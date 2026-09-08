import { AuthenticatedRequest } from '../middlewares/auth.middleware.js';
import { UserService } from '../services/user.service.js';
import { OrderService } from '../services/order.service.js';
import { DriverService } from '../services/driver.service.js';
import { RouteService } from '../services/route.service.js';
import { SellerService } from '../services/seller.service.js';
import { createOrderSchema } from '../validators/order.validators';
import { VehicleService } from '../services/vehicle.service.js';
import { RouteTypedService } from '../services/route-typed.service.js';
import { TaskService } from '../services/task.service.js';
import { notificationService } from '../services/notification.service.js';
import { knex } from '../config/database.js';
import Knex from 'knex';
import { Response, NextFunction } from 'express';
import { NotFoundError, ForbiddenError, ValidationError } from '../utils/errors.js';
import { decryptObject } from '../config/encryption.js';
import {
  OrderStatus,
  DriverAvailability,
  RouteStatus,
  OrderStatusTyped,
  CreateOrderTypedInput,
  CreateVehicleInput,
  CreateRouteTypedInput,
  OrderTyped,
  TaskStatus,
} from '../models/index.js';

export class UserController {
  static async getProfile(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) throw new ForbiddenError('Authentication required');

      const user = await UserService.findById(req.user.sub);
      if (!user) throw new NotFoundError('User not found');

      res.json({ success: true, data: { user } });
    } catch (error) {
      next(error);
    }
  }

  static async updateProfile(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) throw new ForbiddenError('Authentication required');

      const { profileDetails } = req.body;
      const user = await UserService.updateProfile(req.user.sub, profileDetails);

      res.json({ success: true, data: { user }, message: 'Profile updated' });
    } catch (error) {
      next(error);
    }
  }

  static async listUsers(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
      const role = req.query.role as 'admin' | 'seller' | 'driver' | undefined;

      const { users, total } = await UserService.findByRolePaginated(role ?? 'seller', { page, limit });

      res.json({
        success: true,
        data: users,
        meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
      });
    } catch (error) {
      next(error);
    }
  }
}

export class OrderController {
  static async createOrder(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user || req.user.role !== 'seller') {
        throw new ForbiddenError('Only sellers can create orders');
      }

      // Parse + validate the body. A failure throws a ZodError,
      // which the global error handler maps to a 400 with
      // field-level details. customerEmail is required here —
      // it has been since the 2026-09-07 audit.
      const body = createOrderSchema.parse(req.body);
      const order = await OrderService.create({
        sellerId: req.user.sub,
        customerName: body.customerName,
        customerPhone: body.customerPhone,
        customerEmail: body.customerEmail,
        deliveryAddress: body.deliveryAddress,
        // The legacy CreateOrderInput requires lat/lng as numbers;
        // default to (0, 0) which the service treats as "no pickup
        // coords — order stays PENDING until manual assign".
        latitude: body.latitude ?? 0,
        longitude: body.longitude ?? 0,
        // Cast: Zod's parcelDetails shape is slightly stricter than
        // the model's `Partial<OrderParcelDetails>` (e.g. dimensions
        // is `string` here but `{ length, width, height }` on the
        // model). The service treats it as an opaque payload, so the
        // structural mismatch is safe to ignore.
        parcelDetails: body.parcelDetails as
          | Partial<import('../models').OrderParcelDetails>
          | undefined,
      });
      res.status(201).json({ success: true, data: { order }, message: 'Order created' });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /orders/stats
   * Returns the count of orders in each status for the current seller
   * (or for every seller, when the caller is an admin).
   *
   * IMPORTANT: This route must be registered BEFORE /orders/:id in the
   * router, otherwise Express will treat "stats" as an order id and
   * 400-out with a UUID validation error.
   */
  static async getStats(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) throw new ForbiddenError('Authentication required');

      if (req.user.role === 'admin') {
        // Aggregate across the entire platform
        const stats = await knex('orders')
          .select('status')
          .count('* as count')
          .groupBy('status');
        const result: Record<string, number> = {
          pending: 0,
          assigned: 0,
          picked_up: 0,
          on_the_way: 0,
          delivered: 0,
          cancelled: 0,
        };
        for (const s of stats) result[s.status] = Number(s.count);
        res.json({ success: true, data: result });
      } else if (req.user.role === 'seller') {
        const stats = await OrderService.getOrderStats(req.user.sub);
        res.json({ success: true, data: stats });
      } else {
        throw new ForbiddenError('Not authorized');
      }
    } catch (error) {
      next(error);
    }
  }

  static async getOrder(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const order = await OrderService.getOrderById(req.params.id);
      if (!order) throw new NotFoundError('Order not found');

      if (req.user?.role === 'seller' && order.seller_id !== req.user.sub) {
        throw new ForbiddenError('Not authorized to view this order');
      }

      res.json({ success: true, data: { order } });
    } catch (error) {
      next(error);
    }
  }

  static async listOrders(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      // Only sellers and admins are allowed to call this endpoint
      if (!req.user || !['seller', 'admin'].includes(req.user.role)) {
        throw new ForbiddenError('Only sellers and admins can list orders');
      }

      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
      const status = req.query.status as OrderStatus;

      // ---------------------------------------------------------------
      // ROLE-BASED DATA FILTERING
      // - Admins see ALL orders in the system (no seller filter)
      // - Sellers only see orders they created (filtered by their own ID)
      // ---------------------------------------------------------------
      if (req.user.role === 'admin') {
        // Admin path: fetch every order, regardless of seller
        const { orders, total } = await OrderService.listAllOrders({ page, limit, status });
        res.json({
          success: true,
          data: orders,
          meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
        });
      } else {
        // Seller path: fetch only this seller's own orders
        const { orders, total } = await OrderService.listOrdersBySeller(req.user.sub, { page, limit, status });
        res.json({
          success: true,
          data: orders,
          meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
        });
      }
    } catch (error) {
      next(error);
    }
  }

  static async updateOrderStatus(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { status } = req.body;
      const order = await OrderService.updateOrderStatus(req.params.id, status);
      res.json({ success: true, data: { order }, message: 'Order status updated' });
    } catch (error) {
      next(error);
    }
  }
}

export class DriverController {
  static async createDriverProfile(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user || req.user.role !== 'driver') {
        throw new ForbiddenError('Only drivers can create driver profiles');
      }

