"""Инъектор неисправностей: портит датчики и моторы по сценарию.
Контроллер дрона о сценарии НЕ знает - он просто получает испорченные данные.
Разметка (что и когда внедрено, в секундах после взлёта) - отдельно в labels.csv."""
import csv
import math
import random

# Сценарий на ~95 с: (начало, конец, тип) в секундах после взлёта
SCENARIO = [
    (8.0, 8.05, "esc_spike"),            # одиночный сбой телеметрии мотора - НЕ поломка
    (12.0, 27.0, "mag_interference"),    # магнитная помеха: растёт, потом уходит
    (32.0, 37.0, "esc_dropout"),         # пропала телеметрия моторов (моторы при этом работают)
    (42.0, 55.0, "vibration"),           # вибрации растут и спадают
    (60.0, 9999.0, "motor_wear"),        # мотор 3 постепенно теряет мощность (износ)
    (90.0, 9999.0, "gyro_bias"),         # медленный дрейф гироскопа до конца полёта
]

PROFILE = {
    "mag_interference": "triangle",      # 0 -> 1 -> 0 (дрейф с возвратом)
    "vibration": "triangle",
}
WEAR_MOTOR = 2             # индекс изнашиваемого мотора (0 FL, 1 FR, 2 RL, 3 RR)
WEAR_MAX = 0.2             # максимальная потеря мощности: 20 %
WEAR_RAMP_S = 15.0         # за сколько секунд износ доходит до максимума
ESC_NOISE = 0.01           # шум телеметрии оборотов: 1 %


class FaultInjector:
    """Портит показания датчиков и работу моторов согласно сценарию."""

    def __init__(self, labels_path, scenario=None, seed=1):
        self.scenario = scenario if scenario is not None else SCENARIO
        self.rng = random.Random(seed)   # фиксированный seed = повторяемый эксперимент
        self.t0 = None                   # момент взлёта
        self.gyro_bias = 0.0
        with open(labels_path, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["start", "end", "type"])
            for s, e, k in self.scenario:
                w.writerow([s, e, k])

    def start(self, t):
        """Запустить отсчёт сценария (вызывается при взлёте)."""
        if self.t0 is None:
            self.t0 = t

    def active(self, t):
        """Список активных неисправностей в момент t."""
        if self.t0 is None:
            return []
        tr = t - self.t0
        return [k for s, e, k in self.scenario if s <= tr <= e]

    def level(self, t, kind):
        """Интенсивность неисправности 0..1 по её профилю."""
        tr = t - self.t0
        for s, e, k in self.scenario:
            if k == kind and s <= tr <= e:
                if kind == "motor_wear":
                    return min(1.0, (tr - s) / WEAR_RAMP_S)
                frac = (tr - s) / (e - s)
                if PROFILE.get(kind) == "triangle":
                    return 1.0 - abs(2.0 * frac - 1.0)
                return frac
        return 0.0

    def apply_sensors(self, t, gyro_roll, mag_vec):
        """Испорченные гироскоп и компас, датчик вибрации и физическая тряска."""
        act = self.active(t)

        if "gyro_bias" in act:
            self.gyro_bias += 0.00005          # смещение растёт каждый шаг
        gyro_roll += self.gyro_bias

        if "mag_interference" in act:
            lvl = self.level(t, "mag_interference")
            mag_vec = [mag_vec[0] + 0.8 * lvl, mag_vec[1], mag_vec[2] + 0.5 * lvl]

        # виртуальный датчик вибрации (в модели Webots его нет)
        std = 0.05
        shake = 0.0                            # физическая тряска: только при неисправности
        if "vibration" in act:
            lvl = self.level(t, "vibration")
            std *= 1.0 + 4.0 * lvl
            # плавное покачивание 3 Гц: хорошо видно, но дрон не переворачивает
            shake = 0.5 * lvl * math.sin(2.0 * math.pi * 3.0 * t)
        vib = self.rng.gauss(0.0, std)

        return gyro_roll, mag_vec, vib, shake

    def apply_motors(self, t, w_cmd):
        """Модель моторов и их телеметрии (ESC).
        w_cmd - заданные обороты 4 моторов (рад/с, по модулю).
        Возвращает реальные обороты и измеренные (None - телеметрии нет)."""
        act = self.active(t)
        w_real = list(w_cmd)
        if "motor_wear" in act:
            w_real[WEAR_MOTOR] *= 1.0 - WEAR_MAX * self.level(t, "motor_wear")

        if "esc_dropout" in act:
            return w_real, None                # моторы крутятся, но данных о них нет
        w_meas = [w * (1.0 + self.rng.gauss(0.0, ESC_NOISE)) for w in w_real]
        if "esc_spike" in act:
            w_meas[WEAR_MOTOR] *= 0.3          # сбойный отсчёт телеметрии
        return w_real, w_meas