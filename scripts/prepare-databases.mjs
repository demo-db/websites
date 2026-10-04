import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const registry = JSON.parse(await readFile(join(root, 'config/databases.json'), 'utf8'));
const localRoot = process.env.DEMODB_CONTRACTS_DIR ? resolve(process.env.DEMODB_CONTRACTS_DIR) : null;
const isRelease = Boolean(process.env.CI || process.env.GITHUB_ACTIONS || process.env.DEPLOY_ENV || process.env.CF_PAGES);
if (localRoot && isRelease) throw new Error('DEMODB_CONTRACTS_DIR is development-only and cannot be used in CI/deploy builds');
if (!localRoot && registry.databases.some((db) => !isSha(db.commit) || !isHash(db.contractSha256))) {
  throw new Error('Registry pins are not complete. Use DEMODB_CONTRACTS_DIR for a local build or land and pin each provider commit and contract SHA.');
}

const generatedDir = join(root, 'src/data/generated');
const internalAssets = join(root, 'public/_db');
await rm(generatedDir, { recursive: true, force: true });
await rm(internalAssets, { recursive: true, force: true });
await mkdir(generatedDir, { recursive: true });
await mkdir(internalAssets, { recursive: true });

const databases = [];
for (const entry of registry.databases) {
  const source = await loadProvider(entry);
  validateDatabaseEntry(entry, source.manifest, source.contract);
  const db = normalizeProvider(entry, source);
  databases.push(db);
  await materializeExports(db, source);
  await materializeModels(db, source);
  const schemaPath = join(internalAssets, db.id, 'metadata/schema.json');
  await mkdir(dirname(schemaPath), { recursive: true });
  await writeFile(schemaPath, `${JSON.stringify(db.schema, null, 2)}\n`);
}

const ids = new Set();
const hosts = new Map();
const aliasHosts = new Map();
for (const db of databases) {
  if (ids.has(db.id)) throw new Error(`Duplicate database id: ${db.id}`);
  ids.add(db.id);
  if (hosts.has(db.siteHost)) throw new Error(`Duplicate database host: ${db.siteHost}`);
  hosts.set(db.siteHost, db.id);
  for (const alias of db.aliases) {
    if (alias === registry.catalogueHost || alias === `www.${registry.catalogueHost}` || hosts.has(alias) || aliasHosts.has(alias)) throw new Error(`Conflicting provider alias: ${alias}`);
    aliasHosts.set(alias, db.id);
  }
}
if (hosts.has(registry.catalogueHost)) throw new Error('The catalogue host cannot also be a database host');
for (const host of hosts.keys()) if (aliasHosts.has(host)) throw new Error(`Provider alias collides with a database host: ${host}`);

await writeFile(join(generatedDir, 'index.json'), `${JSON.stringify({ catalogueHost: registry.catalogueHost, databases }, null, 2)}\n`);
await writeFile(join(generatedDir, 'runtime.json'), `${JSON.stringify({
  catalogueHost: registry.catalogueHost,
  wwwCatalogueHost: `www.${registry.catalogueHost}`,
  databaseHosts: Object.fromEntries(hosts),
  legacyAliases: Object.fromEntries(databases.flatMap((db) => db.aliases.map((host) => [host, db.id]))),
  databaseIds: [...ids],
}, null, 2)}\n`);
console.log(`Prepared ${databases.length} provider contracts: ${databases.map((db) => db.id).join(', ')}`);

