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

## Order of changes

1. The provider pull requests add `dialect-scripts/` (nothing else changes in a provider; the contract, the checksums and the model are untouched).
2. After they land, `config/databases.json` pins each provider's new commit in this repository (the contract SHA-256 does not change), and `config/derived-exports.lock.json` already holds the decoded hashes.
3. A new datatug release (for example the one carrying `dialect=mssql`) is a change of `config/dialect-scripts.json`, then `generate` in each provider, then new pins.

## Adding SQL Server later

Add the dialect to `config/dialect-scripts.json` (`"mssql": { "format": "sqlserver", "extension": "sqlserver.sql", ... }` with its own marker, client flags and image), pin the datatug release that has it,
declare `sqlserver` a `download` with origin `provider-script` for the datasets that get it, run `generate`, add a SQL Server leg to `served-formats-live.yml`
(`ACCEPT_EULA=Y` for the Developer edition is a licence acceptance that needs the founder's yes) and a loader to `scripts/verify-*-live.mjs`. The site code does not change.
Until then the matrix says `planned`, and the pages say "Planned", never "available". Oracle is planned the same way and has no generator yet.

## Chinook

Chinook ships lerocha's upstream scripts. The generated, verified MySQL script is at the canonical URL `/data/chinook.mysql.sql`. The upstream MySQL script
moved, unchanged, to `/data/upstream/chinook.mysql.sql` and is labelled "MySQL script, upstream (unverified, drops database)": it starts with
`DROP DATABASE IF EXISTS` and is not checked against the pinned fixture. The upstream PostgreSQL and SQL Server scripts keep their URLs and are
still the provider's files.

## Loading

```sh
mysql --default-character-set=utf8mb4 --skip-commands --skip-system-command --database <empty database> < <id>.mysql.sql
```

Requires MySQL 8.0.16 or later (CHECK constraints are enforced there); verified on MySQL 8.4 LTS. The first statement creates the marker table
`_demodb_import` and the last fills it: a row there means the load completed, and a second load into the same database stops at once. MySQL commits DDL, so a failed load
is not rolled back: drop the database and load again. `--skip-commands` needs mysql 8.4.6 or later and is a second line of defence: no data byte can start a script line.
