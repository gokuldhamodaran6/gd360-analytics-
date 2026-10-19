"""Background runs, saving the output table, alerts, the schedule and the
'run when a source changes' trigger.

Runs happen on a daemon thread in this web process (the same model the
rest of GD360's automations use); the run row is written first, so a
crash still leaves an honest record and recover_interrupted() closes it."""
from __future__ import annotations

import hashlib
import logging
import threading
import time
import uuid
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pandas as pd
from sqlalchemy import func
from sqlalchemy.orm import Session

from ... import models
from ...database import SessionLocal
from . import engine, fix as fixer
from .profile import FlowError, load_source
from .spec import hm, validate

logger = logging.getLogger(__name__)
CHANGE_CHECK_EVERY = timedelta(minutes=10)
STALE_RUN = timedelta(minutes=45)
MAX_THREAD = 200

_claims: set[str] = set()
_lock = threading.Lock()


class FlowBusy(FlowError):
    pass


def _iso(d: datetime | None) -> str | None:
    return d.replace(microsecond=0).isoformat() + "Z" if d else None


def add_message(flow: models.DataFlow, role: str, kind: str, text: str, data: dict | None = None) -> dict:
    msg = {"id": uuid.uuid4().hex[:12], "role": role, "kind": kind, "text": text, "data": data or {},
           "at": _iso(datetime.utcnow())}
    thread = list(flow.thread or []) + [msg]
    flow.thread = thread[-MAX_THREAD:]
    return msg


# ------------------------------------------------------------ schedule ----

def next_run(spec: dict, after_utc: datetime) -> datetime | None:
    from ..automations import next_fire
    sch = spec.get("schedule") or {}
    return next_fire({"every": "day", "time": sch.get("time") or "06:00", "days": sch.get("days") or list(range(7))},
                     sch.get("timezone") or "UTC", after_utc)


def local_now(spec: dict) -> datetime:
    tz = (spec.get("schedule") or {}).get("timezone") or "UTC"
    return datetime.now(ZoneInfo(tz))


# ------------------------------------------------------------- output ----

def publish(db: Session, flow: models.DataFlow, df: pd.DataFrame) -> models.DataSource:
    from .. import blob_io
    from ..data_loader import drop_cached_original
    name = (flow.spec.get("output") or {}).get("name") or "flow_output"
    ds = db.get(models.DataSource, flow.output_datasource_id) if flow.output_datasource_id else None
    schema = {"columns": [{"name": str(c), "type": str(df[c].dtype)} for c in df.columns]}
    if ds is None:
        ds = models.DataSource(
            owner_id=flow.owner_id, workspace_id=flow.workspace_id, name=name, kind="csv",
            connection_info={"original_filename": f"{name}.csv", "tidy_v": 1, "managed_by_flow": flow.id},
            file_data=None, read_only=True, schema_cache=schema,
            description=f"Made and refreshed by the flow “{flow.name}”. Edit the flow, not this table.",
        )
        db.add(ds)
        db.flush()
        flow.output_datasource_id = ds.id
    else:
        info = dict(ds.connection_info or {})
        info.update({"original_filename": f"{name}.csv", "managed_by_flow": flow.id})
        info.pop("import_by_sheet", None)
        info.pop("import_settings", None)
        info.pop("import_summary", None)
        ds.connection_info = info
        ds.schema_cache = schema
        ds.cleaned_data = None
    ds.api_last_refreshed_at = datetime.utcnow()
    blob_io.put_bytes(db, models.DataSource, "file_data", ds.id, df.to_csv(index=False).encode("utf-8"))
    db.flush()
    drop_cached_original(ds.id)
    return ds


def fingerprint(db: Session, ds: models.DataSource) -> str | None:
    from ..automations import data_version
    from ..synced_sources import SYNCED_KINDS
    try:
        if ds.kind in SYNCED_KINDS or ds.kind in ("api", "streaming"):
            v = data_version(ds)
            return _iso(v) if v else None
        if ds.kind in ("csv", "excel"):
            try:
                h = db.query(func.md5(models.DataSource.file_data)).filter(models.DataSource.id == ds.id).scalar()
                if h:
                    return str(h)
            except Exception:  # noqa: BLE001 - not Postgres
                db.rollback()
            raw = db.query(models.DataSource.file_data).filter(models.DataSource.id == ds.id).scalar() or b""
            return hashlib.md5(bytes(raw)).hexdigest()
        if ds.kind in ("google_sheets", "microsoft_excel"):
            from ..data_loader import load_dataframe
            df = load_dataframe(ds, db=db, row_limit=50_000)
            return hashlib.md5(pd.util.hash_pandas_object(df.astype(str), index=False).values.tobytes()).hexdigest()
    except Exception as e:  # noqa: BLE001
        logger.info("[flows] fingerprint skipped for %s: %s", ds.id, e)
    return None


