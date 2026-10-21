#!/usr/bin/env python3
"""Validate the downloads the site actually serves, against the pinned SQLite fixtures.

Runs over the built asset tree (``public/_db``), not over the generators' inputs, so it checks the bytes
a visitor downloads:

* PostgreSQL scripts are loaded into a throwaway PostgreSQL (loopback only) and compared with the pinned
  SQLite fixture: table set, row counts, primary-key columns and foreign-key counts for every script, plus
  the full typed row-multiset check of ``postgres_samples.verify_database`` for scripts the shared generator
  wrote. The Chinook script is the upstream one and is loaded the way psql would (it creates and connects to
  its own database).
* the YAML is loaded with PyYAML (a strict YAML 1.1 reader) and compared with the served JSON;
* inGitDB archives are extracted and compared, row by row and definition by definition, with the fixture by
  the independent parity checker ``validate_datatug_exports.py``. Native inGitDB source archives instead
  retain byte parity with the pinned originals after source hash, schema, key and row validation.

Needs psycopg 3 for PostgreSQL (scripts/hosting-tools/requirements-live.txt).
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import re
import sqlite3
import shutil
import tarfile
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))
import postgres_samples as pg  # noqa: E402
import validate_datatug_exports as ingitdb  # noqa: E402
from test_postgres_live import assert_loopback  # noqa: E402

UPSTREAM_PSQL_SCRIPTS = {"chinook"}  # scripts written by the dataset's upstream project for psql
# Chinook's YAML is the provider's own, with plain scalars: a YAML 1.1 reader reads Customer.State "ON" (Ontario) as true and
# Employee dates as timestamps. Documented in docs/format-matrix.md; the YAML generated here quotes every scalar.
PROVIDER_PLAIN_SCALAR_YAML = {"chinook"}


def read_export(data_dir: Path, item: dict[str, Any]) -> bytes:
    if item.get("chunks"):
        return gzip.decompress(b"".join((data_dir / chunk["assetPath"]).read_bytes() for chunk in item["chunks"]))
    raw = (data_dir / item["assetPath"]).read_bytes()
    return gzip.decompress(raw) if item.get("compression") == "gzip" else raw


def complete(db: dict[str, Any], fmt: str) -> dict[str, Any] | None:
    found = [item for item in db["exports"] if item["format"] == fmt and not item.get("table")]
    return found[0] if found else None


def norm(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", name.lower())


def provider_root(providers: Path, db_id: str) -> Path:
    root = providers / db_id
    if not (root / "manifest.json").is_file():
        raise SystemExit(f"provider checkout missing for {db_id}: {root}")
    return root


def source_sqlite(root: Path) -> tuple[sqlite3.Connection, Path | None]:
    manifest, path, _digest, _size, temporary = pg.load_source(root)
    return sqlite3.connect(path.as_uri() + "?mode=ro", uri=True), temporary


def structure(source: sqlite3.Connection) -> dict[str, dict[str, Any]]:
    tables: dict[str, dict[str, Any]] = {}
    for (name,) in source.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"):
        info = source.execute(f"PRAGMA table_info({pg.quote(name)})").fetchall()
        fks = source.execute(f"PRAGMA foreign_key_list({pg.quote(name)})").fetchall()
        tables[norm(name)] = {
            "name": name,
            "rows": source.execute(f"SELECT count(*) FROM {pg.quote(name)}").fetchone()[0],
            "pk": sorted(norm(row[1]) for row in info if row[5]),
            "fks": len({row[0] for row in fks}),
        }
    return tables


def check_structure(conn: Any, schema: str, expected: dict[str, dict[str, Any]], label: str) -> dict[str, int]:
    actual_tables = {
        row[0]: row[0] for row in conn.execute(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = %s AND table_type = 'BASE TABLE' AND table_name <> '_import_manifest'",
            (schema,),
        )
    }
    by_norm = {norm(name): name for name in actual_tables}
    if set(by_norm) != set(expected):
        raise AssertionError(f"{label}: table sets differ: only in script {sorted(set(by_norm) - set(expected))}, only in fixture {sorted(set(expected) - set(by_norm))}")
    rows = fks_total = pks = 0
    for key, want in sorted(expected.items()):
        table = by_norm[key]
        count = conn.execute(f'SELECT count(*) FROM "{schema}"."{table}"').fetchone()[0]
        if count != want["rows"]:
            raise AssertionError(f"{label}.{table}: {count} rows in PostgreSQL, {want['rows']} in the fixture")
        pk_cols = sorted(norm(row[0]) for row in conn.execute(
            """SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
               WHERE i.indrelid = %s::regclass AND i.indisprimary""", (f'"{schema}"."{table}"',)))
        if pk_cols != want["pk"]:
            raise AssertionError(f"{label}.{table}: primary key {pk_cols} in PostgreSQL, {want['pk']} in the fixture")
        fk_count = conn.execute("SELECT count(*) FROM pg_constraint WHERE conrelid = %s::regclass AND contype = 'f'", (f'"{schema}"."{table}"',)).fetchone()[0]
        if fk_count != want["fks"]:
            raise AssertionError(f"{label}.{table}: {fk_count} foreign keys in PostgreSQL, {want['fks']} in the fixture")
        rows += count
        fks_total += fk_count
        pks += 1 if pk_cols else 0
    return {"tables": len(expected), "rows": rows, "primaryKeys": pks, "foreignKeys": fks_total}


def validate_postgresql(url: str, db: dict[str, Any], data_dir: Path, providers: Path) -> dict[str, Any]:
    import psycopg
    from psycopg import conninfo
    item = complete(db, "postgresql")
    script = read_export(data_dir, item).decode("utf-8")
    root = provider_root(providers, db["id"])
    source, temporary = source_sqlite(root)
    schema = db["id"]
    try:
        expected = structure(source)
        with psycopg.connect(url, autocommit=True) as admin:
            if db["id"] in UPSTREAM_PSQL_SCRIPTS:
                head, marker, tail = script.partition(f"\\c {db['id']};")
                if not marker:
                    raise AssertionError(f"{db['id']}: expected a psql \\c line in the upstream script")
                admin.execute(f'DROP DATABASE IF EXISTS "{db["id"]}"')
                admin.execute(f'CREATE DATABASE "{db["id"]}"')
                target = conninfo.make_conninfo(url, dbname=db["id"])
                with psycopg.connect(target, autocommit=True) as conn:
                    conn.execute(tail)
                    result = check_structure(conn, "public", expected, db["id"])
                admin.execute(f'DROP DATABASE IF EXISTS "{db["id"]}"')
                return {"id": db["id"], "script": "upstream (loaded as psql would)", **result}
            admin.execute(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE')
            try:
                admin.execute(script)
                result = check_structure(admin, schema, expected, db["id"])
                full = None
                if db["id"] not in OWN_ARTIFACT:
                    full = pg.verify_database(admin, root)
                    if full["rows"] != result["rows"]:
                        raise AssertionError(f"{db['id']}: verify_database counted {full['rows']} rows, structure check {result['rows']}")
                return {"id": db["id"], "script": "generated, full typed row verification" if full else "provider artifact, structural verification", **result}
            finally:
                admin.execute(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE')
    finally:
        source.close()
        if temporary:
            temporary.unlink(missing_ok=True)


OWN_ARTIFACT = {"northwind"}


def validate_native_ingitdb_archive(archive: Path, root: Path, scratch: Path) -> tuple[Path, dict[str, Any]]:
    """Check native downloads against validated original bytes, without a SQL snapshot."""
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "provider-tools"))
    import generate_ingitdb as native

    manifest = native.decode(native.read(root, "manifest.json"))
    expected_root = scratch / "expected"
    expected_root.mkdir()
    (expected_root / "manifest.json").write_bytes(native.read(root, "manifest.json"))
    source_path = manifest["dataFile"]
    destination = native.checked_path(expected_root, source_path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(native.read(root, source_path))
    shutil.copytree(root / "ingitdb", expected_root / "ingitdb", symlinks=True)
    # The existing native generator checks hashes, keys, row counts, types and schema.
    # Run it only in scratch; the pinned checkout remains read-only.
    native.generate(expected_root)
    expected_archive = expected_root / f"artifacts/{manifest['id']}.ingitdb.tar.gz"
    with tarfile.open(expected_archive, "r:gz") as bundle:
        expected = {member.name: bundle.extractfile(member).read() for member in bundle}
    actual: dict[str, bytes] = {}
    with tarfile.open(archive, "r:gz") as bundle:
        for member in bundle:
            if not member.isfile() or member.name not in expected or member.name in actual:
                raise AssertionError(f"{manifest['id']}: unexpected or unsafe native archive entry {member.name!r}")
            if member.size != len(expected[member.name]):
                raise AssertionError(f"{manifest['id']}: native archive size differs: {member.name}")
            actual[member.name] = bundle.extractfile(member).read()
    if actual != expected:
        raise AssertionError(f"{manifest['id']}: native archive differs from pinned original files")
    extracted = scratch / "download"
    for name, body in actual.items():
        path = extracted / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
    contract = json.loads((expected_root / "metadata/contract.json").read_text())
    tables = contract["schema"]["tables"]
    return extracted / "ingitdb", {"dataChecked": True, "metadataAndDataMatch": True,
                                    "errorCount": 0, "errors": [], "tables": len(tables),
                                    "rows": sum(table["rowCount"] for table in tables)}


def validate_ingitdb(db: dict[str, Any], data_dir: Path, providers: Path) -> dict[str, Any]:
    item = complete(db, "ingitdb")
    archive = data_dir / item["assetPath"]
    root = provider_root(providers, db["id"])
    with tempfile.TemporaryDirectory(prefix="demodb-ingitdb-check-") as scratch:
        manifest = json.loads((root / "manifest.json").read_text())
        if manifest.get("storage", {}).get("engine") == "ingitdb":
            native, report = validate_native_ingitdb_archive(archive, root, Path(scratch))
        else:
            with zipfile.ZipFile(archive) as bundle:
                if bundle.testzip() is not None:
                    raise AssertionError(f"{db['id']}: corrupt ZIP entry")
                names = bundle.namelist()
                prefix = f"{db['id']}-ingitdb/"
                if not names or any(not name.startswith(prefix) or ".." in name.split("/") for name in names):
                    raise AssertionError(f"{db['id']}: archive entries are not all under {prefix}")
                bundle.extractall(scratch)
            native = Path(scratch) / f"{db['id']}-ingitdb"
            report = ingitdb.validate(root, native)
        cli = os.environ.get("INGITDB_CLI")
        if cli:
            run = subprocess.run([cli, "validate", "--path", str(native)], capture_output=True, text=True)
            if run.returncode != 0 or "invalid" in run.stdout.lower() or "error" in run.stdout.lower():
                raise AssertionError(f"{db['id']}: ingitdb validate failed: {(run.stdout + run.stderr)[-600:]}")
    if not (report["dataChecked"] and report["metadataAndDataMatch"] and report["errorCount"] == 0):
        raise AssertionError(f"{db['id']}: inGitDB parity failed: {report['errors'][:5]}")
    return {"id": db["id"], "tables": report["tables"], "rows": report["rows"], "errors": report["errorCount"], "ingitdbCli": bool(cli)}


def _same(yaml_value: Any, json_value: Any) -> bool:
    """Equality that tolerates only YAML 1.1's reading of an exponent number without a dot (1e+21) as text."""
    if isinstance(json_value, dict):
        return isinstance(yaml_value, dict) and list(yaml_value) == list(json_value) and all(_same(yaml_value[k], v) for k, v in json_value.items())
    if isinstance(json_value, list):
        return isinstance(yaml_value, list) and len(yaml_value) == len(json_value) and all(_same(a, b) for a, b in zip(yaml_value, json_value))
    if isinstance(json_value, (int, float)) and not isinstance(json_value, bool) and isinstance(yaml_value, str):
        try:
            return float(yaml_value) == float(json_value)
        except ValueError:
            return False
    return type(yaml_value) is type(json_value) and yaml_value == json_value


