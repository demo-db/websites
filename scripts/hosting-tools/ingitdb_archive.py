#!/usr/bin/env python3
"""Package a provider's pinned inGitDB edition as one deterministic ZIP download.

The provider repository already holds the native inGitDB directory (``ingitdb/``), written by
DataTug's DALgo -> inGitDB export and checked by ``validate_datatug_exports.py``. This tool does not
regenerate it: it takes the directory at the pinned revision (a GitHub source tarball, or a local
directory for development), refuses it unless its export manifest names the same dataset and the same
SQLite fixture SHA-256 as the pinned provider contract, and writes the files unchanged into a ZIP whose
entry order, timestamps and permissions are normalised.

``contentSha256`` (a digest of the sorted ``<sha256>  <path>`` lines) identifies the files independent of
the ZIP encoder, so it is stable across zlib builds; the lock in ``config/derived-exports.lock.json`` pins
it. Standard library only.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import sys
import tarfile
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any, Mapping

DATASET_ID = re.compile(r"^[a-z][a-z0-9-]{0,39}$")
REVISION = re.compile(r"^[0-9a-f]{40}$")
HEX64 = re.compile(r"^[0-9a-f]{64}$")
ZIP_TIME = (1980, 1, 1, 0, 0, 0)
MAX_ARCHIVE_BYTES = 25 * 1024 * 1024


class ArchiveError(ValueError):
    """Raised when the inGitDB edition cannot be packaged safely."""


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _safe(path: str) -> str:
    pure = PurePosixPath(path)
    if pure.is_absolute() or ".." in pure.parts or not pure.parts or "\\" in path:
        raise ArchiveError(f"unsafe path in the inGitDB edition: {path!r}")
    return pure.as_posix()


def files_from_tarball(data: bytes, repository_slug: str, revision: str) -> dict[str, bytes]:
    """Return ``ingitdb/`` files (relative to it) from a GitHub source tarball of ``revision``."""
    prefix_name = f"{repository_slug.split('/')[-1]}-{revision}"
    found: dict[str, bytes] = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        for member in archive:
            if not member.isfile():
                if member.issym() or member.islnk():
                    raise ArchiveError(f"link in the tarball: {member.name}")
                continue
            name = _safe(member.name)
            parts = name.split("/")
            if parts[0] != prefix_name:
                raise ArchiveError(f"tarball entry {name!r} is outside {prefix_name}/")
            if len(parts) > 2 and parts[1] == "ingitdb":
                extracted = archive.extractfile(member)
                assert extracted is not None
                found["/".join(parts[2:])] = extracted.read()
    return found


def files_from_directory(directory: Path) -> dict[str, bytes]:
    root = directory.resolve()
    if not root.is_dir():
        raise ArchiveError(f"no inGitDB directory at {directory}")
    found: dict[str, bytes] = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ArchiveError(f"symbolic link in the inGitDB edition: {path}")
        if path.is_file():
            found[path.relative_to(root).as_posix()] = path.read_bytes()
    return found


def verify_edition(files: Mapping[str, bytes], dataset_id: str, fixture_sha256: str) -> dict[str, Any]:
    if not files:
        raise ArchiveError(f"{dataset_id}: the pinned revision has no ingitdb/ directory")
    raw = files.get("export-manifest.json")
    if raw is None:
        raise ArchiveError(f"{dataset_id}: ingitdb/export-manifest.json is missing")
    manifest = json.loads(raw)
    if manifest.get("datasetId") != dataset_id:
        raise ArchiveError(f"{dataset_id}: export manifest is for {manifest.get('datasetId')!r}")
    if (manifest.get("source") or {}).get("fixtureSha256") != fixture_sha256:
        raise ArchiveError(f"{dataset_id}: the inGitDB edition was exported from a different SQLite fixture than the pinned one")
    parity = manifest.get("nativeParity") or {}
    if parity.get("metadataAndDataMatch") is not True or parity.get("errorCount") != 0 or parity.get("dataChecked") is not True:
        raise ArchiveError(f"{dataset_id}: the export manifest does not record a clean data parity check")
    return manifest


def content_sha256(files: Mapping[str, bytes]) -> str:
    lines = "".join(f"{sha256(files[name])}  {name}\n" for name in sorted(files))
    return sha256(lines.encode("utf-8"))


def write_zip(files: Mapping[str, bytes], dataset_id: str) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name in sorted(files):
            info = zipfile.ZipInfo(f"{dataset_id}-ingitdb/{_safe(name)}", ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            info.create_system = 3
            archive.writestr(info, files[name], compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    return buffer.getvalue()


def build(dataset_id: str, fixture_sha256: str, *, repository: str | None, revision: str | None,
          directory: Path | None, tarball: Path | None = None) -> tuple[bytes, dict[str, Any]]:
    if not DATASET_ID.fullmatch(dataset_id):
        raise ArchiveError("invalid dataset id")
    if not HEX64.fullmatch(fixture_sha256):
        raise ArchiveError("fixture SHA-256 must be 64 lowercase hex characters")
    if directory is not None:
        files = files_from_directory(directory)
        origin = {"directory": True}
    else:
        if not repository or not revision or not REVISION.fullmatch(revision):
            raise ArchiveError("a repository and a full 40-character revision are required")
        match = re.fullmatch(r"https://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)", repository)
        if not match:
            raise ArchiveError("repository must be an https://github.com/<owner>/<name> URL")
        slug = match.group(1)
        if tarball is not None:
            data = tarball.read_bytes()
        else:
            url = f"https://codeload.github.com/{slug}/tar.gz/{revision}"
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "DemoDB-ingitdb-archive/1"}), timeout=300) as response:
                data = response.read()
        files = files_from_tarball(data, slug, revision)
        origin = {"repository": repository, "revision": revision}
    manifest = verify_edition(files, dataset_id, fixture_sha256)
    archive = write_zip(files, dataset_id)
    report = {
        "format": "demodb-ingitdb-archive/v1", "datasetId": dataset_id, "fileCount": len(files),
        "rowCount": manifest.get("rowCount"), "recordFormat": manifest.get("recordFormat"),
        "generatorVersion": manifest.get("generatorVersion"), "contentSha256": content_sha256(files),
        "rootDirectory": f"{dataset_id}-ingitdb/", "bytes": len(archive), "sha256": sha256(archive), **origin,
    }
    return archive, report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("dataset_id")
    parser.add_argument("--fixture-sha256", required=True, help="decoded SQLite SHA-256 of the pinned provider contract")
    parser.add_argument("--repository", help="provider repository URL (https://github.com/<owner>/<name>)")
    parser.add_argument("--revision", help="full commit SHA that holds the ingitdb/ directory")
    parser.add_argument("--directory", type=Path, help="local ingitdb directory (development only)")
    parser.add_argument("--tarball", type=Path, help="local copy of the revision's source tarball (tests)")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        archive, report = build(args.dataset_id, args.fixture_sha256, repository=args.repository, revision=args.revision,
                                directory=args.directory, tarball=args.tarball)
    except (ArchiveError, OSError, tarfile.TarError, json.JSONDecodeError) as error:
        print(f"ingitdb_archive: {error}", file=sys.stderr)
        return 1
    if len(archive) > MAX_ARCHIVE_BYTES:
        print(f"ingitdb_archive: {args.dataset_id} archive is {len(archive)} bytes, above the {MAX_ARCHIVE_BYTES}-byte static asset limit", file=sys.stderr)
        return 2
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(archive)
    print(json.dumps(report, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
