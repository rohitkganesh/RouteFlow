/**
 * Unit tests for RouteCalculationService.
 *
 * Covers:
 *   1. Polyline decoder round-trip (Google encoded format)
 *   2. Polyline decoder handles the project's mock `lat,lng;lat,lng` format
 *   3. Polyline decoder edge cases (empty, malformed, single point)
 *   4. calculateRoute happy path: writes a `routes` row with
 *      distance/duration/polyline, returns the camelCase payload
 *   5. calculateRoute upsert path: a second call for the same order
 *      updates the existing row instead of inserting a duplicate
 *   6. calculateRoute missing coordinates throws ValidationError
 *   7. calculateRoute missing ids throws ValidationError
 *   8. calculateRoute fallback: provider error → haversine straight
 *      line at ~30 km/h urban speed, polyline reduced to two endpoints
 *   9. hydrate: re-runs the decoder on a raw row so legacy rows
 *      (written by `RouteService.optimizeDeliveryRoute`, which doesn't
 *      store polyline_points) still come back as a populated payload
 *
 * Run:
 *   NODE_ENV=test npx tsx test/route-calculation.test.ts
 */
import path from 'path';
import { config as dotenvConfig } from 'dotenv';
dotenvConfig({ path: path.resolve(__dirname, '../.env.test') });

import { knex } from '../src/config/database';
import { RouteCalculationService, decodePolyline, encodePolylineGoogle } from '../src/services/route-calculation.service';
import { ValidationError } from '../src/utils/errors';

let pass = 0;
let fail = 0;

function assert(cond: unknown, msg: string): void {
  if (cond) {
    pass++;
    console.log(`  ✅ ${msg}`);
  } else {
    fail++;
    console.error(`  ❌ ${msg}`);
  }
}

function section(name: string): void {
  console.log(`\n--- ${name} ---`);
}

function approxEq(a: number, b: number, tol: number): boolean {
  return Math.abs(a - b) <= tol;
}

// =====================================================================
// 1. Polyline decoder (Google format)
// =====================================================================
section('decodePolyline — Google encoded format');

const GOOGLE_SAMPLE = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';
const GOOGLE_SAMPLE_PTS = [
  { lat: 38.5, lng: -120.2 },
  { lat: 40.7, lng: -120.95 },
  { lat: 43.252, lng: -126.453 },
];
{
  const got = decodePolyline(GOOGLE_SAMPLE);
  assert(
    JSON.stringify(got) === JSON.stringify(GOOGLE_SAMPLE_PTS),
    `Google sample decodes to 3 known points (got ${JSON.stringify(got)})`
  );
}

// Round-trip a 5-point sequence
{
  const pts = [
    { lat: 27.7172, lng: 85.3240 },
    { lat: 27.7175, lng: 85.3250 },
    { lat: 27.7200, lng: 85.3300 },
    { lat: 27.7300, lng: 85.3400 },
    { lat: 27.7400, lng: 85.3500 },
  ];
  const encoded = encodePolylineGoogle(pts);
  const decoded = decodePolyline(encoded);
  assert(
    JSON.stringify(decoded) === JSON.stringify(pts),
    `round-trip 5 points (encoded length=${encoded.length})`
  );
}

// Negative latitudes / wrap-around
{
  const pts = [
    { lat: 0, lng: 0 },
    { lat: -10, lng: 10 },
    { lat: 10, lng: -10 },
  ];
  const decoded = decodePolyline(encodePolylineGoogle(pts));
  assert(
    JSON.stringify(decoded) === JSON.stringify(pts),
    `round-trip with negative coords + sign flips`
  );
}

section('decodePolyline — project mock format');

// Mock format = `lat,lng;lat,lng;...`
{
  const got = decodePolyline('27.717200,85.324000;27.717500,85.325000');
  assert(got.length === 2, 'mock format: 2 points');
  assert(approxEq(got[0].lat, 27.7172, 1e-6), 'mock format: lat[0]');
  assert(approxEq(got[0].lng, 85.324, 1e-6), 'mock format: lng[0]');
  assert(approxEq(got[1].lat, 27.7175, 1e-6), 'mock format: lat[1]');
  assert(approxEq(got[1].lng, 85.325, 1e-6), 'mock format: lng[1]');
}

