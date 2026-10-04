import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildInfo, writeBuildInfo } from './write-build-info.mjs';

const sha = 'a'.repeat(40);

test('build marker only accepts local builds or complete Git SHAs', () => {
  assert.deepEqual(buildInfo(sha.toUpperCase()), { format: 'demodb-build/1', commit: sha });
  assert.equal(buildInfo(undefined).commit, 'local');
  for (const invalid of ['', 'main', 'g'.repeat(40), `${sha}0`]) assert.throws(() => buildInfo(invalid));
});

test('build marker is written to the root static assets after build', async () => {
  const root = await mkdtemp(join(tmpdir(), 'demodb-marker-'));
  try {
    await assert.rejects(writeBuildInfo(root, sha), /build the static site first/);
    await mkdir(join(root, 'dist'));
    const result = await writeBuildInfo(root, sha);
    assert.deepEqual(JSON.parse(await readFile(result.file, 'utf8')), { format: 'demodb-build/1', commit: sha });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('public corpus index keeps native metadata but omits preview rows', async () => {
  const corpus = JSON.parse(await readFile('public/corpus.json', 'utf8'));
  assert.equal(corpus.format, 'demodb-corpus/draft-1');
  assert.ok(Array.isArray(corpus.databases) && corpus.databases.length >= 2);
  for (const database of corpus.databases) {
    assert.match(database.id, /^https:\/\//);
    assert.ok(database.sourceVersion);
    assert.match(database.sourceRevision, /^[a-f0-9]{40}$/);
    assert.ok(database.licences?.data && database.licences?.model && database.licences?.meaning);
    assert.match(database.browserManifestUrl, /\/ovdb-database\.json$/);
    assert.match(database.schemaSha256, /^[a-f0-9]{64}$/);
    assert.match(database.serverManifestUrl, /\/ovdb-database\.json$/);
    for (const recordset of database.recordsets) {
      assert.equal(Object.hasOwn(recordset, 'rows'), false, `${database.localId}.${recordset.name} does not publish preview row data`);
      assert.ok(Array.isArray(recordset.columns));
      assert.ok(Array.isArray(recordset.primaryKey), 'composite primary key order is explicit');
      for (const representation of recordset.availableRepresentations) {
        assert.match(representation.url, /^https:\/\//);
        assert.equal(typeof representation.sha256, 'string');
      }
    }
  }
  const northwind = corpus.databases.find((database) => database.localId === 'northwind');
  const orderDetails = northwind?.recordsets.find((recordset) => recordset.name === 'Order Details');
  assert.deepEqual(orderDetails?.primaryKey, ['OrderID', 'ProductID'], 'native composite key ordering stays in the published corpus');
  assert.match(orderDetails?.sampleExportUrl ?? '', /northwind\.Order%20Details\.json$/);
});
