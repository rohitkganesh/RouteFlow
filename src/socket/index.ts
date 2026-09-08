import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import { config } from '../config/env';
import { verifyAccessToken, JWTPayload } from '../config/jwt';
import { knex } from '../config/database';

interface AuthenticatedSocket extends Socket {
  user?: JWTPayload;
  /**
   * True when the socket connected with a valid JWT. Unauthenticated
   * public sockets (e.g. the /track/:id page) can still connect, but
   * they are limited to joining `order:<id>` rooms for orders in
   * publicly-trackable statuses.
   */
  authenticated?: boolean;
}

interface DriverLocationData {
  driverId: string;
  latitude: number;
  longitude: number;
  heading?: number;
  speed?: number;
  timestamp: Date;
}

interface OrderStatusData {
  orderId: string;
  status: string;
  driverId?: string;
  location?: { latitude: number; longitude: number };
  timestamp: Date;
}

/**
 * Per-task status update. Emitted whenever a task row moves through the
 * PICKUP / DELIVERY state machine (TaskService.advanceStatus) so the
 * driver's /driver/tasks page can re-render without a manual refresh.
 *
 * Carries both the task id (so the frontend can match the right row)
 * and the order id (so an order-level listener can also react).
 * `driverId` is the Driver table PK — TaskService already has that
 * loaded, so callers don't need to re-resolve.
 */
export interface TaskStatusData {
  taskId: string;
  orderId: string;
  driverId: string;
  type: 'PICKUP' | 'DELIVERY';
  status: string;
  timestamp: Date;
}

interface JoinRoomData {
  room: string;
}

/**
 * Order statuses that are safe to expose to the public. The /track/:id
 * page is intentionally unauthenticated, so we only let public sockets
 * join rooms for orders that are already in motion (pickup / delivery
 * in progress) — a `pending` order reveals the customer's address
 * before the driver has even been assigned, so it's NOT public.
 */
const PUBLIC_TRACKABLE_STATUSES = ['assigned', 'picked_up', 'on_the_way'] as const;

let io: Server | null = null;

/**
 * Tiny in-memory cache of user_id → driver_id so we don't issue a
 * SELECT every time the driver pushes a location update. Cleared on
 * process restart; stale entries (driver profile deleted) self-correct
 * because we re-query on miss.
 */
const userIdToDriverIdCache = new Map<string, string>();

/**
 * Resolve the Driver table primary key for a given user id. The
 * `driver:location` socket event from the driver app carries
 * `driverId: <user_id>` (the JWT subject), but the `orders.driver_id`
 * column and the `driver:<id>` rooms use the Driver PK. This helper
 * bridges the two.
 */
async function resolveDriverPk(userId: string): Promise<string | null> {
  const cached = userIdToDriverIdCache.get(userId);
  if (cached) return cached;
  const row = await knex('drivers').select('id').where({ user_id: userId }).first();
  if (!row) return null;
  userIdToDriverIdCache.set(userId, row.id);
  return row.id;
}

/**
 * Look up the order ids a driver is currently handling (orders in
 * `assigned` / `picked_up` / `on_the_way`). Returns an empty array if
 * the driver has no active orders. Hits the `idx_orders_driver_id`
 * index so it's cheap at the row counts this app sees.
 */
async function getActiveOrderIdsForDriver(driverId: string): Promise<string[]> {
  const rows = await knex('orders')
    .select('id')
    .where({ driver_id: driverId })
    .whereIn('status', PUBLIC_TRACKABLE_STATUSES as unknown as string[]);
  return rows.map((r) => r.id);
}

/**
 * Initialize Socket.io server
 */
