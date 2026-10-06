#!/usr/bin/env python3
"""Independently compare DataTug's native inGitDB export with pinned SQLite.

DataTug is not imported: the source catalogue and typed rows are read again
through Python's SQLite driver. This catches exporter regressions, including a
row moved beneath another valid transport ID.
"""
from __future__ import annotations

import argparse
import base64
import csv
import json
import re
import sqlite3
import sys
from decimal import Decimal
from pathlib import Path
from typing import Any

import yaml

from postgres_samples import DECIMAL_TEXT, DECIMAL_TYPED, ImportError, _check_expressions, inspect, quote


def _safe_file(root: Path, name: str) -> Path:
    path = (root / name).resolve()
    if not path.is_relative_to(root.resolve()) or not path.is_file():
        raise ImportError(f"missing or escaping native export file: {name}")
    return path


def _yaml_file(path: Path) -> dict[str, Any]:
    value = yaml.load(path.read_text(encoding="utf-8"), Loader=_UniqueYAMLLoader)
    if not isinstance(value, dict):
        raise ImportError(f"expected YAML mapping: {path}")
    return value


def _unique_json_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ImportError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _native_collection_id(source_name: str) -> str:
    """Derive the portable native ID independently from DataTug's Go writer."""
    valid = bool(re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9._]*[A-Za-z0-9])?", source_name))
    base = source_name.split(".", 1)[0].upper()
    windows_device = base in {"CON", "PRN", "AUX", "NUL"} or bool(re.fullmatch(r"(?:COM|LPT)[1-9]", base))
    if valid and source_name[:3].lower() != "dt_" and not windows_device:
        return source_name
    return "dt_" + source_name.encode("utf-8").hex()


class _UniqueYAMLLoader(yaml.SafeLoader):
    def construct_mapping(self, node: Any, deep: bool = False) -> dict[Any, Any]:
        result: dict[Any, Any] = {}
        for key_node, value_node in node.value:
            key = self.construct_object(key_node, deep=deep)
            if key in result:
                raise ImportError(f"duplicate YAML key: {key}")
            result[key] = self.construct_object(value_node, deep=deep)
        return result


def _native_records(path: Path, definition: dict[str, Any], table_name: str,
                    columns: list[str], native_id: str | None = None) -> dict[str, dict[str, Any]]:
    """Decode DataTug's documented record formats without using its exporter."""
    record_file = definition["record_file"]
    record_format = record_file["format"]
    record_type = record_file["type"]
    records: dict[str, dict[str, Any]] = {}
    if record_format in ("json", "yaml"):
        if record_type != "map[$record_id]map[$field_name]any":
            raise ImportError(f"{table_name}: unexpected map record type")
        with path.open(encoding="utf-8") as stream:
            values = (json.load(stream, object_pairs_hook=_unique_json_pairs) if record_format == "json"
                      else yaml.load(stream, Loader=_UniqueYAMLLoader))
        if record_format == "yaml" and values is None and path.stat().st_size == 0:
            values = {}  # DataTug writes an empty YAML stream for a zero-row table.
        if not isinstance(values, dict) or any(not isinstance(key, str) or not isinstance(row, dict)
                                                   for key, row in values.items()):
            raise ImportError(f"{table_name}: native record file is not an ID-keyed map")
        return values

    def add(row: Any) -> None:
        if not isinstance(row, dict):
            raise ImportError(f"{table_name}: native row is not an object")
        transport_id = row.pop("$ID", None)
        if not isinstance(transport_id, str) or not transport_id:
            raise ImportError(f"{table_name}: missing or invalid $ID")
        if transport_id in records:
            raise ImportError(f"{table_name}: duplicate transport ID {transport_id}")
        records[transport_id] = row

    if record_format == "jsonl":
        if record_type != "[]map[string]any":
            raise ImportError(f"{table_name}: unexpected JSONL record type")
        with path.open(encoding="utf-8") as stream:
            for line in stream:
                if line.strip():
                    add(json.loads(line, object_pairs_hook=_unique_json_pairs))
    elif record_format == "csv":
        if record_type != "[]map[string]any" or record_file.get("csv_cell_encoding") != "json-v1":
            raise ImportError(f"{table_name}: CSV lacks lossless json-v1 cells")
        expected_header = ["$ID", *columns]
        if definition.get("columns_order") != expected_header:
            raise ImportError(f"{table_name}: CSV columns_order differs from source columns")
        with path.open(newline="", encoding="utf-8") as stream:
            reader = csv.reader(stream)
            if next(reader, None) != expected_header:
                raise ImportError(f"{table_name}: CSV header differs from source columns")
            for cells in reader:
                if len(cells) != len(expected_header):
                    raise ImportError(f"{table_name}: CSV row has wrong field count")
                add(dict(zip(expected_header, (json.loads(cell, object_pairs_hook=_unique_json_pairs) for cell in cells))))
    elif record_format == "ingr":
        if record_type != "map[$record_id]map[$field_name]any":
            raise ImportError(f"{table_name}: unexpected INGR record type")
        with path.open(encoding="utf-8") as stream:
            header = stream.readline().rstrip("\r\n")
            prefix = f"# INGR.io | {native_id or table_name}: "
            if not header.startswith(prefix):
                raise ImportError(f"{table_name}: invalid INGR header")
            header_columns = [part.strip().split(":", 1)[0] for part in header[len(prefix):].split(",")]
            expected_header = ["$ID", *columns]
            if header_columns != expected_header:
                raise ImportError(f"{table_name}: INGR columns differ from source columns")
            pending: list[str] = []
            footer = None
            for line in stream:
                raw = line.rstrip("\r\n")
                if raw.startswith("#"):
                    if raw.startswith("#-"):
                        if pending:
                            raise ImportError(f"{table_name}: INGR delimiter splits a row")
                        continue
                    footer = raw
                    break
                pending.append(raw)
                if len(pending) == len(expected_header):
                    add(dict(zip(expected_header, (json.loads(cell, object_pairs_hook=_unique_json_pairs) for cell in pending))))
                    pending = []
            if pending or footer != f"# {len(records)} record{'s' if len(records) != 1 else ''}":
                raise ImportError(f"{table_name}: INGR row count or footer differs")
            if stream.read().strip():
                raise ImportError(f"{table_name}: trailing INGR content")
    else:
        raise ImportError(f"{table_name}: unsupported native record format {record_format}")
    return records


