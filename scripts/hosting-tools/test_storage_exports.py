"""Boundary checks for reproducible storage exports."""
import importlib.util
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch
import json

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
spec = importlib.util.spec_from_file_location("storage_exports", HERE / "storage_exports.py")
exports = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exports)


class StorageExportsTest(unittest.TestCase):
    def test_decimal_and_binary_roundtrip(self):
        self.assertEqual(exports.scalar(".0000", "DECIMAL_TEXT(10,4)"), ".0000")
        self.assertEqual(exports.scalar(2.5, "DECIMAL(10,2)"), "2.5")
        self.assertEqual(exports.bigquery_type("DECIMAL(10,2)", {"float"}), "NUMERIC")
        self.assertEqual(exports.bigquery_type("DECIMAL(38,6)", {"str"}), "BIGNUMERIC")
        self.assertEqual(exports.bigquery_type("DECIMAL(38,9)", {"str"}), "NUMERIC")
        self.assertEqual(exports.bigquery_type("DECIMAL(76,0)", {"str"}), "STRING")
        blob = b"\x00\xffabc"
        encoded = exports.encode_value(blob, "BLOB", False)
        self.assertEqual(exports.decode_value(encoded, "BLOB", False, bytes), blob)

    def test_mixed_storage_classes_are_tagged(self):
        for value in ("2", 2, 2.0, b"2"):
            encoded = exports.encode_value(value, "", True)
            self.assertEqual(exports.decode_value(encoded, "", True, type(value)), value)
        self.assertEqual(exports.bigquery_type("", {"str", "int"}), "STRING")

    def test_large_integer_fails_closed_for_json_reader(self):
        with self.assertRaisesRegex(exports.ImportError, "lossless inGitDB JSON"):
            exports.scalar(2**53, "INTEGER")

    def test_second_export_refuses_nonempty_output_without_changing_it(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            provider = root / "provider"
            provider.mkdir()
            source = {"repository": "https://example.test/source", "revision": "test"}
            (provider / "manifest.json").write_text(json.dumps({"source": source}))
            contract = provider / "contract.json"
            contract.write_text(json.dumps({"manifest": {"source": source}}))
            catalogue = json.loads((HERE.parents[1] / "config" / "databases.json").read_text())
            pin = next(entry for entry in catalogue["databases"] if entry["id"] == "chinook")

            class Snapshot:
                database_id = "chinook"
                source_sha256 = "a" * 64
                source_bytes = 1
                tables = []
                views = []

                def close(self):
                    pass

            output = root / "output"
            with patch.object(exports, "inspect", return_value=Snapshot()), \
                 patch.object(exports, "digest", side_effect=lambda path: pin["contractSha256"] if path == contract else ""):
                exports.export(provider, output)
            first = (output / "export-manifest.json").read_bytes()
            with self.assertRaisesRegex(exports.ImportError, "not empty"):
                exports.export(provider, output)
            self.assertEqual((output / "export-manifest.json").read_bytes(), first)


if __name__ == "__main__":
    unittest.main()
