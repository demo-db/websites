"""Project validated native JSONL inGitDB sources into the existing provider contract.

The JSON-subset YAML collection definitions remain authoritative. Original files
are only read/copied into a reproducible source archive, never a row database.
"""
import argparse
import gzip
import io
import json
import tarfile
from pathlib import Path
import generate as shared

def decode(body):

    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise shared.GenerationError('duplicate native JSON member')
            result[key] = value
        return result
    return json.loads(body, object_pairs_hook=unique)

def read(root, name):
    lexical = root / name
    path = shared.safe_relative(root, name, 'native input')
    for candidate in [lexical, *lexical.parents]:
        if candidate == root.parent:
            break
        if candidate.is_symlink():
            raise shared.GenerationError('native inputs cannot be symlinks')
    body = path.read_bytes()
    if len(body) > shared.MAX_STATIC_EXPORT_BYTES:
        raise shared.GenerationError('native input exceeds limit')
    return body

def generate(root):
    root = root.resolve()
    manifest = decode(read(root, 'manifest.json'))
    dbid = manifest['id']
    if not shared.DATABASE_ID_PATTERN.fullmatch(dbid) or manifest.get('storage') != {'engine': 'ingitdb', 'path': 'ingitdb'} or manifest['siteHost'] != dbid + '.demodb.dev':
        raise shared.GenerationError('invalid native provider identity/storage')
    roots = decode(read(root, 'ingitdb/.ingitdb/root-collections.yaml'))
    if not roots or len(roots) > 100 or set(roots) != set(manifest['source']['files']):
        raise shared.GenerationError('native source inventory differs from collections')
    inputs = {'ingitdb/.ingitdb/root-collections.yaml': read(root, 'ingitdb/.ingitdb/root-collections.yaml'), 'ingitdb/.ingitdb/settings.yaml': read(root, 'ingitdb/.ingitdb/settings.yaml')}
    tables, exports = ([], [])
    for name, folder in sorted(roots.items()):
        if not name.isalnum() or not isinstance(folder, str):
            raise shared.GenerationError('unsupported collection identity')
        definition_path = 'ingitdb/' + folder + '/.collection/definition.yaml'
        definition_bytes = read(root, definition_path)
        definition = decode(definition_bytes)
        rf = definition['record_file']
        if rf.get('type') != '[]map[string]any' or rf.get('format') != 'jsonl' or definition.get('source_schema', {}).get('key_mode') or (not definition.get('primary_key')):
            raise shared.GenerationError('native JSONL requires declared source primary key')
        path = 'ingitdb/' + folder + '/' + rf['name']
        body = read(root, path)
        pin = manifest['source']['files'][name]
        if pin['path'] != path or pin['bytes'] != len(body) or pin['sha256'] != shared.sha256(body):
            raise shared.GenerationError('native file differs from pin')
        rows = [decode(line) for line in body.splitlines()]
        if len(rows) != pin['rowCount'] or len(rows) > 100000:
            raise shared.GenerationError('native row count differs')
        pk = definition['primary_key']
        seen = set()
        if len(set(pk)) != len(pk) or any((field not in definition['columns'] or not definition['columns'][field].get('required') for field in pk)):
            raise shared.GenerationError('primary key must name distinct required columns')
        for row in rows:
            if not isinstance(row, dict) or '$ID' in row or set(row) - set(definition['columns']):
                raise shared.GenerationError('unsupported native record shape')
            key = tuple((row.get(field) for field in pk))
            if any((not isinstance(v, str) or not v.strip() for v in key)) or key in seen:
                raise shared.GenerationError('missing/duplicate native key')
            seen.add(key)
            for field, col in definition['columns'].items():
                value = row.get(field)
                if value is None:
                    if col.get('required'):
                        raise shared.GenerationError('required native field missing')
                    continue
                if col['type'] == 'string':
                    valid = isinstance(value, str)
                elif col['type'] == 'int':
                    valid = isinstance(value, int) and (not isinstance(value, bool))
                elif col['type'] == 'bool':
                    valid = isinstance(value, bool)
                else:
                    raise shared.GenerationError('unsupported declared native type')
                if not valid:
                    raise shared.GenerationError('native field type mismatch')
        columns = [dict(name=field, type=col['type'], nullable=not col.get('required', False), primaryKey=field in pk, primaryKeyPosition=pk.index(field) + 1 if field in pk else None, defaultValue=None) for field, col in definition['columns'].items()]
        tables.append(dict(name=name, kind='table', description=definition['titles']['en'], columns=columns, primaryKey=[dict(column=field, position=i + 1) for i, field in enumerate(pk)], foreignKeys=[], uniqueKeys=[], uniqueIndexes=[], rowCount=len(rows), rows=[], modelEntity=name))
        inputs[definition_path] = definition_bytes
        inputs[path] = body
        exports.append(dict(table=name, format='jsonl', path=path, bytes=len(body)))
    source_manifest = read(root, manifest['dataFile'])
    if shared.sha256(source_manifest) != manifest['source']['sha256']:
        raise shared.GenerationError('original source manifest differs')
    schema = dict(contractVersion=1, database=dict(id=dbid, name=manifest['name']), source=manifest['source'], tables=tables, sourceViews=[], preview='native-api-only')
    config = manifest['generator']
    model, model_json, model_hcl, meaning = shared.model_files(dbid, config, tables)
    schema_bytes = Path(shared.__file__).resolve().parents[2].joinpath('schemas', shared.DATABASE_SCHEMA_NAME).read_bytes()
    if shared.sha256(schema_bytes) != shared.DATABASE_SCHEMA_SHA256:
        raise shared.GenerationError('public descriptor schema differs')
    ovdb, descriptor = shared.ovdb_files(root, manifest, config, schema, shared.sha256(source_manifest), schema_bytes, model)
    tar = io.BytesIO()
    with tarfile.open(fileobj=tar, mode='w', format=tarfile.USTAR_FORMAT) as archive:
        for path, body in sorted(inputs.items()):
            entry = tarfile.TarInfo(path)
            entry.size = len(body)
            entry.mode = 292
            entry.mtime = 0
            archive.addfile(entry, io.BytesIO(body))
    archive_bytes = bytearray(gzip.compress(tar.getvalue(), mtime=0))
    archive_bytes[9] = 255
    archive_bytes = bytes(archive_bytes)
    outputs = {f'artifacts/{dbid}.ingitdb.tar.gz': archive_bytes, f'model/{dbid}.modelspec.json': model_json, f'model/{dbid}.modelspec.hcl': model_hcl, f'model/{dbid}.meaning.yaml': meaning, 'metadata/schema.json': shared.canonical_json(schema), 'ovdb.yaml': ovdb, 'ovdb-database.json': descriptor, 'schemas/' + shared.DATABASE_SCHEMA_NAME: schema_bytes}
    exports.append(dict(table=None, format='metadata', path=manifest['dataFile'], bytes=len(source_manifest)))
    exports.append(dict(table=None, format='ingitdb', path=f'artifacts/{dbid}.ingitdb.tar.gz', bytes=len(archive_bytes)))
    outputs['metadata/contract.json'] = shared.canonical_json(dict(contractVersion=1, manifest=manifest, schema=schema, exports=exports))
    checksum_inputs = {**outputs, **inputs, 'manifest.json': read(root, 'manifest.json'), manifest['dataFile']: source_manifest}
    outputs['metadata/checksums.json'] = shared.canonical_json(dict(contractVersion=1, files={path: dict(sha256=shared.sha256(body), bytes=len(body)) for path, body in sorted(checksum_inputs.items())}))
    for path, body in outputs.items():
        destination = shared.safe_relative(root, path, 'native output')
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(body)
    print(f'Generated native inGitDB provider {dbid}: {len(tables)} original-file collections; no parsed-row snapshots')
if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, required=True)
    generate(parser.parse_args().root)
