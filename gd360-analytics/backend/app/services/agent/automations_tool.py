"""2026-10-14 (R46): the Automation tool - "alert me if churn goes above 3%",
"every Monday send me revenue by region" - from one sentence to a confirm card.

The sentence is read into a draft by the model (GD360 AUTOMATION DRAFTER), the
draft is mapped onto the real Automation body (services/automations.py owns the
rules), validated with svc.validate, and shown as the sentence GD360 will act on:
WHEN -> DO -> TELL. Nothing is saved until the person confirms.
"""
from __future__ import annotations

import json
import re

from sqlalchemy.orm import Session

from ... import models
from .. import ai_engine
from .. import automations as svc

_SYSTEM = (
    "Euliv AUTOMATION DRAFTER. Turn the person's sentence into an automation draft. Reply with JSON only:\n"
    '{"name": "<up to 8 words>", "kind": "threshold" | "schedule", '
    '"every": "hour"|"day"|"week"|"month" (schedule or the check frequency), "time": "HH:MM", "days": [0..6 Mon=0], '
    '"op": "below"|"above"|"drops_by"|"rises_by", "value": <number>, "kpi_hint": "<the number watched, in the person\'s words>", '
    '"channels": ["in_app", "email", "slack"], "note": "<anything you could not map, else empty>"}\n'
    "A percentage in the sentence is the number itself (3% -> 3). If the sentence has no frequency, a threshold is "
    "checked every hour and a schedule runs daily at 08:00."
)


def _model_draft(text: str) -> dict:
    raw = ai_engine._call_llm_resilient([{"role": "system", "content": _SYSTEM}, {"role": "user", "content": text}], max_tokens=300)
    m = re.search(r"\{.*\}", raw or "", re.S)
    return json.loads(m.group(0)) if m else {}


def _rule_draft(text: str) -> dict:
    """A draft without the model, for the common shapes."""
    t = text.lower()
    d: dict = {"name": text.strip()[:60], "channels": ["in_app"]}
    if "email" in t or "mail me" in t:
        d["channels"].append("email")
    if "slack" in t:
        d["channels"].append("slack")
    m = re.search(r"\b(below|above|under|over|drops? by|falls? by|rises? by|exceeds?|pass(?:es)?|cross(?:es)?|tops?|reach(?:es)?|hits?|goes over|goes above)\b"
                  r"\s*(?:by\s*)?([-$€£₹]?\s*[\d.,]+)\s*(%|percent)?", t)
    if m:
        op = {"below": "below", "under": "below", "above": "above", "over": "above", "exceed": "above", "exceeds": "above"}.get(m.group(1), None)
        if re.match(r"pass|cross|top|reach|hit|goes", m.group(1)):
            op = "above"
        if m.group(1).startswith(("drop", "fall")):
            op = "drops_by"
        elif m.group(1).startswith("rise"):
            op = "rises_by"
        d.update({"kind": "threshold", "op": op or "below", "value": float(re.sub(r"[^\d.]", "", m.group(2)) or 0), "every": "hour"})
        hint = re.search(r"\b(?:if|when|whenever)\s+(.+?)\s+(?:drops?|falls?|rises?|goes|gets|crosses|exceeds?|passes|tops|reaches|hits|is)\b", t)
        d["kpi_hint"] = (hint.group(1) if hint else "").strip()
        return d
    d["kind"] = "schedule"
    day_names = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
    days = [i for i, n in enumerate(day_names) if n in t]
    if days:
        d.update({"every": "week", "days": days})
    elif "every hour" in t or "hourly" in t:
        d["every"] = "hour"
    elif "month" in t:
        d["every"] = "month"
    else:
        d["every"] = "day"
    tm = re.search(r"\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b", t)
    if tm:
        h = int(tm.group(1)) % 12 + (12 if tm.group(3) == "pm" else 0)
        d["time"] = f"{h:02d}:{int(tm.group(2) or 0):02d}"
    else:
        d["time"] = "08:00"
    return d


def _pick_kpi(kpis: list[dict], hint: str) -> dict | None:
    if not kpis:
        return None
    words = [w for w in re.findall(r"[a-z0-9]+", (hint or "").lower()) if len(w) > 2]
    best, score = None, -1
    for k in kpis:
        label = str(k.get("label") or "").lower()
        s = sum(1 for w in words if w in label)
        if s > score:
            best, score = k, s
    return best if score > 0 else kpis[0]


