// Deploys every static host bundle in dist-hosts/ as its own Cloudflare Pages project (direct upload, no Git
// integration, no Pages Functions) and moves each public hostname onto it. Pages projects use no Worker slots and
// their static requests are not metered against the Workers request quota.
//
//   node scripts/deploy-hosts.mjs --dry-run   validate the bundles and print the plan (no network; CI on every build)
//   node scripts/deploy-hosts.mjs             deploy and cut over (push to main, with CLOUDFLARE_API_TOKEN and
//                                             CLOUDFLARE_ACCOUNT_ID)
//
// Preflight, before anything changes:
//   - Pages projects: existing + the ones this run creates must fit DEMODB_PAGES_LIMIT (default 100).
//   - Workers: the account's Worker list is recorded; after the run it is compared again and any new Worker
//     fails the run (this deploy must never create one).
//
// Per host, dataset hosts first and demodb.dev last, every step idempotent so a re-run resumes safely:
//   1. ensure the Pages project exists          wrangler pages project create <project> --production-branch main
//   2. upload the bundle                        wrangler pages deploy dist-hosts/<host> --project-name <project> --branch main
//   3. detach the hostname from its Worker      DELETE /accounts/:acct/workers/domains/:id   (Pages cannot add a
//                                               custom domain while a Worker is routed on it)
//   4. attach it to the Pages project           POST /accounts/:acct/pages/projects/:project/domains {name}
//   5. point DNS at the project                 proxied CNAME <host> -> <project subdomain>.pages.dev
//   6. wait until the Pages domain is active    GET .../domains/:host until status "active"
// The host is unavailable from step 3 until step 6 completes; the run prints both times.
//
// After a successful run it prints, but does not run, the command that deletes the retired, now domainless
// demodb-websites Worker.
import { spawnSync } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
export const ZONE = 'demodb.dev';
export const RETIRED_WORKER = 'demodb-websites';
export const DEFAULT_PAGES_LIMIT = 100;
export const DEFAULT_DOMAIN_TIMEOUT_SECONDS = 1200;
export const DOMAIN_POLL_SECONDS = 15;

export function parsePositiveInteger(name, value, fallback) {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer, not ${JSON.stringify(value)}`);
  return number;
}

// Dataset hosts first, the catalogue (demodb.dev) last.
export function orderHosts(hosts) {
  return [...hosts].sort((a, b) => (a.host === ZONE) - (b.host === ZONE) || a.host.localeCompare(b.host));
}

export async function readHosts(output = join(root, 'dist-hosts')) {
  const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
  if (manifest.format !== 'demodb-static-hosts/v1') throw new Error('dist-hosts/manifest.json has an unexpected format; run pnpm build');
  for (const host of manifest.hosts) {
    if (!/^demodb-[a-z0-9-]+$/.test(host.project)) throw new Error(`${host.host}: unexpected Pages project name ${host.project}`);
    if (host.host !== ZONE && !host.host.endsWith(`.${ZONE}`)) throw new Error(`${host.host} is not in the ${ZONE} zone`);
    const dir = join(output, host.host);
    if (!(await stat(join(dir, '404.html')).catch(() => null))?.isFile()) throw new Error(`${host.host}: no top-level 404.html (Pages would serve index.html for every missing path)`);
    if (!(await readdir(dir)).includes('index.html')) throw new Error(`${host.host}: no index.html`);
  }
  return orderHosts(manifest.hosts).map((host) => ({ ...host, dir: join('dist-hosts', host.host) }));
}

// A small Cloudflare v4 API client; `fetch` is injectable for tests.
export function cloudflare({ fetch: fetchImpl = globalThis.fetch, token, accountId }) {
  async function call(method, path, body) {
    const response = await fetchImpl(`https://api.cloudflare.com/client/v4${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let json;
    try { json = await response.json(); } catch { json = null; }
    if (!response.ok || !json?.success) {
      const reason = json?.errors?.map((error) => `${error.code}: ${error.message}`).join('; ') || `HTTP ${response.status}`;
      const error = new Error(`${method} ${path} failed (${reason})`);
      error.status = response.status;
      throw error;
    }
    return json;
  }
  async function all(path) {
    const items = [];
    for (let page = 1, pages = 1; page <= pages; page++) {
      const json = await call('GET', `${path}${path.includes('?') ? '&' : '?'}page=${page}`);
      items.push(...json.result);
      const total = Number(json.result_info?.total_pages);
      if (Number.isSafeInteger(total) && total > pages && total <= 50) pages = total;
    }
    return items;
  }
  const account = `/accounts/${encodeURIComponent(accountId)}`;
  return {
    listWorkers: async () => (await call('GET', `${account}/workers/scripts`)).result.map((script) => script.id),
    listPagesProjects: async () => (await all(`${account}/pages/projects`)).map((project) => project.name),
    getPagesProject: async (name) => (await call('GET', `${account}/pages/projects/${name}`)).result,
    listPagesDomains: async (name) => (await call('GET', `${account}/pages/projects/${name}/domains`)).result,
    addPagesDomain: async (name, domain) => (await call('POST', `${account}/pages/projects/${name}/domains`, { name: domain })).result,
    getPagesDomain: async (name, domain) => (await call('GET', `${account}/pages/projects/${name}/domains/${domain}`)).result,
    listWorkerDomains: async (hostname) => (await call('GET', `${account}/workers/domains?hostname=${encodeURIComponent(hostname)}`)).result,
    listServiceDomains: async (service) => (await call('GET', `${account}/workers/domains?service=${encodeURIComponent(service)}`)).result,
    deleteWorkerDomain: async (id) => call('DELETE', `${account}/workers/domains/${id}`),
    zoneId: async (name) => {
      const zones = (await call('GET', `/zones?name=${encodeURIComponent(name)}&account.id=${encodeURIComponent(accountId)}`)).result;
      if (zones.length !== 1) throw new Error(`zone ${name} not found in account ${accountId}`);
      return zones[0].id;
    },
    listDnsRecords: async (zoneId, name) => (await call('GET', `/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}`)).result,
    createCname: async (zoneId, name, content) => (await call('POST', `/zones/${zoneId}/dns_records`, { type: 'CNAME', name, content, proxied: true, ttl: 1, comment: 'DemoDB static host (Cloudflare Pages project), scripts/deploy-hosts.mjs' })).result,
  };
}

