/**
 * Migration: widen orders, add vehicles, add order_items, add typed routes
 *
 * Brings the schema in line with the frontend's typed payload:
 *   - orders: split delivery_address (text) into delivery_address (jsonb)
 *     + pickup_address (jsonb) + lat/lng for each, plus items/totals/payment.
 *   - order_items: child rows for multi-item orders.
 *   - vehicles: seller's fleet, separate table.
 *   - routes_typed: seller-driven multi-waypoint routes (the existing
 *     admin-only `routes` table stays for backward compatibility).
 */

exports.up = async function (knex) {
  // Add new columns to orders
  await knex.schema.alterTable('orders', (table) => {
    table.jsonb('pickup_address').defaultTo('{}');
    table.jsonb('delivery_address_typed').defaultTo('{}');
    table.decimal('pickup_latitude', 10, 8);
    table.decimal('pickup_longitude', 11, 8);
    table.decimal('delivery_latitude', 10, 8);
    table.decimal('delivery_longitude', 11, 8);
    table.decimal('total_weight', 10, 3).defaultTo(0);
    table.decimal('total_volume', 10, 6).defaultTo(0);
    table.decimal('total_value', 12, 2).defaultTo(0);
    table.decimal('delivery_fee', 10, 2).defaultTo(0);
    table.decimal('discount', 10, 2).defaultTo(0);
    table.decimal('tax', 10, 2).defaultTo(0);
    table.decimal('total_amount', 12, 2).defaultTo(0);
    table.enu('payment_method', ['CASH', 'CARD', 'BANK_TRANSFER', 'WALLET', 'COD'], { useNative: true, enumName: 'payment_method' });
    table.enu('payment_status', ['PENDING', 'PAID', 'REFUNDED', 'FAILED'], { useNative: true, enumName: 'payment_status' }).defaultTo('PENDING');
    table.string('customer_email', 255);
    table.text('instructions');
    table.timestamp('scheduled_pickup_at', { useTz: true });
    table.timestamp('scheduled_delivery_at', { useTz: true });
    table.timestamp('actual_pickup_at', { useTz: true });
    table.timestamp('actual_delivery_at', { useTz: true });
    table.timestamp('cancelled_at', { useTz: true });
    table.text('cancellation_reason');
    table.text('failed_reason');
    table.uuid('route_id');
    table.jsonb('metadata').defaultTo('{}');
  });

  // Order items
  await knex.schema.createTable('order_items', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('order_id').notNullable().references('id').inTable('orders').onDelete('CASCADE').onUpdate('CASCADE');
    table.string('name', 255).notNullable();
    table.text('description');
    table.string('sku', 100);
    table.integer('quantity').notNullable().defaultTo(1);
    table.decimal('weight', 10, 3).notNullable().defaultTo(0);
    table.decimal('volume', 10, 6).notNullable().defaultTo(0);
    table.decimal('unit_price', 12, 2).notNullable().defaultTo(0);
    table.decimal('total_price', 12, 2).notNullable().defaultTo(0);
    table.jsonb('metadata').defaultTo('{}');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index('order_id', 'idx_order_items_order_id');
  });

  // Vehicles
  await knex.schema.createTable('vehicles', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('seller_id').notNullable().references('id').inTable('sellers').onDelete('CASCADE').onUpdate('CASCADE');
    table.string('plate_number', 50).notNullable();
    table.enu('type', ['motorcycle', 'car', 'van', 'truck', 'bicycle'], { useNative: true, enumName: 'vehicle_type' }).notNullable();
    table.string('brand', 100).notNullable();
    table.string('model', 100).notNullable();
    table.integer('year').notNullable();
    table.string('color', 50);
    table.decimal('capacity_weight', 10, 3).notNullable();
    table.decimal('capacity_volume', 10, 6).notNullable();
    table.string('fuel_type', 50);
    table.date('insurance_expiry');
    table.date('registration_expiry');
    table.string('gps_device_id', 100);
    table.uuid('driver_id');
    table.enu('status', ['active', 'inactive', 'maintenance'], { useNative: true, enumName: 'vehicle_status' }).notNullable().defaultTo('active');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.unique(['seller_id', 'plate_number'], { indexName: 'uq_vehicles_seller_plate' });
    table.index('seller_id', 'idx_vehicles_seller_id');
    table.index('driver_id', 'idx_vehicles_driver_id');
    table.index('status', 'idx_vehicles_status');
  });
  await knex.raw(`
    CREATE TRIGGER update_vehicles_updated_at
    BEFORE UPDATE ON vehicles
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  `);

  // Typed routes (multi-waypoint, seller-driven)
  await knex.schema.createTable('routes_typed', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('seller_id').notNullable().references('id').inTable('sellers').onDelete('CASCADE').onUpdate('CASCADE');
    table.string('name', 255).notNullable();
    table.text('description');
    table.jsonb('start_location').notNullable();
    table.jsonb('end_location').notNullable();
    table.jsonb('waypoints').notNullable().defaultTo('[]');
    table.uuid('driver_id');
    table.uuid('vehicle_id');
    table.timestamp('scheduled_start_at', { useTz: true });
    table.decimal('estimated_distance', 10, 2).defaultTo(0);
    table.integer('estimated_duration').defaultTo(0);
    table.enu('status', ['PLANNED', 'ACTIVE', 'COMPLETED', 'CANCELLED'], { useNative: true, enumName: 'route_typed_status' }).notNullable().defaultTo('PLANNED');
    table.jsonb('order_ids').notNullable().defaultTo('[]');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index('seller_id', 'idx_routes_typed_seller_id');
    table.index('driver_id', 'idx_routes_typed_driver_id');
    table.index('vehicle_id', 'idx_routes_typed_vehicle_id');
    table.index('status', 'idx_routes_typed_status');
  });
  await knex.raw(`
    CREATE TRIGGER update_routes_typed_updated_at
    BEFORE UPDATE ON routes_typed
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  `);

  // Order route link (back-link from orders to routes_typed)
  await knex.schema.alterTable('orders', (table) => {
    table.foreign('route_id').references('id').inTable('routes_typed').onDelete('SET NULL').onUpdate('CASCADE');
  });
};

