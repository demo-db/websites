# DemoDB websites

One Astro static build produces the catalogue at `demodb.dev` and one metadata-driven database site for every pinned provider entry. The Worker selects the catalogue or database from the request host, serves the matching static page tree, and keeps its generated `/_db/<id>/...` paths private. The current provider-backed datasets are Chinook, Northwind, Pubs, Sakila, AdventureWorks, and Employees.

Provider commits and contract hashes are locked in [`config/databases.json`](config/databases.json). Release builds fetch exact GitHub revisions and verify the provider contract, checksums, and every listed export before rendering. For local development, set `DEMODB_CONTRACTS_DIR` to a directory containing provider checkouts named by database id, such as `../` from the `demo-db` organization worktree. That override is rejected in CI and deploy builds.

AdventureWorks source conversion and OVDB fixture preparation currently use Python. A future Go consolidation is worth considering if it reduces tooling and runtime dependencies while preserving reproducible outputs and exact-decimal and provenance checks; this is an option to evaluate, not a committed or scheduled migration.

```sh
pnpm install --frozen-lockfile
DEMODB_CONTRACTS_DIR=/path/to/demo-db pnpm dev
```

Local preview hosts are `localhost` for the catalogue, `chinook.localhost` and `northwind.localhost` for the database sites. Wrangler maps these names without changing the release hostname registry.

## OpenVaultDB

The shared server page is [`/ovdb/`](https://demodb.dev/ovdb/). Its typed descriptor is [`/ovdb/ovdb-server.json`](https://demodb.dev/ovdb/ovdb-server.json), and the legacy OpenVaultDB discovery protocol remains available at `/.well-known/openvaultdb`. Database identities are canonical URLs such as `https://demodb.dev/northwind/`; each provider descriptor is published at both `/ovdb/db/{localId}/ovdb-database.json` and `/{localId}/ovdb-database.json` with identical bytes. The two JSON Schema files are published under `/ovdb/schemas/` and validated during the build.

The central read-only API at `/ovdb/v1/databases/{localId}` proxies the fixed `cloud.openvaultdb.com` backend. It preserves the existing OVDB database metadata response and points its DTQL endpoint back to the central proxy; the draft-1 typed descriptor remains available at its manifest URL. It allowlists record reads, inferred schema, read queries, and DTQL query routes. POST supports bounded raw DTQL YAML and JSON wrappers; write methods are denied. API requests support CORS and the OVDB page-size, page-token, and page-close headers. Provider descriptors contain public schema/provenance/model/meaning data and no storage credentials or DSNs.

Run `pnpm build`, `pnpm test`, and `pnpm typecheck` before submitting changes. Pull requests run these checks and never deploy. A push to `main` deploys the Worker and assets when the Cloudflare token and account identifier are available, then checks the live build marker and representative routes. See [`docs/architecture.md`](docs/architecture.md), [`docs/adding-a-database.md`](docs/adding-a-database.md), and [`docs/deployment.md`](docs/deployment.md).

The `chinookdb.com` provider alias has verified 308 redirect behavior enabled and its Cloudflare custom-domain binding is attached to this Worker. The redirect preserves path, query, and method, sends database profile URLs to the canonical DemoDB identity, and rejects unknown OVDB database IDs. Main-branch deployment smoke checks page, download, profile, and POST query redirects without following them.

Database Downloads pages also support explicit, resumable browser-local imports to IndexedDB. See [`docs/browser-import.md`](docs/browser-import.md) for key handling, verification, storage, and view behavior. The generated [`/corpus.json`](https://demodb.dev/corpus.json) exposes the catalogued schema and public export metadata without preview rows.
