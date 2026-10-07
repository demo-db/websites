#!/usr/bin/env python3
"""Generate and verify guarded PostgreSQL copies of pinned DemoDB SQLite fixtures.

This module uses only the Python standard library for source validation and SQL
generation. The ``import`` and ``verify`` commands need psycopg 3.
"""
from __future__ import annotations

import argparse
import builtins
import collections
import gzip
import hashlib
import json
import math
import re
import stat
import sys
import tempfile
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any, Iterable, Sequence
from urllib.parse import urlsplit
import sqlite3


IMPORT_VERSION = 1
DATABASE_ID = re.compile(r"^[a-z][a-z0-9-]{0,39}$")
DECIMAL_TEXT = re.compile(r"^\s*DECIMAL_TEXT\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)\s*$", re.I)
DECIMAL_TYPED = re.compile(r"^\s*(?:NUMERIC|DECIMAL)\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)\s*$", re.I)
STORAGE_OVERRIDES = {("adventureworks", "Production.Document", "FileExtension"): "BYTEA"}
# Northwind's hosted PostgreSQL snapshot was produced by a separate, pinned
# converter artifact, not the generic importer below. The canonical table-map
# digest is derived from that commit's artifacts/hosting-imports/manifest.json.
NORTHWIND_IMPORTER_REVISION = "3dc8cd94c0a9859853c4da1187c6f4075535f8d7"
NORTHWIND_IMPORT_VERSION = 1
NORTHWIND_IMPORTER_TABLES_SHA256 = "b76d3d90338790078eeadf059f1c8c35bcae868f148a31c2d821f7fabb7e5a03"


class ImportError(ValueError):
    """Raised when a pinned source or schema cannot be represented safely."""


def quote(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _bracket_identifiers(sql: str) -> str:
    """Convert SQLite/SQL Server bracket identifiers without touching strings."""
    out: list[str] = []
    quote_char: str | None = None
    i = 0
    while i < len(sql):
        char = sql[i]
        if quote_char:
            out.append(char)
            if char == quote_char:
                if i + 1 < len(sql) and sql[i + 1] == quote_char:
                    out.append(sql[i + 1]); i += 1
                else:
                    quote_char = None
        elif char in "'\"`":
            quote_char = char
            out.append(char)
        elif char == "[" and "]" in sql[i + 1:]:
            end = sql.find("]", i + 1)
            out.append(quote(sql[i + 1:end])); i = end
        else:
            out.append(char)
        i += 1
    return "".join(out)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _source_pin(manifest: dict[str, Any]) -> tuple[str, str | None]:
    source = manifest.get("source")
    if not isinstance(source, dict):
        raise ImportError("manifest source must be an object")
    decoded = source.get("databaseSha256") or source.get("sha256")
    compressed = source.get("inputSha256")
    if not isinstance(decoded, str) or not re.fullmatch(r"[0-9a-f]{64}", decoded):
        raise ImportError("manifest source must pin databaseSha256 or sha256")
    if compressed is not None and (not isinstance(compressed, str) or not re.fullmatch(r"[0-9a-f]{64}", compressed)):
        raise ImportError("manifest source.inputSha256 must be a SHA-256 digest")
    return decoded, compressed


def load_source(root: Path) -> tuple[dict[str, Any], Path, str, int, Path | None]:
    """Read a provider root and return its validated manifest and SQLite path.

    Uses the provider's declared ``dataFile`` where present, and accepts staged
    ``decoded.sqlite``. If only a compressed source exists, gzip chunks named
    ``<dataFile>.part-*`` are joined in lexical order before decoding.
    """
    root = root.resolve()
    manifest_path = root / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ImportError(f"cannot read provider manifest at {manifest_path}") from exc
    database_id = manifest.get("id")
    if not isinstance(database_id, str) or not DATABASE_ID.fullmatch(database_id):
        raise ImportError("manifest id must be a lowercase database identifier")
    expected, expected_input = _source_pin(manifest)
    data_file = manifest.get("dataFile")
    candidates: list[Path] = []
    if isinstance(data_file, str):
        data_path = (root / data_file).resolve()
        if not data_path.is_relative_to(root):
            raise ImportError("manifest dataFile escapes provider root")
        candidates.append(data_path)
    candidates += [root / "source.sqlite", root / "source.sqlite.gz", root / "decoded.sqlite"]
    source_path = next((path for path in candidates if path.is_file()), None)
    compressed = False
    raw = b""
    if source_path is None and isinstance(data_file, str) and data_file.endswith(".gz"):
        parts = sorted(root.glob(data_file + ".part-*"))
        if parts:
            raw = b"".join(path.read_bytes() for path in parts)
            compressed = True
    elif source_path is not None:
        raw = source_path.read_bytes()
        compressed = source_path.name.endswith(".gz")
    else:
        raise ImportError("no manifest dataFile, decoded.sqlite, or source.sqlite fixture found")
    if compressed and expected_input and sha256(raw) != expected_input:
        raise ImportError("compressed source SHA-256 does not match manifest source.inputSha256")
    decoded_path: Path | None = None
    if compressed:
        try:
            import io
            with tempfile.NamedTemporaryFile(prefix="demodb-source-", suffix=".sqlite", delete=False) as target:
                decoded_path = Path(target.name)
                with gzip.GzipFile(fileobj=io.BytesIO(raw)) as stream:
                    while block := stream.read(1024 * 1024):
                        target.write(block)
            db_path = decoded_path
        except (OSError, EOFError) as exc:
            if decoded_path:
                decoded_path.unlink(missing_ok=True)
            raise ImportError("compressed SQLite fixture is not a complete gzip stream") from exc
    else:
        assert source_path is not None
        db_path = source_path
    digest = hashlib.sha256()
    size = 0
    with db_path.open("rb") as source_stream:
        header = source_stream.read(16)
        digest.update(header)
        size += len(header)
        while block := source_stream.read(1024 * 1024):
            digest.update(block)
            size += len(block)
    actual = digest.hexdigest()
    if actual != expected:
        if decoded_path:
            decoded_path.unlink(missing_ok=True)
        raise ImportError(f"decoded SQLite SHA-256 mismatch: expected {expected}, got {actual}")
    if not header.startswith(b"SQLite format 3\x00"):
        if decoded_path:
            decoded_path.unlink(missing_ok=True)
        raise ImportError("pinned source is not a SQLite database")
    return manifest, db_path, actual, size, decoded_path


def pg_type(declared: str) -> str:
    value = (declared or "").strip()
    exact = DECIMAL_TEXT.fullmatch(value) or DECIMAL_TYPED.fullmatch(value)
    if exact:
        precision, scale = (int(part) for part in exact.groups())
        if not 1 <= precision <= 1000 or scale > precision:
            raise ImportError(f"invalid DECIMAL_TEXT precision/scale: {value}")
        return f"NUMERIC({precision},{scale})"
    upper = value.upper()
    if any(word in upper for word in ("BLOB", "BINARY", "IMAGE")):
        return "BYTEA"
    if "DATETIME" in upper or "DATE" in upper or "TIME" in upper:
        return "TEXT"
    if any(word in upper for word in ("INT", "BOOL", "BIT")):
        return "BIGINT"
    if any(word in upper for word in ("REAL", "FLOA", "DOUB")):
        return "DOUBLE PRECISION"
    if any(word in upper for word in ("NUM", "DEC", "MONEY")):
        return "NUMERIC"
    return "TEXT"


def _sqlite_literal(value: Any, declared: str, bytea_override: bool = False) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bytes):
        return "decode(" + literal(value.hex()) + ", 'hex')"
    if isinstance(value, str):
        if bytea_override:
            return "decode(" + literal(value.encode("utf-8").hex()) + ", 'hex')"
        if "\x00" in value:
            raise ImportError("PostgreSQL TEXT cannot contain NUL")
        if DECIMAL_TEXT.fullmatch(declared):
            try:
                decimal = Decimal(value)
            except Exception as exc:
                raise ImportError(f"invalid exact decimal value {value!r}") from exc
            return format(decimal, "f")
        if any(ord(char) < 0x20 or ord(char) == 0x7f for char in value):
            return "convert_from(decode(" + literal(value.encode("utf-8").hex()) + ", 'hex'), 'UTF8')"
        return literal(value)
    if isinstance(value, (int, float)):
        return repr(value)
    raise ImportError(f"unsupported SQLite value type {type(value).__name__}")


