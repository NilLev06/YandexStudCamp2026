"""Независимые тревоги одного источника; профиль задаёт допустимую динамику.

Вход монитора — только сообщения и часы обработки, без разметки сценария.
Окна не перекрываются: одна точка не подтверждает несколько решений.
"""
from __future__ import annotations

import math
from collections import defaultdict
from typing import Any

from .monitor import CONFIG, median, median_sd, valid

SINGLE_CONFIG = {
    'window': 3, 'dynamics_window': 3, 'max_age': 6, 'lateness': 2,
    'fresh_confirm': 6, 'fresh_recover': 2, 'confirm': 1, 'recover': 2, 'invalid_recover': 2,
    'cusum_k': CONFIG['k'], 'cusum_h': CONFIG['h'], 'cusum_clip': CONFIG['clip'],
    'cusum_confirm_z': CONFIG['confirmZ'], 'cusum_recover_z': CONFIG['recoverZ'],
    'cusum_suspect': CONFIG['suspect'], 'level_recover': 2, 'noise_ratio': 2.5, 'noise_confirm': 1,
    'min_spread': 0.01, 'range_min': 0, 'range_max': 100,
    'max_rate': 12, 'expected_period': 1, 'min_coverage': 0.7,
    'bad_share': 0.5, 'late_share': 0.5, 'saturation_share': 0.5,
}
SINGLE_PROFILES = {'A': {'mean': 70, 'sigma': 1}, 'B': {'mean': 50, 'sigma': 1}}
ALARM_NAMES = {
    'level': 'Отклонение уровня', 'noise': 'Повышенный разброс',
    'stuck': 'Подозрение на залипание', 'saturation': 'Насыщение диапазона',
    'rate': 'Снижена частота измерений', 'invalid': 'Высокая доля непригодных измерений',
    'availability': 'Нет свежих пригодных данных', 'latency': 'Высокая доля опоздавших измерений',
}


