// Dataset contract of the built site, for EVERY dataset in config/databases.json (a new registry entry is
// covered with no edit here):
//  - the primary action of each dataset page is "Explore SQLite in DataTug": first in the hero, the only primary
//    button, no "WASM" in its wording, linking to DataTug's /demo/sqlite/<dataset> route;
//  - the secondary actions and the download lists name only files that really are in the dataset's registry
//    entry (config pin -> provider contract -> generated index) and exist in the built asset set;
//  - the DataTug catalog (datatug-apps libs/.../demo-sqlite-catalog.ts) lists the same datasets with the same
//    SQLite URL, SHA-256 and size as this registry. A mismatch fails and names the dataset and the field.
//
// Needs the built site (`pnpm build`). The DataTug catalog is read from DATATUG_SQLITE_CATALOG (a file path)
// or, by default, from datatug-apps main on GitHub. Locally an unreadable catalog skips that one test; with CI set
// (any value) a fetch, read, parse or import failure FAILS it, so the drift check can never be silently off in CI.
//
// Merge order: the catalog is read from datatug-apps main on purpose, so a change to the DataTug catalog
// (a new dataset, a new pin) must merge in datatug-apps BEFORE the matching registry change in this repository,
// and a registry change that is not yet in the catalog fails here until it is. Set DATATUG_SQLITE_CATALOG to a
// local copy to check both sides before either merges.
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';

const root = new URL('..', import.meta.url).pathname;
const config = JSON.parse(await readFile(join(root, 'config/databases.json'), 'utf8'));
const generated = JSON.parse(await readFile(join(root, 'src/data/generated/index.json'), 'utf8')).databases;
const ids = config.databases.map((entry) => entry.id);
const CTA = 'Explore SQLite in DataTug';
const CATALOG_URL = 'https://raw.githubusercontent.com/datatug/datatug-apps/main/libs/datatug/main/src/lib/queries/demo-sqlite-catalog.ts';

const exists = (path) => access(path).then(() => true, () => false);
const providerOf = (id) => generated.find((database) => database.id === id);
// The label a download carries: the matrix's name for its format, or an explicit one for the SQLite-dialect dump.
const labelOf = (database, format) => (format === 'sql' ? 'SQL (SQLite dialect)' : database.formatAvailability.find((item) => item.format === format)?.label);
const completeDownloads = (database) => database.exports.filter((file) => !file.table && file.format !== 'metadata');
const decodedSha = (file) => file.decodedSha256 ?? file.sha256;
const decodedBytes = (file) => file.decodedBytes ?? file.bytes;

function heroActions(html) {
  const block = /<div class="hero-actions">(.*?)<\/div>/s.exec(html)?.[1];
  assert.ok(block, 'the page has a hero-actions block');
  return [...block.matchAll(/<a\b([^>]*)>(.*?)<\/a>/gs)].map((match) => ({
    attrs: match[1],
    href: /href="([^"]*)"/.exec(match[1])?.[1],
    classes: (/class="([^"]*)"/.exec(match[1])?.[1] ?? '').split(/\s+/),
    text: match[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(),
  }));
}

test('the registry, the generated index and the built pages list the same datasets', async () => {
  assert.deepEqual(generated.map((database) => database.id).sort(), [...ids].sort());
  for (const id of ids) {
    assert.ok(await exists(join(root, 'dist/_db', id, 'index.html')), `${id} has a built page`);
    assert.ok(await exists(join(root, 'dist/ovdb/db', id, 'index.html')), `${id} has a built OpenVaultDB page`);
  }
});

