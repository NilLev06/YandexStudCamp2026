"""Мост Webots-дрон -> Sensor Watch Gateway.

Схема (бортовой монитор продолжает спасать дрон, шлюз даёт наблюдаемость):

    контроллер дрона --UDP 5006--> gateway_bridge.py --HTTP--> Gateway (/api/v1/ingest) --> интерфейс
                                          |
                                          +--UDP 5016--> monitor.py (MONITOR_PORT=5016): компенсация, посадка

Каналы дрона становятся отдельными датчиками шлюза:
    mavic.gyro, mavic.mag, mavic.vib, mavic.motor1..4
Отсчёты сжимаются до 10 Гц (медиана за 0.1 с). Время события - настенное время приёма мостом,
поэтому замедление симуляции не делает данные «опоздавшими».
Разметка из сценария faults.py пересчитывается в настенное время по мере прохождения
границ и загружается отдельно (PUT /sensors/{id}/labels) - монитор её не видит.

Запуск (Windows, из папки проекта):
    python gateway_bridge.py --gateway http://127.0.0.1:8000
    set MONITOR_PORT=5016 && python monitor.py
"""
import argparse
import json
import os
import socket
import statistics
import sys
import threading
import time
import urllib.error
import urllib.request
from queue import Empty, Queue

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "controllers", "mavic_failsafe"))
from faults import SCENARIO, WEAR_MOTOR  # noqa: E402  - сценарий неисправностей (для разметки)

PREFIX = "mavic"
FLUSH_S = 0.1          # период сжатия отсчётов, с

# Параметры монитора для каналов дрона: окно 1 с вместо 3 с (данных 10 Гц, а не 1 Гц)
# alarm_before_first=False: датчик зарегистрирован заранее, «нет данных» считаем только после первого отсчёта
FAST = {"bucket": 1.0, "lateness": 0.5, "stale_after": 2.0, "fresh_age_threshold": 1.0, "calib_samples": 50,
        "dedup_window": 30.0, "alarm_before_first": False}
CHANNELS = {
    "gyro": {"name": "Гироскоп (крен)", "unit": "рад/с", "config": {**FAST, "direction": "both", "calib_min_sigma": 0.002},
             # при манёврах угловая скорость меняется по нормальным причинам - оцениваем только зависание
             "profiles": {"maneuver": {"mean": 0.0, "sigma": 1.0, "assess": False}}},
    # компас в Webots без шума: идеально ровный сигнал - норма, поэтому залипание не проверяем,
    # а σ не опускаем ниже паспортной точности (как min_sigma в monitor.py)
    "mag": {"name": "Компас (модуль поля)", "unit": "отн.",
            "config": {**FAST, "direction": "both", "calib_min_sigma": 0.02, "stuck_windows": 0}},
    "vib": {"name": "Вибрация (модуль)", "unit": "g", "config": {**FAST, "direction": "up", "calib_min_sigma": 0.005}},
}
for _i in range(4):
    CHANNELS[f"motor{_i + 1}"] = {
        "name": f"Мотор {_i + 1}: обороты изм./зад.", "unit": "отн.",
        "config": {**FAST, "direction": "down", "calib_min_sigma": 0.005},
        "profiles": {"ground": {"mean": 0.0, "sigma": 1.0, "assess": False}},
    }

# Неисправность сценария -> (канал, тип инцидента, который должен открыть монитор)
LABEL_MAP = {
    "mag_interference": [("mag", "quality")],
    "esc_dropout": [(f"motor{i + 1}", "availability") for i in range(4)],
    "vibration": [("vib", "quality"), ("vib", "noise")],     # вибрация: растут и уровень, и разброс
    "motor_wear": [(f"motor{WEAR_MOTOR + 1}", "quality")],
    "gyro_bias": [("gyro", "quality")],
    # esc_spike - одиночный выброс: разметки нет, тревоги быть не должно
}


def sid(channel):
    return f"{PREFIX}.{channel}"


class Gateway:
    """Отправка в шлюз из отдельного потока, чтобы не тормозить приём UDP."""

    def __init__(self, url, key=None):
        self.url = url.rstrip("/") + "/api/v1"
        self.key = key
        self.q = Queue(maxsize=2000)
        threading.Thread(target=self._worker, daemon=True).start()

    def request(self, method, path, body=None):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.url + path, data=data, method=method,
                                     headers={"Content-Type": "application/json", **({"X-API-Key": self.key} if self.key else {})})
        try:
            with urllib.request.urlopen(req, timeout=3) as r:
                return r.status, json.loads(r.read() or b"null")
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode(errors="replace")
        except OSError as e:
            return 0, str(e)

    def send_async(self, method, path, body=None):
        try:
            self.q.put_nowait((method, path, body))
        except Exception:
            pass                                    # очередь переполнена: шлюз недоступен, данные теряем

    def _worker(self):
        while True:
            try:
                method, path, body = self.q.get(timeout=1)
            except Empty:
                continue
            code, resp = self.request(method, path, body)
            if code >= 400 or code == 0:
                print(f"[шлюз] {method} {path}: {code} {str(resp)[:200]}")

    def register(self):
        for ch, c in CHANNELS.items():
            body = {"id": sid(ch), "name": c["name"], "unit": c["unit"], "tags": ["mavic", "webots"],
                    "config": c["config"], "profiles": c.get("profiles")}
            code, resp = self.request("POST", "/sensors", body)
            if code == 409:                         # уже есть - обновим параметры и сбросим состояние
                self.request("PATCH", f"/sensors/{sid(ch)}", {"config": c["config"]})
                self.request("POST", f"/sensors/{sid(ch)}/reset")
            elif code >= 400 or code == 0:
                print(f"[шлюз] не удалось зарегистрировать {sid(ch)}: {code} {resp}")
                return False
        return True


