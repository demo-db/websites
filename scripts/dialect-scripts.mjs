// Verified SQL scripts of the DemoDB datasets in other database engines (today: MySQL).
//
// A script is written by the DataTug faithful SQL-script exporter (`datatug db copy --to sqlscript://...?dialect=mysql`,
// pinned in config/dialect-scripts.json by release tag and SHA-256) from the provider's pinned SQLite fixture and is
// checked into the provider repository under dialect-scripts/, next to a manifest that records everything that decides
// the bytes. The site serves those bytes (origin `provider-script` in config/format-matrix.json) after this module has
// verified them, and config/derived-exports.lock.json pins their decoded SHA-256 as it does for every derived export.
//
//   node scripts/dialect-scripts.mjs generate --provider <provider checkout> [--force] [--tools <dir>]
//       writes or refreshes dialect-scripts/ in one provider checkout. It runs the pinned datatug only when the inputs
//       hash differs from the manifest (the guard: unchanged inputs never rewrite a byte), and keeps the stored bytes
//       when a regeneration reproduces the same decoded script, so a zlib difference never churns a provider repository.
//   node scripts/dialect-scripts.mjs check (--provider <checkout> | --providers <dir of <id> checkouts>)
//       the lane that needs neither the datatug binary nor Docker: inputs hash, stored bytes, decoded SHA-256, header,
//       line starts, marker table and licence, against the provider manifest.json.
//   node scripts/dialect-scripts.mjs regenerate-check --providers <dir> [--tools <dir>]
//       regenerates every script with the pinned datatug into a scratch directory and fails on any decoded byte that
//       differs from the committed script (the check of the non-required served-formats-live workflow).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { MAX_ASSET_BYTES, chunkEncoded, deterministicGzip } from './derived-exports.mjs';

export const CONFIG_FORMAT = 'demodb-dialect-scripts-config/v1';
export const MANIFEST_FORMAT = 'demodb-dialect-scripts/v1';
export const REPORT_FORMAT = 'demodb-dialect-report/v1';
export const DIALECT_DIR = 'dialect-scripts';
export const MANIFEST_PATH = `${DIALECT_DIR}/manifest.json`;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const isHash = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

const sortDeep = (value) => {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, item]) => [key, sortDeep(item)]));
  return value;
};
export const canonicalJson = (value) => JSON.stringify(sortDeep(value));
export const serializeJson = (value) => `${JSON.stringify(sortDeep(value), null, 2)}\n`;

// --- configuration ----------------------------------------------------------------------------------------
export function validateConfig(config) {
  const problems = [];
  if (config?.format !== CONFIG_FORMAT) problems.push(`format must be ${CONFIG_FORMAT}`);
  const generator = config?.generator ?? {};
  if (generator.name !== 'datatug') problems.push('generator.name must be datatug');
  if (!/^v\d+\.\d+\.\d+$/.test(generator.tag ?? '')) problems.push('generator.tag must be an exact release tag such as v0.97.1 (never latest)');
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases\/download\/v\d+\.\d+\.\d+$/.test(generator.downloadBase ?? '')) problems.push('generator.downloadBase must be a GitHub release download URL of the tag');
  if (!String(generator.downloadBase ?? '').endsWith(`/${generator.tag}`)) problems.push('generator.downloadBase must end with the tag');
  if (!isHash(generator.checksumsSha256) || typeof generator.checksumsFile !== 'string') problems.push('generator needs checksumsFile and checksumsSha256');
  const assets = generator.assets ?? {};
  if (Object.keys(assets).length === 0) problems.push('generator.assets is empty');
  for (const [platform, asset] of Object.entries(assets)) {
    if (typeof asset?.name !== 'string' || !asset.name.includes(generator.tag?.slice(1) ?? '\0') || !isHash(asset.sha256)) problems.push(`generator.assets.${platform} needs a name of this release and a SHA-256`);
  }
  if (typeof config?.edition !== 'string' || config.edition.length === 0 || config.edition.length > 255) problems.push('edition must be a label of at most 255 characters');
  if (config?.notice?.enabled && (typeof config.notice.param !== 'string' || !/^[a-z][a-z-]*$/.test(config.notice.param))) problems.push('notice.enabled needs notice.param, the exporter parameter that takes the notice file');
  for (const [dialect, spec] of Object.entries(config?.dialects ?? {})) {
    if (!/^[a-z][a-z0-9]*$/.test(dialect) || !/^[a-z][a-z0-9]*$/.test(spec.format ?? '') || typeof spec.extension !== 'string' || !spec.extension.endsWith('.sql') || typeof spec.marker !== 'string') problems.push(`dialects.${dialect} is incomplete`);
  }
  if (problems.length) throw new Error(`config/dialect-scripts.json is invalid:\n  ${problems.join('\n  ')}`);
  return config;
}

export const platformKey = (platform = process.platform, arch = process.arch) => `${platform}-${arch}`;

