import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker, { internalAssetPath, resolveHost } from '../src/worker';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const dist = join(root, 'dist');
const local = { LOCAL_DB_HOSTS: '{"chinook.localhost":"chinook","northwind.localhost":"northwind"}', LOCAL_CATALOGUE_HOSTS: '["localhost"]' };
const assets = {
  async fetch(request: Request) {
    const url = new URL(request.url);
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
assert.equal(internalAssetPath('northwind', '/_db/northwind/index.html'), '/404.html');

for (const [host, expected] of [['demodb.dev', 'Northwind'], ['chinook.demodb.dev', 'Chinook'], ['northwind.demodb.dev', 'Northwind'], ['localhost', 'DemoDB']] as const) {
  const response = await fetch(host, '/');
  assert.equal(response.status, 200, host);
  assert.match(await response.text(), new RegExp(expected));
}

const rootDocs = await fetch('demodb.dev', '/_db/northwind/index.html');
assert.equal(rootDocs.status, 404, 'internal static namespace cannot be requested publicly');
assert.equal((await fetch('demodb.dev', '/', 'POST')).status, 405, 'catalogue pages are read-only');
const siteMap = await fetch('demodb.dev', '/sitemap.xml');
assert.equal(siteMap.status, 200);
assert.match(await siteMap.text(), /https:\/\/northwind\.demodb\.dev\//);
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
  assert.match(html, /href="https:\/\/cloud\.openvaultdb\.com\/ovdb\/dbs\/(chinook|northwind)">Explore in OpenVaultDB/, `${name} landing page exposes its available OVDB deployment`);
}

const json = await fetch('northwind.demodb.dev', '/data/json/northwind.Order%20Details.json');
assert.equal(json.status, 200);
assert.equal(json.headers.get('Access-Control-Allow-Origin'), '*');
assert.equal(json.headers.get('Content-Type'), 'application/json; charset=utf-8');
assert.equal((await json.json() as unknown[]).length, 2155);
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
  assert.equal(body.databases[0].apiUrl, `https://cloud.openvaultdb.com/v1/databases/${id}`);
}
const redirect = await fetch('northwind.demodb.dev', '/ovdb/dbs/northwind/collections/Order%20Details?limit=2');
assert.equal(redirect.status, 308);
assert.equal(redirect.headers.get('Location'), 'https://cloud.openvaultdb.com/ovdb/dbs/northwind/collections/Order%20Details?limit=2');
const postRedirect = await fetch('chinook.demodb.dev', '/ovdb/v1/databases/chinook/dtql?format=json', 'POST', local, { body: '{"query":"from: {name: Artist}"}', headers: { 'Content-Type': 'application/json' } });
assert.equal(postRedirect.status, 308);
assert.equal(postRedirect.headers.get('Location'), 'https://cloud.openvaultdb.com/v1/databases/chinook/dtql?format=json');
const legacyDisabled = await fetch('chinookdb.com', '/tables/Artist/?x=1', 'GET', { ...local, ENABLE_LEGACY_REDIRECTS: 'false' });
assert.equal(legacyDisabled.status, 404);
const legacy = await fetch('chinookdb.com', '/ovdb/v1/databases/chinook/dtql?q=a%20b', 'GET', { ...local, ENABLE_LEGACY_REDIRECTS: 'true' });
assert.equal(legacy.status, 308);
assert.equal(legacy.headers.get('Location'), 'https://chinook.demodb.dev/ovdb/v1/databases/chinook/dtql?q=a%20b');

console.log('Worker host resolution, static pages, exports, CORS, discovery, OVDB redirects, and legacy redirect pass.');
