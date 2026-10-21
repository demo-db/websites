import copy
import gzip
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
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
if __name__ == '__main__':
    unittest.main()
