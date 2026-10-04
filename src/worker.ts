import runtime from './data/generated/runtime.json';
import providerIndex from './data/generated/index.json';
import ovdbIndex from './data/generated/ovdb.json';

type Runtime = {
  catalogueHost: string;
  wwwCatalogueHost: string;
  databaseHosts: Record<string, string>;
  legacyAliases: Record<string, string>;
  databaseIds: string[];
};

type Database = {
  id: string;
  name: string;
  siteHost: string;
  tables: { name: string }[];
  ovdb: { url: string; deploymentUrl: string; connection: string; available: boolean; readOnly: boolean; query: boolean };
};
type Env = {
  ASSETS: { fetch(request: Request): Promise<Response> };
  ENABLE_LEGACY_REDIRECTS?: string;
  LOCAL_DB_HOSTS?: string;
  LOCAL_CATALOGUE_HOSTS?: string;
};

type OVDBManifest = { id: string; localId: string; apiUrl: string; capabilities: { query: boolean }; deployment: { url: string }; [key: string]: unknown };

const sites = runtime as Runtime;
const databaseList = providerIndex.databases as Database[];
const databases = new Map(databaseList.map((database) => [database.id, database]));
const ovdbDatabases = new Map((ovdbIndex.databases as OVDBManifest[]).map((database) => [database.localId, database]));
const ovdbApiOrigin = 'https://cloud.openvaultdb.com';
const contentTypes: Record<string, string> = {
  '.sqlite': 'application/vnd.sqlite3', '.db': 'application/vnd.sqlite3', '.sql': 'application/sql; charset=utf-8',
  '.yaml': 'application/yaml; charset=utf-8', '.yml': 'application/yaml; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.hcl': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();
    if (unsafePath(url.pathname)) return new Response('Bad Request', { status: 400, headers: securityHeaders() });

    const localDb = localDatabase(host, env.LOCAL_DB_HOSTS);
    const localCatalogue = localCatalogueHost(host, env.LOCAL_CATALOGUE_HOSTS);
    const databaseId = sites.databaseHosts[host] ?? localDb;
    const catalogue = host === sites.catalogueHost || host === sites.wwwCatalogueHost || localCatalogue;

    const aliasId = sites.legacyAliases[host];
    if (aliasId) {
      const aliasDatabase = databases.get(aliasId);
      if (env.ENABLE_LEGACY_REDIRECTS !== 'true' || !aliasDatabase) return notFound();
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });
      const apiAlias = /^\/ovdb\/v1\/databases\/([a-z][a-z0-9-]{0,39})(?:\/.*)?$/.exec(url.pathname);
      if (apiAlias && ovdbDatabases.has(apiAlias[1])) return redirectPreservingRequest(request, `https://demodb.dev${url.pathname}${url.search}`);
      const profileAlias = /^\/ovdb\/(?:dbs|db)\/([a-z][a-z0-9-]{0,39})\/?$/.exec(url.pathname);
      if (profileAlias && ovdbDatabases.has(profileAlias[1])) return redirectPreservingRequest(request, `https://demodb.dev/${profileAlias[1]}/${url.search}`);
      return redirectPreservingRequest(request, `https://${aliasDatabase.siteHost}${url.pathname}${url.search}`);
    }

    if (!catalogue && !databaseId) return notFound();
    if (catalogue && host === sites.wwwCatalogueHost) return redirectPreservingRequest(request, `https://${sites.catalogueHost}${url.pathname}${url.search}`);
    if (decodedPathname(url.pathname).toLowerCase().startsWith('/_db/')) return notFound();
    if (url.pathname === '/build-info.json') return serveAsset(request, env, url, '/build-info.json');
    if (url.pathname === '/robots.txt' || url.pathname === '/sitemap.xml') {
      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
      const db = databaseId ? databases.get(databaseId) : undefined;
      return hostMetadata(request.method, host, url.pathname, db);
    }

    if (catalogue) {
      if (url.pathname === '/.well-known/openvaultdb') return serverDiscovery(request);
      if (url.pathname.startsWith('/data/') || url.pathname.startsWith('/model/')) return notFound();
      if (url.pathname === '/ovdb/v1' || url.pathname === '/ovdb/v1/') return serverApiIndex(request);
      if (url.pathname.startsWith('/ovdb/v1/')) return proxyOVDB(request, url);
      const legacyDbRoute = /^\/ovdb\/(?:dbs\/([a-z][a-z0-9-]{0,39})\/?|db\/([a-z][a-z0-9-]{0,39}))$/.exec(url.pathname);
      const legacyDbId = legacyDbRoute?.[1] ?? legacyDbRoute?.[2];
      if (legacyDbId && ovdbDatabases.has(legacyDbId)) {
        if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
        return redirectPreservingRequest(request, `https://demodb.dev/${legacyDbId}/${url.search}`);
      }
      if (url.pathname.startsWith('/ovdb/db/')) {
        const id = /^\/ovdb\/db\/([a-z][a-z0-9-]{0,39})\//.exec(url.pathname)?.[1];
        if (!id || !ovdbDatabases.has(id)) return notFound();
      }
      if (/^\/[a-z][a-z0-9-]{0,39}\/ovdb-database\.json$/.test(url.pathname)) {
        const id = url.pathname.split('/')[1];
        if (!ovdbDatabases.has(id)) return notFound();
      }
      if (request.method === 'OPTIONS' && isOVDBPublicJson(url.pathname)) return new Response(null, { status: 204, headers: readonlyCorsHeaders() });
      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
      const target = url.pathname === '/' ? '/index.html'
        : url.pathname === '/ovdb' || url.pathname === '/ovdb/' ? '/ovdb/index.html'
          : /^\/[a-z][a-z0-9-]{0,39}\/$/.test(url.pathname) ? `${url.pathname}index.html`
            : /^\/ovdb\/db\/[a-z][a-z0-9-]{0,39}\/$/.test(url.pathname) ? `${url.pathname}index.html`
              : url.pathname;
      const response = await serveAsset(request, env, url, target);
      return isOVDBPublicJson(url.pathname) ? withDataHeaders(response, request.method) : response;
    }

    const db = databaseId ? databases.get(databaseId) : undefined;
    if (!db) return notFound();
    if (url.pathname === '/.well-known/openvaultdb') return discovery(request, db);
    if (url.pathname === '/ovdb' || url.pathname === '/ovdb/' || url.pathname.startsWith('/ovdb/')) return redirectOvdb(request, url, db);
    const isPublicData = isDataPath(url.pathname);
    if (request.method === 'OPTIONS' && isPublicData) return new Response(null, { status: 204, headers: readonlyCorsHeaders() });
    if (isPublicData && request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method Not Allowed', { status: 405, headers: { ...readonlyCorsHeaders(), Allow: 'GET, HEAD, OPTIONS' } });
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });

    const target = internalAssetPath(db.id, url.pathname);
    const response = await serveAsset(request, env, url, target);
    if (isPublicData) return withDataHeaders(response, request.method);
    return response;
  },
};

