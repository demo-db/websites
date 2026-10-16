"""Tests for the inGitDB archive packer."""
import hashlib
import importlib.util
import io
import json
import pathlib
import tarfile
import tempfile
import unittest
import zipfile

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("ingitdb_archive", HERE / "ingitdb_archive.py")
archive = importlib.util.module_from_spec(spec)
spec.loader.exec_module(archive)

FIXTURE = "a" * 64
REVISION = "b" * 40


def manifest(**overrides):
    value = {"datasetId": "demo", "source": {"fixtureSha256": FIXTURE}, "rowCount": 2, "recordFormat": "json", "generatorVersion": "0.61.1",
             "nativeParity": {"metadataAndDataMatch": True, "dataChecked": True, "errorCount": 0}}
    value.update(overrides)
    return value


def tarball(files, prefix=f"demo-{REVISION}"):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as bundle:
        for name, data in files.items():
            info = tarfile.TarInfo(f"{prefix}/{name}")
            info.size = len(data)
            bundle.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


class IngitdbArchiveTest(unittest.TestCase):
    def setUp(self):
        self.files = {
            "ingitdb/export-manifest.json": json.dumps(manifest()).encode(),
            "ingitdb/t/records.json": b'{"1": {"a": 1}}\n',
            "ingitdb/t/.collection/definition.yaml": b"id: t\n",
            "README.md": b"not part of the edition\n",
        }

    def build(self, files=None, **kwargs):
        with tempfile.TemporaryDirectory() as temporary:
            path = pathlib.Path(temporary) / "demo.tar.gz"
            path.write_bytes(tarball(files or self.files))
            return archive.build("demo", FIXTURE, repository="https://github.com/demo-db/demo", revision=REVISION, directory=None, tarball=path, **kwargs)

    def test_packs_only_the_ingitdb_directory_unchanged_and_deterministically(self):
        data, report = self.build()
        again, repeat = self.build()
        self.assertEqual(data, again)
        self.assertEqual(report, repeat)
        names = zipfile.ZipFile(io.BytesIO(data)).namelist()
        self.assertEqual(names, sorted(names))
        self.assertTrue(all(name.startswith("demo-ingitdb/") for name in names))
        self.assertNotIn("demo-ingitdb/README.md", names)
        self.assertEqual(zipfile.ZipFile(io.BytesIO(data)).read("demo-ingitdb/t/records.json"), b'{"1": {"a": 1}}\n')
        self.assertEqual(report["fileCount"], 3)
        self.assertEqual(report["rowCount"], 2)
        self.assertEqual(report["sha256"], hashlib.sha256(data).hexdigest())
        info = zipfile.ZipFile(io.BytesIO(data)).infolist()[0]
        self.assertEqual(info.date_time, (1980, 1, 1, 0, 0, 0))

    def test_content_digest_does_not_depend_on_the_zip_encoding(self):
        files = {"b": b"2", "a": b"1"}
        self.assertEqual(archive.content_sha256(files), archive.content_sha256({"a": b"1", "b": b"2"}))
        self.assertNotEqual(archive.content_sha256(files), archive.content_sha256({"a": b"1", "b": b"3"}))

    def test_refuses_an_edition_exported_from_another_fixture_or_dataset(self):
        wrong_fixture = dict(self.files, **{"ingitdb/export-manifest.json": json.dumps(manifest(source={"fixtureSha256": "c" * 64})).encode()})
        with self.assertRaisesRegex(archive.ArchiveError, "different SQLite fixture"):
            self.build(wrong_fixture)
        wrong_dataset = dict(self.files, **{"ingitdb/export-manifest.json": json.dumps(manifest(datasetId="other")).encode()})
        with self.assertRaisesRegex(archive.ArchiveError, "export manifest is for"):
            self.build(wrong_dataset)

    def test_refuses_an_edition_without_a_clean_parity_record(self):
        dirty = dict(self.files, **{"ingitdb/export-manifest.json": json.dumps(manifest(nativeParity={"metadataAndDataMatch": False, "dataChecked": True, "errorCount": 1})).encode()})
        with self.assertRaisesRegex(archive.ArchiveError, "clean data parity"):
            self.build(dirty)

    def test_refuses_a_revision_without_the_directory_and_a_foreign_tarball_layout(self):
        with self.assertRaisesRegex(archive.ArchiveError, "no ingitdb/ directory"):
            self.build({"README.md": b"x"})
        with tempfile.TemporaryDirectory() as temporary:
            path = pathlib.Path(temporary) / "x.tar.gz"
            path.write_bytes(tarball(self.files, prefix="other-" + REVISION))
            with self.assertRaisesRegex(archive.ArchiveError, "outside"):
                archive.build("demo", FIXTURE, repository="https://github.com/demo-db/demo", revision=REVISION, directory=None, tarball=path)

    def test_refuses_unsafe_arguments(self):
        with self.assertRaises(archive.ArchiveError):
            archive.build("Demo", FIXTURE, repository=None, revision=None, directory=None)
        with self.assertRaises(archive.ArchiveError):
            archive.build("demo", "short", repository=None, revision=None, directory=None)
        with self.assertRaises(archive.ArchiveError):
            archive.build("demo", FIXTURE, repository="https://example.com/x/y", revision=REVISION, directory=None)
        with self.assertRaises(archive.ArchiveError):
            archive.build("demo", FIXTURE, repository="https://github.com/demo-db/demo", revision="main", directory=None)
        with self.assertRaises(archive.ArchiveError):
            archive._safe("../escape")

    def test_reads_a_local_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary) / "ingitdb"
            (root / "t").mkdir(parents=True)
            (root / "export-manifest.json").write_text(json.dumps(manifest()))
            (root / "t" / "records.json").write_text("{}")
            data, report = archive.build("demo", FIXTURE, repository=None, revision=None, directory=root)
            self.assertEqual(report["fileCount"], 2)
            self.assertEqual(report["directory"], True)
            (root / "link").symlink_to(root / "t")
            with self.assertRaisesRegex(archive.ArchiveError, "symbolic link"):
                archive.build("demo", FIXTURE, repository=None, revision=None, directory=root)

    def test_cli_reports_and_enforces_the_asset_limit(self):
        with tempfile.TemporaryDirectory() as temporary:
            tar = pathlib.Path(temporary) / "demo.tar.gz"
            tar.write_bytes(tarball(self.files))
            out = pathlib.Path(temporary) / "out" / "demo.zip"
            args = ["demo", "--fixture-sha256", FIXTURE, "--repository", "https://github.com/demo-db/demo", "--revision", REVISION, "--tarball", str(tar), "--output", str(out)]
            self.assertEqual(archive.main(args), 0)
            self.assertTrue(out.is_file())
            out.unlink()
            original = archive.MAX_ARCHIVE_BYTES
            archive.MAX_ARCHIVE_BYTES = 10
            try:
                self.assertEqual(archive.main(args), 2)
                self.assertFalse(out.exists())
            finally:
                archive.MAX_ARCHIVE_BYTES = original
            self.assertEqual(archive.main(["demo", "--fixture-sha256", "bad", "--directory", temporary, "--output", str(out)]), 1)


if __name__ == "__main__":
    unittest.main()
