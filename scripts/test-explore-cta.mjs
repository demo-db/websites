import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

const root = new URL('..', import.meta.url).pathname;
const ids = ['chinook', 'northwind', 'pubs', 'sakila', 'adventureworks', 'employees'];
const pages = [
  ...ids.map((id) => ({ id, file: join(root, 'dist/_db', id, 'index.html') })),
  ...ids.map((id) => ({ id, file: join(root, 'dist/ovdb/db', id, 'index.html') })),
];

for (const { id, file } of pages) {
  test(`${file.replace(root, '')} carries the primary SQLite DataTug call to action`, async () => {
    const html = await readFile(file, 'utf8');
    const href = `https://datatug.app/demo/sqlite/${id}`;
    const anchors = [...html.matchAll(/<a\b[^>]*>Explore SQLite in DataTug<\/a>/g)].map((match) => match[0]);
    assert.equal(anchors.length, 1, 'exactly one CTA with the exact text');
    assert.ok(anchors[0].includes(`href="${href}"`), `CTA links to ${href}`);
    assert.ok(anchors[0].includes('button-primary'), 'CTA is the primary button');
    assert.doesNotMatch(anchors[0], /wasm/i, 'CTA text never mentions WASM');
  });
}
