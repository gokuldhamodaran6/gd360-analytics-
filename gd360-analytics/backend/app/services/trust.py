"""
Trust Center (2026-10-10, round 19) - replaces the Governance page.

For one workspace it answers, from real records only:
  - who can see each source, and when that was last confirmed (access review)
  - which columns hold personal or sensitive data, and whether they're hidden
  - what is shared outside the team (public/private links, the company domain)
  - whether the data's quality checks pass
  - who signs in with 2-step, who is active, who manages the workspace
and turns that into a posture score (six parts) and an ordered list of
risks, each with the fix one click away.

Sensitive data is found by column NAME for every source (free, no query)
and also by sampling VALUES for uploaded files (local data, never billed).
Live warehouses are never queried by the Trust Center.
"""
from __future__ import annotations

import csv
import io
import json
import re
import zipfile
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from .. import models
from . import policies, workspace_access
from .ops_home import Scope, ScopeError, iso
from .project_engine.catalog import _schema_tables, source_mode

# ------------------------------------------------------------ sensitive ----

CATEGORY_LABEL = {
    "email": "Email", "phone": "Phone", "name": "Person's name", "address": "Address", "birth_date": "Date of birth",
    "salary": "Pay", "government_id": "Government ID", "payment": "Payment details", "ip_address": "IP address",
    "health": "Health", "other": "Sensitive",
}

_NAME_RULES: list[tuple[str, re.Pattern]] = [
    ("email", re.compile(r"(^|_)(e_?mail|email_?addr(ess)?)($|_)")),
    ("phone", re.compile(r"(^|_)(phone|mobile|cell|telephone|tel|whatsapp)(_?(no|number|num))?($|_)")),
    ("name", re.compile(r"(^|_)(first|last|full|given|family|sur|middle)_?name($|_)|^(customer|contact|employee|person|guest|patient|member|user)_?name$")),
    ("address", re.compile(r"(^|_)(street|address|addr|address_line_?\d?|postcode|post_code|postal_code|zip|zipcode|zip_code)($|_)")),
    ("birth_date", re.compile(r"(^|_)(dob|birth|birthday|birth_?date|date_of_birth)($|_)")),
    ("salary", re.compile(r"(^|_)(salary|salaries|wage|wages|compensation|pay_?rate|payroll|base_pay|bonus|income)($|_)")),
    ("government_id", re.compile(r"(^|_)(ssn|social_security|passport(_no|_number)?|national_id|nin|aadhaar|aadhar|pan_?(no|number)?|tax_?id|driver_?licen[cs]e)($|_)")),
    ("payment", re.compile(r"(^|_)(card_?number|credit_?card|cc_?number|iban|account_?number|routing_?number|cvv|cvc|sort_?code)($|_)")),
    ("ip_address", re.compile(r"(^|_)(ip|ip_?address|ip_?addr|client_?ip|remote_?addr)($|_)")),
    ("health", re.compile(r"(^|_)(diagnosis|medical|health_?condition|disability|medication)($|_)")),
]
# a column that only counts or describes the thing is not personal data
_NOT_PERSONAL = re.compile(
    r"(count|_cnt|rate|pct|percent|ratio|opens|clicks|bounces|sent|delivered|campaign|template|type|kind|status|flag|"
    r"^is_|^has_|_domain$|verified|opt_?in|consent|_at$|_date$|score|share|total|avg|mean|sum|_id$|^id$)"
)

EMAIL_VAL = re.compile(r"^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$")
PHONE_VAL = re.compile(r"^\+?[\d][\d\s().\-]{6,18}\d$")
IP_VAL = re.compile(r"^(\d{1,3}\.){3}\d{1,3}$")
CARD_VAL = re.compile(r"^(?:\d[ -]?){13,19}$")


def _norm(name: str) -> str:
    s = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", str(name or "")).lower()
    return re.sub(r"[^a-z0-9]+", "_", s).strip("_")


def name_category(column: str) -> str | None:
    n = _norm(column)
    if not n:
        return None
    for cat, rx in _NAME_RULES:
        if rx.search(n):
            if cat not in ("birth_date",) and _NOT_PERSONAL.search(n) and not n.endswith(("_email", "email")):
                continue
            return cat
    return None


def _luhn(digits: str) -> bool:
    total, alt = 0, False
    for ch in reversed(digits):
        d = int(ch)
        if alt:
            d = d * 2 - 9 if d > 4 else d * 2
        total += d
        alt = not alt
    return total % 10 == 0


def value_category(values: list) -> str | None:
    vals = [str(v).strip() for v in values if v is not None and str(v).strip() and str(v).strip().lower() != "nan"]
    if len(vals) < 5:
        return None
    vals = vals[:300]
    n = len(vals)
    if sum(1 for v in vals if EMAIL_VAL.match(v)) / n >= 0.6:
        return "email"
    if sum(1 for v in vals if IP_VAL.match(v)) / n >= 0.6:
        return "ip_address"
    cards = [re.sub(r"[ -]", "", v) for v in vals if CARD_VAL.match(v)]
    if len(cards) / n >= 0.6 and sum(1 for c in cards if _luhn(c)) / max(1, len(cards)) >= 0.9:
        return "payment"
    phones = [v for v in vals if PHONE_VAL.match(v) and (v.startswith("+") or re.search(r"[\s().\-]", v))]
    if len(phones) / n >= 0.6:
        return "phone"
    return None