def fingerprints(db: Session, spec: dict) -> dict:
    out = {}
    for s in spec.get("sources") or []:
        ds = db.get(models.DataSource, s["datasource_id"])
        if ds is not None:
            fp = fingerprint(db, ds)
            if fp:
                out[ds.id] = fp
    return out


# ------------------------------------------------------------- alerts ----

def _emails(db: Session, ids: list[str]) -> list[str]:
    if not ids:
        return []
    rows = db.query(models.User.email).filter(models.User.id.in_(ids)).all()
    return [r[0] for r in rows if r[0]]


def _names(db: Session, ids: list[str]) -> str:
    if not ids:
        return "nobody"
    rows = db.query(models.User).filter(models.User.id.in_(ids)).all()
    names = [(getattr(u, "full_name", None) or getattr(u, "name", None) or (u.email or "").split("@")[0]) for u in rows]
    return ", ".join(n for n in names if n) or "the owner"


def _deliver(db: Session, flow: models.DataFlow, people: list[str], message: dict, email: bool) -> list[dict]:
    from ..automations import app_url, deliver
    if not people:
        return []
    tell = {"in_app": people, "email": _emails(db, people) if email else []}
    msg = {"link": app_url() + f"/automate/{flow.id}", "link_label": "Open the flow", "app_link": f"/automate/{flow.id}",
           **message}
    try:
        return deliver(db, flow.owner_id, tell, msg)
    except Exception as e:  # noqa: BLE001 - recorded, never raised
        db.rollback()
        return [{"channel": "in_app", "status": "failed", "detail": str(e)[:300]}]


# ---------------------------------------------------------------- run ----

def _claim(flow_id: str) -> bool:
    with _lock:
        if flow_id in _claims:
            return False
        _claims.add(flow_id)
        return True


def _release(flow_id: str) -> None:
    with _lock:
        _claims.discard(flow_id)


def start_run(db: Session, flow: models.DataFlow, reason: str, *, background: bool = True) -> models.DataFlowRun:
    running = (db.query(models.DataFlowRun)
               .filter(models.DataFlowRun.flow_id == flow.id, models.DataFlowRun.status == "running",
                       models.DataFlowRun.started_at >= datetime.utcnow() - STALE_RUN).first())
    if running is not None or not _claim(flow.id):
        raise FlowBusy("This flow is already running. It usually takes a few seconds.")
    try:
        validate(flow.spec)
        run = models.DataFlowRun(flow_id=flow.id, owner_id=flow.owner_id, version=flow.version, reason=reason,
                                 status="running", events=[], stats={}, checks=[])
        db.add(run)
        db.commit()
        db.refresh(run)
    except Exception:
        _release(flow.id)
        raise
    if background:
        threading.Thread(target=_execute, args=(run.id,), daemon=True, name=f"flow-{flow.id[:8]}").start()
    else:
        _execute(run.id)
    return run


def _ready_check(spec: dict, res_checks: list[dict], reason: str) -> None:
    for c in res_checks:
        if c["kind"] != "ready_by":
            continue
        if reason not in ("schedule", "change"):
            c["status"], c["note"] = "later", "Checked on scheduled runs"
            continue
        h, m = hm(next((x["time"] for x in spec.get("checks") or [] if x["id"] == c["id"]), "23:59"))
        now = local_now(spec)
        late = (now.hour, now.minute) > (h, m) and reason == "schedule"
        c["status"] = "late" if late else "passed"
        c["note"] = f"Finished at {now:%H:%M}" + (" (ran because a source changed)" if reason == "change" else "")


def _fmt_secs(s: float) -> str:
    if s < 1:
        return "under a second"
    return f"{s:.0f} s" if s < 90 else f"{s / 60:.0f} min"


