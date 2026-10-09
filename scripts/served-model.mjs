// What a dataset's served ModelSpec files must look like. One definition for the
// Worker test (against the built files) and the live smoke check (against
// production), so the two cannot drift apart.
//
// Every dataset publishes its model in the current ModelSpec spelling: record
// types are `record` blocks (JSON: `records`), their members are `field`s, and
// the identifier is `1.0-draft-2`. The earlier spelling (`entity`, `property`,
// `entity =`; JSON `entities`, `properties`) must not appear: a reader accepts
// both and a file may mix them, so a half-rewritten model has to be refused here.

export const modelspecIdentifier = '1.0-draft-2';

// One record type per dataset and one member of it. The same member name also
// occurs in another record type of every dataset (for example Album.ArtistId),
// so a check that only looks for the member anywhere in the file proves nothing.
// `records` is the number of record types, which equals the dataset's tables.
// `hclNamesRevision` is true where the provider's header comment in the HCL file
// names the ModelSpec revision (Chinook and Northwind do; the four generated
// datasets write no revision into the HCL, so for them the JSON file carries it).
export const servedModels = {
  chinook: { record: 'Artist', field: 'ArtistId', records: 11, hclNamesRevision: true },
  northwind: { record: 'Categories', field: 'CategoryID', records: 13, hclNamesRevision: true },
  pubs: { record: 'authors', field: 'au_id', records: 11, hclNamesRevision: false },
  sakila: { record: 'actor', field: 'actor_id', records: 16, hclNamesRevision: false },
  adventureworks: { record: 'HumanResources_Department', field: 'DepartmentID', records: 71, hclNamesRevision: false },
  employees: { record: 'employees', field: 'emp_no', records: 6, hclNamesRevision: false },
};

export function servedModelPaths(id) {
  return { hcl: `/model/${id}.modelspec.hcl`, json: `/model/${id}.modelspec.json` };
}

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The text of one top-level record block: from its header line to the closing
// brace in column 0. Null when the file has no such record type.
export function recordBlock(hcl, name) {
  const lines = hcl.split('\n');
  const start = lines.findIndex((line) => line === `record "${name}" {`);
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && line === '}');
  return end < 0 ? null : lines.slice(start, end + 1).join('\n');
}

export function hclProblems(id, hcl) {
  const expected = servedModels[id];
  if (!expected) return [`${id}: no served-model expectation is defined`];
  const problems = [];
  const records = hcl.match(/^record "[^"]+" \{$/gm) ?? [];
  if (records.length !== expected.records) problems.push(`${id} HCL declares ${records.length} record types, expected ${expected.records}`);
  const block = recordBlock(hcl, expected.record);
  if (block === null) problems.push(`${id} HCL does not declare the ${expected.record} record type`);
  else if (!new RegExp(`^  field "${escape(expected.field)}" \\{$`, 'm').test(block)) problems.push(`${id} HCL does not declare ${expected.record}.${expected.field} inside its own record block`);
  if (expected.hclNamesRevision && !hcl.includes(`ModelSpec ${modelspecIdentifier}`)) problems.push(`${id} HCL does not name ModelSpec ${modelspecIdentifier}`);
  if (/^\s*(entity|property) "/m.test(hcl)) problems.push(`${id} HCL still has an entity or property block in the earlier spelling`);
  if (/^\s*entity\s*=/m.test(hcl)) problems.push(`${id} HCL still has an "entity =" reference in the earlier spelling`);
  return problems;
}

export function jsonProblems(id, text) {
  const expected = servedModels[id];
  if (!expected) return [`${id}: no served-model expectation is defined`];
  const problems = [];
  let model;
  try { model = JSON.parse(text); } catch { return [`${id} JSON is not valid JSON`]; }
  if (typeof model !== 'object' || model === null || Array.isArray(model)) return [`${id} JSON is not an object`];
  if (!text.includes(`"modelspec": "${modelspecIdentifier}"`)) problems.push(`${id} JSON does not say "modelspec": "${modelspecIdentifier}"`);
  if (model.modelspec !== modelspecIdentifier) problems.push(`${id} JSON modelspec is ${JSON.stringify(model.modelspec)}`);
  if (typeof model.records !== 'object' || model.records === null || Array.isArray(model.records)) problems.push(`${id} JSON has no records object`);
  else {
    const count = Object.keys(model.records).length;
    if (count !== expected.records) problems.push(`${id} JSON has ${count} records, expected ${expected.records}`);
    const fields = model.records[expected.record]?.fields;
    if (typeof fields !== 'object' || fields === null || !(expected.field in fields)) problems.push(`${id} JSON ${expected.record} has no ${expected.field} field`);
    for (const [name, record] of Object.entries(model.records)) {
      if (record && typeof record === 'object' && 'properties' in record) problems.push(`${id} JSON record ${name} still has the earlier "properties" key`);
    }
  }
  if ('entities' in model) problems.push(`${id} JSON still has the earlier "entities" key`);
  return problems;
}
