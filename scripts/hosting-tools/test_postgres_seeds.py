from __future__ import annotations

import hashlib
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import postgres_seeds as seeds  # noqa: E402


class PostgresSeedsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.provider = self.root / "provider"
        self.provider.mkdir()
        db_path = self.provider / "source.sqlite"
        db = sqlite3.connect(db_path)
        db.executescript('''
            PRAGMA foreign_keys=ON;
            CREATE TABLE ParentA (a INTEGER, b INTEGER, label TEXT, PRIMARY KEY (a,b));
            CREATE TABLE ParentB (id INTEGER PRIMARY KEY, label TEXT);
            CREATE TABLE Child (
              id INTEGER PRIMARY KEY,
              a INTEGER,
              b INTEGER,
              parent_b INTEGER,
              FOREIGN KEY (a,b) REFERENCES ParentA(a,b),
              FOREIGN KEY (parent_b) REFERENCES ParentB(id)
            );
            CREATE TABLE CycleA (id INTEGER PRIMARY KEY, b_id INTEGER,
              FOREIGN KEY (b_id) REFERENCES CycleB(id) DEFERRABLE INITIALLY DEFERRED);
            CREATE TABLE CycleB (id INTEGER PRIMARY KEY, a_id INTEGER,
              FOREIGN KEY (a_id) REFERENCES CycleA(id) DEFERRABLE INITIALLY DEFERRED);
            CREATE TABLE Keyless (value TEXT);
            BEGIN;
            INSERT INTO ParentA VALUES (1,1,'one'),(2,2,'two');
            INSERT INTO ParentB VALUES (1,'one');
            INSERT INTO Child VALUES (1,1,1,1),(2,2,2,NULL);
            INSERT INTO CycleA VALUES (1,1);
            INSERT INTO CycleB VALUES (1,1);
            INSERT INTO Keyless VALUES ('same'),('same');
        ''')
        db.commit()
        db.close()
        payload = db_path.read_bytes()
        (self.provider / "manifest.json").write_text(json.dumps({
            "contractVersion": 1,
            "id": "chinook",
            "dataFile": "source.sqlite",
            "source": {
                "sha256": hashlib.sha256(payload).hexdigest(),
                "repository": "https://example.invalid/source",
                "revision": "0123456789abcdef",
            },
        }), encoding="utf-8")

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_full_seed_is_deterministic_fk_safe_and_one_transaction(self) -> None:
        out_one = self.root / "out-one"
        out_two = self.root / "out-two"
        one = seeds.build(self.provider, out_one)
        two = seeds.build(self.provider, out_two)
        first = out_one / "chinook"
        second = out_two / "chinook"
        self.assertEqual((first / "seed.sql.gz").read_bytes(), (second / "seed.sql.gz").read_bytes())
        self.assertEqual((first / "seed-manifest.json").read_bytes(), (second / "seed-manifest.json").read_bytes())
        self.assertEqual(one["format"], "demodb-postgres-seed")
        self.assertEqual(one["formatVersion"], 1)
        self.assertEqual(one["source"]["fixturePath"], "source.sqlite")
        self.assertEqual(one["integrity"]["sourceForeignKeyViolations"], 0)
        self.assertTrue(one["restore"]["singleTransaction"])
        self.assertFalse(one["restore"]["psqlMetaCommands"])
        self.assertEqual(sum(table["retainedRows"] for table in one["tables"]), 9)
        self.assertTrue(all(table["sourceRows"] == table["retainedRows"] and table["prunedRows"] == 0
                            for table in one["tables"]))
        result = seeds.verify(self.provider, out_one)
        self.assertTrue(result["verified"])
        self.assertEqual(result["foreignKeyViolations"], 0)
        self.assertEqual(result["rows"], 9)
        self.assertEqual(one["restore"]["uncompressed"]["sha256"], result["uncompressedSqlSha256"])

    def test_manifest_or_sql_corruption_is_rejected(self) -> None:
        output = self.root / "out"
        seeds.build(self.provider, output)
        bundle = output / "chinook"
        (bundle / "seed.sql.gz").write_bytes(b"corrupt")
        with self.assertRaisesRegex(seeds.pg.ImportError, "compressed SQL checksum"):
            seeds.verify(self.provider, output)

    def test_source_foreign_key_violation_blocks_seed(self) -> None:
        db_path = self.provider / "source.sqlite"
        db = sqlite3.connect(db_path)
        db.execute("PRAGMA foreign_keys=OFF")
        db.execute("INSERT INTO Child VALUES (3,99,99,NULL)")
        db.commit()
        db.close()
        payload = db_path.read_bytes()
        manifest = json.loads((self.provider / "manifest.json").read_text())
        manifest["source"]["sha256"] = hashlib.sha256(payload).hexdigest()
        (self.provider / "manifest.json").write_text(json.dumps(manifest))
        with self.assertRaisesRegex(seeds.pg.ImportError, "foreign_key_check"):
            seeds.build(self.provider, self.root / "out")

    def test_unapproved_tpch_dataset_is_refused(self) -> None:
        manifest_path = self.provider / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["id"] = "tpch"
        manifest_path.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(seeds.pg.ImportError, "not in the approved six-dataset"):
            seeds.build(self.provider, self.root / "out")


if __name__ == "__main__":
    unittest.main()
