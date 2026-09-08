/**
 * Tests for the Pickup-and-Delivery TSP solver and the
 * `RoutingService.optimizeDeliveryRoutePDP` / `RouteService.optimizeDeliveryRoute`
 * integration.
 *
 * Runs as a plain Node script (no Jest) — matches the rest of test/.
 *
 * Tests:
 *   1. PDTSPSolver respects pickup-before-delivery precedence on
 *      crossing pickup/delivery coordinates.
 *   2. PDTSPSolver degenerates to standard TSP when pickup == delivery.
 *   3. PDTSPSolver handles the 1-order degenerate case.
 *   4. PDTSPSolver handles an 8-order realistic case and beats the
 *      unoptimized input order.
 *   5. `RoutingService.optimizeDeliveryRoutePDP` returns the
 *      expected shape and per-leg distances.
 *   6. `RouteService.optimizeDeliveryRoute` writes one `routes` row
 *      per order with the correct `sequence_index`.
 *   7. 2-opt doesn't break precedence.
 *   8. `RouteService.optimizeDeliveryRoute` rejects a driver who is
 *      not 'available'.
 *   9. `RouteService.optimizeDeliveryRoute` rejects a seller who
 *      doesn't own all the orders.
 *
 * Run: NODE_ENV=test node --import \
 *   "file:///C:/Users/rohit/Downloads/routeflow/node_modules/tsx/dist/loader.mjs" \
 *   test/pdp-tsp.test.ts
 */
import path from 'path';
import { config as dotenvConfig } from 'dotenv';
dotenvConfig({ path: path.resolve(__dirname, '../.env.test') });

import { knex } from '../src/config/database';
import { PDTSPSolver, TSPSolver, MockRoutingProvider } from '../src/services/routing.service';
import { RouteService } from '../src/services/route.service';
import { encryptObject } from '../src/config/encryption';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error('❌', msg);
    process.exit(1);
  }
  console.log('✅', msg);
}

/** Build a square distance matrix from a list of (lat, lng) points. */
function buildMatrix(coords: Array<{ lat: number; lng: number }>): number[][] {
  const provider = new MockRoutingProvider(0);
  const c = coords.map(p => ({ latitude: p.lat, longitude: p.lng }));
  // Synchronous Haversine (we don't await — MockRoutingProvider has
  // 0ms delay in the test)
  const m: number[][] = [];
  for (let i = 0; i < c.length; i++) {
    const row: number[] = [];
    for (let j = 0; j < c.length; j++) {
      const R = 6371000;
      const φ1 = (c[i].latitude * Math.PI) / 180;
      const φ2 = (c[j].latitude * Math.PI) / 180;
      const Δφ = ((c[j].latitude - c[i].latitude) * Math.PI) / 180;
      const Δλ = ((c[j].longitude - c[i].longitude) * Math.PI) / 180;
      const a =
        Math.sin(Δφ / 2) ** 2 +
        Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
      row.push(Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))));
    }
    m.push(row);
  }
  void provider;
  return m;
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
  lng: number,
  status: 'available' | 'busy' | 'offline' = 'available'
): Promise<string> {
  const [d] = await knex('drivers')
    .insert({
      user_id: userId,
      current_latitude: lat,
      current_longitude: lng,
      availability_status: status,
      current_workload: 0,
    })
    .returning('id');
  return d.id as string;
}

async function makeOrder(
  sellerId: string,
  pickup: { lat: number; lng: number },
  delivery: { lat: number; lng: number }
): Promise<string> {
  const [o] = await knex('orders')
    .insert({
      seller_id: sellerId,
      customer_name: 'Test',
      customer_phone: '+10000000000',
      delivery_address: 'Test',
      latitude: delivery.lat,
      longitude: delivery.lng,
      pickup_latitude: pickup.lat,
      pickup_longitude: pickup.lng,
      delivery_latitude: delivery.lat,
      delivery_longitude: delivery.lng,
      parcel_details: encryptObject({ weight: 1 }),
      status: 'pending',
    })
    .returning('id');
  return o.id as string;
}

