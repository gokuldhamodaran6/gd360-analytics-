"""
Static checks on every query a plan contains, before anything runs.

A step's SQL must be exactly one read-only SELECT (or WITH ... SELECT /
UNION of SELECTs) in its source's dialect, and may only read tables that
the catalog lists for that source (plus its own CTEs). A combine step may
only read the outputs of earlier steps. Column-level mistakes are left to
the engine itself - the warehouse's free dry run, or DuckDB - whose error
goes back to the language model for one bounded repair (planner.repair_sql).

`ensure_row_cap` adds an outer LIMIT when the query has none, so a step
never pulls an unbounded result out of a warehouse.
"""
from __future__ import annotations

import sqlglot
from sqlglot import exp

from .catalog import CatalogSource

ROW_CAP = 5000

_FORBIDDEN = (
    exp.Insert, exp.Update, exp.Delete, exp.Create, exp.Drop, exp.Alter, exp.Merge, exp.Command,
    exp.TruncateTable, exp.Grant,
)


class PlanSQLError(ValueError):
    """A query in the plan that must not run as written."""


def _parse(sql: str, dialect: str) -> exp.Expression:
    text = (sql or "").strip().rstrip(";").strip()
    if not text:
        raise PlanSQLError("The query is empty.")
    try:
        trees = sqlglot.parse(text, read=dialect)
    except Exception as e:  # noqa: BLE001
        raise PlanSQLError(f"The query could not be read as {dialect} SQL: {str(e).splitlines()[0][:300]}") from e
    trees = [t for t in trees if t is not None]
    if len(trees) != 1:
        raise PlanSQLError("Exactly one SELECT statement is allowed per step.")
    tree = trees[0]
    if not isinstance(tree, (exp.Select, exp.Union, exp.Subquery)) and not (
        isinstance(tree, exp.Query)
    ):
        raise PlanSQLError("Only SELECT queries are allowed.")
    for node in tree.walk():
        if isinstance(node, _FORBIDDEN):
            raise PlanSQLError("Only read-only SELECT queries are allowed.")
    return tree


def _cte_names(tree: exp.Expression) -> set[str]:
    return {c.alias_or_name.lower() for c in tree.find_all(exp.CTE)}


def _table_refs(tree: exp.Expression) -> list[exp.Table]:
    ctes = _cte_names(tree)
    out = []
    for t in tree.find_all(exp.Table):
        name = (t.name or "").lower()
        if not name or name in ctes:
            continue
        # table-valued functions (UNNEST, GENERATE_SERIES ...) are not tables
        if isinstance(t.this, exp.Func):
            continue
        out.append(t)
    return out


def check_step_sql(sql: str, source: CatalogSource) -> str:
    """Raises PlanSQLError, or returns the SQL (unchanged)."""
    tree = _parse(sql, source.dialect)
    refs = _table_refs(tree)
    if not refs:
        raise PlanSQLError("The query does not read any table of this source.")
    known = {t.name.lower() for t in source.tables}
    known_last = {t.name.lower().split(".")[-1] for t in source.tables}
    for t in refs:
        full = ".".join(p for p in (t.catalog, t.db, t.name) if p).lower()
        if full in known or t.name.lower() in known or t.name.lower() in known_last:
            continue
        listed = ", ".join(sorted(x.name for x in source.tables)[:20]) or "none"
        raise PlanSQLError(f'Table "{t.name}" is not in {source.name}. Tables available: {listed}.')
    return sql


def check_combine_sql(sql: str, available: set[str]) -> str:
    tree = _parse(sql, "duckdb")
    refs = _table_refs(tree)
    if not refs:
        raise PlanSQLError("A combine step must read the results of earlier steps.")
    for t in refs:
        if t.name.lower() not in {a.lower() for a in available}:
            raise PlanSQLError(
                f'"{t.name}" is not an earlier step. A combine step can read: {", ".join(sorted(available))}.'
            )
    return sql


def has_limit(sql: str, dialect: str) -> bool:
    try:
        tree = _parse(sql, dialect)
    except PlanSQLError:
        return False
    if isinstance(tree, exp.Select):
        return tree.args.get("limit") is not None or (
            dialect == "tsql" and bool(tree.args.get("top") or tree.args.get("limit"))
        )
    if isinstance(tree, exp.Union):
        return tree.args.get("limit") is not None
    return False


def ensure_row_cap(sql: str, dialect: str, cap: int = ROW_CAP) -> str:
    """The query with an outer LIMIT cap+1 when it has none (cap+1 so a
    truncated result can be recognised). Falls back to the original text if
    the query cannot be rewritten - the result is truncated after fetching
    in that case."""
    if has_limit(sql, dialect):
        return sql
    try:
        tree = _parse(sql, dialect)
        if isinstance(tree, (exp.Select, exp.Union)):
            return tree.limit(cap + 1).sql(dialect=dialect)
    except Exception:  # noqa: BLE001
        pass
    return sql