def _check_expressions(create_sql: str) -> list[str]:
    # Walk SQL characters so nested function calls and quoted strings do not
    # truncate a CHECK expression at the first closing parenthesis.
    out: list[str] = []
    token = re.compile(r"\bCHECK\s*\(", re.I)
    for match in token.finditer(create_sql or ""):
        start = match.end()
        depth, quote_char, i = 1, None, start
        while i < len(create_sql) and depth:
            char = create_sql[i]
            if quote_char:
                if char == quote_char:
                    if i + 1 < len(create_sql) and create_sql[i + 1] == quote_char:
                        i += 1
                    else:
                        quote_char = None
            elif char in "'\"`":
                quote_char = char
            elif char == "(":
                depth += 1
            elif char == ")":
                depth -= 1
            i += 1
        if depth:
            raise ImportError("unterminated SQLite CHECK expression")
        expr = create_sql[start:i - 1].strip()
        expr = re.sub(r"((?:\([^()]+\)|\"[^\"]+\"|[A-Za-z_][A-Za-z0-9_]*))\s+GLOB\s+'((?:''|[^'])*)'",
                      lambda m: m.group(1) + " ~ " + literal(_glob_regex(m.group(2))), expr, flags=re.I)
        expr = _bracket_identifiers(expr)
        out.append(expr)
    return out


def _glob_regex(pattern: str) -> str:
    """Translate SQLite's small GLOB pattern language to an anchored PG regex."""
    result = ["^"]
    in_class = False
    for char in pattern:
        if char == "[":
            in_class = True
            result.append(char)
        elif char == "]" and in_class:
            in_class = False
            result.append(char)
        elif in_class:
            result.append(char)
        elif char == "*":
            result.append(".*")
        elif char == "?":
            result.append(".")
        else:
            result.append(re.escape(char))
    if in_class:
        raise ImportError(f"unterminated SQLite GLOB character class: {pattern!r}")
    result.append("$")
    return "".join(result)


@dataclass
class Snapshot:
    database_id: str
    source_sha256: str
    tables: list[dict[str, Any]]
    views: list[dict[str, Any]]
    source_bytes: int
    db: sqlite3.Connection
    temporary_source: Path | None = None

    def rows(self, name: str) -> Iterable[tuple[Any, ...]]:
        return self.db.execute(f"SELECT * FROM {quote(name)}")

    def row_count(self, name: str) -> int:
        return int(self.db.execute(f"SELECT count(*) FROM {quote(name)}").fetchone()[0])

    def close(self) -> None:
        self.db.close()
        if self.temporary_source:
            self.temporary_source.unlink(missing_ok=True)


