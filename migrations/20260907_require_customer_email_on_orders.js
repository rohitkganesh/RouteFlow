/**
 * Require customer_email NOT NULL on orders.
 *
 * Background: order creation now requires a customer email so the
 * backend can send the "Order Confirmed" and "Order Delivered"
 * transactional emails. Legacy rows that pre-date the requirement
 * are backfilled to '' (empty string) so the NOT NULL ALTER doesn't
 * fail. New writes go through OrderService.create, which now
 * validates the field and rejects bad input.
 *
 * The down-migration simply drops the NOT NULL constraint, which
 * leaves the column at whatever value the row already has.
 *
 * Run:
 *   NODE_ENV=development npx knex migrate:latest
 *   NODE_ENV=test       npx knex migrate:latest
 */
exports.up = async function (knex) {
  // 1. Backfill: rows that were created before the email became
  //    required have NULL. Give them an empty string so the ALTER
  //    below can run without violating NOT NULL.
  await knex('orders')
    .whereNull('customer_email')
    .update({ customer_email: '' });

  // 2. Add the NOT NULL constraint. `defaultTo('')` is defensive —
  //    the column is also required at the application layer
  //    (OrderService.create), so the default is only a safety net
  //    for any direct SQL writes that bypass the service.
  await knex.schema.alterTable('orders', (table) => {
    table.string('customer_email', 255).notNullable().defaultTo('').alter();
  });
};

exports.down = function (knex) {
  return knex.schema.alterTable('orders', (table) => {
    table.string('customer_email', 255).nullable().alter();
  });
};
