"""The generated YAML must load in a strict YAML 1.1 reader (PyYAML), not only in the YAML 1.2 parser CI's node tests use."""
import json
import pathlib
import shutil
import subprocess
import unittest

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[2]

SAMPLE = r"""
import { yamlDocument } from './scripts/derived-exports.mjs';
const c = String.fromCharCode;
const text = [0x00, 0x07, 0x09, 0x0a, 0x1f, 0x7f, 0x80, 0x85, 0x9f, 0xa0, 0x2028, 0x2029, 0xfeff, 0xfffd, 0xfffe, 0xffff].map((code) => c(code)).join('|') + ' \u{1F600} é';
const rows = [{ 'Order Details': 'x: y', n: 1, f: 1.5, b: true, z: null, s: text, y: 'yes', d: '2016-07-04', e: '', t: 'null', k: '- dash', big: 7 }];
process.stdout.write(yamlDocument([{ name: 'a.b', json: Buffer.from(JSON.stringify(rows)) }, { name: 'empty', json: Buffer.from('[]') }]));
"""


@unittest.skipUnless(shutil.which("node"), "node is needed to run the generator")
class GeneratedYamlTest(unittest.TestCase):
    def test_strict_yaml_1_1_reader_reads_the_same_values(self):
        text = subprocess.run(["node", "--input-type=module", "-e", SAMPLE], cwd=ROOT, check=True, capture_output=True).stdout.decode("utf-8")
        for loader in filter(None, (yaml.SafeLoader, getattr(yaml, "CSafeLoader", None))):
            with self.subTest(loader=loader.__name__):
                loaded = yaml.load(text, Loader=loader)
                row = loaded["a.b"][0]
                self.assertEqual(loaded["empty"], [])
                self.assertEqual(row["Order Details"], "x: y")
                self.assertEqual((row["n"], row["f"], row["b"], row["z"]), (1, 1.5, True, None))
                self.assertEqual((row["y"], row["d"], row["e"], row["t"], row["k"]), ("yes", "2016-07-04", "", "null", "- dash"))
                self.assertEqual(row["big"], 7)
                expected = "|".join(chr(code) for code in (0x00, 0x07, 0x09, 0x0A, 0x1F, 0x7F, 0x80, 0x85, 0x9F, 0xA0, 0x2028, 0x2029, 0xFEFF, 0xFFFD, 0xFFFE, 0xFFFF)) + " \U0001F600 é"
                self.assertEqual(row["s"], expected)


if __name__ == "__main__":
    unittest.main()
