"""
Column-level data profiling (2026-10-05): one aggregate SQL query, run
once against the FULL table at the data source itself, that answers "what
does the whole dataset actually look like" without ever pulling its rows
into this app's own memory - the same idea Google's own BigQuery/Dataplex
data-profiling feature uses (null %, distinct count, min/max per column,
computed server-side over the real table, not a sample) - see
routers/datasources.py's `/profile` endpoint, which is what calls this.

This supplements, never replaces, routers/datasources.py's existing
`_column_stats` - that one is free (it runs over a dataframe the preview
endpoint already has in memory) but is capped to whatever
settings.PREVIEW_ROW_LIMIT allowed in, so on a live-connector source
(BigQuery/Snowflake/SQL) it describes only a SAMPLE, not the real table.
`_column_stats` stays exactly as it is and is still what file-based
sources (CSV/Excel) use, since their whole file is already fully loaded
anyway - this module only matters for the live-connector kinds where a
sample and the real table can genuinely differ.

Deliberately conservative in which aggregates it computes: COUNT(*),
COUNT(col) [non-null], COUNT(DISTINCT col), MIN(col), MAX(col) - every one
of these is valid SQL for ANY column type (text/numeric/date/boolean) on
every SQL dialect this app supports (Postgres/MySQL/SQL Server/Snowflake/
BigQuery), so ONE query can safely cover every column without first
needing to trust each column's reported type across five different
dialects. AVG is deliberately left out: it would need real type-awareness
to avoid erroring on a non-numeric column, and null%/distinct/min/max
already delivers the "shape of the whole dataset" value this exists for.
"""
from __future__ import annotations

import json

import pandas as pd

# A very wide table would otherwise build one enormous SELECT list (4
# aggregates per column) in a single query - profiling the first N
# columns is an honest, visible degradation (the caller marks
# `truncated_columns: true`), not a silent gap or a reason to fail the
# whole profile.
MAX_PROFILE_COLUMNS = 40

_IDENT_QUOTERS = {
    "mysql": lambda n: f"`{n}`",
    "bigquery": lambda n: f"`{n}`",
    "sqlserver": lambda n: f"[{n}]",
}


def _quote_ident(kind: str, name: str) -> str:
    quoter = _IDENT_QUOTERS.get(kind)
    if quoter:
        return quoter(name.replace("`", "").replace("[", "").replace("]", ""))
    # ANSI-standard double-quote identifier - Postgres/Supabase/Snowflake.
    return '"' + name.replace('"', '""') + '"'


def _from_target(kind: str, table: str | None, from_clause: str | None) -> str:
    """What goes after FROM: the quoted table name, or - 2026-10-06
    ("generated data is a saved query" layer) - an already-rendered
    derived table such as `(<query_sql body>) AS gd360_v` passed verbatim
    as `from_clause`, so a saved-query DatasetVersion is profiled by
    running its definition inside the warehouse, exactly like a real
    table (see warehouse_tables.subquery_from_clause; its WITH prefix, if
    any, is prepended by the caller to the finished statement)."""
    if from_clause:
        return from_clause
    if not table:
        raise ValueError("build_profile_query needs a table name or a from_clause")
    return _quote_ident(kind, table)


def build_profile_query(
    kind: str, table: str | None, columns: list[str], from_clause: str | None = None,
) -> tuple[str, list[str]]:
    """Builds ONE aggregate query that profiles every column in `columns`
    (capped at MAX_PROFILE_COLUMNS) in a single pass over the table, so
    profiling cost is one table scan no matter how many columns are
    profiled - never one query per column. Returns (sql, profiled_columns)
    - profiled_columns is `columns` capped to MAX_PROFILE_COLUMNS, in the
    same order the SELECT list's aliases are built in, so the caller can
    zip the result row back to real column names positionally.
    `from_clause` (optional) replaces the table - see _from_target."""
    cols = columns[:MAX_PROFILE_COLUMNS]
    table_q = _from_target(kind, table, from_clause)
    select_parts = ["COUNT(*) AS gd360_total_rows"]
    for i, col in enumerate(cols):
        col_q = _quote_ident(kind, col)
        select_parts.append(f"COUNT({col_q}) AS gd360_c{i}_nonnull")
        select_parts.append(f"COUNT(DISTINCT {col_q}) AS gd360_c{i}_distinct")
        select_parts.append(f"MIN({col_q}) AS gd360_c{i}_min")
        select_parts.append(f"MAX({col_q}) AS gd360_c{i}_max")
    sql = "SELECT " + ", ".join(select_parts) + f" FROM {table_q}"
    return sql, cols


def _jsonify_scalar(v):
    """Mirrors routers/datasources.py's own `_jsonify_scalar` closely
    enough for this module's narrower needs (a profiling MIN/MAX is never
    a complex/nested type) without importing a router module from a
    service module."""
    if v is None:
        return None
    if isinstance(v, pd.Timestamp):
        return None if pd.isna(v) else v.isoformat()
    if isinstance(v, float) and pd.isna(v):
        return None
    if isinstance(v, (str, int, float, bool)):
        return v
    return str(v)


