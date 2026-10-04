import assert from 'node:assert/strict';
import { databases, databaseById } from '../src/data/db';
import { relatedRecordsets } from '../src/data/similarity';

const pairs = [
  ['chinook', 'Customer', 'northwind', 'Customers'],
  ['chinook', 'Employee', 'northwind', 'Employees'],
  ['chinook', 'Invoice', 'northwind', 'Orders'],
  ['chinook', 'InvoiceLine', 'northwind', 'Order Details'],
] as const;
for (const [leftId, leftName, rightId, rightName] of pairs) {
  const leftDb = databaseById.get(leftId)!;
  const left = leftDb.tables.find((table) => table.name === leftName)!;
  const match = relatedRecordsets(leftDb, left, databases).find((candidate) => candidate.database.id === rightId && candidate.table.name === rightName);
  assert.ok(match, `${leftId}.${leftName} matches ${rightId}.${rightName}`);
  assert.ok(match.evidence.some((item) => item.startsWith('shared meaning concept:')), `${leftName} match is explainable by provider semantic metadata`);
  assert.ok(match.score >= 100);
}
const artist = databaseById.get('chinook')!.tables.find((table) => table.name === 'Artist')!;
assert.equal(relatedRecordsets(databaseById.get('chinook')!, artist, databases).length, 0, 'weak matches are suppressed');

console.log('Cross-database similarity is deterministic and derives the four seeded matches from provider metadata.');
