"""Генератор синтетических потоков с отдельно хранимой разметкой.

Первые пять сценариев - побитовый порт generate() из demo/engine.js
(тот же генератор mulberry32, тот же порядок вызовов): seed 42 даёт те же числа.
Сценарии stuck / noise / rate - наше расширение под ошибки из «математической базы».
Сценарии случаев (step, bias, latency, saturation, quant, periodic, pair, gain) показывают,
что каждый из 14 случаев документа ловит детектор своей группы - отдельные детекторы не нужны.
"""
from __future__ import annotations

import math
from typing import Callable

from .config import Profile

M32 = 0xFFFFFFFF


def _imul(a: int, b: int) -> int:
    """Math.imul: произведение по модулю 2^32."""
    return (a * b) & M32


def mulberry32(seed: int) -> Callable[[], float]:
    """Тот же ГПСЧ, что rng() в engine.js (арифметика по модулю 2^32)."""
    state = seed & M32

    def nxt() -> float:
        nonlocal state
        state = (state + 0x6D2B79F5) & M32
        a = state
        t = _imul(a ^ (a >> 15), 1 | a)
        t ^= (t + _imul(t ^ (t >> 7), 61 | t)) & M32
        return ((t ^ (t >> 14)) & M32) / 4294967296

    return nxt


SCENARIOS: dict[str, dict] = {
    "combined": {"name": "Полная демонстрация", "duration": 390,
                 "description": "Выброс -> плавная деградация -> восстановление -> пропуск и старые сообщения -> смена режима."},
    "spike": {"name": "Одиночный выброс", "duration": 120,
              "description": "Одно измерение резко падает. Устойчивую неисправность объявлять не нужно."},
    "drift": {"name": "Плавная деградация", "duration": 220,
              "description": "Качество плавно падает и затем восстанавливается. Сравниваем момент обнаружения."},
    "gap": {"name": "Пропуск и поздняя пачка", "duration": 160,
            "description": "Поток прерывается, затем приходят старые измерения. Свежие данные появляются позже."},
    "mode": {"name": "Допустимая смена режима", "duration": 150,
             "description": "Режим A сменяется режимом B. Ожидаемый уровень меняется с 95 на 80."},
    # --- расширение: ошибки, которые среднее не видит ---
    "stuck": {"name": "Залипание", "duration": 200, "extended": True,
              "description": "Датчик замирает на последнем значении: уровень в норме, но данные мёртвые."},
    "noise": {"name": "Рост шума", "duration": 200, "extended": True,
              "description": "Среднее в норме, разброс вырос в 4 раза (вибрация, плохой контакт)."},
    "rate": {"name": "Отсчёты реже", "duration": 200, "extended": True,
             "description": "Датчик присылает данные в 3 раза реже: окна пустеют, оценка качества теряет опору."},
    # --- случаи документа внутри групп: тот же детектор группы, другой вид ошибки ---
    "step": {"name": "Ступенька", "duration": 200, "extended": True, "group": 2, "cases": [2],
             "description": "Показания резко сдвигаются на 8 и держатся со сдвигом (удар, переподключение)."},
    "bias": {"name": "Дрейф нуля", "duration": 200, "extended": True, "group": 2, "cases": [4],
             "description": "Ноль датчика случайно блуждает и уходит за паспортный бюджет, затем перекалибровка."},
    "latency": {"name": "Растущая задержка", "duration": 200, "extended": True, "group": 3, "cases": [11],
                "description": "Отсчёты приходят всё позже и не по порядку: время события отстаёт от времени приёма."},
    "saturation": {"name": "Насыщение", "duration": 200, "extended": True, "group": 5, "cases": [8],
                   "description": "Величина выше диапазона датчика: показания упираются в потолок 100."},
    "quant": {"name": "Грубое квантование", "duration": 200, "extended": True, "group": 5, "cases": [12],
              "description": "Разрешение упало до шага 6: сигнал превращается в лесенку и почти не меняется."},
    "periodic": {"name": "Периодическая помеха", "duration": 200, "extended": True, "group": 6, "cases": [13],
                 "description": "К сигналу добавилась синусоида с периодом 4 с (вращение, наводка)."},
    "pair": {"name": "Расхождение двух датчиков", "duration": 200, "extended": True, "group": 7, "cases": [14],
             "description": "Два термометра в одной точке; монитор смотрит на невязку y2 - y1, второй уходит вниз."},
    "gain": {"name": "Ошибка масштаба", "duration": 200, "extended": True, "group": 7, "cases": [5],
             "description": "Мотор даёт 85 % заданных оборотов: монитор смотрит на отношение измерено/задано."},
}

