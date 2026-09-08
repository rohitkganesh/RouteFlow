/**
 * Migration: create tasks table
 *
 * Tasks are the per-stop records a driver works through during a route.
 * Two rows are generated per `routes_typed` order (PICKUP + DELIVERY)
 * — see TaskService.generateForRoute / generateForOrder for the
 * callers. A driver sees them via GET /tasks/my; a seller sees them
 * on the order detail page; admins see everything via GET /tasks.
 *
 * The `status` enum mirrors the frontend's `TaskStatus` enum in
 * routeflow-frontend/src/types/index.ts. PICKED_UP on a PICKUP task
 * advances the underlying order to `picked_up`; DELIVERED on a
 * DELIVERY task advances it to `delivered`. The translation lives
 * in TaskService.advanceStatus.
 *
 * `route_id` is nullable so an ad-hoc seller assignment (no route
 * yet) can still create tasks. The order_id is NOT NULL — every
 * task belongs to an order, and the legacy `orders.driver_id` is
 * the source of truth for which driver is doing what.
 */

exports.up = async function (knex) {
  await knex.schema.createTable('tasks', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    // Optional: a task may not yet be attached to a routes_typed row
    // (e.g. ad-hoc manual assignment from the seller order detail
    // page). When `route_id` is null, the task is a one-stop delivery.
    table.uuid('route_id').references('id').inTable('routes_typed').onDelete('SET NULL').onUpdate('CASCADE');
    // Required: every task is rooted in a specific order.
    table.uuid('order_id').notNullable().references('id').inTable('orders').onDelete('CASCADE').onUpdate('CASCADE');
    // Required: every task is assigned to a specific driver profile.
    table.uuid('driver_id').notNullable().references('id').inTable('drivers').onDelete('CASCADE').onUpdate('CASCADE');
    // 'PICKUP' or 'DELIVERY' — what the driver does in this step.
    table.enu('type', ['PICKUP', 'DELIVERY'], { useNative: true, enumName: 'task_type' }).notNullable();
    // Mirrors the frontend's TaskStatus enum exactly. The status
    // values are intentionally granular so the driver can show
    // en_route / arrived states without round-tripping a separate
    // "trip state" resource.
    table.enu(
      'status',
      [
        'PENDING',
        'ACCEPTED',
        'EN_ROUTE_TO_PICKUP',
        'ARRIVED_AT_PICKUP',
        'PICKED_UP',
        'EN_ROUTE_TO_DROPOFF',
        'ARRIVED_AT_DROPOFF',
        'DELIVERED',
        'FAILED',
        'CANCELLED',
      ],
      { useNative: true, enumName: 'task_status' }
    )
      .notNullable()
      .defaultTo('PENDING');
    // Position of this task within the route (1-indexed). Used by
    // the route-level map to draw a sequence. Two tasks per order
    // share the same sequence_index (pickup is `n`, delivery is `n`
    // too — they're not separate stops in the waypoint sense).
    table.integer('sequence_index').notNullable().defaultTo(0);
    // Coordinates: pickup_* always populated (the seller's
    // warehouse), delivery_* always populated (the customer's
    // address). For a PICKUP task only the pickup_* are "live"
    // coords; for a DELIVERY task only the delivery_* are. We
    // populate both so the route's draw tool can plan a leg.
    table.decimal('pickup_latitude', 10, 8);
    table.decimal('pickup_longitude', 11, 8);
    table.decimal('delivery_latitude', 10, 8);
    table.decimal('delivery_longitude', 11, 8);
    // Address jsonb shape mirrors orders.pickup_address and
    // orders.delivery_address_typed.
    table.jsonb('pickup_address').defaultTo('{}');
    table.jsonb('delivery_address').defaultTo('{}');
    // Timestamps for SLA tracking and progress reporting.
    table.timestamp('estimated_pickup_at', { useTz: true });
    table.timestamp('estimated_delivery_at', { useTz: true });
    table.timestamp('actual_pickup_at', { useTz: true });
    table.timestamp('actual_delivery_at', { useTz: true });
    // Free-form notes the driver attaches (e.g. "left with
    // receptionist"). Distinct from the order-level cancellation
    // reason; this is per-task operational note.
    table.text('notes');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    // Indexes
    // (driver_id, status) — primary access pattern: "what's still
    // on my plate?" and "show me everything I've finished today."
    table.index(['driver_id', 'status'], 'idx_tasks_driver_status');
    table.index('order_id', 'idx_tasks_order_id');
    table.index(['route_id', 'sequence_index'], 'idx_tasks_route_sequence');
  });

  // updated_at trigger
  await knex.raw(`
    CREATE TRIGGER update_tasks_updated_at
    BEFORE UPDATE ON tasks
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  `);
};

exports.down = async function (knex) {
  await knex.raw(`DROP TRIGGER IF EXISTS update_tasks_updated_at ON tasks;`);
  await knex.schema.dropTableIfExists('tasks');
  await knex.raw(`DROP TYPE IF EXISTS task_status;`);
  await knex.raw(`DROP TYPE IF EXISTS task_type;`);
};
