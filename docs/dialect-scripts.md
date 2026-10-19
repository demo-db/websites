# Dialect SQL scripts (MySQL, SQL Server and Oracle)

A dialect script creates and fills one DemoDB dataset in a database engine. The MySQL, SQL Server and Oracle scripts of every dataset are written by the
DataTug faithful SQL-script exporter from the provider's pinned SQLite fixture, loaded into a real MySQL 8.4, SQL Server 2022 and Oracle Free 23ai and verified, then
served as the `mysql`, `sqlserver` and `oracle` formats at `/data/<id>.mysql.sql`, `/data/<id>.sqlserver.sql` and `/data/<id>.oracle.sql`. Each file is labelled "DemoDB contract edition, identical to the SQLite/CSV/JSON":
it holds the same tables and rows as the SQLite, CSV and JSON downloads, and what the engine cannot carry exactly is listed in the header and in the exporter's report (for example views; the empty text, which Oracle stores as NULL;
a text column widened so that the columns of a foreign key share one type; a foreign key action Oracle or SQL Server lacks; one index Oracle refuses). The SQL Server format is `sqlserver` (the dialect key of the exporter is `mssql`).

## Where things live

| What | Where |
|---|---|
| The generator pin | `config/dialect-scripts.json`: datatug release tag `v0.103.4` (never `latest`; the release that carries `dialect=mssql` and `dialect=oracle`), the SHA-256 of the checksums file and of every platform asset, the edition label, and the dialects (`mysql`, `mssql` with format `sqlserver`, `oracle`), each with its digest-pinned engine image |
| The scripts | each provider repository, `dialect-scripts/<id>.mysql.sql`, `<id>.sqlserver.sql` and `<id>.oracle.sql` (plain up to 25 MiB; above that deterministic gzip `.sql.gz`, and `.gz.part-NNNN` pieces above 25 MiB again, exactly like the provider exports; AdventureWorks is about 100 MiB decoded and about 19 MiB gzip-encoded per dialect) |
| What decides the bytes | `dialect-scripts/manifest.json` of the provider: the provider-written `attribution`, the recorded `inputs` (decoded SQLite SHA-256, datatug pin, edition, licence from `manifest.json` `source.license`, attribution), their hash `inputsSha256`, the stored files with their SHA-256, the decoded size and SHA-256, the exporter's report and the verification run (engine image digest and version, client version, tables, rows, values compared, differences, the row count of every table read back from the engine, load and verifier seconds) |
| The exporter's report | `dialect-scripts/<id>.<dialect>.report.json`: every warning (what was not carried exactly), without any local path |
| The served bytes | the site reads those files at the revision pinned in `config/databases.json`, `scripts/dialect-scripts.mjs` verifies them, and `config/derived-exports.lock.json` pins the decoded SHA-256 and size (origin `provider-script` in `config/format-matrix.json`) |

The provider files are outside `artifacts/`, so the providers' own generators, which checksum everything under `artifacts/`, are not involved.

