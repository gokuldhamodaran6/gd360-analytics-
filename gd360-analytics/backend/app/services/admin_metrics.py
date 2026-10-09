"""
Mission Control metrics (2026-10-10). Everything is computed from the app's
own tables with a handful of grouped queries; nothing is sampled or made up.

Building blocks used by the admin routers:
  * user_rows(db)       one dict per user with usage counts
  * account_rows(db)    users grouped into accounts (company email domain,
                        or one personal account per freemail user)
  * workspace_rows(db)  per-workspace usage, and the smallest plan that fits
  * health(...)         a 0-100 account health score with its parts
  * segment matching    evaluate saved segment rules against user_rows
"""
from __future__ import annotations

import hashlib
from collections import defaultdict
from datetime import datetime, timedelta

from sqlalchemy import func
from sqlalchemy.orm import Session

from .. import models

FREEMAIL = {
    "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.in", "yahoo.co.uk", "hotmail.com", "outlook.com",
    "live.com", "msn.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com",
    "gmx.com", "gmx.de", "mail.com", "yandex.com", "yandex.ru", "zoho.com", "rediffmail.com", "qq.com",
    "163.com", "126.com", "pm.me", "fastmail.com", "hey.com", "tutanota.com", "web.de",
}
DISPOSABLE = {
    "mailinator.com", "10minutemail.com", "guerrillamail.com", "tempmail.com", "temp-mail.org", "yopmail.com",
    "trashmail.com", "sharklasers.com", "getnada.com", "dispostable.com", "maildrop.cc", "throwawaymail.com",
}
WAREHOUSE_KINDS = {"bigquery", "snowflake", "redshift", "databricks", "synapse"}
DATABASE_KINDS = {"postgres", "mysql", "sqlserver", "mongodb", "supabase", "mariadb", "oracle"}
FILE_KINDS = {"csv", "excel", "microsoft_excel", "google_sheets", "json", "parquet", "file"}


def domain_of(email: str | None) -> str:
    return (email or "").split("@")[-1].lower().strip()


def is_corporate(email: str | None) -> bool:
    d = domain_of(email)
    return bool(d) and d not in FREEMAIL and d not in DISPOSABLE


def account_key_for(user) -> str:
    return domain_of(user.email) if is_corporate(user.email) else f"personal:{user.id}"


def days_ago(dt: datetime | None, now: datetime | None = None) -> int | None:
    if not dt:
        return None
    return max(0, ((now or datetime.utcnow()) - dt).days)


def kind_group(kind: str | None) -> str:
    k = (kind or "").lower()
    if k in WAREHOUSE_KINDS:
        return "warehouse"
    if k in DATABASE_KINDS:
        return "database"
    if k in FILE_KINDS:
        return "file"
    return "app"


# ---------------------------------------------------------------------------
def _group_counts(db: Session, col, *filters) -> dict:
    q = db.query(col, func.count()).filter(*filters).group_by(col)
    return {k: n for k, n in q.all() if k is not None}


