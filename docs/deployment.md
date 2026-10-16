# Deployment

`.github/workflows/deploy.yml` builds the site and deploys one **assets-only** Cloudflare Worker per public hostname from `main`. No DemoDB host runs a Worker script: every request is answered by Workers static assets, which is free and unmetered. The former single Worker (`demodb-websites`, `src/worker.ts` with `run_worker_first`) ran on every request, used most of the account's Workers Free daily quota of 100,000 requests and took the account down on 2026-10-16 (Cloudflare Error 1027). It is retired.

| Host | Config (`deploy/hosts/`) | Bundle (`dist-hosts/`) |
| --- | --- | --- |
| `demodb.dev` | `demodb-catalogue.jsonc` | catalogue pages, `/ovdb/` pages, OVDB JSON, `corpus.json`, research snapshots |
| `<id>.demodb.dev` (six datasets) | `demodb-<id>.jsonc` | the dataset's pages and files at their public paths |
| `chinookdb.com` | `demodb-chinookdb-com.jsonc` | redirects only |

`scripts/build-hosts.mjs` (the last step of `pnpm build`) writes each bundle with its `_headers` and `_redirects`; `scripts/deploy-hosts.mjs` deploys the configs one by one (`pnpm run deploy:hosts`, or `--dry-run` in CI). What the Worker computed per request is now produced at build time:

- **Files at public paths.** There is no private `/_db/<id>/` namespace: `/_db/*` is a 404 everywhere. `/schema.json`, `/.well-known/openvaultdb`, `robots.txt` and `sitemap.xml` are generated files.
- **Headers** (`_headers`): `X-Content-Type-Options: nosniff` everywhere; read-only CORS (`Access-Control-Allow-Origin: *`) and `Cross-Origin-Resource-Policy: cross-origin` on `/data/*`, `/model/*`, `/schema.json` and the Northwind evidence; CORS on the catalogue's public JSON; explicit content types for `.sqlite`, `.sql`, `.yaml`, `.csv`, `.json`, `.zip`, `.hcl`. Data files keep `Cache-Control: public, max-age=300, must-revalidate`; content-addressed comparison fixtures and the parts of chunked exports get `public, max-age=31536000, immutable`.
- **Chunked exports.** A gzip-encoded export (all AdventureWorks complete-database files and two per-table JSON files, each above 25 MiB decoded) has **no single-file URL**. It is published as `<file>.gz.part-N` files plus a manifest at `/data/<file>.parts.json` (`format: demodb-chunked-export/v1`: `file`, `compression`, `bytes` and `sha256` of the joined gzip, `uncompressedSha256`, and `parts[]` with `path` relative to the manifest, `bytes`, `sha256`). `corpus.json` points such an export's `url` at its manifest and marks it `delivery: demodb-chunked-export/v1`.
- **Redirects** (`_redirects`, all 308 so method and query are kept): `/ovdb/v1*` on every host to `https://ovdb.demodb.dev/v1*` (the OVDB API is served by the openvaultdb-cloud Worker, not here); legacy `/ovdb/dbs/<id>` and `/ovdb/db/<id>` profiles to `https://demodb.dev/<id>/`; `/ovdb/*` on a dataset host to its OpenVaultDB deployment; every `chinookdb.com` path to `chinook.demodb.dev`.
- **Methods.** Static assets answer `GET` and `HEAD`. `OPTIONS`, `POST` and other methods on a file get **405** (the Worker answered `OPTIONS` with 204). This is accepted: DemoDB files are fetched with simple CORS requests (no custom request headers), which need no preflight. Redirect rules run before the method check, so a `POST` to a redirected path still gets its 308.
- **Directory URLs.** `html_handling: auto-trailing-slash`: `/tables/Artist` answers 307 to `/tables/Artist/` (the Worker served the page directly).

`scripts/write-build-info.mjs` writes `build-info.json` (format `demodb-build/1`, the full `BUILD_COMMIT`) into every bundle. `scripts/smoke-live.mjs` runs after a deploy and sends at most one request per URL: it checks the commit marker on every host, representative pages, every advertised download (chunked ones joined and decoded), the redirects and the `/_db` and single-file 404s. It sends no OVDB API query.

`CLOUDFLARE_API_TOKEN` is passed only to the deploy step; `CLOUDFLARE_ACCOUNT_ID` can be an organization variable or secret. If either is absent, the build succeeds and deployment is marked skipped with a notice. In CI (no TTY) Wrangler moves a custom domain that is still bound to another Worker, such as the retired `demodb-websites`, to the config that names it. Deleting the retired Worker afterwards is a manual step.

For local preview, `pnpm dev` serves the catalogue bundle; serve another host with `wrangler dev --config deploy/hosts/demodb-<id>.jsonc`. `pnpm test` includes `scripts/test-static-hosts.mjs` (bundle, URL inventory, headers and redirects) and `scripts/test-static-hosts-workerd.mjs` (the bundles under `wrangler dev`).