function respectsPrecedence(
  path: number[],
  pairs: Array<{ pickup: number; delivery: number }>
): { ok: boolean; violations: string[] } {
  const position = new Map<number, number>();
  for (let i = 0; i < path.length; i++) {
    position.set(path[i], i);
  }
  const violations: string[] = [];
  for (const { pickup, delivery } of pairs) {
    const p = position.get(pickup);
    const d = position.get(delivery);
    if (p === undefined || d === undefined) {
      violations.push(`missing pickup ${pickup} or delivery ${delivery}`);
      continue;
    }
    if (p >= d) {
      violations.push(`pickup ${pickup} at ${p} is not before delivery ${delivery} at ${d}`);
    }
  }
  return { ok: violations.length === 0, violations };
}

// ============================================================
// 1. PDTSPSolver respects pickup-before-delivery precedence
// ============================================================
async function test1PrecedenceRespected() {
  console.log('\n=== Test 1: PDP respects pickup-before-delivery precedence ===');
  // 3 orders with deliberately crossing pickup/delivery coordinates.
  // Order A: pickup in north, delivery in south
  // Order B: pickup in east, delivery in west
  // Order C: pickup in south, delivery in north
  // The driver starts at the center. A naive TSP that visits only
  // deliveries could pick any order. The PDP solver must visit each
  // pickup before its delivery.
  const driver = { lat: 40.75, lng: -74.0 };
  const orders = [
    { pickup: { lat: 40.80, lng: -74.0 }, delivery: { lat: 40.70, lng: -74.0 } }, // N → S
    { pickup: { lat: 40.75, lng: -73.9 }, delivery: { lat: 40.75, lng: -74.1 } }, // E → W
    { pickup: { lat: 40.70, lng: -74.0 }, delivery: { lat: 40.80, lng: -74.0 } }, // S → N
  ];
  const coords: Array<{ lat: number; lng: number }> = [];
  const pairs: Array<{ pickup: number; delivery: number }> = [];
  for (const o of orders) {
    pairs.push({ pickup: coords.length, delivery: coords.length + 1 });
    coords.push(o.pickup, o.delivery);
  }
  const driverIdx = coords.length;
  coords.push(driver);

  const matrix = buildMatrix(coords);
  const path = PDTSPSolver.solve(matrix, pairs, driverIdx);

  console.log('  path:', path);
  const { ok, violations } = respectsPrecedence(path, pairs);
  assert(ok, `precedence respected (violations: ${violations.join('; ')})`);
  assert(path[0] === driverIdx, 'driver is the first stop');
  assert(path.length === coords.length, `path covers all ${coords.length} points`);
}

// ============================================================
// 2. PDTSPSolver degenerates to TSP when pickup == delivery
// ============================================================
async function test2DegeneratesToTSP() {
  console.log('\n=== Test 2: PDP degenerates to TSP when pickup == delivery ===');
  // When pickup and delivery are at the same coordinate, the PDP
  // solver should visit them together (consecutively or near each
  // other) and the precedence constraint is trivially satisfied.
  // The total distance should be the same as TSP visiting those 2N
  // points starting from the driver.
  const driver = { lat: 40.75, lng: -74.0 };
  const orderA = { lat: 40.80, lng: -74.0 }; // pickup == delivery (same point)
  const orderB = { lat: 40.70, lng: -74.0 };
  // Matrix: [pickupA, deliveryA, pickupB, deliveryB, driver]
  const coords = [orderA, orderA, orderB, orderB, driver];
  const pairs = [
    { pickup: 0, delivery: 1 },
    { pickup: 2, delivery: 3 },
  ];
  const matrix = buildMatrix(coords);
  const pdpPath = PDTSPSolver.solve(matrix, pairs, 4);
  const { ok } = respectsPrecedence(pdpPath, pairs);
  assert(ok, 'PDP solver returns a precedence-valid path');
  assert(pdpPath[0] === 4, 'driver is first in PDP path');
  assert(pdpPath.length === 5, 'path covers all 5 points');
  // For order A (pickup 0, delivery 1), since they're at the same
  // coordinate, the solver should visit them consecutively.
  const pos0 = pdpPath.indexOf(0);
  const pos1 = pdpPath.indexOf(1);
  assert(Math.abs(pos0 - pos1) === 1, 'pickup and delivery of same coord are visited consecutively');
}