export function resolveHost(hostname: string, env: Pick<Env, 'LOCAL_DB_HOSTS' | 'LOCAL_CATALOGUE_HOSTS'> = {}) {
  const host = hostname.toLowerCase();
  return {
    databaseId: sites.databaseHosts[host] ?? localDatabase(host, env.LOCAL_DB_HOSTS),
    catalogue: host === sites.catalogueHost || host === sites.wwwCatalogueHost || localCatalogueHost(host, env.LOCAL_CATALOGUE_HOSTS),
    legacyDatabaseId: sites.legacyAliases[host],
  };
}

export function internalAssetPath(databaseId: string, pathname: string): string {
  if (!sites.databaseIds.includes(databaseId)) return '/404.html';
  if (pathname === '/') return `/_db/${databaseId}/index.html`;
  if (pathname === '/schema.json') return `/_db/${databaseId}/metadata/schema.json`;
  if (pathname.startsWith('/data/')) return `/_db/${databaseId}/data/${pathname.slice('/data/'.length)}`;
  if (pathname === '/data') return `/_db/${databaseId}/data/index.html`;
  if (pathname === '/model/') return `/_db/${databaseId}/model/index.html`;
  if (pathname.startsWith('/model/')) return `/_db/${databaseId}/model/${pathname.slice('/model/'.length)}`;
  if (pathname.startsWith('/_db/')) return '/404.html';
  if (pathname === '/embed/datatug.js' || pathname.startsWith('/_astro/') || pathname === '/favicon.svg') return pathname;
  const suffix = pathname.endsWith('/') ? 'index.html' : `${pathname.split('/').at(-1)?.includes('.') ? '' : '/index.html'}`;
  return `/_db/${databaseId}${pathname}${suffix}`;
}

