"""Потоковый монитор качества и свежести. Порт demo/engine.js с тем же поведением."""
from __future__ import annotations

import math
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from itertools import count
from typing import Any

CONFIG: dict[str, float] = {
    'bucket': 3, 'lateness': 2, 'staleAfter': 6, 'freshConfirm': 3, 'freshAgeThreshold': 2,
    'k': 0.5, 'h': 10, 'clip': 4.5, 'suspect': 4.5, 'confirmZ': 1.2, 'recoverZ': 1.35,
    'badFlagShare': 0.5, 'flagsRecover': 3, 'dedupWindow': 120, 'modeLogEvery': 30,
    'maxLog': 10000, 'matchTolerance': 3, 'baselineSigma': 4.5,
}
PROFILES: dict[str, dict[str, float]] = {'A': {'mean': 95, 'sigma': 1.5}, 'B': {'mean': 80, 'sigma': 1.5}}

MEDIAN_SD = [1, 1, 0.7071, 0.6702, 0.5467, 0.5352, 0.4635, 0.4588, 0.4107]


def median_sd(n: int) -> float:
    return MEDIAN_SD[n] if n < len(MEDIAN_SD) else math.sqrt(math.pi / (2 * n))


def median(values: list[float]) -> float:
    a = sorted(values)
    n = len(a)
    return a[(n - 1) // 2] if n % 2 else (a[n // 2 - 1] + a[n // 2]) / 2


def valid(m: dict[str, Any]) -> bool:
    v = m.get('value')
    flags = m.get('quality_flags')
    return isinstance(v, (int, float)) and math.isfinite(v) and (flags is None or flags == 'valid')


@dataclass
class Incident:
    id: int
    type: str
    start: float
    end: float | None
    reason: str

    def as_dict(self) -> dict[str, Any]:
        return {'id': self.id, 'type': self.type, 'start': self.start, 'end': self.end, 'reason': self.reason}


@dataclass
class Frame:
    now: float
    mode: str
    mode_known: bool
    s: float
    z: float
    aggregate: float | None
    aggregate_time: float | None
    quality: str
    availability: str
    flags: str
    age: float | None
    since_receipt: float | None
    late_count: int
    accepted: int
    events: int

    def as_dict(self) -> dict[str, Any]:
        return dict(self.__dict__)


@dataclass
class Monitor:
    config: dict[str, float] = field(default_factory=lambda: dict(CONFIG))
    profiles: dict[str, dict[str, float]] = field(default_factory=lambda: dict(PROFILES))
    on_event: Callable[[dict[str, Any]], None] | None = None

    def __post_init__(self) -> None:
        self.mode: str | None = None
        self.s = 0.0
        self.recent: list[float] = []
        self.buckets: dict[int, dict[str, Any]] = {}
        self.last_bucket = -1
        self.seen: dict[int, set] = {}
        self.newest: float | None = None
        self.last_receipt: float | None = None
        self.incidents: list[Incident] = []
        self.events: list[dict[str, Any]] = []
        self.quality_incident: Incident | None = None
        self.availability_incident: Incident | None = None
        self.fresh_run = 0
        self.late_count = 0
        self.accepted = 0
        self.z = 0.0
        self.aggregate: float | None = None
        self.aggregate_time: float | None = None
        self.bad_flag_count = 0
        self.bad_buckets: dict[int, int] = {}
        self.last_bad: float | None = None
        self.flags_incident: Incident | None = None
        self.flags_ok_run = 0
        self.last_mode_log = -math.inf
        self.pending_switches = 0
        self._ids = count(1)

    def _log(self, items: list, item: Any) -> None:
        items.append(item)
        if len(items) > self.config['maxLog']:
            items.pop(0)

    def _event(self, event: dict[str, Any]) -> None:
        self._log(self.events, event)
        if self.on_event:
            self.on_event(event)

    def _open(self, type_: str, now: float, reason: str) -> Incident:
        incident = Incident(next(self._ids), type_, now, None, reason)
        self._log(self.incidents, incident)
        self._event({'time': now, 'kind': 'open', 'type': type_, 'text': reason, 'incident_id': incident.id})
        return incident

    def _close(self, incident: Incident, now: float, reason: str) -> None:
        incident.end = now
        self._event({'time': now, 'kind': 'close', 'type': incident.type, 'text': reason, 'incident_id': incident.id})

    def _duplicate(self, m: dict[str, Any], now: float) -> bool:
        c = self.config
        horizon = math.floor((now - c['dedupWindow']) / c['bucket'])
        b = math.floor(m['event_time'] / c['bucket'])
        key = m.get('id')
        if key is None:
            key = m['event_time']
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
        from_mode, self.mode = self.mode, mode
        if mode not in self.profiles:
            self._event({'time': now, 'kind': 'unknown_mode', 'type': 'info', 'text': 'Режим ' + mode + ' не описан: эталона нет, качество не оценивается'})
            return
        if from_mode is None:
            return
        if from_mode not in self.profiles:
            self._event({'time': now, 'kind': 'mode', 'type': 'info', 'text': 'Режим ' + from_mode + ' → ' + mode + '; оценка качества возобновлена'})
            return
        if now - self.last_mode_log < self.config['modeLogEvery']:
            self.pending_switches += 1
            return
        extra = ' (ещё ' + str(self.pending_switches) + ' переключений с прошлой записи)' if self.pending_switches else ''
        keep = '; инцидент качества остаётся открытым, восстановление проверяется по эталону ' + mode if self.quality_incident else ''
        self._event({'time': now, 'kind': 'mode', 'type': 'info', 'text': 'Режим ' + from_mode + ' → ' + mode + '; применён отдельный эталон' + keep + extra})
        self.last_mode_log = now
        self.pending_switches = 0

    def tick(self, now: float, incoming: Iterable[dict[str, Any]]) -> Frame:
        c = self.config
        incoming = list(incoming)
        for m in incoming:
            if self._duplicate(m, now):
                continue
            self.last_receipt = now
            self.accepted += 1
            ok = valid(m)
            bucket = math.floor(m['event_time'] / c['bucket'])
            if ok:
                self.newest = max(self.newest if self.newest is not None else -math.inf, m['event_time'])
            if now - m['event_time'] > c['lateness'] + c['bucket'] or bucket <= self.last_bucket:
                self.late_count += 1
                continue
            if not ok:
                self.bad_buckets[bucket] = self.bad_buckets.get(bucket, 0) + 1
                self.bad_flag_count += 1
                self.last_bad = now
                continue
            if self.mode != m['mode']:
                self._switch_mode(m['mode'], now)
            profile = self.profiles.get(m['mode'])
            if not profile:
                continue
            slot = self.buckets.setdefault(bucket, {'r': [], 'mode': m['mode']})
            slot['r'].append((profile['mean'] - m['value']) / profile['sigma'])
            slot['mode'] = m['mode']
        finalized = math.floor((now - c['lateness']) / c['bucket']) - 1
        due = sorted({b for b in (*self.buckets, *self.bad_buckets) if self.last_bucket < b <= finalized})
        for b in due:
            slot = self.buckets.pop(b, None)
            values = slot['r'] if slot else []
            bad_count = self.bad_buckets.pop(b, 0)
            total = len(values) + bad_count
            if total >= 2:
                share = bad_count / total
                if share >= c['badFlagShare']:
                    self.flags_ok_run = 0
                    if not self.flags_incident:
                        self.flags_incident = self._open('flags', now, 'Доля невалидных измерений в окне ' + str(bad_count) + '/' + str(total) + ' (порог ' + str(round(c['badFlagShare'] * 100)) + '%)')
                elif self.flags_incident:
                    self.flags_ok_run += 1
                    if self.flags_ok_run >= c['flagsRecover']:
                        self._close(self.flags_incident, now, 'Доля невалидных измерений ниже порога в ' + _num(c['flagsRecover']) + ' окнах подряд')
                        self.flags_incident = None
                        self.flags_ok_run = 0
            if len(values) < 2:
                continue
            z_median = median(values)
            profile = self.profiles[slot['mode']]
            self.aggregate = profile['mean'] - z_median * profile['sigma']
            self.aggregate_time = (b + 1) * c['bucket'] - 1
            self.z = z_median / median_sd(len(values))
            self.s = max(0, self.s + max(-c['clip'], min(c['clip'], self.z)) - c['k'])
            self.recent.append(self.z)
            if len(self.recent) > 5:
                self.recent.pop(0)
            if not self.quality_incident and self.s >= c['h'] and sum(1 for z in self.recent[-3:] if z > c['confirmZ']) >= 2:
                self.quality_incident = self._open('quality', now, 'Устойчивое снижение качества: CUSUM ≥ ' + _num(c['h']) + ' и подтверждение по последним окнам')
            if self.quality_incident and len(self.recent) == 5 and all(abs(z) < c['recoverZ'] for z in self.recent):
                self._close(self.quality_incident, now, 'Пять последовательных окон вернулись в нормальный диапазон')
                self.quality_incident = None
                self.s = 0
                self.recent = []
                self.aggregate = None
                self.aggregate_time = None
        self.last_bucket = max(self.last_bucket, finalized)
        horizon = math.floor((now - c['dedupWindow']) / c['bucket'])
        for b in [b for b in self.seen if b < horizon]:
            del self.seen[b]
        for b in [b for b in self.bad_buckets if b <= self.last_bucket]:
            del self.bad_buckets[b]
        age = None if self.newest is None else now - self.newest
        stale = age is None or age > c['staleAfter']
        if stale:
            self.fresh_run = 0
            if not self.availability_incident and now > c['staleAfter']:
                flagged = self.last_bad is not None and now - self.last_bad <= c['staleAfter']
                reason = ('Измерения поступают, но более ' + _num(c['staleAfter']) + ' секунд помечены невалидными') if flagged else ('Нет пригодных свежих измерений более ' + _num(c['staleAfter']) + ' секунд')
                self.availability_incident = self._open('availability', now, reason)
        elif self.availability_incident:
            has_fresh = any(valid(m) and now - m['event_time'] <= c['freshAgeThreshold'] for m in incoming)
            self.fresh_run = self.fresh_run + 1 if has_fresh else 0
            if self.fresh_run >= c['freshConfirm']:
                self._close(self.availability_incident, now, 'Получены три последовательных свежих измерения')
                self.availability_incident = None
                self.fresh_run = 0
                self.s = 0
                self.recent = []
        unavailable = (self.aggregate_time is None or now - self.aggregate_time > c['bucket'] * 2 + c['lateness']
                       or stale or bool(self.availability_incident))
        if self.quality_incident:
            quality = 'alarm'
        elif unavailable:
            quality = 'unknown'
        else:
            quality = 'suspect' if self.s > c['suspect'] else 'normal'
        if self.availability_incident:
            availability = 'stale'
        elif age is None:
            availability = 'unknown'
        else:
            availability = 'stale' if stale else 'fresh'
        return Frame(
            now=now, mode=self.mode or '—', mode_known=self.mode in self.profiles, s=self.s, z=self.z,
            aggregate=self.aggregate, aggregate_time=self.aggregate_time, quality=quality, availability=availability,
            flags='degraded' if self.flags_incident else 'ok', age=age,
            since_receipt=None if self.last_receipt is None else now - self.last_receipt,
            late_count=self.late_count, accepted=self.accepted, events=len(self.events),
        )


def _num(v: float) -> str:
    return str(int(v)) if float(v).is_integer() else str(v)
