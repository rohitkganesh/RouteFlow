import { knex } from '../config/database';
import { Route, RouteStatus, CreateRouteInput } from '../models';
import { NotFoundError, ValidationError, ForbiddenError } from '../utils/errors';
import { routingService, OptimizedRoute } from './routing.service';

export class RouteService {
  static async getRouteById(routeId: string): Promise<Route | null> {
    return knex('routes').where({ id: routeId }).first();
  }

  static async createRoute(input: CreateRouteInput): Promise<Route> {
    const [route] = await knex('routes')
      .insert({
        order_id: input.orderId,
        driver_id: input.driverId,
        optimized_polyline: input.optimizedPolyline,
        estimated_travel_time: input.estimatedTravelTime,
        estimated_distance: input.estimatedDistance,
        status: 'planned',
        created_at: new Date(),
        updated_at: new Date(),
      })
      .returning('*');

    return route;
  }

  static async findById(routeId: string): Promise<Route | null> {
    return knex('routes').where({ id: routeId }).first();
  }

  static async findByOrderId(orderId: string): Promise<Route | null> {
    return knex('routes').where({ order_id: orderId }).first();
  }

  static async listRoutesByDriver(
    driverId: string,
    options: { status?: RouteStatus; page?: number; limit?: number } = {}
  ): Promise<{ routes: Route[]; total: number }> {
    const page = Math.max(1, options.page || 1);
    const limit = Math.min(100, Math.max(1, options.limit || 20));
    const offset = (page - 1) * limit;

    let query = knex('routes').where({ driver_id: driverId }).orderBy('created_at', 'desc');

    if (options.status) {
      query = query.where({ status: options.status });
    }

    // Build a separate count query without ORDER BY / LIMIT to avoid Postgres GROUP BY errors
    let countQuery = knex('routes').where({ driver_id: driverId });
    if (options.status) {
      countQuery = countQuery.where({ status: options.status });
    }
    const totalResult = await countQuery.count('* as count').first();
    const total = Number(totalResult?.count ?? 0);
    const routes = await query.limit(limit).offset(offset);

    return { routes, total: Number(total) };
  }

  static async updateRouteStatus(routeId: string, status: RouteStatus): Promise<Route> {
    const [route] = await knex('routes')
      .where({ id: routeId })
      .update({ status, updated_at: new Date() })
      .returning('*');

    if (!route) {
      throw new NotFoundError('Route not found');
    }

    return route;
  }

  static async updatePolyline(routeId: string, optimizedPolyline: string): Promise<Route> {
    const [route] = await knex('routes')
      .where({ id: routeId })
      .update({ optimized_polyline: optimizedPolyline, updated_at: new Date() })
      .returning('*');

    if (!route) {
      throw new NotFoundError('Route not found');
    }

    return route;
  }

  static async deleteRoute(routeId: string): Promise<void> {
    const deleted = await knex('routes').where({ id: routeId }).del();
    if (!deleted) {
      throw new NotFoundError('Route not found');
    }
  }

  static async getRouteStats(driverId: string): Promise<Record<RouteStatus, number>> {
    const stats = await knex('routes')
      .where({ driver_id: driverId })
      .select('status')
      .count('* as count')
      .groupBy('status');

    const result: Record<RouteStatus, number> = {
      planned: 0,
      active: 0,
      completed: 0,
      cancelled: 0,
    };

    for (const stat of stats) {
      result[stat.status as RouteStatus] = Number(stat.count);
    }

    return result;
  }

  /**
   * Optimize delivery route for a driver with multiple orders.
   *
   * Uses the Pickup-and-Delivery TSP solver so the route respects the
   * physical constraint that every pickup is visited before its
   * matching delivery. The driver must be 'available' and the caller
   * (if a seller) must own all of the orders.
   *
   * For each order we insert a single `routes` row tagged with the
   * order's position in the optimized delivery sequence. The total
   * route distance / duration already includes the driver-to-first
   * pickup, the between-pickups, and the between-deliveries legs.
   */
  static async optimizeDeliveryRoute(
    driverId: string,
    orderIds: string[],
    options: { callerRole?: 'admin' | 'seller' | 'driver'; callerId?: string } = {}
  ): Promise<OptimizedRoute> {
    if (!orderIds || orderIds.length === 0) {
      throw new ValidationError('At least one order ID is required');
    }

    // Guard: driver must exist and be available
    const driver = await knex('drivers').where({ id: driverId }).first();
    if (!driver) {
      throw new NotFoundError('Driver not found');
    }
    if (driver.availability_status !== 'available') {
      throw new ValidationError(
        `Driver is not available (status: ${driver.availability_status})`
      );
    }

    // Guard: if caller is a seller, every order must belong to them
    if (options.callerRole === 'seller' && options.callerId) {
      const orderRows = await knex('orders')
        .select('id', 'seller_id')
        .whereIn('id', orderIds);
      if (orderRows.length !== orderIds.length) {
        const foundIds = orderRows.map(o => o.id);
        const missing = orderIds.filter(id => !foundIds.includes(id));
        throw new NotFoundError(`Orders not found: ${missing.join(', ')}`);
      }
      const foreign = orderRows.filter(o => o.seller_id !== options.callerId);
      if (foreign.length > 0) {
        throw new ForbiddenError(
          `You do not own these orders: ${foreign.map(o => o.id).join(', ')}`
        );
      }
    }

    // Get optimized route via the PDP solver. The driver check above
    // has already confirmed the driver is 'available' but the routing
    // service still re-checks that the driver has a current location.
    const optimizedRoute = await routingService.optimizeDeliveryRoutePDP(driverId, orderIds);

    // Create one `routes` row per order. The per-row distance and
    // duration are the leg from that order's pickup to its delivery
    // (the business-meaningful cost for the order) — the routing
    // service exposes this in `orderLegs`, aligned with `sequence`.
    // The total route distance / duration in the response already
    // includes the full path.
    const createdRoutes: Route[] = [];
    for (let i = 0; i < optimizedRoute.sequence.length; i++) {
      const orderId = optimizedRoute.sequence[i];
      const leg = optimizedRoute.orderLegs?.[i] ?? optimizedRoute.legs[i];

      const [route] = await knex('routes')
        .insert({
          order_id: orderId,
          driver_id: driverId,
          optimized_polyline: leg.polyline,
          estimated_travel_time: leg.duration,
          estimated_distance: leg.distance,
          sequence_index: i,
          status: 'planned',
          created_at: new Date(),
          updated_at: new Date(),
        })
        .returning('*');

      createdRoutes.push(route);
    }

    // Update order statuses to 'assigned'
    await knex('orders')
      .whereIn('id', orderIds)
      .update({ status: 'assigned', updated_at: new Date() });

    return {
      ...optimizedRoute,
      routeIds: createdRoutes.map(r => r.id),
    };
  }

  /**
   * Get optimized route details by driver and order IDs
   */
  static async getOptimizedRoute(driverId: string, orderIds: string[]): Promise<{
    routes: Route[];
    sequence: string[];
    totalDistance: number;
    totalDuration: number;
  }> {
    const routes = await knex('routes')
      .where({ driver_id: driverId })
      .whereIn('order_id', orderIds)
      .orderBy('created_at', 'asc');

    const sequence = orderIds.filter(id => routes.some(r => r.order_id === id));
    const totalDistance = routes.reduce((sum, r) => sum + Number(r.estimated_distance), 0);
    const totalDuration = routes.reduce((sum, r) => sum + Number(r.estimated_travel_time), 0);

    return { routes, sequence, totalDistance, totalDuration };
  }
}