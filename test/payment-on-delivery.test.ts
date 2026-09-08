/**
 * End-to-end tests for the payment_status transition on delivery.
 *
 * Background: orders are created with `payment_status = 'PENDING'`
 * (see `OrderService.createTyped`). The seller dashboard shows
 * a "Payment: PENDING" badge until the order is paid. We want
 * successful delivery to clear that badge: when the DELIVERY task
 * reaches `DELIVERED`, the order's `payment_status` should flip
 * to `PAID`. (Refunds / failures are out of scope for this
 * transition — those happen through the cancel flow.)
 *
 * Run: NODE_ENV=test node --import \
 *   "file:///C:/Users/rohit/Downloads/routeflow/node_modules/tsx/dist/loader.mjs" \
 *   test/payment-on-delivery.test.ts
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

async function test1PaymentPendingOnCreation() {
  console.log('\n=== Test 1: new order starts with payment_status = PENDING ===');
  await clean();
  const sellerUserId = await makeUser('seller@test.com', 'seller');
  const driverUserId = await makeUser('driver@test.com', 'driver');
  await makeSellerProfile(sellerUserId);
  await makeDriver(driverUserId, PICKUP_LAT, PICKUP_LNG);

  const order = await makeTypedOrder(sellerUserId);
  const row = await knex('orders').where({ id: order.id }).first();
  assert(row.payment_status === 'PENDING', `order starts as PENDING (got ${row.payment_status})`);
}

async function test2PaymentPaidOnDelivery() {
  console.log('\n=== Test 2: order payment_status flips to PAID when delivered ===');
  await clean();
  const sellerUserId = await makeUser('seller@test.com', 'seller');
  const driverUserId = await makeUser('driver@test.com', 'driver');
  await makeSellerProfile(sellerUserId);
  await makeDriver(driverUserId, PICKUP_LAT, PICKUP_LNG);

  const order = await makeTypedOrder(sellerUserId);
  // Manually assign — OrderService.createTyped no longer auto-assigns.
  const driverRow = await knex('drivers').where({ user_id: driverUserId }).first();
  await OrderService.assignDriver(order.id, driverRow.id);

  // Walk PICKUP through to PICKED_UP, then DELIVERY through to DELIVERED.
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

  const row = await knex('orders').where({ id: order.id }).first();
  assert(row.status === 'delivered', 'order status reached delivered');
  assert(
    row.payment_status === 'PAID',
    `payment_status flipped to PAID on delivery (got ${row.payment_status})`,
  );
}

async function test3PaymentUnchangedOnCancel() {
  console.log('\n=== Test 3: cancelling a PENDING order leaves payment_status PENDING ===');
  await clean();
  const sellerUserId = await makeUser('seller@test.com', 'seller');
  const driverUserId = await makeUser('driver@test.com', 'driver');
  await makeSellerProfile(sellerUserId);
  await makeDriver(driverUserId, PICKUP_LAT, PICKUP_LNG);

  const order = await makeTypedOrder(sellerUserId);
  // Manually assign so the driver is the assigned driver and
  // `declineOrderByDriver` has a driver_id to validate against.
  const driverRow = await knex('drivers').where({ user_id: driverUserId }).first();
  await OrderService.assignDriver(order.id, driverRow.id);
  // Decline reverts to PENDING, so we just check the row wasn't paid.
  await OrderService.declineOrderByDriver(order.id, driverUserId);
  const row = await knex('orders').where({ id: order.id }).first();
  assert(
    row.payment_status === 'PENDING',
    `payment_status stays PENDING after decline (got ${row.payment_status})`,
  );
}

(async () => {
  await knex.migrate.latest();
  try {
    await test1PaymentPendingOnCreation();
    await test2PaymentPaidOnDelivery();
    await test3PaymentUnchangedOnCancel();
    console.log('\n🎉 All payment-on-delivery tests passed!');
  } catch (e) {
    console.error('💥 test threw:', e);
    process.exitCode = 1;
  } finally {
    await knex.destroy();
  }
})();
