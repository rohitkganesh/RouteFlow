/**
 * Geospatial utilities.
 *
 * Centralised so multiple features (routing provider, geofence, future
 * "find nearest driver" work) all use the same arithmetic. Anything
 * new that needs to compute a distance between two lat/lng points
 * should call {@link haversineMeters} rather than re-implement the
 * formula.
 *
 * Behavioural contract for {@link haversineMeters}:
 *   - Returns a finite number in meters, always ≥ 0.
 *   - Returns `null` (NOT NaN) when either input is missing, non-finite,
 *     or out of the valid lat/lng range. Callers can then treat
 *     "missing coordinate" as "can't compute" without poisoning
 *     downstream comparisons (e.g. `NaN > x` is `false`, which would
 *     otherwise silently bypass geofence range checks).
 *   - Identical inputs return 0.
 *   - Symmetric: `d(a, b) === d(b, a)`.
 */

export interface LatLng {
  latitude: number;
  longitude: number;
}

const EARTH_RADIUS_METERS = 6_371_000;

/** Latitude range in degrees. Latitudes outside this are unphysical. */
const MIN_LAT = -90;
const MAX_LAT = 90;
/** Longitude range in degrees. The antimeridian is ±180 inclusive. */
const MIN_LNG = -180;
const MAX_LNG = 180;

/**
 * Read a lat/lng value from a point-like input, returning a finite
 * number in valid degree range or `null`. Handles three input shapes
 * gracefully:
 *   - number → returned if finite and in range
 *   - string → coerced via `Number(...)` (Postgres NUMERIC columns
 *     surface as strings; see driver.service / order.service where
 *     `current_latitude` arrives as "27.7172")
 *   - null / undefined / NaN / out-of-range → null
 */
function toValidDegree(v: unknown, min: number, max: number): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  if (n < min || n > max) return null;
  return n;
}

/**
 * Validate a point: both lat and lng must be present, finite, and in
 * range. Returns the normalized `LatLng` (numbers, not strings) or
 * `null` if invalid.
 */
function normalizePoint(p: LatLng | null | undefined): LatLng | null {
  if (!p) return null;
  const lat = toValidDegree(p.latitude, MIN_LAT, MAX_LAT);
  const lng = toValidDegree(p.longitude, MIN_LNG, MAX_LNG);
  if (lat == null || lng == null) return null;
  return { latitude: lat, longitude: lng };
}

/**
 * Great-circle distance between two points in meters (Haversine
 * formula). Treats the Earth as a sphere — at the distances this app
 * cares about (intra-city), the error vs. an ellipsoid model is
 * negligible (~0.5%).
 *
 * @param a First point (latitude / longitude in decimal degrees).
 * @param b Second point.
 * @returns Distance in meters, always ≥ 0, or `null` if either
 *   point has missing/non-finite/out-of-range coordinates. Callers
 *   MUST handle `null` (treat as "distance unknown" — don't fall
 *   through to a comparison that would evaluate `NaN > x` as
 *   `false` and silently bypass a range check).
 */
export function haversineMeters(a: LatLng, b: LatLng): number | null {
  const pa = normalizePoint(a);
  const pb = normalizePoint(b);
  if (!pa || !pb) return null;

  const φ1 = (pa.latitude * Math.PI) / 180;
  const φ2 = (pb.latitude * Math.PI) / 180;
  const Δφ = ((pb.latitude - pa.latitude) * Math.PI) / 180;
  const Δλ = ((pb.longitude - pa.longitude) * Math.PI) / 180;

  const sinHalfΔφ = Math.sin(Δφ / 2);
  const sinHalfΔλ = Math.sin(Δλ / 2);
  const aHarv =
    sinHalfΔφ * sinHalfΔφ +
    Math.cos(φ1) * Math.cos(φ2) * sinHalfΔλ * sinHalfΔλ;
  // Floating-point error can push aHarv slightly above 1 even for
  // antipodal points; clamp before the sqrt.
  const clampedA = Math.min(1, Math.max(0, aHarv));
  const c = 2 * Math.atan2(Math.sqrt(clampedA), Math.sqrt(1 - clampedA));

  return EARTH_RADIUS_METERS * c;
}
