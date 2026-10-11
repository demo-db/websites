import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

const HASH = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function assertAppendOnlyFixturePins(configuredPins, historicalPins) {
  const configured = indexPins(configuredPins, 'configured');
  const historical = indexPins(historicalPins, 'historical');
  assertRetainsComparisonFixturePins(configuredPins, historicalPins);
  for (const id of configured.keys()) {
    if (!historical.has(id)) throw new Error(`Comparison fixture ${id} is not recorded in append-only history`);
  }
  return true;
}

export function assertRetainsComparisonFixturePins(configuredPins, historicalPins) {
  const configured = indexPins(configuredPins, 'configured');
  const historical = indexPins(historicalPins, 'base/history');
  for (const [id, pin] of historical) {
    const current = configured.get(id);
    if (!current) throw new Error(`Historical comparison fixture ${id} was removed from the active pins`);
    if (JSON.stringify(current) !== JSON.stringify(pin)) throw new Error(`Historical comparison fixture ${id} was changed`);
  }
  return true;
}

function indexPins(pins, label) {
  if (!Array.isArray(pins)) throw new Error(`Comparison fixture ${label} pins must be an array`);
  const indexed = new Map();
  for (const pin of pins) {
    validatePin(pin);
    if (indexed.has(pin.fixtureId)) throw new Error(`Duplicate ${label} comparison fixture ID: ${pin.fixtureId}`);
    indexed.set(pin.fixtureId, pin);
  }
  return indexed;
}

export async function materializeComparisonFixtures(fixtures, assetRoot, readPinnedFile, readCanonicalExport) {
  if (!Array.isArray(fixtures)) throw new Error('Comparison fixtures must be an array');
  if (typeof readPinnedFile !== 'function') throw new Error('Comparison fixture reader must be a function');
  if (typeof readCanonicalExport !== 'function') throw new Error('Canonical SQLite export reader must be a function');
  const ids = new Set();
  const assetPaths = new Set();
  const materialized = [];

  for (const pin of fixtures) {
    validatePin(pin);
    if (ids.has(pin.fixtureId)) throw new Error(`Duplicate comparison fixture ID: ${pin.fixtureId}`);
    ids.add(pin.fixtureId);

    const manifestBytes = await readPinnedFile(pin, pin.manifestPath);
    if (sha256(manifestBytes) !== pin.manifestSha256) throw new Error(`${pin.fixtureId}: provider manifest hash mismatch`);
    let manifest;
    try { manifest = JSON.parse(manifestBytes.toString('utf8')); }
    catch (error) { throw new Error(`${pin.fixtureId}: provider manifest is not valid JSON`, { cause: error }); }
    if (manifest.format !== 'datatug-compare-fixtures/v1' || manifest.appendOnly !== true || !Array.isArray(manifest.fixtures)) {
      throw new Error(`${pin.fixtureId}: unsupported comparison fixture manifest`);
    }
    const matches = manifest.fixtures.filter((entry) => entry.id === pin.fixtureId);
    if (matches.length !== 1) throw new Error(`${pin.fixtureId}: expected exactly one matching manifest entry`);
    const entry = matches[0];
    if (entry.environment !== 'synthetic fixture environment') throw new Error(`${pin.fixtureId}: fixture environment is not explicitly synthetic`);
    if (entry.baseline?.path !== 'data-source/source.sqlite'
      || entry.baseline.sha256 !== pin.baselineSha256
      || entry.baseline.bytes !== pin.baselineBytes) {
      throw new Error(`${pin.fixtureId}: baseline does not match the website pin`);
    }
    const baselineBytes = await readPinnedFile(pin, entry.baseline.path);
    if (baselineBytes.length !== pin.baselineBytes) throw new Error(`${pin.fixtureId}: baseline byte length mismatch`);
    if (sha256(baselineBytes) !== pin.baselineSha256) throw new Error(`${pin.fixtureId}: baseline content hash mismatch`);
    const canonical = await readCanonicalExport(pin);
    if (!canonical || canonical.bytes !== pin.baselineBytes || canonical.sha256 !== pin.baselineSha256) {
      throw new Error(`${pin.fixtureId}: canonical SQLite export does not match the pinned baseline`);
    }
    if (entry.candidate?.path !== pin.candidatePath
      || entry.candidate.sha256 !== pin.candidateSha256
      || entry.candidate.bytes !== pin.candidateBytes) {
      throw new Error(`${pin.fixtureId}: candidate path, hash, or size does not match the website pin`);
    }
    safeRelative(entry.candidate.path);
    if (!entry.candidate.path.startsWith('fixtures/compare/')) throw new Error(`${pin.fixtureId}: candidate is outside fixtures/compare`);
    if (entry.candidate.path.split('/').at(-1) !== `chinook-candidate-${pin.candidateSha256}.sqlite`) {
      throw new Error(`${pin.fixtureId}: candidate path is not content-addressed`);
    }

    const bytes = await readPinnedFile(pin, entry.candidate.path);
    if (bytes.length !== pin.candidateBytes) throw new Error(`${pin.fixtureId}: candidate byte length mismatch`);
    if (sha256(bytes) !== pin.candidateSha256) throw new Error(`${pin.fixtureId}: candidate content hash mismatch`);

    const publicPath = `compare/${pin.candidateSha256}.sqlite`;
    const targetPath = resolve(assetRoot, pin.databaseId, 'data', ...publicPath.split('/'));
    const expectedRoot = `${resolve(assetRoot)}${sep}`;
    if (!targetPath.startsWith(expectedRoot)) throw new Error(`${pin.fixtureId}: materialized asset path escapes the asset root`);
    const identity = `${pin.databaseId}/${publicPath}`;
    if (assetPaths.has(identity)) throw new Error(`Duplicate comparison fixture asset path: ${identity}`);
    assetPaths.add(identity);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, bytes, { flag: 'wx' });
    materialized.push({
      databaseId: pin.databaseId,
      id: pin.fixtureId,
      publicPath,
      assetPath: publicPath,
      sha256: pin.candidateSha256,
      bytes: pin.candidateBytes,
    });
  }

  return materialized;
}

