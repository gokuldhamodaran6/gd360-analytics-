"""
Mission Control, part 3 (2026-10-10): plans & entitlements, the pricing lab,
product analytics, AI usage & cost (budgets, kill switches), segments,
feature flags and announcements.

Plans are not enforced in the product yet (billing isn't live); the matrix
here is the source of truth the enforcement will read.
"""
from __future__ import annotations

import csv
import io
import statistics
from collections import defaultdict
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from .. import models
from ..database import get_db
from ..services import admin_metrics as M
from ..services.admin_access import Staff, current_staff, log_admin, mask_email, require
from ..services.ai_meter import KILL_SWITCHES, forget_setting

router = APIRouter(prefix="/admin/v2", tags=["mission-control"])

PLANS = ["Early access", "Plus", "Team", "Business", "Enterprise"]


def _iso(dt):
    return dt.isoformat() + "Z" if isinstance(dt, datetime) else dt


def _get(db: Session, key: str, default):
    row = db.get(models.AdminSetting, key)
    return row.value if row and row.value is not None else default


def _put(db: Session, key: str, value, staff: Staff):
    row = db.get(models.AdminSetting, key)
    if row is None:
        row = models.AdminSetting(key=key)
        db.add(row)
    row.value, row.updated_by, row.updated_at = value, staff.email, datetime.utcnow()
    forget_setting(key)


# ============================================================ plans
DEFAULT_MATRIX = [
    # key, label, [EA, Plus, Team, Business, Enterprise], enforcement
    ("seats.min_max", "Seats (min / max)", ["1 / ∞", "1 / 1", "3 / 50", "10 / 500", "custom"], "hard"),
    ("chats.per_user_month", "AI chats per person per month", ["1000", "200", "500", "2000", "unlimited"], "soft"),
    ("sources.max", "Data sources", ["∞", "5", "25", "∞", "∞"], "hard"),
    ("sources.kinds", "Source kinds", ["all", "files + databases", "all", "all", "all + private link"], "hard"),
    ("warehouse.gib_day_user", "Warehouse scan per person per day (GiB)", ["50", "10", "50", "250", "custom"], "hard"),
    ("dashboards.max", "Dashboards", ["∞", "5", "50", "∞", "∞"], "soft"),
    ("share.private", "Password / email-only sharing", ["yes", "yes", "yes", "yes", "yes"], "hard"),
    ("share.custom_domain", "Custom domain for dashboards", ["yes", "—", "—", "yes", "yes"], "hard"),
    ("spaces.max", "Spaces", ["∞", "1", "10", "∞", "∞"], "soft"),
    ("ml.models", "ML models", ["∞", "3", "20", "∞", "∞"], "soft"),
    ("automations.max", "Automations", ["∞", "2", "20", "∞", "∞"], "soft"),
    ("automations.interval", "Fastest automation interval", ["15 min", "daily", "hourly", "15 min", "5 min"], "hard"),
    ("access.rules", "Row and column access rules", ["yes", "—", "yes", "yes", "yes"], "hard"),
    ("audit.retention_days", "Audit log retention (days)", ["90", "—", "30", "365", "2555"], "hard"),
    ("sso", "Single sign-on", ["—", "—", "Google", "Google + Microsoft", "SAML + SCIM"], "hard"),
    ("support.sla", "Support", ["community", "email 48h", "email 24h", "priority 4h", "named contact, 1h P1"], "hard"),
]
DEFAULT_CATALOG = {
    "Early access": {"monthly": 0, "annual": 0, "min_seats": 1, "visibility": "Sign-up default"},
    "Plus": {"monthly": 10, "annual": 100, "min_seats": 1, "visibility": "Hidden until launch"},
    "Team": {"monthly": 25, "annual": 250, "min_seats": 3, "visibility": "Hidden until launch"},
    "Business": {"monthly": 49, "annual": 490, "min_seats": 10, "visibility": "Hidden until launch"},
    "Enterprise": {"monthly": None, "annual": None, "min_seats": 50, "visibility": "Sales only", "assumed_mrr": 3000},
}


def _matrix(db: Session) -> list[dict]:
    saved = {r["key"]: r for r in _get(db, "plan_matrix", [])}
    out = []
    for key, label, vals, enf in DEFAULT_MATRIX:
        s = saved.get(key, {})
        # copy: set_cell edits row["values"] in place, which must never touch DEFAULT_MATRIX
        cur = list(s.get("values", vals))
        out.append({"key": key, "label": label, "values": cur, "enforce": s.get("enforce", enf),
                    "defaults": list(vals), "changed": [i for i, (a, b) in enumerate(zip(cur, vals)) if a != b]})
    return out


