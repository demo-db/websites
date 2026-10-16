# Dialect SQL scripts (MySQL; SQL Server and Oracle planned)

A dialect script creates and fills one DemoDB dataset in a database engine. The MySQL script of every dataset is written by the
DataTug faithful SQL-script exporter from the provider's pinned SQLite fixture, loaded into a real MySQL 8.4 and verified, then
served as the `mysql` format at `/data/<id>.mysql.sql`. Each file is labelled "DemoDB contract edition, identical to the SQLite/CSV/JSON":
it holds the same tables and rows as the SQLite, CSV and JSON downloads, and what MySQL cannot carry exactly is listed in the header.

## Where things live

| What | Where |
|---|---|
| The generator pin | `config/dialect-scripts.json`: datatug release tag `v0.97.1` (never `latest`), the SHA-256 of the checksums file and of every platform asset, the edition label, the dialects |
| The scripts | each provider repository, `dialect-scripts/<id>.mysql.sql` (plain up to 25 MiB; above that deterministic gzip `.sql.gz`, and `.gz.part-NNNN` pieces above 25 MiB again, exactly like the provider exports) |
| What decides the bytes | `dialect-scripts/manifest.json` of the provider: the provider-written `attribution`, the recorded `inputs` (decoded SQLite SHA-256, datatug pin, edition, licence from `manifest.json` `source.license`, attribution), their hash `inputsSha256`, the stored files with their SHA-256, the decoded size and SHA-256, the exporter's report and the verification run |
| The exporter's report | `dialect-scripts/<id>.mysql.report.json`: every warning (what was not carried exactly), without any local path |
| The served bytes | the site reads those files at the revision pinned in `config/databases.json`, `scripts/dialect-scripts.mjs` verifies them, and `config/derived-exports.lock.json` pins the decoded SHA-256 and size (origin `provider-script` in `config/format-matrix.json`) |

The provider files are outside `artifacts/`, so the providers' own generators, which checksum everything under `artifacts/`, are not involved.

## Commands

```sh
# Refresh one provider checkout. Runs the pinned datatug only when the inputs hash differs from the manifest (the guard).
# The release is downloaded from the public datatug/datatug release (the same assets and checksums file as the private
# datatug-cli release), and its SHA-256 and the checksums file are verified before it runs: a mismatch is an error.
node scripts/dialect-scripts.mjs generate --provider ../chinook --tools /tmp/demodb-tools [--force]

# Needs neither the datatug binary nor Docker: the required lane.
node scripts/dialect-scripts.mjs check --providers /path/to/providers      # directory holding <id> checkouts

# Regenerates every script with the pinned datatug and compares the bytes with the committed ones.
node scripts/dialect-scripts.mjs regenerate-check --providers /path/to/providers

# Loads every script into a digest-pinned mysql:8.4 container and compares tables, columns, keys, counts and the marker row
# with the SQLite fixture. Needs Docker.
node scripts/verify-mysql-live.mjs --providers /path/to/providers
```

The guard: `inputsSha256` is the hash of the decoded SQLite SHA-256, the datatug tag and checksums-file digest, the edition label, the
licence, the attribution, the dialect and the dataset name. When it is unchanged, `generate` does nothing. When it changed, `generate`
regenerates, and if the decoded script is the same as before it keeps the stored bytes and the recorded verification, so a different zlib never
rewrites a provider repository. A recorded verification belongs to one script: `check` fails when it names another one.

## Order of changes, the pins and the merge method

1. The provider pull requests add `dialect-scripts/`. Nothing else changes in a provider (contract, checksums and model untouched, so the `contractSha256` pins stay valid).
2. The websites pull request pins each provider's **pull request head** in `config/databases.json` so that its CI can run before the providers land. Until then
   `dialect-scripts.mjs check-pins` only warns on the pull request (`DEMODB_PIN_MODE=warn-ahead`).
3. The providers land first. On the push to `main` the same step runs strict: every pinned commit must be on that provider's `main` (GitHub compare of `main...<commit>` says
   `identical` or `behind`; `ahead`, `diverged` and an API error fail), so nothing deploys from a commit nobody merged.
4. **Merge commit or fast-forward push**: the pinned head is now in `main`'s history, nothing to do. **Squash or rebase**: the pinned head is not on `main`, the strict check fails, and
   you re-pin each affected `commit` to the commit `main` now has (the tree is the same: no `contractSha256` or lock change), push, and wait for CI again before landing.
5. A new datatug release (for example the one carrying `dialect=mssql`, or the multi-line licence notice below) is a change of `config/dialect-scripts.json`, then `generate` and a
   verification record in each provider, then new pins.

`record-verification` stamps the numbers of a cross-engine verifier run onto the stored script (`node scripts/dialect-scripts.mjs record-verification --provider <checkout> --tables N --rows N --values N --differences 0 --warnings N`).
It refuses a run with differences, and `check` refuses a script whose manifest has no clean verification of exactly its bytes: a regenerated script is not publishable until one is recorded.

## What `check` refuses

