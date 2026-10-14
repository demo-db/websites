// Fails closed unless the built dist/ is the production build: PostgreSQL API config taken from the
// committed config/postgresql-api.json (not a fixture selected by DEMODB_POSTGRESQL_API_CONFIG) and
// identical to the committed file now. Runs before every deploy (pnpm run deploy:worker, CI deploy job).
// Wrangler bundles src/data/generated/postgresql-api.json, so that file and dist/build-info.json must both
// name the committed config and agree on its hash.
// Limit: "committed" means the working-tree file, not git HEAD; CI checks out clean, so there they are equal.
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEPLOYABLE_POSTGRESQL_API_SOURCE = 'config/postgresql-api.json';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJson = async (file) => { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return undefined; } };

export async function deployableProblems(root, env = process.env) {
  const problems = [];
  if (env.DEMODB_POSTGRESQL_API_CONFIG) problems.push('DEMODB_POSTGRESQL_API_CONFIG is set; unset it and rebuild before deploying');
  let committed;
  try { committed = sha256(await readFile(join(root, DEPLOYABLE_POSTGRESQL_API_SOURCE))); } catch { problems.push(`${DEPLOYABLE_POSTGRESQL_API_SOURCE} cannot be read`); }
  const info = await readJson(join(root, 'dist/build-info.json'));
  if (!info) problems.push('dist/build-info.json is missing or unreadable; run pnpm build');
  const generated = await readJson(join(root, 'src/data/generated/postgresql-api.json'));
  if (!generated) problems.push('src/data/generated/postgresql-api.json is missing or unreadable; run pnpm build');
  const records = [['dist/build-info.json', info?.postgresqlApiConfig, info], ['src/data/generated/postgresql-api.json', generated?.provenance, generated]];
  const hashes = [];
  for (const [name, config, present] of records) {
    if (!present) continue;
    if (!config || typeof config.source !== 'string' || typeof config.sha256 !== 'string') { problems.push(`${name} records no PostgreSQL API config provenance; rebuild`); continue; }
    if (config.source !== DEPLOYABLE_POSTGRESQL_API_SOURCE) problems.push(`${name}: the build used PostgreSQL API config ${config.source}, not ${DEPLOYABLE_POSTGRESQL_API_SOURCE}; it is not deployable`);
    if (committed && config.sha256 !== committed) problems.push(`${name}: the build used a ${DEPLOYABLE_POSTGRESQL_API_SOURCE} that differs from the committed file; rebuild`);
    hashes.push(config.sha256);
  }
  if (hashes.length === 2 && hashes[0] !== hashes[1]) problems.push('dist/build-info.json and src/data/generated/postgresql-api.json disagree on the PostgreSQL API config; rebuild');
  return problems;
}

async function main() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const problems = await deployableProblems(root);
  if (problems.length) {
    for (const problem of problems) console.error(`NOT DEPLOYABLE: ${problem}`);
    process.exitCode = 1;
  } else console.log('Build is deployable: PostgreSQL API config is the committed config/postgresql-api.json.');
}

// Run as a CLI. Compare real paths so spaces and symlinked directories cannot make the entry check silently skip.
const entry = process.argv[1] ? await realpath(process.argv[1]).catch(() => process.argv[1]) : '';
if (entry === await realpath(fileURLToPath(import.meta.url))) await main();
