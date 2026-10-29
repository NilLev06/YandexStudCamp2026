"""Границы seed и рекомендованные seed для сценариев. Совпадают с demo/engine.js — это проверяет tests/test_matrix.py."""
from __future__ import annotations

from typing import Any

SEED: dict[str, int] = {
    "min": 1,
    "max": 999999,
    "scan": 1000
}

RECOMMENDED_SEEDS: dict[str, list[dict[str, Any]]] = {
    "combined": [
        {
            "seed": 42,
            "kind": "reference",
            "label": "Эталон",
            "note": "Сценарий защиты: тревога качества в 02:02, закрытие в 03:41, средняя задержка 14 с."
        },
        {
            "seed": 532,
            "kind": "fastest",
            "value": 9.5,
            "label": "Быстрое обнаружение",
            "note": "Средняя задержка 9,5 с — минимум среди seed 1…1000."
        },
        {
            "seed": 951,
            "kind": "slowest",
            "value": 17,
            "label": "Медленное обнаружение",
            "note": "Средняя задержка 17 с — максимум среди seed 1…1000."
        },
        {
            "seed": 214,
            "kind": "unclosed",
            "label": "Инцидент не закрылся",
            "note": "После восстановления не набирается пяти спокойных окон подряд: инцидент качества открыт до конца записи."
        }
    ],
    "spike": [
        {
            "seed": 42,
            "kind": "reference",
            "label": "Эталон",
            "note": "Выброс до 40: порог срабатывает, монитор инцидент не открывает."
        },
        {
            "seed": 532,
            "kind": "near_miss",
            "value": 9.23,
            "label": "Почти тревога",
            "note": "CUSUM доходит до 9,23 при пороге 10 — ближе всего к ложной тревоге среди seed 1…1000."
        }
    ],
    "drift": [
        {
            "seed": 42,
            "kind": "reference",
            "label": "Эталон",
            "note": "Тревога через 23 с после начала деградации, закрытие через 27 с после восстановления."
        },
        {
            "seed": 698,
            "kind": "fastest",
            "value": 14,
            "label": "Быстрое обнаружение",
            "note": "Задержка 14 с — минимум среди seed 1…1000."
        },
        {
            "seed": 932,
            "kind": "slowest",
            "value": 26,
            "label": "Медленное обнаружение",
            "note": "Задержка 26 с — максимум среди seed 1…1000."
        },
        {
            "seed": 1,
            "kind": "unclosed",
            "label": "Инцидент не закрылся",
            "note": "Инцидент не успевает закрыться до конца записи — так примерно у 12% seed."
        }
    ],
    "gap": [
        {
            "seed": 42,
            "kind": "reference",
            "label": "Эталон",
            "note": "Seed меняет только шум: разрыв обнаруживается за 6 с, инцидент закрывается через 2 с после свежих данных."
        },
        {
            "seed": 642,
            "kind": "near_miss",
            "value": 7.55,
            "label": "Самый шумный",
            "note": "Наибольший CUSUM среди seed 1…1000 — 7,55 при пороге 10, тревоги нет."
        }
    ],
    "mode": [
        {
            "seed": 42,
            "kind": "reference",
            "label": "Эталон",
            "note": "Смена режима 95 → 80 не открывает инцидент качества."
        },
        {
            "seed": 532,
            "kind": "near_miss",
            "value": 9.23,
            "label": "Почти тревога",
            "note": "После смены режима CUSUM доходит до 9,23 при пороге 10 — ближе всего к ложной тревоге среди seed 1…1000."
        }
    ]
}


def check_seed(seed: object) -> int:
    if isinstance(seed, bool) or not isinstance(seed, int) or not SEED["min"] <= seed <= SEED["max"]:
        raise ValueError(f"Seed должен быть целым числом от {SEED['min']} до {SEED['max']}")
    return seed
