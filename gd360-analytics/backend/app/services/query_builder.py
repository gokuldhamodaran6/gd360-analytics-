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

2026-10-06 (warehouse-native dashboards layer) - the second, richer shape
this module renders is the dashboard BlockSpec (see validate_block_spec /
build_block_sql at the bottom of this file): several measures, a safe
arithmetic `expr` measure (SUM(adr * nights) - validated by a tiny
tokenizer, never interpolated raw), a time bucket per dialect (day/week/
month/quarter/year), explicit order_by, the page's filter rail pushed
into the WHERE clause (page_filters_to_block_filters translates the Data
tab's own filter shapes), and the prior-period window maths for KPI
deltas. Same safety model, same single chokepoints - a block spec is
just a bigger spec, not a different trust boundary. The original
QueryBuilderSpec API above is unchanged and still used by routers/chat.py.
"""
from __future__ import annotations

import re
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation

from .profiling import _TEXT_CAST_TYPES, _quote_ident

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


# ============================================================================
# 2026-10-06 (warehouse-native dashboards layer): the dashboard BlockSpec.
#
# A warehouse dashboard block never stores rows - it stores a spec, and the
# engine (services/dashboard_engine.py) compiles that spec plus the page's
# live filter rail into ONE query that runs inside the warehouse on every
# refresh/filter change. The spec shape (every key optional except table):
#
#   {"table": <schema_cache key | saved-query sql_alias>,
#    "time": {"column": <date/timestamp column>, "grain": "day"|"week"|"month"|"quarter"|"year"} | null,
#    "group_by": [<col>, ...]                        (0..MAX_GROUP_BY),
#    "measures": [{"alias": <ident>, "agg": count|sum|avg|min|max|count_distinct,
#                  "column": <col> | null, "expr": <safe arithmetic> | null}, ...],
#    "filters": [{"column", "op", "value"}, ...]     (the block's OWN, always applied),
#    "order_by": [{"by": <measure alias | group col | "period">, "dir": "asc"|"desc"}, ...],
#    "limit": <int, 1..MAX_LIMIT>,
#    "compare_prior_period": bool, "sparkline": bool}
#
# The time bucket is always rendered as the ISO date of the bucket START
# ("2017-03-01" for March 2017 at month grain, the Monday for week grain)
# in a column aliased `period` - one uniform, sortable, dialect-independent
# string for the frontend, whatever the warehouse.
# ============================================================================

GRAINS = ("day", "week", "month", "quarter", "year")
PERIOD_ALIAS = "period"
MAX_MEASURES = 6
MAX_ORDER_BY = 3
DIRS = ("asc", "desc")
# Filter ops a BlockSpec (or a translated page filter) may use, on top of
# the original OPS: `between` takes [lo, hi]; the text ops are case-
# insensitive and operate on the column cast to text; the two *_ci ops are
# the text panel's "equals"/"not equals"; is_true/is_false render a dialect-
# correct boolean literal; in_or_null is "values" multi-select with the
# (Blanks) entry ticked.
BLOCK_OPS = OPS + (
    "between", "contains", "not_contains", "starts_with", "ends_with", "equals_ci", "not_equals_ci",
    "is_empty", "is_not_empty", "is_true", "is_false", "in_or_null",
)
_TEXT_OPS = ("contains", "not_contains", "starts_with", "ends_with", "equals_ci", "not_equals_ci")
_NO_VALUE_OPS = NULL_OPS + ("is_empty", "is_not_empty", "is_true", "is_false")
_ALIAS_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class BlockSpecError(QueryBuilderError):
    """A dashboard BlockSpec (or a page filter) that cannot be rendered
    safely. Subclass of QueryBuilderError so existing `except
    QueryBuilderError` call sites keep catching it."""


# --- safe arithmetic expressions -------------------------------------------

_EXPR_TOKEN_RE = re.compile(
    r"\s*(?:"
    r"(?P<num>\d+(?:\.\d*)?|\.\d+)"
    r"|(?P<ident>[A-Za-z_][A-Za-z0-9_]*)"
    r"|(?P<qident>\"[^\"]+\"|`[^`]+`|\[[^\]]+\])"
    r"|(?P<op>[-+*/()])"
    r")"
)
_EXPR_MAX_LEN = 400


def tokenize_expr(expr: str) -> list[tuple[str, str]]:
    """Tokenizes a measure `expr` into [(kind, text)] where kind is "num",
    "ident" or "op". Only numeric literals, identifiers (bare, or quoted
    with "..." / `...` / [...] so a column named "Order Date" can be
    used), the four arithmetic operators and parentheses are tokens -
    anything else (a function call is an ident followed by "(", see
    parse_expr; a string literal, a comma, a semicolon, a comment, a
    comparison, a keyword) is a BlockSpecError. Nothing from `expr` is
    ever copied into SQL: identifiers are re-quoted by the dialect and
    numbers are re-rendered from their parsed value."""
    if not isinstance(expr, str) or not expr.strip():
        raise BlockSpecError("A measure expression must be a non-empty string.")
    if len(expr) > _EXPR_MAX_LEN:
        raise BlockSpecError(f"A measure expression can be at most {_EXPR_MAX_LEN} characters.")
    tokens: list[tuple[str, str]] = []
    pos = 0
    while pos < len(expr):
        if expr[pos:].strip() == "":
            break
        m = _EXPR_TOKEN_RE.match(expr, pos)
        if not m or m.end() == pos:
            bad = expr[pos:].strip()[:12]
            raise BlockSpecError(
                f"The measure expression contains something that is not allowed near {bad!r}: only column names, "
                "numbers, + - * / and parentheses are accepted."
            )
        if m.group("num") is not None:
            tokens.append(("num", m.group("num")))
        elif m.group("ident") is not None:
            tokens.append(("ident", m.group("ident")))
        elif m.group("qident") is not None:
            tokens.append(("ident", m.group("qident")[1:-1]))
        else:
            tokens.append(("op", m.group("op")))
        pos = m.end()
    if not tokens:
        raise BlockSpecError("A measure expression must be a non-empty string.")
    return tokens


def parse_expr(expr: str, known_columns: set[str]) -> list[tuple[str, str]]:
    """Validates `expr` with a tiny recursive-descent grammar -
      expr   := term (('+'|'-') term)*
      term   := factor (('*'|'/') factor)*
      factor := num | ident | '(' expr ')' | '-' factor
    - and checks every identifier is a real column of the table. Returns
    the token list for render_expr. A bare identifier followed by "(" (a
    function call) fails the grammar, as does anything unbalanced."""
    tokens = tokenize_expr(expr)
    idents = [t for k, t in tokens if k == "ident"]
    for name in idents:
        if name not in known_columns:
            raise BlockSpecError(f"The measure expression refers to {name!r}, which is not a column of this table.")
    i = 0

    def peek():
        return tokens[i] if i < len(tokens) else (None, None)

    def take():
        nonlocal i
        tok = tokens[i]
        i += 1
        return tok

    def p_expr():
        p_term()
        while peek() == ("op", "+") or peek() == ("op", "-"):
            take()
            p_term()

    def p_term():
        p_factor()
        while peek() == ("op", "*") or peek() == ("op", "/"):
            take()
            p_factor()

    def p_factor():
        kind, text = peek()
        if kind is None:
            raise BlockSpecError("The measure expression ends unexpectedly.")
        if kind in ("num", "ident"):
            take()
            if peek() == ("op", "("):
                raise BlockSpecError("Function calls are not allowed in a measure expression - only column arithmetic.")
            return
        if (kind, text) == ("op", "("):
            take()
            p_expr()
            if peek() != ("op", ")"):
                raise BlockSpecError("The measure expression has unbalanced parentheses.")
            take()
            return
        if (kind, text) == ("op", "-"):
            take()
            p_factor()
            return
        raise BlockSpecError(f"The measure expression is malformed near {text!r}.")

    p_expr()
    if i != len(tokens):
        raise BlockSpecError(f"The measure expression is malformed near {tokens[i][1]!r}.")
    return tokens


def render_expr(kind: str, tokens: list[tuple[str, str]]) -> str:
    """The validated token list as dialect SQL: identifiers quoted by the
    dialect, numbers re-rendered through Decimal, operators as-is."""
    out: list[str] = []
    for tkind, text in tokens:
        if tkind == "ident":
            out.append(_quote_ident(kind, text))
        elif tkind == "num":
            try:
                out.append(str(Decimal(text)))
            except InvalidOperation:
                raise BlockSpecError(f"{text!r} is not a valid number in the measure expression.")
        else:
            out.append(text)
    return " ".join(out).replace("( ", "(").replace(" )", ")")


# --- time buckets per dialect ---------------------------------------------

def time_bucket_expr(kind: str, column: str, grain: str) -> str:
    """The SQL for `column` bucketed at `grain`, always producing the ISO
    date string of the bucket start (weeks start Monday on every
    dialect). Each form was chosen to work on both a DATE and a
    TIMESTAMP/DATETIME column of that dialect."""
    if grain not in GRAINS:
        raise BlockSpecError(f"The time grain {grain!r} is not supported. Use one of: {', '.join(GRAINS)}.")
    col = _quote_ident(kind, column)
    if kind == "bigquery":
        if grain == "day":
            return f"FORMAT_DATE('%Y-%m-%d', DATE({col}))"
        part = "WEEK(MONDAY)" if grain == "week" else grain.upper()
        return f"FORMAT_DATE('%Y-%m-%d', DATE_TRUNC(DATE({col}), {part}))"
    if kind == "snowflake":
        return f"TO_CHAR(DATE_TRUNC('{grain}', CAST({col} AS DATE)), 'YYYY-MM-DD')"
    if kind in ("postgres", "supabase"):
        return f"TO_CHAR(DATE_TRUNC('{grain}', CAST({col} AS TIMESTAMP)), 'YYYY-MM-DD')"
    if kind == "mysql":
        if grain == "day":
            return f"DATE_FORMAT({col}, '%Y-%m-%d')"
        if grain == "month":
            return f"DATE_FORMAT({col}, '%Y-%m-01')"
        if grain == "year":
            return f"DATE_FORMAT({col}, '%Y-01-01')"
        if grain == "week":
            return f"DATE_FORMAT(DATE_SUB(DATE({col}), INTERVAL WEEKDAY({col}) DAY), '%Y-%m-%d')"
        return f"DATE_FORMAT(MAKEDATE(YEAR({col}), 1) + INTERVAL (QUARTER({col}) - 1) QUARTER, '%Y-%m-%d')"
    if kind == "sqlserver":
        if grain == "day":
            return f"CONVERT(VARCHAR(10), CAST({col} AS DATE), 23)"
        if grain == "month":
            return f"CONVERT(VARCHAR(10), DATEFROMPARTS(YEAR({col}), MONTH({col}), 1), 23)"
        if grain == "year":
            return f"CONVERT(VARCHAR(10), DATEFROMPARTS(YEAR({col}), 1, 1), 23)"
        if grain == "quarter":
            return f"CONVERT(VARCHAR(10), DATEFROMPARTS(YEAR({col}), ((DATEPART(QUARTER, {col}) - 1) * 3) + 1, 1), 23)"
        # Monday-start weeks independent of @@DATEFIRST: whole weeks since
        # 1900-01-01 (a Monday).
        return f"CONVERT(VARCHAR(10), DATEADD(DAY, (DATEDIFF(DAY, 0, {col}) / 7) * 7, 0), 23)"
    raise BlockSpecError("Time bucketing is only available for SQL warehouses and databases.")


# --- BlockSpec validation --------------------------------------------------

def _validate_filter(f, known: set[str], table: str, strict: bool = True) -> dict | None:
    """One filter in BLOCK_OPS vocabulary -> normalised dict, or raises
    BlockSpecError (strict) / returns None (lenient, used for AI-suggested
    specs)."""
    try:
        f = _as_spec_dict(f) if not isinstance(f, dict) else f
        column, op, value = f.get("column"), f.get("op"), f.get("value")
        if not isinstance(column, str) or column not in known:
            raise BlockSpecError(f"The filter column {column!r} does not exist in {table!r}.")
        if not isinstance(op, str) or op not in BLOCK_OPS:
            raise BlockSpecError(f"The filter operator {op!r} is not supported.")
        if op in _NO_VALUE_OPS:
            return {"column": column, "op": op, "value": None}
        if op in ("in", "in_or_null"):
            if not isinstance(value, list):
                value = [value] if value is not None else []
            value = [v for v in value if v is not None]
            if op == "in" and not value:
                raise BlockSpecError(f"An 'in' filter on {column!r} needs a list of one or more values.")
            if len(value) > MAX_IN_ITEMS:
                raise BlockSpecError(f"An 'in' filter can list at most {MAX_IN_ITEMS} values.")
            for v in value:
                _check_scalar(v, column)
            if op == "in_or_null" and not value:
                return {"column": column, "op": "is_null", "value": None}
            return {"column": column, "op": op, "value": value}
        if op == "between":
            if not isinstance(value, list) or len(value) != 2 or any(v is None for v in value):
                raise BlockSpecError(f"A 'between' filter on {column!r} needs exactly two values.")
            for v in value:
                _check_scalar(v, column)
            return {"column": column, "op": op, "value": list(value)}
        if op in _TEXT_OPS:
            if value is None or isinstance(value, (list, dict)):
                raise BlockSpecError(f"The text filter on {column!r} needs a single value.")
            return {"column": column, "op": op, "value": str(value)}
        if value is None or isinstance(value, list):
            raise BlockSpecError(f"The filter on {column!r} needs a single value.")
        _check_scalar(value, column)
        return {"column": column, "op": op, "value": value}
    except BlockSpecError:
        if strict:
            raise
        return None
    except QueryBuilderError as e:
        if strict:
            raise BlockSpecError(str(e))
        return None


def validate_block_spec(spec, schema_cache, strict: bool = True) -> dict:
    """Strict validation of a dashboard BlockSpec against the (alias-
    extended, see with_version_aliases) schema. Returns the normalised
    spec with every key present. `strict=False` is the lenient mode for an
    AI-suggested spec (ai_engine.generate_block_spec): invalid group_by
    columns, measures, filters and order_by entries are dropped
    individually instead of failing the whole spec, as long as a usable
    table and at least one measure remain."""
    s = _as_spec_dict(spec)
    table = s.get("table")
    cols = table_columns(schema_cache, table) if isinstance(table, str) else None
    if not cols:
        raise BlockSpecError(
            f"The table {table!r} is not one of this data source's tables. Pick a table from the list."
        )
    known = {c["name"] for c in cols}

    def fail_or_skip(msg: str):
        if strict:
            raise BlockSpecError(msg)

    # time
    time_raw = s.get("time")
    time_out = None
    if time_raw:
        t = _as_spec_dict(time_raw) if not isinstance(time_raw, dict) else time_raw
        tcol, grain = t.get("column"), (t.get("grain") or "month")
        if not isinstance(tcol, str) or tcol not in known:
            fail_or_skip(f"The time column {tcol!r} does not exist in {table!r}.")
        elif not isinstance(grain, str) or grain.lower() not in GRAINS:
            fail_or_skip(f"The time grain {grain!r} is not supported. Use one of: {', '.join(GRAINS)}.")
        else:
            time_out = {"column": tcol, "grain": grain.lower()}

    # group_by
    group_raw = s.get("group_by") or []
    if not isinstance(group_raw, list):
        fail_or_skip("Group-by must be a list of column names.")
        group_raw = []
    group_by: list[str] = []
    for g in group_raw:
        if not isinstance(g, str) or g not in known:
            fail_or_skip(f"The column {g!r} does not exist in {table!r}.")
            continue
        if g not in group_by:
            group_by.append(g)
    if len(group_by) > MAX_GROUP_BY:
        fail_or_skip(f"You can group by at most {MAX_GROUP_BY} columns.")
        group_by = group_by[:MAX_GROUP_BY]

    # measures
    measures_raw = s.get("measures")
    if not measures_raw and (s.get("agg") or s.get("measure")):
        # Accept the chat QueryBuilderSpec's single-measure shape too.
        measures_raw = [{"agg": s.get("agg") or "count", "column": s.get("measure")}]
    if not isinstance(measures_raw, list) or not measures_raw:
        if strict:
            raise BlockSpecError("A block needs at least one measure.")
        measures_raw = [{"agg": "count"}]
    measures: list[dict] = []
    taken_aliases: set[str] = set()
    for m in measures_raw:
        m = _as_spec_dict(m) if not isinstance(m, dict) else m
        agg = (m.get("agg") or "count")
        if not isinstance(agg, str) or agg.lower() not in AGGS:
            fail_or_skip(f"The aggregation {agg!r} is not supported. Use one of: {', '.join(AGGS)}.")
            continue
        agg = agg.lower()
        column, expr = m.get("column"), m.get("expr")
        expr_tokens = None
        if expr:
            try:
                expr_tokens = parse_expr(expr, known)
            except BlockSpecError as e:
                fail_or_skip(str(e))
                continue
            column = None
        elif column is not None:
            if not isinstance(column, str) or column not in known:
                fail_or_skip(f"The column {column!r} does not exist in {table!r}.")
                continue
        elif agg != "count":
            fail_or_skip(f"{agg.upper()} needs a column or an expression to aggregate - pick one, or use count.")
            continue
        alias = m.get("alias")
        if not alias:
            alias = _measure_alias(agg, column) if not expr else f"{agg}_expr"
        alias = str(alias)
        if not _ALIAS_RE.match(alias):
            fail_or_skip(f"The measure name {alias!r} must be a plain identifier (letters, digits, underscores).")
            alias = re.sub(r"[^A-Za-z0-9_]+", "_", alias).strip("_") or "value"
            if not alias[0].isalpha() and alias[0] != "_":
                alias = "m_" + alias
        base, n = alias, 2
        while alias in taken_aliases or alias == PERIOD_ALIAS or alias in group_by:
            alias = f"{base}_{n}"
            n += 1
        taken_aliases.add(alias)
        measures.append({"alias": alias, "agg": agg, "column": column, "expr": expr if expr else None,
                         "_tokens": expr_tokens})
        if len(measures) >= MAX_MEASURES:
            break
    if not measures:
        raise BlockSpecError("A block needs at least one valid measure.")

    # filters
    raw_filters = s.get("filters") or []
    if not isinstance(raw_filters, list):
        fail_or_skip("Filters must be a list.")
        raw_filters = []
    if len(raw_filters) > MAX_FILTERS:
        fail_or_skip(f"At most {MAX_FILTERS} filters are allowed.")
        raw_filters = raw_filters[:MAX_FILTERS]
    filters = [out for f in raw_filters if (out := _validate_filter(f, known, table, strict=strict)) is not None]

    # order_by
    order_raw = s.get("order_by") or []
    if isinstance(order_raw, str):
        # The chat spec's "measure_desc"/"measure_asc"/"group" strings.
        first = measures[0]["alias"]
        order_raw = (
            [{"by": first, "dir": "desc"}] if order_raw == "measure_desc"
            else [{"by": first, "dir": "asc"}] if order_raw == "measure_asc"
            else [{"by": g, "dir": "asc"} for g in group_by] if order_raw == "group" else []
        )
    if not isinstance(order_raw, list):
        fail_or_skip("order_by must be a list of {by, dir} entries.")
        order_raw = []
    sortable = set(group_by) | taken_aliases | ({PERIOD_ALIAS} if time_out else set())
    order_by: list[dict] = []
    for o in order_raw[:MAX_ORDER_BY]:
        o = _as_spec_dict(o) if not isinstance(o, dict) else o
        by, direction = o.get("by"), (o.get("dir") or "asc")
        if not isinstance(by, str) or by not in sortable:
            fail_or_skip(f"Cannot sort by {by!r} - it is not a measure, a group-by column or the period.")
            continue
        if not isinstance(direction, str) or direction.lower() not in DIRS:
            fail_or_skip(f"The sort direction {direction!r} must be asc or desc.")
            continue
        order_by.append({"by": by, "dir": direction.lower()})

    limit = s.get("limit")
    if limit is None:
        limit = DEFAULT_LIMIT
    try:
        limit = int(limit)
    except (TypeError, ValueError):
        if strict:
            raise BlockSpecError("The row limit must be a whole number.")
        limit = DEFAULT_LIMIT
    limit = max(1, min(MAX_LIMIT, limit))

    return {
        "table": table, "time": time_out, "group_by": group_by,
        "measures": [{k: v for k, v in m.items() if k != "_tokens"} for m in measures],
        "filters": filters, "order_by": order_by, "limit": limit,
        "compare_prior_period": bool(s.get("compare_prior_period")),
        "sparkline": bool(s.get("sparkline")),
        "_measure_tokens": {m["alias"]: m["_tokens"] for m in measures},
    }


def public_spec(normalised: dict) -> dict:
    """The normalised spec without its private `_measure_tokens` - what is
    stored on block.config["spec"] and returned to the frontend."""
    return {k: v for k, v in (normalised or {}).items() if not k.startswith("_")}


# --- page filters -> block filters ----------------------------------------

def page_filters_to_block_filters(page_filters, known_columns: set[str] | None = None) -> list[dict]:
    """Translates the dashboard page's filter payload - each entry
    {"column", "spec"} where `spec` is exactly one of routers/datasources.
    _apply_column_filter's shapes (a bare string, "values", "text",
    "number", "date", "boolean") - into BLOCK_OPS filters, so the same
    filter rail that already drives the pandas path drives the warehouse
    query instead. Unknown columns (when `known_columns` is given) and
    malformed specs are skipped, mirroring _apply_filters' own
    "skip, don't fail" behaviour. A cross-filter from clicking a bar is the
    "values" shape with one value, so it needs nothing special."""
    out: list[dict] = []
    for f in page_filters or []:
        column = f.column if hasattr(f, "column") else (f.get("column") if isinstance(f, dict) else None)
        spec = f.spec if hasattr(f, "spec") else (f.get("spec") if isinstance(f, dict) else None)
        if not isinstance(column, str) or not column:
            continue
        if known_columns is not None and column not in known_columns:
            continue
        for translated in _translate_filter_spec(column, spec):
            out.append(translated)
    return out


def _translate_filter_spec(column: str, spec) -> list[dict]:
    if isinstance(spec, str):
        return [{"column": column, "op": "contains", "value": spec}] if spec else []
    if not isinstance(spec, dict):
        return []
    kind = spec.get("type")
    if kind == "values":
        include = spec.get("include")
        if include is None:
            include = spec.get("values")
        if not isinstance(include, list) or not include:
            return []
        wants_null = any(v is None for v in include)
        values = [v for v in include if v is not None and isinstance(v, (str, int, float)) and not isinstance(v, bool)]
        if values and wants_null:
            return [{"column": column, "op": "in_or_null", "value": values}]
        if values:
            return [{"column": column, "op": "in", "value": values}]
        if wants_null:
            return [{"column": column, "op": "is_null", "value": None}]
        return []
    if kind == "text":
        op = spec.get("op")
        value = str(spec.get("value") or "")
        mapping = {
            "contains": "contains", "not_contains": "not_contains", "equals": "equals_ci",
            "not_equals": "not_equals_ci", "starts_with": "starts_with", "ends_with": "ends_with",
            "is_empty": "is_empty", "is_not_empty": "is_not_empty",
        }
        if op not in mapping:
            return []
        if mapping[op] in _NO_VALUE_OPS:
            return [{"column": column, "op": mapping[op], "value": None}]
        if value == "":
            return []
        return [{"column": column, "op": mapping[op], "value": value}]
    if kind == "number":
        op = spec.get("op")

        def _num(key):
            raw = spec.get(key)
            if raw in (None, ""):
                return None
            try:
                v = float(raw)
            except (TypeError, ValueError):
                return None
            return int(v) if v == int(v) and abs(v) < 1e15 else v

        value, value2 = _num("value"), _num("value2")
        if op == "between":
            if value is None or value2 is None:
                return []
            return [{"column": column, "op": "between", "value": [min(value, value2), max(value, value2)]}]
        if value is None:
            return []
        mapping = {"eq": "=", "neq": "!=", "gt": ">", "gte": ">=", "lt": "<", "lte": "<="}
        if op not in mapping:
            return []
        return [{"column": column, "op": mapping[op], "value": value}]
    if kind == "date":
        out = []
        start = _parse_iso_date(spec.get("from"))
        end = _parse_iso_date(spec.get("to"))
        if start:
            out.append({"column": column, "op": ">=", "value": start.isoformat()})
        if end:
            # Inclusive of the whole "to" day: strictly before the next day,
            # which is correct for DATE and TIMESTAMP columns alike.
            out.append({"column": column, "op": "<", "value": (end + timedelta(days=1)).isoformat()})
        return out
    if kind == "boolean":
        value = spec.get("value")
        if value in ("true", True):
            return [{"column": column, "op": "is_true", "value": None}]
        if value in ("false", False):
            return [{"column": column, "op": "is_false", "value": None}]
        return []
    return []


def _parse_iso_date(raw) -> date | None:
    if raw is None or raw == "":
        return None
    if isinstance(raw, datetime):
        return raw.date()
    if isinstance(raw, date):
        return raw
    text = str(raw).strip()
    for fmt in ("%Y-%m-%d", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%dT%H:%M:%SZ"):
        try:
            return datetime.strptime(text[:26] if "." in text else text, fmt).date()
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).date()
    except ValueError:
        return None


# --- date range / prior period --------------------------------------------

def normalize_date_range(date_range) -> dict | None:
    """{"from": "YYYY-MM-DD", "to": "YYYY-MM-DD"} (both inclusive) from
    whatever the frontend sent ({from,to} / {start,end}, ISO strings or
    datetimes, either end optional). None when neither end parses."""
    if not date_range:
        return None
    if hasattr(date_range, "model_dump"):
        date_range = date_range.model_dump()
    if not isinstance(date_range, dict):
        return None
    start = _parse_iso_date(date_range.get("from") if "from" in date_range else date_range.get("start"))
    end = _parse_iso_date(date_range.get("to") if "to" in date_range else date_range.get("end"))
    if start is None and end is None:
        return None
    if start and end and end < start:
        start, end = end, start
    return {"from": start.isoformat() if start else None, "to": end.isoformat() if end else None}


def prior_period_range(date_range) -> dict | None:
    """The same-length window immediately before `date_range` - "prior
    period" for KPI deltas. [from, to] inclusive of length n days ->
    [from - n, from - 1]. None for an open-ended range (no honest prior
    window exists)."""
    r = normalize_date_range(date_range)
    if not r or not r.get("from") or not r.get("to"):
        return None
    start, end = date.fromisoformat(r["from"]), date.fromisoformat(r["to"])
    length = (end - start).days + 1
    return {"from": (start - timedelta(days=length)).isoformat(), "to": (start - timedelta(days=1)).isoformat()}


def date_range_filters(column: str, date_range) -> list[dict]:
    """The BLOCK_OPS filters for a date range on `column` (>= from, <
    to + 1 day)."""
    r = normalize_date_range(date_range)
    if not r:
        return []
    return _translate_filter_spec(column, {"type": "date", "from": r.get("from"), "to": r.get("to")})


# --- rendering --------------------------------------------------------------

def _escape_like(kind: str, text: str) -> tuple[str, str]:
    """(pattern body with LIKE wildcards escaped, ESCAPE clause or "")."""
    if kind == "bigquery":
        # BigQuery has no ESCAPE clause; a backslash escapes % and _ in the
        # pattern, and the backslash itself is doubled inside the literal.
        body = text.replace("\\", "\\\\\\\\").replace("%", "\\\\%").replace("_", "\\\\_")
        return body, ""
    body = text.replace("!", "!!").replace("%", "!%").replace("_", "!_")
    return body, " ESCAPE '!'"


def _text_expr(kind: str, col_q: str) -> str:
    cast_type = _TEXT_CAST_TYPES.get(kind) or ("STRING" if kind == "bigquery" else "VARCHAR")
    return f"LOWER(CAST({col_q} AS {cast_type}))"


def _bool_literal(kind: str, value: bool) -> str:
    if kind == "sqlserver":
        return "1" if value else "0"
    return "TRUE" if value else "FALSE"


def render_filter(kind: str, f: dict) -> str:
    """One validated BLOCK_OPS filter as a WHERE fragment."""
    col = _quote_ident(kind, f["column"])
    op, value = f["op"], f.get("value")
    if op == "is_null":
        return f"{col} IS NULL"
    if op == "is_not_null":
        return f"{col} IS NOT NULL"
    if op == "in":
        return f"{col} IN (" + ", ".join(_render_value(v) for v in value) + ")"
    if op == "in_or_null":
        return f"({col} IN (" + ", ".join(_render_value(v) for v in value) + f") OR {col} IS NULL)"
    if op == "between":
        return f"{col} BETWEEN {_render_value(value[0])} AND {_render_value(value[1])}"
    if op == "is_true":
        return f"{col} = {_bool_literal(kind, True)}"
    if op == "is_false":
        return f"{col} = {_bool_literal(kind, False)}"
    if op == "is_empty":
        return f"({col} IS NULL OR {_text_expr(kind, col)} = '')"
    if op == "is_not_empty":
        return f"({col} IS NOT NULL AND {_text_expr(kind, col)} <> '')"
    if op in _TEXT_OPS:
        text = str(value).lower()
        if op in ("equals_ci", "not_equals_ci"):
            lit = "'" + text.replace("'", "''") + "'"
            return f"{_text_expr(kind, col)} {'=' if op == 'equals_ci' else '<>'} {lit}"
        body, escape = _escape_like(kind, text)
        body = body.replace("'", "''")
        pattern = {"contains": f"%{body}%", "not_contains": f"%{body}%", "starts_with": f"{body}%", "ends_with": f"%{body}"}[op]
        neg = "NOT " if op == "not_contains" else ""
        return f"{_text_expr(kind, col)} {neg}LIKE '{pattern}'{escape}"
    sql_op = "<>" if op == "!=" else op
    return f"{col} {sql_op} {_render_value(value)}"


def _measure_sql(kind: str, m: dict, tokens) -> str:
    if m.get("expr"):
        inner = render_expr(kind, tokens or parse_expr(m["expr"], set()))
        if m["agg"] == "count_distinct":
            return f"COUNT(DISTINCT ({inner}))"
        if m["agg"] == "count":
            return f"COUNT({inner})"
        return f"{m['agg'].upper()}({inner})"
    return _aggregate_expr(kind, m["agg"], m.get("column"))


def build_block_sql(
    spec, kind: str, schema_cache, connection_info: dict | None = None, alias_tables: set[str] | None = None,
    extra_filters: list[dict] | None = None, date_range=None, date_column: str | None = None,
    grain_override: str | None = None,
) -> tuple[str, dict]:
    """Validates a BlockSpec (strictly) and renders ONE aggregate query
    for `kind`. `extra_filters` are already-translated page filters
    (page_filters_to_block_filters) AND-ed with the block's own; a filter
    on a column the table does not have is skipped (a page filter rail
    may name a column of another table). `date_range` on `date_column`
    (the dashboard's time column, when it belongs to this table; else the
    spec's own time column) is pushed down as >= from / < to+1.
    `grain_override` (the page's period control) replaces the spec's
    grain when the spec has a time bucket. Returns (sql, normalised_spec)."""
    if kind not in SQL_KINDS:
        raise BlockSpecError("Warehouse-native blocks only work for SQL warehouses and databases right now.")
    s = validate_block_spec(spec, schema_cache, strict=True)
    known = {c["name"] for c in table_columns(schema_cache, s["table"]) or []}
    tokens_by_alias = s.get("_measure_tokens") or {}

    time_sql = None
    if s["time"]:
        grain = grain_override if grain_override in GRAINS else s["time"]["grain"]
        time_sql = time_bucket_expr(kind, s["time"]["column"], grain)

    select_parts: list[str] = []
    group_parts: list[str] = []
    if time_sql:
        select_parts.append(f"{time_sql} AS {_quote_ident(kind, PERIOD_ALIAS)}")
        group_parts.append(time_sql)
    for g in s["group_by"]:
        q = _quote_ident(kind, g)
        select_parts.append(q)
        group_parts.append(q)
    for m in s["measures"]:
        select_parts.append(f"{_measure_sql(kind, m, tokens_by_alias.get(m['alias']))} AS {_quote_ident(kind, m['alias'])}")

    where_parts = [render_filter(kind, f) for f in s["filters"]]
    for f in extra_filters or []:
        if not isinstance(f, dict) or f.get("column") not in known:
            continue
        checked = _validate_filter(f, known, s["table"], strict=False)
        if checked:
            where_parts.append(render_filter(kind, checked))
    range_col = date_column if (date_column and date_column in known) else (s["time"]["column"] if s["time"] else None)
    if range_col and date_range:
        for f in date_range_filters(range_col, date_range):
            where_parts.append(render_filter(kind, f))

    order_by = list(s["order_by"])
    if not order_by:
        if time_sql:
            order_by = [{"by": PERIOD_ALIAS, "dir": "asc"}]
        elif s["group_by"]:
            order_by = [{"by": s["measures"][0]["alias"], "dir": "desc"}]
    order_sql = ""
    if order_by:
        order_sql = " ORDER BY " + ", ".join(f"{_quote_ident(kind, o['by'])} {o['dir'].upper()}" for o in order_by)

    table_sql = qualified_table_ident(kind, s["table"], connection_info, alias_tables)
    select_list = ", ".join(select_parts)
    limit = s["limit"]
    if kind == "sqlserver":
        sql = f"SELECT TOP {limit} {select_list} FROM {table_sql}"
        tail = ""
    else:
        sql = f"SELECT {select_list} FROM {table_sql}"
        tail = f" LIMIT {limit}"
    if where_parts:
        sql += " WHERE " + " AND ".join(where_parts)
    if group_parts:
        sql += " GROUP BY " + ", ".join(group_parts)
    sql += order_sql + tail
    return sql, public_spec(s)


def build_count_sql(
    table: str, kind: str, schema_cache, connection_info: dict | None = None, alias_tables: set[str] | None = None,
    extra_filters: list[dict] | None = None, date_range=None, date_column: str | None = None,
) -> str:
    """`SELECT COUNT(*) AS gd360_n FROM <table> [WHERE <page filters>]` -
    the dashboard's "Showing 75,166 of 119,386 rows" number."""
    if kind not in SQL_KINDS:
        raise BlockSpecError("Warehouse-native blocks only work for SQL warehouses and databases right now.")
    cols = table_columns(schema_cache, table)
    if not cols:
        raise BlockSpecError(f"The table {table!r} is not one of this data source's tables.")
    known = {c["name"] for c in cols}
    where_parts: list[str] = []
    for f in extra_filters or []:
        if not isinstance(f, dict) or f.get("column") not in known:
            continue
        checked = _validate_filter(f, known, table, strict=False)
        if checked:
            where_parts.append(render_filter(kind, checked))
    if date_column and date_column in known and date_range:
        for f in date_range_filters(date_column, date_range):
            where_parts.append(render_filter(kind, f))
    sql = f"SELECT COUNT(*) AS gd360_n FROM {qualified_table_ident(kind, table, connection_info, alias_tables)}"
    if where_parts:
        sql += " WHERE " + " AND ".join(where_parts)
    return sql


def build_distinct_values_sql(
    table: str, column: str, kind: str, schema_cache, connection_info: dict | None = None,
    alias_tables: set[str] | None = None, search: str | None = None, limit: int = 50,
    extra_filters: list[dict] | None = None,
) -> str:
    """The ONE query behind a filter-rail parameter's options: the
    column's distinct values with counts, most common first, optionally
    narrowed by a case-insensitive `search` (the country search box).
    `extra_filters` (other page filters) narrow the counts so chips show
    counts under the current selection."""
    if kind not in SQL_KINDS:
        raise BlockSpecError("Warehouse-native blocks only work for SQL warehouses and databases right now.")
    cols = table_columns(schema_cache, table)
    if not cols:
        raise BlockSpecError(f"The table {table!r} is not one of this data source's tables.")
    known = {c["name"] for c in cols}
    if column not in known:
        raise BlockSpecError(f"The column {column!r} does not exist in {table!r}.")
    col = _quote_ident(kind, column)
    limit = max(1, min(500, int(limit)))
    where_parts = [f"{col} IS NOT NULL"]
    if search:
        where_parts.append(render_filter(kind, {"column": column, "op": "contains", "value": str(search)}))
    for f in extra_filters or []:
        if not isinstance(f, dict) or f.get("column") not in known or f.get("column") == column:
            continue
        checked = _validate_filter(f, known, table, strict=False)
        if checked:
            where_parts.append(render_filter(kind, checked))
    table_sql = qualified_table_ident(kind, table, connection_info, alias_tables)
    value_alias, count_alias = _quote_ident(kind, "value"), _quote_ident(kind, "count")
    where_sql = " WHERE " + " AND ".join(where_parts)
    if kind == "sqlserver":
        return (f"SELECT TOP {limit} {col} AS {value_alias}, COUNT(*) AS {count_alias} FROM {table_sql}{where_sql} "
                f"GROUP BY {col} ORDER BY {count_alias} DESC")
    return (f"SELECT {col} AS {value_alias}, COUNT(*) AS {count_alias} FROM {table_sql}{where_sql} "
            f"GROUP BY {col} ORDER BY {count_alias} DESC LIMIT {limit}")


def build_column_bounds_sql(
    table: str, columns: list[str], kind: str, schema_cache, connection_info: dict | None = None,
    alias_tables: set[str] | None = None,
) -> tuple[str, list[str]]:
    """(`SELECT MIN(a), MAX(a), MIN(b), MAX(b) FROM <table>`, [a, b]) - the
    ONE query behind the date pickers' bounds: the real first and last
    value of each of `columns` that the table has, in that order (a pair
    of result columns per name, read by position). Raises BlockSpecError
    when none of the columns is in the table."""
    if kind not in SQL_KINDS:
        raise BlockSpecError("Warehouse-native blocks only work for SQL warehouses and databases right now.")
    cols = table_columns(schema_cache, table)
    if not cols:
        raise BlockSpecError(f"The table {table!r} is not one of this data source's tables.")
    known = {c["name"] for c in cols}
    present: list[str] = []
    for c in columns or []:
        if c in known and c not in present:
            present.append(c)
    if not present:
        raise BlockSpecError(f"None of these columns exist in {table!r}.")
    parts = []
    for i, c in enumerate(present):
        q = _quote_ident(kind, c)
        parts.append(f"MIN({q}) AS {_quote_ident(kind, f'gd360_min_{i}')}, MAX({q}) AS {_quote_ident(kind, f'gd360_max_{i}')}")
    return f"SELECT {', '.join(parts)} FROM {qualified_table_ident(kind, table, connection_info, alias_tables)}", present


def describe_block_spec(spec: dict) -> str:
    """One readable line for a BlockSpec - the block's default subtitle."""
    parts = []
    for m in spec.get("measures") or []:
        if m.get("expr"):
            parts.append(f"{m['agg'].replace('_', ' ')} of {m['expr']}")
        elif m.get("column"):
            parts.append(f"{m['agg'].replace('_', ' ')} of {m['column']}")
        else:
            parts.append("count of rows")
    text = ", ".join(parts) + f" from {spec.get('table')}"
    dims = list(spec.get("group_by") or [])
    if spec.get("time"):
        dims.insert(0, f"{spec['time']['column']} by {spec['time']['grain']}")
    if dims:
        text += " by " + ", ".join(dims)
    if spec.get("filters"):
        text += " where " + " and ".join(
            f"{f['column']} {f['op'].replace('_', ' ')}" + ("" if f.get("value") is None else f" {f['value']}")
            for f in spec["filters"]
        )
    return text


# --- number format (2026-10-07) ---------------------------------------------
#
# A KPI tile's display format, inferred from its spec. Deliberately small and
# conservative: a format is only returned when the spec itself makes it
# certain enough to show without asking - never "probably". `None` means
# "leave config.format unset" (the frontend then shows a plain number).

NUMBER_FORMATS = ("number", "percent", "currency", "compact")

# Words that say "this is a fraction of a whole" in a measure alias / block title.
_RATE_WORDS = frozenset({"rate", "share", "percent", "percentage", "pct"})
# Words that say a COLUMN already stores a rate - its scale (0..1 or 0..100)
# is unknown from the schema, so no format is ever inferred for it.
_STORED_RATE_WORDS = _RATE_WORDS | {"ratio", "proportion", "fraction"}
# Money words (the alias/title of a money measure).
_MONEY_WORDS = frozenset({"revenue", "sales", "amount", "price", "cost", "adr"})
# "rate" next to one of these is a per-unit amount or a change, not a share
# of a whole ("average daily rate", "exchange rate", "growth rate").
_NOT_A_SHARE_WORDS = frozenset({
    "daily", "hourly", "nightly", "weekly", "monthly", "yearly", "annual", "exchange", "interest", "tax", "growth",
    "heart", "bit", "frame", "room", "pay",
})
_FLAG_PREFIXES = ("is", "has", "was", "did", "can", "should")
_FLAG_SUFFIXES = ("flag", "bool", "indicator")
_WORD_RE = re.compile(r"[A-Za-z]+")
_CAMEL_RE = re.compile(r"(?<=[a-z0-9])(?=[A-Z])")


def _word_list(text) -> list[str]:
    """Lower-cased words of an identifier / title, in order: snake_case,
    camelCase, spaces and punctuation all split ("isCanceled" ->
    ["is", "canceled"])."""
    if not isinstance(text, str) or not text:
        return []
    return [w.lower() for w in _WORD_RE.findall(_CAMEL_RE.sub(" ", text))]


def _says_rate(text, max_words: int | None = None) -> bool:
    """True when `text` NAMES a rate: its first or last word is a rate
    word ("cancellation_rate", "pct_canceled", "Repeat guest share") or
    it carries a % sign - and it is not a per-unit amount ("average daily
    rate"). `max_words` keeps a long sentence (a question that merely
    mentions a rate) from counting."""
    words = _word_list(text)
    if not words or (max_words is not None and len(words) > max_words):
        return False
    if set(words) & _NOT_A_SHARE_WORDS:
        return False
    return words[0] in _RATE_WORDS or words[-1] in _RATE_WORDS or "%" in text


def _is_flag_name(column: str) -> bool:
    words = _word_list(column)
    if len(words) < 2:
        return False
    return words[0] in _FLAG_PREFIXES or words[-1] in _FLAG_SUFFIXES


def _type_family(col_type) -> str:
    """"bool" | "int" | "float" | "other" | "unknown" for a schema type
    string of any supported warehouse (INT64, BIGINT, BOOLEAN, FLOAT64,
    NUMERIC(10,2), VARCHAR, DATE, ...)."""
    t = str(col_type or "").strip().lower()
    if not t:
        return "unknown"
    if "bool" in t or t == "bit":
        return "bool"
    if any(k in t for k in ("char", "text", "string", "date", "time", "json", "uuid", "byte", "binary", "array", "struct")):
        return "other"
    if "int" in t and "interval" not in t and "point" not in t:
        return "int"
    if any(k in t for k in ("float", "double", "real", "numeric", "decimal", "number", "money")):
        return "float"
    return "unknown"


# Words that name something a business wants LESS of. Deliberately short
# and unambiguous: "cost"/"time"/"price" are left out (a lower cost is good,
# a lower price is not always), so nothing is flipped on a guess.
_LOWER_IS_BETTER_WORDS = frozenset({
    "cancel", "canceled", "cancelled", "cancellation", "cancellations", "cancelation",
    "churn", "churned", "refund", "refunds", "refunded", "chargeback", "chargebacks",
    "error", "errors", "failure", "failures", "failed", "defect", "defects",
    "complaint", "complaints", "delay", "delays", "delayed", "late", "bounce", "bounced",
    "downtime", "outage", "outages", "overdue", "noshow",
})


def infer_good_direction(spec, title: str | None = None) -> str | None:
    """"down" when a single-measure block clearly counts or rates something
    a business wants less of (cancellations, churn, refunds, errors,
    delays...), else None (the frontend's default is "up"). Looks at the
    measure's alias, its column and a short title (at most 5 words). Pure
    and deterministic; never returns "up" - an unset value already means it."""
    if not isinstance(spec, dict):
        return None
    measures = spec.get("measures")
    if not isinstance(measures, list) or len(measures) != 1 or not isinstance(measures[0], dict):
        return None
    m = measures[0]
    words = set(_word_list(m.get("alias"))) | set(_word_list(m.get("column") if isinstance(m.get("column"), str) else None))
    title_words = _word_list(title)
    if len(title_words) <= 5:
        words |= set(title_words)
    if "no" in words and "show" in words:
        return "down"
    return "down" if words & _LOWER_IS_BETTER_WORDS else None


def infer_number_format(spec, title: str | None = None, schema=None, currency: str | None = None) -> str | None:
    """The display format for a block whose spec has exactly ONE measure,
    or None when it is not certain. Pure and deterministic.

    "percent" (the value is a 0..1 fraction; the frontend renders it x100
    with a % sign) only for an AVG of a plain column (no `expr`) that is a
    0/1 flag:
      - the column is named like a flag (is_*/has_*/was_*/did_*/can_*/
        should_*, *_flag/*_bool/*_indicator) and is not a text/date
        column, or
      - the column is a boolean/integer column per `schema` AND the
        measure's alias, or a short block `title` (at most 4 words),
        NAMES a rate: it starts or ends with rate/share/percent/
        percentage/pct or carries a % sign, and is not a per-unit amount
        such as "daily rate". A longer title (a whole question that
        merely mentions a rate) never counts.
    Never for a column that itself stores a rate (name says rate/pct/
    ratio/...: its scale is unknown), never for sum/count/min/max, never
    when the alias/title also names money.

    "currency" only when the alias/title names money (revenue, sales,
    amount, price, cost, adr), the aggregation keeps the unit (sum/avg/
    min/max) AND the caller knows the currency (`currency`) - with no
    known currency the format is left unset rather than guessed.

    "number"/"compact" are never inferred."""
    if not isinstance(spec, dict):
        return None
    measures = spec.get("measures")
    if not isinstance(measures, list) or len(measures) != 1 or not isinstance(measures[0], dict):
        return None
    m = measures[0]
    agg = str(m.get("agg") or "").lower()
    column = m.get("column") if isinstance(m.get("column"), str) else None
    label_words = set(_word_list(m.get("alias"))) | set(_word_list(title))
    says_rate = _says_rate(m.get("alias")) or _says_rate(title, max_words=4)
    says_money = bool(label_words & _MONEY_WORDS)
    if says_rate and says_money:
        return None

    if agg == "avg" and column and not m.get("expr") and not says_money:
        column_words = set(_word_list(column))
        col_type = None
        for c in table_columns(schema, spec.get("table")) or []:
            if c["name"] == column:
                col_type = c.get("type")
                break
        family = _type_family(col_type)
        if not (column_words & _STORED_RATE_WORDS) and not (column_words & _MONEY_WORDS):
            if _is_flag_name(column) and family != "other":
                return "percent"
            if family in ("bool", "int") and says_rate:
                return "percent"
        return None

    if says_money and not says_rate and agg in ("sum", "avg", "min", "max") and currency:
        return "currency"
    return None
