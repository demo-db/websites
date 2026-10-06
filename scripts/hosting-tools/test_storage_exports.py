"""Boundary checks for reproducible storage exports."""
import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest

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

    def test_large_integer_remains_exact_in_bigquery_rows(self):
        self.assertEqual(exports.scalar(2**53 + 1, "INTEGER"), 2**53 + 1)
        self.assertEqual(exports.bigquery_type("NUMERIC", {"float"}), "STRING")

    def test_export_refuses_nonempty_output_before_reading_source_or_running_cli(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            output = root / "output"
            output.mkdir()
            (output / "sentinel").write_bytes(b"caller data")
            with self.assertRaisesRegex(exports.ImportError, "not empty"):
                exports.export(root / "missing-provider", output)
            self.assertEqual((output / "sentinel").read_bytes(), b"caller data")

    def test_export_rejects_unsupported_format_before_touching_destination(self):
        with tempfile.TemporaryDirectory() as temp:
            output = pathlib.Path(temp) / "new-output"
            with self.assertRaisesRegex(exports.ImportError, "unsupported native records format"):
                exports.export(pathlib.Path(temp) / "missing-provider", output, records_format="xml")
            self.assertFalse(output.exists())

    def test_exclusive_publish_refuses_destination_created_after_guard(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            staging, output = root / "staging", root / "output"
            staging.mkdir()
            (staging / "candidate").write_bytes(b"new")
            output.mkdir()
            (output / "sentinel").write_bytes(b"caller data")
            with self.assertRaises(OSError):
                exports.publish_exclusive(staging, output)
            self.assertEqual((output / "sentinel").read_bytes(), b"caller data")
            self.assertEqual((staging / "candidate").read_bytes(), b"new")
            (output / "sentinel").unlink()
            with self.assertRaises(OSError):
                exports.publish_exclusive(staging, output)
            self.assertTrue(output.is_dir())

    def test_public_parity_receipt_excludes_private_diagnostics(self):
        with tempfile.TemporaryDirectory() as temp:
            parity = {field: None for field in exports.PUBLIC_PARITY_FIELDS}
            parity.update({"format": "demodb-datatug-parity/v1", "sourceSha256": "f" * 64,
                           "metadataAndDataMatch": True, "errorCount": 0,
                           "privatePath": "/Users/alex/private/source.sqlite",
                           "sourceUrl": "postgres://private-credential@example.invalid/db"})
            path = exports.persist_public_parity(pathlib.Path(temp), parity)
            published = json.loads(path.read_text())
            self.assertEqual(set(published), set(exports.PUBLIC_PARITY_FIELDS))
            self.assertEqual(published["sourceSha256"], "f" * 64)
            self.assertNotIn("privatePath", published)
            self.assertNotIn("sourceUrl", published)


if __name__ == "__main__":
    unittest.main()
