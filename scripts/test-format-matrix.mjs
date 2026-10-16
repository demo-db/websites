// The format matrix, its metadata and the files actually served must agree (drift fails CI), and the
// generated complete-database JSON and YAML must carry exactly the pinned SQLite fixture's data.
//
// Needs the built site (`pnpm build`, or at least `pnpm prepare:databases` plus the astro build for the page
// checks). The PostgreSQL scripts and inGitDB archives are validated against a real PostgreSQL 17 and the
// independent parity checker by scripts/hosting-tools/validate_served_formats.py (served-formats workflow).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { parse as parseYaml } from 'yaml';
import { chunkEncoded, deterministicGzip, jsonDocument, parseRows, pinOrVerify, placeDerivedExport, yamlDocument } from './derived-exports.mjs';
import { formatAvailability, validateMatrix } from './format-matrix.mjs';
import { renderMatrixDoc } from './format-matrix-doc.mjs';

const root = new URL('..', import.meta.url).pathname;
const readJson = async (path) => JSON.parse(await readFile(join(root, path), 'utf8'));
const config = await readJson('config/databases.json');
const matrix = await readJson('config/format-matrix.json');
const lock = await readJson('config/derived-exports.lock.json');
const generated = (await readJson('src/data/generated/index.json')).databases;
const corpus = await readJson('public/corpus.json');
const ids = config.databases.map((entry) => entry.id);
const LIMIT = 25 * 1024 * 1024;
const scratch = [];
after(() => Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true }))));

const dataDir = (id) => join(root, 'public/_db', id, 'data');
const completeOf = (database, format) => database.exports.filter((file) => file.format === format && !file.table);
const decodeHtml = (text) => text.replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16))).replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&amp;', '&');

async function encodedBytes(database, file) {
  const parts = file.chunks?.length ? file.chunks.map((chunk) => chunk.assetPath) : [file.assetPath];
  return Buffer.concat(await Promise.all(parts.map((part) => readFile(join(dataDir(database.id), part)))));
}
async function decodedBytesOf(database, file) {
  const encoded = await encodedBytes(database, file);
  return file.compression === 'gzip' ? gunzipSync(encoded) : encoded;
}

// --- the declaration and its checks ------------------------------------------------------------------------

test('the committed matrix is valid for every registered dataset', () => {
  validateMatrix(matrix, ids);
});

test('validateMatrix rejects a missing cell, an unexplained gap and an unknown dataset', () => {
  const clone = () => structuredClone(matrix);
  const missing = clone(); delete missing.datasets.pubs.yaml;
  assert.throws(() => validateMatrix(missing, ids), /pubs\/yaml: missing/);
  const unexplained = clone(); unexplained.datasets.pubs.mysql = { state: 'unavailable', reason: 'no' };
  assert.throws(() => validateMatrix(unexplained, ids), /pubs\/mysql: an unavailable format needs a specific reason/);
  const extra = clone(); extra.datasets.nowhere = extra.datasets.pubs;
  assert.throws(() => validateMatrix(extra, ids), /nowhere is declared but not registered/);
  assert.throws(() => validateMatrix(matrix, [...ids, 'newdb']), /newdb is registered but not declared/);
});

test('formatAvailability fails when the declaration and the produced exports differ', () => {
  const small = { datasets: { x: { json: { state: 'download', origin: 'derived' }, yaml: { state: 'unavailable', reason: 'a specific and sufficiently long reason text' } } }, formats: ['json', 'yaml'], labels: { json: 'JSON', yaml: 'YAML' } };
  const json = { format: 'json', table: null, publicPath: 'x.json', derived: true };
  assert.deepEqual(formatAvailability(small, 'x', [json]).map((item) => [item.format, item.state]), [['json', 'download'], ['yaml', 'unavailable']]);
  assert.throws(() => formatAvailability(small, 'x', []), /json: declared as a download but not produced/);
  assert.throws(() => formatAvailability(small, 'x', [json, { format: 'yaml', table: null, publicPath: 'x.yaml', derived: true }]), /yaml: declared unavailable but x\.yaml is served/);
  assert.throws(() => formatAvailability(small, 'x', [json, { format: 'mysql', table: null, publicPath: 'x.mysql.sql' }]), /mysql download that the matrix does not know/);
  assert.throws(() => formatAvailability(small, 'x', [{ ...json, derived: false }]), /declared origin derived but the export is a provider contract export/);
  assert.doesNotThrow(() => formatAvailability(small, 'x', [json, { format: 'sql', table: null, publicPath: 'x.sql' }, { format: 'json', table: 'a', publicPath: 'json/x.a.json' }]));
});