      const driver = await DriverService.createDriverProfile(req.user.sub);
      res.status(201).json({ success: true, data: { driver }, message: 'Driver profile created' });
    } catch (error) {
      next(error);
    }
  }

  static async updateLocation(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user || req.user.role !== 'driver') {
        throw new ForbiddenError('Only drivers can update location');
      }

      const { latitude, longitude } = req.body;
      if (typeof latitude !== 'number' || typeof longitude !== 'number') {
        throw new ValidationError('Invalid coordinates');
      }

      const driver = await DriverService.updateDriverLocation(req.user.sub, { latitude, longitude });
      res.json({
        success: true,
        data: { driver: DriverController['toCamelDriver'](driver) },
        message: 'Location updated',
      });
    } catch (error) {
      next(error);
    }
  }

  static async updateAvailability(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user || req.user.role !== 'driver') {
        throw new ForbiddenError('Only drivers can update availability');
      }

      const { availabilityStatus } = req.body;
      const driver = await DriverService.updateDriverAvailability(req.user.sub, { availabilityStatus });
      res.json({
        success: true,
        data: { driver: DriverController['toCamelDriver'](driver) },
        message: 'Availability updated',
      });
    } catch (error) {
      next(error);
    }
  }

  static async getMe(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) throw new ForbiddenError('Authentication required');
      if (req.user.role !== 'driver') {
        throw new ForbiddenError('Only drivers can call /drivers/me');
      }
      // Return the calling driver's row (with the camelCase shape
      // the frontend's Driver type uses). The driver's own vehicle
      // assignment is joined in for the /driver/vehicle page so the
      // page can render the full hero card without a second round
      // trip. We do not require a vehicle to exist — drivers who
      // haven't been assigned a vehicle yet just get the row back
      // with `vehicle: null`.
      const driver = await DriverService.getDriverByUserId(req.user.sub);
      if (!driver) {
        // No profile yet — surface a clean 404 so the page can
        // guide the driver through profile creation.
        throw new NotFoundError('Driver profile not found');
      }
      const vehicle = await knex('vehicles').where({ driver_id: driver.id }).first();
      const user = await knex('users').where({ id: driver.user_id }).first();
      const profileDetails = user?.profile_details
        ? decryptObject(user.profile_details as Record<string, unknown>)
        : {};
      res.json({
        success: true,
        data: {
          ...DriverController['toCamelDriver'](driver),
          isAvailable: driver.availability_status === 'available',
          isOnline: driver.availability_status !== 'offline',
          user: user
            ? {
                id: user.id,
                firstName: String(profileDetails.firstName ?? ''),
                lastName: String(profileDetails.lastName ?? ''),
                email: user.email,
                phone: String(profileDetails.phone ?? ''),
              }
            : undefined,
          vehicle: vehicle ?? null,
        },
        message: 'Driver fetched',
      });
    } catch (error) {
      next(error);
    }
  }

  static async getNearbyDrivers(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user || !['admin', 'seller'].includes(req.user.role)) {
        throw new ForbiddenError('Not authorized');
      }

      const latitude = parseFloat(req.query.latitude as string);
      const longitude = parseFloat(req.query.longitude as string);
      const radius = parseFloat(req.query.radius as string) || 10;
      const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));

      if (isNaN(latitude) || isNaN(longitude)) {
        throw new ValidationError('Valid latitude and longitude required');
      }

      const drivers = await DriverService.findNearbyDrivers(latitude, longitude, radius, limit);
      res.json({ success: true, data: drivers });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /drivers — list all drivers (with their user info). The seller
   * dashboard's "assign driver" dropdown calls this via apiClient.getDrivers.
   * Supports ?isAvailable=true to filter to currently available drivers.
   */
  static async listDrivers(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) throw new ForbiddenError('Authentication required');
      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
      const isAvailable = req.query.isAvailable !== undefined
        ? String(req.query.isAvailable) === 'true'
        : undefined;
      const { drivers, total } = await DriverService.listAll({ page, limit, isAvailable });
      res.json({
        success: true,
        data: drivers,
        meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Convert a snake_case Driver row from the DB into the camelCase shape the
   * frontend's Driver type uses (currentLatitude, availabilityStatus, etc.).
   */
  private static toCamelDriver(row: Record<string, unknown>): Record<string, unknown> {
    return {
      id: row.id,
      userId: row.user_id,
      licenseNumber: row.license_number ?? null,
      licenseExpiry: row.license_expiry ?? null,
      availabilityStatus: row.availability_status,
      currentLatitude: row.current_latitude ?? null,
      currentLongitude: row.current_longitude ?? null,
      currentWorkload: Number(row.current_workload ?? 0),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

export class RouteController {
  static async createRoute(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user || req.user.role !== 'admin') {
        throw new ForbiddenError('Admin access required');
      }

      const route = await RouteService.createRoute(req.body);
      res.status(201).json({ success: true, data: { route }, message: 'Route created' });
    } catch (error) {
      next(error);
    }
  }

  static async optimizeRoute(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user || !['admin', 'seller'].includes(req.user.role)) {
        throw new ForbiddenError('Admin or seller access required');
      }

      const { driverId, orderIds } = req.body;

      const result = await RouteService.optimizeDeliveryRoute(driverId, orderIds, {
        callerRole: req.user.role,
        callerId: req.user.sub,
      });

      res.status(201).json({
        success: true,
        data: {
          sequence: result.sequence,
          legs: result.legs,
          totalDistance: result.totalDistance,
          totalDuration: result.totalDuration,
          encodedPolyline: result.encodedPolyline,
          routeIds: result.routeIds,
          totalStops: result.totalStops,
          pickupSequence: result.pickupSequence,
          orderLegs: result.orderLegs,
        },
        message: 'Route optimized successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  static async getRoute(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const route = await RouteService.getRouteById(req.params.id);
      if (!route) throw new NotFoundError('Route not found');

      if (req.user?.role === 'driver' && route.driver_id !== req.user.sub) {
        throw new ForbiddenError('Not authorized to view this route');
      }

      res.json({ success: true, data: { route } });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/routes/by-order/:orderId
   *
   * Returns the `routes` row attached to a given order, hydrated to
   * the camelCase `CalculatedRoute` shape used by the seller order
   * detail and driver dashboard route cards.
   *
   * Returns `{ data: { route: null } }` with HTTP 200 when no row
   * exists yet (the order was just created and `RouteCalculationService`
   * hasn't run, or the routing provider is down). We deliberately do
   * NOT 404: the absence of a route is a normal pre-assignment state.
   *
   * Authorization:
   *   - admin → any order
   *   - seller → only own orders
   *   - driver → only orders assigned to them (via `drivers.user_id`)
   */
  static async getRouteByOrderId(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new ForbiddenError('Authentication required');
      }
      const { orderId } = req.params;
      if (!orderId) {
        throw new ValidationError('orderId is required');
      }

      // Pull the route row first; if it doesn't exist we return 200/null
      // rather than 404, per the contract above.
      const row = await knex('routes').where({ order_id: orderId }).first();
      if (!row) {
        res.json({ success: true, data: { route: null } });
        return;
      }

      // Authorization: verify the caller has a right to see this route.
      if (req.user.role === 'admin') {
        // full access
      } else if (req.user.role === 'seller') {
        const order = await knex('orders').select('seller_id').where({ id: orderId }).first();
        if (!order || order.seller_id !== req.user.sub) {
          throw new ForbiddenError('Not authorized to view this route');
        }
      } else if (req.user.role === 'driver') {
        // `routes.driver_id` is the driver-record id; resolve to user id
        // for comparison against the JWT subject.
        const driver = await knex('drivers').select('user_id').where({ id: row.driver_id }).first();
        if (!driver || driver.user_id !== req.user.sub) {
          throw new ForbiddenError('Not authorized to view this route');
        }
      } else {
        throw new ForbiddenError('Not authorized to view this route');
      }

      const { RouteCalculationService } = await import('../services/route-calculation.service');
      const route = RouteCalculationService.hydrate(row);
      res.json({ success: true, data: { route } });
    } catch (error) {
      next(error);
    }
  }

  static async listDriverRoutes(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user || req.user.role !== 'driver') {
        throw new ForbiddenError('Driver access required');
      }

      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
      const status = req.query.status as RouteStatus;

      const { routes, total } = await RouteService.listRoutesByDriver(req.user.sub, {
        status,
        page,
        limit,
      });

      res.json({
        success: true,
        data: routes,
        meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
      });
    } catch (error) {
      next(error);
    }
  }
}

/**
 * Analytics Controller
 *
 * Provides dashboard metrics and revenue timeseries. The shape of the
 * responses matches the frontend's `DashboardMetrics` type in
 * routeflow-frontend/src/types/index.ts.
 *
 * These endpoints compute their numbers from the `orders` and
 * `order_status_history` tables at request time. For a production
 * deployment, you'd back this with a materialized view or a dedicated
 * metrics service — but the current scale is small enough that direct
 * aggregation is fine.
 */
export class AnalyticsController {
  /**
   * GET /analytics/dashboard
   *
   * Returns a snapshot of the key numbers for the caller's role:
   *   - Sellers see only their own orders.
   *   - Admins see the whole platform.
   *   - Drivers see their own deliveries.
   */
  static async getDashboardMetrics(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) throw new ForbiddenError('Authentication required');

      const startDate = parseDateParam(req.query.startDate);
      const endDate = endOfDayIfMidnight(parseDateParam(req.query.endDate)) ?? new Date();

      // Build a base query scoped to the caller's role
      const baseQuery = knex('orders');
      if (req.user.role === 'seller') {
        baseQuery.where({ seller_id: req.user.sub });
      } else if (req.user.role === 'driver') {
        // orders.driver_id references drivers.id, not users.id. Resolve
        // the caller's driver record first so the analytics reflect only
        // that driver's deliveries.
        const driverRow = await knex('drivers')
          .where({ user_id: req.user.sub })
          .first();
        if (driverRow) {
          baseQuery.where({ driver_id: driverRow.id });
        } else {
          // No driver profile yet — short-circuit to zero counts.
          baseQuery.whereRaw('1 = 0');
        }
      }
      if (startDate) baseQuery.where('created_at', '>=', startDate);
      if (endDate) baseQuery.where('created_at', '<=', endDate);

      // Total + completed counts
      const totalRow = await baseQuery.clone().count('* as count').first();
      const totalDeliveries = Number(totalRow?.count ?? 0);

      const completedRow = await baseQuery.clone().where('status', 'delivered').count('* as count').first();
      const completedDeliveries = Number(completedRow?.count ?? 0);

      // Total revenue — sum of `total_amount` for delivered orders.
      //
      // We previously used `parcel_details->>'value'` here, but
      // `parcel_details` is encrypted at write (see order.service
      // createOrder), so the jsonb operator was summing ciphertext and
      // always returning 0. `total_amount` is a plain decimal column
      // populated at order create time and is the right source of
      // truth for the per-order revenue figure.
      const revenueRow = await baseQuery
        .clone()
        .where('status', 'delivered')
        .sum<{ revenue: string | number | null }>({ revenue: 'total_amount' })
        .first();
      const totalRevenue = Number(revenueRow?.revenue ?? 0);

      // Active drivers (only meaningful for admin/seller scope)
      let activeDrivers = 0;
      if (req.user.role === 'admin' || req.user.role === 'seller') {
        const driverRow = await knex('drivers')
          .whereIn('availability_status', ['available', 'busy'])
          .count('* as count')
          .first();
        activeDrivers = Number(driverRow?.count ?? 0);
      }

      // Average delivery time (minutes) — only for delivered orders
      // Compute from order_status_history: time between 'picked_up' and
      // 'delivered' entries. The history table's timestamp column is
      // `timestamp`, not `changed_at` (the legacy name).
      const deliveryTimeRow = await knex('order_status_history as h1')
        .join('order_status_history as h2', function () {
          this.on('h1.order_id', 'h2.order_id').andOn(knex.raw('h2.timestamp > h1.timestamp'));
        })
        .where('h1.status', 'picked_up')
        .where('h2.status', 'delivered')
        .avg(knex.raw('EXTRACT(EPOCH FROM (h2.timestamp - h1.timestamp)) / 60.0 as avg_minutes'))
        .first()
        .catch(() => null);
      const avgDeliveryTime =
        deliveryTimeRow && deliveryTimeRow.avg_minutes != null
          ? Math.round(Number(deliveryTimeRow.avg_minutes))
          : 0;

      res.json({
        success: true,
        data: {
          totalDeliveries,
          completedDeliveries,
          activeDrivers,
          totalRevenue,
          avgDeliveryTime,
          onTimeRate: 0, // Out of scope until SLA timestamps are tracked
          customerSatisfaction: 0, // Out of scope until ratings are tracked
          trend: {
            deliveries: 0,
            revenue: 0,
            drivers: 0,
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /analytics/revenue
   *
   * Returns the daily revenue sum for the caller's scope over the
   * requested date range. Each entry is `{ date: 'YYYY-MM-DD', value: <sum> }`,
   * matching what the dashboard's `revenueChart` expects.
   */
  static async getRevenueAnalytics(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) throw new ForbiddenError('Authentication required');

      const startDate =
        parseDateParam(req.query.startDate) ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const endDate = endOfDayIfMidnight(parseDateParam(req.query.endDate)) ?? new Date();

      const baseQuery = knex('orders')
        .where('status', 'delivered')
        .where('created_at', '>=', startDate)
        .where('created_at', '<=', endDate);
      if (req.user.role === 'seller') {
        baseQuery.where({ seller_id: req.user.sub });
      } else if (req.user.role === 'driver') {
        const driverRow = await knex('drivers').where({ user_id: req.user.sub }).first();
        if (driverRow) {
          baseQuery.where({ driver_id: driverRow.id });
        } else {
          baseQuery.whereRaw('1 = 0');
        }
      }

      // Group by date — postgres `date_trunc('day', ...)` gives a timestamp;
      // cast to ::date for the YYYY-MM-DD label the frontend expects.
      //
      // We previously summed `parcel_details->>'value'` here too, which
      // was summing ciphertext (the column is encrypted at write) and
      // producing an all-zeros series. `total_amount` is a plain
      // decimal column and is the right revenue source.
      const rows = (await baseQuery
        .select(knex.raw("to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS date"))
        .sum<{ value: string | number | null }>({ value: 'total_amount' })
        .groupByRaw("date_trunc('day', created_at)")
        .orderByRaw("date_trunc('day', created_at) ASC")) as Array<{ date: string; value: string | number | null }>;

      res.json({
        success: true,
        data: rows.map((r) => ({
          date: r.date,
          value: Number(r.value ?? 0),
        })),
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /analytics/driver-earnings
   *
   * Returns the caller's driver earnings for the requested date
   * range. Distinct from `/analytics/dashboard` and
   * `/analytics/revenue`, which both return *seller* revenue
   * (`sum(orders.total_amount)`). The driver's payout is
   * computed from a configurable rate model — see
   * `DriverEarningsService` — and is *not* a slice of the
   * seller's sale.
   *
   * Drivers only. Admin and seller roles get a 403.
   */
  static async getDriverEarnings(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) throw new ForbiddenError('Authentication required');
      if (req.user.role !== 'driver') {
        throw new ForbiddenError('Driver earnings are only available to drivers');
      }
      const startDate =
        parseDateParam(req.query.startDate) ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const endDate = endOfDayIfMidnight(parseDateParam(req.query.endDate)) ?? new Date();

      const driverRow = await knex('drivers').where({ user_id: req.user.sub }).first();
      if (!driverRow) {
        // No driver profile yet — return zeroed payload, don't 404.
        res.json({
          success: true,
          data: {
            breakdown: {
              baseRate: 0,
              perKmRate: 0,
              totalDistanceKm: 0,
              orderCount: 0,
              totalEarnings: 0,
            },
            daily: [],
          },
        });
        return;
      }
      // Dynamic import: keeps the cold-start payload small for the
      // seller/admin paths that never touch this endpoint, and
      // avoids a static cycle through env → service → controller.
      const { DriverEarningsService } = await import('../services/driver-earnings.service');
      const result = await DriverEarningsService.computeForDriver(String(driverRow.id), startDate, endDate);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /analytics/deliveries
   *
   * Daily count of orders that reached DELIVERED status over the date
   * range. Each row is `{ date: 'YYYY-MM-DD', value: <count> }` — same
   * shape as the revenue series so the admin dashboard can render both
   * on the same chart axis.
   */
  static async getDeliveryAnalytics(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) throw new ForbiddenError('Authentication required');

      const startDate =
        parseDateParam(req.query.startDate) ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const endDate = endOfDayIfMidnight(parseDateParam(req.query.endDate)) ?? new Date();

      const baseQuery = knex('orders')
        .where('status', 'delivered')
        .where('created_at', '>=', startDate)
        .where('created_at', '<=', endDate);
      if (req.user.role === 'seller') {
        baseQuery.where({ seller_id: req.user.sub });
      } else if (req.user.role === 'driver') {
        const driverRow = await knex('drivers').where({ user_id: req.user.sub }).first();
        if (driverRow) {
          baseQuery.where({ driver_id: driverRow.id });
        } else {
          baseQuery.whereRaw('1 = 0');
        }
      }

      const rows = await baseQuery
        .select(knex.raw("to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS date"))
        .count('* as value')
        .groupByRaw("date_trunc('day', created_at)")
        .orderByRaw("date_trunc('day', created_at) ASC");

      res.json({
        success: true,
        data: rows.map((r: { date: string; value: unknown }) => ({
          date: r.date,
          value: Number(r.value ?? 0),
        })),
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /analytics/drivers
   *
   * Per-driver performance leaderboard. Returns one row per driver that
   * had at least one order in the date range, sorted by completed
   * deliveries descending. Sellers and admins get the same shape; the
   * admin analytics page renders this as a table.
   *
   * Columns:
   *   - id            driver user id (used as React key)
   *   - name          "First Last" or email fallback
   *   - deliveries    total orders assigned in the window
   *   - completed     orders that reached DELIVERED
   *   - completionRate completed / deliveries (0..1)
   *   - avgMinutes    average minutes between PICKED_UP and DELIVERED
   */
  static async getDriverPerformance(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) throw new ForbiddenError('Authentication required');

      const startDate =
        parseDateParam(req.query.startDate) ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const endDate = parseDateParam(req.query.endDate) ?? new Date();

      // Pull per-driver aggregates in a single query. Using the orders table
      // as the source so the window is consistent with the other analytics.
      const rows = await knex('orders as o')
        .leftJoin('drivers as d', 'd.id', 'o.driver_id')
        .leftJoin('users as u', 'u.id', 'd.user_id')
        .whereNotNull('o.driver_id')
        .where('o.created_at', '>=', startDate)
        .where('o.created_at', '<=', endDate)
        .select('d.user_id as driverUserId')
        .select(knex.raw("COUNT(o.id) AS deliveries"))
        .select(
          knex.raw(
            "COUNT(*) FILTER (WHERE o.status = 'delivered') AS completed"
          )
        )
        .groupBy('d.user_id')
        .orderBy('completed', 'desc')
        .limit(50);

      // Pull avg delivery time per driver in a second query. Using a
      // subquery (with knex.raw and an explicit AS outside the
      // parentheses) so knex doesn't rewrite the alias inside the
      // aggregate — that produces "sum(... as x)" which Postgres
      // rejects. The same gotcha applies to the dashboard revenue query.
      const avgTimeRows = await knex('orders as o')
        .leftJoin('drivers as d', 'd.id', 'o.driver_id')
        .leftJoin('order_status_history as h1', function () {
          this.on('h1.order_id', 'o.id').andOn(knex.raw("h1.status = 'picked_up'"));
        })
        .leftJoin('order_status_history as h2', function () {
          this.on('h2.order_id', 'o.id').andOn(knex.raw("h2.status = 'delivered'"));
        })
        .whereNotNull('o.driver_id')
        .where('o.created_at', '>=', startDate)
        .where('o.created_at', '<=', endDate)
        .select('d.user_id as driverUserId')
        .select(
          knex.raw(
            "AVG(EXTRACT(EPOCH FROM (h2.timestamp - h1.timestamp)) / 60.0) AS avg_minutes"
          )
        )
        .groupBy('d.user_id');
      const avgTimeByUser = new Map<string, number>();
      for (const r of avgTimeRows) {
        if (r.driverUserId && r.avg_minutes != null) {
          avgTimeByUser.set(String(r.driverUserId), Math.round(Number(r.avg_minutes)));
        }
      }

      // Resolve display names for each driver. We do one query per driver
      // because the user table is small; for >100 drivers swap this for
      // a single WHERE IN lookup.
      const results = await Promise.all(
        rows.map(async (r) => {
          const userId = r.driverUserId as string | null;
          if (!userId) return null;
          const user = await knex('users').where({ id: userId }).first();
          // users.profile_details is encrypted at write time; decrypt
          // before reading firstName/lastName or the analytics
          // response will surface the base64 ciphertext to the UI.
          const profile = user?.profile_details
            ? decryptObject(user.profile_details as Record<string, unknown>)
            : {};
          const first = String(profile.firstName ?? '');
          const last = String(profile.lastName ?? '');
          const name = [first, last].filter(Boolean).join(' ') || user?.email || 'Driver';
          const deliveries = Number(r.deliveries ?? 0);
          const completed = Number(r.completed ?? 0);
          return {
            id: userId,
            name,
            deliveries,
            completed,
            completionRate: deliveries > 0 ? Number((completed / deliveries).toFixed(2)) : 0,
            avgMinutes: avgTimeByUser.get(userId) ?? 0,
          };
        })
      );

      res.json({
        success: true,
        data: results.filter((r) => r !== null),
      });
    } catch (error) {
      next(error);
    }
  }
}

/**
 * Seller Controller
 *
 * Endpoints under /sellers. The frontend's `apiClient.getMySeller()` calls
 * GET /sellers/me, which auto-creates a seller profile on first use so
 * downstream flows (create order, add vehicle, etc.) always have a seller id.
 */
export class SellerController {
  static async getMySeller(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) throw new ForbiddenError('Authentication required');
      const seller = await SellerService.getOrCreateForUser(req.user.sub);
      res.json({ success: true, data: SellerService.toCamel(seller) });
    } catch (error) {
      next(error);
    }
  }

  static async getSellerById(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const seller = await SellerService.findById(req.params.id);
      if (!seller) throw new NotFoundError('Seller not found');
      res.json({ success: true, data: SellerService.toCamel(seller) });
    } catch (error) {
      next(error);
    }
  }

  static async createSeller(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) throw new ForbiddenError('Authentication required');
      const seller = await SellerService.create({ ...req.body, userId: req.user.sub });
      res.status(201).json({ success: true, data: SellerService.toCamel(seller), message: 'Seller profile created' });
    } catch (error) {
      next(error);
    }
  }

  static async updateSeller(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) throw new ForbiddenError('Authentication required');
      const seller = await SellerService.getOrCreateForUser(req.user.sub);
      // Accept both camelCase (frontend) and snake_case (DB legacy) keys.
      const b = req.body ?? {};
      const updates = {
        businessName: b.businessName ?? b.business_name,
        businessType: b.businessType ?? b.business_type,
        businessEmail: b.businessEmail ?? b.business_email,
        businessPhone: b.businessPhone ?? b.business_phone,
        businessAddress: b.businessAddress ?? b.business_address,
        taxId: b.taxId ?? b.tax_id,
        licenseNumber: b.licenseNumber ?? b.license_number,
      };
      const updated = await SellerService.update(seller.id, updates);
      res.json({ success: true, data: SellerService.toCamel(updated), message: 'Seller updated' });
    } catch (error) {
      next(error);
    }
  }

  static async listSellers(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
      const status = req.query.status as string | undefined;
      const { sellers, total } = await SellerService.listAll({ page, limit, status });
      res.json({
        success: true,
        data: sellers.map((s) => SellerService.toCamel(s)),
        meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
      });
    } catch (error) {
      next(error);
    }
  }
}

