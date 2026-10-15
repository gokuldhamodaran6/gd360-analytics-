"""2026-10-14 (R47): the Team tool - "create a Retention team with Priya and Ravi; they can use
Shopify and Stripe but not emails or card numbers; Ravi only sees India".

A team is a Space (the room: its sources, its library) plus data rules on those
sources (services/data_access_rules.py: hidden columns, allowed row values, per
workspace role). The sentence is read into a draft (model or rules), every name is
resolved against the real workspace members and sources, and a confirm card shows
exactly what will be created. Nothing is created until the person confirms.

Honest limits of today's rule engine, stated on the card: rules apply per workspace
ROLE (member / viewer), not per named person, and a hidden column is hidden, not masked.
"""
from __future__ import annotations

import json
import re

from sqlalchemy.orm import Session

from ... import models, schemas
from .. import ai_engine

TEAM = re.compile(
    r"\b(create|make|set ?up|start|add|build)\b.{0,40}\b(team|space|group|room)\b"
    r"|\b(give|grant|allow)\b.{0,30}\baccess\b.{0,30}\b(to|for)\b"
    r"|\b(hide|mask|restrict|block)\b.{0,30}\b(column|columns|emails?|phones?|card numbers?|salar(y|ies)|ssn|pan|aadhaar)\b"
    r"|\bonly sees?\b|\bcan only see\b", re.I)

_SYSTEM = (
    "GD360 TEAM DRAFTER. Read the sentence into a team draft. Reply with JSON only:\n"
    '{"name": "<team name>", "members": ["<person names or emails>"], "sources": ["<data source names mentioned>"], '
    '"hidden_columns": ["<column words to hide, e.g. email, card_number>"], '
    '"row_rules": [{"column": "<column>", "values": ["<allowed value>"], "who": "<person or everyone>"}], '
    '"can_act": true|false, "note": "<anything you could not map, else empty>"}'
)

_HIDE_WORDS = {"email": ["email", "e_mail", "mail"], "phone": ["phone", "mobile", "tel"], "card": ["card", "card_number", "cc"],
               "salary": ["salary", "pay", "wage"], "address": ["address", "street"], "name": ["name"], "ssn": ["ssn"], "pan": ["pan"],
               "aadhaar": ["aadhaar", "aadhar"], "dob": ["dob", "birth"]}


def wants_team(text: str) -> bool:
    return bool(TEAM.search(text or ""))


def _model_draft(text: str) -> dict:
    raw = ai_engine._call_llm_resilient([{"role": "system", "content": _SYSTEM}, {"role": "user", "content": text}], max_tokens=400)
    m = re.search(r"\{.*\}", raw or "", re.S)
    return json.loads(m.group(0)) if m else {}


def _rule_draft(text: str) -> dict:
    t = text.strip()
    d: dict = {"name": "", "members": [], "sources": [], "hidden_columns": [], "row_rules": [], "note": ""}
    m = re.search(r"\b(?:create|make|set ?up|start|build)\s+(?:a |an |the )?(?:new )?([A-Z][\w&' -]{1,40}?)\s+(?:team|space|group)\b", t)
    if m:
        d["name"] = m.group(1).strip()
    m = re.search(r"\bwith\s+(.+?)(?:\.|,? (?:they|who|that|which) |$)", t, re.I)
    if m:
        d["members"] = [x.strip() for x in re.split(r",|\band\b", m.group(1)) if x.strip() and not re.search(r"\b(data|source|access)\b", x, re.I)]
    m = re.search(r"\b(?:can )?(?:use|see|access)\s+(.+?)\s+(?:data|sources?|but|and nothing|$)", t, re.I)
    if m:
        d["sources"] = [x.strip() for x in re.split(r",|\band\b", m.group(1)) if x.strip()]
    m = re.search(r"\b(?:but )?not\s+(.+?)(?:\.|;|$)", t, re.I)
    if m:
        d["hidden_columns"] = [x.strip() for x in re.split(r",|\bor\b|\band\b", m.group(1)) if x.strip()]
    for who, col_val in re.findall(r"\b([A-Z][a-z]+)\s+(?:only sees?|can only see)\s+(.+?)(?:\.|;|$)", t):
        d["row_rules"].append({"column": "", "values": [col_val.strip()], "who": who})
    return d


