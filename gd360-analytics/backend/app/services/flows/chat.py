"""Plain-word edits from the thread: 'run it at 7', 'hold if more than 100
rows look odd', 'send the odd rows to Sara', 'test it', 'turn it on'.

Rules first (exact and predictable); the language model is only asked when
no rule matches, and only for the same small set of edits."""
from __future__ import annotations

import copy
import json
import re

from sqlalchemy.orm import Session

from ... import models
from .plan import add_minutes, parse_days, parse_hold, parse_time
from .profile import slug

HELP = ("I can change when it runs (“every day at 7”), the safety limit (“hold if more than 100 rows look odd”), "
        "who gets the odd rows (“send them to Sara”), the table name (“save it as orders_clean”), or test, run, "
        "turn on and pause it. For bigger changes, edit the plan on the right.")


def _people(db: Session, flow: models.DataFlow) -> list[models.User]:
    ids = {flow.owner_id}
    if flow.workspace_id:
        ids |= {r[0] for r in db.query(models.WorkspaceMember.user_id)
                .filter(models.WorkspaceMember.workspace_id == flow.workspace_id).all()}
    return db.query(models.User).filter(models.User.id.in_(ids)).all()


def _match_person(db: Session, flow: models.DataFlow, name: str) -> models.User | None:
    n = name.strip().lower()
    if n in ("me", "myself"):
        return None
    for u in _people(db, flow):
        full = (u.full_name or "").lower()
        first = full.split(" ")[0] if full else ""
        if n and (n == full or n == first or n == (u.email or "").lower() or n == (u.email or "").split("@")[0].lower()):
            return u
    return None


def _llm_edit(text: str, spec: dict) -> dict | None:
    try:
        from ..ai_engine import _call_llm_resilient, _extract_json
    except Exception:  # noqa: BLE001
        return None
    system = (
        "GD360 FLOW EDITOR. A person is editing a scheduled data flow. Reply ONLY with JSON: "
        '{"reply": "<one short sentence>", "time": "HH:MM"|null, "hold_above": int|null, '
        '"weekdays_only": true|false|null, "on_change": true|false|null, "name": str|null, "output_name": str|null}. '
        "Use null for anything the person did not ask to change. Never invent other fields."
    )
    user = json.dumps({"request": text, "schedule": spec.get("schedule"), "policy": {"hold_above": spec.get("policy", {}).get("hold_above")},
                       "output": spec.get("output")})
    try:
        raw = _call_llm_resilient([{"role": "system", "content": system}, {"role": "user", "content": user}], max_tokens=300)
        data = _extract_json(raw) if raw else None
        return data if isinstance(data, dict) else None
    except Exception:  # noqa: BLE001
        return None


