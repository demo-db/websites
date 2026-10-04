export type Column = {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  primaryKeyPosition?: number | null;
  defaultValue?: string | number | null;
};

export type ForeignKey = {
  column: string;
  table: string;
  referencedColumn: string;
};

export type Recordset = {
  name: string;
  modelEntity?: string;
  kind: 'table' | 'view';
  description: string;
  columns: Column[];
  foreignKeys: ForeignKey[];
  rowCount: number | null;
  rows: Record<string, unknown>[];
  viewSql?: string | null;
};

export type ExportFile = {
  path: string;
  publicPath: string;
  format: string;
  table: string | null;
  bytes: number | null;
  sha256: string | null;
  dbWide: boolean;
};

export type Database = {
  id: string;
  name: string;
  description: string;
  domain: string;
  siteHost: string;
  aliases: string[];
  canonicalUrl: string;
  source: Record<string, unknown>;
  sourceRepository: string;
  sourceCommit: string | null;
  capabilities: Record<string, unknown>;
  semantics: { tableConcepts?: Record<string, string[]> };
  queries: { title: string; description?: string; sql: string }[];
  schema: { contractVersion: number; database: { id: string; name: string }; source: Record<string, unknown>; tables: Recordset[] };
  tables: Recordset[];
  exports: ExportFile[];
  exportByPublicPath: Record<string, ExportFile>;
  model: { modelspec?: string; hcl?: string };
  meaning: { file?: string };
  ovdb: { url: string; deploymentUrl: string; discovery: string; recordsetPage: string | null; connection: string; available: boolean; readOnly: boolean; query: boolean };
};
