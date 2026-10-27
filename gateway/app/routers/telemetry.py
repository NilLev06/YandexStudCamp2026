"""Приём телеметрии и живой поток для интерфейса."""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect

from ..deps import require_ingest_key
from ..hub import hub
from ..schemas import IngestRequest, IngestResponse

router = APIRouter(tags=["Телеметрия"])


@router.post("/ingest", response_model=IngestResponse, dependencies=[Depends(require_ingest_key)],
             summary="Принять пачку измерений")
def ingest(req: IngestRequest) -> IngestResponse:
    """Источник (дрон, установка, шлюз Modbus...) присылает измерения пачкой.

    - Время **приёма** ставит шлюз по часам датчика: так видно опоздания и старые пачки.
    - Новый `sensor_id` регистрируется автоматически; эталон нормы калибруется по первым отсчётам режима.
    - Разметку сюда не присылают: она хранится отдельно (`PUT /sensors/{id}/labels`).
    """
    try:
        n, touched, created, received_at = hub.ingest([m.model_dump() for m in req.messages])
    except ValueError as e:
        raise HTTPException(409, str(e)) from e
    return IngestResponse(accepted=n, sensors=touched, created=created, received_at=received_at)


@router.websocket("/ws")
async def stream(ws: WebSocket, sensor_id: list[str] | None = Query(default=None)):
    """Живой поток: `tick` (кадр монитора + пришедшие измерения + события), `sensor`, `sensor_removed`.

    Фильтр: `/ws?sensor_id=a&sensor_id=b`; без фильтра - все датчики.
    """
    await ws.accept()
    wanted = set(sensor_id or [])
    q = hub.subscribe()
    try:
        await ws.send_json({"type": "hello", "sensors": [hub.summary(rt) for rt in hub.sensors.values()]})
        while True:
            msg = await q.get()
            sid = msg.get("sensor_id") or msg.get("sensor", {}).get("id")
            if wanted and sid not in wanted:
                continue
            await ws.send_json(msg)
    except (WebSocketDisconnect, asyncio.CancelledError, RuntimeError):
        pass
    finally:
        hub.unsubscribe(q)
