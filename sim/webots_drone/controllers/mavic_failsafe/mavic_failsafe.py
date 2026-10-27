"""Контроллер Mavic 2 Pro: пульт-телефон, аварийные режимы, компенсация моторов, HUD.
Неисправности внедряет faults.py - логика управления о них не знает.
Монитор присылает коэффициенты компенсации моторов ("comp") и аварийные режимы.
Клавиши (кликнуть по 3D-виду): R - вернуть управление, W/S - выше/ниже,
1/2/3 - политика монитора: без защиты / порог / CUSUM."""
import json
import math
import os
import socket

from controller import Supervisor

from faults import FaultInjector

# Константы из стандартного примера mavic2pro (Webots)
K_VERTICAL_THRUST = 68.5   # тяга, при которой дрон висит
K_VERTICAL_OFFSET = 0.6    # смещение для стабилизации высоты
K_VERTICAL_P = 3.0         # P-коэффициент по высоте
K_ROLL_P = 50.0            # P-коэффициент по крену
K_PITCH_P = 30.0           # P-коэффициент по тангажу

# Пульт: ограничение и сглаживание команд
STICK_MAX_ROLL = 1.0       # макс. команда крена
STICK_MAX_PITCH = 2.0      # макс. команда тангажа
STICK_SMOOTH = 0.2         # фильтр команд: доля нового значения за шаг (1.0 = без фильтра)

# Удержание позиции и возврат домой (по скорости из GPS)
K_BRAKE = 1.0              # торможение: команда на 1 м/с скорости (если разгоняется - поставить -1.0)
K_POS = 0.4                # возврат домой: команда на 1 м ошибки
BRAKE_MAX = 1.0            # ограничение команд в HOLD/RTH/LAND

LINK_HOLD = 2.0            # сек без данных пульта -> HOLD
LINK_RTH = 6.0             # сек без данных пульта -> RTH
TOUCHDOWN_ALT = 0.15       # ниже этой высоты при посадке - выключаем моторы

CMD_ADDR = ("127.0.0.1", 5005)     # команды: пульт, монитор
TELEM_ADDR = ("127.0.0.1", 5006)   # телеметрия для монитора
LOG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "logs")
POLICIES = {ord("1"): "none", ord("2"): "threshold", ord("3"): "cusum"}


def clamp(v, lo, hi):
    """Ограничить значение диапазоном [lo, hi]."""
    return max(lo, min(hi, v))


# --- Инициализация ---
robot = Supervisor()               # Supervisor нужен только для надписей HUD
dt = int(robot.getBasicTimeStep())
dt_s = dt / 1000.0

imu = robot.getDevice("inertial unit")
imu.enable(dt)
gps = robot.getDevice("gps")
gps.enable(dt)
gyro = robot.getDevice("gyro")
gyro.enable(dt)
compass = robot.getDevice("compass")
compass.enable(dt)
kb = robot.getKeyboard()
kb.enable(dt)

names = ["front left propeller", "front right propeller",
         "rear left propeller", "rear right propeller"]
motors = [robot.getDevice(n) for n in names]
for m in motors:
    m.setPosition(float("inf"))
    m.setVelocity(1.0)

rx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
rx.bind(CMD_ADDR)
rx.setblocking(False)
tx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

os.makedirs(LOG_DIR, exist_ok=True)
faults = FaultInjector(labels_path=os.path.join(LOG_DIR, "labels.csv"))

# --- Состояние ---
stick = {"roll": 0.0, "pitch": 0.0, "yaw": 0.0}    # последняя команда пульта
smooth = {"roll": 0.0, "pitch": 0.0, "yaw": 0.0}   # сглаженная команда
mode = "MANUAL"            # MANUAL / HOLD / RTH / LAND / LANDED
last_rx = 0.0
ever_linked = False
target_alt = 1.5
home = None
prev_xy = None             # положение на прошлом шаге (для оценки скорости)
vx = vy = 0.0              # скорость по GPS, м/с
comp = [1.0, 1.0, 1.0, 1.0]   # компенсация моторов от монитора (1.0 = без компенсации)
monitor_status = "норма"
policy = "cusum"
step_n = 0


