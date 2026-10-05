# Browser-local database snapshots

Each database Downloads page offers an explicit browser import. No data export is fetched before the visitor starts. The site imports only physical tables that have a provider-declared JSON export; native views remain in the schema and are never presented as materialized tables.

The importer reads each table as a stream, verifies the decoded byte count and SHA-256 from the pinned provider checksums, and compares the final row count with the native schema. It writes bounded batches to a staging IndexedDB database and makes that database active only after every table passes verification. A later attempt reuses completed tables only after their checksum and row count match; an interrupted or failed table is cleared and downloaded again. Cancel keeps the staging copy for a later retry; Remove local copy deletes both staged and active data.

Primary keys use their source columns in declared order, including composite keys. A native table without a key uses IndexedDB's out-of-line numeric row ordinal in provider JSON export order. That export order is for local traversal and does not claim to preserve native source insertion order. Foreign-key indexes use native constraints and column order for record traversal. This is a read-only local snapshot; it does not mutate the downloadable database or provider files.

Storage is estimated before importing, with working room included. The interface remains opt-in and imports one table at a time. Large exports therefore do not become an automatic first-page download. Gzip exports are stored encoded by the Worker, served with their original media type and `Content-Encoding: gzip`, then verified in the browser after normal Fetch decoding against the provider's decoded size and digest. Build-time provider checksum validation covers the encoded bytes.

The public [`/corpus.json`](https://demodb.dev/corpus.json) index is generated from the same pinned contracts. It lists native tables and views, ordered keys, foreign-key metadata, public export URLs and hashes, model/meaning references, provenance, and representation notes. It omits row previews. Per-database `/schema.json` remains the richer compatibility schema and may include sample rows.

IndexedDB is isolated by browser origin. A snapshot imported on a database subdomain is not shared with the catalogue or other database subdomains. Visitors can clear the local copy at any time from the same database site's Downloads page.

JSON exports and IndexedDB keep decimal columns as fixed-point strings, including trailing zeroes. The shared table grid displays those strings unchanged and compares valid decimal lexemes exactly for sorting; malformed values sort in a separate lexical class. CSV and JSON downloads remain provider-generated representations.
