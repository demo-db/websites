import assert from 'node:assert/strict';
import { test } from 'node:test';
import { databases } from '../src/data/db';
import { exploreActions } from '../src/data/explore';
import { postgresqlReadiness, storageGroups } from '../src/data/ovdb';
import postgresqlApi from '../config/postgresql-api.json';

const sqlite = { format: 'sqlite', table: null };

test('exploreActions offers the SQLite DataTug edition as the primary action when metadata publishes it', () => {
  assert.deepEqual(exploreActions({ id: 'chinook', exports: [{ format: 'json', table: 'Artist' }, sqlite] }), {
    primary: { engine: 'SQLite', label: 'Explore SQLite in DataTug', href: 'https://datatug.app/demo/sqlite/chinook' },
    secondary: [],
  });
});

test('exploreActions offers nothing without a database-level SQLite file', () => {
  assert.deepEqual(exploreActions({ id: 'x', exports: [] }), { primary: null, secondary: [] });
  assert.deepEqual(exploreActions({ id: 'x', exports: [{ format: 'sqlite', table: 'Artist' }] }), { primary: null, secondary: [] });
  assert.deepEqual(exploreActions(undefined), { primary: null, secondary: [] });
});

test('every registered dataset gets a SQLite primary action and no user-facing WASM text', () => {
  for (const database of databases) {
    const actions = exploreActions(database);
    assert.equal(actions.primary?.label, 'Explore SQLite in DataTug', `${database.id} primary label`);
    assert.equal(actions.primary?.href, `https://datatug.app/demo/sqlite/${database.id}`, `${database.id} href`);
    assert.deepEqual(actions.secondary, [], `${database.id} offers no secondary edition yet`);
    assert.doesNotMatch(JSON.stringify(actions), /wasm/i);
  }
});

test('PostgreSQL copies stay pending until config/postgresql-api.json is verified', () => {
  assert.equal(postgresqlApi.format, 'demodb-postgresql-api/v1');
  assert.equal(postgresqlApi.publicApiVerified, false, 'the website cannot route PostgreSQL OVDB requests yet');
  assert.equal(postgresqlReadiness, 'hosted-api-pending');
  const postgres = storageGroups.flatMap((group) => group.storages).filter((storage) => storage.engine === 'PostgreSQL');
  assert.equal(postgres.length, databases.length, 'every dataset has one PostgreSQL copy entry');
  for (const storage of postgres) {
    assert.equal(storage.readiness, 'hosted-api-pending', `${storage.id} is not presented as public`);
  }
});
