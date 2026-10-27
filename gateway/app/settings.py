"""Настройки шлюза из переменных окружения (префикс SENSORWATCH_)."""
from __future__ import annotations

import os
from dataclasses import dataclass, field


def _env(name: str, default: str) -> str:
    return os.environ.get(f"SENSORWATCH_{name}", default)


@dataclass
class Settings:
    # Разрешённые источники для фронтенда (через запятую); "*" - все
    cors_origins: list[str] = field(default_factory=lambda: _env("CORS_ORIGINS", "*").split(","))
    # Ключ для отправки телеметрии (POST /ingest). Пусто - без проверки (режим демо)
    ingest_key: str = field(default_factory=lambda: _env("INGEST_KEY", ""))
    # Как часто планировщик проверяет часы датчиков, с
    loop_interval: float = field(default_factory=lambda: float(_env("LOOP_INTERVAL", "0.1")))
    # Шаг монитора по времени датчика, с (монитор рассчитан на тик раз в секунду)
    tick_step: float = 1.0
    # Сколько последних сообщений и кадров хранить на датчик
    history: int = field(default_factory=lambda: int(_env("HISTORY", "20000")))
    # Сколько офлайн-прогонов держать в памяти
    max_runs: int = 30
    # Автокалибровка новых живых датчиков: столько отсчётов на режим
    auto_calib_samples: int = field(default_factory=lambda: int(_env("AUTO_CALIB_SAMPLES", "30")))
    # Демо-датчик при старте: сценарий combined в реальном времени x6
    demo_on_start: bool = field(default_factory=lambda: _env("DEMO_ON_START", "1") == "1")


settings = Settings()
