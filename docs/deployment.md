# Deployment

`.github/workflows/deploy.yml` builds and deploys the Cloudflare Worker from `main`.

| Event | Result |
| --- | --- |
| Pull request | Install the frozen dependency graph, fetch pinned provider contracts, build pages, run type and behavior tests; no deployment. |
| Push to `main` | Run the same checks, deploy Worker and static assets when credentials are present, then verify the live SHA marker and database routes. |

Every job has a timeout. GitHub Actions are pinned by full commit SHA. `CLOUDFLARE_API_TOKEN` is passed only to the deploy step; `CLOUDFLARE_ACCOUNT_ID` can be an organization variable or secret. If either is absent, the build succeeds and deployment is marked skipped with a notice. The configured production deployment should provide both values.

`scripts/write-build-info.mjs` writes `dist/build-info.json` with format `demodb-build/1` and the full `BUILD_COMMIT`. `scripts/smoke-live.mjs` confirms all three official hosts report that exact commit and that the catalogue, representative native table/view pages, SQLite downloads, and per-site discovery return successfully. The test suite checks host resolution, unknown-host rejection, path encoding, private internal assets, CORS/read-only behavior, legacy route availability, and OVDB redirects without deploying.

The current Worker has explicit custom domains for `demodb.dev`, `chinook.demodb.dev`, and `northwind.demodb.dev`. Its `ENABLE_LEGACY_REDIRECTS` variable is false, and `chinookdb.com` is not bound to this Worker. After live verification, the deployment coordinator can attach the old domain and enable the 308 redirect. Redirects preserve path, query, and method for the full legacy OVDB route tree.

For local preview, use `pnpm dev` with `DEMODB_CONTRACTS_DIR` pointing at the provider checkout directory. `localhost` serves the catalogue; `chinook.localhost` and `northwind.localhost` select the database site. Release builds ignore that override and fetch the exact pinned GitHub revisions.
