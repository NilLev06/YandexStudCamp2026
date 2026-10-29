from __future__ import annotations

from fastapi import APIRouter, status

from ..registry import RegistryError
from ..schemas import SimulationCreate, SimulationOut
from .deps import RegistryDep, WriteAccess

router = APIRouter(tags=['Симуляции'])


@router.post('/simulations', response_model=SimulationOut, status_code=status.HTTP_201_CREATED, dependencies=[WriteAccess],
             summary='Запустить сценарий как живой сенсор',
             description='Создаёт виртуальный сенсор, который получает сообщения сценария в модельном времени '
                         'с заданной скоростью. Монитор обрабатывает их так же, как реальную телеметрию.')
async def start(body: SimulationCreate, registry: RegistryDep) -> dict:
    return registry.start_simulation(body.scenario, body.seed, body.speed, body.sensor_id).as_dict()


@router.get('/simulations', response_model=list[SimulationOut], summary='Список симуляций')
async def list_simulations(registry: RegistryDep) -> list[dict]:
    return [s.as_dict() for s in registry.simulations.values()]


@router.get('/simulations/{sim_id}', response_model=SimulationOut, summary='Состояние симуляции')
async def get_simulation(sim_id: str, registry: RegistryDep) -> dict:
    sim = registry.simulations.get(sim_id)
    if sim is None:
        raise RegistryError(404, 'Симуляция не найдена')
    return sim.as_dict()


@router.delete('/simulations/{sim_id}', response_model=SimulationOut, dependencies=[WriteAccess],
               summary='Остановить симуляцию; сенсор и история сохраняются')
async def stop(sim_id: str, registry: RegistryDep) -> dict:
    return registry.stop_simulation(sim_id).as_dict()
