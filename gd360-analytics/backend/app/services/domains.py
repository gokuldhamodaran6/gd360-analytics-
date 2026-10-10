"""
Company domains (2026-10-10, round 19).

A workspace connects ONE address of its own (data.acmeretail.com) and
publishes dashboards at paths on it (data.acmeretail.com/sales). Viewers open
them on that address, in the same dashboard view as the app, and sign in with
a GD360 account (password or an emailed code) - never a redirect elsewhere.

Connecting a domain (owner/admin):
  1. Add two DNS records at the company's DNS provider:
       CNAME  data.acmeretail.com      -> this installation's frontend host
       TXT    _gd360.data.acmeretail.com = "gd360-verify=<token>"
     The TXT record proves the company controls the domain; the CNAME sends
     visitors here.
  2. "Check now" reads both records over DNS-over-HTTPS (Cloudflare, then
     Google as a fallback) and, once both are found, registers the hostname
     with Render (services/render_domains.py), which issues the HTTPS
     certificate. pending_dns -> pending_ssl -> live.

Who can open what on the domain (checked on every request):
  - members of the workspace: everything published there;
  - anyone else needs a proven email (signed in with an emailed code, or
    verified once) and the publication's audience:
      "domain"  -> the domain's own audience: "company" (email at one of
                   allowed_email_domains), "invited" (in invited_emails) or
                   "public" (anyone, no sign-in);
      "invited" -> in the publication's invited_emails;
      "members" -> workspace members only;
  - or an approved access request for that dashboard.

Row rules (warehouse dashboards only): a publication can show each viewer
only their rows - {"column": "region", "by_email": {...}, "by_domain": {...},
"default": "none" | "all" | [values]}. The rule is added to every query as a
filter the viewer can't remove; a block whose table can't be filtered by the
column (and a SQL cell, which takes no page filters) is not shown to them.
Owners, admins and the dashboard's owner see every row.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta
from urllib.parse import urlparse

import requests
from sqlalchemy.orm import Session

from .. import models
from ..config import get_settings
from . import policies, workspace_access

settings = get_settings()

FREE_MAIL = {
    "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "ymail.com",
    "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "gmx.de", "mail.com",
    "zoho.com", "yandex.com", "yandex.ru", "qq.com", "163.com", "rediffmail.com",
}

_HOST_RX = re.compile(r"^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")
_PATH_RX = re.compile(r"^[a-z0-9]([a-z0-9-]{0,58}[a-z0-9])?$")
RESERVED_PATHS = {
    "login", "logout", "signin", "sign-in", "signup", "sign-up", "register", "verify", "code", "api", "admin",
    "settings", "account", "home", "assets", "static", "public", "viewer", "d", "auth", "help", "privacy",
    "favicon-ico", "robots-txt",
}


class DomainError(Exception):
    """A message safe to show the person as is."""


# ------------------------------------------------------------ addresses ----

def cname_target() -> str:
    if settings.FRONTEND_CNAME_TARGET:
        return settings.FRONTEND_CNAME_TARGET.strip().lower().rstrip(".")
    host = urlparse(settings.FRONTEND_ORIGIN or "").hostname or ""
    return host.lower()


def normalize_hostname(raw: str) -> str:
    h = str(raw or "").strip().lower()
    if "://" in h:
        h = urlparse(h).hostname or ""
    h = h.split("/")[0].split(":")[0].strip(".")
    if h.startswith("www.") and h.count(".") >= 2:
        pass  # www.acme.com is a fine subdomain - kept as typed
    if not _HOST_RX.match(h):
        raise DomainError("Enter an address like data.yourcompany.com.")
    if h.count(".") < 2:
        raise DomainError("Use a subdomain such as data." + h + " - a bare company domain can't point here "
                          "without moving your website.")
    target = cname_target()
    if h.endswith(".onrender.com") or (target and (h == target or h.endswith("." + target))) or "gd360" in h.split(".")[-2:]:
        raise DomainError("That address belongs to GD360 itself - use one of your company's own.")
    return h


def txt_name(hostname: str) -> str:
    return f"_gd360.{hostname}"


def txt_value(dom: models.WorkspaceDomain) -> str:
    return f"gd360-verify={dom.verify_token}"


def _relative(name: str, hostname: str) -> str:
    """The "Name/Host" box most DNS providers want - the part before the
    company's own domain (data, _gd360.data)."""
    parts = hostname.split(".")
    zone = ".".join(parts[-2:]) if len(parts[-1]) > 2 or len(parts) < 4 else ".".join(parts[-3:])
    return name[: -(len(zone) + 1)] if name.endswith("." + zone) else name


