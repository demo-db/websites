// The verified dialect scripts: the pin of the generator, the guard that regenerates only when an input changes, and the checks of the
// committed provider files that need neither the datatug binary nor Docker. Runs in `pnpm test` and uses only synthetic providers.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import {
  MANIFEST_FORMAT, canonicalJson, checkProvider, describeStored, encodeScript, generateProvider, inputsOf, inputsSha256Of, loadConfig,
  scriptProblems, serializeJson, validateConfig, verifyRelease, literalProblems, classifyPin, pinProblems, recordVerification, ensureDatatug, expectedNoticeLines,
  noticeOf, KNOWN_DIALECTS, ORACLE_MAX_LINE, ORACLE_PREAMBLE,
  scriptedDatasetIds,
} from './dialect-scripts.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const committed = await loadConfig();
const matrix = JSON.parse(await readFile(new URL('../config/format-matrix.json', import.meta.url), 'utf8'));
// The synthetic providers below have no notice file: the notice is switched off for them and tested on its own.
const config = { ...structuredClone(committed), notice: { enabled: false, dir: 'config/dialect-notices', param: null } };
const spec = config.dialects.mysql;
const scratch = [];
after(() => Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true }))));
const clone = (value) => structuredClone(value);

test('bulk dialect checks select only providers with declared generated scripts', () => {
  const databases = [{ id: 'ready' }, { id: 'sqlite-only' }, { id: 'native-only' }];
  const formats = {
    datasets: {
      ready: { mysql: { state: 'download', origin: 'provider-script' }, sqlserver: { state: 'download', origin: 'provider-script' } },
      'sqlite-only': { mysql: { state: 'unavailable' }, sqlserver: { state: 'unavailable' } },
      'native-only': { mysql: { state: 'unavailable' }, sqlserver: { state: 'unavailable' } },
    },
  };
  assert.deepEqual(scriptedDatasetIds(databases, formats, ['mysql', 'sqlserver']), ['ready']);
});

// --- the pin of the generator --------------------------------------------------------------------------------

