// Unit tests of scripts/deploy-hosts.mjs: Pages capacity preflight, the per-host domain cutover against a fake
// Cloudflare account, re-run safety, the no-new-Workers check and the API client (mocked fetch).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_PAGES_LIMIT, RETIRED_WORKER, cloudflare, deployHosts, orderHosts, pagesPlan, parsePositiveInteger, readHosts } from './deploy-hosts.mjs';

const HOSTS = [
  { host: 'demodb.dev', project: 'demodb-catalogue', dir: 'dist-hosts/demodb.dev' },
  { host: 'chinook.demodb.dev', project: 'demodb-chinook', dir: 'dist-hosts/chinook.demodb.dev' },
  { host: 'pubs.demodb.dev', project: 'demodb-pubs', dir: 'dist-hosts/pubs.demodb.dev' },
];

// A fake account: Workers custom domains on demodb-websites, Pages projects, DNS records and Pages domain status.
function fakeAccount({ workers = 97, pagesProjects = ['rehearse-ink'], activateAfterPolls = 2, subdomain = (name) => `${name}.pages.dev`, extraDns = {} } = {}) {
  const state = {
    workers: [RETIRED_WORKER, ...Array.from({ length: workers - 1 }, (_, i) => `w${i}`)],
    projects: new Map(pagesProjects.map((name) => [name, { name, subdomain: subdomain(name), domains: new Map() }])),
    workerDomains: HOSTS.map((host, i) => ({ id: `wd${i}`, hostname: host.host, service: RETIRED_WORKER })),
    dns: Object.entries(extraDns).map(([name, record]) => ({ name, ...record })),
    calls: [],
  };
  const cf = {
    listWorkers: async () => [...state.workers],
    listPagesProjects: async () => [...state.projects.keys()],
    getPagesProject: async (name) => ({ name, subdomain: state.projects.get(name).subdomain }),
    listPagesDomains: async (name) => [...state.projects.get(name).domains.values()],
    addPagesDomain: async (name, domain) => {
      state.calls.push(`pages-domain-add ${domain}`);
      assert.ok(!state.workerDomains.some((item) => item.hostname === domain), `${domain}: Pages refuses a domain a Worker is still routed on`);
      state.projects.get(name).domains.set(domain, { name: domain, status: 'initializing', polls: 0 });
    },
    getPagesDomain: async (name, domain) => {
      const item = state.projects.get(name).domains.get(domain);
      item.polls += 1;
      if (item.polls > activateAfterPolls && state.dns.some((record) => record.name === domain && record.content === state.projects.get(name).subdomain)) item.status = 'active';
      else if (item.polls > 1) item.status = 'pending';
      return { name: domain, status: item.status, validation_data: { status: item.status === 'active' ? 'active' : 'pending' } };
    },
    listWorkerDomains: async (hostname) => state.workerDomains.filter((item) => item.hostname === hostname),
    listServiceDomains: async (service) => state.workerDomains.filter((item) => item.service === service),
    deleteWorkerDomain: async (id) => { state.calls.push(`worker-domain-delete ${state.workerDomains.find((item) => item.id === id).hostname}`); state.workerDomains = state.workerDomains.filter((item) => item.id !== id); },
    zoneId: async () => 'zone1',
    listDnsRecords: async (_zone, name) => state.dns.filter((record) => record.name === name),
    createCname: async (_zone, name, content) => { state.calls.push(`cname ${name} ${content}`); state.dns.push({ type: 'CNAME', name, content }); },
  };
  const wrangler = (args) => {
    state.calls.push(`wrangler ${args.join(' ')}`);
    if (args[1] === 'project' && args[2] === 'create') state.projects.set(args[3], { name: args[3], subdomain: subdomain(args[3]), domains: new Map() });
  };
  let clock = 0;
  return { state, cf, wrangler, now: () => clock, sleep: async (ms) => { clock += ms; } };
}

test('hosts deploy dataset first and demodb.dev last; the built manifest has one Pages project per host', async () => {
  assert.deepEqual(orderHosts(HOSTS).map((host) => host.host), ['chinook.demodb.dev', 'pubs.demodb.dev', 'demodb.dev']);
  const built = await readHosts();
  assert.equal(built.at(-1).host, 'demodb.dev');
  assert.equal(built.at(-1).project, 'demodb-catalogue');
  assert.equal(new Set(built.map((host) => host.project)).size, built.length);
});

test('a cutover detaches the Worker domain, attaches Pages, creates the CNAME and waits for active, in that order', async () => {
  const account = fakeAccount();
  const log = [];
  const results = await deployHosts({ hosts: HOSTS, cf: account.cf, wrangler: account.wrangler, env: {}, log: (line) => log.push(line), sleep: account.sleep, now: account.now });
  const chinook = account.state.calls.slice(0, 5);
  assert.deepEqual(chinook, [
    'wrangler pages project create demodb-chinook --production-branch main',
    'wrangler pages deploy dist-hosts/chinook.demodb.dev --project-name demodb-chinook --branch main --commit-dirty=true',
    'worker-domain-delete chinook.demodb.dev',
    'pages-domain-add chinook.demodb.dev',
    'cname chinook.demodb.dev demodb-chinook.pages.dev',
  ]);
  assert.equal(account.state.calls.at(-1), 'cname demodb.dev demodb-catalogue.pages.dev', 'demodb.dev moves last');
  assert.deepEqual(results.map((result) => result.host), ['chinook.demodb.dev', 'pubs.demodb.dev', 'demodb.dev']);
  for (const result of results) assert.ok(result.activeAt > result.detachedAt, 'the gap is measured');
  assert.ok(log.some((line) => /chinook\.demodb\.dev: active at .*s after it left the Worker/.test(line)));
  assert.ok(log.some((line) => line.includes(`pnpm exec wrangler delete --name ${RETIRED_WORKER}`)), 'prints the cleanup command');
  assert.ok(account.state.workers.includes(RETIRED_WORKER), 'never deletes the Worker itself');
  assert.ok(log.some((line) => line.startsWith('Workers check: 97 Workers, none created')));
});

