/**
 * Tests for the GeofenceService auto-delivery flow.
 *
 * Runs as a plain Node script (no Jest) — matches the rest of test/.
 *
 * Tests:
 *   1. In range + `on_the_way` → auto-delivered.
 *   2. Out of range + `on_the_way` → still `on_the_way`.
 *   3. In range + `picked_up` → not auto-delivered (status filter).
 *   4. Two `on_the_way` orders, only the in-range one is delivered.
 *   5. Idempotency: a second location update at the same point does
 *      not duplicate the `delivered` row in `order_status_history`.
 *   6. Env var = 0 disables the geofence entirely.
 *
 * Run: NODE_ENV=test node --import \
 *   "file:///C:/Users/rohit/Downloads/routeflow/node_modules/tsx/dist/loader.mjs" \
 *   test/geofence.test.ts
 */
import path from 'path';
import { config as dotenvConfig } from 'dotenv';
dotenvConfig({ path: path.resolve(__dirname, '../.env.test') });

import { knex } from '../src/config/database';
import { DriverService } from '../src/services/driver.service';
import { config } from '../src/config/env';
import { encryptObject } from '../src/config/encryption';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error('❌', msg);
    process.exit(1);
  }
  console.log('✅', msg);
}

/**
 * Compute a lat/lng approximately N meters east of a base point.
 * 1° of latitude ≈ 111_320 m; 1° of longitude at lat L ≈ 111_320 *
 * cos(L) m. We use this to place points at known distances without
 * having to compute haversine manually in every test.
 */
function offsetMeters(
  base: { lat: number; lng: number },
  eastMeters: number,
  northMeters: number
): { lat: number; lng: number } {
  const newLat = base.lat + northMeters / 111_320;
  const newLng = base.lng + eastMeters / (111_320 * Math.cos((base.lat * Math.PI) / 180));
  return { lat: newLat, lng: newLng };
}

async function makeUser(email: string, role: 'driver' | 'seller' | 'admin'): Promise<string> {
  const [u] = await knex('users')
    .insert({
      email,
      password_hash: 'x',
      role,
      profile_details: encryptObject({ firstName: email.split('@')[0] }),
    })
    .returning('id');
  return u.id as string;
}

async function makeDriver(
  userId: string,
  lat: number,
  lng: number
): Promise<string> {
  const [d] = await knex('drivers')
    .insert({
      user_id: userId,
      current_latitude: lat,
      current_longitude: lng,
      availability_status: 'available',
      current_workload: 0,
    })
    .returning('id');
  return d.id as string;
}

async function makeOrder(
  sellerId: string,
  driverId: string,
  delivery: { lat: number; lng: number },
  status: 'pending' | 'assigned' | 'picked_up' | 'on_the_way' = 'on_the_way'
): Promise<string> {
  const [o] = await knex('orders')
    .insert({
      seller_id: sellerId,
      driver_id: driverId,
      customer_name: 'Test',
      customer_phone: '+10000000000',
      delivery_address: 'Test',
      latitude: delivery.lat,
      longitude: delivery.lng,
      delivery_latitude: delivery.lat,
      delivery_longitude: delivery.lng,
      parcel_details: encryptObject({ weight: 1 }),
      status,
    })
    .returning('id');
  return o.id as string;
}

async function getOrderStatus(orderId: string): Promise<string> {
  const row = await knex('orders').select('status').where({ id: orderId }).first();
  return row?.status as string;
}

async function countHistoryRows(orderId: string, status: string): Promise<number> {
  const row = await knex('order_status_history')
    .where({ order_id: orderId, status })
    .count('* as count')
    .first();
  return Number(row?.count ?? 0);
}

async function resetState() {
  await knex('order_status_history').del();
  await knex('routes').del();
  await knex('orders').del();
  await knex('drivers').del();
  await knex('users').del();
}

