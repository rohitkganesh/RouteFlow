/**
 * End-to-end tests for the driver-side decline flow.
 *
 * Background: drivers used to have no way to reject an assigned order
 * without seller intervention. The new `OrderService.declineOrderByDriver`
 * lets a driver atomically:
 *   1. Cancel both PICKUP + DELIVERY tasks for the order
 *   2. Revert the order's status to 'pending'
 *   3. Clear `driver_id` and `route_id` so the seller's pool / auto-assign
 *      can re-route it
 *   4. Free the driver (busy → available, workload -= 1)
 *
 * Authorization: only the assigned driver can decline. Sellers and admins
 * use the existing /orders/:id/cancel endpoint; a foreign driver gets
 * a validation error.
 *
 * Status guard: orders in DELIVERED or CANCELLED cannot be declined.
 *
 * Run: NODE_ENV=test node --import \
 *   "file:///C:/Users/rohit/Downloads/routeflow/node_modules/tsx/dist/loader.mjs" \
 *   test/driver-decline.test.ts
 */
import path from 'path';
import { config as dotenvConfig } from 'dotenv';
dotenvConfig({ path: path.resolve(__dirname, '../.env.test') });

import { knex } from '../src/config/database';
import { TaskService } from '../src/services/task.service';
import { OrderService } from '../src/services/order.service';
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

async function makeDriver(userId: string, lat: number, lng: number, workload = 0) {
  const [d] = await knex('drivers')
    .insert({
      user_id: userId,
      current_latitude: lat,
      current_longitude: lng,
      availability_status: 'available',
      current_workload: workload,
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
    deliveryAddress: {
      street: '500 5th Ave',
      city: 'New York',
      state: 'NY',
      zip: '10110',
    },
    pickupAddress: {
      street: '350 5th Ave',
      city: 'New York',
      state: 'NY',
      zip: '10118',
    },
    pickupLat: PICKUP_LAT,
    pickupLng: PICKUP_LNG,
    deliveryLat: DELIVERY_LAT,
    deliveryLng: DELIVERY_LNG,
    totalWeight: 1.5,
    totalVolume: 0.01,
    totalValue: 25,
    items: [
      {
        name: 'Test Item',
        quantity: 1,
        unitPrice: 25,
        weight: 1.5,
        volume: 0.01,
      },
    ],
  });
}

