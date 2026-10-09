from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import sys
import tempfile
import unittest
import yaml
from urllib.error import HTTPError
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import postgres_samples as pg  # noqa: E402
import verify_hosted_snapshots as verify  # noqa: E402


class FakeCursor:
    def __init__(self, rows: list[tuple[str, str]]) -> None:
        self.rows = rows

    def execute(self, query: str, args: tuple[str, ...]) -> None:
        self.query = query
        self.args = args

    def fetchall(self) -> list[tuple[str, str]]:
        return self.rows


class FakeConnection:
    def __init__(self, rows: list[tuple[str, str]]) -> None:
        self.fake_cursor = FakeCursor(rows)

    def cursor(self) -> FakeCursor:
        return self.fake_cursor


class HostedSnapshotVerificationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / "source.sqlite"
        db = sqlite3.connect(self.source)
        db.executescript('''
            CREATE TABLE parent (id INTEGER PRIMARY KEY, label TEXT NOT NULL, note TEXT);
            INSERT INTO parent VALUES (1, 'one', NULL), (2, 'two', 'memo');
            CREATE VIEW parent_names AS SELECT id, label FROM parent;
        ''')
        db.close()
        raw = self.source.read_bytes()
        (self.root / "manifest.json").write_text(json.dumps({
            "contractVersion": 1, "id": "fixture", "dataFile": "source.sqlite",
            "source": {"sha256": hashlib.sha256(raw).hexdigest()},
        }), encoding="utf-8")
        self.snapshot = pg.inspect(self.root)
        self.baseline = {
            "id": "fixture", "datasetId": "fixture", "tableCount": 1, "rowCount": 2,
            "tables": [{"tableId": "parent", "sourceTable": "parent", "rowCount": 2,
                        "schema": {"fields": [
                            {"name": "id", "type": "INTEGER", "mode": "REQUIRED", "description": "Source field: id"},
                            {"name": "label", "type": "STRING", "mode": "REQUIRED", "description": "Source field: label"},
                            {"name": "note", "type": "STRING", "mode": "NULLABLE", "description": "Source field: note"},
                        ]}}],
        }

    def tearDown(self) -> None:
        self.snapshot.close()
        self.temp.cleanup()

    def test_postgres_inventory_allows_only_pinned_tables_views_and_import_manifest(self) -> None:
        rows = [("_import_manifest", "r"), ("parent", "r"), ("parent_names", "v")]
        receipt = verify.verify_postgres_inventory(FakeConnection(rows), self.root)
        self.assertTrue(receipt["inventoryMatch"])
        self.assertEqual(receipt["provenanceTables"], 1)

    def test_postgres_inventory_rejects_missing_and_extra_relations(self) -> None:
        for rows in (
            [("_import_manifest", "r"), ("parent", "r")],
            [("_import_manifest", "r"), ("parent", "r"), ("parent_names", "v"), ("unpublished", "r")],
        ):
            with self.subTest(rows=rows), self.assertRaisesRegex(pg.ImportError, "inventory drift"):
                verify.verify_postgres_inventory(FakeConnection(rows), self.root)

    def test_postgres_inventory_rejects_wrong_relation_kinds(self) -> None:
        rows = [("_import_manifest", "r"), ("parent", "v"), ("parent_names", "v")]
        with self.assertRaisesRegex(pg.ImportError, "inventory drift"):
            verify.verify_postgres_inventory(FakeConnection(rows), self.root)

    def test_source_schema_mapping_checks_order_nullability_and_type_compatibility(self) -> None:
        result = verify.verify_source_schema_compatibility(self.snapshot, self.baseline)
        self.assertEqual(result, {"sourceSchemaBindings": 1, "sourceRows": 2})
        changed = json.loads(json.dumps(self.baseline))
        changed["tables"][0]["schema"]["fields"][1]["description"] = "Source field: note"
        with self.assertRaisesRegex(pg.ImportError, "order or mapping"):
            verify.verify_source_schema_compatibility(self.snapshot, changed)
        changed = json.loads(json.dumps(self.baseline))
        changed["tables"][0]["schema"]["fields"][1]["mode"] = "NULLABLE"
        with self.assertRaisesRegex(pg.ImportError, "nullability"):
            verify.verify_source_schema_compatibility(self.snapshot, changed)
        changed = json.loads(json.dumps(self.baseline))
        changed["tables"][0]["schema"]["fields"][1]["type"] = "BYTES"
        with self.assertRaisesRegex(pg.ImportError, "incompatible"):
            verify.verify_source_schema_compatibility(self.snapshot, changed)

    def test_source_schema_mapping_rejects_duplicate_and_missing_table_bindings(self) -> None:
        changed = json.loads(json.dumps(self.baseline))
        changed["tables"][0]["sourceTable"] = "not_a_source_table"
        with self.assertRaisesRegex(pg.ImportError, "sourceTable binding"):
            verify.verify_source_schema_compatibility(self.snapshot, changed)
        changed = json.loads(json.dumps(self.baseline))
        changed["tables"].append(dict(changed["tables"][0]))
        with self.assertRaisesRegex(pg.ImportError, "sourceTable binding"):
            verify.verify_source_schema_compatibility(self.snapshot, changed)

    def test_bigquery_api_metadata_success_checks_inventory_counts_and_schema_without_jobs(self) -> None:
        host = {"projectId": "demodb-dev", "location": "US"}
        fields = self.baseline["tables"][0]["schema"]["fields"]
        dataset_obj = {"datasetReference": {"projectId": "demodb-dev", "datasetId": "fixture"}, "location": "US"}
        list_obj = {"tables": [{"tableReference": {"projectId": "demodb-dev", "datasetId": "fixture", "tableId": "parent"}}]}
        table_obj = {"tableReference": {"projectId": "demodb-dev", "datasetId": "fixture", "tableId": "parent"},
                     "type": "TABLE", "numRows": "2", "schema": {"fields": fields}}
        paths: list[str] = []

        def fake_get(token: str, path: str, **kwargs: object) -> dict[str, object]:
            self.assertEqual(token, "dummy-token")
            paths.append(path)
            if path.endswith("/tables?maxResults=1000"):
                return list_obj
            if path.endswith("/tables/parent"):
                return table_obj
            return dataset_obj

        with patch.object(verify, "bq_get", side_effect=fake_get):
            result = verify.verify_bigquery_metadata("fixture", "dummy-token", host, self.baseline, self.snapshot)
        self.assertTrue(result["metadataBaselineMatch"])
        self.assertFalse(result["fullCellEqualityVerified"])
        self.assertEqual(result["queryJobsSubmitted"], 0)
        self.assertTrue(all(path.startswith("projects/") for path in paths))
        self.assertFalse(any("/jobs" in path for path in paths))

    def test_bigquery_metadata_rejects_extra_tables_count_and_schema_drift(self) -> None:
        host = {"projectId": "demodb-dev", "location": "US"}
        dataset_obj = {"datasetReference": {"projectId": "demodb-dev", "datasetId": "fixture"}, "location": "US"}
        list_obj = {"tables": [{"tableReference": {"tableId": "parent"}}]}
        table_obj = {"tableReference": {"projectId": "demodb-dev", "datasetId": "fixture", "tableId": "parent"},
                     "type": "TABLE", "numRows": "2", "schema": {"fields": self.baseline["tables"][0]["schema"]["fields"]}}
        def run(listing: dict[str, object], table: dict[str, object]) -> None:
            def fake_get(token: str, path: str, **kwargs: object) -> dict[str, object]:
                if path.endswith("/tables?maxResults=1000"):
                    return listing
                if path.endswith("/tables/parent"):
                    return table
                return dataset_obj
            with patch.object(verify, "bq_get", side_effect=fake_get):
                verify.verify_bigquery_metadata("fixture", "dummy-token", host, self.baseline, self.snapshot)
        with self.assertRaisesRegex(pg.ImportError, "inventory"):
            run({"tables": [*list_obj["tables"], {"tableReference": {"tableId": "extra"}}]}, table_obj)
        changed_count = {**table_obj, "numRows": "3"}
        with self.assertRaisesRegex(pg.ImportError, "row count"):
            run(list_obj, changed_count)
        changed_schema = {**table_obj, "schema": {"fields": []}}
        with self.assertRaisesRegex(pg.ImportError, "schema"):
            run(list_obj, changed_schema)

    def test_postgres_url_is_written_with_private_mode_and_removed_by_caller(self) -> None:
        path = verify._private_url_file("postgresql://readonly:secret@db.example/test", self.root, "fixture")
        try:
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
            self.assertEqual(path.read_text(), "postgresql://readonly:secret@db.example/test\n")
        finally:
            path.unlink()
        self.assertFalse(path.exists())

    def test_postgres_verifier_sets_read_only_before_parity_and_removes_url_file(self) -> None:
        class Result:
            def fetchone(self) -> tuple[str]:
                return ("on",)

        class Connection:
            def __init__(self) -> None:
                self.statements: list[str] = []
                self.closed = False
            def execute(self, query: str) -> Result:
                self.statements.append(query)
                return Result()
            def commit(self) -> None:
                return None
            def close(self) -> None:
                self.closed = True

        connection = Connection()
        opened: list[Path] = []
        def open_private_url(path: Path) -> Connection:
            opened.append(path)
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
            return connection
        with patch.object(verify, "_connection_from_url_file", side_effect=open_private_url), \
             patch.object(verify, "verify_postgres_inventory", return_value={"tables": 1, "views": 1}), \
             patch.object(verify, "verify_database", return_value={"id": "fixture", "tables": 1, "rows": 2}):
            result = verify.verify_postgres("postgresql://secret@example.invalid/test", self.root,
                                            "fixture", self.root)
        self.assertEqual(result["rows"], 2)
        self.assertEqual(connection.statements[0], "SET default_transaction_read_only = on")
        self.assertEqual(connection.statements[1], "SHOW default_transaction_read_only")
        self.assertTrue(connection.closed)
        self.assertFalse(opened[0].exists())

    def test_postgres_driver_errors_are_sanitized_and_secret_file_is_removed(self) -> None:
        url = "postgresql://user:private-password@db.example/test"
        with patch.object(verify, "_connection_from_url_file", side_effect=RuntimeError(url)):
            with self.assertRaises(pg.ImportError) as raised:
                verify.verify_postgres(url, self.root, "fixture", self.root)
        self.assertNotIn("private-password", str(raised.exception))
        self.assertFalse((self.root / "fixture.pg-url").exists())

    def test_checked_in_baseline_is_bound_to_hosting_config_sha(self) -> None:
        repo_root = Path(__file__).resolve().parents[2]
        _, hosted, _ = verify.load_pins(repo_root)
        self.assertEqual(len(hosted["_schemaBaseline"]["datasets"]), 6)
        self.assertEqual(sum(len(dataset["tables"]) for dataset in hosted["_schemaBaseline"]["datasets"]), 128)

    def test_workflow_is_manual_weekly_main_only_bounded_and_read_only(self) -> None:
        repo_root = Path(__file__).resolve().parents[2]
        workflow = yaml.safe_load((repo_root / ".github/workflows/verify-hosted-snapshots.yml").read_text())
        triggers = workflow.get("on", workflow.get(True, {}))
        self.assertEqual(set(triggers), {"workflow_dispatch", "schedule"})
        self.assertEqual(workflow["jobs"]["verify"]["timeout-minutes"], 30)
        self.assertEqual(workflow["jobs"]["verify"]["permissions"], {"contents": "read", "id-token": "write"})
        steps = workflow["jobs"]["verify"]["steps"]
        auth = next(step for step in steps if step.get("id") == "google-auth")
        self.assertEqual(auth["with"]["access_token_scopes"], "https://www.googleapis.com/auth/bigquery.readonly")
        self.assertEqual(auth["with"]["create_credentials_file"], False)
        self.assertEqual(auth["with"]["export_environment_variables"], False)
        verify_step = steps[-1]
        self.assertEqual(set(verify_step["env"]) - {"DEMODB_VERIFY_BQ_ACCESS_TOKEN"}, {
            f"DEMODB_PG_VERIFY_URL_{name}" for name in
            ("CHINOOK", "NORTHWIND", "PUBS", "SAKILA", "ADVENTUREWORKS", "EMPLOYEES")})
        self.assertNotIn("pull_request", triggers)
        self.assertIn("workflow_ref", " ".join(step.get("run", "") for step in steps) + " " +
                      " ".join(step.get("name", "") for step in steps) + " " +
                      " ".join(step.get("uses", "") for step in steps) + " " +
                      (repo_root / ".github/workflows/verify-hosted-snapshots.yml").read_text())

    def test_missing_hosted_credentials_fail_closed_without_echoing_secret_values(self) -> None:
        repo_root = Path(__file__).resolve().parents[2]
        with self.assertRaisesRegex(pg.ImportError, "BigQuery read access token is missing"):
            verify.verify_run(repo_root, env={})

    def test_dataset_and_stage_are_added_to_sanitized_verification_errors(self) -> None:
        entries = {dataset: {"id": dataset, "commit": "a" * 40} for dataset in verify.DATASET_IDS}
        catalogue = {"ingitdbRevisions": {dataset: "b" * 40 for dataset in verify.DATASET_IDS}}
        hosted = {"projectId": "demodb-dev", "location": "US", "datasets": [],
                  "_schemaBaseline": {"datasets": []}, "_schemaBaselineSha256": "c" * 64}
        environment = {"DEMODB_VERIFY_BQ_ACCESS_TOKEN": "bounded-test-token"}
        environment.update({f"DEMODB_PG_VERIFY_URL_{dataset.upper()}": "redacted-url"
                            for dataset in verify.DATASET_IDS})
        with patch.object(verify, "load_pins", return_value=(catalogue, hosted, entries)), \
             patch.object(verify, "materialize_provider", side_effect=pg.ImportError("source is unavailable")):
            with self.assertRaisesRegex(pg.ImportError, "chinook: provider materialization: source is unavailable"):
                verify.verify_run(Path("."), env=environment)

    def test_source_type_compatibility_is_conservative_for_exact_values(self) -> None:
        self.assertTrue(verify._field_type_compatible("DECIMAL_TEXT(76,0)", "STRING"))
        self.assertFalse(verify._field_type_compatible("DECIMAL_TEXT(76,0)", "NUMERIC"))
        self.assertTrue(verify._field_type_compatible("DECIMAL(10,2)", "NUMERIC"))
        self.assertFalse(verify._field_type_compatible("DECIMAL(40,2)", "NUMERIC"))
        self.assertTrue(verify._field_type_compatible("DECIMAL(40,2)", "BIGNUMERIC"))

    def test_bigquery_http_errors_never_include_bearer_token(self) -> None:
        token = "private-bearer-token"
        error = HTTPError("https://bigquery.googleapis.com/bigquery/v2/x", 403, "denied", {}, None)
        with patch.object(verify.urllib.request, "urlopen", side_effect=error):
            with self.assertRaises(pg.ImportError) as raised:
                verify.bq_get(token, "projects/demo/datasets/sample")
        self.assertNotIn(token, str(raised.exception))


if __name__ == "__main__":
    unittest.main()
