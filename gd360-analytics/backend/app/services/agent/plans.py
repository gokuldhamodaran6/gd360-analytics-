"""2026-10-14 (R46): plans, limits and usage.

One product for individuals, teams and enterprises: every feature is on every
plan; plans differ by limits, governance and where it runs. This module is the
ONE place limits are read (`can`), so a cap is never scattered through the UI.

Until billing exists every account is on settings.PLAN_DEFAULT; an
EntitlementOverride row (workspace_id, key="plan", value=<plan>, status="active")
moves a workspace to another plan. With settings.PLAN_ENFORCE off, usage is
shown but nothing is blocked.
"""
from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import func
from sqlalchemy.orm import Session

from ... import models
from ...config import get_settings

settings = get_settings()

# limit value None = unlimited (fair use)
PLANS: dict[str, dict] = {
    "free": {
        "label": "Free", "price": {"usd_month": 0, "inr_month": 0},
        "who": "Individuals",
        "limits": {"seats": 1, "sources": 3, "rows_per_source": 200_000, "file_mb": 50,
                   "questions_per_day": 40, "models_per_month": 3, "spaces": 1, "dashboards": 5, "automations": 2},
        "model_tier": "standard", "support": "community",
    },
    "pro": {
        "label": "Pro", "price": {"usd_month": 29, "inr_month": 1499},
        "who": "Professionals and freelancers",
        "limits": {"seats": 1, "sources": 10, "rows_per_source": 5_000_000, "file_mb": 250,
                   "questions_per_day": None, "models_per_month": None, "spaces": None, "dashboards": None, "automations": None},
        "model_tier": "strongest", "support": "email, 1 day",
    },
    "team": {
        "label": "Team", "price": {"usd_seat_month": 49, "min_seats": 3},
        "who": "Teams, SMB to mid-market",
        "limits": {"seats": 500, "sources": None, "rows_per_source": 50_000_000, "file_mb": 1000,
                   "questions_per_day": None, "models_per_month": None, "spaces": None, "dashboards": None, "automations": None},
        "model_tier": "strongest", "support": "chat, 4 h",
    },
    "enterprise": {
        "label": "Enterprise", "price": {"platform_fee": True, "annual": True},
        "who": "Enterprises, public sector, regulated",
        "limits": {"seats": None, "sources": None, "rows_per_source": None, "file_mb": 5000,
                   "questions_per_day": None, "models_per_month": None, "spaces": None, "dashboards": None, "automations": None},
        "model_tier": "strongest or your own keys", "support": "SLA, success manager, consulting",
    },
}

LIMIT_LABELS = {
    "seats": "people", "sources": "data sources", "rows_per_source": "rows per source", "file_mb": "MB per file",
    "questions_per_day": "questions a day", "models_per_month": "models a month", "spaces": "Spaces",
    "dashboards": "dashboards", "automations": "automations",
}


class PlanLimit(Exception):
    def __init__(self, key: str, limit: int, plan: str):
        self.key, self.limit, self.plan = key, limit, plan
        super().__init__(f"{LIMIT_LABELS.get(key, key)}: the {PLANS[plan]['label']} plan allows {limit}.")


def plan_key(db: Session, user: models.User, workspace_id: str | None = None) -> str:
    """The plan this person is on: an active override on their workspace, else the default."""
    default = settings.PLAN_DEFAULT if settings.PLAN_DEFAULT in PLANS else "team"
    ws_ids = [workspace_id] if workspace_id else []
    try:
        ws_ids += [m.workspace_id for m in db.query(models.WorkspaceMember).filter(models.WorkspaceMember.user_id == user.id).all()]
    except Exception:  # noqa: BLE001 - a plan lookup must never block a question
        pass
    if not ws_ids:
        return default
    try:
        row = (db.query(models.EntitlementOverride)
               .filter(models.EntitlementOverride.workspace_id.in_(ws_ids), models.EntitlementOverride.key == "plan",
                       models.EntitlementOverride.status == "active")
               .order_by(models.EntitlementOverride.created_at.desc()).first())
    except Exception:  # noqa: BLE001
        row = None
    if row and row.value in PLANS and (row.expires_at is None or row.expires_at > datetime.utcnow()):
        return row.value
    return default


