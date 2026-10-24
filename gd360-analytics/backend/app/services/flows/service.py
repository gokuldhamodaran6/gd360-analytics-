"""What the /flows router calls. Access, drafts, saving versions, turning
on/off, fixes, history and 'used by'."""
from __future__ import annotations

import json
from datetime import datetime
from zoneinfo import ZoneInfo

from sqlalchemy.orm import Session

from ... import models
from ..workspace_access import can_access_datasource, member_role, member_workspace_ids
from . import chat, fix as fixer, plan, runner
from .profile import FlowError, profile
from .spec import check_words, check_zone, code_for, step_words, validate


class NotFound(FlowError):
    pass


class Forbidden(FlowError):
    pass


class NeedSources(FlowError):
    def __init__(self, message: str, options: list[dict]):
        super().__init__(message)
        self.options = options


def iso(d: datetime | None) -> str | None:
    return d.replace(microsecond=0).isoformat() + "Z" if d else None


# ------------------------------------------------------------- access ----

def get_flow(db: Session, user: models.User, flow_id: str, edit: bool = False) -> models.DataFlow:
    f = db.get(models.DataFlow, flow_id)
    if f is None:
        raise NotFound("This flow doesn’t exist or you don’t have access.")
    if f.owner_id == user.id:
        return f
    if not f.workspace_id or f.workspace_id not in member_workspace_ids(db, user.id):
        raise NotFound("This flow doesn’t exist or you don’t have access.")
    if edit and member_role(db, user.id, f.workspace_id) == "viewer":
        raise Forbidden("You can view this flow but not change it.")
    return f


def can_edit(db: Session, user: models.User, f: models.DataFlow) -> bool:
    if f.owner_id == user.id:
        return True
    return bool(f.workspace_id) and member_role(db, user.id, f.workspace_id) not in (None, "viewer")


def list_flows(db: Session, user: models.User, workspace_id: str | None) -> list[dict]:
    q = db.query(models.DataFlow)
    if workspace_id:
        if workspace_id not in member_workspace_ids(db, user.id):
            q = q.filter(models.DataFlow.owner_id == user.id, models.DataFlow.workspace_id == workspace_id)
        else:
            q = q.filter(models.DataFlow.workspace_id == workspace_id)
    else:
        q = q.filter(models.DataFlow.owner_id == user.id)
    out = []
    for f in q.order_by(models.DataFlow.updated_at.desc()).limit(200).all():
        last = db.get(models.DataFlowRun, f.last_run_id) if f.last_run_id else None
        out.append({
            "id": f.id, "name": f.name, "status": f.status, "enabled": f.enabled,
            "sources": [s.get("label") for s in (f.spec or {}).get("sources") or []],
            "output": (f.spec or {}).get("output", {}).get("name"),
            "schedule": _schedule_text(f.spec or {}),
            "next_run_at": iso(f.next_run_at), "last_run_at": iso(f.last_run_at), "last_status": f.last_status,
            "last_rows": (last.stats or {}).get("rows_out") if last else None,
            "last_flagged": (last.stats or {}).get("flagged") if last else None,
            "needs_fix": bool(f.pending_fix), "updated_at": iso(f.updated_at),
        })
    return out


# ------------------------------------------------------------ helpers ----

def _schedule_text(spec: dict) -> str:
    sch = spec.get("schedule") or {}
    days = sch.get("days") or list(range(7))
    when = "Every day" if len(days) == 7 else "Weekdays" if days == [0, 1, 2, 3, 4] else \
        ", ".join(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][d] for d in days)
    return f"{when} at {sch.get('time', '06:00')}"


def _next_local(f: models.DataFlow) -> str | None:
    if not f.next_run_at:
        return None
    tz = ((f.spec or {}).get("schedule") or {}).get("timezone") or "UTC"
    local = f.next_run_at.replace(tzinfo=ZoneInfo("UTC")).astimezone(ZoneInfo(tz))
    today = datetime.now(ZoneInfo(tz)).date()
    day = "today" if local.date() == today else "tomorrow" if (local.date() - today).days == 1 else f"{local:%a %d %b}"
    return f"{day} at {local:%H:%M}"