def dns_records(dom: models.WorkspaceDomain) -> list[dict]:
    return [
        {"type": "CNAME", "name": dom.hostname, "host": _relative(dom.hostname, dom.hostname), "value": cname_target(),
         "ok": bool(dom.dns_cname_ok), "purpose": "Sends visitors to GD360"},
        {"type": "TXT", "name": txt_name(dom.hostname), "host": _relative(txt_name(dom.hostname), dom.hostname),
         "value": txt_value(dom), "ok": bool(dom.dns_txt_ok), "purpose": "Proves the domain is yours"},
    ]


def normalize_path(raw: str) -> str:
    p = re.sub(r"[^a-z0-9]+", "-", str(raw or "").strip().lower()).strip("-")[:60].strip("-")
    if not p or not _PATH_RX.match(p):
        raise DomainError("Use letters, numbers and dashes for the address, like sales or weekly-kpis.")
    if p in RESERVED_PATHS:
        raise DomainError(f'"{p}" is kept for sign-in pages - pick another address.')
    return p


def suggest_path(db: Session, dom: models.WorkspaceDomain, name: str, exclude_pub_id: str | None = None) -> str:
    try:
        base = normalize_path(name)
    except DomainError:
        base = "dashboard"
    taken = {p for (p,) in db.query(models.DomainPublication.path).filter(
        models.DomainPublication.domain_id == dom.id, models.DomainPublication.status.in_(("live", "pending")),
        models.DomainPublication.id != (exclude_pub_id or ""))}
    if base not in taken:
        return base
    for i in range(2, 200):
        cand = f"{base[:55]}-{i}"
        if cand not in taken:
            return cand
    return f"{base[:40]}-{datetime.utcnow().strftime('%H%M%S')}"


def clean_emails(raw) -> list[str]:
    items = raw if isinstance(raw, list) else re.split(r"[\s,;]+", str(raw or ""))
    out = []
    for e in items:
        e = str(e or "").strip().lower()
        if e and re.match(r"^[^@\s]+@[^@\s]+\.[a-z]{2,}$", e) and e not in out:
            out.append(e)
    return out[:500]


def clean_email_domains(raw) -> list[str]:
    items = raw if isinstance(raw, list) else re.split(r"[\s,;]+", str(raw or ""))
    out = []
    for d in items:
        d = str(d or "").strip().lower().lstrip("@")
        if not d:
            continue
        if not _HOST_RX.match(d) or d.count(".") < 1:
            raise DomainError(f'"{d}" isn\'t an email domain - use something like acmeretail.com.')
        if d in FREE_MAIL:
            raise DomainError(f"{d} is a free email service - anyone can have an address there, so it can't "
                              "stand for your company. Invite those people by email instead.")
        if d not in out:
            out.append(d)
    return out[:20]


def guess_email_domains(db: Session, ws: models.Workspace) -> list[str]:
    rows = (db.query(models.User.email).join(models.WorkspaceMember, models.WorkspaceMember.user_id == models.User.id)
            .filter(models.WorkspaceMember.workspace_id == ws.id).all())
    counts: dict[str, int] = {}
    for (e,) in rows:
        d = (e or "").split("@")[-1].lower()
        if d and d not in FREE_MAIL:
            counts[d] = counts.get(d, 0) + 1
    return [d for d, _ in sorted(counts.items(), key=lambda x: -x[1])][:3]


# ------------------------------------------------------------------ DNS ----

_DOH = ("https://cloudflare-dns.com/dns-query", "https://dns.google/resolve")


