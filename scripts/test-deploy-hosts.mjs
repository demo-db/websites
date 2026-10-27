// Unit tests of scripts/deploy-hosts.mjs: deploy order, the Workers capacity preflight and the API client, all
// against a fake fetch and a fake Wrangler (no network, no account).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CATALOGUE_SCRIPT, DEFAULT_WORKERS_LIMIT, capacityPlan, cloudflare, deployHosts, hostConfigs, parseLimit, preflight, validateConfigs } from './deploy-hosts.mjs';

const env = { CLOUDFLARE_API_TOKEN: 'test-token', CLOUDFLARE_ACCOUNT_ID: 'acct123' };
// Every dataset Worker is already deployed; Countries has no host (it is read from GitHub, not demodb.dev).
const ESTABLISHED_DATASET_WORKERS = ['demodb-adventureworks', 'demodb-chinook', 'demodb-employees', 'demodb-northwind', 'demodb-pubs', 'demodb-sakila', 'demodb-shipping-logs', 'demodb-shipping'];
const NEW_DATASET_WORKERS = [];
const DATASET_WORKERS = [...ESTABLISHED_DATASET_WORKERS];
const scripts = (count, extra = []) => [...Array.from({ length: count - extra.length }, (_, i) => `other-${i}`), ...extra];

function mockFetch(pages, calls = []) {
  return async (url, init) => {
    calls.push({ url, method: init?.method, auth: init?.headers?.Authorization });
    const page = Number(new URL(url).searchParams.get('page') ?? 1);
    const names = pages[page - 1];
    if (!names) return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }), { status: 403 });
    return new Response(JSON.stringify({ success: true, result: names.map((id) => ({ id })), result_info: { page, total_pages: pages.length } }));
  };
}

test('the dataset Workers deploy first and the catalogue reuses demodb-websites, last, with demodb.dev only', async () => {
  const configs = await validateConfigs(await hostConfigs());
  assert.deepEqual(configs.map(({ config }) => config.name), [...DATASET_WORKERS, CATALOGUE_SCRIPT]);
  assert.deepEqual(configs.at(-1).config.routes, [{ pattern: 'demodb.dev', custom_domain: true }]);
  assert.ok(!configs.some(({ config }) => config.routes.some((route) => route.pattern === 'chinookdb.com')), 'chinookdb.com is detached by the last deploy');
});

test('a real run lists Workers (read-only GET) before any wrangler call, then deploys in order', async () => {
  const configs = await hostConfigs();
  const events = [];
  const fetch = async (url, init) => { events.push(`${init?.method} ${url}`); return mockFetch([scripts(100, [CATALOGUE_SCRIPT, ...ESTABLISHED_DATASET_WORKERS])])(url, init); };
  const log = [];
  await deployHosts({ configs, env, fetch, wrangler: (args) => events.push(`wrangler ${args.join(' ')}`), log: (line) => log.push(line) });
  assert.deepEqual(events, [
    'GET https://api.cloudflare.com/client/v4/accounts/acct123/workers/scripts',
    ...DATASET_WORKERS.map((name) => `wrangler deploy --config deploy/hosts/${name}.jsonc`),
    'wrangler deploy --config deploy/hosts/demodb-websites.jsonc',
  ]);
  assert.match(log[0], /100 existing, 0 slot\(s\) needed/);
});

test('today\'s account (100 Workers incl. demodb-websites) passes at exactly 100: no new Worker', async () => {
  const configs = await hostConfigs();
  const plan = await preflight({ names: configs.map(({ config }) => config.name), env, fetch: mockFetch([scripts(100, [CATALOGUE_SCRIPT, ...ESTABLISHED_DATASET_WORKERS])]) });
  assert.deepEqual(plan.created, NEW_DATASET_WORKERS);
  assert.equal(plan.after, 100);
  assert.ok(plan.ok);
});

test('a failed preflight deploys nothing and says how many slots are needed', async () => {
  const configs = await hostConfigs();
  const calls = [];
  await assert.rejects(deployHosts({ configs, env, fetch: mockFetch([scripts(100, [CATALOGUE_SCRIPT, ...ESTABLISHED_DATASET_WORKERS.slice(1)])]), wrangler: (args) => calls.push(args), log: () => {} }),
    /needs 1 free Worker slot\(s\) .* the account has 100 Workers and 0 free under the limit of 100 \(101 in total after the deploy\)\. Nothing was deployed\. Free 1 more Worker slot/);
  assert.deepEqual(calls, []);
});

test('an account above the configured limit can update existing Workers without creating any', async () => {
  const configs = await hostConfigs();
  const calls = [];
  await deployHosts({ configs, env, fetch: mockFetch([scripts(103, [CATALOGUE_SCRIPT, ...ESTABLISHED_DATASET_WORKERS])]), wrangler: (args) => calls.push(args), log: () => {} });
  assert.equal(calls.length, configs.length);
});

