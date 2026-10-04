import type { Database, Recordset } from './types';

export type Similarity = {
  database: Database;
  table: Recordset;
  score: number;
  evidence: string[];
};

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const tokens = (value: string) => new Set(normalize(value).split(/\s+/).filter(Boolean).map(singular));
const singular = (word: string) => word.endsWith('ies') ? `${word.slice(0, -3)}y` : word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;

export function relatedRecordsets(currentDb: Database, current: Recordset, registry: Database[], limit = 3): Similarity[] {
  const concepts = conceptsFor(currentDb, current.name);
  const ranked: Similarity[] = [];
  for (const database of registry) {
    if (database.id === currentDb.id) continue;
    for (const candidate of database.tables.filter((table) => table.kind === current.kind)) {
      const evidence: string[] = [];
      let score = 0;
      const sharedConcepts = concepts.filter((concept) => conceptsFor(database, candidate.name).includes(concept));
      if (sharedConcepts.length) {
        score += 100 * sharedConcepts.length;
        evidence.push(`shared meaning concept: ${sharedConcepts.join(', ')}`);
      }
      const a = tokens(current.name), b = tokens(candidate.name);
      const sharedName = [...a].filter((token) => b.has(token));
      if (sharedName.length) {
        score += sharedName.length === a.size && sharedName.length === b.size ? 35 : 14 * sharedName.length;
        evidence.push(`matching table name: ${sharedName.join(' ')}`);
      }
      const currentColumns = new Set(current.columns.map((column) => normalize(column.name)));
      const commonColumns = candidate.columns.map((column) => normalize(column.name)).filter((name) => currentColumns.has(name));
      if (commonColumns.length >= 2) {
        score += Math.min(20, commonColumns.length * 2);
        evidence.push(`${commonColumns.length} shared column names`);
      }
      const currentKeys = current.columns.filter((column) => column.primaryKey).length;
      const candidateKeys = candidate.columns.filter((column) => column.primaryKey).length;
      if (currentKeys > 0 && currentKeys === candidateKeys && current.foreignKeys.length === candidate.foreignKeys.length) {
        score += 2;
        evidence.push('similar key and relationship counts');
      }
      if (score >= 30) ranked.push({ database, table: candidate, score, evidence });
    }
  }
  return ranked.sort((a, b) => b.score - a.score || a.database.id.localeCompare(b.database.id) || a.table.name.localeCompare(b.table.name)).slice(0, limit);
}

function conceptsFor(database: Database, recordset: string): string[] {
  return database.semantics.tableConcepts?.[recordset] ?? [];
}
