// Loads the committed dialect scripts into a REAL engine, in a throwaway container of the digest-pinned image of
// config/dialect-scripts.json, and compares what was loaded with the provider's pinned SQLite fixture:
//
//   node scripts/verify-engines-live.mjs --providers <dir of provider checkouts named by dataset id> --dialect mysql|mssql|oracle
//        [--only id,id] [--crossverify <datatug-cli checkout at the pinned release>] [--out <directory for the result files>]
//
// Per dataset it proves:
//   * the script loads into a clean database (MySQL, SQL Server) or schema (Oracle) with the client and the flags the header recommends,
//     and stops at the first error;
//   * a second load stops at the marker table and changes nothing;
//   * every table of the SQLite fixture holds exactly its rows (the count of every table is read back from the engine);
//   * the marker row names the dataset, the SQLite SHA-256, the datatug release, the table count and the row count.
// With --crossverify it also runs the cross-engine verifier of datatug-cli (`internal/crossverify`, TestJourneyMySQL, TestJourneyMSSQL or
// TestJourneyOracle) over the SQLite file and the loaded database: tables, columns, keys, indexes, row counts and every value, read through
// Go drivers. The numbers go to <out>/<id>.<dialect>.verification.json, which `dialect-scripts.mjs record-verification --result-file` stamps
// onto the stored script. This repository's required lane never runs it (it needs Docker, and for SQL Server a licence acceptance, see
// docs/dialect-scripts.md); it is the local, reproducible record.
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { MANIFEST_PATH, VERIFIER_TESTS, loadConfig, readStoredScript, sqliteSha256Of } from './dialect-scripts.mjs';

