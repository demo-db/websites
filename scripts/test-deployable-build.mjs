import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deployableProblems } from './assert-deployable-build.mjs';
import { writeBuildInfo } from './write-build-info.mjs';

const repo = new URL('..', import.meta.url).pathname;
const sha = 'b'.repeat(40);
const hash = (text) => createHash('sha256').update(text).digest('hex');

// A throwaway repo root holding the committed config and a dist/ built from `source`.
async function fakeBuild(source = 'config/postgresql-api.json', { mutate, generatedSource = source } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'demodb-deployable-'));
  await mkdir(join(root, 'config'), { recursive: true });
  await mkdir(join(root, 'dist'));
  await mkdir(join(root, 'src/data/generated'), { recursive: true });
  await cp(join(repo, 'config/postgresql-api.json'), join(root, 'config/postgresql-api.json'));
  const bytes = await readFile(join(repo, source));
  const generatedBytes = await readFile(join(repo, generatedSource));
  const generated = (file) => JSON.stringify({ ...JSON.parse(generatedBytes), provenance: { source: generatedSource, sha256: hash(generatedBytes), default: generatedSource === 'config/postgresql-api.json' } });
  // build-info is written from the first build's provenance, the generated file may be regenerated later
  await writeFile(join(root, 'src/data/generated/postgresql-api.json'), JSON.stringify({ ...JSON.parse(bytes), provenance: { source, sha256: hash(bytes), default: source === 'config/postgresql-api.json' } }));
  await writeBuildInfo(root, sha);
  if (generatedSource !== source) await writeFile(join(root, 'src/data/generated/postgresql-api.json'), generated());
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

test('regenerating the bundled config from the fixture after a default build is not deployable', async () => {
  // pnpm build, then DEMODB_POSTGRESQL_API_CONFIG=<fixture> node scripts/prepare-databases.mjs: build-info still says default
  const problems = await check(await fakeBuild('config/postgresql-api.json', { generatedSource: 'scripts/fixtures/postgresql-api-verified.json' }));
  assert.ok(problems.some((problem) => /src\/data\/generated\/postgresql-api\.json: .*not deployable/.test(problem)), problems.join('; '));
  assert.ok(problems.some((problem) => /disagree/.test(problem)), problems.join('; '));
});

test('a generated config with a tampered hash, or none, is not deployable', async () => {
  const tampered = await fakeBuild('config/postgresql-api.json', { mutate: async (dir) => {
    const file = join(dir, 'src/data/generated/postgresql-api.json');
    const generated = JSON.parse(await readFile(file, 'utf8'));
    generated.provenance.sha256 = '0'.repeat(64);
    await writeFile(file, JSON.stringify(generated));
  } });
  assert.ok((await check(tampered)).some((problem) => /generated\/postgresql-api\.json: .*differs/.test(problem)));
  assert.ok((await check(await fakeBuild('config/postgresql-api.json', { mutate: (dir) => rm(join(dir, 'src/data/generated/postgresql-api.json')) }))).some((problem) => /generated\/postgresql-api\.json is missing/.test(problem)));
});

test('an unreadable committed config is not deployable', async () => {
  const problems = await check(await fakeBuild('config/postgresql-api.json', { mutate: (dir) => rm(join(dir, 'config/postgresql-api.json')) }));
  assert.ok(problems.some((problem) => /config\/postgresql-api\.json cannot be read/.test(problem)));
});

// The CLI must exit non-zero for a bad build however it is invoked: plain path, path with a space, symlinked directory.
test('the guard CLI exits non-zero on a bad build from any invocation path', async () => {
  const base = await mkdtemp(join(tmpdir(), 'demodb-cli-'));
  try {
    const spaced = join(base, 'with space');
    await mkdir(join(spaced, 'scripts'), { recursive: true });
    await mkdir(join(spaced, 'config'));
    await cp(join(repo, 'scripts/assert-deployable-build.mjs'), join(spaced, 'scripts/assert-deployable-build.mjs'));
    await cp(join(repo, 'config/postgresql-api.json'), join(spaced, 'config/postgresql-api.json'));
    // no dist/ and no generated file: not deployable
    await symlink(spaced, join(base, 'link'));
    for (const script of [join(spaced, 'scripts/assert-deployable-build.mjs'), join(base, 'link/scripts/assert-deployable-build.mjs')]) {
      const result = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, DEMODB_POSTGRESQL_API_CONFIG: '' } });
      assert.equal(result.status, 1, `${script}: ${result.stdout}${result.stderr}`);
      assert.match(result.stderr, /NOT DEPLOYABLE/);
    }
    const real = spawnSync(process.execPath, [join(repo, 'scripts/assert-deployable-build.mjs')], { encoding: 'utf8', env: { ...process.env, DEMODB_POSTGRESQL_API_CONFIG: 'x' } });
    assert.equal(real.status, 1);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('write-build-info CLI writes the marker from a path with a space and via a symlinked directory', async () => {
  const base = await mkdtemp(join(tmpdir(), 'demodb-wbi-'));
  try {
    const spaced = join(base, 'with space');
    await mkdir(join(spaced, 'scripts'), { recursive: true });
    await mkdir(join(spaced, 'dist'));
    await mkdir(join(spaced, 'src/data/generated'), { recursive: true });
    await cp(join(repo, 'scripts/write-build-info.mjs'), join(spaced, 'scripts/write-build-info.mjs'));
    await writeFile(join(spaced, 'src/data/generated/postgresql-api.json'), JSON.stringify({ provenance: { source: 'config/postgresql-api.json', sha256: 'e'.repeat(64), default: true } }));
    await symlink(spaced, join(base, 'link'));
    for (const script of [join(spaced, 'scripts/write-build-info.mjs'), join(base, 'link/scripts/write-build-info.mjs')]) {
      await rm(join(spaced, 'dist/build-info.json'), { force: true });
      const result = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, BUILD_COMMIT: sha } });
      assert.equal(result.status, 0, `${script}: ${result.stderr}`);
      assert.equal(JSON.parse(await readFile(join(spaced, 'dist/build-info.json'), 'utf8')).commit, sha, `${script} wrote the marker`);
    }
  } finally { await rm(base, { recursive: true, force: true }); }
});
