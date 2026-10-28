from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from .api import analysis, incidents, sensors, simulations, stream, system, telemetry
from .broker import Broker
from .registry import Registry, RegistryError
from .settings import VERSION, Settings

log = logging.getLogger('sensor_watch.gateway')

API_PREFIX = '/api/v1'


async def _ticker(registry: Registry, interval: float) -> None:
    while True:
        try:
            registry.tick()
        except Exception:
            log.exception('Ошибка такта монитора')
        await asyncio.sleep(interval)


def create_app(settings: Settings | None = None, *, start_ticker: bool = True,
               time_fn: Callable[[], float] = time.time) -> FastAPI:
    settings = settings or Settings()
    broker = Broker()
    registry = Registry(settings, broker, time_fn)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        task = asyncio.create_task(_ticker(registry, settings.tick_interval)) if start_ticker else None
        yield
        if task:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    app = FastAPI(
        title='Sensor Watch Gateway',
        version=VERSION,
        description='Gateway приёма телеметрии сенсоров: потоковый монитор качества и свежести данных, '
                    'инциденты, журнал объяснений, симуляции сценариев и пакетная оценка.',
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.broker = broker
    app.state.registry = registry
    app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_methods=['*'], allow_headers=['*'])

    @app.exception_handler(RegistryError)
    async def registry_error(_: Request, exc: RegistryError) -> JSONResponse:
        return JSONResponse({'detail': exc.detail}, status_code=exc.status)

    for module in (system, telemetry, sensors, incidents, simulations, analysis, stream):
        app.include_router(module.router, prefix=API_PREFIX)

    if settings.static_dir and (settings.static_dir / 'index.html').is_file():
        _mount_frontend(app, settings.static_dir.resolve())
    return app


def _mount_frontend(app: FastAPI, root: Path) -> None:
    index = root / 'index.html'

    @app.get('/{path:path}', include_in_schema=False, response_model=None)
    async def frontend(path: str) -> FileResponse | JSONResponse:
        if path == 'api' or path.startswith('api/'):
            return JSONResponse({'detail': 'Not Found'}, status_code=404)
        target = (root / path).resolve()
        if path and target.is_file() and target.is_relative_to(root):
            return FileResponse(target)
        return FileResponse(index)


app = create_app()
