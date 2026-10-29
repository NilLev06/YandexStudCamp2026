"""Состояние gateway: сенсоры, их мониторы, история и симуляции. Всё изменяется только из цикла событий asyncio."""
from __future__ import annotations

import math
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from itertools import count
from typing import Any, Literal

from .broker import Broker
from .engine import PROFILES, SCENARIOS, Incident, generate
from .schemas import TelemetryMessage
from .engine.live import LiveMonitor, LIVE_ALARMS
from .settings import Settings


class RegistryError(Exception):
    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


@dataclass
class Simulation:
    id: str
    sensor_id: str
    scenario: str
    seed: int
    speed: float
    data: dict[str, Any]
    started_at: float
    state: Literal['running', 'finished', 'stopped'] = 'running'
    position: int = -1
    cursor: int = 0

    def as_dict(self) -> dict[str, Any]:
        duration = self.data['duration']
        return {'id': self.id, 'sensor_id': self.sensor_id, 'scenario': self.scenario, 'seed': self.seed,
                'speed': self.speed, 'state': self.state, 'position': max(self.position, 0), 'duration': duration,
                'progress': round(max(self.position, 0) / duration, 4), 'started_at': self.started_at}


@dataclass
class SensorState:
    sensor_id: str
    source: Literal['ingest', 'simulation']
    clock: Literal['wall', 'virtual']
    created_at: float
    settings: Settings
    simulation: Simulation | None = None
    pending: list[dict[str, Any]] = field(default_factory=list)
    last_frame: dict[str, Any] | None = None

    def __post_init__(self) -> None:
        s = self.settings
        self.monitor = LiveMonitor()
        self.frames: deque[dict[str, Any]] = deque(maxlen=s.frame_history)
        self.measurements: deque[dict[str, Any]] = deque(maxlen=s.measurement_history)
        self.events: deque[dict[str, Any]] = deque(maxlen=s.event_history)
        self.incident_wall: dict[int, list[float | None]] = {}
        self.outbox: dict[str, list[dict[str, Any]]] = {'frames': [], 'measurements': [], 'events': []}

    def add_measurement(self, record: dict[str, Any]) -> None:
        self.measurements.append(record)
        self.outbox['measurements'].append(record)

    def add_frame(self, frame: dict[str, Any]) -> None:
        self.last_frame = frame
        self.frames.append(frame)
        self.outbox['frames'].append(frame)

    def take_outbox(self) -> dict[str, list[dict[str, Any]]]:
        out, self.outbox = self.outbox, {'frames': [], 'measurements': [], 'events': []}
        return out


