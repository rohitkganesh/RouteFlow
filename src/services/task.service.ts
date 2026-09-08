import { knex } from '../config/database';
import { Task, TaskStatus, CreateTaskInput } from '../models';
import { NotFoundError, ForbiddenError, ValidationError } from '../utils/errors';
import { emitOrderStatus, emitTaskStatus } from '../socket';
import { AutoAssignService } from './auto-assign.service';
import { notificationService } from './notification.service';
import { haversineMeters } from '../utils/geo';

/** Urban average in m/s (30 km/h) — used to derive a duration when the
 *  routing provider is unavailable and we only have a haversine
 *  distance. Mirrors the constant in route-calculation.service. */
const URBAN_SPEED_MPS = 30_000 / 3600;

// Lazy import to avoid a circular dependency at module load time:
// TaskService → routingService → RouteService → TaskService.
async function getRoutingService() {
  const { routingService } = await import('./routing.service.js');
  return routingService;
}

/**
 * Task Service
 *
 * Source of truth for the per-stop work items a driver works through
 * during a route. Two tasks are generated per order: PICKUP from the
 * seller and DELIVERY to the customer. Tasks drive both the driver
 * dashboard (`GET /tasks/my`) and the seller order detail view.
 *
 * Generation paths (idempotent — re-running with the same inputs is
 * safe; we look for an existing (order_id, type) pair before insert):
 *
 *   - `generateForOrder(orderId, driverId)` — when a driver is attached
 *     to an order with no route yet (e.g. auto-assign or manual seller
 *     assignment), creates a one-order `routes_typed` row + two tasks.
 *
 *   - `generateForRoute(routeId)` — when a multi-order seller-driven
 *     route is created, generates two tasks per order in the route.
 *
 * Status translation (TaskService.advanceStatus):
 *
 *   PICKUP task reaches PICKED_UP        → orders.status = 'picked_up'
 *   DELIVERY task reaches DELIVERED       → orders.status = 'delivered'
 *   any task reaches DELIVERED/FAILED/CANCELLED
 *     AND both tasks for the order are terminal
 *                                          → AutoAssignService.freeDriverForOrder
 */
export class TaskService {
  /**
   * Convert a snake_case row from the `tasks` table to the camelCase
   * shape the frontend's `Task` type uses. Exported so the seller
   * listTasks path in TaskController can reuse the mapping without
   * going through the per-order helper.
   */
  static toCamel(row: Record<string, unknown>): Task {
    return {
      id: String(row.id),
      routeId: row.route_id ? String(row.route_id) : null,
      orderId: String(row.order_id),
      driverId: String(row.driver_id),
      type: row.type as Task['type'],
      status: row.status as TaskStatus,
      sequenceIndex: Number(row.sequence_index ?? 0),
      pickupLatitude: row.pickup_latitude != null ? Number(row.pickup_latitude) : null,
      pickupLongitude: row.pickup_longitude != null ? Number(row.pickup_longitude) : null,
      deliveryLatitude: row.delivery_latitude != null ? Number(row.delivery_latitude) : null,
      deliveryLongitude: row.delivery_longitude != null ? Number(row.delivery_longitude) : null,
      pickupAddress: (row.pickup_address as Record<string, unknown>) ?? {},
      deliveryAddress: (row.delivery_address as Record<string, unknown>) ?? {},
      estimatedPickupAt: toIso(row.estimated_pickup_at),
      estimatedDeliveryAt: toIso(row.estimated_delivery_at),
      actualPickupAt: toIso(row.actual_pickup_at),
      actualDeliveryAt: toIso(row.actual_delivery_at),
      notes: row.notes ? String(row.notes) : null,
      createdAt: toIso(row.created_at) ?? String(row.created_at),
      updatedAt: toIso(row.updated_at) ?? String(row.updated_at),
    };
  }

