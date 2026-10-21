// Post-deploy smoke of the live, Worker-less DemoDB hosts.
//
// Budget: at most ONE request per URL and method per run, and no retry loops. Every DemoDB host is an
// assets-only deployment, and on 2026-10-16 a request loop helped exhaust the account's Workers request quota
// (Cloudflare Error 1027). `get()` memoizes each GET, so checks that read the same page or manifest share one
// response. The OVDB API is no longer served by this repository (it moved to https://ovdb.demodb.dev/v1,
// served by the openvaultdb-cloud Worker), so this smoke checks only that the old URLs redirect there and
// sends no API query.
import { storageGroups } from '../src/data/ovdb.ts';
import { catalogueProblems, storagePageProblems } from './smoke-catalogue.mjs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import postgresqlApi from '../config/postgresql-api.json' with { type: 'json' };
import datatugCatalog from './fixtures/datatug-postgresql-catalog.json' with { type: 'json' };
import derivedLock from '../config/derived-exports.lock.json' with { type: 'json' };
import dialectConfig from '../config/dialect-scripts.json' with { type: 'json' };
import { assertNotRateLimited, requestBudget } from './smoke-guard.mjs';
import { hclProblems, jsonProblems, modelPageProblems, servedModelPaths, servedModels } from './served-model.mjs';

const commit = process.env.BUILD_COMMIT;
if (!/^[0-9a-f]{40}$/i.test(commit ?? '')) throw new Error('BUILD_COMMIT must be a full 40-digit Git SHA');

const OVDB_API = 'https://ovdb.demodb.dev/v1';
const IMMUTABLE = 'public, max-age=31536000, immutable';
const requiredQueryableDatabaseIds = ['chinook', 'northwind', 'pubs', 'sakila', 'adventureworks', 'employees'];
const comparisonFixture = {
  sha256: '3369d25729dea9e21facc7226aee3d5247fa0f3d8d4be4678aa9247fd064845f',
  bytes: 1007616,
};
const comparisonFixturePath = `/data/compare/${comparisonFixture.sha256}.sqlite`;
const sites = [
  ['https://demodb.dev', ['/', '/theme.js', '/ovdb/', '/ovdb/ovdb-server.json', '/.well-known/openvaultdb', '/chinook/', '/chinook/ovdb-database.json', '/ovdb/db/chinook/ovdb-database.json', '/northwind/', '/northwind/ovdb-database.json', '/ovdb/db/northwind/ovdb-database.json', '/pubs/', '/pubs/ovdb-database.json', '/ovdb/db/pubs/ovdb-database.json', '/sakila/', '/sakila/ovdb-database.json', '/ovdb/db/sakila/ovdb-database.json', '/adventureworks/', '/adventureworks/ovdb-database.json', '/ovdb/db/adventureworks/ovdb-database.json', '/employees/', '/employees/ovdb-database.json', '/ovdb/db/employees/ovdb-database.json']],
  ['https://chinook.demodb.dev', ['/', '/theme.js', '/tables/Artist/', '/.well-known/openvaultdb']],
  ['https://northwind.demodb.dev', ['/', '/theme.js', '/tables/Order%20Details/', '/tables/Invoices/', '/.well-known/openvaultdb']],
  ['https://pubs.demodb.dev', ['/', '/theme.js', '/tables/', '/tables/titles/', '/.well-known/openvaultdb']],
  ['https://sakila.demodb.dev', ['/', '/theme.js', '/tables/film_actor/', '/tables/actor_info/', '/.well-known/openvaultdb']],
  ['https://adventureworks.demodb.dev', ['/', '/theme.js', '/tables/HumanResources.EmployeeDepartmentHistory/', '/tables/Production.Product/', '/schema/', '/schema.json', '/.well-known/openvaultdb']],
  ['https://employees.demodb.dev', ['/', '/theme.js', '/tables/titles/', '/tables/current_dept_emp/', '/.well-known/openvaultdb']],
];
const storageEntries = storageGroups.flatMap(({ storages }) => storages);

// Sequential on purpose (every request is awaited before the next; no Promise.all, no timers, no retry), at most one request per URL
// and method, a hard cap on the total (scripts/smoke-guard.mjs), and the first HTTP 429 or Cloudflare 1027/1015 answer stops the run.
const requested = new Set();
const budget = requestBudget();
function once(method, url) {
  const key = `${method} ${url}`;
  if (requested.has(key)) throw new Error(`smoke budget: ${key} was already requested once in this run`);
  requested.add(key);
  budget.spend(key);
}

