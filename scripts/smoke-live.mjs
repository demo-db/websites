import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const commit = process.env.BUILD_COMMIT;
if (!/^[0-9a-f]{40}$/i.test(commit ?? '')) throw new Error('BUILD_COMMIT must be a full 40-digit Git SHA');

const requiredQueryableDatabaseIds = ['chinook', 'northwind', 'pubs', 'sakila', 'adventureworks', 'employees'];
const sites = [
  ['https://demodb.dev', ['/', '/theme.js', '/ovdb/', '/ovdb/ovdb-server.json', '/.well-known/openvaultdb', '/chinook/', '/chinook/ovdb-database.json', '/ovdb/db/chinook/ovdb-database.json', '/northwind/', '/northwind/ovdb-database.json', '/ovdb/db/northwind/ovdb-database.json', '/pubs/', '/pubs/ovdb-database.json', '/ovdb/db/pubs/ovdb-database.json', '/sakila/', '/sakila/ovdb-database.json', '/ovdb/db/sakila/ovdb-database.json', '/adventureworks/', '/adventureworks/ovdb-database.json', '/ovdb/db/adventureworks/ovdb-database.json', '/employees/', '/employees/ovdb-database.json', '/ovdb/db/employees/ovdb-database.json']],
  ['https://chinook.demodb.dev', ['/', '/theme.js', '/tables/Artist/', '/data/chinook.sqlite', '/.well-known/openvaultdb']],
  ['https://northwind.demodb.dev', ['/', '/theme.js', '/tables/Order%20Details/', '/tables/Invoices/', '/data/northwind.sqlite', '/.well-known/openvaultdb']],
  ['https://pubs.demodb.dev', ['/', '/theme.js', '/tables/', '/tables/titles/', '/data/pubs.sqlite', '/.well-known/openvaultdb']],
  ['https://sakila.demodb.dev', ['/', '/theme.js', '/tables/film_actor/', '/tables/actor_info/', '/data/sakila.sqlite', '/.well-known/openvaultdb']],
  ['https://adventureworks.demodb.dev', ['/', '/theme.js', '/tables/HumanResources.EmployeeDepartmentHistory/', '/tables/Production.Product/', '/schema/', '/schema.json', '/.well-known/openvaultdb']],
  ['https://employees.demodb.dev', ['/', '/theme.js', '/tables/titles/', '/tables/current_dept_emp/', '/data/employees.sqlite', '/.well-known/openvaultdb']],
];
const storageIds = requiredQueryableDatabaseIds.flatMap((id) => [`${id}-sqlite`, `${id}-postgresql`, `${id}-ingitdb`, `${id}-bigquery`]);

async function checked(url, validate) {
  let last = 'request was not attempted';
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const response = await fetch(url, { redirect: 'manual', cache: 'no-store' });
      if (response.ok) {
        const body = await response.text();
        if (validate(body, response)) return;
        last = `response from ${url} did not match the expected build`;
      } else last = `HTTP ${response.status} from ${url}`;
    } catch (error) { last = error instanceof Error ? error.message : String(error); }
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** attempt, 15000)));
  }
  throw new Error(`${url}: ${last}`);
}

async function checkedNotFound(url) {
  let last = 'request was not attempted';
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const response = await fetch(url, { redirect: 'manual', cache: 'no-store' });
      if (response.status === 404) return;
      last = `HTTP ${response.status} from ${url}`;
    } catch (error) { last = error instanceof Error ? error.message : String(error); }
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** attempt, 15000)));
  }
  throw new Error(`${url}: expected HTTP 404 after retries; ${last}`);
}

async function checkedReadOnlyQuery(localId, query, pageSize, nativeRecordset) {
  const url = `https://demodb.dev/ovdb/v1/databases/${localId}/dtql`;
  let last = 'request was not attempted';
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (pageSize !== undefined) headers['OVDB-Page-Size'] = String(pageSize);
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query }),
        cache: 'no-store',
      });
      const body = await response.text();
      if (response.ok) {
        const result = JSON.parse(body);
        const expectedRecords = pageSize ?? 1;
        if (Array.isArray(result.records) && result.records.length === expectedRecords) {
          const records = result.records;
          if (records.every((record) => typeof record.key === 'string'
            && record.key.startsWith(`${nativeRecordset}/`)
            && typeof record.data?.id === 'string'
            && record.data.id.length > 0
            && record.data.id !== '<nil>'
            && record.key.slice(nativeRecordset.length + 1) === record.data.id)) {
            const first = records[0];
            const keyUrl = url.replace(/\/dtql$/, `/records/${encodeURIComponent(nativeRecordset)}/${encodeURIComponent(first.data.id)}`);
            const keyResponse = await fetch(keyUrl, { cache: 'no-store' });
            if (keyResponse.ok) {
              const keyResult = await keyResponse.json();
              if (keyResult.key === first.key && keyResult.data?.id === first.data.id) {
                assert.deepStrictEqual(keyResult.data, first.data, `${localId} keyed record payload matches the query row`);
                return;
              }
              last = `${localId} record lookup did not preserve its queried identity and data`;
            } else last = `${localId} record lookup returned HTTP ${keyResponse.status}`;
          } else last = `${localId} query did not preserve its native record identity`;
        } else last = `query returned an unexpected record payload: ${body}`;
      } else last = `HTTP ${response.status} from ${url}: ${body}`;
    } catch (error) { last = error instanceof Error ? error.message : String(error); }
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** attempt, 15000)));
  }
  throw new Error(`${url}: ${last}`);
}