_VALUE_SCANNED: dict[tuple, bool] = {}


def _data_version(ds: models.DataSource) -> str:
    v = ds.last_synced_at or getattr(ds, "cleaned_updated_at", None) or ds.created_at
    return v.isoformat() if v else ""


def scan_source(db: Session, ds: models.DataSource, values: bool = True) -> list[dict]:
    """Finds sensitive columns in one source and records new ones. Never
    queries a live database or warehouse; samples values only for uploaded
    files. Returns the findings (table, column, category, reason)."""
    findings: list[dict] = []
    seen: set[tuple] = set()
    for table, cols in _schema_tables(ds):
        for c in cols:
            name = c.get("name") if isinstance(c, dict) else c
            if name is None:
                continue
            cat = name_category(str(name))
            if cat:
                key = (table or "", str(name))
                if key not in seen:
                    seen.add(key)
                    findings.append({"table": table or "", "column": str(name), "category": cat, "reason": "Column name"})
    if source_mode(ds.kind) == "synced":
        rows = db.query(models.SyncedTable.table_name, models.SyncedTable.columns).filter(
            models.SyncedTable.datasource_id == ds.id).all()
        for tname, cols in rows:
            for c in cols or []:
                name = c.get("name") if isinstance(c, dict) else c
                cat = name_category(str(name or ""))
                if cat and (tname, str(name)) not in seen:
                    seen.add((tname, str(name)))
                    findings.append({"table": tname, "column": str(name), "category": cat, "reason": "Column name"})
    key = (ds.id, _data_version(ds))
    if values and source_mode(ds.kind) == "file" and ds.kind in ("csv", "excel") and not _VALUE_SCANNED.get(key):
        try:
            from .data_loader import load_dataframe
            df = load_dataframe(ds, table=None, version="original", db=db)
            sample = df.head(400)
            for col in sample.columns:
                if (("", str(col)) in seen) or (sample[col].dtype.kind in "biuf"):
                    continue
                cat = value_category(sample[col].tolist())
                if cat:
                    seen.add(("", str(col)))
                    findings.append({"table": "", "column": str(col), "category": cat,
                                     "reason": f"Values look like {CATEGORY_LABEL[cat].lower()}s"})
            _VALUE_SCANNED[key] = True
        except Exception as e:  # noqa: BLE001 - a scan never breaks the page
            print(f"[trust] value scan of {ds.id} failed: {e}")
            _VALUE_SCANNED[key] = True
    existing = {(r.table_name or "", r.column_name): r for r in
                db.query(models.SensitiveColumn).filter(models.SensitiveColumn.datasource_id == ds.id).all()}
    added = False
    for f in findings:
        if (f["table"], f["column"]) not in existing:
            db.add(models.SensitiveColumn(datasource_id=ds.id, table_name=f["table"], column_name=f["column"],
                                          category=f["category"], reason=f["reason"], source="auto", status="flagged"))
            added = True
    if added:
        db.commit()
    return findings


# ------------------------------------------------------------ the data ----

def _sources(scope: Scope) -> list[models.DataSource]:
    return scope.filter(scope.db.query(models.DataSource), models.DataSource).order_by(models.DataSource.name).all()


def _members(db: Session, ws: models.Workspace) -> list[tuple[models.WorkspaceMember, models.User]]:
    return (db.query(models.WorkspaceMember, models.User)
            .join(models.User, models.User.id == models.WorkspaceMember.user_id)
            .filter(models.WorkspaceMember.workspace_id == ws.id).all())


def _last_active(db: Session, user_ids: list[str]) -> dict:
    if not user_ids:
        return {}
    from sqlalchemy import func
    rows = (db.query(models.AuditEvent.actor_user_id, func.max(models.AuditEvent.created_at))
            .filter(models.AuditEvent.actor_user_id.in_(user_ids)).group_by(models.AuditEvent.actor_user_id).all())
    return {uid: ts for uid, ts in rows}


def _rules(db: Session, ds_ids: list[str]) -> dict:
    out: dict[str, list[models.DataAccessRule]] = {}
    if not ds_ids:
        return out
    for r in db.query(models.DataAccessRule).filter(models.DataAccessRule.datasource_id.in_(ds_ids)).all():
        out.setdefault(r.datasource_id, []).append(r)
    return out


def _hidden_from(rules: list[models.DataAccessRule], column: str) -> set[str]:
    return {r.role for r in rules if r.kind == "column" and (r.column_name or "").lower() == column.lower()}


def _dash_source(db: Session, d: models.Dashboard) -> str | None:
    from .ops_home import _dash_source_id
    return _dash_source_id(db, d)


