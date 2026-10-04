import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { indexedDB as fakeIndexedDB } from 'fake-indexeddb';
import worker, { internalAssetPath, resolveHost } from '../src/worker';
import { activeSnapshot, clearActiveSnapshot, importSnapshot, IncrementalSha256, isVerifiedTableCheckpoint, parseJsonArray, stagingImportKey } from '../src/scripts/indexeddb-snapshot';
import providerIndex from '../src/data/generated/index.json';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const dist = join(root, 'dist');
const local = { LOCAL_DB_HOSTS: '{"chinook.localhost":"chinook","northwind.localhost":"northwind"}', LOCAL_CATALOGUE_HOSTS: '["localhost"]' };
const gzipPayload = Buffer.from('[{"fixture":"gzip"}]');
const gzipPayloadBytes = gzipSync(gzipPayload);
const chinookGenerated = providerIndex.databases.find((database) => database.id === 'chinook') as unknown as { exports: { publicPath: string; compression?: string }[] };
chinookGenerated.exports.push({ publicPath: 'test/gzip-fixture.json.gz', compression: 'gzip' });

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
    tables: [{ name: 'Items', kind: 'table' as const, rowCount: 1, columns: [{ name: 'id', primaryKey: true, primaryKeyPosition: 1 }, { name: 'value' }], foreignKeys: [] }],
    exports: [{ table: 'Items', url: 'https://fixture.example/items.json', bytes: Buffer.byteLength('[{"id":1,"value":"right"}]'), sha256: createHash('sha256').update('[{"id":1,"value":"right"}]').digest('hex') }],
  };
  const bad = new TextEncoder().encode('[{"id":1,"value":"wrong"}]');
  const good = new TextEncoder().encode('[{"id":1,"value":"right"}]');
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
  globalThis.fetch = async () => new Response(attempts++ === 0 ? bad : good);
  try {
    await assert.rejects(importSnapshot(configuration, () => {}, new AbortController().signal), /checksum mismatch/);
    await importSnapshot(configuration, () => {}, new AbortController().signal);
    const db = await activeSnapshot(configuration);
    assert.ok(db, 'valid retry promotes a complete snapshot');
    const row = await new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
      const request = db!.transaction('recordset-0').objectStore('recordset-0').get(1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    assert.deepEqual(row, { id: 1, value: 'right' }, 'valid retry replaces rows written from the failed checksum response');
    db!.close();
    await clearActiveSnapshot(configuration);
    assert.equal(attempts, 2, 'the failed table is fetched again and replayed');
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
    if (url.pathname.endsWith('/_db/chinook/data/test/gzip-fixture.json.gz')) return new Response(gzipPayloadBytes, { headers: { 'Content-Type': 'application/gzip', 'Content-Length': String(gzipPayloadBytes.length), 'Accept-Ranges': 'bytes' } });
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
assert.equal(resolveHost('unknown.demodb.dev').databaseId, undefined);
assert.equal(internalAssetPath('northwind', '/tables/Order%20Details/'), '/_db/northwind/tables/Order%20Details/index.html');
assert.equal(internalAssetPath('northwind', '/theme.js'), '/theme.js', 'shared theme controller is not host-prefixed');
assert.equal(internalAssetPath('northwind', '/_db/northwind/index.html'), '/404.html');

for (const [host, expected] of [['demodb.dev', 'Northwind'], ['chinook.demodb.dev', 'Chinook'], ['northwind.demodb.dev', 'Northwind'], ['localhost', 'DemoDB']] as const) {
  const response = await fetch(host, '/');
  assert.equal(response.status, 200, host);
  assert.match(await response.text(), new RegExp(expected));
}
for (const host of ['demodb.dev', 'chinook.demodb.dev', 'northwind.demodb.dev']) {
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
assert.match(siteMapXml, /https:\/\/northwind\.demodb\.dev\//);
assert.match(siteMapXml, /https:\/\/demodb\.dev\/ovdb\//);
assert.match(siteMapXml, /https:\/\/demodb\.dev\/northwind\//);
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

const json = await fetch('northwind.demodb.dev', '/data/json/northwind.Order%20Details.json');
assert.equal(json.status, 200);
assert.equal(json.headers.get('Access-Control-Allow-Origin'), '*');
assert.equal(json.headers.get('Content-Type'), 'application/json; charset=utf-8');
assert.equal((await json.json() as unknown[]).length, 2155);
const encodedJson = await fetch('chinook.demodb.dev', '/data/test/gzip-fixture.json.gz');
assert.equal(encodedJson.status, 200);
assert.equal(encodedJson.headers.get('Content-Type'), 'application/json; charset=utf-8');
assert.equal(encodedJson.headers.get('Content-Encoding'), 'gzip');
assert.match(encodedJson.headers.get('Vary') ?? '', /Accept-Encoding/i);
assert.equal(gunzipSync(Buffer.from(await encodedJson.arrayBuffer())).toString('utf8'), gzipPayload.toString('utf8'), 'precompressed export bytes are not double-encoded by the Worker');
const encodedHead = await fetch('chinook.demodb.dev', '/data/test/gzip-fixture.json.gz', 'HEAD');
assert.equal(encodedHead.status, 200);
assert.equal(encodedHead.headers.get('Content-Encoding'), 'gzip');
assert.equal(await encodedHead.text(), '');
const encodedRange = await worker.fetch(makeRequest('chinook.demodb.dev', '/data/test/gzip-fixture.json.gz', 'GET', { headers: { Range: 'bytes=0-3' } }), { ...local, ASSETS: assets } as Env, {} as ExecutionContext);
assert.equal(encodedRange.status, 200, 'compressed exports ignore byte ranges and serve one complete representation');
assert.equal(encodedRange.headers.get('Content-Range'), null);
assert.equal(encodedRange.headers.get('Accept-Ranges'), null);
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

for (const [host, id] of [['chinook.demodb.dev', 'chinook'], ['northwind.demodb.dev', 'northwind']] as const) {
  const discovery = await fetch(host, '/.well-known/openvaultdb');
  assert.equal(discovery.status, 200);
  assert.equal(discovery.headers.get('Access-Control-Allow-Origin'), '*');
  const body = await discovery.json() as { databases: { id: string; url: string; apiUrl: string }[] };
  assert.equal(body.databases.length, 1);
  assert.equal(body.databases[0].id, id);
  assert.equal(body.databases[0].apiUrl, `https://demodb.dev/ovdb/v1/databases/${id}`);
}
const downloads = await fetch('northwind.demodb.dev', '/downloads/');
assert.equal(downloads.status, 200);
const downloadsHtml = await downloads.text();
assert.match(downloadsHtml, /Check storage and import/);
assert.match(downloadsHtml, /Remove local copy/);
assert.match(downloadsHtml, /Order Details/);
for (const id of ['chinook', 'northwind'] as const) {
  const publicDatabasePage = await fetch('demodb.dev', `/${id}/`);
  assert.equal(publicDatabasePage.status, 200, `canonical ${id} database page exists`);
  assert.match(await publicDatabasePage.text(), new RegExp(`${id === 'chinook' ? 'Chinook' : 'Northwind'}`));
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
assert.deepEqual(serverManifest.databases.map((database) => database.localId).sort(), ['chinook', 'northwind']);
assert.ok(serverManifest.databases.every((database) => database.manifestUrl === `${database.serverDbBaseUrl}ovdb-database.json`));
assert.equal((await fetch('demodb.dev', '/ovdb/')).status, 200);
assert.equal((await fetch('demodb.dev', '/ovdb/v1')).status, 200, 'declared API root returns the server descriptor');
assert.equal((await fetch('demodb.dev', '/ovdb/schemas/ovdb-database-draft-1.schema.json')).status, 200);
const centralDiscovery = await fetch('demodb.dev', '/.well-known/openvaultdb');
assert.equal(centralDiscovery.status, 200);
assert.equal(centralDiscovery.headers.get('Access-Control-Allow-Origin'), '*');
const discoveredDatabases = (await centralDiscovery.json() as { databases: { id: string; url: string; manifestUrl: string; apiUrl: string }[] }).databases;
assert.deepEqual(discoveredDatabases.map((database) => database.id).sort(), ['chinook', 'northwind'], 'legacy discovery keeps local database IDs');
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
  const requestedMetadata = /^\/v1\/databases\/(chinook|northwind)$/.exec(new URL(request.url).pathname);
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
