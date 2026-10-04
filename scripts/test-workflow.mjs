import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';

const root = new URL('..', import.meta.url).pathname;
const workflow = parse(await readFile(join(root, '.github/workflows/deploy.yml'), 'utf8'));
const wrangler = JSON.parse(await readFile(join(root, 'wrangler.jsonc'), 'utf8'));

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

test('only the three verified new hostnames bind, with legacy redirect disabled', () => {
  assert.deepEqual(wrangler.routes, [
    { pattern: 'demodb.dev', custom_domain: true },
    { pattern: 'chinook.demodb.dev', custom_domain: true },
    { pattern: 'northwind.demodb.dev', custom_domain: true },
  ]);
  assert.equal(wrangler.vars.ENABLE_LEGACY_REDIRECTS, 'false');
  assert.equal(wrangler.assets.html_handling, 'none');
  assert.equal(wrangler.assets.run_worker_first, true);
});
