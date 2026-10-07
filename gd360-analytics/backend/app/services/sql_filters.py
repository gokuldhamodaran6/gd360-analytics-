"""
"Say what was filtered" (2026-10-07, chart-integrity round).

Two answers titled "total revenue" showed 11.67M and 18.87M for the same
year. Both were right: one query had added `WHERE is_canceled = 0` on its
own and the other had not - and nothing on screen said so. This module
reads the SQL that actually ran and lists the row filters it applied, so
every warehouse answer can carry the line

    Filters applied by this query: is_canceled = 0

under its chart title and in its chat answer, and two charts that differ
only by a filter can be told apart at a glance.

What counts as a filter here
    where         each top-level AND-ed predicate of a WHERE clause (of the
                  outer query, of a CTE, of a subquery in FROM)
    conditional   an aggregate that only counts some rows:
                  SUM(CASE WHEN <cond> THEN x ELSE 0 END), COUNT(CASE WHEN
                  <cond> THEN 1 END), SUM(IF/IIF(<cond>, x, 0)),
                  COUNTIF(<cond>), <agg> FILTER (WHERE <cond>)
    having        a HAVING predicate (groups dropped after aggregation)

A filter inside the definition of a SAVED TABLE the query reads from (the
saved-query CTEs routers/chat.py wraps a statement in) is reported as
carried over from that table, by its name.

Parsing is done by sqlglot (pure Python; BigQuery, Snowflake, Postgres,
MySQL and T-SQL dialects), never by regular expressions over SQL text: a
predicate is printed back from the parsed tree, so a comment, a string
literal that contains "WHERE", or a nested query cannot produce a filter
that is not there. When a statement does not parse, the result says so
(`parsed: False`) and NOTHING is claimed about its filters.

The literal predicate is always shown. A plain-words gloss is added only
where the mapping is certain from the predicate alone: a 0/1 flag column
(`is_canceled = 0` -> "canceled rows excluded"), an IS NOT NULL test.
"""
from __future__ import annotations

import json
import re
from typing import Any

try:  # sqlglot is in requirements.txt; the guard only keeps an import error from taking chat down
    import sqlglot
    from sqlglot import exp
except Exception as _e:  # pragma: no cover - exercised only on a broken install
    sqlglot = None
    exp = None
    print(f"[sql_filters] sqlglot is not available, filters will not be reported: {_e}")

_DIALECTS = {
    "bigquery": "bigquery", "snowflake": "snowflake", "postgres": "postgres", "supabase": "postgres",
    "mysql": "mysql", "sqlserver": "tsql",
}
_SIMPLE_IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_MAX_FILTERS = 24
_FLAG_RE = re.compile(r"^(is|has)_([a-z0-9_]+)$|^([a-z0-9_]+)_flag$", re.IGNORECASE)


def dialect_for(kind: str | None) -> str | None:
    return _DIALECTS.get((kind or "").lower())


def _plain(node: Any, dialect: str, single_table: bool) -> str:
    """A predicate printed for a person: identifier quotes dropped where the
    name does not need them, and the table qualifier dropped when the query
    reads one table (h.country -> country)."""
    copy = node.copy()
    for ident in copy.find_all(exp.Identifier):
        if ident.args.get("quoted") and _SIMPLE_IDENT.match(ident.name or ""):
            ident.set("quoted", False)
    if single_table:
        for col in copy.find_all(exp.Column):
            if col.args.get("table") is not None and not col.find_ancestor(exp.Select):
                col.set("table", None)
                col.set("db", None)
                col.set("catalog", None)
    text = re.sub(r"\s+", " ", copy.sql(dialect=dialect)).strip()
    # sqlglot prints "NOT x IS NULL"; people write "x IS NOT NULL".
    m = re.fullmatch(r"NOT (\S+) IS NULL", text)
    return f"{m.group(1)} IS NOT NULL" if m else text


def _conjuncts(node: Any) -> list:
    if isinstance(node, exp.Paren) and isinstance(node.this, exp.And):
        return _conjuncts(node.this)
    if isinstance(node, exp.And):
        return _conjuncts(node.left) + _conjuncts(node.right)
    return [node]


def _own_tables(select: Any) -> list:
    """The tables this SELECT itself reads (its FROM and JOINs) - not the
    ones a nested query reads."""
    out = []
    sources = []
    frm = select.args.get("from") or select.args.get("from_")
    if frm is not None:
        sources.append(frm.this)
    for j in select.args.get("joins") or []:
        sources.append(j.this)
    for src in sources:
        if isinstance(src, exp.Table):
            out.append(src)
    return out


def _table_name(t: Any) -> str:
    return t.name or ""


def _flag_words(column: str) -> str | None:
    m = _FLAG_RE.match(column or "")
    if not m:
        return None
    words = (m.group(2) or m.group(3) or "").replace("_", " ").strip().lower()
    return words or None