def validate_yaml(db: dict[str, Any], data_dir: Path) -> dict[str, Any]:
    """Load the served YAML with PyYAML (a strict YAML 1.1 reader) and compare it with the served JSON.

    A whole document up to 12 MB; above that, every table section up to 8 MB (the larger ones are covered by the
    YAML 1.2 comparison in scripts/test-format-matrix.mjs), so memory stays bounded on a CI runner.
    """
    import yaml
    loader = getattr(yaml, "CSafeLoader", yaml.SafeLoader)
    text = read_export(data_dir, complete(db, "yaml")).decode("utf-8")
    expected = json.loads(read_export(data_dir, complete(db, "json")).decode("utf-8"))
    checked = tables = 0
    if len(text) <= 12 * 1024 * 1024:
        loaded = yaml.load(text, Loader=loader)
        if not _same(loaded, expected):
            raise AssertionError(f"{db['id']}: PyYAML reads the served YAML differently from the served JSON")
        checked = tables = len(expected)
    else:
        for section in re.split(r'^(?=")', text, flags=re.M):
            if not section.strip():
                continue
            tables += 1
            if len(section) > 8 * 1024 * 1024:
                continue
            loaded = yaml.load(section, Loader=loader)
            (name, rows), = loaded.items()
            if not _same(rows, expected[name]):
                raise AssertionError(f"{db['id']}.{name}: PyYAML reads the served YAML differently from the served JSON")
            checked += 1
    return {"id": db["id"], "tables": tables, "tablesCompared": checked}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--index", type=Path, default=Path("src/data/generated/index.json"))
    parser.add_argument("--assets", type=Path, default=Path("public/_db"))
    parser.add_argument("--providers", type=Path, required=True, help="directory of <id>/ provider checkouts at the pinned revisions")
    parser.add_argument("--postgres-url", default=os.environ.get("DEMODB_LIVE_POSTGRES_URL", ""))
    parser.add_argument("--only", action="append", help="limit to a dataset id (repeatable)")
    parser.add_argument("--skip", choices=["postgresql", "ingitdb", "yaml"], action="append", default=[])
    args = parser.parse_args()
    databases = json.loads(args.index.read_text(encoding="utf-8"))["databases"]
    results: list[dict[str, Any]] = []
    failures: list[str] = []
    if "postgresql" not in args.skip:
        if not args.postgres_url:
            raise SystemExit("set --postgres-url or DEMODB_LIVE_POSTGRES_URL to a throwaway loopback PostgreSQL")
        assert_loopback(args.postgres_url)
        if os.environ.get("DEMODB_LIVE_POSTGRES_ALLOW_DROP") != "1":
            raise SystemExit("refusing to run: this DROPs schemas and databases named after the datasets; set DEMODB_LIVE_POSTGRES_ALLOW_DROP=1 on a throwaway server")
    for db in databases:
        if args.only and db["id"] not in args.only:
            continue
        data_dir = args.assets / db["id"] / "data"
        for fmt, check in (("postgresql", lambda d=db, dd=data_dir: validate_postgresql(args.postgres_url, d, dd, args.providers)),
                           ("ingitdb", lambda d=db, dd=data_dir: validate_ingitdb(d, dd, args.providers)),
                           ("yaml", lambda d=db, dd=data_dir: validate_yaml(d, dd))):
            if fmt in args.skip or complete(db, fmt) is None:
                continue
            if fmt == "yaml" and db["id"] in PROVIDER_PLAIN_SCALAR_YAML:
                print(f"skip {db['id']} yaml: provider-written plain scalars, see docs/format-matrix.md", flush=True)
                continue
            try:
                result = {"format": fmt, **check()}
                results.append(result)
                print(json.dumps(result, sort_keys=True), flush=True)
            except Exception as error:  # noqa: BLE001 - report every dataset before failing
                failures.append(f"{db['id']} {fmt}: {error}")
                print(f"FAIL {db['id']} {fmt}: {error}", file=sys.stderr, flush=True)
    print(f"validated {len(results)} served downloads, {len(failures)} failures")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
