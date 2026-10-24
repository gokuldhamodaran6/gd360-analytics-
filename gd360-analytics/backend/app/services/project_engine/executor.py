"""
Runs a project question end to end, in a background thread, writing its
progress to the ProjectRun row as it goes so the page can show it live.

  plan_run(run_id)     - build the catalog, ask the planner, store the plan;
                         then run it straight away when auto_run is on.
  execute_run(run_id)  - run every step (in parallel), the combine steps,
                         the analysis and the composer; store the answer.

Each background job opens its own database session. Steps run in a thread
pool; a step never touches the session (warehouse_exec.run_sql is
session-free, DuckDB steps get plain DataFrames), and every write to the
run row happens on the job's own thread.

Guards on every step: read-only SQL (sqlcheck + the connector's own
check), the source's cost caps, the person's daily scan budget, and their
row/column rules (DuckDB sources: the loaded table is filtered first; a
live warehouse with rules for this person is not queried - the same policy
the one-source chat uses).
"""
from __future__ import annotations

import re
import threading
import time
from types import SimpleNamespace
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime

import duckdb
import pandas as pd
import sqlglot
from sqlglot import exp
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from ... import models
from ...config import get_settings
from ...database import SessionLocal
from .. import ai_engine, data_access_rules, data_loader, synced_sources, warehouse_exec
from ..pushdown_budget import log_pushdown
from . import composer, planner
from .analysis import AnalysisError, run_analysis, table_payload
from .catalog import Catalog, CatalogSource, build_catalog
from .sqlcheck import ROW_CAP, ensure_row_cap

settings = get_settings()

_RUN_SLOTS = threading.BoundedSemaphore(max(1, settings.PROJECT_MAX_CONCURRENT_RUNS))
_STOP_REQUESTED: set[str] = set()
FILE_ROW_CAP = 300_000
PREVIEW_ROWS = 50


# ---- public entry points -----------------------------------------------------

def start_planning(run_id: str) -> None:
    threading.Thread(target=_guarded, args=(plan_run, run_id), daemon=True, name=f"plan-{run_id[:8]}").start()


def start_execution(run_id: str) -> None:
    threading.Thread(target=_guarded, args=(execute_run, run_id), daemon=True, name=f"run-{run_id[:8]}").start()


def request_stop(run_id: str) -> None:
    _STOP_REQUESTED.add(run_id)


def _guarded(fn, run_id: str) -> None:
    db = SessionLocal()
    try:
        fn(db, run_id)
    except Exception as e:  # noqa: BLE001 - a background job must always leave a final status
        traceback.print_exc()
        try:
            db.rollback()
            run = db.get(models.ProjectRun, run_id)
            if run and run.status in ("planning", "planned", "running"):
                run.status = "failed"
                # R59: never a Python message in front of the person - the details stay in the server log
                run.error_message = ("Something went wrong on our side while answering this. It has been logged - "
                                     "ask it again, or put it another way.")
                run.finished_at = datetime.utcnow()
                db.commit()
        except Exception:  # noqa: BLE001
            traceback.print_exc()
    finally:
        db.close()
        _STOP_REQUESTED.discard(run_id)


# ---- planning ----------------------------------------------------------------

def _history(db: Session, run: models.ProjectRun) -> list[dict]:
    prev = (
        db.query(models.ProjectRun)
        .filter(models.ProjectRun.conversation_id == run.conversation_id, models.ProjectRun.id != run.id,
                models.ProjectRun.created_at <= run.created_at)
        .order_by(models.ProjectRun.created_at.asc())
        .all()
    )
    # 2026-10-11 (Guided follow-ups): in a Guided Analysis thread the two
    # latest earlier questions also list the steps that ran, so a follow-up
    # plan can reuse one exactly (guided.reuse_earlier then copies its result
    # instead of querying the source again).
    conv = db.get(models.Conversation, run.conversation_id)
    guided = bool(conv and conv.kind == "guided")
    recent = [p for p in prev if p.status != "replaced"][-4:]
    out = []
    for i, p in enumerate(recent):
        ans = (p.result or {}).get("answer") or {}
        item = {"question": p.question, "headline": ans.get("headline")}
        if guided and i >= len(recent) - 2:
            item["steps"] = [
                {"title": s.get("title"), "source_id": s.get("source_id"), "sql": s.get("sql")}
                for s in (p.steps or []) if s.get("kind") != "combine" and s.get("status") == "done"
            ][:8]
        out.append(item)
    return out


def initial_steps(plan: dict) -> list[dict]:
    out = []
    for st in plan.get("steps") or []:
        out.append({
            "id": st["id"], "kind": "step", "title": st["title"], "purpose": st.get("purpose"),
            "source_id": st["source_id"], "source_name": st.get("source_name"), "source_kind": st.get("source_kind"),
            "mode": st.get("mode"), "dialect": st.get("dialect"), "sql": st["sql"], "status": "pending",
            "rows_returned": None, "bytes_scanned": None, "rows_read": None, "duration_ms": None, "error": None,
            "repaired": False, "truncated": False, "columns": None, "preview": None,
            "tweaks": st.get("tweaks") or [], "approved": False,
        })
    for cb in plan.get("combine") or []:
        out.append({
            "id": cb["id"], "kind": "combine", "title": cb["title"], "purpose": cb.get("purpose"), "source_id": None,
            "source_name": "Combined", "source_kind": "duckdb", "mode": "combine", "dialect": "duckdb", "sql": cb["sql"],
            "status": "pending", "rows_returned": None, "duration_ms": None, "error": None, "repaired": False,
            "truncated": False, "columns": None, "preview": None,
            "tweaks": cb.get("tweaks") or [], "approved": False,
        })
    return out