/**
 * Typed Order Controller — accepts/returns the frontend's typed Order shape.
 * Coexists with the legacy /orders endpoints so the existing admin/driver
 * flows keep working.
 */
export class OrderTypedController {
  static async createTypedOrder(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user || req.user.role !== 'seller') {
        throw new ForbiddenError('Only sellers can create orders');
      }
      // Override sellerId with the authenticated user — never trust the body
      const input: CreateOrderTypedInput = { ...req.body, sellerId: req.user.sub };
      const order = await OrderService.createTyped(input);
      res.status(201).json({ success: true, data: order, message: 'Order created' });
    } catch (error) {
      next(error);
    }
  }

  static async getTypedOrder(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const order = await OrderService.getOrderTypedById(req.params.id);
      if (!order) throw new NotFoundError('Order not found');
      if (req.user?.role === 'seller' && order.sellerId !== req.user.sub) {
        throw new ForbiddenError('Not authorized to view this order');
      }
      // Drivers and admins get the seller's contact info attached so
      // the driver dashboard's "Contact Seller" card has something to
      // render. The owning seller already has this via /sellers/me.
      if (req.user?.role === 'driver' || req.user?.role === 'admin') {
        const sellerContact = await OrderService.getSellerContactForOrder(order.id);
        if (sellerContact) {
          order.seller = sellerContact;
        }
      }
      // Attach the order's tasks (PICKUP + DELIVERY) so the order
      // detail page can show per-stop progress without a second
      // round trip. Drivers, admins, and the owning seller all get
      // them.
      const tasks = await TaskService.listForOrder(order.id);
      res.json({ success: true, data: { ...order, tasks } });
    } catch (error) {
      next(error);
    }
  }

  static async listMyOrders(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) throw new ForbiddenError('Authentication required');
      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

      // ---------------------------------------------------------------
      // ROLE-BASED SCOPE
      // - Sellers see only their own orders (existing behavior).
      // - Admins see ALL orders in the system.
      //
      // Previously this handler filtered by seller_id unconditionally,
      // which made /orders return zero rows for admins. The fix lives
      // here, in buildOrderListQuery, so the seller-scope is a single
      // conditional rather than a separate code path.
      // ---------------------------------------------------------------
      const role: 'admin' | 'seller' = req.user.role === 'admin' ? 'admin' : 'seller';
      const sellerId = role === 'seller' ? req.user.sub : undefined;

      const filters: OrderListFilters = {
        status: req.query.status ? String(req.query.status).toLowerCase() : undefined,
        search: req.query.search ? String(req.query.search) : undefined,
        driverId: req.query.driverId ? String(req.query.driverId) : undefined,
        vehicleType: req.query.vehicleType ? String(req.query.vehicleType) : undefined,
        startDate: req.query.startDate ? String(req.query.startDate) : undefined,
        endDate: req.query.endDate ? String(req.query.endDate) : undefined,
      };

      const { dataQuery, countQuery } = buildOrderListQuery(sellerId, filters);

      const totalRow = await countQuery.count<{ count: string }>('orders.id as count').first();
      const total = Number(totalRow?.count ?? 0);
      const rows = await dataQuery
        .clone()
        .orderBy('orders.created_at', 'desc')
        .limit(limit)
        .offset((page - 1) * limit);
      const orders = await Promise.all(rows.map((r) => OrderService.toTyped(r)));

      res.json({
        success: true,
        data: orders,
        meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
      });
    } catch (error) {
      next(error);
    }
  }

  static async updateOrderStatus(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { status, notes, cancellationReason, failedReason } = req.body as {
        status: OrderStatusTyped;
        notes?: string;
        cancellationReason?: string;
        failedReason?: string;
      };
      if (!status) throw new ValidationError('status is required');
      const order = await OrderService.updateOrderStatusTyped(req.params.id, status, { notes, cancellationReason, failedReason });
      res.json({ success: true, data: order, message: 'Order status updated' });
    } catch (error) {
      next(error);
    }
  }

  static async assignOrder(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { driverId, routeId } = req.body as { driverId: string; routeId?: string };
      if (!driverId) throw new ValidationError('driverId is required');
      const order = await OrderService.assignDriver(req.params.id, driverId, routeId);
      res.json({ success: true, data: order, message: 'Driver assigned' });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /orders/:id/cancel
   *
   * Dedicated cancel endpoint that captures the reason and frees the
   * assigned driver (if any). Sellers can cancel their own orders;
   * admins can cancel any order. Drivers cannot cancel — they can only
   * mark PICKED_UP / DELIVERED / FAILED via the status endpoint.
   *
   * Status guard: orders in DELIVERED status cannot be cancelled.
   */
  static async cancelOrder(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) throw new ForbiddenError('Authentication required');
      if (req.user.role !== 'seller' && req.user.role !== 'admin') {
        throw new ForbiddenError('Only sellers or admins can cancel orders');
      }
      const { reason } = req.body as { reason?: string };
      const order = await OrderService.cancelOrderTyped(req.params.id, req.user.sub, req.user.role, reason);
      res.json({ success: true, data: order, message: 'Order cancelled' });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /orders/:id/decline
   *
   * Driver-only counterpart to cancelOrder. Lets a driver reject an
   * assignment so the order returns to PENDING in the seller's pool
   * and the driver is freed (status flips back to 'available',
   * workload decremented). Distinct from cancel: we keep the order
   * alive in PENDING state so the seller can re-assign it (or it
   * can be auto-assigned to a different driver) rather than
   * marking it CANCELLED.
   */
  static async declineOrder(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) throw new ForbiddenError('Authentication required');
      if (req.user.role !== 'driver') {
        throw new ForbiddenError('Only drivers can decline an order');
      }
      const order = await OrderService.declineOrderByDriver(req.params.id, req.user.sub);
      res.json({ success: true, data: order, message: 'Order declined' });
    } catch (error) {
      next(error);
    }
  }
}

