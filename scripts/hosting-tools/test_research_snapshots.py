"""Deterministic research snapshot and checksum validation tests."""
import hashlib
import importlib.util
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("research_snapshots", HERE / "research_snapshots.py")
snapshots = importlib.util.module_from_spec(spec)
spec.loader.exec_module(snapshots)


class ResearchSnapshotsTest(unittest.TestCase):
    def test_build_is_repeatable_and_manifest_checks_every_included_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            assets = root / "_db"
            database = assets / "chinook"
            (database / "metadata").mkdir(parents=True)
            (database / "data").mkdir()
            (database / "model").mkdir()
            schema = b'{"tables":[]}\n'
            export = b'{"rows":[]}\n'
            model = b"model revision\n"
            (database / "metadata/schema.json").write_bytes(schema)
            (database / "data/chinook.json").write_bytes(export)
            (database / "model/model.hcl").write_bytes(model)
            db = {
                "id": "chinook", "name": "Chinook", "canonicalUrl": "https://chinook.demodb.dev/",
                "sourceRepository": "https://github.com/demo-db/chinook", "sourceCommit": "abc123",
                "source": {"revision": "abc123"},
                "provenance": {"sha256": "a" * 64, "license": "CC-BY-4.0"},
                "licences": {"data": "CC-BY-4.0", "model": "CC-BY-4.0"},
                "schemaSha256": hashlib.sha256(schema).hexdigest(),
                "exports": [{"assetPath": "chinook.json", "format": "json", "bytes": len(export),
                             "sha256": hashlib.sha256(export).hexdigest()}],
                "queries": [{"title": "Sample", "sql": "SELECT 1"}],
            }
            first, second = root / "first", root / "second"
            with patch.object(snapshots, "PART_BYTES", 128):
                report1 = snapshots.write_bundle(db, assets, first)
                report2 = snapshots.write_bundle(db, assets, second)
            self.assertEqual(report1["archiveSha256"], report2["archiveSha256"])
            self.assertEqual(report1["parts"], report2["parts"])
            self.assertGreater(len(report1["parts"]), 1)
            self.assertFalse((first / "chinook.zip").exists(), "oversize archive must not be emitted as one static asset")
            self.assertTrue(all(part["bytes"] <= 128 for part in report1["parts"]))
            verified = snapshots.verify(first / "chinook.manifest.json")
            self.assertEqual(verified["status"], "verified")
            manifest = json.loads((first / "chinook.manifest.json").read_text())
            self.assertEqual(manifest["source"]["commit"], "abc123")
            self.assertEqual(manifest["licences"]["data"], "CC-BY-4.0")
            self.assertEqual(manifest["archive"]["sha256"], report1["archiveSha256"])
            self.assertEqual({entry["path"] for entry in manifest["files"]}, {
                "metadata/schema.json", "data/chinook.json", "model/model.hcl", "queries/examples.json"})
            corrupt_archive = first / "chinook.zip"
            corrupt_archive.write_bytes(b"not a zip archive")
            with self.assertRaisesRegex(snapshots.SnapshotError, "provided archive SHA-256"):
                snapshots.verify(corrupt_archive, first / "chinook.manifest.json")

    def test_verify_detects_changed_archive_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            assets = root / "_db"
            dataset = assets / "employees"
            (dataset / "metadata").mkdir(parents=True)
            (dataset / "data").mkdir()
            schema = b'{"tables":[]}\n'
            rows = b"[]\n"
            (dataset / "metadata/schema.json").write_bytes(schema)
            (dataset / "data/employees.json").write_bytes(rows)
            db = {"id": "employees", "name": "Employees", "sourceRepository": "repo", "sourceCommit": "def",
                  "source": {"revision": "def"}, "provenance": {}, "licences": {},
                  "schemaSha256": hashlib.sha256(schema).hexdigest(), "exports": [{"assetPath": "employees.json",
                  "bytes": len(rows), "sha256": hashlib.sha256(rows).hexdigest()}], "queries": []}
            output = root / "out"
            snapshots.write_bundle(db, assets, output)
            manifest = json.loads((output / "employees.manifest.json").read_text())
            part = output / manifest["archive"]["parts"][0]["file"]
            part.write_bytes(b"changed")
            with self.assertRaisesRegex(snapshots.SnapshotError, "archive part checksum"):
                snapshots.verify(output / "employees.manifest.json")

    def test_verify_cleans_temporary_archive_when_a_part_is_missing(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            assets = root / "_db"
            dataset = assets / "employees"
            (dataset / "metadata").mkdir(parents=True)
            (dataset / "data").mkdir()
            schema = b'{"tables":[]}\n'
            rows = b"[]\n"
            (dataset / "metadata/schema.json").write_bytes(schema)
            (dataset / "data/employees.json").write_bytes(rows)
            db = {"id": "employees", "name": "Employees", "sourceRepository": "repo", "sourceCommit": "def",
                  "source": {"revision": "def"}, "provenance": {}, "licences": {},
                  "schemaSha256": hashlib.sha256(schema).hexdigest(), "exports": [{"assetPath": "employees.json",
                  "bytes": len(rows), "sha256": hashlib.sha256(rows).hexdigest()}], "queries": []}
            output = root / "out"
            with patch.object(snapshots, "PART_BYTES", 64):
                snapshots.write_bundle(db, assets, output)
            manifest = json.loads((output / "employees.manifest.json").read_text())
            self.assertGreater(len(manifest["archive"]["parts"]), 1)
            (output / manifest["archive"]["parts"][-1]["file"]).unlink()
            with self.assertRaisesRegex(snapshots.SnapshotError, "asset path is missing"):
                snapshots.verify(output / "employees.manifest.json")
            self.assertEqual(list(output.glob("demodb-snapshot-*.zip")), [], "failed verification must remove the partial archive")


if __name__ == "__main__":
    unittest.main()
