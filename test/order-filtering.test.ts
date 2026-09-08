/**
 * Tests for the GET /orders and GET /orders/my filtering.
 *
 * The endpoint is exercised through the exported
 * `buildOrderListQuery` helper, not through the live Express stack.
 * That keeps the test surface small (no JWT minting, no
 * supertest dep) while still covering the SQL WHERE-clause logic
 * the controller delegates to the helper.
 *
 * Tests:
 *   1. Admin scope: builds a query that returns all orders (no
 *      seller filter when sellerId is undefined).
 *   2. Seller scope: when sellerId is supplied, the query filters
 *      to that seller's orders only.
 *   3. Status filter: only matching status is returned.
 *   4. Date range: inclusive bounds on created_at.
 *   5. Driver filter: only orders assigned to that driver.
 *   6. Search by customer name: case-insensitive substring.
 *   7. Search by id prefix.
 *   8. Vehicle-type filter: routed orders whose route's vehicle
 *      matches; un-routed orders are excluded.
 *   9. Combined filters: status + search + driver intersect.
 *  10. Pagination: dataQuery + countQuery + limit/offset work
 *      end-to-end against the seed data.
 *
 * Run: NODE_ENV=test timeout 90 node --import \
 *   "file:///C:/Users/rohit/Downloads/routeflow/node_modules/tsx/dist/loader.mjs" \
 *   test/order-filtering.test.ts
 */
import { knex } from '../src/config/database';
import { buildOrderListQuery, OrderListFilters } from '../src/controllers/api.controller';
import { encryptObject } from '../src/config/encryption';

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
  return u.id as string;
}

/**
 * Create the `sellers` profile row for a seller-role user. The
 * `vehicles` and `routes_typed` tables FK to `sellers.id`, so any test
 * that exercises those tables must call this first.
 */
async function makeSellerProfile(userId: string): Promise<string> {
  const [s] = await knex('sellers')
    .insert({
      user_id: userId,
      business_name: `Business-${userId.slice(0, 6)}`,
      status: 'active',
    })
    .returning('id');
  return s.id as string;
}

async function makeDriver(
  userId: string,
  lat: number,
  lng: number
): Promise<string> {
  const [d] = await knex('drivers')
    .insert({
      user_id: userId,
      current_latitude: lat,
      current_longitude: lng,
      availability_status: 'available',
      current_workload: 0,
    })
    .returning('id');
  return d.id as string;
}

interface MakeOrderOpts {
  sellerId: string;
  driverId: string | null;
  customerName: string;
  customerPhone?: string;
  status: 'pending' | 'assigned' | 'picked_up' | 'on_the_way' | 'delivered' | 'cancelled';
  createdAt: Date;
  routeId?: string | null;
}

async function makeOrder(opts: MakeOrderOpts): Promise<string> {
  const [o] = await knex('orders')
    .insert({
      seller_id: opts.sellerId,
      driver_id: opts.driverId,
      customer_name: opts.customerName,
      customer_phone: opts.customerPhone ?? '+10000000000',
      delivery_address: 'Test',
      latitude: 40.0,
      longitude: -74.0,
      delivery_latitude: 40.0,
      delivery_longitude: -74.0,
      parcel_details: encryptObject({ weight: 1 }),
      status: opts.status,
      created_at: opts.createdAt,
      updated_at: opts.createdAt,
      route_id: opts.routeId ?? null,
    })
    .returning('id');
  return o.id as string;
}