@router.get("/plans")
def plans(staff: Staff = Depends(require("metrics.read")), db: Session = Depends(get_db)):
    catalog = {**DEFAULT_CATALOG, **_get(db, "plan_catalog", {})}
    ws = M.workspace_rows(db)
    fits = defaultdict(int)
    for w in ws:
        if w["chats_30d"] or w["sources"]:
            fits[w["fit"]] += 1
    names = {w.id: w.name for w in db.query(models.Workspace).all()}
    ovs = db.query(models.EntitlementOverride).order_by(models.EntitlementOverride.created_at.desc()).all()
    now = datetime.utcnow()
    hist = db.query(models.AdminAuditEvent).filter(models.AdminAuditEvent.action.like("plans.%")).order_by(models.AdminAuditEvent.created_at.desc()).limit(15).all()
    return {
        "plans": PLANS, "matrix": _matrix(db), "catalog": catalog, "fits": fits, "billing_live": False,
        "overrides": [{"id": o.id, "workspace_id": o.workspace_id, "workspace": names.get(o.workspace_id, o.workspace_id), "key": o.key,
                       "value": o.value, "reason": o.reason, "requested_by": o.requested_by, "approved_by": o.approved_by,
                       "status": "expired" if (o.status == "active" and o.expires_at and o.expires_at < now) else o.status,
                       "expires_at": _iso(o.expires_at), "created_at": _iso(o.created_at)} for o in ovs],
        "history": [{"t": _iso(h.created_at), "by": h.staff_email, "text": h.summary} for h in hist],
    }


class CellIn(BaseModel):
    key: str
    plan: str
    value: str = Field(min_length=1, max_length=60)


@router.put("/plans/cell")
def set_cell(body: CellIn, request: Request, staff: Staff = Depends(require("plans.write")), db: Session = Depends(get_db)):
    if body.plan not in PLANS:
        raise HTTPException(400, "Unknown plan.")
    m = _matrix(db)
    row = next((r for r in m if r["key"] == body.key), None)
    if not row:
        raise HTTPException(400, "Unknown entitlement.")
    i = PLANS.index(body.plan)
    before = row["values"][i]
    row["values"][i] = body.value.strip()
    _put(db, "plan_matrix", [{"key": r["key"], "values": r["values"], "enforce": r["enforce"]} for r in m], staff)
    log_admin(db, staff, "plans.cell", target_type="plan", target_id=body.plan, summary=f"{body.plan} · {row['label']}: {before} → {body.value}",
              before={"value": before}, after={"value": body.value}, request=request)
    db.commit()
    return {"ok": True}


class EnforceIn(BaseModel):
    key: str
    enforce: str = Field(pattern="^(soft|hard)$")


@router.put("/plans/enforce")
def set_enforce(body: EnforceIn, request: Request, staff: Staff = Depends(require("plans.write")), db: Session = Depends(get_db)):
    m = _matrix(db)
    row = next((r for r in m if r["key"] == body.key), None)
    if not row:
        raise HTTPException(400, "Unknown entitlement.")
    row["enforce"] = body.enforce
    _put(db, "plan_matrix", [{"key": r["key"], "values": r["values"], "enforce": r["enforce"]} for r in m], staff)
    log_admin(db, staff, "plans.enforce", target_type="entitlement", target_id=body.key, summary=f"{row['label']} → {body.enforce} limit", request=request)
    db.commit()
    return {"ok": True}


class CatalogIn(BaseModel):
    plan: str
    monthly: float | None = Field(default=None, ge=0)
    annual: float | None = Field(default=None, ge=0)
    min_seats: int | None = Field(default=None, ge=1)


@router.put("/plans/catalog")
def set_catalog(body: CatalogIn, request: Request, staff: Staff = Depends(require("plans.write")), db: Session = Depends(get_db)):
    if body.plan not in PLANS:
        raise HTTPException(400, "Unknown plan.")
    cat = {**DEFAULT_CATALOG, **_get(db, "plan_catalog", {})}
    before = dict(cat[body.plan])
    for k in ("monthly", "annual", "min_seats"):
        v = getattr(body, k)
        if v is not None:
            cat[body.plan] = {**cat[body.plan], k: v}
    _put(db, "plan_catalog", cat, staff)
    log_admin(db, staff, "plans.price", target_type="plan", target_id=body.plan, summary=f"{body.plan} price/seats updated", before=before, after=cat[body.plan], request=request)
    db.commit()
    return {"ok": True}


_IMPACT_FIELDS = {"chats.per_user_month": "chats_per_user", "sources.max": "sources", "automations.max": "automations",
                  "ml.models": "ml_models", "seats.min_max": "members"}


@router.get("/plans/impact")
def impact(key: str, plan: str, value: str, staff: Staff = Depends(require("metrics.read")), db: Session = Depends(get_db)):
    field = _IMPACT_FIELDS.get(key)
    if not field:
        return {"supported": False}
    try:
        limit = float(value.split("/")[-1].strip().replace(",", ""))
    except ValueError:
        return {"supported": True, "limit": None, "over": 0, "total": 0, "names": []}
    ws = [w for w in M.workspace_rows(db) if w["fit"] == plan and (w["chats_30d"] or w["sources"])]
    over = [w for w in ws if (w[field] or 0) > limit]
    return {"supported": True, "limit": limit, "total": len(ws), "over": len(over),
            "names": [f"{w['name']} ({w[field]})" for w in sorted(over, key=lambda w: -(w[field] or 0))[:8]]}