def gather(db: Session, user: models.User, workspace_id: str | None, scan: bool = True) -> dict:
    scope = Scope(db, user, workspace_id)
    if not scope.admin:
        raise PermissionError("Only owners and admins can open the Trust Center.")
    ws = scope.ws
    rules_cfg = policies.get(ws)
    sources = _sources(scope)
    if scan:
        scanned = 0
        for ds in sources:
            scan_source(db, ds, values=scanned < 6)
            if source_mode(ds.kind) == "file":
                scanned += 1
    ds_ids = [d.id for d in sources]
    rules = _rules(db, ds_ids)
    sens_rows = (db.query(models.SensitiveColumn).filter(models.SensitiveColumn.datasource_id.in_(ds_ids)).all()
                 if ds_ids else [])
    members = _members(db, ws)
    active = _last_active(db, [u.id for _, u in members])
    names = {u.id: (u.full_name or u.email) for _, u in members}

    # dashboards and what they share
    dash_q = scope.filter(db.query(models.Dashboard), models.Dashboard)
    dashes = dash_q.all()
    domain = db.query(models.WorkspaceDomain).filter(models.WorkspaceDomain.workspace_id == ws.id).first()
    pubs = (db.query(models.DomainPublication).filter(models.DomainPublication.workspace_id == ws.id,
                                                       models.DomainPublication.status == "live").all()
            if domain else [])
    return {"scope": scope, "rules_cfg": rules_cfg, "sources": sources, "rules": rules, "sensitive": sens_rows,
            "members": members, "active": active, "names": names, "dashes": dashes, "domain": domain, "pubs": pubs}


def _sensitive_out(g: dict) -> list[dict]:
    by_id = {d.id: d for d in g["sources"]}
    out = []
    for r in g["sensitive"]:
        ds = by_id.get(r.datasource_id)
        if not ds:
            continue
        hidden = _hidden_from(g["rules"].get(ds.id, []), r.column_name)
        personal = g["scope"].personal or not ds.workspace_id
        if r.status == "dismissed":
            state = "dismissed"
        elif personal:
            state = "private"          # only its owner can see the source at all
        elif {"viewer", "member"} <= hidden:
            state = "hidden"
        elif "viewer" in hidden:
            state = "hidden_viewers"
        else:
            state = "visible"
        out.append({
            "id": r.id, "datasource_id": ds.id, "datasource": ds.name, "table": r.table_name or None,
            "column": r.column_name, "category": r.category, "category_label": CATEGORY_LABEL.get(r.category, "Sensitive"),
            "reason": r.reason, "status": r.status, "state": state,
            "protected": state in ("dismissed", "private", "hidden", "hidden_viewers"),
            "decided_by": g["names"].get(r.decided_by_id) if r.decided_by_id else None, "decided_at": iso(r.decided_at),
            "can_manage": True,
        })
    out.sort(key=lambda x: (x["protected"], x["datasource"].lower(), x["column"].lower()))
    return out


def _sharing_out(g: dict, sens: list[dict]) -> list[dict]:
    db = g["scope"].db
    exposed_sources = {s["datasource_id"] for s in sens if s["status"] != "dismissed"}
    out = []
    for d in g["dashes"]:
        share = d.share
        src = _dash_source(db, d)
        has_sensitive = src in exposed_sources
        if share and share.published_at:
            # A public link never has a password (only private links can
            # carry one, on top of the named-people list).
            level = "public" if share.mode == "public" else "private"
            emails = len(share.allowed_emails or [])
            out.append({
                "kind": "link", "dashboard_id": d.id, "dashboard": d.name, "level": level,
                "address": f"/d/{share.slug}", "custom_domain": share.custom_domain,
                "custom_domain_status": share.custom_domain_status,
                "password": share.mode == "private" and bool(share.password_hash), "emails": emails,
                "views": share.view_count or 0, "last_viewed_at": iso(share.last_viewed_at),
                "published_at": iso(share.published_at), "sensitive_source": has_sensitive,
                "owner": g["names"].get(d.owner_id, "Someone"),
            })
    dom = g["domain"]
    since = datetime.utcnow() - timedelta(days=30)
    for p in g["pubs"]:
        d = db.get(models.Dashboard, p.dashboard_id)
        if not d:
            continue
        src = _dash_source(db, d)
        viewers = (db.query(models.DomainView.user_id).filter(models.DomainView.publication_id == p.id,
                                                              models.DomainView.viewed_at >= since).distinct().count())
        aud = p.audience if p.audience != "domain" else (dom.audience if dom else "company")
        out.append({
            "kind": "domain", "dashboard_id": d.id, "dashboard": d.name, "level": f"domain_{aud}",
            "address": f"{dom.hostname}/{p.path}" if dom else p.path, "custom_domain": dom.hostname if dom else None,
            "custom_domain_status": dom.status if dom else None, "password": False,
            "emails": len(p.invited_emails or []), "views": viewers, "last_viewed_at": iso(p.last_viewed_at),
            "published_at": iso(p.published_at), "sensitive_source": src in exposed_sources,
            "owner": g["names"].get(p.requested_by_id or d.owner_id, "Someone"),
            "row_rule": bool(p.row_rule),
        })
    order = {"public": 0, "domain_public": 0, "domain_company": 2, "domain_invited": 3,
             "domain_members": 3, "private": 4}
    out.sort(key=lambda x: (order.get(x["level"], 5), not x["sensitive_source"], x["dashboard"].lower()))
    return out


