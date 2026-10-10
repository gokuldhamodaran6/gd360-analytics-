"""
The Automations home (2026-10-10, round 19): one place for everything that
runs by itself in a workspace - automations and alerts, dashboard refreshes
(the old Jobs page), chains (pipelines) and data syncs - with what needs
attention first.

Nothing here runs anything; it reads the existing engines' own records:
  automations / alerts : models.Automation + AutomationRun
  dashboard refreshes  : models.Dashboard (layout_version 2) + JobRun
  chains               : models.Pipeline + PipelineRun
  data syncs           : models.DataSource (synced apps) + SyncRun

Scope: one workspace at a time (the app's active workspace). In the
personal workspace that is the person's own work (NULL workspace_id counts
as personal, as everywhere else in the app); in a team workspace it is
everything tagged with that workspace. A Space narrows it further to items
whose sources are in the Space.
"""
from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import or_
from sqlalchemy.orm import Session

from .. import models
from . import automations as auto_svc
from . import workspace_access
from .synced_sources import DEFAULT_INTERVAL as SYNC_DEFAULT, SYNC_INTERVALS, SYNCED_KINDS

INTERVALS = {"15m": timedelta(minutes=15), "1h": timedelta(hours=1), "6h": timedelta(hours=6), "daily": timedelta(days=1)}
INTERVAL_TEXT = {"15m": "Every 15 minutes", "1h": "Every hour", "6h": "Every 6 hours", "daily": "Once a day"}
SYNC_TEXT = {"15m": "Every 15 minutes", "1h": "Every hour", "6h": "Every 6 hours", "daily": "Once a day"}
KIND_LABEL = {"automation": "Automation", "alert": "Alert", "refresh": "Dashboard refresh", "chain": "Chain", "sync": "Data sync"}
HISTORY = 7


class ScopeError(LookupError):
    pass


def iso(dt: datetime | None) -> str | None:
    return dt.isoformat() + "Z" if dt else None


# ------------------------------------------------------------------ scope ----

class Scope:
    def __init__(self, db: Session, user: models.User, workspace_id: str | None):
        ws = None
        if workspace_id:
            ws = db.get(models.Workspace, workspace_id)
        if ws is None:
            ws = (
                db.query(models.Workspace)
                .join(models.WorkspaceMember, models.WorkspaceMember.workspace_id == models.Workspace.id)
                .filter(models.WorkspaceMember.user_id == user.id, models.Workspace.is_personal.is_(True))
                .first()
            )
        if ws is None:
            raise ScopeError("Workspace not found.")
        role = workspace_access.member_role(db, user.id, ws.id)
        if role is None:
            raise ScopeError("Workspace not found.")
        self.db, self.user, self.ws, self.role = db, user, ws, role
        self.personal = bool(ws.is_personal)
        self.admin = role in workspace_access.ADMIN_ROLES
        self.can_edit = role in workspace_access._EDIT_ROLES  # noqa: SLF001

    def filter(self, q, model, owner_col="owner_id"):
        ws_col = getattr(model, "workspace_id")
        if self.personal:
            return q.filter(getattr(model, owner_col) == self.user.id,
                            or_(ws_col.is_(None), ws_col == self.ws.id))
        return q.filter(ws_col == self.ws.id)


# ------------------------------------------------------------ the items ----

def _users(db: Session, ids: set[str]) -> dict:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    rows = db.query(models.User).filter(models.User.id.in_(ids)).all()
    return {u.id: (u.full_name or u.email.split("@")[0]) for u in rows}


def _dash_source_id(db: Session, d: models.Dashboard | None) -> str | None:
    if not d:
        return None
    if getattr(d, "datasource_id", None):
        return d.datasource_id
    from ..routers.dashboard_builder import _dashboard_datasource
    ds = _dashboard_datasource(db, d)
    return ds.id if ds else None


def _automation_sources(db: Session, a: models.Automation) -> list[str]:
    out: list[str] = []
    t = a.trigger or {}
    if t.get("datasource_id"):
        out.append(t["datasource_id"])
    tgt = t.get("target") or {}
    if tgt.get("dashboard_id"):
        out.append(_dash_source_id(db, db.get(models.Dashboard, tgt["dashboard_id"])) or "")
    for s in a.steps or []:
        if s.get("datasource_id"):
            out.append(s["datasource_id"])
        if s.get("dashboard_id"):
            out.append(_dash_source_id(db, db.get(models.Dashboard, s["dashboard_id"])) or "")
    return [x for x in dict.fromkeys(out) if x]