// The release is trusted only through two pins in this repository: the SHA-256 of the checksums file and the SHA-256 of
// the asset itself. The asset must also be named by the checksums file with the same digest. Any disagreement is an error.
export function verifyRelease(config, checksumsText, assetName, assetBytes) {
  const { generator } = config;
  if (sha256(Buffer.from(checksumsText)) !== generator.checksumsSha256) throw new Error(`${generator.checksumsFile} does not match its pinned SHA-256 ${generator.checksumsSha256}`);
  const pinned = Object.values(generator.assets).find((asset) => asset.name === assetName);
  if (!pinned) throw new Error(`${assetName} is not one of the pinned datatug ${generator.tag} assets`);
  const listed = checksumsText.split('\n').map((line) => line.trim().split(/\s+/)).find((parts) => parts[1] === assetName);
  if (!listed || listed[0] !== pinned.sha256) throw new Error(`${assetName}: the pinned SHA-256 is not the one in ${generator.checksumsFile}`);
  const actual = sha256(assetBytes);
  if (actual !== pinned.sha256) throw new Error(`${assetName}: SHA-256 is ${actual}, pinned ${pinned.sha256}`);
}

async function download(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'DemoDB-dialect-scripts/1' }, redirect: 'follow' });
  if (!response.ok) throw new Error(`GET ${url} failed with ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

// Returns the path of the pinned datatug binary, downloading and verifying it once into the tools directory.
export async function ensureDatatug(config, toolsDir, key = platformKey()) {
  const { generator } = config;
  const asset = generator.assets[key];
  if (!asset) throw new Error(`datatug ${generator.tag} has no pinned asset for ${key}; pinned: ${Object.keys(generator.assets).join(', ')}`);
  if (!asset.name.endsWith('.tar.gz')) throw new Error(`${asset.name}: only .tar.gz assets are supported`);
  const dir = join(toolsDir, `datatug-${generator.tag}-${key}`);
  const binary = join(dir, 'datatug');
  const tarball = join(dir, asset.name);
  // Nothing in the cache is trusted because this program wrote it: the kept archive is hashed again on every use and the binary is
  // unpacked from it again, so a changed cache file or binary is replaced or refused, never run.
  if (existsSync(tarball) && sha256(await readFile(tarball)) === asset.sha256) {
    const unpacked = spawnSync('tar', ['-xzf', tarball, '-C', dir, 'datatug'], { encoding: 'utf8' });
    if (unpacked.status === 0) return binary;
  }
  const checksumsText = (await download(`${generator.downloadBase}/${generator.checksumsFile}`)).toString('utf8');
  const bytes = await download(`${generator.downloadBase}/${asset.name}`);
  verifyRelease(config, checksumsText, asset.name, bytes);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await writeFile(tarball, bytes);
  const unpacked = spawnSync('tar', ['-xzf', tarball, '-C', dir, 'datatug'], { encoding: 'utf8' });
  if (unpacked.status !== 0) throw new Error(`could not unpack ${asset.name}: ${unpacked.stderr}`);
  return binary;
}

// --- inputs and the guard ---------------------------------------------------------------------------------
export const sqliteSha256Of = (manifest) => manifest.source?.databaseSha256 ?? manifest.source?.sha256;

// The licence notice a script header carries in full, written from the upstream licence files (config/dialect-notices/<id>.txt) and
// switched on in config/dialect-scripts.json (`notice.enabled`, with the exporter parameter that takes it) when the pinned datatug
// release can write a multi-line notice. Off, it changes no input and no byte.
export function noticeOf(id, config) {
  if (!config.notice?.enabled) return null;
  const path = resolve(root, config.notice.dir ?? 'config/dialect-notices', `${id}.txt`);
  if (!existsSync(path)) throw new Error(`${id}: notice.enabled is set but ${path} does not exist`);
  const text = readFileSync(path, 'utf8');
  if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\ufeff]/.test(text) || !text.endsWith('\n')) throw new Error(`${id}: the notice file must be LF text (tab allowed, no other control character) ending in a line break`);
  return text;
}

export function inputsOf({ manifest, config, dialect, attribution }) {
  const sha = sqliteSha256Of(manifest);
  if (!isHash(sha)) throw new Error(`${manifest.id}: manifest.json pins no decoded SQLite SHA-256 (source.databaseSha256 or source.sha256)`);
  const license = manifest.source?.license;
  if (typeof license !== 'string' || license.length === 0) throw new Error(`${manifest.id}: manifest.json has no source.license`);
  if (typeof attribution !== 'string' || attribution.length === 0) throw new Error(`${manifest.id}: ${MANIFEST_PATH} has no attribution`);
  // The exporter writes each of these as ONE comment line, collapses runs of white space and cuts the line at 400 bytes ("Attribution: " included)
  // with "...": an attribution that long would reach the header shortened, silently. Refuse it here instead.
  for (const [what, value, prefix] of [['attribution', attribution, 'Attribution: '], ['licence', license, 'Licence: '], ['edition', config.edition, '']]) {
    if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value) || value !== value.trim().replace(/\s+/g, ' ')) throw new Error(`${manifest.id}: the ${what} must be one line without control characters or runs of white space`);
    if (Buffer.byteLength(prefix + value) > 400) throw new Error(`${manifest.id}: the ${what} is ${Buffer.byteLength(prefix + value)} bytes with its header prefix; the exporter cuts a header line at 400 bytes`);
  }
  const notice = noticeOf(manifest.id, config);
  return {
    attribution,
    dialect,
    edition: config.edition,
    generator: { checksumsSha256: config.generator.checksumsSha256, tag: config.generator.tag },
    license,
    name: manifest.id,
    ...(notice ? { noticeSha256: sha256(Buffer.from(notice)) } : {}),
    sqliteSha256: sha,
  };
}
export const inputsSha256Of = (inputs) => sha256(Buffer.from(canonicalJson(inputs)));

// --- the committed files ----------------------------------------------------------------------------------
export const storedPaths = (id, dialect, config, mode, chunkCount = 0) => {
  const base = `${DIALECT_DIR}/${id}.${config.dialects[dialect].extension}`;
  if (mode === 'plain') return [base];
  if (mode === 'gzip') return [`${base}.gz`];
  return Array.from({ length: chunkCount }, (_, index) => `${base}.gz.part-${String(index + 1).padStart(4, '0')}`);
};

// Encodes a decoded script the way every provider export is stored: plain up to 25 MiB, else deterministic gzip
// (level 9, zero timestamp), else gzip split into ordered ".gz.part-NNNN" files.
export function encodeScript(id, dialect, config, bytes) {
  if (bytes.length <= MAX_ASSET_BYTES) return { mode: 'plain', files: new Map([[storedPaths(id, dialect, config, 'plain')[0], bytes]]) };
  const encoded = deterministicGzip(bytes);
  if (encoded.length <= MAX_ASSET_BYTES) return { mode: 'gzip', files: new Map([[storedPaths(id, dialect, config, 'gzip')[0], encoded]]) };
  const pieces = chunkEncoded(encoded);
  const paths = storedPaths(id, dialect, config, 'chunks', pieces.length);
  return { mode: 'chunks', files: new Map(pieces.map((piece, index) => [paths[index], piece])) };
}

export const describeStored = (mode, files, decoded) => {
  const entries = [...files.entries()];
  const stored = { mode, files: entries.map(([path, content]) => ({ bytes: content.length, path, sha256: sha256(content) })) };
  if (mode !== 'plain') {
    const encoded = Buffer.concat(entries.map(([, content]) => content));
    stored.encodedBytes = encoded.length;
    stored.encodedSha256 = sha256(encoded);
    stored.compression = 'gzip';
  }
  return { ...stored, decodedBytes: decoded.length, decodedSha256: sha256(decoded) };
};

// Reads the stored files named by a manifest record through `read(path)`, checks every size and digest and returns the
// decoded script.
export async function readStoredScript(record, read) {
  const stored = record.stored;
  if (!stored || !['plain', 'gzip', 'chunks'].includes(stored.mode) || !Array.isArray(stored.files) || stored.files.length === 0) throw new Error('the manifest record names no stored files');
  const parts = [];
  for (const file of stored.files) {
    if (typeof file.path !== 'string' || !file.path.startsWith(`${DIALECT_DIR}/`) || file.path.includes('..')) throw new Error(`unsafe stored path ${file.path}`);
    const bytes = await read(file.path);
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new Error(`${file.path} does not match the manifest (size or SHA-256)`);
    parts.push(bytes);
  }
  let decoded;
  if (stored.mode === 'plain') decoded = parts[0];
  else {
    const encoded = Buffer.concat(parts);
    if (encoded.length !== stored.encodedBytes || sha256(encoded) !== stored.encodedSha256) throw new Error('the gzip stream does not match the manifest');
    try { decoded = gunzipSync(encoded); } catch (error) { throw new Error(`the stored script is not a complete gzip stream: ${error.message}`); }
  }
  if (decoded.length !== stored.decodedBytes || sha256(decoded) !== stored.decodedSha256) throw new Error('the decoded script does not match the manifest (size or SHA-256)');
  return decoded;
}

// --- the script itself ------------------------------------------------------------------------------------
// Tokens the exporter emits at the start of a script line. No data byte can start a line (a value with a line break is written as
// hex), so a line starting with anything else is a script that someone edited. An indented line is a column or key definition.
const LINE_START = [/^$/, /^--/, /^SET /, /^CREATE /, /^INSERT /, /^\(/, /^START /, /^COMMIT/, /^ALTER /, /^\)/,
  /^ {2}(`|PRIMARY KEY|UNIQUE KEY|UNIQUE |KEY |CONSTRAINT |CHECK |FOREIGN KEY|INDEX )/];