```sh
# Refresh one provider checkout, for every dialect of the config (or one: --dialect mysql|mssql|oracle). Runs the pinned datatug only when the inputs hash differs from the manifest (the guard).
# The release is downloaded from the public datatug/datatug release (the same assets and checksums file as the private
# datatug-cli release), and its SHA-256 and the checksums file are verified before it runs: a mismatch is an error.
node scripts/dialect-scripts.mjs generate --provider ../chinook --tools /tmp/demodb-tools [--dialect oracle] [--force]

# Needs neither the datatug binary nor Docker: the required lane.
node scripts/dialect-scripts.mjs check --providers /path/to/providers      # directory holding <id> checkouts

# Regenerates every script with the pinned datatug and compares the bytes with the committed ones.
node scripts/dialect-scripts.mjs regenerate-check --providers /path/to/providers

# Loads every MySQL script into a digest-pinned mysql:8.4 container and compares tables, columns, keys, counts and the marker row
# with the SQLite fixture. Needs Docker. This is the leg of the non-required served-formats-live workflow.
node scripts/verify-mysql-live.mjs --providers /path/to/providers

# Loads every script of one dialect into a throwaway container of the digest-pinned engine image (mysql, mssql or oracle), with the client and the flags the header
# recommends; a second load must stop at the marker table; the row count of every table is read back and compared with the SQLite fixture; the marker row is checked;
# with --crossverify <datatug-cli checkout at the pinned release> the cross-engine verifier (internal/crossverify) compares every value; --out writes one result file per script.
node scripts/verify-engines-live.mjs --providers /path/to/providers --dialect oracle --crossverify /path/to/datatug-cli --out /tmp/results

# Stamps a result file onto the stored script of one provider.
node scripts/dialect-scripts.mjs record-verification --provider ../chinook --dialect oracle --result-file /tmp/results/chinook.oracle.verification.json
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
5. A new datatug release (for example v0.103.4, which added `dialect=mssql` and `dialect=oracle`, or an earlier one with the multi-line licence notice below) is a change of `config/dialect-scripts.json`, then `generate` and a
   verification record in each provider, then new pins. A release changes the inputs hash of **every** dialect, so the MySQL scripts are regenerated and verified again with it (v0.103.4 changed their header release and marker row only).

`record-verification` stamps the numbers of a cross-engine verifier run onto the stored script (`node scripts/dialect-scripts.mjs record-verification --provider <checkout> --dialect <dialect> --result-file <file>`, or `--tables N --rows N --values N --differences 0 --warnings N`).
It refuses a run with differences, a run of another image than the one pinned in `config/dialect-scripts.json`, and row counts that are not the exporter's own report, and `check` refuses a script whose manifest has no clean verification of exactly its bytes: a regenerated script is not publishable until one is recorded.

## Release: what goes live, and how

**Gate: do not land the websites pull request until the owner confirms that the Cloudflare rate-limit incident on `*.demodb.dev` (Error 1027) is closed.** Landing it triggers `pnpm run deploy:hosts` and then `scripts/smoke-live.mjs` against `*.demodb.dev`, which downloads every complete export listed in the corpus, including two new AdventureWorks sets of about 19 MiB each.

Nothing is published by a pull request. The site is built and deployed by `.github/workflows/deploy.yml` on a push to `main` of this repository (the `deploy` job: `pnpm build`, `pnpm test`, `pnpm run deploy:hosts`, then `node scripts/smoke-live.mjs`),
so the release is the sequence in the previous section: land the six provider pull requests (each with a merge commit, so that the pinned heads are on `main`), re-pin if one was squashed, then land the websites pull request.
On that push every host gets its new bundle (`demodb-chinook`, `-northwind`, `-pubs`, `-sakila`, `-adventureworks`, `-employees`, assets-only Workers) and these URLs appear (the same file names on each host):

| Host | New downloads |
|---|---|
| `https://chinook.demodb.dev` | `/data/chinook.sqlserver.sql` (generated; lerocha's upstream script moves to `/data/upstream/chinook.sqlserver.sql`), `/data/chinook.oracle.sql`; `/data/chinook.mysql.sql` is regenerated |
| `https://northwind.demodb.dev`, `https://pubs.demodb.dev`, `https://sakila.demodb.dev`, `https://employees.demodb.dev` | `/data/<id>.sqlserver.sql`, `/data/<id>.oracle.sql`; `/data/<id>.mysql.sql` is regenerated |
| `https://adventureworks.demodb.dev` | the same two, but as chunked gzip like every other AdventureWorks complete-database file: there is **no** `/data/adventureworks.sqlserver.sql` or `.oracle.sql` URL (it answers 404). The manifests are `https://adventureworks.demodb.dev/data/adventureworks.sqlserver.sql.parts.json` and `.../adventureworks.oracle.sql.parts.json` (`demodb-chunked-export/v1`, one gzip part of about 19 MiB each at `/data/adventureworks.<format>.sql.gz.<hash>.part-1`, 105 MB decoded); a client joins the parts and gunzips them. Its MySQL script already works this way (`adventureworks.mysql.sql.parts.json`) |

`/data/<id>.mysql.sql` changes in its release line and marker row only. The corpus (`/data/metadata/corpus.json`, `formatAvailability` and `exports`) lists the two new formats per dataset, and the dataset and download pages show them. The post-deploy `smoke-live.mjs` is the repository's own live check and downloads every complete export listed in the corpus;
it checks MySQL scripts specifically (and the upstream Chinook MySQL URL), so SQL Server and Oracle are covered there by the generic size and SHA-256 comparison of the corpus only.

## What `check` refuses

