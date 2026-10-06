"""
Saved-query tables for warehouse sources (2026-10-06, "generated data is a
saved query" layer).

For a warehouse/database data source (BigQuery, Snowflake, Postgres, MySQL,
SQL Server, Supabase) GD360 never loads rows into the app. A "generated"
table - "keep only non-canceled bookings and add a total nights column" -
is therefore NOT a copied dataset: it is ONE standalone, read-only SELECT
stored on a DatasetVersion (source_kind="warehouse_query", query_sql) and
re-run inside the warehouse whenever the table is used (profiled, sampled,
downloaded, or asked a follow-up question). The founder's words: "generated
data from a prompt is a saved query on top of the original, still inside
BigQuery."

This module holds every PURE text helper that layer needs - nothing here
touches a database, a connector or a language model, so all of it is unit
testable with plain strings:

  - sql_alias derivation (`derive_sql_alias`): a safe identifier a saved
    query is referenced by in later SQL (`WITH <alias> AS (<query_sql>)`).
  - CTE handling: `split_leading_ctes` / `wrap_with_ctes` turn "a question
    on a saved query" into one statement, and ALWAYS flatten nested WITHs
    to the top level (hoisting) - SQL Server rejects a WITH inside a
    derived table, and a definition that is itself `WITH ... SELECT` must
    stay usable as a CTE body everywhere. A stored `query_sql` is always
    flat: optional top-level `WITH a AS (...), b AS (...)` then one SELECT,
    with every CTE's text inlined, so a stored definition never depends on
    another DatasetVersion at run time (a deleted parent cannot break a
    child).
  - Per-dialect wrappers around a definition: the zero-row validation
    statement, `COUNT(*)`, the n-row sample, and the subquery FROM clause
    the Data-tab profile uses.
  - Parsing the table-SQL writer's answer (`-- name: ...` trailer) and the
    result-schema capture helpers used by the connectors' describe_query.
"""
from __future__ import annotations

import re

SQL_ALIAS_MAX_LEN = 40
TABLE_NAME_MAX_LEN = 60
SUBQUERY_ALIAS = "gd360_v"

# Words that are reserved in at least one supported dialect and would make an
# unquoted CTE alias ambiguous. Not exhaustive on purpose - an alias only
# needs to be *unambiguous*, and the `_t` suffix keeps it that way.
_RESERVED_WORDS = {
    "select", "from", "where", "with", "table", "as", "and", "or", "not", "in", "is", "null", "join",
    "on", "group", "order", "by", "limit", "union", "all", "having", "distinct", "case", "when", "then",
    "else", "end", "true", "false", "left", "right", "inner", "outer", "full", "cross", "using", "top",
    "offset", "fetch", "values", "exists", "between", "like", "desc", "asc", "recursive", "window",
    "over", "partition", "user", "current", "default", "primary", "key", "index", "view", "data",
}


class CteConflict(ValueError):
    """Two CTEs with the same name but different bodies were asked to share
    one statement - the SQL writer reused a saved query's alias for its own
    CTE, or two chained definitions disagree about a hoisted parent."""


# --- naming ---------------------------------------------------------------

def derive_sql_alias(name: str | None, existing: "set[str] | list[str] | None" = None) -> str:
    """A safe identifier for a saved query: lowercase, [a-z0-9_], starts
    with a letter, at most SQL_ALIAS_MAX_LEN chars, unique within
    `existing` (case-insensitive) - "_2", "_3", ... appended on collision,
    always fitting inside the length cap."""
    taken = {str(e).lower() for e in (existing or [])}
    base = re.sub(r"[^a-z0-9_]+", "_", (name or "").lower())
    base = re.sub(r"_+", "_", base).strip("_")
    if not base:
        base = "query"
    if not base[0].isalpha():
        base = "t_" + base
    base = base[:SQL_ALIAS_MAX_LEN].rstrip("_") or "query"
    if base in _RESERVED_WORDS:
        base = (base[: SQL_ALIAS_MAX_LEN - 2] + "_t")
    if base not in taken:
        return base
    n = 2
    while True:
        suffix = f"_{n}"
        candidate = base[: SQL_ALIAS_MAX_LEN - len(suffix)].rstrip("_") + suffix
        if candidate not in taken:
            return candidate
        n += 1