def usage(db: Session, user: models.User) -> dict:
    """Today's and this month's counts, cheap enough to read on every home load."""
    now = datetime.utcnow()
    day0 = now.replace(hour=0, minute=0, second=0, microsecond=0)
    month0 = day0.replace(day=1)
    out = {"questions_today": 0, "models_this_month": 0, "sources": 0, "dashboards": 0, "automations": 0, "spaces": 0}
    try:
        out["questions_today"] = (db.query(func.count(models.ProjectRun.id))
                                  .filter(models.ProjectRun.owner_id == user.id, models.ProjectRun.created_at >= day0).scalar() or 0)
        out["questions_today"] += (
            db.query(func.count(models.Message.id)).join(models.Conversation, models.Conversation.id == models.Message.conversation_id)
            .filter(models.Conversation.owner_id == user.id, models.Message.role == "assistant",
                    models.Message.created_at >= day0, models.Message.action == "v2:knowledge").scalar() or 0)
    except Exception:  # noqa: BLE001
        pass
    try:
        out["models_this_month"] = (db.query(func.count(models.MLModel.id))
                                    .filter(models.MLModel.owner_id == user.id, models.MLModel.created_at >= month0).scalar() or 0)
    except Exception:  # noqa: BLE001
        pass
    for key, model in (("sources", models.DataSource), ("dashboards", models.Dashboard), ("automations", models.Automation),
                       ("spaces", models.Space)):
        try:
            out[key] = db.query(func.count(model.id)).filter(model.owner_id == user.id).scalar() or 0
        except Exception:  # noqa: BLE001
            pass
    return out


def summary(db: Session, user: models.User, workspace_id: str | None = None) -> dict:
    key = plan_key(db, user, workspace_id)
    p = PLANS[key]
    u = usage(db, user)
    limits = p["limits"]
    meters = []
    for k, used in (("questions_per_day", u["questions_today"]), ("models_per_month", u["models_this_month"]),
                    ("sources", u["sources"]), ("dashboards", u["dashboards"]), ("automations", u["automations"]), ("spaces", u["spaces"])):
        lim = limits.get(k)
        meters.append({"key": k, "label": LIMIT_LABELS[k], "used": int(used), "limit": lim,
                       "near": bool(lim and used >= 0.8 * lim), "over": bool(lim and used >= lim)})
    return {"plan": key, "label": p["label"], "who": p["who"], "price": p["price"], "model_tier": p["model_tier"],
            "support": p["support"], "enforced": bool(settings.PLAN_ENFORCE), "limits": limits, "meters": meters,
            "all_features": True, "plans": {k: {"label": v["label"], "price": v["price"], "limits": v["limits"], "who": v["who"]}
                                            for k, v in PLANS.items()}}


def can(db: Session, user: models.User, key: str, n: int = 1, workspace_id: str | None = None) -> None:
    """Raises PlanLimit when adding `n` more of `key` would pass the plan's limit (only when enforced)."""
    if not settings.PLAN_ENFORCE:
        return
    plan = plan_key(db, user, workspace_id)
    lim = PLANS[plan]["limits"].get(key)
    if lim is None:
        return
    u = usage(db, user)
    used = {"questions_per_day": u["questions_today"], "models_per_month": u["models_this_month"]}.get(key, u.get(key, 0))
    if used + n > lim:
        raise PlanLimit(key, lim, plan)


def rows_cap(db: Session, user: models.User) -> int | None:
    return PLANS[plan_key(db, user)]["limits"].get("rows_per_source")


__all__ = ["PLANS", "PlanLimit", "plan_key", "usage", "summary", "can", "rows_cap", "timedelta"]
