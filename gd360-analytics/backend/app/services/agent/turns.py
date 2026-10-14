"""2026-10-14 (R46): one turn of the GD360 2.0 conversation.

A conversation is a models.Conversation of kind "project" whose thread_meta has
"v2": true, so routers/projects.py (runs, dashboards, explains) and the classic
page keep working on it. A turn that the project engine answers IS a ProjectRun;
every other turn (knowledge, document, automation, chat, a check that needs the
person, an explanation) is a models.Message with action "v2:<kind>" and its
state in chart_spec["v2"]. `turns_of` merges both in time order for the page.
"""
from __future__ import annotations

import threading
import traceback
from datetime import date, datetime

from fastapi import HTTPException
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from ... import models
from ...database import SessionLocal
from .. import ai_engine, ai_meter
from . import automations_tool, documents, intents, knowledge, plans, truth_guard

KINDS = ("knowledge", "data", "guided", "dashboard", "document", "automation", "chat", "check", "explain")


# ---- helpers ------------------------------------------------------------------

def _meta(conv: models.Conversation) -> dict:
    return dict(conv.thread_meta) if isinstance(conv.thread_meta, dict) else {}


def is_v2(conv: models.Conversation) -> bool:
    return bool(_meta(conv).get("v2"))


def _save_meta(db: Session, conv: models.Conversation, meta: dict) -> None:
    conv.thread_meta = meta
    flag_modified(conv, "thread_meta")
    db.commit()


def _state(msg: models.Message) -> dict:
    spec = msg.chart_spec if isinstance(msg.chart_spec, dict) else {}
    return dict(spec.get("v2") or {})


def _set_state(db: Session, msg: models.Message, **changes) -> dict:
    st = _state(msg) | changes
    msg.chart_spec = {"v2": st}
    flag_modified(msg, "chart_spec")
    if changes.get("text") is not None:
        msg.content = str(changes["text"])[:20000]
    db.commit()
    return st


def _new_turn(db: Session, conv: models.Conversation, kind: str, question: str, status: str = "working", **extra) -> models.Message:
    now = datetime.utcnow().isoformat() + "Z"
    msg = models.Message(conversation_id=conv.id, role="assistant", content="", action=f"v2:{kind}",
                         chart_spec={"v2": {"kind": kind, "status": status, "question": question, "started_at": now, **extra}})
    db.add(msg)
    db.commit()
    db.refresh(msg)
    return msg


def _bg(fn, message_id: str, user_id: str) -> None:
    def run():
        db = SessionLocal()
        token = ai_meter.set_context(user_id, "v2")
        try:
            msg = db.get(models.Message, message_id)
            user = db.get(models.User, user_id)
            if msg is None or user is None:
                return
            fn(db, msg, user)
        except Exception as e:  # noqa: BLE001 - a turn must always end
            traceback.print_exc()
            try:
                msg = db.get(models.Message, message_id)
                if msg is not None:
                    _set_state(db, msg, status="failed", error=ai_engine.friendly_ai_error(e), finished_at=datetime.utcnow().isoformat() + "Z")
            except Exception:  # noqa: BLE001
                db.rollback()
        finally:
            ai_meter.reset_context(token)
            db.close()
    threading.Thread(target=run, daemon=True, name=f"v2-{message_id[:8]}").start()


def _history(db: Session, conv: models.Conversation, limit: int = 8) -> list[dict]:
    """The last turns as plain chat history for the knowledge tool."""
    out = []
    for t in turns_of(db, conv, None, full=False)[-limit:]:
        if t.get("question"):
            out.append({"role": "user", "content": t["question"]})
        text = t.get("text") or (t.get("run") or {}).get("headline")
        if text:
            out.append({"role": "assistant", "content": text})
    return out


def _done_runs(db: Session, conv: models.Conversation) -> list[models.ProjectRun]:
    return (db.query(models.ProjectRun)
            .filter(models.ProjectRun.conversation_id == conv.id, models.ProjectRun.status == "done")
            .order_by(models.ProjectRun.created_at.asc()).all())


def _last_run(db: Session, conv: models.Conversation) -> models.ProjectRun | None:
    runs = _done_runs(db, conv)
    return runs[-1] if runs else None


def _knowledge_turns(db: Session, conv: models.Conversation) -> list[dict]:
    rows = (db.query(models.Message).filter(models.Message.conversation_id == conv.id, models.Message.action == "v2:knowledge")
            .order_by(models.Message.created_at.asc()).all())
    return [_state(m) for m in rows if _state(m).get("status") == "done"]