  /**
   * List the tasks for a specific driver (by user id). Joins through
   * the `drivers` table to convert user_id → driver_id. The driver
   * dashboard's `/tasks/my` endpoint calls this.
   */
  static async listForDriver(
    driverUserId: string,
    options: { status?: TaskStatus; page?: number; limit?: number } = {}
  ): Promise<{ tasks: Task[]; total: number }> {
    const page = Math.max(1, options.page || 1);
    const limit = Math.min(100, Math.max(1, options.limit || 20));
    const offset = (page - 1) * limit;

    const driver = await knex('drivers').where({ user_id: driverUserId }).first();
    if (!driver) {
      // No driver profile yet — return an empty list, not a 404. The
      // UI can guide the user through driver onboarding.
      return { tasks: [], total: 0 };
    }

    let countQuery = knex('tasks').where({ driver_id: driver.id });
    let dataQuery = knex('tasks').where({ driver_id: driver.id });
    if (options.status) {
      countQuery = countQuery.andWhere({ status: options.status });
      dataQuery = dataQuery.andWhere({ status: options.status });
    }

    const totalRow = await countQuery.count('* as count').first();
    const total = Number(totalRow?.count ?? 0);

    const rows = await dataQuery
      .orderBy([
        { column: 'status', order: 'asc' },
        { column: 'sequence_index', order: 'asc' },
        { column: 'created_at', order: 'asc' },
      ])
      .limit(limit)
      .offset(offset);

    return { tasks: rows.map((r) => this.toCamel(r)), total };
  }

  /**
   * List all tasks for a specific order. Used by the order detail
   * page so the seller (or driver) can see per-stop progress
   * without a separate round trip.
   */
  static async listForOrder(orderId: string): Promise<Task[]> {
    const rows = await knex('tasks')
      .where({ order_id: orderId })
      .orderBy('sequence_index', 'asc')
      .orderBy('type', 'asc');
    return rows.map((r) => this.toCamel(r));
  }

  /**
   * Get a single task by id. The frontend's getTask / PATCH endpoints
   * call this; the route is also used by advanceStatus.
   */
  static async getById(taskId: string): Promise<Task | null> {
    const row = await knex('tasks').where({ id: taskId }).first();
    return row ? this.toCamel(row) : null;
  }

  /**
   * List all tasks (admin/seller view) with optional filters. Mirrors
   * the shape of listForDriver but scoped by filters the caller picks.
   */
  static async listAll(options: {
    driverId?: string;
    routeId?: string;
    orderId?: string;
    status?: TaskStatus;
    page?: number;
    limit?: number;
  } = {}): Promise<{ tasks: Task[]; total: number }> {
    const page = Math.max(1, options.page || 1);
    const limit = Math.min(100, Math.max(1, options.limit || 20));
    const offset = (page - 1) * limit;

    let countQuery = knex('tasks');
    let dataQuery = knex('tasks');
    if (options.driverId) {
      countQuery = countQuery.where({ driver_id: options.driverId });
      dataQuery = dataQuery.where({ driver_id: options.driverId });
    }
    if (options.routeId) {
      countQuery = countQuery.where({ route_id: options.routeId });
      dataQuery = dataQuery.where({ route_id: options.routeId });
    }
    if (options.orderId) {
      countQuery = countQuery.where({ order_id: options.orderId });
      dataQuery = dataQuery.where({ order_id: options.orderId });
    }
    if (options.status) {
      countQuery = countQuery.andWhere({ status: options.status });
      dataQuery = dataQuery.andWhere({ status: options.status });
    }

    const totalRow = await countQuery.count('* as count').first();
    const total = Number(totalRow?.count ?? 0);

    const rows = await dataQuery
      .orderBy('created_at', 'desc')
      .limit(limit)
      .offset(offset);
    return { tasks: rows.map((r) => this.toCamel(r)), total };
  }

