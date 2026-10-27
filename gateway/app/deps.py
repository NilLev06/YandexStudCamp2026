"""Общие зависимости роутеров."""
from __future__ import annotations

from fastapi import Header, HTTPException

from sensorwatch import MonitorConfig

from .hub import SensorRuntime, hub
from .settings import settings


def get_sensor(sensor_id: str) -> SensorRuntime:
    rt = hub.sensors.get(sensor_id)
    if rt is None:
        raise HTTPException(404, f"Датчик {sensor_id} не найден")
    return rt


def require_ingest_key(x_api_key: str | None = Header(default=None)) -> None:
    """Если задан SENSORWATCH_INGEST_KEY, источник должен прислать его в X-API-Key."""
    if settings.ingest_key and x_api_key != settings.ingest_key:
        raise HTTPException(401, "Неверный или отсутствующий X-API-Key")


def make_config(overrides: dict | None, base: MonitorConfig | None = None) -> MonitorConfig:
    try:
        return (base or MonitorConfig()).with_overrides(**(overrides or {}))
    except (TypeError, ValueError) as e:
        raise HTTPException(422, str(e)) from e
