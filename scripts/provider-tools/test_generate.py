from __future__ import annotations

import hashlib
import importlib.util
import json
import gzip
import sqlite3
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("generate.py")
SPEC = importlib.util.spec_from_file_location("provider_generator", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
generator = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(generator)


class ProviderGeneratorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        database = self.root / "source.sqlite"
        connection = sqlite3.connect(database)
        connection.executescript(
            '''
            PRAGMA foreign_keys=ON;
            CREATE TABLE "Order Details" (
              "Order ID" INTEGER,
              "Product ID" INTEGER,
              "Receipt" BLOB,
              PRIMARY KEY ("Product ID", "Order ID")
            );
            INSERT INTO "Order Details" VALUES (7, 3, X'00FF10');
            CREATE TABLE "HumanResources.Employee" (
              EmployeeID INTEGER NOT NULL,
              Department TEXT DEFAULT 'Research',
              Salary MONEY,
              Score INTEGER GENERATED ALWAYS AS (EmployeeID * 2) STORED,
              PRIMARY KEY (EmployeeID)
            );
            INSERT INTO "HumanResources.Employee" (EmployeeID) VALUES (4);
            CREATE TABLE "dbo.DatabaseLog" (DatabaseLogID INTEGER, Message TEXT);
            INSERT INTO "dbo.DatabaseLog" VALUES (1, 'has no declared key');
            CREATE TABLE "Child" (
              child_a INTEGER, child_b INTEGER,
              FOREIGN KEY (child_b, child_a) REFERENCES "Order Details" ("Product ID", "Order ID") ON UPDATE CASCADE ON DELETE SET NULL
            );
            INSERT INTO Child VALUES (7, 3);
            CREATE TABLE "Empty Demo" (Value TEXT);
            CREATE TABLE "Self Link" (ID INTEGER PRIMARY KEY, ParentID INTEGER REFERENCES "Self Link");
            INSERT INTO "Self Link" VALUES (1, NULL);
            INSERT INTO "Self Link" VALUES (2, 1);
            CREATE VIEW "Employee Summary" AS SELECT EmployeeID, Score FROM "HumanResources.Employee";
            '''
        )
        connection.commit()
        connection.close()
        source_hash = hashlib.sha256(database.read_bytes()).hexdigest()
        self.manifest = {
            "contractVersion": 1,
            "id": "fixture",
            "name": "Fixture DB",
            "description": "A generator test fixture",
            "siteHost": "fixture.demodb.dev",
            "dataFile": "source.sqlite",
            "source": {
                "repository": "https://github.com/example/fixture",
                "revision": "0123456789abcdef0123456789abcdef01234567",
                "path": "src/create.sql",
                "databaseSha256": source_hash,
                "license": "MIT",
                "notes": "Pinned test recipe",
            },
            "tableDescriptions": {"Order Details": "Native spaced collection"},
            "capabilities": {
                "ovdb": {
                    "canonicalUrl": "https://demodb.dev/fixture/",
                    "serverId": "https://demodb.dev/ovdb",
                    "serverDbBaseUrl": "https://demodb.dev/ovdb/db/fixture/",
                    "connection": "https://demodb.dev/ovdb/v1/databases/fixture",
                }
            },
            "generator": {
                "publisher": {"name": "Example", "url": "https://example.org/", "repository": "https://github.com/example/fixture"},
                "licences": {"model": "CC-BY-4.0", "meaning": "CC-BY-4.0"},
                "model": {"address": "modelspec://github.com/example/fixture/0.1.0", "moduleId": "fixture", "name": "Fixture_DB", "version": "0.1.0"},
                "modelEntityAliases": {"Order Details": "Order_Details", "HumanResources.Employee": "HumanResources_Employee"},
                "modelPropertyAliases": {"Order Details": {"Order ID": "Order_ID"}},
                "ovdb": {
                    "query": True,
                    "deployment": {"engine": "openvaultdb-go", "url": "https://cloud.openvaultdb.com/ovdb/db/fixture", "discovery": "https://fixture.demodb.dev/.well-known/openvaultdb"},
                    "recordsets": ["Order Details", "HumanResources.Employee", "dbo.DatabaseLog", "Child", "Empty Demo", "Self Link"],
                },
                "meaning": {
                    "id": "fixture",
                    "address": "meaning://github.com/example/fixture",
                    "name": "Fixture DB",
                    "description": "Fixture semantics",
                    "license": "CC-BY-4.0",
                    "core": {"address": "meaning://github.com/meaninggraph/core", "revision": "abcdef0123456789abcdef0123456789abcdef01"},
                    "concepts": [{
                        "id": "order-line",
                        "kind": "entity",
                        "label": "Order line",
                        "description": "A line in an order",
                        "bindings": [{"recordset": "Order Details", "role": "entity"}],
                    }, {
                        "id": "order-id",
                        "kind": "attribute",
                        "label": "Order ID",
                        "description": "Identifier of the order containing this line",
                        "of": "order-line",
                        "bindings": [{"recordset": "Order Details", "property": "Order ID", "role": "value"}],
                    }, {
                        "id": "employee-department",
                        "kind": "attribute",
                        "label": "Department",
                        "description": "Department for an employee",
                        "valuesOf": "department",
                        "bindings": [{"recordset": "HumanResources.Employee", "property": "Department", "role": "value"}],
                    }, {
                        "id": "employee",
                        "kind": "entity",
                        "label": "Employee",
                        "description": "A human resource employee",
                        "extends": "meaning://github.com/meaninggraph/core/employee?ref=abcdef0123456789abcdef0123456789abcdef01",
                        "bindings": [{"recordset": "HumanResources.Employee", "role": "entity"}],
                    }],
                },
            },
        }
        (self.root / "manifest.json").write_text(json.dumps(self.manifest, indent=2) + "\n", encoding="utf-8")

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_preserves_native_metadata_and_emits_deterministic_contract(self) -> None:
        generator.generate(self.root)
        first = {path.relative_to(self.root).as_posix(): path.read_bytes() for path in self.root.rglob("*") if path.is_file() and path.name != "source.sqlite"}
        generator.generate(self.root)
        second = {path.relative_to(self.root).as_posix(): path.read_bytes() for path in self.root.rglob("*") if path.is_file() and path.name != "source.sqlite"}
        self.assertEqual(first, second)

        schema = json.loads((self.root / "metadata/schema.json").read_text())
        tables = {table["name"]: table for table in schema["tables"]}
        order_details = tables["Order Details"]
        self.assertEqual(order_details["primaryKey"], [
            {"column": "Product ID", "position": 1},
            {"column": "Order ID", "position": 2},
        ])
        self.assertTrue(order_details["columns"][0]["nullable"], "SQLite composite PKs do not necessarily imply NOT NULL")
        self.assertEqual(order_details["columns"][2]["name"], "Receipt")
        self.assertEqual(order_details["rows"][0]["Receipt"], "AP8Q")
        self.assertEqual(tables["Empty Demo"]["rowCount"], 0)
        self.assertEqual(tables["Empty Demo"]["rows"], [])
        self.assertIn("CREATE VIEW", tables["Employee Summary"]["viewSql"])
        employee = tables["HumanResources.Employee"]
        self.assertEqual(employee["columns"][3]["generated"], "stored")
        self.assertIn("GENERATED ALWAYS", employee["tableSql"])
        self.assertEqual(tables["dbo.DatabaseLog"]["primaryKey"], [])
        model = json.loads((self.root / "model/fixture.modelspec.json").read_text())
        self.assertNotIn("key", model["entities"]["dbo_DatabaseLog"])
        self.assertEqual(model["entities"]["dbo_DatabaseLog"]["properties"]["DatabaseLogID"]["type"], "int")
        self.assertEqual(tables["dbo.DatabaseLog"]["modelEntity"], "dbo_DatabaseLog")
        self.assertIsNone(tables["dbo.DatabaseLog"]["modelRecordset"])
        self.assertEqual(schema["modelingLimitations"], [])

        foreign_keys = tables["Child"]["foreignKeys"]
        self.assertEqual([(fk["column"], fk["referencedColumn"], fk["position"]) for fk in foreign_keys], [
            ("child_b", "Product ID", 0),
            ("child_a", "Order ID", 1),
        ])
        self.assertEqual((foreign_keys[0]["onUpdate"], foreign_keys[0]["onDelete"]), ("CASCADE", "SET NULL"))
        self.assertEqual(tables["Self Link"]["foreignKeys"][0]["referencedColumn"], "ID")
        model = json.loads((self.root / "model/fixture.modelspec.json").read_text())
        self.assertEqual(model["entities"]["Order_Details"]["key"], ["Product_ID", "Order_ID"])
        self.assertIn("Order_ID", model["entities"]["Order_Details"]["properties"])
        hcl = (self.root / "model/fixture.modelspec.hcl").read_text()
        self.assertLess(hcl.index('key = ["Product_ID","Order_ID"]'), hcl.index('property "Order_ID"'))
        keyless_hcl = hcl.split('entity "dbo_DatabaseLog" {', 1)[1].split("}", 1)[0]
        self.assertNotIn("key =", keyless_hcl)
        self.assertEqual(model["entities"]["HumanResources_Employee"]["properties"]["Salary"]["type"], "decimal")
        meaning = json.loads((self.root / "model/fixture.meaning.yaml").read_text())
        concepts = {concept["id"]: concept for concept in meaning["concepts"]}
        self.assertEqual(concepts["order-id"]["of"], "order-line")
        self.assertEqual(concepts["order-id"]["bindings"][0]["property"], "Order_ID")
        self.assertEqual(concepts["employee-department"]["values-of"], "meaning://github.com/meaninggraph/core/department?ref=abcdef0123456789abcdef0123456789abcdef01")
        self.assertEqual(concepts["employee"]["extends"], "meaning://github.com/meaninggraph/core/employee?ref=abcdef0123456789abcdef0123456789abcdef01")
        descriptor = json.loads((self.root / "ovdb-database.json").read_text())
        self.assertEqual(descriptor["recordsets"][0]["name"], "Order Details")
        self.assertEqual(descriptor["recordsets"][0]["modelEntity"], "Order_Details")
        self.assertEqual(next(row for row in descriptor["recordsets"] if row["name"] == "dbo.DatabaseLog")["modelEntity"], "dbo_DatabaseLog")
        self.assertEqual(descriptor["provenance"]["sha256"], hashlib.sha256((self.root / "source.sqlite").read_bytes()).hexdigest())
        self.assertEqual((self.root / "artifacts/fixture.sqlite").read_bytes(), (self.root / "source.sqlite").read_bytes())
        restored = sqlite3.connect(":memory:")
        restored.executescript((self.root / "artifacts/fixture.sql").read_text(encoding="utf-8"))
        self.assertEqual(restored.execute('SELECT "Score" FROM "HumanResources.Employee"').fetchone()[0], 8)
        self.assertEqual(restored.execute('SELECT "Receipt" FROM "Order Details"').fetchone()[0], b"\x00\xff\x10")
        self.assertEqual(restored.execute('SELECT COUNT(*) FROM "Empty Demo"').fetchone()[0], 0)
        restored.close()
        checksums = json.loads((self.root / "metadata/checksums.json").read_text())
        for file_path in self.root.rglob("*"):
            if file_path.is_file() and file_path.name not in ("source.sqlite", "source.sqlite.gz"):
                self.assertLessEqual(file_path.stat().st_size, generator.MAX_STATIC_EXPORT_BYTES, file_path.relative_to(self.root).as_posix())
        self.assertEqual(checksums["files"]["ovdb-database.json"]["sha256"], hashlib.sha256((self.root / "ovdb-database.json").read_bytes()).hexdigest())
        schema = json.loads((Path(__file__).resolve().parents[2] / "schemas/ovdb-database-draft-1.schema.json").read_text())
        descriptor["recordsets"][0]["rows"] = [{"Receipt": "AP8Q"}]
        with self.assertRaisesRegex(generator.GenerationError, "unknown fields rows"):
            generator.validate_database_descriptor_shape(descriptor, schema)

    def test_refuses_source_drift_before_creating_exports(self) -> None:
        (self.root / "source.sqlite").write_bytes((self.root / "source.sqlite").read_bytes() + b"drift")
        with self.assertRaisesRegex(generator.GenerationError, "SHA-256 differs"):
            generator.generate(self.root)
        self.assertFalse((self.root / "artifacts/data").exists())

    def test_export_cap_is_actionable_and_never_truncates(self) -> None:
        path = self.root / "too-large.json"
        with self.assertRaisesRegex(generator.GenerationError, "preserve the full source data"):
            generator.write_export(path, b"x" * (generator.MAX_STATIC_EXPORT_BYTES + 1))
        self.assertFalse(path.exists())

    def test_deterministic_gzip_chunks_reassemble_and_verify(self) -> None:
        original_limit = generator.MAX_STATIC_EXPORT_BYTES
        generator.MAX_STATIC_EXPORT_BYTES = 1024
        contents = b"".join(hashlib.sha256(str(index).encode()).digest() for index in range(100))
        outputs = {"artifacts/large.bin": contents}
        exports = [{"path": "artifacts/large.bin", "bytes": len(contents)}]
        try:
            generator.compress_large_exports(outputs, exports)
            export = exports[0]
            self.assertEqual(export["compression"], "gzip")
            self.assertGreater(len(export["chunks"]), 1)
            joined = bytearray()
            for chunk in export["chunks"]:
                piece = outputs[chunk["path"]]
                self.assertLessEqual(len(piece), original_limit)
                self.assertEqual(chunk["bytes"], len(piece))
                self.assertEqual(chunk["sha256"], hashlib.sha256(piece).hexdigest())
                joined.extend(piece)
            self.assertEqual(len(joined), export["bytes"])
            self.assertEqual(hashlib.sha256(joined).hexdigest(), export["sha256"])
            self.assertEqual(gzip.decompress(joined), contents)
            self.assertEqual(export["decodedBytes"], len(contents))
            self.assertEqual(export["decodedSha256"], hashlib.sha256(contents).hexdigest())
            again = generator.deterministic_gzip(contents)
            self.assertEqual(bytes(joined), again)
        finally:
            generator.MAX_STATIC_EXPORT_BYTES = original_limit

    def test_oversized_exports_and_gzipped_source_are_complete_and_deterministic(self) -> None:
        source_path = self.root / "source.sqlite"
        connection = sqlite3.connect(source_path)
        connection.execute('CREATE TABLE "Large Export" (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)')
        payload = "x" * 1100
        connection.executemany('INSERT INTO "Large Export" (payload) VALUES (?)', ((payload,) for _ in range(30000)))
        connection.commit()
        connection.close()
        source_bytes = source_path.read_bytes()
        self.assertGreater(len(source_bytes), generator.MAX_STATIC_EXPORT_BYTES)
        compressed_source = generator.deterministic_gzip(source_bytes)
        (self.root / "source.sqlite.gz").write_bytes(compressed_source)
        manifest = self.manifest
        manifest["dataFile"] = "source.sqlite.gz"
        manifest["source"]["inputCompression"] = "gzip"
        manifest["source"]["inputSha256"] = hashlib.sha256(compressed_source).hexdigest()
        manifest["source"]["databaseSha256"] = hashlib.sha256(source_bytes).hexdigest()
        (self.root / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

        generator.generate(self.root)
        generated = {
            path.relative_to(self.root).as_posix(): path.read_bytes()
            for path in self.root.rglob("*")
            if path.is_file() and path.name not in ("source.sqlite", "source.sqlite.gz")
        }
        contract = json.loads((self.root / "metadata/contract.json").read_text())
        checksums = json.loads((self.root / "metadata/checksums.json").read_text())
        large_exports = [item for item in contract["exports"] if item.get("table") == "Large Export"]
        self.assertEqual({item["format"] for item in large_exports}, {"json", "csv"})
        for export in large_exports:
            self.assertEqual(export["compression"], "gzip")
            decoded = gzip.decompress((self.root / export["encodedPath"]).read_bytes())
            self.assertEqual(len(decoded), export["decodedBytes"])
            self.assertEqual(hashlib.sha256(decoded).hexdigest(), export["decodedSha256"])
            checksum = checksums["files"][export["encodedPath"]]
            self.assertEqual(checksum["compression"], "gzip")
            self.assertEqual(checksum["bytes"], export["bytes"])
            self.assertEqual(checksum["sha256"], export["sha256"])
            self.assertEqual(checksum["decodedBytes"], export["decodedBytes"])
            self.assertEqual(checksum["decodedSha256"], export["decodedSha256"])
            self.assertFalse((self.root / export["path"]).exists())
        sqlite_export = next(item for item in contract["exports"] if item["format"] == "sqlite")
        self.assertEqual(gzip.decompress((self.root / sqlite_export["encodedPath"]).read_bytes()), source_bytes)
        self.assertEqual(sqlite_export["decodedSha256"], hashlib.sha256(source_bytes).hexdigest())
        descriptor = json.loads((self.root / "ovdb-database.json").read_text())
        self.assertIn("source.inputSha256 identifies the compressed dataFile bytes", descriptor["provenance"]["notes"])
        sql_export = next(item for item in contract["exports"] if item["format"] == "sql")
        restored = sqlite3.connect(":memory:")
        restored.executescript(gzip.decompress((self.root / sql_export["encodedPath"]).read_bytes()).decode("utf-8"))
        self.assertEqual(restored.execute('SELECT COUNT(*) FROM "Large Export"').fetchone()[0], 30000)
        restored.close()

        generator.generate(self.root)
        repeated = {
            path.relative_to(self.root).as_posix(): path.read_bytes()
            for path in self.root.rglob("*")
            if path.is_file() and path.name not in ("source.sqlite", "source.sqlite.gz")
        }
        self.assertEqual(generated, repeated)

    def test_source_integrity_and_foreign_key_violations_are_checked(self) -> None:
        connection = sqlite3.connect(":memory:")
        connection.executescript("CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (parent_id INTEGER REFERENCES parent(id));")
        connection.execute("PRAGMA foreign_keys=OFF")
        connection.execute("INSERT INTO child VALUES (99)")
        with self.assertRaisesRegex(generator.GenerationError, "foreign_key_check found violations"):
            generator.verify_sqlite_source(connection)
        connection.close()

    def test_ambiguous_local_core_self_reference_requires_explicit_core_uri(self) -> None:
        manifest = json.loads((self.root / "manifest.json").read_text())
        manifest["generator"]["meaning"]["concepts"].append({
            "id": "self-kind", "kind": "entity", "label": "Self", "description": "Invalid self extension",
            "extends": "self-kind", "bindings": [{"recordset": "Order Details", "role": "entity"}],
        })
        (self.root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        with self.assertRaisesRegex(generator.GenerationError, "use a pinned meaning:// URL"):
            generator.generate(self.root)

    def test_native_tables_cannot_overwrite_the_same_model_entity(self) -> None:
        manifest = json.loads((self.root / "manifest.json").read_text())
        manifest["generator"]["modelEntityAliases"]["HumanResources.Employee"] = "Order_Details"
        (self.root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        with self.assertRaisesRegex(generator.GenerationError, "two native tables map"):
            generator.generate(self.root)


if __name__ == "__main__":
    unittest.main()