class OverrideIn(BaseModel):
    workspace_id: str
    key: str
    value: str = Field(min_length=1, max_length=60)
    reason: str = Field(min_length=3, max_length=500)
    days: int = Field(default=30, ge=1, le=365)


@router.get("/workspaces/search")
def search_workspaces(q: str = "", staff: Staff = Depends(require("metrics.read")), db: Session = Depends(get_db)):
    ql = q.lower().strip()
    users = {u.id: u.email for u in db.query(models.User.id, models.User.email).all()}
    out = []
    for w in db.query(models.Workspace).limit(5000).all():
        owner = users.get(w.owner_id, "")
        if ql and ql not in (w.name or "").lower() and ql not in owner.lower():
            continue
        out.append({"id": w.id, "name": w.name, "owner_email": mask_email(owner, staff), "personal": bool(w.is_personal)})
        if len(out) >= 20:
            break
    return {"items": out}


@router.post("/plans/overrides")
def request_override(body: OverrideIn, request: Request, staff: Staff = Depends(require("overrides.request")), db: Session = Depends(get_db)):
    if body.key not in {k for k, _, _, _ in DEFAULT_MATRIX}:
        raise HTTPException(400, "Unknown entitlement.")
    if not db.get(models.Workspace, body.workspace_id):
        raise HTTPException(404, "Workspace not found.")
    o = models.EntitlementOverride(workspace_id=body.workspace_id, key=body.key, value=body.value, reason=body.reason,
                                   requested_by=staff.email, expires_at=datetime.utcnow() + timedelta(days=body.days),
                                   status="active" if staff.can("overrides.approve") else "pending",
                                   approved_by=staff.email if staff.can("overrides.approve") else None)
    db.add(o)
    log_admin(db, staff, "plans.override", target_type="workspace", target_id=body.workspace_id,
              summary=f"Override {body.key} = {body.value} ({o.status})", reason=body.reason, request=request)
    db.commit()
    return {"id": o.id, "status": o.status}


@router.post("/plans/overrides/{ov_id}/{action}")
def act_override(ov_id: str, action: str, request: Request, staff: Staff = Depends(current_staff), db: Session = Depends(get_db)):
    o = db.get(models.EntitlementOverride, ov_id)
    if not o:
        raise HTTPException(404, "Override not found.")
    if action == "approve":
        if not staff.can("overrides.approve"):
            raise HTTPException(403, "Only Finance or an Owner can approve overrides.")
        if o.requested_by == staff.email:
            raise HTTPException(400, "Someone else has to approve your own request.")
        o.status, o.approved_by = "active", staff.email
    elif action == "revoke":
        if not (staff.can("overrides.approve") or o.requested_by == staff.email):
            raise HTTPException(403, "You can't revoke this override.")
        o.status = "revoked"
    else:
        raise HTTPException(404, "Unknown action.")
    log_admin(db, staff, f"plans.override_{action}", target_type="workspace", target_id=o.workspace_id, summary=f"{action.title()}d override {o.key} = {o.value}", request=request)
    db.commit()
    return {"ok": True}


# ============================================================ pricing lab
@router.get("/pricing-lab")
def pricing_lab(staff: Staff = Depends(require("metrics.read")), db: Session = Depends(get_db)):
    catalog = {**DEFAULT_CATALOG, **_get(db, "plan_catalog", {})}
    ws = [w for w in M.workspace_rows(db) if w["chats_30d"] or w["sources"] or w["members"] > 1]
    dist = defaultdict(lambda: {"n": 0, "seats": 0, "mrr": 0.0})
    for w in ws:
        p = w["fit"]
        seats = max(w["members"], catalog[p].get("min_seats") or 1) if p != "Plus" else 1
        price = catalog[p].get("monthly")
        mrr = (catalog[p].get("assumed_mrr") or 0) if price is None else price * seats
        d = dist[p]
        d["n"] += 1
        d["seats"] += seats
        d["mrr"] += mrr
    rows = M.user_rows(db)
    active = [r for r in rows if r["chats_30d"] > 0]
    caps = []
    for cap in (100, 150, 200, 300, 500):
        over = sum(1 for r in active if r["chats_30d"] > cap)
        caps.append({"cap": cap, "over": over, "pct": round(over / len(active) * 100, 1) if active else 0})
    top = sorted(ws, key=lambda w: (-["Plus", "Team", "Business", "Enterprise"].index(w["fit"]), -w["chats_30d"]))[:40]
    return {
        "catalog": catalog, "workspaces_counted": len(ws), "active_people": len(active),
        "distribution": [{"plan": p, **{k: (round(v, 2) if isinstance(v, float) else v) for k, v in dist[p].items()}} for p in ["Plus", "Team", "Business", "Enterprise"]],
        "caps": caps,
        "top": [{"id": w["id"], "name": w["name"], "owner_email": mask_email(w["owner_email"], staff), "fit": w["fit"], "members": w["members"],
                 "chats_30d": w["chats_30d"], "chats_per_user": w["chats_per_user"], "sources": w["sources"], "warehouse": w["warehouse"]} for w in top],
    }