# ---- the tools --------------------------------------------------------------------

def _do_knowledge(db: Session, msg: models.Message, user: models.User) -> None:
    st = _state(msg)
    conv = db.get(models.Conversation, msg.conversation_id)
    hist = _history(db, conv)[:-2] if conv else []
    today = date.fromisoformat(st["today"]) if st.get("today") else date.today()
    out = knowledge.answer(st["question"], hist, today)
    _set_state(db, msg, status="done", text=out["text"], sources=out["sources"], grounded=out["grounded"], chips=out["chips"],
               provider=out.get("provider"), queries=out.get("queries") or [], elapsed_s=out.get("elapsed_s"),
               trail=[{"label": f"Searched: {q}"} for q in (out.get("queries") or [])[:3]] + [{"label": f"Read {len(out['sources'])} pages"}] if out["grounded"]
               else [{"label": "Answered from the model's knowledge"}],
               finished_at=datetime.utcnow().isoformat() + "Z")


_CHAT_HELP = (
    "I'm GD360. Ask me anything in plain words: a question about the world, a question about your data "
    "(\"why are customers leaving\", \"revenue by region last quarter\"), a what-if, a forecast, \"make that a dashboard\", "
    "\"write the board review\", or \"alert me if churn goes above 3%\". Switch to Step by step when you want to see and "
    "change every step."
)


def _do_chat(db: Session, msg: models.Message, user: models.User) -> None:
    q = _state(msg)["question"].strip().lower()
    if intents.CHAT.search(q) and any(w in q for w in ("what can you do", "who are you", "help", "how do")):
        text = _CHAT_HELP
    elif any(w in q for w in ("thank", "thx", "cheers")):
        text = "You're welcome. Ask the next one whenever you're ready."
    elif any(w in q for w in ("bye",)):
        text = "Bye for now. Your conversation is saved in the library."
    else:
        first = (user.full_name or "").split(" ")[0]
        text = f"Hi{' ' + first if first else ''}. What would you like to know?"
    _set_state(db, msg, status="done", text=text, chips=[], finished_at=datetime.utcnow().isoformat() + "Z")


def _do_document(db: Session, msg: models.Message, user: models.User) -> None:
    st = _state(msg)
    conv = db.get(models.Conversation, msg.conversation_id)
    runs = _done_runs(db, conv)
    know = _knowledge_turns(db, conv)
    out = documents.write(st["question"], runs, know)
    artifact = {"type": "document", "id": msg.id, "title": out["title"], "words": out["words"]}
    _set_state(db, msg, status="done", text=f"I wrote \"{out['title']}\" from the {len(runs) + len(know)} answer{'s' if len(runs) + len(know) != 1 else ''} in this conversation. It is open on the canvas; edit it there or tell me what to change.",
               document={"title": out["title"], "markdown": out["markdown"], "flagged": out["flagged"]},
               chips=([{"key": "numbers", "ok": True, "label": "Every figure comes from the answers above"}] if not out["flagged"]
                      else [{"key": "numbers", "ok": False, "label": f"{len(out['flagged'])} figure{'s' if len(out['flagged']) != 1 else ''} to check", "detail": ", ".join(out["flagged"])}]),
               artifacts=[artifact], trail=[{"label": f"Read {len(runs)} answers"}, {"label": "Wrote the draft"}, {"label": "Checked every figure"}],
               finished_at=datetime.utcnow().isoformat() + "Z")


def _do_automation(db: Session, msg: models.Message, user: models.User) -> None:
    st = _state(msg)
    conv = db.get(models.Conversation, msg.conversation_id)
    from ...routers.projects import _thread_dashboards
    dashboards = _thread_dashboards(db, conv, user)
    d = automations_tool.draft(db, user, st["question"], last_run=_last_run(db, conv), dashboards=dashboards,
                               timezone=st.get("timezone") or "UTC", workspace_id=conv.workspace_id)
    if d["ok"]:
        text = "Here is the automation. Confirm and it starts; nothing runs until you do."
        status = "confirm"
    else:
        text = d["issues"][0]
        status = "needs_input"
    _set_state(db, msg, status=status, text=text, confirm={"kind": "automation", **d} if d["ok"] else None,
               issues=d["issues"], chips=[], finished_at=datetime.utcnow().isoformat() + "Z")


