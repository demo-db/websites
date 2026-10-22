export type StorageEntry = {
  id: string;
  engine: 'SQLite' | 'PostgreSQL' | 'inGitDB' | 'BigQuery';
  tags: string[];
  readiness: 'public-api' | 'hosted-api-pending' | 'hosted-repository' | 'public-read-user-project-required';
  apiUrl?: string;
  repositoryUrl?: string;
  manifestUrl?: string;
  revision?: string;
  nativeOriginal?: boolean;
  sourceProjectId?: string;
  datasetId?: string;
  location?: string;
  executionProject?: 'user-selected';
  tableCount?: number;
  rowCount?: number;
  sourceRepository?: string;
  sourceRevision?: string;
  sourceSqliteSha256?: string;
  verificationUrl?: string;
};

export type CallableReadOnlyCapability = { deploymentVerified: boolean; available: boolean; query: boolean; readOnly: boolean };

export function hasCallableReadOnlyApi(capability: CallableReadOnlyCapability): boolean {
  return capability.deploymentVerified === true && capability.available === true && capability.query === true && capability.readOnly === true;
}

export function inGitDBStorageEntry(localId: string, revision: string, nativeOriginal: boolean, capability: CallableReadOnlyCapability, apiUrl: string, manifestUrl: string): StorageEntry {
  const publicApi = nativeOriginal && hasCallableReadOnlyApi(capability);
  return {
    id: `${localId}-ingitdb`, engine: 'inGitDB', tags: [localId, 'ingitdb', 'github'],
    readiness: publicApi ? 'public-api' : 'hosted-repository', nativeOriginal,
    ...(publicApi ? { apiUrl } : {}),
    repositoryUrl: `https://github.com/demo-db/${localId}/tree/${revision}/ingitdb`,
    manifestUrl,
    revision,
  };
}
