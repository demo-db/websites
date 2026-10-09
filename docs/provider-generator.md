# Shared provider generator

`scripts/provider-tools/generate.py` is the shared, standard-library-only
generator for DemoDB SQLite providers. Run it from any checkout with:

```sh
python3 scripts/provider-tools/generate.py --root /path/to/provider
```

The provider owns its `manifest.json`, pinned source database, and semantic
inputs. Add a `generator` object to the manifest:

```json
{
  "generator": {
    "nativeObjectsFile": "metadata/native-objects.json",
    "publisher": {"name": "Example", "url": "https://example.org/", "repository": "https://github.com/example/db"},
    "licences": {"model": "CC-BY-4.0", "meaning": "CC-BY-4.0"},
    "emitModelSpdxLicense": true,
    "model": {"address": "modelspec://github.com/example/db/0.1.0", "moduleId": "example-db", "name": "Example_DB", "version": "0.1.0"},
    "modelEntityAliases": {"HumanResources.Employee": "HumanResources_Employee"},
    "modelPropertyAliases": {"HumanResources.Employee": {"Employee ID": "Employee_ID"}},
    "ovdb": {
      "query": true,
      "deployment": {"engine": "openvaultdb-go", "url": "https://cloud.openvaultdb.com/ovdb/db/example-db", "discovery": "https://example-db.demodb.dev/.well-known/openvaultdb"},
      "recordsets": ["HumanResources.Employee"]
    },
    "meaning": {
      "id": "example-db", "address": "meaning://github.com/example/db", "name": "Example DB", "description": "Example database concepts", "license": "CC-BY-4.0",
      "core": {"address": "meaning://github.com/meaninggraph/core", "revision": "0000000000000000000000000000000000000000"},
      "concepts": [{"id": "employee", "kind": "entity", "label": "Employee", "description": "An employee", "bindings": [{"recordset": "HumanResources.Employee", "role": "entity"}]}]
    }
  }
}
```

`emitModelSpdxLicense` is an optional boolean, false when omitted. When true,
the generated ModelSpec HCL includes an `SPDX-License-Identifier` declaration
using the SPDX identifier in `generator.licences.model`. This declaration applies to
that generated HCL model artifact only; it does not change ModelSpec JSON,
source-data licensing, or the repository's root `LICENSE` file.

The provider manifest also pins `dataFile` and `source.databaseSha256` (the
SHA-256 of the decoded SQLite bytes), source `repository`, immutable `revision`,
and `license`. A large source may be stored as a gzip file in Git: set
`source.inputCompression` to `gzip` and `source.inputSha256` to the hash of the
compressed `dataFile`; `databaseSha256` still identifies the exact decoded
SQLite fixture. Table descriptions belong in `tableDescriptions`, keyed by the
native SQLite name. Optional `columnDescriptions` maps native table names to
native column names and plain-language descriptions; they stay in schema
metadata alongside the original DDL.

`modelEntityAliases` and `modelPropertyAliases` are optional. Their names are
historical: the first renames the ModelSpec record type generated for a native
table, the second renames the ModelSpec fields generated for a table's native
columns. Generated record type names replace punctuation with underscores; a
native table name starting with a digit needs an explicit `modelEntityAliases`
entry. Generated field names replace punctuation with underscores and prefix an
underscore when a native column name starts with a digit. Collisions require an
explicit alias.
Meaning bindings name native table and column names; the generator resolves
those to ModelSpec aliases. Bindings use
the MeaningGraph roles `entity`, `identifier`, `display-name`, `foreign-key`,
or `value`. A bare `of`, `extends`, `valuesOf`, measure input, or dimension
reference names a local concept when it exists; otherwise it resolves against
the pinned core revision. Full `meaning://` references are retained. Concepts
can declare labels, synonyms, units, known values, and measures using the
MeaningGraph draft-1 fields.

