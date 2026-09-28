"""
Phase 5, Batch A (2026-09-28, "Data governance & quality" roadmap): writes
one models.AuditEvent row for a significant action someone just took - see
that model's own docstring for the full design and why this is genuinely
different from /admin's live-computed "Recent activity" feed.

log_audit_event deliberately does NOT call db.commit() itself. Every call
site adds the event to the SAME session as the action it's recording, right
before that endpoint's own existing db.commit() - so the action and its
audit trail are persisted together, atomically, by that one commit. If the
action fails partway through and never reaches its commit, the audit event
never gets written either, which is correct: there is nothing to log if the
action itself didn't actually happen. This is simpler and more correct than
a separate best-effort commit here, which could record an event for an
action that then rolled back, or vice versa. Do NOT "fix" this into
committing on its own - that would break the atomicity this is built for.
"""
from __future__ import annotations

from sqlalchemy.orm import Session

from .. import models


def log_audit_event(
    db: Session,
    *,
    actor: models.User,
    action: str,
    workspace_id: str | None = None,
    target_type: str | None = None,
    target_id: str | None = None,
    metadata: dict | None = None,
) -> models.AuditEvent:
    """Stages one AuditEvent row on `db` (via db.add) and returns it -
    the caller's own subsequent db.commit() is what actually persists it.
    See this module's own docstring for why there is no db.commit() here."""
    event = models.AuditEvent(
        workspace_id=workspace_id,
        actor_user_id=actor.id,
        action=action,
        target_type=target_type,
        target_id=target_id,
        event_metadata=metadata,
    )
    db.add(event)
    return event
