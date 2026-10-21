export const RELATED_DATABASES_FORMAT = 'demodb-related-databases/v1';

const ID = /^[a-z][a-z0-9-]{0,63}$/;

export function projectRelatedDatabases(document, databases) {
  const problems = [];
  if (document?.format !== RELATED_DATABASES_FORMAT) problems.push(`format must be ${RELATED_DATABASES_FORMAT}`);
  if (!Array.isArray(document?.relationships)) problems.push('relationships must be a list');
  const databaseById = new Map(databases.map((database) => [database.id, database]));
  const relationshipIds = new Set();
  const endpointPairs = new Set();
  const projected = new Map(databases.map((database) => [database.id, []]));

  for (const relationship of document?.relationships ?? []) {
    if (!ID.test(relationship?.id ?? '')) problems.push(`invalid relationship id ${JSON.stringify(relationship?.id)}`);
    else if (relationshipIds.has(relationship.id)) problems.push(`duplicate relationship id ${relationship.id}`);
    else relationshipIds.add(relationship.id);
    if (relationship?.kind !== 'synthetic-companion') problems.push(`${relationship?.id}: unsupported kind ${JSON.stringify(relationship?.kind)}`);
    if (typeof relationship?.label !== 'string' || !relationship.label.trim()) problems.push(`${relationship?.id}: label is required`);
    if (typeof relationship?.description !== 'string' || relationship.description.trim().length < 30) problems.push(`${relationship?.id}: description must be specific`);
    if (!Array.isArray(relationship?.endpoints) || relationship.endpoints.length !== 2) {
      problems.push(`${relationship?.id}: exactly two endpoints are required`);
      continue;
    }
    const [left, right] = relationship.endpoints;
    if (left.database === right.database) problems.push(`${relationship.id}: self relationships are not allowed`);
    const canonicalPair = relationship.endpoints.map((endpoint) => `${endpoint.database}/${endpoint.recordset}/${endpoint.field}`).sort().join('\0');
    if (endpointPairs.has(canonicalPair)) problems.push(`${relationship.id}: duplicate endpoint pair`);
    else endpointPairs.add(canonicalPair);

    for (const endpoint of relationship.endpoints) {
      const database = databaseById.get(endpoint.database);
      if (!database) {
        problems.push(`${relationship.id}: unknown database ${endpoint.database}`);
        continue;
      }
      const recordset = database.tables.find((item) => item.name === endpoint.recordset);
      if (!recordset) {
        problems.push(`${relationship.id}: unknown recordset ${endpoint.database}.${endpoint.recordset}`);
        continue;
      }
      if (!recordset.columns.some((column) => column.name === endpoint.field)) {
        problems.push(`${relationship.id}: unknown field ${endpoint.database}.${endpoint.recordset}.${endpoint.field}`);
      }
    }
    if (relationship.endpoints.every((endpoint) => databaseById.has(endpoint.database))) {
      for (const [source, target] of [[left, right], [right, left]]) {
        projected.get(source.database).push({
          id: relationship.id,
          kind: relationship.kind,
          label: relationship.label,
          description: relationship.description,
          databaseId: target.database,
          local: { recordset: source.recordset, field: source.field },
          remote: { recordset: target.recordset, field: target.field },
        });
      }
    }
  }
  if (problems.length) throw new Error(`config/related-databases.json is invalid:\n  ${problems.join('\n  ')}`);
  for (const relationships of projected.values()) relationships.sort((a, b) => a.databaseId.localeCompare(b.databaseId) || a.id.localeCompare(b.id));
  return projected;
}
