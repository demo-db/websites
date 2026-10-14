import type { ExportFile } from './types';

const dataTugDemoOrigin = 'https://datatug.app/demo';

// The subset of a dataset's generated metadata that decides which DataTug
// editions can be offered. Only editions published in that metadata appear.
export type ExploreSubject = { id: string; exports: Pick<ExportFile, 'format' | 'table'>[] };

export type ExploreAction = { engine: 'SQLite'; label: string; href: string };
export type ExploreActions = { primary: ExploreAction | null; secondary: ExploreAction[] };

type Edition = {
  engine: ExploreAction['engine'];
  path: string;
  available: (subject: ExploreSubject) => boolean;
};

// Ordered by preference. A future edition, such as PostgreSQL, is added here
// only once its availability is published in the generated metadata.
const editions: Edition[] = [
  {
    engine: 'SQLite',
    path: 'sqlite',
    available: (subject) => subject.exports.some((file) => file.format === 'sqlite' && file.table === null),
  },
];

export function exploreActions(subject: ExploreSubject | undefined): ExploreActions {
  if (!subject) return { primary: null, secondary: [] };
  const actions = editions
    .filter((edition) => edition.available(subject))
    .map((edition): ExploreAction => ({
      engine: edition.engine,
      label: `Explore ${edition.engine} in DataTug`,
      href: `${dataTugDemoOrigin}/${edition.path}/${encodeURIComponent(subject.id)}`,
    }));
  const [primary = null, ...secondary] = actions;
  return { primary, secondary };
}
