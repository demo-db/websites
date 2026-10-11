import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertAppendOnlyFixturePins, assertRetainsComparisonFixturePins, materializeComparisonFixtures, sha256 } from './comparison-fixtures.mjs';

function bundle() {
  const baseline = Buffer.from('baseline sqlite bytes');
  const candidate = Buffer.from('synthetic candidate sqlite bytes');
  const candidateSha256 = sha256(candidate);
  const candidatePath = `fixtures/compare/chinook-candidate-${candidateSha256}.sqlite`;
  const fixture = {
    id: `chinook-synthetic-${candidateSha256}`,
    environment: 'synthetic fixture environment',
    baseline: { path: 'data-source/source.sqlite', sha256: sha256(baseline), bytes: baseline.length },
    candidate: { path: candidatePath, sha256: candidateSha256, bytes: candidate.length },
  };
  const manifest = Buffer.from(`${JSON.stringify({ format: 'datatug-compare-fixtures/v1', appendOnly: true, fixtures: [fixture] }, null, 2)}\n`);
  const pin = {
    databaseId: 'chinook',
    repository: 'https://github.com/demo-db/chinook',
    commit: '95d14a11256f8db512d5ecd7ea5be56e01d51781',
    manifestPath: 'fixtures/compare/manifest.json',
    manifestSha256: sha256(manifest),
    fixtureId: fixture.id,
    baselineSha256: fixture.baseline.sha256,
    baselineBytes: fixture.baseline.bytes,
    candidatePath,
    candidateSha256,
    candidateBytes: candidate.length,
  };
  const files = new Map([[pin.manifestPath, manifest], [fixture.baseline.path, baseline], [candidatePath, candidate]]);
  const readPinnedFile = async (_pin, path) => {
    const bytes = files.get(path);
    if (!bytes) throw new Error(`unexpected pinned input path: ${path}`);
    return bytes;
  };
  const readCanonicalExport = async () => ({ bytes: pin.baselineBytes, sha256: pin.baselineSha256 });
  return { pin, fixture, manifest, baseline, candidate, files, readPinnedFile, readCanonicalExport };
}

