"""Live PostgreSQL load + verify test for every pinned provider dataset.

Skipped unless DEMODB_LIVE_POSTGRES_URL points at a THROWAWAY server on a
loopback host (never a hosted database) and DEMODB_PROVIDER_ROOTS names a
directory holding one checkout per dataset id at the revision pinned in
config/databases.json (<root>/<id>/manifest.json).

For each dataset the test loads the generated canonical SQL, runs `verify`,
drops the schema, then repeats with the COPY-based `import` path and `verify`.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).parent))
import postgres_samples as pg  # noqa: E402

URL = os.environ.get("DEMODB_LIVE_POSTGRES_URL", "")
ROOTS = os.environ.get("DEMODB_PROVIDER_ROOTS", "")
CONFIG = Path(__file__).resolve().parents[2] / "config" / "databases.json"
# Northwind ships its own PostgreSQL artifact (artifacts/hosting-imports/postgres.sql,
# built by the northwind repo's tooling, which emulates SQL Server-style view
# expressions that SQLite evaluates differently). The shared generator does not
# claim northwind, so that artifact is loaded as-is and compared table by table.
OWN_ARTIFACT = {"northwind"}
LOOPBACK = {"127.0.0.1", "localhost", "::1"}


@unittest.skipUnless(URL and ROOTS, "set DEMODB_LIVE_POSTGRES_URL and DEMODB_PROVIDER_ROOTS to run live PostgreSQL tests")
class LivePostgresTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        host = urlsplit(URL).hostname
        if host not in LOOPBACK:
            raise RuntimeError(f"refusing live test against non-loopback host {host!r}")
        import psycopg
        cls.psycopg = psycopg
        cls.ids = [d["id"] for d in json.loads(CONFIG.read_text(encoding="utf-8"))["databases"]]

    def connect(self):
        return self.psycopg.connect(URL, autocommit=True)

    def drop(self, schema: str) -> None:
        with self.connect() as conn:
            conn.execute(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE')

    def check_own_artifact(self, dataset: str, root: Path) -> None:
        import sqlite3
        manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
        source = sqlite3.connect(f"file:{root / manifest['dataFile']}?mode=ro", uri=True)
        try:
            self.drop(dataset)
            with self.connect() as conn:
                conn.execute((root / "artifacts" / "hosting-imports" / "postgres.sql").read_text(encoding="utf-8"))
                tables = [r[0] for r in source.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
                total = 0
                for table in tables:
                    expected = source.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0]
                    actual = conn.execute(f'SELECT count(*) FROM "{dataset}"."{table}"').fetchone()[0]
                    with self.subTest(dataset=dataset, table=table):
                        self.assertEqual(actual, expected)
                    total += actual
                    print(f"  {dataset}.{table}: sqlite={expected} postgres={actual}")
                print(f"own-artifact {dataset}: {len(tables)} tables, {total} rows")
        finally:
            source.close()
            self.drop(dataset)

    def test_every_dataset_loads_and_verifies_via_generated_sql_and_import(self) -> None:
        for dataset in self.ids:
            root = Path(ROOTS) / dataset
            if dataset in OWN_ARTIFACT:
                self.check_own_artifact(dataset, root)
                continue
            with self.subTest(dataset=dataset, path="generate"):
                self.drop(dataset)
                with tempfile.TemporaryDirectory() as tmp:
                    out = Path(tmp) / "postgres.sql"
                    report = pg.generate(root, out)
                    with self.connect() as conn:
                        conn.execute(out.read_text(encoding="utf-8"))
                        result = pg.verify_database(conn, root)
                self.assertEqual(result["rows"], report["rows"])
                print(f"generate+verify {dataset}: {json.dumps(result, sort_keys=True)}")
            with self.subTest(dataset=dataset, path="import"):
                self.drop(dataset)
                with self.connect() as conn:
                    imported = pg.import_database(conn, root)
                    result = pg.verify_database(conn, root)
                self.assertEqual(result["rows"], imported["rows"])
                print(f"import+verify   {dataset}: {json.dumps(result, sort_keys=True)}")
            self.drop(dataset)


if __name__ == "__main__":
    unittest.main()