def derive_table_name(prompt: str | None, fallback: str = "Generated table") -> str:
    """Fallback display name for a saved query when the SQL writer did not
    supply one: the prompt, whitespace-normalised, capitalised, capped at
    TABLE_NAME_MAX_LEN."""
    text = " ".join((prompt or "").split())
    if not text:
        return fallback
    text = text[0].upper() + text[1:]
    if len(text) > TABLE_NAME_MAX_LEN:
        text = text[: TABLE_NAME_MAX_LEN - 1].rstrip() + "…"
    return text


_NAME_LINE_RE = re.compile(r"^[ \t]*--[ \t]*name[ \t]*:[ \t]*(.+?)[ \t]*$", re.IGNORECASE | re.MULTILINE)
_NOT_POSSIBLE_MARKERS = {"NOT_POSSIBLE", "NEEDS_TABLE"}


def parse_table_sql_response(raw: str | None) -> tuple[str | None, str | None]:
    """Parses the table-SQL writer's answer into (sql, name). Strips a
    markdown fence, lifts the `-- name: <...>` trailer line out of the SQL
    (so the stored definition never carries it), trims whitespace and a
    trailing semicolon. Returns (None, None) for an empty answer or the
    NOT_POSSIBLE marker."""
    text = (raw or "").strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text[:3].lower() == "sql":
            text = text[3:]
        text = text.strip()
    name = None
    m = _NAME_LINE_RE.search(text)
    if m:
        name = " ".join(m.group(1).split())[:TABLE_NAME_MAX_LEN] or None
        text = (text[: m.start()] + text[m.end():]).strip()
    text = strip_trailing_semicolon(text)
    if not text or text.upper() in _NOT_POSSIBLE_MARKERS:
        return None, name
    return text, name


def strip_trailing_semicolon(sql: str) -> str:
    return (sql or "").strip().rstrip(";").strip()


# --- SQL text scanning ----------------------------------------------------

def _skip_ws_and_comments(s: str, i: int) -> int:
    n = len(s)
    while i < n:
        c = s[i]
        if c in " \t\r\n":
            i += 1
        elif s.startswith("--", i):
            j = s.find("\n", i)
            i = n if j < 0 else j + 1
        elif s.startswith("/*", i):
            j = s.find("*/", i + 2)
            i = n if j < 0 else j + 2
        else:
            break
    return i


def _skip_quoted(s: str, i: int) -> int:
    """`i` points at an opening quote char ('"`[); returns the index just
    past the matching close (doubled quotes inside '...' and "..." are
    escapes). Unterminated -> end of string."""
    q = s[i]
    close = "]" if q == "[" else q
    n = len(s)
    i += 1
    while i < n:
        if s[i] == close:
            if close in ("'", '"') and i + 1 < n and s[i + 1] == close:
                i += 2
                continue
            return i + 1
        i += 1
    return n


def _find_matching_paren(s: str, i: int) -> int:
    """`i` points at '('; returns the index of its matching ')' or -1."""
    depth = 0
    n = len(s)
    while i < n:
        c = s[i]
        if c in "'\"`[":
            i = _skip_quoted(s, i)
            continue
        if s.startswith("--", i) or s.startswith("/*", i):
            i = _skip_ws_and_comments(s, i)
            continue
        if c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return -1


_IDENT_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_$]*")


