"""
Shared, reusable models (Phase 2, feature 1) - the whole backend for the
new /models library page (frontend pages/Models.tsx).

A DatasetVersion (a saved/prepared table) is normally scoped to just the
one datasource it lives on - the only way to find or reuse one has always
been to go open that exact datasource's own Data tab. Promoting a version
(see routers/datasources.py promote_version/unpromote_version, which own
the actual write - this file is read-only) marks it as a reusable, named
"model" with a short description; this router's one endpoint lists every
such promoted model the CALLING user can currently see, across EVERY
datasource they have access to - their own, plus anything shared into a
workspace they're a member of - reusing the exact same
workspace_access.datasource_access_filter every other cross-datasource
listing in this app already uses (see routers/jobs.py's own
_visible_dashboards for the identical pattern applied to dashboards
instead of datasources), rather than inventing a second, parallel access
model just for this page.

Included in main.py exactly the way routers/jobs.py was added the previous
round: `from .routers import ..., models_library` and
`app.include_router(models_library.router)`.
"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user
from ..services import workspace_access

router = APIRouter(prefix="/models", tags=["models"])


def _row_count(v: models.DatasetVersion) -> int | None:
    """The row count AFTER the last cleaning/prep step already recorded on
    this version's own cleaning_log (see models.DataSource.cleaning_log's
    own docstring for that entry's {..., rows_after, ...} shape), if one
    happens to already be sitting there - deliberately NEVER computed
    fresh by loading this version's full CSV bytes and counting its rows on
    every single /models list call, which would make a simple metadata
    listing's cost scale with how much data every promoted model actually
    holds. None (left out by the frontend, never guessed) when no such
    figure is already available - e.g. a version with an empty cleaning_log
    because it is the original, untouched data someone chose to promote
    as-is."""
    log = v.cleaning_log or []
    if not log:
        return None
    last = log[-1]
    if not isinstance(last, dict):
        return None
    return last.get("rows_after")


@router.get("", response_model=list[schemas.SharedModelOut])
def list_shared_models(db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    """Every promoted shared model across every datasource this caller can
    at least view - newest-promoted first, so a freshly promoted model is
    easy to spot at the top of the gallery rather than buried wherever its
    datasource's own creation order happens to put it."""
    ds_ids = {
        row[0]
        for row in db.query(models.DataSource.id).filter(workspace_access.datasource_access_filter(db, user)).all()
    }
    if not ds_ids:
        return []

    rows = (
        db.query(models.DatasetVersion, models.DataSource)
        .join(models.DataSource, models.DatasetVersion.datasource_id == models.DataSource.id)
        .filter(
            models.DatasetVersion.is_shared_model.is_(True),
            models.DatasetVersion.datasource_id.in_(ds_ids),
        )
        .order_by(models.DatasetVersion.shared_model_promoted_at.desc())
        .all()
    )
    return [
        schemas.SharedModelOut(
            id=v.id,
            name=v.name,
            description=v.shared_model_description,
            datasource_id=ds.id,
            datasource_name=ds.name,
            created_at=v.created_at,
            promoted_at=v.shared_model_promoted_at,
            step_count=len(v.cleaning_log or []),
            row_count=_row_count(v),
        )
        for v, ds in rows
    ]
