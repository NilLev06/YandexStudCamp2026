from __future__ import annotations

from fastapi import APIRouter

from ..engine import CONFIG, PROFILES, SCENARIOS
from ..schemas import HealthOut, MetaOut, Overview
from ..settings import VERSION
from .deps import RegistryDep, SettingsDep

router = APIRouter(tags=['Система'])


@router.get('/health', response_model=HealthOut, summary='Проверка работоспособности')
async def health(registry: RegistryDep) -> dict:
    return {'status': 'ok', 'version': VERSION, **registry.health()}


@router.get('/meta', response_model=MetaOut, summary='Параметры детектора, эталоны режимов и сценарии')
async def meta(settings: SettingsDep) -> dict:
    return {
        'version': VERSION,
        'config': CONFIG,
        'profiles': PROFILES,
        'scenarios': [{'id': k, **v} for k, v in SCENARIOS.items()],
        'limits': {'max_batch': settings.max_batch, 'max_future_skew': settings.max_future_skew,
                   'max_simulation_speed': settings.max_simulation_speed, 'max_benchmark_runs': settings.max_benchmark_runs},
        'auth_required': bool(settings.api_key),
    }


@router.get('/overview', response_model=Overview, summary='Сводка статусов по всем сенсорам')
async def overview(registry: RegistryDep) -> dict:
    return registry.overview()