test('an account above the configured limit still refuses a new Worker before deploying anything', async () => {
  const configs = await hostConfigs();
  const calls = [];
  await assert.rejects(deployHosts({ configs, env, fetch: mockFetch([scripts(103, [CATALOGUE_SCRIPT, ...ESTABLISHED_DATASET_WORKERS.slice(1)])]), wrangler: (args) => calls.push(args), log: () => {} }), /needs 1 free Worker slot/);
  assert.deepEqual(calls, []);
});

test('a dry run calls no API and passes --dry-run to every wrangler deploy', async () => {
  const configs = await hostConfigs();
  const calls = [];
  await deployHosts({ configs, dryRun: true, env: {}, fetch: async () => { throw new Error('no network in a dry run'); }, wrangler: (args) => calls.push(args.join(' ')), log: () => {} });
  assert.equal(calls.length, 9);
  for (const call of calls) assert.match(call, /^deploy --config deploy\/hosts\/demodb-[a-z-]+\.jsonc --dry-run$/);
});

test('capacityPlan counts only names the account does not have yet', () => {
  assert.deepEqual(capacityPlan(['a', 'b', CATALOGUE_SCRIPT], ['a', CATALOGUE_SCRIPT, 'c', 'd'], 5), { existing: 3, created: ['c', 'd'], after: 5, limit: 5, free: 2, ok: true });
  assert.equal(capacityPlan(['a', 'b', CATALOGUE_SCRIPT], ['c', 'd', 'e'], 5).ok, false);
});

test('the limit is configurable through DEMODB_WORKERS_LIMIT', async () => {
  const names = [CATALOGUE_SCRIPT, 'demodb-chinook'];
  const fetch = mockFetch([scripts(100, [CATALOGUE_SCRIPT])]);
  await assert.rejects(preflight({ names, env, fetch }), /limit of 100/);
  assert.equal((await preflight({ names, env: { ...env, DEMODB_WORKERS_LIMIT: '500' }, fetch })).limit, 500);
  assert.equal(parseLimit(undefined), DEFAULT_WORKERS_LIMIT);
  assert.throws(() => parseLimit('lots'), /positive integer/);
  assert.throws(() => parseLimit('0'), /positive integer/);
});

test('every page the API reports is counted, with the token sent to the account endpoint', async () => {
  const calls = [];
  const names = await cloudflare({ fetch: mockFetch([['a', 'b'], ['c']], calls), token: 't', accountId: 'x' }).listWorkerScripts();
  assert.deepEqual(names, ['a', 'b', 'c']);
  assert.deepEqual(calls.map(({ url }) => url), ['https://api.cloudflare.com/client/v4/accounts/x/workers/scripts', 'https://api.cloudflare.com/client/v4/accounts/x/workers/scripts?page=2']);
  assert.ok(calls.every(({ auth, method }) => auth === 'Bearer t' && method === 'GET'));
});

test('the API client treats a 2xx with an empty body as success, and anything else unexpected as failure', async () => {
  const answer = (status, body) => cloudflare({ fetch: async () => new Response(body, { status }), token: 't', accountId: 'x' }).call('DELETE', '/accounts/x/workers/domains/abc');
  assert.deepEqual(await answer(200, ''), { success: true, result: null }, '200 with an empty body (the response that broke run 38964238432)');
  assert.deepEqual(await answer(200, ' \n'), { success: true, result: null });
  assert.deepEqual(await answer(204, null), { success: true, result: null });
  assert.equal((await answer(200, JSON.stringify({ success: true, result: { id: 'abc' } }))).result.id, 'abc');
  await assert.rejects(answer(200, JSON.stringify({ success: false, errors: [{ code: 1, message: 'nope' }] })), /failed \(1: nope\)/);
  await assert.rejects(answer(200, 'not json'), /failed \(HTTP 200, body is not JSON\)/);
  await assert.rejects(answer(404, ''), /failed \(HTTP 404\)/);
  await assert.rejects(answer(502, 'Bad gateway'), /failed \(HTTP 502, body is not JSON\)/);
});

test('the preflight fails closed when the API or the credentials are unavailable', async () => {
  await assert.rejects(preflight({ names: ['x'], env: {}, fetch: mockFetch([[]]) }), /CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required/);
  await assert.rejects(preflight({ names: ['x'], env, fetch: mockFetch([]) }), /Cannot list the account's Workers \(.*10000: Authentication error\)/);
  await assert.rejects(preflight({ names: ['x'], env, fetch: async () => new Response('not json', { status: 502 }) }), /Cannot list the account's Workers \(.*HTTP 502/);
  await assert.rejects(preflight({ names: ['x'], env, fetch: async () => new Response('', { status: 200 }) }), /Cannot list the account's Workers \(.*no script list\)/);
});