def plan_run(db: Session, run_id: str) -> None:
    run = db.get(models.ProjectRun, run_id)
    if not run:
        return
    conv = db.get(models.Conversation, run.conversation_id)
    user = db.get(models.User, run.owner_id)
    catalog = build_catalog(db, user, list(conv.source_ids or []))
    # R57: "Guided analysis" asked in a conversation - the same step-by-step engine as a Guided Analysis page
    guided_v2 = bool(isinstance(run.plan, dict) and run.plan.get("guided_v2"))
    guided = bool(conv and conv.kind == "guided") or guided_v2
    keep = {k: v for k, v in (run.plan or {}).items() if k in ("guided_v2", "v2_intent", "report")} if isinstance(run.plan, dict) else {}
    # 2026-10-13 (R43): questions that need a model, a scenario, a simulation, maths SQL can't hold - or no
    # data at all - go to the Analyst (writes and runs Python, checks itself, decision-first answer)
    from . import analyst
    if not run.note and analyst.wants_analyst(run.question, catalog, "guided" if guided else (conv.kind if conv else "project")):
        _run_analyst(db, run, catalog, user)
        return
    previous = None
    if run.note:
        # a re-plan: the plan this run replaces is kept on the run itself
        previous = (run.plan or {}).get("replaced_plan") or run.plan
    try:
        # 2026-10-11 (round 24): what the person agreed before planning (the
        # period in dates, the read-back) travels with the question
        from ..question_check import planner_context
        brief = (run.plan or {}).get("brief") if isinstance(run.plan, dict) else None
        # round 32: slipped words read as meant ("forcast" -> forecast), and a forecast of a year that has
        # already gone ("2016 forcast") read as the coming one when nothing was agreed before planning
        asked, read_as = _read_question(run.question, brief)
        if read_as.get("brief"):
            brief = read_as["brief"]
        plan = planner.make_plan(asked + planner_context(brief), catalog, _history(db, run), note=run.note,
                                 previous=previous, guided=guided)
        if brief:
            plan["brief"] = brief
        if read_as.get("assumptions"):
            plan["assumptions"] = read_as["assumptions"] + list(plan.get("assumptions") or [])
    except planner.PlanningError as e:
        if not guided and "AI" not in str(e) and "usage limit" not in str(e):
            # R43: no SQL plan fits - the Analyst reads the data itself instead of giving up
            _run_analyst(db, run, catalog, user, fallback_note=str(e))
            return
        run.status = "failed"
        run.error_message = str(e)
        run.finished_at = datetime.utcnow()
        db.commit()
        return
    plan["catalog"] = [
        {"id": s.id, "name": s.name, "kind": s.kind, "label": s.label, "mode": s.mode, "freshness": s.freshness,
         "restricted": s.restricted, "tables": len(s.tables)}
        for s in catalog.sources
    ]
    plan.update(keep)
    run.plan = plan
    run.steps = initial_steps(plan)
    if not plan.get("can_answer", True) and not guided:
        # R43: what SQL alone can't answer, the Analyst can - it models, assumes out loud and computes
        run.plan = plan
        _run_analyst(db, run, catalog, user, fallback_note=plan.get("missing") or "the data has no direct query for it")
        return
    if not plan.get("can_answer", True):
        # round 32: never a dead end - what the data CAN answer that comes closest, as one-tap choices
        run.status = "needs_input"
        run.result = {"answer": {
            "headline": "I can't answer that from this data yet.",
            "answer": plan.get("missing") or "The data needed for this question is not in the project's sources.",
            "causes": [], "ruled_out": [], "next_questions": [],
            "options": ways_forward(plan, run.question, catalog),
        }}
        run.finished_at = datetime.utcnow()
        _assistant_message(db, run, run.result["answer"])
        db.commit()
        return
    run.status = "planned"
    if conv and (not conv.title or conv.title in ("New analysis", "New project")) and plan.get("title"):
        conv.title = plan["title"][:80]
    claimed = False
    if guided:
        # 2026-10-11: busy BEFORE the plan is visible, so the page keeps
        # following the run until its first step (or every step) is done
        from . import guided as guided_engine
        claimed = guided_engine.claim_for_planning(run_id)
    try:
        db.commit()
    except Exception:
        if claimed:
            guided_engine._release(run_id)
        raise
    if guided:
        # 2026-10-10 (Guided Analysis): the plan is shown and the first step
        # runs straight away; every later step waits for the person.
        # 2026-10-11: a follow-up first takes every step that is the same as
        # one an earlier question already ran; a follow-up asked as a Quick
        # answer (auto_run) runs every step and writes the answer.
        guided_engine.after_plan(db, run_id, bool(run.auto_run), claimed)
        return
    if run.auto_run:
        execute_run(db, run_id)


def _run_analyst(db: Session, run: models.ProjectRun, catalog, user, fallback_note: str | None = None) -> None:
    from . import analyst
    acquired = _RUN_SLOTS.acquire(timeout=120)
    if not acquired:
        run.status = "failed"
        run.error_message = "GD360 is busy answering other questions right now. Please try again in a minute."
        run.finished_at = datetime.utcnow()
        db.commit()
        return
    try:
        out = analyst.run(db, run, catalog, user, _history(db, run), fallback_note=fallback_note)
    finally:
        _RUN_SLOTS.release()
    if out and out.get("cannot"):
        # the facts are not in the data: the closest questions it CAN answer, one tap each (round 32)
        plan = dict(run.plan or {}) if isinstance(run.plan, dict) else {}
        plan["can_answer"] = False
        plan["missing"] = plan.get("missing") or out["cannot"]
        plan["alternatives"] = plan.get("alternatives") or out.get("alternatives") or []
        run.plan = plan
        run.steps = run.steps or []
        run.status = "needs_input"
        run.result = {"answer": {
            "headline": "I can't answer that from this data yet.",
            "answer": plan["missing"], "causes": [], "ruled_out": [], "next_questions": [],
            "options": ways_forward(plan, run.question, catalog),
        }}
        run.finished_at = datetime.utcnow()
        _assistant_message(db, run, run.result["answer"])
        db.commit()


