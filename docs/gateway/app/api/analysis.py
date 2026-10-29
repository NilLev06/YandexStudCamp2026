from __future__ import annotations

import time

from fastapi import APIRouter, HTTPException, status

from ..engine import SCENARIOS, benchmark, evaluate, replay
from ..schemas import BenchmarkOut, BenchmarkRequest, Metrics, ReplayOut, ReplayRequest
from .deps import SettingsDep

router = APIRouter(tags=['Анализ'])


def _check_scenarios(names: list[str]) -> None:
    unknown = [n for n in names if n not in SCENARIOS]
    if unknown:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, 'Неизвестные сценарии: ' + ', '.join(unknown))


@router.post('/replays', response_model=ReplayOut, summary='Воспроизвести сценарий целиком',
             description='Детерминированный проход монитора по сценарию: тот же результат, что в автономной демонстрации. '
                         'Возвращает сообщения, разметку, кадры, инциденты, журнал, пороговый метод и метрики.')
def run_replay(body: ReplayRequest) -> dict:
    _check_scenarios([body.scenario])
    result = replay(body.scenario, body.seed)
    metrics = evaluate(result)
    return {**result, 'metrics': {k: Metrics.from_engine(v) for k, v in metrics.items()}}


@router.post('/benchmark', response_model=BenchmarkOut, summary='Пакетная проверка: сценарии × диапазон seed')
def run_benchmark(body: BenchmarkRequest, settings: SettingsDep) -> dict:
    scenarios = body.scenarios or list(SCENARIOS)
    _check_scenarios(scenarios)
    if body.seed_to < body.seed_from:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, 'seed_to должен быть не меньше seed_from')
    runs = len(scenarios) * (body.seed_to - body.seed_from + 1)
    if runs > settings.max_benchmark_runs:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f'Не больше {settings.max_benchmark_runs} прогонов за запрос')
    started = time.perf_counter()
    totals = benchmark(scenarios, range(body.seed_from, body.seed_to + 1))
    return {'runs': runs, 'scenarios': scenarios, 'seed_from': body.seed_from, 'seed_to': body.seed_to,
            'elapsed_ms': round((time.perf_counter() - started) * 1000, 1),
            **{k: Metrics.from_engine(v) for k, v in totals.items()}}
