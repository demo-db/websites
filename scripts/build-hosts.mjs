// Turns the built site (dist/) into one Worker-less static-asset bundle per public hostname.
//
// Every DemoDB host is served by Cloudflare Workers static assets with no Worker script (no `main`), so a
// request never counts against the account's Worker request quota. Files sit at their PUBLIC paths: there is
// no private /_db/<id> namespace and no host-to-directory mapping at request time. Everything the former
// src/worker.ts computed per request is produced here at build time:
//
//   dist-hosts/<host>/            the asset directory for that host
//   dist-hosts/<host>/_headers    CORS, nosniff, content types and cache policy
//   dist-hosts/<host>/_redirects  legacy OVDB and API redirects (308, method and query preserved)
//   dist-hosts/manifest.json      the host list and every chunked export, for tests and the live smoke
//
// The matching assets-only Wrangler configs are committed under deploy/hosts/ and read by the tests.
//
// Exports stored gzip-encoded (all AdventureWorks complete-database files and two large per-table JSON
// files; each decodes to more than the 25 MiB asset limit) are published ONLY as gzip chunks plus a
// manifest, with no single joined URL:
//
//   GET https://<id>.demodb.dev/data/<file>.parts.json
//   {"format":"demodb-chunked-export/v1","file":"<file>","compression":"gzip","bytes":N,"sha256":"<joined gzip>",
//    "uncompressedSha256":"<decoded file>"|null,"parts":[{"path":"<file>.gz.<sha256[:16]>.part-1","bytes":N,"sha256":"..."}]}
//
// Each part `path` is relative to the manifest URL.
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const MAX_ASSET_BYTES = 25 * 1024 * 1024;
export const CHUNKED_FORMAT = 'demodb-chunked-export/v1';
export const SHORT_CACHE = 'public, max-age=300, must-revalidate';
export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
export const CATALOGUE_HOST = 'demodb.dev';
// The OVDB API moved to its own host, served by the openvaultdb-cloud Worker. Old /ovdb/v1 URLs redirect there.
export const OVDB_API = 'https://ovdb.demodb.dev/v1';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Content types the former Worker set explicitly for data files. Static assets infer a type from the
// extension at upload; these rules pin the same values the Worker sent.
export const DATA_CONTENT_TYPES = {
  sqlite: 'application/vnd.sqlite3', db: 'application/vnd.sqlite3', sql: 'application/sql; charset=utf-8',
  yaml: 'application/yaml; charset=utf-8', yml: 'application/yaml; charset=utf-8', csv: 'text/csv; charset=utf-8',
  json: 'application/json; charset=utf-8', zip: 'application/zip', hcl: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8',
};
// The former Worker's CORS and cache headers on its 308 redirects, so a cross-origin GET can follow them.
const REDIRECT_HEADERS = ['Access-Control-Allow-Origin: *', 'Access-Control-Allow-Methods: GET, HEAD, OPTIONS, POST', 'Access-Control-Allow-Headers: Content-Type, Accept, OVDB-Page-Size, OVDB-Page-Token, OVDB-Page-Close', 'Access-Control-Max-Age: 86400', 'Cache-Control: public, max-age=300'];
const SECURITY = ['X-Content-Type-Options: nosniff', 'Referrer-Policy: strict-origin-when-cross-origin'];
const READONLY_CORS = ['Access-Control-Allow-Origin: *', 'Access-Control-Allow-Methods: GET, HEAD', 'Access-Control-Allow-Headers: Content-Type', 'Access-Control-Max-Age: 86400'];
// Assets the former Worker served unchanged on every dataset host.
const SHARED_ASSETS = ['_astro', 'embed/datatug.js', 'embed/exact-decimal.js', 'theme.js', 'favicon.svg', 'build-info.json', '404.html'];

export function workerName(host) {
  // The catalogue reuses the existing script name, so the cutover replaces demodb-websites' code in place
  // instead of creating a new Worker (the account is at the Free plan's 100-Worker limit).
  if (host === CATALOGUE_HOST) return 'demodb-websites';
  const dataset = /^([a-z][a-z0-9-]*)\.demodb\.dev$/.exec(host);
  if (dataset) return `demodb-${dataset[1]}`;
  return `demodb-${host.replace(/[^a-z0-9]+/g, '-')}`;
}

