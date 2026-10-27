"""Потоковый монитор одного датчика.

Ядро - порт класса Monitor из demo/engine.js: окна по времени события,
ожидание опозданий, медиана окна, ограниченный CUSUM с подтверждением,
независимый таймер свежести, инцидент невалидных флагов, эталоны режимов.

Наши расширения (не меняют поведение на штатных сценариях):
- direction: деградация вниз, вверх или в обе стороны (двусторонний CUSUM);
- эталоны режимов задаются на каждый датчик и могут калиброваться автоматически
  (медиана и 1.4826·MAD по первым N пригодным отсчётам режима);
- диагностика по окну: залипание, рост шума, изменение частоты отсчётов.

Монитор не знает будущего: tick(now, incoming) получает только то, что пришло к моменту now.
"""
from __future__ import annotations

import math
import statistics
from collections import deque
from typing import Callable, Iterable

from .config import DEFAULT_CONFIG, DEFAULT_PROFILES, MonitorConfig, Profile

# Стандартное отклонение медианы n нормальных величин (в σ), как MEDIAN_SD в engine.js
MEDIAN_SD = [1, 1, 0.7071, 0.6702, 0.5467, 0.5352, 0.4635, 0.4588, 0.4107]


def median_sd(n: int) -> float:
    return MEDIAN_SD[n] if n < len(MEDIAN_SD) else math.sqrt(math.pi / (2 * n))


def is_valid(m: dict) -> bool:
    """Пригодное измерение: число и флаг valid (или флага нет)."""
    v = m.get("value")
    flags = m.get("quality_flags")
    return isinstance(v, (int, float)) and math.isfinite(v) and (flags is None or flags == "valid")


def robust_profile(values: Iterable[float], min_sigma: float = 1e-6, source: str = "calibrated") -> Profile:
    """Эталон по выборке: медиана и 1.4826·MAD (устойчиво к выбросам)."""
    vals = list(values)
    if not vals:
        raise ValueError("Пустая выборка для калибровки")
    mu = statistics.median(vals)
    mad = statistics.median(abs(v - mu) for v in vals)
    return Profile(mean=mu, sigma=max(1.4826 * mad, min_sigma), source=source)


