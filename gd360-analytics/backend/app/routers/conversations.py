"""
List and resume past chat conversations. Powers two things:
  1. The home pages "Recent conversations" panel, so a person can see and
     jump back into their last few analysis sessions without hunting for
     the right data source first.
  2. The workspace resuming a prior conversation (via a `conversation`
     query param) with its full message + chart history restored, instead
     of always starting from a blank chat.

Since 2026-09-23, a Project (Conversation) built on a data source that's
been shared into a team workspace is visible to every member of that
workspace, not just whoever started it - see services/workspace_access.py
for the shared access model this file, routers/datasources.py and
routers/chat.py all now use. Renaming/pinning it needs editable-tier
access (any role except a workspace "viewer"); deleting it is narrower
still - only its own creator, or the data source's owner
(workspace_access.can_delete_conversation), independent of role. Every
Project returned here also carries created_by_*/is_own/can_edit/can_delete
so the frontend can show who made it and which actions to offer without
re-deriving the role logic itself.
"""
import re

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user
from ..services import chart_builder, chart_model, insights, sql_filters, workspace_access
from ..services.profile_cache import cached_exact_total_rows


def _restored_exact_total_rows(ds, m) -> int | None:
    """2026-10-06 (warehouse-honesty round): the same `exact_total_rows`
    routers/chat.py attaches to a live warehouse-computed turn, resolved
    the same way - the real COUNT(*) the Data tab's profile already paid
    for and cached (services/profile_cache.py), only when exactly ONE
    table was in scope. The scoped table is derived from the persisted
    `sources` manifest: a single "sheet" entry names it directly; a single
    "original" entry means the whole data source, which is one table only
    when its schema_cache has exactly one key. Several entries (a join)
    -> None. Never a fresh COUNT(*) query, and never raises - a cache
    miss or a malformed manifest simply yields None."""
    try:
        if ds is None or not m.used_pushdown:
            return None
        sources = m.sources if isinstance(m.sources, list) else []
        if len(sources) != 1 or not isinstance(sources[0], dict):
            return None
        entry = sources[0]
        table = None
        if entry.get("kind") == "sheet" and isinstance(entry.get("sheet"), str):
            table = entry["sheet"]
        elif entry.get("kind") == "original":
            schema_cache = ds.schema_cache if isinstance(ds.schema_cache, dict) else {}
            if len(schema_cache) == 1:
                table = next(iter(schema_cache))
        if not table:
            return None
        return cached_exact_total_rows(ds.id, table)
    except Exception as e:  # noqa: BLE001
        print(f"[conversations] exact_total_rows restore skipped (non-fatal): {e}")
        return None



def _audited_chart(m) -> tuple[object, str | None]:
    """2026-10-07 (chart-integrity round): the load path's audit. A message
    stored before figures were audited can hold a chart that contradicts
    its own result rows (a pivoted result drawn as one measure against
    another). Every stored figure is checked here against the chart model
    of the rows stored beside it and, when it fails, the figure REBUILT
    from those rows is what is served - so an old conversation opens with
    the right chart without the question being asked again. Read-only: the
    row itself is not rewritten ("Double-check this" repairs it in place).
    Returns (chart_spec, chart_type); chart_type is "table" when the rows
    cannot be drawn as that chart at all."""
    spec, chart_type = m.chart_spec, m.chart_type
    if not spec:
        return spec, chart_type
    try:
        checked, _reason, problems = chart_builder.checked_chart_spec(
            spec, m.result_columns, m.result_rows, chart_type,
            context=f"message={m.id} (stored)", truncated=bool(m.result_truncated),
        )
    except Exception as e:  # noqa: BLE001 - never fail a conversation load over the audit
        print(f"[chart_audit] message={m.id} (stored) audit skipped: {e}")
        return spec, chart_type
    if not problems:
        return spec, chart_type
    return checked, (chart_type if checked is not None else "table")


