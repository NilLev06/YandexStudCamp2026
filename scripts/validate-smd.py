"""Offline SMD benchmark. Uses locally downloaded, checksum-verified raw files."""
import argparse
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'gateway'))
from app.validation.smd import SIGMA_FLOOR, fit_profiles, read_matrix, replay_metrics

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, default=ROOT / 'docs/SMD_VALIDATION.json')
args = parser.parse_args()
manifest = json.loads((ROOT / 'data/smd/manifest.json').read_text())
for entry in manifest['files'].values():
    path = ROOT / entry['path']
    if not path.exists():
        parser.error('Missing local raw data: ' + str(path) + '. See data/smd/README.md')
    if hashlib.sha256(path.read_bytes()).hexdigest() != entry['sha256']:
        parser.error('Source checksum mismatch: ' + str(path))
train = read_matrix(ROOT / manifest['files']['train']['path'])
test = read_matrix(ROOT / manifest['files']['test']['path'])
labels = [int(v) for v in (ROOT / manifest['files']['test_label']['path']).read_text().splitlines()]
cut = len(train) * 2 // 3
profiles = fit_profiles(train[:cut])
print(f'Calibration: train[0:{cut}], 38 channels. Frozen before any test evaluation.', flush=True)
holdout = train[cut:]
normal = replay_metrics(holdout, profiles, [0] * len(holdout))
print('Training holdout complete; evaluating the full labelled test stream.', flush=True)
metrics = replay_metrics(test, profiles, labels)
result = {'machine': manifest['machine'], 'source': manifest['source'], 'revision': manifest['revision'],
          'source_sha256': {k: v['sha256'] for k, v in manifest['files'].items()},
          'protocol': {'calibration': {'split': 'train', 'start_index': 0, 'end_index_exclusive': cut},
                       'holdout': {'split': 'train', 'start_index': cut, 'end_index_exclusive': len(train)},
                       'test': 'All original test rows and labels; one forward pass; no tuning on test labels.',
                       'axis': 'sample indices, NOT physical seconds', 'window_samples': 3,
                       'opening_windows': 1, 'recovery_windows': 2, 'sigma_floor': SIGMA_FLOOR,
                       'aggregation': 'Alarm if any of the 38 independent channels has an open incident.',
                       'disabled': ['physical bounds / saturation', 'physical slew-rate limit', 'stuck detector'],
                       'network_faults': 'Not evaluated: replay delivers one sample per synthetic tick without delays.',
                       'point_scoring': 'Original binary labels; no point adjustment or event-wide expansion.',
                       'event_scoring': 'Any overlap with an active alarm; may count an alarm already open before the event.',
                       'train_holdout_labels': 'Assumed normal; no per-row reference labels provided for train.',
                       'scope': 'One machine only. This benchmark does not validate every fault type.'},
          'profiles': profiles, 'assumed_normal_train_holdout': normal, 'labelled_test': metrics}
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps(result, indent=2, allow_nan=False) + '\n')
print(json.dumps(metrics, indent=2), flush=True)
print('Report:', args.output, flush=True)
