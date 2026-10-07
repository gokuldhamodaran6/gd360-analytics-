"""
Block / page / dashboard comments (2026-10-07, analyst canvas round).

The Option C canvas pins a comment thread to a chart element ("Gokul on
the Groups bar - Why is Groups so high? - 2 replies"); the Builder's
published dashboard shows the same threads. One table
(models.DashboardComment), one router, mounted at
/dashboard-builder/{dashboard_id}/comments:

  GET    ?block_id=&page_id=&include_resolved=   threads (root + replies)
                                                 with author display, counts
  POST   {block_id?, page_id?, parent_id?, body, anchor?}
  PATCH  /{comment_id} {body?, resolved?}
  DELETE /{comment_id}

Permissions - reused from routers/dashboard_builder.py so they can never
drift: anyone who can VIEW the dashboard (_get_dashboard_v2: owner, or a
member of its workspace) can read and write comments; editing a body is
the author's alone; resolving a thread is the author's or any dashboard
EDITOR's (_can_edit); deleting is the author's or the dashboard OWNER's.
There is deliberately no public (no-login) endpoint: a public/private
share viewer has no GD360 identity to attribute a comment to, so the
published view reads counts only through what the owner surfaces.

@mentions: every `@name` token in a body is parsed (parse_mentions) and
stored on the row (`mentions`) as plain text tokens, exactly as typed.
No email is sent: Notifications v1 exists but SMTP is off, so this just
records who was named, for the UI and for a later notification pass.
"""
import re
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user
from .dashboard_builder import _get_dashboard_v2
from .dashboards import _can_edit

router = APIRouter(prefix="/dashboard-builder/{dashboard_id}/comments", tags=["dashboard-comments"])

_MENTION_RE = re.compile(r"(?<![\w@])@([A-Za-z][A-Za-z0-9_.\-]{0,63})")
_MAX_MENTIONS = 20


def _initials(name: str | None, email: str | None) -> str:
    source = (name or "").strip() or (email or "").split("@")[0]
    parts = [p for p in re.split(r"[\s._\-]+", source) if p]
    if not parts:
        return "?"
    if len(parts) == 1:
        return parts[0][:2].upper()
    return (parts[0][0] + parts[-1][0]).upper()


def _author_out(user: models.User | None, user_id: str) -> schemas.CommentAuthorOut:
    if user is None:
        return schemas.CommentAuthorOut(id=user_id, name="Former member", initials="?", email=None)
    name = (user.full_name or "").strip() or (user.email or "").split("@")[0]
    return schemas.CommentAuthorOut(id=user.id, name=name, initials=_initials(user.full_name, user.email), email=user.email)


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


def _can_act(db: Session, d: models.Dashboard, user: models.User, c: models.DashboardComment) -> tuple[bool, bool, bool]:
    is_author = c.author_id == user.id
    return is_author, is_author or _can_edit(db, d, user), is_author or d.owner_id == user.id


def _comment_out(db: Session, d: models.Dashboard, user: models.User, c: models.DashboardComment, users: dict) -> schemas.CommentOut:
    can_edit, can_resolve, can_delete = _can_act(db, d, user, c)
    return schemas.CommentOut(
        id=c.id, dashboard_id=c.dashboard_id, block_id=c.block_id, page_id=c.page_id, parent_id=c.parent_id,
        author=_author_out(users.get(c.author_id), c.author_id), body=c.body, anchor=c.anchor,
        mentions=list(c.mentions or []), resolved_at=c.resolved_at, created_at=c.created_at, updated_at=c.updated_at,
        can_edit=can_edit, can_resolve=can_resolve, can_delete=can_delete,
    )


