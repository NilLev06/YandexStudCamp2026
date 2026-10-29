"""Analysis of current synthetic replays; scenario truth is evaluator-only."""
from functools import lru_cache

from .single_scenarios import SINGLE_SCENARIOS, replay_single
from .single import ALARM_NAMES, SINGLE_CONFIG, SingleMonitor
from .monitor import PROFILES
from .scenarios import generate
from .pair import PAIR_SCENARIOS, replay_pair
from .group import GROUP_SCENARIOS

TARGETS = {'drift': 'level', 'rise': 'level', 'step': 'level', 'noise': 'noise',
           'periodic': 'noise', 'stuck': 'stuck', 'saturation': 'saturation',
           'jumps': 'invalid', 'invalid': 'invalid', 'gap': 'availability',
           'delay': 'latency', 'rate': 'rate'}


def cases():
    result = [{'id': 'single:combined', 'kind': 'single', 'scenario': 'combined',
               'name': 'Один датчик · Полная демонстрация', 'target': 'level',
               'fault_start': 100, 'fault_end': 300,
               'expected_events': [{'target': 'level', 'start': 100, 'end': 200},
                                   {'target': 'availability', 'start': 240, 'end': 300}],
               'expectation': 'Ожидаются две целевые тревоги: изменение уровня и потеря свежести. Одиночный выброс и смена режима не должны открывать тревогу.'}]
    for kind, names in [('single', SINGLE_SCENARIOS), ('pair', PAIR_SCENARIOS), ('triple', GROUP_SCENARIOS)]:
        for scenario, name in names.items():
            target = TARGETS.get(scenario) if kind == 'single' else {'drift': 'disagreement', 'dual_drift': 'disagreement', 'gap': 'availability'}.get(scenario)
            start = 60 if kind == 'single' else 65 if scenario in ('drift', 'dual_drift') else 70
            end = 120 if kind == 'single' else 125 if scenario in ('drift', 'dual_drift') else 110
            result.append({'id': f'{kind}:{scenario}', 'kind': 'single' if kind == 'single' else 'pair', 'scenario': scenario, 'sensor_count': 3 if kind == 'triple' else 2,
                           'name': ('Один датчик · ' if kind == 'single' else '3 датчика · ' if kind == 'triple' else '2 датчика · ') + name,
                           'target': target, 'fault_start': start if target else None,
                           'fault_end': end if target else None,
                           'expected_events': [{'target': target, 'start': start, 'end': end}] if target else [],
                           'expectation': 'B и C смещаются вместе, A остаётся нормальным. Ожидается обнаружение расхождения; согласованное большинство не определяет виновных.' if scenario == 'dual_drift' else 'Ожидается тревога по целевому нарушению и восстановление после него.' if target else
                           'Тревог не ожидается: нормальная работа, штатная смена режима или одиночный выброс.'})
    return result


def combined(seed):
    result = generate('combined', seed)
    monitor, frames, cursor = SingleMonitor(profiles=PROFILES), [], 0
    for now in range(result['duration'] + 1):
        incoming = []
        while cursor < len(result['messages']) and result['messages'][cursor]['received_at'] <= now:
            incoming.append(result['messages'][cursor])
            cursor += 1
        frames.append(monitor.tick(now, incoming))
    return {**result, 'frames': frames, 'incidents': monitor.incidents, 'events': monitor.events,
            'config': dict(SINGLE_CONFIG), 'profiles': PROFILES, 'alarm_names': ALARM_NAMES,
            'scenarios': {'combined': 'Полная демонстрация'}}


def analyze(case_id, seed):
    case = next((c for c in cases() if c['id'] == case_id), None)
    if case is None:
        raise ValueError('Неизвестный сценарий: ' + case_id)
    data = (combined(seed) if case['scenario'] == 'combined' else replay_single(case['scenario'], seed)
            if case['kind'] == 'single' else replay_pair(case['scenario'], seed, case['sensor_count']))
    evaluated, relevant_ids = [], set()
    for event in case['expected_events']:
        matches = [i for i in data['incidents'] if i['type'] == event['target']
                   and event['start'] <= i['start'] <= event['end'] + 3]
        relevant_ids.update(i['id'] for i in matches)
        recovered = max(i['end'] for i in matches) if matches and all(i['end'] is not None for i in matches) else None
        by_pair = {}
        for incident in matches:
            pair = incident.get('pair', 'single')
            by_pair[pair] = by_pair.get(pair, 0) + 1
        evaluated.append({**event, 'detected': bool(matches),
                          'detection_time': matches[0]['start'] if matches else None,
                          'delay': matches[0]['start'] - event['start'] if matches else None,
                          'recovery_time': recovered,
                          'recovery_delay': recovered - event['end'] if recovered is not None and recovered >= event['end'] else None,
                          'repeats': sum(max(0, count - 1) for count in by_pair.values()),
                          'early_recoveries': sum(i['end'] is not None and i['end'] < event['end'] for i in matches)})
    false = [i for i in data['incidents'] if not any(e['start'] <= i['start'] <= e['end'] + 3 for e in case['expected_events'])]
    false_ids = {i['id'] for i in false}
    other = [i for i in data['incidents'] if i['id'] not in relevant_ids | false_ids]
    early, repeats = sum(e['early_recoveries'] for e in evaluated), sum(e['repeats'] for e in evaluated)
    open_count = sum(i['end'] is None for i in data['incidents'])
    detected_count = sum(e['detected'] for e in evaluated)
    issues = []
    if detected_count < len(evaluated):
        issues.append(f'Целевых нарушений пропущено: {len(evaluated) - detected_count}')
    if false:
        issues.append(f'Лишних тревог вне ожидаемого нарушения: {len(false)}')
    if repeats:
        issues.append(f'Повторных открытий целевой тревоги: {repeats}')
    if early:
        issues.append(f'Снятий целевой тревоги до конца нарушения: {early}')
    if open_count:
        issues.append(f'К концу записи не закрыто тревог: {open_count}')
    first = evaluated[0] if evaluated else {}
    last = evaluated[-1] if evaluated else {}
    assessment = {'case_id': case_id, 'seed': seed, 'expected': bool(evaluated),
                  'expected_count': len(evaluated), 'detected_count': detected_count,
                  'detected': detected_count == len(evaluated) and bool(evaluated),
                  'passed': not issues, 'issues': issues, 'event_results': evaluated,
                  'false_alarms': len(false), 'other_alarms': len(other), 'repeats': repeats,
                  'early_recoveries': early, 'unclosed': open_count,
                  'detection_time': first.get('detection_time'), 'delay': first.get('delay'),
                  'recovery_time': last.get('recovery_time'), 'recovery_delay': last.get('recovery_delay')}
    return {'case': case, 'data': data, 'assessment': assessment}


