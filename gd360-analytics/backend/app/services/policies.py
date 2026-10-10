"""
Company rules for a workspace (2026-10-10, round 19).

Stored on Workspace.policies (JSON); anything missing falls back to the
default below, so a workspace that never touched its rules behaves exactly
as before this round. Owners and admins change them in the Trust Center.

Each rule is enforced where it matters, not just displayed:
  require_mfa                     - members without 2-step sign-in are listed
                                    as a risk and asked to set it up when they
                                    open the app (routers/auth.py /me flag).
  block_public_links              - "Anyone with the link" sharing is turned
                                    off: dashboards in this workspace are
                                    shared with named people (private links)
                                    or on the company domain. Publishing a
                                    public link is refused (dashboard_builder).
  external_email_needs_approval   - a member's automation that emails people
                                    outside the company waits for an owner or
                                    admin (routers/automations.py).
  domain_publish_needs_approval   - members ask; owners/admins publish to
                                    the company domain (routers/domains.py).
  review_every_days               - how often each source's access must be
                                    confirmed before it counts as overdue.
  guest_expiry_days               - informational for now (shown in rules).
"""
from __future__ import annotations

from .. import models

DEFAULTS: dict = {
    "require_mfa": False,
    "block_public_links": False,
    "external_email_needs_approval": True,
    "domain_publish_needs_approval": True,
    "review_every_days": 90,
}

LABELS: dict = {
    "require_mfa": "2-step sign-in required for everyone",
    "block_public_links": "No \"anyone with the link\" dashboards - share with named people or on the company domain",
    "external_email_needs_approval": "Emails to people outside the company need an owner's or admin's OK",
    "domain_publish_needs_approval": "Members ask before publishing to the company domain",
    "review_every_days": "Confirm who can see each source every",
}

REVIEW_CHOICES = (30, 60, 90, 180, 365)


def get(ws: models.Workspace | None) -> dict:
    out = dict(DEFAULTS)
    if ws is not None and isinstance(ws.policies, dict):
        for k, v in ws.policies.items():
            if k in DEFAULTS:
                out[k] = v
    return out


def normalize(patch: dict, current: dict) -> dict:
    """Validates a partial update; returns the full new rule set."""
    out = dict(current)
    for k, v in (patch or {}).items():
        if k not in DEFAULTS:
            raise ValueError(f'"{k}" is not a rule GD360 knows.')
        if k == "review_every_days":
            try:
                n = int(v)
            except (TypeError, ValueError):
                raise ValueError("Pick how many days between access reviews.")
            if n not in REVIEW_CHOICES:
                raise ValueError("Reviews can be every 30, 60, 90, 180 or 365 days.")
            out[k] = n
        else:
            out[k] = bool(v)
    return out


def for_workspace_id(db, workspace_id: str | None) -> dict:
    return get(db.get(models.Workspace, workspace_id) if workspace_id else None)
