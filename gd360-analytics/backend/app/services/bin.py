"""2026-10-24 (R61): the Bin.

Deleting an answer (a conversation), a dashboard, a report, a model or a pipeline moves it to the Bin instead of
removing it: `trashed_at` is set and the item disappears from every list, link, search and shared page at once. From
the Bin it can be restored, or deleted for good; anything left in the Bin for 7 days is deleted for good by the
nightly purge (and on start-up).

How it disappears everywhere without touching every query: one SQLAlchemy `do_orm_execute` hook adds
"trashed_at IS NULL" for these five models to every ORM SELECT (lists, `db.get`, joins, lazy loads). The Bin itself
reads with `execution_options(include_trashed=True)`.
"""
from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import event
from sqlalchemy.orm import Session, with_loader_criteria

from .. import models

KEEP_DAYS = 7

KINDS: dict[str, type] = {
    "answer": models.Conversation,
    "dashboard": models.Dashboard,
    "report": models.DocDocument,
    "model": models.MLModel,
    "pipeline": models.DataFlow,
}
LABEL = {"answer": "Answer", "dashboard": "Dashboard", "report": "Report", "model": "Model", "pipeline": "Pipeline"}
_INSTALLED = False


def install() -> None:
    """Hide items in the Bin from every ORM query (once per process)."""
    global _INSTALLED
    if _INSTALLED:
        return
    _INSTALLED = True

    @event.listens_for(Session, "do_orm_execute")
    def _hide_trashed(state):  # noqa: ANN001
        if not state.is_select or state.execution_options.get("include_trashed", False):
            return
        for cls in KINDS.values():
            state.statement = state.statement.options(
                with_loader_criteria(cls, lambda c: c.trashed_at.is_(None), include_aliases=True))


def _name(kind: str, obj) -> str:
    return (getattr(obj, "title", None) if kind in ("answer", "report") else getattr(obj, "name", None)) or LABEL[kind]


def get_any(db: Session, kind: str, item_id: str):
    """The row whether it is in the Bin or not."""
    cls = KINDS.get(kind)
    if cls is None:
        return None
    return db.get(cls, item_id, execution_options={"include_trashed": True})


def can_delete(db: Session, user: models.User, kind: str, obj) -> bool:
    """The same people who could delete it before the Bin existed."""
    from . import workspace_access
    if kind == "answer":
        return workspace_access.can_delete_conversation(db, obj, user)
    if kind == "dashboard":
        if obj.owner_id == user.id:
            return True
        return bool(obj.workspace_id and workspace_access.member_role(db, user.id, obj.workspace_id) in ("owner", "admin"))
    if kind == "report":
        if obj.owner_id == user.id:
            return True
        return bool(obj.workspace_id and workspace_access.member_role(db, user.id, obj.workspace_id) in ("owner", "admin"))
    return obj.owner_id == user.id   # a model or a pipeline: only the person who made it


def move_to_bin(db: Session, user: models.User, kind: str, obj) -> dict:
    obj.trashed_at = datetime.utcnow()
    obj.trashed_by = user.id
    db.commit()
    return item_out(kind, obj)


def item_out(kind: str, obj) -> dict:
    gone = (obj.trashed_at + timedelta(days=KEEP_DAYS)) if obj.trashed_at else None
    days = max(0, int((gone - datetime.utcnow()).total_seconds() // 86400) + 1) if gone else None
    return {"kind": kind, "type_label": LABEL[kind], "id": obj.id, "name": _name(kind, obj),
            "trashed_at": obj.trashed_at.isoformat() + "Z" if obj.trashed_at else None,
            "deleted_for_good_at": gone.isoformat() + "Z" if gone else None, "days_left": days}


def mine(db: Session, user: models.User) -> list[dict]:
    """What this person can see in their Bin: what they deleted, and their own items someone else deleted."""
    out = []
    for kind, cls in KINDS.items():
        q = (db.query(cls).execution_options(include_trashed=True)
             .filter(cls.trashed_at.isnot(None))
             .filter((cls.trashed_by == user.id) | (cls.owner_id == user.id)))
        out += [item_out(kind, o) for o in q.all()]
    return sorted(out, key=lambda x: x["trashed_at"] or "", reverse=True)


def _mine_to_manage(user: models.User, obj) -> bool:
    return obj.trashed_by == user.id or obj.owner_id == user.id


def restore(db: Session, user: models.User, kind: str, item_id: str) -> dict | None:
    obj = get_any(db, kind, item_id)
    if obj is None or obj.trashed_at is None or not _mine_to_manage(user, obj):
        return None
    obj.trashed_at = None
    obj.trashed_by = None
    db.commit()
    return {"kind": kind, "id": obj.id, "name": _name(kind, obj), "restored": True}


def purge(db: Session, kind: str, obj) -> None:
    """Delete for good - exactly what the delete buttons did before the Bin."""
    if kind == "answer":
        db.query(models.ProjectRun).filter(models.ProjectRun.conversation_id == obj.id).delete(synchronize_session=False)
        db.query(models.Dashboard).execution_options(include_trashed=True).filter(
            models.Dashboard.source_conversation_id == obj.id).update({models.Dashboard.source_conversation_id: None}, synchronize_session=False)
    elif kind == "dashboard":
        db.query(models.DashboardPageSnapshot).filter(models.DashboardPageSnapshot.dashboard_id == obj.id).delete(synchronize_session=False)
    elif kind == "pipeline":
        db.query(models.DataFlowRun).filter(models.DataFlowRun.flow_id == obj.id).delete(synchronize_session=False)
        db.query(models.DataFlowVersion).filter(models.DataFlowVersion.flow_id == obj.id).delete(synchronize_session=False)
    elif kind == "report":
        db.query(models.DocComment).filter(models.DocComment.doc_id == obj.id).delete(synchronize_session=False)
    db.delete(obj)
    db.commit()


def delete_for_good(db: Session, user: models.User, kind: str, item_id: str) -> bool:
    obj = get_any(db, kind, item_id)
    if obj is None or obj.trashed_at is None or not _mine_to_manage(user, obj):
        return False
    purge(db, kind, obj)
    return True


def empty(db: Session, user: models.User) -> int:
    n = 0
    for it in mine(db, user):
        if delete_for_good(db, user, it["kind"], it["id"]):
            n += 1
    return n


def purge_expired(db: Session | None = None) -> int:
    """The nightly job: everything in the Bin for more than 7 days is deleted for good."""
    from ..database import SessionLocal
    own = db is None
    db = db or SessionLocal()
    n = 0
    try:
        cutoff = datetime.utcnow() - timedelta(days=KEEP_DAYS)
        for kind, cls in KINDS.items():
            for obj in (db.query(cls).execution_options(include_trashed=True)
                        .filter(cls.trashed_at.isnot(None), cls.trashed_at < cutoff).all()):
                try:
                    purge(db, kind, obj)
                    n += 1
                except Exception as e:  # noqa: BLE001 - one bad row never stops the rest
                    db.rollback()
                    print(f"[bin] could not purge {kind} {obj.id}: {e}")
        if n:
            print(f"[bin] deleted {n} item(s) for good after {KEEP_DAYS} days in the Bin")
    finally:
        if own:
            db.close()
    return n
