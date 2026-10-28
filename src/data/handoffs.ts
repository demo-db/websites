import type { Database, MeaningConcept, Recordset } from './types';
import { publicDataPath, recordsetPath } from './db';

export type TableAction = { product: 'datatug' | 'codegrapher' | 'meaninggraph'; label: string; href: string; detail: string };

export function tableActions(db: Database, table: Recordset): TableAction[] {
  if (!db.tables.some((candidate) => candidate.name === table.name)) return [];
  const back = new URL(recordsetPath(table.name), db.canonicalUrl).href;
  const actions: TableAction[] = [];
  if (table.kind === 'table' && publicDataPath(db, 'sqlite')) {
    const href = new URL(`https://datatug.app/demo/sqlite/${encodeURIComponent(db.id)}/table/${encodeURIComponent(table.name)}`);
    href.searchParams.set('returnTo', back);
    const fixture = db.exports.find((file) => file.format === 'sqlite' && !file.table);
    const checksum = fixture?.decodedSha256 ?? fixture?.sha256;
    if (checksum) href.searchParams.set('sourceSha256', checksum);
    if (db.sourceCommit) href.searchParams.set('sourceRevision', db.sourceCommit);
    actions.push({ product: 'datatug', label: 'Browse in DataTug', href: href.href, detail: 'Editable SQLite copy in your browser' });
  }
  if (db.id === 'shipping-logs' && ['baseline','carrierGateway'].includes(table.name)) {
    const href = new URL('https://datatug.app/demo/logs');
    href.searchParams.set('source', 'shipping-logs'); href.searchParams.set('collection', table.name); href.searchParams.set('returnTo', back);
    if (db.sourceCommit) href.searchParams.set('sourceRevision', db.sourceCommit);
    actions.push({ product: 'datatug', label: 'Browse in DataTug', href: href.href, detail: 'Declared live read-only log collection' });
  }
  const graph = new URL(db.graph.href);
  graph.searchParams.set('node', `table:${table.name}`);
  graph.searchParams.set('focus', '1');
  graph.searchParams.set('returnTo', back);
  actions.push({ product: 'codegrapher', label: 'View in CodeGrapher', href: graph.href, detail: 'This table, nearby relationships and linked meanings' });
  const entity = meaningsFor(db, table.name).find((concept) => concept.kind === 'entity' && concept.bindings.some((binding) => binding.table === table.name && binding.role === 'entity'));
  if (entity) actions.push({ product: 'meaninggraph', label: 'Meaning', href: entity.definitionHref, detail: entity.label });
  return actions;
}

export function meaningsFor(db: Database, table: string, column?: string): MeaningConcept[] {
  return db.graph.concepts.filter((concept) => concept.bindings.some((binding) => binding.table === table && (column === undefined || binding.column === column)));
}

export function quoteIdentifier(name: string): string { return `"${name.replaceAll('"', '""')}"`; }
export function tableSelect(table: Recordset): string { return `SELECT *\nFROM ${quoteIdentifier(table.name)}\nLIMIT 20;`; }

export function foreignKeyGroups(table: Recordset) {
  const groups = new Map<string, Recordset['foreignKeys']>();
  for (const key of table.foreignKeys) {
    if (key.constraint === undefined && table.foreignKeys.filter((candidate) => candidate.table === key.table).length > 1) continue;
    const id = `${key.table}:${key.constraint ?? key.column}`;
    groups.set(id, [...(groups.get(id) ?? []), key]);
  }
  return [...groups.values()].map((keys) => keys.sort((a, b) => (a.position ?? 0) - (b.position ?? 0)));
}

export function joinExamples(db: Database, table: Recordset): { title: string; sql: string; target: Recordset }[] {
  return foreignKeyGroups(table).flatMap((keys) => {
    const target = db.tables.find((candidate) => candidate.name === keys[0].table);
    if (!target) return [];
    const conditions = keys.map((key) => `source.${quoteIdentifier(key.column)} = related.${quoteIdentifier(key.referencedColumn)}`).join('\n  AND ');
    return [{ title: `${table.name} with ${target.name}`, target, sql: `SELECT source.*, related.*\nFROM ${quoteIdentifier(table.name)} AS source\nJOIN ${quoteIdentifier(target.name)} AS related\n  ON ${conditions}\nLIMIT 20;` }];
  });
}

export function humanBytes(bytes: number | null): string {
  if (bytes === null) return 'Size unavailable';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024, index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
  return `${value.toLocaleString('en', { maximumFractionDigits: 1 })} ${units[index]}`;
}
