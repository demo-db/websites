"""Independent native export parity guards against plausible silent drift."""
from __future__ import annotations

import json
import csv
import base64
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import yaml

import validate_datatug_exports as parity


class NativeParityTest(unittest.TestCase):
    def test_decimal_primary_key_uses_transported_text_and_go_float_spelling(self):
        columns = [{"name": "amount", "type": "NUMERIC(10,2)", "pk": 1}]
        fields = {"amount": {"type": "decimal", "encoding": "decimal-string"}}
        key = parity._native_id((1_000_000.0,), columns, 1, fields)
        decoded = base64.urlsafe_b64decode(key[3:] + "==").decode()
        self.assertEqual(decoded, '[["string","1e+06"]]')
        self.assertEqual(parity._expected_value(1e-5, "NUMERIC", "decimal-string"), "1e-05")
        self.assertEqual(parity._expected_value(2.0, "NUMERIC", "decimal-string"), "2")

    def test_id_bound_rows_schema_and_view_mutations(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            db = sqlite3.connect(":memory:")
            ddl = "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, amount NUMERIC)"
            db.execute(ddl)
            db.execute("INSERT INTO users VALUES (1, 'Ada', 1.25), (2, 'Bob', 2)")
            view_sql = "CREATE VIEW user_names AS SELECT name FROM users"
            db.execute(view_sql)
            table = {"name": "users", "sql": ddl,
                     "columns": [{"name": "id", "type": "INTEGER", "notnull": False, "default": None, "pk": 1},
                                 {"name": "name", "type": "TEXT", "notnull": False, "default": None, "pk": 0},
                                 {"name": "amount", "type": "NUMERIC", "notnull": False, "default": None, "pk": 0}],
                     "indexes": [], "foreign_keys": []}

            class Snapshot:
                database_id = "synthetic"
                source_sha256 = "f" * 64
                tables = [table]
                views = [{"name": "user_names", "sql": view_sql, "columns": ["name"]}]
                def __init__(self, connection): self.db = connection
                def row_count(self, name): return self.db.execute("SELECT count(*) FROM users").fetchone()[0]
                def close(self): pass

            source_definition = {"dialect": "sqlite", "createSql": ddl, "columns": [
                {"name": "id", "declaredType": "INTEGER", "notNull": False, "primaryKeyPosition": 1},
                {"name": "name", "declaredType": "TEXT", "notNull": False},
                {"name": "amount", "declaredType": "NUMERIC", "notNull": False}], "indexes": []}
            native = {"record_file": {"name": "records.json", "format": "json", "type": "map[$record_id]map[$field_name]any"},
                      "columns_order": ["id", "name", "amount"],
                      "columns": {"id": {"type": "int", "required": True}, "name": {"type": "string"}, "amount": {"type": "string"}},
                      "primary_key": ["id"],
                      "source_schema": {"key_mode": "source-primary-key", "constraint_validation": "provider-preflight-passed",
                                        "source_definition_json": json.dumps(source_definition),
                                        "fields": [{"name": "id", "type": "int", "nullable": False},
                                                   {"name": "name", "type": "string", "nullable": True},
                                                   {"name": "amount", "type": "decimal", "nullable": True,
                                                    "encoding": "decimal-string"}],
                                        "storage_class_files": ["source-storage-0001.jsonl"], "foreign_keys": []}}
            native_dir = root / "users" / ".collection"
            native_dir.mkdir(parents=True)
            (root / ".ingitdb").mkdir()
            (root / ".ingitdb/root-collections.yaml").write_text("users: users\n")
            mapping_path = root / ".ingitdb/source-collections.json"
            mapping_path.write_text(json.dumps({"format": "datatug-source-collections/v1",
                                                "collections": {"users": "users"}}))
            views = [{"name": "user_names", "createsql": view_sql, "columns": ["name"]}]
            views_path = root / ".ingitdb/source-views.yaml"
            views_path.write_text(yaml.safe_dump(views))
            native_path = native_dir / "definition.yaml"
            native_path.write_text(yaml.safe_dump(native))
            first = parity._native_id((1, "Ada", 1.25), table["columns"], 1)
            second = parity._native_id((2, "Bob", 2), table["columns"], 2)
            records = {first: {"id": 1, "name": "Ada", "amount": "1.25"},
                       second: {"id": 2, "name": "Bob", "amount": "2"}}
            records_path = root / "users/records.json"
            records_path.write_text(json.dumps(records))
            classes_path = root / "users/source-storage-0001.jsonl"
            classes_path.write_text(json.dumps({"id": first, "classes": {"amount": "real"}}) + "\n" +
                                    json.dumps({"id": second, "classes": {"amount": "integer"}}) + "\n")

            def run():
                with patch.object(parity, "inspect", return_value=Snapshot(db)):
                    return parity.validate(root, root)

            self.assertTrue(run()["metadataAndDataMatch"], run()["errors"])
            mapping_path.write_text(json.dumps({"format": "datatug-source-collections/v1",
                                                "collections": {"users": "other"}}))
            self.assertIn("collection-to-source mapping differs", " ".join(run()["errors"]))
            mapping_path.write_text(json.dumps({"format": "datatug-source-collections/v1",
                                                "collections": {"users": "users", "extra": "other"}}))
            self.assertIn("collection-to-source mapping differs", " ".join(run()["errors"]))
            mapping_path.write_text('{"format":"datatug-source-collections/v1","collections":{"users":"users","users":"other"}}')
            self.assertIn("duplicate JSON key", " ".join(run()["errors"]))
            mapping_path.write_text(json.dumps({"format": "datatug-source-collections/v1",
                                                "collections": {"users": "users"}}))
            records[first], records[second] = records[second], records[first]
            records_path.write_text(json.dumps(records))
            self.assertIn("typed value differs", " ".join(run()["errors"]))
            records[first], records[second] = records[second], records[first]
            records[first]["name"] = "Eve"
            records_path.write_text(json.dumps(records))
            self.assertIn("typed value differs", " ".join(run()["errors"]))
            records[first]["name"] = "Ada"
            records_path.write_text(json.dumps(records))
            classes_path.write_text(json.dumps({"id": first, "classes": {"amount": "integer"}}) + "\n" +
                                    json.dumps({"id": second, "classes": {"amount": "integer"}}) + "\n")
            self.assertIn("source storage classes differ", " ".join(run()["errors"]))
            classes_path.write_text(json.dumps({"id": first, "classes": {"amount": "real"}}) + "\n" +
                                    json.dumps({"id": second, "classes": {"amount": "integer"}}) + "\n")
            native["source_schema"]["source_definition_json"] = json.dumps({**source_definition, "createSql": ddl + " /* altered */"})
            native_path.write_text(yaml.safe_dump(native))
            self.assertIn("CREATE TABLE SQL differs", " ".join(run()["errors"]))
            native["source_schema"]["source_definition_json"] = json.dumps(source_definition)
            native["columns"]["id"]["type"] = "string"
            native_path.write_text(yaml.safe_dump(native))
            self.assertIn("native type/required differs", " ".join(run()["errors"]))
            native["columns"]["id"]["type"] = "int"
            native_path.write_text(yaml.safe_dump(native))
            native["source_schema"]["fields"][2]["encoding"] = "native-json"
            native_path.write_text(yaml.safe_dump(native))
            self.assertIn("portable encoding differs", " ".join(run()["errors"]))
            native["source_schema"]["fields"][2]["encoding"] = "decimal-string"
            native["source_schema"]["fields"][1]["nullable"] = False
            native_path.write_text(yaml.safe_dump(native))
            self.assertIn("portable nullable differs", " ".join(run()["errors"]))
            native["source_schema"]["fields"][1]["nullable"] = True
            native_path.write_text(yaml.safe_dump(native))
            native["source_schema"]["fields"][2]["precision"] = 12
            native_path.write_text(yaml.safe_dump(native))
            self.assertIn("portable precision differs", " ".join(run()["errors"]))
            del native["source_schema"]["fields"][2]["precision"]
            native_path.write_text(yaml.safe_dump(native))
            views_path.write_text(yaml.safe_dump([{**views[0], "createsql": "CREATE VIEW user_names AS SELECT 1 AS name"}]))
            self.assertIn("source view SQL", " ".join(run()["errors"]))
            db.close()

    def test_ordered_foreign_key_actions_are_checked(self):
        table = {"name": "child", "foreign_keys": [(4, 0, "parent", "a", "x", "CASCADE", "SET NULL", "NONE"),
                                                   (4, 1, "parent", "b", "y", "CASCADE", "SET NULL", "NONE")]}
        native = {"foreign_keys": [{"name": "child_fk_4", "fields": ["a", "b"], "referenced_collection": "parent",
                                    "referenced_fields": ["x", "y"], "source_enforcement": "disabled",
                                    "on_update": "CASCADE", "on_delete": "SET NULL"}]}
        self.assertEqual(parity._foreign_key_errors(table, native, {"parent": "parent"}), [])
        native["foreign_keys"][0]["fields"] = ["b", "a"]
        self.assertIn("ordered foreign-key", parity._foreign_key_errors(table, native, {"parent": "parent"})[0])
        native["foreign_keys"][0]["fields"] = ["a", "b"]
        native["foreign_keys"][0]["on_delete"] = "NO ACTION"
        self.assertIn("actions differ", parity._foreign_key_errors(table, native, {"parent": "parent"})[0])

    def test_collection_identity_mapping_is_injective_and_fk_targets_are_native(self):
        source = "Order Details"
        native_id = parity._native_collection_id(source)
        self.assertEqual(native_id, "dt_4f726465722044657461696c73")
        self.assertNotEqual(native_id, parity._native_collection_id(native_id))
        self.assertNotEqual(parity._native_collection_id(native_id),
                            parity._native_collection_id(native_id.upper()))
        self.assertEqual(parity._native_collection_id("Album"), "Album")
        self.assertEqual(parity._native_collection_id("CON"), "dt_434f4e")
        self.assertEqual(parity._native_collection_id("nul.txt"), "dt_6e756c2e747874")
        table = {"name": "child", "foreign_keys": [(1, 0, source, "parent_id", "id", "NO ACTION", "NO ACTION", "NONE")]}
        schema = {"foreign_keys": [{"name": "child_fk_1", "fields": ["parent_id"],
                                    "referenced_collection": native_id, "referenced_fields": ["id"],
                                    "source_enforcement": "disabled", "on_update": "NO ACTION", "on_delete": "NO ACTION"}]}
        self.assertEqual(parity._foreign_key_errors(table, schema, {source: native_id}), [])
        schema["foreign_keys"][0]["referenced_collection"] = source
        self.assertIn("foreign-key", " ".join(parity._foreign_key_errors(table, schema, {source: native_id})))

    def test_portable_index_metadata_is_checked_independently_of_source_sql(self):
        db = sqlite3.connect(":memory:")
        db.execute("CREATE TABLE items (id INTEGER, label TEXT)")
        db.execute("CREATE UNIQUE INDEX items_label ON items(label)")
        db.execute("CREATE INDEX items_lower ON items(lower(label))")
        table = {"name": "items", "indexes": [{"name": row[1], "unique": bool(row[2]), "origin": row[3]}
                                              for row in db.execute("PRAGMA index_list(items)")]}
        expected = [{"name": "items_label", "fields": ["label"], "unique": True}]
        self.assertEqual(parity._portable_index_errors(table, {"indexes": expected}, db), [])
        altered = [{**expected[0], "unique": False}]
        self.assertIn("ordered portable indexes differ",
                      parity._portable_index_errors(table, {"indexes": altered}, db)[0])
        db.close()

    def test_native_record_formats_preserve_transport_ids_and_types(self):
        wide = 2**53 + 1
        row = {"$ID": "pk-composite", "n": wide, "s": "", "nullable": None}
        names = ["n", "s", "nullable"]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "records"
            cases = (
                ("json", json.dumps({row["$ID"]: {key: row[key] for key in names}}),
                 "map[$record_id]map[$field_name]any"),
                ("yaml", yaml.safe_dump({row["$ID"]: {key: row[key] for key in names}}),
                 "map[$record_id]map[$field_name]any"),
                ("jsonl", json.dumps(row) + "\n", "[]map[string]any"),
                ("ingr", "# INGR.io | users: $ID, n, s, nullable\n" +
                 "\n".join(json.dumps(row[key]) for key in ("$ID", *names)) + "\n# 1 record",
                 "map[$record_id]map[$field_name]any"),
            )
            for record_format, content, record_type in cases:
                with self.subTest(record_format=record_format):
                    path.write_text(content)
                    definition = {"record_file": {"format": record_format, "type": record_type}}
                    self.assertEqual(parity._native_records(path, definition, "users", names),
                                     {row["$ID"]: {key: row[key] for key in names}})
            for record_format, content in (("json", '{"same":{},"same":{}}'),
                                           ("yaml", 'same: {}\nsame: {}\n')):
                with self.subTest(duplicate=record_format):
                    path.write_text(content)
                    definition = {"record_file": {"format": record_format,
                                                   "type": "map[$record_id]map[$field_name]any"}}
                    with self.assertRaisesRegex(parity.ImportError, "duplicate"):
                        parity._native_records(path, definition, "users", names)
            with path.open("w", newline="") as stream:
                writer = csv.writer(stream)
                writer.writerow(["$ID", *names])
                writer.writerow([json.dumps(row[key]) for key in ("$ID", *names)])
            definition = {"record_file": {"format": "csv", "type": "[]map[string]any",
                                          "csv_cell_encoding": "json-v1"},
                          "columns_order": ["$ID", *names]}
            self.assertEqual(parity._native_records(path, definition, "users", names),
                             {row["$ID"]: {key: row[key] for key in names}})
            with path.open("a", newline="") as stream:
                csv.writer(stream).writerow([json.dumps(row[key]) for key in ("$ID", *names)])
            with self.assertRaisesRegex(parity.ImportError, "duplicate transport ID"):
                parity._native_records(path, definition, "users", names)


if __name__ == "__main__":
    unittest.main()
