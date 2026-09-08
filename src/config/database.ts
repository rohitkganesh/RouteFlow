import Knex from 'knex';
import { config } from './env';

export const knex = Knex({
  client: 'pg',
  connection: {
    host: config.DB_HOST,
    port: config.DB_PORT,
    database: config.DB_NAME,
    user: config.DB_USER,
    password: config.DB_PASSWORD,
  },
  pool: {
    min: 2,
    max: 10,
  },
  migrations: {
    directory: './migrations',
    tableName: 'knex_migrations',
  },
});

export async function testConnection(): Promise<void> {
  try {
    await knex.raw('SELECT 1');
    console.log('✅ Database connected');
  } catch (error) {
    console.error('❌ Database connection failed:', error);
    throw error;
  }
}

export async function closeConnection(): Promise<void> {
  await knex.destroy();
}