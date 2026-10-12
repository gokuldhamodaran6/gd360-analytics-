"""
ML engine v2 - the run queue (2026-10-12, round 39).

Every ML Studio training run and every "score every row" run is a row in
ml_jobs. Workers - a thread inside the web app (ML_WORKER_MODE=inline) or a
separate worker service (`python -m app.ml_worker`, ML_WORKER_MODE=external)
- claim the oldest queued job, report a heartbeat while they work, and mark
it done or failed. Nothing is lost on a restart or an out-of-memory kill: a
job whose heartbeat goes quiet is queued again, the second time with half
the row budget, and only then failed with a plain reason.
"""
from __future__ import annotations

import logging
import os
import socket
from datetime import datetime, timedelta

from sqlalchemy import text
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from .. import models
from ..config import get_settings

logger = logging.getLogger(__name__)

MAX_ATTEMPTS = 2


def worker_name(n: int = 0) -> str:
    return f"{socket.gethostname()}:{os.getpid()}:{n}"


def enqueue(db: Session, *, kind: str, model: models.MLModel, owner_id: str, payload: dict | None = None) -> models.MLJob:
    """Queues a job and tells the model page where it stands."""
    for old in db.query(models.MLJob).filter(models.MLJob.model_id == model.id, models.MLJob.kind == kind,
                                             models.MLJob.state.in_(("queued",))).all():
        old.state = "cancelled"
        old.finished_at = datetime.utcnow()
    job = models.MLJob(kind=kind, model_id=model.id, owner_id=owner_id, state="queued", payload=dict(payload or {}))
    db.add(job)
    db.commit()
    db.refresh(job)
    return job


def position(db: Session, job: models.MLJob) -> int:
    """How many jobs will start before this one (0 = it is next)."""
    if job.state != "queued":
        return 0
    return int(db.query(models.MLJob).filter(models.MLJob.state == "queued", models.MLJob.created_at < job.created_at).count())


def latest(db: Session, model_id: str, kind: str | None = None) -> models.MLJob | None:
    q = db.query(models.MLJob).filter(models.MLJob.model_id == model_id)
    if kind:
        q = q.filter(models.MLJob.kind == kind)
    return q.order_by(models.MLJob.created_at.desc()).first()


def status(db: Session, model_id: str, kind: str = "train") -> dict | None:
    """{state, position, running, mode, attempts, note} for the model page."""
    job = latest(db, model_id, kind)
    if not job:
        return None
    running = int(db.query(models.MLJob).filter(models.MLJob.state == "running").count())
    out = {"id": job.id, "state": job.state, "position": position(db, job), "running": running,
           "mode": get_settings().ML_WORKER_MODE, "attempts": int(job.attempts or 0),
           "note": (job.payload or {}).get("note"), "started_at": _iso(job.started_at), "finished_at": _iso(job.finished_at),
           "created_at": _iso(job.created_at), "error": job.error, "result": job.result}
    return out


def _iso(dt):
    return dt.isoformat() + "Z" if dt else None


def claim(db: Session, worker_id: str) -> models.MLJob | None:
    """Takes the oldest queued job for this worker (one worker per job, even
    with several workers or services polling the same database)."""
    now = datetime.utcnow()
    if db.bind.dialect.name == "postgresql":
        row = db.execute(text(
            "UPDATE ml_jobs SET state = 'running', worker_id = :w, started_at = :now, heartbeat_at = :now, "
            "attempts = COALESCE(attempts, 0) + 1 "
            "WHERE id = (SELECT id FROM ml_jobs WHERE state = 'queued' ORDER BY created_at "
            "FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id"), {"w": worker_id, "now": now}).first()
        db.commit()
        return db.get(models.MLJob, row[0]) if row else None
    job = (db.query(models.MLJob).filter(models.MLJob.state == "queued").order_by(models.MLJob.created_at).first())
    if not job:
        return None
    n = db.execute(text("UPDATE ml_jobs SET state = 'running', worker_id = :w, started_at = :now, heartbeat_at = :now, "
                        "attempts = COALESCE(attempts, 0) + 1 WHERE id = :id AND state = 'queued'"),
                   {"w": worker_id, "now": now, "id": job.id}).rowcount
    db.commit()
    if not n:
        return None
    db.refresh(job)
    return job


