import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUILD_INFO_FORMAT = 'demodb-build/1';

// Which PostgreSQL API config the build used, copied from the generated file that prepare:databases wrote.
export async function postgresqlApiConfigProvenance(root) {
  const generated = JSON.parse(await readFile(join(root, 'src/data/generated/postgresql-api.json'), 'utf8'));
  const { source, sha256 } = generated.provenance ?? {};
  if (typeof source !== 'string' || !/^[a-f0-9]{64}$/.test(sha256 ?? '')) throw new Error('The generated PostgreSQL API config has no provenance; run prepare:databases');
  return { source, sha256 };
}

export function buildInfo(commit, postgresqlApiConfig) {
  const value = commit ?? 'local';
  if (value !== 'local' && !/^[0-9a-f]{40}$/i.test(value)) throw new Error('BUILD_COMMIT must be a full 40-digit Git commit SHA');
  return { format: BUILD_INFO_FORMAT, commit: value.toLowerCase(), ...(postgresqlApiConfig ? { postgresqlApiConfig } : {}) };
}

export async function writeBuildInfo(root, commit) {
  const dist = join(root, 'dist');
  if (!(await stat(dist).catch(() => null))?.isDirectory()) throw new Error('dist/ is missing; build the static site first');
  const file = join(dist, 'build-info.json');
  await mkdir(dist, { recursive: true });
  const info = buildInfo(commit, await postgresqlApiConfigProvenance(root));
  await writeFile(file, `${JSON.stringify(info, null, 2)}\n`);
  return { file, info };
}

// Compare real paths so spaces or a symlinked directory cannot silently skip writing the marker.
const entry = process.argv[1] ? await realpath(process.argv[1]).catch(() => process.argv[1]) : '';
if (entry === await realpath(fileURLToPath(import.meta.url))) {
  try {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const { file, info } = await writeBuildInfo(root, process.env.BUILD_COMMIT);
    console.log(`Wrote ${file} (commit ${info.commit}).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
