"""
Save charts from the AI workspace onto named dashboards, list/view them
later.

Scope history:
  - v1: strictly personal - a dashboard belonged to one user (owner_id)
    with no schema-level notion of sharing, no real "list my dashboards"
    UI beyond opening a /dashboards/<id> link directly, and a bug where
    every "Save chart to dashboard" click created a brand-new dashboard
    (the frontend never actually passed dashboard_id back on a second
    save, so charts never accumulated onto one board).
  - 2026-09-23 (shared dashboards v1): a dashboard can now optionally live
    in a team workspace (Dashboard.workspace_id) instead of staying
    personal, so a team can build one curated board of recurring charts
    together instead of everyone re-saving the same numbers into their own
    private dashboard. Access follows the same view/editable split used
    everywhere else a workspace shares something (see
    services/workspace_access.py for the datasource/conversation version
    of this same rule):
      - "view" tier (any workspace member, any role, viewer included):
        see the dashboard exists, open it, see its charts.
      - "editable" tier (the dashboard's own creator, always, OR a
        workspace member whose role isn't "viewer"): rename it, add a
        chart to it, remove a chart from it.
      - Deleting is narrower still, same reasoning as conversation
        deletion: the dashboard's own creator, or that workspace's owner
        (its admin) - not just any teammate with edit rights, so one
        member can't wipe a board others spent time curating.
      - Re-sharing (changing WHICH workspace, if any, a dashboard is
        visible to - see share_dashboard below) is narrower still: only
        the dashboard's own creator, since it changes who can see the
        thing at all, not just its content.
    A personal dashboard (workspace_id stays NULL) keeps working exactly
    as it always did - owner-only, on every tier. This round also added a
    real POST /dashboards (create an empty one to start pinning into) and
    fixed save-chart to actually reuse an existing dashboard_id instead of
    silently creating a new board every time.

Every "not accessible at all" case here 404s; a workspace member who CAN
see a dashboard but lacks the tier for the specific action they tried gets
a 403 instead - same info-non-leak convention as workspaces.py and
services/workspace_access.py.
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import or_
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user
from ..services import workspace_access

router = APIRouter(prefix="/dashboards", tags=["dashboards"])

# Same "viewer is the one role without write access" set as
# services/workspace_access.py - kept local rather than imported since a
# dashboard isn't scoped to a data source at all, just to a workspace.
_EDIT_ROLES = {"owner", "member"}


def _can_view(db: Session, dash: models.Dashboard, user: models.User) -> bool:
    if dash.owner_id == user.id:
        return True
    if not dash.workspace_id:
        return False
    return dash.workspace_id in workspace_access.member_workspace_ids(db, user.id)


def _can_edit(db: Session, dash: models.Dashboard, user: models.User) -> bool:
    if dash.owner_id == user.id:
        return True
    if not dash.workspace_id:
        return False
    return workspace_access.member_role(db, user.id, dash.workspace_id) in _EDIT_ROLES


def _can_delete(db: Session, dash: models.Dashboard, user: models.User) -> bool:
    if dash.owner_id == user.id:
        return True
    if not dash.workspace_id:
        return False
    return workspace_access.member_role(db, user.id, dash.workspace_id) == "owner"


def _get_viewable(db: Session, user: models.User, dashboard_id: str) -> models.Dashboard:
    d = db.query(models.Dashboard).filter(models.Dashboard.id == dashboard_id).first()
    if not d or not _can_view(db, d, user):
        raise HTTPException(404, "Dashboard not found.")
    return d


def _get_editable(db: Session, user: models.User, dashboard_id: str) -> models.Dashboard:
    d = _get_viewable(db, user, dashboard_id)
    if not _can_edit(db, d, user):
        raise HTTPException(403, "You have view-only access to this dashboard.")
    return d


def _check_can_share_into(db: Session, user: models.User, workspace_id: str) -> None:
    """Raises if `user` can't share a dashboard into `workspace_id` -
    either they aren't a member of it at all (404, same info-non-leak
    reasoning as everywhere else), or they're a "viewer" there (403)."""
    role = workspace_access.member_role(db, user.id, workspace_id)
    if role is None:
        raise HTTPException(404, "Workspace not found.")
    if role not in _EDIT_ROLES:
        raise HTTPException(403, "You have view-only access to that workspace.")


def _dashboard_out(db: Session, dash: models.Dashboard, user: models.User) -> schemas.DashboardOut:
    creator = db.query(models.User).filter(models.User.id == dash.owner_id).first()
    ws_name = None
    if dash.workspace_id:
        ws = db.query(models.Workspace).filter(models.Workspace.id == dash.workspace_id).first()
        ws_name = ws.name if ws else None
    return schemas.DashboardOut(
        id=dash.id,
        name=dash.name,
        workspace_id=dash.workspace_id,
        workspace_name=ws_name,
        created_at=dash.created_at,
        chart_count=len(dash.charts),
        is_own=dash.owner_id == user.id,
        created_by_name=creator.full_name if creator else None,
        created_by_email=creator.email if creator else None,
        can_edit=_can_edit(db, dash, user),
        can_delete=_can_delete(db, dash, user),
    )


