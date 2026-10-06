"""
Deterministic SQL builder (2026-10-06, warehouse-honesty round).

Turns a small, structured `QueryBuilderSpec` (see schemas_extra.
QueryBuilderSpec - table, group_by, measure, agg, filters, order_by,
limit) into ONE aggregate SQL query for a given warehouse/database kind,
with ZERO language-model involvement. This is the "finish it yourself"
path routers/chat.py offers when the AI pushdown SQL writer could not
turn a question into a query that runs inside the person's warehouse:
rather than ever falling back to analyzing a row-capped sample (the
founder's firm product rule - a warehouse answer is either computed
inside the warehouse over every row, or not computed at all), the person
is shown a builder whose output is this module's SQL.

Safety model - every identifier and value goes through exactly one
chokepoint each, and there is no other way into the query text:
  - Table and column names are only ever accepted if they appear in
    `ds.schema_cache` (the connector's own introspection of the real
    warehouse). An unknown name raises QueryBuilderError - callers turn
    that into HTTP 400. Even then, the accepted name is quoted with the
    dialect's own identifier quoting (profiling._quote_ident, shared with
    the Data tab's profile query so both paths agree on how a name is
    spelled to the warehouse). A name is never interpolated raw.
  - Filter values are rendered as a SQL number only when they genuinely
    parse as one; every other value is a single-quoted string literal
    with embedded quotes doubled ('' - the standard escape every dialect
    here accepts). NULL ops take no value at all. `in` lists are capped
    at MAX_IN_ITEMS.
  - The query is still run through the exact same read-only check,
    cost/budget guards and audit log as AI-written pushdown SQL
    (routers/chat.py) - this builder makes the SQL predictable, it does
    not bypass any guard.

The query shape is deliberately small and readable: SELECT <group
cols>, <one aggregate> FROM <table> [WHERE ...] [GROUP BY ...] [ORDER BY
...] <row cap>. One measure, up to MAX_GROUP_BY grouping columns, a flat
AND-ed filter list. That covers the overwhelming majority of "how much /
how many, by what, for which slice" questions a founder asks; anything
more is what the free-form `raw_sql` path exists for.
"""
from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation

from .profiling import _quote_ident

AGGS = ("count", "sum", "avg", "min", "max", "count_distinct")
OPS = ("=", "!=", ">", ">=", "<", "<=", "is_null", "is_not_null", "in")
NULL_OPS = ("is_null", "is_not_null")
ORDER_BYS = ("measure_desc", "measure_asc", "group")
MAX_GROUP_BY = 3
MAX_IN_ITEMS = 50
MAX_LIMIT = 5000
DEFAULT_LIMIT = 1000
MAX_FILTERS = 20
# Kinds this builder can write SQL for. MongoDB is deliberately absent:
# the builder is SQL-only for now (see routers/chat.py, which returns
# builder_suggestion=None for mongodb).
SQL_KINDS = ("bigquery", "snowflake", "postgres", "mysql", "sqlserver", "supabase")

_NUMBER_RE = re.compile(r"^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$")


class QueryBuilderError(ValueError):
    """A spec that cannot be turned into SQL safely - an unknown table or
    column, a bad op/agg, a malformed filter. The message is written for
    the person (plain language), not for a log."""


# --- schema helpers ---------------------------------------------------------

def table_columns(schema_cache, table: str) -> list[dict] | None:
    """The [{"name", "type"}] column list for `table` straight from a
    multi-table schema_cache ({table_name: [{"name","type"}, ...]}), or
    None if the table is not in it. Tolerates a legacy bare-string column
    entry by giving it a None type."""
    if not isinstance(schema_cache, dict) or not isinstance(table, str):
        return None
    cols = schema_cache.get(table)
    if not isinstance(cols, list):
        return None
    out = []
    for c in cols:
        if isinstance(c, dict) and c.get("name") is not None:
            out.append({"name": str(c["name"]), "type": c.get("type")})
        elif isinstance(c, str):
            out.append({"name": c, "type": None})
    return out


def builder_columns(schema_cache, tables: list[str] | None) -> dict[str, list[dict]]:
    """{table: [{name, type}]} for exactly the given tables (every table
    in schema_cache when `tables` is None) - what routers/chat.py hands
    the frontend as `builder_columns` so its selects can populate without
    a second request."""
    if not isinstance(schema_cache, dict):
        return {}
    names = list(schema_cache.keys()) if tables is None else [t for t in tables if t in schema_cache]
    out: dict[str, list[dict]] = {}
    for t in names:
        cols = table_columns(schema_cache, t)
        if cols:
            out[t] = cols
    return out


# --- validation -------------------------------------------------------------