def _doh(name: str, rtype: str) -> list[str] | None:
    """Answers for one record, or None if no resolver could be reached."""
    for url in _DOH:
        try:
            r = requests.get(url, params={"name": name, "type": rtype}, headers={"accept": "application/dns-json"},
                             timeout=6)
            if r.status_code != 200:
                continue
            data = r.json()
            return [str(a.get("data") or "").strip().strip('"').rstrip(".").lower()
                    for a in data.get("Answer") or [] if a.get("data")]
        except Exception:  # noqa: BLE001 - try the next resolver
            continue
    return None


def check_dns(dom: models.WorkspaceDomain) -> dict:
    """Reads the two records. Returns {"cname": bool, "txt": bool, "reached": bool,
    "cname_seen": [...], "txt_seen": [...]}."""
    target = cname_target()
    cname = _doh(dom.hostname, "CNAME")
    txt = _doh(txt_name(dom.hostname), "TXT")
    reached = cname is not None or txt is not None
    cname_ok = bool(cname and target and any(c == target for c in cname))
    if not cname_ok and target:
        # A proxied CNAME (Cloudflare's orange cloud) answers with addresses;
        # the same addresses as the target count as pointing here.
        mine = _doh(dom.hostname, "A") or []
        theirs = _doh(target, "A") or []
        cname_ok = bool(mine and theirs and set(mine) & set(theirs))
    want = txt_value(dom).lower()
    txt_ok = bool(txt and any(t.replace('" "', "").replace('"', "") == want for t in txt))
    return {"cname": cname_ok, "txt": txt_ok, "reached": reached, "cname_seen": cname or [], "txt_seen": txt or []}


def check(db: Session, dom: models.WorkspaceDomain) -> dict:
    """One "Check now": DNS, then Render. Updates the row (caller commits).
    Returns what changed, for the audit log and the page."""
    from . import render_domains
    before = dom.status
    dom.last_checked_at = datetime.utcnow()
    dom.last_error = None
    seen = check_dns(dom)
    dom.dns_cname_ok, dom.dns_txt_ok = seen["cname"], seen["txt"]
    if not seen["reached"]:
        dom.last_error = "We couldn't reach a DNS resolver just now - try again in a minute."
        return {"before": before, "after": dom.status, "dns": seen}
    if not seen["txt"]:
        dom.status = "pending_dns"
        dom.last_error = (f"The TXT record isn't there yet. Add {txt_name(dom.hostname)} with the value "
                          f"{txt_value(dom)} - new records can take up to an hour to show.")
        return {"before": before, "after": dom.status, "dns": seen}
    if not seen["cname"]:
        dom.status = "pending_dns"
        got = ", ".join(seen["cname_seen"][:2])
        dom.last_error = (f"The CNAME record for {dom.hostname} should point to {cname_target()}"
                          + (f" - it points to {got} right now." if got else " - we can't see it yet."))
        return {"before": before, "after": dom.status, "dns": seen}
    dom.verified_at = dom.verified_at or datetime.utcnow()
    try:
        if not dom.render_custom_domain_id:
            dom.render_custom_domain_id, status = render_domains.create_custom_domain(dom.hostname)
        else:
            status = render_domains.get_custom_domain_status(dom.render_custom_domain_id)
    except render_domains.RenderDomainsNotConfigured:
        dom.status = "pending_ssl"
        dom.last_error = ("Your records are right. The HTTPS step needs this server's hosting key "
                          "(RENDER_API_KEY and RENDER_FRONTEND_SERVICE_ID) - ask whoever runs GD360 to add them.")
        return {"before": before, "after": dom.status, "dns": seen}
    except render_domains.RenderDomainError as e:
        dom.status = "error"
        dom.last_error = str(e)
        return {"before": before, "after": dom.status, "dns": seen}
    if status == "live":
        dom.status = "live"
        dom.live_at = dom.live_at or datetime.utcnow()
    else:
        dom.status = "pending_ssl"
    return {"before": before, "after": dom.status, "dns": seen}


# --------------------------------------------------------------- access ----

def member_role(db: Session, user: models.User | None, workspace_id: str) -> str | None:
    if not user:
        return None
    return workspace_access.member_role(db, user.id, workspace_id)


def _email_domain(email: str) -> str:
    return (email or "").split("@")[-1].lower()


