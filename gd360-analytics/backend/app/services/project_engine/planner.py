"""
The planner: question + catalog -> a typed, checked plan.

The language model writes the plan as JSON; nothing it writes runs until
validate_plan has checked it - every step names a source that is really in
the project, every query is one read-only SELECT over that source's real
tables in that source's dialect, every combine step reads only earlier
steps. One retry is given with the list of problems; whatever still fails
is reported in plan["issues"] and the step is dropped.

repair_sql is the bounded second chance for a single step whose query the
engine itself rejected (an unknown column, a type mismatch): the model sees
its query, the engine's own error and that source's tables, once.
"""
from __future__ import annotations

import json
import re
from datetime import date

from .. import ai_engine
from .catalog import Catalog, CatalogSource
from .sqlcheck import PlanSQLError, check_combine_sql, check_step_sql

MAX_STEPS = 8
MAX_COMBINE = 4
PLANNER_MARKER = "GD360 PROJECT PLANNER"
REPAIR_MARKER = "GD360 SQL REPAIR"

ANALYSIS_TYPES = ("explain_change", "trend", "breakdown", "comparison", "lookup", "list")


class PlanningError(RuntimeError):
    pass


PLANNER_SYSTEM = f"""You are the {PLANNER_MARKER}. You turn a business question into a plan
that GD360 runs against the person's own data sources.

How GD360 runs your plan:
- Each STEP runs ONE read-only SQL query inside ONE source, written in that source's
  sql_dialect (bigquery, snowflake, postgres, mysql, tsql or duckdb). Use only the
  tables and columns listed for that source in the catalog, spelled exactly as listed.
  Quote identifiers that contain spaces or capitals in the dialect's own way.
- Return SMALL results: aggregate in SQL (GROUP BY, SUM, COUNT, AVG). A step should
  return at most a few hundred rows. Never select raw rows unless the person asked
  for a list (then add LIMIT 200).
- Name output columns in snake_case with AS.
- A COMBINE step joins or reshapes the results of earlier steps with DuckDB SQL,
  reading them by step id as table names (e.g. FROM s1 JOIN s2 USING (day)).
  Sources are joined ONLY in combine steps, never inside a step.
- Then GD360's analysis engine computes the statistics from the tables named in
  "analysis". You do not compute or guess any number yourself.

Comparisons between two periods (explain_change):
- Every table used by the analysis must have a column named period whose values
  are exactly 'current' and 'previous'; one row per period (or per period and
  segment for drivers).
- Compare windows of the same length (this month so far vs the same days of last
  month; this week vs last week). Add period_start and period_end columns to the
  total table so the windows can be labelled.
- If the data may not reach today, anchor the windows on the latest date in the
  data (e.g. a subquery with MAX(date)) and say so in "assumptions".
- "components" are parts that MULTIPLY to the metric (visitors x share who buy x
  average order = revenue) or ADD to it (new + returning = revenue); set
  components_mode to "multiply" or "add". Use components only when they really
  rebuild the metric from the same data; otherwise leave them out.
- "drivers" are dimensions to rank by how much of the change each segment explains
  (channel, campaign, product, country, device...). Use the sources that can show
  them, and include ad spend or budget tables as "context" when they may explain
  traffic changes.

Today's date is {{today}}.

Answer with JSON only, in exactly this shape:
{{
  "title": "short title for the project (max 60 characters)",
  "can_answer": true,
  "missing": "",
  "understanding": {{"metric": "...", "window": "...", "method": "...", "scope": "..."}},
  "assumptions": ["each assumption you made, one sentence each"],
  "steps": [
    {{"id": "s1", "title": "Measure the drop", "purpose": "one sentence", "source_id": "<id from the catalog>", "sql": "SELECT ..."}}
  ],
  "combine": [
    {{"id": "c1", "title": "...", "purpose": "...", "sql": "SELECT ... FROM s1 JOIN s2 ..."}}
  ],
  "analysis": {{
    "type": "explain_change | trend | breakdown | lookup | list",
    "metric_name": "Revenue",
    "format": "currency | number | integer | percent | ratio",
    "currency": "USD",
    "total": {{"table": "s1", "period_column": "period", "value_column": "revenue"}},
    "components_mode": "multiply",
    "components": [{{"name": "Visitors", "table": "c1", "period_column": "period", "value_column": "sessions", "format": "number"}}],
    "drivers": [{{"label": "Channel", "table": "s3", "dimension_column": "channel", "period_column": "period", "value_column": "revenue"}}],
    "series": {{"table": "s2", "title": "Revenue per day"}},
    "context": ["s4"],
    "table": "s1", "time_column": "month", "value_columns": ["revenue"],
    "dimension_column": "channel", "value_column": "revenue",
    "chart_type": "line | bar | horizontal_bar | area | table"
  }}
}}
Fields of "analysis" by type:
- explain_change: metric_name, format, currency, total, optional components_mode,
  components, drivers, series, context.
- trend: table, time_column, value_columns, metric_name, format, chart_type.
- breakdown: table, dimension_column, value_column, metric_name, format, chart_type.
- lookup / list: table, chart_type.
If the sources cannot answer the question, set can_answer to false, explain in
"missing" what data would be needed, and return empty steps.
At most {MAX_STEPS} steps and {MAX_COMBINE} combine steps."""