Besides the hashes, `check` lints the committed script the way the client of its engine reads it, so that a re-hashed manifest cannot hide an edit. For every dialect: no CR or NUL; every line starts with a token the exporter writes
(an indented line is a column or key definition, or a line of a generated PL/SQL block); no `/*` or mid-line `--` comment; no `--` that is not followed by a space or the end of the line; no raw line break inside a string or a quoted name; the contract-edition label, the dataset, the licence of the provider manifest,
the attribution, the datatug release and the SQLite SHA-256 in the header; the header's recommended client flags; the marker table first and its row last; the completion comment. It also hashes the provider's SQLite file when the file is present. The comments in the header are free text and the client ignores a comment line.

- **MySQL** (client `mysql`): no byte order mark; no backslash outside a `--` comment line; no `#` comment; nothing after a semicolon on its line (`COMMIT; \! cmd`).
- **SQL Server** (client `sqlcmd -X -x -b -f 65001 -i`): the byte order mark exactly once at the start (the file is read with `-i`, never a redirect); a `GO` line is exactly `GO` (never `GO 100000`); no `:r`, `!!`, `EXIT`, `QUIT`, `RESET` or `ED` line start; no `$(` outside a comment line (sqlcmd would substitute a variable without `-x`).
- **Oracle** (client `sqlplus` with `NLS_LANG=.AL32UTF8`): no byte order mark; `SET DEFINE OFF` is the first statement; no line over 2,300 characters (SQL*Plus refuses a longer line and goes on); no statement line ending in a hyphen (SQL*Plus drops it and joins the next line); no `&` followed by a non-blank in the header; a `/` line is exactly `/`; no `@`, `@@`, `HOST`, `!`, `REM`, `PROMPT` or `SPOOL` line start.

The lint reads a whole script (100 MiB for AdventureWorks) in under a second.

## Licence notices in the headers

A script travels without the site that carries its licence, so every header carries the whole notice its licence asks for: MIT (Chinook, Northwind, Pubs, AdventureWorks) the copyright line, the permission notice and the
disclaimer; BSD-3-Clause (Sakila) the copyright, the three conditions and the disclaimer; CC BY-SA 3.0 (Employees) the verbatim copyright, credits, title, source, the adaptation statement and the licence URI.
The text is in `config/dialect-notices/<id>.txt`, written verbatim from the upstream licence files (only trailing spaces at line ends removed). It was compared with the upstream repositories at the pinned revisions: Chinook (`lerocha/chinook-database` at 7f67772),
Northwind (`jpwhite3/northwind-SQLite3` at 4f56e7f) and the Microsoft repository (`microsoft/sql-server-samples` at beaab06, Pubs and AdventureWorks) are byte for byte the retained `data-source/` licence files; Sakila's header is
identical to `sakila-schema.sql` of the archive with the pinned SHA-256; Employees is the header of `employees.sql` at e324b56 (note `Copyright (C) 2007,2008, MySQL AB` exactly as upstream writes it, which the retained
`UPSTREAM-NOTICE.txt` respaces).

`generate` passes the file to datatug as `notice-file=<percent-encoded absolute path>` (datatug v0.103.4, `notice.param` in `config/dialect-scripts.json`). Datatug reads it as UTF-8 (at most 16 KiB, not empty) and writes it after the
`Licence:` and `Attribution:` lines and a bare `--` line, one `-- ` comment line per notice line. It is verbatim except: CR, CR LF, VT, FF and the other line separators end a line; other control characters, a byte order mark and bidirectional controls become
spaces; **a tab becomes four spaces**; **`*/` and `/*` get a space between the two characters**; trailing spaces and the blank lines at both ends are dropped (a blank line inside is a bare `--`). A notice line such as `GO` or `\! cmd` therefore stays a comment.
The notice files here are LF text with no control character except tab (`generate` refuses the rest).

A dialect may need other words: `config/dialect-notices/<id>.<dialect>.txt` wins over `<id>.txt` for that dialect. Only Employees has such files (`employees.mssql.txt`, `employees.oracle.txt`): its adaptation sentence says which script the notice travels in ("this SQL Server script", "this Oracle script").
Two more neutralisations apply in the header of the dialects that need them, and `check` models both: for `mssql` `$(` becomes `$ (`, for `oracle` `&` becomes `& ` (the header comes before `SET DEFINE OFF`). No committed notice contains either, a test fails if one ever does without the rule, and the rules were compared with the real exporter output on a hostile notice (tabs, `*/`, `$(HOME)`, `&`, a trailing hyphen, blank runs).

