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

// The label of a complete-database download. The matrix names its formats; `sql` is the SQLite-dialect dump
// every provider ships, which is not PostgreSQL, MySQL or SQL Server SQL and says so.
export function downloadLabel(db: Database, format: string): string {
  if (format === 'sql') return 'SQL (SQLite dialect)';
  return db.formatAvailability.find((item) => item.format === format)?.label ?? format.toUpperCase();
}

// Complete-database downloads in the matrix's format order, the SQLite-dialect dump after the matrix formats.
export function completeDownloads(db: Database) {
  const order = [...db.formatAvailability.map((item) => item.format), 'sql'];
  const rank = (format: string) => (order.includes(format) ? order.indexOf(format) : order.length);
  return db.exports.filter((item) => !item.table && item.format !== 'metadata').sort((a, b) => rank(a.format) - rank(b.format));
}

export function unavailableFormats(db: Database) {
  return db.formatAvailability.filter((item) => item.state === 'unavailable');
}

export function downloadFiles(db: Database) {
  return db.exports.filter((item) => item.format !== 'metadata').map((item) => ({
    ...item,
    label: item.table ? `${item.table} · ${item.format.toUpperCase()}` : item.format.toUpperCase(),
    href: `/data/${item.publicPath}`,
  }));
}

// Every download, including the files DemoDB generates from the pinned fixture, is a copy of the dataset's data and carries its licence.
export function licenceNotice(db: Database): string {
  const licence = String((db as unknown as { licences?: { data?: string } }).licences?.data ?? db.source.license ?? 'the dataset licence');
  const origin = String(db.source.repository ?? db.sourceRepository);
  const shareAlike = /-SA-/i.test(licence) ? ' Files derived from it, in any format, must be shared under the same licence.' : '';
  return `Every file here, including the JSON, YAML, PostgreSQL script and inGitDB archive that DemoDB generates from the pinned fixture, contains ${db.name} data from ${origin} and is licensed ${licence}.${shareAlike} Keep the licence and attribution notices with any copy.`;
}
