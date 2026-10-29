"""Матричные тесты: сценарии × seed, граница seed × точки входа, рекомендованные seed, ступени × seed."""
import json
import math
import shutil
import subprocess
from pathlib import Path

import pytest

from app.engine.live import replay_live

from app.engine import CONFIG, RECOMMENDED_SEEDS, SCENARIOS, SEED, Monitor, check_seed, evaluate, generate, replay, rng

ENGINE_JS = Path(__file__).resolve().parents[2] / 'demo' / 'engine.js'
RECOMMENDED = [(scenario, rec) for scenario, recs in RECOMMENDED_SEEDS.items() for rec in recs]
MATRIX_SEEDS = sorted({*range(1, 41), SEED['max'], *(rec['seed'] for _, rec in RECOMMENDED)})


def quality(r):
    return [i for i in r['incidents'] if i['type'] == 'quality']


def availability(r):
    return [i for i in r['incidents'] if i['type'] == 'availability']


def check_combined(r, e):
    assert (e['detected'], e['falseAlarms'], e['repeats']) == (2, 0, 0)
    assert len(quality(r)) == 1 and 100 <= quality(r)[0]['start'] <= 135


def check_spike(r, e):
    assert quality(r) == [] and e['falseAlarms'] == 0
    assert any(i['type'] == 'quality' and 60 <= i['start'] <= 61 for i in r['baseline']), 'порог должен сработать на выбросе'


def check_drift(r, e):
    assert (e['detected'], e['falseAlarms'], e['repeats']) == (1, 0, 0)
    q = quality(r)[0]
    assert 60 <= q['start'] <= 90
    assert q['end'] is None or q['end'] >= 150


def check_gap(r, e):
    assert e['detected'] == 1 and quality(r) == []
    a = availability(r)[0]
    assert 60 <= a['start'] <= 67
    assert 120 <= a['end'] <= 125, 'старая пачка не должна закрывать инцидент'
    assert r['frames'][110]['availability'] == 'stale'


def check_mode(r, e):
    assert quality(r) == []
    assert [ev['kind'] for ev in r['events']].count('mode') == 1


INVARIANTS = {'combined': check_combined, 'spike': check_spike, 'drift': check_drift, 'gap': check_gap, 'mode': check_mode}


@pytest.mark.parametrize('seed', MATRIX_SEEDS)
@pytest.mark.parametrize('scenario', list(SCENARIOS))
def test_scenario_invariants(scenario, seed):
    r = replay(scenario, seed)
    assert len(r['frames']) == SCENARIOS[scenario]['duration'] + 1
    INVARIANTS[scenario](r, evaluate(r)['monitor'])


@pytest.fixture(scope='module')
def js_seeds():
    node = shutil.which('node')
    if not node or not ENGINE_JS.exists():
        pytest.skip('Нужен Node.js и demo/engine.js')
    code = 'const a=require(process.argv[1]);process.stdout.write(JSON.stringify({seed:a.SEED,recommended:a.RECOMMENDED_SEEDS}))'
    return json.loads(subprocess.run([node, '-e', code, str(ENGINE_JS)], capture_output=True, check=True, text=True).stdout)


def test_seed_constants_match_js_engine(js_seeds):
    assert SEED == js_seeds['seed']
    assert RECOMMENDED_SEEDS == js_seeds['recommended']


@pytest.mark.parametrize('scenario,rec', RECOMMENDED, ids=[f"{s}-{r['seed']}-{r['kind']}" for s, r in RECOMMENDED])
def test_recommended_seed_claim(scenario, rec):
    r = replay(scenario, rec['seed'])
    e = evaluate(r)['monitor']
    peak = max(f['s'] for f in r['frames'])
    assert SEED['min'] <= rec['seed'] <= SEED['scan']
    if rec['kind'] == 'reference':
        assert rec['seed'] == 42
    elif rec['kind'] in ('fastest', 'slowest'):
        assert e['delay'] == rec['value']
    elif rec['kind'] == 'unclosed':
        assert e['unclosed'] > 0
    elif rec['kind'] == 'near_miss':
        assert quality(r) == [] and round(peak, 2) == rec['value'] < CONFIG['h']
    else:
        pytest.fail('Неизвестный вид рекомендации: ' + rec['kind'])


def test_every_scenario_has_reference_seed_first():
    assert set(RECOMMENDED_SEEDS) == set(SCENARIOS)
    for scenario, recs in RECOMMENDED_SEEDS.items():
        assert recs[0]['kind'] == 'reference' and recs[0]['seed'] == 42, scenario
        assert len({r['seed'] for r in recs}) == len(recs), scenario


