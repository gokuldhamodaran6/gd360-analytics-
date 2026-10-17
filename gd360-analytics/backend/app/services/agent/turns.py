"""2026-10-14 (R46): one turn of the GD360 2.0 conversation.

A conversation is a models.Conversation of kind "project" whose thread_meta has
"v2": true, so routers/projects.py (runs, dashboards, explains) and the classic
page keep working on it. A turn that the project engine answers IS a ProjectRun;
every other turn (knowledge, document, automation, chat, a check that needs the
person, an explanation) is a models.Message with action "v2:<kind>" and its
state in chart_spec["v2"]. `turns_of` merges both in time order for the page.
"""
from __future__ import annotations

import json
import re
import threading
import traceback
from datetime import date, datetime

from fastapi import HTTPException
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from ... import models
from ...database import SessionLocal
from .. import ai_engine, ai_meter
from . import analysis, automations_tool, board, budgets, dashboard_tool, docblocks, docexport, documents, followups, intents, knowledge, model_tool, plans, segment_watch, team_tool, truth_guard, writer

KINDS = ("knowledge", "data", "guided", "dashboard", "document", "automation", "chat", "check", "explain", "dashboard_edit", "model", "team", "analysis",
         "document_edit", "list", "whatif")


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
    # R52: a turn stopped by its time budget stays stopped - a late result from the worker is dropped
    if "timed_out" not in changes and msg.id is not None:
        try:
            db.refresh(msg)
        except Exception:  # noqa: BLE001 - a new or detached row: nothing stored to protect yet
            pass
        if _state(msg).get("timed_out") and _state(msg).get("status") == "failed":
            return _state(msg)
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
    kind = None
    try:
        with SessionLocal() as _db:
            m0 = _db.get(models.Message, message_id)
            kind = _state(m0).get("kind") if m0 is not None else None
    except Exception:  # noqa: BLE001
        kind = None
    limit = budgets.hard(kind)
    timer = threading.Timer(limit, _time_out, args=(message_id,)) if limit else None
    if timer is not None:
        timer.daemon = True
        timer.start()
    threading.Thread(target=run, daemon=True, name=f"v2-{message_id[:8]}").start()


def _time_out(message_id: str) -> None:
    """The hard stop: a turn still working past three times its target fails with a plain sentence."""
    db = SessionLocal()
    try:
        msg = db.get(models.Message, message_id)
        if msg is not None and _state(msg).get("status") == "working":
            kind = _state(msg).get("kind")
            print(f"[agent.budget] {kind} turn {message_id[:8]} stopped after {budgets.hard(kind)} s")
            _set_state(db, msg, status="failed", timed_out=True, error=budgets.timeout_text(kind), text=None,
                       finished_at=datetime.utcnow().isoformat() + "Z")
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        db.rollback()
    finally:
        db.close()


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
    hist = [h for h in (_history(db, conv) if conv else []) if h.get("content") != st["question"]]
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


def _latest_doc(db: Session, conv: models.Conversation) -> models.DocDocument | None:
    return (db.query(models.DocDocument).filter(models.DocDocument.conversation_id == conv.id)
            .order_by(models.DocDocument.created_at.desc()).first())


def _doc_state(doc: models.DocDocument) -> tuple[dict, dict, list[dict]]:
    s = docblocks.summary(doc)
    md = docexport.markdown(s)
    artifact = {"type": "document", "id": doc.message_id or doc.id, "doc_id": doc.id, "title": doc.title, "words": s["words"],
                "pages": s["pages"], "figures": s["figures"]}
    chips = ([{"key": "numbers", "ok": True, "label": f"{s['checked']} figures re-checked against the data"}] if not s["flagged"]
             else [{"key": "numbers", "ok": False, "label": f"{len(s['flagged'])} figure{'s' if len(s['flagged']) != 1 else ''} to check",
                    "detail": ", ".join(s["flagged"])}])
    chips.append({"key": "sources", "ok": True, "label": f"{len(s['sources'])} source{'s' if len(s['sources']) != 1 else ''}"})
    return {"title": doc.title, "markdown": md, "flagged": s["flagged"], "doc_id": doc.id}, artifact, chips


def _do_document(db: Session, msg: models.Message, user: models.User) -> None:
    """R51: a block document built from what the conversation found (services/agent/docblocks.py)."""
    st = _state(msg)
    conv = db.get(models.Conversation, msg.conversation_id)
    today = date.fromisoformat(st["today"]) if st.get("today") else date.today()
    _set_state(db, msg, trail=[{"label": "Reading what this conversation found"}, {"label": "Writing the blocks"}, {"label": "Checking every figure"}])
    try:
        doc = docblocks.create(db, user, conv, msg.id, st.get("question") or "", today)
    except docblocks.DocError as e:
        _set_state(db, msg, status="needs_input", text=str(e), finished_at=datetime.utcnow().isoformat() + "Z")
        return
    except Exception as e:  # noqa: BLE001 - the older writer still gives a document
        traceback.print_exc()
        print(f"[agent.docblocks] block document failed, falling back to the markdown writer: {e}")
        return _do_document_markdown(db, msg, user)
    document, artifact, chips = _doc_state(doc)
    mat_bits = []
    if (doc.meta or {}).get("analysis_turn"):
        mat_bits.append("the analysis" + (" and its risk scores" if any(b["type"] == "table" and "Tier" in json.dumps(b.get("columns")) for b in doc.blocks) else ""))
    n_ans = len({x.get("turn_id") for x in doc.sources or [] if x.get("kind") in ("answer", "web")})
    if n_ans:
        mat_bits.append(f"{n_ans} answer{'s' if n_ans != 1 else ''}")
    _written_title(db, conv, st.get("question") or "", doc.title)
    _set_state(db, msg, status="done",
               text=f"Done. I wrote “{doc.title}” from {' and '.join(mat_bits) or 'this conversation'}; every figure in it links back to the step that produced it. "
                    "Click any paragraph on the right to change it.",
               document=document, artifacts=[artifact], chips=chips,
               trail=[{"label": f"Read {len(doc.sources or [])} sources from this conversation"}, {"label": f"Wrote {len(doc.blocks)} blocks"},
                      {"label": "Re-checked every figure against the data"}],
               finished_at=datetime.utcnow().isoformat() + "Z")


