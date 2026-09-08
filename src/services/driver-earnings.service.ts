/**
 * Driver Earnings Service
 *
 * Computes what a driver has earned from completed deliveries.
 *
 * **Important:** this is *not* the seller's sale (`orders.total_amount`).
 * The customer-facing order total is the seller's revenue; the driver is
 * paid independently based on a configurable rate model. Decoupling
 * order pricing from driver payouts means a seller can offer free
 * delivery without shorting the driver, and a high-distance order
 * still pays the driver fairly even if the customer paid a small
 * shipping fee.
 *
 * Rate model (see env):
 *   driverEarning = DRIVER_BASE_RATE + (distance_km * DRIVER_PER_KM_RATE)
 *
 * Distance source: prefer the per-order `routes.estimated_distance`
 * (the metric computed by `RouteCalculationService` when the driver
 * was assigned). Fall back to a haversine of the order's pickup →
 * delivery coords if no route row exists, so legacy or pre-calc
 * orders still produce a sensible earning.
 *
 * Scope: only `status = 'delivered'` orders count. Cancelled,
 * returned, and in-flight orders don't.
 */
import { knex } from '../config/database';
import { config } from '../config/env';
import { haversineMeters } from '../utils/geo';

/**
 * Multiplier applied to haversine (straight-line) distance to approximate
 * road-network distance. Used only in the haversine fallback path when no
 * `routes` row exists.
 */
const ROAD_DISTANCE_FACTOR = config.ROUTING_ROAD_DISTANCE_FACTOR;

export interface DriverEarningsBreakdown {
  /** Per-delivery base rate (USD). */
  baseRate: number;
  /** Per-km rate (USD / km). */
  perKmRate: number;
  /** Total distance across the counted orders, in km. */
  totalDistanceKm: number;
  /** Total orders that contributed an earning. */
  orderCount: number;
  /** Sum of base + per-km for all counted orders (USD). */
  totalEarnings: number;
}

export interface DailyEarning {
  /** YYYY-MM-DD (server local timezone) */
  date: string;
  /** Earning for that day (USD). */
  value: number;
}

export class DriverEarningsService {
  /**
   * Earnings for a single delivered order, in USD.
   * Returns 0 for orders that aren't delivered (cancelled, in-flight, etc.)
   * — callers should filter on `status = 'delivered'` first.
   */
  static async computeForOrder(orderId: string): Promise<number> {
    const order = await knex('orders').where({ id: orderId }).first();
    if (!order) return 0;
    if (order.status !== 'delivered') return 0;

    const distanceMeters = await this.getOrderDistanceMeters(order);
    return this.computeForDistance(distanceMeters);
  }

  /**
   * Total driver earnings over a date range. `startDate` and
   * `endDate` are inclusive on both ends; `endDate` is treated as
   * the end of day (mirrors `endOfDayIfMidnight` in the analytics
   * controller). The result is a per-day series plus a total.
   */
  static async computeForDriver(
    driverId: string,
    startDate: Date,
    endDate: Date
  ): Promise<{ breakdown: DriverEarningsBreakdown; daily: DailyEarning[] }> {
    const rows = await knex('orders')
      .where({ driver_id: driverId, status: 'delivered' })
      .where('created_at', '>=', startDate)
      .where('created_at', '<=', endDate)
      .orderBy('created_at', 'asc');

    let totalDistanceMeters = 0;
    let totalEarnings = 0;
    let orderCount = 0;
    const byDate = new Map<string, number>();

    for (const o of rows) {
      const meters = await this.getOrderDistanceMeters(o);
      const earning = this.computeForDistance(meters);
      totalDistanceMeters += meters;
      totalEarnings += earning;
      orderCount++;
      const dayKey = toDateKey(o.created_at);
      byDate.set(dayKey, (byDate.get(dayKey) ?? 0) + earning);
    }

    // Fill the date series so the chart has no gaps.
    const daily: DailyEarning[] = [];
    const cur = new Date(startDate);
    cur.setHours(0, 0, 0, 0);
    const end = new Date(endDate);
    end.setHours(0, 0, 0, 0);
    while (cur.getTime() <= end.getTime()) {
      const key = toDateKey(cur);
      daily.push({ date: key, value: Number((byDate.get(key) ?? 0).toFixed(2)) });
      cur.setDate(cur.getDate() + 1);
    }

    return {
      breakdown: {
        baseRate: config.DRIVER_BASE_RATE,
        perKmRate: config.DRIVER_PER_KM_RATE,
        totalDistanceKm: Number((totalDistanceMeters / 1000).toFixed(2)),
        orderCount,
        totalEarnings: Number(totalEarnings.toFixed(2)),
      },
      daily,
    };
  }

  // ----------------------------------------------------------------
  // Internals
  // ----------------------------------------------------------------

  /**
   * Distance in meters for an order, with a sensible fallback.
   * Prefers the per-order `routes.estimated_distance` written by
   * `RouteCalculationService`. Falls back to haversine of the
   * order's pickup → delivery coords. Returns 0 if we genuinely
   * have no usable coordinates (so the driver's earning is at
   * least the base rate, never negative).
   */
  private static async getOrderDistanceMeters(order: Record<string, unknown>): Promise<number> {
    const route = await knex('routes')
      .where({ order_id: order.id as string })
      .first();
    if (route && route.estimated_distance != null) {
      const m = Number(route.estimated_distance);
      if (Number.isFinite(m) && m > 0) return m;
    }

    // Fallback: haversine of pickup → delivery coords, scaled by the
    // road-distance factor so earnings are based on an approximate road
    // distance even when no `routes` row exists. The real routing
    // provider (OSRM / Google) is already wired into
    // RouteCalculationService, which writes the `routes` row this
    // method prefers; this haversine fallback only fires for legacy
    // or pre-calc orders that have no route row.
    const pickupLat = Number(order.pickup_latitude ?? order.latitude ?? 0);
    const pickupLng = Number(order.pickup_longitude ?? order.longitude ?? 0);
    const deliveryLat = Number(order.delivery_latitude ?? order.latitude ?? 0);
    const deliveryLng = Number(order.delivery_longitude ?? order.longitude ?? 0);
    const meters = haversineMeters(
      { latitude: pickupLat, longitude: pickupLng },
      { latitude: deliveryLat, longitude: deliveryLng },
    );
    if (meters == null || meters <= 0) return 0;
    return Math.round(meters * ROAD_DISTANCE_FACTOR);
  }

  /**
   * Apply the rate model. Pure function — exported for testing.
   */
  static computeForDistance(distanceMeters: number): number {
    const km = Math.max(0, distanceMeters / 1000);
    return Number((config.DRIVER_BASE_RATE + km * config.DRIVER_PER_KM_RATE).toFixed(2));
  }
}

/**
 * YYYY-MM-DD formatter for a Date or ISO string.
 *
 * Uses **local** calendar date (server's timezone) — the rest of the
 * codebase treats the server's local day as the canonical day boundary
 * (see `endOfDayIfMidnight` in the analytics controller). Using UTC
 * here would silently shift the series by ±1 day for any user east of
 * UTC and the chart would show the wrong day as "today".
 */
function toDateKey(v: unknown): string {
  const d =
    v instanceof Date
      ? v
      : typeof v === 'string'
        ? new Date(v)
        : new Date();
  if (isNaN(d.getTime())) return new Date().toISOString().split('T')[0];
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