function validatePin(pin) {
  if (!pin || typeof pin !== 'object') throw new Error('Invalid comparison fixture pin');
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(pin.databaseId)) throw new Error(`Invalid comparison fixture database ID: ${pin.databaseId}`);
  if (typeof pin.fixtureId !== 'string' || !pin.fixtureId) throw new Error('Comparison fixture ID is required');
  if (typeof pin.repository !== 'string') throw new Error(`${pin.fixtureId}: provider repository is required`);
  let repository;
  try { repository = new URL(pin.repository); } catch { throw new Error(`${pin.fixtureId}: provider repository URL is invalid`); }
  if (repository.protocol !== 'https:' || repository.hostname !== 'github.com' || repository.pathname !== '/demo-db/chinook') {
    throw new Error(`${pin.fixtureId}: provider repository must be https://github.com/demo-db/chinook`);
  }
  if (!COMMIT.test(pin.commit)) throw new Error(`${pin.fixtureId}: provider commit must be a full immutable SHA`);
  if (pin.manifestPath !== 'fixtures/compare/manifest.json') throw new Error(`${pin.fixtureId}: unexpected provider manifest path`);
  if (!HASH.test(pin.manifestSha256)) throw new Error(`${pin.fixtureId}: invalid provider manifest SHA-256`);
  if (!HASH.test(pin.baselineSha256) || !Number.isSafeInteger(pin.baselineBytes) || pin.baselineBytes <= 0) {
    throw new Error(`${pin.fixtureId}: invalid baseline hash or size`);
  }
  if (typeof pin.candidatePath !== 'string' || !pin.candidatePath.startsWith('fixtures/compare/')) throw new Error(`${pin.fixtureId}: invalid candidate path`);
  if (!HASH.test(pin.candidateSha256) || !Number.isSafeInteger(pin.candidateBytes) || pin.candidateBytes <= 0) {
    throw new Error(`${pin.fixtureId}: invalid candidate hash or size`);
  }
}

function safeRelative(path) {
  if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\\') || path.split('/').some((part) => part === '..' || part === '.' || !part)) {
    throw new Error(`Unsafe provider path: ${path}`);
  }
}