exports.down = function (knex) {
  return knex.schema
    .alterTable('orders', (table) => {
      table.dropForeign('route_id');
    })
    .dropTableIfExists('routes_typed')
    .then(() => knex.raw(`DROP TYPE IF EXISTS route_typed_status;`))
    .dropTableIfExists('vehicles')
    .then(() => knex.raw(`DROP TYPE IF EXISTS vehicle_status; DROP TYPE IF EXISTS vehicle_type;`))
    .dropTableIfExists('order_items')
    .alterTable('orders', (table) => {
      table.dropColumn('pickup_address');
      table.dropColumn('delivery_address_typed');
      table.dropColumn('pickup_latitude');
      table.dropColumn('pickup_longitude');
      table.dropColumn('delivery_latitude');
      table.dropColumn('delivery_longitude');
      table.dropColumn('total_weight');
      table.dropColumn('total_volume');
      table.dropColumn('total_value');
      table.dropColumn('delivery_fee');
      table.dropColumn('discount');
      table.dropColumn('tax');
      table.dropColumn('total_amount');
      table.dropColumn('payment_method');
      table.dropColumn('payment_status');
      table.dropColumn('customer_email');
      table.dropColumn('instructions');
      table.dropColumn('scheduled_pickup_at');
      table.dropColumn('scheduled_delivery_at');
      table.dropColumn('actual_pickup_at');
      table.dropColumn('actual_delivery_at');
      table.dropColumn('cancelled_at');
      table.dropColumn('cancellation_reason');
      table.dropColumn('failed_reason');
      table.dropColumn('route_id');
      table.dropColumn('metadata');
    })
    .then(() => knex.raw(`
      DROP TYPE IF EXISTS payment_method;
      DROP TYPE IF EXISTS payment_status;
    `));
};
