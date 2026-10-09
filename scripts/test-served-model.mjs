import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { hclProblems, jsonProblems, modelPageProblems, modelspecIdentifier, recordBlock, servedModelPaths, servedModels } from './served-model.mjs';

const root = new URL('..', import.meta.url).pathname;
const ids = Object.keys(servedModels);
const served = Object.fromEntries(await Promise.all(ids.map(async (id) => {
  const read = (path) => readFile(join(root, 'dist/_db', id, path.replace(/^\//, '')), 'utf8');
  return [id, { hcl: await read(servedModelPaths(id).hcl), json: await read(servedModelPaths(id).json), page: await read('model/index.html') }];
})));

// The earlier spelling of the same model, derived from the current one.
const earlierHcl = (hcl) => hcl
  .replace(/^record "/gm, 'entity "').replace(/^ {2}field "/gm, '  property "').replace(/^( {4})record = /gm, '$1entity = ')
  .replace(modelspecIdentifier, '1.0-draft');
const earlierJson = (text) => text
  .replace(`"modelspec": "${modelspecIdentifier}"`, '"modelspec": "1.0-draft"').replace('"records": {', '"entities": {').replace(/"fields": \{/g, '"properties": {');

test('every dataset serves a model in the current spelling', () => {
  for (const id of ids) {
    assert.deepEqual(hclProblems(id, served[id].hcl), [], `${id} HCL`);
    assert.deepEqual(jsonProblems(id, served[id].json), [], `${id} JSON`);
    assert.deepEqual(modelPageProblems(id, served[id].page), [], `${id} model page`);
  }
});

test('a correct model is accepted whatever its layout', () => {
  for (const id of ids) {
    assert.deepEqual(jsonProblems(id, JSON.stringify(JSON.parse(served[id].json))), [], `${id} JSON without whitespace`);
    assert.deepEqual(jsonProblems(id, JSON.stringify(JSON.parse(served[id].json), null, '\t')), [], `${id} JSON indented with tabs`);
    assert.deepEqual(hclProblems(id, served[id].hcl.replace(/\n/g, '\r\n')), [], `${id} HCL with CRLF line endings`);
  }
});

test('a member whose reference key is back to the earlier "entity" is refused', () => {
  for (const id of ids) {
    const model = JSON.parse(served[id].json);
    const references = Object.values(model.records).flatMap((record) => Object.values(record.fields)).filter((field) => 'record' in field);
    assert.ok(references.length > 0, `${id} has members that reference a record type`);
    const one = JSON.parse(served[id].json);
    const target = Object.values(one.records).flatMap((record) => Object.values(record.fields)).find((field) => 'record' in field);
    target.entity = target.record;
    delete target.record;
    assert.match(jsonProblems(id, JSON.stringify(one, null, 2)).join('\n'), /earlier "entity" reference key/, `${id} one member`);
    for (const field of references) { field.entity = field.record; delete field.record; }
    assert.match(jsonProblems(id, JSON.stringify(model, null, 2)).join('\n'), /earlier "entity" reference key/, `${id} every member`);
  }
});

test('the model page is judged by its heading, not by the letters elsewhere on it', () => {
  for (const id of ids) {
    const { records } = servedModels[id];
    const page = served[id].page;
    assert.match(page, new RegExp(`<h2[^>]*>${records} record types\\.</h2>`), `${id} page has its heading`);
    assert.deepEqual(modelPageProblems(id, page.replace('</body>', '<p>Identities and the legal-entities concept.</p></body>')), [], `${id} unrelated text containing "entities" is accepted`);
    assert.match(modelPageProblems(id, page.replace(`${records} record types.`, `${records} entities.`)).join('\n'), /no heading|earlier heading/, `${id} earlier wording`);
    assert.match(modelPageProblems(id, page.replace(`${records} record types.`, `${records + 10} record types.`)).join('\n'), /no heading/, `${id} wrong count`);
    assert.match(modelPageProblems(id, page.replace(`>${records} record types.<`, `>${records} record types. (${records} entities.)<`)).join('\n'), /no heading/, `${id} heading with extra text`);
    assert.match(modelPageProblems(id, page.replace('</body>', `<h2>${records} entities.</h2></body>`)).join('\n'), /earlier heading/, `${id} extra earlier heading beside the right one`);
    assert.notDeepEqual(modelPageProblems(id, ''), [], `${id} empty page`);
    for (const other of ids.filter((candidate) => candidate !== id && servedModels[candidate].records !== records)) {
      assert.notDeepEqual(modelPageProblems(id, served[other].page), [], `${id} given ${other}'s page`);
    }
  }
});

test('the checked record type and member are real, and the member name is shared with another record type', () => {
  for (const id of ids) {
    const { record, field } = servedModels[id];
    const block = recordBlock(served[id].hcl, record);
    assert.ok(block, `${id} has ${record}`);
    assert.ok(block.includes(`  field "${field}" {`), `${id} ${record} has ${field}`);
    assert.ok(served[id].hcl.split(`  field "${field}" {`).length > 2, `${id}: ${field} also occurs in another record type, so a file-wide search would prove nothing`);
  }
});

test('an empty file, the previous spelling and another dataset\'s file fail for every dataset', () => {
  for (const id of ids) {
    assert.notDeepEqual(hclProblems(id, ''), [], `${id} empty HCL`);
    assert.notDeepEqual(jsonProblems(id, ''), [], `${id} empty JSON`);
    assert.notDeepEqual(hclProblems(id, earlierHcl(served[id].hcl)), [], `${id} previous HCL`);
    assert.notDeepEqual(jsonProblems(id, earlierJson(served[id].json)), [], `${id} previous JSON`);
    for (const other of ids.filter((candidate) => candidate !== id)) {
      assert.notDeepEqual(hclProblems(id, served[other].hcl), [], `${id} given ${other}'s HCL`);
      assert.notDeepEqual(jsonProblems(id, served[other].json), [], `${id} given ${other}'s JSON`);
    }
  }
});

test('the member must be inside the named record type, not in another record type', () => {
  for (const id of ids) {
    const { record, field } = servedModels[id];
    const block = recordBlock(served[id].hcl, record);
    const renamed = served[id].hcl.replace(block, block.replace(`  field "${field}" {`, '  field "Renamed" {'));
    assert.notEqual(renamed, served[id].hcl);
    assert.match(hclProblems(id, renamed).join('\n'), new RegExp(`does not declare ${record}\\.${field} inside its own record block`), `${id} another record type's ${field} must not satisfy the check`);
    const json = JSON.parse(served[id].json);
    json.records[record].fields.Renamed = json.records[record].fields[field];
    delete json.records[record].fields[field];
    assert.notDeepEqual(jsonProblems(id, JSON.stringify(json, null, 2)), [], `${id} JSON without ${record}.${field}`);
  }
});

test('a leftover earlier-spelling member or block is refused', () => {
  for (const id of ids) {
    const { field } = servedModels[id];
    const member = served[id].hcl.match(new RegExp(`^  field "(?!${field}")[^"]+" \\{$`, 'm'))[0];
    const mixed = served[id].hcl.replace(member, member.replace('field', 'property'));
    assert.match(hclProblems(id, mixed).join('\n'), /earlier spelling/, `${id} one property member among field members`);
    assert.match(hclProblems(id, `${served[id].hcl}\nentity "Legacy" {\n}\n`).join('\n'), /earlier spelling/, `${id} appended entity block`);
    const reference = served[id].hcl.match(/^( {4})record = /m);
    if (reference) assert.match(hclProblems(id, served[id].hcl.replace(reference[0], `${reference[1]}entity = `)).join('\n'), /entity =/, `${id} entity = reference`);
  }
});

test('where the HCL names its ModelSpec revision, naming the earlier one is refused', () => {
  for (const id of ids.filter((candidate) => servedModels[candidate].hclNamesRevision)) {
    assert.ok(served[id].hcl.includes(`ModelSpec ${modelspecIdentifier}`), `${id} HCL names the revision`);
    assert.match(hclProblems(id, served[id].hcl.replace(`ModelSpec ${modelspecIdentifier}`, 'ModelSpec 1.0-draft')).join('\n'), /does not name ModelSpec/, `${id} reverted identifier`);
  }
  for (const id of ids.filter((candidate) => !servedModels[candidate].hclNamesRevision)) {
    assert.ok(!served[id].hcl.includes('1.0-draft'), `${id} HCL names no revision, so none is asserted`);
  }
});

test('the served JSON must say 1.0-draft-2 and use records', () => {
  for (const id of ids) {
    const json = served[id].json;
    assert.match(jsonProblems(id, json.replace(`"modelspec": "${modelspecIdentifier}"`, '"modelspec": "1.0-draft"')).join('\n'), /modelspec/, `${id} identifier`);
    assert.match(jsonProblems(id, json.replace('"records": {', '"entities": {')).join('\n'), /records|entities/, `${id} entities key`);
    const withBoth = JSON.parse(json);
    withBoth.entities = {};
    assert.match(jsonProblems(id, JSON.stringify(withBoth, null, 2)).join('\n'), /"entities"/, `${id} both keys`);
    const withProperties = JSON.parse(json);
    withProperties.records[servedModels[id].record].properties = {};
    assert.match(jsonProblems(id, JSON.stringify(withProperties, null, 2)).join('\n'), /"properties"/, `${id} properties key`);
  }
});
