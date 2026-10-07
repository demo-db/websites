import generated from './generated/ovdb.json';
import registry from '../../config/databases.json';
import bigQueryHosting from '../../config/bigquery-hosting.json';
import postgresqlApi from '../../config/postgresql-api.json';
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
// IDs remain the stable dataset IDs. PostgreSQL stays pending until all six
// public endpoints and browser reads have been verified.
export function postgresqlStorageEntry(id: string, publicApiVerified: boolean): StorageEntry {
  return {
    id: `${id}-postgresql`, engine: 'PostgreSQL', tags: [id, 'postgresql', 'neon'],
    readiness: publicApiVerified ? 'public-api' : 'hosted-api-pending',
    ...(publicApiVerified ? { apiUrl: `https://cloud.openvaultdb.com/v1/databases/${id}-postgresql` } : {}),
  };
}

export const storageGroups: { database: OVDBDatabase; storages: StorageEntry[] }[] = ovdbDatabases.map((database) => ({
  database,
  storages: [
    { id: `${database.localId}-sqlite`, engine: 'SQLite', tags: [database.localId, 'sqlite'], readiness: 'public-api' },
    postgresqlStorageEntry(database.localId, postgresqlApi.publicApiVerified),
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
export const storageEntryCount = storageGroups.reduce((sum, group) => sum + group.storages.length, 0);
export const storageEngineCount = new Set(storageGroups.flatMap((group) => group.storages.map((storage) => storage.engine))).size;
export const publicOvdbApiCount = storageGroups.reduce((sum, group) => sum + group.storages.filter((storage) => storage.readiness === 'public-api').length, 0);
export const storageById = new Map(storageGroups.flatMap((group) =>
  group.storages.map((storage) => [storage.id, { database: group.database, ...storage }] as const),
));
