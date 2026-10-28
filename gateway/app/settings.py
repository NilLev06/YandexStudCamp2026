from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

VERSION = '0.1.0'


class Settings(BaseSettings):
    """Настройки gateway. Каждое поле переопределяется переменной окружения GATEWAY_<ИМЯ>."""

    model_config = SettingsConfigDict(env_prefix='GATEWAY_', env_file='.env', extra='ignore')

    api_key: str | None = None
    cors_origins: list[str] = ['http://localhost:5173', 'http://127.0.0.1:5173']
    tick_interval: float = 1.0
    frame_history: int = 3600
    measurement_history: int = 3600
    event_history: int = 2000
    max_batch: int = 5000
    max_sensors: int = 1000
    max_future_skew: float = 5.0
    max_simulation_speed: float = 60.0
    max_benchmark_runs: int = 1000
    stream_heartbeat: float = 15.0
    static_dir: Path | None = Path(__file__).resolve().parents[2] / 'frontend' / 'dist'