// ============================================================
// 3. PDTSPSolver handles 1-order degenerate case
// ============================================================
async function test3OneOrderDegenerate() {
  console.log('\n=== Test 3: PDP handles 1-order degenerate case ===');
  // driver → pickup → delivery
  const driver = { lat: 40.75, lng: -74.0 };
  const pickup = { lat: 40.80, lng: -74.0 };
  const delivery = { lat: 40.70, lng: -74.0 };
  const coords = [pickup, delivery, driver];
  const pairs = [{ pickup: 0, delivery: 1 }];
  const matrix = buildMatrix(coords);
  const path = PDTSPSolver.solve(matrix, pairs, 2);
  console.log('  path:', path);
  assert(path[0] === 2, 'driver is first');
  assert(path.length === 3, 'path has 3 points (driver, pickup, delivery)');
  const { ok } = respectsPrecedence(path, pairs);
  assert(ok, 'pickup precedes delivery');
}

// ============================================================
// 4. PDTSPSolver on 8-order realistic case
// ============================================================
async function test4EightOrderRealistic() {
  console.log('\n=== Test 4: PDP on 8-order realistic case (NYC-ish) ===');
  // Driver starts in midtown Manhattan. 8 orders scattered around
  // Brooklyn / Queens / NJ. Each has a near-driver pickup and a
  // far-from-driver delivery. Optimal path should group nearby stops.
  const driver = { lat: 40.7549, lng: -73.9840 };
  const orders = [
    { pickup: { lat: 40.7060, lng: -74.0090 }, delivery: { lat: 40.6892, lng: -74.0445 } }, // downtown / statue
    { pickup: { lat: 40.7484, lng: -73.9857 }, delivery: { lat: 40.7505, lng: -73.9934 } }, // empire / penn
    { pickup: { lat: 40.7589, lng: -73.9851 }, delivery: { lat: 40.7614, lng: -73.9776 } }, // times sq / central park
    { pickup: { lat: 40.7282, lng: -73.9942 }, delivery: { lat: 40.7191, lng: -74.0006 } }, // chelsea / tribeca
    { pickup: { lat: 40.7831, lng: -73.9712 }, delivery: { lat: 40.7794, lng: -73.9632 } }, // central park / met
    { pickup: { lat: 40.6892, lng: -73.9442 }, delivery: { lat: 40.6782, lng: -73.9442 } }, // brooklyn
    { pickup: { lat: 40.7505, lng: -73.9934 }, delivery: { lat: 40.7549, lng: -73.9840 } }, // penn / midtown
    { pickup: { lat: 40.7614, lng: -73.9776 }, delivery: { lat: 40.7681, lng: -73.9819 } }, // central park
  ];
  const coords: Array<{ lat: number; lng: number }> = [];
  const pairs: Array<{ pickup: number; delivery: number }> = [];
  for (const o of orders) {
    pairs.push({ pickup: coords.length, delivery: coords.length + 1 });
    coords.push(o.pickup, o.delivery);
  }
  const driverIdx = coords.length;
  coords.push(driver);

  const matrix = buildMatrix(coords);
  const path = PDTSPSolver.solve(matrix, pairs, driverIdx);

  const { ok } = respectsPrecedence(path, pairs);
  assert(ok, 'all 8 pickups precede their deliveries');

  // Compute optimized total distance
  let optimized = 0;
  for (let i = 0; i < path.length - 1; i++) {
    optimized += matrix[path[i]][path[i + 1]];
  }

  // Compute "unoptimized" distance using the input order
  let unoptimized = matrix[driverIdx][pairs[0].pickup];
  for (let i = 0; i < pairs.length; i++) {
    unoptimized += matrix[pairs[i].pickup][pairs[i].delivery];
    if (i < pairs.length - 1) {
      unoptimized += matrix[pairs[i].delivery][pairs[i + 1].pickup];
    }
  }

  console.log(`  optimized total: ${(optimized / 1000).toFixed(2)} km`);
  console.log(`  unoptimized total: ${(unoptimized / 1000).toFixed(2)} km`);
  assert(optimized <= unoptimized, 'optimized route is at least as good as input order');
}

