/**
 * Unit tests for the driver-task consolidation helper.
 *
 * The driver dashboard at /driver/tasks renders ONE row per order
 * with a single "Next step" button. The state machine that decides
 * which leg (PICKUP or DELIVERY) and which status the button
 * targets lives in `src/lib/driver-tasks.ts`. The original
 * implementation was inlined in the page; extracting it makes the
 * logic testable without spinning up React.
 *
 * These tests assert the consolidated state machine matches the
 * backend's per-leg `isAllowedTransition` table:
 *
 *   PICKUP, PENDING              → ACCEPTED on pickup
 *   PICKUP, ACCEPTED             → EN_ROUTE_TO_PICKUP on pickup
 *   PICKUP, EN_ROUTE_TO_PICKUP   → ARRIVED_AT_PICKUP on pickup
 *   PICKUP, ARRIVED_AT_PICKUP    → PICKED_UP on pickup
 *   PICKUP, PICKED_UP            → ACCEPTED on delivery
 *   DELIVERY, ACCEPTED           → EN_ROUTE_TO_DROPOFF on delivery
 *   DELIVERY, EN_ROUTE_TO_DROPOFF → ARRIVED_AT_DROPOFF on delivery
 *   DELIVERY, ARRIVED_AT_DROPOFF  → DELIVERED on delivery
 *   DELIVERY, DELIVERED          → terminal
 *
 * Run: node --import tsx test/driver-task-consolidation.test.ts
 *
 * (No DB needed — these are pure-function tests against an extracted
 * helper. They live in the same test/ directory as the rest of the
 * project tests so the run command is consistent.)
 */
import path from 'path';
import { config as dotenvConfig } from 'dotenv';
dotenvConfig({ path: path.resolve(__dirname, '../.env.test') });

import {
  getCombinedNextStep,
  getRowStatus,
  type ConsolidatedOrder,
} from '../routeflow-frontend/src/lib/driver-tasks';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error('❌', msg);
    process.exit(1);
  }
  console.log('✅', msg);
}

function makeRow(pickupStatus: ConsolidatedOrder['pickup'] extends infer T ? (T extends { status: infer S } ? S : never) : never, deliveryStatus: any): ConsolidatedOrder {
  return {
    pickup: { id: 'pickup-1', type: 'PICKUP', status: pickupStatus as any },
    delivery: { id: 'delivery-1', type: 'DELIVERY', status: deliveryStatus as any },
  };
}

function makeEmptyRow(): ConsolidatedOrder {
  return {};
}

async function test1NextStepPickingUp() {
  console.log('\n=== Test 1: PICKUP leg state machine ===');

  // 1a. PENDING → ACCEPTED on PICKUP
  let row = makeRow('PENDING', 'PENDING');
  let step = getCombinedNextStep(row);
  assert(step !== null, 'PICKUP PENDING returns a next step');
  assert(step!.task.type === 'PICKUP', 'PICKUP PENDING advances pickup');
  assert(step!.nextStatus === 'ACCEPTED', `→ ACCEPTED (got ${step!.nextStatus})`);
  assert(step!.label === 'Accept', `label is "Accept" (got "${step!.label}")`);

  // 1b. ACCEPTED → EN_ROUTE_TO_PICKUP
  row = makeRow('ACCEPTED', 'PENDING');
  step = getCombinedNextStep(row);
  assert(step?.nextStatus === 'EN_ROUTE_TO_PICKUP', `→ EN_ROUTE_TO_PICKUP (got ${step?.nextStatus})`);
  assert(step?.label === 'Going to Pickup', `label "Going to Pickup" (got "${step?.label}")`);

  // 1c. EN_ROUTE_TO_PICKUP → ARRIVED_AT_PICKUP
  row = makeRow('EN_ROUTE_TO_PICKUP', 'PENDING');
  step = getCombinedNextStep(row);
  assert(step?.nextStatus === 'ARRIVED_AT_PICKUP', `→ ARRIVED_AT_PICKUP (got ${step?.nextStatus})`);

  // 1d. ARRIVED_AT_PICKUP → PICKED_UP (success tone)
  row = makeRow('ARRIVED_AT_PICKUP', 'PENDING');
  step = getCombinedNextStep(row);
  assert(step?.nextStatus === 'PICKED_UP', `→ PICKED_UP (got ${step?.nextStatus})`);
  assert(step?.tone === 'success', 'PICKED_UP is the success tone');
}

async function test2NextStepDeliveryAfterPickedUp() {
  console.log('\n=== Test 2: PICKUP done → DELIVERY leg state machine ===');

  // 2a. PICKUP PICKED_UP, DELIVERY PENDING → ACCEPTED on delivery
  let row = makeRow('PICKED_UP', 'PENDING');
  let step = getCombinedNextStep(row);
  assert(step?.task.type === 'DELIVERY', 'PICKED_UP PICKUP advances delivery');
  assert(step?.nextStatus === 'ACCEPTED', `delivery PENDING → ACCEPTED (got ${step?.nextStatus})`);
  assert(step?.label === 'Accept delivery', `label "Accept delivery" (got "${step?.label}")`);

  // 2b. ACCEPTED → EN_ROUTE_TO_DROPOFF
  row = makeRow('PICKED_UP', 'ACCEPTED');
  step = getCombinedNextStep(row);
  assert(step?.nextStatus === 'EN_ROUTE_TO_DROPOFF', `→ EN_ROUTE_TO_DROPOFF (got ${step?.nextStatus})`);
  assert(step?.label === 'Going to Dropoff', `label "Going to Dropoff" (got "${step?.label}")`);

  // 2c. EN_ROUTE_TO_DROPOFF → ARRIVED_AT_DROPOFF
  row = makeRow('PICKED_UP', 'EN_ROUTE_TO_DROPOFF');
  step = getCombinedNextStep(row);
  assert(step?.nextStatus === 'ARRIVED_AT_DROPOFF', `→ ARRIVED_AT_DROPOFF (got ${step?.nextStatus})`);

  // 2d. ARRIVED_AT_DROPOFF → DELIVERED (success tone)
  row = makeRow('PICKED_UP', 'ARRIVED_AT_DROPOFF');
  step = getCombinedNextStep(row);
  assert(step?.nextStatus === 'DELIVERED', `→ DELIVERED (got ${step?.nextStatus})`);
  assert(step?.tone === 'success', 'DELIVERED is the success tone');
  assert(step?.label === 'Mark as Delivered', `label "Mark as Delivered" (got "${step?.label}")`);
}