def _go_float_text(value: float, *, json_number: bool = False) -> str:
    """Go's shortest round-trip float spelling for decimal transport/JSON IDs."""
    number = Decimal(repr(value)).normalize()
    exponent = number.adjusted()
    low, high = (-6, 21) if json_number else (-4, 6)
    if low <= exponent < high or number.is_zero():
        return format(number, "f")
    coefficient, power = format(number, "e").split("e")
    exp = int(power)
    digits = str(abs(exp)) if json_number else f"{abs(exp):02d}"
    return f"{coefficient}e{'+' if exp >= 0 else '-'}{digits}"


def _go_json_string(value: str) -> str:
    return (json.dumps(value, ensure_ascii=False)
            .replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
            .replace("\u2028", "\\u2028").replace("\u2029", "\\u2029"))


def _native_id(row: tuple[Any, ...], columns: list[dict[str, Any]], ordinal: int,
               fields: dict[str, dict[str, Any]] | None = None) -> str:
    pk = sorted(((col["pk"], i) for i, col in enumerate(columns) if col["pk"]))
    if not pk:
        return f"row-{ordinal:012d}"
    typed = []
    for _, i in pk:
        value = row[i]
        field = (fields or {}).get(columns[i]["name"], {})
        if field.get("type") == "decimal":
            value = _expected_value(value, columns[i]["type"], "decimal-string")
        if value is None:
            raise ImportError("source primary key contains NULL")
        if isinstance(value, int):
            tag = "int64"
        elif isinstance(value, float):
            tag = "float64"
        elif isinstance(value, str):
            tag = "string"
        elif isinstance(value, bytes):
            # SourceRowsReader exposes BLOB transport keys as base64 strings.
            tag, value = "string", base64.b64encode(value).decode("ascii")
        else:
            raise ImportError(f"unsupported source primary-key value: {type(value).__name__}")
        encoded = _go_float_text(value, json_number=True) if isinstance(value, float) else _go_json_string(value) if isinstance(value, str) else str(value)
        typed.append(f"[{_go_json_string(tag)},{encoded}]")
    raw = ("[" + ",".join(typed) + "]").encode("utf-8")
    return "pk-" + base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _source_rows(snapshot: Any, table: dict[str, Any]):
    name = table["name"]
    pk = sorted(((col["pk"], col["name"]) for col in table["columns"] if col["pk"]))
    if pk:
        order = ", ".join(quote(col) for _, col in pk)
    else:
        names = {col["name"].lower() for col in table["columns"]}
        order = next((candidate for candidate in ("_rowid_", "rowid", "oid") if candidate not in names), None)
        if order is None:
            raise ImportError(f"{name}: no unshadowed rowid alias for keyless export")
    columns = table["columns"]
    classes = ", ".join(f"typeof({quote(col['name'])})" for col in columns)
    statement = f"SELECT *, {classes} FROM {quote(name)} ORDER BY {order}"
    count = len(columns)
    for ordinal, raw in enumerate(snapshot.db.execute(statement), 1):
        yield ordinal, raw[:count], raw[count:]