test('the committed config is valid, pins an exact release and names every asset by SHA-256, and passes the licence notice to the exporter', () => {
  validateConfig(committed);
  assert.match(committed.generator.tag, /^v\d+\.\d+\.\d+$/);
  assert.equal(committed.generator.tag, 'v0.103.4', 'the release that carries dialect=mssql and dialect=oracle');
  assert.equal(committed.generator.checksumsSha256, '32c36126ec6c8961a7b493c21f18b63ecb0146faff84089d89566a659fd975fd');
  assert.deepEqual(Object.keys(committed.dialects), ['mysql', 'mssql', 'oracle']);
  assert.deepEqual(Object.values(committed.dialects).map((dialect) => dialect.format), ['mysql', 'sqlserver', 'oracle']);
  assert.deepEqual(Object.values(committed.dialects).map((dialect) => dialect.extension), ['mysql.sql', 'sqlserver.sql', 'oracle.sql']);
  for (const dialect of Object.values(committed.dialects)) assert.match(dialect.serverImage, /^[\w./-]+:[\w.-]+@sha256:[0-9a-f]{64}$/, 'every engine image is pinned by digest');
  assert.deepEqual(KNOWN_DIALECTS, Object.keys(committed.dialects), 'every configured dialect has a script check');
  assert.notEqual(committed.generator.tag, 'latest');
  for (const asset of Object.values(committed.generator.assets)) assert.match(asset.sha256, /^[0-9a-f]{64}$/);
  assert.equal(committed.edition, 'DemoDB contract edition, identical to the SQLite/CSV/JSON');
  assert.deepEqual([committed.notice.enabled, committed.notice.param], [true, 'notice-file']);
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
  const name = `datatug_${config.generator.tag.slice(1)}_linux_amd64.tar.gz`;
  const local = clone(config);
  local.generator.assets['linux-x64'] = { name, sha256: sha(asset) };
  const checksums = `${sha(asset)}  ${name}\n${'0'.repeat(64)}  other.tar.gz\n`;
  local.generator.checksumsSha256 = sha(Buffer.from(checksums));
  assert.doesNotThrow(() => verifyRelease(local, checksums, name, asset));
  assert.throws(() => verifyRelease(local, `${checksums}x`, name, asset), /does not match its pinned SHA-256/);
  assert.throws(() => verifyRelease(local, checksums, name, Buffer.from('tampered')), /SHA-256 is/);
  assert.throws(() => verifyRelease(local, checksums, `datatug_${config.generator.tag.slice(1)}_plan9.tar.gz`, asset), /not one of the pinned/);
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

const verificationFor = (stored) => ({ scriptSha256: stored.decodedSha256, differences: 0, rows: 1, tables: 1, secondLoadRefusedAtMarkerTable: true });

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
    scripts: { mysql: { verification: verificationFor(stored), inputs, inputsSha256: inputsSha256Of(inputs), report: { bytes: report.length, path: 'dialect-scripts/demo.mysql.report.json', sha256: sha(report), warnings: {} }, stored } },
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

test('the check requires a clean recorded verification of this very script', async () => {
  const { dir } = await syntheticProvider();
  await rewriteManifest(dir, (value) => { delete value.scripts.mysql.verification; });
  assert.match((await checkProvider(dir, config)).join('\n'), /records no verification/);
  assert.deepEqual(await checkProvider(dir, config, 'mysql', { requireVerification: false }), [], 'only the verification is missing');
  await rewriteManifest(dir, (value) => { value.scripts.mysql.verification = { scriptSha256: value.scripts.mysql.stored.decodedSha256, differences: 2, rows: 1, tables: 1, secondLoadRefusedAtMarkerTable: true }; });
  assert.match((await checkProvider(dir, config)).join('\n'), /not a clean one/);
});

// The reviewer's bypass: edit the script, re-hash the manifest, drop the verification. The check must still refuse every client-command shape.
for (const [name, edit] of [
  ['a command after a semicolon in a line', (text) => text.replace('(1);', '(1);\nCOMMIT; \\! touch /tmp/pwn_mid')],
  ['an indented command', (text) => text.replace('(1);', '(1);\n  \\! touch /tmp/pwn_indent')],
  ['a command inside a value line', (text) => text.replace('(1);', "(1), ('a\\! cmd');")],
  ['a source command in an indented line', (text) => text.replace('(1);', '(1);\n  source /etc/passwd')],
  ['a mid-line comment that hides text', (text) => text.replace('(1);', '(1); -- x')],
  ['a hash comment', (text) => text.replace('(1);', '(1) # x\n;')],
  ['a conditional comment', (text) => text.replace('(1);', '(1) /*! x */;')],
  ['a raw line break inside a string', (text) => text.replace('(1);', "('a\nb');")],
  ['an unterminated string', (text) => text.replace('(1);', "('a);")],
  // `--` is a comment for the mysql client only when white space or the end of the line follows it: these are not comments, and the plain client runs the first one.
  ['a --\\! command line', (text) => text.replace('(1);', '(1);\n--\\! touch /tmp/pwn_dash')],
  ['a --source line', (text) => text.replace('(1);', '(1);\n--source /etc/passwd')],
  ['a --<tab> command line', (text) => text.replace('(1);', '(1);\n--\tsource /etc/passwd')],
  ['a --; line', (text) => text.replace('(1);', '(1);\n--;')],
  ['a --\\! line inside the header', (text) => text.replace('-- Dataset: demo', '--\\! touch /tmp/pwn_header\n-- Dataset: demo')],
  ['a --\\! line between header and statements', (text) => text.replace('\nSET NAMES', '\n--\\! touch /tmp/pwn_gap\nSET NAMES')],
]) {
  test(`the required check refuses ${name}, even when the manifest is re-hashed and carries no verification`, async () => {
    const { dir, script, inputs } = await syntheticProvider();
    const edited = Buffer.from(edit(script.toString()));
    assert.notDeepEqual(edited, script);
    await writeFile(join(dir, 'dialect-scripts/demo.mysql.sql'), edited);
    await rewriteManifest(dir, (value) => {
      const record = value.scripts.mysql;
      record.stored = describeStored('plain', new Map([['dialect-scripts/demo.mysql.sql', edited]]), edited);
      delete record.verification;
      assert.equal(record.inputsSha256, inputsSha256Of(inputs));
    });
    const problems = (await checkProvider(dir, config)).join('\n');
    assert.match(problems, /starts with something the exporter never writes|line \d+: |records no verification/);
    assert.match(problems, /line \d+: |starts with something/, 'the script itself is refused, not only the missing verification');
  });
}

test('only `-- ` and a bare `--` are comment lines', () => {
  const lint = (text) => literalProblems(Buffer.from(text)).join('\n');
  assert.equal(lint('-- ok \\! fine\n--\nSELECT 1;\n'), '');
  for (const hostile of ['--\\! x', '--source x', '--\tx', '--;', '--x']) assert.match(lint(`${hostile}\nSELECT 1;\n`), /not followed by a space or the end of the line/, hostile);
  assert.match(lint('SELECT 1;\n--\\! x\n'), /not followed by a space/);
});

test('a clean script with strings, quoted names and doubled quotes passes the literal lint', () => {
  const ok = Buffer.from("-- c \\ # /* \nINSERT INTO `a``b` VALUES\n(1, 'it''s -- not a comment; \u00e9', _utf8mb4 X'5c21'),\n(2, NULL);\n");
  assert.deepEqual(literalProblems(ok), []);
});

test('the SQLite file of the provider must match its pin when it is present', async () => {
  const { dir } = await syntheticProvider();
  await writeFile(join(dir, 'data-source/source.sqlite'), Buffer.from('changed'));
  assert.match((await checkProvider(dir, config)).join('\n'), /does not decode to the pinned SQLite SHA-256/);
  assert.deepEqual(await checkProvider(dir, config, 'mysql', { checkSqlite: false }), []);
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
  '-- Licence: ' + p.get('license'), '-- Attribution: ' + p.get('attribution'),
  ...(p.get('notice-file') ? ['--', ...readFileSync(p.get('notice-file'), 'utf8').trimEnd().split('\\n').map((l) => l === '' ? '--' : '-- ' + l.replaceAll('\\t', '    '))] : []), '--',
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
  assert.match((await checkProvider(dir, config)).join('\n'), /records no verification/, 'a regenerated script has no verification until one is recorded');
  assert.deepEqual(await checkProvider(dir, config, 'mysql', { requireVerification: false }), []);
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

// --- the provider pins -----------------------------------------------------------------------------------------

test('a pin must be on the provider main: identical and behind pass, ahead only in warn-ahead mode, diverged and API errors never', async () => {
  assert.deepEqual(['identical', 'behind', 'ahead', 'diverged', undefined].map(classifyPin), ['on-main', 'on-main', 'ahead', 'refused', 'refused']);
  const databases = [{ id: 'a', repository: 'https://github.com/demo-db/a', commit: 'c1' }, { id: 'b', repository: 'https://github.com/demo-db/b', commit: 'c2' }];
  const fetchJson = (statuses) => async (url) => {
    const id = url.match(/repos\/demo-db\/(\w)\/compare\/main\.\.\.(\w+)$/);
    assert.ok(id, `compares main with the pinned commit: ${url}`);
    const status = statuses[id[1]];
    if (status === 'error') throw new Error('HTTP 500');
    return { status };
  };
  assert.deepEqual((await pinProblems({ databases, fetchJson: fetchJson({ a: 'identical', b: 'behind' }) })).problems, []);
  const ahead = await pinProblems({ databases, fetchJson: fetchJson({ a: 'identical', b: 'ahead' }) });
  assert.match(ahead.problems.join('\n'), /b: the pinned commit c2 is ahead, not on main/);
  const warn = await pinProblems({ databases, fetchJson: fetchJson({ a: 'identical', b: 'ahead' }), mode: 'warn-ahead' });
  assert.deepEqual(warn.problems, []);
  assert.match(warn.notes.join('\n'), /b: c2 is not on main/);
  assert.match((await pinProblems({ databases, fetchJson: fetchJson({ a: 'diverged', b: 'identical' }), mode: 'warn-ahead' })).problems.join('\n'), /a: the pinned commit c1 is diverged/);
  assert.match((await pinProblems({ databases, fetchJson: fetchJson({ a: 'error', b: 'identical' }), mode: 'warn-ahead' })).problems.join('\n'), /cannot compare c1 with main/);
});

test('the required served-formats job checks the pins, strictly on a push to main', async () => {
  const { parse } = await import('yaml');
  const deploy = parse(await readFile(join(new URL('..', import.meta.url).pathname, '.github/workflows/deploy.yml'), 'utf8'));
  const step = deploy.jobs['served-formats'].steps.find((item) => /check-pins/.test(item.run ?? ''));
  assert.ok(step, 'a check-pins step');
  assert.match(step.env.DEMODB_PIN_MODE, /pull_request.*warn-ahead.*strict/);
  assert.match(step.env.GITHUB_TOKEN, /github\.token/);
});

// --- verification record and the binary cache ------------------------------------------------------------------

test('record-verification stamps the numbers of a clean run onto the stored script and refuses a run with differences', async () => {
  const { dir } = await syntheticProvider();
  await rewriteManifest(dir, (value) => { delete value.scripts.mysql.verification; });
  const result = { tables: 2, rows: 9, valuesCompared: 40, differences: 0, verifierWarnings: 1, engine: 'MySQL 8.4.11', verifier: 'v' };
  await assert.rejects(recordVerification({ dir, config, result: { ...result, differences: 1 } }), /not recorded/);
  await assert.rejects(recordVerification({ dir, config, result: { ...result, rows: NaN } }), /--rows/);
  await recordVerification({ dir, config, result });
  assert.deepEqual(await checkProvider(dir, config), []);
});

test('the datatug cache is hashed again on every use: a changed archive is downloaded again, a changed binary is unpacked again', async () => {
  const work = await mkdtemp(join(tmpdir(), 'demodb-cache-test-'));
  scratch.push(work);
  await mkdir(join(work, 'src'));
  await writeFile(join(work, 'src/datatug'), '#!/bin/sh\necho real\n');
  const name = `datatug_${config.generator.tag.slice(1)}_linux_amd64.tar.gz`;
  spawnSync('tar', ['-czf', join(work, name), '-C', join(work, 'src'), 'datatug']);
  const archive = await readFile(join(work, name));
  const checksums = `${sha(archive)}  ${name}\n`;
  const local = clone(config);
  local.generator.assets['linux-x64'] = { name, sha256: sha(archive) };
  local.generator.checksumsSha256 = sha(Buffer.from(checksums));
  const realFetch = globalThis.fetch;
  let downloads = 0;
  globalThis.fetch = async (url) => { downloads += 1; return new Response(String(url).endsWith('checksums.txt') ? checksums : archive); };
  try {
    const tools = join(work, 'tools');
    const binary = await ensureDatatug(local, tools, 'linux-x64');
    assert.equal(downloads, 2);
    assert.equal((await readFile(binary)).toString(), '#!/bin/sh\necho real\n');
    await ensureDatatug(local, tools, 'linux-x64');
    assert.equal(downloads, 2, 'a verified cache is used without a download');
    await writeFile(binary, 'tampered binary');
    await ensureDatatug(local, tools, 'linux-x64');
    assert.equal(downloads, 2);
    assert.equal((await readFile(binary)).toString(), '#!/bin/sh\necho real\n', 'the binary is unpacked again from the verified archive');
    await writeFile(join(tools, `datatug-${config.generator.tag}-linux-x64`, name), 'tampered archive');
    await ensureDatatug(local, tools, 'linux-x64');
    assert.equal(downloads, 4, 'a changed archive is downloaded and verified again');
  } finally {
    globalThis.fetch = realFetch;
  }
});

// --- the licence notice input ----------------------------------------------------------------------------------

test('a notice input changes the inputs hash and the header must carry the notice, line by line, right after the attribution; off, nothing changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'demodb-notice-test-'));
  scratch.push(dir);
  const notice = 'Copyright (c) 2026 Someone\n\n\tPermission is hereby granted. /* x */\n\n';
  await writeFile(join(dir, 'demo.txt'), notice);
  const withNotice = { ...clone(config), notice: { enabled: true, dir, param: 'notice-file' } };
  const manifest = { id: 'demo', source: { databaseSha256: sha(SQLITE), license: 'MIT' } };
  const off = inputsOf({ manifest, config, dialect: 'mysql', attribution: ATTRIBUTION });
  const on = inputsOf({ manifest, config: withNotice, dialect: 'mysql', attribution: ATTRIBUTION });
  assert.ok(!('noticeSha256' in off) && /^[0-9a-f]{64}$/.test(on.noticeSha256));
  assert.notEqual(inputsSha256Of(on), inputsSha256Of(off));
  // what datatug v0.100.0 writes: tab -> four spaces, "/*" and "*/" split, blank ends dropped, a blank line inside is a bare "--"
  assert.deepEqual(expectedNoticeLines(notice), ['-- Copyright (c) 2026 Someone', '--', '--     Permission is hereby granted. / * x * /']);
  const write = (lines) => scriptFor({ inputs: on }).toString().replace(`-- Attribution: ${ATTRIBUTION}\n--\n`, `-- Attribution: ${ATTRIBUTION}\n--\n${lines.join('\n')}\n--\n`);
  const check = (text) => scriptProblems(Buffer.from(text), { id: 'demo', inputs: on, spec, notice }).join('\n');
  assert.equal(check(write(expectedNoticeLines(notice))), '');
  assert.match(check(scriptFor({ inputs: on }).toString()), /lacks the licence notice line 1/, 'no notice at all');
  const lines = expectedNoticeLines(notice);
  assert.match(check(write(lines.slice(0, 2))), /lacks the licence notice line 3/, 'a notice cut short');
  assert.match(check(write([lines[0], lines[2], lines[1]])), /lacks the licence notice line 2/, 'lines out of order');
  assert.match(check(write(lines.map((line) => line.replace('Someone', 'Some')))), /lacks the licence notice line 1/, 'a changed word');
  assert.match(check(write(lines).replace(`-- Attribution: ${ATTRIBUTION}`, `-- Attribution: ${ATTRIBUTION.slice(0, 20)}...`)), /attribution/, 'a truncated attribution line');
  assert.throws(() => validateConfig({ ...clone(config), notice: { enabled: true, dir, param: null } }), /notice\.param/);
  await writeFile(join(dir, 'demo.txt'), 'bell \u0007\n');
  assert.throws(() => inputsOf({ manifest, config: withNotice, dialect: 'mysql', attribution: ATTRIBUTION }), /LF text/);
  await rm(join(dir, 'demo.txt'));
  assert.throws(() => inputsOf({ manifest, config: withNotice, dialect: 'mysql', attribution: ATTRIBUTION }), /does not exist/);
});

test('an attribution, licence or edition the exporter would cut at 400 bytes or fold is refused before it is generated', () => {
  const manifest = { id: 'demo', source: { databaseSha256: sha(SQLITE), license: 'MIT' } };
  assert.throws(() => inputsOf({ manifest, config, dialect: 'mysql', attribution: 'x'.repeat(400) }), /cuts a header line at 400 bytes/);
  assert.doesNotThrow(() => inputsOf({ manifest, config, dialect: 'mysql', attribution: 'x'.repeat(387) }));
  assert.throws(() => inputsOf({ manifest, config, dialect: 'mysql', attribution: 'two  spaces' }), /one line/);
  assert.throws(() => inputsOf({ manifest, config, dialect: 'mysql', attribution: 'a\nb' }), /one line/);
});

test('the exporter run passes the notice file and the header it writes passes the check', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'demodb-notice-run-'));
  scratch.push(dir);
  await mkdir(join(dir, 'notices'));
  await writeFile(join(dir, 'notices/demo.txt'), 'Copyright (c) 2026 Someone\n\n\tPermission is hereby granted.\n');
  const local = { ...clone(config), notice: { enabled: true, dir: join(dir, 'notices'), param: 'notice-file' } };
  const { dir: provider } = await syntheticProvider();
  const binary = await fakeDatatug(provider);
  assert.equal(await generateProvider({ dir: provider, config: local, force: true, getBinary: async () => binary }), 'rewritten');
  const text = (await readFile(join(provider, 'dialect-scripts/demo.mysql.sql'))).toString();
  assert.ok(text.includes('-- Attribution: ' + ATTRIBUTION + '\n--\n-- Copyright (c) 2026 Someone\n--\n--     Permission is hereby granted.\n--\n'));
  assert.deepEqual(await checkProvider(provider, local, 'mysql', { requireVerification: false }), []);
});

