/**
 * End-to-end tests for the order-lifecycle transactional email
 * triggers. The Nodemailer transporter is mocked at the
 * notificationService level so tests don't contact SMTP.
 *
 * Background: the user requested two email triggers:
 *   1. Order creation → "Order Confirmed - Track Your Delivery"
 *      using the `pending` template.
 *   2. Order status → delivered → "Your Order Has Been Delivered!"
 *      using the `delivered` template.
 *
 * The previous code only fired on transitions (assigned,
 * picked_up, on_the_way, delivered, cancelled) and SKIPPED
 * `pending` because no caller ever passed it. The fix wires
 * `OrderService.create` to call `notifyOrderStatusChange(order,
 * 'pending')` (fire-and-forget, so the API response is not
 * blocked) and changes the two existing status callers from
 * `await` to non-awaited `.catch()` for the same reason.
 *
 * Mocking strategy (per the user's choice):
 *   - `notificationService.emailTransporter` is replaced with
 *     `{ sendMail: jest.fn(async () => ({ messageId: 'stub' })) }`.
 *   - `config.SMTP_FROM_EMAIL` is set to a placeholder so the
 *     "SMTP not configured" guard in `sendEmail` is bypassed.
 *   - The original values are restored in `afterAll` so other
 *     tests aren't affected.
 *
 * Run:
 *   NODE_ENV=test npx tsx test/email-notifications.test.ts
 */
import path from 'path';
import { config as dotenvConfig } from 'dotenv';
dotenvConfig({ path: path.resolve(__dirname, '../.env.test') });

import { knex } from '../src/config/database';
import { config } from '../src/config/env';
import { OrderService } from '../src/services/order.service';
import { notificationService } from '../src/services/notification.service';
import { encryptObject } from '../src/config/encryption';

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

// Hand-rolled mock: this test runner doesn't have Jest. We
// record every (to, subject, html) tuple `sendMail` is invoked
// with so the assertions can inspect them. Same idea for SMS:
// we record every (to, body) tuple `messages.create` is invoked
// with.
interface CapturedMail {
  to: string;
  from?: string;
  subject: string;
  html: string;
}
interface CapturedSms {
  to: string;
  from?: string;
  body: string;
}
const captured: CapturedMail[] = [];
const capturedSms: CapturedSms[] = [];
let slowSendMail: ((opts: unknown) => Promise<{ messageId: string }>) | null = null;

function sendMail(opts: unknown): Promise<{ messageId: string }> {
  // If a slow impl is installed (used by the non-blocking test),
  // delegate to it. Otherwise capture and return a stub.
  if (slowSendMail) {
    return slowSendMail(opts);
  }
  const o = opts as CapturedMail;
  captured.push({ to: o.to, from: o.from, subject: o.subject, html: o.html });
  return Promise.resolve({ messageId: 'stub' });
}

function messagesCreate(opts: unknown): Promise<{ sid: string }> {
  const o = opts as CapturedSms;
  capturedSms.push({ to: o.to, from: o.from, body: o.body });
  return Promise.resolve({ sid: 'SM-stub' });
}

// Save originals so we can restore them in the finally block.
// The notificationService is a singleton that lazy-initialises
// its transporter inside `sendEmail`; we override the slot to
// skip the SMTP handshake and use our mock instead.
const ORIGINAL_TRANSPORTER = (notificationService as any).emailTransporter;
const ORIGINAL_TWILIO = (notificationService as any).twilioClient;
const ORIGINAL_INITIALISED = (notificationService as any).initialized;
const ORIGINAL_SMTP_FROM_EMAIL = config.SMTP_FROM_EMAIL;
const ORIGINAL_TWILIO_FROM = config.TWILIO_PHONE_NUMBER;

function installMock() {
  (notificationService as any).emailTransporter = { sendMail };
  // Stub the Twilio client. Real Twilio SDK has a `messages`
  // namespace with a `create` method; we mirror that surface
  // so the production call `this.twilioClient.messages.create(...)`
  // lands in our `messagesCreate` recorder.
  (notificationService as any).twilioClient = { messages: { create: messagesCreate } };
  (notificationService as any).initialized = true; // skip lazy init
  config.SMTP_FROM_EMAIL = 'test@routeflow.local';
  config.TWILIO_PHONE_NUMBER = '+15005550006';
}

function restoreMock() {
  (notificationService as any).emailTransporter = ORIGINAL_TRANSPORTER;
  (notificationService as any).twilioClient = ORIGINAL_TWILIO;
  (notificationService as any).initialized = ORIGINAL_INITIALISED;
  config.SMTP_FROM_EMAIL = ORIGINAL_SMTP_FROM_EMAIL;
  config.TWILIO_PHONE_NUMBER = ORIGINAL_TWILIO_FROM;
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
  await knex('order_status_history').del();
  await knex('tasks').del();
  await knex('order_items').del();
  await knex('routes_typed').del();
  await knex('orders').del();
  await knex('refresh_tokens').del();
  await knex('drivers').del();
  await knex('sellers').del();
  await knex('users').del();
  await knex('notifications').del();
}

