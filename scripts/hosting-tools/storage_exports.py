#!/usr/bin/env python3
"""Prepare BigQuery load files from pinned SQLite; DataTug writes inGitDB.

The `export` entry point runs DataTug's generic DALgo exporter and then
independently checks the native result before publishing a prepared bundle.
Views retain source SQL metadata and are never materialized here.
"""
from __future__ import annotations

import argparse
import base64
import ctypes
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

import yaml

from postgres_samples import DECIMAL_TEXT, DECIMAL_TYPED, ImportError, inspect, load_source, quote
from validate_datatug_exports import _native_id, _source_rows, validate as validate_native


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True, allow_nan=False)


def digest(path: Path) -> str:
    hashed = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            hashed.update(chunk)
    return hashed.hexdigest()


def publish_exclusive(staging: Path, output: Path) -> None:
    """Atomically install a prepared directory only if no destination exists."""
    if sys.platform == "darwin":
        libc = ctypes.CDLL(None, use_errno=True)
        operation = libc.renamex_np
        operation.argtypes = (ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint)
        arguments = (os.fsencode(staging), os.fsencode(output), 0x00000004)  # RENAME_EXCL
    elif sys.platform.startswith("linux"):
        libc = ctypes.CDLL(None, use_errno=True)
        operation = libc.renameat2
        operation.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint)
        arguments = (-100, os.fsencode(staging), -100, os.fsencode(output), 1)  # AT_FDCWD, RENAME_NOREPLACE
    elif os.name == "nt":
        os.rename(staging, output)  # Windows refuses existing destinations.
        return
    else:
        raise ImportError(f"exclusive directory rename is unavailable on {sys.platform}")
    operation.restype = ctypes.c_int
    if operation(*arguments) != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code), str(output))


PUBLIC_PARITY_FIELDS = ("format", "datasetId", "sourceSha256", "tables", "views", "rows",
                        "sourceOrphans", "dataChecked", "metadataMatches", "metadataAndDataMatch",
                        "nativeConstraintEquivalent", "errors", "errorCount", "nativeLimitations")