def inspect(root: Path) -> Snapshot:
    manifest, db_path, digest, size, temporary_source = load_source(root)
    db = sqlite3.connect(db_path.as_uri() + "?mode=ro", uri=True)
    objects = db.execute("SELECT type,name,sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type,name").fetchall()
    tables: list[dict[str, Any]] = []
    views: list[dict[str, Any]] = []
    for kind, name, create_sql in objects:
        if kind == "table":
            columns = db.execute(f"PRAGMA table_info({quote(name)})").fetchall()
            fks = db.execute(f"PRAGMA foreign_key_list({quote(name)})").fetchall()
            indexes = db.execute(f"PRAGMA index_list({quote(name)})").fetchall()
            index_items = []
            for index in indexes:
                index_name = index[1]
                index_sql_row = db.execute("SELECT sql FROM sqlite_master WHERE type='index' AND name=?", (index_name,)).fetchone()
                index_cols = db.execute(f"PRAGMA index_xinfo({quote(index_name)})").fetchall()
                index_items.append({"name": index_name, "unique": bool(index[2]), "origin": index[3], "partial": bool(index[4]) if len(index) > 4 else False,
                                    "sql": index_sql_row[0] if index_sql_row else None,
                                    "columns": [row[2] for row in index_cols if row[5] and row[2] is not None],
                                    "key_columns": [row[2] for row in index_cols if row[5]]})
            tables.append({"name": name, "sql": create_sql or "", "columns": [
                {"name": row[1], "type": row[2] or "", "notnull": bool(row[3]), "default": row[4], "pk": int(row[5]),
                 "bytea_override": STORAGE_OVERRIDES.get((manifest["id"], name, row[1])) == "BYTEA"}
                for row in columns], "foreign_keys": fks, "indexes": index_items})
        else:
            columns = [item[0] for item in db.execute(f"SELECT * FROM {quote(name)} LIMIT 0").description or []]
            views.append({"name": name, "sql": create_sql or "", "columns": columns})
    return Snapshot(manifest["id"], digest, tables, views, size, db, temporary_source)


