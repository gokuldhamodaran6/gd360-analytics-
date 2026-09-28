"""
Background job orchestration (2026-09-28) - the Jobs page's entire backend.

Two related but separate things live here:
  1. Schedule management for the scheduled auto-refresh feature (see
     services/scheduler.py's own module docstring for the full design) -
     list every dashboard this person can see with its current schedule,
     last run, and next run, and change one dashboard's refresh_interval.
  2. The job run history itself (models.JobRun) - paginated, newest first -
     and a "Run now" endpoint that runs one dashboard's refresh
     immediately, outside its own schedule, through the exact same
     services.scheduler.refresh_dashboard function a scheduled tick calls.

Scoping matches every other dashboard-scoped endpoint in this app exactly -
`from .dashboards import _can_edit, _can_view` is the same import
routers/dashboard_builder.py already uses for the identical reason. A
dashboard's own owner, or any member of the workspace it's shared into, can
see its schedule/history here; changing its schedule or hitting "Run now"
needs the "editable" tier, the same write-access rule every other mutating
action on a shared dashboard already checks - never a separate, new auth
model invented just for this page.
"""
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import or_
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user
from ..services import workspace_access
from ..services.scheduler import compute_next_refresh_at, refresh_dashboard
from .dashboard_builder import _dashboard_datasource
from .dashboards import _can_edit, _can_view

router = APIRouter(prefix="/jobs", tags=["jobs"])


def _visible_dashboards(db: Session, user: models.User) -> list[models.Dashboard]:
    """Every layout_version==2 (Dashboard Builder) dashboard this user can
    at least VIEW - their own, or one shared into a workspace they belong
    to. Mirrors dashboard_builder._get_dashboard_v2's own access rule
    exactly, just listing every match instead of fetching one by id. A
    layout_version==1 "chart board" (routers/dashboards.py) has no pages/
    blocks and therefore nothing this round's refresh logic can recompute -
    it never appears here, the same scope line ask_ai_block/
    build_manual_block already draw."""
    ws_ids = workspace_access.member_workspace_ids(db, user.id)
    q = db.query(models.Dashboard).filter(models.Dashboard.layout_version == 2)
    if ws_ids:
        q = q.filter(or_(models.Dashboard.owner_id == user.id, models.Dashboard.workspace_id.in_(ws_ids)))
    else:
        q = q.filter(models.Dashboard.owner_id == user.id)
    return q.order_by(models.Dashboard.name).all()


def _get_dashboard_for_jobs(db: Session, user: models.User, dashboard_id: str) -> models.Dashboard:
    d = (
        db.query(models.Dashboard)
        .filter(models.Dashboard.id == dashboard_id, models.Dashboard.layout_version == 2)
        .first()
    )
    if not d or not _can_view(db, d, user):
        raise HTTPException(404, "Dashboard not found.")
    return d


def _schedule_out(db: Session, d: models.Dashboard, user: models.User) -> schemas.DashboardScheduleOut:
    ds = _dashboard_datasource(db, d)
    last_run = (
        db.query(models.JobRun)
        .filter(models.JobRun.dashboard_id == d.id)
        .order_by(models.JobRun.started_at.desc())
        .first()
    )
    return schemas.DashboardScheduleOut(
        dashboard_id=d.id,
        dashboard_name=d.name,
        source_label=ds.name if ds else None,
        refresh_interval=d.refresh_interval or "off",
        next_refresh_at=d.next_refresh_at,
        last_refreshed_at=d.last_refreshed_at,
        last_run_status=last_run.status if last_run else None,
        last_run_duration_seconds=last_run.duration_seconds if last_run else None,
        last_run_error=last_run.error_message if last_run else None,
        can_edit=_can_edit(db, d, user),
    )


@router.get("/schedules", response_model=list[schemas.DashboardScheduleOut])
def list_schedules(db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    """Every dashboard row the Jobs page's main table renders - one per
    dashboard this person can see, regardless of whether it has a schedule
    turned on yet (an "off" row is still worth showing, with "Run now"
    always available even with no schedule set)."""
    return [_schedule_out(db, d, user) for d in _visible_dashboards(db, user)]


@router.patch("/schedules/{dashboard_id}", response_model=schemas.DashboardScheduleOut)
def update_schedule(
    dashboard_id: str,
    payload: schemas.UpdateDashboardScheduleRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    d = _get_dashboard_for_jobs(db, user, dashboard_id)
    if not _can_edit(db, d, user):
        raise HTTPException(403, "You have view-only access to this dashboard.")
    if payload.refresh_interval not in schemas.REFRESH_INTERVALS:
        raise HTTPException(400, f"refresh_interval must be one of: {', '.join(schemas.REFRESH_INTERVALS)}")

    d.refresh_interval = None if payload.refresh_interval == "off" else payload.refresh_interval
    # Measured from now, not from the dashboard's last refresh - turning a
    # schedule on (or changing its interval) always counts its first
    # interval starting from this moment, exactly like flipping on a
    # recurring reminder starts counting from when you set it, not from
    # some earlier unrelated event.
    d.next_refresh_at = compute_next_refresh_at(d.refresh_interval, datetime.utcnow())
    db.commit()
    db.refresh(d)
    return _schedule_out(db, d, user)


@router.post("/schedules/{dashboard_id}/run-now", response_model=schemas.JobRunOut)
def run_now(dashboard_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    """Runs this dashboard's refresh immediately, outside its own schedule
    (or with no schedule set at all) - through the exact same
    services.scheduler.refresh_dashboard function a scheduled tick calls,
    so a manual run is logged and behaves identically to a scheduled one,
    just triggered by a click instead of a timer. Does not change
    next_refresh_at's own cadence beyond what refresh_dashboard itself
    always does (recomputes it from THIS run's completion time) - clicking
    "Run now" on a dashboard with an active schedule effectively resets its
    countdown to a fresh full interval from now, the same as any refresh
    would."""
    d = _get_dashboard_for_jobs(db, user, dashboard_id)
    if not _can_edit(db, d, user):
        raise HTTPException(403, "You have view-only access to this dashboard.")
    return refresh_dashboard(db, d, job_type="manual_refresh")


@router.get("/runs", response_model=schemas.JobRunsPage)
def list_runs(
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """The Jobs page's run-history table - every JobRun for a dashboard
    this person can see (own, or shared into one of their workspaces),
    newest first, paginated. Scoped through _visible_dashboards rather than
    JobRun.owner_id alone, so a workspace member with edit/view access to a
    shared dashboard sees its run history too, not only whoever happened to
    own it at the moment a given run fired."""
    page = max(1, page)
    page_size = max(1, min(100, page_size))
    dashboard_ids = [d.id for d in _visible_dashboards(db, user)]
    if not dashboard_ids:
        return schemas.JobRunsPage(runs=[], total=0, page=page, page_size=page_size)

    q = db.query(models.JobRun).filter(models.JobRun.dashboard_id.in_(dashboard_ids))
    total = q.count()
    rows = (
        q.order_by(models.JobRun.started_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    return schemas.JobRunsPage(runs=rows, total=total, page=page, page_size=page_size)
