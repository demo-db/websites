// The verified dialect scripts: the pin of the generator, the guard that regenerates only when an input changes, and the checks of the
// committed provider files that need neither the datatug binary nor Docker. Runs in `pnpm test` and uses only synthetic providers.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  MANIFEST_FORMAT, canonicalJson, checkProvider, describeStored, encodeScript, generateProvider, inputsOf, inputsSha256Of, loadConfig,
  scriptProblems, serializeJson, validateConfig, verifyRelease,
} from './dialect-scripts.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const config = await loadConfig();
const spec = config.dialects.mysql;
const scratch = [];
after(() => Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true }))));
const clone = (value) => structuredClone(value);

// --- the pin of the generator --------------------------------------------------------------------------------

test('the committed config is valid, pins an exact release and names every asset by SHA-256', () => {
  validateConfig(config);
  assert.match(config.generator.tag, /^v\d+\.\d+\.\d+$/);
  assert.notEqual(config.generator.tag, 'latest');
  for (const asset of Object.values(config.generator.assets)) assert.match(asset.sha256, /^[0-9a-f]{64}$/);
  assert.equal(config.edition, 'DemoDB contract edition, identical to the SQLite/CSV/JSON');
});

test('validateConfig refuses latest, a missing pin and a download base of another release', () => {
  const bad = (change, pattern) => { const next = clone(config); change(next); assert.throws(() => validateConfig(next), pattern); };
  bad((next) => { next.generator.tag = 'latest'; }, /exact release tag/);
  bad((next) => { next.generator.tag = 'v0.97'; }, /exact release tag/);
  bad((next) => { delete next.generator.checksumsSha256; }, /checksumsSha256/);
  bad((next) => { next.generator.downloadBase = 'https://github.com/datatug/datatug/releases/download/v0.90.0'; }, /must end with the tag/);
  bad((next) => { next.generator.downloadBase = 'https://example.com/v0.97.1'; }, /downloadBase/);
  bad((next) => { next.generator.assets['linux-x64'].sha256 = 'abc'; }, /assets\.linux-x64/);
  bad((next) => { next.generator.assets = {}; }, /assets is empty/);
  bad((next) => { next.edition = ''; }, /edition/);
});

test('verifyRelease fails closed on a changed checksums file, a changed asset and an asset the pins do not know', () => {
  const asset = Buffer.from('pretend release asset');
  const name = 'datatug_0.97.1_linux_amd64.tar.gz';
  const local = clone(config);
  local.generator.assets['linux-x64'] = { name, sha256: sha(asset) };
  const checksums = `${sha(asset)}  ${name}\n${'0'.repeat(64)}  other.tar.gz\n`;
  local.generator.checksumsSha256 = sha(Buffer.from(checksums));
  assert.doesNotThrow(() => verifyRelease(local, checksums, name, asset));
  assert.throws(() => verifyRelease(local, `${checksums}x`, name, asset), /does not match its pinned SHA-256/);
  assert.throws(() => verifyRelease(local, checksums, name, Buffer.from('tampered')), /SHA-256 is/);
  assert.throws(() => verifyRelease(local, checksums, 'datatug_0.97.1_plan9.tar.gz', asset), /not one of the pinned/);
  const disagree = clone(local);
  disagree.generator.assets['linux-x64'].sha256 = sha(Buffer.from('another'));
  assert.throws(() => verifyRelease(disagree, checksums, name, asset), /not the one in/);
});

// --- encoding ------------------------------------------------------------------------------------------------

test('encodeScript stores a script plain up to 25 MiB and as deterministic gzip above it', () => {
  const small = encodeScript('t', 'mysql', config, Buffer.from('-- x\n'));
  assert.equal(small.mode, 'plain');
  assert.deepEqual([...small.files.keys()], ['dialect-scripts/t.mysql.sql']);
  const big = Buffer.alloc(25 * 1024 * 1024 + 1, 'a');
  const first = encodeScript('t', 'mysql', config, big);
  assert.equal(first.mode, 'gzip');
  assert.deepEqual([...first.files.keys()], ['dialect-scripts/t.mysql.sql.gz']);
  const [encoded] = [...first.files.values()];
  assert.deepEqual([...encoded.subarray(4, 8)], [0, 0, 0, 0], 'zero timestamp');
  assert.deepEqual(encoded, [...encodeScript('t', 'mysql', config, big).files.values()][0], 'repeatable');
});

// --- a synthetic provider ------------------------------------------------------------------------------------

const ATTRIBUTION = 'Demo; data by A & B (c) 2026, https://example.org/x?y=1';
const SQLITE = Buffer.from('not really sqlite, only bytes with a pinned hash');

