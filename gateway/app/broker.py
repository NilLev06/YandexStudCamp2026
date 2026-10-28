from __future__ import annotations

import asyncio
from typing import Any


class Broker:
    """Рассылка обновлений подписчикам SSE. Медленный подписчик теряет самые старые сообщения, а не тормозит тикер."""

    def __init__(self, queue_size: int = 256) -> None:
        self._queue_size = queue_size
        self._subscribers: set[asyncio.Queue[dict[str, Any]]] = set()

    @property
    def subscribers(self) -> int:
        return len(self._subscribers)

    def subscribe(self) -> asyncio.Queue[dict[str, Any]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(self._queue_size)
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[dict[str, Any]]) -> None:
        self._subscribers.discard(queue)

    def publish(self, message: dict[str, Any]) -> None:
        for queue in self._subscribers:
            if queue.full():
                queue.get_nowait()
            queue.put_nowait(message)