# The sentence the old deterministic insight builder wrote, whatever the
# result looked like: "<a> leads at <v>, versus <b> at <w> - a gap of <g>
# (<p>% relative) (n = <N>)". It took the first numeric value of a row as
# the measure and the first other value as the label, so on a pivoted
# result the "labels" are numbers ("7081020.069999966 leads at
# 11789581.13"), on a time series it compares two years as if they were
# rivals, and a missing value is printed as "None".
_LEGACY_INSIGHT_RE = re.compile(r"\bleads at\b.{1,200}?\bversus\b.{1,200}?\ba gap of\b", re.S)
_LEGACY_WAREHOUSE_PHRASE_RE = re.compile(r"\((computed inside your [^()]{1,160})\)")
_LEGACY_N_RE = re.compile(r"\(n = ([\d,]+)\)")


def _restored_insight(m) -> object:
    """2026-10-07 (chart-integrity round): the load path's insight repair.
    An answer stored before the insight builder was rewritten can carry the
    old "leads at / versus" sentence. It is recognisable by its exact
    wording, it was computed from nothing but the result rows, and those
    rows are stored beside it - so the sentence is written again from them
    by the current builder (services/insights.py, the same chart model the
    chart is drawn from) and that is what is served. A model-written
    insight is left exactly as stored: only the old template is replaced.
    Read-only; the row is not rewritten."""
    text = m.insight
    if not isinstance(text, str) or not _LEGACY_INSIGHT_RE.search(text):
        return text
    if not m.result_columns or not m.result_rows or m.result_truncated:
        return text
    try:
        model = chart_model.derive_chart_model(m.result_columns, m.result_rows, m.chart_type)
        if model.get("kind") not in ("cartesian", "pie", "kpi"):
            return text
        # Where it was computed is kept as the old sentence stated it; a bare
        # "(n = 6)" is kept only when it is a real sample size (the old
        # sentence printed the size of the aggregated result itself).
        n_phrase = ""
        where = _LEGACY_WAREHOUSE_PHRASE_RE.search(text)
        if where:
            n_phrase = f" ({where.group(1)})"
        else:
            n_match = _LEGACY_N_RE.search(text)
            n = int(n_match.group(1).replace(",", "")) if n_match else 0
            if n >= 30 and n > len(m.result_rows):
                n_phrase = f" (n = {n:,} rows)"
        built = insights.build_insight(model, n_phrase)
        if not built:
            return text
        print(f"[insight_audit] message={m.id} (stored) the old 'leads at / versus' insight was rewritten from the result table")
        return built["text"]
    except Exception as e:  # noqa: BLE001 - never fail a conversation load over the insight
        print(f"[insight_audit] message={m.id} (stored) insight left as stored: {e}")
        return text


def _restored_query_filters(ds, m) -> object:
    """The row filters behind a stored answer. An answer stored since
    2026-10-07 carries them (Message.query_filters). An OLDER warehouse
    answer has only the SQL that ran - which is everything needed: the
    same parser reads it here, so the chart the founder already has
    ("total revenue" computed WHERE is_canceled = 0) says so the next time
    it is opened, without the question being asked again. Read-only, and
    never a reason for a conversation not to load."""
    if m.query_filters is not None:
        return m.query_filters
    if not (m.used_pushdown and m.pushdown_sql and ds is not None):
        return None
    try:
        info = sql_filters.extract_query_filters(m.pushdown_sql, ds.kind)
        info["text"] = sql_filters.describe_filters(info)
        info["writer_note"] = None
        return info
    except Exception as e:  # noqa: BLE001
        print(f"[conversations] filters for message={m.id} could not be derived (non-fatal): {e}")
        return None


