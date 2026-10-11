"""
/assistant - Euliv, the GD360 voice assistant (2026-10-11).

  GET    /assistant/hello?talk_id=     "Hi Gokul, how can I help you?" / "Welcome back ..."
  POST   /assistant/turn               one thing the person said -> what Euliv says and does next
  GET    /assistant/answer/{run_id}    a question being answered: progress, then what to say + the answer card
  GET    /assistant/connected?kind=    has the source Euliv offered to connect been connected yet?
  GET    /assistant/memory             the sources Euliv remembers per topic
  DELETE /assistant/memory?topic=      forget one topic (or all)
  GET    /assistant/talks/{id}         a saved talk: every turn, with its cards
  PATCH  /assistant/talks/{id}         rename
  DELETE /assistant/talks/{id}

Round 24 (2026-10-11) - Euliv understands before it answers. A new question
is read back first (services/question_check.py), out loud:
  - a date that can't be right is asked about ("January 20258 - did you mean 2025?");
  - the data: every source that could answer it is offered as a numbered list;
    the person picks by voice ("the first and third", "add Shopify", "drop both,
    use the fourth", "just Meta", "what else do I have?", "which is best?") or
    by tapping, and Euliv reads the choice back after every change;
  - data that can't answer it (no dates, dates that stop too early) is said
    plainly, with what can: other sources, the data's latest window, connect or upload;
  - finally "So: your e-commerce sales for July - September 2026, from
    Ecommerce_Data. Shall I go ahead?" - and only then does it run, with the
    agreed period handed to the planner.
Every talk is saved as its own item in Library (Conversation kind "voice"):
the words both ways and each card, never audio. Answers stay in the popup.

The browser turns speech into words and speaks Euliv's replies; only the
words reach here. The conversation's state comes back on every turn, so a
turn is stateless on the server.
"""
from __future__ import annotations

import logging
import re
from contextvars import ContextVar
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from .. import models
from ..database import get_db
from ..deps import get_current_user
from ..services import assistant as eu
from ..services import question_check as qc
from ..services.project_engine.catalog import KIND_LABELS, accessible_sources
from . import projects

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/assistant", tags=["assistant"])

FOLLOW_UP = (
    "why", "how come", "what about", "and ", "compare", "break it", "break that", "split", "what drove", "what caused",
    "explain", "tell me more", "and what", "how about", "same for", "what was driving", "what's driving", "whats driving",
    "is that", "was that", "can you explain", "go deeper", "dig into",
)
MAX_OPTIONS = 12

# round 25b: "today" is the person's own date (their browser's), not the server's - "last month" on
# 1 Nov at 1am in Sydney is October, even while the server in UTC still says 31 Oct
_TODAY: ContextVar[date | None] = ContextVar("euliv_today", default=None)


def local_today(said: str | None) -> date:
    """The client's date when it's within a day of the server's (time zones), else the server's."""
    server = date.today()
    try:
        d = date.fromisoformat(str(said or "")[:10])
    except ValueError:
        return server
    return d if abs((d - server).days) <= 1 else server


def _today() -> date:
    return _TODAY.get() or date.today()


def first_name(user: models.User) -> str:
    name = (user.full_name or "").strip()
    if name:
        n = name.split()[0][:30]
        return n[:1].upper() + n[1:] if n.islower() else n
    local = (user.email or "").split("@")[0]
    local = local.split(".")[0].split("_")[0]
    letters = "".join(ch for ch in local if ch.isalpha())
    return letters[:1].upper() + letters[1:20] if len(letters) >= 2 else ""


def hello_text(user: models.User) -> str:
    n = first_name(user)
    return f"Hi {n}, how can I help you?" if n else "Hi, how can I help you?"


class TurnState(BaseModel):
    awaiting: str | None = None           # fix_date | plan | connect | connecting | None
    pending_question: str | None = Field(default=None, max_length=2000)
    candidates: list[dict] = Field(default_factory=list, max_length=12)
    connect: dict | None = None
    project_id: str | None = None
    last_run_id: str | None = None
    topic: str | None = None
    retries: int = 0
    # round 24: the read-back being agreed (question, what, period, numbered options, selected ...)
    brief: dict | None = None
    talk_id: str | None = None


class TurnRequest(BaseModel):
    text: str = Field(default="", max_length=2000)
    state: TurnState = Field(default_factory=TurnState)
    workspace_id: str | None = None
    # "connected": the source Euliv offered was connected - carry on;
    # "confirm": the Go ahead button (the picked sources are in state.brief);
    # "needs_input": the answer came back "these sources can't answer that" - offer other data
    event: str | None = None
    run_id: str | None = None
    # keep a written record of the talk (Euliv settings > Keep a written record)
    save: bool = True
    greeting: str | None = Field(default=None, max_length=300)
    today: str | None = Field(default=None, max_length=10)  # the person's local date, YYYY-MM-DD


def _reply(say: str, action: str, state: TurnState, **extra) -> dict:
    return {"say": say, "speak": eu.speakable(say), "action": action, "state": state.model_dump(), **extra}


def _err_text(e: HTTPException) -> str:
    d = e.detail if isinstance(e.detail, str) else "That didn't work"
    if e.status_code == 429:
        return "You're asking a bit fast - give me a few seconds and ask again."
    if e.status_code == 403:
        return "You can only view those sources, so I can't run a new analysis on them. Ask an editor for access."
    return d.rstrip(".") + "."


def _keep(state: TurnState, **upd) -> TurnState:
    """A fresh state that keeps the conversation's thread (project, talk, topic)."""
    base = TurnState(project_id=state.project_id, last_run_id=state.last_run_id, topic=state.topic, talk_id=state.talk_id)
    return base.model_copy(update=upd) if upd else base


# ---- running -----------------------------------------------------------------------------

def _start(db: Session, user: models.User, question: str, source_ids: list[str] | None, workspace_id: str | None,
           state: TurnState, picked: list[dict] | None = None, brief: dict | None = None, say: str | None = None) -> dict:
    """A new question -> a Quick-answer project."""
    try:
        out = projects.create_project(
            projects.CreateProjectRequest(question=question, source_ids=source_ids or None,
                                          workspace_id=workspace_id, mode="answer", brief=brief),
            db=db, user=user,
        )
    except HTTPException as e:
        if state.awaiting == "plan" and state.brief:
            # the read-back stays agreed: "go ahead" again in a moment runs it
            return _reply(_err_text(e) + " Say 'go ahead' when you're ready.", "plan", state,
                          plan=_talk_card(state.brief), title=_title_of(state.brief))
        return _reply(_err_text(e), "chat", _keep(state))
    names = eu.names_text(picked or [])
    if not say:
        say = f"On it - looking at {names}." if names else "On it."
    st = _keep(state, project_id=out["project_id"], last_run_id=out["run_id"])
    return _reply(say, "run", st, run_id=out["run_id"], project_id=out["project_id"], question=question,
                  sources=picked or [])