def _read_question(question: str, brief: dict | None) -> tuple[str, dict]:
    """The question as the planner reads it (round 32): intent words with an obvious slip read as meant,
    and - only when nothing was agreed before planning - a forecast for a year already gone read as the
    coming one ("2016 forcast in sales" -> 2026), said in the plan's assumptions."""
    from datetime import date as _date
    from .. import question_check as qc
    fixed, fixes = qc.read_typos(question)
    out: dict = {}
    notes = [f"Read “{a}” as “{b}”." for a, b in list(fixes.items())[:2]]
    if not (brief or {}).get("period") and qc.wants_forecast(fixed):
        today = _date.today()
        period, _ = qc.parse_period(fixed, today)
        said = qc._said_year(fixed, period) if period and not period.get("parts") else None  # noqa: SLF001
        if said:
            issue = qc._forecast_year_issue(said, qc.forecast_span(period, today), [], today, set(), "")  # noqa: SLF001
            if issue:
                meant = issue["suggested"]
                fixed = re.sub(rf"\b{said}\b", meant, fixed)
                p2, _ = qc.parse_period(fixed, today)
                if p2:
                    out["brief"] = {"period": qc.forecast_span(p2, today), "forecast": True}
                notes.append(f"Read {said} as {meant}: a forecast looks ahead, and {said} has already happened.")
    if notes:
        out["assumptions"] = notes
    return fixed, out


_TABLE_QUESTIONS = {
    "accounts": "How many followers does each account have?",
    "posts": "Which posts got the most engagement?",
    "channel_daily": "How has daily reach changed over time?",
    "campaign_daily": "Which campaigns spent the most?",
    "messages_daily": "How many WhatsApp messages were delivered each day?",
    "conversations_daily": "What did WhatsApp cost by category?",
    "templates": "Which WhatsApp templates were read the most?",
    "phone_numbers": "What is the quality rating of each WhatsApp number?",
    "traffic_daily": "How has traffic changed over time?",
    "orders": "How have orders changed over time?",
}


_EMPTY_WORDS = {
    "posts": ("post", "reel", "story", "stories", "caption", "content type", "publishing"),
    "channel_daily": ("reach", "impression", "daily", "per day", "follower growth", "growth", "trend", "over time",
                      "by month", "by week", "views"),
    "template_daily": ("template",), "templates": ("template",),
    "conversations_daily": ("cost", "spend", "billed", "conversation"),
    "messages_daily": ("delivered", "sent", "messages"),
}


def askable_next(questions: list, plan: dict, catalog) -> list:
    """Round 38c: "Ask next" never suggests a question the data can't answer - a suggestion that needs a table
    with no rows is swapped for one the filled tables can answer."""
    used = {s.get("source_id") for s in plan.get("steps") or []}
    srcs = [x for x in catalog.sources if x.id in used] or list(catalog.sources)
    empty = {t.name for x in srcs for t in x.tables if t.rows == 0}
    filled = [t.name for x in srcs for t in x.tables if t.rows]
    if not empty:
        return questions
    bad_words = [w for t in empty for w in _EMPTY_WORDS.get(t, ())]
    keep = [q for q in questions if not any(w in str(q).lower() for w in bad_words)]
    for t in filled:
        q = _TABLE_QUESTIONS.get(t)
        if len(keep) >= 3:
            break
        if q and q not in keep:
            keep.append(q)
    return keep[:3]


def empty_for_lack_of_data(plan: dict, catalog) -> bool:
    """An all-empty result is "this app holds nothing for it yet" only when a query read a synced app's table
    that has no rows at all. A file or database that has rows but none matching the dates or filters keeps
    the normal answer path (it is the question that's off, not the data)."""
    for st in plan.get("steps") or []:
        src = catalog.source(st.get("source_id")) if st.get("source_id") else None
        if src is None or src.mode != "synced":
            continue
        sql = str(st.get("sql") or "").lower()
        for t in src.tables:
            if t.rows == 0 and re.search(rf"\b{re.escape(t.name.lower())}\b", sql):
                return True
    return False


def _held_words(table: str, rows: int) -> str:
    """"2 accounts' details", "24 posts", "1,462 daily rows" - what a table holds, in plain words."""
    if table in ("accounts", "pages", "ad_accounts", "phone_numbers", "properties", "sites"):
        noun = {"phone_numbers": "phone number", "properties": "property", "sites": "site"}.get(table, "account")
        return f"{rows:,} {noun}{'s' if rows != 1 else ''}' details" if noun != "property" else f"{rows:,} properties' details"
    if table == "posts":
        return f"{rows:,} post{'s' if rows != 1 else ''}"
    if table.endswith("daily"):
        return f"{rows:,} daily rows"
    return f"{table.replace('_', ' ')} ({rows:,} rows)"


def _and_list(xs: list[str]) -> str:
    return xs[0] if len(xs) == 1 else ", ".join(xs[:-1]) + " and " + xs[-1]