def _do_dashboard(db: Session, msg: models.Message, user: models.User) -> None:
    st = _state(msg)
    conv = db.get(models.Conversation, msg.conversation_id)
    from ...routers import projects as projects_router
    last = _last_run(db, conv)
    if last is None:
        _set_state(db, msg, status="needs_input", text="Ask the question you want on the dashboard first; the dashboard is built from an answer.",
                   finished_at=datetime.utcnow().isoformat() + "Z")
        return
    run_ids = st.get("run_ids") or None
    try:
        out = projects_router.make_dashboard(conv.id, projects_router.DashboardRequest(run_id=None if run_ids else last.id, run_ids=run_ids,
                                                                                       name=st.get("name")), db=db, user=user)
    except HTTPException as e:
        _set_state(db, msg, status="failed", error=str(e.detail), finished_at=datetime.utcnow().isoformat() + "Z")
        return
    artifact = {"type": "dashboard", "id": out["dashboard_id"], "name": out["name"], "url": f"/dashboard-builder/{out['dashboard_id']}",
                "page_id": out.get("page_id"), "live": out.get("live")}
    _set_state(db, msg, status="done", artifacts=[artifact],
               text=f"\"{out['name']}\" is on the canvas, computed live on {out.get('datasource_name') or 'your data'} with filters in the header. "
                    "Change anything by saying it (\"add a chart of revenue by city\", \"make it dark\"), or open it full-screen.",
               chips=[{"key": "live", "ok": True, "label": f"Live on {out.get('datasource_name') or 'your data'}"}],
               trail=[{"label": "Chose the blocks from the answer"}, {"label": "Checked every block against the columns"}, {"label": "Built the pages"}],
               finished_at=datetime.utcnow().isoformat() + "Z")


_TOOLS = {"knowledge": _do_knowledge, "chat": _do_chat, "document": _do_document, "automation": _do_automation, "dashboard": _do_dashboard}


# ---- entry points -----------------------------------------------------------------

def new_conversation(db: Session, user: models.User, *, question: str, space_id: str | None, source_ids: list[str] | None,
                     workspace_id: str | None) -> models.Conversation:
    from ...routers import projects as projects_router
    ids, space = [], None
    # a Space or chosen sources bind the conversation; otherwise sources are picked for the first
    # DATA question (a conversation that opens with "who is the chief minister" must not be tied to
    # whichever source matched that sentence best)
    probe = intents.route(question, has_sources=True, source_names=[], last_kind=None) if not (space_id or source_ids) else {"intent": "data"}
    if space_id or source_ids or probe["intent"] in ("data", "dashboard"):
        try:
            ids, space = projects_router._scope_ids(db, user, source_ids, space_id, workspace_id, question)
        except HTTPException as e:
            if (space_id or source_ids) and e.status_code != 400:
                raise
            # no usable data: the conversation can still answer world questions and work from the question alone
    first = db.get(models.DataSource, ids[0]) if ids else None
    conv = models.Conversation(owner_id=user.id, datasource_id=ids[0] if ids else None, kind="project", source_ids=ids,
                               workspace_id=workspace_id or (first.workspace_id if first else None),
                               title=question.strip()[:80] or "New conversation", space_id=space.id if space else None,
                               thread_meta={"v2": True, "created_v2_at": datetime.utcnow().isoformat() + "Z"})
    db.add(conv)
    db.commit()
    db.refresh(conv)
    return conv


def _source_names(db: Session, conv: models.Conversation) -> tuple[list[str], list[str]]:
    names, cols = [], []
    for sid in list(conv.source_ids or [])[:6]:
        ds = db.get(models.DataSource, sid)
        if not ds:
            continue
        names.append(ds.name or "")
        sc = ds.schema_cache if isinstance(ds.schema_cache, dict) else {}
        for t, spec in list(sc.items())[:12] if isinstance(sc, dict) else []:
            names.append(str(t))
            if isinstance(spec, dict):
                cols += [str(c) for c in (spec.get("columns") or [])[:60] if isinstance(c, str)]
                cols += [str(c.get("name")) for c in (spec.get("columns") or [])[:60] if isinstance(c, dict) and c.get("name")]
            elif isinstance(spec, list):
                cols += [str(c.get("name") if isinstance(c, dict) else c) for c in spec[:60]]
    return names, cols


