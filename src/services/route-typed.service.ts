import { knex } from '../config/database';
import { RouteTyped, CreateRouteTypedInput } from '../models';
import { NotFoundError } from '../utils/errors';
import { haversineMeters } from '../utils/geo';
import { TaskService } from './task.service';

/** Urban average in m/s (30 km/h). Mirrors the constant in
 *  route-calculation.service so the values match. */
const URBAN_SPEED_MPS = 30_000 / 3600;

// Lazy import to avoid a circular dependency at module load time:
// RouteTypedService → routingService → RouteService → ...
async function getRoutingService() {
  const { routingService } = await import('./routing.service.js');
  return routingService;
}

export class RouteTypedService {
  static async create(input: CreateRouteTypedInput): Promise<RouteTyped> {
    const [row] = await knex('routes_typed')
      .insert({
        seller_id: input.sellerId,
        name: input.name,
        description: input.description,
        start_location: JSON.stringify(input.startLocation),
        end_location: JSON.stringify(input.endLocation),
        // JSON.stringify the array/object because the underlying column is JSONB.
        // Knex's default for a plain array is to pass it as a Postgres array, not
        // a JSONB document — which causes a syntax error at insert time.
        waypoints: JSON.stringify(input.waypoints ?? []),
        driver_id: input.driverId,
        vehicle_id: input.vehicleId,
        scheduled_start_at: input.scheduledStartAt,
        order_ids: JSON.stringify(input.orderIds ?? []),
        status: 'PLANNED',
      })
      .returning('*');
    // If a driver is attached and the route already has orders,
    // create the per-order PICKUP + DELIVERY tasks so the driver's
    // /tasks/my and /routes/my both see this work. Best-effort —
    // the tasks table may not exist on a fresh DB.
    if (input.driverId && input.orderIds && input.orderIds.length > 0) {
      try {
        await TaskService.generateForRoute(String(row.id));
      } catch (e) {
        console.warn('[routeTyped.create] task generation failed:', (e as Error).message);
      }
    }
    return this.normalize(row);
  }

  static async findById(id: string): Promise<RouteTyped | null> {
    const row = await knex('routes_typed').where({ id }).first();
    return row ? this.normalize(row) : null;
  }

  static async listBySeller(
    sellerId: string,
    options: { page?: number; limit?: number; status?: string } = {}
  ): Promise<{ routes: RouteTyped[]; total: number }> {
    const page = Math.max(1, options.page || 1);
    const limit = Math.min(100, Math.max(1, options.limit || 20));
    const offset = (page - 1) * limit;

    let countQuery = knex('routes_typed').where({ seller_id: sellerId });
    if (options.status) countQuery = countQuery.where({ status: options.status });
    const totalRow = await countQuery.count('* as count').first();
    const total = Number(totalRow?.count ?? 0);

    let query = knex('routes_typed').where({ seller_id: sellerId }).orderBy('created_at', 'desc');
    if (options.status) query = query.where({ status: options.status });
    const rows = await query.limit(limit).offset(offset);

    return { routes: rows.map(r => this.normalize(r)), total };
  }

  static async listByDriver(
    driverId: string,
    options: { page?: number; limit?: number; status?: string } = {}
  ): Promise<{ routes: RouteTyped[]; total: number }> {
    const page = Math.max(1, options.page || 1);
    const limit = Math.min(100, Math.max(1, options.limit || 20));
    const offset = (page - 1) * limit;

    let countQuery = knex('routes_typed').where({ driver_id: driverId });
    if (options.status) countQuery = countQuery.where({ status: options.status });
    const totalRow = await countQuery.count('* as count').first();
    const total = Number(totalRow?.count ?? 0);

    let query = knex('routes_typed').where({ driver_id: driverId }).orderBy('created_at', 'desc');
    if (options.status) query = query.where({ status: options.status });
    const rows = await query.limit(limit).offset(offset);

    return { routes: rows.map(r => this.normalize(r)), total };
  }

  static async updateStatus(id: string, status: 'PLANNED' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED'): Promise<RouteTyped> {
    const [row] = await knex('routes_typed')
      .where({ id })
      .update({ status, updated_at: new Date() })
      .returning('*');
    if (!row) throw new NotFoundError('Route not found');
    return this.normalize(row);
  }

  /**
   * Generic PATCH handler used by RouteTypedController.update. When
   * the patch attaches a driver (driverId goes from null → uuid) we
   * also generate PICKUP + DELIVERY tasks for every order on the
   * route so the driver has something to work with.
   */
  static async update(
    id: string,
    updates: Record<string, unknown>
  ): Promise<RouteTyped> {
    const before = await knex('routes_typed').where({ id }).first();
    if (!before) throw new NotFoundError('Route not found');

    const [row] = await knex('routes_typed')
      .where({ id })
      .update({ ...updates, updated_at: new Date() })
      .returning('*');
    if (!row) throw new NotFoundError('Route not found');

    // If the patch attached a driver that wasn't there before, the
    // orders on this route now have a driver but no tasks. Generate
    // them so /tasks/my surfaces the work.
    if (
      updates.driverId &&
      !before.driver_id &&
      row.driver_id
    ) {
      try {
        await TaskService.generateForRoute(String(row.id));
      } catch (e) {
        console.warn('[routeTyped.update] task generation failed:', (e as Error).message);
      }
    }
    return this.normalize(row);
  }

