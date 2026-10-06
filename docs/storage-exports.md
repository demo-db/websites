# Preparing additional storage editions

`scripts/hosting-tools/storage_exports.py` reads a provider's pinned
`manifest.json` and SQLite fixture using the same source verification as the
PostgreSQL importer. It writes an inGitDB database and BigQuery load files to
an output directory; it never provisions or advertises a hosted service.
The provider contract hash must match `config/databases.json` before export.
The output path must be new or empty; a rerun refuses to overwrite or leave
stale collections from an earlier export.

```sh
python3 scripts/hosting-tools/storage_exports.py /path/to/provider /private/tmp/chinook-storage
ingitdb validate --path /private/tmp/chinook-storage/ingitdb --safe-diagnostics
ingitdb list collections --path /private/tmp/chinook-storage/ingitdb
```

Each source table is one native inGitDB `map[$record_id]map[$field_name]any`
JSON collection, with a bounded file count. The export manifest maps its
collection name back to the native table name and records the source SHA-256,
row count, columns, composite primary key, foreign keys, field encodings, and
checksums. Native primary keys become deterministic transport IDs. Tables
without a primary key use source row ordinals as transport IDs; these are not
native keys. Views include their source SQL and column names as provenance,
with no queryable inGitDB or BigQuery table implied.

Binary SQLite values are base64 encoded. `DECIMAL_TEXT` retains its source
lexical string in inGitDB; numeric BigQuery values are normalized to decimal
strings. Mixed SQLite storage classes carry type tags, and the BigQuery column
uses a JSON-encoded `STRING`. Export fails if an integer exceeds the range the
current inGitDB JSON reader can represent exactly. Every emitted value is
checked against its typed source value before the export completes.

BigQuery directories contain NDJSON and a table schema. Column names are
normalized for BigQuery; the manifest provides the reversible name mapping.
`NUMERIC` and `BIGNUMERIC` are selected by declared decimal precision and
scale, and wider decimals remain strings. The manifest's
`prepared-not-hosted` status is intentional. A BigQuery project, location,
cost policy, ingestion receipts, and query validation are required before
publishing any hosted storage entry.