// --- matrix == metadata == pages == files ------------------------------------------------------------------

for (const id of ids) {
  const database = generated.find((item) => item.id === id);
  const published = corpus.databases.find((item) => item.localId === id);

  test(`${id}: the matrix, the registry metadata, corpus.json, the pages and the served files agree`, async () => {
    const recomputed = formatAvailability(matrix, id, database.exports);
    assert.deepEqual(database.formatAvailability, recomputed, 'registry metadata equals matrix + reality');
    assert.deepEqual(published.formatAvailability, recomputed, 'corpus.json carries the same metadata');

    const listed = published.exports.map((file) => file.format).filter((format) => matrix.formats.includes(format)).sort();
    const declared = matrix.formats.filter((format) => matrix.datasets[id][format].state === 'download').sort();
    assert.deepEqual(listed, declared, 'corpus.json lists exactly the declared downloads');

    const downloadsPage = decodeHtml(await readFile(join(root, 'dist/_db', id, 'downloads/index.html'), 'utf8'));
    const datasetPage = decodeHtml(await readFile(join(root, 'dist/_db', id, 'index.html'), 'utf8'));
    for (const format of matrix.formats) {
      const cell = matrix.datasets[id][format];
      const entry = recomputed.find((item) => item.format === format);
      if (cell.state === 'download') {
        const [file] = completeOf(database, format);
        assert.ok(downloadsPage.includes(`<a href="/data/${file.publicPath}" download>`), `${format}: the downloads page links ${file.publicPath}`);
        assert.ok(datasetPage.includes(`<a href="/data/${file.publicPath}">`), `${format}: the dataset page links ${file.publicPath}`);
        assert.ok(!downloadsPage.includes(`${entry.label}</strong><span>Not available`), `${format}: not also described as unavailable`);
      } else {
        const sentence = `Not available: ${cell.reason}`;
        assert.ok(downloadsPage.includes(sentence), `${format}: the downloads page says "${sentence.slice(0, 60)}…"`);
        assert.ok(datasetPage.includes(sentence), `${format}: the dataset page says it too`);
        assert.ok(!database.exports.some((file) => file.format === format && !file.table), `${format}: no file behind an unavailable format`);
      }
    }

    for (const format of matrix.formats.filter((item) => matrix.datasets[id][item].state === 'download')) {
      const [file] = completeOf(database, format);
      const parts = file.chunks?.length ? file.chunks : [{ assetPath: file.assetPath, bytes: file.bytes, sha256: file.sha256 }];
      let total = 0;
      for (const part of parts) {
        const bytes = await readFile(join(dataDir(id), part.assetPath));
        assert.ok(bytes.length <= LIMIT, `${part.assetPath} is within the ${LIMIT}-byte asset limit`);
        assert.equal(bytes.length, part.bytes, `${part.assetPath} size`);
        assert.equal(createHash('sha256').update(bytes).digest('hex'), part.sha256, `${part.assetPath} sha256`);
        total += bytes.length;
      }
      if (file.chunks?.length) assert.equal(total, file.bytes, `${format}: chunks add up`);
      const decoded = await decodedBytesOf(database, file);
      assert.equal(decoded.length, file.decodedBytes ?? file.bytes, `${format}: decoded size`);
      assert.equal(createHash('sha256').update(decoded).digest('hex'), file.decodedSha256 ?? file.sha256, `${format}: decoded sha256`);
    }
  });

  test(`${id}: every generated file is pinned by the lock, and nothing else is`, () => {
    const pinned = Object.keys(lock.datasets[id] ?? {}).sort();
    const generatedFormats = matrix.formats.filter((format) => ['derived', 'provider-artifact', 'archive'].includes(matrix.datasets[id][format].origin)).sort();
    assert.deepEqual(pinned, generatedFormats);
    for (const format of generatedFormats.filter((item) => item !== 'ingitdb')) {
      const [file] = completeOf(database, format);
      assert.equal(lock.datasets[id][format].bytes, file.decodedBytes ?? file.bytes);
      assert.equal(lock.datasets[id][format].sha256, file.decodedSha256 ?? file.sha256);
    }
  });
}