Besides the hashes, `check` lints the committed script the way the mysql client reads it, so that a re-hashed manifest cannot hide an edit: no CR, BOM or NUL; every line starts with a token the exporter writes
(an indented line is a column or key definition); no backslash outside a `--` comment line; no `#`, `/*` or mid-line `--` comment; no raw line break inside a string or a quoted name; nothing after a semicolon
on its line (`COMMIT; \! cmd`); the contract-edition label, the dataset, the licence of the provider manifest, the attribution, the datatug release and the SQLite SHA-256 in the header; the marker table first and
its row last. It also hashes the provider's SQLite file when the file is present. The comments in the header are free text and the client ignores a comment line.

## Licence notices in the headers (staged)

Today the header carries the SPDX identifier, the copyright and the provider-written attribution. The full notice each licence asks to travel with a copy (MIT: the copyright line, the permission notice and the
disclaimer; BSD-3-Clause for Sakila: the copyright, the three conditions and the disclaimer; CC BY-SA 3.0 for Employees: the verbatim copyright, credits, title, source, the adaptation and the licence URI) is staged in
`config/dialect-notices/<id>.txt`, written verbatim from the upstream licence files (only trailing spaces at line ends removed). They were compared with the upstream repositories at the pinned revisions: Chinook (`lerocha/chinook-database` at 7f67772),
Northwind (`jpwhite3/northwind-SQLite3` at 4f56e7f) and the Microsoft repository (`microsoft/sql-server-samples` at beaab06, Pubs and AdventureWorks) are byte for byte the retained `data-source/` licence files; Sakila's header is
identical to `sakila-schema.sql` of the archive with the pinned SHA-256; Employees is the header of `employees.sql` at e324b56 (note `Copyright (C) 2007,2008, MySQL AB` exactly as upstream writes it, which the retained
`UPSTREAM-NOTICE.txt` respaces).

They are switched on by `notice.enabled` and `notice.param` in `config/dialect-scripts.json` once the pinned datatug release can write a multi-line notice from a file: then the notice joins the inputs hash
(`noticeSha256`), `generate` passes the file, and `check` requires every notice line in the header as a `-- ` comment line. Until then nothing changes, and no script byte does.

For the provider re-run, the Employees attribution input in `dialect-scripts/manifest.json` should read (the notice file carries the rest):
`Employees sample database, Copyright (C) 2007,2008, MySQL AB, original data by Fusheng Wang and Carlo Zaniolo, current schema by Giuseppe Maxia, data conversion from XML to relational by Patrick Crews, https://github.com/datacharmer/test_db. Adapted by DemoDB: reduced 1,024-employee subset, converted to SQLite and to MySQL by DataTug. CC BY-SA 3.0 Unported, https://creativecommons.org/licenses/by-sa/3.0/legalcode`.
Providers should also add `dialect-scripts/** -text` to their `.gitattributes` in that run: with `core.autocrlf=true` a checkout would otherwise turn LF into CRLF and `check` would fail.

## `corpus.json` compatibility

`corpus.json` stays `demodb-corpus/draft-1` and the change is additive: `formatAvailability` gains the format `oracle`, the state `planned` and the origin `provider-script`, and `exports` gains the formats `mysql`
(for every dataset) and `upstream-mysql` (Chinook). A consumer must ignore formats, states and origins it does not know; the existing keys and meanings are unchanged. If a consumer cannot, bump the draft with the same change.

## Adding SQL Server later

Add the dialect to `config/dialect-scripts.json` (`"mssql": { "format": "sqlserver", "extension": "sqlserver.sql", ... }` with its own marker, client flags and image), pin the datatug release that has it,
declare `sqlserver` a `download` with origin `provider-script` for the datasets that get it, run `generate`, add a SQL Server leg to `served-formats-live.yml`
(`ACCEPT_EULA=Y` for the Developer edition is a licence acceptance that needs the founder's yes) and a loader to `scripts/verify-*-live.mjs`. The site code does not change.
Until then the matrix says `planned`, and the pages say "Planned", never "available". Oracle is planned the same way and has no generator yet.

## Chinook

Chinook ships lerocha's upstream scripts. The generated, verified MySQL script is at the canonical URL `/data/chinook.mysql.sql`. The upstream MySQL script
moved, unchanged, to `/data/upstream/chinook.mysql.sql`. All three upstream scripts (MySQL, PostgreSQL, SQL Server) are labelled "upstream (unverified, drops database)" on the pages: each starts by dropping and creating the
`Chinook` database and none is checked against the pinned fixture. The upstream PostgreSQL and SQL Server scripts keep their URLs. The published `/data/metadata/checksums.json` is rewritten at build time to match what is
served (the upstream script under `upstream/`, the generated files added), and a test compares every entry of every published checksums.json with the served bytes.

## Loading

```sh
mysql --default-character-set=utf8mb4 --skip-commands --skip-system-command --database <empty database> < <id>.mysql.sql
```

Verified on MySQL 8.4 LTS (8.4.11). The exporter's header states 8.0.16 as the minimum (where CHECK constraints are enforced); that has not been tested here, only 8.4. The first statement creates the marker table
`_demodb_import` and the last fills it: a row there means the load completed, and a second load into the same database stops at once. MySQL commits DDL, so a failed load
is not rolled back: drop the database and load again. `--skip-commands` needs mysql 8.4.6 or later and is a second line of defence: no data byte can start a script line.
