"""Offline tests for the served-format validator helpers (the PostgreSQL and parity runs need live services)."""
import gzip
import importlib.util
import pathlib
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
spec = importlib.util.spec_from_file_location("validate_served_formats", HERE / "validate_served_formats.py")
validator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validator)


class ValidateServedFormatsTest(unittest.TestCase):
    def test_reads_plain_gzip_and_chunked_assets(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            (root / "plain.json").write_bytes(b"{}")
            (root / "one.json.gz").write_bytes(gzip.compress(b"[1]"))
            encoded = gzip.compress(b"x" * 1000)
            (root / "many.gz.0001.part").write_bytes(encoded[:10])
            (root / "many.gz.0002.part").write_bytes(encoded[10:])
            self.assertEqual(validator.read_export(root, {"assetPath": "plain.json"}), b"{}")
            self.assertEqual(validator.read_export(root, {"assetPath": "one.json.gz", "compression": "gzip"}), b"[1]")
            chunks = [{"assetPath": "many.gz.0001.part"}, {"assetPath": "many.gz.0002.part"}]
            self.assertEqual(validator.read_export(root, {"chunks": chunks, "compression": "gzip"}), b"x" * 1000)

    def test_normalises_names_across_naming_styles(self):
        self.assertEqual(validator.norm("PlaylistTrack"), validator.norm("playlist_track"))
        self.assertEqual(validator.norm("Order Details"), "orderdetails")

    def test_picks_the_complete_export_not_a_table_export(self):
        db = {"exports": [{"format": "json", "table": "a"}, {"format": "json", "table": None, "assetPath": "all.json"}]}
        self.assertEqual(validator.complete(db, "json")["assetPath"], "all.json")
        self.assertIsNone(validator.complete(db, "yaml"))

    def test_requires_a_provider_checkout(self):
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaises(SystemExit):
                validator.provider_root(pathlib.Path(temporary), "missing")


if __name__ == "__main__":
    unittest.main()