export function initializeSocket(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    cors: {
      origin: config.CORS_ORIGIN
        ? config.CORS_ORIGIN.split(',').map((o) => o.trim())
        : [
            'http://localhost:3000',
            'http://localhost:3001',
            'http://localhost:3002',
            'http://localhost:3003',
            'http://127.0.0.1:3000',
            'http://127.0.0.1:3001',
            'http://127.0.0.1:3002',
          ],
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  });

  // Authentication middleware
  //
  // Connections WITHOUT a token are allowed (the public /track/:id page
  // is intentionally unauthenticated). They are flagged as
  // `authenticated: false` and can only join `order:<id>` rooms for
  // orders in publicly-trackable statuses (see PUBLIC_TRACKABLE_STATUSES).
  //
  // Connections WITH a token are validated as before; role-based rooms
  // (`user:<id>`, `driver:<id>`, `seller:<id>`, `admins`) are only
  // assigned to authenticated sockets.
  io.use(async (socket: AuthenticatedSocket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.replace('Bearer ', '');

    if (!token) {
      // Public socket — limited capabilities (see join:order handler).
      socket.authenticated = false;
      return next();
    }

    try {
      const payload = verifyAccessToken(token);
      socket.user = payload;
      socket.authenticated = true;
      next();
    } catch (error) {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket: AuthenticatedSocket) => {
    const authLabel = socket.authenticated
      ? `user: ${socket.user?.sub} (role: ${socket.user?.role})`
      : 'public (unauthenticated)';
    console.log(`Client connected: ${socket.id} (${authLabel})`);

    // Role-based rooms — only assigned to authenticated sockets.
    if (socket.authenticated && socket.user) {
      // Personal room for direct messages
      socket.join(`user:${socket.user.sub}`);

      // Role-based rooms
      if (socket.user.role === 'seller') {
        socket.join(`seller:${socket.user.sub}`);
      } else if (socket.user.role === 'driver') {
        socket.join(`driver:${socket.user.sub}`);
      } else if (socket.user.role === 'admin') {
        socket.join('admins');
      }
    }

    // Handle joining order tracking room
    //
    // Authenticated sockets: can join any order room.
    // Unauthenticated (public) sockets: must join an `order:<id>` room
    // for an order that exists and is in a publicly-trackable status
    // (assigned / picked_up / on_the_way). This is the gate that
    // prevents random unauthenticated visitors from listening to any
    // order room — they have to know a real, active order id.
    socket.on('join:order', async (data: JoinRoomData) => {
      const orderId = data?.room;
      if (!orderId) return;

      if (socket.authenticated) {
        const room = `order:${orderId}`;
        socket.join(room);
        console.log(`User ${socket.user?.sub} joined order room: ${room}`);
        return;
      }

      // Unauthenticated path — validate the order exists and is public.
      const order = await knex('orders')
        .select('id', 'status')
        .where({ id: orderId })
        .whereIn('status', PUBLIC_TRACKABLE_STATUSES as unknown as string[])
        .first();
      if (!order) {
        // Silent reject — don't leak whether the id exists. The public
        // client will simply not receive location updates.
        console.warn(`[socket] public join:order rejected for id=${orderId}`);
        return;
      }
      socket.join(`order:${orderId}`);
      console.log(`[socket] public client joined order room: order:${orderId}`);
    });

    // Handle leaving order tracking room
    socket.on('leave:order', (data: JoinRoomData) => {
      const orderId = data?.room;
      if (!orderId) return;
      const room = `order:${orderId}`;
      socket.leave(room);
      console.log(`Client ${socket.id} left order room: ${room}`);
    });

    // Handle driver location updates (from driver app)
    //
    // The driver app sends `driver:location` over the socket. We fan it
    // out to the driver's own room, the admins room, AND every
    // `order:<id>` room the driver currently has an active order for
    // (via emitDriverLocation below). The order-room fan-out is what
    // makes the public /track/:id page update in real time.
    socket.on('driver:location', (data: DriverLocationData) => {
      if (!socket.user || socket.user.role !== 'driver') {
        return;
      }

      // Verify the driverId matches the authenticated user
      if (data.driverId !== socket.user.sub) {
        console.warn(`Driver ${socket.user.sub} attempted to send location for different driver ${data.driverId}`);
        return;
      }

      console.log(`Driver location update: ${data.driverId} -> [${data.latitude}, ${data.longitude}]`);

      // The driver model PK is the user_id when sent from the driver
      // app (the JWT's `sub` is the user id, and the Driver table
      // primary key IS that user id? — actually no, the Driver table
      // has its own `id` and a `user_id` FK. emitDriverLocation expects
      // the Driver PK, so we resolve it from the user_id here.
      resolveDriverPk(data.driverId).then((driverPk) => {
        if (!driverPk) return;
        emitDriverLocation({
          driverId: driverPk,
          latitude: data.latitude,
          longitude: data.longitude,
          heading: data.heading,
          speed: data.speed,
          timestamp: data.timestamp ?? new Date(),
        });
      });
    });

    // Handle order status updates (from driver/seller)
    socket.on('order:status', (data: OrderStatusData) => {
      if (!socket.user) {
        return;
      }

      console.log(`Order status update: ${data.orderId} -> ${data.status} by ${socket.user.role} (${socket.user.sub})`);

      // Broadcast to order tracking room
      io?.to(`order:${data.orderId}`).emit('order:status', data);

      // Broadcast to seller if they own this order
      // Note: Would need to fetch order to get sellerId, for now broadcast to relevant roles
      if (socket.user.role === 'driver') {
        // Driver updated status - notify seller and admins
        io?.to('admins').emit('order:status', data);
        // Seller would be in the order room if they joined it
      } else if (socket.user.role === 'seller') {
        // Seller updated status - notify driver and admins
        io?.to('admins').emit('order:status', data);
        if (data.driverId) {
          io?.to(`driver:${data.driverId}`).emit('order:status', data);
        }
      } else if (socket.user.role === 'admin') {
        // Admin updated status - notify everyone
        io?.to(`order:${data.orderId}`).emit('order:status', data);
      }
    });

    // Handle driver availability updates
    socket.on('driver:availability', (data: { driverId: string; availabilityStatus: string }) => {
      if (!socket.user || socket.user.role !== 'driver') {
        return;
      }

      if (data.driverId !== socket.user.sub) {
        return;
      }

      console.log(`Driver availability update: ${data.driverId} -> ${data.availabilityStatus}`);

      io?.to('admins').emit('driver:availability', data);
      io?.to(`driver:${data.driverId}`).emit('driver:availability', data);
    });

    socket.on('disconnect', (reason) => {
      console.log(`Client disconnected: ${socket.id} (reason: ${reason})`);
    });
  });

  console.log('Socket.io server initialized');
  return io;
}