def _follow_up(db: Session, user: models.User, question: str, state: TurnState,
               source_ids: list[str] | None = None) -> dict | None:
    """A follow-up in the conversation's project; None when it should be a new question."""
    try:
        out = projects.ask(
            state.project_id,
            projects.AskRequest(question=question, route=True, context_run_id=state.last_run_id,
                                source_ids=source_ids or None),
            db=db, user=user,
        )
    except HTTPException as e:
        if e.status_code == 409:
            return _reply("I'm still working on your last question - one moment.", "wait", state)
        if e.status_code in (403, 404):
            return None
        return _reply(_err_text(e), "chat", state)
    if out.get("kind") == "explain":
        ex = out.get("explain") or {}
        pts = [p.get("text") for p in ex.get("points") or [] if p.get("text")]
        say = " ".join([ex.get("headline") or ""] + pts[:2]).strip() or "Here's what the numbers show."
        return _reply(eu.first_sentences(say, 3, 420), "explain", _keep(state), explain={
            "headline": ex.get("headline"), "points": ex.get("points") or [], "takeaway": ex.get("takeaway"),
            "followups": ex.get("followups") or [], "run_id": state.last_run_id,
            "link": f"/p/{state.project_id}?run={state.last_run_id}" if state.last_run_id else f"/p/{state.project_id}",
        })
    st = _keep(state, last_run_id=out["run_id"])
    return _reply("On it.", "run", st, run_id=out["run_id"], project_id=state.project_id, question=question)


def _is_follow_up(text: str, state: TurnState, topic: str | None, named: bool) -> bool:
    if not state.project_id or not state.last_run_id:
        return False
    if not eu.questionish(text):
        return False  # "no you are good", "hmm okay" - a remark, not a question about the answer
    low = text.lower().strip()
    if named:
        return False  # a source was named - a fresh question on it
    if topic and state.topic and topic != state.topic:
        return False  # a different subject
    if low.startswith(FOLLOW_UP):
        return True
    return not topic and len(low.split()) <= 6


# ---- the read-back ---------------------------------------------------------------------------

def _note(c: dict) -> str:
    """A few spoken words on why a source fits (or doesn't)."""
    cov = c.get("coverage")
    if c.get("fit") == "no_dates":
        return "no dates"
    if c.get("fit") == "out_of_range" and cov:
        return f"its data runs {cov['text']}"
    if c.get("fit") == "good" and cov:
        hi = date.fromisoformat(cov["end"])
        return f"data up to {qc.MONTHS[hi.month - 1].title()} {hi.year}"
    return ""


def _opt(c: dict) -> dict:
    return {"id": c["id"], "name": c["name"], "kind": c.get("kind"), "label": c.get("label") or KIND_LABELS.get(c.get("kind"), ""),
            "why": c.get("why") or "", "fit": c.get("fit") or "good", "note": _note(c), "says": c.get("says") or "",
            "recommended": bool(c.get("recommended"))}


def _all_options(db: Session, user: models.User, ws: str | None, first: list[dict]) -> list[dict]:
    """The options already offered, then every other source this person can use."""
    seen = {o["id"] for o in first}
    rest = [{"id": s.id, "name": s.name, "kind": s.kind, "label": KIND_LABELS.get(s.kind, s.kind), "why": "", "fit": "unknown",
             "note": ""} for s in accessible_sources(db, user, ws) if s.id not in seen]
    return (first + rest)[:MAX_OPTIONS]


def _restated(b: dict) -> str:
    picked = [o for o in b.get("options") or [] if o["id"] in set(b.get("selected") or [])]
    if b.get("mode") == "follow":
        names = eu.names_text(picked, limit=4)
        return f"Your follow-up, answered from {names or 'the same data'}" + (
            f" for {b['period']['text']}" if b.get("period") else "") + "."
    s = qc._restate(b.get("what") or "the answer", b.get("period"), picked, bool(b.get("needs_time")))  # noqa: SLF001
    if not picked and not b.get("needs_pick"):
        s = s.rstrip(".") + ", looking across all your data."
    return s


def _plan_say(b: dict, lead: str = "") -> str:
    r = _restated(b)
    if r.startswith("Your "):
        r = "your " + r[5:]
    if lead.endswith(":"):
        return f"{lead} {r} Shall I go ahead?"
    return (lead + " " if lead else "") + "So: " + r + " Shall I go ahead?"


def _title_of(b: dict) -> str:
    what = (b.get("what") or "Talk").removeprefix("your ").removeprefix("the ")
    t = what[:1].upper() + what[1:]
    if b.get("period"):
        t += f" · {b['period'].get('text')}"
    return t[:80]


def _talk_card(b: dict, kind: str = "plan") -> dict:
    return {"type": kind, "question": b.get("question") or "", "options": b.get("options") or [], "selected": b.get("selected") or [],
            "period": b.get("period"), "period_options": b.get("period_options") or [],
            "restated": _restated(b), "needs_pick": bool(b.get("needs_pick")), "connect": b.get("connect") or [],
            "mode": b.get("mode"), "what": b.get("what"), "needs_time": bool(b.get("needs_time"))}


def _plan_reply(say: str, state: TurnState, b: dict) -> dict:
    st = _keep(state, awaiting="plan", pending_question=b["question"], brief=b, retries=0)
    return _reply(say, "plan", st, plan=_talk_card(b), title=_title_of(b))