The notice joins the inputs hash (`noticeSha256`), and `check` requires the header to carry it exactly: the line after the `Attribution:` line is `--`, then the expected comment lines one by one. A notice cut short, reordered or changed fails, in the required lane.
Datatug also **cuts every single header line at 400 bytes and ends it with `...`** (the `Attribution: ` prefix counts) and folds runs of white space; an attribution, licence or edition that long would reach the header shortened without a word, so `generate` and `check` refuse
one over 400 bytes or with control characters or double spaces. This is why the Employees attribution is a short line and the credits live in the notice.

The Employees attribution line (provider `dialect-scripts/manifest.json`) is `Employees sample database, Copyright (C) 2007,2008, MySQL AB, https://github.com/datacharmer/test_db, CC BY-SA 3.0 Unported. Reduced 1,024-employee subset adapted by DemoDB (full notice below)`;
the verbatim credits, the adaptation and the licence URI are in its notice. Every provider has `dialect-scripts/** -text` in `.gitattributes`: with `core.autocrlf=true` a checkout would otherwise turn LF into CRLF and `check` would fail.

## `corpus.json` compatibility

`corpus.json` stays `demodb-corpus/draft-1` and the change is additive: `formatAvailability` gains the format `oracle`, the state `planned` and the origin `provider-script`, and `exports` gains the formats `mysql`, `sqlserver` and `oracle`
(for every dataset) and `upstream-mysql` and `upstream-sqlserver` (Chinook). A consumer must ignore formats, states and origins it does not know; the existing keys and meanings are unchanged. If a consumer cannot, bump the draft with the same change.

## Adding another dialect, or a CI leg for SQL Server and Oracle

Another dialect: add it to `config/dialect-scripts.json` (`format`, `extension`, `marker`, `clientFlags`, `headerHint`, a digest-pinned `serverImage`), teach `LINE_STARTS`, `RULES` and the marker checks of `scripts/dialect-scripts.mjs` its client (a test fails while `KNOWN_DIALECTS` and the config disagree),
declare the format a `download` with origin `provider-script` in `config/format-matrix.json`, run `generate`, load and verify it with `scripts/verify-engines-live.mjs`, `record-verification`, and pin the provider heads. The site code does not change.

