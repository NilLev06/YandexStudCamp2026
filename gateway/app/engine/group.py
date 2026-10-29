"""Three comparable sources, with an independent existing monitor per pair."""
import math
import re

from .pair import PAIR_CONFIG, PAIR_SCENARIOS, PairMonitor, generate_pair
from .scenarios import rng

GROUP_SCENARIOS = {**PAIR_SCENARIOS, 'dual_drift': 'Совместный дрейф двух датчиков'}

PAIRS = [('A', 'B'), ('A', 'C'), ('B', 'C')]


class GroupMonitor:
    def __init__(self):
        self.monitors = {f'{a}-{b}': PairMonitor() for a, b in PAIRS}
        self.incidents = []
        self.events = []
        self.ids = {}
        self.event_cursors = dict.fromkeys(self.monitors, 0)

    def tick(self, now, incoming):
        frames = {}
        for a, b in PAIRS:
            key = f'{a}-{b}'
            monitor = self.monitors[key]
            mapped = [{**m, 'sensor_id': 'A' if m['sensor_id'] == a else 'B'}
                      for m in incoming if m.get('sensor_id') in (a, b)]
            frames[key] = monitor.tick(now, mapped)
            def text(message):
                return f'Пара {a}–{b}. ' + re.sub(r'\b[AB]\b', lambda m: {'A': a, 'B': b}[m[0]], message)
            for incident in monitor.incidents:
                identity = (key, incident['id'])
                if identity not in self.ids:
                    record = {**incident, 'id': len(self.incidents) + 1, 'pair': key,
                              'reason': text(incident['reason'])}
                    self.ids[identity] = record
                    self.incidents.append(record)
                record = self.ids[identity]
                record['end'] = incident['end']
                if 'highlight_end' in incident:
                    record['highlight_end'] = incident['highlight_end']
            for event in monitor.events[self.event_cursors[key]:]:
                self.events.append({**event, 'pair': key, 'text': text(event['text'])})
            self.event_cursors[key] = len(monitor.events)
        sensors = {'A': {'value': frames['A-B']['a'], 'age': frames['A-B']['age_a']},
                   'B': {'value': frames['A-B']['b'], 'age': frames['A-B']['age_b']},
                   'C': {'value': frames['A-C']['b'], 'age': frames['A-C']['age_b']}}
        states = {f['status'] for f in frames.values()}
        status = next((s for s in ['unavailable', 'recovering', 'alarm', 'suspect'] if s in states), 'normal')
        available = [key for key, frame in frames.items() if frame['difference'] is not None]
        missing = [key for key in frames if key not in available]
        suspect = None
        if not missing:
            for candidate in sensors:
                involving = [key for key in frames if candidate in key.split('-')]
                remaining = next(key for key in frames if candidate not in key.split('-'))
                if (all(frames[key]['comparison_alarm_open'] for key in involving)
                        and frames[remaining]['difference'] < PAIR_CONFIG['recover_threshold']
                        and not frames[remaining]['comparison_alarm_open']):
                    suspect = candidate
                    break
        if missing:
            comment = 'Недоступны сравнения: ' + ', '.join(missing) + '. '
            comment += 'Доступны сравнения: ' + ', '.join(available) + '. Отсутствие данных не подтверждает восстановление.'
        elif suspect:
            other = [s for s in sensors if s != suspect]
            comment = (f'Датчик {suspect} расходится с обоими источниками, а {other[0]} и {other[1]} согласованы. '
                       f'Вероятный источник расхождения: {suspect}. Это предположение: согласованная пара тоже может ошибаться.')
        elif status == 'normal':
            comment = 'Все три источника согласованы в пределах заданного допуска.'
        else:
            comment = 'Сравниваются A–B, A–C и B–C. Причины подтверждённых тревог показаны ниже.'
        differences = [frames[key]['difference'] for key in available]
        return {'now': now, 'a': sensors['A']['value'], 'b': sensors['B']['value'], 'c': sensors['C']['value'],
                'age_a': sensors['A']['age'], 'age_b': sensors['B']['age'], 'age_c': sensors['C']['age'],
                'sensors': sensors, 'pairs': frames, 'suspect_sensor': suspect,
                'time_skew': max((f['time_skew'] or 0 for f in frames.values()), default=0),
                'difference': max(differences) if differences else None,
                'status': status, 'comment': comment,
                'bad_run': max(f['bad_run'] for f in frames.values()),
                'good_run': min(f['good_run'] for f in frames.values()),
                'comparison_alarm_open': any(f['comparison_alarm_open'] for f in frames.values())}


def replay_three(scenario, seed):
    data = generate_pair('drift' if scenario == 'dual_drift' else scenario, seed)
    data['scenario'] = scenario
    if scenario == 'dual_drift':
        data['truth'] = [{'start': 65, 'end': 125, 'label': 'Совместный дрейф B и C'}]
    random = rng(seed + 104729)  # A/B stay identical when switching from two to three sources.
    for t in range(data['duration'] + 1):
        physical = 25 + 1.5 * math.sin(t / 22) + (2 if t >= 40 else 0)
        noise = 0.12 * math.sqrt(-2 * math.log(max(random(), 1e-9))) * math.cos(2 * math.pi * random())
        bias = 0
        if scenario == 'dual_drift':
            if 65 <= t < 110:
                bias = 2 * min(1, (t - 65) / 25)
            elif 110 <= t < 125:
                bias = 2 * (125 - t) / 15
        data['messages'].append({'sensor_id': 'C', 'event_time': t, 'received_at': t,
                                 'value': round(physical + noise + bias, 4), 'quality_flags': 'valid'})
    data['messages'].sort(key=lambda m: (m['received_at'], m['event_time'], m['sensor_id']))
    monitor, frames, cursor = GroupMonitor(), [], 0
    for now in range(data['duration'] + 1):
        incoming = []
        while cursor < len(data['messages']) and data['messages'][cursor]['received_at'] <= now:
            incoming.append(data['messages'][cursor])
            cursor += 1
        frames.append(monitor.tick(now, incoming))
    return {**data, 'sensor_count': 3, 'sensor_ids': ['A', 'B', 'C'], 'config': dict(PAIR_CONFIG),
            'frames': frames, 'incidents': monitor.incidents, 'events': monitor.events}
