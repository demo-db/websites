// Loads every committed MySQL script into a real MySQL server and compares the result with the provider's pinned SQLite
// fixture. Used by .github/workflows/served-formats-live.yml (a non-required workflow) and runnable on any machine with Docker:
//
//   node scripts/verify-mysql-live.mjs --providers <directory of provider checkouts named by dataset id> [--only id,id]
//
// What it proves, per dataset, with the server and the client of the digest-pinned image in config/dialect-scripts.json:
//   * the script loads with the recommended client flags (--skip-commands --skip-system-command, stop at the first error), and again, into a
//     second database, with the plain client (no flags), the way a person who ignored the header would load it;
//   * a second load stops at the marker table and changes nothing;
//   * the marker row names the dataset, the SQLite SHA-256, the datatug release, the table count and the row count;
//   * the table set, the column names and their order, the primary key columns, the foreign key count and the row count of
//     every table are those of the SQLite file.
// It does not compare every value. That check is the cross-engine verifier of datatug-cli (internal/crossverify, run by its
// journey-mysql workflow and recorded in each provider's dialect-scripts/manifest.json), which this repository cannot run
// because datatug-cli is private.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { MANIFEST_PATH, loadConfig, readStoredScript, sqliteSha256Of } from './dialect-scripts.mjs';

const args = process.argv.slice(2);
const option = (name) => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : undefined; };
const providers = resolve(option('providers') ?? '');
if (!option('providers')) throw new Error('pass --providers <directory of provider checkouts named by dataset id>');
const registry = JSON.parse(await readFile(new URL('../config/databases.json', import.meta.url), 'utf8'));
const matrix = JSON.parse(await readFile(new URL('../config/format-matrix.json', import.meta.url), 'utf8'));
const only = option('only')?.split(',');
const ids = registry.databases.map((entry) => entry.id)
  .filter((id) => matrix.datasets[id]?.mysql?.state === 'download' && matrix.datasets[id]?.mysql?.origin === 'provider-script')
  .filter((id) => !only || only.includes(id));
const config = await loadConfig();
const spec = config.dialects.mysql;
const password = `live-${process.pid}-${Math.random().toString(36).slice(2)}`;
const container = `demodb-mysql-live-${process.pid}`;
const docker = (...a) => spawnSync('docker', a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

function cleanup() { docker('rm', '-f', container); }
process.on('exit', cleanup);

function start() {
  const run = docker('run', '-d', '--name', container, '-e', `MYSQL_ROOT_PASSWORD=${password}`, '--tmpfs', '/var/lib/mysql:rw,size=4g', spec.serverImage);
  if (run.status !== 0) throw new Error(`docker run failed: ${run.stderr}`);
}
async function ready() {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    if (/ready for connections.*port: 3306/.test(docker('logs', container).stderr + docker('logs', container).stdout)) return;
    await new Promise((done) => setTimeout(done, 1000));
  }
  throw new Error(`the MySQL server did not come up:\n${docker('logs', container).stderr}`);
}
const mysqlArgs = (...extra) => ['exec', '-i', '-e', `MYSQL_PWD=${password}`, container, 'mysql', '-uroot', '--default-character-set=utf8mb4', ...extra];

function query(database, sql) {
  const result = docker(...mysqlArgs('-N', '-B', ...(database ? ['--database', database] : []), '-e', sql));
  if (result.status !== 0) throw new Error(`mysql: ${result.stderr}`);
  return result.stdout.split('\n').filter((line) => line.length > 0).map((line) => line.split('\t'));
}

