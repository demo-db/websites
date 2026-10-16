// Deploys (or, with --dry-run, validates) every assets-only DemoDB host config in deploy/hosts/.
//
// Each config has no `main`, so the deployed Worker is static assets only: requests never run a Worker
// script and do not count against the Workers request quota. Configs are deployed one at a time and the
// first failure stops the run.
//
// Order matters for custom domains. In CI (no TTY) Wrangler moves a custom domain that another script holds
// to the config that names it (override_existing_origin), and it REPLACES a script's whole custom-domain set
// with the routes of the config being deployed (changeset `replace_state=true`, PUT `override_scope: true`).
// The catalogue config keeps the existing script name `demodb-websites`, which today holds every DemoDB custom domain,
// so it deploys LAST: by then every other host has moved its domain away, and its replace leaves demodb.dev.
//
// Before a real deploy, a preflight lists the account's Workers through the Cloudflare API and fails, before
// anything is deployed, when the run would create more scripts than the account may hold
// (DEMODB_WORKERS_LIMIT, default 100: the Workers Free plan limit).
import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
export const hostsDir = join(root, 'deploy/hosts');
export const CATALOGUE_SCRIPT = 'demodb-websites';
export const DEFAULT_WORKERS_LIMIT = 100;

export async function hostConfigs(dir = hostsDir) {
  const files = (await readdir(dir)).filter((name) => name.endsWith('.jsonc')).sort();
  const configs = [];
  for (const file of files) {
    const text = await readFile(join(dir, file), 'utf8');
    const config = JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''));
    configs.push({ file: join('deploy/hosts', file), config });
  }
  // Dataset hosts, then any other host, then the catalogue script that holds every domain today.
  const rank = ({ config }) => config.name === CATALOGUE_SCRIPT ? 2 : config.routes.some((route) => route.pattern.endsWith('.demodb.dev')) ? 0 : 1;
  return configs.sort((a, b) => rank(a) - rank(b) || a.file.localeCompare(b.file));
}

// Lists the account's Worker script names (every page the API reports).
export async function listWorkerScripts({ fetch: fetchImpl = globalThis.fetch, token, accountId }) {
  const names = [];
  for (let page = 1, pages = 1; page <= pages; page++) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/scripts${page > 1 ? `?page=${page}` : ''}`;
    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
    let body;
    try { body = await response.json(); } catch { body = null; }
    if (!response.ok || !body?.success || !Array.isArray(body.result)) {
      const reason = body?.errors?.map((error) => `${error.code}: ${error.message}`).join('; ') || `HTTP ${response.status}`;
      throw new Error(`Cannot list the account's Workers (${reason}); refusing to deploy without the capacity preflight`);
    }
    names.push(...body.result.map((script) => script.id));
    const totalPages = Number(body.result_info?.total_pages);
    if (Number.isSafeInteger(totalPages) && totalPages > pages && totalPages <= 50) pages = totalPages;
  }
  return [...new Set(names)];
}

// Pure capacity check: how many of `names` would be new scripts, and whether that fits under `limit`.
export function capacityPlan(existing, names, limit) {
  const have = new Set(existing);
  const created = [...new Set(names)].filter((name) => !have.has(name));
  const after = have.size + created.length;
  return { existing: have.size, created, after, limit, ok: after <= limit };
}

export function parseLimit(value) {
  if (value === undefined || value === '') return DEFAULT_WORKERS_LIMIT;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error(`DEMODB_WORKERS_LIMIT must be a positive integer, not ${JSON.stringify(value)}`);
  return limit;
}

export async function preflight({ names, env = process.env, fetch: fetchImpl = globalThis.fetch }) {
  const token = env.CLOUDFLARE_API_TOKEN;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !accountId) throw new Error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required for the Workers capacity preflight');
  const limit = parseLimit(env.DEMODB_WORKERS_LIMIT);
  const existing = await listWorkerScripts({ fetch: fetchImpl, token, accountId });
  const plan = capacityPlan(existing, names, limit);
  if (!plan.ok) {
    throw new Error(`Workers capacity preflight failed: the account has ${plan.existing} Workers and this deploy would create ${plan.created.length} more (${plan.created.join(', ')}), ${plan.after} in total, above the limit of ${limit}. Nothing was deployed. Free ${plan.after - limit} Worker slot(s) in the Cloudflare dashboard, or set DEMODB_WORKERS_LIMIT if the plan allows more.`);
  }
  return plan;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const configs = await hostConfigs();
  for (const { file, config } of configs) {
    if (config.main) throw new Error(`${file} declares a Worker script (main); DemoDB hosts must be assets-only`);
  }
  if (!dryRun) {
    const plan = await preflight({ names: configs.map(({ config }) => config.name) });
    console.log(`Workers capacity preflight: ${plan.existing} existing, ${plan.created.length} to create (${plan.created.join(', ') || 'none'}), ${plan.after}/${plan.limit} after deploy.`);
  }
  for (const { file } of configs) {
    const args = ['deploy', '--config', file, ...(dryRun ? ['--dry-run'] : [])];
    console.log(`wrangler ${args.join(' ')}`);
    const result = spawnSync(join(root, 'node_modules/.bin/wrangler'), args, { cwd: root, stdio: 'inherit' });
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      throw new Error(`${file}: wrangler ${dryRun ? 'dry-run' : 'deploy'} failed`);
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
