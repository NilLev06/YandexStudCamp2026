"""Тесты API шлюза. Часы датчиков подменяются, планировщик двигаем вручную (hub.advance)."""
import os

os.environ["SENSORWATCH_DEMO_ON_START"] = "0"

import pytest
from fastapi.testclient import TestClient

from app.hub import hub
from app.main import app
from app.settings import settings


class FakeClock:
    kind = "wall"
    speed = None

    def __init__(self, t=1000.0):
        self.t = t

    def now(self):
        return self.t


@pytest.fixture()
def client():
    settings.demo_on_start = False
    hub.sensors.clear()
    hub.incidents.clear()
    hub.runs.clear()
    with TestClient(app) as c:
        hub._task.cancel()          # тики двигаем сами
        yield c
    hub.sensors.clear()


def test_health_and_meta(client):
    assert client.get("/api/v1/health").json()["status"] == "ok"
    meta = client.get("/api/v1/meta").json()
    assert "quality" in meta["incident_types"] and any(s["id"] == "combined" for s in meta["scenarios"])


def test_register_ingest_detect_and_ack(client):
    r = client.post("/api/v1/sensors", json={"id": "probe-1", "unit": "°C",
                                             "profiles": {"run": {"mean": 20.0, "sigma": 0.2}}})
    assert r.status_code == 201
    clock = FakeClock()
    hub.sensors["probe-1"].clock = clock
    # 60 с нормы, затем значение уходит вниз на 1 градус (5σ)
    for k in range(200):
        v = 20.0 + (0.1 if k % 2 else -0.1) - (1.0 if k >= 60 else 0.0)
        client.post("/api/v1/ingest", json={"messages": [{"sensor_id": "probe-1", "event_time": clock.t,
                                                          "value": v, "mode": "run", "id": k}]})
        hub.advance()
        clock.t += 1
    st = client.get("/api/v1/sensors/probe-1/status").json()
    assert st["quality"] == "alarm"
    inc = client.get("/api/v1/incidents", params={"sensor_id": "probe-1", "state": "open"}).json()
    assert len(inc) == 1 and inc[0]["type"] == "quality"
    acked = client.post(f"/api/v1/incidents/{inc[0]['id']}/ack", json={"by": "Уэкслер"}).json()
    assert acked["acknowledged"] and acked["open"]
    series = client.get("/api/v1/sensors/probe-1/series").json()
    assert len(series["messages"]) == 200 and series["frames"][-1]["quality"] == "alarm"
    assert client.get("/api/v1/overview").json()["open_incidents"] == 1


def test_silence_opens_availability_incident(client):
    client.post("/api/v1/sensors", json={"id": "probe-2", "profiles": {"A": {"mean": 1.0, "sigma": 0.1}}})
    clock = FakeClock()
    hub.sensors["probe-2"].clock = clock
    for k in range(30):
        if k < 10:   # потом источник замолкает - тик идёт сам, без входящих данных
            client.post("/api/v1/ingest", json={"messages": [
                {"sensor_id": "probe-2", "event_time": clock.t, "value": 1.0 + 0.01 * (k % 3), "mode": "A"}]})
        hub.advance()
        clock.t += 1
    assert client.get("/api/v1/sensors/probe-2/status").json()["availability"] == "stale"


def test_auto_register_and_auto_calibration(client):
    settings.auto_calib_samples = 10
    clock = FakeClock()
    msgs = [{"sensor_id": "auto-1", "event_time": clock.t, "value": 5.0, "mode": "idle"}]
    r = client.post("/api/v1/ingest", json={"messages": msgs}).json()
    assert r["created"] == ["auto-1"]
    hub.sensors["auto-1"].clock = clock
    for k in range(1, 40):
        clock.t += 1
        client.post("/api/v1/ingest", json={"messages": [
            {"sensor_id": "auto-1", "event_time": clock.t, "value": 5.0 + 0.05 * (k % 4), "mode": "idle"}]})
        hub.advance()
    prof = client.get("/api/v1/sensors/auto-1/profiles").json()
    assert prof["idle"]["source"] == "auto"


def test_calibrate_endpoint(client):
    client.post("/api/v1/sensors", json={"id": "cal-1", "profiles": {"A": {"mean": 0, "sigma": 1}}})
    clock = FakeClock()
    hub.sensors["cal-1"].clock = clock
    for k in range(30):
        client.post("/api/v1/ingest", json={"messages": [
            {"sensor_id": "cal-1", "event_time": clock.t, "value": 10 + (k % 5) * 0.1, "mode": "A"}]})
        hub.advance()
        clock.t += 1
    p = client.post("/api/v1/sensors/cal-1/calibrate", json={"mode": "A"}).json()
    assert abs(p["mean"] - 10.2) < 1e-9 and p["source"].startswith("calibrated")


def test_runs_and_benchmark(client):
    run = client.post("/api/v1/runs", json={"scenario": "drift", "seed": 42}).json()
    assert run["metrics"]["monitor"]["detected"] == 1
    assert client.get(f"/api/v1/runs/{run['id']}").json()["scenario"] == "drift"
    b = client.post("/api/v1/benchmark", json={"scenarios": ["spike", "gap"], "seeds": 5}).json()
    assert b["runs"] == 10 and b["total"]["monitor"]["false_alarms"] == 0
    bad = client.post("/api/v1/runs", json={"scenario": "drift", "config": {"no_such": 1}})
    assert bad.status_code == 422


def test_simulation_feeds_monitor_and_scores_labels(client):
    s = client.post("/api/v1/simulations", json={"scenario": "gap", "seed": 42, "speed": 1}).json()
    rt = hub.sensors[s["id"]]
    rt.clock = FakeClock(0.0)
    while not rt.finished:
        rt.clock.t += 5
        hub.advance()
    ev = client.get(f"/api/v1/sensors/{s['id']}/evaluation").json()
    assert ev["complete"] and ev["monitor"]["detected"] == 1 and ev["monitor"]["false_alarms"] == 0
    # в симуляцию телеметрию отправлять нельзя
    r = client.post("/api/v1/ingest", json={"messages": [{"sensor_id": s["id"], "event_time": 1, "value": 1}]})
    assert r.status_code == 409


def test_websocket_hello(client):
    client.post("/api/v1/sensors", json={"id": "ws-1", "profiles": {"A": {"mean": 1, "sigma": 1}}})
    with client.websocket_connect("/api/v1/ws") as ws:
        hello = ws.receive_json()
        assert hello["type"] == "hello" and hello["sensors"][0]["id"] == "ws-1"
        hub.advance()
        msg = ws.receive_json()
        assert msg["type"] == "tick" and msg["sensor_id"] == "ws-1"


def test_ingest_key(client):
    settings.ingest_key = "secret"
    try:
        body = {"messages": [{"sensor_id": "k-1", "event_time": 1, "value": 1}]}
        assert client.post("/api/v1/ingest", json=body).status_code == 401
        assert client.post("/api/v1/ingest", json=body, headers={"X-API-Key": "secret"}).status_code == 200
    finally:
        settings.ingest_key = ""
