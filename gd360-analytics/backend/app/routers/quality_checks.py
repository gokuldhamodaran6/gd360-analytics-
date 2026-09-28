"""
Phase 5, Batch A (2026-09-28, "Data governance & quality" roadmap): create,
list, re-run, and delete automated data-quality checks on a connected data
source's columns - see models.DataQualityRule's own docstring for exactly
what a rule is and services/quality_checks.run_quality_rule for how one is
actually evaluated.

Nested under /datasources/{datasource_id}/..., the same style
routers/dashboard_builder.py already uses for nesting under
/dashboards/{id}/... - one router, one consistent prefix, every route below
takes datasource_id as its first path parameter.

Access follows this app's existing two-tier convention exactly (see
services/workspace_access.py): creating/deleting a rule needs "editable"
tier (can_edit_datasource); viewing the list, checking the cheap status
summary, and re-running an existing rule only need "view" tier
(can_access_datasource) - a workspace viewer can re-check a number that's
already there, same as they can already re-run nothing else destructive,
but can't add or remove what gets checked.
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user
from ..services import audit, workspace_access
from ..services.quality_checks import run_quality_rule

router = APIRouter(prefix="/datasources", tags=["quality-checks"])


def _get_accessible_datasource(db: Session, user: models.User, datasource_id: str) -> models.DataSource:
    ds = db.query(models.DataSource).filter(models.DataSource.id == datasource_id).first()
    if not ds or not workspace_access.can_access_datasource(db, ds, user):
        raise HTTPException(404, "Datasource not found.")
    return ds


def _get_editable_datasource(db: Session, user: models.User, datasource_id: str) -> models.DataSource:
    ds = _get_accessible_datasource(db, user, datasource_id)
    if not workspace_access.can_edit_datasource(db, ds, user):
        raise HTTPException(403, "You have view-only access to this data source.")
    return ds


def _rule_out(db: Session, rule: models.DataQualityRule) -> schemas.QualityRuleOut:
    creator = db.query(models.User).filter(models.User.id == rule.owner_id).first()
    return schemas.QualityRuleOut(
        id=rule.id,
        datasource_id=rule.datasource_id,
        column_name=rule.column_name,
        rule_type=rule.rule_type,
        rule_config=rule.rule_config or {},
        created_at=rule.created_at,
        last_run_at=rule.last_run_at,
        last_status=rule.last_status,
        last_checked_row_count=rule.last_checked_row_count,
        last_failing_row_count=rule.last_failing_row_count,
        last_message=rule.last_message,
        created_by_name=creator.full_name if creator else None,
        created_by_email=creator.email if creator else None,
    )


def _get_owned_rule(db: Session, ds: models.DataSource, rule_id: str) -> models.DataQualityRule:
    rule = (
        db.query(models.DataQualityRule)
        .filter(models.DataQualityRule.id == rule_id, models.DataQualityRule.datasource_id == ds.id)
        .first()
    )
    if not rule:
        raise HTTPException(404, "That quality check no longer exists.")
    return rule


@router.post("/{datasource_id}/quality-rules", response_model=schemas.QualityRuleOut, status_code=201)
def create_quality_rule(
    datasource_id: str,
    payload: schemas.CreateQualityRuleRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Creates a new rule and immediately runs it once, so the panel never
    shows a freshly-created check with no result yet."""
    ds = _get_editable_datasource(db, user, datasource_id)
    rule = models.DataQualityRule(
        datasource_id=ds.id,
        owner_id=user.id,
        column_name=payload.column_name.strip(),
        rule_type=payload.rule_type,
        rule_config=payload.rule_config or {},
    )
    db.add(rule)
    db.flush()
    run_quality_rule(db, rule)
    audit.log_audit_event(
        db, actor=user, action="quality_rule_created", workspace_id=ds.workspace_id,
        target_type="quality_rule", target_id=rule.id,
    )
    db.commit()
    db.refresh(rule)
    return _rule_out(db, rule)


@router.get("/{datasource_id}/quality-rules", response_model=list[schemas.QualityRuleOut])
def list_quality_rules(
    datasource_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)
):
    """Every rule on this data source, each with its last STORED result -
    never re-runs anything (see get_quality_status below for the even
    cheaper polling endpoint that reads the same stored last_status)."""
    ds = _get_accessible_datasource(db, user, datasource_id)
    rules = (
        db.query(models.DataQualityRule)
        .filter(models.DataQualityRule.datasource_id == ds.id)
        .order_by(models.DataQualityRule.created_at)
        .all()
    )
    return [_rule_out(db, r) for r in rules]


@router.post("/{datasource_id}/quality-rules/{rule_id}/run", response_model=schemas.QualityRuleOut)
def run_quality_rule_now(
    datasource_id: str,
    rule_id: str,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Re-runs one existing rule against the data source's current data -
    "view" tier is enough here (a workspace viewer can re-check a number
    that's already there), matching this app's existing view-vs-edit split
    for anything that only reads/recomputes rather than creates or
    destroys something."""
    ds = _get_accessible_datasource(db, user, datasource_id)
    rule = _get_owned_rule(db, ds, rule_id)
    run_quality_rule(db, rule)
    db.commit()
    db.refresh(rule)
    return _rule_out(db, rule)


@router.delete("/{datasource_id}/quality-rules/{rule_id}", status_code=204)
def delete_quality_rule(
    datasource_id: str,
    rule_id: str,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    ds = _get_editable_datasource(db, user, datasource_id)
    rule = _get_owned_rule(db, ds, rule_id)
    db.delete(rule)
    audit.log_audit_event(
        db, actor=user, action="quality_rule_deleted", workspace_id=ds.workspace_id,
        target_type="quality_rule", target_id=rule_id,
    )
    db.commit()
    return None


@router.get("/{datasource_id}/quality-status", response_model=schemas.QualityStatusOut)
def get_quality_status(
    datasource_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)
):
    """Cheap, read-only summary computed purely from each rule's own
    already-stored last_status - what a dashboard polls (once per data
    source it uses) to decide whether to show a "quality checks are
    failing" banner. Deliberately never triggers a live re-run of
    anything: a dashboard rendering for a viewer must never silently kick
    off real data-quality computation just because it happened to load."""
    ds = _get_accessible_datasource(db, user, datasource_id)
    rules = db.query(models.DataQualityRule).filter(models.DataQualityRule.datasource_id == ds.id).all()
    failing = [r for r in rules if r.last_status == "fail"]
    return schemas.QualityStatusOut(has_failing_rules=len(failing) > 0, failing_count=len(failing))
