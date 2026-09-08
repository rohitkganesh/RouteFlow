import { Router } from 'express';
import { body, param, query } from 'express-validator';
import {
  UserController,
  OrderController,
  DriverController,
  RouteController,
  AnalyticsController,
  SellerController,
  OrderTypedController,
  VehicleController,
  RouteTypedController,
  TaskController,
  NotificationsController,
} from '../controllers/api.controller';
import { PublicController } from '../controllers/public.controller';
import { authenticate, authorize } from '../middlewares/auth.middleware';
import { validate } from '../middlewares/validate.middleware';
import { publicRateLimit } from '../middlewares/public-auth.middleware';

const router = Router();

// Public routes (no authentication required)
const publicRouter = Router();
publicRouter.use(publicRateLimit); // Apply rate limiting to all public routes

publicRouter.get(
  '/track/:id',
  [param('id').isUUID().withMessage('Valid order ID required')],
  validate,
  PublicController.trackOrder
);

publicRouter.get(
  '/track/:id/history',
  [param('id').isUUID().withMessage('Valid order ID required')],
  validate,
  PublicController.getOrderTrackingHistory
);

// Mount public routes under /public
router.use('/public', publicRouter);

// User routes
router.get('/users/me', authenticate, UserController.getProfile);
router.patch(
  '/users/me',
  authenticate,
  [body('profileDetails').optional().isObject()],
  validate,
  UserController.updateProfile
);
router.get(
  '/users',
  authenticate,
  authorize('admin'),
  [
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('role').optional().isIn(['admin', 'seller', 'driver']),
  ],
  validate,
  UserController.listUsers
);

// Order routes
//
// We accept the typed payload (matching the frontend's CreateOrderRequest):
//   { customerName, customerPhone, customerEmail?, pickupAddress,
//     deliveryAddress, pickupLat/Lng, deliveryLat/Lng, items[],
//     totalWeight/Volume/Value, paymentMethod, instructions? }
//
// Legacy fields (latitude, longitude, parcelDetails) are no longer required —
// the typed controller derives them from the typed shape.
router.post(
  '/orders',
  authenticate,
  authorize('seller'),
  [
    body('customerName').isString().trim().notEmpty().withMessage('Customer name required'),
    body('customerPhone').isString().trim().notEmpty().withMessage('Customer phone required'),
    body('pickupAddress').isObject().withMessage('pickupAddress object required'),
    body('deliveryAddress').isObject().withMessage('deliveryAddress object required'),
    body('pickupLat').isFloat({ min: -90, max: 90 }).withMessage('Valid pickupLat required'),
    body('pickupLng').isFloat({ min: -180, max: 180 }).withMessage('Valid pickupLng required'),
    body('deliveryLat').isFloat({ min: -90, max: 90 }).withMessage('Valid deliveryLat required'),
    body('deliveryLng').isFloat({ min: -180, max: 180 }).withMessage('Valid deliveryLng required'),
    body('items').isArray({ min: 1 }).withMessage('At least one item required'),
    body('totalWeight').isFloat({ min: 0 }).withMessage('totalWeight must be a non-negative number'),
    body('totalVolume').isFloat({ min: 0 }).withMessage('totalVolume must be a non-negative number'),
    body('totalValue').isFloat({ min: 0 }).withMessage('totalValue must be a non-negative number'),
    body('paymentMethod').isIn(['CASH', 'CARD', 'BANK_TRANSFER', 'WALLET', 'COD']).withMessage('Invalid paymentMethod'),
    body('instructions').optional().isString(),
  ],
  validate,
  OrderTypedController.createTypedOrder
);

// ---------------------------------------------------------------
// Shared query validators for `GET /orders` and `GET /orders/my`.
// Both endpoints call the same controller, so they share the same
// param shape. Keeping the validator list in one place stops the
// two routes from drifting apart as we add more filters.
// ---------------------------------------------------------------
const ORDER_STATUS_VALUES = ['pending', 'assigned', 'picked_up', 'on_the_way', 'delivered', 'cancelled'];
const VEHICLE_TYPE_VALUES = ['motorcycle', 'car', 'van', 'truck', 'bicycle'];

