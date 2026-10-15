// How the live smoke reads the public corpus manifest (public/corpus.json). The manifest's
// database-level `exports` carry `format`, `url`, `bytes` and, for gzip assets, `decodedBytes`;
// they do not carry the registry-internal `publicPath`, so look exports up by format.
export function corpusExport(corpus, localId, format) {
  return corpus.databases?.find((item) => item.localId === localId)?.exports?.find((item) => item.format === format);
}

// The decoded size the live smoke compares a served download against, or throws if the
// manifest cannot describe it.
export function decodedExportBytes(corpus, localId, format) {
  const item = corpusExport(corpus, localId, format);
  if (!Number.isSafeInteger(item?.decodedBytes) || item.decodedBytes <= 0) {
    throw new Error(`${localId}: corpus metadata lacks the decoded ${format.toUpperCase()} export size`);
  }
  return item.decodedBytes;
}
