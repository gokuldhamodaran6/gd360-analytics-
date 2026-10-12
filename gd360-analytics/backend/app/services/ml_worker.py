"""
ML engine v2 - the worker (2026-10-12, round 39).

Claims jobs from the queue (services/ml_queue.py) and runs them, one at a
time, with a heartbeat thread beside each run. Runs inside the web app as a
background thread (ML_WORKER_MODE=inline, the default) or as its own
service with its own memory and CPU (`python -m app.ml_worker`,
ML_WORKER_MODE=external on the web app) - the same code either way.
"""
from __future__ import annotations

import gc
import logging
import threading
import time
import traceback

from ..config import get_settings
from ..database import SessionLocal
from . import ml_queue

logger = logging.getLogger(__name__)

_started = threading.Event()
_stop = threading.Event()
IDLE_SECONDS = 1.5
REAP_EVERY = 30.0


def _heartbeat(job_id: str, done: threading.Event) -> None:
    while not done.wait(15.0):
        db = SessionLocal()
        try:
            ml_queue.beat(db, job_id)
        except Exception:  # noqa: BLE001
            db.rollback()
        finally:
            db.close()


def run_job(job_id: str) -> None:
    """Runs one claimed job to the end, whatever happens inside it."""
    from . import ml_studio
    db = SessionLocal()
    done = threading.Event()
    beat = threading.Thread(target=_heartbeat, args=(job_id, done), daemon=True, name=f"ml-beat-{job_id[:6]}")
    beat.start()
    try:
        from .. import models
        job = db.get(models.MLJob, job_id)
        if job is None:
            return
        kind, model_id, payload = job.kind, job.model_id, dict(job.payload or {})
        db.close()
        db = SessionLocal()
        if kind == "train":
            ok, err = ml_studio.run_training(model_id, payload)
        elif kind == "score":
            ok, err, result = ml_studio.run_scoring(model_id, payload)
            ml_queue.finish(db, job_id, ok=ok, error=err, result=result)
            return
        else:
            ok, err = False, f"Unknown job kind {kind}"
        ml_queue.finish(db, job_id, ok=ok, error=err, cancelled=(err == "stopped"))
    except Exception as e:  # noqa: BLE001
        logger.warning("[ml_worker] job %s crashed: %s\n%s", job_id, e, traceback.format_exc())
        try:
            db.rollback()
            ml_queue.finish(db, job_id, ok=False, error=f"{type(e).__name__}: {str(e)[:300]}")
        except Exception:  # noqa: BLE001
            pass
    finally:
        done.set()
        db.close()
        gc.collect()


def work_once(worker_id: str) -> bool:
    """Claims and runs one job. False when the queue was empty."""
    db = SessionLocal()
    try:
        job = ml_queue.claim(db, worker_id)
        job_id = job.id if job else None
    except Exception as e:  # noqa: BLE001
        logger.warning("[ml_worker] claim failed: %s", e)
        db.rollback()
        job_id = None
    finally:
        db.close()
    if not job_id:
        return False
    run_job(job_id)
    return True


def reap_now() -> None:
    db = SessionLocal()
    try:
        ml_queue.reap(db)
    except Exception as e:  # noqa: BLE001
        logger.warning("[ml_worker] reap failed: %s", e)
        db.rollback()
    finally:
        db.close()


def run_forever(worker_id: str, stop: threading.Event | None = None) -> None:
    stop = stop or _stop
    last_reap = 0.0
    logger.info("[ml_worker] %s started (mode %s)", worker_id, get_settings().ML_WORKER_MODE)
    while not stop.is_set():
        try:
            if time.time() - last_reap > REAP_EVERY:
                reap_now()
                last_reap = time.time()
            if not work_once(worker_id):
                stop.wait(IDLE_SECONDS)
        except Exception as e:  # noqa: BLE001 - the loop itself never dies
            logger.warning("[ml_worker] loop error: %s", e)
            stop.wait(5.0)


def start_inline() -> None:
    """Started once by the web app when ML_WORKER_MODE is inline: picks up
    what this host left running, then works the queue in a daemon thread.
    External mode only reaps (the worker service trains)."""
    if _started.is_set():
        return
    _started.set()
    mode = get_settings().ML_WORKER_MODE
    db = SessionLocal()
    try:
        if mode == "inline":
            ml_queue.recover_own(db)
    except Exception as e:  # noqa: BLE001
        logger.warning("[ml_worker] recover failed: %s", e)
        db.rollback()
    finally:
        db.close()
    if mode == "inline":
        threading.Thread(target=run_forever, args=(ml_queue.worker_name(0),), daemon=True, name="ml-worker").start()
    elif mode == "external":
        def reaper():
            while not _stop.wait(REAP_EVERY):
                reap_now()
        threading.Thread(target=reaper, daemon=True, name="ml-reaper").start()


def stop_all() -> None:
    _stop.set()