for (const id of ids) {
  for (const [label, file] of [['site page', join('dist/_db', id, 'index.html')], ['OpenVaultDB page', join('dist/ovdb/db', id, 'index.html')]]) {
    test(`${id} ${label}: the primary action is "${CTA}", first, without WASM, to DataTug's route`, async () => {
      const actions = heroActions(await readFile(join(root, file), 'utf8'));
      const [first, ...others] = actions;
      assert.equal(first.text, CTA, 'the first hero action is the CTA');
      assert.ok(first.classes.includes('button-primary'), 'it is the primary button');
      assert.equal(first.href, `https://datatug.app/demo/sqlite/${id}`);
      assert.doesNotMatch(first.text, /wasm/i, 'the wording never says WASM');
      assert.deepEqual(others.filter((action) => action.classes.includes('button-primary')), [], 'no other primary button competes with it');
      assert.deepEqual(others.filter((action) => action.text === CTA || /wasm/i.test(action.text)), [], 'no duplicate CTA or WASM wording among the secondary actions');
    });
  }

  test(`${id}: the CTA is offered because a complete SQLite file is published`, () => {
    const database = providerOf(id);
    assert.ok(completeDownloads(database).some((file) => file.format === 'sqlite'), 'a complete SQLite file is in the registry entry');
  });

  test(`${id}: the download lists name only files that exist in the registry entry and in the built assets`, async () => {
    const database = providerOf(id);
    const advertised = new Set(completeDownloads(database).map((file) => `/data/${file.publicPath}`));
    const page = await readFile(join(root, 'dist/_db', id, 'index.html'), 'utf8');
    const list = /<div class="format-list">(.*?)<\/div><\/div><\/section>/s.exec(page)?.[1];
    assert.ok(list, 'the page has a format list');
    const shown = [...list.matchAll(/<a href="([^"]*)"><span class="format-label">([^<]*)<\/span>/g)].map((match) => ({ href: match[1], label: match[2] }));
    assert.deepEqual(new Set(shown.map((item) => item.href)), advertised, 'the page lists exactly the complete downloads of the registry entry');
    for (const item of shown) {
      const file = completeDownloads(database).find((candidate) => `/data/${candidate.publicPath}` === item.href);
      assert.equal(item.label, labelOf(database, file.format), `${item.href} is labelled with its real format`);
    }

    const downloads = await readFile(join(root, 'dist/_db', id, 'downloads/index.html'), 'utf8');
    const linked = new Set([...downloads.matchAll(/<a href="(\/data\/[^"]*)" download>/g)].map((match) => match[1]));
    for (const href of advertised) assert.ok(linked.has(href), `the downloads page offers ${href}`);
    for (const href of [...shown.map((item) => item.href), ...[...linked].filter((href) => advertised.has(href))]) {
      const file = completeDownloads(database).find((candidate) => `/data/${candidate.publicPath}` === href);
      const assets = file.chunks?.length ? file.chunks.map((chunk) => chunk.assetPath) : [file.assetPath];
      for (const asset of assets) assert.ok(await exists(join(root, 'dist/_db', id, 'data', asset)), `${href} is backed by the built asset ${asset}`);
    }
  });
}

let catalogDir;
after(() => catalogDir && rm(catalogDir, { recursive: true, force: true }));

async function loadCatalog() {
  let source;
  if (process.env.DATATUG_SQLITE_CATALOG) source = await readFile(process.env.DATATUG_SQLITE_CATALOG, 'utf8');
  else {
    const response = await fetch(CATALOG_URL, { headers: { 'User-Agent': 'DemoDB-dataset-contract/1' } });
    if (!response.ok) throw new Error(`GET ${CATALOG_URL}: HTTP ${response.status}`);
    source = await response.text();
  }
  catalogDir = await mkdtemp(join(tmpdir(), 'datatug-catalog-'));
  const file = join(catalogDir, 'demo-sqlite-catalog.ts');
  await writeFile(file, source);
  return import(pathToFileURL(file).href);
}

test('the DataTug catalog and this registry list the same datasets with the same SQLite file, SHA-256 and size', async (t) => {
  let catalog;
  try { catalog = await loadCatalog(); } catch (error) {
    if (process.env.CI) throw new Error(`DataTug catalog unavailable (a failure in CI, never a skip): ${error.message}`);
    return t.skip(`DataTug catalog unavailable: ${error.message}`);
  }
  assert.deepEqual([...catalog.demoSqliteDatasetIds].sort(), [...ids].sort(), 'datasets: DataTug catalog vs DemoDB registry');
  for (const id of ids) {
    const file = completeDownloads(providerOf(id)).find((candidate) => candidate.format === 'sqlite');
    const entry = catalog.demoSqliteCatalog[id];
    assert.deepEqual(
      { id, url: entry.url, sha256: entry.sha256, bytes: entry.bytes, transferBytes: entry.transferBytes },
      { id, url: `https://${providerOf(id).siteHost}/data/${file.publicPath}`, sha256: decodedSha(file), bytes: decodedBytes(file), transferBytes: file.bytes },
      `${id}: DataTug catalog vs DemoDB registry`,
    );
  }
});
