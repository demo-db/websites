// The registry-vs-catalog check must never be silently off in CI: with CI set, an unreadable catalog fails the
// run; without it, only that test is skipped.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const script = new URL('./test-dataset-contract.mjs', import.meta.url).pathname;
const { NODE_TEST_CONTEXT, ...parentEnv } = process.env; // a nested run must report on its own
const run = (env) => spawnSync(process.execPath, ['--test', script], {
  encoding: 'utf8',
  env: { ...parentEnv, CI: '', DATATUG_SQLITE_CATALOG: '/nonexistent/demo-sqlite-catalog.ts', ...env },
});

test('an unreadable DataTug catalog fails the contract test in CI', () => {
  const result = run({ CI: 'true' });
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stdout, /failure in CI, never a skip/);
});

test('a catalog that is not valid TypeScript also fails in CI', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(`${tmpdir()}/bad-catalog-`);
  try {
    await writeFile(`${dir}/c.ts`, 'export const = ;');
    assert.notEqual(run({ CI: 'true', DATATUG_SQLITE_CATALOG: `${dir}/c.ts` }).status, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('locally the same failure only skips that test', () => {
  const result = run({});
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /skipped 1/);
});
