"""
Shared access-control helpers for anything scoped to a data source, or to a
conversation/saved-table/view built on one, now that a data source can be
shared into a team workspace (see models.Workspace / routers/workspaces.py).

Three tiers, used consistently everywhere a data source (or something
built on it) is reached:

  - "accessible" ("view" tier, 2026-09-23 sharing v1): the data source's
    own owner, OR any member of the workspace it has been shared into
    (DataSource.workspace_id) - REGARDLESS of that member's role, "viewer"
    included. This is what every read-only action checks: view schema/
    preview/versions/flow/distinct-values/export, view any conversation
    and its messages, view saved views. A data source still sitting in its
    owner's personal workspace (workspace_id is NULL - a pre-migration row
    not yet backfilled, see database._ensure_personal_workspaces - or
    explicitly its owner's personal workspace) is only ever accessible to
    its owner, since a personal workspace has exactly one member by
    construction.
  - "editable" ("collaborate" tier, 2026-09-23 roles v1): the data source's
    own owner, OR a workspace member whose WorkspaceMember.role is "owner"
    or "member" - "viewer" excluded. This is what every WRITE action on a
    shared data source checks: run chat/analysis, create/continue/rename/
    pin a conversation, create/rename/delete a saved view, rename/delete a
    saved table version. A workspace's "viewer" role can see everything
    the "editable" tier produces, just never produce or change it - the
    same read/write split as a shared spreadsheet opened in view-only mode.
  - "owned" (kept as each router's own strict, unchanged helper): the data
    source's own owner only - reserved for the handful of truly
    administrative actions on the DATA SOURCE ROW ITSELF (rename it,
    delete it, reassign which workspace it lives in). This module does not
    touch those checks.

Conversations get one narrower rule of their own (see can_delete_
conversation): deleting is reserved for whoever started that specific
conversation, or the data source's own owner - not just any teammate who
happens to share the workspace (and not gated by the "editable" role at
all, deliberately: removing your own old content is a housekeeping action,
not a collaboration one), so one member can never wipe another's chat
history.

Every "not accessible" case here 404s (never 403) - matching the
info-non-leak convention routers/workspaces.py already established: a
non-member should not be able to tell "this id doesn't exist" apart from
"this id exists but isn't yours to see". A member who IS in the workspace
but lacks edit rights (a viewer trying a write action) gets a 403 instead,
same as workspaces.py's own owner-only actions - they can already see the
workspace and the thing they tried to change, so there's nothing left to
hide by pretending it doesn't exist.
"""
from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from .. import models

# Roles that carry write ("editable" tier) access on top of view access -
# a plain member has full collaborate-tier rights, same as before roles
# existed; "viewer" (added 2026-09-23) is the one role that doesn't. Kept
# as a set (not just `!= "viewer"`) so a future role slots in explicitly
# rather than silently inheriting write access by default.
_EDIT_ROLES = {"owner", "member"}


def member_workspace_ids(db: Session, user_id: str) -> set[str]:
    """Every workspace id this user belongs to (owner or member alike -
    WorkspaceMember has one row per person per workspace regardless of
    role)."""
    rows = db.query(models.WorkspaceMember.workspace_id).filter(models.WorkspaceMember.user_id == user_id).all()
    return {r[0] for r in rows}


def member_role(db: Session, user_id: str, workspace_id: str) -> str | None:
    """This user's role ("owner" | "member" | "viewer") in one specific
    workspace, or None if they aren't a member of it at all."""
    row = (
        db.query(models.WorkspaceMember.role)
        .filter(models.WorkspaceMember.workspace_id == workspace_id, models.WorkspaceMember.user_id == user_id)
        .first()
    )
    return row[0] if row else None


def can_access_datasource(db: Session, ds: models.DataSource, user: models.User) -> bool:
    """The "view" tier check for one already-fetched DataSource row - any
    role, viewer included."""
    if ds.owner_id == user.id:
        return True
    if not ds.workspace_id:
        return False
    return ds.workspace_id in member_workspace_ids(db, user.id)


def can_edit_datasource(db: Session, ds: models.DataSource, user: models.User) -> bool:
    """The "editable" tier check for one already-fetched DataSource row -
    the data source's own owner (always, regardless of any workspace
    role), or a workspace member whose role isn't "viewer"."""
    if ds.owner_id == user.id:
        return True
    if not ds.workspace_id:
        return False
    return member_role(db, user.id, ds.workspace_id) in _EDIT_ROLES


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


def can_edit_conversation(db: Session, conv: models.Conversation, user: models.User) -> bool:
    """The "editable" tier check for a Conversation: rename/pin/continue-
    chatting on it. Gated on the underlying data source's editable tier,
    not on who created the conversation - a workspace "viewer" can't rename
    or add to a conversation even if they happen to be its creator from
    before being downgraded, and conversely the data source's owner (or any
    non-viewer member) can rename/pin ANY conversation on it, matching the
    existing "workspace member can rename a teammate's Project" behavior.
    A conversation whose data source was since deleted (datasource_id is
    NULL) falls back to creator-only, since there's no workspace role left
    to check against."""
    if not conv.datasource_id:
        return conv.owner_id == user.id
    ds = db.query(models.DataSource).filter(models.DataSource.id == conv.datasource_id).first()
    return bool(ds and can_edit_datasource(db, ds, user))


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