def _access_out(g: dict, sens: list[dict]) -> list[dict]:
    scope = g["scope"]
    every = int(g["rules_cfg"]["review_every_days"])
    now = datetime.utcnow()
    roster = [{"user_id": u.id, "name": u.full_name or u.email, "email": u.email, "role": m.role} for m, u in g["members"]]
    out = []
    for ds in g["sources"]:
        reviewed = ds.governance_last_reviewed_at
        due_at = (reviewed + timedelta(days=every)) if reviewed else None
        status = "never" if not reviewed else ("overdue" if due_at and due_at < now else "ok")
        shared = bool(ds.workspace_id) and not scope.personal
        rules = g["rules"].get(ds.id, [])
        out.append({
            "id": ds.id, "name": ds.name, "kind": ds.kind, "mode": source_mode(ds.kind),
            "owner": g["names"].get(ds.owner_id) or "Someone", "shared": shared,
            "who": roster if shared else [r for r in roster if r["user_id"] == ds.owner_id],
            "reviewed_at": iso(reviewed), "reviewed_by": g["names"].get(ds.governance_last_reviewed_by_id),
            "due_at": iso(due_at), "status": status,
            "sensitive": [{"column": s["column"], "category_label": s["category_label"], "protected": s["protected"]}
                          for s in sens if s["datasource_id"] == ds.id and s["status"] != "dismissed"],
            "rules": [{"id": r.id, "role": r.role, "kind": r.kind, "column": r.column_name,
                       "values": r.allowed_values} for r in rules],
        })
    out.sort(key=lambda x: ({"never": 0, "overdue": 1, "ok": 2}[x["status"]], x["name"].lower()))
    return out


def _people_out(g: dict) -> list[dict]:
    out = []
    for m, u in g["members"]:
        last = g["active"].get(u.id)
        out.append({
            "user_id": u.id, "name": u.full_name or u.email.split("@")[0], "email": u.email, "role": m.role,
            "mfa": bool(u.mfa_enabled_at), "last_active": iso(last), "joined_at": iso(m.created_at),
            "is_me": u.id == g["scope"].user.id,
        })
    order = {"owner": 0, "admin": 1, "member": 2, "viewer": 3}
    out.sort(key=lambda p: (order.get(p["role"], 9), p["name"].lower()))
    return out


def _quality_out(g: dict) -> dict:
    db = g["scope"].db
    ds_ids = [d.id for d in g["sources"]]
    rows = db.query(models.DataQualityRule).filter(models.DataQualityRule.datasource_id.in_(ds_ids)).all() if ds_ids else []
    by = {}
    for r in rows:
        by.setdefault(r.datasource_id, []).append(r)
    out = []
    for ds in g["sources"]:
        rs = by.get(ds.id, [])
        failing = [r for r in rs if r.last_status == "fail"]
        errors = [r for r in rs if r.last_status == "error"]
        out.append({
            "id": ds.id, "name": ds.name, "rules": len(rs), "failing": len(failing), "errors": len(errors),
            "passing": sum(1 for r in rs if r.last_status == "pass"),
            "last_run_at": iso(max((r.last_run_at for r in rs if r.last_run_at), default=None)),
            "details": [{"id": r.id, "column": r.column_name, "type": r.rule_type, "status": r.last_status,
                         "message": r.last_message, "failing_rows": r.last_failing_row_count} for r in rs],
        })
    out.sort(key=lambda x: (-x["failing"], x["rules"] == 0, x["name"].lower()))
    return {"sources": out, "total_rules": len(rows), "failing": sum(1 for r in rows if r.last_status == "fail")}


# ------------------------------------------------------------ the score ----