def _no_data_answer(db: Session, run: models.ProjectRun, plan: dict, catalog) -> None:
    """Round 38c: the queries ran and every result was empty. The answer says, in plain words, what the
    source does hold, why the rest is missing (its sync report), and offers what it CAN answer."""
    used_ids = [s.get("source_id") for s in plan.get("steps") or [] if s.get("source_id")]
    srcs = [catalog.source(i) for i in dict.fromkeys(used_ids)]
    srcs = [x for x in srcs if x is not None] or list(catalog.sources)[:1]
    names = ", ".join(x.name for x in srcs[:2]) or "This data"
    have, why, asks, links = [], [], [], []
    for src in srcs[:2]:
        filled = [t for t in src.tables if t.rows]
        if src.mode != "synced":
            have.append(f"Nothing in {src.name} matched this question")  # row counts are only known for apps
        elif filled:
            have.append(f"{src.name} only holds " + _and_list([_held_words(t.name, t.rows) for t in filled[:3]])
                        + " so far - nothing this question needs")
        else:
            have.append(f"{src.name} hasn't brought in any rows yet")
        ds = db.get(models.DataSource, src.id)
        rep = ((ds.connection_info or {}).get("sync_report") if ds and isinstance(ds.connection_info, dict) else None) or {}
        for p in (rep.get("problems") or [])[:3]:
            why.append(str(p))
        for t in filled:
            q = _TABLE_QUESTIONS.get(t.name)
            if q and q not in asks:
                asks.append(q)
        if src.mode == "synced":
            links.append({"id": f"source-{src.id}", "label": f"See what {src.name} sent at the last sync",
                          "href": f"/data?tab=sources&report={src.id}", "kind": "connect"})
    for q in plan.get("alternatives") or []:
        q = re.sub(r"\s+", " ", str(q or "")).strip()
        if 4 <= len(q) <= 140 and q not in asks:
            asks.append(q)
    text = ". ".join(have) + "."
    if why:
        text += " What's missing and why: " + " ".join(w if w.endswith(".") else w + "." for w in why)
    answer = {
        "headline": f"{names} has nothing to show for this yet.",
        "answer": text,
        "causes": [], "ruled_out": [], "next_questions": [],
        "options": [{"id": f"alt{i + 1}", "label": q, "question": q, "kind": "ask"} for i, q in enumerate(asks[:3])] + links[:1],
        "no_data": True,
    }
    run.status = "needs_input"
    run.result = {"answer": answer, "no_data": True, "warnings": [],
                  "queries": sum(1 for s in run.steps or [] if s.get("status") in ("done", "failed"))}
    run.finished_at = datetime.utcnow()
    _assistant_message(db, run, answer)
    db.commit()


def ways_forward(plan: dict, question: str, catalog=None) -> list[dict]:
    """The closest questions the sources CAN answer (round 32) - from the planner's own alternatives,
    plus connecting data that has what's missing."""
    out: list[dict] = []
    for q in plan.get("alternatives") or []:
        q = re.sub(r"\s+", " ", str(q or "")).strip()
        if 4 <= len(q) <= 140 and q.lower() != (question or "").strip().lower() and q not in [o["question"] for o in out]:
            out.append({"id": f"alt{len(out) + 1}", "label": q, "question": q, "kind": "ask"})
    out = out[:3]
    # round 38c: an app that synced but holds nothing for this - its own report says why, one tap away
    synced_empty = [x for x in (catalog.sources if catalog else []) if x.mode == "synced" and any(t.rows == 0 for t in x.tables)]
    if synced_empty:
        x = synced_empty[0]
        out.append({"id": f"source-{x.id}", "label": f"See what {x.name} sent at the last sync", "href": f"/data?tab=sources&report={x.id}",
                    "kind": "connect"})
        return out
    out.append({"id": "connect", "label": "Connect data that has it", "href": "/data?tab=catalog", "kind": "connect"})
    return out


# ---- loading data for DuckDB sources -----------------------------------------

def _referenced_tables(sql: str, dialect: str) -> list[str]:
    try:
        tree = sqlglot.parse_one(sql, read=dialect)
    except Exception:  # noqa: BLE001
        return []
    ctes = {c.alias_or_name.lower() for c in tree.find_all(exp.CTE)}
    names = []
    for t in tree.find_all(exp.Table):
        if t.name and t.name.lower() not in ctes and not isinstance(t.this, exp.Func):
            names.append(t.name)
    return list(dict.fromkeys(names))


def _load_inputs(db: Session, ds: models.DataSource, src: CatalogSource, sql: str, user: models.User) -> tuple[dict, int, str | None]:
    """{table name: DataFrame} for every table a DuckDB step reads, with the
    person's row/column rules applied. (frames, rows read, limit note)."""
    frames: dict[str, pd.DataFrame] = {}
    rows = 0
    note = None
    for name in _referenced_tables(sql, "duckdb"):
        t = src.table(name)
        if t is None:
            continue
        if src.mode == "synced":
            df = synced_sources.load_table(db, ds.id, t.source_key)
        else:
            df = data_loader.load_dataframe(ds, table=t.source_key, db=db)
            if ds.kind == "mongodb" and len(df) >= settings.MAX_ROWS_LOADED_PER_QUERY:
                note = f"Read the first {len(df):,} documents of {t.name}."
        if len(df) > FILE_ROW_CAP:
            df = df.head(FILE_ROW_CAP)
            note = f"Read the first {FILE_ROW_CAP:,} rows of {t.name}."
        try:
            df = data_access_rules.filter_dataframe_for_role(db, df, ds, user)
        except Exception as e:  # noqa: BLE001
            raise RuntimeError(f"Your access rules on {ds.name} could not be applied, so it was not read: {e}") from e
        frames[t.name] = df
        rows += len(df)
    return frames, rows, note


