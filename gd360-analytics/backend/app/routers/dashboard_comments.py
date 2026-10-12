"""
Block / page / dashboard comments (2026-10-07, analyst canvas round;
2026-10-12 round 38: team comments on every chart).

A thread hangs on a block (a chart, a KPI, a table...), optionally pinned
to one element of it - a bar, a day on a line, a slice, a row - through
`anchor` {kind, key, label, column}, so it stays on the DATA, not a pixel.
One table (models.DashboardComment), one router, mounted at
/dashboard-builder/{dashboard_id}/comments:

  GET    ?block_id=&page_id=&include_resolved=   threads (root + replies)
  GET    /people                                  who can be @mentioned
  POST   {block_id?, page_id?, parent_id?, body, anchor?, mention_ids?}
  PATCH  /{comment_id} {body?, resolved?, mention_ids?}
  DELETE /{comment_id}
  POST   /{comment_id}/suggestion {apply}         accept / undo GD360's offer

Permissions - reused from routers/dashboard_builder.py so they can never
drift: anyone who can VIEW the dashboard (owner, or a member of its
workspace - viewers included) can read and write comments; editing a body
is the author's alone; resolving a thread is the author's or any dashboard
EDITOR's; deleting is the author's or the dashboard OWNER's. There is no
public (no-login) endpoint: a share-link viewer has no GD360 identity.

round 38 - the team part:
  - @mentions resolve to PEOPLE: the ids picked from the @ list
    (mention_ids) plus any @token typed by hand that names exactly one
    person who can open the dashboard (first name, first.last, full name
    without spaces, or the part of the email before @). Naming someone who
    cannot open it is refused with "share it first" - a mention must never
    send a link someone cannot open.
  - Notifications (the bell): a mention -> "Maya mentioned you on <chart>";
    a reply -> everyone already in the thread; a new thread -> the
    dashboard's owner; resolving someone else's thread -> its author. Never
    the person who acted. The link opens the dashboard on that thread
    (?comment=<root id>). A mention is also emailed when email is set up.
  - Every create / resolve / reopen / delete / suggestion is audited.
  - GD360's suggestion: a thread pinned to one period of a chart over
    time whose words say the point is not normal ("one-off", "exclude",
    "spike", "outlier"...) offers "Treat <period> as a one-off?". Nothing
    changes until someone who can edit the dashboard accepts; then the
    period is stored on the block (config.one_offs) - the chart marks it and
    every forecast made from the block leaves it out (services/forecast.py).
    Undo removes it again.
"""
from __future__ import annotations

import html
import logging
import re
from datetime import datetime

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from .. import models, schemas
from ..config import get_settings
from ..database import get_db
from ..deps import get_current_user
from ..services import notifications as notify
from ..services.audit import log_audit_event
from .dashboard_builder import _get_dashboard_v2
from .dashboards import _can_edit

log = logging.getLogger(__name__)

router = APIRouter(prefix="/dashboard-builder/{dashboard_id}/comments", tags=["dashboard-comments"])

_MENTION_RE = re.compile(r"(?<![\w@])@([A-Za-z][A-Za-z0-9_.\-]{0,63})")
_MAX_MENTIONS = 20
_ISO_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}")
# What makes a comment on a point read as "this point is not normal".
_ONE_OFF_RE = re.compile(
    r"\bone[\s-]?offs?\b|\bexclud\w*|\bignore\b|\boutliers?\b|\bspikes?\b|\banomal\w*|\bunusual\b|\bnot (?:normal|typical|real|representative)\b"
    r"|\bdon'?t (?:count|plan on|use)\b|\bleave (?:it|this) out\b|\bbot traffic\b|\bfluke\b",
    re.I,
)


def _initials(name: str | None, email: str | None) -> str:
    source = (name or "").strip() or (email or "").split("@")[0]
    parts = [p for p in re.split(r"[\s._\-]+", source) if p]
    if not parts:
        return "?"
    if len(parts) == 1:
        return parts[0][:2].upper()
    return (parts[0][0] + parts[-1][0]).upper()


def _name(user: models.User) -> str:
    return (user.full_name or "").strip() or (user.email or "").split("@")[0]


