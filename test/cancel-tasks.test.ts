/**
 * End-to-end tests for the seller-cancel → task-propagation fix.
 *
 * Background: `OrderService.cancelOrderTyped` used to flip
 * `orders.status` to `cancelled` and emit a socket event but NEVER
 * touched the per-order `tasks` rows. The PICKUP and DELIVERY
 * tasks stayed PENDING, so the driver's /driver/tasks page kept
 * listing the order as actionable, and "Mark as Delivered" would
 * silently overwrite the order's `cancelled` status with
 * `delivered` (via `TaskService.advanceStatus` →
 * `translateTaskToOrderStatus`). The seller's dashboard would
 * then show the order as Delivered even though they cancelled
 * it minutes earlier.
 *
 * The fix mirrors the existing `declineOrderByDriver` block in
 * `OrderService.declineOrderByDriver`: walk the `tasks` rows for
 * the order and call `TaskService.advanceStatus(..., 'CANCELLED')`
 * for each one that isn't already terminal. `translateTaskToOrderStatus`
 * then sees the order is already `cancelled` and returns null, so
 * the order status is not double-written.
 *
 * These tests assert:
 *   1. Cancelling a fresh order marks both PICKUP + DELIVERY tasks
 *      as CANCELLED.
 *   2. Cancelling after the driver has already PICKED_UP the
 *      package marks the (still-PENDING) DELIVERY task as
 *      CANCELLED while leaving the PICKUP task alone (PICKED_UP
 *      is treated as terminal for the cancel sweep).
 *   3. After cancel, the driver cannot advance a cancelled task
 *      to DELIVERED — `isAllowedTransition` rejects it.
 *   4. After cancel, the order status stays `cancelled` even
 *      when a stale delivery PATCH is attempted (covered by 3).
 *
 * Run: NODE_ENV=test node --import \
 *   "file:///C:/Users/rohit/Downloads/routeflow/node_modules/tsx/dist/loader.mjs" \
 *   test/cancel-tasks.test.ts
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
    items: [
      { name: 'Test Item', quantity: 1, unitPrice: 25, weight: 1.5, volume: 0.01 },
    ],
  });
}

async function clean() {
  // FK order: tasks → order_status_history → orders → drivers → sellers → users.
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

/**
 * Test 1: a freshly-assigned order is cancelled by the seller
 * and both PICKUP + DELIVERY tasks are marked CANCELLED. This is
 * the headline regression — the bug the user reported.
 */
async function test1SellerCancelCancelsBothTasks() {
  console.log('\n=== Test 1: seller cancel propagates to PICKUP + DELIVERY tasks ===');
  await clean();

  const sellerUserId = await makeUser('seller@test.com', 'seller');
  const driverUserId = await makeUser('driver@test.com', 'driver');
  await makeSellerProfile(sellerUserId);
  const driver = await makeDriver(driverUserId, PICKUP_LAT, PICKUP_LNG);

  const order = await makeTypedOrder(sellerUserId);
  // OrderService.createTyped no longer auto-assigns. Drive the
  // manual path so the rest of the test (tasks, cancel) still works.
  const assigned = await OrderService.assignDriver(order.id, driver.id);
  assert(assigned.driverId !== null, 'order is manually assigned');

  // Sanity: 2 tasks both PENDING before cancel.
  let taskRows = await knex('tasks').where({ order_id: order.id });
  assert(taskRows.length === 2, 'order has 2 tasks (PICKUP + DELIVERY)');
  assert(
    taskRows.every((t) => t.status === 'PENDING'),
    'both tasks start in PENDING',
  );

  // Cancel as the seller.
  let cancelled;
  try {
    cancelled = await OrderService.cancelOrderTyped(
      order.id,
      sellerUserId,
      'seller',
      'customer changed mind',
    );
  } catch (e) {
    console.error('cancelOrderTyped threw:', (e as Error).message);
    console.error((e as Error).stack);
    throw e;
  }
  assert(cancelled.status === 'CANCELLED', `order is CANCELLED (got ${cancelled.status})`);

  // The fix: both tasks are now CANCELLED too. Without the fix
  // these would still be PENDING, which would let the driver
  // "Mark as Delivered" the order and flip it back.
  taskRows = await knex('tasks').where({ order_id: order.id });
  assert(taskRows.length === 2, 'still 2 tasks after cancel');
  assert(
    taskRows.every((t) => t.status === 'CANCELLED'),
    `both tasks end in CANCELLED (got: ${taskRows.map((t) => t.status).join(', ')})`,
  );

  // And the order status is preserved.
  const orderRow = await knex('orders').where({ id: order.id }).first();
  assert(orderRow.status === 'cancelled', 'order row still cancelled in DB');
}

/**
 * Test 2: the seller cancels after the driver has already
 * PICKED_UP. The PICKUP task stays PICKED_UP (it's already
 * terminal in the cancel sweep) and the still-PENDING DELIVERY
 * task is the one that gets CANCELLED.
 */
