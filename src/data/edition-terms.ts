import type { Database, OVDBDatabase } from './types';

export type EditionTerm = { term: string; value: string };

const engineLabels: Record<string, string> = { sqlite: 'SQLite' };
const engineLabel = (engine: string) => engineLabels[engine.toLowerCase()] ?? engine;

// Terms for a PostgreSQL copy. The dataset contents describe the data, so they are
// the same whether access is pending or public; only the access line depends on the
// copy's public OVDB API URL. Neither line makes a hosting claim. The dataset contents
// come from the site metadata, which also lists views.
export function editionTerms(database: OVDBDatabase, source: Database | undefined, postgresqlApiUrl?: string): EditionTerm[] {
  const recordsets = source?.tables ?? database.recordsets;
  const tables = recordsets.filter((recordset) => recordset.kind === 'table');
  const views = recordsets.filter((recordset) => recordset.kind === 'view');
  const rows = tables.reduce((sum, recordset) => sum + (recordset.rowCount ?? 0), 0);
  return [
    {
      term: 'Dataset contents',
      value: `${tables.length} tables and ${views.length} views with ${rows.toLocaleString()} rows in total.`,
    },
    {
      term: 'Access layer (OVDB)',
      value: postgresqlApiUrl
        ? `The read-only OVDB API at ${postgresqlApiUrl} serves the PostgreSQL copy.`
        : `The read-only OVDB API at ${database.apiUrl} serves the ${engineLabel(database.deployment.engine)} edition. The PostgreSQL copy is not yet available through OVDB.`,
    },
  ];
}
