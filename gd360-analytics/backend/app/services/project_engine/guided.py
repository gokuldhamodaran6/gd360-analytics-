"""
Guided Analysis (2026-10-10): the Instant Answers engine, one step at a time.

A Guided Analysis is a Conversation with kind="guided" and ONE ProjectRun.
The same planner writes the plan (planner.make_plan(guided=True)); the same
step runner, combine runner, analysis and answer writer do the work. What
changes is who drives:

  - the plan is shown and the FIRST step runs straight away;
  - every later step waits for the person: they read its result, change it
    in plain English (revise_step - the step editor rewrites only that
    step's query), edit its SQL, re-run it, or approve it - approving runs
    the next step;
  - steps can be added or removed; a change to a step marks every combine
    step built on it (and the written answer) out of date;
  - "Write the answer" (finish) runs the analysis and the answer writer
    over the steps that ran - the same checked numbers as Instant Answers.

Each step's full result (at most ROW_CAP rows - steps aggregate in SQL) is
kept on the run (result["guided_tables"]) so a combine step, or the answer,
never re-queries a warehouse for a step that already ran. The page never
receives those tables (routers/projects._run_out strips them); it reads
each step's preview.

Background work runs in its own thread and session, one job per run at a
time (_busy); the page polls GET /projects/runs/{id}.
"""
from __future__ import annotations

import json
import re
import threading
import time
import traceback
from datetime import datetime

import pandas as pd
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from ... import models
from ...database import SessionLocal
from .. import ai_engine
from . import composer, planner, present
from .analysis import table_payload
from .catalog import Catalog, build_catalog  # noqa: F401 - Catalog used in type hints
from .executor import (
    PREVIEW_ROWS, _assistant_message, _kpis_for, _referenced_tables, _run_duckdb, _set_step, analyse,
    enrich_causes, run_plan,
)
from .sqlcheck import ROW_CAP, PlanSQLError, check_combine_sql, check_step_sql

EDITOR_MARKER = "GD360 STEP EDITOR"
MAX_GUIDED_STEPS = 12


class GuidedError(ValueError):
    pass


# ---- one background job per run ------------------------------------------------

_busy: set[str] = set()
_lock = threading.Lock()


def is_busy(run_id: str) -> bool:
    return run_id in _busy


def _claim(run_id: str) -> bool:
    with _lock:
        if run_id in _busy:
            return False
        _busy.add(run_id)
        return True


def _release(run_id: str) -> None:
    with _lock:
        _busy.discard(run_id)


def _fail_running(db: Session, run_id: str, message: str) -> None:
    run = db.get(models.ProjectRun, run_id)
    if not run:
        return
    run.steps = [{**s, "status": "failed", "error": message} if s.get("status") == "running" else s for s in run.steps or []]
    flag_modified(run, "steps")
    if run.status == "running":
        run.status = "planned"
    db.commit()


def start(run_id: str, fn, *args) -> None:
    """Runs fn(db, run_id, *args) in its own thread and session. Raises
    GuidedError when this analysis is already working on something."""
    if not _claim(run_id):
        raise GuidedError("GD360 is still working on this analysis. Wait for the current step to finish.")

    def target():
        db = SessionLocal()
        try:
            fn(db, run_id, *args)
        except Exception as e:  # noqa: BLE001 - a job must always leave a final status
            traceback.print_exc()
            try:
                db.rollback()
                _fail_running(db, run_id, f"Something went wrong: {str(e)[:200]}")
            except Exception:  # noqa: BLE001
                traceback.print_exc()
        finally:
            db.close()
            _release(run_id)

    threading.Thread(target=target, daemon=True, name=f"guided-{run_id[:8]}").start()


# ---- steps and their stored results ------------------------------------------

def find(run: models.ProjectRun, step_id: str) -> dict | None:
    return next((s for s in run.steps or [] if s.get("id") == step_id), None)


def _index(run: models.ProjectRun, step_id: str) -> int:
    for i, s in enumerate(run.steps or []):
        if s.get("id") == step_id:
            return i
    return -1


def _stored(run: models.ProjectRun) -> dict:
    return (run.result or {}).get("guided_tables") or {}


