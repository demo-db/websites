import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

// Measured with `wrangler dev --env local` at 375px: these grid and flex items overflowed
// the viewport because their default min-width is min-content (long table names, URLs,
// SHAs, commands). Each rule below is what stops that, so removing one fails here.
const ovdb = await readFile(new URL('../src/styles/ovdb.css', import.meta.url), 'utf8');
const demodb = await readFile(new URL('../src/styles/demodb.css', import.meta.url), 'utf8');
const rule = (css, selector) => css.split('}').map((block) => block.replace(/@media[^{]*\{/, '')).filter((block) => block.split('{')[0].split(',').map((part) => part.trim()).includes(selector)).join(';');

test('OVDB database page grid items can shrink below their content', () => {
  assert.match(rule(ovdb, '.recordset-list'), /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(rule(ovdb, '.recordset-card'), /min-width:\s*0/);
  assert.match(rule(ovdb, '.recordset-heading>div'), /min-width:\s*0/);
  assert.match(rule(ovdb, '.recordset-heading h3'), /overflow-wrap:\s*anywhere/);
  assert.match(rule(ovdb, '.intro-grid>*'), /min-width:\s*0/);
  assert.match(rule(ovdb, '.intro-copy'), /overflow-wrap:\s*anywhere/);
  assert.match(rule(ovdb, 'pre.query-code'), /overflow-x:\s*auto/);
});

test('landing table cards stay inside a one-column phone grid', () => {
  assert.match(rule(demodb, '.table-grid'), /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(rule(demodb, '.table-card'), /min-width:\s*0/);
  assert.match(rule(demodb, '.table-card strong'), /overflow-wrap:\s*anywhere/);
});
