import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
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
  const receiptName = 'public-orders-evidence-2026-10-16.json';
  assert.match(page, new RegExp(`/evidence/public-orders/${receiptName}`));
  assert.match(page, /\/evidence\/public-orders\/source-rights\.json/);
  assert.match(page, /\/evidence\/public-orders\/README\.md/);
  const receipt = JSON.parse(await readFile(join(published, receiptName), 'utf8'));
  const rights = JSON.parse(await readFile(join(published, 'source-rights.json'), 'utf8'));
  const descriptor = JSON.parse(await readFile(join(root, 'dist/northwind/ovdb-database.json'), 'utf8'));
  assert.ok(descriptor.recordsets.some((recordset: { name: string }) => recordset.name === 'Orders'));
  const expectedSource = { serverId: descriptor.serverId, databaseId: descriptor.localId, recordset: 'Orders' };
  const expectedSourceId = `ovdb:${encodeURIComponent(descriptor.serverId)}/${encodeURIComponent(descriptor.localId)}/Orders`;
  assert.equal(rights.format, 'demodb-observed-source-rights/v1');
  assert.deepEqual(rights.usedSourceIds, [expectedSourceId]);
  assert.equal(rights.admission.endpoint, receipt.sources.sqlite.endpoint);
  assert.equal(rights.admission.querySha256, receipt.sources.sqlite.querySha256);
  assert.equal(rights.admission.canonicalRowsSha256, receipt.sources.sqlite.canonicalRowsSha256);
  assert.equal(rights.admission.rows, 830);
  assert.equal(rights.admission.complete, true);
  assert.equal(rights.admission.executionSourcesPresent, false);
  assert.deepEqual(rights.admission.fields, receipt.sources.sqlite.fields);
  assert.equal(rights.sourceRights[0].sourceId, rights.usedSourceIds[0]);
  assert.deepEqual(rights.sourceRights[0].source, expectedSource);
  assert.deepEqual(rights.sourceRights[0].declaredAt, rights.sourceRights[0].source);
  assert.equal(rights.sourceRights[0].evidenceOrigin, 'publisher-verified');
  assert.equal(rights.sourceRights[0].declaration.spdx, 'MIT');
  assert.equal(rights.receipt.sha256, digest(await readFile(join(published, receiptName))));
  const readme = await readFile(join(published, 'README.md'), 'utf8');
  const links = [...readme.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]);
  assert.ok(links.includes(receiptName), 'the source README links to the published original receipt filename');
  assert.ok(links.includes('source-rights.json'), 'the source README links to the published rights declaration');
  for (const link of links) {
    const target = new URL(link, 'https://northwind.demodb.dev/evidence/public-orders/');
    if (target.origin === 'https://northwind.demodb.dev') {
      const file = join(root, 'dist/_db/northwind', target.pathname);
      assert.ok((await stat(file)).isFile(), `README target ${link} exists in the built site`);
    } else {
      assert.equal(target.origin, 'https://github.com');
      assert.equal(target.pathname, '/demo-db/northwind/blob/de7f81c591abccc30fb9a0a58f44be9fd7265cd6/scripts/verify-public-orders.py');
    }
  }

  // Served Worker-less from the northwind.demodb.dev static bundle: the files sit at their public paths and
  // one _headers rule gives them read-only CORS and a cross-origin resource policy (simple GETs need no preflight).
  const host = join(root, 'dist-hosts/northwind.demodb.dev');
  const paths = ['/evidence/public-orders/', `/evidence/public-orders/${receiptName}`, '/evidence/public-orders/README.md', '/evidence/public-orders/source-rights.json'];
  for (const path of paths) {
    const file = join(host, path.endsWith('/') ? `${path}index.html` : path);
    assert.deepEqual(await readFile(file), await readFile(join(root, 'dist/_db/northwind', path.endsWith('/') ? `${path}index.html` : path)), path);
  }
  const headers = await readFile(join(host, '_headers'), 'utf8');
  const rule = headers.split('\n\n').find((block) => block.startsWith('/evidence/public-orders/*\n'));
  assert.ok(rule, 'the evidence files have their own header rule');
  assert.match(rule, /^  Access-Control-Allow-Origin: \*$/m);
  assert.match(rule, /^  Access-Control-Allow-Methods: GET, HEAD$/m);
  assert.match(rule, /^  Cross-Origin-Resource-Policy: cross-origin$/m);
});

test('publication fails closed if pinned evidence bytes change', async () => {
  const manifest = { files: Object.fromEntries(Object.entries(ORDERS_EVIDENCE_ASSETS).map(([name, item]) => [`artifacts/hosting-imports/${name}`, { bytes: item.bytes, sha256: item.sha256 }])) };
  const altered = Buffer.from(await readFile(join(published, 'public-orders-evidence-2026-10-16.json')));
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
    await assert.rejects(stat(join(outputDir, 'public-orders-evidence-2026-10-16.json')), { code: 'ENOENT' });
  } finally { await rm(outputDir, { recursive: true, force: true }); }
});
