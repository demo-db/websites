import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasCallableReadOnlyApi, inGitDBStorageEntry } from '../src/data/storage-entry';

test('native source API admission requires all actual normalized capabilities', () => {
  for (const nativeOriginal of [false, true]) for (const verified of [false, true])
  for (const available of [false, true]) for (const query of [false, true]) for (const readOnly of [false, true]) {
    const capability = { deploymentVerified: verified, available, query, readOnly };
    const manifestUrl = `https://github.com/demo-db/neutral-native/blob/${'a'.repeat(40)}/source-info.json`;
    const apiUrl = 'https://demodb.dev/ovdb/v1/databases/neutral-native';
    const entry = inGitDBStorageEntry('neutral-native', 'a'.repeat(40), nativeOriginal, capability, apiUrl, manifestUrl);
    assert.equal(hasCallableReadOnlyApi(capability), verified && available && query && readOnly);
    const admitted = nativeOriginal && verified && available && query && readOnly;
    assert.equal(entry.readiness, admitted ? 'public-api' : 'hosted-repository');
    assert.equal(entry.apiUrl, admitted ? apiUrl : undefined);
    assert.equal(entry.manifestUrl, manifestUrl);
    assert.equal(entry.revision, 'a'.repeat(40));
    assert.equal(entry.repositoryUrl, `https://github.com/demo-db/neutral-native/tree/${'a'.repeat(40)}/ingitdb`);
  }
});

test('verified deployment cannot advertise undeclared, nonquery or writable native sources', () => {
  const actual = { deploymentVerified: true, available: true, query: true, readOnly: true };
  for (const missing of ['available', 'query', 'readOnly'] as const) {
    const entry = inGitDBStorageEntry('another-source', 'b'.repeat(40), true,
      { ...actual, [missing]: false }, 'https://demodb.dev/ovdb/v1/databases/another-source',
      'https://github.com/demo-db/another-source/blob/pin/metadata/origin.json');
    assert.equal(entry.readiness, 'hosted-repository', missing);
    assert.equal(Object.hasOwn(entry, 'apiUrl'), false, missing);
    assert.match(entry.manifestUrl!, /metadata\/origin\.json$/);
  }
});
