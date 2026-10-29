from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .engine.seeds import SEED

SeedValue = Field(default=42, ge=SEED['min'], le=SEED['max'], description=f"Целое число от {SEED['min']} до {SEED['max']}")
SensorId = Field(pattern=r'^[A-Za-z0-9_.:-]{1,64}$', examples=['camera-01'])
IncidentType = Literal['quality', 'availability', 'flags', 'noise', 'stuck', 'saturation', 'rate', 'latency']
QualityStatus = Literal['normal', 'suspect', 'alarm', 'unknown']
AvailabilityStatus = Literal['fresh', 'stale', 'unknown']


class TelemetryMessage(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False, extra='forbid')

    sensor_id: str = SensorId
    event_time: float = Field(description='Время измерения, секунды Unix', examples=[1761600000.0])
    value: float | None = Field(description='Значение; null — измерение непригодно', examples=[95.2])
    mode: str = Field(min_length=1, max_length=32, examples=['A'])
    quality_flags: str = Field(default='valid', max_length=32, description='Всё, кроме valid, исключает измерение из анализа')
    id: int | str | None = Field(default=None, description='Идентификатор для удаления дублей')


class TelemetryBatch(BaseModel):
    messages: list[TelemetryMessage] = Field(min_length=1, max_length=5000)


class Rejection(BaseModel):
    index: int
    sensor_id: str
    reason: str


class IngestResult(BaseModel):
    accepted: int
    rejected: list[Rejection]
    received_at: float


class FrameOut(BaseModel):
    now: float
    mode: str
    mode_known: bool
    s: float
    z: float
    aggregate: float | None
    aggregate_time: float | None
    quality: QualityStatus
    availability: AvailabilityStatus
    flags: Literal['ok', 'degraded']
    age: float | None
    since_receipt: float | None
    late_count: int
    accepted: int
    events: int
    alarm_count: int = 0
    comment: str = ''


class Measurement(BaseModel):
    event_time: float
    received_at: float
    value: float | None
    mode: str
    quality_flags: str


class EventOut(BaseModel):
    seq: int
    sensor_id: str
    time: float
    wall_time: float
    kind: str
    type: str
    text: str
    incident_id: int | None = None


class IncidentOut(BaseModel):
    id: int
    sensor_id: str
    type: IncidentType
    start: float
    end: float | None
    reason: str
    highlight_end: float | None = None
    state: Literal['open', 'closed']
    opened_at: float = Field(description='Время открытия по часам gateway, секунды Unix')
    closed_at: float | None


class SimulationCreate(BaseModel):
    model_config = ConfigDict(strict=True)

    scenario: str = Field(default='combined', examples=['combined'])
    seed: int = SeedValue
    speed: float = Field(default=6, gt=0, description='Модельных секунд за секунду реального времени')
    sensor_id: str | None = Field(default=None, pattern=r'^[A-Za-z0-9_.:-]{1,64}$')


class SimulationOut(BaseModel):
    id: str
    sensor_id: str
    scenario: str
    seed: int
    speed: float
    state: Literal['running', 'finished', 'stopped']
    position: int
    duration: int
    progress: float
    started_at: float


class SensorSummary(BaseModel):
    sensor_id: str
    source: Literal['ingest', 'simulation']
    clock: Literal['wall', 'virtual'] = Field(description='wall — секунды Unix, virtual — модельные секунды от начала сценария')
    created_at: float
    status: FrameOut | None
    open_incidents: list[IncidentOut]
    simulation: SimulationOut | None


class Interval(BaseModel):
    start: float
    end: float
    label: str
    type: str | None = None
    kind: str | None = None


class SensorDetail(SensorSummary):
    truth: list[Interval]
    annotations: list[Interval]
    profiles: dict[str, dict[str, float]]


class ScenarioOut(BaseModel):
    id: str
    name: str
    duration: int
    description: str


class RecommendedSeed(BaseModel):
    seed: int
    kind: Literal['reference', 'fastest', 'slowest', 'unclosed', 'near_miss']
    label: str
    note: str
    value: float | None = None


class MetaOut(BaseModel):
    version: str
    config: dict[str, float]
    profiles: dict[str, dict[str, float]]
    scenarios: list[ScenarioOut]
    seed: dict[str, int] = Field(description='Границы seed: min, max и диапазон, на котором выбраны рекомендации (scan)')
    recommended_seeds: dict[str, list[RecommendedSeed]]
    limits: dict[str, float]
    auth_required: bool


class HealthOut(BaseModel):
    status: Literal['ok']
    version: str
    uptime_s: float
    sensors: int
    simulations_running: int
    subscribers: int


class Overview(BaseModel):
    sensors: int
    quality: dict[QualityStatus, int]
    availability: dict[AvailabilityStatus, int]
    flags_degraded: int
    open_incidents: dict[IncidentType, int]


class Metrics(BaseModel):
    detected: int
    total: int
    false_alarms: int
    repeats: int
    unclosed: int
    delay: float | None
    close_delay: float | None
    closed: int

    @classmethod
    def from_engine(cls, m: dict[str, Any]) -> 'Metrics':
        return cls(detected=m['detected'], total=m['total'], false_alarms=m['falseAlarms'], repeats=m['repeats'],
                   unclosed=m['unclosed'], delay=m['delay'], close_delay=m['closeDelay'], closed=m['closed'])


class MethodMetrics(BaseModel):
    monitor: Metrics
    baseline: Metrics


class ReplayRequest(BaseModel):
    model_config = ConfigDict(strict=True)

    scenario: str = Field(default='combined', examples=['combined'])
    seed: int = SeedValue


class ReplayIncident(BaseModel):
    id: int | None = None
    type: str
    start: float
    end: float | None
    reason: str


class ReplayEvent(BaseModel):
    time: float
    kind: str
    type: str
    text: str
    incident_id: int | None = None


class ReplayMessage(BaseModel):
    id: int
    sensor_id: str
    event_time: float
    received_at: float
    value: float
    mode: str
    quality_flags: str


class ReplayOut(BaseModel):
    scenario: str
    seed: int
    duration: int
    messages: list[ReplayMessage]
    truth: list[Interval]
    annotations: list[Interval]
    frames: list[FrameOut]
    incidents: list[ReplayIncident]
    events: list[ReplayEvent]
    baseline: list[ReplayIncident]
    metrics: MethodMetrics


class BenchmarkRequest(BaseModel):
    scenarios: list[str] | None = Field(default=None, description='По умолчанию все сценарии')
    model_config = ConfigDict(strict=True)

    seed_from: int = Field(default=1, ge=SEED['min'], le=SEED['max'])
    seed_to: int = Field(default=50, ge=SEED['min'], le=SEED['max'])


class BenchmarkOut(MethodMetrics):
    runs: int
    scenarios: list[str]
    seed_from: int
    seed_to: int
    elapsed_ms: float
