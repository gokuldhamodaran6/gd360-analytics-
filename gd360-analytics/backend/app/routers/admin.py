"""
Owner-only admin endpoints: how many people have signed up, how much of the
AI chat feature they are using, and where the product's real adoption and
trust signals stand. Restricted to the email addresses listed in the
ADMIN_EMAILS setting (see config.py) via get_current_admin.

Every number here is computed straight from the application's own tables -
nothing is estimated, sampled, or hardcoded. Where a metric would need data
this app does not track yet (for example, AI token spend), it is simply not
exposed rather than approximated, so nothing on this dashboard can silently
drift from what actually happened.
"""
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import case, func
from sqlalchemy.orm import Session

from .. import models
from ..database import get_db
from ..deps import get_current_admin

router = APIRouter(prefix="/admin", tags=["admin"])

# chart_type / action values this app can actually produce, used only to
# keep the breakdown queries' `filter(...in_(...))` calls self-documenting -
# never used to reject a value; an unexpected one still shows up in "Other".
_ACTION_KINDS = ("analyze", "transform")


@router.get("/stats")
def get_stats(db: Session = Depends(get_db), admin: models.User = Depends(get_current_admin)):
    now = datetime.utcnow()
    today_start = datetime(now.year, now.month, now.day)
    week_start = now - timedelta(days=7)
    month_start = now - timedelta(days=30)

    total_users = db.query(func.count(models.User.id)).scalar() or 0
    new_users_today = (
        db.query(func.count(models.User.id))
        .filter(models.User.created_at >= today_start)
        .scalar()
        or 0
    )
    new_users_7d = (
        db.query(func.count(models.User.id))
        .filter(models.User.created_at >= week_start)
        .scalar()
        or 0
    )

    total_prompts = (
        db.query(func.count(models.Message.id))
        .filter(models.Message.role == "user")
        .scalar()
        or 0
    )
    prompts_today = (
        db.query(func.count(models.Message.id))
        .filter(models.Message.role == "user", models.Message.created_at >= today_start)
        .scalar()
        or 0
    )
    prompts_7d = (
        db.query(func.count(models.Message.id))
        .filter(models.Message.role == "user", models.Message.created_at >= week_start)
        .scalar()
        or 0
    )

    total_datasources = db.query(func.count(models.DataSource.id)).scalar() or 0
    total_dashboards = db.query(func.count(models.Dashboard.id)).scalar() or 0

    # Distinct people who actually sent a prompt in the window - "active",
    # not just "signed up". Joined through Conversation since Message only
    # carries conversation_id, not owner_id directly.
    active_today = (
        db.query(func.count(func.distinct(models.Conversation.owner_id)))
        .join(models.Message, models.Message.conversation_id == models.Conversation.id)
        .filter(models.Message.role == "user", models.Message.created_at >= today_start)
        .scalar()
        or 0
    )
    active_7d = (
        db.query(func.count(func.distinct(models.Conversation.owner_id)))
        .join(models.Message, models.Message.conversation_id == models.Conversation.id)
        .filter(models.Message.role == "user", models.Message.created_at >= week_start)
        .scalar()
        or 0
    )
    # Same distinct-owner pattern as active_today/active_7d, just over a
    # 30-day window - powers the "Active users" KPI tile's own Today/7d/30d
    # toggle in the frontend. A real distinct count, not a sum of daily
    # counts (which would double-count anyone active on more than one day).
    active_30d = (
        db.query(func.count(func.distinct(models.Conversation.owner_id)))
        .join(models.Message, models.Message.conversation_id == models.Conversation.id)
        .filter(models.Message.role == "user", models.Message.created_at >= month_start)
        .scalar()
        or 0
    )

    # Activation funnel counts - how many distinct users have reached each
    # stage, ever (not windowed). Each is a simple distinct-owner count
    # against one table, so there is no join fan-out to worry about.
    activated_users = (
        db.query(func.count(func.distinct(models.DataSource.owner_id))).scalar() or 0
    )
    prompted_users = (
        db.query(func.count(func.distinct(models.Conversation.owner_id)))
        .join(models.Message, models.Message.conversation_id == models.Conversation.id)
        .filter(models.Message.role == "user")
        .scalar()
        or 0
    )
    dashboarded_users = (
        db.query(func.count(func.distinct(models.Dashboard.owner_id))).scalar() or 0
    )

    total_verify_checks = db.query(func.coalesce(func.sum(models.Message.verified_count), 0)).scalar() or 0

    return {
        "total_users": total_users,
        "new_users_today": new_users_today,
        "new_users_7d": new_users_7d,
        "total_prompts": total_prompts,
        "prompts_today": prompts_today,
        "prompts_7d": prompts_7d,
        "total_datasources": total_datasources,
        "total_dashboards": total_dashboards,
        "active_users_today": active_today,
        "active_users_7d": active_7d,
        "active_users_30d": active_30d,
        "total_verify_checks": total_verify_checks,
        "funnel": {
            "signed_up": total_users,
            "connected_data": activated_users,
            "ran_a_prompt": prompted_users,
            "saved_a_dashboard": dashboarded_users,
        },
    }


