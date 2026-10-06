import assert from 'node:assert/strict';
import test from 'node:test';
import { isCompatibleProviderSchema } from './provider-schema-compat.mjs';

test('accepts only the current additive schema and prior pinned draft-1 schema', () => {
  assert.equal(isCompatibleProviderSchema('2424ef00acd462ab5a8abc546fe2d1fffbbb5397e312332aedc77b3e73109488'), true, 'existing provider pins remain buildable');
  assert.equal(isCompatibleProviderSchema('5c3acdf1b858f45a78558555e92255f847fb54d8d1bcbef5567c89bdff77758d'), true, 'new exact-decimal provider pins are accepted');
  assert.equal(isCompatibleProviderSchema('4af5dc5f48bce1bc2ba5cb6664dd2c28adcadd818c74da0e78fe428f6f6ec55b'), true, 'tagged provider schema pins are accepted');
  assert.equal(isCompatibleProviderSchema('f'.repeat(64)), false, 'unknown schema revisions fail closed');
});
