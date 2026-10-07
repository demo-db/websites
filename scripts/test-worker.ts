import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { indexedDB as fakeIndexedDB } from 'fake-indexeddb';
import worker, { internalAssetPath, resolveHost, serveChunkedGzip } from '../src/worker';
import { activeSnapshot, clearActiveSnapshot, followNativeForeignKey, importSnapshot, IncrementalSha256, isVerifiedTableCheckpoint, parseJsonArray, stagingImportKey } from '../src/scripts/indexeddb-snapshot';
import providerIndex from '../src/data/generated/index.json';
import { bigQueryHosting, publicOvdbApiCount, storageEngineCount, storageEntryCount, storageGroups } from '../src/data/ovdb';
import registry from '../config/databases.json';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const dist = join(root, 'dist');
const localDatabaseHosts = Object.fromEntries((providerIndex.databases as { id: string }[]).map(({ id }) => [`${id}.localhost`, id]));
const local = { LOCAL_DB_HOSTS: JSON.stringify(localDatabaseHosts), LOCAL_CATALOGUE_HOSTS: '["localhost"]' };
const gzipPayload = Buffer.from('[{"fixture":"gzip"}]');
const gzipPayloadBytes = gzipSync(gzipPayload);
const chunkedPayload = Buffer.from('full AdventureWorks SQLite fixture '.repeat(120));
const chunkedEncoded = gzipSync(chunkedPayload);
const chunkBoundaries = [0, Math.ceil(chunkedEncoded.length / 2), chunkedEncoded.length];
const chunkAssetPaths = ['__chunks/chinook.sqlite.gz.part-0001', '__chunks/chinook.sqlite.gz.part-0002'];
const chunkAssets = new Map<string, Buffer>();
const chunkMetadata = chunkBoundaries.slice(0, -1).map((start, index) => {
  const bytes = chunkedEncoded.subarray(start, chunkBoundaries[index + 1]);
  chunkAssets.set(`/_db/chinook/data/${chunkAssetPaths[index]}`, bytes);
  return { assetPath: chunkAssetPaths[index], bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
});
const chinookGenerated = providerIndex.databases.find((database) => database.id === 'chinook') as unknown as { exports: { publicPath: string; assetPath: string; compression?: string; bytes?: number; sha256?: string; chunks?: { assetPath: string; bytes: number; sha256: string }[] }[] };
chinookGenerated.exports.push({ publicPath: 'json/chinook.Order Details.json', assetPath: 'json/chinook.Order Details.json.gz', compression: 'gzip' });
chinookGenerated.exports.push({
  publicPath: 'chinook.sqlite', assetPath: 'chinook.sqlite', compression: 'gzip', bytes: chunkedEncoded.length,
  sha256: createHash('sha256').update(chunkedEncoded).digest('hex'), chunks: chunkMetadata,
});

for (const value of ['', 'abc', 'unicode ✓ and a longer value'.repeat(80)]) {
  const bytes = new TextEncoder().encode(value);
  const hash = new IncrementalSha256();
  for (let index = 0; index < bytes.length; index += 7) hash.update(bytes.slice(index, index + 7));
  assert.equal(hash.hexDigest(), createHash('sha256').update(bytes).digest('hex'), 'incremental browser digest matches SHA-256');
}
assert.equal(isVerifiedTableCheckpoint({ complete: false, count: 10, sha256: 'bad' }, 'good', 10), false, 'an interrupted or checksum-failed table must be cleared and replayed');
assert.equal(isVerifiedTableCheckpoint({ complete: true, count: 10, sha256: 'good' }, 'good', 10), true, 'only a complete table with the pinned digest can be reused');
assert.equal(isVerifiedTableCheckpoint({ complete: true, count: 9, sha256: 'good' }, 'good', 10), false, 'row-count disagreement forces a table replay');
assert.notEqual(stagingImportKey('chinook'), stagingImportKey('northwind'), 'partial import state is isolated per database');

{
  const configuration = {
    id: 'retry-fixture',
    sourceCommit: 'fixture',
    tables: [
      { name: 'Parent', kind: 'table' as const, rowCount: 1, columns: [{ name: 'id', primaryKey: true, primaryKeyPosition: 1 }, { name: 'code' }, { name: 'amount', decimal: { precision: 30, scale: 4, storage: 'text' } }], foreignKeys: [] },
      { name: 'Child', kind: 'table' as const, rowCount: 1, columns: [{ name: 'id', primaryKey: true, primaryKeyPosition: 1 }, { name: 'parent_code' }], foreignKeys: [{ column: 'parent_code', table: 'Parent', referencedColumn: 'code', constraint: 1, position: 0 }] },
    ],
    exports: [
      { table: 'Parent', url: 'https://fixture.example/parents.json', bytes: Buffer.byteLength('[{"id":1,"code":"A","amount":"9007199254740993.1200","label":"right"}]'), sha256: createHash('sha256').update('[{"id":1,"code":"A","amount":"9007199254740993.1200","label":"right"}]').digest('hex') },
      { table: 'Child', url: 'https://fixture.example/children.json', bytes: Buffer.byteLength('[{"id":7,"parent_code":"A"}]'), sha256: createHash('sha256').update('[{"id":7,"parent_code":"A"}]').digest('hex') },
    ],
  };
  const bad = new TextEncoder().encode('[{"id":1,"code":"A","amount":"9007199254740993.1200","label":"wrong"}]');
  const good = new TextEncoder().encode('[{"id":1,"code":"A","amount":"9007199254740993.1200","label":"right"}]');
  const child = new TextEncoder().encode('[{"id":7,"parent_code":"A"}]');
  assert.equal(bad.byteLength, good.byteLength, 'bad first download reaches checksum verification');
  const originalFetch = globalThis.fetch;
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  const originalSessionStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const sessionValues = new Map<string, string>();
  const localValues = new Map<string, string>();
  let attempts = 0;
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: fakeIndexedDB });
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: (key: string) => sessionValues.get(key) ?? null, setItem: (key: string, value: string) => sessionValues.set(key, value), removeItem: (key: string) => sessionValues.delete(key) } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => localValues.get(key) ?? null, setItem: (key: string, value: string) => localValues.set(key, value), removeItem: (key: string) => localValues.delete(key) } });
  globalThis.fetch = async () => new Response([bad, good, child][attempts++]);
  try {
    await assert.rejects(importSnapshot(configuration, () => {}, new AbortController().signal), /checksum mismatch/);
    await importSnapshot(configuration, () => {}, new AbortController().signal);
    const db = await activeSnapshot(configuration);
    assert.ok(db, 'valid retry promotes a complete snapshot');
    const parent = await new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
      const request = db!.transaction('recordset-0').objectStore('recordset-0').get(1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const childRow = await new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
      const request = db!.transaction('recordset-1').objectStore('recordset-1').get(7);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    assert.deepEqual(parent, { id: 1, code: 'A', amount: '9007199254740993.1200', label: 'right' }, 'IndexedDB retains the high-precision decimal string and valid retry replaces the failed row');
    assert.deepEqual(await followNativeForeignKey(db!, configuration.tables, 'Child', childRow!, configuration.tables[1].foreignKeys[0]), parent, 'foreign keys to a unique non-primary target column resolve through a native index');
    db!.close();
    await clearActiveSnapshot(configuration);
    assert.equal(attempts, 3, 'the failed table is fetched again and later tables import after it verifies');
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, descriptor] of [['indexedDB', originalIndexedDB], ['sessionStorage', originalSessionStorage], ['localStorage', originalLocalStorage]] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
}