def posture(g: dict, access: list, sens: list, sharing: list, people: list, quality: dict) -> dict:
    scope = g["scope"]
    dims = []

    # 1. access confirmed
    team_sources = [a for a in access if a["shared"]]
    if scope.personal or not team_sources:
        dims.append({"key": "access", "label": "Access confirmed", "score": 100,
                     "detail": "Only you can see your sources" if scope.personal else "Nothing is shared with the team yet"})
    else:
        ok = sum(1 for a in team_sources if a["status"] == "ok")
        dims.append({"key": "access", "label": "Access confirmed", "score": round(100 * ok / len(team_sources)),
                     "detail": f"{ok} of {len(team_sources)} shared sources confirmed in the last {g['rules_cfg']['review_every_days']} days"})

    # 2. sensitive data hidden
    live_sens = [s for s in sens if s["status"] != "dismissed"]
    if not live_sens:
        dims.append({"key": "sensitive", "label": "Personal data hidden", "score": 100, "detail": "No personal data found"})
    else:
        ok = sum(1 for s in live_sens if s["protected"])
        dims.append({"key": "sensitive", "label": "Personal data hidden", "score": round(100 * ok / len(live_sens)),
                     "detail": f"{ok} of {len(live_sens)} sensitive columns hidden or private"})

    # 3. sharing
    links = [s for s in sharing]
    if not links:
        dims.append({"key": "sharing", "label": "Sharing", "score": 100, "detail": "Nothing is shared outside the team"})
    else:
        bad = sum(1 for s in links if s["level"] in ("public", "domain_public"))
        worse = sum(1 for s in links if s["level"] in ("public", "domain_public") and s["sensitive_source"])
        score = max(0, 100 - worse * 40 - (bad - worse) * 20)
        dims.append({"key": "sharing", "label": "Sharing", "score": score,
                     "detail": f"{len(links)} shared · {bad} open to anyone" if bad else f"{len(links)} shared, none open to anyone"})

    # 4. sign-in
    if not people:
        dims.append({"key": "signin", "label": "2-step sign-in", "score": 100, "detail": ""})
    else:
        on = sum(1 for p in people if p["mfa"])
        dims.append({"key": "signin", "label": "2-step sign-in", "score": round(100 * on / len(people)),
                     "detail": f"{on} of {len(people)} people use it" + (" · required" if g["rules_cfg"]["require_mfa"] else "")})

    # 5. data quality
    qs = quality["sources"]
    if not qs:
        dims.append({"key": "quality", "label": "Data quality", "score": 100, "detail": "No sources yet"})
    else:
        covered = sum(1 for q in qs if q["rules"] > 0)
        clean = sum(1 for q in qs if q["rules"] > 0 and q["failing"] == 0 and q["errors"] == 0)
        score = round(50 * covered / len(qs) + 50 * (clean / covered if covered else 0))
        dims.append({"key": "quality", "label": "Data quality", "score": score,
                     "detail": f"{covered} of {len(qs)} sources have checks · {quality['failing']} failing"})

    # 6. people & roles
    if scope.personal:
        dims.append({"key": "people", "label": "People & roles", "score": 100, "detail": "Just you"})
    else:
        admins = sum(1 for p in people if p["role"] in ("owner", "admin"))
        cutoff = datetime.utcnow() - timedelta(days=90)
        idle = sum(1 for p in people if not p["last_active"] or datetime.fromisoformat(p["last_active"].rstrip("Z")) < cutoff)
        score = (50 if admins >= 2 else 25) + round(50 * (len(people) - idle) / len(people))
        dims.append({"key": "people", "label": "People & roles", "score": min(100, score),
                     "detail": f"{admins} {'owner or admin' if admins == 1 else 'owners and admins'} · {idle} inactive for 90 days"})

    weights = {"access": 1.0, "sensitive": 1.4, "sharing": 1.4, "signin": 1.0, "quality": 0.8, "people": 0.6}
    total = sum(weights[d["key"]] for d in dims)
    overall = round(sum(d["score"] * weights[d["key"]] for d in dims) / total)
    grade = "Strong" if overall >= 85 else "Good" if overall >= 70 else "Needs work" if overall >= 50 else "At risk"
    return {"score": overall, "grade": grade, "dimensions": dims}


def risks(g: dict, access: list, sens: list, sharing: list, people: list, quality: dict) -> list[dict]:
    scope = g["scope"]
    out = []
    for s in sharing:
        if s["level"] in ("public", "domain_public") and s["sensitive_source"]:
            out.append({"id": f"public-sensitive:{s['dashboard_id']}", "severity": "high",
                        "title": f"“{s['dashboard']}” is open to anyone and is built on a source with personal data",
                        "detail": "Anyone with the link can open it without signing in. Share it with named people, publish it on the company domain instead, or stop publishing it.",
                        "actions": [{"type": "open_dashboard", "label": "Open sharing", "dashboard_id": s["dashboard_id"]},
                                    {"type": "unpublish", "label": "Stop publishing", "dashboard_id": s["dashboard_id"]}]})
    visible = [s for s in sens if not s["protected"]]
    by_ds: dict[str, list] = {}
    for s in visible:
        by_ds.setdefault(s["datasource_id"], []).append(s)
    for ds_id, cols in by_ds.items():
        names = ", ".join(c["column"] for c in cols[:4]) + (f" and {len(cols) - 4} more" if len(cols) > 4 else "")
        out.append({"id": f"sensitive:{ds_id}", "severity": "high",
                    "title": f"{cols[0]['datasource']}: {len(cols)} column{'s' if len(cols) != 1 else ''} with personal data are visible to the whole team",
                    "detail": f"{names}. Hide them from members and viewers, or mark them as not sensitive.",
                    "actions": [{"type": "hide_columns", "label": "Hide from members and viewers", "datasource_id": ds_id,
                                 "columns": [c["column"] for c in cols]},
                                {"type": "tab", "label": "Review", "tab": "sensitive"}]})
    for s in sharing:
        if s["level"] in ("public", "domain_public") and not s["sensitive_source"]:
            out.append({"id": f"public:{s['dashboard_id']}", "severity": "medium",
                        "title": f"“{s['dashboard']}” is open to anyone with the link",
                        "detail": "No sign-in is needed. That's fine for public numbers; otherwise share it with named people or on the company domain.",
                        "actions": [{"type": "open_dashboard", "label": "Open sharing", "dashboard_id": s["dashboard_id"]}]})
    team = [a for a in access if a["shared"]]
    never = [a for a in team if a["status"] == "never"]
    overdue = [a for a in team if a["status"] == "overdue"]
    if never or overdue:
        n = len(never) + len(overdue)
        out.append({"id": "review", "severity": "medium",
                    "title": f"{n} shared source{'s' if n != 1 else ''} {'have' if n != 1 else 'has'} not had who-can-see-it confirmed"
                             + (f" ({len(never)} never)" if never else ""),
                    "detail": f"Confirm each one every {g['rules_cfg']['review_every_days']} days: check the people, then mark it reviewed.",
                    "actions": [{"type": "tab", "label": "Start review", "tab": "access"}]})
    no_mfa = [p for p in people if not p["mfa"]]
    if no_mfa and not scope.personal:
        sev = "medium" if g["rules_cfg"]["require_mfa"] or len(no_mfa) == len(people) else "low"
        out.append({"id": "mfa", "severity": sev,
                    "title": f"{len(no_mfa)} of {len(people)} people sign in without 2-step",
                    "detail": ", ".join(p["name"] for p in no_mfa[:4]) + (" and more" if len(no_mfa) > 4 else "")
                              + (". The workspace requires it." if g["rules_cfg"]["require_mfa"] else ". Require it in Rules."),
                    "actions": ([] if g["rules_cfg"]["require_mfa"] else
                                [{"type": "set_policy", "label": "Require 2-step", "policy": "require_mfa", "value": True}])
                               + [{"type": "tab", "label": "See people", "tab": "access"}]})
    if quality["failing"]:
        out.append({"id": "quality", "severity": "medium",
                    "title": f"{quality['failing']} data quality check{'s' if quality['failing'] != 1 else ''} failing",
                    "detail": "Numbers built on those sources may be wrong until the data is fixed.",
                    "actions": [{"type": "tab", "label": "See checks", "tab": "quality"}]})
    without = [q for q in quality["sources"] if q["rules"] == 0]
    if without:
        out.append({"id": "quality-cover", "severity": "low",
                    "title": f"{len(without)} source{'s have' if len(without) != 1 else ' has'} no quality checks",
                    "detail": "A check (no empty values, numbers in range…) catches a broken import before a dashboard shows it.",
                    "actions": [{"type": "tab", "label": "See sources", "tab": "quality"}]})
    if not scope.personal:
        admins = [p for p in people if p["role"] in ("owner", "admin")]
        if len(admins) < 2 and len(people) > 1:
            out.append({"id": "admins", "severity": "low",
                        "title": "Only one person can manage this workspace",
                        "detail": "Make a second person an admin so access and the domain never depend on one account.",
                        "actions": [{"type": "tab", "label": "Choose an admin", "tab": "access"}]})
    order = {"high": 0, "medium": 1, "low": 2}
    out.sort(key=lambda r: order[r["severity"]])
    return out


