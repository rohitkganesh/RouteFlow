/**
 * Unit tests for the AutoAssignService matching algorithm.
 *
 * The algorithm is supposed to:
 *   1. Skip drivers whose availability != 'available'
 *   2. Skip drivers outside the search radius
 *   3. Skip drivers whose workload has hit MAX_DRIVER_WORKLOAD
 *   4. Among remaining drivers, prefer the one with the lowest
 *      `distance_km + (WORKLOAD_PENALTY * workload)` score
 *
 * These tests are pure-Node script style (matching the rest of test/).
 * They require NODE_ENV=test so the test DB is used.
 */
import { knex } from '../src/config/database';
import { AutoAssignService } from '../src/services/auto-assign.service';
import { encryptObject } from '../src/config/encryption';

const PICKUP_LAT = 40.7128;
const PICKUP_LNG = -74.006;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error('❌', msg);
    process.exit(1);
  }
  console.log('✅', msg);
}

async function makeUser(email: string, role: 'driver' | 'seller' | 'admin'): Promise<string> {
  const [u] = await knex('users')
    .insert({
      email,
      password_hash: 'x',
      role,
      profile_details: encryptObject({ firstName: email.split('@')[0], phone: '+10000000000' }),
    })
    .returning('id');
  return u.id;
}

async function makeDriver(userId: string, lat: number, lng: number, workload: number, status = 'available') {
  await knex('drivers').insert({
    user_id: userId,
    current_latitude: lat,
    current_longitude: lng,
    availability_status: status,
    current_workload: workload,
  });
}

async function makeOrder(sellerId: string, lat: number, lng: number): Promise<string> {
  const [o] = await knex('orders')
    .insert({
      seller_id: sellerId,
      customer_name: 'Test Customer',
      customer_phone: '+10000000000',
      delivery_address: 'Test Address',
      latitude: lat,
      longitude: lng,
      parcel_details: encryptObject({ weight: 1 }),
      status: 'pending',
    })
    .returning('id');
  return o.id;
}

async function test1PicksClosestWhenWorkloadTied() {
  console.log('\n=== Test 1: nearest driver wins when workloads are equal ===');
  // Clean slate
  await knex('order_status_history').del();
  await knex('orders').del();
  await knex('drivers').del();
  await knex('users').del();

  const sellerId = await makeUser('seller@test.com', 'seller');
  const d1 = await makeUser('close@test.com', 'driver');
  const d2 = await makeUser('far@test.com', 'driver');
  // d1 is closer (~1km), d2 is farther (~13km). Both at workload 0.
  await makeDriver(d1, 40.72, -74.0, 0);
  await makeDriver(d2, 40.83, -74.0, 0);
  const orderId = await makeOrder(sellerId, PICKUP_LAT, PICKUP_LNG);

  const result = await AutoAssignService.assignNearest({
    orderId,
    pickupLat: PICKUP_LAT,
    pickupLng: PICKUP_LNG,
    radiusKm: 50,
  });

  assert(result.driver, 'a driver was assigned');
  assert(result.driver!.user_id === d1, 'closest driver (d1) was chosen when workloads tied');
  assert(result.workload === 0, 'workload reported is 0 (pre-increment value)');
  assert(result.driver!.availability_status === 'busy', 'driver flipped to busy');
  assert(result.driver!.current_workload === 1, 'workload incremented to 1');
}

async function test2WorkloadPenaltyBeatsProximity() {
  console.log('\n=== Test 2: lighter workload wins over closer-but-busy driver ===');
  await knex('order_status_history').del();
  await knex('orders').del();
  await knex('drivers').del();
  await knex('users').del();

  const sellerId = await makeUser('seller@test.com', 'seller');
  const closeBusy = await makeUser('close-busy@test.com', 'driver');
  const farFree = await makeUser('far-free@test.com', 'driver');
  // closeBusy is 1km away but at workload 5 (capped). With default MAX=5
  // the where clause `current_workload < maxWorkload` should exclude them.
  await makeDriver(closeBusy, 40.72, -74.0, 5);
  // farFree is 13km away but at workload 0 — should be picked.
  await makeDriver(farFree, 40.83, -74.0, 0);
  const orderId = await makeOrder(sellerId, PICKUP_LAT, PICKUP_LNG);

  const result = await AutoAssignService.assignNearest({
    orderId,
    pickupLat: PICKUP_LAT,
    pickupLng: PICKUP_LNG,
    radiusKm: 50,
  });

  assert(result.driver, 'a driver was assigned');
  assert(result.driver!.user_id === farFree, 'far-but-free driver (farFree) wins over workload-capped close driver');
}