def _save_table(run: models.ProjectRun, step_id: str, df: pd.DataFrame) -> None:
    result = dict(run.result or {})
    tables = dict(result.get("guided_tables") or {})
    payload = table_payload(df, limit=ROW_CAP)
    tables[step_id] = {"columns": payload["columns"], "rows": payload["rows"]}
    result["guided_tables"] = tables
    run.result = result
    flag_modified(run, "result")


def _drop_table(run: models.ProjectRun, step_id: str) -> None:
    result = dict(run.result or {})
    tables = dict(result.get("guided_tables") or {})
    if step_id in tables:
        tables.pop(step_id)
        result["guided_tables"] = tables
        run.result = result
        flag_modified(run, "result")


def load_table(run: models.ProjectRun, step_id: str) -> pd.DataFrame | None:
    t = _stored(run).get(step_id)
    if not t:
        return None
    names = [c["name"] for c in t.get("columns") or []]
    df = pd.DataFrame(t.get("rows") or [], columns=names)
    for c in t.get("columns") or []:
        if c.get("dtype") == "date":
            try:
                df[c["name"]] = pd.to_datetime(df[c["name"]])
            except Exception:  # noqa: BLE001 - leave it as text
                pass
    return df


def _decorate(run: models.ProjectRun, step_id: str, df: pd.DataFrame) -> None:
    """The preview the page shows: labelled, formatted columns."""
    try:
        payload = present.annotate(table_payload(df, limit=PREVIEW_ROWS))
    except Exception:  # noqa: BLE001 - presentation never fails a step
        payload = table_payload(df, limit=PREVIEW_ROWS)
    _set_step(run, step_id, columns=payload["columns"], preview=payload["rows"])


def _reads(step: dict, step_id: str) -> bool:
    return step.get("kind") == "combine" and bool(re.search(rf"\b{re.escape(step_id)}\b", step.get("sql") or ""))


def invalidate_after(run: models.ProjectRun, step_id: str) -> None:
    """A step changed: every combine step built on it (directly or through
    another combine step) is out of date, and so is the written answer."""
    changed = {step_id}
    steps = list(run.steps or [])
    start_at = _index(run, step_id)
    for i, s in enumerate(steps):
        if i <= start_at:
            continue
        if any(_reads(s, c) for c in changed):
            changed.add(s["id"])
            if s.get("status") == "done":
                steps[i] = {**s, "status": "stale", "approved": False}
    run.steps = steps
    flag_modified(run, "steps")
    if run.status == "done":
        run.status = "planned"
        result = dict(run.result or {})
        result["answer_stale"] = True
        run.result = result
        flag_modified(run, "result")


# ---- running ---------------------------------------------------------------------

def _context(db: Session, run: models.ProjectRun) -> tuple[models.Conversation, models.User]:
    return db.get(models.Conversation, run.conversation_id), db.get(models.User, run.owner_id)


def _run_combine(db: Session, run: models.ProjectRun, step: dict, set_step) -> bool:
    sid = step["id"]
    frames: dict[str, pd.DataFrame] = {}
    missing: list[str] = []
    for ref in _referenced_tables(step["sql"], "duckdb"):
        other = find(run, ref)
        if other is None or other["id"] == sid:
            continue
        df = load_table(run, ref) if other.get("status") == "done" else None
        if df is None:
            missing.append(other.get("title") or ref)
        else:
            frames[ref] = df
    if missing:
        set_step(sid, status="failed", error=f"Run {', '.join(missing)} first - this step combines its result.")
        return False
    started = time.perf_counter()
    sql, repaired, df, err = step["sql"], False, None, None
    for attempt in range(2):
        try:
            df = _run_duckdb(sql, frames)
            break
        except Exception as e:  # noqa: BLE001
            err = str(e).split("\n")[0][:400]
            if attempt == 0:
                fixed = planner.repair_combine_sql(step | {"sql": sql}, {k: [str(c) for c in v.columns] for k, v in frames.items()}, err)
                if fixed and fixed.strip() != sql.strip():
                    sql, repaired = fixed, True
                    continue
    if df is None:
        set_step(sid, status="failed", sql=sql, error=err, repaired=repaired,
                 duration_ms=int((time.perf_counter() - started) * 1000))
        return False
    truncated = len(df) > ROW_CAP
    df = df.head(ROW_CAP)
    _save_table(run, sid, df)
    payload = table_payload(df, limit=PREVIEW_ROWS)
    set_step(sid, status="done", sql=sql, rows_returned=int(len(df)), repaired=repaired, truncated=truncated,
             duration_ms=int((time.perf_counter() - started) * 1000), columns=payload["columns"], preview=payload["rows"])
    _decorate(run, sid, df)
    return True


