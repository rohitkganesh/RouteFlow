/**
 * Migration: add `sequence_index` to the `routes` table.
 *
 * The optimized PDP-TSP solver visits pickups and deliveries in a
 * specific order. We want to preserve that order in the database so the
 * driver app can show the next stop without re-solving the route.
 *
 * The existing `routes` table is one row per order (the leg from
 * pickup → delivery for that order). The new `sequence_index` is the
 * 0-based position of the order in the optimized delivery sequence.
 *
 * Nullable for legacy rows; new rows are written with an explicit index.
 */

exports.up = async function (knex) {
  await knex.schema.alterTable('routes', (table) => {
    table.integer('sequence_index'); // 0-based position in optimized sequence
  });
};

exports.down = function (knex) {
  return knex.schema.alterTable('routes', (table) => {
    table.dropColumn('sequence_index');
  });
};