  /**
   * Advance a task to a new status. Driver-side: validates the actor
   * owns the task, validates the transition is allowed, then writes
   * the new status, fires side effects (update order status, free
   * driver on terminal states, emit socket events, notify).
   */
  static async advanceStatus(
    taskId: string,
    actorUserId: string,
    actorRole: 'driver' | 'admin' | 'seller',
    nextStatus: TaskStatus,
    notes?: string
  ): Promise<Task> {
    const task = await knex('tasks').where({ id: taskId }).first();
    if (!task) throw new NotFoundError('Task not found');

    // Authorization: drivers can only advance their own tasks. Admins
    // can advance anything (operational override). Sellers cannot
    // (drivers own the workflow), so we reject that role.
    if (actorRole === 'driver') {
      const driver = await knex('drivers').where({ id: task.driver_id }).first();
      if (!driver || driver.user_id !== actorUserId) {
        throw new ForbiddenError('Not authorized to advance this task');
      }
    } else if (actorRole === 'seller') {
      throw new ForbiddenError('Sellers cannot advance task status');
    }

    if (!isAllowedTransition(task.status as TaskStatus, nextStatus, task.type as 'PICKUP' | 'DELIVERY')) {
      throw new ValidationError(
        `Cannot transition task from ${task.status} to ${nextStatus}`
      );
    }

    // Compute timestamp columns we need to write alongside the status
    // change so the driver can show "I picked it up at HH:MM".
    const now = new Date();
    const update: Record<string, unknown> = {
      status: nextStatus,
      updated_at: now,
    };
    if (nextStatus === 'PICKED_UP' && !task.actual_pickup_at) {
      update.actual_pickup_at = now;
    }
    if (nextStatus === 'DELIVERED' && !task.actual_delivery_at) {
      update.actual_delivery_at = now;
    }
    if (notes) update.notes = notes;

    const [updated] = await knex('tasks').where({ id: taskId }).update(update).returning('*');
    if (!updated) throw new NotFoundError('Task not found');

    // ----------------------------------------------------------------
    // Side effects:
    //  1. Translate the task status to the underlying order status.
    //  2. On terminal states, free the driver (if both tasks for
    //     this order are done) so they can take the next one.
    //  3. Emit the order:status socket event so dashboards refresh.
    //  4. Notify the customer (in-app + best-effort SMS/email) when
    //     the order status actually changes.
    // ----------------------------------------------------------------
    const order = await knex('orders').where({ id: task.order_id }).first();
    if (order) {
      const newOrderStatus = translateTaskToOrderStatus(
        nextStatus,
        task.type as 'PICKUP' | 'DELIVERY',
        order.status as string
      );
      if (newOrderStatus && newOrderStatus !== order.status) {
        const orderUpdate: Record<string, unknown> = {
          status: newOrderStatus,
          updated_at: now,
        };
        if (newOrderStatus === 'picked_up' && !order.actual_pickup_at) {
          orderUpdate.actual_pickup_at = now;
        }
        if (newOrderStatus === 'delivered' && !order.actual_delivery_at) {
          orderUpdate.actual_delivery_at = now;
        }
        // On successful delivery, mark the order as paid so the seller
        // dashboard no longer shows the "Payment pending" badge. We
        // don't touch refunded/failed orders here — those are handled
        // by the cancel/fail paths.
        if (newOrderStatus === 'delivered' && order.payment_status !== 'PAID') {
          orderUpdate.payment_status = 'PAID';
        }
        await knex('orders').where({ id: order.id }).update(orderUpdate);

        // History row (best-effort — the table may not exist)
        try {
          await knex('order_status_history').insert({
            order_id: order.id,
            status: newOrderStatus,
            latitude: order.latitude,
            longitude: order.longitude,
            notes: notes ?? null,
            timestamp: now,
          });
        } catch {
          // ignore — table may not be migrated yet
        }

        // Customer notification (in-app + best-effort SMS/email)
        try {
          const updated = { ...order, ...orderUpdate, parcel_details: order.parcel_details };
          // newOrderStatus comes from translateTaskToOrderStatus and
          // is the DB enum ('pending'/'assigned'/'picked_up'/...);
          // the notification service's type wants OrderStatus but
          // the runtime values match. Cast through `unknown` to
          // avoid a sprawl of string-conversion noise.
          await notificationService.notifyOrderStatusChange(updated, newOrderStatus as unknown as Parameters<typeof notificationService.notifyOrderStatusChange>[1]);
        } catch (e) {
          console.warn('[task] customer notification failed:', (e as Error).message);
        }

        emitOrderStatus({
          orderId: order.id,
          status: newOrderStatus,
          driverId: order.driver_id ?? undefined,
          timestamp: now,
        });
      }

      // Free the driver only when BOTH tasks for the order are in a
      // terminal state. Otherwise the driver still has open work.
      //
      // Note: the PICKUP task's terminal state is PICKED_UP (not
      // DELIVERED — that's the DELIVERY task's terminal state). We
      // treat a task as "done" if it's PICKED_UP for a PICKUP task
      // or DELIVERED for a DELIVERY task, plus the FAILED/CANCELLED
      // branch that can happen on either.
      const allTasks = await knex('tasks').where({ order_id: order.id });
      const isTaskDone = (t: { type: string; status: string }): boolean => {
        if (['FAILED', 'CANCELLED'].includes(t.status)) return true;
        if (t.type === 'PICKUP' && t.status === 'PICKED_UP') return true;
        if (t.type === 'DELIVERY' && t.status === 'DELIVERED') return true;
        return false;
      };
      const allDone = allTasks.every((t) => isTaskDone(t as { type: string; status: string }));
      if (allDone && order.driver_id) {
        try {
          await AutoAssignService.freeDriverForOrder(order.id);
        } catch (e) {
          console.warn('[task] freeDriverForOrder failed:', (e as Error).message);
        }
      }
    }

    // ----------------------------------------------------------------
    // Per-task real-time emit. Fires on every status transition (not
    // just the ones that flip the order status) so the driver's
    // /driver/tasks list re-renders mid-flow — e.g. clicking
    // "Going to Pickup" updates the row immediately, without waiting
    // for the next /tasks/my poll. Without this the driver sees the
    // "Saving…" state forever on slow connections and has to refresh.
    //
    // Sits outside the `if (order)` block above because we want the
    // event even when the order lookup failed (rare, but a row that
    // is still advancing for a deleted order should still update the
    // driver's list).
    //
    // task.driver_id is the Driver table PK (set by generateForOrder
    // / assignDriver), which is what the `driver:<pk>` room expects.
    // ----------------------------------------------------------------
    try {
      emitTaskStatus({
        taskId: String(updated.id),
        orderId: String(updated.order_id),
        driverId: String(updated.driver_id),
        type: updated.type as 'PICKUP' | 'DELIVERY',
        status: String(updated.status),
        timestamp: now,
      });
    } catch (e) {
      console.warn('[task] emitTaskStatus failed:', (e as Error).message);
    }

    return this.toCamel(updated);
  }