def run_step(db: Session, run_id: str, step_id: str) -> None:
    run = db.get(models.ProjectRun, run_id)
    if not run:
        return
    step = find(run, step_id)
    if not step:
        return
    conv, user = _context(db, run)

    def set_step(sid, **fields):
        _set_step(run, sid, **fields)
        db.commit()

    _drop_table(run, step_id)
    set_step(step_id, status="running", error=None, approved=False, columns=None, preview=None,
             rows_returned=None, duration_ms=None, repaired=False, truncated=False, reused=None)
    if step.get("kind") == "combine":
        ok = _run_combine(db, run, step, set_step)
    else:
        catalog = build_catalog(db, user, list(conv.source_ids or []))
        tables, _evidence = run_plan(db, {"steps": [step], "combine": []}, user, catalog, set_step, lambda: False)
        ok = step_id in tables
        if ok:
            _save_table(run, step_id, tables[step_id])
            _decorate(run, step_id, tables[step_id])
    invalidate_after(run, step_id)
    db.commit()


def claim_for_planning(run_id: str) -> bool:
    """2026-10-11: taken by the planning thread BEFORE the plan is stored, so
    the page never sees a stored plan with nothing working on it (it stops
    following a run that looks idle). Released by after_plan."""
    return _claim(run_id)


def after_plan(db: Session, run_id: str, run_everything: bool, claimed: bool) -> None:
    """Called on the planning thread right after a guided plan is stored.
    Takes every step an earlier question already ran (reuse_earlier), then
    either runs the first step that still has no result (step by step) or
    every step and the answer (a follow-up asked as a Quick answer). When
    every step already has a result, the answer is written."""
    if not claimed and not _claim(run_id):
        return
    try:
        run = db.get(models.ProjectRun, run_id)
        if not run or not run.steps:
            return
        try:
            reuse_earlier(db, run)
        except Exception:  # noqa: BLE001 - reuse is a shortcut; the steps can always run
            traceback.print_exc()
            db.rollback()
            run = db.get(models.ProjectRun, run_id)
        if run_everything:
            _run_all(db, run_id)
        else:
            first = next((s for s in run.steps or [] if s.get("status") != "done"), None)
            if first is None:
                finish(db, run_id)
            else:
                run_step(db, run_id, first["id"])
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()
        db.rollback()
        _fail_running(db, run_id, f"Something went wrong: {str(e)[:200]}")
    finally:
        _release(run_id)


def run_first_step(db: Session, run_id: str) -> None:
    """The first step that has no result yet (kept for callers outside the
    planning thread)."""
    after_plan(db, run_id, False, False)


def _run_all(db: Session, run_id: str) -> None:
    """2026-10-11: a follow-up asked as a Quick answer inside a Guided
    Analysis - every step runs, then the answer is written. The steps stay
    on the run, so the person can still open, change or re-run any of them."""
    run_rest(db, run_id)
    run = db.get(models.ProjectRun, run_id)
    if run:
        db.refresh(run)
        run.steps = [{**s, "approved": True} if s.get("status") == "done" else s for s in run.steps or []]
        flag_modified(run, "steps")
        db.commit()


def _norm_sql(sql: str | None) -> str:
    return re.sub(r"\s+", " ", (sql or "").strip().rstrip(";")).strip().lower()