_FREQ = re.compile(r"\b(every|each|hourly|daily|weekly|monthly|morning|evening|monday|tuesday|wednesday|thursday|friday|saturday|sunday|"
                   r"\d{1,2}(:\d{2})?\s*(am|pm))\b", re.I)


def _segments_trigger(d: dict, text: str, target: dict) -> dict:
    """R50: a segment alert is checked once a day at 08:00 unless the sentence says otherwise (it reads the whole table)."""
    every = d.get("every") if d.get("every") in svc.EVERY else None
    if not _FREQ.search(text or ""):
        every = "day"
    every = every or "day"
    check = {"every": every, "minute": 0} if every == "hour" else {"every": every, "time": d.get("time") or "08:00"}
    if every in ("day", "week"):
        check["days"] = d.get("days") or ([0] if every == "week" else list(range(7)))
    value = d.get("value")
    return {"type": "threshold", "target": dict(target), "kpi": "worst_segment_rate", "op": d.get("op") if d.get("op") in ("above", "below") else "above",
            "value": value, "check": check}


def first_check_for(db: Session, user: models.User, trigger: dict) -> dict | None:
    """R50: what the alert would say right now - "1 segment is already above 25%: Platinum ..." - shown on the card."""
    target = trigger.get("target") or {}
    try:
        if target.get("kind") == "segments":
            from . import segment_watch
            return segment_watch.first_check(db, user, target, float(trigger.get("value") or 0))
        kpis = svc.target_kpis(db, user, target)
        kpi = next((k for k in kpis if k.get("key") == trigger.get("kpi")), None)
        if not kpi:
            return None
        met, shown = svc.condition_met(trigger, kpi)
        if met is None:
            return None
        return {"text": f"{kpi.get('label')} is {shown} now" + (" - already past the line, so the first check would alert" if met else " - not past the line yet")}
    except Exception as e:  # noqa: BLE001 - the card still works without it
        print(f"[agent.automations] first check skipped: {e}")
        return None


