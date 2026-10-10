"""
Automations (2026-10-08, round 12): work that runs by itself.

Every automation reads as one sentence - WHEN -> DO -> TELL:

  WHEN  a schedule (read in the owner's time zone), new data landing in a
        synced app / API / streaming source, or a number crossing a line
        (checked on its own schedule; fires when the condition BECOMES true).
  DO    an ordered chain of steps - refresh a project dashboard, re-run a
        project question, rebuild a classic dashboard, sync a source, check
        quality rules, re-score with an ML model, summarise what changed.
  TELL  email (Resend or any SMTP server), Slack and Microsoft Teams
        (incoming webhooks) - every time, only when something changed, or
        only when it fails.

Runs happen in the scheduler's 60-second tick (services/scheduler.py) and,
for "Run now" / "Test it now", on a background thread. Every run is
recorded as an AutomationRun before any work starts.

The steps reuse the engines the rest of the app already uses (project
dashboards' rerun_snapshot, scheduler.refresh_dashboard, synced_sources.
sync_datasource, quality checks, ML scoring) - an automation never has a
second, different way of computing the same number.
"""
from __future__ import annotations

import hashlib
import html
import json
import logging
import re
import smtplib
import ssl
import threading
import time
from datetime import date, datetime, timedelta
from email.message import EmailMessage
from urllib.parse import urlparse
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import requests
from sqlalchemy import update
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from .. import models
from ..config import get_settings
from ..database import SessionLocal
from .synced_sources import SYNCED_KINDS

logger = logging.getLogger("gd360.automations")

TRIGGER_TYPES = ("schedule", "new_data", "threshold")
EVERY = ("hour", "day", "week", "month")
STEP_TYPES = (
    "refresh_project_dashboard", "rerun_question", "refresh_dashboard",
    "sync_source", "quality_check", "rescore_model", "summarise",
)
MODES = ("always", "on_change", "on_failure")
OPS = ("below", "above", "drops_by", "rises_by")
MAX_STEPS = 8
MAX_RECIPIENTS = 10
MAX_PER_OWNER = 50
# 2026-10-09 (round 15): every synced app (synced_sources.SYNCED_KINDS, which
# now includes the round-15 connectors) plus REST APIs and event streams.
NEW_DATA_KINDS = SYNCED_KINDS + ("api", "streaming")
DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$")

_RUNNING: set[str] = set()
_RUNNING_LOCK = threading.Lock()


class AutomationError(ValueError):
    """A problem with what was asked (shown to the person as it is)."""


class StepFailed(RuntimeError):
    pass


# ---------------------------------------------------------------- time ----

def zone(tz: str | None) -> ZoneInfo:
    try:
        return ZoneInfo(tz or "UTC")
    except (ZoneInfoNotFoundError, ValueError):
        raise AutomationError(f'"{tz}" is not a time zone GD360 knows - pick one from the list.')


def _hm(text: str | None) -> tuple[int, int]:
    m = re.match(r"^(\d{1,2}):(\d{2})$", str(text or "").strip())
    if not m or int(m.group(1)) > 23 or int(m.group(2)) > 59:
        raise AutomationError("Times are written like 06:00 or 18:30.")
    return int(m.group(1)), int(m.group(2))


def _to_utc(local: datetime) -> datetime:
    return local.astimezone(ZoneInfo("UTC")).replace(tzinfo=None)


def next_fire(sched: dict, tz: str, after_utc: datetime) -> datetime | None:
    """The first time strictly after `after_utc` (naive UTC) that `sched`
    fires, read in time zone `tz`. Returns naive UTC."""
    z = zone(tz)
    after_local = after_utc.replace(tzinfo=ZoneInfo("UTC")).astimezone(z)
    every = sched.get("every")
    if every == "hour":
        minute = int(sched.get("minute") or 0) % 60
        cand = after_local.replace(minute=minute, second=0, microsecond=0)
        if cand <= after_local:
            cand += timedelta(hours=1)
        return _to_utc(cand)
    h, m = _hm(sched.get("time") or "06:00")
    if every in ("day", "week"):
        days = sorted({int(d) % 7 for d in (sched.get("days") or ([0] if every == "week" else range(7)))})
        for i in range(0, 9):
            d = after_local.date() + timedelta(days=i)
            if d.weekday() not in days:
                continue
            cand = datetime(d.year, d.month, d.day, h, m, tzinfo=z)
            if cand > after_local:
                return _to_utc(cand)
        return None
    if every == "month":
        dom = min(max(int(sched.get("day_of_month") or 1), 1), 28)
        y, mo = after_local.year, after_local.month
        for _ in range(3):
            cand = datetime(y, mo, dom, h, m, tzinfo=z)
            if cand > after_local:
                return _to_utc(cand)
            mo += 1
            if mo > 12:
                y, mo = y + 1, 1
        return None
    return None


def schedule_of(trigger: dict) -> dict | None:
    t = trigger.get("type")
    if t == "schedule":
        return trigger
    if t == "threshold":
        return trigger.get("check") or {"every": "hour", "minute": 0}
    return None


def next_runs(trigger: dict, tz: str, n: int = 5, start: datetime | None = None) -> list[datetime]:
    sched = schedule_of(trigger)
    if not sched:
        return []
    out, t = [], start or datetime.utcnow()
    for _ in range(n):
        nxt = next_fire(sched, tz, t)
        if not nxt:
            break
        out.append(nxt)
        t = nxt
    return out


def runs_per_month(trigger: dict) -> float | None:
    sched = schedule_of(trigger)
    if not sched:
        return None
    every = sched.get("every")
    if every == "hour":
        return 730.0
    if every == "day":
        return round(len(set(sched.get("days") or range(7))) * 4.35, 1)
    if every == "week":
        return round(len(set(sched.get("days") or [0])) * 4.35, 1)
    if every == "month":
        return 1.0
    return None


def _fmt_time(h: int, m: int) -> str:
    suffix = "AM" if h < 12 else "PM"
    hh = h % 12 or 12
    return f"{hh}:{m:02d} {suffix}"


def schedule_text(sched: dict) -> str:
    every = sched.get("every")
    if every == "hour":
        minute = int(sched.get("minute") or 0)
        return "Every hour" if minute == 0 else f"Every hour at :{minute:02d}"
    h, m = _hm(sched.get("time") or "06:00")
    at = _fmt_time(h, m)
    if every == "day":
        days = sorted({int(d) % 7 for d in (sched.get("days") or range(7))})
        if len(days) == 7:
            return f"Every day at {at}"
        if days == [0, 1, 2, 3, 4]:
            return f"Every weekday at {at}"
        if days == [5, 6]:
            return f"Weekends at {at}"
        return f"{', '.join(DAY_NAMES[d] for d in days)} at {at}"
    if every == "week":
        days = sorted({int(d) % 7 for d in (sched.get("days") or [0])})
        names = ["Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays", "Sundays"]
        return f"{' and '.join(names[d] for d in days)} at {at}"
    if every == "month":
        dom = int(sched.get("day_of_month") or 1)
        suffix = "th" if 10 <= dom % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(dom % 10, "th")
        return f"On the {dom}{suffix} of every month at {at}"
    return "On a schedule"


# ------------------------------------------------------------ targets ----

def _dash_visible(db: Session, d: models.Dashboard | None, user: models.User) -> bool:
    if not d:
        return False
    from ..routers.dashboards import _can_view
    return _can_view(db, d, user)


