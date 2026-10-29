"""Extract fixed offline regression fixtures; verify source checksums first."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
source = json.loads((ROOT / 'data/smd/manifest.json').read_text())
for entry in source['files'].values():
    if hashlib.sha256((ROOT / entry['path']).read_bytes()).hexdigest() != entry['sha256']:
        raise ValueError('Source checksum mismatch: ' + entry['path'])
output = ROOT / 'gateway/tests/fixtures/smd_machine_1_1'
output.mkdir(parents=True, exist_ok=True)
files = {}
for name, split, start, end in [('calibration.csv', 'train', 0, 600), ('normal.csv', 'train', 600, 900),
                                ('test.csv', 'test', 15549, 16695), ('labels.txt', 'test_label', 15549, 16695)]:
    lines = (ROOT / source['files'][split]['path']).read_bytes().splitlines(keepends=True)
    contents = b''.join(lines[start:end])
    (output / name).write_bytes(contents)
    files[name] = {'file': name, 'source_split': split, 'start_index': start, 'end_index_exclusive': end,
                   'sha256': hashlib.sha256(contents).hexdigest()}
license_contents = (ROOT / 'data/smd/raw/LICENSE').read_bytes()
(output / 'LICENSE').write_bytes(license_contents)
files['LICENSE'] = {'file': 'LICENSE', 'sha256': hashlib.sha256(license_contents).hexdigest()}
(output / 'manifest.json').write_text(json.dumps({'source': source['source'], 'revision': source['revision'],
    'machine': source['machine'], 'source_sha256': {k: v['sha256'] for k, v in source['files'].items()},
    'selection': 'Training prefixes and first annotated test event with 300 context samples on each side; not a representative benchmark.',
    'files': files}, indent=2) + '\n')
print('Prepared attributed fixture:', output)