def overview(db: Session, user: models.User, workspace_id: str | None) -> dict:
    g = gather(db, user, workspace_id)
    sens = _sensitive_out(g)
    sharing = _sharing_out(g, sens)
    access = _access_out(g, sens)
    people = _people_out(g)
    quality = _quality_out(g)
    score = posture(g, access, sens, sharing, people, quality)
    rk = risks(g, access, sens, sharing, people, quality)
    scope = g["scope"]
    audit_count = (db.query(models.AuditEvent).filter(models.AuditEvent.workspace_id == scope.ws.id).count()
                   if not scope.personal else
                   db.query(models.AuditEvent).filter(models.AuditEvent.actor_user_id == user.id).count())
    return {
        "workspace": {"id": scope.ws.id, "name": scope.ws.name, "personal": scope.personal, "role": scope.role,
                      "owner": scope.role == "owner"},
        "posture": score, "risks": rk, "access": access, "sensitive": sens, "sharing": sharing, "people": people,
        "quality": quality, "policies": g["rules_cfg"], "policy_labels": policies.LABELS,
        "review_choices": list(policies.REVIEW_CHOICES),
        "domain": ({"hostname": g["domain"].hostname, "status": g["domain"].status, "audience": g["domain"].audience}
                   if g["domain"] else None),
        "counts": {"sources": len(access), "audit_events": audit_count,
                   "high": sum(1 for r in rk if r["severity"] == "high"),
                   "medium": sum(1 for r in rk if r["severity"] == "medium"),
                   "low": sum(1 for r in rk if r["severity"] == "low")},
        "generated_at": iso(datetime.utcnow()),
    }


# ------------------------------------------------------------- audit log ----