def site_audience_allows(dom: models.WorkspaceDomain, user: models.User | None) -> tuple[bool, str]:
    """(ok, reason) for the domain's own audience."""
    if dom.audience == "public":
        return True, ""
    if not user:
        return False, "sign_in"
    email = (user.email or "").lower()
    if dom.audience == "company":
        if _email_domain(email) in (dom.allowed_email_domains or []):
            return (True, "") if user.email_verified_at else (False, "verify_email")
        return False, "not_allowed"
    if email in (dom.invited_emails or []):
        return (True, "") if user.email_verified_at else (False, "verify_email")
    return False, "not_allowed"


def can_open(db: Session, dom: models.WorkspaceDomain, pub: models.DomainPublication,
             user: models.User | None) -> tuple[bool, str]:
    """(ok, reason). reason: "" | "sign_in" | "verify_email" | "not_allowed" | "members_only"."""
    if pub.status != "live":
        return False, "gone"
    if member_role(db, user, dom.workspace_id):
        return True, ""
    if user and db.query(models.DomainAccessRequest.id).filter(
            models.DomainAccessRequest.publication_id == pub.id, models.DomainAccessRequest.status == "approved",
            models.DomainAccessRequest.email == (user.email or "").lower()).first():
        return (True, "") if user.email_verified_at else (False, "verify_email")
    if pub.audience == "members":
        return False, ("sign_in" if not user else "members_only")
    if pub.audience == "invited":
        if not user:
            return False, "sign_in"
        if (user.email or "").lower() in (pub.invited_emails or []):
            return (True, "") if user.email_verified_at else (False, "verify_email")
        return False, "not_allowed"
    ok, why = site_audience_allows(dom, user)
    if ok and pub.row_rule and not user:
        return False, "sign_in"     # a row rule needs to know who is looking
    return ok, why


def sees_every_row(db: Session, dom: models.WorkspaceDomain, pub: models.DomainPublication,
                   d: models.Dashboard, user: models.User | None) -> bool:
    if not user:
        return False
    if user.id == d.owner_id:
        return True
    return member_role(db, user, dom.workspace_id) in workspace_access.ADMIN_ROLES


def rule_values(pub: models.DomainPublication, user: models.User | None):
    """None = every row; [] = no rows; [values] = only those."""
    rule = pub.row_rule if isinstance(pub.row_rule, dict) else None
    if not rule or not rule.get("column"):
        return None
    email = (user.email or "").lower() if user else ""
    by_email = {str(k).lower(): v for k, v in (rule.get("by_email") or {}).items()}
    by_domain = {str(k).lower(): v for k, v in (rule.get("by_domain") or {}).items()}
    if email and email in by_email:
        return [v for v in by_email[email] if v is not None]
    if email and _email_domain(email) in by_domain:
        return [v for v in by_domain[_email_domain(email)] if v is not None]
    default = rule.get("default", "none")
    if default == "all":
        return None
    if isinstance(default, list):
        return [v for v in default if v is not None]
    return []


def normalize_row_rule(raw, schema_columns: set[str]) -> dict | None:
    if not raw:
        return None
    if not isinstance(raw, dict):
        raise DomainError("That row rule isn't in a shape GD360 understands.")
    column = str(raw.get("column") or "").strip()
    if not column:
        return None
    if column not in schema_columns:
        raise DomainError(f'"{column}" isn\'t a column of this dashboard\'s data.')

    def vals(v):
        if isinstance(v, str):
            v = [x.strip() for x in v.split(",")]
        if not isinstance(v, list):
            return []
        out = []
        for x in v:
            if isinstance(x, (str, int, float)) and not isinstance(x, bool) and str(x).strip() != "" and x not in out:
                out.append(x.strip() if isinstance(x, str) else x)
        return out[:200]

    by_email = {}
    for k, v in (raw.get("by_email") or {}).items():
        e = clean_emails([k])
        if e and vals(v):
            by_email[e[0]] = vals(v)
    by_domain = {}
    for k, v in (raw.get("by_domain") or {}).items():
        d = str(k or "").strip().lower().lstrip("@")
        if d and vals(v):
            by_domain[d] = vals(v)
    default = raw.get("default", "none")
    if default not in ("none", "all"):
        default = vals(default) or "none"
    if not by_email and not by_domain and default == "none":
        raise DomainError("Say who sees which rows - add at least one person or email domain.")
    return {"column": column, "by_email": by_email, "by_domain": by_domain, "default": default}


