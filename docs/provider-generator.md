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
    "publisher": {"name": "Example", "url": "https://example.org/", "repository": "https://github.com/example/db"},
    "licences": {"model": "CC-BY-4.0", "meaning": "CC-BY-4.0"},
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

The provider manifest also pins `dataFile` and `source.databaseSha256` (the
SHA-256 of those exact SQLite bytes), source `repository`, immutable `revision`,
and `license`. Table descriptions belong in `tableDescriptions`, keyed by the
native SQLite name. Optional `columnDescriptions` maps native table names to
native column names and plain-language descriptions; they stay in schema
metadata alongside the original DDL.

`modelEntityAliases` and `modelPropertyAliases` are optional. Generated entity
aliases replace punctuation with underscores; a native entity name starting
with a digit needs an explicit `modelEntityAliases` entry. Generated property
aliases replace punctuation with underscores and prefix an underscore when a
native property starts with a digit. Collisions require an explicit alias.
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
ModelSpec entities with their native properties and no `key` field. Composite
primary and foreign keys retain their declared position.
Native table/view names, column defaults, generated-column markers, table/view
SQL, empty tables, and BLOB bytes are preserved in metadata or the unchanged
SQLite artifact. Source `integrity_check` and `foreign_key_check` must pass.
JSON and CSV encode BLOB values as base64; that encoding is described in
generated metadata. View rows are available as metadata previews,
but the generated OVDB descriptor only advertises the physical tables selected
by `generator.ovdb.recordsets`.

The output includes table JSON/CSV, an exact byte copy of the source SQLite
database, SQL dump, schema and provider contracts, ModelSpec JSON/HCL,
MeaningGraph YAML-compatible JSON, the publisher OVDB YAML-compatible JSON,
the public `ovdb-database.json`, and checksums. Provider CI should call this
tool from a pinned immutable website-repository commit, verify its published
script hash, run it, and fail on generated drift.

The per-file 25 MiB static-export limit is intentional. Large sources must
retain the full SQLite data. A future additive compression mode can publish a
deterministic gzip export next to its canonical path, with compressed and
decoded hashes in metadata and HTTP `Content-Encoding: gzip`; the website must
verify the browser-visible decoded bytes. If the compressed artifact still
exceeds the limit, use paged OVDB delivery or a separately reviewed chunked
download. Providers must not silently omit rows or tables to fit static hosting.