def beat(db: Session, job_id: str) -> None:
    db.execute(text("UPDATE ml_jobs SET heartbeat_at = :now WHERE id = :id AND state = 'running'"),
               {"now": datetime.utcnow(), "id": job_id})
    db.commit()


def finish(db: Session, job_id: str, *, ok: bool, error: str | None = None, result: dict | None = None,
           cancelled: bool = False) -> None:
    job = db.get(models.MLJob, job_id)
    if not job:
        return
    job.state = "cancelled" if cancelled else "done" if ok else "failed"
    job.error = (error or None) and str(error)[:2000]
    if result is not None:
        job.result = result
        flag_modified(job, "result")
    job.finished_at = datetime.utcnow()
    db.commit()


def cancel_queued(db: Session, model_id: str) -> bool:
    """Stops a run that hasn't started yet. True when there was one."""
    jobs = db.query(models.MLJob).filter(models.MLJob.model_id == model_id, models.MLJob.state == "queued").all()
    for j in jobs:
        j.state = "cancelled"
        j.finished_at = datetime.utcnow()
    if jobs:
        db.commit()
    return bool(jobs)


def reap(db: Session) -> int:
    """Jobs whose worker went quiet (restart, deploy, out of memory): queued
    again with half the row budget, or failed with a plain reason after the
    second try. Returns how many it touched."""
    stale = datetime.utcnow() - timedelta(seconds=get_settings().ML_HEARTBEAT_STALE_SECONDS)
    jobs = (db.query(models.MLJob).filter(models.MLJob.state == "running", models.MLJob.heartbeat_at < stale).all())
    for job in jobs:
        _retry_or_fail(db, job, "The worker running this stopped responding (a restart, or it ran out of memory).")
    if jobs:
        db.commit()
    return len(jobs)


def recover_own(db: Session) -> int:
    """At start-up of an inline worker: jobs this host left running when the
    process stopped are picked up again at once (no need to wait for the
    heartbeat to go stale)."""
    host = socket.gethostname() + ":"
    mine = os.getpid()
    jobs = db.query(models.MLJob).filter(models.MLJob.state == "running").all()
    n = 0
    for job in jobs:
        w = job.worker_id or ""
        if w.startswith(host) and not w.startswith(f"{host}{mine}:"):
            _retry_or_fail(db, job, "The server restarted while this was running.")
            n += 1
    if n:
        db.commit()
    return n


def _retry_or_fail(db: Session, job: models.MLJob, why: str) -> None:
    payload = dict(job.payload or {})
    if (job.attempts or 0) < MAX_ATTEMPTS:
        factor = float(payload.get("budget_factor") or 1.0) * 0.5
        payload.update(budget_factor=factor, note=f"{why} Started again with half the rows to stay inside memory.")
        job.payload = payload
        flag_modified(job, "payload")
        job.state = "queued"
        job.worker_id = None
        job.heartbeat_at = None
        m = db.get(models.MLModel, job.model_id)
        if m is not None and job.kind == "train":
            p = dict(m.progress or {})
            p["message"] = payload["note"]
            m.progress = p
            flag_modified(m, "progress")
            m.stop_requested = False
        logger.warning("[ml_queue] job %s re-queued: %s", job.id, why)
        return
    job.state = "failed"
    job.error = f"{why} It stopped twice, so it was not started again."
    job.finished_at = datetime.utcnow()
    m = db.get(models.MLModel, job.model_id)
    if m is not None and job.kind == "train" and m.status == "training":
        m.status = "failed"
        m.error_message = (f"{why} It stopped twice. Try fewer columns, a narrower table, or give ML its own worker "
                           "with more memory (Settings › ML worker).")
        p = dict(m.progress or {})
        p["message"] = m.error_message
        m.progress = p
        flag_modified(m, "progress")
    elif m is not None and job.kind == "score":
        p = dict(m.progress or {})
        p["scoring"] = {**(p.get("scoring") or {}), "state": "failed", "error": job.error}
        m.progress = p
        flag_modified(m, "progress")
