"""Пара сравнивает одну величину; изменение процесса и ошибки доставки не означают расхождение."""
import importlib

import pytest


def pair_api():
    try:
        return importlib.import_module('app.engine.pair')
    except ModuleNotFoundError:
        pytest.fail('Сценарий двух датчиков ещё не реализован')


def messages(t, a=25.0, b=25.0):
    return [{'sensor_id': name, 'event_time': t, 'value': value, 'quality_flags': 'valid'}
            for name, value in [('A', a), ('B', b)]]


def test_common_change_is_not_disagreement():
    m = pair_api().PairMonitor()
    for t in range(30):
        v = 25 + t * 0.4
        m.tick(t, messages(t, v, v + 0.1))
    assert m.incidents == []


def test_persistent_difference_opens_once_and_explains_without_blame():
    m = pair_api().PairMonitor()
    for t in range(15):
        m.tick(t, messages(t, 25, 27))
    assert len(m.incidents) == 1
    assert m.incidents[0]['type'] == 'disagreement'
    assert m.incidents[0]['start'] == 3
    assert '2.00' in m.incidents[0]['reason']
    assert 'какой' in m.incidents[0]['reason']


def test_swapping_sensors_does_not_change_alarm():
    api = pair_api()
    a, b = api.PairMonitor(), api.PairMonitor()
    for t in range(10):
        fa = a.tick(t, messages(t, 25, 27))
        fb = b.tick(t, messages(t, 27, 25))
        assert fa['difference'] == fb['difference']
        assert fa['status'] == fb['status']


def test_one_spike_does_not_open_persistent_alarm():
    m = pair_api().PairMonitor()
    for t in range(20):
        m.tick(t, messages(t, 25, 30 if t == 8 else 25))
    assert m.incidents == []


def test_recovery_needs_two_three_second_windows_and_silence_does_not_close():
    m = pair_api().PairMonitor()
    for t in range(4):
        m.tick(t, messages(t, 25, 27))
    for t in range(4, 10):
        m.tick(t, [])
    assert m.incidents[0]['end'] is None
    for t in range(10, 16):
        m.tick(t, messages(t))
    assert m.incidents[0]['end'] is None
    m.tick(16, messages(16))
    assert m.incidents[0]['end'] == 16


def test_old_messages_do_not_restore_comparison():
    m = pair_api().PairMonitor()
    m.tick(0, messages(0))
    for t in range(1, 9):
        m.tick(t, [messages(t)[0]])
    frame = m.tick(9, [{'sensor_id': 'B', 'event_time': 1, 'value': 25}])
    assert frame['status'] == 'unavailable'
    assert frame['difference'] is None
    assert any(i['type'] == 'availability' and i['end'] is None for i in m.incidents)


def test_repeated_pair_cannot_confirm_disagreement():
    m = pair_api().PairMonitor()
    m.tick(0, messages(0, 25, 27))
    m.tick(0.1, [])
    m.tick(0.2, [])
    assert not [i for i in m.incidents if i['type'] == 'disagreement']


def test_unaligned_samples_are_not_compared():
    m = pair_api().PairMonitor()
    frame = m.tick(1, [{'sensor_id': 'A', 'event_time': 0, 'value': 25},
                       {'sensor_id': 'B', 'event_time': 1, 'value': 35}])
    assert frame['difference'] is None
    assert frame['status'] == 'unavailable'


def test_one_reused_measurement_cannot_confirm_multiple_pairs():
    m = pair_api().PairMonitor()
    m.tick(0, messages(0, 25, 27))
    m.tick(0.1, [{'sensor_id': 'A', 'event_time': 0.1, 'value': 25}])
    m.tick(0.2, [{'sensor_id': 'A', 'event_time': 0.2, 'value': 25}])
    assert not [i for i in m.incidents if i['type'] == 'disagreement']


def test_freshness_recovery_is_not_green_before_three_new_pairs():
    r = pair_api().replay_pair('gap', 42)
    assert r['frames'][110]['status'] == 'recovering'
    assert r['frames'][111]['status'] == 'recovering'
    assert r['frames'][112]['status'] == 'recovering'
    assert r['frames'][115]['status'] == 'recovering'
    assert r['frames'][116]['status'] == 'normal'


@pytest.mark.parametrize('scenario', ['normal', 'drift', 'spike', 'gap'])
def test_pair_scenarios_are_reproducible(scenario):
    api = pair_api()
    assert api.generate_pair(scenario, 42) == api.generate_pair(scenario, 42)
    r = api.replay_pair(scenario, 42)
    assert len(r['frames']) == r['duration'] + 1
    alarms = [i for i in r['incidents'] if i['type'] == 'disagreement']
    if scenario == 'drift':
        assert len(alarms) == 1 and 65 <= alarms[0]['start'] < 100
        assert alarms[0]['end'] is not None and alarms[0]['end'] > 120
    else:
        assert alarms == []


def test_pair_endpoint(client):
    r = client.post('/api/v1/pair-replays', json={'scenario': 'drift', 'seed': 42})
    assert r.status_code == 200, r.text
    data = r.json()
    assert data['config']['threshold'] == 0.8
    assert {m['sensor_id'] for m in data['messages']} == {'A', 'B'}
    assert any(i['type'] == 'disagreement' for i in data['incidents'])
    for body in [{'seed': 0}, {'seed': True}, {'scenario': 'unknown'}]:
        assert client.post('/api/v1/pair-replays', json=body).status_code == 422


def test_freshness_recovery_is_not_green_before_three_new_pairs():
    result = pair_api().replay_pair('gap', 42)
    assert result['frames'][110]['status'] == 'recovering'
    assert result['frames'][111]['status'] == 'recovering'
    assert result['frames'][112]['status'] == 'recovering'
    assert result['frames'][115]['status'] == 'recovering'
    assert result['frames'][116]['status'] == 'normal'
