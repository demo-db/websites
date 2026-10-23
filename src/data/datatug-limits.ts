// Known limits of the local SQLite browser that "Explore SQLite in DataTug" opens.
// Verified against datatug/datatug-apps (libs/datatug/main/src/lib/ovdb and
// demo-sqlite) and dal-go/dalgo-http-adapters (packages/sqlite-wasm/src/schema.ts):
//  - a table opens read-only unless it has exactly one primary-key column
//    (`ovdbRecordActions`: `primaryKey.length !== 1`);
//  - the table list is built from `type = 'table'` rows of the SQLite schema, so views
//    are not listed;
//  - the table browser requests one page of OVDB_PAGE_SIZE rows and has no paging.
// "Explore PostgreSQL in DataTug" opens the hosted edition through the public OpenVaultDB
// server (datatug-apps demo-ovdb-page.component.ts, ovdb-database-browser.component.ts):
//  - it is read-only by design: the page offers browsing only, because every control is
//    decided by the descriptor's capabilities, and the page holds no credentials;
//  - it browses with read-only TugQL (the API does not accept the legacy collection-key query);
//  - a table opens with one page of OVDB_PAGE_SIZE (100) rows, noted as "Showing the first 100 rows".
// The counts are computed from each dataset's own generated metadata, so no page names
// a dataset or table by hand.
export const DATATUG_BROWSER_PAGE_SIZE = 100;

export type LimitsSubject = { kind: 'table' | 'view'; name: string; columns: { primaryKey?: boolean }[] };

export type DataTugLocalLimits = {
  tables: number;
  views: number;
  readOnlyTables: string[];
  pageSize: number;
};

export function datatugLocalLimits(recordsets: readonly LimitsSubject[]): DataTugLocalLimits {
  const tables = recordsets.filter((recordset) => recordset.kind === 'table');
  return {
    tables: tables.length,
    views: recordsets.length - tables.length,
    readOnlyTables: tables.filter((table) => table.columns.filter((column) => column.primaryKey).length !== 1).map((table) => table.name),
    pageSize: DATATUG_BROWSER_PAGE_SIZE,
  };
}

export function datatugLocalLimitLines(limits: DataTugLocalLimits): string[] {
  const lines: string[] = [];
  if (limits.readOnlyTables.length > 0) {
    lines.push(`Editing needs exactly one primary-key column. ${limits.readOnlyTables.length} of ${limits.tables} tables here have a composite key or none, so they open read-only: ${limits.readOnlyTables.join(', ')}.`);
  } else {
    lines.push('Editing needs exactly one primary-key column. Every table here has one.');
  }
  lines.push(limits.views > 0
    ? `Views are not listed: the local SQLite browser shows the ${limits.tables} tables only, not the ${limits.views} views. The schema pages on this site list them.`
    : 'Views are not listed in the local SQLite browser; this dataset has none.');
  lines.push(`A table opens with its first ${limits.pageSize} rows. There is no paging yet.`);
  return lines;
}

// What the PostgreSQL path (hosted, read-only) can and cannot do. Free of dataset names,
// so it is the same truth on every page that offers it.
export function datatugPostgresqlLimitLines(pageSize: number = DATATUG_BROWSER_PAGE_SIZE): string[] {
  return [
    'Explore PostgreSQL in DataTug is read-only by design: you can browse tables and records, but nothing can be edited, deleted or reset.',
    'It reads the hosted PostgreSQL copy through the public OpenVaultDB server with read-only TugQL queries, never the database directly.',
    `A table opens with its first ${pageSize} rows. There is no paging yet.`,
    'To change data, use the editable local SQLite copy that Explore SQLite in DataTug opens in your browser.',
  ];
}
