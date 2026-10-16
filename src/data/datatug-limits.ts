// Known limits of the local SQLite browser that "Explore SQLite in DataTug" opens.
// Verified against datatug/datatug-apps (libs/datatug/main/src/lib/ovdb and
// demo-sqlite) and dal-go/dalgo-http-adapters (packages/sqlite-wasm/src/schema.ts):
//  - a table opens read-only unless it has exactly one primary-key column
//    (`ovdbRecordActions`: `primaryKey.length !== 1`);
//  - the table list is built from `type = 'table'` rows of the SQLite schema, so views
//    are not listed;
//  - the table browser requests one page of OVDB_PAGE_SIZE rows and has no paging.
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