def _plan_from_check(db: Session, user: models.User, q: str, c: dict, state: TurnState, ws: str | None,
                     lead: str = "") -> dict:
    """The first read-back of a question: what was understood, and the data to use."""
    issues = {i["kind"]: i for i in c.get("issues") or []}
    cands = c.get("candidates") or []
    b = {"question": q, "what": c.get("what"), "period": c.get("period"), "period_options": c.get("period_options") or [],
         "needs_time": c.get("needs_time"), "topic": c.get("topic"), "connect": c.get("connect") or [],
         "options": [], "selected": [], "needs_pick": False, "mode": None}
    lead = (lead + " ").lstrip()

    if c.get("sources_considered", 1) == 0:
        conn = (c.get("connect") or [{"kind": None, "label": "a data source", "url": "/data?tab=catalog"}])[0]
        st = _keep(state, awaiting="connect", pending_question=q, connect=conn)
        say = (f"{lead}You haven't connected any data yet. Shall I open {conn['label']} so you can connect it? "
               "Or upload a file from Data.")
        return _reply(say, "connect_offer", st, connect=conn)

    cant = issues.get("cant_answer")
    choose = issues.get("choose")
    pick = issues.get("swap") or issues.get("confirm_pick")
    by_id = {x["id"]: x for x in cands}
    if cant:
        shift = next((o for o in cant["options"] if o["id"] == "shift"), None)
        weak = [_opt(x) for x in cands if x.get("fit") != "good"]
        b["options"] = _all_options(db, user, ws, weak[:4])
        b["needs_pick"] = True
        if shift:
            b["mode"] = "shift"
            b["suggest"] = {"source": shift["value"], "period": shift["period"]}
            return _plan_reply(f"{lead}{cant['text']} Shall I do that?", state, b)
        extra = ""
        if b["connect"]:
            extra = f" You can also say 'connect {b['connect'][0]['label']}' or 'upload a file'."
        say = f"{lead}{cant['text']} Here's what you have: {eu.numbered(b['options'])}{extra}"
        return _plan_reply(say.strip(), state, b)

    if pick:
        ids = [o["value"] for o in pick["options"]]
        b["options"] = [_opt(by_id[i]) | {"recommended": n == 0} for n, i in enumerate(ids) if i in by_id]
        # "use them together" (a comparison split across two sources) ticks them all
        b["selected"] = (ids if pick.get("id") == "combine" else [ids[0]]) if ids else []
        b["chosen"] = True
        return _plan_reply(f"{lead}{pick['text']}", state, b)

    if choose:
        ids = [o["value"] for o in choose["options"]]
        b["options"] = [_opt(by_id[i]) | {"recommended": n == 0} for n, i in enumerate(ids) if i in by_id]
        b["needs_pick"] = True
        n_good = sum(1 for o in b["options"] if o["fit"] == "good")
        # the period is part of the read-back even before the data is picked
        p = b.get("period") or {}
        when = ""
        if p.get("parts"):
            when = f" I'll compare {p['parts'][0]['text']} with {p['parts'][1]['text']}."
        elif p.get("future"):
            when = f" {p['text']} hasn't happened yet, so it will be a forecast."
        say = (f"{lead}I found {b['what']} in {n_good} places.{when} {eu.numbered(b['options'])} "
               "Which should I use? You can pick one, a few, or all of them.")
        return _plan_reply(say, state, b)

    picked = c.get("picked") or []
    good_others = [x for x in cands if x.get("fit") == "good" and x["id"] not in picked]
    b["options"] = [_opt(by_id[i]) for i in picked if i in by_id] + [_opt(x) for x in good_others[:4]]
    b["selected"] = list(picked)
    # what this person picked for the topic before, when it's still on offer
    topic = c.get("topic")
    if topic and not any(x.get("named") for x in cands):
        mem = [i for i in eu.remembered(db, user, topic) if i in {o["id"] for o in b["options"]}]
        if mem:
            b["selected"] = mem
            lead = (lead + "Like last time:").strip()
    say = _plan_say(b, lead.strip())
    if b["connect"] and not b["selected"]:
        # only worth saying out loud when nothing connected can answer; the card still offers it
        say += f" (Your {b['connect'][0]['label']} isn't connected - say 'connect {b['connect'][0]['label']}' to add it.)"
    return _plan_reply(say, state, b)


def _new_question(db: Session, user: models.User, q: str, ws: str | None, state: TurnState, lead: str = "",
                  accepted: list[str] | None = None) -> dict:
    # an app named in the question that isn't connected ("followers on Instagram"): offer to connect it
    from ..services import synced_sources
    pool = accessible_sources(db, user, ws)
    named_ds, missing = eu._named(q, pool)  # noqa: SLF001
    if missing and not named_ds and missing[0] in synced_sources.APPS:
        conn = eu._connect_info(missing[0])  # noqa: SLF001
        st = _keep(state, awaiting="connect", pending_question=q, connect=conn)
        say = (f"{(lead + ' ') if lead else ''}{conn['label']} isn't connected yet, so I can't see that. Shall I connect it now? "
               "Or say 'use what's connected' and I'll try with the data you have.")
        return _reply(say, "connect_offer", st, connect=conn)
    try:
        c = qc.check(db, user, q, workspace_id=ws, accepted=accepted, today=_today())
    except Exception as e:  # noqa: BLE001 - never stand between a person and an answer
        logger.warning("[assistant] question check skipped: %s", e)
        c = {"ready": True, "issues": [], "candidates": [], "picked": [], "what": "the answer", "period": None}
    named = any(x.get("named") for x in c.get("candidates") or [])
    if _is_follow_up(q, state, c.get("topic"), named):
        # round 25: a follow-up is read back too - same data as the answer before - and runs on "go ahead"
        return _follow_plan(db, user, q, state, lead)
    # a short remark with nothing to look up ("hmm okay", "great stuff"): don't build an analysis out of it
    words = q.split()
    if (len(words) <= 4 and not eu.questionish(q) and not c.get("period") and not named
            and not any(x.get("score", 0) >= 4 for x in c.get("candidates") or [])):
        return _reply("I'm not sure what you'd like me to look at. Ask me about your data - like 'sales last month' - "
                      "or say 'bye' to finish.", "chat", _keep(state))
    st = _keep(state, topic=c.get("topic") or state.topic)
    date_issue = next((i for i in c.get("issues") or [] if i["kind"] in ("year_typo", "month_typo", "future_year")), None)
    if date_issue:
        st = st.model_copy(update={"awaiting": "fix_date", "pending_question": q,
                                   "brief": {"issue": date_issue, "question": q, "accepted": list(accepted or [])}})
        return _reply((lead + " " if lead else "") + date_issue["text"], "fix_date", st, issue=date_issue)
    return _plan_from_check(db, user, q, c, st, ws, lead)