async function test3LowerWorkloadWinsAtSimilarDistance() {
  console.log('\n=== Test 3: at similar distance, lower workload wins ===');
  await knex('order_status_history').del();
  await knex('orders').del();
  await knex('drivers').del();
  await knex('users').del();

  const sellerId = await makeUser('seller@test.com', 'seller');
  const d1 = await makeUser('overloaded@test.com', 'driver');
  const d2 = await makeUser('rested@test.com', 'driver');
  // Both drivers are 5km away. d1 has 4 orders, d2 has 0.
  // Default penalty=2km per workload unit → d1 score = 5 + 8 = 13,
  // d2 score = 5 + 0 = 5. d2 should win.
  await makeDriver(d1, 40.76, -74.0, 4);
  await makeDriver(d2, 40.76, -74.0, 0);
  const orderId = await makeOrder(sellerId, PICKUP_LAT, PICKUP_LNG);

  const result = await AutoAssignService.assignNearest({
    orderId,
    pickupLat: PICKUP_LAT,
    pickupLng: PICKUP_LNG,
    radiusKm: 50,
  });

  assert(result.driver, 'a driver was assigned');
  assert(result.driver!.user_id === d2, 'lower-workload driver (d2) wins at equal distance');
  assert(result.candidates.length === 2, 'both candidates returned in ranked list');
  assert(result.candidates[0].driver.user_id === d2, 'ranked list starts with winner');
  assert(result.candidates[1].driver.user_id === d1, 'ranked list ends with runner-up');
}

async function test4UnavailableDriversSkipped() {
  console.log('\n=== Test 4: busy and offline drivers are skipped ===');
  await knex('order_status_history').del();
  await knex('orders').del();
  await knex('drivers').del();
  await knex('users').del();

  const sellerId = await makeUser('seller@test.com', 'seller');
  const busy = await makeUser('busy@test.com', 'driver');
  const offline = await makeUser('offline@test.com', 'driver');
  const available = await makeUser('available@test.com', 'driver');
  // All at the same location. busy + offline should be excluded by the
  // `where({ availability_status: 'available' })` clause.
  await makeDriver(busy, 40.72, -74.0, 0, 'busy');
  await makeDriver(offline, 40.72, -74.0, 0, 'offline');
  await makeDriver(available, 40.72, -74.0, 0, 'available');
  const orderId = await makeOrder(sellerId, PICKUP_LAT, PICKUP_LNG);

  const result = await AutoAssignService.assignNearest({
    orderId,
    pickupLat: PICKUP_LAT,
    pickupLng: PICKUP_LNG,
    radiusKm: 50,
  });

  assert(result.driver, 'a driver was assigned');
  assert(result.driver!.user_id === available, 'only the available driver was eligible');
}

async function test5NoDriverLeavesOrderPending() {
  console.log('\n=== Test 5: no driver in range → order stays pending ===');
  await knex('order_status_history').del();
  await knex('orders').del();
  await knex('drivers').del();
  await knex('users').del();

  const sellerId = await makeUser('seller@test.com', 'seller');
  const orderId = await makeOrder(sellerId, PICKUP_LAT, PICKUP_LNG);

  const result = await AutoAssignService.assignNearest({
    orderId,
    pickupLat: PICKUP_LAT,
    pickupLng: PICKUP_LNG,
    radiusKm: 1, // tiny radius, no drivers seeded → nothing in range
  });

  assert(result.driver === null, 'no driver returned when pool is empty');
  const order = await knex('orders').where({ id: orderId }).first();
  assert(order.status === 'pending', 'order remains pending');
  assert(order.driver_id === null, 'order has no driver attached');
}

async function test6FreeDriverDecrementsWorkload() {
  console.log('\n=== Test 6: freeDriverForOrder decrements workload and flips status ===');
  await knex('order_status_history').del();
  await knex('orders').del();
  await knex('drivers').del();
  await knex('users').del();

  const sellerId = await makeUser('seller@test.com', 'seller');
  const driverUserId = await makeUser('driver@test.com', 'driver');
  const driverId = (
    await knex('drivers').where({ user_id: driverUserId }).first()
  )?.id;
  // The driver was inserted via makeDriver? No, we never seeded them. Insert here.
  const [d] = await knex('drivers')
    .insert({
      user_id: driverUserId,
      current_latitude: 40.72,
      current_longitude: -74.0,
      availability_status: 'busy',
      current_workload: 3,
    })
    .returning('*');
  const orderId = await makeOrder(sellerId, PICKUP_LAT, PICKUP_LNG);
  await knex('orders').where({ id: orderId }).update({ driver_id: d.id, status: 'assigned' });

  await AutoAssignService.freeDriverForOrder(orderId);

  const reloaded = await knex('drivers').where({ id: d.id }).first();
  assert(reloaded.availability_status === 'available', 'driver is available again');
  assert(Number(reloaded.current_workload) === 2, 'workload decremented from 3 → 2');
}

(async () => {
  await knex.migrate.latest();
  await knex('order_status_history').del();
  await knex('orders').del();
  await knex('drivers').del();
  await knex('users').del();

  try {
    await test1PicksClosestWhenWorkloadTied();
    await test2WorkloadPenaltyBeatsProximity();
    await test3LowerWorkloadWinsAtSimilarDistance();
    await test4UnavailableDriversSkipped();
    await test5NoDriverLeavesOrderPending();
    await test6FreeDriverDecrementsWorkload();
    console.log('\n🎉 All auto-assign tests passed!');
  } catch (e) {
    console.error('💥 test threw:', e);
    process.exitCode = 1;
  } finally {
    await knex.destroy();
  }
})();
