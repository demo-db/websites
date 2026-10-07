#!/usr/bin/env python3
"""Build deterministic, checksum-addressed research bundles from site assets."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import tempfile
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any


FORMAT = "demodb-research-snapshot/v2"
ZIP_TIME = (1980, 1, 1, 0, 0, 0)
PART_BYTES = 20 * 1024 * 1024
DATASET_ID = re.compile(r"^[a-z][a-z0-9-]{0,39}$")


class SnapshotError(RuntimeError):
    pass


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while block := stream.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def canonical_json(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n").encode("utf-8")


def safe_source_file(root: Path, relative: str) -> Path:
    candidate = (root / relative).resolve()
    if not candidate.is_relative_to(root.resolve()) or not candidate.is_file():
        raise SnapshotError(f"asset path is missing or escapes source root: {relative}")
    return candidate


def add_file(files: dict[str, tuple[Path, str]], root: Path, relative: str, archive_path: str,
             purpose: str, expected_sha: str | None = None, expected_bytes: int | None = None) -> None:
    pure = PurePosixPath(archive_path)
    if pure.is_absolute() or ".." in pure.parts or not pure.parts:
        raise SnapshotError(f"invalid bundle path: {archive_path}")
    source = safe_source_file(root, relative)
    digest = sha256_file(source)
    size = source.stat().st_size
    if expected_sha and digest != expected_sha:
        raise SnapshotError(f"{relative}: SHA-256 differs from pinned build metadata")
    if expected_bytes is not None and size != expected_bytes:
        raise SnapshotError(f"{relative}: byte size differs from pinned build metadata")
    if archive_path in files:
        raise SnapshotError(f"duplicate bundle path: {archive_path}")
    files[archive_path] = (source, purpose)


def dataset_files(db: dict[str, Any], asset_root: Path) -> tuple[dict[str, tuple[Path, str]], dict[str, Any]]:
    dataset_id = db.get("id")
    if not isinstance(dataset_id, str) or not DATASET_ID.fullmatch(dataset_id):
        raise SnapshotError("database index contains an invalid dataset ID")
    root = asset_root / dataset_id
    files: dict[str, tuple[Path, str]] = {}
    schema_sha = db.get("schemaSha256")
    add_file(files, root, "metadata/schema.json", "metadata/schema.json", "typed schema", schema_sha)

    for export in db.get("exports", []):
        chunks = export.get("chunks") or []
        if chunks:
            for chunk in chunks:
                asset_path = chunk.get("assetPath")
                add_file(files, root, f"data/{asset_path}", f"data/{asset_path}",
                         f"provider export chunk for {export.get('path')}", chunk.get("sha256"), chunk.get("bytes"))
        else:
            asset_path = export.get("assetPath")
            add_file(files, root, f"data/{asset_path}", f"data/{asset_path}",
                     f"provider {export.get('format', 'data')} export", export.get("sha256"), export.get("bytes"))

    model_root = root / "model"
    if model_root.is_dir():
        for path in sorted(model_root.rglob("*")):
            if path.is_file():
                relative = path.relative_to(root).as_posix()
                add_file(files, root, relative, relative, "provider model or meaning metadata")

    examples = db.get("queries", [])
    query_bytes = canonical_json(examples)
    temp_query_path = root / ".research-example-queries.json"
    temp_query_path.write_bytes(query_bytes)
    files["queries/examples.json"] = (temp_query_path, "provider-authored example queries")

    entries = []
    for archive_path, (source, purpose) in sorted(files.items()):
        entries.append({"path": archive_path, "bytes": source.stat().st_size,
                        "sha256": sha256_file(source), "purpose": purpose})
    provenance = db.get("provenance") or {}
    licences = db.get("licences") or {}
    manifest = {
        "format": FORMAT,
        "dataset": {"id": dataset_id, "name": db.get("name"), "canonicalUrl": db.get("canonicalUrl")},
        "source": {"repository": db.get("sourceRepository"), "commit": db.get("sourceCommit"),
                   "revision": (db.get("source") or {}).get("revision"),
                   "fixtureSha256": provenance.get("sha256"),
                   "provenance": provenance},
        "licences": licences,
        "schema": {"path": "metadata/schema.json", "sha256": schema_sha},
        "queries": {"path": "queries/examples.json", "count": len(examples)},
        "files": entries,
        "constraints": {"foreignKeysIncluded": True, "enforcedByBundle": False},
    }
    return files, manifest


def write_bundle(db: dict[str, Any], asset_root: Path, output_root: Path) -> dict[str, Any]:
    files, manifest = dataset_files(db, asset_root)
    dataset_id = db["id"]
    output_root.mkdir(parents=True, exist_ok=True)
    for stale_part in output_root.glob(f"{dataset_id}.zip.part-*"):
        stale_part.unlink()
    manifest_path = output_root / f"{dataset_id}.manifest.json"
    manifest_bytes = json.dumps(manifest, indent=2, ensure_ascii=False, sort_keys=True, allow_nan=False).encode("utf-8") + b"\n"
    archive_path = output_root / f".{dataset_id}.zip.tmp"
    try:
        with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for archive_name, (source, _purpose) in sorted(files.items()):
                info = zipfile.ZipInfo(archive_name, ZIP_TIME)
                info.compress_type = zipfile.ZIP_DEFLATED
                info.create_system = 3
                info.external_attr = 0o100644 << 16
                archive.writestr(info, source.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
            info = zipfile.ZipInfo("research-manifest.json", ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            archive.writestr(info, manifest_bytes, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
        archive_sha = sha256_file(archive_path)
        archive_bytes = archive_path.stat().st_size
        parts = []
        with archive_path.open("rb") as source:
            number = 1
            while block := source.read(PART_BYTES):
                part_name = f"{dataset_id}.zip.part-{number:04d}"
                part_path = output_root / part_name
                part_path.write_bytes(block)
                parts.append({"file": part_name, "bytes": len(block), "sha256": sha256_bytes(block)})
                number += 1
        sidecar_manifest = dict(manifest)
        sidecar_manifest["archive"] = {"file": f"{dataset_id}.zip", "bytes": archive_bytes,
                                       "sha256": archive_sha, "partBytes": PART_BYTES, "parts": parts,
                                       "assembly": "concatenate the listed parts in order to recreate the ZIP"}
        sidecar_bytes = json.dumps(sidecar_manifest, indent=2, ensure_ascii=False,
                                   sort_keys=True, allow_nan=False).encode("utf-8") + b"\n"
        manifest_path.write_bytes(sidecar_bytes)
        (output_root / f"{dataset_id}.zip.sha256").write_text(
            f"{archive_sha}  {dataset_id}.zip\n", encoding="ascii")
    finally:
        archive_path.unlink(missing_ok=True)
        temp_query = asset_root / dataset_id / ".research-example-queries.json"
        temp_query.unlink(missing_ok=True)
    return {"datasetId": dataset_id, "archive": f"{dataset_id}.zip",
            "archiveBytes": archive_bytes, "archiveSha256": archive_sha,
            "parts": parts, "manifest": manifest_path.name, "files": len(files)}


def build(index_path: Path, asset_root: Path, output_root: Path) -> list[dict[str, Any]]:
    try:
        index = json.loads(index_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SnapshotError(f"cannot read provider index: {exc}") from exc
    databases = index.get("databases")
    if not isinstance(databases, list) or not databases:
        raise SnapshotError("provider index contains no databases")
    reports = [write_bundle(db, asset_root, output_root) for db in databases]
    return reports


def verify(path: Path, manifest_path: Path | None = None) -> dict[str, Any]:
    """Verify a split archive, or a locally reassembled ZIP and its manifest."""
    if path.name.endswith(".manifest.json"):
        manifest_path = path
    else:
        manifest_path = manifest_path or path.with_suffix(".manifest.json")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("format") != FORMAT:
        raise SnapshotError("unsupported research snapshot manifest")
    dataset = manifest.get("dataset")
    if not isinstance(dataset, dict) or not isinstance(dataset.get("id"), str) or not DATASET_ID.fullmatch(dataset["id"]):
        raise SnapshotError("manifest contains an invalid dataset ID")
    archive = manifest.get("archive")
    if not isinstance(archive, dict) or not isinstance(archive.get("parts"), list) or not archive["parts"]:
        raise SnapshotError("manifest is missing split archive metadata")
    checksum_path = manifest_path.parent / f"{dataset['id']}.zip.sha256"
    expected = checksum_path.read_text(encoding="ascii").split()[0]
    with tempfile.NamedTemporaryFile(prefix="demodb-snapshot-", suffix=".zip", dir=manifest_path.parent, delete=False) as target:
        assembled_path = Path(target.name)
        digest = hashlib.sha256()
        total_bytes = 0
        for part in archive["parts"]:
            part_path = safe_source_file(manifest_path.parent, part["file"])
            if part_path.stat().st_size != part.get("bytes") or sha256_file(part_path) != part.get("sha256"):
                assembled_path.unlink(missing_ok=True)
                raise SnapshotError(f"archive part checksum differs: {part['file']}")
            with part_path.open("rb") as stream:
                while block := stream.read(1024 * 1024):
                    target.write(block)
                    digest.update(block)
                    total_bytes += len(block)
    try:
        if total_bytes != archive.get("bytes") or digest.hexdigest() != archive.get("sha256") or digest.hexdigest() != expected:
            raise SnapshotError("archive SHA-256 or byte size differs from sidecar")
        with zipfile.ZipFile(assembled_path) as zip_archive:
            names = set(zip_archive.namelist())
            if len(names) != len(zip_archive.namelist()) or "research-manifest.json" not in names:
                raise SnapshotError("archive has duplicate entries or no embedded manifest")
            embedded = json.loads(zip_archive.read("research-manifest.json"))
            embedded_manifest = {key: value for key, value in manifest.items() if key != "archive"}
            if embedded != embedded_manifest:
                raise SnapshotError("embedded manifest differs from sidecar contents")
            for entry in manifest.get("files", []):
                item_path = entry.get("path")
                if item_path not in names:
                    raise SnapshotError(f"archive is missing {item_path}")
                content = zip_archive.read(item_path)
                if len(content) != entry.get("bytes") or sha256_bytes(content) != entry.get("sha256"):
                    raise SnapshotError(f"archive file checksum differs: {item_path}")
    finally:
        assembled_path.unlink(missing_ok=True)
    return {"format": "demodb-research-snapshot-verification/v2", "status": "verified",
            "archive": archive.get("file"), "archiveSha256": digest.hexdigest(),
            "filesChecked": len(manifest.get("files", []))}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    build_parser = sub.add_parser("build")
    build_parser.add_argument("--index", required=True, type=Path)
    build_parser.add_argument("--assets", required=True, type=Path)
    build_parser.add_argument("--output", required=True, type=Path)
    verify_parser = sub.add_parser("verify")
    verify_parser.add_argument("archive", type=Path)
    verify_parser.add_argument("--manifest", type=Path)
    args = parser.parse_args(argv)
    try:
        if args.command == "build":
            result: Any = {"format": "demodb-research-snapshot-build/v1",
                           "datasets": build(args.index, args.assets, args.output)}
        else:
            result = verify(args.archive, args.manifest)
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return 0
    except (SnapshotError, OSError, KeyError, TypeError, ValueError, zipfile.BadZipFile) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
