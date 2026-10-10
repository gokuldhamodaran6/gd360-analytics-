"""
/trust - the Trust Center (2026-10-10, round 19). Owners and admins only.
See services/trust.py for how each number is worked out.
"""
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import models
from ..database import get_db
from ..deps import get_current_user
from ..services import audit, policies, trust, workspace_access
from ..services.ops_home import Scope, ScopeError

router = APIRouter(prefix="/trust", tags=["trust"])


def _admin_scope(db: Session, user: models.User, workspace_id: str | None) -> Scope:
    try:
        scope = Scope(db, user, workspace_id)
    except ScopeError as e:
        raise HTTPException(404, str(e))
    if not scope.admin:
        raise HTTPException(403, "Only the workspace's owner and admins can open the Trust Center.")
    return scope


def _ws_id(scope: Scope) -> str | None:
    return None if scope.personal else scope.ws.id


@router.get("/overview")
def overview(workspace_id: str | None = None, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    _admin_scope(db, user, workspace_id)
    try:
        return trust.overview(db, user, workspace_id)
    except PermissionError as e:
        raise HTTPException(403, str(e))


# ---------------------------------------------------------------- fixes ----

class FixBody(BaseModel):
    type: str
    datasource_id: str | None = None
    datasource_ids: list[str] = Field(default_factory=list)
    columns: list[str] = Field(default_factory=list)
    sensitive_id: str | None = None
    dashboard_id: str | None = None
    policy: str | None = None
    value: object | None = None


def _source_in_scope(db: Session, scope: Scope, ds_id: str | None) -> models.DataSource:
    ds = db.get(models.DataSource, ds_id or "")
    if not ds:
        raise HTTPException(404, "Data source not found.")
    ok = (ds.workspace_id == scope.ws.id) or (scope.personal and ds.owner_id == scope.user.id and ds.workspace_id in (None, scope.ws.id))
    if not ok:
        raise HTTPException(404, "Data source not found.")
    return ds


@router.post("/fix")
def fix(body: FixBody, workspace_id: str | None = None, db: Session = Depends(get_db),
        user: models.User = Depends(get_current_user)):
    scope = _admin_scope(db, user, workspace_id)
    t = body.type
    if t == "hide_columns":
        ds = _source_in_scope(db, scope, body.datasource_id)
        cols = [c.strip() for c in body.columns if c and c.strip()][:200]
        if not cols:
            raise HTTPException(400, "Pick at least one column.")
        existing = {(r.role, r.kind, (r.column_name or "").lower()) for r in
                    db.query(models.DataAccessRule).filter(models.DataAccessRule.datasource_id == ds.id).all()}
        added = 0
        for c in cols:
            for role in ("viewer", "member"):
                if (role, "column", c.lower()) not in existing:
                    db.add(models.DataAccessRule(datasource_id=ds.id, role=role, kind="column", column_name=c,
                                                 created_by_id=user.id))
                    added += 1
        for r in db.query(models.SensitiveColumn).filter(models.SensitiveColumn.datasource_id == ds.id).all():
            if r.column_name.lower() in {c.lower() for c in cols} and r.status == "flagged":
                r.status, r.decided_by_id, r.decided_at = "confirmed", user.id, datetime.utcnow()
        audit.log_audit_event(db, actor=user, action="sensitive_columns_hidden", workspace_id=_ws_id(scope),
                              target_type="datasource", target_id=ds.id, metadata={"datasource": ds.name, "items": cols})
        db.commit()
        return {"ok": True, "rules_added": added}
    if t in ("dismiss_column", "confirm_column", "restore_column"):
        r = db.get(models.SensitiveColumn, body.sensitive_id or "")
        if not r:
            raise HTTPException(404, "Column not found.")
        ds = _source_in_scope(db, scope, r.datasource_id)
        r.status = {"dismiss_column": "dismissed", "confirm_column": "confirmed", "restore_column": "flagged"}[t]
        r.decided_by_id, r.decided_at = user.id, datetime.utcnow()
        audit.log_audit_event(db, actor=user, action="sensitive_column_dismissed" if t == "dismiss_column" else "sensitive_column_confirmed",
                              workspace_id=_ws_id(scope), target_type="datasource", target_id=ds.id,
                              metadata={"datasource": ds.name, "column_name": r.column_name})
        db.commit()
        return {"ok": True}
    if t == "add_sensitive":
        ds = _source_in_scope(db, scope, body.datasource_id)
        col = (body.columns or [""])[0].strip()
        if not col:
            raise HTTPException(400, "Name the column.")
        row = (db.query(models.SensitiveColumn).filter(models.SensitiveColumn.datasource_id == ds.id,
                                                       models.SensitiveColumn.column_name == col).first())
        if not row:
            row = models.SensitiveColumn(datasource_id=ds.id, table_name="", column_name=col, category=str(body.value or "other"),
                                         reason="Marked by a person", source="manual")
            db.add(row)
        row.status, row.decided_by_id, row.decided_at = "confirmed", user.id, datetime.utcnow()
        db.commit()
        return {"ok": True}
    if t == "mark_reviewed":
        ids = body.datasource_ids or ([body.datasource_id] if body.datasource_id else [])
        if not ids:
            raise HTTPException(400, "Pick a source.")
        names = []
        for i in ids[:200]:
            ds = _source_in_scope(db, scope, i)
            ds.governance_last_reviewed_at = datetime.utcnow()
            ds.governance_last_reviewed_by_id = user.id
            names.append(ds.name)
            audit.log_audit_event(db, actor=user, action="governance_review_marked", workspace_id=_ws_id(scope) or ds.workspace_id,
                                  target_type="datasource", target_id=ds.id, metadata={"datasource": ds.name})
        db.commit()
        return {"ok": True, "reviewed": names}
    if t == "unpublish":
        d = db.get(models.Dashboard, body.dashboard_id or "")
        if not d or not ((d.workspace_id == scope.ws.id) or (scope.personal and d.owner_id == user.id)):
            raise HTTPException(404, "Dashboard not found.")
        if d.share and d.share.published_at:
            d.share.published_at = None
            audit.log_audit_event(db, actor=user, action="dashboard_unpublished", workspace_id=_ws_id(scope),
                                  target_type="dashboard", target_id=d.id, metadata={"dashboard": d.name, "via": "trust_center"})
            db.commit()
        return {"ok": True}
    if t == "set_policy":
        return set_policies(PolicyBody(rules={body.policy or "": body.value}), workspace_id, db, user)
    raise HTTPException(400, "Unknown fix.")


# ------------------------------------------------------------- policies ----

class PolicyBody(BaseModel):
    rules: dict = Field(default_factory=dict)


@router.get("/policies")
def get_policies(workspace_id: str | None = None, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    scope = _admin_scope(db, user, workspace_id)
    return {"rules": policies.get(scope.ws), "labels": policies.LABELS, "review_choices": list(policies.REVIEW_CHOICES)}


@router.patch("/policies")
def set_policies(body: PolicyBody, workspace_id: str | None = None, db: Session = Depends(get_db),
                 user: models.User = Depends(get_current_user)):
    scope = _admin_scope(db, user, workspace_id)
    current = policies.get(scope.ws)
    try:
        new = policies.normalize(body.rules, current)
    except ValueError as e:
        raise HTTPException(400, str(e))
    changed = {k: new[k] for k in new if new[k] != current.get(k)}
    scope.ws.policies = new
    if changed:
        audit.log_audit_event(db, actor=user, action="policy_changed", workspace_id=_ws_id(scope) or scope.ws.id,
                              target_type="workspace", target_id=scope.ws.id,
                              metadata={"name": ", ".join(
                                  f"{policies.LABELS.get(k, k)}: {('on' if v else 'off') if isinstance(v, bool) else f'{v} days'}"
                                  for k, v in changed.items())})
    db.commit()
    return {"rules": new, "changed": changed}


# ------------------------------------------------------------- audit log ----

@router.get("/audit")
def audit_log(workspace_id: str | None = None, page: int = 1, page_size: int = 30, category: str | None = None,
              actor_id: str | None = None, q: str | None = None, days: int | None = None,
              db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    scope = _admin_scope(db, user, workspace_id)
    page = max(1, page)
    page_size = max(1, min(100, page_size))
    query = trust.audit_query(db, scope, category, actor_id, q, days)
    total = query.count()
    rows = trust.audit_rows(db, query.offset((page - 1) * page_size).limit(page_size).all())
    cats = sorted({c for _, c in trust.ACTIONS.values()} | {"Initiatives"})
    return {"events": rows, "total": total, "page": page, "page_size": page_size, "categories": cats}


@router.get("/audit.csv")
def audit_csv(workspace_id: str | None = None, category: str | None = None, actor_id: str | None = None,
              q: str | None = None, days: int | None = 365, db: Session = Depends(get_db),
              user: models.User = Depends(get_current_user)):
    scope = _admin_scope(db, user, workspace_id)
    rows = trust.audit_rows(db, trust.audit_query(db, scope, category, actor_id, q, days).limit(50000).all())
    audit.log_audit_event(db, actor=user, action="audit_exported", workspace_id=_ws_id(scope) or scope.ws.id,
                          metadata={"name": f"{len(rows)} events"})
    db.commit()
    stamp = datetime.utcnow().strftime("%Y-%m-%d")
    return Response(content=trust.audit_csv(rows), media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="gd360-audit-log-{stamp}.csv"'})


@router.get("/evidence.zip")
def evidence(workspace_id: str | None = None, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    scope = _admin_scope(db, user, workspace_id)
    blob = trust.evidence_zip(db, user, workspace_id)
    audit.log_audit_event(db, actor=user, action="evidence_exported", workspace_id=_ws_id(scope) or scope.ws.id)
    db.commit()
    stamp = datetime.utcnow().strftime("%Y-%m-%d")
    return Response(content=blob, media_type="application/zip",
                    headers={"Content-Disposition": f'attachment; filename="gd360-evidence-pack-{stamp}.zip"'})


# ----------------------------------------------------------- privacy ----

@router.get("/privacy/lookup")
def privacy_lookup(email: str, workspace_id: str | None = None, db: Session = Depends(get_db),
                   user: models.User = Depends(get_current_user)):
    """Everything GD360 holds about one person in this workspace: their
    contact record (Initiatives / outreach), what they did, and whether they
    have an account here."""
    scope = _admin_scope(db, user, workspace_id)
    e = email.strip().lower()
    if "@" not in e:
        raise HTTPException(400, "Enter an email address.")
    contacts = (db.query(models.GtmContact).filter(models.GtmContact.workspace_id == scope.ws.id,
                                                   models.GtmContact.email.ilike(e)).all())
    out = []
    for c in contacts:
        eng = db.query(models.GtmEngagement).filter(models.GtmEngagement.contact_id == c.id).count()
        consent = [x.detail for x in db.query(models.GtmEngagement).filter(models.GtmEngagement.contact_id == c.id).all()
                   if isinstance(x.detail, dict) and x.detail.get("consent") is not None]
        out.append({"id": c.id, "name": c.name, "email": c.email, "title": c.title, "phone": bool(c.phone),
                    "subscribed": bool(c.subscribed), "unsubscribed": bool(c.unsubscribed), "engagements": eng,
                    "consent_records": len(consent), "created_at": c.created_at.isoformat() + "Z" if c.created_at else None})
    member = (db.query(models.User).join(models.WorkspaceMember, models.WorkspaceMember.user_id == models.User.id)
              .filter(models.WorkspaceMember.workspace_id == scope.ws.id, models.User.email.ilike(e)).first())
    views = 0
    dom = db.query(models.WorkspaceDomain).filter(models.WorkspaceDomain.workspace_id == scope.ws.id).first()
    if dom:
        views = (db.query(models.DomainView).join(models.DomainPublication, models.DomainPublication.id == models.DomainView.publication_id)
                 .filter(models.DomainPublication.domain_id == dom.id, models.DomainView.email.ilike(e)).count())
    audit.log_audit_event(db, actor=user, action="privacy_lookup", workspace_id=_ws_id(scope) or scope.ws.id,
                          metadata={"email": e[:2] + "…@" + e.split("@")[-1]})
    db.commit()
    return {"email": e, "contacts": out, "is_member": bool(member), "domain_views": views}


@router.get("/privacy/history")
def privacy_history(workspace_id: str | None = None, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    scope = _admin_scope(db, user, workspace_id)
    q = (db.query(models.AuditEvent).filter(models.AuditEvent.workspace_id == scope.ws.id,
                                            models.AuditEvent.action.in_(("gtm.contact_export", "gtm.contact_erase")))
         .order_by(models.AuditEvent.created_at.desc()).limit(50).all())
    consents = 0
    for x in db.query(models.GtmEngagement.detail).filter(models.GtmEngagement.workspace_id == scope.ws.id).all():
        d = x[0]
        if isinstance(d, dict) and d.get("consent"):
            consents += 1
    return {"requests": trust.audit_rows(db, q), "consent_records": consents}


# ------------------------------------------------------- people & roles ----

class RoleBody(BaseModel):
    role: str


@router.patch("/people/{user_id}")
def set_role(user_id: str, body: RoleBody, workspace_id: str | None = None, db: Session = Depends(get_db),
             user: models.User = Depends(get_current_user)):
    """Owners make admins; owners and admins change members and viewers.
    Nobody changes the owner here."""
    scope = _admin_scope(db, user, workspace_id)
    if scope.personal:
        raise HTTPException(400, "Your personal workspace is just you.")
    if body.role not in ("admin", "member", "viewer"):
        raise HTTPException(400, "Pick admin, member or viewer.")
    target = (db.query(models.WorkspaceMember).filter(models.WorkspaceMember.workspace_id == scope.ws.id,
                                                      models.WorkspaceMember.user_id == user_id).first())
    if not target:
        raise HTTPException(404, "That person isn't in this workspace.")
    if target.role == "owner":
        raise HTTPException(400, "The owner's role can't be changed.")
    if (body.role == "admin" or target.role == "admin") and scope.role != "owner":
        raise HTTPException(403, "Only the owner can make or change admins.")
    old = target.role
    target.role = body.role
    who = db.get(models.User, user_id)
    audit.log_audit_event(db, actor=user, action="member_role_changed", workspace_id=scope.ws.id, target_type="user",
                          target_id=user_id, metadata={"name": who.email if who else user_id, "role": f"{old} → {body.role}"})
    db.commit()
    return {"ok": True, "role": body.role}


__all__ = ["router", "workspace_access"]