# Сценарии случаев, у которых монитор смотрит не на сам сигнал, а на невязку с ожидаемым (адаптер)
CASE_PROFILES: dict[str, dict[str, Profile]] = {
    "pair": {"A": Profile(mean=0.0, sigma=1.414, source="passport")},     # y2 - y1, σ = √2·σ_датчика
    "gain": {"A": Profile(mean=1.0, sigma=0.03, source="passport")},      # y / ŷ
}
CASE_SCENARIOS = ("step", "bias", "latency", "saturation", "quant", "periodic", "pair", "gain")

BASE_SCENARIOS = ("combined", "spike", "drift", "gap", "mode")
MEAN = {"A": 95.0, "B": 80.0}


def _fmt3(v: float) -> float:
    """Number(v.toFixed(3)) из JS."""
    return float(f"{v:.3f}")


def generate(scenario: str = "combined", seed: int = 42, sensor_id: str = "camera-01") -> dict:
    """Поток сообщений + разметка (truth) + подписи для графика.

    Разметка возвращается отдельно и монитору никогда не передаётся.
    """
    if scenario not in SCENARIOS:
        raise KeyError(f"Неизвестный сценарий: {scenario}")
    if scenario in BASE_SCENARIOS:
        return _generate_base(scenario, seed, sensor_id)
    if scenario in CASE_SCENARIOS:
        return _generate_case(scenario, seed, sensor_id)
    return _generate_extended(scenario, seed, sensor_id)


def scenario_profiles(scenario: str) -> dict[str, Profile] | None:
    """Паспорт датчика сценария (None - эталоны демо A/B)."""
    return CASE_PROFILES.get(scenario)


def _generate_base(scenario: str, seed: int, sensor_id: str) -> dict:
    random = mulberry32(seed)
    cfg = SCENARIOS[scenario]
    messages: list[dict] = []
    truth: list[dict] = []
    annotations: list[dict] = []

    def normal() -> float:
        # Порядок вызовов как в JS: сначала random() под логарифмом, затем под косинусом
        u = max(random(), 1e-9)
        return math.sqrt(-2 * math.log(u)) * math.cos(2 * math.pi * random())

    full = scenario == "combined"
    drift_start, drift_hold = (100, 160) if full else (60, 110)
    recovery = 180 if full else 150
    drift_end = recovery + 20
    gap_start, batch_time, fresh_time = (240, 290, 300) if full else (60, 110, 120)
    if full or scenario == "spike":
        annotations.append({"start": 60, "end": 61, "label": "Выброс", "kind": "spike"})
    if full or scenario == "drift":
        truth.append({"start": drift_start, "end": drift_end, "type": "quality", "label": "Деградация"})
        annotations.append({"start": drift_start, "end": drift_end, "label": "Деградация", "kind": "quality"})
    if full or scenario == "gap":
        truth.append({"start": gap_start, "end": fresh_time, "type": "availability", "label": "Нет свежих данных"})
        annotations.append({"start": gap_start, "end": fresh_time, "label": "Нет свежих данных", "kind": "availability"})
        annotations.append({"start": batch_time, "end": batch_time + 1, "label": "Старая пачка", "kind": "batch"})
    mode_time = 340 if full else 60
    if full or scenario == "mode":
        annotations.append({"start": mode_time, "end": cfg["duration"], "label": "Режим B", "kind": "mode"})

    for t in range(cfg["duration"] + 1):
        mode = "B" if (full or scenario == "mode") and t >= mode_time else "A"
        value = MEAN[mode] + 1.5 * normal()
        if (full or scenario == "spike") and t == 60:
            value = 40.0
        if full or scenario == "drift":
            if drift_start <= t < recovery:
                value -= 12 * min(1, (t - drift_start) / (drift_hold - drift_start))
            if recovery <= t < drift_end:
                value -= 12 * (1 - (t - recovery) / 20)
        received: float = t
        if (full or scenario == "gap") and gap_start <= t < fresh_time:
            if t < batch_time - 15:
                received = batch_time + (random() * 0.5 - 0.25)
            else:
                continue
        messages.append({"id": t, "sensor_id": sensor_id, "event_time": t, "received_at": received,
                         "value": _fmt3(value), "mode": mode, "quality_flags": "valid"})
    messages.sort(key=lambda m: (m["received_at"], m["event_time"]))
    return {"scenario": scenario, "seed": seed, "duration": cfg["duration"],
            "messages": messages, "truth": truth, "annotations": annotations}


