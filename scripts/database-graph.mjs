import { createHash } from 'node:crypto';

export const GRAPH_FORMAT = 'codegrapher-database-graph/v1';
const registered = new Set(['chinook', 'northwind', 'pubs', 'sakila', 'adventureworks', 'employees']);
const segment = encodeURIComponent;

export function meaningGraphHref(repository, concept) {
  const url = new URL(repository);
  if (url.origin !== 'https://github.com' || !/^\/[\w.-]+\/[\w.-]+$/.test(url.pathname)) throw new Error('Invalid meaning repository');
  const base = `https://meaninggraph.io/registry/github.com${url.pathname}/`;
  return concept ? `${base}${concept.kind === 'entity' ? 'entities' : 'concepts'}/${segment(concept.id)}/` : base;
}

/** Project only authored bindings to native schema; never infer meaning from a name. */
export function databaseGraph(db, meaning, model, aliases = {}) {
  const records = model?.records ?? model?.entities ?? {};
  const moduleName = model?.module?.name;
  const tableModels = new Map();
  for (const table of db.tables) {
    const record = table.modelEntity ?? aliases[table.name] ?? table.name.replace(/[^A-Za-z0-9_]/g, '_');
    if (records[record]) {
      const matches = tableModels.get(record) ?? [];
      matches.push(table);
      tableModels.set(record, matches);
    }
  }
  const diagnostics = [];
  const candidates = (meaning?.concepts ?? []).flatMap((concept) => {
    const bindings = (concept.bindings ?? []).flatMap((binding) => {
      const prefix = `modelspec:///${moduleName}.`;
      if (!moduleName || !binding.model?.startsWith(prefix)) {
        diagnostics.push(`${concept.id}: binding ${binding.model} is outside the local model.`);
        return [];
      }
      const name = binding.model.slice(prefix.length);
      const matches = tableModels.get(name) ?? [];
      if (matches.length !== 1) {
        diagnostics.push(`${concept.id}: model record ${name} has no unique native table.`);
        return [];
      }
      const table = matches[0];
      const field = binding.property ?? binding.field;
      if (field && !table.columns.some((column) => column.name === field)) {
        diagnostics.push(`${concept.id}: field ${name}.${field} has no native column.`);
        return [];
      }
      return [{ table: table.name, ...(field ? { column: field } : {}), role: binding.role, ...(binding.note ? { note: binding.note } : {}) }];
    });
    return [{ id: concept.id, kind: concept.kind, label: concept.labels?.en ?? concept.id,
      description: concept.description ?? '', bindings,
      ...(concept.extends ? { extends: concept.extends } : {}),
      ...(concept['values-of'] ? { valuesOf: concept['values-of'] } : {}),
      definitionHref: registered.has(db.id) ? meaningGraphHref(db.sourceRepository, concept) : `${db.canonicalUrl}model/#concept-${segment(concept.id)}`,
      definitionLabel: registered.has(db.id) ? 'MeaningGraph definition' : 'Authored meaning',
    }];
  });
  const relevant = new Set(candidates.filter((concept) => concept.bindings.length).map((concept) => concept.id));
  let grew = true;
  while (grew) {
    grew = false;
    for (const concept of candidates) if (relevant.has(concept.id)) {
      for (const ref of [concept.extends, concept.valuesOf]) if (ref && !ref.includes('://') && !relevant.has(ref) && candidates.some((candidate) => candidate.id === ref)) { relevant.add(ref); grew = true; }
    }
  }
  const concepts = candidates.filter((concept) => relevant.has(concept.id));
  return { format: GRAPH_FORMAT, id: db.id, name: db.name, homepage: db.canonicalUrl,
    source: { repository: db.sourceRepository, revision: db.sourceCommit },
    meaningHref: registered.has(db.id) ? meaningGraphHref(db.sourceRepository) : 'https://meaninggraph.io/registry/',
    tables: db.tables.map(({ name, kind, description, columns, foreignKeys }) => ({ name, kind, description, columns: columns.map(({ name, type, primaryKey, nullable }) => ({ name, type, primaryKey, nullable })), foreignKeys })),
    concepts, diagnostics,
  };
}

export function graphAsset(graph) {
  const bytes = `${JSON.stringify(graph)}\n`;
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const path = `model/schema-graph.${sha256}.json`;
  const source = `${graph.homepage}${path}`;
  const href = new URL('https://codegrapher.dev/database');
  href.searchParams.set('source', source);
  href.searchParams.set('sha256', sha256);
  return { bytes, sha256, path, href: href.toString(), concepts: graph.concepts, meaningHref: graph.meaningHref, diagnostics: graph.diagnostics };
}
