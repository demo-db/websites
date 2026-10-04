# Architecture decision: one metadata-driven site build

**Status:** accepted for the Chinook and Northwind conversion.

## Context

The existing Chinook website combined one database’s pages, schema, query examples, and download URLs. The conversion brief requires Chinook and Northwind to share a catalogue, table pages, format navigation, relationship views, and DataTug components while preserving Chinook’s public page and `/data/...` URLs. Northwind adds native names with spaces, composite keys, self-references, views, and binary data. Duplicating a Chinook page tree would make each new sample a separate implementation to maintain.

## Decision

Each sample database owns its source fixture, generated formats, schema metadata, ModelSpec, meaning graph, OVDB manifest, licenses, semantics, and provider checksums in its provider repository. The website registry pins a provider commit and contract SHA. A single build script verifies those inputs and emits one indexed catalogue plus host-addressed static page and data trees. Shared Astro components read provider metadata; the Worker resolves official hostnames and maps public URLs to static assets.

Provider metadata supplies recordset names, kinds, columns, primary and foreign keys, descriptions, rows for previews, view definitions, semantic concepts, downloads, and capabilities. The UI offers a DataTug grid only where the provider publishes a JSON export for that recordset. This keeps Northwind’s schema-only views from being presented as mounted live collections. Exact concept tags plus name, column, and key-shape evidence rank cross-database matches; the site contains no Chinook/Northwind table-pair list.

The site uses explicit Worker custom domains for `demodb.dev`, `chinook.demodb.dev`, and `northwind.demodb.dev`. Static HTML handling is disabled and page routes are rewritten to explicit `index.html` assets, so the private build namespace does not produce a `Location` redirect. Unknown hosts and direct, encoded, or case-varied `/_db/` paths fail closed. Read-only data and schema assets support CORS `GET`, `HEAD`, and `OPTIONS`; all database mutations are rejected or redirected to the OVDB API endpoint.

The original Chinook pages and assets were audited at `datatug/chinookdb` commit `79e7bb0b1d6f0666dce465874990dec64348331f`. Existing page intents (home, tables, table detail, downloads, about, queries, and model) are now shared routes. Chinook’s case-sensitive table names, `/tables/<name>/`, `/data/...`, `/model/...`, favicon, styles, generic DataTug embed, sample SQL, and model documents are retained from provider exports or shared assets. Provider metadata and generated exports replace the former copied static table records.

## Consequences

Adding a third database changes the provider repository and registry, plus a reviewed Worker custom-domain entry after domain ownership and DNS are ready. It does not require a new page component, a table-specific branch, or a hand-maintained cross-database map. Provider export compatibility and correctness are checked at build time against pinned SHA-256 values.

The private output tree uses `/_db/<id>/...`, but Astro reserves leading-underscore page directories. Source page templates therefore live under `src/pages/db/`; `scripts/finalize-static.mjs` moves the built routes into `dist/_db/` after Astro has generated them. The Worker never exposes this internal path and always resolves directory routes to explicit `index.html` assets.

### Abstraction leak review

The shared renderer and similarity code were searched for `chinook`, `northwind`, and sample table names. Database-specific facts remain in the registry or provider contracts. `chinookdb.com` appears only as a provider-declared alias; its redirect is governed by a generic off-by-default flag and target-host lookup. The hostname list in Wrangler is intentionally explicit because Cloudflare custom domains are deployment configuration. `Order Details` is an ordinary provider recordset name and uses encoded public paths.

### Deferred production work

The legacy `chinookdb.com` DNS/custom-domain binding and permanent 308 cutover remain disabled until the new Chinook site, discovery route, and cloud OVDB behavior pass live checks. Production domain binding and cutover are owned by the deployment coordinator. Browser verification should follow the first deployment.