def send(db: Session, conv: models.Conversation, user: models.User, text: str, *, mode: str = "auto", today: date | None = None,
         accepted: list[str] | None = None, context_run_id: str | None = None, timezone: str = "UTC", intent: str | None = None) -> dict:
    """Routes one message and starts its tool. Returns the new turn (see turns_of)."""
    from ...routers import projects as projects_router
    text = (text or "").strip()
    if not text:
        raise HTTPException(400, "Say what you want to know.")
    try:
        plans.can(db, user, "questions_per_day", 1, conv.workspace_id)
    except plans.PlanLimit as e:
        raise HTTPException(402, str(e))
    has_sources = bool(conv.source_ids)
    if not has_sources and conv.space_id is None and not _meta(conv).get("sources_chosen"):
        # a conversation started without data: a data-sounding question picks its sources now
        try:
            ids, _space = projects_router._scope_ids(db, user, None, None, conv.workspace_id, text)
            probe = intents.route(text, has_sources=True, source_names=[], last_kind=None)
            if probe["intent"] in ("data", "dashboard") and ids:
                conv.source_ids, conv.datasource_id = ids, ids[0]
                db.commit()
                has_sources = True
                _save_meta(db, conv, _meta(conv) | {"sources_picked_for": text[:120]})
        except HTTPException:
            pass
    names, cols = _source_names(db, conv)
    last = _last_turn_kind(db, conv)
    decision = {"intent": intent, "by": "person", "reason": "chosen on the card"} if intent in KINDS else \
        intents.route(text, has_sources=has_sources, source_names=names, column_names=cols, last_kind=last, mode=mode)
    kind = decision["intent"]
    if kind == "data" and mode == "guided":
        kind = "guided"
    if kind in ("data", "guided") and not has_sources:
        # the Analyst works from the question alone (what-if, simulation); anything else is a world question
        from ..project_engine import analyst as _analyst
        if not _analyst._ROUTE.search(text):
            kind = "knowledge"
            decision = {"intent": "knowledge", "by": "rule", "reason": "no data connected"}
    if kind == "data":
        return _start_data(db, conv, user, text, today, accepted, context_run_id, decision)
    if kind == "guided":
        return _start_guided(db, conv, user, text, decision)
    msg = _new_turn(db, conv, kind, text, today=(today or date.today()).isoformat(), timezone=timezone, intent_by=decision.get("by"),
                    intent_reason=decision.get("reason"))
    _bg(_TOOLS[kind], msg.id, user.id)
    return _message_turn(db, msg, conv, user)


def _last_turn_kind(db: Session, conv: models.Conversation) -> str | None:
    ts = turns_of(db, conv, None, full=False)
    return ts[-1]["kind"] if ts else None


def _start_data(db, conv, user, text, today, accepted, context_run_id, decision) -> dict:
    from ...routers import projects as projects_router
    if context_run_id is None:
        last = _last_run(db, conv)
        context_run_id = last.id if last else None
    payload = projects_router.AskRequest(question=text, auto_run=True, route=True, understand=True, accepted=accepted or [],
                                         context_run_id=context_run_id, today=(today or date.today()).isoformat())
    out = projects_router.ask(conv.id, payload, db=db, user=user)
    if out.get("kind") == "run":
        run = db.get(models.ProjectRun, out["run_id"])
        run.plan = dict(run.plan or {}) | {"v2_intent": decision}
        flag_modified(run, "plan")
        db.commit()
        return _run_turn(db, run, conv, user, full=False)
    if out.get("kind") == "check":
        msg = _new_turn(db, conv, "check", text, status="needs_input", check=out["check"],
                        text="Before I run this, one thing to confirm.", finished_at=datetime.utcnow().isoformat() + "Z")
        return _message_turn(db, msg, conv, user)
    ex = out.get("explain") or {}
    prose = " ".join([str(ex.get("headline") or "")] + [str(p.get("text") or "") for p in (ex.get("points") or []) if isinstance(p, dict)]
                     + [str(ex.get("takeaway") or "")]).strip()
    msg = _new_turn(db, conv, "explain", text, status="done", explain=ex, text=prose, run_id=ex.get("run_id"),
                    chips=[{"key": "basis", "ok": True, "label": "Explained from the answer above, no new query"}],
                    finished_at=datetime.utcnow().isoformat() + "Z")
    return _message_turn(db, msg, conv, user)


