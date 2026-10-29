from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, StrictInt

from ..engine.simulation_analysis import analyze, batch, cases
from ..engine.seeds import SEED
from .deps import SettingsDep

router = APIRouter(prefix='/simulation-analysis', tags=['Анализ актуальных симуляций'])


class ReplayRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    case_id: str = 'single:combined'
    seed: StrictInt = Field(default=42, ge=SEED['min'], le=SEED['max'])


class BatchRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    case_ids: list[str] = Field(min_length=1, max_length=25)
    seed_from: StrictInt = Field(default=1, ge=SEED['min'], le=SEED['max'])
    seed_to: StrictInt = Field(default=10, ge=SEED['min'], le=SEED['max'])


@router.get('/cases')
def catalog():
    return cases()


@router.post('/replay')
def replay(body: ReplayRequest):
    try:
        return analyze(body.case_id, body.seed)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e


@router.post('/benchmark')
def benchmark(body: BatchRequest, settings: SettingsDep):
    ids = list(dict.fromkeys(body.case_ids))
    known = {c['id'] for c in cases()}
    if any(i not in known for i in ids):
        raise HTTPException(422, 'Выбран неизвестный сценарий')
    if body.seed_to < body.seed_from:
        raise HTTPException(422, 'Конец диапазона seed должен быть не меньше начала')
    if len(ids) * (body.seed_to - body.seed_from + 1) > settings.max_benchmark_runs:
        raise HTTPException(422, f'Не больше {settings.max_benchmark_runs} прогонов за запрос')
    return batch(ids, body.seed_from, body.seed_to)


@router.get('/examples')
def recommended_examples(case_id: str):
    from ..engine.simulation_analysis import examples
    try:
        return examples(case_id)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
