import { knex } from '../config/database';
import { config } from '../config/env';
import { emitDriverAvailability, emitOrderStatus } from '../socket';
import { notificationService } from './notification.service';
import { Driver } from '../models';
import { decryptObject } from '../config/encryption';

/**
 * Multiplier applied to haversine (straight-line) distance to approximate
 * road-network distance in SQL. The auto-assign query uses haversine for
 * the SQL-level radius pre-filter (a hard requirement — Postgres can't
 * call a routing API inside WHERE), then scales by this factor so the
 * stored `distance_km` and the score reflect road distance, not the
 * straight-line crow-fly distance. The real routing providers (OSRM,
 * Google) return actual road distances; this factor only corrects the
 * haversine approximation used in the SQL query.
 */
const ROAD_DISTANCE_FACTOR = config.ROUTING_ROAD_DISTANCE_FACTOR;

/**
 * Auto-Assign Service
 *
 * The design's "Assign Nearest Available Driver" step is implemented here.
 * Given a pickup coordinate and a search radius, it picks the best available
 * driver using a *scoring* algorithm that considers both **proximity** and
 * **workload**:
 *
 *   score = distance_km + (WORKLOAD_DISTANCE_PENALTY_KM * current_workload)
 *
 * A driver is excluded from the candidate pool entirely when:
 *   - availability_status != 'available'
 *   - their current location is unknown
 *   - they are outside the search radius
 *   - their current_workload >= MAX_DRIVER_WORKLOAD (capacity cap)
 *
 * The chosen driver is then:
 *   1. Attached to the order (`orders.driver_id` set, status = 'assigned')
 *   2. Flipped to 'busy' so they don't get re-assigned mid-delivery
 *   3. Has their `current_workload` incremented by 1
 *   4. Notified via the notification service (in-app + best-effort SMS/email)
 *
 * If no driver is found in range, the order is left as 'pending' and a
 * separate manual flow (`POST /orders/:id/assign`) can be used.
 *
 * The same function powers the legacy `OrderService.create` and the typed
 * `OrderService.createTyped` so both paths behave the same way.
 */

export interface AutoAssignInput {
  orderId: string;
  pickupLat: number;
  pickupLng: number;
  /** Optional: how far to look (km). Defaults to 25. */
  radiusKm?: number;
  /** Optional: cap on how many active orders a driver can hold. */
  maxWorkload?: number;
  /**
   * Optional: how many "km of equivalent distance" each unit of workload
   * adds to a driver's score. Higher = workload dominates proximity.
   */
  workloadPenaltyKm?: number;
  /** Optional: how many candidate drivers to evaluate before picking the best. */
  candidateLimit?: number;
}

export interface AutoAssignCandidate {
  driver: Driver;
  distanceKm: number;
  workload: number;
  score: number;
}

export interface AutoAssignResult {
  /** The driver that was attached, or null if none was available. */
  driver: Driver | null;
  /** The driver's user id, convenient for downstream notification calls. */
  driverUserId: string | null;
  /** Distance from the pickup point to the assigned driver, in km. */
  distanceKm: number | null;
  /** The driver's `current_workload` at the moment of selection. */
  workload: number | null;
  /** The final score the chosen driver was ranked by. */
  score: number | null;
  /** All drivers considered, sorted best→worst. Useful for diagnostics / "why this driver" UI. */
  candidates: AutoAssignCandidate[];
}

export class AutoAssignService {
  /**
   * Haversine in SQL — Postgres-friendly, no PostGIS dependency.
   * Same formula used by DriverService.findNearbyDrivers; duplicated
   * here so the auto-assign path is self-contained and easy to follow.
   *
   * The raw haversine distance is scaled by {@link ROAD_DISTANCE_FACTOR}
   * so the returned `distance_km` reflects an approximate *road* distance
   * rather than the straight-line crow-fly distance. The real routing
   * providers (OSRM, Google) apply this scaling at the provider level;
   * here in the SQL pre-filter we replicate the same factor so the
   * auto-assign score is consistent with what the route pages show.
   */
  private static distanceExpr(): string {
    return `
      (
        ${ROAD_DISTANCE_FACTOR} * (
          2 * 6371 * asin(
            least(1.0, sqrt(
              power(sin(radians(current_latitude - ?) / 2), 2) +
              cos(radians(?)) *
              cos(radians(current_latitude)) *
              power(sin(radians(current_longitude - ?) / 2), 2)
            ))
          )
        )
      )
    `;
  }

