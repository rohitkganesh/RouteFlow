/**
 * Unit tests for the dashboard's pctChange helper.
 *
 * The seller dashboard's "X% from last month" line used to be
 * hardcoded (`+12% from last month` etc.) — the user explicitly
 * asked for these to be real values computed from comparing two
 * `getDashboardMetrics` calls (current 30d vs previous 30d). The
 * helper is `pctChange(previous, current)` and lives in
 * `routeflow-frontend/src/app/seller/dashboard/page.tsx`.
 *
 * This test exercises the corner cases so the helper never
 * produces a divide-by-zero artefact or an unhelpful "Infinity%"
 * on a fresh seller account.
 *
 * Run:
 *   NODE_ENV=test npx tsx test/dashboard-pct-change.test.ts
 */

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

// Mirror the helper from the dashboard page exactly. Keep in
// sync if the helper changes.
function pctChange(
  previous: number | null | undefined,
  current: number,
): { label: string; trend: 'up' | 'down' | 'neutral' } {
  if (previous == null) {
    return { label: 'No prior data', trend: 'neutral' };
  }
  if (previous === 0) {
    if (current === 0) return { label: 'No change', trend: 'neutral' };
    return { label: 'New this period', trend: 'up' };
  }
  const diff = current - previous;
  const pct = (diff / previous) * 100;
  const rounded = Math.round(pct);
  if (rounded === 0) return { label: 'No change', trend: 'neutral' };
  const sign = rounded > 0 ? '+' : '';
  return {
    label: `${sign}${rounded}% from last month`,
    trend: rounded > 0 ? 'up' : 'down',
  };
}

// =====================================================================
// 1. Missing previous period (the API call failed or the seller
//    signed up today) — must NOT show "Infinity%" or "NaN%".
// =====================================================================
section('previous period is missing');

{
  const r = pctChange(null, 12);
  assert(r.label === 'No prior data', `null → "No prior data" (got "${r.label}")`);
  assert(r.trend === 'neutral', 'null → trend=neutral');

  const u = pctChange(undefined, 0);
  assert(u.label === 'No prior data', `undefined → "No prior data" (got "${u.label}")`);
}

// =====================================================================
// 2. Both periods are zero — flat "No change".
// =====================================================================
section('both periods are 0');

{
  const r = pctChange(0, 0);
  assert(r.label === 'No change', `0 → 0 = "No change" (got "${r.label}")`);
  assert(r.trend === 'neutral', 'trend=neutral');
}

// =====================================================================
// 3. Previous period was 0, current has activity — first sale.
// =====================================================================
section('first-ever activity (previous=0, current>0)');

{
  const r = pctChange(0, 1);
  assert(r.label === 'New this period', `0 → 1 = "New this period" (got "${r.label}")`);
  assert(r.trend === 'up', 'trend=up');

  const r2 = pctChange(0, 100);
  assert(r2.label === 'New this period', `0 → 100 = "New this period" (got "${r2.label}")`);
}

// =====================================================================
// 4. Round trips — small but non-trivial values
// =====================================================================
section('round trips with realistic numbers');

{
  // 50 → 56 → +12% (the exact number the old hardcoded string used,
  // verified by hand: (56-50)/50 = 0.12)
  const r = pctChange(50, 56);
  assert(r.label === '+12% from last month', `50 → 56 = "+12% from last month" (got "${r.label}")`);
  assert(r.trend === 'up', 'trend=up');

  // 100 → 92 → -8%
  const r2 = pctChange(100, 92);
  assert(r2.label === '-8% from last month', `100 → 92 = "-8% from last month" (got "${r2.label}")`);
  assert(r2.trend === 'down', 'trend=down');
}

// =====================================================================
// 5. Same value — "No change" (not "+0%")
// =====================================================================
section('identical values');

{
  const r = pctChange(7, 7);
  assert(r.label === 'No change', `7 → 7 = "No change" (got "${r.label}")`);
  assert(r.trend === 'neutral', 'trend=neutral');
}

// =====================================================================
// 6. Sub-1% change rounds to 0 — also "No change"
// =====================================================================
section('sub-1% change rounds to 0');

{
  // 100 → 100 (0.4%): rounds to 0
  const r = pctChange(100, 100.4);
  assert(r.label === 'No change', `100 → 100.4 = "No change" (got "${r.label}")`);
}

// =====================================================================
// 7. Half values — large deltas still readable
// =====================================================================
section('large deltas');

{
  const r = pctChange(10, 100);
  // 90/10 = 9.0 = 900%
  assert(r.label === '+900% from last month', `10 → 100 = "+900% from last month" (got "${r.label}")`);
  assert(r.trend === 'up', 'trend=up');
}

// =====================================================================
// Summary
// =====================================================================
console.log(`\n========================================`);
console.log(`  ${pass} passed, ${fail} failed`);
console.log(`========================================`);
if (fail > 0) process.exit(1);