def _lower_keys(row: dict) -> dict:
    """Result-column names are looked up case-insensitively: Snowflake
    folds an unquoted alias like `gd360_c0_nonnull` to upper case in its
    result metadata (so fetch_pandas_all hands back `GD360_C0_NONNULL`),
    while every other dialect here keeps it as written. Lower-casing the
    keys once makes every positional lookup below dialect-proof."""
    return {str(k).lower(): v for k, v in (row or {}).items()}


def parse_profile_row(row: dict, columns: list[str], total_rows: int) -> dict:
    """Turns the single aggregate result row back into a per-column stats
    dict, keyed by real column name - the shape the `/profile` endpoint
    hands straight to the frontend's profile strip."""
    row = _lower_keys(row)
    out: dict = {}
    for i, col in enumerate(columns):
        nonnull = row.get(f"gd360_c{i}_nonnull")
        distinct = row.get(f"gd360_c{i}_distinct")
        nonnull_int = int(nonnull) if nonnull is not None and not pd.isna(nonnull) else None
        out[col] = {
            "non_null": nonnull_int,
            "null_pct": (
                round(100 * (1 - nonnull_int / total_rows), 1)
                if total_rows and nonnull_int is not None else None
            ),
            "distinct": int(distinct) if distinct is not None and not pd.isna(distinct) else None,
            "min": _jsonify_scalar(row.get(f"gd360_c{i}_min")),
            "max": _jsonify_scalar(row.get(f"gd360_c{i}_max")),
        }
    return out


# ---------------------------------------------------------------------------
# Top values (2026-10-06, profile-first Data tab): for every profiled
# column whose COUNT(DISTINCT) came back small (1..TOP_VALUES_MAX_DISTINCT),
# the three most common values with their row counts - what turns a
# "hotel: 2 distinct" line into "City Hotel 66% · Resort Hotel 34%". ONE
# extra query per profile run, never one per column, built per dialect:
#
#   BigQuery   SELECT APPROX_TOP_COUNT(`col`, 3) AS gd360_c0_top, ... FROM t
#   Snowflake  SELECT APPROX_TOP_K("col", 3)     AS gd360_c0_top, ... FROM t
#   Postgres / Supabase / MySQL / SQL Server: a UNION ALL of one small
#              derived table per column, each GROUP BY col ORDER BY count
#              DESC capped to 3 rows (LIMIT 3, or TOP 3 on SQL Server),
#              every value CAST to the dialect's text type so the branches
#              are union-compatible regardless of each column's real type.
#
# Only columns the first profile query ALREADY proved low-cardinality are
# included, so this second query is bounded by the number of category-
# like columns, not the table's width - and on BigQuery it is a second
# billable scan, which the caller logs/meters exactly like the first one.
# Any failure of this query is non-fatal to the profile as a whole (see
# routers/datasources.py profile_datasource).
# ---------------------------------------------------------------------------
TOP_VALUES_LIMIT = 3
TOP_VALUES_MAX_DISTINCT = 50

_TEXT_CAST_TYPES = {
    "mysql": "CHAR",
    "sqlserver": "NVARCHAR(MAX)",
}


def _sql_string_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def build_top_values_query(
    kind: str, table: str | None, columns: list[str], from_clause: str | None = None,
) -> tuple[str | None, list[str]]:
    """Builds the ONE top-values query for `columns` (capped at
    MAX_PROFILE_COLUMNS, like build_profile_query). Returns (sql, columns)
    - sql is None when there is nothing to ask for (no eligible columns)
    or the dialect is not one this knows how to build for, so the caller
    can simply skip the second query. `from_clause` (optional) replaces
    the table - see _from_target; on the UNION ALL dialects it is repeated
    once per branch, which is still one statement."""
    cols = [c for c in columns if c][:MAX_PROFILE_COLUMNS]
    if not cols:
        return None, []
    table_q = _from_target(kind, table, from_clause)
    n = TOP_VALUES_LIMIT

    if kind == "bigquery":
        parts = [f"APPROX_TOP_COUNT({_quote_ident(kind, c)}, {n}) AS gd360_c{i}_top" for i, c in enumerate(cols)]
        return "SELECT " + ", ".join(parts) + f" FROM {table_q}", cols

    if kind == "snowflake":
        parts = [f"APPROX_TOP_K({_quote_ident(kind, c)}, {n}) AS gd360_c{i}_top" for i, c in enumerate(cols)]
        return "SELECT " + ", ".join(parts) + f" FROM {table_q}", cols

    if kind in ("postgres", "supabase", "mysql", "sqlserver"):
        text_type = _TEXT_CAST_TYPES.get(kind, "TEXT")
        branches = []
        for i, c in enumerate(cols):
            col_q = _quote_ident(kind, c)
            label = _sql_string_literal(c)
            if kind == "sqlserver":
                inner = (
                    f"SELECT TOP {n} {label} AS gd360_col, CAST({col_q} AS {text_type}) AS gd360_val, "
                    f"COUNT(*) AS gd360_n FROM {table_q} WHERE {col_q} IS NOT NULL "
                    f"GROUP BY {col_q} ORDER BY gd360_n DESC"
                )
            else:
                inner = (
                    f"SELECT {label} AS gd360_col, CAST({col_q} AS {text_type}) AS gd360_val, "
                    f"COUNT(*) AS gd360_n FROM {table_q} WHERE {col_q} IS NOT NULL "
                    f"GROUP BY {col_q} ORDER BY gd360_n DESC LIMIT {n}"
                )
            # Every branch is its own parenthesised, aliased derived table
            # (MySQL rejects a bare "SELECT ... LIMIT n UNION ALL SELECT ...
            # LIMIT n" and requires exactly this form; it is also valid on
            # Postgres and SQL Server, so one shape serves all four).
            branches.append(f"SELECT * FROM ({inner}) AS gd360_t{i}")
        return " UNION ALL ".join(branches), cols

    return None, []


