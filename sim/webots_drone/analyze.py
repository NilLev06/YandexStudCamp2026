"""Анализ полётов: графики, метрики и HTML-отчёт со сравнением политик.

Запуск:
    python analyze.py           -> logs/report.html (открывается в браузере)
    python analyze.py --clean   -> удалить старые полёты, оставить последний полёт каждой политики
    python analyze.py --all     -> удалить ВСЕ полёты (начать с чистого листа)
"""
import base64
import csv
import glob
import html
import os
import pathlib
import shutil
import sys
import webbrowser
from collections import Counter

import matplotlib
matplotlib.use("Agg")       # рисуем сразу в файл, без окон
import matplotlib.pyplot as plt  # noqa: E402

LOG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs")
TOL = 2.0                   # допуск по времени при сопоставлении тревоги с событием, с
MIN_FLIGHT_S = 20.0         # полёты короче этого (после взлёта) не считаем

LABEL_ROW = {"gyro_bias": "gyro", "mag_interference": "mag", "vibration": "vib",
             "esc_spike": "r", "esc_dropout": "r", "motor_wear": "r"}
ALARM_ROW = {"gyro": "gyro", "mag": "mag", "vib": "vib", "motor": "r",
             "esc_gap": "r", "link": "alt"}
ALARM_CH = {"gyro_bias": "gyro", "mag_interference": "mag", "vibration": "vib",
            "esc_dropout": "esc_gap", "motor_wear": "motor", "esc_spike": "motor"}
SPIKES = {"esc_spike"}      # скачки: тревога на них = ложная
POLICY_NAMES = {"none": "Без защиты", "threshold": "Наивный порог", "cusum": "CUSUM (наш)"}
FAULT_NAMES = {"esc_spike": "Сбой телеметрии мотора (не поломка)",
               "mag_interference": "Магнитная помеха", "esc_dropout": "Нет телеметрии моторов",
               "vibration": "Вибрации", "motor_wear": "Износ мотора 3",
               "gyro_bias": "Дрейф гироскопа"}
MODE_COLORS = {"HOLD": "gold", "RTH": "deepskyblue", "LAND": "limegreen", "LANDED": "gray"}


def read(path):
    """Прочитать CSV (пустой список, если файла нет)."""
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        return list(csv.DictReader(f))


def num(v):
    """Число из ячейки CSV (True/False -> 1/0)."""
    if v == "True":
        return 1.0
    if v == "False":
        return 0.0
    return float(v)


def alarm_row(channel):
    """Строка графика для тревоги (motor1..motor4 и motor_fail -> строка моторов)."""
    if channel.startswith("motor"):
        return "r"
    return ALARM_ROW.get(channel)


def mode_spans(tel, t):
    """Интервалы режимов, отличных от MANUAL: [(начало, конец, режим)]."""
    spans, cur, start = [], None, None
    for ti, r in zip(t, tel):
        m = r["mode"]
        if m != cur:
            if cur in MODE_COLORS:
                spans.append((start, ti, cur))
            cur, start = m, ti
    if cur in MODE_COLORS:
        spans.append((start, t[-1], cur))
    return spans


def plot(tel, t, labels, alarms, policy, out):
    """Графики каналов: оранжевое - неисправность, красное - тревога, цвет на высоте - режим."""
    t_end = t[-1]
    rows = [("gyro", "Гироскоп, рад/с"), ("mag", "|B| дрона"), ("vib", "Вибрация"),
            ("r", "Моторы: обороты\nизмер. / задан."), ("alt", "Высота, м")]
    fig, axes = plt.subplots(len(rows), 1, sharex=True, figsize=(12, 2.2 * len(rows)))
    for ax, (col, title) in zip(axes, rows):
        if col == "r":              # 4 мотора на одном графике
            for i in range(1, 5):
                pts = [(ti, num(r[f"r{i}"])) for ti, r in zip(t, tel) if r.get(f"r{i}")]
                ax.plot([p[0] for p in pts], [p[1] for p in pts], lw=0.6, label=f"М{i}")
            pts = [(ti, num(r["comp_max"])) for ti, r in zip(t, tel) if r.get("comp_max")]
            if pts:
                ax.plot([p[0] for p in pts], [p[1] for p in pts], "k--", lw=1,
                        label="компенсация")
            ax.legend(loc="lower left", fontsize=7, ncol=4)
        else:
            pts = [(ti, num(r[col])) for ti, r in zip(t, tel) if r.get(col, "") != ""]
            ax.plot([p[0] for p in pts], [p[1] for p in pts], lw=0.6)
        for lb in labels:
            if LABEL_ROW.get(lb["type"]) == col and lb["s"] <= t_end:
                ax.axvspan(lb["s"], max(min(lb["e"], t_end), lb["s"] + 0.3),
                           color="orange", alpha=0.3)
        for a in alarms:
            if alarm_row(a["channel"]) == col:
                ax.axvline(float(a["t"]), color="red", ls="--", lw=1)
        if col == "alt":            # режимы дрона - фоном на графике высоты
            seen = set()
            for s, e, m in mode_spans(tel, t):
                ax.axvspan(s, max(e, s + 0.2), color=MODE_COLORS[m], alpha=0.25,
                           label=None if m in seen else m)
                seen.add(m)
            if seen:
                ax.legend(loc="upper right", fontsize=7)
        ax.set_ylabel(title, fontsize=8)
    axes[-1].set_xlabel("t, с")
    fig.suptitle(f"{POLICY_NAMES.get(policy, policy)}: оранжевое - неисправность, "
                 f"красное - тревога, фон высоты - режим дрона")
    fig.tight_layout()
    fig.savefig(out, dpi=110)
    plt.close(fig)