def _ds_visible(db: Session, ds: models.DataSource | None, user: models.User) -> bool:
    if not ds:
        return False
    from . import workspace_access
    return workspace_access.can_access_datasource(db, ds, user)


def _run_visible(db: Session, run: models.ProjectRun | None, user: models.User) -> bool:
    if not run:
        return False
    conv = db.get(models.Conversation, run.conversation_id)
    if not conv:
        return False
    from . import workspace_access
    return workspace_access.can_access_conversation(db, conv, user)


def _model_visible(db: Session, mid: str, user: models.User) -> models.MLModel | None:
    from fastapi import HTTPException
    from ..routers.ml_models import _get_accessible_ml_model
    try:
        return _get_accessible_ml_model(db, user, mid)
    except HTTPException:
        return None


def target_name(db: Session, step: dict) -> str:
    t = step.get("type")
    if t in ("refresh_project_dashboard", "refresh_dashboard"):
        d = db.get(models.Dashboard, step.get("dashboard_id") or "")
        return d.name if d else "a deleted dashboard"
    if t == "rerun_question":
        r = db.get(models.ProjectRun, step.get("run_id") or "")
        return f"“{r.question}”" if r else "a deleted question"
    if t in ("sync_source", "quality_check"):
        ds = db.get(models.DataSource, step.get("datasource_id") or "")
        return ds.name if ds else "a deleted source"
    if t == "rescore_model":
        m = db.get(models.MLModel, step.get("model_id") or "")
        return m.name if m else "a deleted model"
    return ""


def step_text(db: Session, step: dict) -> str:
    t = step.get("type")
    name = target_name(db, step)
    return {
        "refresh_project_dashboard": f"Refresh {name}",
        "rerun_question": f"Re-run {name}",
        "refresh_dashboard": f"Rebuild {name}",
        "sync_source": f"Sync {name}",
        "quality_check": f"Check quality rules on {name}",
        "rescore_model": f"Re-score with {name}",
        "summarise": "Summarise what changed",
    }.get(t, t or "")


def _kpi_text(kpi: dict | None) -> str:
    return (kpi or {}).get("label") or "the number"


def threshold_text(db: Session, trigger: dict) -> str:
    op, value = trigger.get("op"), trigger.get("value")
    kpi = trigger.get("kpi_label") or "the number"
    unit = trigger.get("unit") or ""
    v = f"{_num_text(value)}{unit}"
    if op == "below":
        cond = f"{kpi} drops below {v}"
    elif op == "above":
        cond = f"{kpi} goes above {v}"
    elif op == "drops_by":
        cond = f"{kpi} falls by more than {_num_text(value)}%"
    else:
        cond = f"{kpi} rises by more than {_num_text(value)}%"
    return cond


def _num_text(v) -> str:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return str(v)
    return f"{f:g}"


def when_text(db: Session, a_trigger: dict) -> str:
    t = a_trigger.get("type")
    if t == "schedule":
        return schedule_text(a_trigger)
    if t == "new_data":
        ds = db.get(models.DataSource, a_trigger.get("datasource_id") or "")
        return f"When new {ds.name} data lands" if ds else "When new data lands"
    if t == "threshold":
        return schedule_text(schedule_of(a_trigger) or {"every": "hour"})
    return "—"


def do_text(db: Session, steps: list[dict], trigger: dict | None = None) -> str:
    parts = [step_text(db, s) for s in steps or []]
    if trigger and trigger.get("type") == "threshold":
        parts.insert(0, "Check if " + threshold_text(db, trigger))
    if not parts:
        return "Add a step below"
    out = parts[0]
    for p in parts[1:]:
        low = p[0].lower() + p[1:]
        out += (" and " if low.startswith("summarise") else ", then ") + low
    return out


def tell_text(tell: dict) -> str:
    bits = []
    emails = tell.get("email") or []
    if emails:
        bits.append(f"email {emails[0]}" if len(emails) == 1 else f"email {len(emails)} people")
    if tell.get("slack"):
        bits.append("Slack " + (tell["slack"].get("label") or "channel"))
    if tell.get("teams"):
        bits.append("Teams " + (tell["teams"].get("label") or "channel"))
    if not bits:
        return "No one"
    text = " · ".join(bits)
    mode = tell.get("mode") or "always"
    if mode == "on_change":
        text += ", only when something changes"
    elif mode == "on_failure":
        text += ", only if it fails"
    return text


def tell_sentence(tell: dict, threshold: bool = False) -> str:
    """The TELL part as it reads inside the full sentence."""
    bits = []
    emails = tell.get("email") or []
    if emails:
        bits.append(f"email {emails[0]}" if len(emails) == 1 else f"email {len(emails)} people")
    if tell.get("slack"):
        bits.append("post in Slack " + (tell["slack"].get("label") or "channel"))
    if tell.get("teams"):
        bits.append("post in Teams " + (tell["teams"].get("label") or "channel"))
    if not bits:
        return ""
    text = bits[0] if len(bits) == 1 else ", ".join(bits[:-1]) + " and " + bits[-1]
    mode = tell.get("mode") or "always"
    if threshold and mode == "always":
        text += " only if it happens"
    elif mode == "on_change":
        text += ", only when something changes"
    elif mode == "on_failure":
        text += " only if it fails"
    return text


def sentence(db: Session, a: dict) -> dict:
    trig = a.get("trigger") or {}
    thr = trig.get("type") == "threshold"
    tell = a.get("tell") or {}
    chip = tell_text(tell)
    if thr and (tell.get("mode") or "always") == "always" and chip != "No one":
        chip += ", only if it happens"
    return {
        "when": when_text(db, trig),
        "do": do_text(db, a.get("steps") or [], trig),
        "tell": chip[:1].upper() + chip[1:],
        "tell_sentence": tell_sentence(tell, thr),
    }


# ---------------------------------------------------------- validation ----

def mask_url(url: str) -> str:
    p = urlparse(url)
    tail = (p.path or "").rstrip("/").split("/")[-1]
    return f"{p.netloc}/…/{tail[-4:]}" if tail else p.netloc


def check_webhook(kind: str, url: str) -> str:
    url = (url or "").strip()
    p = urlparse(url)
    host = (p.hostname or "").lower()
    if p.scheme != "https" or not host:
        raise AutomationError(f"The {kind.title()} webhook must be an https:// link.")
    if kind == "slack":
        if host != "hooks.slack.com":
            raise AutomationError("A Slack webhook starts with https://hooks.slack.com/ - create one in Slack (Apps › Incoming Webhooks).")
    else:
        ok = host.endswith(".webhook.office.com") or host.endswith(".logic.azure.com") or host.endswith(".powerplatform.com") \
            or host.endswith(".powerautomate.com")
        if not ok:
            raise AutomationError("A Teams webhook is a link from Teams (Workflows › “Post to a channel when a webhook request is received”).")
    return url


