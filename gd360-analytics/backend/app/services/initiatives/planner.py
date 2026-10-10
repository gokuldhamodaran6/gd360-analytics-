"""
The initiative planner: a brief in plain words becomes a complete plan -
the questions still worth asking, a strategy, phases, dated tasks with the
tool for each, targets (learned from the workspace's earlier initiatives of
the same kind), the audience, and starting cards for the board.

The AI writes it (marker "GD360 INITIATIVE PLANNER"); everything it returns
is validated against catalog.py, and when the AI is unavailable the
template for the kind is used, so a plan always comes back.
"""
from __future__ import annotations

import json
import logging
import re
from datetime import date, timedelta

from sqlalchemy import func
from sqlalchemy.orm import Session

from ... import models
from .. import ai_engine
from . import catalog, gtm, metrics

logger = logging.getLogger(__name__)
MARKER = "GD360 INITIATIVE PLANNER"
DEFAULT_LEAD = {"event": 42, "webinar": 28, "hiring": 60, "product": 84}


def _system() -> str:
    tools = "\n".join(f"  {k}: {v['name']} ({v['mode']}) - {v['does']}" for k, v in catalog.TOOLS.items())
    mets = "\n".join(f"  {k}: {v['label']} ({v['unit']}{', counted automatically' if v['auto'] else ', typed by the owner'})"
                     for k, v in catalog.METRICS.items())
    kinds = ", ".join(catalog.KINDS)
    return f"""{MARKER}
You plan business initiatives for GD360 - events, webinars, campaigns,
account-based marketing, hiring, product builds and any custom department
activity. GD360 itself provides registration pages, walk-in capture, email
campaigns with open/click tracking, website visit tracking by account,
reminders and a stage board, so a plan must work with NO other tool;
other tools are recommendations with a reason.

Reply with ONE JSON object only:
{{
 "title": "short name",
 "kind": one of {kinds},
 "department": "Marketing | Sales | People | Engineering | Operations | Finance | ...",
 "summary": "2-3 sentences: the strategy in plain words",
 "strategy": ["3-5 short, specific moves that make this work"],
 "key_date": "YYYY-MM-DD or null (event day, webinar day, launch, start date of hires)",
 "location": "or null", "budget": number or null,
 "questions": [{{"key": "...", "question": "...", "options": ["...", "..."]}}],
 "details": {{"format": "...", "audience": "...", "goal": "..."}},
 "audience": {{"tiers": ["A","B"]}} or null,
 "targets": [{{"key": metric key, "target": number, "why": "one line"}}],
 "phases": [{{"id": "p1", "title": "...", "from": days, "to": days}}],
 "tasks": [{{"title": "...", "phase": "p1", "offset": days, "tool": tool key or null, "detail": "or null"}}],
 "tools": [{{"key": tool key, "why": "one line specific to this initiative"}}],
 "board_items": [{{"title": "...", "group": "...", "stage": "..."}}],
 "roles": [{{"role": "Account executive", "does": "what this role owns", "targets": {{"invites": 25, "registrations": 8, "meetings": 4}}}}],
 "assumptions": ["..."], "learned": ["what earlier initiatives taught, if any"]
}}

Rules:
- Offsets are days relative to key_date (negative = before) for dated work;
  days from the start otherwise. 8-18 tasks, each a concrete action.
- Ask at most 3 questions, only ones whose answer would change the plan,
  and never one the brief or answers already settle. Empty list if none.
- Targets: 3-6, realistic. When HISTORY has numbers, base targets on them
  and say so in "why" and "learned".
- Tools: only these keys:
{tools}
- Metric keys:
{mets}
- roles: the people this needs and what each owns (role targets use keys
  invites, registrations, meetings, walk_ins). Sales roles log their personal
  outreach (LinkedIn, Sales Navigator, email, calls) in GD360.
- board_items: hiring -> one card per open seat ("Backend engineer #1",
  group = role, stage "Sourced"); product -> the must-have scope (stage
  "Backlog", group = milestone); others -> [] unless obvious.
- Plain, professional English. No hype, no emojis.
"""