section('decodePolyline — edge cases');

{
  assert(decodePolyline('').length === 0, 'empty string → []');
  // A single `lat,lng` (no `;`) should still decode one point.
  const got = decodePolyline('27.7172,85.324');
  assert(got.length === 1 && got[0].lat === 27.7172, 'single-segment mock still decodes');
  // Garbage that isn't a comma list and isn't a valid Google polyline:
  // the decoder must not throw, even on pathological input.
  let threw = false;
  try { decodePolyline('!!!@@@###'); } catch { threw = true; }
  assert(!threw, 'garbage input does not throw');
  // Whitespace and partial inputs also must not throw. The exact
  // output isn't important — what matters is that we don't crash a
  // page render with an unhandled exception.
  try { decodePolyline('   '); decodePolyline(','); decodePolyline(';'); } catch { threw = true; }
  assert(!threw, 'whitespace / partial inputs do not throw');
}

// =====================================================================
// 2. calculateRoute — happy path
// =====================================================================
section('calculateRoute — happy path writes a routes row');

async function setupWorld() {
  // Wipe everything to start from a known state. Order: children first
  // to satisfy FK constraints.
  await knex('order_status_history').del();
  await knex('tasks').del();
  await knex('order_items').del();
  await knex('routes').del();
  await knex('routes_typed').del();
  await knex('orders').del();
  await knex('refresh_tokens').del();
  await knex('drivers').del();
  await knex('sellers').del();
  await knex('users').del();

  // Minimal seller + driver — we only need valid foreign keys for the
  // route row. We don't go through the OrderService typed-creation
  // path because that would also create a `routes_typed` row we don't
  // need here.
  //
  // NOTE: orders.seller_id is a FK to users.id (not sellers.id) per
  // the initial schema. We still create a sellers row so the typed
  // routes (out of scope for these tests) can pick it up later, but
  // for the orders insert we use the user id directly.
  const sellerUserId = (await knex('users')
    .insert({ email: 's@x.com', password_hash: 'x', role: 'seller' })
    .returning('id'))[0].id;
  await knex('sellers').insert({ user_id: sellerUserId, business_name: 'T', business_type: 'retail', status: 'active' });
  const driverUserId = (await knex('users')
    .insert({ email: 'd@x.com', password_hash: 'x', role: 'driver' })
    .returning('id'))[0].id;
  const driver = (await knex('drivers')
    .insert({ user_id: driverUserId, current_latitude: 0, current_longitude: 0, availability_status: 'available', current_workload: 0 })
    .returning('*'))[0];

  const order = (await knex('orders')
    .insert({
      seller_id: sellerUserId,
      driver_id: driver.id,
      status: 'assigned',
      customer_name: 'Test',
      customer_phone: '+10000000000',
      delivery_address: { street: 'dest', city: 'KTM', state: 'Bagmati', country: 'NP' },
      pickup_address: { street: 'origin', city: 'KTM', state: 'Bagmati', country: 'NP' },
      latitude: 27.7172,
      longitude: 85.324,
      delivery_latitude: 27.7400,
      delivery_longitude: 85.350,
      pickup_latitude: 27.7172,
      pickup_longitude: 85.324,
      total_weight: 1,
      total_volume: 0.01,
      total_amount: 100,
      payment_status: 'PENDING',
      payment_method: 'CASH',
    })
    .returning('*'))[0];

  return { sellerUserId, driver, order };
}

