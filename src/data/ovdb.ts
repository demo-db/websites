import { hasCallableReadOnlyApi, inGitDBStorageEntry } from './storage-entry';
import type { StorageEntry } from './storage-entry';
export type { StorageEntry } from './storage-entry';
import generated from './generated/ovdb.json';
import registry from '../../config/databases.json';
import bigQueryHosting from '../../config/bigquery-hosting.json';
import postgresqlApi from './generated/postgresql-api.json';
import generatedIndex from './generated/index.json';
import type { OVDBDatabase, OVDBServer } from './types';

export { bigQueryHosting };

export const ovdbServer = generated.server as unknown as OVDBServer;
export const ovdbDatabases = generated.databases as unknown as OVDBDatabase[];
export const ovdbDatabaseById = new Map(ovdbDatabases.map((database) => [database.localId, database]));
export const ovdbDeploymentVerified = new Map(generatedIndex.databases.map((database) => [
  database.id, database.ovdb?.deploymentVerified === true,
]));



// PostgreSQL copies are public only when config/postgresql-api.json says so (copied to
// generated/ by prepare:databases, or taken from DEMODB_POSTGRESQL_API_CONFIG in CI). The
// flag is validated here and passed to postgresqlStorageEntry, so both states are
// testable without editing the committed config.
if (postgresqlApi.format !== 'demodb-postgresql-api/v1' || typeof postgresqlApi.publicApiVerified !== 'boolean') {
  throw new Error('The PostgreSQL API config must declare demodb-postgresql-api/v1 with a boolean publicApiVerified');
}
export const postgresqlPublicApiVerified: boolean = postgresqlApi.publicApiVerified;
// Which config produced this build (written by prepare:databases). Only the committed
// config/postgresql-api.json may be deployed; see scripts/assert-deployable-build.mjs.
export type PostgresqlApiProvenance = { source: string; sha256: string; default: boolean };
const provenance = (postgresqlApi as { provenance?: Partial<PostgresqlApiProvenance> }).provenance;
if (!provenance || typeof provenance.source !== 'string' || !/^[a-f0-9]{64}$/.test(provenance.sha256 ?? '') || typeof provenance.default !== 'boolean') {
  throw new Error('The generated PostgreSQL API config must record its provenance (source, sha256, default); run prepare:databases');
}
export const postgresqlApiProvenance: PostgresqlApiProvenance = provenance as PostgresqlApiProvenance;

const inGitDBRevisions: Record<string, string> = registry.ingitdbRevisions;
if (Object.entries(inGitDBRevisions).some(([id, revision]) => !ovdbDatabaseById.has(id) || !/^[a-f0-9]{40}$/.test(revision))) {
  throw new Error('inGitDB revisions must identify registered datasets with immutable revisions');
}

const bigQueryEditions = bigQueryHosting.datasets;
if (bigQueryHosting.format !== 'demodb-bigquery-hosting/v1'
  || bigQueryHosting.projectId !== 'demodb-dev'
  || bigQueryHosting.location !== 'US'
  || bigQueryEditions.some((edition) => !ovdbDatabaseById.has(edition.id)
    || edition.datasetId !== edition.id
    || edition.verified !== true
    || !/^[a-f0-9]{64}$/.test(edition.sourceSqliteSha256)
    || !/^[a-f0-9]{40}$/.test(edition.sourceRevision)
    || !Number.isSafeInteger(edition.tableCount)
    || !Number.isSafeInteger(edition.rowCount))) {
  throw new Error('BigQuery hosted editions must be immutable verified registered DemoDB datasets');
}
if (new Set(bigQueryEditions.map((edition) => edition.id)).size !== bigQueryEditions.length) {
  throw new Error('BigQuery hosted editions must identify each hosted dataset exactly once');
}

export function postgresqlStorageEntry(id: string, publicApiVerified: boolean): StorageEntry {
  return {
    id: `${id}-postgresql`,
    engine: 'PostgreSQL',
    tags: publicApiVerified ? [id, 'postgresql', 'neon'] : [id, 'postgresql'],
    readiness: publicApiVerified ? 'public-api' : 'hosted-api-pending',
    ...(publicApiVerified ? { apiUrl: `https://cloud.openvaultdb.com/v1/databases/${id}-postgresql` } : {}),
  };
}