def _do_document_edit(db: Session, msg: models.Message, user: models.User) -> None:
    """R51: "make the brief shorter", "rename it to ...", "undo" on the document of this conversation."""
    st = _state(msg)
    conv = db.get(models.Conversation, msg.conversation_id)
    doc = _latest_doc(db, conv)
    if doc is None:
        _set_state(db, msg, status="needs_input", text="There is no document in this conversation yet. Say “write a brief from this” first.",
                   finished_at=datetime.utcnow().isoformat() + "Z")
        return
    q = st.get("question") or ""
    try:
        if re.match(r"^\s*undo\b", q, re.I):
            what = "undid “" + docblocks.undo(db, doc) + "”"
        elif m := re.search(r"\b(?:rename|call|title)\s+(?:it|the (?:brief|doc|document|report|memo|summary))\s+(?:to\s+)?[\"“']?(.+?)[\"”']?\s*$", q, re.I):
            docblocks.rename(db, doc, m.group(1).strip().rstrip("."))
            what = f"renamed it “{doc.title}”"
        else:
            what = docblocks.shorten_all(db, doc)
    except docblocks.DocError as e:
        _set_state(db, msg, status="needs_input", text=str(e), finished_at=datetime.utcnow().isoformat() + "Z")
        return
    document, artifact, chips = _doc_state(doc)
    artifact["refresh"] = True
    s = docblocks.summary(doc)
    _set_state(db, msg, status="done", text=f"Done: {what}. “{doc.title}” is now {s['pages']} page{'s' if s['pages'] != 1 else ''} with {s['figures']} figure{'s' if s['figures'] != 1 else ''}; say “undo” to go back.",
               document=document, artifacts=[artifact], chips=chips, trail=[{"label": what}], finished_at=datetime.utcnow().isoformat() + "Z")


def _do_document_markdown(db: Session, msg: models.Message, user: models.User) -> None:
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
    last_run = _last_run(db, conv)
    # R50: "churn in any segment passes 25%" watches every segment of the conversation's table
    seg = None
    if segment_watch.wants_segments(st["question"]) or last_run is None:
        seg = segment_watch.find(db, user, conv, _last_analysis(db, conv))
    d = automations_tool.draft(db, user, st["question"], last_run=last_run, dashboards=dashboards,
                               timezone=st.get("timezone") or "UTC", workspace_id=conv.workspace_id, segments_target=seg)
    if d["ok"]:
        text = _alert_sentence(d) if (d["body"].get("trigger") or {}).get("type") == "threshold" else \
            "Here is the automation. Confirm and it starts; nothing runs until you do."
        status = "confirm"
    else:
        text = d["issues"][0]
        status = "needs_input"
    _set_state(db, msg, status=status, text=text, confirm={"kind": "automation", **d} if d["ok"] else None,
               issues=d["issues"], chips=[], finished_at=datetime.utcnow().isoformat() + "Z")


def _cap(s: str) -> str:
    return s[:1].upper() + s[1:] if s else s


def _alert_sentence(d: dict) -> str:
    """R50: one bold sentence that says exactly what will happen (board 06)."""
    s = d.get("sentence") or {}
    trig = (d.get("body") or {}).get("trigger") or {}
    when = (s.get("when") or "").rstrip(".")
    if (trig.get("target") or {}).get("kind") == "segments":
        fc = d.get("first_check") or {}
        groups = fc.get("groups")
        line = trig.get("value")
        what = f"watch {groups} segments" if groups else "watch every segment"
        sched = automations_tool.svc.schedule_text(trig.get("check") or {}) if trig.get("check") else ""
        if sched.startswith(("Every", "On ")):
            sched = sched[:1].lower() + sched[1:]
        elif sched:
            sched = "on " + sched
        verb = "passes" if trig.get("op") != "below" else "drops below"
        return (f"On it. Confirm below to {what} {sched} and message you when any {verb} {line:g}%.".replace("  ", " ")
                if isinstance(line, (int, float)) else "Confirm below and I start watching.")
    return f"On it. Confirm below and I start checking: {when[:1].lower() + when[1:] if when else 'on the schedule shown'}. Nothing runs until you do."


def _do_dashboard(db: Session, msg: models.Message, user: models.User) -> None:
    """R49: a dashboard is a designed board (services/agent/board.py) built from the conversation's table and,
    when there is one, its analysis. The older block builder is only the fallback when a board cannot be built."""
    st = _state(msg)
    conv = db.get(models.Conversation, msg.conversation_id)
    an = _last_analysis(db, conv)
    source_id = ((an or {}).get("analysis") or {}).get("table", {}).get("source_id") or (list(conv.source_ids or []) or [None])[0]
    table = ((an or {}).get("analysis") or {}).get("table", {}).get("table")
    if source_id is None:
        _set_state(db, msg, status="needs_input", text="Choose the data first: a dashboard is built from a table. Pick a source in the box below and ask again.",
                   finished_at=datetime.utcnow().isoformat() + "Z")
        return
    _set_state(db, msg, trail=[{"label": "Reading the table"}, {"label": "Designing the pages"}, {"label": "Computing every block"}])
    try:
        dash = board.create(db, user, conv, source_id, table, question=st.get("question") or "", analysis_result=(an or {}).get("analysis"),
                            name=st.get("name"))
    except Exception as e:  # noqa: BLE001 - the old builder still gives a dashboard
        traceback.print_exc()
        print(f"[agent.board] designed board failed, falling back to the block builder: {e}")
        return _do_dashboard_blocks(db, msg, user)
    spec = dash.board_spec or {}
    pages = [p["name"] for p in spec.get("pages") or []]
    artifact = {"type": "dashboard", "id": dash.id, "name": dash.name, "url": f"/boards/{dash.id}", "board": True, "pages": len(pages)}
    src = (spec.get("source") or {}).get("name") or "your data"
    typo = None
    if st.get("normalized") and st.get("question"):
        q0, q1 = re.findall(r"[A-Za-z]+", st["question"]), re.findall(r"[A-Za-z]+", st["normalized"])
        fixed = [(a, b) for a, b in zip(q0, q1) if a.lower() != b.lower()]
        typo = f"{fixed[0][0]} → {fixed[0][1]}" if fixed else None
    _written_title(db, conv, st.get("question") or "", dash.name)
    _set_state(db, msg, status="done", artifacts=[artifact],
               built={"pages": pages, "name": dash.name, "theme": card_state_label(spec), "typo": typo, "dashboard_id": dash.id},
               text=f"“{dash.name}” is on the right: {len(pages)} pages ({', '.join(pages)}), computed live on {src}. "
                    f"Change it by saying so: {_board_hints(spec)}.",
               chips=[{"key": "live", "ok": True, "label": f"Live on {src} · {spec.get('rows_at_build', 0):,} rows"}]
               + ([{"key": "model", "ok": True, "label": f"Risk scores from a model tested on held-out rows · AP {spec['model']['ap']}"}] if spec.get("model") else []),
               trail=[{"label": f"Read {src} · {spec.get('rows_at_build', 0):,} rows"}, {"label": "Designed " + ", ".join(pages)},
                      {"label": "Wrote the definitions behind every number"}],
               finished_at=datetime.utcnow().isoformat() + "Z")


def card_state_label(spec: dict) -> str:
    return board.THEMES.get(spec.get("theme") or "ink", board.THEMES["ink"])["label"]


