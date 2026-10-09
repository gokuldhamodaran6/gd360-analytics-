"""
2026-10-09 (round 15): Spaces - named groups of data sources (services/spaces.py).

  GET    /spaces?workspace_id=         the Spaces this person can see
  POST   /spaces                       create one
  GET    /spaces/suggest?kind=         which Space a newly connected app belongs in
  POST   /spaces/assign                add several sources to one Space
  GET    /spaces/{id}                  one Space
  PATCH  /spaces/{id}                  rename, recolour, change who sees it or its sources
  DELETE /spaces/{id}                  delete it (its sources are untouched)
  POST   /spaces/{id}/sources          add / remove sources
  GET    /spaces/{id}/overview?days=   the channel hub computed from its synced tables

A Space never grants access to data: every source list is filtered to the
sources the viewer can already access. A Space the person can't see is a
404; a change without the right to make it is a 403.
"""
from __future__ import annotations

from datetime import date, datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import models
from ..database import get_db
from ..deps import get_current_user
from ..services import spaces as sp
from ..services import workspace_access

router = APIRouter(prefix="/spaces", tags=["spaces"])


class CreateSpaceRequest(BaseModel):
    name: str
    color: str | None = None
    description: str | None = Field(default=None, max_length=300)
    icon: str | None = Field(default=None, max_length=40)
    access: str = "private"
    member_ids: list[str] = Field(default_factory=list)
    source_ids: list[str] = Field(default_factory=list)
    workspace_id: str | None = None


class UpdateSpaceRequest(BaseModel):
    name: str | None = None
    color: str | None = None
    description: str | None = Field(default=None, max_length=300)
    icon: str | None = Field(default=None, max_length=40)
    access: str | None = None
    member_ids: list[str] | None = None
    source_ids: list[str] | None = None
    workspace_id: str | None = None


class SourcesRequest(BaseModel):
    add: list[str] = Field(default_factory=list)
    remove: list[str] = Field(default_factory=list)


class AssignRequest(BaseModel):
    source_ids: list[str]
    space_id: str


# ---- helpers -----------------------------------------------------------------

def _space(db: Session, space_id: str, user: models.User, edit: bool = False) -> models.Space:
    s = sp.get_space(db, user, space_id)
    if not s:
        raise HTTPException(404, "Space not found.")
    if edit and not sp.can_edit(db, s, user):
        raise HTTPException(403, "Only the person who made this Space or the workspace owner can change it.")
    return s


def _name(v: str | None) -> str:
    name = (v or "").strip()
    if not 1 <= len(name) <= 60:
        raise HTTPException(400, "Give the Space a name of 1 to 60 characters.")
    return name


def _color(v: str | None) -> str:
    if not sp.HEX_COLOR.match(v or ""):
        raise HTTPException(400, "Colour must look like #C9A7FF.")
    return v.upper()


def _check_access(db: Session, user: models.User, access: str, workspace_id: str | None) -> None:
    if access not in sp.ACCESS_LEVELS:
        raise HTTPException(400, "Who can see it must be one of: private, workspace, members.")
    if access == "workspace":
        if not workspace_id:
            raise HTTPException(400, "Choose the workspace whose members can see this Space.")
    if workspace_id and workspace_access.member_role(db, user.id, workspace_id) is None:
        raise HTTPException(403, "You are not a member of that workspace.")


def _clean_members(db: Session, ids: list[str]) -> list[str]:
    out = []
    for uid in dict.fromkeys(i for i in ids if isinstance(i, str) and i):
        if db.get(models.User, uid):
            out.append(uid)
    return out[:200]


def _usable_sources(db: Session, user: models.User, ids: list[str]) -> list[str]:
    """Every id must be a source this person can access - a Space never
    reaches past someone's own access."""
    out = []
    for sid in dict.fromkeys(ids or []):
        ds = db.get(models.DataSource, sid)
        if not ds or not workspace_access.can_access_datasource(db, ds, user):
            raise HTTPException(400, "One of those sources was not found or you can't access it.")
        out.append(sid)
    return out


def _merge_sources(space: models.Space, add: list[str], remove: list[str]) -> None:
    current = [i for i in (space.source_ids or []) if i not in set(remove)]
    for sid in add:
        if sid not in current:
            current.append(sid)
    if len(current) > sp.MAX_SOURCES_PER_SPACE:
        raise HTTPException(400, f"A Space can hold up to {sp.MAX_SOURCES_PER_SPACE} sources.")
    space.source_ids = current
    space.updated_at = datetime.utcnow()


# ---- endpoints ---------------------------------------------------------------

@router.get("")
def list_spaces(workspace_id: str | None = None, db: Session = Depends(get_db),
                user: models.User = Depends(get_current_user)):
    return {"spaces": [sp.space_out(db, s, user) for s in sp.list_spaces(db, user, workspace_id)]}