def _expected_value(value: Any, declared: str, encoding: str | None) -> Any:
    if value is None:
        return None
    if isinstance(value, bytes):
        if encoding != "base64":
            raise ImportError("source BLOB has no native base64 encoding declaration")
        return base64.b64encode(value).decode("ascii")
    if DECIMAL_TEXT.fullmatch(declared):
        return value  # Lexical text is part of the source value.
    if encoding == "decimal-string":
        return _go_float_text(value) if isinstance(value, float) else str(value)
    return value


def _same_value(actual: Any, expected: Any, field_type: str | None = None) -> bool:
    if isinstance(expected, float):
        # JSON has one numeric syntax: Go emits an integral float64 as `0`.
        # The native field definition identifies this as a REAL value.
        if field_type == "float" and type(actual) is int:
            actual = float(actual)
        return isinstance(actual, float) and actual.hex() == expected.hex()
    return type(actual) is type(expected) and actual == expected


def _source_definition_errors(table: dict[str, Any], definition: dict[str, Any], db: sqlite3.Connection) -> list[str]:
    name = table["name"]
    errors: list[str] = []
    if definition.get("dialect") != "sqlite" or definition.get("createSql") != table["sql"]:
        errors.append(f"{name}: original SQLite CREATE TABLE SQL differs")
    published_columns = definition.get("columns", [])
    if len(published_columns) != len(table["columns"]):
        errors.append(f"{name}: source-definition column count differs")
    for expected, actual in zip(table["columns"], published_columns):
        for field, value in (("name", expected["name"]), ("declaredType", expected["type"]),
                             ("notNull", expected["notnull"]), ("primaryKeyPosition", expected["pk"]),
                             ("defaultSql", expected["default"])):
            if actual.get(field, 0 if field == "primaryKeyPosition" else None) != value:
                errors.append(f"{name}.{expected['name']}: source-definition {field} differs")
    published_indexes = definition.get("indexes", [])
    if len(published_indexes) != len(table["indexes"]):
        errors.append(f"{name}: source-definition index count differs")
    for expected, actual in zip(table["indexes"], published_indexes):
        for field, value in (("name", expected["name"]), ("unique", expected["unique"]),
                             ("origin", expected["origin"]), ("partial", expected["partial"]),
                             ("createSql", expected["sql"])):
            if actual.get(field, False if field == "partial" else None) != value:
                errors.append(f"{name}.{expected['name']}: index {field} differs")
        terms = db.execute(f"PRAGMA index_xinfo({quote(expected['name'])})").fetchall()
        actual_terms = actual.get("columns", [])
        if len(terms) != len(actual_terms):
            errors.append(f"{name}.{expected['name']}: index term count differs")
        for term, native_term in zip(terms, actual_terms):
            for field, value in (("position", term[0]), ("name", term[2]),
                                 ("descending", bool(term[3])), ("collation", term[4] or ""),
                                 ("key", bool(term[5]))):
                if native_term.get(field, False if field == "descending" else None) != value:
                    errors.append(f"{name}.{expected['name']}: index term {field} differs")
    return errors