test('the staged licence notices exist for every dataset and carry the text each licence asks to travel', async () => {
  const root = new URL('..', import.meta.url).pathname;
  const ids = JSON.parse(await readFile(join(root, 'config/databases.json'), 'utf8')).databases.map((entry) => entry.id);
  // The last words of each licence are in the list on purpose: a notice cut at a line end (a bad whitespace strip once removed trailing letters) must fail.
const mit = ['Permission is hereby granted, free of charge', 'The above copyright notice and this permission notice shall be included', 'THE SOFTWARE IS PROVIDED "AS IS"', 'DEALINGS IN', 'SOFTWARE.'];
  const need = {
    chinook: ['Copyright (c) 2008-2024 Luis Rocha', ...mit],
    northwind: ['Copyright (c) 2016 JP White', ...mit],
    pubs: ['Copyright Microsoft, Inc. 1994 - 2000', 'Copyright (c) Microsoft Corporation', ...mit],
    adventureworks: ['Copyright (c) Microsoft Corporation', ...mit],
    sakila: ['Copyright (c) 2006, 2026, Oracle and/or its affiliates.', 'Redistributions of source code must retain the above copyright notice', 'Redistributions in binary form must reproduce the above copyright', 'Neither the name of Oracle', 'THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS', 'EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.'],
    employees: ['Copyright (C) 2007,2008, MySQL AB', 'Fusheng Wang and Carlo Zaniolo', 'Giuseppe Maxia', 'Patrick Crews', 'http://creativecommons.org/licenses/by-sa/3.0/', 'https://github.com/datacharmer/test_db', 'Adaptation:', 'Any similarity to existing people is purely coincidental.', 'https://creativecommons.org/licenses/by-sa/3.0/legalcode'],
  };
  const scriptedIds = ids.filter((id) => Object.values(matrix.datasets[id]).some((cell) => cell.state === 'download' && cell.origin === 'provider-script'));
  assert.deepEqual(Object.keys(need).sort(), scriptedIds.sort());
  for (const id of scriptedIds) {
    const text = await readFile(join(root, 'config/dialect-notices', `${id}.txt`), 'utf8');
    assert.ok(text.endsWith('\n') && !text.includes('\r') && !text.includes('\0'), `${id}: LF text`);
    for (const phrase of need[id]) assert.ok(text.includes(phrase), `${id}: the notice carries "${phrase}"`);
    assert.ok(text.split('\n').every((line) => line === line.trimEnd()), `${id}: no trailing whitespace`);
  }
});

