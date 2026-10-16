// Deploys (or, with --dry-run, validates) every assets-only DemoDB host config in deploy/hosts/.
// Each config has no `main`, so the deployed Worker is static assets only: requests never run a Worker
// script and do not count against the Workers request quota. Configs are deployed one at a time and the
// first failure stops the run. In CI (no TTY) Wrangler moves an existing custom domain, such as one still
// bound to the retired demodb-websites Worker, to the config that names it.
import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
export const hostsDir = join(root, 'deploy/hosts');

export async function hostConfigs() {
  const files = (await readdir(hostsDir)).filter((name) => name.endsWith('.jsonc')).sort();
  const configs = [];
  for (const file of files) {
    const text = await readFile(join(hostsDir, file), 'utf8');
    const config = JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''));
    configs.push({ file: join('deploy/hosts', file), config });
  }
  // Dataset hosts first, then the catalogue, then legacy aliases that redirect to both.
  const rank = ({ config }) => config.name === 'demodb-catalogue' ? 1 : config.routes.some((route) => route.pattern.endsWith('.demodb.dev')) ? 0 : 2;
  return configs.sort((a, b) => rank(a) - rank(b) || a.file.localeCompare(b.file));
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  for (const { file, config } of await hostConfigs()) {
    if (config.main) throw new Error(`${file} declares a Worker script (main); DemoDB hosts must be assets-only`);
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
