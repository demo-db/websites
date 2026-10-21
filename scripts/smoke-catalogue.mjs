// Validate the rendered catalogue against the same capability-gated inventory used by Astro.
// This module has no network effects; smoke-live owns the one-request-per-URL budget.
export function catalogueProblems(body, groups) {
  const problems = [];
  const entries = groups.flatMap(({ storages }) => storages);
  const publicCount = entries.filter(({ readiness }) => readiness === 'public-api').length;
  const text = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  if (!text.includes(`${groups.length} datasets across ${entries.length} storage editions.`)) problems.push('storage summary differs from runtime inventory');
  if (!text.includes(`${publicCount} public OVDB APIs`)) problems.push('public API count differs from admitted capabilities');
  const links = [...body.matchAll(/<a\b[^>]*href="(\/ovdb\/db\/[^"/]+\/)"[^>]*>([\s\S]*?)<\/a>/g)];
  const expected = entries.map(({ id }) => `/ovdb/db/${id}/`).sort();
  if (JSON.stringify(links.map(([, href]) => href).sort()) !== JSON.stringify(expected)) problems.push('storage links differ from runtime inventory');
  for (const entry of entries) {
    const anchor = links.find(([, href]) => href === `/ovdb/db/${entry.id}/`)?.[2] ?? '';
    const label = entry.readiness === 'public-api' ? 'Public read-only API'
      : entry.readiness === 'hosted-repository' ? 'Published on GitHub · query locally'
      : entry.readiness === 'public-read-user-project-required' ? 'BigQuery · Google sign-in and your execution project required'
      : `${entry.engine} edition · public API pending`;
    if (!anchor.includes(label)) problems.push(`${entry.id}: readiness label differs from runtime capability`);
    if (entry.readiness !== 'public-api' && anchor.includes('Public read-only API')) problems.push(`${entry.id}: unverified public API advertised`);
  }
  const postgres = entries.filter(({ engine }) => engine === 'PostgreSQL');
  const postgresVerified = postgres.length > 0 && postgres.every(({ readiness }) => readiness === 'public-api');
  if (postgresVerified
    ? !text.includes('PostgreSQL copies are hosted on Neon with separate public read-only DTQL endpoints') || text.includes('public API access pending')
    : !text.includes('PostgreSQL copies have public API access pending') || text.includes('Neon')) problems.push('PostgreSQL introduction differs from admitted capabilities');
  if (!body.includes('demodb-dev') || !body.includes('your own execution project')) problems.push('BigQuery execution requirements missing');
  return problems;
}

export function storagePageProblems(body, storage) {
  const problems = [];
  if (!body.includes(`https://demodb.dev/ovdb/db/${storage.id}/`)) problems.push('canonical storage URL missing');
  if (storage.readiness === 'public-api') {
    if (!body.includes('Open read-only API')) problems.push('admitted API link missing');
    if (storage.engine === 'PostgreSQL' && (!body.includes(storage.apiUrl) || !body.includes('does not expose the SQLite snapshot’s immutable build pin or a general SQL query endpoint'))) problems.push('PostgreSQL API contract missing');
  } else {
    if (body.includes('Open read-only API')) problems.push('unverified API advertised');
    if (storage.readiness === 'hosted-api-pending' && !body.includes('Public OpenVaultDB API access is being prepared')) problems.push('pending API state missing');
    if (storage.readiness === 'hosted-repository' && (!body.includes('Browse inGitDB files') || !body.includes('ingitdb validate --path ingitdb') || !body.includes(storage.repositoryUrl))) problems.push('pinned inGitDB repository instructions missing');
    if (storage.readiness === 'public-read-user-project-required' && (!body.includes('demodb-dev') || !body.includes('your own Google Cloud execution project') || !body.includes('does not execute or proxy SQL') || !body.includes('DataTug browser query execution is not enabled yet') || body.includes('Database descriptor'))) problems.push('BigQuery capability limits missing');
  }
  if (storage.id === 'shipping-logs-ingitdb' && (!body.includes('three native inGitDB collections') || !body.includes('No SQLite database, parsed snapshot, parity report, or source-name map is claimed'))) problems.push('native original log provenance missing');
  return problems;
}