/**
 * Vehicle Controller — CRUD for seller's fleet.
 */
export class VehicleController {
  static async create(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user || req.user.role !== 'seller') {
        throw new ForbiddenError('Only sellers can create vehicles');
      }
      const seller = await SellerService.getOrCreateForUser(req.user.sub);
      // Normalize the vehicle type to the DB enum (lowercase) since the
      // frontend sends UPPERCASE (e.g. CAR) but the column enum is lowercase.
      const normalizedType = String(req.body.type).toLowerCase();
      const input: CreateVehicleInput = { ...req.body, type: normalizedType as CreateVehicleInput['type'], sellerId: seller.id };
      const vehicle = await VehicleService.create(input);
      res.status(201).json({ success: true, data: VehicleController.toCamel(vehicle), message: 'Vehicle created' });
    } catch (error) {
      next(error);
    }
  }

  static async getById(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const v = await VehicleService.findById(req.params.id);
      if (!v) throw new NotFoundError('Vehicle not found');
      res.json({ success: true, data: VehicleController.toCamel(v) });
    } catch (error) {
      next(error);
    }
  }

  static async list(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
      const { vehicles, total } = await VehicleService.listAll({
        page,
        limit,
        sellerId: req.query.sellerId as string,
        type: req.query.type as string,
        status: req.query.status as string,
      });
      res.json({
        success: true,
        data: vehicles.map((v) => VehicleController.toCamel(v)),
        meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
      });
    } catch (error) {
      next(error);
    }
  }

  static async myVehicles(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) throw new ForbiddenError('Authentication required');
      const seller = await SellerService.getOrCreateForUser(req.user.sub);
      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
      const { vehicles, total } = await VehicleService.listBySeller(seller.id, { page, limit });
      res.json({
        success: true,
        data: vehicles.map((v) => VehicleController.toCamel(v)),
        meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
      });
    } catch (error) {
      next(error);
    }
  }

  static async update(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const v = await VehicleService.update(req.params.id, req.body);
      res.json({ success: true, data: VehicleController.toCamel(v), message: 'Vehicle updated' });
    } catch (error) {
      next(error);
    }
  }

  // Convert a snake_case Vehicle row to the camelCase shape the frontend expects.
  private static toCamel(v: Record<string, unknown>): Record<string, unknown> {
    return {
      id: v.id,
      sellerId: v.seller_id,
      plateNumber: v.plate_number,
      type: String(v.type).toUpperCase(),
      brand: v.brand,
      model: v.model,
      year: Number(v.year),
      color: v.color ?? null,
      capacityWeight: Number(v.capacity_weight),
      capacityVolume: Number(v.capacity_volume),
      fuelType: v.fuel_type ?? null,
      insuranceExpiry: v.insurance_expiry ?? null,
      registrationExpiry: v.registration_expiry ?? null,
      gpsDeviceId: v.gps_device_id ?? null,
      driverId: v.driver_id ?? null,
      status: String(v.status).toUpperCase(),
      createdAt: v.created_at,
      updatedAt: v.updated_at,
    };
  }

  static async delete(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      await VehicleService.delete(req.params.id);
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  }
}