// One GET per URL: the text body and headers are cached for every later check.
const pages = new Map();
function get(url) {
  if (!pages.has(url)) {
    once('GET', url);
    pages.set(url, fetch(url, { redirect: 'manual', cache: 'no-store' }).then(async (response) => {
      const body = await response.text();
      assertNotRateLimited(url, response.status, body);
      return { response, body };
    }));
  }
  return pages.get(url);
}

async function checked(url, validate) {
  const { response, body } = await get(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  // A validator returns true, false, or a string that says what was wrong.
  const verdict = validate(body, response);
  if (!verdict || typeof verdict === 'string') throw new Error(`${url}: response did not match the expected build${typeof verdict === 'string' ? `: ${verdict}` : ''}`);
}

// One GET of a binary file, streamed and hashed without buffering it twice.
// Kept by URL so a later check (the upstream MySQL script) reuses the export loop's request.
const downloads = new Map();
async function download(url) {
  once('GET', url);
  const response = await fetch(url, { redirect: 'manual', cache: 'no-store' });
  if (response.status !== 200) {
    assertNotRateLimited(url, response.status, (await response.text()).slice(0, 4096));
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  const result = { response, bytes: Buffer.from(await response.arrayBuffer()) };
  downloads.set(url, result);
  return result;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// A demodb-chunked-export/v1 manifest: every part once, each part and the joined gzip checked against the
// manifest, the decoded bytes returned for the caller to compare with the corpus.
async function chunkedExport(manifestUrl) {
  const { response, body } = await get(manifestUrl);
  if (response.status !== 200) throw new Error(`${manifestUrl}: HTTP ${response.status}`);
  if (response.headers.get('Access-Control-Allow-Origin') !== '*') throw new Error(`${manifestUrl}: no read-only CORS`);
  const manifest = JSON.parse(body);
  if (manifest.format !== 'demodb-chunked-export/v1' || manifest.compression !== 'gzip' || !manifest.parts?.length) throw new Error(`${manifestUrl}: not a demodb-chunked-export/v1 gzip manifest`);
  const pieces = [];
  for (const part of manifest.parts) {
    const url = new URL(part.path, manifestUrl).href;
    const { response: partResponse, bytes } = await download(url);
    if (bytes.length !== part.bytes || sha256(bytes) !== part.sha256) throw new Error(`${url}: part differs from its manifest entry`);
    if (partResponse.headers.get('Cache-Control') !== IMMUTABLE) throw new Error(`${url}: part is not served with immutable caching`);
    if (partResponse.headers.get('Access-Control-Allow-Origin') !== '*') throw new Error(`${url}: part lacks read-only CORS`);
    if (partResponse.headers.get('Content-Encoding')) throw new Error(`${url}: part was served with a Content-Encoding`);
    pieces.push(bytes);
  }
  const joined = Buffer.concat(pieces);
  if (joined.length !== manifest.bytes || sha256(joined) !== manifest.sha256) throw new Error(`${manifestUrl}: joined gzip differs from the manifest`);
  const decoded = gunzipSync(joined);
  if (manifest.uncompressedSha256 && sha256(decoded) !== manifest.uncompressedSha256) throw new Error(`${manifestUrl}: decoded bytes differ from uncompressedSha256`);
  return decoded;
}

for (const [origin, paths] of sites) {
  await checked(`${origin}/build-info.json`, (body) => {
    try { const marker = JSON.parse(body); return marker.format === 'demodb-build/1' && marker.commit === commit.toLowerCase(); }
    catch { return false; }
  });
  for (const path of paths) await checked(`${origin}${path}`, (_body, response) => response.status === 200);
}
await checked('https://demodb.dev/', (body) => body.includes('Explore OpenVaultDB server') && body.includes('Browse server and storage catalogue'));
await checked('https://demodb.dev/ovdb/', (body) => {
  const problems = catalogueProblems(body, storageGroups);
  return problems.length === 0 || problems.join('; ');
});
for (const storage of storageEntries) {
  await checked(`https://demodb.dev/ovdb/db/${storage.id}/`, (body) => {
    const problems = storagePageProblems(body, storage);
    return problems.length === 0 || problems.join('; ');
  });
}
await checkedDataTugPostgresqlLinks();
await checkedServedModels();
await checkedComparisonFixture();
await checkedAdventureWorksSchema();

// Every "Explore PostgreSQL in DataTug" link the live pages render must open the SPA on
// datatug.app. The links are read from the live dataset and OVDB database pages, so a link
// that is rendered but not served fails here; the set must equal datatug-apps' catalogue
// routes (the vendored fixture), and a pending flag must render none.
async function checkedDataTugPostgresqlLinks() {
  const expected = new Map(datatugCatalog.entries.map(({ dataset, route }) => [dataset, `https://datatug.app${route}`]));
  assert.deepEqual([...expected.keys()].sort(), [...requiredQueryableDatabaseIds].sort(), 'the catalogue fixture covers every dataset');
  for (const id of requiredQueryableDatabaseIds) {
    for (const page of [`https://${id}.demodb.dev/`, `https://demodb.dev/ovdb/db/${id}/`]) {
      let rendered = [];
      await checked(page, (body) => {
        rendered = [...body.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>Explore PostgreSQL in DataTug<\/a>/g)].map((match) => match[1]);
        if (!postgresqlApi.publicApiVerified) return rendered.length === 0 || 'a pending PostgreSQL edition is advertised';
        return rendered.length === 1 && rendered[0] === expected.get(id) || `rendered ${JSON.stringify(rendered)}, expected ${expected.get(id)}`;
      });
      for (const href of rendered) {
        await checked(href, (body, response) => response.status === 200 && /<title>DataTug\.app<\/title>/.test(body) && /<base href="\/">/.test(body));
      }
    }
  }
}

// Every dataset's model files and model page, in the current ModelSpec spelling.
async function checkedServedModels() {
  assert.deepEqual(Object.keys(servedModels).sort(), [...requiredQueryableDatabaseIds].sort(), 'every dataset has a served-model expectation');
  for (const id of requiredQueryableDatabaseIds) {
    const origin = `https://${id}.demodb.dev`;
    const paths = servedModelPaths(id);
    for (const [path, problemsOf] of [[paths.hcl, hclProblems], [paths.json, jsonProblems]]) {
      await checked(`${origin}${path}`, (body, response) => {
        if (response.headers.get('Access-Control-Allow-Origin') !== '*') return 'the model file is not served with Access-Control-Allow-Origin: *';
        const problems = problemsOf(id, body);
        return problems.length === 0 ? true : problems.join('; ');
      });
    }
    await checked(`${origin}/model/`, (body) => {
      const problems = modelPageProblems(id, body);
      return problems.length === 0 ? true : problems.join('; ');
    });
  }
}

async function checkedAdventureWorksSchema() {
  const { response, body } = await get('https://adventureworks.demodb.dev/schema.json');
  if (!response.ok) throw new Error(`AdventureWorks source schema returned HTTP ${response.status}`);
  const schema = JSON.parse(body);
  const tables = schema.tables?.filter((table) => table.kind === 'table') ?? [];
  const executableViews = schema.tables?.filter((table) => table.kind === 'view') ?? [];
  const sourceViews = schema.sourceViews ?? [];
  if (tables.length !== 71 || executableViews.length !== 11 || sourceViews.length !== 20) {
    throw new Error(`AdventureWorks schema counts differ from the pinned source (tables=${tables.length}, sqliteViews=${executableViews.length}, sourceViews=${sourceViews.length})`);
  }
  const available = sourceViews.filter((view) => view.availableAsSqliteView).length;
  const sourceOnly = sourceViews.filter((view) => !view.availableAsSqliteView).length;
  if (available !== 11 || sourceOnly !== 9) throw new Error(`AdventureWorks view availability is incorrect (SQLite=${available}, source-only=${sourceOnly})`);
  if (sourceViews.some((view) => !view.availableAsSqliteView && schema.tables.some((table) => table.name === view.recordset))) {
    throw new Error('A source-only SQL Server view is incorrectly published as an executable SQLite recordset');
  }
}

// Every complete-database download the corpus advertises, each fetched once: a plain file is compared with
// its declared size and SHA-256; a chunked one (url is its .parts.json manifest) is joined, decoded and
// compared with its declared decoded size and SHA-256. Formats declared unavailable must say so on the page.
// MySQL scripts are kept for the MySQL check so they are not downloaded twice.
const mysqlScripts = new Map();
async function checkedCompleteExports() {
  const corpus = JSON.parse((await get('https://demodb.dev/corpus.json')).body);
  let files = 0;
  for (const database of corpus.databases) {
    const availability = database.formatAvailability;
    if (!Array.isArray(availability)) throw new Error(`${database.localId}: corpus metadata lacks formatAvailability`);
    for (const item of availability.filter((entry) => entry.state === 'download')) {
      if (!database.exports.some((file) => file.format === item.format)) throw new Error(`${database.localId}: ${item.format} is declared as a download but the corpus lists no such export`);
    }
    for (const file of database.exports) {
      let bytes;
      if (file.delivery === 'demodb-chunked-export/v1') {
        if (!file.url.endsWith('.parts.json')) throw new Error(`${file.url}: a chunked export must point at its .parts.json manifest`);
        bytes = await chunkedExport(file.url);
        if (file.format === 'sqlite' && bytes.subarray(0, 16).toString('latin1') !== 'SQLite format 3\0') throw new Error(`${file.url}: decoded bytes are not a SQLite database`);
      } else {
        const result = await download(file.url);
        bytes = result.bytes;
        if (result.response.headers.get('Access-Control-Allow-Origin') !== '*') throw new Error(`${file.url}: no read-only CORS`);
        if (result.response.headers.get('Cross-Origin-Resource-Policy') !== 'cross-origin') throw new Error(`${file.url}: no cross-origin resource policy`);
        if (file.format === 'sqlite' && result.response.headers.get('Content-Type') !== 'application/vnd.sqlite3') throw new Error(`${file.url}: SQLite download has the wrong content type`);
      }
      const expectedBytes = file.decodedBytes ?? file.bytes;
      const expectedSha256 = file.decodedSha256 ?? file.sha256;
      if (bytes.length !== expectedBytes || sha256(bytes) !== expectedSha256) throw new Error(`${file.url}: download differs from corpus metadata (declared ${expectedBytes} bytes ${expectedSha256}, received ${bytes.length} bytes)`);
      if (file.format === 'mysql') mysqlScripts.set(database.localId, bytes);
      files += 1;
    }
    const missing = availability.filter((entry) => entry.state !== 'download');
    if (missing.length) {
      const { body: page } = await get(`https://${database.localId}.demodb.dev/downloads/`);
      for (const entry of missing) {
        const word = entry.state === 'planned' ? 'Planned' : 'Not available';
        if (!page.includes(`${word}:`) || !page.includes(entry.label)) throw new Error(`${database.localId}: the downloads page does not state that ${entry.label} is ${word.toLowerCase()}`);
        if (database.exports.some((file) => file.format === entry.format)) throw new Error(`${database.localId}: ${entry.format} is declared ${entry.state} but the corpus lists an export`);
      }
    }
  }
  return files;
}

// Every generated MySQL script the corpus advertises (bytes from checkedCompleteExports): it is the script the
// lock pins, starts with the contract-edition label, carries its licence, creates the marker table and ends with
// the completion comment. Chinook's upstream script is still served, apart.
async function checkedMysqlScripts() {
  const corpus = JSON.parse((await get('https://demodb.dev/corpus.json')).body);
  const spec = dialectConfig.dialects.mysql;
  let checkedScripts = 0;
  for (const database of corpus.databases) {
    const declared = database.formatAvailability.find((entry) => entry.format === 'mysql');
    if (declared?.state !== 'download') throw new Error(`${database.localId}: the MySQL script is not declared as a download`);
    const pinned = derivedLock.datasets?.[database.localId]?.mysql;
    const bytes = mysqlScripts.get(database.localId);
    if (!bytes || !pinned) throw new Error(`${database.localId}: no MySQL script in the corpus or in the lock`);
    if (bytes.length !== pinned.bytes || sha256(bytes) !== pinned.sha256) throw new Error(`${database.localId}: the served MySQL script is not the one the lock pins`);
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) throw new Error(`${database.localId}: MySQL script still gzip after decoding`);
    const text = bytes.toString('utf8');
    const lines = text.split('\n');
    if (lines[0] !== `-- ${dialectConfig.edition}`) throw new Error(`${database.localId}: the first line is not the contract-edition label`);
    if (!lines.slice(0, 40).includes(`-- Licence: ${database.licences.data}`)) throw new Error(`${database.localId}: the header lacks the licence ${database.licences.data}`);
    if (!lines.some((line) => line.startsWith(`CREATE TABLE \`${spec.marker}\``))) throw new Error(`${database.localId}: no marker table`);
    if (!lines.some((line) => line.startsWith(`INSERT INTO \`${spec.marker}\` VALUES ('${database.localId}', `))) throw new Error(`${database.localId}: the marker row is missing`);
    if (text.includes('\r')) throw new Error(`${database.localId}: holds a CR`);
    if (lines.filter((line) => line.length > 0).at(-1) !== '-- end of script') throw new Error(`${database.localId}: does not end with the completion comment`);
    checkedScripts += 1;
  }
  const upstreamUrl = 'https://chinook.demodb.dev/data/upstream/chinook.mysql.sql';
  const downloaded = downloads.get(upstreamUrl);
  const { response: upstream, body: upstreamText } = downloaded
    ? { response: downloaded.response, body: downloaded.bytes.toString('utf8') }
    : await get(upstreamUrl);
  if (upstream.status !== 200) throw new Error(`chinook: the upstream MySQL script is not served at /data/upstream/chinook.mysql.sql (HTTP ${upstream.status})`);
  if (!upstreamText.includes('Chinook_MySql.sql') || !upstreamText.includes('DROP DATABASE IF EXISTS')) throw new Error('chinook: /data/upstream/chinook.mysql.sql is not the upstream script');
  return checkedScripts;
}

async function checkedComparisonFixture() {
  const url = `https://chinook.demodb.dev${comparisonFixturePath}`;
  const { response, bytes } = await download(url);
  if (response.headers.get('Content-Type') !== 'application/vnd.sqlite3') throw new Error('Chinook comparison fixture has the wrong content type');
  if (response.headers.get('Access-Control-Allow-Origin') !== '*') throw new Error('Chinook comparison fixture is missing read-only CORS');
  if (response.headers.get('Cache-Control') !== IMMUTABLE) throw new Error('Chinook comparison fixture is not served with immutable caching');
  if (bytes.length !== comparisonFixture.bytes || sha256(bytes) !== comparisonFixture.sha256) {
    throw new Error(`Chinook comparison fixture failed full-byte verification (bytes=${bytes.length})`);
  }
  once('HEAD', url);
  const head = await fetch(url, { method: 'HEAD', redirect: 'manual', cache: 'no-store' });
  assertNotRateLimited(url, head.status, '');
  const headLength = head.headers.get('Content-Length');
  if (head.status !== 200 || (headLength !== null && headLength !== String(comparisonFixture.bytes)) ||
      head.headers.get('Content-Type') !== 'application/vnd.sqlite3' ||
      head.headers.get('Access-Control-Allow-Origin') !== '*' ||
      head.headers.get('Cache-Control') !== IMMUTABLE) {
    throw new Error('Chinook comparison fixture HEAD response did not preserve byte metadata and immutable CORS headers');
  }
  if (await head.text() !== '') throw new Error('Chinook comparison fixture HEAD response included a body');
}

// Redirects are answered by the static asset router before any file; one request each, not followed.
async function checkedRedirect(url, init, expectedLocation) {
  once(init.method, url);
  const response = await fetch(url, { ...init, redirect: 'manual', cache: 'no-store' });
  assertNotRateLimited(url, response.status, response.status === 429 || response.status >= 403 ? await response.text() : '');
  // The static router may answer with a relative Location; browsers resolve it against the request URL.
  const location = response.headers.get('Location');
  const resolved = location === null ? null : new URL(location, url).href;
  if (response.status !== 308 || resolved !== new URL(expectedLocation).href) {
    throw new Error(`redirect from ${url}: HTTP ${response.status} to ${location ?? 'no location'}, expected 308 to ${expectedLocation}`);
  }
}

await checkedRedirect('https://demodb.dev/ovdb/v1/databases/chinook?smoke=api', { method: 'GET' }, `${OVDB_API}/databases/chinook?smoke=api`);
await checkedRedirect('https://demodb.dev/ovdb/dbs/chinook', { method: 'GET' }, 'https://demodb.dev/chinook/');
for (const path of ['/_db/chinook/index.html', '/data/adventureworks.sqlite', '/data/adventureworks.sqlserver.sql', '/data/adventureworks.oracle.sql']) {
  const url = `https://${path.includes('adventureworks') ? 'adventureworks' : 'chinook'}.demodb.dev${path}`;
  once('GET', url);
  const response = await fetch(url, { redirect: 'manual', cache: 'no-store' });
  assertNotRateLimited(url, response.status, response.status === 404 ? '' : await response.text());
  await response.body?.cancel();
  if (response.status !== 404) throw new Error(`${url}: expected 404 (no private namespace, no single-file URL for a chunked export), got ${response.status}`);
}
const completeExportCount = await checkedCompleteExports();
const mysqlScriptCount = await checkedMysqlScripts();
console.log(`Live DemoDB static hosts serve ${commit}: pages, typed manifests, discovery, ${completeExportCount} complete-database downloads (chunked ones joined and decoded) checked against the corpus, ${mysqlScriptCount} MySQL scripts checked against the lock, legacy and API redirects; ${requested.size} requests, none repeated.`);
