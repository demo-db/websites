import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { storageGroups, publicOvdbApiCount, postgresqlPublicApiVerified, ovdbDeploymentVerified } from '../src/data/ovdb.ts';
import { catalogueProblems, storagePageProblems } from './smoke-catalogue.mjs';

const html = await readFile(new URL('../dist/ovdb/index.html', import.meta.url), 'utf8');
const entries = storageGroups.flatMap(({ storages }) => storages);
const page = async (id) => readFile(new URL(`../dist/ovdb/db/${id}/index.html`, import.meta.url), 'utf8');

test('actual built catalogue and every edition match the typed capability inventory', async () => {
  assert.deepEqual(catalogueProblems(html, storageGroups), []);
  assert.equal(storageGroups.length, 8);
  assert.equal(entries.length, 26);
  assert.equal(publicOvdbApiCount, postgresqlPublicApiVerified ? 12 : 6);
  assert.deepEqual(entries.filter(({ engine, readiness }) => engine === 'SQLite' && readiness === 'public-api').map(({ id }) => id).sort(), ['adventureworks-sqlite', 'chinook-sqlite', 'employees-sqlite', 'northwind-sqlite', 'pubs-sqlite', 'sakila-sqlite']);
  for (const entry of entries) assert.deepEqual(storagePageProblems(await page(entry.id), entry), [], entry.id);
  for (const { database, storages } of storageGroups) {
    for (const entry of storages.filter(({ engine }) => engine === 'SQLite')) {
      assert.equal(entry.readiness === 'public-api', ovdbDeploymentVerified.get(database.localId) === true);
    }
  }
  assert.equal(entries.find(({ id }) => id === 'shipping-sqlite').readiness, 'hosted-api-pending');
  assert.deepEqual(entries.filter(({ id }) => id.startsWith('shipping-logs-')).map(({ id, readiness }) => [id, readiness]), [['shipping-logs-ingitdb', 'hosted-repository']]);
});

test('missing, duplicate and unexpected edition links fail', () => {
  const href = '/ovdb/db/shipping-logs-ingitdb/';
  assert.ok(catalogueProblems(html.replace(`href="${href}"`, 'href="/missing/"'), storageGroups).some((p) => p.includes('storage links')));
  assert.ok(catalogueProblems(`${html}<a href="${href}">extra</a>`, storageGroups).some((p) => p.includes('storage links')));
  assert.ok(catalogueProblems(`${html}<a href="/ovdb/db/unpublished-sqlite/">extra</a>`, storageGroups).some((p) => p.includes('storage links')));
});

test('wrong totals and falsely admitted pending APIs fail against actual built HTML', async () => {
  assert.ok(catalogueProblems(html.replace('8 datasets across 26 storage editions.', '6 datasets across 24 storage editions.'), storageGroups).some((p) => p.includes('summary')));
  assert.ok(catalogueProblems(html.replace(`${publicOvdbApiCount} public OVDB APIs`, '999 public OVDB APIs'), storageGroups).some((p) => p.includes('API count')));
  assert.ok(catalogueProblems(html.replace(/(href="\/ovdb\/db\/shipping-sqlite\/"[\s\S]*?)SQLite edition · public API pending/, '$1Public read-only API'), storageGroups).some((p) => p.includes('shipping-sqlite')));
  const pending = entries.find(({ id }) => id === 'shipping-sqlite');
  assert.ok(storagePageProblems(`${await page(pending.id)}<a>Open read-only API</a>`, pending).includes('unverified API advertised'));
  const native = entries.find(({ id }) => id === 'shipping-logs-ingitdb');
  assert.ok(storagePageProblems((await page(native.id)).replace('three native inGitDB collections', 'SQLite snapshot'), native).includes('native original log provenance missing'));
});

test('actual built PostgreSQL introduction cannot overclaim or underclaim readiness', () => {
  const honest = postgresqlPublicApiVerified ? 'are hosted on Neon with separate public read-only DTQL endpoints' : 'have public API access pending';
  const misleading = postgresqlPublicApiVerified ? 'have public API access pending' : 'are hosted on Neon with separate public read-only DTQL endpoints';
  assert.ok(catalogueProblems(html.replace(honest, misleading), storageGroups).some((p) => p.includes('PostgreSQL introduction')));
});

test('both PostgreSQL config states enforce catalogue and detail readiness', () => {
  for (const verified of [false, true]) {
    const entry = { id: 'chinook-postgresql', engine: 'PostgreSQL', readiness: verified ? 'public-api' : 'hosted-api-pending', apiUrl: verified ? 'https://cloud.openvaultdb.com/v1/databases/chinook-postgresql' : undefined };
    const groups = [{ storages: [entry] }];
    const label = verified ? 'Public read-only API' : 'PostgreSQL edition · public API pending';
    const body = `<h2>1 datasets across 1 storage editions.</h2><span>${verified ? 1 : 0} public OVDB APIs</span><a href="/ovdb/db/chinook-postgresql/">${label}</a>demodb-dev your own execution project PostgreSQL copies ${verified ? 'are hosted on Neon with separate public read-only DTQL endpoints' : 'have public API access pending'}`;
    assert.deepEqual(catalogueProblems(body, groups), []);
    assert.ok(catalogueProblems(body.replace(label, verified ? 'PostgreSQL edition · public API pending' : 'Public read-only API'), groups).length);
    const detail = `https://demodb.dev/ovdb/db/chinook-postgresql/ ${verified ? `${entry.apiUrl} Open read-only API does not expose the SQLite snapshot’s immutable build pin or a general SQL query endpoint` : 'Public OpenVaultDB API access is being prepared'}`;
    assert.deepEqual(storagePageProblems(detail, entry), []);
    assert.ok(storagePageProblems(detail, { ...entry, readiness: verified ? 'hosted-api-pending' : 'public-api' }).length);
  }
});
