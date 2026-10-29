"""Контракты нового монитора: наблюдаемые симптомы и честное восстановление."""
import importlib

import pytest


def engine():
    try:
        return importlib.import_module('app.engine.single')
    except ModuleNotFoundError:
        pytest.fail('Не реализован монитор тревог одного датчика')


def replay(scenario, seed=42):
    try:
        module = importlib.import_module('app.engine.single_scenarios')
    except ModuleNotFoundError:
        pytest.fail('Не реализовано воспроизведение нарушений одного датчика')
    return module.replay_single(scenario, seed)


def message(t, value=70, **kw):
    return {'event_time': t, 'received_at': t, 'value': value, 'mode': 'A', 'quality_flags': 'valid', **kw}


@pytest.mark.parametrize('scenario,expected', [
    ('drift', 'level'), ('rise', 'level'), ('step', 'level'), ('noise', 'noise'),
    ('periodic', 'noise'), ('stuck', 'stuck'), ('saturation', 'saturation'),
    ('jumps', 'invalid'), ('invalid', 'invalid'), ('rate', 'rate'),
    ('delay', 'latency'), ('gap', 'availability'),
])
@pytest.mark.parametrize('seed', [1, 7, 42, 999999])
def test_scenarios_detect_and_recover(scenario, expected, seed):
    r = replay(scenario, seed)
    incidents = [i for i in r['incidents'] if i['type'] == expected]
    if scenario == 'noise':
        # Three random samples can have a normal spread inside a noisy interval.
        # Two normal windows close it; longer quiet sections can still reopen it.
        assert incidents, r['incidents']
        assert incidents[0]['start'] == (66 if seed == 999999 else 63)
        assert all(60 <= i['start'] <= 120 and i['end'] is not None
                   and i['start'] < i['end'] <= 126 for i in incidents)
    else:
        assert len(incidents) == 1, r['incidents']
    i = incidents[0]
    assert 60 <= i['start'] < 130
    assert i['end'] is not None and i['start'] < i['end'] <= r['duration']
    assert len(i['reason']) > 40
    assert any(e['kind'] == 'close' and e['type'] == expected and e['text'] for e in r['events'])
    assert r['frames'][-1]['status'] == 'normal'


@pytest.mark.parametrize('scenario', ['normal', 'spike', 'mode'])
@pytest.mark.parametrize('seed', [1, 7, 42, 999999])
def test_normal_and_isolated_spike_do_not_alarm(scenario, seed):
    assert replay(scenario, seed)['incidents'] == []


def test_sign_symmetry():
    for sign in [-1, 1]:
        m = engine().SingleMonitor()
        for t in range(80):
            m.tick(t, [message(t, 70 + (sign * 7 if t >= 20 else (t % 3 - 1)))])
        assert any(i['type'] == 'level' for i in m.incidents)


def test_duplicate_cannot_confirm_or_recover():
    m = engine().SingleMonitor()
    for t in range(50):
        m.tick(t, [message(t, 80 + (t % 3 - 1))])
    assert any(i['type'] == 'level' for i in m.incidents)
    for t in range(50, 90):
        f = m.tick(t, [message(50, 70)])
    assert any(i['type'] == 'level' and i['end'] is None for i in m.incidents)
    assert f['status'] == 'alarm'


def test_old_batch_does_not_restore_freshness():
    m = engine().SingleMonitor()
    for t in range(30):
        m.tick(t, [message(t, 70 + (t % 3 - 1))])
    for t in range(30, 45):
        m.tick(t, [])
    f = m.tick(45, [message(t) for t in range(30, 36)])
    assert f['age'] > 6
    assert any(i['type'] == 'availability' for i in f['alarms'])
    assert f['since_receipt'] == 0


def test_missing_data_never_closes_noise_alarm():
    m = engine().SingleMonitor()
    for t in range(60):
        m.tick(t, [message(t, 70 + (5 if t % 2 else -5))])
    for t in range(60, 100):
        m.tick(t, [])
    assert any(i['type'] == 'noise' and i['end'] is None for i in m.incidents)


def test_impossible_jumps_are_excluded_from_level_and_noise():
    r = replay('jumps')
    assert any(i['type'] == 'invalid' for i in r['incidents'])
    assert not any(i['type'] in ('level', 'noise') for i in r['incidents'])


def test_mode_change_does_not_look_like_impossible_jump():
    assert replay('mode')['incidents'] == []


def test_constant_signal_can_be_permitted_by_profile():
    m = engine().SingleMonitor(config={'min_spread': 0})
    for t in range(60):
        m.tick(t, [message(t)])
    assert not any(i['type'] == 'stuck' for i in m.incidents)


def test_replay_is_deterministic_but_seed_changes_data():
    assert replay('noise', 42) == replay('noise', 42)
    assert replay('noise', 1)['messages'] != replay('noise', 42)['messages']


def test_api(client):
    response = client.post('/api/v1/single-replays', json={'scenario': 'noise', 'seed': 42})
    assert response.status_code == 200, response.text
    assert any(i['type'] == 'noise' for i in response.json()['incidents'])
    for seed in [True, 0, 1.5, '42', 1000000]:
        assert client.post('/api/v1/single-replays', json={'seed': seed}).status_code == 422
    assert client.post('/api/v1/single-replays', json={'scenario': 'unknown'}).status_code == 422


def test_old_valid_messages_do_not_close_invalid_measurement_alarm():
    m = engine().SingleMonitor()
    for t in range(12):
        m.tick(t, [message(t, quality_flags='invalid')])
    for t in range(12, 30):
        m.tick(t, [])
    for t in range(30, 43):
        m.tick(t, [message(t - 15)])
    assert any(i['type'] == 'invalid' and i['end'] is None for i in m.incidents)
