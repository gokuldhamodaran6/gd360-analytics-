"""
R64 (2026-11-06), deep analysis: the Analyst talks to the database first.

Before R64 the Analyst copied the first 50,000 rows of every live warehouse
table into Python and worked from that copy - slow to load, and wrong for any
total over a bigger table. Now a live table is described to the model (its
columns, row count and what is in it) but not loaded. The model writes the SQL
it needs as named steps, Euliv runs them in the database (every guard the
planned steps have: read-only check, the person's access rules, scan budgets,
cost caps, one automatic repair), and the Python step gets each result as a
DataFrame under the step's name:

    step 1  SQL in the warehouse   - filter, join, aggregate over ALL rows
    step 2  Python in the sandbox  - pandas, scipy, scikit-learn, statsmodels
    step 3  checks                 - stated totals reproduced, held-out score

A reply carries its SQL blocks and its Python block together, so the common
case is ONE model call; a failed query goes back to the model with the
database's own error, like a failed run.
"""
from __future__ import annotations

import re
import time

import pandas as pd
from sqlalchemy.orm import Session

from ... import models
from .analysis import table_payload
from .catalog import Catalog, CatalogSource
from .sqlcheck import PlanSQLError, check_step_sql

SQL_ROW_CAP = 100_000     # rows one SQL step may hand to Python
MAX_SQL_STEPS = 6
PREVIEW_ROWS = 8

_SQL_BLOCK = re.compile(r"```sql[ \t]*\r?\n(.*?)```", re.S | re.I)
_HEADER = re.compile(r"^\s*--\s*(name|source)\s*:\s*(.+?)\s*$", re.I)


def deferred_ok(src: CatalogSource) -> bool:
    """A live source the Analyst queries instead of loading. A source the person has row/column rules on is still
    loaded and filtered in Python (the planned steps never query those either)."""
    return src.mode == "live" and not src.restricted


def describe_live(src: CatalogSource, names: dict[str, str]) -> str:
    """The model's view of one live source: dialect, id, and each table as SQL names it. `names` maps a table's
    SQL name to the Python name it would get if loaded (only used for the lazy fallback)."""
    lines = [f'LIVE SOURCE "{src.name}" ({src.label}, SQL dialect: {src.dialect}) - source id: {src.id}'
             + (f" - {src.freshness}" if src.freshness else "")]
    for t in src.tables[:40]:
        cols = ", ".join(f"{c.get('name')} {str(c.get('type') or '').lower()}".strip() for c in (t.columns or [])[:80])
        rows = f"{t.rows:,} rows" if isinstance(t.rows, int) and t.rows >= 0 else "row count unknown"
        lines.append(f"  TABLE {t.name}  ({rows})")
        lines.append(f"    columns: {cols}")
        if t.facts:
            lines.append(f"    what is in it: {t.facts[:300]}")
    if src.note:
        lines.append(f"  note: {src.note[:200]}")
    return "\n".join(lines)


LIVE_RULES = f"""HOW TO USE THE LIVE SOURCES ABOVE: their tables are NOT loaded into Python. Get what you need with SQL
first - Euliv runs your SQL in the database, then your Python receives each result as a DataFrame.
- Before the python block, write one ```sql block per query (at most {MAX_SQL_STEPS}). Each starts with two comment lines:
    -- name: monthly_sales        (the Python variable the result arrives in)
    -- source: <the source id above>
  then exactly ONE read-only SELECT in that source's dialect, using the table names exactly as listed.
- Push the heavy work into SQL: filter, join and aggregate in the database; return only the rows Python needs
  (max {SQL_ROW_CAP:,} rows per query - more are cut off). Totals, counts and averages over a whole table come from
  SQL over ALL rows, never from a sample.
- For a model or a statistical test, select the rows and feature columns to learn from (if a table is huge, take a
  random or recent subset in SQL and say so in "assumptions").
- In Python, use each result by its name. Do not invent tables or columns."""


def parse_sql_steps(text: str) -> list[dict]:
    out = []
    for block in _SQL_BLOCK.findall(text or ""):
        meta, body = {}, []
        for line in block.splitlines():
            m = _HEADER.match(line)
            if m and not body:
                meta[m.group(1).lower()] = m.group(2).strip().strip("`'\"")
            else:
                body.append(line)
        sql = "\n".join(body).strip().rstrip(";").strip()
        if sql:
            out.append({"name": meta.get("name") or f"query_{len(out) + 1}", "source": meta.get("source") or "", "sql": sql})
    return out[:MAX_SQL_STEPS]


def strip_sql_blocks(text: str) -> str:
    return _SQL_BLOCK.sub("", text or "")


def _py_ident(name: str, taken: set[str]) -> str:
    base = re.sub(r"[^0-9a-zA-Z_]+", "_", (name or "").strip()).strip("_").lower() or "query"
    if base[0].isdigit():
        base = f"q_{base}"
    if base in ("pd", "np", "stats", "optimize", "math", "rng", "df", "tables", "result", "statistics", "itertools", "sm"):
        base = f"{base}_data"
    out, i = base, 2
    while out in taken:
        out, i = f"{base}_{i}", i + 1
    taken.add(out)
    return out