test('docs/format-matrix.md is the current rendering of the declaration and the build', async () => {
  const expected = renderMatrixDoc({ matrix, databases: generated, lock });
  const actual = await readFile(join(root, 'docs/format-matrix.md'), 'utf8');
  assert.equal(actual, expected, 'regenerate it with: node scripts/format-matrix-doc.mjs --write');
});

// --- the generators ----------------------------------------------------------------------------------------

test('jsonDocument keeps the provider bytes of every value, including numbers JSON.parse would round', () => {
  const big = '[\n  {"id": 12345678901234567890, "price": 1.50, "blob": "AAE="}\n]\n';
  const text = jsonDocument([{ name: 'A b', json: Buffer.from(big) }, { name: 't2', json: Buffer.from('[]\n') }]).toString();
  assert.ok(text.includes('12345678901234567890') && text.includes('1.50'));
  assert.deepEqual(Object.keys(JSON.parse(text)), ['A b', 't2']);
  assert.throws(() => jsonDocument([{ name: 'x', json: Buffer.from('{}') }]), /not an array/);
});

test('yamlDocument writes block YAML that a YAML 1.2 parser reads back as the same rows', () => {
  const rows = '[{"a":1,"b":"x: y\\n\\"z\\"","c":null,"d":true,"e":1.50,"f":"\\u2028 \\u0000 é","g":12345678901234567890},{"a":2,"b":"","c":"null","d":false,"e":0,"f":"- dash","g":-0.0}]';
  const text = yamlDocument([{ name: 'Order Details', json: Buffer.from(rows) }, { name: 'empty', json: Buffer.from('[]') }, { name: 'a.b', json: Buffer.from('[{}]') }]).toString();
  const back = parseYaml(text);
  assert.deepEqual(Object.keys(back), ['Order Details', 'empty', 'a.b']);
  assert.equal(back['Order Details'][0].b, 'x: y\n"z"');
  assert.equal(back['Order Details'][1].c, 'null');
  assert.equal(back['Order Details'][0].f, '  \u0000 é');
  assert.deepEqual(back.empty, []);
  assert.deepEqual(back['a.b'], [{}]);
  assert.ok(text.includes('12345678901234567890') && text.includes('1.50'), 'numbers are written verbatim');
});

test('parseRows keeps number source text', () => {
  assert.equal(parseRows('[1.50]')[0].source, '1.50');
});

test('deterministicGzip is repeatable and carries a zero timestamp', () => {
  const input = Buffer.from('demo'.repeat(1000));
  const first = deterministicGzip(input);
  assert.deepEqual(first, deterministicGzip(input));
  assert.deepEqual([...first.subarray(4, 8)], [0, 0, 0, 0]);
  assert.deepEqual(gunzipSync(first), input);
});

test('placeDerivedExport stores small files plain, gzips large ones and chunks a stream above the limit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'demodb-place-'));
  scratch.push(dir);
  const small = await placeDerivedExport({ id: 't', format: 'json', bytes: Buffer.from('{}'), destination: dir });
  assert.deepEqual([small.assetPath, small.compression, small.derived], ['t.json', null, true]);
  const big = Buffer.alloc(LIMIT + 1, 'a');
  const gz = await placeDerivedExport({ id: 't', format: 'yaml', bytes: big, destination: dir });
  assert.deepEqual([gz.assetPath, gz.compression, gz.decodedBytes, gz.chunks.length], ['t.yaml.gz', 'gzip', big.length, 0]);
  assert.deepEqual(chunkEncoded(Buffer.alloc(10), 4).map((part) => part.length), [4, 4, 2]);
  const pg = await placeDerivedExport({ id: 't', format: 'postgresql', bytes: Buffer.from('x'), destination: dir });
  assert.equal(pg.publicPath, 't.postgresql.sql');
  assert.equal((await placeDerivedExport({ id: 't', format: 'ingitdb', bytes: Buffer.from('x'), destination: dir })).publicPath, 't.ingitdb.zip');
});