def analyze_run(run_dir, labels_rel):
    """Метрики одного полёта. None - если дрон не взлетел или полёт слишком короткий."""
    tel = read(os.path.join(run_dir, "telemetry.csv"))
    if not tel:
        return None
    alarms = [a for a in read(os.path.join(run_dir, "alarms.csv")) if a["event"] == "raise"]
    t0 = next((float(r["t0"]) for r in tel if r["t0"] and float(r["t0"]) >= 0), None)
    if t0 is None:
        return None
    t = [float(r["t"]) for r in tel]
    t_end = t[-1]
    if t_end - t0 < MIN_FLIGHT_S:
        return None
    policy = Counter(r["policy"] for r in tel).most_common(1)[0][0]
    labels = [{"type": lb["type"], "s": t0 + float(lb["start"]), "e": t0 + float(lb["end"])}
              for lb in labels_rel]

    # исход полёта: когда дрон оказался на земле и почему
    down_t, down_mode = None, None
    for r in tel:
        if float(r["t"]) > t0 + 3.0 and float(r["alt"]) < 0.3:
            down_t, down_mode = float(r["t"]), r["mode"]
            break
    land_needed = min((lb["s"] for lb in labels if lb["type"] == "gyro_bias"), default=1e9)
    if down_t is None:
        outcome = ("в воздухе до конца записи", "ok")
    elif down_mode not in ("LAND", "LANDED"):
        outcome = (f"ПАДЕНИЕ ({down_t - t0:.0f} с, режим {down_mode})", "bad")
    elif down_t < land_needed:
        outcome = (f"лишняя посадка ({down_t - t0:.0f} с)", "bad")
    else:
        outcome = (f"посадка по команде ({down_t - t0:.0f} с)", "ok")
    t_air = down_t if down_t is not None else t_end

    # результат по каждой неисправности: (текст, класс для цвета)
    results, used, spike_hits = {}, set(), 0
    for lb in labels:
        s, e = lb["s"], lb["e"]
        if s > t_air:
            results[lb["type"]] = ("дрон уже на земле", "")
            continue
        ch = ALARM_CH[lb["type"]]
        hit = next((a for a in alarms if a["channel"].startswith(ch)
                    and s <= float(a["t"]) <= min(e, t_end) + TOL), None)
        if hit:
            used.add(id(hit))
        if lb["type"] in SPIKES:
            results[lb["type"]] = ("ЛОЖНАЯ ТРЕВОГА", "bad") if hit else ("проигнорирован", "ok")
            spike_hits += 1 if hit else 0
        elif policy == "none":
            results[lb["type"]] = ("монитор выключен", "")
        elif hit:
            results[lb["type"]] = (f"через {float(hit['t']) - s:.1f} с", "ok")
        elif lb["type"] == "esc_dropout" and any(
                a["channel"] == "motor_fail" and s <= float(a["t"]) <= e + TOL for a in alarms):
            results[lb["type"]] = ("принято за отказ моторов -> посадка", "bad")
        else:
            results[lb["type"]] = ("не обнаружено", "bad")
    false = [a for a in alarms if id(a) not in used and a["channel"] not in ("link", "policy")
             and float(a["t"]) <= t_air]

    return {"dir": run_dir, "name": os.path.basename(run_dir), "policy": policy,
            "labels": labels, "alarms": alarms, "tel": tel, "t": t, "results": results,
            "false": len(false) + spike_hits, "outcome": outcome}


