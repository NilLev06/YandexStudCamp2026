import asyncio

import pytest

from app.api import stream as stream_api
from app.engine.live import replay_live


def msg(clock, sensor='camera-01', dt=0.0, **extra):
    return {'sensor_id': sensor, 'event_time': clock.now + dt, 'value': 95.0, 'mode': 'A', **extra}


def feed(client, registry, clock, seconds, sensor='camera-01', **extra):
    for index in range(seconds):
        clock.advance(1)
        r = client.post('/api/v1/telemetry', json={'messages': [msg(clock, sensor, id=clock.now, **{**extra, 'value': extra.get('value', 95.0) + (index % 3 - 1) * 0.25})]})
        assert r.status_code == 202, r.text
        registry.tick()


def test_health_and_meta(client):
    h = client.get('/api/v1/health').json()
    assert h['status'] == 'ok' and h['sensors'] == 0
    meta = client.get('/api/v1/meta').json()
    assert meta['config']['h'] == 10
    assert {s['id'] for s in meta['scenarios']} == {'combined', 'spike', 'drift', 'gap', 'mode'}
    assert meta['auth_required'] is False


def test_openapi_lists_all_routes(client):
    paths = client.get('/openapi.json').json()['paths']
    for p in ('/api/v1/telemetry', '/api/v1/sensors', '/api/v1/sensors/{sensor_id}/frames', '/api/v1/incidents',
              '/api/v1/simulations', '/api/v1/replays', '/api/v1/benchmark', '/api/v1/stream', '/api/v1/overview'):
        assert p in paths


def test_ingest_registers_sensor_and_reports_normal_quality(client, registry, clock):
    feed(client, registry, clock, 20)
    sensors = client.get('/api/v1/sensors').json()
    assert [s['sensor_id'] for s in sensors] == ['camera-01']
    status = sensors[0]['status']
    assert status['quality'] == 'normal' and status['availability'] == 'fresh'
    assert sensors[0]['clock'] == 'wall' and sensors[0]['source'] == 'ingest'
    assert len(client.get('/api/v1/sensors/camera-01/measurements').json()) == 20
    assert len(client.get('/api/v1/sensors/camera-01/frames', params={'limit': 5}).json()) == 5


def test_validation_and_future_timestamps(client, clock):
    assert client.post('/api/v1/telemetry', json={'messages': []}).status_code == 422
    assert client.post('/api/v1/telemetry', json={'messages': [{'sensor_id': 'x', 'value': 1}]}).status_code == 422
    assert client.post('/api/v1/telemetry', json={'messages': [{**msg(clock), 'extra': 1}]}).status_code == 422
    assert client.post('/api/v1/telemetry', json={'messages': [msg(clock, sensor='bad id!')]}).status_code == 422
    r = client.post('/api/v1/telemetry', json={'messages': [msg(clock), msg(clock, dt=60)]}).json()
    assert r['accepted'] == 1
    assert r['rejected'] == [{'index': 1, 'sensor_id': 'camera-01', 'reason': 'Время измерения в будущем: часы сенсора спешат'}]


def test_silence_opens_and_fresh_data_closes_availability_incident(client, registry, clock):
    feed(client, registry, clock, 20)
    for _ in range(10):
        clock.advance(1)
        registry.tick()
    open_ = client.get('/api/v1/incidents', params={'state': 'open'}).json()
    assert [(i['type'], i['sensor_id']) for i in open_] == [('availability', 'camera-01')]
    assert client.get('/api/v1/overview').json()['open_incidents']['availability'] == 1
    feed(client, registry, clock, 7)
    incident = client.get('/api/v1/sensors/camera-01/incidents').json()[0]
    assert incident['state'] == 'closed' and incident['closed_at'] > incident['opened_at']
    kinds = [e['kind'] for e in client.get('/api/v1/sensors/camera-01/events').json() if e['type'] == 'availability']
    assert kinds == ['open', 'close']


def test_degradation_opens_quality_incident(client, registry, clock):
    feed(client, registry, clock, 30)
    feed(client, registry, clock, 40, value=80.0)
    sensor = client.get('/api/v1/sensors/camera-01').json()
    assert sensor['status']['quality'] == 'alarm'
    assert [i['type'] for i in sensor['open_incidents']] == ['quality']


def test_api_key_protects_writes_only(make_client, clock):
    client = make_client(api_key='secret')
    body = {'messages': [msg(clock)]}
    assert client.post('/api/v1/telemetry', json=body).status_code == 401
    assert client.post('/api/v1/telemetry', json=body, headers={'X-API-Key': 'wrong'}).status_code == 401
    assert client.post('/api/v1/telemetry', json=body, headers={'X-API-Key': 'secret'}).status_code == 202
    assert client.post('/api/v1/simulations', json={}).status_code == 401
    assert client.get('/api/v1/sensors').status_code == 200
    assert client.get('/api/v1/meta').json()['auth_required'] is True