# ============================================================ product
@router.get("/product")
def product(cohort: str | None = None, seg: str = Query("all", pattern="^(all|corporate|freemail)$"),
            staff: Staff = Depends(require("metrics.read")), db: Session = Depends(get_db)):
    now = datetime.utcnow()
    users = db.query(models.User).all()
    months = sorted({u.created_at.strftime("%Y-%m") for u in users if u.created_at}, reverse=True)
    cohort = cohort if cohort in months else (months[0] if months else now.strftime("%Y-%m"))

    def in_seg(u):
        return seg == "all" or (seg == "corporate") == M.is_corporate(u.email)

    co = [u for u in users if u.created_at and u.created_at.strftime("%Y-%m") == cohort and in_seg(u)]
    ids = {u.id for u in co}
    has_source = {o for (o,) in db.query(models.DataSource.owner_id).distinct().all()}
    first_answer = dict(
        db.query(models.Conversation.owner_id, func.min(models.Message.created_at))
        .join(models.Message, models.Message.conversation_id == models.Conversation.id)
        .filter(models.Message.role == "assistant", models.Message.action.in_(("analyze", "transform")))
        .group_by(models.Conversation.owner_id).all()
    )
    has_dash = {o for (o,) in db.query(models.Dashboard.owner_id).distinct().all()}
    team_owner = set()
    counts = defaultdict(int)
    for (wid,) in db.query(models.WorkspaceMember.workspace_id).all():
        counts[wid] += 1
    for w in db.query(models.Workspace).all():
        if counts[w.id] > 1:
            team_owner.add(w.owner_id)
    published = {o for (o,) in db.query(models.Dashboard.owner_id).join(models.DashboardShare, models.DashboardShare.dashboard_id == models.Dashboard.id)
                 .filter(models.DashboardShare.published_at.isnot(None)).distinct().all()}
    steps = [("Signed up", ids), ("Connected a source", ids & has_source), ("First proven answer", ids & set(first_answer)),
             ("Saved a dashboard", ids & has_dash), ("Invited a teammate", ids & team_owner), ("Published a dashboard", ids & published)]
    funnel = [{"k": k, "n": len(s)} for k, s in steps]
    ttfa = [(first_answer[u.id] - u.created_at).total_seconds() / 60 for u in co if u.id in first_answer and first_answer[u.id] >= u.created_at]

    # weekly retention: last 8 signup weeks, share with a question in week N
    week0 = (now - timedelta(days=now.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
    msgs = defaultdict(set)
    for owner, created in (db.query(models.Conversation.owner_id, models.Message.created_at)
                           .join(models.Message, models.Message.conversation_id == models.Conversation.id)
                           .filter(models.Message.role == "user", models.Message.created_at >= week0 - timedelta(weeks=9)).all()):
        msgs[owner].add(((created - week0).days // 7))
    heat = []
    for i in range(8, 0, -1):
        start = week0 - timedelta(weeks=i)
        group = [u for u in users if u.created_at and start <= u.created_at < start + timedelta(weeks=1) and in_seg(u)]
        cells = []
        for n in range(0, 9):
            wk = -i + n
            if wk > 0:
                cells.append(None)
                continue
            act = sum(1 for u in group if wk in msgs.get(u.id, set()))
            cells.append(round(act / len(group) * 100) if group else None)
        heat.append({"week": start.date().isoformat(), "n": len(group), "cells": cells})

    since30 = now - timedelta(days=30)
    active_ids = {o for (o,) in db.query(models.Conversation.owner_id).join(models.Message, models.Message.conversation_id == models.Conversation.id)
                  .filter(models.Message.role == "user", models.Message.created_at >= since30).distinct().all()}
    def share(owner_col):
        owners = {o for (o,) in db.query(owner_col).distinct().all()}
        return round(len(owners & active_ids) / len(active_ids) * 100, 1) if active_ids else 0
    adoption = [
        {"k": "Ask anything", "v": 100.0 if active_ids else 0},
        {"k": "Dashboards", "v": share(models.Dashboard.owner_id)},
        {"k": "Published dashboards", "v": round(len(published & active_ids) / len(active_ids) * 100, 1) if active_ids else 0},
        {"k": "Spaces", "v": share(models.Space.owner_id)},
        {"k": "Automations", "v": share(models.Automation.owner_id)},
        {"k": "ML Studio", "v": share(models.MLModel.owner_id)},
        {"k": "Pipelines", "v": share(models.Pipeline.owner_id)},
        {"k": "Quality checks", "v": share(models.DataQualityRule.owner_id)},
        {"k": "Metric definitions", "v": share(models.MetricDefinition.owner_id) if hasattr(models.MetricDefinition, "owner_id") else 0},
    ]
    a30 = db.query(models.Message).filter(models.Message.role == "assistant", models.Message.created_at >= since30)
    total_a = a30.count()
    clar = a30.filter(models.Message.needs_clarification.is_(True)).count()
    analyses = a30.filter(models.Message.action.in_(("analyze", "transform")))
    n_an = analyses.count()
    verified = analyses.filter(models.Message.verified_count > 0).count()
    pushed = analyses.filter(models.Message.used_pushdown.is_(True)).count()
    lat = [d for (d,) in db.query(models.Message.duration_ms).filter(models.Message.role == "assistant", models.Message.created_at >= since30,
                                                                    models.Message.duration_ms.isnot(None)).all()]
    lat.sort()
    pr = db.query(models.ProjectRun).filter(models.ProjectRun.created_at >= since30).all()
    pr_done = [r for r in pr if r.status in ("done", "failed", "stopped")]
    quality = [
        {"k": "Clarification rate", "v": f"{round(clar / total_a * 100, 1)}%" if total_a else "—", "sub": "answers that asked a question back"},
        {"k": "Double-check rate", "v": f"{round(verified / n_an * 100, 1)}%" if n_an else "—", "sub": "analyses people chose to verify"},
        {"k": "Run at the source", "v": f"{round(pushed / n_an * 100, 1)}%" if n_an else "—", "sub": "analyses pushed down to a warehouse"},
        {"k": "Answer time p50", "v": f"{lat[len(lat) // 2] / 1000:.1f} s" if lat else "—", "sub": (f"p95 {lat[int(len(lat) * 0.95) - 1] / 1000:.1f} s" if len(lat) >= 20 else "per answer")},
        {"k": "Project runs finished", "v": f"{round(sum(1 for r in pr_done if r.status == 'done') / len(pr_done) * 100, 1)}%" if pr_done else "—", "sub": f"{len(pr)} runs in 30 days"},
        {"k": "Answers in 30 days", "v": f"{total_a:,}", "sub": f"{n_an:,} analyses"},
    ]
    kinds = defaultdict(lambda: [0, 0])
    for k, err in db.query(models.DataSource.kind, models.DataSource.sync_error).filter(models.DataSource.created_at >= now - timedelta(days=90)).all():
        kinds[k][0] += 1
        if err:
            kinds[k][1] += 1
    tot = sum(v[0] for v in kinds.values()) or 1
    connectors = [{"kind": k, "n": v[0], "share": round(v[0] / tot * 100, 1), "ok": round((1 - v[1] / v[0]) * 100) if v[0] else None}
                  for k, v in sorted(kinds.items(), key=lambda kv: -kv[1][0])][:12]
    return {"cohort": cohort, "cohorts": months[:12], "seg": seg, "funnel": funnel,
            "ttfa_median_min": round(statistics.median(ttfa), 1) if ttfa else None,
            "heat": heat, "adoption": adoption, "active_30d": len(active_ids), "quality": quality, "connectors": connectors}


# ============================================================ AI usage
@router.get("/ai")
def ai_usage(days: int = Query(30, ge=1, le=90), staff: Staff = Depends(require("metrics.read")), db: Session = Depends(get_db)):
    now = datetime.utcnow()
    since = now - timedelta(days=days)
    calls = db.query(models.AICall).filter(models.AICall.created_at >= since).all()
    cost = sum(c.cost_usd or 0 for c in calls)
    tin = sum(c.input_tokens or 0 for c in calls)
    tout = sum(c.output_tokens or 0 for c in calls)
    errs = sum(1 for c in calls if c.status != "ok")
    lat = sorted(c.latency_ms for c in calls if c.latency_ms is not None)
    chats = db.query(func.count(models.Message.id)).filter(models.Message.role == "user", models.Message.created_at >= since).scalar() or 0
    daily = defaultdict(lambda: {"cost": 0.0, "calls": 0})
    for c in calls:
        d = daily[c.created_at.date().isoformat()]
        d["cost"] += c.cost_usd or 0
        d["calls"] += 1
    series = [{"date": (now - timedelta(days=i)).date().isoformat(), **daily[(now - timedelta(days=i)).date().isoformat()]} for i in range(days - 1, -1, -1)]
    for s in series:
        s["cost"] = round(s["cost"], 4)

    def group(attr):
        g = defaultdict(lambda: {"calls": 0, "cost": 0.0, "tokens": 0})
        for c in calls:
            x = g[getattr(c, attr) or "—"]
            x["calls"] += 1
            x["cost"] += c.cost_usd or 0
            x["tokens"] += (c.input_tokens or 0) + (c.output_tokens or 0)
        return [{"k": k, **{kk: (round(vv, 4) if isinstance(vv, float) else vv) for kk, vv in v.items()}} for k, v in sorted(g.items(), key=lambda kv: -kv[1]["cost"])]

    users = {u.id: u for u in db.query(models.User).all()}
    rows = {r["id"]: r for r in M.user_rows(db)}
    per_user = defaultdict(lambda: {"calls": 0, "cost": 0.0})
    for c in calls:
        if c.user_id:
            per_user[c.user_id]["calls"] += 1
            per_user[c.user_id]["cost"] += c.cost_usd or 0
    caps = _get(db, "ai_caps", {})
    top = []
    for uid, v in sorted(per_user.items(), key=lambda kv: -kv[1]["cost"])[:25]:
        u = users.get(uid)
        r = rows.get(uid, {})
        top.append({"user_id": uid, "email": mask_email(u.email if u else uid, staff), "plan": r.get("plan", "Early access"),
                    "chats_30d": r.get("chats_30d", 0), "calls": v["calls"], "cost": round(v["cost"], 4),
                    "cap": caps.get(uid)})
    for uid, cap in caps.items():
        if uid not in per_user and users.get(uid):
            top.append({"user_id": uid, "email": mask_email(users[uid].email, staff), "plan": rows.get(uid, {}).get("plan", "Early access"),
                        "chats_30d": rows.get(uid, {}).get("chats_30d", 0), "calls": 0, "cost": 0.0, "cap": cap})
    first = db.query(func.min(models.AICall.created_at)).scalar()
    return {
        "days": days, "metering_since": _iso(first),
        "kpis": {"calls": len(calls), "cost": round(cost, 4), "tokens_in": tin, "tokens_out": tout, "chats": chats,
                 "cost_per_chat": round(cost / chats, 5) if chats else None, "error_rate": round(errs / len(calls) * 100, 2) if calls else None,
                 "p50_ms": lat[len(lat) // 2] if lat else None, "p95_ms": lat[min(len(lat) - 1, -(-len(lat) * 95 // 100) - 1)] if lat else None},
        "series": series, "by_model": group("model"), "by_feature": group("feature"), "top_users": top,
        "kill_switches": [{"key": k, "label": lbl, "paused": bool(_get(db, "kill_switches", {}).get(k))} for k, (_, lbl) in KILL_SWITCHES.items()],
        "prices_note": "Cost is estimated from public list prices per million tokens.",
    }


class CapIn(BaseModel):
    user_id: str
    usd: float | None = Field(default=None, ge=0)


@router.put("/ai/caps")
def set_cap(body: CapIn, request: Request, staff: Staff = Depends(require("ai.write")), db: Session = Depends(get_db)):
    u = db.get(models.User, body.user_id)
    if not u:
        raise HTTPException(404, "Person not found.")
    caps = dict(_get(db, "ai_caps", {}))
    if body.usd in (None, 0):
        caps.pop(body.user_id, None)
    else:
        caps[body.user_id] = body.usd
    _put(db, "ai_caps", caps, staff)
    log_admin(db, staff, "ai.cap", target_type="user", target_id=u.id, summary=f"AI cap for {u.email}: {('$' + str(body.usd)) if body.usd else 'removed'}", request=request)
    db.commit()
    return {"ok": True}


class KillIn(BaseModel):
    key: str
    paused: bool


@router.put("/kill-switches")
def set_kill(body: KillIn, request: Request, staff: Staff = Depends(require("ai.write")), db: Session = Depends(get_db)):
    if body.key not in KILL_SWITCHES:
        raise HTTPException(400, "Unknown feature.")
    ks = dict(_get(db, "kill_switches", {}))
    ks[body.key] = body.paused
    _put(db, "kill_switches", ks, staff)
    log_admin(db, staff, "ai.kill_switch", target_type="feature", target_id=body.key,
              summary=f"{KILL_SWITCHES[body.key][1]} {'paused' if body.paused else 'resumed'}", request=request)
    db.commit()
    return {"ok": True}


# ============================================================ segments
TEMPLATES = [
    {"name": "Power users", "rules": [{"field": "chats_30d", "op": "gte", "value": 30}]},
    {"name": "Signed up, no question yet", "rules": [{"field": "chats_total", "op": "eq", "value": 0}]},
    {"name": "Gone quiet (14+ days)", "rules": [{"field": "chats_total", "op": "gt", "value": 0}, {"field": "last_active_days", "op": "gte", "value": 14}]},
    {"name": "Company domain with a warehouse", "rules": [{"field": "corporate", "op": "is_true", "value": True}, {"field": "warehouse", "op": "is_true", "value": True}]},
    {"name": "Asks but never saved a dashboard", "rules": [{"field": "chats_30d", "op": "gte", "value": 5}, {"field": "dashboards", "op": "eq", "value": 0}]},
]


class SegmentIn(BaseModel):
    name: str = Field(default="", max_length=120)
    rules: list[dict] = Field(default_factory=list)


def _preview(rows, rules, staff: Staff, sample: int = 25):
    hit = M.segment_members(rows, rules)
    accounts = {r["account"] for r in hit}
    hit.sort(key=lambda r: -r["chats_30d"])
    return {"count": len(hit), "accounts": len(accounts), "of": len(rows),
            "corporate": sum(1 for r in hit if r["corporate"]),
            "sample": [{"id": r["id"], "email": mask_email(r["email"], staff), "name": r["name"], "chats_30d": r["chats_30d"],
                        "lifecycle": r["lifecycle"], "last_active": _iso(r["last_active"]), "sources": r["sources"]} for r in hit[:sample]]}


@router.get("/segments")
def segments(staff: Staff = Depends(require("metrics.read")), db: Session = Depends(get_db)):
    rows = M.user_rows(db)
    saved = db.query(models.Segment).order_by(models.Segment.created_at.desc()).all()
    return {"fields": [{"key": k, "label": l, "type": t} for k, l, t in M.SEGMENT_FIELDS], "templates": TEMPLATES,
            "saved": [{"id": s.id, "name": s.name, "rules": s.rules, "count": len(M.segment_members(rows, s.rules)),
                       "created_by": s.created_by, "created_at": _iso(s.created_at)} for s in saved]}


@router.post("/segments/preview")
def preview(body: SegmentIn, staff: Staff = Depends(require("metrics.read")), db: Session = Depends(get_db)):
    return _preview(M.user_rows(db), body.rules, staff)


@router.post("/segments")
def save_segment(body: SegmentIn, request: Request, staff: Staff = Depends(require("segments.write")), db: Session = Depends(get_db)):
    if not body.name.strip():
        raise HTTPException(400, "Name the segment.")
    count = len(M.segment_members(M.user_rows(db), body.rules))
    s = models.Segment(name=body.name.strip(), rules=body.rules, created_by=staff.email, last_count=count)
    db.add(s)
    log_admin(db, staff, "segment.save", target_type="segment", summary=f"Saved segment “{s.name}” ({count} people)", request=request)
    db.commit()
    return {"id": s.id, "count": count}


@router.delete("/segments/{seg_id}")
def delete_segment(seg_id: str, request: Request, staff: Staff = Depends(require("segments.write")), db: Session = Depends(get_db)):
    s = db.get(models.Segment, seg_id)
    if not s:
        raise HTTPException(404, "Segment not found.")
    log_admin(db, staff, "segment.delete", target_type="segment", target_id=s.id, summary=f"Deleted segment “{s.name}”", request=request)
    db.delete(s)
    db.commit()
    return {"ok": True}


@router.get("/segments/{seg_id}/export.csv")
def export_segment(seg_id: str, staff: Staff = Depends(require("metrics.read")), db: Session = Depends(get_db)):
    s = db.get(models.Segment, seg_id)
    if not s:
        raise HTTPException(404, "Segment not found.")
    hit = M.segment_members(M.user_rows(db), s.rules)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["email", "name", "company", "lifecycle", "chats_30d", "sources", "dashboards", "last_active"])
    for r in hit:
        w.writerow([mask_email(r["email"], staff), r["name"], r["company"], r["lifecycle"], r["chats_30d"], r["sources"], r["dashboards"], _iso(r["last_active"])])
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv", headers={"Content-Disposition": f"attachment; filename=segment-{seg_id[:8]}.csv"})


# ============================================================ flags
class FlagIn(BaseModel):
    key: str = Field(min_length=2, max_length=60, pattern=r"^[a-z0-9_.\-]+$")
    name: str = Field(min_length=2, max_length=120)
    description: str | None = None


class FlagPatch(BaseModel):
    name: str | None = None
    description: str | None = None
    enabled: bool | None = None
    rollout_pct: int | None = Field(default=None, ge=0, le=100)
    staff_only: bool | None = None
    segment_id: str | None = None


def _flag_out(f: models.FeatureFlag, total: int, seg_counts: dict) -> dict:
    base = seg_counts.get(f.segment_id, total) if f.segment_id else total
    exposed = 0 if not f.enabled else round(base * (f.rollout_pct or 0) / 100)
    return {"key": f.key, "name": f.name, "description": f.description, "enabled": f.enabled, "rollout_pct": f.rollout_pct,
            "staff_only": f.staff_only, "segment_id": f.segment_id, "owner_email": f.owner_email, "updated_at": _iso(f.updated_at),
            "exposed_estimate": exposed if not f.staff_only else None}


@router.get("/flags")
def flags(staff: Staff = Depends(require("metrics.read")), db: Session = Depends(get_db)):
    rows = M.user_rows(db)
    segs = db.query(models.Segment).all()
    seg_counts = {s.id: len(M.segment_members(rows, s.rules)) for s in segs}
    return {"flags": [_flag_out(f, len(rows), seg_counts) for f in db.query(models.FeatureFlag).order_by(models.FeatureFlag.key).all()],
            "segments": [{"id": s.id, "name": s.name, "count": seg_counts[s.id]} for s in segs], "users": len(rows)}


@router.post("/flags")
def create_flag(body: FlagIn, request: Request, staff: Staff = Depends(require("flags.write")), db: Session = Depends(get_db)):
    if db.get(models.FeatureFlag, body.key):
        raise HTTPException(400, "A flag with that key exists.")
    f = models.FeatureFlag(key=body.key, name=body.name, description=body.description, owner_email=staff.email)
    db.add(f)
    log_admin(db, staff, "flag.create", target_type="flag", target_id=body.key, summary=f"Created flag {body.key}", request=request)
    db.commit()
    return {"ok": True}


@router.patch("/flags/{key}")
def update_flag(key: str, body: FlagPatch, request: Request, staff: Staff = Depends(require("flags.write")), db: Session = Depends(get_db)):
    f = db.get(models.FeatureFlag, key)
    if not f:
        raise HTTPException(404, "Flag not found.")
    data = body.model_dump(exclude_unset=True)
    before = {k: getattr(f, k) for k in data}
    for k, v in data.items():
        setattr(f, k, v)
    f.updated_at = datetime.utcnow()
    log_admin(db, staff, "flag.update", target_type="flag", target_id=key, summary=f"{key}: " + ", ".join(f"{k} {before[k]} → {v}" for k, v in data.items()),
              before=before, after=data, request=request)
    db.commit()
    return {"ok": True}


@router.delete("/flags/{key}")
def delete_flag(key: str, request: Request, staff: Staff = Depends(require("flags.write")), db: Session = Depends(get_db)):
    f = db.get(models.FeatureFlag, key)
    if not f:
        raise HTTPException(404, "Flag not found.")
    db.delete(f)
    log_admin(db, staff, "flag.delete", target_type="flag", target_id=key, summary=f"Deleted flag {key}", request=request)
    db.commit()
    return {"ok": True}


# ============================================================ announcements
class AnnIn(BaseModel):
    kind: str = Field(default="banner", pattern="^(banner|modal)$")
    title: str = Field(min_length=2, max_length=140)
    body: str | None = Field(default=None, max_length=600)
    cta_label: str | None = Field(default=None, max_length=40)
    cta_url: str | None = Field(default=None, max_length=300)
    segment_id: str | None = None
    status: str = Field(default="draft", pattern="^(draft|live|ended)$")


@router.get("/announcements")
def announcements(staff: Staff = Depends(require("metrics.read")), db: Session = Depends(get_db)):
    rows = M.user_rows(db)
    segs = {s.id: s for s in db.query(models.Segment).all()}
    out = []
    for a in db.query(models.Announcement).order_by(models.Announcement.created_at.desc()).all():
        rec = db.query(models.AnnouncementReceipt).filter(models.AnnouncementReceipt.announcement_id == a.id).all()
        aud = len(M.segment_members(rows, segs[a.segment_id].rules)) if a.segment_id in segs else len(rows)
        out.append({"id": a.id, "kind": a.kind, "title": a.title, "body": a.body, "cta_label": a.cta_label, "cta_url": a.cta_url,
                    "segment_id": a.segment_id, "segment": segs[a.segment_id].name if a.segment_id in segs else "Everyone",
                    "status": a.status, "audience": aud, "created_by": a.created_by, "created_at": _iso(a.created_at),
                    "starts_at": _iso(a.starts_at), "ends_at": _iso(a.ends_at),
                    "seen": sum(1 for r in rec if r.seen_at), "clicked": sum(1 for r in rec if r.clicked_at),
                    "dismissed": sum(1 for r in rec if r.dismissed_at)})
    return {"announcements": out, "segments": [{"id": s.id, "name": s.name} for s in segs.values()]}


@router.post("/announcements")
def create_announcement(body: AnnIn, request: Request, staff: Staff = Depends(require("announce.write")), db: Session = Depends(get_db)):
    if body.cta_url and not (body.cta_url.startswith("/") or body.cta_url.startswith("https://")):
        raise HTTPException(400, "Links must start with / or https://")
    a = models.Announcement(**body.model_dump(), created_by=staff.email)
    if a.status == "live":
        a.starts_at = datetime.utcnow()
    db.add(a)
    log_admin(db, staff, "announce.create", target_type="announcement", summary=f"{a.status.title()} {a.kind}: {a.title}", request=request)
    db.commit()
    return {"id": a.id}


class AnnPatch(BaseModel):
    status: str | None = Field(default=None, pattern="^(draft|live|ended)$")
    title: str | None = None
    body: str | None = None
    cta_label: str | None = None
    cta_url: str | None = None
    segment_id: str | None = None


@router.patch("/announcements/{ann_id}")
def update_announcement(ann_id: str, body: AnnPatch, request: Request, staff: Staff = Depends(require("announce.write")), db: Session = Depends(get_db)):
    a = db.get(models.Announcement, ann_id)
    if not a:
        raise HTTPException(404, "Announcement not found.")
    data = body.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(a, k, v)
    if data.get("status") == "live":
        a.starts_at, a.ends_at = datetime.utcnow(), None
    if data.get("status") == "ended":
        a.ends_at = datetime.utcnow()
    log_admin(db, staff, "announce.update", target_type="announcement", target_id=a.id, summary=f"{a.title}: {', '.join(data)}", request=request)
    db.commit()
    return {"ok": True}
