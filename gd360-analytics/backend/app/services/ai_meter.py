"""
AI metering (2026-10-10, Mission Control): every model call made through
ai_engine._call_llm is written to the ai_calls table - who made it, for which
feature, which model, tokens, an estimated cost and the latency.

Cost is an ESTIMATE from public list prices per million tokens (PRICES
below); the admin screen labels it that way. Metering never breaks a call:
any failure here is swallowed.

Also here: small cached reads of admin_settings (AI caps, kill switches),
used on every request, so they cost one query every 30 seconds at most.
"""
from __future__ import annotations

import threading
import time
from contextvars import ContextVar
from datetime import datetime

from ..config import get_settings

_ctx: ContextVar[dict] = ContextVar("gd360_ai_ctx", default={})
_local = threading.local()

# USD per 1M tokens (input, output). Matched by substring of the model name.
PRICES = [
    ("flash-lite", 0.10, 0.40),
    ("flash", 0.30, 2.50),
    ("gemini", 1.25, 10.00),
    ("gpt-oss-120b", 0.15, 0.75),
    ("gpt-oss-20b", 0.10, 0.50),
    ("gpt-oss", 0.15, 0.75),
    ("gpt-4o-mini", 0.15, 0.60),
    ("gpt-4o", 2.50, 10.00),
    ("haiku", 1.00, 5.00),
    ("sonnet", 3.00, 15.00),
    ("opus", 15.00, 75.00),
]

FEATURES = [
    ("/chat", "Ask anything"),
    ("/conversations", "Ask anything"),
    ("/projects", "Project runs"),
    ("/ml-studio", "ML Studio"),
    ("/ml-models", "ML Studio"),
    ("/automations", "Automations"),
    ("/goku", "Goku helper"),
    ("/dashboard-builder", "Dashboards"),
    ("/dashboards", "Dashboards"),
    ("/datasources", "Data prep"),
    ("/pipelines", "Pipelines"),
    ("/admin", "Ask Admin"),
    ("/initiatives", "Initiatives"),
    ("/gtm", "Initiatives"),
]


def feature_for_path(path: str) -> str:
    for prefix, name in FEATURES:
        if path.startswith(prefix):
            return name
    return "Other"


def set_context(user_id: str | None, feature: str):
    return _ctx.set({"user_id": user_id, "feature": feature})


def reset_context(token) -> None:
    try:
        _ctx.reset(token)
    except Exception:
        pass


def price_for(model: str | None) -> tuple[float, float]:
    m = (model or "").lower()
    for key, pin, pout in PRICES:
        if key in m:
            return pin, pout
    return 0.50, 1.50


def model_name(provider: str, override: str | None) -> str:
    s = get_settings()
    if override:
        return override
    return {"gemini": s.GEMINI_MODEL, "groq": s.GROQ_MODEL, "openai": s.OPENAI_MODEL,
            "anthropic": s.ANTHROPIC_MODEL}.get(provider, provider)


def begin() -> None:
    _local.usage = None


def note_usage(usage: dict | None) -> None:
    """Called by ai_engine right after a provider responds."""
    if isinstance(usage, dict):
        _local.usage = usage


def finish(provider: str, model: str, started: float, status: str, error: str | None) -> None:
    try:
        from ..database import SessionLocal
        from .. import models
        usage = getattr(_local, "usage", None) or {}
        tin = usage.get("prompt_tokens", usage.get("input_tokens"))
        tout = usage.get("completion_tokens", usage.get("output_tokens"))
        pin, pout = price_for(model)
        cost = ((tin or 0) * pin + (tout or 0) * pout) / 1_000_000 if (tin or tout) else None
        ctx = _ctx.get() or {}
        db = SessionLocal()
        try:
            db.add(models.AICall(
                user_id=ctx.get("user_id"), feature=ctx.get("feature") or "Background jobs", provider=provider,
                model=model, input_tokens=tin, output_tokens=tout, cost_usd=cost,
                latency_ms=int((time.time() - started) * 1000), status=status, error=(error or None) and error[:300],
            ))
            db.commit()
        finally:
            db.close()
    except Exception:
        pass


# ---- cached admin settings ------------------------------------------------
_cache: dict[str, tuple[float, object]] = {}
_TTL = 30.0


def get_setting(key: str, default=None):
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < _TTL:
        return hit[1]
    value = default
    try:
        from ..database import SessionLocal
        from .. import models
        db = SessionLocal()
        try:
            row = db.get(models.AdminSetting, key)
            if row is not None and row.value is not None:
                value = row.value
        finally:
            db.close()
    except Exception:
        pass
    _cache[key] = (time.time(), value)
    return value


def forget_setting(key: str) -> None:
    _cache.pop(key, None)


class AIBudgetExceeded(RuntimeError):
    pass


def check_budget() -> None:
    """Refuse a call when an admin has capped this person's monthly AI spend
    and it is used up. No cap set for them: nothing to check."""
    ctx = _ctx.get() or {}
    uid = ctx.get("user_id")
    if not uid:
        return
    caps = get_setting("ai_caps", {}) or {}
    cap = caps.get(uid)
    if cap in (None, "", 0):
        return
    try:
        from sqlalchemy import func
        from ..database import SessionLocal
        from .. import models
        start = datetime.utcnow().replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        db = SessionLocal()
        try:
            spent = db.query(func.coalesce(func.sum(models.AICall.cost_usd), 0.0)).filter(
                models.AICall.user_id == uid, models.AICall.created_at >= start).scalar() or 0.0
        finally:
            db.close()
    except Exception:
        return
    if float(spent) >= float(cap):
        raise AIBudgetExceeded("This account has reached its AI budget for the month. Contact support to raise it.")


KILL_SWITCHES = {
    "goku": ("/goku", "Goku helper"),
    "ml_studio": ("/ml-studio", "ML Studio"),
    "automations": ("/automations", "Automations"),
    "projects": ("/projects", "Project runs"),
    "apps": ("/apps", "Synced apps"),
}


def killed_feature(path: str, method: str) -> str | None:
    """Name of a feature an admin has paused, if this request would use it."""
    if method not in ("POST", "PUT", "PATCH"):
        return None
    off = get_setting("kill_switches", {}) or {}
    for key, (prefix, label) in KILL_SWITCHES.items():
        if off.get(key) and path.startswith(prefix):
            return label
    return None