def _read_identifier(s: str, i: int) -> tuple[str | None, int]:
    """Reads one identifier (bare or quoted) at `i`; returns (bare_name,
    index after it). bare_name is the unquoted text."""
    if i >= len(s):
        return None, i
    c = s[i]
    if c in "\"`[":
        j = _skip_quoted(s, i)
        return s[i + 1: j - 1], j
    m = _IDENT_RE.match(s, i)
    if not m:
        return None, i
    return m.group(0), m.end()


def split_leading_ctes(sql: str) -> tuple[list[tuple[str, str, str]], str, bool]:
    """Splits a statement into its top-level CTE list and its main body.
    Returns (ctes, main_sql, recursive) where each CTE is (bare_alias,
    alias_declaration_text, body_sql) - alias_declaration_text is exactly
    what stood before `AS` (so a quoted alias or a column list is kept
    verbatim). A statement with no leading WITH comes back as ([], sql,
    False). Anything this scanner cannot parse is returned unsplit, never
    raised - the warehouse itself is the authority on syntax."""
    s = strip_trailing_semicolon(sql)
    i = _skip_ws_and_comments(s, 0)
    m = re.compile(r"with\b", re.IGNORECASE).match(s, i)
    if not m:
        return [], s, False
    i = m.end()
    recursive = False
    j = _skip_ws_and_comments(s, i)
    mr = re.compile(r"recursive\b", re.IGNORECASE).match(s, j)
    if mr:
        recursive = True
        i = mr.end()
    ctes: list[tuple[str, str, str]] = []
    while True:
        i = _skip_ws_and_comments(s, i)
        decl_start = i
        alias, i = _read_identifier(s, i)
        if not alias:
            return [], s, False
        # Optional column list "(a, b)" between the alias and AS.
        k = _skip_ws_and_comments(s, i)
        if k < len(s) and s[k] == "(":
            close = _find_matching_paren(s, k)
            if close < 0:
                return [], s, False
            i = close + 1
        k = _skip_ws_and_comments(s, i)
        mas = re.compile(r"as\b", re.IGNORECASE).match(s, k)
        if not mas:
            return [], s, False
        decl_text = s[decl_start:k].strip()
        i = mas.end()
        # Postgres: AS [NOT] MATERIALIZED (
        k = _skip_ws_and_comments(s, i)
        mm = re.compile(r"(not\s+)?materialized\b", re.IGNORECASE).match(s, k)
        if mm:
            i = mm.end()
            k = _skip_ws_and_comments(s, i)
        if k >= len(s) or s[k] != "(":
            return [], s, False
        close = _find_matching_paren(s, k)
        if close < 0:
            return [], s, False
        body = s[k + 1: close].strip()
        ctes.append((alias, decl_text, body))
        i = _skip_ws_and_comments(s, close + 1)
        if i < len(s) and s[i] == ",":
            i += 1
            continue
        main = s[i:].strip()
        if not main:
            return [], s, False
        return ctes, main, recursive


def _normalize_sql(sql: str) -> str:
    return " ".join((sql or "").split()).lower()


def wrap_with_ctes(statement: str, ctes: list[tuple[str, str]]) -> str:
    """ONE flat statement: `WITH <alias> AS (<query_sql>), ... <statement>`.
    Every CTE in `ctes` is (alias, query_sql); a query_sql that itself
    starts with WITH has its own CTEs hoisted in front (recursively flat),
    and a `statement` that starts with WITH has its CTEs appended after
    the version aliases (they may reference them). Duplicate aliases with
    identical bodies collapse to one; a duplicate alias with a different
    body raises CteConflict. With no CTEs the statement is returned
    unchanged (minus a trailing semicolon)."""
    out: list[tuple[str, str]] = []  # (declaration, body)
    seen: dict[str, str] = {}
    recursive = False

    def add(alias: str, decl: str, body: str) -> None:
        key = alias.lower()
        norm = _normalize_sql(body)
        if key in seen:
            if seen[key] != norm:
                raise CteConflict(
                    f"The name {alias!r} is already used for a saved query in this request; "
                    "give your own CTE a different name."
                )
            return
        seen[key] = norm
        out.append((decl, body))

    for alias, sql in ctes:
        inner, main, rec = split_leading_ctes(sql)
        recursive = recursive or rec
        for a, d, b in inner:
            add(a, d, b)
        add(alias, alias, main)
    stmt_ctes, stmt_main, rec = split_leading_ctes(statement)
    recursive = recursive or rec
    for a, d, b in stmt_ctes:
        add(a, d, b)
    if not out:
        return stmt_main
    keyword = "WITH RECURSIVE " if recursive else "WITH "
    return keyword + ", ".join(f"{decl} AS ({body})" for decl, body in out) + " " + stmt_main