def _duckdb() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect(database=":memory:")
    try:
        con.execute(f"SET memory_limit='{settings.PROJECT_DUCKDB_MEMORY_LIMIT}'")
        con.execute("SET threads=2")
        con.execute("SET enable_external_access=false")
    except Exception:  # noqa: BLE001
        pass
    return con


def _run_duckdb(sql: str, frames: dict[str, pd.DataFrame]) -> pd.DataFrame:
    con = _duckdb()
    try:
        for name, df in frames.items():
            con.register(name, df)
        return con.execute(ensure_row_cap(sql, "duckdb")).df()
    finally:
        con.close()


# ---- running a step ----------------------------------------------------------

def _detached(ds: models.DataSource) -> SimpleNamespace:
    """The few fields a worker thread needs from a data source, copied out
    of the ORM object. Worker threads must never touch the session: an
    attribute of an expired ORM object reloads itself through it, and a
    session is not safe to use from several threads at once."""
    return SimpleNamespace(
        id=ds.id, name=ds.name, kind=ds.kind, connection_info=dict(ds.connection_info or {}),
        encrypted_secret=ds.encrypted_secret, schema_cache=ds.schema_cache,
    )


def _run_one(step: dict, ds: models.DataSource, src: CatalogSource, frames: dict | None) -> dict:
    """Runs one step (thread-safe, no session). Returns a result dict;
    repairs the query once when the engine rejects it."""
    started = time.perf_counter()
    sql = step["sql"]
    repaired = False
    last_error = None
    for attempt in range(2):
        try:
            if src.mode == "live":
                df, scanned = warehouse_exec.run_sql(ds, ensure_row_cap(sql, src.dialect))
            else:
                df, scanned = _run_duckdb(sql, frames or {}), None
            truncated = len(df) > ROW_CAP
            if truncated:
                df = df.head(ROW_CAP)
            return {"ok": True, "df": df, "sql": sql, "bytes_scanned": scanned, "repaired": repaired,
                    "truncated": truncated, "duration_ms": int((time.perf_counter() - started) * 1000),
                    "raw_error": None}
        except Exception as e:  # noqa: BLE001
            last_error = e
            status = warehouse_exec.classify_error(e)
            if attempt == 0 and status != "rejected_too_expensive":
                fixed = planner.repair_sql(step | {"sql": sql}, src, warehouse_exec.clean_warehouse_error(e))
                if fixed and fixed.strip() != sql.strip():
                    sql, repaired = fixed, True
                    continue
            break
    return {"ok": False, "sql": sql, "repaired": repaired, "error": warehouse_exec.clean_warehouse_error(last_error),
            "status": warehouse_exec.classify_error(last_error) if last_error else "error",
            "duration_ms": int((time.perf_counter() - started) * 1000), "raw_error": str(last_error)[:2000]}


def _set_step(run: models.ProjectRun, step_id: str, **fields) -> None:
    steps = list(run.steps or [])
    for i, s in enumerate(steps):
        if s.get("id") == step_id:
            steps[i] = {**s, **fields}
    run.steps = steps
    flag_modified(run, "steps")


def _stopped(db: Session, run: models.ProjectRun) -> bool:
    if run.id in _STOP_REQUESTED:
        return True
    db.refresh(run)
    return run.status == "stopped"


def execute_run(db: Session, run_id: str) -> None:
    run = db.get(models.ProjectRun, run_id)
    if not run or run.status not in ("planned",):
        return
    acquired = _RUN_SLOTS.acquire(timeout=120)
    if not acquired:
        run.status = "failed"
        run.error_message = "GD360 is busy answering other questions right now. Please try again in a minute."
        run.finished_at = datetime.utcnow()
        db.commit()
        return
    try:
        _execute(db, run)
    finally:
        _RUN_SLOTS.release()


