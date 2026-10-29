"""Контролируемые нарушения: разметка используется только для показа."""
import math

from .scenarios import rng
from .seeds import check_seed
from .single import ALARM_NAMES, SINGLE_CONFIG, SINGLE_PROFILES, SingleMonitor

SINGLE_SCENARIOS = {
    'normal': 'Нормальная работа', 'drift': 'Плавное снижение и восстановление',
    'rise': 'Плавный рост и восстановление', 'step': 'Ступенчатое смещение',
    'noise': 'Рост случайного шума', 'periodic': 'Периодическая помеха',
    'stuck': 'Залипание', 'saturation': 'Насыщение диапазона',
    'spike': 'Одиночный невозможный скачок', 'jumps': 'Повторные невозможные скачки',
    'invalid': 'Непригодные измерения', 'gap': 'Потеря данных и старая пачка',
    'delay': 'Задержка доставки', 'rate': 'Снижение частоты', 'mode': 'Штатная смена режима',
}


def generate_single(scenario='noise', seed=42):
    check_seed(seed)
    if scenario not in SINGLE_SCENARIOS:
        raise ValueError('Неизвестный сценарий одного датчика')
    random = rng(seed)
    messages = []
    for t in range(241):
        mode = 'B' if scenario == 'mode' and t >= 60 else 'A'
        mean = SINGLE_PROFILES[mode]['mean']
        noise = math.sqrt(-2 * math.log(max(random(), 1e-9))) * math.cos(2 * math.pi * random())
        value = mean + noise
        flags = 'valid'
        arrival = t
        active = 60 <= t < 120
        if scenario in ('drift', 'rise') and active:
            value += (-1 if scenario == 'drift' else 1) * min(7, (t - 60) * 0.35, (120 - t) * 0.7)
        elif scenario == 'step' and active:
            value -= 7
        elif scenario == 'noise' and active:
            # Большой разброс, но допустимая физическая скорость. Случайный
            # знак и амплитуда; предел скорости профиля не подменяет шум.
            value = mean + (4 + random()) * (1 if random() > 0.5 else -1)
        elif scenario == 'periodic' and active:
            value = mean + 5 * math.sin(2 * math.pi * (t - 60) / 4) + noise * 0.1
        elif scenario == 'stuck' and active:
            value = mean
        elif scenario == 'saturation' and active:
            value = min(100, mean + (t - 59) * 6)
        elif scenario == 'spike' and t == 80:
            value = 98
        elif scenario == 'jumps' and active:
            value = 98 if t % 3 != 2 else mean + noise
        elif scenario == 'invalid' and active:
            flags = 'invalid'
        elif scenario == 'rate' and active and t % 4:
            continue
        elif scenario == 'delay' and active:
            arrival += 8
        elif scenario == 'gap' and active:
            if t >= 90:
                continue
            arrival = 110
        messages.append({'sensor_id': 'single-01', 'event_time': t, 'received_at': arrival,
                         'value': value, 'mode': mode, 'quality_flags': flags})
    return {'scenario': scenario, 'seed': seed, 'duration': 240, 'messages': sorted(messages, key=lambda m: m['received_at']),
            'truth': [] if scenario in ('normal', 'mode') else [{'start': 80 if scenario == 'spike' else 60,
                                                               'end': 81 if scenario == 'spike' else 120,
                                                               'label': SINGLE_SCENARIOS[scenario]}]}


def replay_single(scenario='noise', seed=42):
    result = generate_single(scenario, seed)
    monitor = SingleMonitor()
    messages = iter(result['messages'])
    pending = next(messages, None)
    frames = []
    for now in range(result['duration'] + 1):
        incoming = []
        while pending and pending['received_at'] <= now:
            incoming.append(pending)
            pending = next(messages, None)
        frames.append(monitor.tick(now, incoming))
    return {**result, 'config': dict(SINGLE_CONFIG), 'profiles': SINGLE_PROFILES, 'alarm_names': ALARM_NAMES,
            'scenarios': SINGLE_SCENARIOS, 'frames': frames, 'incidents': monitor.incidents, 'events': monitor.events}
