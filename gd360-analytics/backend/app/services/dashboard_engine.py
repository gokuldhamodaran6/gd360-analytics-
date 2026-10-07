"""
Warehouse-native dashboard engine (2026-10-06).

The product rule (the founder's firm decision): for a warehouse/database
data source (BigQuery, Snowflake, Postgres, MySQL, SQL Server, Supabase)
rows are NEVER loaded into GD360 for analysis. The chat already obeys it
(routers/chat.py). This module makes dashboards obey it too: every block
of a dashboard on such a source is a BlockSpec (services/query_builder.
validate_block_spec) and, on every refresh or filter change, the engine
compiles that spec PLUS the page's live filter rail into ONE query that
runs inside the warehouse - fast (bounded concurrency, an in-process
result cache keyed by the exact SQL), audited (one PushdownQueryLog row
per real query, through the same chokepoint as chat), and honest (a
block that could not be computed says so in its own result; nothing is
ever filtered in pandas, nothing ever falls back to a sample).

File sources (csv/excel/sheets/...) never reach this module - their data
is complete inside the app and routers/dashboard_builder.py keeps the
pandas path for them unchanged.

Public API (every function returns plain JSON-safe dicts):
  run_page(...)          - every warehouse block on a page, concurrently.
  run_block(...)         - one block (the same result shape).
  compile_block(...)     - the SQL (main / prior / sparkline) without running.
  distinct_values(...)   - a filter-rail parameter's options with counts.
  validate_spec_in_warehouse(...) - zero-row validation of a spec's SQL.

BlockResult shape (run_page's per-block value, run_block's return):
  {"status": "ok"|"error"|"rejected_unsafe"|"rejected_too_expensive"|
             "budget_exhausted"|"invalid_spec",
   "error": str|None,
   "columns": [{"name", "type"}], "rows": [{col: value}], "row_count": int,
   "truncated": bool,                 # row_count hit the spec's limit
   "sql": str,                        # exactly what ran (CTEs inlined)
   "bytes_scanned": int|None, "duration_ms": int, "cached": bool,
   "computed_in": ds.kind, "ran_at": iso str,
   "dimensions": [cols], "measures": [aliases], "time_column": "period"|None,
   "exact_total_rows": int|None,      # the table's profiled COUNT(*) if cached
   "prior": {"columns", "rows", "row_count", "sql", "date_range", ...}|None,
   "delta": {alias: {"current", "prior", "abs", "pct"}}|None,   # KPI tiles
   "sparkline": {"columns", "rows", "sql", "grain"}|None,
   "spec": <normalised spec>}

2026-10-07 (chart-types round) - a BlockResult may also carry:
  "date_parts": {alias: "weekday"|"month"|...}  the derived dimensions;
  "bins": {"column", "start", "width", "count", "end", "integer",
           "underflow", "overflow"}             a histogram's edges (rows are
                                                one per bin, empty bins included);
  "partial": {"first": {...}|None, "last": {"period", "through", "days", "of"}|None}
                                                buckets the data only partly covers;
  "forecast": {"status": "ok"|"refused", "reason", "horizon", "interval",
               "points": [{period, value, lo80, hi80, lo95, hi95}], "method",
               "season_length", "backtest": {mape, smape, mase, folds, ...},
               "notes": [...], "series": [per-series forecasts]}
  "anomalies": [{period, value, expected, lo, hi, direction, series}]
when run_page's block entry has "forecast": {horizon, interval, anomalies}
(the block's config.forecast). None of these holds SQL.

2026-10-07 (analyst canvas round) - cells. run_page's `blocks` may now
also carry:
  {"id", "type": "sql", "sql": <raw SELECT>, "name": <cell name>} - a SQL
     cell: the person's own statement, run as-is (the page's filter rail
     is NOT pushed down - raw SQL has no spec) with the dashboard's
     parameters BOUND (bind_parameters: {{name}} / @name become real
     query parameters, never text), other cells inlined as CTEs
     ({{cell:<name>}}), capped at DASHBOARD_MAX_BLOCK_ROWS rows.
  {"id", "type": "chart"|"kpi"|..., "source_block_id": <id>} - a block
     rendered from another cell's result (no query of its own).
run_page orders cells by their dependencies (sources before dependents,
CTE chains resolved transitively), raises DependencyCycleError for a
loop, and reports {"dependencies": {id: [source ids]}, "order": [ids],
"parameters_used": {name: value}, "missing_parameters": [names]}.
A SQL-cell BlockResult adds "kind": "sql", "name", "parameters" (names
referenced), "missing_parameters"; a derived block adds "kind":
"derived", "source_block_id".
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from types import SimpleNamespace

from sqlalchemy.orm import Session

from .. import models
from ..config import get_settings
from . import forecast as forecast_svc
from . import query_builder as qb
from . import warehouse_exec
from . import warehouse_tables
from .connectors import QueryTooExpensive, assert_read_only_sql
from .profile_cache import cached_exact_total_rows
from .pushdown_budget import log_pushdown

settings = get_settings()

SPARKLINE_MAX_POINTS = 400
COUNT_ALIAS = "gd360_n"


def is_warehouse_native(ds) -> bool:
    """True when a dashboard on this data source must compute every block
    inside the warehouse (the SQL warehouse/database kinds). MongoDB is a
    pushdown kind for chat but has no SQL builder yet, so it is False."""
    return bool(ds) and warehouse_exec.is_sql_warehouse(getattr(ds, "kind", None))


# --- caches -----------------------------------------------------------------

class TTLCache:
    """A tiny thread-safe in-process TTL cache with a size bound (oldest
    insert evicted first). Values are whatever the caller stores; the
    caller treats them as immutable."""

    def __init__(self, ttl_seconds: float, max_entries: int = 512):
        self.ttl = ttl_seconds
        self.max_entries = max_entries
        self._data: OrderedDict = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key):
        with self._lock:
            entry = self._data.get(key)
            if entry is None:
                return None
            stored_at, value = entry
            if time.time() - stored_at > self.ttl:
                self._data.pop(key, None)
                return None
            return value

    def put(self, key, value) -> None:
        with self._lock:
            if key in self._data:
                self._data.pop(key)
            self._data[key] = (time.time(), value)
            while len(self._data) > self.max_entries:
                self._data.popitem(last=False)

    def clear(self) -> None:
        with self._lock:
            self._data.clear()

    def __len__(self) -> int:
        with self._lock:
            return len(self._data)


_result_cache = TTLCache(settings.DASHBOARD_RESULT_CACHE_TTL_SECONDS)
_options_cache = TTLCache(settings.DASHBOARD_OPTIONS_CACHE_TTL_SECONDS)
# 2026-10-07 (chart-types round): a forecast is a pure function of the
# block's aggregated rows and its options, so it is cached by a fingerprint
# of exactly those - alongside the block result it was computed from.
_forecast_cache = TTLCache(settings.DASHBOARD_RESULT_CACHE_TTL_SECONDS, max_entries=256)


def params_fingerprint(params) -> str:
    """A stable text for a bound-parameter payload (any dialect shape),
    for cache keys and in-batch de-duplication."""
    if not params:
        return ""
    try:
        return json.dumps(params, sort_keys=True, default=str)
    except Exception:
        return repr(params)


def cache_key(ds_id: str, sql: str, params=None) -> tuple:
    return (ds_id, hashlib.sha256(((sql or "") + "\x00" + params_fingerprint(params)).encode("utf-8")).hexdigest())


def clear_caches() -> None:
    _result_cache.clear()
    _options_cache.clear()
    _forecast_cache.clear()


# --- helpers ----------------------------------------------------------------

def ds_snapshot(ds) -> SimpleNamespace:
    """A plain copy of the DataSource fields the connectors need, taken on
    the request thread so worker threads never touch a SQLAlchemy
    instance (an expired attribute would lazy-load through the Session,
    which is not thread-safe)."""
    return SimpleNamespace(
        id=ds.id, kind=ds.kind, name=getattr(ds, "name", None),
        connection_info=dict(ds.connection_info or {}), encrypted_secret=ds.encrypted_secret,
        schema_cache=ds.schema_cache,
    )


def load_versions(db: Session, ds) -> list:
    """The saved-query DatasetVersions of this data source - a block spec
    may name one by its sql_alias, in which case its statement is wrapped
    in the matching CTE (warehouse_tables.wrap_with_ctes)."""
    try:
        rows = (
            db.query(models.DatasetVersion)
            .filter(models.DatasetVersion.datasource_id == ds.id, models.DatasetVersion.source_kind == "warehouse_query")
            .all()
        )
    except Exception:
        return []
    return [v for v in rows if getattr(v, "sql_alias", None) and getattr(v, "query_sql", None)]


def version_ctes(versions) -> list[tuple[str, str]]:
    return [(v.sql_alias, v.query_sql) for v in (versions or []) if getattr(v, "sql_alias", None) and getattr(v, "query_sql", None)]


def schema_with_aliases(ds, versions) -> tuple[dict, set[str]]:
    return qb.with_version_aliases(ds.schema_cache, versions)


def normalize_period(period: str | None, default_period: str | None = None) -> str:
    for candidate in (period, default_period):
        if isinstance(candidate, str) and candidate.lower() in qb.GRAINS:
            return candidate.lower()
    return "month"


def normalize_page_filters(page_filters) -> list[dict]:
    """[{column, spec}] (FilterCriterion objects or dicts) -> BLOCK_OPS
    filters. Per-table column checks happen at compile time."""
    return qb.page_filters_to_block_filters(page_filters or [])


def _json_scalar(v):
    if v is None:
        return None
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, str)):
        return v
    if isinstance(v, float):
        return None if (math.isnan(v) or math.isinf(v)) else v
    if isinstance(v, Decimal):
        f = float(v)
        return None if (math.isnan(f) or math.isinf(f)) else (int(v) if v == v.to_integral_value() and abs(f) < 1e15 else f)
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    if isinstance(v, bytes):
        return v.decode("utf-8", "replace")
    try:
        import numpy as np  # local - keeps this module importable without pandas in tests
        if isinstance(v, np.generic):
            return _json_scalar(v.item())
    except Exception:
        pass
    try:
        import pandas as pd
        if isinstance(v, pd.Timestamp):
            return None if pd.isna(v) else v.isoformat()
        if v is pd.NaT:
            return None
        if hasattr(v, "isoformat"):
            return v.isoformat()
        if pd.isna(v):
            return None
    except Exception:
        pass
    return str(v)


def frame_to_result(df, limit: int | None = None) -> tuple[list[dict], list[dict], int, bool]:
    """(columns, rows, row_count, truncated) from a result DataFrame,
    JSON-safe. `limit` is the spec's row cap: when the frame has exactly
    that many rows the result is flagged truncated (the warehouse may
    have had more)."""
    if df is None:
        return [], [], 0, False
    columns = [{"name": str(c), "type": str(df[c].dtype)} for c in df.columns]
    records = []
    for row in df.itertuples(index=False, name=None):
        records.append({str(c): _json_scalar(v) for c, v in zip(df.columns, row)})
    n = len(records)
    truncated = bool(limit is not None and n >= limit)
    return columns, records, n, truncated


# --- compile ----------------------------------------------------------------

@dataclass
class Compiled:
    spec: dict
    sql: str                       # CTE-wrapped, exactly what runs
    prior_sql: str | None = None
    sparkline_sql: str | None = None
    prior_range: dict | None = None
    sparkline_grain: str | None = None
    filters_applied: list = field(default_factory=list)
    date_range: dict | None = None
    period: str = "month"
    error: str | None = None
    bin_edges: dict | None = None


def compile_block(
    ds, block_spec: dict, page_filters=None, period: str | None = None, date_range=None,
    date_column: str | None = None, versions=None, block_filters=None, default_period: str | None = None,
    bin_edges: dict | None = None,
) -> Compiled:
    """Compiles one block: main SQL with the page (+ per-block) filters and
    the date range pushed down, the prior-period SQL (same spec over the
    window immediately before, when compare_prior_period and the range is
    closed) and the sparkline SQL (the spec with no group-by, bucketed by
    the period over the range, when sparkline is set). Raises nothing: a
    spec that cannot be compiled comes back with `error` set."""
    grain = normalize_period(period, default_period)
    schema, aliases = schema_with_aliases(ds, versions)
    ctes = version_ctes(versions)
    page = normalize_page_filters(page_filters)
    own = normalize_page_filters(block_filters) if block_filters else []
    extra = page + own
    rng = qb.normalize_date_range(date_range)
    info = ds.connection_info or {}
    try:
        sql, spec = qb.build_block_sql(
            block_spec, ds.kind, schema, info, aliases, extra_filters=extra, date_range=rng,
            date_column=date_column, grain_override=grain, bin_edges=bin_edges,
        )
        sql = warehouse_exec.wrap_ctes(sql, ctes)
    except (qb.QueryBuilderError, Exception) as e:
        return Compiled(spec=block_spec if isinstance(block_spec, dict) else {}, sql="", error=str(e), period=grain,
                        date_range=rng)
    compiled = Compiled(spec=spec, sql=sql, filters_applied=extra, date_range=rng, period=grain, bin_edges=bin_edges)
    if spec.get("compare_prior_period"):
        prior_rng = qb.prior_period_range(rng)
        if prior_rng:
            try:
                prior_sql, _ = qb.build_block_sql(
                    block_spec, ds.kind, schema, info, aliases, extra_filters=extra, date_range=prior_rng,
                    date_column=date_column, grain_override=grain, bin_edges=bin_edges,
                )
                compiled.prior_sql = warehouse_exec.wrap_ctes(prior_sql, ctes)
                compiled.prior_range = prior_rng
            except Exception:
                compiled.prior_sql = None
    if spec.get("sparkline"):
        known = {c["name"] for c in qb.table_columns(schema, spec["table"]) or []}
        tcol = date_column if (date_column and date_column in known) else (spec["time"]["column"] if spec.get("time") else None)
        if tcol:
            series_spec = {
                **{k: v for k, v in spec.items() if k not in ("bins", "date_parts")},
                "time": {"column": tcol, "grain": grain}, "group_by": [],
                "order_by": [{"by": qb.PERIOD_ALIAS, "dir": "asc"}], "limit": SPARKLINE_MAX_POINTS,
                "compare_prior_period": False, "sparkline": False,
            }
            try:
                spark_sql, _ = qb.build_block_sql(
                    series_spec, ds.kind, schema, info, aliases, extra_filters=extra, date_range=rng,
                    date_column=date_column, grain_override=grain,
                )
                compiled.sparkline_sql = warehouse_exec.wrap_ctes(spark_sql, ctes)
                compiled.sparkline_grain = grain
            except Exception:
                compiled.sparkline_sql = None
    return compiled


# --- execution --------------------------------------------------------------

@dataclass
class _Job:
    key: str
    sql: str
    params: object = None           # dialect-shaped bound parameters (bind_parameters), or None
    cached: dict | None = None
    outcome: dict | None = None     # {"df", "bytes_scanned", "duration_ms"} or {"error", "status", "bytes"}

    @property
    def dedupe_key(self) -> str:
        return (self.sql or "") + "\x00" + params_fingerprint(self.params)


def _run_job(ds_plain, job: _Job) -> _Job:
    """Worker-thread body: one statement through warehouse_exec.run_sql
    (a fresh connector per call). Touches no Session."""
    started = time.perf_counter()
    try:
        df, bytes_scanned = warehouse_exec.run_sql(ds_plain, job.sql, params=job.params or None)
        job.outcome = {"df": df, "bytes_scanned": bytes_scanned, "duration_ms": int((time.perf_counter() - started) * 1000)}
    except QueryTooExpensive as e:
        job.outcome = {"error": str(e), "status": "rejected_too_expensive", "bytes": e.estimated_bytes,
                       "duration_ms": int((time.perf_counter() - started) * 1000)}
    except Exception as e:
        # The block's `error` is the database's own sentence (no driver
        # class, no statement echo, no documentation link); the full text
        # goes to the server log and, as `raw_error`, to the audit row.
        print(f"[dashboard_engine] {getattr(ds_plain, 'kind', '?')} query failed: {e}")
        job.outcome = {"error": warehouse_exec.clean_warehouse_error(e), "raw_error": str(e),
                       "status": warehouse_exec.classify_error(e), "bytes": None,
                       "duration_ms": int((time.perf_counter() - started) * 1000)}
    return job


def _execute_jobs(db: Session, ds, user_id: str, jobs: list[_Job], force_refresh: bool = False,
                  budget_exhausted: bool = False, max_parallel: int | None = None) -> None:
    """Runs every job: cache hits are served without a query; the rest run
    concurrently (one connector per thread), then are audited and cached
    on the request thread. Duplicate SQL within one batch runs once."""
    ds_plain = ds_snapshot(ds)
    to_run: dict[str, _Job] = {}
    for job in jobs:
        if not job.sql:
            continue
        key = cache_key(ds.id, job.sql, job.params)
        if not force_refresh:
            hit = _result_cache.get(key)
            if hit is not None:
                job.cached = hit
                continue
        if budget_exhausted:
            job.outcome = {"error": "Today's warehouse scan budget for your account is used up - this block will "
                                    "compute again tomorrow, or when the budget is raised.",
                           "status": "budget_exhausted", "bytes": None, "duration_ms": 0}
            continue
        if job.dedupe_key in to_run:
            continue
        to_run[job.dedupe_key] = job
    if to_run:
        workers = max(1, min(max_parallel or settings.DASHBOARD_RUN_MAX_PARALLEL, len(to_run)))
        if workers == 1:
            for job in to_run.values():
                _run_job(ds_plain, job)
        else:
            with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="gd360-dash") as pool:
                list(pool.map(lambda j: _run_job(ds_plain, j), list(to_run.values())))
        # Audit + cache on the request thread (the Session is only safe here).
        for job in to_run.values():
            out = job.outcome or {}
            if "df" in out:
                log_pushdown(db, user_id, ds.id, ds.kind, job.sql, out.get("bytes_scanned"), "ok")
            else:
                log_pushdown(db, user_id, ds.id, ds.kind, job.sql, out.get("bytes"), out.get("status") or "error",
                             out.get("raw_error") or out.get("error"))
    # Share outcomes across duplicate-SQL jobs.
    for job in jobs:
        if job.sql and job.cached is None and job.outcome is None and job.dedupe_key in to_run:
            job.outcome = to_run[job.dedupe_key].outcome


def _materialize(job: _Job, ds, limit: int | None, sql: str) -> dict:
    """The JSON result for one job - from the cache, or from its fresh
    outcome (which is then cached)."""
    if job.cached is not None:
        return {**job.cached, "cached": True}
    out = job.outcome or {"error": "This block did not run.", "status": "error", "duration_ms": 0}
    if "df" in out:
        columns, rows, n, truncated = frame_to_result(out["df"], limit)
        result = {
            "status": "ok", "error": None, "columns": columns, "rows": rows, "row_count": n, "truncated": truncated,
            "sql": sql, "bytes_scanned": out.get("bytes_scanned"), "duration_ms": out.get("duration_ms", 0),
            "ran_at": datetime.utcnow().isoformat() + "Z",
        }
        _result_cache.put(cache_key(ds.id, sql, job.params), result)
        return {**result, "cached": False}
    return {
        "status": out.get("status") or "error", "error": out.get("error"), "columns": [], "rows": [], "row_count": 0,
        "truncated": False, "sql": sql, "bytes_scanned": out.get("bytes"), "duration_ms": out.get("duration_ms", 0),
        "ran_at": datetime.utcnow().isoformat() + "Z", "cached": False,
    }


def _kpi_delta(result: dict, prior: dict | None, spec: dict) -> dict | None:
    """For a one-row result (no group_by, no time bucket): per-measure
    current/prior/abs/pct."""
    if not result.get("rows") or prior is None or not prior.get("rows"):
        return None
    if spec.get("group_by") or spec.get("time"):
        return None
    cur, prev = result["rows"][0], prior["rows"][0]
    delta: dict = {}
    for m in spec.get("measures") or []:
        alias = m["alias"]
        c, p = cur.get(alias), prev.get(alias)
        if isinstance(c, bool) or isinstance(p, bool) or not isinstance(c, (int, float)) or not isinstance(p, (int, float)):
            delta[alias] = {"current": c, "prior": p, "abs": None, "pct": None}
            continue
        delta[alias] = {
            "current": c, "prior": p, "abs": c - p,
            "pct": (round((c - p) / abs(p) * 100.0, 2) if p not in (0, 0.0) else None),
        }
    return delta


def _assemble(compiled: Compiled, ds, main: _Job, prior: _Job | None, spark: _Job | None) -> dict:
    spec = compiled.spec
    result = _materialize(main, ds, spec.get("limit"), compiled.sql)
    result["computed_in"] = ds.kind
    result["dimensions"] = list(spec.get("group_by") or []) + [p["alias"] for p in (spec.get("date_parts") or [])]
    result["measures"] = [m["alias"] for m in (spec.get("measures") or [])]
    if spec.get("date_parts"):
        result["date_parts"] = {p["alias"]: p["part"] for p in spec["date_parts"]}
    if spec.get("bins") and compiled.bin_edges and result.get("status") == "ok":
        result = histogram_result(result, spec, compiled.bin_edges)
    result["time_column"] = qb.PERIOD_ALIAS if spec.get("time") else None
    result["exact_total_rows"] = cached_exact_total_rows(ds.id, spec.get("table"))
    result["spec"] = spec
    result["period"] = compiled.period
    result["date_range"] = compiled.date_range
    result["filters_applied"] = compiled.filters_applied
    prior_result = None
    if prior is not None and compiled.prior_sql:
        prior_result = _materialize(prior, ds, spec.get("limit"), compiled.prior_sql)
        prior_result["date_range"] = compiled.prior_range
    result["prior"] = prior_result
    result["delta"] = _kpi_delta(result, prior_result, spec) if prior_result and prior_result.get("status") == "ok" else None
    spark_result = None
    if spark is not None and compiled.sparkline_sql:
        spark_result = _materialize(spark, ds, SPARKLINE_MAX_POINTS, compiled.sparkline_sql)
        spark_result["grain"] = compiled.sparkline_grain
        spark_result.pop("truncated", None)
    result["sparkline"] = spark_result
    return result


def _invalid_result(compiled: Compiled, ds) -> dict:
    return {
        "status": "invalid_spec", "error": compiled.error, "columns": [], "rows": [], "row_count": 0,
        "truncated": False, "sql": "", "bytes_scanned": None, "duration_ms": 0, "cached": False,
        "computed_in": ds.kind, "ran_at": datetime.utcnow().isoformat() + "Z", "dimensions": [], "measures": [],
        "time_column": None, "exact_total_rows": None, "prior": None, "delta": None, "sparkline": None,
        "spec": compiled.spec, "period": compiled.period, "date_range": compiled.date_range, "filters_applied": [],
    }


# --- histograms, partial periods, forecasts (2026-10-07, chart-types round) -----

def resolve_bin_edges(db: Session, ds, block_spec: dict, versions=None, user_id: str | None = None,
                      force_refresh: bool = False) -> tuple[dict | None, str | None]:
    """(edges, error) for a `bins` spec: the person's own min / max when
    both are set, else ONE cached `SELECT MIN, MAX, AVG, STDDEV, COUNT`
    of the binned column under the block's own filters (the page's
    filters are deliberately left out, so the bars do not change width
    while someone cross-filters). (None, None) for a spec without bins."""
    bins = (block_spec or {}).get("bins") if isinstance(block_spec, dict) else None
    if not isinstance(bins, dict) or not bins.get("column"):
        return None, None
    if versions is None:
        versions = load_versions(db, ds)
    schema, aliases = schema_with_aliases(ds, versions)
    try:
        sql, spec = qb.build_bins_stats_sql(block_spec, ds.kind, schema, ds.connection_info or {}, aliases)
        sql = warehouse_exec.wrap_ctes(sql, version_ctes(versions))
    except Exception as e:
        return None, str(e)
    b = spec["bins"]
    if b.get("min") is not None and b.get("max") is not None:
        try:
            edges = qb.histogram_edges({"min": b["min"], "max": b["max"]}, b["count"], b.get("integer", False), b["min"], b["max"])
            # The person's range may leave values outside it: both tails are possible.
            return {**edges, "underflow": True, "overflow": True}, None
        except Exception as e:
            return None, str(e)
    key = cache_key(ds.id, sql)
    stats = None if force_refresh else _options_cache.get(key)
    if stats is None:
        if warehouse_exec.daily_budget_exhausted(db, ds, user_id):
            return None, "Today's warehouse scan budget for your account is used up."
        res = warehouse_exec.execute_sql(db, ds, user_id, sql)
        if "df" not in res or not len(res["df"]):
            return None, (res.get("attempt") or {}).get("error") or "The column's range could not be read."
        row = [_json_scalar(v) for v in res["df"].iloc[0].tolist()]
        stats = dict(zip(("min", "max", "avg", "std", "n"), row + [None] * 5))
        _options_cache.put(key, stats)
    if stats.get("min") is None or stats.get("max") is None or not stats.get("n"):
        return None, f"The column {b['column']!r} has no values to draw a histogram of."
    try:
        edges = qb.histogram_edges(stats, b["count"], b.get("integer", False), b.get("min"), b.get("max"))
    except Exception as e:
        return None, str(e)
    return {**edges, "stats": {k: stats.get(k) for k in ("min", "max", "avg", "std", "n")}}, None


def histogram_result(result: dict, spec: dict, edges: dict) -> dict:
    """The (bin index, measures) rows of a histogram query as one row per
    bin, empty bins included: {<column>: bin start, "bin_end": bin end,
    "bin": index, <measure>: n}. Values outside the drawn range come back
    as their own rows (bin -1: below `start`; bin `count`: above `end`)
    only when there are any. `result["bins"]` carries the edges."""
    column = spec["bins"]["column"]
    measures = [m["alias"] for m in (spec.get("measures") or [])]
    by_bin: dict[int, dict] = {}
    for row in result.get("rows") or []:
        raw = row.get(qb.BIN_ALIAS, row.get(qb.BIN_ALIAS.upper()))
        try:
            idx = int(raw)
        except (TypeError, ValueError):
            continue
        by_bin[idx] = row
    n, start, width = int(edges["count"]), edges["start"], edges["width"]

    def edge(i: int):
        v = start + i * width
        return int(v) if edges.get("integer") else round(float(v), 10)

    rows: list[dict] = []
    under = by_bin.get(-1)
    if under and any((under.get(m) or 0) for m in measures):
        rows.append({column: None, "bin_end": edge(0), "bin": -1, **{m: under.get(m) or 0 for m in measures}})
    for i in range(n):
        src = by_bin.get(i) or {}
        rows.append({column: edge(i), "bin_end": edge(i + 1), "bin": i, **{m: src.get(m) or 0 for m in measures}})
    over = by_bin.get(n)
    if over and any((over.get(m) or 0) for m in measures):
        rows.append({column: edge(n), "bin_end": None, "bin": n, **{m: over.get(m) or 0 for m in measures}})
    types = {c["name"]: c.get("type") for c in result.get("columns") or []}
    out = dict(result)
    out["rows"] = rows
    out["row_count"] = len(rows)
    out["truncated"] = False
    out["columns"] = [{"name": column, "type": "int64" if edges.get("integer") else "float64"}, {"name": "bin_end", "type": "float64"}] + [
        {"name": m, "type": types.get(m)} for m in measures
    ]
    out["dimensions"] = [column]
    out["bins"] = {
        "column": column, "start": edges["start"], "width": edges["width"], "count": n, "end": edges["end"],
        "integer": bool(edges.get("integer")), "underflow": bool(under and rows and rows[0]["bin"] == -1),
        "overflow": bool(over and rows and rows[-1]["bin"] == n), "stats": edges.get("stats"),
    }
    return out


def _clamp_bounds(bounds: dict | None, date_range: dict | None) -> dict | None:
    """The time column's real first / last date, narrowed to the page's
    date range - what a bucket can actually be covered by."""
    lo = (bounds or {}).get("min")
    hi = (bounds or {}).get("max")
    rng = date_range or {}
    if rng.get("from") and (lo is None or str(rng["from"]) > str(lo)):
        lo = str(rng["from"])[:10]
    if rng.get("to") and (hi is None or str(rng["to"]) < str(hi)):
        hi = str(rng["to"])[:10]
    if lo is None and hi is None:
        return None
    return {"min": lo, "max": hi}


def _forecast_measures(spec: dict, formats: dict | None = None) -> list[dict]:
    """[{alias, additive, rate}] for the forecaster: a count or a sum has
    zeros where it has no rows; an average of a 0/1 flag (or a measure
    the block shows as a percent) is a rate and stays within [0, 1]."""
    out = []
    for i, m in enumerate(spec.get("measures") or []):
        agg = str(m.get("agg") or "").lower()
        rate = (formats or {}).get(m["alias"]) == "percent"
        if not rate and agg == "avg":
            try:
                rate = qb.infer_number_format({**spec, "measures": [m], "group_by": [], "time": None}) == "percent"
            except Exception:
                rate = False
        out.append({"alias": m["alias"], "additive": agg in ("sum", "count", "count_distinct"), "rate": bool(rate)})
    return out


def attach_time_analysis(
    result: dict, spec: dict, period: str, bounds: dict | None, date_range: dict | None, options: dict | None,
    formats: dict | None = None,
) -> None:
    """Adds, in place, what a time series knows beyond its rows:
      result["partial"]   buckets the data only partly covers (always, for
                          a time series - a line chart draws them dashed);
      result["forecast"] / result["anomalies"]   when the block has
                          config.forecast (see services/forecast.py).
    Never raises: a forecast that cannot be computed is a refusal with a
    reason, and anything unexpected leaves the result as it was."""
    try:
        if result.get("status") != "ok":
            return
        rows = result.get("rows") or []
        time_col = result.get("time_column")
        measures = _forecast_measures(spec, formats)
        series_col = None
        if not time_col:
            # A KPI tile: its sparkline is the series.
            spark = result.get("sparkline") or {}
            if not options or spark.get("status") not in (None, "ok") or not spark.get("rows"):
                return
            rows, time_col, period = spark["rows"], qb.PERIOD_ALIAS, spark.get("grain") or period
            measures = measures[:1]
        else:
            dims = result.get("dimensions") or []
            if len(dims) == 1:
                series_col, measures = dims[0], measures[:1]
            elif len(dims) > 1:
                options = None
        clamped = _clamp_bounds(bounds, date_range)
        periods = sorted({str(r.get(time_col)) for r in rows if r.get(time_col) is not None})
        partial = forecast_svc.partial_periods(periods, period, clamped, today=date.today())
        if partial.get("first") or partial.get("last"):
            result["partial"] = partial
        if not options:
            return
        key = forecast_svc.fingerprint(rows, time_col, measures, series_col, period, options, clamped)
        cached = _forecast_cache.get(key)
        if cached is None:
            cached = forecast_svc.forecast_result(rows, time_col, measures, series_col, period, options, partial=partial)
            _forecast_cache.put(key, cached)
        result["forecast"] = cached
        result["anomalies"] = cached.get("anomalies") or []
    except Exception as e:  # pragma: no cover - defensive: a forecast never fails a block
        print(f"[dashboard_engine] time analysis skipped (non-fatal): {e}")


# --- parameters (2026-10-07) -------------------------------------------------
#
# A SQL cell references a dashboard parameter as {{name}} or @name (and a
# date_range parameter's ends as {{name.from}} / {{name.to}}). The value is
# NEVER written into the SQL text: it is bound through the warehouse's own
# parameter mechanism - BigQuery query parameters in the job config,
# SQLAlchemy bound parameters (:name) for Postgres/MySQL/SQL Server/
# Supabase, the Snowflake connector's pyformat binding (%(name)s). A list
# value becomes one ARRAY parameter on BigQuery (`IN UNNEST(@name)`) and,
# on every other dialect, one bound parameter PER VALUE (`IN (:name_0,
# :name_1, ...)`) because those drivers cannot bind an array for IN.

_PARAM_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_REF_RE = re.compile(
    r"\{\{\s*(?P<braced>[A-Za-z_][A-Za-z0-9_]*(?:\.(?:from|to))?)\s*\}\}"
    r"|(?<![A-Za-z0-9_@:])@(?P<at>[A-Za-z_][A-Za-z0-9_]*(?:\.(?:from|to))?)"
)
_CELL_REF_RE = re.compile(r"\{\{\s*cell\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")
_ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_ISO_TS_RE = re.compile(r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$")
_IN_CONTEXT_RE = re.compile(
    r"(?P<kw>\bIN\s+UNNEST\s*\(\s*|\bIN\s*\(\s*|\bNOT\s+IN\s+UNNEST\s*\(\s*|\bNOT\s+IN\s*\(\s*|\bIN\s+|\bNOT\s+IN\s+)$",
    re.IGNORECASE,
)


# 2026-10-07 (real end-to-end run): `col IN ({{p}})` with nothing picked.
# An empty multi-select means "all" everywhere else in the product; in a
# SQL cell it used to bind `IN (NULL)`, match no row, and leave the page
# saying "Waiting for a value: hotel, market_segment" over an empty table.
# When the predicate is the plain shape - a (qualified, optionally quoted)
# column name directly before [NOT] IN, standing on its own after WHERE /
# AND / OR / ON / HAVING / WHEN or an opening parenthesis - the whole
# predicate is replaced by a tautology every dialect accepts. Anything
# more involved (an expression, a NOT in front, arithmetic) keeps the old
# behaviour and is still reported in missing_parameters.
_IDENT_PART = r'(?:"[^"\n]+"|`[^`\n]+`|\[[^\]\n]+\]|[A-Za-z_][A-Za-z0-9_$]*)'
_IN_SUBJECT_RE = re.compile(r"(?P<subject>" + _IDENT_PART + r"(?:\s*\.\s*" + _IDENT_PART + r")*)\s*$")
_PREDICATE_LEAD_RE = re.compile(r"(?:^|\(|\b(?:WHERE|AND|OR|ON|HAVING|WHEN))\s*$", re.IGNORECASE)
_SQL_KEYWORDS = frozenset((
    "select", "from", "where", "and", "or", "not", "on", "having", "when", "then", "else", "end", "case", "in", "is",
    "null", "like", "between", "exists", "all", "any", "some", "as", "by", "group", "order", "limit", "join", "union",
    "true", "false", "distinct", "with", "over", "using",
))
_NO_FILTER_SQL = "(1 = 1)"
_ALL_WHEN_EMPTY_CONTROLS = frozenset(("chips", "multi", "search", "checkboxes", "segmented"))


def _is_empty_selection(value) -> bool:
    return value is None or value == "" or (isinstance(value, (list, tuple)) and len(value) == 0)


def _plain_in_predicate(lead: str, lead_masked: str) -> int | None:
    """Where the predicate `<column> [NOT] IN (...)` starts inside `lead`
    (the text between the previous reference and the IN keyword), when
    the thing before IN is just a column name standing as a predicate of
    its own; None otherwise. `lead_masked` is the same text with quoted
    strings/identifiers blanked, used to look at what precedes the column."""
    m = _IN_SUBJECT_RE.search(lead)
    if not m:
        return None
    subject = m.group("subject")
    last = re.split(r"\s*\.\s*", subject)[-1]
    if last.lower() in _SQL_KEYWORDS:
        return None
    if not _PREDICATE_LEAD_RE.search(lead_masked[:m.start("subject")]):
        return None
    return m.start("subject")


class DependencyCycleError(ValueError):
    """Cells depend on each other in a loop - run_page cannot order them."""


class ParameterError(ValueError):
    """A SQL cell references a parameter the dashboard does not define, or
    uses one in a way that cannot be bound."""


def _mask_literals(sql: str) -> str:
    """The SQL with every quoted string/identifier and comment replaced
    by spaces of the same length, so references inside them are ignored
    and every index still lines up with the original text."""
    out = list(sql)
    i, n = 0, len(sql)
    while i < n:
        ch = sql[i]
        if ch == "-" and sql.startswith("--", i):
            j = sql.find("\n", i)
            j = n if j < 0 else j
            for k in range(i, j):
                out[k] = " "
            i = j
            continue
        if ch == "/" and sql.startswith("/*", i):
            j = sql.find("*/", i + 2)
            j = n if j < 0 else j + 2
            for k in range(i, j):
                out[k] = " "
            i = j
            continue
        if ch in ("'", '"', "`"):
            j = i + 1
            while j < n:
                if sql[j] == "\\" and ch != "`":
                    j += 2
                    continue
                if sql[j] == ch:
                    if j + 1 < n and sql[j + 1] == ch:
                        j += 2
                        continue
                    break
                j += 1
            j = min(n, j + 1)
            for k in range(i, j):
                out[k] = " "
            i = j
            continue
        i += 1
    return "".join(out)


def parameter_name(p: dict) -> str | None:
    """The name a SQL cell uses for a rail parameter: its `name`, else its
    id, else its column (slugified to an identifier)."""
    if not isinstance(p, dict):
        return None
    for key in ("name", "id", "column"):
        raw = p.get(key)
        if isinstance(raw, str) and raw.strip():
            name = re.sub(r"[^A-Za-z0-9_]+", "_", raw.strip()).strip("_")
            if name and not (name[0].isalpha() or name[0] == "_"):
                name = "p_" + name
            if name:
                return name
    return None


def referenced_parameters(sql: str) -> list[str]:
    """The base parameter names a SQL cell references (deduplicated, in
    order of first appearance; `{{x.from}}` counts as `x`). Quoted
    strings and comments are ignored."""
    masked = _mask_literals(sql or "")
    out: list[str] = []
    for m in _REF_RE.finditer(masked):
        ref = m.group("braced") or m.group("at")
        base = ref.split(".")[0]
        if base.lower() == "cell":
            continue
        if base not in out:
            out.append(base)
    return out


def referenced_cells(sql: str) -> list[str]:
    masked = _mask_literals(sql or "")
    out: list[str] = []
    for m in _CELL_REF_RE.finditer(masked):
        if m.group(1) not in out:
            out.append(m.group(1))
    return out


def resolve_parameter_values(dashboard_parameters, request_values=None, date_range=None) -> tuple[dict, dict]:
    """({name: value}, {name: parameter def}) for every rail parameter:
    the run request's value (keyed by name or id) wins, then the
    request's date_range for a date_range control, then the parameter's
    own default; a parameter with none of those maps to None (bound as
    NULL / an empty array, and reported in missing_parameters)."""
    values: dict = {}
    defs: dict = {}
    req = request_values if isinstance(request_values, dict) else {}
    for p in dashboard_parameters or []:
        name = parameter_name(p)
        if not name:
            continue
        defs[name] = p
        v = None
        if name in req:
            v = req[name]
        elif p.get("id") in req:
            v = req[p.get("id")]
        elif p.get("column") in req:
            v = req[p.get("column")]
        elif (p.get("control") == "date_range") and date_range:
            rng = qb.normalize_date_range(date_range)
            v = rng if rng else None
        if v is None or v == "" or v == []:
            v = p.get("default")
            if v == "" or v == []:
                v = None
        values[name] = v
    return values, defs


def _column_type_for(param: dict | None, schema) -> str:
    """The upper-cased warehouse type of the parameter's column, "" when
    unknown."""
    if not param or not schema:
        return ""
    column = param.get("column")
    tables = [param["table"]] if param.get("table") else list(schema.keys()) if isinstance(schema, dict) else []
    for t in tables:
        for c in qb.table_columns(schema, t) or []:
            if c.get("name") == column:
                return str(c.get("type") or "").upper()
    return ""


def _bq_type(value, column_type: str, prefer_date: bool = False) -> str:
    """The BigQuery parameter type for a value: from the Python type, and
    for an ISO date/timestamp STRING from the parameter column's own
    warehouse type (a date-looking string stays STRING against a STRING
    column; `prefer_date` - a date_range control's ends - makes it a DATE
    when the column type is unknown)."""
    if isinstance(value, bool):
        return "BOOL"
    if isinstance(value, int):
        return "INT64"
    if isinstance(value, float):
        return "FLOAT64"
    if isinstance(value, str):
        if _ISO_DATE_RE.match(value):
            if "TIMESTAMP" in column_type:
                return "TIMESTAMP"
            if "DATETIME" in column_type:
                return "DATETIME"
            if "DATE" in column_type or (prefer_date and not column_type):
                return "DATE"
            return "STRING"
        if _ISO_TS_RE.match(value):
            if "DATETIME" in column_type:
                return "DATETIME"
            if "TIMESTAMP" in column_type or prefer_date:
                return "TIMESTAMP"
            return "STRING"
        return "STRING"
    if value is None:
        if "INT" in column_type:
            return "INT64"
        if "FLOAT" in column_type or "NUMERIC" in column_type:
            return "FLOAT64"
        if "BOOL" in column_type:
            return "BOOL"
        if "TIMESTAMP" in column_type:
            return "TIMESTAMP"
        if "DATE" in column_type:
            return "DATE"
    return "STRING"


def _coerce_scalar(value):
    if isinstance(value, (bool, int, float, str)) or value is None:
        return value
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return str(value)


def bind_parameters(sql: str, values: dict, kind: str, param_defs: dict | None = None, schema=None) -> tuple[str, object, list[str]]:
    """(sql, params, referenced_names) - see bind_parameters_detailed, which
    also reports the parameters whose empty selection became "no filter"."""
    bound_sql, params, used, _relaxed = bind_parameters_detailed(sql, values, kind, param_defs, schema)
    return bound_sql, params, used


def bind_parameters_detailed(
    sql: str, values: dict, kind: str, param_defs: dict | None = None, schema=None,
) -> tuple[str, object, list[str], list[str]]:
    """Rewrites every parameter reference in `sql` into the dialect's own
    placeholder and returns (sql, params, referenced_names, unfiltered):
      - bigquery: `@name` + [{"name", "type", "value"}] / [{"name",
        "type", "values"}] (BigQueryConnector.query_parameters turns these
        into Scalar/ArrayQueryParameter objects in the job config).
      - postgres/mysql/sqlserver/supabase: `:name` + {name: value}
        (SQLAlchemy text() binding).
      - snowflake: `%(name)s` + {name: value} (the connector's binding).
    A list value in an IN context (`IN ({{x}})`, `IN {{x}}`, `IN
    UNNEST({{x}})`) becomes `IN UNNEST(@x)` on BigQuery and `IN (:x_0,
    :x_1, ...)` elsewhere - one bound parameter per value. A scalar in an
    IN context is treated as a one-element list. `{{x.from}}`/`{{x.to}}`
    read a {from, to} value. Raises ParameterError for a reference to a
    name not in `values` (the dashboard's parameters). The value text
    never enters the SQL.

    An EMPTY selection of a multi-value parameter in a plain `col IN
    ({{p}})` / `col NOT IN ({{p}})` predicate means "no filter": the
    predicate is replaced by `(1 = 1)` (valid in every dialect here) and
    nothing is bound for it. `unfiltered` lists the parameters EVERY one of
    whose references was relaxed that way - they are not "missing"."""
    param_defs = param_defs or {}
    masked = _mask_literals(sql or "")
    out_parts: list[str] = []
    bq_params: list[dict] = []
    dict_params: dict = {}
    used: list[str] = []
    relaxed: set[str] = set()
    strict: set[str] = set()
    pos = 0
    is_bq = kind == "bigquery"
    is_snow = kind == "snowflake"

    def placeholder(name: str) -> str:
        return f"@{name}" if is_bq else (f"%({name})s" if is_snow else f":{name}")

    def bind_scalar(name: str, value, column_type: str, prefer_date: bool = False) -> str:
        value = _coerce_scalar(value)
        if is_bq:
            bq_params.append({"name": name, "type": _bq_type(value, column_type, prefer_date), "value": value})
        else:
            dict_params[name] = value
        return placeholder(name)

    def bind_list(name: str, items: list, column_type: str) -> str:
        items = [_coerce_scalar(v) for v in items]
        if is_bq:
            elem_type = _bq_type(items[0], column_type) if items else _bq_type(None, column_type)
            bq_params.append({"name": name, "type": elem_type, "values": items})
            return f"UNNEST(@{name})"
        if not items:
            # Nothing selected: a constant that matches no row. Not a
            # user value - the literal NULL keyword only.
            return "(NULL)"
        names = []
        for i, v in enumerate(items):
            dict_params[f"{name}_{i}"] = v
            names.append(placeholder(f"{name}_{i}"))
        return "(" + ", ".join(names) + ")"

    for m in _REF_RE.finditer(masked):
        ref = m.group("braced") or m.group("at")
        base, _, part = ref.partition(".")
        if base.lower() == "cell":
            raise ParameterError(f"The cell reference {sql[m.start():m.end()]!r} could not be resolved.")
        if base not in values:
            raise ParameterError(
                f"The parameter \"{base}\" is not defined on this dashboard. Add it to the filter rail, or fix the name."
            )
        if base not in used:
            used.append(base)
        value = values.get(base)
        column_type = _column_type_for(param_defs.get(base), schema)
        bound_name = base if not part else f"{base}__{part}"
        if part:
            if isinstance(value, dict):
                value = value.get(part)
            elif value is not None:
                raise ParameterError(f"The parameter \"{base}\" is not a date range, so \"{ref}\" cannot be used.")
            if isinstance(value, str) and _ISO_DATE_RE.match(value) and "TIMESTAMP" in column_type:
                value = value + "T00:00:00"
        elif isinstance(value, dict):
            raise ParameterError(
                f"The parameter \"{base}\" is a date range - reference its ends as {{{{{base}.from}}}} and {{{{{base}.to}}}}."
            )

        before = masked[pos:m.start()]
        ctx = _IN_CONTEXT_RE.search(before)
        is_list = isinstance(value, (list, tuple))
        if ctx:
            kw = ctx.group("kw")
            kw_upper = kw.upper()
            # Normalise the IN context: drop the opening "UNNEST(" / "(" the
            # person wrote and the matching ")" after the reference, then
            # emit the dialect's own form.
            # 2026-10-07 (real end-to-end run): `ctx` was matched inside
            # `before`, which starts at `pos` - its offsets are relative to
            # `pos`, not to the statement. Using ctx.start() as an absolute
            # index was only right for the FIRST reference (pos == 0): for
            # any later IN-parameter everything between the previous
            # reference and this "IN (" was dropped, so
            #   WHERE hotel IN ({{hotel}}) AND market_segment IN ({{market_segment}})
            # reached the warehouse as
            #   WHERE hotel IN (:hotel_0)IN (:market_segment_0)
            lead = sql[pos:pos + ctx.start()]
            in_word = "NOT IN" if "NOT" in kw_upper else "IN"
            after_pos = m.end()
            if "(" in kw:
                rest = masked[after_pos:]
                closing = re.match(r"\s*\)", rest)
                if not closing:
                    raise ParameterError(f"Unbalanced parentheses around the parameter \"{base}\".")
                after_pos += closing.end()
            items = list(value) if is_list else ([] if value is None else [value])
            if not items and not part:
                pdef = param_defs.get(base)
                multi = (pdef or {}).get("control") in _ALL_WHEN_EMPTY_CONTROLS if pdef else is_list
                start = _plain_in_predicate(lead, masked[pos:pos + ctx.start()]) if multi else None
                if start is not None:
                    out_parts.append(lead[:start] + _NO_FILTER_SQL)
                    relaxed.add(base)
                    pos = after_pos
                    continue
            strict.add(base)
            rendered = bind_list(bound_name, items, column_type)
            out_parts.append(lead + f"{in_word} " + rendered)
            pos = after_pos
            continue
        strict.add(base)
        if is_list:
            # A list outside an IN context: still bound, as an array.
            rendered = bind_list(bound_name, list(value), column_type)
            out_parts.append(sql[pos:m.start()] + rendered)
            pos = m.end()
            continue
        prefer_date = bool(part) or (param_defs.get(base) or {}).get("control") == "date_range"
        out_parts.append(sql[pos:m.start()] + bind_scalar(bound_name, value, column_type, prefer_date))
        pos = m.end()
    out_parts.append(sql[pos:])
    bound_sql = "".join(out_parts)
    return bound_sql, (bq_params if is_bq else dict_params), used, [n for n in used if n in relaxed and n not in strict]


# --- cells & dependencies ---------------------------------------------------

DERIVED_TYPES = ("chart", "table", "kpi", "gauge", "donut", "sparkline", "avatar_list")


def _cell_name(block: dict) -> str | None:
    name = block.get("name")
    if isinstance(name, str) and _PARAM_NAME_RE.match(name.strip()):
        return name.strip()
    return None


def dependency_graph(blocks: list[dict]) -> dict[str, list[str]]:
    """{block_id: [block ids it needs first]} for run_page's `blocks`: a
    derived block needs its source_block_id; a SQL cell needs every cell
    it references as {{cell:<name>}} (unknown names are left for the
    compile step to report)."""
    by_name = {}
    for b in blocks:
        if b.get("type") == "sql":
            nm = _cell_name(b)
            if nm:
                by_name[nm] = b["id"]
    deps: dict[str, list[str]] = {}
    for b in blocks:
        own: list[str] = []
        if b.get("type") == "sql":
            for nm in referenced_cells(b.get("sql") or ""):
                if nm in by_name and by_name[nm] != b["id"] and by_name[nm] not in own:
                    own.append(by_name[nm])
                elif nm in by_name and by_name[nm] == b["id"]:
                    own.append(b["id"])  # a self-reference is a cycle
        src = b.get("source_block_id")
        if src and src != b["id"]:
            own.append(src)
        elif src == b["id"]:
            own.append(src)
        deps[b["id"]] = own
    return deps


def topological_order(deps: dict[str, list[str]]) -> list[str]:
    """Kahn's algorithm over dependency_graph's output; raises
    DependencyCycleError naming the loop."""
    indeg = {k: 0 for k in deps}
    children: dict[str, list[str]] = {k: [] for k in deps}
    for k, needs in deps.items():
        for n in needs:
            if n in deps:
                indeg[k] += 1
                children[n].append(k)
    ready = [k for k, d in indeg.items() if d == 0]
    order: list[str] = []
    while ready:
        k = ready.pop(0)
        order.append(k)
        for c in children[k]:
            indeg[c] -= 1
            if indeg[c] == 0:
                ready.append(c)
    if len(order) != len(deps):
        stuck = [k for k in deps if k not in order]
        # Walk one loop for the message.
        path = [stuck[0]]
        cur = stuck[0]
        while True:
            nxt = next((n for n in deps.get(cur, []) if n in stuck), None)
            if nxt is None or nxt in path:
                if nxt is not None:
                    path.append(nxt)
                break
            path.append(nxt)
            cur = nxt
        raise DependencyCycleError(
            "These cells depend on each other in a loop, so none of them can run: " + " -> ".join(path)
            + ". Remove one of the references to break the loop."
        )
    return order


def inline_cell_ctes(block: dict, blocks_by_id: dict[str, dict], deps: dict[str, list[str]]) -> tuple[str, list[tuple[str, str]]]:
    """(the cell's SQL with {{cell:name}} replaced by the bare CTE name,
    [(name, source sql), ...] in dependency order, transitively). The
    source SQL keeps its own {{param}} references - the whole statement is
    bound once afterwards, so a parameter means the same thing in every
    cell."""
    by_name = {_cell_name(b): b for b in blocks_by_id.values() if b.get("type") == "sql" and _cell_name(b)}
    ctes: list[tuple[str, str]] = []
    seen: set[str] = set()

    def visit(b: dict) -> str:
        sql = warehouse_tables.strip_trailing_semicolon(b.get("sql") or "")

        def repl(m):
            nm = m.group(1)
            src = by_name.get(nm)
            if not src:
                raise ParameterError(f"The cell \"{nm}\" does not exist on this page (referenced as {{{{cell:{nm}}}}}).")
            if src["id"] not in seen:
                seen.add(src["id"])
                body = visit(src)
                ctes.append((nm, body))
            return nm

        return _CELL_REF_RE.sub(repl, sql)

    main = visit(block)
    return main, ctes


def compile_sql_cell(
    ds, block: dict, blocks_by_id: dict[str, dict], deps: dict[str, list[str]], values: dict, param_defs: dict,
    schema=None, versions=None, row_limit: int | None = None,
) -> dict:
    """{"sql", "params", "parameters", "error"} for a SQL cell: the
    statement with its cell references inlined as CTEs, the saved-query
    versions wrapped in front, every parameter reference bound, and the
    row cap applied (`SELECT * FROM (...) LIMIT n`). Never raises."""
    raw = block.get("sql") or ""
    if not isinstance(raw, str) or not raw.strip():
        return {"sql": "", "params": None, "parameters": [], "error": "This SQL cell is empty - write a SELECT first."}
    try:
        main, cell_ctes = inline_cell_ctes(block, blocks_by_id, deps)
        all_ctes = version_ctes(versions) + cell_ctes
        wrapped = warehouse_exec.wrap_ctes(main, all_ctes) if all_ctes else warehouse_tables.strip_trailing_semicolon(main)
        bound, params, used, unfiltered = bind_parameters_detailed(wrapped, values, ds.kind, param_defs, schema)
        assert_read_only_sql(bound)
        if row_limit:
            bound = warehouse_tables.sample_sql(ds.kind, bound, row_limit)
    except (ParameterError, warehouse_tables.CteConflict) as e:
        return {"sql": "", "params": None, "parameters": referenced_parameters(raw), "unfiltered_parameters": [], "error": str(e)}
    except Exception as e:
        return {"sql": "", "params": None, "parameters": referenced_parameters(raw), "unfiltered_parameters": [], "error": str(e)}
    return {"sql": bound, "params": params, "parameters": used, "unfiltered_parameters": unfiltered, "error": None}


_YEAR_NAME_RE = re.compile(r"(^|_)(year|yr)(_|$)")


def _infer_shape(columns: list[dict], rows: list[dict]) -> tuple[list[str], list[str], str | None]:
    """(dimensions, measures, time_column) for a raw result: numeric
    columns are measures, the rest dimensions; the first datetime-typed
    (or period/date-named) column is the time column."""
    dims, measures, time_col = [], [], None
    for c in columns:
        name, dtype = c["name"], str(c.get("type") or "").lower()
        sample = next((r.get(name) for r in rows[:50] if r.get(name) is not None), None)
        is_num = any(k in dtype for k in ("int", "float", "decimal", "numeric", "double")) or (
            isinstance(sample, (int, float)) and not isinstance(sample, bool)
        )
        is_time = "datetime" in dtype or "date" in dtype or "timestamp" in dtype or name.lower() in ("period", "month", "week", "day", "date", "year", "quarter")
        if is_time and time_col is None:
            time_col = name
            continue
        # 2026-10-07 (real end-to-end run): a whole-number column named as a
        # year ("arrival_date_year": 2015, 2016, 2017) is something to group
        # by, not something to add up. As a measure it was printed "2,015"
        # in the cell's result and offered as the VALUE of a chart bound to
        # the cell.
        is_year = (
            is_num and bool(_YEAR_NAME_RE.search(name.lower()))
            and isinstance(sample, (int, float)) and not isinstance(sample, bool)
            and float(sample).is_integer() and 1000 <= sample <= 2999
        )
        (measures if is_num and not is_year else dims).append(name)
    return dims, measures, time_col


def _sql_cell_result(job: _Job, ds, compiled: dict, block: dict, limit: int | None) -> dict:
    result = _materialize(job, ds, limit, compiled["sql"])
    dims, measures, time_col = _infer_shape(result.get("columns") or [], result.get("rows") or [])
    result.update({
        "kind": "sql", "name": _cell_name(block), "computed_in": ds.kind, "dimensions": dims, "measures": measures,
        "time_column": time_col, "exact_total_rows": None, "spec": None, "prior": None, "delta": None, "sparkline": None,
        "period": None, "date_range": None, "filters_applied": [], "parameters": compiled.get("parameters") or [],
        "missing_parameters": compiled.get("missing_parameters") or [],
    })
    return result


def _sql_cell_error(ds, compiled: dict, block: dict, status: str = "invalid_sql") -> dict:
    return {
        "status": status, "error": compiled.get("error"), "columns": [], "rows": [], "row_count": 0,
        "truncated": False, "sql": compiled.get("sql") or "", "bytes_scanned": None, "duration_ms": 0, "cached": False,
        "computed_in": ds.kind, "ran_at": datetime.utcnow().isoformat() + "Z", "dimensions": [], "measures": [],
        "time_column": None, "exact_total_rows": None, "prior": None, "delta": None, "sparkline": None, "spec": None,
        "period": None, "date_range": None, "filters_applied": [], "kind": "sql", "name": _cell_name(block),
        "parameters": compiled.get("parameters") or [], "missing_parameters": compiled.get("missing_parameters") or [],
    }


def validate_sql_cell(
    ds, sql: str, dashboard_parameters, versions=None, cells: list[dict] | None = None, name: str | None = None,
    block_id: str | None = None,
) -> dict:
    """Zero-row validation of a SQL cell inside the warehouse with its
    parameters bound to their defaults (NULL / an empty array when a
    parameter has no default): {"ok", "sql", "columns", "estimated_bytes",
    "parameters", "cells", "error"}. Nothing is read, nothing billed.
    `cells` are the OTHER sql cells on the page ({id, type, sql, name});
    `name`/`block_id` identify this one so a loop through it is caught."""
    values, defs = resolve_parameter_values(dashboard_parameters)
    schema, _ = schema_with_aliases(ds, versions)
    probe = {"id": block_id or "__probe__", "type": "sql", "sql": sql, "name": name}
    others = [b for b in (cells or []) if b.get("type") == "sql" and b.get("id") != probe["id"]]
    blocks_by_id = {b["id"]: b for b in others}
    blocks_by_id[probe["id"]] = probe
    deps = dependency_graph(list(blocks_by_id.values()))
    try:
        topological_order(deps)
    except DependencyCycleError as e:
        return {"ok": False, "sql": None, "columns": [], "estimated_bytes": None, "parameters": referenced_parameters(sql),
                "cells": referenced_cells(sql), "error": str(e)}
    compiled = compile_sql_cell(ds, probe, blocks_by_id, deps, values, defs, schema, versions)
    if compiled["error"]:
        return {"ok": False, "sql": None, "columns": [], "estimated_bytes": None, "parameters": compiled["parameters"],
                "cells": referenced_cells(sql), "error": compiled["error"]}
    try:
        columns, estimated = warehouse_exec.describe_sql(ds, compiled["sql"], params=compiled["params"] or None)
    except Exception as e:
        print(f"[dashboard_engine] {ds.kind} SQL cell failed validation: {e}")
        return {"ok": False, "sql": compiled["sql"], "columns": [], "estimated_bytes": None, "parameters": compiled["parameters"],
                "cells": referenced_cells(sql), "error": warehouse_exec.clean_warehouse_error(e)}
    return {"ok": True, "sql": compiled["sql"], "columns": columns, "estimated_bytes": estimated,
            "parameters": compiled["parameters"], "cells": referenced_cells(sql), "error": None}


def run_page(
    db: Session, ds, blocks: list[dict], page_filters=None, period: str | None = None, date_range=None,
    user_id: str | None = None, date_column: str | None = None, versions=None, block_filters: dict | None = None,
    force_refresh: bool = False, count_table: str | None = None, default_period: str | None = None,
    max_parallel: int | None = None, parameters: dict | None = None, dashboard_parameters: list | None = None,
) -> dict:
    """Runs every block in `blocks` under the page's filters. One batch:
    every distinct (SQL, params) runs once, concurrently up to
    DASHBOARD_RUN_MAX_PARALLEL, cache hits never touch the warehouse.

    `blocks` entries: {"id", "spec"} (a spec block - the page filters,
    period and date range are pushed down), {"id", "type": "sql", "sql",
    "name"} (a SQL cell - parameters bound, nothing pushed down) or
    {"id", "type", "source_block_id"} (rendered from another block's
    result). `parameters` is the viewer's {name: value} for the rail;
    `dashboard_parameters` the dashboard's parameter definitions.

    Returns {"blocks": {id: BlockResult}, "matched_rows", "total_rows",
    "computed_in", "total_duration_ms", "period", "date_range",
    "dependencies", "order", "parameters_used", "missing_parameters"}.
    Raises DependencyCycleError when cells form a loop."""
    started = time.perf_counter()
    grain = normalize_period(period, default_period)
    if versions is None:
        versions = load_versions(db, ds)
    blocks = [dict(b) for b in blocks if b.get("id")]
    for b in blocks:
        if not b.get("type"):
            b["type"] = "sql" if b.get("sql") else ("derived" if b.get("source_block_id") else "spec")
    blocks_by_id = {b["id"]: b for b in blocks}
    deps = dependency_graph(blocks)
    order = topological_order(deps)
    values, defs = resolve_parameter_values(dashboard_parameters, parameters, date_range)
    missing = [n for n, v in values.items() if v is None]
    schema, _aliases = schema_with_aliases(ds, versions)

    compiled: dict[str, Compiled] = {}
    sql_compiled: dict[str, dict] = {}
    jobs: list[_Job] = []
    per_block: dict[str, tuple[_Job, _Job | None, _Job | None]] = {}
    sql_jobs: dict[str, _Job] = {}
    for b in blocks:
        bid = b["id"]
        if b.get("type") == "sql":
            c = compile_sql_cell(ds, b, blocks_by_id, deps, values, defs, schema, versions,
                                 row_limit=settings.DASHBOARD_MAX_BLOCK_ROWS)
            # A parameter whose empty selection reads as "all" in this cell
            # (see bind_parameters_detailed) is not one the cell waits for.
            c["missing_parameters"] = [
                n for n in c.get("parameters") or [] if n in missing and n not in (c.get("unfiltered_parameters") or [])
            ]
            sql_compiled[bid] = c
            if c["error"]:
                continue
            job = _Job(key=f"{bid}:main", sql=c["sql"], params=c["params"] or None)
            sql_jobs[bid] = job
            jobs.append(job)
            continue
        if b.get("source_block_id"):
            continue
        spec = b.get("spec")
        edges = None
        if isinstance(spec, dict) and spec.get("bins"):
            edges, edge_error = resolve_bin_edges(db, ds, spec, versions, user_id, force_refresh=force_refresh)
            if edge_error:
                compiled[bid] = Compiled(spec=spec, sql="", error=edge_error, period=grain, date_range=qb.normalize_date_range(date_range))
                continue
        c = compile_block(
            ds, spec, page_filters, grain, date_range, date_column, versions,
            block_filters=(block_filters or {}).get(bid), default_period=default_period, bin_edges=edges,
        )
        compiled[bid] = c
        if c.error:
            continue
        main = _Job(key=f"{bid}:main", sql=c.sql)
        prior = _Job(key=f"{bid}:prior", sql=c.prior_sql) if c.prior_sql else None
        spark = _Job(key=f"{bid}:spark", sql=c.sparkline_sql) if c.sparkline_sql else None
        per_block[bid] = (main, prior, spark)
        jobs.extend(j for j in (main, prior, spark) if j is not None)

    count_job = None
    count_sql = None
    total_job = None
    total_sql = None
    if count_table:
        try:
            count_sql = qb.build_count_sql(
                count_table, ds.kind, schema, ds.connection_info or {}, _aliases,
                extra_filters=normalize_page_filters(page_filters), date_range=qb.normalize_date_range(date_range),
                date_column=date_column,
            )
            count_sql = warehouse_exec.wrap_ctes(count_sql, version_ctes(versions))
            count_job = _Job(key="page:count", sql=count_sql)
            jobs.append(count_job)
            # 2026-10-07 (real end-to-end run): the "of N rows" half of the
            # rail's "Showing 37,518 of 119,386 rows". It used to come ONLY
            # from the Data tab's profile cache (5 minutes, in-process), so
            # for anyone who had not just opened that tab - every public
            # viewer, every owner after a deploy - total_rows was null and
            # the page printed the filtered count twice ("Showing 37,518 of
            # 37,518 rows · 1 filter"). When the profile has no number, the
            # same COUNT(*) without the page's filters supplies it: on an
            # unfiltered run it IS the count query (one job, not two), and
            # on a filtered run it is normally a result-cache hit from the
            # unfiltered load that preceded it.
            if cached_exact_total_rows(ds.id, count_table) is None:
                total_sql = warehouse_exec.wrap_ctes(
                    qb.build_count_sql(count_table, ds.kind, schema, ds.connection_info or {}, _aliases),
                    version_ctes(versions),
                )
                if total_sql == count_sql:
                    total_job = count_job
                else:
                    total_job = _Job(key="page:total", sql=total_sql)
                    jobs.append(total_job)
        except Exception as e:
            print(f"[dashboard_engine] matched_rows count could not be compiled (non-fatal): {e}")

    budget_exhausted = bool(jobs) and warehouse_exec.daily_budget_exhausted(db, ds, user_id)
    _execute_jobs(db, ds, user_id, jobs, force_refresh=force_refresh, budget_exhausted=budget_exhausted,
                  max_parallel=max_parallel)

    out: dict[str, dict] = {}
    for bid in order:
        b = blocks_by_id[bid]
        if b.get("type") == "sql":
            c = sql_compiled[bid]
            if c["error"]:
                out[bid] = _sql_cell_error(ds, c, b)
            else:
                out[bid] = _sql_cell_result(sql_jobs[bid], ds, c, b, settings.DASHBOARD_MAX_BLOCK_ROWS)
            continue
        src = b.get("source_block_id")
        if src:
            source = out.get(src)
            if source is None:
                out[bid] = {
                    **_sql_cell_error(ds, {"error": f"The cell this block reads from ({src}) is not on this page."}, b, status="error"),
                    "kind": "derived", "source_block_id": src, "name": None,
                }
            else:
                out[bid] = {**source, "kind": "derived", "source_block_id": src}
            continue
        c = compiled.get(bid)
        if c is None:
            continue
        if c.error:
            out[bid] = _invalid_result(c, ds)
            continue
        main, prior, spark = per_block[bid]
        out[bid] = _assemble(c, ds, main, prior, spark)
        # A time series: mark partial buckets; forecast when the block asks.
        options = forecast_svc.normalize_options(b.get("forecast"), c.period) if b.get("forecast") else None
        if out[bid].get("status") == "ok" and (c.spec.get("time") or (options and out[bid].get("sparkline"))):
            known_cols = {col["name"] for col in qb.table_columns(schema, c.spec.get("table")) or []}
            tcol = c.spec["time"]["column"] if c.spec.get("time") else (
                date_column if (date_column and date_column in known_cols) else None)
            bounds = None
            if tcol:
                bounds = column_bounds(db, ds, c.spec["table"], [tcol], user_id=user_id, versions=versions).get(tcol)
            attach_time_analysis(out[bid], c.spec, c.period, bounds, c.date_range, options, formats=b.get("formats"))

    def _count_value(job, sql) -> int | None:
        if job is None:
            return None
        count_result = _materialize(job, ds, None, sql)
        if count_result.get("status") == "ok" and count_result.get("rows"):
            row = {str(k).lower(): v for k, v in count_result["rows"][0].items()}
            v = row.get(COUNT_ALIAS)
            if v is None and row:
                v = next(iter(row.values()))
            try:
                return int(v) if v is not None else None
            except (TypeError, ValueError):
                return None
        return None

    matched_rows = _count_value(count_job, count_sql)
    total_rows = cached_exact_total_rows(ds.id, count_table) if count_table else None
    if total_rows is None and total_job is not None:
        total_rows = matched_rows if total_job is count_job else _count_value(total_job, total_sql)
    # A block's own "computed over N rows" comes from the same profile
    # cache; when that was cold, a block on the counted table takes the
    # page's count instead of leaving the footer without one.
    if total_rows is not None:
        for bid, c in compiled.items():
            r = out.get(bid)
            if r is not None and not c.error and r.get("exact_total_rows") is None and (c.spec or {}).get("table") == count_table:
                r["exact_total_rows"] = total_rows

    referenced = {n for c in sql_compiled.values() for n in (c.get("parameters") or [])}
    waiting = {n for c in sql_compiled.values() for n in (c.get("missing_parameters") or [])}
    return {
        "blocks": out,
        "matched_rows": matched_rows,
        "total_rows": total_rows,
        "computed_in": ds.kind,
        "total_duration_ms": int((time.perf_counter() - started) * 1000),
        "period": grain,
        "date_range": qb.normalize_date_range(date_range),
        "budget_exhausted": budget_exhausted,
        "dependencies": {bid: list(needs) for bid, needs in deps.items() if needs},
        "order": order,
        "parameters_used": {n: values[n] for n in values if n in referenced},
        "missing_parameters": [n for n in missing if n in waiting],
    }


def run_block(
    db: Session, ds, block_spec: dict, page_filters=None, period: str | None = None, date_range=None,
    user_id: str | None = None, date_column: str | None = None, versions=None, block_filters=None,
    force_refresh: bool = False, default_period: str | None = None,
) -> dict:
    """One block -> BlockResult (see the module docstring)."""
    page = run_page(
        db, ds, [{"id": "block", "spec": block_spec}], page_filters, period, date_range, user_id, date_column,
        versions, block_filters={"block": block_filters} if block_filters else None, force_refresh=force_refresh,
        default_period=default_period,
    )
    return page["blocks"]["block"]


# --- parameter options ------------------------------------------------------

def distinct_values(
    db: Session, ds, table: str, column: str, user_id: str | None = None, search: str | None = None,
    limit: int = 50, versions=None, page_filters=None, force_refresh: bool = False,
) -> dict:
    """[{value, count}] for a filter-rail parameter via ONE `GROUP BY ...
    ORDER BY count DESC LIMIT n` query, cached for
    DASHBOARD_OPTIONS_CACHE_TTL_SECONDS. `search` narrows case-
    insensitively (the country search box); `page_filters` (the other
    active filters) narrow the counts. Never raises for a warehouse
    failure - the result carries `error`."""
    if versions is None:
        versions = load_versions(db, ds)
    schema, aliases = schema_with_aliases(ds, versions)
    search = (search or "").strip()[:100] or None
    try:
        sql = qb.build_distinct_values_sql(
            table, column, ds.kind, schema, ds.connection_info or {}, aliases, search=search, limit=limit,
            extra_filters=[f for f in normalize_page_filters(page_filters) if f.get("column") != column],
        )
        sql = warehouse_exec.wrap_ctes(sql, version_ctes(versions))
    except Exception as e:
        return {"column": column, "table": table, "search": search, "values": [], "truncated": False, "cached": False,
                "error": str(e), "sql": ""}
    key = cache_key(ds.id, sql)
    if not force_refresh:
        hit = _options_cache.get(key)
        if hit is not None:
            return {**hit, "cached": True}
    if warehouse_exec.daily_budget_exhausted(db, ds, user_id):
        return {"column": column, "table": table, "search": search, "values": [], "truncated": False, "cached": False,
                "error": "Today's warehouse scan budget for your account is used up.", "sql": sql}
    res = warehouse_exec.execute_sql(db, ds, user_id, sql)
    if "df" not in res:
        return {"column": column, "table": table, "search": search, "values": [], "truncated": False, "cached": False,
                "error": res["attempt"].get("error"), "sql": sql}
    df = res["df"]
    values: list[dict] = []
    cols = [str(c).lower() for c in df.columns]
    for row in df.itertuples(index=False, name=None):
        rec = dict(zip(cols, row))
        v = rec.get("value", row[0] if row else None)
        n = rec.get("count", row[1] if len(row) > 1 else None)
        try:
            n = int(n) if n is not None else None
        except (TypeError, ValueError):
            n = None
        values.append({"value": _json_scalar(v), "count": n})
    result = {"column": column, "table": table, "search": search, "values": values, "truncated": len(values) >= limit,
              "error": None, "sql": sql, "bytes_scanned": res.get("bytes_scanned")}
    _options_cache.put(key, result)
    return {**result, "cached": False}


def _iso_day(v) -> str | None:
    """A MIN/MAX result as "YYYY-MM-DD", or None when it is not a date."""
    text = _json_scalar(v)
    if isinstance(text, str) and len(text) >= 10 and _ISO_DATE_RE.match(text[:10]):
        return text[:10]
    return None


def column_bounds(
    db: Session, ds, table: str, columns: list[str], user_id: str | None = None, versions=None,
    force_refresh: bool = False,
) -> dict:
    """{column: {"min": "YYYY-MM-DD", "max": "YYYY-MM-DD"}} - the real
    first and last date of each of `columns` in `table`, via ONE
    `SELECT MIN(..), MAX(..)` query cached for
    DASHBOARD_OPTIONS_CACHE_TTL_SECONDS (a failed read is cached too, so
    a broken column is not retried on every run). A column that is not in
    the table, or whose values are not dates, is left out. Never raises."""
    columns = [c for c in (columns or []) if isinstance(c, str) and c]
    if not table or not columns:
        return {}
    if versions is None:
        versions = load_versions(db, ds)
    schema, aliases = schema_with_aliases(ds, versions)
    try:
        sql, present = qb.build_column_bounds_sql(table, columns, ds.kind, schema, ds.connection_info or {}, aliases)
        sql = warehouse_exec.wrap_ctes(sql, version_ctes(versions))
    except Exception:
        return {}
    key = cache_key(ds.id, sql)
    if not force_refresh:
        hit = _options_cache.get(key)
        if hit is not None:
            return dict(hit)
    if warehouse_exec.daily_budget_exhausted(db, ds, user_id):
        return {}
    res = warehouse_exec.execute_sql(db, ds, user_id, sql)
    out: dict = {}
    if "df" in res and len(res["df"]):
        row = list(res["df"].iloc[0].tolist())
        for i, column in enumerate(present):
            lo = _iso_day(row[2 * i]) if len(row) > 2 * i else None
            hi = _iso_day(row[2 * i + 1]) if len(row) > 2 * i + 1 else None
            if lo and hi:
                out[column] = {"min": lo, "max": hi}
    else:
        print(f"[dashboard_engine] date bounds could not be read for {table} (non-fatal): {(res.get('attempt') or {}).get('error')}")
    _options_cache.put(key, out)
    return dict(out)


# --- validation -------------------------------------------------------------

def validate_spec_in_warehouse(ds, block_spec: dict, versions=None, date_column: str | None = None) -> dict:
    """Validates a spec twice: structurally (query_builder, strict) and
    then inside the warehouse with the connector's zero-row validation
    (nothing read, nothing billed). Returns {"ok", "spec", "sql",
    "columns", "estimated_bytes", "error"}. The SQL stored as
    DashboardBlock.query_sql is this one - the spec's own query with no
    page filters."""
    schema, aliases = schema_with_aliases(ds, versions)
    try:
        sql, spec = qb.build_block_sql(block_spec, ds.kind, schema, ds.connection_info or {}, aliases,
                                       date_column=date_column)
        sql = warehouse_exec.wrap_ctes(sql, version_ctes(versions))
    except Exception as e:
        return {"ok": False, "spec": None, "sql": None, "columns": [], "estimated_bytes": None, "error": str(e)}
    try:
        columns, estimated = warehouse_exec.describe_sql(ds, sql)
    except Exception as e:
        print(f"[dashboard_engine] {ds.kind} spec failed validation: {e}")
        return {"ok": False, "spec": spec, "sql": sql, "columns": [], "estimated_bytes": None,
                "error": warehouse_exec.clean_warehouse_error(e)}
    return {"ok": True, "spec": spec, "sql": sql, "columns": columns, "estimated_bytes": estimated, "error": None}