def _board_hints(spec: dict) -> str:
    """Three edits that make sense on THIS board."""
    fl = [f for f in spec.get("filters") or [] if f.get("column") and not str(f.get("key", "")).startswith("__")]
    hints = ["“make it navy”"]
    dims = [f["label"].lower() for f in fl]
    if spec.get("outcome"):
        hints.append(f"“add {spec['outcome']['noun']} by {dims[-1] if dims else 'segment'}”")
    else:
        m = next((b.get("column") for p in spec.get("pages") or [] for b in p.get("blocks") or [] if b.get("kind") == "g_measure"), None)
        hints.append(f"“add {analysis.label_of(m) if m else 'revenue'} by {dims[-1] if dims else 'region'}”")
    if fl and fl[0].get("values"):
        hints.append(f"“filter to {fl[0]['values'][0]}”")
    return ", ".join(hints)


def _do_dashboard_blocks(db: Session, msg: models.Message, user: models.User) -> None:
    st = _state(msg)
    conv = db.get(models.Conversation, msg.conversation_id)
    from ...routers import projects as projects_router
    last = _last_run(db, conv)
    if last is None:
        an = _last_analysis(db, conv)
        if an is None:
            _set_state(db, msg, status="needs_input", text="Ask the question you want on the dashboard first; the dashboard is built from an answer.",
                       finished_at=datetime.utcnow().isoformat() + "Z")
            return
        _dashboard_from_analysis(db, msg, user, conv, an)
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


def _dashboard_from_analysis(db: Session, msg: models.Message, user: models.User, conv: models.Conversation, an: dict) -> None:
    """R48: a dashboard built from the analysis's table and question (the designed dashboard spec is R49)."""
    from ...routers import dashboard_builder as dbr
    r = an["analysis"]
    ds = db.get(models.DataSource, r["table"]["source_id"])
    if ds is None:
        _set_state(db, msg, status="needs_input", text="The analysis's table is no longer connected.", finished_at=datetime.utcnow().isoformat() + "Z")
        return
    goal = f"{r.get('title') or an.get('question')}: {r['target']['noun']} rate by segment, the signals ({', '.join(s['label'] for s in r['signals'][:4])}), and {r['table']['entities']} at risk"
    try:
        dash, page_ids = dbr.build_dashboard_from_goal(db, user, ds, goal, name=(r.get("title") or "Analysis dashboard")[:80], conversation_id=conv.id)
    except HTTPException as e:
        _set_state(db, msg, status="failed", error=str(e.detail), finished_at=datetime.utcnow().isoformat() + "Z")
        return
    artifact = {"type": "dashboard", "id": dash.id, "name": dash.name, "url": f"/dashboard-builder/{dash.id}", "page_id": page_ids[0] if page_ids else None}
    _set_state(db, msg, status="done", artifacts=[artifact],
               text=f"“{dash.name}” is on the canvas, computed live on {ds.name}. Change anything by saying it (\"make it dark\", \"rename it\"), or open it full-screen.",
               chips=[{"key": "live", "ok": True, "label": f"Live on {ds.name}"}],
               trail=[{"label": "Took the table and signals from the analysis"}, {"label": "Built the pages"}],
               finished_at=datetime.utcnow().isoformat() + "Z")


def _current_dashboard(db: Session, conv: models.Conversation, user: models.User) -> models.Dashboard | None:
    """The dashboard this conversation is working on: the latest one made from it (or added to)."""
    from ...routers.projects import _thread_dashboards
    rows = _thread_dashboards(db, conv, user)
    rows = [r for r in rows if r.get("layout_version") in (2, 4) and r.get("can_edit")]
    if not rows:
        return None
    return db.get(models.Dashboard, rows[-1]["id"])


def _do_dashboard_edit(db: Session, msg: models.Message, user: models.User) -> None:
    st = _state(msg)
    conv = db.get(models.Conversation, msg.conversation_id)
    dash = _current_dashboard(db, conv, user)
    if dash is None:
        _set_state(db, msg, status="needs_input", text="There is no dashboard in this conversation yet. Say “make this a dashboard” first.",
                   finished_at=datetime.utcnow().isoformat() + "Z")
        return
    if (dash.layout_version or 0) == 4:
        src = (dash.board_spec or {}).get("source") or {}
        try:
            df, _s = board.frame(db, user, src.get("source_id"), src.get("table"))
            out = board.apply_edit(db, user, dash, st["question"], [str(c) for c in df.columns],
                                   numeric={str(c) for c in df.columns if str(df[c].dtype) not in ("object", "string", "category", "bool")})
        except ValueError as e:
            _set_state(db, msg, status="needs_input", text=str(e), finished_at=datetime.utcnow().isoformat() + "Z")
            return
        artifact = {"type": "dashboard", "id": dash.id, "name": dash.name, "url": f"/boards/{dash.id}", "board": True, "page_id": out.get("page_id"), "refresh": True}
        ch = out["changes"]
        after, before = out.get("after") or {}, out.get("before") or {}
        n = len(after.get("pages") or [])
        if out.get("undo"):
            text = (f"Done. “{after.get('name')}” is back to how it was, on the {after.get('theme_label')} theme"
                    + (f" with {str(after['accent']).upper()}" if after.get("accent") else "") + ". Say “undo” again to go back further.")
        else:
            # R50: one bold sentence that says exactly what changed (board 06)
            renamed = after.get("name") != before.get("name")
            look = None
            if after.get("accent") and after.get("accent") != before.get("accent"):
                look = f"your colour {str(after['accent']).upper()}"
            elif after.get("theme") != before.get("theme"):
                look = f"the {after.get('theme_label')} theme"
            bits = []
            if look:
                bits.append(f"{after.get('name')} now uses {look} on all {n} pages" + (f" (renamed from “{before.get('name')}”)" if renamed else ""))
            elif renamed:
                bits.append(f"the dashboard is now called “{after.get('name')}”")
            other = [c for c in ch if not c.startswith(("renamed", "theme set", "accent colour"))]
            lead = ("Done. " + _cap(bits[0]) + ".") if bits else ("Done: " + "; ".join(other or ch) + ".")
            if bits and other:
                lead += " Also " + "; ".join(other) + "."
            text = lead + (" The exports follow it." if bits else " The dashboard on the right shows it.")
        _set_state(db, msg, status="done", text=text, edit={"before": before, "after": after, "changes": ch, "undo": bool(out.get("undo")), "dashboard_id": dash.id},
                   artifacts=[artifact], chips=[{"key": "applied", "ok": True, "label": f"{len(ch)} change{'s' if len(ch) != 1 else ''} applied"}],
                   trail=[{"label": c} for c in ch], finished_at=datetime.utcnow().isoformat() + "Z")
        return
    try:
        out = dashboard_tool.apply(db, user, dash, st["question"], conv)
    except HTTPException as e:
        _set_state(db, msg, status="needs_input", text=str(e.detail), finished_at=datetime.utcnow().isoformat() + "Z")
        return
    artifact = {"type": "dashboard", "id": dash.id, "name": out["name"], "url": f"/dashboard-builder/{dash.id}", "page_id": out.get("page_id"), "refresh": True}
    _set_state(db, msg, status="done", text="Done: " + "; ".join(out["changes"]) + ". The canvas shows the change.",
               artifacts=[artifact], chips=[{"key": "applied", "ok": True, "label": f"{len(out['changes'])} change{'s' if len(out['changes']) != 1 else ''} applied"}],
               trail=[{"label": c} for c in out["changes"]], finished_at=datetime.utcnow().isoformat() + "Z")


