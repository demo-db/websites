// Deploys (or, with --dry-run, validates) every assets-only DemoDB host config in deploy/hosts/.
//
//   node scripts/deploy-hosts.mjs --dry-run   validate the configs and bundles, then `wrangler deploy --dry-run` each
//                                             config (no account, no network change; CI on every build)
//   node scripts/deploy-hosts.mjs             capacity preflight, then `wrangler deploy` each config (push to main,
//                                             with CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID)
//
// Each config has no `main`, so the deployed Worker is static assets only: requests never run a Worker
// script and do not count against the Workers request quota. One Worker per host. Configs are deployed one at a
// time and the first failure stops the run; a re-run is idempotent.
//
// Order matters for custom domains. In CI (no TTY) Wrangler moves a custom domain that another script holds
// to the config that names it (override_existing_origin), creates or updates its proxied DNS record, and it
// REPLACES a script's whole custom-domain set with the routes of the config being deployed (changeset
// `replace_state=true`, PUT `override_scope: true`). The catalogue config keeps the existing script name
// `demodb-websites`, which holds the DemoDB custom domains before the cutover, so it deploys LAST: by then every
// dataset host has moved its domain away, and its replace leaves only demodb.dev (chinookdb.com is detached).
//
// Before a real deploy, a preflight lists the account's Workers through the Cloudflare API and fails, before
// anything is deployed, when the run would create more scripts than the account may hold
// (DEMODB_WORKERS_LIMIT, default 100: the Workers Free plan limit). The preflight only reads.
import { spawnSync } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
export const hostsDir = join(root, 'deploy/hosts');
export const CATALOGUE_SCRIPT = 'demodb-websites';
export const CATALOGUE_HOST = 'demodb.dev';
export const DEFAULT_WORKERS_LIMIT = 100;

// Dataset hosts, then any other host, then the catalogue script that holds the old custom domains.
export function orderConfigs(configs) {
  const rank = ({ config }) => config.name === CATALOGUE_SCRIPT ? 2 : config.routes.some((route) => route.pattern.endsWith(`.${CATALOGUE_HOST}`)) ? 0 : 1;
  return [...configs].sort((a, b) => rank(a) - rank(b) || a.file.localeCompare(b.file));
}

export async function hostConfigs(dir = hostsDir) {
  const files = (await readdir(dir)).filter((name) => name.endsWith('.jsonc')).sort();
  const configs = [];
  for (const file of files) {
    const text = await readFile(join(dir, file), 'utf8');
    const config = JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''));
    configs.push({ file: join('deploy/hosts', file), config });
  }
  return orderConfigs(configs);
}

// Every config must be assets-only with exactly one custom domain, and the configs must match the built bundles
// (dist-hosts/manifest.json) one to one, each bundle with its top-level 404.html.
export async function validateConfigs(configs, output = join(root, 'dist-hosts')) {
  const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
  if (manifest.format !== 'demodb-static-hosts/v1') throw new Error('dist-hosts/manifest.json has an unexpected format; run pnpm build');
  const byHost = new Map(manifest.hosts.map((host) => [host.host, host]));
  const seen = new Set();
  for (const { file, config } of configs) {
    if (config.main) throw new Error(`${file} declares a Worker script (main); DemoDB hosts must be assets-only`);
    if (config.routes?.length !== 1 || config.routes[0].custom_domain !== true) throw new Error(`${file}: exactly one custom_domain route is required`);
    const host = config.routes[0].pattern;
    if (seen.has(host)) throw new Error(`${file}: ${host} is declared twice`);
    seen.add(host);
    const built = byHost.get(host);
    if (!built) throw new Error(`${file}: ${host} has no built bundle in dist-hosts/manifest.json`);
    if (built.name !== config.name) throw new Error(`${file}: Worker name ${config.name} differs from the build's ${built.name}`);
    if (config.assets?.directory !== `../../dist-hosts/${host}`) throw new Error(`${file}: assets.directory must be ../../dist-hosts/${host}`);
    if (!(await stat(join(output, host, '404.html')).catch(() => null))?.isFile()) throw new Error(`${file}: dist-hosts/${host} has no top-level 404.html`);
  }
  const missing = [...byHost.keys()].filter((host) => !seen.has(host));
  if (missing.length) throw new Error(`no deploy/hosts config for ${missing.join(', ')}`);
  return configs;
}

