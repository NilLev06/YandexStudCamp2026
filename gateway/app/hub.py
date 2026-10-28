"""Состояние шлюза: датчики, их часы и мониторы, планировщик тиков, рассылка по WebSocket.

Каждый датчик живёт по своим часам:
- wall - настенное время (живые источники: дрон, оборудование), event_time в секундах epoch;
- sim  - модельное время симуляции с ускорением (сценарии), event_time в секундах от начала.
Планировщик раз в loop_interval догоняет часы каждого датчика шагами по 1 с и вызывает
monitor.tick(now, пришедшее_к_now). Тик идёт и без входящих данных - иначе пропуск не заметить.
"""
from __future__ import annotations

import asyncio
import bisect
import logging
import math
import time
from collections import OrderedDict, deque
from dataclasses import dataclass, field
from typing import Any

from sensorwatch import (DEFAULT_PROFILES, Monitor, MonitorConfig, Profile, SCENARIOS, ThresholdBaseline,
                         generate, scenario_profiles, score_incidents)

from .settings import settings

log = logging.getLogger("sensorwatch.hub")


class WallClock:
    kind = "wall"
    speed = None

    def now(self) -> float:
        return time.time()


class SimClock:
    """Модельное время: стартует с 0 и идёт в speed раз быстрее настенного."""

    kind = "sim"

    def __init__(self, speed: float):
        self.speed = speed
        self._t0 = time.monotonic()

    def now(self) -> float:
        return (time.monotonic() - self._t0) * self.speed


@dataclass
class SensorRuntime:
    id: str
    name: str
    kind: str                      # live | simulation
    source: str                    # api | simulation:<сценарий> | webots | ...
    clock: Any
    monitor: Monitor
    baseline: ThresholdBaseline
    unit: str | None = None
    description: str | None = None
    tags: list[str] = field(default_factory=list)
    created_at: float = field(default_factory=time.time)
    inbox: list[tuple[float, int, dict]] = field(default_factory=list)   # (received_at, порядок, сообщение)
    feed: deque = field(default_factory=deque)                           # ещё не доставленные сообщения сценария
    messages: deque = field(default_factory=lambda: deque(maxlen=settings.history))
    frames: deque = field(default_factory=lambda: deque(maxlen=settings.history))
    labels: list[dict] = field(default_factory=list)
    annotations: list[dict] = field(default_factory=list)
    duration: float | None = None
    next_tick: float | None = None
    finished: bool = False
    last_frame: dict | None = None
    received: int = 0
    _seq: int = 0

    def push(self, msg: dict) -> None:
        """Положить сообщение во входящие (упорядочено по времени приёма)."""
        self._seq += 1
        bisect.insort(self.inbox, (msg["received_at"], self._seq, msg))
        self.received += 1


