from __future__ import annotations

from fastapi import APIRouter, HTTPException, status

from ..schemas import IngestResult, TelemetryBatch
from .deps import RegistryDep, SettingsDep, WriteAccess

router = APIRouter(tags=['Телеметрия'])


@router.post('/telemetry', response_model=IngestResult, status_code=status.HTTP_202_ACCEPTED, dependencies=[WriteAccess],
             summary='Принять пачку измерений',
             description='Сообщения ставятся в очередь сенсора и обрабатываются монитором на ближайшем такте. '
                         'Время получения назначает gateway. Неизвестный сенсор регистрируется автоматически. '
                         'Сообщения с временем измерения из будущего отклоняются поштучно.')
async def ingest(batch: TelemetryBatch, registry: RegistryDep, settings: SettingsDep) -> dict:
    if len(batch.messages) > settings.max_batch:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, f'Не больше {settings.max_batch} сообщений в пачке')
    return registry.ingest(batch.messages)
