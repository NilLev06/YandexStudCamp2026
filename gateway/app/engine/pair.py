"""Сравнение двух синхронизированных источников одной величины без выбора виновного."""
from __future__ import annotations

import math
from typing import Any

from .monitor import valid
from .scenarios import rng
from .seeds import check_seed

PAIR_CONFIG = {'window': 3, 'recovery_windows': 2, 'threshold': 0.8, 'recover_threshold': 0.5, 'confirm': 3, 'recover': 3,
               'max_age': 3, 'max_skew': 0.5, 'fresh_confirm': 3}
PAIR_SCENARIOS = {
    'drift': 'Плавное расхождение и восстановление',
    'normal': 'Общая динамика без неисправности',
    'spike': 'Одиночный выброс одного источника',
    'gap': 'Пропуск и старая пачка одного источника',
}


class PairMonitor:
    def __init__(self) -> None:
        self.latest: dict[str, dict] = {}
        self.last_pair: tuple | None = None
        self.bad_run = self.good_run = self.fresh_run = 0
        self.bad_since: float | None = None
        self.good_since: float | None = None
        self.fresh_since: float | None = None
        self.unavailable_since: float | None = None
        self.incidents: list[dict] = []
        self.events: list[dict] = []
        self.alarm: dict | None = None
        self.missing: dict | None = None

    def _open(self, kind: str, now: float, text: str) -> dict:
        incident = {'id': len(self.incidents) + 1, 'type': kind, 'start': now, 'end': None, 'reason': text}
        self.incidents.append(incident)
        self.events.append({'time': now, 'kind': 'open', 'type': kind, 'text': text})
        return incident

    def _close(self, incident: dict, now: float, text: str, highlight_end: float | None = None) -> None:
        incident['end'] = now
        if highlight_end is not None:
            incident['highlight_end'] = highlight_end
        self.events.append({'time': now, 'kind': 'close', 'type': incident['type'], 'text': text})

    def tick(self, now: float, incoming: list[dict]) -> dict:
        c = PAIR_CONFIG
        for m in incoming:
            name = m.get('sensor_id')
            event_time = m.get('event_time')
            if name not in ('A', 'B') or not valid(m) or not isinstance(event_time, (int, float)):
                continue
            if not math.isfinite(event_time) or event_time > now:
                continue
            if name not in self.latest or event_time > self.latest[name]['event_time']:
                self.latest[name] = dict(m)
        a, b = self.latest.get('A'), self.latest.get('B')
        age_a = now - a['event_time'] if a else None
        age_b = now - b['event_time'] if b else None
        skew = abs(a['event_time'] - b['event_time']) if a and b else None
        available = (age_a is not None and age_b is not None and max(age_a, age_b) <= c['max_age']
                     and skew <= c['max_skew'])
        difference = abs(a['value'] - b['value']) if available else None
        if not available:
            self.bad_run = self.good_run = self.fresh_run = 0
            self.bad_since = self.good_since = self.fresh_since = None
            if self.unavailable_since is None:
                self.unavailable_since = now
            absent = [name for name, age in [('A', age_a), ('B', age_b)] if age is None or age > c['max_age']]
            comment = ('Нет свежих пригодных данных: ' + ', '.join(absent) + '. ' if absent else
                       f'Время измерений различается на {skew:.2f} с, предел {c["max_skew"]} с. ')
            comment += 'Сравнение недоступно; отсутствие данных не подтверждает восстановление.'
            if not self.missing and now - self.unavailable_since >= c['max_age']:
                self.missing = self._open('availability', now, comment)
            status = 'unavailable'
        else:
            self.unavailable_since = None
            key = (a['event_time'], b['event_time'])
            if self.last_pair is None or all(t > previous for t, previous in zip(key, self.last_pair)):
                self.last_pair = key
                if self.fresh_run == 0:
                    self.fresh_since = now
                self.fresh_run += 1
                if self.missing and self.fresh_run >= c['fresh_confirm'] * c['recovery_windows'] and now - self.fresh_since >= c['window'] * c['recovery_windows']:
                    self._close(self.missing, now, f'Два окна по {c["window"]} с с новыми свежими синхронизированными парами подтвердили восстановление сравнения.', self.fresh_since)
                    self.missing = None
                if difference > c['threshold']:
                    if self.bad_run == 0:
                        self.bad_since = now
                    self.bad_run += 1
                    self.good_run = 0
                    self.good_since = None
                    if not self.alarm and self.bad_run >= c['confirm'] and now - self.bad_since >= c['window']:
                        text = (f'Показания A и B расходятся на {difference:.2f} °C, порог {c["threshold"]} °C. '
                                f'Превышение подтверждено одним окном {c["window"]} с новых последовательных пар. '
                                'По двум источникам нельзя определить, какой датчик ошибается.')
                        self.alarm = self._open('disagreement', now, text)
                elif difference < c['recover_threshold']:
                    self.bad_run = 0
                    self.bad_since = None
                    if self.good_run == 0:
                        self.good_since = now
                    self.good_run += 1
                    if self.alarm and self.good_run >= c['recover'] * c['recovery_windows'] and now - self.good_since >= c['window'] * c['recovery_windows']:
                        self._close(self.alarm, now, f'Два окна по {c["window"]} с с новыми парами с разницей ниже {c["recover_threshold"]} °C подтвердили согласованность.', self.good_since)
                        self.alarm = None
                else:
                    self.bad_run = self.good_run = 0
                    self.bad_since = self.good_since = None
            status = 'alarm' if self.alarm else 'suspect' if self.bad_run else 'normal'
            comment = (f'Разница {difference:.2f} °C; порог расхождения {c["threshold"]} °C. '
                       + ('Инцидент открыт; какой источник неисправен, не установлено.' if self.alarm else
                          f'Подтверждение открытия: {min(now - self.bad_since, c["window"]):g}/{c["window"]} с; '
                          f'новых пар: {self.bad_run}, минимум {c["confirm"]}.' if self.bad_run else
                          'Показания согласованы в пределах заданного допуска.'))
            if self.missing:
                status = 'recovering'
                elapsed = now - self.fresh_since if self.fresh_since is not None else 0
                duration = c['window'] * c['recovery_windows']
                comment = (f'Свежие пары снова поступают. Подтверждение восстановления сравнения: '
                           f'{min(elapsed, duration):g}/{duration} с (два окна по {c["window"]} с); '
                           f'новых пар: {self.fresh_run}, минимум {c["fresh_confirm"] * c["recovery_windows"]}.')
                if self.alarm:
                    comment += ' Инцидент расхождения остаётся открытым.'
        return {'now': now, 'a': a['value'] if a else None, 'b': b['value'] if b else None,
                'age_a': age_a, 'age_b': age_b, 'time_skew': skew, 'difference': difference,
                'status': status, 'comment': comment, 'bad_run': self.bad_run,
                'good_run': self.good_run, 'comparison_alarm_open': self.alarm is not None}


