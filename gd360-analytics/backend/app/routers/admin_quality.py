"""2026-10-17 (R52): Mission Control > Quality - the nightly check on the live model and how fast real answers are.

GET  /admin/v2/quality                the schedule, the last 30 runs, the latest run in full, answer speed (7 days)
GET  /admin/v2/quality/runs/{id}      one run in full
POST /admin/v2/quality/run            start a run now
PUT  /admin/v2/quality/nightly        switch the nightly run on or off
"""
from __future__ import annotations

from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import models
from ..database import get_db
from ..services import quality
from ..services.admin_access import Staff, log_admin, require
from ..services.agent import budgets

router = APIRouter(prefix="/admin/v2/quality", tags=["mission-control"])


def _iso(dt):
    return dt.isoformat() + "Z" if dt else None


def _run_out(r: models.QualityRun, full: bool) -> dict:
    out = {"id": r.id, "trigger": r.trigger, "status": r.status, "provider": r.provider, "model": r.model, "summary": r.summary or {},
           "started_at": _iso(r.started_at), "finished_at": _iso(r.finished_at), "error": r.error, "started_by": r.started_by}
    if full:
        out["results"] = r.results or []
    return out


def _pct(vals: list[float], q: float) -> float | None:
    if not vals:
        return None
    v = sorted(vals)
    i = min(len(v) - 1, max(0, int(round(q * (len(v) - 1)))))
    return round(v[i], 1)


def _speed(db: Session, days: int = 7) -> list[dict]:
    """p50 / p95 per kind of answer over real people's turns (the nightly account is left out)."""
    since = datetime.utcnow() - timedelta(days=days)
    ev = db.query(models.User.id).filter(models.User.email == quality.EVAL_EMAIL).scalar()
    secs: dict[str, list[float]] = {}
    msgs = (db.query(models.Message.chart_spec, models.Conversation.owner_id)
            .join(models.Conversation, models.Conversation.id == models.Message.conversation_id)
            .filter(models.Message.created_at >= since, models.Message.action.like("v2:%")).limit(8000).all())
    for spec, owner in msgs:
        if ev and owner == ev:
            continue
        st = (spec or {}).get("v2") if isinstance(spec, dict) else None
        if not isinstance(st, dict) or st.get("status") not in ("done", "confirm", "failed", "needs_input"):
            continue
        e = st.get("elapsed_s")
        if e is None and st.get("started_at") and st.get("finished_at"):
            try:
                e = (datetime.fromisoformat(st["finished_at"].rstrip("Z")) - datetime.fromisoformat(st["started_at"].rstrip("Z"))).total_seconds()
            except ValueError:
                e = None
        if isinstance(e, (int, float)) and e >= 0:
            secs.setdefault(st.get("kind") or "other", []).append(float(e))
    runs = (db.query(models.ProjectRun.started_at, models.ProjectRun.created_at, models.ProjectRun.finished_at, models.ProjectRun.owner_id)
            .filter(models.ProjectRun.created_at >= since, models.ProjectRun.finished_at.isnot(None), models.ProjectRun.auto_run.is_(True)).limit(8000).all())
    for started, created, finished, owner in runs:
        if ev and owner == ev:
            continue
        e = (finished - (created or started)).total_seconds()
        if e >= 0:
            secs.setdefault("data", []).append(e)
    out = []
    for kind, v in sorted(secs.items(), key=lambda kv: -len(kv[1])):
        target = budgets.budget(kind)
        out.append({"kind": kind, "target": target, "n": len(v), "p50": _pct(v, 0.5), "p95": _pct(v, 0.95),
                    "over_pct": round(100 * sum(1 for x in v if target and x > target) / len(v), 1) if target else None})
    return out


@router.get("")
def overview(db: Session = Depends(get_db), staff: Staff = Depends(require("metrics.read"))):
    runs = db.query(models.QualityRun).order_by(models.QualityRun.started_at.desc()).limit(30).all()
    now = datetime.utcnow()
    nxt = now.replace(hour=2, minute=10, second=0, microsecond=0)
    if nxt <= now:
        nxt += timedelta(days=1)
    return {"nightly_on": quality.nightly_enabled(db), "next_run_at": _iso(nxt) if quality.nightly_enabled(db) else None,
            "questions": [{"n": n, "dataset": d, "question": q, "expected": k, "budget": budgets.budget(k)} for n, d, q, k, _c in quality.QUESTIONS],
            "budgets": budgets.TARGETS, "runs": [_run_out(r, False) for r in runs], "latest": _run_out(runs[0], True) if runs else None,
            "speed": _speed(db), "generated_at": _iso(now)}


@router.get("/runs/{run_id}")
def one(run_id: str, db: Session = Depends(get_db), staff: Staff = Depends(require("metrics.read"))):
    r = db.get(models.QualityRun, run_id)
    if r is None:
        raise HTTPException(404, "Run not found.")
    return _run_out(r, True)


@router.post("/run")
def run_now(request: Request, db: Session = Depends(get_db), staff: Staff = Depends(require("health.write"))):
    r = quality.start("manual", staff.email)
    if r is None:
        raise HTTPException(409, "A check is already running. It takes about ten minutes.")
    log_admin(db, staff, "quality.run", target_type="quality_run", target_id=r.id, summary="Started the quality check by hand", request=request)
    db.commit()
    return {"id": r.id, "status": "running"}


class NightlyIn(BaseModel):
    on: bool


@router.put("/nightly")
def set_nightly(body: NightlyIn, request: Request, db: Session = Depends(get_db), staff: Staff = Depends(require("health.write"))):
    row = db.get(models.AdminSetting, quality.SETTING)
    if row is None:
        row = models.AdminSetting(key=quality.SETTING)
        db.add(row)
    before = row.value
    row.value, row.updated_by, row.updated_at = {"on": body.on}, staff.email, datetime.utcnow()
    log_admin(db, staff, "quality.nightly", target_type="setting", target_id=quality.SETTING,
              summary=f"Nightly quality check switched {'on' if body.on else 'off'}", before=before, after=row.value, request=request)
    db.commit()
    return {"nightly_on": body.on}