def _generate_extended(scenario: str, seed: int, sensor_id: str) -> dict:
    random = mulberry32(seed ^ 0x5EED)

    def normal() -> float:
        u = max(random(), 1e-9)
        return math.sqrt(-2 * math.log(u)) * math.cos(2 * math.pi * random())

    duration = SCENARIOS[scenario]["duration"]
    start, end = 70, 150
    label = {"stuck": "Залипание", "noise": "Рост шума", "rate": "Отсчёты реже"}[scenario]
    truth = [{"start": start, "end": end, "type": scenario, "label": label}]
    annotations = [{"start": start, "end": end, "label": label, "kind": scenario}]
    messages: list[dict] = []
    frozen: float | None = None
    for t in range(duration + 1):
        value = 95.0 + 1.5 * normal()
        inside = start <= t < end
        if scenario == "stuck" and inside:
            frozen = value if frozen is None else frozen
            value = frozen                       # датчик повторяет последнее значение
        if scenario == "noise" and inside:
            value = 95.0 + 4 * (value - 95.0)    # тот же центр, разброс x4
        if scenario == "rate" and inside and (t - start) % 3:
            continue                             # приходит только каждый третий отсчёт
        messages.append({"id": t, "sensor_id": sensor_id, "event_time": t, "received_at": t,
                         "value": _fmt3(value), "mode": "A", "quality_flags": "valid"})
    return {"scenario": scenario, "seed": seed, "duration": duration,
            "messages": messages, "truth": truth, "annotations": annotations}


def _generate_case(scenario: str, seed: int, sensor_id: str) -> dict:
    """Сценарии случаев из документа. Разметка - тип инцидента, которым случай должна поймать его группа."""
    random = mulberry32(seed ^ 0xCA5E)

    def normal() -> float:
        u = max(random(), 1e-9)
        return math.sqrt(-2 * math.log(u)) * math.cos(2 * math.pi * random())

    duration = SCENARIOS[scenario]["duration"]
    start, end = 70, 150
    messages: list[dict] = []
    truth_type, label = "quality", SCENARIOS[scenario]["name"]
    bias = 0.0
    phase = random() * 2 * math.pi
    for t in range(duration + 1):
        x = 95.0 + 1.5 * normal()                # исправный датчик: норма 95, σ = 1.5
        received = float(t)
        inside = start <= t < end
        if scenario == "step" and inside:
            x -= 8.0                             # случай 2: b_k = B при k ≥ k0
        elif scenario == "bias":
            if inside:
                bias += -0.08 + 0.1 * normal()   # случай 4: b_k = b_(k-1) + w_k, у w есть снос
            elif t >= end:
                bias = 0.0                       # перекалибровка нуля в опорном состоянии
            x += bias
        elif scenario == "latency" and inside:
            # случай 11: задержка τ - t растёт до 10 с, с разбросом - отсчёты приходят не по порядку
            received = t + min(10.0, (t - start) * 0.15) + random()
        elif scenario == "saturation":
            if inside:
                x += 12.0                        # величина выше диапазона
            x = min(x, 100.0)                    # случай 8: y = clamp(x, x_min, x_max)
        elif scenario == "quant" and inside:
            x = 6.0 * round(x / 6.0)             # случай 12: y = q·round(x/q), q = 6 ≫ σ
        elif scenario == "periodic" and inside:
            x += 6.0 * math.sin(2 * math.pi * t / 4 + phase)   # случай 13: A·sin(2πft), f = 0.25 Гц
        elif scenario == "pair":
            temp = 20.0 + 5.0 * math.sin(2 * math.pi * t / 200)   # настоящая температура меняется
            y1 = temp + normal()
            y2 = temp + normal()
            if inside:
                y2 -= min(8.0, (t - start) * 0.15)     # второй термометр уходит вниз
            x = y2 - y1                          # случай 14: невязка r = y2 - h(y1)
        elif scenario == "gain":
            cmd = 50.0 + 30.0 * math.sin(2 * math.pi * t / 60)    # заданные обороты меняются
            eps = -0.15 if inside else 0.0       # случай 5: y = (1 + ε)·ŷ
            x = (cmd * (1 + eps) + 0.8 * normal()) / cmd
        messages.append({"id": t, "sensor_id": sensor_id, "event_time": t, "received_at": received,
                         "value": _fmt3(x), "mode": "A", "quality_flags": "valid"})
    if scenario == "latency":
        truth_type = "availability"
        start = 110                              # задержка превысила порог свежести 6 с
        messages.sort(key=lambda m: (m["received_at"], m["event_time"]))
    if scenario in ("saturation", "quant"):
        truth_type = "stuck"
    if scenario == "periodic":
        truth_type = "noise"
    truth = [{"start": start, "end": end, "type": truth_type, "label": label}]
    annotations = [{"start": start, "end": end, "label": label, "kind": truth_type}]
    return {"scenario": scenario, "seed": seed, "duration": duration,
            "messages": messages, "truth": truth, "annotations": annotations}