  /**
   * Score expression matching the distance expression, plus a workload
   * penalty. We use the workload count * a km-equivalent penalty so that
   * a driver who is 4 km away but unburdened still wins over one who is
   * 1 km away but already juggling the maximum number of active orders.
   *
   * The distance portion is scaled by {@link ROAD_DISTANCE_FACTOR} to
   * match {@link distanceExpr}.
   */
  private static scoreExpr(workloadPenalty: number): string {
    return `(
      ${ROAD_DISTANCE_FACTOR} * (
        2 * 6371 * asin(
          least(1.0, sqrt(
            power(sin(radians(current_latitude - ?) / 2), 2) +
            cos(radians(?)) *
            cos(radians(current_latitude)) *
            power(sin(radians(current_longitude - ?) / 2), 2)
          ))
        )
      )
      + (current_workload * ?)
    )`;
  }

  /**
   * Find and attach the nearest available driver for the given order.
   * Returns the driver that was attached (or null if none was in range).
   */
  static async assignNearest(input: AutoAssignInput): Promise<AutoAssignResult> {
    const radius = input.radiusKm ?? 25;
    const maxWorkload = input.maxWorkload ?? config.MAX_DRIVER_WORKLOAD;
    const workloadPenalty = input.workloadPenaltyKm ?? config.WORKLOAD_DISTANCE_PENALTY_KM;
    const candidateLimit = input.candidateLimit ?? 10;
    const distExpr = this.distanceExpr();
    const scoreExpr = this.scoreExpr(workloadPenalty);

    // 1. Find candidate drivers: available + has a known location + within
    //    radius + still has capacity. We pull a wider candidate list than
    //    just one row so the scoring function has room to choose the best
    //    fit, not just the closest.
    const candidateRows = await knex('drivers')
      .select(
        'id',
        'user_id',
        'current_latitude',
        'current_longitude',
        'availability_status',
        'current_workload'
      )
      .select(knex.raw(`${distExpr} as distance_km`, [input.pickupLat, input.pickupLat, input.pickupLng]))
      .where({ availability_status: 'available' })
      .whereNotNull('current_latitude')
      .whereNotNull('current_longitude')
      .where('current_workload', '<', maxWorkload)
      .whereRaw(`${distExpr} <= ?`, [input.pickupLat, input.pickupLat, input.pickupLng, radius])
      // Sort by the combined proximity + workload score, ascending — lower
      // score = better fit. Tie-break by distance to keep the result
      // deterministic when two drivers have identical workloads.
      .orderByRaw(`${scoreExpr} ASC`, [input.pickupLat, input.pickupLat, input.pickupLng, workloadPenalty])
      .orderByRaw(`${distExpr} ASC`, [input.pickupLat, input.pickupLat, input.pickupLng])
      .limit(candidateLimit);

    const candidates: AutoAssignCandidate[] = candidateRows.map((row) => ({
      driver: row as Driver,
      // The SQL distanceExpr already applies ROAD_DISTANCE_FACTOR, so
      // row.distance_km is the approximate road distance. No JS rescale
      // needed — just coerce to a finite number.
      distanceKm: Number(row.distance_km),
      workload: Number(row.current_workload ?? 0),
      // Recompute the score in JS so the result is self-explanatory and
      // matches what the SQL ORDER BY used. row.distance_km already
      // includes the road factor.
      score:
        Number(row.distance_km) + workloadPenalty * Number(row.current_workload ?? 0),
    }));

    const chosen = candidates[0];
    if (!chosen) {
      return { driver: null, driverUserId: null, distanceKm: null, workload: null, score: null, candidates: [] };
    }

    // 2. Attach the driver to the order, transition to 'assigned'.
    await knex('orders')
      .where({ id: input.orderId })
      .update({
        driver_id: chosen.driver.id,
        status: 'assigned',
        updated_at: new Date(),
      });

    // 3. Mark the driver as 'busy' AND increment their workload in one
    //    round-trip. We use a single UPDATE so the two state changes
    //    happen atomically — a driver can never be marked busy without
    //    the workload counter moving up.
    const [busyDriver] = await knex('drivers')
      .where({ id: chosen.driver.id })
      .update({
        availability_status: 'busy',
        updated_at: new Date(),
      })
      .increment('current_workload', 1)
      .returning('*');

    // 4. History row (best-effort — the table may not exist on fresh DBs).
    try {
      await knex('order_status_history').insert({
        order_id: input.orderId,
        status: 'assigned',
        latitude: input.pickupLat,
        longitude: input.pickupLng,
        notes: `Auto-assigned to driver ${chosen.driver.id} `
          + `(distance=${chosen.distanceKm.toFixed(2)}km, `
          + `workload=${chosen.workload}, score=${chosen.score.toFixed(2)}, `
          + `candidates=${candidates.length})`,
        timestamp: new Date(),
      });
    } catch {
      // ignore — table may not be migrated yet
    }

    // 5. Real-time emit: order status, driver availability, in-app notification.
    emitOrderStatus({
      orderId: input.orderId,
      status: 'assigned',
      driverId: chosen.driver.user_id, // user id — the socket layer keys rooms by user id
      timestamp: new Date(),
    });
    emitDriverAvailability(busyDriver.id, 'busy');

    // 6. Notify the driver. We need the user's email/phone for SMS/email;
    //    the in-app notification is always written.
    const user = await knex('users').where({ id: chosen.driver.user_id }).first();
    // users.profile_details is encrypted; decrypt before reading
    // phone so the SMS goes to the real number, not the ciphertext.
    const profileDetails = user?.profile_details
      ? decryptObject(user.profile_details as Record<string, unknown>)
      : {};
    const phone = String(profileDetails.phone ?? '');
    const email = user?.email ?? null;

    await notificationService.notifyDriverAssignment({
      driverUserId: chosen.driver.user_id,
      driverPhone: phone || null,
      driverEmail: email,
      orderId: input.orderId,
      // The auto-assign path doesn't have the pickup address handy
      // — `AutoAssignInput` only carries pickup coordinates, and
      // the legacy `orders` row only has `delivery_address` (no
      // pickup_address column). Passing delivery_address here is
      // misleading because the driver hasn't picked up yet. The
      // notification service uses a sensible default ("You have a
      // new order") when this is omitted; the driver can tap the
      // notification to see the order's full details.
    });

    return {
      driver: busyDriver as Driver,
      driverUserId: chosen.driver.user_id,
      distanceKm: chosen.distanceKm,
      workload: chosen.workload,
      score: chosen.score,
      candidates,
    };
  }