def run_plan(db: Session, plan: dict, user: models.User, catalog: Catalog, set_step, should_stop) -> tuple[dict, list[dict]]:
    """Runs every step and combine step of `plan`. `set_step(step_id,
    **fields)` records progress (the caller decides where - a ProjectRun
    row, or nothing); `should_stop()` is polled between steps. Returns
    ({step id: DataFrame}, evidence tables)."""
    tables: dict[str, pd.DataFrame] = {}
    evidence: list[dict] = []
    jobs = []
    for st in plan.get("steps") or []:
        src = catalog.source(st["source_id"])
        ds = db.get(models.DataSource, st["source_id"])
        if src is None or ds is None:
            set_step(st["id"], status="failed", error="This source is no longer available to you.")
            continue
        if src.mode == "live" and src.restricted:
            set_step(st["id"], status="failed",
                     error="You have row or column rules on this source, so GD360 does not query it directly for you.")
            continue
        if src.mode == "live" and warehouse_exec.daily_budget_exhausted(db, ds, user.id):
            set_step(st["id"], status="failed", error="Your daily warehouse scan budget is used up; it resets at midnight UTC.")
            continue
        frames, rows_read, note = None, None, None
        if src.mode != "live":
            try:
                frames, rows_read, note = _load_inputs(db, ds, src, st["sql"], user)
            except Exception as e:  # noqa: BLE001
                set_step(st["id"], status="failed", error=str(e)[:400])
                continue
        set_step(st["id"], status="running", rows_read=rows_read, note=note, freshness=src.freshness)
        jobs.append((st, _detached(ds), src, frames))

    if jobs:
        with ThreadPoolExecutor(max_workers=max(1, settings.PROJECT_STEP_MAX_PARALLEL)) as pool:
            futures = {pool.submit(_run_one, st, ds, src, frames): (st, ds, src) for st, ds, src, frames in jobs}
            for fut in as_completed(futures):
                st, ds, src = futures[fut]
                try:
                    res = fut.result()
                except Exception as e:  # noqa: BLE001
                    res = {"ok": False, "sql": st["sql"], "error": str(e)[:400], "status": "error", "raw_error": str(e)}
                if src.mode == "live":
                    try:
                        log_pushdown(db, user.id, ds.id, ds.kind, res.get("sql") or st["sql"], res.get("bytes_scanned"),
                                     "ok" if res["ok"] else res.get("status", "error"),
                                     None if res["ok"] else res.get("raw_error"))
                    except Exception:  # noqa: BLE001
                        db.rollback()
                if res["ok"]:
                    df = res["df"]
                    tables[st["id"]] = df
                    payload = table_payload(df, limit=PREVIEW_ROWS)
                    set_step(st["id"], status="done", sql=res["sql"], rows_returned=int(len(df)),
                             bytes_scanned=res.get("bytes_scanned"), duration_ms=res.get("duration_ms"),
                             repaired=res.get("repaired", False), truncated=res.get("truncated", False),
                             columns=payload["columns"], preview=payload["rows"])
                    evidence.append({"id": st["id"], "title": st["title"], "source": src.name,
                                     **table_payload(df, limit=200)})
                else:
                    set_step(st["id"], status="failed", sql=res.get("sql"), error=res.get("error"),
                             duration_ms=res.get("duration_ms"), repaired=res.get("repaired", False))
                if should_stop():
                    for f in futures:
                        f.cancel()
                    break
    if should_stop():
        return tables, evidence

    for cb in plan.get("combine") or []:
        set_step(cb["id"], status="running")
        started = time.perf_counter()
        sql = cb["sql"]
        repaired = False
        df, err = None, None
        for attempt in range(2):
            try:
                df = _run_duckdb(sql, dict(tables))
                break
            except Exception as e:  # noqa: BLE001
                err = str(e).split("\n")[0][:400]
                missing = [t for t in _referenced_tables(sql, "duckdb") if t not in tables]
                if missing:
                    break
                if attempt == 0:
                    fixed = planner.repair_combine_sql(
                        cb | {"sql": sql}, {k: [str(c) for c in v.columns] for k, v in tables.items()}, err)
                    if fixed and fixed != sql:
                        sql, repaired = fixed, True
                        continue
        if df is not None:
            tables[cb["id"]] = df
            payload = table_payload(df, limit=PREVIEW_ROWS)
            set_step(cb["id"], status="done", sql=sql, rows_returned=int(len(df)), repaired=repaired,
                     duration_ms=int((time.perf_counter() - started) * 1000), columns=payload["columns"], preview=payload["rows"])
            evidence.append({"id": cb["id"], "title": cb["title"], "source": "Combined", **table_payload(df, limit=200)})
        else:
            missing = [t for t in _referenced_tables(cb["sql"], "duckdb") if t not in tables]
            reason = f"It needs {', '.join(missing)}, which did not run." if missing else err
            set_step(cb["id"], status="failed", sql=sql, error=reason, repaired=repaired)
    return tables, evidence


def analyse(plan: dict, tables: dict, steps: list[dict], question: str = "") -> tuple[dict, list[str]]:
    """The planned analysis, or - when it cannot be computed - the last
    result shown as it is, with the reason as a warning. Then (round 14)
    the presentation: a chart for every other part of the question, and a
    note wherever the data covers the calendar unevenly."""
    from . import present
    spec = dict(plan.get("analysis") or {})
    if question and spec.get("type") in ("breakdown", "comparison") and not spec.get("rank"):
        spec["rank"] = present.question_rank(question)
    warnings: list[str] = []
    try:
        # round 36: a rate's unit comes from its values, not the plan's guess (24.3%, never "0.2%")
        from .analysis import reconcile_format
        fixed = reconcile_format(spec, tables, {s.get("id"): s.get("sql") or "" for s in steps or []})
        if fixed and fixed != spec.get("format"):
            spec["format"] = fixed
    except Exception as e:  # noqa: BLE001 - never fails an answer
        print(f"[project_engine] format reconcile skipped: {e}")
    try:
        analysis = run_analysis(spec, tables)
    except (AnalysisError, KeyError, ValueError, TypeError) as e:
        # round 38c: in words, and the fallback shows a table that HAS rows - never a bare header
        empty = "empty" in str(e).lower()
        warnings.append("One part of this came back with no rows, so it is left out; showing what the data does have."
                        if empty else "The full analysis couldn't be computed from these results; showing them as they are.")
        order = [x.get("id") for x in reversed((plan.get("combine") or []) + (plan.get("steps") or []))]
        filled = [t for t in order if t in tables and len(tables[t])] or [t for t in tables if len(tables[t])]
        fallback_table = filled[0] if filled else next(iter(tables))
        analysis = run_analysis({"type": "lookup", "table": fallback_table}, tables)
    # 2026-10-12 (round 32): a question about the future gets a forecast - from the history the plan
    # fetched, for exactly the period asked - never the history alone (project_engine/forecasting.py)
    try:
        from . import forecasting
        forecasting.attach(analysis, plan, tables, question)
    except Exception as e:  # noqa: BLE001 - the forecast never fails an answer
        print(f"[project_engine] forecast skipped: {e}")
        analysis.setdefault("warnings", []).append("The forecast could not be computed this time; showing the history.")
    # 2026-10-12 (round 33): "why / what drives" is answered from what the plan fetched - the change split
    # into the number of orders vs the value of each (project_engine/drivers.py)
    if analysis.get("type") != "explain_change":
        try:
            from . import drivers
            drivers.attach(analysis, plan, tables, question)
        except Exception as e:  # noqa: BLE001 - never fails an answer
            print(f"[project_engine] drivers skipped: {e}")
    warnings += analysis.get("warnings") or []
    currency = spec.get("currency") if spec.get("format") == "currency" else (spec.get("currency") or "USD")
    try:
        used = {t for v in analysis.get("visuals") or [] for t in (v.get("tables") or [])}
        used |= {spec.get("table")} | {(spec.get("total") or {}).get("table")}
        used |= {d.get("table") for d in spec.get("drivers") or []} | {c.get("table") for c in spec.get("components") or []}
        used |= {(spec.get("series") or {}).get("table")}
        focus_dim = spec.get("dimension_column")
        extra = present.supporting_visuals(plan, tables, {u for u in used if u}, currency, focus_dim,
                                           limit=4 if spec.get("type") != "explain_change" else 2)
        analysis["visuals"] = (analysis.get("visuals") or []) + extra
        cov = present.coverage(tables)
        analysis["coverage"] = cov
        warnings += [n for n in cov.get("notes") or [] if n not in warnings]
    except Exception as e:  # noqa: BLE001 - presentation never fails an answer
        print(f"[project_engine] presentation step skipped: {e}")
    label_sources(analysis, plan, steps or [])
    failed_steps = [s for s in steps or [] if s.get("status") == "failed"]
    if failed_steps:
        warnings.append(
            f"{len(failed_steps)} step{'s' if len(failed_steps) > 1 else ''} could not run, so the answer leaves "
            + ("it" if len(failed_steps) == 1 else "them") + " out: " + "; ".join(s["title"] for s in failed_steps[:3]) + "."
        )
    return analysis, warnings