def _do_model(db: Session, msg: models.Message, user: models.User) -> None:
    st = _state(msg)
    conv = db.get(models.Conversation, msg.conversation_id)
    out = model_tool.start(db, user, st["question"], conv)
    if not out.get("ok"):
        _set_state(db, msg, status="needs_input", text=out.get("issue") or "I couldn't set up the model.", finished_at=datetime.utcnow().isoformat() + "Z")
        return
    spec = out.get("spec") or {}
    _set_state(db, msg, status="working", model_id=out["model_id"], model_spec=spec,
               text=f"Training a {spec.get('problem_type', 'model').replace('_', ' ')} model on “{spec.get('target')}” from {spec.get('table') or 'your data'}. "
                    "I hold back rows it never sees to score it honestly, and remove any column that leaks the answer.",
               trail=[{"label": "Read the question into a model spec"}, {"label": "Checked the plan on the data" + ((" · " + " ".join(map(str, rt)) if isinstance(rt := out.get("plan", {}).get("rows_text"), list) else (" · " + str(rt)) if rt else ""))},
                      {"label": "Training in the queue"}])


def _do_team(db: Session, msg: models.Message, user: models.User) -> None:
    st = _state(msg)
    conv = db.get(models.Conversation, msg.conversation_id)
    d = team_tool.draft(db, user, st["question"], workspace_id=conv.workspace_id, source_ids=list(conv.source_ids or []), conversation_id=conv.id)
    if d["ok"]:
        _set_state(db, msg, status="confirm", text="Here is the team. Confirm and I create the Space and its data rules; nothing changes until you do.",
                   confirm={"kind": "team", **d}, chips=[], finished_at=datetime.utcnow().isoformat() + "Z")
    else:
        _set_state(db, msg, status="needs_input", text=d["issues"][0], issues=d["issues"], finished_at=datetime.utcnow().isoformat() + "Z")


def _last_analysis(db: Session, conv: models.Conversation) -> dict | None:
    rows = (db.query(models.Message).filter(models.Message.conversation_id == conv.id, models.Message.action == "v2:analysis")
            .order_by(models.Message.created_at.desc()).all())
    for m in rows:
        st = _state(m)
        if st.get("status") == "done" and st.get("analysis"):
            return st
    return None


def _do_analysis(db: Session, msg: models.Message, user: models.User) -> None:
    st = _state(msg)
    conv = db.get(models.Conversation, msg.conversation_id)
    spec = {k: st.get(k) for k in ("recipe", "table", "target", "dimension", "feature") if st.get(k)}
    _set_state(db, msg, trail=[{"label": "Reading the table"}, {"label": "Finding the outcome and the signals"}, {"label": "Training and testing a model"}])
    try:
        r = analysis.run(db, user, conv, st["question"], spec)
    except analysis.AnalysisError as e:
        _set_state(db, msg, status="needs_input", text=str(e), trail=[], finished_at=datetime.utcnow().isoformat() + "Z")
        return
    prose = writer.write(r)
    ttl = writer.title(r)
    ent = r["table"]["entities"]
    chips = [{"key": "rows", "ok": True, "label": (f"All {r['baseline']['n']:,} {ent} read" if not r["table"]["sampled"] else f"A fair sample of {r['baseline']['n']:,} {ent} read"),
              "detail": f"{r['table']['source']} · {r['table']['table']}"}]
    if r.get("model"):
        chips.append({"key": "validation", "ok": True, "label": f"Held-out test · AP {r['model']['ap']}",
                      "detail": f"{r['model']['test_n']:,} rows the model never saw · AUC {r['model']['auc']} · random would score {r['model']['baseline_ap']}"})
        if r["model"].get("leaks"):
            chips.append({"key": "leaks", "ok": True, "label": f"{len(r['model']['leaks'])} leaking column{'s' if len(r['model']['leaks']) != 1 else ''} removed",
                          "detail": ", ".join(l["column"][:40] for l in r["model"]["leaks"][:4])})
    chips.append({"key": "numbers" if not prose["replaced"] else "rewritten", "ok": True, "label": "Every number in the text is in the findings" if not prose["replaced"]
                  else f"{len(prose['replaced'])} sentence{'s' if len(prose['replaced']) != 1 else ''} rewritten from the findings",
                  "detail": None if not prose["replaced"] else "The model wrote a number the data did not support; the template sentence is shown instead."})
    if not r.get("has_dates"):
        chips.append({"key": "dates", "ok": True, "label": "No dates in the data: a snapshot, not a trend", "detail": "Scores say who resembles past cases, not when."})
    text = writer.chat_text(r, prose)
    every = (r.get("risk_list") or {}).pop("_all", None)  # R52: kept for "show them as a list", not sent to the page
    r["prose"] = prose
    r["title"] = ttl
    if conv is not None and (conv.title or "").strip().lower() in ((st.get("question") or "").strip()[:80].lower(), "new conversation", ""):
        conv.title = ttl[:80]  # a written title instead of the question cut mid-word
        db.commit()
    artifact = {"type": "analysis", "id": msg.id, "name": ttl, "recipe": r["recipe"], "figures": 4 if r.get("model") else 1,
                "scored": (r.get("baseline") or {}).get("existing") if r.get("tiers") else None}
    trail = [{"label": s["label"] + (f" · {s['detail']}" if s.get("detail") else ""), "ms": s.get("ms")} for s in r["method"]["steps"]]
    _set_state(db, msg, status="done", text=text, analysis=r, artifacts=[artifact], chips=chips, trail=trail, elapsed_s=r.get("elapsed_s"), risk_rows=every,
               document={"title": ttl, "markdown": writer.markdown(r, prose, ttl), "flagged": []},
               finished_at=datetime.utcnow().isoformat() + "Z")


def _last_analysis_msg(db: Session, conv: models.Conversation) -> models.Message | None:
    rows = (db.query(models.Message).filter(models.Message.conversation_id == conv.id, models.Message.action == "v2:analysis")
            .order_by(models.Message.created_at.desc()).all())
    return next((m for m in rows if _state(m).get("status") == "done" and _state(m).get("analysis")), None)


