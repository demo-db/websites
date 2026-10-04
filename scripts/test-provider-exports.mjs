import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { materializeProviderExports } from './provider-exports.mjs';

const decoded = Buffer.from('Complete SQLite fixture; every byte must survive chunk assembly. '.repeat(50));
const encoded = gzipSync(decoded);
const split = Math.max(1, Math.floor(encoded.length / 2));
const parts = [encoded.subarray(0, split), encoded.subarray(split)];
const files = new Map([
  ['artifacts/AdventureWorks.sqlite.gz.part-0001', parts[0]],
  ['artifacts/AdventureWorks.sqlite.gz.part-0002', parts[1]],
  ['artifacts/AdventureWorks.sql.gz', encoded],
]);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const chunkEntries = [...files.entries()].slice(0, 2).map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: digest(bytes) }));
const checksums = { files: Object.fromEntries([...files.entries()].map(([path, bytes]) => [path, { bytes: bytes.length, sha256: digest(bytes) }])) };
const source = { checksums, read: async (path) => {
  const bytes = files.get(path);
  if (!bytes) throw new Error(`fixture file not found: ${path}`);
  return bytes;
} };
const common = { bytes: encoded.length, sha256: digest(encoded), decodedBytes: decoded.length, decodedSha256: digest(decoded), compression: 'gzip' };
const exports = [
  { path: 'artifacts/AdventureWorks.sqlite', encodedPath: 'artifacts/AdventureWorks.sqlite.gz', publicPath: 'AdventureWorks.sqlite', assetPath: 'AdventureWorks.sqlite', chunks: chunkEntries.map((chunk, index) => ({ ...chunk, assetPath: `__chunks/AdventureWorks.sqlite.gz.part-${String(index + 1).padStart(4, '0')}` })), ...common },
  { path: 'artifacts/AdventureWorks.sql', encodedPath: 'artifacts/AdventureWorks.sql.gz', publicPath: 'AdventureWorks.sql', assetPath: 'AdventureWorks.sql.gz', ...common },
];
const root = await mkdtemp(join(tmpdir(), 'demodb-export-check-'));
try {
  await materializeProviderExports('adventureworks', exports, source, root);
  const joined = Buffer.concat(await Promise.all(exports[0].chunks.map((chunk) => readFile(join(root, chunk.assetPath)))));
  assert.deepEqual(joined, encoded, 'chunks retain their declared order and reconstruct the exact encoded stream');
  assert.deepEqual(await readFile(join(root, exports[1].assetPath)), encoded, 'single gzip export retains its exact bytes');

  const badChunk = { ...exports[0], chunks: exports[0].chunks.map((chunk, index) => index ? chunk : { ...chunk, sha256: '0'.repeat(64) }) };
  await assert.rejects(materializeProviderExports('adventureworks', [badChunk], source, root), /disagrees with its export descriptor/);
  const badAggregate = { ...exports[0], sha256: '0'.repeat(64) };
  await assert.rejects(materializeProviderExports('adventureworks', [badAggregate], source, root), /encoded checksum mismatch/);
  const badDecoded = { ...exports[0], decodedSha256: '0'.repeat(64) };
  await assert.rejects(materializeProviderExports('adventureworks', [badDecoded], source, root), /decoded checksum mismatch/);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('Provider build verification preserves and validates single and ordered chunked gzip exports.');