const orderListValidators = [
  query('page').optional().isInt({ min: 1 }).toInt(),
  query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  query('status').optional().isIn(ORDER_STATUS_VALUES),
  query('search').optional().isString().isLength({ max: 100 }),
  query('driverId').optional().isUUID(),
  query('vehicleType').optional().isIn(VEHICLE_TYPE_VALUES),
  query('startDate').optional().isISO8601(),
  query('endDate').optional().isISO8601(),
];

router.get(
  '/orders/my',
  authenticate,
  authorize('seller'),
  orderListValidators,
  validate,
  OrderTypedController.listMyOrders
);

router.get(
  '/orders',
  authenticate,
  authorize('seller', 'admin'),
  orderListValidators,
  validate,
  OrderTypedController.listMyOrders
);

// IMPORTANT: /orders/stats MUST be registered BEFORE /orders/:id,
// otherwise Express will treat "stats" as an order id and 400.
router.get(
  '/orders/stats',
  authenticate,
  authorize('seller', 'admin'),
  validate,
  OrderController.getStats
);

router.get(
  '/orders/:id',
  authenticate,
  authorize('seller', 'admin', 'driver'),
  [param('id').isUUID().withMessage('Valid order ID required')],
  validate,
  OrderTypedController.getTypedOrder
);

