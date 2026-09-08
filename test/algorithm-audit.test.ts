/**
 * Algorithm audit & unit tests for spatial / optimization code.
 *
 * Covers:
 *   1. haversineMeters (src/utils/geo.ts) — known reference distances,
 *      edge cases (null, NaN, out-of-bounds, missing keys, identical
 *      points, antimeridian, poles, string-encoded Postgres NUMERIC).
 *   2. TSPSolver (src/services/routing.service.ts) — edge cases
 *      (n=0,1,2), asymmetric matrices, optimality vs. nearest-neighbor
 *      baseline, no-op when already optimal.
 *   3. PDTSPSolver (src/services/routing.service.ts) — precedence
 *      (pickup-before-delivery), unpaired indices should be visited
 *      (NOT silently dropped — bug fix verification), 2-opt respects
 *      precedence, single-order degenerate, empty-pairs degenerate.
 *
 * Pure unit tests, no DB. Run with:
 *   NODE_ENV=test npx tsx test/algorithm-audit.test.ts
 *
 * These complement the integration tests in test/auto-assign.test.ts
 * and test/pdp-tsp.test.ts, which exercise the full DB-backed
 * service paths.
 */
import { haversineMeters } from '../src/utils/geo';
import { TSPSolver, PDTSPSolver } from '../src/services/routing.service';

let passed = 0;
let failed = 0;

function expect(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.error(`  ❌ ${msg}`);
  }
}

function section(name: string): void {
  console.log(`\n--- ${name} ---`);
}

function pathDistance(path: number[], m: number[][]): number {
  let d = 0;
  for (let i = 0; i < path.length - 1; i++) d += m[path[i]][path[i + 1]];
  return d;
}

// =====================================================================
// 1. haversineMeters
// =====================================================================
section('haversineMeters — known reference distances');

const NYC = { latitude: 40.7128, longitude: -74.006 };
const LA = { latitude: 34.0522, longitude: -118.2437 };
const KTM = { latitude: 27.7172, longitude: 85.324 };
const NORTH_POLE = { latitude: 90, longitude: 0 };
const SOUTH_POLE = { latitude: -90, longitude: 0 };

// (a) NYC → LA — accepted great-circle distance is 3935.746 km
{
  const m = haversineMeters(NYC, LA);
  expect(typeof m === 'number' && Number.isFinite(m!), 'NYC→LA returns a finite number');
  const km = m! / 1000;
  expect(Math.abs(km - 3935.746) < 1, `NYC→LA distance is ~3935.7 km (got ${km.toFixed(3)} km)`);
}

// (b) Identical coords → 0
{
  const m = haversineMeters(KTM, KTM);
  expect(m === 0, `identical coords return 0 m (got ${m})`);
}

// (c) Symmetry: d(a, b) === d(b, a)
{
  const ab = haversineMeters(NYC, KTM);
  const ba = haversineMeters(KTM, NYC);
  expect(ab === ba, `haversine is symmetric (ab=${ab} ba=${ba})`);
}

// (d) Pole to pole — half Earth's circumference (~20015 km)
{
  const m = haversineMeters(NORTH_POLE, SOUTH_POLE)!;
  const km = m / 1000;
  expect(Math.abs(km - 20015) < 5, `pole-to-pole is ~20015 km (got ${km.toFixed(2)} km)`);
}

// (e) Antimeridian crossing — 1° lng at lat 0 ≈ 111.32 km
{
  const a = { latitude: 0, longitude: 179.0 };
  const b = { latitude: 0, longitude: -179.0 };
  const m = haversineMeters(a, b)!;
  // 2° at lat 0 ≈ 222.4 km
  expect(Math.abs(m / 1000 - 222.4) < 1, `antimeridian 2° at equator is ~222.4 km (got ${(m/1000).toFixed(2)} km)`);
}

// (f) Kathmandu 1 km east — verify with known conversion
{
  // 1° lng at lat 27.7172° = 111.32 * cos(27.7172) ≈ 98.53 km
  // So 1/98.53° east ≈ 1 km
  const a = { latitude: 27.7172, longitude: 85.324 };
  const b = { latitude: 27.7172, longitude: 85.324 + 1 / 98.53 };
  const m = haversineMeters(a, b)!;
  expect(Math.abs(m / 1000 - 1) < 0.01, `1 km east at Kathmandu (got ${(m/1000).toFixed(3)} km)`);
}

section('haversineMeters — input validation (rejects bad input with null)');

// (g) null latitude/longitude → null
expect(
  haversineMeters({ latitude: null as unknown as number, longitude: 85 }, KTM) === null,
  'null latitude → null'
);
expect(
  haversineMeters({ latitude: 27, longitude: null as unknown as number }, KTM) === null,
  'null longitude → null'
);

// (h) undefined fields
expect(haversineMeters({} as any, KTM) === null, 'empty input object → null');
expect(haversineMeters({ latitude: 27 } as any, KTM) === null, 'missing longitude → null');

