import generated from './generated/ovdb.json';
import type { OVDBDatabase, OVDBServer } from './types';

export const ovdbServer = generated.server as unknown as OVDBServer;
export const ovdbDatabases = generated.databases as unknown as OVDBDatabase[];
export const ovdbDatabaseById = new Map(ovdbDatabases.map((database) => [database.localId, database]));
