import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import worker from '../src/worker';
import { ORDERS_EVIDENCE_ASSETS, ORDERS_EVIDENCE_REVISION, publishNorthwindOrdersEvidence } from './northwind-orders-evidence.mjs';

const root = process.cwd();
const published = join(root, 'dist/_db/northwind/evidence/public-orders');
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

test('the built Northwind evidence route contains exactly pinned provider bytes', async () => {
  for (const expected of Object.values(ORDERS_EVIDENCE_ASSETS)) {
    const bytes = await readFile(join(published, expected.name));
    assert.equal(bytes.length, expected.bytes);
    assert.equal(digest(bytes), expected.sha256);
  }
  const page = await readFile(join(published, 'index.html'), 'utf8');
  assert.match(page, /Public Orders evidence/);
  assert.match(page, new RegExp(ORDERS_EVIDENCE_REVISION.slice(0, 12)));
  assert.match(page, /not prove other tables, future API state/);

  const requests: string[] = [];
  const env = { ASSETS: { fetch: async (request: Request) => {
    const path = new URL(request.url).pathname;
    requests.push(path);
    try {
      const bytes = await readFile(join(root, 'dist', path));
      return new Response(request.method === 'HEAD' ? null : bytes, { status: 200 });
    } catch { return new Response(null, { status: 404 }); }
  } } };
  for (const path of ['/evidence/public-orders/', '/evidence/public-orders/receipt.json', '/evidence/public-orders/README.md']) {
    const response = await worker.fetch(new Request(`https://northwind.demodb.dev${path}`), env);
    assert.equal(response.status, 200, path);
  }
  assert.deepEqual(requests, ['/_db/northwind/evidence/public-orders/index.html', '/_db/northwind/evidence/public-orders/receipt.json', '/_db/northwind/evidence/public-orders/README.md']);
});

test('publication fails closed if pinned evidence bytes change', async () => {
  const manifest = { files: Object.fromEntries(Object.entries(ORDERS_EVIDENCE_ASSETS).map(([name, item]) => [`artifacts/hosting-imports/${name}`, { bytes: item.bytes, sha256: item.sha256 }])) };
  const altered = Buffer.from(await readFile(join(published, 'receipt.json')));
  altered[0] ^= 1;
  const outputDir = await mkdtemp(join(tmpdir(), 'northwind-evidence-'));
  try {
    const fetchFile = async (url: string) => {
      const path = new URL(url).pathname;
      const body = path.endsWith('/metadata/checksums.json') ? Buffer.from(JSON.stringify(manifest))
        : path.endsWith('/README-public-orders-evidence.md') ? await readFile(join(published, 'README.md')) : altered;
      return new Response(body);
    };
    await assert.rejects(publishNorthwindOrdersEvidence({ fetchFile, outputDir }), /content disagrees with publication pin/);
    await assert.rejects(stat(join(outputDir, 'receipt.json')), { code: 'ENOENT' });
  } finally { await rm(outputDir, { recursive: true, force: true }); }
});
