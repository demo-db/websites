"""Boundary checks for reproducible storage exports."""
import importlib.util
import pathlib
import sys
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

    def test_large_integer_fails_closed_for_json_reader(self):
        with self.assertRaisesRegex(exports.ImportError, "lossless inGitDB JSON"):
            exports.scalar(2**53, "INTEGER")


if __name__ == "__main__":
    unittest.main()