router.patch(
  '/orders/:id/status',
  authenticate,
  authorize('seller', 'driver', 'admin'),
  [
    param('id').isUUID().withMessage('Valid order ID required'),
    body('status').isIn(['PENDING', 'CONFIRMED', 'ASSIGNED', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED', 'FAILED', 'RETURNED']).withMessage('Invalid status'),
  ],
  validate,
  OrderTypedController.updateOrderStatus
);

// POST /orders/:id/assign — assign a driver to an order
router.post(
  '/orders/:id/assign',
  authenticate,
  authorize('seller', 'admin'),
  [
    param('id').isUUID().withMessage('Valid order ID required'),
    body('driverId').isUUID().withMessage('Valid driverId required'),
    body('routeId').optional().isUUID(),
  ],
  validate,
  OrderTypedController.assignOrder
);

// POST /orders/:id/cancel — cancel an order with a reason
//
// IMPORTANT: this must be registered BEFORE /orders/:id (it doesn't
// actually conflict because /orders/:id is GET-only, but for symmetry
// with the other /orders/:id/* routes it lives in this block).
router.post(
  '/orders/:id/cancel',
  authenticate,
  authorize('seller', 'admin'),
  [
    param('id').isUUID().withMessage('Valid order ID required'),
    body('reason').optional().isString().isLength({ max: 500 }),
  ],
  validate,
  OrderTypedController.cancelOrder
);

// POST /orders/:id/decline — driver-only counterpart to cancel.
//
// The driver has an "I can't take this one" flow that is NOT a cancel:
// we want the order to go back to PENDING in the seller's pool so it
// can be re-assigned, not marked CANCELLED. The driver is freed
// (busy → available, workload -= 1) and the per-order PICKUP +
// DELIVERY tasks are marked CANCELLED.
router.post(
  '/orders/:id/decline',
  authenticate,
  authorize('driver'),
  [param('id').isUUID().withMessage('Valid order ID required')],
  validate,
  OrderTypedController.declineOrder
);

// =====================================================================
// Task routes
// =====================================================================
// /tasks/my is the driver dashboard's primary feed. /tasks is the
// admin/seller audit view. /tasks/:id and /tasks/:id/status are the
// per-task read + advance endpoints used by the driver detail view.
//
// IMPORTANT: /tasks/my MUST be registered BEFORE /tasks/:id, otherwise
// Express will treat "my" as a task id and 400 out with a UUID error.
const TASK_STATUS_VALUES = [
  'PENDING',
  'ACCEPTED',
  'EN_ROUTE_TO_PICKUP',
  'ARRIVED_AT_PICKUP',
  'PICKED_UP',
  'EN_ROUTE_TO_DROPOFF',
  'ARRIVED_AT_DROPOFF',
  'DELIVERED',
  'FAILED',
  'CANCELLED',
];

router.get(
  '/tasks/my',
  authenticate,
  authorize('driver'),
  [
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('status').optional().isIn(TASK_STATUS_VALUES),
  ],
  validate,
  TaskController.listMyTasks
);

router.get(
  '/tasks',
  authenticate,
  authorize('admin', 'seller'),
  [
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('driverId').optional().isUUID(),
    query('routeId').optional().isUUID(),
    query('orderId').optional().isUUID(),
    query('status').optional().isIn(TASK_STATUS_VALUES),
  ],
  validate,
  TaskController.listTasks
);

router.get(
  '/tasks/:id',
  authenticate,
  [param('id').isUUID().withMessage('Valid task ID required')],
  validate,
  TaskController.getTask
);

router.patch(
  '/tasks/:id/status',
  authenticate,
  authorize('driver', 'admin'),
  [
    param('id').isUUID().withMessage('Valid task ID required'),
    body('status').isIn(TASK_STATUS_VALUES).withMessage('Invalid task status'),
    body('notes').optional().isString().isLength({ max: 1000 }),
  ],
  validate,
  TaskController.updateTaskStatus
);

// Driver routes
router.post(
  '/drivers/profile',
  authenticate,
  authorize('driver'),
  DriverController.createDriverProfile
);

router.patch(
  '/drivers/location',
  authenticate,
  authorize('driver'),
  [
    body('latitude').isFloat({ min: -90, max: 90 }).withMessage('Valid latitude required'),
    body('longitude').isFloat({ min: -180, max: 180 }).withMessage('Valid longitude required'),
  ],
  validate,
  DriverController.updateLocation
);

router.patch(
  '/drivers/availability',
  authenticate,
  authorize('driver'),
  [
    body('availabilityStatus').isIn(['available', 'busy', 'offline']).withMessage('Invalid availability status'),
  ],
  validate,
  DriverController.updateAvailability
);

// GET /drivers/me — fetch the calling driver's own record (plus
// joined user + vehicle). The driver dashboard's /driver/vehicle
// page calls this. Must be registered BEFORE /drivers/:id so
// Express doesn't treat "me" as a driver id.
router.get(
  '/drivers/me',
  authenticate,
  authorize('driver'),
  DriverController.getMe
);

router.get(
  '/drivers/nearby',
  authenticate,
  authorize('admin', 'seller'),
  [
    query('latitude').isFloat({ min: -90, max: 90 }).withMessage('Valid latitude required'),
    query('longitude').isFloat({ min: -180, max: 180 }).withMessage('Valid longitude required'),
    query('radius').optional().isFloat({ min: 0.1, max: 100 }).toFloat(),
  ],
  validate,
  DriverController.getNearbyDrivers
);

// Route routes
// The typed route (multi-waypoint, seller-driven) MUST be registered before
// the legacy /routes handler below, otherwise Express will match the legacy
// validator first and reject typed payloads (e.g. startLocation is required,
// not orderId/driverId/polyline).
router.post(
  '/routes',
  authenticate,
  authorize('seller', 'admin'),
  [
    body('name').isString().trim().notEmpty().withMessage('name required'),
    body('startLocation').isObject().withMessage('startLocation required'),
    body('endLocation').isObject().withMessage('endLocation required'),
    body('waypoints').optional().isArray(),
    body('driverId').optional().isUUID(),
    body('vehicleId').optional().isUUID(),
    body('orderIds').optional().isArray(),
  ],
  validate,
  RouteTypedController.create
);

router.post(
  '/routes/legacy',
  authenticate,
  authorize('admin'),
  [
    body('orderId').isUUID().withMessage('Valid order ID required'),
    body('driverId').isUUID().withMessage('Valid driver ID required'),
    body('optimizedPolyline').isString().notEmpty().withMessage('Polyline required'),
    body('estimatedTravelTime').isInt({ min: 1 }).withMessage('Valid travel time required'),
    body('estimatedDistance').isFloat({ min: 0 }).withMessage('Valid distance required'),
  ],
  validate,
  RouteController.createRoute
);

router.post(
  '/routes/optimize',
  authenticate,
  authorize('admin', 'seller'),
  [
    body('driverId').isUUID().withMessage('Valid driver ID required'),
    body('orderIds').isArray({ min: 1 }).withMessage('At least one order ID required'),
    body('orderIds.*').isUUID().withMessage('Valid order ID required'),
  ],
  validate,
  RouteController.optimizeRoute
);

// NOTE: GET /routes/:id is registered later (in the typed-routes section).
// The earlier legacy handler at this position has been removed because it
// shadowed `/routes/my` — Express matches the first registered route, and
// `:id` was consuming "my" as an id. The typed controller at the bottom
// (RouteTypedController.getById) handles the same path correctly.

// NOTE: legacy `GET /routes` (driver-only listing) has been removed because
// it shadowed the typed `GET /routes` further down. The typed controller
// (RouteTypedController.list) is now the canonical handler.

// Analytics routes (dashboard metrics + revenue timeseries)
router.get(
  '/analytics/dashboard',
  authenticate,
  authorize('admin', 'seller', 'driver'),
  [
    query('startDate').optional().isISO8601().withMessage('Valid startDate required'),
    query('endDate').optional().isISO8601().withMessage('Valid endDate required'),
  ],
  validate,
  AnalyticsController.getDashboardMetrics
);

router.get(
  '/analytics/revenue',
  authenticate,
  authorize('admin', 'seller', 'driver'),
  [
    query('startDate').optional().isISO8601().withMessage('Valid startDate required'),
    query('endDate').optional().isISO8601().withMessage('Valid endDate required'),
  ],
  validate,
  AnalyticsController.getRevenueAnalytics
);

// Driver-only — returns earnings computed from a base + per-km
// rate model rather than the seller's `orders.total_amount`.
// See DriverEarningsService for the rate source.
router.get(
  '/analytics/driver-earnings',
  authenticate,
  authorize('driver'),
  [
    query('startDate').optional().isISO8601().withMessage('Valid startDate required'),
    query('endDate').optional().isISO8601().withMessage('Valid endDate required'),
  ],
  validate,
  AnalyticsController.getDriverEarnings
);

router.get(
  '/analytics/deliveries',
  authenticate,
  authorize('admin', 'seller', 'driver'),
  [
    query('startDate').optional().isISO8601().withMessage('Valid startDate required'),
    query('endDate').optional().isISO8601().withMessage('Valid endDate required'),
  ],
  validate,
  AnalyticsController.getDeliveryAnalytics
);

router.get(
  '/analytics/drivers',
  authenticate,
  authorize('admin', 'seller'),
  [
    query('startDate').optional().isISO8601().withMessage('Valid startDate required'),
    query('endDate').optional().isISO8601().withMessage('Valid endDate required'),
  ],
  validate,
  AnalyticsController.getDriverPerformance
);

// =====================================================================
// Seller routes
// =====================================================================
// IMPORTANT: /sellers/me must be registered BEFORE /sellers/:id, otherwise
// Express will treat "me" as an id and 400-out.
router.get('/sellers/me', authenticate, SellerController.getMySeller);
router.get('/sellers/me/stats', authenticate, SellerController.getMySeller);
router.post('/sellers', authenticate, authorize('seller'), SellerController.createSeller);
router.patch(
  '/sellers/me',
  authenticate,
  authorize('seller'),
  SellerController.updateSeller
);
router.patch(
  '/sellers/:id',
  authenticate,
  authorize('admin', 'seller'),
  SellerController.updateSeller
);
router.get(
  '/sellers',
  authenticate,
  authorize('admin'),
  SellerController.listSellers
);
router.get(
  '/sellers/:id',
  authenticate,
  SellerController.getSellerById
);

// =====================================================================
// Vehicle routes
// =====================================================================
router.post(
  '/vehicles',
  authenticate,
  authorize('seller'),
  [
    body('plateNumber').isString().trim().notEmpty().withMessage('plateNumber required'),
    // Accept either the DB enum (lowercase) or the frontend enum (UPPERCASE).
    // The controller normalizes to lowercase before writing.
    body('type').isIn(['motorcycle', 'car', 'van', 'truck', 'bicycle', 'MOTORCYCLE', 'CAR', 'VAN', 'TRUCK', 'BICYCLE']).withMessage('Invalid type'),
    body('brand').isString().trim().notEmpty().withMessage('brand required'),
    body('model').isString().trim().notEmpty().withMessage('model required'),
    body('year').isInt({ min: 1950, max: new Date().getFullYear() + 1 }).withMessage('year must be a valid year'),
    body('capacityWeight').isFloat({ min: 0 }).withMessage('capacityWeight must be >= 0'),
    body('capacityVolume').isFloat({ min: 0 }).withMessage('capacityVolume must be >= 0'),
  ],
  validate,
  VehicleController.create
);

router.get(
  '/vehicles/my',
  authenticate,
  authorize('seller'),
  [
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  ],
  validate,
  VehicleController.myVehicles
);

router.get(
  '/vehicles',
  authenticate,
  [
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  ],
  validate,
  VehicleController.list
);

router.get('/vehicles/:id', authenticate, VehicleController.getById);
router.patch('/vehicles/:id', authenticate, authorize('seller', 'admin'), VehicleController.update);
router.delete('/vehicles/:id', authenticate, authorize('seller', 'admin'), VehicleController.delete);

// =====================================================================
// Typed routes (multi-waypoint, seller-driven)
// =====================================================================
// The POST /routes handler is registered earlier (above, before the legacy
// /routes/legacy handler) so the typed payload is matched first. Here we
// only register the GET / PATCH / DELETE / list / my-routes handlers.

router.get(
  '/routes/my',
  authenticate,
  authorize('seller', 'driver'),
  [
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('status').optional().isString(),
  ],
  validate,
  RouteTypedController.myRoutes
);

// IMPORTANT: register /routes/by-order/:orderId BEFORE /routes/:id —
// Express matches in order, and `:id` would otherwise swallow the
// "by-order" literal as the id and 400-out.
router.get(
  '/routes/by-order/:orderId',
  authenticate,
  authorize('admin', 'seller', 'driver'),
  [
    param('orderId').isUUID().withMessage('Valid orderId (UUID) required'),
  ],
  validate,
  RouteController.getRouteByOrderId
);

router.get(
  '/routes',
  authenticate,
  [
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  ],
  validate,
  RouteTypedController.list
);

router.get('/routes/:id', authenticate, RouteTypedController.getById);
router.patch('/routes/:id', authenticate, authorize('seller', 'admin'), RouteTypedController.update);
router.delete('/routes/:id', authenticate, authorize('seller', 'admin'), RouteTypedController.delete);

// =====================================================================
// Driver list (for seller's assign-driver dropdown)
// =====================================================================
router.get(
  '/drivers',
  authenticate,
  [
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('isAvailable').optional().isIn(['true', 'false']),
  ],
  validate,
  DriverController.listDrivers
);

// =====================================================================
// Notifications inbox
// =====================================================================
//
// The bell in the top-right of every role layout polls `GET /notifications`
// on mount and writes the rows into a zustand store. `PATCH /:id/read` and
// `PATCH /read-all` are the mark-read actions the dropdown uses.
//
// All three endpoints are scoped to the caller — the controller filters by
// `req.user.sub`, so a caller can only see/mark their own notifications.
// The `:id` path param is also matched against `user_id` in the service
// layer so a caller can't toggle someone else's notification.
router.get(
  '/notifications',
  authenticate,
  [
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  ],
  validate,
  NotificationsController.listNotifications
);
router.patch('/notifications/:id/read', authenticate, NotificationsController.markRead);
router.patch('/notifications/read-all', authenticate, NotificationsController.markAllRead);

export default router;