class SingleMonitor:
    def __init__(self, config: dict | None = None, profiles: dict | None = None) -> None:
        self.config = {**SINGLE_CONFIG, **(config or {})}
        self.profiles = profiles if profiles is not None else SINGLE_PROFILES
        self.incidents: list[dict] = []
        self.events: list[dict] = []
        self.open: dict[str, dict] = {}
        self.runs: dict[str, list[int]] = defaultdict(lambda: [0, 0])
        self.samples: list[dict] = []
        self.receipts: list[dict] = []
        self.seen: dict[float, float] = {}
        self.mode: str | None = None
        self.newest: float | None = None
        self.last_receipt: float | None = None
        self.previous: dict | None = None
        self.started: float | None = None
        self.last_window: int | None = None
        self.last_dynamics: int | None = None
        self.fresh_run = 0
        self.fresh_since: float | None = None
        self.aggregate: float | None = None
        self.spread: float | None = None
        self.coverage: float | None = None
        self.bad_share: float | None = None
        self.rejected = 0
        self.cusum_down = self.cusum_up = 0.0
        self.recent_z: list[float] = []

    def _open(self, kind: str, now: float, reason: str) -> None:
        item = {'id': len(self.incidents) + 1, 'type': kind, 'start': now, 'end': None, 'reason': reason}
        self.incidents.append(item)
        self.open[kind] = item
        self.events.append({'time': now, 'kind': 'open', 'type': kind, 'text': reason, 'incident_id': item['id']})

    def _close(self, kind: str, now: float, reason: str, highlight_end: float | None = None) -> None:
        item = self.open.pop(kind)
        item['end'] = now
        if highlight_end is not None:
            item['highlight_end'] = highlight_end
        self.events.append({'time': now, 'kind': 'close', 'type': kind, 'text': reason, 'incident_id': item['id']})

    def _decide(self, kind: str, now: float, bad: bool, good: bool, reason: str, confirm: int | None = None,
                recover: int | None = None, normal_since: float | None = None) -> None:
        run = self.runs[kind]
        run[0] = run[0] + 1 if bad else 0
        run[1] = run[1] + 1 if good else 0
        count = confirm or self.config['confirm']
        if kind not in self.open and run[0] >= count:
            self._open(kind, now, f'{ALARM_NAMES[kind]}. {reason} Подтверждающих окон подряд: {run[0]}.')
        elif kind in self.open and run[1] >= (recover or self.config['recover']):
            self._close(kind, now, f'{ALARM_NAMES[kind]}: восстановление подтверждено; нормальных окон подряд: {run[1]}. {reason}',
                        highlight_end=None if normal_since is None else normal_since - ((recover or self.config['recover']) - 1) * self.config['window'])

    def _values(self, start: float, end: float) -> list[dict]:
        return [m for m in self.samples if start <= m['event_time'] < end and m['mode'] == self.mode]

    def _level(self, now: float, start: float, end: float) -> None:
        c = self.config
        deliveries = [m for m in self.receipts if start <= m['received_at'] < end]
        if len(deliveries) >= 2:
            bad = sum(m['bad'] for m in deliveries)
            self.bad_share = bad / len(deliveries)
            reasons = sorted({m['reason'] for m in deliveries if m['bad']})
            fresh_good = sum(m['fresh'] and not m['bad'] for m in deliveries)
            self._decide('invalid', now, self.bad_share >= c['bad_share'], self.bad_share < c['bad_share'] and fresh_good >= 2,
                         f'Непригодны {bad}/{len(deliveries)} ({self.bad_share:.0%}), порог {c["bad_share"]:.0%}. '
                         + ('Причины: ' + '; '.join(reasons) + '.' if reasons else 'Проверены флаги, диапазон и скорость изменения.'),
                         confirm=1, recover=c['invalid_recover'], normal_since=start)
        else:
            self.runs['invalid'] = [0, 0]
        values = self._values(start, end)
        profile = self.profiles.get(self.mode)
        if len(values) < 2 or not profile:
            self.recent_z.clear()
            return
        self.aggregate = median([m['value'] for m in values])
        # Стандартизация медианы и ограниченный вклад как в исходном Monitor.
        # После достижения порога достаточно одного текущего окна отклонения.
        z = (profile['mean'] - self.aggregate) / profile['sigma'] / median_sd(len(values))
        clipped = max(-c['cusum_clip'], min(c['cusum_clip'], z))
        self.cusum_down = max(0.0, self.cusum_down + clipped - c['cusum_k'])
        self.cusum_up = max(0.0, self.cusum_up - clipped - c['cusum_k'])
        self.recent_z.append(z)
        # История нужна только для подтверждения восстановления.
        recover_count = int(c['level_recover'])
        self.recent_z = self.recent_z[-recover_count:]
        down = self.cusum_down >= c['cusum_h'] and z > c['cusum_confirm_z']
        up = self.cusum_up >= c['cusum_h'] and z < -c['cusum_confirm_z']
        level_was_open = 'level' in self.open
        if 'level' not in self.open and (down or up):
            direction = 'снижение' if down else 'повышение'
            self._open('level', now,
                       f'Устойчивое {direction} уровня: CUSUM {max(self.cusum_down, self.cusum_up):.2f} ≥ {c["cusum_h"]:g}; '
                       'отклонение подтверждено одним текущим окном. '
                       f'Медиана {self.aggregate:.2f}, норма режима {self.mode}: {profile["mean"]:.2f} ± {profile["sigma"]:.2f}. '
                       'По одному каналу причина сдвига не установлена.')
        if (level_was_open and len(self.recent_z) >= recover_count
                and all(abs(v) < c['cusum_recover_z'] for v in self.recent_z[-recover_count:])):
            self._close('level', now,
                        f'Восстановление уровня подтверждено; нормальных окон подряд: {recover_count} '
                        f'(|z| < {c["cusum_recover_z"]:g}); накопление CUSUM сброшено.', highlight_end=start - (recover_count - 1) * c['window'])
            self.cusum_down = self.cusum_up = 0.0
            self.recent_z.clear()

    def _dynamics(self, now: float, start: float, end: float) -> None:
        c = self.config
        deliveries = [m for m in self.receipts if start <= m['received_at'] < end]
        # Частоту считаем по свежим временным меткам даже у невалидных значений.
        fresh = sum(m['fresh'] for m in deliveries)
        expected = (end - start) / c['expected_period']
        self.coverage = fresh / expected
        self._decide('rate', now, 0 < self.coverage < c['min_coverage'], self.coverage >= c['min_coverage'],
                     f'За {end-start:g} с получено {fresh:g} свежих уникальных измерений, ожидается {expected:g}; '
                     f'полнота {self.coverage:.0%}, минимум {c["min_coverage"]:.0%}. Штатный период {c["expected_period"]:g} с.', normal_since=start)
        if deliveries:
            late = sum(m['late'] for m in deliveries)
            share = late / len(deliveries)
            self._decide('latency', now, share >= c['late_share'], share < c['late_share'],
                         f'Старых сообщений {late}/{len(deliveries)} ({share:.0%}), порог {c["late_share"]:.0%}; '
                         f'возраст при получении превышает {c["lateness"]:g} с. Нужны согласованные часы источника и приёмника.', normal_since=start)
        else:
            self.runs['latency'] = [0, 0]
        values = [m['value'] for m in self._values(start, end)]
        profile = self.profiles.get(self.mode)
        if len(values) < max(3, expected * c['min_coverage']) or not profile:
            for kind in ('noise', 'stuck', 'saturation'):
                self.runs[kind] = [0, 0]
            self.spread = None
            return
        center = sum(values) / len(values)
        self.spread = math.sqrt(sum((v - center) ** 2 for v in values) / len(values))
        ratio = self.spread / profile['sigma']
        self._decide('noise', now, ratio > c['noise_ratio'], ratio < c['noise_ratio'] * 0.8,
                     f'Стандартное отклонение пригодных значений = {self.spread:.2f}, эталон σ = {profile["sigma"]:.2f}; '
                     f'отношение {ratio:.2f}, порог {c["noise_ratio"]}. Возможны шум, помеха или изменение процесса.',
                     confirm=c['noise_confirm'], normal_since=start)
        width = max(values) - min(values)
        self._decide('stuck', now, c['min_spread'] > 0 and width < c['min_spread'], width >= c['min_spread'],
                     f'Размах {width:.3f}, минимум профиля {c["min_spread"]:.3f} за {end-start:g} с. '
                     'Профиль предполагает изменяющийся сигнал; плато само по себе не доказывает поломку.', normal_since=start)
        at_limit = sum(v <= c['range_min'] or v >= c['range_max'] for v in values)
        share = at_limit / len(values)
        self._decide('saturation', now, share >= c['saturation_share'], share < c['saturation_share'],
                     f'На границах [{c["range_min"]:g}, {c["range_max"]:g}] находятся {at_limit}/{len(values)} '
                     f'значений ({share:.0%}), порог {c["saturation_share"]:.0%}. Возможен выход процесса за диапазон датчика.', normal_since=start)

    def tick(self, now: float, incoming: list[dict]) -> dict[str, Any]:
        c = self.config
        if self.started is None:
            self.started = now
            self.last_window = math.floor(now / c['window'])
            self.last_dynamics = math.floor(now / c['dynamics_window'])
        new_fresh = False
        for source in incoming:
            self.last_receipt = now
            t = source.get('event_time')
            if not isinstance(t, (float, int)) or not math.isfinite(t):
                continue
            if t in self.seen:
                continue
            self.seen[t] = now
            age = now - t
            late = age > c['lateness']
            fresh = 0 <= age <= c['lateness']
            reason = ''
            if not valid(source):
                reason = 'невалидное значение или флаг качества'
            elif t > now:
                reason = 'временная метка из будущего'
            elif not c['range_min'] <= source['value'] <= c['range_max']:
                reason = 'значение вне измерительного диапазона'
            mode = source.get('mode', 'A')
            if fresh and mode != self.mode:
                if self.mode is not None:
                    self.events.append({'time': now, 'kind': 'mode', 'type': 'info',
                                        'text': f'Режим {self.mode} → {mode}; используется отдельный эталон. Открытые тревоги требуют подтверждения восстановления.'})
                self.mode = mode
                self.previous = None
                self.samples.clear()
                self.runs.clear()
                self.recent_z.clear()
            if not reason and fresh and self.previous and t > self.previous['event_time']:
                speed = abs(source['value'] - self.previous['value']) / (t - self.previous['event_time'])
                if speed > c['max_rate']:
                    reason = f'невозможная скорость изменения {speed:.2f} > {c["max_rate"]:g} ед/с'
            self.receipts.append({'received_at': now, 'bad': bool(reason), 'reason': reason, 'fresh': fresh, 'late': late})
            if reason:
                self.rejected += 1
            if reason or not fresh or (self.newest is not None and t <= self.newest):
                continue
            item = {**source, 'mode': mode}
            self.samples.append(item)
            self.previous = item
            self.newest = t
            new_fresh = True
        for index in range(self.last_window, math.floor(now / c['window'])):
            self._level(now, index * c['window'], (index + 1) * c['window'])
        self.last_window = math.floor(now / c['window'])
        for index in range(self.last_dynamics, math.floor(now / c['dynamics_window'])):
            self._dynamics(now, index * c['dynamics_window'], (index + 1) * c['dynamics_window'])
        self.last_dynamics = math.floor(now / c['dynamics_window'])
        age = None if self.newest is None else now - self.newest
        if age is None or age > c['max_age']:
            self.fresh_run = 0
            self.fresh_since = None
            if 'availability' not in self.open and now - self.started > c['max_age']:
                receipt_age = None if self.last_receipt is None else now - self.last_receipt
                text = (f'Возраст последнего пригодного измерения {age:.1f} с' if age is not None else 'Пригодных измерений ещё нет')
                text += f', предел {c["max_age"]:g} с. '
                text += ('Сообщения не поступают.' if receipt_age is None or receipt_age > c['max_age'] else
                         'Сообщения поступают, но не дают свежих пригодных данных: проверьте задержку и качество.')
                self._open('availability', now, text)
        elif 'availability' in self.open:
            if new_fresh and self.fresh_run == 0:
                self.fresh_since = now
            self.fresh_run = self.fresh_run + 1 if new_fresh else 0
            if not new_fresh:
                self.fresh_since = None
            if self.fresh_run >= c['fresh_confirm'] and now - self.fresh_since >= c['fresh_recover'] * c['window']:
                self._close('availability', now, f'Нормальных окон подряд: {c["fresh_recover"]} по {c["window"]} с: {self.fresh_run} новых свежих пригодных измерения подряд; возраст ≤ {c["lateness"]:g} с.',
                            highlight_end=self.fresh_since)
        alarms = [dict(i) for i in self.open.values()]
        suspect = any(run[0] for run in self.runs.values()) or max(self.cusum_down, self.cusum_up) > c['cusum_suspect']
        status = 'alarm' if alarms else 'unknown' if self.mode not in self.profiles or age is None or age > c['max_age'] else 'suspect' if suspect else 'normal'
        if alarms:
            comment = 'Открыты тревоги: ' + ', '.join(ALARM_NAMES[i['type']] for i in alarms) + '. Причины и условия — ниже.'
        elif self.mode not in self.profiles:
            comment = 'Для режима нет эталона: уровень и динамика не оцениваются.'
        elif suspect:
            comment = 'Есть нарушение порога; монитор накапливает подтверждение по новым неперекрывающимся окнам.'
        else:
            comment = 'Подтверждённых нарушений нет. Оценка динамики требует полного окна наблюдений.'
        horizon = now - 2 * c['dynamics_window']
        self.samples = [m for m in self.samples if m['event_time'] >= horizon]
        self.receipts = [m for m in self.receipts if m['received_at'] >= horizon]
        self.seen = {t: received for t, received in self.seen.items() if received >= now - 240}
        return {'now': now, 'mode': self.mode, 'value': self.previous['value'] if self.previous else None,
                's': max(self.cusum_down, self.cusum_up), 'cusum_down': self.cusum_down, 'cusum_up': self.cusum_up,
                'aggregate': self.aggregate, 'spread': self.spread, 'coverage': self.coverage,
                'bad_share': self.bad_share, 'age': age,
                'since_receipt': None if self.last_receipt is None else now - self.last_receipt,
                'rejected': self.rejected, 'status': status, 'comment': comment, 'alarms': alarms}
