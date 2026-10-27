import { test } from 'node:test';
import assert from 'node:assert/strict';
import { databaseGraph, graphAsset } from './database-graph.mjs';

const db = { id: 'chinook', name: 'Chinook', canonicalUrl: 'https://chinook.demodb.dev/', sourceRepository: 'https://github.com/demo-db/chinook', sourceCommit: 'a'.repeat(40), tables: [{ name: 'Sales.Customer', kind: 'table', description: '', columns: [{ name: 'Id', type: 'int', nullable: false, primaryKey: true }], foreignKeys: [], rows: [{ Id: 42 }] }] };
const model = { module: { name: 'chinook' }, records: { Sales_Customer: { fields: { Id: {} } } } };

test('projects authored model bindings, preserves scope and excludes rows', () => {
  const meaning = { concepts: [{ id: 'customer', kind: 'entity', labels: { en: 'Customer' }, extends: `meaning://github.com/meaninggraph/core/customer?ref=${'b'.repeat(40)}`, bindings: [{ model: 'modelspec:///chinook.Sales_Customer', role: 'entity' }] }, { id: 'unbound', kind: 'entity', bindings: [{ model: 'modelspec:///elsewhere.Invoice', role: 'entity' }] }] };
  const graph = databaseGraph(db, meaning, model);
  assert.equal(graph.concepts.length, 1);
  assert.equal(graph.concepts[0].bindings[0].table, 'Sales.Customer');
  assert.equal(graph.concepts[0].definitionHref, 'https://meaninggraph.io/registry/github.com/demo-db/chinook/entities/customer/');
  assert.equal(graph.diagnostics.length, 1);
  assert.equal('rows' in graph.tables[0], false);
  const asset = graphAsset(graph);
  assert.match(asset.path, new RegExp(asset.sha256));
  assert.equal(new URL(asset.href).searchParams.get('sha256'), asset.sha256);
});

test('never matches a concept by label or publishes unresolved field bindings', () => {
  const graph = databaseGraph(db, { concepts: [{ id: 'Customer', kind: 'entity', bindings: [] }, { id: 'missing', bindings: [{ model: 'modelspec:///chinook.Sales_Customer', property: 'Missing', role: 'identifier' }] }] }, model);
  assert.equal(graph.concepts.length, 0);
  assert.equal(graph.diagnostics.length, 1);
});

test('unregistered graphs link to the exact authored local definition', () => {
  const graph = databaseGraph({ ...db, id: 'unlisted', canonicalUrl: 'https://unlisted.demodb.dev/' }, { concepts: [{ id: 'customer', kind: 'entity', bindings: [{ model: 'modelspec:///chinook.Sales_Customer', role: 'entity' }] }] }, model);
  assert.equal(graph.concepts[0].definitionHref, 'https://unlisted.demodb.dev/model/#concept-customer');
  assert.equal(graph.concepts[0].definitionLabel, 'Authored meaning');
});

for (const id of ['shipping', 'shipping-logs']) test(`${id} links bound concepts to registered MeaningGraph definitions`, () => {
  const graph = databaseGraph({ ...db, id, sourceRepository: `https://github.com/demo-db/${id}` }, { concepts: [{ id: 'observation', kind: 'entity', bindings: [{ model: 'modelspec:///chinook.Sales_Customer', role: 'entity' }] }] }, model);
  assert.equal(graph.concepts[0].definitionHref, `https://meaninggraph.io/registry/github.com/demo-db/${id}/entities/observation/`);
  assert.equal(graph.concepts[0].definitionLabel, 'MeaningGraph definition');
  assert.equal(graph.meaningHref, `https://meaninggraph.io/registry/github.com/demo-db/${id}/`);
});