function headersFile(rules) {
  const patterns = rules.map(([pattern]) => pattern);
  const duplicate = patterns.find((pattern, i) => patterns.indexOf(pattern) !== i);
  if (duplicate) throw new Error(`_headers has two rules for ${duplicate}`);
  const lines = [];
  for (const [pattern, values] of rules) lines.push(pattern, ...values.map((value) => `  ${value}`), '');
  if (rules.length > 100) throw new Error(`_headers has ${rules.length} rules; the platform limit is 100`);
  for (const line of lines) if (line.length > 2000) throw new Error(`_headers line exceeds 2,000 characters: ${line.slice(0, 80)}`);
  return lines.join('\n');
}

// Rejects every rule wrangler would report as invalid (and ignore): duplicate sources, bad status codes,
// sources that are not paths, destinations that are neither paths nor absolute https URLs, overlong rules.
export function redirectProblems(rules) {
  const problems = [];
  const seen = new Set();
  for (const [from, to, status] of rules) {
    const line = `${from} ${to} ${status}`;
    if (!from.startsWith('/') || /\s/.test(from)) problems.push(`invalid source: ${line}`);
    if (!(to.startsWith('/') || /^https:\/\/[^\s/]+(\/\S*)?$/.test(to)) || /\s/.test(to)) problems.push(`invalid destination: ${line}`);
    if (![301, 302, 303, 307, 308].includes(status)) problems.push(`invalid status: ${line}`);
    if (line.length > 1000) problems.push(`rule longer than 1,000 characters: ${from}`);
    if ((from.match(/\*/g) ?? []).length > 1) problems.push(`more than one splat: ${line}`);
    if (seen.has(from)) problems.push(`duplicate source ${from}`);
    seen.add(from);
  }
  return problems;
}

function redirectsFile(rules) {
  const problems = redirectProblems(rules);
  if (problems.length) throw new Error(`_redirects would contain rules wrangler rejects:\n${problems.join('\n')}`);
  const dynamic = rules.filter(([from]) => /[*:]/.test(from)).length;
  const fixed = rules.length - dynamic;
  if (dynamic > 100 || fixed > 2000) throw new Error(`_redirects exceeds limits (static=${fixed}, dynamic=${dynamic})`);
  // Static rules must precede dynamic ones; callers already order them, so assert it.
  let seenDynamic = false;
  for (const [from] of rules) {
    if (/[*:]/.test(from)) seenDynamic = true;
    else if (seenDynamic) throw new Error(`_redirects: static rule ${from} follows a dynamic rule`);
  }
  return rules.map(([from, to, status]) => `${from} ${to} ${status}`).join('\n') + '\n';
}

function robots(host) {
  return `User-agent: *\nAllow: /\n\nSitemap: https://${host}/sitemap.xml\n`;
}