def _do_list(db: Session, msg: models.Message, user: models.User) -> None:
    """R52: "show the 135 high-risk customers as a list" - the tier's rows from the analysis, no re-run."""
    st = _state(msg)
    conv = db.get(models.Conversation, msg.conversation_id)
    am = _last_analysis_msg(db, conv)
    a = _state(am).get("analysis") if am else None
    if not a or not a.get("tiers"):
        _set_state(db, msg, status="needs_input", text="There is no risk list yet. Ask who is likely to leave first; the list comes from that analysis.",
                   finished_at=datetime.utcnow().isoformat() + "Z")
        return
    rows = _state(am).get("risk_rows")
    if not rows:  # an analysis from before R52 kept only the top 50: score again, same recipe
        _set_state(db, msg, trail=[{"label": "Scoring every current row again"}])
        r = analysis.run(db, user, conv, a.get("question") or st["question"], {"recipe": "outcome", "table": (a.get("table") or {}).get("table"),
                                                                               "target": (a.get("target") or {}).get("column")})
        rows = (r.get("risk_list") or {}).pop("_all", None) or {}
        _set_state(db, am, risk_rows=rows)
    lst = followups.build_list(a, rows, st.get("question") or "")
    msg_rows = lst["rows"]
    _set_state(db, msg, status="done", text=followups.list_text(lst), list={**lst, "rows": msg_rows[:500]}, list_all=msg_rows,
               artifacts=[{"type": "list", "id": msg.id, "name": lst["title"], "rows": lst["total"]}],
               chips=[{"key": "rows", "ok": True, "label": f"{lst['shown']:,} of {lst['total']:,} {lst['title'].lower()}",
                       "detail": "Scored by a model that never saw each row (out of fold)"},
                      {"key": "basis", "ok": True, "label": "From the analysis above, nothing recomputed"}],
               trail=[{"label": f"Took the {lst['title'].lower()} from the analysis · {lst['total']:,} rows"}],
               finished_at=datetime.utcnow().isoformat() + "Z")


def _do_whatif(db: Session, msg: models.Message, user: models.User) -> None:
    """R52: "what if churn fell by a quarter in the low-usage band" - arithmetic on the analysis's groups, assumptions stated."""
    st = _state(msg)
    conv = db.get(models.Conversation, msg.conversation_id)
    an = _last_analysis(db, conv)
    a = (an or {}).get("analysis") or {}
    q = st.get("question") or ""
    band = None
    if followups.group_phrase(q) and followups._band(a, q) is None and (a.get("table") or {}).get("source_id"):
        try:  # a group named by a value in the table, not one of the analysis's signals ("Blue card holders")
            from .. import ml_studio
            df, _e, _s = ml_studio.load_frame(db, user, a["table"]["source_id"], a["table"]["table"], cap=analysis.MAX_ROWS)
            band = followups.band_from_frame(df, a, q)
        except Exception as e:  # noqa: BLE001 - then the sentence asks for a group it can find
            print(f"[agent.whatif] table lookup skipped: {e}")
    out = followups.whatif(a, q, band)
    if not out["ok"]:
        _set_state(db, msg, status="needs_input", text=out["text"], finished_at=datetime.utcnow().isoformat() + "Z")
        return
    c = out["card"]
    _set_state(db, msg, status="done", text=out["text"], whatif=c,
               chips=[{"key": "numbers", "ok": True, "label": "Every number from the analysis above" if band is None else "Every number read from the table just now"},
                      {"key": "assumptions", "ok": True, "label": f"{len(c['assumptions'])} assumptions stated, not findings",
                       "detail": " ".join(c["assumptions"])}],
               trail=[{"label": f"Took {c['group']} from the analysis · {c['group_n']:,} {c['entities']}"}, {"label": f"Applied the change {c['change']['label']}"}],
               finished_at=datetime.utcnow().isoformat() + "Z")


_TOOLS = {"list": _do_list, "whatif": _do_whatif, "knowledge": _do_knowledge, "analysis": _do_analysis, "chat": _do_chat, "document": _do_document, "automation": _do_automation, "dashboard": _do_dashboard,
          "dashboard_edit": _do_dashboard_edit, "model": _do_model, "team": _do_team, "document_edit": _do_document_edit}


# ---- entry points -----------------------------------------------------------------

def new_conversation(db: Session, user: models.User, *, question: str, space_id: str | None, source_ids: list[str] | None,
                     workspace_id: str | None) -> models.Conversation:
    from ...routers import projects as projects_router
    ids, space = [], None
    # a Space or chosen sources bind the conversation; otherwise sources are picked for the first
    # DATA question (a conversation that opens with "who is the chief minister" must not be tied to
    # whichever source matched that sentence best)
    probe = intents.route(question, has_sources=True, source_names=[], last_kind=None) if not (space_id or source_ids) else {"intent": "data"}
    if space_id or source_ids or probe["intent"] in ("data", "dashboard", "analysis", "model"):
        try:
            ids, space = projects_router._scope_ids(db, user, source_ids, space_id, workspace_id, question)
        except HTTPException as e:
            if (space_id or source_ids) and e.status_code != 400:
                raise
            # no usable data: the conversation can still answer world questions and work from the question alone
    first = db.get(models.DataSource, ids[0]) if ids else None
    conv = models.Conversation(owner_id=user.id, datasource_id=ids[0] if ids else None, kind="project", source_ids=ids,
                               workspace_id=workspace_id or (first.workspace_id if first else None),
                               title=(question.strip()[:1].upper() + question.strip()[1:])[:80] or "New conversation", space_id=space.id if space else None,
                               thread_meta={"v2": True, "created_v2_at": datetime.utcnow().isoformat() + "Z"})
    db.add(conv)
    db.commit()
    db.refresh(conv)
    file_into_space(db, user, conv)
    return conv


def _space_map(db: Session, user: models.User, workspace_id: str | None) -> dict[str, models.Space]:
    """source id -> the Space it is filed under (the first Space listing it)."""
    from .. import spaces as spaces_service
    out: dict[str, models.Space] = {}
    for sp in spaces_service.list_spaces(db, user, workspace_id):
        for sid in spaces_service.space_source_ids(db, user, sp.id):
            out.setdefault(sid, sp)
    return out


def file_into_space(db: Session, user: models.User, conv: models.Conversation, smap: dict | None = None) -> None:
    """R50: a conversation on a Space's data is filed in that Space, so Spaces count their conversations and Home
    labels each one with its Space. A conversation already in a Space, or without data, is left alone."""
    if conv.space_id or not conv.source_ids:
        return
    smap = smap if smap is not None else _space_map(db, user, conv.workspace_id)
    votes: dict[str, int] = {}
    for sid in conv.source_ids or []:
        sp = smap.get(sid)
        if sp is not None:
            votes[sp.id] = votes.get(sp.id, 0) + 1
    if votes:
        conv.space_id = max(votes.items(), key=lambda kv: kv[1])[0]
        db.commit()


