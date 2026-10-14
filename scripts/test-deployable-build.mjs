import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deployableProblems } from './assert-deployable-build.mjs';
import { writeBuildInfo } from './write-build-info.mjs';

const repo = new URL('..', import.meta.url).pathname;
const sha = 'b'.repeat(40);
const hash = (text) => createHash('sha256').update(text).digest('hex');

// A throwaway repo root holding the committed config and a dist/ built from `source`.
async function fakeBuild(source = 'config/postgresql-api.json', { mutate } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'demodb-deployable-'));
  await mkdir(join(root, 'config'), { recursive: true });
  await mkdir(join(root, 'dist'));
  await mkdir(join(root, 'src/data/generated'), { recursive: true });
  await cp(join(repo, 'config/postgresql-api.json'), join(root, 'config/postgresql-api.json'));
  const bytes = await readFile(join(repo, source));
  await writeFile(join(root, 'src/data/generated/postgresql-api.json'), JSON.stringify({ ...JSON.parse(bytes), provenance: { source, sha256: hash(bytes), default: source === 'config/postgresql-api.json' } }));
  await writeBuildInfo(root, sha);
  if (mutate) await mutate(root);
  return root;
}
const check = async (root, env = {}) => { try { return await deployableProblems(root, env); } finally { await rm(root, { recursive: true, force: true }); } };

test('a build from the committed config is deployable', async () => {
  assert.deepEqual(await check(await fakeBuild()), []);
});

test('a build from the verified fixture is not deployable', async () => {
  const problems = await check(await fakeBuild('scripts/fixtures/postgresql-api-verified.json'));
  assert.ok(problems.some((problem) => /not deployable/.test(problem)), problems.join('; '));
});

test('a build with no provenance is not deployable', async () => {
  const root = await fakeBuild('config/postgresql-api.json', { mutate: async (dir) => {
    const file = join(dir, 'dist/build-info.json');
    const info = JSON.parse(await readFile(file, 'utf8'));
    delete info.postgresqlApiConfig;
    await writeFile(file, JSON.stringify(info));
  } });
  assert.ok((await check(root)).some((problem) => /no PostgreSQL API config provenance/.test(problem)));
  assert.ok((await check(await fakeBuild('config/postgresql-api.json', { mutate: (dir) => rm(join(dir, 'dist/build-info.json')) }))).some((problem) => /build-info/.test(problem)));
});

test('a tampered or stale hash is not deployable', async () => {
  const tampered = await fakeBuild('config/postgresql-api.json', { mutate: async (dir) => {
    const file = join(dir, 'dist/build-info.json');
    const info = JSON.parse(await readFile(file, 'utf8'));
    info.postgresqlApiConfig.sha256 = '0'.repeat(64);
    await writeFile(file, JSON.stringify(info));
  } });
  assert.ok((await check(tampered)).some((problem) => /differs from the committed file/.test(problem)));
  const edited = await fakeBuild('config/postgresql-api.json', { mutate: (dir) => writeFile(join(dir, 'config/postgresql-api.json'), '{"format":"demodb-postgresql-api/v1","publicApiVerified":true}') });
  assert.ok((await check(edited)).some((problem) => /differs from the committed file/.test(problem)), 'flipping the committed config after the build requires a rebuild');
});

test('the guard fails in deploy mode while DEMODB_POSTGRESQL_API_CONFIG is set', async () => {
  const problems = await check(await fakeBuild(), { DEMODB_POSTGRESQL_API_CONFIG: 'scripts/fixtures/postgresql-api-verified.json' });
  assert.ok(problems.some((problem) => /DEMODB_POSTGRESQL_API_CONFIG is set/.test(problem)));
});

test('the real dist/ of this checkout records provenance for the config it was built from', async () => {
  const info = JSON.parse(await readFile(join(repo, 'dist/build-info.json'), 'utf8'));
  const generated = JSON.parse(await readFile(join(repo, 'src/data/generated/postgresql-api.json'), 'utf8'));
  assert.deepEqual(info.postgresqlApiConfig, { source: generated.provenance.source, sha256: generated.provenance.sha256 });
  const bytes = await readFile(join(repo, generated.provenance.source));
  assert.equal(generated.provenance.sha256, hash(bytes), 'the recorded hash is the hash of the recorded source');
  assert.equal(generated.provenance.default, generated.provenance.source === 'config/postgresql-api.json');
});