/**
 * Typed Route Controller — multi-waypoint seller-driven routes.
 */
export class RouteTypedController {
  static async create(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) throw new ForbiddenError('Authentication required');
      const seller = await SellerService.getOrCreateForUser(req.user.sub);
      const input: CreateRouteTypedInput = { ...req.body, sellerId: seller.id };
      const route = await RouteTypedService.create(input);
      res.status(201).json({ success: true, data: route, message: 'Route created' });
    } catch (error) {
      next(error);
    }
  }

  static async getById(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const r = await RouteTypedService.findById(req.params.id);
      if (!r) throw new NotFoundError('Route not found');
      res.json({ success: true, data: r });
    } catch (error) {
      next(error);
    }
  }

  static async list(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
      const status = req.query.status as string | undefined;
      const where: Record<string, unknown> = {};
      if (req.query.sellerId) where.seller_id = req.query.sellerId;
      if (status) where.status = status;

      const totalRow = await knex('routes_typed').where(where).count('* as count').first();
      const total = Number(totalRow?.count ?? 0);
      const rows = await knex('routes_typed').where(where).orderBy('created_at', 'desc').limit(limit).offset((page - 1) * limit);
      const routes = rows.map((r) => RouteTypedService['normalize'](r));

      res.json({
        success: true,
        data: routes,
        meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
      });
    } catch (error) {
      next(error);
    }
  }

  static async myRoutes(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) throw new ForbiddenError('Authentication required');
      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
      const status = req.query.status as string | undefined;
      const options = { page, limit, status };

      // Drivers see routes they're assigned to (driver_id matches their profile id);
      // sellers (and admins) see routes they own. The branch is needed because the
      // driver dashboard derives its orders from this endpoint.
      if (req.user.role === 'driver') {
        const driver = await DriverService.getDriverByUserId(req.user.sub);
        if (!driver) throw new NotFoundError('Driver profile not found');
        const { routes, total } = await RouteTypedService.listByDriver(driver.id, options);
        return void res.json({
          success: true,
          data: routes,
          meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
        });
      }

      const seller = await SellerService.getOrCreateForUser(req.user.sub);
      const { routes, total } = await RouteTypedService.listBySeller(seller.id, options);
      res.json({
        success: true,
        data: routes,
        meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
      });
    } catch (error) {
      next(error);
    }
  }

  static async update(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = req.body as { status?: 'PLANNED' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED' };
      if (body.status) {
        const r = await RouteTypedService.updateStatus(req.params.id, body.status);
        return void res.json({ success: true, data: r, message: 'Route updated' });
      }
      // Generic update — the service handles driver-attach side effects
      // (generating PICKUP + DELIVERY tasks for the new driver's route).
      const r = await RouteTypedService.update(req.params.id, body as Record<string, unknown>);
      res.json({ success: true, data: r });
    } catch (error) {
      next(error);
    }
  }

  static async delete(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      await RouteTypedService.delete(req.params.id);
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  }
}

