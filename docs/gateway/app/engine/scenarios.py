"""Генератор синтетических сценариев, воспроизведение и оценка. Порт demo/engine.js."""
from __future__ import annotations

import math
from typing import Any

from .monitor import CONFIG, PROFILES, Monitor
from .seeds import check_seed

SCENARIOS: dict[str, dict[str, Any]] = {
    'combined': {'name': 'Полная демонстрация', 'duration': 390, 'description': 'Выброс → плавная деградация → восстановление → пропуск и старые сообщения → смена режима.'},
    'spike': {'name': 'Одиночный выброс', 'duration': 120, 'description': 'Одно измерение резко падает. Устойчивую неисправность объявлять не нужно.'},
    'drift': {'name': 'Плавная деградация', 'duration': 220, 'description': 'Качество плавно падает и затем восстанавливается. Сравниваем момент обнаружения.'},
    'gap': {'name': 'Пропуск и поздняя пачка', 'duration': 160, 'description': 'Поток прерывается, затем приходят старые измерения. Свежие данные появляются позже.'},
    'mode': {'name': 'Допустимая смена режима', 'duration': 150, 'description': 'Режим A сменяется режимом B. Ожидаемый уровень меняется с 95 на 80.'},
}

_M32 = 0xFFFFFFFF


def _imul(a: int, b: int) -> int:
    return ((a & _M32) * (b & _M32)) & _M32


def rng(seed: int):
    """mulberry32 с той же арифметикой, что и в JS: последовательности совпадают."""
    state = seed & _M32

    def random() -> float:
        nonlocal state
        state = (state + 0x6D2B79F5) & _M32
        t = _imul(state ^ (state >> 15), 1 | state)
        t = (t ^ ((t + _imul(t ^ (t >> 7), 61 | t)) & _M32)) & _M32
        return ((t ^ (t >> 14)) & _M32) / 4294967296

    return random


def _round3(v: float) -> float:
    return float(f'{v:.3f}')


def generate(scenario: str = 'combined', seed: int = 42) -> dict[str, Any]:
    if scenario not in SCENARIOS:
        raise ValueError('Неизвестный сценарий')
    check_seed(seed)
    random = rng(seed)
    cfg = SCENARIOS[scenario]
    messages: list[dict[str, Any]] = []
    truth: list[dict[str, Any]] = []
    annotations: list[dict[str, Any]] = []

    def normal() -> float:
        r = math.sqrt(-2 * math.log(max(random(), 1e-9)))
        return r * math.cos(2 * math.pi * random())

    full = scenario == 'combined'
    drift_start, drift_hold, recovery = (100, 160, 180) if full else (60, 110, 150)
    drift_end = recovery + 20
    gap_start, batch_time, fresh_time = (240, 290, 300) if full else (60, 110, 120)
    if full or scenario == 'spike':
        annotations.append({'start': 60, 'end': 61, 'label': 'Выброс', 'kind': 'spike'})
    if full or scenario == 'drift':
        truth.append({'start': drift_start, 'end': drift_end, 'type': 'quality', 'label': 'Деградация'})
        annotations.append({'start': drift_start, 'end': drift_end, 'label': 'Деградация', 'kind': 'quality'})
    if full or scenario == 'gap':
        truth.append({'start': gap_start, 'end': fresh_time, 'type': 'availability', 'label': 'Нет свежих данных'})
        annotations.append({'start': gap_start, 'end': fresh_time, 'label': 'Нет свежих данных', 'kind': 'availability'})
        annotations.append({'start': batch_time, 'end': batch_time + 1, 'label': 'Старая пачка', 'kind': 'batch'})
    mode_time = 340 if full else 60
    if full or scenario == 'mode':
        annotations.append({'start': mode_time, 'end': cfg['duration'], 'label': 'Режим B', 'kind': 'mode'})
    for t in range(cfg['duration'] + 1):
        mode = 'B' if (full or scenario == 'mode') and t >= mode_time else 'A'
        value = PROFILES[mode]['mean'] + 1.5 * normal()
        if (full or scenario == 'spike') and t == 60:
            value = 40
        if full or scenario == 'drift':
            if drift_start <= t < recovery:
                value -= 12 * min(1, (t - drift_start) / (drift_hold - drift_start))
            if recovery <= t < drift_end:
                value -= 12 * (1 - (t - recovery) / 20)
        received: float = t
        if (full or scenario == 'gap') and gap_start <= t < fresh_time:
            if t < batch_time - 15:
                received = batch_time + (random() * 0.5 - 0.25)
            else:
                continue
        messages.append({'id': t, 'sensor_id': 'camera-01', 'event_time': t, 'received_at': received,
                         'value': _round3(value), 'mode': mode, 'quality_flags': 'valid'})
    messages.sort(key=lambda m: (m['received_at'], m['event_time']))
    return {'scenario': scenario, 'seed': seed, 'duration': cfg['duration'], 'messages': messages,
            'truth': truth, 'annotations': annotations}


