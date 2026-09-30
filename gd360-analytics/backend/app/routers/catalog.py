"""
2026-09-30 (data catalog v1): the Catalog page's entire backend - a single
account-wide search across every kind of asset this app has. See
services/catalog.py's own module docstring for the full design; this
router is intentionally thin, just turning that service's plain dicts into
schemas.CatalogEntryOut and handling the request/response shape.
"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user
from ..services.catalog import search_catalog

router = APIRouter(prefix="/catalog", tags=["catalog"])


@router.get("/search", response_model=list[schemas.CatalogEntryOut])
def search(
    q: str = "",
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """`q` blank means "browse everything this person can see" (minus
    columns - see services/catalog.py's own comment on why those only
    appear once there's something to actually search for); a non-blank `q`
    searches name + description (+ column names) across every asset kind.
    No pagination this round - see that module's own column cap for why
    the result stays a reasonable size even on a large account."""
    return search_catalog(db, user, q)
