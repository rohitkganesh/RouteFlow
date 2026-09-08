/**
 * Migration: add notifications table + denormalized driver_user_id
 *
 * Two changes, one migration so they ship together:
 *
 * 1. `notifications` — in-app inbox for users (sellers, drivers, admins).
 *    The notification service writes one row per event and emits a socket
 *    event to the recipient's `user:{id}` room. Even when Twilio/SMTP are
 *    not configured, the in-app row is the source of truth so the user
 *    can see what happened in the dashboard.
 *
 * 2. `routes_typed.driver_user_id` — denormalized user id for the driver
 *    attached to a route. The existing `driver_id` on `routes_typed` points
 *    to the `drivers` profile row, but the socket layer uses the *user*
 *    id for rooms (`driver:{userId}` and `user:{userId}`). Storing the
 *    user id here lets us emit `order:status` / `notification:new` events
 *    directly to the driver without an extra join on every emit.
 */

exports.up = async function (knex) {
  // 1. Notifications inbox
  await knex.schema.createTable('notifications', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE').onUpdate('CASCADE');
    // Notification kind — 'order_status', 'order_assigned', 'order_cancelled', 'system', …
    table.string('type', 64).notNullable();
    table.string('title', 255).notNullable();
    table.text('body').notNullable();
    // Free-form payload: { orderId, status, driverId, ... }
    table.jsonb('data').notNullable().defaultTo('{}');
    table.timestamp('read_at', { useTz: true });
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index('user_id', 'idx_notifications_user_id');
    // Unread first: a partial-ish index by created_at desc for the inbox query
    table.index(['user_id', 'created_at'], 'idx_notifications_user_created');
    table.index(['user_id', 'read_at'], 'idx_notifications_user_unread');
  });

  // 2. Denormalized driver user id on routes_typed
  await knex.schema.alterTable('routes_typed', (table) => {
    table.uuid('driver_user_id');
    // Foreign key to users so we can rely on referential integrity
    table.foreign('driver_user_id').references('id').inTable('users').onDelete('SET NULL').onUpdate('CASCADE');
    table.index('driver_user_id', 'idx_routes_typed_driver_user_id');
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('routes_typed', (table) => {
    table.dropForeign('driver_user_id');
    table.dropColumn('driver_user_id');
  });
  await knex.schema.dropTableIfExists('notifications');
};
