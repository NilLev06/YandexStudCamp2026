"""Генератор синтетических потоков с отдельно хранимой разметкой.

Первые пять сценариев - побитовый порт generate() из demo/engine.js
(тот же генератор mulberry32, тот же порядок вызовов): seed 42 даёт те же числа.
Сценарии stuck / noise / rate - наше расширение под ошибки из «математической базы».
"""
from __future__ import annotations

import math
from typing import Callable

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
}

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
    return _generate_extended(scenario, seed, sensor_id)


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
