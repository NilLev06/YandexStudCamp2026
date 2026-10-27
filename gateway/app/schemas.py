"""Модели запросов и ответов API (Pydantic v2)."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

QualityFlag = str  # "valid" | "invalid" | "degraded" | ... - всё, кроме "valid", считается непригодным


# ----------------------------------------------------------------------------- телеметрия
class MessageIn(BaseModel):
    """Одно измерение от источника. Время события - когда измерено (не когда доставлено)."""

    sensor_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_.:-]+$", examples=["camera-01"])
    event_time: float | datetime = Field(description="Время измерения: секунды (epoch или модельные) или ISO 8601")
    value: float | None = Field(description="Значение или score качества; null - измерения нет")
    mode: str | None = Field(default=None, max_length=64, description="Режим работы датчика (свой эталон на режим)")
    quality_flags: QualityFlag | None = Field(default="valid", description="valid или причина непригодности")
    id: str | int | None = Field(default=None, description="Идентификатор для удаления дублей")

    @field_validator("event_time")
    @classmethod
    def _to_seconds(cls, v: float | datetime) -> float:
        return v.timestamp() if isinstance(v, datetime) else float(v)


class IngestRequest(BaseModel):
    messages: list[MessageIn] = Field(min_length=1, max_length=10000)


class IngestResponse(BaseModel):
    accepted: int
    sensors: list[str]
    created: list[str]
    received_at: dict[str, float] = Field(description="Время приёма по часам каждого датчика")


# ----------------------------------------------------------------------------- датчики
class ProfileIn(BaseModel):
    mean: float
    sigma: float = Field(gt=0)
    assess: bool = True


class ProfileOut(ProfileIn):
    source: str


class SensorCreate(BaseModel):
    id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_.:-]+$")
    name: str | None = None
    unit: str | None = None
    description: str | None = None
    profiles: dict[str, ProfileIn] | None = Field(default=None, description="Эталоны режимов; нет - автокалибровка")
    config: dict[str, Any] | None = Field(default=None, description="Переопределение параметров монитора")
    tags: list[str] = Field(default_factory=list)


class SensorPatch(BaseModel):
    name: str | None = None
    unit: str | None = None
    description: str | None = None
    config: dict[str, Any] | None = None
    tags: list[str] | None = None


class CalibrateRequest(BaseModel):
    mode: str
    since: float | None = Field(default=None, description="Начало здорового интервала (время события)")
    until: float | None = None
    min_sigma: float = Field(default=1e-6, gt=0)
    assess: bool = True


class Label(BaseModel):
    """Разметка хранится отдельно и монитору не передаётся - только оценщику."""

    start: float
    end: float
    type: Literal["quality", "availability", "stuck", "noise", "rate"]
    label: str | None = None


class Status(BaseModel):
    model_config = ConfigDict(extra="allow")
    now: float
    mode: str
    quality: str
    availability: str
    flags: str


class SensorSummary(BaseModel):
    id: str
    name: str
    kind: Literal["live", "simulation"]
    clock: Literal["wall", "sim"]
    source: str
    unit: str | None
    description: str | None
    tags: list[str]
    created_at: float
    now: float | None
    finished: bool
    duration: float | None
    speed: float | None
    status: dict[str, Any] | None
    open_incidents: int
    messages: int
    profiles: dict[str, ProfileOut]


class SensorDetail(SensorSummary):
    config: dict[str, Any]
    labels: list[Label]
    annotations: list[dict[str, Any]]


# ----------------------------------------------------------------------------- инциденты и события
class Incident(BaseModel):
    id: str
    sensor_id: str
    type: str
    start: float
    end: float | None
    reason: str
    close_reason: str | None = None
    side: str | None = None
    open: bool
    acknowledged: bool = False
    ack_by: str | None = None
    ack_comment: str | None = None
    ack_at: float | None = None


class AckRequest(BaseModel):
    by: str = Field(default="оператор", max_length=64)
    comment: str | None = Field(default=None, max_length=500)


class Event(BaseModel):
    sensor_id: str
    time: float
    kind: str
    type: str
    text: str


# ----------------------------------------------------------------------------- сценарии и прогоны
class RunRequest(BaseModel):
    scenario: str = "combined"
    seed: int = Field(default=42, ge=0, le=2**32 - 1)
    config: dict[str, Any] | None = None


class BenchmarkRequest(BaseModel):
    scenarios: list[str] | None = Field(default=None, description="По умолчанию - все сценарии")
    seeds: int = Field(default=50, ge=1, le=500, description="Сколько seed (1..N) на сценарий")
    config: dict[str, Any] | None = None


class SimulationRequest(BaseModel):
    scenario: str = "combined"
    seed: int = Field(default=42, ge=0, le=2**32 - 1)
    speed: float = Field(default=6.0, gt=0, le=100, description="Во сколько раз быстрее реального времени")
    sensor_id: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_.:-]+$")
    config: dict[str, Any] | None = None
