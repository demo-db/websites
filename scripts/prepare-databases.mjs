import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { assertAppendOnlyFixturePins, materializeComparisonFixtures } from './comparison-fixtures.mjs';
import { validateDatabaseDescriptor, validateServerDescriptor } from './ovdb-schema.mjs';
import { materializeProviderExports } from './provider-exports.mjs';
import { LOCK_FORMAT, LOCK_PATH, SQL_SCRIPT_FORMATS, deriveDatasetExports, serializeLock } from './derived-exports.mjs';
import { formatAvailability, validateMatrix } from './format-matrix.mjs';
import { isCompatibleProviderSchema } from './provider-schema-compat.mjs';
import { publishNorthwindOrdersEvidence } from './northwind-orders-evidence.mjs';
import { projectRelatedDatabases } from './related-databases.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const registry = JSON.parse(await readFile(join(root, 'config/databases.json'), 'utf8'));
const relatedDatabaseConfig = JSON.parse(await readFile(join(root, 'config/related-databases.json'), 'utf8'));
const comparisonHistory = JSON.parse(await readFile(join(root, 'config/comparison-fixtures-history.json'), 'utf8'));
if (comparisonHistory.format !== 'demodb-comparison-fixture-history/v1') throw new Error('Unsupported comparison fixture history format');
assertAppendOnlyFixturePins(registry.comparisonFixtures ?? [], comparisonHistory.fixtures);
const localRoot = process.env.DEMODB_CONTRACTS_DIR ? resolve(process.env.DEMODB_CONTRACTS_DIR) : null;
const isRelease = Boolean(process.env.CI || process.env.GITHUB_ACTIONS || process.env.DEPLOY_ENV || process.env.CF_PAGES);
if (localRoot && isRelease) throw new Error('DEMODB_CONTRACTS_DIR is development-only and cannot be used in CI/deploy builds');
if (!localRoot && registry.databases.some((db) => !isSha(db.commit) || !isHash(db.contractSha256))) {
  throw new Error('Registry pins are not complete. Use DEMODB_CONTRACTS_DIR for a local build or land and pin each provider commit and contract SHA.');
}

const formatMatrix = validateMatrix(JSON.parse(await readFile(join(root, 'config/format-matrix.json'), 'utf8')), registry.databases.map((entry) => entry.id));
const updateDerivedLock = process.env.DEMODB_UPDATE_DERIVED_LOCK === '1';
if (updateDerivedLock && isRelease) throw new Error('DEMODB_UPDATE_DERIVED_LOCK is development-only and cannot be used in CI/deploy builds');
const derivedLock = updateDerivedLock ? null : JSON.parse(await readFile(join(root, LOCK_PATH), 'utf8'));
if (derivedLock && derivedLock.format !== LOCK_FORMAT) throw new Error(`${LOCK_PATH} must declare ${LOCK_FORMAT}`);
const lockCollector = updateDerivedLock ? { update: true, collected: {} } : { lock: derivedLock };
const python = process.env.PYTHON ?? 'python3';
const derivedByDatabase = new Map();

const generatedDir = join(root, 'src/data/generated');
const internalAssets = join(root, 'public/_db');
const researchSnapshots = join(root, 'public/research-snapshots');
const previousManifestIds = await readFile(join(generatedDir, 'public-manifest-ids.json'), 'utf8')
  .then((value) => JSON.parse(value))
  .catch(() => []);
for (const id of Array.isArray(previousManifestIds) ? previousManifestIds : []) {
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(id)) continue;
  await rm(join(root, 'public', id, 'ovdb-database.json'), { force: true });
  await rm(join(root, 'public/ovdb/db', id, 'ovdb-database.json'), { force: true });
}
await rm(join(root, 'public/ovdb/ovdb-server.json'), { force: true });
await rm(join(root, 'public/ovdb/schemas/ovdb-database-draft-1.schema.json'), { force: true });
await rm(join(root, 'public/ovdb/schemas/ovdb-server-draft-1.schema.json'), { force: true });
await rm(generatedDir, { recursive: true, force: true });
await rm(internalAssets, { recursive: true, force: true });
await rm(researchSnapshots, { recursive: true, force: true });
await mkdir(generatedDir, { recursive: true });
await mkdir(internalAssets, { recursive: true });
await mkdir(researchSnapshots, { recursive: true });