def _headline(db: Session, c: models.Conversation, lm: models.Message) -> str | None:
    """R50: the line under a conversation's title on Home - its finding when it has one (the analysis headline),
    otherwise what was made: "Dashboard · 5 pages", "Every day at 8:00 AM · 22 segments watched"."""
    rows = (db.query(models.Message).filter(models.Message.conversation_id == c.id, models.Message.action.like("v2:%"))
            .order_by(models.Message.created_at.desc()).limit(25).all())
    for m in rows:
        st = _state(m)
        if st.get("kind") == "analysis" and st.get("status") == "done" and (st.get("analysis") or {}).get("prose", {}).get("headline"):
            return str(st["analysis"]["prose"]["headline"])[:160]
    st = _state(lm)
    kind, arts = st.get("kind"), st.get("artifacts") or []
    if kind in ("dashboard", "dashboard_edit"):
        a = next((x for x in arts if x.get("type") == "dashboard"), None)
        d = db.get(models.Dashboard, a["id"]) if a and a.get("id") else None
        if d is not None:
            n = len((d.board_spec or {}).get("pages") or []) if d.layout_version == 4 else None
            return f"{d.name} · dashboard" + (f" · {n} pages" if n else "")
    if kind == "automation":
        a = next((x for x in arts if x.get("type") == "automation"), None)
        sent = (a or {}).get("sentence") or (st.get("confirm") or {}).get("sentence") or {}
        fc = (st.get("confirm") or {}).get("first_check") or {}
        when = sent.get("when")
        if a and when:
            return f"{when} · watching"
        if st.get("status") == "confirm":
            return "Waiting for your confirm" + (f" · {fc['groups']} segments" if fc.get("groups") else "")
    if kind == "document" and (st.get("document") or {}).get("title"):
        return f"Document · {st['document']['title']}"[:160]
    if st.get("text"):
        return str(st["text"]).split(". ")[0][:140]
    return None


def _written_title(db: Session, conv: models.Conversation, question: str, title: str | None) -> None:
    """R50: a conversation still named after its first sentence takes the name of what it made."""
    if not title or conv is None:
        return
    cur = (conv.title or "").strip().lower()
    if cur in ((question or "").strip()[:80].lower(), "new conversation", ""):
        conv.title = title.strip()[:80]
        db.commit()


_WORK = (("analysis", "analysis"), ("model", "model"), ("guided", "guided analysis"), ("dashboard", "dashboard"), ("dashboard_edit", "dashboard"),
         ("automation", "automation"), ("document", "document"), ("team", "team"), ("knowledge", "world question"), ("chat", "chat"))


def _work_label(kinds: set[str], has_runs: bool) -> str:
    """R50: what a conversation holds, in two words at most: "analysis + dashboard"."""
    seen: list[str] = []
    for k, lab in _WORK:
        if k in kinds and lab not in seen:
            seen.append(lab)
    if has_runs and "answer" not in seen:
        seen.insert(0 if not seen else 1, "answer")
    seen = [x for x in seen if x != "chat"] or seen
    return " + ".join(seen[:2]) if seen else "conversation"


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
            if probe["intent"] in ("data", "dashboard", "analysis", "model") and ids:
                conv.source_ids, conv.datasource_id = ids, ids[0]
                db.commit()
                file_into_space(db, user, conv)
                has_sources = True
                _save_meta(db, conv, _meta(conv) | {"sources_picked_for": text[:120]})
        except HTTPException:
            pass
    names, cols = _source_names(db, conv)
    last = _last_turn_kind(db, conv)
    cur_dash = _current_dashboard(db, conv, user)
    has_dash = cur_dash is not None
    edit_fn = board.wants_edit if cur_dash is not None and (cur_dash.layout_version or 0) == 4 else dashboard_tool.wants_edit
    # R51: "make the brief shorter", "rename the doc ...", "undo" right after a document - the document on the canvas changes
    doc_edit = False
    if intent not in KINDS and docblocks.wants_edit(text) and _latest_doc(db, conv) is not None:
        doc_edit = (last in ("document", "document_edit")) if re.match(r"^\s*undo\b", text, re.I) else \
            (last in ("document", "document_edit") or bool(re.search(r"\b(brief|doc|document|report|memo|summary)\b", text, re.I)))
    # R52: follow-ups to an analysis answered from it - the risk list, a what-if
    follow = None
    if intent not in KINDS and not doc_edit and (followups.wants_list(text) or followups.wants_whatif(text)) and not team_tool.wants_team(text):
        an = _last_analysis(db, conv)
        if an and followups.wants_list(text) and (an.get("analysis") or {}).get("tiers"):
            follow = {"intent": "list", "by": "rule", "reason": "a list from the analysis above"}
        elif an and followups.wants_whatif(text):
            follow = {"intent": "whatif", "by": "rule", "reason": "a what-if on the analysis above"}
    decision = {"intent": intent, "by": "person", "reason": "chosen on the card", "text": text} if intent in KINDS else \
        follow if follow else \
        {"intent": "document_edit", "by": "rule", "reason": "changes the document on the canvas"} if doc_edit else \
        intents.route(text, has_sources=has_sources, source_names=names, column_names=cols, last_kind=last, mode=mode, has_dashboard=has_dash,
                      wants_team=team_tool.wants_team, wants_edit=edit_fn)
    kind = decision["intent"]
    if kind == "dashboard_edit" and not has_dash:
        kind = "dashboard"
    if kind == "data" and mode == "guided":
        kind = "guided"
    if kind == "analysis" and mode == "guided":
        kind = "guided"
    if kind in ("data", "guided", "analysis") and not has_sources:
        # the Analyst works from the question alone (what-if, simulation); anything else is a world question
        from ..project_engine import analyst as _analyst
        if not _analyst._ROUTE.search(text):
            kind = "knowledge"
            decision = {"intent": "knowledge", "by": "rule", "reason": "no data connected"}
        else:
            kind = "data"
    if kind == "data":
        return _start_data(db, conv, user, text, today, accepted, context_run_id, decision)
    if kind == "guided":
        return _start_guided(db, conv, user, text, decision)
    msg = _new_turn(db, conv, kind, text, today=(today or date.today()).isoformat(), timezone=timezone, intent_by=decision.get("by"),
                    intent_reason=decision.get("reason"), normalized=decision.get("text") if decision.get("normalized") else None,
                    **({"recipe": decision.get("recipe")} if kind == "analysis" else {}))
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


def _done_sentence(s: dict) -> str:
    """R50: "Done. Every day at 8:00 AM I check if ..., and notify you in GD360 the moment it happens." """
    when = (s.get("when") or "").strip().rstrip(".")
    do = (s.get("do") or "").strip().rstrip(".")
    do = do[:1].lower() + do[1:] if do else do
    tell = (s.get("tell_sentence") or "").strip().rstrip(".")
    parts = [p for p in (f"{when} I {do}" if when and do else (when or do), tell) if p]
    return ("Done. " + ", and ".join(parts) + ".") if parts else "Done."


