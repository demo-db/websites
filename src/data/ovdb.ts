import generated from './generated/ovdb.json';
import registry from '../../config/databases.json';
import bigQueryHosting from '../../config/bigquery-hosting.json';
import postgresqlApi from './generated/postgresql-api.json';
import type { OVDBDatabase, OVDBServer } from './types';

export { bigQueryHosting };

export const ovdbServer = generated.server as unknown as OVDBServer;
export const ovdbDatabases = generated.databases as unknown as OVDBDatabase[];
export const ovdbDatabaseById = new Map(ovdbDatabases.map((database) => [database.localId, database]));

export type StorageEntry = {
  id: string;
  engine: 'SQLite' | 'PostgreSQL' | 'inGitDB' | 'BigQuery';
  tags: string[];
  readiness: 'public-api' | 'hosted-api-pending' | 'hosted-repository' | 'public-read-user-project-required';
  apiUrl?: string;
  repositoryUrl?: string;
  manifestUrl?: string;
  revision?: string;
  sourceProjectId?: string;
  datasetId?: string;
  location?: string;
  executionProject?: 'user-selected';
  tableCount?: number;
  rowCount?: number;
  sourceRepository?: string;
  sourceRevision?: string;
  sourceSqliteSha256?: string;
  verificationUrl?: string;
};

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
if (Object.keys(inGitDBRevisions).length !== ovdbDatabases.length
  || ovdbDatabases.some((database) => !/^[a-f0-9]{40}$/.test(inGitDBRevisions[database.localId] ?? ''))) {
  throw new Error('inGitDB revisions must pin every registered dataset exactly once');
}

const bigQueryEditions = bigQueryHosting.datasets;
if (bigQueryHosting.format !== 'demodb-bigquery-hosting/v1'
  || bigQueryHosting.projectId !== 'demodb-dev'
  || bigQueryHosting.location !== 'US'
  || bigQueryEditions.length !== ovdbDatabases.length
  || bigQueryEditions.some((edition) => !ovdbDatabaseById.has(edition.id)
    || edition.datasetId !== edition.id
    || edition.verified !== true
    || !/^[a-f0-9]{64}$/.test(edition.sourceSqliteSha256)
    || !/^[a-f0-9]{40}$/.test(edition.sourceRevision)
    || !Number.isSafeInteger(edition.tableCount)
    || !Number.isSafeInteger(edition.rowCount))) {
  throw new Error('BigQuery hosted editions must verify every registered DemoDB dataset');
}
if (new Set(bigQueryEditions.map((edition) => edition.id)).size !== ovdbDatabases.length) {
  throw new Error('BigQuery hosted editions must identify every registered dataset exactly once');
}

// Storage IDs identify catalogue entries, while the provider and OVDB manifest
// IDs remain the stable dataset IDs. Only SQLite is public unless the PostgreSQL
// flag is verified; the verified copy is served from the cloud OpenVaultDB API.
export function postgresqlStorageEntry(id: string, publicApiVerified: boolean): StorageEntry {
  return {
    id: `${id}-postgresql`,
    engine: 'PostgreSQL',
    tags: publicApiVerified ? [id, 'postgresql', 'neon'] : [id, 'postgresql'],
    readiness: publicApiVerified ? 'public-api' : 'hosted-api-pending',
    ...(publicApiVerified ? { apiUrl: `https://cloud.openvaultdb.com/v1/databases/${id}-postgresql` } : {}),
  };
}

export const storageGroups: { database: OVDBDatabase; storages: StorageEntry[] }[] = ovdbDatabases.map((database) => ({
  database,
  storages: [
    { id: `${database.localId}-sqlite`, engine: 'SQLite', tags: [database.localId, 'sqlite'], readiness: 'public-api' },
    postgresqlStorageEntry(database.localId, postgresqlPublicApiVerified),
    { id: `${database.localId}-ingitdb`, engine: 'inGitDB', tags: [database.localId, 'ingitdb', 'github'], readiness: 'hosted-repository',
      repositoryUrl: `https://github.com/demo-db/${database.localId}/tree/${inGitDBRevisions[database.localId]}/ingitdb`,
      manifestUrl: `https://github.com/demo-db/${database.localId}/blob/${inGitDBRevisions[database.localId]}/ingitdb/export-manifest.json`,
      revision: inGitDBRevisions[database.localId] },
    { id: `${database.localId}-bigquery`, engine: 'BigQuery', tags: [database.localId, 'bigquery', 'google-cloud'], readiness: 'public-read-user-project-required',
      sourceProjectId: bigQueryHosting.projectId,
      datasetId: bigQueryEditions.find((edition) => edition.id === database.localId)!.datasetId,
      location: bigQueryHosting.location,
      executionProject: 'user-selected',
      tableCount: bigQueryEditions.find((edition) => edition.id === database.localId)!.tableCount,
      rowCount: bigQueryEditions.find((edition) => edition.id === database.localId)!.rowCount,
      sourceRepository: bigQueryEditions.find((edition) => edition.id === database.localId)!.sourceRepository,
      sourceRevision: bigQueryEditions.find((edition) => edition.id === database.localId)!.sourceRevision,
      sourceSqliteSha256: bigQueryEditions.find((edition) => edition.id === database.localId)!.sourceSqliteSha256,
      verificationUrl: 'https://github.com/demo-db/websites/blob/main/config/bigquery-hosting.json' },
  ],
}));
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
