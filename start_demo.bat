@echo off
rem Двойной клик: шлюз + интерфейс + дрон + Webots. Остановить: Ctrl+C или закрыть окно.
chcp 65001 >nul
cd /d "%~dp0"
python start_demo.py %*
pause
