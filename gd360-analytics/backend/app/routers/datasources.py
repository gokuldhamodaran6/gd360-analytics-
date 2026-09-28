"""
Phase 5, Batch B (governance & data permissions): create, list, and delete
row/column-level access rules on a connected data source - see
models.DataAccessRule's own docstring for exactly what a rule is and
services/data_access_rules.py for how one is actually enforced against real
data.

Nested under /datasources/{datasource_id}/access-rules, the same style
routers/quality_checks.py already uses for nesting under
/datasources/{id}/quality-rules.

Access here is deliberately STRICTER than this app's usual two-tier
convention (see services/workspace_access.py): every endpoint below is
OWNER-only (ds.owner_id == user.id), not just "editable" tier. A rule
governs what OTHER people on the team can see, so even a "member"-role
teammate with full edit access on this data source must not be able to
grant or restrict visibility for anyone, including themselves - only the
data source's own owner can. _get_owned_datasource below mirrors
routers/governance.py's own _get_owned_workspace 404-vs-403 pattern exactly:
a data source the caller cannot even see 404s (can't tell it exists at
all), one they can see but don't own 403s (they already know it exists, so
there's nothing left to hide by pretending otherwise).
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user
from ..services import audit, workspace_access

router = APIRouter(prefix="/datasources", tags=["data-access-rules"])


def _get_owned_datasource(db: Session, user: models.User, datasource_id: str) -> models.DataSource:
    """404s for a data source the caller can't even see (can't tell it
    exists at all - see workspace_access.can_access_datasource); 403s for
    one they can see but don't own - see this file's own module docstring
    for the full reasoning on why this is owner-only, stricter than the
    usual "editable" tier."""
    ds = db.query(models.DataSource).filter(models.DataSource.id == datasource_id).first()
    if not ds or not workspace_access.can_access_datasource(db, ds, user):
        raise HTTPException(404, "Datasource not found.")
    if ds.owner_id != user.id:
        raise HTTPException(403, "Only this data source's owner can manage access rules.")
    return ds


def _rule_out(db: Session, rule: models.DataAccessRule) -> schemas.AccessRuleOut:
    creator = db.query(models.User).filter(models.User.id == rule.created_by_id).first()
    return schemas.AccessRuleOut(
        id=rule.id,
        datasource_id=rule.datasource_id,
        role=rule.role,
        kind=rule.kind,
        column_name=rule.column_name,
        allowed_values=rule.allowed_values,
        created_at=rule.created_at,
        created_by_id=rule.created_by_id,
        created_by_name=(creator.full_name or creator.email) if creator else None,
    )


@router.post("/{datasource_id}/access-rules", response_model=schemas.AccessRuleOut, status_code=201)
def create_access_rule(
    datasource_id: str,
    payload: schemas.CreateAccessRuleRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Owner-only (see _get_owned_datasource above). For a "row" rule,
    allowed_values must be a real, non-empty list - a row rule created with
    nothing in it would hide every row for that role the moment it's
    created (see services/data_access_rules.filter_dataframe_for_role's
    fail-safe "empty allowed_values matches nothing" behavior), which is
    never what someone setting one up actually meant to do, so it's
    rejected up front instead. A "column" rule ignores allowed_values
    entirely, whatever was sent."""
    ds = _get_owned_datasource(db, user, datasource_id)

    if payload.kind == "row" and not payload.allowed_values:
        raise HTTPException(400, "Pick at least one allowed value for a row rule.")

    rule = models.DataAccessRule(
        datasource_id=ds.id,
        role=payload.role,
        kind=payload.kind,
        column_name=payload.column_name.strip(),
        allowed_values=payload.allowed_values if payload.kind == "row" else None,
        created_by_id=user.id,
    )
    db.add(rule)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(400, "A rule for this column and role already exists — delete it first to change it.")

    audit.log_audit_event(
        db, actor=user, action="access_rule_created", workspace_id=ds.workspace_id,
        target_type="datasource", target_id=ds.id,
        metadata={"role": rule.role, "kind": rule.kind, "column_name": rule.column_name},
    )
    db.commit()
    db.refresh(rule)
    return _rule_out(db, rule)


@router.get("/{datasource_id}/access-rules", response_model=list[schemas.AccessRuleOut])
def list_access_rules(
    datasource_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)
):
    """Owner-only. Every rule on this data source, newest first."""
    ds = _get_owned_datasource(db, user, datasource_id)
    rules = (
        db.query(models.DataAccessRule)
        .filter(models.DataAccessRule.datasource_id == ds.id)
        .order_by(models.DataAccessRule.created_at.desc())
        .all()
    )
    return [_rule_out(db, r) for r in rules]


@router.delete("/{datasource_id}/access-rules/{rule_id}", status_code=204)
def delete_access_rule(
    datasource_id: str,
    rule_id: str,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Owner-only. Deleting a rule immediately restores full visibility for
    that role on the next request - there is nothing else cached anywhere
    that would keep enforcing it (see services/data_access_rules.
    filter_dataframe_for_role, which reads the current rule set fresh on
    every call)."""
    ds = _get_owned_datasource(db, user, datasource_id)
    rule = (
        db.query(models.DataAccessRule)
        .filter(models.DataAccessRule.id == rule_id, models.DataAccessRule.datasource_id == ds.id)
        .first()
    )
    if not rule:
        raise HTTPException(404, "That access rule no longer exists.")
    audit.log_audit_event(
        db, actor=user, action="access_rule_deleted", workspace_id=ds.workspace_id,
        target_type="datasource", target_id=ds.id,
        metadata={"role": rule.role, "kind": rule.kind, "column_name": rule.column_name},
    )
    db.delete(rule)
    db.commit()
    return None
