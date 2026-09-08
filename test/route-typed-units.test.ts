/**
 * Unit-conversion regression test for RouteTypedService.normalize.
 *
 * The `routes_typed.estimated_distance` column is stored in METERS and
 * `estimated_duration` in SECONDS (the haversine + 30 km/h math
 * produces those base SI units). The frontend's `Route.totalDistance`
 * / `Route.estimatedDuration` fields and the list pages all expect
 * KILOMETERS and MINUTES — so the model layer has to convert at the
 * boundary, otherwise the driver routes page renders 9898.0 km /
 * 1188 min for a route that was actually 9.9 km / ~20 min.
 *
 * The test exercises the conversion by hand-rolling a fake DB row
 * with known meter/second values and asserting the normalized payload
 * reports km/min.
 *
 * Run:
 *   NODE_ENV=test npx tsx test/route-typed-units.test.ts
 */
import path from 'path';
import { config as dotenvConfig } from 'dotenv';
dotenvConfig({ path: path.resolve(__dirname, '../.env.test') });

import { knex } from '../src/config/database';
import { RouteTypedService } from '../src/services/route-typed.service';

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

// Reach into the private normalize via the prototype. Same trick the
// other typed-route tests use.
const normalize = (RouteTypedService as unknown as { normalize: (row: Record<string, unknown>) => unknown })
  .normalize.bind(RouteTypedService);

// =====================================================================
// 1. 9.9 km / 20 min — the exact values the driver was seeing
// =====================================================================
section('normalize converts meters→km and seconds→min');

{
  // 9 898 m, 1 188 s — the values the user reported rendered as
  // "9898.0 km · 1188 min" before the fix.
  const out = normalize({
    id: 'test-1',
    seller_id: 's1',
    name: 'Order TEST',
    description: null,
    start_location: { lat: 27.7172, lng: 85.324, name: 'P', address: {} },
    end_location: { lat: 27.7400, lng: 85.350, name: 'D', address: {} },
    waypoints: [],
    driver_id: 'd1',
    vehicle_id: null,
    scheduled_start_at: null,
    estimated_distance: 9898,
    estimated_duration: 1188,
    status: 'PLANNED',
    order_ids: [],
    created_at: '2026-09-07T00:00:00.000Z',
    updated_at: '2026-09-07T00:00:00.000Z',
  }) as { totalDistance: number; estimatedDistance: number; estimatedDuration: number };

  assert(Math.abs(out.totalDistance - 9.9) < 0.01, `totalDistance ≈ 9.9 km (got ${out.totalDistance})`);
  assert(Math.abs(out.estimatedDistance - 9.9) < 0.01, `estimatedDistance ≈ 9.9 km (got ${out.estimatedDistance})`);
  assert(out.estimatedDuration === 20, `estimatedDuration = 20 min (got ${out.estimatedDuration})`);

  // The exact value the user saw — make sure the fix actually
  // changes the displayed text, not just the unit.
  assert(out.totalDistance !== 9898, 'totalDistance is NOT 9898 (was the raw meter value)');
  assert(out.estimatedDuration !== 1188, 'estimatedDuration is NOT 1188 (was the raw second value)');
}

// =====================================================================
// 2. Other distances
// =====================================================================
section('normalize handles other distances correctly');