// ============================================================
// 1. In range + on_the_way → auto-delivered
// ============================================================
async function test1InRangeDelivers() {
  console.log('\n=== Test 1: in-range on_the_way → auto-delivered ===');
  await resetState();

  const sellerId = await makeUser('seller1@test.com', 'seller');
  const driverUserId = await makeUser('driver1@test.com', 'driver');
  const driverPk = await makeDriver(driverUserId, 40.75, -74.0);

  const deliveryPoint = { lat: 40.76, lng: -74.0 };
  const orderId = await makeOrder(sellerId, driverPk, deliveryPoint, 'on_the_way');

  // Driver pushes a location 20m east of the delivery point —
  // well within the 50m default radius.
  const driverLoc = offsetMeters(deliveryPoint, 20, 0);
  await DriverService.updateDriverLocation(driverUserId, {
    latitude: driverLoc.lat,
    longitude: driverLoc.lng,
  });

  // Give the fire-and-forget geofence check a moment to run.
  await new Promise((r) => setTimeout(r, 100));

  const status = await getOrderStatus(orderId);
  assert(status === 'delivered', `order is now 'delivered' (was: ${status})`);

  const historyRows = await countHistoryRows(orderId, 'delivered');
  assert(historyRows === 1, `order_status_history has exactly 1 'delivered' row (got: ${historyRows})`);
}

// ============================================================
// 2. Out of range + on_the_way → still on_the_way
// ============================================================
async function test2OutOfRangeDoesNotDeliver() {
  console.log('\n=== Test 2: out-of-range on_the_way → still on_the_way ===');
  await resetState();

  const sellerId = await makeUser('seller2@test.com', 'seller');
  const driverUserId = await makeUser('driver2@test.com', 'driver');
  const driverPk = await makeDriver(driverUserId, 40.75, -74.0);

  const deliveryPoint = { lat: 40.76, lng: -74.0 };
  const orderId = await makeOrder(sellerId, driverPk, deliveryPoint, 'on_the_way');

  // Driver is 1 km away — way outside the 50m default radius.
  const driverLoc = offsetMeters(deliveryPoint, 1000, 0);
  await DriverService.updateDriverLocation(driverUserId, {
    latitude: driverLoc.lat,
    longitude: driverLoc.lng,
  });

  await new Promise((r) => setTimeout(r, 100));

  const status = await getOrderStatus(orderId);
  assert(status === 'on_the_way', `order remains 'on_the_way' (got: ${status})`);

  const historyRows = await countHistoryRows(orderId, 'delivered');
  assert(historyRows === 0, `no 'delivered' history row written (got: ${historyRows})`);
}

// ============================================================
// 3. In range but picked_up → not auto-delivered
// ============================================================
async function test3PickedUpNotDelivered() {
  console.log('\n=== Test 3: in-range but picked_up → not auto-delivered ===');
  await resetState();

  const sellerId = await makeUser('seller3@test.com', 'seller');
  const driverUserId = await makeUser('driver3@test.com', 'driver');
  const driverPk = await makeDriver(driverUserId, 40.75, -74.0);

  const deliveryPoint = { lat: 40.76, lng: -74.0 };
  const orderId = await makeOrder(sellerId, driverPk, deliveryPoint, 'picked_up');

  // Driver is right on top of the delivery point.
  const driverLoc = offsetMeters(deliveryPoint, 0, 0);
  await DriverService.updateDriverLocation(driverUserId, {
    latitude: driverLoc.lat,
    longitude: driverLoc.lng,
  });

  await new Promise((r) => setTimeout(r, 100));

  const status = await getOrderStatus(orderId);
  assert(
    status === 'picked_up',
    `order remains 'picked_up' (geofence only fires for 'on_the_way'; got: ${status})`
  );
}

// ============================================================
// 4. Two on_the_way orders, only the in-range one delivers
// ============================================================
async function test4OnlyOneOfTwoDelivers() {
  console.log('\n=== Test 4: two on_the_way orders, only the in-range one delivers ===');
  await resetState();

  const sellerId = await makeUser('seller4@test.com', 'seller');
  const driverUserId = await makeUser('driver4@test.com', 'driver');
  const driverPk = await makeDriver(driverUserId, 40.75, -74.0);

  const nearDelivery = { lat: 40.76, lng: -74.0 };
  // farDelivery is ~5 km away from the driver's position.
  const farDelivery = { lat: 40.81, lng: -74.0 };
  const nearOrderId = await makeOrder(sellerId, driverPk, nearDelivery, 'on_the_way');
  const farOrderId = await makeOrder(sellerId, driverPk, farDelivery, 'on_the_way');

  // Push a location near `nearDelivery` (within 50m), far from `farDelivery`.
  const driverLoc = offsetMeters(nearDelivery, 10, 0);
  await DriverService.updateDriverLocation(driverUserId, {
    latitude: driverLoc.lat,
    longitude: driverLoc.lng,
  });

  await new Promise((r) => setTimeout(r, 100));

  const nearStatus = await getOrderStatus(nearOrderId);
  const farStatus = await getOrderStatus(farOrderId);
  assert(nearStatus === 'delivered', `near order is 'delivered' (got: ${nearStatus})`);
  assert(farStatus === 'on_the_way', `far order is still 'on_the_way' (got: ${farStatus})`);
}