// Walks the script as the mysql client does and reports the first thing no exporter output contains:
//   * a backslash anywhere outside a `--` comment line (the client reads `\` as an escape in a string and as a command start
//     elsewhere, and the exporter writes a value with a backslash as hex);
//   * `#` or `/*` outside a string or a quoted name (a comment or a conditional comment the exporter never writes), or `--` after
//     the start of a line;
//   * a raw line break inside a string or a quoted name (a value with a line break is written as hex);
//   * anything after a `;` on the same line (`COMMIT; \! cmd` would run a second command).
// `--` comment lines are skipped whole: the header is free text and the client ignores a comment line.
export function literalProblems(bytes) {
  const problems = [];
  const n = bytes.length;
  let state = 0; // 0 statement text, 1 string literal, 2 quoted name
  let line = 1;
  let atLineStart = true;
  const report = (message) => { if (problems.length < 5) problems.push(`line ${line}: ${message}`); };
  for (let i = 0; i < n; i += 1) {
    const c = bytes[i];
    if (c === 0x0a) {
      if (state !== 0) report(state === 1 ? 'a raw line break inside a string literal' : 'a raw line break inside a quoted name');
      state = 0; line += 1; atLineStart = true;
      continue;
    }
    if (state === 0 && atLineStart && c === 0x2d && bytes[i + 1] === 0x2d) {
      const end = bytes.indexOf(0x0a, i);
      if (end === -1) break;
      i = end - 1;
      continue;
    }
    const wasLineStart = atLineStart;
    atLineStart = false;
    if (c === 0x5c) { report('a backslash outside a comment line'); continue; }
    if (state === 1) { if (c === 0x27) { if (bytes[i + 1] === 0x27) i += 1; else state = 0; } continue; }
    if (state === 2) { if (c === 0x60) { if (bytes[i + 1] === 0x60) i += 1; else state = 0; } continue; }
    if (c === 0x27) state = 1;
    else if (c === 0x60) state = 2;
    else if (c === 0x23) report('a # comment');
    else if (c === 0x2f && bytes[i + 1] === 0x2a) report('a /* comment');
    else if (c === 0x2d && bytes[i + 1] === 0x2d && !wasLineStart) report('a -- comment inside a line');
    else if (c === 0x3b && i + 1 < n && bytes[i + 1] !== 0x0a) report('text after a semicolon on the same line');
  }
  if (state !== 0) report('the script ends inside a literal or a quoted name');
  return problems;
}

