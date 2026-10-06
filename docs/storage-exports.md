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

Install the Python YAML dependency and use a DataTug CLI build that supports
`db export` (the old installed CLI may only expose `db copy`):

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

The previously published Python-generated inGitDB editions can still be
checked with `validate_storage_exports.py`; new DataTug editions use
`validate_datatug_exports.py` and manifest format `demodb-storage-export/v2`.