test('the lock detects a changed generated file and an unpinned one', () => {
  const collector = { lock: { datasets: { t: { json: { bytes: 2, sha256: createHash('sha256').update('{}').digest('hex') } } } } };
  assert.doesNotThrow(() => pinOrVerify(collector, 't', 'json', { bytes: 2, sha256: createHash('sha256').update('{}').digest('hex') }));
  assert.throws(() => pinOrVerify(collector, 't', 'json', { bytes: 3, sha256: 'a'.repeat(64) }), /differs from config\/derived-exports\.lock\.json/);
  assert.throws(() => pinOrVerify(collector, 't', 'yaml', { bytes: 1, sha256: 'b'.repeat(64) }), /no yaml entry/);
  const update = { update: true, collected: {} };
  pinOrVerify(update, 't', 'yaml', { bytes: 1, sha256: 'c' });
  assert.deepEqual(update.collected, { t: { yaml: { bytes: 1, sha256: 'c' } } });
});

// --- complete JSON and YAML equal the pinned SQLite fixture -----------------------------------------------------

async function openFixture(database) {
  const file = completeOf(database, 'sqlite')[0];
  const dir = await mkdtemp(join(tmpdir(), 'demodb-fixture-'));
  scratch.push(dir);
  const path = join(dir, `${database.id}.sqlite`);
  await writeFile(path, await decodedBytesOf(database, file));
  return new DatabaseSync(path, { readOnly: true });
}

const quote = (name) => `"${name.replaceAll('"', '""')}"`;

// The provider JSON convention: BLOBs are base64 text; every other value is the SQLite value. A row is compared
// as a canonical string, so the order of rows (the provider orders by primary key) does not matter but every value does.
function canonical(value) {
  if (value === null) return 'null';
  if (value instanceof Uint8Array) return `s:${Buffer.from(value).toString('base64')}`;
  if (typeof value === 'bigint' || typeof value === 'number') return `n:${Number(value)}`;
  return `s:${value}`;
}
const rowKey = (columns, row) => columns.map((column) => canonical(row[column])).join('\u0001');

// A tiny reader for exactly the YAML subset yamlDocument writes (every scalar is a JSON scalar), independent of
// the writer, so every row of even the largest file is compared with the JSON.
function readGeneratedYaml(text) {
  const tables = {};
  let rows = null;
  let row = null;
  const key = /^( {2}- | {4})("(?:[^"\\]|\\.)*"): (.*)$/;
  for (const line of text.split('\n')) {
    if (line === '') continue;
    let match;
    if ((match = /^("(?:[^"\\]|\\.)*"):( \[\])?$/.exec(line))) {
      rows = match[2] ? [] : [];
      tables[JSON.parse(match[1])] = rows;
    } else if (line === '  - {}') { row = {}; rows.push(row); }
    else if ((match = key.exec(line))) {
      if (match[1] === '  - ') { row = {}; rows.push(row); }
      row[JSON.parse(match[2])] = JSON.parse(match[3]);
    } else throw new Error(`unexpected YAML line: ${line.slice(0, 80)}`);
  }
  return tables;
}