The SQL Server and Oracle loads are **not** a leg of `served-formats-live.yml`: that needs `ACCEPT_EULA=Y` for the SQL Server Developer image and the Oracle Free Use Terms accepted in a workflow (datatug-cli's journeys do both for automated testing only, and its documentation cites the 2026-10-16 decision of the owner; this repository has no such record),
so the loads were run locally by `scripts/verify-engines-live.mjs` and recorded in the manifests. Adding the legs is a small change once that decision is recorded here.

## Chinook

Chinook ships lerocha's upstream scripts. The generated, verified MySQL and SQL Server scripts are at the canonical URLs `/data/chinook.mysql.sql` and `/data/chinook.sqlserver.sql`. The upstream MySQL and SQL Server scripts
moved, unchanged, to `/data/upstream/chinook.mysql.sql` and `/data/upstream/chinook.sqlserver.sql`. All three upstream scripts (MySQL, PostgreSQL, SQL Server) are labelled "upstream (unverified, drops database)" on the pages: each starts by dropping and creating the
`Chinook` database and none is checked against the pinned fixture. The upstream PostgreSQL script keeps its URL. The published `/data/metadata/checksums.json` is rewritten at build time to match what is
served (the upstream scripts under `upstream/`, the generated files added), and a test compares every entry of every published checksums.json with the served bytes.

## Loading

```sh
mysql --default-character-set=utf8mb4 --skip-commands --skip-system-command --database <empty database> < <id>.mysql.sql
sqlcmd -S <server> -d <empty database> -X -x -b -f 65001 -i <id>.sqlserver.sql          # -i, not a redirect: the file starts with a byte order mark
NLS_LANG=.AL32UTF8 sqlplus -L -S <user>/<password>@<service> @<id>.oracle.sql < /dev/null
```

A file stored as `.sql.gz` (AdventureWorks) is decoded first (`gunzip`).

**MySQL.** Verified on MySQL 8.4 LTS (8.4.11). The exporter's header states 8.0.16 as the minimum (where CHECK constraints are enforced); that has not been tested here, only 8.4. The first statement creates the marker table
`_demodb_import` and the last fills it: a row there means the load completed, and a second load into the same database stops at once. MySQL commits DDL, so a failed load
is not rolled back: drop the database and load again. `--skip-commands` needs mysql 8.4.6 or later and is a second line of defence: no data byte can start a script line.

**SQL Server.** Verified on SQL Server 2022 Developer (16.0.4305.5, CU27-GDR, default collation `SQL_Latin1_General_CP1_CI_AS`, `linux/amd64` image run under emulation on an Apple-silicon Mac). The header states SQL Server 2016 as the minimum; that has not been tested here. The script is one transaction (`SET XACT_ABORT ON`, `BEGIN TRANSACTION`, a `GO` after every statement, every batch guarded by `IF @@TRANCOUNT=0 SET NOEXEC ON`):
a failed load rolls back and leaves the database as it was. The first statement creates `_demodb_import` and a second load stops there. Text comparison is case-insensitive and ignores trailing spaces by default, so a key that differs only that way in SQLite would stop the load; the six datasets have none.

**Oracle.** Verified on Oracle AI Database 26ai Free 23.26.3 (`COMPATIBLE` 23.6.0, `AL32UTF8`, `MAX_STRING_SIZE=STANDARD`) with SQL*Plus 23.26.3, natively on arm64. Oracle Database 23ai or later is required (the first block raises ORA-20001 below it; not run on an older server). Load into an empty schema of a user that may create tables and sequences and has a quota; the script creates no user.
The client must say UTF-8 (`NLS_LANG=.AL32UTF8`), else the first block stops with ORA-20003. Oracle commits DDL, so the load is not transactional: the last block counts every table's rows and its keys, checks and indexes before it writes the marker row, so a row there means a complete load. A failed load leaves the tables it created: drop them and the marker, and load again. SQLcl, SQL Developer, Windows and non-default `NLS_*` settings are untested.

## Verification record (2026-10-19, datatug v0.103.4)

Every committed script was loaded into a clean database or schema of the digest-pinned image with the client and flags its header recommends, a second load stopped at the marker table (MySQL also loaded with the plain client), the row count of every table was read back from the engine and equals the SQLite fixture, the marker row names the dataset, the SQLite SHA-256, the release, the table count and the row count, and the cross-engine verifier of datatug-cli v0.103.4 (`internal/crossverify`) reported no difference. The numbers are in each provider's `dialect-scripts/manifest.json`.

| Engine | Image |
|---|---|
| MySQL 8.4.11 | `mysql:8.4@sha256:24989179f58856db763f418010c1169fecc944e3ec1ea7e921572d83eb070f70` |
| SQL Server 2022 (16.0.4305.5) | `mcr.microsoft.com/mssql/server:2022-latest@sha256:cf8f0ab2ebe61feec2eed2629061a07d247f791c2a8ddda74a4ac9f06a291718` |
| Oracle AI Database 26ai Free 23.26.3 | `gvenzl/oracle-free:23-slim@sha256:6d61d267a3b978c24c5ac1790e62e927416a0aec446bd86e4b3a1527562757bd` |

| Dataset | Tables | Rows | Values compared | MySQL load | SQL Server load | Oracle load |
|---|---|---|---|---|---|---|
| chinook | 11 | 15,607 | 66,439 | 0.3 s | 1.9 s | 2.9 s |
| northwind | 13 | 3,310 | 25,004 | 0.2 s | 0.8 s | 2.6 s |
| pubs | 11 | 255 | 1,472 | 0.2 s | 0.4 s | 1.1 s |
| sakila | 16 | 47,268 | 292,767 | 0.7 s | 7.2 s | 5 s |
| adventureworks | 71 | 759,240 | 7,110,291 | 10.6 s | 145.7 s | 73.1 s |
| employees | 6 | 13,584 | 56,366 | 0.1 s | 1.1 s | 1.7 s |

The verifier compares every value of the SQLite source with the engine, modelling exactly the normalisations the exporter reports (exact decimals for REAL, the Oracle empty text as NULL, columns widened to text); anything else is a difference. It does not compare the text of a default or of a `CHECK`.
The numbers come from one run on one Apple-silicon Mac (SQL Server under emulation, so its times are slower than native), not from a workflow of this repository.