async function clean() {
  // Order of deletes matters because of FKs. tasks → routes_typed →
  // orders → drivers → sellers → users.
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

async function test1DeclineFreesDriverAndRevertsOrder() {
  console.log('\n=== Test 1: driver decline cancels tasks, reverts order, frees driver ===');
  await clean();

  const sellerUserId = await makeUser('seller@test.com', 'seller');
  const driverUserId = await makeUser('driver@test.com', 'driver');
  await makeSellerProfile(sellerUserId);
  const driver = await makeDriver(driverUserId, PICKUP_LAT, PICKUP_LNG);

  // Manually assign — OrderService.createTyped no longer auto-assigns.
  // The seller (or test) calls assignDriver to attach the driver and
  // create PICKUP + DELIVERY tasks.
  const order = await makeTypedOrder(sellerUserId);
  const assigned = await OrderService.assignDriver(order.id, driver.id);
  assert(assigned.driverId !== null && assigned.driverId !== undefined, 'order is manually assigned');

  // Sanity: before the decline, the driver is busy with workload = 1.
  let drv = await knex('drivers').where({ id: driver.id }).first();
  assert(drv.availability_status === 'busy', 'driver is busy after manual assign');
  assert(Number(drv.current_workload) === 1, 'driver workload is 1');

  // Both tasks should exist and be PENDING.
  let taskRows = await knex('tasks').where({ order_id: order.id });
  assert(taskRows.length === 2, 'order has 2 tasks (PICKUP + DELIVERY)');
  assert(
    taskRows.every((t) => t.status === 'PENDING'),
    'both tasks start in PENDING',
  );

  // Decline.
  const declined = await OrderService.declineOrderByDriver(order.id, driverUserId);
  assert(declined.status === 'PENDING', 'order status reverted to PENDING');
  assert(declined.driverId === null, 'driver_id is cleared');
  assert(declined.routeId === null, 'route_id is cleared');

  // Tasks should be CANCELLED.
  taskRows = await knex('tasks').where({ order_id: order.id });
  assert(taskRows.length === 2, 'still 2 tasks after decline');
  assert(
    taskRows.every((t) => t.status === 'CANCELLED'),
    'both tasks end in CANCELLED after decline',
  );

  // Driver is freed.
  drv = await knex('drivers').where({ id: driver.id }).first();
  assert(drv.availability_status === 'available', 'driver is back to available');
  assert(Number(drv.current_workload) === 0, 'driver workload decremented to 0');
}

async function test2ForeignDriverCannotDecline() {
  console.log('\n=== Test 2: another driver cannot decline someone else\'s assignment ===');
  await clean();

  const sellerUserId = await makeUser('seller@test.com', 'seller');
  const driverAUserId = await makeUser('a@test.com', 'driver');
  const driverBUserId = await makeUser('b@test.com', 'driver');
  await makeSellerProfile(sellerUserId);
  const driverA = await makeDriver(driverAUserId, PICKUP_LAT, PICKUP_LNG);
  await makeDriver(driverBUserId, PICKUP_LAT + 0.01, PICKUP_LNG);

  const order = await makeTypedOrder(sellerUserId);
  // Manually assign to driver A. The test below is about driver B
  // trying to decline someone else's assignment, so A must be the
  // assigned driver.
  const assigned = await OrderService.assignDriver(order.id, driverA.id);
  assert(assigned.driverId !== null, 'order is manually assigned to driver A');

  let threw = false;
  try {
    await OrderService.declineOrderByDriver(order.id, driverBUserId);
  } catch (e) {
    threw = true;
    const msg = (e as Error).message.toLowerCase();
    assert(
      msg.includes('not authorized') || msg.includes('not assigned'),
      `foreign-driver decline rejected: ${(e as Error).message}`,
    );
  }
  assert(threw, 'foreign-driver decline throws');

  // Order should be unchanged after the failed decline.
  const orderRow = await knex('orders').where({ id: order.id }).first();
  assert(orderRow.status === 'assigned', 'order remains assigned after failed decline');
  assert(orderRow.driver_id !== null, 'driver_id preserved after failed decline');
}

async function test3CannotDeclineDeliveredOrder() {
  console.log('\n=== Test 3: declined-after-delivery is rejected ===');
  await clean();

  const sellerUserId = await makeUser('seller@test.com', 'seller');
  const driverUserId = await makeUser('driver@test.com', 'driver');
  await makeSellerProfile(sellerUserId);
  const driver = await makeDriver(driverUserId, PICKUP_LAT, PICKUP_LNG);

  const order = await makeTypedOrder(sellerUserId);
  // Manually assign — see test 1.
  await OrderService.assignDriver(order.id, driver.id);

  // Walk the workflow all the way to DELIVERED.
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

  let threw = false;
  try {
    await OrderService.declineOrderByDriver(order.id, driverUserId);
  } catch (e) {
    threw = true;
    assert(
      (e as Error).message.toLowerCase().includes('delivered'),
      `decline-after-delivery error mentions delivered: ${(e as Error).message}`,
    );
  }
  assert(threw, 'decline of a delivered order throws');
}

async function test4DeclineAfterAcceptStillFreesDriver() {
  console.log('\n=== Test 4: driver accepts the PICKUP task then declines — driver still freed ===');
  await clean();

  const sellerUserId = await makeUser('seller@test.com', 'seller');
  const driverUserId = await makeUser('driver@test.com', 'driver');
  await makeSellerProfile(sellerUserId);
  const driver = await makeDriver(driverUserId, PICKUP_LAT, PICKUP_LNG);

  const order = await makeTypedOrder(sellerUserId);
  // Manually assign — see test 1.
  await OrderService.assignDriver(order.id, driver.id);

  // Driver accepts the PICKUP task.
  const { tasks } = await TaskService.listForDriver(driverUserId);
  const pickup = tasks.find((t) => t.type === 'PICKUP')!;
  await TaskService.advanceStatus(pickup.id, driverUserId, 'driver', 'ACCEPTED');

  // Now the driver changes their mind and declines. The service
  // should still cancel the remaining PENDING DELIVERY task and
  // revert the order.
  const declined = await OrderService.declineOrderByDriver(order.id, driverUserId);
  assert(declined.status === 'PENDING', 'order reverted to PENDING after mid-workflow decline');
  assert(declined.driverId === null, 'driver_id cleared after mid-workflow decline');

  const drv = await knex('drivers').where({ id: driver.id }).first();
  assert(drv.availability_status === 'available', 'driver freed after mid-workflow decline');
  assert(Number(drv.current_workload) === 0, 'driver workload zero after mid-workflow decline');

  const taskRows = await knex('tasks').where({ order_id: order.id });
  assert(
    taskRows.every((t) => t.status === 'CANCELLED'),
    'both tasks are CANCELLED even after a mid-workflow decline',
  );
}

(async () => {
  await knex.migrate.latest();
  try {
    await test1DeclineFreesDriverAndRevertsOrder();
    await test2ForeignDriverCannotDecline();
    await test3CannotDeclineDeliveredOrder();
    await test4DeclineAfterAcceptStillFreesDriver();
    console.log('\n🎉 All driver-decline tests passed!');
  } catch (e) {
    console.error('💥 test threw:', e);
    process.exitCode = 1;
  } finally {
    await knex.destroy();
  }
})();
