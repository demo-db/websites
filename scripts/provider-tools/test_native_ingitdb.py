import copy
import gzip
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
import os
import subprocess
from unittest.mock import patch
import generate as shared
import generate_ingitdb as native

class NativeProviderTest(unittest.TestCase):

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.raw = b'{"event_id":"e1","occurred_at":"2018-05-20T09:00:00Z","synthetic":true}\n'
        self.definition = dict(titles={'en': 'Baseline'}, record_file=dict(name='records.jsonl', type='[]map[string]any', format='jsonl'), primary_key=['event_id'], columns={'event_id': dict(type='string', required=True), 'occurred_at': dict(type='string', required=True), 'synthetic': dict(type='bool', required=True)})
        self.manifest = dict(id='logs', contractVersion=1, name='Logs', description='Original synthetic evidence', siteHost='logs.demodb.dev', storage=dict(engine='ingitdb', path='ingitdb'), dataFile='source-manifest.json', source=dict(repository='https://github.com/demo-db/logs', revision='a' * 40, path='source-manifest.json', license='CC0-1.0', sha256=shared.sha256(b'{}'), files={'baseline': dict(path='ingitdb/collections/baseline/records.jsonl', bytes=len(self.raw), sha256=shared.sha256(self.raw), rowCount=1)}), capabilities=dict(ovdb=dict(canonicalUrl='https://demodb.dev/logs/', serverId='https://demodb.dev/ovdb', serverDbBaseUrl='https://demodb.dev/ovdb/db/logs/', connection='https://demodb.dev/ovdb/v1/databases/logs')), generator=dict(model=dict(name='logs', moduleId='logs', version='0.1.0', address='modelspec://github.com/demo-db/logs/0.1.0'), meaning=dict(id='logs', address='meaning://github.com/demo-db/logs', name='Logs', description='Original logs', license='CC0-1.0', core=dict(address='meaning://github.com/meaninggraph/core', revision='a' * 40), concepts=[]), publisher=dict(name='DemoDB', url='https://demodb.dev', repository='https://github.com/demo-db/logs'), licences=dict(model='CC0-1.0', meaning='CC0-1.0'), ovdb=dict(query=True, recordsets=['baseline'], deployment=dict(engine='openvaultdb-go', url='https://cloud.openvaultdb.com/ovdb/db/logs', discovery='https://logs.demodb.dev/.well-known/openvaultdb'))))
        self.put('ingitdb/.ingitdb/root-collections.yaml', {'baseline': 'collections/baseline'})
        self.put('ingitdb/.ingitdb/settings.yaml', {'languages': [{'required': 'en'}]})
        self.put('source-manifest.json', b'{}')
        self.save()

    def put(self, path, value):
        p = self.root / path
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(value if isinstance(value, bytes) else shared.canonical_json(value))

    def save(self):
        self.put('manifest.json', self.manifest)
        self.put('ingitdb/collections/baseline/.collection/definition.yaml', self.definition)
        self.put('ingitdb/collections/baseline/records.jsonl', self.raw)

    def test_native_source_and_archive_have_no_parsed_snapshot(self):
        native.generate(self.root)
        contract = json.loads((self.root / 'metadata/contract.json').read_text())
        self.assertEqual(contract['schema']['tables'][0]['rows'], [])
        self.assertEqual(contract['schema']['tables'][0]['primaryKey'], [dict(column='event_id', position=1)])
        self.assertEqual((self.root / 'ingitdb/collections/baseline/records.jsonl').read_bytes(), self.raw)
        with tarfile.open(fileobj=io.BytesIO((self.root / 'artifacts/logs.ingitdb.tar.gz').read_bytes())) as archive:
            self.assertEqual(archive.extractfile('ingitdb/collections/baseline/records.jsonl').read(), self.raw)
            self.assertFalse(any((n.endswith(('.sqlite', '.db')) for n in archive.getnames())))
        first = (self.root / 'metadata/checksums.json').read_bytes()
        native.generate(self.root)
        self.assertEqual((self.root / 'metadata/checksums.json').read_bytes(), first)
        self.assertEqual(json.loads((self.root / 'model/logs.modelspec.json').read_text())['records']['baseline']['fields']['synthetic']['type'], 'bool')

    def test_invalid_source_aborts_before_outputs(self):
        for kind in ['hash', 'key', 'duplicate', 'type', 'required', 'path', 'format', 'symlink']:
            with self.subTest(kind=kind):
                with tempfile.TemporaryDirectory() as directory:
                    import shutil
                    target = Path(directory) / 'provider'
                    shutil.copytree(self.root, target)
                    m = copy.deepcopy(self.manifest)
                    definition = copy.deepcopy(self.definition)
                    raw = self.raw
                    if kind == 'hash':
                        m['source']['files']['baseline']['sha256'] = '0' * 64
                    elif kind == 'key':
                        definition['primary_key'] = []
                    elif kind == 'duplicate':
                        raw += raw
                    elif kind == 'type':
                        raw = raw.replace(b'true', b'"true"')
                    elif kind == 'required':
                        raw = b'{"event_id":"e1","synthetic":true}\n'
                    elif kind == 'path':
                        definition['record_file']['name'] = '../../../../outside.jsonl'
                    elif kind == 'format':
                        definition['record_file']['format'] = 'json'
                    if kind != 'hash':
                        m['source']['files']['baseline'].update(bytes=len(raw), sha256=shared.sha256(raw), rowCount=len(raw.splitlines()))
                    (target / 'manifest.json').write_bytes(shared.canonical_json(m))
                    (target / 'ingitdb/collections/baseline/.collection/definition.yaml').write_bytes(shared.canonical_json(definition))
                    (target / 'ingitdb/collections/baseline/records.jsonl').write_bytes(raw)
                    if kind == 'symlink':
                        path = target / 'ingitdb/collections/baseline/records.jsonl'
                        path.rename(path.with_suffix('.original'))
                        path.symlink_to(path.with_suffix('.original').name)
                    with self.assertRaises((shared.GenerationError, FileNotFoundError)):
                        native.generate(target)
                    self.assertFalse((target / 'metadata/contract.json').exists())
    def snapshot(self):
        import os
        result = {}
        for path in self.root.rglob('*'):
            name = path.relative_to(self.root).as_posix()
            if path.is_symlink(): result[name] = ('link', os.readlink(path))
            elif path.is_file(): result[name] = ('file', path.read_bytes())
            else: result[name] = ('directory',)
        return result

    def test_all_native_definitions_are_validated_without_row_dependence(self):
        for kind in ['optional-type', 'empty-type', 'null-type', 'settings-syntax', 'settings-shape', 'language', 'data-dir', 'formula', 'required-shape', 'pk-type', 'record-option']:
            with self.subTest(kind=kind):
                self.definition = dict(titles={'en': 'Baseline'}, record_file=dict(name='records.jsonl', type='[]map[string]any', format='jsonl'), primary_key=['event_id'], columns={'event_id': dict(type='string', required=True), 'occurred_at': dict(type='string', required=True), 'synthetic': dict(type='bool', required=True)})
                raw = self.raw
                if kind in ('optional-type', 'empty-type', 'null-type'):
                    self.definition['columns']['unused'] = dict(type='NOT_A_NATIVE_TYPE', required=False)
                if kind == 'empty-type': raw = b''
                if kind == 'null-type': raw = raw.replace(b'"synthetic":true', b'"synthetic":true,"unused":null')
                if kind == 'data-dir': self.definition['data_dir'] = 'not-packaged'
                if kind == 'formula': self.definition['columns']['synthetic']['formula'] = 'True'
                if kind == 'required-shape': self.definition['columns']['synthetic']['required'] = 'false'
                if kind == 'pk-type': self.definition['columns']['event_id']['type'] = 'int'
                if kind == 'record-option': self.definition['record_file']['records_base_path'] = 'other'
                self.save()
                self.put('ingitdb/collections/baseline/records.jsonl', raw)
                manifest = copy.deepcopy(self.manifest)
                manifest['source']['files']['baseline'].update(bytes=len(raw), sha256=shared.sha256(raw), rowCount=len(raw.splitlines()))
                self.put('manifest.json', manifest)
                if kind == 'settings-syntax': self.put('ingitdb/.ingitdb/settings.yaml', b'not: [valid')
                elif kind == 'settings-shape': self.put('ingitdb/.ingitdb/settings.yaml', {'languages': [], 'unsupported': True})
                elif kind == 'language': self.put('ingitdb/.ingitdb/settings.yaml', {'languages': [{'required': 'en'}, {'optional': 'en'}]})
                else: self.put('ingitdb/.ingitdb/settings.yaml', {'languages': [{'required': 'en'}]})
                before = self.snapshot()
                with self.assertRaises((shared.GenerationError, ValueError)):
                    native.generate(self.root)
                self.assertEqual(self.snapshot(), before)

    def test_all_output_aliases_refuse_before_any_tree_change(self):
        for kind in ['inside-source-link', 'external-directory', 'hardlink', 'directory-target', 'reserved-source']:
            with self.subTest(kind=kind):
                with tempfile.TemporaryDirectory() as directory:
                    import shutil
                    original = self.root
                    self.root = Path(directory) / 'provider'
                    shutil.copytree(original, self.root)
                    try:
                        source = self.root / 'ingitdb/collections/baseline/records.jsonl'
                        model = self.root / 'model/logs.modelspec.json'
                        model.parent.mkdir()
                        if kind == 'inside-source-link': model.symlink_to('../ingitdb/collections/baseline/records.jsonl')
                        elif kind == 'external-directory': (self.root / 'metadata').symlink_to(Path(directory), target_is_directory=True)
                        elif kind == 'hardlink': os.link(source, model)
                        elif kind == 'directory-target': model.mkdir()
                        elif kind == 'reserved-source':
                            manifest = copy.deepcopy(self.manifest)
                            manifest['dataFile'] = 'metadata/schema.json'
                            self.put('metadata/schema.json', b'{}')
                            self.put('manifest.json', manifest)
                        before = self.snapshot()
                        with self.assertRaises(shared.GenerationError): native.generate(self.root)
                        self.assertEqual(self.snapshot(), before)
                        self.assertEqual(source.read_bytes(), self.raw)
                    finally:
                        self.root = original

    def test_publication_io_failure_restores_previous_outputs_and_originals(self):
        native.generate(self.root)
        before = self.snapshot()
        replace = os.replace
        calls = 0
        def fail_once(source, destination):
            nonlocal calls
            calls += 1
            if calls == 4: raise OSError('publication refused')
            return replace(source, destination)
        with patch.object(native.os, 'replace', side_effect=fail_once):
            with self.assertRaises(OSError): native.generate(self.root)
        self.assertEqual(self.snapshot(), before)

    def test_native_root_and_serialized_key_refusals_preserve_tree(self):
        for kind in ['duplicate-path', 'language-order', 'unicode-id', 'wildcard', 'composite-key']:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                import shutil
                original = self.root
                self.root = Path(directory) / 'provider'
                shutil.copytree(original, self.root)
                try:
                    if kind == 'duplicate-path':
                        self.put('ingitdb/.ingitdb/root-collections.yaml', {'baseline': 'collections/baseline', 'alias': 'collections/baseline'})
                        manifest = copy.deepcopy(self.manifest)
                        manifest['source']['files']['alias'] = manifest['source']['files']['baseline']
                        self.put('manifest.json', manifest)
                    elif kind == 'language-order':
                        self.put('ingitdb/.ingitdb/settings.yaml', {'languages': [{'optional': 'fr'}, {'required': 'en'}]})
                    elif kind in ('unicode-id', 'wildcard'):
                        name = 'é' if kind == 'unicode-id' else 'baseline'
                        folder = 'collections/*' if kind == 'wildcard' else 'collections/baseline'
                        self.put('ingitdb/.ingitdb/root-collections.yaml', {name: folder})
                        manifest = copy.deepcopy(self.manifest)
                        manifest['source']['files'] = {name: manifest['source']['files']['baseline']}
                        self.put('manifest.json', manifest)
                    else:
                        definition = copy.deepcopy(self.definition)
                        definition['primary_key'] = ['event_id', 'part']
                        definition['columns']['part'] = {'type': 'string', 'required': True}
                        rows = [dict(event_id='x\x1fy', part='z', occurred_at='t', synthetic=True), dict(event_id='x', part='y\x1fz', occurred_at='t', synthetic=True)]
                        raw = ''.join(json.dumps(row) + '\n' for row in rows).encode()
                        self.put('ingitdb/collections/baseline/.collection/definition.yaml', definition)
                        self.put('ingitdb/collections/baseline/records.jsonl', raw)
                        manifest = copy.deepcopy(self.manifest)
                        manifest['source']['files']['baseline'].update(bytes=len(raw), sha256=shared.sha256(raw), rowCount=2)
                        self.put('manifest.json', manifest)
                    before = self.snapshot()
                    with self.assertRaises(shared.GenerationError): native.generate(self.root)
                    self.assertEqual(before, self.snapshot())
                finally:
                    self.root = original

    def test_actual_native_archive_reader(self):
        self.put('ingitdb/.ingitdb/settings.yaml', {'languages': [{'required': 'en'}, {'optional': 'fr'}]})
        native.generate(self.root)
        env = dict(os.environ, NATIVE_PROVIDER_ARCHIVE=str(self.root / 'artifacts/logs.ingitdb.tar.gz'))
        result = subprocess.run(['go', '-C', str(Path(__file__).parent / 'native-reader'), 'test', '-count=1', './...'], env=env, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.definition['primary_key'] = ['event_id', 'occurred_at']
        self.save()
        native.generate(self.root)
        env['NATIVE_EXPECTED_KEY'] = 'e1\x1f2018-05-20T09:00:00Z'
        result = subprocess.run(['go', '-C', str(Path(__file__).parent / 'native-reader'), 'test', '-count=1', './...'], env=env, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

if __name__ == '__main__':
    unittest.main()
