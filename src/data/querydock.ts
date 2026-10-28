import { databaseById } from './db';
import manifest from './querydock/manifest.json';
export type QueryExample = { id: string; title: string; sql: string; href: string; snapshotDigest: string; expected: { columns: string[]; rowCount: number; rows: unknown[][] } };
export type TeachingDataset = { catalogDigest: string; datasetDigest: string; engine: string; engineVersion: string; fixtureSha256: string; sourceRevision: string; scope: string; rowCounts: Record<string, number>; rootTables: string[]; examples: QueryExample[] };
export const teachingDatasets = manifest.datasets as unknown as Record<string, TeachingDataset>;
export function preparedQuery(id: string, example: QueryExample, returnPath = '/queries/'): string {
  const href = new URL(example.href);
  href.searchParams.set('returnTo', `https://${id}.demodb.dev${returnPath}`);
  href.searchParams.set('sourceSha256', teachingDatasets[id].fixtureSha256);
  return href.href;
}

// A provider refresh must not silently leave examples claiming another fixture revision.
for (const [id, dataset] of Object.entries(teachingDatasets)) {
  const db = databaseById.get(id);
  const fixture = db?.exports.find((file) => file.format === 'sqlite' && file.table === null);
  if (!db || db.sourceCommit !== dataset.sourceRevision || (fixture?.decodedSha256 ?? fixture?.sha256) !== dataset.fixtureSha256 || db.queries.some((query) => !dataset.examples.some((example) => example.sql === query.sql))) {
    throw new Error(`Prepared QueryDock inputs for ${id} are stale. Regenerate and review both release worktrees before publishing.`);
  }
}
