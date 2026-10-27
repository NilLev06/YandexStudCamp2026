"""Тест без телефона: шлём дрону постоянную команду "медленно вперёд"."""
import json
import socket
import time

sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
while True:
    stick = {"roll": 0.0, "pitch": -0.5, "yaw": 0.0}   # pitch < 0 = вперёд
    sock.sendto(json.dumps({"stick": stick}).encode(), ("127.0.0.1", 5005))
    time.sleep(0.03)