def _follow_plan(db: Session, user: models.User, q: str, state: TurnState, lead: str = "") -> dict:
    conv = None
    if state.project_id:
        try:
            conv = projects._project(db, state.project_id, user)  # noqa: SLF001 - same access rules as the thread page
        except HTTPException:
            conv = None
    if conv is None:
        return _new_question(db, user, q, None, _keep(state, project_id=None, last_run_id=None), lead)
    ids = list(conv.source_ids or [])
    rows = {s.id: s for s in db.query(models.DataSource).filter(models.DataSource.id.in_(ids)).all()} if ids else {}
    opts = [{"id": i, "name": rows[i].name, "kind": rows[i].kind, "label": KIND_LABELS.get(rows[i].kind, rows[i].kind),
             "why": "", "fit": "good", "note": "used for the last answer", "says": "", "recommended": False}
            for i in ids if i in rows]
    b = {"question": q, "what": f"“{q}”", "period": None, "period_options": [], "needs_time": False, "topic": state.topic,
         "connect": [], "options": opts, "selected": [o["id"] for o in opts], "needs_pick": False, "mode": "follow",
         "orig_selected": [o["id"] for o in opts]}
    say = (lead + " " if lead else "") + f"You asked: “{q}”. I'll answer it from the same data as before. Shall I go ahead?"
    return _plan_reply(say, state, b)


def _run_plan(db: Session, user: models.User, state: TurnState, b: dict, ws: str | None, lead: str = "") -> dict:
    if b.get("mode") == "follow":
        sel = b.get("selected") or []
        changed = sorted(sel) != sorted(b.get("orig_selected") or [])
        out = _follow_up(db, user, b["question"], _keep(state), sel if changed and sel else None)
        if out:
            return out
        return _new_question(db, user, b["question"], ws, _keep(state, project_id=None, last_run_id=None))
    sel = b.get("selected") or []
    picked = [o for o in b.get("options") or [] if o["id"] in set(sel)]
    if b.get("topic") and sel and b.get("chosen"):
        eu.remember(db, user, b["topic"], sel)
        db.commit()
    brief = {"period": b.get("period"), "restated": _restated(b)}
    names = eu.names_text(picked)
    say = (lead + " " if lead else "") + (f"On it - {b.get('what') or 'looking'}" if not names else f"On it - looking at {names}")
    if b.get("period"):
        say += f" for {b['period']['text']}"
    return _start(db, user, b["question"], sel or None, ws, _keep(state, topic=b.get("topic") or state.topic), picked,
                  brief=brief, say=say + ".")


_REPHRASE = re.compile(r"^(?:(?:no|wait|actually|sorry|hold on)[\s,]+)*(?:can i |let me |i want to |i'?d like to )?"
                       r"(?:change|edit|rephrase|reword|update|fix|correct|redo)\s+(?:the |my |that )?question\b(?:\s+to\s+(.+))?", re.I)


_NEW_LEAD = re.compile(r"^(?:(?:no|actually|wait|sorry|instead|ok|okay|and|now|also|forget that|scratch that)[\s,]+)*"
                       r"(?:what|what's|whats|how|why|which|who|show|give|tell|compare|list|can you|could you|"
                       r"i want to (?:see|know)|let'?s look at|look at)\b", re.I)


def _looks_new(text: str, opts: list[dict]) -> bool:
    """A whole new question asked during a read-back ("actually, show me marketing spend last month instead"),
    not an answer to it ("the first and third", "what else do I have?")."""
    low = (text or "").lower().strip()
    if len(low.split()) < 4:
        return False
    if any(eu._says(eu._norm(low), o["name"]) for o in opts if o.get("name")):  # noqa: SLF001
        return False
    qw = qc.words(low)
    subject = bool(qw & qc.MEASURE_WORDS) or bool(qc._topic(qw)) or bool(qw & {"products", "product", "customers", "customer"})  # noqa: SLF001
    return subject and (bool(_NEW_LEAD.match(low)) or bool(re.search(r"\binstead\b", low)))


def _add_to_plan(state: TurnState, ds: models.DataSource) -> dict:
    """"add Shopify" during a read-back, when Shopify is connected but wasn't offered: offer it, ticked."""
    b = dict(state.brief or {})
    opts = list(b.get("options") or [])
    if not any(o["id"] == ds.id for o in opts):
        opts.append({"id": ds.id, "name": ds.name, "kind": ds.kind, "label": KIND_LABELS.get(ds.kind, ds.kind), "why": "",
                     "fit": "unknown", "note": "", "says": "", "recommended": False})
    b["options"] = opts
    b["selected"] = list(dict.fromkeys(list(b.get("selected") or []) + [ds.id]))
    b["chosen"] = True
    if b.get("mode") == "shift":
        b["mode"] = None
    picked = [o for o in opts if o["id"] in set(b["selected"])]
    return _plan_reply(f"Added {ds.name}. Now: {eu.names_text(picked, limit=4)}. Anything else, or shall I go ahead?", state, b)