function localDatabase(host: string, value?: string): string | undefined {
  const parsed = parseLocalMap(value);
  const id = parsed[host];
  return id && sites.databaseIds.includes(id) ? id : undefined;
}

function localCatalogueHost(host: string, value?: string): boolean {
  if (!value) return host === 'localhost' || host === '127.0.0.1';
  try { return (JSON.parse(value) as unknown[]).some((candidate) => candidate === host); }
  catch { return false; }
}

function parseLocalMap(value?: string): Record<string, string> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).filter(([host, id]) => /^[a-z0-9.-]+$/.test(host) && typeof id === 'string')) as Record<string, string>;
  } catch { return {}; }
}

function unsafePath(pathname: string): boolean {
  if (/%2f|%5c|%00/i.test(pathname)) return true;
  for (const raw of pathname.split('/')) {
    let segment: string;
    try { segment = decodeURIComponent(raw); } catch { return true; }
    if (segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\') || segment.includes('\0') || segment.includes('%')) return true;
  }
  return false;
}

function decodedPathname(pathname: string): string {
  return pathname.split('/').map((segment) => decodeURIComponent(segment)).join('/');
}

function leaksPrivatePath(location: string, originalUrl: URL): boolean {
  try { return decodedPathname(new URL(location, originalUrl).pathname).toLowerCase().startsWith('/_db/'); }
  catch { return true; }
}

function isDataPath(pathname: string): boolean {
  return pathname === '/data' || pathname.startsWith('/data/') || pathname === '/schema.json' || (pathname.startsWith('/model/') && pathname !== '/model/' && /\.[a-z0-9]+$/i.test(pathname));
}

async function serveAsset(request: Request, env: Env, originalUrl: URL, targetPath: string): Promise<Response> {
  const target = new URL(originalUrl);
  target.pathname = targetPath;
  const assetRequest = new Request(target, request);
  const asset = await env.ASSETS.fetch(assetRequest);
  if (asset.status === 404 || asset.status === 403) return notFound();
  const location = asset.headers.get('Location');
  if (location && leaksPrivatePath(location, originalUrl)) return notFound();
  const headers = new Headers(asset.headers);
  for (const [name, value] of Object.entries(securityHeaders())) headers.set(name, value);
  const extension = originalUrl.pathname.slice(originalUrl.pathname.lastIndexOf('.')).toLowerCase();
  if (contentTypes[extension] && isDataPath(originalUrl.pathname)) headers.set('Content-Type', contentTypes[extension]);
  return new Response(request.method === 'HEAD' ? null : asset.body, { status: asset.status, statusText: asset.statusText, headers });
}

function withDataHeaders(response: Response, method: string): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(readonlyCorsHeaders())) headers.set(name, value);
  headers.set('Cache-Control', 'public, max-age=300, must-revalidate');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(method === 'HEAD' ? null : response.body, { status: response.status, statusText: response.statusText, headers });
}

function discovery(request: Request, db: Database): Response {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: readonlyCorsHeaders() });
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method Not Allowed', { status: 405, headers: { ...readonlyCorsHeaders(), Allow: 'GET, HEAD, OPTIONS' } });
  const body = JSON.stringify({
    name: `${db.name} OVDB discovery`, protocol: 'openvaultdb/0.1', authEnabled: false,
    databases: [{ id: db.id, url: db.ovdb.url, apiUrl: db.ovdb.connection, capabilities: { read: true, query: db.ovdb.query, write: false } }],
  });
  return new Response(request.method === 'HEAD' ? null : body, { headers: { ...readonlyCorsHeaders(), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });
}