def _chain_sources(db: Session, p: models.Pipeline) -> list[str]:
    out = []
    for s in p.steps or []:
        if s.get("datasource_id"):
            out.append(s["datasource_id"])
        if s.get("dashboard_id"):
            out.append(_dash_source_id(db, db.get(models.Dashboard, s["dashboard_id"])) or "")
    return [x for x in dict.fromkeys(out) if x]


def _runs_out(rows) -> list[dict]:
    """Newest-first rows -> oldest-first [{status, at}] for the little bars."""
    return [{"status": r.status, "at": iso(r.started_at)} for r in reversed(rows)]


def _last(rows) -> dict | None:
    if not rows:
        return None
    r = rows[0]
    secs = round((r.finished_at - r.started_at).total_seconds(), 1) if r.finished_at and r.started_at else None
    err = getattr(r, "error_message", None)
    return {"status": r.status, "at": iso(r.finished_at or r.started_at), "seconds": secs, "error": err}


def _data_version(ds: models.DataSource | None) -> datetime | None:
    if not ds:
        return None
    vals = [ds.last_synced_at, ds.api_last_refreshed_at, getattr(ds, "last_event_at", None),
            getattr(ds, "cleaned_updated_at", None), ds.created_at]
    vals = [v for v in vals if v]
    return max(vals) if vals else None


def _is_shared(d: models.Dashboard, team: bool) -> bool:
    share = d.share
    if share and share.published_at:
        return True
    return bool(team and d.workspace_id)


def _upcoming_interval(next_at: datetime | None, interval: str | None, horizon: datetime) -> list[datetime]:
    out = []
    if not next_at or interval not in INTERVALS:
        return out
    t = next_at
    now = datetime.utcnow()
    step = INTERVALS[interval]
    while t <= horizon and len(out) < 200:
        if t >= now - timedelta(minutes=1):
            out.append(t)
        t += step
    return out