{
  const source = '[{"id":1,"text":"brace } and quote \\\" ok","nested":[1,2]},{"id":2}]';
  const bytes = new TextEncoder().encode(source);
  const rows: unknown[] = [];
  const digest = new IncrementalSha256();
  let byteCount = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  });
  await parseJsonArray(stream, async (row) => { rows.push(row); }, (chunk) => digest.update(chunk), (count) => { byteCount += count; });
  assert.deepEqual(rows, [{ id: 1, text: 'brace } and quote " ok', nested: [1, 2] }, { id: 2 }]);
  assert.equal(byteCount, bytes.length);
  assert.equal(digest.hexDigest(), createHash('sha256').update(bytes).digest('hex'));
  const emptyRows: unknown[] = [];
  await parseJsonArray(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(' [ ] ')); controller.close(); } }), async (row) => { emptyRows.push(row); }, () => {}, () => {});
  assert.deepEqual(emptyRows, [], 'empty native tables remain valid JSON exports');
  await assert.rejects(parseJsonArray(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('[{"a":1}')); controller.close(); } }), async () => {}, () => {}, () => {}), /ended before/);
  for (const invalid of ['[{"a":1},]', '[{"a":1}{"a":2}]', '[,{"a":1}]', '[{"a":1},,{"a":2}]']) {
    await assert.rejects(parseJsonArray(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(invalid)); controller.close(); } }), async () => {}, () => {}, () => {}), /comma|separated|objects/i, invalid);
  }
}
const assets = {
  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.hostname === 'demodb.dev' && url.pathname === '/research-snapshots/chinook.manifest.json') {
      return new Response('{"fixture":"research manifest"}', { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname.endsWith('/_db/chinook/data/json/chinook.Order%20Details.json.gz')) return new Response(gzipPayloadBytes, { headers: { 'Content-Type': 'application/gzip', 'Content-Length': String(gzipPayloadBytes.length), 'Accept-Ranges': 'bytes' } });
    const chunk = chunkAssets.get(decodeURIComponent(url.pathname));
    if (chunk) return new Response(request.method === 'HEAD' ? null : chunk, { headers: { 'Content-Length': String(chunk.length), 'Accept-Ranges': 'bytes' } });
    if (url.pathname.endsWith('/redirect-test/index.html')) return new Response(null, { status: 302, headers: { Location: '/_db/northwind/index.html' } });
    const name = decodeURIComponent(url.pathname.replace(/^\//, ''));
    try {
      const bytes = await readFile(join(dist, name));
      const ext = name.slice(name.lastIndexOf('.'));
      const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript' };
      return new Response(request.method === 'HEAD' ? null : bytes, { status: 200, headers: { 'Content-Type': types[ext] ?? 'application/octet-stream' } });
    } catch { return new Response('Not found', { status: 404 }); }
  },
};

function makeRequest(host: string, path: string, method = 'GET', init?: RequestInit) {
  return new Request(`https://${host}${path}`, { method, ...init });
}
async function fetch(host: string, path: string, method = 'GET', env = local, init?: RequestInit) {
  return worker.fetch(makeRequest(host, path, method, init), { ...env, ASSETS: assets } as Env, {} as ExecutionContext);
}

assert.equal(resolveHost('chinook.demodb.dev').databaseId, 'chinook');
assert.equal(resolveHost('northwind.localhost', local).databaseId, 'northwind');
assert.equal(resolveHost('pubs.localhost', local).databaseId, 'pubs');
assert.equal(resolveHost('adventureworks.localhost', local).databaseId, 'adventureworks');
assert.equal(resolveHost('employees.localhost', local).databaseId, 'employees');
assert.equal(resolveHost('unknown.demodb.dev').databaseId, undefined);
assert.equal((await fetch('demodb.dev', '/research-snapshots/chinook.manifest.json')).status, 200, 'research bundles are served from the catalogue asset path');
assert.equal((await fetch('chinook.demodb.dev', '/research-snapshots/chinook.manifest.json')).status, 404, 'database subdomains do not expose catalogue-scoped research bundles');
assert.equal(internalAssetPath('northwind', '/tables/Order%20Details/'), '/_db/northwind/tables/Order%20Details/index.html');
assert.equal(internalAssetPath('northwind', '/theme.js'), '/theme.js', 'shared theme controller is not host-prefixed');
assert.equal(internalAssetPath('northwind', '/embed/exact-decimal.js'), '/embed/exact-decimal.js', 'the exact comparator module is served from database subdomains');
assert.equal(internalAssetPath('northwind', '/_db/northwind/index.html'), '/404.html');

for (const [host, expected] of [['demodb.dev', 'Northwind'], ['localhost', 'DemoDB']] as const) {
  const response = await fetch(host, '/');
  assert.equal(response.status, 200, host);
  const html = await response.text();
  assert.ok(html.includes(expected), `${host} page contains its expected heading`);
  assert.match(html, /Explore OpenVaultDB server/);
  assert.match(html, /Browse server and storage catalogue/);
}
const decimalModule = await fetch('chinook.demodb.dev', '/embed/exact-decimal.js');
assert.equal(decimalModule.status, 200, 'database subdomains serve the exact decimal comparator');
assert.match(await decimalModule.text(), /compareDecimalValues/);
for (const database of providerIndex.databases as { id: string; name: string; siteHost: string }[]) {
  const response = await fetch(database.siteHost, '/');
  assert.equal(response.status, 200, database.siteHost);
  assert.ok((await response.text()).includes(database.name), `${database.id} landing page uses its provider title`);
}
for (const host of ['demodb.dev', ...((providerIndex.databases as { siteHost: string }[]).map((database) => database.siteHost))]) {
  const theme = await fetch(host, '/theme.js');
  assert.equal(theme.status, 200, `${host} serves the shared theme controller`);
  assert.match(await theme.text(), /demodb-theme/, `${host} serves the preference logic`);
}

const rootDocs = await fetch('demodb.dev', '/_db/northwind/index.html');
assert.equal(rootDocs.status, 404, 'internal static namespace cannot be requested publicly');
assert.equal((await fetch('demodb.dev', '/', 'POST')).status, 405, 'catalogue pages are read-only');
const siteMap = await fetch('demodb.dev', '/sitemap.xml');
assert.equal(siteMap.status, 200);
const siteMapXml = await siteMap.text();
for (const database of providerIndex.databases as { siteHost: string }[]) assert.match(siteMapXml, new RegExp(`https:\/\/${database.siteHost.replaceAll('.', '\\.')}\/`));
assert.match(siteMapXml, /https:\/\/demodb\.dev\/ovdb\//);
assert.match(siteMapXml, /https:\/\/demodb\.dev\/northwind\//);
for (const { storages } of storageGroups) for (const storage of storages) assert.ok(siteMapXml.includes(`https://demodb.dev/ovdb/db/${storage.id}/`));
const corpusResponse = await fetch('demodb.dev', '/corpus.json');
assert.equal(corpusResponse.status, 200);
assert.equal(corpusResponse.headers.get('Access-Control-Allow-Origin'), '*');
assert.match(await corpusResponse.text(), /demodb-corpus\/draft-1/);
assert.match(await (await fetch('chinook.demodb.dev', '/sitemap.xml')).text(), /\/tables\/Artist\//);
assert.match(await (await fetch('northwind.demodb.dev', '/robots.txt')).text(), /https:\/\/northwind\.demodb\.dev\/sitemap\.xml/);
assert.equal((await fetch('evil.example', '/')).status, 404, 'unknown hosts fail closed');
assert.equal((await fetch('northwind.demodb.dev', '/data/%2Fetc%2Fpasswd')).status, 400, 'encoded path separators are rejected');

const detailsPage = await fetch('northwind.demodb.dev', '/tables/Order%20Details/');
assert.equal(detailsPage.status, 200);
const detailsHtml = await detailsPage.text();
assert.match(detailsHtml, /Order Details/);
assert.match(detailsHtml, /InvoiceLine/);
assert.match(detailsHtml, /shared meaning concept/);
const viewPage = await fetch('northwind.demodb.dev', '/tables/Invoices/');
assert.equal(viewPage.status, 200);
const viewHtml = await viewPage.text();
assert.match(viewHtml, /View definition/);
assert.match(viewHtml, /SELECT/i);
assert.match(viewHtml, /Data preview/);
assert.doesNotMatch(viewHtml, /<datatug-grid/i, 'native views without provider JSON exports do not claim live OVDB collections');

for (const [host, name] of [['chinook.demodb.dev', 'Chinook'], ['northwind.demodb.dev', 'Northwind']] as const) {
  const home = await fetch(host, '/');
  const html = await home.text();
  assert.match(html, new RegExp(`<a[^>]+href="https://demodb\\.dev/"[^>]*aria-label="DemoDB home"`), `${name} brand returns to the catalogue`);
  assert.match(html, /href="https:\/\/demodb\.dev\/"[^>]*>All sample databases<\/a>/, `${name} landing page links back to the catalogue`);
  assert.match(html, /href="https:\/\/demodb\.dev\/"[^>]*>All databases<\/a>/, `${name} footer links back to the catalogue`);
  assert.match(html, /href="\/tables\/"/, `${name} table navigation stays on the database host`);
  assert.match(html, /href="\/schema\/"/, `${name} schema navigation stays on the database host`);
  assert.match(html, new RegExp(`href="https://demodb\\.dev/${name.toLowerCase()}/">Explore in OpenVaultDB`), `${name} landing page links to its canonical OVDB identity`);
}
const pubsHomeHtml = await (await fetch('pubs.demodb.dev', '/')).text();
assert.match(pubsHomeHtml, /Pubs/);
assert.match(pubsHomeHtml, /href="https:\/\/demodb\.dev\/"[^>]*>All sample databases<\/a>/);
assert.equal((await fetch('pubs.demodb.dev', '/tables/')).status, 200, 'Pubs has static table navigation');
const pubsKeyless = await fetch('pubs.demodb.dev', '/tables/discounts/');
assert.match(await pubsKeyless.text(), /No primary key is declared for this native table/, 'keyless physical tables are identified from native primary-key metadata');
assert.equal((await fetch('sakila.demodb.dev', '/data/sakila.sqlite', 'HEAD')).status, 200, 'Sakila keeps its full SQLite download route');
const sakilaView = await fetch('sakila.demodb.dev', '/tables/actor_info/');
assert.equal(sakilaView.status, 200, 'Sakila native view remains browsable as schema metadata');
assert.match(await sakilaView.text(), /actor_info/);
const adventureworksSchema = await fetch('adventureworks.demodb.dev', '/schema.json');
assert.equal(adventureworksSchema.status, 200, 'AdventureWorks publishes its complete SQLite and source-view schema');
const adventureworksSchemaData = await adventureworksSchema.json() as { tables: { kind: string; name: string }[]; sourceViews: { recordset: string; availableAsSqliteView: boolean }[] };
assert.equal(adventureworksSchemaData.tables.filter((table) => table.kind === 'table').length, 71);
assert.equal(adventureworksSchemaData.tables.filter((table) => table.kind === 'view').length, 11);
assert.equal(adventureworksSchemaData.sourceViews.length, 20);
assert.equal(adventureworksSchemaData.sourceViews.filter((view) => view.availableAsSqliteView).length, 11);
assert.equal(adventureworksSchemaData.sourceViews.filter((view) => !view.availableAsSqliteView).length, 9);
assert.ok(adventureworksSchemaData.sourceViews.some((view) => view.recordset === 'Person.vAdditionalContactInfo' && !view.availableAsSqliteView));
assert.ok(!adventureworksSchemaData.tables.some((table) => table.name === 'Person.vAdditionalContactInfo'), 'unsupported SQL Server views are not advertised as executable SQLite recordsets');
const adventureworksSchemaPage = await fetch('adventureworks.demodb.dev', '/schema/');
assert.equal(adventureworksSchemaPage.status, 200);
const adventureworksSchemaHtml = await adventureworksSchemaPage.text();
assert.match(adventureworksSchemaHtml, /20 definitions retained/);
assert.match(adventureworksSchemaHtml, /11 available as SQLite views · 9 source-only/);
assert.match(adventureworksSchemaHtml, /Person\.vAdditionalContactInfo/);
assert.match(adventureworksSchemaHtml, /source definition only/);
assert.equal((await fetch('adventureworks.demodb.dev', '/data/adventureworks.sqlite', 'HEAD')).status, 200, 'AdventureWorks keeps its complete SQLite download route');
assert.equal((await fetch('employees.demodb.dev', '/tables/titles/')).status, 200, 'Employees composite-key table is browsable');
assert.equal((await fetch('employees.demodb.dev', '/tables/current_dept_emp/')).status, 200, 'Employees native view is browsable');
assert.equal((await fetch('employees.demodb.dev', '/data/employees.sqlite', 'HEAD')).status, 200, 'Employees publishes the full SQLite download');
const json = await fetch('northwind.demodb.dev', '/data/json/northwind.Order%20Details.json');
assert.equal(json.status, 200);
assert.equal(json.headers.get('Access-Control-Allow-Origin'), '*');
assert.equal(json.headers.get('Content-Type'), 'application/json; charset=utf-8');
assert.equal((await json.json() as unknown[]).length, 2155);
const encodedJson = await fetch('chinook.demodb.dev', '/data/json/chinook.Order%20Details.json');
assert.equal(encodedJson.status, 200);
assert.equal(encodedJson.headers.get('Content-Type'), 'application/json; charset=utf-8');
assert.equal(encodedJson.headers.get('Content-Encoding'), 'gzip');
assert.match(encodedJson.headers.get('Vary') ?? '', /Accept-Encoding/i);
assert.equal(gunzipSync(Buffer.from(await encodedJson.arrayBuffer())).toString('utf8'), gzipPayload.toString('utf8'), 'precompressed export bytes are not double-encoded by the Worker');
const encodedHead = await fetch('chinook.demodb.dev', '/data/json/chinook.Order%20Details.json', 'HEAD');
assert.equal(encodedHead.status, 200);
assert.equal(encodedHead.headers.get('Content-Encoding'), 'gzip');
assert.equal(await encodedHead.text(), '');
const encodedRange = await worker.fetch(makeRequest('chinook.demodb.dev', '/data/json/chinook.Order%20Details.json', 'GET', { headers: { Range: 'bytes=0-3' } }), { ...local, ASSETS: assets } as Env, {} as ExecutionContext);
assert.equal(encodedRange.status, 200, 'compressed exports ignore byte ranges and serve one complete representation');
assert.equal(encodedRange.headers.get('Content-Range'), null);
assert.equal(encodedRange.headers.get('Accept-Ranges'), null);
const chunkedResponse = await fetch('chinook.demodb.dev', '/data/chinook.sqlite');
const chunkedExport = chinookGenerated.exports.find((file) => file.publicPath === 'chinook.sqlite' && file.chunks?.length)!;
assert.equal(chunkedResponse.status, 200);
assert.equal(chunkedResponse.headers.get('Content-Type'), 'application/vnd.sqlite3');
assert.equal(chunkedResponse.headers.get('Content-Encoding'), 'gzip');
assert.equal(chunkedResponse.headers.get('Content-Length'), String(chunkedEncoded.length));
assert.match(chunkedResponse.headers.get('Vary') ?? '', /Accept-Encoding/i);
assert.equal(gunzipSync(Buffer.from(await chunkedResponse.arrayBuffer())).compare(chunkedPayload), 0, 'the canonical database URL joins ordered verified chunks into the complete gzip stream');
let streamedAssetRequests = 0;
const streamingAssets = {
  async fetch(request: Request) {
    const path = decodeURIComponent(new URL(request.url).pathname);
    const bytes = chunkAssets.get(path);
    if (!bytes) return assets.fetch(request);
    streamedAssetRequests++;
    const split = Math.max(1, Math.floor(bytes.length / 2));
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, split));
        controller.enqueue(bytes.subarray(split));
        controller.close();
      },
    }), { headers: { 'Content-Length': String(bytes.length) } });
  },
};
const streamingResponse = await serveChunkedGzip(
  makeRequest('chinook.demodb.dev', '/data/chinook.sqlite'),
  { ...local, ASSETS: streamingAssets } as Env,
  new URL('https://chinook.demodb.dev/data/chinook.sqlite'),
  'chinook',
  chunkedExport,
);
const streamingReader = streamingResponse.body!.getReader();
const firstStreamPart = await streamingReader.read();
assert.ok(firstStreamPart.value?.byteLength, 'the first verified immutable chunk streams before buffering the joined export');
assert.equal(streamedAssetRequests, 1, 'backpressure prevents fetching the next asset chunk before the current stream is consumed');
await streamingReader.cancel();
const chunkedHead = await fetch('chinook.demodb.dev', '/data/chinook.sqlite', 'HEAD');
assert.equal(chunkedHead.status, 200);
assert.equal(chunkedHead.headers.get('Content-Encoding'), 'gzip');
assert.equal(chunkedHead.headers.get('Content-Length'), String(chunkedEncoded.length));
assert.equal(await chunkedHead.text(), '');
const chunkedRange = await worker.fetch(makeRequest('chinook.demodb.dev', '/data/chinook.sqlite', 'GET', { headers: { Range: 'bytes=0-3' } }), { ...local, ASSETS: assets } as Env, {} as ExecutionContext);
assert.equal(chunkedRange.status, 200, 'chunked compressed exports ignore ranges rather than serving a partial gzip stream');
assert.equal(chunkedRange.headers.get('Content-Range'), null);
assert.equal(chunkedRange.headers.get('Accept-Ranges'), null);
const secondChunk = chunkMetadata[1];
const secondChunkPath = `/_db/chinook/data/${secondChunk.assetPath}`;
const secondChunkBytes = chunkAssets.get(secondChunkPath)!;
chunkAssets.set(secondChunkPath, secondChunkBytes.subarray(0, secondChunkBytes.length - 1));
const truncatedChunkResponse = await fetch('chinook.demodb.dev', '/data/chinook.sqlite');
await assert.rejects(truncatedChunkResponse.arrayBuffer(), /unexpected size/, 'a short immutable asset cannot be reported as a complete export');
chunkAssets.set(secondChunkPath, secondChunkBytes);
const joinedBytes = chunkedExport.bytes!;
chunkedExport.bytes = joinedBytes + 1;
const invalidJoinedResponse = await serveChunkedGzip(
  makeRequest('chinook.demodb.dev', '/data/chinook.sqlite'),
  { ...local, ASSETS: assets } as Env,
  new URL('https://chinook.demodb.dev/data/chinook.sqlite'),
  'chinook',
  chunkedExport,
);
await assert.rejects(invalidJoinedResponse.arrayBuffer(), /unexpected size/, 'the joined stream length is checked after every chunk is streamed');
chunkedExport.bytes = joinedBytes;
const csv = await fetch('chinook.demodb.dev', '/data/csv/chinook.Artist.csv');
assert.equal(csv.status, 200);
assert.equal(csv.headers.get('Access-Control-Allow-Origin'), '*');
assert.match(await csv.text(), /ArtistId,Name/);
const metadata = await fetch('chinook.demodb.dev', '/data/metadata/checksums.json');
assert.equal(metadata.status, 200, 'legacy data metadata URL remains available');
assert.equal((await fetch('chinook.demodb.dev', '/data/metadata/source.json')).status, 200);
assert.equal((await fetch('chinook.demodb.dev', '/data/chinook.sqlite', 'HEAD')).status, 200);
for (const path of ['/data/chinook.json', '/data/chinook.yaml', '/data/chinook.postgresql.sql', '/data/chinook.mysql.sql', '/data/chinook.sqlserver.sql', '/data/json/chinook.Album.json', '/data/yaml/chinook.Album.yaml', '/data/sql/chinook.Album.sql']) {
  assert.equal((await fetch('chinook.demodb.dev', path)).status, 200, `legacy Chinook export remains available at ${path}`);
}
assert.equal((await fetch('northwind.demodb.dev', '/data/northwind.sql')).status, 200);
assert.equal((await fetch('northwind.demodb.dev', '/data/json/northwind.Customers.json', 'OPTIONS')).status, 204);
assert.equal((await fetch('northwind.demodb.dev', '/data/json/northwind.Customers.json', 'POST')).status, 405);
assert.equal((await fetch('northwind.demodb.dev', '/data/%255fdb/northwind/index.html')).status, 400, 'double-encoded path segments are rejected');
assert.equal((await fetch('northwind.demodb.dev', '/build-info.json')).status, 200, 'exact build marker is visible on each official host');
assert.equal((await fetch('northwind.demodb.dev', '/redirect-test/')).status, 404, 'asset redirects never expose private build paths');
for (const path of ['/_db/northwind/index.html', '/%5fdb/northwind/index.html', '/%5Fdb/northwind/index.html']) {
  assert.equal((await fetch('demodb.dev', path)).status, 404, `internal static namespace must stay private: ${path}`);
}

