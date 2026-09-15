"""
Owner-only admin endpoints: how many people have signed up, and how much
of the AI chat feature they are using. Restricted to the email addresses
listed in the ADMIN_EMAILS setting (see config.py) via get_current_admin.
"""
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import func
from sqlalchemy.orm import Session

from .. import models
from ..database import get_db
from ..deps import get_current_admin

router = APIRouter(prefix="/admin", tags=["admin"])


@router.get("/stats")
def get_stats(db: Session = Depends(get_db), admin: models.User = Depends(get_current_admin)):
    now = datetime.utcnow()
    today_start = datetime(now.year, now.month, now.day)
    week_start = now - timedelta(days=7)

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

    return {
        "total_users": total_users,
        "new_users_today": new_users_today,
        "new_users_7d": new_users_7d,
        "total_prompts": total_prompts,
        "prompts_today": prompts_today,
        "prompts_7d": prompts_7d,
        "total_datasources": total_datasources,
        "total_dashboards": total_dashboards,
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
    return [
        {
            "id": r.id,
            "email": r.email,
            "full_name": r.full_name,
            "company": r.company,
            "created_at": r.created_at.isoformat() if r.created_at else None,
            "prompt_count": r.prompt_count or 0,
            "last_prompt_at": r.last_prompt_at.isoformat() if r.last_prompt_at else None,
        }
        for r in rows
    ]


@router.get("/usage-timeseries")
def usage_timeseries(
    days: int = 14,
    db: Session = Depends(get_db),
    admin: models.User = Depends(get_current_admin),
):
    since = datetime.utcnow() - timedelta(days=days)
    rows = (
        db.query(
            func.date(models.Message.created_at).label("day"),
            func.count(models.Message.id).label("count"),
        )
        .filter(models.Message.role == "user", models.Message.created_at >= since)
        .group_by(func.date(models.Message.created_at))
        .order_by(func.date(models.Message.created_at))
        .all()
    )
    return [{"day": str(r.day), "count": r.count} for r in rows]
