# DemoDB websites

One Astro static build produces the catalogue at `demodb.dev` and one metadata-driven database site for every pinned provider entry. The Worker selects the catalogue or database from the request host, serves the matching static page tree, and keeps its generated `/_db/<id>/...` paths private. Chinook and Northwind are the current provider-backed examples.

Provider commits and contract hashes are locked in [`config/databases.json`](config/databases.json). Release builds fetch exact GitHub revisions and verify the provider contract, checksums, and every listed export before rendering. For local development, set `DEMODB_CONTRACTS_DIR` to a directory containing provider checkouts named by database id, such as `../` from the `demo-db` organization worktree. That override is rejected in CI and deploy builds.

```sh
pnpm install --frozen-lockfile
DEMODB_CONTRACTS_DIR=/path/to/demo-db pnpm dev
```

Local preview hosts are `localhost` for the catalogue, `chinook.localhost` and `northwind.localhost` for the database sites. Wrangler maps these names without changing the release hostname registry.

Run `pnpm build`, `pnpm test`, and `pnpm typecheck` before submitting changes. Pull requests run these checks and never deploy. A push to `main` deploys the Worker and assets when the Cloudflare token and account identifier are available, then checks the live build marker and representative routes. See [`docs/architecture.md`](docs/architecture.md), [`docs/adding-a-database.md`](docs/adding-a-database.md), and [`docs/deployment.md`](docs/deployment.md).

The `chinookdb.com` provider alias remains disabled in the Worker and is not attached to this Worker’s routes. The legacy host should be redirected only after the new Chinook pages and OVDB routes have been verified live; the root owner controls that production cutover.
