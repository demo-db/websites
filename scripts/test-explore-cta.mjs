import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
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

async function* htmlFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* htmlFiles(path);
    else if (entry.name.endsWith('.html')) yield path;
  }
}

test('no built page names Neon while PostgreSQL readiness is hosted-api-pending', async () => {
  // Precondition: every PostgreSQL copy is still pending. If one becomes public,
  // this test must be revisited rather than silently allowing the host name.
  for (const id of ids) {
    const page = await readFile(join(root, 'dist/ovdb/db', `${id}-postgresql`, 'index.html'), 'utf8');
    assert.ok(page.includes('Public OpenVaultDB API access is being prepared'), `${id} PostgreSQL copy is still pending`);
  }
  const offenders = [];
  for await (const file of htmlFiles(join(root, 'dist'))) {
    if (/neon/i.test(await readFile(file, 'utf8'))) offenders.push(file.replace(root, ''));
  }
  assert.deepEqual(offenders, []);
});
