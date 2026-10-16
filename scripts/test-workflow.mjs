import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';

const root = new URL('..', import.meta.url).pathname;
const workflow = parse(await readFile(join(root, '.github/workflows/deploy.yml'), 'utf8'));
const wrangler = JSON.parse(await readFile(join(root, 'wrangler.jsonc'), 'utf8'));
const liveSmoke = await readFile(join(root, 'scripts/smoke-live.mjs'), 'utf8');
const comparisonHistoryCheck = await readFile(join(root, 'scripts/check-comparison-fixture-history.mjs'), 'utf8');

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
  assert.ok(job.steps.some((step) => step.name === 'Validate Worker and static asset configuration' && step.run === 'pnpm run deploy:dry-run'));
  assert.equal(deploy.run, 'pnpm run deploy:worker');
  const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts;
  assert.match(scripts['deploy:dry-run'], /--dry-run/);
  assert.match(scripts['deploy:worker'], /--env=""/);
  for (const step of job.steps) {
    if (step === deploy) continue;
    assert.ok(!JSON.stringify(step).includes('secrets.CLOUDFLARE_API_TOKEN'), 'Cloudflare token is limited to the deploy step');
  }
  assert.ok(job.steps.some((step) => step.name === 'Verify the deployed commit and public routes' && /github\.event_name == 'push'/.test(step.if)));
});