// --- SQL Server and Oracle -------------------------------------------------------------------------------------

// A minimal script in the shape each dialect's exporter writes (see the committed provider scripts): header, prelude, marker table first, a table,
// its rows, the marker row last.
const BOM_BYTES = Buffer.from([0xef, 0xbb, 0xbf]);
function dialectScriptFor({ dialect, id = 'demo', inputs }) {
  const header = (hint) => [
    `-- ${inputs.edition}`, `-- Dataset: ${id}`,
    `-- Generated by datatug ${inputs.generator.tag} (datatug db copy --to sqlscript:///<file>.sql?dialect=${dialect}) from a SQLite file with SHA-256 ${inputs.sqliteSha256}`,
    `-- Licence: ${inputs.license}`, `-- Attribution: ${inputs.attribution}`, '--', `--   ${hint}`, '',
  ];
  if (dialect === 'mssql') {
    return Buffer.concat([BOM_BYTES, Buffer.from([
      ...header('sqlcmd -S <server> -d <database> -X -x -b -f 65001 -i <file>.sql'),
      'SET QUOTED_IDENTIFIER ON; SET ANSI_NULLS ON; SET XACT_ABORT ON; SET NOCOUNT ON;', 'GO', 'BEGIN TRANSACTION;', 'GO',
      'IF @@TRANCOUNT=0 SET NOEXEC ON', 'CREATE TABLE [_demodb_import] ([dataset] NVARCHAR(MAX) NOT NULL);', 'GO',
      'IF @@TRANCOUNT=0 SET NOEXEC ON', 'CREATE TABLE [t] (', '  [a] BIGINT IDENTITY(1,1) NOT NULL,', '  [b] NVARCHAR(50) NULL,', '  PRIMARY KEY ([a])', ');', 'GO',
      'IF @@TRANCOUNT=0 SET NOEXEC ON', 'INSERT INTO [t] ([a], [b]) VALUES', "(1,N'it''s -- not a comment; [x] \\ #'),", '(2,NULL);', 'GO',
      'IF @@TRANCOUNT=0 SET NOEXEC ON', `INSERT INTO [_demodb_import] VALUES (N'${id}', N'x', N'${inputs.sqliteSha256}', N'${inputs.generator.tag}', 1, 2);`, 'GO',
      'IF @@TRANCOUNT=0 SET NOEXEC ON', 'COMMIT TRANSACTION;', 'GO', 'SET NOEXEC OFF;', 'GO', '-- end of script', '',
    ].join('\n'))]);
  }
  return Buffer.from([
    ...header('NLS_LANG=.AL32UTF8 sqlplus -L -S <user>/<password>@<service> @<file>.sql'),
    ...ORACLE_PREAMBLE, 'ALTER SESSION SET NLS_COMP = BINARY NLS_SORT = BINARY;', 'DECLARE', '  n NUMBER;', 'BEGIN', '  SELECT COUNT(*) INTO n FROM DUAL;', 'END;', '/',
    'CREATE TABLE "_demodb_import" ("dataset" VARCHAR2(4000 BYTE));', '',
    'CREATE TABLE "t" (', '  "a" NUMBER(19,0) GENERATED BY DEFAULT AS IDENTITY,', '  "b" VARCHAR2(50 CHAR),', '  PRIMARY KEY ("a")', ');',
    'INSERT INTO "t" ("a", "b") VALUES', "(1,'it''s -- not a comment; & \\ #'),", '(2,NULL);', 'COMMIT;',
    'BEGIN', '  INSERT INTO "_demodb_import" VALUES', `('${id}','x','${inputs.sqliteSha256}','${inputs.generator.tag}',1,2);`, '  COMMIT;', 'END;', '/', '-- end of script', '',
  ].join('\n'));
}

