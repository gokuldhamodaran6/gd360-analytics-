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


def build_profile_query(kind: str, table: str, columns: list[str]) -> tuple[str, list[str]]:
    """Builds ONE aggregate query that profiles every column in `columns`
    (capped at MAX_PROFILE_COLUMNS) in a single pass over the table, so
    profiling cost is one table scan no matter how many columns are
    profiled - never one query per column. Returns (sql, profiled_columns)
    - profiled_columns is `columns` capped to MAX_PROFILE_COLUMNS, in the
    same order the SELECT list's aliases are built in, so the caller can
    zip the result row back to real column names positionally."""
    cols = columns[:MAX_PROFILE_COLUMNS]
    table_q = _quote_ident(kind, table)
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


def parse_profile_row(row: dict, columns: list[str], total_rows: int) -> dict:
    """Turns the single aggregate result row back into a per-column stats
    dict, keyed by real column name - the shape the `/profile` endpoint
    hands straight to the frontend's profile strip."""
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
