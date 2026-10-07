# Preparing additional storage editions

`scripts/hosting-tools/storage_exports.py` verifies a provider's pinned SQLite
fixture and contract, runs **DataTug's generic DALgo → inGitDB export**, checks
the resulting native collection files independently against the pinned source,
and prepares BigQuery NDJSON/schema files. It does not provision BigQuery.
The inGitDB files come from DataTug; Python writes only BigQuery files and a
provenance manifest. The output directory must be new or empty. A failed run
leaves the destination untouched.
The native directory includes `export-manifest.json` and a SHA-pinned
`native-parity-report.json` with the independent row and schema check results.

Install the Python YAML dependency and use DataTug CLI v0.61.1 or newer for
`db export` with portable collection IDs:

```sh
python3 -m venv /private/tmp/demodb-export-venv
/private/tmp/demodb-export-venv/bin/pip install -r scripts/hosting-tools/requirements.txt
/private/tmp/demodb-export-venv/bin/python scripts/hosting-tools/storage_exports.py \
  /path/to/provider /private/tmp/chinook-storage --datatug /path/to/datatug \
  --records-format json
/private/tmp/demodb-export-venv/bin/python scripts/hosting-tools/validate_datatug_exports.py \
  /path/to/provider /private/tmp/chinook-storage/ingitdb --report /private/tmp/chinook-parity.json
```

`--records-format` defaults to `json` and also accepts `jsonl`, `ingr`,
`csv`, and `yaml`. Each format keeps the same explicit transport IDs and
source-schema metadata. JSONL and CSV use the reserved `$ID` field; CSV uses
`json-v1` cells so NULL, empty strings, numbers, and quoted text remain
distinct. The independent parity checker decodes the selected native format
and checks each source row at its ID. The manifest records the chosen format.

The wrapper records the exact source fixture SHA-256, provider pin, DataTug
version, commit and binary SHA-256. It checks the source SHA again after
DataTug exits. Each table is an ID-keyed native inGitDB collection in a bounded
file count. Composite source primary keys form ordered transport IDs; keyless
tables use source row order and transport ordinals. These IDs are not extra SQL
columns. Source views retain their ordered names, columns and SQL as metadata;
they are not materialized in the target.
Native collection IDs keep ordinary source names. Names outside inGitDB's ID
alphabet, including Northwind's `Order Details`, use `dt_` plus lowercase hex
of the exact UTF-8 source name. The `dt_` prefix is reserved to avoid a
collision with a literal source name. `.ingitdb/source-collections.json`
records every native ID and original SQL name, and the export manifest hashes
that mapping. Native foreign-key targets use the native IDs; the original SQL
DDL and actions remain in source metadata.

The independent checker compares exact SQLite table DDL, ordered declared
columns and defaults, index terms including expressions/collations/partial
predicates, foreign-key groups and actions, source view definitions, native
field definitions, and every typed row at its transport ID. Decimal source
storage classes are checked against DataTug's sidecars. A changed record under
a different valid ID fails. The report distinguishes snapshot parity from
native SQL constraint enforcement. SQLite's source FK checker must report zero
orphans; source primary keys, UNIQUE, CHECK and FK semantics are metadata in
the native edition and are not enforced on subsequent inGitDB edits.
Use inGitDB CLI v0.70.0 or newer to validate and query these editions. That
release includes the inGitDB core v0.9.0 readers needed for JSONL, INGR, and
lossless CSV.

BigQuery directories contain NDJSON and table schemas. The manifest maps
normalized BigQuery field names to source names and records file checksums.
Declared exact decimals with known precision choose NUMERIC or BIGNUMERIC only
when their precision/scale fit; unbounded NUMERIC/DECIMAL/MONEY values remain
decimal strings. BigQuery remains prepared but unhosted until a project,
location, cost policy, ingestion and query receipts are available.

Each Downloads page also links a deterministic research snapshot ZIP. During
the site build, `research_snapshots.py` packages each pinned provider's checked
public exports, schema, model and meaning files, licences, provenance, and
example queries. It writes a sidecar manifest with per-file sizes and SHA-256
digests, plus a SHA-256 file for the archive. ZIP entry order, timestamps, and
permissions are normalized so repeated builds from the same pinned inputs
produce the same archive.

To verify a built research snapshot's split files:

```sh
python3 scripts/hosting-tools/research_snapshots.py verify \
  public/research-snapshots/chinook.manifest.json
```

The pinned SQLite providers can also produce deterministic full PostgreSQL
restore bundles for the six approved demo datasets (Chinook, Northwind, Pubs,
Sakila, AdventureWorks, and Employees). `postgres_seeds.py` reuses the
PostgreSQL converter, rejects source fixtures with foreign-key violations, and
records source provenance, complete per-table row counts, SQL checksums, and
transaction semantics. Bundle generation writes outside the repository; it
does not publish a database or commit dataset SQL:

```sh
python3 scripts/hosting-tools/postgres_seeds.py build \
  /path/to/provider-root --output /private/tmp/demodb-postgres-seeds
python3 scripts/hosting-tools/postgres_seeds.py verify \
  /path/to/provider-root /private/tmp/demodb-postgres-seeds
```

Each `<dataset-id>/seed.sql.gz` decompresses to plain SQL with one `BEGIN` and
`COMMIT`, without `psql` meta-commands. Its manifest identifies compressed and
decompressed byte counts and SHA-256 values, plus the pinned SQLite source
hash. SQL and SQLite byte sizes are not PostgreSQL logical-size measurements;
the sandbox service must measure the restored database before setting its
dataset-specific storage quota.

The previously published Python-generated inGitDB editions can still be
checked with `validate_storage_exports.py`; new DataTug editions use
`validate_datatug_exports.py` and manifest format `demodb-storage-export/v2`.
The Cloudflare Worker assets have a per-file size limit, so each ZIP is split
into deterministic 20 MiB parts. Download all `<dataset-id>.zip.part-####`
files and concatenate them in numeric order to recreate the archive. The
manifest lists every part's hash and byte count, along with the complete ZIP's
checksum. To verify the downloaded parts before assembly:

```sh
python3 scripts/hosting-tools/research_snapshots.py verify \
  public/research-snapshots/chinook.manifest.json
```