  static async delete(id: string): Promise<void> {
    const deleted = await knex('routes_typed').where({ id }).del();
    if (!deleted) throw new NotFoundError('Route not found');
  }

  /**
   * Backfill `estimated_distance` / `estimated_duration` for any
   * `routes_typed` row that has 0/0. The driver's `/driver/routes`
   * page reads these columns and would otherwise show "—" for every
   * route that was created before the create path started populating
   * them (the legacy `TaskService.generateForOrder` insert didn't
   * compute them).
   *
   * Distance is recomputed from the row's `start_location` →
   * `end_location` coords using the configured routing provider
   * (OSRM / Google) for real road-network distance + ETA. If the
   * provider call fails, falls back to haversine + 30 km/h urban speed.
   *
   * @returns The number of rows that were updated.
   */
  static async backfillDistanceAndDuration(): Promise<number> {
    const rows = await knex('routes_typed')
      .where((q) => q.where('estimated_distance', 0).orWhere('estimated_distance', null))
      .orWhere((q) => q.where('estimated_duration', 0).orWhere('estimated_duration', null));
    if (rows.length === 0) return 0;

    const rs = await getRoutingService();
    let updated = 0;
    for (const r of rows) {
      const start = r.start_location as { lat?: number; latitude?: number; lng?: number; longitude?: number } | null;
      const end = r.end_location as { lat?: number; latitude?: number; lng?: number; longitude?: number } | null;
      if (!start || !end) continue;
      const startLat = Number(start.lat ?? start.latitude ?? 0);
      const startLng = Number(start.lng ?? start.longitude ?? 0);
      const endLat = Number(end.lat ?? end.latitude ?? 0);
      const endLng = Number(end.lng ?? end.longitude ?? 0);
      const origin = { latitude: startLat, longitude: startLng };
      const destination = { latitude: endLat, longitude: endLng };

      let distance: number;
      let duration: number;
      try {
        const leg = await rs.getRoute(origin, destination);
        distance = Math.max(0, Math.round(Number(leg.distance) || 0));
        duration = Math.max(0, Math.round(Number(leg.duration) || 0));
        if (distance > 0 && duration === 0) duration = 1;
      } catch (e) {
        console.warn(
          `[routeTyped.backfill] routing provider failed for route ${r.id} ` +
          `(${(e as Error)?.message ?? 'unknown'}); falling back to haversine`
        );
        const meters = haversineMeters(origin, destination) ?? 0;
        distance = Math.round(meters);
        duration = distance > 0
          ? Math.max(1, Math.round(distance / URBAN_SPEED_MPS))
          : 0;
      }

      await knex('routes_typed')
        .where({ id: r.id })
        .update({
          estimated_distance: distance,
          estimated_duration: duration,
          updated_at: new Date(),
        });
      updated++;
    }
    return updated;
  }

  // Map snake_case row to camelCase RouteTyped.
  private static normalize(row: Record<string, unknown>): RouteTyped {
    // The DB stores `estimated_distance` in METERS and
    // `estimated_duration` in SECONDS (the values are produced by
    // haversine + 30 km/h in `backfillDistanceAndDuration` and by
    // `TaskService.generateForOrder`). The frontend's `Route` type
    // and all three route-list pages display these as km and min,
    // so we convert at the model boundary to keep callers from
    // accidentally re-introducing a unit mismatch.
    const distanceMeters = Number(row.estimated_distance ?? 0);
    const durationSeconds = Number(row.estimated_duration ?? 0);
    const totalDistanceKm = Number((distanceMeters / 1000).toFixed(2));
    const estimatedDurationMin = Math.round(durationSeconds / 60);
    return {
      id: String(row.id),
      sellerId: String(row.seller_id),
      name: String(row.name),
      description: row.description ? String(row.description) : null,
      startLocation: row.start_location as RouteTyped['startLocation'],
      endLocation: row.end_location as RouteTyped['endLocation'],
      waypoints: (row.waypoints as RouteTyped['waypoints']) ?? [],
      driverId: row.driver_id ? String(row.driver_id) : null,
      vehicleId: row.vehicle_id ? String(row.vehicle_id) : null,
      scheduledStartAt: toIso(row.scheduled_start_at),
      estimatedDistance: totalDistanceKm,
      estimatedDuration: estimatedDurationMin,
      // Frontend Route type
      totalDistance: totalDistanceKm,
      status: row.status as RouteTyped['status'],
      orders: (row.order_ids as string[]) ?? [],
      createdAt: toIso(row.created_at) ?? String(row.created_at),
      updatedAt: toIso(row.updated_at) ?? String(row.updated_at),
    };
  }
}

/** Normalize a Knex/Postgres date value (Date, string, or null) to ISO 8601. */
function toIso(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') {
    const d = new Date(v);
    return isNaN(d.getTime()) ? v : d.toISOString();
  }
  return String(v);
}