test('a re-run after a completed cutover changes nothing but the upload', async () => {
  const account = fakeAccount();
  const quiet = { env: {}, log: () => {}, sleep: account.sleep, now: account.now };
  await deployHosts({ hosts: HOSTS, cf: account.cf, wrangler: account.wrangler, ...quiet });
  account.state.calls.length = 0;
  await deployHosts({ hosts: HOSTS, cf: account.cf, wrangler: account.wrangler, ...quiet });
  assert.ok(account.state.calls.every((call) => call.startsWith('wrangler pages deploy ')), account.state.calls.join('\n'));
});

test('a run that stopped after attaching resumes without detaching again', async () => {
  const account = fakeAccount();
  const failing = { ...account.cf, createCname: async () => { throw new Error('DNS write refused'); } };
  await assert.rejects(deployHosts({ hosts: HOSTS, cf: failing, wrangler: account.wrangler, env: {}, log: () => {}, sleep: account.sleep, now: account.now }), /DNS write refused/);
  account.state.calls.length = 0;
  await deployHosts({ hosts: HOSTS, cf: account.cf, wrangler: account.wrangler, env: {}, log: () => {}, sleep: account.sleep, now: account.now });
  assert.ok(!account.state.calls.includes('pages-domain-add chinook.demodb.dev'));
  assert.ok(account.state.calls.includes('cname chinook.demodb.dev demodb-chinook.pages.dev'));
});

test('the CNAME target is the subdomain Pages assigned, not the project name', async () => {
  const account = fakeAccount({ subdomain: (name) => `${name}-7xq.pages.dev` });
  await deployHosts({ hosts: HOSTS, cf: account.cf, wrangler: account.wrangler, env: {}, log: () => {}, sleep: account.sleep, now: account.now });
  assert.ok(account.state.calls.includes('cname pubs.demodb.dev demodb-pubs-7xq.pages.dev'));
});

test('an unexpected DNS record stops the run instead of being overwritten', async () => {
  const account = fakeAccount({ extraDns: { 'chinook.demodb.dev': { type: 'A', content: '192.0.2.1' } } });
  await assert.rejects(deployHosts({ hosts: HOSTS, cf: account.cf, wrangler: account.wrangler, env: {}, log: () => {}, sleep: account.sleep, now: account.now }), /DNS already has A 192\.0\.2\.1/);
});

test('a domain that never activates fails after the configurable timeout', async () => {
  const account = fakeAccount({ activateAfterPolls: 1e9 });
  await assert.rejects(deployHosts({ hosts: HOSTS, cf: account.cf, wrangler: account.wrangler, env: { DEMODB_DOMAIN_TIMEOUT_SECONDS: '60' }, log: () => {}, sleep: account.sleep, now: account.now }),
    /chinook\.demodb\.dev: Pages domain not active after 60s .*re-run to keep waiting/);
});

test('the Pages preflight fails before any change when the project limit would be exceeded', async () => {
  const account = fakeAccount({ pagesProjects: Array.from({ length: 98 }, (_, i) => `p${i}`) });
  await assert.rejects(deployHosts({ hosts: HOSTS, cf: account.cf, wrangler: account.wrangler, env: {}, log: () => {}, sleep: account.sleep, now: account.now }),
    /account has 98 Pages projects and this run would create 3 more .*101 in total, above the limit of 100\. Nothing was changed/);
  assert.deepEqual(account.state.calls, []);
  await deployHosts({ hosts: HOSTS, cf: account.cf, wrangler: account.wrangler, env: { DEMODB_PAGES_LIMIT: '500' }, log: () => {}, sleep: account.sleep, now: account.now });
  assert.deepEqual(pagesPlan(['a'], ['a', 'b'], 2), { existing: 1, created: ['b'], after: 2, limit: 2, ok: true });
  assert.equal(parsePositiveInteger('X', undefined, DEFAULT_PAGES_LIMIT), 100);
  assert.throws(() => parsePositiveInteger('DEMODB_PAGES_LIMIT', 'lots', 100), /positive integer/);
});

test('the run fails if a new Worker appeared', async () => {
  const account = fakeAccount();
  const wrangler = (args) => { account.wrangler(args); if (args[1] === 'deploy') account.state.workers.push('surprise'); };
  await assert.rejects(deployHosts({ hosts: HOSTS, cf: account.cf, wrangler, env: {}, log: () => {}, sleep: account.sleep, now: account.now }), /Workers check failed: the run created Worker\(s\) surprise/);
});

test('the API client sends the token, follows pages and fails closed', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push([init.method, url, init.headers.Authorization]);
    const page = Number(new URL(url).searchParams.get('page') ?? 1);
    if (url.includes('/pages/projects?')) return new Response(JSON.stringify({ success: true, result: page === 1 ? [{ name: 'a' }] : [{ name: 'b' }], result_info: { total_pages: 2 } }));
    return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }), { status: 403 });
  };
  const cf = cloudflare({ fetch, token: 't0k', accountId: 'acct' });
  assert.deepEqual(await cf.listPagesProjects(), ['a', 'b']);
  assert.deepEqual(calls[0], ['GET', 'https://api.cloudflare.com/client/v4/accounts/acct/pages/projects?page=1', 'Bearer t0k']);
  await assert.rejects(cf.listWorkers(), /GET \/accounts\/acct\/workers\/scripts failed \(10000: Authentication error\)/);
});
