/**
 * Add driver_id column to orders table for auto-assignment
 */

exports.up = function (knex) {
  return knex.schema
    .table('orders', (table) => {
      table.uuid('driver_id').references('id').inTable('drivers').onDelete('SET NULL').onUpdate('CASCADE');
      table.index('driver_id', 'idx_orders_driver_id');
    });
};

exports.down = function (knex) {
  return knex.schema
    .table('orders', (table) => {
      table.dropColumn('driver_id');
    });
};