async function checkedConfiguredDatabaseQueries() {
  const response = await fetch('https://demodb.dev/corpus.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Cannot read the public corpus manifest for API smoke: HTTP ${response.status}`);
  const corpus = await response.json();
  const databases = corpus.databases;
  if (!Array.isArray(databases)) throw new Error('The public corpus manifest has no database list');
  const ids = databases.map((database) => database.localId).sort();
  if (JSON.stringify(ids) !== JSON.stringify([...requiredQueryableDatabaseIds].sort())) {
    throw new Error(`Configured database IDs differ from the six-provider smoke contract: ${ids.join(', ')}`);
  }

  const targetedQueries = new Map([
    ['chinook', { query: 'from: {name: Artist}\nlimit: 1\n', recordset: 'Artist' }],
    ['northwind', { query: "from: {name: 'Order Details'}\norderBy: [{field: OrderID}, {field: ProductID}]\n", pageSize: 2, recordset: 'Order Details' }],
    ['pubs', { query: 'from: {name: authors}\nlimit: 1\n', recordset: 'authors' }],
  ]);
  for (const database of databases) {
    const capabilities = database.capabilities;
    if (capabilities?.read !== true || capabilities?.query !== true || capabilities?.write !== false) {
      throw new Error(`${database.localId}: query smoke requires the verified read-only API capability`);
    }
    const targeted = targetedQueries.get(database.localId);
    const recordset = targeted ? undefined : database.recordsets?.find((item) => item.kind === 'table' && item.rowCount > 0 && item.columns?.some((column) => column.primaryKey));
    if (!targeted && !recordset) throw new Error(`${database.localId}: no populated keyed physical table is available for the query smoke`);
    const query = targeted?.query ?? `from: {name: ${JSON.stringify(recordset.name)}}\nlimit: 1\n`;
    await checkedReadOnlyQuery(database.localId, query, targeted?.pageSize, targeted?.recordset ?? recordset.name);
  }
}

for (const [origin, paths] of sites) {
  await checked(`${origin}/build-info.json`, (body) => {
    try { const marker = JSON.parse(body); return marker.format === 'demodb-build/1' && marker.commit === commit.toLowerCase(); }
    catch { return false; }
  });
  for (const path of paths) await checked(`${origin}${path}`, (_body, response) => response.status === 200);
}
await checked('https://demodb.dev/', (body) => body.includes('Explore OpenVaultDB server') && body.includes('Browse server and storage catalogue'));
await checked('https://demodb.dev/ovdb/', (body) => storageIds.every((id) => body.includes(`/ovdb/db/${id}/`)) &&
  body.includes('6 datasets. 4 storage editions each') && body.includes('demodb-dev') && body.includes('your own execution project'));
for (const id of storageIds) {
  const url = `https://demodb.dev/ovdb/db/${id}/`;
  await checked(url, (body) => body.includes(`https://demodb.dev/ovdb/db/${id}/`) && (id.endsWith('-postgresql')
    ? body.includes('Public OpenVaultDB API access is being prepared') && !body.includes('Open read-only API')
    : id.endsWith('-ingitdb')
      ? body.includes('Browse inGitDB files') && body.includes('ingitdb validate --path ingitdb') && !body.includes('Open read-only API')
      : id.endsWith('-bigquery')
        ? body.includes('demodb-dev') && body.includes('your own Google Cloud execution project') &&
          body.includes('does not execute or proxy SQL') && body.includes('DataTug browser query execution is not enabled yet') &&
          !body.includes('Open read-only API') && !body.includes('Database descriptor')
        : body.includes('Open read-only API')));
  if (id.endsWith('-bigquery')) await checkedNotFound(`https://demodb.dev/ovdb/v1/databases/${id}`);
}
await checkedConfiguredDatabaseQueries();
await checkedAdventureWorksSchema();
await checkedDecodedSqlite('adventureworks');

async function checkedAdventureWorksSchema() {
  const response = await fetch('https://adventureworks.demodb.dev/schema.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`AdventureWorks source schema returned HTTP ${response.status}`);
  const schema = await response.json();
  const tables = schema.tables?.filter((table) => table.kind === 'table') ?? [];
  const executableViews = schema.tables?.filter((table) => table.kind === 'view') ?? [];
  const sourceViews = schema.sourceViews ?? [];
  if (tables.length !== 71 || executableViews.length !== 11 || sourceViews.length !== 20) {
    throw new Error(`AdventureWorks schema counts differ from the pinned source (tables=${tables.length}, sqliteViews=${executableViews.length}, sourceViews=${sourceViews.length})`);
  }
  const available = sourceViews.filter((view) => view.availableAsSqliteView).length;
  const sourceOnly = sourceViews.filter((view) => !view.availableAsSqliteView).length;
  if (available !== 11 || sourceOnly !== 9) throw new Error(`AdventureWorks view availability is incorrect (SQLite=${available}, source-only=${sourceOnly})`);
  if (sourceViews.some((view) => !view.availableAsSqliteView && schema.tables.some((table) => table.name === view.recordset))) {
    throw new Error('A source-only SQL Server view is incorrectly published as an executable SQLite recordset');
  }
}

async function checkedDecodedSqlite(localId) {
  const corpusResponse = await fetch('https://demodb.dev/corpus.json', { cache: 'no-store' });
  if (!corpusResponse.ok) throw new Error(`Cannot read the public corpus manifest: HTTP ${corpusResponse.status}`);
  const corpus = await corpusResponse.json();
  const database = corpus.databases?.find((item) => item.localId === localId);
  const expected = database?.exports?.find((item) => item.format === 'sqlite');
  if (!expected || expected.decodedBytes !== 126820352 || !/^[a-f0-9]{64}$/.test(expected.decodedSha256 ?? '')) {
    throw new Error(`${localId}: corpus metadata does not describe the complete decoded SQLite export`);
  }
  const response = await fetch(`https://${localId}.demodb.dev/data/${localId}.sqlite`, { redirect: 'manual', cache: 'no-store' });
  if (response.status !== 200) throw new Error(`${localId}: SQLite download returned HTTP ${response.status}`);
  if (response.headers.get('Content-Encoding') !== 'gzip') throw new Error(`${localId}: chunked SQLite route did not retain its gzip transfer encoding`);
  if (response.headers.get('Content-Type') !== 'application/vnd.sqlite3') throw new Error(`${localId}: SQLite download has the wrong content type`);
  if (!/accept-encoding/i.test(response.headers.get('Vary') ?? '')) throw new Error(`${localId}: gzip transfer does not vary on Accept-Encoding`);
  if (!response.body) throw new Error(`${localId}: SQLite download has no response body`);
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of response.body) {
    const part = Buffer.from(chunk);
    bytes += part.length;
    hash.update(part);
  }
  const actualSha256 = hash.digest('hex');
  if (bytes !== expected.decodedBytes || actualSha256 !== expected.decodedSha256) {
    throw new Error(`${localId}: full decoded SQLite download failed verification (bytes=${bytes}, sha256=${actualSha256})`);
  }
}

async function checkedLegacyRedirect(url, init, expectedLocation) {
  let last = 'request was not attempted';
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const response = await fetch(url, { ...init, redirect: 'manual', cache: 'no-store' });
      if (response.status === 308 && response.headers.get('Location') === expectedLocation) return;
      last = `HTTP ${response.status} to ${response.headers.get('Location') ?? 'no location'}`;
    } catch (error) { last = error instanceof Error ? error.message : String(error); }
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** attempt, 15000)));
  }
  throw new Error(`legacy redirect from ${url} did not match after retries: ${last}`);
}

await checkedLegacyRedirect('https://chinookdb.com/tables/Artist/?smoke=legacy', { method: 'GET' }, 'https://chinook.demodb.dev/tables/Artist/?smoke=legacy');
await checkedLegacyRedirect('https://chinookdb.com/data/chinook.sqlite?download=1', { method: 'HEAD' }, 'https://chinook.demodb.dev/data/chinook.sqlite?download=1');
await checkedLegacyRedirect('https://chinookdb.com/ovdb/dbs/chinook?smoke=profile', { method: 'GET' }, 'https://demodb.dev/chinook/?smoke=profile');
await checkedLegacyRedirect('https://chinookdb.com/ovdb/v1/databases/chinook/dtql?smoke=query', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: 'from: {name: Artist}\nlimit: 1\n' }),
}, 'https://demodb.dev/ovdb/v1/databases/chinook/dtql?smoke=query');
console.log(`Live DemoDB pages, typed manifests, discovery, full AdventureWorks SQLite download, read-only OVDB queries, and Chinook legacy redirects serve ${commit}.`);