def _as_spec_dict(spec) -> dict:
    if hasattr(spec, "model_dump"):
        return spec.model_dump()
    if isinstance(spec, dict):
        return dict(spec)
    raise QueryBuilderError("The query builder request was not understood.")


def validate_spec(spec, schema_cache) -> dict:
    """Strict validation for a spec the person submitted: every part must
    be valid or the whole thing is rejected with QueryBuilderError (HTTP
    400 upstream). Returns a normalised plain dict with every field
    present, ready for build_sql."""
    s = _as_spec_dict(spec)
    table = s.get("table")
    cols = table_columns(schema_cache, table) if isinstance(table, str) else None
    if not cols:
        raise QueryBuilderError(
            f"The table {table!r} is not one of this data source's tables. Pick a table from the list."
        )
    known = {c["name"] for c in cols}

    group_by = s.get("group_by") or []
    if not isinstance(group_by, list) or any(not isinstance(g, str) for g in group_by):
        raise QueryBuilderError("Group-by must be a list of column names.")
    if len(group_by) > MAX_GROUP_BY:
        raise QueryBuilderError(f"You can group by at most {MAX_GROUP_BY} columns.")
    seen: set[str] = set()
    deduped: list[str] = []
    for g in group_by:
        if g not in known:
            raise QueryBuilderError(f"The column {g!r} does not exist in {table!r}.")
        if g not in seen:
            seen.add(g)
            deduped.append(g)
    group_by = deduped

    agg = (s.get("agg") or "count")
    if not isinstance(agg, str) or agg.lower() not in AGGS:
        raise QueryBuilderError(f"The aggregation {agg!r} is not supported. Use one of: {', '.join(AGGS)}.")
    agg = agg.lower()

    measure = s.get("measure")
    if measure is not None:
        if not isinstance(measure, str) or measure not in known:
            raise QueryBuilderError(f"The column {measure!r} does not exist in {table!r}.")
    elif agg != "count":
        raise QueryBuilderError(f"{agg.upper()} needs a column to aggregate - pick one, or use count.")

    raw_filters = s.get("filters") or []
    if not isinstance(raw_filters, list):
        raise QueryBuilderError("Filters must be a list.")
    if len(raw_filters) > MAX_FILTERS:
        raise QueryBuilderError(f"At most {MAX_FILTERS} filters are allowed.")
    filters: list[dict] = []
    for f in raw_filters:
        f = _as_spec_dict(f) if not isinstance(f, dict) else f
        column, op, value = f.get("column"), f.get("op"), f.get("value")
        if not isinstance(column, str) or column not in known:
            raise QueryBuilderError(f"The filter column {column!r} does not exist in {table!r}.")
        if not isinstance(op, str) or op not in OPS:
            raise QueryBuilderError(f"The filter operator {op!r} is not supported.")
        if op in NULL_OPS:
            value = None
        elif op == "in":
            if not isinstance(value, list) or not value:
                raise QueryBuilderError(f"An 'in' filter on {column!r} needs a list of one or more values.")
            if len(value) > MAX_IN_ITEMS:
                raise QueryBuilderError(f"An 'in' filter can list at most {MAX_IN_ITEMS} values.")
            for v in value:
                _check_scalar(v, column)
        else:
            if value is None or isinstance(value, list):
                raise QueryBuilderError(f"The filter on {column!r} needs a single value.")
            _check_scalar(value, column)
        filters.append({"column": column, "op": op, "value": value})

    order_by = s.get("order_by")
    if order_by is not None and order_by not in ORDER_BYS:
        raise QueryBuilderError(f"The sort {order_by!r} is not supported.")

    limit = s.get("limit")
    if limit is None:
        limit = DEFAULT_LIMIT
    try:
        limit = int(limit)
    except (TypeError, ValueError):
        raise QueryBuilderError("The row limit must be a whole number.")
    limit = max(1, min(MAX_LIMIT, limit))

    return {
        "table": table, "group_by": group_by, "measure": measure, "agg": agg,
        "filters": filters, "order_by": order_by, "limit": limit,
    }


def _check_scalar(v, column: str) -> None:
    if isinstance(v, bool) or isinstance(v, (int, float, str)):
        return
    raise QueryBuilderError(f"The filter value for {column!r} must be a number or text.")