def _run_out(r: models.DataFlowRun, full: bool = False) -> dict:
    dur = (r.finished_at - r.started_at).total_seconds() if r.finished_at and r.started_at else None
    out = {"id": r.id, "reason": r.reason, "status": r.status, "published": r.published, "version": r.version,
           "started_at": iso(r.started_at), "finished_at": iso(r.finished_at),
           "seconds": round(dur, 1) if dur is not None else None,
           "rows_out": (r.stats or {}).get("rows_out"), "flagged": (r.stats or {}).get("flagged"),
           "error": r.error_message}
    if full:
        out.update({"stats": r.stats or {}, "checks": r.checks or [], "events": r.events or [], "flagged_rows": r.flagged or [],
                    "set_aside": r.set_aside or [], "examples": r.examples or [], "preview": r.preview or {},
                    "deliveries": r.deliveries or []})
    return out


def used_by(db: Session, f: models.DataFlow) -> list[dict]:
    ds_id = f.output_datasource_id
    if not ds_id:
        return []
    out: list[dict] = []
    seen: set[str] = set()
    dash_ids = {r[0] for r in db.query(models.Dashboard.id).filter(models.Dashboard.datasource_id == ds_id).all()}
    dash_ids |= {r[0] for r in db.query(models.DashboardPage.dashboard_id).filter(models.DashboardPage.datasource_id == ds_id).all()}
    if dash_ids:
        for d in db.query(models.Dashboard).filter(models.Dashboard.id.in_(dash_ids)).limit(30).all():
            out.append({"kind": "dashboard", "id": d.id, "name": d.name, "link": f"/dashboards/{d.id}"})
            seen.add(d.id)
    scope = (models.DocDocument.workspace_id == f.workspace_id) if f.workspace_id else (models.DocDocument.owner_id == f.owner_id)
    for doc in db.query(models.DocDocument).filter(scope).order_by(models.DocDocument.updated_at.desc()).limit(300).all():
        if ds_id in json.dumps(doc.sources or [], default=str) or ds_id in json.dumps(doc.meta or {}, default=str):
            out.append({"kind": "doc", "id": doc.id, "name": doc.title, "link": f"/docs/{doc.id}"})
    ascope = (models.Automation.workspace_id == f.workspace_id) if f.workspace_id else (models.Automation.owner_id == f.owner_id)
    for a in db.query(models.Automation).filter(ascope).limit(300).all():
        if ds_id in json.dumps([a.steps, a.trigger], default=str):
            out.append({"kind": "automation", "id": a.id, "name": a.name, "link": f"/automations/{a.id}"})
    return out


def flow_out(db: Session, user: models.User, f: models.DataFlow) -> dict:
    spec = f.spec or {}
    try:
        code = code_for(validate(spec))
    except FlowError:
        code = "-- this plan has a problem; fix it in the plan view"
    runs = (db.query(models.DataFlowRun).filter(models.DataFlowRun.flow_id == f.id)
            .order_by(models.DataFlowRun.started_at.desc()).limit(30).all())
    last_test = next((r for r in runs if r.reason == "test"), None)
    last_live = next((r for r in runs if r.reason != "test"), None)
    running = next((r for r in runs if r.status == "running"), None)
    out_ds = db.get(models.DataSource, f.output_datasource_id) if f.output_datasource_id else None
    people_ids = set((spec.get("policy") or {}).get("flag_to") or []) | set((spec.get("policy") or {}).get("alert_to") or [])
    people = {u.id: (u.full_name or u.email) for u in db.query(models.User).filter(models.User.id.in_(people_ids or {"-"})).all()}
    return {
        "id": f.id, "name": f.name, "request": f.request, "status": f.status, "enabled": f.enabled,
        "version": f.version, "workspace_id": f.workspace_id, "can_edit": can_edit(db, user, f),
        "spec": spec,
        "steps": [{"id": st["id"], "kind": st["kind"], "enabled": st.get("enabled", True), **step_words(spec, st)}
                  for st in spec.get("steps") or []] if _valid(spec) else [],
        "checks": [{"id": c["id"], "kind": c["kind"], "enabled": c.get("enabled", True), "label": check_words(c),
                    "column": c.get("column"), "value": c.get("value"), "time": c.get("time")}
                   for c in spec.get("checks") or []] if _valid(spec) else [],
        "schedule_text": _schedule_text(spec), "code": code,
        "profile": f.profile, "thread": f.thread or [], "pending_fix": f.pending_fix,
        "output": {"datasource_id": f.output_datasource_id, "name": (spec.get("output") or {}).get("name"),
                   "exists": out_ds is not None},
        "next_run_at": iso(f.next_run_at), "next_run_text": _next_local(f),
        "last_run_at": iso(f.last_run_at), "last_status": f.last_status,
        "last_test": _run_out(last_test, True) if last_test else None,
        "last_live": _run_out(last_live, True) if last_live else None,
        "running": _run_out(running) if running else None,
        "runs": [_run_out(r) for r in runs if r.reason != "test"][:14],
        "used_by": used_by(db, f), "people": people,
        "created_at": iso(f.created_at), "updated_at": iso(f.updated_at),
    }