def reuse_earlier(db: Session, run: models.ProjectRun) -> int:
    """2026-10-11 (Guided follow-ups): every step of a new question that is
    the same query on the same source as a step an earlier question in this
    thread already ran takes that stored result - no new query - and is
    marked approved, with where it came from ("reused": question and step
    number). Returns how many steps were reused."""
    earlier = (
        db.query(models.ProjectRun)
        .filter(models.ProjectRun.conversation_id == run.conversation_id, models.ProjectRun.id != run.id,
                models.ProjectRun.created_at <= run.created_at)
        .order_by(models.ProjectRun.created_at.asc()).all()
    )
    earlier = [p for p in earlier if p.status != "replaced"]
    index: dict[tuple, tuple] = {}
    for qn, p in enumerate(earlier, start=1):
        tables = _stored(p)
        for sn, st in enumerate(p.steps or [], start=1):
            if st.get("kind") == "combine" or st.get("status") != "done" or st.get("id") not in tables:
                continue
            index[(st.get("source_id"), _norm_sql(st.get("sql")))] = (qn, sn, p, st)
    if not index:
        return 0
    reused = 0
    for st in list(run.steps or []):
        if st.get("kind") == "combine" or st.get("status") == "done":
            continue
        hit = index.get((st.get("source_id"), _norm_sql(st.get("sql"))))
        if not hit:
            continue
        qn, sn, p, src = hit
        result = dict(run.result or {})
        tables = dict(result.get("guided_tables") or {})
        tables[st["id"]] = _stored(p)[src["id"]]
        result["guided_tables"] = tables
        run.result = result
        flag_modified(run, "result")
        _set_step(run, st["id"], status="done", approved=True, error=None, columns=src.get("columns"),
                  preview=src.get("preview"), rows_returned=src.get("rows_returned"), duration_ms=0,
                  truncated=bool(src.get("truncated")), repaired=False,
                  reused={"question": qn, "step": sn, "title": src.get("title"), "run_id": p.id})
        reused += 1
    if reused:
        db.commit()
    return reused


def run_rest(db: Session, run_id: str) -> None:
    """Every step that has not run yet (or is out of date), in order, then
    the answer."""
    run = db.get(models.ProjectRun, run_id)
    if not run:
        return
    for s in list(run.steps or []):
        db.refresh(run)
        cur = find(run, s["id"])
        if cur and cur.get("status") != "done":
            run_step(db, run_id, s["id"])
    finish(db, run_id)


def approve_and_next(db: Session, run_id: str, step_id: str) -> None:
    """The job behind "Approve": run the next step that has not run, or
    write the answer when every step is approved."""
    run = db.get(models.ProjectRun, run_id)
    if not run:
        return
    nxt = next_step(run, step_id)
    if nxt is not None:
        run_step(db, run_id, nxt["id"])
    elif all(s.get("approved") for s in run.steps or [] if s.get("status") == "done") and any(
        s.get("status") == "done" for s in run.steps or []
    ):
        finish(db, run_id)


def next_step(run: models.ProjectRun, after_id: str) -> dict | None:
    """The next step after `after_id` that still has to run (else the first
    one anywhere that has not run)."""
    steps = list(run.steps or [])
    i = _index(run, after_id)
    # "running": the router marks the step it is about to run before the job starts
    waiting = [s for s in steps if not s.get("approved") and s.get("status") in ("pending", "stale", "running")]
    later = [s for s in waiting if _index(run, s["id"]) > i]
    return (later or waiting or [None])[0]


