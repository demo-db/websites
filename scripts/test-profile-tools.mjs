import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const root = new URL('../', import.meta.url);
const { databases } = JSON.parse(await readFile(new URL('src/data/generated/index.json', root), 'utf8'));
for (const db of databases) {
  test(`${db.id}: tools, meanings below tables, and integrity-pinned graph are published`, async () => {
    const dir = new URL(`dist-hosts/${db.siteHost}/`, root);
    const html = await readFile(new URL('index.html', dir), 'utf8');
    assert.match(html, /Tools for your next step/);
    assert.match(html, /CodeGrapher/);
    assert.match(html, /Preview QueryDock/);
    const tools = html.indexOf('id="tools-heading"');
    const tables = html.indexOf('Browse the recordsets.');
    const meanings = html.indexOf('id="meanings-heading"');
    assert.ok(tools > 0 && tables > tools && meanings > tables, 'Meanings must follow the table grid');
    const bytes = await readFile(new URL(db.graph.path, dir));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), db.graph.sha256);
    const graph = JSON.parse(bytes);
    if (['shipping', 'shipping-logs'].includes(db.id)) {
      assert.ok(graph.concepts.some((concept) => concept.kind === 'entity'), 'Shipping profiles must publish meaningful entity lists');
      assert.deepEqual(graph.diagnostics, [], 'Every authored Shipping binding must resolve to its native schema');
      assert.ok(graph.concepts.every((concept) => concept.definitionHref.startsWith(`https://meaninggraph.io/registry/github.com/demo-db/${db.id}/`)));
    }
    if (db.id === 'shipping-logs') {
      const entities = graph.concepts.filter((concept) => concept.kind === 'entity');
      assert.ok(entities.every((concept) => concept.bindings.filter((binding) => binding.role === 'entity').length === 1), 'Each log entity concept must bind one record type');
      assert.deepEqual(entities.map((concept) => concept.bindings.find((binding) => binding.role === 'entity').table).sort(), graph.tables.map((table) => table.name).sort());
      const recovery = entities.filter((concept) => concept.id.includes('recovery'));
      assert.equal(recovery.length, 4);
      assert.ok(recovery.every((concept) => concept.bindings.every((binding) => /recovery/i.test(binding.table))), 'Recovery examples must not be classified as baseline observations');
      const attempt = graph.concepts.find((concept) => concept.id === 'attempt-reference');
      assert.equal(attempt?.valuesOf, `meaning://github.com/demo-db/shipping/shipping-attempt?ref=${databases.find((database) => database.id === 'shipping').sourceCommit}`);
    }
    assert.equal(graph.source.revision, db.sourceCommit);
    assert.equal(graph.tables.length, db.tables.length);
    assert.equal(graph.tables.reduce((n, t) => n + t.foreignKeys.length, 0), db.tables.reduce((n, t) => n + t.foreignKeys.length, 0));
    assert.ok(graph.tables.every((table) => !('rows' in table)), 'Graph must not duplicate row data');
    assert.equal(new URL(db.graph.href).pathname, '/database');
    assert.equal(new URL(db.graph.href).searchParams.get('source'), `${db.canonicalUrl}${db.graph.path}`);
    assert.equal(new URL(db.graph.href).searchParams.get('sha256'), db.graph.sha256);
    const model = await readFile(new URL('model/index.html', dir), 'utf8');
    for (const concept of graph.concepts) {
      assert.ok(model.includes(`id="concept-${concept.id}"`));
      if (concept.kind === 'entity') assert.ok(html.includes(`id="concept-${concept.id}"`));
      assert.ok(concept.bindings.every((binding) => graph.tables.some((table) => table.name === binding.table)));
    }
    const headers = await readFile(new URL('_headers', dir), 'utf8');
    assert.match(headers, /\/model\/\*\n  Access-Control-Allow-Origin: \*/);
  });
}