def _match(name: str, candidates: list[tuple[str, str]]) -> str | None:
    """candidates: [(id, label)]; returns the id whose label shares the most words with name."""
    words = [w for w in re.findall(r"[a-z0-9]+", (name or "").lower()) if len(w) > 1]
    best, score = None, 0
    for cid, label in candidates:
        lab = (label or "").lower()
        s = sum(1 for w in words if w in lab)
        if s > score:
            best, score = cid, s
    return best if score else None


def _columns_of(ds: models.DataSource) -> list[str]:
    sc = ds.schema_cache if isinstance(ds.schema_cache, dict) else {}
    cols: list[str] = []
    for spec in sc.values():
        if isinstance(spec, dict):
            for c in spec.get("columns") or []:
                cols.append(str(c.get("name") if isinstance(c, dict) else c))
        elif isinstance(spec, list):
            cols += [str(c.get("name") if isinstance(c, dict) else c) for c in spec]
    return cols


def draft(db: Session, user: models.User, text: str, *, workspace_id: str | None, use_model: bool = True) -> dict:
    from ..project_engine.catalog import accessible_sources
    d: dict = {}
    if use_model:
        try:
            d = _model_draft(text)
        except Exception as e:  # noqa: BLE001
            print(f"[agent.team] model draft skipped: {e}")
    if not d.get("name") and not d.get("members") and not d.get("sources"):
        d = _rule_draft(text)
    issues: list[str] = []
    # members
    members_out, to_invite = [], []
    ws = db.get(models.Workspace, workspace_id) if workspace_id else None
    if ws is None:
        ws = db.query(models.Workspace).join(models.WorkspaceMember, models.WorkspaceMember.workspace_id == models.Workspace.id)\
            .filter(models.WorkspaceMember.user_id == user.id, models.Workspace.is_personal.is_(False)).first()
    people = []
    if ws is not None:
        rows = (db.query(models.WorkspaceMember, models.User).join(models.User, models.User.id == models.WorkspaceMember.user_id)
                .filter(models.WorkspaceMember.workspace_id == ws.id).all())
        people = [(u.id, f"{u.full_name or ''} {u.email or ''}", u, m.role) for m, u in rows]
    for name in d.get("members") or []:
        uid = _match(str(name), [(p[0], p[1]) for p in people])
        if uid:
            p = next(p for p in people if p[0] == uid)
            members_out.append({"user_id": uid, "name": p[2].full_name or p[2].email, "role": p[3]})
        else:
            to_invite.append(str(name))
    # sources
    sources_out = []
    all_sources = accessible_sources(db, user, ws.id if ws else None)
    for sname in d.get("sources") or []:
        sid = _match(str(sname), [(s.id, s.name or "") for s in all_sources])
        if sid:
            ds = next(s for s in all_sources if s.id == sid)
            sources_out.append({"id": ds.id, "name": ds.name, "kind": ds.kind})
        else:
            issues.append(f"I couldn't find a data source called “{sname}”.")
    if not sources_out and not (d.get("sources")):
        sources_out = [{"id": s.id, "name": s.name, "kind": s.kind} for s in all_sources[:3]]
    # hidden columns: resolve words to real column names on each chosen source
    hidden_out = []
    for ds_ref in sources_out:
        ds = db.get(models.DataSource, ds_ref["id"])
        cols = _columns_of(ds) if ds else []
        for want in d.get("hidden_columns") or []:
            w = str(want).lower()
            keys = [k for k, alts in _HIDE_WORDS.items() if any(a in w for a in alts)] or [re.sub(r"[^a-z0-9]+", "_", w)]
            for c in cols:
                cl = c.lower()
                if any(k in cl for k in keys) or any(a in cl for k in keys for a in _HIDE_WORDS.get(k, [])):
                    if not any(h["column"] == c and h["source_id"] == ds.id for h in hidden_out):
                        hidden_out.append({"source_id": ds.id, "source": ds.name, "column": c})
    if d.get("hidden_columns") and not hidden_out:
        issues.append("None of the chosen sources has a column matching " + ", ".join(map(str, d["hidden_columns"])) + ".")
    # row rules: find the column that holds the value
    rows_out = []
    for rr in d.get("row_rules") or []:
        vals = [str(v) for v in (rr.get("values") or []) if str(v).strip()]
        col = str(rr.get("column") or "")
        for ds_ref in sources_out:
            ds = db.get(models.DataSource, ds_ref["id"])
            cols = _columns_of(ds) if ds else []
            pick = next((c for c in cols if col and c.lower() == col.lower()), None)
            if not pick:
                pick = next((c for c in cols if re.search(r"region|country|state|city|market|territory|area|zone", c, re.I)), None)
            if pick and vals:
                rows_out.append({"source_id": ds.id, "source": ds.name, "column": pick, "values": vals, "who": str(rr.get("who") or "viewers"), "role": "viewer"})
                break
    name = (d.get("name") or "").strip() or "New team"
    body = {"name": name[:60], "access": "members" if members_out else "workspace" if ws else "private",
            "member_ids": [m["user_id"] for m in members_out], "source_ids": [s["id"] for s in sources_out], "workspace_id": ws.id if ws else None,
            "hidden": hidden_out, "rows": rows_out}
    if not sources_out:
        issues.append("Connect a data source first; a team needs data to work on.")
    invite = f"/invite/{ws.invite_token}" if (ws is not None and getattr(ws, 'invite_token', None) and to_invite) else None
    return {"ok": not issues, "body": body, "members": members_out, "to_invite": to_invite, "invite_link": invite, "sources": sources_out,
            "hidden": hidden_out, "rows": rows_out, "issues": issues, "note": str(d.get("note") or "").strip() or None,
            "limits": ["Rules apply to everyone with the member or viewer role on a source, not to one named person.",
                       "A hidden column is removed from every answer and dashboard for those roles; it is not masked."]}


