// Unit tests of scripts/deploy-hosts.mjs: deploy order and the Workers capacity preflight (mocked fetch).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CATALOGUE_SCRIPT, DEFAULT_WORKERS_LIMIT, capacityPlan, hostConfigs, listWorkerScripts, parseLimit, preflight } from './deploy-hosts.mjs';

const env = { CLOUDFLARE_API_TOKEN: 'test-token', CLOUDFLARE_ACCOUNT_ID: 'acct123' };
const scripts = (count, extra = []) => [...Array.from({ length: count - extra.length }, (_, i) => `other-${i}`), ...extra];

function mockFetch(pages, calls = []) {
  return async (url, init) => {
    calls.push({ url, auth: init?.headers?.Authorization });
    const page = Number(new URL(url).searchParams.get('page') ?? 1);
    const names = pages[page - 1];
    if (!names) return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }), { status: 403 });
    return new Response(JSON.stringify({ success: true, result: names.map((id) => ({ id })), result_info: { page, total_pages: pages.length } }));
  };
}

test('the catalogue reuses the existing demodb-websites script and deploys after every other host', async () => {
  const configs = await hostConfigs();
  assert.equal(configs.at(-1).config.name, CATALOGUE_SCRIPT);
  assert.deepEqual(configs.at(-1).config.routes, [{ pattern: 'demodb.dev', custom_domain: true }]);
  const datasetIndexes = configs.map(({ config }, i) => (config.routes[0].pattern.endsWith('.demodb.dev') ? i : -1)).filter((i) => i >= 0);
  const otherIndexes = configs.map(({ config }, i) => (!config.routes[0].pattern.endsWith('demodb.dev') ? i : -1)).filter((i) => i >= 0);
  assert.ok(Math.max(...datasetIndexes) < Math.min(...otherIndexes, configs.length - 1), 'dataset hosts first');
  assert.equal(configs.filter(({ config }) => config.name === CATALOGUE_SCRIPT).length, 1);
});

test('capacityPlan counts only names the account does not have yet', () => {
  assert.deepEqual(capacityPlan(['a', 'b', CATALOGUE_SCRIPT], ['a', CATALOGUE_SCRIPT, 'c', 'd'], 5), { existing: 3, created: ['c', 'd'], after: 5, limit: 5, ok: true });
  assert.equal(capacityPlan(['a', 'b', CATALOGUE_SCRIPT], ['c', 'd', 'e'], 5).ok, false);
});

test('preflight passes when the new scripts fit and sends the token to the account endpoint', async () => {
  const calls = [];
  const names = [CATALOGUE_SCRIPT, 'demodb-chinook', 'demodb-pubs'];
  const plan = await preflight({ names, env, fetch: mockFetch([scripts(98, [CATALOGUE_SCRIPT])], calls) });
  assert.deepEqual(plan.created, ['demodb-chinook', 'demodb-pubs']);
  assert.equal(plan.after, 100);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.cloudflare.com/client/v4/accounts/acct123/workers/scripts');
  assert.equal(calls[0].auth, 'Bearer test-token');
});

test('preflight fails before any deploy when the account would exceed its Workers limit', async () => {
  const names = [CATALOGUE_SCRIPT, 'demodb-chinook', 'demodb-northwind', 'demodb-pubs', 'demodb-sakila', 'demodb-adventureworks', 'demodb-employees', 'demodb-chinookdb-com'];
  await assert.rejects(preflight({ names, env, fetch: mockFetch([scripts(100, [CATALOGUE_SCRIPT])]) }),
    /the account has 100 Workers and this deploy would create 7 more .*107 in total, above the limit of 100\. Nothing was deployed\. Free 7 Worker slot/);
});

test('the limit is configurable through DEMODB_WORKERS_LIMIT', async () => {
  const names = [CATALOGUE_SCRIPT, 'demodb-chinook'];
  const fetch = mockFetch([scripts(100, [CATALOGUE_SCRIPT])]);
  await assert.rejects(preflight({ names, env, fetch }), /above the limit of 100/);
  assert.equal((await preflight({ names, env: { ...env, DEMODB_WORKERS_LIMIT: '500' }, fetch })).limit, 500);
  assert.equal(parseLimit(undefined), DEFAULT_WORKERS_LIMIT);
  assert.throws(() => parseLimit('lots'), /positive integer/);
  assert.throws(() => parseLimit('0'), /positive integer/);
});

test('every page the API reports is counted', async () => {
  const names = await listWorkerScripts({ fetch: mockFetch([['a', 'b'], ['c']]), token: 't', accountId: 'x' });
  assert.deepEqual(names, ['a', 'b', 'c']);
});

test('the preflight fails closed when the API or the credentials are unavailable', async () => {
  await assert.rejects(preflight({ names: ['x'], env: {}, fetch: mockFetch([[]]) }), /CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required/);
  await assert.rejects(preflight({ names: ['x'], env, fetch: mockFetch([]) }), /Cannot list the account's Workers \(10000: Authentication error\)/);
  await assert.rejects(preflight({ names: ['x'], env, fetch: async () => new Response('not json', { status: 502 }) }), /Cannot list the account's Workers \(HTTP 502\)/);
});