async function test2CancelAfterPickupLeavesPickedUpAlone() {
  console.log('\n=== Test 2: cancel after PICKED_UP — pickup stays, delivery cancels ===');
  await clean();

  const sellerUserId = await makeUser('seller@test.com', 'seller');
  const driverUserId = await makeUser('driver@test.com', 'driver');
  await makeSellerProfile(sellerUserId);
  const driver = await makeDriver(driverUserId, PICKUP_LAT, PICKUP_LNG);

  const order = await makeTypedOrder(sellerUserId);
  // Manual assign — see comment in test 1.
  await OrderService.assignDriver(order.id, driver.id);

  // Walk the PICKUP task through to PICKED_UP.
  const { tasks } = await TaskService.listForDriver(driverUserId);
  const pickup = tasks.find((t) => t.type === 'PICKUP')!;
  const delivery = tasks.find((t) => t.type === 'DELIVERY')!;
  for (const next of ['ACCEPTED', 'EN_ROUTE_TO_PICKUP', 'ARRIVED_AT_PICKUP', 'PICKED_UP'] as const) {
    await TaskService.advanceStatus(pickup.id, driverUserId, 'driver', next);
  }

  // Now the seller cancels.
  await OrderService.cancelOrderTyped(order.id, sellerUserId, 'seller', 'oops');

  const taskRows = await knex('tasks').where({ order_id: order.id });
  const pickupRow = taskRows.find((t) => t.type === 'PICKUP')!;
  const deliveryRow = taskRows.find((t) => t.type === 'DELIVERY')!;
  assert(pickupRow.status === 'PICKED_UP', `PICKUP stays PICKED_UP after cancel (got ${pickupRow.status})`);
  assert(deliveryRow.status === 'CANCELLED', `DELIVERY flips to CANCELLED (got ${deliveryRow.status})`);

  // The order is still cancelled (not flipped to delivered by any
  // task transition).
  const orderRow = await knex('orders').where({ id: order.id }).first();
  assert(orderRow.status === 'cancelled', 'order stays cancelled in DB');
}

/**
 * Test 3: after cancel, the driver trying to advance the
 * delivery task to DELIVERED is rejected. This is the second
 * half of the original bug — the "Mark as Delivered" button
 * was still working on a cancelled order, and it silently
 * overwrote the cancel with a delivery.
 */
async function test3DriverCannotDeliverCancelledTask() {
  console.log('\n=== Test 3: driver cannot advance a CANCELLED task to DELIVERED ===');
  await clean();

  const sellerUserId = await makeUser('seller@test.com', 'seller');
  const driverUserId = await makeUser('driver@test.com', 'driver');
  await makeSellerProfile(sellerUserId);
  const driver = await makeDriver(driverUserId, PICKUP_LAT, PICKUP_LNG);

  const order = await makeTypedOrder(sellerUserId);
  // Manual assign — see comment in test 1.
  await OrderService.assignDriver(order.id, driver.id);
  const { tasks } = await TaskService.listForDriver(driverUserId);
  const delivery = tasks.find((t) => t.type === 'DELIVERY')!;

  // Cancel as the seller (cancels the delivery task too).
  await OrderService.cancelOrderTyped(order.id, sellerUserId, 'seller');

  // Driver attempts to mark as delivered.
  let threw = false;
  try {
    await TaskService.advanceStatus(delivery.id, driverUserId, 'driver', 'DELIVERED');
  } catch (e) {
    threw = true;
    const msg = (e as Error).message.toLowerCase();
    assert(
      msg.includes('cancel') || msg.includes('transition') || msg.includes('invalid'),
      `advance-to-DELIVERED rejected with cancellation-related error: ${(e as Error).message}`,
    );
  }
  assert(threw, 'advance-to-DELIVERED on a cancelled task throws');

  // And the order is still cancelled (not flipped to delivered).
  const orderRow = await knex('orders').where({ id: order.id }).first();
  assert(orderRow.status === 'cancelled', 'order stays cancelled in DB after failed delivery attempt');
}

/**
 * Test 4: cancelling an already-delivered order is still
 * rejected at the order level (pre-existing guard). This is
 * just a regression check to make sure the new task-sweep
 * block didn't relax that guard.
 */
async function test4CannotCancelDeliveredOrder() {
  console.log('\n=== Test 4: cannot cancel a DELIVERED order (regression) ===');
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
    await OrderService.cancelOrderTyped(order.id, sellerUserId, 'seller', 'too late');
  } catch (e) {
    threw = true;
    const msg = (e as Error).message.toLowerCase();
    assert(
      msg.includes('delivered'),
      `cancel-after-delivered error mentions delivered: ${(e as Error).message}`,
    );
  }
  assert(threw, 'cancel of a delivered order throws');
}

(async () => {
  await knex.migrate.latest();
  try {
    await test1SellerCancelCancelsBothTasks();
    await test2CancelAfterPickupLeavesPickedUpAlone();
    await test3DriverCannotDeliverCancelledTask();
    await test4CannotCancelDeliveredOrder();
    console.log('\n🎉 All cancel-tasks tests passed!');
  } catch (e) {
    console.error('💥 test threw:', e);
    process.exitCode = 1;
  } finally {
    await knex.destroy();
  }
})();