// ============================================================
// 5. Idempotency: second location update does not duplicate
// ============================================================
async function test5Idempotent() {
  console.log('\n=== Test 5: idempotency — second update at same point ===');
  await resetState();

  const sellerId = await makeUser('seller5@test.com', 'seller');
  const driverUserId = await makeUser('driver5@test.com', 'driver');
  const driverPk = await makeDriver(driverUserId, 40.75, -74.0);

  const deliveryPoint = { lat: 40.76, lng: -74.0 };
  const orderId = await makeOrder(sellerId, driverPk, deliveryPoint, 'on_the_way');

  const driverLoc = offsetMeters(deliveryPoint, 10, 0);
  const update = () => DriverService.updateDriverLocation(driverUserId, {
    latitude: driverLoc.lat,
    longitude: driverLoc.lng,
  });

  // First push — should deliver.
  await update();
  await new Promise((r) => setTimeout(r, 100));
  const status1 = await getOrderStatus(orderId);
  assert(status1 === 'delivered', `first push delivers the order (got: ${status1})`);
  const history1 = await countHistoryRows(orderId, 'delivered');
  assert(history1 === 1, `first push writes 1 'delivered' history row (got: ${history1})`);

  // Second push at the same point — must NOT add another history row
  // (the idempotency guard re-reads the status and skips).
  await update();
  await new Promise((r) => setTimeout(r, 100));
  const status2 = await getOrderStatus(orderId);
  assert(status2 === 'delivered', `second push keeps the order 'delivered' (got: ${status2})`);
  const history2 = await countHistoryRows(orderId, 'delivered');
  assert(
    history2 === 1,
    `second push does NOT add another 'delivered' history row (got: ${history2})`
  );
}

// ============================================================
// 6. Env var = 0 disables the geofence
// ============================================================
async function test6EnvZeroDisables() {
  console.log('\n=== Test 6: env var = 0 disables the geofence ===');
  await resetState();

  const sellerId = await makeUser('seller6@test.com', 'seller');
  const driverUserId = await makeUser('driver6@test.com', 'driver');
  const driverPk = await makeDriver(driverUserId, 40.75, -74.0);

  const deliveryPoint = { lat: 40.76, lng: -74.0 };
  const orderId = await makeOrder(sellerId, driverPk, deliveryPoint, 'on_the_way');

  // Save the original radius and override to 0 (disabled).
  const originalRadius = config.GEOFENCE_DELIVERY_RADIUS_METERS;
  // Mutate the config object — the GeofenceService reads it at
  // call time so this takes effect immediately. We restore at the end.
  // Cast to `any` because `config` is a `Readonly<>` type from zod's
  // `.default()`-typed object; the underlying object IS mutable.
  (config as { GEOFENCE_DELIVERY_RADIUS_METERS: number }).GEOFENCE_DELIVERY_RADIUS_METERS = 0;

  try {
    // Driver pushes a location EXACTLY on the delivery point.
    const driverLoc = offsetMeters(deliveryPoint, 0, 0);
    await DriverService.updateDriverLocation(driverUserId, {
      latitude: driverLoc.lat,
      longitude: driverLoc.lng,
    });
    await new Promise((r) => setTimeout(r, 100));

    const status = await getOrderStatus(orderId);
    assert(
      status === 'on_the_way',
      `with radius=0, order remains 'on_the_way' (got: ${status})`
    );
  } finally {
    (config as { GEOFENCE_DELIVERY_RADIUS_METERS: number }).GEOFENCE_DELIVERY_RADIUS_METERS = originalRadius;
  }
}

(async () => {
  await knex.migrate.latest();
  await resetState();

  try {
    await test1InRangeDelivers();
    await test2OutOfRangeDoesNotDeliver();
    await test3PickedUpNotDelivered();
    await test4OnlyOneOfTwoDelivers();
    await test5Idempotent();
    await test6EnvZeroDisables();
    console.log('\n🎉 All geofence tests passed!');
  } catch (e) {
    console.error('💥 test threw:', e);
    process.exitCode = 1;
  } finally {
    await knex.destroy();
  }
})();