_LEAD = re.compile(r"^(Effect of .+ on .+|.+: change|Change in .+)$")


def _table_sources(plan: dict, steps: list[dict]) -> dict[str, list[str]]:
    """Step or combine id -> the source names behind it (a combine step is
    every step its SQL reads)."""
    out: dict[str, list[str]] = {}
    for s in steps:
        if s.get("kind") != "combine" and s.get("source_name"):
            out[s["id"]] = [s["source_name"]]
    for c in plan.get("combine") or []:
        sql = c.get("sql") or ""
        names: list[str] = []
        for sid, srcs in list(out.items()):
            if re.search(rf"\b{re.escape(sid)}\b", sql):
                names += [n for n in srcs if n not in names]
        out[c.get("id")] = names
    return out


def label_sources(analysis: dict, plan: dict, steps: list[dict]) -> None:
    """Every fact and chart names the source(s) its numbers came from."""
    by_table = _table_sources(plan, steps)

    def names(tables) -> list[str]:
        out: list[str] = []
        for t in tables or []:
            for n in by_table.get(t or "", []):
                if n not in out:
                    out.append(n)
        return out

    for f in analysis.get("facts") or []:
        f["sources"] = names([f.get("table")])
    for v in analysis.get("visuals") or []:
        v["sources"] = names(v.get("tables"))


def enrich_causes(answer: dict, analysis: dict, plan: dict, steps: list[dict], idx: list | None = None,
                  currency: str | None = None) -> None:
    """Each cause gets the number it moved (its lead fact), what share of
    the whole change that is, and the sources that number came from - all
    read off computed facts, never written by the model.

    Round 14: the big number on a cause card is one the cause itself talks
    about. A fact the writer cited but whose number is not in the cause
    (the total revenue on a "peak pricing" cause) is not used; when the
    cause names a number from the result tables instead, that number is
    shown, written the way its column means it."""
    from . import present
    from .numbers import extract_numbers
    facts = {f["id"]: f for f in analysis.get("facts") or []}
    by_table = _table_sources(plan, steps)

    def written(f: dict, nums: list[float]) -> bool:
        v = f.get("value")
        if v is None:
            return False
        for n in nums:
            if abs(abs(n) - abs(v)) <= max(0.051, abs(v) * 0.006):
                return True
            for scale in (1e3, 1e6, 1e9):
                if abs(v) >= scale and abs(abs(n) - abs(v)) <= scale * 0.0051:
                    return True
        return False

    for cause in answer.get("causes") or []:
        text = f"{cause.get('title') or ''} {cause.get('detail') or ''}"
        nums = [v for _t, v, pct in extract_numbers(text) if not pct and not (1900 <= abs(v) <= 2100 and float(v).is_integer())]
        ids = [i for i in cause.get("fact_ids") or [] if i in facts]

        def rank(f: dict) -> int:
            lab = f["label"]
            return 0 if lab.startswith("Effect of ") else 1 if lab.endswith(": change") else 2 if lab.startswith("Change in ") else 9
        leads = sorted((facts[i] for i in ids if facts[i]["kind"] != "percent" and _LEAD.match(facts[i]["label"])), key=rank)
        lead = leads[0] if leads else None
        if lead is None:
            lead = next((facts[i] for i in ids if facts[i]["kind"] != "percent" and written(facts[i], nums)), None)
        if lead is None and nums:
            lead = next((f for f in facts.values() if f["kind"] != "percent" and written(f, nums[:1])), None)
        share = None
        if lead is not None:
            base = lead["label"][: -len(": change")] if lead["label"].endswith(": change") else lead["label"]
            want = f"{base}: share of the change"
            share = next((f for f in facts.values() if f["label"] == want), None)
        amount, amount_value = (lead["display"], lead["value"]) if lead else (None, None)
        if lead is None and nums and idx:
            for n in nums:
                hit = present.match_index(n, idx)
                # money, or a count big enough to headline; a bare 4.14 says nothing on its own
                if hit and (hit[1] == "currency" or (hit[1] == "integer" and abs(hit[0]) >= 100)):
                    amount, amount_value = present.nice(hit[0], hit[1], currency), hit[0]
                    break
        srcs: list[str] = []
        for i in ids:
            for n in facts[i].get("sources") or by_table.get(facts[i].get("table") or "", []):
                if n not in srcs:
                    srcs.append(n)
        if not srcs and amount and not lead:
            srcs = sorted({n for v in by_table.values() for n in v})[:2]
        cause["amount"] = amount
        cause["amount_value"] = amount_value
        cause["share"] = share["display"] if share else None
        cause["sources"] = srcs


