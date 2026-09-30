"""
2026-09-30 (transformation layer v1): the ONE place a saved transform
(models.DataTransform) - a named, ordered pipeline of small, whitelisted
operations - is actually applied to a real dataframe. Every consumer calls
through THIS module and only this module, so a saved "table" like "Revenue
by region" always means the exact same derived data everywhere it appears
in the app - the same single-source-of-truth guarantee services/metrics.py
already gives a metric (see that module's own docstring; this is the
sibling "T" half of the "worth designing together" note in
claude/gd360-competitive-gap-analysis-2026-09-29.md, gap #4).

Five step types, deliberately small and fixed - never a free-form formula
string or any executable code, matching this app's "small fixed whitelist,
zero code-execution risk" philosophy (services/metrics.py, services/
ml_training.py, dashboard_builder.py's own _MANUAL_AGG_FUNCS):
  - "filter": {"op": "filter", "column": str, "spec": {...}} - one
    criterion, applied through services/metrics.apply_filters (a services-
    to-services import - this app's services/ modules already import from
    each other, e.g. ai_engine.py importing describe_metric/
    match_metric_by_name/resolve_metric_value from this same package; the
    "never import routers from services" rule services/metrics.py's own
    docstring documents is about the ROUTER layer, not this one) rather
    than a fourth copy of that same filter engine.
  - "add_column": {"op": "add_column", "name": str, "left": str,
    "operator": "+" | "-" | "*" | "/", "right_type": "column" | "value",
    "right": str | number} - a derived column from basic arithmetic
    against another column or a constant. Both sides are coerced to
    numeric (pd.to_numeric, errors="coerce" - a non-numeric cell becomes an
    honest NaN, never a fabricated number); division by zero produces NaN
    too (never a fabricated inf), since a NaN is at least honestly "not a
    real number here" and downstream aggregation already treats NaN
    correctly, while inf would silently corrupt a sum/average.
  - "select_columns": {"op": "select_columns", "columns": [str, ...]} -
    keeps only these columns, in this order.
  - "rename_column": {"op": "rename_column", "from": str, "to": str}.
  - "group_by": {"op": "group_by", "by": [str, ...], "aggregations":
    [{"column": str, "agg": "sum"|"avg"|"count"|"min"|"max",
    "output_name": str | None}, ...]} - the same five aggregations every
    other computed feature in this app already offers (AGG_FUNCS below,
    identical to services/metrics.AGG_FUNCS and dashboard_builder.py's own
    _MANUAL_AGG_FUNCS).

apply_transform_steps applies every step in order, each one's output
feeding the next, and - unlike services/metrics.apply_filters, which
defensively SKIPS a malformed filter criterion - fails the WHOLE transform
on the first bad step with a short, honest, step-numbered message. This is
the correct tradeoff here (not an inconsistency with that other module):
a later step in a transform pipeline depends on the exact shape the
previous step produced (a select_columns after a group_by needs THAT
group_by's real output column names), so silently skipping a broken middle
step would hand every step after it a dataframe shape nothing downstream
was actually built for, producing a table that's wrong in a way nobody
asked for or can see coming - a loud, precise failure ("Step 2 (add_column):
...") is the honest choice, exactly like resolve_metric_value's own
"never fabricate, always say plainly what went wrong" standard.
"""
from __future__ import annotations

import pandas as pd

from .metrics import apply_filters

# The same five aggregations services/metrics.AGG_FUNCS and dashboard_
# builder.py's own _MANUAL_AGG_FUNCS already offer - deliberately identical,
# so a group_by step's own aggregation choice is always a 1:1 match with
# every other aggregation picker in this app.
AGG_FUNCS = {"sum": "sum", "avg": "mean", "count": "count", "min": "min", "max": "max"}
AGG_LABELS = {"sum": "Sum", "avg": "Average", "count": "Count", "min": "Min", "max": "Max"}
AGG_NEEDS_NUMERIC = {"sum", "avg"}

ARITH_OPS = {"+": "add", "-": "subtract", "*": "multiply", "/": "divide"}
ARITH_LABELS = {"+": "plus", "-": "minus", "*": "times", "/": "divided by"}

