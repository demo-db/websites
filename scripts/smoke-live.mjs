const commit = process.env.BUILD_COMMIT;
if (!/^[0-9a-f]{40}$/i.test(commit ?? '')) throw new Error('BUILD_COMMIT must be a full 40-digit Git SHA');

const sites = [
  ['https://demodb.dev', ['/', '/ovdb/', '/ovdb/ovdb-server.json', '/.well-known/openvaultdb', '/chinook/', '/chinook/ovdb-database.json', '/ovdb/db/chinook/ovdb-database.json', '/northwind/', '/northwind/ovdb-database.json', '/ovdb/db/northwind/ovdb-database.json']],
  ['https://chinook.demodb.dev', ['/', '/tables/Artist/', '/data/chinook.sqlite', '/.well-known/openvaultdb']],
  ['https://northwind.demodb.dev', ['/', '/tables/Order%20Details/', '/tables/Invoices/', '/data/northwind.sqlite', '/.well-known/openvaultdb']],
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

async function checkedReadOnlyQuery(localId, query) {
  const url = `https://demodb.dev/ovdb/v1/databases/${localId}/dtql`;
  let last = 'request was not attempted';
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'OVDB-Page-Size': '1' },
        body: JSON.stringify({ query }),
        cache: 'no-store',
      });
      const body = await response.text();
      if (response.ok) {
        const result = JSON.parse(body);
        if (Array.isArray(result.records) && result.records.length === 1) {
          const record = result.records[0];
          const nativeKeyPrefix = 'Order Details/';
          if (localId !== 'northwind' || (typeof record.key === 'string'
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
await checkedReadOnlyQuery('northwind', "from: {name: 'Order Details'}\norderBy: [{field: OrderID}, {field: ProductID}]\nlimit: 1\n");
console.log(`Live DemoDB pages, typed manifests, discovery, and read-only OVDB queries serve ${commit}.`);
