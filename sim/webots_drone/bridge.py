"""Мост: наклон телефона (Phyphox, "Ускорение с g") -> команды дрону в Webots.
Телефон опрашивается в отдельном потоке, а команды уходят дрону с постоянной частотой:
короткие задержки Wi-Fi не вызывают ложную потерю связи."""
import json
import math
import os
import socket
import threading
import time
import urllib.request

# адрес, который показывает Phyphox (можно задать переменной PHONE_URL или в start_demo.py --phone)
PHONE = os.environ.get("PHONE_URL", "http://172.22.60.144:8080")
DRONE = ("127.0.0.1", 5005)
DEAD_DEG = 5.0                        # мёртвая зона наклона, градусы
MAX_DEG = 20.0                        # наклон для максимальной команды
STALE_S = 1.0                         # данные старше этого -> не шлём (дрон уйдёт в HOLD)

latest = {"pitch": 0.0, "roll": 0.0, "time": 0.0}   # последнее измерение и когда получено
lock = threading.Lock()


def poll_phone():
    """Поток: постоянно опрашивает телефон и обновляет latest."""
    last_t = 0.0
    while True:
        q = (f"/get?acc_time={last_t}&accX={last_t}%7Cacc_time"
             f"&accY={last_t}%7Cacc_time&accZ={last_t}%7Cacc_time")
        try:
            with urllib.request.urlopen(PHONE + q, timeout=0.5) as r:
                b = json.load(r)["buffer"]
        except Exception:
            time.sleep(0.05)          # зависший запрос бросаем и сразу пробуем снова
            continue
        ts = b["acc_time"]["buffer"]
        if ts:
            last_t = ts[-1]
            ax, ay, az = (b[k]["buffer"][-1] for k in ("accX", "accY", "accZ"))
            with lock:
                latest["pitch"] = math.degrees(math.atan2(-ay, math.hypot(ax, az)))
                latest["roll"] = math.degrees(math.atan2(ax, az))
                latest["time"] = time.time()
        time.sleep(0.02)


def axis(deg, gain):
    """Угол наклона -> команда в диапазоне [-gain, gain] с мёртвой зоной."""
    if abs(deg) < DEAD_DEG:
        return 0.0
    return max(-1.0, min(1.0, deg / MAX_DEG)) * gain


threading.Thread(target=poll_phone, daemon=True).start()
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

while True:
    with lock:
        pitch, roll, got = latest["pitch"], latest["roll"], latest["time"]
    age = time.time() - got
    if got == 0.0:
        print("жду первые данные с телефона...                          ", end="\r")
    elif age < STALE_S:
        # если ось работает наоборот - поменять знак здесь
        stick = {"roll": axis(roll, 1.0), "pitch": axis(-pitch, 2.0), "yaw": 0.0}
        sock.sendto(json.dumps({"stick": stick}).encode(), DRONE)
        print(f"pitch={pitch:6.1f} roll={roll:6.1f}  возраст данных={age * 1000:4.0f} мс   ", end="\r")
    else:
        print(f"нет свежих данных с телефона ({age:4.1f} с)                    ", end="\r")
    time.sleep(0.03)