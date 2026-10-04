import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const BUILD_INFO_FORMAT = 'demodb-build/1';

export function buildInfo(commit) {
  const value = commit ?? 'local';
  if (value !== 'local' && !/^[0-9a-f]{40}$/i.test(value)) throw new Error('BUILD_COMMIT must be a full 40-digit Git commit SHA');
  return { format: BUILD_INFO_FORMAT, commit: value.toLowerCase() };
}

export async function writeBuildInfo(root, commit) {
  const dist = join(root, 'dist');
  if (!(await stat(dist).catch(() => null))?.isDirectory()) throw new Error('dist/ is missing; build the static site first');
  const file = join(dist, 'build-info.json');
  await mkdir(dist, { recursive: true });
  const info = buildInfo(commit);
  await writeFile(file, `${JSON.stringify(info, null, 2)}\n`);
  return { file, info };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    const root = new URL('..', import.meta.url).pathname;
    const { file, info } = await writeBuildInfo(root, process.env.BUILD_COMMIT);
    console.log(`Wrote ${file} (commit ${info.commit}).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