def _view_dependencies(views: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_name = {v["name"]: v for v in views}
    deps: dict[str, set[str]] = {name: set() for name in by_name}
    for name, view in by_name.items():
        for other in by_name:
            if name != other and re.search(r"\b(?:FROM|JOIN)\s+(?:\[" + re.escape(other) + r"\]|\"" + re.escape(other) + r"\"|`" + re.escape(other) + r"`|" + re.escape(other) + r"\b)", view["sql"], re.I):
                deps[name].add(other)
    order: list[dict[str, Any]] = []
    active: set[str] = set()
    done: set[str] = set()
    def visit(name: str) -> None:
        if name in active:
            raise ImportError(f"cyclic SQLite view dependency: {name}")
        if name in done:
            return
        active.add(name)
        for dep in sorted(deps[name]):
            visit(dep)
        active.remove(name); done.add(name); order.append(by_name[name])
    for name in by_name:
        visit(name)
    return order


def _identity_column(table: dict[str, Any]) -> str | None:
    if "AUTOINCREMENT" not in table["sql"].upper():
        return None
    keys = [col["name"] for col in table["columns"] if col["pk"]]
    if len(keys) != 1:
        raise ImportError(f"AUTOINCREMENT requires one primary key in {table['name']!r}")
    return keys[0]


def _table_ddl(table: dict[str, Any]) -> str:
    defs: list[str] = []
    pks: list[tuple[int, str]] = []
    identity = _identity_column(table)
    for col in table["columns"]:
        target_type = "BYTEA" if col.get("bytea_override") else pg_type(col["type"])
        text = f"  {quote(col['name'])} {target_type}"
        if col["notnull"] or col["pk"]:
            text += " NOT NULL"
        if col["default"] is not None:
            default = str(col["default"])
            if "\x00" in default:
                raise ImportError("SQLite default contains NUL")
            text += " DEFAULT " + default
        if col["name"] == identity:
            text += " GENERATED BY DEFAULT AS IDENTITY"
        defs.append(text)
        if col["pk"]:
            pks.append((col["pk"], col["name"]))
    if pks:
        defs.append("  PRIMARY KEY (" + ", ".join(quote(name) for _, name in sorted(pks)) + ")")
    defs.extend("  CHECK (" + value + ")" for value in _check_expressions(table["sql"]))
    return f"CREATE TABLE {quote(table['name'])} (\n" + ",\n".join(defs) + "\n);"


def _identity_statements(snapshot: Snapshot) -> list[str]:
    statements: list[str] = []
    for table in snapshot.tables:
        identity = _identity_column(table)
        if identity:
            relation = literal(f'{quote(snapshot.database_id)}.{quote(table["name"])}')
            column = literal(identity)
            statements.append("SELECT setval(pg_get_serial_sequence(" + relation + ", " + column + "), GREATEST(COALESCE(MAX(" + quote(identity) + "), 1), 1), COUNT(*) > 0) FROM " + quote(table["name"]) + ";")
    return statements


def _index_name(name: str) -> str:
    raw = name.encode("utf-8")
    if len(raw) <= 63:
        return name
    suffix = "_" + hashlib.sha256(raw).hexdigest()[:10]
    clipped = raw[:63 - len(suffix)].decode("utf-8", errors="ignore")
    return clipped + suffix


def _index_ddl(table: dict[str, Any]) -> list[str]:
    statements: list[str] = []
    for idx in table["indexes"]:
        # Primary keys become table constraints. SQLite autoindexes for UNIQUE
        # constraints have no SQL text, so recreate them from their columns.
        if idx["origin"] == "pk":
            continue
        name = idx["name"]
        if idx["sql"]:
            sql = _bracket_identifiers(idx["sql"].strip().rstrip(";"))
            sql = re.sub(r"^(CREATE\s+(?:UNIQUE\s+)?INDEX\s+)(?:IF\s+NOT\s+EXISTS\s+)?(?:\"(?:\"\"|[^\"])+\"|[^\s]+)", lambda m: m.group(1) + quote(_index_name(name)), sql, flags=re.I)
            sql = re.sub(r"\bON\s+[^\s(]+", "ON " + quote(table["name"]), sql, count=1, flags=re.I)
        else:
            if not idx["columns"]:
                continue
            unique = "UNIQUE " if idx["unique"] else ""
            sql = f"CREATE {unique}INDEX {quote(_index_name(name))} ON {quote(table['name'])} (" + ", ".join(quote(c) for c in idx["columns"]) + ")"
        statements.append(sql + ";")
    return statements


def _fk_ddl(table: dict[str, Any], ordinal: int) -> list[str]:
    groups: dict[int, list[tuple[Any, ...]]] = collections.defaultdict(list)
    for row in table["foreign_keys"]:
        groups[int(row[0])].append(row)
    statements = []
    for fk_id, rows in sorted(groups.items()):
        rows.sort(key=lambda row: int(row[1]))
        local = ", ".join(quote(row[3]) for row in rows)
        remote = ", ".join(quote(row[4]) for row in rows)
        target = quote(rows[0][2])
        update = str(rows[0][5]).upper()
        delete = str(rows[0][6]).upper()
        allowed = {"NO ACTION", "RESTRICT", "SET NULL", "SET DEFAULT", "CASCADE"}
        if update not in allowed or delete not in allowed:
            raise ImportError("SQLite foreign key uses an unsupported action")
        cname = quote(f"fk_{ordinal}_{fk_id}")
        statements.append(f"ALTER TABLE {quote(table['name'])} ADD CONSTRAINT {cname} FOREIGN KEY ({local}) REFERENCES {target} ({remote}) ON UPDATE {update} ON DELETE {delete} DEFERRABLE INITIALLY DEFERRED;")
    return statements


def _copy_row(table: dict[str, Any], row: Sequence[Any]) -> tuple[Any, ...]:
    return tuple(value.encode("utf-8") if table["columns"][i].get("bytea_override") and isinstance(value, str) else value
                 for i, value in enumerate(row))


def _view_sql(view: dict[str, Any], snapshot: Snapshot) -> str:
    sql = view["sql"].strip().rstrip(";")
    # SQLite's bracket quoting is used by several SQL Server-derived fixtures.
    sql = _bracket_identifiers(sql)
    # Case-sensitive SQLite names must be quoted for PostgreSQL. This lexical
    # pass leaves quoted strings and existing quoted identifiers alone.
    known = {t["name"] for t in snapshot.tables} | {c["name"] for t in snapshot.tables for c in t["columns"]}
    known |= {v["name"] for v in snapshot.views} | {c for v in snapshot.views for c in v["columns"]}
    lookup = {name.casefold(): name for name in known}
    token = re.compile(r"'(?:''|[^'])*'|\"(?:\"\"|[^\"])*\"|[A-Za-z_][A-Za-z0-9_]*")
    def quote_known(match: re.Match[str]) -> str:
        word = match.group(0)
        if word.startswith(("'", '"')):
            return word
        if sql[match.end():].lstrip().startswith("("):
            return word
        original = lookup.get(word.casefold())
        return quote(original) if original else word
    sql = token.sub(quote_known, sql)
    # Explicit SQLite compatibility adapters. These are narrow syntax rewrites,
    # and each is exercised by unit tests.
    sql = re.sub(r"\bDATETIME\s*\(\s*('(?:''|[^'])*')\s*\)", r"\1", sql, flags=re.I)
    sql = re.sub(r"\bIFNULL\s*\(", "COALESCE(", sql, flags=re.I)
    if snapshot.database_id == "sakila":
        sql = _adapt_sakila_view(view["name"], sql)
    return sql + ";"


def _adapt_sakila_view(name: str, sql: str) -> str:
    if name == "customer_list":
        sql = re.sub(r"\bWHEN\s+cu\.\"?active\"?\s+THEN", 'WHEN cu."active" <> 0 THEN', sql, flags=re.I)
    if name in ("film_list", "nicer_but_slower_film_list"):
        sql = re.sub(r"\bgroup_concat\s*\((.*?),\s*', '\s*\)", r"string_agg(\1, ', ' ORDER BY actor.actor_id)", sql, flags=re.I | re.S)
    if name == "actor_info":
        sql = re.sub(r"\bgroup_concat\s*\(\s*\"?category_info\"?\s*,\s*'; '\s*\)",
                     "string_agg(category_info, '; ' ORDER BY category_info)", sql, flags=re.I)
        sql = re.sub(r"\bgroup_concat\s*\(\s*\"?title\"?\s*,\s*', '\s*\)",
                     'string_agg("title", \', \' ORDER BY "title")', sql, flags=re.I)
    if name == "sales_by_store":
        sql = re.sub(r"GROUP\s+BY\s+s\.\"?store_id\"?(?=\s|$)", 'GROUP BY s."store_id", c."city", cy."country", m."first_name", m."last_name"', sql, flags=re.I)
    if "group_concat" in sql.casefold():
        raise ImportError(f"unadapted SQLite group_concat in Sakila view {name!r}")
    return sql


def _base_statements(snapshot: Snapshot) -> list[str]:
    schema = snapshot.database_id
    marker = f"demodb-import:v{IMPORT_VERSION}:source-sha256:{snapshot.source_sha256}"
    out = ["-- Generated from a manifest-pinned DemoDB SQLite fixture.",
           "-- Guarded schema creation and all data are in one transaction.", "BEGIN;",
           "DO $demodb_guard$ BEGIN IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = " + literal(schema) + ") THEN RAISE EXCEPTION 'schema " + schema + " already exists; refusing overwrite'; END IF; EXECUTE " + literal("CREATE SCHEMA " + quote(schema)) + "; END $demodb_guard$;",
           "SET LOCAL search_path = " + quote(schema) + ", pg_catalog;",
           "COMMENT ON SCHEMA " + quote(schema) + " IS " + literal(marker) + ";"]
    for table in snapshot.tables:
        out.append(_table_ddl(table))
    for idx, table in enumerate(snapshot.tables):
        out.extend(_fk_ddl(table, idx))
    return out


def _tail_statements(snapshot: Snapshot) -> list[str]:
    out: list[str] = []
    for table in snapshot.tables:
        out.extend(_index_ddl(table))
    for view in _view_dependencies(snapshot.views):
        out.append(_view_sql(view, snapshot))
    overrides = [{"table": table["name"], "column": col["name"], "storage": "BYTEA", "sourceType": col["type"]}
                 for table in snapshot.tables for col in table["columns"] if col.get("bytea_override")]
    manifest = json.dumps({"version": IMPORT_VERSION, "sourceSha256": snapshot.source_sha256,
                           "compatibilityOverrides": overrides,
                           "tables": {table["name"]: snapshot.row_count(table["name"]) for table in snapshot.tables}}, sort_keys=True, separators=(",", ":"))
    out.append('CREATE TABLE "_import_manifest" ("version" integer NOT NULL, "source_sha256" text NOT NULL, "manifest_json" jsonb NOT NULL);')
    out.append("INSERT INTO \"_import_manifest\" VALUES (" + str(IMPORT_VERSION) + ", " + literal(snapshot.source_sha256) + ", " + literal(manifest) + "::jsonb);")
    return out


def postgres_sql(snapshot: Snapshot, batch_size: int = 250) -> str:
    out = _base_statements(snapshot)
    for table in snapshot.tables:
        columns = ", ".join(quote(col["name"]) for col in table["columns"])
        batch: list[str] = []
        for row in snapshot.rows(table["name"]):
            values = ", ".join(_sqlite_literal(value, table["columns"][i]["type"], table["columns"][i].get("bytea_override", False)) for i, value in enumerate(row))
            batch.append("(" + values + ")")
            if len(batch) == batch_size:
                out.append(f"INSERT INTO {quote(table['name'])} ({columns}) VALUES " + ", ".join(batch) + ";")
                batch.clear()
        if batch:
            out.append(f"INSERT INTO {quote(table['name'])} ({columns}) VALUES " + ", ".join(batch) + ";")
    out.extend(_identity_statements(snapshot))
    out.extend(_tail_statements(snapshot))
    out.append("COMMIT;")
    return "\n\n".join(out) + "\n"


def import_database(connection: Any, root: Path) -> dict[str, Any]:
    """Import a pinned source with psycopg COPY in one schema-guarded transaction."""
    snapshot = inspect(root)
    try:
        schema = snapshot.database_id
        with connection.transaction():
            cursor = connection.cursor()
            for statement in _base_statements(snapshot):
                if statement != "BEGIN;":
                    cursor.execute(statement)
            for table in snapshot.tables:
                names = [column["name"] for column in table["columns"]]
                command = f"COPY {quote(schema)}.{quote(table['name'])} ({', '.join(quote(n) for n in names)}) FROM STDIN"
                with cursor.copy(command) as copy:
                    for row in snapshot.rows(table["name"]):
                        copy.write_row(_copy_row(table, row))
            for statement in _identity_statements(snapshot):
                cursor.execute(statement)
            for statement in _tail_statements(snapshot):
                cursor.execute(statement)
        return {"id": schema, "sourceSha256": snapshot.source_sha256, "tables": len(snapshot.tables),
                "views": len(snapshot.views), "rows": sum(snapshot.row_count(table["name"]) for table in snapshot.tables),
                "compatibilityOverrides": [{"table": table["name"], "column": col["name"], "storage": "BYTEA", "sourceType": col["type"]}
                                           for table in snapshot.tables for col in table["columns"] if col.get("bytea_override")]}
    finally:
        snapshot.close()


def generate(root: Path, output: Path) -> dict[str, Any]:
    snapshot = inspect(root)
    try:
        output.parent.mkdir(parents=True, exist_ok=True)
        text = postgres_sql(snapshot)
        output.write_text(text, encoding="utf-8")
        return {"id": snapshot.database_id, "sourceSha256": snapshot.source_sha256,
                "bytes": snapshot.source_bytes, "tables": len(snapshot.tables), "views": len(snapshot.views),
                "rows": sum(snapshot.row_count(t["name"]) for t in snapshot.tables),
                "compatibilityOverrides": [{"table": table["name"], "column": col["name"], "storage": "BYTEA", "sourceType": col["type"]}
                                           for table in snapshot.tables for col in table["columns"] if col.get("bytea_override")],
                "output": str(output)}
    finally:
        snapshot.close()


def _normal(value: Any, declared: str, bytea_override: bool = False) -> Any:
    if value is None:
        return ["null"]
    if isinstance(value, memoryview):
        value = value.tobytes()
    if bytea_override and isinstance(value, bytes):
        return ["text", value.decode("utf-8")]
    if isinstance(value, bytes):
        return ["blob", value.hex()]
    if DECIMAL_TEXT.fullmatch(declared) or any(x in declared.upper() for x in ("NUM", "DEC", "MONEY")):
        text = format(Decimal(str(value)), "f")
        if "." in text:
            text = text.rstrip("0").rstrip(".")
        return ["number", text or "0"]
    if isinstance(value, float):
        return ["float", value.hex()]
    if isinstance(value, int):
        return ["integer", str(value)]
    return ["text", str(value)]


def _digest_rows(rows: Iterable[Sequence[Any]], columns: list[dict[str, Any]]) -> collections.Counter[str]:
    counts: collections.Counter[str] = collections.Counter()
    for row in rows:
        payload = [_normal(value, columns[i]["type"], columns[i].get("bytea_override", False)) for i, value in enumerate(row)]
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        counts[encoded] += 1
    return counts


def _row_digest(row: Sequence[Any], columns: list[dict[str, Any]]) -> bytes:
    payload = [_normal(value, columns[i]["type"], columns[i].get("bytea_override", False)) for i, value in enumerate(row)]
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).digest()