def _valid(spec: dict) -> bool:
    try:
        validate(spec)
        return True
    except FlowError:
        return False


def _check_sources(db: Session, user: models.User, spec: dict) -> None:
    """A plan may only read sources the person editing it can open."""
    for s in spec.get("sources") or []:
        ds = db.get(models.DataSource, s.get("datasource_id"))
        if ds is None or not can_access_datasource(db, ds, user):
            raise FlowError("One of the sources in this plan doesn’t exist or you don’t have access to it.")


def _save_version(db: Session, f: models.DataFlow, user: models.User | None, spec: dict, note: str | None) -> None:
    spec = validate(spec)
    if user is not None:
        _check_sources(db, user, spec)
    f.version = (f.version or 0) + 1
    f.spec = spec
    db.add(models.DataFlowVersion(flow_id=f.id, version=f.version, spec=spec, note=(note or "Changed the plan")[:300],
                                  created_by=user.id if user else None))
    if f.enabled:
        f.next_run_at = runner.next_run(spec, datetime.utcnow())
    f.updated_at = datetime.utcnow()


# ------------------------------------------------------------- create ----

def _read_message(prof: dict, sources: list[dict]) -> str:
    link = prof.get("link")
    kinds = {}
    for i in prof.get("issues") or []:
        kinds.setdefault(i["kind"], 0)
        kinds[i["kind"]] += i.get("count", 0)
    parts = []
    if link:
        parts.append(f"I found the link: “{link['left_on']}” and “{link['right_on']}” match for "
                     f"{round(link['overlap'] * 100)}% of rows.")
    elif len(sources) > 1:
        parts.append("I couldn’t find a column that links these sources yet.")
    n = len(prof.get("issues") or [])
    if n:
        parts.append(f"Before building anything I looked at the real data and found {n} kind{'s' if n != 1 else ''} of "
                     "mistake you’d normally fix by hand. They’re marked on the right.")
    else:
        parts.append("The data looks tidy - no typing mistakes found.")
    return " ".join(parts)


def create_draft(db: Session, user: models.User, text: str, workspace_id: str | None, source_ids: list[str] | None,
                 timezone: str | None) -> models.DataFlow:
    text = (text or "").strip()
    if len(text) < 6:
        raise FlowError("Describe the job in a sentence, e.g. “Every morning, combine Shopify orders with the refunds sheet.”")
    if workspace_id and workspace_id not in member_workspace_ids(db, user.id):
        raise NotFound("That workspace doesn’t exist or you don’t have access.")
    options = plan.source_options(db, user, workspace_id)
    if not options:
        raise NeedSources("Connect or upload a data source first - Euliv needs something to read.", [])
    sources = plan.match_sources(text, options, source_ids)
    if not sources:
        raise NeedSources("Which data should I use? Pick one or more sources.", options)
    prof, _ = profile(db, sources)
    tz = timezone or "UTC"
    try:
        check_zone(tz)
    except FlowError:
        tz = "UTC"
    name, spec, notes = plan.build_spec(text, sources, prof, timezone=tz, owner_id=user.id)
    order = [s["alias"] for s in spec["sources"]]
    sources = sorted(sources, key=lambda s: order.index(s["alias"]) if s["alias"] in order else 99)
    spec = validate(spec)
    f = models.DataFlow(owner_id=user.id, workspace_id=workspace_id, name=name, request=text, status="draft",
                        enabled=False, spec=spec, version=1, profile=prof, thread=[])
    db.add(f)
    db.flush()
    db.add(models.DataFlowVersion(flow_id=f.id, version=1, spec=spec, note="First plan", created_by=user.id))
    runner.add_message(f, "user", "text", text)
    runner.add_message(f, "gd360", "read", _read_message(prof, sources), {
        "sources": [{"label": s["label"], "rows": next((p["rows"] for p in prof["sources"] if p["alias"] == s["alias"]), None)}
                    for s in sources],
        "issues": len(prof.get("issues") or []), "link": prof.get("link")})
    n_steps = len(spec["steps"]) + 3  # read, the steps, check, save - as the plan lists them
    n_checks = len([c for c in spec["checks"]])
    runner.add_message(f, "gd360", "plan",
                       f"Here’s the plan: {n_steps} steps and {n_checks} checks. Each step says what it does in plain words. "
                       "Nothing runs until you say go.", {"notes": notes})
    db.commit()
    db.refresh(f)
    return f