const presentationHits = new Map();
const databases = [];
const ovdbDescriptors = [];
for (const entry of registry.databases) {
  const source = await loadProvider(entry);
  validateDatabaseEntry(entry, source.manifest, source.contract);
  const db = normalizeProvider(entry, source);
  applyPresentationText(db, entry, ['name', 'description', 'source', 'queries', 'model', 'meaning']);
  databases.push(db);
  const descriptor = validateDatabaseDescriptor(source.ovdbDescriptor, entry.id);
  validateDescriptorSchemaProjection(descriptor, db.schema.tables);
  validateDescriptorAssetReferences(descriptor, db);
  if (descriptor.title !== source.ovdb.title || descriptor.description !== source.ovdb.description) throw new Error(`${entry.id}: OVDB descriptor text disagrees with the publisher metadata`);
  if (descriptor.capabilities.query !== db.ovdb.query) throw new Error(`${entry.id}: OVDB query capability disagrees with the website metadata`);
  const displayDescriptor = structuredClone(descriptor);
  applyPresentationText(displayDescriptor, entry, ['title', 'description', 'provenance', 'model', 'meaning']);
  ovdbDescriptors.push({ descriptor, displayDescriptor, bytes: source.ovdbDescriptorBytes });
  await materializeExports(db, source);
  derivedByDatabase.set(db.id, await deriveDatasetExports({
    db, row: formatMatrix.datasets[db.id], source, collector: lockCollector, assetsRoot: internalAssets, python,
    registryEntry: entry, ingitdbRevision: registry.ingitdbRevisions?.[db.id], localRoot,
  }));
  await materializeModels(db, source);
  const schemaPath = join(internalAssets, db.id, 'metadata/schema.json');
  await mkdir(dirname(schemaPath), { recursive: true });
  await writeFile(schemaPath, `${JSON.stringify(db.schema, null, 2)}\n`);
}

// Publish the separately reviewed, immutable Northwind Orders observation.
// It is evidence about public responses at one time, not a live rights envelope.
await publishNorthwindOrdersEvidence({ outputDir: join(internalAssets, 'northwind/evidence/public-orders') });

const databaseEntries = new Map(registry.databases.map((entry) => [entry.id, entry]));
const comparisonAssets = await materializeComparisonFixtures(
  registry.comparisonFixtures ?? [],
  internalAssets,
  async (pin, path) => {
    safeRelative(path);
    if (pin.repository !== databaseEntries.get(pin.databaseId)?.repository) {
      throw new Error(`${pin.fixtureId}: comparison fixture repository does not match its provider entry`);
    }
    return localRoot
      ? readFile(join(localRoot, pin.databaseId, path))
      : fetchPinnedRevision(pin.repository, pin.commit, path);
  },
  (pin) => {
    const db = databases.find((database) => database.id === pin.databaseId);
    const exportFile = db?.exports.find((item) => item.publicPath === `${pin.databaseId}.sqlite` && item.format === 'sqlite' && item.table == null);
    return exportFile ? {
      bytes: exportFile.decodedBytes ?? exportFile.bytes,
      sha256: exportFile.decodedSha256 ?? exportFile.sha256,
    } : null;
  },
);
for (const asset of comparisonAssets) {
  const db = databases.find((database) => database.id === asset.databaseId);
  if (!db) throw new Error(`${asset.id}: comparison fixture references an unknown database ${asset.databaseId}`);
  db.comparisonFixtures ??= [];
  db.comparisonFixtures.push({
    id: asset.id,
    publicPath: asset.publicPath,
    assetPath: asset.assetPath,
    sha256: asset.sha256,
    bytes: asset.bytes,
  });
}