def replay(scenario: str = 'combined', seed: int = 42) -> dict[str, Any]:
    data = generate(scenario, seed)
    monitor = Monitor()
    frames: list[dict[str, Any]] = []
    baseline: list[dict[str, Any]] = []
    p = 0
    active: dict[str, Any] | None = None
    msgs = data['messages']
    for now in range(data['duration'] + 1):
        incoming = []
        while p < len(msgs) and msgs[p]['received_at'] <= now:
            incoming.append(msgs[p])
            p += 1
        frames.append(monitor.tick(now, incoming).as_dict())
        fresh = [m for m in incoming if now - m['event_time'] <= CONFIG['bucket'] + CONFIG['lateness']]
        if fresh:
            m = fresh[-1]
            profile = PROFILES[m['mode']]
            if m['value'] < profile['mean'] - CONFIG['baselineSigma'] * profile['sigma']:
                if not active:
                    active = {'type': 'quality', 'start': now, 'end': None, 'reason': 'Порог: значение ниже нормы на 4,5σ'}
                    baseline.append(active)
            elif active:
                active['end'] = now
                active = None
    incidents = [i.as_dict() for i in monitor.incidents]
    baseline.extend({**i} for i in incidents if i['type'] == 'availability')
    return {**data, 'frames': frames, 'incidents': incidents, 'events': list(monitor.events), 'baseline': baseline}


def evaluate(result: dict[str, Any]) -> dict[str, dict[str, Any]]:
    scored = {'quality', 'availability'}
    truth = result['truth']

    def mean(a: list[float]) -> float | None:
        return sum(a) / len(a) if a else None

    def score(incidents: list[dict[str, Any]]) -> dict[str, Any]:
        matched: dict[int, dict[str, Any]] = {}
        delays: list[float] = []
        close_delays: list[float] = []
        false_alarms = repeats = unclosed = 0
        for i in (i for i in incidents if i['type'] in scored):
            j = next((k for k, t in enumerate(truth) if t['type'] == i['type']
                      and t['start'] - CONFIG['matchTolerance'] <= i['start'] < t['end']), -1)
            if j == -1:
                false_alarms += 1
                if i['end'] is None:
                    unclosed += 1
            elif j in matched:
                repeats += 1
                if i['end'] is None and truth[j]['end'] < result['duration']:
                    unclosed += 1
            else:
                matched[j] = i
                delays.append(max(0, i['start'] - truth[j]['start']))
        for j, i in matched.items():
            t = truth[j]
            if i['end'] is not None:
                close_delays.append(i['end'] - t['end'])
            elif t['end'] < result['duration']:
                unclosed += 1
        return {'detected': len(matched), 'total': len(truth), 'falseAlarms': false_alarms, 'repeats': repeats,
                'unclosed': unclosed, 'delay': mean(delays), 'closeDelay': mean(close_delays), 'closed': len(close_delays)}

    return {'monitor': score(result['incidents']), 'baseline': score(result['baseline'])}


def benchmark(scenarios: list[str], seeds: range) -> dict[str, dict[str, Any]]:
    keys = ('detected', 'total', 'falseAlarms', 'repeats', 'unclosed', 'closed')
    totals = {m: {**{k: 0 for k in keys}, 'delaySum': 0.0, 'closeDelaySum': 0.0} for m in ('monitor', 'baseline')}
    for s in scenarios:
        for seed in seeds:
            e = evaluate(replay(s, seed))
            for method, a in totals.items():
                b = e[method]
                for k in keys:
                    a[k] += b[k]
                a['delaySum'] += (b['delay'] or 0) * b['detected']
                a['closeDelaySum'] += (b['closeDelay'] or 0) * b['closed']
    out = {}
    for method, a in totals.items():
        out[method] = {k: a[k] for k in keys}
        out[method]['delay'] = a['delaySum'] / a['detected'] if a['detected'] else None
        out[method]['closeDelay'] = a['closeDelaySum'] / a['closed'] if a['closed'] else None
    return out