function scriptFor({ id = 'demo', inputs, body = ['CREATE TABLE `t` (', '  `a` BIGINT NOT NULL', ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;', 'INSERT INTO `t` VALUES', '(1);'] }) {
  return Buffer.from([
    `-- ${inputs.edition}`, `-- Dataset: ${id}`,
    `-- Generated by datatug ${inputs.generator.tag} (datatug db copy --to sqlscript:///<file>.sql?dialect=mysql) from a SQLite file with SHA-256 ${inputs.sqliteSha256}`,
    `-- Licence: ${inputs.license}`, `-- Attribution: ${inputs.attribution}`, '--',
    '--   mysql --default-character-set=utf8mb4 --skip-commands --skip-system-command --database <name> < <file>.sql', '',
    'SET NAMES utf8mb4;', `CREATE TABLE \`${spec.marker}\` (\`dataset\` VARCHAR(255) NOT NULL);`, '',
    ...body, `INSERT INTO \`${spec.marker}\` VALUES ('${id}', 'x', '${inputs.sqliteSha256}', '${inputs.generator.tag}', 1, 1);`, '-- end of script', '',
  ].join('\n'));
}

async function syntheticProvider({ license = 'MIT', gzip = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'demodb-dialect-test-'));
  scratch.push(dir);
  const manifest = { id: 'demo', source: { databaseSha256: sha(SQLITE), license }, dataFile: 'data-source/source.sqlite' };
  await mkdir(join(dir, 'data-source'), { recursive: true });
  await mkdir(join(dir, 'dialect-scripts'), { recursive: true });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(dir, 'data-source/source.sqlite'), SQLITE);
  const inputs = inputsOf({ manifest, config, dialect: 'mysql', attribution: ATTRIBUTION });
  const script = scriptFor({ inputs });
  const encoded = gzip ? { mode: 'gzip', files: new Map([['dialect-scripts/demo.mysql.sql.gz', gzipSync(script)]]) } : encodeScript('demo', 'mysql', config, script);
  for (const [path, content] of encoded.files) await writeFile(join(dir, path), content);
  const report = Buffer.from(serializeJson({ warnings: [] }));
  await writeFile(join(dir, 'dialect-scripts/demo.mysql.report.json'), report);
  const stored = describeStored(encoded.mode, encoded.files, script);
  const dialectManifest = {
    format: MANIFEST_FORMAT, id: 'demo', attribution: ATTRIBUTION,
    scripts: { mysql: { inputs, inputsSha256: inputsSha256Of(inputs), report: { bytes: report.length, path: 'dialect-scripts/demo.mysql.report.json', sha256: sha(report), warnings: {} }, stored } },
  };
  await writeFile(join(dir, 'dialect-scripts/manifest.json'), serializeJson(dialectManifest));
  return { dir, manifest, inputs, script, dialectManifest };
}
const rewriteManifest = async (dir, change) => {
  const path = join(dir, 'dialect-scripts/manifest.json');
  const value = JSON.parse(await readFile(path, 'utf8'));
  change(value);
  await writeFile(path, serializeJson(value));
};

test('a consistent provider passes the check, plain or gzip', async () => {
  for (const gzip of [false, true]) {
    const { dir } = await syntheticProvider({ gzip });
    assert.deepEqual(await checkProvider(dir, config), [], gzip ? 'gzip' : 'plain');
  }
});

test('the check fails when a stored byte, the licence, the attribution or the SQLite pin changed', async () => {
  const { dir, script } = await syntheticProvider();
  await writeFile(join(dir, 'dialect-scripts/demo.mysql.sql'), Buffer.concat([script.subarray(0, 100), Buffer.from('X'), script.subarray(101)]));
  assert.match((await checkProvider(dir, config)).join('\n'), /does not match the manifest/);

  const licensed = await syntheticProvider({ license: 'MIT' });
  const manifest = JSON.parse(await readFile(join(licensed.dir, 'manifest.json'), 'utf8'));
  manifest.source.license = 'CC-BY-SA-3.0';
  await writeFile(join(licensed.dir, 'manifest.json'), JSON.stringify(manifest));
  assert.match((await checkProvider(licensed.dir, config)).join('\n'), /inputs changed/, 'a licence change makes the script stale');

  const attributed = await syntheticProvider();
  await rewriteManifest(attributed.dir, (value) => { value.attribution = 'someone else'; });
  assert.match((await checkProvider(attributed.dir, config)).join('\n'), /inputs changed/);

  const pinned = await syntheticProvider();
  const m = JSON.parse(await readFile(join(pinned.dir, 'manifest.json'), 'utf8'));
  m.source.databaseSha256 = sha(Buffer.from('another fixture'));
  await writeFile(join(pinned.dir, 'manifest.json'), JSON.stringify(m));
  assert.match((await checkProvider(pinned.dir, config)).join('\n'), /inputs changed/, 'a new SQLite fixture makes the script stale');
});