def split_definition(sql: str) -> tuple[str, str]:
    """(with_prefix, body) for a stored definition: with_prefix is
    "WITH a AS (...), ... " (trailing space) or "" - so any wrapper is
    `with_prefix + "<template around body>"`, which keeps the CTEs at the
    top level of the final statement (valid on every dialect, including
    SQL Server, which rejects a WITH inside a derived table)."""
    ctes, main, recursive = split_leading_ctes(sql)
    if not ctes:
        return "", main
    keyword = "WITH RECURSIVE " if recursive else "WITH "
    return keyword + ", ".join(f"{decl} AS ({body})" for _, decl, body in ctes) + " ", main


# --- per-dialect wrappers around a definition ------------------------------

def zero_row_validation_sql(kind: str, sql: str) -> str:
    """The statement that validates a definition without reading a row:
    SQL Server `SELECT TOP 0 * FROM (<body>) AS gd360_v`, Snowflake
    `... LIMIT 0`, every other SQL kind `... WHERE 1=0`. (BigQuery
    validates through its free dry run of the definition itself - see
    BigQueryConnector.describe_query - but this wrapper is valid there
    too.)"""
    prefix, body = split_definition(sql)
    if kind == "sqlserver":
        return f"{prefix}SELECT TOP 0 * FROM ({body}) AS {SUBQUERY_ALIAS}"
    if kind == "snowflake":
        return f"{prefix}SELECT * FROM ({body}) AS {SUBQUERY_ALIAS} LIMIT 0"
    return f"{prefix}SELECT * FROM ({body}) AS {SUBQUERY_ALIAS} WHERE 1=0"


def count_sql(kind: str, sql: str) -> str:
    prefix, body = split_definition(sql)
    return f"{prefix}SELECT COUNT(*) AS gd360_n FROM ({body}) AS {SUBQUERY_ALIAS}"


def sample_sql(kind: str, sql: str, n: int) -> str:
    n = max(1, int(n))
    prefix, body = split_definition(sql)
    if kind == "sqlserver":
        return f"{prefix}SELECT TOP {n} * FROM ({body}) AS {SUBQUERY_ALIAS}"
    return f"{prefix}SELECT * FROM ({body}) AS {SUBQUERY_ALIAS} LIMIT {n}"


def subquery_from_clause(kind: str, sql: str) -> tuple[str, str]:
    """(with_prefix, "(<body>) AS gd360_v") - what profiling.build_profile_
    query / build_top_values_query take as `from_clause`; the caller
    prepends with_prefix to the finished statement."""
    prefix, body = split_definition(sql)
    return prefix, f"({body}) AS {SUBQUERY_ALIAS}"


def count_from_frame(df) -> int | None:
    """The COUNT(*) out of a one-row result frame (column name
    case-insensitive: Snowflake upper-cases unquoted aliases)."""
    try:
        if df is None or not len(df):
            return None
        row = {str(k).lower(): v for k, v in df.iloc[0].to_dict().items()}
        v = row.get("gd360_n")
        if v is None:
            v = next(iter(row.values()))
        return int(v)
    except Exception:
        return None


# --- schema capture -------------------------------------------------------