for (const dialect of ['mssql', 'oracle']) {
  const dialectSpec = committed.dialects[dialect];
  const inputsFor = () => inputsOf({ manifest: { id: 'demo', source: { databaseSha256: sha(SQLITE), license: 'MIT' } }, config, dialect, attribution: ATTRIBUTION });
  const lint = (bytes, inputs = inputsFor(), notice = null) => scriptProblems(bytes, { id: 'demo', inputs, spec: dialectSpec, notice }).join('\n');

  test(`${dialect}: a script in the exporter's shape passes the check`, () => {
    assert.equal(lint(dialectScriptFor({ dialect, inputs: inputsFor() })), '');
  });

  test(`${dialect}: the header, the marker table, the marker row and the completion comment are required`, () => {
    const good = dialectScriptFor({ dialect, inputs: inputsFor() });
    const text = (bytes) => bytes.toString('utf8');
    const edit = (change) => Buffer.from(change(text(good)));
    const marker = dialect === 'mssql' ? '[_demodb_import]' : '"_demodb_import"';
    assert.match(lint(edit((t) => t.replace('-- DemoDB contract edition', '-- Some edition'))), /contract-edition label/);
    assert.match(lint(edit((t) => t.replace('-- Licence: MIT', '-- Licence: GPL-3.0'))), /licence of the provider manifest/);
    assert.match(lint(edit((t) => t.replace(ATTRIBUTION, 'x'))), /attribution/);
    assert.match(lint(edit((t) => t.replace(`CREATE TABLE ${marker}`, 'CREATE TABLE "other"'))), /marker table/);
    assert.match(lint(edit((t) => t.replace('-- end of script', ''))), /completion comment/);
    assert.match(lint(edit((t) => t.replace(/SHA-256 [0-9a-f]{64}/, 'SHA-256 0'))), /pinned datatug release/);
    assert.match(lint(edit((t) => t.replace(dialect === 'mssql' ? '-X -x -b -f 65001' : 'NLS_LANG=.AL32UTF8', 'nothing'))), /safe client flags/);
    assert.match(lint(edit((t) => t.replace(/N?'[0-9a-f]{64}'/, "'tampered'"))), /does not fill the marker table/);
    assert.match(lint(edit((t) => t.replaceAll('\n', '\r\n'))), /CR byte/);
    assert.match(lint(Buffer.concat([good, Buffer.from([0xff])])), /UTF-8/);
  });

  // The required lane must refuse what the client would run, even when the manifest is re-hashed: a client command or batch separator at a line start,
  // a comment that hides text, a raw line break inside a literal.
  const hostile = dialect === 'mssql'
    ? [['GO with a repeat count', 'GO 100000'], ['a :r command', ':r /etc/passwd'], ['a !! command', '!! touch /tmp/pwn'], ['EXIT', 'EXIT'], ['QUIT(', 'QUIT'], ['an indented GO', '  GO'], ['a lone :setvar', ':setvar a 1']]
    : [['a @ command', '@/etc/passwd'], ['a @@ command', '@@x.sql'], ['HOST', 'HOST touch /tmp/pwn'], ['EXIT', 'EXIT'], ['a ! command', '! touch /tmp/pwn'], ['REM', 'REM x'], ['PROMPT', 'PROMPT x'], ['an indented @', '  @x.sql'], ['SPOOL', 'SPOOL /tmp/x']];
  for (const [name, line] of hostile) {
    test(`${dialect}: the required check refuses ${name} at a line start`, () => {
      const inputs = inputsFor();
      const good = dialectScriptFor({ dialect, inputs });
      const edited = Buffer.from(good.toString().replace('(2,NULL);', `(2,NULL);\n${line}`));
      assert.notDeepEqual(edited, good);
      assert.match(lint(edited, inputs), /starts with something the exporter never writes/);
    });
  }
  for (const [name, edit] of [
    ['a mid-line comment that hides text', (t) => t.replace('(2,NULL);', '(2,NULL); -- x')],
    ['a block comment', (t) => t.replace('(2,NULL);', '(2,NULL) /* x */;')],
    ['a raw line break inside a string', (t) => t.replace('(2,NULL);', "(2,'a\nb');")],
    ['an unterminated string', (t) => t.replace('(2,NULL);', "(2,'a);")],
    ['a --x line (not a comment for the client)', (t) => t.replace('(2,NULL);', '(2,NULL);\n--x')],
  ]) {
    test(`${dialect}: the required check refuses ${name}`, () => {
      const inputs = inputsFor();
      const edited = Buffer.from(edit(dialectScriptFor({ dialect, inputs }).toString()));
      assert.notEqual(lint(edited, inputs), '');
    });
  }

  test(`${dialect}: the literal lint reads this dialect's quotes and nothing else`, () => {
    const ok = {
      mssql: "-- c $( \\ # /* \nINSERT INTO [a]]b] VALUES\n(1, N'it''s -- not a comment; é \\ #', 0x5c21),\n(2, NULL);\n",
      oracle: "-- c \\ # /* \nINSERT INTO \"a\"\"b\" VALUES\n(1,'it''s -- not a comment; é \\ # &x'),\n(2,NULL);\n",
    }[dialect];
    assert.deepEqual(literalProblems(Buffer.from(ok), dialect), []);
    assert.match(literalProblems(Buffer.from("SELECT 1; -- x\n"), dialect).join(), /-- comment inside a line/);
    assert.match(literalProblems(Buffer.from("SELECT 'a\nb';\n"), dialect).join(), /raw line break/);
  });
}

