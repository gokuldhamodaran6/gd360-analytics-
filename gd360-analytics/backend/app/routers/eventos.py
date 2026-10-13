"""
Event OS (2026-10-13, round 42) - see services/eventos/__init__.py.

Signed-in (workspace members; viewers read, members edit):
  POST   /initiatives/eventos/sample                 a complete sample event (before | live | done)
  GET    /initiatives/{id}/eventos/overview          Event 360: before / during / after on one screen
  GET    .../growth  .../buzz  .../demand  .../live  .../sponsors  .../report
  GET    .../export.xlsx                             the A to Z workbook
  GET    .../config   PATCH .../config               setup: format, times, capacity, hashtags, codes, costs ...
  goals, sessions, sponsors, brand images, tickets, posts, agent actions, Zoom import, learnings, clone - below

Public (no login) are in eventos_public.py.
"""
from __future__ import annotations

import csv
import io
import re
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import models
from ..database import get_db
from ..deps import get_current_user
from ..services import workspace_access
from ..services.audit import log_audit_event
from ..services.automations import app_url
from ..services.eventos import agent, core, export, sample, score, social, views
from ..services.eventos.ctx import METRICS, Ctx
from .initiatives import author, initiative_for, workspace_for

router = APIRouter(prefix="/initiatives", tags=["eventos"])
MAX_IMAGE = 3 * 1024 * 1024


def _ctx(db: Session, user: models.User, initiative_id: str, edit: bool = False) -> Ctx:
    i = initiative_for(db, user, initiative_id, edit=edit)
    return Ctx(db, i)


def _can_edit(db: Session, user: models.User, i: models.Initiative) -> bool:
    role = workspace_access.member_role(db, user.id, i.workspace_id)
    ws = db.get(models.Workspace, i.workspace_id) if i.workspace_id else None
    return role in ("owner", "admin", "member") or bool(ws and ws.owner_id == user.id)


def _links(ctx: Ctx) -> dict:
    base = app_url()
    i, cfg = ctx.i, ctx.cfg
    return {"registration": f"{base}/e/{i.public_token}", "staff": f"{base}/staff/{i.public_token}?k={cfg.staff_key}",
            "share": f"{base}/x/{cfg.share_token}" if cfg.share_enabled else None, "share_enabled": bool(cfg.share_enabled),
            "survey": f"{base}/f/{cfg.survey_token}", "walk_in": f"{base}/w/{i.public_token}?k={i.walkin_key}"}


def _done(db: Session, ctx: Ctx, payload: dict, user: models.User) -> dict:
    payload["links"] = _links(ctx)
    payload["can_edit"] = _can_edit(db, user, ctx.i)
    db.commit()
    return payload


# ================================================================= sample ==

class SampleBody(BaseModel):
    workspace_id: str | None = None
    stage: str = "done"