// Streams a script into the client the way a person loads it and reports the exit status and what the client printed.
function load(database, bytes, plain = false) {
  return new Promise((done, fail) => {
    // `plain` is the client of a person who ignored the header: no --skip-commands, no --skip-system-command.
    const child = spawn('docker', mysqlArgs(...(plain ? [] : ['--skip-commands', '--skip-system-command']), '--database', database), { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', fail);
    // The client stops reading at the first error (a second load must), which closes the pipe under the writer: that is the answer, not a failure.
    child.stdin.on('error', () => {});
    child.on('close', (code) => done({ code, stderr }));
    Readable.from([bytes]).pipe(child.stdin);
  });
}

async function sqliteOf(id, dir, manifest) {
  const raw = await readFile(join(dir, manifest.dataFile));
  const bytes = manifest.source?.inputCompression === 'gzip' || manifest.dataFile.endsWith('.gz') ? gunzipSync(raw) : raw;
  const scratch = await mkdtemp(join(tmpdir(), 'demodb-live-'));
  const file = join(scratch, `${id}.sqlite`);
  await writeFile(file, bytes);
  return { db: new DatabaseSync(file, { readOnly: true }), scratch };
}

const quoteSqlite = (name) => `"${name.replaceAll('"', '""')}"`;
const failures = [];
const fail = (id, message) => { failures.push(`${id}: ${message}`); console.error(`${id}: ${message}`); };

start();
await ready();
console.log(`server ${query(null, 'select version()')[0][0]} (${spec.serverImage})`);
console.log(`${'dataset'.padEnd(30)} ${'tables'.padEnd(7)} ${'rows'.padEnd(9)} result`);

for (const [id, plain] of ids.flatMap((item) => [[item, false], [item, true]])) {
  const dir = join(providers, id);
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  const dialectManifest = JSON.parse(await readFile(join(dir, MANIFEST_PATH), 'utf8'));
  const record = dialectManifest.scripts.mysql;
  const script = await readStoredScript(record, (path) => readFile(join(dir, path)));
  const report = JSON.parse(await readFile(join(dir, record.report.path), 'utf8'));
  const database = `${plain ? 'plain' : 'live'}_${id}`;
  const label = plain ? `${id} (plain client)` : id;
  query(null, `DROP DATABASE IF EXISTS \`${database}\`; CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
  const first = await load(database, script, plain);
  if (first.code !== 0) { fail(label, `the script stopped at an error: ${first.stderr.replace(/.*Using a password.*\n/, '').slice(0, 400)}`); continue; }
  const second = await load(database, script, plain);
  if (second.code === 0 || !second.stderr.includes(spec.marker)) { fail(label, 'a second load did not stop at the marker table'); continue; }

  const { db, scratch } = await sqliteOf(id, dir, manifest);
  try {
    const sqliteTables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);
    const renamed = report.warnings.filter((warning) => warning.kind === 'name-renamed' || warning.kind === 'fk-not-carried' || warning.kind === 'fk-violations-in-source');
    if (renamed.length) { fail(label, `the report names renamed tables or dropped foreign keys (${renamed.length}), which this check does not model`); continue; }
    const mysqlTables = query(database, `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${database}' AND TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME <> '${spec.marker}' ORDER BY TABLE_NAME`).map((row) => row[0]);
    if (JSON.stringify([...mysqlTables].sort()) !== JSON.stringify([...sqliteTables].sort())) { fail(label, `table sets differ: ${mysqlTables.join(',')} != ${sqliteTables.join(',')}`); continue; }
    const columnsByTable = new Map();
    for (const [table, column] of query(database, `SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = '${database}' ORDER BY TABLE_NAME, ORDINAL_POSITION`)) {
      if (!columnsByTable.has(table)) columnsByTable.set(table, []);
      columnsByTable.get(table).push(column);
    }
    const pkByTable = new Map();
    for (const [table, column] of query(database, `SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = '${database}' AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY TABLE_NAME, ORDINAL_POSITION`)) {
      if (!pkByTable.has(table)) pkByTable.set(table, []);
      pkByTable.get(table).push(column);
    }
    const fkByTable = new Map(query(database, `SELECT TABLE_NAME, COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = '${database}' AND CONSTRAINT_TYPE = 'FOREIGN KEY' GROUP BY TABLE_NAME`).map(([table, count]) => [table, Number(count)]));
    let rows = 0;
    let bad = false;
    for (const table of sqliteTables) {
      const columns = db.prepare(`PRAGMA table_info(${quoteSqlite(table)})`).all();
      const expectedColumns = columns.map((column) => column.name);
      const expectedPk = columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name);
      const expectedFk = new Set(db.prepare(`PRAGMA foreign_key_list(${quoteSqlite(table)})`).all().map((row) => row.id)).size;
      const expectedRows = Number(db.prepare(`SELECT count(*) AS n FROM ${quoteSqlite(table)}`).get().n);
      const actualRows = Number(query(database, `SELECT COUNT(*) FROM \`${table.replaceAll('`', '``')}\``)[0][0]);
      rows += expectedRows;
      const problems = [];
      if (JSON.stringify(columnsByTable.get(table)) !== JSON.stringify(expectedColumns)) problems.push('columns');
      if (JSON.stringify(pkByTable.get(table) ?? []) !== JSON.stringify(expectedPk)) problems.push('primary key');
      if ((fkByTable.get(table) ?? 0) !== expectedFk) problems.push(`foreign keys ${fkByTable.get(table) ?? 0} != ${expectedFk}`);
      if (actualRows !== expectedRows) problems.push(`rows ${actualRows} != ${expectedRows}`);
      if (problems.length) { fail(label, `${table}: ${problems.join(', ')} differ from the SQLite fixture`); bad = true; }
    }
    if (bad) continue;
    const [marker] = query(database, `SELECT dataset, source_sha256, datatug_version, tables_count, rows_count FROM \`${spec.marker}\``);
    const expected = [id, sqliteSha256Of(manifest), config.generator.tag, String(sqliteTables.length), String(rows)];
    if (JSON.stringify(marker) !== JSON.stringify(expected)) { fail(label, `marker row ${JSON.stringify(marker)} != ${JSON.stringify(expected)}`); continue; }
    console.log(`${label.padEnd(30)} ${String(sqliteTables.length).padEnd(7)} ${String(rows).padEnd(9)} PASS`);
  } finally {
    db.close();
    await rm(scratch, { recursive: true, force: true });
  }
}
if (failures.length) { console.error(`${failures.length} dataset(s) failed`); process.exitCode = 1; } else console.log('MySQL live load passed');
