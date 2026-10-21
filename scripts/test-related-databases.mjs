import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { projectRelatedDatabases } from './related-databases.mjs';

const config = JSON.parse(await readFile(new URL('../config/related-databases.json', import.meta.url), 'utf8'));
const generated = JSON.parse(await readFile(new URL('../src/data/generated/index.json', import.meta.url), 'utf8')).databases;

test('declared related fields project reciprocally', () => {
  const projected = projectRelatedDatabases(config, generated);
  assert.deepEqual(projected.get('northwind').map((item) => [item.databaseId, item.local, item.remote]), [
    ['shipping', { recordset: 'Orders', field: 'OrderID' }, { recordset: 'requests', field: 'order_id' }],
  ]);
  assert.deepEqual(projected.get('shipping').map((item) => item.databaseId), ['northwind', 'shipping-logs']);
  assert.deepEqual(projected.get('shipping-logs').map((item) => [item.databaseId, item.local, item.remote]), [
    ['shipping', { recordset: 'baseline', field: 'event_id' }, { recordset: 'events', field: 'event_id' }],
  ]);
});

test('unknown, self and duplicate relationships fail closed', () => {
  const clone = () => structuredClone(config);
  const unknown = clone(); unknown.relationships[0].endpoints[1].database = 'missing';
  assert.throws(() => projectRelatedDatabases(unknown, generated), /unknown database missing/);
  const self = clone(); self.relationships[0].endpoints[1].database = 'northwind';
  assert.throws(() => projectRelatedDatabases(self, generated), /self relationships are not allowed/);
  const duplicate = clone(); duplicate.relationships.push(structuredClone(duplicate.relationships[0]));
  duplicate.relationships[2].id = 'duplicate-pair';
  assert.throws(() => projectRelatedDatabases(duplicate, generated), /duplicate endpoint pair/);
});

test('built pages render reciprocal related database evidence without join claims', async () => {
  for (const [id, names] of [['northwind', ['Shipping']], ['shipping', ['Northwind', 'Shipping original logs']], ['shipping-logs', ['Shipping']]]) {
    const page = await readFile(new URL(`../dist/_db/${id}/index.html`, import.meta.url), 'utf8');
    assert.match(page, /Related databases/);
    assert.match(page, /do not create foreign keys, automatic joins, or federation/);
    for (const name of names) assert.ok(page.includes(name), `${id} links ${name}`);
  }
});