/**
 * Get the Socket.io server instance
 */
export function getSocketServer(): Server | null {
  return io;
}

/**
 * Emit driver location to relevant rooms (called from HTTP handlers
 * and from the `driver:location` socket event).
 *
 * `data.driverId` MUST be the Driver table primary key (NOT the user
 * id). Callers that have only the user id (the driver-app socket event
 * path) should resolve it via `resolveDriverPk` first.
 *
 * Broadcasts go to:
 *   - `driver:<driverId>` — the driver's own dashboard
 *   - `admins` — the admin monitoring room
 *   - every `order:<id>` room where this driver has an active order in
 *     a publicly-trackable status — this is what feeds the public
 *     /track/:id page
 *
 * The order-room fan-out is async (we need to look up active order
 * ids) but the call is fire-and-forget — a slow query must never
 * delay a high-frequency location push. We use `.catch(...)` to keep
 * any DB error from breaking the in-room broadcast.
 */
export function emitDriverLocation(data: DriverLocationData): void {
  if (!io) return;

  // 1. Driver's own room + admins — synchronous, no DB needed.
  io.to(`driver:${data.driverId}`).emit('driver:location', data);
  io.to('admins').emit('driver:location', data);

  // 2. Fan out to every active order room.
  //    Fire-and-forget; never await in a high-frequency path.
  getActiveOrderIdsForDriver(data.driverId)
    .then((orderIds) => {
      if (orderIds.length === 0) return;
      for (const orderId of orderIds) {
        io?.to(`order:${orderId}`).emit('driver:location', data);
      }
    })
    .catch((err) => {
      // Log but don't propagate — a missing index or transient DB
      // hiccup must not break the live updates.
      console.warn(`[socket] failed to fan out location to order rooms for driver ${data.driverId}:`, err);
    });
}

/**
 * Emit order status update to relevant rooms (called from HTTP handlers)
 */
export function emitOrderStatus(data: OrderStatusData): void {
  if (!io) return;

  // Emit to order tracking room
  io.to(`order:${data.orderId}`).emit('order:status', data);

  // Emit to admins
  io.to('admins').emit('order:status', data);

  // Emit to driver if specified
  if (data.driverId) {
    io.to(`driver:${data.driverId}`).emit('order:status', data);
  }
}

/**
 * Emit a per-task status update to the driver's room and to admins.
 * Companion to `emitOrderStatus` for the PICKUP / DELIVERY task
 * sub-rows: the driver dashboard (/driver/tasks) listens for this
 * event so a "Mark as Delivered" click refreshes the row in place
 * instead of waiting for the next /tasks/my poll.
 *
 * The driver's own room (`driver:<id>`) is the primary consumer;
 * admins also receive it so the admin view stays in sync.
 */
export function emitTaskStatus(data: TaskStatusData): void {
  if (!io) return;

  io.to(`driver:${data.driverId}`).emit('task:status', data);
  io.to('admins').emit('task:status', data);
}

/**
 * Emit driver availability update
 */
export function emitDriverAvailability(driverId: string, availabilityStatus: string): void {
  if (!io) return;

  io.to(`driver:${driverId}`).emit('driver:availability', { driverId, availabilityStatus });
  io.to('admins').emit('driver:availability', { driverId, availabilityStatus });
}

/**
 * Emit an in-app notification to a single user. The notification row is
 * written by notification.service before this is called; this just
 * delivers the live event so the dashboard toast/inbox updates without
 * a refresh.
 */
export interface NotificationEvent {
  id: string;
  userId: string;
  type: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export function emitNotification(event: NotificationEvent): void {
  if (!io) return;
  io.to(`user:${event.userId}`).emit('notification:new', event);
}