def validate(db: Session, user: models.User, body: dict, existing: models.Automation | None = None) -> dict:
    """Checks a create/update body and returns the clean fields to store."""
    from ..security import encrypt_secret
    out: dict = {}
    name = str(body.get("name") or "").strip()
    if not name:
        raise AutomationError("Give the automation a name.")
    out["name"] = name[:80]
    tz = str(body.get("timezone") or "UTC")
    zone(tz)
    out["timezone"] = tz

    trig = dict(body.get("trigger") or {})
    ttype = trig.get("type")
    if ttype not in TRIGGER_TYPES:
        raise AutomationError("Choose when it should run.")
    if ttype == "schedule":
        if trig.get("every") not in EVERY:
            raise AutomationError("Choose how often it should run.")
        if trig.get("every") != "hour":
            _hm(trig.get("time") or "06:00")
            trig.setdefault("time", "06:00")
        if trig.get("every") in ("day", "week"):
            days = sorted({int(d) % 7 for d in (trig.get("days") or ([0] if trig["every"] == "week" else range(7)))})
            if not days:
                raise AutomationError("Pick at least one day.")
            trig["days"] = days
        clean = {k: trig.get(k) for k in ("type", "every", "time", "minute", "days", "day_of_month") if trig.get(k) is not None}
    elif ttype == "new_data":
        ds = db.get(models.DataSource, trig.get("datasource_id") or "")
        if not _ds_visible(db, ds, user):
            raise AutomationError("Pick a data source you can see.")
        if ds.kind not in NEW_DATA_KINDS:
            raise AutomationError(f"{ds.name} is read live every time, so it never has “new data” to wait for - use a schedule instead.")
        clean = {"type": "new_data", "datasource_id": ds.id}
    else:
        target = trig.get("target") or {}
        if trig.get("op") not in OPS:
            raise AutomationError("Choose how the number should cross the line.")
        try:
            value = float(trig.get("value"))
        except (TypeError, ValueError):
            raise AutomationError("Enter the line the number should cross.")
        kpis = target_kpis(db, user, target)
        key = trig.get("kpi")
        kpi = next((k for k in kpis if k.get("key") == key), None)
        if not kpi:
            raise AutomationError("Pick one of the numbers this answer or dashboard shows.")
        check = dict(trig.get("check") or {"every": "hour", "minute": 0})
        if check.get("every") not in EVERY:
            check = {"every": "hour", "minute": 0}
        if check["every"] != "hour":
            _hm(check.get("time") or "06:00")
        clean = {
            "type": "threshold", "target": {k: target.get(k) for k in ("kind", "run_id", "dashboard_id") if target.get(k)},
            "kpi": key, "kpi_label": kpi.get("label"), "op": trig["op"], "value": value,
            "unit": "%" if is_percent(kpi) and trig["op"] in ("below", "above") else "",
            "check": check,
        }
    out["trigger"] = clean

    steps = []
    for i, s in enumerate((body.get("steps") or [])[:MAX_STEPS + 1]):
        if len(steps) >= MAX_STEPS:
            raise AutomationError(f"An automation can have at most {MAX_STEPS} steps.")
        t = s.get("type")
        if t not in STEP_TYPES:
            raise AutomationError(f"Step {i + 1}: unknown step.")
        if t in ("refresh_project_dashboard", "refresh_dashboard"):
            d = db.get(models.Dashboard, s.get("dashboard_id") or "")
            if not _dash_visible(db, d, user):
                raise AutomationError(f"Step {i + 1}: pick a dashboard you can see.")
            if t == "refresh_project_dashboard" and d.layout_version != 3:
                t = "refresh_dashboard"
            if t == "refresh_dashboard" and d.layout_version == 3:
                t = "refresh_project_dashboard"
            steps.append({"type": t, "dashboard_id": d.id})
        elif t == "rerun_question":
            r = db.get(models.ProjectRun, s.get("run_id") or "")
            if not _run_visible(db, r, user) or r.status != "done":
                raise AutomationError(f"Step {i + 1}: pick a question that has an answer.")
            steps.append({"type": t, "run_id": r.id})
        elif t in ("sync_source", "quality_check"):
            ds = db.get(models.DataSource, s.get("datasource_id") or "")
            if not _ds_visible(db, ds, user):
                raise AutomationError(f"Step {i + 1}: pick a data source you can see.")
            if t == "sync_source" and ds.kind not in SYNCED_KINDS + ("api",):
                raise AutomationError(f"Step {i + 1}: {ds.name} is read live, so it has nothing to sync.")
            steps.append({"type": t, "datasource_id": ds.id})
        elif t == "rescore_model":
            m = _model_visible(db, s.get("model_id") or "", user)
            if not m:
                raise AutomationError(f"Step {i + 1}: pick a model you can use.")
            steps.append({"type": t, "model_id": m.id})
        else:
            steps.append({"type": "summarise"})
    if not steps and ttype != "threshold":
        raise AutomationError("Add at least one step - what should it do?")
    out["steps"] = steps
    out["stop_on_quality_fail"] = bool(body.get("stop_on_quality_fail", True))

    tell_in = body.get("tell") or {}
    old_tell = (existing.tell if existing else None) or {}
    emails = []
    for e in tell_in.get("email") or []:
        e = str(e).strip()
        if not e:
            continue
        if not EMAIL_RE.match(e):
            raise AutomationError(f"“{e}” doesn't look like an email address.")
        if e.lower() not in [x.lower() for x in emails]:
            emails.append(e)
    if len(emails) > MAX_RECIPIENTS:
        raise AutomationError(f"Up to {MAX_RECIPIENTS} email recipients per automation.")
    tell = {"email": emails, "mode": tell_in.get("mode") if tell_in.get("mode") in MODES else "always"}
    for kind in ("slack", "teams"):
        url = tell_in.get(f"{kind}_url")
        label = str(tell_in.get(f"{kind}_label") or "").strip()[:60]
        if url:  # a new link
            url = check_webhook(kind, url)
            tell[kind] = {"url_enc": encrypt_secret(url), "masked": mask_url(url), "label": label or ("#channel" if kind == "slack" else "channel")}
        elif url == "" or tell_in.get(f"{kind}_remove"):
            tell[kind] = None
        elif old_tell.get(kind):  # keep the saved link; the label can change
            tell[kind] = {**old_tell[kind], "label": label or old_tell[kind].get("label")}
        else:
            tell[kind] = None
    out["tell"] = tell
    out["enabled"] = bool(body.get("enabled", True))
    return out


# ------------------------------------------------------------ KPIs ----

def _snapshot_for_target(db: Session, user: models.User, target: dict) -> tuple[dict | None, dict]:
    """(stored snapshot, info) for a threshold target, without running anything."""
    kind = target.get("kind")
    if kind == "dashboard":
        d = db.get(models.Dashboard, target.get("dashboard_id") or "")
        if not _dash_visible(db, d, user) or d.layout_version != 3:
            raise AutomationError("Pick a project dashboard you can see.")
        return d.project_snapshot or {}, {"name": d.name, "link": f"/project-dashboards/{d.id}"}
    if kind == "project_run":
        r = db.get(models.ProjectRun, target.get("run_id") or "")
        if not _run_visible(db, r, user) or r.status != "done":
            raise AutomationError("Pick a question that has an answer.")
        res = r.result or {}
        return {"kpis": res.get("kpis") or []}, {"name": r.question, "link": f"/p/{r.conversation_id}?run={r.id}"}
    raise AutomationError("Pick what the number comes from.")


def target_kpis(db: Session, user: models.User, target: dict) -> list[dict]:
    snap, _ = _snapshot_for_target(db, user, target)
    return [k for k in (snap or {}).get("kpis") or [] if k.get("value") is not None or k.get("display")]


