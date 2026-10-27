"""Поведенческие тесты ядра: сценарии кейса, расширения и совпадение с demo/engine.js."""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from sensorwatch import (MonitorConfig, Monitor, Profile, benchmark, evaluate, generate, replay)

ROOT = Path(__file__).resolve().parents[2]


def types(result):
    return [(i["type"], i["start"], i["end"]) for i in result["incidents"]]


def test_deterministic_seed():
    assert generate("combined", 42) == generate("combined", 42)
    assert generate("combined", 42)["messages"] != generate("combined", 43)["messages"]


def test_truth_is_separate_from_input():
    data = generate("drift", 7)
    assert all("truth" not in m and "label" not in m for m in data["messages"])
    assert data["truth"][0]["type"] == "quality"


def test_spike_is_not_an_incident():
    # Сценарий 1 кейса: краткий одиночный выброс - монитор молчит, порог срабатывает
    r = replay("spike", 42)
    assert types(r) == []
    assert evaluate(r)["baseline"]["false_alarms"] == 1


def test_drift_opens_once_and_closes_after_recovery():
    # Сценарий 2: плавное ухудшение и возврат - один инцидент, закрытие после возврата
    r = replay("drift", 42)
    q = [i for i in r["incidents"] if i["type"] == "quality"]
    assert len(q) == 1 and 60 <= q[0]["start"] < 110 and q[0]["end"] is not None and q[0]["end"] >= 170


def test_gap_and_late_batch():
    # Сценарий 3: пропуск, затем поздние значения - старая пачка не закрывает инцидент свежести
    r = replay("gap", 42)
    a = [i for i in r["incidents"] if i["type"] == "availability"]
    assert len(a) == 1 and a[0]["start"] == 66 and a[0]["end"] >= 120
    assert r["frames"][111]["availability"] == "stale"     # пачка пришла в 110, данные всё ещё старые


def test_mode_change_is_not_degradation():
    assert types(replay("mode", 42)) == []


@pytest.mark.parametrize("scenario", ["stuck", "noise", "rate"])
def test_extended_scenarios_detected(scenario):
    m = evaluate(replay(scenario, 42))["monitor"]
    assert m["detected"] == 1 and m["false_alarms"] == 0


def test_base_scenarios_have_no_false_alarms_on_50_seeds():
    b = benchmark(["combined", "spike", "drift", "gap", "mode"], list(range(1, 51)))
    t = b["total"]["monitor"]
    assert t["detected"] == t["total"] == 200 and t["false_alarms"] == 0 and t["repeats"] == 0


def test_two_sided_cusum_catches_upward_drift():
    mon = Monitor(MonitorConfig(direction="both"), {"A": Profile(10.0, 0.5)})
    opened = None
    for now in range(200):
        v = 10.0 + (0.0 if now < 60 else min(3.0, (now - 60) * 0.05)) + (0.3 if now % 2 else -0.3)
        f = mon.tick(now, [{"id": now, "event_time": now, "received_at": now, "value": v, "mode": "A"}])
        if f["quality"] == "alarm" and opened is None:
            opened = now
    assert opened is not None and mon.incidents[0]["side"] == "up"


def test_one_sided_ignores_upward_drift():
    mon = Monitor(MonitorConfig(direction="down"), {"A": Profile(10.0, 0.5)})
    for now in range(200):
        v = 10.0 + (0.0 if now < 60 else 3.0) + (0.3 if now % 2 else -0.3)
        mon.tick(now, [{"id": now, "event_time": now, "received_at": now, "value": v, "mode": "A"}])
    assert not [i for i in mon.incidents if i["type"] == "quality"]


def test_auto_calibration_learns_unknown_mode():
    mon = Monitor(MonitorConfig(calib_samples=30), {})
    for now in range(120):
        v = 50.0 + (0.4 if now % 3 == 0 else -0.2)
        mon.tick(now, [{"id": now, "event_time": now, "received_at": now, "value": v, "mode": "hover"}])
    prof = mon.profiles["hover"]
    assert prof.source == "auto" and abs(prof.mean - 49.8) < 0.3
    assert any(e["kind"] == "calibrated" for e in mon.events)


def test_epoch_time_first_tick_is_fast():
    # Время epoch: первый тик не должен перебирать окна с нуля
    mon = Monitor(profiles={"A": Profile(95, 1.5)})
    t0 = 1_793_000_000
    for k in range(20):
        mon.tick(t0 + k, [{"id": k, "event_time": t0 + k, "received_at": t0 + k, "value": 95.0, "mode": "A"}])
    assert mon.accepted == 20


@pytest.mark.skipif(shutil.which("node") is None, reason="нужен Node.js")
def test_parity_with_engine_js():
    """Python-ядро повторяет demo/engine.js: те же данные, инциденты, события и S на каждом шаге."""
    seeds = list(range(1, 21))
    out = subprocess.check_output(["node", str(ROOT / "gateway/tests/parity/dump_js.cjs"),
                                   "combined,spike,drift,gap,mode", ",".join(map(str, seeds))])
    js = json.loads(out)
    for key, j in js.items():
        sc, seed = key.split(":")
        r = replay(sc, int(seed))
        assert [[m["event_time"], m["received_at"], m["value"], m["mode"]] for m in r["messages"]] == j["messages"]
        assert [[i["type"], i["start"], i["end"]] for i in r["incidents"]] == j["incidents"]
        assert [[e["time"], e["kind"], e["type"]] for e in r["events"]] == j["events"]
        assert [f["s"] for f in r["frames"]] == j["s"]


def test_waiting_for_first_message_option():
    quiet = Monitor(MonitorConfig(alarm_before_first=False), {"A": Profile(1, 1)})
    loud = Monitor(MonitorConfig(), {"A": Profile(1, 1)})
    for now in range(20):
        quiet.tick(now, [])
        loud.tick(now, [])
    assert not quiet.incidents and loud.incidents[0]["type"] == "availability"
