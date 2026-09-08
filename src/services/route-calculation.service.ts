/**
 * Per-order route calculation.
 *
 * Wraps the shared `routingService.getRoute(origin, destination)` so the
 * caller only needs to provide pickup/destination coordinates + the
 * `orderId`/`driverId` they want attached to the resulting row. The
 * computed distance, duration, and decoded polyline points are written
 * to a `routes` row (upsert by `order_id`) and returned as a
 * camelCase payload suitable for the frontend.
 *
 * Failure handling:
 *   - Missing origin or destination → `ValidationError` (the caller
 *     — OrderService.assignDriver — never calls us without coords).
 *   - Routing provider network / 5xx error → log + fall back to
 *     haversine distance at 30 km/h (urban speed), polyline reduced
 *     to `[origin, destination]`. The order assignment flow must
 *     not be blocked by a routing outage.
 *   - Existing route row for this order → upsert via
 *     `select-then-update`. The `routes.order_id` UNIQUE constraint
 *     enforces uniqueness; we read-then-write so the in-flight row
 *     gets its distance/duration/polyline refreshed without a raw
 *     `ON CONFLICT` (which isn't portable across drivers/Postgres
 *     versions).
 */
import { knex } from '../config/database';
import { Route, RouteStatus } from '../models';
import { ValidationError } from '../utils/errors';
import { haversineMeters } from '../utils/geo';
import { routingService, Coordinates } from './routing.service';

export interface CalculateRouteInput {
  orderId: string;
  driverId: string;
  origin: { latitude: number; longitude: number };
  destination: { latitude: number; longitude: number };
}

export interface PolylinePoint {
  lat: number;
  lng: number;
}

export interface CalculatedRoute {
  id: string;
  orderId: string;
  driverId: string;
  /** Distance in meters (matches historical `routes.estimated_distance` unit). */
  distance: number;
  /** ETA in minutes, rounded to 1 decimal. */
  etaMinutes: number;
  /** Raw duration in seconds (matches `routes.estimated_travel_time`). */
  durationSeconds: number;
  /** Encoded polyline as returned by the routing provider (or mock `lat,lng;lat,lng`). */
  polyline: string;
  /** Decoded polyline points for the map UI to draw without shipping a polyline decoder. */
  polylinePoints: PolylinePoint[];
  status: RouteStatus;
  createdAt: Date;
}

/** Average urban speed in m/s (30 km/h). */
const URBAN_SPEED_MPS = 30_000 / 3600;

export class RouteCalculationService {
  /**
   * Compute a pickup→delivery leg and persist it as a `routes` row.
   *
   * Never throws on routing-provider errors — those fall back to a
   * haversine-based straight line. The only things that throw are
   * caller mistakes (missing coordinates, missing ids).
   */
  static async calculateRoute(input: CalculateRouteInput): Promise<CalculatedRoute> {
    const { orderId, driverId, origin, destination } = input;

    if (!orderId || !driverId) {
      throw new ValidationError('orderId and driverId are required');
    }
    if (
      !isValidCoord(origin) ||
      !isValidCoord(destination)
    ) {
      throw new ValidationError('origin and destination must be valid {latitude, longitude} pairs');
    }

    const o = normalize(origin!);
    const d = normalize(destination!);

    let distance: number;
    let duration: number;
    let polyline: string;
    let providerSucceeded = true;

    try {
      const leg = await routingService.getRoute(o, d);
      distance = Math.max(0, Math.round(Number(leg.distance) || 0));
      duration = Math.max(0, Math.round(Number(leg.duration) || 0));
      polyline = String(leg.polyline ?? '');
      if (!polyline) {
        // Defensive: an empty polyline is useless for the map. Fall back
        // to the mock format so the UI still has something to draw.
        polyline = encodeMockPolyline([o, d]);
      }
    } catch (err) {
      providerSucceeded = false;
      const reason = (err as Error)?.message ?? 'unknown error';
      console.warn(
        `[route-calculation] routing provider failed for order ${orderId} (${reason}); ` +
        `falling back to haversine straight-line`
      );
      const meters = haversineMeters(o, d) ?? 0;
      distance = Math.round(meters);
      duration = Math.round(distance / URBAN_SPEED_MPS);
      polyline = encodeMockPolyline([o, d]);
    }

    // The routing provider can return a 0-second duration for very
    // short legs. Floor to 1 second so downstream "ETA > 0" checks
    // don't read 0:00.
    if (distance > 0 && duration === 0) {
      duration = 1;
    }

    const polylinePoints = decodePolyline(polyline);
    // If decoding returned nothing (e.g. blank or unrecognised string),
    // fall back to the two endpoints so the map has *something* to draw.
    const finalPoints: PolylinePoint[] =
      polylinePoints.length > 0 ? polylinePoints : [
        { lat: o.latitude, lng: o.longitude },
        { lat: d.latitude, lng: d.longitude },
      ];

    const etaMinutes = Math.round((duration / 60) * 10) / 10;
    const now = new Date();

    const existing = await knex('routes').where({ order_id: orderId }).first();

    let row: Route;
    if (existing) {
      const [updated] = await knex('routes')
        .where({ id: existing.id })
        .update({
          driver_id: driverId,
          optimized_polyline: polyline,
          estimated_travel_time: duration,
          estimated_distance: distance,
          updated_at: now,
        })
        .returning('*');
      row = updated;
    } else {
      const [inserted] = await knex('routes')
        .insert({
          order_id: orderId,
          driver_id: driverId,
          optimized_polyline: polyline,
          estimated_travel_time: duration,
          estimated_distance: distance,
          status: 'planned',
          created_at: now,
          updated_at: now,
        })
        .returning('*');
      row = inserted;
    }

    return {
      id: row.id,
      orderId: row.order_id,
      driverId: row.driver_id,
      distance,
      etaMinutes,
      durationSeconds: duration,
      polyline,
      polylinePoints: finalPoints,
      status: row.status as RouteStatus,
      createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
      ...(providerSucceeded ? {} : {}), // placeholder; we could add `fallback: true` later
    };
  }