def user_rows(db: Session) -> list[dict]:
    """One row per user with everything the admin screens filter and sort on."""
    now = datetime.utcnow()
    since30 = now - timedelta(days=30)
    since7 = now - timedelta(days=7)

    chats = defaultdict(lambda: {"total": 0, "d30": 0, "d7": 0, "last": None, "first_answer": None})
    q = (
        db.query(models.Conversation.owner_id, func.count(models.Message.id), func.max(models.Message.created_at))
        .join(models.Message, models.Message.conversation_id == models.Conversation.id)
        .filter(models.Message.role == "user")
        .group_by(models.Conversation.owner_id)
    )
    for uid, n, last in q.all():
        chats[uid]["total"] = n
        chats[uid]["last"] = last
    for label, since in (("d30", since30), ("d7", since7)):
        q = (
            db.query(models.Conversation.owner_id, func.count(models.Message.id))
            .join(models.Message, models.Message.conversation_id == models.Conversation.id)
            .filter(models.Message.role == "user", models.Message.created_at >= since)
            .group_by(models.Conversation.owner_id)
        )
        for uid, n in q.all():
            chats[uid][label] = n

    answers = defaultdict(lambda: [0, 0])  # [assistant answers 30d, of which asked to clarify]
    q = (
        db.query(models.Conversation.owner_id, models.Message.needs_clarification, func.count(models.Message.id))
        .join(models.Message, models.Message.conversation_id == models.Conversation.id)
        .filter(models.Message.role == "assistant", models.Message.created_at >= since30)
        .group_by(models.Conversation.owner_id, models.Message.needs_clarification)
    )
    for uid, clar, n in q.all():
        answers[uid][0] += n
        if clar:
            answers[uid][1] += n

    sources = _group_counts(db, models.DataSource.owner_id)
    warehouse = _group_counts(db, models.DataSource.owner_id, models.DataSource.kind.in_(WAREHOUSE_KINDS))
    dashboards = _group_counts(db, models.Dashboard.owner_id)
    published = dict(
        db.query(models.Dashboard.owner_id, func.count(models.DashboardShare.id))
        .join(models.DashboardShare, models.DashboardShare.dashboard_id == models.Dashboard.id)
        .filter(models.DashboardShare.published_at.isnot(None))
        .group_by(models.Dashboard.owner_id).all()
    )
    ml = _group_counts(db, models.MLModel.owner_id)
    autos = _group_counts(db, models.Automation.owner_id)
    memberships = defaultdict(list)
    for uid, ws, role in db.query(models.WorkspaceMember.user_id, models.WorkspaceMember.workspace_id, models.WorkspaceMember.role).all():
        memberships[uid].append((ws, role))
    logins = dict(
        db.query(models.AuditEvent.actor_user_id, func.max(models.AuditEvent.created_at))
        .filter(models.AuditEvent.action == "login").group_by(models.AuditEvent.actor_user_id).all()
    )
    staff = {r.email for r in db.query(models.StaffMember.email).all()}

    rows = []
    for u in db.query(models.User).all():
        c = chats[u.id]
        last = c["last"]
        last_login = logins.get(u.id)
        last_seen = max([d for d in (last, last_login) if d] or [None]) if (last or last_login) else None
        locked = bool(u.locked_until and u.locked_until > now)
        status = "suspended" if getattr(u, "disabled_at", None) else ("locked" if locked else (
            "active" if last and last >= now - timedelta(days=14) else ("dormant" if c["total"] else "new")))
        lifecycle = (
            "Signed up" if not c["total"] else
            "Engaged" if c["d7"] >= 10 else
            "Activated" if last and last >= now - timedelta(days=14) else
            "Dormant"
        )
        rows.append({
            "id": u.id, "email": u.email, "name": u.full_name or "", "company": u.company or "",
            "domain": domain_of(u.email), "corporate": is_corporate(u.email), "account": account_key_for(u),
            "signed_up": u.created_at, "signup_days": days_ago(u.created_at, now),
            "chats_total": c["total"], "chats_30d": c["d30"], "chats_7d": c["d7"],
            "answers_30d": answers[u.id][0], "clarify_30d": answers[u.id][1],
            "last_active": last, "last_active_days": days_ago(last, now), "last_login": last_login,
            "last_seen": last_seen,
            "sources": sources.get(u.id, 0), "warehouse": warehouse.get(u.id, 0) > 0,
            "dashboards": dashboards.get(u.id, 0), "published": published.get(u.id, 0),
            "ml_models": ml.get(u.id, 0), "automations": autos.get(u.id, 0),
            "workspaces": len(memberships[u.id]),
            "roles": sorted({r for _, r in memberships[u.id]}),
            "workspace_ids": [w for w, _ in memberships[u.id]],
            "plan": "Early access",
            "status": status, "lifecycle": lifecycle,
            "failed_logins": u.failed_login_attempts or 0, "locked_until": u.locked_until if locked else None,
            "staff": u.email.lower() in staff,
        })
    return rows


# ---------------------------------------------------------------------------
def health(acct: dict) -> tuple[int, list[dict]]:
    """0-100. Parts (weights): usage trend 35, breadth 25, seat activity 20,
    answer trust 10, support 10. Billing is left out until billing exists."""
    parts = []
    d7, d30 = acct.get("chats_7d", 0), acct.get("chats_30d", 0)
    prior_weekly = max(0.0, (d30 - d7) / 3.0)
    if d30 == 0:
        trend = 0.0
    elif prior_weekly == 0:
        trend = 1.0 if d7 else 0.4
    else:
        trend = max(0.0, min(1.0, 0.5 + (d7 - prior_weekly) / (2 * prior_weekly)))
    parts.append({"k": "Usage trend", "weight": 35, "score": round(trend * 35)})
    fam = acct.get("families", 0)
    parts.append({"k": "Feature breadth", "weight": 25, "score": round(min(1.0, fam / 6) * 25)})
    members = max(1, acct.get("users", 1))
    act = acct.get("active_users_30d", 0) / members
    parts.append({"k": "People active", "weight": 20, "score": round(min(1.0, act) * 20)})
    a30 = acct.get("answers_30d", 0)
    trust = (1 - acct.get("clarify_30d", 0) / a30) if a30 else 0.0
    parts.append({"k": "Answer trust", "weight": 10, "score": round(trust * 10)})
    open_t = acct.get("open_tickets", 0)
    parts.append({"k": "Support", "weight": 10, "score": 10 if open_t == 0 else (6 if open_t == 1 else 2)})
    return sum(p["score"] for p in parts), parts


