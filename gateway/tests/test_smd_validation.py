"""Small unit checks plus offline regressions on attributed, fixed SMD excerpts."""
import hashlib
import json
from pathlib import Path

import pytest

from app.validation.smd import fit_profiles, read_matrix, replay_metrics, score

FIXTURE = Path(__file__).parent / 'fixtures' / 'smd_machine_1_1'


def test_training_statistics_use_only_provided_training_rows():
    profiles = fit_profiles([[0.0, 0.5], [0.2, 0.5]], sigma_floor=0.01)
    assert profiles == [{'mean': 0.1, 'sigma': 0.1}, {'mean': 0.5, 'sigma': 0.01}]


@pytest.mark.parametrize('contents', ['1,2\n3\n', '1,nan\n', '1,inf\n', ''])
def test_invalid_matrices_are_rejected(tmp_path, contents):
    path = tmp_path / 'matrix.csv'
    path.write_text(contents)
    with pytest.raises(ValueError):
        read_matrix(path, features=2)


def test_point_and_event_scores_do_not_expand_one_detection_to_a_whole_event():
    result = score([False, False, True, False, True, False], [0, 1, 1, 1, 0, 0])
    assert result['tp'] == 1 and result['fp'] == 1
    assert result['fn'] == 2 and result['tn'] == 2
    assert result['event_detected'] == 1 and result['event_total'] == 1
    assert result['event_delays_samples'] == [1]
    assert result['point_recall'] == pytest.approx(1 / 3)


def test_fixture_provenance_shape_and_labels():
    manifest = json.loads((FIXTURE / 'manifest.json').read_text())
    assert manifest['revision'] == '7fb0e0acf89ea49908896bcc9f9e80fcfff6baf4'
    for record in manifest['files'].values():
        assert hashlib.sha256((FIXTURE / record['file']).read_bytes()).hexdigest() == record['sha256']
    train = read_matrix(FIXTURE / 'calibration.csv')
    normal = read_matrix(FIXTURE / 'normal.csv')
    test = read_matrix(FIXTURE / 'test.csv')
    labels = [int(line) for line in (FIXTURE / 'labels.txt').read_text().splitlines()]
    assert len(train) == 600 and len(normal) == 300
    assert len(test) == len(labels) == 1146
    assert all(len(row) == 38 for row in train + normal + test)
    assert set(labels) == {0, 1} and sum(labels) == 546
    assert (FIXTURE / 'LICENSE').read_text().startswith('MIT License')


@pytest.fixture(scope='module')
def real_result():
    train = read_matrix(FIXTURE / 'calibration.csv')
    normal = read_matrix(FIXTURE / 'normal.csv')
    test = read_matrix(FIXTURE / 'test.csv')
    labels = [int(line) for line in (FIXTURE / 'labels.txt').read_text().splitlines()]
    profiles = fit_profiles(train)
    return {'normal': replay_metrics(normal, profiles, [0] * len(normal)),
            'annotated': replay_metrics(test, profiles, labels)}


def test_real_smd_regression_records_false_alarms_and_misses(real_result):
    # A regression baseline is not an accuracy target. Bad scores remain visible.
    expected = json.loads((FIXTURE / 'expected.json').read_text())
    assert real_result == expected
    assert real_result['annotated']['event_total'] == 1
    assert real_result['normal']['event_total'] == 0


def test_reference_labels_cannot_change_detector_predictions():
    train = read_matrix(FIXTURE / 'calibration.csv')
    test = read_matrix(FIXTURE / 'test.csv')[:120]
    profiles = fit_profiles(train)
    normal_labels = replay_metrics(test, profiles, [0] * len(test))
    anomaly_labels = replay_metrics(test, profiles, [1] * len(test))
    assert normal_labels['prediction_sha256'] == anomaly_labels['prediction_sha256']
    assert normal_labels['alarm_points'] == anomaly_labels['alarm_points']


def test_future_real_samples_do_not_change_past_predictions():
    from app.validation.smd import predict
    train = read_matrix(FIXTURE / 'calibration.csv')
    rows = read_matrix(FIXTURE / 'test.csv')[:90]
    profiles = fit_profiles(train)
    assert predict(rows[:60], profiles) == predict(rows, profiles)[:60]


@pytest.mark.parametrize('labels', [[0], [0, 2]])
def test_scores_reject_bad_alignment_or_nonbinary_labels(labels):
    with pytest.raises(ValueError):
        score([False, True], labels)


@pytest.mark.parametrize('direction', [-1, 1])
def test_controlled_shift_on_real_measurements_opens_and_recovers(direction):
    from app.engine.single import SingleMonitor
    from app.validation.smd import SMD_CONFIG
    rows = read_matrix(FIXTURE / 'calibration.csv')
    profile = fit_profiles(rows)[0]
    original = SingleMonitor(config=SMD_CONFIG, profiles={'A': profile})
    injected = SingleMonitor(config=SMD_CONFIG, profiles={'A': profile})
    for index, row in enumerate(rows[:180]):
        message = {'event_time': index, 'received_at': index, 'mode': 'A', 'value': row[0]}
        original.tick(index, [message])
        shift = direction * 10 * profile['sigma'] if 60 <= index < 120 else 0
        injected.tick(index, [{**message, 'value': row[0] + shift}])
    assert not any(i['type'] == 'level' and 60 <= i['start'] < 120 for i in original.incidents)
    alarms = [i for i in injected.incidents if i['type'] == 'level' and 60 <= i['start'] < 120]
    assert len(alarms) == 1 and 60 < alarms[0]['start'] <= 72
    assert alarms[0]['end'] is not None and 120 <= alarms[0]['end'] < 180
