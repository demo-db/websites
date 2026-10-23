import assert from 'node:assert/strict';
import { test } from 'node:test';
import { databases } from '../src/data/db';
import { datatugLocalLimitLines, datatugLocalLimits, datatugPostgresqlLimitLines } from '../src/data/datatug-limits';
import { datatugPostgresqlHref, exploreActions } from '../src/data/explore';
import { postgresqlApiProvenance, postgresqlDataTugEditionId, postgresqlPublicApiVerified, postgresqlStorageEntry, storageGroups } from '../src/data/ovdb';
import postgresqlApi from '../src/data/generated/postgresql-api.json';
import committedPostgresqlApi from '../config/postgresql-api.json';
import datatugCatalog from './fixtures/datatug-postgresql-catalog.json' with { type: 'json' };

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

test('registered datasets expose only the DataTug actions backed by their published formats', () => {
  for (const database of databases) {
    const actions = exploreActions(database);
    const hasSqlite = database.exports.some((file) => file.format === 'sqlite' && file.table === null);
    if (hasSqlite) {
      assert.equal(actions.primary?.label, 'Explore SQLite in DataTug', `${database.id} primary label`);
      assert.equal(actions.primary?.href, `https://datatug.app/demo/sqlite/${database.id}`, `${database.id} href`);
    } else {
      assert.equal(actions.primary, null, `${database.id} has no SQLite action without a database-level SQLite export`);
    }
    const hasPostgresql = storageGroups.some((group) => group.database.localId === database.id
      && group.storages.some((storage) => storage.engine === 'PostgreSQL'));
    const editionId = postgresqlDataTugEditionId(database.id);
    assert.equal(editionId, postgresqlPublicApiVerified && hasPostgresql ? `${database.id}-postgresql` : null, `${database.id} PostgreSQL edition follows its format and the verified flag`);
    const withPostgres = exploreActions(database, editionId);
    assert.deepEqual(withPostgres.primary, actions.primary, 'PostgreSQL never displaces the SQLite primary action');
    assert.deepEqual(withPostgres.secondary, editionId ? [{ engine: 'PostgreSQL', label: 'Explore PostgreSQL in DataTug', href: `https://datatug.app/demo/ovdb/${database.id}-postgresql` }] : []);
    assert.doesNotMatch(JSON.stringify(withPostgres), /wasm/i);
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
  assert.match(postgresqlApi.provenance.sha256, /^[a-f0-9]{64}$/, 'the generated config records the hash of its source');
  assert.equal(postgresqlApi.provenance.default, postgresqlApi.provenance.source === 'config/postgresql-api.json');
  assert.deepEqual(postgresqlApiProvenance, postgresqlApi.provenance);
  const postgres = storageGroups.flatMap((group) => group.storages).filter((storage) => storage.engine === 'PostgreSQL');
  const postgresqlDownloads = databases.filter((database) => database.formatAvailability.some((format) => format.format === 'postgresql' && format.state === 'download'));
  assert.equal(postgres.length, postgresqlDownloads.length, 'each PostgreSQL-capable dataset has one copy entry');
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

test('DataTug local limits are computed from each dataset, not written per page', () => {
  const counts = Object.fromEntries(databases.map((db) => {
    const limits = datatugLocalLimits(db.tables);
    return [db.id, [limits.readOnlyTables.length, limits.tables, limits.views]];
  }));
  assert.deepEqual(counts.chinook, [1, 11, 0]);
  assert.deepEqual(counts.employees, [4, 6, 2]);
  assert.deepEqual(counts.adventureworks, [23, 71, 11]);
  assert.deepEqual(datatugLocalLimits(databases.find((db) => db.id === 'chinook')!.tables).readOnlyTables, ['PlaylistTrack']);
  const lines = datatugLocalLimitLines(datatugLocalLimits(databases.find((db) => db.id === 'employees')!.tables)).join(' ');
  assert.match(lines, /4 of 6 tables/);
  assert.match(lines, /first 100 rows/);
  assert.match(lines, /Views are not listed/);
});

test('the Employees subset is not described as a browser edition', () => {
  const employees = databases.find((db) => db.id === 'employees')!;
  assert.equal(employees.name, 'Employees (reduced subset)');
  assert.doesNotMatch(JSON.stringify({ name: employees.name, description: employees.description, source: employees.source, queries: employees.queries }), /browser[- ](edition|sized)/i);
});

test('the PostgreSQL DataTug action needs a verified API and a hosted edition', () => {
  const chinook = databases.find((db) => db.id === 'chinook')!;
  assert.deepEqual(exploreActions(chinook, null).secondary, [], 'no edition id, no link');
  assert.equal(exploreActions(chinook, 'chinook-postgresql').secondary[0]?.href, datatugPostgresqlHref('chinook-postgresql'));
  // Without a SQLite file the PostgreSQL action is still honest: it becomes the only action.
  const noSqlite = exploreActions({ id: 'x', exports: [] }, 'x-postgresql');
  assert.equal(noSqlite.primary?.engine, 'PostgreSQL');
  assert.deepEqual(noSqlite.secondary, []);
  assert.equal(postgresqlDataTugEditionId('missing'), null);
});

test('generated PostgreSQL DataTug links equal the datatug-apps catalogue routes', () => {
  assert.match(datatugCatalog.commit, /^[0-9a-f]{40}$/, 'the fixture records its source commit');
  const postgresqlDatasets = storageGroups
    .filter((group) => group.storages.some((storage) => storage.engine === 'PostgreSQL'))
    .map((group) => group.database.localId)
    .sort();
  assert.deepEqual(datatugCatalog.entries.map((entry) => entry.dataset).sort(), postgresqlDatasets, 'same datasets as the PostgreSQL storage catalogue');
  for (const { dataset, route } of datatugCatalog.entries) {
    assert.equal(datatugPostgresqlHref(`${dataset}-postgresql`), `https://datatug.app${route}`);
    if (postgresqlPublicApiVerified) {
      assert.equal(exploreActions(databases.find((db) => db.id === dataset), postgresqlDataTugEditionId(dataset)).secondary[0]?.href, `https://datatug.app${route}`);
    }
  }
});

test('the PostgreSQL limits say read-only, TugQL, 100 rows and never imply editing it', () => {
  const lines = datatugPostgresqlLimitLines().join(' ');
  assert.match(lines, /read-only by design/);
  assert.match(lines, /TugQL/);
  assert.match(lines, /first 100 rows/);
  assert.match(lines, /editable local SQLite copy/);
  assert.doesNotMatch(lines, /wasm/i);
});