def collect(scope: Scope) -> list[dict]:
    """Every item in scope, with its run history."""
    db, user = scope.db, scope.user
    from ..routers.dashboards import _can_edit as dash_can_edit
    from ..routers.pipelines import _can_edit_pipeline
    from ..routers import apps as apps_router
    from ..services import dashboard_engine

    items: list[dict] = []
    owners: set[str] = set()

    # -- automations and alerts --
    autos = scope.filter(db.query(models.Automation), models.Automation).all()
    for a in autos:
        runs = (db.query(models.AutomationRun)
                .filter(models.AutomationRun.automation_id == a.id, models.AutomationRun.reason != "test")
                .order_by(models.AutomationRun.started_at.desc()).limit(HISTORY).all())
        trig = a.trigger or {}
        kind = "alert" if trig.get("type") == "threshold" else "automation"
        body = {"trigger": trig, "steps": a.steps or [], "tell": a.tell or {}}
        try:
            sentence = auto_svc.sentence(db, body)
        except Exception:  # noqa: BLE001 - a broken target never hides the row
            sentence = {"when": "", "do": "", "tell": ""}
        mine = a.owner_id == user.id
        manage = mine or scope.admin
        if trig.get("type") == "new_data":
            sched_text = sentence.get("when") or "When new data arrives"
        else:
            sched_text = sentence.get("when") or "On a schedule"
        owners.add(a.owner_id)
        if a.approval_requested_by_id:
            owners.add(a.approval_requested_by_id)
        last = _last(runs)
        if kind == "alert" and a.last_checked_at and (not last or (a.last_checked_at.isoformat() + "Z") > (last["at"] or "")):
            last = {"status": "failed" if a.last_status == "failed" else "success", "at": iso(a.last_checked_at),
                    "seconds": None, "error": None, "checked": True, "value": a.last_value}
        items.append({
            "key": f"{kind}:{a.id}", "kind": kind, "id": a.id, "name": a.name,
            "detail": " → ".join(x for x in (sentence.get("do"), sentence.get("tell")) if x),
            "sentence": sentence,
            "schedule": {"text": sched_text, "interval": None, "editable": False},
            "enabled": bool(a.enabled), "owner_id": a.owner_id,
            "runs": _runs_out(runs), "last_run": last,
            "next_run_at": iso(a.next_run_at) if a.enabled else None,
            "running": auto_svc.is_running(a.id),
            "can_edit": manage, "can_run": manage and a.approval_status != "pending",
            "can_toggle": manage and (a.approval_status != "pending" or scope.admin),
            "who_can_edit": "Its owner, owners and admins",
            "link": f"/automations/{a.id}",
            "approval": {
                "status": a.approval_status, "requested_at": iso(a.approval_requested_at),
                "requested_by_id": a.approval_requested_by_id, "note": a.approval_note,
                "external": _external_list(db, scope.ws, (a.tell or {}).get("email") or []),
            } if a.approval_status else None,
            "scheduled": True,
            "source_ids": _automation_sources(db, a),
            "_trigger": trig, "_tz": a.timezone,
        })

    # -- dashboard refreshes (the old Jobs page) --
    dashes = scope.filter(db.query(models.Dashboard).filter(models.Dashboard.layout_version == 2), models.Dashboard).all()
    for d in dashes:
        runs = (db.query(models.JobRun)
                .filter(models.JobRun.dashboard_id == d.id,
                        models.JobRun.job_type.in_(("scheduled_refresh", "manual_refresh")))
                .order_by(models.JobRun.started_at.desc()).limit(HISTORY).all())
        sid = _dash_source_id(db, d)
        ds = db.get(models.DataSource, sid) if sid else None
        shared = _is_shared(d, not scope.personal)
        live = bool(ds and dashboard_engine.is_warehouse_native(ds))
        refreshed = d.last_refreshed_at or d.created_at
        version = _data_version(ds)
        stale = bool(shared and not d.refresh_interval and not live and ds and version and refreshed and version > refreshed)
        owners.add(d.owner_id)
        editable = dash_can_edit(db, d, user)
        share = d.share
        where = []
        if share and share.published_at:
            where.append(f"Published ({'public link' if share.mode == 'public' else 'private link'})")
        pubs = db.query(models.DomainPublication).filter(models.DomainPublication.dashboard_id == d.id,
                                                          models.DomainPublication.status == "live").all()
        for p in pubs:
            dom = db.get(models.WorkspaceDomain, p.domain_id)
            if dom:
                where.append(f"{dom.hostname}/{p.path}")
        items.append({
            "key": f"refresh:{d.id}", "kind": "refresh", "id": d.id, "name": d.name,
            "detail": (f"{ds.name} · " if ds else "") + (" · ".join(where) if where else ("Shared with the team" if shared else "Not shared")),
            "schedule": {"text": INTERVAL_TEXT.get(d.refresh_interval or "", "Only when someone refreshes"),
                         "interval": d.refresh_interval or "off", "editable": editable},
            "enabled": bool(d.refresh_interval), "owner_id": d.owner_id,
            "runs": _runs_out(runs), "last_run": _last(runs),
            "next_run_at": iso(d.next_refresh_at) if d.refresh_interval else None,
            "running": bool(runs and runs[0].status == "running"),
            "can_edit": editable, "can_run": editable, "can_toggle": False,
            "who_can_edit": "Owner, admins and members" if not scope.personal else "Only you",
            "link": f"/dashboard-builder/{d.id}",
            "approval": None,
            "scheduled": bool(d.refresh_interval) or bool(runs),
            "shared": shared, "stale": stale, "live_source": live,
            "last_refreshed_at": iso(d.last_refreshed_at),
            "source_ids": [sid] if sid else [],
            "_interval": d.refresh_interval, "_next": d.next_refresh_at,
        })

    # -- chains --
    chains = scope.filter(db.query(models.Pipeline), models.Pipeline).all()
    for p in chains:
        runs = (db.query(models.PipelineRun).filter(models.PipelineRun.pipeline_id == p.id)
                .order_by(models.PipelineRun.started_at.desc()).limit(HISTORY).all())
        owners.add(p.owner_id)
        editable = _can_edit_pipeline(db, p, user)
        try:
            from .pipelines import describe_pipeline
            summary = describe_pipeline(db, p.steps or [])
        except Exception:  # noqa: BLE001
            summary = []
        items.append({
            "key": f"chain:{p.id}", "kind": "chain", "id": p.id, "name": p.name,
            "detail": " → ".join(summary) if summary else (p.description or f"{len(p.steps or [])} steps"),
            "schedule": {"text": INTERVAL_TEXT.get(p.schedule_interval or "", "Only when run by hand"),
                         "interval": p.schedule_interval or "off", "editable": editable},
            "enabled": bool(p.schedule_interval), "owner_id": p.owner_id,
            "runs": _runs_out(runs), "last_run": _last(runs),
            "next_run_at": iso(p.next_run_at) if p.schedule_interval else None,
            "running": bool(runs and runs[0].status == "running"),
            "can_edit": editable, "can_run": editable, "can_toggle": False,
            "can_delete": p.owner_id == user.id,
            "who_can_edit": "Owner, admins and members" if not scope.personal else "Only you",
            "link": None, "approval": None, "scheduled": True,
            "steps": p.steps or [], "description": p.description,
            "source_ids": _chain_sources(db, p),
            "_interval": p.schedule_interval, "_next": p.next_run_at,
        })

    # -- data syncs --
    sources = scope.filter(db.query(models.DataSource).filter(models.DataSource.kind.in_(SYNCED_KINDS)),
                           models.DataSource).all()
    for ds in sources:
        runs = (db.query(models.SyncRun).filter(models.SyncRun.datasource_id == ds.id)
                .order_by(models.SyncRun.started_at.desc()).limit(HISTORY).all())
        interval = (ds.connection_info or {}).get("sync_interval") or SYNC_DEFAULT.get(ds.kind, "1h")
        owners.add(ds.owner_id)
        editable = workspace_access.can_edit_datasource(db, ds, user)
        syncing = ds.id in apps_router._SYNCING or bool(runs and runs[0].status == "running")  # noqa: SLF001
        last = _last(runs)
        if not last and (ds.last_synced_at or ds.sync_error):
            last = {"status": "failed" if ds.sync_error and not ds.last_synced_at else "success",
                    "at": iso(ds.last_synced_at), "seconds": None, "error": ds.sync_error}
        if last and ds.sync_error and last["status"] != "failed" and runs and runs[0].status == "failed":
            last["status"] = "failed"
        items.append({
            "key": f"sync:{ds.id}", "kind": "sync", "id": ds.id, "name": ds.name,
            "detail": f"Copies new {ds.kind.replace('_', ' ').title()} records into GD360",
            "schedule": {"text": SYNC_TEXT.get(interval, "On a schedule"), "interval": interval, "editable": editable,
                         "options": list(SYNC_INTERVALS.keys())},
            "enabled": True, "owner_id": ds.owner_id,
            "runs": _runs_out(runs), "last_run": last,
            "next_run_at": iso(ds.next_sync_at),
            "running": syncing,
            "can_edit": editable, "can_run": editable, "can_toggle": False,
            "who_can_edit": "Owner, admins and members" if not scope.personal else "Only you",
            "link": f"/workspace/{ds.id}", "approval": None, "scheduled": True,
            "sync_error": ds.sync_error,
            "source_ids": [ds.id],
            "_interval": interval, "_next": ds.next_sync_at,
        })

    names = _users(db, owners)
    for it in items:
        it["owner"] = {"id": it["owner_id"], "name": "You" if it["owner_id"] == user.id else names.get(it["owner_id"], "Someone")}
        ap = it.get("approval")
        if ap and ap.get("requested_by_id"):
            ap["requested_by"] = "You" if ap["requested_by_id"] == user.id else names.get(ap["requested_by_id"], "Someone")
    return items