async function makeVehicle(sellerId: string, type: 'motorcycle' | 'car' | 'van' | 'truck' | 'bicycle'): Promise<string> {
  const [v] = await knex('vehicles')
    .insert({
      seller_id: sellerId,
      type,
      plate_number: `TEST-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      brand: 'TestBrand',
      model: 'TestModel',
      year: 2024,
      capacity_weight: 1000,
      capacity_volume: 5,
      status: 'active',
    })
    .returning('id');
  return v.id as string;
}

async function makeRouteTyped(sellerId: string, vehicleId: string, orderIds: string[]): Promise<string> {
  const [r] = await knex('routes_typed')
    .insert({
      seller_id: sellerId,
      name: 'Test route',
      start_location: JSON.stringify({ lat: 40, lng: -74 }),
      end_location: JSON.stringify({ lat: 40, lng: -74 }),
      waypoints: JSON.stringify([]),
      vehicle_id: vehicleId,
      order_ids: JSON.stringify(orderIds),
      status: 'PLANNED',
    })
    .returning('id');
  return r.id as string;
}

async function resetState() {
  await knex('order_status_history').del();
  await knex('order_items').del();
  await knex('routes_typed').del();
  await knex('routes').del();
  await knex('orders').del();
  await knex('vehicles').del();
  await knex('drivers').del();
  await knex('users').del();
  // Wipe sellers too — the routes_typed.seller_id FK points at
  // the sellers table, so leftover rows can cause FK errors.
  await knex('sellers').del();
}

/**
 * Run a query and return both the rows and the count. Mirrors
 * what the controller does in production, minus the `toTyped`
 * mapping (we only need the raw shape for assertions).
 */
async function runQuery(
  sellerId: string | undefined,
  filters: OrderListFilters,
  options: { page?: number; limit?: number } = {}
): Promise<{ rows: any[]; total: number }> {
  const { dataQuery, countQuery } = buildOrderListQuery(sellerId, filters);
  const totalRow = await countQuery.count<{ count: string }>('orders.id as count').first();
  const total = Number(totalRow?.count ?? 0);
  const limit = options.limit ?? 100;
  const offset = ((options.page ?? 1) - 1) * limit;
  const rows = await dataQuery
    .clone()
    .orderBy('orders.created_at', 'desc')
    .limit(limit)
    .offset(offset);
  return { rows, total };
}

// ============================================================
// 1. Admin scope — sellerId undefined returns all orders
// ============================================================
async function test1AdminSeesAllOrders() {
  console.log('\n=== Test 1: admin scope (no sellerId) returns all orders ===');
  await resetState();

  const sellerA = await makeUser('a-seller@test.com', 'seller');
  const sellerB = await makeUser('b-seller@test.com', 'seller');
  const now = new Date();

  await makeOrder({ sellerId: sellerA, driverId: null, customerName: 'A1', status: 'pending', createdAt: now });
  await makeOrder({ sellerId: sellerB, driverId: null, customerName: 'B1', status: 'pending', createdAt: now });

  // sellerId === undefined mimics an admin request.
  const { rows, total } = await runQuery(undefined, {});

  assert(total === 2, `total is 2 across both sellers (got: ${total})`);
  assert(rows.length === 2, `2 rows returned (got: ${rows.length})`);
  const sellerIds = new Set(rows.map((r) => r.seller_id));
  assert(
    sellerIds.has(sellerA) && sellerIds.has(sellerB),
    `result set contains both sellers (got: ${[...sellerIds].join(', ')})`
  );
}

// ============================================================
// 2. Seller scope — only own orders
// ============================================================
async function test2SellerSeesOnlyOwn() {
  console.log('\n=== Test 2: seller scope returns only own orders ===');
  await resetState();

  const sellerA = await makeUser('a2-seller@test.com', 'seller');
  const sellerB = await makeUser('b2-seller@test.com', 'seller');
  const now = new Date();

  await makeOrder({ sellerId: sellerA, driverId: null, customerName: 'A2', status: 'pending', createdAt: now });
  await makeOrder({ sellerId: sellerB, driverId: null, customerName: 'B2', status: 'pending', createdAt: now });

  const { rows, total } = await runQuery(sellerA, {});

  assert(total === 1, `total is 1 (only seller A's order; got: ${total})`);
  assert(rows.length === 1, `1 row returned (got: ${rows.length})`);
  assert(rows[0].seller_id === sellerA, `row is seller A's (got: ${rows[0].seller_id})`);
}

// ============================================================
// 3. Status filter
// ============================================================
async function test3StatusFilter() {
  console.log('\n=== Test 3: status filter ===');
  await resetState();

  const sellerId = await makeUser('s3@test.com', 'seller');
  const now = new Date();
  await makeOrder({ sellerId, driverId: null, customerName: 'D1', status: 'delivered', createdAt: now });
  await makeOrder({ sellerId, driverId: null, customerName: 'D2', status: 'delivered', createdAt: now });
  await makeOrder({ sellerId, driverId: null, customerName: 'P1', status: 'pending', createdAt: now });

  const { rows, total } = await runQuery(sellerId, { status: 'delivered' });

  assert(total === 2, `total is 2 delivered orders (got: ${total})`);
  assert(rows.every((r) => r.status === 'delivered'), `every row is 'delivered'`);
}

// ============================================================
// 4. Date range filter (inclusive bounds)
// ============================================================
async function test4DateRangeFilter() {
  console.log('\n=== Test 4: date range filter (inclusive bounds) ===');
  await resetState();

  const sellerId = await makeUser('s4@test.com', 'seller');
  // Three orders at three timestamps; window covers the middle one.
  const jan1 = new Date('2026-01-01T00:00:00Z');
  const feb1 = new Date('2026-02-01T00:00:00Z');
  const mar1 = new Date('2026-03-01T00:00:00Z');
  await makeOrder({ sellerId, driverId: null, customerName: 'JAN', status: 'pending', createdAt: jan1 });
  await makeOrder({ sellerId, driverId: null, customerName: 'FEB', status: 'pending', createdAt: feb1 });
  await makeOrder({ sellerId, driverId: null, customerName: 'MAR', status: 'pending', createdAt: mar1 });

  const { rows, total } = await runQuery(sellerId, {
    startDate: '2026-01-15',
    endDate: '2026-02-15',
  });

  assert(total === 1, `only the FEB order is in the window (got: ${total})`);
  assert(rows[0]?.customer_name === 'FEB', `the matched row is FEB (got: ${rows[0]?.customer_name})`);
}

// ============================================================
// 5. Driver filter
// ============================================================
async function test5DriverFilter() {
  console.log('\n=== Test 5: driver filter ===');
  await resetState();

  const sellerId = await makeUser('s5@test.com', 'seller');
  const driverUser1 = await makeUser('d5a@test.com', 'driver');
  const driverUser2 = await makeUser('d5b@test.com', 'driver');
  const driver1 = await makeDriver(driverUser1, 40, -74);
  const driver2 = await makeDriver(driverUser2, 40, -74);
  const now = new Date();

  await makeOrder({ sellerId, driverId: driver1, customerName: 'With D1', status: 'assigned', createdAt: now });
  await makeOrder({ sellerId, driverId: driver2, customerName: 'With D2', status: 'assigned', createdAt: now });
  await makeOrder({ sellerId, driverId: null, customerName: 'Unassigned', status: 'pending', createdAt: now });

  const { rows, total } = await runQuery(sellerId, { driverId: driver1 });

  assert(total === 1, `only D1's order matches (got: ${total})`);
  assert(rows[0]?.customer_name === 'With D1', `row is D1's order (got: ${rows[0]?.customer_name})`);
}

// ============================================================
// 6. Search by customer name (case-insensitive)
// ============================================================
async function test6SearchByName() {
  console.log('\n=== Test 6: search by customer name (case-insensitive) ===');
  await resetState();

  const sellerId = await makeUser('s6@test.com', 'seller');
  const now = new Date();
  await makeOrder({ sellerId, driverId: null, customerName: 'Alice Wonderland', status: 'pending', createdAt: now });
  await makeOrder({ sellerId, driverId: null, customerName: 'Bob Builder', status: 'pending', createdAt: now });
  // 'ALICE' is also a match (case-insensitive); 'Alicia' is NOT
  // a match because Postgres ILIKE is a substring check — "Alicia"
  // does not contain the substring "Alice".
  await makeOrder({ sellerId, driverId: null, customerName: 'ALICE Cooper', status: 'pending', createdAt: now });

  const { rows, total } = await runQuery(sellerId, { search: 'alice' });

  assert(total === 2, `2 rows match 'alice' (case-insensitive; got: ${total})`);
  const names = rows.map((r) => r.customer_name).sort();
  assert(
    JSON.stringify(names) === JSON.stringify(['ALICE Cooper', 'Alice Wonderland']),
    `matched names are Alice + ALICE (got: ${names.join(', ')})`
  );
}

// ============================================================
// 7. Search by id prefix
// ============================================================
async function test7SearchByIdPrefix() {
  console.log('\n=== Test 7: search by id prefix ===');
  await resetState();

  const sellerId = await makeUser('s7@test.com', 'seller');
  const now = new Date();
  const idA = await makeOrder({ sellerId, driverId: null, customerName: 'A', status: 'pending', createdAt: now });
  await makeOrder({ sellerId, driverId: null, customerName: 'B', status: 'pending', createdAt: now });
  const idC = await makeOrder({ sellerId, driverId: null, customerName: 'C', status: 'pending', createdAt: now });

  // Take the first 8 chars of idA and search for that. The other
  // IDs are random UUIDs and very unlikely to share that prefix.
  const prefix = idA.slice(0, 8);
  const { rows, total } = await runQuery(sellerId, { search: prefix });

  assert(total === 1, `1 row matches the id prefix (got: ${total})`);
  assert(rows[0]?.id === idA, `matched row is the seeded one (got: ${rows[0]?.id})`);
  // Sanity: idC is a different row entirely.
  assert(idA !== idC, 'seeded ids are distinct (sanity check)');
}

// ============================================================
// 8. Vehicle-type filter via routes_typed
// ============================================================
async function test8VehicleTypeFilter() {
  console.log('\n=== Test 8: vehicle-type filter via routes_typed join ===');
  await resetState();

  // `orders.seller_id` FKs to users.id, but `vehicles.seller_id` and
  // `routes_typed.seller_id` FK to sellers.id. We need both — the
  // user row carries the order authorship, the seller profile
  // carries the fleet.
  const sellerUserId = await makeUser('s8@test.com', 'seller');
  const sellerProfileId = await makeSellerProfile(sellerUserId);
  const now = new Date();

  // Three orders: one routed with a van, one routed with a car, one
  // un-routed. vehicleType=van should return exactly the first.
  const vanId = await makeVehicle(sellerProfileId, 'van');
  const carId = await makeVehicle(sellerProfileId, 'car');
  const vanOrderId = await makeOrder({ sellerId: sellerUserId, driverId: null, customerName: 'VAN', status: 'assigned', createdAt: now });
  const carOrderId = await makeOrder({ sellerId: sellerUserId, driverId: null, customerName: 'CAR', status: 'assigned', createdAt: now });
  await makeOrder({ sellerId: sellerUserId, driverId: null, customerName: 'NONE', status: 'pending', createdAt: now });

  await makeRouteTyped(sellerProfileId, vanId, [vanOrderId]);
  await makeRouteTyped(sellerProfileId, carId, [carOrderId]);

  // The two routes are distinguishable by the vehicle they were built
  // for — fetch both and patch the orders' route_id column with the
  // matching route.
  const routes = await knex('routes_typed').where({ seller_id: sellerProfileId }).select('id', 'vehicle_id');
  const vanRoute = routes.find((r) => r.vehicle_id === vanId);
  const carRoute = routes.find((r) => r.vehicle_id === carId);
  await knex('orders').where({ id: vanOrderId }).update({ route_id: vanRoute?.id });
  await knex('orders').where({ id: carOrderId }).update({ route_id: carRoute?.id });

  // van filter
  const vanResult = await runQuery(sellerUserId, { vehicleType: 'van' });
  assert(vanResult.total === 1, `vehicleType=van → 1 order (got: ${vanResult.total})`);
  assert(vanResult.rows[0]?.customer_name === 'VAN', `matched row is VAN (got: ${vanResult.rows[0]?.customer_name})`);

  // car filter
  const carResult = await runQuery(sellerUserId, { vehicleType: 'car' });
  assert(carResult.total === 1, `vehicleType=car → 1 order (got: ${carResult.total})`);
  assert(carResult.rows[0]?.customer_name === 'CAR', `matched row is CAR (got: ${carResult.rows[0]?.customer_name})`);

  // motorcycle filter — no order uses one, so the result is empty
  // (the un-routed order is excluded because the route_id IN subquery
  // doesn't include NULL).
  const motoResult = await runQuery(sellerUserId, { vehicleType: 'motorcycle' });
  assert(motoResult.total === 0, `vehicleType=motorcycle → 0 (un-routed order excluded; got: ${motoResult.total})`);
}

// ============================================================
// 9. Combined filters intersect
// ============================================================
async function test9CombinedFilters() {
  console.log('\n=== Test 9: combined filters intersect (status + search + driver) ===');
  await resetState();

  const sellerId = await makeUser('s9@test.com', 'seller');
  const driverUser1 = await makeUser('d9a@test.com', 'driver');
  const driverUser2 = await makeUser('d9b@test.com', 'driver');
  const driver1 = await makeDriver(driverUser1, 40, -74);
  const driver2 = await makeDriver(driverUser2, 40, -74);
  const now = new Date();

  // Two delivered orders, one with Alice+D1, one with Bob+D2.
  // Plus an Alice+D1 that's still pending — must NOT match.
  await makeOrder({ sellerId, driverId: driver1, customerName: 'Alice', status: 'delivered', createdAt: now });
  await makeOrder({ sellerId, driverId: driver2, customerName: 'Bob', status: 'delivered', createdAt: now });
  await makeOrder({ sellerId, driverId: driver1, customerName: 'Alice', status: 'pending', createdAt: now });

  const { rows, total } = await runQuery(sellerId, {
    status: 'delivered',
    search: 'Alice',
    driverId: driver1,
  });

  assert(total === 1, `only the Alice+D1+delivered order matches (got: ${total})`);
  assert(rows[0]?.status === 'delivered', `row is delivered`);
  assert(rows[0]?.customer_name === 'Alice', `row is Alice`);
  assert(rows[0]?.driver_id === driver1, `row is D1's`);
}

// ============================================================
// 10. Pagination — limit/offset + meta.total
// ============================================================
async function test10Pagination() {
  console.log('\n=== Test 10: pagination — limit/offset + meta.total ===');
  await resetState();

  const sellerId = await makeUser('s10@test.com', 'seller');
  // Seed 5 orders, each one second apart so created_at desc gives
  // a stable order for slicing.
  const base = new Date('2026-01-01T00:00:00Z');
  for (let i = 0; i < 5; i++) {
    const t = new Date(base.getTime() + i * 1000);
    await makeOrder({
      sellerId,
      driverId: null,
      customerName: `Order-${i}`,
      status: 'pending',
      createdAt: t,
    });
  }

  // Page 1, limit 2 → newest two (Order-4, Order-3)
  const p1 = await runQuery(sellerId, {}, { page: 1, limit: 2 });
  assert(p1.total === 5, `total is 5 (got: ${p1.total})`);
  assert(p1.rows.length === 2, `page 1 returns 2 rows (got: ${p1.rows.length})`);
  assert(p1.rows[0]?.customer_name === 'Order-4', `page 1 row 0 is Order-4 (got: ${p1.rows[0]?.customer_name})`);
  assert(p1.rows[1]?.customer_name === 'Order-3', `page 1 row 1 is Order-3 (got: ${p1.rows[1]?.customer_name})`);

  // Page 2, limit 2 → next two
  const p2 = await runQuery(sellerId, {}, { page: 2, limit: 2 });
  assert(p2.rows.length === 2, `page 2 returns 2 rows (got: ${p2.rows.length})`);
  assert(p2.rows[0]?.customer_name === 'Order-2', `page 2 row 0 is Order-2 (got: ${p2.rows[0]?.customer_name})`);
  assert(p2.rows[1]?.customer_name === 'Order-1', `page 2 row 1 is Order-1 (got: ${p2.rows[1]?.customer_name})`);

  // Page 3, limit 2 → last one
  const p3 = await runQuery(sellerId, {}, { page: 3, limit: 2 });
  assert(p3.rows.length === 1, `page 3 returns 1 row (got: ${p3.rows.length})`);
  assert(p3.rows[0]?.customer_name === 'Order-0', `page 3 row 0 is Order-0 (got: ${p3.rows[0]?.customer_name})`);
}

(async () => {
  await knex.migrate.latest();
  await resetState();

  try {
    await test1AdminSeesAllOrders();
    await test2SellerSeesOnlyOwn();
    await test3StatusFilter();
    await test4DateRangeFilter();
    await test5DriverFilter();
    await test6SearchByName();
    await test7SearchByIdPrefix();
    await test8VehicleTypeFilter();
    await test9CombinedFilters();
    await test10Pagination();
    console.log('\n🎉 All order-filtering tests passed!');
  } catch (e) {
    console.error('💥 test threw:', e);
    process.exitCode = 1;
  } finally {
    await knex.destroy();
  }
})();
