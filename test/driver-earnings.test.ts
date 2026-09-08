/**
 * Unit tests for DriverEarningsService.
 *
 * The driver's earnings must NOT be the seller's sale
 * (`orders.total_amount`); it must be computed from a base rate
 * plus a per-km rate applied to the route distance. This test
 * exercises:
 *
 *   1. Pure rate math (computeForDistance) — no DB, just the
 *      rate model.
 *   2. `computeForOrder` for a delivered order pulls the
 *      distance from the per-order `routes.estimated_distance`
 *      (the metric `RouteCalculationService` writes when the
 *      driver was assigned).
 *   3. `computeForOrder` for an undelivered order returns 0
 *      (cancelled/in-flight don't pay out).
 *   4. `computeForDriver` over a date range sums correctly and
 *      produces a gap-free daily series.
 *   5. Fallback path: if no `routes` row exists, haversine of
 *      the order's pickup → delivery coords is used.
 *
 * Run:
 *   NODE_ENV=test npx tsx test/driver-earnings.test.ts
 */
import path from 'path';
import { config as dotenvConfig } from 'dotenv';
dotenvConfig({ path: path.resolve(__dirname, '../.env.test') });

import { knex } from '../src/config/database';
import { DriverEarningsService } from '../src/services/driver-earnings.service';
import { config } from '../src/config/env';
import { haversineMeters } from '../src/utils/geo';

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
// 1. Pure rate math — no DB
// =====================================================================
section('computeForDistance — pure rate model');

{
  // 0 m → base only
  assert(
    approxEq(DriverEarningsService.computeForDistance(0), config.DRIVER_BASE_RATE, 0.01),
    `0 m → $${config.DRIVER_BASE_RATE.toFixed(2)} (base only)`
  );
  // 1 km → base + per-km
  const oneKm = DriverEarningsService.computeForDistance(1000);
  const expected = config.DRIVER_BASE_RATE + 1 * config.DRIVER_PER_KM_RATE;
  assert(approxEq(oneKm, expected, 0.01), `1000 m → $${expected.toFixed(2)}`);
  // 10 km
  const tenKm = DriverEarningsService.computeForDistance(10000);
  const expected10 = config.DRIVER_BASE_RATE + 10 * config.DRIVER_PER_KM_RATE;
  assert(approxEq(tenKm, expected10, 0.01), `10 km → $${expected10.toFixed(2)}`);
  // Negative distance clamps to 0
  assert(
    approxEq(DriverEarningsService.computeForDistance(-100), config.DRIVER_BASE_RATE, 0.01),
    'negative distance clamps to 0 → base only'
  );
}

// =====================================================================
// Setup helpers
// =====================================================================
async function setupWorld() {
  // Wipe everything. Order: children first to satisfy FK constraints.
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

  return { sellerUserId, driver, driverUserId };
}

async function makeOrder(opts: {
  driverId: string;
  sellerUserId: string;
  status: 'delivered' | 'assigned' | 'cancelled' | 'pending';
  distanceMeters?: number | null;
  pickupLat?: number;
  pickupLng?: number;
  deliveryLat?: number;
  deliveryLng?: number;
  createdAt?: Date;
}) {
  const {
    driverId, sellerUserId, status,
    distanceMeters = 5000,
    pickupLat = 27.7172, pickupLng = 85.324,
    deliveryLat = 27.7400, deliveryLng = 85.350,
    createdAt = new Date(),
  } = opts;
  const [order] = await knex('orders')
    .insert({
      seller_id: sellerUserId,
      driver_id: driverId,
      status,
      customer_name: 'Test',
      customer_phone: '+10000000000',
      delivery_address: { street: 'dest', city: 'KTM', state: 'Bagmati', country: 'NP' },
      pickup_address: { street: 'origin', city: 'KTM', state: 'Bagmati', country: 'NP' },
      latitude: deliveryLat,
      longitude: deliveryLng,
      delivery_latitude: deliveryLat,
      delivery_longitude: deliveryLng,
      pickup_latitude: pickupLat,
      pickup_longitude: pickupLng,
      total_weight: 1,
      total_volume: 0.01,
      // IMPORTANT: total_amount is the SELLER's sale, not the driver's earning.
      // The driver earning test should *not* depend on this value.
      total_amount: 999.99,
      payment_status: 'PENDING',
      payment_method: 'CASH',
      created_at: createdAt,
      updated_at: createdAt,
    })
    .returning('*');

  if (distanceMeters != null && distanceMeters > 0) {
    await knex('routes').insert({
      order_id: order.id,
      driver_id: driverId,
      optimized_polyline: 'mock',
      estimated_travel_time: Math.round(distanceMeters / 8.33),
      estimated_distance: distanceMeters,
      status: 'planned',
    });
  }

  return order;
}

// =====================================================================
// 2. computeForOrder — happy path uses routes.estimated_distance
// =====================================================================
section('computeForOrder — uses routes.estimated_distance');

async function testHappyPath() {
  const { driver, sellerUserId } = await setupWorld();
  const order = await makeOrder({
    driverId: driver.id,
    sellerUserId,
    status: 'delivered',
    distanceMeters: 5000, // 5 km
  });

  const earning = await DriverEarningsService.computeForOrder(order.id);
  const expected = config.DRIVER_BASE_RATE + 5 * config.DRIVER_PER_KM_RATE;
  assert(approxEq(earning, expected, 0.01), `5 km delivered → $${expected.toFixed(2)} (got $${earning.toFixed(2)})`);

  // The earning must NOT equal orders.total_amount. This is the
  // exact regression the user reported — if a future refactor
  // accidentally falls back to the order total, this test fails.
  assert(
    earning !== Number(order.total_amount),
    `earning ($${earning.toFixed(2)}) is NOT the order total ($${Number(order.total_amount).toFixed(2)})`
  );
}

