import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

const postgresqlApi = JSON.parse(await readFile(join(new URL('..', import.meta.url).pathname, 'src/data/generated/postgresql-api.json'), 'utf8'));

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

const neonPages = (file) => file.startsWith('/dist/ovdb/db/') && file.endsWith('-postgresql/index.html') || file === '/dist/ovdb/index.html' || file.startsWith('/dist/_db/') && file.endsWith('-postgresql/index.html');

// Pending: no built page names Neon. Verified: only the PostgreSQL storage pages and the
// catalogue may, and only when the selected config's `copies` text backs the hosting claim.
test(postgresqlApi.publicApiVerified ? 'Neon is named only on verified PostgreSQL pages, backed by the config' : 'no built page names Neon while PostgreSQL readiness is hosted-api-pending', async () => {
  for (const id of ids) {
    const page = await readFile(join(root, 'dist/ovdb/db', `${id}-postgresql`, 'index.html'), 'utf8');
    assert.equal(page.includes('Public OpenVaultDB API access is being prepared'), !postgresqlApi.publicApiVerified, `${id} PostgreSQL readiness matches the selected config`);
  }
  const offenders = [];
  for await (const file of htmlFiles(join(root, 'dist'))) {
    const relative = file.replace(root, '/');
    if (/neon/i.test(await readFile(file, 'utf8')) && !(postgresqlApi.publicApiVerified && neonPages(relative.replace('//', '/')))) offenders.push(relative);
  }
  assert.deepEqual(offenders, []);
  if (postgresqlApi.publicApiVerified) assert.match(postgresqlApi.copies, /Neon/, 'a Neon claim needs the verified config to say so');
});
