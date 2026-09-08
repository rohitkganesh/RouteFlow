/**
 * Add order_status_history table for tracking status transitions
 * Used by the public tracking page to render the customer-facing timeline
 */

exports.up = function (knex) {
  return knex.schema.createTable('order_status_history', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('order_id').notNullable().references('id').inTable('orders').onDelete('CASCADE').onUpdate('CASCADE');
    // Reuse the existing 'order_status' enum created by the initial schema migration.
    // Use knex.raw so we don't try to (re-)CREATE TYPE during this migration.
    table.specificType('status', 'order_status').notNullable();
    table.decimal('latitude', 10, 8);
    table.decimal('longitude', 11, 8);
    table.text('notes');
    table.timestamp('timestamp', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index('order_id', 'idx_osh_order_id');
    table.index(['order_id', 'timestamp'], 'idx_osh_order_time');
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists('order_status_history');
};
