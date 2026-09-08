/**
 * End-to-end tests for the `customerEmail is required` rule.
 *
 * Background: order creation used to accept any payload (no
 * validation, just `{...req.body}` passed to OrderService.create).
 * The transactional email system (see
 * `src/services/notification.service.ts`) needs a destination
 * email to send the "Order Confirmed" and "Order Delivered"
 * emails. So `customerEmail` is now required at three layers:
 *
 *   1. HTTP: `src/validators/order.validators.ts` runs
 *      `createOrderSchema.parse(req.body)` in the controller. A
 *      Zod failure → 400 with field-level details (handled by
 *      `error.middleware.ts`).
 *   2. Service: `OrderService.create` throws `ValidationError`
 *      if the email is missing or malformed, defending against
 *      callers that bypass the controller.
 *   3. Schema: `orders.customer_email` is now NOT NULL via
 *      `migrations/20260907_require_customer_email_on_orders.js`.
 *
 * These tests exercise layer 2 (the service, which the controller
 * also goes through) and verify the column is persisted correctly.
 * The controller-level Zod parse is exercised by the route —
 * exercised transitively because the controller calls
 * `createOrderSchema.parse` before reaching the service.
 *
 * Run:
 *   NODE_ENV=test npx tsx test/customer-email-required.test.ts
 */
import path from 'path';
import { config as dotenvConfig } from 'dotenv';
dotenvConfig({ path: path.resolve(__dirname, '../.env.test') });

import { knex } from '../src/config/database';
import { OrderService } from '../src/services/order.service';
import { encryptObject } from '../src/config/encryption';
import { createOrderSchema } from '../src/validators/order.validators';
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