async function testHappyPath() {
  const { driver, order } = await setupWorld();
  const origin = { latitude: 27.7172, longitude: 85.324 };
  const destination = { latitude: 27.7400, longitude: 85.350 };

  const r = await RouteCalculationService.calculateRoute({
    orderId: order.id,
    driverId: driver.id,
    origin,
    destination,
  });

  assert(typeof r.id === 'string' && r.id.length > 0, 'returns a UUID id');
  assert(r.orderId === order.id, 'orderId echoed back');
  assert(r.driverId === driver.id, 'driverId echoed back');
  assert(r.distance > 0, `distance > 0 (got ${r.distance} m)`);
  // ~3 km between these two points (Kathmandu east a few km). Mock
  // gives straight-line haversine, which is ~2.7–3.0 km for these
  // coords. Allow a generous tolerance.
  assert(
    r.distance > 2000 && r.distance < 4000,
    `distance is ~3 km (got ${r.distance} m)`
  );
  assert(r.durationSeconds > 0, `durationSeconds > 0 (got ${r.durationSeconds} s)`);
  assert(
    r.etaMinutes > 0 && r.etaMinutes < 60,
    `etaMinutes is sensible (got ${r.etaMinutes} min)`
  );
  assert(r.polyline.length > 0, 'polyline string non-empty');
  assert(
    Array.isArray(r.polylinePoints) && r.polylinePoints.length >= 2,
    `polylinePoints has >= 2 points (got ${r.polylinePoints.length})`
  );
  assert(r.status === 'planned', `status is 'planned' (got ${r.status})`);
  assert(r.createdAt instanceof Date, 'createdAt is a Date');

  // Verify the DB row is what we asked for
  const row = await knex('routes').where({ id: r.id }).first();
  assert(row !== undefined, 'routes row exists in DB');
  assert(row.order_id === order.id, 'DB row order_id matches');
  assert(Number(row.estimated_distance) === r.distance, 'DB distance matches payload');
  assert(row.estimated_travel_time === r.durationSeconds, 'DB travel_time matches payload');
  assert(row.optimized_polyline === r.polyline, 'DB polyline matches payload');
  assert(row.status === 'planned', 'DB status is planned');
}

// =====================================================================
// 3. calculateRoute — upsert path
// =====================================================================
section('calculateRoute — upserts on existing route row');

async function testUpsert() {
  const { driver, order } = await setupWorld();
  const origin = { latitude: 27.7172, longitude: 85.324 };
  const destination = { latitude: 27.7400, longitude: 85.350 };

  const r1 = await RouteCalculationService.calculateRoute({
    orderId: order.id, driverId: driver.id, origin, destination,
  });
  const r2 = await RouteCalculationService.calculateRoute({
    orderId: order.id, driverId: driver.id, origin, destination,
  });

  assert(r1.id === r2.id, 'second call returns the same routes.id (upsert, not insert)');
  // The table has a UNIQUE constraint on order_id, so without upsert
  // the second call would throw a constraint-violation. We assert
  // there's still exactly one row.
  const count = await knex('routes').where({ order_id: order.id }).count('* as c').first();
  assert(Number(count?.c) === 1, `only 1 routes row for this order (got ${count?.c})`);
}

// =====================================================================
// 4. calculateRoute — missing coords throws
// =====================================================================
section('calculateRoute — validation errors');

async function testValidation() {
  const { driver, order } = await setupWorld();

  let threw = false;
  try {
    await RouteCalculationService.calculateRoute({
      orderId: '', driverId: driver.id,
      origin: { latitude: 0, longitude: 0 },
      destination: { latitude: 0, longitude: 0 },
    });
  } catch (e) {
    threw = e instanceof ValidationError;
  }
  assert(threw, 'empty orderId throws ValidationError');

  threw = false;
  try {
    await RouteCalculationService.calculateRoute({
      orderId: order.id, driverId: '',
      origin: { latitude: 0, longitude: 0 },
      destination: { latitude: 0, longitude: 0 },
    });
  } catch (e) {
    threw = e instanceof ValidationError;
  }
  assert(threw, 'empty driverId throws ValidationError');

  threw = false;
  try {
    // Out-of-range latitude. The (0,0) sentinel-rejection is handled
    // by the order.service caller; here the service itself just
    // validates the coord shape.
    await RouteCalculationService.calculateRoute({
      orderId: order.id, driverId: driver.id,
      origin: { latitude: 95, longitude: 0 } as unknown as { latitude: number; longitude: number },
      destination: { latitude: 0, longitude: 0 },
    });
  } catch (e) {
    threw = e instanceof ValidationError;
  }
  assert(threw, 'out-of-range origin throws ValidationError');

  threw = false;
  try {
    await RouteCalculationService.calculateRoute({
      orderId: order.id, driverId: driver.id,
      origin: { latitude: 27, longitude: 85 },
      destination: null as unknown as { latitude: number; longitude: number },
    });
  } catch (e) {
    threw = e instanceof ValidationError;
  }
  assert(threw, 'null destination throws ValidationError');
}