def _author_out(user: models.User | None, user_id: str) -> schemas.CommentAuthorOut:
    if user is None:
        return schemas.CommentAuthorOut(id=user_id, name="Former member", initials="?", email=None)
    return schemas.CommentAuthorOut(id=user.id, name=_name(user), initials=_initials(user.full_name, user.email), email=user.email)


def parse_mentions(body: str) -> list[str]:
    out: list[str] = []
    for m in _MENTION_RE.finditer(body or ""):
        token = m.group(1).rstrip(".")
        if token and token not in out:
            out.append(token)
        if len(out) >= _MAX_MENTIONS:
            break
    return out


def _key(c: models.DashboardComment) -> str:
    if c.block_id:
        return c.block_id
    if c.page_id:
        return f"page:{c.page_id}"
    return "dashboard"


def comment_counts(db: Session, dashboard_id: str) -> dict:
    """{block_id | "page:<id>" | "dashboard": {"open": n, "total": n}} -
    one query over the dashboard's comments; "open" counts comments
    (root + replies) on an unresolved thread."""
    rows = db.query(models.DashboardComment).filter(models.DashboardComment.dashboard_id == dashboard_id).all()
    resolved_roots = {c.id for c in rows if c.parent_id is None and c.resolved_at is not None}
    out: dict = {}
    for c in rows:
        key = _key(c)
        entry = out.setdefault(key, {"open": 0, "total": 0})
        entry["total"] += 1
        root_id = c.parent_id or c.id
        if root_id not in resolved_roots:
            entry["open"] += 1
    return out


# ---------------------------------------------------------------- people

def people_for(db: Session, d: models.Dashboard) -> list[tuple[models.User, str]]:
    """Everyone who can open the dashboard: its owner, and - when it lives
    in a workspace - every member of that workspace, with their role. The
    same rule _can_view applies, so the @ list never offers someone who
    could not follow the link."""
    out: dict[str, tuple[models.User, str]] = {}
    owner = db.get(models.User, d.owner_id) if d.owner_id else None
    if owner:
        out[owner.id] = (owner, "owner")
    if d.workspace_id:
        rows = (
            db.query(models.WorkspaceMember, models.User)
            .join(models.User, models.User.id == models.WorkspaceMember.user_id)
            .filter(models.WorkspaceMember.workspace_id == d.workspace_id)
            .all()
        )
        for m, u in rows:
            role = m.role or "member"
            if u.id in out and out[u.id][1] == "owner":
                continue
            out[u.id] = (u, role)
    return list(out.values())


def _token_forms(user: models.User) -> set[str]:
    name = (user.full_name or "").strip().lower()
    parts = [p for p in re.split(r"\s+", name) if p]
    forms = {(user.email or "").split("@")[0].lower()}
    if parts:
        forms.update({parts[0], "".join(parts), ".".join(parts), "_".join(parts), "-".join(parts)})
    return {f for f in forms if f}


def resolve_mentions(people: list[tuple[models.User, str]], body: str, picked: list[str] | None) -> tuple[list[str], list[str]]:
    """(user ids, refused) - ids picked from the @ list must be people who
    can open the dashboard (else refused); an @token typed by hand is kept
    only when it names exactly one of them (an ambiguous or unknown token
    stays plain text)."""
    allowed = {u.id: u for u, _ in people}
    ids: list[str] = []
    refused: list[str] = []
    for uid in picked or []:
        if uid in allowed:
            if uid not in ids:
                ids.append(uid)
        else:
            refused.append(uid)
    forms = {u.id: _token_forms(u) for u, _ in people}
    for token in parse_mentions(body):
        t = token.lower()
        hits = [uid for uid, f in forms.items() if t in f]
        if len(hits) == 1 and hits[0] not in ids:
            ids.append(hits[0])
    return ids[:_MAX_MENTIONS], refused