def revise(db: Session, conv: models.Conversation, user: models.User, message_id: str, edits: dict) -> dict:
    """R50: "Change the threshold" on an alert card - the line moves, the first check and the sentence are redone,
    and the card still waits for Confirm."""
    msg = db.get(models.Message, message_id)
    if msg is None or msg.conversation_id != conv.id:
        raise HTTPException(404, "That card is not in this conversation.")
    st = _state(msg)
    card = dict(st.get("confirm") or {})
    if st.get("status") != "confirm" or card.get("kind") != "automation":
        raise HTTPException(400, "There is nothing to change on this turn.")
    body = dict(card.get("body") or {})
    trig = dict(body.get("trigger") or {})
    if trig.get("type") != "threshold":
        raise HTTPException(400, "Only an alert has a line to change.")
    try:
        value = float(str((edits or {}).get("value")).replace("%", "").strip())
    except (TypeError, ValueError):
        raise HTTPException(400, "Enter the line as a number, like 20.")
    trig["value"] = value
    body["trigger"] = trig
    fields = automations_tool.svc.validate(db, user, body)
    tg = fields.get("trigger") or trig
    card.update(body=body, sentence=automations_tool.svc.sentence(db, fields),
                first_check=automations_tool.first_check_for(db, user, tg),
                threshold={"value": value, "unit": tg.get("unit") or "", "op": tg.get("op")})
    if (tg.get("target") or {}).get("kind") == "segments":
        card["watches"] = segment_watch.watches_text(tg["target"], (card.get("first_check") or {}).get("groups"), (card.get("first_check") or {}).get("entities"))
    nm = str(body.get("name") or "")
    if re.match(r"^Segment .+ (above|below) [\d.]+%$", nm):
        body["name"] = re.sub(r"[\d.]+%$", f"{value:g}%", nm)
    _set_state(db, msg, confirm=card, text=_alert_sentence(card), error=None)
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
        _written_title(db, conv, st.get("question") or "", created.get("name"))
        _set_state(db, msg, status="done", confirm=None, error=None,
                   artifacts=[{"type": "automation", "id": created["id"], "name": created["name"], "url": f"/automations/{created['id']}",
                               "sentence": s, "next_run_at": created.get("next_run_at")}],
                   text=_done_sentence(s),
                   chips=[{"key": "automation", "ok": True, "label": "Watching" if (body.get("trigger") or {}).get("type") == "threshold" else "Scheduled"}])
        return _message_turn(db, msg, conv, user)
    if card.get("kind") == "team":
        body = dict(card.get("body") or {})
        if edits and edits.get("name"):
            body["name"] = str(edits["name"])[:60]
        try:
            created = team_tool.create(db, user, body)
        except HTTPException as e:
            _set_state(db, msg, status="confirm", error=str(e.detail))
            return _message_turn(db, msg, conv, user)
        made = created.get("rules_made") or []
        skipped = created.get("rules_skipped") or []
        text = f"“{created['name']}” is ready as a Space with {len(body.get('source_ids') or [])} source{'s' if len(body.get('source_ids') or []) != 1 else ''}"
        text += f" and {len(made)} data rule{'s' if len(made) != 1 else ''}." if made else "."
        if skipped:
            text += " Not applied: " + "; ".join(skipped[:3]) + "."
        if body.get("conversation_id") == conv.id and created.get("space_id"):
            conv.space_id = created["space_id"]  # R52: "share this with the team" - the conversation moves into its Space
            db.commit()
            text += " This conversation is in it now."
        if card.get("to_invite"):
            text += " Invite " + ", ".join(card["to_invite"]) + " with the workspace link; they join as members."
        _set_state(db, msg, status="done", confirm=None, error=None,
                   artifacts=[{"type": "space", "id": created["space_id"], "name": created["name"], "url": created["url"],
                               "rules": made, "invite_link": card.get("invite_link")}],
                   text=text, chips=[{"key": "team", "ok": True, "label": f"{len(made)} rule{'s' if len(made) != 1 else ''} enforced on every answer"}] if made
                   else [{"key": "team", "ok": True, "label": "Space created"}])
        return _message_turn(db, msg, conv, user)
    raise HTTPException(400, "Unknown card.")


# ---- reading ------------------------------------------------------------------------

def _run_turn(db: Session, run: models.ProjectRun, conv: models.Conversation, user: models.User, full: bool) -> dict:
    from ...routers.projects import _run_out
    if run.status in ("planning", "running") and run.auto_run and run.created_at is not None and \
            _stale(run.created_at.isoformat(), budgets.hard("data"), grace=0):  # step-by-step runs wait for the person: no stop
        from ..project_engine import executor
        try:
            executor.request_stop(run.id)
            run.error_message = budgets.timeout_text("data")
            if run.status == "planning":
                run.status, run.finished_at = "stopped", datetime.utcnow()
            db.commit()
            print(f"[agent.budget] data run {run.id[:8]} stopped after {budgets.hard('data')} s")
        except Exception:  # noqa: BLE001
            db.rollback()
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
        "artifacts": [], "trail": trail, "elapsed_s": out.get("duration_seconds"), "error": out.get("error"), "budget_s": budgets.budget("data"),
        "intent_by": (plan.get("v2_intent") or {}).get("by"), "mode": "analyst" if plan.get("mode") == "analyst" else "engine",
        "placements": [p for p in ((_meta(conv).get("placements") or {}).values()) if run.id in (p.get("run_ids") or [])],
    }


def _viewer_rules(db: Session, user: models.User | None, source_id: str | None) -> dict | None:
    """R52: None when this person sees the source unrestricted; else {"hidden": {columns}, "rows": bool} from the data rules
    on their role - stored rows (a risk list) are cut the same way a live query would be."""
    if user is None or not source_id:
        return None
    from .. import data_access_rules
    ds = db.get(models.DataSource, source_id)
    if ds is None:
        return None
    role = data_access_rules.resolve_restriction_role(db, ds, user)
    if role is None:
        return None
    rules = db.query(models.DataAccessRule).filter(models.DataAccessRule.datasource_id == ds.id, models.DataAccessRule.role == role).all()
    if not rules:
        return None
    return {"hidden": {r.column_name for r in rules if r.kind == "column"}, "rows": any(r.kind == "row" for r in rules)}


def _cut_rows(rows: list[dict], a: dict, rules: dict) -> list[dict] | None:
    if rules.get("rows"):
        return None  # row rules need columns the stored list does not carry: show nothing rather than too much
    id_col = (a.get("risk_list") or {}).get("id_column") or a.get("id_column")
    hidden_labels = {s.get("label") for s in (a.get("signals") or []) if s.get("column") in rules["hidden"]}
    out = []
    for r in rows:
        r2 = {k: v for k, v in r.items() if k not in hidden_labels}
        if id_col and id_col in rules["hidden"]:
            r2["id"] = "hidden"
        out.append(r2)
    return out


