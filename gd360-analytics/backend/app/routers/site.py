"""
The public website's own endpoints (2026-10-09).

  POST /site/demo-request     an Enterprise demo request from /pricing (no sign-in)
  GET  /site/demo-requests    the requests, newest first (owner only)
  PATCH /site/demo-requests/{id}   mark one contacted / closed (owner only)

The public endpoint is rate limited per address and only stores what the
form sends; nothing is emailed or shared.
"""
import re
import time
from collections import defaultdict, deque

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import models
from ..database import get_db
from ..deps import get_current_admin

router = APIRouter(prefix="/site", tags=["site"])

_WINDOW, _MAX = 3600, 5
_hits: dict[str, deque] = defaultdict(deque)
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _limit(ip: str) -> None:
    now = time.time()
    q = _hits[ip]
    while q and now - q[0] > _WINDOW:
        q.popleft()
    if len(q) >= _MAX:
        raise HTTPException(429, "Thanks - we already have your request. We'll be in touch shortly.")
    q.append(now)


class DemoRequestIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    email: str = Field(min_length=3, max_length=200)
    company: str | None = Field(default=None, max_length=160)
    team_size: str | None = Field(default=None, max_length=40)
    question: str | None = Field(default=None, max_length=2000)


@router.post("/demo-request", status_code=201)
def create_demo_request(payload: DemoRequestIn, request: Request, db: Session = Depends(get_db)):
    email = payload.email.strip().lower()
    if not _EMAIL.match(email):
        raise HTTPException(400, "Please use a valid work email.")
    _limit(_client_ip(request))
    row = models.DemoRequest(
        name=payload.name.strip(), email=email, company=(payload.company or "").strip() or None,
        team_size=(payload.team_size or "").strip() or None, question=(payload.question or "").strip() or None,
    )
    db.add(row)
    db.commit()
    return {"ok": True}


def _out(r: models.DemoRequest) -> dict:
    return {"id": r.id, "name": r.name, "email": r.email, "company": r.company, "team_size": r.team_size,
            "question": r.question, "status": r.status, "created_at": r.created_at.isoformat() + "Z"}


@router.get("/demo-requests")
def list_demo_requests(db: Session = Depends(get_db), admin: models.User = Depends(get_current_admin)):
    rows = db.query(models.DemoRequest).order_by(models.DemoRequest.created_at.desc()).limit(500).all()
    return [_out(r) for r in rows]


class DemoStatusIn(BaseModel):
    status: str = Field(pattern="^(new|contacted|closed)$")


@router.patch("/demo-requests/{request_id}")
def update_demo_request(request_id: str, payload: DemoStatusIn, db: Session = Depends(get_db),
                        admin: models.User = Depends(get_current_admin)):
    row = db.get(models.DemoRequest, request_id)
    if not row:
        raise HTTPException(404, "Not found.")
    row.status = payload.status
    db.commit()
    return _out(row)