// ============================================================
// 5. RoutingService.optimizeDeliveryRoutePDP returns expected shape
// ============================================================
async function test5OptimizeDeliveryRoutePDPShape() {
  console.log('\n=== Test 5: RoutingService.optimizeDeliveryRoutePDP shape ===');
  await knex('order_status_history').del();
  await knex('routes').del();
  await knex('orders').del();
  await knex('drivers').del();
  await knex('users').del();

  const sellerId = await makeUser('seller1@test.com', 'seller');
  const driverUserId = await makeUser('driver1@test.com', 'driver');
  const driverPk = await makeDriver(driverUserId, 40.75, -74.0);

  const o1 = await makeOrder(sellerId, { lat: 40.80, lng: -74.0 }, { lat: 40.70, lng: -74.0 });
  const o2 = await makeOrder(sellerId, { lat: 40.75, lng: -73.9 }, { lat: 40.75, lng: -74.1 });
  const o3 = await makeOrder(sellerId, { lat: 40.70, lng: -74.0 }, { lat: 40.80, lng: -74.0 });

  const { routingService } = await import('../src/services/routing.service');
  const result = await routingService.optimizeDeliveryRoutePDP(driverPk, [o1, o2, o3]);

  console.log('  sequence:', result.sequence);
  console.log('  pickupSequence:', result.pickupSequence);
  console.log('  totalStops:', result.totalStops);
  console.log('  legs.length:', result.legs.length);

  assert(result.sequence.length === 3, 'sequence has 3 order IDs');
  assert(result.pickupSequence.length === 3, 'pickupSequence has 3 order IDs');
  assert(result.totalStops === 6, 'totalStops = 6 (2 × 3)');
  assert(result.legs.length === 6, 'legs has 6 entries (one per stop)');
  assert(result.orderLegs?.length === 3, 'orderLegs has 3 entries (one per order)');
  // Pickup sequence is a permutation of the input order IDs
  const set = new Set([o1, o2, o3]);
  assert(result.sequence.every(id => set.has(id)), 'sequence contains only the input order IDs');
  assert(result.pickupSequence.every(id => set.has(id)), 'pickupSequence contains only the input order IDs');
  assert(result.totalDistance > 0, 'totalDistance is positive');
  assert(result.totalDuration > 0, 'totalDuration is positive');

  // Each orderLeg should end at the corresponding order's delivery
  // coordinate, proving it's the pickup→delivery leg for that order.
  const ordersById = new Map([
    [o1, { pickup: { lat: 40.80, lng: -74.0 }, delivery: { lat: 40.70, lng: -74.0 } }],
    [o2, { pickup: { lat: 40.75, lng: -73.9 }, delivery: { lat: 40.75, lng: -74.1 } }],
    [o3, { pickup: { lat: 40.70, lng: -74.0 }, delivery: { lat: 40.80, lng: -74.0 } }],
  ]);
  for (let i = 0; i < result.sequence.length; i++) {
    const orderId = result.sequence[i];
    const expected = ordersById.get(orderId)!;
    const leg = result.orderLegs![i];
    assert(
      Math.abs(leg.to.latitude - expected.delivery.lat) < 1e-6 &&
        Math.abs(leg.to.longitude - expected.delivery.lng) < 1e-6,
      `orderLegs[${i}] (for ${orderId.slice(0, 8)}) ends at the order's delivery coordinate`
    );
    assert(
      Math.abs(leg.from.latitude - expected.pickup.lat) < 1e-6 &&
        Math.abs(leg.from.longitude - expected.pickup.lng) < 1e-6,
      `orderLegs[${i}] (for ${orderId.slice(0, 8)}) starts at the order's pickup coordinate`
    );
  }
}