STEP_TYPES = ("filter", "add_column", "select_columns", "rename_column", "group_by")

_MAX_STEPS = 20


def _step_op(step) -> str | None:
    return step.get("op") if isinstance(step, dict) else None


def _apply_filter_step(df: pd.DataFrame, step: dict) -> pd.DataFrame:
    column = step.get("column")
    if not column:
        raise ValueError("No column set for this filter.")
    if column not in df.columns:
        raise ValueError(f'Column "{column}" was not found in this data.')
    return apply_filters(df, [{"column": column, "spec": step.get("spec")}])


def _apply_add_column_step(df: pd.DataFrame, step: dict) -> pd.DataFrame:
    name = (step.get("name") or "").strip()
    left = step.get("left")
    operator = step.get("operator")
    right_type = step.get("right_type") or "value"
    right = step.get("right")

    if not name:
        raise ValueError("No name set for the new column.")
    if operator not in ARITH_OPS:
        raise ValueError(f'Unknown operator "{operator}" - use one of +, -, *, /.')
    if not left or left not in df.columns:
        raise ValueError(f'Column "{left}" was not found in this data.')
    left_series = pd.to_numeric(df[left], errors="coerce")

    if right_type == "column":
        if not right or right not in df.columns:
            raise ValueError(f'Column "{right}" was not found in this data.')
        right_series = pd.to_numeric(df[right], errors="coerce")
    else:
        try:
            right_value = float(right)
        except (TypeError, ValueError):
            raise ValueError(f'"{right}" isn\'t a number.')
        right_series = pd.Series(right_value, index=df.index)

    if operator == "+":
        result = left_series + right_series
    elif operator == "-":
        result = left_series - right_series
    elif operator == "*":
        result = left_series * right_series
    else:  # "/"
        # A zero (or NaN) denominator becomes an honest NaN result rather
        # than a fabricated +/-inf - see this module's own docstring.
        safe_denominator = right_series.where(right_series != 0)
        result = left_series / safe_denominator

    df = df.copy()
    df[name] = result
    return df


def _apply_select_columns_step(df: pd.DataFrame, step: dict) -> pd.DataFrame:
    columns = step.get("columns") or []
    if not columns:
        raise ValueError("Pick at least one column to keep.")
    missing = [c for c in columns if c not in df.columns]
    if missing:
        raise ValueError(f'Column{"s" if len(missing) > 1 else ""} not found: {", ".join(missing)}.')
    return df[list(columns)]


def _apply_rename_column_step(df: pd.DataFrame, step: dict) -> pd.DataFrame:
    old = step.get("from")
    new = (step.get("to") or "").strip()
    if not old or old not in df.columns:
        raise ValueError(f'Column "{old}" was not found in this data.')
    if not new:
        raise ValueError("No new name set for this column.")
    if new != old and new in df.columns:
        raise ValueError(f'A column named "{new}" already exists.')
    return df.rename(columns={old: new})


def _apply_group_by_step(df: pd.DataFrame, step: dict) -> pd.DataFrame:
    by = step.get("by") or []
    aggregations = step.get("aggregations") or []
    if not by:
        raise ValueError("Pick at least one column to group by.")
    missing_by = [c for c in by if c not in df.columns]
    if missing_by:
        raise ValueError(f'Column{"s" if len(missing_by) > 1 else ""} not found: {", ".join(missing_by)}.')
    if not aggregations:
        raise ValueError("Pick at least one column to aggregate.")

    named_aggs = {}
    for a in aggregations:
        column = a.get("column")
        agg = a.get("agg")
        if not column or column not in df.columns:
            raise ValueError(f'Column "{column}" was not found in this data.')
        if agg not in AGG_FUNCS:
            raise ValueError(f'Unknown aggregation "{agg}".')
        if agg in AGG_NEEDS_NUMERIC and not pd.api.types.is_numeric_dtype(df[column]):
            raise ValueError(f'"{column}" isn\'t a numeric column, so it can\'t be summed or averaged.')
        output_name = (a.get("output_name") or "").strip() or f"{agg}_{column}"
        if output_name in named_aggs:
            raise ValueError(f'Two aggregations both produce a column named "{output_name}" - give one a different name.')
        named_aggs[output_name] = pd.NamedAgg(column=column, aggfunc=AGG_FUNCS[agg])

    grouped = df.groupby(list(by), dropna=False).agg(**named_aggs).reset_index()
    return grouped


