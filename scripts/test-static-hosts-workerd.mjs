// Serves the built per-host bundles with `wrangler dev` (workerd, the static asset router, local only, no
// account) and checks status codes and headers as a client sees them. With DEMODB_RECEIPTS=1 it also prints
// a GET/HEAD/OPTIONS receipt table for the probe paths.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { IMMUTABLE_CACHE, OVDB_API, SHORT_CACHE } from './build-hosts.mjs';

const root = new URL('..', import.meta.url).pathname;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on('error', reject);
  });
}

async function serve(config) {
  const port = await freePort();
  const inspector = await freePort();
  const child = spawn(join(root, 'node_modules/.bin/wrangler'), ['dev', '--config', config, '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(inspector)], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const deadline = Date.now() + 120_000;
  while (!output.includes('Ready on') && child.exitCode === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(output.includes('Ready on'), `wrangler dev ${config} did not start:\n${output}`);
  test.after(async () => { child.kill('SIGTERM'); await once(child, 'exit').catch(() => {}); });
  return (path, method = 'GET', init = {}) => fetch(`http://127.0.0.1:${port}${path}`, { method, redirect: 'manual', ...init });
}

// Started one after another: concurrent starts race for workerd's helper ports.
const catalogue = await serve('deploy/hosts/demodb-catalogue.jsonc');
const chinook = await serve('deploy/hosts/demodb-chinook.jsonc');
const adventureworks = await serve('deploy/hosts/demodb-adventureworks.jsonc');
const alias = await serve('deploy/hosts/demodb-chinookdb-com.jsonc');

const receipts = [];
async function probe(label, client, path, method = 'GET') {
  const response = await client(path, method);
  const body = Buffer.from(await response.arrayBuffer());
  receipts.push([label, method, path, response.status, ...['content-type', 'cache-control', 'access-control-allow-origin', 'cross-origin-resource-policy', 'x-content-type-options', 'location'].map((name) => response.headers.get(name) ?? '-')]);
  return { response, body };
}

test.after(() => {
  if (process.env.DEMODB_RECEIPTS !== '1') return;
  console.log(['host', 'method', 'path', 'status', 'content-type', 'cache-control', 'acao', 'corp', 'nosniff', 'location'].join(' | '));
  for (const row of receipts) console.log(row.join(' | '));
});

test('catalogue: pages, public JSON with CORS, API and legacy redirects, no dataset files', async () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS']) await probe('demodb.dev', catalogue, '/', method);
  assert.equal((await probe('demodb.dev', catalogue, '/')).response.status, 200);
  const corpus = await probe('demodb.dev', catalogue, '/corpus.json');
  assert.equal(corpus.response.status, 200);
  assert.equal(corpus.response.headers.get('access-control-allow-origin'), '*');
  assert.equal(corpus.response.headers.get('cache-control'), SHORT_CACHE);
  assert.equal((await probe('demodb.dev', catalogue, '/corpus.json', 'HEAD')).response.status, 200);
  assert.equal((await probe('demodb.dev', catalogue, '/corpus.json', 'OPTIONS')).response.status, 405, 'static assets answer OPTIONS with 405');
  const discovery = await probe('demodb.dev', catalogue, '/.well-known/openvaultdb');
  assert.equal(discovery.response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(JSON.parse(discovery.body).protocol, 'openvaultdb/0.1');
  const api = await probe('demodb.dev', catalogue, '/ovdb/v1/databases/chinook/dtql?q=1');
  assert.equal(api.response.status, 308);
  assert.equal(api.response.headers.get('location'), `${OVDB_API}/databases/chinook/dtql?q=1`);
  const post = await catalogue('/ovdb/v1/databases/chinook/dtql', 'POST', { body: '{}', headers: { 'Content-Type': 'application/json' } });
  assert.equal(post.status, 308, 'a POST is redirected with its method preserved');
  const legacy = await probe('demodb.dev', catalogue, '/ovdb/dbs/chinook?x=1');
  assert.equal(legacy.response.status, 308);
  // A same-origin absolute target is sent as a path (wrangler dev maps it back to its local origin).
  assert.match(legacy.response.headers.get('location'), /^(?:https:\/\/demodb\.dev|http:\/\/127\.0\.0\.1:\d+)?\/chinook\/\?x=1$/);
  assert.equal((await probe('demodb.dev', catalogue, '/ovdb/db/chinook-sqlite/')).response.status, 200);
  assert.equal((await probe('demodb.dev', catalogue, '/data/chinook.sqlite')).response.status, 404);
  assert.equal((await probe('demodb.dev', catalogue, '/_db/x')).response.status, 404);
  assert.equal((await probe('demodb.dev', catalogue, '/no-such-page/')).response.status, 404);
});

test('dataset host: files at public paths with data headers, no private namespace', async () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS']) await probe('chinook', chinook, '/', method);
  for (const method of ['GET', 'HEAD', 'OPTIONS']) await probe('chinook', chinook, '/data/chinook.sqlite', method);
  const sqlite = await chinook('/data/chinook.sqlite');
  assert.equal(sqlite.status, 200);
  assert.equal(sqlite.headers.get('content-type'), 'application/vnd.sqlite3');
  assert.equal(sqlite.headers.get('cache-control'), SHORT_CACHE);
  assert.equal(sqlite.headers.get('access-control-allow-origin'), '*');
  assert.equal(sqlite.headers.get('cross-origin-resource-policy'), 'cross-origin');
  assert.equal(sqlite.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(sqlite.headers.get('content-encoding'), null);
  assert.equal((await sqlite.arrayBuffer()).byteLength, 1007616);
  const fixture = await probe('chinook', chinook, '/data/compare/3369d25729dea9e21facc7226aee3d5247fa0f3d8d4be4678aa9247fd064845f.sqlite');
  assert.equal(fixture.response.headers.get('cache-control'), IMMUTABLE_CACHE);
  assert.equal(sha256(fixture.body), '3369d25729dea9e21facc7226aee3d5247fa0f3d8d4be4678aa9247fd064845f');
  assert.equal((await probe('chinook', chinook, '/data/chinook.yaml')).response.headers.get('content-type'), 'application/yaml; charset=utf-8');
  assert.equal((await probe('chinook', chinook, '/data/chinook.postgresql.sql')).response.headers.get('content-type'), 'application/sql; charset=utf-8');
  assert.equal((await probe('chinook', chinook, '/schema.json')).response.headers.get('access-control-allow-origin'), '*');
  assert.equal((await probe('chinook', chinook, '/tables/Artist/')).response.status, 200);
  assert.equal((await probe('chinook', chinook, '/.well-known/openvaultdb')).response.status, 200);
  const api = await probe('chinook', chinook, '/ovdb/v1/databases/chinook/dtql?x=1');
  assert.equal(api.response.headers.get('location'), `${OVDB_API}/databases/chinook/dtql?x=1`);
  assert.equal(api.response.headers.get('access-control-allow-origin'), '*', 'the redirect carries CORS like the Worker did');
  assert.equal((await probe('chinook', chinook, '/ovdb/')).response.headers.get('location'), 'https://cloud.openvaultdb.com/ovdb/dbs/chinook');
  for (const path of ['/_db/x', '/_db/chinook/index.html', '/no-such-page/']) assert.equal((await probe('chinook', chinook, path)).response.status, 404, path);
  // An encoded spelling is first normalized by a 307 to its canonical path, which is then 404.
  const encoded = await probe('chinook', chinook, '/%5Fdb/chinook/index.html');
  assert.ok([307, 404].includes(encoded.response.status));
  if (encoded.response.status === 307) assert.equal((await probe('chinook', chinook, new URL(encoded.response.headers.get('location'), 'http://x').pathname)).response.status, 404);
  assert.equal((await chinook('/data/chinook.sqlite', 'POST')).status, 405);
});

test('AdventureWorks: only chunks and a manifest, joined and decoded to the pinned SQLite', async () => {
  const manifest = await probe('adventureworks', adventureworks, '/data/adventureworks.sqlite.parts.json');
  for (const method of ['HEAD', 'OPTIONS']) await probe('adventureworks', adventureworks, '/data/adventureworks.sqlite.parts.json', method);
  assert.equal(manifest.response.status, 200);
  assert.equal(manifest.response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(manifest.response.headers.get('access-control-allow-origin'), '*');
  const parsed = JSON.parse(manifest.body);
  assert.equal(parsed.format, 'demodb-chunked-export/v1');
  const pieces = [];
  for (const part of parsed.parts) {
    const path = `/data/${part.path}`;
    for (const method of ['HEAD', 'OPTIONS']) await probe('adventureworks', adventureworks, path, method);
    const { response, body } = await probe('adventureworks', adventureworks, path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), IMMUTABLE_CACHE);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.equal(response.headers.get('cross-origin-resource-policy'), 'cross-origin');
    assert.equal(response.headers.get('content-encoding'), null);
    assert.equal(sha256(body), part.sha256);
    pieces.push(body);
  }
  const joined = Buffer.concat(pieces);
  assert.equal(sha256(joined), parsed.sha256);
  const decoded = gunzipSync(joined);
  assert.equal(decoded.length, 126820352);
  assert.equal(sha256(decoded), parsed.uncompressedSha256);
  assert.equal(decoded.subarray(0, 16).toString('latin1'), 'SQLite format 3\0');
  for (const path of ['/data/adventureworks.sqlite', '/data/adventureworks.sql', '/data/adventureworks.sql.gz', '/data/adventureworks.sqlite.gz.0001.part']) {
    assert.equal((await probe('adventureworks', adventureworks, path)).response.status, 404, `${path}: no single-file URL`);
  }
  assert.equal((await probe('adventureworks', adventureworks, '/data/adventureworks.ingitdb.zip')).response.headers.get('content-type'), 'application/zip');
});

test('chinookdb.com: every path redirects with 308, preserving path, query and method', async () => {
  const page = await probe('chinookdb.com', alias, '/tables/Artist/?q=1');
  assert.equal(page.response.status, 308);
  assert.equal(page.response.headers.get('location'), 'https://chinook.demodb.dev/tables/Artist/?q=1');
  const root = await probe('chinookdb.com', alias, '/');
  assert.equal(root.response.headers.get('location'), 'https://chinook.demodb.dev/');
  const head = await probe('chinookdb.com', alias, '/data/chinook.sqlite?download=1', 'HEAD');
  assert.equal(head.response.headers.get('location'), 'https://chinook.demodb.dev/data/chinook.sqlite?download=1');
  assert.equal((await probe('chinookdb.com', alias, '/ovdb/dbs/chinook?p=1')).response.headers.get('location'), 'https://demodb.dev/chinook/?p=1');
  const post = await alias('/ovdb/v1/databases/chinook/dtql?q=1', 'POST', { body: '{}', headers: { 'Content-Type': 'application/json' } });
  assert.equal(post.status, 308);
  assert.equal(post.headers.get('location'), `${OVDB_API}/databases/chinook/dtql?q=1`);
  const options = await probe('chinookdb.com', alias, '/data/chinook.sqlite', 'OPTIONS');
  assert.equal(options.response.status, 308, 'redirect rules run before the method check');
});