def img64(path):
    """Картинка внутрь HTML (base64), чтобы отчёт был одним файлом."""
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode()


def cell(text, cls):
    """Ячейка таблицы с цветом."""
    return f'<td class="{cls}">{html.escape(text)}</td>'


def clean(keep_latest):
    """Удалить папки полётов. keep_latest=True - оставить последний полёт каждой политики."""
    labels_rel = read(os.path.join(LOG_DIR, "labels.csv"))
    dirs = sorted(glob.glob(os.path.join(LOG_DIR, "run_*")))
    keep = set()
    if keep_latest:
        latest = {}
        for d in dirs:
            try:
                r = analyze_run(d, labels_rel)
            except (ValueError, KeyError):
                r = None
            if r:
                latest[r["policy"]] = d
        keep = set(latest.values())
    removed = 0
    for d in dirs:
        if d not in keep:
            shutil.rmtree(d, ignore_errors=True)
            removed += 1
    print(f"удалено полётов: {removed}, осталось: {len(keep)}")


def main():
    """Проанализировать полёты и собрать отчёт."""
    if "--all" in sys.argv:
        clean(keep_latest=False)
        return
    if "--clean" in sys.argv:
        clean(keep_latest=True)

    labels_rel = read(os.path.join(LOG_DIR, "labels.csv"))
    runs = []
    for d in sorted(glob.glob(os.path.join(LOG_DIR, "run_*"))):
        try:
            r = analyze_run(d, labels_rel)
        except (ValueError, KeyError) as e:
            print(f"{os.path.basename(d)}: пропущен ({e})")
            continue
        if r:
            runs.append(r)
            print(f"{r['name']}: {POLICY_NAMES.get(r['policy'], r['policy'])}, "
                  f"ложных тревог {r['false']}, исход: {r['outcome'][0]}")
    if not runs:
        print("нет полётов для анализа (короткие полёты < 20 с не считаются)")
        return

    # последний полёт каждой политики - в таблицу и в графики
    latest = {}
    for r in runs:
        latest[r["policy"]] = r
    cols = [p for p in ("none", "threshold", "cusum") if p in latest]

    head = "".join(f"<th>{POLICY_NAMES[p]}<br><small>{latest[p]['name']}</small></th>"
                   for p in cols)
    body = ""
    for lb in labels_rel:
        k = lb["type"]
        body += f"<tr><th>{FAULT_NAMES.get(k, k)}</th>"
        body += "".join(cell(*latest[p]["results"].get(k, ("-", ""))) for p in cols) + "</tr>"
    body += "<tr><th>Ложных тревог</th>" + "".join(
        cell(str(latest[p]["false"]), "bad" if latest[p]["false"] else "ok") for p in cols) + "</tr>"
    body += "<tr><th>Исход полёта</th>" + "".join(
        cell(*latest[p]["outcome"]) for p in cols) + "</tr>"

    figs = ""
    for p in cols:
        r = latest[p]
        png = os.path.join(r["dir"], "flight.png")
        plot(r["tel"], r["t"], r["labels"], r["alarms"], p, png)
        figs += (f'<h3>{POLICY_NAMES[p]} - {r["name"]}</h3>'
                 f'<img src="data:image/png;base64,{img64(png)}">')

    page = f"""<!doctype html><html lang="ru"><meta charset="utf-8">
<title>Монитор дрейфа - отчёт</title>
<style>
body {{ font-family: system-ui, sans-serif; margin: 24px; max-width: 1200px; color: #222; }}
table {{ border-collapse: collapse; margin: 16px 0; }}
th, td {{ border: 1px solid #ccc; padding: 6px 12px; text-align: left; vertical-align: top; }}
td.ok {{ background: #e3f6e3; }} td.bad {{ background: #fbe2e2; font-weight: 600; }}
small {{ color: #888; font-weight: normal; }}
img {{ max-width: 100%; border: 1px solid #ddd; margin-bottom: 24px; }}
</style>
<h1>Монитор дрейфа сенсоров - сравнение политик</h1>
<p>Один и тот же сценарий неисправностей, три политики мониторинга (последний полёт каждой).</p>
<table><tr><th>Неисправность</th>{head}</tr>{body}</table>
<h2>Графики полётов</h2>{figs}
</html>"""
    out = os.path.join(LOG_DIR, "report.html")
    with open(out, "w", encoding="utf-8") as f:
        f.write(page)
    print(f"\nотчёт: {out}")
    webbrowser.open(pathlib.Path(out).as_uri())


if __name__ == "__main__":
    main()