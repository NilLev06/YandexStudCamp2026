"""Sensor Watch Gateway: единая точка входа для источников телеметрии и интерфейса.

Запуск:  uvicorn app.main:app --reload --port 8000   (из папки gateway)
Документация API: http://localhost:8000/docs
"""
from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import APIRouter, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from sensorwatch import INCIDENT_TYPES, SCENARIOS, config_fields

from .hub import hub
from .routers import incidents, lab, sensors, telemetry
from .settings import settings

VERSION = "0.2.0"
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(_: FastAPI):
    await hub.start()
    if settings.demo_on_start:
        # Демо-датчик, чтобы интерфейс не был пустым сразу после запуска
        hub.start_simulation("combined", 42, 6.0, "demo-camera-01", None)
    yield
    await hub.stop()


app = FastAPI(
    title="Sensor Watch Gateway",
    version=VERSION,
    description=(
        "Шлюз монитора дрейфа сенсоров и качества восприятия (кейс 07 АлгоКемп ИТМО × Яндекс).\n\n"
        "Источники присылают измерения в `POST /api/v1/ingest`, монитор раз в секунду решает по каждому датчику: "
        "качество (CUSUM по медианам окон), свежесть (независимый таймер), флаги, залипание, шум, частота. "
        "Интерфейс читает REST и живой поток `WS /api/v1/ws`."
    ),
    lifespan=lifespan,
)
app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_methods=["*"], allow_headers=["*"])

api = APIRouter(prefix="/api/v1")


@api.get("/health", tags=["Служебное"], summary="Проверка живости")
def health() -> dict:
    return {"status": "ok", "version": VERSION, "sensors": len(hub.sensors)}


@api.get("/meta", tags=["Служебное"], summary="Справочники для интерфейса")
def meta() -> dict:
    return {"version": VERSION, "incident_types": INCIDENT_TYPES, "config": config_fields(),
            "scenarios": [{"id": k, **v} for k, v in SCENARIOS.items()],
            "ingest_key_required": bool(settings.ingest_key)}


for r in (telemetry.router, sensors.router, incidents.router, lab.router):
    api.include_router(r)
app.include_router(api)

# Собранный фронтенд (npm run build): шлюз отдаёт его сам, отдельный веб-сервер для показа не нужен
DIST = Path(os.environ.get("SENSORWATCH_FRONTEND_DIST", Path(__file__).resolve().parents[2] / "frontend" / "dist"))
if DIST.is_dir():
    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str) -> FileResponse:
        if path.startswith("api/"):
            raise HTTPException(404)
        file = (DIST / path).resolve()
        if path and file.is_file() and DIST.resolve() in file.parents:
            return FileResponse(file)
        return FileResponse(DIST / "index.html")   # маршруты React (/sensors/..., /lab)