def _context(db: Session, workspace_id: str | None, kind: str | None) -> dict:
    ctx: dict = {"today": date.today().isoformat()}
    if not workspace_id:
        return ctx
    if kind:
        ctx["history"] = metrics.history(db, workspace_id, kind)
    A = models.GtmAccount
    n = db.query(A).filter(A.workspace_id == workspace_id).count()
    if n:
        tiers = dict(db.query(A.icp_tier, func.count()).filter(A.workspace_id == workspace_id)
                     .group_by(A.icp_tier).all())
        ctx["accounts"] = {"total": n, "tiers": {k or "unscored": v for k, v in tiers.items()}}
    prof = gtm.profile(db, workspace_id)
    if gtm.icp_is_set(prof.icp):
        ctx["icp"] = {k: v for k, v in (prof.icp or {}).items() if v and k not in ("postal_address",)}
    conns = [c.provider for c in db.query(models.GtmConnection).filter(models.GtmConnection.workspace_id == workspace_id)]
    if conns:
        ctx["connected"] = conns
    return ctx


def draft(db: Session, workspace_id: str | None, brief: str, kind: str | None = None, answers: dict | None = None,
          key_date: str | None = None, previous: dict | None = None, instruction: str | None = None) -> dict:
    explicit = kind in catalog.KINDS
    kind = kind if explicit else catalog.guess_kind(brief)
    ctx = _context(db, workspace_id, kind)
    user = {"brief": brief, "kind_hint": kind, "answers": answers or {}, "key_date": key_date, "context": ctx}
    if previous:
        user["current_plan"] = {k: previous.get(k) for k in ("title", "kind", "summary", "key_date", "targets",
                                                              "phases", "tasks", "tools", "audience")}
    if instruction:
        user["change_request"] = instruction
    raw = None
    try:
        raw = ai_engine._plan_with_retry(
            [{"role": "system", "content": _system()},
             {"role": "user", "content": json.dumps(user, default=str)[:24000]}],
            max_tokens=5000)
    except Exception as e:  # noqa: BLE001 - the template always works
        logger.warning("[initiatives] planner fell back to the template: %s", e)
    if explicit and isinstance(raw, dict):
        raw["kind"] = kind  # the person chose it
    plan = validate(raw or {}, brief, kind, answers or {}, key_date, ctx, fallback=raw is None)
    plan["ai"] = raw is not None
    return plan


# ------------------------------------------------------------ validate ---

def _int(v, lo, hi, default=0) -> int:
    try:
        return max(lo, min(hi, int(round(float(v)))))
    except (TypeError, ValueError):
        return default


def _num(v):
    try:
        f = float(v)
        return f if f == f else None
    except (TypeError, ValueError):
        return None


def _str(v, n=300):
    s = str(v or "").strip()
    return s[:n] if s else None


def _date(v) -> str | None:
    try:
        return date.fromisoformat(str(v)[:10]).isoformat() if v else None
    except ValueError:
        return None