def _threads_out(db: Session, d: models.Dashboard, user: models.User, rows: list) -> list[schemas.CommentThreadOut]:
    author_ids = {c.author_id for c in rows}
    users = {u.id: u for u in db.query(models.User).filter(models.User.id.in_(author_ids)).all()} if author_ids else {}
    roots = [c for c in rows if c.parent_id is None]
    replies: dict = {}
    for c in rows:
        if c.parent_id:
            replies.setdefault(c.parent_id, []).append(c)
    out: list[schemas.CommentThreadOut] = []
    for root in sorted(roots, key=lambda c: c.created_at):
        reps = sorted(replies.get(root.id, []), key=lambda c: c.created_at)
        base = _comment_out(db, d, user, root, users)
        out.append(schemas.CommentThreadOut(
            **base.model_dump(), replies=[_comment_out(db, d, user, r, users) for r in reps], reply_count=len(reps),
            resolved=root.resolved_at is not None,
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
    (page_id, no block_id) or the whole dashboard (neither), newest root
    last, replies in order. Resolved threads are left out unless
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
    return schemas.CommentsOut(threads=threads, counts=counts, total=total, open=open_count)


@router.post("", response_model=schemas.CommentThreadOut, status_code=201)
def create_comment(
    dashboard_id: str,
    payload: schemas.CommentCreateRequest,
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
        if anchor is not None and not isinstance(anchor, dict):
            raise HTTPException(400, "anchor must be an object like {kind, key}.")
    mentions = parse_mentions(body)
    now = datetime.utcnow()
    c = models.DashboardComment(
        dashboard_id=d.id, block_id=block_id, page_id=page_id, parent_id=root.id if root else None, author_id=user.id,
        body=body[:5000], anchor=anchor, mentions=mentions, created_at=now, updated_at=now,
    )
    db.add(c)
    db.commit()
    db.refresh(c)
    root_id = root.id if root else c.id
    rows = (
        db.query(models.DashboardComment)
        .filter(models.DashboardComment.dashboard_id == d.id)
        .filter((models.DashboardComment.id == root_id) | (models.DashboardComment.parent_id == root_id))
        .all()
    )
    return _threads_out(db, d, user, rows)[0]


@router.patch("/{comment_id}", response_model=schemas.CommentThreadOut)
def update_comment(
    dashboard_id: str,
    comment_id: str,
    payload: schemas.CommentUpdateRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """body: the author only. resolved: the author or a dashboard editor;
    resolving/reopening applies to the thread (its root)."""
    d = _get_dashboard_v2(db, user, dashboard_id)
    c = _get_comment(db, d, comment_id)
    if payload.body is None and payload.resolved is None:
        raise HTTPException(400, "Nothing to update.")
    is_author, can_resolve, _ = _can_act(db, d, user, c)
    if payload.body is not None:
        if not is_author:
            raise HTTPException(403, "Only the person who wrote a comment can edit it.")
        body = payload.body.strip()
        if not body:
            raise HTTPException(400, "A comment cannot be empty - delete it instead.")
        c.body = body[:5000]
        c.mentions = parse_mentions(body)
        c.updated_at = datetime.utcnow()
    root = c if c.parent_id is None else _get_comment(db, d, c.parent_id)
    if payload.resolved is not None:
        root_author, root_can_resolve, _ = _can_act(db, d, user, root)
        if not (can_resolve or root_can_resolve):
            raise HTTPException(403, "Only the comment's author or a dashboard editor can resolve a thread.")
        root.resolved_at = datetime.utcnow() if payload.resolved else None
        root.updated_at = datetime.utcnow()
    db.commit()
    rows = (
        db.query(models.DashboardComment)
        .filter(models.DashboardComment.dashboard_id == d.id)
        .filter((models.DashboardComment.id == root.id) | (models.DashboardComment.parent_id == root.id))
        .all()
    )
    return _threads_out(db, d, user, rows)[0]


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
    if c.parent_id is None:
        for r in list(c.replies):
            db.delete(r)
    db.delete(c)
    db.commit()
    return list_comments(dashboard_id, block_id=block_id, page_id=page_id if not block_id else None,
                         include_resolved=True, db=db, user=user)