def hud(active):
    """Надписи поверх 3D-вида."""
    robot.setLabel(0, f"Режим: {mode}", 0.01, 0.01, 0.08, 0xFFFFFF, 0.0, "Arial")
    injected = ", ".join(active) if active else "-"
    robot.setLabel(1, f"Внедрено: {injected}", 0.01, 0.06, 0.07, 0xFFA500, 0.0, "Arial")
    color = 0x30FF30 if monitor_status in ("норма", "норма откалибрована") else 0xFF3030
    robot.setLabel(2, f"Монитор: {monitor_status}", 0.01, 0.11, 0.07, color, 0.0, "Arial")
    robot.setLabel(3, f"Политика: {policy}  (1/2/3)", 0.01, 0.16, 0.07, 0x80C0FF, 0.0, "Arial")
    fixed = [f"М{i + 1} x{c:.2f}" for i, c in enumerate(comp) if abs(c - 1.0) > 0.01]
    robot.setLabel(4, "Компенсация: " + (", ".join(fixed) if fixed else "-"),
                   0.01, 0.21, 0.07, 0xFFFF60, 0.0, "Arial")


while robot.step(dt) != -1:
    t = robot.getTime()
    step_n += 1

    # 1. Пакеты от пульта и монитора
    while True:
        try:
            data, _ = rx.recvfrom(2048)
        except BlockingIOError:
            break
        msg = json.loads(data)
        if "stick" in msg:
            stick, last_rx, ever_linked = msg["stick"], t, True
        if "mode" in msg and msg["mode"] != "MANUAL" and mode != "LANDED":
            mode = msg["mode"]             # монитор может только ужесточить режим
        if "comp" in msg:
            comp = [clamp(c, 0.7, 1.4) for c in msg["comp"]]
        if "status" in msg:
            monitor_status = msg["status"]

    # 2. Клавиатура
    key = kb.getKey()
    while key != -1:
        if key == ord("R"):
            mode, last_rx, target_alt = "MANUAL", t, 1.5
        elif key == ord("W"):
            target_alt = min(4.0, target_alt + 0.05)
        elif key == ord("S"):
            target_alt = max(0.3, target_alt - 0.05)
        elif key in POLICIES:
            policy = POLICIES[key]
            comp = [1.0, 1.0, 1.0, 1.0]   # новая политика начинает без компенсации
        key = kb.getKey()

    # 3. Датчики
    roll, pitch, yaw = imu.getRollPitchYaw()
    roll_v, pitch_v, _ = gyro.getValues()
    x, y, alt = gps.getValues()        # высоту считаем отдельным датчиком (барометр)
    mag_vec = compass.getValues()
    if home is None and alt > 1.0:
        home = (x, y)
        faults.start(t)                # сценарий отсчитывается от взлёта

    # 4. Инъекция неисправностей датчиков (дальше код видит только испорченные данные)
    roll_v, mag_vec, vib, shake = faults.apply_sensors(t, roll_v, mag_vec)

    # 5. Скорость по GPS (для торможения в аварийных режимах)
    if prev_xy is not None:
        vx = 0.9 * vx + 0.1 * (x - prev_xy[0]) / dt_s
        vy = 0.9 * vy + 0.1 * (y - prev_xy[1]) / dt_s
    prev_xy = (x, y)
    v_fwd = vx * math.cos(yaw) + vy * math.sin(yaw)       # скорость в осях дрона
    v_left = -vx * math.sin(yaw) + vy * math.cos(yaw)

    # 6. Failsafe по потере связи (только если пульт уже был подключён)
    silent = t - last_rx
    if ever_linked and mode == "MANUAL" and silent > LINK_HOLD:
        mode = "HOLD"
    if ever_linked and mode == "HOLD" and silent > LINK_RTH:
        mode = "RTH"

    # 7. Уставки по режиму
    roll_d = pitch_d = yaw_d = 0.0
    if mode == "MANUAL":
        for k in smooth:               # сглаживание команд пульта
            smooth[k] += STICK_SMOOTH * (stick.get(k, 0.0) - smooth[k])
        roll_d = clamp(smooth["roll"], -STICK_MAX_ROLL, STICK_MAX_ROLL)
        pitch_d = clamp(smooth["pitch"], -STICK_MAX_PITCH, STICK_MAX_PITCH)
        yaw_d = clamp(smooth["yaw"], -1.3, 1.3)
    else:
        for k in smooth:
            smooth[k] = 0.0
        # HOLD и LAND: тормозим (pitch > 0 - назад, roll < 0 - вправо)
        pitch_d = clamp(K_BRAKE * v_fwd, -BRAKE_MAX, BRAKE_MAX)
        roll_d = clamp(-K_BRAKE * v_left, -BRAKE_MAX, BRAKE_MAX)
        if mode == "RTH" and home:
            ex, ey = home[0] - x, home[1] - y
            fwd = ex * math.cos(yaw) + ey * math.sin(yaw)
            left = -ex * math.sin(yaw) + ey * math.cos(yaw)
            # ПД-регулятор: к дому + торможение
            pitch_d = clamp(-K_POS * fwd + K_BRAKE * v_fwd, -BRAKE_MAX, BRAKE_MAX)
            roll_d = clamp(K_POS * left - K_BRAKE * v_left, -BRAKE_MAX, BRAKE_MAX)
            if math.hypot(ex, ey) < 0.5 and math.hypot(vx, vy) < 0.3:
                mode = "LAND"
        if mode == "LAND":
            target_alt = max(0.0, target_alt - 0.002)
            if alt < TOUCHDOWN_ALT:
                mode = "LANDED"        # коснулись земли - выключаем моторы (disarm)

    # 8. Закон управления из примера mavic2pro
    roll_in = K_ROLL_P * clamp(roll, -1, 1) + roll_v + roll_d
    roll_in += shake                   # физический эффект вибрации (0 без неисправности)
    pitch_in = K_PITCH_P * clamp(pitch, -1, 1) + pitch_v + pitch_d
    yaw_in = yaw_d
    diff = clamp(target_alt - alt + K_VERTICAL_OFFSET, -1, 1)
    vert = K_VERTICAL_P * diff ** 3
    w_ctrl = [K_VERTICAL_THRUST + vert - roll_in + pitch_in - yaw_in,    # передний левый
              K_VERTICAL_THRUST + vert + roll_in + pitch_in + yaw_in,    # передний правый
              K_VERTICAL_THRUST + vert - roll_in - pitch_in + yaw_in,    # задний левый
              K_VERTICAL_THRUST + vert + roll_in - pitch_in - yaw_in]    # задний правый
    if mode == "LANDED":
        w_ctrl = [0.0, 0.0, 0.0, 0.0]  # моторы выключены до команды оператора (R)

    # 9. Моторы: компенсация от монитора -> модель моторов (износ) -> Webots
    w_cmd = [w * c for w, c in zip(w_ctrl, comp)]
    w_real, w_meas = faults.apply_motors(t, w_cmd)
    motors[0].setVelocity(w_real[0])
    motors[1].setVelocity(-w_real[1])
    motors[2].setVelocity(-w_real[2])
    motors[3].setVelocity(w_real[3])

    # 10. Телеметрия для монитора
    hover = abs(roll_d) + abs(pitch_d) < 0.05
    mag = math.sqrt(sum(c * c for c in mag_vec))
    tx.sendto(json.dumps({
        "t": t, "t0": faults.t0 if faults.t0 is not None else -1.0, "policy": policy,
        "gyro": roll_v, "mag": mag, "vib": vib, "alt": alt, "hover": hover, "mode": mode,
        "w_cmd": w_cmd, "w_meas": w_meas, "comp": comp,
        "link_age": silent if ever_linked else -1.0,
    }).encode(), TELEM_ADDR)

    # 11. HUD (не каждый шаг, чтобы не нагружать)
    if step_n % 8 == 0:
        hud(faults.active(t))