def draft(db: Session, user: models.User, text: str, *, last_run: models.ProjectRun | None, dashboards: list[dict],
          timezone: str = "UTC", workspace_id: str | None = None, use_model: bool = True, segments_target: dict | None = None) -> dict:
    """{ok, body, sentence{when,do,tell}, issues[], needs[]}: a body ready for POST /automations when ok."""
    from . import segment_watch
    d: dict = {}
    if use_model:
        try:
            d = _model_draft(text)
        except Exception as e:  # noqa: BLE001 - the rules still produce a draft
            print(f"[agent.automations] model draft skipped: {e}")
    if not d.get("kind"):
        d = _rule_draft(text)
    if d.get("kind") != "threshold" and segments_target and re.search(r"%|\bpercent\b", text or "") and _rule_draft(text).get("kind") == "threshold":
        d = {**_rule_draft(text), **{k: v for k, v in d.items() if k in ("name", "channels", "every", "time", "days")}, "kind": "threshold"}
    segment_alert = d.get("kind") == "threshold" and segments_target is not None and (segment_watch.wants_segments(text) or last_run is None)
    issues: list[str] = []
    needs: list[str] = []
    body: dict = {"name": str(d.get("name") or text.strip()[:60])[:80], "enabled": True, "timezone": timezone,
                  "stop_on_quality_fail": True, "workspace_id": workspace_id}
    channels = set(d.get("channels") or ["in_app"])
    if d.get("kind") == "threshold" and user.email and svc.email_configured():
        channels.add("email")  # R50: an alert reaches you by email too when email is set up; the card says so
    tell = {"in_app": [user.id], "email": [user.email] if "email" in channels and user.email else [], "mode": "always", "remind": "once"}
    if "slack" in channels:
        needs.append("slack")  # a Slack webhook URL is pasted on the confirm card; never guessed
    body["tell"] = tell
    every = d.get("every") if d.get("every") in svc.EVERY else None
    if segment_alert:
        try:
            d["value"] = float(str(d.get("value")).replace("%", "")) if d.get("value") is not None else None
        except ValueError:
            d["value"] = None
        if d.get("value") is None:
            issues.append("Say the line to watch, for example “alert me if churn in any segment passes 25%”.")
        body["trigger"] = _segments_trigger(d, text, segments_target)
        noun = segment_watch._noun(segments_target.get("outcome") or "", segments_target.get("positive") or "")
        if not str(d.get("name") or "").strip() or len(str(d.get("name"))) > 50 or str(d.get("name")).strip().lower() == text.strip().lower()[:60]:
            body["name"] = f"Segment {noun} above {d.get('value'):g}%" if isinstance(d.get("value"), (int, float)) else f"Segment {noun} alert"
        body["steps"] = [{"type": "summarise"}]
    elif d.get("kind") == "threshold":
        if last_run is None or last_run.status != "done":
            issues.append("Ask the question you want watched first; the alert watches that answer's numbers.")
            body["trigger"] = {"type": "threshold"}
            body["steps"] = []
        else:
            target = {"kind": "project_run", "run_id": last_run.id}
            try:
                kpis = svc.target_kpis(db, user, target)
            except svc.AutomationError as e:
                kpis, issues = [], issues + [str(e)]
            kpi = _pick_kpi(kpis, d.get("kpi_hint") or "")
            if not kpi:
                issues.append("That answer has no headline number to watch; ask for a figure (a total, a rate, a count) first.")
            check = {"every": every or "hour", "minute": 0} if (every or "hour") == "hour" else {"every": every, "time": d.get("time") or "08:00"}
            if every in ("day", "week"):
                check["days"] = d.get("days") or ([0] if every == "week" else list(range(7)))
            body["trigger"] = {"type": "threshold", "target": target, "kpi": (kpi or {}).get("key"), "op": d.get("op") if d.get("op") in svc.OPS else "below",
                               "value": d.get("value"), "check": check}
            body["steps"] = [{"type": "summarise"}]
    else:
        trig = {"type": "schedule", "every": every or "day", "time": d.get("time") or "08:00"}
        if trig["every"] == "week":
            trig["days"] = d.get("days") or [0]
        elif trig["every"] == "day":
            trig["days"] = list(range(7))
        elif trig["every"] == "month":
            trig["day_of_month"] = 1
        body["trigger"] = trig
        steps = []
        if last_run is not None and last_run.status == "done":
            steps.append({"type": "rerun_question", "run_id": last_run.id})
        for dsh in dashboards[:2]:
            if dsh.get("id"):
                steps.append({"type": "refresh_dashboard", "dashboard_id": dsh["id"]})
        steps.append({"type": "summarise"})
        if len(steps) == 1:
            issues.append("Ask the question (or make the dashboard) you want sent first; the schedule re-runs it.")
        body["steps"] = steps
    fields = None
    if not issues:
        try:
            fields = svc.validate(db, user, body)
        except svc.AutomationError as e:
            issues.append(str(e))
    sentence = svc.sentence(db, fields or {"trigger": body.get("trigger") or {}, "steps": body.get("steps") or [], "tell": tell})
    note = str(d.get("note") or "").strip()
    trig = (fields or {}).get("trigger") or body.get("trigger") or {}
    first = first_check_for(db, user, trig) if not issues and trig.get("type") == "threshold" else None
    watches = None
    if segment_alert:
        watches = segment_watch.watches_text(segments_target, (first or {}).get("groups"), (first or {}).get("entities"))
    elif last_run is not None and trig.get("type") == "threshold":
        watches = f"{trig.get('kpi_label') or 'The headline number'} in “{last_run.question}”"
    return {"ok": not issues, "body": body, "sentence": sentence, "issues": issues, "needs": needs, "note": note or None,
            "watch": {"question": last_run.question, "run_id": last_run.id} if last_run is not None and not segment_alert else None,
            "watches": watches, "first_check": first, "sends": sends_text(tell),
            "threshold": {"value": trig.get("value"), "unit": trig.get("unit") or "", "op": trig.get("op")} if trig.get("type") == "threshold" else None}


def sends_text(tell: dict) -> str:
    """R50: where the message goes, in words - "In GD360 and by email to you"."""
    parts = []
    if tell.get("in_app"):
        parts.append("In Euliv (the bell)")
    if tell.get("email"):
        parts.append("by email to " + (", ".join(tell["email"][:2]) if len(tell["email"]) > 1 else "you"))
    if tell.get("slack"):
        parts.append("Slack")
    return (" and ".join(parts) if parts else "In Euliv") + " · one short message naming what crossed the line"
