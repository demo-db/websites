import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { corpusExport, decodedExportBytes } from './corpus-exports.mjs';

const corpus = JSON.parse(await readFile(new URL('../public/corpus.json', import.meta.url), 'utf8'));

// scripts/smoke-live.mjs reads these through the same helpers; a manifest shape the smoke
// cannot read must fail in pull-request CI, not after the deploy.
test('the published corpus describes the decoded size of every gzip export', () => {
  for (const database of corpus.databases) {
    for (const item of database.exports) {
      if (item.compression !== 'gzip') continue;
      assert.ok(Number.isSafeInteger(item.decodedBytes) && item.decodedBytes > item.bytes, `${database.localId} ${item.format}`);
      assert.match(item.decodedSha256, /^[a-f0-9]{64}$/, `${database.localId} ${item.format}`);
    }
  }
});

test('the live smoke can read the AdventureWorks decoded sizes from the corpus', () => {
  assert.equal(decodedExportBytes(corpus, 'adventureworks', 'sqlite'), 126820352);
  assert.ok(decodedExportBytes(corpus, 'adventureworks', 'sql') > 0);
  assert.equal(corpusExport(corpus, 'adventureworks', 'sql').url, 'https://adventureworks.demodb.dev/data/adventureworks.sql');
});

test('a missing decoded size is reported, not guessed', () => {
  assert.throws(() => decodedExportBytes({ databases: [{ localId: 'x', exports: [{ format: 'sql', bytes: 1 }] }] }, 'x', 'sql'), /lacks the decoded SQL export size/);
  assert.throws(() => decodedExportBytes({ databases: [] }, 'x', 'sql'), /lacks the decoded SQL export size/);
});
