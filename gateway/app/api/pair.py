from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field, StrictInt

from ..engine.pair import replay_pair
from ..engine.seeds import SEED

router = APIRouter(tags=['Два датчика'])


class PairReplayRequest(BaseModel):
    scenario: Literal['normal', 'drift', 'spike', 'gap'] = 'drift'
    seed: StrictInt = Field(default=42, ge=SEED['min'], le=SEED['max'])


class PairReplayOut(BaseModel):
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
             summary='Сравнить два датчика одной величины',
             description='Синтетическое последовательное воспроизведение двух датчиков температуры. '
                         'Разметка отделена от монитора. Расхождение не определяет виновный источник.')
def pair_replay(body: PairReplayRequest) -> dict:
    return replay_pair(body.scenario, body.seed)