const xmlEscape = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
function sitemap(urls) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((url) => `<url><loc>${xmlEscape(url)}</loc></url>`).join('')}</urlset>\n`;
}

async function isDir(path) { return (await stat(path).catch(() => null))?.isDirectory() ?? false; }

async function walk(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full, base));
    else out.push(full.slice(base.length + 1));
  }
  return out;
}

export async function buildHosts({ dist = join(root, 'dist'), output = join(root, 'dist-hosts') } = {}) {
  const index = JSON.parse(await readFile(join(root, 'src/data/generated/index.json'), 'utf8'));
  const runtime = JSON.parse(await readFile(join(root, 'src/data/generated/runtime.json'), 'utf8'));
  const ovdb = JSON.parse(await readFile(join(root, 'src/data/generated/ovdb.json'), 'utf8'));
  if (runtime.catalogueHost !== CATALOGUE_HOST) throw new Error(`Unexpected catalogue host ${runtime.catalogueHost}`);
  const ovdbIds = ovdb.databases.map((database) => database.localId);
  for (const id of ovdbIds) if (!/^[a-z][a-z0-9-]{0,39}$/.test(id)) throw new Error(`Unsafe OVDB id ${id}`);
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const hosts = [];

  // --- catalogue: demodb.dev ------------------------------------------------------------------------------
  {
    const host = CATALOGUE_HOST;
    const dir = join(output, host);
    await cp(dist, dir, { recursive: true, filter: (source) => source !== join(dist, '_db') });
    // The OVDB API now lives at ovdb.demodb.dev (openvaultdb-cloud Worker); this bundle only redirects /ovdb/v1.
    if (await stat(join(dir, 'ovdb/v1')).catch(() => null)) throw new Error('dist must not contain /ovdb/v1; that path belongs to the openvaultdb-cloud Worker route');
    const storageIds = [];
    for (const entry of await readdir(join(dir, 'ovdb/db'), { withFileTypes: true })) {
      if (entry.isDirectory() && (await stat(join(dir, 'ovdb/db', entry.name, 'index.html')).catch(() => null))) storageIds.push(entry.name);
    }
    storageIds.sort();
    await mkdir(join(dir, '.well-known'), { recursive: true });
    await writeFile(join(dir, '.well-known/openvaultdb'), JSON.stringify({
      name: 'DemoDB OpenVaultDB server', protocol: 'openvaultdb/0.1', authEnabled: false,
      databases: ovdb.databases.map((database) => ({
        id: database.localId, url: database.id, apiUrl: database.apiUrl,
        manifestUrl: `https://demodb.dev/ovdb/db/${database.localId}/ovdb-database.json`,
        capabilities: { read: true, query: database.capabilities.query, write: false },
      })),
    }));
    await writeFile(join(dir, 'robots.txt'), robots(host));
    await writeFile(join(dir, 'sitemap.xml'), sitemap([
      `https://${host}/`, 'https://demodb.dev/corpus.json', 'https://demodb.dev/ovdb/', 'https://demodb.dev/ovdb/ovdb-server.json',
      ...storageIds.map((id) => `https://demodb.dev/ovdb/db/${id}/`),
      ...ovdbIds.flatMap((id) => [`https://demodb.dev/${id}/`, `https://demodb.dev/${id}/ovdb-database.json`, `https://demodb.dev/ovdb/db/${id}/ovdb-database.json`]),
      ...index.databases.map((database) => `https://${database.siteHost}/`),
    ]));
    const publicJson = [...READONLY_CORS, `Cache-Control: ${SHORT_CACHE}`];
    await writeFile(join(dir, '_headers'), headersFile([
      ['/*', SECURITY],
      ['/ovdb/v1', REDIRECT_HEADERS],
      ['/ovdb/v1/*', REDIRECT_HEADERS],
      ['/ovdb/dbs/*', REDIRECT_HEADERS],
      ['/corpus.json', publicJson],
      ['/.well-known/openvaultdb', [...publicJson, 'Content-Type: application/json; charset=utf-8']],
      ['/ovdb/ovdb-server.json', publicJson],
      ['/ovdb/schemas/*', publicJson],
      ['/ovdb/db/:id/ovdb-database.json', publicJson],
      ['/:id/ovdb-database.json', publicJson],
      ['/robots.txt', ['Cache-Control: public, max-age=300']],
      ['/sitemap.xml', ['Cache-Control: public, max-age=300', 'Content-Type: application/xml; charset=utf-8']],
    ]));
    await writeFile(join(dir, '_redirects'), redirectsFile([
      ['/ovdb/v1', OVDB_API, 308],
      // Legacy dataset profiles move to the canonical dataset identity page.
      ...ovdbIds.flatMap((id) => [
        [`/ovdb/dbs/${id}`, `https://demodb.dev/${id}/`, 308],
        [`/ovdb/dbs/${id}/`, `https://demodb.dev/${id}/`, 308],
        // The retired Worker checked storage routes first: an id that is also a storage entry keeps its storage page.
        ...(storageIds.includes(id) ? [] : [[`/ovdb/db/${id}`, `https://demodb.dev/${id}/`, 308]]),
      ]),
      // Storage catalogue entries gain their trailing slash with the Worker's permanent status.
      ...storageIds.map((id) => [`/ovdb/db/${id}`, `https://demodb.dev/ovdb/db/${id}/`, 308]),
      ['/ovdb/v1/*', `${OVDB_API}/:splat`, 308],
    ]));
    hosts.push({ host, name: workerName(host), kind: 'catalogue', chunked: [] });
  }

  // --- one host per dataset -------------------------------------------------------------------------------
  for (const db of index.databases) {
    const host = db.siteHost;
    if (runtime.databaseHosts[host] !== db.id || host !== `${db.id}.demodb.dev`) throw new Error(`Unexpected dataset host ${host}`);
    const dir = join(output, host);
    const source = join(dist, '_db', db.id);
    if (!(await isDir(source))) throw new Error(`${source} is missing; run the site build first`);
    const encoded = db.exports.filter((item) => item.compression === 'gzip');
    for (const item of db.exports) {
      if (item.compression && item.compression !== 'gzip') throw new Error(`${db.id}/${item.publicPath}: unsupported compression ${item.compression}`);
      if (!item.compression && item.publicPath !== item.assetPath) throw new Error(`${db.id}/${item.publicPath}: an uncompressed export must live at its public path`);
    }
    const encodedAssets = new Set(encoded.flatMap((item) => item.chunks?.length ? item.chunks.map((chunk) => `data/${chunk.assetPath}`) : [`data/${item.assetPath}`]));
    await cp(source, dir, { recursive: true, filter: (path) => !encodedAssets.has(path.slice(source.length + 1)) });
    for (const shared of SHARED_ASSETS) await cp(join(dist, shared), join(dir, shared), { recursive: true });
    // The former Worker served the internal metadata/schema.json at /schema.json.
    await cp(join(source, 'metadata/schema.json'), join(dir, 'schema.json'));

    const chunked = [];
    for (const item of encoded) {
      const pieces = item.chunks?.length
        ? await Promise.all(item.chunks.map((chunk) => readFile(join(source, 'data', chunk.assetPath))))
        : [await readFile(join(source, 'data', item.assetPath))];
      const joined = Buffer.concat(pieces);
      if (joined.length !== item.bytes || sha256(joined) !== item.sha256) throw new Error(`${db.id}/${item.publicPath}: the joined gzip differs from its pinned size or SHA-256`);
      if (item.chunks?.length) item.chunks.forEach((chunk, n) => {
        if (pieces[n].length !== chunk.bytes || sha256(pieces[n]) !== chunk.sha256) throw new Error(`${db.id}/${item.publicPath}: chunk ${n + 1} differs from its pin`);
      });
      const file = item.publicPath.split('/').at(-1);
      const parts = [];
      for (const [n, bytes] of pieces.entries()) {
        if (bytes.length > MAX_ASSET_BYTES) throw new Error(`${db.id}/${item.publicPath}: part ${n + 1} exceeds the 25 MiB asset limit`);
        // Content-addressed: the part's own SHA-256 prefix is in its name, so a one-year immutable cache can
        // never serve stale bytes after a re-pin. Consumers take part paths from the manifest.
        const name = `${file}.gz.${sha256(bytes).slice(0, 16)}.part-${n + 1}`;
        await writeFile(join(dir, 'data', dirname(item.publicPath), name), bytes);
        parts.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
      }
      const manifest = {
        format: CHUNKED_FORMAT, file, compression: 'gzip', bytes: item.bytes, sha256: item.sha256,
        uncompressedSha256: /^[a-f0-9]{64}$/.test(item.decodedSha256 ?? '') ? item.decodedSha256 : null,
        parts,
      };
      await writeFile(join(dir, 'data', `${item.publicPath}.parts.json`), `${JSON.stringify(manifest, null, 2)}\n`);
      chunked.push({ publicPath: item.publicPath, manifestPath: `/data/${item.publicPath}.parts.json`, decodedBytes: item.decodedBytes ?? null, ...manifest });
    }

    for (const relative of await walk(dir)) {
      const size = (await stat(join(dir, relative))).size;
      if (size > MAX_ASSET_BYTES) throw new Error(`${host}/${relative} is ${size} bytes, above the 25 MiB static asset limit`);
      if (relative.split('/').some((part) => part === '_db')) throw new Error(`${host}/${relative}: the private /_db namespace must not be published`);
    }

    await mkdir(join(dir, '.well-known'), { recursive: true });
    await writeFile(join(dir, '.well-known/openvaultdb'), JSON.stringify({
      name: `${db.name} OVDB discovery`, protocol: 'openvaultdb/0.1', authEnabled: false,
      databases: [{ id: db.id, url: db.ovdb.url, apiUrl: db.ovdb.connection, capabilities: { read: true, query: db.ovdb.query, write: false } }],
    }));
    await writeFile(join(dir, 'robots.txt'), robots(host));
    await writeFile(join(dir, 'sitemap.xml'), sitemap(['/', '/tables/', '/schema/', '/downloads/', '/queries/', '/about/', '/model/', ...db.tables.map((table) => `/tables/${encodeURIComponent(table.name)}/`)].map((path) => `https://${host}${path}`)));

    const dataCors = [...READONLY_CORS, 'Cross-Origin-Resource-Policy: cross-origin', `Cache-Control: ${SHORT_CACHE}`];
    const immutable = ['! Cache-Control', `Cache-Control: ${IMMUTABLE_CACHE}`];
    const usedExtensions = new Set((await walk(dir)).filter((path) => path.startsWith('data/') || path.startsWith('model/')).map((path) => path.split('.').at(-1)));
    await writeFile(join(dir, '_headers'), headersFile([
      ['/*', SECURITY],
      ['/data/*', dataCors],
      ['/schema.json', [...dataCors, `Content-Type: ${DATA_CONTENT_TYPES.json}`]],
      ['/model/*', dataCors],
      ['/.well-known/openvaultdb', [...READONLY_CORS, 'Content-Type: application/json; charset=utf-8', 'Cache-Control: public, max-age=300']],
      ...(db.id === 'northwind' ? [['/evidence/public-orders/*', [...READONLY_CORS, 'Cross-Origin-Resource-Policy: cross-origin', `Cache-Control: ${SHORT_CACHE}`]]] : []),
      ...Object.entries(DATA_CONTENT_TYPES).filter(([extension]) => usedExtensions.has(extension)).flatMap(([extension, type]) => [
        [`/data/*.${extension}`, [`Content-Type: ${type}`]],
        [`/model/*.${extension}`, [`Content-Type: ${type}`]],
      ]),
      // `/data/*.json` above also types the .parts.json manifests; a second rule would join two values.
      // Content-addressed comparison fixtures and the parts of a chunked export never change at their URL.
      ['/data/compare/*', immutable],
      // One exact rule per part: a pattern would also stamp a year of immutable caching on 404s next to them.
      ...chunked.flatMap((item) => item.parts.map((part) => [`/data/${dirname(item.publicPath) === '.' ? '' : `${dirname(item.publicPath)}/`}${part.path}`, [...immutable, 'Content-Type: application/octet-stream']])),
      ['/robots.txt', ['Cache-Control: public, max-age=300']],
      ['/sitemap.xml', ['Cache-Control: public, max-age=300', 'Content-Type: application/xml; charset=utf-8']],
      ['/ovdb', REDIRECT_HEADERS],
      ['/ovdb/*', REDIRECT_HEADERS],
    ]));

    const deployment = db.ovdb.deploymentUrl.replace(/\/$/, '');
    await writeFile(join(dir, '_redirects'), redirectsFile(db.ovdb.available ? [
      ['/ovdb', deployment, 308],
      ['/ovdb/', deployment, 308],
      ['/ovdb/v1', OVDB_API, 308],
      [`/ovdb/dbs/${db.id}`, deployment, 308],
      ['/ovdb/v1/*', `${OVDB_API}/:splat`, 308],
      [`/ovdb/dbs/${db.id}/*`, `${deployment}/:splat`, 308],
      ['/ovdb/*', `${deployment}/:splat`, 308],
    ] : []));
    hosts.push({ host, name: workerName(host), kind: 'dataset', id: db.id, chunked });
  }

  // chinookdb.com (runtime.legacyAliases) is deliberately not built: the founder dropped it from this cutover
  // (2026-10-16), and the datatug/chinookdb repository declares that domain for its own Worker.

  await writeFile(join(output, 'manifest.json'), `${JSON.stringify({ format: 'demodb-static-hosts/v1', hosts }, null, 2)}\n`);
  return hosts;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const hosts = await buildHosts();
  console.log(`Static host bundles: ${hosts.map((host) => `${host.host}${host.chunked.length ? ` (${host.chunked.length} chunked)` : ''}`).join(', ')}`);
}