@router.get("", response_model=list[schemas.DashboardOut])
def list_dashboards(db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    """Every dashboard this person can see - their own personal ones, plus
    any dashboard shared into a workspace they belong to (regardless of
    who created it)."""
    ws_ids = workspace_access.member_workspace_ids(db, user.id)
    if ws_ids:
        dashboards = (
            db.query(models.Dashboard)
            .filter(or_(models.Dashboard.owner_id == user.id, models.Dashboard.workspace_id.in_(list(ws_ids))))
            .all()
        )
    else:
        dashboards = db.query(models.Dashboard).filter(models.Dashboard.owner_id == user.id).all()
    out = [_dashboard_out(db, d, user) for d in dashboards]
    out.sort(key=lambda d: d.created_at, reverse=True)
    return out


@router.post("", response_model=schemas.DashboardOut, status_code=201)
def create_dashboard(
    payload: schemas.DashboardCreate, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)
):
    """Starts a brand-new, empty dashboard - charts get pinned onto it
    afterward from the AI workspace's "Save chart to dashboard" flow (see
    save_chart below)."""
    if payload.workspace_id:
        _check_can_share_into(db, user, payload.workspace_id)
    dash = models.Dashboard(
        owner_id=user.id, name=payload.name.strip()[:80] or "Untitled dashboard", workspace_id=payload.workspace_id
    )
    db.add(dash)
    db.commit()
    db.refresh(dash)
    return _dashboard_out(db, dash, user)


@router.get("/{dashboard_id}", response_model=schemas.DashboardDetailOut)
def get_dashboard(dashboard_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    d = _get_viewable(db, user, dashboard_id)
    base = _dashboard_out(db, d, user)
    charts = [
        schemas.SavedChartOut(id=c.id, title=c.title, chart_spec=c.chart_spec, insight=c.insight, position=c.position)
        for c in sorted(d.charts, key=lambda c: c.position)
    ]
    return schemas.DashboardDetailOut(**base.model_dump(), charts=charts)


@router.patch("/{dashboard_id}", response_model=schemas.DashboardOut)
def rename_dashboard(
    dashboard_id: str,
    payload: schemas.DashboardRenameRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    d = _get_editable(db, user, dashboard_id)
    d.name = payload.name.strip()[:80] or d.name
    db.commit()
    db.refresh(d)
    return _dashboard_out(db, d, user)


@router.patch("/{dashboard_id}/workspace", response_model=schemas.DashboardOut)
def share_dashboard(
    dashboard_id: str,
    payload: schemas.DashboardShareRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Shares this dashboard into a workspace (payload.workspace_id set)
    or un-shares it back to personal (payload.workspace_id omitted/None).
    Deliberately narrower than the "editable" tier used for renaming/
    adding charts - only the dashboard's own creator can change WHO can
    see it at all, same as a workspace "viewer" can't reassign a data
    source's workspace even though they can view it."""
    d = _get_viewable(db, user, dashboard_id)
    if d.owner_id != user.id:
        raise HTTPException(403, "Only the dashboard's creator can change who it's shared with.")
    if payload.workspace_id:
        _check_can_share_into(db, user, payload.workspace_id)
    d.workspace_id = payload.workspace_id
    db.commit()
    db.refresh(d)
    return _dashboard_out(db, d, user)


@router.post("/save-chart")
def save_chart(
    payload: schemas.SaveChartRequest, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)
):
    if payload.dashboard_id:
        dashboard = _get_editable(db, user, payload.dashboard_id)
    else:
        if payload.workspace_id:
            _check_can_share_into(db, user, payload.workspace_id)
        dashboard = models.Dashboard(
            owner_id=user.id,
            name=(payload.dashboard_name or "My dashboard").strip()[:80] or "My dashboard",
            workspace_id=payload.workspace_id,
        )
        db.add(dashboard)
        db.commit()
        db.refresh(dashboard)

    position = len(dashboard.charts)
    chart = models.SavedChart(
        dashboard_id=dashboard.id,
        title=payload.title,
        chart_spec=payload.chart_spec,
        insight=payload.insight,
        position=position,
    )
    db.add(chart)
    db.commit()
    db.refresh(chart)
    return {"dashboard_id": dashboard.id, "dashboard_name": dashboard.name, "chart_id": chart.id}


@router.delete("/{dashboard_id}/charts/{chart_id}", status_code=204)
def remove_chart(
    dashboard_id: str,
    chart_id: str,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    d = _get_editable(db, user, dashboard_id)
    chart = (
        db.query(models.SavedChart)
        .filter(models.SavedChart.id == chart_id, models.SavedChart.dashboard_id == d.id)
        .first()
    )
    if not chart:
        raise HTTPException(404, "Chart not found on this dashboard.")
    db.delete(chart)
    db.commit()
    return None


@router.delete("/{dashboard_id}", status_code=204)
def delete_dashboard(dashboard_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    d = _get_viewable(db, user, dashboard_id)
    if not _can_delete(db, d, user):
        raise HTTPException(403, "Only the dashboard's creator or the workspace owner can delete it.")
    db.delete(d)
    db.commit()
    return None