STEP_HANDLERS = {
    "filter": _apply_filter_step,
    "add_column": _apply_add_column_step,
    "select_columns": _apply_select_columns_step,
    "rename_column": _apply_rename_column_step,
    "group_by": _apply_group_by_step,
}


def apply_transform_steps(df: pd.DataFrame, steps: list[dict] | None) -> tuple[pd.DataFrame | None, str | None]:
    """Applies every step in `steps`, in order, each one's output feeding
    the next - the single canonical computation every consumer listed in
    this module's own docstring calls through. Returns (result_df, error) -
    result_df is a real dataframe on success; on any problem, result_df is
    None and error is a short, honest, step-numbered message safe to show
    as-is. Never raises. An empty/None `steps` list is a no-op (the
    original data, unchanged) - a transform with no steps yet is a valid,
    if not yet useful, thing to have saved."""
    if not steps:
        return df, None
    if len(steps) > _MAX_STEPS:
        return None, f"A transform can have at most {_MAX_STEPS} steps."
    result = df
    for i, step in enumerate(steps):
        op = _step_op(step)
        handler = STEP_HANDLERS.get(op or "")
        if not handler:
            return None, f'Step {i + 1}: unknown operation "{op}".'
        try:
            result = handler(result, step)
        except ValueError as e:
            return None, f"Step {i + 1} ({op}): {e}"
        except Exception as e:
            return None, f"Step {i + 1} ({op}): couldn't apply this step: {e}"
    return result, None


def describe_transform_step(step: dict) -> str | None:
    """One short, honest, plain-English line describing a single step -
    used by describe_transform below, and mirrored by the frontend's own
    describeTransformStep() so the builder's own summary line never
    disagrees with what the AI is told. Returns None for a step with
    nothing meaningful to describe yet (still being filled in)."""
    op = _step_op(step)
    if op == "filter":
        column = step.get("column")
        return f"Filter where {column} matches the given criteria" if column else None
    if op == "add_column":
        name, left, operator, right_type, right = (
            step.get("name"), step.get("left"), step.get("operator"), step.get("right_type"), step.get("right"),
        )
        if not (name and left and operator in ARITH_OPS):
            return None
        right_label = right if right_type == "column" else right
        if right_label in (None, ""):
            return None
        return f'Add column "{name}" = {left} {ARITH_LABELS[operator]} {right_label}'
    if op == "select_columns":
        columns = step.get("columns") or []
        if not columns:
            return None
        shown = ", ".join(columns[:6])
        more = f" (+{len(columns) - 6} more)" if len(columns) > 6 else ""
        return f"Keep only: {shown}{more}"
    if op == "rename_column":
        old, new = step.get("from"), step.get("to")
        return f'Rename "{old}" to "{new}"' if old and new else None
    if op == "group_by":
        by = step.get("by") or []
        aggregations = step.get("aggregations") or []
        if not by or not aggregations:
            return None
        by_text = ", ".join(by)
        agg_parts = [
            f'{AGG_LABELS.get(a.get("agg"), a.get("agg"))} of {a.get("column")}'
            for a in aggregations if a.get("column") and a.get("agg") in AGG_FUNCS
        ]
        if not agg_parts:
            return None
        return f"Group by {by_text}, computing {', '.join(agg_parts)}"
    return None


def describe_transform(steps: list[dict] | None) -> list[str]:
    """Every step's own plain-English line, in order - the one shared,
    honest step summary used both by routers/transforms.py's API response
    (mirrored by the frontend builder) and services/ai_engine.py's
    prompt-injected glossary note. Never computes anything itself - purely
    descriptive, so it never disagrees with what apply_transform_steps
    actually does (both are driven from the exact same `steps` list)."""
    if not steps:
        return []
    lines = []
    for step in steps:
        line = describe_transform_step(step)
        if line:
            lines.append(line)
    return lines
