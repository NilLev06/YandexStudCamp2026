"""Последовательный прогон сценария через монитор, пороговый метод и оценка.

replay() и evaluate() повторяют одноимённые функции demo/engine.js.
"""
from __future__ import annotations

from statistics import fmean

from .config import DEFAULT_CONFIG, DEFAULT_PROFILES, SCORED_TYPES, MonitorConfig, Profile
from .monitor import Monitor
from .scenarios import generate, scenario_profiles


class ThresholdBaseline:
    """Простой порог для сравнения: последнее свежее значение ниже mean - 4.5σ -> тревога."""

    def __init__(self, config: MonitorConfig, profiles: dict[str, Profile]):
        self.cfg = config
        self.profiles = profiles
        self.incidents: list[dict] = []
        self.active: dict | None = None

    def tick(self, now: float, incoming: list[dict]) -> None:
        fresh = [m for m in incoming if now - m["event_time"] <= self.cfg.bucket + self.cfg.lateness]
        if not fresh:
            return
        m = fresh[-1]
        profile = self.profiles.get(m.get("mode") or "A")
        if profile is None:
            return
        if m["value"] < profile.mean - self.cfg.baseline_sigma * profile.sigma:
            if not self.active:
                self.active = {"type": "quality", "start": now, "end": None,
                               "reason": f"Порог: значение ниже нормы на {self.cfg.baseline_sigma:g}σ"}
                self.incidents.append(self.active)
        elif self.active:
            self.active["end"] = now
            self.active = None


def replay(scenario: str = "combined", seed: int = 42, config: MonitorConfig | None = None,
           profiles: dict[str, Profile] | None = None, keep_messages: bool = True) -> dict:
    """Прогон по времени доставки: на шаге now монитор видит только пришедшее к now."""
    cfg = config or DEFAULT_CONFIG
    data = generate(scenario, seed)
    profs = dict(profiles if profiles is not None else scenario_profiles(scenario) or DEFAULT_PROFILES)
    monitor = Monitor(cfg, profs)
    baseline = ThresholdBaseline(cfg, profs)
    frames: list[dict] = []
    msgs = data["messages"]
    p = 0
    for now in range(data["duration"] + 1):
        incoming = []
        while p < len(msgs) and msgs[p]["received_at"] <= now:
            incoming.append(msgs[p])
            p += 1
        frames.append(monitor.tick(now, incoming))
        baseline.tick(now, incoming)
    # Как в engine.js: у порога нет своего таймера, доступность берём у монитора
    base = baseline.incidents + [dict(i) for i in monitor.incidents if i["type"] == "availability"]
    result = {**data, "frames": frames, "incidents": monitor.incidents, "events": monitor.events, "baseline": base,
              "config": cfg.as_dict(), "profiles": {k: v.as_dict() for k, v in profs.items()}}
    if not keep_messages:
        result.pop("messages")
    return result


def _score(incidents: list[dict], truth: list[dict], duration: float, tol: float) -> dict:
    matched: dict[int, dict] = {}
    delays: list[float] = []
    close_delays: list[float] = []
    false_alarms = repeats = unclosed = 0
    for inc in (i for i in incidents if i["type"] in SCORED_TYPES):
        j = next((k for k, t in enumerate(truth)
                  if t["type"] == inc["type"] and t["start"] - tol <= inc["start"] < t["end"]), -1)
        if j == -1:
            false_alarms += 1
            if inc["end"] is None:
                unclosed += 1
        elif j in matched:
            repeats += 1
            if inc["end"] is None and truth[j]["end"] < duration:
                unclosed += 1
        else:
            matched[j] = inc
            delays.append(max(0, inc["start"] - truth[j]["start"]))
    for j, inc in matched.items():
        t = truth[j]
        if inc["end"] is not None:
            close_delays.append(inc["end"] - t["end"])
        elif t["end"] < duration:
            unclosed += 1
    return {"detected": len(matched), "total": len(truth), "false_alarms": false_alarms, "repeats": repeats,
            "unclosed": unclosed, "delay": fmean(delays) if delays else None,
            "close_delay": fmean(close_delays) if close_delays else None, "closed": len(close_delays)}


def evaluate(result: dict, tol: float | None = None) -> dict:
    """Сравнение инцидентов с разметкой: обнаружено, ложные, повторы, задержки."""
    tol = DEFAULT_CONFIG.match_tolerance if tol is None else tol
    truth, duration = result["truth"], result["duration"]
    return {"monitor": _score(result["incidents"], truth, duration, tol),
            "baseline": _score(result["baseline"], truth, duration, tol)}


def score_incidents(incidents: list[dict], truth: list[dict], duration: float, tol: float | None = None) -> dict:
    """Оценка произвольного набора инцидентов (живой датчик + загруженная разметка)."""
    return _score(incidents, truth, duration, DEFAULT_CONFIG.match_tolerance if tol is None else tol)


def benchmark(scenarios: list[str], seeds: list[int], config: MonitorConfig | None = None,
              profiles: dict[str, Profile] | None = None) -> dict:
    """Пакетная проверка: сценарии x seed, суммы метрик по методам."""
    keys = ("detected", "total", "false_alarms", "repeats", "unclosed", "closed")
    per: dict[str, dict] = {}
    totals = {m: {k: 0 for k in keys} | {"delays": [], "close_delays": []} for m in ("monitor", "baseline")}
    for sc in scenarios:
        acc = {m: {k: 0 for k in keys} | {"delays": [], "close_delays": []} for m in ("monitor", "baseline")}
        for seed in seeds:
            ev = evaluate(replay(sc, seed, config, profiles, keep_messages=False))
            for method, met in ev.items():
                for k in keys:
                    acc[method][k] += met[k]
                    totals[method][k] += met[k]
                for src, dst in (("delay", "delays"), ("close_delay", "close_delays")):
                    if met[src] is not None:
                        acc[method][dst].append(met[src])
                        totals[method][dst].append(met[src])
        per[sc] = {m: _finish(a) for m, a in acc.items()}
    return {"runs": len(scenarios) * len(seeds), "scenarios": per, "total": {m: _finish(a) for m, a in totals.items()}}


def _finish(acc: dict) -> dict:
    out = {k: v for k, v in acc.items() if k not in ("delays", "close_delays")}
    out["delay"] = fmean(acc["delays"]) if acc["delays"] else None
    out["close_delay"] = fmean(acc["close_delays"]) if acc["close_delays"] else None
    return out