def _plan_turn(db: Session, user: models.User, text: str, state: TurnState, ws: str | None, intent: str) -> dict:
    b = dict(state.brief or {})
    opts = b.get("options") or []
    sel = list(b.get("selected") or [])

    m = _REPHRASE.match(text.strip())
    if m:
        if m.group(1) and len(m.group(1).split()) >= 2:
            return _new_question(db, user, m.group(1).strip(" .?!"), ws, _keep(state), "Okay, the new question:")
        st = _keep(state, awaiting="rephrase", pending_question=b.get("question"), brief=b)
        return _reply(f"Sure. You asked: “{b.get('question')}”. What should the question be?", "rephrase", st,
                      question=b.get("question"))

    if b.get("mode") == "shift":
        if eu.is_yes(text) or re.search(r"\b(do that|use (?:it|that|the latest)|latest)\b", text, re.I):
            sug = b.get("suggest") or {}
            b.update(mode=None, period=sug.get("period"), selected=[sug.get("source")] if sug.get("source") else [],
                     needs_pick=False, chosen=True)
            b["options"] = [o for o in opts if o["id"] == sug.get("source")] + [o for o in opts if o["id"] != sug.get("source")]
            return _plan_reply(_plan_say(b, "Okay."), state, b)
        if eu.is_no(text):
            b["mode"] = None
            b["options"] = _all_options(db, user, ws, opts)
            return _plan_reply(f"Okay. Which data should I use instead? {eu.numbered(b['options'])}", state, b)

    if _looks_new(text, opts):
        return _new_question(db, user, text, ws, _keep(state), "Okay, a new question.")

    r = eu.select_sources(text, opts, sel)
    op = r["op"]
    if op == "confirm" or (op == "unknown" and eu.is_yes(text)):
        if b.get("needs_pick") and not sel:
            return _plan_reply("Which one should I use? Say a number or a name - or 'all of them'.", state, b)
        return _run_plan(db, user, state, b, ws)
    if op in ("set", "change", "all", "none"):
        b["selected"] = r["selected"]
        b["chosen"] = True
        if b.get("mode") == "shift":
            b["mode"] = None  # their own pick replaces "use its latest window"
        picked = [o for o in opts if o["id"] in set(b["selected"])]
        if not picked:
            return _plan_reply("Okay, nothing picked yet. Which should I use? Say a number or a name.", state, b)
        fits = [o for o in picked if o.get("fit") in ("no_dates", "out_of_range")]
        warn = f" Heads up: {fits[0]['name']} has {fits[0]['note']}." if fits and fits[0].get("note") else ""
        say = f"Got it: {eu.names_text(picked, limit=4)}.{warn} Anything to add, or shall I go ahead?"
        return _plan_reply(say, state, b)
    if op == "more":
        b["options"] = _all_options(db, user, ws, opts)
        b["all_shown"] = True
        return _plan_reply(f"Here's all your data. {eu.numbered(b['options'], limit=6)} Which would you like?", state, b)
    if op == "recommend":
        best = next((o for o in opts if o.get("fit") == "good" and o.get("recommended")), None) or \
            next((o for o in opts if o.get("fit") == "good"), None) or (opts[0] if opts else None)
        if not best:
            return _plan_reply("I don't have a clear favourite here. Say 'show all' and I'll list everything you have.", state, b)
        b["selected"] = [best["id"]]
        b["chosen"] = True
        says = best.get("says") or ""
        reason = says[len(best["name"]):].strip() if says.startswith(best["name"]) else (best.get("note") or "")
        return _plan_reply(f"I'd go with {best['name']}{' - it ' + reason if reason else ''}. Shall I use that?", state, b)

    # not about the data: a new period? a no? a new question?
    p, alts = qc.parse_period(text, _today())
    if p:
        b["period"] = p
        b["period_options"] = ([p] + alts) if alts else []
        return _plan_reply(_plan_say(b, "Okay."), state, b)
    if re.search(r"\b(rolling|up to today|including this month|to date)\b", text, re.I) and b.get("period_options"):
        alt = next((x for x in b["period_options"] if x.get("key") == "rolling"), None)
        if alt:
            b["period"] = alt
            return _plan_reply(_plan_say(b, "Okay."), state, b)
    if eu.is_no(text):
        return _plan_reply("No problem. What should I change - the data, the dates, or the question? Or ask me something new.",
                           state, b)
    if intent == "question" and len(text.split()) > 4:
        return _new_question(db, user, text, ws, _keep(state))
    if state.retries >= 2:
        return _reply("Let's leave that one. Ask me again whenever you're ready.", "chat", _keep(state))
    st = _keep(state, awaiting="plan", pending_question=b.get("question"), brief=b, retries=state.retries + 1)
    return _reply("Sorry, I didn't get that. Say a number like 'one and three', a name, 'show all', or 'go ahead'.",
                  "plan", st, plan=_talk_card(b), title=_title_of(b))


def _fix_date_turn(db: Session, user: models.User, text: str, state: TurnState, ws: str | None) -> dict:
    b = state.brief or {}
    issue = b.get("issue") or {}
    q = b.get("question") or state.pending_question or ""
    raw = issue.get("said") or ""
    value = None
    m = re.search(r"\b(19\d\d|20\d\d)\b", text)
    mo = re.search(rf"\b{qc.MONTH_RE}\b", text.lower()) if issue.get("kind") == "month_typo" else None
    said = text.strip().strip(".!?").lower()
    if raw and (said == raw.lower() or re.search(r"\b(keep (?:it|that|as)|as (?:i )?(?:wrote|said) it|as written)\b", said)):
        value = raw  # "Keep as written" / "Keep 2027 - it's a forecast"
    elif mo:
        # a month typo answered with a month (and maybe a year): "yes, March 2025" fixes the month only
        value = qc.MONTHS[qc.MONTH_NUM[mo.group(0)[:3]] - 1].title()
    elif m:
        value = m.group(1)
    elif eu.is_yes(text) and issue.get("options"):
        value = issue["options"][0]["value"]
    elif issue.get("kind") == "month_typo" and eu.is_no(text):
        value = raw
    elif issue.get("kind") == "future_year" and re.search(r"\b(keep|forecast|predict|future|no)\b", text, re.I):
        value = raw
    if not value:
        if state.retries >= 1:
            return _reply("Let's try again - ask the question with the year you meant.", "chat", _keep(state))
        st = state.model_copy(update={"retries": state.retries + 1})
        opts = _or([o["label"] for o in issue.get("options") or []][:3])
        return _reply(f"Which year did you mean - {opts}?", "fix_date", st, issue=issue)
    fixed = qc.apply_fixes(q, {raw: value}) if value != raw else q
    lead = f"Got it - {value}." if value != raw else "Okay, keeping it as you said."
    accepted = list(b.get("accepted") or [])
    if value == raw:
        accepted.append(raw)  # never asked about again in this question
    return _new_question(db, user, fixed, ws, _keep(state), lead, accepted=accepted)


def _or(items: list[str]) -> str:
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + " or " + items[-1] if items else ""


