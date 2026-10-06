import generated from './generated/ovdb.json';
import type { OVDBDatabase, OVDBServer } from './types';

export const ovdbServer = generated.server as unknown as OVDBServer;
export const ovdbDatabases = generated.databases as unknown as OVDBDatabase[];
export const ovdbDatabaseById = new Map(ovdbDatabases.map((database) => [database.localId, database]));

// Storage IDs identify catalogue entries, while the provider and OVDB manifest
// IDs remain the stable dataset IDs. Only SQLite has a published OVDB API.
export const storageGroups = ovdbDatabases.map((database) => ({
  database,
  storages: [
    { id: `${database.localId}-sqlite`, engine: 'SQLite', tags: [database.localId, 'sqlite'], readiness: 'public-api' as const },
    { id: `${database.localId}-postgresql`, engine: 'PostgreSQL', tags: [database.localId, 'postgresql', 'neon'], readiness: 'hosted-api-pending' as const },
  ],
}));
export const storageById = new Map(storageGroups.flatMap((group) =>
  group.storages.map((storage) => [storage.id, { database: group.database, ...storage }] as const),
));
