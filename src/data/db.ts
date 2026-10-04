import generated from './generated/index.json';
import type { Database, Recordset } from './types';

export const catalogueHost = generated.catalogueHost;
export const databases = generated.databases as unknown as Database[];
export const databaseById = new Map(databases.map((db) => [db.id, db]));

export function databasePath(db: Database, path = ''): string {
  return `https://${db.siteHost}/${path.replace(/^\//, '')}`;
}

export function recordsetPath(name: string): string {
  return `/tables/${encodeURIComponent(name)}/`;
}

export function recordsetByName(db: Database, name: string): Recordset | undefined {
  return db.tables.find((table) => table.name === name);
}

export function displayCount(value: number | null): string {
  return value == null ? '—' : value.toLocaleString();
}

export function publicDataPath(db: Database, format: string, recordset?: string): string | undefined {
  const candidate = db.exports.find((item) => item.format === format && item.table === (recordset ?? null));
  return candidate ? `/data/${candidate.publicPath}` : undefined;
}

export function downloadFiles(db: Database) {
  return db.exports.filter((item) => item.format !== 'metadata').map((item) => ({
    ...item,
    label: item.table ? `${item.table} · ${item.format.toUpperCase()}` : item.format.toUpperCase(),
    href: `/data/${item.publicPath}`,
  }));
}
