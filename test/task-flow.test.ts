/**
 * End-to-end tests for the per-driver Task lifecycle.
 *
 * Background: drivers used to have no visible work items because the
 * /tasks/my endpoint and the `tasks` table did not exist. This test
 * exercises the new flow:
 *
 *   1. Seller creates a typed order near an available driver.
 *   2. Auto-assign attaches the driver and OrderService.createTyped
 *      calls TaskService.generateForOrder, which creates a
 *      one-order `routes_typed` row + 2 task rows (PICKUP + DELIVERY).
 *   3. TaskService.listForDriver(driverUserId) returns both tasks.
 *   4. The driver advances the PICKUP task to PICKED_UP and the
 *      orders.status is mirrored to 'picked_up'.
 *   5. The driver advances the DELIVERY task to DELIVERED; the order
 *      is mirrored to 'delivered' and the driver is freed (status
 *      flips to 'available', workload decrements).
 *
 * Idempotency check: re-calling generateForOrder is a no-op (the
 * existing (order_id, type) pairs are detected and skipped).
 *
 * Run: NODE_ENV=test node --import \
 *   "file:///C:/Users/rohit/Downloads/routeflow/node_modules/tsx/dist/loader.mjs" \
 *   test/task-flow.test.ts
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
  // routes_typed.seller_id references sellers.id (see migration
  // 20260901_add_sellers_table.js), so an order whose seller has
  // not been promoted to a sellers row will fail the FK when the
  // task service tries to insert a one-order route. The auto-assign
  // code path goes through generateForOrder → creates a route → so
  // we must seed a sellers row up front.
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

async function test1AutoAssignGeneratesTasks() {
  console.log('\n=== Test 1: auto-assigned order produces 2 tasks visible to the driver ===');
  await clean();

  const sellerUserId = await makeUser('seller@test.com', 'seller');
  const driverUserId = await makeUser('driver@test.com', 'driver');
  await makeSellerProfile(sellerUserId);
  const driver = await makeDriver(driverUserId, PICKUP_LAT, PICKUP_LNG);

  const order = await makeTypedOrder(sellerUserId);
  // OrderService.createTyped no longer auto-assigns (sellers assign
  // manually from /seller/orders/[id]). Drive the manual path so
  // the test still exercises the full task-generation flow.
  const assigned = await OrderService.assignDriver(order.id, driver.id);
  assert(assigned.driverId !== null && assigned.driverId !== undefined, 'order is attached to a driver after manual assign');

  const { tasks, total } = await TaskService.listForDriver(driverUserId);
  assert(total === 2, 'listForDriver returns total=2 for an order with both PICKUP and DELIVERY');
  const pickup = tasks.find((t) => t.type === 'PICKUP');
  const delivery = tasks.find((t) => t.type === 'DELIVERY');
  assert(pickup !== undefined, 'PICKUP task is present');
  assert(delivery !== undefined, 'DELIVERY task is present');
  assert(pickup!.status === 'PENDING', 'PICKUP task starts PENDING');
  assert(delivery!.status === 'PENDING', 'DELIVERY task starts PENDING');
  assert(pickup!.orderId === order.id, 'PICKUP task links to the order');
  assert(delivery!.orderId === order.id, 'DELIVERY task links to the order');
  assert(pickup!.routeId !== null && delivery!.routeId === pickup!.routeId, 'both tasks share a route id');
  assert(pickup!.sequenceIndex === 0, 'PICKUP task has sequenceIndex 0');
  assert(delivery!.sequenceIndex === 1, 'DELIVERY task has sequenceIndex 1');

  // The auto-generation should have created a one-order routes_typed row.
  const route = await knex('routes_typed').where({ id: pickup!.routeId! }).first();
  assert(route, 'routes_typed row was created');
  assert(route.status === 'PLANNED', 'new route starts PLANNED');
  const orderIds = route.order_ids as string[];
  assert(orderIds.includes(order.id), 'route.order_ids contains the order id');
}

async function test2GenerateForOrderIsIdempotent() {
  console.log('\n=== Test 2: re-running generateForOrder does not duplicate tasks ===');
  await clean();

  const sellerUserId = await makeUser('seller@test.com', 'seller');
  const driverUserId = await makeUser('driver@test.com', 'driver');
  await makeSellerProfile(sellerUserId);
  const driver = await makeDriver(driverUserId, PICKUP_LAT, PICKUP_LNG);

  const order = await makeTypedOrder(sellerUserId);
  // Manual assign — see comment in test 1.
  await OrderService.assignDriver(order.id, driver.id);
  const before = await knex('tasks').where({ order_id: order.id }).count('* as count').first();
  assert(Number(before?.count) === 2, '2 tasks before re-running generateForOrder');

  await TaskService.generateForOrder(order.id, driver.id);
  await TaskService.generateForOrder(order.id, driver.id);
  const after = await knex('tasks').where({ order_id: order.id }).count('* as count').first();
  assert(Number(after?.count) === 2, 'still 2 tasks after two re-runs (idempotent)');
}

async function test3AdvancePickupFlipsOrderStatus() {
  console.log('\n=== Test 3: PICKUP task → PICKED_UP mirrors to orders.status=picked_up ===');
  await clean();

  const sellerUserId = await makeUser('seller@test.com', 'seller');
  const driverUserId = await makeUser('driver@test.com', 'driver');
  await makeSellerProfile(sellerUserId);
  const driver = await makeDriver(driverUserId, PICKUP_LAT, PICKUP_LNG);

  const order = await makeTypedOrder(sellerUserId);
  // Manual assign — see comment in test 1.
  await OrderService.assignDriver(order.id, driver.id);
  const { tasks } = await TaskService.listForDriver(driverUserId);
  const pickup = tasks.find((t) => t.type === 'PICKUP')!;

  // Walk the workflow: PENDING → ACCEPTED → EN_ROUTE_TO_PICKUP →
  // ARRIVED_AT_PICKUP → PICKED_UP. The order's status only changes
  // at the last step.
  let t = await TaskService.advanceStatus(pickup.id, driverUserId, 'driver', 'ACCEPTED');
  assert(t.status === 'ACCEPTED', 'PICKUP task → ACCEPTED');
  let orderRow = await knex('orders').where({ id: order.id }).first();
  assert(orderRow.status === 'assigned', 'order is still "assigned" mid-workflow');

  t = await TaskService.advanceStatus(pickup.id, driverUserId, 'driver', 'EN_ROUTE_TO_PICKUP');
  assert(t.status === 'EN_ROUTE_TO_PICKUP', 'PICKUP task → EN_ROUTE_TO_PICKUP');
  t = await TaskService.advanceStatus(pickup.id, driverUserId, 'driver', 'ARRIVED_AT_PICKUP');
  assert(t.status === 'ARRIVED_AT_PICKUP', 'PICKUP task → ARRIVED_AT_PICKUP');

  t = await TaskService.advanceStatus(pickup.id, driverUserId, 'driver', 'PICKED_UP');
  assert(t.status === 'PICKED_UP', 'PICKUP task → PICKED_UP');
  assert(t.actualPickupAt !== null, 'actual_pickup_at is recorded');

  orderRow = await knex('orders').where({ id: order.id }).first();
  assert(orderRow.status === 'picked_up', 'order.status mirrors to "picked_up"');
  assert(orderRow.actual_pickup_at !== null, 'orders.actual_pickup_at is recorded');
}

async function test4DeliveryCompletesAndFreesDriver() {
  console.log('\n=== Test 4: DELIVERY → DELIVERED marks order delivered and frees driver ===');
  await clean();

  const sellerUserId = await makeUser('seller@test.com', 'seller');
  const driverUserId = await makeUser('driver@test.com', 'driver');
  await makeSellerProfile(sellerUserId);
  const driver = await makeDriver(driverUserId, PICKUP_LAT, PICKUP_LNG);

  const order = await makeTypedOrder(sellerUserId);
  // Manual assign — see comment in test 1.
  await OrderService.assignDriver(order.id, driver.id);
  // After manual assign the driver is busy and workload = 1.
  let drv = await knex('drivers').where({ id: driver.id }).first();
  assert(drv.availability_status === 'busy', 'driver is busy after manual assign');
  assert(Number(drv.current_workload) === 1, 'driver workload is 1');

  // Walk PICKUP to PICKED_UP.
  const { tasks } = await TaskService.listForDriver(driverUserId);
  const pickup = tasks.find((t) => t.type === 'PICKUP')!;
  for (const next of ['ACCEPTED', 'EN_ROUTE_TO_PICKUP', 'ARRIVED_AT_PICKUP', 'PICKED_UP'] as const) {
    await TaskService.advanceStatus(pickup.id, driverUserId, 'driver', next);
  }

  // Walk DELIVERY to DELIVERED. The DELIVERY task's own workflow is
  // PENDING → ACCEPTED → EN_ROUTE_TO_DROPOFF → ARRIVED_AT_DROPOFF →
  // DELIVERED (no pickup step — that's the PICKUP task's job).
  const delivery = tasks.find((t) => t.type === 'DELIVERY')!;
  for (const next of ['ACCEPTED', 'EN_ROUTE_TO_DROPOFF', 'ARRIVED_AT_DROPOFF'] as const) {
    await TaskService.advanceStatus(delivery.id, driverUserId, 'driver', next);
  }
  const delivered = await TaskService.advanceStatus(delivery.id, driverUserId, 'driver', 'DELIVERED');
  assert(delivered.status === 'DELIVERED', 'DELIVERY task → DELIVERED');
  assert(delivered.actualDeliveryAt !== null, 'actual_delivery_at is recorded');

  const orderRow = await knex('orders').where({ id: order.id }).first();
  assert(orderRow.status === 'delivered', 'order.status mirrors to "delivered"');
  assert(orderRow.actual_delivery_at !== null, 'orders.actual_delivery_at is recorded');

  // Driver should be freed: busy → available, workload 1 → 0.
  drv = await knex('drivers').where({ id: driver.id }).first();
  assert(drv.availability_status === 'available', 'driver is available again after both tasks done');
  assert(Number(drv.current_workload) === 0, 'driver workload decremented to 0');
}

async function test5UnauthorizedAdvanceRejected() {
  console.log('\n=== Test 5: another driver cannot advance someone else\'s task ===');
  await clean();

  const sellerUserId = await makeUser('seller@test.com', 'seller');
  const driverAUserId = await makeUser('a@test.com', 'driver');
  const driverBUserId = await makeUser('b@test.com', 'driver');
  await makeSellerProfile(sellerUserId);
  const driverA = await makeDriver(driverAUserId, PICKUP_LAT, PICKUP_LNG);
  await makeDriver(driverBUserId, PICKUP_LAT + 0.01, PICKUP_LNG);

  const order = await makeTypedOrder(sellerUserId);
  // Manual assign — see comment in test 1. We assign to driverA so
  // the unauthorized-advancer test below (driverB) is meaningful.
  await OrderService.assignDriver(order.id, driverA.id);
  const { tasks } = await TaskService.listForDriver(driverAUserId);
  const pickup = tasks.find((t) => t.type === 'PICKUP')!;

  let threw = false;
  try {
    await TaskService.advanceStatus(pickup.id, driverBUserId, 'driver', 'ACCEPTED');
  } catch (e) {
    threw = true;
    assert(
      (e as Error).message.toLowerCase().includes('not authorized'),
      'rejection error mentions authorization'
    );
  }
  assert(threw, 'foreign-driver advance throws ForbiddenError');

  // And the seller role is rejected outright.
  let sellerThrew = false;
  try {
    await TaskService.advanceStatus(pickup.id, sellerUserId, 'seller', 'ACCEPTED');
  } catch {
    sellerThrew = true;
  }
  assert(sellerThrew, 'seller role cannot advance tasks');

  // The real owner can still advance.
  await TaskService.advanceStatus(pickup.id, driverAUserId, 'driver', 'ACCEPTED');
  const t = await knex('tasks').where({ id: pickup.id }).first();
  assert(t.status === 'ACCEPTED', 'real owner advanced the task successfully');
}

(async () => {
  await knex.migrate.latest();
  try {
    await test1AutoAssignGeneratesTasks();
    await test2GenerateForOrderIsIdempotent();
    await test3AdvancePickupFlipsOrderStatus();
    await test4DeliveryCompletesAndFreesDriver();
    await test5UnauthorizedAdvanceRejected();
    console.log('\n🎉 All task-flow tests passed!');
  } catch (e) {
    console.error('💥 test threw:', e);
    process.exitCode = 1;
  } finally {
    await knex.destroy();
  }
})();
