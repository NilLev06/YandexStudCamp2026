"""Проверка связи с телефоном: чтение акселерометра Phyphox с обработкой разрывов."""
import json
import time
import urllib.request

PHONE = "http://172.22.60.144:8080"   # адрес, который показывает Phyphox
last_t = 0.0                          # время последнего полученного отсчёта
gap_since = None                      # момент начала разрыва связи


def get(path, timeout=2.0):
    """GET-запрос к Phyphox, ответ в JSON."""
    with urllib.request.urlopen(PHONE + path, timeout=timeout) as r:
        return json.load(r)


while True:
    # просим только отсчёты новее last_t (после разрыва придут все пропущенные)
    q = (f"/get?acc_time={last_t}&accX={last_t}%7Cacc_time"
         f"&accY={last_t}%7Cacc_time&accZ={last_t}%7Cacc_time")
    try:
        b = get(q)["buffer"]
    except urllib.error.HTTPError as e:
        print("HTTP", e.code, e.read()[:200])
        time.sleep(1)
        continue
    except Exception as e:
        if gap_since is None:
            gap_since = time.time()
            print("НЕТ ДАННЫХ:", type(e).__name__)
        time.sleep(0.2)
        continue

    if gap_since is not None:
        print(f"СВЯЗЬ ВОССТАНОВЛЕНА через {time.time() - gap_since:.1f} с")
        gap_since = None

    ts = b["acc_time"]["buffer"]
    if ts:
        z = b["accZ"]["buffer"][-1]
        print(f"{len(ts):4d} новых отсчётов  t={ts[-1]:7.2f}  z={z:5.2f}")
        last_t = ts[-1]
    time.sleep(0.05)                  # не перегружать сервер телефона