async function clean() {
  // FK order: orders → sellers → users.
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

// =====================================================================
// 1. Zod schema rejects missing customerEmail
// =====================================================================
async function test1SchemaRejectsMissingEmail() {
  section('createOrderSchema rejects missing customerEmail');
  const result = createOrderSchema.safeParse({
    customerName: 'Alice',
    customerPhone: '+15555550100',
    // customerEmail: missing on purpose
    deliveryAddress: '1 Main St',
  });
  assert(!result.success, 'safeParse returns success=false without customerEmail');
  if (!result.success) {
    const emailFieldErr = result.error.errors.find((e) => e.path.includes('customerEmail'));
    assert(
      Boolean(emailFieldErr),
      `error mentions customerEmail (got: ${result.error.errors.map((e) => e.path.join('.')).join(', ')})`,
    );
  }
}

// =====================================================================
// 1b. Zod schema rejects malformed customerPhone
// =====================================================================
async function test1bSchemaRejectsMalformedPhone() {
  section('createOrderSchema rejects malformed customerPhone');
  // Pure nonsense (letters / too few digits)
  let r = createOrderSchema.safeParse({
    customerName: 'Alice',
    customerEmail: 'alice@example.com',
    customerPhone: 'abc',
    deliveryAddress: '1 Main St',
  });
  assert(!r.success, 'safeParse rejects "abc"');

  // Empty / too short
  r = createOrderSchema.safeParse({
    customerName: 'Alice',
    customerEmail: 'alice@example.com',
    customerPhone: '12345',
    deliveryAddress: '1 Main St',
  });
  assert(!r.success, 'safeParse rejects a 5-digit phone');

  // Missing
  r = createOrderSchema.safeParse({
    customerName: 'Alice',
    customerEmail: 'alice@example.com',
    // customerPhone: missing
    deliveryAddress: '1 Main St',
  });
  assert(!r.success, 'safeParse rejects missing customerPhone');

  // Valid forms
  for (const phone of ['+15555550100', '(555) 555-0100', '5555550100', '+1 555-555-0100']) {
    const ok = createOrderSchema.safeParse({
      customerName: 'Alice',
      customerEmail: 'alice@example.com',
      customerPhone: phone,
      deliveryAddress: '1 Main St',
    });
    assert(ok.success, `safeParse accepts "${phone}"`);
  }
}

// =====================================================================
// 2. Zod schema rejects malformed customerEmail
// =====================================================================
async function test2SchemaRejectsMalformedEmail() {
  section('createOrderSchema rejects malformed customerEmail');
  const result = createOrderSchema.safeParse({
    customerName: 'Alice',
    customerPhone: '+15555550100',
    customerEmail: 'not-an-email',
    deliveryAddress: '1 Main St',
  });
  assert(!result.success, 'safeParse rejects "not-an-email"');
  if (!result.success) {
    const emailFieldErr = result.error.errors.find((e) => e.path.includes('customerEmail'));
    assert(Boolean(emailFieldErr), 'error is on customerEmail field');
  }
}

// =====================================================================
// 3. Service throws ValidationError if a caller bypasses the schema
// =====================================================================
async function test3ServiceGuardsMissingEmail() {
  section('OrderService.create guards against missing customerEmail');
  await clean();
  const sellerUserId = await makeUser('seller@test.com', 'seller');

  let threw = false;
  let message = '';
  try {
    // Cast to any so TypeScript doesn't catch it at compile time —
    // the test is verifying the runtime guard.
    await OrderService.create({
      sellerId: sellerUserId,
      customerName: 'Alice',
      customerPhone: '+15555550100',
      // @ts-expect-error - intentionally testing the runtime guard
      customerEmail: undefined,
      deliveryAddress: '1 Main St',
      latitude: 40.7128,
      longitude: -74.006,
    });
  } catch (e) {
    threw = true;
    if (e instanceof ValidationError) {
      message = e.message;
    }
  }
  assert(threw, 'service throws when customerEmail is missing');
  assert(
    message.toLowerCase().includes('customeremail'),
    `error message names the field (got: "${message}")`,
  );
}

// =====================================================================
// 4. Service throws ValidationError if email is malformed
// =====================================================================
async function test4ServiceGuardsMalformedEmail() {
  section('OrderService.create guards against malformed customerEmail');
  await clean();
  const sellerUserId = await makeUser('seller@test.com', 'seller');

  let threw = false;
  try {
    await OrderService.create({
      sellerId: sellerUserId,
      customerName: 'Alice',
      customerPhone: '+15555550100',
      customerEmail: 'not-an-email',
      deliveryAddress: '1 Main St',
      latitude: 40.7128,
      longitude: -74.006,
    });
  } catch (e) {
    threw = e instanceof ValidationError;
  }
  assert(threw, 'service throws ValidationError on malformed email');
}

// =====================================================================
// 5. Order persists customerEmail when valid
// =====================================================================
async function test5OrderPersistsValidEmail() {
  section('OrderService.create persists customerEmail to the DB');
  await clean();
  const sellerUserId = await makeUser('seller@test.com', 'seller');
  const CUSTOMER_EMAIL = 'alice@example.com';

  const order = await OrderService.create({
    sellerId: sellerUserId,
    customerName: 'Alice',
    customerPhone: '+15555550100',
    customerEmail: CUSTOMER_EMAIL,
    deliveryAddress: '1 Main St, NY',
    latitude: 40.7128,
    longitude: -74.006,
  });

  assert(order.id, 'order is created');
  assert(
    (order as { customer_email?: string }).customer_email === CUSTOMER_EMAIL ||
      order.customer_email === CUSTOMER_EMAIL,
    `in-memory order has the email (got: ${(order as { customer_email?: string }).customer_email})`,
  );

  const row = await knex('orders').where({ id: order.id }).first();
  assert(row.customer_email === CUSTOMER_EMAIL, `DB row has the email (got: ${row.customer_email})`);
}

(async () => {
  await knex.migrate.latest();
  try {
    await test1SchemaRejectsMissingEmail();
    await test1bSchemaRejectsMalformedPhone();
    await test2SchemaRejectsMalformedEmail();
    await test3ServiceGuardsMissingEmail();
    await test4ServiceGuardsMalformedEmail();
    await test5OrderPersistsValidEmail();
    console.log(`\n========================================`);
    console.log(`  ${pass} passed, ${fail} failed`);
    console.log(`========================================`);
    if (fail > 0) process.exitCode = 1;
  } catch (e) {
    console.error('💥 test threw:', e);
    process.exitCode = 1;
  } finally {
    await knex.destroy();
  }
})();