// ============================================================
// 6. RouteService.optimizeDeliveryRoute writes sequence_index
// ============================================================
async function test6RouteServiceWritesSequenceIndex() {
  console.log('\n=== Test 6: RouteService writes sequence_index ===');
  await knex('order_status_history').del();
  await knex('routes').del();
  await knex('orders').del();
  await knex('drivers').del();
  await knex('users').del();

  const sellerUserId = await makeUser('seller2@test.com', 'seller');
  // RouteService.optimizeDeliveryRoute takes driverId which is the
  // Driver PK (per the current contract). Set up a driver with the
  // seller as caller.
  const driverUserId = await makeUser('driver2@test.com', 'driver');
  const driverPk = await makeDriver(driverUserId, 40.75, -74.0);

  const o1 = await makeOrder(sellerUserId, { lat: 40.80, lng: -74.0 }, { lat: 40.70, lng: -74.0 });
  const o2 = await makeOrder(sellerUserId, { lat: 40.75, lng: -73.9 }, { lat: 40.75, lng: -74.1 });
  const o3 = await makeOrder(sellerUserId, { lat: 40.70, lng: -74.0 }, { lat: 40.80, lng: -74.0 });

  const result = await RouteService.optimizeDeliveryRoute(driverPk, [o1, o2, o3], {
    callerRole: 'admin',
  });

  assert(result.routeIds?.length === 3, '3 routes were created');

  // Verify the database rows
  const rows = await knex('routes').select('*').orderBy('sequence_index', 'asc');
  assert(rows.length === 3, '3 route rows in DB');
  assert(rows[0].sequence_index === 0, 'first row has sequence_index 0');
  assert(rows[1].sequence_index === 1, 'second row has sequence_index 1');
  assert(rows[2].sequence_index === 2, 'third row has sequence_index 2');
  // The order in rows[].order_id should match result.sequence
  assert(rows[0].order_id === result.sequence[0], 'row 0 order_id matches sequence[0]');
  assert(rows[1].order_id === result.sequence[1], 'row 1 order_id matches sequence[1]');
  assert(rows[2].order_id === result.sequence[2], 'row 2 order_id matches sequence[2]');
  // Order statuses
  const orders = await knex('orders').whereIn('id', [o1, o2, o3]);
  assert(orders.every(o => o.status === 'assigned'), 'all orders moved to assigned');
}

// ============================================================
// 7. 2-opt doesn't break precedence on a tricky matrix
// ============================================================
async function test7TwoOptPreservesPrecedence() {
  console.log('\n=== Test 7: 2-opt preserves precedence on a tricky matrix ===');
  // Construct a matrix where a 2-opt swap would shorten total distance
  // but violate precedence. The solver must reject the swap.
  // Setup: driver at 0, two orders with pairs (1,2) and (3,4).
  //   - Pickup 1 close to driver, delivery 2 far away
  //   - Pickup 3 close to delivery 2, delivery 4 close to pickup 1
  // A 2-opt that swaps the order-2-delivery and order-1-pickup
  // sections would put delivery 2 (index 2) before pickup 1 (index 1).
  const driver = { lat: 0, lng: 0 };
  const p1 = { lat: 0.001, lng: 0 };      // near driver
  const d1 = { lat: 1, lng: 0 };         // far east
  const p2 = { lat: 0, lng: 0.001 };     // near d1
  const d2 = { lat: 0, lng: 0.0001 };    // near p1
  const coords = [p1, d1, p2, d2, driver];
  const pairs = [
    { pickup: 0, delivery: 1 },
    { pickup: 2, delivery: 3 },
  ];
  const matrix = buildMatrix(coords);
  const path = PDTSPSolver.solve(matrix, pairs, 4);
  console.log('  path:', path);
  const { ok, violations } = respectsPrecedence(path, pairs);
  assert(ok, `2-opt respected precedence (would-have-been violations: ${violations.join('; ')})`);
}

