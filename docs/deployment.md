# Deployment

`.github/workflows/deploy.yml` builds the site and deploys each public hostname from `main` as its own **Cloudflare Pages project** (direct upload, no Git integration, no Pages Functions). No DemoDB request runs a Worker script, Pages static requests are free and unmetered, and Pages projects use no Worker slots (the account is at 97 of the Workers Free limit of 100; Pages has a separate limit of 100 projects). The former single Worker (`demodb-websites`, `src/worker.ts` with `run_worker_first`) ran on every request, used most of the account's Workers Free daily quota of 100,000 requests and took the account down on 2026-10-16 (Cloudflare Error 1027). It is retired.

| Host | Pages project | Bundle (`dist-hosts/`) |
| --- | --- | --- |
| `<id>.demodb.dev` (six datasets) | `demodb-<id>` | the dataset's pages and files at their public paths |
| `demodb.dev` | `demodb-catalogue` | catalogue pages, `/ovdb/` pages, OVDB JSON, `corpus.json`, research snapshots |

`scripts/build-hosts.mjs` (the last step of `pnpm build`) writes each bundle with its `_headers`, `_redirects` and a top-level `404.html` (without one, Pages serves `index.html` with 200 for every missing path). `scripts/deploy-hosts.mjs` deploys (`pnpm run deploy:hosts`; `--dry-run` in CI validates the bundles without network):

1. **Preflight**, before anything changes: existing Pages projects plus the ones this run creates must fit `DEMODB_PAGES_LIMIT` (default 100). No zone Worker route on `demodb.dev` may match a DemoDB host (Pages refuses a domain a Worker route is on). The account's Worker list is recorded; after the run any new Worker fails the run.
2. **Per host, dataset hosts first and `demodb.dev` last**, every step idempotent so a re-run resumes:
   1. `wrangler pages project create <project> --production-branch main` if the project does not exist;
   2. `wrangler pages deploy dist-hosts/<host> --project-name <project> --branch main`;
   3. delete the hostname's Workers custom domain (`DELETE /accounts/:acct/workers/domains/:id`): Pages cannot add a custom domain while a Worker is routed on it;
   4. add it to the project (`POST /accounts/:acct/pages/projects/:project/domains`);
   5. create a proxied `CNAME <host> -> <project subdomain>.pages.dev` in the `demodb.dev` zone, using the subdomain Pages assigned (it can differ from the project name). Any other A, AAAA or CNAME record on the name stops the run instead of being overwritten;
   6. poll the Pages domain every 15 s until it is `active` (timeout `DEMODB_DOMAIN_TIMEOUT_SECONDS`, default 1200; a re-run keeps waiting).

   If step 4 or 5 fails after step 3, the run removes the Pages domain (if added) and re-attaches the Worker custom domain to `demodb-websites` (`PUT /accounts/:acct/workers/domains`) before failing, so the host goes back to the old Worker instead of staying dark. If that rollback also fails, the error says how to re-attach the domain in the dashboard. The deploy job's timeout is 90 minutes so it outlasts seven activations.
3. **Cleanup is manual.** The run prints `pnpm exec wrangler delete --name demodb-websites` once that Worker has no custom domains left. It never deletes it.

A host is unavailable from step 3 until step 6 finishes, while Pages validates the hostname and issues its certificate. Cloudflare does not document a duration; the run logs both times and the gap for each host. The hosts were already failing with Error 1027 when this cutover was written.

The token in `CLOUDFLARE_API_TOKEN` needs Account > Cloudflare Pages: Edit, Account > Workers Scripts: Edit (list Workers, detach and re-attach their custom domains), and on `demodb.dev` Zone > Workers Routes: Edit (custom domain changes and the route preflight), Zone > DNS: Edit and Zone: Read.

What the Worker computed per request is now produced at build time:

- **Files at public paths.** There is no private `/_db/<id>/` namespace: `/_db/*` is a 404 everywhere. `/schema.json`, `/.well-known/openvaultdb`, `robots.txt` and `sitemap.xml` are generated files.
- **Headers** (`_headers`): `X-Content-Type-Options: nosniff` everywhere; read-only CORS (`Access-Control-Allow-Origin: *`) and `Cross-Origin-Resource-Policy: cross-origin` on `/data/*`, `/model/*`, `/schema.json` and the Northwind evidence; CORS on the catalogue's public JSON; explicit content types for `.sqlite`, `.sql`, `.yaml`, `.csv`, `.json`, `.zip`, `.hcl`. Data files keep `Cache-Control: public, max-age=300, must-revalidate`; content-addressed comparison fixtures and the parts of chunked exports get `public, max-age=31536000, immutable`.
- **Chunked exports.** A gzip-encoded export (all AdventureWorks complete-database files and two per-table JSON files, each above 25 MiB decoded) has **no single-file URL**. It is published as content-addressed `<file>.gz.<first 16 hex of the part's SHA-256>.part-N` files plus a manifest at `/data/<file>.parts.json` (`format: demodb-chunked-export/v1`: `file`, `compression`, `bytes` and `sha256` of the joined gzip, `uncompressedSha256`, and `parts[]` with `path` relative to the manifest, `bytes`, `sha256`). `corpus.json` points such an export's `url` at its manifest and marks it `delivery: demodb-chunked-export/v1`.
- **Redirects** (`_redirects`, all 308 so method and query are kept): `/ovdb/v1*` on every host to `https://ovdb.demodb.dev/v1*` (the OVDB API is served by the openvaultdb-cloud Worker, not here); legacy `/ovdb/dbs/<id>` and `/ovdb/db/<id>` profiles to `https://demodb.dev/<id>/`; `/ovdb/*` on a dataset host to its OpenVaultDB deployment.
- **Methods.** Pages answers `GET` and `HEAD`. `OPTIONS`, `POST` and other methods on a file get **405** (the Worker answered `OPTIONS` with 204). This is accepted: DemoDB files are fetched with simple CORS requests (no custom request headers), which need no preflight. Redirect rules run before the method check, so a `POST` to a redirected path still gets its 308.
- **Directory URLs.** `/tables/Artist` and `/tables/Artist/index.html` answer 308 to `/tables/Artist/` (the Worker served the page directly).
- **Pages defaults.** Pages adds `Access-Control-Allow-Origin: *` to every response, pages included (the content is public and no request carries credentials). A 404 is the bundle's `404.html` with `Cache-Control: no-store`.

`scripts/write-build-info.mjs` writes `build-info.json` (format `demodb-build/1`, the full `BUILD_COMMIT`) into every bundle. `scripts/smoke-live.mjs` runs after a deploy and sends at most one request per URL: it checks the commit marker on every host, representative pages, every advertised download (chunked ones joined and decoded), the redirects and the `/_db` and single-file 404s. It sends no OVDB API query.

`CLOUDFLARE_API_TOKEN` is passed only to the deploy step; `CLOUDFLARE_ACCOUNT_ID` can be an organization variable or secret. If either is absent, the build succeeds and deployment is marked skipped with a notice. `chinookdb.com` is not deployed from this repository (founder decision, 2026-10-16); the cutover leaves its custom domain on `demodb-websites`, so the run reports that Worker as not yet deletable until that domain is moved or removed.

For local preview, `pnpm dev` serves the catalogue bundle with `wrangler pages dev`; serve another host with `wrangler pages dev dist-hosts/<host>`. `pnpm test` includes `scripts/test-static-hosts.mjs` (bundles, URL inventory, headers and redirects), `scripts/test-deploy-hosts.mjs` (preflight and cutover against a fake account) and `scripts/test-static-hosts-pages.mjs` (every bundle under `wrangler pages dev`, every inventory URL requested).
