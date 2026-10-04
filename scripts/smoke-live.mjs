const commit = process.env.BUILD_COMMIT;
if (!/^[0-9a-f]{40}$/i.test(commit ?? '')) throw new Error('BUILD_COMMIT must be a full 40-digit Git SHA');

const sites = [
  ['https://demodb.dev', ['/', '/theme.js', '/ovdb/', '/ovdb/ovdb-server.json', '/.well-known/openvaultdb', '/chinook/', '/chinook/ovdb-database.json', '/ovdb/db/chinook/ovdb-database.json', '/northwind/', '/northwind/ovdb-database.json', '/ovdb/db/northwind/ovdb-database.json', '/pubs/', '/pubs/ovdb-database.json', '/ovdb/db/pubs/ovdb-database.json', '/sakila/', '/sakila/ovdb-database.json', '/ovdb/db/sakila/ovdb-database.json']],
  ['https://chinook.demodb.dev', ['/', '/theme.js', '/tables/Artist/', '/data/chinook.sqlite', '/.well-known/openvaultdb']],
  ['https://northwind.demodb.dev', ['/', '/theme.js', '/tables/Order%20Details/', '/tables/Invoices/', '/data/northwind.sqlite', '/.well-known/openvaultdb']],
  ['https://pubs.demodb.dev', ['/', '/theme.js', '/tables/', '/tables/titles/', '/data/pubs.sqlite', '/.well-known/openvaultdb']],
  ['https://sakila.demodb.dev', ['/', '/theme.js', '/tables/film_actor/', '/tables/actor_info/', '/data/sakila.sqlite', '/.well-known/openvaultdb']],
];

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

async function checkedReadOnlyQuery(localId, query, pageSize) {
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
          const nativeKeyPrefix = 'Order Details/';
          if (localId !== 'northwind' || records.every((record) => typeof record.key === 'string'
            && record.key.startsWith(nativeKeyPrefix)
            && typeof record.data?.id === 'string'
            && record.data.id !== '<nil>'
            && record.key.slice(nativeKeyPrefix.length) === record.data.id)) return;
          last = 'Northwind query did not preserve the native record identity';
        } else last = `query returned an unexpected record payload: ${body}`;
      } else last = `HTTP ${response.status} from ${url}: ${body}`;
    } catch (error) { last = error instanceof Error ? error.message : String(error); }
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** attempt, 15000)));
  }
  throw new Error(`${url}: ${last}`);
}

for (const [origin, paths] of sites) {
  await checked(`${origin}/build-info.json`, (body) => {
    try { const marker = JSON.parse(body); return marker.format === 'demodb-build/1' && marker.commit === commit.toLowerCase(); }
    catch { return false; }
  });
  for (const path of paths) await checked(`${origin}${path}`, (_body, response) => response.status === 200);
}
await checkedReadOnlyQuery('chinook', 'from: {name: Artist}\nlimit: 1\n');
await checkedReadOnlyQuery('northwind', "from: {name: 'Order Details'}\norderBy: [{field: OrderID}, {field: ProductID}]\n", 2);
await checkedReadOnlyQuery('pubs', 'from: {name: authors}\nlimit: 1\n');

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
console.log(`Live DemoDB pages, typed manifests, discovery, read-only OVDB queries, and Chinook legacy redirects serve ${commit}.`);