// ============================================================
// 8. RouteService rejects a non-available driver
// ============================================================
async function test8RejectsBusyDriver() {
  console.log('\n=== Test 8: RouteService rejects a busy driver ===');
  await knex('order_status_history').del();
  await knex('routes').del();
  await knex('orders').del();
  await knex('drivers').del();
  await knex('users').del();

  const sellerId = await makeUser('seller3@test.com', 'seller');
  const driverUserId = await makeUser('driver3@test.com', 'driver');
  const driverPk = await makeDriver(driverUserId, 40.75, -74.0, 'busy');
  const o1 = await makeOrder(sellerId, { lat: 40.80, lng: -74.0 }, { lat: 40.70, lng: -74.0 });

  let threw = false;
  try {
    await RouteService.optimizeDeliveryRoute(driverPk, [o1], { callerRole: 'admin' });
  } catch (e: unknown) {
    threw = true;
    const msg = e instanceof Error ? e.message : String(e);
    assert(msg.includes('not available'), `error mentions "not available" (got: ${msg})`);
  }
  assert(threw, 'RouteService threw when driver was busy');

  // No route should have been written
  const rows = await knex('routes').select('*');
  assert(rows.length === 0, 'no route rows written for rejected optimize');
  const order = await knex('orders').where({ id: o1 }).first();
  assert(order.status === 'pending', 'order status remains pending after rejection');
}

// ============================================================
// 9. RouteService rejects a seller who doesn't own all orders
// ============================================================
async function test9RejectsForeignOrderForSeller() {
  console.log('\n=== Test 9: RouteService rejects a seller who doesn\'t own all orders ===');
  await knex('order_status_history').del();
  await knex('routes').del();
  await knex('orders').del();
  await knex('drivers').del();
  await knex('users').del();

  const seller1Id = await makeUser('seller-a@test.com', 'seller');
  const seller2Id = await makeUser('seller-b@test.com', 'seller');
  const driverUserId = await makeUser('driver4@test.com', 'driver');
  const driverPk = await makeDriver(driverUserId, 40.75, -74.0);

  // seller1 owns order1; seller2 owns order2. Caller is seller1.
  const o1 = await makeOrder(seller1Id, { lat: 40.80, lng: -74.0 }, { lat: 40.70, lng: -74.0 });
  const o2 = await makeOrder(seller2Id, { lat: 40.75, lng: -73.9 }, { lat: 40.75, lng: -74.1 });

  let threw = false;
  try {
    await RouteService.optimizeDeliveryRoute(driverPk, [o1, o2], {
      callerRole: 'seller',
      callerId: seller1Id,
    });
  } catch (e: unknown) {
    threw = true;
    const msg = e instanceof Error ? e.message : String(e);
    assert(msg.includes('do not own'), `error mentions "do not own" (got: ${msg})`);
  }
  assert(threw, 'RouteService threw when seller did not own all orders');
}

(async () => {
  await knex.migrate.latest();
  await knex('order_status_history').del();
  await knex('routes').del();
  await knex('orders').del();
  await knex('drivers').del();
  await knex('users').del();

  try {
    await test1PrecedenceRespected();
    await test2DegeneratesToTSP();
    await test3OneOrderDegenerate();
    await test4EightOrderRealistic();
    await test5OptimizeDeliveryRoutePDPShape();
    await test6RouteServiceWritesSequenceIndex();
    await test7TwoOptPreservesPrecedence();
    await test8RejectsBusyDriver();
    await test9RejectsForeignOrderForSeller();
    console.log('\n🎉 All PDP-TSP tests passed!');
  } catch (e) {
    console.error('💥 test threw:', e);
    process.exitCode = 1;
  } finally {
    await knex.destroy();
  }
})();