def _gloss(node: Any) -> str | None:
    """Plain words for a predicate - ONLY when it is certain from the
    predicate itself. Everything else stays the literal predicate."""
    def col_name(n: Any) -> str | None:
        return n.name if isinstance(n, exp.Column) else None

    def truthy(n: Any) -> bool | None:
        if isinstance(n, exp.Boolean):
            return bool(n.this)
        if isinstance(n, exp.Literal) and not n.is_string and n.this in ("0", "1"):
            return n.this == "1"
        return None

    target = node.this if isinstance(node, exp.Paren) else node
    # `x IS NOT NULL` parses as Is(negate=True) in some dialects and as
    # Not(Is(...)) in others.
    if isinstance(target, exp.Is) and target.args.get("negate") and isinstance(target.expression, exp.Null) and isinstance(target.this, exp.Column):
        return f"rows with no {target.this.name} excluded"
    if isinstance(target, exp.Is) and target.args.get("negate"):
        return None
    if isinstance(target, (exp.EQ, exp.Is)):
        name = col_name(target.left) if isinstance(target, exp.EQ) else col_name(target.this)
        value = truthy(target.right) if isinstance(target, exp.EQ) else truthy(target.expression)
        words = _flag_words(name or "")
        if words and value is not None:
            return f"only {words} rows" if value else f"{words} rows excluded"
    if isinstance(target, exp.NEQ):
        name, value = col_name(target.left), truthy(target.right)
        words = _flag_words(name or "")
        if words and value is not None:
            return f"{words} rows excluded" if value else f"only {words} rows"
    if isinstance(target, exp.Not):
        inner = target.this
        if isinstance(inner, exp.Column) and _flag_words(inner.name):
            return f"{_flag_words(inner.name)} rows excluded"
        if isinstance(inner, exp.Is) and isinstance(inner.expression, exp.Null) and isinstance(inner.this, exp.Column):
            return f"rows with no {inner.this.name} excluded"
    if isinstance(target, exp.Column) and _flag_words(target.name):
        return f"only {_flag_words(target.name)} rows"
    return None


def _conditional_condition(agg: Any) -> Any | None:
    """The row condition of a conditional aggregate, or None."""
    if isinstance(agg, exp.Filter):
        where = agg.expression
        return where.this if isinstance(where, exp.Where) else None
    if exp is not None and hasattr(exp, "CountIf") and isinstance(agg, exp.CountIf):
        return agg.this
    if not isinstance(agg, (exp.Sum, exp.Count, exp.Avg, exp.Min, exp.Max)):
        return None
    arg = agg.this
    if isinstance(arg, exp.Distinct) and arg.expressions:
        arg = arg.expressions[0]
    if isinstance(arg, exp.Case) and not arg.this and len(arg.args.get("ifs") or []) == 1:
        default = arg.args.get("default")
        zero = default is None or isinstance(default, exp.Null) or (isinstance(default, exp.Literal) and not default.is_string and float(default.this or 0) == 0)
        if zero:
            return arg.args["ifs"][0].this
    if isinstance(arg, exp.If):
        default = arg.args.get("false")
        zero = default is None or isinstance(default, exp.Null) or (isinstance(default, exp.Literal) and not default.is_string and float(default.this or 0) == 0)
        if zero:
            return arg.this
    return None


def _sql_filters(sql: str, dialect: str, saved_tables: dict[str, str]) -> dict:
    tree = sqlglot.parse_one(sql, read=dialect)
    saved_lower = {k.lower(): v for k, v in (saved_tables or {}).items()}
    cte_names = {c.alias_or_name.lower() for c in tree.find_all(exp.CTE)}
    filters: list[dict] = []
    seen: set[tuple] = set()
    base_tables: list[str] = []

    def add(kind: str, predicate: str, table: str | None, saved: str | None, label: str | None = None, applies_to: str | None = None) -> None:
        key = (kind, predicate, saved, applies_to)
        if key in seen or len(filters) >= _MAX_FILTERS:
            return
        seen.add(key)
        filters.append({
            "kind": kind, "predicate": predicate, "table": table, "label": label, "applies_to": applies_to,
            "source": "saved_table" if saved else "query", "saved_table": saved,
        })

    for select in tree.find_all(exp.Select):
        cte = select.find_ancestor(exp.CTE)
        saved = saved_lower.get(cte.alias_or_name.lower()) if cte is not None else None
        tables = _own_tables(select)
        for t in tables:
            name = _table_name(t)
            if name and name.lower() not in cte_names and name not in base_tables:
                base_tables.append(name)
        single = len(tables) <= 1
        table = None
        if tables:
            first = _table_name(tables[0])
            table = saved_lower.get(first.lower(), first)
        where = select.args.get("where")
        if where is not None:
            for c in _conjuncts(where.this):
                add("where", _plain(c, dialect, single), table, saved, _gloss(c))
        having = select.args.get("having")
        if having is not None:
            for c in _conjuncts(having.this):
                add("having", _plain(c, dialect, single), table, saved)
        for projection in select.expressions:
            alias = projection.alias_or_name if isinstance(projection, exp.Alias) else None
            for node in projection.walk():
                if node.find_ancestor(exp.Select) is not select:
                    continue
                cond = _conditional_condition(node)
                if cond is not None:
                    add("conditional", _plain(cond, dialect, single), table, saved, _gloss(cond), alias or None)
    return {"parsed": True, "filters": filters, "tables": base_tables}


