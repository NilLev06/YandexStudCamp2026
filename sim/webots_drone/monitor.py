"""Монитор неисправностей дрона: несколько каналов, политика выбирается в Webots (1/2/3).
Не только обнаруживает, но и удерживает дрон в воздухе: при износе мотора
оценивает его потерю мощности и присылает контроллеру компенсацию.
Запускается один раз и работает всё время: каждый перезапуск симуляции = новый полёт,
логи в logs/run_<дата_время>/."""
import csv
import json
import os
import socket
import statistics
from collections import deque
from datetime import datetime

LOG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs")
DRONE = ("127.0.0.1", 5005)

WARMUP_S = 5.0      # длительность калибровки нормы, с
WINDOW_S = 0.1      # окно агрегации для CUSUM, с
GAP_S = 0.5         # нет телеметрии дольше этого -> тревога
LINK_GAP_S = 1.0    # нет связи с пультом дольше этого -> тревога
COMP_EVERY_S = 0.5  # как часто обновлять компенсацию мотора
COMP_MAX = 1.4      # максимальная компенсация (+40 % оборотов)

# Каналы: мин. разброс, порог h, реакция дрона, текст для HUD, оценивать только в зависании
CHANNELS = {
    "gyro": {"min_sigma": 0.01, "h": 8.0, "action": "LAND",
             "text": "дрейф гироскопа", "hover_only": True},
    "mag": {"min_sigma": 0.02, "h": 8.0, "action": None,
            "text": "магнитная помеха", "hover_only": False},
    "vib": {"min_sigma": 0.005, "h": 8.0, "action": None,
            "text": "рост вибраций", "hover_only": False},
}
for _i in range(4):     # отношение "измеренные обороты / заданные" для каждого мотора
    CHANNELS[f"motor{_i + 1}"] = {"min_sigma": 0.005, "h": 8.0, "action": "COMP",
                                  "text": f"износ мотора {_i + 1}", "hover_only": False}

TEL_COLS = ["t", "t0", "policy", "gyro", "mag", "vib", "r1", "r2", "r3", "r4",
            "esc_ok", "comp_max", "alt", "hover", "mode", "link_age"]


def ratios(m):
    """Отношение измеренных оборотов к заданным для 4 моторов (None - данных нет)."""
    if m.get("w_meas") is None:
        return [None] * 4
    return [wm / wc if wc > 1.0 else None for wm, wc in zip(m["w_meas"], m["w_cmd"])]


def feature(name, m):
    """Признак канала из пакета телеметрии (None - данных нет)."""
    if name.startswith("motor"):
        return m["r"][int(name[-1]) - 1]
    x = m.get(name)
    if x is None:
        return None
    return abs(x) if name == "vib" else x   # для вибрации важен размах


def csv_value(v):
    """Значение для CSV: None -> пусто, True/False -> 1/0."""
    if v is None:
        return ""
    if isinstance(v, bool):
        return int(v)
    return v


class Detector:
    """Один канал: калибровка нормы, медиана окна, CUSUM и гистерезис."""

    def __init__(self, min_sigma, h, k=0.5, clear_windows=20):
        self.min_sigma = min_sigma
        self.h = h
        self.k = k
        self.clear_windows = clear_windows   # столько окон подряд в норме -> снять тревогу
        self.ref = []
        self.mu = None
        self.sigma = None
        self.reset_state()

    def reset_state(self):
        """Сбросить накопленное (при смене политики), норму сохранить."""
        self.win = []
        self.win_t0 = None
        self.s_up = 0.0
        self.s_dn = 0.0
        self.calm = 0
        self.alarm = False

    def finish_calibration(self):
        """Норма = медиана, разброс = 1.4826 * MAD (устойчиво к выбросам)."""
        if not self.ref:
            return                          # канал без данных - не используется
        self.mu = statistics.median(self.ref)
        mad = statistics.median(abs(v - self.mu) for v in self.ref)
        self.sigma = max(1.4826 * mad, self.min_sigma)

    def z(self, x):
        """Нормированное отклонение от нормы."""
        return (x - self.mu) / self.sigma

    def step_threshold(self, x):
        """Наивный порог по каждому отсчёту: реагирует и на одиночные скачки."""
        now = abs(self.z(x)) > 4.0
        if now != self.alarm:
            self.alarm = now
            return "raise" if now else "clear"
        return None

    def step_cusum(self, t, x):
        """Медиана окна + CUSUM; тревога снимается только после устойчивой нормы."""
        if self.win_t0 is None:
            self.win_t0 = t
        self.win.append(x)
        if t - self.win_t0 < WINDOW_S:
            return None
        med = statistics.median(self.win)    # медиана убирает короткие выбросы
        self.win, self.win_t0 = [], t
        z = max(-3.0, min(3.0, self.z(med)))
        if not self.alarm:
            self.s_up = max(0.0, self.s_up + z - self.k)
            self.s_dn = max(0.0, self.s_dn - z - self.k)
            if max(self.s_up, self.s_dn) > self.h:
                self.alarm, self.calm = True, 0
                return "raise"
        else:
            self.calm = self.calm + 1 if abs(z) < 1.0 else 0
            if self.calm >= self.clear_windows:
                self.alarm = False
                self.s_up = self.s_dn = 0.0
                return "clear"
        return None


