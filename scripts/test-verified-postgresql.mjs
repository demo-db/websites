// Runs the whole suite with the verified PostgreSQL fixture selected. Its dist/ is NOT deployable.
import { spawnSync } from 'node:child_process';

const note = 'NOTE: this build uses scripts/fixtures/postgresql-api-verified.json. Its dist/ is NOT deployable; rebuild with `pnpm build` (no DEMODB_POSTGRESQL_API_CONFIG) before any deploy. The deploy guard refuses it.';
console.log(note);
const result = spawnSync('pnpm', ['test'], { stdio: 'inherit', env: { ...process.env, DEMODB_POSTGRESQL_API_CONFIG: 'scripts/fixtures/postgresql-api-verified.json' } });
console.log(note);
process.exitCode = result.status ?? 1;
