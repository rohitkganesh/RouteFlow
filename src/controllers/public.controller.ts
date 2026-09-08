import { Response, NextFunction } from 'express';
import { PublicRequest } from '../middlewares/public-auth.middleware';
import { OrderService } from '../services/order.service';
import { knex } from '../config/database';
import { NotFoundError } from '../utils/errors';
import { Order, OrderStatus } from '../models';
import { decryptObject } from '../config/encryption';

/**
 * Public Controller
 *
 * Handles public-facing endpoints (no authentication required). Every
 * response shape is hand-picked — we never return the full row from
 * `OrderService.getOrderById` (which carries customer phone, seller
 * id, parcel value, etc.) — and the shapes are designed so a tracking
 * link is safe to forward.
 *
 * What we DO surface:
 *   - First name of the customer (so the page can say "Hi, Salman")
 *   - Approximate delivery area (city + state + country only, parsed
 *     from the comma-separated `delivery_address` string the legacy
 *     orders table stores)
 *   - Destination coordinates rounded to 2 decimal places (~1 km)
 *   - Driver first name + last initial, no UUID, no contact info
 *
 * What we DON'T surface:
 *   - Full customer name, phone, email
 *   - Full delivery street address / landmark / instructions
 *   - Driver profile UUID, driver user UUID, driver phone, driver email
 *   - Driver's last known exact position (the live position still
 *     flows through the socket — that's the whole point of the page —
 *     but we don't ship it as part of the initial REST payload)
 *   - Seller id, seller name, seller contact info
 *   - Parcel value, weight, dimensions, description
 *   - Internal notes (e.g. "Assigned to driver <uuid>")
 *   - Pickup address (the seller's secret)
 *   - Route polyline (encodes the seller's pickup coords)
 */
