// Providers currently pin immutable draft-1 schema copies. Accept the previous
// published schemas and additive decimal/tag revisions while preserving
// checksum and descriptor validation; every other schema revision must be
// regenerated and reviewed explicitly.
export const compatibleProviderSchemaSha256 = new Set([
  '2424ef00acd462ab5a8abc546fe2d1fffbbb5397e312332aedc77b3e73109488',
  '5c3acdf1b858f45a78558555e92255f847fb54d8d1bcbef5567c89bdff77758d',
  '4af5dc5f48bce1bc2ba5cb6664dd2c28adcadd818c74da0e78fe428f6f6ec55b',
]);

export function isCompatibleProviderSchema(sha256) {
  return compatibleProviderSchemaSha256.has(sha256);
}
