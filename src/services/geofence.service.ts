import { knex } from '../config/database';
import { config } from '../config/env';
import { haversineMeters, LatLng } from '../utils/geo';
import { OrderService } from './order.service';

/**
 * Geofencing for delivery completion.
 *
 * When a driver pushes a location update (REST or socket), this
 * service checks whether the driver is within
 * `config.GEOFENCE_DELIVERY_RADIUS_METERS` of any of their
 * `on_the_way` orders' delivery coordinates. If so, those orders
 * are auto-transitioned to `delivered`.
 *
 * The status transition goes through `OrderService.updateOrderStatus`
 * so the downstream side effects — `order_status_history` row,
 * `order:status` socket broadcast, customer notifications, and
 * `AutoAssignService.freeDriverForOrder` — all run for free.
 *
 * Notes:
 *   - The radius is read at call time (not at module load) so tests
 *     can override `config.GEOFENCE_DELIVERY_RADIUS_METERS` and the
 *     change takes effect on the next call.
 *   - Idempotency: we re-read the order's status immediately before
 *     transitioning. If it's no longer `on_the_way` (e.g. the driver
 *     manually cancelled it, or a parallel auto-deliver already
 *     finished), we do nothing.
 *   - The caller treats the call as fire-and-forget (a `.catch(...)`
 *     on the returned promise). A slow DB or a misconfigured radius
 *     must never delay a high-frequency location push.
 */
export class GeofenceService {
  /**
   * Check the driver's just-written location against any active
   * `on_the_way` order they're carrying. If any are within the
   * configured radius of their delivery coordinate, mark them
   * `delivered`. No-op for drivers with no active on_the_way orders
   * or when the geofence is disabled (radius ≤ 0).
   *
   * Errors are caught and logged; the caller does not need to handle
   * them.
   */
  static async checkOnLocationUpdate(
    driverId: string,
    location: LatLng
  ): Promise<void> {
    const radiusMeters = config.GEOFENCE_DELIVERY_RADIUS_METERS;
    if (!radiusMeters || radiusMeters <= 0) {
      // Geofence disabled.
      return;
    }

    // Single SELECT for all on_the_way orders this driver is
    // carrying. Hits the existing `idx_orders_driver_id` index.
    const activeOrders = await knex('orders')
      .select('id', 'status', 'latitude', 'longitude', 'delivery_latitude', 'delivery_longitude')
      .where({ driver_id: driverId, status: 'on_the_way' });

    if (activeOrders.length === 0) return;

    for (const order of activeOrders) {
      const deliveryCoord = this.getDeliveryCoord(order);
      if (!deliveryCoord) continue;

      const distanceMeters = haversineMeters(location, deliveryCoord);
      // `null` means at least one input was missing/non-finite/out of
      // range. We treat that as "out of range" (skip) rather than
      // letting the old `NaN > x === false` behaviour silently bypass
      // the check — a driver with corrupt GPS would otherwise never
      // auto-deliver.
      if (distanceMeters == null || distanceMeters > radiusMeters) continue;

      // Idempotency guard: re-read the status right before the
      // transition. `OrderService.updateOrderStatus` writes a history
      // row and emits a broadcast on every call, so we want to avoid
      // firing it twice for the same order.
      const current = await knex('orders')
        .select('status')
        .where({ id: order.id })
        .first();
      if (!current || current.status !== 'on_the_way') continue;

      try {
        await OrderService.updateOrderStatus(order.id, 'delivered');
      } catch (err) {
        // Log but don't rethrow — one bad order must not stop the
        // others, and the caller treats this whole call as
        // fire-and-forget.
        console.warn(`[geofence] auto-deliver failed for order ${order.id}:`, err);
      }
    }
  }

  /**
   * Resolve the canonical delivery coordinate for an order. Typed
   * orders (with `delivery_latitude`/`delivery_longitude`) get those;
   * legacy orders fall back to the bare `latitude`/`longitude`
   * columns. Returns `null` if both are missing / zero (shouldn't
   * happen in practice — a delivery always has a coord — but we
   * defend against it).
   */
  private static getDeliveryCoord(order: {
    delivery_latitude?: number | string | null;
    delivery_longitude?: number | string | null;
    latitude?: number | string | null;
    longitude?: number | string | null;
  }): LatLng | null {
    // The legacy `latitude=0 && longitude=0` check was meant to
    // defend against uninitialised rows, but it also rejects the
    // real (0°, 0°) point in the Gulf of Guinea. The uninitialised
    // sentinel is "both columns are 0 simultaneously" — a real
    // delivery near (0, 0) is vanishingly unlikely and easy to
    // confirm with a sanity check. Only reject when BOTH are zero.
    const dLat = Number(order.delivery_latitude);
    const dLng = Number(order.delivery_longitude);
    if (
      Number.isFinite(dLat) &&
      Number.isFinite(dLng) &&
      !(dLat === 0 && dLng === 0)
    ) {
      return { latitude: dLat, longitude: dLng };
    }
    const lat = Number(order.latitude);
    const lng = Number(order.longitude);
    if (
      Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      !(lat === 0 && lng === 0)
    ) {
      return { latitude: lat, longitude: lng };
    }
    return null;
  }
}
