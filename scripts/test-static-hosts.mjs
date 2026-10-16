// Tests the Worker-less per-host bundles that scripts/build-hosts.mjs writes to dist-hosts/ (run after pnpm build).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { CHUNKED_FORMAT, IMMUTABLE_CACHE, MAX_ASSET_BYTES, OVDB_API, SHORT_CACHE } from './build-hosts.mjs';
import { hostConfigs } from './deploy-hosts.mjs';
import { inventoryDiff } from './static-hosts-inventory.mjs';

const root = new URL('..', import.meta.url).pathname;
const out = join(root, 'dist-hosts');
const index = JSON.parse(await readFile(join(root, 'src/data/generated/index.json'), 'utf8'));
const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function walk(dir, base = dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full, base));
    else files.push(full.slice(base.length + 1));
  }
  return files;
}

// The _headers / _redirects path matcher of Workers static assets: one splat, `:name` placeholders.
function matcher(pattern) {
  const source = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '(.*)').replace(/:[A-Za-z]\w*/g, '([^/]+)');
  return new RegExp(`^${source}$`);
}

function parseHeaders(text) {
  const rules = [];
  let current;
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    if (!/^\s/.test(line)) { current = { pattern: line.trim(), set: [], unset: [] }; rules.push(current); continue; }
    const value = line.trim();
    if (value.startsWith('! ')) current.unset.push(value.slice(2).toLowerCase());
    else current.set.push([value.slice(0, value.indexOf(':')).toLowerCase(), value.slice(value.indexOf(':') + 1).trim()]);
  }
  return rules;
}

// Applies rules in order exactly like the asset worker: per rule, detach first, then set; a second set of
// the same header in a later rule is APPENDED (comma-joined), which is what this test must never allow.
function headersFor(rules, path) {
  const headers = new Map();
  const seen = new Set();
  for (const rule of rules) {
    if (!matcher(rule.pattern).test(path)) continue;
    for (const name of rule.unset) headers.delete(name);
    for (const [name, value] of rule.set) {
      if (seen.has(name) && headers.has(name)) throw new Error(`${path}: ${name} would be comma-joined (${headers.get(name)}, ${value})`);
      headers.set(name, value);
      seen.add(name);
    }
  }
  return headers;
}

const urlOf = (file) => `/${file}`.replace(/(^|\/)index\.html$/, '$1');

test('every host config points at a built bundle, and every bundle respects the static asset limits', async () => {
  const configs = await hostConfigs();
  assert.deepEqual(configs.map(({ config }) => config.routes[0].pattern).sort(), manifest.hosts.map((host) => host.host).sort());
  for (const { config } of configs) {
    const dir = join(out, config.routes[0].pattern);
    assert.ok((await stat(dir)).isDirectory());
    assert.equal(config.name, manifest.hosts.find((host) => host.host === config.routes[0].pattern).name);
    const files = await walk(dir);
    assert.ok(files.length < 20000, 'Workers Free allows 20,000 files per version');
    for (const file of files) {
      assert.ok((await stat(join(dir, file))).size <= MAX_ASSET_BYTES, `${file} is within 25 MiB`);
      assert.ok(!file.split('/').includes('_db'), `${file}: no private namespace is published`);
    }
  }
  const catalogue = await walk(join(out, 'demodb.dev'));
  assert.ok(!catalogue.some((file) => file.startsWith('ovdb/v1/') || file === 'ovdb/v1'), 'nothing is published under /ovdb/v1 on demodb.dev');
  assert.ok(!catalogue.some((file) => file.startsWith('data/') || file.startsWith('model/')), 'the catalogue publishes no dataset files');
});

test('the URL inventory changes only where a gzip export became chunks plus a manifest', async () => {
  const diff = await inventoryDiff(root);
  const expected = {};
  for (const db of index.databases) {
    const encoded = db.exports.filter((item) => item.compression === 'gzip');
    if (!encoded.length) continue;
    const removed = encoded.flatMap((item) => [`/data/${item.publicPath}`, ...(item.chunks?.length ? item.chunks.map((chunk) => `/data/${chunk.assetPath}`) : [`/data/${item.assetPath}`])]).sort();
    const host = manifest.hosts.find((entry) => entry.host === db.siteHost);
    const added = host.chunked.flatMap((item) => [item.manifestPath, ...item.parts.map((part) => `${item.manifestPath.slice(0, item.manifestPath.lastIndexOf('/') + 1)}${part.path}`)]).sort();
    expected[db.siteHost] = { removed, added };
  }
  assert.deepEqual(diff, expected);
});