def _fresh_snapshot(db: Session, user: models.User, target: dict) -> tuple[dict, dict]:
    """Re-runs the target's plan now (no language model) for a threshold check."""
    from .project_engine.dashboards import refresh as refresh_dashboard3, rerun_snapshot
    kind = target.get("kind")
    if kind == "dashboard":
        d = db.get(models.Dashboard, target.get("dashboard_id") or "")
        if not _dash_visible(db, d, user):
            raise StepFailed("The dashboard this alert watches no longer exists or isn't shared with you.")
        d = refresh_dashboard3(db, d, user)
        return d.project_snapshot or {}, {"name": d.name, "link": f"/project-dashboards/{d.id}"}
    r = db.get(models.ProjectRun, target.get("run_id") or "")
    if not _run_visible(db, r, user):
        raise StepFailed("The question this alert watches no longer exists or isn't shared with you.")
    conv = db.get(models.Conversation, r.conversation_id)
    snap = rerun_snapshot(db, r.plan or {}, user, list(conv.source_ids or []))
    return snap, {"name": r.question, "link": f"/p/{r.conversation_id}?run={r.id}"}


_NUM = re.compile(r"[-−+]?\d[\d,]*\.?\d*")


def _parse_display(text: str | None) -> float | None:
    """'$364.0k' -> 364000, '1.79%' -> 1.79, '−12.2%' -> -12.2."""
    if not text:
        return None
    m = _NUM.search(str(text))
    if not m:
        return None
    v = float(m.group(0).replace(",", "").replace("−", "-"))
    tail = str(text)[m.end():m.end() + 1].lower()
    return v * {"k": 1e3, "m": 1e6, "b": 1e9}.get(tail, 1)


def is_percent(kpi: dict) -> bool:
    return kpi.get("kind") in ("percent", "ratio") or str(kpi.get("display") or "").strip().endswith("%")


def kpi_number(kpi: dict) -> float | None:
    """The KPI as the number people read on screen (a ratio shown as 1.79%
    compares as 1.79)."""
    v, kind = kpi.get("value"), kpi.get("kind")
    if kind == "ratio" and v is not None:
        return float(v) * 100
    if kind and v is not None:
        return float(v)
    shown = _parse_display(kpi.get("display"))
    if v is None:
        return shown
    if shown is not None and is_percent(kpi) and abs(float(v)) <= 1.5 and abs(float(v) * 100 - shown) < 0.6:
        return float(v) * 100
    return float(v)


def condition_met(trigger: dict, kpi: dict) -> tuple[bool | None, str]:
    """(met?, the value as text). None when the number isn't available."""
    op, line = trigger.get("op"), float(trigger.get("value") or 0)
    if op in ("below", "above"):
        v = kpi_number(kpi)
        if v is None:
            return None, kpi.get("display") or "—"
        return (v < line if op == "below" else v > line), kpi.get("display") or _num_text(v)
    d = kpi.get("delta_pct")
    if d is None:
        d = _parse_display(kpi.get("delta"))
        if d is not None and kpi.get("delta_dir") == "down" and d > 0:
            d = -d
    if d is None:
        return None, kpi.get("delta") or "—"
    d = float(d)
    return (d <= -line if op == "drops_by" else d >= line), kpi.get("delta") or f"{d:+.1f}%"


# ------------------------------------------------------------- steps ----

def _kpi_lines(kpis: list[dict]) -> list[dict]:
    return [
        {"label": k.get("label"), "display": k.get("display"), "delta": k.get("delta"), "delta_dir": k.get("delta_dir"),
         "note": k.get("note")}
        for k in (kpis or [])[:6]
    ]


def _step_refresh_project_dashboard(db, step, user, ctx):
    from .project_engine.dashboards import headline_for, refresh
    d = db.get(models.Dashboard, step.get("dashboard_id") or "")
    if not _dash_visible(db, d, user):
        raise StepFailed("That dashboard no longer exists or isn't shared with you.")
    d = refresh(db, d, user)
    snap = d.project_snapshot or {}
    ok = [s for s in snap.get("steps") or [] if s.get("status") == "done"]
    ctx["kpis"] = snap.get("kpis") or []
    ctx.setdefault("headline", headline_for(snap) or (d.project_spec or {}).get("headline"))
    ctx.setdefault("link", f"/project-dashboards/{d.id}")
    ctx.setdefault("link_label", "Open dashboard")
    ctx.setdefault("subject_name", d.name)
    return {"queries": len(snap.get("steps") or []), "ok": len(ok)}


def _step_rerun_question(db, step, user, ctx):
    from .project_engine.dashboards import headline_for, rerun_snapshot
    r = db.get(models.ProjectRun, step.get("run_id") or "")
    if not _run_visible(db, r, user):
        raise StepFailed("That question no longer exists or isn't shared with you.")
    conv = db.get(models.Conversation, r.conversation_id)
    snap = rerun_snapshot(db, r.plan or {}, user, list(conv.source_ids or []))
    ctx["kpis"] = snap.get("kpis") or []
    ctx.setdefault("headline", headline_for(snap))
    ctx.setdefault("link", f"/p/{r.conversation_id}?run={r.id}")
    ctx.setdefault("link_label", "Open project")
    ctx.setdefault("subject_name", r.question)
    return {"queries": len(snap.get("steps") or [])}


def _step_refresh_dashboard(db, step, user, ctx):
    from .scheduler import refresh_dashboard
    d = db.get(models.Dashboard, step.get("dashboard_id") or "")
    if not _dash_visible(db, d, user):
        raise StepFailed("That dashboard no longer exists or isn't shared with you.")
    job = refresh_dashboard(db, d, job_type="automation")
    if job.status == "failed":
        raise StepFailed(job.error_message or "The dashboard's refresh failed.")
    ctx.setdefault("link", f"/dashboards/{d.id}")
    ctx.setdefault("link_label", "Open dashboard")
    ctx.setdefault("subject_name", d.name)
    return {"job_run_id": job.id}


def _step_sync_source(db, step, user, ctx):
    ds = db.get(models.DataSource, step.get("datasource_id") or "")
    if not _ds_visible(db, ds, user):
        raise StepFailed("That data source no longer exists or isn't shared with you.")
    if ds.kind == "api":
        from .datasource_refresh import refresh_api_datasource
        df = refresh_api_datasource(db, ds)
        return {"rows": int(len(df))}
    from .synced_sources import sync_datasource
    out = sync_datasource(db, ds, reason="automation")
    if not out.get("ok"):
        raise StepFailed(out.get("error") or "The sync failed.")
    return {"tables": out.get("tables"), "rows": sum((out.get("tables") or {}).values())}


def _step_quality_check(db, step, user, ctx):
    from .quality_checks import run_quality_rule
    ds = db.get(models.DataSource, step.get("datasource_id") or "")
    if not _ds_visible(db, ds, user):
        raise StepFailed("That data source no longer exists or isn't shared with you.")
    rules = db.query(models.DataQualityRule).filter(models.DataQualityRule.datasource_id == ds.id).all()
    failing = []
    for rule in rules:
        run_quality_rule(db, rule)
        if rule.last_status in ("fail", "error"):
            failing.append(f"{rule.column_name} {rule.rule_type.replace('_', ' ')}")
    db.commit()
    ctx.setdefault("quality", []).append({"source": ds.name, "checked": len(rules), "failing": len(failing)})
    if failing:
        raise StepFailed(f"{len(failing)} of {len(rules)} quality rules on {ds.name} failed: " + ", ".join(map(str, failing[:4])))
    return {"checked": len(rules), "failing": 0}


def _step_rescore_model(db, step, user, ctx):
    from fastapi import HTTPException
    from .. import schemas
    from ..routers.ml_models import score_table_with_ml_model
    try:
        out = score_table_with_ml_model(step.get("model_id"), schemas.ScoreTableRequest(table=None), db=db, user=user)
    except HTTPException as e:
        raise StepFailed(str(e.detail))
    return {"rows": out.row_count, "saved_as": out.new_version_name}


