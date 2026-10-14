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

// Measured at 320px on adventureworks.localhost (scrollWidth 366 to 996 before): single-column grids declared
// as `1fr` cannot shrink below the min-content of long identifiers such as HumanResources.EmployeeDepartmentHistory.
const globalCss = await readFile(new URL('../src/styles/global.css', import.meta.url), 'utf8');
const schemaPage = await readFile(new URL('../src/pages/db/[id]/schema/index.astro', import.meta.url), 'utf8');
const phoneRules = globalCss.slice(globalCss.indexOf('@media (max-width:800px)'));

test('phone single-column grids use minmax(0, 1fr) so long identifiers wrap', () => {
  assert.match(phoneRules, /\.hero\{grid-template-columns:minmax\(0,1fr\)/);
  assert.match(phoneRules, /\.about-grid,\.url-contract\{grid-template-columns:minmax\(0,1fr\)/);
  assert.match(phoneRules, /\.table-layout\{grid-template-columns:minmax\(0,1fr\)\}/);
  assert.match(globalCss, /\.source-details\{display:grid;grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(globalCss, /h1,h2,\.prose p,\.schema-card strong,\.mini-table-list a,\.big-download-list a span\{overflow-wrap:anywhere\}/);
});

test('the schema page styles its foreign-key rows and lets source views shrink', () => {
  assert.match(schemaPage, /\.relationship-row \{ display: grid;/, 'the schema page renders .relationship-row, so it carries the grid styles');
  assert.match(schemaPage, /@media \(max-width:540px\) \{ \.relationship-row \{ grid-template-columns:minmax\(0,1fr\)/);
  assert.match(schemaPage, /\.source-view-list \{ display:grid; grid-template-columns:minmax\(0,1fr\)/);
  assert.match(schemaPage, /\.source-view-card \{ min-width:0;/);
});