test('chunked exports follow the demodb-chunked-export/v1 contract and decode to their pinned bytes', async () => {
  const adventureworks = manifest.hosts.find((host) => host.host === 'adventureworks.demodb.dev');
  assert.ok(adventureworks.chunked.some((item) => item.publicPath === 'adventureworks.sqlite' && item.parts.length === 2));
  for (const host of manifest.hosts) {
    for (const item of host.chunked) {
      const file = join(out, host.host, item.manifestPath);
      const published = JSON.parse(await readFile(file, 'utf8'));
      assert.deepEqual(Object.keys(published), ['format', 'file', 'compression', 'bytes', 'sha256', 'uncompressedSha256', 'parts']);
      assert.equal(published.format, CHUNKED_FORMAT);
      assert.equal(published.file, item.publicPath.split('/').at(-1));
      assert.equal(published.compression, 'gzip');
      const pieces = [];
      published.parts.forEach((part, n) => assert.equal(part.path, `${published.file}.gz.part-${n + 1}`));
      for (const part of published.parts) {
        assert.deepEqual(Object.keys(part), ['path', 'bytes', 'sha256']);
        const bytes = await readFile(join(file, '..', part.path));
        assert.equal(bytes.length, part.bytes);
        assert.equal(sha256(bytes), part.sha256);
        pieces.push(bytes);
      }
      const joined = Buffer.concat(pieces);
      assert.equal(joined.length, published.bytes);
      assert.equal(sha256(joined), published.sha256);
      const decoded = gunzipSync(joined);
      assert.equal(sha256(decoded), published.uncompressedSha256, `${item.publicPath}: decodes to its pinned bytes`);
      assert.equal(decoded.length, item.decodedBytes);
    }
  }
});

test('_headers give every file one value per header: CORS, nosniff, content types and cache policy', async () => {
  for (const host of manifest.hosts) {
    const dir = join(out, host.host);
    const rules = parseHeaders(await readFile(join(dir, '_headers'), 'utf8'));
    assert.ok(rules.length <= 100);
    for (const file of await walk(dir)) {
      if (file === '_headers' || file === '_redirects') continue;
      const path = urlOf(file);
      const headers = headersFor(rules, path);
      assert.equal(headers.get('x-content-type-options'), 'nosniff', `${host.host}${path}`);
      if (host.kind !== 'dataset') continue;
      if (path.startsWith('/data/')) {
        assert.equal(headers.get('access-control-allow-origin'), '*', path);
        assert.equal(headers.get('cross-origin-resource-policy'), 'cross-origin', path);
        const immutable = path.startsWith('/data/compare/') || /\.gz\.part-\d+$/.test(path);
        assert.equal(headers.get('cache-control'), immutable ? IMMUTABLE_CACHE : SHORT_CACHE, path);
        if (path.endsWith('.sqlite')) assert.equal(headers.get('content-type'), 'application/vnd.sqlite3', path);
        if (path.endsWith('.sql')) assert.equal(headers.get('content-type'), 'application/sql; charset=utf-8', path);
        if (path.endsWith('.yaml')) assert.equal(headers.get('content-type'), 'application/yaml; charset=utf-8', path);
        if (path.endsWith('.json')) assert.equal(headers.get('content-type'), 'application/json; charset=utf-8', path);
      }
      if (path === '/schema.json' || path === '/.well-known/openvaultdb') assert.equal(headers.get('access-control-allow-origin'), '*', path);
    }
  }
  const catalogue = parseHeaders(await readFile(join(out, 'demodb.dev/_headers'), 'utf8'));
  for (const path of ['/corpus.json', '/.well-known/openvaultdb', '/ovdb/ovdb-server.json', '/ovdb/db/chinook/ovdb-database.json', '/chinook/ovdb-database.json', '/ovdb/schemas/ovdb-database-draft-1.schema.json']) {
    const headers = headersFor(catalogue, path);
    assert.equal(headers.get('access-control-allow-origin'), '*', path);
    assert.equal(headers.get('cache-control'), SHORT_CACHE, path);
  }
  assert.equal(headersFor(catalogue, '/').get('access-control-allow-origin'), undefined, 'catalogue pages are not CORS resources');
});