function serverDiscovery(request: Request): Response {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: readonlyCorsHeaders() });
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method Not Allowed', { status: 405, headers: { ...readonlyCorsHeaders(), Allow: 'GET, HEAD, OPTIONS' } });
  const body = JSON.stringify({
    name: 'DemoDB OpenVaultDB server', protocol: 'openvaultdb/0.1', authEnabled: false,
    databases: [...ovdbDatabases.values()].map((database) => ({
      id: database.localId, url: database.id, apiUrl: database.apiUrl,
      manifestUrl: `https://demodb.dev/ovdb/db/${database.localId}/ovdb-database.json`,
      capabilities: { read: true, query: database.capabilities.query, write: false },
    })),
  });
  return new Response(request.method === 'HEAD' ? null : body, { headers: { ...readonlyCorsHeaders(), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300', ...securityHeaders() } });
}

function serverApiIndex(request: Request): Response {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: readonlyCorsHeaders() });
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method Not Allowed', { status: 405, headers: { ...readonlyCorsHeaders(), Allow: 'GET, HEAD, OPTIONS' } });
  const body = JSON.stringify(ovdbIndex.server);
  return new Response(request.method === 'HEAD' ? null : body, { headers: { ...readonlyCorsHeaders(), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300', ...securityHeaders() } });
}

function isOVDBPublicJson(pathname: string): boolean {
  return pathname === '/.well-known/openvaultdb'
    || pathname === '/ovdb/ovdb-server.json'
    || /^\/ovdb\/schemas\/ovdb-(?:server|database)-draft-1\.schema\.json$/.test(pathname)
    || /^\/ovdb\/db\/[a-z][a-z0-9-]{0,39}\/ovdb-database\.json$/.test(pathname)
    || /^\/[a-z][a-z0-9-]{0,39}\/ovdb-database\.json$/.test(pathname);
}

async function proxyOVDB(request: Request, url: URL): Promise<Response> {
  const match = /^\/ovdb\/v1\/databases\/([a-z][a-z0-9-]{0,39})(\/.*)?$/.exec(url.pathname);
  const database = match && ovdbDatabases.get(match[1]);
  if (!database) return notFound();
  const suffix = match[2] ?? '';
  if (suffix === '' || suffix === '/') return databaseApiIndex(request, database);
  const query = suffix === '/dtql' || suffix === '/query';
  const recordRead = /^\/records\/[^/]+(?:\/[^/]+)+$/.test(suffix);
  const readPath = suffix === '/read' || suffix === '/inferred-schema' || recordRead;
  if (!query && !readPath) return notFound();
  if (query && !database.capabilities.query) return notFound();
  const methods = query ? ['GET', 'HEAD', 'POST', 'OPTIONS'] : ['GET', 'HEAD', 'OPTIONS'];
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: apiCorsHeaders(methods) });
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) && !(query && request.method === 'POST')) {
    return new Response('OpenVaultDB is read-only', { status: 403, headers: { ...apiCorsHeaders(methods), Allow: methods.join(', ') } });
  }
  if (!methods.includes(request.method)) {
    return new Response('Method Not Allowed', { status: 405, headers: { ...apiCorsHeaders(methods), Allow: methods.join(', ') } });
  }
  const target = new URL(`/v1/databases/${database.localId}${suffix}${url.search}`, ovdbApiOrigin);
  const headers = new Headers({ Accept: request.headers.get('Accept') ?? 'application/json' });
  let body: ArrayBuffer | undefined;
  if (query) {
    if (request.method === 'POST') {
      const length = Number(request.headers.get('Content-Length'));
      if (Number.isFinite(length) && length > 1 * 1024 * 1024) return new Response('Query request is too large', { status: 413, headers: apiCorsHeaders(methods) });
      const limitedBody = await readLimitedBody(request, 1 * 1024 * 1024);
      if (!limitedBody) return new Response('Query request is too large', { status: 413, headers: apiCorsHeaders(methods) });
      body = limitedBody;
      const contentType = request.headers.get('Content-Type');
      if (contentType) headers.set('Content-Type', contentType);
    }
  }
  for (const name of ['OVDB-Page-Size', 'OVDB-Page-Token', 'OVDB-Page-Close']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  try {
    const response = await fetch(target, { method: request.method, headers, body, redirect: 'error' });
    if (response.status >= 300 && response.status < 400) return new Response('The OVDB backend returned a redirect', { status: 502, headers: securityHeaders() });
    const outputHeaders = new Headers();
    for (const name of ['Content-Type', 'Cache-Control', 'ETag', 'Last-Modified', 'Vary', 'Link', 'OVDB-Page-Size', 'OVDB-Page-Token']) {
      const value = response.headers.get(name);
      if (value) outputHeaders.set(name, value);
    }
    for (const [name, value] of Object.entries(apiCorsHeaders(methods))) outputHeaders.set(name, value);
    for (const [name, value] of Object.entries(securityHeaders())) outputHeaders.set(name, value);
    return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, statusText: response.statusText, headers: outputHeaders });
  } catch {
    return new Response('OpenVaultDB is temporarily unavailable', { status: 502, headers: { ...apiCorsHeaders(methods), ...securityHeaders() } });
  }
}

