"""
Company domains (2026-10-10, round 19) - see services/domains.py.

/domains/*  - signed-in owners, admins and members of the workspace:
              connect the address, who may open it, publish dashboards at
              paths on it, decide requests.
/viewer/*   - the company's own address (data.acmeretail.com) calls these:
              which site this is, sign-in state, the home list, and each
              dashboard - rendered by the same view as the app, with the same
              run / filter / options endpoints the public link has, plus the
              access checks and per-viewer row rules.
"""
from __future__ import annotations

from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, File, Header, HTTPException, Request, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user
from ..services import audit, dashboard_engine, policies, query_builder, workspace_access
from ..services import domains as svc
from . import dashboard_builder as dbm
from .dashboards import _can_edit

router = APIRouter(prefix="/domains", tags=["domains"])
viewer_router = APIRouter(prefix="/viewer", tags=["domain-viewer"])


# =============================================================== helpers ====

def _ws_role(db: Session, user: models.User, workspace_id: str) -> tuple[models.Workspace, str]:
    ws = db.get(models.Workspace, workspace_id) if workspace_id else None
    role = workspace_access.member_role(db, user.id, workspace_id) if ws else None
    if not ws or not role:
        raise HTTPException(404, "Workspace not found.")
    return ws, role


def _admin_ws(db: Session, user: models.User, workspace_id: str) -> models.Workspace:
    ws, role = _ws_role(db, user, workspace_id)
    if role not in workspace_access.ADMIN_ROLES:
        raise HTTPException(403, "Only the workspace's owner and admins can change its company domain.")
    return ws


def _domain(db: Session, user: models.User, domain_id: str, admin: bool = True) -> models.WorkspaceDomain:
    dom = db.get(models.WorkspaceDomain, domain_id)
    if not dom:
        raise HTTPException(404, "Domain not found.")
    ws, role = _ws_role(db, user, dom.workspace_id)
    if admin and role not in workspace_access.ADMIN_ROLES:
        raise HTTPException(403, "Only the workspace's owner and admins can change its company domain.")
    return dom


def _dash_in_workspace(d: models.Dashboard, ws: models.Workspace) -> bool:
    if d.workspace_id == ws.id:
        return True
    return bool(ws.is_personal and d.owner_id == ws.owner_id and d.workspace_id in (None, ws.id))


def _schema_columns(db: Session, ds) -> set[str]:
    if not ds:
        return set()
    try:
        schema, _ = dashboard_engine.schema_with_aliases(ds, dashboard_engine.load_versions(db, ds))
    except Exception:  # noqa: BLE001
        schema = ds.schema_cache or {}
    cols: set[str] = set()
    if isinstance(schema, dict):
        for t in schema:
            for c in query_builder.table_columns(schema, t) or []:
                cols.add(c["name"])
    return cols


def _columns_by_table(db: Session, ds) -> dict[str, list[str]]:
    if not ds:
        return {}
    try:
        schema, _ = dashboard_engine.schema_with_aliases(ds, dashboard_engine.load_versions(db, ds))
    except Exception:  # noqa: BLE001
        schema = ds.schema_cache or {}
    out: dict[str, list[str]] = {}
    if isinstance(schema, dict):
        for t in schema:
            out[t] = [c["name"] for c in query_builder.table_columns(schema, t) or []]
    return out


def _audit(db, user, action, dom_or_ws_id, target_id=None, **meta):
    audit.log_audit_event(db, actor=user, action=action, workspace_id=dom_or_ws_id, target_type="domain",
                          target_id=target_id, metadata=meta or None)


# ================================================================ /domains ===