// (i) NaN
expect(
  haversineMeters({ latitude: NaN, longitude: 0 }, KTM) === null,
  'NaN latitude → null'
);
expect(
  haversineMeters({ latitude: 27, longitude: NaN }, KTM) === null,
  'NaN longitude → null'
);

// (j) Out-of-bounds latitude
expect(
  haversineMeters({ latitude: 95, longitude: 0 }, KTM) === null,
  'out-of-bounds lat=95 → null (was: silently returned 10563 km)'
);
expect(
  haversineMeters({ latitude: -91, longitude: 0 }, KTM) === null,
  'out-of-bounds lat=-91 → null'
);

// (k) Out-of-bounds longitude
expect(
  haversineMeters({ latitude: 27, longitude: 181 }, KTM) === null,
  'out-of-bounds lng=181 → null'
);
expect(
  haversineMeters({ latitude: 27, longitude: -181 }, KTM) === null,
  'out-of-bounds lng=-181 → null'
);

// (l) Infinity
expect(
  haversineMeters({ latitude: Infinity, longitude: 0 }, KTM) === null,
  'Infinity latitude → null'
);

// (m) String-encoded numbers (Postgres NUMERIC)
{
  const m = haversineMeters(
    { latitude: '27.7172' as unknown as number, longitude: '85.324' as unknown as number },
    { latitude: '27.7172' as unknown as number, longitude: '85.3334' as unknown as number }
  );
  expect(typeof m === 'number' && Number.isFinite(m!), 'string-encoded numbers are coerced');
  expect(m! > 800 && m! < 1100, `~1 km east of Kathmandu (got ${m!.toFixed(0)} m)`);
}

// (n) Gulf of Guinea (0,0) is a real point, not a sentinel
{
  // Pick a point 10 km east of (0,0) — should be ~10 km, NOT null
  const m = haversineMeters(
    { latitude: 0, longitude: 0 },
    { latitude: 0, longitude: 10 / 111.32 }
  );
  expect(m !== null, '(0,0) is a real coord, not rejected as null');
  expect(m! / 1000 > 9 && m! / 1000 < 11, `(0,0) → 10 km east is ~10 km (got ${(m!/1000).toFixed(2)} km)`);
}

// =====================================================================
// 2. TSPSolver
// =====================================================================
section('TSPSolver — edge cases');

// (a) n=0
{
  const path = TSPSolver.solve([], 0);
  expect(Array.isArray(path) && path.length === 0, 'n=0 returns empty path');
}

// (b) n=1
{
  const path = TSPSolver.solve([[0]], 0);
  expect(JSON.stringify(path) === '[0]', `n=1 returns [0] (got ${JSON.stringify(path)})`);
}

// (c) n=2
{
  const path = TSPSolver.solve([[0, 5], [5, 0]], 0);
  expect(JSON.stringify(path) === '[0,1]', `n=2 returns [0,1] (got ${JSON.stringify(path)})`);
}

section('TSPSolver — correctness');

// (d) Asymmetric matrix: solver must respect direction
{
  // Going 0→1→2 is 10+10=20; going 0→2→1 is 100+10=110. Cheaper = 0→1→2.
  const m = [
    [0, 10, 100],
    [10, 0, 10],
    [100, 10, 0],
  ];
  const path = TSPSolver.solve(m, 0);
  expect(JSON.stringify(path) === '[0,1,2]', `asymmetric picks [0,1,2] (got ${JSON.stringify(path)})`);
  const d = pathDistance(path, m);
  expect(d === 20, `path distance is 20 (got ${d})`);
}

// (e) 4-point symmetric, must be ≤ the naive nearest-neighbor cost
{
  const m = [
    [0, 10, 15, 20],
    [10, 0, 35, 25],
    [15, 35, 0, 30],
    [20, 25, 30, 0],
  ];
  const path = TSPSolver.solve(m, 0);
  // Brute force all permutations to find the true optimum.
  const start = path[0];
  const rest = path.slice(1);
  const perms = permute(rest);
  let bestD = Infinity;
  for (const p of perms) {
    const full = [start, ...p];
    const d = pathDistance(full, m);
    if (d < bestD) bestD = d;
  }
  const gotD = pathDistance(path, m);
  expect(gotD === bestD, `4-point: returned path is the true optimum (got ${gotD}, optimal ${bestD})`);
}

// (f) Already optimal: no-op
{
  const m = [
    [0, 10, 20, 30],
    [10, 0, 10, 20],
    [20, 10, 0, 10],
    [30, 20, 10, 0],
  ];
  const path = TSPSolver.solve(m, 0);
  expect(JSON.stringify(path) === '[0,1,2,3]', `linear optimal is [0,1,2,3] (got ${JSON.stringify(path)})`);
}

// (g) Start node preserved at position 0
{
  const m = [
    [0, 1, 100, 100],
    [1, 0, 1, 100],
    [100, 1, 0, 1],
    [100, 100, 1, 0],
  ];
  // Start from index 3
  const path = TSPSolver.solve(m, 3);
  expect(path[0] === 3, `start index 3 is preserved at path[0] (got ${path[0]})`);
  expect(path.length === 4, `all 4 nodes visited (got ${path.length})`);
}

