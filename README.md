# DemoDB websites

One Astro static build produces the catalogue at `demodb.dev` and one metadata-driven database site for every pinned provider entry. The Worker selects the catalogue or database from the request host, serves the matching static page tree, and keeps its generated `/_db/<id>/...` paths private. The current provider-backed datasets are Chinook, Northwind, Pubs, Sakila, AdventureWorks, and Employees.

Provider commits and contract hashes are locked in [`config/databases.json`](config/databases.json). Release builds fetch exact GitHub revisions and verify the provider contract, checksums, and every listed export before rendering. For local development, set `DEMODB_CONTRACTS_DIR` to a directory containing provider checkouts named by database id, such as `../` from the `demo-db` organization worktree. That override is rejected in CI and deploy builds.

AdventureWorks source conversion and OVDB fixture preparation currently use Python. A future Go consolidation is worth considering if it reduces tooling and runtime dependencies while preserving reproducible outputs and exact-decimal and provenance checks; this is an option to evaluate, not a committed or scheduled migration.

## PostgreSQL sample imports

The standard-library tool under [`scripts/hosting-tools/`](scripts/hosting-tools/) validates a provider's pinned SQLite SHA-256 and generates a transactional PostgreSQL script without replacing an existing database schema. Inputs may be a provider root with its `manifest.json` and declared SQLite or gzip source, concatenated gzip chunks, or a staged `decoded.sqlite`. Generated SQL belongs in a private temporary directory, not the repository:

```sh
python3 scripts/hosting-tools/postgres_samples.py generate /path/to/provider-root \
  --output /private/tmp/chinook-postgres.sql
```

For large fixtures, install `psycopg[binary]==3.2.12` in a private Python environment and stream rows with `COPY`. Put a PostgreSQL URL in a private `0600` file. The import creates only the provider's own schema, refuses to overwrite it, and rolls back on failure. The verifier checks source provenance, table columns, keys, indexes, foreign keys, exact typed table row multisets, and view columns and results:

```sh
python3 scripts/hosting-tools/postgres_samples.py import /path/to/provider-root \
  --url-file /private/tmp/provider-owner-url
python3 scripts/hosting-tools/postgres_samples.py verify /path/to/provider-root \
  --url-file /private/tmp/provider-owner-url
```

The Python API exposes `import_database(connection, provider_root)` and `verify_database(connection, provider_root)` for existing psycopg 3 connections, including autocommit connections. AdventureWorks `Production.Document.FileExtension` is the sole storage override: the SQLite `TEXT` values include NUL characters, which PostgreSQL `TEXT` cannot store. The importer maps this column to `BYTEA` and preserves each source string's UTF-8 bytes exactly. The import manifest records the override.

## Local development

```sh
pnpm install --frozen-lockfile
DEMODB_CONTRACTS_DIR=/path/to/demo-db pnpm dev
```

Local preview hosts are `localhost` for the catalogue, `chinook.localhost` and `northwind.localhost` for the database sites. Wrangler maps these names without changing the release hostname registry.

## OpenVaultDB

The shared server page is [`/ovdb/`](https://demodb.dev/ovdb/). Its typed descriptor is [`/ovdb/ovdb-server.json`](https://demodb.dev/ovdb/ovdb-server.json), and the legacy OpenVaultDB discovery protocol remains available at `/.well-known/openvaultdb`. Database identities are canonical URLs such as `https://demodb.dev/northwind/`; each provider descriptor is published at both `/ovdb/db/{localId}/ovdb-database.json` and `/{localId}/ovdb-database.json` with identical bytes. The two JSON Schema files are published under `/ovdb/schemas/` and validated during the build.

The central read-only API at `/ovdb/v1/databases/{localId}` proxies the fixed `cloud.openvaultdb.com` backend. It preserves the existing OVDB database metadata response and points its DTQL endpoint back to the central proxy; the draft-1 typed descriptor remains available at its manifest URL. It allowlists record reads, inferred schema, read queries, and DTQL query routes. POST supports bounded raw DTQL YAML and JSON wrappers; write methods are denied. API requests support CORS and the OVDB page-size, page-token, and page-close headers. Provider descriptors contain public schema/provenance/model/meaning data and no storage credentials or DSNs.

The storage catalogue also links to pinned inGitDB editions in each provider's GitHub repository. These are Git-hosted collections for local CLI queries; the six OVDB API routes continue to serve the SQLite editions. The separate storage revision pins in `config/databases.json` point to the published inGitDB files without changing the provider contract pins. New inGitDB bundles are generated with DataTug's DALgo exporter and independently checked against the pinned SQLite source. [`scripts/hosting-tools/storage_exports.py`](scripts/hosting-tools/storage_exports.py) also prepares BigQuery load bundles, but no BigQuery-hosted edition is listed until a project and deployment are verified.

Run `pnpm build`, `pnpm test`, and `pnpm typecheck` before submitting changes. Pull requests run these checks and never deploy. A push to `main` deploys the Worker and assets when the Cloudflare token and account identifier are available, then checks the live build marker and representative routes. See [`docs/architecture.md`](docs/architecture.md), [`docs/adding-a-database.md`](docs/adding-a-database.md), and [`docs/deployment.md`](docs/deployment.md).

The `chinookdb.com` provider alias has verified 308 redirect behavior enabled and its Cloudflare custom-domain binding is attached to this Worker. The redirect preserves path, query, and method, sends database profile URLs to the canonical DemoDB identity, and rejects unknown OVDB database IDs. Main-branch deployment smoke checks page, download, profile, and POST query redirects without following them.

Database Downloads pages also support explicit, resumable browser-local imports to IndexedDB. See [`docs/browser-import.md`](docs/browser-import.md) for key handling, verification, storage, and view behavior. The generated [`/corpus.json`](https://demodb.dev/corpus.json) exposes the catalogued schema and public export metadata without preview rows.
