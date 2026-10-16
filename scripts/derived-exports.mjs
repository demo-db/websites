// Reusable generation of the complete-database downloads that a provider contract does not carry.
//
// Every dataset publishes SQLite, a SQLite-dialect SQL dump and per-table JSON/CSV in its pinned provider
// contract. The complete-database JSON, YAML and PostgreSQL script are derived here, from those pinned and
// checksum-verified inputs only (never from a hand-maintained copy), so one generator serves every dataset:
//
//   json        the per-table JSON exports joined as {"<table>": [rows]} (the provider bytes, unparsed)
//   yaml        the same rows as block-style YAML (every scalar is a JSON scalar, numbers verbatim)
//   postgresql  scripts/hosting-tools/postgres_samples.py `generate` over the pinned SQLite (live-loaded and
//               verified against PostgreSQL 17 in CI), or the provider's own pinned PostgreSQL artifact
//               where it ships one (Northwind)
//
// config/derived-exports.lock.json pins the decoded SHA-256 and size of every derived file, so a change in
// the generator, its inputs or the interpreter that alters a published byte fails the build until the lock
// is regenerated and reviewed (DEMODB_UPDATE_DERIVED_LOCK=1).
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const MAX_ASSET_BYTES = 25 * 1024 * 1024;
// Formats that are one SQL script of an engine, served as <id>.<format>.sql.
export const SQL_SCRIPT_FORMATS = ['postgresql', 'mysql', 'sqlserver', 'oracle'];

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// --- JSON -----------------------------------------------------------------------------------------------
// Joins the provider's per-table JSON arrays without parsing them, so every value (exact decimals,
// base64 BLOBs, large integers) stays byte-for-byte what the provider published.
export function jsonDocument(tables) {
  const parts = [Buffer.from('{\n')];
  tables.forEach((table, index) => {
    const body = Buffer.from(table.json.toString('utf8').trim(), 'utf8');
    if (body[0] !== 0x5b || body[body.length - 1] !== 0x5d) throw new Error(`${table.name}: per-table JSON is not an array`);
    parts.push(Buffer.from(`  ${JSON.stringify(table.name)}: `), body, Buffer.from(index === tables.length - 1 ? '\n' : ',\n'));
  });
  parts.push(Buffer.from('}\n'));
  return Buffer.concat(parts);
}

// --- YAML -----------------------------------------------------------------------------------------------
class RawNumber { constructor(source) { this.source = source; } }

// JSON.parse with numbers kept as their source text, so 12345678901234567890 and 1.50 survive.
export function parseRows(json) {
  return JSON.parse(json, (_key, value, context) => (typeof value === 'number' ? new RawNumber(context.source) : value));
}

// JSON string escapes are valid YAML double-quoted escapes; the extra escapes keep characters that a
// YAML 1.1 reader treats as line breaks or byte-order marks from altering a scalar.
const ch = String.fromCharCode;
// DEL, the C1 controls (which include YAML 1.1's NEL), the line/paragraph separators, the byte-order mark and the two
// noncharacters YAML 1.1 readers such as PyYAML and ruamel refuse in a scalar.
const ESCAPE_IN_YAML = new RegExp(`[${ch(0x7f)}-${ch(0x9f)}${ch(0x2028)}${ch(0x2029)}${ch(0xfeff)}${ch(0xfffe)}${ch(0xffff)}]`, 'g');
// A lone surrogate cannot be written in any YAML encoding (libyaml refuses even its escape), and SQLite text is UTF-8, which
// cannot hold one, so one in a table means a corrupt source: refuse it instead of altering the value.
const yamlString = (value) => (value.isWellFormed() ? JSON.stringify(value) : (() => { throw new Error('a lone UTF-16 surrogate cannot be written in YAML'); })()).replace(ESCAPE_IN_YAML, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);