def _multiset_matches(expected_rows: Iterable[Sequence[Any]], actual_rows: Iterable[Sequence[Any]], columns: list[dict[str, Any]]) -> bool:
    """Exact typed row-multiset check with counts spilled to a temporary SQLite index."""
    with tempfile.NamedTemporaryFile(prefix="demodb-row-check-", suffix=".sqlite") as temp:
        scratch = sqlite3.connect(temp.name)
        try:
            scratch.execute("CREATE TABLE expected_rows (row_hash BLOB PRIMARY KEY, count INTEGER NOT NULL)")
            batch: list[tuple[bytes]] = []
            for row in expected_rows:
                batch.append((_row_digest(row, columns),))
                if len(batch) >= 1000:
                    scratch.executemany("INSERT INTO expected_rows VALUES (?,1) ON CONFLICT(row_hash) DO UPDATE SET count=count+1", batch)
                    batch.clear()
            if batch:
                scratch.executemany("INSERT INTO expected_rows VALUES (?,1) ON CONFLICT(row_hash) DO UPDATE SET count=count+1", batch)
            scratch.commit()
            for row in actual_rows:
                cursor = scratch.execute("UPDATE expected_rows SET count=count-1 WHERE row_hash=? AND count>0", (_row_digest(row, columns),))
                if cursor.rowcount != 1:
                    return False
            return scratch.execute("SELECT 1 FROM expected_rows WHERE count<>0 LIMIT 1").fetchone() is None
        finally:
            scratch.close()