REPAIR_SYSTEM = f"""You are the {REPAIR_MARKER} step. A query in a GD360 plan was rejected.
Rewrite it so it runs, keeping its purpose and its output column names.
Use only the tables and columns listed, in the given SQL dialect.
Return JSON only: {{"sql": "SELECT ..."}}"""


def _history_text(history: list[dict]) -> str:
    if not history:
        return ""
    lines = ["Earlier questions in this project (for follow-ups):"]
    for h in history[-4:]:
        lines.append(f"- Q: {h.get('question')}")
        if h.get("headline"):
            lines.append(f"  A: {h.get('headline')}")
    return "\n".join(lines)


def _ask_model(question: str, catalog: Catalog, history: list[dict], note: str | None,
               previous: dict | None, problems: list[str] | None) -> dict:
    user = [f"CATALOG\n{catalog.prompt_text()}", _history_text(history)]
    if previous and note:
        user.append("Your previous plan:\n" + json.dumps(_plan_for_prompt(previous))[:6000])
        user.append(f"The person changed it: {note}")
    if previous and problems:
        user.append("Your previous plan:\n" + json.dumps(_plan_for_prompt(previous))[:6000])
        user.append("These problems must be fixed:\n- " + "\n- ".join(problems))
    user.append(f"Question: {question}")
    messages = [
        {"role": "system", "content": PLANNER_SYSTEM.replace("{today}", date.today().isoformat())},
        {"role": "user", "content": "\n\n".join(u for u in user if u)},
    ]
    return ai_engine._plan_with_retry(messages, max_tokens=6000)


def _plan_for_prompt(plan: dict) -> dict:
    return {k: plan.get(k) for k in ("title", "understanding", "assumptions", "steps", "combine", "analysis")}


_ID_RE = re.compile(r"^[a-z][a-z0-9_]{0,15}$")


def validate_plan(raw: dict, catalog: Catalog) -> tuple[dict, list[str]]:
    """(clean plan, problems). Never raises for a content problem."""
    problems: list[str] = []
    if not isinstance(raw, dict):
        return {}, ["The plan was not a JSON object."]
    plan = {
        "title": str(raw.get("title") or "")[:80].strip(),
        "can_answer": raw.get("can_answer", True) is not False,
        "missing": str(raw.get("missing") or "").strip(),
        "understanding": raw.get("understanding") if isinstance(raw.get("understanding"), dict) else {},
        "assumptions": [str(a).strip() for a in (raw.get("assumptions") or []) if str(a).strip()][:8],
        "steps": [],
        "combine": [],
        "analysis": raw.get("analysis") if isinstance(raw.get("analysis"), dict) else {},
    }
    if not plan["can_answer"]:
        return plan, []

    ids: set[str] = set()
    for i, st in enumerate((raw.get("steps") or [])[:MAX_STEPS]):
        if not isinstance(st, dict):
            continue
        sid = str(st.get("id") or f"s{i + 1}").strip().lower()
        if not _ID_RE.match(sid) or sid in ids:
            sid = f"s{i + 1}"
        src: CatalogSource | None = catalog.source(str(st.get("source_id") or ""))
        if src is None:
            # tolerate the model writing the source NAME instead of its id
            name = str(st.get("source_id") or st.get("source") or "").strip().lower()
            src = next((s for s in catalog.sources if s.name.lower() == name), None)
        if src is None:
            problems.append(f"Step {sid}: source_id {st.get('source_id')!r} is not in the catalog.")
            continue
        sql = str(st.get("sql") or "").strip()
        try:
            check_step_sql(sql, src)
        except PlanSQLError as e:
            problems.append(f"Step {sid} ({src.name}, {src.dialect}): {e}")
            continue
        ids.add(sid)
        plan["steps"].append({
            "id": sid, "title": str(st.get("title") or f"Step {i + 1}")[:80], "purpose": str(st.get("purpose") or "")[:240],
            "source_id": src.id, "source_name": src.name, "source_kind": src.kind, "mode": src.mode,
            "dialect": src.dialect, "sql": sql,
        })
    for i, cb in enumerate((raw.get("combine") or [])[:MAX_COMBINE]):
        if not isinstance(cb, dict):
            continue
        cid = str(cb.get("id") or f"c{i + 1}").strip().lower()
        if not _ID_RE.match(cid) or cid in ids:
            cid = f"c{i + 1}"
        sql = str(cb.get("sql") or "").strip()
        try:
            check_combine_sql(sql, ids)
        except PlanSQLError as e:
            problems.append(f"Combine {cid}: {e}")
            continue
        ids.add(cid)
        plan["combine"].append({"id": cid, "title": str(cb.get("title") or f"Combine {i + 1}")[:80],
                                "purpose": str(cb.get("purpose") or "")[:240], "sql": sql})
    if not plan["steps"]:
        problems.append("The plan has no step that can run.")

    a = plan["analysis"]
    atype = a.get("type") if a.get("type") in ANALYSIS_TYPES else None
    if not atype:
        a["type"] = "lookup"
        atype = "lookup"
    referenced = []
    if atype == "explain_change":
        referenced.append((a.get("total") or {}).get("table"))
        referenced += [c.get("table") for c in a.get("components") or [] if isinstance(c, dict)]
        referenced += [d.get("table") for d in a.get("drivers") or [] if isinstance(d, dict)]
        if (a.get("series") or {}).get("table"):
            referenced.append(a["series"]["table"])
        if not (a.get("total") or {}).get("table"):
            problems.append("analysis.total.table is required for explain_change.")
    else:
        if not a.get("table"):
            last = (plan["combine"] or plan["steps"] or [{}])[-1].get("id")
            a["table"] = last
        referenced.append(a.get("table"))
    for t in referenced:
        if t and t not in ids:
            problems.append(f"analysis refers to {t!r}, which is not a step or combine id ({', '.join(sorted(ids))}).")
    a["context"] = [c for c in (a.get("context") or []) if c in ids]
    return plan, problems