def _resolve(source: str, live: list[CatalogSource]) -> CatalogSource | None:
    s = (source or "").strip().lower()
    for src in live:
        if s and (src.id.lower() == s or src.name.lower() == s):
            return src
    for src in live:
        if s and (s in src.name.lower() or src.id.lower().startswith(s)):
            return src
    return live[0] if len(live) == 1 else None


def run_sql_steps(db: Session, user: models.User, catalog: Catalog, steps: list[dict], live: list[CatalogSource],
                  taken: set[str], cache: dict) -> tuple[dict[str, pd.DataFrame], list[dict], list[str]]:
    """Runs the reply's SQL steps (in parallel, through the same runner as planned steps).
    Returns ({python name: DataFrame}, a record per step for the page, errors for the model).
    `cache` holds results by (source id, sql) so a retry that keeps a query does not run it again."""
    from . import executor
    frames: dict[str, pd.DataFrame] = {}
    records: list[dict] = []
    errors: list[str] = []
    to_run: list[dict] = []
    local_taken = set(taken)
    for st in steps:
        src = _resolve(st["source"], live)
        name = _py_ident(st["name"], local_taken)
        rec = {"name": name, "source": src.name if src else st["source"], "source_id": src.id if src else None,
               "sql": st["sql"], "status": "pending"}
        records.append(rec)
        if src is None:
            rec.update(status="failed", error="Unknown source")
            ids = ", ".join(f"{s.id} ({s.name})" for s in live) or "none"
            errors.append(f"SQL step {name}: no live source matches '{st['source']}'. Use one of these source ids: {ids}.")
            continue
        try:
            check_step_sql(st["sql"], src)
        except PlanSQLError as e:
            rec.update(status="failed", error=str(e)[:300])
            errors.append(f"SQL step {name}: {e}")
            continue
        key = (src.id, st["sql"].strip())
        if key in cache:
            hit = cache[key]
            frames[name] = hit["df"]
            rec.update(status="done", sql=hit["sql"], rows=int(len(hit["df"])), truncated=hit["truncated"], ms=0, cached=True,
                       **_preview(hit["df"]))
            continue
        to_run.append({"id": name, "title": name, "source_id": src.id, "sql": st["sql"], "row_cap": SQL_ROW_CAP, "_key": key})

    if to_run:
        fields: dict[str, dict] = {}

        def set_step(step_id, **kv):
            fields.setdefault(step_id, {}).update(kv)

        started = time.perf_counter()
        tables, _evidence = executor.run_plan(db, {"steps": to_run, "combine": []}, user, catalog, set_step, lambda: False)
        for st in to_run:
            rec = next(r for r in records if r["name"] == st["id"])
            f = fields.get(st["id"], {})
            if st["id"] in tables:
                df = tables[st["id"]]
                frames[st["id"]] = df
                cache[st["_key"]] = {"df": df, "sql": f.get("sql") or st["sql"], "truncated": bool(f.get("truncated"))}
                rec.update(status="done", sql=f.get("sql") or st["sql"], rows=int(len(df)), truncated=bool(f.get("truncated")),
                           ms=f.get("duration_ms"), repaired=bool(f.get("repaired")), bytes_scanned=f.get("bytes_scanned"),
                           **_preview(df))
                if f.get("truncated"):
                    errors_note = (f"NOTE: SQL step {st['id']} returned more than {SQL_ROW_CAP:,} rows and was cut off - "
                                   "aggregate or filter in SQL if the answer needs every row.")
                    rec["note"] = errors_note
            else:
                msg = f.get("error") or "The query did not run."
                rec.update(status="failed", error=str(msg)[:400], sql=f.get("sql") or st["sql"])
                errors.append(f"SQL step {st['id']} failed in the database: {msg}")
        print(f"[analyst] {len(to_run)} SQL step(s) in {time.perf_counter() - started:.1f}s, {len(errors)} failed")
    return frames, records, errors


def _preview(df: pd.DataFrame) -> dict:
    p = table_payload(df.head(PREVIEW_ROWS), limit=PREVIEW_ROWS)
    return {"columns": p["columns"], "preview": p["rows"]}


def results_text(frames: dict[str, pd.DataFrame], records: list[dict]) -> str:
    """What the SQL steps returned, for a retry message: shape, columns and a few rows of each."""
    out = []
    for r in records:
        if r.get("status") != "done" or r["name"] not in frames:
            continue
        df = frames[r["name"]]
        cols = ", ".join(f"{c} ({str(t)})" for c, t in list(df.dtypes.items())[:40])
        with pd.option_context("display.max_columns", 30, "display.width", 200, "display.max_colwidth", 24):
            head = df.head(5).to_string(index=False)
        out.append(f"{r['name']}: {len(df):,} rows; columns: {cols}\n" + "\n".join("    " + x for x in head.splitlines()))
    return "\n".join(out)
