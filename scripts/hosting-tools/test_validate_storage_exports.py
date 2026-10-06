"""Meaningful SQL constraint comparison and exported-row orphan checks."""
import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from storage_exports import record_id
spec = importlib.util.spec_from_file_location("validate_storage_exports", HERE / "validate_storage_exports.py")
validate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validate)


class ValidationTest(unittest.TestCase):
    def test_composite_foreign_key_preserves_order_and_actions(self):
        table = {"foreign_keys": [
            (3, 0, "parent", "a", "x", "CASCADE", "RESTRICT", "NONE"),
            (3, 1, "parent", "b", "y", "CASCADE", "RESTRICT", "NONE"),
        ]}
        rows, groups = validate.expected_foreign_keys(table)
        self.assertEqual([row["sequence"] for row in rows], [0, 1])
        self.assertEqual(groups, [{"id": 3, "localColumns": ["a", "b"],
                                   "referencedTable": "parent", "referencedColumns": ["x", "y"],
                                   "onUpdate": "CASCADE", "onDelete": "RESTRICT", "match": "NONE", "enforced": False}])

    def test_exported_composite_orphan_check_skips_partially_null_key(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            (root / "parent.json").write_text(json.dumps({"p": {"x": 1, "y": 2}}))
            child_path = root / "child.json"
            child_path.write_text(json.dumps({"ok": {"a": 1, "b": 2}, "null": {"a": 1, "b": None}}))
            published = {
                "parent": {"nativeName": "parent", "records": {"path": "parent.json"},
                           "columns": [{"nativeName": "x", "encoding": "native-json"}, {"nativeName": "y", "encoding": "native-json"}]},
                "child": {"nativeName": "child", "records": {"path": "child.json"},
                          "columns": [{"nativeName": "a", "encoding": "native-json"}, {"nativeName": "b", "encoding": "native-json"}]},
            }
            source = {
                "parent": {"name": "parent", "sql": "CREATE TABLE parent (x INT, y INT, PRIMARY KEY (x,y))",
                           "columns": [{"name": "x", "type": "INT", "pk": 1}, {"name": "y", "type": "INT", "pk": 2}],
                           "foreign_keys": [], "indexes": []},
                "child": {"name": "child", "sql": "CREATE TABLE child (a INT, b INT, FOREIGN KEY (a,b) REFERENCES parent(x,y))",
                          "columns": [{"name": "a", "type": "INT", "pk": 0}, {"name": "b", "type": "INT", "pk": 0}], "foreign_keys": [
                    (0, 0, "parent", "a", "x", "NO ACTION", "NO ACTION", "NONE"),
                    (0, 1, "parent", "b", "y", "NO ACTION", "NO ACTION", "NONE"),
                ], "indexes": []},
            }
            class Snapshot:
                def rows(self, name):
                    return iter([(1, 2)] if name == "parent" else [(1, 2), (1, None)])
            count, findings, _rows = validate.check_orphans(root, published, source, Snapshot())
            self.assertEqual((count, findings), (0, []))
            child_path.write_text(json.dumps({"orphan": {"a": 1, "b": 3}}))
            count, findings, row_findings = validate.check_orphans(root, published, source, Snapshot())
            self.assertEqual(count, 1)
            self.assertIn("violates source FK", findings[0])
            self.assertTrue(row_findings)

    def test_parity_detects_action_order_and_nullability_mutations(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            (root / "export-manifest.json").touch()
            parent = {"name": "parent", "sql": "CREATE TABLE parent (x INT PRIMARY KEY)",
                      "columns": [{"name": "x", "type": "INT", "notnull": True, "pk": 1, "default": None}],
                      "foreign_keys": [], "indexes": []}
            child = {"name": "child", "sql": "CREATE TABLE child (a INT, b INT)",
                     "columns": [{"name": "a", "type": "INT", "notnull": False, "pk": 0, "default": None},
                                 {"name": "b", "type": "INT", "notnull": False, "pk": 0, "default": None}],
                     "foreign_keys": [(0, 0, "parent", "a", "x", "CASCADE", "RESTRICT", "NONE"),
                                      (0, 1, "parent", "b", "x", "CASCADE", "RESTRICT", "NONE")], "indexes": []}

            class Snapshot:
                database_id = "synthetic"
                source_sha256 = "a" * 64
                tables = [parent, child]
                def row_count(self, _name): return 0
                def close(self): pass

            tables = []
            definitions = {}
            for source in (parent, child):
                name = source["name"]
                columns = [{**column, "ingitdbType": "any"}
                           for column in validate.expected_columns(source)]
                foreign_rows, foreign_groups = validate.expected_foreign_keys(source)
                tables.append({"nativeName": name, "collection": name, "rows": 0, "sourceSql": source["sql"],
                               "columns": columns, "primaryKey": ["x"] if name == "parent" else [],
                               "indexes": [], "foreignKeys": foreign_rows, "foreignKeyConstraints": foreign_groups})
                definitions[name] = {"columns": {col["nativeName"]: {"type": "any", "required": col["exportRequired"]} for col in columns},
                                     "primary_key": ["x"] if name == "parent" else [],
                                     "record_file": {"type": "map[$record_id]map[$field_name]any"}}
            manifest = {"datasetId": "synthetic", "source": {"fixtureSha256": "a" * 64},
                        "rowCount": 0, "tables": tables}

            def run():
                (root / "export-manifest.json").write_text(json.dumps(manifest))
                with patch.object(validate, "inspect", return_value=Snapshot()), \
                     patch.object(validate, "definition", side_effect=lambda _root, name: definitions[name]):
                    return validate.validate(root, root, check_data=False)

            baseline = run()
            self.assertTrue(baseline["metadataMatches"], baseline["errors"])
            self.assertIsNone(baseline["metadataAndDataMatch"])
            self.assertFalse(baseline["nativeConstraintEquivalent"])
            manifest["tables"][1]["foreignKeys"][0]["onDelete"] = "CASCADE"
            self.assertIn("ordered FK rows or actions differ", " ".join(run()["errors"]))
            manifest["tables"][1]["foreignKeys"][0]["onDelete"] = "RESTRICT"
            manifest["tables"][1]["foreignKeyConstraints"][0]["localColumns"].reverse()
            self.assertIn("grouped FK constraints differ", " ".join(run()["errors"]))
            manifest["tables"][1]["foreignKeyConstraints"][0]["localColumns"].reverse()
            manifest["tables"][1]["columns"][0]["sourceDeclaredNullable"] = False
            self.assertIn("sourceDeclaredNullable differs", " ".join(run()["errors"]))

    def test_row_swap_under_existing_record_ids_fails_even_when_multiset_matches(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            columns = [{"name": "id", "type": "INT", "pk": 1}, {"name": "value", "type": "TEXT", "pk": 0}]
            first, second = (1, "A"), (2, "B")
            key1, key2 = record_id(first, columns, 1), record_id(second, columns, 2)
            (root / "rows.json").write_text(json.dumps({key1: {"id": 2, "value": "B"},
                                                       key2: {"id": 1, "value": "A"}}))
            source = {"example": {"name": "example", "sql": "CREATE TABLE example (id INT PRIMARY KEY, value TEXT)",
                                  "columns": columns, "foreign_keys": [], "indexes": []}}
            published = {"example": {"nativeName": "example", "records": {"path": "rows.json"},
                                     "columns": [{"nativeName": "id", "encoding": "native-json"},
                                                 {"nativeName": "value", "encoding": "native-json"}]}}
            class Snapshot:
                def rows(self, _name): return iter([first, second])
            orphans, _fk_findings, row_findings = validate.check_orphans(root, published, source, Snapshot())
            self.assertEqual(orphans, 0)
            self.assertIn("example: 2 exported records differ at their transport IDs", row_findings)


if __name__ == "__main__":
    unittest.main()
