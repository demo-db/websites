import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// This publication pin is independent of the older Northwind export-contract
// pin in config/databases.json. Only these three reviewed evidence files ship.
export const ORDERS_EVIDENCE_REVISION = '9af760ec3b7d9088567b7b716bcdd2a7e97b91dd';
export const ORDERS_EVIDENCE_PATH = 'artifacts/hosting-imports/';
export const ORDERS_EVIDENCE_ASSETS = Object.freeze({
  'README-public-orders-evidence.md': { name: 'README.md', bytes: 2838, sha256: '3ec1f5f72e3a4aaa823aa217ed9581e18782c175e0ccf40c9127c2da517d6483' },
  'public-orders-evidence-2026-10-16.json': { name: 'public-orders-evidence-2026-10-16.json', bytes: 5940, sha256: '2f3bf872421d645d8c3f4274b52b2ed8da64a490f1f69dd6812b01157fb61010' },
  'source-rights.json': { name: 'source-rights.json', bytes: 4379, sha256: 'b51b2cc489f267bd049e3302ff05587851caac00ee8715f194d6fd7b9a064773' },
});

const MAX_PROVIDER_BYTES = 64 * 1024;
const rawUrl = (path) => `https://raw.githubusercontent.com/demo-db/northwind/${ORDERS_EVIDENCE_REVISION}/${path}`;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function fetchBounded(fetchFile, path) {
  const response = await fetchFile(rawUrl(path), { headers: { 'User-Agent': 'DemoDB-provider-evidence/1' } });
  if (!response.ok || !response.body) throw new Error(`${path}: pinned provider read failed (${response.status})`);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PROVIDER_BYTES) throw new Error(`${path}: provider evidence exceeds ${MAX_PROVIDER_BYTES} bytes`);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

export async function publishNorthwindOrdersEvidence({ fetchFile = fetch, outputDir }) {
  const checksums = JSON.parse((await fetchBounded(fetchFile, 'metadata/checksums.json')).toString('utf8'));
  const verified = [];
  for (const [file, expected] of Object.entries(ORDERS_EVIDENCE_ASSETS)) {
    const path = `${ORDERS_EVIDENCE_PATH}${file}`;
    const manifest = checksums.files?.[path];
    if (manifest?.bytes !== expected.bytes || manifest?.sha256 !== expected.sha256) {
      throw new Error(`${path}: pinned provider checksum manifest disagrees with publication pin`);
    }
    const bytes = await fetchBounded(fetchFile, path);
    if (bytes.length !== expected.bytes || digest(bytes) !== expected.sha256) {
      throw new Error(`${path}: pinned provider content disagrees with publication pin`);
    }
    verified.push({ name: expected.name, bytes });
  }
  await mkdir(outputDir, { recursive: true });
  for (const file of verified) await writeFile(join(outputDir, file.name), file.bytes);
}
