import { config, isTest } from '../src/config/env';

if (!isTest) {
  console.error('❌ Tests must run with NODE_ENV=test');
  process.exit(1);
}

import { config as dotenvConfig } from 'dotenv';
import path from 'path';
dotenvConfig({ path: path.resolve(__dirname, '../.env.test') });

import { knex } from '../src/config/database';

beforeAll(async () => {
  await knex.migrate.latest();
});

afterAll(async () => {
  await knex.destroy();
});

beforeEach(async () => {
  await knex('refresh_tokens').del();
  await knex('routes').del();
  await knex('orders').del();
  await knex('drivers').del();
  await knex('users').del();
});

export { knex };