"""
Mission Control, part 1 (2026-10-10): who you are, the command center,
Ask Admin, accounts, people, staff access, just-in-time grants and the
audit log. Every route needs a Mission Control role (services/admin_access).
"""
from __future__ import annotations

import csv
import io
import json
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
from ..services.admin_access import (
    PERMISSIONS, ROLE_PERMISSIONS, ROLES, Staff, current_staff, log_admin, mask_email, require, staff_role,
    _owner_emails,
)
from ..services.ai_meter import forget_setting

router = APIRouter(prefix="/admin/v2", tags=["mission-control"])

STAGE_PROB = {"new": 0.05, "qualified": 0.15, "demo": 0.30, "proposal": 0.60, "won": 1.0, "lost": 0.0}


def _setting(db: Session, key: str, default):
    row = db.get(models.AdminSetting, key)
    return row.value if row and row.value is not None else default


def _save_setting(db: Session, key: str, value, staff: Staff):
    row = db.get(models.AdminSetting, key)
    if row is None:
        row = models.AdminSetting(key=key)
        db.add(row)
    row.value = value
    row.updated_by = staff.email
    row.updated_at = datetime.utcnow()
    forget_setting(key)


def _iso(dt):
    return dt.isoformat() + "Z" if isinstance(dt, datetime) else dt


# ---------------------------------------------------------------- me
@router.get("/me")
def me(staff: Staff = Depends(current_staff), db: Session = Depends(get_db)):
    grants = (
        db.query(models.AccessRequest)
        .filter(models.AccessRequest.staff_email == staff.email, models.AccessRequest.status == "approved",
                models.AccessRequest.expires_at > datetime.utcnow()).all()
    )
    return {
        "email": staff.email, "name": staff.user.full_name or staff.email.split("@")[0], "role": staff.role,
        "role_label": ROLES[staff.role], "perms": sorted(staff.perms),
        "grants": [{"permission": g.permission, "expires_at": _iso(g.expires_at)} for g in grants],
        "roles": [{"key": k, "label": v} for k, v in ROLES.items()],
        "permissions": [{"key": k, "label": l, "roles": sorted(r for r in ROLES if k in ROLE_PERMISSIONS[r])} for k, l, _ in PERMISSIONS],
    }


# ---------------------------------------------------------------- overview
def _distinct_active(db: Session, since: datetime) -> int:
    return (
        db.query(func.count(func.distinct(models.Conversation.owner_id)))
        .join(models.Message, models.Message.conversation_id == models.Conversation.id)
        .filter(models.Message.role == "user", models.Message.created_at >= since).scalar() or 0
    )


def _daily(db: Session, col, since: datetime, *filters, join=None) -> dict:
    q = db.query(func.date(col), func.count())
    if join is not None:
        q = q.join(*join)
    q = q.filter(col >= since, *filters).group_by(func.date(col))
    return {str(d): n for d, n in q.all()}


def _activation(db: Session, now: datetime) -> dict:
    lo, hi = now - timedelta(days=37), now - timedelta(days=7)
    cohort = db.query(models.User.id, models.User.created_at).filter(models.User.created_at >= lo, models.User.created_at < hi).all()
    if not cohort:
        return {"rate": None, "cohort": 0, "activated": 0}
    first = dict(
        db.query(models.Conversation.owner_id, func.min(models.Message.created_at))
        .join(models.Message, models.Message.conversation_id == models.Conversation.id)
        .filter(models.Message.role == "assistant", models.Message.action.in_(("analyze", "transform")))
        .group_by(models.Conversation.owner_id).all()
    )
    act = sum(1 for uid, created in cohort if first.get(uid) and first[uid] <= created + timedelta(days=7))
    return {"rate": round(act / len(cohort) * 100, 1), "cohort": len(cohort), "activated": act}


def _sla_breaching(db: Session, now: datetime) -> list[models.SupportTicket]:
    return (
        db.query(models.SupportTicket)
        .filter(models.SupportTicket.status == "open", models.SupportTicket.first_responded_at.is_(None),
                models.SupportTicket.first_response_due_at.isnot(None),
                models.SupportTicket.first_response_due_at <= now + timedelta(hours=1)).all()
    )


def _ai_cost(db: Session, since: datetime) -> float:
    return float(db.query(func.coalesce(func.sum(models.AICall.cost_usd), 0.0)).filter(models.AICall.created_at >= since).scalar() or 0.0)


def _goals_default():
    return [
        {"key": "users", "label": "Total users", "target": 500},
        {"key": "wau", "label": "Weekly active users", "target": 150},
        {"key": "activation", "label": "Activation rate (%)", "target": 60},
        {"key": "corporate_accounts", "label": "Company accounts", "target": 50},
        {"key": "pipeline", "label": "Weighted pipeline ($)", "target": 100000},
        {"key": "csat", "label": "Support CSAT", "target": 4.5},
    ]


