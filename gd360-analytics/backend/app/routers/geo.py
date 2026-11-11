"""2026-11-11 (live maps): POST /geo/resolve - place names to coordinates for the live map (services/geo.py).

Public on purpose: a published dashboard (/d/:slug) draws its map for viewers who are not signed in. It only takes
place names a chart already shows, answers from a local index (no outside service, nothing stored) and is rate
limited per address."""
from __future__ import annotations

import time
from collections import defaultdict, deque

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from ..services import geo

router = APIRouter(prefix="/geo", tags=["geo"])

_calls: dict[str, deque] = defaultdict(deque)
MAX_VALUES = 1000


class ResolveRequest(BaseModel):
    values: list[str] = Field(default_factory=list, max_length=MAX_VALUES)
    country: str | None = Field(default=None, max_length=60)


def _limit(ip: str, limit: int = 60, window: int = 60) -> None:
    now = time.time()
    log = _calls[ip]
    while log and now - log[0] > window:
        log.popleft()
    if len(log) >= limit:
        raise HTTPException(429, "Too many map lookups. Please wait a minute.")
    log.append(now)


@router.post("/resolve")
def resolve(payload: ResolveRequest, request: Request) -> dict:
    ip = (request.headers.get("x-forwarded-for") or (request.client.host if request.client else "") or "?").split(",")[0].strip()
    _limit(ip)
    values = [str(v)[:120] for v in payload.values if v is not None and str(v).strip()][:MAX_VALUES]
    results = geo.resolve(values, payload.country)
    matched = sum(1 for v in results.values() if v)
    return {"results": results, "matched": matched, "total": len(results)}