class Run:
    """Состояние одного полёта: логи, детекторы, активные тревоги, компенсация."""

    def __init__(self):
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        self.dir = os.path.join(LOG_DIR, f"run_{stamp}")
        os.makedirs(self.dir, exist_ok=True)
        self.tel_f = open(os.path.join(self.dir, "telemetry.csv"), "w", newline="", encoding="utf-8")
        self.tel = csv.writer(self.tel_f)
        self.tel.writerow(TEL_COLS)
        self.al_f = open(os.path.join(self.dir, "alarms.csv"), "w", newline="", encoding="utf-8")
        self.al = csv.writer(self.al_f)
        self.al.writerow(["t", "channel", "event", "policy"])
        self.dets = {n: Detector(c["min_sigma"], c["h"]) for n, c in CHANNELS.items()}
        self.calib_t0 = None
        self.calibrated = False
        self.active = {}            # канал -> текст активной тревоги
        self.last_esc_t = None
        self.info_until = 0.0       # до какого момента показывать "норма откалибрована"
        self.comp = [1.0, 1.0, 1.0, 1.0]
        self.comp_t = 0.0           # когда последний раз обновляли компенсацию
        self.hist = [deque(maxlen=150) for _ in range(4)]   # последние отношения оборотов
        self.policy = None
        print(f"\n=== новый полёт: {self.dir}")

    def close(self):
        """Закрыть файлы логов."""
        self.tel_f.close()
        self.al_f.close()


rx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
# порт можно сменить: MONITOR_PORT=5016, если телеметрию принимает gateway_bridge.py
rx.bind(("127.0.0.1", int(os.environ.get("MONITOR_PORT", "5006"))))
rx.settimeout(0.5)                  # чтобы Ctrl+C срабатывал на Windows
tx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)


def send(msg):
    """Отправить сообщение контроллеру дрона."""
    tx.sendto(json.dumps(msg).encode(), DRONE)


def event(run, t, channel, ev, text=None, action=None):
    """Записать событие, обновить активные тревоги и при необходимости дать команду дрону."""
    run.al.writerow([round(t, 3), channel, ev, run.policy])
    run.al_f.flush()
    suffix = f" -> {action}" if action and ev == "raise" else ""
    print(f"[{t:7.2f} с] {channel}: {ev}{suffix}")
    if ev == "raise":
        run.active[channel] = text or channel
        if action in ("LAND", "RTH"):
            send({"mode": action})
    elif ev == "clear":
        run.active.pop(channel, None)


def update_comp(run, t, i, ratio_now=None):
    """Компенсация мотора i: обороты делим на оценку его эффективности.
    CUSUM: оценка - медиана последней секунды (устойчива к сбоям).
    Порог: оценка по одному текущему отсчёту (наивно)."""
    if ratio_now is not None:
        eff = ratio_now
    else:
        recent = [r for tr, r in run.hist[i] if t - tr <= 1.0]
        if not recent:
            return
        eff = statistics.median(recent)
    run.comp[i] = max(1.0 / COMP_MAX, min(COMP_MAX, 1.0 / max(eff, 0.01)))
    run.comp_t = t
    send({"comp": run.comp})
    ch = f"motor{i + 1}"
    if ch in run.active:
        run.active[ch] = f"износ мотора {i + 1}: компенсация x{run.comp[i]:.2f}"


def send_status(run, t):
    """Строка для HUD в Webots."""
    if run.policy == "none":
        s = "выключен"
    elif not run.calibrated:
        s = "калибровка..."
    elif run.active:
        s = "; ".join(run.active.values())
    elif t < run.info_until:
        s = "норма откалибрована"
    else:
        s = "норма"
    send({"status": s})