test('a recorded verification must be for the stored script', async () => {
  const { dir } = await syntheticProvider();
  await rewriteManifest(dir, (value) => { value.scripts.mysql.verification = { scriptSha256: '0'.repeat(64) }; });
  assert.match((await checkProvider(dir, config)).join('\n'), /verification is for another script/);
});

test('the script checks: label, licence, attribution, marker table, completion, CR, BOM and foreign line starts', () => {
  const inputs = inputsOf({ manifest: { id: 'demo', source: { databaseSha256: sha(SQLITE), license: 'MIT' } }, config, dialect: 'mysql', attribution: ATTRIBUTION });
  const good = scriptFor({ inputs });
  const check = (bytes) => scriptProblems(bytes, { id: 'demo', inputs, spec }).join('\n');
  assert.equal(check(good), '');
  const text = good.toString();
  assert.match(check(Buffer.from(text.replace('-- DemoDB contract edition', '-- Some edition'))), /contract-edition label/);
  assert.match(check(Buffer.from(text.replace('-- Licence: MIT', '-- Licence: GPL-3.0'))), /licence of the provider manifest/);
  assert.match(check(Buffer.from(text.replace(ATTRIBUTION, 'x'))), /attribution/);
  assert.match(check(Buffer.from(text.replace(`CREATE TABLE \`${spec.marker}\``, 'CREATE TABLE `other`'))), /marker table/);
  assert.match(check(Buffer.from(text.replace('-- end of script', ''))), /completion comment/);
  assert.match(check(Buffer.from(text.replaceAll('\n', '\r\n'))), /CR byte/);
  assert.match(check(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), good])), /byte order mark/);
  assert.match(check(Buffer.concat([good, Buffer.from([0xff])])), /UTF-8/);
  // C1: no data byte can start a script line. A client command or a batch separator at a line start is refused.
  for (const hostile of ['GO', '\\! touch /tmp/x', 'source /etc/passwd', '/', 'DELIMITER //', 'USE other;']) {
    assert.match(check(Buffer.from(text.replace('(1);', `(1);\n${hostile}`))), /starts with something the exporter never writes/, hostile);
  }
});

// --- the guard and the exporter run ---------------------------------------------------------------------------

test('generate does nothing when the inputs hash is unchanged and never needs the binary', async () => {
  const { dir } = await syntheticProvider();
  const outcome = await generateProvider({ dir, config, getBinary: async () => { throw new Error('the binary must not be needed'); } });
  assert.equal(outcome, 'unchanged');
});