def _start_guided(db, conv, user, text, decision) -> dict:
    from ...routers import projects as projects_router
    out = projects_router.create_project(projects_router.CreateProjectRequest(
        question=text, source_ids=list(conv.source_ids or []), workspace_id=conv.workspace_id, mode="guided", auto_run=False,
        space_id=None), db=db, user=user)
    msg = _new_turn(db, conv, "guided", text, status="working", guided_project_id=out["project_id"], run_id=out["run_id"],
                    text="Here is the plan, step by step. Run each step, change any of them, and I re-run from there.",
                    trail=[{"label": "Planning the steps"}])
    return _message_turn(db, msg, conv, user)


def confirm(db: Session, conv: models.Conversation, user: models.User, message_id: str, *, approve: bool, edits: dict | None = None) -> dict:
    """The person confirmed (or declined) a card: today, an automation."""
    msg = db.get(models.Message, message_id)
    if msg is None or msg.conversation_id != conv.id:
        raise HTTPException(404, "That card is not in this conversation.")
    st = _state(msg)
    if st.get("status") != "confirm" or not st.get("confirm"):
        raise HTTPException(400, "There is nothing to confirm on this turn.")
    if not approve:
        _set_state(db, msg, status="done", confirm=None, text="Cancelled. Nothing was set up.")
        return _message_turn(db, msg, conv, user)
    card = st["confirm"]
    if card.get("kind") == "automation":
        from ...routers import automations as automations_router
        body = dict(card.get("body") or {})
        for k in ("name", "tell", "timezone"):
            if edits and edits.get(k) is not None:
                body[k] = edits[k]
        try:
            created = automations_router.create_automation(automations_router.AutomationBody(**body), db=db, user=user)
        except HTTPException as e:
            _set_state(db, msg, status="confirm", error=str(e.detail))
            return _message_turn(db, msg, conv, user)
        s = created.get("sentence") or {}
        _set_state(db, msg, status="done", confirm=None, error=None,
                   artifacts=[{"type": "automation", "id": created["id"], "name": created["name"], "url": f"/automations/{created['id']}",
                               "sentence": s, "next_run_at": created.get("next_run_at")}],
                   text=f"Done. {s.get('when') or ''} {s.get('do') or ''} {s.get('tell_sentence') or ''}".strip(),
                   chips=[{"key": "automation", "ok": True, "label": "Watching" if (body.get("trigger") or {}).get("type") == "threshold" else "Scheduled"}])
        return _message_turn(db, msg, conv, user)
    raise HTTPException(400, "Unknown card.")


# ---- reading ------------------------------------------------------------------------

def _run_turn(db: Session, run: models.ProjectRun, conv: models.Conversation, user: models.User, full: bool) -> dict:
    from ...routers.projects import _run_out
    out = _run_out(run, full=False)
    status = {"done": "done", "failed": "failed", "stopped": "failed", "needs_input": "needs_input", "replaced": "done"}.get(run.status, "working")
    guard = truth_guard.chips_for_run(run) if run.status == "done" else {"chips": [], "verdict": "pending"}
    plan = run.plan if isinstance(run.plan, dict) else {}
    trail = []
    for s in run.steps or []:
        lbl = s.get("title") or s.get("purpose") or "Step"
        if s.get("rows_read") or s.get("rows_returned"):
            lbl += f" · {int(s.get('rows_read') or s.get('rows_returned') or 0):,} rows"
        trail.append({"label": lbl, "status": s.get("status"), "sql": s.get("sql"), "ms": s.get("duration_ms")})
    for p in (plan.get("progress") or []) if plan.get("mode") == "analyst" else []:
        if isinstance(p, dict):
            trail.append({"label": p.get("label") or p.get("stage") or "", "status": p.get("status")})
    return {
        "id": run.id, "kind": "data", "status": status, "question": run.question, "created_at": out["created_at"],
        "finished_at": out["finished_at"], "run_id": run.id, "run": out, "text": None, "chips": guard["chips"], "verdict": guard["verdict"],
        "artifacts": [], "trail": trail, "elapsed_s": out.get("duration_seconds"), "error": out.get("error"),
        "intent_by": (plan.get("v2_intent") or {}).get("by"), "mode": "analyst" if plan.get("mode") == "analyst" else "engine",
        "placements": [p for p in ((_meta(conv).get("placements") or {}).values()) if run.id in (p.get("run_ids") or [])],
    }