export function pagesPlan(existingProjects, projects, limit) {
  const have = new Set(existingProjects);
  const created = [...new Set(projects)].filter((name) => !have.has(name));
  const after = have.size + created.length;
  return { existing: have.size, created, after, limit, ok: after <= limit };
}

export async function preflight({ cf, hosts, env, log }) {
  const limit = parsePositiveInteger('DEMODB_PAGES_LIMIT', env.DEMODB_PAGES_LIMIT, DEFAULT_PAGES_LIMIT);
  const plan = pagesPlan(await cf.listPagesProjects(), hosts.map((host) => host.project), limit);
  if (!plan.ok) {
    throw new Error(`Pages capacity preflight failed: the account has ${plan.existing} Pages projects and this run would create ${plan.created.length} more (${plan.created.join(', ')}), ${plan.after} in total, above the limit of ${limit}. Nothing was changed. Set DEMODB_PAGES_LIMIT if the plan allows more.`);
  }
  const workers = await cf.listWorkers();
  log(`preflight: ${plan.existing} Pages projects, ${plan.created.length} to create (${plan.created.join(', ') || 'none'}), ${plan.after}/${limit} after; ${workers.length} Workers (this run creates none)`);
  return { plan, workers };
}

// Moves one hostname from its Worker custom domain to the Pages project. Every step checks the current state
// first, so a re-run after any failure continues where the last run stopped.
export async function cutover({ cf, host, project, zoneId, log, sleep, now, timeoutSeconds }) {
  const target = (await cf.getPagesProject(project)).subdomain;
  if (!/^[a-z0-9-]+\.pages\.dev$/.test(target ?? '')) throw new Error(`${project}: unexpected Pages subdomain ${target}`);
  const domains = await cf.listPagesDomains(project);
  const attached = domains.find((domain) => domain.name === host);
  let detachedAt = null;
  if (!attached) {
    for (const domain of (await cf.listWorkerDomains(host)).filter((item) => item.hostname === host)) {
      await cf.deleteWorkerDomain(domain.id);
      detachedAt ??= now();
      log(`${host}: detached from Worker ${domain.service} at ${new Date(detachedAt).toISOString()} (the host is down until its Pages domain is active)`);
    }
    await cf.addPagesDomain(project, host);
    log(`${host}: added to Pages project ${project}`);
  } else log(`${host}: already a custom domain of ${project} (status ${attached.status})`);

  const records = await cf.listDnsRecords(zoneId, host);
  const cname = records.find((record) => record.type === 'CNAME' && record.name === host);
  if (cname && cname.content === target) log(`${host}: CNAME -> ${target} already present`);
  else if (cname || records.some((record) => ['A', 'AAAA', 'CNAME'].includes(record.type))) {
    throw new Error(`${host}: DNS already has ${records.map((record) => `${record.type} ${record.content}`).join(', ')}; expected only a proxied CNAME to ${target}. Fix the record in the dashboard and re-run.`);
  } else {
    try {
      await cf.createCname(zoneId, host, target);
      log(`${host}: created proxied CNAME -> ${target}`);
    } catch (error) {
      // Pages may have created the record itself in the meantime; accept it if it is the right one.
      const again = await cf.listDnsRecords(zoneId, host);
      if (!again.some((record) => record.type === 'CNAME' && record.content === target)) throw error;
      log(`${host}: CNAME -> ${target} present`);
    }
  }

  const started = now();
  let last = '';
  while (true) {
    const domain = await cf.getPagesDomain(project, host);
    const state = `${domain.status}${domain.validation_data?.status ? ` (certificate ${domain.validation_data.status})` : ''}${domain.verification_data?.status ? ` (verification ${domain.verification_data.status})` : ''}`;
    if (state !== last) { log(`${host}: Pages domain ${state}`); last = state; }
    if (domain.status === 'active') break;
    if (['blocked', 'error', 'deactivated'].includes(domain.status)) {
      throw new Error(`${host}: Pages domain is ${domain.status}${domain.validation_data?.error_message ? `: ${domain.validation_data.error_message}` : ''}`);
    }
    if (now() - started > timeoutSeconds * 1000) throw new Error(`${host}: Pages domain not active after ${timeoutSeconds}s (last ${state}); re-run to keep waiting`);
    await sleep(DOMAIN_POLL_SECONDS * 1000);
  }
  const activeAt = now();
  log(`${host}: active at ${new Date(activeAt).toISOString()}${detachedAt !== null ? `, ${Math.round((activeAt - detachedAt) / 1000)}s after it left the Worker` : ''}`);
  return { host, target, detachedAt, activeAt };
}