def handle(db: Session, flow: models.DataFlow, text: str) -> dict:
    """Returns {"reply", "spec" (new spec or None), "note", "action": test|run|enable|disable|None, "name"}."""
    low = (text or "").lower().strip()
    spec = copy.deepcopy(flow.spec or {})
    replies: list[str] = []
    notes: list[str] = []
    action = None
    new_name = None
    changed = False
    sch = spec.setdefault("schedule", {})
    pol = spec.setdefault("policy", {})

    t = parse_time(text)
    if t and t != sch.get("time"):
        sch["time"] = t
        for c in spec.get("checks") or []:
            if c.get("kind") == "ready_by":
                c["time"] = add_minutes(t, 30)
        changed = True
        replies.append(f"It will run at {t} ({sch.get('timezone', 'UTC')}).")
        notes.append(f"Runs at {t}")
    d = parse_days(text)
    if d and d != sch.get("days"):
        sch["days"] = d
        changed = True
        replies.append("Only on weekdays (Monday to Friday).")
        notes.append("Weekdays only")
    elif re.search(r"\bevery day\b|\bdaily\b|\bweekends? too\b", low) and sch.get("days") != list(range(7)) and not d:
        sch["days"] = list(range(7))
        changed = True
        replies.append("Every day, weekends included.")
        notes.append("Every day")
    h = parse_hold(text)
    if h is not None and h != pol.get("hold_above"):
        pol["hold_above"] = h
        changed = True
        replies.append(f"If more than {h} rows look odd, it won’t update anything and will tell you.")
        notes.append(f"Hold above {h} rows")
    if re.search(r"(when|if) (the |a |any )?(sheet|source|data|file)s? (is )?(changes?|edited|updated)|on change", low):
        if not sch.get("on_change"):
            sch["on_change"] = True
            changed = True
        replies.append("It also runs when a source changes (checked every 10 minutes).")
    if re.search(r"only on (the )?schedule|(don.?t|do not) run (it )?(when|on) change", low):
        sch["on_change"] = False
        changed = True
        replies.append("It will only run on its schedule.")
        notes.append("Schedule only")
    m = re.search(r"(?:send|give|share|email|forward)\s+(?:the\s+|them\s+|those\s+|it\s+)?(?:odd\s+|flagged\s+)?(?:rows?\s+|list\s+)?(?:to|with)\s+([a-z][\w.@\- ]{1,40}?)(?:[.,;!]|$| and | if | every )", low + " ")
    if m:
        u = _match_person(db, flow, m.group(1))
        if u:
            if u.id not in pol.setdefault("flag_to", []):
                pol["flag_to"] = pol["flag_to"] + [u.id]
                changed = True
            replies.append(f"Rows that look odd go to {u.full_name or u.email}.")
            notes.append(f"Odd rows to {u.full_name or u.email}")
        else:
            replies.append(f"I couldn’t find “{m.group(1).strip()}” in this workspace - invite them first, or pick someone in Settings on the right.")
    m = re.search(r"(?:tell|alert|notify|warn)\s+([a-z][\w.@\-]{1,30})\b", low)
    if m and m.group(1) not in ("me", "us", "them", "everyone"):
        u = _match_person(db, flow, m.group(1))
        if u and u.id not in pol.setdefault("alert_to", []):
            pol["alert_to"] = pol["alert_to"] + [u.id]
            changed = True
            replies.append(f"{u.full_name or u.email} will be told if a run is held.")
            notes.append(f"Alerts to {u.full_name or u.email}")
    if re.search(r"(no|stop|don.?t send)( the)? (daily|morning) (message|summary|note)", low):
        pol["daily_summary"] = False
        changed = True
        replies.append("No daily message - you’ll only hear about problems.")
        notes.append("No daily message")
    m = re.search(r"(?:save (?:it )?as|call the table|name the table)\s+[\"“']?([\w\- ]{2,60})", low)
    if m:
        spec.setdefault("output", {})["name"] = slug(m.group(1))
        changed = True
        replies.append(f"The table will be saved as {spec['output']['name']}.")
        notes.append(f"Saved as {spec['output']['name']}")
    m = re.search(r"(?:call it|rename (?:it|the flow) to|name it)\s+[\"“']?(.{2,80}?)[\"”']?$", text.strip(), re.IGNORECASE)
    if m and not re.search(r"call the table", low):
        new_name = m.group(1).strip()
        replies.append(f"Renamed to “{new_name}”.")
    if re.search(r"\b(test|try) (it|this|again|once)\b|^test\b|dry run|looks good\.? test", low):
        action = "test"
    if re.search(r"\b(turn (it )?on|go live|switch (it )?on|start it|enable it|schedule it)\b|\brun it every\b|\bevery (day|morning) at\b", low):
        action = "enable" if action is None else action
        if action == "test":
            action = "test"
    if re.search(r"\b(pause|turn (it )?off|stop it|disable)\b", low):
        action = "disable"
    if re.search(r"\brun (it )?(now|again)\b|\bre-?run\b", low):
        action = "run"
    if not replies and action is None and new_name is None:
        data = _llm_edit(text, spec)
        if data:
            if isinstance(data.get("time"), str) and re.match(r"^\d{1,2}:\d{2}$", data["time"]):
                sch["time"] = data["time"]
                changed = True
                notes.append(f"Runs at {data['time']}")
            if isinstance(data.get("hold_above"), int) and data["hold_above"] >= 0:
                pol["hold_above"] = data["hold_above"]
                changed = True
                notes.append(f"Hold above {data['hold_above']} rows")
            if data.get("weekdays_only") is True:
                sch["days"] = [0, 1, 2, 3, 4]
                changed = True
            if isinstance(data.get("on_change"), bool):
                sch["on_change"] = data["on_change"]
                changed = True
            if isinstance(data.get("output_name"), str) and data["output_name"].strip():
                spec.setdefault("output", {})["name"] = slug(data["output_name"])
                changed = True
            if isinstance(data.get("name"), str) and data["name"].strip():
                new_name = data["name"].strip()[:80]
            if changed or new_name:
                replies.append(str(data.get("reply") or "Done.")[:300])
    if not replies and action is None and new_name is None:
        return {"reply": HELP, "spec": None, "note": None, "action": None, "name": None}
    return {"reply": " ".join(replies), "spec": spec if changed else None, "note": "; ".join(notes) or None,
            "action": action, "name": new_name}
