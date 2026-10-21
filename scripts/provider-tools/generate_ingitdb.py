"""Project validated native JSONL inGitDB sources into the existing provider contract.

The JSON-subset YAML collection definitions remain authoritative. Original files
are only read/copied into a reproducible source archive, never a row database.
"""
import argparse
import gzip
import io
import json
import tarfile
import os
import re
import shutil
import tempfile
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

def checked_path(root, name):
    if not isinstance(name, str) or not name or name.startswith('/') or '\\' in name or any(part in ('', '.', '..') for part in name.split('/')):
        raise shared.GenerationError('native path must be canonical and relative')
    path = root / name
    for candidate in [path, *path.parents]:
        if candidate == root.parent:
            break
        if candidate.is_symlink():
            raise shared.GenerationError('native paths cannot be symlinks')
    shared.safe_relative(root, name, 'native path')
    return path


def read(root, name):
    path = checked_path(root, name)
    if not path.is_file():
        raise shared.GenerationError('native input must be a regular file')
    body = path.read_bytes()
    if len(body) > shared.MAX_STATIC_EXPORT_BYTES:
        raise shared.GenerationError('native input exceeds limit')
    return body


def object_fields(value, allowed, required, label):
    if not isinstance(value, dict) or set(value) - set(allowed) or not set(required) <= set(value):
        raise shared.GenerationError('unsupported ' + label + ' shape')


def settings_valid(settings):
    object_fields(settings, ['languages'], ['languages'], 'native settings')
    languages = settings['languages']
    if not isinstance(languages, list) or not languages or len(languages) > 100:
        raise shared.GenerationError('native languages must be a bounded list')
    seen = set()
    optional_seen = False
    for item in languages:
        if not isinstance(item, dict) or len(item) != 1 or next(iter(item)) not in ('required', 'optional'):
            raise shared.GenerationError('unsupported native language')
        if 'required' in item and optional_seen:
            raise shared.GenerationError('required languages must precede optional languages')
        optional_seen = optional_seen or 'optional' in item
        code = next(iter(item.values()))
        if not isinstance(code, str) or not re.fullmatch(r'[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*', code) or code in seen:
            raise shared.GenerationError('invalid native language')
        seen.add(code)


def definition_valid(definition):
    object_fields(definition, ['titles', 'record_file', 'primary_key', 'columns', 'columns_order'], ['titles', 'record_file', 'primary_key', 'columns'], 'native collection')
    titles = definition['titles']
    if not isinstance(titles, dict) or not isinstance(titles.get('en'), str) or not titles['en'].strip() or any(not isinstance(k, str) or not isinstance(v, str) or not v.strip() for k, v in titles.items()):
        raise shared.GenerationError('invalid native titles')
    rf = definition['record_file']
    object_fields(rf, ['name', 'type', 'format'], ['name', 'type', 'format'], 'native record file')
    if not isinstance(rf['name'], str) or '/' in rf['name'] or rf['name'] in ('', '.', '..') or rf['type'] != '[]map[string]any' or rf['format'] != 'jsonl':
        raise shared.GenerationError('unsupported native JSONL record file')
    columns = definition['columns']
    if not isinstance(columns, dict) or not columns or len(columns) > 256:
        raise shared.GenerationError('native columns must be bounded')
    for field, column in columns.items():
        if not isinstance(field, str) or not field or field == '$ID':
            raise shared.GenerationError('invalid native field')
        object_fields(column, ['type', 'required', 'min_length'], ['type'], 'native column')
        if column['type'] not in ('string', 'int', 'bool') or ('required' in column and not isinstance(column['required'], bool)):
            raise shared.GenerationError('unsupported declared native type or requirement')
        if 'min_length' in column and (column['type'] != 'string' or type(column['min_length']) is not int or column['min_length'] < 0):
            raise shared.GenerationError('unsupported native string constraint')
    order = definition.get('columns_order', list(columns))
    if not isinstance(order, list) or any(not isinstance(v, str) for v in order) or len(order) != len(set(order)) or set(order) != set(columns):
        raise shared.GenerationError('native column order must name every field once')
    pk = definition['primary_key']
    if not isinstance(pk, list) or not pk or any(not isinstance(v, str) for v in pk) or len(pk) != len(set(pk)) or any(v not in columns or columns[v]['type'] != 'string' or columns[v].get('required') is not True for v in pk):
        raise shared.GenerationError('primary key must name distinct required string columns')


