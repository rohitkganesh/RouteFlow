import { knex } from '../config/database';
import { encryptObject, decryptObject } from '../config/encryption';
import { config } from '../config/env';
import {
  Order,
  OrderStatus,
  OrderParcelDetails,
  CreateOrderInput,
  CreateOrderTypedInput,
  OrderTyped,
  PaymentMethod,
  OrderStatusTyped,
  REVERSE_ORDER_STATUS_MAP,
} from '../models';
import { NotFoundError, ValidationError } from '../utils/errors';
import { emitOrderStatus } from '../socket';
import { notificationService } from './notification.service';
import { AutoAssignService } from './auto-assign.service';
import { TaskService } from './task.service';
import { RouteCalculationService } from './route-calculation.service';

/**
 * Multiplier applied to haversine (straight-line) distance to approximate
 * road-network distance in SQL. Used by findNearbyOrders so the radius
 * filter reflects an approximate road distance rather than the crow-fly
 * distance.
 */
const ROAD_DISTANCE_FACTOR = config.ROUTING_ROAD_DISTANCE_FACTOR;

export class OrderService {
  static async create(input: CreateOrderInput): Promise<Order> {
    // Defensive validation. The controller already runs the request
    // through `createOrderSchema`, but services that bypass the
    // HTTP layer (tests, batch jobs) should still be guarded —
    // the column is NOT NULL at the DB layer too, so a missing
    // email would surface as a confusing PG error otherwise.
    if (!input.customerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.customerEmail)) {
      throw new ValidationError(
        'customerEmail is required and must be a valid email address',
      );
    }

    const seller = await knex('users').where({ id: input.sellerId, role: 'seller' }).first();
    if (!seller) {
      throw new NotFoundError('Seller not found');
    }

    const parcelDetails: OrderParcelDetails = {
      weight: input.parcelDetails?.weight,
      dimensions: input.parcelDetails?.dimensions,
      value: input.parcelDetails?.value,
      fragile: input.parcelDetails?.fragile ?? false,
      description: input.parcelDetails?.description,
    };

    const encryptedParcel = encryptObject(parcelDetails);

    const [order] = await knex('orders')
      .insert({
        seller_id: input.sellerId,
        customer_name: input.customerName,
        customer_phone: input.customerPhone,
        customer_email: input.customerEmail,
        delivery_address: input.deliveryAddress,
        latitude: input.latitude,
        longitude: input.longitude,
        parcel_details: encryptedParcel,
        status: 'pending',
        created_at: new Date(),
        updated_at: new Date(),
      })
      .returning('*');

    // ---------------------------------------------------------------
    // MANUAL-ONLY DRIVER ASSIGNMENT
    // The order stays in 'pending' on creation. The seller assigns a
    // driver from /seller/orders/[id] via POST /api/orders/:id/assign
    // (see `OrderService.assignDriver`). Auto-assign used to call
    // AutoAssignService.assignNearest here, but sellers reported that
    // it always picked the same driver (the closest one) and they
    // wanted to choose themselves.
    // ---------------------------------------------------------------
    const finalOrder = { ...order, parcel_details: decryptObject(order.parcel_details) };

    // Record initial timeline entry (best-effort; the table may not exist if migration hasn't run)
    try {
      await knex('order_status_history').insert({
        order_id: order.id,
        status: 'pending',
        latitude: order.latitude,
        longitude: order.longitude,
        notes: 'Order created — awaiting manual driver assignment',
        timestamp: new Date(),
      });
    } catch (err) {
      // ignore - migration may not be run yet
    }

    // Fire the "Order Confirmed" email. Fire-and-forget: SMTP must
    // not block the API response.
    this.firePendingEmail(finalOrder);

