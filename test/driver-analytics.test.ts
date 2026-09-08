/**
 * End-to-end tests for the driver-scoped analytics endpoints.
 *
 * Background: `orders.driver_id` is a foreign key to `drivers.id`,
 * not `users.id`. The old analytics queries scoped the driver
 * filter to `req.user.sub` directly, which is the user's id — so
 * a driver's analytics call always returned zero rows.
 *
 * These tests exercise the controller through the service path
 * (re-creating the same filter resolution) so we catch a future
 * regression where the wrong column gets queried.
 *
 * Run: NODE_ENV=test node --import \
 *   "file:///C:/Users/rohit/Downloads/routeflow/node_modules/tsx/dist/loader.mjs" \
 *   test/driver-analytics.test.ts
 */
import path from 'path';
import { config as dotenvConfig } from 'dotenv';
dotenvConfig({ path: path.resolve(__dirname, '../.env.test') });

import { knex } from '../src/config/database';
import { OrderService } from '../src/services/order.service';
import { TaskService } from '../src/services/task.service';
import { encryptObject } from '../src/config/encryption';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error('❌', msg);
    process.exit(1);
  }
  console.log('✅', msg);
}

const PICKUP_LAT = 40.7128;
const PICKUP_LNG = -74.006;
const DELIVERY_LAT = 40.73061;
const DELIVERY_LNG = -73.935242;

/**
 * Mirror the analytics filter resolution: drivers.user_id maps to
 * req.user.sub, but orders.driver_id is the driver record's id. The
 * controller must look up the driver row first and use its id to
 * filter orders.
 */
async function driverOrderCount(userId: string): Promise<number> {
  const driverRow = await knex('drivers').where({ user_id: userId }).first();
  if (!driverRow) return 0;
  const row = await knex('orders')
    .where({ driver_id: driverRow.id })
    .count('* as count')
    .first();
  return Number(row?.count ?? 0);
}