export async function deployHosts({ hosts, cf, wrangler, env = process.env, log = console.log, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now }) {
  const timeoutSeconds = parsePositiveInteger('DEMODB_DOMAIN_TIMEOUT_SECONDS', env.DEMODB_DOMAIN_TIMEOUT_SECONDS, DEFAULT_DOMAIN_TIMEOUT_SECONDS);
  const { workers: before } = await preflight({ cf, hosts, env, log });
  const zoneId = await cf.zoneId(ZONE);
  const projects = new Set(await cf.listPagesProjects());
  const results = [];
  for (const host of orderHosts(hosts)) {
    if (!projects.has(host.project)) {
      wrangler(['pages', 'project', 'create', host.project, '--production-branch', 'main']);
      projects.add(host.project);
      log(`${host.host}: created Pages project ${host.project}`);
    }
    wrangler(['pages', 'deploy', host.dir, '--project-name', host.project, '--branch', 'main', '--commit-dirty=true']);
    log(`${host.host}: uploaded ${host.dir} to ${host.project}`);
    results.push(await cutover({ cf, host: host.host, project: host.project, zoneId, log, sleep, now, timeoutSeconds }));
  }
  const after = await cf.listWorkers();
  const created = after.filter((name) => !before.includes(name));
  if (created.length) throw new Error(`Workers check failed: the run created Worker(s) ${created.join(', ')}; it must create none`);
  log(`Workers check: ${after.length} Workers, none created by this run.`);
  const remaining = (await cf.listServiceDomains(RETIRED_WORKER)).filter((domain) => domain.service === RETIRED_WORKER);
  if (remaining.length) log(`${RETIRED_WORKER} still has custom domains (${remaining.map((domain) => domain.hostname).join(', ')}); do not delete it yet.`);
  else log(`Cleanup (not run automatically): ${RETIRED_WORKER} has no custom domains left. Delete it with:\n  pnpm exec wrangler delete --name ${RETIRED_WORKER}`);
  return results;
}

function runWrangler(args) {
  console.log(`wrangler ${args.join(' ')}`);
  const result = spawnSync(join(root, 'node_modules/.bin/wrangler'), args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`wrangler ${args.slice(0, 2).join(' ')} failed (exit ${result.status})`);
}

async function main() {
  const hosts = await readHosts();
  if (process.argv.includes('--dry-run')) {
    for (const host of hosts) console.log(`plan: ${host.host} -> Pages project ${host.project} (${host.dir})`);
    console.log(`Dry run: ${hosts.length} bundles validated; no network calls.`);
    return;
  }
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !accountId) throw new Error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required');
  await deployHosts({ hosts, cf: cloudflare({ token, accountId }), wrangler: runWrangler });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