ACTIONS: dict[str, tuple[str, str]] = {
    "login": ("Signed in", "Sign-in"), "signup": ("Created an account", "Sign-in"),
    "mfa_enabled": ("Turned on 2-step sign-in", "Sign-in"), "mfa_disabled": ("Turned off 2-step sign-in", "Sign-in"),
    "mfa_recovery_used": ("Signed in with a recovery code", "Sign-in"),
    "password_changed": ("Changed their password", "Sign-in"),
    "workspace_created": ("Created the workspace", "People"), "member_joined": ("Joined the workspace", "People"),
    "member_role_changed": ("Changed someone's role", "People"), "member_removed": ("Removed someone", "People"),
    "member_left": ("Left the workspace", "People"), "invite_link_reset": ("Made a new invite link", "People"),
    "workspace_deleted": ("Deleted the workspace", "People"), "workspace_renamed": ("Renamed the workspace", "People"),
    "workspace_brand_kit_updated": ("Changed the brand kit", "Settings"), "policy_changed": ("Changed a company rule", "Settings"),
    "datasource_connected": ("Connected a data source", "Data"), "datasource_deleted": ("Deleted a data source", "Data"),
    "datasource_reimported": ("Re-imported a data source", "Data"), "datasource_cleaning_applied": ("Cleaned a data source", "Data"),
    "data_transform_created": ("Added a data transform", "Data"), "data_transform_deleted": ("Removed a data transform", "Data"),
    "governance_review_marked": ("Confirmed who can see a source", "Access"),
    "access_rule_created": ("Added an access rule", "Access"), "access_rule_deleted": ("Removed an access rule", "Access"),
    "sensitive_columns_hidden": ("Hid sensitive columns", "Access"), "sensitive_column_dismissed": ("Marked a column not sensitive", "Access"),
    "sensitive_column_confirmed": ("Confirmed a column is sensitive", "Access"),
    "quality_rule_created": ("Added a quality check", "Quality"), "quality_rule_deleted": ("Removed a quality check", "Quality"),
    "dashboard_created": ("Created a dashboard", "Dashboards"), "dashboard_deleted": ("Deleted a dashboard", "Dashboards"),
    "dashboard_upgraded": ("Upgraded a dashboard", "Dashboards"),
    "dashboard_published": ("Published a dashboard link", "Sharing"), "dashboard_unpublished": ("Stopped publishing a dashboard", "Sharing"),
    "dashboard_share_email_added": ("Gave someone access to a private link", "Sharing"),
    "dashboard_share_email_removed": ("Removed someone from a private link", "Sharing"),
    "dashboard_custom_domain_set": ("Put a dashboard on its own domain", "Sharing"),
    "dashboard_custom_domain_removed": ("Removed a dashboard's own domain", "Sharing"),
    "dashboard_moved_to_workspace": ("Shared a dashboard with the team", "Sharing"),
    "domain_added": ("Added the company domain", "Domain"), "domain_removed": ("Removed the company domain", "Domain"),
    "domain_live": ("The company domain went live", "Domain"), "domain_settings_changed": ("Changed who can open the domain", "Domain"),
    "domain_published": ("Published to the company domain", "Domain"), "domain_unpublished": ("Took a dashboard off the domain", "Domain"),
    "domain_publish_requested": ("Asked to publish to the company domain", "Domain"),
    "domain_publish_approved": ("Approved a publish request", "Domain"), "domain_publish_declined": ("Declined a publish request", "Domain"),
    "domain_access_requested": ("Asked to open a dashboard on the domain", "Domain"),
    "domain_access_approved": ("Gave someone access on the domain", "Domain"), "domain_access_declined": ("Declined access on the domain", "Domain"),
    "pipeline_created": ("Created a chain", "Automations"), "pipeline_updated": ("Changed a chain", "Automations"),
    "pipeline_deleted": ("Deleted a chain", "Automations"), "schedule_changed": ("Changed how often something runs", "Automations"),
    "automation_created": ("Created an automation", "Automations"), "automation_updated": ("Changed an automation", "Automations"),
    "automation_deleted": ("Deleted an automation", "Automations"), "automation_approved": ("Approved an automation", "Automations"),
    "automation_rejected": ("Turned down an automation", "Automations"),
    "metric_definition_created": ("Defined a metric", "Data"), "metric_definition_updated": ("Changed a metric", "Data"),
    "metric_definition_deleted": ("Removed a metric", "Data"),
    "ml_model_created": ("Trained a model", "Data"), "ml_model_deleted": ("Deleted a model", "Data"),
    "gtm.contact_export": ("Exported a person's data", "Privacy"), "gtm.contact_erase": ("Erased a person's data", "Privacy"),
    "privacy_lookup": ("Looked up a person's data", "Privacy"), "evidence_exported": ("Downloaded the evidence pack", "Trust"),
    "audit_exported": ("Downloaded the audit log", "Trust"),
}


def action_label(action: str) -> tuple[str, str]:
    if action in ACTIONS:
        return ACTIONS[action]
    if action.startswith("gtm."):
        return (action[4:].replace("_", " ").capitalize(), "Initiatives")
    if action.startswith("initiative."):
        return ("Initiative: " + action.split(".", 1)[1].replace("_", " "), "Initiatives")
    return (action.replace("_", " ").capitalize(), "Other")


def audit_query(db: Session, scope: Scope, category: str | None = None, actor_id: str | None = None,
                q: str | None = None, days: int | None = None):
    query = db.query(models.AuditEvent)
    if scope.personal:
        query = query.filter((models.AuditEvent.workspace_id == scope.ws.id) |
                             ((models.AuditEvent.workspace_id.is_(None)) & (models.AuditEvent.actor_user_id == scope.user.id)))
    else:
        query = query.filter(models.AuditEvent.workspace_id == scope.ws.id)
    if actor_id:
        query = query.filter(models.AuditEvent.actor_user_id == actor_id)
    if days:
        query = query.filter(models.AuditEvent.created_at >= datetime.utcnow() - timedelta(days=days))
    if category:
        acts = [a for a, (_, c) in ACTIONS.items() if c == category]
        if category == "Initiatives":
            query = query.filter(models.AuditEvent.action.like("initiative.%") | models.AuditEvent.action.like("gtm.%"))
        else:
            query = query.filter(models.AuditEvent.action.in_(acts or ["__none__"]))
    if q:
        like = f"%{q.lower()}%"
        from sqlalchemy import func, cast, String
        query = query.filter(func.lower(models.AuditEvent.action).like(like) |
                             func.lower(cast(models.AuditEvent.event_metadata, String)).like(like))
    return query.order_by(models.AuditEvent.created_at.desc())


