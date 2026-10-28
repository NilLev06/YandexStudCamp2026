"""Запуск всей демонстрации одной командой (Windows, Linux, macOS).

    python start_demo.py                 # шлюз + интерфейс + дрон (мост, бортовой монитор, телефон) + Webots
    python start_demo.py --no-drone      # только шлюз и интерфейс (сценарии)
    python start_demo.py --no-phone      # дрон без телефона (управление клавишами в Webots)
    python start_demo.py --phone http://192.168.1.5:8080   # адрес, который показывает Phyphox
    python start_demo.py --webots "D:/Webots/msys64/mingw64/bin/webotsw.exe"

Все процессы пишут в одно окно с меткой [шлюз], [мост], [монитор], [телефон].
Ctrl+C или закрытие окна останавливает всё.
"""
import argparse
import os
import signal
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DRONE = ROOT / "sim" / "webots_drone"
WORLD = DRONE / "worlds" / "drift.wbt"
DEFAULT_WEBOTS = r"C:\Program Files\Webots\msys64\mingw64\bin\webotsw.exe"
PORT = 8000

procs: list[tuple[str, subprocess.Popen]] = []


def start(tag: str, args: list[str], cwd: Path, env: dict | None = None, quiet: bool = False) -> subprocess.Popen:
    """Запустить процесс и печатать его вывод с меткой."""
    p = subprocess.Popen(args, cwd=cwd, env={**os.environ, "PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8", **(env or {})},
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
                         creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0)
    procs.append((tag, p))

    def pump():
        for line in p.stdout:
            line = line.rstrip()
            if line and not (quiet and ("GET /api" in line or "POST /api" in line)):
                print(f"[{tag}] {line}", flush=True)
        print(f"[{tag}] процесс завершился (код {p.wait()})", flush=True)

    threading.Thread(target=pump, daemon=True).start()
    return p


def wait_gateway(timeout: float = 30) -> bool:
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/v1/health", timeout=1):
                return True
        except OSError:
            time.sleep(0.5)
    return False


def stop_all() -> None:
    for tag, p in reversed(procs):
        if p.poll() is None:
            try:
                p.terminate()
            except OSError:
                pass
    for _, p in procs:
        try:
            p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            p.kill()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--no-drone", action="store_true", help="без дрона: только шлюз и интерфейс")
    ap.add_argument("--no-phone", action="store_true", help="без телефона")
    ap.add_argument("--no-webots", action="store_true", help="не открывать Webots (если он уже открыт)")
    ap.add_argument("--phone", default=os.environ.get("PHONE_URL"), help="адрес Phyphox, например http://192.168.1.5:8080")
    ap.add_argument("--webots", default=os.environ.get("WEBOTS", DEFAULT_WEBOTS), help="путь к webotsw.exe")
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    py = sys.executable
    if not (ROOT / "frontend" / "dist" / "index.html").exists():
        print("! Нет собранного интерфейса frontend/dist: будет доступен только API (/docs).")

    print(f"Запускаю шлюз на http://localhost:{PORT} ...")
    start("шлюз", [py, "-m", "uvicorn", "app.main:app", "--port", str(PORT)], ROOT / "gateway", quiet=True)
    if not wait_gateway():
        print("Шлюз не запустился. Проверьте: python -m pip install -r gateway/requirements.txt")
        stop_all()
        sys.exit(1)

    if not args.no_drone:
        start("мост", [py, "gateway_bridge.py", "--gateway", f"http://127.0.0.1:{PORT}"], DRONE)
        start("монитор", [py, "monitor.py"], DRONE, env={"MONITOR_PORT": "5016"})
        if not args.no_phone:
            env = {"PHONE_URL": args.phone} if args.phone else None
            start("телефон", [py, "bridge.py"], DRONE, env=env)
        if not args.no_webots:
            webots = Path(args.webots)
            if webots.exists():
                print(f"Открываю Webots: {WORLD.name}")
                subprocess.Popen([str(webots), str(WORLD)], cwd=DRONE)
            else:
                print(f"! Webots не найден: {webots}. Укажите путь: --webots \"...\\webotsw.exe\"")

    if not args.no_browser:
        webbrowser.open(f"http://localhost:{PORT}")
    print("\nВсё запущено. Интерфейс: http://localhost:8000   API: http://localhost:8000/docs")
    print("Остановить всё: Ctrl+C\n")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        print("\nОстанавливаю...")
        stop_all()


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_: (stop_all(), sys.exit(0)))
    main()
