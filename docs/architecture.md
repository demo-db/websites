# Architecture decision: one metadata-driven site build

**Status:** accepted for the Chinook and Northwind conversion.

## Context

The existing Chinook website combined one database’s pages, schema, query examples, and download URLs. The conversion brief requires Chinook and Northwind to share a catalogue, table pages, format navigation, relationship views, and DataTug components while preserving Chinook’s public page and `/data/...` URLs. Northwind adds native names with spaces, composite keys, self-references, views, and binary data. Duplicating a Chinook page tree would make each new sample a separate implementation to maintain.

## Decision

Each sample database owns its source fixture, generated formats, schema metadata, ModelSpec, meaning graph, OVDB manifest, licenses, semantics, and provider checksums in its provider repository. The website registry pins a provider commit and contract SHA. A single build script verifies those inputs and emits one indexed catalogue plus host-addressed static page and data trees. Shared Astro components read provider metadata; the Worker resolves official hostnames and maps public URLs to static assets.

Provider metadata supplies recordset names, kinds, columns, primary and foreign keys, descriptions, rows for previews, view definitions, semantic concepts, downloads, and capabilities. The UI offers a DataTug grid only where the provider publishes a JSON export for that recordset. This keeps Northwind’s schema-only views from being presented as mounted live collections. Exact concept tags plus name, column, and key-shape evidence rank cross-database matches; the site contains no Chinook/Northwind table-pair list.

The site uses explicit Worker custom domains for `demodb.dev`, `chinook.demodb.dev`, and `northwind.demodb.dev`. Static HTML handling is disabled and page routes are rewritten to explicit `index.html` assets, so the private build namespace does not produce a `Location` redirect. Unknown hosts and direct, encoded, or case-varied `/_db/` paths fail closed. Read-only data and schema assets support CORS `GET`, `HEAD`, and `OPTIONS`; database writes are denied.

The public OVDB server identity is `https://demodb.dev/ovdb`, with a human page at `/ovdb/`, a draft-1 server JSON descriptor at `/ovdb/ovdb-server.json`, and legacy protocol discovery at `/.well-known/openvaultdb`. Each database identity is its canonical human URL (`https://demodb.dev/{localId}/`); its typed draft-1 descriptor is served at both the shared server resource `/ovdb/db/{localId}/ovdb-database.json` and the short canonical path `/{localId}/ovdb-database.json`. The two representations are byte-identical copies of the checksum-verified provider descriptor. The build validates descriptors against the separately published JSON Schemas, then checks DemoDB’s fixed server, identity, homepage, API route, public references, and read-only constraints.

The public API `/ovdb/v1/databases/{localId}` proxies the configured OpenVaultDB service through a fixed origin. The database API endpoint preserves the backend’s existing `id`, engine, schema mode, collection, capability, DTQL endpoint, and query-format response; it rewrites only the advertised DTQL URL to the central proxy. The draft-1 typed database descriptor remains available at its separate manifest URL. Native record reads, inferred schema, and GET/POST query routes are forwarded; POST accepts bounded raw DTQL YAML or the backend’s JSON wrapper. Write methods are rejected. The proxy forwards page-size, page-token, and page-close headers and retains `Vary` cache behavior needed for stable query pagination. It never forwards authorization or cookie headers. Legacy discovery keeps local database IDs and advertises each global canonical URL separately. Unknown database IDs and unlisted routes fail closed.

The original Chinook pages and assets were audited at `datatug/chinookdb` commit `79e7bb0b1d6f0666dce465874990dec64348331f`. Existing page intents (home, tables, table detail, downloads, about, queries, and model) are now shared routes. Chinook’s case-sensitive table names, `/tables/<name>/`, `/data/...`, `/model/...`, favicon, styles, generic DataTug embed, sample SQL, and model documents are retained from provider exports or shared assets. Provider metadata and generated exports replace the former copied static table records.

## Consequences

Adding a third database changes the provider repository and registry, plus a reviewed Worker custom-domain entry after domain ownership and DNS are ready. It does not require a new page component, a table-specific branch, or a hand-maintained cross-database map. Provider export compatibility and correctness are checked at build time against pinned SHA-256 values.

The private output tree uses `/_db/<id>/...`, but Astro reserves leading-underscore page directories. Source page templates therefore live under `src/pages/db/`; `scripts/finalize-static.mjs` moves the built routes into `dist/_db/` after Astro has generated them. The Worker never exposes this internal path and always resolves directory routes to explicit `index.html` assets.

### Abstraction leak review

The shared renderer and similarity code were searched for `chinook`, `northwind`, and sample table names. Database-specific facts remain in the registry or provider contracts. `chinookdb.com` appears only as a provider-declared alias; its redirects use a generic flag and target-host lookup. The transferred hostname is now an explicit Wrangler custom domain. `Order Details` is an ordinary provider recordset name and uses encoded public paths.

### Deferred production work

The Chinook site, discovery route, cloud OVDB behavior, query journey, theme preference, and old-host 308 redirects have passed live checks. `chinookdb.com` is bound to the same Worker as the canonical DemoDB and sample database hosts.