def features(m):
    """Признаки каналов из пакета телеметрии контроллера."""
    out = {"gyro": m.get("gyro"), "mag": m.get("mag"),
           "vib": abs(m["vib"]) if m.get("vib") is not None else None}
    w_cmd, w_meas = m.get("w_cmd") or [], m.get("w_meas")
    landed = m.get("mode") == "LANDED" or (m.get("alt") or 0) < 0.2
    for i in range(4):
        if landed:
            out[f"motor{i + 1}"] = 0.0                       # на земле моторы выключены - отдельный режим
        elif w_meas is None:
            out[f"motor{i + 1}"] = None                      # телеметрии ESC нет -> ничего не шлём (пропуск)
        else:
            out[f"motor{i + 1}"] = w_meas[i] / w_cmd[i] if w_cmd[i] > 1.0 else None
    return out, landed


def channel_mode(ch, m, landed):
    if ch.startswith("motor"):
        return "ground" if landed else "flight"
    if ch == "gyro":
        return "hover" if m.get("hover") and m.get("mode") == "MANUAL" else "maneuver"
    return "flight" if not landed else "ground"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--gateway", default=os.environ.get("SENSORWATCH_URL", "http://127.0.0.1:8000"))
    ap.add_argument("--key", default=os.environ.get("SENSORWATCH_INGEST_KEY"))
    ap.add_argument("--listen", type=int, default=5006, help="порт телеметрии контроллера")
    ap.add_argument("--forward", type=int, default=5016, help="куда пересылать для monitor.py (0 - не пересылать)")
    args = ap.parse_args()

    gw = Gateway(args.gateway, args.key)
    while not gw.register():
        print("[шлюз] жду шлюз...")
        time.sleep(2)
    print(f"мост запущен: UDP {args.listen} -> {gw.url}" + (f", копия в UDP {args.forward}" if args.forward else ""))

    rx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    rx.bind(("127.0.0.1", args.listen))
    rx.settimeout(0.2)                         # чтобы Ctrl+C срабатывал на Windows
    fwd = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    buf = {ch: [] for ch in CHANNELS}          # отсчёты текущего окна сжатия
    modes = {}
    last_flush = time.time()
    prev_t = None
    labels = {}                                # (канал, тип, начало сценария) -> разметка в настенном времени
    seq = 0

    while True:
        try:
            data = rx.recv(8192)
        except socket.timeout:
            data = None
        now = time.time()
        if data:
            if args.forward:
                fwd.sendto(data, ("127.0.0.1", args.forward))
            m = json.loads(data)
            t = m["t"]
            if prev_t is not None and t < prev_t - 0.5:          # перезапуск симуляции: новый полёт
                print("новый полёт: сбрасываю датчики и разметку")
                labels.clear()
                for ch in CHANNELS:
                    gw.send_async("POST", f"/sensors/{sid(ch)}/reset")
                    gw.send_async("PUT", f"/sensors/{sid(ch)}/labels", [])
            prev_t = t
            vals, landed = features(m)
            for ch, v in vals.items():
                if v is not None:
                    buf[ch].append(v)
                    modes[ch] = channel_mode(ch, m, landed)
            # Разметка: фиксируем настенное время прохождения границ сценария
            t0 = m.get("t0", -1.0)
            if t0 is not None and t0 >= 0:
                changed = set()
                for s, e, kind in SCENARIO:
                    for ch, typ in LABEL_MAP.get(kind, []):
                        key = (ch, typ, s)
                        if key not in labels and t - t0 >= s:
                            labels[key] = {"start": now, "end": now + 3600, "type": typ, "label": kind}
                            changed.add(ch)
                        if key in labels and e < 9000 and t - t0 >= e and labels[key]["end"] > now + 60:
                            labels[key]["end"] = now
                            changed.add(ch)
                for ch in changed:
                    gw.send_async("PUT", f"/sensors/{sid(ch)}/labels",
                                  [lb for (c, _, _), lb in labels.items() if c == ch])

        if now - last_flush >= FLUSH_S:
            batch = []
            for ch, vals in buf.items():
                if vals:
                    seq += 1
                    batch.append({"sensor_id": sid(ch), "event_time": now, "value": statistics.median(vals),
                                  "mode": modes.get(ch), "id": seq})
                    vals.clear()
            if batch:
                gw.send_async("POST", "/ingest", {"messages": batch})
            last_flush = now


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("мост остановлен")