def _execute(db: Session, run: models.ProjectRun) -> None:
    run.status = "running"
    run.started_at = datetime.utcnow()
    db.commit()
    plan = run.plan or {}
    user = db.get(models.User, run.owner_id)
    conv = db.get(models.Conversation, run.conversation_id)
    catalog: Catalog = build_catalog(db, user, list(conv.source_ids or []))

    def set_step(step_id, **fields):
        _set_step(run, step_id, **fields)
        db.commit()

    tables, evidence = run_plan(db, plan, user, catalog, set_step, lambda: _stopped(db, run))
    if _stopped(db, run):
        _finish_stopped(db, run)
        return
    if not tables:
        run.status = "failed"
        failed = [s for s in run.steps or [] if s.get("status") == "failed"]
        run.error_message = (
            "None of the queries could run. " + (failed[0].get("error") or "") if failed else "Nothing could run."
        )[:600]
        run.finished_at = datetime.utcnow()
        db.commit()
        return

    # round 38c: every query ran and came back empty - never an empty table and an engine error; say what
    # the data has, why the rest is missing (the app's own sync report), and what CAN be asked instead
    if all(df is None or len(df) == 0 for df in tables.values()) and empty_for_lack_of_data(plan, catalog):
        _no_data_answer(db, run, plan, catalog)
        return

    analysis, warnings = analyse(plan, tables, run.steps, run.question)
    rk = (analysis.get("summary") or {}).get("rank")
    if rk and isinstance(plan.get("analysis"), dict) and not plan["analysis"].get("rank"):
        plan = {**plan, "analysis": {**plan["analysis"], "rank": rk}}
        run.plan = plan
        flag_modified(run, "plan")
    if _stopped(db, run):
        _finish_stopped(db, run)
        return
    answer = _safe_compose(run.question, plan, analysis, evidence)
    from . import present
    spec = plan.get("analysis") or {}
    currency = spec.get("currency") or "USD"
    idx = present.number_index(analysis.get("facts") or [], [*evidence, *[v for v in analysis.get("visuals") or [] if v.get("rows")]], currency)
    answer = present.polish_answer(answer, idx, currency) | {"written_by": answer.get("written_by")}
    enrich_causes(answer, analysis, plan, run.steps or [], idx, currency)
    answer["next_questions"] = askable_next(answer.get("next_questions") or [], plan, catalog)

    run.result = {
        "answer": answer,
        "analysis_type": analysis.get("type"),
        "facts": analysis.get("facts"),
        "summary": analysis.get("summary"),
        "visuals": analysis.get("visuals"),
        "kpis": _kpis_for(analysis),
        "warnings": warnings,
        "evidence": [{k: v for k, v in e.items()} for e in evidence],
        "sources_used": sorted({s.get("source_name") for s in run.steps or [] if s.get("status") == "done" and s.get("kind") == "step"}),
        "queries": sum(1 for s in run.steps or [] if s.get("status") in ("done", "failed")),
    }
    run.status = "done"
    run.finished_at = datetime.utcnow()
    _assistant_message(db, run, answer)
    db.commit()


def _safe_compose(question: str, plan: dict, analysis: dict, evidence: list[dict]) -> dict:
    """R59: the numbers are already computed - a problem in writing the words must never fail the answer.
    The writer first, then the template, then the main numbers as the headline."""
    try:
        return composer.compose(question, plan, analysis, evidence)
    except Exception as e:  # noqa: BLE001
        print(f"[project_engine] answer writer failed, using the template: {e!r}")
    try:
        return composer.fallback_answer(question, analysis)
    except Exception as e:  # noqa: BLE001
        print(f"[project_engine] template failed, using the main numbers: {e!r}")
    kpis = [f for f in analysis.get("facts") or [] if isinstance(f, dict) and f.get("display")][:3]
    headline = "; ".join(f"{k.get('label')}: {k['display']}" for k in kpis) or "Here is the result."
    return {"headline": headline, "answer": "", "causes": [], "ruled_out": [], "next_questions": [], "written_by": "template"}


def _kpis_for(analysis: dict) -> list[dict]:
    from .dashboards import _kpis
    try:
        return _kpis(analysis.get("type"), analysis.get("summary") or {}, analysis.get("facts") or [])
    except Exception:  # noqa: BLE001 - headline numbers are a convenience, never a failure
        return []


def _finish_stopped(db: Session, run: models.ProjectRun) -> None:
    run.status = "stopped"
    run.finished_at = datetime.utcnow()
    steps = [
        {**s, "status": "skipped"} if s.get("status") in ("pending", "running") else s for s in (run.steps or [])
    ]
    run.steps = steps
    flag_modified(run, "steps")
    db.commit()


def _assistant_message(db: Session, run: models.ProjectRun, answer: dict) -> None:
    text = answer.get("headline") or ""
    if answer.get("answer") and answer.get("answer") != text:
        text = f"{text}\n\n{answer['answer']}".strip()
    db.add(models.Message(conversation_id=run.conversation_id, role="assistant", content=text or "Done."))