test('mssql: the byte order mark is required once, and Oracle and MySQL scripts have none', () => {
  const inputs = inputsOf({ manifest: { id: 'demo', source: { databaseSha256: sha(SQLITE), license: 'MIT' } }, config, dialect: 'mssql', attribution: ATTRIBUTION });
  const good = dialectScriptFor({ dialect: 'mssql', inputs });
  const check = (bytes) => scriptProblems(bytes, { id: 'demo', inputs, spec: committed.dialects.mssql }).join('\n');
  assert.equal(check(good), '');
  assert.match(check(good.subarray(3)), /byte order mark of a SQL Server script/);
  assert.match(check(Buffer.concat([good, BOM_BYTES, Buffer.from('\n')])), /byte order mark after its first bytes/);
  const oracleInputs = inputsOf({ manifest: { id: 'demo', source: { databaseSha256: sha(SQLITE), license: 'MIT' } }, config, dialect: 'oracle', attribution: ATTRIBUTION });
  const oracle = dialectScriptFor({ dialect: 'oracle', inputs: oracleInputs });
  assert.match(scriptProblems(Buffer.concat([BOM_BYTES, oracle]), { id: 'demo', inputs: oracleInputs, spec: committed.dialects.oracle }).join('\n'), /starts with a byte order mark/);
});