// What the exporter writes for `notice-file` (datatug v0.100.0, docs/db-copy.md "Licence notice"): every line of the file becomes one `-- ` comment
// line right after the licence and attribution lines and a blank comment line (`--`); a tab becomes four spaces, `*/` and `/*` get a space between the
// two characters, trailing spaces and the blank lines at both ends are dropped (a blank line inside stays a bare `--`). CRLF and the other line
// breaks end a line. The notice files here are LF text without other control characters (noticeOf refuses the rest), so these are the only rules that apply.
export function expectedNoticeLines(notice) {
  const lines = notice.split('\n').map((line) => line.replaceAll('\t', '    ').replaceAll('*/', '* /').replaceAll('/*', '/ *').trimEnd());
  while (lines.length && lines[0] === '') lines.shift();
  while (lines.length && lines.at(-1) === '') lines.pop();
  return lines.map((line) => (line === '' ? '--' : `-- ${line}`));
}

export function noticeProblems(lines, notice, attribution) {
  const expected = expectedNoticeLines(notice);
  const at = lines.indexOf(`-- Attribution: ${attribution}`);
  if (at === -1) return ['the header has no attribution line to anchor the licence notice'];
  if (lines[at + 1] !== '--') return ['the licence notice does not follow the attribution after a blank comment line'];
  for (const [index, line] of expected.entries()) {
    if (lines[at + 2 + index] !== line) return [`the header lacks the licence notice line ${index + 1} (${JSON.stringify(line.slice(0, 60))}); the notice must follow the attribution line by line`];
  }
  return [];
}

