#!/usr/bin/env python3
"""Verify pinned DemoDB inGitDB, PostgreSQL, and hosted BigQuery snapshots.

This job reuses the repository's independent SQLite/inGitDB and PostgreSQL
parity validators. BigQuery verification reads only dataset/table metadata; it
does not submit query jobs or claim full-cell equality.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tarfile
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import quote, urlencode

from postgres_samples import ImportError as SnapshotError
from postgres_samples import _connection_from_url_file, inspect, verify_database
from validate_datatug_exports import validate as validate_ingitdb


DATASET_IDS = ("chinook", "northwind", "pubs", "sakila", "adventureworks", "employees")
PG_SECRET_PREFIX = "DEMODB_PG_VERIFY_URL_"
BQ_API = "https://bigquery.googleapis.com/bigquery/v2"


def _safe_json(response: Any) -> dict[str, Any]:
    try:
        value = json.load(response)
    except (ValueError, OSError) as exc:
        raise SnapshotError("BigQuery API returned invalid JSON") from exc
    if not isinstance(value, dict):
        raise SnapshotError("BigQuery API returned an unexpected response")
    return value


def bq_get(token: str, path: str, *, timeout: float = 12.0) -> dict[str, Any]:
    """Make one bounded metadata GET; never include credentials in diagnostics."""
    if not token or "\n" in token or "\r" in token:
        raise SnapshotError("BigQuery read token is missing or malformed")
    request = urllib.request.Request(
        f"{BQ_API}/{path.lstrip('/')}",
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
        method="GET",
    )
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return _safe_json(response)
        except urllib.error.HTTPError as exc:
            if exc.code not in (429, 500, 502, 503, 504) or attempt == 2:
                raise SnapshotError(f"BigQuery metadata request failed with HTTP {exc.code}") from None
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            if attempt == 2:
                raise SnapshotError(f"BigQuery metadata request failed ({type(exc).__name__})") from None
        time.sleep(0.5 * (attempt + 1))
    raise SnapshotError("BigQuery metadata request exhausted retries")


def _run_git(args: list[str], *, cwd: Path | None = None) -> str:
    result = subprocess.run(args, cwd=cwd, capture_output=True, text=True, check=False,
                            env={**os.environ, "GIT_TERMINAL_PROMPT": "0"})
    if result.returncode:
        # Git diagnostics can contain remote URLs; report only the failed operation.
        raise SnapshotError(f"pinned source checkout failed: {Path(args[0]).name} {args[1]}")
    return result.stdout.strip()


def _archive_commit(repo: Path, revision: str, destination: Path) -> None:
    process = subprocess.Popen(["git", "archive", "--format=tar", revision], cwd=repo,
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        assert process.stdout is not None
        with tarfile.open(fileobj=process.stdout, mode="r|") as archive:
            archive.extractall(destination, filter="data")
        if process.wait(timeout=60) != 0:
            raise SnapshotError("could not materialize a pinned provider revision")
    except Exception:
        process.kill()
        process.wait()
        raise


def materialize_provider(entry: dict[str, Any], native_revision: str,
                         temporary_root: Path) -> tuple[Path, Path]:
    """Materialize two immutable revisions from one provider repository."""
    repository = entry.get("repository")
    source_revision = entry.get("commit")
    expected_repository = f"https://github.com/demo-db/{entry.get('id')}"
    if (not isinstance(repository, str) or repository.removesuffix(".git") != expected_repository
            or not isinstance(source_revision, str) or not re.fullmatch(r"[0-9a-f]{40}", source_revision)
            or not isinstance(native_revision, str) or not re.fullmatch(r"[0-9a-f]{40}", native_revision)):
        raise SnapshotError("provider pin is malformed")
    clone = temporary_root / f"{entry['id']}-git"
    _run_git(["git", "clone", "--filter=blob:none", "--no-checkout", "--depth=1", repository, str(clone)])
    _run_git(["git", "fetch", "--depth=1", "origin", source_revision, native_revision], cwd=clone)
    source_root = temporary_root / f"{entry['id']}-source"
    native_root = temporary_root / f"{entry['id']}-native"
    source_root.mkdir()
    native_root.mkdir()
    for revision in (source_revision, native_revision):
        actual = _run_git(["git", "rev-parse", f"{revision}^{{commit}}"], cwd=clone)
        if actual != revision:
            raise SnapshotError(f"{entry['id']}: resolved provider revision differs from catalogue pin")
    _archive_commit(clone, source_revision, source_root)
    _archive_commit(clone, native_revision, native_root)
    return source_root, native_root / "ingitdb"


def verify_postgres_inventory(connection: Any, provider_root: Path) -> dict[str, Any]:
    """Require the selected PostgreSQL schema to contain only pinned relations.

    The importer adds `_import_manifest` for provenance. No other extra tables,
    views, materialized views, or foreign tables are accepted.
    """
    snapshot = inspect(provider_root)
    try:
        expected: dict[str, str] = {table["name"]: "table" for table in snapshot.tables}
        expected.update({view["name"]: "view" for view in snapshot.views})
        if "_import_manifest" in expected:
            raise SnapshotError("pinned source collides with PostgreSQL import provenance table")
        expected["_import_manifest"] = "table"
        cursor = connection.cursor()
        cursor.execute(
            """SELECT c.relname, c.relkind
               FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = %s AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
               ORDER BY c.relname""",
            (snapshot.database_id,),
        )
        kind_names = {"r": "table", "p": "partitioned table", "v": "view",
                      "m": "materialized view", "f": "foreign table"}
        actual_rows = cursor.fetchall()
        actual = {name: kind_names[kind] for name, kind in actual_rows}
        if len(actual) != len(actual_rows):
            raise SnapshotError("PostgreSQL selected schema has duplicate relation names")
        if actual != expected:
            missing = sorted(set(expected) - set(actual))
            extra = sorted(set(actual) - set(expected))
            wrong_kind = sorted(name for name in set(expected) & set(actual) if expected[name] != actual[name])
            raise SnapshotError(
                f"{snapshot.database_id}: PostgreSQL relation inventory drift "
                f"(missing={missing[:8]}, extra={extra[:8]}, kindMismatch={wrong_kind[:8]})"
            )
        return {"tables": len(snapshot.tables), "views": len(snapshot.views),
                "provenanceTables": 1, "inventoryMatch": True}
    finally:
        snapshot.close()


def _private_url_file(url: str, directory: Path, dataset_id: str) -> Path:
    if not url or "\n" in url or "\r" in url:
        raise SnapshotError(f"{dataset_id}: PostgreSQL verifier URL secret is missing or malformed")
    path = directory / f"{dataset_id}.pg-url"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(url)
            stream.write("\n")
    except Exception:
        path.unlink(missing_ok=True)
        raise
    return path


def verify_postgres(url: str, provider_root: Path, dataset_id: str,
                    temporary_root: Path) -> dict[str, Any]:
    url_file = _private_url_file(url, temporary_root, dataset_id)
    connection = None
    try:
        connection = _connection_from_url_file(url_file)
        connection.execute("SET default_transaction_read_only = on")
        connection.commit()
        if connection.execute("SHOW default_transaction_read_only").fetchone()[0] != "on":
            raise SnapshotError(f"{dataset_id}: PostgreSQL connection did not enter read-only mode")
        inventory = verify_postgres_inventory(connection, provider_root)
        parity = verify_database(connection, provider_root)
        if parity.get("id") != dataset_id or parity.get("tables") != inventory["tables"]:
            raise SnapshotError(f"{dataset_id}: PostgreSQL parity receipt does not match pinned source")
        return {**parity, **inventory}
    except SnapshotError:
        raise
    except Exception as exc:
        # Driver exceptions may interpolate a DSN; keep only their class name.
        raise SnapshotError(f"{dataset_id}: PostgreSQL verification failed ({type(exc).__name__})") from None
    finally:
        if connection is not None:
            connection.close()
        url_file.unlink(missing_ok=True)


def load_pins(root: Path) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    catalogue = json.loads((root / "config" / "databases.json").read_text(encoding="utf-8"))
    hosted = json.loads((root / "config" / "bigquery-hosting.json").read_text(encoding="utf-8"))
    verification = json.loads((root / "config" / "hosted-snapshot-verification.json").read_text(encoding="utf-8"))
    if (verification.get("format") != "demodb-hosted-snapshot-verification/v1"
            or verification.get("projectId") != hosted.get("projectId")
            or verification.get("location") != hosted.get("location")
            or verification.get("secretsIncluded") is not False):
        raise SnapshotError("hosted verification config has an unexpected identity or scope")
    catalogue_items = catalogue.get("databases", [])
    hosted_items = hosted.get("datasets", [])
    entries = {entry["id"]: entry for entry in catalogue_items}
    hosted_entries = {entry["id"]: entry for entry in hosted_items}
    if (len(catalogue_items) != len(DATASET_IDS) or len(hosted_items) != len(DATASET_IDS)
            or set(entries) != set(DATASET_IDS) or set(hosted_entries) != set(DATASET_IDS)):
        raise SnapshotError("checked-in provider and hosted dataset pins must contain exactly six datasets")
    for dataset_id in DATASET_IDS:
        provider, hosted_entry = entries[dataset_id], hosted_entries[dataset_id]
        if (provider.get("commit") != hosted_entry.get("sourceRevision")
                or hosted_entry.get("sourceRepository") != provider.get("repository")):
            raise SnapshotError(f"{dataset_id}: hosted metadata is not bound to its provider source pin")
    if hosted.get("projectId") != "demodb-dev" or hosted.get("location") != "US":
        raise SnapshotError("hosted BigQuery project or location differs from the reviewed receipt")
    baseline_ref = verification.get("schemaBaseline", {})
    baseline_path = root / baseline_ref.get("path", "")
    if not baseline_path.resolve().is_relative_to(root.resolve()) or not baseline_path.is_file():
        raise SnapshotError("checked-in BigQuery schema baseline is missing")
    baseline_bytes = baseline_path.read_bytes()
    if hashlib.sha256(baseline_bytes).hexdigest() != baseline_ref.get("sha256"):
        raise SnapshotError("checked-in BigQuery schema baseline SHA-256 differs from hosting receipt")
    baseline = json.loads(baseline_bytes)
    if (baseline.get("format") != "demodb-bigquery-schema-baseline/v1"
            or baseline.get("projectId") != verification["projectId"]
            or baseline.get("location") != verification["location"]
            or baseline.get("secretsIncluded") is not False
            or not isinstance(baseline.get("sourceTableBindingMethod"), str)
            or "one-to-one" not in baseline.get("sourceTableBindingMethod", "").lower()
            or baseline.get("verificationScope") != "Live BigQuery table metadata and row counts; not full-cell equality"):
        raise SnapshotError("checked-in BigQuery schema baseline has an unexpected identity or scope")
    baseline_entries = {item.get("id"): item for item in baseline.get("datasets", [])}
    if set(baseline_entries) != set(DATASET_IDS):
        raise SnapshotError("BigQuery schema baseline must bind exactly the six hosted datasets")
    for dataset_id in DATASET_IDS:
        provider, hosted_entry = entries[dataset_id], hosted_entries[dataset_id]
        observed = baseline_entries[dataset_id]
        if (observed.get("datasetId") != hosted_entry.get("datasetId")
                or observed.get("sourceRevision") != provider.get("commit")
                or observed.get("sourceSqliteSha256") != hosted_entry.get("sourceSqliteSha256")
                or observed.get("tableCount") != hosted_entry.get("tableCount")
                or observed.get("rowCount") != hosted_entry.get("rowCount")):
            raise SnapshotError(f"{dataset_id}: BigQuery baseline is not bound to the checked-in source pin")
    hosted["_schemaBaseline"] = baseline
    hosted["_schemaBaselineSha256"] = baseline_ref["sha256"]
    return catalogue, hosted, entries


def _field_type_compatible(declared: str, target: str) -> bool:
    """Reject incompatible types without reproducing the DataTug export mapper."""
    source = (declared or "").strip().upper()
    target = target.upper()
    if any(token in source for token in ("BLOB", "BINARY", "IMAGE")):
        return target == "BYTES"
    if "TIMESTAMP" in source:
        return target in {"TIMESTAMP", "DATETIME", "STRING"}
    if "DATETIME" in source or ("DATE" in source and "TIME" in source):
        return target in {"DATETIME", "TIMESTAMP", "STRING"}
    if source == "DATE" or source.startswith("DATE("):
        return target in {"DATE", "STRING"}
    if "TIME" in source:
        return target in {"TIME", "STRING"}
    if source.startswith("DECIMAL_TEXT"):
        return target == "STRING"
    exact_decimal = re.match(r"^(?:NUMERIC|DECIMAL)\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)$", source)
    if exact_decimal:
        precision, scale = map(int, exact_decimal.groups())
        if target == "NUMERIC":
            return precision <= 38 and scale <= 9 and precision - scale <= 29
        if target == "BIGNUMERIC":
            return precision <= 76 and scale <= 38 and precision - scale <= 38
        return target == "STRING"
    if source.startswith(("NUMERIC", "DECIMAL", "NUMBER", "MONEY")):
        return target in {"NUMERIC", "BIGNUMERIC", "STRING"}
    if any(token in source for token in ("INT", "BOOL", "BIT")):
        return target in {"INTEGER", "STRING"}
    if any(token in source for token in ("REAL", "FLOAT", "DOUBLE")):
        return target in {"FLOAT", "STRING"}
    # SQLite text-affinity values may encode dates or numbers. The exact
    # observed target type is separately bound by the immutable baseline.
    return target == "STRING"


def verify_source_schema_compatibility(snapshot: Any, baseline_dataset: dict[str, Any]) -> dict[str, Any]:
    """Bind observed fields to ordered pinned SQLite table/column metadata."""
    expected_tables = {table["name"]: table for table in snapshot.tables}
    bound: set[str] = set()
    for target_table in baseline_dataset.get("tables", []):
        source_name = target_table.get("sourceTable")
        if not isinstance(source_name, str) or source_name not in expected_tables or source_name in bound:
            raise SnapshotError(f"{snapshot.database_id}: baseline sourceTable binding is missing, extra, or repeated")
        bound.add(source_name)
        source_table = expected_tables[source_name]
        if target_table.get("rowCount") != snapshot.row_count(source_name):
            raise SnapshotError(f"{snapshot.database_id}.{source_name}: baseline row count differs from pinned SQLite")
        fields = target_table.get("schema", {}).get("fields")
        columns = source_table["columns"]
        if not isinstance(fields, list) or len(fields) != len(columns):
            raise SnapshotError(f"{snapshot.database_id}.{source_name}: BigQuery field count differs from SQLite")
        names: set[str] = set()
        for field, column in zip(fields, columns):
            source_column = column["name"]
            if field.get("description") != f"Source field: {source_column}":
                raise SnapshotError(f"{snapshot.database_id}.{source_name}: source field order or mapping differs")
            field_name = field.get("name")
            if not isinstance(field_name, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", field_name):
                raise SnapshotError(f"{snapshot.database_id}.{source_name}: BigQuery field name is invalid")
            if field_name in names:
                raise SnapshotError(f"{snapshot.database_id}.{source_name}: BigQuery field names collide")
            names.add(field_name)
            # SQLite PRAGMA reports notnull=false for rowid INTEGER PRIMARY
            # KEY, although that form is effectively non-null. Composite and
            # non-integer primary keys retain SQLite's nullable semantics.
            primary_columns = [item for item in columns if item["pk"]]
            rowid_primary = (len(primary_columns) == 1 and primary_columns[0]["name"] == source_column
                             and column["type"].strip().upper() == "INTEGER"
                             and "WITHOUT ROWID" not in source_table["sql"].upper())
            required = bool(column["notnull"] or rowid_primary
                            or ("WITHOUT ROWID" in source_table["sql"].upper() and column["pk"]))
            if field.get("mode", "NULLABLE") != ("REQUIRED" if required else "NULLABLE"):
                raise SnapshotError(f"{snapshot.database_id}.{source_name}.{source_column}: nullability differs")
            if not _field_type_compatible(column["type"], str(field.get("type", ""))):
                raise SnapshotError(f"{snapshot.database_id}.{source_name}.{source_column}: target type is incompatible with source declaration")
    if bound != set(expected_tables):
        raise SnapshotError(f"{snapshot.database_id}: BigQuery source table inventory differs from pinned SQLite")
    total_rows = sum(snapshot.row_count(name) for name in expected_tables)
    if (baseline_dataset.get("tableCount") != len(expected_tables)
            or baseline_dataset.get("rowCount") != total_rows):
        raise SnapshotError(f"{snapshot.database_id}: BigQuery baseline aggregate counts differ from pinned SQLite")
    return {"sourceSchemaBindings": len(bound), "sourceRows": total_rows}


def verify_bigquery_metadata(dataset_id: str, token: str, hosted: dict[str, Any],
                             baseline_dataset: dict[str, Any], snapshot: Any) -> dict[str, Any]:
    """Compare live BigQuery metadata with the checked-in observed schema baseline."""
    project = hosted["projectId"]
    dataset = baseline_dataset["datasetId"]
    prefix = f"projects/{quote(project, safe='')}/datasets/{quote(dataset, safe='')}"
    dataset_metadata = bq_get(token, prefix)
    reference = dataset_metadata.get("datasetReference", {})
    if (reference.get("projectId") != project or reference.get("datasetId") != dataset
            or dataset_metadata.get("location") != hosted["location"]):
        raise SnapshotError(f"{dataset_id}: live BigQuery dataset identity/location differs from baseline")
    listed: dict[str, dict[str, Any]] = {}
    page_token: str | None = None
    while True:
        query = urlencode({"maxResults": "1000", **({"pageToken": page_token} if page_token else {})})
        page = bq_get(token, f"{prefix}/tables?{query}")
        for item in page.get("tables", []):
            table_id = item.get("tableReference", {}).get("tableId")
            if not isinstance(table_id, str) or table_id in listed:
                raise SnapshotError(f"{dataset_id}: BigQuery table inventory has missing or duplicate IDs")
            listed[table_id] = item
        page_token = page.get("nextPageToken")
        if not page_token:
            break
    expected = {item["tableId"]: item for item in baseline_dataset.get("tables", [])}
    if set(listed) != set(expected):
        raise SnapshotError(f"{dataset_id}: BigQuery table inventory differs from checked-in baseline")

    def get_table(table_id: str) -> dict[str, Any]:
        return bq_get(token, f"{prefix}/tables/{quote(table_id, safe='')}")

    with ThreadPoolExecutor(max_workers=8) as pool:
        actual = dict(zip(expected, pool.map(get_table, expected)))
    total_rows = 0
    for table_id, expected_table in expected.items():
        got = actual[table_id]
        reference = got.get("tableReference", {})
        if (reference.get("projectId") != project or reference.get("datasetId") != dataset
                or reference.get("tableId") != table_id or got.get("type") != "TABLE"):
            raise SnapshotError(f"{dataset_id}.{table_id}: live BigQuery table identity/type differs")
        if str(got.get("numRows", "")) != str(expected_table.get("rowCount")):
            raise SnapshotError(f"{dataset_id}.{table_id}: live BigQuery row count differs from baseline")
        if got.get("schema", {}).get("fields") != expected_table.get("schema", {}).get("fields"):
            raise SnapshotError(f"{dataset_id}.{table_id}: live BigQuery schema differs from baseline")
        if got.get("tableConstraints"):
            raise SnapshotError(f"{dataset_id}.{table_id}: unexpected unenforced BigQuery key constraints")
        total_rows += int(got["numRows"])
    source_result = verify_source_schema_compatibility(snapshot, baseline_dataset)
    if (len(expected) != baseline_dataset.get("tableCount")
            or total_rows != baseline_dataset.get("rowCount")):
        raise SnapshotError(f"{dataset_id}: BigQuery aggregate table or row count differs from baseline")
    return {"tables": len(expected), "rows": total_rows, **source_result,
            "metadataBaselineMatch": True, "sourceSchemaCompatible": True,
            "fullCellEqualityVerified": False, "queryJobsSubmitted": 0}


def verify_run(root: Path, *, env: dict[str, str] | None = None) -> dict[str, Any]:
    """Run all six pinned checks. Missing credentials and drift are fatal."""
    env = env or os.environ
    catalogue, hosted, entries = load_pins(root)
    token = env.get("DEMODB_VERIFY_BQ_ACCESS_TOKEN", "")
    if not token:
        raise SnapshotError("BigQuery read access token is missing")
    missing = [f"{PG_SECRET_PREFIX}{dataset.upper()}" for dataset in DATASET_IDS
               if not env.get(f"{PG_SECRET_PREFIX}{dataset.upper()}")]
    if missing:
        raise SnapshotError(f"required read-only PostgreSQL secret is missing: {missing[0]}")
    report: dict[str, Any] = {"format": "demodb-hosted-snapshot-verification/v1",
                              "projectId": hosted["projectId"], "location": hosted["location"],
                              "bigQuerySchemaBaselineSha256": hosted["_schemaBaselineSha256"],
                              "datasets": []}
    baseline_entries = {item["id"]: item for item in hosted["_schemaBaseline"]["datasets"]}
    with tempfile.TemporaryDirectory(prefix="demodb-hosted-verify-") as temp:
        run_temp = Path(temp)
        for dataset_id in DATASET_IDS:
            with tempfile.TemporaryDirectory(prefix=f"{dataset_id}-", dir=run_temp) as per_dataset:
                temporary_root = Path(per_dataset)
                provider = entries[dataset_id]
                native_revision = catalogue["ingitdbRevisions"].get(dataset_id)
                if not native_revision:
                    raise SnapshotError(f"{dataset_id}: inGitDB revision pin is missing")
                try:
                    stage = "provider materialization"
                    source_root, native_root = materialize_provider(provider, native_revision, temporary_root)
                    stage = "SQLite/inGitDB parity"
                    sqlite_native = validate_ingitdb(source_root, native_root, check_data=True)
                    hosted_entry = next(item for item in hosted["datasets"] if item["id"] == dataset_id)
                    if sqlite_native.get("sourceSha256") != hosted_entry.get("sourceSqliteSha256"):
                        raise SnapshotError("source SQLite digest differs from hosted source binding")
                    if sqlite_native.get("metadataAndDataMatch") is not True or sqlite_native.get("sourceOrphans") != 0:
                        raise SnapshotError("SQLite/inGitDB metadata, rows, or foreign keys differ")
                    stage = "BigQuery metadata"
                    source_snapshot = inspect(source_root)
                    try:
                        bq_result = verify_bigquery_metadata(dataset_id, token, hosted,
                                                             baseline_entries[dataset_id], source_snapshot)
                    finally:
                        source_snapshot.close()
                    stage = "PostgreSQL schema and typed-row parity"
                    pg_url = env[f"{PG_SECRET_PREFIX}{dataset_id.upper()}"]
                    pg_result = verify_postgres(pg_url, source_root, dataset_id, temporary_root)
                except (SnapshotError, OSError, ValueError, KeyError) as exc:
                    raise SnapshotError(f"{dataset_id}: {stage}: {exc}") from None
            report["datasets"].append({"id": dataset_id, "sourceRevision": provider["commit"],
                "inGitDBRevision": native_revision, "sourceSqliteSha256": sqlite_native["sourceSha256"],
                "sqliteInGitDB": {"tables": sqlite_native["tables"], "views": sqlite_native["views"],
                                  "rows": sqlite_native["rows"], "foreignKeyOrphans": sqlite_native["sourceOrphans"],
                                  "metadataAndDataMatch": sqlite_native["metadataAndDataMatch"]},
                "postgresql": pg_result, "bigquery": bq_result})
    return report


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2])
    args = parser.parse_args(argv)
    try:
        report = verify_run(args.root.resolve())
    except (SnapshotError, OSError, ValueError, KeyError) as exc:
        print(f"hosted-snapshot-verify: {exc}", file=sys.stderr)
        return 2
    serialized = json.dumps(report, indent=2, sort_keys=True)
    print(serialized)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as stream:
            stream.write("\n## Hosted snapshot verification\n\n")
            stream.write("SQLite/inGitDB metadata, rows, and foreign keys; PostgreSQL schema and full rows; and BigQuery schema/count metadata passed for all six pinned sources.\n\n")
            stream.write("BigQuery verification submits no SQL jobs and does not establish full-cell equality.\n\n")
            stream.write("| Dataset | SQLite/inGitDB rows | PostgreSQL rows | BigQuery rows |\n| --- | ---: | ---: | ---: |\n")
            for dataset in report["datasets"]:
                stream.write(f"| {dataset['id']} | {dataset['sqliteInGitDB']['rows']} | {dataset['postgresql']['rows']} | {dataset['bigquery']['rows']} |\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