def replan(db: Session, user: models.User, f: models.DataFlow, source_ids: list[str] | None) -> models.DataFlow:
    options = plan.source_options(db, user, f.workspace_id)
    sources = plan.match_sources(f.request or "", options, source_ids or [s["datasource_id"] for s in f.spec.get("sources") or []])
    if not sources:
        raise FlowError("Pick at least one source.")
    prof, _ = profile(db, sources)
    old = f.spec or {}
    name, spec, notes = plan.build_spec(f.request or "", sources, prof,
                                        timezone=(old.get("schedule") or {}).get("timezone") or "UTC", owner_id=f.owner_id)
    spec["schedule"] = old.get("schedule") or spec["schedule"]
    spec["policy"] = old.get("policy") or spec["policy"]
    if (old.get("output") or {}).get("name"):
        spec["output"] = old["output"]
    f.profile = prof
    _save_version(db, f, user, spec, "Read the sources again and rebuilt the plan")
    runner.add_message(f, "gd360", "read", _read_message(prof, sources), {
        "sources": [{"label": s["label"]} for s in sources], "issues": len(prof.get("issues") or []), "link": prof.get("link")})
    db.commit()
    return f


# -------------------------------------------------------------- edits ----

def save_spec(db: Session, user: models.User, f: models.DataFlow, spec: dict, note: str | None) -> models.DataFlow:
    _save_version(db, f, user, spec, note)
    runner.add_message(f, "gd360", "edit", f"Saved version {f.version}: {note or 'changed the plan'}. You can undo it from History.",
                       {"version": f.version})
    db.commit()
    return f


def set_enabled(db: Session, user: models.User, f: models.DataFlow, enabled: bool) -> models.DataFlow:
    if enabled:
        if f.status == "draft":
            raise FlowError("Test it once first, so you can see the result before it runs on its own.")
        spec = validate(f.spec)
        f.enabled = True
        f.status = "live"
        f.next_run_at = runner.next_run(spec, datetime.utcnow())
        f.fingerprints = runner.fingerprints(db, spec)
        sch = spec["schedule"]
        runner.add_message(f, "gd360", "live",
                           f"It’s on. It runs {_schedule_text(spec).lower()} ({sch['timezone']})"
                           + (" and when a source changes" if sch.get("on_change") else "")
                           + f". Next run: {_next_local(f)}.", {"next_run_at": iso(f.next_run_at)})
    else:
        f.enabled = False
        f.status = "paused" if f.status in ("live", "paused") else f.status
        f.next_run_at = None
        runner.add_message(f, "gd360", "paused", "Paused. It won’t run until you turn it on again. The last saved table stays as it is.")
    f.updated_at = datetime.utcnow()
    db.commit()
    return f