/**
 * Helper to wait for any in-flight fire-and-forget email to land
 * in the mock. `notifyOrderStatusChange` returns a Promise that
 * the production code intentionally does not await; in tests we
 * need to give the event loop a tick (or two) to drain it.
 */
async function flushEmails() {
  // Two microtask cycles: one for the .then on the awaited
  // renderTemplate chain, one for the catch+sendEmail.
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

// =====================================================================
// 1. Creating an order fires the "Order Confirmed" email with the
//    right subject, recipient, and tracking link.
// =====================================================================
async function test1OrderCreationFiresPendingEmail() {
  section('OrderService.create fires the "Order Confirmed" email');
  await clean();
  captured.length = 0;
  slowSendMail = null;
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

  // The email is fire-and-forget. Wait for the microtask queue
  // to drain before asserting on the captured sendMail call.
  await flushEmails();

  assert(
    captured.length === 1,
    `sendMail called once (got ${captured.length})`,
  );

  const mail = captured[0];
  if (!mail) return;
  assert(mail.to === CUSTOMER_EMAIL, `to = customer email (got ${mail.to})`);
  assert(
    String(mail.subject).startsWith('Order Confirmed - Track Your Delivery'),
    `subject = "Order Confirmed - Track Your Delivery ..." (got "${mail.subject}")`,
  );
  // shortOrderId is order.id.substring(0, 8).toUpperCase()
  const shortId = order.id.substring(0, 8).toUpperCase();
  assert(
    String(mail.subject).includes(shortId),
    `subject includes short order id ${shortId} (got "${mail.subject}")`,
  );
  // Body must include the customer name + the tracking URL.
  const html = String(mail.html ?? '');
  assert(html.includes('Alice'), 'body includes customer name');
  assert(
    html.includes(`${config.PUBLIC_APP_URL}/track/${order.id}`),
    `body includes tracking URL ${config.PUBLIC_APP_URL}/track/${order.id}`,
  );
  assert(
    html.includes("We'll email you again when your order is delivered"),
    'body mentions the upcoming delivered email',
  );
}

// =====================================================================
// 2. Transitioning an order to delivered fires the delivered
//    template with the new subject.
// =====================================================================
async function test2DeliveredFiresDeliveredEmail() {
  section('Transitioning to delivered fires the "Your Order Has Been Delivered!" email');
  await clean();
  captured.length = 0;
  slowSendMail = null;
  const sellerUserId = await makeUser('seller@test.com', 'seller');
  const CUSTOMER_EMAIL = 'bob@example.com';

  const order = await OrderService.create({
    sellerId: sellerUserId,
    customerName: 'Bob',
    customerPhone: '+15555550101',
    customerEmail: CUSTOMER_EMAIL,
    deliveryAddress: '2 Main St, NY',
    latitude: 40.7128,
    longitude: -74.006,
  });

  // Drain the create-time email so it doesn't pollute the count.
  await flushEmails();
  captured.length = 0;

  // Move the order to delivered via the typed status updater.
  await OrderService.updateOrderStatusTyped(order.id, 'DELIVERED');
  await flushEmails();

  assert(
    captured.length === 1,
    `sendMail called once on delivered (got ${captured.length})`,
  );

  const mail = captured[0];
  if (!mail) return;
  assert(mail.to === CUSTOMER_EMAIL, `to = customer email (got ${mail.to})`);
  assert(
    String(mail.subject).startsWith('Your Order Has Been Delivered!'),
    `subject starts with "Your Order Has Been Delivered!" (got "${mail.subject}")`,
  );
  const shortId = order.id.substring(0, 8).toUpperCase();
  assert(
    String(mail.subject).includes(shortId),
    `subject includes short order id ${shortId} (got "${mail.subject}")`,
  );
  const html = String(mail.html ?? '');
  assert(
    html.includes(`${config.PUBLIC_APP_URL}/track/${order.id}`),
    'body still includes the tracking URL',
  );
}

// =====================================================================
// 3. The status update is non-blocking. The smoke test is that
//    the response from `updateOrderStatusTyped` is returned BEFORE
//    the mocked sendMail is invoked — proving the production
//    code does not `await` the email send.
// =====================================================================
async function test3StatusUpdateDoesNotBlockOnEmail() {
  section('Status update returns before sendMail resolves');
  await clean();
  captured.length = 0;
  slowSendMail = null;
  const sellerUserId = await makeUser('seller@test.com', 'seller');

  const order = await OrderService.create({
    sellerId: sellerUserId,
    customerName: 'Carol',
    customerPhone: '+15555550102',
    customerEmail: 'carol@example.com',
    deliveryAddress: '3 Main St, NY',
    latitude: 40.7128,
    longitude: -74.006,
  });
  await flushEmails();
  captured.length = 0;

  // Make sendMail intentionally slow so the await would have
  // been measurable. We assert `updateOrderStatusTyped` returns
  // BEFORE this slow sendMail resolves.
  let sendMailResolved = false;
  slowSendMail = async (_opts: unknown) => {
    await new Promise((r) => setTimeout(r, 200));
    sendMailResolved = true;
    return { messageId: 'stub' };
  };

  const t0 = Date.now();
  await OrderService.updateOrderStatusTyped(order.id, 'DELIVERED');
  const t1 = Date.now();

  assert(!sendMailResolved, 'sendMail has not yet resolved when the API call returns');
  assert(
    t1 - t0 < 100,
    `updateOrderStatusTyped returned in <100ms (got ${t1 - t0}ms) — email is non-blocking`,
  );

  // Now wait for the slow sendMail (a setTimeout, not a microtask)
  // to actually resolve before we move on, so the mock doesn't
  // leak to other tests.
  await new Promise((r) => setTimeout(r, 250));
  assert(sendMailResolved, 'sendMail eventually resolves');
  slowSendMail = null;
}

// =====================================================================
// 4. Transitioning to delivered fires the spec-required SMS copy
//    to the customer phone. Subject line and body follow the
//    wording the spec asks for:
//    "Hi {customerName}, your RouteFlow order #{orderId} has
//    been successfully delivered! Thank you for using our
//    service."
// =====================================================================
async function test4DeliveredFiresSmsWithSpecCopy() {
  section('Delivered status fires SMS to customer_phone with the spec copy');
  await clean();
  captured.length = 0;
  capturedSms.length = 0;
  slowSendMail = null;
  const sellerUserId = await makeUser('seller@test.com', 'seller');
  const CUSTOMER_PHONE = '+15555550199';
  const CUSTOMER_NAME = 'Dana';

  const order = await OrderService.create({
    sellerId: sellerUserId,
    customerName: CUSTOMER_NAME,
    customerPhone: CUSTOMER_PHONE,
    customerEmail: 'dana@example.com',
    deliveryAddress: '4 Main St, NY',
    latitude: 40.7128,
    longitude: -74.006,
  });

  // Drain the create-time email so it doesn't pollute the count.
  await flushEmails();
  captured.length = 0;
  capturedSms.length = 0;

  await OrderService.updateOrderStatusTyped(order.id, 'DELIVERED');
  await flushEmails();

  assert(
    capturedSms.length === 1,
    `messages.create called once on delivered (got ${capturedSms.length})`,
  );
  const sms = capturedSms[0];
  if (!sms) return;
  assert(sms.to === CUSTOMER_PHONE, `SMS to = customer phone (got ${sms.to})`);

  const shortId = order.id.substring(0, 8).toUpperCase();
  const expectedBody = `Hi ${CUSTOMER_NAME}, your RouteFlow order #${shortId} has been successfully delivered! Thank you for using our service.`;
  assert(
    sms.body === expectedBody,
    `SMS body matches the spec copy exactly (got "${sms.body}")`,
  );
}

// =====================================================================
// 5. The pending email body includes an "Item Summary" line
//    derived from parcelDetails (description, then weight, then
//    "Parcel" as a fallback). The spec asks for this in the
//    email body.
// =====================================================================
async function test5PendingEmailIncludesItemSummary() {
  section('Pending email body includes an Item Summary line from parcelDetails');
  await clean();
  captured.length = 0;
  capturedSms.length = 0;
  slowSendMail = null;
  const sellerUserId = await makeUser('seller@test.com', 'seller');

  // Create with a description AND a weight so we can assert
  // the description wins.
  const order = await OrderService.create({
    sellerId: sellerUserId,
    customerName: 'Eve',
    customerPhone: '+15555550111',
    customerEmail: 'eve@example.com',
    deliveryAddress: '5 Main St, NY',
    latitude: 40.7128,
    longitude: -74.006,
    parcelDetails: { description: '2x Book + 1x Headphones', weight: 1.5 },
  });
  await flushEmails();

  const mail = captured[0];
  if (!mail) {
    assert(false, 'no email captured');
    return;
  }
  const html = String(mail.html ?? '');
  assert(
    html.includes('<strong>Item Summary:</strong>'),
    'body has the "Item Summary" label',
  );
  assert(
    html.includes('2x Book + 1x Headphones'),
    `body includes parcel description (got: ${html.slice(0, 200)}...)`,
  );
}

(async () => {
  await knex.migrate.latest();
  installMock();
  try {
    await test1OrderCreationFiresPendingEmail();
    await test2DeliveredFiresDeliveredEmail();
    await test3StatusUpdateDoesNotBlockOnEmail();
    await test4DeliveredFiresSmsWithSpecCopy();
    await test5PendingEmailIncludesItemSummary();
    console.log(`\n========================================`);
    console.log(`\n========================================`);
    console.log(`  ${pass} passed, ${fail} failed`);
    console.log(`========================================`);
    if (fail > 0) process.exitCode = 1;
  } catch (e) {
    console.error('💥 test threw:', e);
    process.exitCode = 1;
  } finally {
    restoreMock();
    await knex.destroy();
  }
})();