async function test3TerminalStates() {
  console.log('\n=== Test 3: terminal states return null ===');

  // Delivered is terminal.
  let row = makeRow('PICKED_UP', 'DELIVERED');
  let step = getCombinedNextStep(row);
  assert(step === null, 'DELIVERED delivery returns no next step');

  // Cancelled delivery is terminal.
  row = makeRow('PICKED_UP', 'CANCELLED');
  step = getCombinedNextStep(row);
  assert(step === null, 'CANCELLED delivery returns no next step');

  // Failed delivery is terminal.
  row = makeRow('PICKED_UP', 'FAILED');
  step = getCombinedNextStep(row);
  assert(step === null, 'FAILED delivery returns no next step');
}

async function test4CancelledPickupFallback() {
  console.log('\n=== Test 4: cancelled pickup still lets delivery proceed ===');

  // If pickup is cancelled but delivery is pending, the driver can
  // still accept the delivery (the package may have been handed
  // off by hand). This is the "customer came to the store" path.
  const row = makeRow('CANCELLED', 'PENDING');
  const step = getCombinedNextStep(row);
  assert(step !== null, 'cancelled pickup + pending delivery still has a next step');
  assert(step?.task.type === 'DELIVERY', 'delivery task is the active leg');
  assert(step?.nextStatus === 'ACCEPTED', `→ ACCEPTED (got ${step?.nextStatus})`);

  // If the pickup was cancelled AND the delivery has already been
  // started or finished, no fallback.
  const row2 = makeRow('CANCELLED', 'EN_ROUTE_TO_DROPOFF');
  const step2 = getCombinedNextStep(row2);
  assert(step2 === null, 'cancelled pickup + in-flight delivery returns null (driver can still finish the delivery via the in-flight task itself)');
}

async function test5GetRowStatus() {
  console.log('\n=== Test 5: getRowStatus picks the active leg ===');

  // Empty row → PENDING placeholder.
  let status = getRowStatus(makeEmptyRow());
  assert(status === 'PENDING', `empty row → PENDING (got ${status})`);

  // PICKUP not yet PICKED_UP — pickup leg wins.
  status = getRowStatus(makeRow('EN_ROUTE_TO_PICKUP', 'PENDING'));
  assert(status === 'EN_ROUTE_TO_PICKUP', `active pickup leg → EN_ROUTE_TO_PICKUP (got ${status})`);

  // PICKUP at PICKED_UP — delivery leg takes over.
  status = getRowStatus(makeRow('PICKED_UP', 'EN_ROUTE_TO_DROPOFF'));
  assert(status === 'EN_ROUTE_TO_DROPOFF', `delivery leg takes over → EN_ROUTE_TO_DROPOFF (got ${status})`);

  // PICKUP at PICKED_UP, delivery PENDING — delivery leg is the "active" one.
  status = getRowStatus(makeRow('PICKED_UP', 'PENDING'));
  assert(status === 'PENDING', `post-pickup → PENDING (delivery leg) (got ${status})`);

  // Both terminal — delivery is the final state.
  status = getRowStatus(makeRow('PICKED_UP', 'DELIVERED'));
  assert(status === 'DELIVERED', `delivered → DELIVERED (got ${status})`);
}

async function test6SynthesizedFallback() {
  console.log('\n=== Test 6: synthesized fallback rows still compute a step ===');

  // Fallback rows (no real backend task ids) have empty `id`. The
  // helper doesn't care about the id; the renderer is the one that
  // hides the button when the id is empty. The helper still has to
  // return a valid step so the renderer can label it.
  const row: ConsolidatedOrder = {
    pickup: { id: '', type: 'PICKUP', status: 'PENDING' },
    delivery: { id: '', type: 'DELIVERY', status: 'PENDING' },
  };
  const step = getCombinedNextStep(row);
  assert(step !== null, 'synthesized PENDING row returns a next step');
  assert(step?.nextStatus === 'ACCEPTED', 'synthesized PENDING still points at ACCEPTED on pickup');
}

(async () => {
  try {
    await test1NextStepPickingUp();
    await test2NextStepDeliveryAfterPickedUp();
    await test3TerminalStates();
    await test4CancelledPickupFallback();
    await test5GetRowStatus();
    await test6SynthesizedFallback();
    console.log('\n🎉 All driver-task-consolidation tests passed!');
  } catch (e) {
    console.error('💥 test threw:', e);
    process.exitCode = 1;
  }
})();
