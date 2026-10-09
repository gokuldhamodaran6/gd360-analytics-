"""
Mission Control access (2026-10-10): staff roles, permissions, just-in-time
grants and the append-only admin audit log.

  * Emails in settings.ADMIN_EMAILS are always "owner".
  * Everyone else needs an active StaffMember row; their role decides what
    they can see and do (ROLE_PERMISSIONS below).
  * An approved AccessRequest adds one permission until it expires.
  * Every write in Mission Control calls log_admin(), which chains each row
    to the previous one with a SHA-256 hash.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import datetime

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from .. import models
from ..config import get_settings
from ..database import get_db
from ..deps import get_current_user

ROLES = {
    "owner": "Owner",
    "admin": "Admin",
    "support_lead": "Support lead",
    "support_agent": "Support agent",
    "sales": "Sales / AE",
    "csm": "Customer success",
    "finance": "Finance",
    "analyst": "Product analyst",
    "engineer": "Engineer / SRE",
    "security": "Security officer",
    "auditor": "Auditor (read-only)",
}

# (key, label, roles that have it)
PERMISSIONS = [
    ("metrics.read", "View metrics and dashboards", "*"),
    ("pii.read", "See names and emails", "owner admin support_lead support_agent sales csm finance security"),
    ("users.unlock", "Unlock accounts and sign people out", "owner admin support_lead support_agent security"),
    ("users.write", "Change roles and suspend accounts", "owner admin support_lead security"),
    ("tickets.write", "Reply to and update tickets", "owner admin support_lead support_agent csm"),
    ("crm.write", "Work leads and deals", "owner admin sales csm"),
    ("plans.write", "Edit plans and entitlements", "owner finance"),
    ("overrides.request", "Request entitlement overrides", "owner admin sales csm finance support_lead"),
    ("overrides.approve", "Approve entitlement overrides", "owner finance"),
    ("segments.write", "Build and save segments", "owner admin sales csm analyst"),
    ("flags.write", "Feature flags and kill switches", "owner admin analyst engineer"),
    ("announce.write", "Announcements and in-app messages", "owner admin support_lead csm analyst"),
    ("ai.write", "AI budgets and model switches", "owner admin engineer finance"),
    ("health.write", "Retry runs and manage incidents", "owner admin engineer"),
    ("privacy.write", "Log privacy requests", "owner admin support_lead security"),
    ("privacy.execute", "Complete privacy requests", "owner security"),
    ("audit.read", "Read the audit log", "owner admin finance engineer security auditor"),
    ("staff.manage", "Invite staff and change roles", "owner admin"),
    ("access.approve", "Approve just-in-time access", "owner admin"),
]

ROLE_PERMISSIONS: dict[str, set[str]] = {r: set() for r in ROLES}
for _key, _label, _roles in PERMISSIONS:
    for _r in (ROLES.keys() if _roles == "*" else _roles.split()):
        ROLE_PERMISSIONS[_r].add(_key)


def _owner_emails() -> set[str]:
    return {e.strip().lower() for e in get_settings().ADMIN_EMAILS.split(",") if e.strip()}


def staff_role(db: Session, email: str | None) -> str | None:
    if not email:
        return None
    email = email.lower()
    if email in _owner_emails():
        return "owner"
    row = db.query(models.StaffMember).filter(models.StaffMember.email == email).first()
    if row and row.status == "active" and row.role in ROLES:
        return row.role
    return None


def active_grants(db: Session, email: str) -> list[models.AccessRequest]:
    now = datetime.utcnow()
    return (
        db.query(models.AccessRequest)
        .filter(models.AccessRequest.staff_email == email.lower(), models.AccessRequest.status == "approved",
                models.AccessRequest.expires_at > now)
        .all()
    )


@dataclass
class Staff:
    user: models.User
    email: str
    role: str
    perms: set[str] = field(default_factory=set)

    def can(self, perm: str) -> bool:
        return perm in self.perms


def current_staff(user: models.User = Depends(get_current_user), db: Session = Depends(get_db)) -> Staff:
    role = staff_role(db, user.email)
    if not role:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Mission Control is for the GD360 team only.")
    perms = set(ROLE_PERMISSIONS[role])
    for g in active_grants(db, user.email):
        perms.add(g.permission)
    row = db.query(models.StaffMember).filter(models.StaffMember.email == user.email.lower()).first()
    if row:
        row.last_seen_at = datetime.utcnow()
        db.commit()
    return Staff(user=user, email=user.email.lower(), role=role, perms=perms)


def require(perm: str):
    def _dep(staff: Staff = Depends(current_staff)) -> Staff:
        if not staff.can(perm):
            label = next((l for k, l, _ in PERMISSIONS if k == perm), perm)
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                detail=f"Your role ({ROLES[staff.role]}) can't do this: {label}. Ask for just-in-time access.")
        return staff
    return _dep


def mask_email(email: str | None, staff: Staff) -> str | None:
    if not email or staff.can("pii.read"):
        return email
    name, _, domain = email.partition("@")
    return (name[:1] + "•••@" + domain) if domain else "•••"


def _client_ip(request: Request | None) -> str | None:
    if request is None:
        return None
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else None


def log_admin(db: Session, staff: Staff, action: str, *, target_type: str | None = None, target_id: str | None = None,
              summary: str | None = None, reason: str | None = None, before=None, after=None,
              request: Request | None = None) -> models.AdminAuditEvent:
    """Stage one chained audit row; the caller's commit persists it with the action."""
    last = db.query(models.AdminAuditEvent).order_by(models.AdminAuditEvent.created_at.desc()).first()
    prev = last.row_hash if last else ""
    now = datetime.utcnow()
    body = json.dumps({"t": now.isoformat(), "by": staff.email, "a": action, "tt": target_type, "ti": target_id,
                       "s": summary, "r": reason, "b": before, "af": after}, sort_keys=True, default=str)
    row = models.AdminAuditEvent(
        staff_email=staff.email, action=action, target_type=target_type, target_id=target_id, summary=summary,
        reason=reason, before=before, after=after, ip=_client_ip(request), prev_hash=prev,
        row_hash=hashlib.sha256((prev + body).encode()).hexdigest(), created_at=now,
    )
    db.add(row)
    db.flush()  # so a second log_admin in the same request chains to this one
    return row
