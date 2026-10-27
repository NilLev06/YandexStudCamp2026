"""Имитация телеметрии контроллера дрона без Webots (для проверки моста и монитора).

Физики нет: дрон взлетает и висит, faults.py портит датчики и моторы по сценарию.
    python tools/fake_drone.py --speed 3     # в 3 раза быстрее реального времени
"""
import argparse
import json
import os
import random
import socket
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "controllers", "mavic_failsafe"))
from faults import FaultInjector  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--speed", type=float, default=1.0)
ap.add_argument("--duration", type=float, default=105.0)
ap.add_argument("--policy", default="cusum")
ap.add_argument("--port", type=int, default=5006)
args = ap.parse_args()

rx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
rx.bind(("127.0.0.1", 5005))
rx.setblocking(False)
tx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
os.makedirs(os.path.join(HERE, "..", "logs"), exist_ok=True)
f = FaultInjector(os.path.join(HERE, "..", "logs", "labels.csv"))
t, dt, alt, mode, comp = 0.0, 0.008, 0.1, "MANUAL", [1.0] * 4
rng = random.Random(3)
start = time.time()
while t < args.duration:
    t += dt
    while True:
        try:
            m = json.loads(rx.recvfrom(4096)[0])
        except (BlockingIOError, ConnectionResetError):
            break
        if "mode" in m and mode != "LANDED":
            mode = m["mode"]
        if "comp" in m:
            comp = m["comp"]
    if t > 2.5 and mode in ("MANUAL", "HOLD"):
        alt = min(1.5, alt + 0.004)
    if mode == "LAND":
        alt = max(0.0, alt - 0.002)
        if alt < 0.15:
            mode = "LANDED"
    if alt > 1.0:
        f.start(t)
    g, mv, vib, _ = f.apply_sensors(t, rng.gauss(0, 0.003), [1.0, 0.0, 0.0])
    w = [68.5 + rng.gauss(0, 0.3) for _ in range(4)] if mode != "LANDED" else [0.0] * 4
    w_cmd = [a * c for a, c in zip(w, comp)]
    _, w_meas = f.apply_motors(t, w_cmd)
    tx.sendto(json.dumps({"t": t, "t0": f.t0 if f.t0 else -1.0, "policy": args.policy, "gyro": g,
                          "mag": sum(c * c for c in mv) ** 0.5, "vib": vib, "alt": alt, "hover": True, "mode": mode,
                          "w_cmd": w_cmd, "w_meas": w_meas, "comp": comp, "link_age": 0.01}).encode(),
              ("127.0.0.1", args.port))
    lag = start + t / args.speed - time.time()
    if lag > 0:
        time.sleep(lag)
print("fake done", mode, [round(c, 2) for c in comp])
