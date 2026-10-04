import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';

const root = new URL('..', import.meta.url).pathname;
const workflow = parse(await readFile(join(root, '.github/workflows/deploy.yml'), 'utf8'));
const wrangler = JSON.parse(await readFile(join(root, 'wrangler.jsonc'), 'utf8'));
const liveSmoke = await readFile(join(root, 'scripts/smoke-live.mjs'), 'utf8');

test('workflow only builds pull requests and deploys pushes to main', () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ['pull_request', 'push']);
  assert.deepEqual(workflow.on.push.branches, ['main']);
  assert.ok(!workflow.on.schedule);
  const job = workflow.jobs.deploy;
  assert.ok(job['timeout-minutes'] > 0);
  const actions = job.steps.filter((step) => step.uses).map((step) => step.uses);
  assert.ok(actions.length > 0);
  for (const action of actions) assert.match(action, /@[0-9a-f]{40}(?:\s|$)/, `unpinned action: ${action}`);
  const deploy = job.steps.find((step) => step.name === 'Deploy Worker and static assets');
  assert.match(deploy.if, /github\.event_name == 'push'/);
  assert.match(deploy.if, /env\.HAS_CREDENTIALS == 'true'/);
  assert.equal(deploy.env.CLOUDFLARE_API_TOKEN, '${{ secrets.CLOUDFLARE_API_TOKEN }}');
  assert.ok(job.steps.some((step) => step.name === 'Validate Worker and static asset configuration' && step.run.includes('--dry-run')));
  assert.match(deploy.run, /--env=""/);
  for (const step of job.steps) {
    if (step === deploy) continue;
    assert.ok(!JSON.stringify(step).includes('secrets.CLOUDFLARE_API_TOKEN'), 'Cloudflare token is limited to the deploy step');
  }
  assert.ok(job.steps.some((step) => step.name === 'Verify the deployed commit and public routes' && /github\.event_name == 'push'/.test(step.if)));
});

test('binds the transferred Chinook hostname to the verified legacy redirects', () => {
  const routeNames = wrangler.routes.map((route) => route.pattern);
  assert.equal(new Set(routeNames).size, routeNames.length, 'custom domain bindings are unique');
  for (const route of [
    { pattern: 'demodb.dev', custom_domain: true },
    { pattern: 'chinook.demodb.dev', custom_domain: true },
    { pattern: 'northwind.demodb.dev', custom_domain: true },
    { pattern: 'pubs.demodb.dev', custom_domain: true },
    { pattern: 'sakila.demodb.dev', custom_domain: true },
    { pattern: 'adventureworks.demodb.dev', custom_domain: true },
    { pattern: 'employees.demodb.dev', custom_domain: true },
    { pattern: 'chinookdb.com', custom_domain: true },
  ]) assert.ok(wrangler.routes.some((candidate) => candidate.pattern === route.pattern && candidate.custom_domain === route.custom_domain), `${route.pattern} remains bound`);
  assert.equal(wrangler.vars.ENABLE_LEGACY_REDIRECTS, 'true');
  assert.equal(wrangler.assets.html_handling, 'none');
  assert.equal(wrangler.assets.run_worker_first, true);
});

test('live smoke separates DTQL limits from OVDB server pagination', () => {
  const northwindCall = liveSmoke.match(/await checkedReadOnlyQuery\('northwind', (".*?"), 2\);/)?.[1];
  assert.ok(northwindCall, 'Northwind live smoke uses a two-record server page');
  const pagedQuery = JSON.parse(northwindCall);
  assert.match(pagedQuery, /orderBy:/);
  assert.doesNotMatch(pagedQuery, /\b(?:limit|offset):/i, 'server-paginated DTQL cannot specify its own limit or offset');
  assert.match(liveSmoke, /await checkedReadOnlyQuery\('chinook', 'from: \{name: Artist\}\\nlimit: 1\\n'\);/, 'an unpaged query retains its ordinary DTQL limit');
  assert.match(liveSmoke, /if \(pageSize !== undefined\) headers\['OVDB-Page-Size'\] = String\(pageSize\)/);
});

test('live smoke checks Pubs static pages and its verified query endpoint', () => {
  assert.match(liveSmoke, /https:\/\/pubs\.demodb\.dev/);
  assert.match(liveSmoke, /\/data\/pubs\.sqlite/);
  assert.match(liveSmoke, /\/ovdb\/db\/pubs\/ovdb-database\.json/);
  assert.match(liveSmoke, /await checkedReadOnlyQuery\('pubs'/);
});

test('live smoke checks Sakila native tables, views, and SQLite without claiming query availability', () => {
  assert.match(liveSmoke, /https:\/\/sakila\.demodb\.dev/);
  assert.match(liveSmoke, /\/tables\/film_actor\//);
  assert.match(liveSmoke, /\/tables\/actor_info\//);
  assert.match(liveSmoke, /\/data\/sakila\.sqlite/);
  assert.match(liveSmoke, /\/ovdb\/db\/sakila\/ovdb-database\.json/);
  assert.doesNotMatch(liveSmoke, /checkedReadOnlyQuery\('sakila'/);
});

test('live smoke verifies AdventureWorks full SQLite bytes and source-only SQL Server views', () => {
  assert.match(liveSmoke, /https:\/\/adventureworks\.demodb\.dev/);
  assert.match(liveSmoke, /\/tables\/HumanResources\.EmployeeDepartmentHistory\//);
  assert.match(liveSmoke, /\/tables\/Production\.Product\//);
  assert.match(liveSmoke, /\/schema\.json/);
  assert.match(liveSmoke, /checkedDecodedSqlite\('adventureworks'\)/);
  assert.match(liveSmoke, /125276160/);
  assert.doesNotMatch(liveSmoke, /checkedReadOnlyQuery\('adventureworks'/);
});

test('live smoke verifies Employees native tables without claiming query availability', () => {
  assert.match(liveSmoke, /https:\/\/employees\.demodb\.dev/);
  assert.match(liveSmoke, /\/tables\/titles\//);
  assert.match(liveSmoke, /\/tables\/current_dept_emp\//);
  assert.match(liveSmoke, /\/data\/employees\.sqlite/);
  assert.doesNotMatch(liveSmoke, /checkedReadOnlyQuery\('employees'/);
});

test('live smoke verifies old-host page, download, canonical profile, and POST redirects without following them', () => {
  assert.match(liveSmoke, /async function checkedLegacyRedirect\(url, init, expectedLocation\)/);
  assert.match(liveSmoke, /redirect: 'manual'/);
  assert.match(liveSmoke, /https:\/\/chinookdb\.com\/tables\/Artist\//);
  assert.match(liveSmoke, /https:\/\/chinookdb\.com\/data\/chinook\.sqlite/);
  assert.match(liveSmoke, /https:\/\/chinookdb\.com\/ovdb\/dbs\/chinook/);
  assert.match(liveSmoke, /https:\/\/chinookdb\.com\/ovdb\/v1\/databases\/chinook\/dtql/);
});
