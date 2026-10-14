import assert from 'node:assert/strict';
import { test } from 'node:test';
import { databases } from '../src/data/db';
import { exploreActions } from '../src/data/explore';
import { postgresqlPublicApiVerified, postgresqlStorageEntry, storageGroups } from '../src/data/ovdb';
import postgresqlApi from '../src/data/generated/postgresql-api.json';
import committedPostgresqlApi from '../config/postgresql-api.json';

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

test('the committed PostgreSQL flag is a valid boolean', () => {
  assert.equal(committedPostgresqlApi.format, 'demodb-postgresql-api/v1');
  // The activation owner flips this; CI covers the verified state with a fixture
  // through DEMODB_POSTGRESQL_API_CONFIG, so no test depends on the committed value.
  assert.equal(typeof committedPostgresqlApi.publicApiVerified, 'boolean');
});

test('the selected PostgreSQL flag is a valid boolean and matches every storage entry', () => {
  assert.equal(postgresqlApi.format, 'demodb-postgresql-api/v1');
  assert.equal(typeof postgresqlApi.publicApiVerified, 'boolean');
  assert.equal(postgresqlPublicApiVerified, postgresqlApi.publicApiVerified);
  const postgres = storageGroups.flatMap((group) => group.storages).filter((storage) => storage.engine === 'PostgreSQL');
  assert.equal(postgres.length, databases.length, 'every dataset has one PostgreSQL copy entry');
  for (const storage of postgres) {
    assert.deepEqual(storage, postgresqlStorageEntry(storage.id.replace(/-postgresql$/, ''), postgresqlPublicApiVerified));
  }
});

test('pending PostgreSQL copies make no hosting or API claim', () => {
  const pending = postgresqlStorageEntry('chinook', false);
  assert.equal(pending.readiness, 'hosted-api-pending');
  assert.equal(pending.apiUrl, undefined);
  assert.deepEqual(pending.tags, ['chinook', 'postgresql']);
  assert.doesNotMatch(JSON.stringify(pending), /neon/i);
});

test('verified PostgreSQL copies link to the cloud OpenVaultDB endpoint', () => {
  const publicApi = postgresqlStorageEntry('chinook', true);
  assert.equal(publicApi.readiness, 'public-api');
  assert.equal(publicApi.apiUrl, 'https://cloud.openvaultdb.com/v1/databases/chinook-postgresql');
  assert.equal(publicApi.id, 'chinook-postgresql');
  assert.equal(publicApi.engine, 'PostgreSQL');
});
