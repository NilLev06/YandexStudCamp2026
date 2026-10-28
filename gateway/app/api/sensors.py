from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Query, Response, status

from ..schemas import EventOut, FrameOut, IncidentOut, IncidentType, Measurement, SensorDetail, SensorSummary
from .deps import RegistryDep, WriteAccess

router = APIRouter(tags=['Сенсоры'])

Since = Annotated[float | None, Query(description='Только записи позже этой отметки, в часах сенсора')]
Limit = Annotated[int, Query(ge=1, le=10000)]


@router.get('/sensors', response_model=list[SensorSummary], summary='Список сенсоров с текущими статусами')
async def list_sensors(registry: RegistryDep) -> list[dict]:
    return [registry.summary(s) for s in registry.sensors.values()]


@router.get('/sensors/{sensor_id}', response_model=SensorDetail, summary='Сенсор: статус, эталоны и разметка симуляции')
async def get_sensor(sensor_id: str, registry: RegistryDep) -> dict:
    return registry.detail(registry.get(sensor_id))


@router.delete('/sensors/{sensor_id}', status_code=status.HTTP_204_NO_CONTENT, dependencies=[WriteAccess],
               summary='Удалить сенсор и его историю')
async def delete_sensor(sensor_id: str, registry: RegistryDep) -> Response:
    registry.delete(sensor_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get('/sensors/{sensor_id}/frames', response_model=list[FrameOut], summary='История статусов монитора по тактам')
async def frames(sensor_id: str, registry: RegistryDep, since: Since = None, limit: Limit = 3600) -> list[dict]:
    items = [f for f in registry.get(sensor_id).frames if since is None or f['now'] > since]
    return items[-limit:]


@router.get('/sensors/{sensor_id}/measurements', response_model=list[Measurement], summary='Полученные измерения в порядке доставки')
async def measurements(sensor_id: str, registry: RegistryDep, since: Since = None, limit: Limit = 3600) -> list[dict]:
    items = [m for m in registry.get(sensor_id).measurements if since is None or m['received_at'] > since]
    return items[-limit:]


@router.get('/sensors/{sensor_id}/events', response_model=list[EventOut], summary='Журнал объяснений монитора')
async def events(sensor_id: str, registry: RegistryDep,
                 after_seq: Annotated[int | None, Query(description='Только события с seq больше указанного')] = None,
                 limit: Limit = 500) -> list[dict]:
    items = [e for e in registry.get(sensor_id).events if after_seq is None or e['seq'] > after_seq]
    return items[-limit:]


@router.get('/sensors/{sensor_id}/incidents', response_model=list[IncidentOut], summary='Инциденты сенсора')
async def sensor_incidents(sensor_id: str, registry: RegistryDep, type: IncidentType | None = None) -> list[dict]:
    return [i for i in registry.incidents(registry.get(sensor_id)) if type is None or i['type'] == type]