def sanitize_suggested_spec(spec, schema_cache) -> dict | None:
    """Loose validation for a spec the LANGUAGE MODEL suggested (see
    ai_engine.suggest_query_spec): instead of rejecting the whole thing on
    the first problem, drop each invalid part on its own - an unknown
    group-by column is dropped, an unknown measure becomes None (and the
    agg falls back to count), a bad filter is dropped - so the person
    still gets a mostly-right prefilled builder rather than nothing.
    Returns None only when no usable table could be identified, or the
    spec is not even a dict."""
    try:
        s = _as_spec_dict(spec)
    except QueryBuilderError:
        return None
    table = s.get("table")
    cols = table_columns(schema_cache, table) if isinstance(table, str) else None
    if not cols:
        return None
    known = {c["name"] for c in cols}

    group_by_raw = s.get("group_by") if isinstance(s.get("group_by"), list) else []
    group_by: list[str] = []
    for g in group_by_raw:
        if isinstance(g, str) and g in known and g not in group_by:
            group_by.append(g)
    group_by = group_by[:MAX_GROUP_BY]

    agg = s.get("agg")
    agg = agg.lower() if isinstance(agg, str) and agg.lower() in AGGS else "count"
    measure = s.get("measure")
    if not (isinstance(measure, str) and measure in known):
        measure = None
    if measure is None and agg != "count":
        agg = "count"

    filters: list[dict] = []
    for f in (s.get("filters") if isinstance(s.get("filters"), list) else []):
        if not isinstance(f, dict):
            continue
        column, op, value = f.get("column"), f.get("op"), f.get("value")
        if not (isinstance(column, str) and column in known and isinstance(op, str) and op in OPS):
            continue
        if op in NULL_OPS:
            filters.append({"column": column, "op": op, "value": None})
            continue
        if op == "in":
            if not isinstance(value, list):
                value = [value] if value is not None else []
            value = [v for v in value if isinstance(v, (int, float, str)) and not isinstance(v, bool)][:MAX_IN_ITEMS]
            if not value:
                continue
        else:
            if value is None or isinstance(value, (list, dict, bool)):
                continue
            if not isinstance(value, (int, float, str)):
                continue
        filters.append({"column": column, "op": op, "value": value})
        if len(filters) >= MAX_FILTERS:
            break

    order_by = s.get("order_by")
    if order_by not in ORDER_BYS:
        order_by = "measure_desc" if group_by else None
    limit = s.get("limit")
    try:
        limit = int(limit) if limit is not None else DEFAULT_LIMIT
    except (TypeError, ValueError):
        limit = DEFAULT_LIMIT
    limit = max(1, min(MAX_LIMIT, limit))

    return {
        "table": table, "group_by": group_by, "measure": measure, "agg": agg,
        "filters": filters, "order_by": order_by, "limit": limit,
    }


# --- SQL rendering ----------------------------------------------------------

def _render_value(v) -> str:
    """One SQL literal. A real number (int/float, or a string that parses
    as a number) is rendered bare; everything else is a single-quoted
    string with every embedded single quote doubled. bool is deliberately
    rendered as a quoted string rather than a bare TRUE/FALSE, since the
    dialects here disagree on boolean literals and the column is far more
    likely to be text anyway."""
    if isinstance(v, bool):
        return "'" + str(v).lower() + "'"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        if v != v or v in (float("inf"), float("-inf")):
            raise QueryBuilderError("A filter value must be a finite number.")
        return repr(v)
    text = str(v)
    if _NUMBER_RE.match(text.strip()):
        try:
            Decimal(text.strip())
            return text.strip()
        except InvalidOperation:
            pass
    return "'" + text.replace("'", "''") + "'"


def _measure_alias(agg: str, measure: str | None) -> str:
    if agg == "count" and measure is None:
        return "count"
    safe_measure = re.sub(r"[^A-Za-z0-9_]+", "_", measure or "").strip("_") or "value"
    return f"{agg}_{safe_measure}"


def _aggregate_expr(kind: str, agg: str, measure: str | None) -> str:
    if measure is None:
        return "COUNT(*)"
    col = _quote_ident(kind, measure)
    if agg == "count_distinct":
        return f"COUNT(DISTINCT {col})"
    return f"{agg.upper()}({col})"


def with_version_aliases(schema_cache, versions) -> tuple[dict, set[str]]:
    """2026-10-06 ("generated data is a saved query" layer): the schema
    dict handed to this builder when saved-query DatasetVersions are in
    scope - the real tables plus one entry per version keyed by its
    sql_alias with its columns_json - and the set of alias names, so
    build_sql can render an alias as a bare CTE name (never BigQuery-
    qualified, never quoted differently from its `WITH <alias> AS (...)`
    declaration). The caller wraps the finished SQL in those CTEs
    (warehouse_tables.wrap_with_ctes)."""
    schema = dict(schema_cache) if isinstance(schema_cache, dict) else {}
    aliases: set[str] = set()
    for v in versions or []:
        alias = getattr(v, "sql_alias", None)
        cols = getattr(v, "columns_json", None)
        if alias and isinstance(cols, list):
            schema[alias] = cols
            aliases.add(alias)
    return schema, aliases