async function databaseApiIndex(request: Request, database: OVDBManifest): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: readonlyCorsHeaders() });
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return new Response('OpenVaultDB is read-only', { status: 403, headers: { ...readonlyCorsHeaders(), Allow: 'GET, HEAD, OPTIONS' } });
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method Not Allowed', { status: 405, headers: { ...readonlyCorsHeaders(), Allow: 'GET, HEAD, OPTIONS' } });
  return fetchDatabaseMetadata(request, database);
}

async function fetchDatabaseMetadata(request: Request, database: OVDBManifest): Promise<Response> {
  const target = new URL(`/v1/databases/${database.localId}`, ovdbApiOrigin);
  try {
    const upstream = await fetch(target, { method: request.method, headers: { Accept: 'application/json' }, redirect: 'error' });
    if (upstream.status >= 300 && upstream.status < 400) return new Response('The OVDB backend returned a redirect', { status: 502, headers: securityHeaders() });
    const outputHeaders = new Headers();
    for (const name of ['Content-Type', 'Cache-Control', 'ETag', 'Last-Modified', 'Vary', 'Link']) {
      const value = upstream.headers.get(name);
      if (value) outputHeaders.set(name, value);
    }
    for (const [name, value] of Object.entries({ ...readonlyCorsHeaders(), 'Access-Control-Expose-Headers': 'Cache-Control, ETag, Last-Modified, Link, Vary', ...securityHeaders() })) outputHeaders.set(name, value);
    if (request.method === 'HEAD' || !upstream.ok) return new Response(request.method === 'HEAD' ? null : upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: outputHeaders });

    const metadata = await upstream.json() as { id?: unknown; endpoints?: { dtql?: unknown }; [key: string]: unknown };
    if (!metadata || metadata.id !== database.localId || typeof metadata.endpoints?.dtql !== 'string') return new Response('The OVDB backend returned invalid database metadata', { status: 502, headers: { ...readonlyCorsHeaders(), ...securityHeaders() } });
    const expectedBackendEndpoint = `https://cloud.openvaultdb.com/v1/databases/${database.localId}/dtql`;
    if (metadata.endpoints.dtql !== expectedBackendEndpoint) return new Response('The OVDB backend returned an unexpected query endpoint', { status: 502, headers: { ...readonlyCorsHeaders(), ...securityHeaders() } });
    metadata.endpoints.dtql = `https://demodb.dev/ovdb/v1/databases/${database.localId}/dtql`;
    outputHeaders.set('Content-Type', 'application/json; charset=utf-8');
    outputHeaders.delete('ETag');
    return new Response(JSON.stringify(metadata), { status: upstream.status, statusText: upstream.statusText, headers: outputHeaders });
  } catch {
    return new Response('OpenVaultDB is temporarily unavailable', { status: 502, headers: { ...readonlyCorsHeaders(), ...securityHeaders() } });
  }
}