export function scriptProblems(bytes, { id, inputs, spec, notice = null }) {
  const problems = [];
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) problems.push('the script starts with a byte order mark');
  if (bytes.includes(0x0d)) problems.push('the script holds a CR byte (LF line ends only)');
  if (bytes.includes(0x00)) problems.push('the script holds a NUL byte');
  const text = bytes.toString('utf8');
  if (Buffer.byteLength(text, 'utf8') !== bytes.length || text.includes('�')) problems.push('the script is not valid UTF-8');
  const lines = text.split('\n');
  // The header is the leading block of comment lines (a long licence notice makes it long).
  const header = lines.slice(0, Math.max(1, lines.findIndex((line) => !line.startsWith('--'))));
  const expectHeader = (prefix, value, what) => {
    if (!header.some((line) => line === `${prefix}${value}`)) problems.push(`the header lacks ${what}`);
  };
  if (lines[0] !== `-- ${inputs.edition}`) problems.push('the first line is not the contract-edition label');
  expectHeader('-- Dataset: ', id, 'the dataset name');
  expectHeader('-- Licence: ', inputs.license, 'the licence of the provider manifest');
  expectHeader('-- Attribution: ', inputs.attribution, 'the attribution of the provider');
  if (inputs.noticeSha256) problems.push(...noticeProblems(lines, notice, inputs.attribution));
  if (!header.some((line) => line.startsWith(`-- Generated by datatug ${inputs.generator.tag} (`) && line.endsWith(`SHA-256 ${inputs.sqliteSha256}`))) problems.push('the header does not name the pinned datatug release and the SQLite SHA-256');
  if (!header.some((line) => line.includes(spec.clientFlags.split(' ')[1]))) problems.push('the header does not recommend the safe client flags');
  const statements = lines.filter((line) => line.startsWith('CREATE TABLE') || line.startsWith('INSERT INTO `' + spec.marker));
  if (!statements[0]?.startsWith(`CREATE TABLE \`${spec.marker}\``)) problems.push(`the first statement is not the creation of the marker table ${spec.marker}`);
  const insertMarker = `INSERT INTO \`${spec.marker}\` VALUES ('${id}', `;
  const last = lines.filter((line) => line.length > 0).at(-2);
  if (!last?.startsWith(insertMarker) || !last.includes(`'${inputs.sqliteSha256}'`)) problems.push('the last statement does not fill the marker table with the dataset and the SQLite SHA-256');
  if (lines.filter((line) => line.length > 0).at(-1) !== '-- end of script') problems.push('the script does not end with its completion comment');
  for (const [index, line] of lines.entries()) {
    if (!LINE_START.some((pattern) => pattern.test(line))) { problems.push(`line ${index + 1} starts with something the exporter never writes: ${JSON.stringify(line.slice(0, 40))}`); break; }
  }
  problems.push(...literalProblems(bytes));
  return problems;
}