def _step_summarise(db, step, user, ctx):
    ctx["summarise"] = True
    return {}


HANDLERS = {
    "refresh_project_dashboard": _step_refresh_project_dashboard,
    "rerun_question": _step_rerun_question,
    "refresh_dashboard": _step_refresh_dashboard,
    "sync_source": _step_sync_source,
    "quality_check": _step_quality_check,
    "rescore_model": _step_rescore_model,
    "summarise": _step_summarise,
}


# ------------------------------------------------------------ message ----

def app_url() -> str:
    s = get_settings()
    return (s.APP_PUBLIC_URL or s.FRONTEND_ORIGIN or "").rstrip("/")


def _previous_kpis(db: Session, automation_id: str | None, exclude_run: str) -> dict:
    if not automation_id:
        return {}
    prev = (
        db.query(models.AutomationRun)
        .filter(models.AutomationRun.automation_id == automation_id, models.AutomationRun.status == "success",
                models.AutomationRun.id != exclude_run)
        .order_by(models.AutomationRun.started_at.desc())
        .first()
    )
    if not prev or not prev.message:
        return {}
    return {k.get("label"): k.get("display") for k in prev.message.get("kpis") or []}


def build_message(db: Session, name: str, tz: str, ctx: dict, failed: str | None, run_id: str,
                  automation_id: str | None, alert: dict | None = None) -> dict:
    local = datetime.utcnow().replace(tzinfo=ZoneInfo("UTC")).astimezone(zone(tz))
    when = f"{local.strftime('%a')} {local.day} {local.strftime('%b')}"
    kpis = _kpi_lines(ctx.get("kpis") or [])
    lines: list[str] = []
    if alert:
        headline = f"{alert['kpi']} is {alert['value']} - {alert['condition']}."
    elif failed:
        headline = f"{name} could not finish: {failed}"
    else:
        headline = ctx.get("headline") or f"{name} ran."
    if ctx.get("summarise") and kpis:
        before = _previous_kpis(db, automation_id, run_id)
        for k in kpis:
            line = f"{k['label']}: {k['display']}"
            if k.get("delta"):
                line += " (" + f"{k['delta']} {k.get('note') or ''}".strip() + ")"
            old = before.get(k["label"])
            if old and old != k["display"]:
                line += f" - was {old} at the last run"
            lines.append(line)
    for q in ctx.get("quality") or []:
        lines.append(f"Quality rules on {q['source']}: {q['checked'] - q['failing']} of {q['checked']} passed.")
    link = ctx.get("link")
    return {
        "subject": (f"Alert: {alert['kpi']} - {name}" if alert else f"{'Failed: ' if failed else ''}{name} · {when}"),
        "title": f"{ctx.get('subject_name') or name} · {when}",
        "headline": headline,
        "lines": lines,
        "kpis": kpis,
        "link": (app_url() + link) if link else None,
        "link_label": ctx.get("link_label") or "Open in GD360",
        "failed": bool(failed),
    }


def digest(message: dict) -> str:
    body = json.dumps({"h": message.get("headline"), "k": [(k.get("label"), k.get("display")) for k in message.get("kpis") or []]},
                      sort_keys=True)
    return hashlib.sha256(body.encode()).hexdigest()[:32]


def email_html(m: dict) -> str:
    esc = html.escape
    rows = "".join(
        f'<tr><td style="padding:6px 0;color:#4f5b58;font-size:13px">{esc(str(k["label"]))}</td>'
        f'<td style="padding:6px 0;text-align:right;font:600 14px ui-monospace,Menlo,monospace;color:#0b1210">{esc(str(k["display"]))}'
        + (f'<span style="font-weight:400;color:{"#b42318" if k.get("delta_dir") == "down" else "#0f7a54"}"> {esc(str(k["delta"]))}</span>' if k.get("delta") else "")
        + "</td></tr>"
        for k in m.get("kpis") or []
    )
    lines = "".join(f'<p style="margin:0 0 6px;color:#2b3633;font-size:14px;line-height:1.5">{esc(l)}</p>' for l in m.get("lines") or [])
    link = (f'<p style="margin:18px 0 0"><a href="{esc(m["link"])}" style="color:#0f7a54;font-weight:600;text-decoration:none">'
            f'{esc(m.get("link_label") or "Open")} →</a></p>') if m.get("link") else ""
    return f"""<!doctype html><html><body style="margin:0;background:#f2f4f3;padding:24px 12px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
<table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;width:100%;background:#ffffff;border:1px solid #dde3e1;border-radius:14px">
<tr><td style="padding:22px 24px">
<div style="font:600 11px ui-monospace,Menlo,monospace;letter-spacing:.12em;text-transform:uppercase;color:#6f7c78">GD360</div>
<h1 style="margin:8px 0 10px;font-size:18px;line-height:1.3;color:#0b1210">{esc(m.get("title") or "")}</h1>
<p style="margin:0 0 14px;color:{"#b42318" if m.get("failed") else "#0b1210"};font-size:15px;line-height:1.5">{esc(m.get("headline") or "")}</p>
{lines}
{f'<table role="presentation" width="100%" style="margin-top:10px;border-top:1px solid #e7ecea">{rows}</table>' if rows else ""}
{link}
</td></tr></table>
<p style="color:#8a9894;font-size:11px;margin:14px 0 0">Sent by a GD360 automation. Numbers are computed from your data, never written by AI.</p>
</td></tr></table></body></html>"""


def email_text(m: dict) -> str:
    parts = [m.get("title") or "", "", m.get("headline") or ""]
    parts += m.get("lines") or []
    for k in m.get("kpis") or []:
        parts.append(f"{k['label']}: {k['display']}" + (f" ({k['delta']})" if k.get("delta") else ""))
    if m.get("link"):
        parts += ["", f"{m.get('link_label') or 'Open'}: {m['link']}"]
    return "\n".join(parts)


# ----------------------------------------------------------- delivery ----

class NotConfigured(RuntimeError):
    pass


def email_configured() -> bool:
    s = get_settings()
    return bool(s.EMAIL_FROM and (s.RESEND_API_KEY or s.SMTP_HOST))


def send_email(to: list[str], subject: str, html_body: str, text_body: str) -> str:
    s = get_settings()
    if not email_configured():
        raise NotConfigured("Email isn't set up yet - add RESEND_API_KEY (or SMTP settings) and EMAIL_FROM on the server.")
    if s.RESEND_API_KEY:
        r = requests.post(
            "https://api.resend.com/emails",
            headers={"Authorization": f"Bearer {s.RESEND_API_KEY}", "Content-Type": "application/json"},
            json={"from": s.EMAIL_FROM, "to": to, "subject": subject, "html": html_body, "text": text_body},
            timeout=20,
        )
        if r.status_code >= 300:
            try:
                detail = r.json().get("message") or r.text
            except ValueError:
                detail = r.text
            raise RuntimeError(f"The email service refused it ({r.status_code}): {str(detail)[:200]}")
        return "sent"
    msg = EmailMessage()
    msg["From"] = s.EMAIL_FROM
    msg["To"] = ", ".join(to)
    msg["Subject"] = subject
    msg.set_content(text_body)
    msg.add_alternative(html_body, subtype="html")
    ctx = ssl.create_default_context()
    if s.SMTP_USE_SSL:
        with smtplib.SMTP_SSL(s.SMTP_HOST, s.SMTP_PORT, timeout=20, context=ctx) as smtp:
            if s.SMTP_USERNAME:
                smtp.login(s.SMTP_USERNAME, s.SMTP_PASSWORD)
            smtp.send_message(msg)
    else:
        with smtplib.SMTP(s.SMTP_HOST, s.SMTP_PORT, timeout=20) as smtp:
            smtp.starttls(context=ctx)
            if s.SMTP_USERNAME:
                smtp.login(s.SMTP_USERNAME, s.SMTP_PASSWORD)
            smtp.send_message(msg)
    return "sent"