  /**
   * Generate the two tasks (PICKUP + DELIVERY) for a single order,
   * creating a one-order `routes_typed` row if the order doesn't
   * already belong to a route. This is the path used by:
   *
   *   - `OrderService.assignDriver` (manual seller assignment)
   *   - `OrderService.createTyped` / `OrderService.create` after
   *     a successful `AutoAssignService.assignNearest` call
   *
   * Idempotent: if the order already has both task rows, the
   * function returns the existing ones. If only one exists, it
   * inserts the missing one.
   */
  static async generateForOrder(orderId: string, driverId: string): Promise<Task[]> {
    const order = await knex('orders').where({ id: orderId }).first();
    if (!order) throw new NotFoundError('Order not found');

    const driver = await knex('drivers').where({ id: driverId }).first();
    if (!driver) throw new NotFoundError('Driver not found');

    // `routes_typed.seller_id` is a foreign key to `sellers.id` (NOT
    // `users.id`). The `orders.seller_id` column still references
    // `users.id` — the seller profile row is created lazily on first
    // login / seller onboarding. We resolve the sellers.id here so
    // the route insert doesn't blow up on FK constraint violations.
    //
    // If the seller has no profile row yet (e.g. a legacy test
    // fixture), fall back to using the user id directly. This keeps
    // a path for the rare case where the sellers table hasn't been
    // populated; the FK on a real DB will still reject it.
    const sellerProfile = await knex('sellers')
      .where({ user_id: order.seller_id })
      .first();
    const routeSellerId = sellerProfile ? String(sellerProfile.id) : String(order.seller_id);

    // If the order is already attached to a routes_typed row, we
    // don't create another one — just ensure the tasks exist.
    let routeId: string | null = order.route_id ? String(order.route_id) : null;

    if (!routeId) {
      // Find an existing PLANNED route owned by the same seller that
      // has space for one more order, or create a fresh one. We
      // prefer PLANNED-with-driver so the route's driver is the one
      // we just attached to the order.
      const existing = await knex('routes_typed')
        .where({ seller_id: routeSellerId, driver_id: driver.id, status: 'PLANNED' })
        .orderBy('created_at', 'desc')
        .first();

      if (existing) {
        routeId = String(existing.id);
        // Append the order to the route's order_ids array. JSONB
        // concatenation via `||` keeps the existing entries.
        await knex.raw(
          `UPDATE routes_typed SET order_ids = order_ids || ?::jsonb, updated_at = NOW() WHERE id = ?`,
          [JSON.stringify([orderId]), routeId]
        );
        await knex('orders').where({ id: orderId }).update({ route_id: routeId, updated_at: new Date() });
      } else {
        // Brand new one-order route. Build minimal start/end
        // location objects so the typed-route shape stays valid.
        const pickup = order.pickup_address ?? {};
        const delivery = order.delivery_address_typed ?? {};
        const pickupLat = Number(order.pickup_latitude ?? order.latitude ?? 0);
        const pickupLng = Number(order.pickup_longitude ?? order.longitude ?? 0);
        const deliveryLat = Number(order.delivery_latitude ?? order.latitude ?? 0);
        const deliveryLng = Number(order.delivery_longitude ?? order.longitude ?? 0);

        // Use the configured routing provider (OSRM / Google) to compute
        // the *road* distance + ETA for the pickup→delivery leg. The
        // driver's `/driver/routes` page reads from `routes_typed` and
        // would otherwise show "—" because the column defaults to 0 on
        // insert. If the provider call fails, fall back to haversine +
        // 30 km/h urban speed (same fallback as route-calculation.service).
        const origin = { latitude: pickupLat, longitude: pickupLng };
        const destination = { latitude: deliveryLat, longitude: deliveryLng };
        let estimatedDistance: number;
        let estimatedDuration: number;
        try {
          const rs = await getRoutingService();
          const leg = await rs.getRoute(origin, destination);
          estimatedDistance = Math.max(0, Math.round(Number(leg.distance) || 0));
          estimatedDuration = Math.max(0, Math.round(Number(leg.duration) || 0));
          if (estimatedDistance > 0 && estimatedDuration === 0) {
            estimatedDuration = 1; // floor to 1s so ETA reads >0
          }
        } catch (e) {
          console.warn(
            `[task.generateForOrder] routing provider failed for order ${orderId} ` +
            `(${(e as Error)?.message ?? 'unknown'}); falling back to haversine`
          );
          const meters = haversineMeters(origin, destination) ?? 0;
          estimatedDistance = Math.round(meters);
          estimatedDuration = estimatedDistance > 0
            ? Math.max(1, Math.round(estimatedDistance / URBAN_SPEED_MPS))
            : 0;
        }

        const [created] = await knex('routes_typed')
          .insert({
            seller_id: routeSellerId,
            name: `Order ${orderId.substring(0, 8).toUpperCase()}`,
            description: 'Auto-generated on driver assignment',
            start_location: JSON.stringify({
              lat: pickupLat,
              lng: pickupLng,
              name: 'Pickup',
              address: pickup,
            }),
            end_location: JSON.stringify({
              lat: deliveryLat,
              lng: deliveryLng,
              name: 'Delivery',
              address: delivery,
            }),
            waypoints: JSON.stringify([]),
            driver_id: driver.id,
            driver_user_id: driver.user_id,
            vehicle_id: null,
            scheduled_start_at: null,
            estimated_distance: estimatedDistance,
            estimated_duration: estimatedDuration,
            status: 'PLANNED',
            order_ids: JSON.stringify([orderId]),
          })
          .returning('*');
        routeId = String(created.id);
        await knex('orders').where({ id: orderId }).update({ route_id: routeId, updated_at: new Date() });
      }
    }

    // Ensure both task rows exist. If the order already has a
    // PICKUP task, skip its insert; same for DELIVERY.
    const existingTasks = await knex('tasks').where({ order_id: orderId });
    const hasPickup = existingTasks.some((t) => t.type === 'PICKUP');
    const hasDelivery = existingTasks.some((t) => t.type === 'DELIVERY');

    if (!hasPickup) {
      await this.insertTask({
        routeId,
        orderId,
        driverId,
        type: 'PICKUP',
        pickupLatitude: Number(order.pickup_latitude ?? order.latitude ?? 0),
        pickupLongitude: Number(order.pickup_longitude ?? order.longitude ?? 0),
        deliveryLatitude: Number(order.delivery_latitude ?? order.latitude ?? 0),
        deliveryLongitude: Number(order.delivery_longitude ?? order.longitude ?? 0),
        pickupAddress: (order.pickup_address as Record<string, unknown>) ?? {},
        deliveryAddress: (order.delivery_address_typed as Record<string, unknown>) ?? {},
      });
    }
    if (!hasDelivery) {
      await this.insertTask({
        routeId,
        orderId,
        driverId,
        type: 'DELIVERY',
        sequenceIndex: 1,
        pickupLatitude: Number(order.pickup_latitude ?? order.latitude ?? 0),
        pickupLongitude: Number(order.pickup_longitude ?? order.longitude ?? 0),
        deliveryLatitude: Number(order.delivery_latitude ?? order.latitude ?? 0),
        deliveryLongitude: Number(order.delivery_longitude ?? order.longitude ?? 0),
        pickupAddress: (order.pickup_address as Record<string, unknown>) ?? {},
        deliveryAddress: (order.delivery_address_typed as Record<string, unknown>) ?? {},
      });
    }

    return this.listForOrder(orderId);
  }