// --- one provider -----------------------------------------------------------------------------------------
async function readJsonFile(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

// Verifies one dialect script of one provider through `read(path)` (a file system or a pinned-revision reader).
// Returns { bytes, record, inputs, problems }. `problems` lists every disagreement; `bytes` is null when the stored files
// cannot be read.
export async function verifyDialectScript({ id, manifest, dialect, config, read, requireVerification = true }) {
  const problems = [];
  const spec = config.dialects[dialect];
  if (!spec) return { bytes: null, problems: [`no ${dialect} dialect in config/dialect-scripts.json`] };
  let dialectManifest;
  try { dialectManifest = JSON.parse((await read(MANIFEST_PATH)).toString('utf8')); } catch (error) { return { bytes: null, problems: [`${MANIFEST_PATH} is not readable: ${error.message}`] }; }
  if (dialectManifest.format !== MANIFEST_FORMAT) problems.push(`${MANIFEST_PATH} must declare ${MANIFEST_FORMAT}`);
  if (dialectManifest.id !== id || manifest.id !== id) problems.push(`${MANIFEST_PATH} is for ${dialectManifest.id}, not ${id}`);
  const record = dialectManifest.scripts?.[dialect];
  if (!record) return { bytes: null, problems: [...problems, `${MANIFEST_PATH} has no ${dialect} script`] };
  let inputs;
  try { inputs = inputsOf({ manifest, config, dialect, attribution: dialectManifest.attribution }); } catch (error) { return { bytes: null, problems: [...problems, error.message] }; }
  if (record.inputsSha256 !== inputsSha256Of(inputs)) problems.push(`${dialect}: the inputs changed (SQLite fixture, datatug pin, edition label, licence or attribution) since the script was generated: regenerate it (node scripts/dialect-scripts.mjs generate)`);
  if (canonicalJson(record.inputs) !== canonicalJson(inputs)) problems.push(`${dialect}: the inputs recorded in the manifest are not the inputs the provider manifest and config give now`);
  let bytes = null;
  try { bytes = await readStoredScript(record, read); } catch (error) { problems.push(`${dialect}: ${error.message}`); }
  if (bytes) {
    problems.push(...scriptProblems(bytes, { id, inputs, spec, notice: noticeOf(id, config) }).map((problem) => `${dialect}: ${problem}`));
    if (record.verification && record.verification.scriptSha256 !== record.stored.decodedSha256) problems.push(`${dialect}: the recorded verification is for another script (${record.verification.scriptSha256})`);
    if (requireVerification) {
      const v = record.verification;
      if (!v) problems.push(`${dialect}: the manifest records no verification of this script (load it into ${spec.verifiedOn} and run the cross-engine verifier, then: node scripts/dialect-scripts.mjs record-verification)`);
      else if (v.differences !== 0 || !(v.rows > 0) || !(v.tables > 0) || v.secondLoadRefusedAtMarkerTable !== true) problems.push(`${dialect}: the recorded verification is not a clean one (differences ${v.differences}, rows ${v.rows}, tables ${v.tables})`);
    }
    if (record.report) {
      try {
        const reportBytes = await read(record.report.path);
        if (sha256(reportBytes) !== record.report.sha256 || reportBytes.length !== record.report.bytes) problems.push(`${dialect}: ${record.report.path} does not match the manifest`);
      } catch (error) { problems.push(`${dialect}: report not readable: ${error.message}`); }
    } else problems.push(`${dialect}: the manifest records no report`);
  }
  return { bytes, record, inputs, problems };
}

const fsReader = (dir) => async (path) => {
  if (path.includes('..') || path.startsWith('/')) throw new Error(`unsafe path ${path}`);
  return readFile(join(dir, path));
};

export async function checkProvider(dir, config, dialect = 'mysql', { requireVerification = true, checkSqlite = true } = {}) {
  const manifest = await readJsonFile(join(dir, 'manifest.json'));
  const result = await verifyDialectScript({ id: manifest.id, manifest, dialect, config, read: fsReader(dir), requireVerification });
  const problems = [...result.problems];
  if (checkSqlite && existsSync(join(dir, manifest.dataFile ?? ''))) {
    try { await sqliteBytes(dir, manifest); } catch (error) { problems.push(error.message); }
  }
  return problems;
}

// Compact, path-free report kept next to the script: what the exporter could not carry exactly.
export function prunedReport({ id, dialect, config, report }) {
  return {
    dataset: id,
    dialect,
    format: REPORT_FORMAT,
    generator: config.generator.tag,
    tables: (report.tables ?? []).map((table) => ({ columns: table.columns, name: table.name, rows: table.rows })),
    totals: report.totals ?? null,
    warnings: (report.warnings ?? []).map((warning) => ({ kind: warning.kind, message: warning.message, object: warning.object })),
  };
}

async function sqliteBytes(dir, manifest) {
  const raw = await readFile(join(dir, manifest.dataFile));
  const bytes = manifest.source?.inputCompression === 'gzip' || manifest.dataFile.endsWith('.gz') ? gunzipSync(raw) : raw;
  const sha = sqliteSha256Of(manifest);
  if (sha256(bytes) !== sha) throw new Error(`${manifest.id}: ${manifest.dataFile} does not decode to the pinned SQLite SHA-256 ${sha}`);
  return bytes;
}

// Runs the pinned datatug over the provider's SQLite and returns { script, report } (decoded bytes and the pruned report).
export async function runExporter({ dir, manifest, config, dialect, attribution, binary }) {
  const scratch = await mkdtemp(join(tmpdir(), 'demodb-dialect-'));
  try {
    const source = join(scratch, `${manifest.id}.sqlite`);
    await writeFile(source, await sqliteBytes(dir, manifest));
    const output = join(scratch, `${manifest.id}.${config.dialects[dialect].extension}`);
    const inputs = inputsOf({ manifest, config, dialect, attribution });
    const enc = (value) => encodeURIComponent(value);
    let destination = `sqlscript://${output}?dialect=${enc(dialect)}&name=${enc(inputs.name)}&license=${enc(inputs.license)}&attribution=${enc(inputs.attribution)}&edition=${enc(inputs.edition)}`;
    const notice = noticeOf(manifest.id, config);
    if (notice) {
      const noticePath = join(scratch, 'notice.txt');
      await writeFile(noticePath, notice);
      destination += `&${config.notice.param}=${enc(noticePath)}`;
    }
    const result = spawnSync(binary, ['db', 'copy', '--from', `sqlite://${source}`, '--to', destination, '--json'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, DATATUG_TELEMETRY: '0' } });
    if (result.error) throw new Error(`could not start ${binary}: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`${manifest.id}: datatug db copy exited ${result.status}: ${result.stderr || result.stdout}`);
    const report = JSON.parse(result.stdout);
    if (report.exitCode !== 0 && report.exitCode != null) throw new Error(`${manifest.id}: datatug reported exit code ${report.exitCode}`);
    return { report: prunedReport({ id: manifest.id, dialect, config, report }), script: await readFile(output) };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function atomicWrite(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, bytes);
  await rename(temporary, path);
}

// Refreshes dialect-scripts/ of one provider checkout. Returns 'unchanged', 'regenerated' or 'rewritten'.
export async function generateProvider({ dir, config, dialect = 'mysql', force = false, getBinary }) {
  const manifest = await readJsonFile(join(dir, 'manifest.json'));
  const id = manifest.id;
  const manifestPath = join(dir, MANIFEST_PATH);
  const dialectManifest = existsSync(manifestPath) ? await readJsonFile(manifestPath) : null;
  if (!dialectManifest?.attribution) throw new Error(`${id}: ${MANIFEST_PATH} must exist with an "attribution" text written by the provider before a script is generated`);
  const inputs = inputsOf({ manifest, config, dialect, attribution: dialectManifest.attribution });
  const hash = inputsSha256Of(inputs);
  const previous = dialectManifest.scripts?.[dialect];
  if (!force && previous?.inputsSha256 === hash && (await checkProvider(dir, config, dialect, { requireVerification: false, checkSqlite: false })).length === 0) return 'unchanged';
  const binary = await getBinary();
  const { report, script } = await runExporter({ dir, manifest, config, dialect, attribution: dialectManifest.attribution, binary });
  const reportBytes = Buffer.from(serializeJson(report));
  const reportPath = `${DIALECT_DIR}/${id}.${dialect}.report.json`;
  let stored = previous?.stored;
  let outcome = 'rewritten';
  // The same decoded script keeps its stored bytes: only a different script is written again.
  if (stored && stored.decodedSha256 === sha256(script) && stored.decodedBytes === script.length) outcome = 'regenerated';
  else {
    const encoded = encodeScript(id, dialect, config, script);
    for (const old of stored?.files ?? []) await rm(join(dir, old.path), { force: true });
    for (const [path, content] of encoded.files) await atomicWrite(join(dir, path), content);
    stored = describeStored(encoded.mode, encoded.files, script);
  }
  await atomicWrite(join(dir, reportPath), reportBytes);
  const record = {
    // A recorded verification belongs to one script: it is kept only when the regeneration reproduced those bytes.
    ...(outcome === 'regenerated' && previous?.verification ? { verification: previous.verification } : {}),
    inputs,
    inputsSha256: hash,
    report: { bytes: reportBytes.length, path: reportPath, sha256: sha256(reportBytes), warnings: countKinds(report.warnings) },
    stored,
  };
  dialectManifest.format = MANIFEST_FORMAT;
  dialectManifest.id = id;
  dialectManifest.scripts = { ...(dialectManifest.scripts ?? {}), [dialect]: record };
  await atomicWrite(manifestPath, Buffer.from(serializeJson(dialectManifest)));
  const problems = await checkProvider(dir, config, dialect, { requireVerification: false });
  if (problems.length) throw new Error(`${id}: the generated script fails its own check:\n  ${problems.join('\n  ')}`);
  return outcome;
}

const countKinds = (warnings) => Object.fromEntries(Object.entries(warnings.reduce((counts, warning) => ({ ...counts, [warning.kind]: (counts[warning.kind] ?? 0) + 1 }), {})).sort(([a], [b]) => (a < b ? -1 : 1)));

// --- the provider pins -----------------------------------------------------------------------------------------
// config/databases.json pins one commit per provider. A pin the provider's `main` does not contain would serve files nobody reviewed on
// main (a squash or rebase of the provider pull request leaves the pinned head behind). GitHub's compare of main...<commit> says which:
//   identical, behind  the commit is on main: good
//   ahead              the commit is only on a branch or pull request: refused in strict mode (the push to main that deploys),
//                      reported in `warn-ahead` mode (a pull request, so its CI can run before the providers land)
//   diverged, error    refused in both modes
export function classifyPin(status) {
  if (status === 'identical' || status === 'behind') return 'on-main';
  if (status === 'ahead') return 'ahead';
  return 'refused';
}

export async function pinProblems({ databases, fetchJson, mode = 'strict' }) {
  const problems = [];
  const notes = [];
  for (const entry of databases) {
    const slug = new URL(entry.repository).pathname.replace(/^\/|\/$/g, '');
    let status;
    try { status = (await fetchJson(`https://api.github.com/repos/${slug}/compare/main...${entry.commit}`)).status; } catch (error) { problems.push(`${entry.id}: cannot compare ${entry.commit} with main of ${slug}: ${error.message}`); continue; }
    const verdict = classifyPin(status);
    if (verdict === 'on-main') continue;
    if (verdict === 'ahead' && mode === 'warn-ahead') { notes.push(`${entry.id}: ${entry.commit} is not on main of ${slug} yet (it is ahead of it): land the provider pull request, then re-pin if its commit changed`); continue; }
    problems.push(`${entry.id}: the pinned commit ${entry.commit} is ${status}, not on main of ${slug}${verdict === 'ahead' ? ' (land the provider pull request first, then pin the commit main now has)' : ''}`);
  }
  return { problems, notes };
}

async function githubJson(url) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'DemoDB-dialect-scripts/1', ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) };
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`GET ${url} returned ${response.status}`);
  return response.json();
}

