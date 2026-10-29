from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field, StrictInt

from ..engine.seeds import SEED
from ..engine.single_scenarios import replay_single

router = APIRouter(tags=['Тревоги одного датчика'])


class SingleReplayRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    scenario: Literal['normal', 'drift', 'rise', 'step', 'noise', 'periodic', 'stuck', 'saturation',
                      'spike', 'jumps', 'invalid', 'gap', 'delay', 'rate', 'mode'] = 'noise'
    seed: StrictInt = Field(default=42, ge=SEED['min'], le=SEED['max'])


class SingleReplayOut(BaseModel):
    scenario: str
    seed: int
    duration: int
    config: dict[str, float]
    profiles: dict[str, dict[str, float]]
    alarm_names: dict[str, str]
    scenarios: dict[str, str]
    messages: list[dict[str, Any]]
    frames: list[dict[str, Any]]
    incidents: list[dict[str, Any]]
    events: list[dict[str, Any]]
    truth: list[dict[str, Any]]


@router.post('/single-replays', response_model=SingleReplayOut,
             summary='Воспроизвести нарушения одного датчика',
             description='Синтетический эксперимент: независимые тревоги с причинами и подтверждением восстановления. '
                         'Профиль задаёт диапазон, скорость, частоту и ожидаемую динамику. Разметка монитору недоступна.')
def single_replay(body: SingleReplayRequest) -> dict:
    return replay_single(body.scenario, body.seed)
