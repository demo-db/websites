import type { StorageEntry } from './ovdb';
import type { Database, OVDBDatabase } from './types';

export type EditionTerm = { term: string; value: string };

const engineLabels: Record<string, string> = { sqlite: 'SQLite', postgresql: 'PostgreSQL' };
const engineLabel = (engine: string) => engineLabels[engine.toLowerCase()] ?? engine;

// Separates what is distributed, where the copy runs, and how OVDB exposes it.
// Every value comes from the dataset's generated metadata or its storage entry.
// The site metadata is preferred for contents because it also lists views.
export function editionTerms(database: OVDBDatabase, storage: StorageEntry, source: Database | undefined): EditionTerm[] {
  const sqliteFile = source?.exports.find((file) => file.format === 'sqlite' && file.table === null);
  const recordsets = source?.tables ?? database.recordsets;
  const tables = recordsets.filter((recordset) => recordset.kind === 'table');
  const views = recordsets.filter((recordset) => recordset.kind === 'view');
  const rows = tables.reduce((sum, recordset) => sum + (recordset.rowCount ?? 0), 0);
  const access = storage.readiness === 'public-api'
    ? `Public read-only OVDB API at ${database.apiUrl}.`
    : `The read-only OVDB API at ${database.apiUrl} serves the ${engineLabel(database.deployment.engine)} edition. This ${storage.engine} copy has no public OVDB endpoint yet.`;
  return [
    {
      term: 'Distribution format',
      value: sqliteFile ? `${engineLabel(sqliteFile.format)} file ${sqliteFile.publicPath.split('/').at(-1)}` : 'Exports listed on the dataset site',
    },
    {
      term: 'Dataset contents',
      value: `${tables.length} tables and ${views.length} views with ${rows.toLocaleString()} rows in total.`,
    },
    {
      term: 'Runtime and storage',
      value: `${storage.engine}${storage.host ? `, hosted on ${storage.host}` : ''}.`,
    },
    { term: 'Access layer (OVDB)', value: access },
  ];
}