print("монитор запущен, жду телеметрию... (политика выбирается в Webots клавишами 1/2/3)")
run = None
prev_t = None
n = 0
while True:
    try:
        data = rx.recv(4096)
    except socket.timeout:
        continue                    # данных нет - просто ждём дальше
    m = json.loads(data)
    t = m["t"]
    m["r"] = ratios(m)
    m["esc_ok"] = m.get("w_meas") is not None
    m["comp_max"] = max(m.get("comp") or [1.0])   # самая сильная компенсация в контроллере
    for i in range(4):
        m[f"r{i + 1}"] = m["r"][i]

    # Новый полёт: время симуляции пошло заново (перезапуск в Webots)
    if run is None or (prev_t is not None and t < prev_t - 0.5):
        if run is not None:
            run.close()
        run = Run()
    prev_t = t

    # Смена политики (клавиши 1/2/3 в Webots)
    if m["policy"] != run.policy:
        if run.policy is not None:
            event(run, t, "policy", m["policy"])
        run.policy = m["policy"]
        for d in run.dets.values():
            d.reset_state()
        run.active.clear()
        run.comp = [1.0, 1.0, 1.0, 1.0]

    run.tel.writerow([csv_value(m.get(c)) for c in TEL_COLS])
    for i in range(4):
        if m["r"][i] is not None:
            run.hist[i].append((t, m["r"][i]))
    n += 1
    if n % 25 == 0:                 # ~5 раз в секунду
        run.tel_f.flush()
        send_status(run, t)
    if run.policy == "none":
        continue

    # 1. Калибровка нормы: первые секунды устойчивого зависания
    if not run.calibrated:
        if m["hover"] and m["alt"] > 1.2:
            if run.calib_t0 is None:
                run.calib_t0 = t
            for name, d in run.dets.items():
                x = feature(name, m)
                if x is not None:
                    d.ref.append(x)
            if t - run.calib_t0 >= WARMUP_S:
                for d in run.dets.values():
                    d.finish_calibration()
                run.calibrated = True
                run.info_until = t + 3.0
                print("норма откалибрована: " + ", ".join(
                    f"{k}: mu={d.mu:.4f} sigma={d.sigma:.4f}"
                    for k, d in run.dets.items() if d.mu is not None))
        continue

    # 2. Непрерывные каналы
    regime_ok = m["hover"] and m["mode"] == "MANUAL"
    for name, d in run.dets.items():
        cfg = CHANNELS[name]
        x = feature(name, m)
        if x is None or d.mu is None:
            continue
        if run.policy == "cusum":
            if cfg["hover_only"] and not regime_ok:
                continue            # при манёврах гироскоп меняется по нормальным причинам
            ev = d.step_cusum(t, x)
        else:
            ev = d.step_threshold(x)   # наивно: без учёта режима
        if ev:
            event(run, t, name, ev, cfg["text"], cfg["action"])
            if cfg["action"] == "COMP":
                i = int(name[-1]) - 1
                if run.policy == "cusum" and ev == "raise":
                    update_comp(run, t, i)
                elif run.policy == "threshold":
                    update_comp(run, t, i, ratio_now=x if ev == "raise" else 1.0)

    # 3. Пока мотор изношен - уточняем компенсацию (износ может нарастать)
    if run.policy == "cusum" and t - run.comp_t >= COMP_EVERY_S:
        for i in range(4):
            if f"motor{i + 1}" in run.active:
                update_comp(run, t, i)

    # 4. Телеметрия моторов: пропуск данных
    if m["esc_ok"]:
        run.last_esc_t = t
        if "esc_gap" in run.active:
            event(run, t, "esc_gap", "clear")
        if "motor_fail" in run.active:
            event(run, t, "motor_fail", "clear")
    elif run.last_esc_t is not None and t - run.last_esc_t > GAP_S:
        if run.policy == "cusum" and "esc_gap" not in run.active:
            # нет данных - это не поломка: моторы работают, компенсацию сохраняем
            event(run, t, "esc_gap", "raise", "нет телеметрии моторов")
        elif run.policy == "threshold" and "motor_fail" not in run.active:
            # наивно: нет данных = моторы отказали -> аварийная посадка
            event(run, t, "motor_fail", "raise", "отказ моторов!", "LAND")

    # 5. Связь с пультом
    lost = m["link_age"] > LINK_GAP_S
    if lost and "link" not in run.active:
        event(run, t, "link", "raise", "потеря связи")
    elif not lost and "link" in run.active:
        event(run, t, "link", "clear")