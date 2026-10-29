from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Query

from ..schemas import IncidentOut, IncidentType
from .deps import RegistryDep

router = APIRouter(tags=['Инциденты'])


@router.get('/incidents', response_model=list[IncidentOut], summary='Инциденты всех сенсоров, новые сверху')
async def list_incidents(
    registry: RegistryDep,
    sensor_id: str | None = None,
    type: IncidentType | None = None,
    state: Literal['open', 'closed'] | None = None,
    limit: Annotated[int, Query(ge=1, le=5000)] = 500,
) -> list[dict]:
    sensors = [registry.get(sensor_id)] if sensor_id else registry.sensors.values()
    items = [i for s in sensors for i in registry.incidents(s)
             if (type is None or i['type'] == type) and (state is None or i['state'] == state)]
    items.sort(key=lambda i: i['opened_at'], reverse=True)
    return items[:limit]