def _needs_input_turn(db: Session, user: models.User, run_id: str, state: TurnState, ws: str | None) -> dict:
    """The answer came back "these sources can't answer that": say why, offer other data."""
    run, conv = projects._run(db, run_id, user)  # noqa: SLF001
    used = list(conv.source_ids or [])
    names = [s.name for s in db.query(models.DataSource).filter(models.DataSource.id.in_(used)).all()] if used else []
    missing = str(((run.result or {}).get("answer") or {}).get("answer") or "").strip()
    try:
        c = qc.check(db, user, run.question, workspace_id=ws, coverage=False, today=_today())
    except Exception:  # noqa: BLE001
        c = {"candidates": [], "what": "the answer", "period": None, "needs_time": False, "topic": None, "connect": []}
    better = [_opt(x) for x in c.get("candidates") or [] if x["id"] not in used and x.get("fit") == "good"]
    b = {"question": run.question, "what": c.get("what"), "period": c.get("period"), "needs_time": c.get("needs_time"),
         "topic": c.get("topic"), "connect": c.get("connect") or [], "selected": [], "needs_pick": True, "mode": None,
         "period_options": c.get("period_options") or []}
    b["options"] = [o for o in _all_options(db, user, ws, better) if o["id"] not in used]
    why = eu.first_sentences(missing, 1, 220)
    lead = f"I couldn't answer that from {eu.names_text([{'name': n} for n in names]) or 'that data'}"
    lead += f": {why[0].lower() + why[1:]}" if why else "."
    if not lead.endswith("."):
        lead += "."
    if not b["options"]:
        # nothing else to try here: say how to bring the data in
        conn = (b["connect"] or [{"kind": None, "label": "a file", "url": "/data?tab=catalog&upload=1"}])[0]
        st = _keep(state, awaiting="connect", pending_question=run.question, connect=conn)
        either = "" if re.search(r"\bnone of your\b", lead, re.I) else " None of your other data has it either."
        say = f"{lead}{either} You can connect a source that has it, or upload a file."
        return _reply(say, "connect_offer", st, connect=conn)
    say = f"{lead} Want me to try other data? {eu.numbered(b['options'])}"
    if b["connect"]:
        say += f" Or say 'connect {b['connect'][0]['label']}', or 'upload a file'."
    return _plan_reply(say, state, b)


# ---- talks (saved conversations) -----------------------------------------------------------------

def _talk(db: Session, user: models.User, talk_id: str | None) -> models.Conversation | None:
    if not talk_id:
        return None
    c = db.get(models.Conversation, talk_id)
    if not c or c.kind != "voice" or c.owner_id != user.id:
        return None
    return c


def _talk_meta(c: models.Conversation) -> dict:
    return dict(c.thread_meta or {})


_last_at: dict[str, datetime] = {}


def _log(db: Session, talk: models.Conversation, role: str, text: str, card: dict | None = None) -> None:
    # strictly increasing times, so two turns written together never swap places
    now = datetime.utcnow()
    prev = _last_at.get(talk.id)
    if prev and now <= prev:
        now = prev + timedelta(microseconds=1000)
    _last_at[talk.id] = now
    if len(_last_at) > 2000:
        _last_at.clear()
    db.add(models.Message(conversation_id=talk.id, role=role, content=(text or "…")[:4000], created_at=now,
                          chart_spec={"euliv": card} if card else None))


def _card_of(out: dict) -> dict | None:
    a = out.get("action")
    if a == "plan" and out.get("plan"):
        return out["plan"]
    if a == "rephrase":
        return {"type": "rephrase", "question": out.get("question") or ""}
    if a == "fix_date" and out.get("issue"):
        return {"type": "fix_date", "issue": out["issue"]}
    if a in ("connect", "connect_offer") and out.get("connect"):
        return {"type": "connect", "connect": out["connect"]}
    if a == "explain" and out.get("explain"):
        return {"type": "explain", **out["explain"]}
    if a == "run" and out.get("run_id"):
        return {"type": "working", "run_id": out["run_id"], "project_id": out.get("project_id"), "sources": out.get("sources") or []}
    return None


def _record(db: Session, user: models.User, payload: TurnRequest, said: str, out: dict) -> dict:
    """Keeps the talk: created at the first real question, then every turn both ways."""
    if not payload.save:
        return out
    a = out.get("action")
    talk = _talk(db, user, payload.state.talk_id)
    meaningful = a in ("plan", "fix_date", "rephrase", "run", "explain", "connect", "connect_offer", "connect_wait") or bool(talk)
    if not meaningful:
        return out
    if not talk:
        talk = models.Conversation(owner_id=user.id, kind="voice", title=out.get("title") or "Talk with Euliv",
                                   workspace_id=payload.workspace_id, thread_meta={"questions": 0, "runs": [], "sources": []})
        db.add(talk)
        db.flush()
        _log(db, talk, "assistant", payload.greeting or hello_text(user))
    meta = _talk_meta(talk)
    if said:
        _log(db, talk, "user", said)
    _log(db, talk, "assistant", out.get("say") or "", _card_of(out))
    if out.get("title") and (talk.title in (None, "", "Talk with Euliv") or a == "plan" and not meta.get("titled")):
        talk.title = out["title"]
        meta["titled"] = True
    if a == "run":
        meta["questions"] = int(meta.get("questions") or 0) + 1
        meta["runs"] = (list(meta.get("runs") or []) + [out.get("run_id")])[-60:]
        names = [s.get("name") for s in out.get("sources") or [] if s.get("name")]
        meta["sources"] = list(dict.fromkeys(list(meta.get("sources") or []) + names))[:8]
        # a talk stays private to its person: it never carries a datasource_id,
        # which is what would share it with everyone who can open that source
    meta["state"] = out.get("state")
    talk.thread_meta = meta
    flag_modified(talk, "thread_meta")
    db.commit()
    out["talk_id"] = talk.id
    out["talk_title"] = talk.title
    if isinstance(out.get("state"), dict):
        out["state"]["talk_id"] = talk.id
    return out


# ---- endpoints ---------------------------------------------------------------------------------