def make_plan(question: str, catalog: Catalog, history: list[dict] | None = None,
              note: str | None = None, previous: dict | None = None) -> dict:
    """A validated plan. Raises PlanningError when no usable plan came back."""
    if not catalog.sources:
        raise PlanningError("This project has no data sources you can use.")
    history = history or []
    try:
        raw = _ask_model(question, catalog, history, note, previous, None)
    except Exception as e:  # noqa: BLE001
        raise PlanningError(ai_engine.friendly_ai_error(e)) from e
    plan, problems = validate_plan(raw, catalog)
    if problems and plan.get("can_answer", True):
        try:
            raw2 = _ask_model(question, catalog, history, None, raw, problems)
            plan2, problems2 = validate_plan(raw2, catalog)
            if len(problems2) <= len(problems) and plan2.get("steps"):
                plan, problems = plan2, problems2
        except Exception as e:  # noqa: BLE001
            print(f"[project_engine] plan retry failed (keeping first plan): {e}")
    plan["issues"] = problems
    if plan.get("can_answer", True) and not plan.get("steps"):
        raise PlanningError(
            "GD360 could not build a query that fits your sources for this question. "
            + ("Details: " + "; ".join(problems[:3]) if problems else "")
        )
    if not plan.get("title"):
        plan["title"] = question[:60]
    return plan


def repair_sql(step: dict, source: CatalogSource, error: str) -> str | None:
    """One corrected query for a step the engine rejected, or None."""
    tables = "\n".join(
        f"TABLE {t.name}: " + ", ".join(f"{c['name']} ({c['type'] or '?'})" for c in t.columns) for t in source.tables
    )
    messages = [
        {"role": "system", "content": REPAIR_SYSTEM},
        {"role": "user", "content": (
            f"Source: {source.name} (sql_dialect={source.dialect})\n{tables}\n\n"
            f"Step purpose: {step.get('purpose') or step.get('title')}\n"
            f"Query:\n{step.get('sql')}\n\nError from the engine:\n{error}"
        )},
    ]
    try:
        out = ai_engine._plan_with_retry(messages, max_tokens=3000)
    except Exception as e:  # noqa: BLE001
        print(f"[project_engine] repair failed: {e}")
        return None
    sql = str((out or {}).get("sql") or "").strip()
    if not sql:
        return None
    try:
        check_step_sql(sql, source)
    except PlanSQLError as e:
        print(f"[project_engine] repaired query still invalid: {e}")
        return None
    return sql


def repair_combine_sql(step: dict, available: dict[str, list[str]], error: str) -> str | None:
    """The same second chance for a combine step (DuckDB over step outputs)."""
    tables = "\n".join(f"TABLE {k}: {', '.join(v)}" for k, v in available.items())
    messages = [
        {"role": "system", "content": REPAIR_SYSTEM},
        {"role": "user", "content": (
            f"Source: earlier step results (sql_dialect=duckdb)\n{tables}\n\n"
            f"Step purpose: {step.get('purpose') or step.get('title')}\n"
            f"Query:\n{step.get('sql')}\n\nError from the engine:\n{error}"
        )},
    ]
    try:
        out = ai_engine._plan_with_retry(messages, max_tokens=3000)
    except Exception as e:  # noqa: BLE001
        print(f"[project_engine] combine repair failed: {e}")
        return None
    sql = str((out or {}).get("sql") or "").strip()
    try:
        check_combine_sql(sql, set(available))
    except PlanSQLError:
        return None
    return sql