test('workflow checks pins against the exact PR base or previous push commit', () => {
  const checkout = workflow.jobs.deploy.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with['fetch-depth'], 0, 'the immutable base commit must be available locally');
  const historyCheck = workflow.jobs.deploy.steps.find((step) => step.name === 'Verify comparison fixture pins preserve commit history');
  assert.ok(historyCheck, 'history protection runs in CI');
  assert.equal(historyCheck.run, 'node scripts/check-comparison-fixture-history.mjs');
  assert.match(historyCheck.env.COMPARISON_BASE_SHA, /pull_request\.base\.sha/);
  assert.match(historyCheck.env.COMPARISON_BASE_SHA, /github\.event\.before/);
  assert.match(comparisonHistoryCheck, /cat-file', '-e'/, 'an unavailable historical commit fails closed');
  assert.match(comparisonHistoryCheck, /baseRegistry\.comparisonFixtures/, 'before the separate ledger existed, the base registry pins are retained');
  assert.match(comparisonHistoryCheck, /assertRetainsComparisonFixturePins\(registry\.comparisonFixtures/);
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
  const northwindCall = liveSmoke.match(/\['northwind', \{ query: (".*?"), pageSize: 2, recordset: 'Order Details' \}\]/)?.[1];
  assert.ok(northwindCall, 'Northwind live smoke uses a two-record server page');
  const pagedQuery = JSON.parse(northwindCall);
  assert.match(pagedQuery, /orderBy:/);
  assert.doesNotMatch(pagedQuery, /\b(?:limit|offset):/i, 'server-paginated DTQL cannot specify its own limit or offset');
  assert.match(liveSmoke, /\['chinook', \{ query: 'from: \{name: Artist\}\\nlimit: 1\\n', recordset: 'Artist' \}\]/, 'Chinook retains its ordinary DTQL limit');
  assert.match(liveSmoke, /if \(pageSize !== undefined\) headers\['OVDB-Page-Size'\] = String\(pageSize\)/);
  assert.match(liveSmoke, /await checkedConfiguredDatabaseQueries\(\)/, 'all configured providers receive a live read-only query check');
});

test('live smoke checks all six hosted BigQuery editions and their source, billing, and API boundaries', () => {
  assert.match(liveSmoke, /storageIds = requiredQueryableDatabaseIds\.flatMap\(\(id\) => \[`\$\{id\}-sqlite`, `\$\{id\}-postgresql`, `\$\{id\}-ingitdb`, `\$\{id\}-bigquery`\]\)/);
  assert.match(liveSmoke, /6 datasets\. 4 storage editions each/);
  assert.match(liveSmoke, /body\.includes\('demodb-dev'\) && body\.includes\('your own execution project'\)/);
  assert.match(liveSmoke, /your own Google Cloud execution project/);
  assert.match(liveSmoke, /does not execute or proxy SQL/);
  assert.match(liveSmoke, /DataTug browser query execution is not enabled yet/);
  assert.match(liveSmoke, /checkedNotFound\(`https:\/\/demodb\.dev\/ovdb\/v1\/databases\/\$\{id\}`\)/);
  assert.match(liveSmoke, /!body\.includes\('Open read-only API'\) && !body\.includes\('Database descriptor'\)/);
});

test('live smoke checks Pubs static pages and includes it in shared query coverage', () => {
  assert.match(liveSmoke, /https:\/\/pubs\.demodb\.dev/);
  assert.match(liveSmoke, /\/data\/pubs\.sqlite/);
  assert.match(liveSmoke, /\/ovdb\/db\/pubs\/ovdb-database\.json/);
  assert.match(liveSmoke, /\['pubs', \{ query: 'from: \{name: authors\}\\nlimit: 1\\n', recordset: 'authors' \}\]/);
});

test('live smoke checks Sakila native tables, views, SQLite, and query capability through the shared provider loop', () => {
  assert.match(liveSmoke, /https:\/\/sakila\.demodb\.dev/);
  assert.match(liveSmoke, /\/tables\/film_actor\//);
  assert.match(liveSmoke, /\/tables\/actor_info\//);
  assert.match(liveSmoke, /\/data\/sakila\.sqlite/);
  assert.match(liveSmoke, /\/ovdb\/db\/sakila\/ovdb-database\.json/);
  assert.match(liveSmoke, /requiredQueryableDatabaseIds = \['chinook', 'northwind', 'pubs', 'sakila', 'adventureworks', 'employees'\]/);
});

test('live smoke verifies AdventureWorks full SQLite bytes and source-only SQL Server views', () => {
  assert.match(liveSmoke, /https:\/\/adventureworks\.demodb\.dev/);
  assert.match(liveSmoke, /\/tables\/HumanResources\.EmployeeDepartmentHistory\//);
  assert.match(liveSmoke, /\/tables\/Production\.Product\//);
  assert.match(liveSmoke, /\/schema\.json/);
  assert.match(liveSmoke, /checkedDecodedSqlite\('adventureworks'\)/);
  assert.match(liveSmoke, /126820352/);
  assert.match(liveSmoke, /checkedConfiguredDatabaseQueries\(\)/);
});

test('live smoke verifies the content-addressed Chinook comparison fixture end to end', () => {
  assert.match(liveSmoke, /sha256: '3369d25729dea9e21facc7226aee3d5247fa0f3d8d4be4678aa9247fd064845f'/);
  assert.match(liveSmoke, /bytes: 1007616/);
  assert.match(liveSmoke, /\/data\/compare\/\$\{comparisonFixture\.sha256\}\.sqlite/);
  assert.match(liveSmoke, /await checkedComparisonFixture\(\)/);
  assert.match(liveSmoke, /async function checkedComparisonFixture\(\)/);
  assert.match(liveSmoke, /actualSha256 !== comparisonFixture\.sha256/);
  assert.match(liveSmoke, /headLength !== null && headLength !== String\(comparisonFixture\.bytes\)/, 'HEAD length is optional, but a supplied value must match the pinned GET size');
  assert.match(liveSmoke, /method: 'OPTIONS'/);
  assert.match(liveSmoke, /public, max-age=31536000, immutable/);
  assert.match(liveSmoke, /Access-Control-Allow-Origin/);
  assert.match(liveSmoke, /AbortSignal\.timeout\(45_000\)/, 'the full-byte check has a bounded request deadline');
  assert.match(liveSmoke, /bytes > comparisonFixture\.bytes/, 'the stream is rejected as soon as it exceeds its pinned size');
  assert.match(liveSmoke, /response\.body\.cancel\(\)/, 'an oversized declared body is canceled before reading');
});

test('live smoke verifies Employees native tables and shared query capability coverage', () => {
  assert.match(liveSmoke, /https:\/\/employees\.demodb\.dev/);
  assert.match(liveSmoke, /\/tables\/titles\//);
  assert.match(liveSmoke, /\/tables\/current_dept_emp\//);
  assert.match(liveSmoke, /\/data\/employees\.sqlite/);
  assert.match(liveSmoke, /requiredQueryableDatabaseIds/);
});

test('live smoke verifies old-host page, download, canonical profile, and POST redirects without following them', () => {
  assert.match(liveSmoke, /async function checkedLegacyRedirect\(url, init, expectedLocation\)/);
  assert.match(liveSmoke, /redirect: 'manual'/);
  assert.match(liveSmoke, /https:\/\/chinookdb\.com\/tables\/Artist\//);
  assert.match(liveSmoke, /https:\/\/chinookdb\.com\/data\/chinook\.sqlite/);
  assert.match(liveSmoke, /https:\/\/chinookdb\.com\/ovdb\/dbs\/chinook/);
  assert.match(liveSmoke, /https:\/\/chinookdb\.com\/ovdb\/v1\/databases\/chinook\/dtql/);
});

test('live smoke checks every dataset\'s served model files and model page', () => {
  assert.match(liveSmoke, /from '\.\/served-model\.mjs'/, 'the live check and the Worker test share one definition of a correct served model');
  assert.match(liveSmoke, /await checkedServedModels\(\)/);
  assert.match(liveSmoke, /for \(const id of requiredQueryableDatabaseIds\)[\s\S]*servedModelPaths\(id\)/, 'one HCL and one JSON path per dataset');
  assert.match(liveSmoke, /\[\[paths\.hcl, hclProblems\], \[paths\.json, jsonProblems\]\]/);
  assert.match(liveSmoke, /modelPageProblems\(id, body\)/, 'the model page heading is checked, not the whole page text');
  assert.doesNotMatch(liveSmoke, /includes\('entities'\)/);
  assert.match(liveSmoke, /cache: 'no-store'/);
});

test('the verified PostgreSQL state is tested in CI from a fixture and never deployed', () => {
  const job = workflow.jobs['verified-postgresql-state'];
  assert.equal(job.env.DEMODB_POSTGRESQL_API_CONFIG, 'scripts/fixtures/postgresql-api-verified.json');
  assert.ok(job.steps.some((step) => step.run === 'pnpm test'));
  assert.ok(!JSON.stringify(job).includes('secrets.') && !JSON.stringify(job).includes('wrangler deploy'), 'the fixture build has no credentials and no deploy step');
  assert.equal(workflow.jobs.deploy.env.DEMODB_POSTGRESQL_API_CONFIG, undefined, 'deploys use the committed config');
  assert.ok(!job.steps.some((step) => /deploy/.test(step.run ?? '')), 'the fixture job runs no deploy script');
  assert.equal(job.needs, undefined);
  assert.ok(!Object.values(workflow.jobs).some((other) => [].concat(other.needs ?? []).includes('verified-postgresql-state')), 'nothing consumes the fixture job output');
});

test('every deploy path runs the deployable-build guard after the build and before wrangler deploys', async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  for (const name of ['deploy:worker', 'deploy:dry-run']) assert.match(pkg.scripts[name], /^node scripts\/assert-deployable-build\.mjs && wrangler deploy /, `${name} runs the guard first`);
  const steps = workflow.jobs.deploy.steps;
  const index = (pattern) => steps.findIndex((step) => pattern.test(step.run ?? ''));
  assert.ok(index(/^pnpm build$/) >= 0 && index(/^pnpm run deploy:dry-run$/) > index(/^pnpm build$/));
  assert.ok(index(/^pnpm run deploy:worker$/) > index(/^pnpm build$/));
  assert.ok(!steps.some((step) => /wrangler deploy/.test(step.run ?? '')), 'CI only deploys through the guarded package scripts');
  assert.ok(!/wrangler deploy/.test(Object.entries(pkg.scripts).filter(([name]) => !name.startsWith('deploy:')).map(([, value]) => value).join(' ')), 'no other package script deploys');
});

test('the verified-state fixture matches the committed config format', async () => {
  const committed = JSON.parse(await readFile(join(root, 'config/postgresql-api.json'), 'utf8'));
  const fixture = JSON.parse(await readFile(join(root, 'scripts/fixtures/postgresql-api-verified.json'), 'utf8'));
  assert.equal(typeof committed.publicApiVerified, 'boolean');
  assert.equal(fixture.publicApiVerified, true);
  assert.equal(fixture.format, committed.format);
});

test('live smoke checks every rendered PostgreSQL DataTug link against the datatug-apps catalogue fixture', () => {
  assert.match(liveSmoke, /datatug-postgresql-catalog\.json/);
  assert.match(liveSmoke, /Explore PostgreSQL in DataTug/);
  assert.match(liveSmoke, /checkedDataTugPostgresqlLinks\(\)/);
});