def finish(db: Session, run_id: str) -> None:
    """Write the answer from every step that ran - the same analysis,
    writer and number checks as Instant Answers."""
    run = db.get(models.ProjectRun, run_id)
    if not run:
        return
    done = [s for s in run.steps or [] if s.get("status") == "done"]
    tables = {s["id"]: df for s in done if (df := load_table(run, s["id"])) is not None}
    if not tables:
        run.error_message = "Run at least one step before writing the answer."
        db.commit()
        return
    run.status = "running"
    run.error_message = None
    run.started_at = run.started_at or datetime.utcnow()
    db.commit()

    plan = dict(run.plan or {})
    plan.pop("replaced_plan", None)
    plan["steps"] = [
        {k: s.get(k) for k in ("id", "title", "purpose", "source_id", "source_name", "source_kind", "mode", "dialect", "sql")}
        for s in done if s.get("kind") != "combine"
    ]
    plan["combine"] = [{k: s.get(k) for k in ("id", "title", "purpose", "sql")} for s in done if s.get("kind") == "combine"]
    analysis, warnings = analyse(plan, tables, done, run.question)
    rk = (analysis.get("summary") or {}).get("rank")
    if rk and isinstance(plan.get("analysis"), dict) and not plan["analysis"].get("rank"):
        plan["analysis"] = {**plan["analysis"], "rank": rk}
    evidence = [
        {"id": s["id"], "title": s.get("title"), "source": s.get("source_name") or "Combined", **table_payload(tables[s["id"]], limit=200)}
        for s in done if s["id"] in tables
    ]
    answer = composer.compose(run.question, plan, analysis, evidence)
    spec = plan.get("analysis") or {}
    currency = spec.get("currency") or "USD"
    idx = present.number_index(analysis.get("facts") or [], [*evidence, *[v for v in analysis.get("visuals") or [] if v.get("rows")]], currency)
    answer = present.polish_answer(answer, idx, currency) | {"written_by": answer.get("written_by")}
    enrich_causes(answer, analysis, plan, done, idx, currency)

    db.refresh(run)
    result = dict(run.result or {})
    result.update({
        "answer": answer,
        "analysis_type": analysis.get("type"),
        "facts": analysis.get("facts"),
        "summary": analysis.get("summary"),
        "visuals": analysis.get("visuals"),
        "kpis": _kpis_for(analysis),
        "warnings": warnings,
        "evidence": evidence,
        "sources_used": sorted({s.get("source_name") for s in done if s.get("kind") != "combine" and s.get("source_name")}),
        "queries": len(done),
        "answer_stale": False,
    })
    run.result = result
    flag_modified(run, "result")
    run.plan = {**(run.plan or {}), "steps": plan["steps"], "combine": plan["combine"], "analysis": plan.get("analysis")}
    flag_modified(run, "plan")
    run.status = "done"
    run.finished_at = datetime.utcnow()
    _assistant_message(db, run, answer)
    db.commit()


# ---- the step editor -------------------------------------------------------------

EDITOR_SYSTEM = f"""You are the {EDITOR_MARKER}. A person is working through a GD360 analysis
one step at a time. You write ONE step: either a change they asked for to an existing
step, or a new step they want to add.

A step is one of:
- kind "step": ONE read-only SQL query inside ONE source, in that source's sql_dialect,
  using only the tables and columns listed for it in the catalog, spelled exactly as
  listed (quote identifiers with spaces or capitals the dialect's way).
- kind "combine": DuckDB SQL over the results of EARLIER steps only, reading them by
  step id as table names (FROM s1 JOIN s2 USING (month)). Use it to join sources or
  reshape earlier results; use only the output columns listed for those steps.

Rules:
- Aggregate in SQL (GROUP BY, SUM, COUNT, AVG); return at most a few hundred rows.
  Never select raw rows unless asked for a list (then LIMIT 200).
- Name output columns in snake_case with AS. When changing a step, keep its output
  column names unless the change needs different ones.
- Do exactly what was asked - nothing more.
- The title is plain English (at most 8 words); the purpose is one sentence saying
  what the step computes. Add up to 3 short "tweaks" a person might want next.

Answer with JSON only:
{{"kind": "step", "source_id": "<id from the catalog, for kind step>", "title": "...", "purpose": "...",
  "sql": "SELECT ...", "tweaks": ["..."]}}"""


def _earlier_text(steps: list[dict]) -> str:
    if not steps:
        return "(none - this is the first step)"
    lines = []
    for s in steps:
        cols = ", ".join(c["name"] for c in s.get("columns") or []) or "not run yet"
        where = "combine" if s.get("kind") == "combine" else f"source {s.get('source_name')}"
        lines.append(f"- {s['id']} ({where}): {s.get('title')}. Output columns: {cols}")
    return "\n".join(lines)