def _message_turn(db: Session, msg: models.Message, conv: models.Conversation, user: models.User) -> dict:
    st = _state(msg)
    out = {"id": msg.id, "kind": st.get("kind"), "status": st.get("status"), "question": st.get("question"),
           "created_at": msg.created_at, "finished_at": st.get("finished_at"), "text": st.get("text"), "sources": st.get("sources") or [],
           "grounded": st.get("grounded"), "chips": st.get("chips") or [], "verdict": "ok", "artifacts": st.get("artifacts") or [],
           "trail": st.get("trail") or [], "elapsed_s": st.get("elapsed_s"), "error": st.get("error"), "confirm": st.get("confirm"),
           "check": st.get("check"), "explain": st.get("explain"), "document": st.get("document"), "issues": st.get("issues") or [],
           "run_id": st.get("run_id"), "guided_project_id": st.get("guided_project_id"), "intent_by": st.get("intent_by")}
    if st.get("kind") == "guided" and st.get("run_id"):
        run = db.get(models.ProjectRun, st["run_id"])
        if run is not None:
            from ...routers.projects import _run_out
            out["run"] = _run_out(run, full=False)
            if run.status == "done":
                out["status"] = "done"
                out["chips"] = truth_guard.chips_for_run(run)["chips"]
            elif run.status in ("failed", "stopped"):
                out["status"] = "failed"
                out["error"] = run.error_message
            elif run.status == "needs_input":
                out["status"] = "needs_input"
            else:
                out["status"] = "working" if run.status in ("planning", "running") else "steps"
    return out


def turns_of(db: Session, conv: models.Conversation, user: models.User | None, full: bool = True) -> list[dict]:
    runs = (db.query(models.ProjectRun).filter(models.ProjectRun.conversation_id == conv.id)
            .order_by(models.ProjectRun.created_at.asc()).all())
    msgs = (db.query(models.Message).filter(models.Message.conversation_id == conv.id, models.Message.role == "assistant",
                                            models.Message.action.like("v2:%")).order_by(models.Message.created_at.asc()).all())
    guided_run_ids = {_state(m).get("run_id") for m in msgs if _state(m).get("kind") == "guided"}
    items: list[tuple[datetime, dict]] = []
    for r in runs:
        if r.status == "replaced" or r.id in guided_run_ids:
            continue
        items.append((r.created_at or datetime.min, _run_turn(db, r, conv, user, full)))
    for m in msgs:
        items.append((m.created_at or datetime.min, _message_turn(db, m, conv, user)))
    items.sort(key=lambda x: x[0])
    return [t for _, t in items]


def conversation_out(db: Session, conv: models.Conversation, user: models.User) -> dict:
    from ...routers.projects import _source_summary, _space_ref, _thread_dashboards
    from .. import workspace_access
    sources = []
    for sid in conv.source_ids or []:
        ds = db.get(models.DataSource, sid)
        if ds and workspace_access.can_access_datasource(db, ds, user):
            sources.append(_source_summary(db, ds, user))
    return {"id": conv.id, "title": conv.title, "created_at": conv.created_at, "source_ids": conv.source_ids or [], "sources": sources,
            "workspace_id": conv.workspace_id, "can_edit": workspace_access.can_edit_conversation(db, conv, user),
            "turns": turns_of(db, conv, user), "dashboards": _thread_dashboards(db, conv, user), "v2": is_v2(conv),
            **_space_ref(db, conv, user)}


def list_conversations(db: Session, user: models.User, workspace_id: str | None = None, limit: int = 60) -> list[dict]:
    from .. import workspace_access
    q = db.query(models.Conversation).filter(models.Conversation.kind.in_(("project", "guided")))
    rows = q.order_by(models.Conversation.created_at.desc()).limit(400).all()
    out = []
    for c in rows:
        if c.kind == "guided" and not is_v2(c):
            continue
        if not workspace_access.can_access_conversation(db, c, user):
            continue
        if workspace_id and c.workspace_id and c.workspace_id != workspace_id:
            continue
        last = (db.query(models.ProjectRun).filter(models.ProjectRun.conversation_id == c.id)
                .order_by(models.ProjectRun.created_at.desc()).first())
        ans = ((last.result or {}).get("answer") or {}) if last else {}
        out.append({"id": c.id, "title": c.title, "created_at": c.created_at, "space_id": c.space_id, "pinned": bool(c.pinned),
                    "last_at": (last.created_at if last else c.created_at), "headline": ans.get("headline"), "v2": is_v2(c),
                    "kind": c.kind, "mine": c.owner_id == user.id})
        if len(out) >= limit:
            break
    out.sort(key=lambda x: (not x["pinned"], -(x["last_at"] or datetime.min).timestamp()))
    return out