/** Parse a YYYY-MM-DD or ISO timestamp query param. Returns undefined on bad input. */
function parseDateParam(input: unknown): Date | undefined {
  if (typeof input !== 'string' || !input) return undefined;
  const d = new Date(input);
  return isNaN(d.getTime()) ? undefined : d;
}

/**
 * Normalise a date so a `YYYY-MM-DD` value is treated as the *end* of
 * that day, not midnight. The analytics endpoints receive dates
 * straight from a date picker (no time component), and the
 * `<= endDate` filter would otherwise drop every order created after
 * 00:00 UTC on the chosen end day. We detect "this looks like a
 * midnight Date" and roll it forward to 23:59:59.999 of the same
 * day. Mid-day values (e.g. `new Date()` from a default) pass through
 * unchanged.
 */
function endOfDayIfMidnight(d: Date | undefined): Date | undefined {
  if (!d) return d;
  if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0) {
    const eod = new Date(d);
    eod.setUTCHours(23, 59, 59, 999);
    return eod;
  }
  return d;
}

// ============================================================
// Order list filter helper
// ============================================================

/**
 * Filter shape consumed by `buildOrderListQuery`. All fields are
 * optional; missing fields mean "no filter on that dimension".
 *
 * Mirrors the query params on `GET /orders` and `GET /orders/my`:
 *   - status: order lifecycle status (lowercase enum).
 *   - search: case-insensitive substring against customer_name, id,
 *     and customer_phone.
 *   - driverId: orders assigned to this driver.
 *   - vehicleType: orders whose `route_id` resolves to a route using
 *     a vehicle of the given type. Orders with no route are excluded.
 *   - startDate / endDate: inclusive bounds on `orders.created_at`.
 */