def _view_groups(rows: Iterable[Sequence[Any]], numeric: list[bool]) -> dict[str, list[tuple[Decimal | float | None, ...]]]:
    groups: dict[str, list[tuple[Decimal | float | None, ...]]] = collections.defaultdict(list)
    for row in rows:
        labels: list[Any] = []
        numbers: list[Decimal | float | None] = []
        for index, value in enumerate(row):
            if numeric[index]:
                if value is None:
                    numbers.append(None)
                else:
                    numbers.append(value if isinstance(value, float) else Decimal(str(value)))
            elif value is None:
                labels.append(["null"])
            elif isinstance(value, memoryview):
                labels.append(["blob", value.tobytes().hex()])
            elif isinstance(value, bytes):
                labels.append(["blob", value.hex()])
            else:
                labels.append(["text", str(value)])
        groups[json.dumps(labels, ensure_ascii=False, separators=(",", ":"))].append(tuple(numbers))
    return groups


def _same_numeric(left: Decimal | float | None, right: Decimal | float | None) -> bool:
    if left is None or right is None:
        return left is right
    if isinstance(left, float):
        # SQLite aggregates over floating source values can accumulate in a
        # different order than PostgreSQL. This allowance applies to views
        # only; source table decimals are compared exactly by row digest.
        a, b = float(left), float(right)
        return math.isclose(a, b, rel_tol=1e-12, abs_tol=1e-9)
    return left == Decimal(str(right))


def _view_multiset_matches(source: Iterable[Sequence[Any]], target: Iterable[Sequence[Any]], numeric: list[bool]) -> bool:
    expected = _view_groups(source, numeric)
    actual = _view_groups(target, numeric)
    if expected.keys() != actual.keys():
        return False
    for key, expected_rows in expected.items():
        actual_rows = actual[key]
        if len(expected_rows) != len(actual_rows):
            return False
        # Numeric row order is immaterial. Sorting avoids an O(n^2) matching
        # path while the final pair comparison keeps float tolerance bounded.
        expected_rows.sort(key=lambda row: tuple(float(value) if value is not None else float("-inf") for value in row))
        actual_rows.sort(key=lambda row: tuple(float(value) if value is not None else float("-inf") for value in row))
        if any(not all(_same_numeric(a, b) for a, b in zip(left, right)) for left, right in zip(expected_rows, actual_rows)):
            return False
    return True


def _matches_pg_type(expected: str, actual: str, precision: int | None, scale: int | None) -> bool:
    if actual.casefold() != expected.casefold().split("(", 1)[0]:
        return False
    typed = DECIMAL_TYPED.fullmatch(expected)
    return typed is None or (precision, scale) == tuple(int(value) for value in typed.groups())


def verify_database(connection: Any, root: Path) -> dict[str, Any]:
    """Compare a target schema's rows and view results against its pinned source.

    The caller supplies an open psycopg 3 connection. A transaction keeps named
    server cursors usable even when the connection has autocommit enabled.
    """
    snapshot = inspect(root)
    try:
        with connection.transaction():
            return _verify_snapshot(connection, snapshot)
    finally:
        snapshot.close()