def _execute(run_id: str) -> None:
    db = SessionLocal()
    flow_id = None
    try:
        run = db.get(models.DataFlowRun, run_id)
        flow = db.get(models.DataFlow, run.flow_id) if run else None
        if run is None or flow is None:
            return
        flow_id = flow.id
        t0 = time.time()
        spec = validate(flow.spec)
        test = run.reason == "test"
        pending = None
        out_ds = None
        try:
            res = engine.run_spec(db, spec, last_good_columns=flow.last_good_columns)
            status = res["status"]
            _ready_check(spec, res["checks"], run.reason)
            events = res["events"]
            if not test and status == "success":
                out_ds = publish(db, flow, res["frame"])
                res["ev"](f"Saved {spec['output']['name']} · {res['stats']['rows_out']:,} rows")
                flow.last_good_columns = res["fills"]
                flow.fingerprints = fingerprints(db, spec)
                run.published = True
            elif not test:
                flow.fingerprints = fingerprints(db, spec)
            if status == "held" and res.get("health"):
                h = res["health"][0]
                pending = fixer.propose(spec, run_id=run.id, alias=h["alias"], column=h["column"], cause=res["hold_reason"],
                                        now_fills=res["fills"], last_good=flow.last_good_columns)
            run.stats, run.checks = res["stats"], res["checks"]
            run.flagged, run.set_aside, run.examples, run.preview = res["flagged"], res["set_aside"], res["examples"], res["preview"]
            run.events = events
            hold_reason = res["hold_reason"]
            err = None
        except engine.StepError as e:
            status, hold_reason, err = "failed", None, str(e)
            run.events = list(getattr(e, "events", []) or []) or [{"at": _iso(datetime.utcnow()), "text": f"Stopped: {e}", "status": "bad"}]
            run.error_message = err
            pending = fixer.propose(spec, run_id=run.id, alias=e.alias, column=e.column, cause=err,
                                    now_fills=getattr(e, "fills", None), last_good=flow.last_good_columns)
            if not test:
                flow.fingerprints = fingerprints(db, spec)
        except FlowError as e:
            status, hold_reason, err = "failed", None, str(e)
            run.error_message = err
            run.events = [{"at": _iso(datetime.utcnow()), "text": f"Stopped: {e}", "status": "bad"}]
        secs = time.time() - t0
        run.status = status
        run.finished_at = datetime.utcnow()
        st = run.stats or {}
        if pending:
            flow.pending_fix = pending
        elif status == "success" and not test:
            flow.pending_fix = None
        if test:
            if status == "success" and flow.status == "draft":
                flow.status = "tested"
        else:
            flow.last_run_at = run.finished_at
            flow.last_status = status
            flow.last_run_id = run.id
        # the thread
        data = {"run_id": run.id, "reason": run.reason, "status": status, "secs": round(secs, 1),
                "stats": {k: st.get(k) for k in ("rows_out", "matched_right", "right_rows", "flagged", "set_aside", "fixed")},
                "hold_reason": hold_reason, "error": err, "fix_id": pending["id"] if pending else None}
        out_name = spec["output"]["name"]
        flag_to = spec["policy"]["flag_to"]
        alert_to = spec["policy"]["alert_to"] or [flow.owner_id]
        if test:
            if status == "success":
                bits = [f"{st.get('matched_right', 0):,} of {st.get('right_rows', 0):,} rows matched" if st.get("right_rows") else f"{st.get('rows_out', 0):,} rows came out"]
                if st.get("fixed"):
                    bits.append(f"{st['fixed']} typing mistakes fixed")
                if st.get("flagged"):
                    bits.append(f"{st['flagged']} look odd")
                if st.get("set_aside"):
                    bits.append(f"{st['set_aside']} set aside")
                text = f"Test run done in {_fmt_secs(secs)}: " + ", ".join(bits) + ". Nothing was saved. If it looks right, turn it on."
            elif status == "held":
                text = f"The test finished, but a real run would be held: {hold_reason}"
            else:
                text = f"The test stopped: {err}"
        elif status == "success":
            text = f"Done at {local_now(spec):%H:%M}. {st.get('rows_out', 0):,} rows saved to {out_name}."
            if st.get("flagged"):
                text += f" {st['flagged']} look odd; I sent them to {_names(db, flag_to)}."
        elif status == "held":
            text = f"I held today’s data. {hold_reason} The last good table is still in place, so nobody sees wrong numbers."
        else:
            text = f"This run stopped: {err} Nothing was saved; the last good table is still in place."
        if pending:
            text += " I found a likely fix - review it below."
        add_message(flow, "gd360", "run", text, data)
        # alerts (real runs only)
        deliveries: list[dict] = []
        if not test:
            link_note = f"Flow: {flow.name}"
            if status == "success":
                if spec["policy"].get("daily_summary") or st.get("flagged"):
                    lines = [f"{st.get('rows_out', 0):,} rows saved to {out_name}."]
                    if st.get("flagged"):
                        lines.append(f"{st['flagged']} rows look odd and need a look.")
                    deliveries += _deliver(db, flow, alert_to, {
                        "subject": f"{flow.name}: today’s table is ready", "headline": f"{flow.name}: ready",
                        "lines": lines + [link_note]}, email=False)
                extra = [u for u in flag_to if u not in alert_to]
                if st.get("flagged") and extra:
                    deliveries += _deliver(db, flow, extra, {
                        "subject": f"{st['flagged']} rows need a look - {flow.name}",
                        "headline": f"{st['flagged']} rows need a look",
                        "lines": [f"{flow.name} flagged {st['flagged']} rows today.", link_note]}, email=True)
            else:
                lines = [hold_reason or err or "The run stopped.",
                         "The last good table is still in place."]
                if pending:
                    lines.append("GD360 proposed a fix: " + pending["summary"])
                deliveries += _deliver(db, flow, alert_to, {
                    "subject": f"{'Held' if status == 'held' else 'Stopped'}: {flow.name}",
                    "headline": f"{flow.name} {'held its data' if status == 'held' else 'stopped'}",
                    "lines": lines + [link_note], "failed": True}, email=True)
        run.deliveries = deliveries
        db.commit()
    except Exception as e:  # noqa: BLE001 - the run must never stay "running"
        logger.exception("[flows] run %s crashed", run_id)
        db.rollback()
        try:
            run = db.get(models.DataFlowRun, run_id)
            if run is not None:
                run.status = "failed"
                run.error_message = f"Something went wrong inside GD360: {str(e)[:300]}"
                run.finished_at = datetime.utcnow()
                db.commit()
        except Exception:  # noqa: BLE001
            db.rollback()
    finally:
        if flow_id:
            _release(flow_id)
        db.close()


