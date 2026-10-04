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
  assetPath: string;
  format: string;
  table: string | null;
  bytes: number | null;
  sha256: string | null;
  dbWide: boolean;
  compression?: 'gzip' | null;
  decodedBytes?: number | null;
  decodedSha256?: string | null;
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
  schemaSha256: string;
  tables: Recordset[];
  exports: ExportFile[];
  exportByPublicPath: Record<string, ExportFile>;
  model: { modelspec?: string; hcl?: string };
  meaning: { file?: string };
  ovdb: { url: string; deploymentUrl: string; discovery: string; recordsetPage: string | null; connection: string; available: boolean; readOnly: boolean; query: boolean };
};

export type OVDBColumn = Pick<Column, 'name' | 'type' | 'nullable' | 'primaryKey' | 'primaryKeyPosition' | 'defaultValue'>;
export type OVDBRecordset = {
  name: string;
  modelEntity?: string;
  kind: 'table' | 'view';
  description: string;
  rowCount: number | null;
  columns: OVDBColumn[];
  primaryKey: { column: string; position: number }[];
  foreignKeys: { column: string; table: string; referencedColumn: string; constraint: number; position: number }[];
};
export type OVDBReference = { id: string; url: string; hclUrl?: string };
export type OVDBDatabase = {
  format: 'ovdb-database/draft-1';
  id: string;
  localId: string;
  serverId: string;
  serverDbBaseUrl: string;
  title: string;
  description: string;
  homepage: string;
  apiUrl: string;
  capabilities: { read: true; query: boolean; write: false };
  deployment: { engine: string; url: string; discovery: string };
  model: OVDBReference;
  meaning: OVDBReference;
  publisher: { name: string; url: string; repository: string };
  provenance: { repository: string; revision: string; path: string; sha256: string; license: string; notes: string };
  licences: { data: string; model: string; meaning: string };
  schemaUrl?: string;
  recordsets: OVDBRecordset[];
};
export type OVDBServer = {
  format: 'ovdb-server/draft-1';
  id: string;
  title: string;
  description: string;
  homepage: string;
  apiUrl: string;
  databases: { id: string; localId: string; serverDbBaseUrl: string; manifestUrl: string; apiUrl: string }[];
};
