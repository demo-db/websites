import type { ExportFile } from './types';

const dataTugDemoOrigin = 'https://datatug.app/demo';

// The subset of a dataset's generated metadata that decides which DataTug
// editions can be offered. Only editions published in that metadata appear.
export type ExploreSubject = { id: string; exports: Pick<ExportFile, 'format' | 'table'>[] };

export type ExploreAction = { engine: 'SQLite' | 'PostgreSQL'; label: string; href: string };
export type ExploreActions = { primary: ExploreAction | null; secondary: ExploreAction[] };

// The DataTug route of the hosted read-only PostgreSQL edition. `editionId` is the
// storage id the catalogue publishes (`<dataset>-postgresql`); datatug-apps serves
// `/demo/ovdb/<editionId>` (its demo-postgresql-catalog `route`). The one place this URL is built.
export function datatugPostgresqlHref(editionId: string): string {
  return `${dataTugDemoOrigin}/ovdb/${encodeURIComponent(editionId)}`;
}

type Edition = {
  engine: ExploreAction['engine'];
  href: (subject: ExploreSubject, postgresqlEditionId: string | null) => string | null;
};

// Ordered by preference; the first available edition is the primary action. An edition
// is offered only when its availability is published: SQLite by the dataset's generated
// metadata, PostgreSQL by a verified public API (config/postgresql-api.json) plus a
// hosted PostgreSQL storage entry for the dataset (`postgresqlEditionId`, see ovdb.ts).
const editions: Edition[] = [
  {
    engine: 'SQLite',
    href: (subject) => subject.exports.some((file) => file.format === 'sqlite' && file.table === null)
      ? `${dataTugDemoOrigin}/sqlite/${encodeURIComponent(subject.id)}`
      : null,
  },
  {
    engine: 'PostgreSQL',
    href: (_subject, postgresqlEditionId) => postgresqlEditionId ? datatugPostgresqlHref(postgresqlEditionId) : null,
  },
];

export function exploreActions(subject: ExploreSubject | undefined, postgresqlEditionId: string | null = null): ExploreActions {
  if (!subject) return { primary: null, secondary: [] };
  const actions = editions.flatMap((edition): ExploreAction[] => {
    const href = edition.href(subject, postgresqlEditionId);
    return href ? [{ engine: edition.engine, label: `Explore ${edition.engine} in DataTug`, href }] : [];
  });
  const [primary = null, ...secondary] = actions;
  return { primary, secondary };
}