const args = process.argv.slice(2);
const option = (name) => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : undefined; };
if (!option('providers') || !option('dialect')) throw new Error('pass --providers <directory of provider checkouts named by dataset id> and --dialect mysql|mssql|oracle');
const providers = resolve(option('providers'));
const dialect = option('dialect');
const registry = JSON.parse(await readFile(new URL('../config/databases.json', import.meta.url), 'utf8'));
const only = option('only')?.split(',');
const ids = registry.databases.map((entry) => entry.id).filter((id) => !only || only.includes(id));
const crossverify = option('crossverify') ? resolve(option('crossverify')) : null;
const outDir = option('out') ? resolve(option('out')) : null;
const config = await loadConfig();
const spec = config.dialects[dialect];
if (!spec) throw new Error(`no ${dialect} dialect in config/dialect-scripts.json`);
const password = { mysql: `live-${process.pid}-${Math.random().toString(36).slice(2)}`, mssql: `Demo-Live-${process.pid}-${Math.random().toString(36).slice(2, 8)}`, oracle: `Live${process.pid}x${Math.random().toString(36).slice(2, 8)}` }[dialect];
const container = `demodb-${dialect}-live-${process.pid}`;
const docker = (...a) => spawnSync('docker', a, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
process.on('exit', () => { docker('rm', '-f', container); });

const sqlcmd = ['exec', '-i', container, '/opt/mssql-tools18/bin/sqlcmd', '-C', '-S', 'localhost', '-U', 'sa', '-P', password];

// --- one adapter per engine --------------------------------------------------------------------------------------------------
const adapters = {
  mysql: {
    run: ['-d', '--name', container, '-e', `MYSQL_ROOT_PASSWORD=${password}`, '-p', '127.0.0.1::3306', '--tmpfs', '/var/lib/mysql:rw,size=4g', spec.serverImage],
    async ready() {
      for (let attempt = 0; attempt < 240; attempt += 1) {
        const logs = docker('logs', container);
        if (/ready for connections.*port: 3306/.test(logs.stderr + logs.stdout)) return;
        await sleep(1000);
      }
      throw new Error('the MySQL server did not come up');
    },
    mysql: (...extra) => ['exec', '-i', '-e', `MYSQL_PWD=${password}`, container, 'mysql', '-uroot', '--default-character-set=utf8mb4', ...extra],
    query(sql, database) {
      const result = docker(...this.mysql('-N', '-B', ...(database ? ['--database', database] : []), '-e', sql));
      if (result.status !== 0) throw new Error(`mysql: ${result.stderr}`);
      return result.stdout.split('\n').filter(Boolean).map((line) => line.split('\t'));
    },
    version() { return `MySQL ${this.query('select version()')[0][0]}`; },
    clientVersion() { return docker('exec', container, 'mysql', '--version').stdout.trim(); },
    create(name) { this.query(`DROP DATABASE IF EXISTS \`${name}\`; CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4`); },
    load(name, bytes, { plain = false } = {}) {
      return new Promise((done, fail) => {
        const child = spawn('docker', this.mysql(...(plain ? [] : ['--skip-commands', '--skip-system-command']), '--database', name), { stdio: ['pipe', 'pipe', 'pipe'] });
        let output = '';
        child.stdout.on('data', (chunk) => { output += chunk; });
        child.stderr.on('data', (chunk) => { output += chunk; });
        child.on('error', fail);
        child.stdin.on('error', () => {});
        child.on('close', (code) => done({ code, output }));
        Readable.from([bytes]).pipe(child.stdin);
      });
    },
    secondLoadStops: (output) => output.includes(spec.marker),
    counts(name, tables) {
      const sql = tables.map((table) => `SELECT ${sqlString(table)}, COUNT(*) FROM \`${table.replaceAll('`', '``')}\``).join(' UNION ALL ');
      return Object.fromEntries(this.query(sql, name).map(([table, n]) => [table, Number(n)]));
    },
    marker(name) { return this.query(`SELECT dataset, source_sha256, datatug_version, tables_count, rows_count FROM \`${spec.marker}\``, name)[0]; },
    dsn: (name, port) => `root:${password}@tcp(127.0.0.1:${port})/${name}?charset=utf8mb4`,
    port: 3306,
    env: 'DATATUG_JOURNEY_MYSQL_DSN',
  },
  mssql: {
    // SQL Server is amd64 only: on an Apple-silicon Mac the container runs under emulation.
    run: ['-d', '--name', container, '--platform', 'linux/amd64', '-e', 'ACCEPT_EULA=Y', '-e', `MSSQL_SA_PASSWORD=${password}`, '-e', 'MSSQL_PID=Developer', '-p', '127.0.0.1::1433', spec.serverImage],
    async ready() {
      for (let attempt = 0; attempt < 400; attempt += 1) {
        if (docker(...sqlcmd, '-X', '-b', '-Q', 'SELECT 1').status === 0) return;
        await sleep(2000);
      }
      throw new Error(`the SQL Server did not come up:\n${docker('logs', container).stdout.slice(-2000)}`);
    },
    query(sql, database) {
      const result = docker(...sqlcmd, '-X', '-b', '-h', '-1', '-W', '-s', '|', ...(database ? ['-d', database] : []), '-Q', `SET NOCOUNT ON; ${sql}`);
      if (result.status !== 0) throw new Error(`sqlcmd: ${result.stdout}${result.stderr}`);
      return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => line.split('|'));
    },
    version() { return this.query('SELECT @@VERSION')[0][0].replace(/\s+/g, ' ') + ` / collation ${this.query("SELECT CAST(SERVERPROPERTY('Collation') AS varchar(100))")[0][0]}`; },
    clientVersion() { return docker('exec', container, '/opt/mssql-tools18/bin/sqlcmd', '-?').stdout.split('\n').find((line) => /Version/.test(line))?.trim() ?? 'sqlcmd'; },
    create(name) { this.query(`IF DB_ID(N'${name}') IS NOT NULL DROP DATABASE [${name}]; CREATE DATABASE [${name}]`); },
    async load(name, bytes) {
      // The header says: sqlcmd -X -x -b -f 65001 -i <file> (a file, not a redirect: the script starts with a byte order mark).
      const scratch = await mkdtemp(join(tmpdir(), 'demodb-mssql-'));
      try {
        const file = join(scratch, `${name}.sql`);
        await writeFile(file, bytes);
        const copied = docker('cp', file, `${container}:/tmp/${name}.sql`);
        if (copied.status !== 0) throw new Error(`docker cp: ${copied.stderr}`);
        const result = docker(...sqlcmd, '-d', name, '-X', '-x', '-b', '-f', '65001', '-i', `/tmp/${name}.sql`);
        return { code: result.status, output: result.stdout + result.stderr };
      } finally { await rm(scratch, { recursive: true, force: true }); }
    },
    secondLoadStops: (output) => output.includes(spec.marker),
    counts(name, tables) {
      const sql = tables.map((table) => `SELECT ${sqlString(table)} + '|' + CAST(COUNT_BIG(*) AS varchar(30)) FROM [${table.replaceAll(']', ']]')}]`).join(' UNION ALL ');
      return Object.fromEntries(this.query(sql, name).map((row) => { const text = row.join('|'); const at = text.lastIndexOf('|'); return [text.slice(0, at), Number(text.slice(at + 1))]; }));
    },
    marker(name) { return this.query(`SELECT dataset, source_sha256, datatug_version, tables_count, rows_count FROM [${spec.marker}]`, name)[0]; },
    dsn: (name, port) => `sqlserver://sa:${encodeURIComponent(password)}@127.0.0.1:${port}?database=${name}&encrypt=disable`,
    port: 1433,
    env: 'DATATUG_JOURNEY_MSSQL_DSN',
  },
  oracle: {
    run: ['-d', '--name', container, '-e', `ORACLE_PASSWORD=${password}`, '-p', '127.0.0.1::1521', spec.serverImage],
    service: 'FREEPDB1',
    async ready() {
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const logs = docker('logs', container);
        if ((logs.stdout + logs.stderr).includes('DATABASE IS READY TO USE')) return;
        await sleep(3000);
      }
      throw new Error(`the Oracle database did not come up:\n${docker('logs', container).stdout.slice(-2000)}`);
    },
    sqlplus(user, input) {
      const result = spawnSync('docker', ['exec', '-i', '-e', 'NLS_LANG=.AL32UTF8', container, 'sqlplus', '-L', '-S', `${user}/${password}@//localhost/${this.service}`], { input: `set heading off feedback off pagesize 0 linesize 4000 define off trimout on\nwhenever sqlerror exit failure\n${input}\nexit\n`, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
      return result;
    },
    query(sql, user = 'system') {
      const result = this.sqlplus(user, sql);
      if (result.status !== 0) throw new Error(`sqlplus: ${result.stdout}${result.stderr}`);
      return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => line.split('|'));
    },
    version() { return this.query("select banner_full from v$version where rownum = 1;")[0][0] + ` / compatible ${this.query("select value from v$parameter where name = 'compatible';")[0][0]} / ${this.query("select value from nls_database_parameters where parameter = 'NLS_CHARACTERSET';")[0][0]} / MAX_STRING_SIZE ${this.query("select value from v$parameter where name = 'max_string_size';")[0][0]}`; },
    clientVersion() { return docker('exec', container, 'sqlplus', '-V').stdout.replace(/\s+/g, ' ').trim(); },
    create(name) {
      this.query(`begin execute immediate 'drop user ${name} cascade'; exception when others then null; end;\n/\ncreate user ${name} identified by "${password}" quota unlimited on users;\ngrant create session, create table, create sequence to ${name};`);
    },
    load(name, bytes) {
      // The header says: NLS_LANG=.AL32UTF8 sqlplus -L -S user/password@service @file, with stdin at the end of file.
      return new Promise(async (done, fail) => {
        const scratch = await mkdtemp(join(tmpdir(), 'demodb-oracle-'));
        try {
          const file = join(scratch, `${name}.sql`);
          await writeFile(file, bytes);
          const copied = docker('cp', file, `${container}:/tmp/${name}.sql`);
          if (copied.status !== 0) throw new Error(`docker cp: ${copied.stderr}`);
          const child = spawn('docker', ['exec', '-e', 'NLS_LANG=.AL32UTF8', container, 'sqlplus', '-L', '-S', `${name}/${password}@//localhost/${this.service}`, `@/tmp/${name}.sql`], { stdio: ['ignore', 'pipe', 'pipe'] });
          let output = '';
          child.stdout.on('data', (chunk) => { output += chunk; });
          child.stderr.on('data', (chunk) => { output += chunk; });
          child.on('error', fail);
          child.on('close', (code) => done({ code, output }));
        } catch (error) { fail(error); } finally { await rm(scratch, { recursive: true, force: true }); }
      });
    },
    secondLoadStops: (output) => output.includes('ORA-00955'),
    counts(name, tables) {
      const sql = `${tables.map((table) => `select ${sqlString(table)} || '|' || count(*) from "${table.replaceAll('"', '""')}"`).join('\nunion all\n')};`;
      return Object.fromEntries(this.query(sql, name).map((row) => { const text = row.join('|'); const at = text.lastIndexOf('|'); return [text.slice(0, at), Number(text.slice(at + 1))]; }));
    },
    marker(name) { return this.query(`select "dataset" || '|' || "source_sha256" || '|' || "datatug_version" || '|' || "tables_count" || '|' || "rows_count" from "${spec.marker}";`, name)[0]; },
    dsn(name, port) { return `oracle://${name}:${password}@127.0.0.1:${port}/${this.service}`; },
    port: 1521,
    env: 'DATATUG_JOURNEY_ORACLE_DSN',
  },
};
const adapter = adapters[dialect];
const sqlString = (value) => `'${value.replaceAll("'", "''")}'`;

async function sqliteOf(id, dir, manifest) {
  const raw = await readFile(join(dir, manifest.dataFile));
  const bytes = manifest.source?.inputCompression === 'gzip' || manifest.dataFile.endsWith('.gz') ? gunzipSync(raw) : raw;
  const scratch = await mkdtemp(join(tmpdir(), 'demodb-live-'));
  const file = join(scratch, `${id}.sqlite`);
  await writeFile(file, bytes);
  return { db: new DatabaseSync(file, { readOnly: true }), file, scratch };
}
const quoteSqlite = (name) => `"${name.replaceAll('"', '""')}"`;
const failures = [];
const fail = (id, message) => { failures.push(`${id}: ${message}`); console.error(`${id}: ${message}`); };
const seconds = (since) => Math.round((Date.now() - since) / 100) / 10;

const started = docker('run', ...adapter.run);
if (started.status !== 0) throw new Error(`docker run failed: ${started.stderr}`);
const image = docker('image', 'inspect', '--format', '{{index .RepoDigests 0}}', spec.serverImage.split('@')[0]).stdout.trim();
const platform = docker('inspect', '--format', '{{.Platform}} {{.Config.Image}}', container).stdout.trim();
const bootStarted = Date.now();
await adapter.ready();
const serverVersion = adapter.version();
const clientVersion = adapter.clientVersion();
const hostPort = docker('port', container, `${adapter.port}/tcp`).stdout.split('\n')[0].replace(/.*:/, '');
console.log(`image ${spec.serverImage} (local ${image}, ${platform}), ready after ${seconds(bootStarted)}s`);
console.log(`server ${serverVersion}`);
console.log(`client ${clientVersion}`);
console.log(`${'dataset'.padEnd(18)} ${'tables'.padEnd(7)} ${'rows'.padEnd(9)} ${'load s'.padEnd(8)} ${'values'.padEnd(10)} ${'verify s'.padEnd(9)} result`);
if (outDir) await mkdir(outDir, { recursive: true });

for (const id of ids) {
  const dir = join(providers, id);
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  const dialectManifest = JSON.parse(await readFile(join(dir, MANIFEST_PATH), 'utf8'));
  const record = dialectManifest.scripts[dialect];
  const script = await readStoredScript(record, (path) => readFile(join(dir, path)));
  const database = `j_${id}`.slice(0, 30);
  adapter.create(database);
  const loadStarted = Date.now();
  const first = await adapter.load(database, script);
  const loadSeconds = seconds(loadStarted);
  if (first.code !== 0 || /SP2-\d+/.test(first.output) || /\bMsg \d+, Level \d+/.test(first.output)) { fail(id, `the script stopped at an error: ${first.output.replace(/.*Using a password.*\n/, '').slice(0, 600)}`); continue; }
  const second = await adapter.load(database, script);
  if (second.code === 0 || !adapter.secondLoadStops(second.output)) { fail(id, `a second load did not stop at the marker table: ${second.output.slice(0, 300)}`); continue; }
  if (dialect === 'mysql') {
    adapter.create(`${database}_plain`.slice(0, 60));
    const plain = await adapter.load(`${database}_plain`.slice(0, 60), script, { plain: true });
    if (plain.code !== 0) { fail(id, `the plain client could not load the script: ${plain.output.slice(0, 400)}`); continue; }
  }
  const { db, file, scratch } = await sqliteOf(id, dir, manifest);
  try {
    const sqliteTables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);
    const renamed = JSON.parse(await readFile(join(dir, record.report.path), 'utf8')).warnings.filter((warning) => warning.kind === 'name-renamed' || warning.kind === 'fk-not-carried');
    if (renamed.length) { fail(id, `the report names ${renamed.length} renamed tables or dropped foreign keys, which this check does not model`); continue; }
    const expected = Object.fromEntries(sqliteTables.map((table) => [table, Number(db.prepare(`SELECT count(*) AS n FROM ${quoteSqlite(table)}`).get().n)]));
    const actual = adapter.counts(database, sqliteTables);
    const wrong = sqliteTables.filter((table) => actual[table] !== expected[table]);
    if (wrong.length) { fail(id, `row counts differ: ${wrong.map((table) => `${table} ${actual[table]} != ${expected[table]}`).join(', ')}`); continue; }
    const rows = Object.values(expected).reduce((sum, n) => sum + n, 0);
    const marker = adapter.marker(database);
    const want = [id, sqliteSha256Of(manifest), config.generator.tag, String(sqliteTables.length), String(rows)];
    const got = dialect === 'oracle' ? marker : marker.map(String);
    if (JSON.stringify(got) !== JSON.stringify(want) && JSON.stringify([got.join('|')]) !== JSON.stringify([want.join('|')])) { fail(id, `marker row ${JSON.stringify(got)} != ${JSON.stringify(want)}`); continue; }
    let verification = { differences: 0, tables: sqliteTables.length, rows, valuesCompared: null, verifierWarnings: null, verifierSeconds: null };
    if (crossverify) {
      const verifyStarted = Date.now();
      const run = spawnSync('go', ['test', '-count=1', '-v', '-timeout', '90m', '-run', `^${VERIFIER_TESTS[dialect]}$`, './internal/crossverify/'], {
        cwd: crossverify, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
        env: { ...process.env, DATATUG_JOURNEY_SQLITE: file, [adapter.env]: adapter.dsn(database, hostPort) },
      });
      const output = run.stdout + run.stderr;
      if (run.status !== 0 || /--- SKIP/.test(output) || !new RegExp(`--- PASS: ${VERIFIER_TESTS[dialect]}`).test(output)) { fail(id, `the cross-engine verifier did not pass:\n${output.split('\n').filter((line) => /DIFF|FAIL|SKIP|error/i.test(line)).slice(0, 12).join('\n')}`); continue; }
      const summary = output.match(/(\d+) tables, (\d+) rows, (\d+) values compared, (\d+) warnings, (\d+) difference/);
      if (!summary) { fail(id, 'the verifier printed no summary'); continue; }
      verification = { differences: Number(summary[5]), tables: Number(summary[1]), rows: Number(summary[2]), valuesCompared: Number(summary[3]), verifierWarnings: Number(summary[4]), verifierSeconds: seconds(verifyStarted) };
      if (verification.differences !== 0 || verification.rows !== rows || verification.tables !== sqliteTables.length) { fail(id, `the verifier summary ${summary[0]} disagrees with the row counts read back (${sqliteTables.length} tables, ${rows} rows)`); continue; }
    }
    if (outDir) {
      await writeFile(join(outDir, `${id}.${dialect}.verification.json`), `${JSON.stringify({
        clientVersion, differences: verification.differences, engine: serverVersion, image: spec.serverImage, loadSeconds, rows: verification.rows,
        scriptSha256: record.stored.decodedSha256, tableRows: actual, tables: verification.tables, valuesCompared: verification.valuesCompared,
        verifierSeconds: verification.verifierSeconds, verifierWarnings: verification.verifierWarnings,
      }, null, 2)}\n`);
    }
    console.log(`${id.padEnd(18)} ${String(sqliteTables.length).padEnd(7)} ${String(rows).padEnd(9)} ${String(loadSeconds).padEnd(8)} ${String(verification.valuesCompared ?? '-').padEnd(10)} ${String(verification.verifierSeconds ?? '-').padEnd(9)} PASS`);
  } finally {
    db.close();
    await rm(scratch, { recursive: true, force: true });
  }
}
if (failures.length) { console.error(`${failures.length} dataset(s) failed`); process.exitCode = 1; } else console.log(`${dialect} live load passed`);
