#!/usr/bin/env python3
"""Build deterministic, full PostgreSQL restore bundles from pinned DemoDB fixtures.

The generated SQL comes from ``postgres_samples`` so schema adaptation and row
serialization stay identical to the existing PostgreSQL importer. Bundles are
written outside the repository by default; no fixture SQL is checked in.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

import postgres_samples as pg


FORMAT = "demodb-postgres-seed"
FORMAT_VERSION = 1
DATABASE_ID = re.compile(r"^[a-z][a-z0-9-]{0,39}$")
SUPPORTED_DATASETS = frozenset({"adventureworks", "chinook", "employees", "northwind", "pubs", "sakila"})


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _canonical(data: Any) -> bytes:
    return (json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")


def _source_fk_check(snapshot: pg.Snapshot) -> list[dict[str, Any]]:
    rows = snapshot.db.execute("PRAGMA foreign_key_check").fetchall()
    return [{"table": row[0], "rowid": row[1], "parent": row[2], "fkId": row[3]} for row in rows]


def _fixture_path(provider_root: Path, manifest: dict[str, Any], loaded_path: Path) -> str:
    root = provider_root.resolve()
    declared = manifest.get("dataFile")
    if isinstance(declared, str):
        candidate = (root / declared).resolve()
        if candidate.is_relative_to(root) and candidate.is_file():
            return candidate.relative_to(root).as_posix()
    if loaded_path.is_relative_to(root):
        return loaded_path.relative_to(root).as_posix()
    for name in ("decoded.sqlite", "source.sqlite", "source.sqlite.gz"):
        candidate = root / name
        if candidate.is_file():
            return name
    raise pg.ImportError("cannot identify the SQLite fixture path inside the provider root")


def build(provider_root: Path, output_root: Path) -> dict[str, Any]:
    """Create one full-data SQL restore bundle and its machine-readable manifest."""
    manifest, source_path, source_sha, source_bytes, temporary = pg.load_source(provider_root)
    database_id = manifest["id"]
    if not DATABASE_ID.fullmatch(database_id):
        raise pg.ImportError("provider id is not safe for an artifact directory")
    if database_id not in SUPPORTED_DATASETS:
        raise pg.ImportError(f"provider {database_id!r} is not in the approved six-dataset seed allowlist")
    try:
        snapshot = pg.inspect(provider_root)
        try:
            fk_errors = _source_fk_check(snapshot)
            if fk_errors:
                raise pg.ImportError(f"source foreign_key_check found {len(fk_errors)} violations")
            sql = pg.postgres_sql(snapshot).encode("utf-8")
            source_tables = {table["name"]: table for table in snapshot.tables}
            table_entries = []
            for name in sorted(source_tables, key=lambda value: value.casefold()):
                table = source_tables[name]
                table_entries.append({
                    "name": name,
                    "sourceRows": snapshot.row_count(name),
                    "retainedRows": snapshot.row_count(name),
                    "prunedRows": 0,
                    "primaryKey": [column["name"] for column in sorted(table["columns"], key=lambda col: col["pk"]) if column["pk"]],
                    "foreignKeys": len({int(row[0]) for row in table["foreign_keys"]}),
                })
            # Separate data INSERT bytes from schema/index/view/metadata bytes
            # for a transparent SQL-size proxy; the runtime database size must
            # still be measured after restore.
            data_bytes = sum(len(line.encode("utf-8")) + 1 for line in sql.decode("utf-8").splitlines()
                             if line.startswith("INSERT INTO "))
            schema_bytes = len(sql) - data_bytes
            compressed = gzip.compress(sql, compresslevel=9, mtime=0)
            # Normalize the gzip OS header byte for cross-platform stability.
            if len(compressed) >= 10:
                compressed = compressed[:9] + b"\xff" + compressed[10:]
            out = output_root / database_id
            out.mkdir(parents=True, exist_ok=True)
            sql_path = out / "seed.sql.gz"
            sql_path.write_bytes(compressed)
            source_info = manifest.get("source", {})
            provenance = {
                "providerId": database_id,
                "repository": source_info.get("repository") or source_info.get("url"),
                "revision": source_info.get("revision") or source_info.get("commit"),
                "manifestPath": "manifest.json",
                "fixturePath": _fixture_path(provider_root, manifest, source_path),
                "manifestDataFile": manifest.get("dataFile"),
                "fixtureSha256": source_sha,
                "fixtureBytes": source_bytes,
                "fixtureInputSha256": source_info.get("inputSha256"),
                "manifestSha256": _sha((provider_root / "manifest.json").read_bytes()),
            }
            seed = {
                "format": FORMAT,
                "formatVersion": FORMAT_VERSION,
                "datasetId": database_id,
                "source": provenance,
                "restore": {
                    "file": "seed.sql.gz",
                    "sha256": _sha(compressed),
                    "bytes": len(compressed),
                    "uncompressed": {"file": "seed.sql (decompressed)", "sha256": _sha(sql), "bytes": len(sql)},
                    "singleTransaction": True,
                    "psqlMetaCommands": False,
                    "command": "decompress and execute the SQL as one transaction",
                },
                "size": {
                    "sourceSqliteBytes": source_bytes,
                    "sourceSqlitePageCount": int(snapshot.db.execute("PRAGMA page_count").fetchone()[0]),
                    "sourceSqlitePageSize": int(snapshot.db.execute("PRAGMA page_size").fetchone()[0]),
                    "generatedPostgresSqlBytes": len(sql),
                    "schemaIndexAndMetadataSqlBytes": schema_bytes,
                    "rowInsertSqlBytes": data_bytes,
                    "logicalDatabaseBytes": None,
                    "logicalDatabaseBytesMeasurement": "must be measured by the PostgreSQL backend after restore; SQL and SQLite sizes are not PostgreSQL storage receipts",
                },
                "tables": table_entries,
                "integrity": {"sourceForeignKeyViolations": 0, "foreignKeysPreserved": True},
            }
            manifest_bytes = _canonical(seed)
            (out / "seed-manifest.json").write_bytes(manifest_bytes)
            (out / "seed.sql.sha256").write_text(f"{_sha(compressed)}  seed.sql.gz\n", encoding="ascii")
            (out / "seed-manifest.sha256").write_text(f"{_sha(manifest_bytes)}  seed-manifest.json\n", encoding="ascii")
            return seed
        finally:
            snapshot.close()
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)


def verify(provider_root: Path, bundle_root: Path) -> dict[str, Any]:
    """Verify artifact pins, source identity, complete rows, and one-transaction SQL."""
    expected, _source_path, source_sha, source_bytes, temporary = pg.load_source(provider_root)
    try:
        database_id = expected["id"]
        bundle = bundle_root / database_id
        manifest_bytes = (bundle / "seed-manifest.json").read_bytes()
        manifest = json.loads(manifest_bytes)
        if not isinstance(manifest, dict) or not isinstance(manifest.get("source"), dict) or not isinstance(manifest.get("restore"), dict):
            raise pg.ImportError("seed manifest is missing source or restore metadata")
        compressed = (bundle / "seed.sql.gz").read_bytes()
        if manifest.get("format") != FORMAT or manifest.get("formatVersion") != FORMAT_VERSION:
            raise pg.ImportError("unsupported seed bundle format")
        if manifest.get("datasetId") != database_id or manifest["source"].get("fixtureSha256") != source_sha:
            raise pg.ImportError("seed bundle dataset/source pin does not match provider")
        restore = manifest["restore"]
        if _sha(manifest_bytes) != (bundle / "seed-manifest.sha256").read_text().split()[0]:
            raise pg.ImportError("seed manifest checksum mismatch")
        if _sha(compressed) != restore.get("sha256") or len(compressed) != restore.get("bytes"):
            raise pg.ImportError("compressed SQL checksum or byte count mismatch")
        if _sha(compressed) != (bundle / "seed.sql.sha256").read_text().split()[0]:
            raise pg.ImportError("compressed SQL sidecar checksum mismatch")
        sql = gzip.decompress(compressed)
        uncompressed = restore.get("uncompressed", {})
        if _sha(sql) != uncompressed.get("sha256") or len(sql) != uncompressed.get("bytes"):
            raise pg.ImportError("uncompressed SQL checksum or byte count mismatch")
        decoded = sql.decode("utf-8")
        if decoded.count("BEGIN;") != 1 or decoded.count("COMMIT;") != 1 or "\\copy" in decoded:
            raise pg.ImportError("restore SQL must be a single transaction without psql meta-commands")
        if not decoded.startswith("-- Generated from a manifest-pinned DemoDB SQLite fixture."):
            raise pg.ImportError("unexpected PostgreSQL SQL generator output")
        if not isinstance(manifest.get("tables"), list):
            raise pg.ImportError("seed manifest table inventory is invalid")
        snapshot = pg.inspect(provider_root)
        try:
            counts = {table["name"]: snapshot.row_count(table["name"]) for table in snapshot.tables}
            declared = {table["name"]: table["retainedRows"] for table in manifest["tables"]}
            if counts != declared:
                raise pg.ImportError("seed table inventory/counts do not match complete source")
        finally:
            snapshot.close()
        return {"datasetId": database_id, "verified": True, "sourceSha256": source_sha,
                "sourceBytes": source_bytes, "compressedSqlSha256": restore["sha256"],
                "compressedSqlBytes": len(compressed), "uncompressedSqlSha256": _sha(sql),
                "uncompressedSqlBytes": len(sql), "tables": len(counts), "rows": sum(counts.values()),
                "foreignKeyViolations": 0}
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    build_cmd = sub.add_parser("build", help="build one full seed bundle")
    build_cmd.add_argument("provider", type=Path)
    build_cmd.add_argument("--output", type=Path, required=True)
    verify_cmd = sub.add_parser("verify", help="verify one bundle against its pinned provider")
    verify_cmd.add_argument("provider", type=Path)
    verify_cmd.add_argument("bundle", type=Path, help="bundle root containing <dataset-id>/")
    args = parser.parse_args(argv)
    try:
        result = build(args.provider, args.output) if args.command == "build" else verify(args.provider, args.bundle)
        print(json.dumps(result, sort_keys=True, indent=2))
        return 0
    except (pg.ImportError, OSError, ValueError, EOFError) as exc:
        parser.exit(2, f"postgres_seeds: {exc}\n")


if __name__ == "__main__":
    raise SystemExit(main())