def recover_interrupted() -> None:
    db = SessionLocal()
    try:
        rows = db.query(models.DataFlowRun).filter(models.DataFlowRun.status == "running").all()
        for r in rows:
            r.status = "failed"
            r.error_message = "Interrupted by a server restart. Run it again."
            r.finished_at = datetime.utcnow()
        if rows:
            db.commit()
    except Exception as e:  # noqa: BLE001
        logger.warning("[flows] recover skipped: %s", e)
        db.rollback()
    finally:
        db.close()


def tick(db: Session, now: datetime) -> None:
    """Called every minute by services/scheduler.py."""
    due = (db.query(models.DataFlow)
           .filter(models.DataFlow.enabled.is_(True), models.DataFlow.next_run_at.isnot(None),
                   models.DataFlow.next_run_at <= now).limit(10).all())
    for f in due:
        try:
            f.next_run_at = next_run(f.spec, now)
            db.commit()
            start_run(db, f, "schedule")
        except FlowBusy:
            continue
        except Exception as e:  # noqa: BLE001
            db.rollback()
            logger.warning("[flows] scheduled run failed to start for %s: %s", f.id, e)
    watch = (db.query(models.DataFlow)
             .filter(models.DataFlow.enabled.is_(True))
             .filter((models.DataFlow.last_change_check_at.is_(None)) | (models.DataFlow.last_change_check_at <= now - CHANGE_CHECK_EVERY))
             .limit(20).all())
    for f in watch:
        try:
            f.last_change_check_at = now
            spec = f.spec or {}
            if not (spec.get("schedule") or {}).get("on_change", True):
                db.commit()
                continue
            fps = fingerprints(db, spec)
            if f.fingerprints is None:
                f.fingerprints = fps
                db.commit()
                continue
            changed = any(fps.get(k) and fps.get(k) != f.fingerprints.get(k) for k in fps)
            db.commit()
            if changed:
                start_run(db, f, "change")
        except FlowBusy:
            continue
        except Exception as e:  # noqa: BLE001
            db.rollback()
            logger.warning("[flows] change check failed for %s: %s", f.id, e)