def _mongo_filters(text: str) -> dict:
    """A MongoDB answer is {"collection", "pipeline"}: the $match stages
    before the first $group are its row filters, shown as written."""
    parsed = json.loads(text)
    pipeline = parsed.get("pipeline") if isinstance(parsed, dict) else None
    if not isinstance(pipeline, list):
        return {"parsed": False, "filters": [], "tables": []}
    filters = []
    for stage in pipeline:
        if not isinstance(stage, dict):
            continue
        if "$group" in stage or "$bucket" in stage or "$count" in stage:
            break
        if "$match" in stage and stage["$match"]:
            filters.append({
                "kind": "where", "predicate": json.dumps(stage["$match"], separators=(", ", ": ")), "table": parsed.get("collection"),
                "label": None, "applies_to": None, "source": "query", "saved_table": None,
            })
    return {"parsed": True, "filters": filters[:_MAX_FILTERS], "tables": [parsed.get("collection")] if parsed.get("collection") else []}


def extract_query_filters(sql: str | None, kind: str | None, saved_tables: dict[str, str] | None = None) -> dict:
    """The row filters of one executed statement.

    `kind` is the data source kind (bigquery / snowflake / postgres /
    supabase / mysql / sqlserver / mongodb). `saved_tables` maps the alias
    of each saved-query table in scope to the name the person knows it by.

    Returns {"parsed": bool, "filters": [...], "tables": [...]} where each
    filter is {"kind": "where" | "conditional" | "having", "predicate",
    "table", "label", "applies_to", "source": "query" | "saved_table",
    "saved_table"}. `parsed` False means the statement could not be read
    and nothing is known about its filters (never "no filters")."""
    empty = {"parsed": False, "filters": [], "tables": []}
    if not sql or not str(sql).strip():
        return empty
    try:
        if (kind or "").lower() == "mongodb":
            return _mongo_filters(sql)
        dialect = dialect_for(kind)
        if sqlglot is None or dialect is None:
            return empty
        return _sql_filters(sql, dialect, saved_tables or {})
    except Exception as e:
        first_line = str(e).splitlines()[0][:200] if str(e) else type(e).__name__
        print(f"[sql_filters] could not read the filters of a {kind} statement (nothing is claimed about them): {first_line}")
        return empty


def _one(f: dict) -> str:
    text = str(f.get("predicate") or "")
    if f.get("kind") == "conditional" and f.get("applies_to"):
        text = f"{f['applies_to']} counts only rows where {text}"
    elif f.get("kind") == "conditional":
        text = f"an aggregate counts only rows where {text}"
    elif f.get("kind") == "having":
        text = f"groups kept only where {text}"
    if f.get("label"):
        text += f" ({f['label']})"
    return text


def describe_filters(info: dict | None) -> str | None:
    """One line for the chat answer and the chart header:
        "Filters applied by this query: is_canceled = 0 (canceled rows excluded)"
        "Filters carried over from the saved table "Revenue by year": ..."
    None when nothing is known (`parsed` False) or there are no filters -
    the caller decides how to say "none"."""
    if not info or not info.get("parsed"):
        return None
    filters = info.get("filters") or []
    if not filters:
        return None
    own = [f for f in filters if f.get("source") != "saved_table"]
    carried: dict[str, list[dict]] = {}
    for f in filters:
        if f.get("source") == "saved_table":
            carried.setdefault(str(f.get("saved_table") or "a saved table"), []).append(f)
    parts = []
    if own:
        parts.append("Filters applied by this query: " + "; ".join(_one(f) for f in own))
    for name, fs in carried.items():
        parts.append(f"Filters carried over from the saved table “{name}”: " + "; ".join(_one(f) for f in fs))
    return ". ".join(parts)


def carried_from_versions(versions: list) -> dict | None:
    """For an answer computed by pandas over saved table(s): the filters
    those tables were built with, read from each table's own cleaning log
    (routers/chat.py records them there when the table is created from a
    warehouse query, and a table built on top of another inherits its
    parent's log). None when no source table recorded any filter
    information - nothing is known, so nothing is claimed."""
    filters: list[dict] = []
    seen: set[tuple] = set()
    known = False
    for v in versions or []:
        name = getattr(v, "name", None) or "a saved table"
        for entry in (getattr(v, "cleaning_log", None) or []):
            if not isinstance(entry, dict) or not isinstance(entry.get("query_filters"), dict):
                continue
            info = entry["query_filters"]
            if not info.get("parsed"):
                continue
            known = True
            for f in info.get("filters") or []:
                if not isinstance(f, dict):
                    continue
                carried_name = f.get("saved_table") if f.get("source") == "saved_table" and f.get("saved_table") else name
                key = (f.get("kind"), f.get("predicate"), f.get("applies_to"))
                if key in seen:
                    continue
                seen.add(key)
                filters.append({**f, "source": "saved_table", "saved_table": carried_name})
    if not known:
        return None
    return {"parsed": True, "filters": filters[:_MAX_FILTERS], "tables": [], "carried": True}