def qualified_table_ident(
    kind: str, table: str, connection_info: dict | None, alias_tables: set[str] | None = None,
) -> str:
    """How this table must be spelled in a FROM clause for this kind.
    BigQuery needs `project.dataset.table` (exactly what routers/
    datasources.py's profile_datasource builds - an unqualified name fails
    with a real "must be qualified with a dataset" error); every other kind
    uses the bare quoted name, same as the profile query. A saved-query
    alias (`alias_tables`, see with_version_aliases) is rendered bare on
    every dialect: it is a CTE name of the shape [a-z][a-z0-9_]*, which
    needs no quoting anywhere and must match its unquoted declaration."""
    if alias_tables and table in alias_tables:
        return table
    if kind == "bigquery":
        info = connection_info or {}
        project, dataset = info.get("project_id"), info.get("dataset_id")
        if not project or not dataset:
            raise QueryBuilderError("This BigQuery connection is missing its project or dataset.")
        return _quote_ident(kind, f"{project}.{dataset}.{table}")
    return _quote_ident(kind, table)


def build_sql(
    spec, kind: str, schema_cache, connection_info: dict | None = None, alias_tables: set[str] | None = None,
) -> tuple[str, dict]:
    """Validates `spec` (strictly - see validate_spec) and renders the
    query for `kind`. Returns (sql, normalised_spec). Raises
    QueryBuilderError for anything that cannot be rendered safely.
    `alias_tables` names the entries of `schema_cache` that are saved-
    query aliases rather than real tables (see with_version_aliases)."""
    if kind not in SQL_KINDS:
        raise QueryBuilderError("The query builder only works for SQL warehouses and databases right now.")
    s = validate_spec(spec, schema_cache)
    group_cols = [_quote_ident(kind, g) for g in s["group_by"]]
    alias = _measure_alias(s["agg"], s["measure"])
    measure_expr = f"{_aggregate_expr(kind, s['agg'], s['measure'])} AS {_quote_ident(kind, alias)}"
    select_list = ", ".join(group_cols + [measure_expr])

    where_parts: list[str] = []
    for f in s["filters"]:
        col = _quote_ident(kind, f["column"])
        op = f["op"]
        if op == "is_null":
            where_parts.append(f"{col} IS NULL")
        elif op == "is_not_null":
            where_parts.append(f"{col} IS NOT NULL")
        elif op == "in":
            where_parts.append(f"{col} IN (" + ", ".join(_render_value(v) for v in f["value"]) + ")")
        else:
            sql_op = "<>" if op == "!=" else op
            where_parts.append(f"{col} {sql_op} {_render_value(f['value'])}")

    order_sql = ""
    if s["order_by"] == "measure_desc":
        order_sql = f" ORDER BY {_quote_ident(kind, alias)} DESC"
    elif s["order_by"] == "measure_asc":
        order_sql = f" ORDER BY {_quote_ident(kind, alias)} ASC"
    elif s["order_by"] == "group" and group_cols:
        order_sql = " ORDER BY " + ", ".join(group_cols)

    limit = s["limit"]
    if kind == "sqlserver":
        # T-SQL has no LIMIT keyword - TOP n goes right after SELECT. ORDER
        # BY is required for TOP to be deterministic; without one the
        # engine still accepts it, it just picks an arbitrary n rows.
        sql = f"SELECT TOP {limit} {select_list} FROM {qualified_table_ident(kind, s['table'], connection_info, alias_tables)}"
        tail = ""
    else:
        sql = f"SELECT {select_list} FROM {qualified_table_ident(kind, s['table'], connection_info, alias_tables)}"
        tail = f" LIMIT {limit}"
    if where_parts:
        sql += " WHERE " + " AND ".join(where_parts)
    if group_cols:
        sql += " GROUP BY " + ", ".join(group_cols)
    sql += order_sql + tail
    return sql, s


def describe_spec(spec: dict) -> str:
    """A one-line, human-readable description of a (validated) spec -
    used as the note handed to ai_engine.analyze so the chart/insight
    describe the result rather than re-derive it, and as a fallback
    prompt label."""
    agg, measure = spec.get("agg", "count"), spec.get("measure")
    what = "count of rows" if (agg == "count" and measure is None) else f"{agg.replace('_', ' ')} of {measure}"
    text = f"{what} from {spec.get('table')}"
    if spec.get("group_by"):
        text += " by " + ", ".join(spec["group_by"])
    if spec.get("filters"):
        parts = []
        for f in spec["filters"]:
            if f["op"] in NULL_OPS:
                parts.append(f"{f['column']} {f['op'].replace('_', ' ')}")
            elif f["op"] == "in":
                parts.append(f"{f['column']} in ({', '.join(str(v) for v in f['value'])})")
            else:
                parts.append(f"{f['column']} {f['op']} {f['value']}")
        text += " where " + " and ".join(parts)
    return text