def slack_payload(m: dict) -> dict:
    text = f"*{m.get('title')}*\n{m.get('headline')}"
    if m.get("lines"):
        text += "\n" + "\n".join(f"• {l}" for l in m["lines"])
    elif m.get("kpis"):
        text += "\n" + "\n".join(f"• {k['label']}: *{k['display']}*" + (f" ({k['delta']})" if k.get("delta") else "") for k in m["kpis"])
    if m.get("link"):
        text += f"\n<{m['link']}|{m.get('link_label') or 'Open in GD360'} →>"
    return {"text": text}


def teams_payload(m: dict) -> dict:
    body = [
        {"type": "TextBlock", "text": m.get("title") or "", "weight": "Bolder", "size": "Medium", "wrap": True},
        {"type": "TextBlock", "text": m.get("headline") or "", "wrap": True, "color": "Attention" if m.get("failed") else "Default"},
    ]
    facts = [{"title": str(k["label"]), "value": f"{k['display']}" + (f" ({k['delta']})" if k.get("delta") else "")} for k in m.get("kpis") or []]
    if facts:
        body.append({"type": "FactSet", "facts": facts})
    for l in m.get("lines") or []:
        body.append({"type": "TextBlock", "text": l, "wrap": True, "spacing": "Small"})
    card = {"type": "AdaptiveCard", "$schema": "http://adaptivecards.io/schemas/adaptive-card.json", "version": "1.4", "body": body}
    if m.get("link"):
        card["actions"] = [{"type": "Action.OpenUrl", "title": m.get("link_label") or "Open in GD360", "url": m["link"]}]
    return {"type": "message", "attachments": [{"contentType": "application/vnd.microsoft.card.adaptive", "content": card}]}


def post_webhook(url: str, payload: dict) -> str:
    for attempt in range(2):
        try:
            r = requests.post(url, json=payload, timeout=15)
        except requests.RequestException as e:
            if attempt:
                raise RuntimeError(f"Couldn't reach the webhook: {type(e).__name__}.")
            time.sleep(1.5)
            continue
        if r.status_code == 429 and not attempt:
            time.sleep(2)
            continue
        if r.status_code >= 300:
            raise RuntimeError(f"The webhook refused it ({r.status_code}): {r.text[:160]}")
        return "sent"
    return "sent"


def _emails_sent_today(db: Session, owner_id: str) -> int:
    since = datetime.utcnow() - timedelta(days=1)
    n = 0
    for (deliveries,) in db.query(models.AutomationRun.deliveries).filter(
        models.AutomationRun.owner_id == owner_id, models.AutomationRun.started_at >= since
    ):
        for d in deliveries or []:
            if d.get("channel") == "email" and d.get("status") == "sent":
                n += int(d.get("count") or 1)
    return n


def deliver(db: Session, owner_id: str, tell: dict, message: dict) -> list[dict]:
    from ..security import decrypt_secret
    out = []
    emails = tell.get("email") or []
    if emails:
        cap = get_settings().AUTOMATION_DAILY_EMAIL_CAP
        if _emails_sent_today(db, owner_id) + len(emails) > cap:
            out.append({"channel": "email", "to": ", ".join(emails), "status": "skipped",
                        "detail": f"Daily email limit reached ({cap} a day)."})
        else:
            try:
                send_email(emails, message["subject"], email_html(message), email_text(message))
                out.append({"channel": "email", "to": ", ".join(emails), "status": "sent", "count": len(emails)})
            except NotConfigured as e:
                out.append({"channel": "email", "to": ", ".join(emails), "status": "not_configured", "detail": str(e)})
            except Exception as e:  # noqa: BLE001 - recorded on the run, never raised
                out.append({"channel": "email", "to": ", ".join(emails), "status": "failed", "detail": str(e)[:300]})
    for kind, build in (("slack", slack_payload), ("teams", teams_payload)):
        hook = tell.get(kind)
        if not hook:
            continue
        try:
            url = decrypt_secret(hook["url_enc"])
            post_webhook(url, build(message))
            out.append({"channel": kind, "to": hook.get("label"), "status": "sent"})
        except Exception as e:  # noqa: BLE001
            out.append({"channel": kind, "to": hook.get("label"), "status": "failed", "detail": str(e)[:300]})
    return out


# ---------------------------------------------------------------- run ----

def execute(db: Session, *, owner: models.User, name: str, tz: str, steps: list[dict], tell: dict,
            stop_on_quality_fail: bool, reason: str, automation: models.Automation | None,
            run: models.AutomationRun | None = None, alert: dict | None = None,
            preset_ctx: dict | None = None) -> models.AutomationRun:
    """Runs the steps in order, builds the message and delivers it."""
    if run is None:
        run = models.AutomationRun(
            automation_id=automation.id if automation else None, owner_id=owner.id, automation_name=name,
            reason=reason, status="running", step_results=[], started_at=datetime.utcnow(),
        )
        db.add(run)
        db.commit()
        db.refresh(run)
    ctx: dict = dict(preset_ctx or {})
    results: list[dict] = []
    failed: str | None = None
    for i, step in enumerate(steps or []):
        label = step_text(db, step)
        t0 = time.perf_counter()
        try:
            detail = HANDLERS[step["type"]](db, step, owner, ctx)
            results.append({"index": i, "type": step["type"], "label": label, "status": "done", "detail": detail,
                            "seconds": round(time.perf_counter() - t0, 1)})
        except Exception as e:  # noqa: BLE001 - one step's failure is recorded, then the chain decides
            db.rollback()
            msg = str(e) if isinstance(e, (StepFailed, AutomationError)) else f"{type(e).__name__}: {str(e)[:300]}"
            if not isinstance(e, (StepFailed, AutomationError)):
                logger.warning("[automations] step %s of %s failed: %s", step.get("type"), name, e)
            results.append({"index": i, "type": step["type"], "label": label, "status": "failed", "error": msg,
                            "seconds": round(time.perf_counter() - t0, 1)})
            if step["type"] != "quality_check" or stop_on_quality_fail:
                failed = msg
                for j, rest in enumerate(steps[i + 1:], start=i + 1):
                    results.append({"index": j, "type": rest["type"], "label": step_text(db, rest), "status": "skipped"})
                break
        run.step_results = list(results)
        flag_modified(run, "step_results")
        db.commit()

    message = build_message(db, name, tz, ctx, failed, run.id, automation.id if automation else None, alert)
    mode = tell.get("mode") or "always"
    d = digest(message)
    should = (
        reason in ("test", "threshold")
        or mode == "always"
        or (mode == "on_failure" and failed)
        or (mode == "on_change" and (failed or not automation or automation.last_digest != d))
    )
    deliveries = deliver(db, owner.id, tell, message) if should else []
    run.step_results = results
    run.message = message
    run.deliveries = deliveries
    run.notified = any(x.get("status") == "sent" for x in deliveries)
    run.status = "failed" if failed else "success"
    run.error_message = failed
    run.finished_at = datetime.utcnow()
    if automation is not None and reason != "test":
        automation.last_run_at = run.finished_at
        automation.last_status = run.status
        if not failed:
            automation.last_digest = d
    for col in ("step_results", "deliveries"):
        flag_modified(run, col)
    db.commit()
    db.refresh(run)
    return run