def _describe(meta: dict | None) -> str:
    if not isinstance(meta, dict):
        return ""
    for k in ("name", "dashboard", "datasource", "path", "hostname", "email", "column_name", "role", "interval"):
        v = meta.get(k)
        if v:
            return f"{k.replace('_', ' ')}: {v}" if k in ("role", "interval", "column_name") else str(v)
    if meta.get("items"):
        return ", ".join(map(str, meta["items"]))[:200]
    return ""


def audit_rows(db: Session, events: list[models.AuditEvent]) -> list[dict]:
    ids = {e.actor_user_id for e in events if e.actor_user_id}
    users = {u.id: u for u in db.query(models.User).filter(models.User.id.in_(ids)).all()} if ids else {}
    out = []
    for e in events:
        label, cat = action_label(e.action)
        u = users.get(e.actor_user_id)
        out.append({"id": e.id, "at": iso(e.created_at), "action": e.action, "label": label, "category": cat,
                    "actor": (u.full_name or u.email) if u else "GD360", "actor_email": u.email if u else None,
                    "target_type": e.target_type, "target_id": e.target_id, "what": _describe(e.event_metadata),
                    "metadata": e.event_metadata or {}})
    return out


def audit_csv(rows: list[dict]) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["When (UTC)", "Who", "Email", "What", "Category", "Detail", "Target type", "Target id"])
    for r in rows:
        w.writerow([r["at"], r["actor"], r["actor_email"] or "", r["label"], r["category"], r["what"],
                    r["target_type"] or "", r["target_id"] or ""])
    return buf.getvalue()


# ------------------------------------------------------- evidence pack ----

def evidence_zip(db: Session, user: models.User, workspace_id: str | None) -> bytes:
    data = overview(db, user, workspace_id)
    scope = Scope(db, user, workspace_id)
    events = audit_query(db, scope, days=365).limit(20000).all()
    rows = audit_rows(db, events)

    def table(headers, rows_):
        b = io.StringIO()
        w = csv.writer(b)
        w.writerow(headers)
        for r in rows_:
            w.writerow(r)
        return b.getvalue()

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        p = data["posture"]
        z.writestr("README.txt", (
            f"GD360 Trust Center evidence pack\nWorkspace: {data['workspace']['name']}\n"
            f"Generated: {data['generated_at']} by {user.email}\n\n"
            f"Posture: {p['score']}/100 ({p['grade']})\n"
            + "".join(f"  - {d['label']}: {d['score']} ({d['detail']})\n" for d in p["dimensions"])
            + f"\nRisks: {data['counts']['high']} high, {data['counts']['medium']} medium, {data['counts']['low']} low\n\n"
            "Files:\n  posture.csv, risks.csv, access_review.csv, people.csv, sensitive_columns.csv,\n"
            "  sharing.csv, data_quality.csv, policies.json, audit_log.csv (last 365 days)\n"))
        z.writestr("posture.csv", table(["Part", "Score", "Detail"], [[d["label"], d["score"], d["detail"]] for d in p["dimensions"]]))
        z.writestr("risks.csv", table(["Severity", "Risk", "Detail"], [[r["severity"], r["title"], r["detail"]] for r in data["risks"]]))
        z.writestr("access_review.csv", table(
            ["Source", "Kind", "Owner", "Shared with team", "People with access", "Last confirmed", "Confirmed by", "Status"],
            [[a["name"], a["kind"], a["owner"], "yes" if a["shared"] else "no", len(a["who"]), a["reviewed_at"] or "never",
              a["reviewed_by"] or "", a["status"]] for a in data["access"]]))
        z.writestr("people.csv", table(["Name", "Email", "Role", "2-step sign-in", "Last active", "Joined"],
                                       [[x["name"], x["email"], x["role"], "on" if x["mfa"] else "off", x["last_active"] or "",
                                         x["joined_at"] or ""] for x in data["people"]]))
        z.writestr("sensitive_columns.csv", table(["Source", "Table", "Column", "Category", "Found by", "Decision", "Protection"],
                                                  [[s["datasource"], s["table"] or "", s["column"], s["category_label"], s["reason"] or "",
                                                    s["status"], s["state"]] for s in data["sensitive"]]))
        z.writestr("sharing.csv", table(["Dashboard", "Where", "Who can open", "Password", "Views", "Published", "Built on personal data"],
                                        [[s["dashboard"], s["address"], s["level"], "yes" if s["password"] else "no", s["views"],
                                          s["published_at"] or "", "yes" if s["sensitive_source"] else "no"] for s in data["sharing"]]))
        z.writestr("data_quality.csv", table(["Source", "Checks", "Passing", "Failing", "Errors", "Last run"],
                                             [[q["name"], q["rules"], q["passing"], q["failing"], q["errors"], q["last_run_at"] or ""]
                                              for q in data["quality"]["sources"]]))
        z.writestr("policies.json", json.dumps({k: data["policies"][k] for k in data["policies"]}, indent=2))
        z.writestr("audit_log.csv", audit_csv(rows))
    return buf.getvalue()


__all__ = ["overview", "scan_source", "audit_query", "audit_rows", "audit_csv", "evidence_zip", "ScopeError",
           "name_category", "value_category", "action_label", "workspace_access"]