class Registry:
    def __init__(self, settings: Settings, broker: Broker, time_fn: Callable[[], float] = time.time) -> None:
        self.settings = settings
        self.broker = broker
        self.time_fn = time_fn
        self.started_at = time_fn()
        self.sensors: dict[str, SensorState] = {}
        self.simulations: dict[str, Simulation] = {}
        self._seq = count(1)
        self._sim_ids = count(1)
        self._wall = self.started_at

    def _create(self, sensor_id: str, source: Literal['ingest', 'simulation'], clock: Literal['wall', 'virtual'],
                simulation: Simulation | None = None) -> SensorState:
        if len(self.sensors) >= self.settings.max_sensors:
            raise RegistryError(429, 'Достигнут предел числа сенсоров')
        sensor = SensorState(sensor_id, source, clock, self.time_fn(), self.settings, simulation)
        sensor.monitor.on_event = lambda event, s=sensor: self._on_event(s, event)
        self.sensors[sensor_id] = sensor
        self.broker.publish({'type': 'sensor_added', 'sensor_id': sensor_id, 'summary': self.summary(sensor)})
        return sensor

    def _on_event(self, sensor: SensorState, event: dict[str, Any]) -> None:
        record = {'seq': next(self._seq), 'sensor_id': sensor.sensor_id, 'wall_time': self._wall,
                  'incident_id': event.get('incident_id'), **{k: event[k] for k in ('time', 'kind', 'type', 'text')}}
        sensor.events.append(record)
        sensor.outbox['events'].append(record)
        if record['incident_id'] is not None:
            if event['kind'] == 'open':
                sensor.incident_wall[record['incident_id']] = [self._wall, None]
            else:
                sensor.incident_wall.setdefault(record['incident_id'], [self._wall, None])[1] = self._wall

    def get(self, sensor_id: str) -> SensorState:
        sensor = self.sensors.get(sensor_id)
        if sensor is None:
            raise RegistryError(404, 'Сенсор не найден')
        return sensor

    def ingest(self, messages: list[TelemetryMessage]) -> dict[str, Any]:
        now = self.time_fn()
        accepted = 0
        rejected: list[dict[str, Any]] = []
        for index, m in enumerate(messages):
            if m.event_time > now + self.settings.max_future_skew:
                rejected.append({'index': index, 'sensor_id': m.sensor_id, 'reason': 'Время измерения в будущем: часы сенсора спешат'})
                continue
            sensor = self.sensors.get(m.sensor_id)
            if sensor is None:
                try:
                    sensor = self._create(m.sensor_id, 'ingest', 'wall')
                except RegistryError as e:
                    rejected.append({'index': index, 'sensor_id': m.sensor_id, 'reason': e.detail})
                    continue
            elif sensor.source != 'ingest':
                rejected.append({'index': index, 'sensor_id': m.sensor_id, 'reason': 'Сенсор занят симуляцией'})
                continue
            message = m.model_dump()
            message['received_at'] = now
            sensor.pending.append(message)
            sensor.add_measurement(_measurement(message))
            accepted += 1
        return {'accepted': accepted, 'rejected': rejected, 'received_at': now}

    def start_simulation(self, scenario: str, seed: int, speed: float, sensor_id: str | None) -> Simulation:
        if scenario not in SCENARIOS:
            raise RegistryError(422, 'Неизвестный сценарий: ' + scenario)
        if speed > self.settings.max_simulation_speed:
            raise RegistryError(422, 'Скорость не больше ' + str(self.settings.max_simulation_speed))
        if sensor_id is None:
            base = sensor_id = f'sim-{scenario}-{seed}'
            for n in range(2, 10_000):
                if sensor_id not in self.sensors:
                    break
                sensor_id = f'{base}-{n}'
        elif sensor_id in self.sensors:
            raise RegistryError(409, 'Сенсор с таким идентификатором уже существует')
        sim = Simulation(f'sim-{next(self._sim_ids)}', sensor_id, scenario, seed, speed, generate(scenario, seed), self.time_fn())
        self._create(sensor_id, 'simulation', 'virtual', sim)
        self.simulations[sim.id] = sim
        return sim

    def stop_simulation(self, sim_id: str) -> Simulation:
        sim = self.simulations.get(sim_id)
        if sim is None:
            raise RegistryError(404, 'Симуляция не найдена')
        if sim.state == 'running':
            sim.state = 'stopped'
            sensor = self.sensors.get(sim.sensor_id)
            if sensor:
                self._publish_update(sensor)
        return sim

    def delete(self, sensor_id: str) -> None:
        sensor = self.get(sensor_id)
        if sensor.simulation:
            sensor.simulation.state = 'stopped'
            self.simulations.pop(sensor.simulation.id, None)
        del self.sensors[sensor_id]
        self.broker.publish({'type': 'sensor_removed', 'sensor_id': sensor_id})

    def tick(self) -> None:
        wall = self._wall = self.time_fn()
        for sensor in list(self.sensors.values()):
            sim = sensor.simulation
            if sim is None:
                incoming, sensor.pending = sensor.pending, []
                sensor.add_frame(sensor.monitor.tick(wall, incoming).as_dict())
            elif sim.state == 'running':
                messages = sim.data['messages']
                target = min(sim.data['duration'], math.floor((wall - sim.started_at) * sim.speed))
                for t in range(sim.position + 1, target + 1):
                    incoming = []
                    while sim.cursor < len(messages) and messages[sim.cursor]['received_at'] <= t:
                        incoming.append(messages[sim.cursor])
                        sensor.add_measurement(_measurement(messages[sim.cursor]))
                        sim.cursor += 1
                    sensor.add_frame(sensor.monitor.tick(t, incoming).as_dict())
                    sim.position = t
                if sim.position >= sim.data['duration']:
                    sim.state = 'finished'
            else:
                continue
            self._publish_update(sensor)

    def _publish_update(self, sensor: SensorState) -> None:
        self.broker.publish({'type': 'update', 'sensor_id': sensor.sensor_id, **sensor.take_outbox(), 'summary': self.summary(sensor)})

    def incidents(self, sensor: SensorState) -> list[dict[str, Any]]:
        return [self._incident(sensor, i) for i in sensor.monitor.incidents]

    def _incident(self, sensor: SensorState, incident: Incident) -> dict[str, Any]:
        opened_at, closed_at = sensor.incident_wall.get(incident.id, [self._wall, None])
        return {**incident.as_dict(), 'sensor_id': sensor.sensor_id, 'state': 'open' if incident.end is None else 'closed',
                'opened_at': opened_at, 'closed_at': closed_at}

    def summary(self, sensor: SensorState) -> dict[str, Any]:
        open_incidents = [i for i in sensor.monitor.incidents if i.end is None]
        return {'sensor_id': sensor.sensor_id, 'source': sensor.source, 'clock': sensor.clock, 'created_at': sensor.created_at,
                'status': sensor.last_frame, 'open_incidents': [self._incident(sensor, i) for i in open_incidents],
                'simulation': sensor.simulation.as_dict() if sensor.simulation else None}

    def detail(self, sensor: SensorState) -> dict[str, Any]:
        data = sensor.simulation.data if sensor.simulation else {}
        return {**self.summary(sensor), 'truth': data.get('truth', []), 'annotations': data.get('annotations', []),
                'profiles': PROFILES}

    def overview(self) -> dict[str, Any]:
        quality = dict.fromkeys(('normal', 'suspect', 'alarm', 'unknown'), 0)
        availability = dict.fromkeys(('fresh', 'stale', 'unknown'), 0)
        incidents = dict.fromkeys(LIVE_ALARMS, 0)
        flags = 0
        for sensor in self.sensors.values():
            frame = sensor.last_frame
            quality[frame['quality'] if frame else 'unknown'] += 1
            availability[frame['availability'] if frame else 'unknown'] += 1
            flags += bool(frame and frame['flags'] == 'degraded')
            m = sensor.monitor
            for i in m.incidents:
                if i.end is None:
                    incidents[i.type] += 1
        return {'sensors': len(self.sensors), 'quality': quality, 'availability': availability,
                'flags_degraded': flags, 'open_incidents': incidents}

    def health(self) -> dict[str, Any]:
        running = sum(1 for s in self.simulations.values() if s.state == 'running')
        return {'sensors': len(self.sensors), 'simulations_running': running, 'subscribers': self.broker.subscribers,
                'uptime_s': round(self.time_fn() - self.started_at, 3)}


def _measurement(m: dict[str, Any]) -> dict[str, Any]:
    return {k: m[k] for k in ('event_time', 'received_at', 'value', 'mode', 'quality_flags')}