@router.post("/eventos/sample")
def make_sample(body: SampleBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    ws = workspace_for(db, user, body.workspace_id, edit=True)
    stage = body.stage if body.stage in ("before", "live", "done") else "done"
    i = sample.create(db, user, ws, stage)
    log_audit_event(db, actor=user, action="initiative.sample_event", workspace_id=ws, target_type="initiative", target_id=i.id,
                    metadata={"stage": stage})
    db.commit()
    return {"id": i.id}


# ================================================================ screens ==

@router.get("/{initiative_id}/eventos/overview")
def overview(initiative_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    ctx = _ctx(db, user, initiative_id)
    return _done(db, ctx, views.overview(ctx), user)


@router.get("/{initiative_id}/eventos/growth")
def growth(initiative_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    ctx = _ctx(db, user, initiative_id)
    return _done(db, ctx, views.growth(ctx), user)


@router.get("/{initiative_id}/eventos/buzz")
def buzz(initiative_id: str, phase: str | None = None, state: str | None = None, platform: str | None = None,
         limit: int = 60, offset: int = 0, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    ctx = _ctx(db, user, initiative_id)
    return _done(db, ctx, views.buzz(ctx, phase, state, platform, min(max(limit, 1), 200), max(offset, 0)), user)


@router.get("/{initiative_id}/eventos/demand")
def demand(initiative_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    ctx = _ctx(db, user, initiative_id)
    return _done(db, ctx, views.demand(ctx), user)


@router.get("/{initiative_id}/eventos/live")
def live(initiative_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    ctx = _ctx(db, user, initiative_id)
    return _done(db, ctx, views.live(ctx), user)


@router.get("/{initiative_id}/eventos/sponsors")
def sponsors(initiative_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    ctx = _ctx(db, user, initiative_id)
    return _done(db, ctx, views.sponsors(ctx), user)


@router.get("/{initiative_id}/eventos/report")
def report(initiative_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    ctx = _ctx(db, user, initiative_id)
    return _done(db, ctx, views.report(ctx), user)


@router.get("/{initiative_id}/eventos/export.xlsx")
def export_xlsx(initiative_id: str, sections: str | None = None, mask: bool = True, db: Session = Depends(get_db),
                user: models.User = Depends(get_current_user)):
    ctx = _ctx(db, user, initiative_id)
    want = [s.strip().upper() for s in (sections or "").split(",") if s.strip().upper() in export.SECTIONS] or None
    raw = export.workbook(ctx, want, mask=mask)
    log_audit_event(db, actor=user, action="initiative.event_export", workspace_id=ctx.i.workspace_id, target_type="initiative",
                    target_id=ctx.i.id, metadata={"sections": want or "all", "masked": mask})
    db.commit()
    name = re.sub(r"[^A-Za-z0-9]+", "-", ctx.i.title).strip("-")[:60] or "event"
    return Response(raw, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f'attachment; filename="{name}-A-to-Z.xlsx"'})


@router.get("/eventos/catalog")
def catalog(user: models.User = Depends(get_current_user)):
    return {"formats": core.FORMATS, "modes": core.MODES, "tiers": core.TIERS, "truth": core.TRUTH,
            "metrics": {k: {"label": v[0], "unit": v[1], "truth": v[2], "phase": v[3], "higher": v[4]} for k, v in METRICS.items()},
            "sections": export.SECTIONS}


# ================================================================= config ==

def _cfg_row(ctx: Ctx) -> dict:
    c = ctx.cfg
    d = c.data or {}
    return {"format": c.format, "mode": c.mode, "starts_at": c.starts_at.isoformat() if c.starts_at else None,
            "ends_at": c.ends_at.isoformat() if c.ends_at else None, "timezone": c.timezone, "capacity": c.capacity,
            "fire_limit": c.fire_limit, "post_window_days": c.post_window_days, "code": c.code, "hashtags": c.hashtags or [],
            "keywords": c.keywords or [], "promo_codes": c.promo_codes or [], "handles": c.handles or {}, "ad_campaigns": c.ad_campaigns or [],
            "zones": c.zones or [], "share_enabled": bool(c.share_enabled),
            "costs": d.get("costs") or [], "income": d.get("income") or [], "prices": d.get("prices") or {}, "currency": d.get("currency") or "INR",
            "win_rate": d.get("win_rate") or 0.22, "city": d.get("city"), "join_url": d.get("join_url"),
            "zoom_secret_set": bool(d.get("zoom_secret")), "sample": bool(d.get("sample")),
            "naming_rule": f"INIT-{(c.code or 'EVT').upper()}-"}


@router.get("/{initiative_id}/eventos/config")
def get_config(initiative_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    ctx = _ctx(db, user, initiative_id)
    ads = ctx.ads()
    assets = db.query(models.EventAsset).filter(models.EventAsset.initiative_id == ctx.i.id).order_by(models.EventAsset.created_at).all()
    out = {"config": _cfg_row(ctx), "event": views.event_head(ctx), "checks": views.setup_checks(ctx),
           "ads": {"campaigns": ads["campaigns"], "unmatched": ads["unmatched"], "sources": ads["sources"], "total": ads["total"]},
           "assets": [{"id": a.id, "kind": a.kind, "label": a.label, "url": f"/public/eventos/asset/{a.id}"} for a in assets],
           "scan": (ctx.cfg.data or {}).get("last_scan"), "last_scan_at": (ctx.cfg.data or {}).get("last_scan_at"),
           "social_rules": social.rules_for(db, ctx.i, ctx.cfg)}
    out["social_rules"].pop("links", None)
    return _done(db, ctx, out, user)


class ConfigBody(BaseModel):
    format: str | None = None
    mode: str | None = None
    starts_at: str | None = None
    ends_at: str | None = None
    timezone: str | None = Field(default=None, max_length=60)
    capacity: int | None = None
    fire_limit: int | None = None
    post_window_days: int | None = None
    code: str | None = Field(default=None, max_length=20)
    hashtags: list[str] | None = None
    keywords: list[str] | None = None
    promo_codes: list[str] | None = None
    handles: dict | None = None
    ad_campaigns: list[str] | None = None
    zones: list[dict] | None = None
    share_enabled: bool | None = None
    costs: list[dict] | None = None
    income: list[dict] | None = None
    prices: dict | None = None
    currency: str | None = Field(default=None, max_length=6)
    win_rate: float | None = None
    city: str | None = Field(default=None, max_length=80)
    join_url: str | None = Field(default=None, max_length=600)
    zoom_secret: str | None = Field(default=None, max_length=200)


def _dt(v: str | None) -> datetime | None:
    if not v:
        return None
    try:
        return datetime.fromisoformat(v.replace("Z", "")[:19])
    except ValueError:
        raise HTTPException(422, "Use a time like 2026-11-06T09:30.")


def _strs(xs, n=30, size=80) -> list[str]:
    return [str(x).strip()[:size] for x in (xs or []) if str(x).strip()][:n]


@router.patch("/{initiative_id}/eventos/config")
def patch_config(initiative_id: str, body: ConfigBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    i = initiative_for(db, user, initiative_id, edit=True)
    cfg = core.ensure_config(db, i)
    d = body.model_dump(exclude_unset=True)
    if "format" in d:
        if d["format"] not in core.FORMATS:
            raise HTTPException(422, "Unknown format.")
        cfg.format = d["format"]
    if "mode" in d:
        if d["mode"] not in core.MODES:
            raise HTTPException(422, "Mode is solo, team, pro or mega.")
        cfg.mode = d["mode"]
    if "starts_at" in d:
        cfg.starts_at = _dt(d["starts_at"])
        if cfg.starts_at:
            i.key_date = cfg.starts_at.date().isoformat()
    if "ends_at" in d:
        cfg.ends_at = _dt(d["ends_at"])
    if cfg.starts_at and cfg.ends_at and cfg.ends_at <= cfg.starts_at:
        raise HTTPException(422, "The end has to be after the start.")
    if "timezone" in d:
        cfg.timezone = (d["timezone"] or "").strip() or "UTC"
    for f in ("capacity", "fire_limit"):
        if f in d:
            v = d[f]
            if v is not None and (v < 0 or v > 2_000_000):
                raise HTTPException(422, "That number looks wrong.")
            setattr(cfg, f, v)
    if "post_window_days" in d and d["post_window_days"] is not None:
        cfg.post_window_days = max(1, min(int(d["post_window_days"]), 365))
    if "code" in d:
        code = re.sub(r"[^A-Za-z0-9]", "", d["code"] or "").upper()[:16]
        if not code:
            raise HTTPException(422, "The event code needs letters or numbers.")
        cfg.code = code
    if "hashtags" in d:
        cfg.hashtags = ["#" + re.sub(r"[^\w]", "", h.lstrip("#")) for h in _strs(d["hashtags"], 12, 60) if re.sub(r"[^\w]", "", h.lstrip("#"))]
    if "keywords" in d:
        cfg.keywords = [k.lower() for k in _strs(d["keywords"], 20, 80)]
    if "promo_codes" in d:
        cfg.promo_codes = [c.upper() for c in _strs(d["promo_codes"], 30, 30)]
    if "handles" in d:
        h = d["handles"] or {}
        cfg.handles = {k: _strs(h.get(k), 200, 80) for k in ("speakers", "sponsors", "press", "creators")}
    if "ad_campaigns" in d:
        cfg.ad_campaigns = _strs(d["ad_campaigns"], 100, 160)
    if "zones" in d:
        zs = []
        for n, z in enumerate((d["zones"] or [])[:40]):
            name = str(z.get("name") or "").strip()[:60]
            if not name:
                continue
            cap = z.get("capacity")
            zs.append({"id": str(z.get("id") or re.sub(r"[^a-z0-9]+", "_", name.lower()) or f"z{n}")[:30], "name": name,
                       "capacity": int(cap) if cap not in (None, "") else None, "outside": bool(z.get("outside"))})
        cfg.zones = zs
    if "share_enabled" in d:
        cfg.share_enabled = bool(d["share_enabled"])
    data = dict(cfg.data or {})
    for f in ("costs", "income"):
        if f in d:
            rows = []
            for c in (d[f] or [])[:60]:
                try:
                    amt = float(c.get("amount") or 0)
                except (TypeError, ValueError):
                    raise HTTPException(422, "Amounts are numbers.")
                rows.append({"label": str(c.get("label") or "Line")[:80], "amount": amt,
                             "channel": (str(c.get("channel"))[:40] if c.get("channel") else None),
                             "kind": "marketing" if c.get("channel") or c.get("kind") == "marketing" else "cost"})
            data[f] = rows
    if "prices" in d:
        data["prices"] = {k: float(v) for k, v in (d["prices"] or {}).items() if k in ("vip", "paid") and v not in (None, "")}
    for f in ("currency", "city", "join_url"):
        if f in d:
            data[f] = (d[f] or "").strip() or None
    if "win_rate" in d and d["win_rate"] is not None:
        data["win_rate"] = max(0.0, min(float(d["win_rate"]), 1.0))
    if "zoom_secret" in d:
        data["zoom_secret"] = (d["zoom_secret"] or "").strip() or None
    cfg.data = data
    cfg.updated_at = datetime.utcnow()
    i.updated_at = datetime.utcnow()
    db.commit()
    return {"ok": True}


@router.post("/{initiative_id}/eventos/config/new-links")
def new_links(initiative_id: str, which: str = "staff", db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    """Replaces the staff-app key or the share link (the old one stops working)."""
    import secrets
    i = initiative_for(db, user, initiative_id, edit=True)
    cfg = core.ensure_config(db, i)
    if which == "share":
        cfg.share_token = secrets.token_urlsafe(18)
    else:
        cfg.staff_key = secrets.token_urlsafe(18)
    log_audit_event(db, actor=user, action=f"initiative.event_{which}_link_reset", workspace_id=i.workspace_id, target_id=i.id)
    db.commit()
    return {"ok": True}


# ================================================================== goals ==

class GoalBody(BaseModel):
    owner_name: str | None = Field(default=None, max_length=80)
    owner_role: str | None = Field(default=None, max_length=60)
    owner_email: str | None = Field(default=None, max_length=200)
    label: str | None = Field(default=None, max_length=120)
    metric: str | None = None
    unit: str | None = Field(default=None, max_length=20)
    target: float | None = None
    low: float | None = None
    high: float | None = None
    weight: float | None = None
    lower_is_better: bool | None = None
    safety: bool | None = None
    actual_typed: float | None = None
    position: int | None = None


def _check_range(lo: float, tgt: float, hi: float, lower: bool):
    if lower:
        if not (lo >= tgt >= hi):
            raise HTTPException(422, "Lower is better here, so the range runs from the worst (largest) through the target to the best (smallest).")
    elif not (lo <= tgt <= hi):
        raise HTTPException(422, "The target sits inside the range: low end ≤ target ≤ good end.")


@router.get("/{initiative_id}/eventos/goals")
def goals(initiative_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    ctx = _ctx(db, user, initiative_id)
    blk = views._score_block(ctx)
    return _done(db, ctx, {"event": views.event_head(ctx), **blk, "suggested": score.suggest(ctx) if not ctx.goals else [],
                           "metrics": {k: {"label": v[0], "unit": v[1], "truth": v[2], "phase": v[3], "higher": v[4]} for k, v in METRICS.items()},
                           "sign_base": f"{app_url()}/sign/"}, user)


@router.post("/{initiative_id}/eventos/goals")
def add_goal(initiative_id: str, body: GoalBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    i = initiative_for(db, user, initiative_id, edit=True)
    if not (body.owner_name and body.label and body.target is not None and body.low is not None and body.high is not None):
        raise HTTPException(422, "A goal needs an owner, what they expect, a target and a range.")
    metric = body.metric if (body.metric in METRICS or body.metric == "custom") else "custom"
    lower = bool(body.lower_is_better if body.lower_is_better is not None else (METRICS.get(metric, (0, 0, 0, 0, True))[4] is False))
    _check_range(body.low, body.target, body.high, lower)
    n = db.query(models.EventGoal).filter(models.EventGoal.initiative_id == i.id).count()
    if n >= 20:
        raise HTTPException(409, "A contract holds up to 20 goals.")
    g = models.EventGoal(initiative_id=i.id, owner_name=body.owner_name.strip(), owner_role=body.owner_role, owner_email=body.owner_email,
                         label=body.label.strip(), metric=metric, unit=body.unit, target=body.target, low=body.low, high=body.high,
                         weight=max(0.0, body.weight if body.weight is not None else 10), lower_is_better=lower, safety=bool(body.safety),
                         actual_typed=body.actual_typed, position=body.position if body.position is not None else n,
                         history=[{"at": datetime.utcnow().isoformat(), "by": author(user), "change": "created"}])
    db.add(g)
    core.ensure_config(db, i)
    db.commit()
    return {"id": g.id}


@router.post("/{initiative_id}/eventos/goals/suggested")
def add_suggested(initiative_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    ctx = _ctx(db, user, initiative_id, edit=True)
    if ctx.goals:
        raise HTTPException(409, "This event already has a contract.")
    for s in score.suggest(ctx):
        db.add(models.EventGoal(initiative_id=ctx.i.id, history=[{"at": datetime.utcnow().isoformat(), "by": author(user), "change": "suggested"}], **s))
    db.commit()
    return {"ok": True}


@router.patch("/{initiative_id}/eventos/goals/{goal_id}")
def patch_goal(initiative_id: str, goal_id: str, body: GoalBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    i = initiative_for(db, user, initiative_id, edit=True)
    g = db.get(models.EventGoal, goal_id)
    if not g or g.initiative_id != i.id:
        raise HTTPException(404, "Goal not found.")
    d = body.model_dump(exclude_unset=True)
    changed = []
    for f in ("owner_name", "owner_role", "owner_email", "label", "unit"):
        if f in d and d[f] is not None:
            setattr(g, f, str(d[f]).strip() or None if f != "owner_name" else str(d[f]).strip() or g.owner_name)
    if "metric" in d and d["metric"]:
        g.metric = d["metric"] if (d["metric"] in METRICS or d["metric"] == "custom") else "custom"
    for f in ("target", "low", "high", "weight", "lower_is_better"):
        if f in d and d[f] is not None and getattr(g, f) != d[f]:
            changed.append(f"{f} {getattr(g, f)} → {d[f]}")
            setattr(g, f, d[f])
    for f in ("safety", "actual_typed", "position"):
        if f in d:
            setattr(g, f, d[f])
    _check_range(g.low, g.target, g.high, bool(g.lower_is_better))
    if changed:
        g.version = (g.version or 1) + 1
        g.history = (g.history or []) + [{"at": datetime.utcnow().isoformat(), "by": author(user), "change": "; ".join(changed),
                                          "was_signed_by": g.signed_by}]
        if g.signed_at:
            # a signed target that moves needs signing again - and the report shows the change
            g.signed_at, g.signed_by = None, None
    db.commit()
    return {"ok": True, "unsigned": bool(changed)}


@router.delete("/{initiative_id}/eventos/goals/{goal_id}")
def delete_goal(initiative_id: str, goal_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    i = initiative_for(db, user, initiative_id, edit=True)
    g = db.get(models.EventGoal, goal_id)
    if not g or g.initiative_id != i.id:
        raise HTTPException(404, "Goal not found.")
    db.delete(g)
    db.commit()
    return {"ok": True}


@router.post("/{initiative_id}/eventos/goals/{goal_id}/sign")
def sign_goal(initiative_id: str, goal_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    i = initiative_for(db, user, initiative_id)
    g = db.get(models.EventGoal, goal_id)
    if not g or g.initiative_id != i.id:
        raise HTTPException(404, "Goal not found.")
    g.signed_at, g.signed_by = datetime.utcnow(), author(user)
    g.history = (g.history or []) + [{"at": g.signed_at.isoformat(), "by": g.signed_by, "change": f"signed v{g.version or 1}"}]
    log_audit_event(db, actor=user, action="initiative.goal_signed", workspace_id=i.workspace_id, target_type="event_goal", target_id=g.id)
    db.commit()
    return {"ok": True}


# =============================================================== sessions ==

class SessionBody(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    speaker: str | None = Field(default=None, max_length=160)
    room: str | None = Field(default=None, max_length=80)
    track: str | None = Field(default=None, max_length=60)
    starts_at: str | None = None
    ends_at: str | None = None
    capacity: int | None = None
    online: bool | None = None


@router.get("/{initiative_id}/eventos/sessions")
def list_sessions(initiative_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    ctx = _ctx(db, user, initiative_id)
    return {"sessions": views.sessions_rows(ctx)}


@router.post("/{initiative_id}/eventos/sessions")
def add_session(initiative_id: str, body: SessionBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    i = initiative_for(db, user, initiative_id, edit=True)
    if not (body.title or "").strip():
        raise HTTPException(422, "Give the session a title.")
    if db.query(models.EventSession).filter(models.EventSession.initiative_id == i.id).count() >= 300:
        raise HTTPException(409, "An event holds up to 300 sessions.")
    s = models.EventSession(initiative_id=i.id, title=body.title.strip(), speaker=body.speaker, room=body.room, track=body.track,
                            starts_at=_dt(body.starts_at), ends_at=_dt(body.ends_at), capacity=body.capacity, online=bool(body.online))
    db.add(s)
    db.commit()
    return {"id": s.id}


@router.patch("/{initiative_id}/eventos/sessions/{session_id}")
def patch_session(initiative_id: str, session_id: str, body: SessionBody, db: Session = Depends(get_db),
                  user: models.User = Depends(get_current_user)):
    i = initiative_for(db, user, initiative_id, edit=True)
    s = db.get(models.EventSession, session_id)
    if not s or s.initiative_id != i.id:
        raise HTTPException(404, "Session not found.")
    d = body.model_dump(exclude_unset=True)
    for f in ("title", "speaker", "room", "track"):
        if f in d:
            setattr(s, f, (d[f] or "").strip() or (s.title if f == "title" else None))
    for f in ("starts_at", "ends_at"):
        if f in d:
            setattr(s, f, _dt(d[f]))
    if "capacity" in d:
        s.capacity = d["capacity"]
    if "online" in d:
        s.online = bool(d["online"])
    db.commit()
    return {"ok": True}


@router.delete("/{initiative_id}/eventos/sessions/{session_id}")
def delete_session(initiative_id: str, session_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    i = initiative_for(db, user, initiative_id, edit=True)
    s = db.get(models.EventSession, session_id)
    if not s or s.initiative_id != i.id:
        raise HTTPException(404, "Session not found.")
    db.delete(s)
    db.commit()
    return {"ok": True}


# =============================================================== sponsors ==

class SponsorBody(BaseModel):
    name: str | None = Field(default=None, max_length=120)
    tier: str | None = Field(default=None, max_length=30)
    booth: str | None = Field(default=None, max_length=30)
    goal_leads: int | None = None
    amount: float | None = None
    contact_email: str | None = Field(default=None, max_length=200)
    renewal: str | None = None


@router.post("/{initiative_id}/eventos/sponsors")
def add_sponsor(initiative_id: str, body: SponsorBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    i = initiative_for(db, user, initiative_id, edit=True)
    if not (body.name or "").strip():
        raise HTTPException(422, "Add the sponsor's name.")
    if db.query(models.EventSponsor).filter(models.EventSponsor.initiative_id == i.id).count() >= 200:
        raise HTTPException(409, "An event holds up to 200 sponsors.")
    s = models.EventSponsor(initiative_id=i.id, name=body.name.strip(), tier=body.tier, booth=body.booth, goal_leads=body.goal_leads,
                            amount=body.amount, contact_email=(body.contact_email or "").strip() or None)
    db.add(s)
    db.commit()
    return {"id": s.id}


@router.patch("/{initiative_id}/eventos/sponsors/{sponsor_id}")
def patch_sponsor(initiative_id: str, sponsor_id: str, body: SponsorBody, db: Session = Depends(get_db),
                  user: models.User = Depends(get_current_user)):
    i = initiative_for(db, user, initiative_id, edit=True)
    s = db.get(models.EventSponsor, sponsor_id)
    if not s or s.initiative_id != i.id:
        raise HTTPException(404, "Sponsor not found.")
    d = body.model_dump(exclude_unset=True)
    for f in ("name", "tier", "booth", "contact_email"):
        if f in d:
            setattr(s, f, (d[f] or "").strip() or (s.name if f == "name" else None))
    for f in ("goal_leads", "amount"):
        if f in d:
            setattr(s, f, d[f])
    if "renewal" in d:
        if d["renewal"] not in ("none", "verbal", "signed", "declined"):
            raise HTTPException(422, "Renewal is none, verbal, signed or declined.")
        s.renewal, s.renewal_at = d["renewal"], datetime.utcnow()
    db.commit()
    return {"ok": True}


@router.delete("/{initiative_id}/eventos/sponsors/{sponsor_id}")
def delete_sponsor(initiative_id: str, sponsor_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    i = initiative_for(db, user, initiative_id, edit=True)
    s = db.get(models.EventSponsor, sponsor_id)
    if not s or s.initiative_id != i.id:
        raise HTTPException(404, "Sponsor not found.")
    db.query(models.EventLead).filter(models.EventLead.sponsor_id == s.id).delete(synchronize_session=False)
    db.delete(s)
    db.commit()
    return {"ok": True}


@router.get("/{initiative_id}/eventos/sponsors/{sponsor_id}/report")
def sponsor_report(initiative_id: str, sponsor_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    ctx = _ctx(db, user, initiative_id)
    s = db.get(models.EventSponsor, sponsor_id)
    if not s or s.initiative_id != ctx.i.id:
        raise HTTPException(404, "Sponsor not found.")
    return views.sponsor_report(ctx, s)


# ============================================================ brand images ==

@router.post("/{initiative_id}/eventos/assets")
async def add_asset(initiative_id: str, file: UploadFile = File(...), kind: str = Form("banner"), label: str = Form(""),
                    db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    i = initiative_for(db, user, initiative_id, edit=True)
    raw = await file.read()
    if not raw:
        raise HTTPException(422, "The file is empty.")
    if len(raw) > MAX_IMAGE:
        raise HTTPException(413, "Images up to 3 MB - export a smaller version.")
    from ..services.eventos.vision import _sniff
    mime = _sniff(raw)
    if not (raw[:3] == b"\xff\xd8\xff" or raw[:8] == b"\x89PNG\r\n\x1a\n" or raw[:4] == b"RIFF" or raw[:6] in (b"GIF87a", b"GIF89a")):
        raise HTTPException(422, "Upload a JPG, PNG, WEBP or GIF image.")
    if db.query(models.EventAsset).filter(models.EventAsset.initiative_id == i.id).count() >= 12:
        raise HTTPException(409, "Up to 12 images per event.")
    a = models.EventAsset(initiative_id=i.id, kind=kind if kind in ("banner", "logo", "backdrop", "badge", "photo") else "banner",
                          label=label[:80] or file.filename, mime=mime, data=raw)
    db.add(a)
    db.commit()
    return {"id": a.id, "url": f"/public/eventos/asset/{a.id}"}


@router.delete("/{initiative_id}/eventos/assets/{asset_id}")
def delete_asset(initiative_id: str, asset_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    i = initiative_for(db, user, initiative_id, edit=True)
    a = db.get(models.EventAsset, asset_id)
    if not a or a.initiative_id != i.id:
        raise HTTPException(404, "Image not found.")
    db.delete(a)
    db.commit()
    return {"ok": True}


# ================================================================== posts ==

class LinkBody(BaseModel):
    url: str = Field(min_length=4, max_length=1000)
    author_kind: str | None = None
    author: str | None = Field(default=None, max_length=120)


@router.post("/{initiative_id}/eventos/buzz/scan")
def scan(initiative_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    ctx = _ctx(db, user, initiative_id, edit=True)
    out = social.scan(db, ctx.i, ctx.cfg)
    db.commit()
    return out


@router.post("/{initiative_id}/eventos/buzz/link")
def add_post(initiative_id: str, body: LinkBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    ctx = _ctx(db, user, initiative_id, edit=True)
    if db.query(models.EventMention).filter(models.EventMention.initiative_id == ctx.i.id).count() >= 20000:
        raise HTTPException(409, "This event already holds 20,000 posts.")
    m = social.add_link(db, ctx.i, ctx.cfg, body.url, body.author_kind, body.author)
    db.commit()
    return views.mention_row(m, ctx)


class MentionPatch(BaseModel):
    state: str | None = None
    author_kind: str | None = None
    sentiment: str | None = None


@router.patch("/{initiative_id}/eventos/mentions/{mention_id}")
def patch_mention(initiative_id: str, mention_id: str, body: MentionPatch, db: Session = Depends(get_db),
                  user: models.User = Depends(get_current_user)):
    i = initiative_for(db, user, initiative_id, edit=True)
    m = db.get(models.EventMention, mention_id)
    if not m or m.initiative_id != i.id:
        raise HTTPException(404, "Post not found.")
    if body.state:
        if body.state not in ("confirmed", "rejected", "review", "auto"):
            raise HTTPException(422, "Unknown state.")
        m.state = body.state
    if body.author_kind:
        if body.author_kind not in ("own", "speaker", "sponsor", "attendee", "press", "creator", "public"):
            raise HTTPException(422, "Unknown author kind.")
        m.author_kind = body.author_kind
    if body.sentiment in ("positive", "neutral", "negative"):
        m.sentiment = body.sentiment
    db.commit()
    return {"ok": True}


# ================================================================ actions ==

@router.get("/{initiative_id}/eventos/actions")
def actions(initiative_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    ctx = _ctx(db, user, initiative_id)
    out = {"actions": agent.list_actions(ctx, refresh=True)}
    db.commit()
    return out


@router.post("/{initiative_id}/eventos/actions/{action_id}/{decision}")
def decide_action(initiative_id: str, action_id: str, decision: str, db: Session = Depends(get_db),
                  user: models.User = Depends(get_current_user)):
    ctx = _ctx(db, user, initiative_id, edit=True)
    a = db.get(models.EventAction, action_id)
    if not a or a.initiative_id != ctx.i.id:
        raise HTTPException(404, "Suggestion not found.")
    if a.state != "proposed":
        raise HTTPException(409, "This was already decided.")
    if decision not in ("approve", "dismiss"):
        raise HTTPException(422, "Approve or dismiss.")
    a.decided_by, a.decided_at = author(user), datetime.utcnow()
    if decision == "dismiss":
        a.state, a.result = "dismissed", "Dismissed"
    else:
        a.result = agent.execute(ctx, a, author(user))
        a.state = "done"
    from ..services.initiatives import tracking
    tracking.log(db, ctx.i, f"{a.agent} agent - {a.title}: {a.result}", author(user), kind="system")
    log_audit_event(db, actor=user, action=f"initiative.agent_{decision}", workspace_id=ctx.i.workspace_id, target_type="event_action",
                    target_id=a.id, metadata={"key": a.key})
    db.commit()
    return agent.row(a)


# ================================================================ tickets ==

@router.get("/{initiative_id}/eventos/tickets")
def tickets(initiative_id: str, q: str | None = None, status: str | None = None, limit: int = 100, offset: int = 0,
            db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    ctx = _ctx(db, user, initiative_id)
    rows = ctx.tickets
    if status in ("registered", "checked_in"):
        rows = [t for t in rows if t.status == status]
    if status == "walk_in":
        rows = [t for t in rows if t.walk_in]
    if q:
        ql = q.lower()
        rows = [t for t in rows if ql in (t.name or "").lower() or ql in (t.email or "").lower() or ql in (t.company or "").lower()
                or ql == (t.code or "").lower()]
    rows = sorted(rows, key=lambda t: t.checked_in_at or t.registered_at or datetime.min, reverse=True)
    db.commit()
    return {"total": len(rows), "tickets": [_ticket(t) for t in rows[offset:offset + min(max(limit, 1), 500)]]}


def _ticket(t: models.EventTicket) -> dict:
    return {"id": t.id, "code": t.code, "name": t.name, "email": t.email, "company": t.company, "title": t.title, "tier": t.tier,
            "icp": t.icp, "source": t.source, "status": t.status, "walk_in": bool(t.walk_in), "registered_at": core.iso(t.registered_at),
            "checked_in_at": core.iso(t.checked_in_at), "show_prob": t.show_prob, "gate": t.gate, "confirmed": bool(t.confirmed_at),
            "online_minutes": t.online_minutes, "engagement": t.engagement}


class TicketBody(BaseModel):
    name: str | None = Field(default=None, max_length=120)
    email: str | None = Field(default=None, max_length=200)
    company: str | None = Field(default=None, max_length=160)
    title: str | None = Field(default=None, max_length=120)
    tier: str = "free"
    source: str | None = Field(default=None, max_length=60)


@router.post("/{initiative_id}/eventos/tickets")
def add_ticket(initiative_id: str, body: TicketBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    i = initiative_for(db, user, initiative_id, edit=True)
    from ..services.initiatives import gtm
    if body.email and not gtm.valid_email(body.email):
        raise HTTPException(422, "That email doesn't look right.")
    if not (body.name or body.email):
        raise HTTPException(422, "Add a name or an email.")
    cfg = core.ensure_config(db, i)
    c = None
    if i.workspace_id and not (cfg.data or {}).get("sample"):
        c = gtm.upsert_contact(db, i.workspace_id, {"name": body.name, "email": body.email, "company": body.company, "title": body.title}, "manual")
        db.flush()
        if c and not db.query(models.GtmEngagement.id).filter(models.GtmEngagement.initiative_id == i.id, models.GtmEngagement.contact_id == c.id,
                                                              models.GtmEngagement.kind == "registered").first():
            gtm.record(db, i.workspace_id, "registered", account_id=c.account_id, contact_id=c.id, initiative_id=i.id, channel=body.source or "manual",
                       detail={"added_by": author(user)})
        if c:
            existing = db.query(models.EventTicket).filter(models.EventTicket.initiative_id == i.id, models.EventTicket.contact_id == c.id).first()
            if existing:
                existing.tier = body.tier if body.tier in core.TIERS else existing.tier
                db.commit()
                return _ticket(existing)
    t = core.ticket_from_contact(db, i, c, source=body.source or "manual", when=datetime.utcnow(), tier=body.tier,
                                 extra={"name": body.name, "email": body.email, "company": body.company, "title": body.title})
    db.commit()
    return _ticket(t)


@router.post("/{initiative_id}/eventos/tickets/{ticket_id}/{op}")
def ticket_op(initiative_id: str, ticket_id: str, op: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    i = initiative_for(db, user, initiative_id, edit=True)
    t = db.get(models.EventTicket, ticket_id)
    if not t or t.initiative_id != i.id:
        raise HTTPException(404, "Ticket not found.")
    if op == "checkin":
        core.check_in(db, i, t, author(user), "desk")
    elif op == "undo":
        t.status, t.checked_in_at = "registered", None
        E = models.GtmEngagement
        if t.contact_id:
            db.query(E).filter(E.initiative_id == i.id, E.contact_id == t.contact_id, E.kind.in_(("attended", "webinar_attended"))) \
                .delete(synchronize_session=False)
    elif op == "cancel":
        t.status = "cancelled"
    elif op == "confirm":
        t.confirmed_at = datetime.utcnow()
    else:
        raise HTTPException(422, "Unknown action.")
    db.commit()
    return _ticket(t)


# ======================================================= Zoom / Teams import ==

def _num(v):
    try:
        return float(str(v).replace(",", "").strip())
    except (TypeError, ValueError):
        return None


@router.post("/{initiative_id}/eventos/import/attendance")
async def import_attendance(initiative_id: str, file: UploadFile = File(...), session_id: str | None = Form(None),
                            db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    """A Zoom / Teams / Webex attendee report (CSV): each row a join with
    name, email, join and leave time (or duration). Gives every person
    their watch minutes, checks them in, and draws the viewers-per-minute
    curve - no app to install."""
    i = initiative_for(db, user, initiative_id, edit=True)
    cfg = core.ensure_config(db, i)
    raw = await file.read()
    if len(raw) > 15 * 1024 * 1024:
        raise HTTPException(413, "That file is over 15 MB.")
    text = raw.decode("utf-8-sig", errors="ignore")
    lines = text.splitlines()
    # Zoom reports start with a summary block; find the header row that has an email column
    start = next((n for n, l in enumerate(lines) if re.search(r"e-?mail", l, re.I) and ("," in l or "\t" in l)), None)
    if start is None:
        raise HTTPException(422, "Couldn't find the attendee table - it needs an Email column (and Join / Leave time or Duration).")
    delim = "\t" if lines[start].count("\t") > lines[start].count(",") else ","
    rdr = csv.DictReader(io.StringIO("\n".join(lines[start:])), delimiter=delim)
    cols = {c.lower().strip(): c for c in (rdr.fieldnames or [])}

    def col(*names):
        for n in names:
            for k, v in cols.items():
                if n in k:
                    return v
        return None
    c_email, c_name = col("email"), col("name (original", "user name", "name", "full name")
    c_join, c_leave, c_dur = col("join time", "join"), col("leave time", "leave"), col("duration", "time in session", "minutes")
    if not c_email:
        raise HTTPException(422, "The report needs an Email column.")
    from ..services.initiatives import gtm

    def ts(v):
        if not v:
            return None
        for fmt in ("%m/%d/%Y %I:%M:%S %p", "%m/%d/%Y %H:%M:%S", "%Y-%m-%d %H:%M:%S", "%d/%m/%Y %H:%M:%S", "%m/%d/%Y %I:%M %p", "%Y-%m-%dT%H:%M:%S"):
            try:
                return datetime.strptime(v.strip()[:22], fmt)
            except ValueError:
                continue
        return None
    per: dict[str, dict] = {}
    spans = []
    for r in rdr:
        email = (r.get(c_email) or "").strip().lower()
        if not email or "@" not in email:
            continue
        p = per.setdefault(email, {"name": (r.get(c_name) or "").strip() if c_name else None, "minutes": 0.0, "first": None})
        j, lv = ts(r.get(c_join)) if c_join else None, ts(r.get(c_leave)) if c_leave else None
        mins = _num(r.get(c_dur)) if c_dur else None
        if mins is None and j and lv:
            mins = (lv - j).total_seconds() / 60
        p["minutes"] += mins or 0
        if j and (p["first"] is None or j < p["first"]):
            p["first"] = j
        if j and lv:
            spans.append((j, lv))
    if not per:
        raise HTTPException(422, "No attendee rows with an email were found.")
    T = models.EventTicket
    by_email = {t.email.lower(): t for t in db.query(T).filter(T.initiative_id == i.id, T.email.isnot(None))}
    made = joined = 0
    for email, p in per.items():
        t = by_email.get(email)
        if t is None:
            c = gtm.upsert_contact(db, i.workspace_id, {"name": p["name"], "email": email}, "webinar") if i.workspace_id else None
            db.flush()
            t = core.ticket_from_contact(db, i, c, source="Joined without registering", when=p["first"] or datetime.utcnow(),
                                         walk_in=True, extra={"name": p["name"], "email": email})
            made += 1
        t.online_minutes = round(p["minutes"], 1)
        when_utc = core.to_utc(p["first"], cfg.timezone) if p["first"] else None
        if core.check_in(db, i, t, "attendance report", "online", when=when_utc):
            joined += 1
    if spans:
        lo = min(a for a, _ in spans)
        hi = max(b for _, b in spans)
        n = int((hi - lo).total_seconds() // 60) + 1
        if n <= 24 * 60:
            curve = [0] * n
            for a, b in spans:
                for m in range(int((a - lo).total_seconds() // 60), int((b - lo).total_seconds() // 60) + 1):
                    if 0 <= m < n:
                        curve[m] += 1
            db.query(models.EventTouch).filter(models.EventTouch.initiative_id == i.id, models.EventTouch.kind == "stream_viewers",
                                               models.EventTouch.session_id == (session_id or None)).delete(synchronize_session=False)
            for m, val in enumerate(curve):
                db.add(models.EventTouch(initiative_id=i.id, kind="stream_viewers", occurred_at=core.to_utc(lo + timedelta(minutes=m), cfg.timezone),
                                         value=val, session_id=session_id or None, source="attendance report", data={"minute": m}))
    from ..services.initiatives import tracking
    tracking.log(db, i, f"Attendance report: {len(per)} people, {joined} newly marked as joined, {made} who hadn't registered.", author(user), kind="system")
    db.commit()
    return {"ok": True, "people": len(per), "joined": joined, "new": made, "curve_minutes": len(spans) and n}


class TouchBody(BaseModel):
    kind: str
    zone: str | None = Field(default=None, max_length=60)
    value: float | None = None
    text: str | None = Field(default=None, max_length=1000)
    at: str | None = None
    session_id: str | None = None


@router.post("/{initiative_id}/eventos/touches")
def add_touch(initiative_id: str, body: TouchBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    """A number logged by hand: a queue time, a room count, replay views,
    a question - labelled as typed (reported)."""
    i = initiative_for(db, user, initiative_id, edit=True)
    if body.kind not in ("queue", "occupancy", "replay_view", "question", "cta_click", "poll", "chat", "stream_viewers", "meeting", "survey"):
        raise HTTPException(422, "Unknown kind.")
    db.add(models.EventTouch(initiative_id=i.id, kind=body.kind, zone=body.zone, value=body.value, text=body.text,
                             occurred_at=_dt(body.at) or datetime.utcnow(), session_id=body.session_id, source="typed", truth="reported"))
    db.commit()
    return {"ok": True}


# ============================================================== learnings ==

class LearningsBody(BaseModel):
    learnings: list[dict]


@router.put("/{initiative_id}/eventos/learnings")
def put_learnings(initiative_id: str, body: LearningsBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    i = initiative_for(db, user, initiative_id, edit=True)
    cfg = core.ensure_config(db, i)
    rows = [{"kind": str(l.get("kind") or "keep")[:12], "title": str(l.get("title") or "")[:200], "proof": str(l.get("proof") or "")[:300]}
            for l in body.learnings[:20] if str(l.get("title") or "").strip()]
    cfg.data = {**(cfg.data or {}), "learnings": rows}
    db.commit()
    return {"ok": True}


class CloneBody(BaseModel):
    title: str = Field(min_length=2, max_length=120)
    key_date: str | None = None


@router.post("/{initiative_id}/eventos/clone")
def clone(initiative_id: str, body: CloneBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    """The next edition: same setup and contract (unsigned), the learnings
    attached, nothing counted yet."""
    ctx = _ctx(db, user, initiative_id)
    workspace_for(db, user, ctx.i.workspace_id, edit=True)
    src, cfg = ctx.i, ctx.cfg
    kd = None
    if body.key_date:
        try:
            kd = date.fromisoformat(body.key_date[:10])
        except ValueError:
            raise HTTPException(422, "Dates are written as YYYY-MM-DD.")
    shift = (kd - date.fromisoformat(src.key_date[:10])) if (kd and src.key_date) else timedelta(days=365)
    n = models.Initiative(owner_id=user.id, workspace_id=src.workspace_id, title=body.title.strip(), kind=src.kind, department=src.department,
                          status="planning", brief=src.brief, summary=src.summary, key_date=(kd or (date.fromisoformat(src.key_date[:10]) + shift if src.key_date else None)).isoformat() if (kd or src.key_date) else None,
                          location=src.location, budget=src.budget, details={k: v for k, v in (src.details or {}).items() if k != "sample"},
                          targets=src.targets, phases=src.phases, tools=src.tools, audience=src.audience,
                          plan_meta={"cloned_from": src.id, "learnings": views.report(ctx)["learnings"]})
    db.add(n)
    db.flush()
    yy = (n.key_date or date.today().isoformat())[2:4]
    data = {k: v for k, v in (cfg.data or {}).items() if k in ("costs", "prices", "currency", "win_rate", "city", "income")}
    data["learnings_from"] = {"id": src.id, "title": src.title, "learnings": views.report(ctx)["learnings"]}
    nc = models.EventConfig(initiative_id=n.id, format=cfg.format, mode=cfg.mode,
                            starts_at=cfg.starts_at + shift if cfg.starts_at else None, ends_at=cfg.ends_at + shift if cfg.ends_at else None,
                            timezone=cfg.timezone, capacity=cfg.capacity, fire_limit=cfg.fire_limit, post_window_days=cfg.post_window_days,
                            code=re.sub(r"\d{2}$", yy, cfg.code or core.event_code(n.title, n.key_date)),
                            hashtags=[re.sub(r"\d{2}$", yy, h) for h in (cfg.hashtags or [])], keywords=cfg.keywords, promo_codes=[],
                            handles=cfg.handles, ad_campaigns=[], zones=cfg.zones, data=data)
    db.add(nc)
    for g in ctx.goals:
        db.add(models.EventGoal(initiative_id=n.id, owner_name=g.owner_name, owner_role=g.owner_role, owner_email=g.owner_email,
                                label=g.label, metric=g.metric, unit=g.unit, target=g.target, low=g.low, high=g.high, weight=g.weight,
                                lower_is_better=g.lower_is_better, safety=g.safety, position=g.position,
                                history=[{"at": datetime.utcnow().isoformat(), "by": author(user), "change": f"copied from {src.title}"}]))
    for s in ctx.sponsors:
        db.add(models.EventSponsor(initiative_id=n.id, name=s.name, tier=s.tier, goal_leads=s.goal_leads, contact_email=s.contact_email))
    log_audit_event(db, actor=user, action="initiative.event_clone", workspace_id=n.workspace_id, target_type="initiative", target_id=n.id,
                    metadata={"from": src.id})
    db.commit()
    return {"id": n.id}


@router.get("/{initiative_id}/eventos/qr.svg")
def qr(initiative_id: str, what: str = "registration", db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    """A QR code for the registration page, the staff app, the survey or the
    share link - to print on posters, table cards or the staff briefing."""
    ctx = _ctx(db, user, initiative_id)
    links = _links(ctx)
    url = links.get(what) if what in ("registration", "staff", "survey", "share", "walk_in") else None
    if not url:
        raise HTTPException(404, "Nothing to make a QR for.")
    import io

    import segno
    buf = io.BytesIO()
    segno.make(url, error="m").save(buf, kind="svg", scale=8, border=2, dark="#06150F", light="#ffffff")
    db.commit()
    return Response(buf.getvalue(), media_type="image/svg+xml", headers={"Cache-Control": "no-store"})