def health_band(score: int) -> str:
    return "Healthy" if score >= 70 else ("Watch" if score >= 40 else "At risk")


def account_rows(db: Session, users: list[dict] | None = None) -> list[dict]:
    users = users if users is not None else user_rows(db)
    tickets_open = defaultdict(int)
    for email, in db.query(models.SupportTicket.requester_email).filter(models.SupportTicket.status.in_(("open", "pending"))).all():
        if email:
            tickets_open[email.lower()] += 1
    deals = defaultdict(list)
    for d in db.query(models.CrmDeal).filter(models.CrmDeal.stage.notin_(("lost",))).all():
        if d.domain:
            deals[d.domain.lower()].append(d)
    groups: dict[str, list[dict]] = defaultdict(list)
    for u in users:
        groups[u["account"]].append(u)
    out = []
    now = datetime.utcnow()
    for key, members in groups.items():
        personal = key.startswith("personal:")
        first = members[0]
        name = (first["company"] or first["name"] or first["email"]) if personal else (
            next((m["company"] for m in members if m["company"]), "") or key)
        fam = sum(1 for flag in (
            any(m["chats_total"] for m in members), any(m["dashboards"] for m in members),
            any(m["published"] for m in members), any(m["ml_models"] for m in members),
            any(m["automations"] for m in members), any(m["warehouse"] for m in members),
        ) if flag)
        acct = {
            "key": key, "name": name, "domain": None if personal else key, "personal": personal,
            "users": len(members),
            "active_users_30d": sum(1 for m in members if m["chats_30d"] > 0),
            "chats_7d": sum(m["chats_7d"] for m in members), "chats_30d": sum(m["chats_30d"] for m in members),
            "chats_total": sum(m["chats_total"] for m in members),
            "sources": sum(m["sources"] for m in members), "warehouse": any(m["warehouse"] for m in members),
            "dashboards": sum(m["dashboards"] for m in members), "published": sum(m["published"] for m in members),
            "ml_models": sum(m["ml_models"] for m in members), "automations": sum(m["automations"] for m in members),
            "families": fam,
            "answers_30d": sum(m["answers_30d"] for m in members), "clarify_30d": sum(m["clarify_30d"] for m in members),
            "open_tickets": sum(tickets_open.get(m["email"].lower(), 0) for m in members),
            "deals": [{"id": d.id, "name": d.name, "stage": d.stage, "amount": d.amount} for d in deals.get(key, [])],
            "signed_up": min(m["signed_up"] for m in members),
            "last_active": max([m["last_active"] for m in members if m["last_active"]] or [None]),
            "plan": "Early access",
        }
        acct["last_active_days"] = days_ago(acct["last_active"], now)
        score, parts = health(acct)
        acct["health"], acct["health_parts"], acct["health_band"] = score, parts, health_band(score)
        acct["fit"] = fit_plan(acct["users"], (acct["chats_30d"] / max(1, acct["active_users_30d"] or 1)),
                               acct["sources"], acct["warehouse"], acct["published"], acct["ml_models"], acct["automations"])
        out.append(acct)
    return out


# ---------------------------------------------------------------------------
PLAN_ORDER = ["Plus", "Team", "Business", "Enterprise"]


def fit_plan(members: int, chats_per_user: float, sources: int, warehouse: bool, published: int,
             ml: int, automations: int, custom_domain: bool = False) -> str:
    """Smallest plan whose limits fit today's usage (limits from the plan matrix defaults)."""
    if members >= 50:
        return "Enterprise"
    if members >= 10 or chats_per_user > 500 or sources > 25 or custom_domain or automations > 25 or ml > 20:
        return "Business"
    if members >= 2 or warehouse or chats_per_user > 200 or sources > 5 or automations > 3 or ml > 3:
        return "Team"
    return "Plus"


