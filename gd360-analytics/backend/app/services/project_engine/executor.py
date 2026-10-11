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
                run.error_message = f"Something went wrong while answering: {str(e)[:300]}"
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
    guided = bool(conv and conv.kind == "guided")
    previous = None
    if run.note:
        # a re-plan: the plan this run replaces is kept on the run itself
        previous = (run.plan or {}).get("replaced_plan") or run.plan
    try:
        plan = planner.make_plan(run.question, catalog, _history(db, run), note=run.note, previous=previous, guided=guided)
    except planner.PlanningError as e:
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
    run.plan = plan
    run.steps = initial_steps(plan)
    if not plan.get("can_answer", True):
        run.status = "needs_input"
        run.result = {"answer": {
            "headline": "These sources can't answer that yet.",
            "answer": plan.get("missing") or "The data needed for this question is not in the project's sources.",
            "causes": [], "ruled_out": [], "next_questions": [],
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
        analysis = run_analysis(spec, tables)
    except (AnalysisError, KeyError, ValueError, TypeError) as e:
        warnings.append(f"The planned analysis could not be completed ({e}); showing the results as they are.")
        last = (plan.get("combine") or plan.get("steps") or [{}])[-1].get("id")
        fallback_table = last if last in tables else next(iter(tables))
        analysis = run_analysis({"type": "lookup", "table": fallback_table}, tables)
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

    analysis, warnings = analyse(plan, tables, run.steps, run.question)
    rk = (analysis.get("summary") or {}).get("rank")
    if rk and isinstance(plan.get("analysis"), dict) and not plan["analysis"].get("rank"):
        plan = {**plan, "analysis": {**plan["analysis"], "rank": rk}}
        run.plan = plan
        flag_modified(run, "plan")
    if _stopped(db, run):
        _finish_stopped(db, run)
        return
    answer = composer.compose(run.question, plan, analysis, evidence)
    from . import present
    spec = plan.get("analysis") or {}
    currency = spec.get("currency") or "USD"
    idx = present.number_index(analysis.get("facts") or [], [*evidence, *[v for v in analysis.get("visuals") or [] if v.get("rows")]], currency)
    answer = present.polish_answer(answer, idx, currency) | {"written_by": answer.get("written_by")}
    enrich_causes(answer, analysis, plan, run.steps or [], idx, currency)

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