export interface OrderListFilters {
  status?: string;
  search?: string;
  driverId?: string;
  vehicleType?: string;
  startDate?: string;
  endDate?: string;
}

/**
 * Build the Knex query for `GET /orders` and `GET /orders/my`.
 *
 * Returns a fresh `dataQuery` and `countQuery` (siblings; share the
 * same WHERE clauses but no ORDER BY / LIMIT on the count side, so
 * Postgres doesn't choke on a grouped count). Both queries are
 * clones — callers can mutate one without affecting the other.
 *
 * `sellerId` is the seller scope; pass `undefined` for admins (who
 * see all orders). When `sellerId` is undefined the seller filter is
 * skipped entirely.
 *
 * Exported so `test/order-filtering.test.ts` can assert the SQL
 * directly without spinning up Express.
 */
export function buildOrderListQuery(
  sellerId: string | undefined,
  filters: OrderListFilters
): {
  dataQuery: Knex.QueryBuilder;
  countQuery: Knex.QueryBuilder;
} {
  // Start with a fresh query. We always go through `orders` as the
  // primary table so count/rows agree on the same row set.
  const base = () => knex('orders');

  const dataQuery = base();
  const countQuery = base();

  if (sellerId) {
    dataQuery.where({ 'orders.seller_id': sellerId });
    countQuery.where({ 'orders.seller_id': sellerId });
  }

  if (filters.status) {
    dataQuery.where({ 'orders.status': filters.status });
    countQuery.where({ 'orders.status': filters.status });
  }

  if (filters.driverId) {
    dataQuery.where({ 'orders.driver_id': filters.driverId });
    countQuery.where({ 'orders.driver_id': filters.driverId });
  }

  if (filters.startDate || filters.endDate) {
    const start = parseDateParam(filters.startDate);
    const end = parseDateParam(filters.endDate);
    if (start || end) {
      // Build a [start, end] tuple — Knex whereBetween accepts either
      // a Date or undefined, but undefined on either side is
      // an open bound, so we use a manual where() when one side
      // is missing rather than passing undefined into whereBetween
      // (which Postgres rejects).
      if (start && end) {
        dataQuery.whereBetween('orders.created_at', [start, end]);
        countQuery.whereBetween('orders.created_at', [start, end]);
      } else if (start) {
        dataQuery.where('orders.created_at', '>=', start);
        countQuery.where('orders.created_at', '>=', start);
      } else if (end) {
        dataQuery.where('orders.created_at', '<=', end);
        countQuery.where('orders.created_at', '<=', end);
      }
    }
  }

  if (filters.search) {
    // Wrap the OR group in a function so the `OR`s don't leak into
    // the surrounding AND'd filters (Knex binds ORs across the
    // whole chain otherwise).
    //
    // `orders.id` is a UUID, and Postgres' `~~*` (ILIKE) operator
    // doesn't have a uuid overload — we cast to text so the
    // substring match works. The cast is cheap (UUIDs are short);
    // the cost is negligible compared to the index scan the rest
    // of the query does.
    const q = `%${filters.search}%`;
    const searchClause = (qb: Knex.QueryBuilder) => {
      qb.whereILike('orders.customer_name', q)
        .orWhereILike(knex.raw('orders.id::text'), q)
        .orWhereILike('orders.customer_phone', q);
    };
    dataQuery.where(searchClause);
    countQuery.where(searchClause);
  }

  if (filters.vehicleType) {
    // `orders` doesn't carry vehicle info — `vehicle_id` lives on
    // `routes_typed`, and `orders.route_id` references it. Filter
    // orders whose route is using a vehicle of the given type.
    // Un-routed orders (route_id IS NULL) are excluded by the IN.
    const vehicleTypeSubquery = knex('routes_typed')
      .join('vehicles', 'vehicles.id', 'routes_typed.vehicle_id')
      .where('vehicles.type', filters.vehicleType)
      .select('routes_typed.id');
    dataQuery.whereIn('orders.route_id', vehicleTypeSubquery);
    countQuery.whereIn('orders.route_id', vehicleTypeSubquery);
  }

  return { dataQuery, countQuery };
}

/**
 * Task Controller
 *
 * The tasks table is the per-stop source of truth for what a driver
 * is working on. Each route's orders have a PICKUP task and a
 * DELIVERY task; the driver dashboard's `/tasks/my` page calls
 * `listMyTasks`, and the order detail page calls `listForOrder`
 * (already invoked inside `getTypedOrder` above).
 *
 * Drivers can advance their own tasks through the workflow. Sellers
 * cannot advance tasks (the driver owns the workflow). Admins can
 * advance anything for operational override.
 */
export class TaskController {
  /**
   * GET /tasks — admin/seller list view. Supports filters by
   * driverId, routeId, orderId, status. Pagination follows the same
   * shape as the rest of the API.
   */
  static async listTasks(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) throw new ForbiddenError('Authentication required');
      if (!['admin', 'seller'].includes(req.user.role)) {
        throw new ForbiddenError('Only admins or sellers can list all tasks');
      }
      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

      const options: Parameters<typeof TaskService.listAll>[0] = {
        page,
        limit,
      };
      if (req.query.driverId) options.driverId = String(req.query.driverId);
      if (req.query.routeId) options.routeId = String(req.query.routeId);
      if (req.query.orderId) options.orderId = String(req.query.orderId);
      if (req.query.status) options.status = String(req.query.status) as TaskStatus;