@router.post("", status_code=201)
def create_space(payload: CreateSpaceRequest, db: Session = Depends(get_db),
                 user: models.User = Depends(get_current_user)):
    name = _name(payload.name)
    tmpl = sp.SPACE_TEMPLATES.get(name, {})
    color = _color(payload.color or tmpl.get("color") or "#C9A7FF")
    _check_access(db, user, payload.access, payload.workspace_id)
    ids = _usable_sources(db, user, payload.source_ids)
    if len(ids) > sp.MAX_SOURCES_PER_SPACE:
        raise HTTPException(400, f"A Space can hold up to {sp.MAX_SOURCES_PER_SPACE} sources.")
    space = models.Space(
        owner_id=user.id, workspace_id=payload.workspace_id, name=name, color=color,
        description=(payload.description or tmpl.get("description") or "").strip() or None,
        icon=payload.icon, access=payload.access,
        member_ids=_clean_members(db, payload.member_ids) if payload.access == "members" else [],
        source_ids=ids,
    )
    db.add(space)
    db.commit()
    db.refresh(space)
    return sp.space_out(db, space, user)


@router.get("/suggest")
def suggest(kind: str = Query(..., min_length=1), workspace_id: str | None = None, db: Session = Depends(get_db),
            user: models.User = Depends(get_current_user)):
    name = sp.suggest_space(kind)
    match = None
    if name:
        for s in sp.list_spaces(db, user, workspace_id):
            if s.name.strip().lower() == name.lower() and sp.can_edit(db, s, user):
                match = s.id
                break
    tmpl = sp.SPACE_TEMPLATES.get(name or "", {})
    return {"name": name, "space_id": match, "color": tmpl.get("color"), "description": tmpl.get("description")}


@router.post("/assign")
def assign(payload: AssignRequest, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    space = _space(db, payload.space_id, user, edit=True)
    _merge_sources(space, _usable_sources(db, user, payload.source_ids), [])
    db.commit()
    return sp.space_out(db, space, user)


@router.get("/{space_id}")
def get_space(space_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    return sp.space_out(db, _space(db, space_id, user), user)


@router.patch("/{space_id}")
def update_space(space_id: str, payload: UpdateSpaceRequest, db: Session = Depends(get_db),
                 user: models.User = Depends(get_current_user)):
    space = _space(db, space_id, user, edit=True)
    fields = payload.model_fields_set if hasattr(payload, "model_fields_set") else payload.__fields_set__
    if payload.name is not None:
        space.name = _name(payload.name)
    if payload.color is not None:
        space.color = _color(payload.color)
    if "description" in fields:
        space.description = (payload.description or "").strip() or None
    if "icon" in fields:
        space.icon = payload.icon
    ws_id = payload.workspace_id if "workspace_id" in fields else space.workspace_id
    access = payload.access if payload.access is not None else space.access
    if "workspace_id" in fields or payload.access is not None:
        _check_access(db, user, access, ws_id)
        space.workspace_id, space.access = ws_id, access
    if payload.member_ids is not None:
        space.member_ids = _clean_members(db, payload.member_ids)
    if space.access != "members" and payload.access is not None:
        space.member_ids = []
    if payload.source_ids is not None:
        # sources this editor can't see stay where they are: they can't remove what they can't see
        hidden = [i for i in (space.source_ids or [])
                  if i not in {ds.id for ds in sp.space_sources(db, user, space)}]
        new = _usable_sources(db, user, payload.source_ids)
        if len(hidden) + len(new) > sp.MAX_SOURCES_PER_SPACE:
            raise HTTPException(400, f"A Space can hold up to {sp.MAX_SOURCES_PER_SPACE} sources.")
        space.source_ids = new + [i for i in hidden if i not in new]
    space.updated_at = datetime.utcnow()
    db.commit()
    return sp.space_out(db, space, user)


@router.delete("/{space_id}", status_code=204)
def delete_space(space_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    space = _space(db, space_id, user, edit=True)
    db.query(models.Conversation).filter(models.Conversation.space_id == space.id).update(
        {models.Conversation.space_id: None}, synchronize_session=False)
    db.delete(space)
    db.commit()
    return None


@router.post("/{space_id}/sources")
def change_sources(space_id: str, payload: SourcesRequest, db: Session = Depends(get_db),
                   user: models.User = Depends(get_current_user)):
    space = _space(db, space_id, user, edit=True)
    add = _usable_sources(db, user, payload.add)
    visible = {ds.id for ds in sp.space_sources(db, user, space)}
    remove = [i for i in payload.remove if i in visible]
    _merge_sources(space, add, remove)
    db.commit()
    return sp.space_out(db, space, user)


@router.get("/{space_id}/overview")
def space_overview(space_id: str, days: int = Query(28, ge=1, le=366), end: date | None = None,
                   db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    space = _space(db, space_id, user)
    return sp.overview(db, user, space, days=days, end=end)
