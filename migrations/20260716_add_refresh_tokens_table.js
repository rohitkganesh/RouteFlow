/**
 * Add refresh_tokens table for JWT refresh token storage
 */

exports.up = function (knex) {
  return knex.schema
    .createTable('refresh_tokens', (table) => {
      table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE').onUpdate('CASCADE');
      table.text('token').notNullable();
      table.timestamp('expires_at', { useTz: true }).notNullable();
      table.boolean('revoked').notNullable().defaultTo(false);
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

      // Indexes
      table.index('user_id', 'idx_refresh_tokens_user_id');
      table.index('token', 'idx_refresh_tokens_token');
      table.index('expires_at', 'idx_refresh_tokens_expires_at');
    });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists('refresh_tokens');
};