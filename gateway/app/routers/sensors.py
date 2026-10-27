"""Датчики: регистрация, состояние, ряды для графиков, эталоны, разметка и оценка."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query

from sensorwatch import Profile, robust_profile

from ..deps import get_sensor, make_config
from ..hub import SensorRuntime, hub
from ..schemas import (CalibrateRequest, Label, ProfileIn, ProfileOut, SensorCreate, SensorDetail, SensorPatch,
                       SensorSummary)

router = APIRouter(prefix="/sensors", tags=["Датчики"])

FRAME_KEYS = ("now", "s", "s_up", "s_down", "z", "quality", "availability", "flags", "aggregate", "aggregate_time",
              "norm", "sigma", "mode", "age", "noise_ratio", "rate_ratio", "since_receipt", "accepted", "late_count")


@router.get("", response_model=list[SensorSummary], summary="Список датчиков со статусом")
def list_sensors(kind: str | None = Query(default=None, pattern="^(live|simulation)$"),
                 tag: str | None = None) -> list[dict]:
    out = [hub.summary(rt) for rt in hub.sensors.values()]
    if kind:
        out = [s for s in out if s["kind"] == kind]
    if tag:
        out = [s for s in out if tag in s["tags"]]
    return out


@router.post("", response_model=SensorDetail, status_code=201, summary="Зарегистрировать датчик")
def create_sensor(req: SensorCreate) -> dict:
    """Явная регистрация: паспортные эталоны режимов и параметры монитора.
    Без `profiles` монитор сам откалибрует норму каждого режима по первым отсчётам."""
    profiles = {k: Profile(mean=p.mean, sigma=p.sigma, assess=p.assess, source="passport")
                for k, p in (req.profiles or {}).items()}
    base = make_config({"calib_samples": 0} if profiles else {})
    cfg = make_config(req.config, base) if req.config else base
    if not profiles and cfg.calib_samples == 0 and not (req.config or {}).get("calib_samples"):
        from ..settings import settings
        cfg = make_config({"calib_samples": settings.auto_calib_samples}, cfg)
    try:
        rt = hub.create_sensor(req.id, config=cfg, profiles=profiles, name=req.name, unit=req.unit,
                               description=req.description, tags=req.tags)
    except KeyError as e:
        raise HTTPException(409, str(e)) from e
    return hub.detail(rt)


@router.get("/{sensor_id}", response_model=SensorDetail, summary="Карточка датчика")
def sensor_detail(rt: SensorRuntime = Depends(get_sensor)) -> dict:
    return hub.detail(rt)


@router.patch("/{sensor_id}", response_model=SensorDetail, summary="Изменить описание или параметры монитора")
def patch_sensor(req: SensorPatch, rt: SensorRuntime = Depends(get_sensor)) -> dict:
    """Параметры применяются со следующего тика; накопленное состояние монитора сохраняется."""
    for attr in ("name", "unit", "description", "tags"):
        val = getattr(req, attr)
        if val is not None:
            setattr(rt, attr, val)
    if req.config:
        cfg = make_config(req.config, rt.monitor.cfg)
        rt.monitor.cfg = cfg
        rt.baseline.cfg = cfg
    hub.broadcast({"type": "sensor", "sensor": hub.summary(rt)})
    return hub.detail(rt)


@router.delete("/{sensor_id}", status_code=204, summary="Удалить датчик")
def delete_sensor(rt: SensorRuntime = Depends(get_sensor)) -> None:
    hub.remove_sensor(rt.id)


@router.post("/{sensor_id}/reset", response_model=SensorDetail, summary="Сбросить состояние монитора")
def reset_sensor(rt: SensorRuntime = Depends(get_sensor)) -> dict:
    hub.reset_sensor(rt)
    return hub.detail(rt)


@router.get("/{sensor_id}/status", summary="Последний кадр монитора")
def sensor_status(rt: SensorRuntime = Depends(get_sensor)) -> dict:
    if rt.last_frame is None:
        raise HTTPException(404, "Монитор ещё не сделал ни одного шага")
    return rt.last_frame


@router.get("/{sensor_id}/series", summary="Ряды для графиков: измерения и кадры монитора")
def sensor_series(rt: SensorRuntime = Depends(get_sensor), since: float | None = None, until: float | None = None,
                  max_points: int = Query(default=3000, ge=10, le=50000)) -> dict:
    """`messages` - по времени события (как измерено), `frames` - по времени обработки (когда решил монитор)."""
    msgs = [m for m in rt.messages if (since is None or m["event_time"] >= since)
            and (until is None or m["event_time"] <= until)]
    frames = [{k: f.get(k) for k in FRAME_KEYS} for f in rt.frames
              if (since is None or f["now"] >= since) and (until is None or f["now"] <= until)]
    return {"sensor_id": rt.id, "clock": rt.clock.kind, "messages": _thin(msgs, max_points),
            "frames": _thin(frames, max_points), "annotations": rt.annotations,
            "incidents": [hub.incident_view(rt.id, i) for i in rt.monitor.incidents],
            "baseline": rt.baseline.incidents, "events": rt.monitor.events[-200:]}


def _thin(rows: list, limit: int) -> list:
    """Равномерное прореживание для графика (первый и последний элемент сохраняются)."""
    if len(rows) <= limit:
        return rows
    step = len(rows) / limit
    out = [rows[int(i * step)] for i in range(limit)]
    out[-1] = rows[-1]
    return out


@router.get("/{sensor_id}/profiles", response_model=dict[str, ProfileOut], summary="Эталоны режимов")
def get_profiles(rt: SensorRuntime = Depends(get_sensor)) -> dict:
    return {k: v.as_dict() for k, v in rt.monitor.profiles.items()}


@router.put("/{sensor_id}/profiles/{mode}", response_model=ProfileOut, summary="Задать эталон режима вручную")
def put_profile(mode: str, req: ProfileIn, rt: SensorRuntime = Depends(get_sensor)) -> dict:
    prof = Profile(mean=req.mean, sigma=req.sigma, assess=req.assess, source="manual")
    rt.monitor.set_profile(mode, prof, rt.last_frame["now"] if rt.last_frame else None)
    return prof.as_dict()


@router.post("/{sensor_id}/calibrate", response_model=ProfileOut, summary="Откалибровать эталон по здоровому интервалу")
def calibrate(req: CalibrateRequest, rt: SensorRuntime = Depends(get_sensor)) -> dict:
    """Медиана и 1.4826·MAD пригодных измерений режима на интервале [since, until] времени события."""
    vals = [m["value"] for m in rt.messages
            if m.get("mode") == req.mode and m.get("value") is not None and (m.get("quality_flags") in (None, "valid"))
            and (req.since is None or m["event_time"] >= req.since) and (req.until is None or m["event_time"] <= req.until)]
    if len(vals) < 5:
        raise HTTPException(422, f"Мало пригодных измерений режима {req.mode} на интервале: {len(vals)} (нужно ≥ 5)")
    prof = robust_profile(vals, req.min_sigma, source=f"calibrated:{len(vals)}")
    prof = Profile(mean=prof.mean, sigma=prof.sigma, assess=req.assess, source=prof.source)
    rt.monitor.set_profile(req.mode, prof, rt.last_frame["now"] if rt.last_frame else None)
    return prof.as_dict()


@router.get("/{sensor_id}/labels", response_model=list[Label], summary="Разметка (только для оценки)")
def get_labels(rt: SensorRuntime = Depends(get_sensor)) -> list[dict]:
    return rt.labels


@router.put("/{sensor_id}/labels", response_model=list[Label], summary="Загрузить разметку")
def put_labels(labels: list[Label], rt: SensorRuntime = Depends(get_sensor)) -> list[dict]:
    """Разметка хранится отдельно от потока и монитору не передаётся."""
    rt.labels = [lb.model_dump() for lb in labels]
    return rt.labels


@router.get("/{sensor_id}/evaluation", summary="Сравнить инциденты с разметкой")
def evaluation(rt: SensorRuntime = Depends(get_sensor)) -> dict:
    return hub.evaluation(rt)


@router.get("/{sensor_id}/export", summary="Полная выгрузка датчика в JSON")
def export(rt: SensorRuntime = Depends(get_sensor)) -> dict:
    return {**hub.detail(rt), "messages": list(rt.messages), "frames": list(rt.frames),
            "incidents": [hub.incident_view(rt.id, i) for i in rt.monitor.incidents],
            "events": rt.monitor.events, "baseline": rt.baseline.incidents, "evaluation": hub.evaluation(rt)}