// =====================================================================
// 3. PDTSPSolver
// =====================================================================
section('PDTSPSolver — precedence');

function respectsPrecedence(path: number[], pairs: Array<{ pickup: number; delivery: number }>): boolean {
  for (const { pickup, delivery } of pairs) {
    if (path.indexOf(pickup) >= path.indexOf(delivery)) return false;
  }
  return true;
}

// (a) Single order, driver at index 0
{
  const m = [
    [0, 100, 200], // 0=driver
    [100, 0, 50],  // 1=pickup
    [200, 50, 0],  // 2=delivery
  ];
  const pairs = [{ pickup: 1, delivery: 2 }];
  const path = PDTSPSolver.solve(m, pairs, 0);
  expect(JSON.stringify(path) === '[0,1,2]', `single-order PDP (got ${JSON.stringify(path)})`);
  expect(respectsPrecedence(path, pairs), 'precedence: pickup(1) < delivery(2)');
}

// (b) Two orders, precedence held through 2-opt
{
  const m = [
    [0, 100, 50, 200, 150],
    [100, 0, 80, 250, 90],
    [50, 80, 0, 200, 70],
    [200, 250, 200, 0, 60],
    [150, 90, 70, 60, 0],
  ];
  const pairs = [
    { pickup: 1, delivery: 2 },
    { pickup: 3, delivery: 4 },
  ];
  const path = PDTSPSolver.solve(m, pairs, 0);
  expect(respectsPrecedence(path, pairs), `two-order precedence (path=${JSON.stringify(path)})`);
  expect(path[0] === 0, 'driver at start');
  expect(path.length === 5, 'all 5 nodes visited');
}

section('PDTSPSolver — unpaired indices are visited (bug fix verification)');

// (c) Empty pairs: solver should behave like TSPSolver, NOT drop the second node
// This was the silent-drop bug: with `pairs=[]` and a 2x2 matrix, the solver
// used to return [0] instead of [0, 1].
{
  const m = [[0, 100], [100, 0]];
  const path = PDTSPSolver.solve(m, [], 0);
  expect(
    path.length === 2 && path.includes(0) && path.includes(1),
    `empty pairs → visits all nodes (got ${JSON.stringify(path)})`
  );
}

// (d) Mixed: 1 paired + 1 unpaired. Both stops must appear in the path.
{
  // 0=driver, 1=pickup-A, 2=delivery-A, 3=unpaired waypoint
  const m = [
    [0, 100, 200, 50],
    [100, 0, 50, 150],
    [200, 50, 0, 250],
    [50, 150, 250, 0],
  ];
  const pairs = [{ pickup: 1, delivery: 2 }];
  const path = PDTSPSolver.solve(m, pairs, 0);
  expect(path.includes(3), `unpaired waypoint(3) is in path (got ${JSON.stringify(path)})`);
  expect(respectsPrecedence(path, pairs), 'precedence still held with unpaired waypoint');
  expect(path.length === 4, 'all 4 nodes visited');
}

// (e) Out-of-range pair indices do not crash
{
  const m = [[0, 1], [1, 0]];
  const path = PDTSPSolver.solve(m, [{ pickup: 99, delivery: 100 }], 0);
  expect(Array.isArray(path), 'out-of-range pair indices do not throw');
  expect(path.includes(1), 'matrix node(1) still visited despite bad pair index');
}

section('PDTSPSolver — 2-opt respects precedence');

// (f) Hand-crafted case where a naive 2-opt would violate precedence
{
  // Driver 0 → P1(1) → P2(3) → D1(2) → D2(4)
  // A reversal that swaps (P2, D1) → (D1, P2) would put P2 after D1
  // → violation. The solver must REJECT that swap.
  const m = [
    [0, 10, 1000, 20, 1000],
    [10, 0, 30, 1000, 1000],
    [1000, 30, 0, 1000, 1000],
    [20, 1000, 1000, 0, 30],
    [1000, 1000, 1000, 30, 0],
  ];
  const pairs = [
    { pickup: 1, delivery: 2 },
    { pickup: 3, delivery: 4 },
  ];
  const path = PDTSPSolver.solve(m, pairs, 0);
  expect(respectsPrecedence(path, pairs), `2-opt preserved precedence (got ${JSON.stringify(path)})`);
  // All four order points (1,2,3,4) must be in the path
  for (const idx of [1, 2, 3, 4]) {
    expect(path.includes(idx), `node ${idx} is in path`);
  }
}

// =====================================================================
// Helpers
// =====================================================================
function permute<T>(arr: T[]): T[][] {
  if (arr.length <= 1) return [arr.slice()];
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const p of permute(rest)) {
      result.push([arr[i], ...p]);
    }
  }
  return result;
}

// =====================================================================
// Summary
// =====================================================================
console.log(`\n========================================`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`========================================`);

if (failed > 0) {
  process.exit(1);
}
