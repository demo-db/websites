#!/usr/bin/env python3
"""Prepare pinned SQLite tables for inGitDB and BigQuery without provisioning either.

One native, ID-keyed JSON record file per table is an inGitDB MapOfRecords
collection. Views are described in the manifest but not materialized: their SQL
belongs to the source engine and must not be presented as queryable tables.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
import re
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

from postgres_samples import DECIMAL_TEXT, DECIMAL_TYPED, ImportError, inspect, quote


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True, allow_nan=False)


def digest(path: Path) -> str:
    hashed = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            hashed.update(chunk)
    return hashed.hexdigest()


def scalar(value: Any, declared: str) -> Any:
    if value is None:
        return None
    if isinstance(value, bytes):
        return base64.b64encode(value).decode("ascii")
    if DECIMAL_TEXT.fullmatch(declared):
        if not isinstance(value, str):
            raise ImportError("DECIMAL_TEXT value is not stored as source text")
        return value
    if DECIMAL_TYPED.fullmatch(declared):
        # Mirror postgres_samples._normal: normalize SQLite's stored decimal
        # value through Decimal(str(value)), never a binary float in JSON.
        try:
            return format(Decimal(str(value)), "f")
        except InvalidOperation as exc:
            raise ImportError(f"invalid decimal value {value!r}") from exc
    if isinstance(value, float) and not math.isfinite(value):
        raise ImportError("non-finite SQLite float cannot be represented by JSON")
    if isinstance(value, int) and abs(value) > 2**53 - 1:
        raise ImportError("SQLite integer exceeds lossless inGitDB JSON reader range")
    if isinstance(value, (str, int, float)):
        return value
    raise ImportError(f"unsupported SQLite value type {type(value).__name__}")


def bigquery_type(declared: str, observed: set[str]) -> str:
    if len(observed - {"null"}) > 1:
        return "STRING"
    match = DECIMAL_TEXT.fullmatch(declared) or DECIMAL_TYPED.fullmatch(declared)
    if match:
        precision, scale = map(int, match.groups())
        if precision - scale <= 29 and scale <= 9:
            return "NUMERIC"
        if precision - scale <= 38 and scale <= 38:
            return "BIGNUMERIC"
        return "STRING"  # Wider source decimal: preserve exact text, never round.
    if observed == {"null"}:
        return "STRING"
    non_null = observed - {"null"}
    if non_null == {"bytes"}:
        return "BYTES"
    if non_null <= {"int"}:
        return "INTEGER"
    if non_null == {"float"}:
        return "FLOAT"
    if non_null <= {"str"}:
        return "STRING"
    # Mixed SQLite storage classes use a type-tagged JSON string below.
    return "STRING"


def encode_value(value: Any, declared: str, mixed: bool) -> Any:
    encoded = scalar(value, declared)
    if value is None or not mixed:
        return encoded
    return {"sqliteType": type(value).__name__, "value": encoded}


def decode_value(encoded: Any, declared: str, mixed: bool, source_type: type) -> Any:
    if encoded is None:
        return None
    if mixed:
        if encoded["sqliteType"] != source_type.__name__:
            raise ImportError("mixed SQLite type tag does not round-trip")
        encoded = encoded["value"]
    if source_type is bytes:
        return base64.b64decode(encoded, validate=True)
    if source_type is float:
        return float(encoded)
    if source_type is int:
        return int(encoded)
    return encoded


def bq_column_names(names: list[str]) -> dict[str, str]:
    mapped: dict[str, str] = {}
    used = {"_transport_id"}
    for name in names:
        candidate = re.sub(r"[^A-Za-z0-9_]", "_", name).lower()
        if not candidate or not candidate[0].isalpha():
            candidate = "c_" + candidate
        candidate = candidate[:270]
        if candidate in used:
            candidate = candidate[:260] + "_" + hashlib.sha256(name.encode()).hexdigest()[:8]
        if candidate in used:
            raise ImportError(f"BigQuery column collision for {name!r}")
        mapped[name] = candidate
        used.add(candidate)
    return mapped


def collection_slug(name: str) -> str:
    readable = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")[:35]
    return f"{readable or 'table'}_{hashlib.sha256(name.encode()).hexdigest()[:8]}"


def record_id(row: tuple[Any, ...], columns: list[dict[str, Any]], ordinal: int) -> str:
    keys = sorted(((col["pk"], i) for i, col in enumerate(columns) if col["pk"]))
    if not keys:
        return f"row-{ordinal:012d}"  # Transport identity, never a native PK.
    values = [[type(row[i]).__name__, scalar(row[i], columns[i]["type"])] for _, i in keys]
    if any(value[1] is None for value in values):
        raise ImportError("source primary key contains NULL")
    return "pk-" + base64.urlsafe_b64encode(canonical(values).encode()).decode().rstrip("=")


def export_table(snapshot: Any, table: dict[str, Any], output: Path) -> dict[str, Any]:
    table_name = table["name"]
    slug = collection_slug(table_name)
    cols = table["columns"]
    names = [col["name"] for col in cols]
    bq_names = bq_column_names(names)
    ingit_dir = output / "ingitdb" / slug
    bq_dir = output / "bigquery" / slug
    (ingit_dir / ".collection").mkdir(parents=True, exist_ok=True)
    bq_dir.mkdir(parents=True, exist_ok=True)
    records_path = ingit_dir / "records.json"
    rows_path = bq_dir / "rows.ndjson"
    observed: dict[str, set[str]] = {name: set() for name in names}
    for row in snapshot.rows(table_name):
        for col, value in zip(cols, row):
            observed[col["name"]].add("null" if value is None else type(value).__name__)
    mixed = {name: len(types - {"null"}) > 1 for name, types in observed.items()}
    seen: set[str] = set()
    count = 0
    # A map-of-records file is the native inGitDB representation. It keeps Git
    # file count bounded, while the BigQuery file remains streaming NDJSON.
    with records_path.open("w", encoding="utf-8") as records, rows_path.open("w", encoding="utf-8") as bq:
        records.write("{\n")
        for count, row in enumerate(snapshot.rows(table_name), 1):
            rid = record_id(row, cols, count)
            if rid in seen:
                raise ImportError(f"duplicate primary-key transport ID in {table_name}: {rid}")
            seen.add(rid)
            native = {}
            bq_row = {"_transport_id": rid}
            for col, value in zip(cols, row):
                name = col["name"]
                encoded = encode_value(value, col["type"], mixed[name])
                if decode_value(encoded, col["type"], mixed[name], type(value)) != value:
                    raise ImportError(f"value failed typed round-trip: {table_name}.{name}")
                native[name] = encoded
                bq_value = canonical(encoded) if mixed[name] and value is not None else encoded
                if value is not None and DECIMAL_TEXT.fullmatch(col["type"]) and not mixed[name]:
                    bq_value = format(Decimal(encoded), "f")
                bq_row[bq_names[name]] = bq_value
            if count > 1:
                records.write(",\n")
            records.write("  " + canonical(rid) + ": " + canonical(native))
            bq.write(canonical(bq_row) + "\n")
        records.write("\n}\n")
    # `any` preserves SQLite's dynamic types and source field names. The
    # companion manifest carries exact declared types, PKs, FKs and encodings.
    definition = "record_file:\n  name: records.json\n  format: json\n  type: \"map[$record_id]map[$field_name]any\"\ncolumns:\n"
    for name in names:
        definition += "  " + canonical(name) + ":\n    type: any\n"
    (ingit_dir / ".collection" / "definition.yaml").write_text(definition, encoding="utf-8")
    fields = [{"name": "_transport_id", "type": "STRING", "mode": "REQUIRED"}]
    for col in cols:
        kind = bigquery_type(col["type"], observed[col["name"]])
        fields.append({"name": bq_names[col["name"]], "type": kind, "mode": "NULLABLE"})
    schema_path = bq_dir / "schema.json"
    schema_path.write_text(json.dumps(fields, indent=2) + "\n", encoding="utf-8")
    return {
        "nativeName": table_name, "collection": slug, "rows": count,
        "primaryKey": [col["name"] for col in sorted(cols, key=lambda c: c["pk"]) if col["pk"]],
        "transportId": "encoded-native-primary-key" if any(col["pk"] for col in cols) else "source-row-ordinal-not-native-key",
        "foreignKeys": [{"id": fk[0], "sequence": fk[1], "table": fk[2], "from": fk[3], "to": fk[4]} for fk in table["foreign_keys"]],
        "columns": [{"nativeName": col["name"], "declaredType": col["type"], "bigqueryName": bq_names[col["name"]],
                     "bigqueryType": fields[i + 1]["type"], "encoding": "sqlite-typed-json" if mixed[col["name"]] else
                     "base64" if fields[i + 1]["type"] == "BYTES" else
                     "decimal-string-from-source" if DECIMAL_TEXT.fullmatch(col["type"]) or DECIMAL_TYPED.fullmatch(col["type"]) else "native-json"}
                    for i, col in enumerate(cols)],
        "files": {"ingitdb": {"path": str(records_path.relative_to(output)), "sha256": digest(records_path)},
                  "bigqueryRows": {"path": str(rows_path.relative_to(output)), "sha256": digest(rows_path)},
                  "bigquerySchema": {"path": str(schema_path.relative_to(output)), "sha256": digest(schema_path)}},
    }


def export(root: Path, output: Path) -> dict[str, Any]:
    if output.exists() and (not output.is_dir() or any(output.iterdir())):
        raise ImportError(f"output directory is not empty: {output}")
    snapshot = inspect(root)
    try:
        manifest = json.loads((root / "manifest.json").read_text())
        catalogue_path = Path(__file__).resolve().parents[2] / "config" / "databases.json"
        catalogue = json.loads(catalogue_path.read_text())
        pin = next((entry for entry in catalogue["databases"] if entry["id"] == snapshot.database_id), None)
        if pin is None:
            raise ImportError(f"{snapshot.database_id}: not pinned in catalogue")
        contract_path = next((path for path in (root / "contract.json", root / "metadata" / "contract.json") if path.is_file()), None)
        if contract_path is None or digest(contract_path) != pin["contractSha256"]:
            raise ImportError(f"{snapshot.database_id}: provider contract differs from catalogue pin")
        contract = json.loads(contract_path.read_text())
        if contract.get("manifest", {}).get("source") != manifest.get("source"):
            raise ImportError(f"{snapshot.database_id}: source provenance differs from pinned contract")
        output.mkdir(parents=True, exist_ok=True)
        tables = [export_table(snapshot, table, output) for table in snapshot.tables]
        (output / "ingitdb" / ".ingitdb").mkdir(parents=True, exist_ok=True)
        collections = "".join(f'{table["collection"]}: {table["collection"]}\n' for table in tables)
        (output / "ingitdb" / ".ingitdb" / "root-collections.yaml").write_text(collections)
        result = {"format": "demodb-storage-export/v1", "datasetId": snapshot.database_id,
                  "source": {"repository": manifest["source"]["repository"], "revision": manifest["source"]["revision"],
                             "providerRepository": pin["repository"], "providerCommit": pin["commit"],
                             "providerContractSha256": pin["contractSha256"],
                             "fixtureSha256": snapshot.source_sha256, "fixtureBytes": snapshot.source_bytes},
                  "rowCount": sum(table["rows"] for table in tables), "tables": tables,
                  "views": [{"name": view["name"], "status": "source-definition-only",
                             "columns": view["columns"], "sourceSql": view["sql"]} for view in snapshot.views],
                  "status": "prepared-not-hosted"}
        (output / "export-manifest.json").write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
        return result
    finally:
        snapshot.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("provider_root", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    print(json.dumps({"datasetId": (result := export(args.provider_root, args.output))["datasetId"],
                      "tables": len(result["tables"]), "rows": result["rowCount"]}))