def create(db: Session, user: models.User, body: dict) -> dict:
    from ...routers import data_access_rules as rules_router
    from ...routers import spaces as spaces_router
    space = spaces_router.create_space(spaces_router.CreateSpaceRequest(
        name=body["name"], access=body.get("access") or "private", member_ids=body.get("member_ids") or [],
        source_ids=body.get("source_ids") or [], workspace_id=body.get("workspace_id")), db=db, user=user)
    made, skipped = [], []
    for h in body.get("hidden") or []:
        for role in ("member", "viewer"):
            try:
                rules_router.create_access_rule(h["source_id"], schemas.CreateAccessRuleRequest(role=role, kind="column", column_name=h["column"]), db=db, user=user)
                made.append(f"hide {h['column']} on {h['source']} for {role}s")
            except Exception as e:  # noqa: BLE001 - a duplicate or a source the person does not own
                skipped.append(f"{h['column']} on {h['source']} ({getattr(e, 'detail', str(e))[:80]})")
    for r in body.get("rows") or []:
        try:
            rules_router.create_access_rule(r["source_id"], schemas.CreateAccessRuleRequest(role=r.get("role") or "viewer", kind="row",
                                                                                           column_name=r["column"], allowed_values=r["values"]), db=db, user=user)
            made.append(f"{r['column']} limited to {', '.join(r['values'])} on {r['source']} for viewers")
        except Exception as e:  # noqa: BLE001
            skipped.append(f"{r['column']} on {r['source']} ({getattr(e, 'detail', str(e))[:80]})")
    sid = space.get("id") if isinstance(space, dict) else getattr(space, "id", None)
    return {"space_id": sid, "name": body["name"], "rules_made": made, "rules_skipped": skipped, "url": f"/spaces/{sid}"}