// =====================================================================
// 3. computeForOrder — undelivered orders don't pay out
// =====================================================================
section('computeForOrder — undelivered orders return 0');

async function testUndelivered() {
  const { driver, sellerUserId } = await setupWorld();
  for (const status of ['assigned', 'cancelled', 'pending'] as const) {
    const order = await makeOrder({
      driverId: driver.id,
      sellerUserId,
      status,
      distanceMeters: 5000,
    });
    const earning = await DriverEarningsService.computeForOrder(order.id);
    assert(earning === 0, `status=${status} → $0 (got $${earning.toFixed(2)})`);
  }
}

// =====================================================================
// 4. computeForDriver — sums correctly + fills the daily series
// =====================================================================
section('computeForDriver — sums across orders, fills daily series');

async function testDriverTotals() {
  const { driver, sellerUserId } = await setupWorld();
  const today = new Date();
  // Two delivered orders: 5 km and 12 km, both today.
  await makeOrder({
    driverId: driver.id, sellerUserId, status: 'delivered',
    distanceMeters: 5000, createdAt: today,
  });
  await makeOrder({
    driverId: driver.id, sellerUserId, status: 'delivered',
    distanceMeters: 12000, createdAt: today,
  });
  // One cancelled order — must NOT contribute.
  await makeOrder({
    driverId: driver.id, sellerUserId, status: 'cancelled',
    distanceMeters: 99999, createdAt: today,
  });

  const start = new Date(today);
  start.setDate(start.getDate() - 1);
  start.setHours(0, 0, 0, 0);
  const end = new Date(today);
  end.setHours(23, 59, 59, 999);

  const result = await DriverEarningsService.computeForDriver(driver.id, start, end);
  const expectedPerOrder1 = config.DRIVER_BASE_RATE + 5 * config.DRIVER_PER_KM_RATE;
  const expectedPerOrder2 = config.DRIVER_BASE_RATE + 12 * config.DRIVER_PER_KM_RATE;
  const expectedTotal = expectedPerOrder1 + expectedPerOrder2;

  assert(
    approxEq(result.breakdown.totalEarnings, expectedTotal, 0.05),
    `breakdown.totalEarnings ≈ $${expectedTotal.toFixed(2)} (got $${result.breakdown.totalEarnings.toFixed(2)})`
  );
  assert(
    result.breakdown.orderCount === 2,
    `breakdown.orderCount === 2 (got ${result.breakdown.orderCount})`
  );
  assert(
    approxEq(result.breakdown.totalDistanceKm, 17, 0.05),
    `breakdown.totalDistanceKm ≈ 17 km (got ${result.breakdown.totalDistanceKm})`
  );
  assert(result.breakdown.baseRate === config.DRIVER_BASE_RATE, 'breakdown.baseRate echoes env');
  assert(result.breakdown.perKmRate === config.DRIVER_PER_KM_RATE, 'breakdown.perKmRate echoes env');

  // Daily series: at least 2 entries (one per day in range); today's
  // value should equal expectedTotal.
  const todayKey = today.toISOString().split('T')[0];
  const todayEntry = result.daily.find((d) => d.date === todayKey);
  assert(todayEntry !== undefined, `daily series has entry for today (${todayKey})`);
  assert(
    todayEntry && approxEq(todayEntry.value, expectedTotal, 0.05),
    `today's daily value ≈ $${expectedTotal.toFixed(2)} (got $${todayEntry?.value.toFixed(2)})`
  );
}

// =====================================================================
// 5. Fallback — haversine when no routes row exists
// =====================================================================
section('computeForOrder — haversine fallback when no routes row');

async function testFallback() {
  const { driver, sellerUserId } = await setupWorld();
  // Distance null → service should fall back to haversine of
  // pickup (27.7172, 85.324) → delivery (27.7400, 85.350).
  // The service applies the ROAD_DISTANCE_FACTOR (1.25) to the
  // straight-line distance, so we compute the expected earning
  // from the exact haversine × factor rather than a hardcoded
  // estimate.
  const order = await makeOrder({
    driverId: driver.id, sellerUserId, status: 'delivered',
    distanceMeters: null,
    pickupLat: 27.7172, pickupLng: 85.324,
    deliveryLat: 27.7400, deliveryLng: 85.350,
  });
  const earning = await DriverEarningsService.computeForOrder(order.id);
  // Mirror the service: haversine × ROAD_DISTANCE_FACTOR, then rate-model.
  const rawMeters = haversineMeters(
    { latitude: 27.7172, longitude: 85.324 },
    { latitude: 27.7400, longitude: 85.350 },
  )!;
  const expectedMeters = Math.round(rawMeters * config.ROUTING_ROAD_DISTANCE_FACTOR);
  const expectedKm = expectedMeters / 1000;
  const expected = config.DRIVER_BASE_RATE + expectedKm * config.DRIVER_PER_KM_RATE;
  assert(
    approxEq(earning, expected, 0.01),
    `fallback: haversine(${rawMeters.toFixed(0)}m) × ${config.ROUTING_ROAD_DISTANCE_FACTOR} → ${expectedMeters}m → $${expected.toFixed(2)} (got $${earning.toFixed(2)})`
  );
}

// =====================================================================
// Summary
// =====================================================================
(async () => {
  await knex.migrate.latest();
  try {
    await testHappyPath();
    await testUndelivered();
    await testDriverTotals();
    await testFallback();
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
