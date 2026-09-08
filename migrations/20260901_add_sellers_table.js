/**
 * Migration: sellers table
 *
 * Adds a separate sellers profile table linked 1:1 to a user with role='seller'.
 * The seller_id foreign key on orders previously pointed at users directly;
 * we keep orders.seller_id referencing users.id to avoid rewriting existing
 * rows, and add seller_id (FK -> sellers.id) alongside as a future-proofing
 * column. For now the Seller.userId -> users.id link is the source of truth.
 */

exports.up = function (knex) {
  return knex.schema
    .createTable('sellers', (table) => {
      table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      table.uuid('user_id').notNullable().unique().references('id').inTable('users').onDelete('CASCADE').onUpdate('CASCADE');
      table.string('business_name', 255);
      table.string('business_type', 100);
      table.string('business_email', 255);
      table.string('business_phone', 50);
      table.text('business_address');
      table.string('tax_id', 100);
      table.string('license_number', 100);
      table.enu('status', ['active', 'inactive', 'suspended'], { useNative: true, enumName: 'seller_status' }).notNullable().defaultTo('active');
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

      table.index('user_id', 'idx_sellers_user_id');
      table.index('status', 'idx_sellers_status');
    })
    .then(() => knex.raw(`
      CREATE TRIGGER update_sellers_updated_at
      BEFORE UPDATE ON sellers
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    `));
};

exports.down = function (knex) {
  return knex.schema
    .dropTableIfExists('sellers')
    .then(() => knex.raw(`DROP TYPE IF EXISTS seller_status;`));
};