const websiteById = new Map(generatedIndex.databases.map((database) => [database.id, database]));
export const storageGroups: { database: OVDBDatabase; storages: StorageEntry[] }[] = ovdbDatabases.map((database) => {
  const website = websiteById.get(database.localId);
  if (!website) throw new Error(`${database.localId}: generated website database is missing`);
  const available = new Set(website.formatAvailability.filter((item) => item.state === 'download').map((item) => item.format));
  const storages: StorageEntry[] = [];
  // Preparation admits the established providers as well as explicit new deployment receipts.
  // Use its normalized gate, matching descriptors and profile pages.
  if (available.has('sqlite')) storages.push({
    id: `${database.localId}-sqlite`, engine: 'SQLite', tags: [database.localId, 'sqlite'],
    readiness: hasCallableReadOnlyApi(website.ovdb) ? 'public-api' : 'hosted-api-pending',
  });
  if (available.has('postgresql')) storages.push(postgresqlStorageEntry(database.localId, postgresqlPublicApiVerified));
  if (available.has('ingitdb')) {
    const nativeOriginal = 'preview' in website.schema && website.schema.preview === 'native-api-only';
    const revision = nativeOriginal ? website.sourceCommit : inGitDBRevisions[database.localId];
    if (!revision || !/^[a-f0-9]{40}$/.test(revision)) throw new Error(`${database.localId}: published inGitDB storage needs an immutable repository revision`);
    const sourceManifest = website.exports.find((file) => file.format === 'metadata' && file.table === null);
    if (nativeOriginal && !sourceManifest) throw new Error(`${database.localId}: native original source manifest missing`);
    const manifestPath = nativeOriginal ? sourceManifest!.path : 'ingitdb/export-manifest.json';
    const manifestUrl = `https://github.com/demo-db/${database.localId}/blob/${revision}/${manifestPath.split('/').map(encodeURIComponent).join('/')}`;
    storages.push(inGitDBStorageEntry(database.localId, revision, nativeOriginal, website.ovdb, database.apiUrl, manifestUrl));
  }
  const edition = bigQueryEditions.find((candidate) => candidate.id === database.localId);
  if (edition) storages.push({
    id: `${database.localId}-bigquery`, engine: 'BigQuery', tags: [database.localId, 'bigquery', 'google-cloud'], readiness: 'public-read-user-project-required',
    sourceProjectId: bigQueryHosting.projectId, datasetId: edition.datasetId, location: bigQueryHosting.location, executionProject: 'user-selected',
    tableCount: edition.tableCount, rowCount: edition.rowCount, sourceRepository: edition.sourceRepository, sourceRevision: edition.sourceRevision,
    sourceSqliteSha256: edition.sourceSqliteSha256, verificationUrl: 'https://github.com/demo-db/websites/blob/main/config/bigquery-hosting.json',
  });
  if (!storages.length) throw new Error(`${database.localId}: no published storage edition`);
  return { database, storages };
});
// The hosted PostgreSQL edition DataTug can open for a dataset, or null. Offered only
// when config/postgresql-api.json is verified AND the dataset's PostgreSQL storage
// entry is publicly served; the id is that entry's own id.
export function postgresqlDataTugEditionId(localId: string): string | null {
  const entry = storageGroups.find((group) => group.database.localId === localId)?.storages
    .find((storage) => storage.engine === 'PostgreSQL');
  return postgresqlPublicApiVerified && entry?.readiness === 'public-api' ? entry.id : null;
}
export const storageEntryCount = storageGroups.reduce((sum, group) => sum + group.storages.length, 0);
export const storageEngineCount = new Set(storageGroups.flatMap((group) => group.storages.map((storage) => storage.engine))).size;
export const publicOvdbApiCount = storageGroups.reduce((sum, group) => sum + group.storages.filter((storage) => storage.readiness === 'public-api').length, 0);
export const storageById = new Map(storageGroups.flatMap((group) =>
  group.storages.map((storage) => [storage.id, { database: group.database, ...storage }] as const),
));