  /**
   * Hydrate a `routes` row to the same camelCase `CalculatedRoute`
   * shape `calculateRoute` returns. Used by `getRouteByOrderId` so
   * the API surface is uniform regardless of which path created
   * the row (e.g. `RouteService.optimizeDeliveryRoute` writes rows
   * without `polyline_points`).
   */
  static hydrate(row: Route): CalculatedRoute {
    const distance = Math.round(Number(row.estimated_distance) || 0);
    const duration = Math.max(0, Math.round(Number(row.estimated_travel_time) || 0));
    const etaMinutes = Math.round((duration / 60) * 10) / 10;

    const polyline = String(row.optimized_polyline ?? '');
    const polylinePoints = decodePolyline(polyline);

    return {
      id: row.id,
      orderId: row.order_id,
      driverId: row.driver_id,
      distance,
      etaMinutes,
      durationSeconds: duration,
      polyline,
      polylinePoints,
      status: row.status as RouteStatus,
      createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidCoord(
  p: { latitude: unknown; longitude: unknown } | null | undefined
): p is { latitude: number; longitude: number } {
  if (!p) return false;
  const lat = Number(p.latitude);
  const lng = Number(p.longitude);
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 && lat <= 90 &&
    lng >= -180 && lng <= 180
  );
}

function normalize(p: { latitude: number; longitude: number }): Coordinates {
  return { latitude: Number(p.latitude), longitude: Number(p.longitude) };
}

function encodeMockPolyline(coords: Coordinates[]): string {
  return coords
    .map(c => `${Number(c.latitude).toFixed(6)},${Number(c.longitude).toFixed(6)}`)
    .join(';');
}

/**
 * Decode a polyline string. Supports two formats:
 *
 * 1. **Google encoded polyline** (precision 5; the OSRM and Google
 *    Directions APIs both return this when `geometries=polyline`).
 *    The format uses signed deltas per 5-bit chunk; see
 *    https://developers.google.com/maps/documentation/utilities/polylinealgorithm
 *
 * 2. **Mock format** `lat,lng;lat,lng;...` produced by
 *    `MockRoutingProvider.encodePolyline` — the project's own ad-hoc
 *    encoding for tests and offline mode.
 *
 * Returns an empty array if the string is empty or unrecognised;
 * callers should then fall back to using just the two endpoints.
 */
export function decodePolyline(polyline: string): PolylinePoint[] {
  if (!polyline) return [];

  // Mock format: `lat,lng;lat,lng;...` — semicolon-separated, all
  // entries are plain numbers.
  if (looksLikeMockFormat(polyline)) {
    return polyline
      .split(';')
      .map(seg => seg.trim())
      .filter(Boolean)
      .map(seg => {
        const [latStr, lngStr] = seg.split(',');
        const lat = Number(latStr);
        const lng = Number(lngStr);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        return { lat, lng };
      })
      .filter((p): p is PolylinePoint => p !== null);
  }

  // Google encoded polyline.
  const points: PolylinePoint[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  const len = polyline.length;

  while (index < len) {
    // Decode latitude delta.
    let shift = 0;
    let result = 0;
    let byte: number;
    do {
      if (index >= len) {
        // Truncated polyline; bail rather than emit a partial point.
        return points;
      }
      byte = polyline.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    const dlat = (result & 1) ? ~(result >> 1) : (result >> 1);
    lat += dlat;

    // Decode longitude delta.
    shift = 0;
    result = 0;
    do {
      if (index >= len) {
        return points;
      }
      byte = polyline.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    const dlng = (result & 1) ? ~(result >> 1) : (result >> 1);
    lng += dlng;

    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }

  return points;
}

function looksLikeMockFormat(s: string): boolean {
  // Mock polyline always starts with `-?digit` (lat) followed by `,`.
  // A Google polyline only ever contains the chars 63-127 in its
  // printable form (chars 0x3F '?' through 0x7E '~') and never
  // contains a literal ',' in the encoded portion.
  // So if the string contains a comma, it must be the mock format.
  return s.includes(',');
}

/** Round-trip helper: encode a list of points to a Google polyline. */
export function encodePolylineGoogle(points: PolylinePoint[]): string {
  let prevLat = 0;
  let prevLng = 0;
  let out = '';
  for (const p of points) {
    const lat = Math.round(p.lat * 1e5);
    const lng = Math.round(p.lng * 1e5);
    out += encodeSignedNumber(lat - prevLat);
    out += encodeSignedNumber(lng - prevLng);
    prevLat = lat;
    prevLng = lng;
  }
  return out;
}

function encodeSignedNumber(n: number): string {
  let v = n < 0 ? ~(n << 1) : (n << 1);
  let out = '';
  while (v >= 0x20) {
    out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>= 5;
  }
  out += String.fromCharCode(v + 63);
  return out;
}