def persist_public_parity(native_root: Path, parity: dict[str, Any]) -> Path:
    """Retain only portable checker fields in a publicly distributable receipt."""
    public_report = {field: parity[field] for field in PUBLIC_PARITY_FIELDS}
    path = native_root / "native-parity-report.json"
    path.write_text(json.dumps(public_report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return path


def decimal_declared(declared: str) -> bool:
    return bool(DECIMAL_TEXT.fullmatch(declared) or DECIMAL_TYPED.fullmatch(declared) or
                re.fullmatch(r"(?i)(?:NUMERIC|DECIMAL|MONEY)", declared.strip()))


def scalar(value: Any, declared: str) -> Any:
    if value is None:
        return None
    if isinstance(value, bytes):
        return base64.b64encode(value).decode("ascii")
    if DECIMAL_TEXT.fullmatch(declared):
        if not isinstance(value, str):
            raise ImportError("DECIMAL_TEXT value is not stored as source text")
        return value
    if decimal_declared(declared):
        # Mirror postgres_samples._normal: normalize SQLite's stored decimal
        # value through Decimal(str(value)), never a binary float in JSON.
        try:
            return format(Decimal(str(value)), "f")
        except InvalidOperation as exc:
            raise ImportError(f"invalid decimal value {value!r}") from exc
    if isinstance(value, float) and not math.isfinite(value):
        raise ImportError("non-finite SQLite float cannot be represented by JSON")
    if isinstance(value, (str, int, float)):
        return value
    raise ImportError(f"unsupported SQLite value type {type(value).__name__}")


def bigquery_type(declared: str, observed: set[str]) -> str:
    if decimal_declared(declared) and not (DECIMAL_TEXT.fullmatch(declared) or DECIMAL_TYPED.fullmatch(declared)):
        return "STRING"  # Unbounded precision: exact decimal text is safer than FLOAT.
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


def record_id(row: tuple[Any, ...], columns: list[dict[str, Any]], ordinal: int) -> str:
    """Legacy Python edition ID, retained for its published parity checker."""
    keys = sorted(((col["pk"], i) for i, col in enumerate(columns) if col["pk"]))
    if not keys:
        return f"row-{ordinal:012d}"
    values = [[type(row[i]).__name__, scalar(row[i], columns[i]["type"])] for _, i in keys]
    if any(value[1] is None for value in values):
        raise ImportError("source primary key contains NULL")
    return "pk-" + base64.urlsafe_b64encode(canonical(values).encode()).decode().rstrip("=")


def export_table(snapshot: Any, table: dict[str, Any], output: Path, native_root: Path,
                 native_id: str) -> dict[str, Any]:
    table_name = table["name"]
    cols = table["columns"]
    names = [col["name"] for col in cols]
    bq_names = bq_column_names(names)
    bq_dir = output / "bigquery" / table_name
    bq_dir.mkdir(parents=True, exist_ok=True)
    rows_path = bq_dir / "rows.ndjson"
    native_definition = yaml.safe_load((native_root / native_id / ".collection" / "definition.yaml").read_text(encoding="utf-8"))
    native_fields = {field["name"]: field for field in native_definition["source_schema"]["fields"]}
    records_path = native_root / native_id / native_definition["record_file"]["name"]
    observed: dict[str, set[str]] = {name: set() for name in names}
    for row in snapshot.rows(table_name):
        for col, value in zip(cols, row):
            observed[col["name"]].add("null" if value is None else type(value).__name__)
    mixed = {name: len(types - {"null"}) > 1 for name, types in observed.items()}
    seen: set[str] = set()
    count = 0
    with rows_path.open("w", encoding="utf-8") as bq:
        for count, row, _classes in _source_rows(snapshot, table):
            rid = _native_id(row, cols, count, native_fields)
            if rid in seen:
                raise ImportError(f"duplicate primary-key transport ID in {table_name}: {rid}")
            seen.add(rid)
            bq_row = {"_transport_id": rid}
            for col, value in zip(cols, row):
                name = col["name"]
                encoded = encode_value(value, col["type"], mixed[name])
                if decode_value(encoded, col["type"], mixed[name], type(value)) != value:
                    raise ImportError(f"value failed typed round-trip: {table_name}.{name}")
                bq_value = canonical(encoded) if mixed[name] and value is not None else encoded
                if value is not None and DECIMAL_TEXT.fullmatch(col["type"]) and not mixed[name]:
                    bq_value = format(Decimal(encoded), "f")
                bq_row[bq_names[name]] = bq_value
            bq.write(canonical(bq_row) + "\n")
    # Native bytes are DataTug output. This function writes BigQuery files only.
    primary_key = [col["name"] for col in sorted(cols, key=lambda c: c["pk"]) if col["pk"]]
    fields = [{"name": "_transport_id", "type": "STRING", "mode": "REQUIRED"}]
    for col in cols:
        kind = bigquery_type(col["type"], observed[col["name"]])
        fields.append({"name": bq_names[col["name"]], "type": kind, "mode": "NULLABLE"})
    schema_path = bq_dir / "schema.json"
    schema_path.write_text(json.dumps(fields, indent=2) + "\n", encoding="utf-8")
    return {
        "nativeName": table_name, "collection": native_id, "rows": count,
        "primaryKey": primary_key,
        "transportId": "encoded-native-primary-key" if any(col["pk"] for col in cols) else "source-row-ordinal-not-native-key",
        "sourceSql": table["sql"],
        "indexes": table["indexes"],
        "foreignKeys": [{"id": fk[0], "sequence": fk[1], "table": fk[2], "from": fk[3], "to": fk[4],
                         "onUpdate": fk[5], "onDelete": fk[6], "match": fk[7]} for fk in table["foreign_keys"]],
        "foreignKeyConstraints": [
            {"id": fk_id, "localColumns": [row[3] for row in group], "referencedTable": group[0][2],
             "referencedColumns": [row[4] for row in group], "onUpdate": group[0][5],
             "onDelete": group[0][6], "match": group[0][7], "enforced": False}
            for fk_id, group in sorted((fk_id, sorted((row for row in table["foreign_keys"] if row[0] == fk_id),
                                                  key=lambda row: row[1])) for fk_id in {row[0] for row in table["foreign_keys"]})
        ],
        "columns": [{"nativeName": col["name"], "declaredType": col["type"], "bigqueryName": bq_names[col["name"]],
                     "bigqueryType": fields[i + 1]["type"], "sourceNotNull": col["notnull"],
                     "primaryKeyPosition": col["pk"], "sourceDeclaredNullable": not col["notnull"],
                     "defaultValue": col["default"],
                     "ingitdbType": native_definition["columns"][col["name"]]["type"],
                     "exportRequired": bool(col["notnull"] or col["pk"]),
                     "encoding": native_fields[col["name"]].get("encoding", "native-json")}
                    for i, col in enumerate(cols)],
        "records": {"path": str(records_path.relative_to(native_root)), "sha256": digest(records_path)},
        "files": {"ingitdb": {"path": str(records_path.relative_to(output)), "sha256": digest(records_path)},
                  "bigqueryRows": {"path": str(rows_path.relative_to(output)), "sha256": digest(rows_path)},
                  "bigquerySchema": {"path": str(schema_path.relative_to(output)), "sha256": digest(schema_path)}},
    }


def export(root: Path, output: Path, *, datatug: Path | None = None,
           records_format: str = "json") -> dict[str, Any]:
    records_format = records_format.lower()
    if records_format == "yml":
        records_format = "yaml"
    if records_format not in {"json", "jsonl", "ingr", "csv", "yaml"}:
        raise ImportError(f"unsupported native records format: {records_format}")
    if output.exists() and (not output.is_dir() or any(output.iterdir())):
        raise ImportError(f"output directory is not empty: {output}")
    snapshot = inspect(root)
    decoded_source: Path | None = None
    staging: Path | None = None
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
        _, db_path, source_sha, _, decoded_source = load_source(root)
        if source_sha != snapshot.source_sha256:
            raise ImportError("decoded fixture changed during source inspection")
        cli = datatug or Path(shutil.which("datatug") or "")
        if not cli.is_file():
            raise ImportError("DataTug CLI is unavailable; pass --datatug with a build supporting db export")
        version_result = subprocess.run([str(cli), "version", "--json"], capture_output=True, text=True, check=False)
        if version_result.returncode:
            raise ImportError(f"cannot identify DataTug CLI version: {version_result.stderr.strip()}")
        try:
            cli_version = json.loads(version_result.stdout)
            if not all(isinstance(cli_version.get(key), str) and cli_version[key] for key in ("version", "commit")):
                raise ValueError("version or commit is absent")
        except (json.JSONDecodeError, ValueError) as exc:
            raise ImportError("DataTug CLI did not return a verifiable version receipt") from exc
        output.parent.mkdir(parents=True, exist_ok=True)
        staging = Path(tempfile.mkdtemp(prefix=f".{output.name}-datatug-", dir=output.parent))
        native_root = staging / "ingitdb"
        command = [str(cli), "db", "export", "--from", db_path.as_uri().replace("file:", "sqlite:", 1),
                   "--to", native_root.as_uri().replace("file:", "ingitdb:", 1),
                   "--records-format", records_format]
        process = subprocess.run(command, capture_output=True, text=True, check=False)
        if process.returncode:
            raise ImportError(f"DataTug export failed: {process.stderr.strip() or process.stdout.strip()}")
        if digest(db_path) != source_sha:
            raise ImportError("DataTug export changed the pinned SQLite source")
        parity = validate_native(root, native_root)
        if parity["sourceSha256"] != source_sha:
            raise ImportError("DataTug parity receipt refers to different SQLite source bytes")
        if not parity["metadataAndDataMatch"]:
            raise ImportError(f"DataTug native export differs from pinned SQLite: {parity['errors'][:5]}")
        parity_path = persist_public_parity(native_root, parity)
        mapping_path = native_root / ".ingitdb" / "source-collections.json"
        mapping = json.loads(mapping_path.read_text(encoding="utf-8"))["collections"]
        source_to_native = {source: native for native, source in mapping.items()}
        tables = [export_table(snapshot, table, staging, native_root, source_to_native[table["name"]])
                  for table in snapshot.tables]
        result = {"format": "demodb-storage-export/v2", "generator": "datatug-dalgo-to-ingitdb",
                  "recordFormat": records_format,
                  "generatorVersion": cli_version["version"], "generatorCommit": cli_version["commit"],
                  "generatorSha256": digest(cli), "datasetId": snapshot.database_id,
                  "source": {"repository": manifest["source"]["repository"], "revision": manifest["source"]["revision"],
                             "providerRepository": pin["repository"], "providerCommit": pin["commit"],
                             "providerContractSha256": pin["contractSha256"],
                             "fixtureSha256": snapshot.source_sha256, "fixtureBytes": snapshot.source_bytes},
                  "rowCount": sum(table["rows"] for table in tables), "tables": tables,
                  "sourceCollections": {"path": "ingitdb/.ingitdb/source-collections.json",
                                        "sha256": digest(mapping_path)},
                  "views": [{"name": view["name"], "status": "source-definition-only",
                             "columns": view["columns"], "sourceSql": view["sql"]} for view in snapshot.views],
                  "status": "prepared-not-hosted", "nativeParity": {"format": parity["format"],
                  "sourceSha256": parity["sourceSha256"], "tables": parity["tables"], "rows": parity["rows"],
                  "dataChecked": parity["dataChecked"], "metadataAndDataMatch": True,
                  "sourceOrphans": parity["sourceOrphans"], "errorCount": parity["errorCount"],
                  "report": {"path": "ingitdb/native-parity-report.json", "sha256": digest(parity_path)}}}
        serialized = json.dumps(result, indent=2, ensure_ascii=False) + "\n"
        (staging / "export-manifest.json").write_text(serialized, encoding="utf-8")
        (native_root / "export-manifest.json").write_text(serialized, encoding="utf-8")
        if output.exists():
            if any(output.iterdir()):
                raise ImportError(f"output directory became nonempty: {output}")
            output.rmdir()
        publish_exclusive(staging, output)
        staging = None
        return result
    finally:
        snapshot.close()
        if decoded_source:
            decoded_source.unlink(missing_ok=True)
        if staging:
            shutil.rmtree(staging)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("provider_root", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--datatug", type=Path, help="DataTug CLI build with db export support")
    parser.add_argument("--records-format", default="json", choices=("json", "jsonl", "ingr", "csv", "yaml", "yml"))
    args = parser.parse_args()
    print(json.dumps({"datasetId": (result := export(args.provider_root, args.output, datatug=args.datatug,
                                                   records_format=args.records_format))["datasetId"],
                      "tables": len(result["tables"]), "rows": result["rowCount"]}))