function yamlScalar(value) {
  if (value === null) return 'null';
  if (value instanceof RawNumber) return value.source;
  if (typeof value === 'string') return yamlString(value);
  if (typeof value === 'boolean') return String(value);
  throw new Error(`unsupported value in a table row: ${JSON.stringify(value)}`);
}

export function yamlDocument(tables) {
  const lines = [];
  for (const table of tables) {
    const rows = parseRows(table.json.toString('utf8'));
    if (!Array.isArray(rows)) throw new Error(`${table.name}: per-table JSON is not an array`);
    if (rows.length === 0) { lines.push(`${yamlString(table.name)}: []`); continue; }
    lines.push(`${yamlString(table.name)}:`);
    for (const row of rows) {
      const keys = Object.keys(row);
      if (keys.length === 0) { lines.push('  - {}'); continue; }
      keys.forEach((key, index) => lines.push(`${index === 0 ? '  - ' : '    '}${yamlString(key)}: ${yamlScalar(row[key])}`));
    }
  }
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

// --- gzip -----------------------------------------------------------------------------------------------
// Level 9 with a zero timestamp and a fixed header, the same convention as the provider exports.
export function deterministicGzip(bytes) {
  const out = gzipSync(bytes, { level: 9 });
  out.fill(0, 4, 8);
  out[8] = 2;
  out[9] = 3;
  return out;
}

// Splits an encoded stream into the ordered ".gz.NNNN.part" files the Worker joins and serves as one
// download, exactly as the provider's chunked exports are served.
export function chunkEncoded(encoded, limit = MAX_ASSET_BYTES) {
  const chunks = [];
  for (let offset = 0, index = 1; offset < encoded.length; offset += limit, index += 1) chunks.push(encoded.subarray(offset, offset + limit));
  return chunks;
}

// --- PostgreSQL script ----------------------------------------------------------------------------------
export function generatePostgresqlScript({ python, script, manifest, decodedSqlite, scratchRoot }) {
  return mkdtemp(join(scratchRoot ?? tmpdir(), 'demodb-pg-')).then(async (dir) => {
    try {
      const provider = join(dir, 'provider');
      await mkdir(provider, { recursive: true });
      await writeFile(join(provider, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
      await writeFile(join(provider, 'decoded.sqlite'), decodedSqlite);
      const output = join(dir, 'postgresql.sql');
      const result = spawnSync(python, [script, 'generate', provider, '--output', output], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      if (result.error) throw new Error(`could not start ${python}: ${result.error.message}`);
      if (result.status !== 0) throw new Error(`postgres_samples.py generate failed: ${result.stderr || result.stdout}`);
      return await readFile(output);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

// --- placement ------------------------------------------------------------------------------------------
// Writes one derived file under the dataset's internal asset directory (plain, gzip, or gzip chunks, by the
// same size rule as the provider contract) and returns its registry entry.
export async function placeDerivedExport({ id, format, bytes, destination }) {
  const publicPath = SQL_SCRIPT_FORMATS.includes(format) ? `${id}.${format}.sql` : format === 'ingitdb' ? `${id}.ingitdb.zip` : `${id}.${format}`;
  const entry = {
    path: `derived/${publicPath}`, encodedPath: null, publicPath, assetPath: publicPath, chunks: [], format, table: null,
    bytes: bytes.length, sha256: sha256(bytes), compression: null, decodedBytes: null, decodedSha256: null, dbWide: true, derived: true,
  };
  const write = async (assetPath, content) => {
    const target = join(destination, assetPath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  };
  if (bytes.length <= MAX_ASSET_BYTES) { await write(publicPath, bytes); return entry; }
  const encoded = deterministicGzip(bytes);
  Object.assign(entry, {
    encodedPath: `${entry.path}.gz`, compression: 'gzip', bytes: encoded.length, sha256: sha256(encoded),
    decodedBytes: bytes.length, decodedSha256: sha256(bytes),
  });
  if (encoded.length <= MAX_ASSET_BYTES) {
    entry.assetPath = `${publicPath}.gz`;
    await write(entry.assetPath, encoded);
    return entry;
  }
  const pieces = chunkEncoded(encoded);
  entry.chunks = [];
  for (const [index, piece] of pieces.entries()) {
    const n = String(index + 1).padStart(4, '0');
    const assetPath = `${publicPath}.gz.${n}.part`;
    await write(assetPath, piece);
    entry.chunks.push({ path: `${entry.encodedPath}.part-${n}`, bytes: piece.length, sha256: sha256(piece), assetPath });
  }
  entry.assetPath = `${publicPath}.gz`;
  return entry;
}

export function decodeEntry(encoded, entry) {
  return entry.compression === 'gzip' ? gunzipSync(encoded) : encoded;
}

// --- the lock -------------------------------------------------------------------------------------------
export const LOCK_FORMAT = 'demodb-derived-exports-lock/v1';
export const LOCK_PATH = 'config/derived-exports.lock.json';

export const bytesIdentity = (bytes) => ({ bytes: bytes.length, sha256: sha256(bytes) });

// `collector` is either { lock } (verify) or { update: true, collected } (rewrite the lock deliberately).
export function pinOrVerify(collector, id, format, identity) {
  if (collector.update) {
    (collector.collected[id] ??= {})[format] = identity;
    return;
  }
  const pinned = collector.lock.datasets?.[id]?.[format];
  if (!pinned) throw new Error(`${id}: no ${format} entry in ${LOCK_PATH} (regenerate it with DEMODB_UPDATE_DERIVED_LOCK=1 outside CI and review the diff)`);
  if (JSON.stringify(sortKeys(pinned)) !== JSON.stringify(sortKeys(identity))) {
    throw new Error(`${id}: derived ${format} export differs from ${LOCK_PATH}\n  locked    ${JSON.stringify(sortKeys(pinned))}\n  generated ${JSON.stringify(sortKeys(identity))}`);
  }
}

const sortKeys = (value) => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));

export function serializeLock(collected) {
  const datasets = Object.fromEntries(Object.entries(collected).sort(([a], [b]) => a.localeCompare(b)).map(([id, formats]) => [id, Object.fromEntries(Object.entries(formats).sort(([a], [b]) => a.localeCompare(b)).map(([format, identity]) => [format, sortKeys(identity)]))]));
  return `${JSON.stringify({ format: LOCK_FORMAT, datasets }, null, 2)}\n`;
}

// --- one dataset ----------------------------------------------------------------------------------------
async function readExportBytes(dataDir, item) {
  if (item.chunks?.length) {
    const parts = [];
    for (const chunk of item.chunks) parts.push(await readFile(join(dataDir, chunk.assetPath)));
    return gunzipSync(Buffer.concat(parts));
  }
  return decodeEntry(await readFile(join(dataDir, item.assetPath)), item);
}

const hostingTools = fileURLToPath(new URL('./hosting-tools/', import.meta.url));
const loadDialectConfig = async () => (await import('./dialect-scripts.mjs')).loadConfig();

// Produces every download that the matrix declares as derived, a provider artifact or an archive for this
// dataset, writes it into the dataset's internal asset directory and returns the registry entries.
// Nothing is produced for a format the matrix does not ask for, and every produced file is pinned by the lock.
export async function deriveDatasetExports({ db, row, source, collector, assetsRoot, python = 'python3', registryEntry, ingitdbRevision, localRoot }) {
  const dataDir = join(assetsRoot, db.id, 'data');
  const wants = (format, ...origins) => row[format]?.state === 'download' && origins.includes(row[format].origin);
  const placed = [];
  const place = async (format, bytes, lockIdentity = bytesIdentity(bytes)) => {
    pinOrVerify(collector, db.id, format, lockIdentity);
    placed.push(await placeDerivedExport({ id: db.id, format, bytes, destination: dataDir }));
  };

  if (wants('json', 'derived') || wants('yaml', 'derived')) {
    const tables = [];
    for (const table of db.tables.filter((item) => item.kind === 'table')) {
      const item = db.exports.find((candidate) => candidate.format === 'json' && candidate.table === table.name);
      if (!item) throw new Error(`${db.id}: cannot derive the complete JSON/YAML because ${table.name} has no per-table JSON export`);
      tables.push({ name: table.name, json: await readExportBytes(dataDir, item) });
    }
    if (wants('json', 'derived')) await place('json', jsonDocument(tables));
    if (wants('yaml', 'derived')) await place('yaml', yamlDocument(tables));
  }

  if (wants('postgresql', 'derived')) {
    const sqlite = db.exports.find((item) => item.format === 'sqlite' && !item.table);
    const script = await generatePostgresqlScript({
      python, script: join(hostingTools, 'postgres_samples.py'), manifest: source.manifest, decodedSqlite: await readExportBytes(dataDir, sqlite),
    });
    await place('postgresql', script);
  }
  if (wants('postgresql', 'provider-artifact')) {
    const path = 'artifacts/hosting-imports/postgres.sql';
    const bytes = await source.read(path);
    const entry = source.checksums.files?.[path];
    if (!entry || entry.sha256 !== sha256(bytes) || (entry.bytes != null && entry.bytes !== bytes.length)) throw new Error(`${db.id}: ${path} is not covered by the provider checksums`);
    await place('postgresql', bytes);
  }

  // Dialect scripts written by the DataTug exporter and checked into the provider repository: verified here (inputs hash,
  // stored bytes, header, marker table, licence) and then pinned by the lock like every other derived file.
  if (Object.values((await loadDialectConfig()).dialects).some((spec) => wants(spec.format, 'provider-script'))) {
    const scripts = await import('./dialect-scripts.mjs');
    const config = await scripts.loadConfig();
    for (const [dialect, spec] of Object.entries(config.dialects)) {
      if (!wants(spec.format, 'provider-script')) continue;
      const result = await scripts.verifyDialectScript({ id: db.id, manifest: source.manifest, dialect, config, read: source.read });
      if (result.problems.length) throw new Error(`${db.id}: the ${dialect} script of the provider is not valid:\n  ${result.problems.join('\n  ')}`);
      await place(spec.format, result.bytes);
    }
  }

  if (wants('ingitdb', 'archive')) {
    const sqlite = db.exports.find((item) => item.format === 'sqlite' && !item.table);
    const fixtureSha256 = sqlite.decodedSha256 ?? sqlite.sha256;
    const scratch = await mkdtemp(join(tmpdir(), 'demodb-ingitdb-'));
    try {
      const output = join(scratch, `${db.id}.ingitdb.zip`);
      const args = [join(hostingTools, 'ingitdb_archive.py'), db.id, '--fixture-sha256', fixtureSha256, '--output', output];
      if (localRoot) args.push('--directory', join(localRoot, db.id, 'ingitdb'));
      else args.push('--repository', registryEntry.repository, '--revision', ingitdbRevision);
      const result = spawnSync(python, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      if (result.error) throw new Error(`could not start ${python}: ${result.error.message}`);
      if (result.status !== 0) throw new Error(`${db.id}: ingitdb_archive.py failed: ${result.stderr || result.stdout}`);
      const report = JSON.parse(result.stdout);
      const archive = await readFile(output);
      pinOrVerify(collector, db.id, 'ingitdb', { contentSha256: report.contentSha256, fileCount: report.fileCount, rowCount: report.rowCount });
      const entry = await placeDerivedExport({ id: db.id, format: 'ingitdb', bytes: archive, destination: dataDir });
      if (entry.compression) throw new Error(`${db.id}: the inGitDB archive is ${archive.length} bytes, above the static asset limit; declare it unavailable in config/format-matrix.json`);
      placed.push(entry);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
  return placed;
}