// =====================================================================
// 5. calculateRoute — provider failure → haversine fallback
// =====================================================================
section('calculateRoute — fallback when routing provider throws');

async function testFallback() {
  const { driver, order } = await setupWorld();
  // Monkey-patch routingService.getRoute to throw, simulating OSRM
  // or Google Maps being unreachable. The service should swallow
  // this and fall back to haversine@30km/h.
  const routingMod = await import('../src/services/routing.service');
  const original = routingMod.routingService.getRoute.bind(routingMod.routingService);
  (routingMod.routingService as any).getRoute = async () => {
    throw new Error('synthetic network failure');
  };

  try {
    const r = await RouteCalculationService.calculateRoute({
      orderId: order.id,
      driverId: driver.id,
      origin: { latitude: 27.7172, longitude: 85.324 },
      destination: { latitude: 27.7400, longitude: 85.350 },
    });

    assert(r.distance > 0, `fallback distance > 0 (got ${r.distance} m)`);
    assert(r.durationSeconds > 0, `fallback duration > 0 (got ${r.durationSeconds} s)`);
    // 30 km/h ≈ 8.333 m/s. distance / 8.333 ≈ duration. So the
    // duration is just the distance in meters divided by 8.333. For
    // ~3 km that's ~360 s. The mock polyline fallback is a 2-point
    // string with the two endpoints.
    assert(
      r.polylinePoints.length === 2,
      `fallback polyline reduced to 2 endpoints (got ${r.polylinePoints.length})`
    );
    assert(r.polyline.includes(';'), 'fallback polyline uses mock format with `;`');

    // Verify the row was actually written
    const row = await knex('routes').where({ order_id: order.id }).first();
    assert(row !== undefined, 'fallback path still writes a routes row');
  } finally {
    (routingMod.routingService as any).getRoute = original;
  }
}

// =====================================================================
// 6. hydrate — re-decodes the polyline for legacy rows
// =====================================================================
section('hydrate — re-decodes polyline for legacy rows');

async function testHydrate() {
  const { driver, order } = await setupWorld();
  // Write a row directly with an encoded polyline and no polyline_points
  // — this mimics what `RouteService.optimizeDeliveryRoute` produces.
  const polyline = encodePolylineGoogle([
    { lat: 27.7172, lng: 85.324 },
    { lat: 27.7300, lng: 85.340 },
    { lat: 27.7400, lng: 85.350 },
  ]);
  const [row] = await knex('routes')
    .insert({
      order_id: order.id,
      driver_id: driver.id,
      optimized_polyline: polyline,
      estimated_travel_time: 360,
      estimated_distance: 3000,
      status: 'planned',
    })
    .returning('*');

  const h = RouteCalculationService.hydrate(row);
  assert(h.id === row.id, 'hydrate: id matches');
  assert(h.distance === 3000, 'hydrate: distance matches');
  assert(h.durationSeconds === 360, 'hydrate: durationSeconds matches');
  assert(h.etaMinutes === 6, 'hydrate: etaMinutes = 360/60 = 6');
  assert(h.polylinePoints.length === 3, 'hydrate: decoded 3 points from encoded polyline');
  assert(approxEq(h.polylinePoints[0].lat, 27.7172, 1e-4), 'hydrate: lat[0]');
  assert(approxEq(h.polylinePoints[2].lng, 85.350, 1e-4), 'hydrate: lng[2]');
}

// =====================================================================
// Summary
// =====================================================================
(async () => {
  await knex.migrate.latest();
  try {
    await testHappyPath();
    await testUpsert();
    await testValidation();
    await testFallback();
    await testHydrate();
    console.log(`\n========================================`);
    console.log(`  ${pass} passed, ${fail} failed`);
    console.log(`========================================`);
    if (fail > 0) process.exit(1);
  } catch (e) {
    console.error('💥 test threw:', e);
    process.exitCode = 1;
  } finally {
    await knex.destroy();
  }
})();
