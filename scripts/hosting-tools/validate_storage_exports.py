#!/usr/bin/env python3
"""Compare a published inGitDB edition with its pinned SQLite source schema.

This checks metadata parity, native inGitDB definitions and exported row
references. It reports native constraint gaps separately: a metadata record of
a SQL constraint is not the same as enforcement by inGitDB.
"""
from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
from collections import defaultdict
from pathlib import Path
from typing import Any

from postgres_samples import ImportError, _check_expressions, _multiset_matches, _row_digest, inspect, quote
from storage_exports import record_id


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        while block := stream.read(1024 * 1024):
            h.update(block)
    return h.hexdigest()


def expected_foreign_keys(table: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    rows = [{"id": row[0], "sequence": row[1], "table": row[2], "from": row[3], "to": row[4],
             "onUpdate": row[5], "onDelete": row[6], "match": row[7]}
            for row in table["foreign_keys"]]
    groups: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        groups[row["id"]].append(row)
    constraints = []
    for id, parts in sorted(groups.items()):
        parts.sort(key=lambda item: item["sequence"])
        constraints.append({"id": id, "localColumns": [part["from"] for part in parts],
                            "referencedTable": parts[0]["table"], "referencedColumns": [part["to"] for part in parts],
                            "onUpdate": parts[0]["onUpdate"], "onDelete": parts[0]["onDelete"],
                            "match": parts[0]["match"], "enforced": False})
    return rows, constraints


def expected_columns(table: dict[str, Any]) -> list[dict[str, Any]]:
    return [{"nativeName": col["name"], "declaredType": col["type"],
             "sourceNotNull": col["notnull"], "sourceDeclaredNullable": not col["notnull"],
             "primaryKeyPosition": col["pk"], "defaultValue": col["default"],
             "exportRequired": bool(col["notnull"] or col["pk"] > 0)}
            for col in table["columns"]]


def definition(root: Path, collection: str) -> dict[str, Any]:
    command = ["ingitdb", "describe", "collection", collection, "--path", str(root), "--format", "json"]
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode:
        raise ImportError(f"ingitdb describe failed for {collection}: {result.stderr.strip()}")
    return json.loads(result.stdout)["definition"]


def record_file(root: Path, table: dict[str, Any]) -> Path:
    path_text = table.get("records", {}).get("path")
    if not isinstance(path_text, str):
        raise ImportError(f"{table.get('nativeName')}: missing published records path")
    path = (root / path_text).resolve()
    if not path.is_relative_to(root.resolve()) or not path.is_file():
        raise ImportError(f"{table.get('nativeName')}: records path is missing or escapes inGitDB root")
    return path


def decode_exported(value: Any, encoding: str) -> Any:
    if value is None:
        return None
    if encoding == "sqlite-typed-json":
        if not isinstance(value, dict) or set(value) != {"sqliteType", "value"}:
            raise ImportError("mixed SQLite value lacks its type envelope")
        kind, value = value["sqliteType"], value["value"]
        if kind == "bytes":
            return base64.b64decode(value, validate=True)
        if kind == "int":
            return int(value)
        if kind == "float":
            return float(value)
        if kind == "str":
            return str(value)
        raise ImportError(f"unknown SQLite storage class {kind!r}")
    if encoding == "base64":
        return base64.b64decode(value, validate=True)
    if encoding in ("decimal-string-from-source", "native-json"):
        return value
    raise ImportError(f"unknown export encoding {encoding!r}")


def check_orphans(root: Path, manifest_tables: dict[str, dict[str, Any]], source_tables: dict[str, dict[str, Any]], snapshot: Any) -> tuple[int, list[str], list[str]]:
    """Replay exported rows under source DDL so SQLite owns FK affinity/collation."""
    with tempfile.NamedTemporaryFile(prefix="demodb-fk-parity-", suffix=".sqlite", delete=False) as scratch:
        scratch_path = Path(scratch.name)
    connection = sqlite3.connect(scratch_path)
    row_findings: list[str] = []
    try:
        connection.execute("PRAGMA foreign_keys=OFF")
        for source in source_tables.values():
            if not source["sql"]:
                raise ImportError(f"{source['name']}: source CREATE TABLE SQL is absent")
            connection.execute(source["sql"])
        for name, source in source_tables.items():
            if name not in manifest_tables:
                raise ImportError(f"{name}: published table is absent")
            published = manifest_tables[name]
            columns = [col["name"] for col in source["columns"]]
            encodings = {col["nativeName"]: col["encoding"] for col in published["columns"]}
            statement = f"INSERT INTO {quote(name)} (" + ", ".join(quote(col) for col in columns) + ") VALUES (" + ", ".join("?" for _ in columns) + ")"
            with record_file(root, published).open(encoding="utf-8") as stream:
                records = json.load(stream)
            if not isinstance(records, dict):
                raise ImportError(f"{name}: published records are not an ID-keyed map")
            expected_by_id = {record_id(row, source["columns"], ordinal): _row_digest(row, source["columns"])
                              for ordinal, row in enumerate(snapshot.rows(name), 1)}
            if set(records) != set(expected_by_id):
                row_findings.append(f"{name}: transport record IDs differ from pinned source keys/order")
            batch = []
            mismatched_ids = 0
            for transport_id, record in records.items():
                if not isinstance(record, dict) or set(record) != set(columns):
                    raise ImportError(f"{name}: published row columns differ from SQLite source")
                decoded = tuple(decode_exported(record[col], encodings[col]) for col in columns)
                if expected_by_id.get(transport_id) != _row_digest(decoded, source["columns"]):
                    mismatched_ids += 1
                batch.append(decoded)
                if len(batch) == 500:
                    connection.executemany(statement, batch)
                    batch.clear()
            if batch:
                connection.executemany(statement, batch)
            if mismatched_ids:
                row_findings.append(f"{name}: {mismatched_ids} exported records differ at their transport IDs")
            if not _multiset_matches(snapshot.rows(name), connection.execute(f"SELECT * FROM {quote(name)}"), source["columns"]):
                row_findings.append(f"{name}: typed exported row multiset differs from pinned SQLite source")
        for source in source_tables.values():
            for index in source["indexes"]:
                if index["sql"]:
                    connection.execute(index["sql"])
        connection.commit()
        violations = connection.execute("PRAGMA foreign_key_check").fetchall()
        findings = [f"{name}: exported row {rowid} violates source FK {fk_id} toward {parent}"
                    for name, rowid, parent, fk_id in violations[:20]]
        return len(violations), findings, row_findings
    finally:
        connection.close()
        scratch_path.unlink(missing_ok=True)


def validate(source_root: Path, ingitdb_root: Path, *, check_data: bool = True) -> dict[str, Any]:
    snapshot = inspect(source_root)
    try:
        manifest = json.loads((ingitdb_root / "export-manifest.json").read_text(encoding="utf-8"))
        errors: list[str] = []
        data_errors: list[str] = []
        native_gaps: list[str] = []
        source_tables = {table["name"]: table for table in snapshot.tables}
        published_tables = {table["nativeName"]: table for table in manifest["tables"]}
        if manifest.get("datasetId") != snapshot.database_id:
            errors.append("dataset ID differs from pinned source")
        if manifest.get("source", {}).get("fixtureSha256") != snapshot.source_sha256:
            errors.append("source fixture SHA-256 differs from pinned source")
        if set(published_tables) != set(source_tables) or len(published_tables) != len(manifest["tables"]):
            errors.append("published native table names differ from source")
        if manifest.get("rowCount") != sum(snapshot.row_count(name) for name in source_tables):
            errors.append("database row count differs from source")
        expected_views = [{"name": view["name"], "status": "source-definition-only",
                           "columns": view["columns"], "sourceSql": view["sql"]}
                          for view in snapshot.views]
        if manifest.get("views") != expected_views:
            errors.append("ordered source view definitions or columns differ")
        fk_count = unique_count = check_count = row_count = 0
        for name, source in source_tables.items():
            published = published_tables.get(name)
            if published is None:
                continue
            row_count += snapshot.row_count(name)
            if published.get("rows") != snapshot.row_count(name):
                errors.append(f"{name}: row count differs from source")
            if published.get("sourceSql") != source["sql"]:
                errors.append(f"{name}: source CREATE TABLE SQL differs")
            expected = expected_columns(source)
            columns = published.get("columns", [])
            if len(columns) != len(expected):
                errors.append(f"{name}: column count differs")
            for position, col in enumerate(expected):
                if position >= len(columns):
                    break
                for field, value in col.items():
                    if columns[position].get(field) != value:
                        errors.append(f"{name}.{col['nativeName']}: {field} differs from SQLite PRAGMA")
            pk = [col["name"] for col in sorted(source["columns"], key=lambda c: c["pk"]) if col["pk"]]
            if published.get("primaryKey") != pk:
                errors.append(f"{name}: ordered primary key differs")
            if published.get("indexes") != source["indexes"]:
                errors.append(f"{name}: unique and ordinary index metadata differ")
            unique_count += sum(bool(index["unique"]) for index in source["indexes"])
            fk_rows, fk_groups = expected_foreign_keys(source)
            fk_count += len(fk_groups)
            if published.get("foreignKeys") != fk_rows:
                errors.append(f"{name}: ordered FK rows or actions differ")
            if published.get("foreignKeyConstraints") != fk_groups:
                errors.append(f"{name}: grouped FK constraints differ")
            try:
                native = definition(ingitdb_root, published["collection"])
            except (ImportError, KeyError, json.JSONDecodeError) as exc:
                errors.append(f"{name}: cannot inspect native definition: {exc}")
                continue
            native_columns = native.get("columns", {})
            if set(native_columns) != {col["name"] for col in source["columns"]}:
                errors.append(f"{name}: native inGitDB column names differ")
            if native.get("primary_key", []) != pk:
                errors.append(f"{name}: native primary_key metadata differs")
            for col in columns:
                name_col = col["nativeName"]
                definition_col = native_columns.get(name_col, {})
                if definition_col.get("type") != col.get("ingitdbType") or bool(definition_col.get("required", False)) != col.get("exportRequired"):
                    errors.append(f"{name}.{name_col}: native type/required differs from manifest")
            if native.get("record_file", {}).get("type") != "map[$record_id]map[$field_name]any":
                errors.append(f"{name}: native record type is not ID-keyed map")
            if check_data:
                try:
                    records = record_file(ingitdb_root, published)
                    if sha256(records) != published.get("records", {}).get("sha256"):
                        data_errors.append(f"{name}: published record checksum differs")
                    with records.open(encoding="utf-8") as stream:
                        if len(json.load(stream)) != published["rows"]:
                            data_errors.append(f"{name}: published record key count differs")
                except (OSError, ValueError, ImportError, KeyError) as exc:
                    data_errors.append(f"{name}: records cannot be checked: {exc}")
            if pk:
                native_gaps.append(f"{name}: SQL primary-key field values are not maintained by native record-ID updates")
            if fk_groups:
                native_gaps.append(f"{name}: {len(fk_groups)} SQL foreign keys are metadata only; native inGitDB key references cannot target these encoded transport IDs or reproduce composite/action semantics")
            if any(index["unique"] and index["origin"] != "pk" for index in source["indexes"]):
                native_gaps.append(f"{name}: SQL unique indexes are metadata only in inGitDB")
            checks = _check_expressions(source["sql"])
            check_count += len(checks)
            if checks:
                native_gaps.append(f"{name}: source SQL CHECK constraints are metadata only in inGitDB")
        source_orphans = 0
        exported_orphans = 0
        orphan_findings: list[str] = []
        if check_data:
            source_orphans = len(snapshot.db.execute("PRAGMA foreign_key_check").fetchall())
            if source_orphans:
                data_errors.append(f"source SQLite has {source_orphans} foreign-key violations")
            try:
                exported_orphans, orphan_findings, row_findings = check_orphans(ingitdb_root, published_tables, source_tables, snapshot)
                data_errors.extend(orphan_findings)
                data_errors.extend(row_findings)
            except (OSError, ValueError, ImportError, KeyError, TypeError, sqlite3.Error, binascii.Error) as exc:
                data_errors.append(f"exported FK orphan check failed: {exc}")
        return {"format": "demodb-schema-parity/v1", "datasetId": snapshot.database_id, "sourceSha256": snapshot.source_sha256,
                "tables": len(source_tables), "views": len(expected_views), "rows": row_count, "foreignKeyConstraints": fk_count,
                "uniqueIndexes": unique_count, "checkConstraints": check_count, "sourceOrphans": source_orphans,
                "exportedOrphans": exported_orphans, "dataChecked": check_data,
                "metadataMatches": not errors, "metadataAndDataMatch": not (errors or data_errors) if check_data else None,
                "nativeConstraintEquivalent": not native_gaps,
                "errors": errors + data_errors, "nativeLimitations": native_gaps}
    finally:
        snapshot.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_root", type=Path, help="pinned provider fixture root")
    parser.add_argument("ingitdb_root", type=Path, help="published /ingitdb directory")
    parser.add_argument("--metadata-only", action="store_true", help="skip record checks")
    parser.add_argument("--require-native-constraints", action="store_true", help="fail if inGitDB cannot enforce all SQL constraints")
    parser.add_argument("--report", type=Path, help="also write JSON report here")
    args = parser.parse_args()
    report = validate(args.source_root, args.ingitdb_root, check_data=not args.metadata_only)
    serialized = json.dumps(report, indent=2, ensure_ascii=False) + "\n"
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(serialized, encoding="utf-8")
    sys.stdout.write(serialized)
    parity_ok = report["metadataAndDataMatch"] if report["dataChecked"] else report["metadataMatches"]
    return 0 if parity_ok and (report["nativeConstraintEquivalent"] or not args.require_native_constraints) else 2


if __name__ == "__main__":
    raise SystemExit(main())