def _portable_field_errors(table: dict[str, Any], schema: dict[str, Any],
                           native_columns: dict[str, Any], db: sqlite3.Connection) -> list[str]:
    name = table["name"]
    errors: list[str] = []
    fields = schema.get("fields", [])
    if [field.get("name") for field in fields] != [column["name"] for column in table["columns"]]:
        return [f"{name}: ordered portable source fields differ from SQLite columns"]
    marker_table = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='_dalgo_time_columns'").fetchone()
    time_markers = ({row[0] for row in db.execute("SELECT column_name FROM _dalgo_time_columns WHERE collection_name=?", (name,))}
                    if marker_table else set())
    has_pk_index = any(index["origin"] == "pk" for index in table["indexes"])
    pk = [column for column in table["columns"] if column["pk"]]
    for source, actual in zip(table["columns"], fields):
        declared = source["type"].strip().upper()
        precision = DECIMAL_TYPED.fullmatch(declared)
        if source["name"] in time_markers or declared in {"DATETIME", "DATE", "TIME", "TIMESTAMP"}:
            kind = "time"
        elif precision or declared in {"NUMERIC", "DECIMAL"}:
            kind = "decimal"
        elif "INT" in declared:
            kind = "int"
        elif any(part in declared for part in ("CHAR", "CLOB", "TEXT")):
            kind = "string"
        elif "BLOB" in declared:
            kind = "bytes"
        elif any(part in declared for part in ("REAL", "FLOA", "DOUB")):
            kind = "float"
        else:
            errors.append(f"{name}.{source['name']}: unsupported declared type {declared!r}")
            continue
        rowid_alias = (len(pk) == 1 and pk[0]["name"] == source["name"] and declared == "INTEGER" and
                       not has_pk_index and "WITHOUT ROWID" not in table["sql"].upper())
        nullable = not source["notnull"] and not rowid_alias
        expected = {"name": source["name"], "type": kind, "nullable": nullable}
        if kind == "decimal":
            expected["encoding"] = "decimal-string"
            if precision:
                expected["precision"], expected["scale"] = (int(part) for part in precision.groups())
        elif kind == "bytes":
            expected["encoding"] = "base64"
        if kind == "int" and source["pk"] == 1 and "AUTOINCREMENT" in table["sql"].upper():
            expected["auto_increment"] = True
        for key in ("name", "type", "nullable", "encoding", "precision", "scale", "length",
                    "auto_increment", "default_kind", "default_type", "default_json"):
            if actual.get(key) != expected.get(key):
                errors.append(f"{name}.{source['name']}: portable {key} differs from SQLite source")
        native = native_columns.get(source["name"], {})
        native_type = {"time": "datetime", "decimal": "string", "bytes": "string"}.get(kind, kind)
        if native.get("type") != native_type or bool(native.get("required")) != (not nullable):
            errors.append(f"{name}.{source['name']}: native type/required differs from portable SQLite schema")
    return errors


def _foreign_key_errors(table: dict[str, Any], native: dict[str, Any], source_to_native: dict[str, str]) -> list[str]:
    name = table["name"]
    grouped: dict[int, list[tuple[Any, ...]]] = {}
    for row in table["foreign_keys"]:
        grouped.setdefault(row[0], []).append(row)
    expected = []
    for group_id, parts in sorted(grouped.items()):
        parts.sort(key=lambda part: part[1])
        expected.append((f"{name}_fk_{group_id}", [part[3] for part in parts], source_to_native.get(parts[0][2]),
                         [part[4] for part in parts], "disabled", parts[0][5], parts[0][6]))
    actual = []
    for fk in native.get("foreign_keys", []):
        actual.append((fk.get("name"), fk.get("fields"), fk.get("referenced_collection"),
                       fk.get("referenced_fields"), fk.get("source_enforcement"),
                       fk.get("on_update", "NO ACTION"), fk.get("on_delete", "NO ACTION")))
    return [] if actual == expected else [f"{name}: ordered foreign-key groups/actions differ"]


def _portable_index_errors(table: dict[str, Any], schema: dict[str, Any], db: sqlite3.Connection) -> list[str]:
    expected = []
    for index in table["indexes"]:
        if index["origin"] == "pk":
            continue
        terms = db.execute(f"PRAGMA index_xinfo({quote(index['name'])})").fetchall()
        key_terms = [term for term in terms if term[5]]
        if not key_terms or any(term[2] is None for term in key_terms):
            continue  # expression indexes exist only in exact SourceDefinition metadata
        expected.append({"name": index["name"], "fields": [term[2] for term in key_terms],
                         "unique": index["unique"]})
    actual = [{"name": item.get("name"), "fields": item.get("fields"),
               "unique": item.get("unique", False)} for item in schema.get("indexes", [])]
    return [] if actual == expected else [f"{table['name']}: ordered portable indexes differ"]


