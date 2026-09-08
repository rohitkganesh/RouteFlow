/**
 * Backfill `routes_typed.estimated_distance` / `estimated_duration`
 * for any row that has 0/0.
 *
 * One-shot. Run with:
 *   NODE_ENV=test npx tsx test/backfill-routes-typed-distance.test.ts
 *
 * Why: the legacy `TaskService.generateForOrder` insert (used by both
 * manual seller assignment and auto-assign) didn't populate
 * `estimated_distance` / `estimated_duration` on the typed-route row
 * it created. The driver's `/driver/routes` page reads those columns
 * and would otherwise show "—" for every such row.
 *
 * This script recomputes the haversine distance and 30 km/h urban
 * duration for each affected row from its `start_location` /
 * `end_location` JSONB coords and updates the row. Subsequent
 * `generateForOrder` calls (post-fix) write the values inline, so
 * this script is only needed once for the existing backlog.
 */
import path from 'path';
import { config as dotenvConfig } from 'dotenv';
dotenvConfig({ path: path.resolve(__dirname, '../.env.test') });

import { knex } from '../src/config/database';
import { RouteTypedService } from '../src/services/route-typed.service';

(async () => {
  const before = await knex('routes_typed')
    .count('* as count')
    .first()
    .then((r) => Number((r as { count?: string | number }).count ?? 0));
  const total = before;
  console.log(`[backfill] ${total} routes_typed rows to scan`);

  const updated = await RouteTypedService.backfillDistanceAndDuration();
  console.log(`[backfill] updated ${updated} row(s) with computed distance/duration`);

  // Show the first 5 rows so the operator can eyeball the values.
  const sample = await knex('routes_typed')
    .select('id', 'name', 'status', 'estimated_distance', 'estimated_duration')
    .orderBy('created_at', 'desc')
    .limit(5);
  console.log('[backfill] sample of recent rows:');
  for (const r of sample) {
    console.log(
      `  - ${r.name}  status=${r.status}  dist=${r.estimated_distance}  dur=${r.estimated_duration}s`
    );
  }

  await knex.destroy();
})().catch((e) => {
  console.error('[backfill] failed:', e);
  process.exit(1);
});