// Writes the verification block of one provider script from the numbers of a cross-engine verifier run over exactly that script.
export async function recordVerification({ dir, config, dialect = 'mysql', result }) {
  const manifestPath = join(dir, MANIFEST_PATH);
  const dialectManifest = await readJsonFile(manifestPath);
  const record = dialectManifest.scripts?.[dialect];
  if (!record) throw new Error(`${dir}: no ${dialect} script to record a verification for`);
  for (const key of ['tables', 'rows', 'valuesCompared', 'differences', 'verifierWarnings']) if (!Number.isInteger(result[key]) || result[key] < 0) throw new Error(`--${key} must be a non-negative integer`);
  if (result.differences !== 0) throw new Error('a verification with differences is not recorded');
  const spec = config.dialects[dialect];
  record.verification = {
    date: result.date ?? new Date().toISOString().slice(0, 10),
    differences: 0,
    engine: result.engine,
    image: spec.serverImage,
    loadedWith: `${spec.clientFlags}, stop at first error`,
    rows: result.rows,
    scriptSha256: record.stored.decodedSha256,
    secondLoadRefusedAtMarkerTable: true,
    tables: result.tables,
    valuesCompared: result.valuesCompared,
    verifier: result.verifier,
    verifierWarnings: result.verifierWarnings,
  };
  await atomicWrite(manifestPath, Buffer.from(serializeJson(dialectManifest)));
}