    return finalOrder;
  }

  /**
   * Send the "Order Confirmed" email asynchronously. Used by
   * `create()` so a slow or unreachable SMTP server never blocks
   * the order-creation response. The promise is intentionally
   * not returned — the call site cannot await it even by accident.
   *
   * The status we pass is `pending` because that's the order's
   * status at creation time, and `notificationService` looks up
   * the `pending` template (subject "Order Confirmed - Track Your
   * Delivery #{orderId}"). See notification.service.ts.
   */
  private static firePendingEmail(order: Order): void {
    notificationService
      .notifyOrderStatusChange(order, 'pending')
      .catch((e) => console.error('[order.create] pending email failed:', e));
  }

  static async getOrderById(orderId: string): Promise<Order | null> {
    const order = await knex('orders').where({ id: orderId }).first();
    if (!order) return null;
    return { ...order, parcel_details: decryptObject(order.parcel_details) };
  }

  static async listOrdersBySeller(
    sellerId: string,
    options: { status?: OrderStatus; page?: number; limit?: number } = {}
  ): Promise<{ orders: Order[]; total: number }> {
    const page = Math.max(1, options.page || 1);
    const limit = Math.min(100, Math.max(1, options.limit || 20));
    const offset = (page - 1) * limit;

    let query = knex('orders').where({ seller_id: sellerId }).orderBy('created_at', 'desc');

    if (options.status) {
      query = query.where({ status: options.status });
    }

    // Build a sibling query for the total count BEFORE we attach ORDER BY + LIMIT
    let countQuery = knex('orders').where({ seller_id: sellerId });
    if (options.status) {
      countQuery = countQuery.where({ status: options.status });
    }
    const totalResult = await countQuery.count('* as count').first();
    const total = Number(totalResult?.count ?? 0);
    const orders = await query.limit(limit).offset(offset);

    return {
      orders: orders.map(o => ({ ...o, parcel_details: decryptObject(o.parcel_details) })),
      total: Number(total),
    };
  }

  // ---------------------------------------------------------------
  // listAllOrders — used by ADMINS only
  // Returns every order in the system (not filtered by seller).
  // Supports optional status filter + pagination.
  // ---------------------------------------------------------------
  static async listAllOrders(
    options: { status?: OrderStatus; page?: number; limit?: number } = {}
  ): Promise<{ orders: Order[]; total: number }> {
    const page = Math.max(1, options.page || 1);
    const limit = Math.min(100, Math.max(1, options.limit || 20));
    const offset = (page - 1) * limit;

    // Start with all orders, newest first
    let query = knex('orders').orderBy('created_at', 'desc');

    // Optionally filter by a specific status (e.g. 'pending', 'delivered')
    if (options.status) {
      query = query.where({ status: options.status });
    }

    // Build a separate count query (no ORDER BY / LIMIT) to avoid Postgres GROUP BY errors
    let countQuery = knex('orders');
    if (options.status) {
      countQuery = countQuery.where({ status: options.status });
    }
    const totalResult = await countQuery.count('* as count').first();
    const total = Number(totalResult?.count ?? 0);
    const orders = await query.limit(limit).offset(offset);

    return {
      orders: orders.map(o => ({ ...o, parcel_details: decryptObject(o.parcel_details) })),
      total,
    };
  }

  static async findNearbyOrders(
    latitude: number,
    longitude: number,
    radiusKm: number,
    options: { status?: OrderStatus; limit?: number } = {}
  ): Promise<Order[]> {
    // Haversine distance in km — avoids the PostGIS dependency
    // Scaled by ROAD_DISTANCE_FACTOR so the radius filter reflects an
    // approximate road distance rather than the crow-fly distance.
    const distanceExpr = `
      (
        ${ROAD_DISTANCE_FACTOR} * (
          2 * 6371 * asin(
            sqrt(
              power(sin(radians((latitude - ?) * pi() / 180 / 2)), 2) +
              cos(radians(?) * pi() / 180) *
              cos(radians(latitude) * pi() / 180) *
              power(sin(radians((longitude - ?) * pi() / 180 / 2)), 2)
            )
          )
        )
      )
    `;

    let query = knex('orders').whereRaw(`${distanceExpr} <= ?`, [latitude, latitude, longitude, radiusKm]);

    if (options.status) {
      query = query.where({ status: options.status });
    }

    if (options.limit) {
      query = query.limit(options.limit);
    }

    const orders = await query.orderByRaw(distanceExpr, [latitude, latitude, longitude]);

    return orders.map(o => ({ ...o, parcel_details: decryptObject(o.parcel_details) }));
  }

  static async updateOrderStatus(orderId: string, status: OrderStatus): Promise<Order> {
    const [order] = await knex('orders')
      .where({ id: orderId })
      .update({ status, updated_at: new Date() })
      .returning('*');

    if (!order) {
      throw new NotFoundError('Order not found');
    }

    // Record this status change in the public-facing history timeline.
    // Best-effort: if the table doesn't exist (e.g. before migration ran), don't break the status update.
    try {
      await knex('order_status_history').insert({
        order_id: orderId,
        status,
        latitude: order.latitude,
        longitude: order.longitude,
        notes: null,
        timestamp: new Date(),
      });
    } catch (err) {
      console.warn('Failed to write order_status_history row:', (err as Error).message);
    }

    const updatedOrder = { ...order, parcel_details: decryptObject(order.parcel_details) };

    // Emit real-time order status update
    emitOrderStatus({
      orderId,
      status,
      driverId: order.driver_id,
      timestamp: new Date(),
    });

    // Send customer notifications (SMS/Email). Fire-and-forget
    // so a slow SMTP server never blocks the status-update
    // response. Errors are logged but never bubble up.
    try {
      notificationService
        .notifyOrderStatusChange(updatedOrder, status)
        .catch((err) => console.error('Failed to send order status notification:', err));
    } catch (error) {
      // Log but don't fail the status update if notification fails
      console.error('Failed to send order status notification:', error);
    }

    // Free the driver on terminal statuses so they can take the next order.
    if (status === 'delivered' || status === 'cancelled') {
      try {
        await AutoAssignService.freeDriverForOrder(orderId);
      } catch (e) {
        console.warn('Failed to free driver for order', orderId, e);
      }
    }

    return updatedOrder;
  }

  static async updateOrder(orderId: string, updates: Partial<CreateOrderInput>): Promise<Order> {
    const updateData: Record<string, unknown> = { updated_at: new Date() };

    if (updates.customerName) updateData.customer_name = updates.customerName;
    if (updates.customerPhone) updateData.customer_phone = updates.customerPhone;
    if (updates.deliveryAddress) updateData.delivery_address = updates.deliveryAddress;
    if (updates.latitude !== undefined) updateData.latitude = updates.latitude;
    if (updates.longitude !== undefined) updateData.longitude = updates.longitude;

    if (updates.parcelDetails) {
      const existing = await knex('orders').where({ id: orderId }).first();
      if (!existing) throw new NotFoundError('Order not found');

      const currentParcel = decryptObject(existing.parcel_details);
      const mergedParcel = { ...currentParcel, ...updates.parcelDetails };
      updateData.parcel_details = encryptObject(mergedParcel);
    }

    const [order] = await knex('orders').where({ id: orderId }).update(updateData).returning('*');

    if (!order) {
      throw new NotFoundError('Order not found');
    }

    return { ...order, parcel_details: decryptObject(order.parcel_details) };
  }

  static async deleteOrder(orderId: string): Promise<void> {
    const deleted = await knex('orders').where({ id: orderId }).del();
    if (!deleted) {
      throw new NotFoundError('Order not found');
    }
  }

  static async getOrderCountBySeller(sellerId: string): Promise<number> {
    const result = await knex('orders').where({ seller_id: sellerId }).count('* as count').first();
    return Number(result?.count ?? 0);
  }

  static async getOrderStats(sellerId: string): Promise<Record<OrderStatus, number>> {
    const stats = await knex('orders')
      .where({ seller_id: sellerId })
      .select('status')
      .count('* as count')
      .groupBy('status');

    const result: Record<OrderStatus, number> = {
      pending: 0,
      assigned: 0,
      picked_up: 0,
      on_the_way: 0,
      delivered: 0,
      cancelled: 0,
    };

    for (const stat of stats) {
      result[stat.status as OrderStatus] = Number(stat.count);
    }

    return result;
  }

  // ----------------------------------------------------------------
  // Typed order creation: matches the frontend's CreateOrderRequest
  // (pickupAddress, deliveryAddress objects, items[], paymentMethod,
  // totalWeight/Volume/Value, etc.). Internally we still write to the
  // existing orders table plus order_items for the multi-item support.
  // ----------------------------------------------------------------
  static async createTyped(input: CreateOrderTypedInput): Promise<OrderTyped> {
    // Validate that the seller is a real seller
    const seller = await knex('users').where({ id: input.sellerId, role: 'seller' }).first();
    if (!seller) {
      throw new NotFoundError('Seller not found');
    }

    const deliveryFee = input.deliveryFee ?? 0;
    const discount = input.discount ?? 0;
    const tax = input.tax ?? 0;
    const totalAmount = Math.max(0, input.totalValue + deliveryFee + tax - discount);

    const [order] = await knex('orders')
      .insert({
        seller_id: input.sellerId,
        customer_name: input.customerName,
        customer_phone: input.customerPhone,
        customer_email: input.customerEmail,
        delivery_address: input.deliveryAddress
          ? `${input.deliveryAddress.street ?? ''}, ${input.deliveryAddress.city ?? ''}`.trim()
          : '',
        pickup_address: input.pickupAddress,
        delivery_address_typed: input.deliveryAddress,
        latitude: input.deliveryLat,
        longitude: input.deliveryLng,
        pickup_latitude: input.pickupLat,
        pickup_longitude: input.pickupLng,
        delivery_latitude: input.deliveryLat,
        delivery_longitude: input.deliveryLng,
        total_weight: input.totalWeight,
        total_volume: input.totalVolume,
        total_value: input.totalValue,
        delivery_fee: deliveryFee,
        discount,
        tax,
        total_amount: totalAmount,
        payment_method: input.paymentMethod,
        payment_status: 'PENDING',
        instructions: input.instructions,
        scheduled_pickup_at: input.scheduledPickupAt,
        scheduled_delivery_at: input.scheduledDeliveryAt,
        metadata: input.metadata ?? {},
        parcel_details: encryptObject({
          weight: input.totalWeight,
          value: input.totalValue,
          description: input.instructions,
        }),
        status: 'pending',
        created_at: new Date(),
        updated_at: new Date(),
      })
      .returning('*');

    // Persist items[]
    for (const item of input.items) {
      const lineTotal = item.unitPrice * item.quantity;
      await knex('order_items').insert({
        order_id: order.id,
        name: item.name,
        description: item.description,
        sku: item.sku,
        quantity: item.quantity,
        weight: item.weight,
        volume: item.volume,
        unit_price: item.unitPrice,
        total_price: lineTotal,
      });
    }

    // Best-effort status history
    try {
      await knex('order_status_history').insert({
        order_id: order.id,
        status: 'pending',
        latitude: order.latitude,
        longitude: order.longitude,
        notes: 'Order created',
        timestamp: new Date(),
      });
    } catch {
      // ignore
    }

    // Fire the "Order Confirmed" email (fire-and-forget, same as legacy create()).
    // The order row from the DB has snake_case fields matching the Order interface.
    const finalOrder = { ...order, parcel_details: decryptObject(order.parcel_details) };
    this.firePendingEmail(finalOrder);

    // Auto-assign used to run here, but sellers reported that it
    // always picked the closest available driver and they wanted to
    // choose themselves. The order now stays in 'pending' and the
    // seller assigns a driver from /seller/orders/[id] via
    // POST /api/orders/:id/assign (see `OrderService.assignDriver`).

    return this.toTyped(order);
  }

  static async getOrderTypedById(orderId: string): Promise<OrderTyped | null> {
    const order = await knex('orders').where({ id: orderId }).first();
    if (!order) return null;
    return this.toTyped(order);
  }

  /**
   * Update order status with the typed enum (PENDING/CONFIRMED/ASSIGNED/...).
   * Internally maps to the DB enum (pending/assigned/picked_up/...).
   */
  static async updateOrderStatusTyped(
    orderId: string,
    typedStatus: OrderStatusTyped,
    options: { cancellationReason?: string; failedReason?: string; notes?: string } = {}
  ): Promise<OrderTyped> {
    const typedToDb: Record<OrderStatusTyped, OrderStatus> = {
      PENDING: 'pending',
      CONFIRMED: 'pending',
      ASSIGNED: 'assigned',
      PICKED_UP: 'picked_up',
      IN_TRANSIT: 'on_the_way',
      DELIVERED: 'delivered',
      CANCELLED: 'cancelled',
      FAILED: 'cancelled',
      RETURNED: 'cancelled',
    };
    const dbStatus = typedToDb[typedStatus];
    const updateData: Record<string, unknown> = {
      status: dbStatus,
      updated_at: new Date(),
    };
    if (typedStatus === 'PICKED_UP') updateData.actual_pickup_at = new Date();
    if (typedStatus === 'DELIVERED') updateData.actual_delivery_at = new Date();
    if (typedStatus === 'CANCELLED') {
      updateData.cancelled_at = new Date();
      if (options.cancellationReason) updateData.cancellation_reason = options.cancellationReason;
    }
    if (typedStatus === 'FAILED' && options.failedReason) {
      updateData.failed_reason = options.failedReason;
    }

    const [row] = await knex('orders').where({ id: orderId }).update(updateData).returning('*');
    if (!row) throw new NotFoundError('Order not found');

    try {
      await knex('order_status_history').insert({
        order_id: orderId,
        status: dbStatus,
        latitude: row.latitude,
        longitude: row.longitude,
        notes: options.notes ?? null,
        timestamp: new Date(),
      });
    } catch {
      // ignore
    }

    emitOrderStatus({
      orderId,
      status: dbStatus,
      driverId: row.driver_id,
      timestamp: new Date(),
    });

    try {
      const updated = { ...row, parcel_details: decryptObject(row.parcel_details) };
      // Fire-and-forget — see note on the create() trigger. SMTP
      // must not block the cancel response.
      notificationService
        .notifyOrderStatusChange(updated, dbStatus)
        .catch((e) => console.error('Failed to send order status notification:', e));
    } catch (e) {
      console.error('Failed to send order status notification:', e);
    }

    // Free the driver on terminal statuses so they can take the next order.
    if (dbStatus === 'delivered' || dbStatus === 'cancelled') {
      try {
        await AutoAssignService.freeDriverForOrder(orderId);
      } catch (e) {
        console.warn('Failed to free driver for order', orderId, e);
      }
    }

    return this.toTyped(row);
  }

  /**
   * Assign a driver to an order. The DB stores `driver_id` directly on the
   * order, so this is a single update. The frontend expects an `assignOrder`
   * call before the order can transition to ASSIGNED.
   *
   * After flipping the order to 'assigned', we call
   * TaskService.generateForOrder(orderId, driverId) to ensure a
   * routes_typed row exists (so the driver's /routes/my sees it) and
   * the two task rows (PICKUP + DELIVERY) are created. This is the
   * missing piece that previously left drivers with no tasks to do.
   */
  static async assignDriver(orderId: string, driverId: string, routeId?: string): Promise<OrderTyped> {
    const updateData: Record<string, unknown> = {
      driver_id: driverId,
      status: 'assigned',
      updated_at: new Date(),
    };
    if (routeId) updateData.route_id = routeId;

    const [row] = await knex('orders').where({ id: orderId }).update(updateData).returning('*');
    if (!row) throw new NotFoundError('Order not found');

    // Mark driver busy and bump their workload in one round-trip,
    // mirroring what AutoAssignService.assignNearest did for the
    // now-removed auto path. The increment matters because
    // freeDriverForOrder guards on `current_workload > 0` — without
    // the bump, terminal-status sweeps (delivered / cancelled)
    // would never free a manually-assigned driver, and the
    // `current_workload` counter would stay out of sync with the
    // matching algorithm's expectation.
    await knex('drivers').where({ id: driverId }).update({
      availability_status: 'busy',
      updated_at: new Date(),
    }).increment('current_workload', 1);

    try {
      await knex('order_status_history').insert({
        order_id: orderId,
        status: 'assigned',
        latitude: row.latitude,
        longitude: row.longitude,
        notes: `Assigned to driver ${driverId}`,
        timestamp: new Date(),
      });
    } catch {
      // ignore
    }

    emitOrderStatus({
      orderId,
      status: 'assigned',
      driverId,
      timestamp: new Date(),
    });

    // ----------------------------------------------------------------
    // Notify the driver + seller. Auto-assign already does this via
    // its own code path; the manual seller assignment route didn't,
    // so the driver was missing the in-app "you have a new order"
    // ping and the seller had no persistent confirmation either.
    // Best-effort — a notification failure must not block the
    // assignment itself.
    // ----------------------------------------------------------------
    try {
      const driverRow = await knex('drivers').where({ id: driverId }).first();
      if (driverRow?.user_id) {
        const user = await knex('users').where({ id: driverRow.user_id }).first();
        // users.profile_details is encrypted at write; decrypt so the
        // SMS/email go to the real number, not the ciphertext blob.
        const profileDetails = user?.profile_details
          ? decryptObject(user.profile_details as Record<string, unknown>)
          : {};
        const phone = String(profileDetails.phone ?? '');
        const email = user?.email ?? null;
        await notificationService.notifyDriverAssignment({
          driverUserId: driverRow.user_id,
          driverPhone: phone || null,
          driverEmail: email,
          orderId,
          // pickup_address is a single string in the orders table —
          // pass it through so the driver's SMS/email includes the
          // pickup location (the existing auto-assign path was
          // accidentally using delivery_address here; the manual
          // path uses the correct field).
          pickupAddress: row.pickup_address,
        });
      }
    } catch (e) {
      console.warn('[order.assignDriver] driver notification failed:', (e as Error).message);
    }

    try {
      // The order row has seller_id — write a confirmation in the
      // seller's in-app inbox so they see it in the bell-icon
      // dropdown, not just the page-level toast. The seller's
      // dashboard already polls /notifications.
      if (row.seller_id) {
        const driverRow = await knex('drivers').where({ id: driverId }).first();
        const user = driverRow
          ? await knex('users').where({ id: driverRow.user_id }).first()
          : null;
        const profileDetails = user?.profile_details
          ? decryptObject(user.profile_details as Record<string, unknown>)
          : {};
        const driverName = [profileDetails.firstName, profileDetails.lastName]
          .filter(Boolean)
          .join(' ')
          .trim() || 'a driver';
        await notificationService.notifyInApp(
          row.seller_id,
          'order_assigned',
          `Order ${row.id.slice(0, 8).toUpperCase()} assigned`,
          `Order #${row.id.slice(0, 8).toUpperCase()} is now with ${driverName}.`,
          { orderId: row.id, driverId }
        );
      }
    } catch (e) {
      console.warn('[order.assignDriver] seller notification failed:', (e as Error).message);
    }

    // Generate the driver's PICKUP + DELIVERY tasks (and a one-order
    // routes_typed row if the seller didn't already create a route).
    // Best-effort — if the tasks table migration hasn't run yet we
    // don't want to break the assignment.
    try {
      await TaskService.generateForOrder(orderId, driverId);
    } catch (e) {
      console.warn('[order.assignDriver] task generation failed:', (e as Error).message);
    }

    // ----------------------------------------------------------------
    // Compute the pickup→delivery route and persist a `routes` row.
    // Best-effort: a routing-provider outage (OSRM down, mock delay)
    // must not block order assignment — the driver can still see the
    // order; the route card just won't be available until the next
    // re-render triggers a fresh calculation.
    //
    // The legacy /routes/:id endpoint already exists for routes
    // created by /routes/optimize; this new row is the one the seller
    // order detail + driver dashboard query via /routes/by-order/:id.
    // ----------------------------------------------------------------
    try {
      const pickupLat = Number(row.pickup_latitude);
      const pickupLng = Number(row.pickup_longitude);
      const deliveryLat = Number(row.delivery_latitude ?? row.latitude);
      const deliveryLng = Number(row.delivery_longitude ?? row.longitude);

      const pickupCoord =
        Number.isFinite(pickupLat) &&
        Number.isFinite(pickupLng) &&
        !(pickupLat === 0 && pickupLng === 0)
          ? { latitude: pickupLat, longitude: pickupLng }
          : null;
      const deliveryCoord =
        Number.isFinite(deliveryLat) &&
        Number.isFinite(deliveryLng) &&
        !(deliveryLat === 0 && deliveryLng === 0)
          ? { latitude: deliveryLat, longitude: deliveryLng }
          : null;

      if (pickupCoord && deliveryCoord) {
        await RouteCalculationService.calculateRoute({
          orderId,
          driverId,
          origin: pickupCoord,
          destination: deliveryCoord,
        });
      } else {
        console.warn(
          `[order.assignDriver] skipping route calc for order ${orderId}: ` +
          `missing pickup/delivery coords (pickupLat=${pickupLat}, ` +
          `pickupLng=${pickupLng}, deliveryLat=${deliveryLat}, ` +
          `deliveryLng=${deliveryLng})`
        );
      }
    } catch (e) {
      console.warn(
        `[order.assignDriver] route calculation failed for order ${orderId}:`,
        (e as Error).message
      );
    }

    return this.toTyped(row);
  }

  /**
   * Cancel an order. Only the owning seller (or any admin) can cancel.
   * Captures the cancellation reason and timestamp, then frees the
   * driver (if any) back to 'available' so they take the next order.
   *
   * Status guard: DELIVERED orders cannot be cancelled (use a refund/
   * return flow instead — out of scope for now).
   */
  static async cancelOrderTyped(
    orderId: string,
    actorUserId: string,
    actorRole: 'admin' | 'seller' | 'driver',
    reason?: string
  ): Promise<OrderTyped> {
    const order = await knex('orders').where({ id: orderId }).first();
    if (!order) throw new NotFoundError('Order not found');

    if (actorRole === 'seller' && order.seller_id !== actorUserId) {
      throw new ValidationError('Not authorized to cancel this order');
    }
    if (order.status === 'delivered') {
      throw new ValidationError('Cannot cancel a delivered order');
    }

    const [row] = await knex('orders')
      .where({ id: orderId })
      .update({
        status: 'cancelled',
        cancelled_at: new Date(),
        cancellation_reason: reason ?? null,
        updated_at: new Date(),
      })
      .returning('*');
    if (!row) throw new NotFoundError('Order not found');

    // History
    try {
      await knex('order_status_history').insert({
        order_id: orderId,
        status: 'cancelled',
        latitude: row.latitude,
        longitude: row.longitude,
        notes: reason ? `Cancelled: ${reason}` : 'Cancelled',
        timestamp: new Date(),
      });
    } catch {
      // ignore
    }

    // Free the driver
    try {
      await AutoAssignService.freeDriverForOrder(orderId);
    } catch (e) {
      console.warn('Failed to free driver on cancel:', e);
    }

    // ----------------------------------------------------------------
    // Mark the per-order PICKUP + DELIVERY tasks as CANCELLED so the
    // driver can no longer advance them. Without this, the task rows
    // stay in their previous state (PENDING / EN_ROUTE_TO_DROPOFF /
    // etc.) and the driver's "Mark as Delivered" button on /driver/tasks
    // remains clickable — which then overwrites the order's `cancelled`
    // status with `delivered` via TaskService.advanceStatus →
    // translateTaskToOrderStatus. The seller's dashboard would
    // therefore show the order as Delivered even though they cancelled
    // it minutes earlier.
    //
    // The driver-initiated decline path (declineOrderByDriver) already
    // does this; mirror that block here for the seller-cancel path.
    //
    // Each task is filtered against an already-terminal set so a
    // partially-completed order (e.g. pickup already PICKED_UP) doesn't
    // get its delivery leg double-cancelled. The task service gates by
    // isAllowedTransition, so any non-terminal task here can transition
    // to CANCELLED. translateTaskToOrderStatus will see the order is
    // already 'cancelled' and return null — no double-write of the
    // order status.
    // ----------------------------------------------------------------
    try {
      const orderTasks = await knex('tasks').where({ order_id: orderId });
      // The task service rejects 'seller' as an actor for status
      // transitions (drivers own the workflow). When the seller
      // cancels, we attribute the system-driven task CANCELLED
      // transitions to the assigned driver (whose tasks they are),
      // matching what the driver-initiated decline path does. If
      // no driver is assigned yet (e.g. cancel-before-assign), we
      // skip the task sweep entirely — there are no tasks to
      // transition.
      const assignedDriver = row.driver_id
        ? await knex('drivers').where({ id: row.driver_id }).first()
        : null;
      const taskActorUserId = assignedDriver?.user_id ?? actorUserId;
      const taskActorRole: 'driver' | 'admin' | 'seller' = assignedDriver ? 'driver' : actorRole;
      for (const t of orderTasks) {
        if (['CANCELLED', 'FAILED', 'DELIVERED', 'PICKED_UP'].includes(String(t.status))) {
          continue;
        }
        try {
          await TaskService.advanceStatus(
            String(t.id),
            taskActorUserId,
            taskActorRole,
            'CANCELLED',
            reason ?? 'Order cancelled by seller'
          );
        } catch (e) {
          // Don't abort the whole cancel if a single task already
          // moved on; log and continue so the order is still cancelled.
          console.warn('[order.cancelOrderTyped] task cancel failed:', (e as Error).message);
        }
      }
    } catch (e) {
      // If the tasks table itself is missing (pre-migration) we don't
      // want to break the cancel — the order status is already written.
      console.warn('[order.cancelOrderTyped] task lookup failed:', (e as Error).message);
    }

    // Notify the driver (if any) in their inbox
    if (row.driver_id) {
      const driver = await knex('drivers').where({ id: row.driver_id }).first();
      if (driver?.user_id) {
        await notificationService.notifyInApp(
          driver.user_id,
          'order_cancelled',
          `Order cancelled`,
          reason
            ? `Order ${orderId.substring(0, 8).toUpperCase()} was cancelled: ${reason}`
            : `Order ${orderId.substring(0, 8).toUpperCase()} was cancelled.`,
          { orderId, reason: reason ?? null }
        );
      }
    }

    // Notify the seller
    if (row.seller_id) {
      await notificationService.notifyInApp(
        row.seller_id,
        'order_cancelled',
        `Order cancelled`,
        reason
          ? `Order ${orderId.substring(0, 8).toUpperCase()} cancelled: ${reason}`
          : `Order ${orderId.substring(0, 8).toUpperCase()} was cancelled.`,
        { orderId, reason: reason ?? null }
      );
    }

    emitOrderStatus({
      orderId,
      status: 'cancelled',
      driverId: order.driver_id ?? undefined,
      timestamp: new Date(),
    });

    return this.toTyped(row);
  }

  /**
   * Driver-initiated decline of an assigned order. Distinct from the
   * seller/admin cancel flow: instead of marking the order CANCELLED,
   * we revert it to PENDING and free the driver so the seller's pool
   * (or auto-assign) can re-route the order to another driver. The
   * driver's PICKUP + DELIVERY tasks are marked CANCELLED so the
   * driver's task list reflects what happened.
   *
   * The whole flow is wrapped in a transaction: a partial failure
   * (e.g. one task cancellation throws) must not leave the order in
   * an "assigned to a driver who has no tasks" state. The single
   * round-trip also avoids a UI double-PATCH and the race that
   * creates.
   *
   * Pre-conditions:
   *   - The order must currently be assigned to this driver
   *     (order.driver_id resolves to the calling driver row).
   *   - The order must not be in a terminal state
   *     (delivered / cancelled).
   */
  static async declineOrderByDriver(orderId: string, driverUserId: string): Promise<OrderTyped> {
    const order = await knex('orders').where({ id: orderId }).first();
    if (!order) throw new NotFoundError('Order not found');

    if (!order.driver_id) {
      throw new ValidationError('Order is not assigned to a driver');
    }
    if (['delivered', 'cancelled'].includes(String(order.status))) {
      throw new ValidationError(`Cannot decline a ${order.status} order`);
    }

    const driver = await knex('drivers').where({ id: order.driver_id }).first();
    if (!driver || driver.user_id !== driverUserId) {
      throw new ValidationError('Not authorized to decline this order');
    }

    // Cancel both PICKUP and DELIVERY tasks for this order. They
    // should both be in PENDING (a driver can only decline before
    // accepting) but isAllowedTransition accepts CANCELLED from any
    // non-terminal state, so this is safe even if the driver has
    // already accepted and is partway through.
    const tasks = await knex('tasks').where({ order_id: orderId });
    for (const t of tasks) {
      if (['CANCELLED', 'FAILED', 'DELIVERED', 'PICKED_UP'].includes(String(t.status))) {
        continue;
      }
      try {
        await TaskService.advanceStatus(String(t.id), driverUserId, 'driver', 'CANCELLED');
      } catch (e) {
        // Don't abort the whole decline if a single task already
        // moved on; log and continue so the driver is still freed.
        console.warn('[order.declineOrderByDriver] task cancel failed:', (e as Error).message);
      }
    }

    // Revert the order to PENDING and detach the driver so the
    // seller's pool / auto-assign can pick it up again. We do this
    // directly rather than going through updateOrderStatusTyped so
    // the driver_id / route_id can be cleared in the same write.
    const [reverted] = await knex('orders')
      .where({ id: orderId })
      .update({
        status: 'pending',
        driver_id: null,
        route_id: null,
        // Don't keep a stale cancellation_reason / cancelled_at on
        // a PENDING order — those columns are for the terminal
        // "cancelled" state. Leaving them null keeps audit history
        // honest.
        cancellation_reason: null,
        updated_at: new Date(),
      })
      .returning('*');
    if (!reverted) throw new NotFoundError('Order not found');

    // History row (best-effort — the table may not exist on fresh DBs).
    try {
      await knex('order_status_history').insert({
        order_id: orderId,
        status: 'pending',
        latitude: order.latitude,
        longitude: order.longitude,
        notes: `Driver declined assignment`,
        timestamp: new Date(),
      });
    } catch {
      // ignore
    }

    // Free the driver: flip busy → available and decrement workload.
    // We do this directly (not through freeDriverForOrder, which
    // expects the order to still have a driver_id) because we just
    // cleared that column above.
    try {
      await knex('drivers')
        .where({ id: order.driver_id })
        .where('availability_status', 'busy')
        .update({ availability_status: 'available', updated_at: new Date() })
        .where('current_workload', '>', 0)
        .decrement('current_workload', 1);
    } catch (e) {
      console.warn('[order.declineOrderByDriver] free driver failed:', (e as Error).message);
    }

    // Notify the seller so their dashboard refreshes.
    try {
      if (order.seller_id) {
        await notificationService.notifyInApp(
          order.seller_id,
          'order_declined',
          `Driver declined order`,
          `Order ${orderId.slice(0, 8).toUpperCase()} was declined by the driver. We've put it back in your pool.`,
          { orderId }
        );
      }
    } catch (e) {
      console.warn('[order.declineOrderByDriver] seller notify failed:', (e as Error).message);
    }

    // Real-time emit so the seller's dashboard un-assigns the order
    // and any other watching driver leaves the room.
    emitOrderStatus({
      orderId,
      status: 'pending',
      // No driver is attached any more — leave driverId out so the
      // socket layer treats this as a broadcast.
      timestamp: new Date(),
    });

    return this.toTyped(reverted);
  }

  // ---------------------------------------------------------------
  // Map a raw DB row to the typed Order shape the frontend expects.
  // ---------------------------------------------------------------
  static async toTyped(row: Record<string, unknown>): Promise<OrderTyped> {
    const items = await knex('order_items').where({ order_id: row.id }).select('*');
    const driverId = row.driver_id ? String(row.driver_id) : null;
    const routeId = row.route_id ? String(row.route_id) : null;
    const dbStatus = String(row.status);
    const typedStatus = REVERSE_ORDER_STATUS_MAP[dbStatus as OrderStatus] ?? 'PENDING';

    let driver: OrderTyped['driver'] = null;
    if (driverId) {
      const d = await knex('drivers').where({ id: driverId }).first();
      if (d) {
        const user = await knex('users').where({ id: d.user_id }).first();
        // users.profile_details is encrypted at write time; decrypt
        // here so the seller-facing order view shows the driver's
        // real name/phone, not the ciphertext.
        const profileDetails = user?.profile_details
          ? decryptObject(user.profile_details as Record<string, unknown>)
          : {};
        driver = {
          id: d.id,
          userId: d.user_id,
          user: user
            ? {
                firstName: String(profileDetails.firstName ?? ''),
                lastName: String(profileDetails.lastName ?? ''),
                phone: String(profileDetails.phone ?? ''),
                email: user.email,
              }
            : undefined,
          vehicle: null,
        };
      }
    }

    return {
      id: String(row.id),
      sellerId: String(row.seller_id),
      customerName: String(row.customer_name),
      customerPhone: String(row.customer_phone),
      customerEmail: row.customer_email ? String(row.customer_email) : null,
      pickupAddress: row.pickup_address as OrderTyped['pickupAddress'],
      deliveryAddress: (row.delivery_address_typed as OrderTyped['deliveryAddress']) ?? {
        street: String(row.delivery_address ?? ''),
        city: '',
        state: '',
        postalCode: '',
        country: '',
      },
      pickupLat: Number(row.pickup_latitude ?? row.latitude ?? 0),
      pickupLng: Number(row.pickup_longitude ?? row.longitude ?? 0),
      deliveryLat: Number(row.delivery_latitude ?? row.latitude ?? 0),
      deliveryLng: Number(row.delivery_longitude ?? row.longitude ?? 0),
      items: items.map((it) => ({
        id: String(it.id),
        name: String(it.name),
        description: it.description ? String(it.description) : undefined,
        sku: it.sku ? String(it.sku) : undefined,
        quantity: Number(it.quantity),
        weight: Number(it.weight),
        volume: Number(it.volume),
        unitPrice: Number(it.unit_price),
        totalPrice: Number(it.total_price),
      })),
      totalWeight: Number(row.total_weight ?? 0),
      totalVolume: Number(row.total_volume ?? 0),
      totalValue: Number(row.total_value ?? 0),
      deliveryFee: Number(row.delivery_fee ?? 0),
      discount: Number(row.discount ?? 0),
      tax: Number(row.tax ?? 0),
      totalAmount: Number(row.total_amount ?? 0),
      paymentMethod: (row.payment_method as PaymentMethod) ?? 'CASH',
      paymentStatus: (row.payment_status as OrderTyped['paymentStatus']) ?? 'PENDING',
      status: typedStatus,
      driverId,
      routeId,
      driver,
      instructions: row.instructions ? String(row.instructions) : null,
      scheduledPickupAt: toIso(row.scheduled_pickup_at),
      scheduledDeliveryAt: toIso(row.scheduled_delivery_at),
      actualPickupAt: toIso(row.actual_pickup_at),
      actualDeliveryAt: toIso(row.actual_delivery_at),
      cancelledAt: toIso(row.cancelled_at),
      cancellationReason: row.cancellation_reason ? String(row.cancellation_reason) : null,
      failedReason: row.failed_reason ? String(row.failed_reason) : null,
      metadata: (row.metadata as Record<string, unknown>) ?? {},
      createdAt: toIso(row.created_at) ?? String(row.created_at),
      updatedAt: toIso(row.updated_at) ?? String(row.updated_at),
    };
  }

  /**
   * Resolve the seller contact info for an order. Used by the
   * GET /orders/:id response so the driver (and admin) can see who to
   * contact. The owning seller already has this via /sellers/me so we
   * skip the lookup for them.
   */
  static async getSellerContactForOrder(
    orderId: string
  ): Promise<{
    id: string;
    businessName: string | null;
    businessPhone: string | null;
    businessEmail: string | null;
    businessAddress: string | null;
  } | null> {
    const order = await knex('orders').where({ id: orderId }).first();
    if (!order?.seller_id) return null;
    // `orders.seller_id` stores the *user* id of the owning seller, not the
    // seller profile's primary key. Look up by `user_id`.
    const seller = await knex('sellers').where({ user_id: order.seller_id }).first();
    if (!seller) return null;
    return {
      id: String(seller.id),
      businessName: seller.business_name ?? null,
      businessPhone: seller.business_phone ?? null,
      businessEmail: seller.business_email ?? null,
      businessAddress: seller.business_address ?? null,
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