def generate_pair(scenario: str = 'drift', seed: int = 42) -> dict[str, Any]:
    check_seed(seed)
    if scenario not in PAIR_SCENARIOS:
        raise ValueError('Неизвестный сценарий двух датчиков')
    random = rng(seed)
    messages = []
    for t in range(161):
        physical = 25 + 1.5 * math.sin(t / 22) + (2 if t >= 40 else 0)
        for name in ('A', 'B'):
            noise = 0.12 * math.sqrt(-2 * math.log(max(random(), 1e-9))) * math.cos(2 * math.pi * random())
            bias = 0
            if name == 'B' and scenario == 'drift':
                if 65 <= t < 110:
                    bias = 2 * min(1, (t - 65) / 25)
                elif 110 <= t < 125:
                    bias = 2 * (125 - t) / 15
            if name == 'B' and scenario == 'spike' and t == 80:
                bias = 4
            received = t
            if name == 'B' and scenario == 'gap' and 70 <= t < 110:
                if t < 90:
                    received = 100
                else:
                    continue
            messages.append({'sensor_id': name, 'event_time': t, 'received_at': received,
                             'value': round(physical + noise + bias, 4), 'quality_flags': 'valid'})
    messages.sort(key=lambda m: (m['received_at'], m['event_time'], m['sensor_id']))
    truth = [{'start': 65, 'end': 125, 'label': 'Внесённый дрейф B'}] if scenario == 'drift' else []
    if scenario == 'gap':
        truth = [{'start': 70, 'end': 110, 'label': 'Нет свежих данных B'}]
    return {'scenario': scenario, 'seed': seed, 'duration': 160, 'messages': messages, 'truth': truth}


def replay_pair(scenario: str = 'drift', seed: int = 42, sensor_count: int = 2) -> dict[str, Any]:
    if sensor_count == 3:
        from .group import replay_three
        return replay_three(scenario, seed)
    if sensor_count != 2:
        raise ValueError('Sensor count must be 2 or 3')
    data = generate_pair(scenario, seed)
    monitor, frames, cursor = PairMonitor(), [], 0
    for now in range(data['duration'] + 1):
        incoming = []
        while cursor < len(data['messages']) and data['messages'][cursor]['received_at'] <= now:
            incoming.append(data['messages'][cursor])
            cursor += 1
        frames.append(monitor.tick(now, incoming))
    return {**data, 'sensor_count': 2, 'sensor_ids': ['A', 'B'], 'config': dict(PAIR_CONFIG), 'frames': frames,
            'incidents': monitor.incidents, 'events': monitor.events}
