from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, StrictInt

from ..engine.pair import replay_pair
from ..engine.seeds import SEED

router = APIRouter(tags=['Несколько датчиков'])


class PairReplayRequest(BaseModel):
    scenario: Literal['normal', 'drift', 'dual_drift', 'spike', 'gap'] = 'drift'
    sensor_count: Literal[2, 3] = 2
    seed: StrictInt = Field(default=42, ge=SEED['min'], le=SEED['max'])


class PairReplayOut(BaseModel):
    sensor_count: int
    sensor_ids: list[str]
    scenario: str
    seed: int
    duration: int
    config: dict[str, float]
    messages: list[dict[str, Any]]
    frames: list[dict[str, Any]]
    incidents: list[dict[str, Any]]
    events: list[dict[str, Any]]
    truth: list[dict[str, Any]]


@router.post('/pair-replays', response_model=PairReplayOut,
             summary='Сравнить два или три датчика одной величины',
             description='Синтетическое последовательное воспроизведение двух или трёх датчиков температуры. '
                         'Разметка отделена от монитора. Расхождение не определяет виновный источник.')
def pair_replay(body: PairReplayRequest) -> dict:
    if body.scenario == 'dual_drift' and body.sensor_count != 3:
        raise HTTPException(422, 'Дрейф двух датчиков доступен только в режиме трёх датчиков')
    return replay_pair(body.scenario, body.seed, body.sensor_count)