def summarize(runs):
    delays = [e['delay'] for r in runs for e in r['event_results'] if e['delay'] is not None]
    return {'runs': len(runs), 'passed': sum(r['passed'] for r in runs),
            'expected': sum(r['expected_count'] for r in runs), 'detected': sum(r['detected_count'] for r in runs),
            'missed': sum(r['expected_count'] - r['detected_count'] for r in runs),
            'false_alarm_runs': sum(r['false_alarms'] > 0 for r in runs),
            'false_alarms': sum(r['false_alarms'] for r in runs),
            'repeats': sum(r['repeats'] for r in runs),
            'early_recovery_runs': sum(r['early_recoveries'] > 0 for r in runs),
            'unclosed': sum(r['unclosed'] for r in runs),
            'mean_delay': sum(delays) / len(delays) if delays else None}


def batch(case_ids, seed_from, seed_to):
    details = [analyze(case_id, seed)['assessment'] for case_id in case_ids for seed in range(seed_from, seed_to + 1)]
    catalog = {c['id']: c for c in cases()}
    return {'seed_from': seed_from, 'seed_to': seed_to, 'summary': summarize(details),
            'rows': [{'case': catalog[case_id], **summarize([r for r in details if r['case_id'] == case_id])}
                     for case_id in case_ids], 'details': details}


@lru_cache(maxsize=25)
def examples(case_id):
    catalog = {c['id']: c for c in cases()}
    if case_id not in catalog:
        raise ValueError('Неизвестный сценарий: ' + case_id)
    measured = []
    for seed in range(1, 1001):
        result = analyze(case_id, seed)
        a = result['assessment']
        a = {**a, 'peak': max((f.get('s', f.get('difference')) or 0 for f in result['data']['frames']), default=0)}
        measured.append(a)
    picks = [{'seed': 42, 'label': 'Эталон', 'note': 'Опорный пример с seed 42. Остальные примеры выбраны среди seed 1…1000.'}]
    used = {42}
    def add(row, label, note):
        if row['seed'] not in used:
            picks.append({'seed': row['seed'], 'label': label, 'note': note})
            used.add(row['seed'])
    found = [a for a in measured if a['detected'] and a['delay'] is not None]
    if found and min(a['delay'] for a in found) < max(a['delay'] for a in found):
        fast = min(found, key=lambda a: (a['delay'], a['seed']))
        slow = max(found, key=lambda a: (a['delay'], -a['seed']))
        # Keep descriptive choices even when the reference ties for an extreme.
        for group, label, delay in [(found, 'Быстрое обнаружение', fast['delay']), (found, 'Медленное обнаружение', slow['delay'])]:
            tied = next((a for a in group if a['delay'] == delay and a['seed'] not in used), None)
            if tied:
                add(tied, label, f'Первая целевая тревога через {delay:g} с от начала нарушения. Крайний результат среди seed 1…1000; это не гарантия для других записей.')
    elif found:
        clean = next((a for a in found if a['passed'] and a['seed'] not in used), None)
        if clean:
            add(clean, 'Без замечаний', f'Нарушение обнаружено через {clean["delay"]:g} с, нет пропусков, лишних тревог и повторов.')
    else:
        peak = max(measured, key=lambda a: (a['peak'], -a['seed']))
        add(peak, 'Наибольшее отклонение', 'Наибольший CUSUM или расхождение в этом сценарии среди seed 1…1000. ' + ('Тревога здесь не ожидается.' if catalog[case_id]['target'] is None else 'Ни один прогон не обнаружил все целевые нарушения.'))
    bad = [a for a in measured if not a['passed'] and a['seed'] not in used]
    if bad:
        worst = max(bad, key=lambda a: (a['expected_count'] - a['detected_count'], a['false_alarms'], a['unclosed'], a['repeats'], a['early_recoveries'], -a['seed']))
        label = ('Пропуск нарушения' if worst['detected_count'] < worst['expected_count'] else
                 'Лишние тревоги' if worst['false_alarms'] else 'Тревога не снята' if worst['unclosed'] else
                 'Повторные тревоги' if worst['repeats'] else 'Раннее снятие')
        add(worst, label, '. '.join(worst['issues']))
    return picks