async function loadProvider(entry) {
  const files = new Map();
  const read = async (path) => {
    safeRelative(path);
    if (files.has(path)) return files.get(path);
    const bytes = localRoot
      ? await readFile(join(localRoot, entry.id, path))
      : await fetchPinned(entry, path);
    files.set(path, bytes);
    return bytes;
  };
  const [contractBytes, checksumBytes, manifestBytes, ovdbBytes] = await Promise.all([
    read('metadata/contract.json'), read('metadata/checksums.json'), read('manifest.json'), read('ovdb.yaml'),
  ]);
  const contract = JSON.parse(contractBytes.toString('utf8'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const checksums = JSON.parse(checksumBytes.toString('utf8'));
  if (sha256(contractBytes) !== entry.contractSha256 && !localRoot) throw new Error(`${entry.id}: contract SHA does not match registry pin`);
  verifyChecksum(checksums, 'metadata/contract.json', contractBytes);
  verifyChecksum(checksums, 'manifest.json', manifestBytes);
  const ovdb = parseYaml(ovdbBytes.toString('utf8'));
  if (ovdb.id !== entry.id) throw new Error(`${entry.id}: ovdb.yaml declares ${ovdb.id}`);
  if (!Array.isArray(contract.exports)) throw new Error(`${entry.id}: contract has no export list`);
  return { contract, manifest, checksums, ovdb, read };
}

async function fetchPinned(entry, path) {
  const url = `https://raw.githubusercontent.com/${repoSlug(entry.repository)}/${entry.commit}/${path.split('/').map(encodeURIComponent).join('/')}`;
  const response = await fetch(url, { headers: { 'User-Agent': 'DemoDB-provider-contract/1' } });
  if (!response.ok) throw new Error(`${entry.id}: GET ${url} failed with ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function normalizeProvider(entry, source) {
  const manifest = source.manifest;
  const contractManifest = source.contract.manifest;
  if (!contractManifest || contractManifest.id !== entry.id) throw new Error(`${entry.id}: contract manifest ID mismatch`);
  const schema = source.contract.schema;
  if (!schema || schema.database?.id !== entry.id || !Array.isArray(schema.tables)) throw new Error(`${entry.id}: invalid schema contract`);
  if (manifest.siteHost !== contractManifest.siteHost) throw new Error(`${entry.id}: top-level and contract siteHost differ`);
  const siteHost = validHost(manifest.siteHost);
  if (siteHost !== `${entry.id}.${registry.catalogueHost}`) throw new Error(`${entry.id}: unexpected site hostname ${siteHost}`);
  const canonicalUrl = source.ovdb.url;
  const deploymentUrl = source.ovdb.deployment?.url;
  if (!validHttpsUrl(canonicalUrl) || !validHttpsUrl(deploymentUrl)) throw new Error(`${entry.id}: invalid OVDB canonical or deployment URL`);
  const discovery = source.ovdb.deployment?.discovery;
  if (!validHttpsUrl(discovery)) throw new Error(`${entry.id}: invalid OVDB discovery URL`);
  if (new URL(discovery).pathname !== '/.well-known/openvaultdb') throw new Error(`${entry.id}: discovery path must be /.well-known/openvaultdb`);
  const aliases = Array.isArray(manifest.aliases) ? manifest.aliases.map(validHost) : [];
  const exports = source.contract.exports.map((item) => normalizeExport(entry.id, item, schema.tables));
  const paths = new Set();
  const publicPaths = new Set();
  for (const item of exports) {
    if (paths.has(item.path)) throw new Error(`${entry.id}: duplicate provider export path ${item.path}`);
    if (publicPaths.has(item.publicPath)) throw new Error(`${entry.id}: duplicate public export path ${item.publicPath}`);
    paths.add(item.path);
    publicPaths.add(item.publicPath);
  }
  return {
    id: entry.id, name: manifest.name, description: manifest.description,
    domain: manifest.domain ?? 'Sample database', siteHost, aliases,
    canonicalUrl: `https://${siteHost}/`, source: manifest.source,
    capabilities: manifest.capabilities, semantics: manifest.semantics ?? {}, queries: manifest.queries ?? [],
    schema, tables: schema.tables, exports, exportByPublicPath: Object.fromEntries(exports.map((item) => [item.publicPath, item])),
    model: manifest.model ?? source.ovdb.model ?? {}, meaning: manifest.meaning ?? source.ovdb.meaning ?? {}, ovdb: {
      url: canonicalUrl, deploymentUrl, discovery,
      recordsetPage: source.ovdb.deployment?.recordset_page ?? null,
      connection: manifest.capabilities?.ovdb?.connection ?? deploymentUrl,
      available: manifest.capabilities?.ovdb?.available === true,
      readOnly: manifest.capabilities?.ovdb?.readOnly !== false,
      query: manifest.capabilities?.ovdb?.query === true,
    },
    sourceRepository: entry.repository, sourceCommit: entry.commit,
  };
}

async function materializeExports(db, source) {
  for (const item of db.exports) {
    const bytes = await source.read(item.path);
    const checksum = source.checksums.files?.[item.path];
    if (checksum) verifyChecksum(source.checksums, item.path, bytes);
    else if (!item.sha256 || sha256(bytes) !== item.sha256) throw new Error(`${db.id}: export ${item.path} is not covered by a provider checksum or contract hash`);
    if (item.bytes != null && item.bytes !== bytes.length) throw new Error(`${db.id}: ${item.path} size mismatch`);
    if (item.sha256 && item.sha256 !== sha256(bytes)) throw new Error(`${db.id}: ${item.path} export hash mismatch`);
    const target = join(internalAssets, db.id, 'data', item.publicPath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
}

async function materializeModels(db, source) {
  const files = [db.model.modelspec, db.model.hcl, db.meaning.file].filter(Boolean);
  const modelChecksumsBytes = await source.read('model/checksums.json').catch(() => null);
  const modelChecksums = modelChecksumsBytes ? JSON.parse(modelChecksumsBytes.toString('utf8')) : null;
  for (const path of files) {
    safeRelative(path);
    const bytes = await source.read(path);
    verifyChecksum(source.checksums, path, bytes, modelChecksums);
    const name = path.split('/').pop();
    const target = join(internalAssets, db.id, 'model', name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  if (modelChecksumsBytes) await writeFile(join(internalAssets, db.id, 'model/checksums.json'), modelChecksumsBytes);
}

function normalizeExport(id, item, tables) {
  const path = item.path;
  safeRelative(path);
  if (!path.startsWith('artifacts/')) throw new Error(`${id}: public exports must be under artifacts/: ${path}`);
  const base = path.split('/').pop();
  const ext = base.toLowerCase().split('.').pop();
  if (path.split('/').includes('metadata')) {
    return { path, publicPath: `metadata/${base}`, format: 'metadata', table: null, bytes: item.bytes ?? null, sha256: item.sha256 ?? null, dbWide: true };
  }
  let tableName = typeof item.table === 'string' ? item.table : null;
  let format = item.format ?? null;
  if (tableName && (tableName.includes('/') || tableName.includes('\\') || tableName === '.' || tableName === '..')) throw new Error(`${id}: recordset cannot be represented as a single URL path segment: ${tableName}`);
  if (format && !/^[a-z][a-z0-9-]*$/.test(format)) throw new Error(`${id}: invalid export format ${format}`);
  const match = tables.find((table) => tableName ? table.name === tableName : (
    base === `${id}.${table.name}.${ext}` || base === `${table.name}.${ext}`
  ));
  if (!format && match) format = ext === 'sql' && /\/(postgresql|mysql|sqlserver)\//i.test(path) ? 'sql' : ext;
  if (!match) {
    if (!format) {
      if (base === `${id}.sqlite` || base === `${id}.db`) format = 'sqlite';
      else if (base === `${id}.sql`) format = 'sql';
      else if (base === `${id}.json`) format = 'json';
      else if (base === `${id}.yaml` || base === `${id}.yml`) format = 'yaml';
      else if (new RegExp(`^${id}\\.(postgresql|mysql|sqlserver)\\.sql$`).test(base)) format = base.split('.')[1];
    }
    if (!format) throw new Error(`${id}: cannot classify export ${path}`);
  }
  const dbWide = !match && !tableName;
  const extension = ext === 'yml' ? 'yaml' : ext;
  let publicPath;
  if (match || tableName) publicPath = `${format}/${id}.${tableName ?? match.name}.${extension}`;
  else if (format === 'sqlite') publicPath = `${id}.sqlite`;
  else if (format === 'sql' || ['postgresql', 'mysql', 'sqlserver'].includes(format)) publicPath = format === 'sql' ? `${id}.sql` : `${id}.${format}.sql`;
  else if (dbWide) publicPath = `${id}.${extension}`;
  else publicPath = path.slice('artifacts/'.length);
  return { path, publicPath, format, table: tableName ?? match?.name ?? null, bytes: item.bytes ?? null, sha256: item.sha256 ?? null, dbWide };
}

function verifyChecksum(checksums, path, bytes, secondary) {
  const basename = path.split('/').pop();
  const entry = checksums.files?.[path] ?? secondary?.files?.[path] ?? secondary?.files?.[basename];
  if (!entry) throw new Error(`Missing provider checksum for ${path}`);
  if (entry.bytes != null && entry.bytes !== bytes.length) throw new Error(`${path}: provider size mismatch`);
  if (entry.sha256 !== sha256(bytes)) throw new Error(`${path}: provider checksum mismatch`);
}

function validateDatabaseEntry(entry, manifest, contract) {
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(entry.id)) throw new Error(`Invalid database id ${entry.id}`);
  if (manifest.id !== entry.id || contract.manifest?.id !== entry.id) throw new Error(`${entry.id}: ID disagrees across registry and contract`);
  if (!isSha(entry.commit) && !localRoot) throw new Error(`${entry.id}: provider commit must be a full immutable SHA`);
  if (!isHash(entry.contractSha256) && !localRoot) throw new Error(`${entry.id}: provider contract SHA must be a full SHA-256`);
}

function repoSlug(repository) {
  const url = new URL(repository);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.pathname.split('/').filter(Boolean).length !== 2) throw new Error(`Unsupported provider repository: ${repository}`);
  return url.pathname.slice(1);
}
function safeRelative(path) {
  if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\\') || path.split('/').some((part) => part === '..' || part === '.' || !part)) throw new Error(`Unsafe provider path: ${path}`);
}
function validHost(value) {
  if (typeof value !== 'string' || value !== value.toLowerCase() || !/^(?:[a-z0-9]+(?:-[a-z0-9]+)*\.)*[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) throw new Error(`Invalid provider host: ${value}`);
  return value;
}
function validHttpsUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.search && !url.hash && !value.includes('%'); }
  catch { return false; }
}
function isSha(value) { return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value); }
function isHash(value) { return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value); }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
