"""2026-10-14 (R46, GD360 2.0): the conversation API behind the chat-first app
(frontend/src/chat). One box; every capability a sentence away.

GET  /v2/home                                  Spaces, sources, recent conversations, plan and usage
POST /v2/conversations                         start a conversation with a first message
GET  /v2/conversations                         the list (library)
GET  /v2/conversations/{id}                    the conversation with its turns
PATCH /v2/conversations/{id}                   rename / pin
POST /v2/conversations/{id}/messages           one more message (routed to a tool)
GET  /v2/conversations/{id}/turns/{turn_id}    one turn (polled while it works)
POST /v2/conversations/{id}/turns/{turn_id}/confirm   confirm or decline a card
POST /v2/conversations/{id}/dashboard          build a dashboard from answers in this conversation
GET  /v2/conversations/{id}/documents/{turn_id}.md   download a written document
GET  /v2/plan                                  the plan, its limits and today's usage

A turn the project engine answers is a ProjectRun: the page reads it in full from
GET /projects/runs/{id}, exactly as the classic page does.
"""
from __future__ import annotations

import json
from datetime import date, datetime

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import models
from ..database import get_db
from ..deps import get_current_user
from ..services import automations as automations_svc
from ..services import spaces as spaces_service
from ..services.agent import analysis, board, docblocks, docexport, examples, exports, plans, turns, web
from ..services.project_engine.catalog import accessible_sources
from . import projects

router = APIRouter(prefix="/v2", tags=["v2"])

MODES = ("auto", "quick", "guided")


class StartRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    space_id: str | None = None
    source_ids: list[str] | None = None
    workspace_id: str | None = None
    mode: str = "auto"
    today: str | None = Field(default=None, max_length=10)
    timezone: str = Field(default="UTC", max_length=64)
    intent: str | None = None


class MessageRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    mode: str = "auto"
    accepted: list[str] = Field(default_factory=list, max_length=10)
    context_run_id: str | None = None
    today: str | None = Field(default=None, max_length=10)
    timezone: str = Field(default="UTC", max_length=64)
    intent: str | None = None


class ConfirmRequest(BaseModel):
    approve: bool = True
    edits: dict | None = None


class DocPatch(BaseModel):
    title: str | None = None


class BlockEdit(BaseModel):
    instruction: str | None = None
    text: str | None = None


class DashboardFromRequest(BaseModel):
    run_ids: list[str] | None = None
    name: str | None = Field(default=None, max_length=120)


class UpdateRequest(BaseModel):
    title: str | None = Field(default=None, max_length=80)
    pinned: bool | None = None


def _today(s: str | None) -> date:
    try:
        return date.fromisoformat(s) if s else date.today()
    except ValueError:
        return date.today()


def _conv(db: Session, conversation_id: str, user: models.User, edit: bool = False) -> models.Conversation:
    return projects._project(db, conversation_id, user, edit=edit)


def _first_name(user: models.User) -> str:
    """2026-10-15 (R48): a name, capitalised when it had to come from the email."""
    full = (user.full_name or "").strip()
    if full:
        return full.split(" ")[0]
    stem = (user.email or "").split("@")[0].split(".")[0].split("_")[0]
    return stem[:1].upper() + stem[1:] if stem else ""