def _date_in_brief(text: str) -> str | None:
    t = text or ""
    m = re.search(r"(20\d{2})-(\d{2})-(\d{2})", t)
    if m:
        return _date(m.group(0))
    months = {m: i + 1 for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"])}
    m = re.search(r"\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b", t, re.I) or \
        re.search(r"\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?\b", t, re.I)
    if not m:
        return None
    a, b = m.group(1), m.group(2)
    day, mon = (int(a), months[b[:3].lower()]) if a.isdigit() else (int(b), months[a[:3].lower()])
    today = date.today()
    try:
        d = date(today.year, mon, day)
    except ValueError:
        return None
    if d < today:
        d = date(today.year + 1, mon, day)
    return d.isoformat()


def validate(raw: dict, brief: str, kind: str, answers: dict, key_date: str | None, ctx: dict,
             fallback: bool = False) -> dict:
    tpl_kind = raw.get("kind") if raw.get("kind") in catalog.KINDS else kind
    tpl = catalog.TEMPLATES[tpl_kind]
    meta = catalog.KINDS[tpl_kind]
    hist = (ctx.get("history") or {})
    avgs = hist.get("averages") or {}

    title = _str(raw.get("title"), 120) or _title_from(brief, tpl_kind)
    kd = _date(key_date) or _date(raw.get("key_date")) or _date_in_brief(brief)
    if not kd and meta["dated"]:
        kd = (date.today() + timedelta(days=DEFAULT_LEAD.get(tpl_kind, 42))).isoformat()

    # phases
    phases = []
    for n, p in enumerate(raw.get("phases") or []):
        if not isinstance(p, dict) or not _str(p.get("title")):
            continue
        phases.append({"id": f"p{n + 1}", "title": _str(p["title"], 60), "from": _int(p.get("from"), -365, 365),
                       "to": _int(p.get("to"), -365, 365), "_old": p.get("id")})
    if not phases:
        phases = [dict(p) for p in tpl["phases"]]
    remap = {p.pop("_old", None): p["id"] for p in phases}

    # tasks
    tasks = []
    for t in raw.get("tasks") or []:
        if not isinstance(t, dict) or not _str(t.get("title")):
            continue
        ph = remap.get(t.get("phase")) or (t.get("phase") if any(p["id"] == t.get("phase") for p in phases) else None)
        tool = t.get("tool") if t.get("tool") in catalog.TOOLS else None
        tasks.append({"title": _str(t["title"], 200), "phase": ph or phases[0]["id"],
                      "offset": _int(t.get("offset"), -365, 365), "tool": tool, "detail": _str(t.get("detail"), 600)})
    if len(tasks) < 3:
        tasks = [dict(t) for t in tpl["tasks"]]

    # targets
    targets = []
    seen = set()
    for t in raw.get("targets") or []:
        if not isinstance(t, dict):
            continue
        key = str(t.get("key") or "").strip()
        val = _num(t.get("target"))
        if not key or val is None or key in seen:
            continue
        if key not in catalog.METRICS:
            key = re.sub(r"[^a-z0-9_]+", "_", key.lower())[:40] or "custom"
        seen.add(key)
        targets.append({"key": key, "label": catalog.metric_label(key) if key in catalog.METRICS else _str(t.get("label"), 60) or key.replace("_", " ").capitalize(),
                        "target": val, "unit": (catalog.METRICS.get(key) or {}).get("unit") or "count",
                        "auto": bool((catalog.METRICS.get(key) or {}).get("auto")),
                        "why": _str(t.get("why"), 200)})
    learned = [x for x in (_str(v, 240) for v in (raw.get("learned") or [])) if x]
    if not targets:
        targets, learned_tpl = _template_targets(tpl_kind, tpl, avgs)
        learned = learned or learned_tpl
    targets = targets[:8]

    # tools
    tools = []
    for t in raw.get("tools") or []:
        k = t.get("key") if isinstance(t, dict) else t
        if k in catalog.TOOLS and k not in {x["key"] for x in tools}:
            tools.append({"key": k, "why": _str(t.get("why") if isinstance(t, dict) else None, 240)
                          or catalog.TOOLS[k]["does"]})
    for t in tasks:
        if t["tool"] and t["tool"] not in {x["key"] for x in tools}:
            tools.append({"key": t["tool"], "why": catalog.TOOLS[t["tool"]]["does"]})
    if not tools:
        tools = [{"key": k, "why": catalog.TOOLS[k]["does"]} for k in tpl["tools"]]

    questions = []
    for q in (raw.get("questions") or [])[:3]:
        if isinstance(q, dict) and _str(q.get("question")) and _str(q.get("key"), 40) not in answers:
            opts = [o for o in (_str(x, 60) for x in (q.get("options") or [])) if o][:6]
            questions.append({"key": _str(q.get("key"), 40) or f"q{len(questions)}", "question": _str(q["question"], 160),
                              "options": opts})
    if fallback:
        questions = [q for q in catalog.QUESTIONS.get(tpl_kind, []) if q["key"] not in answers][:3]

    audience = raw.get("audience") if isinstance(raw.get("audience"), dict) else None
    if audience:
        audience = {"tiers": [x for x in (audience.get("tiers") or []) if x in ("A", "B", "C")]}
        audience = audience if audience["tiers"] else None
    if audience is None and tpl_kind in ("abm", "campaign", "event", "webinar"):
        audience = {"tiers": ["A", "B"]} if (ctx.get("accounts") or {}).get("total") else None

    items = []
    stages = meta["stages"]
    for it in (raw.get("board_items") or [])[:40]:
        if isinstance(it, dict) and _str(it.get("title")):
            st = it.get("stage") if it.get("stage") in stages else stages[0]
            items.append({"title": _str(it["title"], 120), "group": _str(it.get("group"), 60), "stage": st})
    if not items and tpl_kind == "hiring":
        m = re.search(r"\b(\d{1,2})\s+(?:people|engineers|hires|roles|developers|positions|designers|sales)", brief or "", re.I)
        n = _int(m.group(1), 1, 30, 3) if m else 3
        items = [{"title": f"Open seat #{k + 1}", "group": "Team", "stage": "Sourced"} for k in range(n)]

    summary = _str(raw.get("summary"), 800) or _template_summary(tpl_kind, title, kd)
    strategy = [x for x in (_str(v, 240) for v in (raw.get("strategy") or [])) if x][:6] or _template_strategy(tpl_kind)

    plan = {
        "title": title, "kind": tpl_kind, "department": _str(raw.get("department"), 60) or meta["department"],
        "summary": summary, "strategy": strategy, "key_date": kd, "location": _str(raw.get("location"), 160),
        "budget": _num(raw.get("budget")), "questions": questions,
        "details": {k: _str(v, 200) for k, v in (raw.get("details") or {}).items() if _str(v)} if isinstance(raw.get("details"), dict) else {},
        "audience": audience, "targets": targets, "phases": phases, "tasks": tasks, "tools": tools,
        "board_items": items,
        "roles": _roles(raw.get("roles"), tpl_kind),
        "assumptions": [x for x in (_str(v, 240) for v in (raw.get("assumptions") or [])) if x][:6],
        "learned": learned[:5], "history_count": hist.get("count", 0),
    }
    for k, v in (answers or {}).items():
        if v and k not in plan["details"]:
            plan["details"][str(k)[:40]] = str(v)[:200]
    return schedule(plan)


def _roles(raw, kind: str) -> list[dict]:
    from .team import ROLES
    out = []
    for r in (raw or [])[:10]:
        if isinstance(r, dict) and _str(r.get("role"), 60):
            tg = {k: _int(v, 0, 100000) for k, v in (r.get("targets") or {}).items()
                  if k in ("invites", "registrations", "meetings", "walk_ins")} if isinstance(r.get("targets"), dict) else {}
            out.append({"role": _str(r["role"], 60), "does": _str(r.get("does"), 240) or "", "targets": tg})
    return out or [dict(x) for x in (ROLES.get(kind) or ROLES["custom"])]


def _title_from(brief: str, kind: str) -> str:
    b = re.sub(r"\s+", " ", (brief or "").strip())
    b = re.sub(r"^(i want to|i need to|we want to|we need to|help me|plan|let's|lets)\s+", "", b, flags=re.I)
    b = b[:1].upper() + b[1:] if b else catalog.KINDS[kind]["label"]
    return (b[:70].rsplit(" ", 1)[0] if len(b) > 70 else b).rstrip(".,;:")


def _template_targets(kind: str, tpl: dict, avgs: dict) -> tuple[list[dict], list[str]]:
    learned = []
    vals = dict(tpl["targets"])
    if kind in ("event", "webinar") and avgs.get("registrations"):
        reg = int(round(avgs["registrations"] * 1.15))
        vals["registrations"] = reg
        learned.append(f"Your earlier {kind}s averaged {avgs['registrations']:g} registrations; the target is 15% higher.")
        rate = avgs.get("attendance_rate")
        if rate:
            if "attended" in vals:
                vals["attended"] = int(round(reg * rate / 100))
            if "attendance_rate" in vals:
                vals["attendance_rate"] = round(rate, 1)
            learned.append(f"{rate:g}% of registrants attended last time, so attendance targets use that rate.")
    if avgs.get("walk_ins") and "walk_ins" in vals:
        vals["walk_ins"] = int(round(avgs["walk_ins"] * 1.1))
        learned.append(f"Walk-ins averaged {avgs['walk_ins']:g}; aiming 10% higher with a pre-booked meeting slot.")
    if avgs.get("open_rate") and "open_rate" in vals:
        vals["open_rate"] = round(min(60.0, avgs["open_rate"] + 3), 1)
        learned.append(f"Your emails open at {avgs['open_rate']:g}% on average.")
    out = []
    for key, val in vals.items():
        m = catalog.METRICS[key]
        out.append({"key": key, "label": m["label"], "target": val, "unit": m["unit"], "auto": m["auto"],
                    "why": catalog.DEFAULT_WHY.get(key)})
    return out, learned


def _template_summary(kind: str, title: str, kd: str | None) -> str:
    when = f" on {date.fromisoformat(kd).strftime('%-d %B %Y')}" if kd else ""
    return {
        "event": f"Fill the room with the right accounts{when}: invite Tier A personally, open registration early, capture every walk-in on the day and book meetings within 72 hours.",
        "webinar": f"Run a focused session{when} on a topic your best-fit accounts care about, promote it for four weeks, and follow up attendees and no-shows within a day.",
        "campaign": "Reach the chosen tiers with one clear message across email and LinkedIn, watch which accounts open, click and visit, and follow up the ones that show interest.",
        "abm": "Build the target list from your ICP, warm Tier A and B with ads and email, watch for accounts that surge, and turn engagement into meetings with personal outreach.",
        "hiring": f"Define each role by its outcomes, source wide, keep every candidate moving within 3 days, and close offers{when}.",
        "product": f"Pin down the problem and the must-have scope, build in two-week sprints, freeze features three weeks out and launch{when} with a measurable success goal.",
        "custom": f"{title}: agree the goal and owners, break the work into tasks, check in weekly and review the result.",
    }[kind]


def _template_strategy(kind: str) -> list[str]:
    return {
        "event": ["Tier A accounts get a personal invite from their owner", "Registration opens six weeks out",
                  "Every walk-in is captured on a phone in under 30 seconds", "Meetings booked within 72 hours of the event"],
        "webinar": ["One topic, one promise", "Three emails plus LinkedIn over four weeks",
                    "Recording to everyone within 24 hours", "Personal follow-up for engaged Tier A accounts"],
        "campaign": ["One message per tier", "Track opens, clicks and website visits by account",
                     "Second touch only to those who showed interest", "Call accounts that visit the site"],
        "abm": ["1:1 for Tier A, 1:few for Tier B, 1:many for Tier C", "3-5 buying-committee people per Tier A account",
                "Work the surging-accounts list every week", "Move accounts on the pipeline board as they progress"],
        "hiring": ["Write roles as outcomes, not lists", "Referrals first, then job boards and direct sourcing",
                   "No candidate waits more than 3 days", "Scorecards and same-day debriefs"],
        "product": ["Problem and success measure written first", "Must-have scope only for release one",
                    "Two-week sprints with reviews", "Beta with friendly customers before launch"],
        "custom": ["One owner per task", "Dates on everything", "Weekly check-in", "Review against the goal"],
    }[kind]


def schedule(plan: dict) -> dict:
    """Turns offsets into due dates. When the time left is shorter than the
    plan assumes, the plan is compressed so the first task starts today."""
    kind = plan["kind"]
    dated = catalog.KINDS[kind]["dated"] and plan.get("key_date")
    today = date.today()
    anchor = date.fromisoformat(plan["key_date"]) if dated else today
    offsets = [t["offset"] for t in plan["tasks"]] or [0]
    earliest = min(offsets)
    scale = 1.0
    if dated and anchor + timedelta(days=earliest) < today and earliest < 0:
        room = (anchor - today).days
        scale = max(room, 0) / abs(earliest) if earliest else 1.0
        plan["compressed"] = True
    for t in plan["tasks"]:
        off = int(round(t["offset"] * scale)) if t["offset"] < 0 else t["offset"]
        t["due_on"] = max(anchor + timedelta(days=off), today).isoformat()
    for p in plan["phases"]:
        f = int(round(p["from"] * scale)) if p["from"] < 0 else p["from"]
        to = int(round(p["to"] * scale)) if p["to"] < 0 else p["to"]
        p["starts"] = max(anchor + timedelta(days=f), today).isoformat()
        p["ends"] = max(anchor + timedelta(days=to), today).isoformat()
    plan["tasks"].sort(key=lambda t: (t["due_on"], t["offset"]))
    plan["starts_on"] = min([today.isoformat()] + [t["due_on"] for t in plan["tasks"]])
    return plan