def publish(root, outputs, inputs):
    # Validate the COMPLETE set before creating even a staging directory.
    names = set(outputs)
    input_names = set(inputs)
    input_nodes = {(os.stat(checked_path(root, name)).st_dev, os.stat(checked_path(root, name)).st_ino) for name in input_names}
    def preflight():
        nodes = set()
        for name, body in outputs.items():
            path = checked_path(root, name)
            if len(body) > shared.MAX_STATIC_EXPORT_BYTES or name in input_names or any(name.startswith(v + '/') or v.startswith(name + '/') for v in names | input_names if v != name):
                raise shared.GenerationError('native output collides with input/output')
            if path.exists():
                if not path.is_file():
                    raise shared.GenerationError('native output is not a regular file')
                info = path.stat(); identity = (info.st_dev, info.st_ino)
                if identity in input_nodes or identity in nodes or info.st_nlink != 1:
                    raise shared.GenerationError('native output has a file alias')
                nodes.add(identity)
            for parent in path.parents:
                if parent == root:
                    break
                if parent.exists() and not parent.is_dir():
                    raise shared.GenerationError('native output parent is not a directory')
    preflight()
    stage = Path(tempfile.mkdtemp(prefix='.native-provider-', dir=root))
    changed, created_dirs = [], []
    keep_backup = False
    try:
        for name, body in outputs.items():
            path = stage / 'new' / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(body)
        preflight()
        for name in outputs:
            destination = root / name
            for directory in reversed(destination.parents):
                if directory == root or not directory.is_relative_to(root):
                    continue
                if not directory.exists():
                    directory.mkdir(); created_dirs.append(directory)
            backup = stage / 'old' / name
            existed = destination.exists()
            if existed:
                backup.parent.mkdir(parents=True, exist_ok=True)
                os.replace(destination, backup)
            changed.append((destination, backup, existed))
            os.replace(stage / 'new' / name, destination)
    except BaseException:
        try:
            for destination, backup, existed in reversed(changed):
                if existed:
                    os.replace(backup, destination)
                elif destination.exists():
                    destination.unlink()
            for directory in reversed(created_dirs):
                directory.rmdir()
        except OSError as error:
            keep_backup = True
            raise shared.GenerationError('publication rollback failed; backup retained at ' + str(stage)) from error
        raise
    finally:
        if not keep_backup:
            shutil.rmtree(stage)

def generate(root):
    root = root.resolve()
    manifest = decode(read(root, 'manifest.json'))
    dbid = manifest['id']
    if not shared.DATABASE_ID_PATTERN.fullmatch(dbid) or manifest.get('storage') != {'engine': 'ingitdb', 'path': 'ingitdb'} or manifest['siteHost'] != dbid + '.demodb.dev':
        raise shared.GenerationError('invalid native provider identity/storage')
    settings_valid(decode(read(root, 'ingitdb/.ingitdb/settings.yaml')))
    roots = decode(read(root, 'ingitdb/.ingitdb/root-collections.yaml'))
    if not isinstance(roots, dict):
        raise shared.GenerationError('native root map must be an object')
    if not roots or len(roots) > 100 or set(roots) != set(manifest['source']['files']):
        raise shared.GenerationError('native source inventory differs from collections')
    if any(not isinstance(folder, str) or '*' in folder for folder in roots.values()) or len(set(roots.values())) != len(roots):
        raise shared.GenerationError('native root paths must be distinct and without wildcards')
    inputs = {'ingitdb/.ingitdb/root-collections.yaml': read(root, 'ingitdb/.ingitdb/root-collections.yaml'), 'ingitdb/.ingitdb/settings.yaml': read(root, 'ingitdb/.ingitdb/settings.yaml')}
    tables, exports = ([], [])
    for name, folder in sorted(roots.items()):
        if not re.fullmatch(r'[A-Za-z0-9]+', name) or not isinstance(folder, str):
            raise shared.GenerationError('unsupported collection identity')
        definition_path = 'ingitdb/' + folder + '/.collection/definition.yaml'
        definition_bytes = read(root, definition_path)
        definition = decode(definition_bytes)
        definition_valid(definition)
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
            if any(not isinstance(v, str) or not v.strip() for v in key):
                raise shared.GenerationError('missing native key')
            # Native ResolveListRecordKey joins composite values with U+001F.
            # Refuse ambiguous components rather than rewrite original bytes.
            if len(pk) > 1 and any('\x1f' in value for value in key):
                raise shared.GenerationError('ambiguous native composite key component')
            native_key = '\x1f'.join(key)
            if native_key in seen:
                raise shared.GenerationError('duplicate serialized native key')
            seen.add(native_key)
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
                if isinstance(value, str) and len(value) < col.get('min_length', 0):
                    raise shared.GenerationError('native string is too short')
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
    publish(root, outputs, {**inputs, 'manifest.json': checksum_inputs['manifest.json'], manifest['dataFile']: source_manifest})
    print(f'Generated native inGitDB provider {dbid}: {len(tables)} original-file collections; no parsed-row snapshots')
if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, required=True)
    generate(parser.parse_args().root)