  /**
   * Generate PICKUP + DELIVERY tasks for every order already
   * attached to a `routes_typed` row. Idempotent — tasks that
   * already exist for an (order_id, type) pair are skipped.
   */
  static async generateForRoute(routeId: string): Promise<Task[]> {
    const route = await knex('routes_typed').where({ id: routeId }).first();
    if (!route) throw new NotFoundError('Route not found');

    // The seller_id is required for orders; routes_typed.seller_id
    // references the sellers table. We don't have it on `route` here
    // in the snake_case row, so we look it up — but actually the
    // route's order_ids contains the order ids we need.
    const orderIds: string[] = (route.order_ids as string[] | null) ?? [];

    if (orderIds.length === 0) return [];

    // The driver on the route is the canonical driver; fall back to
    // the order's driver if the route doesn't have one.
    const driverId = route.driver_id ? String(route.driver_id) : null;
    if (!driverId) {
      // No driver on the route — nothing to attach tasks to. The
      // tasks will be created later when a driver is assigned.
      return [];
    }

    const generated: Task[] = [];
    for (const orderId of orderIds) {
      const tasks = await this.generateForOrder(orderId, driverId);
      generated.push(...tasks);
    }
    return generated;
  }

  /**
   * Insert a single task row. Used by generateForOrder /
   * generateForRoute — extracted so the per-type rules (e.g. PICKUP
   * defaults sequenceIndex=0, DELIVERY defaults sequenceIndex=1) live
   * in one place.
   */
  private static async insertTask(input: CreateTaskInput): Promise<Task> {
    const sequenceIndex = input.sequenceIndex ?? (input.type === 'PICKUP' ? 0 : 1);
    const [row] = await knex('tasks')
      .insert({
        route_id: input.routeId ?? null,
        order_id: input.orderId,
        driver_id: input.driverId,
        type: input.type,
        status: 'PENDING',
        sequence_index: sequenceIndex,
        pickup_latitude: input.pickupLatitude ?? null,
        pickup_longitude: input.pickupLongitude ?? null,
        delivery_latitude: input.deliveryLatitude ?? null,
        delivery_longitude: input.deliveryLongitude ?? null,
        pickup_address: JSON.stringify(input.pickupAddress ?? {}),
        delivery_address: JSON.stringify(input.deliveryAddress ?? {}),
        estimated_pickup_at: input.estimatedPickupAt ?? null,
        estimated_delivery_at: input.estimatedDeliveryAt ?? null,
      })
      .returning('*');
    return this.toCamel(row);
  }
}