def _claim(automation_id: str) -> bool:
    with _RUNNING_LOCK:
        if automation_id in _RUNNING:
            return False
        _RUNNING.add(automation_id)
        return True


def _release(automation_id: str) -> None:
    with _RUNNING_LOCK:
        _RUNNING.discard(automation_id)


def is_running(automation_id: str) -> bool:
    with _RUNNING_LOCK:
        return automation_id in _RUNNING


def run_automation(db: Session, a: models.Automation, reason: str, alert: dict | None = None,
                   run: models.AutomationRun | None = None) -> models.AutomationRun | None:
    owner = db.get(models.User, a.owner_id)
    if not owner:
        return None
    return execute(db, owner=owner, name=a.name, tz=a.timezone, steps=a.steps or [], tell=a.tell or {},
                   stop_on_quality_fail=a.stop_on_quality_fail, reason=reason, automation=a, run=run, alert=alert)


def _threshold_now(db: Session, owner: models.User, trig: dict, suffix: str = "") -> tuple[dict, dict]:
    """Checks a threshold's number now: (alert, message context)."""
    snap, info = _fresh_snapshot(db, owner, trig.get("target") or {})
    kpi = next((k for k in snap.get("kpis") or [] if k.get("key") == trig.get("kpi")), None)
    met, val = condition_met(trig, kpi or {})
    cond = threshold_text(db, trig)
    alert = {"kpi": trig.get("kpi_label") or "The number", "value": val,
             "condition": (f"the alert line ({cond}) is crossed" if met else f"not crossed yet - alerts when {cond}") + suffix}
    preset = {"kpis": snap.get("kpis") or [], "link": info["link"], "subject_name": info["name"], "link_label": "Open in GD360"}
    return alert, preset


def start_manual_run(automation_id: str, owner_id: str, reason: str = "manual") -> str:
    """Creates the run row now and does the work on a background thread."""
    db = SessionLocal()
    try:
        a = db.get(models.Automation, automation_id)
        if not _claim(automation_id):
            raise AutomationError("This automation is already running.")
        run = models.AutomationRun(automation_id=a.id, owner_id=owner_id, automation_name=a.name, reason=reason,
                                   status="running", step_results=[], started_at=datetime.utcnow())
        db.add(run)
        db.commit()
        run_id = run.id
    finally:
        db.close()

    def work():
        s = SessionLocal()
        try:
            a2 = s.get(models.Automation, automation_id)
            r2 = s.get(models.AutomationRun, run_id)
            if a2 and r2:
                trig = a2.trigger or {}
                if trig.get("type") == "threshold":
                    owner = s.get(models.User, a2.owner_id)
                    alert, preset = _threshold_now(s, owner, trig)
                    execute(s, owner=owner, name=a2.name, tz=a2.timezone, steps=a2.steps or [], tell=a2.tell or {},
                            stop_on_quality_fail=a2.stop_on_quality_fail, reason="test", automation=a2, run=r2,
                            alert=alert, preset_ctx=preset)
                    r2.reason = reason
                    s.commit()
                else:
                    run_automation(s, a2, reason, run=r2)
        except Exception as e:  # noqa: BLE001
            logger.warning("[automations] manual run %s failed: %s", run_id, e)
            _fail_run(s, run_id, str(e))
        finally:
            _release(automation_id)
            s.close()

    threading.Thread(target=work, daemon=True, name=f"automation-{automation_id[:8]}").start()
    return run_id


def start_test_run(owner_id: str, fields: dict) -> str:
    """'Test it now' on an automation that may not be saved yet."""
    db = SessionLocal()
    try:
        run = models.AutomationRun(automation_id=None, owner_id=owner_id, automation_name=fields["name"], reason="test",
                                   status="running", step_results=[], started_at=datetime.utcnow())
        db.add(run)
        db.commit()
        run_id = run.id
    finally:
        db.close()

    def work():
        s = SessionLocal()
        try:
            owner = s.get(models.User, owner_id)
            r2 = s.get(models.AutomationRun, run_id)
            alert = None
            preset: dict = {}
            trig = fields.get("trigger") or {}
            if trig.get("type") == "threshold":
                alert, preset = _threshold_now(s, owner, trig, " (test)")
            execute(s, owner=owner, name=fields["name"], tz=fields["timezone"], steps=fields.get("steps") or [],
                    tell=fields.get("tell") or {}, stop_on_quality_fail=fields.get("stop_on_quality_fail", True),
                    reason="test", automation=None, run=r2, alert=alert, preset_ctx=preset)
        except Exception as e:  # noqa: BLE001
            logger.warning("[automations] test run %s failed: %s", run_id, e)
            _fail_run(s, run_id, str(e))
        finally:
            s.close()

    threading.Thread(target=work, daemon=True, name="automation-test").start()
    return run_id


def _fail_run(db: Session, run_id: str, msg: str) -> None:
    try:
        db.rollback()
        r = db.get(models.AutomationRun, run_id)
        if r and r.status == "running":
            r.status = "failed"
            r.error_message = msg[:600]
            r.finished_at = datetime.utcnow()
            db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()


# ---------------------------------------------------------- the tick ----

def data_version(ds: models.DataSource | None) -> datetime | None:
    if not ds:
        return None
    if ds.kind in SYNCED_KINDS:
        return ds.last_synced_at
    if ds.kind == "api":
        return ds.api_last_refreshed_at
    if ds.kind == "streaming":
        return ds.last_event_at
    return None


def schedule_initial(a: models.Automation) -> None:
    """Sets the next run (and, for new-data, the data version already seen)."""
    t = a.trigger or {}
    a.next_run_at = None
    if t.get("type") in ("schedule", "threshold") and a.enabled:
        a.next_run_at = next_fire(schedule_of(t), a.timezone, datetime.utcnow())


def _advance(db: Session, a: models.Automation, now: datetime) -> bool:
    """Atomically moves next_run_at forward; False if another worker did."""
    old = a.next_run_at
    new = next_fire(schedule_of(a.trigger or {}), a.timezone, now)
    res = db.execute(
        update(models.Automation)
        .where(models.Automation.id == a.id, models.Automation.next_run_at == old)
        .values(next_run_at=new)
    )
    db.commit()
    if res.rowcount != 1:
        return False
    db.refresh(a)
    return True


def _check_threshold(db: Session, a: models.Automation) -> None:
    owner = db.get(models.User, a.owner_id)
    trig = a.trigger or {}
    try:
        snap, info = _fresh_snapshot(db, owner, trig.get("target") or {})
    except Exception as e:  # noqa: BLE001
        db.rollback()
        a.last_checked_at = datetime.utcnow()
        a.last_status = "failed"
        db.commit()
        logger.warning("[automations] threshold check for %s failed: %s", a.id, e)
        return
    kpi = next((k for k in snap.get("kpis") or [] if k.get("key") == trig.get("kpi")), None)
    met, val = condition_met(trig, kpi or {})
    was = a.last_condition
    a.last_checked_at = datetime.utcnow()
    a.last_value = val
    a.last_condition = met
    db.commit()
    if met and not was:
        alert = {"kpi": trig.get("kpi_label") or "The number", "value": val, "condition": threshold_text(db, trig)}
        preset = {"kpis": snap.get("kpis") or [], "link": info["link"], "subject_name": info["name"], "link_label": "Open in GD360"}
        owner_ = db.get(models.User, a.owner_id)
        execute(db, owner=owner_, name=a.name, tz=a.timezone, steps=a.steps or [], tell=a.tell or {},
                stop_on_quality_fail=a.stop_on_quality_fail, reason="threshold", automation=a, alert=alert,
                preset_ctx=preset)