def _as_entries(cell) -> list[tuple]:
    """Normalises one BigQuery/Snowflake top-values cell into a list of
    (value, count) pairs. BigQuery's APPROX_TOP_COUNT arrives through
    to_dataframe() as an array of {'value': ..., 'count': ...} structs;
    Snowflake's APPROX_TOP_K arrives as a VARIANT - a JSON string (or an
    already-parsed list) of [value, count] pairs."""
    if cell is None:
        return []
    if isinstance(cell, str):
        try:
            cell = json.loads(cell)
        except Exception:
            return []
    if isinstance(cell, float) and pd.isna(cell):
        return []
    try:
        items = list(cell)
    except TypeError:
        return []
    out: list[tuple] = []
    for item in items:
        if isinstance(item, dict):
            out.append((item.get("value"), item.get("count")))
        elif isinstance(item, (list, tuple)) and len(item) >= 2:
            out.append((item[0], item[1]))
    return out


def parse_top_values(kind: str, result_df: pd.DataFrame, columns: list[str], total_rows: int) -> dict:
    """Turns the top-values query result back into
    {column: [{value, count, pct}, ...]} (at most TOP_VALUES_LIMIT entries
    per column, most common first, NULL values dropped - the profile's
    null_pct already covers those). pct is against `total_rows` (the
    exact COUNT(*) from the main profile query) so it reads as "share of
    ALL rows", consistent with the empty-cell percentages next to it."""
    per_col: dict[str, list[tuple]] = {c: [] for c in columns}
    if result_df is None or not len(result_df):
        return {}

    if kind in ("bigquery", "snowflake"):
        row = _lower_keys(result_df.iloc[0].to_dict())
        for i, col in enumerate(columns):
            per_col[col] = _as_entries(row.get(f"gd360_c{i}_top"))
    else:
        rows = result_df.to_dict(orient="records")
        for raw in rows:
            r = _lower_keys(raw)
            col = r.get("gd360_col")
            if col in per_col:
                per_col[col].append((r.get("gd360_val"), r.get("gd360_n")))

    out: dict = {}
    for col, entries in per_col.items():
        cleaned = []
        for value, count in entries:
            if value is None or (isinstance(value, float) and pd.isna(value)):
                continue
            try:
                count_int = int(count)
            except (TypeError, ValueError):
                continue
            cleaned.append({
                "value": _jsonify_scalar(value),
                "count": count_int,
                "pct": round(100 * count_int / total_rows, 1) if total_rows else None,
            })
        cleaned.sort(key=lambda e: -e["count"])
        if cleaned:
            out[col] = cleaned[:TOP_VALUES_LIMIT]
    return out


def profile_dataframe(df: pd.DataFrame, max_columns: int = 200) -> dict:
    """2026-10-06 (pro local-file Data tab): the pandas counterpart of
    build_profile_query + parse_profile_row for a CSV/Excel upload - the
    same per-column shape (type, non_null, null_pct, distinct, min, max,
    top_values for columns with <= TOP_VALUES_MAX_DISTINCT distinct
    values), computed in-process over the WHOLE frame, which for a file is
    complete data rather than a sample. Returns `computed_in: "gd360"` and
    never a bytes_scanned/cost key. The implementation lives in
    services/file_import.py next to the import pipeline whose type fixes
    it reports (`mixed_types`); this is the profiling-module entry point."""
    from .file_import import profile_dataframe as _impl

    return _impl(df, max_columns=max_columns, top_values_max_distinct=TOP_VALUES_MAX_DISTINCT, top_values_limit=TOP_VALUES_LIMIT)
