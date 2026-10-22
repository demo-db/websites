import assert from 'node:assert/strict';
import { test } from 'node:test';
import { providerAvailability } from './provider-availability.mjs';

test('new provider declarations require explicit verified deployment before callable admission', () => {
  for (const declaration of [undefined, false, 'true']) {
    const result = providerAvailability({ capabilities: { ovdb: { available: true, query: true, deploymentVerified: declaration } } });
    assert.deepEqual(result, { declaredAvailable: true, deploymentVerified: false, available: false, readOnly: true, declaredQuery: true, query: false });
  }
  assert.deepEqual(providerAvailability({ capabilities: { ovdb: { available: true, query: true, deploymentVerified: true } } }),
    { declaredAvailable: true, deploymentVerified: true, available: true, readOnly: true, declaredQuery: true, query: true });
});

test('verified deployment cannot create undeclared read/query capabilities; established-provider compatibility stays bounded', () => {
  const undeclared = providerAvailability({ capabilities: { ovdb: { deploymentVerified: true } } });
  assert.equal(undeclared.available, false);
  assert.equal(undeclared.query, false);
  const existing = providerAvailability({ capabilities: { ovdb: { available: true, query: false } } }, true);
  assert.equal(existing.available, true);
  assert.equal(existing.query, false);
  assert.equal(providerAvailability({}).deploymentVerified, false);
});