def describe_rule(rule: dict | None) -> str | None:
    if not rule:
        return None
    n = len(rule.get("by_email") or {}) + len(rule.get("by_domain") or {})
    d = rule.get("default")
    tail = ("everyone else sees all rows" if d == "all" else
            "everyone else sees nothing" if d == "none" else f"everyone else sees {', '.join(map(str, d[:3]))}")
    return f"Rows by {rule['column']}: {n} rule{'s' if n != 1 else ''}, {tail}"


# ------------------------------------------------------------- outputs ----

def iso(dt):
    return dt.isoformat() + "Z" if dt else None


def domain_out(db: Session, dom: models.WorkspaceDomain) -> dict:
    ws = db.get(models.Workspace, dom.workspace_id)
    return {
        "id": dom.id, "hostname": dom.hostname, "status": dom.status, "url": f"https://{dom.hostname}",
        "records": dns_records(dom), "cname_target": cname_target(),
        "last_error": dom.last_error, "last_checked_at": iso(dom.last_checked_at),
        "verified_at": iso(dom.verified_at), "live_at": iso(dom.live_at), "created_at": iso(dom.created_at),
        "audience": dom.audience, "allowed_email_domains": dom.allowed_email_domains or [],
        "invited_emails": dom.invited_emails or [], "site_title": dom.site_title or "",
        "default_title": f"{ws.name} data" if ws else dom.hostname,
        "show_powered_by": bool(dom.show_powered_by), "has_logo": bool(dom.logo_image),
        "publish_needs_approval": bool(policies.get(ws).get("domain_publish_needs_approval")),
    }


def publication_out(db: Session, dom: models.WorkspaceDomain, p: models.DomainPublication,
                    names: dict | None = None) -> dict:
    d = db.get(models.Dashboard, p.dashboard_id)
    since = datetime.utcnow() - timedelta(days=30)
    viewers = (db.query(models.DomainView.email).filter(models.DomainView.publication_id == p.id,
                                                        models.DomainView.viewed_at >= since).distinct().count())
    names = names or {}

    def name_of(uid):
        if not uid:
            return None
        if uid not in names:
            u = db.get(models.User, uid)
            names[uid] = (u.full_name or u.email) if u else "Someone"
        return names[uid]

    return {
        "id": p.id, "dashboard_id": p.dashboard_id, "dashboard": d.name if d else "(deleted)",
        "title": p.title or (d.name if d else ""), "path": p.path, "url": f"https://{dom.hostname}/{p.path}",
        "audience": p.audience, "invited_emails": p.invited_emails or [], "row_rule": p.row_rule,
        "row_rule_text": describe_rule(p.row_rule), "status": p.status,
        "requested_by": name_of(p.requested_by_id), "requested_at": iso(p.requested_at), "request_note": p.request_note,
        "decided_by": name_of(p.decided_by_id), "decided_at": iso(p.decided_at), "decision_note": p.decision_note,
        "published_at": iso(p.published_at), "views": p.view_count or 0, "viewers_30d": viewers,
        "last_viewed_at": iso(p.last_viewed_at),
        "subscribers": db.query(models.DomainSubscription.id).filter(models.DomainSubscription.publication_id == p.id).count(),
    }


def access_request_out(db: Session, dom: models.WorkspaceDomain, r: models.DomainAccessRequest) -> dict:
    p = db.get(models.DomainPublication, r.publication_id)
    u = db.get(models.User, r.user_id) if r.user_id else None
    return {
        "id": r.id, "publication_id": r.publication_id, "title": (p.title if p else None) or "",
        "path": p.path if p else "", "email": r.email, "name": (u.full_name if u else None) or r.email,
        "note": r.note, "status": r.status, "created_at": iso(r.created_at), "decided_at": iso(r.decided_at),
    }


# --------------------------------------------------------- notifications ----

