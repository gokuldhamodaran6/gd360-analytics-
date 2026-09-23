"""
Shared access-control helpers for anything scoped to a data source, or to a
conversation/saved-table/view built on one, now that a data source can be
shared into a team workspace (see models.Workspace / routers/workspaces.py).

Two tiers, used consistently everywhere a data source (or something built
on it) is reached:

  - "accessible" ("collaborate" tier): the data source's own owner, OR any
    member of the workspace it has been shared into (DataSource.
    workspace_id). This is what every view/preview/schema/versions/flow/
    saved-view/export/chat/Goku action checks. A data source still sitting
    in its owner's personal workspace (workspace_id is NULL - a pre-
    migration row not yet backfilled, see database._ensure_personal_
    workspaces - or explicitly its owner's personal workspace) is only
    ever accessible to its owner, since a personal workspace has exactly
    one member by construction.
  - "owned" (kept as each router's own strict, unchanged helper): the data
    source's own owner only - reserved for the handful of truly
    administrative actions on the DATA SOURCE ROW ITSELF (rename it,
    delete it, reassign which workspace it lives in). This module does not
    touch those checks; it only adds the broader "accessible" one.

Everything a data source's collaborators build ON it - saved/cleaned
tables, saved views, conversations, chat messages - inherits "accessible"
once the data source itself passes, the same way a shared spreadsheet
works: anyone with access can view and add to its contents; only the
owner can delete the sheet itself or change who it is shared with.

Conversations get one narrower rule of their own (see can_delete_
conversation): deleting is reserved for whoever started that specific
conversation, or the data source's own owner - not just any teammate who
happens to share the workspace, so one member can never wipe another's
chat history.

Every "not accessible" case here 404s (never 403) - matching the
info-non-leak convention routers/workspaces.py already established: a
non-member should not be able to tell "this id doesn't exist" apart from
"this id exists but isn't yours to see".
"""
from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from .. import models


def member_workspace_ids(db: Session, user_id: str) -> set[str]:
    """Every workspace id this user belongs to (owner or member alike -
    WorkspaceMember has one row per person per workspace regardless of
    role)."""
    rows = db.query(models.WorkspaceMember.workspace_id).filter(models.WorkspaceMember.user_id == user_id).all()
    return {r[0] for r in rows}


def can_access_datasource(db: Session, ds: models.DataSource, user: models.User) -> bool:
    """The "collaborate" tier check for one already-fetched DataSource row."""
    if ds.owner_id == user.id:
        return True
    if not ds.workspace_id:
        return False
    return ds.workspace_id in member_workspace_ids(db, user.id)


def datasource_access_filter(db: Session, user: models.User):
    """A SQLAlchemy filter expression for "every DataSource this user can
    at least view" - their own (regardless of workspace_id, including a
    still-NULL/legacy row), plus any other owner's data source that has
    been explicitly shared into a workspace this user is a member of. Used
    by list_datasources' base (no specific workspace_id requested) query."""
    ws_ids = member_workspace_ids(db, user.id)
    if not ws_ids:
        return models.DataSource.owner_id == user.id
    return or_(
        models.DataSource.owner_id == user.id,
        and_(models.DataSource.workspace_id.isnot(None), models.DataSource.workspace_id.in_(ws_ids)),
    )


def accessible_datasource_ids_in_workspace(db: Session, user: models.User, workspace_id: str) -> set[str]:
    """Every DataSource id visible to this user when they've asked to see
    one specific workspace - anything actually tagged with that
    workspace_id (regardless of who owns it; membership in the workspace
    itself is the caller's job to have already checked), plus, only when
    that workspace happens to be the caller's own personal one, their own
    still-NULL/legacy rows (the same NULL-means-personal-workspace
    fallback every other list/filter in this app uses)."""
    ws = db.query(models.Workspace).filter(models.Workspace.id == workspace_id).first()
    q = db.query(models.DataSource.id)
    if ws and ws.is_personal:
        q = q.filter(
            models.DataSource.owner_id == user.id,
            or_(models.DataSource.workspace_id == workspace_id, models.DataSource.workspace_id.is_(None)),
        )
    else:
        q = q.filter(models.DataSource.workspace_id == workspace_id)
    return {row[0] for row in q.all()}


def can_access_conversation(db: Session, conv: models.Conversation, user: models.User) -> bool:
    """The "collaborate" tier check for a Conversation: its own creator,
    always; otherwise whoever can access the data source it's built on. A
    conversation whose data source was since deleted (datasource_id is
    NULL - see datasources.delete_datasource) is only ever visible to its
    own creator from then on, since there is nothing left to share it
    through."""
    if conv.owner_id == user.id:
        return True
    if not conv.datasource_id:
        return False
    ds = db.query(models.DataSource).filter(models.DataSource.id == conv.datasource_id).first()
    return bool(ds and can_access_datasource(db, ds, user))


def can_delete_conversation(db: Session, conv: models.Conversation, user: models.User) -> bool:
    """Deleting a conversation permanently removes its whole chat history,
    so this is deliberately narrower than can_access_conversation above:
    only the person who started THIS conversation, or the data source's
    own owner (acting as the workspace's admin for whatever's been built
    on their data) - never just any teammate who happens to share the
    workspace it's in."""
    if conv.owner_id == user.id:
        return True
    if not conv.datasource_id:
        return False
    ds = db.query(models.DataSource).filter(models.DataSource.id == conv.datasource_id).first()
    return bool(ds and ds.owner_id == user.id)


def conversation_access_filter(db: Session, user: models.User):
    """A SQLAlchemy filter expression for "every Conversation this user can
    at least view" - their own, plus any conversation built on a data
    source shared into a workspace they're a member of. Used by
    conversations.list_conversations' base (no specific workspace_id
    requested) query."""
    ws_ids = member_workspace_ids(db, user.id)
    if not ws_ids:
        return models.Conversation.owner_id == user.id
    shared_ds_ids = {
        row[0]
        for row in db.query(models.DataSource.id)
        .filter(models.DataSource.workspace_id.isnot(None), models.DataSource.workspace_id.in_(ws_ids))
        .all()
    }
    if not shared_ds_ids:
        return models.Conversation.owner_id == user.id
    return or_(models.Conversation.owner_id == user.id, models.Conversation.datasource_id.in_(shared_ds_ids))
