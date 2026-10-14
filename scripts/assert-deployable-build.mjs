// Fails closed unless the built dist/ is the production build: PostgreSQL API config taken from the
// committed config/postgresql-api.json (not a fixture selected by DEMODB_POSTGRESQL_API_CONFIG) and
// byte-identical to the committed file now. Runs before every deploy (pnpm run deploy:worker, CI deploy job).
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const DEPLOYABLE_POSTGRESQL_API_SOURCE = 'config/postgresql-api.json';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function deployableProblems(root, env = process.env) {
  const problems = [];
  if (env.DEMODB_POSTGRESQL_API_CONFIG) problems.push('DEMODB_POSTGRESQL_API_CONFIG is set; unset it and rebuild before deploying');
  let committed;
  try { committed = sha256(await readFile(join(root, DEPLOYABLE_POSTGRESQL_API_SOURCE))); } catch { problems.push(`${DEPLOYABLE_POSTGRESQL_API_SOURCE} cannot be read`); }
  let info;
  try { info = JSON.parse(await readFile(join(root, 'dist/build-info.json'), 'utf8')); } catch { problems.push('dist/build-info.json is missing or unreadable; run pnpm build'); }
  if (info) {
    const config = info.postgresqlApiConfig;
    if (!config || typeof config.source !== 'string' || typeof config.sha256 !== 'string') problems.push('dist/build-info.json records no PostgreSQL API config provenance; rebuild');
    else {
      if (config.source !== DEPLOYABLE_POSTGRESQL_API_SOURCE) problems.push(`the build used PostgreSQL API config ${config.source}, not ${DEPLOYABLE_POSTGRESQL_API_SOURCE}; it is not deployable`);
      if (committed && config.sha256 !== committed) problems.push(`the build used a ${DEPLOYABLE_POSTGRESQL_API_SOURCE} that differs from the committed file; rebuild`);
    }
  }
  return problems;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const root = new URL('..', import.meta.url).pathname;
  const problems = await deployableProblems(root);
  if (problems.length) {
    for (const problem of problems) console.error(`NOT DEPLOYABLE: ${problem}`);
    process.exitCode = 1;
  } else console.log('Build is deployable: PostgreSQL API config is the committed config/postgresql-api.json.');
}
