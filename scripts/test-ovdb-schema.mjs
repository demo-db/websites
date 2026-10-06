import assert from 'node:assert/strict';
import test from 'node:test';
import { isDatabaseDescriptorShape, validateDatabaseDescriptor, validateServerDescriptor } from './ovdb-schema.mjs';

function database(localId) {
  const site = `https://${localId}.demodb.dev`;
  return {
    format: 'ovdb-database/draft-1', id: `https://demodb.dev/${localId}/`, localId,
    serverId: 'https://demodb.dev/ovdb', serverDbBaseUrl: `https://demodb.dev/ovdb/db/${localId}/`,
    title: localId, description: `${localId} sample`, homepage: `${site}/`,
    apiUrl: `https://demodb.dev/ovdb/v1/databases/${localId}`,
    capabilities: { read: true, query: true, write: false },
    deployment: { engine: 'sqlite', url: `https://cloud.openvaultdb.com/ovdb/dbs/${localId}`, discovery: 'https://demodb.dev/.well-known/openvaultdb' },
    model: { id: `modelspec://${localId}`, url: `${site}/model/${localId}.modelspec.json`, hclUrl: `${site}/model/${localId}.modelspec.hcl` },
    meaning: { id: `meaning://${localId}`, url: `${site}/model/${localId}.meaning.yaml` },
    publisher: { name: 'DemoDB', url: 'https://github.com/demo-db', repository: `https://github.com/demo-db/${localId}` },
    provenance: { repository: 'https://github.com/example/source', revision: 'abc123', path: 'source.sqlite', sha256: 'a'.repeat(64), license: 'MIT', notes: 'Pinned fixture.' },
    licences: { data: 'MIT', model: 'MIT', meaning: 'CC0-1.0' },
    recordsets: [{
      name: 'Example Table', kind: 'table', description: 'Native source table.', rowCount: 1,
      columns: [{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true, primaryKeyPosition: 1, defaultValue: null }],
      primaryKey: [{ column: 'id', position: 1 }], foreignKeys: [],
    }],
  };
}

test('validates global identities, native recordsets and public references for both databases', () => {
  for (const id of ['chinook', 'northwind']) assert.equal(validateDatabaseDescriptor(database(id), id).localId, id);
});

test('accepts exact decimal metadata as an additive column descriptor and checks its bounds', () => {
  const value = database('northwind');
  value.recordsets[0].columns.push({
    name: 'Amount', type: 'DECIMAL_TEXT(30,4)', nullable: true, primaryKey: false,
    primaryKeyPosition: null, defaultValue: null,
    decimal: { precision: 30, scale: 4, storage: 'text' },
  });
  assert.equal(validateDatabaseDescriptor(value, 'northwind').recordsets[0].columns[1].decimal.storage, 'text');
  value.recordsets[0].columns[1].decimal.scale = 31;
  assert.throws(() => validateDatabaseDescriptor(value, 'northwind'), /invalid exact-decimal metadata/);
});

test('accepts normalized optional dataset tags without duplicate or display-only values', () => {
  const value = database('chinook');
  value.tags = ['chinook', 'sqlite'];
  assert.equal(validateDatabaseDescriptor(value, 'chinook').tags.length, 2);
  value.tags.push('SQLite');
  assert.throws(() => validateDatabaseDescriptor(value, 'chinook'), /tags|pattern/i);
  value.tags = ['chinook', 'chinook'];
  assert.throws(() => validateDatabaseDescriptor(value, 'chinook'), /tags|unique/i);
});

test('schema stays publisher-neutral while website validation enforces canonical routes', () => {
  const generic = database('northwind');
  generic.id = 'https://catalog.example/data/northwind/';
  generic.serverId = 'https://catalog.example/ovdb';
  generic.serverDbBaseUrl = 'https://catalog.example/ovdb/db/northwind/';
  generic.apiUrl = 'https://catalog.example/ovdb/v1/databases/northwind';
  generic.homepage = 'https://northwind.example/';
  generic.deployment.discovery = 'https://northwind.example/.well-known/openvaultdb';
  generic.model.url = 'https://northwind.example/model.json';
  generic.meaning.url = 'https://northwind.example/meaning.yaml';
  assert.equal(isDatabaseDescriptorShape(generic), true, 'shared JSON Schema allows other publishers and hosts');
  assert.throws(() => validateDatabaseDescriptor(generic, 'northwind'), /identity\/API/);
});

test('rejects sample rows, credentials and write-enabled descriptors', () => {
  const withRows = database('northwind');
  withRows.recordsets[0].rows = [{ id: 1 }];
  assert.throws(() => validateDatabaseDescriptor(withRows, 'northwind'), /additional propert/i);
  const withWrite = database('northwind');
  withWrite.capabilities.write = true;
  assert.throws(() => validateDatabaseDescriptor(withWrite, 'northwind'), /read-only/);
  const withCredential = database('northwind');
  withCredential.model.url = 'https://user:pass@northwind.demodb.dev/model.json';
  assert.throws(() => validateDatabaseDescriptor(withCredential, 'northwind'), /invalid public URL/);
});

test('validates unique server entries and exact endpoint relationships', () => {
  const databases = ['chinook', 'northwind'].map((id) => ({
    id: `https://demodb.dev/${id}/`, localId: id,
    serverDbBaseUrl: `https://demodb.dev/ovdb/db/${id}/`,
    manifestUrl: `https://demodb.dev/ovdb/db/${id}/ovdb-database.json`,
    apiUrl: `https://demodb.dev/ovdb/v1/databases/${id}`,
  }));
  const server = { format: 'ovdb-server/draft-1', id: 'https://demodb.dev/ovdb', title: 'DemoDB OVDB', description: 'Shared read-only server', homepage: 'https://demodb.dev/ovdb/', apiUrl: 'https://demodb.dev/ovdb/v1', databases };
  assert.equal(validateServerDescriptor(server).databases.length, 2);
  assert.throws(() => validateServerDescriptor({ ...server, databases: [...databases, databases[0]] }), /duplicate/);
  assert.throws(() => validateServerDescriptor({ ...server, databases: [{ ...databases[0], apiUrl: 'https://evil.example' }, databases[1]] }), /inconsistent routes/);
});