{
  // 0 / 0 — empty route, should still produce 0 / 0, not NaN.
  const out0 = normalize({
    id: 'z', seller_id: 's', name: 'Z', description: null,
    start_location: { lat: 0, lng: 0 }, end_location: { lat: 0, lng: 0 },
    waypoints: [], driver_id: null, vehicle_id: null,
    scheduled_start_at: null, estimated_distance: 0, estimated_duration: 0,
    status: 'PLANNED', order_ids: [],
    created_at: null, updated_at: null,
  }) as { totalDistance: number; estimatedDuration: number };
  assert(out0.totalDistance === 0, `0 m → 0 km (got ${out0.totalDistance})`);
  assert(out0.estimatedDuration === 0, `0 s → 0 min (got ${out0.estimatedDuration})`);

  // 1 km / ~2 min — a small intra-city delivery.
  const out1 = normalize({
    id: 'o', seller_id: 's', name: 'O', description: null,
    start_location: { lat: 0, lng: 0 }, end_location: { lat: 0, lng: 0 },
    waypoints: [], driver_id: null, vehicle_id: null,
    scheduled_start_at: null, estimated_distance: 1000, estimated_duration: 120,
    status: 'PLANNED', order_ids: [],
    created_at: null, updated_at: null,
  }) as { totalDistance: number; estimatedDuration: number };
  assert(Math.abs(out1.totalDistance - 1) < 0.01, `1000 m → 1 km (got ${out1.totalDistance})`);
  assert(out1.estimatedDuration === 2, `120 s → 2 min (got ${out1.estimatedDuration})`);

  // 12.343 km / 1481 s — the value the backfill script wrote for a
  // real Kathmandu → Bhaktapur route during the previous fix.
  const out12 = normalize({
    id: 't', seller_id: 's', name: 'T', description: null,
    start_location: { lat: 0, lng: 0 }, end_location: { lat: 0, lng: 0 },
    waypoints: [], driver_id: null, vehicle_id: null,
    scheduled_start_at: null, estimated_distance: 12343, estimated_duration: 1481,
    status: 'PLANNED', order_ids: [],
    created_at: null, updated_at: null,
  }) as { totalDistance: number; estimatedDuration: number };
  assert(Math.abs(out12.totalDistance - 12.34) < 0.01, `12343 m → 12.34 km (got ${out12.totalDistance})`);
  assert(out12.estimatedDuration === 25, `1481 s → 25 min (got ${out12.estimatedDuration})`);
}

// =====================================================================
// 3. List endpoints — read straight from the DB through the service
// to make sure no other layer is dividing or multiplying.
// =====================================================================
section('listByDriver returns the same km/min payload');

(async () => {
  await knex.migrate.latest();
  try {
    // Use the row the user actually saw.
    const rows = await knex('routes_typed')
      .select('id', 'name', 'estimated_distance', 'estimated_duration', 'status')
      .whereNot('estimated_distance', 0)
      .orderBy('created_at', 'desc')
      .limit(2);

    if (rows.length === 0) {
      console.log('  (no rows in DB; skipping integration check)');
    } else {
      // Create a real driver row so the FK accepts it, then attach the
      // route to that driver and re-query through listByDriver. If the
      // unit conversion regresses, this is where it shows up.
      const driverUserId = (await knex('users')
        .insert({ email: `unit-test-${Date.now()}@x.com`, password_hash: 'x', role: 'driver' })
        .returning('id'))[0].id;
      const driver = (await knex('drivers')
        .insert({ user_id: driverUserId, current_latitude: 0, current_longitude: 0, availability_status: 'available', current_workload: 0 })
        .returning('*'))[0];

      await knex('routes_typed')
        .where({ id: rows[0].id })
        .update({ driver_id: driver.id });

      const { routes } = await RouteTypedService.listByDriver(driver.id, { limit: 5 });
      const r = routes.find((x) => x.id === rows[0].id);
      if (!r) {
        assert(false, 'listByDriver returned the row we attached the driver to');
      } else {
        const meters = Number(rows[0].estimated_distance);
        const seconds = Number(rows[0].estimated_duration);
        const expectedKm = Number((meters / 1000).toFixed(2));
        const expectedMin = Math.round(seconds / 60);
        assert(
          Math.abs(r.totalDistance - expectedKm) < 0.01,
          `listByDriver totalDistance = ${expectedKm} km (got ${r.totalDistance})`
        );
        assert(
          r.estimatedDuration === expectedMin,
          `listByDriver estimatedDuration = ${expectedMin} min (got ${r.estimatedDuration})`
        );
      }

      // Clean up so the rest of the suite isn't polluted.
      await knex('routes_typed')
        .where({ id: rows[0].id })
        .update({ driver_id: null });
      await knex('drivers').where({ id: driver.id }).del();
      await knex('users').where({ id: driverUserId }).del();
    }

    console.log(`\n========================================`);
    console.log(`  ${pass} passed, ${fail} failed`);
    console.log(`========================================`);
    if (fail > 0) process.exit(1);
  } catch (e) {
    console.error('💥 test threw:', e);
    process.exitCode = 1;
  } finally {
    await knex.destroy();
  }
})();