def validate(source_root: Path, native_root: Path, *, check_data: bool = True) -> dict[str, Any]:
    snapshot = inspect(source_root)
    errors: list[str] = []
    data_errors: list[str] = []
    native_limits: list[str] = []
    rows_checked = 0
    try:
        collections = _yaml_file(_safe_file(native_root, ".ingitdb/root-collections.yaml"))
        source_names = [table["name"] for table in snapshot.tables]
        source_ids = {name: _native_collection_id(name) for name in source_names}
        if len(set(source_ids.values())) != len(source_names) or \
                len({native_id.lower() for native_id in source_ids.values()}) != len(source_names):
            errors.append("source table names produce colliding native collection IDs")
        try:
            mapping = json.loads(_safe_file(native_root, ".ingitdb/source-collections.json").read_text(encoding="utf-8"),
                                 object_pairs_hook=_unique_json_pairs)
            actual_mapping = mapping["collections"]
            if mapping["format"] != "datatug-source-collections/v1" or not isinstance(actual_mapping, dict) or \
                    set(mapping) != {"format", "collections"} or \
                    actual_mapping != {native_id: name for name, native_id in source_ids.items()}:
                errors.append("native collection-to-source mapping differs from pinned SQLite tables")
        except (OSError, ValueError, KeyError, TypeError, ImportError) as exc:
            errors.append(f"cannot inspect native collection-to-source mapping: {exc}")
        if set(collections) != set(source_ids.values()) or len(collections) != len(source_names):
            errors.append("native collection IDs differ from pinned SQLite tables")
        for table in snapshot.tables:
            name = table["name"]
            native_id = source_ids[name]
            if collections.get(native_id) != native_id:
                errors.append(f"{name}: native collection path differs")
                continue
            try:
                definition = _yaml_file(_safe_file(native_root, f"{native_id}/.collection/definition.yaml"))
                schema = definition["source_schema"]
                source_definition = json.loads(schema["source_definition_json"], object_pairs_hook=_unique_json_pairs)
            except (OSError, KeyError, ValueError, ImportError) as exc:
                errors.append(f"{name}: cannot inspect native source schema: {exc}")
                continue
            errors.extend(_source_definition_errors(table, source_definition, snapshot.db))
            errors.extend(_foreign_key_errors(table, schema, source_ids))
            errors.extend(_portable_index_errors(table, schema, snapshot.db))
            columns = table["columns"]
            column_names = [column["name"] for column in columns]
            expected_order = (["$ID", *column_names] if definition.get("record_file", {}).get("format") == "csv"
                              else column_names)
            if definition.get("columns_order") != expected_order or set(definition.get("columns", {})) != set(column_names):
                errors.append(f"{name}: native fields differ from pinned SQLite columns")
            portable_fields = {field.get("name"): field for field in schema.get("fields", [])}
            if set(portable_fields) != set(column_names):
                errors.append(f"{name}: portable source fields differ from SQLite columns")
            errors.extend(_portable_field_errors(table, schema, definition.get("columns", {}), snapshot.db))
            if [str(field) for field in definition.get("primary_key", [])] != [col["name"] for col in sorted(columns, key=lambda c: c["pk"]) if col["pk"]]:
                errors.append(f"{name}: ordered native primary key differs")
            expected_mode = "source-primary-key" if any(col["pk"] for col in columns) else "export-ordinal"
            if schema.get("key_mode") != expected_mode:
                errors.append(f"{name}: key mode differs")
            if schema.get("constraint_validation") != "provider-preflight-passed":
                errors.append(f"{name}: missing source constraint preflight receipt")
            if table["foreign_keys"]:
                native_limits.append(f"{name}: source foreign keys and actions are metadata; native target does not enforce SQLite semantics")
            if any(col["pk"] for col in columns):
                native_limits.append(f"{name}: source primary-key field values are not maintained by native record-ID updates")
            if any(index["unique"] for index in table["indexes"]) or _check_expressions(table["sql"]):
                native_limits.append(f"{name}: source UNIQUE/CHECK constraints are metadata after export")
            if not check_data:
                continue
            try:
                records = _native_records(_safe_file(native_root, f"{native_id}/{definition['record_file']['name']}"),
                                          definition, name, column_names, native_id)
                fields = portable_fields
                if set(fields) != set(column_names):
                    errors.append(f"{name}: portable source fields differ from SQLite columns")
                storage: dict[str, dict[str, str]] = {}
                for sidecar_name in schema.get("storage_class_files", []):
                    for line in _safe_file(native_root, f"{native_id}/{sidecar_name}").read_text(encoding="utf-8").splitlines():
                        item = json.loads(line, object_pairs_hook=_unique_json_pairs)
                        if item["id"] in storage:
                            data_errors.append(f"{name}: duplicate storage-class row {item['id']}")
                        storage[item["id"]] = item["classes"]
                expected_ids: set[str] = set()
                for ordinal, values, classes in _source_rows(snapshot, table):
                    transport_id = _native_id(values, columns, ordinal, fields)
                    expected_ids.add(transport_id)
                    actual = records.get(transport_id)
                    if not isinstance(actual, dict) or set(actual) != set(column_names):
                        data_errors.append(f"{name}: missing or altered row at source transport ID {transport_id}")
                        continue
                    expected_storage: dict[str, str] = {}
                    for column, value, storage_class in zip(columns, values, classes):
                        field = fields.get(column["name"], {})
                        expected = _expected_value(value, column["type"], field.get("encoding"))
                        if not _same_value(actual[column["name"]], expected, field.get("type")):
                            data_errors.append(f"{name}.{column['name']}: typed value differs at {transport_id}")
                        if field.get("encoding") == "decimal-string" and value is not None:
                            expected_storage[column["name"]] = storage_class
                    if storage.get(transport_id, {}) != expected_storage:
                        data_errors.append(f"{name}: source storage classes differ at {transport_id}")
                    rows_checked += 1
                if set(records) != expected_ids:
                    data_errors.append(f"{name}: transport record IDs differ from pinned source")
                if set(storage) - expected_ids:
                    data_errors.append(f"{name}: orphan storage-class sidecar IDs")
            except (OSError, ValueError, KeyError, TypeError, ImportError, sqlite3.Error) as exc:
                data_errors.append(f"{name}: cannot verify native records: {exc}")
        views_file = native_root / ".ingitdb/source-views.yaml"
        published_views = yaml.load(views_file.read_text(encoding="utf-8"), Loader=_UniqueYAMLLoader) if views_file.is_file() else None
        if snapshot.views:
            expected_views = [{"name": item["name"], "createsql": item["sql"], "columns": item["columns"]} for item in snapshot.views]
            if published_views != expected_views:
                errors.append("ordered source view SQL or columns differ")
        elif published_views not in (None, [], {}):
            errors.append("native export contains views absent from pinned source")
        source_orphans = len(snapshot.db.execute("PRAGMA foreign_key_check").fetchall()) if check_data else None
        if source_orphans:
            data_errors.append(f"source SQLite contains {source_orphans} foreign-key violations")
        return {"format": "demodb-datatug-parity/v1", "datasetId": snapshot.database_id,
                "sourceSha256": snapshot.source_sha256, "tables": len(snapshot.tables), "views": len(snapshot.views),
                "rows": rows_checked if check_data else sum(snapshot.row_count(name) for name in source_names),
                "sourceOrphans": source_orphans, "dataChecked": check_data,
                "metadataMatches": not errors,
                "metadataAndDataMatch": not (errors or data_errors) if check_data else None,
                "nativeConstraintEquivalent": not native_limits,
                "errors": (errors + data_errors)[:100], "errorCount": len(errors) + len(data_errors),
                "nativeLimitations": native_limits}
    finally:
        snapshot.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_root", type=Path)
    parser.add_argument("native_root", type=Path)
    parser.add_argument("--metadata-only", action="store_true")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    report = validate(args.source_root, args.native_root, check_data=not args.metadata_only)
    output = json.dumps(report, indent=2, ensure_ascii=False) + "\n"
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(output, encoding="utf-8")
    sys.stdout.write(output)
    return 0 if (report["metadataAndDataMatch"] if report["dataChecked"] else report["metadataMatches"]) else 2


if __name__ == "__main__":
    raise SystemExit(main())
