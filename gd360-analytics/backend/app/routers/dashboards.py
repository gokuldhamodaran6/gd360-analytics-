"""
Save charts from the AI workspace onto named dashboards, list/view them
later. Simple ownership model: a dashboard belongs to one user.
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user

router = APIRouter(prefix="/dashboards", tags=["dashboards"])


@router.get("")
def list_dashboards(db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    dashboards = db.query(models.Dashboard).filter(models.Dashboard.owner_id == user.id).all()
    return [
        {
            "id": d.id, "name": d.name, "created_at": d.created_at,
            "chart_count": len(d.charts),
        }
        for d in dashboards
    ]


@router.get("/{dashboard_id}")
def get_dashboard(dashboard_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    d = _get_owned(db, user, dashboard_id)
    return {
        "id": d.id,
        "name": d.name,
        "charts": [
            {"id": c.id, "title": c.title, "chart_spec": c.chart_spec, "insight": c.insight, "position": c.position}
            for c in sorted(d.charts, key=lambda c: c.position)
        ],
    }


@router.post("/save-chart")
def save_chart(payload: schemas.SaveChartRequest, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    dashboard = None
    if payload.dashboard_id:
        dashboard = _get_owned(db, user, payload.dashboard_id)
    else:
        dashboard = models.Dashboard(owner_id=user.id, name=payload.dashboard_name or "My dashboard")
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
    return {"dashboard_id": dashboard.id, "chart_id": chart.id}


@router.delete("/{dashboard_id}", status_code=204)
def delete_dashboard(dashboard_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    d = _get_owned(db, user, dashboard_id)
    db.delete(d)
    db.commit()
    return None


def _get_owned(db: Session, user: models.User, dashboard_id: str) -> models.Dashboard:
    d = db.query(models.Dashboard).filter(
        models.Dashboard.id == dashboard_id, models.Dashboard.owner_id == user.id
    ).first()
    if not d:
        raise HTTPException(404, "Dashboard not found.")
    return d
