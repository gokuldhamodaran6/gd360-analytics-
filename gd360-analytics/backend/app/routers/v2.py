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

from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import models
from ..database import get_db
from ..deps import get_current_user
from ..services import spaces as spaces_service
from ..services.agent import plans, turns, web
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


@router.get("/home")
def home(workspace_id: str | None = None, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    spaces = [spaces_service.space_out(db, s, user) for s in spaces_service.list_spaces(db, user, workspace_id)]
    sources = [projects._source_summary(db, ds, user) for ds in accessible_sources(db, user, workspace_id)]
    convs = turns.list_conversations(db, user, workspace_id, limit=40)
    return {
        "user": {"id": user.id, "first_name": (user.full_name or user.email or "").split(" ")[0].split("@")[0], "email": user.email},
        "spaces": spaces, "sources": sources, "conversations": convs,
        "plan": plans.summary(db, user, workspace_id), "web": web.available(), "web_provider": web.provider(),
    }


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


@router.post("/conversations/{conversation_id}/turns/{turn_id}/confirm")
def confirm_turn(conversation_id: str, turn_id: str, payload: ConfirmRequest, db: Session = Depends(get_db),
                 user: models.User = Depends(get_current_user)):
    conv = _conv(db, conversation_id, user, edit=True)
    return turns.confirm(db, conv, user, turn_id, approve=payload.approve, edits=payload.edits)


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
