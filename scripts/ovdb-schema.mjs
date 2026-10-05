import Ajv2020 from 'ajv/dist/2020.js';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
const [databaseSchema, serverSchema] = await Promise.all([
  readFile(join(root, 'schemas/ovdb-database-draft-1.schema.json'), 'utf8').then(JSON.parse),
  readFile(join(root, 'schemas/ovdb-server-draft-1.schema.json'), 'utf8').then(JSON.parse),
]);
const validateDatabaseSchema = ajv.compile(databaseSchema);
const validateServerSchema = ajv.compile(serverSchema);

export function isDatabaseDescriptorShape(value) {
  return Boolean(validateDatabaseSchema(value));
}

export function validateDatabaseDescriptor(value, localId) {
  if (!validateDatabaseSchema(value)) throw new Error(`Invalid ${localId} OVDB descriptor: ${ajv.errorsText(validateDatabaseSchema.errors)}`);
  if (value.localId !== localId
    || value.id !== `https://demodb.dev/${localId}/`
    || value.serverId !== 'https://demodb.dev/ovdb'
    || value.serverDbBaseUrl !== `https://demodb.dev/ovdb/db/${localId}/`
    || value.homepage !== `https://${localId}.demodb.dev/`
    || value.apiUrl !== `https://demodb.dev/ovdb/v1/databases/${localId}`) {
    throw new Error(`${localId}: OVDB descriptor identity/API does not match the central route`);
  }
  if (value.capabilities.read !== true || value.capabilities.write !== false) throw new Error(`${localId}: DemoDB only exposes read-only databases`);
  for (const urlValue of [value.id, value.serverId, value.serverDbBaseUrl, value.homepage, value.apiUrl, value.deployment.url, value.deployment.discovery, value.model.url, value.model.hclUrl, value.meaning.url, value.publisher.url, value.publisher.repository, value.provenance.repository, value.schemaUrl].filter(Boolean)) {
    const url = new URL(urlValue);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) throw new Error(`${localId}: invalid public URL ${urlValue}`);
  }
  if (value.deployment.url !== `https://cloud.openvaultdb.com/ovdb/dbs/${localId}`
    || value.deployment.discovery !== 'https://demodb.dev/.well-known/openvaultdb') throw new Error(`${localId}: deployment endpoints do not match the shared OVDB service`);
  const publicModel = new URL(value.model.url);
  const publicMeaning = new URL(value.meaning.url);
  if (publicModel.hostname !== `${localId}.demodb.dev` || !publicModel.pathname.startsWith('/model/')
    || publicMeaning.hostname !== `${localId}.demodb.dev` || !publicMeaning.pathname.startsWith('/model/')) {
    throw new Error(`${localId}: model/meaning references must target published model assets on the database site`);
  }
  const names = value.recordsets.map((recordset) => recordset.name);
  if (new Set(names).size !== names.length) throw new Error(`${localId}: OVDB descriptor has duplicate native recordset names`);
  for (const recordset of value.recordsets) {
    for (const column of recordset.columns) {
      if (column.decimal && (column.decimal.scale > column.decimal.precision || column.decimal.storage !== 'text')) {
        throw new Error(`${localId}: invalid exact-decimal metadata for ${recordset.name}.${column.name}`);
      }
    }
  }
  for (const reference of [value.model, value.meaning]) {
    if (!new URL(reference.url).hostname.endsWith('.demodb.dev')) throw new Error(`${localId}: semantic reference must point to a public DemoDB URL`);
  }
  return value;
}

export function validateServerDescriptor(value) {
  if (!validateServerSchema(value)) throw new Error(`Invalid OVDB server descriptor: ${ajv.errorsText(validateServerSchema.errors)}`);
  const ids = new Set();
  const localIds = new Set();
  for (const database of value.databases) {
    if (ids.has(database.id) || localIds.has(database.localId)) throw new Error('OVDB server descriptor has duplicate database identities');
    ids.add(database.id);
    localIds.add(database.localId);
    if (database.id !== `https://demodb.dev/${database.localId}/`
      || database.serverDbBaseUrl !== `https://demodb.dev/ovdb/db/${database.localId}/`
      || database.manifestUrl !== `${database.serverDbBaseUrl}ovdb-database.json`
      || database.apiUrl !== `https://demodb.dev/ovdb/v1/databases/${database.localId}`) {
      throw new Error(`OVDB server descriptor has inconsistent routes for ${database.localId}`);
    }
  }
  return value;
}