def _verify_northwind_import_manifest(connection: Any, snapshot: Snapshot) -> None:
    """Validate the known Northwind importer's exact marker and manifest contract."""
    cursor = connection.cursor()
    cursor.execute('SELECT version, source_sha256, manifest_json FROM "northwind"."_import_manifest"')
    rows = cursor.fetchall()
    if len(rows) != 1:
        raise ImportError("Northwind import manifest must contain exactly one provenance row")
    version, source_sha256, manifest = rows[0]
    if isinstance(manifest, str):
        try:
            manifest = json.loads(manifest)
        except json.JSONDecodeError:
            raise ImportError("Northwind import manifest JSON is invalid") from None
    if (version != NORTHWIND_IMPORT_VERSION or source_sha256 != snapshot.source_sha256
            or not isinstance(manifest, dict)
            or manifest.get("version") != NORTHWIND_IMPORT_VERSION
            or manifest.get("sourceSha256") != snapshot.source_sha256):
        raise ImportError("Northwind SQL and JSON import provenance differs from the pinned source")
    tables = manifest.get("tables")
    if not isinstance(tables, dict):
        raise ImportError("Northwind import manifest table map is missing")
    table_digest = hashlib.sha256(json.dumps(tables, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
    if table_digest != NORTHWIND_IMPORTER_TABLES_SHA256:
        raise ImportError("Northwind import manifest differs from the pinned converter artifact")


def _verify_schema_provenance(connection: Any, snapshot: Snapshot, comment: str | None) -> None:
    expected = f"demodb-import:v{IMPORT_VERSION}:source-sha256:{snapshot.source_sha256}"
    if snapshot.database_id == "northwind":
        northwind = f"northwind-import:v{NORTHWIND_IMPORT_VERSION}:source-sha256:{snapshot.source_sha256}"
        if comment == northwind:
            _verify_northwind_import_manifest(connection, snapshot)
            return
        raise ImportError("target schema is missing or has different pinned-source provenance")
    if comment == expected:
        return
    raise ImportError("target schema is missing or has different pinned-source provenance")


def _verify_snapshot(connection: Any, snapshot: Snapshot) -> dict[str, Any]:
    schema = snapshot.database_id
    cursor = connection.cursor()
    cursor.execute("SELECT obj_description(oid, 'pg_namespace') FROM pg_namespace WHERE nspname = %s", (schema,))
    row = cursor.fetchone()
    _verify_schema_provenance(connection, snapshot, row[0] if row else None)
    checked = 0
    for table in snapshot.tables:
        names = [column["name"] for column in table["columns"]]
        cursor.execute("SELECT column_name, data_type, is_nullable, numeric_precision, numeric_scale, is_identity FROM information_schema.columns WHERE table_schema=%s AND table_name=%s ORDER BY ordinal_position", (schema, table["name"]))
        actual_columns = cursor.fetchall()
        actual_names = [r[0] for r in actual_columns]
        if names != actual_names:
            raise ImportError(f"column mismatch for table {table['name']!r}: {actual_names!r}")
        for source_col, target_col in zip(table["columns"], actual_columns):
            expected_type = "bytea" if source_col.get("bytea_override") else pg_type(source_col["type"]).casefold()
            if not _matches_pg_type(expected_type, target_col[1], target_col[3], target_col[4]):
                raise ImportError(f"type mismatch for {table['name']}.{source_col['name']}: expected {expected_type}, got {target_col[1]}")
            expected_nullable = not (source_col["notnull"] or source_col["pk"])
            if (target_col[2] == "YES") != expected_nullable:
                raise ImportError(f"nullability mismatch for {table['name']}.{source_col['name']}")
            if (target_col[5] == "YES") != (source_col["name"] == _identity_column(table)):
                raise ImportError(f"identity mismatch for {table['name']}.{source_col['name']}")
        expected_pk = tuple(name for _, name in sorted((col["pk"], col["name"]) for col in table["columns"] if col["pk"]))
        cursor.execute("""SELECT ARRAY(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
                        JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum ORDER BY k.ord)
                        FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
                        WHERE n.nspname=%s AND t.relname=%s AND c.contype='p'""", (schema, table["name"]))
        pk_row = cursor.fetchone()
        actual_pk = tuple(pk_row[0]) if pk_row else ()
        if expected_pk != actual_pk:
            raise ImportError(f"primary key mismatch for table {table['name']!r}")
        expected_checks = len(_check_expressions(table["sql"]))
        cursor.execute("SELECT count(*) FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=%s AND t.relname=%s AND c.contype='c'", (schema, table["name"]))
        if cursor.fetchone()[0] != expected_checks:
            raise ImportError(f"CHECK constraint count mismatch for table {table['name']!r}")
        expected_indexes = {( _index_name(index["name"]), index["unique"], tuple(index["key_columns"]))
                            for index in table["indexes"] if index["origin"] != "pk"}
        cursor.execute("""SELECT x.relname, i.indisunique,
                        ARRAY(SELECT a.attname FROM unnest(i.indkey) WITH ORDINALITY k(attnum, ord)
                              LEFT JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
                              WHERE k.ord <= i.indnkeyatts ORDER BY k.ord)
                        FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_class x ON x.oid=i.indexrelid
                        JOIN pg_namespace n ON n.oid=t.relnamespace
                        WHERE n.nspname=%s AND t.relname=%s AND NOT i.indisprimary""", (schema, table["name"]))
        actual_indexes = {(r[0], r[1], tuple(r[2])) for r in cursor.fetchall()}
        if expected_indexes != actual_indexes:
            raise ImportError(f"index inventory mismatch for table {table['name']!r}")
        expected_fks: set[tuple[Any, ...]] = set()
        groups: dict[int, list[tuple[Any, ...]]] = collections.defaultdict(list)
        for fk in table["foreign_keys"]:
            groups[int(fk[0])].append(fk)
        for fk_rows in groups.values():
            fk_rows.sort(key=lambda r: int(r[1]))
            expected_fks.add((tuple(r[3] for r in fk_rows), fk_rows[0][2], tuple(r[4] for r in fk_rows), str(fk_rows[0][5]).upper(), str(fk_rows[0][6]).upper()))
        cursor.execute("""SELECT
                          ARRAY(SELECT la.attname FROM unnest(c.conkey) WITH ORDINALITY k(attnum,ord)
                                JOIN pg_attribute la ON la.attrelid=c.conrelid AND la.attnum=k.attnum ORDER BY k.ord),
                          rt.relname,
                          ARRAY(SELECT ra.attname FROM unnest(c.confkey) WITH ORDINALITY k(attnum,ord)
                                JOIN pg_attribute ra ON ra.attrelid=c.confrelid AND ra.attnum=k.attnum ORDER BY k.ord),
                          c.confupdtype, c.confdeltype
                        FROM pg_constraint c
                        JOIN pg_class lt ON lt.oid=c.conrelid JOIN pg_namespace n ON n.oid=lt.relnamespace
                        JOIN pg_class rt ON rt.oid=c.confrelid
                        WHERE n.nspname=%s AND lt.relname=%s AND c.contype='f'""", (schema, table["name"]))
        action_map = {"a": "NO ACTION", "r": "RESTRICT", "c": "CASCADE", "n": "SET NULL", "d": "SET DEFAULT"}
        actual_fks = {(tuple(r[0]), r[1], tuple(r[2]), action_map[r[3]], action_map[r[4]]) for r in cursor.fetchall()}
        if expected_fks != actual_fks:
            raise ImportError(f"foreign key inventory mismatch for table {table['name']!r}")
        row_cursor = connection.cursor(name=f"demodb_verify_{len(names)}_{checked}")
        try:
            row_cursor.execute(f"SELECT {', '.join(quote(name) for name in names)} FROM {quote(schema)}.{quote(table['name'])}")
            if not _multiset_matches(snapshot.rows(table["name"]), row_cursor, table["columns"]):
                raise ImportError(f"typed row multiset mismatch for table {table['name']!r}")
        finally:
            row_cursor.close()
        checked += snapshot.row_count(table["name"])
    for view in snapshot.views:
        cursor.execute("SELECT column_name, data_type FROM information_schema.columns WHERE table_schema=%s AND table_name=%s ORDER BY ordinal_position", (schema, view["name"]))
        view_metadata = cursor.fetchall()
        columns = [r[0] for r in view_metadata]
        numeric = [r[1] in ("numeric", "smallint", "integer", "bigint", "real", "double precision") for r in view_metadata]
        if columns != view["columns"]:
            raise ImportError(f"view column mismatch for {view['name']!r}")
        view_cursor = connection.cursor(name=f"demodb_verify_view_{len(columns)}_{checked}")
        try:
            view_cursor.execute(f"SELECT {', '.join(quote(name) for name in view['columns'])} FROM {quote(schema)}.{quote(view['name'])}")
            source_cursor = snapshot.db.execute(f"SELECT * FROM {quote(view['name'])}")
            if not _view_multiset_matches(source_cursor, view_cursor, numeric):
                raise ImportError(f"view row multiset mismatch for {view['name']!r}")
        finally:
            view_cursor.close()
    return {"id": schema, "sourceSha256": snapshot.source_sha256, "tables": len(snapshot.tables),
            "views": len(snapshot.views), "rows": checked}


def _connection_from_url_file(path: Path) -> Any:
    info = path.stat()
    if stat.S_IMODE(info.st_mode) & 0o077:
        raise ImportError("URL file permissions must be private (0600 or stricter)")
    url = path.read_text(encoding="utf-8").strip()
    parsed = urlsplit(url)
    if parsed.scheme not in ("postgres", "postgresql") or not parsed.hostname or not parsed.path.strip("/"):
        raise ImportError("URL file must contain a PostgreSQL URL with host and database")
    try:
        import psycopg
    except builtins.ImportError as exc:
        raise ImportError("psycopg 3 is required for import/verify; install it or call the library with an open connection") from exc
    return psycopg.connect(url)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    gen = sub.add_parser("generate", help="validate the pinned SQLite source and generate transactional SQL")
    gen.add_argument("provider_root", type=Path)
    gen.add_argument("--output", type=Path, required=True)
    imp = sub.add_parser("import", help="stream a pinned SQLite source into a new guarded PostgreSQL schema")
    imp.add_argument("provider_root", type=Path)
    imp.add_argument("--url-file", type=Path, required=True, help="private file containing the PostgreSQL URL")
    verify = sub.add_parser("verify", help="compare live table and view rows against the pinned source")
    verify.add_argument("provider_root", type=Path)
    verify.add_argument("--url-file", type=Path, required=True, help="private file containing the PostgreSQL URL")
    args = parser.parse_args(argv)
    try:
        if args.command == "generate":
            report = generate(args.provider_root, args.output)
        else:
            connection = _connection_from_url_file(args.url_file)
            try:
                report = (import_database(connection, args.provider_root) if args.command == "import"
                          else verify_database(connection, args.provider_root))
            finally:
                connection.close()
        print(json.dumps(report, sort_keys=True))
        return 0
    except (ImportError, OSError, sqlite3.Error) as exc:
        print(f"postgres-samples: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
