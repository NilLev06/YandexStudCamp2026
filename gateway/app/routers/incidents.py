"""Инциденты, журнал событий и сводка для оператора."""
from __future__ import annotations

import time

from fastapi import APIRouter, HTTPException, Query

from sensorwatch import INCIDENT_TYPES

from ..hub import hub
from ..schemas import AckRequest, Event, Incident

router = APIRouter(tags=["Инциденты"])


@router.get("/incidents", response_model=list[Incident], summary="Инциденты всех датчиков")
def list_incidents(sensor_id: str | None = None, type: str | None = None,
                   state: str | None = Query(default=None, pattern="^(open|closed)$"),
                   limit: int = Query(default=500, ge=1, le=5000)) -> list[dict]:
    out = []
    for sid, inc in hub.incidents.values():
        if sensor_id and sid != sensor_id:
            continue
        if type and inc["type"] != type:
            continue
        if state == "open" and inc["end"] is not None or state == "closed" and inc["end"] is None:
            continue
        out.append(hub.incident_view(sid, inc))
    out.sort(key=lambda i: (not i["open"], -hub.sensors[i["sensor_id"]].created_at, -i["start"]))
    return out[:limit]


@router.get("/incidents/{incident_id:path}", response_model=Incident, summary="Один инцидент")
def get_incident(incident_id: str) -> dict:
    if incident_id not in hub.incidents:
        raise HTTPException(404, "Инцидент не найден")
    sid, inc = hub.incidents[incident_id]
    return hub.incident_view(sid, inc)


@router.post("/incidents/{incident_id:path}/ack", response_model=Incident, summary="Подтвердить, что оператор увидел")
def ack_incident(incident_id: str, req: AckRequest) -> dict:
    """Подтверждение не закрывает инцидент: закрывает только монитор, когда данные вернулись в норму."""
    if incident_id not in hub.incidents:
        raise HTTPException(404, "Инцидент не найден")
    sid, inc = hub.incidents[incident_id]
    inc.update(acknowledged=True, ack_by=req.by, ack_comment=req.comment, ack_at=time.time())
    view = hub.incident_view(sid, inc)
    hub.broadcast({"type": "incident_ack", "sensor_id": sid, "incident": view})
    return view


@router.get("/events", response_model=list[Event], summary="Журнал решений монитора")
def list_events(sensor_id: str | None = None, since: float | None = None,
                limit: int = Query(default=300, ge=1, le=10000)) -> list[dict]:
    out = []
    for rt in hub.sensors.values():
        if sensor_id and rt.id != sensor_id:
            continue
        out += [{"sensor_id": rt.id, **e} for e in rt.monitor.events if since is None or e["time"] >= since]
    out.sort(key=lambda e: e["time"], reverse=True)
    return out[:limit]


@router.get("/overview", summary="Сводка для главного экрана")
def overview() -> dict:
    sensors = [hub.summary(rt) for rt in hub.sensors.values()]
    by_quality: dict[str, int] = {}
    by_availability: dict[str, int] = {}
    for s in sensors:
        st = s["status"] or {}
        by_quality[st.get("quality", "unknown")] = by_quality.get(st.get("quality", "unknown"), 0) + 1
        by_availability[st.get("availability", "unknown")] = by_availability.get(st.get("availability", "unknown"), 0) + 1
    open_inc = [hub.incident_view(sid, i) for sid, i in hub.incidents.values() if i["end"] is None]
    by_type = {t: sum(1 for i in open_inc if i["type"] == t) for t in INCIDENT_TYPES}
    return {"sensors": len(sensors), "live": sum(1 for s in sensors if s["kind"] == "live"),
            "simulations": sum(1 for s in sensors if s["kind"] == "simulation"),
            "quality": by_quality, "availability": by_availability,
            "open_incidents": len(open_inc), "unacknowledged": sum(1 for i in open_inc if not i["acknowledged"]),
            "open_by_type": by_type}
