// Runs the built Worker under workerd and checks that pre-gzipped data files are
// served once: curl --compressed must decode them to the source bytes. It also
// checks the cross-origin resource policy on successful per-dataset downloads.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const root = new URL('..', import.meta.url).pathname;
const providerIndex = JSON.parse(await readFile(join(root, 'src/data/generated/index.json'), 'utf8'));
const adventureworks = providerIndex.databases.find((database) => database.id === 'adventureworks');
const sqlite = adventureworks.exports.find((file) => file.publicPath === 'adventureworks.sqlite' && file.format === 'sqlite' && file.table === null);
const sql = adventureworks.exports.find((file) => file.publicPath === 'adventureworks.sql' && file.format === 'sql');
assert.equal(sqlite.decodedBytes, 126820352, 'the pinned SQLite export size is the expected size');

const port = await new Promise((resolve, reject) => {
  const probe = createServer().listen(0, '127.0.0.1', () => {
    const { port: free } = probe.address();
    probe.close(() => resolve(free));
  });
  probe.on('error', reject);
});

const wrangler = spawn(join(root, 'node_modules/.bin/wrangler'), ['dev', '--env', 'local', '--ip', '127.0.0.1', '--port', String(port)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
wrangler.stdout.on('data', (chunk) => { output += chunk; });
wrangler.stderr.on('data', (chunk) => { output += chunk; });
const deadline = Date.now() + 120_000;
while (!output.includes('Ready on') && wrangler.exitCode === null && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 200));
}
assert.ok(output.includes('Ready on'), `wrangler dev did not start:\n${output}`);
test.after(async () => {
  wrangler.kill('SIGTERM');
  await once(wrangler, 'exit').catch(() => {});
});

const dir = await mkdtemp(join(tmpdir(), 'demodb-workerd-'));
test.after(() => rm(dir, { recursive: true, force: true }));

// curl --compressed decodes Content-Encoding exactly once, like a browser would.
function fetchDecoded(name, path) {
  const bodyFile = join(dir, `${name}.body`);
  const headerFile = join(dir, `${name}.headers`);
  const result = spawnSync('curl', [
    '--silent', '--show-error', '--fail', '--compressed',
    '--resolve', `adventureworks.localhost:${port}:127.0.0.1`,
    '-D', headerFile, '-o', bodyFile,
    `http://adventureworks.localhost:${port}${path}`,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, `curl ${path} failed: ${result.stderr}`);
  return Promise.all([readFile(bodyFile), readFile(headerFile, 'utf8')]);
}

test('chunked gzip SQLite download decodes to the source database bytes', async () => {
  const [body, headers] = await fetchDecoded('sqlite', '/data/adventureworks.sqlite');
  assert.equal(body.length, 126820352, 'decoded length matches the pinned SQLite export');
  assert.equal(body.subarray(0, 16).toString('latin1'), 'SQLite format 3\0', 'decoded bytes are a SQLite database');
  assert.match(headers, /^cross-origin-resource-policy: cross-origin$/im, 'successful data download allows cross-origin embedding');
});

test('single gzip SQL asset decodes to its source bytes', async () => {
  const [body, headers] = await fetchDecoded('sql', '/data/adventureworks.sql');
  assert.equal(body.length, sql.decodedBytes, 'decoded length matches the pinned SQL export');
  assert.notDeepEqual(body.subarray(0, 2), Buffer.from([0x1f, 0x8b]), 'the response is not still gzip');
  assert.match(headers, /^cross-origin-resource-policy: cross-origin$/im);
});

// Every complete-database download of the largest dataset, including the generated JSON, YAML, PostgreSQL script and
// inGitDB archive, is served once-decoded with exactly the size and SHA-256 that corpus.json declares.
test('every complete AdventureWorks download is served with its declared decoded size and SHA-256', async () => {
  const complete = adventureworks.exports.filter((file) => file.table === null && file.format !== 'metadata');
  assert.deepEqual(complete.map((file) => file.format).sort(), ['ingitdb', 'json', 'postgresql', 'sql', 'sqlite', 'yaml']);
  for (const file of complete) {
    const [body, headers] = await fetchDecoded(`all-${file.format}`, `/data/${file.publicPath}`);
    assert.equal(body.length, file.decodedBytes ?? file.bytes, `${file.publicPath}: decoded length`);
    assert.equal(createHash('sha256').update(body).digest('hex'), file.decodedSha256 ?? file.sha256, `${file.publicPath}: decoded SHA-256`);
    assert.match(headers, /^HTTP\/[\d.]+ 200/m, file.publicPath);
    if (file.format === 'ingitdb') assert.match(headers, /^content-type: application\/zip$/im, 'the archive is served as a ZIP');
  }
});