async function fakeDatatug(dir, { exitCode = 0 } = {}) {
  const path = join(dir, 'fake-datatug.mjs');
  await writeFile(path, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const to = new URL(args[args.indexOf('--to') + 1]);
const p = to.searchParams;
const from = args[args.indexOf('--from') + 1].replace('sqlite://', '');
const sha = ${JSON.stringify(sha(SQLITE))};
if (readFileSync(from).length === 0) process.exit(9);
const out = decodeURIComponent(to.pathname);
const lines = [
  '-- ' + p.get('edition'), '-- Dataset: ' + p.get('name'),
  '-- Generated by datatug ${config.generator.tag} (datatug db copy --to sqlscript:///<file>.sql?dialect=mysql) from a SQLite file with SHA-256 ' + sha,
  '-- Licence: ' + p.get('license'), '-- Attribution: ' + p.get('attribution'), '--',
  '--   mysql --default-character-set=utf8mb4 --skip-commands --skip-system-command', '',
  'SET NAMES utf8mb4;', 'CREATE TABLE \`${spec.marker}\` (\`dataset\` VARCHAR(255) NOT NULL);', '',
  "INSERT INTO \`${spec.marker}\` VALUES ('" + p.get('name') + "', 'x', '" + sha + "', '${config.generator.tag}', 0, 0);", '-- end of script', ''];
writeFileSync(out, lines.join('\\n'));
console.log(JSON.stringify({ command: 'db copy', exitCode: ${exitCode}, tables: [], totals: { rows: 0 }, warnings: [{ kind: 'view-not-carried', object: 'v', message: 'm' }] }));
`);
  await chmod(path, 0o755);
  return path;
}

test('a changed input runs the pinned exporter with every parameter intact (; & and spaces survive) and rewrites the stored bytes', async () => {
  const { dir } = await syntheticProvider();
  const manifestPath = join(dir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.source.license = 'CC-BY-SA-3.0';
  await writeFile(manifestPath, JSON.stringify(manifest));
  const binary = await fakeDatatug(dir);
  const outcome = await generateProvider({ dir, config, getBinary: async () => binary });
  assert.equal(outcome, 'rewritten');
  assert.deepEqual(await checkProvider(dir, config), []);
  const script = (await readFile(join(dir, 'dialect-scripts/demo.mysql.sql'))).toString();
  assert.ok(script.includes(`-- Attribution: ${ATTRIBUTION}`), 'the attribution reached the header unchanged');
  assert.ok(script.includes('-- Licence: CC-BY-SA-3.0'));
  const report = JSON.parse(await readFile(join(dir, 'dialect-scripts/demo.mysql.report.json'), 'utf8'));
  assert.deepEqual(report.warnings, [{ kind: 'view-not-carried', message: 'm', object: 'v' }]);
  assert.ok(!JSON.stringify(report).includes(tmpdir()), 'the report holds no local path');
  assert.equal(await generateProvider({ dir, config, getBinary: async () => { throw new Error('unchanged inputs never run the exporter'); } }), 'unchanged');
});

test('a regeneration that reproduces the same script keeps the stored bytes and the recorded verification', async () => {
  const { dir } = await syntheticProvider();
  const binary = await fakeDatatug(dir);
  assert.equal(await generateProvider({ dir, config, force: true, getBinary: async () => binary }), 'rewritten', 'the synthetic script differs from the fake exporter output');
  await rewriteManifest(dir, (value) => { value.scripts.mysql.verification = { scriptSha256: value.scripts.mysql.stored.decodedSha256, differences: 0 }; });
  const before = await readFile(join(dir, 'dialect-scripts/demo.mysql.sql'));
  assert.equal(await generateProvider({ dir, config, force: true, getBinary: async () => binary }), 'regenerated');
  assert.deepEqual(await readFile(join(dir, 'dialect-scripts/demo.mysql.sql')), before);
  assert.equal(JSON.parse(await readFile(join(dir, 'dialect-scripts/manifest.json'), 'utf8')).scripts.mysql.verification.differences, 0);
});

test('a failing exporter fails the run and leaves the provider as it was', async () => {
  const { dir } = await syntheticProvider();
  const before = await readFile(join(dir, 'dialect-scripts/manifest.json'));
  const binary = await fakeDatatug(dir, { exitCode: 3 });
  await assert.rejects(generateProvider({ dir, config, force: true, getBinary: async () => binary }), /exit code 3/);
  assert.deepEqual(await readFile(join(dir, 'dialect-scripts/manifest.json')), before);
});

test('generate needs an attribution written by the provider', async () => {
  const { dir } = await syntheticProvider();
  await rewriteManifest(dir, (value) => { delete value.attribution; });
  await assert.rejects(generateProvider({ dir, config, getBinary: async () => '' }), /attribution/);
});

test('canonicalJson ignores key order', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
});

// --- the workflows ---------------------------------------------------------------------------------------------

test('the live workflow is path-filtered, unscheduled, pins its actions and loads the image the config pins by digest; the required lane runs the Docker-free check', async () => {
  const { parse } = await import('yaml');
  const root = new URL('..', import.meta.url).pathname;
  const live = parse(await readFile(join(root, '.github/workflows/served-formats-live.yml'), 'utf8'));
  assert.ok(!live.on.schedule, 'no scheduled workflow');
  assert.ok(live.on.pull_request.paths.includes('config/dialect-scripts.json') && live.on.push.paths.includes('scripts/dialect-scripts.mjs'), 'path filters');
  assert.equal(live.permissions.contents, 'read');
  for (const job of Object.values(live.jobs)) for (const step of job.steps.filter((item) => item.uses)) assert.match(step.uses, /@[0-9a-f]{40}(?:\s|$)/, `unpinned action: ${step.uses}`);
  const commands = Object.values(live.jobs).flatMap((job) => job.steps.map((step) => step.run ?? '')).join('\n');
  assert.match(commands, /dialect-scripts\.mjs regenerate-check/);
  assert.match(commands, /verify-mysql-live\.mjs/);
  assert.match(spec.serverImage, /^mysql:8\.4@sha256:[0-9a-f]{64}$/, 'the server image is pinned by digest');
  const deploy = parse(await readFile(join(root, '.github/workflows/deploy.yml'), 'utf8'));
  const required = deploy.jobs['served-formats'].steps.map((step) => step.run ?? '').join('\n');
  assert.match(required, /dialect-scripts\.mjs check --providers/, 'the required served-formats job checks the scripts without Docker');
  assert.ok(!/docker|regenerate-check/.test(required.match(/dialect-scripts[^\n]*/g)?.join('\n') ?? ''), 'and without the datatug binary');
  assert.deepEqual(Object.keys(deploy.jobs), ['verified-postgresql-state', 'served-formats', 'deploy'], 'no job was added to or removed from the required workflow');
});