def test_simulation_reproduces_offline_replay(client, registry, clock):
    sim = client.post('/api/v1/simulations', json={'scenario': 'combined', 'seed': 42, 'speed': 60}).json()
    assert sim['state'] == 'running' and sim['sensor_id'] == 'sim-combined-42'
    for _ in range(8):
        clock.advance(1)
        registry.tick()
    sim = client.get(f"/api/v1/simulations/{sim['id']}").json()
    assert sim['state'] == 'finished' and sim['progress'] == 1
    expected = [(i['type'], i['start'], i['end']) for i in replay_live('combined', 42)['incidents']]
    got = [(i['type'], i['start'], i['end']) for i in client.get('/api/v1/sensors/sim-combined-42/incidents').json()]
    assert got == expected
    detail = client.get('/api/v1/sensors/sim-combined-42').json()
    assert detail['clock'] == 'virtual' and len(detail['truth']) == 2
    r = client.post('/api/v1/telemetry', json={'messages': [msg(clock, sensor='sim-combined-42')]}).json()
    assert r['rejected'][0]['reason'] == 'Сенсор занят симуляцией'
    second = client.post('/api/v1/simulations', json={'scenario': 'combined', 'seed': 42}).json()
    assert second['sensor_id'] == 'sim-combined-42-2'


def test_simulation_errors_and_stop(client, registry, clock):
    assert client.post('/api/v1/simulations', json={'scenario': 'nope'}).status_code == 422
    assert client.post('/api/v1/simulations', json={'speed': 1000}).status_code == 422
    sim = client.post('/api/v1/simulations', json={'scenario': 'gap', 'sensor_id': 'demo'}).json()
    assert client.post('/api/v1/simulations', json={'sensor_id': 'demo'}).status_code == 409
    clock.advance(2)
    registry.tick()
    stopped = client.delete(f"/api/v1/simulations/{sim['id']}").json()
    assert stopped['state'] == 'stopped' and stopped['position'] == 12
    clock.advance(10)
    registry.tick()
    assert client.get(f"/api/v1/simulations/{sim['id']}").json()['position'] == 12
    assert client.get('/api/v1/simulations/missing').status_code == 404


def test_delete_sensor(client, registry, clock):
    feed(client, registry, clock, 2)
    assert client.delete('/api/v1/sensors/camera-01').status_code == 204
    assert client.get('/api/v1/sensors/camera-01').status_code == 404
    assert client.get('/api/v1/incidents', params={'sensor_id': 'camera-01'}).status_code == 404


def test_replay_and_benchmark(client):
    r = client.post('/api/v1/replays', json={'scenario': 'drift', 'seed': 42}).json()
    assert len(r['frames']) == 221
    assert r['metrics']['monitor'] == {'detected': 1, 'total': 1, 'false_alarms': 0, 'repeats': 0, 'unclosed': 0,
                                       'delay': 23, 'close_delay': 27, 'closed': 1}
    assert client.post('/api/v1/replays', json={'scenario': 'x'}).status_code == 422
    b = client.post('/api/v1/benchmark', json={'seed_from': 1, 'seed_to': 4}).json()
    assert b['runs'] == 20 and b['monitor']['total'] == 16 and b['monitor']['false_alarms'] == 0
    assert client.post('/api/v1/benchmark', json={'seed_from': 1, 'seed_to': 999}).status_code == 422
    assert client.post('/api/v1/benchmark', json={'seed_from': 5, 'seed_to': 1}).status_code == 422


def test_stream_emits_updates_for_requested_sensor(client, registry, clock):
    class FakeRequest:
        app = client.app

        async def is_disconnected(self):
            return False

    async def run():
        response = await stream_api.stream(FakeRequest(), client.app.state.settings, sensor_id='camera-01')
        body = response.body_iterator
        assert await body.__anext__() == 'retry: 3000\n\n'
        registry.ingest([])
        client.app.state.broker.publish({'type': 'update', 'sensor_id': 'other'})
        client.app.state.broker.publish({'type': 'update', 'sensor_id': 'camera-01', 'frames': []})
        chunk = await asyncio.wait_for(body.__anext__(), 1)
        await body.aclose()
        return chunk

    chunk = asyncio.run(run())
    assert chunk.startswith('event: update\ndata: ') and '"camera-01"' in chunk
    assert client.app.state.broker.subscribers == 0


@pytest.mark.parametrize('path', ['/api/v1/nope', '/api/v1/sensors/x'])
def test_unknown_paths_return_json_404(client, path):
    r = client.get(path)
    assert r.status_code == 404 and 'detail' in r.json()


def test_serves_frontend_build_with_spa_fallback(make_client, tmp_path):
    (tmp_path / 'assets').mkdir()
    (tmp_path / 'index.html').write_text('<div id="root"></div>')
    (tmp_path / 'assets' / 'app.js').write_text('console.log(1)')
    client = make_client(static_dir=tmp_path)
    assert client.get('/').text == '<div id="root"></div>'
    assert client.get('/sensors/camera-01').text == '<div id="root"></div>'
    assert client.get('/assets/app.js').text == 'console.log(1)'
    assert client.get('/../../etc/passwd').text == '<div id="root"></div>'
    assert client.get('/api/v1/nope').status_code == 404
    assert client.get('/api/v1/health').json()['status'] == 'ok'