class Hub:
    def __init__(self) -> None:
        self.sensors: "OrderedDict[str, SensorRuntime]" = OrderedDict()
        self.incidents: dict[str, tuple[str, dict]] = {}       # id -> (sensor_id, инцидент монитора)
        self.subscribers: set[asyncio.Queue] = set()
        self.runs: "OrderedDict[str, dict]" = OrderedDict()
        self.benchmarks: dict[str, dict] = {}
        self._task: asyncio.Task | None = None
        self._pending: list[dict] = []                          # события текущего тика для рассылки

    # ------------------------------------------------------------------ жизненный цикл
    async def start(self) -> None:
        self._task = asyncio.create_task(self._loop(), name="sensorwatch-ticker")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def _loop(self) -> None:
        while True:
            try:
                self.advance()
            except Exception:  # планировщик не должен падать из-за одного датчика
                log.exception("ошибка в тике")
            await asyncio.sleep(settings.loop_interval)

    # ------------------------------------------------------------------ датчики
    def _make_monitor(self, sensor_id: str, config: MonitorConfig, profiles: dict[str, Profile]) -> Monitor:
        def on_event(item: dict) -> None:
            if item["kind"] == "incident_open":
                inc = item["incident"]
                inc_id = f"{sensor_id}~{inc['seq']}"
                inc["id"] = inc_id
                self.incidents[inc_id] = (sensor_id, inc)
            self._pending.append({"sensor_id": sensor_id, **item})
        return Monitor(config, profiles, on_event)

    def create_sensor(self, sensor_id: str, *, kind: str = "live", source: str = "api", clock: Any = None,
                      config: MonitorConfig | None = None, profiles: dict[str, Profile] | None = None,
                      name: str | None = None, unit: str | None = None, description: str | None = None,
                      tags: list[str] | None = None) -> SensorRuntime:
        if sensor_id in self.sensors:
            raise KeyError(f"Датчик {sensor_id} уже существует")
        cfg = config or MonitorConfig(calib_samples=settings.auto_calib_samples if not profiles else 0)
        profs = dict(profiles or {})
        rt = SensorRuntime(id=sensor_id, name=name or sensor_id, kind=kind, source=source,
                           clock=clock or WallClock(), monitor=self._make_monitor(sensor_id, cfg, profs),
                           baseline=ThresholdBaseline(cfg, profs), unit=unit, description=description,
                           tags=list(tags or []))
        rt.baseline.profiles = rt.monitor.profiles      # порог видит те же (в т.ч. откалиброванные) эталоны
        self.sensors[sensor_id] = rt
        self.broadcast({"type": "sensor", "sensor": self.summary(rt)})
        return rt

    def remove_sensor(self, sensor_id: str) -> None:
        self.sensors.pop(sensor_id)
        for inc_id in [i for i, (sid, _) in self.incidents.items() if sid == sensor_id]:
            del self.incidents[inc_id]
        self.broadcast({"type": "sensor_removed", "sensor_id": sensor_id})

    def reset_sensor(self, rt: SensorRuntime) -> None:
        """Сбросить накопленное состояние монитора, эталоны и конфигурацию сохранить."""
        for inc_id in [i for i, (sid, _) in self.incidents.items() if sid == rt.id]:
            del self.incidents[inc_id]
        rt.monitor = self._make_monitor(rt.id, rt.monitor.cfg, rt.monitor.profiles)
        rt.baseline = ThresholdBaseline(rt.monitor.cfg, rt.monitor.profiles)
        rt.messages.clear()
        rt.frames.clear()
        rt.last_frame = None
        rt.next_tick = None

    def start_simulation(self, scenario: str, seed: int, speed: float, sensor_id: str | None,
                         config: MonitorConfig | None) -> SensorRuntime:
        if scenario not in SCENARIOS:
            raise KeyError(f"Неизвестный сценарий: {scenario}")
        sid = sensor_id or f"sim-{scenario}-{seed}"
        if sid in self.sensors:
            self.remove_sensor(sid)
        data = generate(scenario, seed, sensor_id=sid)
        rt = self.create_sensor(
            sid, kind="simulation", source=f"simulation:{scenario}", clock=SimClock(speed),
            config=config or MonitorConfig(), profiles=dict(scenario_profiles(scenario) or DEFAULT_PROFILES),
            name=f"{SCENARIOS[scenario]['name']} (seed {seed})",
            unit={"pair": "°C (y2 - y1)", "gain": "изм./зад."}.get(scenario, "score"),
            description=SCENARIOS[scenario]["description"], tags=["демо", scenario])
        rt.feed = deque(data["messages"])
        rt.labels = data["truth"]                   # разметка - только для оценщика
        rt.annotations = data["annotations"]
        rt.duration = data["duration"]
        rt.next_tick = 0.0
        return rt

    # ------------------------------------------------------------------ приём
    def ingest(self, messages: list[dict], auto_create: bool = True) -> tuple[int, list[str], list[str], dict]:
        created: list[str] = []
        touched: list[str] = []
        received_at: dict[str, float] = {}
        for m in messages:
            sid = m["sensor_id"]
            rt = self.sensors.get(sid)
            if rt is None:
                if not auto_create:
                    raise KeyError(sid)
                rt = self.create_sensor(sid, source="api")
                created.append(sid)
            if rt.kind == "simulation":
                raise ValueError(f"Датчик {sid} - симуляция, телеметрию в него отправлять нельзя")
            now = received_at.setdefault(sid, rt.clock.now())
            rt.push({**m, "received_at": now})      # время приёма ставит шлюз, а не источник
            if sid not in touched:
                touched.append(sid)
        return len(messages), touched, created, received_at

    # ------------------------------------------------------------------ тики
    def advance(self) -> None:
        for rt in list(self.sensors.values()):
            if rt.finished:
                continue
            target = rt.clock.now()
            if rt.next_tick is None:
                rt.next_tick = math.floor(target)
            steps = 0
            while rt.next_tick <= target and steps < 200 and not rt.finished:
                self._tick(rt, rt.next_tick)
                rt.next_tick += settings.tick_step
                steps += 1

    def _tick(self, rt: SensorRuntime, now: float) -> None:
        incoming: list[dict] = []
        while rt.feed and rt.feed[0]["received_at"] <= now:
            incoming.append(rt.feed.popleft())
        while rt.inbox and rt.inbox[0][0] <= now:
            incoming.append(rt.inbox.pop(0)[2])
        self._pending = []
        frame = rt.monitor.tick(now, incoming)
        rt.baseline.tick(now, incoming)
        rt.last_frame = frame
        rt.frames.append(frame)
        slim = [{"event_time": m["event_time"], "received_at": m["received_at"], "value": m.get("value"),
                 "mode": m.get("mode"), "quality_flags": m.get("quality_flags")} for m in incoming]
        rt.messages.extend(slim)
        payload = {"type": "tick", "sensor_id": rt.id, "frame": frame, "messages": slim}
        if self._pending:
            payload["events"] = [self._public_event(e) for e in self._pending]
        self.broadcast(payload)
        if rt.duration is not None and now >= rt.duration and not rt.feed:
            rt.finished = True
            self.broadcast({"type": "sensor", "sensor": self.summary(rt)})

    def _public_event(self, e: dict) -> dict:
        if e["kind"] in ("incident_open", "incident_close"):
            return {"kind": e["kind"], "incident": self.incident_view(e["sensor_id"], e["incident"])}
        return {k: v for k, v in e.items()}

    # ------------------------------------------------------------------ рассылка
    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=2000)
        self.subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self.subscribers.discard(q)

    def broadcast(self, payload: dict) -> None:
        for q in list(self.subscribers):
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:   # медленный клиент: пропускаем, он перечитает историю по REST
                pass

    # ------------------------------------------------------------------ представления
    def incident_view(self, sensor_id: str, inc: dict) -> dict:
        return {"id": inc.get("id", f"{sensor_id}~{inc['seq']}"), "sensor_id": sensor_id, "type": inc["type"],
                "start": inc["start"], "end": inc["end"], "reason": inc["reason"],
                "close_reason": inc.get("close_reason"), "side": inc.get("side"), "open": inc["end"] is None,
                "acknowledged": inc.get("acknowledged", False), "ack_by": inc.get("ack_by"),
                "ack_comment": inc.get("ack_comment"), "ack_at": inc.get("ack_at")}

    def open_incidents(self, rt: SensorRuntime) -> int:
        return sum(1 for i in rt.monitor.incidents if i["end"] is None)

    def summary(self, rt: SensorRuntime) -> dict:
        return {
            "id": rt.id, "name": rt.name, "kind": rt.kind, "clock": rt.clock.kind, "source": rt.source,
            "unit": rt.unit, "description": rt.description, "tags": rt.tags, "created_at": rt.created_at,
            "now": rt.last_frame["now"] if rt.last_frame else None, "finished": rt.finished,
            "duration": rt.duration, "speed": getattr(rt.clock, "speed", None),
            "status": _status(rt.last_frame), "open_incidents": self.open_incidents(rt),
            "messages": len(rt.messages),
            "profiles": {k: v.as_dict() for k, v in rt.monitor.profiles.items()},
        }

    def detail(self, rt: SensorRuntime) -> dict:
        return {**self.summary(rt), "config": rt.monitor.cfg.as_dict(), "labels": rt.labels,
                "annotations": rt.annotations}

    def evaluation(self, rt: SensorRuntime) -> dict:
        now = rt.last_frame["now"] if rt.last_frame else 0.0
        duration = rt.duration if rt.duration is not None else now
        base = rt.baseline.incidents + [dict(i) for i in rt.monitor.incidents if i["type"] == "availability"]
        return {"labels": len(rt.labels), "until": now, "complete": rt.finished or rt.duration is None,
                "monitor": score_incidents(rt.monitor.incidents, rt.labels, duration),
                "baseline": score_incidents(base, rt.labels, duration)}


def _status(frame: dict | None) -> dict | None:
    if frame is None:
        return None
    keys = ("now", "mode", "mode_known", "quality", "availability", "flags", "diagnostics", "s", "z",
            "aggregate", "age", "norm", "sigma", "noise_ratio", "rate_ratio")
    return {k: frame.get(k) for k in keys}


hub = Hub()