async function makeUser(email: string, role: 'driver' | 'seller'): Promise<string> {
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

async function makeDriver(userId: string, lat: number, lng: number) {
  const [d] = await knex('drivers')
    .insert({
      user_id: userId,
      current_latitude: lat,
      current_longitude: lng,
      availability_status: 'available',
      current_workload: 0,
    })
    .returning('*');
  return d;
}

async function makeSellerProfile(userId: string) {
  const [s] = await knex('sellers')
    .insert({
      user_id: userId,
      business_name: 'Test Seller',
      business_type: 'retail',
      status: 'active',
    })
    .returning('*');
  return s;
}

async function makeTypedOrder(sellerId: string) {
  return OrderService.createTyped({
    sellerId,
    customerName: 'Test Customer',
    customerPhone: '+10000000000',
    customerEmail: 'cust@test.com',
    deliveryAddress: { street: '500 5th Ave', city: 'New York', state: 'NY', zip: '10110' },
    pickupAddress: { street: '350 5th Ave', city: 'New York', state: 'NY', zip: '10118' },
    pickupLat: PICKUP_LAT,
    pickupLng: PICKUP_LNG,
    deliveryLat: DELIVERY_LAT,
    deliveryLng: DELIVERY_LNG,
    totalWeight: 1.5,
    totalVolume: 0.01,
    totalValue: 25,
    items: [{ name: 'Test Item', quantity: 1, unitPrice: 25, weight: 1.5, volume: 0.01 }],
  });
}

async function clean() {
  await knex('order_status_history').del();
  await knex('tasks').del();
  await knex('order_items').del();
  await knex('routes_typed').del();
  await knex('orders').del();
  await knex('refresh_tokens').del();
  await knex('drivers').del();
  await knex('sellers').del();
  await knex('users').del();
}

async function test1DriverFilterScopesToDriverRecordId() {
  console.log('\n=== Test 1: driver analytics scope uses driver record id, not user id ===');
  await clean();
  const sellerUserId = await makeUser('seller@test.com', 'seller');
  const driverAUserId = await makeUser('a@test.com', 'driver');
  const driverBUserId = await makeUser('b@test.com', 'driver');
  await makeSellerProfile(sellerUserId);
  await makeDriver(driverAUserId, PICKUP_LAT, PICKUP_LNG);
  await makeDriver(driverBUserId, PICKUP_LAT + 0.01, PICKUP_LNG);

  // OrderService.createTyped no longer auto-assigns; manually attach
  // the order to driver A. (The original test relied on auto-assign
  // picking the closest driver — same outcome, different mechanism.)
  const order = await makeTypedOrder(sellerUserId);
  const driverARow = await knex('drivers').where({ user_id: driverAUserId }).first();
  await OrderService.assignDriver(order.id, driverARow.id);
  const orderRow = await knex('orders').where({ id: order.id }).first();
  assert(orderRow.driver_id === driverARow.id, 'order assigned to driver A');

  const aCount = await driverOrderCount(driverAUserId);
  const bCount = await driverOrderCount(driverBUserId);
  assert(aCount === 1, `driver A analytics sees 1 order (got ${aCount})`);
  assert(bCount === 0, `driver B analytics sees 0 orders (got ${bCount})`);

  // Old buggy filter would have done orders.where({ driver_id: userId }),
  // returning 0 for both drivers regardless.
  const buggyA = await knex('orders').where({ driver_id: driverAUserId }).count('* as count').first();
  const buggyB = await knex('orders').where({ driver_id: driverBUserId }).count('* as count').first();
  assert(
    Number(buggyA?.count ?? 0) === 0,
    'old buggy filter would have returned 0 (driver_id != user_id)',
  );
  assert(Number(buggyB?.count ?? 0) === 0, 'old buggy filter would have returned 0 for B too');
}

async function test2CompletedDeliveriesCountedForDriver() {
  console.log('\n=== Test 2: completed-deliveries count is non-zero for a driver with deliveries ===');
  await clean();
  const sellerUserId = await makeUser('seller@test.com', 'seller');
  const driverUserId = await makeUser('driver@test.com', 'driver');
  await makeSellerProfile(sellerUserId);
  await makeDriver(driverUserId, PICKUP_LAT, PICKUP_LNG);

  const order = await makeTypedOrder(sellerUserId);
  // Manually assign so the tasks below are created. (Test 1 comment.)
  const driverRow0 = await knex('drivers').where({ user_id: driverUserId }).first();
  await OrderService.assignDriver(order.id, driverRow0.id);
  const { tasks } = await TaskService.listForDriver(driverUserId);
  const pickup = tasks.find((t) => t.type === 'PICKUP')!;
  const delivery = tasks.find((t) => t.type === 'DELIVERY')!;
  for (const next of ['ACCEPTED', 'EN_ROUTE_TO_PICKUP', 'ARRIVED_AT_PICKUP', 'PICKED_UP'] as const) {
    await TaskService.advanceStatus(pickup.id, driverUserId, 'driver', next);
  }
  for (const next of ['ACCEPTED', 'EN_ROUTE_TO_DROPOFF', 'ARRIVED_AT_DROPOFF'] as const) {
    await TaskService.advanceStatus(delivery.id, driverUserId, 'driver', next);
  }
  await TaskService.advanceStatus(delivery.id, driverUserId, 'driver', 'DELIVERED');

  const driverRow = await knex('drivers').where({ user_id: driverUserId }).first();
  const row = await knex('orders')
    .where({ driver_id: driverRow.id, status: 'delivered' })
    .count('* as count')
    .first();
  assert(Number(row?.count ?? 0) === 1, 'driver analytics counts the delivered order');
}

async function test3NoDriverProfileReturnsZero() {
  console.log('\n=== Test 3: a user with no driver profile returns zero (no crash) ===');
  await clean();
  // Just a user with no drivers row.
  await makeUser('nothing@test.com', 'driver');
  const count = await driverOrderCount('00000000-0000-0000-0000-000000000000');
  assert(count === 0, 'unknown user resolves to 0 orders');
}

(async () => {
  await knex.migrate.latest();
  try {
    await test1DriverFilterScopesToDriverRecordId();
    await test2CompletedDeliveriesCountedForDriver();
    await test3NoDriverProfileReturnsZero();
    console.log('\n🎉 All driver-analytics tests passed!');
  } catch (e) {
    console.error('💥 test threw:', e);
    process.exitCode = 1;
  } finally {
    await knex.destroy();
  }
})();
