"""
/assistant - Euliv, the GD360 voice assistant (2026-10-11).

  GET    /assistant/hello              "Hi Gokul, how can I help you?"
  POST   /assistant/turn               one thing the person said -> what Euliv says and does next
  GET    /assistant/answer/{run_id}    a question being answered: progress, then what to say + the answer card
  GET    /assistant/connected?kind=    has the source Euliv offered to connect been connected yet?
  GET    /assistant/memory             the sources Euliv remembers per topic ("marketing" -> Google Ads, Meta Ads)
  DELETE /assistant/memory?topic=      forget one topic (or all)

The browser turns speech into words and speaks Euliv's replies; only the
words reach here. The conversation's state lives with the browser and comes
back on every turn (`state`), so a turn is stateless on the server and a
dropped connection never leaves a half-finished conversation behind.

Answers come from the same engine as typed questions: a new question is a
Quick-answer project (routers/projects.create_project); a follow-up in the
same conversation is asked in that project with route=true, so "why?" is
explained from the numbers already computed instead of re-running.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import models
from ..database import get_db
from ..deps import get_current_user
from ..services import assistant as eu
from ..services.project_engine.catalog import KIND_LABELS, accessible_sources
from . import projects

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/assistant", tags=["assistant"])

FOLLOW_UP = (
    "why", "how come", "what about", "and ", "compare", "break", "split", "show", "which", "who", "what drove",
    "what caused", "explain", "tell me more", "more", "and what", "how about", "same for", "last", "previous",
    "by ", "per ", "what was", "is that", "was that", "what's driving", "whats driving",
)


def first_name(user: models.User) -> str:
    name = (user.full_name or "").strip()
    if name:
        return name.split()[0][:30]
    local = (user.email or "").split("@")[0]
    local = local.split(".")[0].split("_")[0]
    letters = "".join(ch for ch in local if ch.isalpha())
    return letters[:1].upper() + letters[1:20] if len(letters) >= 2 else ""


def hello_text(user: models.User) -> str:
    n = first_name(user)
    return f"Hi {n}, how can I help you?" if n else "Hi, how can I help you?"


class TurnState(BaseModel):
    awaiting: str | None = None           # choose | connect | connecting | None
    pending_question: str | None = Field(default=None, max_length=2000)
    candidates: list[dict] = Field(default_factory=list, max_length=12)
    connect: dict | None = None
    project_id: str | None = None
    last_run_id: str | None = None
    topic: str | None = None
    retries: int = 0


class TurnRequest(BaseModel):
    text: str = Field(default="", max_length=2000)
    state: TurnState = Field(default_factory=TurnState)
    workspace_id: str | None = None
    # "connected": the source Euliv offered has just been connected (the
    # browser saw it) - carry on with the question that was waiting for it
    event: str | None = None


def _reply(say: str, action: str, state: TurnState, **extra) -> dict:
    return {"say": say, "speak": eu.speakable(say), "action": action, "state": state.model_dump(), **extra}


def _err_text(e: HTTPException) -> str:
    d = e.detail if isinstance(e.detail, str) else "That didn't work"
    if e.status_code == 429:
        return "You're asking a bit fast - give me a few seconds and ask again."
    if e.status_code == 403:
        return "You can only view those sources, so I can't run a new analysis on them. Ask an editor for access."
    return d.rstrip(".") + "."


def _start(db: Session, user: models.User, question: str, source_ids: list[str] | None, workspace_id: str | None,
           state: TurnState, picked: list[dict] | None = None) -> dict:
    """A new question -> a Quick-answer project."""
    try:
        out = projects.create_project(
            projects.CreateProjectRequest(question=question, source_ids=source_ids or None,
                                          workspace_id=workspace_id, mode="answer"),
            db=db, user=user,
        )
    except HTTPException as e:
        st = TurnState(project_id=state.project_id, last_run_id=state.last_run_id, topic=state.topic)
        return _reply(_err_text(e), "chat", st)
    names = eu.names_text(picked or [])
    say = f"Okay, looking at {names}." if names else "Okay, let me look into that."
    st = TurnState(project_id=out["project_id"], last_run_id=out["run_id"], topic=state.topic)
    return _reply(say, "run", st, run_id=out["run_id"], project_id=out["project_id"], question=question,
                  sources=picked or [])


def _follow_up(db: Session, user: models.User, question: str, state: TurnState) -> dict | None:
    """A follow-up in the conversation's project; None when it should be a new question."""
    try:
        out = projects.ask(
            state.project_id,
            projects.AskRequest(question=question, route=True, context_run_id=state.last_run_id),
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
        return _reply(eu.first_sentences(say, 3, 420), "explain", state, explain={
            "headline": ex.get("headline"), "points": ex.get("points") or [], "takeaway": ex.get("takeaway"),
            "followups": ex.get("followups") or [],
            "link": f"/p/{state.project_id}?run={state.last_run_id}" if state.last_run_id else f"/p/{state.project_id}",
        })
    st = TurnState(project_id=state.project_id, last_run_id=out["run_id"], topic=state.topic)
    return _reply("Okay, let me look into that.", "run", st, run_id=out["run_id"], project_id=state.project_id,
                  question=question)


def _is_follow_up(text: str, state: TurnState, res: dict | None) -> bool:
    if not state.project_id or not state.last_run_id:
        return False
    low = text.lower().strip()
    if res and res.get("why") == "named":
        return False  # a source was named - a fresh question on it
    if res and res.get("topic") and state.topic and res["topic"] != state.topic:
        return False  # a different subject
    if low.startswith(FOLLOW_UP):
        return True  # "why", "what about last quarter", "break it down by channel" ...
    words = low.split()
    if res and res.get("topic"):
        # a subject of its own: a follow-up only when it's the conversation's subject
        return res["topic"] == state.topic and len(words) <= 9
    return len(words) <= 6


def _new_question(db: Session, user: models.User, question: str, workspace_id: str | None, state: TurnState) -> dict:
    res = eu.resolve(db, user, question, workspace_id)
    if _is_follow_up(question, state, res):
        out = _follow_up(db, user, question, state)
        if out:
            return out
    topic = res.get("topic")
    base = TurnState(project_id=state.project_id, last_run_id=state.last_run_id, topic=topic or state.topic)
    status = res["status"]
    if status == "ok":
        picked = res.get("sources") or []
        out = _start(db, user, question, [s["id"] for s in picked], workspace_id, base, picked)
        if res.get("why") == "schema" and out["action"] == "run" and res.get("connect"):
            # nothing made for this topic is connected - say what is being used and how to add the real thing
            app = res["connect"]["label"]
            out["say"] = (f"{app} isn't connected, so I'm using {eu.names_text(picked)}, which has "
                          f"{res.get('topic_label') or 'related'} data. Say 'connect {app}' any time to add it.")
            out["speak"] = eu.speakable(out["say"])
        return out
    if status == "choose":
        cands = res["candidates"]
        names = eu.names_text(cands, limit=4)
        st = base.model_copy(update={"awaiting": "choose", "pending_question": question, "candidates": cands, "retries": 0})
        what = f"your {res['topic_label']} numbers" if res.get("topic_label") else "that"
        n = len(cands)
        tail = "Which should I use - or both?" if n == 2 else "Which should I use - one, a few, or all of them?"
        return _reply(f"I can see {what} in {names}. {tail}", "choose", st, candidates=cands)
    if status == "connect":
        c = res.get("connect") or {}
        st = base.model_copy(update={"awaiting": "connect", "pending_question": question, "connect": c, "retries": 0})
        label = c.get("label") or "a data source"
        if not res.get("any_sources"):
            say = (f"You haven't connected any data yet. Shall I open {label} so you can connect it? It takes about a minute."
                   if c.get("kind") else "You haven't connected any data yet. Shall I open the data catalog so you can connect a source?")
        else:
            what = f"your {res['topic_label']} numbers" if res.get("topic_label") else "that"
            say = (f"{label} isn't connected yet, and that's where {what} live. Shall I connect it now? "
                   "Or say 'use what's connected' and I'll try with the data you have.")
        return _reply(say, "connect_offer", st, connect=c)
    if status == "none":
        return _reply(f"I couldn't find {res.get('missing')} among the sources you can use. "
                      "You can connect it from Data, or ask me about the data you have.", "chat", base)
    return _start(db, user, question, None, workspace_id, base)


@router.get("/hello")
def hello(user: models.User = Depends(get_current_user)):
    return {"say": hello_text(user), "first_name": first_name(user)}


@router.post("/turn")
def turn(payload: TurnRequest, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    state = payload.state
    text = eu.strip_wake(payload.text)
    ws = payload.workspace_id

    # the source Euliv offered was just connected: answer the waiting question with it
    if payload.event == "connected" and state.pending_question:
        kind = (state.connect or {}).get("kind")
        q = state.pending_question
        fresh = [s for s in accessible_sources(db, user, ws) if not kind or s.kind == kind]
        if fresh:
            picked = [eu.source_out(fresh[0])]
            if state.topic:
                eu.remember(db, user, state.topic, [fresh[0].id])
                db.commit()
            out = _start(db, user, q, [fresh[0].id], ws, TurnState(topic=state.topic), picked)
            out["say"] = f"{picked[0]['name']} is connected. " + out["say"]
            out["speak"] = eu.speakable(out["say"])
            return out
        return _reply("I don't see it connected yet. Finish connecting in the other tab and I'll carry on.", "connect_wait", state)

    kind = eu.intent(text)
    if kind == "end":
        return _reply("Okay. Talk soon!", "end", TurnState())
    if not text:
        return _reply(hello_text(user), "chat", state)

    # ---- answering a question Euliv asked -----------------------------------
    if state.awaiting == "choose" and state.candidates:
        picked = None if kind == "question" and eu.topic_of(text) and len(text.split()) > 5 else eu.choose(text, state.candidates)
        if picked is None and eu.wants_connected(text):
            picked = list(state.candidates)
        if picked:
            if state.topic:
                eu.remember(db, user, state.topic, [c["id"] for c in picked])
                db.commit()
            base = TurnState(project_id=state.project_id, last_run_id=state.last_run_id, topic=state.topic)
            return _start(db, user, state.pending_question or text, [c["id"] for c in picked], ws, base, picked)
        if kind == "question" and len(text.split()) > 4:
            return _new_question(db, user, text, ws, TurnState(project_id=state.project_id, last_run_id=state.last_run_id))
        if state.retries >= 1:
            return _reply("Let's leave that for now. Ask me again whenever you're ready.", "chat",
                          TurnState(project_id=state.project_id, last_run_id=state.last_run_id))
        st = state.model_copy(update={"retries": state.retries + 1})
        return _reply(f"Sorry, which one - {eu.names_text(state.candidates, limit=4).replace(' and ', ' or ')}? "
                      "You can also say all of them.", "choose", st, candidates=state.candidates)

    if state.awaiting in ("connect", "connecting") and state.pending_question:
        c = state.connect or {}
        if eu.wants_connected(text):
            base = TurnState(project_id=state.project_id, last_run_id=state.last_run_id, topic=state.topic)
            return _start(db, user, state.pending_question, None, ws, base)
        if eu.is_no(text):
            have = bool(accessible_sources(db, user, ws))
            say = ("No problem. I can answer from the data you already have - just ask." if have
                   else "No problem. Connect a source from Data whenever you're ready.")
            return _reply(say, "chat", TurnState(project_id=state.project_id, last_run_id=state.last_run_id))
        if eu.is_yes(text) or state.awaiting == "connecting":
            if state.awaiting == "connecting" and not eu.is_yes(text) and kind == "question":
                return _new_question(db, user, text, ws, TurnState(project_id=state.project_id, last_run_id=state.last_run_id))
            st = state.model_copy(update={"awaiting": "connecting"})
            label = c.get("label") or "the data catalog"
            return _reply(f"Opening {label} in a new tab. Connect it there and come back - I'll pick up where we left off.",
                          "connect", st, connect=c)
        if kind == "question" and len(text.split()) > 3:
            return _new_question(db, user, text, ws, TurnState(project_id=state.project_id, last_run_id=state.last_run_id))
        if state.retries >= 1:
            return _reply("Okay, let's skip that for now.", "chat", TurnState(project_id=state.project_id, last_run_id=state.last_run_id))
        st = state.model_copy(update={"retries": state.retries + 1})
        return _reply(f"Should I connect {c.get('label') or 'it'} now? Say yes, or no.", "connect_offer", st, connect=c)

    # ---- "connect Google Ads" ---------------------------------------------------
    want = eu.connect_request(text)
    if want:
        from ..services import synced_sources
        label = KIND_LABELS.get(want, want)
        have = [s for s in accessible_sources(db, user, ws) if s.kind == want]
        if have:
            return _reply(f"{label} is already connected as {have[0].name}. Ask me anything about it.", "chat", state)
        c = {"kind": want, "label": label,
             "url": f"/data?tab=catalog&connect={want}" if want in synced_sources.APPS else "/data?tab=catalog"}
        st = TurnState(project_id=state.project_id, last_run_id=state.last_run_id, awaiting="connecting",
                       pending_question=state.pending_question, connect=c, topic=state.topic)
        return _reply(f"Opening {label} in a new tab. Connect it there and come back - I'll be right here.", "connect", st, connect=c)

    target = eu.connect_target(text)
    if target:
        named = [s for s in accessible_sources(db, user, ws) if eu._says(target, s.name)  # noqa: SLF001
                 or (len(target.strip()) >= 6 and f" {target.strip()} " in eu._norm(s.name))]  # noqa: SLF001
        if named:
            return _reply(f"{named[0].name} is already connected. Ask me anything about it.", "chat", state)

    # ---- small talk -----------------------------------------------------------
    if kind == "greeting":
        return _reply(hello_text(user), "chat", state)
    if kind == "thanks":
        return _reply("You're welcome. Anything else?", "chat", state)
    if kind == "help":
        return _reply("Ask me about your business in plain words - like 'how is my marketing doing', 'what were sales last "
                      "month', or 'why did revenue drop'. I'll find the right data, work it out, and tell you. "
                      "If something isn't connected yet, I'll help you connect it.", "chat", state)

    return _new_question(db, user, text, ws, state)


@router.get("/answer/{run_id}")
def answer(run_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    run, conv = projects._run(db, run_id, user)  # noqa: SLF001 - same access rules as the thread page
    link = f"/p/{conv.id}?run={run.id}"
    steps = run.steps or []
    if run.status in ("planning", "running", "planned"):
        done = sum(1 for s in steps if s.get("status") == "done")
        stage = ("Working out which data to use" if run.status == "planning"
                 else f"Running the numbers ({done} of {len(steps)})" if steps else "Running the numbers")
        return {"status": "working", "stage": stage, "done": done, "total": len(steps), "link": link}
    if run.status == "failed":
        msg = (run.error_message or "").split("\n")[0].split(" Details:")[0].strip()
        technical = not msg or len(msg) > 160 or any(w in msg.lower() for w in ("sql", "query", "table", "column", "traceback", "error:"))
        say = ("I couldn't work that one out from your data. Try asking it another way - or open it to see what happened."
               if technical else f"I couldn't finish that one. {msg}")
        return {"status": "failed", "say": say, "speak": eu.speakable(say), "detail": (run.error_message or "")[:400], "link": link}
    if run.status != "done":
        return {"status": run.status, "say": "That one was stopped.", "speak": "That one was stopped.", "link": link}
    result = run.result or {}
    ans = result.get("answer") or {}
    head = str(ans.get("headline") or "").strip()
    body = str(ans.get("answer") or "").strip()
    first = eu.first_sentences(body, 2, 300)
    say = head if head and first.startswith(head[:40]) else " ".join(x for x in (head, first) if x)
    say = say or "Here's what I found."
    kpis = [{"label": k.get("label"), "display": k.get("display"), "delta": k.get("delta"), "dir": k.get("delta_dir"),
             "note": k.get("note")} for k in (result.get("kpis") or [])[:4]]
    return {
        "status": "done", "say": say, "speak": eu.speakable(say), "link": link, "project_id": conv.id,
        "card": {"headline": head or None, "answer": body[:900] or None, "kpis": kpis,
                 "next_questions": [str(q) for q in (ans.get("next_questions") or [])][:3],
                 "sources_used": result.get("sources_used") or [], "question": run.question},
    }


@router.get("/connected")
def connected(kind: str | None = None, workspace_id: str | None = None, db: Session = Depends(get_db),
              user: models.User = Depends(get_current_user)):
    rows = [s for s in accessible_sources(db, user, workspace_id) if not kind or s.kind == kind]
    return {"connected": bool(rows), "source": eu.source_out(rows[0]) if rows else None,
            "label": KIND_LABELS.get(kind, kind) if kind else None}


@router.get("/memory")
def memory(db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    rows = db.query(models.AssistantMemory).filter(models.AssistantMemory.user_id == user.id,
                                                   models.AssistantMemory.key.like("topic:%")).all()
    usable = {s.id: s for s in accessible_sources(db, user)}
    labels = {t["key"]: t["label"] for t in eu.TOPICS}
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