assertPresentationReplacementsUsed();
const relatedByDatabase = projectRelatedDatabases(relatedDatabaseConfig, databases);
for (const db of databases) db.relatedDatabases = relatedByDatabase.get(db.id) ?? [];
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
const snapshotBuilder = spawnSync(process.env.PYTHON ?? 'python3', [
  join(root, 'scripts/hosting-tools/research_snapshots.py'), 'build',
  '--index', join(generatedDir, 'index.json'), '--assets', internalAssets, '--output', researchSnapshots,
], { cwd: root, encoding: 'utf8' });
if (snapshotBuilder.error) throw new Error(`Could not start research snapshot builder: ${snapshotBuilder.error.message}`);
if (snapshotBuilder.status !== 0) throw new Error(`Research snapshot build failed: ${snapshotBuilder.stderr || snapshotBuilder.stdout}`);
// Derived downloads join the registry only now: the research snapshots above package the provider's own pinned
// files and stay byte-identical whatever the matrix adds. The matrix must describe exactly what is produced.
for (const db of databases) {
  db.exports.push(...derivedByDatabase.get(db.id));
  db.exportByPublicPath = Object.fromEntries(db.exports.map((item) => [item.publicPath, item]));
  db.formatAvailability = formatAvailability(formatMatrix, db.id, db.exports);
  await rewritePublishedChecksums(db);
}
if (updateDerivedLock) {
  await writeFile(join(root, LOCK_PATH), serializeLock(lockCollector.collected));
  console.warn(`Rewrote ${LOCK_PATH}; review the diff before committing.`);
}
await writeFile(join(generatedDir, 'index.json'), `${JSON.stringify({ catalogueHost: registry.catalogueHost, databases }, null, 2)}\n`);
await writeFile(join(root, 'public/corpus.json'), `${JSON.stringify(buildCorpus(databases), null, 2)}\n`);
await writeFile(join(generatedDir, 'runtime.json'), `${JSON.stringify({
  catalogueHost: registry.catalogueHost,
  wwwCatalogueHost: `www.${registry.catalogueHost}`,
  databaseHosts: Object.fromEntries(hosts),
  legacyAliases: Object.fromEntries(databases.flatMap((db) => db.aliases.map((host) => [host, db.id]))),
  databaseIds: [...ids],
}, null, 2)}\n`);
const ovdbServer = validateServerDescriptor({
  format: 'ovdb-server/draft-1',
  id: 'https://demodb.dev/ovdb',
  title: 'DemoDB OpenVaultDB server',
  description: 'A shared, read-only OpenVaultDB server for the curated DemoDB sample databases.',
  homepage: 'https://demodb.dev/ovdb/',
  apiUrl: 'https://demodb.dev/ovdb/v1',
  databases: ovdbDescriptors.map(({ descriptor }) => ({
    id: descriptor.id,
    localId: descriptor.localId,
    serverDbBaseUrl: descriptor.serverDbBaseUrl,
    manifestUrl: `${descriptor.serverDbBaseUrl}ovdb-database.json`,
    apiUrl: descriptor.apiUrl,
  })),
});
const publicOvdb = join(root, 'public/ovdb');
await mkdir(join(publicOvdb, 'schemas'), { recursive: true });
await writeFile(join(publicOvdb, 'ovdb-server.json'), `${JSON.stringify(ovdbServer, null, 2)}\n`);
for (const name of ['ovdb-server-draft-1.schema.json', 'ovdb-database-draft-1.schema.json']) {
  await writeFile(join(publicOvdb, 'schemas', name), await readFile(join(root, 'schemas', name)));
}
for (const { descriptor, bytes } of ovdbDescriptors) {
  for (const target of [
    join(root, 'public/ovdb/db', descriptor.localId, 'ovdb-database.json'),
    join(root, 'public', descriptor.localId, 'ovdb-database.json'),
  ]) {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
}
await writeFile(join(generatedDir, 'public-manifest-ids.json'), `${JSON.stringify(ovdbDescriptors.map(({ descriptor }) => descriptor.localId))}\n`);
// PostgreSQL public readiness. DEMODB_POSTGRESQL_API_CONFIG selects a fixture so CI can build the verified
// state without committing the flip. Such a build is NOT deployable: the generated file records which source
// and hash were used, and scripts/assert-deployable-build.mjs refuses anything but the committed config.
const defaultPostgresqlApiSource = 'config/postgresql-api.json';
const postgresqlApiPath = process.env.DEMODB_POSTGRESQL_API_CONFIG ? resolve(process.env.DEMODB_POSTGRESQL_API_CONFIG) : join(root, defaultPostgresqlApiSource);
const postgresqlApiBytes = await readFile(postgresqlApiPath);
const postgresqlApi = JSON.parse(postgresqlApiBytes.toString('utf8'));
if (postgresqlApi.format !== 'demodb-postgresql-api/v1' || typeof postgresqlApi.publicApiVerified !== 'boolean') {
  throw new Error('The PostgreSQL API config must declare demodb-postgresql-api/v1 with a boolean publicApiVerified');
}
const postgresqlApiSource = relative(root, postgresqlApiPath).split(sep).join('/');
const postgresqlApiProvenance = { source: postgresqlApiSource, sha256: createHash('sha256').update(postgresqlApiBytes).digest('hex'), default: postgresqlApiSource === defaultPostgresqlApiSource };
if (!postgresqlApiProvenance.default) console.warn(`WARNING: PostgreSQL API config comes from ${postgresqlApiSource}; this build is not deployable.`);
await writeFile(join(generatedDir, 'postgresql-api.json'), `${JSON.stringify({ ...postgresqlApi, provenance: postgresqlApiProvenance }, null, 2)}\n`);
await writeFile(join(generatedDir, 'ovdb.json'), `${JSON.stringify({ server: ovdbServer, databases: ovdbDescriptors.map(({ displayDescriptor }) => displayDescriptor) }, null, 2)}\n`);
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
  const [contractBytes, checksumBytes, manifestBytes, ovdbBytes, ovdbDescriptorBytes, databaseSchemaBytes] = await Promise.all([
    read('metadata/contract.json'), read('metadata/checksums.json'), read('manifest.json'), read('ovdb.yaml'), read('ovdb-database.json'), read('schemas/ovdb-database-draft-1.schema.json'),
  ]);
  const contract = JSON.parse(contractBytes.toString('utf8'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const checksums = JSON.parse(checksumBytes.toString('utf8'));
  const ovdbDescriptor = JSON.parse(ovdbDescriptorBytes.toString('utf8'));
  if (sha256(contractBytes) !== entry.contractSha256 && !localRoot) throw new Error(`${entry.id}: contract SHA does not match registry pin`);
  verifyChecksum(checksums, 'metadata/contract.json', contractBytes);
  verifyChecksum(checksums, 'manifest.json', manifestBytes);
  verifyChecksum(checksums, 'ovdb-database.json', ovdbDescriptorBytes);
  verifyChecksum(checksums, 'schemas/ovdb-database-draft-1.schema.json', databaseSchemaBytes);
  if (!isCompatibleProviderSchema(sha256(databaseSchemaBytes))) throw new Error(`${entry.id}: vendored OVDB database schema is not a supported immutable draft-1 revision`);
  const ovdb = parseYaml(ovdbBytes.toString('utf8'));
  if (ovdb.id !== entry.id) throw new Error(`${entry.id}: ovdb.yaml declares ${ovdb.id}`);
  if (!Array.isArray(contract.exports)) throw new Error(`${entry.id}: contract has no export list`);
  return { contract, manifest, checksums, ovdb, ovdbDescriptor, ovdbDescriptorBytes, read };
}

async function fetchPinned(entry, path) {
  return fetchPinnedRevision(entry.repository, entry.commit, path);
}

async function fetchPinnedRevision(repository, commit, path) {
  const url = `https://raw.githubusercontent.com/${repoSlug(repository)}/${commit}/${path.split('/').map(encodeURIComponent).join('/')}`;
  const response = await fetch(url, { headers: { 'User-Agent': 'DemoDB-provider-contract/1' } });
  if (!response.ok) throw new Error(`GET ${url} failed with ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

// Registry-level wording corrections for user-visible text. The provider's own descriptor
// bytes stay pinned and are served unchanged; only the site's rendered pages, generated
// catalogue data and descriptive metadata use the corrected wording. Every replacement
// must match at least once so a stale entry fails the build instead of silently doing nothing.
function applyPresentationText(target, entry, fields) {
  const replacements = entry.textReplacements ?? [];
  const rewrite = (value) => {
    if (typeof value === 'string') {
      let out = value;
      for (const { from, to } of replacements) {
        if (!out.includes(from)) continue;
        presentationHits.set(`${entry.id}\0${from}`, true);
        out = out.split(from).join(to);
      }
      return out;
    }
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item)]));
    return value;
  };
  for (const field of fields) if (field in target) target[field] = rewrite(target[field]);
}
function assertPresentationReplacementsUsed() {
  for (const entry of registry.databases) {
    for (const { from } of entry.textReplacements ?? []) {
      if (!presentationHits.has(`${entry.id}\0${from}`)) throw new Error(`${entry.id}: textReplacements entry ${JSON.stringify(from)} matched nothing; remove it`);
    }
  }
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
  const exports = source.contract.exports.map((item) => displacedByGenerated(entry.id, normalizeExport(entry.id, item, schema.tables, source.checksums, manifest)));
  const paths = new Set();
  const physicalPaths = new Set();
  const publicPaths = new Set();
  for (const item of exports) {
    if (paths.has(item.path)) throw new Error(`${entry.id}: duplicate provider export path ${item.path}`);
    if (publicPaths.has(item.publicPath)) throw new Error(`${entry.id}: duplicate public export path ${item.publicPath}`);
    paths.add(item.path);
    publicPaths.add(item.publicPath);
    const materializedPaths = item.compression === 'gzip'
      ? item.chunks?.length ? item.chunks.map((chunk) => chunk.path) : [item.encodedPath]
      : [item.path];
    for (const path of materializedPaths) {
      if (physicalPaths.has(path)) throw new Error(`${entry.id}: provider file is shared by multiple exports: ${path}`);
      physicalPaths.add(path);
    }
  }
  return {
    id: entry.id, name: manifest.name, description: manifest.description,
    domain: manifest.domain ?? 'Sample database', siteHost, aliases,
    canonicalUrl: `https://${siteHost}/`, source: manifest.source,
    capabilities: manifest.capabilities, semantics: manifest.semantics ?? {}, queries: manifest.queries ?? [],
    schema, schemaSha256: sha256(Buffer.from(`${JSON.stringify(schema, null, 2)}\n`)), tables: schema.tables, exports, exportByPublicPath: Object.fromEntries(exports.map((item) => [item.publicPath, item])),
    model: manifest.model ?? source.ovdb.model ?? {}, meaning: manifest.meaning ?? source.ovdb.meaning ?? {}, ovdb: {
      url: canonicalUrl, deploymentUrl, discovery,
      recordsetPage: source.ovdb.deployment?.recordset_page ?? null,
      connection: manifest.capabilities?.ovdb?.connection ?? deploymentUrl,
      available: manifest.capabilities?.ovdb?.available === true,
      readOnly: manifest.capabilities?.ovdb?.readOnly !== false,
      query: manifest.capabilities?.ovdb?.query === true,
    },
    sourceRepository: entry.repository, sourceCommit: entry.commit,
    publicIdentity: source.ovdbDescriptor.id,
    publicManifestUrl: `${source.ovdbDescriptor.serverDbBaseUrl}ovdb-database.json`,
    publicApiUrl: source.ovdbDescriptor.apiUrl,
    publicModel: source.ovdbDescriptor.model,
    publicMeaning: source.ovdbDescriptor.meaning,
    publisher: source.ovdbDescriptor.publisher,
    provenance: source.ovdbDescriptor.provenance,
    licences: source.ovdbDescriptor.licences,
  };
}

async function materializeExports(db, source) {
  await materializeProviderExports(db.id, db.exports, source, join(internalAssets, db.id, 'data'));
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

// A provider may publish `metadata/checksums.json`, "every other published data file with its SHA-256 and size". Chinook does. The site moves
// and adds downloads after the provider wrote it (a displaced upstream script, the generated scripts and archives), so the published copy is
// rewritten here to describe what is served: an upstream script moves to its `upstream/` path, and each file DemoDB generated gets its
// entry (decoded size and SHA-256, as a client receives it). The provider's own entries are not touched, and a test compares every entry
// of every published checksums.json with the bytes served at its path.
async function rewritePublishedChecksums(db) {
  const entry = db.exports.find((item) => item.format === 'metadata' && item.publicPath === 'metadata/checksums.json' && !item.compression && !item.chunks?.length);
  if (!entry) return;
  const target = join(internalAssets, db.id, 'data', entry.assetPath);
  const document = JSON.parse(await readFile(target, 'utf8'));
  if (!document.files || typeof document.files !== 'object') return;
  const files = { ...document.files };
  let changed = false;
  const identityOf = (file) => ({ sha256: file.decodedSha256 ?? file.sha256, bytes: file.decodedBytes ?? file.bytes });
  for (const file of db.exports.filter((item) => !item.table && item.format.startsWith('upstream-'))) {
    const original = file.publicPath.slice('upstream/'.length);
    if (files[original]?.sha256 === identityOf(file).sha256) delete files[original];
    files[file.publicPath] = identityOf(file);
    changed = true;
  }
  for (const file of db.exports.filter((item) => !item.table && item.derived)) {
    files[file.publicPath] = identityOf(file);
    changed = true;
  }
  if (!changed) return;
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const rewritten = Buffer.from(`${JSON.stringify({ ...document, files: sorted, siteNote: 'DemoDB rewrote this file when it built the site: an upstream script that a generated one displaced is listed at its upstream/ path, and the files DemoDB generates are listed with the size and SHA-256 a client receives.' }, null, 2)}\n`);
  await writeFile(target, rewritten);
  entry.bytes = rewritten.length;
  entry.sha256 = sha256(rewritten);
}

// A provider's own complete SQL script of an engine (Chinook ships lerocha's upstream mysql, postgresql and sqlserver scripts) keeps the
// canonical URL only while the matrix says the provider file is what is served. When the matrix serves a script that DemoDB generated and
// verified for that format, the canonical URL belongs to it and the provider's upstream script moves to /data/upstream/<file>, as
// format `upstream-<format>` (labelled "upstream (unverified, drops database)" on the pages).
function displacedByGenerated(id, item) {
  if (item.table || !item.dbWide || !SQL_SCRIPT_FORMATS.includes(item.format)) return item;
  const cell = formatMatrix.datasets[id]?.[item.format];
  if (!cell || cell.state !== 'download' || cell.origin === 'provider') return item;
  const move = (path) => `upstream/${path}`;
  return {
    ...item, format: `upstream-${item.format}`, publicPath: move(item.publicPath), assetPath: move(item.assetPath),
    chunks: item.chunks.map((chunk) => ({ ...chunk, assetPath: move(chunk.assetPath) })),
  };
}

function normalizeExport(id, item, tables, checksums, manifest) {
  const path = item.path;
  safeRelative(path);
  const nativeFiles = new Set(Object.values(manifest.source?.files ?? {}).map((file) => file?.path).filter(Boolean));
  const nativeSourceManifest = manifest.storage?.engine === 'ingitdb' && path === manifest.dataFile;
  const nativeOriginal = manifest.storage?.engine === 'ingitdb' && nativeFiles.has(path);
  if (!path.startsWith('artifacts/') && !nativeSourceManifest && !nativeOriginal) throw new Error(`${id}: public exports must be provider artifacts or declared native original files: ${path}`);
  const base = path.split('/').pop();
  const checksum = checksums.files?.[path];
  const compression = item.compression ?? checksum?.compression ?? null;
  if (compression != null && compression !== 'gzip') throw new Error(`${id}: unsupported export compression ${compression}`);
  const chunks = compression === 'gzip' && Array.isArray(item.chunks) ? item.chunks : [];
  const encodedPath = compression === 'gzip' ? item.encodedPath : null;
  if (compression === 'gzip') {
    if (encodedPath !== `${path}.gz`) throw new Error(`${id}: gzip export ${path} must name its joined stream as ${path}.gz`);
    safeRelative(encodedPath);
    if (chunks.length === 0 && !checksums.files?.[encodedPath]) throw new Error(`${id}: gzip export ${path} has no checksum for its encoded file`);
  }
  const logicalBase = base;
  const ext = logicalBase.toLowerCase().split('.').pop();
  const common = {
    bytes: item.bytes ?? checksum?.bytes ?? null,
    sha256: item.sha256 ?? checksum?.sha256 ?? null,
    compression,
    decodedBytes: item.decodedBytes ?? checksum?.decodedBytes ?? null,
    decodedSha256: item.decodedSha256 ?? checksum?.decodedSha256 ?? null,
  };
  if (nativeSourceManifest) {
    return { path, encodedPath, publicPath: `metadata/${base}`, assetPath: `metadata/${base}`, chunks: [], format: 'metadata', table: null, ...common, dbWide: true };
  }
  if (nativeOriginal) {
    if (item.format !== 'jsonl' || typeof item.table !== 'string' || !tables.some((table) => table.name === item.table)) throw new Error(`${id}: native original ${path} must identify a real JSONL recordset`);
    return { path, encodedPath, publicPath: `jsonl/${id}.${item.table}.jsonl`, assetPath: `jsonl/${id}.${item.table}.jsonl`, chunks: [], format: 'jsonl', table: item.table, ...common, dbWide: false };
  }

  if (compression === 'gzip' && (!Number.isSafeInteger(common.decodedBytes) || !isHash(common.decodedSha256))) {
    throw new Error(`${id}: gzip export ${path} needs decodedBytes and decodedSha256 checksums`);
  }
  if (compression === 'gzip' && (!Number.isSafeInteger(common.bytes) || common.bytes <= 0 || !isHash(common.sha256))) throw new Error(`${id}: gzip export ${path} needs encoded bytes and sha256`);
  const seenChunkPaths = new Set();
  const normalizedChunks = chunks.map((chunk, index) => {
    safeRelative(chunk.path);
    if (!chunk.path.startsWith('artifacts/') || !Number.isSafeInteger(chunk.bytes) || chunk.bytes <= 0 || chunk.bytes > 25 * 1024 * 1024 || !isHash(chunk.sha256)) {
      throw new Error(`${id}: invalid gzip chunk ${chunk.path}`);
    }
    const expectedPath = `${encodedPath}.part-${String(index + 1).padStart(4, '0')}`;
    if (chunk.path !== expectedPath) throw new Error(`${id}: gzip chunks for ${path} are not in their declared sequence`);
    if (seenChunkPaths.has(chunk.path)) throw new Error(`${id}: gzip chunk paths are duplicated for ${path}`);
    seenChunkPaths.add(chunk.path);
    if (!checksums.files?.[chunk.path]) throw new Error(`${id}: gzip chunk ${chunk.path} has no provider checksum`);
    return { path: chunk.path, bytes: chunk.bytes, sha256: chunk.sha256, assetPath: `${compression === 'gzip' ? `${path.slice('artifacts/'.length)}.gz` : path}.${String(index + 1).padStart(4, '0')}.part` };
  });
  if (normalizedChunks.length && normalizedChunks.reduce((sum, chunk) => sum + chunk.bytes, 0) !== common.bytes) throw new Error(`${id}: gzip chunks do not add up to the declared encoded size for ${path}`);
  if (path.split('/').includes('metadata')) {
    const publicPath = `metadata/${base}`;
    return { path, encodedPath, publicPath, assetPath: compression === 'gzip' && !normalizedChunks.length ? `${publicPath}.gz` : publicPath, chunks: normalizedChunks, format: 'metadata', table: null, ...common, dbWide: true };
  }
  let tableName = typeof item.table === 'string' ? item.table : null;
  let format = item.format ?? null;
  if (tableName && (tableName.includes('/') || tableName.includes('\\') || tableName === '.' || tableName === '..')) throw new Error(`${id}: recordset cannot be represented as a single URL path segment: ${tableName}`);
  if (format && !/^[a-z][a-z0-9-]*$/.test(format)) throw new Error(`${id}: invalid export format ${format}`);
  const databaseWideFilename = [
    `${id}.sqlite`, `${id}.db`, `${id}.sql`, `${id}.json`, `${id}.yaml`, `${id}.yml`,
  ].includes(logicalBase);
  const match = tables.find((table) => tableName ? table.name === tableName : !databaseWideFilename && (
    logicalBase === `${id}.${table.name}.${ext}` || logicalBase === `${table.name}.${ext}`
  ));
  if (!format && match) format = ext === 'sql' && /\/(postgresql|mysql|sqlserver|oracle)\//i.test(path) ? 'sql' : ext;
  if (!match) {
    if (!format) {
      if (base === `${id}.sqlite` || base === `${id}.db`) format = 'sqlite';
      else if (base === `${id}.sql`) format = 'sql';
      else if (base === `${id}.json`) format = 'json';
      else if (base === `${id}.yaml` || base === `${id}.yml`) format = 'yaml';
      else if (new RegExp(`^${id}\\.(postgresql|mysql|sqlserver|oracle)\\.sql$`).test(base)) format = base.split('.')[1];
    }
    if (!format) throw new Error(`${id}: cannot classify export ${path}`);
  }
  const dbWide = !match && !tableName;
  const extension = ext === 'yml' ? 'yaml' : ext;
  let publicPath;
  if (match || tableName) publicPath = `${format}/${id}.${tableName ?? match.name}.${extension}`;
  else if (format === 'sqlite') publicPath = `${id}.sqlite`;
  else if (format === 'ingitdb') publicPath = base;
  else if (format === 'sql' || SQL_SCRIPT_FORMATS.includes(format)) publicPath = format === 'sql' ? `${id}.sql` : `${id}.${format}.sql`;
  else if (dbWide) publicPath = `${id}.${extension}`;
  else publicPath = path.slice('artifacts/'.length);
  const assetPath = compression === 'gzip' && !normalizedChunks.length ? `${publicPath}.gz` : publicPath;
  return { path, encodedPath, publicPath, assetPath, chunks: normalizedChunks, format, table: tableName ?? match?.name ?? null, ...common, dbWide };
}

function buildCorpus(databases) {
  return {
    format: 'demodb-corpus/draft-1',
    generatedAtBuild: true,
    databases: databases.map((db) => ({
      id: db.publicIdentity,
      localId: db.id,
      title: db.name,
      description: db.description,
      sourceVersion: db.source.version ?? db.source.revision ?? db.sourceCommit,
      sourceRevision: db.source.revision ?? db.sourceCommit,
      providerRevision: db.sourceCommit,
      homepage: db.canonicalUrl,
      browserManifestUrl: `${db.publicIdentity}ovdb-database.json`,
      serverManifestUrl: db.publicManifestUrl,
      apiUrl: db.publicApiUrl,
      source: db.source,
      provenance: db.provenance,
      publisher: db.publisher,
      licences: db.licences,
      representationNotes: [
        'Only physical source tables are eligible for browser-local import; native views remain schema metadata.',
        'Tables without a native primary key use ordinals in provider JSON export order for local traversal; the browser snapshot does not claim that this is native source insertion order.',
        'Use the full SQLite export for native storage fidelity, including BLOB bytes; JSON and CSV follow the provider export representation.',
      ],
      capabilities: {
        read: true,
        query: db.ovdb.query === true,
        write: false,
        browserImport: db.tables.filter((table) => table.kind === 'table').every((table) => db.exports.some((file) => file.format === 'json' && file.table === table.name && Boolean(file.sha256))),
      },
      model: db.publicModel,
      meaning: db.publicMeaning,
      schemaUrl: `https://${db.siteHost}/schema.json`,
      schemaSha256: db.schemaSha256,
      recordsets: db.tables.map((table) => ({
        name: table.name,
        kind: table.kind,
        description: table.description,
        rowCount: table.rowCount,
        modelEntity: table.modelEntity ?? null,
        columns: table.columns,
        primaryKey: table.columns.filter((column) => column.primaryKey).sort((a, b) => (a.primaryKeyPosition ?? 0) - (b.primaryKeyPosition ?? 0)).map((column) => column.name),
        ...(table.kind === 'table' ? { uniqueKeys: table.uniqueKeys ?? null, uniqueIndexes: table.uniqueIndexes ?? null } : {}),
        foreignKeys: table.foreignKeys,
        availableRepresentations: db.exports.filter((file) => file.table === table.name).map((file) => ({
          format: file.format,
          url: `https://${db.siteHost}/data/${file.publicPath.split('/').map(encodeURIComponent).join('/')}${file.compression === 'gzip' ? '.parts.json' : ''}`,
          bytes: file.bytes,
          sha256: file.sha256,
          ...(file.compression === 'gzip' ? { compression: file.compression, decodedBytes: file.decodedBytes, decodedSha256: file.decodedSha256, delivery: 'demodb-chunked-export/v1' } : {}),
          note: file.compression === 'gzip' ? 'Published as gzip chunks: url is a demodb-chunked-export/v1 manifest; join the parts in order and gunzip.' : undefined,
        })),
        sampleExportUrl: db.exports.find((file) => file.table === table.name && file.format === 'json')
          ? `https://${db.siteHost}/data/${db.exports.find((file) => file.table === table.name && file.format === 'json').publicPath.split('/').map(encodeURIComponent).join('/')}${db.exports.find((file) => file.table === table.name && file.format === 'json').compression === 'gzip' ? '.parts.json' : ''}`
          : null,
      })),
      sourceViews: db.schema.sourceViews ?? [],
      formatAvailability: db.formatAvailability,
      // A gzip export has no single-file URL: `url` is its demodb-chunked-export/v1 manifest (see scripts/build-hosts.mjs).
      exports: db.exports.filter((file) => !file.table && file.format !== 'metadata').map((file) => ({
        format: file.format,
        url: `https://${db.siteHost}/data/${file.publicPath.split('/').map(encodeURIComponent).join('/')}${file.compression === 'gzip' ? '.parts.json' : ''}`,
        ...(file.compression === 'gzip' ? { delivery: 'demodb-chunked-export/v1' } : {}),
        bytes: file.bytes,
        sha256: file.sha256,
        ...(file.compression === 'gzip' ? { compression: file.compression, decodedBytes: file.decodedBytes, decodedSha256: file.decodedSha256 } : {}),
      })),
    })),
  };
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

function validateDescriptorSchemaProjection(descriptor, nativeRecordsets) {
  const nativeByName = new Map(nativeRecordsets.map((recordset) => [recordset.name, recordset]));
  for (const published of descriptor.recordsets) {
    const native = nativeByName.get(published.name);
    if (!native) throw new Error(`${descriptor.localId}: OVDB recordset ${published.name} is absent from the native schema contract`);
    const columns = native.columns.map((column) => ({
      name: column.name,
      type: column.type,
      nullable: column.nullable,
      primaryKey: column.primaryKey,
      primaryKeyPosition: column.primaryKeyPosition ?? null,
      defaultValue: column.defaultValue ?? null,
      ...(column.decimal ? { decimal: column.decimal } : {}),
    }));
    const expected = {
      modelEntity: native.modelEntity ?? null,
      kind: native.kind,
      description: native.description,
      rowCount: native.rowCount,
      columns,
      primaryKey: native.primaryKey,
      foreignKeys: native.foreignKeys,
    };
    const actual = {
      modelEntity: published.modelEntity ?? null,
      kind: published.kind,
      description: published.description,
      rowCount: published.rowCount,
      columns: published.columns.map((column) => ({
        name: column.name,
        type: column.type,
        nullable: column.nullable,
        primaryKey: column.primaryKey,
        primaryKeyPosition: column.primaryKeyPosition ?? null,
        defaultValue: column.defaultValue ?? null,
        ...(column.decimal ? { decimal: column.decimal } : {}),
      })),
      primaryKey: published.primaryKey,
      foreignKeys: published.foreignKeys,
    };
    const publishedForeignKeyFields = [...new Set(published.foreignKeys.flatMap((foreignKey) => Object.keys(foreignKey)))].sort();
    expected.foreignKeys = expected.foreignKeys.map((foreignKey) => Object.fromEntries(publishedForeignKeyFields.map((field) => [field, foreignKey[field]])));
    actual.foreignKeys = actual.foreignKeys.map((foreignKey) => Object.fromEntries(publishedForeignKeyFields.map((field) => [field, foreignKey[field]])));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${descriptor.localId}: OVDB recordset ${published.name} disagrees with the native schema contract`);
  }
}

function validateDescriptorAssetReferences(descriptor, db) {
  const publicAssetUrl = (path) => `https://${db.siteHost}/model/${encodeURIComponent(path.split('/').pop())}`;
  const expectedModel = publicAssetUrl(db.model.modelspec);
  const expectedMeaning = publicAssetUrl(db.meaning.file);
  if (descriptor.model.url !== expectedModel || descriptor.meaning.url !== expectedMeaning) throw new Error(`${db.id}: model or meaning reference does not match the generated public model assets`);
  if (db.model.hcl) {
    if (descriptor.model.hclUrl !== publicAssetUrl(db.model.hcl)) throw new Error(`${db.id}: HCL reference does not match the generated public model asset`);
  } else if (descriptor.model.hclUrl) {
    throw new Error(`${db.id}: descriptor references an HCL file that the site does not publish`);
  }
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
