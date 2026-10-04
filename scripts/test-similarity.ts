import assert from 'node:assert/strict';
import { databases, databaseById } from '../src/data/db';
import { relatedRecordsets } from '../src/data/similarity';

const pairs = [
  ['chinook', 'Customer', 'northwind', 'Customers'],
  ['chinook', 'Employee', 'northwind', 'Employees'],
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
const chinook = databaseById.get('chinook')!;
const northwind = databaseById.get('northwind')!;
const invoiceConcepts = chinook.semantics.tableConcepts?.Invoice ?? [];
const orderConcepts = northwind.semantics.tableConcepts?.Orders ?? [];
assert.ok(invoiceConcepts.includes('invoice'));
assert.ok(!invoiceConcepts.includes('order'));
assert.ok(orderConcepts.includes('order'));
assert.ok(!orderConcepts.includes('invoice'));
assert.equal(invoiceConcepts.some((concept) => orderConcepts.includes(concept)), false, 'invoices and orders keep distinct meanings');
const invoice = chinook.tables.find((table) => table.name === 'Invoice')!;
assert.equal(relatedRecordsets(chinook, invoice, databases).some((candidate) => candidate.database.id === 'northwind' && candidate.table.name === 'Orders'), false, 'Invoice is not presented as similar to Orders');
const artist = databaseById.get('chinook')!.tables.find((table) => table.name === 'Artist')!;
assert.equal(relatedRecordsets(databaseById.get('chinook')!, artist, databases).length, 0, 'weak matches are suppressed');

console.log('Cross-database similarity is deterministic and derives three strong matches from provider metadata while keeping invoices distinct from orders.');