@router.get("")
def get_domain(workspace_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    """Everything the Domains settings page shows."""
    ws, role = _ws_role(db, user, workspace_id)
    is_admin = role in workspace_access.ADMIN_ROLES
    dom = db.query(models.WorkspaceDomain).filter(models.WorkspaceDomain.workspace_id == ws.id).first()
    base = {
        "workspace": {"id": ws.id, "name": ws.name, "personal": bool(ws.is_personal)},
        "role": role, "can_manage": is_admin, "cname_target": svc.cname_target(),
        "suggested_email_domains": svc.guess_email_domains(db, ws),
        "publish_needs_approval": bool(policies.get(ws).get("domain_publish_needs_approval")),
    }
    if not dom:
        return {**base, "domain": None, "publications": [], "requests": [], "access_requests": []}
    names: dict = {}
    pubs = (db.query(models.DomainPublication).filter(models.DomainPublication.domain_id == dom.id,
                                                      models.DomainPublication.status.in_(("live", "pending", "rejected")))
            .order_by(models.DomainPublication.created_at.desc()).all())
    access = (db.query(models.DomainAccessRequest).filter(models.DomainAccessRequest.workspace_id == ws.id,
                                                          models.DomainAccessRequest.status == "pending")
              .order_by(models.DomainAccessRequest.created_at.desc()).limit(100).all())
    pub_out = [svc.publication_out(db, dom, p, names) for p in pubs]
    if not is_admin:
        # Members see what's live and their own requests.
        pub_out = [p for p in pub_out if p["status"] == "live" or
                   next((x for x in pubs if x.id == p["id"]), None).requested_by_id == user.id]
    return {
        **base, "domain": svc.domain_out(db, dom),
        "publications": [p for p in pub_out if p["status"] == "live"],
        "requests": [p for p in pub_out if p["status"] in ("pending", "rejected")],
        "access_requests": [svc.access_request_out(db, dom, r) for r in access] if is_admin else [],
    }


class DomainCreate(BaseModel):
    workspace_id: str
    hostname: str = Field(min_length=3, max_length=253)


@router.post("", status_code=201)
def add_domain(body: DomainCreate, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    ws = _admin_ws(db, user, body.workspace_id)
    if db.query(models.WorkspaceDomain).filter(models.WorkspaceDomain.workspace_id == ws.id).first():
        raise HTTPException(409, "This workspace already has a company domain - remove it first to use another.")
    try:
        host = svc.normalize_hostname(body.hostname)
    except svc.DomainError as e:
        raise HTTPException(400, str(e))
    if db.query(models.WorkspaceDomain).filter(models.WorkspaceDomain.hostname == host).first():
        raise HTTPException(409, f"{host} is already connected to another workspace on GD360.")
    if db.query(models.DashboardShare).filter(models.DashboardShare.custom_domain == host).first():
        raise HTTPException(409, f"{host} is in use as one dashboard's own address. Remove it there first.")
    dom = models.WorkspaceDomain(
        workspace_id=ws.id, hostname=host, created_by_id=user.id, audience="company",
        allowed_email_domains=svc.guess_email_domains(db, ws) or [host.split(".", 1)[1]],
        show_powered_by=True,
        publish_needs_approval=bool(policies.get(ws).get("domain_publish_needs_approval")),
    )
    # A guessed company domain must never be a free mail service.
    dom.allowed_email_domains = [d for d in (dom.allowed_email_domains or []) if d not in svc.FREE_MAIL]
    db.add(dom)
    db.flush()
    _audit(db, user, "domain_added", ws.id, dom.id, hostname=host)
    db.commit()
    return svc.domain_out(db, dom)


@router.post("/{domain_id}/check")
def check_domain(domain_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    dom = _domain(db, user, domain_id)
    result = svc.check(db, dom)
    if result["before"] != "live" and dom.status == "live":
        _audit(db, user, "domain_live", dom.workspace_id, dom.id, hostname=dom.hostname)
    db.commit()
    return {**svc.domain_out(db, dom), "dns_seen": {"cname": result["dns"]["cname_seen"], "txt": result["dns"]["txt_seen"]}}


@router.delete("/{domain_id}")
def remove_domain(domain_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    from ..services import render_domains
    dom = _domain(db, user, domain_id)
    if dom.render_custom_domain_id:
        try:
            render_domains.delete_custom_domain(dom.render_custom_domain_id)
        except (render_domains.RenderDomainsNotConfigured, render_domains.RenderDomainError) as e:
            print(f"[domains] render deregistration skipped: {e}")
    pubs = db.query(models.DomainPublication).filter(models.DomainPublication.domain_id == dom.id).all()
    for p in pubs:
        db.query(models.DomainSubscription).filter(models.DomainSubscription.publication_id == p.id).delete()
        db.query(models.DomainAccessRequest).filter(models.DomainAccessRequest.publication_id == p.id).delete()
        db.query(models.DomainView).filter(models.DomainView.publication_id == p.id).delete()
        db.delete(p)
    _audit(db, user, "domain_removed", dom.workspace_id, dom.id, hostname=dom.hostname, dashboards=len(pubs))
    db.delete(dom)
    db.commit()
    return {"ok": True}


class DomainSettings(BaseModel):
    audience: str | None = None
    allowed_email_domains: list[str] | str | None = None
    invited_emails: list[str] | str | None = None
    site_title: str | None = Field(default=None, max_length=80)
    show_powered_by: bool | None = None
    publish_needs_approval: bool | None = None


@router.patch("/{domain_id}")
def update_domain(domain_id: str, body: DomainSettings, db: Session = Depends(get_db),
                  user: models.User = Depends(get_current_user)):
    dom = _domain(db, user, domain_id)
    ws = db.get(models.Workspace, dom.workspace_id)
    changed = {}
    try:
        if body.allowed_email_domains is not None:
            dom.allowed_email_domains = svc.clean_email_domains(body.allowed_email_domains)
            changed["allowed_email_domains"] = dom.allowed_email_domains
        if body.invited_emails is not None:
            dom.invited_emails = svc.clean_emails(body.invited_emails)
            changed["invited_emails"] = len(dom.invited_emails)
    except svc.DomainError as e:
        raise HTTPException(400, str(e))
    if body.audience is not None:
        if body.audience not in ("company", "invited", "public"):
            raise HTTPException(400, "Pick people at your company, invited people, or anyone.")
        if body.audience == "public":
            ruled = db.query(models.DomainPublication.id).filter(
                models.DomainPublication.domain_id == dom.id, models.DomainPublication.status == "live",
                models.DomainPublication.audience == "domain", models.DomainPublication.row_rule.isnot(None)).first()
            if ruled:
                raise HTTPException(400, "A dashboard here shows each person only their rows, so the domain can't be "
                                         "open to anyone without signing in. Remove that rule or set its dashboard "
                                         "to invited people first.")
        dom.audience = body.audience
        changed["audience"] = body.audience
    if dom.audience == "company" and not (dom.allowed_email_domains or []):
        raise HTTPException(400, "Add your company's email domain (like acmeretail.com) so people there can sign in.")
    if body.site_title is not None:
        dom.site_title = body.site_title.strip() or None
        changed["site_title"] = dom.site_title
    if body.show_powered_by is not None:
        dom.show_powered_by = bool(body.show_powered_by)
        changed["show_powered_by"] = dom.show_powered_by
    if body.publish_needs_approval is not None:
        # One rule, stored once: the workspace policy (also in Trust Center).
        current = policies.get(ws)
        ws.policies = policies.normalize({"domain_publish_needs_approval": bool(body.publish_needs_approval)}, current)
        dom.publish_needs_approval = bool(body.publish_needs_approval)
        changed["publish_needs_approval"] = dom.publish_needs_approval
    if changed:
        _audit(db, user, "domain_settings_changed", dom.workspace_id, dom.id, **changed)
    db.commit()
    return svc.domain_out(db, dom)


@router.post("/{domain_id}/logo", status_code=201)
async def upload_logo(domain_id: str, file: UploadFile = File(...), db: Session = Depends(get_db),
                      user: models.User = Depends(get_current_user)):
    dom = _domain(db, user, domain_id)
    contents, content_type = await dbm._read_and_validate_image(file, dbm._MAX_LOGO_BYTES)  # noqa: SLF001
    dom.logo_image, dom.logo_content_type = contents, content_type
    _audit(db, user, "domain_settings_changed", dom.workspace_id, dom.id, logo="uploaded")
    db.commit()
    return svc.domain_out(db, dom)


@router.delete("/{domain_id}/logo")
def remove_logo(domain_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    dom = _domain(db, user, domain_id)
    dom.logo_image, dom.logo_content_type = None, None
    _audit(db, user, "domain_settings_changed", dom.workspace_id, dom.id, logo="removed")
    db.commit()
    return svc.domain_out(db, dom)


@router.get("/{domain_id}/logo")
def get_logo(domain_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    dom = _domain(db, user, domain_id, admin=False)
    return dbm._image_response(dom.logo_image, dom.logo_content_type)  # noqa: SLF001


@router.get("/{domain_id}/path-available")
def path_available(domain_id: str, path: str, publication_id: str | None = None, db: Session = Depends(get_db),
                   user: models.User = Depends(get_current_user)):
    dom = _domain(db, user, domain_id, admin=False)
    try:
        p = svc.normalize_path(path)
    except svc.DomainError as e:
        return {"path": path, "available": False, "reason": str(e)}
    clash = db.query(models.DomainPublication).filter(
        models.DomainPublication.domain_id == dom.id, models.DomainPublication.path == p,
        models.DomainPublication.status.in_(("live", "pending")), models.DomainPublication.id != (publication_id or "")).first()
    return {"path": p, "available": not clash,
            "reason": f"{dom.hostname}/{p} is already used by another dashboard." if clash else None}


# ------------------------------------------------------- the publish dialog --

@router.get("/for-dashboard/{dashboard_id}")
def publish_state(dashboard_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    """What the "Publish to company domain" dialog needs for one dashboard."""
    d = dbm._get_dashboard_v2(db, user, dashboard_id)  # noqa: SLF001
    ws_id = d.workspace_id
    if not ws_id:
        personal = (db.query(models.Workspace).filter(models.Workspace.owner_id == d.owner_id,
                                                      models.Workspace.is_personal.is_(True)).first())
        ws_id = personal.id if personal else None
    ws = db.get(models.Workspace, ws_id) if ws_id else None
    role = workspace_access.member_role(db, user.id, ws.id) if ws else None
    dom = db.query(models.WorkspaceDomain).filter(models.WorkspaceDomain.workspace_id == ws.id).first() if ws else None
    ds = dbm._dashboard_datasource(db, d)  # noqa: SLF001
    warehouse = bool(ds and dashboard_engine.is_warehouse_native(ds))
    pub = None
    if dom:
        p = (db.query(models.DomainPublication).filter(models.DomainPublication.domain_id == dom.id,
                                                       models.DomainPublication.dashboard_id == d.id,
                                                       models.DomainPublication.status.in_(("live", "pending", "rejected")))
             .order_by(models.DomainPublication.created_at.desc()).first())
        pub = svc.publication_out(db, dom, p) if p else None
    needs_approval = bool(policies.get(ws).get("domain_publish_needs_approval")) if ws else True
    is_admin = role in workspace_access.ADMIN_ROLES
    can_edit = _can_edit(db, d, user)
    sens = []
    if ds:
        sens = [{"column": s.column_name, "category": s.category}
                for s in db.query(models.SensitiveColumn).filter(models.SensitiveColumn.datasource_id == ds.id,
                                                                 models.SensitiveColumn.status != "dismissed").all()]
    members = (db.query(models.WorkspaceMember).filter(models.WorkspaceMember.workspace_id == ws.id).count() if ws else 0)
    return {
        "dashboard": {"id": d.id, "name": d.name, "warehouse_native": warehouse},
        "workspace": {"id": ws.id, "name": ws.name, "personal": bool(ws.is_personal)} if ws else None,
        "in_workspace": bool(ws and _dash_in_workspace(d, ws)),
        "role": role, "can_manage": is_admin,
        "mode": ("direct" if is_admin or (can_edit and not needs_approval and role in ("member",)) else
                 "request" if can_edit and role == "member" else "none"),
        "domain": svc.domain_out(db, dom) if dom else None,
        "publication": pub,
        "suggested_path": svc.suggest_path(db, dom, d.name, pub["id"] if pub else None) if dom else None,
        "columns": _columns_by_table(db, ds) if warehouse else {},
        "sensitive_columns": sens, "member_count": members,
    }


class PublishBody(BaseModel):
    dashboard_id: str
    path: str = Field(min_length=1, max_length=80)
    title: str | None = Field(default=None, max_length=120)
    audience: str = "domain"
    invited_emails: list[str] | str | None = None
    row_rule: dict | None = None
    note: str | None = Field(default=None, max_length=500)


def _validate_publish(db: Session, dom: models.WorkspaceDomain, d: models.Dashboard, body: PublishBody,
                      pub_id: str | None) -> dict:
    if body.audience not in ("domain", "invited", "members"):
        raise HTTPException(400, "Pick who can open it: everyone the domain allows, invited people, or workspace members.")
    try:
        path = svc.normalize_path(body.path)
        invited = svc.clean_emails(body.invited_emails) if body.invited_emails else []
    except svc.DomainError as e:
        raise HTTPException(400, str(e))
    if body.audience == "invited" and not invited:
        raise HTTPException(400, "Add the email addresses of the people who should see it.")
    clash = db.query(models.DomainPublication).filter(
        models.DomainPublication.domain_id == dom.id, models.DomainPublication.path == path,
        models.DomainPublication.status.in_(("live", "pending")), models.DomainPublication.id != (pub_id or "")).first()
    if clash:
        raise HTTPException(409, f"{dom.hostname}/{path} is already used by another dashboard - pick another address.")
    rule = None
    if body.row_rule:
        ds = dbm._dashboard_datasource(db, d)  # noqa: SLF001
        if not ds or not dashboard_engine.is_warehouse_native(ds):
            raise HTTPException(400, "Showing each person only their rows works for dashboards on a live database or "
                                     "warehouse. This dashboard keeps stored numbers - publish separate dashboards instead.")
        try:
            rule = svc.normalize_row_rule(body.row_rule, _schema_columns(db, ds))
        except svc.DomainError as e:
            raise HTTPException(400, str(e))
        if rule and body.audience == "domain" and dom.audience == "public":
            raise HTTPException(400, "This domain is open to anyone without signing in, so it can't tell who is "
                                     "looking. Set this dashboard to invited people, or change the domain's audience.")
    return {"path": path, "invited": invited, "rule": rule}


@router.post("/{domain_id}/publications", status_code=201)
def publish(domain_id: str, body: PublishBody, db: Session = Depends(get_db),
            user: models.User = Depends(get_current_user)):
    dom = _domain(db, user, domain_id, admin=False)
    ws, role = _ws_role(db, user, dom.workspace_id)
    d = dbm._get_dashboard_v2(db, user, body.dashboard_id)  # noqa: SLF001
    if not _dash_in_workspace(d, ws):
        raise HTTPException(400, f"Share this dashboard with {ws.name} first - only the workspace's dashboards go on its domain.")
    is_admin = role in workspace_access.ADMIN_ROLES
    if not is_admin and (role != "member" or not _can_edit(db, d, user)):
        raise HTTPException(403, "Viewers can't publish. Ask an owner or admin.")
    needs_ok = not is_admin and bool(policies.get(ws).get("domain_publish_needs_approval"))
    existing = (db.query(models.DomainPublication).filter(models.DomainPublication.domain_id == dom.id,
                                                          models.DomainPublication.dashboard_id == d.id,
                                                          models.DomainPublication.status.in_(("live", "pending", "rejected")))
                .order_by(models.DomainPublication.created_at.desc()).first())
    if existing and existing.status == "live" and needs_ok:
        raise HTTPException(409, "It's already published. Ask an owner or admin to change it.")
    v = _validate_publish(db, dom, d, body, existing.id if existing else None)
    now = datetime.utcnow()
    p = existing or models.DomainPublication(domain_id=dom.id, workspace_id=ws.id, dashboard_id=d.id)
    p.path, p.title = v["path"], (body.title or "").strip() or None
    p.audience, p.invited_emails, p.row_rule = body.audience, v["invited"] or None, v["rule"]
    if needs_ok:
        p.status = "pending"
        p.requested_by_id, p.requested_at, p.request_note = user.id, now, body.note
        p.decided_by_id = p.decided_at = p.decision_note = None
    else:
        p.status = "live"
        p.published_at = p.published_at or now
        p.requested_by_id = p.requested_by_id or user.id
        p.requested_at = p.requested_at or now
        p.decided_by_id, p.decided_at = user.id, now
    if not existing:
        db.add(p)
    db.flush()
    if needs_ok:
        _audit(db, user, "domain_publish_requested", ws.id, p.id, dashboard=d.name, path=p.path)
        svc.notify(db, svc.admin_emails(db, ws.id, user.email),
                   f"{user.full_name or user.email} wants to publish “{d.name}” on {dom.hostname}",
                   [f"{user.full_name or user.email} asked to publish <b>{d.name}</b> at {dom.hostname}/{p.path}.",
                    f"Note: {body.note}" if body.note else "It stays private until an owner or admin approves it."],
                   f"{svc.app_url()}/settings/domains", "Review the request")
    else:
        _audit(db, user, "domain_published", ws.id, p.id, dashboard=d.name, path=p.path, audience=p.audience,
               row_rule=bool(p.row_rule))
    db.commit()
    return svc.publication_out(db, dom, p)


def _publication(db: Session, user: models.User, pub_id: str) -> tuple[models.DomainPublication, models.WorkspaceDomain, str]:
    p = db.get(models.DomainPublication, pub_id)
    if not p:
        raise HTTPException(404, "Not found.")
    dom = db.get(models.WorkspaceDomain, p.domain_id)
    _, role = _ws_role(db, user, dom.workspace_id)
    return p, dom, role


@router.patch("/publications/{pub_id}")
def update_publication(pub_id: str, body: PublishBody, db: Session = Depends(get_db),
                       user: models.User = Depends(get_current_user)):
    p, dom, role = _publication(db, user, pub_id)
    is_admin = role in workspace_access.ADMIN_ROLES
    if not is_admin and not (p.status == "pending" and p.requested_by_id == user.id):
        raise HTTPException(403, "Only owners and admins can change a published dashboard.")
    d = db.get(models.Dashboard, p.dashboard_id)
    v = _validate_publish(db, dom, d, body, p.id)
    p.path, p.title = v["path"], (body.title or "").strip() or None
    p.audience, p.invited_emails, p.row_rule = body.audience, v["invited"] or None, v["rule"]
    if body.note is not None and p.status == "pending":
        p.request_note = body.note
    _audit(db, user, "domain_published" if p.status == "live" else "domain_publish_requested", dom.workspace_id, p.id,
           dashboard=d.name if d else None, path=p.path, audience=p.audience, row_rule=bool(p.row_rule), changed=True)
    db.commit()
    return svc.publication_out(db, dom, p)


class DecisionBody(BaseModel):
    note: str | None = Field(default=None, max_length=500)


@router.post("/publications/{pub_id}/approve")
def approve_publication(pub_id: str, body: DecisionBody, db: Session = Depends(get_db),
                        user: models.User = Depends(get_current_user)):
    p, dom, role = _publication(db, user, pub_id)
    if role not in workspace_access.ADMIN_ROLES:
        raise HTTPException(403, "Only owners and admins approve publishing.")
    if p.status != "pending":
        raise HTTPException(409, "This request was already decided.")
    clash = db.query(models.DomainPublication.id).filter(
        models.DomainPublication.domain_id == dom.id, models.DomainPublication.path == p.path,
        models.DomainPublication.status == "live", models.DomainPublication.id != p.id).first()
    if clash:
        raise HTTPException(409, f"{dom.hostname}/{p.path} was taken meanwhile - change the address, then approve.")
    now = datetime.utcnow()
    p.status, p.published_at, p.decided_by_id, p.decided_at, p.decision_note = "live", now, user.id, now, body.note
    d = db.get(models.Dashboard, p.dashboard_id)
    _audit(db, user, "domain_publish_approved", dom.workspace_id, p.id, dashboard=d.name if d else None, path=p.path)
    requester = db.get(models.User, p.requested_by_id) if p.requested_by_id else None
    if requester:
        svc.notify(db, [requester.email], f"“{d.name if d else 'Your dashboard'}” is live on {dom.hostname}",
                   [f"{user.full_name or user.email} approved it.", f"Note: {body.note}" if body.note else ""],
                   f"https://{dom.hostname}/{p.path}", "Open it")
    db.commit()
    return svc.publication_out(db, dom, p)


@router.post("/publications/{pub_id}/decline")
def decline_publication(pub_id: str, body: DecisionBody, db: Session = Depends(get_db),
                        user: models.User = Depends(get_current_user)):
    p, dom, role = _publication(db, user, pub_id)
    if role not in workspace_access.ADMIN_ROLES:
        raise HTTPException(403, "Only owners and admins decide publishing requests.")
    if p.status != "pending":
        raise HTTPException(409, "This request was already decided.")
    now = datetime.utcnow()
    p.status, p.decided_by_id, p.decided_at, p.decision_note = "rejected", user.id, now, body.note
    d = db.get(models.Dashboard, p.dashboard_id)
    _audit(db, user, "domain_publish_declined", dom.workspace_id, p.id, dashboard=d.name if d else None, note=body.note)
    requester = db.get(models.User, p.requested_by_id) if p.requested_by_id else None
    if requester:
        svc.notify(db, [requester.email], f"Publishing “{d.name if d else 'your dashboard'}” wasn't approved",
                   [f"{user.full_name or user.email} declined it.", f"Note: {body.note}" if body.note else ""])
    db.commit()
    return svc.publication_out(db, dom, p)


@router.delete("/publications/{pub_id}")
def unpublish(pub_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    """Takes it off the domain (or withdraws a request) - immediately."""
    p, dom, role = _publication(db, user, pub_id)
    d = db.get(models.Dashboard, p.dashboard_id)
    is_admin = role in workspace_access.ADMIN_ROLES
    own_request = p.status in ("pending", "rejected") and p.requested_by_id == user.id
    if not is_admin and not own_request:
        raise HTTPException(403, "Only owners and admins take dashboards off the domain.")
    was_live = p.status == "live"
    p.status = "removed"
    db.query(models.DomainSubscription).filter(models.DomainSubscription.publication_id == p.id).delete()
    _audit(db, user, "domain_unpublished" if was_live else "domain_publish_declined", dom.workspace_id, p.id,
           dashboard=d.name if d else None, path=p.path, withdrawn=not was_live)
    db.commit()
    return {"ok": True}


@router.get("/publications/{pub_id}/viewers")
def publication_viewers(pub_id: str, days: int = 30, db: Session = Depends(get_db),
                        user: models.User = Depends(get_current_user)):
    p, dom, role = _publication(db, user, pub_id)
    if role not in workspace_access.ADMIN_ROLES:
        raise HTTPException(403, "Only owners and admins see who opened it.")
    since = datetime.utcnow() - timedelta(days=max(1, min(365, days)))
    rows = (db.query(models.DomainView).filter(models.DomainView.publication_id == p.id,
                                               models.DomainView.viewed_at >= since)
            .order_by(models.DomainView.viewed_at.desc()).limit(2000).all())
    by: dict[str, dict] = {}
    for r in rows:
        key = r.email or "anonymous"
        e = by.setdefault(key, {"email": r.email, "views": 0, "last_viewed_at": None})
        e["views"] += 1
        e["last_viewed_at"] = e["last_viewed_at"] or svc.iso(r.viewed_at)
    return {"days": days, "viewers": sorted(by.values(), key=lambda x: x["last_viewed_at"] or "", reverse=True)}


# ----------------------------------------------------------- access asks ----

@router.post("/access-requests/{req_id}/{decision}")
def decide_access(req_id: str, decision: str, db: Session = Depends(get_db),
                  user: models.User = Depends(get_current_user)):
    if decision not in ("approve", "decline"):
        raise HTTPException(404, "Not found.")
    r = db.get(models.DomainAccessRequest, req_id)
    if not r:
        raise HTTPException(404, "Not found.")
    p = db.get(models.DomainPublication, r.publication_id)
    dom = db.get(models.WorkspaceDomain, p.domain_id) if p else None
    if not dom:
        raise HTTPException(404, "Not found.")
    _, role = _ws_role(db, user, dom.workspace_id)
    d = db.get(models.Dashboard, p.dashboard_id)
    if role not in workspace_access.ADMIN_ROLES and not (d and d.owner_id == user.id):
        raise HTTPException(403, "Only owners, admins and the dashboard's owner decide access.")
    if r.status != "pending":
        raise HTTPException(409, "Already decided.")
    r.status = "approved" if decision == "approve" else "declined"
    r.decided_by_id, r.decided_at = user.id, datetime.utcnow()
    _audit(db, user, "domain_access_approved" if decision == "approve" else "domain_access_declined", dom.workspace_id,
           r.id, email=r.email, dashboard=p.title or (d.name if d else None))
    title = p.title or (d.name if d else "the dashboard")
    if decision == "approve":
        svc.notify(db, [r.email], f"You can open “{title}” now",
                   [f"{user.full_name or user.email} gave you access to <b>{title}</b>."],
                   f"https://{dom.hostname}/{p.path}", "Open it")
    else:
        svc.notify(db, [r.email], f"Your request to open “{title}”",
                   [f"{user.full_name or user.email} didn't give access this time. Ask them if you think that's a mistake."])
    db.commit()
    return svc.access_request_out(db, dom, r)


# ================================================================= /viewer ===

def optional_user(authorization: str | None = Header(default=None), db: Session = Depends(get_db)) -> models.User | None:
    """The signed-in viewer on the company domain, or None. A bad or expired
    token reads as signed out (the page then offers sign-in)."""
    if not authorization or not authorization.lower().startswith("bearer "):
        return None
    try:
        return get_current_user(token=authorization[7:].strip(), db=db)
    except HTTPException:
        return None


def _live_domain(db: Session, host: str) -> models.WorkspaceDomain:
    h = (host or "").strip().lower().split(":")[0]
    dom = db.query(models.WorkspaceDomain).filter(models.WorkspaceDomain.hostname == h).first()
    if not dom or dom.status != "live":
        raise HTTPException(404, "This address isn't set up on GD360.")
    return dom


def _site(db: Session, dom: models.WorkspaceDomain) -> dict:
    from ..services import automations as auto_svc
    ws = db.get(models.Workspace, dom.workspace_id)
    return {
        "hostname": dom.hostname, "title": dom.site_title or (f"{ws.name} data" if ws else dom.hostname),
        "workspace_name": ws.name if ws else "", "has_logo": bool(dom.logo_image),
        "show_powered_by": bool(dom.show_powered_by), "audience": dom.audience,
        "email_domains": dom.allowed_email_domains or [] if dom.audience == "company" else [],
        "sign_in": {"password": True, "email_code": auto_svc.email_configured()},
    }


def _me(db: Session, dom: models.WorkspaceDomain, user: models.User | None) -> dict | None:
    if not user:
        return None
    return {"id": user.id, "email": user.email, "name": user.full_name or user.email.split("@")[0],
            "email_verified": bool(user.email_verified_at), "member_role": svc.member_role(db, user, dom.workspace_id)}


@viewer_router.get("/site")
def viewer_site(host: str, db: Session = Depends(get_db)):
    """Which site this address is: a company domain ("org"), one dashboard's
    own older address ("legacy" - PublicDashboardView), or nothing."""
    h = (host or "").strip().lower().split(":")[0]
    dom = db.query(models.WorkspaceDomain).filter(models.WorkspaceDomain.hostname == h).first()
    if dom and dom.status == "live":
        return {"kind": "org", "site": _site(db, dom)}
    share = (db.query(models.DashboardShare).filter(models.DashboardShare.custom_domain == h,
                                                    models.DashboardShare.published_at.isnot(None)).first())
    if share:
        return {"kind": "legacy"}
    return {"kind": "none"}


@viewer_router.get("/{host}/logo")
def viewer_logo(host: str, db: Session = Depends(get_db)):
    dom = _live_domain(db, host)
    return dbm._image_response(dom.logo_image, dom.logo_content_type)  # noqa: SLF001


@viewer_router.get("/{host}/home")
def viewer_home(host: str, request: Request, db: Session = Depends(get_db),
                user: models.User | None = Depends(optional_user)):
    dbm._check_rate_limit(f"viewer-home:ip:{dbm._client_ip(request)}", limit=60)  # noqa: SLF001
    dom = _live_domain(db, host)
    site_ok, reason = site_audience_allows_or_member(db, dom, user)
    pubs = (db.query(models.DomainPublication).filter(models.DomainPublication.domain_id == dom.id,
                                                      models.DomainPublication.status == "live")
            .order_by(models.DomainPublication.published_at.desc()).all())
    subs = set()
    if user:
        subs = {pid for (pid,) in db.query(models.DomainSubscription.publication_id).filter(
            models.DomainSubscription.user_id == user.id)}
    items = []
    for p in pubs:
        ok, _ = svc.can_open(db, dom, p, user)
        if not ok:
            continue
        d = db.get(models.Dashboard, p.dashboard_id)
        if not d:
            continue
        items.append({
            "path": p.path, "title": p.title or d.name, "updated_at": svc.iso(d.last_refreshed_at or p.published_at),
            "published_at": svc.iso(p.published_at), "pages": len(d.pages), "subscribed": p.id in subs,
            "personal_view": bool(p.row_rule) and not svc.sees_every_row(db, dom, p, d, user),
            "audience": p.audience,
        })
    pending = []
    if user:
        for r in db.query(models.DomainAccessRequest).filter(models.DomainAccessRequest.email == user.email.lower(),
                                                             models.DomainAccessRequest.workspace_id == dom.workspace_id,
                                                             models.DomainAccessRequest.status == "pending").all():
            p = db.get(models.DomainPublication, r.publication_id)
            if p and p.status == "live":
                pending.append({"path": p.path, "title": p.title or "", "asked_at": svc.iso(r.created_at)})
    return {"site": _site(db, dom), "me": _me(db, dom, user), "can_open_site": site_ok or bool(items),
            "reason": "" if (site_ok or items) else reason, "dashboards": items, "pending_requests": pending}


def site_audience_allows_or_member(db, dom, user):
    if svc.member_role(db, user, dom.workspace_id):
        return True, ""
    return svc.site_audience_allows(dom, user)


def _pub_by_path(db: Session, dom: models.WorkspaceDomain, path: str) -> models.DomainPublication:
    p = (db.query(models.DomainPublication).filter(models.DomainPublication.domain_id == dom.id,
                                                   models.DomainPublication.path == (path or "").strip("/").lower(),
                                                   models.DomainPublication.status == "live").first())
    if not p:
        raise HTTPException(404, "There's no dashboard at this address.")
    return p


class _Ctx:
    """One authorised viewer request: the domain, publication, dashboard,
    its source, and what this viewer may see."""

    def __init__(self, db, host, path, user, need_ok=True):
        self.db, self.user = db, user
        self.dom = _live_domain(db, host)
        self.pub = _pub_by_path(db, self.dom, path)
        self.d = db.get(models.Dashboard, self.pub.dashboard_id)
        if not self.d or self.d.layout_version != 2:
            raise HTTPException(404, "There's no dashboard at this address.")
        self.ok, self.reason = svc.can_open(db, self.dom, self.pub, user)
        if need_ok and not self.ok:
            raise HTTPException(401 if self.reason == "sign_in" else 403, _REASON_TEXT.get(self.reason, "No access."))
        self.ds = dbm._dashboard_datasource(db, self.d)  # noqa: SLF001
        self.warehouse = bool(self.ds and dashboard_engine.is_warehouse_native(self.ds))
        self.values = None
        self.column = None
        self.hidden: set[str] = set()
        rule = self.pub.row_rule if isinstance(self.pub.row_rule, dict) else None
        if rule and rule.get("column") and not svc.sees_every_row(db, self.dom, self.pub, self.d, user):
            if not self.warehouse:
                # Rules are only accepted for warehouse dashboards; if the
                # source changed since, show nothing rather than everything.
                self.values, self.column = [], rule["column"]
            else:
                self.values, self.column = svc.rule_values(self.pub, user), rule["column"]
            if self.values is not None:
                self.hidden = _blocks_hidden_by_rule(db, self.d, self.ds, self.column, self.warehouse)

    @property
    def ruled(self) -> bool:
        return self.values is not None

    def forced_filter(self) -> schemas.FilterCriterion:
        return schemas.FilterCriterion(column=self.column, spec={"type": "values", "include": list(self.values)})


_REASON_TEXT = {
    "sign_in": "Sign in to open this dashboard.",
    "verify_email": "Confirm your email address to open this dashboard.",
    "not_allowed": "This dashboard isn't shared with you. You can ask for access.",
    "members_only": "Only members of the team can open this dashboard. You can ask for access.",
    "gone": "This dashboard isn't published any more.",
}


def _blocks_hidden_by_rule(db, d, ds, column: str, warehouse: bool) -> set[str]:
    """Blocks that can't be limited to the viewer's rows: SQL cells (no
    page filters reach them), blocks on a table without the column and no
    key to reach it through, blocks built from those, and any data block
    holding stored numbers."""
    schema = {}
    if warehouse and ds:
        try:
            schema, _ = dashboard_engine.schema_with_aliases(ds, dashboard_engine.load_versions(db, ds))
        except Exception:  # noqa: BLE001
            schema = ds.schema_cache or {}
    by_id = {b.id: b for p in d.pages for b in p.blocks}

    def hidden(b, seen=frozenset()):
        cfg = b.config or {}
        if b.type == "sql":
            return True
        src = cfg.get("source_block_id")
        if src:
            sb = by_id.get(src)
            return True if (not sb or src in seen) else hidden(sb, seen | {b.id})
        spec = cfg.get("spec")
        if b.type in dbm._DATA_BLOCK_TYPES:  # noqa: SLF001
            if not warehouse or not isinstance(spec, dict) or not spec.get("table"):
                return not dbm._is_empty_warehouse_block(b)  # noqa: SLF001
            cols = {c["name"] for c in query_builder.table_columns(schema, spec["table"]) or []}
            if column in cols:
                return False
            return query_builder.related_filter_path(schema, spec["table"], column) is None
        return False

    return {bid for bid, b in by_id.items() if hidden(b)}


def _log_view(db: Session, ctx: _Ctx) -> None:
    try:
        now = datetime.utcnow()
        ctx.pub.view_count = (ctx.pub.view_count or 0) + 1
        ctx.pub.last_viewed_at = now
        if ctx.user:
            recent = db.query(models.DomainView.id).filter(
                models.DomainView.publication_id == ctx.pub.id, models.DomainView.user_id == ctx.user.id,
                models.DomainView.viewed_at >= now - timedelta(minutes=30)).first()
            if not recent:
                db.add(models.DomainView(publication_id=ctx.pub.id, user_id=ctx.user.id,
                                         email=(ctx.user.email or "").lower(), viewed_at=now))
        db.commit()
    except Exception as e:  # noqa: BLE001
        print(f"[domains] view log skipped (non-fatal): {e}")
        db.rollback()


@viewer_router.get("/{host}/d/{path}")
def viewer_dashboard(host: str, path: str, request: Request, db: Session = Depends(get_db),
                     user: models.User | None = Depends(optional_user)):
    """One dashboard on the company domain. Always 200 for a live address:
    `dashboard` is null and `access.reason` says why when this viewer can't
    open it (sign in / confirm email / ask for access)."""
    dbm._check_rate_limit(f"viewer-dash:ip:{dbm._client_ip(request)}", limit=90)  # noqa: SLF001
    ctx = _Ctx(db, host, path, user, need_ok=False)
    title = ctx.pub.title or ctx.d.name
    requested = None
    if user and not ctx.ok:
        r = (db.query(models.DomainAccessRequest).filter(models.DomainAccessRequest.publication_id == ctx.pub.id,
                                                         models.DomainAccessRequest.email == user.email.lower())
             .order_by(models.DomainAccessRequest.created_at.desc()).first())
        requested = {"status": r.status, "at": svc.iso(r.created_at)} if r else None
    subscribed = bool(user and db.query(models.DomainSubscription.id).filter(
        models.DomainSubscription.publication_id == ctx.pub.id, models.DomainSubscription.user_id == user.id).first())
    meta = {
        "site": _site(db, ctx.dom), "me": _me(db, ctx.dom, user), "path": ctx.pub.path, "title": title,
        "access": {"ok": ctx.ok, "reason": ctx.reason, "message": _REASON_TEXT.get(ctx.reason, ""),
                   "request": requested, "can_request": bool(user and user.email_verified_at and ctx.reason in ("not_allowed", "members_only"))},
        "subscribed": subscribed,
        "view": ({"personal": True, "column": ctx.column, "values": ctx.values, "hidden_blocks": len(ctx.hidden)}
                 if ctx.ruled else {"personal": False}),
        "published_at": svc.iso(ctx.pub.published_at), "updated_at": svc.iso(ctx.d.last_refreshed_at),
    }
    if not ctx.ok:
        return {**meta, "dashboard": None}
    dbm._assign_stored_colors(db, ctx.d)  # noqa: SLF001
    pages = []
    for pg in sorted(ctx.d.pages, key=lambda x: x.position):
        out = dbm._public_page_out(pg)  # noqa: SLF001
        if ctx.hidden:
            out.blocks = [b for b in out.blocks if b.id not in ctx.hidden]
        pages.append(out)
    dash = schemas.PublicDashboardOut(
        name=title, pages=pages, brand_primary_color=ctx.d.brand_primary_color,
        brand_accent_color=ctx.d.brand_accent_color, background_style=ctx.d.background_style,
        background_color=ctx.d.background_color, has_logo=bool(ctx.d.logo_image),
        has_background_image=bool(ctx.d.background_image),
        **dbm._appearance_fields(db, ctx.d, ctx.ds, include_kit=False),  # noqa: SLF001
        **dbm._warehouse_dashboard_fields(db, ctx.d, ctx.ds, include_tables=False),  # noqa: SLF001
    )
    _log_view(db, ctx)
    return {**meta, "dashboard": dash.model_dump() if hasattr(dash, "model_dump") else dash.dict()}


def _limits(request: Request, host: str, kind: str = "run"):
    ip = dbm._client_ip(request)  # noqa: SLF001
    lim = dbm._PUBLIC_RUN_RATE_LIMIT if kind == "run" else 90  # noqa: SLF001
    dbm._check_rate_limit(f"viewer-{kind}:ip:{ip}", limit=lim)  # noqa: SLF001
    dbm._check_rate_limit(f"viewer-{kind}:host:{host}", limit=lim * 4)  # noqa: SLF001


def _page(ctx: _Ctx, page_id: str):
    page = next((p for p in ctx.d.pages if p.id == page_id), None)
    if not page:
        raise HTTPException(404, "Page not found on this dashboard.")
    return page


@viewer_router.post("/{host}/d/{path}/pages/{page_id}/run", response_model=schemas.RunPageOut)
def viewer_run(host: str, path: str, page_id: str, payload: schemas.RunPageRequest, request: Request,
               db: Session = Depends(get_db), user: models.User | None = Depends(optional_user)):
    _limits(request, host)
    ctx = _Ctx(db, host, path, user)
    if not ctx.warehouse:
        raise HTTPException(400, "This dashboard's blocks are not computed in a warehouse.")
    page = _page(ctx, page_id)
    if ctx.ruled:
        if not ctx.values:
            raise HTTPException(403, "There are no rows for you on this dashboard yet. Ask its owner to add you.")
        payload = payload.model_copy(update={"filters": list(payload.filters[:11]) + [ctx.forced_filter()],
                                              "block_ids": [b for b in (payload.block_ids or []) if b not in ctx.hidden] or None})
    out = dbm._run_page_for(db, ctx.d, page, ctx.ds, payload, ctx.d.owner_id, persist_last_run=False,  # noqa: SLF001
                            anonymous=True, hidden_block_ids=ctx.hidden or None)
    out.blocks = {bid: dbm._strip_sql_from_result(res) for bid, res in (out.blocks or {}).items()  # noqa: SLF001
                  if bid not in ctx.hidden}
    if ctx.ruled:
        # A limited view never learns how big the whole table is.
        out.total_rows = None
        for res in (out.blocks or {}).values():
            if isinstance(res, dict):
                res["exact_total_rows"] = None
        table = dbm._dashboard_primary_table(ctx.d, ctx.ds)  # noqa: SLF001
        if table:
            schema, _ = dashboard_engine.schema_with_aliases(ctx.ds, dashboard_engine.load_versions(db, ctx.ds))
            cols = {c["name"] for c in query_builder.table_columns(schema, table) or []}
            if ctx.column not in cols and not query_builder.related_filter_path(schema, table, ctx.column):
                out.matched_rows = None
    return out


@viewer_router.post("/{host}/d/{path}/pages/{page_id}/preview-filtered", response_model=schemas.FilteredBlocksOut)
def viewer_preview(host: str, path: str, page_id: str, payload: schemas.ApplyFiltersRequest, request: Request,
                   db: Session = Depends(get_db), user: models.User | None = Depends(optional_user)):
    _limits(request, host, "filter")
    ctx = _Ctx(db, host, path, user)
    page = _page(ctx, page_id)
    if ctx.ruled:
        raise HTTPException(400, "This view is limited to your rows - refresh the page.")
    if ctx.warehouse:
        _limits(request, host)
        return dbm._public_filtered_out(dbm._filter_page_blocks_warehouse(  # noqa: SLF001
            db, ctx.d, page, ctx.ds, payload, ctx.d.owner_id, anonymous=True))
    out = dbm._filter_page_blocks(db, page, df=None, ds=None, payload=payload)  # noqa: SLF001
    return dbm._public_filtered_out(dbm._with_file_colors(db, ctx.d, page, out, payload, anonymous=True))  # noqa: SLF001


@viewer_router.get("/{host}/d/{path}/pages/{page_id}/filter-options")
def viewer_filter_options(host: str, path: str, page_id: str, column: str, request: Request,
                          db: Session = Depends(get_db), user: models.User | None = Depends(optional_user)):
    _limits(request, host, "filter")
    ctx = _Ctx(db, host, path, user)
    page = _page(ctx, page_id)
    if ctx.ruled:
        return {"column": column, "values": [], "null_count": 0, "distinct_total": 0, "truncated": False, "dtype": ""}
    return dbm._page_filter_options(page, column)  # noqa: SLF001


@viewer_router.get("/{host}/d/{path}/parameters/{param_id}/options", response_model=schemas.ParameterOptionsOut)
def viewer_param_options(host: str, path: str, param_id: str, request: Request, search: str | None = None,
                         limit: int = 50, db: Session = Depends(get_db),
                         user: models.User | None = Depends(optional_user)):
    _limits(request, host, "options")
    ctx = _Ctx(db, host, path, user)
    if not ctx.warehouse:
        raise HTTPException(400, "This dashboard's blocks are not computed in a warehouse.")
    if not ctx.ruled:
        return dbm._parameter_options_for(db, ctx.d, ctx.ds, param_id, search, limit, ctx.d.owner_id)  # noqa: SLF001
    return _ruled_options(db, ctx, param_id, search, limit)


def _ruled_options(db: Session, ctx: _Ctx, param_id: str, search: str | None, limit: int) -> schemas.ParameterOptionsOut:
    """A filter's choices, from the viewer's rows only - the same query as
    a block (one GROUP BY with the rule as a filter), so a filter list never
    names a store, person or region outside their view."""
    params = ctx.d.parameters if isinstance(ctx.d.parameters, list) else []
    param = next((p for p in params if isinstance(p, dict) and p.get("id") == param_id), None)
    if not param or not param.get("column"):
        raise HTTPException(404, "Parameter not found on this dashboard.")
    column = param["column"]
    schema, _ = dashboard_engine.schema_with_aliases(ctx.ds, dashboard_engine.load_versions(db, ctx.ds))
    table = param.get("table") or dbm._dashboard_primary_table(ctx.d, ctx.ds)  # noqa: SLF001
    if not any(c["name"] == column for c in query_builder.table_columns(schema, table) or []):
        holders = query_builder.tables_with_column(schema, column)
        table = holders[0] if holders else table
    empty = schemas.ParameterOptionsOut(parameter_id=param_id, column=column, table=table or "", search=search,
                                        values=[], truncated=False, cached=False)
    if not ctx.values or not table:
        return empty
    cols = {c["name"] for c in query_builder.table_columns(schema, table) or []}
    if ctx.column not in cols and not query_builder.related_filter_path(schema, table, ctx.column):
        return empty
    n = max(1, min(200, int(limit)))
    spec = {"table": table, "group_by": [column], "measures": [{"agg": "count", "alias": "n"}],
            "order_by": [{"by": "n", "dir": "desc"}], "limit": 500}
    try:
        res = dashboard_engine.run_page(db, ctx.ds, [{"id": "opts", "spec": spec}], page_filters=[ctx.forced_filter()],
                                        user_id=ctx.d.owner_id)
    except Exception as e:  # noqa: BLE001
        print(f"[domains] ruled options failed: {e}")
        return empty
    block = (res.get("blocks") or {}).get("opts") or {}
    if block.get("status") != "ok":
        return empty
    s = (search or "").strip().lower()
    vals = [{"value": r.get(column), "count": r.get("n")} for r in block.get("rows") or [] if r.get(column) is not None]
    if s:
        vals = [v for v in vals if s in str(v["value"]).lower()]
    return schemas.ParameterOptionsOut(parameter_id=param_id, column=column, table=table, search=search,
                                       values=vals[:n], truncated=len(vals) > n, cached=bool(block.get("cached")))


@viewer_router.get("/{host}/d/{path}/branding/{kind}")
def viewer_branding(host: str, path: str, kind: str, db: Session = Depends(get_db)):
    dom = _live_domain(db, host)
    p = _pub_by_path(db, dom, path)
    d = db.get(models.Dashboard, p.dashboard_id)
    if kind == "logo":
        return dbm._image_response(d.logo_image if d else None, d.logo_image_content_type if d else None)  # noqa: SLF001
    if kind == "background":
        return dbm._image_response(d.background_image if d else None,  # noqa: SLF001
                                   d.background_image_content_type if d else None)
    raise HTTPException(404, "Not found.")


class AccessAsk(BaseModel):
    note: str | None = Field(default=None, max_length=500)


@viewer_router.post("/{host}/d/{path}/access-request", status_code=201)
def viewer_ask(host: str, path: str, body: AccessAsk, request: Request, db: Session = Depends(get_db),
               user: models.User | None = Depends(optional_user)):
    if not user:
        raise HTTPException(401, "Sign in first.")
    if not user.email_verified_at:
        raise HTTPException(403, "Confirm your email address first, so the team knows it's really you.")
    dbm._check_rate_limit(f"viewer-ask:user:{user.id}", limit=10, window_seconds=3600)  # noqa: SLF001
    ctx = _Ctx(db, host, path, user, need_ok=False)
    if ctx.ok:
        return {"status": "approved"}
    email = user.email.lower()
    r = (db.query(models.DomainAccessRequest).filter(models.DomainAccessRequest.publication_id == ctx.pub.id,
                                                     models.DomainAccessRequest.email == email,
                                                     models.DomainAccessRequest.status == "pending").first())
    if not r:
        r = models.DomainAccessRequest(publication_id=ctx.pub.id, workspace_id=ctx.dom.workspace_id, user_id=user.id,
                                       email=email, note=body.note)
        db.add(r)
        db.flush()
        audit.log_audit_event(db, actor=user, action="domain_access_requested", workspace_id=ctx.dom.workspace_id,
                              target_type="domain", target_id=r.id,
                              metadata={"email": email, "dashboard": ctx.pub.title or ctx.d.name})
        owner = db.get(models.User, ctx.d.owner_id)
        to = svc.admin_emails(db, ctx.dom.workspace_id) + ([owner.email] if owner else [])
        svc.notify(db, to, f"{user.full_name or email} asked to open “{ctx.pub.title or ctx.d.name}”",
                   [f"{user.full_name or email} ({email}) asked to open <b>{ctx.pub.title or ctx.d.name}</b> on "
                    f"{ctx.dom.hostname}.", f"Note: {body.note}" if body.note else ""],
                   f"{svc.app_url()}/settings/domains", "Decide in GD360")
    elif body.note:
        r.note = body.note
    db.commit()
    return {"status": "pending", "at": svc.iso(r.created_at)}


class SubscribeBody(BaseModel):
    timezone: str | None = Field(default=None, max_length=64)


@viewer_router.post("/{host}/d/{path}/subscribe")
def viewer_subscribe(host: str, path: str, body: SubscribeBody, db: Session = Depends(get_db),
                     user: models.User | None = Depends(optional_user)):
    if not user:
        raise HTTPException(401, "Sign in first.")
    ctx = _Ctx(db, host, path, user)
    tz = body.timezone or "UTC"
    try:
        from zoneinfo import ZoneInfo
        ZoneInfo(tz)
    except Exception:  # noqa: BLE001
        tz = "UTC"
    s = (db.query(models.DomainSubscription).filter(models.DomainSubscription.publication_id == ctx.pub.id,
                                                    models.DomainSubscription.user_id == user.id).first())
    if not s:
        s = models.DomainSubscription(publication_id=ctx.pub.id, user_id=user.id, email=user.email.lower())
        db.add(s)
    s.timezone = tz
    s.next_send_at = svc.next_monday_8(tz)
    db.commit()
    return {"subscribed": True, "next_send_at": svc.iso(s.next_send_at), "timezone": tz}


@viewer_router.delete("/{host}/d/{path}/subscribe")
def viewer_unsubscribe(host: str, path: str, db: Session = Depends(get_db),
                       user: models.User | None = Depends(optional_user)):
    if not user:
        raise HTTPException(401, "Sign in first.")
    dom = _live_domain(db, host)
    p = _pub_by_path(db, dom, path)
    db.query(models.DomainSubscription).filter(models.DomainSubscription.publication_id == p.id,
                                               models.DomainSubscription.user_id == user.id).delete()
    db.commit()
    return {"subscribed": False}