class Monitor:
    """Монитор одного датчика. Вызывать tick() раз в секунду модельного/настенного времени."""

    def __init__(self, config: MonitorConfig | None = None, profiles: dict[str, Profile] | None = None,
                 on_event: Callable[[dict], None] | None = None):
        self.cfg = config or DEFAULT_CONFIG
        self.profiles: dict[str, Profile] = dict(DEFAULT_PROFILES if profiles is None else profiles)
        self.on_event = on_event          # колбэк для шлюза: новые события и инциденты
        self._incident_seq = 0
        self.mode: str | None = None
        self.s = 0.0                      # итоговая статистика CUSUM (максимум сторон)
        self.s_dn = 0.0                   # накопление «вниз» (как в engine.js)
        self.s_up = 0.0                   # накопление «вверх» (расширение)
        self.side: str | None = None      # в какую сторону открыт инцидент качества
        self.recent: list[float] = []
        self.buckets: dict[int, dict] = {}
        self.last_bucket = -1
        self.seen: dict[int, set] = {}
        self.newest: float | None = None
        self.last_receipt: float | None = None
        self.started_at: float | None = None   # первый тик: отсчёт «нет данных с момента запуска»
        self.incidents: list[dict] = []
        self.events: list[dict] = []
        self.quality_incident: dict | None = None
        self.availability_incident: dict | None = None
        self.fresh_run = 0
        self.late_count = 0
        self.accepted = 0
        self.z = 0.0
        self.aggregate: float | None = None
        self.aggregate_time: float | None = None
        self.bad_flag_count = 0
        self.bad_buckets: dict[int, int] = {}
        self.last_bad: float | None = None
        self.flags_incident: dict | None = None
        self.flags_ok_run = 0
        self.last_mode_log = -math.inf
        self.pending_switches = 0
        # --- расширения ---
        self.diag_incidents: dict[str, dict | None] = {"stuck": None, "noise": None, "rate": None}
        self.stuck_run = 0
        self.unstuck_run = 0
        self.noise_hist: deque[float] = deque(maxlen=self.cfg.noise_windows)
        self.noise_stat: float | None = None
        self.max_event_time: float | None = None
        self.dt_nominal: float | None = None      # Δt0: измеряется онлайн по первым интервалам
        self.dt_first: list[float] = []
        self.dt_recent: deque[float] = deque(maxlen=self.cfg.rate_window)
        self.rate_ratio: float | None = None
        self.calib: dict[str, list[float]] = {}   # отсчёты неизвестных режимов для автокалибровки

    # ------------------------------------------------------------------ журнал
    def _log(self, lst: list, item: dict) -> None:
        lst.append(item)
        if len(lst) > self.cfg.max_log:
            lst.pop(0)

    def _emit(self, item: dict) -> None:
        if self.on_event:
            self.on_event(item)

    def _event(self, item: dict) -> None:
        self._log(self.events, item)
        self._emit({"kind": "event", **item})

    def open(self, typ: str, now: float, reason: str, **extra) -> dict:
        self._incident_seq += 1
        incident = {"seq": self._incident_seq, "type": typ, "start": now, "end": None, "reason": reason, **extra}
        self._log(self.incidents, incident)
        self._event({"time": now, "kind": "open", "type": typ, "text": reason})
        self._emit({"kind": "incident_open", "incident": incident})
        return incident

    def close(self, incident: dict, now: float, reason: str) -> None:
        incident["end"] = now
        incident["close_reason"] = reason
        self._event({"time": now, "kind": "close", "type": incident["type"], "text": reason})
        self._emit({"kind": "incident_close", "incident": incident})

    # ------------------------------------------------------------------ служебное
    def _duplicate(self, m: dict, now: float) -> bool:
        b_size = self.cfg.bucket
        horizon = math.floor((now - self.cfg.dedup_window) / b_size)
        b = math.floor(m["event_time"] / b_size)
        key = m.get("id")
        key = m["event_time"] if key is None else key
        if b < horizon:
            return False
        ids = self.seen.get(b)
        if ids is not None and key in ids:
            return True
        if ids is None:
            ids = self.seen[b] = set()
        ids.add(key)
        return False

    def _switch_mode(self, mode: str, now: float) -> None:
        prev = self.mode
        self.mode = mode
        if mode not in self.profiles:
            tail = "; копим отсчёты для автокалибровки" if self.cfg.calib_samples > 0 else ""
            self._event({"time": now, "kind": "unknown_mode", "type": "info",
                         "text": f"Режим {mode} не описан: эталона нет, качество не оценивается{tail}"})
            return
        if prev is None:
            return
        if prev not in self.profiles:
            self._event({"time": now, "kind": "mode", "type": "info",
                         "text": f"Режим {prev} -> {mode}; оценка качества возобновлена"})
            return
        if now - self.last_mode_log < self.cfg.mode_log_every:
            self.pending_switches += 1
            return
        extra = f" (ещё {self.pending_switches} переключений с прошлой записи)" if self.pending_switches else ""
        keep = (f"; инцидент качества остаётся открытым, восстановление проверяется по эталону {mode}"
                if self.quality_incident else "")
        self._event({"time": now, "kind": "mode", "type": "info",
                     "text": f"Режим {prev} -> {mode}; применён отдельный эталон{keep}{extra}"})
        self.last_mode_log = now
        self.pending_switches = 0

    def set_profile(self, mode: str, profile: Profile, now: float | None = None) -> None:
        """Задать/заменить эталон режима (API калибровки)."""
        self.profiles[mode] = profile
        self.calib.pop(mode, None)
        if now is not None:
            self._event({"time": now, "kind": "calibrated", "type": "info",
                         "text": f"Эталон режима {mode}: μ={profile.mean:.4g}, σ={profile.sigma:.3g} ({profile.source})"})

    def _calibrate_collect(self, m: dict, now: float) -> None:
        """Автокалибровка: копим пригодные отсчёты неописанного режима."""
        vals = self.calib.setdefault(m["mode"], [])
        vals.append(float(m["value"]))
        if len(vals) >= self.cfg.calib_samples:
            prof = robust_profile(vals, self.cfg.calib_min_sigma, source="auto")
            self.set_profile(m["mode"], prof, now)

    def _track_rate(self, event_time: float) -> None:
        """Δt между отсчётами по времени события (расширение)."""
        if self.max_event_time is not None and event_time > self.max_event_time:
            dt = event_time - self.max_event_time
            if self.dt_nominal is None:
                self.dt_first.append(dt)
                if len(self.dt_first) >= self.cfg.rate_window:
                    self.dt_nominal = statistics.median(self.dt_first)
            else:
                self.dt_recent.append(dt)
        if self.max_event_time is None or event_time > self.max_event_time:
            self.max_event_time = event_time

    # ------------------------------------------------------------------ шаг
    def tick(self, now: float, incoming: Iterable[dict]) -> dict:
        cfg = self.cfg
        incoming = list(incoming)
        if self.started_at is None:
            self.started_at = now
        for m in incoming:
            if self._duplicate(m, now):
                continue
            self.last_receipt = now
            self.accepted += 1
            ok = is_valid(m)
            bucket = math.floor(m["event_time"] / cfg.bucket)
            if ok:
                self.newest = max(self.newest if self.newest is not None else -math.inf, m["event_time"])
                if cfg.diagnostics:
                    self._track_rate(m["event_time"])
            if now - m["event_time"] > cfg.lateness + cfg.bucket or bucket <= self.last_bucket:
                self.late_count += 1
                continue
            if not ok:
                self.bad_buckets[bucket] = self.bad_buckets.get(bucket, 0) + 1
                self.bad_flag_count += 1
                self.last_bad = now
                continue
            mode = m.get("mode") or "A"
            m = {**m, "mode": mode}
            if self.mode != mode:
                self._switch_mode(mode, now)
            profile = self.profiles.get(mode)
            if profile is None:
                if cfg.calib_samples > 0:
                    self._calibrate_collect(m, now)
                continue
            if not profile.assess:
                continue
            slot = self.buckets.setdefault(bucket, {"r": [], "raw": [], "mode": mode})
            slot["r"].append((profile.mean - m["value"]) / profile.sigma)
            slot["raw"].append(float(m["value"]))
            slot["mode"] = mode

        finalized = math.floor((now - cfg.lateness) / cfg.bucket) - 1
        # Пустые окна ничего не меняют, поэтому обходим только окна с данными
        # (иначе при времени epoch первый тик перебирал бы сотни миллионов окон)
        pending = sorted(b for b in set(self.buckets) | set(self.bad_buckets) if self.last_bucket < b <= finalized)
        for b in pending:
            slot = self.buckets.pop(b, None)
            values = slot["r"] if slot else []
            raw = slot["raw"] if slot else []
            slot_mode = slot["mode"] if slot else None
            bad_count = self.bad_buckets.pop(b, 0)
            total = len(values) + bad_count
            if total >= 2:
                share = bad_count / total
                if share >= cfg.bad_flag_share:
                    self.flags_ok_run = 0
                    if not self.flags_incident:
                        self.flags_incident = self.open(
                            "flags", now,
                            f"Доля невалидных измерений в окне {bad_count}/{total} (порог {round(cfg.bad_flag_share * 100)}%)")
                elif self.flags_incident:
                    self.flags_ok_run += 1
                    if self.flags_ok_run >= cfg.flags_recover:
                        self.close(self.flags_incident, now,
                                   f"Доля невалидных измерений ниже порога в {cfg.flags_recover} окнах подряд")
                        self.flags_incident = None
                        self.flags_ok_run = 0
            if len(values) < 2:
                continue
            profile = self.profiles[slot_mode]
            scale = 1.0
            if cfg.diagnostics:
                self._diagnose_window(raw, profile, now)
                if self.diag_incidents["stuck"]:
                    continue        # данные «мёртвые»: качество по ним не оцениваем, CUSUM на паузе
                if self.diag_incidents["noise"] and self.noise_stat:
                    scale = max(1.0, self.noise_stat)   # σ эталона устарела: нормируем на фактический шум
            z_median = statistics.median(values)
            self.aggregate = profile.mean - z_median * profile.sigma
            self.aggregate_time = (b + 1) * cfg.bucket - 1
            self.z = z_median / median_sd(len(values)) / scale
            self._cusum_step(now)
        self.last_bucket = max(self.last_bucket, finalized)

        horizon = math.floor((now - cfg.dedup_window) / cfg.bucket)
        for b in [b for b in self.seen if b < horizon]:
            del self.seen[b]
        for b in [b for b in self.bad_buckets if b <= self.last_bucket]:
            del self.bad_buckets[b]

        age = None if self.newest is None else now - self.newest
        stale = age is None or age > cfg.stale_after
        if stale:
            self.fresh_run = 0
            # Для сценариев с нуля это то же условие now > stale_after, что в engine.js;
            # для живого датчика - «молчит дольше stale_after с момента подключения»
            waiting_first = self.accepted == 0 and not cfg.alarm_before_first
            if not self.availability_incident and not waiting_first and now - self.started_at > cfg.stale_after:
                flagged = self.last_bad is not None and now - self.last_bad <= cfg.stale_after
                text = (f"Измерения поступают, но более {cfg.stale_after:g} секунд помечены невалидными" if flagged
                        else f"Нет пригодных свежих измерений более {cfg.stale_after:g} секунд")
                self.availability_incident = self.open("availability", now, text)
        elif self.availability_incident:
            has_fresh = any(is_valid(m) and now - m["event_time"] <= cfg.fresh_age_threshold for m in incoming)
            self.fresh_run = self.fresh_run + 1 if has_fresh else 0
            if self.fresh_run >= cfg.fresh_confirm:
                self.close(self.availability_incident, now,
                           f"Получены {cfg.fresh_confirm} последовательных свежих измерения")
                self.availability_incident = None
                self.fresh_run = 0
                self.s = self.s_dn = self.s_up = 0.0
                self.recent = []

        if cfg.diagnostics:
            self._diagnose_rate(now)

        unavailable = (self.aggregate_time is None or now - self.aggregate_time > cfg.bucket * 2 + cfg.lateness
                       or stale or bool(self.availability_incident))
        if self.quality_incident:
            quality = "alarm"
        elif unavailable:
            quality = "unknown"
        elif self.s > cfg.suspect:
            quality = "suspect"
        else:
            quality = "normal"
        profile = self.profiles.get(self.mode) if self.mode else None
        return {
            "now": now,
            "mode": self.mode or "-",
            "mode_known": profile is not None,
            "s": self.s,
            "s_up": self.s_up,
            "s_down": self.s_dn,
            "z": self.z,
            "aggregate": self.aggregate,
            "aggregate_time": self.aggregate_time,
            "quality": quality,
            "availability": ("stale" if self.availability_incident else "unknown" if age is None
                             else "stale" if stale else "fresh"),
            "flags": "degraded" if self.flags_incident else "ok",
            "diagnostics": {k: ("alarm" if v else "ok") for k, v in self.diag_incidents.items()},
            "noise_ratio": self.noise_stat,
            "rate_ratio": self.rate_ratio,
            "age": age,
            "since_receipt": None if self.last_receipt is None else now - self.last_receipt,
            "late_count": self.late_count,
            "accepted": self.accepted,
            "events": len(self.events),
            "norm": profile.mean if profile else None,
            "sigma": profile.sigma if profile else None,
        }

    # ------------------------------------------------------------------ CUSUM
    def _cusum_step(self, now: float) -> None:
        cfg = self.cfg
        clip = lambda v: max(-cfg.clip, min(cfg.clip, v))  # noqa: E731
        z = self.z                                        # z > 0: значение ниже нормы
        if cfg.direction in ("down", "both"):
            self.s_dn = max(0.0, self.s_dn + clip(z) - cfg.k)
        if cfg.direction in ("up", "both"):
            self.s_up = max(0.0, self.s_up + clip(-z) - cfg.k)
        self.s = max(self.s_dn, self.s_up)
        self.recent.append(z)
        if len(self.recent) > 5:
            self.recent.pop(0)
        if not self.quality_incident:
            last3 = self.recent[-3:]
            if self.s_dn >= cfg.h and sum(1 for v in last3 if v > cfg.confirm_z) >= 2:
                side, text = "down", "Устойчивое снижение качества"
            elif self.s_up >= cfg.h and sum(1 for v in last3 if v < -cfg.confirm_z) >= 2:
                side, text = "up", "Устойчивый рост значения"
            else:
                side = None
            if side:
                self.side = side
                self.quality_incident = self.open(
                    "quality", now, f"{text}: CUSUM ≥ {cfg.h:g} и подтверждение по последним окнам", side=side)
        if self.quality_incident and len(self.recent) == 5 and all(abs(v) < cfg.recover_z for v in self.recent):
            self.close(self.quality_incident, now, "Пять последовательных окон вернулись в нормальный диапазон")
            self.quality_incident = None
            self.side = None
            self.s = self.s_dn = self.s_up = 0.0
            self.recent = []
            self.aggregate = None
            self.aggregate_time = None

    # ------------------------------------------------------------------ диагностика
    def _diagnose_window(self, raw: list[float], profile: Profile, now: float) -> None:
        cfg = self.cfg
        # Залипание: размах окна нулевой несколько окон подряд (у живого датчика шум есть всегда)
        if cfg.stuck_windows and max(raw) - min(raw) <= cfg.stuck_eps:
            self.stuck_run += 1
            self.unstuck_run = 0
            if self.stuck_run >= cfg.stuck_windows and not self.diag_incidents["stuck"]:
                self.diag_incidents["stuck"] = self.open(
                    "stuck", now, f"Значение не меняется {self.stuck_run} окон подряд (σ окна = 0 при эталонной σ={profile.sigma:.3g})")
        else:
            self.stuck_run = 0
            self.unstuck_run += 1
            if self.diag_incidents["stuck"] and self.unstuck_run >= 2:
                self.close(self.diag_incidents["stuck"], now, "Значение снова меняется")
                self.diag_incidents["stuck"] = None
        # Рост шума: медиана отношения σ_окна/σ_эталона за последние окна.
        # σ_окна - по разностям соседних отсчётов (RMS/√2): плавный тренд (износ, дрейф) её почти не меняет
        diffs = [b - a for a, b in zip(raw, raw[1:])]
        sd_window = math.sqrt(sum(d * d for d in diffs) / len(diffs) / 2)
        self.noise_hist.append(sd_window / profile.sigma)
        if len(self.noise_hist) == self.noise_hist.maxlen:
            self.noise_stat = statistics.median(self.noise_hist)
            inc = self.diag_incidents["noise"]
            if not inc and self.noise_stat >= cfg.noise_ratio:
                self.diag_incidents["noise"] = self.open(
                    "noise", now, f"Разброс вырос: σ_окна/σ ≈ {self.noise_stat:.1f} (порог {cfg.noise_ratio:g})")
            elif inc and self.noise_stat < cfg.noise_recover:
                self.close(inc, now, f"Разброс вернулся к эталону: σ_окна/σ ≈ {self.noise_stat:.1f}")
                self.diag_incidents["noise"] = None

    def _diagnose_rate(self, now: float) -> None:
        cfg = self.cfg
        if self.dt_nominal is None or len(self.dt_recent) < cfg.rate_window // 2:
            return
        # Длинные паузы - это пропуск (таймер свежести), а не частота: их не учитываем
        recent = [d for d in self.dt_recent if d <= cfg.stale_after]
        if len(recent) < cfg.rate_window // 2:
            return
        self.rate_ratio = statistics.median(recent) / self.dt_nominal
        inc = self.diag_incidents["rate"]
        bad = self.rate_ratio > cfg.rate_high or self.rate_ratio < cfg.rate_low
        if bad and not inc:
            where = "реже" if self.rate_ratio > 1 else "чаще"
            self.diag_incidents["rate"] = self.open(
                "rate", now, f"Отсчёты приходят {where} нормы: Δt/Δt0 ≈ {self.rate_ratio:.2f} (Δt0 = {self.dt_nominal:g} с)")
        elif inc and not bad:
            self.close(inc, now, f"Частота вернулась к норме: Δt/Δt0 ≈ {self.rate_ratio:.2f}")
            self.diag_incidents["rate"] = None
