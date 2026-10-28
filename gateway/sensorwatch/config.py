"""Параметры монитора и эталоны режимов.

Значения по умолчанию совпадают с CONFIG/PROFILES из demo/engine.js,
поэтому на штатных сценариях Python-ядро даёт те же инциденты, что и демо.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, fields, replace
from typing import Literal

Direction = Literal["down", "up", "both"]


@dataclass(frozen=True)
class Profile:
    """Эталон одного режима датчика: норма и шум."""

    mean: float
    sigma: float
    # Оценивать ли качество в этом режиме (например, гироскоп дрона - только в зависании)
    assess: bool = True
    # Откуда взялся эталон: задан вручную, из паспорта или откалиброван монитором
    source: str = "manual"

    def as_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class MonitorConfig:
    """Все пороги монитора. Время - в секундах, z - в долях σ."""

    # --- окна и свежесть (как в engine.js) ---
    bucket: float = 3.0              # размер неперекрывающегося окна
    lateness: float = 2.0            # сколько ждём опоздавшие измерения
    stale_after: float = 6.0         # нет свежих пригодных данных дольше -> инцидент доступности
    fresh_confirm: int = 3           # столько тиков подряд со свежими данными -> закрыть
    fresh_age_threshold: float = 2.0 # измерение «свежее», если ему не больше стольких секунд
    alarm_before_first: bool = True  # тревога «нет данных», даже если источник ещё ни разу не присылал
    # --- CUSUM качества ---
    k: float = 0.5                   # допуск (в σ медианы окна)
    h: float = 10.0                  # порог открытия
    clip: float = 4.5                # ограничение вклада одного окна
    suspect: float = 4.5             # S выше - статус «подозрение»
    confirm_z: float = 1.2           # подтверждение: 2 из 3 последних окон с z выше
    recover_z: float = 1.35          # восстановление: 5 окон подряд с |z| ниже
    direction: Direction = "down"    # какое отклонение считать деградацией
    # --- флаги качества ---
    bad_flag_share: float = 0.5      # доля невалидных в окне -> инцидент флагов
    flags_recover: int = 3           # окон подряд ниже доли -> закрыть
    # --- служебное ---
    dedup_window: float = 120.0      # окно памяти дублей
    mode_log_every: float = 30.0     # не чаще одной записи о смене режима
    max_log: int = 10000             # предел журнала
    match_tolerance: float = 3.0     # допуск оценщика на раннее срабатывание
    baseline_sigma: float = 4.5      # пороговый метод сравнения: mean - 4.5σ
    # --- расширения (наш вклад; по умолчанию включены, на штатных сценариях молчат) ---
    diagnostics: bool = True         # диагностика залипания, роста шума и частоты
    stuck_eps: float = 1e-9          # размах окна не больше -> окно «замерло»
    stuck_windows: int = 4           # окон подряд -> инцидент залипания (0 - не проверять)
    noise_ratio: float = 2.5         # медиана σ_окна/σ за 8 окон выше -> рост шума
    noise_recover: float = 1.6       # ниже -> шум в норме
    noise_windows: int = 8           # сколько окон в медиане шума
    rate_window: int = 20            # сколько интервалов в медиане Δt
    rate_low: float = 0.6            # Δt/Δt0 ниже -> отсчёты чаще нормы
    rate_high: float = 1.6           # Δt/Δt0 выше -> отсчёты реже нормы
    calib_samples: int = 0           # >0: автокалибровка эталона неизвестного режима по N отсчётам
    calib_min_sigma: float = 1e-6    # нижняя граница σ при автокалибровке
    max_future: float = 5.0          # время события позже приёма больше чем на столько -> отсчёт отбросить (0 - не проверять)

    def with_overrides(self, **overrides) -> "MonitorConfig":
        """Новая конфигурация с изменёнными полями (неизвестные поля - ошибка)."""
        known = {f.name for f in fields(self)}
        unknown = set(overrides) - known
        if unknown:
            raise ValueError(f"Неизвестные параметры: {', '.join(sorted(unknown))}")
        return replace(self, **overrides)

    def as_dict(self) -> dict:
        return asdict(self)


DEFAULT_CONFIG = MonitorConfig()

# Эталоны демо-сценариев (engine.js): режим A - исправная работа, B - допустимый другой уровень
DEFAULT_PROFILES: dict[str, Profile] = {
    "A": Profile(mean=95.0, sigma=1.5),
    "B": Profile(mean=80.0, sigma=1.5),
}

# Типы инцидентов и их смысл (для API и интерфейса)
INCIDENT_TYPES: dict[str, str] = {
    "quality": "Устойчивая деградация качества (CUSUM)",
    "availability": "Нет пригодных свежих измерений",
    "flags": "Большая доля невалидных флагов качества",
    "stuck": "Залипание: значение не меняется",
    "noise": "Рост шума: разброс вырос относительно эталона",
    "rate": "Изменилась частота отсчётов",
}

# Какие типы оценщик сравнивает с разметкой
SCORED_TYPES = ("quality", "availability", "stuck", "noise", "rate")


def config_fields() -> list[dict]:
    """Описание параметров для интерфейса: имя, значение по умолчанию, тип."""
    return [
        {"name": f.name, "default": getattr(DEFAULT_CONFIG, f.name), "type": type(getattr(DEFAULT_CONFIG, f.name)).__name__}
        for f in fields(MonitorConfig)
    ]


__all__ = [
    "Direction", "Profile", "MonitorConfig", "DEFAULT_CONFIG", "DEFAULT_PROFILES",
    "INCIDENT_TYPES", "SCORED_TYPES", "config_fields",
]
