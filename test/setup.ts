import { config, isTest } from '../src/config/env';

if (!isTest) {
  console.error('❌ Tests must run with NODE_ENV=test');
  process.exit(1);
}

import { knex } from '../src/config/database';
import { config as dbConfig } from '../src/config/database';

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