/**
 * Allowed status transitions, per task type. The PICKUP and DELIVERY
 * tasks share the same enum but represent different legs of the
 * route, so the workflow differs:
 *
 *   PICKUP   task: PENDING → ACCEPTED → EN_ROUTE_TO_PICKUP →
 *             ARRIVED_AT_PICKUP → PICKED_UP
 *   DELIVERY task: PENDING → ACCEPTED → EN_ROUTE_TO_DROPOFF →
 *             ARRIVED_AT_DROPOFF → DELIVERED
 *
 * Plus terminal side-paths FAILED / CANCELLED from any active state
 * on either task type.
 */
function isAllowedTransition(
  from: TaskStatus,
  to: TaskStatus,
  taskType: 'PICKUP' | 'DELIVERY'
): boolean {
  if (from === to) return true; // idempotent re-saves
  if (to === 'FAILED' || to === 'CANCELLED') {
    // FAILED/CANCELLED reachable from any non-terminal state.
    return !['DELIVERED', 'FAILED', 'CANCELLED'].includes(from);
  }

  // The mid-leg states are mutually exclusive across task types: a
  // PICKUP task transitions through the *_PICKUP set of states, and
  // a DELIVERY task transitions through the *_DROPOFF set. Sharing
  // the same enum across types is a UX choice — the frontend
  // re-uses the same status badge for both — so we branch here.
  if (taskType === 'PICKUP') {
    const pickupFlow: Record<TaskStatus, TaskStatus[]> = {
      PENDING: ['ACCEPTED'],
      ACCEPTED: ['EN_ROUTE_TO_PICKUP'],
      EN_ROUTE_TO_PICKUP: ['ARRIVED_AT_PICKUP'],
      ARRIVED_AT_PICKUP: ['PICKED_UP'],
      PICKED_UP: [], // the PICKUP leg is done; the DELIVERY leg continues
      EN_ROUTE_TO_DROPOFF: [],
      ARRIVED_AT_DROPOFF: [],
      DELIVERED: [],
      FAILED: [],
      CANCELLED: [],
    };
    return pickupFlow[from]?.includes(to) ?? false;
  }

  // DELIVERY task flow.
  const deliveryFlow: Record<TaskStatus, TaskStatus[]> = {
    PENDING: ['ACCEPTED'],
    ACCEPTED: ['EN_ROUTE_TO_DROPOFF'],
    EN_ROUTE_TO_DROPOFF: ['ARRIVED_AT_DROPOFF'],
    ARRIVED_AT_DROPOFF: ['DELIVERED'],
    PICKED_UP: [],
    EN_ROUTE_TO_PICKUP: [],
    ARRIVED_AT_PICKUP: [],
    DELIVERED: [],
    FAILED: [],
    CANCELLED: [],
  };
  return deliveryFlow[from]?.includes(to) ?? false;
}