def message(db: Session, user: models.User, f: models.DataFlow, text: str) -> dict:
    text = (text or "").strip()[:2000]
    if not text:
        raise FlowError("Type a message first.")
    runner.add_message(f, "user", "text", text)
    res = chat.handle(db, f, text)
    if res.get("name"):
        f.name = res["name"][:80]
    if res.get("spec"):
        _save_version(db, f, user, res["spec"], res.get("note"))
    reply = res["reply"]
    run_id = None
    db.commit()
    act = res.get("action")
    try:
        if act == "test":
            run_id = runner.start_run(db, f, "test").id
            reply = (reply + " " if reply else "") + "Testing it on today’s real data now - nothing is saved."
        elif act == "run":
            if f.status == "draft":
                run_id = runner.start_run(db, f, "test").id
                reply = (reply + " " if reply else "") + "It hasn’t been tested yet, so I’m running a test first."
            else:
                run_id = runner.start_run(db, f, "manual").id
                reply = (reply + " " if reply else "") + "Running it now."
        elif act == "enable":
            if f.status == "draft":
                reply = (reply + " " if reply else "") + "Test it once first - say “test it” or press Test."
            else:
                set_enabled(db, user, f, True)
                reply = (reply + " " if reply else "") + "Done, it’s on."
        elif act == "disable":
            set_enabled(db, user, f, False)
            reply = (reply + " " if reply else "") + "Paused."
    except runner.FlowBusy as e:
        reply = (reply + " " if reply else "") + str(e)
    db.refresh(f)
    runner.add_message(f, "gd360", "text", reply.strip(), {"version": f.version, "run_id": run_id})
    db.commit()
    return {"reply": reply, "run_id": run_id}


def apply_fix(db: Session, user: models.User, f: models.DataFlow) -> str:
    pf = f.pending_fix
    if not pf:
        raise FlowError("There is no fix waiting.")
    spec = fixer.apply(validate(f.spec), pf)
    _save_version(db, f, user, spec, "Fix: " + pf["summary"].split(". ")[0])
    f.pending_fix = None
    runner.add_message(f, "user", "text", "Apply the fix")
    runner.add_message(f, "gd360", "edit", f"Applied as version {f.version}. Running it again now; you can undo it from History.",
                       {"version": f.version})
    db.commit()
    run = runner.start_run(db, f, "fix" if f.status in ("live", "paused", "tested") else "test")
    return run.id


def dismiss_fix(db: Session, user: models.User, f: models.DataFlow) -> None:
    f.pending_fix = None
    runner.add_message(f, "gd360", "text", "OK, I left the plan as it is.")
    db.commit()


def versions(db: Session, f: models.DataFlow) -> list[dict]:
    rows = (db.query(models.DataFlowVersion).filter(models.DataFlowVersion.flow_id == f.id)
            .order_by(models.DataFlowVersion.version.desc()).limit(50).all())
    names = {u.id: (u.full_name or u.email) for u in db.query(models.User).filter(
        models.User.id.in_({r.created_by for r in rows if r.created_by} or {"-"})).all()}
    return [{"version": r.version, "note": r.note, "by": names.get(r.created_by, "Euliv"), "at": iso(r.created_at),
             "current": r.version == f.version} for r in rows]


def restore(db: Session, user: models.User, f: models.DataFlow, version: int) -> models.DataFlow:
    row = (db.query(models.DataFlowVersion)
           .filter(models.DataFlowVersion.flow_id == f.id, models.DataFlowVersion.version == version).first())
    if row is None:
        raise NotFound("That version doesn’t exist.")
    _save_version(db, f, user, row.spec, f"Went back to version {version}")
    runner.add_message(f, "gd360", "edit", f"Went back to version {version} (saved as version {f.version}).", {"version": f.version})
    db.commit()
    return f


def delete(db: Session, user: models.User, f: models.DataFlow) -> None:
    if f.owner_id != user.id:
        raise Forbidden("Only the person who made this flow can delete it.")
    # R61: to the Bin - its runs and versions go when it is deleted for good (services/bin.purge)
    from ..bin import move_to_bin
    move_to_bin(db, user, "pipeline", f)


def people(db: Session, user: models.User, workspace_id: str | None) -> list[dict]:
    ids = {user.id}
    if workspace_id and workspace_id in member_workspace_ids(db, user.id):
        ids |= {r[0] for r in db.query(models.WorkspaceMember.user_id)
                .filter(models.WorkspaceMember.workspace_id == workspace_id).all()}
    return [{"id": u.id, "name": u.full_name or u.email, "email": u.email}
            for u in db.query(models.User).filter(models.User.id.in_(ids)).all()]