def tick(db: Session, now: datetime | None = None) -> int:
    """Runs every automation that is due. Returns how many ran or were checked."""
    now = now or datetime.utcnow()
    limit = get_settings().AUTOMATION_MAX_PER_TICK
    done = 0
    due = (
        db.query(models.Automation)
        .filter(models.Automation.enabled.is_(True), models.Automation.next_run_at.isnot(None),
                models.Automation.next_run_at <= now)
        .order_by(models.Automation.next_run_at)
        .limit(limit)
        .all()
    )
    for a in due:
        if not _claim(a.id):
            continue
        try:
            if not _advance(db, a, now):
                continue
            if (a.trigger or {}).get("type") == "threshold":
                _check_threshold(db, a)
            else:
                run_automation(db, a, "schedule")
            done += 1
        except Exception as e:  # noqa: BLE001 - one bad automation never blocks the others
            db.rollback()
            logger.warning("[automations] %s failed in the tick: %s", a.id, e)
        finally:
            _release(a.id)

    watching = (
        db.query(models.Automation)
        .filter(models.Automation.enabled.is_(True))
        .all()
    )
    for a in watching:
        if done >= limit:
            break
        t = a.trigger or {}
        if t.get("type") != "new_data":
            continue
        ds = db.get(models.DataSource, t.get("datasource_id") or "")
        version = data_version(ds)
        if version is None or (a.last_seen_data_at and version <= a.last_seen_data_at):
            continue
        if not _claim(a.id):
            continue
        try:
            old = a.last_seen_data_at
            q = update(models.Automation).where(models.Automation.id == a.id)
            q = q.where(models.Automation.last_seen_data_at == old) if old else q.where(models.Automation.last_seen_data_at.is_(None))
            res = db.execute(q.values(last_seen_data_at=version))
            db.commit()
            if res.rowcount != 1:
                continue
            db.refresh(a)
            run_automation(db, a, "new_data")
            done += 1
        except Exception as e:  # noqa: BLE001
            db.rollback()
            logger.warning("[automations] new-data run of %s failed: %s", a.id, e)
        finally:
            _release(a.id)
    return done


def recover_interrupted() -> None:
    """A run whose process died mid-way is marked as such on startup."""
    db = SessionLocal()
    try:
        stale = db.query(models.AutomationRun).filter(models.AutomationRun.status == "running").all()
        for r in stale:
            r.status = "failed"
            r.error_message = "The server restarted while this was running."
            r.finished_at = datetime.utcnow()
        if stale:
            db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()
    finally:
        db.close()


# ------------------------------------------------------- estimates ----

def estimate(db: Session, user: models.User, trigger: dict, steps: list[dict]) -> dict:
    """What each run costs: queries, data scanned, time - from the targets'
    last real runs, never invented."""
    queries, scanned, seconds = 0, 0, 0.0
    known = True
    for s in steps or []:
        t = s.get("type")
        if t == "refresh_project_dashboard":
            d = db.get(models.Dashboard, s.get("dashboard_id") or "")
            st = ((d.project_snapshot or {}).get("steps") or []) if d else []
            queries += len(st)
            seconds += sum((x.get("duration_ms") or 0) for x in st) / 1000
        elif t == "rerun_question":
            r = db.get(models.ProjectRun, s.get("run_id") or "")
            st = (r.steps or []) if r else []
            queries += len(st)
            scanned += sum((x.get("bytes_scanned") or 0) for x in st)
            seconds += sum((x.get("duration_ms") or 0) for x in st) / 1000
        elif t in ("refresh_dashboard", "quality_check"):
            queries += 1
            known = False
        elif t in ("sync_source", "rescore_model"):
            known = False
    if trigger.get("type") == "threshold":
        target = trigger.get("target") or {}
        if target.get("kind") == "project_run":
            r = db.get(models.ProjectRun, target.get("run_id") or "")
            queries += len((r.steps or []) if r else [])
        elif target.get("kind") == "dashboard":
            d = db.get(models.Dashboard, target.get("dashboard_id") or "")
            queries += len(((d.project_snapshot or {}).get("steps") or []) if d else [])
    per_month = runs_per_month(trigger)
    return {
        "queries": queries, "bytes_scanned": scanned or None, "seconds": round(seconds, 1) if seconds else None,
        "runs_per_month": per_month, "exact": known,
    }


def preview_message(db: Session, user: models.User, name: str, tz: str, trigger: dict, steps: list[dict]) -> dict | None:
    """The message people would receive, built from the targets' current
    numbers (nothing is re-run for a preview)."""
    from .project_engine.dashboards import headline_for
    ctx: dict = {}
    alert = None
    for s in steps or []:
        t = s.get("type")
        if t == "refresh_project_dashboard":
            d = db.get(models.Dashboard, s.get("dashboard_id") or "")
            if d and _dash_visible(db, d, user):
                snap = d.project_snapshot or {}
                ctx.setdefault("kpis", snap.get("kpis") or [])
                ctx.setdefault("headline", headline_for(snap) or (d.project_spec or {}).get("headline"))
                ctx.setdefault("link", f"/project-dashboards/{d.id}")
                ctx.setdefault("link_label", "Open dashboard")
                ctx.setdefault("subject_name", d.name)
        elif t == "rerun_question":
            r = db.get(models.ProjectRun, s.get("run_id") or "")
            if r and _run_visible(db, r, user):
                ctx.setdefault("kpis", (r.result or {}).get("kpis") or [])
                ctx.setdefault("headline", ((r.result or {}).get("answer") or {}).get("headline"))
                ctx.setdefault("link", f"/p/{r.conversation_id}?run={r.id}")
                ctx.setdefault("link_label", "Open project")
                ctx.setdefault("subject_name", r.question)
        elif t == "refresh_dashboard":
            d = db.get(models.Dashboard, s.get("dashboard_id") or "")
            if d and _dash_visible(db, d, user):
                ctx.setdefault("link", f"/dashboards/{d.id}")
                ctx.setdefault("link_label", "Open dashboard")
                ctx.setdefault("subject_name", d.name)
        elif t == "summarise":
            ctx["summarise"] = True
    if trigger.get("type") == "threshold":
        try:
            snap, info = _snapshot_for_target(db, user, trigger.get("target") or {})
            kpi = next((k for k in snap.get("kpis") or [] if k.get("key") == trigger.get("kpi")), None)
            if kpi:
                alert = {"kpi": kpi.get("label"), "value": kpi.get("display"), "condition": threshold_text(db, {**trigger, "kpi_label": kpi.get("label")})}
                ctx.setdefault("kpis", snap.get("kpis") or [])
                ctx.setdefault("link", info["link"])
                ctx.setdefault("subject_name", info["name"])
        except AutomationError:
            pass
    if not ctx and not alert:
        return None
    return build_message(db, name or "Automation", tz, ctx, None, "", None, alert)