The generator refuses a source hash mismatch, unsafe output path, invalid
semantic reference, unrepresented foreign-key target, or static export over
25 MiB. It never invents a primary key: physical tables without one remain
ModelSpec record types with their native fields and no `key` field. Composite
primary and foreign keys retain their declared position.
Native table/view names, column defaults, generated-column markers, table/view
SQL, empty tables, and BLOB bytes are preserved in metadata or the unchanged
SQLite artifact. The schema metadata distinguishes `primaryKey`, full-column
`uniqueKeys`, and all inspected `uniqueIndexes`; partial or expression indexes
stay in `uniqueIndexes` with their SQLite index SQL and are not promoted to
simple unique keys. `uniqueKeys: []` means no representable full-column
non-primary unique key was found. Source `integrity_check` and
`foreign_key_check` must pass.
If `generator.nativeObjectsFile` is set, it must point to a pinned
`demodb-native-sqlserver-metadata/draft-1` JSON input. Its native `views` are
preserved in `metadata/schema.json.sourceViews`, and the input file hash and
byte count are added to `metadata/checksums.json`. Each source view keeps its
original SQL definition and SQLite compatibility status. The derived
`availableAsSqliteView` flag is true only when the named recordset exists as a
SQLite view in the fixture. Source-only definitions are never added to SQLite
recordsets, row previews, static exports, or OVDB query capabilities.
JSON and CSV encode BLOB values as base64; that encoding is described in
generated metadata. View rows are available as metadata previews,
but the generated OVDB descriptor only advertises the physical tables selected
by `generator.ovdb.recordsets`.

The output includes table JSON/CSV, the exact decoded SQLite database bytes,
SQL dump, schema and provider contracts, ModelSpec JSON/HCL,
MeaningGraph YAML-compatible JSON, the publisher OVDB YAML-compatible JSON,
the public `ovdb-database.json`, and checksums. Provider CI should call this
tool from a pinned immutable website-repository commit, verify its published
script hash, run it, and fail on generated drift.

## ModelSpec spelling

The generated ModelSpec model is written in ModelSpec's current spelling:

| | HCL (`model/<id>.modelspec.hcl`) | JSON (`model/<id>.modelspec.json`) |
|---|---|---|
| format identifier | none | `"modelspec": "1.0-draft-2"` |
| record type | `record "Invoice" { … }` | key `records` |
| member of a record type | `field "total" { … }` | key `fields` |
| reference to another record type | `record = "Customer"` | `"record": "Customer"` |

The earlier spelling (`entity`, `property`, `entity =`; `1.0-draft` with
`entities`, `properties`, `entity`) is no longer written. The two files carry
the same words, and `modelspec export --check` accepts the pair. Tools that read
the current spelling are `modelspec` 0.2.0 and `meaninggraph` 0.3.0; earlier
releases refuse it.

Other formats keep their own words, which this spelling does not change: the
MeaningGraph file uses the concept kind `entity`, the binding key `property` and
the roles `entity`, `identifier`, `display-name`, `foreign-key` and `value`; the
publisher manifest `ovdb.yaml` (`ovdb-manifest/draft-1`) lists the recordsets
whose record type has another name under `recordset_entities`; the public
descriptor `ovdb-database.json` and `metadata/schema.json` carry `modelEntity`
per recordset, and `metadata/schema.json` carries `modelProperty` on a column
whose field name differs from the native one. The generator reads `records` of
the model it has just built to fill `recordset_entities`.

### Moving a provider to a newer generator revision

A provider pins the generator by commit and by the SHA-256 of `generate.py` and of
`schemas/ovdb-database-draft-1.schema.json` (in its CI workflow). The generator
refuses a provider whose own copy of that schema file differs from the shared one
("differs from the shared schema pin"), and writes the shared file itself when the
provider has none. A provider that moves its pin therefore:

1. changes the commit and both SHA-256 values in its workflow to those of the new
   revision, and either copies `schemas/ovdb-database-draft-1.schema.json` from
   that revision or deletes its copy before the first run;
2. moves its `modelspec` pin to 0.2.0 and its `meaninggraph` pin to 0.3.0;
3. runs the generator and commits the result. Besides the schema copy, the files
   that change are the two model files and `metadata/checksums.json`, which pins
   their bytes and the schema's.

The 25 MiB limit applies to every checked-in generated file. An export above
the limit is deterministic-gzipped at level 9 with a zero timestamp. If the
compressed bytes fit, the contract keeps the canonical logical `path` and adds
`encodedPath`, `compression: "gzip"`, encoded `bytes`/`sha256`, and decoded
`decodedBytes`/`decodedSha256`. The checksum entry is keyed by `encodedPath`
and carries the same compression and decoded-hash fields. If the gzip stream
also exceeds 25 MiB, it is split into ordered `.part-0001`, `.part-0002`, …
files. In that case `exports[].chunks` lists each part's path, bytes, and
SHA-256; the export's byte count and hash cover the concatenated gzip stream.
Consumers must verify every part, concatenate in order, verify the combined
gzip hash, decompress, and verify the decoded size and hash before using or
offering the canonical asset. Providers never drop rows or tables to fit
static hosting; if a consumer cannot assemble chunks, it must use the live
read-only OVDB API rather than present a partial download.