for (const id of ids) {
  const database = generated.find((item) => item.id === id);
  const formats = ['json', 'yaml'].filter((format) => matrix.datasets[id][format].state === 'download');
  if (!formats.length) continue;

  test(`${id}: the complete JSON${formats.includes('yaml') ? ' and YAML' : ''} equal the pinned SQLite fixture (counts, every value, keys, foreign keys)`, async () => {
    const fixture = await openFixture(database);
    try {
      const tables = database.tables.filter((table) => table.kind === 'table');
      const json = JSON.parse((await decodedBytesOf(database, completeOf(database, 'json')[0])).toString('utf8'));
      assert.deepEqual(Object.keys(json).sort(), tables.map((table) => table.name).sort(), 'table set');
      const keySets = new Map();
      const valuesOf = (tableName, column) => {
        const cacheKey = `${tableName}\u0000${column}`;
        if (!keySets.has(cacheKey)) keySets.set(cacheKey, new Set(json[tableName].map((row) => String(row[column]))));
        return keySets.get(cacheKey);
      };
      for (const table of tables) {
        const rows = json[table.name];
        const columns = table.columns.map((column) => column.name);
        const [{ n }] = fixture.prepare(`SELECT count(*) AS n FROM ${quote(table.name)}`).all();
        assert.equal(rows.length, n, `${table.name}: row count equals SELECT count(*) on the fixture`);
        assert.equal(rows.length, table.rowCount, `${table.name}: row count equals the schema`);
        const remaining = new Map();
        for (const row of rows) {
          assert.deepEqual(Object.keys(row), columns, `${table.name}: columns of a row`);
          const key = rowKey(columns, row);
          remaining.set(key, (remaining.get(key) ?? 0) + 1);
        }
        for (const source of fixture.prepare(`SELECT * FROM ${quote(table.name)}`).iterate()) {
          const key = rowKey(columns, source);
          const left = remaining.get(key);
          if (!left) assert.fail(`${table.name}: fixture row ${key.slice(0, 200)} is not in the JSON`);
          remaining.set(key, left - 1);
        }
        assert.ok([...remaining.values()].every((count) => count === 0), `${table.name}: the JSON has no row that the fixture lacks`);
        const pk = table.columns.filter((column) => column.primaryKey).sort((a, b) => (a.primaryKeyPosition ?? 0) - (b.primaryKeyPosition ?? 0)).map((column) => column.name);
        if (pk.length) {
          const seen = new Set(rows.map((row) => JSON.stringify(pk.map((column) => row[column]))));
          assert.equal(seen.size, rows.length, `${table.name}: primary key ${pk.join(', ')} is unique`);
        }
        for (const foreignKey of table.foreignKeys) {
          const parents = valuesOf(foreignKey.table, foreignKey.referencedColumn);
          const orphan = rows.find((row) => row[foreignKey.column] !== null && !parents.has(String(row[foreignKey.column])));
          assert.equal(orphan, undefined, `${table.name}.${foreignKey.column} -> ${foreignKey.table}.${foreignKey.referencedColumn}: every value has a parent`);
        }
      }

      if (formats.includes('yaml')) {
        const text = (await decodedBytesOf(database, completeOf(database, 'yaml')[0])).toString('utf8');
        if (matrix.datasets[id].yaml.origin === 'derived') {
          const read = readGeneratedYaml(text);
          assert.deepEqual(Object.keys(read), Object.keys(json), 'YAML table set and order equal the JSON');
          for (const name of Object.keys(json)) {
            assert.equal(read[name].length, json[name].length, `${name}: YAML row count`);
            assert.ok(read[name].every((row, i) => JSON.stringify(row) === JSON.stringify(json[name][i])), `${name}: YAML rows equal JSON rows`);
          }
        }
        // A real YAML 1.2 parser must read the file: the whole document up to 12 MB, otherwise a sample of tables.
        if (text.length <= 12 * 1024 * 1024) assert.deepEqual(parseYaml(text), json, 'the whole YAML document parses to the JSON');
        else {
          const names = Object.keys(json);
          const sections = text.split(/^(?=")/m);
          const sample = new Set([names[0], names.find((name) => json[name].length > 0 && JSON.stringify(json[name]).length < 8 * 1024 * 1024 && /[^\x00-\x7f]/.test(JSON.stringify(json[name]))) ?? names[1], names.at(-1)]);
          for (const section of sections) {
            const name = JSON.parse(/^("(?:[^"\\]|\\.)*"):/.exec(section)[1]);
            if (sample.has(name)) assert.deepEqual(parseYaml(section)[name], json[name], `${name}: a YAML 1.2 parser reads the table`);
          }
        }
      }
    } finally {
      fixture.close();
    }
  });
}