// A small read-only Cloudflare v4 API client; `fetch` is injectable for tests. A 2xx answer with an empty body
// is a success with no result (some endpoints, e.g. DELETE /workers/domains/:id, answer 200 with nothing).
export function cloudflare({ fetch: fetchImpl = globalThis.fetch, token, accountId }) {
  async function call(method, path) {
    const response = await fetchImpl(`https://api.cloudflare.com/client/v4${path}`, { method, headers: { Authorization: `Bearer ${token}` } });
    const text = await response.text().catch(() => '');
    let json = null;
    if (text.trim() !== '') {
      try { json = JSON.parse(text); } catch { json = undefined; }
    }
    if (response.ok && json === null) return { success: true, result: null };
    if (!response.ok || !json?.success) {
      const reason = json?.errors?.map((error) => `${error.code}: ${error.message}`).join('; ') || `HTTP ${response.status}${json === undefined ? ', body is not JSON' : ''}`;
      const error = new Error(`${method} ${path} failed (${reason})`);
      error.status = response.status;
      throw error;
    }
    return json;
  }
  const account = `/accounts/${encodeURIComponent(accountId)}`;
  return {
    call,
    // Every Worker script name on the account, across every page the API reports.
    async listWorkerScripts() {
      const names = [];
      for (let page = 1, pages = 1; page <= pages; page++) {
        const json = await call('GET', `${account}/workers/scripts${page > 1 ? `?page=${page}` : ''}`);
        if (!Array.isArray(json.result)) throw new Error(`GET ${account}/workers/scripts returned no script list`);
        names.push(...json.result.map((script) => script.id));
        const totalPages = Number(json.result_info?.total_pages);
        if (Number.isSafeInteger(totalPages) && totalPages > pages && totalPages <= 50) pages = totalPages;
      }
      return [...new Set(names)];
    },
  };
}

// Pure capacity check: how many of `names` would be new scripts, and whether that fits under `limit`.
export function capacityPlan(existing, names, limit) {
  const have = new Set(existing);
  const created = [...new Set(names)].filter((name) => !have.has(name));
  const after = have.size + created.length;
  return { existing: have.size, created, after, limit, free: Math.max(0, limit - have.size), ok: after <= limit };
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
  let existing;
  try {
    existing = await cloudflare({ fetch: fetchImpl, token, accountId }).listWorkerScripts();
  } catch (error) {
    throw new Error(`Cannot list the account's Workers (${error.message}); refusing to deploy without the capacity preflight`);
  }
  const plan = capacityPlan(existing, names, limit);
  if (!plan.ok) {
    throw new Error(`Workers capacity preflight failed: this deploy needs ${plan.created.length} free Worker slot(s) (${plan.created.join(', ')}) but the account has ${plan.existing} Workers and ${plan.free} free under the limit of ${limit} (${plan.after} in total after the deploy). Nothing was deployed. Free ${plan.after - limit} more Worker slot(s) in the Cloudflare dashboard, or set DEMODB_WORKERS_LIMIT if the plan allows more.`);
  }
  return plan;
}

// The whole run. `wrangler(args)` runs one Wrangler command and throws on failure; `fetch` reaches the API.
export async function deployHosts({ configs, dryRun = false, env = process.env, fetch: fetchImpl = globalThis.fetch, wrangler, log = console.log }) {
  if (!dryRun) {
    const plan = await preflight({ names: configs.map(({ config }) => config.name), env, fetch: fetchImpl });
    log(`Workers capacity preflight: ${plan.existing} existing, ${plan.created.length} slot(s) needed (${plan.created.join(', ') || 'none'}), ${plan.free} free, ${plan.after}/${plan.limit} after deploy.`);
  }
  for (const { file, config } of configs) {
    log(`${config.routes[0].pattern} -> Worker ${config.name} (${file})`);
    wrangler(['deploy', '--config', file, ...(dryRun ? ['--dry-run'] : [])]);
  }
}

function runWrangler(args) {
  console.log(`wrangler ${args.join(' ')}`);
  const result = spawnSync(join(root, 'node_modules/.bin/wrangler'), args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    throw new Error(`${args[2]}: wrangler ${args.includes('--dry-run') ? 'dry-run' : 'deploy'} failed`);
  }
}

async function main() {
  const configs = await validateConfigs(await hostConfigs());
  await deployHosts({ configs, dryRun: process.argv.includes('--dry-run'), wrangler: runWrangler });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