def list_for(db: Session, msg: models.Message, user: models.User | None, full: bool = False) -> dict | None:
    """The list a turn holds, as this person may see it (full=True: every stored row, for the download)."""
    st = _state(msg)
    lst = st.get("list")
    if not lst:
        return None
    rows = (st.get("list_all") or lst.get("rows") or []) if full else (lst.get("rows") or [])
    conv = db.get(models.Conversation, msg.conversation_id)
    an = _last_analysis(db, conv) if conv else None
    a = (an or {}).get("analysis") or {}
    rules = _viewer_rules(db, user, (a.get("table") or {}).get("source_id"))
    if rules:
        rows = _cut_rows(rows, a, rules)
        if rows is None:
            return {**lst, "rows": [], "shown": 0, "restricted": "Your data rules on this source hide this list."}
        return {**lst, "rows": rows, "restricted": "Some columns are hidden by your data rules."}
    return {**lst, "rows": rows}


def _stale(started: str | None, limit: int | None, grace: int = 30) -> bool:
    if not started or not limit:
        return False
    try:
        return (datetime.utcnow() - datetime.fromisoformat(started.rstrip("Z"))).total_seconds() > limit + grace
    except ValueError:
        return False


def _analysis_for(db: Session, st: dict, user: models.User | None) -> dict | None:
    a = st.get("analysis")
    if not a or not (a.get("risk_list") or {}).get("rows"):
        return a
    rules = _viewer_rules(db, user, (a.get("table") or {}).get("source_id"))
    if not rules:
        return a
    rows = _cut_rows(a["risk_list"]["rows"], a, rules) or []
    return {**a, "risk_list": {**a["risk_list"], "rows": rows}}


def _message_turn(db: Session, msg: models.Message, conv: models.Conversation, user: models.User) -> dict:
    st = _state(msg)
    if st.get("status") == "working" and _stale(st.get("started_at"), budgets.hard(st.get("kind"))):
        # the worker is gone (a restart) or stuck: the same hard stop the timer gives
        st = _set_state(db, msg, status="failed", timed_out=True, error=budgets.timeout_text(st.get("kind")), finished_at=datetime.utcnow().isoformat() + "Z")
    elapsed = st.get("elapsed_s")
    if elapsed is None and st.get("finished_at") and st.get("started_at"):
        try:
            elapsed = round((datetime.fromisoformat(st["finished_at"].rstrip("Z")) - datetime.fromisoformat(st["started_at"].rstrip("Z"))).total_seconds(), 1)
        except ValueError:
            elapsed = None
    out = {"id": msg.id, "kind": st.get("kind"), "status": st.get("status"), "question": st.get("question"),
           "created_at": msg.created_at, "finished_at": st.get("finished_at"), "text": st.get("text"), "sources": st.get("sources") or [],
           "grounded": st.get("grounded"), "chips": st.get("chips") or [], "verdict": "ok", "artifacts": st.get("artifacts") or [],
           "trail": st.get("trail") or [], "elapsed_s": elapsed, "error": st.get("error"), "confirm": st.get("confirm"),
           "check": st.get("check"), "explain": st.get("explain"), "document": st.get("document"), "issues": st.get("issues") or [],
           "run_id": st.get("run_id"), "guided_project_id": st.get("guided_project_id"), "intent_by": st.get("intent_by"),
           "normalized": st.get("normalized"), "analysis": _analysis_for(db, st, user) if st.get("kind") == "analysis" else None,
           "edit": st.get("edit"), "built": st.get("built"), "list": list_for(db, msg, user) if st.get("list") else None, "whatif": st.get("whatif"),
           "budget_s": budgets.budget(st.get("kind")), "timed_out": st.get("timed_out")}
    if st.get("kind") == "model" and st.get("model_id") and st.get("status") == "working":
        try:
            ms = model_tool.status(db, user, st["model_id"])
        except Exception as e:  # noqa: BLE001 - the page keeps polling
            print(f"[agent.model] status skipped: {e}")
            ms = {"status": "working", "text": st.get("text"), "chips": []}
        if ms["status"] in ("done", "failed"):
            st = _set_state(db, msg, status=ms["status"], text=ms.get("text"), chips=ms.get("chips") or [],
                            artifacts=[ms["artifact"]] if ms.get("artifact") else [], model_summary=ms.get("summary"),
                            error=ms.get("text") if ms["status"] == "failed" else None, finished_at=datetime.utcnow().isoformat() + "Z",
                            trail=(st.get("trail") or []) + [{"label": "Scored on held-out rows"}, {"label": "Checked for leaking columns"}])
            out.update({"status": st["status"], "text": st.get("text"), "chips": st.get("chips") or [], "artifacts": st.get("artifacts") or [],
                        "error": st.get("error"), "finished_at": st.get("finished_at"), "trail": st.get("trail") or []})
        else:
            out["text"] = ms.get("text") or out["text"]
            if ms.get("trail"):
                out["trail"] = (st.get("trail") or []) + ms["trail"]
        out["model_summary"] = st.get("model_summary")
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
    smap = None
    spaces: dict[str, models.Space | None] = {}
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
        headline, last_at = ans.get("headline"), (last.created_at if last else c.created_at)
        lm = (db.query(models.Message).filter(models.Message.conversation_id == c.id, models.Message.action.like("v2:%"))
              .order_by(models.Message.created_at.desc()).first())
        if lm is not None and (last is None or (lm.created_at or datetime.min) > (last.created_at or datetime.min)):
            last_at = lm.created_at or last_at
            headline = _headline(db, c, lm) or headline
        if not c.space_id and c.source_ids and c.owner_id == user.id:
            if smap is None:
                smap = _space_map(db, user, workspace_id)
            file_into_space(db, user, c, smap)
        sp = None
        if c.space_id:
            if c.space_id not in spaces:
                spaces[c.space_id] = db.get(models.Space, c.space_id)
            sp = spaces[c.space_id]
        kinds = {str(a).split(":", 1)[1] for (a,) in db.query(models.Message.action).filter(
            models.Message.conversation_id == c.id, models.Message.action.like("v2:%")).distinct().all() if a}
        out.append({"id": c.id, "title": (c.title[:1].upper() + c.title[1:]) if c.title else c.title, "created_at": c.created_at, "space_id": c.space_id, "pinned": bool(c.pinned),
                    "last_at": last_at, "headline": headline, "v2": is_v2(c),
                    "kind": c.kind, "mine": c.owner_id == user.id,
                    "space_name": sp.name if sp is not None else None, "space_color": sp.color if sp is not None else None,
                    "work": _work_label(kinds, last is not None)})
        if len(out) >= limit:
            break
    out.sort(key=lambda x: (not x["pinned"], -(x["last_at"] or datetime.min).timestamp()))
    return out