@router.get("/overview")
def overview(rng: str = Query("30d", alias="range", pattern="^(7d|30d|90d)$"), staff: Staff = Depends(require("metrics.read")),
             db: Session = Depends(get_db)):
    now = datetime.utcnow()
    days = {"7d": 7, "30d": 30, "90d": 90}[rng]
    since, prior = now - timedelta(days=days), now - timedelta(days=2 * days)

    users_total = db.query(func.count(models.User.id)).scalar() or 0
    new_p = db.query(func.count(models.User.id)).filter(models.User.created_at >= since).scalar() or 0
    new_prev = db.query(func.count(models.User.id)).filter(models.User.created_at >= prior, models.User.created_at < since).scalar() or 0
    chat_q = lambda a, b: (db.query(func.count(models.Message.id)).filter(models.Message.role == "user", models.Message.created_at >= a,
                                                                          models.Message.created_at < b).scalar() or 0)
    chats_p, chats_prev = chat_q(since, now + timedelta(seconds=1)), chat_q(prior, since)
    dau, wau, mau = (_distinct_active(db, now - timedelta(days=d)) for d in (1, 7, 30))
    act = _activation(db, now)
    rows = M.user_rows(db)
    accts = M.account_rows(db, rows)
    corporate_accts = [a for a in accts if not a["personal"]]

    open_t = db.query(models.SupportTicket).filter(models.SupportTicket.status.in_(("open", "pending"))).all()
    breaching = _sla_breaching(db, now)
    csat_vals = [t.csat for t in db.query(models.SupportTicket).filter(models.SupportTicket.csat.isnot(None),
                                                                       models.SupportTicket.solved_at >= now - timedelta(days=90)).all()]
    csat = round(sum(csat_vals) / len(csat_vals), 2) if csat_vals else None
    deals = db.query(models.CrmDeal).all()
    weighted = sum((d.amount or 0) * STAGE_PROB.get(d.stage, 0) for d in deals if d.stage not in ("won", "lost"))
    won_q = sum(d.amount or 0 for d in deals if d.stage == "won")
    demo_new = db.query(func.count(models.DemoRequest.id)).filter(models.DemoRequest.status == "new").scalar() or 0

    cost_p, cost_prev = _ai_cost(db, since), float(
        db.query(func.coalesce(func.sum(models.AICall.cost_usd), 0.0)).filter(models.AICall.created_at >= prior, models.AICall.created_at < since).scalar() or 0)
    calls_p = db.query(func.count(models.AICall.id)).filter(models.AICall.created_at >= since).scalar() or 0
    first_call = db.query(func.min(models.AICall.created_at)).scalar()

    failing_src = db.query(models.DataSource).filter(models.DataSource.sync_error.isnot(None)).all()
    day_ago = now - timedelta(days=1)
    run_stats = {}
    for label, model in (("Dashboard refreshes", models.JobRun), ("Pipelines", models.PipelineRun),
                         ("Automations", models.AutomationRun), ("Project runs", models.ProjectRun)):
        total = db.query(func.count(model.id)).filter(model.started_at >= day_ago).scalar() or 0
        failed = db.query(func.count(model.id)).filter(model.started_at >= day_ago, model.status.in_(("failed", "error"))).scalar() or 0
        run_stats[label] = (total, failed)
    runs_total = sum(t for t, _ in run_stats.values())
    runs_failed = sum(f for _, f in run_stats.values())

    def delta(cur, prev):
        if not prev:
            return None
        return round((cur - prev) / prev * 100, 1)

    kpis = [
        {"key": "users", "label": "Users", "value": users_total, "sub": f"+{new_p} in {rng}", "delta": delta(new_p, new_prev), "href": "people"},
        {"key": "wau", "label": "Weekly active users", "value": wau, "sub": f"DAU {dau} · MAU {mau}" + (f" · stickiness {round(dau / mau * 100, 1)}%" if mau else ""), "href": "product"},
        {"key": "chats", "label": f"Questions asked · {rng}", "value": chats_p, "sub": f"{round(chats_p / max(1, wau), 1)} per weekly active user", "delta": delta(chats_p, chats_prev), "href": "product"},
        {"key": "activation", "label": "Activation · 30-day cohort", "value": (f"{act['rate']}%" if act["rate"] is not None else "—"), "sub": f"{act['activated']} of {act['cohort']} got a proven answer in 7 days", "href": "product"},
        {"key": "accounts", "label": "Company accounts", "value": len(corporate_accts), "sub": f"{len(accts) - len(corporate_accts)} personal · all on early access", "href": "accounts"},
        {"key": "support", "label": "Open tickets", "value": len(open_t), "sub": f"{len(breaching)} near or past SLA" + (f" · CSAT {csat}" if csat else ""), "href": "support", "warn": bool(breaching)},
        {"key": "ai", "label": f"AI cost · {rng}", "value": f"${cost_p:,.2f}", "sub": (f"${cost_p / calls_p:,.4f} per model call" if calls_p else "metering started " + (first_call.strftime("%d %b") if first_call else "with this release")), "delta": delta(cost_p, cost_prev), "href": "ai", "estimate": True},
        {"key": "pipeline", "label": "Weighted pipeline", "value": f"${weighted:,.0f}", "sub": f"{sum(1 for d in deals if d.stage not in ('won', 'lost'))} open deals · ${won_q:,.0f} won", "href": "crm"},
    ]

    # daily series
    sig = _daily(db, models.User.created_at, since)
    ch = _daily(db, models.Message.created_at, since, models.Message.role == "user")
    au = dict(
        (str(d), n) for d, n in
        db.query(func.date(models.Message.created_at), func.count(func.distinct(models.Conversation.owner_id)))
        .join(models.Conversation, models.Conversation.id == models.Message.conversation_id)
        .filter(models.Message.role == "user", models.Message.created_at >= since)
        .group_by(func.date(models.Message.created_at)).all()
    )
    series = []
    for i in range(days, -1, -1):
        d = (now - timedelta(days=i)).date().isoformat()
        series.append({"date": d, "signups": sig.get(d, 0), "chats": ch.get(d, 0), "active": au.get(d, 0)})

    # alerts
    alerts = []
    if failing_src:
        top = failing_src[0]
        alerts.append({"level": "warn", "kind": "SYNC FAILING", "text": f"{len(failing_src)} data source(s) failing to sync — e.g. {top.name} ({top.kind}): {(top.sync_error or '')[:90]}", "href": "health", "cta": "Open system health"})
    for t in breaching[:2]:
        alerts.append({"level": "danger", "kind": f"SLA · {t.priority}", "text": f"#{t.number} {t.subject} — first response due {t.first_response_due_at.strftime('%H:%M')} UTC", "href": f"support?t={t.id}", "cta": "Take the ticket"})
    y_cost = _ai_cost(db, now - timedelta(days=1))
    wk_cost = _ai_cost(db, now - timedelta(days=8)) - y_cost
    if wk_cost > 0 and y_cost > 1 and y_cost > 1.3 * (wk_cost / 7):
        alerts.append({"level": "warn", "kind": "COST ANOMALY", "text": f"AI cost ${y_cost:,.2f} in the last 24h vs ${wk_cost / 7:,.2f} daily average (+{round((y_cost / (wk_cost / 7) - 1) * 100)}%).", "href": "ai", "cta": "See the breakdown"})
    locked = sum(1 for r in rows if r["status"] == "locked")
    if locked:
        alerts.append({"level": "warn", "kind": "SIGN-IN", "text": f"{locked} account(s) locked after failed sign-ins right now.", "href": "people?status=locked", "cta": "Review"})
    if demo_new:
        alerts.append({"level": "info", "kind": "ENTERPRISE", "text": f"{demo_new} new demo request(s) waiting for an owner.", "href": "crm?view=leads", "cta": "Open leads"})

    # live activity
    feed = []
    for u in db.query(models.User).order_by(models.User.created_at.desc()).limit(8).all():
        feed.append({"t": _iso(u.created_at), "kind": "signup", "text": f"{mask_email(u.email, staff)} signed up" + (f" ({u.company})" if u.company else "")})
    for d in db.query(models.DataSource).order_by(models.DataSource.created_at.desc()).limit(6).all():
        feed.append({"t": _iso(d.created_at), "kind": "source", "text": f"New {d.kind} source “{d.name}”"})
    for s_ in (db.query(models.DashboardShare, models.Dashboard).join(models.Dashboard, models.Dashboard.id == models.DashboardShare.dashboard_id)
               .filter(models.DashboardShare.published_at.isnot(None)).order_by(models.DashboardShare.published_at.desc()).limit(5).all()):
        feed.append({"t": _iso(s_[0].published_at), "kind": "publish", "text": f"Dashboard “{s_[1].name}” published"})
    for r in db.query(models.DemoRequest).order_by(models.DemoRequest.created_at.desc()).limit(5).all():
        feed.append({"t": _iso(r.created_at), "kind": "demo", "text": f"Demo request from {r.company or r.name} ({r.team_size or 'team size n/a'})"})
    feed.sort(key=lambda x: x["t"] or "", reverse=True)

    # accounts to call
    calls = []
    for a in sorted(accts, key=lambda a: (-a["users"], a["health"])):
        if a["chats_total"] == 0:
            continue
        if a["health"] < 40 and (a["users"] >= 2 or not a["personal"]):
            calls.append({**_acct_brief(a), "signal": _risk_signal(a), "action": "Save: reach out and re-onboard", "tone": "risk"})
        elif a["fit"] in ("Team", "Business", "Enterprise") and a["chats_7d"] > 0:
            calls.append({**_acct_brief(a), "signal": f"Usage fits {a['fit']} today", "action": f"Expand: early-access → {a['fit']} conversation", "tone": "grow"})
        if len(calls) >= 8:
            break

    # goals
    goals_cfg = _setting(db, "goals", _goals_default())
    current = {"users": users_total, "wau": wau, "activation": act["rate"] or 0, "corporate_accounts": len(corporate_accts),
               "pipeline": round(weighted), "csat": csat or 0}
    q_start = datetime(now.year, 3 * ((now.month - 1) // 3) + 1, 1)
    q_end = datetime(now.year + (1 if q_start.month == 10 else 0), 1 if q_start.month == 10 else q_start.month + 3, 1)
    elapsed = round((now - q_start) / (q_end - q_start) * 100)
    goals = []
    for g in goals_cfg:
        cur = current.get(g["key"], 0)
        pct = round(min(100.0, cur / g["target"] * 100), 1) if g.get("target") else 0
        goals.append({**g, "current": cur, "pct": pct, "status": "met" if pct >= 100 else ("on track" if pct >= elapsed else "behind")})

    return {
        "generated_at": _iso(now), "range": rng, "kpis": kpis, "series": series, "alerts": alerts, "feed": feed[:14],
        "accounts_to_call": calls, "goals": goals, "quarter_elapsed": elapsed,
        "platform": {"runs_total": runs_total, "runs_failed": runs_failed,
                     "success": round((1 - runs_failed / runs_total) * 100, 1) if runs_total else None,
                     "failing_sources": len(failing_src)},
        "support": {"open": len(open_t), "by_priority": {p: sum(1 for t in open_t if t.priority == p) for p in ("P1", "P2", "P3", "P4")},
                    "breaching": len(breaching), "csat": csat},
        "crm": {"weighted": round(weighted), "demo_new": demo_new, "open_deals": sum(1 for d in deals if d.stage not in ("won", "lost"))},
        "billing_live": False,
    }


def _acct_brief(a: dict) -> dict:
    return {"key": a["key"], "name": a["name"], "users": a["users"], "health": a["health"], "band": a["health_band"],
            "fit": a["fit"], "chats_30d": a["chats_30d"], "plan": a["plan"]}


def _risk_signal(a: dict) -> str:
    if a["chats_7d"] == 0 and a["chats_30d"] > 0:
        return "No questions in the last 7 days"
    if a["open_tickets"]:
        return f"{a['open_tickets']} open ticket(s)"
    if a["active_users_30d"] < a["users"] / 2:
        return f"Only {a['active_users_30d']} of {a['users']} people active"
    return "Usage falling"


# ---------------------------------------------------------------- goals
class GoalsIn(BaseModel):
    goals: list[dict]


@router.put("/goals")
def save_goals(body: GoalsIn, request: Request, staff: Staff = Depends(current_staff), db: Session = Depends(get_db)):
    if not (staff.can("staff.manage") or staff.can("plans.write")):
        raise HTTPException(403, "Only Owners, Admins and Finance can change goals.")
    clean = []
    for g in body.goals:
        if g.get("key") and g.get("label") and isinstance(g.get("target"), (int, float)) and g["target"] > 0:
            clean.append({"key": g["key"], "label": g["label"], "target": g["target"]})
    before = _setting(db, "goals", _goals_default())
    _save_setting(db, "goals", clean, staff)
    log_admin(db, staff, "goals.update", target_type="settings", target_id="goals", summary="Updated quarterly goals",
              before=before, after=clean, request=request)
    db.commit()
    return {"goals": clean}


# ---------------------------------------------------------------- Ask Admin
class AskIn(BaseModel):
    question: str = Field(min_length=3, max_length=500)


@router.post("/ask")
def ask_admin(body: AskIn, staff: Staff = Depends(require("metrics.read")), db: Session = Depends(get_db)):
    from ..services import ai_engine
    ov = overview(rng="30d", staff=staff, db=db)
    rows = M.user_rows(db)
    accts = M.account_rows(db, rows)
    ws = M.workspace_rows(db)
    fits = defaultdict(int)
    for w in ws:
        fits[w["fit"]] += 1
    context = {
        "today_utc": ov["generated_at"], "kpis": [{k: v for k, v in x.items() if k in ("label", "value", "sub", "delta")} for x in ov["kpis"]],
        "alerts": [a["text"] for a in ov["alerts"]], "goals": ov["goals"],
        "workspaces_by_fitted_plan": dict(fits),
        "top_accounts_by_usage": [{"name": a["name"], "users": a["users"], "chats_30d": a["chats_30d"], "health": a["health"],
                                   "fit": a["fit"], "sources": a["sources"]} for a in sorted(accts, key=lambda a: -a["chats_30d"])[:15]],
        "lowest_health_active_accounts": [{"name": a["name"], "users": a["users"], "health": a["health"], "signal": _risk_signal(a)}
                                           for a in sorted([a for a in accts if a["chats_total"]], key=lambda a: a["health"])[:10]],
        "people_by_lifecycle": {k: sum(1 for r in rows if r["lifecycle"] == k) for k in ("Signed up", "Activated", "Engaged", "Dormant")},
        "platform": ov["platform"], "support": ov["support"], "crm": ov["crm"],
        "billing": "Paid plans are not launched yet; every account is on free early access.",
    }
    messages = [
        {"role": "system", "content": (
            "You are the internal business analyst inside GD360's admin portal. Answer the team's question using ONLY "
            "the JSON facts provided. Be short and specific: one or two sentences that answer directly, then at most "
            "four bullet points with the exact numbers you used. Never invent numbers, names or causes. If the facts "
            "cannot answer it, say exactly which data is missing. Plain text, bullets start with '- '.")},
        {"role": "user", "content": f"Facts (JSON):\n{json.dumps(context, default=str)[:24000]}\n\nQuestion: {body.question}"},
    ]
    try:
        answer = ai_engine._call_llm(messages, max_tokens=700)
    except Exception as exc:  # the model is down or over budget: say so plainly
        raise HTTPException(503, f"Ask Admin couldn't reach the AI model right now ({str(exc)[:120]}). Try again shortly.")
    return {"answer": answer.strip(), "facts_used": list(context.keys())}


# ---------------------------------------------------------------- accounts
@router.get("/accounts")
def list_accounts(q: str = "", kind: str = Query("all", pattern="^(all|company|personal)$"),
                  band: str = Query("all", pattern="^(all|Healthy|Watch|At risk)$"),
                  sort: str = Query("users", pattern="^(users|chats|health|recent|name)$"),
                  staff: Staff = Depends(require("metrics.read")), db: Session = Depends(get_db)):
    accts = M.account_rows(db)
    ql = q.lower().strip()
    out = []
    for a in accts:
        if kind == "company" and a["personal"]:
            continue
        if kind == "personal" and not a["personal"]:
            continue
        if band != "all" and a["health_band"] != band:
            continue
        if ql and ql not in (a["name"] or "").lower() and ql not in (a["domain"] or ""):
            continue
        out.append(a)
    keyf = {"users": lambda a: (-a["users"], -a["chats_30d"]), "chats": lambda a: -a["chats_30d"], "health": lambda a: a["health"],
            "recent": lambda a: -(a["last_active"].timestamp() if a["last_active"] else 0), "name": lambda a: (a["name"] or "").lower()}[sort]
    out.sort(key=keyf)
    totals = {"all": len(accts), "company": sum(1 for a in accts if not a["personal"]), "personal": sum(1 for a in accts if a["personal"]),
              "at_risk": sum(1 for a in accts if a["health_band"] == "At risk" and a["chats_total"])}
    items = []
    for a in out[:500]:
        name = a["name"]
        if a["personal"] and not staff.can("pii.read"):
            name = mask_email(name, staff) if "@" in (name or "") else name
        items.append({**{k: a[k] for k in ("key", "domain", "personal", "users", "active_users_30d", "chats_7d", "chats_30d", "sources",
                                           "dashboards", "published", "ml_models", "automations", "health", "health_band", "fit",
                                           "open_tickets", "plan", "warehouse")},
                      "name": name, "deals": len(a["deals"]), "signed_up": _iso(a["signed_up"]), "last_active": _iso(a["last_active"])})
    return {"totals": totals, "items": items}


@router.get("/accounts/{key:path}")
def account_detail(key: str, staff: Staff = Depends(require("metrics.read")), db: Session = Depends(get_db)):
    rows = M.user_rows(db)
    members = [r for r in rows if r["account"] == key]
    if not members:
        raise HTTPException(404, "Account not found.")
    acct = next(a for a in M.account_rows(db, rows) if a["key"] == key)
    ids = [m["id"] for m in members]
    emails = [m["email"].lower() for m in members]
    now = datetime.utcnow()

    ws_ids = {w for m in members for w in m["workspace_ids"]}
    ws = [w for w in M.workspace_rows(db) if w["id"] in ws_ids]
    srcs = db.query(models.DataSource).filter(models.DataSource.owner_id.in_(ids)).order_by(models.DataSource.created_at.desc()).all()

    weeks = []
    for i in range(11, -1, -1):
        start = (now - timedelta(days=now.weekday())).replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(weeks=i)
        end = start + timedelta(weeks=1)
        n = (db.query(func.count(func.distinct(models.Conversation.owner_id)))
             .join(models.Message, models.Message.conversation_id == models.Conversation.id)
             .filter(models.Conversation.owner_id.in_(ids), models.Message.role == "user",
                     models.Message.created_at >= start, models.Message.created_at < end).scalar() or 0)
        joined = sum(1 for m in members if m["signed_up"] < end)
        weeks.append({"week": start.date().isoformat(), "active": n, "members": joined})

    events = (db.query(models.AuditEvent).filter(models.AuditEvent.actor_user_id.in_(ids))
              .order_by(models.AuditEvent.created_at.desc()).limit(25).all())
    admin_events = (db.query(models.AdminAuditEvent).filter(
        (models.AdminAuditEvent.target_id.in_(ids)) | (models.AdminAuditEvent.target_id == key))
        .order_by(models.AdminAuditEvent.created_at.desc()).limit(15).all())
    by_id = {m["id"]: m["email"] for m in members}
    timeline = [{"t": _iso(e.created_at), "who": "customer", "text": f"{mask_email(by_id.get(e.actor_user_id), staff)} · {e.action.replace('_', ' ')}"} for e in events]
    timeline += [{"t": _iso(e.created_at), "who": "staff", "text": f"{e.staff_email} · {e.summary or e.action}"} for e in admin_events]
    timeline.sort(key=lambda x: x["t"] or "", reverse=True)

    tickets = (db.query(models.SupportTicket).filter(func.lower(models.SupportTicket.requester_email).in_(emails))
               .order_by(models.SupportTicket.created_at.desc()).limit(20).all())
    deals = (db.query(models.CrmDeal).filter(func.lower(models.CrmDeal.domain) == key.lower())
             .order_by(models.CrmDeal.updated_at.desc()).all()) if not acct["personal"] else []

    nba = _next_best_action(acct, ws)
    name = acct["name"]
    if acct["personal"] and "@" in (name or "") and not staff.can("pii.read"):
        name = mask_email(name, staff)  # same masking as the accounts list
    families = [
        ("Ask anything", acct["chats_total"]), ("Dashboards", acct["dashboards"]), ("Published", acct["published"]),
        ("ML Studio", acct["ml_models"]), ("Automations", acct["automations"]),
        ("Warehouse", 1 if acct["warehouse"] else 0),
    ]
    return {
        "account": {**{k: acct[k] for k in ("key", "name", "domain", "personal", "users", "active_users_30d", "chats_7d", "chats_30d",
                                           "chats_total", "sources", "dashboards", "published", "ml_models", "automations",
                                           "health", "health_band", "health_parts", "fit", "plan", "open_tickets")},
                    "name": name, "signed_up": _iso(acct["signed_up"]), "last_active": _iso(acct["last_active"])},
        "members": [{"id": m["id"], "email": mask_email(m["email"], staff), "name": m["name"], "roles": m["roles"],
                     "chats_30d": m["chats_30d"], "last_active": _iso(m["last_active"]), "status": m["status"],
                     "lifecycle": m["lifecycle"]} for m in sorted(members, key=lambda m: -m["chats_30d"])],
        "workspaces": [{**w, "created_at": _iso(w["created_at"]), "owner_email": mask_email(w["owner_email"], staff)} for w in ws],
        "sources": [{"id": s.id, "name": s.name, "kind": s.kind, "group": M.kind_group(s.kind), "created_at": _iso(s.created_at),
                     "last_synced_at": _iso(s.last_synced_at), "sync_error": s.sync_error} for s in srcs],
        "weeks": weeks, "timeline": timeline[:30], "breadth": [{"k": k, "v": v, "on": bool(v)} for k, v in families],
        "tickets": [{"id": t.id, "number": t.number, "subject": t.subject, "priority": t.priority, "status": t.status,
                     "assignee": t.assignee_email, "created_at": _iso(t.created_at)} for t in tickets],
        "deals": [{"id": d.id, "name": d.name, "stage": d.stage, "amount": d.amount, "owner": d.owner_email,
                   "close_date": _iso(d.close_date)} for d in deals],
        "next_best_action": nba,
    }


def _next_best_action(acct: dict, ws: list[dict]) -> dict:
    if acct["open_tickets"]:
        return {"title": "Close the open ticket first", "why": f"{acct['open_tickets']} open ticket(s). Health and trust drop while they wait.", "cta": "Open support", "href": "support"}
    if acct["chats_total"] == 0:
        return {"title": "Help them get a first answer", "why": "Signed up but hasn't asked a question yet. Accounts that ask in week one stay.", "cta": "Open people", "href": "people"}
    if acct["chats_7d"] == 0:
        return {"title": "Re-engage this account", "why": f"No questions in 7 days (was {acct['chats_30d']} in 30). Reach out before they go cold.", "cta": "Log a call", "href": "crm"}
    if acct["fit"] in ("Team", "Business", "Enterprise"):
        return {"title": f"Start the {acct['fit']} conversation", "why": f"{acct['users']} people, {acct['chats_30d']} questions in 30 days and {acct['sources']} sources — usage fits {acct['fit']}.", "cta": "Create a deal", "href": "crm"}
    if not acct["dashboards"]:
        return {"title": "Show them dashboards", "why": "They ask questions but haven't saved a dashboard. Saved dashboards double retention.", "cta": "Send a tip", "href": "flags"}
    return {"title": "Keep them close", "why": "Healthy and growing. Ask for a quote or a referral.", "cta": "Log a note", "href": "crm"}


# ---------------------------------------------------------------- people
def _person_out(r: dict, staff: Staff) -> dict:
    return {
        "id": r["id"], "email": mask_email(r["email"], staff), "name": r["name"], "company": r["company"],
        "account": r["account"], "corporate": r["corporate"], "plan": r["plan"], "roles": r["roles"],
        "chats_30d": r["chats_30d"], "chats_total": r["chats_total"], "sources": r["sources"], "dashboards": r["dashboards"],
        "published": r["published"], "ml_models": r["ml_models"], "automations": r["automations"], "workspaces": r["workspaces"],
        "signed_up": _iso(r["signed_up"]), "last_active": _iso(r["last_active"]), "last_login": _iso(r["last_login"]),
        "status": r["status"], "lifecycle": r["lifecycle"], "failed_logins": r["failed_logins"],
        "locked_until": _iso(r["locked_until"]), "staff": r["staff"],
    }


def _filter_people(rows, q, status, lifecycle, domain):
    ql = q.lower().strip()
    out = []
    for r in rows:
        if status != "all" and r["status"] != status:
            continue
        if lifecycle != "all" and r["lifecycle"] != lifecycle:
            continue
        if domain == "corporate" and not r["corporate"]:
            continue
        if domain == "freemail" and r["corporate"]:
            continue
        if ql and not any(ql in (r[k] or "").lower() for k in ("email", "name", "company")):
            continue
        out.append(r)
    return out


_SORTS = {
    "recent": lambda r: -(r["last_active"].timestamp() if r["last_active"] else 0),
    "chats": lambda r: -r["chats_30d"],
    "newest": lambda r: -(r["signed_up"].timestamp() if r["signed_up"] else 0),
    "name": lambda r: (r["name"] or r["email"]).lower(),
}


@router.get("/people")
def list_people(q: str = "", status: str = Query("all", pattern="^(all|active|dormant|new|locked|suspended)$"),
                lifecycle: str = Query("all", pattern="^(all|Signed up|Activated|Engaged|Dormant)$"),
                domain: str = Query("all", pattern="^(all|corporate|freemail)$"),
                sort: str = Query("recent", pattern="^(recent|chats|newest|name)$"),
                page: int = Query(1, ge=1), size: int = Query(50, ge=1, le=200),
                staff: Staff = Depends(require("metrics.read")), db: Session = Depends(get_db)):
    rows = M.user_rows(db)
    out = _filter_people(rows, q, status, lifecycle, domain)
    out.sort(key=_SORTS[sort])
    counts = {k: sum(1 for r in rows if r["status"] == k) for k in ("active", "dormant", "new", "locked", "suspended")}
    counts["all"] = len(rows)
    return {"total": len(out), "page": page, "size": size, "counts": counts,
            "items": [_person_out(r, staff) for r in out[(page - 1) * size: page * size]]}


@router.get("/people/export.csv")
def export_people(q: str = "", status: str = "all", lifecycle: str = "all", domain: str = "all",
                  staff: Staff = Depends(require("metrics.read")), db: Session = Depends(get_db)):
    rows = _filter_people(M.user_rows(db), q, status, lifecycle, domain)
    buf = io.StringIO()
    w = csv.writer(buf)
    cols = ["email", "name", "company", "plan", "status", "lifecycle", "chats_30d", "chats_total", "sources", "dashboards",
            "published", "ml_models", "automations", "workspaces", "signed_up", "last_active"]
    w.writerow(cols)
    for r in rows:
        o = _person_out(r, staff)
        w.writerow([o.get(c) for c in cols])
    buf.seek(0)
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": "attachment; filename=gd360-people.csv"})


@router.get("/people/{user_id}")
def person_detail(user_id: str, staff: Staff = Depends(require("metrics.read")), db: Session = Depends(get_db)):
    rows = M.user_rows(db)
    r = next((x for x in rows if x["id"] == user_id), None)
    if not r:
        raise HTTPException(404, "Person not found.")
    mem = (db.query(models.WorkspaceMember, models.Workspace).join(models.Workspace, models.Workspace.id == models.WorkspaceMember.workspace_id)
           .filter(models.WorkspaceMember.user_id == user_id).all())
    srcs = db.query(models.DataSource).filter(models.DataSource.owner_id == user_id).order_by(models.DataSource.created_at.desc()).limit(20).all()
    events = (db.query(models.AuditEvent).filter(models.AuditEvent.actor_user_id == user_id)
              .order_by(models.AuditEvent.created_at.desc()).limit(12).all())
    staff_events = (db.query(models.AdminAuditEvent).filter(models.AdminAuditEvent.target_id == user_id)
                    .order_by(models.AdminAuditEvent.created_at.desc()).limit(8).all())
    tickets = (db.query(models.SupportTicket).filter(func.lower(models.SupportTicket.requester_email) == r["email"].lower())
               .order_by(models.SupportTicket.created_at.desc()).limit(10).all())
    user = db.get(models.User, user_id)
    return {
        "person": _person_out(r, staff),
        "suspended_at": _iso(getattr(user, "disabled_at", None)),
        "workspaces": [{"id": w.id, "name": w.name, "role": m.role, "personal": bool(w.is_personal),
                        "members": db.query(func.count(models.WorkspaceMember.id)).filter(models.WorkspaceMember.workspace_id == w.id).scalar()} for m, w in mem],
        "sources": [{"name": s.name, "kind": s.kind, "created_at": _iso(s.created_at), "sync_error": s.sync_error} for s in srcs],
        "recent": [{"t": _iso(e.created_at), "text": e.action.replace("_", " ")} for e in events],
        "staff_actions": [{"t": _iso(e.created_at), "text": f"{e.staff_email}: {e.summary or e.action}"} for e in staff_events],
        "tickets": [{"id": t.id, "number": t.number, "subject": t.subject, "status": t.status, "priority": t.priority} for t in tickets],
    }


class ReasonIn(BaseModel):
    reason: str | None = Field(default=None, max_length=500)


def _user_or_404(db: Session, user_id: str) -> models.User:
    u = db.get(models.User, user_id)
    if not u:
        raise HTTPException(404, "Person not found.")
    return u


@router.post("/people/{user_id}/unlock")
def unlock(user_id: str, request: Request, staff: Staff = Depends(require("users.unlock")), db: Session = Depends(get_db)):
    u = _user_or_404(db, user_id)
    u.locked_until, u.failed_login_attempts = None, 0
    log_admin(db, staff, "user.unlock", target_type="user", target_id=u.id, summary=f"Unlocked {u.email}", request=request)
    db.commit()
    return {"ok": True}


@router.post("/people/{user_id}/signout")
def sign_out_everywhere(user_id: str, request: Request, staff: Staff = Depends(require("users.unlock")), db: Session = Depends(get_db)):
    u = _user_or_404(db, user_id)
    u.token_version = (u.token_version or 0) + 1
    log_admin(db, staff, "user.signout_all", target_type="user", target_id=u.id, summary=f"Signed {u.email} out everywhere", request=request)
    db.commit()
    return {"ok": True}


@router.post("/people/{user_id}/suspend")
def suspend(user_id: str, body: ReasonIn, request: Request, staff: Staff = Depends(require("users.write")), db: Session = Depends(get_db)):
    u = _user_or_404(db, user_id)
    if staff_role(db, u.email) == "owner":
        raise HTTPException(400, "Owners can't be suspended.")
    if not (body.reason or "").strip():
        raise HTTPException(400, "Give a reason — it goes in the audit log.")
    u.disabled_at = datetime.utcnow()
    u.token_version = (u.token_version or 0) + 1
    log_admin(db, staff, "user.suspend", target_type="user", target_id=u.id, summary=f"Suspended {u.email}", reason=body.reason, request=request)
    db.commit()
    return {"ok": True}


@router.post("/people/{user_id}/reactivate")
def reactivate(user_id: str, request: Request, staff: Staff = Depends(require("users.write")), db: Session = Depends(get_db)):
    u = _user_or_404(db, user_id)
    u.disabled_at = None
    log_admin(db, staff, "user.reactivate", target_type="user", target_id=u.id, summary=f"Reactivated {u.email}", request=request)
    db.commit()
    return {"ok": True}


class RoleIn(BaseModel):
    workspace_id: str
    role: str = Field(pattern="^(owner|member|viewer)$")


@router.patch("/people/{user_id}/role")
def change_role(user_id: str, body: RoleIn, request: Request, staff: Staff = Depends(require("users.write")), db: Session = Depends(get_db)):
    m = (db.query(models.WorkspaceMember).filter(models.WorkspaceMember.user_id == user_id,
                                                 models.WorkspaceMember.workspace_id == body.workspace_id).first())
    if not m:
        raise HTTPException(404, "This person isn't in that workspace.")
    if m.role == "owner" and body.role != "owner":
        owners = db.query(func.count(models.WorkspaceMember.id)).filter(models.WorkspaceMember.workspace_id == body.workspace_id,
                                                                        models.WorkspaceMember.role == "owner").scalar()
        if owners <= 1:
            raise HTTPException(400, "A workspace needs at least one owner. Make someone else owner first.")
    before = m.role
    m.role = body.role
    log_admin(db, staff, "user.role_change", target_type="user", target_id=user_id,
              summary=f"Workspace role {before} → {body.role}", before={"role": before}, after={"role": body.role}, request=request)
    db.commit()
    return {"ok": True}


# ---------------------------------------------------------------- staff
@router.get("/staff")
def list_staff(staff: Staff = Depends(current_staff), db: Session = Depends(get_db)):
    users = {u.email.lower(): u for u in db.query(models.User).all()}
    out = []
    for e in sorted(_owner_emails()):
        u = users.get(e)
        out.append({"id": None, "email": e, "name": u.full_name if u else "", "role": "owner", "role_label": ROLES["owner"],
                    "status": "active" if u else "invited", "fixed": True, "last_seen_at": None, "signed_up": bool(u)})
    for s in db.query(models.StaffMember).order_by(models.StaffMember.created_at).all():
        if s.email in _owner_emails():
            continue
        u = users.get(s.email)
        out.append({"id": s.id, "email": s.email, "name": u.full_name if u else "", "role": s.role, "role_label": ROLES.get(s.role, s.role),
                    "status": s.status if u else ("invited" if s.status == "active" else s.status), "fixed": False,
                    "last_seen_at": _iso(s.last_seen_at), "signed_up": bool(u)})
    return {"staff": out}


class StaffIn(BaseModel):
    email: str = Field(min_length=5, max_length=200)
    role: str


@router.post("/staff")
def invite_staff(body: StaffIn, request: Request, staff: Staff = Depends(require("staff.manage")), db: Session = Depends(get_db)):
    email = body.email.strip().lower()
    if body.role not in ROLES or body.role == "owner":
        raise HTTPException(400, "Pick a role other than Owner. Owners come from the ADMIN_EMAILS setting.")
    if body.role == "admin" and staff.role != "owner":
        raise HTTPException(403, "Only an Owner can make someone an Admin.")
    if "@" not in email:
        raise HTTPException(400, "Enter a valid email.")
    if email in _owner_emails():
        raise HTTPException(400, "That person is already an Owner.")
    row = db.query(models.StaffMember).filter(models.StaffMember.email == email).first()
    if row:
        row.role, row.status = body.role, "active"
    else:
        row = models.StaffMember(email=email, role=body.role, invited_by=staff.email)
        db.add(row)
    log_admin(db, staff, "staff.invite", target_type="staff", target_id=email, summary=f"Gave {email} the {ROLES[body.role]} role", request=request)
    db.commit()
    return {"ok": True}


class StaffPatch(BaseModel):
    role: str | None = None
    status: str | None = Field(default=None, pattern="^(active|disabled)$")


@router.patch("/staff/{staff_id}")
def update_staff(staff_id: str, body: StaffPatch, request: Request, staff: Staff = Depends(require("staff.manage")), db: Session = Depends(get_db)):
    row = db.get(models.StaffMember, staff_id)
    if not row:
        raise HTTPException(404, "Staff member not found.")
    if (row.role == "admin" or body.role == "admin") and staff.role != "owner":
        raise HTTPException(403, "Only an Owner can change an Admin.")
    before = {"role": row.role, "status": row.status}
    if body.role:
        if body.role not in ROLES or body.role == "owner":
            raise HTTPException(400, "Unknown role.")
        row.role = body.role
    if body.status:
        row.status = body.status
    log_admin(db, staff, "staff.update", target_type="staff", target_id=row.email, summary=f"{row.email}: {before} → role {row.role}, {row.status}",
              before=before, after={"role": row.role, "status": row.status}, request=request)
    db.commit()
    return {"ok": True}


@router.delete("/staff/{staff_id}")
def remove_staff(staff_id: str, request: Request, staff: Staff = Depends(require("staff.manage")), db: Session = Depends(get_db)):
    row = db.get(models.StaffMember, staff_id)
    if not row:
        raise HTTPException(404, "Staff member not found.")
    if row.role == "admin" and staff.role != "owner":
        raise HTTPException(403, "Only an Owner can remove an Admin.")
    log_admin(db, staff, "staff.remove", target_type="staff", target_id=row.email, summary=f"Removed {row.email} from Mission Control", request=request)
    db.delete(row)
    db.commit()
    return {"ok": True}


# ---------------------------------------------------------------- just-in-time access
class AccessIn(BaseModel):
    permission: str
    reason: str = Field(min_length=3, max_length=500)
    minutes: int = Field(default=60, ge=15, le=480)


@router.get("/access-requests")
def list_access(staff: Staff = Depends(current_staff), db: Session = Depends(get_db)):
    q = db.query(models.AccessRequest).order_by(models.AccessRequest.created_at.desc())
    if not staff.can("access.approve"):
        q = q.filter(models.AccessRequest.staff_email == staff.email)
    now = datetime.utcnow()
    out = []
    for r in q.limit(50).all():
        st = "expired" if r.status == "approved" and r.expires_at and r.expires_at <= now else r.status
        out.append({"id": r.id, "staff_email": r.staff_email, "permission": r.permission, "reason": r.reason, "minutes": r.minutes,
                    "status": st, "decided_by": r.decided_by, "expires_at": _iso(r.expires_at), "created_at": _iso(r.created_at)})
    return {"requests": out}


@router.post("/access-requests")
def request_access(body: AccessIn, request: Request, staff: Staff = Depends(current_staff), db: Session = Depends(get_db)):
    if body.permission not in {k for k, _, _ in PERMISSIONS}:
        raise HTTPException(400, "Unknown permission.")
    if staff.can(body.permission):
        raise HTTPException(400, "You already have this permission.")
    r = models.AccessRequest(staff_email=staff.email, permission=body.permission, reason=body.reason, minutes=body.minutes)
    db.add(r)
    log_admin(db, staff, "access.request", target_type="permission", target_id=body.permission,
              summary=f"Asked for {body.permission} for {body.minutes} min", reason=body.reason, request=request)
    db.commit()
    return {"ok": True, "id": r.id}


@router.post("/access-requests/{req_id}/{decision}")
def decide_access(req_id: str, decision: str, request: Request, staff: Staff = Depends(require("access.approve")), db: Session = Depends(get_db)):
    if decision not in ("approve", "deny"):
        raise HTTPException(404, "Unknown decision.")
    r = db.get(models.AccessRequest, req_id)
    if not r or r.status != "pending":
        raise HTTPException(404, "No pending request with that id.")
    if r.staff_email == staff.email:
        raise HTTPException(400, "You can't approve your own request.")
    r.status = "approved" if decision == "approve" else "denied"
    r.decided_by = staff.email
    if r.status == "approved":
        r.expires_at = datetime.utcnow() + timedelta(minutes=r.minutes)
    log_admin(db, staff, f"access.{decision}", target_type="staff", target_id=r.staff_email,
              summary=f"{'Granted' if r.status == 'approved' else 'Denied'} {r.permission} to {r.staff_email}" + (f" for {r.minutes} min" if r.status == "approved" else ""),
              request=request)
    db.commit()
    return {"ok": True}


# ---------------------------------------------------------------- audit
@router.get("/audit")
def audit_log(kind: str = Query("all", pattern="^(all|staff|customer)$"), q: str = "", limit: int = Query(100, ge=1, le=500),
              staff: Staff = Depends(require("audit.read")), db: Session = Depends(get_db)):
    out = []
    ql = q.lower().strip()
    if kind in ("all", "staff"):
        for e in db.query(models.AdminAuditEvent).order_by(models.AdminAuditEvent.created_at.desc()).limit(limit).all():
            out.append({"t": _iso(e.created_at), "kind": "staff", "actor": e.staff_email, "action": e.action,
                        "text": e.summary or e.action, "reason": e.reason, "hash": (e.row_hash or "")[:10]})
    if kind in ("all", "customer"):
        users = {u.id: u.email for u in db.query(models.User.id, models.User.email).all()}
        for e in db.query(models.AuditEvent).order_by(models.AuditEvent.created_at.desc()).limit(limit).all():
            out.append({"t": _iso(e.created_at), "kind": "customer", "actor": mask_email(users.get(e.actor_user_id), staff),
                        "action": e.action, "text": e.action.replace("_", " ") + (f" · {e.target_type}" if e.target_type else ""), "reason": None, "hash": None})
    if ql:
        out = [e for e in out if ql in json.dumps(e, ensure_ascii=False).lower()]
    out.sort(key=lambda e: e["t"] or "", reverse=True)
    return {"events": out[:limit]}


@router.get("/audit/verify")
def verify_chain(staff: Staff = Depends(require("audit.read")), db: Session = Depends(get_db)):
    rows = db.query(models.AdminAuditEvent).order_by(models.AdminAuditEvent.created_at.asc()).all()
    prev, broken = "", 0
    for r in rows:
        if (r.prev_hash or "") != prev:
            broken += 1
        prev = r.row_hash or ""
    return {"events": len(rows), "broken_links": broken, "intact": broken == 0}


# ---------------------------------------------------------------- nav badges
@router.get("/badges")
def badges(staff: Staff = Depends(current_staff), db: Session = Depends(get_db)):
    now = datetime.utcnow()
    return {
        "support": db.query(func.count(models.SupportTicket.id)).filter(models.SupportTicket.status.in_(("open", "pending"))).scalar() or 0,
        "breaching": len(_sla_breaching(db, now)),
        "crm": db.query(func.count(models.DemoRequest.id)).filter(models.DemoRequest.status == "new").scalar() or 0,
        "health": db.query(func.count(models.DataSource.id)).filter(models.DataSource.sync_error.isnot(None)).scalar() or 0,
        "access": db.query(func.count(models.AccessRequest.id)).filter(models.AccessRequest.status == "pending").scalar() or 0 if staff.can("access.approve") else 0,
        "trust": db.query(func.count(models.PrivacyRequest.id)).filter(models.PrivacyRequest.status.in_(("received", "in_review"))).scalar() or 0,
        "overrides": db.query(func.count(models.EntitlementOverride.id)).filter(models.EntitlementOverride.status == "pending").scalar() or 0,
    }
