from __future__ import annotations

import gzip
import hashlib
import io
import json
import sqlite3
import sys
import tempfile
import unittest
from contextlib import contextmanager, redirect_stdout
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import postgres_samples as pg  # noqa: E402


class PostgresSamplesTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.database = self.root / "source.sqlite"
        db = sqlite3.connect(self.database)
        db.executescript('''
            PRAGMA foreign_keys=ON;
            CREATE TABLE "Order Details" (
              "Order ID" INTEGER NOT NULL,
              "Exact Amount" DECIMAL_TEXT(30,4),
              "Receipt" BLOB,
              PRIMARY KEY ("Order ID"),
              CHECK ("Order ID" > 0)
            );
            INSERT INTO "Order Details" VALUES (1,'12345678901234567890.1200',X'00FF');
            CREATE TABLE Child (
              child_id NUMERIC(10,2), parent_id INTEGER,
              FOREIGN KEY (parent_id) REFERENCES "Order Details"("Order ID")
            );
            INSERT INTO Child VALUES (1.25,1);
            CREATE UNIQUE INDEX Child_Parent ON Child(parent_id);
            CREATE TABLE Keyless ("No Key" TEXT);
            INSERT INTO Keyless VALUES ('repeat'),('repeat');
            CREATE VIEW "Order Summary" AS
              SELECT length("Order Details"."Exact Amount") AS "Length", "Order ID"
              FROM "Order Details";
        ''')
        db.commit()
        db.close()
        self.raw = self.database.read_bytes()
        self.manifest = {
            "contractVersion": 1,
            "id": "fixture",
            "dataFile": "source.sqlite",
            "source": {"sha256": hashlib.sha256(self.raw).hexdigest()},
        }
        self.write_manifest()

    def write_manifest(self) -> None:
        (self.root / "manifest.json").write_text(json.dumps(self.manifest), encoding="utf-8")

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_generates_lossless_schema_rows_constraints_and_quoted_views(self) -> None:
        snapshot = pg.inspect(self.root)
        try:
            sql = pg.postgres_sql(snapshot)
        finally:
            snapshot.close()
        self.assertIn('"Exact Amount" NUMERIC(30,4)', sql)
        self.assertIn('"child_id" NUMERIC(10,2)', sql)
        self.assertIn('"Receipt" BYTEA', sql)
        self.assertIn('FOREIGN KEY ("parent_id") REFERENCES "Order Details" ("Order ID")', sql)
        self.assertIn('CREATE UNIQUE INDEX "Child_Parent"', sql)
        self.assertIn('CHECK ("Order ID" > 0)', sql)
        self.assertIn("12345678901234567890.1200", sql)
        self.assertIn("decode('00ff', 'hex')", sql)
        self.assertIn('"Order Summary"', sql)
        self.assertIn('length("Order Details"."Exact Amount") AS "Length"', sql)
        self.assertIn('CREATE TABLE "Keyless"', sql)
        self.assertEqual(sql.count("('repeat')"), 2, "keyless duplicate source rows must both be retained")
        keyless = sql.split('CREATE TABLE "Keyless" (', 1)[1].split(');', 1)[0]
        self.assertNotIn('PRIMARY KEY', keyless)
        self.assertRegex(sql, r'IF EXISTS \(SELECT 1 FROM pg_namespace')
        self.assertEqual(sql.count("BEGIN;"), 1)
        self.assertEqual(sql.count("COMMIT;"), 1)
        self.assertNotIn("DROP SCHEMA", sql)

    def test_type_mapping_preserves_decimal_text_precision_and_sqlite_time_text(self) -> None:
        self.assertEqual(pg.pg_type("DECIMAL_TEXT(38, 6)"), "NUMERIC(38,6)")
        self.assertEqual(pg.pg_type("NUMERIC(10,2)"), "NUMERIC(10,2)")
        self.assertEqual(pg.pg_type("DATETIME"), "TEXT")
        self.assertTrue(pg._matches_pg_type("NUMERIC(38,4)", "numeric", 38, 4))
        self.assertFalse(pg._matches_pg_type("NUMERIC(38,4)", "numeric", 28, 4))
        self.assertFalse(pg._matches_pg_type("NUMERIC(38,4)", "numeric", 38, 2))
        self.assertEqual(pg._normal("1234567890123456789012345678901234.5678", "DECIMAL_TEXT(38,4)"),
                         ["number", "1234567890123456789012345678901234.5678"])

    def test_adventureworks_nul_text_override_preserves_utf8_bytes(self) -> None:
        db = sqlite3.connect(self.database)
        db.execute('CREATE TABLE "Production.Document" ("FileExtension" TEXT)')
        db.execute('INSERT INTO "Production.Document" VALUES (?)', ("é\x00.doc",))
        db.commit()
        db.close()
        self.manifest["id"] = "adventureworks"
        self.manifest["source"]["sha256"] = hashlib.sha256(self.database.read_bytes()).hexdigest()
        self.write_manifest()
        snapshot = pg.inspect(self.root)
        try:
            table = next(table for table in snapshot.tables if table["name"] == "Production.Document")
            row = next(iter(snapshot.rows(table["name"])))
            self.assertEqual(pg._copy_row(table, row), ("é\x00.doc".encode("utf-8"),))
            self.assertEqual(pg._normal(pg._copy_row(table, row)[0], "TEXT", True), ["text", "é\x00.doc"])
            self.assertIn('"FileExtension" BYTEA', pg._table_ddl(table))
            self.assertIn("decode('c3a9002e646f63', 'hex')", pg.postgres_sql(snapshot))
        finally:
            snapshot.close()

    def test_autoincrement_generates_identity_and_seeds_after_rows(self) -> None:
        db = sqlite3.connect(self.database)
        db.execute('CREATE TABLE Auto (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT)')
        db.execute("INSERT INTO Auto (id,payload) VALUES (42,'value')")
        db.commit()
        db.close()
        self.manifest["source"]["sha256"] = hashlib.sha256(self.database.read_bytes()).hexdigest()
        self.write_manifest()
        snapshot = pg.inspect(self.root)
        try:
            table = next(table for table in snapshot.tables if table["name"] == "Auto")
            self.assertEqual(pg._identity_column(table), "id")
            self.assertIn('"id" BIGINT NOT NULL GENERATED BY DEFAULT AS IDENTITY', pg._table_ddl(table))
            seeds = pg._identity_statements(snapshot)
            self.assertEqual(len(seeds), 1)
            self.assertIn("SELECT setval(pg_get_serial_sequence", seeds[0])
            generated = pg.postgres_sql(snapshot)
            self.assertLess(generated.index('INSERT INTO "Auto"'), generated.index("SELECT setval"))
        finally:
            snapshot.close()

    def test_verifier_opens_transaction_for_autocommit_connection(self) -> None:
        class Connection:
            autocommit = True
            active = False

            @contextmanager
            def transaction(self):
                self.active = True
                try:
                    yield
                finally:
                    self.active = False

        connection = Connection()
        with patch.object(pg, "_verify_snapshot", side_effect=lambda conn, _: conn.active):
            self.assertTrue(pg.verify_database(connection, self.root))
        self.assertFalse(connection.active)

    def test_missing_psycopg_has_actionable_error(self) -> None:
        url_file = self.root / "private-url"
        url_file.write_text("postgresql://user:example@localhost/sample", encoding="utf-8")
        url_file.chmod(0o600)
        with patch.dict(sys.modules, {"psycopg": None}):
            with self.assertRaisesRegex(pg.ImportError, "psycopg 3 is required"):
                pg._connection_from_url_file(url_file)

    def test_url_file_rejects_public_permissions(self) -> None:
        url_file = self.root / "public-url"
        url_file.write_text("postgresql://user:example@localhost/sample", encoding="utf-8")
        url_file.chmod(0o644)
        with self.assertRaisesRegex(pg.ImportError, "permissions must be private"):
            pg._connection_from_url_file(url_file)

    def test_cli_dispatches_import_and_verify_and_closes_connection(self) -> None:
        class Connection:
            closed = False

            def close(self):
                self.closed = True

        for command, function in (("import", "import_database"), ("verify", "verify_database")):
            with self.subTest(command=command):
                connection = Connection()
                output = io.StringIO()
                with patch.object(pg, "_connection_from_url_file", return_value=connection), \
                     patch.object(pg, function, return_value={"id": "fixture"}) as action, \
                     redirect_stdout(output):
                    self.assertEqual(pg.main([command, str(self.root), "--url-file", str(self.root / "url")]), 0)
                action.assert_called_once_with(connection, self.root)
                self.assertTrue(connection.closed)
                self.assertEqual(json.loads(output.getvalue()), {"id": "fixture"})

    def test_view_float_tolerance_does_not_round_exact_decimals(self) -> None:
        self.assertTrue(pg._same_numeric(100.0, 100.00000000001))
        self.assertFalse(pg._same_numeric(100.0, 100.00001))
        self.assertFalse(pg._same_numeric(pg.Decimal("100.0000000000"), pg.Decimal("100.00000000001")))

    def test_long_index_names_get_distinct_postgres_safe_names(self) -> None:
        first = "IX_" + "a" * 70 + "x"
        second = "IX_" + "a" * 70 + "y"
        mapped = (pg._index_name(first), pg._index_name(second))
        self.assertEqual(len(set(mapped)), 2)
        self.assertTrue(all(len(name.encode("utf-8")) <= 63 for name in mapped))

    def test_glob_adapter_anchors_classes_and_translates_wildcards(self) -> None:
        checks = pg._check_expressions('CREATE TABLE t (code TEXT CHECK (code GLOB \'[A-Z][0-9]*\'))')
        self.assertEqual(checks, ["code ~ '^[A-Z][0-9].*$'"])

    def test_compressed_chunks_are_pinned_before_decompression(self) -> None:
        compressed = gzip.compress(self.raw)
        self.database.unlink()
        data_path = self.root / "data-source"
        data_path.mkdir()
        self.manifest["dataFile"] = "data-source/source.sqlite.gz"
        self.manifest["source"] = {
            "databaseSha256": hashlib.sha256(self.raw).hexdigest(),
            "inputSha256": hashlib.sha256(compressed).hexdigest(),
        }
        self.write_manifest()
        midpoint = len(compressed) // 2
        (self.root / "data-source/source.sqlite.gz.part-0001").write_bytes(compressed[:midpoint])
        (self.root / "data-source/source.sqlite.gz.part-0002").write_bytes(compressed[midpoint:])
        snapshot = pg.inspect(self.root)
        try:
            self.assertEqual(snapshot.row_count("Keyless"), 2)
        finally:
            snapshot.close()

    def test_rejects_decoded_source_hash_mismatch(self) -> None:
        self.manifest["source"]["sha256"] = "0" * 64
        self.write_manifest()
        with self.assertRaisesRegex(pg.ImportError, "SHA-256 mismatch"):
            pg.inspect(self.root)

    def test_sakila_view_adapters_preserve_ordered_aggregates_and_pg_grouping(self) -> None:
        db = sqlite3.connect(":memory:")
        tables = [
            {"name": "film", "columns": [{"name": "length"}, {"name": "film_id"}, {"name": "title"}]},
            {"name": "actor", "columns": [{"name": "first_name"}, {"name": "last_name"}, {"name": "actor_id"}]},
            {"name": "customer", "columns": [{"name": "active"}]},
            {"name": "city", "columns": [{"name": "city"}]},
            {"name": "payment", "columns": [{"name": "amount"}]},
        ]
        snapshot = pg.Snapshot("sakila", "a" * 64, tables, [], 0, db)
        try:
            film = pg._view_sql({
                "name": "film_list",
                "sql": "CREATE VIEW film_list AS SELECT film.length, group_concat((actor.first_name || ' ' || actor.last_name), ', ') AS actors FROM film LEFT JOIN actor ON film.film_id=actor.actor_id GROUP BY film.film_id",
            }, snapshot)
            self.assertIn('"film"."length"', film)
            self.assertIn('string_agg(("actor"."first_name" || \' \' || "actor"."last_name"), \', \' ORDER BY actor.actor_id)', film)
            actor = pg._view_sql({
                "name": "actor_info",
                "sql": "CREATE VIEW actor_info AS SELECT (SELECT group_concat(category_info, '; ') FROM (SELECT c.name || ': ' || (SELECT group_concat(title, ', ') FROM (SELECT f.title FROM film AS f ORDER BY f.title)) AS category_info FROM category AS c ORDER BY c.name)) AS film_info",
            }, snapshot)
            self.assertIn("string_agg(category_info, '; ' ORDER BY category_info)", actor)
            self.assertIn('string_agg("title", \', \' ORDER BY "title")', actor)
            customer = pg._view_sql({"name": "customer_list", "sql": "CREATE VIEW customer_list AS SELECT CASE WHEN cu.active THEN 'active' END AS notes FROM customer AS cu"}, snapshot)
            self.assertIn('WHEN cu."active" <> 0 THEN', customer)
            sales = pg._view_sql({"name": "sales_by_store", "sql": "CREATE VIEW sales_by_store AS SELECT c.city, SUM(p.amount) FROM city AS c JOIN payment AS p GROUP BY s.store_id ORDER BY c.city"}, snapshot)
            self.assertIn('GROUP BY s."store_id", c."city", cy."country", m."first_name", m."last_name"', sales)
        finally:
            db.close()


if __name__ == "__main__":
    unittest.main()