      // Sellers are scoped to their own orders. We pull the seller
      // profile id once, then add an `orderId IN (...)` filter to
      // listAll via the `orderId` filter, but `orderId` is a single
      // value. Instead, the cleanest approach is to list tasks for
      // each of the seller's orders. We do that with a subquery to
      // avoid the N+1 cost of the listAll helper.
      if (req.user.role === 'seller') {
        const seller = await SellerService.getOrCreateForUser(req.user.sub);
        const sellerOrderIds = await knex('orders')
          .where({ seller_id: req.user.sub })
          .select('id');
        const allowedIds = sellerOrderIds.map((r) => String(r.id));
        if (allowedIds.length === 0) {
          return void res.json({
            success: true,
            data: [],
            meta: { page, limit, total: 0, totalPages: 0 },
          });
        }
        // When a seller filters to a specific order, validate the
        // order belongs to them.
        if (options.orderId && !allowedIds.includes(options.orderId)) {
          return void res.json({
            success: true,
            data: [],
            meta: { page, limit, total: 0, totalPages: 0 },
          });
        }
        // Otherwise override the filter to scope by their orders.
        options.orderId = allowedIds.length === 1 ? allowedIds[0] : undefined;
        // When the seller has many orders, listAll only supports a
        // single orderId filter — fall back to a manual paginated
        // query to keep the seller scope.
        if (allowedIds.length > 1) {
          let baseQuery = knex('tasks').whereIn('order_id', allowedIds);
          if (options.driverId) baseQuery = baseQuery.andWhere({ driver_id: options.driverId });
          if (options.routeId) baseQuery = baseQuery.andWhere({ route_id: options.routeId });
          if (options.status) baseQuery = baseQuery.andWhere({ status: options.status });
          const totalRow = await baseQuery.clone().count('* as count').first();
          const total = Number(totalRow?.count ?? 0);
          const rows = await baseQuery
            .orderBy('created_at', 'desc')
            .limit(limit)
            .offset((page - 1) * limit);
          return void res.json({
            success: true,
            data: rows.map((r) => TaskService.toCamel(r)),
            meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
          });
        }
      }

      const { tasks, total } = await TaskService.listAll(options);
      res.json({
        success: true,
        data: tasks,
        meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /tasks/my — the driver's own task list. Joins through
   * drivers.user_id to scope by the calling driver.
   */
  static async listMyTasks(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) throw new ForbiddenError('Authentication required');
      if (req.user.role !== 'driver') {
        throw new ForbiddenError('Only drivers can call /tasks/my');
      }
      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
      const status = req.query.status ? (String(req.query.status) as TaskStatus) : undefined;

      const { tasks, total } = await TaskService.listForDriver(req.user.sub, { page, limit, status });
      res.json({
        success: true,
        data: tasks,
        meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /tasks/:id — fetch a single task. Authorization: drivers
   * can only read their own; sellers/admins can read any.
   */
  static async getTask(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) throw new ForbiddenError('Authentication required');
      const task = await TaskService.getById(req.params.id);
      if (!task) throw new NotFoundError('Task not found');

      if (req.user.role === 'driver') {
        const driver = await DriverService.getDriverById(task.driverId);
        if (!driver || driver.user_id !== req.user.sub) {
          throw new ForbiddenError('Not authorized to view this task');
        }
      } else if (req.user.role === 'seller') {
        const order = await knex('orders').where({ id: task.orderId }).first();
        if (!order || order.seller_id !== req.user.sub) {
          throw new ForbiddenError('Not authorized to view this task');
        }
      }
      res.json({ success: true, data: task });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /tasks/:id/status — advance a task through the workflow.
   * Drivers can advance their own; admins can advance any; sellers
   * cannot (the driver owns the workflow).
   */
  static async updateTaskStatus(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) throw new ForbiddenError('Authentication required');
      const { status, notes } = req.body as { status: TaskStatus; notes?: string };
      if (!status) throw new ValidationError('status is required');
      const role = req.user.role as 'driver' | 'admin' | 'seller';
      const task = await TaskService.advanceStatus(req.params.id, req.user.sub, role, status, notes);
      res.json({ success: true, data: task, message: 'Task status updated' });
    } catch (error) {
      next(error);
    }
  }
}

// =====================================================================
// Notifications
// =====================================================================
//
// The in-app notification inbox is written by NotificationService.notifyInApp
// from every order-status event. The frontend bell polls
// `GET /notifications` on mount and re-renders on the
// `notification:new` socket event.
//
// DB column ↔ API field mapping:
//   - `body`        → `message`   (frontend's `Notification` type uses `message`)
//   - `read_at`     → `isRead: boolean` + `readAt: Date | null`
//   - `created_at`  → `createdAt`
//
// `Notification` in the DB has no `channel`, `priority`, `expiresAt`,
// `sentAt`, `failedAt`, or `failureReason` columns, so the controller
// synthesizes sensible defaults for those (IN_APP / 0 / null) so the
// frontend's `Notification` type is satisfied without forcing the
// caller to handle `undefined`.
export class NotificationsController {
  /**
   * GET /notifications
   *
   * Returns the caller's most recent in-app notifications, newest first.
   * `limit` defaults to 20 (matches the bell's hydrate) and is capped
   * at 100 so a single call can't pull the whole table.
   */
  static async listNotifications(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) throw new ForbiddenError('Authentication required');
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
      const rows = await notificationService.listForUser(req.user.sub, limit);
      res.json({
        success: true,
        data: rows.map(NotificationsController.toApi),
        meta: { count: rows.length, limit },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /notifications/:id/read
   *
   * Mark a single notification as read for the caller. Returns the
   * updated row in API shape. The frontend's optimistic update means
   * the response body isn't strictly required, but echoing it makes
   * debugging easier.
   */
  static async markRead(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) throw new ForbiddenError('Authentication required');
      const updated = await notificationService.markRead(req.user.sub, req.params.id);
      if (!updated) {
        throw new NotFoundError('Notification not found');
      }
      const [row] = await knex('notifications').where({ id: req.params.id, user_id: req.user.sub });
      res.json({ success: true, data: NotificationsController.toApi(row) });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /notifications/read-all
   *
   * Mark every unread notification for the caller as read. Idempotent.
   */
  static async markAllRead(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) throw new ForbiddenError('Authentication required');
      const updated = await notificationService.markAllRead(req.user.sub);
      res.json({ success: true, data: { updated } });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Map a raw `notifications` row to the API shape the frontend
   * expects. Centralised so the three endpoints above stay in sync
   * with the shape used by the `notification:new` socket event
   * (after the socket payload is run through the store's
   * `fromSocketEvent` normaliser).
   */
  private static toApi(row: Record<string, unknown>): Record<string, unknown> {
    return {
      id: row.id,
      userId: row.user_id,
      type: row.type,
      // DB column is `body`; the frontend's `Notification` type uses
      // `message`. Don't rename one without the other.
      title: row.title,
      message: row.body,
      data: row.data ?? {},
      isRead: row.read_at != null,
      readAt: row.read_at ?? null,
      sentAt: null,
      failedAt: null,
      failureReason: null,
      priority: 0,
      expiresAt: null,
      channel: 'IN_APP',
      createdAt: row.created_at,
    };
  }
}