test('materializes only the hash- and size-verified fixture at its immutable public asset path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'demodb-comparison-fixture-'));
  try {
    const input = bundle();
    const result = await materializeComparisonFixtures([input.pin], dir, input.readPinnedFile, input.readCanonicalExport);
    assert.deepEqual(result, [{
      databaseId: 'chinook',
      id: input.fixture.id,
      publicPath: `compare/${input.pin.candidateSha256}.sqlite`,
      assetPath: `compare/${input.pin.candidateSha256}.sqlite`,
      sha256: input.pin.candidateSha256,
      bytes: input.candidate.length,
    }]);
    assert.deepEqual(await readFile(join(dir, 'chinook', 'data', result[0].assetPath)), input.candidate);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rejects an unpinned manifest digest and a manifest entry whose candidate path drifts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'demodb-comparison-fixture-'));
  try {
    const digestMismatch = bundle();
    digestMismatch.pin.manifestSha256 = '0'.repeat(64);
    await assert.rejects(materializeComparisonFixtures([digestMismatch.pin], dir, digestMismatch.readPinnedFile, digestMismatch.readCanonicalExport), /manifest hash mismatch/);

    const pathMismatch = bundle();
    const changedManifest = JSON.parse(pathMismatch.manifest.toString('utf8'));
    changedManifest.fixtures[0].candidate.path = `fixtures/compare/other-${pathMismatch.pin.candidateSha256}.sqlite`;
    const bytes = Buffer.from(`${JSON.stringify(changedManifest, null, 2)}\n`);
    pathMismatch.pin.manifestSha256 = sha256(bytes);
    pathMismatch.files.set(pathMismatch.pin.manifestPath, bytes);
    await assert.rejects(materializeComparisonFixtures([pathMismatch.pin], dir, pathMismatch.readPinnedFile, pathMismatch.readCanonicalExport), /candidate path, hash, or size/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rejects candidate bytes that differ from the pinned content hash', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'demodb-comparison-fixture-'));
  try {
    const input = bundle();
    input.files.set(input.pin.candidatePath, Buffer.from('wrong candidate sqlite bytes'));
    await assert.rejects(materializeComparisonFixtures([input.pin], dir, input.readPinnedFile, input.readCanonicalExport), /candidate (byte length mismatch|content hash mismatch)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rejects baseline bytes or the canonical SQLite export when either differs from the pinned input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'demodb-comparison-fixture-'));
  try {
    const badSource = bundle();
    badSource.files.set('data-source/source.sqlite', Buffer.from('different baseline sqlite bytes'));
    await assert.rejects(
      materializeComparisonFixtures([badSource.pin], dir, badSource.readPinnedFile, badSource.readCanonicalExport),
      /baseline (byte length mismatch|content hash mismatch)/,
    );

    const badCanonical = bundle();
    await assert.rejects(
      materializeComparisonFixtures([badCanonical.pin], dir, badCanonical.readPinnedFile, async () => ({ bytes: badCanonical.pin.baselineBytes + 1, sha256: badCanonical.pin.baselineSha256 })),
      /canonical SQLite export does not match the pinned baseline/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('append-only history retains old pins and materializes old and new immutable assets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'demodb-comparison-fixture-'));
  try {
    const old = bundle();
    const newCandidate = Buffer.from('second synthetic candidate sqlite bytes');
    const newSha = sha256(newCandidate);
    const newPath = `fixtures/compare/chinook-candidate-${newSha}.sqlite`;
    const newFixture = {
      ...old.fixture,
      id: `chinook-synthetic-${newSha}`,
      candidate: { path: newPath, sha256: newSha, bytes: newCandidate.length },
    };
    const appendedManifest = Buffer.from(`${JSON.stringify({
      format: 'datatug-compare-fixtures/v1', appendOnly: true, fixtures: [old.fixture, newFixture],
    }, null, 2)}\n`);
    const newPin = {
      ...old.pin,
      commit: 'a'.repeat(40),
      manifestSha256: sha256(appendedManifest),
      fixtureId: newFixture.id,
      candidatePath: newPath,
      candidateSha256: newSha,
      candidateBytes: newCandidate.length,
    };
    const appendedFiles = new Map([
      [newPin.manifestPath, appendedManifest],
      ['data-source/source.sqlite', old.baseline],
      [newPath, newCandidate],
    ]);
    const readPinnedFile = async (pin, path) => {
      const bytes = pin.commit === old.pin.commit ? old.files.get(path) : appendedFiles.get(path);
      if (!bytes) throw new Error(`unexpected pinned input path: ${path}`);
      return bytes;
    };
    const pins = [old.pin, newPin];
    assert.equal(assertAppendOnlyFixturePins(pins, pins), true);
    assert.throws(() => assertAppendOnlyFixturePins([newPin], pins), /was removed from the active pins/);
    assert.throws(() => assertAppendOnlyFixturePins([{ ...old.pin, candidateBytes: 1 }, newPin], pins), /was changed/);
    assert.equal(assertAppendOnlyFixturePins([newPin], [newPin]), true, 'coordinated replacement of both current files appears internally consistent');
    assert.throws(() => assertRetainsComparisonFixturePins([newPin], [old.pin]), /was removed from the active pins/, 'the actual base commit still rejects that coordinated deletion');

    const materialized = await materializeComparisonFixtures(pins, dir, readPinnedFile, async (pin) => ({
      bytes: pin.baselineBytes, sha256: pin.baselineSha256,
    }));
    assert.equal(materialized.length, 2);
    assert.deepEqual(await readFile(join(dir, 'chinook', 'data', `compare/${old.pin.candidateSha256}.sqlite`)), old.candidate);
    assert.deepEqual(await readFile(join(dir, 'chinook', 'data', `compare/${newSha}.sqlite`)), newCandidate);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('checked-in active pins retain every historical comparison fixture pin', async () => {
  const config = JSON.parse(await readFile(new URL('../config/databases.json', import.meta.url), 'utf8'));
  const history = JSON.parse(await readFile(new URL('../config/comparison-fixtures-history.json', import.meta.url), 'utf8'));
  assert.equal(history.format, 'demodb-comparison-fixture-history/v1');
  assert.equal(assertAppendOnlyFixturePins(config.comparisonFixtures, history.fixtures), true);
});