def columns_from_bq_schema(schema_fields) -> list[dict]:
    """[{name, type}] from a BigQuery job's `schema` (SchemaField list)."""
    out: list[dict] = []
    for f in schema_fields or []:
        name = getattr(f, "name", None)
        ftype = getattr(f, "field_type", None) or getattr(f, "type", None) or "STRING"
        mode = (getattr(f, "mode", None) or "").upper()
        if name is None:
            continue
        out.append({"name": str(name), "type": f"ARRAY<{ftype}>" if mode == "REPEATED" else str(ftype)})
    return out


def _psycopg2_type_name(code) -> str | None:
    try:
        from psycopg2 import extensions
        t = extensions.string_types.get(code)
        return t.name.lower() if t is not None else None
    except Exception:
        return None


def _pymysql_type_name(code) -> str | None:
    try:
        from pymysql.constants import FIELD_TYPE
        names = {v: k for k, v in vars(FIELD_TYPE).items() if isinstance(v, int)}
        name = names.get(code)
        return name.lower() if name else None
    except Exception:
        return None


_PYMSSQL_TYPES = {1: "string", 2: "binary", 3: "number", 4: "datetime", 5: "decimal"}


def _snowflake_type_name(code) -> str | None:
    try:
        from snowflake.connector.constants import FIELD_ID_TO_NAME
        name = FIELD_ID_TO_NAME.get(code)
        return str(name) if name else None
    except Exception:
        return None


def columns_from_cursor_description(kind: str, description) -> list[dict]:
    """[{name, type}] from a DB-API cursor.description after a zero-row
    run. Type names are best-effort per driver (psycopg2 OID names, pymysql
    FIELD_TYPE names, pymssql's five codes, Snowflake's FIELD_ID_TO_NAME);
    an unmappable code becomes "unknown" rather than failing validation."""
    out: list[dict] = []
    for col in description or []:
        try:
            name = col[0]
            code = col[1] if len(col) > 1 else None
        except Exception:
            continue
        if name is None:
            continue
        type_name = None
        if kind in ("postgres", "supabase"):
            type_name = _psycopg2_type_name(code)
        elif kind == "mysql":
            type_name = _pymysql_type_name(code)
        elif kind == "sqlserver":
            type_name = _PYMSSQL_TYPES.get(code)
        elif kind == "snowflake":
            type_name = _snowflake_type_name(code)
        if not type_name and isinstance(code, str):
            type_name = code
        out.append({"name": str(name), "type": type_name or "unknown"})
    return out


def detect_source_table(sql: str, table_names) -> str | None:
    """The first real table name of this data source that `sql` mentions
    (whole-word, case-insensitive) - what a saved query "ultimately reads".
    None when none matches."""
    text = sql or ""
    for name in table_names or []:
        if not isinstance(name, str) or not name:
            continue
        if re.search(r"(?<![A-Za-z0-9_])" + re.escape(name) + r"(?![A-Za-z0-9_])", text, re.IGNORECASE):
            return name
    return None


def versions_schema_text(versions) -> str:
    """The schema lines a SQL writer sees for selected saved queries - the
    same `Table \\`<name>\\`:` shape as routers/chat._multi_table_schema_text
    so one list of tables reads uniformly, plus the note that this one is
    a saved query (reference it by its alias, exactly as spelled)."""
    lines: list[str] = []
    for v in versions or []:
        alias = getattr(v, "sql_alias", None)
        if not alias:
            continue
        source = getattr(v, "source_table", None)
        label = f" (a saved query named \"{getattr(v, 'name', alias)}\""
        label += f" on top of {source})" if source else ")"
        lines.append(f"Table `{alias}`{label}:")
        for col in getattr(v, "columns_json", None) or []:
            if isinstance(col, dict) and col.get("name") is not None:
                lines.append(f"  - {col.get('name')} ({col.get('type')})")
    return "\n".join(lines)
