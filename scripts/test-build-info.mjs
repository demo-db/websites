import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildInfo, writeBuildInfo } from './write-build-info.mjs';

const sha = 'a'.repeat(40);

test('build marker only accepts local builds or complete Git SHAs', () => {
  assert.deepEqual(buildInfo(sha.toUpperCase()), { format: 'demodb-build/1', commit: sha });
  assert.equal(buildInfo(undefined).commit, 'local');
  for (const invalid of ['', 'main', 'g'.repeat(40), `${sha}0`]) assert.throws(() => buildInfo(invalid));
});

test('build marker is written to the root static assets after build', async () => {
  const root = await mkdtemp(join(tmpdir(), 'demodb-marker-'));
  try {
    await assert.rejects(writeBuildInfo(root, sha), /build the static site first/);
    await mkdir(join(root, 'dist'));
    const result = await writeBuildInfo(root, sha);
    assert.deepEqual(JSON.parse(await readFile(result.file, 'utf8')), { format: 'demodb-build/1', commit: sha });
  } finally { await rm(root, { recursive: true, force: true }); }
});