export class PublicController {
  /**
   * Track order by ID — public endpoint
   *
   * GET /api/public/track/:id
   */
  static async trackOrder(req: PublicRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const order = await OrderService.getOrderById(req.params.id);
      if (!order) {
        throw new NotFoundError('Order not found');
      }

      // ---- Driver (public-safe) ----
      //
      // The driver row carries the profile id and a join to `users` for
      // the encrypted first/last name. We decrypt the profile in-process
      // and return only the first name + last initial — never the
      // profile UUID, never the user UUID, never the contact info. If
      // decryption fails (e.g. key rotation in flight) we fall back to
      // "Driver assigned" so the page still renders.
      let driverPublic: PublicDriverSummary | null = null;
      if (order.driver_id) {
        const driverRow = await knex('drivers')
          .join('users', 'drivers.user_id', 'users.id')
          .where({ 'drivers.id': order.driver_id })
          .select(
            'drivers.id as driver_id',
            'drivers.availability_status',
            'users.profile_details'
          )
          .first();
        if (driverRow) {
          const profile = decryptObject(
            (driverRow.profile_details ?? {}) as Record<string, unknown>
          );
          const firstName = typeof profile.firstName === 'string' ? profile.firstName.trim() : '';
          const lastName = typeof profile.lastName === 'string' ? profile.lastName.trim() : '';
          driverPublic = {
            firstName,
            lastInitial: lastName ? `${lastName.charAt(0).toUpperCase()}.` : '',
            availabilityStatus: String(driverRow.availability_status ?? ''),
          };
        }
      }

      // ---- Destination area + coordinates ----
      //
      // Prefer the typed-schema `delivery_latitude` / `delivery_longitude`
      // (set by the typed order flow) and fall back to the legacy
      // `latitude` / `longitude` for orders created before the typed
      // migration. Both are rounded to 2 decimal places (~1 km) for
      // privacy — the live driver pin from the socket is still precise
      // because the customer actively opened the page.
      const row = order as unknown as {
        delivery_latitude?: string | number | null;
        delivery_longitude?: string | number | null;
      };
      const deliveryLatRaw =
        toNumberOrNull(row.delivery_latitude) ?? toNumberOrNull(order.latitude);
      const deliveryLngRaw =
        toNumberOrNull(row.delivery_longitude) ?? toNumberOrNull(order.longitude);
      const deliveryLat = round2(deliveryLatRaw);
      const deliveryLng = round2(deliveryLngRaw);

      // ---- Customer first name ----
      //
      // `customer_name` is a free-form string ("Salman Khan", "Mr.
      // John Smith", "Rohit & Priya"). Take the first whitespace-
      // separated token, which is what most customers would recognize
      // as their first name. Empty / null falls back to "Customer".
      const customerFirstName = (order.customer_name ?? '').trim().split(/\s+/)[0] || 'Customer';

      // ---- Delivery area ----
      //
      // The legacy `delivery_address` is a single comma-separated string
      // with the most-specific part first (street, landmark) and the
      // least-specific part last (city, state, country). We take the
      // last three segments — the typical shape is "<city>, <state>,
      // <country>" — and join them. If we have fewer than three
      // segments we just return whatever's left, defensively.
      const deliveryArea = maskDeliveryAddress(order.delivery_address);

      const publicOrder = {
        id: order.id,
        customerFirstName,
        deliveryArea,
        latitude: deliveryLat,
        longitude: deliveryLng,
        status: order.status,
        createdAt: order.created_at,
        updatedAt: order.updated_at,
        driver: driverPublic,
        // No `route`, no `trackingUrl`, no `parcel_details`, no
        // `customer_phone` / `customer_email` / `seller_id`. The
        // exact delivery coordinate is the only one we ship, and
        // it's already rounded.
      };

      res.json({ success: true, data: { order: publicOrder } });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get order tracking history — public endpoint
   *
   * GET /api/public/track/:id/history
   *
   * Returns the per-status timeline the "Timeline" tab renders. Each
   * point is a state transition (`pending`, `assigned`, `picked_up`,
   * `on_the_way`, `delivered`, `cancelled`). We:
   *   - Round all coordinates to 2 decimal places so a casual visitor
   *     doesn't see the driver's exact GPS history.
   *   - Drop `notes` for any non-final status. Final statuses
   *     (`delivered`, `cancelled`, `failed`) keep their notes, but
   *     we strip any UUID-shaped string out of them as a defensive
   *     measure — the previous code wrote "Assigned to driver
   *     d539490f-6506-4e4d-835d-8dfee8b2c634" into the `assigned`
   *     row's notes, which would have leaked the driver profile id.
   *   - Drop the row `id` — the frontend keys by status + timestamp.
   */
  static async getOrderTrackingHistory(req: PublicRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const order = await OrderService.getOrderById(req.params.id);
      if (!order) {
        throw new NotFoundError('Order not found');
      }

      const trackingHistory = await knex('order_status_history')
        .where({ order_id: order.id })
        .orderBy('timestamp', 'asc')
        .select('id', 'latitude', 'longitude', 'status', 'timestamp', 'notes');

      const formattedHistory = trackingHistory.map((point) => ({
        status: point.status,
        timestamp: point.timestamp,
        latitude: round2(toNumberOrNull(point.latitude)),
        longitude: round2(toNumberOrNull(point.longitude)),
        // Notes for non-final statuses are dropped entirely; notes
        // for final statuses are kept but scrubbed of any UUIDs.
        notes: shouldExposeNotes(point.status)
          ? scrubUuids(typeof point.notes === 'string' ? point.notes : null)
          : null,
      }));

      res.json({ success: true, data: { tracking: formattedHistory } });
    } catch (error) {
      next(error);
    }
  }
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

/**
 * Public-safe driver summary shape. Only includes what the public
 * page needs (first name, last initial, availability status) and
 * nothing that could be used to contact or identify the driver
 * outside the app.
 */
interface PublicDriverSummary {
  firstName: string;
  lastInitial: string;
  availabilityStatus: string;
}

/**
 * Coerce a value (string, number, null, undefined) to a number or
 * null. Used when reading coordinate columns from the DB — Knex
 * surfaces Postgres NUMERIC values as strings, so a straight
 * `Number(x)` is fine but `Number(null)` is 0, which is the wrong
 * sentinel for "missing coordinate."
 */
function toNumberOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Round to 2 decimal places. Returns `null` if the input is null —
 * callers should pass the result of `toNumberOrNull`. The 2-decimal
 * precision is ~1 km at the equator, which is enough to position a
 * destination marker at a city zoom level.
 */
function round2(v: number | null): number | null {
  if (v == null) return null;
  return Math.round(v * 100) / 100;
}

/**
 * Reduce a free-form comma-separated `delivery_address` to the last
 * 2-3 segments (city, state/province, country). The legacy orders
 * table stores addresses in most-specific-first order — the legacy
 * example was "Shishu Nikunja secondary school, NH21, Nagarjun-05,
 * Nagarjun, Nagarjun Municipality, Kathmandu, Bagamati Province",
 * so the last 2-3 segments are the right things to expose.
 *
 * Returns `'—'` if the address is empty so the page can render an
 * em-dash without an awkward blank string.
 */
function maskDeliveryAddress(address: string | null | undefined): string {
  if (!address) return '—';
  const segments = address
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (segments.length === 0) return '—';
  // The last segment is the country (or state if no country was
  // provided). Take the last 3 segments when we have 3+, else
  // whatever's left.
  const tail = segments.slice(-3);
  return tail.join(', ');
}

/**
 * Whether the per-status `notes` field is safe to expose on the
 * public page. Final statuses (delivered / cancelled / failed) get
 * a one-line human summary in the notes; intermediate statuses
 * historically have machine-generated text with internal ids
 * (driver profile UUID, etc.), so we drop those.
 */
function shouldExposeNotes(status: string): boolean {
  const s = String(status ?? '').toLowerCase();
  return s === 'delivered' || s === 'cancelled' || s === 'failed';
}

/**
 * Strip every UUID-shaped substring from a notes string. Defensive:
 * the codebase has historically written driver profile UUIDs into
 * the `assigned` row's notes (e.g. "Assigned to driver
 * d539490f-6506-4e4d-835d-8dfee8b2c634"). We don't expose those
 * rows' notes anyway, but if a future edit moves a UUID into a
 * delivered row's notes we still won't leak it.
 */
function scrubUuids(input: string | null): string | null {
  if (!input) return input;
  return input.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    '[redacted]'
  );
}