@router.get("/people", response_model=schemas.CommentPeopleOut)
def list_people(dashboard_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    """Who can be @mentioned here: everyone who can open the dashboard."""
    d = _get_dashboard_v2(db, user, dashboard_id)
    people = people_for(db, d)
    order = {"owner": 0, "admin": 1, "member": 2, "viewer": 3}
    people.sort(key=lambda p: (p[0].id != user.id, order.get(p[1], 4), _name(p[0]).lower()))
    ws = db.get(models.Workspace, d.workspace_id) if d.workspace_id else None
    return schemas.CommentPeopleOut(
        people=[schemas.CommentPersonOut(id=u.id, name=_name(u), initials=_initials(u.full_name, u.email), email=u.email, role=role, is_me=u.id == user.id)
                for u, role in people],
        shared=bool(d.workspace_id) and len(people) > 1,
        workspace_name=ws.name if ws else None,
    )


# ---------------------------------------------------------------- output

def _can_act(db: Session, d: models.Dashboard, user: models.User, c: models.DashboardComment) -> tuple[bool, bool, bool]:
    is_author = c.author_id == user.id
    return is_author, is_author or _can_edit(db, d, user), is_author or d.owner_id == user.id


def _blocks(d: models.Dashboard) -> dict[str, models.DashboardBlock]:
    return {b.id: b for p in d.pages for b in p.blocks}


def _anchor_label(anchor: dict | None) -> str | None:
    if not isinstance(anchor, dict) or anchor.get("key") is None and "key" not in anchor:
        return None
    if anchor.get("label"):
        return str(anchor["label"])
    key = anchor.get("key")
    return "(Blanks)" if key is None else str(key)


def _one_offs(block: models.DashboardBlock | None) -> list[dict]:
    raw = (block.config or {}).get("one_offs") if block is not None else None
    return [o for o in raw if isinstance(o, dict) and o.get("key")] if isinstance(raw, list) else []


def _one_off_impact(block: models.DashboardBlock, day: str) -> str | None:
    """What leaving `day` out does to this chart's forecast, in its own
    unit: "The forecast drops by 64 sessions." Only for a chart that has a
    forecast and whose stored series holds that very day (a monthly series
    cannot say what one day did to it); None otherwise. Cached like the
    chart's own forecast, so the comments list stays fast."""
    cfg = block.config if isinstance(block.config, dict) else {}
    if not cfg.get("forecast"):
        return None
    try:
        from ..services import dashboard_engine, forecast as forecast_svc
        from .dashboard_builder import _file_series_layout
        layout = _file_series_layout(cfg)
        if not layout:
            return None
        time_col = layout["time"]
        rows = [{**r, time_col: str(r.get(time_col))[:10]} for r in cfg.get("result_rows") or [] if isinstance(r, dict) and r.get(time_col) is not None]
        if not any(r[time_col] == day for r in rows):
            return None
        others = [o for o in _one_offs(block) if str(o.get("key"))[:10] != day]

        def total(one_offs: list) -> float | None:
            c = {**cfg, "one_offs": one_offs}
            options = forecast_svc.normalize_options(forecast_svc.with_one_offs(cfg.get("forecast"), c), layout["grain"])
            if not options:
                return None
            key = forecast_svc.fingerprint("file", rows, layout, options, cfg.get("time_bounds"))
            res = dashboard_engine._forecast_cache.get(key)
            if res is None:
                res = forecast_svc.forecast_result(rows, time_col, layout["measures"], layout["series"], layout["grain"], options)
                dashboard_engine._forecast_cache.put(key, res)
            if res.get("status") != "ok":
                return None
            vals = [p.get("value") for p in res.get("points") or [] if isinstance(p.get("value"), (int, float))]
            return sum(vals) if vals else None

        before, after = total(others), total(others + [{"key": day}])
        if before is None or after is None:
            return None
        diff = round(after - before)
        unit = str(layout["measures"][0].get("alias") or "").replace("_", " ").strip().lower() or "units"
        if abs(diff) < 1:
            return "The forecast barely moves - it is marked on the chart all the same."
        return f"The forecast {'drops' if diff < 0 else 'rises'} by {abs(diff):,} {unit}."
    except Exception as e:  # never let a forecast stop the comments loading
        logging.getLogger(__name__).info("one-off impact skipped: %s", e)
        return None


def _suggestion(db: Session, d: models.Dashboard, user: models.User, root: models.DashboardComment, block: models.DashboardBlock | None,
                bodies: list[str], users: dict) -> schemas.CommentSuggestionOut | None:
    """GD360's offer on a thread - see the module docstring. Only for a
    thread pinned to a period of a chart over time whose words say the
    point is not normal; once applied it reports who applied it."""
    anchor = root.anchor if isinstance(root.anchor, dict) else None
    if block is None or not anchor or anchor.get("key") is None:
        return None
    key = str(anchor["key"])
    if not _ISO_DAY.match(key) or block.type not in ("chart", "sparkline"):
        return None
    day = key[:10]
    label = _anchor_label(anchor) or day
    applied = next((o for o in _one_offs(block) if str(o.get("key"))[:10] == day), None)
    if not applied and not any(_ONE_OFF_RE.search(b or "") for b in bodies):
        return None
    has_forecast = bool((block.config or {}).get("forecast"))
    impact = _one_off_impact(block, day)
    if impact:
        text = f"Treat {label} as a one-off? {impact}"
    else:
        text = (f"Treat {label} as a one-off? GD360 will mark it on the chart and leave it out of this chart's forecast."
                if has_forecast else f"Treat {label} as a one-off? GD360 will mark it on the chart and leave it out of any forecast made from it.")
    by = users.get(applied.get("by")) if applied else None
    at = None
    if applied and applied.get("at"):
        try:
            at = datetime.fromisoformat(str(applied["at"]).rstrip("Z"))
        except ValueError:
            at = None
    return schemas.CommentSuggestionOut(
        kind="one_off", key=day, label=label, text=text, applied=bool(applied),
        applied_by=_name(by) if by else (applied.get("by_name") if applied else None), applied_at=at,
        can_apply=_can_edit(db, d, user),
    )


def _comment_out(db: Session, d: models.Dashboard, user: models.User, c: models.DashboardComment, users: dict) -> schemas.CommentOut:
    can_edit, can_resolve, can_delete = _can_act(db, d, user, c)
    mentioned = [_author_out(users.get(uid), uid) for uid in (c.mention_user_ids or []) if uid in users]
    return schemas.CommentOut(
        id=c.id, dashboard_id=c.dashboard_id, block_id=c.block_id, page_id=c.page_id, parent_id=c.parent_id,
        author=_author_out(users.get(c.author_id), c.author_id), body=c.body, anchor=c.anchor,
        mentions=list(c.mentions or []), mentioned=mentioned, resolved_at=c.resolved_at, created_at=c.created_at, updated_at=c.updated_at,
        edited=c.edited_at is not None, can_edit=can_edit, can_resolve=can_resolve, can_delete=can_delete,
    )


def _threads_out(db: Session, d: models.Dashboard, user: models.User, rows: list) -> list[schemas.CommentThreadOut]:
    ids = {c.author_id for c in rows} | {c.resolved_by_id for c in rows if c.resolved_by_id}
    for c in rows:
        ids.update(c.mention_user_ids or [])
    blocks = _blocks(d)
    for b in blocks.values():
        for o in _one_offs(b):
            if o.get("by"):
                ids.add(o["by"])
    users = {u.id: u for u in db.query(models.User).filter(models.User.id.in_(ids)).all()} if ids else {}
    roots = [c for c in rows if c.parent_id is None]
    replies: dict = {}
    for c in rows:
        if c.parent_id:
            replies.setdefault(c.parent_id, []).append(c)
    can_edit_dash = None
    out: list[schemas.CommentThreadOut] = []
    for root in sorted(roots, key=lambda c: c.created_at):
        reps = sorted(replies.get(root.id, []), key=lambda c: c.created_at)
        base = _comment_out(db, d, user, root, users)
        block = blocks.get(root.block_id) if root.block_id else None
        everyone: list[str] = []
        for c in [root, *reps]:
            if c.author_id not in everyone:
                everyone.append(c.author_id)
        mentioned_ids = {uid for c in [root, *reps] for uid in (c.mention_user_ids or [])}
        sug = _suggestion(db, d, user, root, block, [c.body for c in [root, *reps]], users)
        if sug is not None and can_edit_dash is None:
            can_edit_dash = sug.can_apply
        resolver = users.get(root.resolved_by_id) if root.resolved_by_id else None
        out.append(schemas.CommentThreadOut(
            **base.model_dump(), replies=[_comment_out(db, d, user, r, users) for r in reps], reply_count=len(reps),
            resolved=root.resolved_at is not None, resolved_by=_name(resolver) if resolver else None,
            block_title=(block.title or None) if block is not None else None, block_type=block.type if block is not None else None,
            participants=[_author_out(users.get(uid), uid) for uid in everyone],
            involves_me=user.id in everyone or user.id in mentioned_ids, mentions_me=user.id in mentioned_ids,
            suggestion=sug,
        ))
    return out


def _get_comment(db: Session, d: models.Dashboard, comment_id: str) -> models.DashboardComment:
    c = (
        db.query(models.DashboardComment)
        .filter(models.DashboardComment.id == comment_id, models.DashboardComment.dashboard_id == d.id)
        .first()
    )
    if not c:
        raise HTTPException(404, "Comment not found on this dashboard.")
    return c


def _thread_rows(db: Session, d: models.Dashboard, root_id: str) -> list:
    return (
        db.query(models.DashboardComment)
        .filter(models.DashboardComment.dashboard_id == d.id)
        .filter((models.DashboardComment.id == root_id) | (models.DashboardComment.parent_id == root_id))
        .all()
    )


# ---------------------------------------------------------------- notify

def _where(d: models.Dashboard, block: models.DashboardBlock | None, anchor: dict | None) -> str:
    title = (block.title or "a chart") if block is not None else d.name
    label = _anchor_label(anchor)
    return f"{title} · {label}" if label else title


def _snippet(body: str, n: int = 160) -> str:
    text = re.sub(r"\s+", " ", body or "").strip()
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"


def _email_mentions(recipients: list[tuple[str, str]], subject: str, who: str, where: str, body: str, link: str) -> None:
    """Background task: one plain email per mentioned person. Email that
    is not set up (or fails) never affects the comment."""
    from ..services.automations import email_configured, send_email
    if not email_configured():
        return
    for email, name in recipients:
        try:
            text = f"{who} mentioned you on {where}:\n\n{body}\n\nOpen it: {link}\n"
            safe = html.escape(body).replace("\n", "<br>")
            page = (f'<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#161615">'
                    f'<p>Hi {html.escape(name)},</p><p><b>{html.escape(who)}</b> mentioned you on <b>{html.escape(where)}</b>:</p>'
                    f'<blockquote style="margin:0;padding:10px 14px;border-left:3px solid #43e5a0;background:#f4f4f1">{safe}</blockquote>'
                    f'<p><a href="{html.escape(link)}" style="color:#0f5c46;font-weight:600">Open the comment</a></p></div>')
            send_email([email], subject, page, text)
        except Exception:  # noqa: BLE001 - a mail failure must not surface
            log.warning("comment mention email to %s failed", email, exc_info=True)


def _notify(db: Session, d: models.Dashboard, actor: models.User, *, root: models.DashboardComment, comment: models.DashboardComment,
            block: models.DashboardBlock | None, new_mentions: list[str], kind: str, background: BackgroundTasks | None) -> dict:
    """Stages the bell notifications for one write (committed by the
    caller) and queues the mention emails. Returns {"mentioned": n,
    "notified": n} for tests and the audit trail."""
    where = _where(d, block, root.anchor if isinstance(root.anchor, dict) else None)
    link = f"/dashboard-builder/{d.id}?comment={root.id}"
    who = _name(actor)
    data = {"source": d.name, "dashboard_id": d.id, "comment_id": comment.id, "thread_id": root.id, "block_id": root.block_id,
            "author": who, "initials": _initials(actor.full_name, actor.email)}
    mentioned = [uid for uid in new_mentions if uid != actor.id]
    told: set[str] = set(mentioned)
    if mentioned:
        notify.create(db, mentioned, kind="mention", title=f"{who} mentioned you on {where}", body=_snippet(comment.body), link=link,
                      data=data, workspace_id=d.workspace_id)
    others: list[str] = []
    if kind == "reply":
        thread = _thread_rows(db, d, root.id)
        for c in thread:
            for uid in [c.author_id, *(c.mention_user_ids or [])]:
                if uid and uid != actor.id and uid not in told and uid not in others:
                    others.append(uid)
        title = f"{who} replied on {where}"
    elif kind == "new":
        if d.owner_id and d.owner_id != actor.id and d.owner_id not in told:
            others.append(d.owner_id)
        title = f"{who} commented on {where}"
    elif kind == "resolved":
        if root.author_id != actor.id:
            others.append(root.author_id)
        title = f"{who} resolved your comment on {where}"
    else:
        title = f"{who} on {where}"
    # Only people who can still open the dashboard hear about it.
    can_open = {u.id for u, _ in people_for(db, d)}
    others = [uid for uid in others if uid in can_open]
    if others:
        notify.create(db, others, kind="comment", title=title, body=_snippet(comment.body if kind != "resolved" else root.body), link=link,
                      data=data, workspace_id=d.workspace_id)
    if mentioned and background is not None:
        rows = db.query(models.User).filter(models.User.id.in_(mentioned)).all()
        base = (get_settings().FRONTEND_ORIGIN or "").split(",")[0].strip().rstrip("/")
        recipients = [(u.email, _name(u)) for u in rows if u.email]
        if recipients:
            background.add_task(_email_mentions, recipients, f"{who} mentioned you on {where}", who, where, comment.body, f"{base}{link}")
    return {"mentioned": len(mentioned), "notified": len(others)}


# ---------------------------------------------------------------- endpoints

@router.get("", response_model=schemas.CommentsOut)
def list_comments(
    dashboard_id: str,
    block_id: str | None = None,
    page_id: str | None = None,
    include_resolved: bool = False,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Threads for one block (block_id), one page's page-level threads
    (page_id, no block_id) or the whole dashboard (neither), oldest root
    first, replies in order. Resolved threads are left out unless
    include_resolved. View access is enough."""
    d = _get_dashboard_v2(db, user, dashboard_id)
    q = db.query(models.DashboardComment).filter(models.DashboardComment.dashboard_id == d.id)
    if block_id:
        q = q.filter(models.DashboardComment.block_id == block_id)
    elif page_id:
        q = q.filter(models.DashboardComment.page_id == page_id, models.DashboardComment.block_id.is_(None))
    rows = q.all()
    if not include_resolved:
        resolved_roots = {c.id for c in rows if c.parent_id is None and c.resolved_at is not None}
        rows = [c for c in rows if c.id not in resolved_roots and c.parent_id not in resolved_roots]
    threads = _threads_out(db, d, user, rows)
    counts = comment_counts(db, d.id)
    if block_id:
        counts = {k: v for k, v in counts.items() if k == block_id}
    elif page_id:
        counts = {k: v for k, v in counts.items() if k == f"page:{page_id}"}
    total = sum(1 + t.reply_count for t in threads)
    open_count = sum(1 + t.reply_count for t in threads if not t.resolved)
    return schemas.CommentsOut(threads=threads, counts=counts, total=total, open=open_count, me=user.id,
                               can_edit_dashboard=_can_edit(db, d, user))


def _refuse_unshared(people: list, refused: list[str]) -> None:
    if refused:
        raise HTTPException(400, "Someone you mentioned can't open this dashboard. Share it with them first, then mention them.")


@router.post("", response_model=schemas.CommentThreadOut, status_code=201)
def create_comment(
    dashboard_id: str,
    payload: schemas.CommentCreateRequest,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """A new thread (no parent_id) on a block / page / the dashboard, or a
    reply (parent_id = the root's id; a reply to a reply is attached to
    the same root). Anyone with view access may comment. Returns the
    whole thread the comment belongs to."""
    d = _get_dashboard_v2(db, user, dashboard_id)
    body = payload.body.strip()
    if not body:
        raise HTTPException(400, "Write something first.")
    page_ids = {p.id for p in d.pages}
    block_pages = {b.id: p.id for p in d.pages for b in p.blocks}
    block_id, page_id, anchor = payload.block_id, payload.page_id, payload.anchor
    root: models.DashboardComment | None = None
    if payload.parent_id:
        parent = _get_comment(db, d, payload.parent_id)
        root = parent if parent.parent_id is None else _get_comment(db, d, parent.parent_id)
        block_id, page_id, anchor = root.block_id, root.page_id, None
    else:
        if block_id:
            if block_id not in block_pages:
                raise HTTPException(404, "Block not found on this dashboard.")
            page_id = block_pages[block_id]
        elif page_id and page_id not in page_ids:
            raise HTTPException(404, "Page not found on this dashboard.")
        if anchor is not None:
            if not isinstance(anchor, dict):
                raise HTTPException(400, "anchor must be an object like {kind, key}.")
            anchor = {k: anchor[k] for k in ("kind", "key", "label", "column", "series") if k in anchor}
            if isinstance(anchor.get("label"), str):
                anchor["label"] = anchor["label"][:120]
    people = people_for(db, d)
    mention_ids, refused = resolve_mentions(people, body, payload.mention_ids)
    _refuse_unshared(people, refused)
    now = datetime.utcnow()
    c = models.DashboardComment(
        dashboard_id=d.id, block_id=block_id, page_id=page_id, parent_id=root.id if root else None, author_id=user.id,
        body=body[:5000], anchor=anchor, mentions=parse_mentions(body), mention_user_ids=mention_ids, created_at=now, updated_at=now,
    )
    db.add(c)
    db.flush()
    thread_root = root or c
    block = _blocks(d).get(block_id) if block_id else None
    sent = _notify(db, d, user, root=thread_root, comment=c, block=block, new_mentions=mention_ids,
                   kind="reply" if root else "new", background=background)
    log_audit_event(db, actor=user, action="comment_replied" if root else "comment_created", workspace_id=d.workspace_id,
                    target_type="dashboard", target_id=d.id,
                    metadata={"comment_id": c.id, "thread_id": thread_root.id, "block_id": block_id, "mentioned": len(mention_ids), **sent})
    db.commit()
    return _threads_out(db, d, user, _thread_rows(db, d, thread_root.id))[0]


@router.patch("/{comment_id}", response_model=schemas.CommentThreadOut)
def update_comment(
    dashboard_id: str,
    comment_id: str,
    payload: schemas.CommentUpdateRequest,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """body: the author only (new @mentions are notified; people already
    named are not told twice). resolved: the author or a dashboard
    editor; resolving/reopening applies to the thread (its root)."""
    d = _get_dashboard_v2(db, user, dashboard_id)
    c = _get_comment(db, d, comment_id)
    if payload.body is None and payload.resolved is None:
        raise HTTPException(400, "Nothing to update.")
    is_author, can_resolve, _ = _can_act(db, d, user, c)
    root = c if c.parent_id is None else _get_comment(db, d, c.parent_id)
    block = _blocks(d).get(root.block_id) if root.block_id else None
    if payload.body is not None:
        if not is_author:
            raise HTTPException(403, "Only the person who wrote a comment can edit it.")
        body = payload.body.strip()
        if not body:
            raise HTTPException(400, "A comment cannot be empty - delete it instead.")
        people = people_for(db, d)
        ids, refused = resolve_mentions(people, body, payload.mention_ids if payload.mention_ids is not None else list(c.mention_user_ids or []))
        _refuse_unshared(people, refused)
        fresh = [uid for uid in ids if uid not in (c.mention_user_ids or [])]
        if body != c.body:
            c.edited_at = datetime.utcnow()
        c.body = body[:5000]
        c.mentions = parse_mentions(body)
        c.mention_user_ids = ids
        c.updated_at = datetime.utcnow()
        if fresh:
            _notify(db, d, user, root=root, comment=c, block=block, new_mentions=fresh, kind="edit", background=background)
    if payload.resolved is not None:
        _, root_can_resolve, _ = _can_act(db, d, user, root)
        if not (can_resolve or root_can_resolve):
            raise HTTPException(403, "Only the comment's author or a dashboard editor can resolve a thread.")
        was = root.resolved_at is not None
        root.resolved_at = datetime.utcnow() if payload.resolved else None
        root.resolved_by_id = user.id if payload.resolved else None
        root.updated_at = datetime.utcnow()
        if payload.resolved != was:
            if payload.resolved:
                _notify(db, d, user, root=root, comment=root, block=block, new_mentions=[], kind="resolved", background=None)
            log_audit_event(db, actor=user, action="comment_resolved" if payload.resolved else "comment_reopened", workspace_id=d.workspace_id,
                            target_type="dashboard", target_id=d.id, metadata={"thread_id": root.id, "block_id": root.block_id})
    db.commit()
    return _threads_out(db, d, user, _thread_rows(db, d, root.id))[0]


@router.delete("/{comment_id}", response_model=schemas.CommentsOut)
def delete_comment(
    dashboard_id: str,
    comment_id: str,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """The author or the dashboard owner. Deleting a root deletes its
    replies. Returns the remaining threads for the same block/page."""
    d = _get_dashboard_v2(db, user, dashboard_id)
    c = _get_comment(db, d, comment_id)
    _, _, can_delete = _can_act(db, d, user, c)
    if not can_delete:
        raise HTTPException(403, "Only the comment's author or the dashboard owner can delete it.")
    block_id, page_id = c.block_id, c.page_id
    log_audit_event(db, actor=user, action="comment_deleted", workspace_id=d.workspace_id, target_type="dashboard", target_id=d.id,
                    metadata={"comment_id": c.id, "thread": c.parent_id is None, "replies": len(c.replies) if c.parent_id is None else 0,
                              "block_id": block_id, "author_id": c.author_id})
    if c.parent_id is None:
        for r in list(c.replies):
            db.delete(r)
    db.delete(c)
    db.commit()
    return list_comments(dashboard_id, block_id=block_id, page_id=page_id if not block_id else None,
                         include_resolved=True, db=db, user=user)


class SuggestionRequest(BaseModel):
    apply: bool = True


@router.post("/{comment_id}/suggestion", response_model=schemas.CommentThreadOut)
def apply_suggestion(
    dashboard_id: str,
    comment_id: str,
    payload: SuggestionRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Accept (apply=true) or undo (apply=false) GD360's suggestion on a
    thread. It changes the chart, so it needs edit access to the
    dashboard. Accepting stores {key, label, comment_id, by, at} in the
    block's config.one_offs; undo removes that period again."""
    d = _get_dashboard_v2(db, user, dashboard_id)
    c = _get_comment(db, d, comment_id)
    root = c if c.parent_id is None else _get_comment(db, d, c.parent_id)
    if not _can_edit(db, d, user):
        raise HTTPException(403, "Only people who can edit this dashboard can change its charts.")
    block = _blocks(d).get(root.block_id) if root.block_id else None
    rows = _thread_rows(db, d, root.id)
    sug = _suggestion(db, d, user, root, block, [r.body for r in rows], {})
    if sug is None or block is None:
        raise HTTPException(409, "GD360 has nothing to suggest on this thread.")
    config = dict(block.config or {})
    current = _one_offs(block)
    if payload.apply:
        if not any(str(o["key"])[:10] == sug.key for o in current):
            current.append({"key": sug.key, "label": sug.label, "comment_id": root.id, "by": user.id, "by_name": _name(user),
                            "at": datetime.utcnow().isoformat() + "Z", "note": _snippet(root.body, 80)})
    else:
        current = [o for o in current if str(o["key"])[:10] != sug.key]
    if current:
        config["one_offs"] = current
    else:
        config.pop("one_offs", None)
    block.config = config
    flag_modified(block, "config")
    log_audit_event(db, actor=user, action="comment_suggestion_applied" if payload.apply else "comment_suggestion_undone",
                    workspace_id=d.workspace_id, target_type="dashboard", target_id=d.id,
                    metadata={"thread_id": root.id, "block_id": block.id, "kind": sug.kind, "key": sug.key})
    db.commit()
    return _threads_out(db, d, user, _thread_rows(db, d, root.id))[0]