def _validated(raw: dict, catalog: Catalog, earlier_ids: list[str], current: dict | None) -> dict:
    if not isinstance(raw, dict):
        raise GuidedError("The step editor did not return a step.")
    kind = "combine" if str(raw.get("kind") or "").lower() == "combine" else "step"
    sql = str(raw.get("sql") or "").strip()
    if not sql:
        raise GuidedError("The step has no query.")
    if kind == "step":
        src = catalog.source(str(raw.get("source_id") or ""))
        if src is None:
            name = str(raw.get("source_id") or "").strip().lower()
            src = next((s for s in catalog.sources if s.name.lower() == name), None)
        if src is None and current and current.get("source_id"):
            src = catalog.source(current["source_id"])
        if src is None and len(catalog.sources) == 1:
            src = catalog.sources[0]
        if src is None:
            raise GuidedError(f"source_id {raw.get('source_id')!r} is not in the catalog.")
        try:
            check_step_sql(sql, src)
        except PlanSQLError as e:
            raise GuidedError(f"{src.name} ({src.dialect}): {e}") from e
        where = {"source_id": src.id, "source_name": src.name, "source_kind": src.kind, "mode": src.mode, "dialect": src.dialect}
    else:
        if not earlier_ids:
            raise GuidedError("A combine step needs earlier steps to read from.")
        try:
            check_combine_sql(sql, set(earlier_ids))
        except PlanSQLError as e:
            raise GuidedError(str(e)) from e
        where = {"source_id": None, "source_name": "Combined", "source_kind": "duckdb", "mode": "combine", "dialect": "duckdb"}
    return {
        "kind": kind, "title": str(raw.get("title") or (current or {}).get("title") or "New step")[:80].strip(),
        "purpose": str(raw.get("purpose") or "")[:240].strip(), "sql": sql, "tweaks": planner.clean_tweaks(raw.get("tweaks")),
        **where,
    }


def write_step(db: Session, run: models.ProjectRun, instruction: str, current: dict | None = None,
               position: int | None = None) -> dict:
    """One step from the step editor - a change to `current`, or a new step
    at `position` - checked like every planned step. Raises GuidedError."""
    conv, user = _context(db, run)
    catalog = build_catalog(db, user, list(conv.source_ids or []))
    if not catalog.sources:
        raise GuidedError("This analysis has no data sources you can use.")
    steps = list(run.steps or [])
    cut = _index(run, current["id"]) if current else (len(steps) if position is None else position)
    earlier = steps[:max(0, cut)]
    parts = [
        f"CATALOG\n{catalog.prompt_text()}",
        f"The analysis question: {run.question}",
        "Earlier steps (a combine step reads them by id):\n" + _earlier_text(earlier),
    ]
    if current:
        parts.append("The step to change:\n" + json.dumps({k: current.get(k) for k in ("kind", "source_id", "title", "purpose", "sql")}))
        parts.append(f"Change asked for: {instruction}")
    else:
        parts.append(f"New step to add: {instruction}")
    messages = [{"role": "system", "content": EDITOR_SYSTEM}, {"role": "user", "content": "\n\n".join(parts)}]
    last: Exception | None = None
    for attempt in range(2):
        try:
            raw = ai_engine._plan_with_retry(messages, max_tokens=3000)
        except Exception as e:  # noqa: BLE001
            raise GuidedError(ai_engine.friendly_ai_error(e)) from e
        try:
            return _validated(raw, catalog, [s["id"] for s in earlier], current)
        except GuidedError as e:
            last = e
            messages = messages + [
                {"role": "assistant", "content": json.dumps(raw)[:6000]},
                {"role": "user", "content": f"That step was rejected: {e}. Fix it and answer with the JSON only."},
            ]
    raise GuidedError(f"GD360 could not write a step that fits your sources for that. Details: {last}")


def _blank(step_id: str, fields: dict) -> dict:
    return {
        "id": step_id, **fields, "status": "pending", "rows_returned": None, "bytes_scanned": None, "rows_read": None,
        "duration_ms": None, "error": None, "repaired": False, "truncated": False, "columns": None, "preview": None,
        "approved": False,
    }


def revise_step(db: Session, run: models.ProjectRun, step_id: str, instruction: str) -> dict:
    step = find(run, step_id)
    if not step:
        raise GuidedError("That step is not in this analysis.")
    new = write_step(db, run, instruction, current=step)
    edits = list(step.get("edits") or []) + [instruction.strip()[:240]]
    replaced = {**_blank(step_id, new), "edits": edits[-6:]}
    steps = [replaced if s.get("id") == step_id else s for s in run.steps or []]
    run.steps = steps
    flag_modified(run, "steps")
    _drop_table(run, step_id)
    invalidate_after(run, step_id)
    db.commit()
    return replaced