def _audited_results(m) -> object:
    """The same audit for every card of a multi-result answer."""
    results = m.results
    if not isinstance(results, list):
        return results
    out = []
    for entry in results:
        if isinstance(entry, dict) and entry.get("chart_spec"):
            try:
                checked, _reason, problems = chart_builder.checked_chart_spec(
                    entry.get("chart_spec"), entry.get("result_columns"), entry.get("result_rows"), entry.get("chart_type"),
                    context=f"message={m.id} result={entry.get('label')!r} (stored)", truncated=bool(entry.get("result_truncated")),
                )
                if problems:
                    entry = {**entry, "chart_spec": checked, "chart_type": entry.get("chart_type") if checked is not None else None}
            except Exception as e:  # noqa: BLE001
                print(f"[chart_audit] message={m.id} (stored) result audit skipped: {e}")
        out.append(entry)
    return out


router = APIRouter(prefix="/conversations", tags=["conversations"])


@router.get("")
def list_conversations(
    workspace_id: str | None = None,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    if workspace_id:
        # A Project's workspace is its data source's workspace - there is
        # no separate workspace_id on Conversation itself, so this is
        # exactly the same NULL-means-personal-workspace rule
        # routers/datasources.py list_datasources uses, applied through the
        # join instead of directly. Must actually belong to the requested
        # workspace to see anything in it.
        member = (
            db.query(models.WorkspaceMember)
            .filter(models.WorkspaceMember.workspace_id == workspace_id, models.WorkspaceMember.user_id == user.id)
            .first()
        )
        if not member:
            return []
        ds_ids_in_workspace = workspace_access.accessible_datasource_ids_in_workspace(db, user, workspace_id)
        query = db.query(models.Conversation).filter(models.Conversation.datasource_id.in_(ds_ids_in_workspace))
    else:
        query = db.query(models.Conversation).filter(workspace_access.conversation_access_filter(db, user))
    conversations = query.all()

    datasource_names: dict[str, str] = {}
    ds_ids = {c.datasource_id for c in conversations if c.datasource_id}
    if ds_ids:
        rows = db.query(models.DataSource).filter(models.DataSource.id.in_(ds_ids)).all()
        datasource_names = {row.id: row.name for row in rows}

    # Who created each Project - batched into one lookup rather than a
    # query per row (2026-09-23, roles & attribution round) - so a shared
    # workspace's Projects list can show "by <name>" instead of every
    # teammate's Projects looking anonymous/like they came from whoever's
    # looking at the list right now.
    creator_ids = {c.owner_id for c in conversations}
    creators = {
        u.id: u for u in db.query(models.User).filter(models.User.id.in_(creator_ids)).all()
    } if creator_ids else {}

    out = []
    for c in conversations:
        messages = sorted(c.messages, key=lambda m: m.created_at)
        if not messages:
            continue
        last = messages[-1]

        last_chart_type = None
        for m in reversed(messages):
            spec = m.chart_spec
            if spec:
                data = spec.get("data") if isinstance(spec, dict) else None
                if data and isinstance(data, list) and data:
                    last_chart_type = data[0].get("type")
                break

        creator = creators.get(c.owner_id)
        out.append({
            "id": c.id,
            "title": c.title or "Untitled analysis",
            "datasource_id": c.datasource_id,
            "datasource_name": datasource_names.get(c.datasource_id) if c.datasource_id else None,
            "message_count": len(messages),
            "last_message": last.content,
            "last_chart_type": last_chart_type,
            "pinned": bool(c.pinned),
            # 2026-09-23 (folders round): which Folder this Project is
            # filed into, if any - NULL/omitted means "unfiled", the
            # Projects page's default view. See routers/folders.py.
            "folder_id": c.folder_id,
            "created_at": c.created_at,
            "updated_at": last.created_at,
            "created_by_id": c.owner_id,
            "created_by_name": creator.full_name if creator else None,
            "created_by_email": creator.email if creator else None,
            "is_own": c.owner_id == user.id,
            # Server-computed, so the frontend never has to re-derive the
            # role logic itself: a workspace "viewer" (or anyone else
            # without editable-tier access) gets both flags false here and
            # simply doesn't render the rename/pin/delete affordances.
            "can_edit": workspace_access.can_edit_conversation(db, c, user),
            "can_delete": workspace_access.can_delete_conversation(db, c, user),
        })

    # Pinned conversations always float to the top (the same convention as
    # every mainstream chat app), newest-first within each of the two
    # groups - so pinning something is immediately visible as "moved up",
    # not just a quiet badge easy to miss. Python's sort is stable, so
    # sorting by updated_at first and then, separately, by pinned keeps
    # each group in updated_at order without needing a combined key.
    out.sort(key=lambda row: row["updated_at"], reverse=True)
    out.sort(key=lambda row: row["pinned"], reverse=True)
    return out


@router.patch("/bulk-move")
def bulk_move_conversations(
    payload: schemas.BulkMoveConversationsRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Files (or unfiles, if folder_id is None) several Projects into a
    folder at once - the "select some or all, move to folder" bulk action
    on the Projects page (2026-09-23, folders round). Registered ABOVE the
    "/{conversation_id}" route below so "bulk-move" is never swallowed by
    it as a literal conversation id - route order matters here.

    Each conversation is moved only if this user has editable-tier access
    to it (same check update_conversation uses below) - anything else in
    the list is silently skipped rather than failing the whole batch, since
    a stale selection (something deleted or re-shared out from under the
    person a moment ago) shouldn't block moving everything else they
    legitimately can. The response says exactly which ids landed and which
    didn't, so the frontend can tell the person if anything was skipped."""
    target_folder = None
    if payload.folder_id is not None:
        target_folder = db.query(models.Folder).filter(models.Folder.id == payload.folder_id).first()
        if not target_folder:
            raise HTTPException(404, "Folder not found.")
        role = workspace_access.member_role(db, user.id, target_folder.workspace_id)
        is_edit_role = role in {"owner", "member"} or target_folder.owner_id == user.id
        if role is None and target_folder.owner_id != user.id:
            raise HTTPException(404, "Folder not found.")
        if not is_edit_role:
            raise HTTPException(403, "You have view-only access to this workspace.")

    moved: list[str] = []
    skipped: list[str] = []
    conversations = (
        db.query(models.Conversation)
        .filter(models.Conversation.id.in_(payload.conversation_ids))
        .all()
    )
    found_by_id = {c.id: c for c in conversations}
    for conv_id in payload.conversation_ids:
        conv = found_by_id.get(conv_id)
        if not conv or not workspace_access.can_edit_conversation(db, conv, user):
            skipped.append(conv_id)
            continue
        conv.folder_id = target_folder.id if target_folder else None
        moved.append(conv_id)
    db.commit()
    return {"moved": moved, "skipped": skipped, "folder_id": target_folder.id if target_folder else None}


@router.patch("/{conversation_id}")
def update_conversation(
    conversation_id: str,
    payload: schemas.UpdateConversationRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Updates a conversation's title and/or pinned state - either or both,
    whichever the caller actually sent. Shown everywhere a conversation is
    listed: the homepage's Recent conversations, a data source's own
    conversation list, and the Workspace page's own Recent conversations
    panel. All three read the same row from here, so a change made in any
    one of them is instantly reflected everywhere else too, the next time
    each is loaded. Editable-tier: the data source's owner, or a workspace
    member whose role isn't "viewer", can rename/pin it - not just whoever
    started it, but a read-only workspace member cannot (2026-09-23)."""
    conv = db.query(models.Conversation).filter(models.Conversation.id == conversation_id).first()
    if not conv or not workspace_access.can_access_conversation(db, conv, user):
        raise HTTPException(404, "Conversation not found.")
    if not workspace_access.can_edit_conversation(db, conv, user):
        raise HTTPException(403, "You have view-only access to this Project.")
    if payload.title is not None:
        conv.title = payload.title.strip()[:80] or conv.title
    if payload.pinned is not None:
        conv.pinned = payload.pinned
    db.commit()
    return {"id": conv.id, "title": conv.title, "pinned": bool(conv.pinned)}


@router.delete("/{conversation_id}")
def delete_conversation(
    conversation_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)
):
    """Permanently removes a conversation and every message in it (the
    ORM relationship's cascade="all, delete-orphan" takes care of the
    messages once the parent row is deleted through the session, so this
    never leaves orphaned rows behind). This only ever deletes the saved
    chat/analysis history itself - any table version it produced along the
    way stays in the data source's Data tab exactly as it would if the
    conversation had simply been left alone.

    Narrower than viewing/renaming (see workspace_access.
    can_delete_conversation): only this Project's own creator, or the data
    source's owner, can delete it - a shared workspace lets teammates work
    together on a Project, not wipe out each other's chat history."""
    conv = db.query(models.Conversation).filter(models.Conversation.id == conversation_id).first()
    if not conv or not workspace_access.can_delete_conversation(db, conv, user):
        raise HTTPException(404, "Conversation not found.")
    db.delete(conv)
    db.commit()
    return {"id": conversation_id, "deleted": True}


@router.get("/{conversation_id}/messages")
def get_conversation_messages(
    conversation_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)
):
    conv = db.query(models.Conversation).filter(models.Conversation.id == conversation_id).first()
    if not conv or not workspace_access.can_access_conversation(db, conv, user):
        raise HTTPException(404, "Conversation not found.")

    messages = sorted(conv.messages, key=lambda m: m.created_at)
    creator = db.query(models.User).filter(models.User.id == conv.owner_id).first()
    # 2026-10-06 (warehouse-honesty round): pushdown_provider is not
    # stored on the row (it is simply the data source's kind) - resolved
    # once here so a restored warehouse turn carries the same provider the
    # live response did. Imported lazily to keep this router free of any
    # import-time dependency on routers/chat.py.
    from .chat import PUSHDOWN_ELIGIBLE_KINDS  # noqa: WPS433
    ds = db.query(models.DataSource).filter(models.DataSource.id == conv.datasource_id).first() if conv.datasource_id else None
    pushdown_provider = ds.kind if ds and ds.kind in PUSHDOWN_ELIGIBLE_KINDS else None
    # The load path's chart audit (see _audited_chart): once per message.
    audited = {m.id: _audited_chart(m) for m in messages}
    return {
        "id": conv.id,
        "title": conv.title,
        "datasource_id": conv.datasource_id,
        "created_by_id": conv.owner_id,
        "created_by_name": creator.full_name if creator else None,
        "created_by_email": creator.email if creator else None,
        "is_own": conv.owner_id == user.id,
        "can_edit": workspace_access.can_edit_conversation(db, conv, user),
        "can_delete": workspace_access.can_delete_conversation(db, conv, user),
        "messages": [
            {
                "id": m.id,
                "role": m.role,
                "content": m.content,
                # The stored figure, checked against the stored rows and
                # rebuilt from them when it does not match (_audited_chart).
                "chart_spec": audited[m.id][0],
                # The chart type + tidy underlying rows this chart was built
                # from (see chart_builder.result_to_tidy) - resuming a saved
                # conversation needs these too, not just a live turn, so the
                # Explore panel keeps working (instant, client-side chart
                # type/axis/filter changes) after a page reload.
                "chart_type": audited[m.id][1],
                "result_columns": m.result_columns,
                "result_rows": m.result_rows,
                "result_truncated": m.result_truncated,
                "insight": _restored_insight(m),
                "suggestions": m.suggestions,
                "needs_clarification": m.needs_clarification,
                # Which kind of turn this was - needed so a resumed
                # conversation can show the "Double-check this" action on
                # the same messages a live one does (only analyze/transform
                # turns that actually computed something).
                "action": m.action,
                # 2026-09-28 root-cause fix: this endpoint used to leave off
                # the exact "sources manifest" _load_selected_tables built
                # when this turn actually ran (see routers/chat.py
                # _persist_and_respond, which already stores it on
                # Message.sources - it was just never handed back here).
                # Without it, Workspace.tsx's restore-on-refresh effect had
                # no way to know what the real WORKING ON selection was for
                # this conversation, and fell back to a crude "just the most
                # recently created table for this whole data source"
                # default - which is exactly the bug Gokul reported: every
                # table past the first silently disappearing from WORKING ON
                # on a page refresh. Exposing the real manifest here lets
                # the frontend reconstruct the actual selection instead of
                # guessing. new_version_id (already stored on Message the
                # same way) rides along for the same reason.
                "sources": m.sources,
                "new_version_id": m.new_version_id,
                # See models.Message.steps' own docstring - the real "what
                # I did" trace, restored here too so reopening a saved
                # conversation still shows it under each past turn.
                "steps": m.steps,
                # See models.Message.results/self_critique's own docstrings
                # - restored here too so reopening a saved conversation
                # still shows every card of a multi-result answer, and its
                # honest caveat, not just the first one.
                "results": _audited_results(m),
                "self_critique": m.self_critique,
                # 2026-09-29 (plain-language findings round): the real
                # method/code/duration behind this turn (see
                # schemas.ChatResponse's own comment on these three) -
                # restored here too so reopening a saved conversation keeps
                # showing "Show calculation" under a past turn, not just a
                # freshly-sent live one.
                "method_summary": m.method_summary,
                "code": m.code,
                "duration_ms": m.duration_ms,
                # 2026-10-06 (pushdown-honesty round): whether this past
                # turn ran a real query directly against the warehouse/
                # database, or analyzed a loaded sample - see models.
                # Message.used_pushdown/sample_row_count's own docstring.
                # Restored here too so reopening a saved conversation keeps
                # showing the honest "ran directly" / "based on a sample"
                # badge under a past turn, not just a freshly-sent live one.
                "used_pushdown": m.used_pushdown,
                "sample_row_count": m.sample_row_count,
                # 2026-10-06 (warehouse-honesty round): what ran inside the
                # warehouse for this turn, or why it could not - see
                # models.Message.pushdown_sql and friends and schemas.
                # ChatResponse's own comment. Restored so reopening a chat
                # shows the same "ran this SQL over every row" detail, or
                # the same needs_query_help attempts, as the live turn did.
                # builder_suggestion lives inside `suggestions` on the row
                # (see routers/chat.py _persist_and_respond) and is lifted
                # back to top level here; builder_columns is derived from
                # the data source's schema_cache, which the frontend already
                # has, so it is not repeated per message.
                "pushdown_sql": m.pushdown_sql,
                "pushdown_provider": pushdown_provider if (m.used_pushdown or m.action == "needs_query_help") else None,
                "pushdown_bytes_scanned": m.pushdown_bytes_scanned,
                "pushdown_duration_ms": m.pushdown_duration_ms,
                "pushdown_result_rows": m.pushdown_result_rows,
                "pushdown_attempts": m.pushdown_attempts,
                "pushdown_skipped_reason": m.pushdown_skipped_reason,
                # Resolved from the profile cache exactly like the live
                # turn (see _restored_exact_total_rows above) - null when
                # the cache has expired, several tables were joined, or
                # the turn was not warehouse-computed.
                "exact_total_rows": _restored_exact_total_rows(ds, m),
                # 2026-10-07 ("say what was filtered"): the row filters
                # behind this answer - see models.Message.query_filters.
                "query_filters": _restored_query_filters(ds, m),
                "builder_suggestion": (m.suggestions or {}).get("builder_suggestion") if isinstance(m.suggestions, dict) else None,
                "created_at": m.created_at,
            }
            for m in messages
        ],
    }