test('mssql: a $( anywhere outside a comment line is refused (sqlcmd would substitute a variable without -x)', () => {
  const inputs = inputsOf({ manifest: { id: 'demo', source: { databaseSha256: sha(SQLITE), license: 'MIT' } }, config, dialect: 'mssql', attribution: ATTRIBUTION });
  const edited = Buffer.from(dialectScriptFor({ dialect: 'mssql', inputs }).toString().replace('(2,NULL);', "(2,N'$(HOME)');"));
  assert.match(scriptProblems(edited, { id: 'demo', inputs, spec: committed.dialects.mssql }).join('\n'), /\$\(/);
});

test('oracle: SET DEFINE OFF first, no line over 2,300 characters, no statement line ending in a hyphen, no & in the header', () => {
  const inputs = inputsOf({ manifest: { id: 'demo', source: { databaseSha256: sha(SQLITE), license: 'MIT' } }, config, dialect: 'oracle', attribution: ATTRIBUTION });
  const good = dialectScriptFor({ dialect: 'oracle', inputs }).toString();
  const check = (text) => scriptProblems(Buffer.from(text), { id: 'demo', inputs, spec: committed.dialects.oracle }).join('\n');
  assert.equal(check(good), '');
  assert.match(check(good.replace('SET DEFINE OFF\n', '')), /SET DEFINE OFF/);
  assert.match(check(good.replace('(2,NULL);', `(2,'${'x'.repeat(ORACLE_MAX_LINE)}');`)), /longer than 2300 characters/);
  assert.equal(check(good.replace('(2,NULL);', `(2,'${'x'.repeat(ORACLE_MAX_LINE - 8)}');`)), '', 'a line of exactly the limit is fine');
  assert.match(check(good.replace('(2,NULL);', '(2,\n10 -\n3);')), /ends in a hyphen/);
  assert.equal(check(good.replace('--   NLS_LANG', '-- a comment line ending in a hyphen -\n--   NLS_LANG')), '', 'a comment line that ends in a hyphen joins nothing');
  assert.match(check(good.replace('-- Licence: MIT', '-- Licence: MIT\n-- A & B&C')), /holds an & before SET DEFINE OFF/);
  assert.match(check(good.replace('/\nCREATE TABLE "_demodb_import"', '/\n/ \nCREATE TABLE "_demodb_import"')), /starts with something/, 'a / line with anything after it');
});

test('oracle: SQL*Plus host commands cannot ride on the preamble or on a semicolon (reviewer\'s CMDSEP example and variants)', () => {
  const inputs = inputsOf({ manifest: { id: 'demo', source: { databaseSha256: sha(SQLITE), license: 'MIT' } }, config, dialect: 'oracle', attribution: ATTRIBUTION });
  const good = dialectScriptFor({ dialect: 'oracle', inputs }).toString();
  const check = (text) => scriptProblems(Buffer.from(text), { id: 'demo', inputs, spec: committed.dialects.oracle }).join('\n');
  assert.equal(check(good), '');
  const withPreamble = good;
  const hostile = [
    ['the reviewer\'s chained HOST after SET CMDSEP ON', (t) => t.replace('SET CMDSEP OFF', 'SET CMDSEP ON').replace('SET ECHO OFF', 'SET ECHO OFF;HOST touch /tmp/pwn')],
    ['SET CMDSEP ON alone', (t) => t.replace('SET CMDSEP OFF', 'SET CMDSEP ON')],
    ['a changed DEFINE', (t) => t.replace('SET DEFINE OFF\n', 'SET DEFINE ON\n')],
    ['a dropped WHENEVER', (t) => t.replace('WHENEVER SQLERROR EXIT FAILURE ROLLBACK\n', '')],
    ['a dropped trailing WHENEVER OSERROR', (t) => t.replace('WHENEVER OSERROR EXIT FAILURE ROLLBACK\n', '')],
    ['both WHENEVER lines dropped', (t) => t.replace('WHENEVER SQLERROR EXIT FAILURE ROLLBACK\nWHENEVER OSERROR EXIT FAILURE ROLLBACK\n', '')],
    ['a dropped SET VERIFY OFF', (t) => t.replace('SET VERIFY OFF\n', '')],
    ['a changed WHENEVER', (t) => t.replace('WHENEVER OSERROR EXIT FAILURE ROLLBACK', 'WHENEVER OSERROR CONTINUE')],
    ['a reordered preamble', (t) => t.replace('SET ESCAPE OFF\nSET CMDSEP OFF', 'SET CMDSEP OFF\nSET ESCAPE OFF')],
    ['a late SET', (t) => t.replace('(2,NULL);', '(2,NULL);\nSET DEFINE ON')],
    ['a late SET CMDSEP', (t) => t.replace('(2,NULL);', '(2,NULL);\nSET CMDSEP ;')],
    ['a late WHENEVER', (t) => t.replace('(2,NULL);', '(2,NULL);\nWHENEVER SQLERROR CONTINUE')],
    ['a late HOST', (t) => t.replace('(2,NULL);', '(2,NULL);\nHOST touch /tmp/pwn')],
    ['a late !', (t) => t.replace('(2,NULL);', '(2,NULL);\n! touch /tmp/pwn')],
    ['a late $', (t) => t.replace('(2,NULL);', '(2,NULL);\n$ touch /tmp/pwn')],
    ['a late SPOOL', (t) => t.replace('(2,NULL);', '(2,NULL);\nSPOOL /tmp/x')],
    ['a late START', (t) => t.replace('(2,NULL);', '(2,NULL);\nSTART /tmp/x.sql')],
    ['a late EXEC', (t) => t.replace('(2,NULL);', '(2,NULL);\nEXEC dbms_output.put_line(1)')],
    ['a late @', (t) => t.replace('(2,NULL);', '(2,NULL);\n@/tmp/x.sql')],
    ['a chained HOST after a statement', (t) => t.replace('(2,NULL);', '(2,NULL);HOST touch /tmp/pwn')],
    ['a chained HOST after COMMIT', (t) => t.replace('COMMIT;\nBEGIN', 'COMMIT;HOST touch /tmp/pwn\nBEGIN')],
    ['a chained HOST after END', (t) => t.replace('  COMMIT;\nEND;', '  COMMIT;HOST touch /tmp/pwn\nEND;')],
    ['ALTER SESSION of something else', (t) => t.replace('ALTER SESSION SET NLS_COMP = BINARY NLS_SORT = BINARY;', 'ALTER SESSION SET NLS_COMP = LINGUISTIC;')],
  ];
  for (const [name, edit] of hostile) {
    const edited = edit(withPreamble);
    assert.notEqual(edited, withPreamble, name);
    assert.notEqual(check(edited), '', `refused: ${name}`);
  }
  // data that looks like a command or a chain stays inside its quotes and is fine
  assert.equal(check(withPreamble.replace('(2,NULL);', "(2,'x;HOST y; SET DEFINE ON');")), '');
});

test('mssql: a $( in a header comment line is refused', () => {
  const inputs = inputsOf({ manifest: { id: 'demo', source: { databaseSha256: sha(SQLITE), license: 'MIT' } }, config, dialect: 'mssql', attribution: ATTRIBUTION });
  const good = dialectScriptFor({ dialect: 'mssql', inputs }).toString();
  assert.match(scriptProblems(Buffer.from(good.replace('-- Licence: MIT', '-- Licence: MIT $(HOME)')), { id: 'demo', inputs, spec: committed.dialects.mssql }).join('\n'), /\$\(/);
});

test('the notice is neutralised the way each dialect asks: $( for SQL Server, & for Oracle, and */ and tabs everywhere', () => {
  const notice = 'A $(HOME) & B */\n\tx\n';
  assert.deepEqual(expectedNoticeLines(notice, 'mysql'), ['-- A $(HOME) & B * /', '--     x']);
  assert.deepEqual(expectedNoticeLines(notice, 'mssql'), ['-- A $ (HOME) & B * /', '--     x']);
  assert.deepEqual(expectedNoticeLines(notice, 'oracle'), ['-- A $(HOME) &  B * /', '--     x']);
});

test('a dialect notice file wins over the shared one: Employees names the script it travels in', async () => {
  const root = new URL('..', import.meta.url).pathname;
  const dialectConfig = { ...clone(committed), notice: { ...committed.notice, dir: join(root, 'config/dialect-notices') } };
  const mysql = noticeOf('employees', dialectConfig, 'mysql');
  const mssql = noticeOf('employees', dialectConfig, 'mssql');
  const oracle = noticeOf('employees', dialectConfig, 'oracle');
  assert.ok(mysql.includes('to this MySQL script by DataTug') && !mssql.includes('MySQL script') && mssql.includes('to this SQL Server script by DataTug') && oracle.includes('to this Oracle script by DataTug'));
  assert.equal(mssql.replace('SQL Server script', 'MySQL script'), mysql, 'nothing else differs');
  assert.equal(oracle.replace('Oracle script', 'MySQL script'), mysql, 'nothing else differs');
  for (const id of ['chinook', 'northwind', 'pubs', 'sakila', 'adventureworks']) assert.equal(noticeOf(id, dialectConfig, 'oracle'), noticeOf(id, dialectConfig, 'mysql'), `${id}: one notice for every dialect`);
});

test('every committed notice survives every dialect unchanged except for tabs, */, /*, $( and & (and the header of the exporter keeps lines of any length)', async () => {
  const root = new URL('..', import.meta.url).pathname;
  const dialectConfig = { ...clone(committed), notice: { ...committed.notice, dir: join(root, 'config/dialect-notices') } };
  const ids = (await readdir(join(root, 'config/dialect-notices'))).filter((file) => file.endsWith('.txt') && !file.includes('.mssql.') && !file.includes('.oracle.')).map((file) => file.slice(0, -4));
  for (const id of ids) for (const dialect of KNOWN_DIALECTS) {
    const notice = noticeOf(id, dialectConfig, dialect);
    assert.ok(!notice.includes('$(') && !notice.includes('&') && !notice.includes('\t') && !notice.includes('/*') && !notice.includes('*/'), `${id}/${dialect}: nothing to neutralise, so the header carries the notice verbatim`);
  }
});

test('generate writes a SQL Server and an Oracle script next to the MySQL one, each with its own report and inputs hash', async () => {
  const { dir } = await syntheticProvider();
  const stub = async (dialect) => {
    const path = join(dir, `fake-${dialect}.mjs`);
    await writeFile(path, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const to = new URL(args[args.indexOf('--to') + 1]);
const p = to.searchParams;
const sha = ${JSON.stringify(sha(SQLITE))};
const dialect = p.get('dialect');
const head = ['-- ' + p.get('edition'), '-- Dataset: ' + p.get('name'), '-- Generated by datatug ${config.generator.tag} (datatug db copy --to sqlscript:///<file>.sql?dialect=' + dialect + ') from a SQLite file with SHA-256 ' + sha, '-- Licence: ' + p.get('license'), '-- Attribution: ' + p.get('attribution'), '--', '--   ' + (dialect === 'mssql' ? '-X -x -b -f 65001' : 'NLS_LANG=.AL32UTF8'), ''];
const body = dialect === 'mssql'
  ? ['GO', 'CREATE TABLE [_demodb_import] ([dataset] NVARCHAR(MAX) NOT NULL);', 'GO', "INSERT INTO [_demodb_import] VALUES (N'" + p.get('name') + "', N'x', N'" + sha + "', N'${config.generator.tag}', 0, 0);", 'GO', 'COMMIT TRANSACTION;', 'GO']
  : [${JSON.stringify(ORACLE_PREAMBLE)}.join('\\n'), 'CREATE TABLE "_demodb_import" ("dataset" VARCHAR2(4000 BYTE));', 'BEGIN', '  INSERT INTO "_demodb_import" VALUES', "('" + p.get('name') + "','x','" + sha + "','${config.generator.tag}',0,0);", '  COMMIT;', 'END;', '/'];
const bom = dialect === 'mssql' ? '\\ufeff' : '';
writeFileSync(decodeURIComponent(to.pathname), bom + [...head, ...body, '-- end of script', ''].join('\\n'));
console.log(JSON.stringify({ command: 'db copy', exitCode: 0, tables: [{ name: 't', columns: 1, rows: 1 }], totals: { rows: 1 }, warnings: [] }));
`);
    await chmod(path, 0o755);
    return path;
  };
  for (const dialect of ['mssql', 'oracle']) {
    assert.equal(await generateProvider({ dir, config, dialect, getBinary: async () => stub(dialect) }), 'rewritten', dialect);
    const extension = config.dialects[dialect].extension;
    assert.ok((await readFile(join(dir, `dialect-scripts/demo.${extension}`))).length > 0, `dialect-scripts/demo.${extension}`);
    assert.deepEqual(await checkProvider(dir, config, dialect, { requireVerification: false }), [], dialect);
    assert.match((await checkProvider(dir, config, dialect)).join('\n'), /records no verification/, 'no verification until one is recorded');
    assert.equal(await generateProvider({ dir, config, dialect, getBinary: async () => { throw new Error('unchanged inputs never run the exporter'); } }), 'unchanged');
  }
  const record = JSON.parse(await readFile(join(dir, 'dialect-scripts/manifest.json'), 'utf8')).scripts;
  assert.deepEqual(Object.keys(record).sort(), ['mssql', 'mysql', 'oracle']);
  assert.equal(new Set(Object.values(record).map((entry) => entry.inputsSha256)).size, 3, 'the dialect is an input');
  assert.deepEqual(await checkProvider(dir, config, 'mysql'), [], 'the MySQL script is untouched');
});

test('record-verification keeps what makes a run reproducible, and refuses the wrong image or row counts that are not the exporter\'s', async () => {
  const { dir } = await syntheticProvider();
  await rewriteManifest(dir, (value) => { delete value.scripts.mysql.verification; });
  await writeFile(join(dir, 'dialect-scripts/demo.mysql.report.json'), serializeJson({ tables: [{ name: 't', columns: 1, rows: 1 }], warnings: [] }));
  await rewriteManifest(dir, (value) => {
    const bytes = Buffer.from(serializeJson({ tables: [{ name: 't', columns: 1, rows: 1 }], warnings: [] }));
    value.scripts.mysql.report = { bytes: bytes.length, path: 'dialect-scripts/demo.mysql.report.json', sha256: sha(bytes), warnings: {} };
  });
  const result = { tables: 1, rows: 1, valuesCompared: 1, differences: 0, verifierWarnings: 0, engine: 'MySQL 8.4.11', verifier: 'v', clientVersion: 'mysql 8.4.11', loadSeconds: 0.3, verifierSeconds: 0.8, image: config.dialects.mysql.serverImage, tableRows: { t: 1 } };
  await assert.rejects(recordVerification({ dir, config, result: { ...result, image: 'mysql:8.4@sha256:' + '0'.repeat(64) } }), /not the pinned/);
  await assert.rejects(recordVerification({ dir, config, result: { ...result, tableRows: { t: 2 } } }), /not the counts of the exporter report/);
  await recordVerification({ dir, config, result });
  const { verification } = JSON.parse(await readFile(join(dir, 'dialect-scripts/manifest.json'), 'utf8')).scripts.mysql;
  assert.deepEqual([verification.clientVersion, verification.loadSeconds, verification.verifierSeconds, verification.tableRows], ['mysql 8.4.11', 0.3, 0.8, { t: 1 }]);
  assert.equal(verification.image, config.dialects.mysql.serverImage);
  assert.deepEqual(await checkProvider(dir, config), []);
});