@router.get("/home")
def home(workspace_id: str | None = None, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    convs = turns.list_conversations(db, user, workspace_id, limit=40)  # first: it files conversations into Spaces
    spaces = [spaces_service.space_out(db, s, user) for s in spaces_service.list_spaces(db, user, workspace_id)]
    sources = [projects._source_summary(db, ds, user) for ds in accessible_sources(db, user, workspace_id)]
    src_rows = accessible_sources(db, user, workspace_id)
    return {
        "user": {"id": user.id, "first_name": _first_name(user), "email": user.email},
        "spaces": spaces, "sources": sources, "conversations": convs,
        "plan": plans.summary(db, user, workspace_id), "web": web.available(), "web_provider": web.provider(),
        "examples": examples.for_sources(src_rows, web.available()),
    }


@router.get("/plans")
def public_plans():
    """The four plans, for the pricing page. Every feature on every plan; limits differ."""
    return {"plans": {k: {"label": v["label"], "who": v["who"], "price": v["price"], "limits": v["limits"], "model_tier": v["model_tier"],
                          "support": v["support"]} for k, v in plans.PLANS.items()},
            "all_features": True, "enforced": bool(plans.settings.PLAN_ENFORCE)}


def _dash_page(db: Session, user: models.User, dashboard_id: str, page_id: str | None):
    from .dashboard_builder import _get_dashboard_v2
    d = _get_dashboard_v2(db, user, dashboard_id, require_edit=False)
    pages = sorted(d.pages, key=lambda p: p.position)
    page = next((p for p in pages if p.id == page_id), None) if page_id else (pages[0] if pages else None)
    if page is None:
        raise HTTPException(404, "Page not found.")
    return d, page


def _safe(name: str) -> str:
    return "".join(c if c.isalnum() or c in " -_" else "" for c in (name or "dashboard")).strip().replace(" ", "-")[:60] or "dashboard"


@router.get("/dashboards/{dashboard_id}/export.xlsx")
def export_xlsx(dashboard_id: str, page_id: str | None = None, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    d, page = _dash_page(db, user, dashboard_id, page_id)
    blocks = exports.page_blocks(db, user, d, page)
    data = exports.workbook(d, page, blocks)
    return Response(content=data, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f'attachment; filename="{_safe(d.name)}.xlsx"'})


@router.get("/dashboards/{dashboard_id}/export.pptx")
def export_pptx(dashboard_id: str, page_id: str | None = None, theme: str = "light", db: Session = Depends(get_db),
                user: models.User = Depends(get_current_user)):
    d, page = _dash_page(db, user, dashboard_id, page_id)
    blocks = exports.page_blocks(db, user, d, page)
    data = exports.deck(d, page, blocks, theme="dark" if theme == "dark" else "light")
    return Response(content=data, media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
                    headers={"Content-Disposition": f'attachment; filename="{_safe(d.name)}.pptx"'})


@router.get("/dashboards/{dashboard_id}/data")
def dashboard_data(dashboard_id: str, page_id: str | None = None, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    """Get the data: every block's rows as the page shows them, with the definition behind each."""
    d, page = _dash_page(db, user, dashboard_id, page_id)
    blocks = exports.page_blocks(db, user, d, page)
    ds = db.get(models.DataSource, d.datasource_id) if d.datasource_id else None
    return {"dashboard": {"id": d.id, "name": d.name}, "page": {"id": page.id, "name": page.name},
            "source": {"id": ds.id, "name": ds.name, "kind": ds.kind} if ds else None,
            "blocks": [{"id": b["id"], "title": b["title"], "type": b["type"], "columns": b["columns"], "rows": b["rows"][:500],
                        "row_count": len(b["rows"]), "kpi": b["kpi"], "definition": _definition(b)} for b in blocks]}


def _definition(b: dict) -> str | None:
    spec = b.get("spec") or {}
    if not isinstance(spec, dict) or not spec:
        return None
    ms = ", ".join(f"{m.get('agg', '')}({m.get('column') or m.get('expr') or ''}) as {m.get('alias')}" for m in (spec.get("measures") or []) if isinstance(m, dict))
    gb = ", ".join(spec.get("group_by") or [])
    t = spec.get("time") or {}
    parts = [p for p in (ms, f"by {gb}" if gb else "", f"per {t.get('grain')} of {t.get('column')}" if isinstance(t, dict) and t.get("column") else "",
                         f"from {spec.get('table')}" if spec.get("table") else "") if p]
    return " · ".join(parts) or None


# ---- 2026-10-15 (R49): designed boards ---------------------------------------------------------

class BoardRun(BaseModel):
    page_id: str | None = None
    filters: dict | None = None


class BoardPatch(BaseModel):
    name: str | None = Field(default=None, max_length=80)
    theme: str | None = None
    default_filters: dict | None = None


def _board(db: Session, board_id: str, user: models.User, edit: bool = False) -> models.Dashboard:
    from .dashboards import _can_edit, _can_view
    d = db.get(models.Dashboard, board_id)
    if d is None or (d.layout_version or 0) != 4 or not _can_view(db, d, user):
        raise HTTPException(404, "This dashboard isn't here, or isn't shared with you.")
    if edit and not _can_edit(db, d, user):
        raise HTTPException(403, "You can view this dashboard but not change it.")
    try:
        d.last_viewed_at = datetime.utcnow()
        db.commit()
    except Exception:  # noqa: BLE001 - a view stamp never blocks the page
        db.rollback()
    return d


def _filters_arg(filters: str | None) -> dict | None:
    if not filters:
        return None
    try:
        v = json.loads(filters)
        return v if isinstance(v, dict) else None
    except ValueError:
        return None


@router.get("/boards/{board_id}")
def get_board(board_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    from .dashboards import _can_edit
    d = _board(db, board_id, user)
    return board.summary(d) | {"can_edit": _can_edit(db, d, user)}


@router.post("/boards/{board_id}/run")
def run_board(board_id: str, payload: BoardRun, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    d = _board(db, board_id, user)
    try:
        return board.compute(db, user, d, payload.page_id, payload.filters)
    except analysis.AnalysisError as e:
        raise HTTPException(400, str(e))


@router.patch("/boards/{board_id}")
def patch_board(board_id: str, payload: BoardPatch, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    from sqlalchemy.orm.attributes import flag_modified
    d = _board(db, board_id, user, edit=True)
    spec = dict(d.board_spec or {})
    if payload.name and payload.name.strip():
        d.name = payload.name.strip()[:80]
        spec["title"] = d.name
    if payload.theme:
        if payload.theme not in board.THEMES:
            raise HTTPException(400, "Unknown theme.")
        spec["theme"] = payload.theme
        spec.pop("accent", None)
    if payload.default_filters is not None:
        spec["default_filters"] = {k: v for k, v in payload.default_filters.items() if v not in (None, "", "All")}
    d.board_spec = spec
    flag_modified(d, "board_spec")
    db.commit()
    return board.summary(d)


@router.post("/boards/{board_id}/refresh")
def refresh_board(board_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    d = _board(db, board_id, user)
    board.forget((d.board_spec or {}).get("source", {}).get("source_id") or "")
    return {"ok": True}


@router.get("/boards/{board_id}/export.xlsx")
def board_xlsx(board_id: str, filters: str | None = None, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    d = _board(db, board_id, user)
    data = board.workbook(db, user, d, _filters_arg(filters))
    return Response(content=data, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f'attachment; filename="{_safe(d.name)}.xlsx"'})


@router.get("/boards/{board_id}/export.pptx")
def board_pptx(board_id: str, filters: str | None = None, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    d = _board(db, board_id, user)
    data = board.deck(db, user, d, _filters_arg(filters))
    return Response(content=data, media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
                    headers={"Content-Disposition": f'attachment; filename="{_safe(d.name)}.pptx"'})


@router.get("/plan")
def plan(workspace_id: str | None = None, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    return plans.summary(db, user, workspace_id)


@router.post("/conversations", status_code=201)
def start(payload: StartRequest, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    projects._rate_limit(user.id)
    if payload.mode not in MODES:
        raise HTTPException(400, "mode must be auto, quick or guided")
    conv = turns.new_conversation(db, user, question=payload.message, space_id=payload.space_id, source_ids=payload.source_ids,
                                  workspace_id=payload.workspace_id)
    turn = turns.send(db, conv, user, payload.message, mode=payload.mode, today=_today(payload.today), timezone=payload.timezone,
                      intent=payload.intent)
    return {"conversation": turns.conversation_out(db, conv, user), "turn": turn}


@router.get("/conversations")
def list_conversations(workspace_id: str | None = None, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    return {"conversations": turns.list_conversations(db, user, workspace_id, limit=200)}


@router.get("/conversations/{conversation_id}")
def get_conversation(conversation_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    conv = _conv(db, conversation_id, user)
    return turns.conversation_out(db, conv, user)


@router.patch("/conversations/{conversation_id}")
def update_conversation(conversation_id: str, payload: UpdateRequest, db: Session = Depends(get_db),
                        user: models.User = Depends(get_current_user)):
    conv = _conv(db, conversation_id, user, edit=True)
    if payload.title is not None and payload.title.strip():
        conv.title = payload.title.strip()[:80]
    if payload.pinned is not None:
        conv.pinned = bool(payload.pinned)
    db.commit()
    return {"id": conv.id, "title": conv.title, "pinned": bool(conv.pinned)}


@router.post("/conversations/{conversation_id}/messages", status_code=201)
def send_message(conversation_id: str, payload: MessageRequest, db: Session = Depends(get_db),
                 user: models.User = Depends(get_current_user)):
    projects._rate_limit(user.id)
    if payload.mode not in MODES:
        raise HTTPException(400, "mode must be auto, quick or guided")
    conv = _conv(db, conversation_id, user, edit=True)
    if not turns.is_v2(conv):
        meta = dict(conv.thread_meta or {}) | {"v2": True}
        turns._save_meta(db, conv, meta)
    return turns.send(db, conv, user, payload.message, mode=payload.mode, today=_today(payload.today), accepted=payload.accepted,
                      context_run_id=payload.context_run_id, timezone=payload.timezone, intent=payload.intent)


@router.get("/conversations/{conversation_id}/turns/{turn_id}")
def get_turn(conversation_id: str, turn_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    conv = _conv(db, conversation_id, user)
    msg = db.get(models.Message, turn_id)
    if msg is not None and msg.conversation_id == conv.id and (msg.action or "").startswith("v2:"):
        return turns._message_turn(db, msg, conv, user)
    run = db.get(models.ProjectRun, turn_id)
    if run is not None and run.conversation_id == conv.id:
        return turns._run_turn(db, run, conv, user, full=False)
    raise HTTPException(404, "Turn not found.")


@router.get("/conversations/{conversation_id}/turns/{turn_id}/export.{kind}")
def export_list(conversation_id: str, turn_id: str, kind: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    """R52: a list turn ("the 135 high-risk customers") as Excel or CSV - every stored row, cut by the viewer's data rules."""
    from ..services.agent import followups
    conv = _conv(db, conversation_id, user)
    msg = db.get(models.Message, turn_id)
    if msg is None or msg.conversation_id != conv.id or kind not in ("xlsx", "csv"):
        raise HTTPException(404, "Turn not found.")
    lst = turns.list_for(db, msg, user, full=True)
    if not lst:
        raise HTTPException(404, "This turn has no list.")
    if lst.get("restricted") and not lst.get("rows"):
        raise HTTPException(403, lst["restricted"])
    name = "".join(c if c.isalnum() or c in " -_" else "" for c in str(lst.get("title") or "list")).strip().replace(" ", "-")[:60] or "list"
    if kind == "xlsx":
        body, mt = followups.list_xlsx(lst), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    else:
        body, mt = followups.list_csv(lst), "text/csv; charset=utf-8"
    return Response(content=body, media_type=mt, headers={"Content-Disposition": f'attachment; filename="{name}.{kind}"'})


@router.post("/conversations/{conversation_id}/turns/{turn_id}/confirm")
def confirm_turn(conversation_id: str, turn_id: str, payload: ConfirmRequest, db: Session = Depends(get_db),
                 user: models.User = Depends(get_current_user)):
    conv = _conv(db, conversation_id, user, edit=True)
    return turns.confirm(db, conv, user, turn_id, approve=payload.approve, edits=payload.edits)


@router.post("/conversations/{conversation_id}/turns/{turn_id}/revise")
def revise_turn(conversation_id: str, turn_id: str, payload: ConfirmRequest, db: Session = Depends(get_db),
                user: models.User = Depends(get_current_user)):
    """R50: change a card (an alert's line) before confirming it."""
    conv = _conv(db, conversation_id, user, edit=True)
    try:
        return turns.revise(db, conv, user, turn_id, payload.edits or {})
    except automations_svc.AutomationError as e:
        raise HTTPException(400, str(e))


@router.post("/conversations/{conversation_id}/dashboard", status_code=201)
def dashboard_from(conversation_id: str, payload: DashboardFromRequest, db: Session = Depends(get_db),
                   user: models.User = Depends(get_current_user)):
    projects._rate_limit(user.id)
    conv = _conv(db, conversation_id, user, edit=True)
    msg = turns._new_turn(db, conv, "dashboard", "Make this a dashboard", run_ids=payload.run_ids, name=payload.name, intent_by="button")
    turns._bg(turns._do_dashboard, msg.id, user.id)
    return turns._message_turn(db, msg, conv, user)


@router.get("/conversations/{conversation_id}/documents/{turn_id}.md")
def download_document(conversation_id: str, turn_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    conv = _conv(db, conversation_id, user)
    msg = db.get(models.Message, turn_id)
    if msg is None or msg.conversation_id != conv.id:
        raise HTTPException(404, "Document not found.")
    doc = turns._state(msg).get("document") or {}
    if not doc.get("markdown"):
        raise HTTPException(404, "Document not found.")
    name = "".join(c if c.isalnum() or c in " -_" else "" for c in str(doc.get("title") or "document")).strip().replace(" ", "-")[:60] or "document"
    return Response(content=doc["markdown"], media_type="text/markdown; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{name}.md"'})


# ---- R51: block documents -------------------------------------------------------------------

def _doc(db: Session, doc_id: str, user: models.User, edit: bool = False) -> models.DocDocument:
    """A document is seen by whoever can open its conversation, changed by whoever can edit it (404 otherwise)."""
    from ..services import workspace_access
    d = db.get(models.DocDocument, doc_id)
    if d is None:
        raise HTTPException(404, "Document not found.")
    if d.owner_id == user.id:
        return d
    conv = db.get(models.Conversation, d.conversation_id) if d.conversation_id else None
    ok = conv is not None and (workspace_access.can_edit_conversation(db, conv, user) if edit else workspace_access.can_access_conversation(db, conv, user))
    if not ok:
        raise HTTPException(404, "Document not found.")
    return d


def _doc_out(d: models.DocDocument, user: models.User, db: Session) -> dict:
    from ..services import workspace_access
    out = docblocks.summary(d, user)
    conv = db.get(models.Conversation, d.conversation_id) if d.conversation_id else None
    out["can_edit"] = d.owner_id == user.id or (conv is not None and workspace_access.can_edit_conversation(db, conv, user))
    return out


def _doc_err(e: Exception):
    raise HTTPException(400, str(e))


@router.get("/documents")
def list_documents(workspace_id: str | None = None, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    """R52: the Library's Documents tab - the documents this person wrote, newest first (a teammate's open from their
    conversation, as before)."""
    q = db.query(models.DocDocument).filter(models.DocDocument.owner_id == user.id)
    if workspace_id:
        q = q.filter(models.DocDocument.workspace_id == workspace_id)
    out = []
    for d in q.order_by(models.DocDocument.updated_at.desc()).limit(300).all():
        sm = docblocks.summary(d, user)
        conv = db.get(models.Conversation, d.conversation_id) if d.conversation_id else None
        out.append({k: sm[k] for k in ("id", "title", "conversation_id", "created_at", "updated_at", "edited_by_person", "figures", "tables", "words", "pages")}
                   | {"conversation_title": conv.title if conv else None})
    return {"documents": out}


@router.get("/documents/{doc_id}")
def get_document(doc_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    return _doc_out(_doc(db, doc_id, user), user, db)


@router.patch("/documents/{doc_id}")
def patch_document(doc_id: str, payload: DocPatch, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    d = _doc(db, doc_id, user, edit=True)
    try:
        if payload.title is not None:
            docblocks.rename(db, d, payload.title)
    except docblocks.DocError as e:
        _doc_err(e)
    return _doc_out(d, user, db)


@router.post("/documents/{doc_id}/blocks/{block_id}/edit")
def edit_document_block(doc_id: str, block_id: str, payload: BlockEdit, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    """Ask for one block to change: "add a graph for this below", "make it shorter", "rewrite: ...", "remove"."""
    d = _doc(db, doc_id, user, edit=True)
    try:
        change = docblocks.edit_block(db, user, d, block_id, payload.instruction or "")
    except docblocks.DocError as e:
        _doc_err(e)
    return {"change": change, "document": _doc_out(d, user, db)}


@router.put("/documents/{doc_id}/blocks/{block_id}")
def type_document_block(doc_id: str, block_id: str, payload: BlockEdit, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    """The person typed over a block on the page."""
    d = _doc(db, doc_id, user, edit=True)
    try:
        docblocks.type_over(db, d, block_id, payload.text or "")
    except docblocks.DocError as e:
        _doc_err(e)
    return _doc_out(d, user, db)


@router.post("/documents/{doc_id}/blocks/{block_id}/accept")
def accept_document_block(doc_id: str, block_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    d = _doc(db, doc_id, user, edit=True)
    try:
        docblocks.accept(db, d, block_id)
    except docblocks.DocError as e:
        _doc_err(e)
    return _doc_out(d, user, db)


@router.post("/documents/{doc_id}/undo")
def undo_document(doc_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    d = _doc(db, doc_id, user, edit=True)
    try:
        label = docblocks.undo(db, d)
    except docblocks.DocError as e:
        _doc_err(e)
    return {"undid": label, "document": _doc_out(d, user, db)}


@router.post("/documents/{doc_id}/shorter")
def shorten_document(doc_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    d = _doc(db, doc_id, user, edit=True)
    try:
        docblocks.shorten_all(db, d)
    except docblocks.DocError as e:
        _doc_err(e)
    return _doc_out(d, user, db)


def _doc_file(d: models.DocDocument, user: models.User, db: Session, kind: str) -> Response:
    out = _doc_out(d, user, db)
    name = "".join(c if c.isalnum() or c in " -_" else "" for c in str(d.title or "document")).strip().replace(" ", "-")[:60] or "document"
    if kind == "docx":
        body, mt = docexport.docx_bytes(out), "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    elif kind == "pdf":
        body, mt = docexport.pdf_bytes(out), "application/pdf"
    else:
        body, mt = docexport.markdown(out).encode("utf-8"), "text/markdown; charset=utf-8"
    return Response(content=body, media_type=mt, headers={"Content-Disposition": f'attachment; filename="{name}.{kind}"'})


@router.get("/documents/{doc_id}/export.docx")
def document_docx(doc_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    return _doc_file(_doc(db, doc_id, user), user, db, "docx")


@router.get("/documents/{doc_id}/export.pdf")
def document_pdf(doc_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    return _doc_file(_doc(db, doc_id, user), user, db, "pdf")


@router.get("/documents/{doc_id}/export.md")
def document_md(doc_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    return _doc_file(_doc(db, doc_id, user), user, db, "md")
