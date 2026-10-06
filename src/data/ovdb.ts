import generated from './generated/ovdb.json';
import registry from '../../config/databases.json';
import type { OVDBDatabase, OVDBServer } from './types';

export const ovdbServer = generated.server as unknown as OVDBServer;
export const ovdbDatabases = generated.databases as unknown as OVDBDatabase[];
export const ovdbDatabaseById = new Map(ovdbDatabases.map((database) => [database.localId, database]));

export type StorageEntry = {
  id: string;
  engine: 'SQLite' | 'PostgreSQL' | 'inGitDB';
  tags: string[];
  readiness: 'public-api' | 'hosted-api-pending' | 'hosted-repository';
  repositoryUrl?: string;
  manifestUrl?: string;
  revision?: string;
};

const inGitDBRevisions: Record<string, string> = registry.ingitdbRevisions;
if (Object.keys(inGitDBRevisions).length !== ovdbDatabases.length
  || ovdbDatabases.some((database) => !/^[a-f0-9]{40}$/.test(inGitDBRevisions[database.localId] ?? ''))) {
  throw new Error('inGitDB revisions must pin every registered dataset exactly once');
}

// Storage IDs identify catalogue entries, while the provider and OVDB manifest
// IDs remain the stable dataset IDs. Only SQLite has a published OVDB API.
export const storageGroups: { database: OVDBDatabase; storages: StorageEntry[] }[] = ovdbDatabases.map((database) => ({
  database,
  storages: [
    { id: `${database.localId}-sqlite`, engine: 'SQLite', tags: [database.localId, 'sqlite'], readiness: 'public-api' },
    { id: `${database.localId}-postgresql`, engine: 'PostgreSQL', tags: [database.localId, 'postgresql', 'neon'], readiness: 'hosted-api-pending' },
    { id: `${database.localId}-ingitdb`, engine: 'inGitDB', tags: [database.localId, 'ingitdb', 'github'], readiness: 'hosted-repository',
      repositoryUrl: `https://github.com/demo-db/${database.localId}/tree/${inGitDBRevisions[database.localId]}/ingitdb`,
      manifestUrl: `https://github.com/demo-db/${database.localId}/blob/${inGitDBRevisions[database.localId]}/ingitdb/export-manifest.json`,
      revision: inGitDBRevisions[database.localId] },
  ],
}));
export const storageEntryCount = storageGroups.reduce((sum, group) => sum + group.storages.length, 0);
export const storageEngineCount = new Set(storageGroups.flatMap((group) => group.storages.map((storage) => storage.engine))).size;
export const publicOvdbApiCount = storageGroups.reduce((sum, group) => sum + group.storages.filter((storage) => storage.readiness === 'public-api').length, 0);
export const storageById = new Map(storageGroups.flatMap((group) =>
  group.storages.map((storage) => [storage.id, { database: group.database, ...storage }] as const),
));
