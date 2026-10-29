from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from .deps import SettingsDep

router = APIRouter(tags=['Поток'])


@router.get('/stream', summary='Server-Sent Events с обновлениями сенсоров',
            description='События: `sensor_added`, `sensor_removed` и `update` (новые кадры, измерения, записи журнала '
                        'и сводка сенсора после такта). Параметр `sensor_id` оставляет только один сенсор. '
                        'Каждые 15 с без событий приходит комментарий-пинг.',
            response_class=StreamingResponse,
            responses={200: {'content': {'text/event-stream': {}}}})
async def stream(request: Request, settings: SettingsDep, sensor_id: str | None = None) -> StreamingResponse:
    broker = request.app.state.broker
    queue = broker.subscribe()

    async def events() -> AsyncIterator[str]:
        try:
            yield 'retry: 3000\n\n'
            while not await request.is_disconnected():
                try:
                    message = await asyncio.wait_for(queue.get(), timeout=settings.stream_heartbeat)
                except asyncio.TimeoutError:
                    yield ': ping\n\n'
                    continue
                if sensor_id and message['sensor_id'] != sensor_id:
                    continue
                yield f"event: {message['type']}\ndata: {json.dumps(message, ensure_ascii=False)}\n\n"
        finally:
            broker.unsubscribe(queue)

    return StreamingResponse(events(), media_type='text/event-stream',
                             headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})