async function readLimitedBody(request: Request, maximum: number): Promise<ArrayBuffer | null> {
  if (!request.body) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
  return combined.buffer;
}

function apiCorsHeaders(methods: string[]): Record<string, string> {
  const allowed = [...new Set([...methods, 'GET', 'HEAD', 'OPTIONS'])];
  return {
    'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': allowed.join(', '),
    'Access-Control-Allow-Headers': 'Content-Type, Accept, OVDB-Page-Size, OVDB-Page-Token, OVDB-Page-Close',
    'Access-Control-Expose-Headers': 'Cache-Control, ETag, Last-Modified, Link, OVDB-Page-Size, OVDB-Page-Token, Vary', 'Access-Control-Max-Age': '86400',
  };
}

function hostMetadata(method: string, host: string, path: string, db?: Database): Response {
  const body = path === '/robots.txt'
    ? `User-agent: *\nAllow: /\n\nSitemap: https://${host}/sitemap.xml\n`
    : sitemap(host, db);
  return new Response(method === 'HEAD' ? null : body, {
    headers: { 'Content-Type': path === '/robots.txt' ? 'text/plain; charset=utf-8' : 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=300', ...securityHeaders() },
  });
}

function sitemap(host: string, db?: Database): string {
  const urls = db
    ? ['/', '/tables/', '/schema/', '/downloads/', '/queries/', '/about/', '/model/', ...db.tables.map((table) => `/tables/${encodeURIComponent(table.name)}/`)].map((path) => `https://${host}${path}`)
    : [`https://${host}/`, 'https://demodb.dev/ovdb/', 'https://demodb.dev/ovdb/ovdb-server.json', ...[...ovdbDatabases.keys()].flatMap((id) => [`https://demodb.dev/${id}/`, `https://demodb.dev/${id}/ovdb-database.json`, `https://demodb.dev/ovdb/db/${id}/ovdb-database.json`]), ...databaseList.map((database) => `https://${database.siteHost}/`)];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((url) => `<url><loc>${xmlEscape(url)}</loc></url>`).join('')}</urlset>\n`;
}

function xmlEscape(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function redirectOvdb(request: Request, url: URL, db: Database): Response {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });
  if (!db.ovdb.available) return new Response('OpenVaultDB is unavailable for this database', { status: 404, headers: securityHeaders() });
  let target: URL;
  if (url.pathname === '/ovdb/v1' || url.pathname.startsWith('/ovdb/v1/')) {
    target = new URL(`${url.pathname}${url.search}`, 'https://demodb.dev');
  } else {
    const prefix = `/ovdb/dbs/${db.id}`;
    const rest = url.pathname === '/ovdb' || url.pathname === '/ovdb/' ? '' : url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : url.pathname.slice('/ovdb'.length);
    target = new URL(`${db.ovdb.deploymentUrl.replace(/\/$/, '')}${rest}${url.search}`);
  }
  return redirectPreservingRequest(request, target.toString());
}

function redirectPreservingRequest(_request: Request, location: string): Response {
  const headers = new Headers({ Location: location, 'Cache-Control': 'public, max-age=300' });
  for (const [name, value] of Object.entries(corsHeaders())) headers.set(name, value);
  return new Response(null, { status: 308, headers });
}

function notFound(): Response {
  return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...securityHeaders() } });
}

function corsHeaders(): Record<string, string> {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS, POST', 'Access-Control-Allow-Headers': 'Content-Type, Accept, OVDB-Page-Size, OVDB-Page-Token, OVDB-Page-Close', 'Access-Control-Max-Age': '86400' };
}
function readonlyCorsHeaders(): Record<string, string> {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' };
}
function securityHeaders(): Record<string, string> {
  return { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' };
}