  /**
   * Lightweight "what would the algorithm pick?" probe. Used by:
   *   - the seller dashboard "preview driver" UI
   *   - integration tests that want to inspect the ranking without
   *     actually mutating the order row
   *
   * Returns up to `limit` ranked candidates (best first). Does NOT
   * update any DB state.
   */
  static async findCandidates(
    pickupLat: number,
    pickupLng: number,
    options: { radiusKm?: number; maxWorkload?: number; workloadPenaltyKm?: number; limit?: number } = {}
  ): Promise<AutoAssignCandidate[]> {
    const radius = options.radiusKm ?? 25;
    const maxWorkload = options.maxWorkload ?? config.MAX_DRIVER_WORKLOAD;
    const workloadPenalty = options.workloadPenaltyKm ?? config.WORKLOAD_DISTANCE_PENALTY_KM;
    const limit = options.limit ?? 10;
    const distExpr = this.distanceExpr();
    const scoreExpr = this.scoreExpr(workloadPenalty);

    const rows = await knex('drivers')
      .select(
        'id',
        'user_id',
        'current_latitude',
        'current_longitude',
        'availability_status',
        'current_workload'
      )
      .select(knex.raw(`${distExpr} as distance_km`, [pickupLat, pickupLat, pickupLng]))
      .where({ availability_status: 'available' })
      .whereNotNull('current_latitude')
      .whereNotNull('current_longitude')
      .where('current_workload', '<', maxWorkload)
      .whereRaw(`${distExpr} <= ?`, [pickupLat, pickupLat, pickupLng, radius])
      .orderByRaw(`${scoreExpr} ASC`, [pickupLat, pickupLat, pickupLng, workloadPenalty])
      .orderByRaw(`${distExpr} ASC`, [pickupLat, pickupLat, pickupLng])
      .limit(limit);

    return rows.map((row) => ({
      driver: row as Driver,
      // The SQL distanceExpr already applies ROAD_DISTANCE_FACTOR, so
      // row.distance_km is the approximate road distance.
      distanceKm: Number(row.distance_km),
      workload: Number(row.current_workload ?? 0),
      score: Number(row.distance_km) + workloadPenalty * Number(row.current_workload ?? 0),
    }));
  }

  /**
   * Free a driver attached to an order — flips them back to 'available'
   * and decrements their workload so they can take the next delivery.
   * Called when an order is delivered, cancelled, returned, or marked failed.
   */
  static async freeDriverForOrder(orderId: string): Promise<void> {
    const order = await knex('orders').where({ id: orderId }).first();
    if (!order?.driver_id) return;

    const [freed] = await knex('drivers')
      .where({ id: order.driver_id })
      .where('availability_status', 'busy')
      .update({ availability_status: 'available', updated_at: new Date() })
      // Guard with `.where('current_workload', '>', 0)` so the counter
      // never goes negative if a duplicate free call slips through.
      .where('current_workload', '>', 0)
      .decrement('current_workload', 1)
      .returning('*');

    if (freed) {
      emitDriverAvailability(freed.id, freed.availability_status);
    } else {
      // Either the driver was never busy, or the workload was already 0.
      // Emit a status read in either case so the UI doesn't drift.
      const driverRow = await knex('drivers').where({ id: order.driver_id }).first();
      if (driverRow) {
        emitDriverAvailability(driverRow.id, driverRow.availability_status);
      }
    }
  }
}