INVALID_SEEDS = [0, -1, SEED['max'] + 1, 1.5, '42', True, None]
VALID_SEEDS = [SEED['min'], 42, SEED['max']]


@pytest.mark.parametrize('seed', INVALID_SEEDS, ids=repr)
def test_engine_rejects_seed_out_of_bounds(seed):
    with pytest.raises(ValueError):
        check_seed(seed)
    with pytest.raises(ValueError):
        generate('spike', seed)


@pytest.mark.parametrize('seed', VALID_SEEDS)
def test_engine_accepts_boundary_seed(seed):
    assert generate('spike', seed)['seed'] == seed


ENDPOINTS = {
    'simulations': lambda seed: ('/api/v1/simulations', {'scenario': 'spike', 'seed': seed}),
    'replays': lambda seed: ('/api/v1/replays', {'scenario': 'spike', 'seed': seed}),
    'benchmark_from': lambda seed: ('/api/v1/benchmark', {'scenarios': ['spike'], 'seed_from': seed, 'seed_to': SEED['max']}),
    'benchmark_to': lambda seed: ('/api/v1/benchmark', {'scenarios': ['spike'], 'seed_from': SEED['min'], 'seed_to': seed}),
}


@pytest.mark.parametrize('endpoint', list(ENDPOINTS))
@pytest.mark.parametrize('seed', INVALID_SEEDS, ids=repr)
def test_api_rejects_seed_out_of_bounds(client, endpoint, seed):
    path, body = ENDPOINTS[endpoint](seed)
    r = client.post(path, json=body)
    assert r.status_code == 422, r.text


@pytest.mark.parametrize('endpoint', ['simulations', 'replays'])
@pytest.mark.parametrize('seed', VALID_SEEDS)
def test_api_accepts_boundary_seed(client, endpoint, seed):
    path, body = ENDPOINTS[endpoint](seed)
    r = client.post(path, json=body)
    assert r.status_code in (200, 201), r.text
    assert r.json()['seed'] == seed


@pytest.mark.parametrize('seed', [SEED['min'], SEED['max']])
def test_api_benchmark_single_boundary_seed(client, seed):
    r = client.post('/api/v1/benchmark', json={'scenarios': ['spike'], 'seed_from': seed, 'seed_to': seed})
    assert r.status_code == 200 and r.json()['runs'] == 1


def test_meta_exposes_seed_bounds_and_recommendations(client):
    meta = client.get('/api/v1/meta').json()
    assert meta['seed'] == SEED
    assert {s: [r['seed'] for r in recs] for s, recs in meta['recommended_seeds'].items()} == \
           {s: [r['seed'] for r in recs] for s, recs in RECOMMENDED_SEEDS.items()}


@pytest.mark.parametrize('scenario,rec', RECOMMENDED, ids=[f"{s}-{r['seed']}" for s, r in RECOMMENDED])
def test_live_simulation_matches_replay(client, registry, clock, scenario, rec):
    sim = client.post('/api/v1/simulations', json={'scenario': scenario, 'seed': rec['seed'], 'speed': 60}).json()
    for _ in range(math.ceil(SCENARIOS[scenario]['duration'] / 60) + 1):
        clock.advance(1)
        registry.tick()
    got = [(i['type'], i['start'], i['end']) for i in client.get(f"/api/v1/sensors/{sim['sensor_id']}/incidents").json()]
    assert got == [(i['type'], i['start'], i['end']) for i in replay_live(scenario, rec['seed'])['incidents']]


def step_stream(sigmas: float, seed: int, duration: int = 400, start: int = 100) -> list:
    random = rng(seed)
    monitor = Monitor()
    for t in range(duration + 1):
        noise = math.sqrt(-2 * math.log(max(random(), 1e-9))) * math.cos(2 * math.pi * random())
        value = 95 + 1.5 * noise - (sigmas * 1.5 if t >= start else 0)
        monitor.tick(t, [{'id': t, 'event_time': t, 'value': value, 'mode': 'A', 'quality_flags': 'valid'}])
    return [i for i in monitor.incidents if i.type == 'quality']


@pytest.mark.parametrize('seed', range(1, 11))
@pytest.mark.parametrize('sigmas,max_delay', [(1, 120), (2, 40), (3, 25), (5, 20)])
def test_step_detected_within_delay(sigmas, max_delay, seed):
    incidents = step_stream(sigmas, seed)
    assert not [i for i in incidents if i.start < 100], 'тревога до начала ступени'
    assert incidents and incidents[0].start - 100 <= max_delay


@pytest.mark.parametrize('seed', range(1, 6))
def test_healthy_hour_has_no_quality_alarms(seed):
    assert step_stream(0, seed, duration=3600) == []