const schema = await fetch('northwind.demodb.dev', '/schema.json');
assert.equal(schema.status, 200);
const schemaJson = await schema.json() as { tables: { name: string }[] };
assert.ok(schemaJson.tables.some((table) => table.name === 'Order Details'));
const model = await fetch('chinook.demodb.dev', '/model/chinook.modelspec.hcl');
assert.equal(model.status, 200);
assert.equal(model.headers.get('Access-Control-Allow-Origin'), '*');
assert.match(await model.text(), /entity/);
const modelPage = await fetch('chinook.demodb.dev', '/model/');
assert.equal(modelPage.status, 200);
assert.equal(modelPage.headers.get('Access-Control-Allow-Origin'), null);

for (const database of providerIndex.databases as { id: string; siteHost: string; ovdb: { query: boolean } }[]) {
  const { id, siteHost } = database;
  const discovery = await fetch(siteHost, '/.well-known/openvaultdb');
  assert.equal(discovery.status, 200);
  assert.equal(discovery.headers.get('Access-Control-Allow-Origin'), '*');
  const body = await discovery.json() as { databases: { id: string; url: string; apiUrl: string; capabilities: { query: boolean } }[] };
  assert.equal(body.databases.length, 1);
  assert.equal(body.databases[0].id, id);
  assert.equal(body.databases[0].apiUrl, `https://demodb.dev/ovdb/v1/databases/${id}`);
  assert.equal(body.databases[0].capabilities.query, database.ovdb.query, `${id} discovery matches its declared query capability`);
}
const downloads = await fetch('northwind.demodb.dev', '/downloads/');
assert.equal(downloads.status, 200);
const downloadsHtml = await downloads.text();
assert.match(downloadsHtml, /Check storage and import/);
assert.match(downloadsHtml, /Remove local copy/);
assert.match(downloadsHtml, /Order Details/);
for (const { id, name } of providerIndex.databases as { id: string; name: string }[]) {
  const publicDatabasePage = await fetch('demodb.dev', `/${id}/`);
  assert.equal(publicDatabasePage.status, 200, `canonical ${id} database page exists`);
  assert.ok((await publicDatabasePage.text()).includes(name), `${id} canonical page contains its provider title`);
  const nestedHuman = await fetch('demodb.dev', `/ovdb/db/${id}/`);
  assert.equal(nestedHuman.status, 200, 'server database resource has a human-readable page');
  const nestedHtml = await nestedHuman.text();
  assert.match(nestedHtml, new RegExp(`rel="canonical" href="https://demodb.dev/${id}/"`));
  assert.doesNotMatch(nestedHtml, /0 views/, 'table-only published inventory does not imply that the server exposes no views');
  assert.match(nestedHtml, /ModelSpec:/);
  assert.match(nestedHtml, /MeaningGraph:/);
  assert.equal((await fetch('demodb.dev', `/ovdb/db/${id}`)).headers.get('Location'), `https://demodb.dev/${id}/`);
  assert.equal((await fetch('demodb.dev', `/ovdb/dbs/${id}/`)).headers.get('Location'), `https://demodb.dev/${id}/`);
  const serverJson = await fetch('demodb.dev', `/ovdb/db/${id}/ovdb-database.json`);
  const shortJson = await fetch('demodb.dev', `/${id}/ovdb-database.json`);
  assert.equal(serverJson.status, 200);
  assert.equal(shortJson.status, 200);
  const serverBytes = new Uint8Array(await serverJson.arrayBuffer());
  const shortBytes = new Uint8Array(await shortJson.arrayBuffer());
  assert.deepEqual([...serverBytes], [...shortBytes], `${id} typed manifest mirrors are byte-identical`);
  const descriptor = JSON.parse(new TextDecoder().decode(serverBytes)) as { id: string; localId: string; capabilities: { read: boolean; query: boolean; write: boolean }; recordsets: { name: string; kind: string; columns: unknown[] }[] };
  assert.equal(descriptor.id, `https://demodb.dev/${id}/`);
  assert.equal(descriptor.localId, id);
  assert.equal(descriptor.capabilities.read, true);
  assert.equal(descriptor.capabilities.write, false);
  assert.ok(descriptor.recordsets.length > 0);
  assert.ok(descriptor.recordsets.every((recordset) => Array.isArray(recordset.columns)));
  assert.ok(descriptor.recordsets.every((recordset) => !('rows' in recordset)), 'published descriptors contain schema only, no record samples');
  assert.equal(serverJson.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal((await fetch('demodb.dev', `/ovdb/db/${id}/ovdb-database.json`, 'HEAD')).status, 200);
  assert.equal((await fetch('demodb.dev', `/ovdb/db/${id}/ovdb-database.json`, 'OPTIONS')).status, 204);
}
const serverManifestResponse = await fetch('demodb.dev', '/ovdb/ovdb-server.json');
assert.equal(serverManifestResponse.status, 200);
const serverManifest = await serverManifestResponse.json() as { format: string; id: string; databases: { id: string; localId: string; serverDbBaseUrl: string; manifestUrl: string; apiUrl: string }[] };
assert.equal(serverManifest.format, 'ovdb-server/draft-1');
assert.equal(serverManifest.id, 'https://demodb.dev/ovdb');
assert.deepEqual(serverManifest.databases.map((database) => database.localId).sort(), (providerIndex.databases as { id: string }[]).map((database) => database.id).sort());
assert.equal(serverManifest.databases.find((database) => database.localId === 'pubs')?.id, 'https://demodb.dev/pubs/');
assert.ok(serverManifest.databases.every((database) => database.manifestUrl === `${database.serverDbBaseUrl}ovdb-database.json`));
assert.equal((await fetch('demodb.dev', '/ovdb/')).status, 200);
const storageCatalogueHtml = await (await fetch('demodb.dev', '/ovdb/')).text();
assert.match(storageCatalogueHtml, /6 datasets\. 4 storage editions each/);
assert.match(storageCatalogueHtml, /six SQLite databases with working public APIs/);
assert.match(storageCatalogueHtml, /authenticated Google accounts/);
assert.equal(storageGroups.length, 6);
assert.equal(storageEngineCount, 4);
assert.equal(storageEntryCount, 24);
assert.equal(publicOvdbApiCount, 6);
assert.equal(bigQueryHosting.projectId, 'demodb-dev');
assert.equal(bigQueryHosting.location, 'US');
assert.equal(bigQueryHosting.queryAccess.permissionPrincipal, 'allAuthenticatedUsers');
assert.equal(bigQueryHosting.queryAccess.googleAuthenticationRequired, true);
assert.equal(bigQueryHosting.queryAccess.browserQueryInDataTug, 'not-enabled');
assert.equal(bigQueryHosting.datasets.reduce((total, edition) => total + edition.tableCount, 0), 128);
assert.equal(bigQueryHosting.datasets.reduce((total, edition) => total + edition.rowCount, 0), 839264);
for (const { database, storages } of storageGroups) {
  assert.equal(storages.length, 4);
  for (const storage of storages) {
    const path = `/ovdb/db/${storage.id}/`;
    assert.ok(storageCatalogueHtml.includes(`href="${path}"`), `${storage.id} linked from catalogue`);
    const response = await fetch('demodb.dev', path);
    assert.equal(response.status, 200, `${storage.id} page exists`);
    const html = await response.text();
    assert.match(html, new RegExp(`rel="canonical" href="https://demodb.dev${path}"`));
    assert.match(html, new RegExp(`Storage ID: <code>${storage.id}</code>`));
    assert.match(html, new RegExp(`Dataset ID: <code>${database.localId}</code>`));
    assert.equal((await fetch('demodb.dev', path, 'HEAD')).status, 200);
    assert.equal((await fetch('demodb.dev', path, 'POST')).status, 405);
    assert.equal((await fetch('demodb.dev', path.slice(0, -1))).headers.get('Location'), `https://demodb.dev${path}`);
    if (storage.readiness === 'public-api') {
      assert.match(html, new RegExp(`href="${database.apiUrl}"`));
      assert.match(html, new RegExp(`href="/ovdb/db/${database.localId}/ovdb-database.json"`));
    } else if (storage.readiness === 'hosted-repository') {
      const revision = registry.ingitdbRevisions[database.localId as keyof typeof registry.ingitdbRevisions];
      assert.equal(storage.revision, revision);
      assert.match(html, new RegExp(`git checkout ${revision}`));
      assert.match(html, /ingitdb validate --path ingitdb/);
      assert.match(html, /inGitDB CLI v0\.70\.0 or newer/);
      assert.match(html, /Views are metadata only/);
      assert.match(html, /parity checker/);
      assert.match(html, /native inGitDB validation does not enforce those SQL constraints/);
      assert.ok(html.includes(`href="https://github.com/demo-db/${database.localId}/tree/${revision}/ingitdb"`));
      assert.ok(html.includes(`href="https://github.com/demo-db/${database.localId}/blob/${revision}/ingitdb/export-manifest.json"`));
      assert.ok(html.includes(`href="https://github.com/demo-db/${database.localId}/blob/${revision}/ingitdb/native-parity-report.json"`));
      assert.ok(html.includes(`href="https://github.com/demo-db/${database.localId}/blob/${revision}/ingitdb/.ingitdb/source-collections.json"`));
      assert.ok(html.includes('https://github.com/demo-db/websites/blob/main/scripts/hosting-tools/validate_datatug_exports.py'));
      assert.doesNotMatch(html, /Open read-only API|Database descriptor/);
      assert.equal((await fetch('demodb.dev', `${path}ovdb-database.json`)).status, 404);
      assert.equal((await fetch('demodb.dev', `/ovdb/v1/databases/${storage.id}`)).status, 404);
    } else if (storage.readiness === 'public-read-user-project-required') {
      const edition = bigQueryHosting.datasets.find((candidate) => candidate.id === database.localId);
      assert.ok(edition, `${database.localId} has a hosted BigQuery receipt`);
      assert.equal(storage.sourceProjectId, 'demodb-dev');
      assert.equal(storage.datasetId, database.localId);
      assert.equal(storage.location, 'US');
      assert.equal(storage.executionProject, 'user-selected');
      assert.equal(storage.tableCount, edition.tableCount);
      assert.equal(storage.rowCount, edition.rowCount);
      assert.equal(storage.sourceSqliteSha256, edition.sourceSqliteSha256);
      assert.match(html, /authenticated Google accounts/);
      assert.match(html, /execution project selected by you/);
      assert.match(html, /DataTug browser connection is not enabled yet/);
      assert.match(html, /Unverified primary- and foreign-key declarations are omitted/);
      assert.match(html, /secondary indexes are not represented/);
      assert.ok(html.includes('https://github.com/demo-db/websites/blob/main/config/bigquery-hosting.json'));
      assert.doesNotMatch(html, /Open read-only API|Database descriptor/);
      assert.equal((await fetch('demodb.dev', `${path}ovdb-database.json`)).status, 404);
      assert.equal((await fetch('demodb.dev', `/ovdb/v1/databases/${storage.id}`)).status, 404, 'BigQuery storage has no OVDB API route');
    } else {
      assert.match(html, /hosted on Neon/);
      assert.match(html, /Public OpenVaultDB API access is being prepared/);
      assert.doesNotMatch(html, /served from a pinned copy of the upstream SQLite fixture|The pinned SQLite build is read-only/);
      assert.doesNotMatch(html, /Open read-only API|Database descriptor/);
      assert.equal((await fetch('demodb.dev', `${path}ovdb-database.json`)).status, 404);
      assert.equal((await fetch('demodb.dev', `/ovdb/v1/databases/${storage.id}`)).status, 404, 'pending PostgreSQL storage has no public API route');
    }
  }
}
assert.equal((await fetch('demodb.dev', '/ovdb/db/missing-postgresql/')).status, 404);
assert.equal((await fetch('demodb.dev', '/ovdb/v1')).status, 200, 'declared API root returns the server descriptor');
assert.equal((await fetch('demodb.dev', '/ovdb/schemas/ovdb-database-draft-1.schema.json')).status, 200);
const centralDiscovery = await fetch('demodb.dev', '/.well-known/openvaultdb');
assert.equal(centralDiscovery.status, 200);
assert.equal(centralDiscovery.headers.get('Access-Control-Allow-Origin'), '*');
const discoveredDatabases = (await centralDiscovery.json() as { databases: { id: string; url: string; manifestUrl: string; apiUrl: string }[] }).databases;
assert.deepEqual(discoveredDatabases.map((database) => database.id).sort(), (providerIndex.databases as { id: string }[]).map((database) => database.id).sort(), 'legacy discovery keeps local database IDs');
assert.ok(discoveredDatabases.every((database) => database.url === `https://demodb.dev/${database.id}/` && database.manifestUrl === `https://demodb.dev/ovdb/db/${database.id}/ovdb-database.json`));
const redirect = await fetch('northwind.demodb.dev', '/ovdb/dbs/northwind/collections/Order%20Details?limit=2');
assert.equal(redirect.status, 308);
assert.equal(redirect.headers.get('Location'), 'https://cloud.openvaultdb.com/ovdb/dbs/northwind/collections/Order%20Details?limit=2');
const postRedirect = await fetch('chinook.demodb.dev', '/ovdb/v1/databases/chinook/dtql?format=json', 'POST', local, { body: '{"query":"from: {name: Artist}"}', headers: { 'Content-Type': 'application/json' } });
assert.equal(postRedirect.status, 308);
assert.equal(postRedirect.headers.get('Location'), 'https://demodb.dev/ovdb/v1/databases/chinook/dtql?format=json');
const legacyDisabled = await fetch('chinookdb.com', '/tables/Artist/?x=1', 'GET', { ...local, ENABLE_LEGACY_REDIRECTS: 'false' });
assert.equal(legacyDisabled.status, 404);
const redirectCases = [
  ['GET', '/tables/Artist/?filter=live%20tracks', 'https://chinook.demodb.dev/tables/Artist/?filter=live%20tracks'],
  ['HEAD', '/data/chinook.sqlite?download=1', 'https://chinook.demodb.dev/data/chinook.sqlite?download=1'],
  ['GET', '/model/chinook.modelspec.json?format=source', 'https://chinook.demodb.dev/model/chinook.modelspec.json?format=source'],
  ['GET', '/ovdb/dbs/chinook?view=collections', 'https://demodb.dev/chinook/?view=collections'],
  ['HEAD', '/ovdb/db/chinook/?view=collections', 'https://demodb.dev/chinook/?view=collections'],
  ['POST', '/ovdb/v1/databases/chinook/dtql?q=a%20b', 'https://demodb.dev/ovdb/v1/databases/chinook/dtql?q=a%20b'],
  ['GET', '/ovdb/dbs/chinook/collections/Album?limit=5', 'https://chinook.demodb.dev/ovdb/dbs/chinook/collections/Album?limit=5'],
] as const;
for (const [method, path, expected] of redirectCases) {
  const response = await fetch('chinookdb.com', path, method, { ...local, ENABLE_LEGACY_REDIRECTS: 'true' }, method === 'POST' ? { body: 'query: { name: Album }' } : undefined);
  assert.equal(response.status, 308, `${method} ${path} uses a permanent method-preserving redirect`);
  assert.equal(response.headers.get('Location'), expected, `${method} ${path} preserves its canonical route and query`);
}
for (const path of ['/ovdb/v1/databases/unknown/dtql', '/ovdb/dbs/unknown', '/ovdb/db/unknown/']) {
  assert.equal((await fetch('chinookdb.com', path, 'GET', { ...local, ENABLE_LEGACY_REDIRECTS: 'true' })).status, 404, `${path} fails closed for an unknown database`);
}
const oldOVDBPreflight = await fetch('chinookdb.com', '/ovdb/v1/databases/chinook/dtql', 'OPTIONS', { ...local, ENABLE_LEGACY_REDIRECTS: 'true' });
assert.match(oldOVDBPreflight.headers.get('Access-Control-Allow-Headers') ?? '', /OVDB-Page-Token/);

const platformFetch = globalThis.fetch;
const platformConsoleError = console.error;
const gatewayLogs: string[] = [];
let nextFetchError: Error | undefined;
console.error = (...args: Parameters<typeof console.error>) => { gatewayLogs.push(args.join(' ')); };
const forwarded: { url: string; method: string; headers: Headers; body?: string; redirect?: RequestRedirect }[] = [];
let nextRedirectLocation: string | undefined;
globalThis.fetch = async (input, init) => {
  if (nextFetchError) {
    const error = nextFetchError;
    nextFetchError = undefined;
    throw error;
  }
  const request = input instanceof Request ? input : new Request(input, init);
  assert.equal(new URL(request.url).hostname, 'cloud.openvaultdb.com', 'only the fixed public backend receives proxied requests');
  forwarded.push({ url: request.url, method: request.method, headers: request.headers, body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.clone().text(), redirect: init?.redirect });
  if (nextRedirectLocation) {
    const location = nextRedirectLocation;
    nextRedirectLocation = undefined;
    return new Response(null, { status: 302, headers: { Location: location } });
  }
  const requestedMetadata = /^\/v1\/databases\/(chinook|northwind|pubs|sakila)$/.exec(new URL(request.url).pathname);
  const payload = requestedMetadata ? {
    id: requestedMetadata[1], engine: 'sqlite', schemaMode: 'relational', collections: ['Orders', 'Order Details'],
    capabilities: { read: true, query: true, dtql: true, write: false },
    endpoints: { dtql: `https://cloud.openvaultdb.com/v1/databases/${requestedMetadata[1]}/dtql` }, queryFormat: 'dtql-yaml+json',
  } : { records: [{ key: 'Order Details/OrderID=10248;ProductID=11', data: { id: 'OrderID=10248;ProductID=11', OrderID: 10248, ProductID: 11 } }] };
  return new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': requestedMetadata ? 'no-store' : 'public, max-age=30', Vary: 'Origin, OVDB-Page-Size, OVDB-Page-Token, OVDB-Page-Close', 'OVDB-Page-Token': 'next-page', ETag: 'upstream-etag', 'Set-Cookie': 'must-not-pass=secret' },
  });
};
try {
  const databaseApiIndex = await fetch('demodb.dev', '/ovdb/v1/databases/northwind');
  assert.equal(databaseApiIndex.status, 200, 'existing OVDB database API metadata route remains available');
  const apiMetadata = await databaseApiIndex.json() as { id: string; engine: string; schemaMode: string; collections: string[]; capabilities: { dtql: boolean; write: boolean }; endpoints: { dtql: string }; queryFormat: string };
  assert.equal(apiMetadata.id, 'northwind');
  assert.equal(apiMetadata.engine, 'sqlite');
  assert.equal(apiMetadata.schemaMode, 'relational');
  assert.deepEqual(apiMetadata.collections, ['Orders', 'Order Details']);
  assert.equal(apiMetadata.capabilities.dtql, true);
  assert.equal(apiMetadata.capabilities.write, false);
  assert.equal(apiMetadata.endpoints.dtql, 'https://demodb.dev/ovdb/v1/databases/northwind/dtql');
  assert.equal(apiMetadata.queryFormat, 'dtql-yaml+json');
  assert.equal(forwarded.at(-1)?.redirect, 'manual', 'metadata fetch rejects redirects without following them');
  assert.equal(databaseApiIndex.headers.get('Cache-Control'), 'no-store');
  assert.equal(databaseApiIndex.headers.get('ETag'), null, 'rewritten metadata does not retain the backend representation ETag');
  const record = await fetch('demodb.dev', '/ovdb/v1/databases/northwind/records/Order%20Details/OrderID%3D10248%3BProductID%3D11');
  assert.equal(record.status, 200);
  assert.equal(record.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(record.headers.get('Set-Cookie'), null);
  assert.equal(record.headers.get('OVDB-Page-Token'), 'next-page');
  assert.match(record.headers.get('Access-Control-Expose-Headers') ?? '', /OVDB-Page-Token/);
  assert.deepEqual((await record.json() as { records: { key: string; data: { id: string } }[] }).records[0], {
    key: 'Order Details/OrderID=10248;ProductID=11', data: { id: 'OrderID=10248;ProductID=11', OrderID: 10248, ProductID: 11 },
  });
  assert.equal(forwarded.at(-1)?.url, 'https://cloud.openvaultdb.com/v1/databases/northwind/records/Order%20Details/OrderID%3D10248%3BProductID%3D11');
  const getQuery = await fetch('demodb.dev', '/ovdb/v1/databases/chinook/dtql?q=from%3A%20%7Bname%3A%20Artist%7D');
  assert.equal(getQuery.status, 200);
  const pagedQuery = await fetch('demodb.dev', '/ovdb/v1/databases/northwind/dtql', 'POST', local, {
    headers: { 'Content-Type': 'application/json', 'OVDB-Page-Size': '2', 'OVDB-Page-Token': 'page-token', 'OVDB-Page-Close': 'true', Authorization: 'Bearer never-forward', Cookie: 'session=never-forward' },
    body: JSON.stringify({ query: "from: {name: 'Order Details'}\n" }),
  });
  assert.equal(pagedQuery.status, 200);
  assert.match(pagedQuery.headers.get('Vary') ?? '', /OVDB-Page-Size/);
  const latest = forwarded.at(-1)!;
  assert.equal(latest.method, 'POST');
  assert.equal(latest.headers.get('OVDB-Page-Size'), '2');
  assert.equal(latest.headers.get('OVDB-Page-Token'), 'page-token');
  assert.equal(latest.headers.get('OVDB-Page-Close'), 'true');
  assert.equal(latest.headers.get('Authorization'), null);
  assert.equal(latest.headers.get('Cookie'), null);
  const rawYaml = 'from: {name: Artist}\nlimit: 1\n';
  const yamlQuery = await fetch('demodb.dev', '/ovdb/v1/databases/chinook/dtql', 'POST', local, { headers: { 'Content-Type': 'text/yaml' }, body: rawYaml });
  assert.equal(yamlQuery.status, 200);
  assert.equal(forwarded.at(-1)?.headers.get('Content-Type'), 'text/yaml');
  assert.equal(forwarded.at(-1)?.body, rawYaml, 'raw DTQL YAML remains supported by the legacy query endpoint');
  const configuredQueryDatabases = providerIndex.databases as { id: string; ovdb: { query: boolean } }[];
  assert.deepEqual(configuredQueryDatabases.map((database) => database.id).sort(), ['adventureworks', 'chinook', 'employees', 'northwind', 'pubs', 'sakila']);
  for (const database of configuredQueryDatabases) {
    const before = forwarded.length;
    const response = await fetch('demodb.dev', `/ovdb/v1/databases/${database.id}/dtql`, 'POST', local, { body: 'query: {}' });
    if (database.ovdb.query) {
      assert.equal(response.status, 200, `${database.id} query capability is proxied`);
      assert.equal(forwarded.length, before + 1, `${database.id} query reaches the fixed backend`);
      assert.equal(new URL(forwarded.at(-1)!.url).origin, 'https://cloud.openvaultdb.com');
      assert.equal(new URL(forwarded.at(-1)!.url).pathname, `/v1/databases/${database.id}/dtql`);
    } else {
      assert.equal(response.status, 404, `${database.id} query route stays closed while its capability is false`);
      assert.equal(forwarded.length, before, `${database.id} closed query route does not reach the backend`);
    }
  }
  const pubsMetadataResponse = await fetch('demodb.dev', '/ovdb/v1/databases/pubs');
  assert.equal(pubsMetadataResponse.status, 200, 'verified Pubs backend metadata is available through the shared gateway');
  assert.equal((await pubsMetadataResponse.json() as { id: string }).id, 'pubs');
  const pubsQuery = await fetch('demodb.dev', '/ovdb/v1/databases/pubs/dtql', 'POST', local, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'from: {name: authors}\nlimit: 1\n' }) });
  assert.equal(pubsQuery.status, 200, 'verified Pubs query capability is proxied');
  assert.equal(new URL(forwarded.at(-1)!.url).pathname, '/v1/databases/pubs/dtql');
  assert.equal(forwarded.at(-1)?.redirect, 'manual', 'query fetch rejects redirects without following them');
  nextRedirectLocation = 'https://attacker.example/redirect';
  const beforeMetadataRedirect = forwarded.length;
  const rejectedMetadataRedirect = await fetch('demodb.dev', '/ovdb/v1/databases/northwind');
  assert.equal(rejectedMetadataRedirect.status, 502, 'manual upstream redirects remain a safe gateway failure');
  assert.equal(rejectedMetadataRedirect.headers.get('Location'), null, 'redirect destinations are never exposed to clients');
  assert.equal(forwarded.length, beforeMetadataRedirect + 1, 'metadata redirect target is not fetched');
  assert.equal(forwarded.at(-1)?.redirect, 'manual');
  nextRedirectLocation = 'https://attacker.example/redirect';
  const beforeQueryRedirect = forwarded.length;
  const rejectedQueryRedirect = await fetch('demodb.dev', '/ovdb/v1/databases/chinook/dtql?q=from%3AArtist');
  assert.equal(rejectedQueryRedirect.status, 502, 'query redirects remain a safe gateway failure');
  assert.equal(rejectedQueryRedirect.headers.get('Location'), null, 'query redirect destinations are never exposed to clients');
  assert.equal(forwarded.length, beforeQueryRedirect + 1, 'query redirect target is not fetched');
  assert.equal(forwarded.at(-1)?.redirect, 'manual');
  assert.equal((await fetch('demodb.dev', '/ovdb/v1/databases/northwind/records/Orders/10248', 'PUT')).status, 403);
  assert.equal((await fetch('demodb.dev', '/ovdb/v1/databases/northwind/read', 'POST')).status, 403);
  assert.equal((await fetch('demodb.dev', '/ovdb/v1/databases/northwind/dtql', 'DELETE')).status, 403);
  assert.equal((await fetch('demodb.dev', '/ovdb/v1/databases/northwind', 'POST')).status, 403);
  assert.equal((await fetch('demodb.dev', '/ovdb/v1/databases/unknown/dtql', 'POST')).status, 404);
  assert.equal((await fetch('demodb.dev', '/ovdb/v1/databases/northwind/write', 'POST')).status, 404);
  assert.equal((await fetch('demodb.dev', '/ovdb/v1/databases/northwind/dtql', 'OPTIONS')).headers.get('Access-Control-Allow-Origin'), '*');
  const diagnosticMessage = 'fetch failed for https://backend.example/path?token=url-secret&view=private Authorization: Bearer bearer-secret OVDB-Page-Token: page-secret';
  nextFetchError = new TypeError(diagnosticMessage);
  const failedMetadata = await fetch('demodb.dev', '/ovdb/v1/databases/northwind');
  assert.equal(failedMetadata.status, 502, 'runtime failures retain the generic public gateway response');
  nextFetchError = new TypeError(diagnosticMessage);
  const failedQuery = await fetch('demodb.dev', '/ovdb/v1/databases/chinook/dtql', 'POST', local, {
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'private customer query' }),
  });
  assert.equal(failedQuery.status, 502, 'query runtime failures retain the generic public gateway response');
  assert.equal(gatewayLogs.length, 2, 'both metadata and query failures emit a diagnostic');
  const diagnosticEntries = gatewayLogs.map((entry) => JSON.parse(entry) as Record<string, unknown>);
  assert.deepEqual(diagnosticEntries.map((entry) => [entry.event, entry.operation, entry.database, entry.errorName]), [
    ['ovdb_gateway_fetch_failed', 'metadata', 'northwind', 'TypeError'],
    ['ovdb_gateway_fetch_failed', 'query', 'chinook', 'TypeError'],
  ]);
  for (const entry of diagnosticEntries) {
    const serialized = JSON.stringify(entry);
    for (const secret of ['url-secret', 'private', 'bearer-secret', 'page-secret', 'customer query']) assert.doesNotMatch(serialized, new RegExp(secret));
    assert.match(String(entry.errorMessage), /fetch failed/);
    assert.match(String(entry.errorMessage), /\[url\]/);
  }
} finally {
  globalThis.fetch = platformFetch;
  console.error = platformConsoleError;
}

console.log('Worker host resolution, static pages, exports, CORS, discovery, OVDB redirects, and legacy redirect pass.');
