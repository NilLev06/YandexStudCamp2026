"""Лаборатория: сценарии, офлайн-прогоны, пакетная проверка, живые симуляции."""
from __future__ import annotations

import hashlib
import json
import uuid

from fastapi import APIRouter, HTTPException
from fastapi.concurrency import run_in_threadpool

from sensorwatch import SCENARIOS, benchmark, evaluate, generate, replay

from ..deps import make_config
from ..hub import hub
from ..schemas import BenchmarkRequest, RunRequest, SensorSummary, SimulationRequest
from ..settings import settings

router = APIRouter(tags=["Сценарии и проверка"])


@router.get("/scenarios", summary="Доступные сценарии")
def scenarios() -> list[dict]:
    return [{"id": k, **v, "extended": bool(v.get("extended"))} for k, v in SCENARIOS.items()]


@router.get("/scenarios/{scenario}/dataset", summary="Синтетический поток и отдельная разметка")
def dataset(scenario: str, seed: int = 42) -> dict:
    """Вход детектора (`messages`) и разметка (`truth`) отдаются раздельно - как в постановке кейса."""
    try:
        return generate(scenario, seed)
    except KeyError as e:
        raise HTTPException(404, str(e)) from e


@router.post("/runs", status_code=201, summary="Офлайн-прогон сценария через монитор")
async def create_run(req: RunRequest) -> dict:
    if req.scenario not in SCENARIOS:
        raise HTTPException(404, f"Неизвестный сценарий: {req.scenario}")
    cfg = make_config(req.config)
    result = await run_in_threadpool(replay, req.scenario, req.seed, cfg)
    run_id = uuid.uuid4().hex[:10]
    result = {"id": run_id, **result, "metrics": evaluate(result)}
    hub.runs[run_id] = result
    while len(hub.runs) > settings.max_runs:
        hub.runs.popitem(last=False)
    return result


@router.get("/runs", summary="Последние прогоны")
def list_runs() -> list[dict]:
    return [{"id": r["id"], "scenario": r["scenario"], "seed": r["seed"], "duration": r["duration"],
             "metrics": r["metrics"]} for r in reversed(hub.runs.values())]


@router.get("/runs/{run_id}", summary="Результат прогона: кадры, инциденты, метрики")
def get_run(run_id: str) -> dict:
    if run_id not in hub.runs:
        raise HTTPException(404, "Прогон не найден")
    return hub.runs[run_id]


@router.post("/benchmark", summary="Пакетная проверка: сценарии x seed")
async def run_benchmark(req: BenchmarkRequest) -> dict:
    """Монитор против простого порога на одинаковых данных. Результат кэшируется по параметрам."""
    names = req.scenarios or list(SCENARIOS)
    unknown = [s for s in names if s not in SCENARIOS]
    if unknown:
        raise HTTPException(404, f"Неизвестные сценарии: {', '.join(unknown)}")
    cfg = make_config(req.config)
    key = hashlib.sha1(json.dumps([names, req.seeds, cfg.as_dict()], sort_keys=True).encode()).hexdigest()
    if key not in hub.benchmarks:
        res = await run_in_threadpool(benchmark, names, list(range(1, req.seeds + 1)), cfg)
        hub.benchmarks[key] = {"seeds": req.seeds, "config": cfg.as_dict(), **res}
    return hub.benchmarks[key]


@router.post("/simulations", response_model=SensorSummary, status_code=201,
             summary="Запустить сценарий как живой датчик")
def start_simulation(req: SimulationRequest) -> dict:
    """Сценарий проигрывается в модельном времени с ускорением `speed`: сообщения приходят
    в шлюз по своему времени доставки, монитор работает так же, как с живым источником."""
    try:
        rt = hub.start_simulation(req.scenario, req.seed, req.speed, req.sensor_id, make_config(req.config))
    except KeyError as e:
        raise HTTPException(404, str(e)) from e
    return hub.summary(rt)