/**
 * Translate a task status change into the corresponding order status.
 * Returns null when the order status should NOT change (e.g. the task
 * transitioned to ACCEPTED but the order is still pending assignment).
 */
function translateTaskToOrderStatus(
  taskStatus: TaskStatus,
  taskType: 'PICKUP' | 'DELIVERY',
  currentOrderStatus: string
): string | null {
  // PICKUP-task reaching PICKED_UP → order is in transit.
  if (taskType === 'PICKUP' && taskStatus === 'PICKED_UP') {
    return 'picked_up';
  }
  // DELIVERY-task reaching DELIVERED → order is delivered.
  if (taskType === 'DELIVERY' && taskStatus === 'DELIVERED') {
    return 'delivered';
  }
  // DELIVERY-task reaching EN_ROUTE_TO_DROPOFF → order is on its way
  // to the customer. Without this, the order would stay at `picked_up`
  // while the driver walks the DELIVERY leg, and dashboards (which
  // distinguish `picked_up` from `on_the_way`) would render the wrong
  // state. The PICKUP task's terminal state already moves the order
  // to `picked_up`; EN_ROUTE_TO_DROPOFF is the natural mirror for
  // `on_the_way` and what the per-task state machine commits to.
  if (taskType === 'DELIVERY' && taskStatus === 'EN_ROUTE_TO_DROPOFF') {
    if (currentOrderStatus === 'picked_up') return 'on_the_way';
    // If a different state machine already moved the order to
    // `on_the_way` (e.g. geofence auto-deliver pre-staging), don't
    // regress it.
    return null;
  }
  // Any task reaching FAILED / CANCELLED → only flip the order to
  // cancelled if it isn't already terminal.
  if (taskStatus === 'FAILED' || taskStatus === 'CANCELLED') {
    if (['delivered', 'cancelled'].includes(currentOrderStatus)) return null;
    return 'cancelled';
  }
  return null;
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
