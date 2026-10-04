const commit = process.env.BUILD_COMMIT;
if (!/^[0-9a-f]{40}$/i.test(commit ?? '')) throw new Error('BUILD_COMMIT must be a full 40-digit Git SHA');

const sites = [
  ['https://demodb.dev', ['/']],
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

for (const [origin, paths] of sites) {
  await checked(`${origin}/build-info.json`, (body) => {
    try { const marker = JSON.parse(body); return marker.format === 'demodb-build/1' && marker.commit === commit.toLowerCase(); }
    catch { return false; }
  });
  for (const path of paths) await checked(`${origin}${path}`, (_body, response) => response.status === 200);
}
console.log(`Live DemoDB catalogue, database pages, exports, and discovery serve ${commit}.`);