@router.get("/users")
def list_users(db: Session = Depends(get_db), admin: models.User = Depends(get_current_admin)):
    rows = (
        db.query(
            models.User.id,
            models.User.email,
            models.User.full_name,
            models.User.company,
            models.User.created_at,
            func.count(models.Message.id).label("prompt_count"),
            func.max(models.Message.created_at).label("last_prompt_at"),
        )
        .outerjoin(models.Conversation, models.Conversation.owner_id == models.User.id)
        .outerjoin(
            models.Message,
            (models.Message.conversation_id == models.Conversation.id) & (models.Message.role == "user"),
        )
        .group_by(
            models.User.id,
            models.User.email,
            models.User.full_name,
            models.User.company,
            models.User.created_at,
        )
        .order_by(func.count(models.Message.id).desc())
        .all()
    )

    # Per-user counts computed as separate, single-table aggregates rather
    # than joined onto the query above - joining DataSource/Dashboard rows
    # onto the Conversation/Message join above would multiply the prompt
    # count by however many datasources or dashboards that user has (join
    # fan-out), silently inflating it. Each dict below is keyed by owner_id
    # so it merges cleanly in Python instead.
    ds_counts = dict(
        db.query(models.DataSource.owner_id, func.count(models.DataSource.id))
        .group_by(models.DataSource.owner_id)
        .all()
    )
    dash_counts = dict(
        db.query(models.Dashboard.owner_id, func.count(models.Dashboard.id))
        .group_by(models.Dashboard.owner_id)
        .all()
    )
    verify_counts = dict(
        db.query(models.Conversation.owner_id, func.coalesce(func.sum(models.Message.verified_count), 0))
        .join(models.Message, models.Message.conversation_id == models.Conversation.id)
        .group_by(models.Conversation.owner_id)
        .all()
    )

    return [
        {
            "id": r.id,
            "email": r.email,
            "full_name": r.full_name,
            "company": r.company,
            "created_at": r.created_at.isoformat() if r.created_at else None,
            "prompt_count": r.prompt_count or 0,
            "last_prompt_at": r.last_prompt_at.isoformat() if r.last_prompt_at else None,
            "datasource_count": ds_counts.get(r.id, 0),
            "dashboard_count": dash_counts.get(r.id, 0),
            "verified_count": int(verify_counts.get(r.id, 0) or 0),
        }
        for r in rows
    ]


@router.get("/usage-timeseries")
def usage_timeseries(
    days: int = 14,
    db: Session = Depends(get_db),
    admin: models.User = Depends(get_current_admin),
):
    """One row per day: how many prompts were sent, the analyze/transform
    split of the ANSWERS to those prompts, and how many distinct people
    were active. Two separate day-grouped queries merged in Python rather
    than one joined query, because "prompt sent" (role=user) and "action
    taken" (role=assistant) live on different rows of the same table -
    joining them onto one grouped query would double-count."""
    since = datetime.utcnow() - timedelta(days=days)

    prompt_rows = (
        db.query(
            func.date(models.Message.created_at).label("day"),
            func.count(models.Message.id).label("count"),
            func.count(func.distinct(models.Conversation.owner_id)).label("active_users"),
        )
        .join(models.Conversation, models.Conversation.id == models.Message.conversation_id)
        .filter(models.Message.role == "user", models.Message.created_at >= since)
        .group_by(func.date(models.Message.created_at))
        .all()
    )
    action_rows = (
        db.query(
            func.date(models.Message.created_at).label("day"),
            func.sum(case((models.Message.action == "analyze", 1), else_=0)).label("analyze_count"),
            func.sum(case((models.Message.action == "transform", 1), else_=0)).label("transform_count"),
        )
        .filter(
            models.Message.role == "assistant",
            models.Message.action.in_(_ACTION_KINDS),
            models.Message.created_at >= since,
        )
        .group_by(func.date(models.Message.created_at))
        .all()
    )
    actions_by_day = {str(r.day): (r.analyze_count or 0, r.transform_count or 0) for r in action_rows}

    out = []
    for r in sorted(prompt_rows, key=lambda r: str(r.day)):
        day = str(r.day)
        analyze_count, transform_count = actions_by_day.get(day, (0, 0))
        out.append({
            "day": day,
            "count": r.count,
            "active_users": r.active_users,
            "analyze_count": analyze_count,
            "transform_count": transform_count,
        })
    return out


@router.get("/growth-timeseries")
def growth_timeseries(
    days: int = 30,
    db: Session = Depends(get_db),
    admin: models.User = Depends(get_current_admin),
):
    """Daily new signups plus a running cumulative total - the cumulative
    line starts from the real total as of the window start, not from zero,
    so it reads correctly even on a short window."""
    since = datetime.utcnow() - timedelta(days=days)
    users_before = db.query(func.count(models.User.id)).filter(models.User.created_at < since).scalar() or 0

    rows = (
        db.query(
            func.date(models.User.created_at).label("day"),
            func.count(models.User.id).label("new_users"),
        )
        .filter(models.User.created_at >= since)
        .group_by(func.date(models.User.created_at))
        .order_by(func.date(models.User.created_at))
        .all()
    )

    out = []
    running = users_before
    for r in rows:
        running += r.new_users
        out.append({"day": str(r.day), "new_users": r.new_users, "cumulative_users": running})
    return out