def _send(to: list[str], subject: str, html: str, text: str) -> None:
    from . import automations as auto_svc
    to = [t for t in dict.fromkeys(to) if t][:20]
    if not to or not auto_svc.email_configured():
        return
    try:
        auto_svc.send_email(to, subject, html, text)
    except Exception as e:  # noqa: BLE001
        print(f"[domains] email failed (non-fatal): {e}")


def admin_emails(db: Session, workspace_id: str, exclude: str | None = None) -> list[str]:
    rows = (db.query(models.User.email).join(models.WorkspaceMember, models.WorkspaceMember.user_id == models.User.id)
            .filter(models.WorkspaceMember.workspace_id == workspace_id,
                    models.WorkspaceMember.role.in_(tuple(workspace_access.ADMIN_ROLES))).all())
    return [e for (e,) in rows if e and e != exclude]


def notify(db: Session, to: list[str], subject: str, lines: list[str], link: str | None = None,
           link_label: str = "Open it") -> None:
    html = "".join(f"<p>{ln}</p>" for ln in lines) + (f'<p><a href="{link}">{link_label}</a></p>' if link else "")
    text = "\n".join(lines) + (f"\n{link_label}: {link}" if link else "")
    _send(to, subject, html, text)


def app_url() -> str:
    from . import automations as auto_svc
    return auto_svc.app_url()


# ---------------------------------------------------------- subscriptions ----

def next_monday_8(tz_name: str, after: datetime | None = None) -> datetime:
    """Next Monday 08:00 in tz_name, as naive UTC."""
    try:
        from zoneinfo import ZoneInfo
        tz = ZoneInfo(tz_name or "UTC")
    except Exception:  # noqa: BLE001
        from zoneinfo import ZoneInfo
        tz = ZoneInfo("UTC")
    from datetime import timezone
    now_utc = (after or datetime.utcnow()).replace(tzinfo=timezone.utc)
    local = now_utc.astimezone(tz)
    days = (7 - local.weekday()) % 7
    cand = local.replace(hour=8, minute=0, second=0, microsecond=0) + timedelta(days=days)
    if cand <= local:
        cand += timedelta(days=7)
    return cand.astimezone(timezone.utc).replace(tzinfo=None)


def send_due_subscriptions(db: Session) -> int:
    """Called by the scheduler tick: emails each due weekly subscription the
    link to its dashboard. Returns how many were sent."""
    now = datetime.utcnow()
    due = (db.query(models.DomainSubscription).filter(models.DomainSubscription.next_send_at.isnot(None),
                                                      models.DomainSubscription.next_send_at <= now)
           .limit(200).all())
    sent = 0
    for s in due:
        p = db.get(models.DomainPublication, s.publication_id)
        dom = db.get(models.WorkspaceDomain, p.domain_id) if p else None
        u = db.get(models.User, s.user_id)
        if not p or not dom or p.status != "live" or dom.status != "live" or not u:
            db.delete(s)
            continue
        ok, _ = can_open(db, dom, p, u)
        s.next_send_at = next_monday_8(s.timezone, now + timedelta(hours=1))
        if not ok:
            s.last_error = "No longer has access"
            continue
        ws = db.get(models.Workspace, dom.workspace_id)
        site = dom.site_title or (f"{ws.name} data" if ws else dom.hostname)
        title = p.title or "your dashboard"
        url = f"https://{dom.hostname}/{p.path}"
        unsub = f"{url}?unsubscribe=1"
        try:
            from . import automations as auto_svc
            if auto_svc.email_configured():
                auto_svc.send_email(
                    [s.email], f"This week: {title}",
                    f"<p>Your Monday link to <b>{title}</b> on {site}.</p><p><a href=\"{url}\">Open {title}</a></p>"
                    f"<p style=\"color:#7D8A86;font-size:12px\">You asked for this every Monday. "
                    f"<a href=\"{unsub}\">Stop these emails</a>.</p>",
                    f"Your Monday link to {title} on {site}: {url}\nStop these emails: {unsub}",
                )
                s.last_sent_at = now
                s.last_error = None
                sent += 1
            else:
                s.last_error = "Email isn't set up on this server"
        except Exception as e:  # noqa: BLE001
            s.last_error = str(e)[:300]
    db.commit()
    return sent
