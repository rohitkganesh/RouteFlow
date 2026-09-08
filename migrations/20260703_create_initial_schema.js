/**
 * Initial schema migration for RouteFlow
 * Creates: users, orders, drivers, routes tables with proper indexes and constraints
 */

exports.up = function (knex) {
  return knex.schema
    // ============================================
    // USERS TABLE
    // ============================================
    .createTable('users', (table) => {
      table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      table.string('email', 255).notNullable().unique();
      table.string('password_hash', 255).notNullable();
      table.enu('role', ['admin', 'seller', 'driver'], { useNative: true, enumName: 'user_role' }).notNullable().defaultTo('seller');
      table.jsonb('profile_details').notNullable().defaultTo('{}');
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

      // Indexes
      table.index('email', 'idx_users_email');
      table.index('role', 'idx_users_role');
    })

    // ============================================
    // ORDERS TABLE
    // ============================================
    .createTable('orders', (table) => {
      table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      table.uuid('seller_id').notNullable().references('id').inTable('users').onDelete('RESTRICT').onUpdate('CASCADE');
      table.string('customer_name', 255).notNullable();
      table.string('customer_phone', 50).notNullable();
      table.text('delivery_address').notNullable();
      table.decimal('latitude', 10, 8).notNullable();
      table.decimal('longitude', 11, 8).notNullable();
      table.jsonb('parcel_details').notNullable().defaultTo('{}');
      table.enu('status', ['pending', 'assigned', 'picked_up', 'on_the_way', 'delivered', 'cancelled'], { useNative: true, enumName: 'order_status' }).notNullable().defaultTo('pending');
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

      // Indexes for geolocation lookups and common queries
      table.index('seller_id', 'idx_orders_seller_id');
      table.index('status', 'idx_orders_status');
      table.index(['latitude', 'longitude'], 'idx_orders_location');
      table.index('created_at', 'idx_orders_created_at');
    })

    // ============================================
    // DRIVERS TABLE
    // ============================================
    .createTable('drivers', (table) => {
      table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      table.uuid('user_id').notNullable().unique().references('id').inTable('users').onDelete('CASCADE').onUpdate('CASCADE');
      table.decimal('current_latitude', 10, 8);
      table.decimal('current_longitude', 11, 8);
      table.enu('availability_status', ['available', 'busy', 'offline'], { useNative: true, enumName: 'driver_availability' }).notNullable().defaultTo('offline');
      table.integer('current_workload').notNullable().defaultTo(0);
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

      // Indexes
      table.index('user_id', 'idx_drivers_user_id');
      table.index('availability_status', 'idx_drivers_availability');
      table.index(['current_latitude', 'current_longitude'], 'idx_drivers_location');
    })

    // ============================================
    // ROUTES TABLE
    // ============================================
    .createTable('routes', (table) => {
      table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      table.uuid('order_id').notNullable().unique().references('id').inTable('orders').onDelete('CASCADE').onUpdate('CASCADE');
      table.uuid('driver_id').notNullable().references('id').inTable('drivers').onDelete('RESTRICT').onUpdate('CASCADE');
      table.text('optimized_polyline').notNullable();
      table.integer('estimated_travel_time').notNullable(); // in seconds
      table.decimal('estimated_distance', 10, 2).notNullable(); // in kilometers
      table.enu('status', ['planned', 'active', 'completed', 'cancelled'], { useNative: true, enumName: 'route_status' }).notNullable().defaultTo('planned');
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

      // Indexes
      table.index('order_id', 'idx_routes_order_id');
      table.index('driver_id', 'idx_routes_driver_id');
      table.index('status', 'idx_routes_status');
    })

    // ============================================
    // TRIGGERS FOR updated_at TIMESTAMPS
    // ============================================
    .then(() => knex.raw(`
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `))
    .then(() => knex.raw(`
      DROP TRIGGER IF EXISTS update_orders_updated_at ON orders;
      CREATE TRIGGER update_orders_updated_at
      BEFORE UPDATE ON orders
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    `))
    .then(() => knex.raw(`
      DROP TRIGGER IF EXISTS update_drivers_updated_at ON drivers;
      CREATE TRIGGER update_drivers_updated_at
      BEFORE UPDATE ON drivers
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    `))
    .then(() => knex.raw(`
      DROP TRIGGER IF EXISTS update_routes_updated_at ON routes;
      CREATE TRIGGER update_routes_updated_at
      BEFORE UPDATE ON routes
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    `));
};

exports.down = function (knex) {
  return knex.schema
    .dropTableIfExists('routes')
    .dropTableIfExists('drivers')
    .dropTableIfExists('orders')
    .dropTableIfExists('users')
    .then(() => knex.raw(`
      DROP TYPE IF EXISTS user_role;
      DROP TYPE IF EXISTS order_status;
      DROP TYPE IF EXISTS driver_availability;
      DROP TYPE IF EXISTS route_status;
      DROP FUNCTION IF EXISTS update_updated_at_column();
    `));
};