def workspace_rows(db: Session) -> list[dict]:
    since30 = datetime.utcnow() - timedelta(days=30)
    members = _group_counts(db, models.WorkspaceMember.workspace_id)
    chats = dict(
        db.query(models.Conversation.workspace_id, func.count(models.Message.id))
        .join(models.Message, models.Message.conversation_id == models.Conversation.id)
        .filter(models.Message.role == "user", models.Message.created_at >= since30)
        .group_by(models.Conversation.workspace_id).all()
    )
    active = dict(
        db.query(models.Conversation.workspace_id, func.count(func.distinct(models.Conversation.owner_id)))
        .join(models.Message, models.Message.conversation_id == models.Conversation.id)
        .filter(models.Message.role == "user", models.Message.created_at >= since30)
        .group_by(models.Conversation.workspace_id).all()
    )
    sources = _group_counts(db, models.DataSource.workspace_id)
    wh = _group_counts(db, models.DataSource.workspace_id, models.DataSource.kind.in_(WAREHOUSE_KINDS))
    ml = _group_counts(db, models.MLModel.workspace_id)
    autos = _group_counts(db, models.Automation.workspace_id)
    pub = dict(
        db.query(models.Dashboard.workspace_id, func.count(models.DashboardShare.id))
        .join(models.DashboardShare, models.DashboardShare.dashboard_id == models.Dashboard.id)
        .filter(models.DashboardShare.published_at.isnot(None)).group_by(models.Dashboard.workspace_id).all()
    )
    domains = dict(
        db.query(models.Dashboard.workspace_id, func.count(models.DashboardShare.id))
        .join(models.DashboardShare, models.DashboardShare.dashboard_id == models.Dashboard.id)
        .filter(models.DashboardShare.custom_domain.isnot(None)).group_by(models.Dashboard.workspace_id).all()
    )
    owners = {u.id: u for u in db.query(models.User).all()}
    out = []
    for w in db.query(models.Workspace).all():
        m = members.get(w.id, 1)
        a = active.get(w.id, 0)
        cpu = chats.get(w.id, 0) / max(1, a or 1)
        owner = owners.get(w.owner_id)
        out.append({
            "id": w.id, "name": w.name, "personal": bool(w.is_personal), "owner_email": owner.email if owner else None,
            "members": m, "active_30d": a, "chats_30d": chats.get(w.id, 0), "chats_per_user": round(cpu, 1),
            "sources": sources.get(w.id, 0), "warehouse": wh.get(w.id, 0) > 0, "ml_models": ml.get(w.id, 0),
            "automations": autos.get(w.id, 0), "published": pub.get(w.id, 0), "custom_domains": domains.get(w.id, 0),
            "fit": fit_plan(m, cpu, sources.get(w.id, 0), wh.get(w.id, 0) > 0, pub.get(w.id, 0), ml.get(w.id, 0),
                            autos.get(w.id, 0), domains.get(w.id, 0) > 0),
            "created_at": w.created_at,
        })
    return out


# ---------------------------------------------------------------------------
SEGMENT_FIELDS = [
    # key, label, type
    ("chats_30d", "Chats in last 30 days", "number"),
    ("chats_total", "Chats all time", "number"),
    ("last_active_days", "Days since last active", "number"),
    ("signup_days", "Days since sign-up", "number"),
    ("sources", "Data sources", "number"),
    ("dashboards", "Dashboards", "number"),
    ("published", "Published dashboards", "number"),
    ("ml_models", "ML models", "number"),
    ("automations", "Automations", "number"),
    ("workspaces", "Workspaces", "number"),
    ("corporate", "Corporate email domain", "bool"),
    ("warehouse", "Has a warehouse source", "bool"),
    ("lifecycle", "Lifecycle stage", "text"),
    ("status", "Status", "text"),
    ("domain", "Email domain", "text"),
    ("plan", "Plan", "text"),
]
_FIELD_TYPES = {k: t for k, _, t in SEGMENT_FIELDS}


def _match(row: dict, rule: dict) -> bool:
    f, op, v = rule.get("field"), rule.get("op"), rule.get("value")
    if f not in _FIELD_TYPES:
        return True
    x = row.get(f)
    t = _FIELD_TYPES[f]
    if t == "bool":
        want = op != "is_false" and str(v).lower() not in ("false", "no", "0")
        return bool(x) == want
    if t == "number":
        if x is None:
            x = 10**9 if f == "last_active_days" else 0
        try:
            v = float(v)
        except (TypeError, ValueError):
            return True
        return {"gt": x > v, "gte": x >= v, "lt": x < v, "lte": x <= v, "eq": x == v, "neq": x != v}.get(op, True)
    xs, vs = str(x or "").lower(), str(v or "").lower()
    if op == "contains":
        return vs in xs
    if op == "neq":
        return xs != vs
    return xs == vs


def segment_members(rows: list[dict], rules: list[dict]) -> list[dict]:
    rules = [r for r in (rules or []) if r.get("field")]
    return [r for r in rows if all(_match(r, rule) for rule in rules)]


def in_rollout(user_id: str, key: str, pct: int) -> bool:
    if pct >= 100:
        return True
    if pct <= 0:
        return False
    h = int(hashlib.sha256(f"{key}:{user_id}".encode()).hexdigest()[:8], 16) % 100
    return h < pct