// --- command line -----------------------------------------------------------------------------------------
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function loadConfig() {
  return validateConfig(await readJsonFile(join(root, 'config/dialect-scripts.json')));
}

function parseArgs(argv) {
  const options = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--force') options.force = true;
    else if (arg.startsWith('--')) options[arg.slice(2)] = argv[++index];
    else options._.push(arg);
  }
  return options;
}

async function datasetIds() {
  return (await readJsonFile(join(root, 'config/databases.json'))).databases.map((entry) => entry.id);
}

async function main(argv) {
  const [command, ...rest] = argv;
  const options = parseArgs(rest);
  const config = await loadConfig();
  const toolsDir = resolve(options.tools ?? process.env.DEMODB_TOOLS_DIR ?? join(tmpdir(), 'demodb-tools'));
  const dirs = options.provider ? [resolve(options.provider)] : options.providers ? (await datasetIds()).map((id) => join(resolve(options.providers), id)) : [];
  if (dirs.length === 0 && ['generate', 'check', 'regenerate-check', 'record-verification'].includes(command)) throw new Error('pass --provider <checkout> or --providers <directory of checkouts named by dataset id>');
  if (command === 'generate') {
    let binary = null;
    const getBinary = async () => (binary ??= await ensureDatatug(config, toolsDir));
    for (const dir of dirs) console.log(`${dir}: ${await generateProvider({ dir, config, force: options.force === true, getBinary })}`);
    return 0;
  }
  if (command === 'check-pins') {
    const { problems, notes } = await pinProblems({ databases: (await readJsonFile(join(root, 'config/databases.json'))).databases, fetchJson: githubJson, mode: options.mode ?? process.env.DEMODB_PIN_MODE ?? 'strict' });
    for (const note of notes) console.warn(`::warning::${note}`);
    for (const problem of problems) console.error(problem);
    if (!problems.length) console.log(notes.length ? `no pin is refused (${notes.length} unlanded pull request head(s) allowed in warn-ahead mode)` : "every pinned provider commit is on main");
    return problems.length ? 1 : 0;
  }
  if (command === 'record-verification') {
    const number = (name) => (options[name] === undefined ? NaN : Number(options[name]));
    await recordVerification({ dir: dirs[0], config, result: {
      tables: number('tables'), rows: number('rows'), valuesCompared: number('values'), differences: number('differences'), verifierWarnings: number('warnings'),
      engine: options.engine ?? 'MySQL 8.4.11 (official mysql:8.4 image)', date: options.date,
      verifier: options.verifier ?? `datatug-cli internal/crossverify TestJourneyMySQL at ${config.generator.tag}, run locally over this exact script, loaded with the header's client flags and again with the plain client; reads source and target through Go drivers`,
    } });
    console.log(`${dirs[0]}: verification recorded`);
    return 0;
  }
  if (command === 'check') {
    let failed = 0;
    for (const dir of dirs) {
      const id = (await readJsonFile(join(dir, 'manifest.json'))).id;
      const problems = await checkProvider(dir, config);
      if (problems.length) { failed += 1; console.error(`${id}: ${problems.length} problem(s)\n  ${problems.join('\n  ')}`); } else console.log(`${id}: mysql script matches its manifest, the provider manifest and the pinned inputs`);
    }
    return failed ? 1 : 0;
  }
  if (command === 'regenerate-check') {
    const binary = await ensureDatatug(config, toolsDir);
    let failed = 0;
    for (const dir of dirs) {
      const manifest = await readJsonFile(join(dir, 'manifest.json'));
      const dialectManifest = await readJsonFile(join(dir, MANIFEST_PATH));
      const committed = await readStoredScript(dialectManifest.scripts.mysql, fsReader(dir));
      const { script } = await runExporter({ dir, manifest, config, dialect: 'mysql', attribution: dialectManifest.attribution, binary });
      if (Buffer.compare(committed, script) === 0) console.log(`${manifest.id}: regeneration is byte for byte the committed script (${script.length} bytes, ${sha256(script)})`);
      else { failed += 1; console.error(`${manifest.id}: regeneration with datatug ${config.generator.tag} differs from the committed script (${sha256(script)} != ${sha256(committed)})`); }
    }
    return failed ? 1 : 0;
  }
  throw new Error('usage: dialect-scripts.mjs generate|check|regenerate-check|record-verification --provider <dir> | --providers <dir> [--tools <dir>] [--force]; check-pins [--mode strict|warn-ahead]');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => { console.error(error.message); process.exitCode = 1; });
}