@router.get("/hello")
def hello(talk_id: str | None = None, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    talk = _talk(db, user, talk_id)
    if talk:
        n = first_name(user)
        say = f"Welcome back{', ' + n if n else ''}. Last time we looked at {talk.title.split(' · ')[0].lower()}. What would you like next?"
        return {"say": say, "first_name": n}
    return {"say": hello_text(user), "first_name": first_name(user)}


@router.post("/turn")
def turn(payload: TurnRequest, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    said = (payload.text or "").strip()
    _TODAY.set(local_today(payload.today))
    out = _turn(db, user, payload)
    return _record(db, user, payload, said, out)


def _turn(db: Session, user: models.User, payload: TurnRequest) -> dict:
    state = payload.state
    text = eu.strip_wake(payload.text)
    ws = payload.workspace_id

    if payload.event == "needs_input" and payload.run_id:
        return _needs_input_turn(db, user, payload.run_id, state, ws)
    if payload.event == "rephrase" and (payload.text or "").strip():
        # the question was edited in the read-back card: check the new wording from the start
        return _new_question(db, user, eu.strip_wake(payload.text), ws, _keep(state), "Okay, with your edit:")
    if payload.event == "confirm" and state.awaiting == "plan" and state.brief:
        b = dict(state.brief)
        b["chosen"] = True
        if b.get("mode") == "shift" and not b.get("selected"):
            # "Use its latest window" was left as the choice
            sug = b.get("suggest") or {}
            b.update(mode=None, period=sug.get("period") or b.get("period"),
                     selected=[sug["source"]] if sug.get("source") else [], needs_pick=False)
        elif b.get("mode") == "shift":
            b["mode"] = None  # they ticked their own data instead
        if b.get("needs_pick") and not b.get("selected"):
            return _plan_reply("Pick at least one source first.", state, b)
        return _run_plan(db, user, state, b, ws)

    # the source Euliv offered was just connected: answer the waiting question with it
    if payload.event == "connected" and state.pending_question:
        kind = (state.connect or {}).get("kind")
        q = state.pending_question
        fresh = [s for s in accessible_sources(db, user, ws) if not kind or s.kind == kind]
        if fresh:
            return _new_question(db, user, q, ws, _keep(state), f"{fresh[0].name} is connected.")
        return _reply("I don't see it connected yet. Finish connecting in the other tab and I'll carry on.", "connect_wait", state)

    kind = eu.intent(text)
    # "no" while Euliv is waiting on an answer from the person is an answer, not goodbye
    if kind == "end" and state.awaiting in ("plan", "fix_date", "connect", "connecting", "rephrase") and not eu.firm_end(text):
        kind = "question"
    if kind == "end":
        return _reply("Okay. Talk soon!", "end", _keep(state))
    if not text:
        return _reply(hello_text(user), "chat", state)

    # ---- "connect Google Ads" / "upload a file" -----------------------------------
    # round 25b: during a read-back, "add Shopify" names data to pick - not an app to connect
    in_plan = state.awaiting == "plan" and bool(state.brief)
    if in_plan:
        b0 = state.brief or {}
        r0 = eu.select_sources(text, b0.get("options") or [], list(b0.get("selected") or []))
        if r0["op"] in ("set", "change"):
            return _plan_turn(db, user, text, state, ws, kind)
    want = eu.connect_request(text)
    if want:
        from ..services import synced_sources
        label = KIND_LABELS.get(want, want)
        have = [s for s in accessible_sources(db, user, ws) if s.kind == want]
        if have and in_plan:
            return _add_to_plan(state, have[0])
        if have:
            return _reply(f"{label} is already connected as {have[0].name}. Ask me anything about it.", "chat", state)
        c = {"kind": want, "label": label,
             "url": f"/data?tab=catalog&connect={want}" if want in synced_sources.APPS else "/data?tab=catalog"}
        st = _keep(state, awaiting="connecting", pending_question=state.pending_question, connect=c)
        return _reply(f"Tap “Connect {label}” to open it in a new tab. Connect it there and come back - I'll carry on by myself.",
                      "connect", st, connect=c)
    if re.search(r"\b(upload|add) (?:a |my |the )?(?:file|spreadsheet|csv|excel)\b", text, re.I):
        c = {"kind": None, "label": "a file", "url": "/data?tab=catalog&upload=1"}
        st = _keep(state, awaiting="connecting", pending_question=state.pending_question, connect=c)
        return _reply("Tap “Upload a file” to add it in a new tab. Come back when it's in - I'll carry on by myself.",
                      "connect", st, connect=c)
    target = eu.connect_target(text)
    if target:
        named = [s for s in accessible_sources(db, user, ws) if eu._says(target, s.name)  # noqa: SLF001
                 or (len(target.strip()) >= 6 and f" {target.strip()} " in eu._norm(s.name))]  # noqa: SLF001
        if named and in_plan:
            return _add_to_plan(state, named[0])
        if named:
            return _reply(f"{named[0].name} is already connected. Ask me anything about it.", "chat", state)

    # ---- answering what Euliv asked -----------------------------------------------
    if state.awaiting == "fix_date" and state.brief:
        return _fix_date_turn(db, user, text, state, ws)
    if state.awaiting == "rephrase":
        if eu.is_no(text) or re.fullmatch(r"(?:keep it|leave it|it'?s fine|never ?mind)[\s.!]*", text.strip(), re.I):
            b = dict(state.brief or {})
            if b:
                return _plan_reply(_plan_say(b, "Okay, keeping it."), state, b)
        return _new_question(db, user, text, ws, _keep(state), "Okay.")
    if state.awaiting == "plan" and state.brief:
        return _plan_turn(db, user, text, state, ws, kind)
    if state.awaiting in ("connect", "connecting") and state.pending_question:
        c = state.connect or {}
        if eu.wants_connected(text):
            return _new_question(db, user, state.pending_question, ws, _keep(state))
        if eu.is_no(text):
            have = bool(accessible_sources(db, user, ws))
            say = ("No problem. I can answer from the data you already have - just ask." if have
                   else "No problem. Connect a source from Data whenever you're ready.")
            return _reply(say, "chat", _keep(state))
        if eu.is_yes(text):
            st = state.model_copy(update={"awaiting": "connecting"})
            return _reply(f"Tap “Connect {c.get('label') or 'it'}” to open it in a new tab. Connect it there and come back - "
                          "I'll carry on by myself.", "connect", st, connect=c)
        if kind == "question" and len(text.split()) > 3:
            return _new_question(db, user, text, ws, _keep(state))

    # ---- small talk -----------------------------------------------------------
    if kind == "greeting":
        return _reply(hello_text(user), "chat", state)
    if kind == "thanks":
        return _reply("You're welcome. Anything else?", "chat", state)
    if kind == "ack":
        return _reply("Okay. Anything else I can look at?", "chat", state)
    if kind == "help":
        return _reply("Ask me about your business in plain words - like 'how is my e-commerce doing over the last 3 months', "
                      "'what were sales last month', or 'why did revenue drop'. I'll read it back, check which of your data "
                      "can answer it, and only then work it out.", "chat", state)

    return _new_question(db, user, text, ws, state)


def _deliver(db: Session, user: models.User, talk_id: str | None, run_id: str, out: dict) -> None:
    """Adds a finished answer to its talk, once."""
    talk = _talk(db, user, talk_id)
    if not talk:
        return
    meta = _talk_meta(talk)
    done = list(meta.get("delivered") or [])
    if run_id in done:
        return
    card = {"type": "answer", "run_id": run_id, "status": out.get("status"), "link": out.get("link"),
            "card": out.get("card"), "missing": out.get("missing")}
    _log(db, talk, "assistant", out.get("say") or "", card)
    meta["delivered"] = (done + [run_id])[-100:]
    talk.thread_meta = meta
    flag_modified(talk, "thread_meta")
    db.commit()


@router.get("/answer/{run_id}")
def answer(run_id: str, talk_id: str | None = None, db: Session = Depends(get_db),
           user: models.User = Depends(get_current_user)):
    out = _answer(db, user, run_id)
    if out.get("status") != "working":
        _deliver(db, user, talk_id, run_id, out)
    return out


def _answer(db: Session, user: models.User, run_id: str) -> dict:
    run, conv = projects._run(db, run_id, user)  # noqa: SLF001 - same access rules as the thread page
    link = f"/p/{conv.id}?run={run.id}"
    steps = run.steps or []
    if run.status in ("planning", "running", "planned"):
        done = sum(1 for s in steps if s.get("status") == "done")
        stage = ("Working out which data to use" if run.status == "planning"
                 else f"Running the numbers ({done} of {len(steps)})" if steps else "Running the numbers")
        return {"status": "working", "stage": stage, "done": done, "total": len(steps), "link": link}
    if run.status == "needs_input":
        missing = str(((run.result or {}).get("answer") or {}).get("answer") or "").strip()
        say = "That data can't answer it yet."
        return {"status": "needs_input", "say": say, "speak": say, "missing": missing[:600], "link": link,
                "project_id": conv.id}
    if run.status == "failed":
        msg = (run.error_message or "").split("\n")[0].split(" Details:")[0].strip()
        technical = not msg or len(msg) > 160 or any(w in msg.lower() for w in ("sql", "query", "table", "column", "traceback", "error:"))
        say = ("I couldn't work that one out from your data. Try asking it another way, or pick different data."
               if technical else f"I couldn't finish that one. {msg}")
        return {"status": "failed", "say": say, "speak": eu.speakable(say), "detail": (run.error_message or "")[:400], "link": link}
    if run.status != "done":
        return {"status": run.status, "say": "That one was stopped before it finished.",
                "speak": "That one was stopped before it finished.", "link": link}
    result = run.result or {}
    ans = result.get("answer") or {}
    head = str(ans.get("headline") or "").strip()
    body = str(ans.get("answer") or "").strip()
    first = eu.first_sentences(body, 2, 300)
    say = head if head and first.startswith(head[:40]) else " ".join(x for x in (head, first) if x)
    say = say or "Here's what I found."
    kpis = [{"label": k.get("label"), "display": k.get("display"), "delta": k.get("delta"), "dir": k.get("delta_dir"),
             "note": k.get("note")} for k in (result.get("kpis") or [])[:4]]
    # out loud: the gist in two sentences - the whole answer is on screen
    return {
        "status": "done", "say": say, "speak": eu.speakable(eu.first_sentences(say, 2, 260)), "link": link, "project_id": conv.id,
        "card": {"headline": head or None, "answer": body[:900] or None, "kpis": kpis,
                 "next_questions": [str(q) for q in (ans.get("next_questions") or [])][:3],
                 "sources_used": result.get("sources_used") or [], "question": run.question,
                 "period": ((run.plan or {}).get("brief") or {}).get("period") if isinstance(run.plan, dict) else None},
    }


@router.get("/connected")
def connected(kind: str | None = None, workspace_id: str | None = None, since: str | None = None,
              db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    rows = [s for s in accessible_sources(db, user, workspace_id) if not kind or s.kind == kind]
    after = None
    if since:
        try:
            after = datetime.fromisoformat(since.replace("Z", "+00:00")).replace(tzinfo=None)
        except ValueError:
            after = None
    if after is None and not kind:
        after = datetime.utcnow() - timedelta(minutes=30)
    if after is not None:
        # only a source added since Euliv offered it counts
        rows = [s for s in rows if s.created_at and s.created_at >= after]
    return {"connected": bool(rows), "source": eu.source_out(rows[0]) if rows else None,
            "label": KIND_LABELS.get(kind, kind) if kind else None}


@router.get("/memory")
def memory(db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    rows = db.query(models.AssistantMemory).filter(models.AssistantMemory.user_id == user.id,
                                                   models.AssistantMemory.key.like("topic:%")).all()
    usable = {s.id: s for s in accessible_sources(db, user)}
    labels = {t["key"]: t["label"] for t in eu.TOPICS} | qc.TOPIC_LABEL
    out = []
    for r in rows:
        topic = r.key.split(":", 1)[1]
        srcs = [eu.source_out(usable[i]) for i in (r.value or {}).get("source_ids") or [] if i in usable]
        if srcs:
            out.append({"topic": topic, "label": labels.get(topic, topic), "sources": srcs, "updated_at": r.updated_at})
    return out


@router.delete("/memory")
def forget(topic: str | None = None, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    n = eu.forget(db, user, topic)
    db.commit()
    return {"forgotten": n}


@router.get("/talks/{talk_id}")
def get_talk(talk_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    talk = _talk(db, user, talk_id)
    if not talk:
        raise HTTPException(404, "Talk not found.")
    msgs = sorted(talk.messages, key=lambda m: m.created_at or datetime.min)
    meta = _talk_meta(talk)
    return {
        "id": talk.id, "title": talk.title, "created_at": talk.created_at,
        "updated_at": msgs[-1].created_at if msgs else talk.created_at, "workspace_id": talk.workspace_id,
        "questions": int(meta.get("questions") or 0), "sources": meta.get("sources") or [], "state": meta.get("state"),
        "messages": [{"id": m.id, "role": m.role, "text": m.content, "at": m.created_at,
                      "card": (m.chart_spec or {}).get("euliv") if isinstance(m.chart_spec, dict) else None} for m in msgs],
    }


class TalkPatch(BaseModel):
    title: str = Field(min_length=1, max_length=80)


@router.patch("/talks/{talk_id}")
def rename_talk(talk_id: str, payload: TalkPatch, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    talk = _talk(db, user, talk_id)
    if not talk:
        raise HTTPException(404, "Talk not found.")
    talk.title = payload.title.strip()
    meta = _talk_meta(talk)
    meta["titled"] = True
    talk.thread_meta = meta
    flag_modified(talk, "thread_meta")
    db.commit()
    return {"id": talk.id, "title": talk.title}


@router.delete("/talks/{talk_id}")
def delete_talk(talk_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    talk = _talk(db, user, talk_id)
    if not talk:
        raise HTTPException(404, "Talk not found.")
    db.delete(talk)
    db.commit()
    return {"deleted": True}
