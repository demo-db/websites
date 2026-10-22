// Shared normalizer for immutable provider declarations; deployment receipt is explicit.
export function providerAvailability(manifest, establishedPublicProvider = false) {
  const declared = manifest.capabilities?.ovdb;
  const deploymentVerified = declared?.deploymentVerified === true || establishedPublicProvider;
  return {
    declaredAvailable: declared?.available === true,
    deploymentVerified,
    available: declared?.available === true && deploymentVerified,
    readOnly: declared?.readOnly !== false,
    declaredQuery: declared?.query === true,
    query: declared?.query === true && deploymentVerified,
  };
}