def set_sql(db: Session, run: models.ProjectRun, step_id: str, sql: str) -> dict:
    step = find(run, step_id)
    if not step:
        raise GuidedError("That step is not in this analysis.")
    sql = sql.strip()
    if step.get("kind") == "combine":
        earlier = [s["id"] for s in (run.steps or [])[:_index(run, step_id)]]
        try:
            check_combine_sql(sql, set(earlier))
        except PlanSQLError as e:
            raise GuidedError(str(e)) from e
    else:
        conv, user = _context(db, run)
        catalog = build_catalog(db, user, list(conv.source_ids or []))
        src = catalog.source(step.get("source_id") or "")
        if src is None:
            raise GuidedError("This step's source is no longer available to you.")
        try:
            check_step_sql(sql, src)
        except PlanSQLError as e:
            raise GuidedError(str(e)) from e
    edits = list(step.get("edits") or []) + ["Edited the SQL"]
    replaced = {**_blank(step_id, {k: step.get(k) for k in (
        "kind", "title", "purpose", "source_id", "source_name", "source_kind", "mode", "dialect", "tweaks")}),
        "sql": sql, "edits": edits[-6:]}
    run.steps = [replaced if s.get("id") == step_id else s for s in run.steps or []]
    flag_modified(run, "steps")
    _drop_table(run, step_id)
    invalidate_after(run, step_id)
    db.commit()
    return replaced


def add_step(db: Session, run: models.ProjectRun, instruction: str, after_id: str | None = None) -> dict:
    steps = list(run.steps or [])
    if len(steps) >= MAX_GUIDED_STEPS:
        raise GuidedError(f"An analysis can have at most {MAX_GUIDED_STEPS} steps.")
    position = (_index(run, after_id) + 1) if after_id and _index(run, after_id) >= 0 else len(steps)
    new = write_step(db, run, instruction, position=position)
    taken = {s["id"] for s in steps}
    prefix = "c" if new["kind"] == "combine" else "s"
    n = 1
    while f"{prefix}{n}" in taken:
        n += 1
    step = {**_blank(f"{prefix}{n}", new), "edits": [instruction.strip()[:240]], "added": True}
    steps.insert(position, step)
    run.steps = steps
    flag_modified(run, "steps")
    if run.status == "done":
        invalidate_after(run, step["id"])
    db.commit()
    return step


def remove_step(db: Session, run: models.ProjectRun, step_id: str) -> None:
    step = find(run, step_id)
    if not step:
        raise GuidedError("That step is not in this analysis.")
    users = [s.get("title") or s["id"] for s in run.steps or [] if s.get("id") != step_id and _reads(s, step_id)]
    if users:
        raise GuidedError(f"{', '.join(users)} combine{'s' if len(users) == 1 else ''} this step's result - change or remove "
                          f"{'it' if len(users) == 1 else 'them'} first.")
    if len(run.steps or []) <= 1:
        raise GuidedError("An analysis needs at least one step.")
    invalidate_after(run, step_id)
    run.steps = [s for s in run.steps or [] if s.get("id") != step_id]
    flag_modified(run, "steps")
    _drop_table(run, step_id)
    db.commit()


def mark_running(db: Session, run: models.ProjectRun, step_id: str | None) -> None:
    """Shown at once, before the background job picks the step up."""
    if step_id and find(run, step_id):
        _set_step(run, step_id, status="running", error=None)
        db.commit()


def mark_status(db: Session, run: models.ProjectRun, step_id: str, status: str) -> None:
    _set_step(run, step_id, status=status)
    db.commit()


def approve(db: Session, run: models.ProjectRun, step_id: str) -> dict:
    step = find(run, step_id)
    if not step:
        raise GuidedError("That step is not in this analysis.")
    if step.get("status") != "done":
        raise GuidedError("Run this step before approving it.")
    _set_step(run, step_id, approved=True)
    db.commit()
    return find(run, step_id)