# ------------------------------------------------------- outside emails ----

FREE_MAIL = {"gmail.com", "googlemail.com", "yahoo.com", "outlook.com", "hotmail.com", "live.com", "icloud.com",
             "me.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "zoho.com", "yandex.com", "mail.com"}


def company_domains(db: Session, ws: models.Workspace) -> set[str]:
    """Email domains that count as 'inside the company' for this workspace:
    every member's work domain (free-mail domains never count), plus the
    company domain's allowed sign-in domains."""
    out: set[str] = set()
    rows = (db.query(models.User.email).join(models.WorkspaceMember, models.WorkspaceMember.user_id == models.User.id)
            .filter(models.WorkspaceMember.workspace_id == ws.id).all())
    for (email,) in rows:
        dom = (email or "").split("@")[-1].lower()
        if dom and dom not in FREE_MAIL:
            out.add(dom)
    wd = db.query(models.WorkspaceDomain).filter(models.WorkspaceDomain.workspace_id == ws.id).first()
    for d in (wd.allowed_email_domains or []) if wd else []:
        out.add(str(d).lower())
    return out


def member_emails(db: Session, ws: models.Workspace) -> set[str]:
    rows = (db.query(models.User.email).join(models.WorkspaceMember, models.WorkspaceMember.user_id == models.User.id)
            .filter(models.WorkspaceMember.workspace_id == ws.id).all())
    return {(e or "").lower() for (e,) in rows}


def _external_list(db: Session, ws: models.Workspace | None, emails: list[str]) -> list[str]:
    if not ws or ws.is_personal or not emails:
        return []
    doms = company_domains(db, ws)
    mem = member_emails(db, ws)
    return [e for e in emails if e.lower() not in mem and e.split("@")[-1].lower() not in doms]


# ------------------------------------------------------------- overview ----

def _fmt_ago(dt_iso: str | None) -> str:
    if not dt_iso:
        return ""
    try:
        dt = datetime.fromisoformat(dt_iso.rstrip("Z"))
    except ValueError:
        return ""
    secs = max(0, int((datetime.utcnow() - dt).total_seconds()))
    if secs < 90:
        return "just now"
    if secs < 3600:
        return f"{secs // 60} min ago"
    if secs < 86400:
        return f"{secs // 3600} h ago"
    return f"{secs // 86400} d ago"


def upcoming(items: list[dict], hours: int = 24) -> list[dict]:
    horizon = datetime.utcnow() + timedelta(hours=hours)
    out: list[dict] = []
    for it in items:
        times: list[datetime] = []
        if it["kind"] in ("automation", "alert"):
            if not it["enabled"]:
                continue
            trig = it.get("_trigger") or {}
            if trig.get("type") in ("schedule", "threshold"):
                try:
                    times = [t for t in auto_svc.next_runs(trig, it.get("_tz") or "UTC", 60) if t <= horizon]
                except Exception:  # noqa: BLE001
                    times = []
        elif it["kind"] in ("refresh", "chain", "sync"):
            if it["kind"] != "sync" and not it.get("_interval"):
                continue
            times = _upcoming_interval(it.get("_next"), it.get("_interval"), horizon)
        for t in times:
            out.append({"at": iso(t), "key": it["key"], "kind": it["kind"], "name": it["name"]})
    out.sort(key=lambda x: x["at"])
    return out


def attention(scope: Scope, items: list[dict]) -> list[dict]:
    db = scope.db
    out: list[dict] = []
    # 1. approvals waiting (owners/admins act; the requester sees it waiting)
    for it in items:
        ap = it.get("approval")
        if not ap or ap.get("status") != "pending":
            continue
        ext = ap.get("external") or []
        who = ap.get("requested_by") or it["owner"]["name"]
        if scope.admin:
            out.append({
                "id": f"approve:{it['id']}", "tone": "approval", "key": it["key"],
                "title": f"{who} wants to email {len(ext)} {'person' if len(ext) == 1 else 'people'} outside {scope.ws.name}",
                "detail": f"“{it['name']}” · " + ", ".join(ext[:3]) + (f" and {len(ext) - 3} more" if len(ext) > 3 else ""),
                "actions": ["approve", "reject", "open"],
            })
        elif it["owner_id"] == scope.user.id:
            out.append({
                "id": f"waiting:{it['id']}", "tone": "info", "key": it["key"],
                "title": f"“{it['name']}” is waiting for an owner's or admin's OK",
                "detail": "It emails people outside the company, so it stays off until someone approves it.",
                "actions": ["open"],
            })
    # 2. failures
    for it in items:
        last = it.get("last_run") or {}
        if last.get("status") != "failed":
            continue
        if it["kind"] in ("automation", "alert") and not it["enabled"]:
            continue
        what = {"refresh": "refresh", "chain": "chain", "sync": "sync", "automation": "run", "alert": "check"}[it["kind"]]
        out.append({
            "id": f"failed:{it['key']}", "tone": "failed", "key": it["key"],
            "title": f"{it['name']} — the last {what} failed {_fmt_ago(last.get('at'))}".strip(),
            "detail": (last.get("error") or "No error message was recorded.")[:240],
            "actions": (["retry"] if it.get("can_run") else []) + (["open"] if it.get("link") else ["history"]),
        })
    # 3. shared dashboards whose data changed but that never refresh
    stale = [it for it in items if it.get("stale")]
    if stale:
        out.append({
            "id": "stale", "tone": "stale", "keys": [s["key"] for s in stale],
            "title": f"{len(stale)} shared dashboard{'s' if len(stale) != 1 else ''} only update when someone presses refresh",
            "detail": "Their data changed since they were last refreshed: " + ", ".join(s["name"] for s in stale[:3])
                      + (f" and {len(stale) - 3} more" if len(stale) > 3 else "") + ".",
            "actions": ["schedule_daily", "refresh_all"] if any(s.get("can_edit") for s in stale) else [],
        })
    # 4. quality checks failing on sources in scope
    src_ids = {sid for it in items for sid in it.get("source_ids") or []}
    ws_sources = scope.filter(db.query(models.DataSource), models.DataSource).all()
    src_ids |= {d.id for d in ws_sources}
    if src_ids:
        rows = (db.query(models.DataQualityRule)
                .filter(models.DataQualityRule.datasource_id.in_(src_ids), models.DataQualityRule.last_status == "fail").all())
        by_ds: dict[str, int] = {}
        for r in rows:
            by_ds[r.datasource_id] = by_ds.get(r.datasource_id, 0) + 1
        for ds_id, n in by_ds.items():
            ds = db.get(models.DataSource, ds_id)
            if not ds:
                continue
            out.append({
                "id": f"quality:{ds_id}", "tone": "quality", "key": None,
                "title": f"{ds.name}: {n} quality check{'s' if n != 1 else ''} failing",
                "detail": "Numbers built on this source may be wrong until the data is fixed.",
                "actions": ["open_source"], "datasource_id": ds_id,
            })
    order = {"approval": 0, "failed": 1, "stale": 2, "quality": 3, "info": 4}
    out.sort(key=lambda x: order.get(x["tone"], 9))
    return out


def tiles(scope: Scope, items: list[dict], timeline: list[dict]) -> dict:
    db = scope.db
    since = datetime.utcnow() - timedelta(hours=24)
    keys = {it["key"] for it in items}
    failed = 0
    by_kind = {"automation": set(), "alert": set(), "refresh": set(), "chain": set(), "sync": set()}
    for it in items:
        by_kind[it["kind"]].add(it["id"])
    auto_ids = by_kind["automation"] | by_kind["alert"]
    if auto_ids:
        failed += db.query(models.AutomationRun).filter(models.AutomationRun.automation_id.in_(auto_ids),
                                                        models.AutomationRun.status == "failed",
                                                        models.AutomationRun.reason != "test",
                                                        models.AutomationRun.started_at >= since).count()
    if by_kind["refresh"]:
        failed += db.query(models.JobRun).filter(models.JobRun.dashboard_id.in_(by_kind["refresh"]),
                                                 models.JobRun.job_type.in_(("scheduled_refresh", "manual_refresh")),
                                                 models.JobRun.status == "failed", models.JobRun.started_at >= since).count()
    if by_kind["chain"]:
        failed += db.query(models.PipelineRun).filter(models.PipelineRun.pipeline_id.in_(by_kind["chain"]),
                                                      models.PipelineRun.status == "failed",
                                                      models.PipelineRun.started_at >= since).count()
    if by_kind["sync"]:
        failed += db.query(models.SyncRun).filter(models.SyncRun.datasource_id.in_(by_kind["sync"]),
                                                  models.SyncRun.status == "failed", models.SyncRun.started_at >= since).count()
    running = [it for it in items if it.get("running")]
    active = [it for it in items if (it["kind"] in ("automation", "alert") and it["enabled"])
              or (it["kind"] in ("refresh", "chain") and it.get("_interval")) or it["kind"] == "sync"]
    counts = {k: 0 for k in KIND_LABEL}
    for it in active:
        counts[it["kind"]] += 1
    nxt = timeline[0] if timeline else None
    return {
        "active": len(active), "active_by_kind": counts,
        "running_now": len(running), "running_names": [r["name"] for r in running][:3],
        "next_24h": len(timeline), "next": nxt,
        "failed_24h": failed,
        "stale": sum(1 for it in items if it.get("stale")),
        "waiting": sum(1 for it in items if (it.get("approval") or {}).get("status") == "pending"),
        "total": len(keys),
    }


def overview(db: Session, user: models.User, workspace_id: str | None, space_id: str | None = None) -> dict:
    scope = Scope(db, user, workspace_id)
    items = collect(scope)
    space = None
    if space_id:
        from . import spaces as spaces_svc
        sp = spaces_svc.get_space(db, user, space_id)
        if sp:
            space = {"id": sp.id, "name": sp.name}
            ids = set(sp.source_ids or [])
            items = [it for it in items if ids & set(it.get("source_ids") or [])]
    timeline = upcoming(items)
    out_items = [{k: v for k, v in it.items() if not k.startswith("_")} for it in items]
    order = {"automation": 0, "alert": 1, "refresh": 2, "chain": 3, "sync": 4}
    out_items.sort(key=lambda x: (0 if (x.get("last_run") or {}).get("status") == "failed" else 1,
                                  order.get(x["kind"], 9), (x["name"] or "").lower()))
    return {
        "workspace": {"id": scope.ws.id, "name": scope.ws.name, "personal": scope.personal, "role": scope.role,
                      "admin": scope.admin, "can_edit": scope.can_edit},
        "space": space,
        "tiles": tiles(scope, items, timeline),
        "attention": attention(scope, items),
        "timeline": timeline[:60],
        "items": out_items,
        "email_ready": auto_svc.email_configured(),
        "generated_at": iso(datetime.utcnow()),
    }


# ------------------------------------------------------------- run feed ----

def run_feed(db: Session, user: models.User, workspace_id: str | None, page: int = 1, page_size: int = 25,
             kind: str | None = None, status: str | None = None) -> dict:
    scope = Scope(db, user, workspace_id)
    items = collect(scope)
    names = {it["key"]: it["name"] for it in items}
    ids = {k: {it["id"] for it in items if it["kind"] == k} for k in KIND_LABEL}
    page = max(1, page)
    page_size = max(1, min(100, page_size))
    want = page * page_size
    rows: list[dict] = []
    total = 0

    def take(q, model, to_row):
        nonlocal total
        if status in ("success", "failed", "running"):
            q = q.filter(model.status == status)
        total += q.count()
        for r in q.order_by(model.started_at.desc()).limit(want).all():
            rows.append(to_row(r))

    def secs(r):
        return round((r.finished_at - r.started_at).total_seconds(), 1) if r.finished_at and r.started_at else None

    auto_ids = (ids["automation"] if kind in (None, "automation") else set()) | (ids["alert"] if kind in (None, "alert") else set())
    if auto_ids:
        take(db.query(models.AutomationRun).filter(models.AutomationRun.automation_id.in_(auto_ids),
                                                   models.AutomationRun.reason != "test"),
             models.AutomationRun,
             lambda r: {"id": r.id, "kind": "alert" if r.reason == "threshold" or f"alert:{r.automation_id}" in names else "automation",
                        "item_id": r.automation_id, "name": r.automation_name, "reason": r.reason, "status": r.status,
                        "started_at": iso(r.started_at), "seconds": secs(r), "error": r.error_message,
                        "detail": (r.message or {}).get("headline") if isinstance(r.message, dict) else None})
    if ids["refresh"] and kind in (None, "refresh"):
        take(db.query(models.JobRun).filter(models.JobRun.dashboard_id.in_(ids["refresh"]),
                                            models.JobRun.job_type.in_(("scheduled_refresh", "manual_refresh"))),
             models.JobRun,
             lambda r: {"id": r.id, "kind": "refresh", "item_id": r.dashboard_id, "name": r.target_label,
                        "reason": "manual" if r.job_type == "manual_refresh" else "schedule", "status": r.status,
                        "started_at": iso(r.started_at), "seconds": secs(r), "error": r.error_message,
                        "detail": r.source_label})
    if ids["chain"] and kind in (None, "chain"):
        take(db.query(models.PipelineRun).filter(models.PipelineRun.pipeline_id.in_(ids["chain"])),
             models.PipelineRun,
             lambda r: {"id": r.id, "kind": "chain", "item_id": r.pipeline_id, "name": r.pipeline_name,
                        "reason": "manual" if r.run_type == "manual" else "schedule", "status": r.status,
                        "started_at": iso(r.started_at), "seconds": secs(r), "error": r.error_message,
                        "detail": f"{len(r.step_results or [])} steps", "steps": r.step_results or []})
    if ids["sync"] and kind in (None, "sync"):
        take(db.query(models.SyncRun).filter(models.SyncRun.datasource_id.in_(ids["sync"])),
             models.SyncRun,
             lambda r: {"id": r.id, "kind": "sync", "item_id": r.datasource_id, "name": names.get(f"sync:{r.datasource_id}", "Data sync"),
                        "reason": r.reason, "status": r.status, "started_at": iso(r.started_at), "seconds": secs(r),
                        "error": r.error_message, "detail": f"{r.rows:,} rows" if r.rows is not None else None})
    rows.sort(key=lambda x: x["started_at"] or "", reverse=True)
    start = (page - 1) * page_size
    return {"runs": rows[start:start + page_size], "total": total, "page": page, "page_size": page_size}


def item_runs(db: Session, user: models.User, workspace_id: str | None, key: str, limit: int = 30) -> dict:
    """Run history for one item (the drawer)."""
    scope = Scope(db, user, workspace_id)
    kind, _, item_id = key.partition(":")
    items = {it["key"]: it for it in collect(scope)}
    if key not in items:
        raise ScopeError("Not found.")
    limit = max(1, min(100, limit))
    out = []
    if kind in ("automation", "alert"):
        for r in (db.query(models.AutomationRun).filter(models.AutomationRun.automation_id == item_id)
                  .order_by(models.AutomationRun.started_at.desc()).limit(limit)):
            out.append({"id": r.id, "status": r.status, "reason": r.reason, "started_at": iso(r.started_at),
                        "seconds": round((r.finished_at - r.started_at).total_seconds(), 1) if r.finished_at else None,
                        "error": r.error_message, "steps": r.step_results or [], "deliveries": r.deliveries or [],
                        "headline": (r.message or {}).get("headline") if isinstance(r.message, dict) else None})
    elif kind == "refresh":
        for r in (db.query(models.JobRun).filter(models.JobRun.dashboard_id == item_id,
                                                 models.JobRun.job_type.in_(("scheduled_refresh", "manual_refresh")))
                  .order_by(models.JobRun.started_at.desc()).limit(limit)):
            out.append({"id": r.id, "status": r.status, "reason": "manual" if r.job_type == "manual_refresh" else "schedule",
                        "started_at": iso(r.started_at), "seconds": r.duration_seconds, "error": r.error_message})
    elif kind == "chain":
        for r in (db.query(models.PipelineRun).filter(models.PipelineRun.pipeline_id == item_id)
                  .order_by(models.PipelineRun.started_at.desc()).limit(limit)):
            out.append({"id": r.id, "status": r.status, "reason": "manual" if r.run_type == "manual" else "schedule",
                        "started_at": iso(r.started_at), "seconds": r.duration_seconds, "error": r.error_message,
                        "steps": [{"index": s.get("index"), "label": s.get("label"), "status": "done" if s.get("status") == "success" else s.get("status"),
                                   "error": s.get("error")} for s in (r.step_results or [])]})
    elif kind == "sync":
        for r in (db.query(models.SyncRun).filter(models.SyncRun.datasource_id == item_id)
                  .order_by(models.SyncRun.started_at.desc()).limit(limit)):
            out.append({"id": r.id, "status": r.status, "reason": r.reason, "started_at": iso(r.started_at),
                        "seconds": round((r.finished_at - r.started_at).total_seconds(), 1) if r.finished_at else None,
                        "error": r.error_message, "rows": r.rows})
    it = {k: v for k, v in items[key].items() if not k.startswith("_")}
    return {"item": it, "runs": out}