@router.get("/breakdowns")
def breakdowns(db: Session = Depends(get_db), admin: models.User = Depends(get_current_admin)):
    """Everything that is naturally a "which kind" question rather than a
    "how many over time" one: what people connect, what they ask for, and
    how much they lean on the trust features. Bundled into one call since
    each piece is a small, cheap aggregate and the admin page always wants
    all of them together."""
    datasource_kinds = [
        {"kind": kind or "unknown", "count": count}
        for kind, count in (
            db.query(models.DataSource.kind, func.count(models.DataSource.id))
            .group_by(models.DataSource.kind)
            .order_by(func.count(models.DataSource.id).desc())
            .all()
        )
    ]

    action_mix = [
        {"action": action, "count": count}
        for action, count in (
            db.query(models.Message.action, func.count(models.Message.id))
            .filter(models.Message.role == "assistant", models.Message.action.in_(_ACTION_KINDS))
            .group_by(models.Message.action)
            .all()
        )
    ]

    # Every distinct chart type actually rendered, most-used first. Capped
    # to the top 12 in the response - the frontend folds anything beyond
    # that into "Other" rather than ever drawing more than a handful of
    # bars (see the dataviz guidance this app already follows elsewhere:
    # past ~7-8 categories, fold the tail rather than adding more colors).
    chart_type_rows = (
        db.query(models.Message.chart_type, func.count(models.Message.id))
        .filter(models.Message.role == "assistant", models.Message.chart_type.isnot(None))
        .group_by(models.Message.chart_type)
        .order_by(func.count(models.Message.id).desc())
        .limit(12)
        .all()
    )
    chart_types = [{"chart_type": ct, "count": count} for ct, count in chart_type_rows]

    goku_total_questions = (
        db.query(func.count(models.GokuMessage.id)).filter(models.GokuMessage.role == "user").scalar() or 0
    )
    goku_users = db.query(func.count(func.distinct(models.GokuMessage.owner_id))).scalar() or 0

    total_verify_checks = db.query(func.coalesce(func.sum(models.Message.verified_count), 0)).scalar() or 0
    messages_ever_verified = (
        db.query(func.count(models.Message.id)).filter(models.Message.verified_count > 0).scalar() or 0
    )
    verifiable_messages = (
        db.query(func.count(models.Message.id))
        .filter(models.Message.role == "assistant", models.Message.action.in_(_ACTION_KINDS))
        .scalar()
        or 0
    )

    return {
        "datasource_kinds": datasource_kinds,
        "action_mix": action_mix,
        "chart_types": chart_types,
        "goku": {"total_questions": goku_total_questions, "users": goku_users},
        "verification": {
            "total_checks": int(total_verify_checks),
            "messages_ever_verified": messages_ever_verified,
            "verifiable_messages": verifiable_messages,
        },
    }


@router.get("/activity-feed")
def activity_feed(
    limit: int = 30,
    db: Session = Depends(get_db),
    admin: models.User = Depends(get_current_admin),
):
    """A merged, real timeline of what has actually happened in the app
    recently - signups, new data source connections, and saved dashboards -
    each pulled straight from its own table's created_at and merged by
    time. There is no separate "events" table, so this is built from the
    same rows every other admin number comes from, not a parallel log that
    could drift from them."""
    limit = max(1, min(limit, 100))

    signups = (
        db.query(models.User.id, models.User.email, models.User.full_name, models.User.created_at)
        .order_by(models.User.created_at.desc())
        .limit(limit)
        .all()
    )
    connects = (
        db.query(
            models.DataSource.id,
            models.DataSource.name,
            models.DataSource.kind,
            models.DataSource.created_at,
            models.User.email,
            models.User.full_name,
        )
        .join(models.User, models.User.id == models.DataSource.owner_id)
        .order_by(models.DataSource.created_at.desc())
        .limit(limit)
        .all()
    )
    saves = (
        db.query(
            models.Dashboard.id,
            models.Dashboard.name,
            models.Dashboard.created_at,
            models.User.email,
            models.User.full_name,
        )
        .join(models.User, models.User.id == models.Dashboard.owner_id)
        .order_by(models.Dashboard.created_at.desc())
        .limit(limit)
        .all()
    )

    events = []
    for r in signups:
        who = r.full_name or r.email
        events.append({
            "type": "signup",
            "at": r.created_at.isoformat() if r.created_at else None,
            "text": f"{who} signed up",
        })
    for r in connects:
        who = r.full_name or r.email
        events.append({
            "type": "connected_data",
            "at": r.created_at.isoformat() if r.created_at else None,
            "text": f"{who} connected a {r.kind} data source — “{r.name}”",
        })
    for r in saves:
        who = r.full_name or r.email
        events.append({
            "type": "saved_dashboard",
            "at": r.created_at.isoformat() if r.created_at else None,
            "text": f"{who} saved a dashboard — “{r.name}”",
        })

    events.sort(key=lambda e: e["at"] or "", reverse=True)
    return events[:limit]