function redirect(rules, path) {
  for (const line of rules) {
    const [from, to, status] = line.split(' ');
    const match = matcher(from).exec(path);
    if (match) return { to: from.includes('*') ? to.replace(':splat', match[1]) : to, status: Number(status) };
  }
  return null;
}

test('_redirects reproduce the former Worker redirects with 308 and absolute targets', async () => {
  const rules = async (host) => (await readFile(join(out, host, '_redirects'), 'utf8')).split('\n').filter(Boolean);
  const catalogue = await rules('demodb.dev');
  assert.deepEqual(redirect(catalogue, '/ovdb/v1'), { to: OVDB_API, status: 308 });
  assert.deepEqual(redirect(catalogue, '/ovdb/v1/databases/chinook/dtql'), { to: `${OVDB_API}/databases/chinook/dtql`, status: 308 });
  assert.deepEqual(redirect(catalogue, '/ovdb/dbs/northwind/'), { to: 'https://demodb.dev/northwind/', status: 308 });
  assert.deepEqual(redirect(catalogue, '/ovdb/db/northwind'), { to: 'https://demodb.dev/northwind/', status: 308 });
  assert.deepEqual(redirect(catalogue, '/ovdb/db/northwind-sqlite'), { to: 'https://demodb.dev/ovdb/db/northwind-sqlite/', status: 308 });
  assert.equal(redirect(catalogue, '/ovdb/db/northwind-sqlite/'), null, 'storage pages are served, not redirected');
  assert.equal(redirect(catalogue, '/'), null);
  const chinook = await rules('chinook.demodb.dev');
  assert.deepEqual(redirect(chinook, '/ovdb/'), { to: 'https://cloud.openvaultdb.com/ovdb/dbs/chinook', status: 308 });
  assert.deepEqual(redirect(chinook, '/ovdb/dbs/chinook/collections/Artist'), { to: 'https://cloud.openvaultdb.com/ovdb/dbs/chinook/collections/Artist', status: 308 });
  assert.deepEqual(redirect(chinook, '/ovdb/v1/databases/chinook/dtql'), { to: `${OVDB_API}/databases/chinook/dtql`, status: 308 });
  assert.equal(redirect(chinook, '/data/chinook.sqlite'), null);
  const alias = await rules('chinookdb.com');
  assert.deepEqual(redirect(alias, '/tables/Artist/'), { to: 'https://chinook.demodb.dev/tables/Artist/', status: 308 });
  assert.deepEqual(redirect(alias, '/ovdb/dbs/chinook'), { to: 'https://demodb.dev/chinook/', status: 308 });
  assert.deepEqual(redirect(alias, '/ovdb/v1/databases/chinook/dtql'), { to: `${OVDB_API}/databases/chinook/dtql`, status: 308 });
  for (const host of manifest.hosts) {
    const lines = await rules(host.host).catch(() => []);
    const dynamic = lines.filter((line) => /[*:]/.test(line.split(' ')[0])).length;
    assert.ok(dynamic <= 100 && lines.length - dynamic <= 2000, `${host.host}: _redirects within limits`);
    for (const line of lines) assert.equal(line.split(' ')[2], '308', `${host.host}: ${line}`);
  }
});

test('generated metadata endpoints replace the Worker responses', async () => {
  const discovery = JSON.parse(await readFile(join(out, 'demodb.dev/.well-known/openvaultdb'), 'utf8'));
  assert.equal(discovery.protocol, 'openvaultdb/0.1');
  assert.equal(discovery.databases.length, 6);
  for (const db of index.databases) {
    const dir = join(out, db.siteHost);
    const local = JSON.parse(await readFile(join(dir, '.well-known/openvaultdb'), 'utf8'));
    assert.equal(local.databases[0].id, db.id);
    assert.deepEqual(await readFile(join(dir, 'schema.json')), await readFile(join(root, 'dist/_db', db.id, 'metadata/schema.json')));
    assert.match(await readFile(join(dir, 'robots.txt'), 'utf8'), new RegExp(`Sitemap: https://${db.siteHost.replace(/\./g, '\\.')}/sitemap\\.xml`));
    assert.match(await readFile(join(dir, 'sitemap.xml'), 'utf8'), /<urlset /);
  }
});
