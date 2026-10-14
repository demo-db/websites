import type { StorageEntry } from './ovdb';
import type { Database, OVDBDatabase } from './types';

export type EditionTerm = { term: string; value: string };

const engineLabels: Record<string, string> = { sqlite: 'SQLite', postgresql: 'PostgreSQL' };
const engineLabel = (engine: string) => engineLabels[engine.toLowerCase()] ?? engine;

// Describes only what is published today. The distribution file and the OVDB
// access layer come from generated metadata. A storage entry's copy is shown as
// available only once its readiness reaches public-api, so no hosting claim is
// made for a copy whose access is still pending.
export function editionTerms(database: OVDBDatabase, storage: StorageEntry, source: Database | undefined): EditionTerm[] {
  const sqliteFile = source?.exports.find((file) => file.format === 'sqlite' && file.table === null);
  const recordsets = source?.tables ?? database.recordsets;
  const tables = recordsets.filter((recordset) => recordset.kind === 'table');
  const views = recordsets.filter((recordset) => recordset.kind === 'view');
  const rows = tables.reduce((sum, recordset) => sum + (recordset.rowCount ?? 0), 0);
  const access = storage.readiness === 'public-api'
    ? `Public read-only OVDB API at ${database.apiUrl}.`
    : `The read-only OVDB API at ${database.apiUrl} serves the ${engineLabel(database.deployment.engine)} edition. The ${engineLabel(storage.engine)} copy is not yet available through OVDB.`;
  return [
    {
      term: 'Distribution format',
      value: sqliteFile ? `${engineLabel(sqliteFile.format)} file ${sqliteFile.publicPath.split('/').at(-1)}` : 'Exports listed on the dataset site',
    },
    {
      term: 'Dataset contents',
      value: `${tables.length} tables and ${views.length} views with ${rows.toLocaleString()} rows in total.`,
    },
    { term: 'Access layer (OVDB)', value: access },
  ];
}
