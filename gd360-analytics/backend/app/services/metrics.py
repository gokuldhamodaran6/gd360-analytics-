"""
2026-09-30 (semantic layer v1): the ONE place a "metric" - a named,
reusable column + aggregation + filter definition (models.MetricDefinition)
- is actually resolved into a real number against a real dataframe.

Every consumer calls through THIS module and only this module, so a metric
like "Revenue" always means the exact same computation everywhere it
appears in the app - the entire point of a semantic layer (see
claude/gd360-competitive-gap-analysis-2026-09-29.md, gap #6, "the single
highest-leverage gap"). The consumers, as of this round:
  - routers/metric_definitions.py - a metric's own live "current value"
    shown right on its definition.
  - routers/dashboard_builder.py - a kpi/gauge block built FROM a saved
    metric (config["metric_id"] set) recomputes through resolve_metric_value
    every time it's built or a page filter changes, instead of freezing a
    one-shot number the way a plain column+aggregation kpi already does.
  - services/ai_engine.py - a deterministic (zero-LLM-call) exact answer
    for "what is my <metric>"-style questions (match_metric_by_name +
    resolve_metric_value), AND a plain-English glossary note
    (describe_metric) appended to every AI-planned question's own prompt,
    so even a free-form question that asks for a breakdown/trend built
    from a named metric is told the exact formula to use for it.

_apply_filter_criterion/apply_filters below are a deliberate, documented
DUPLICATE of routers/datasources.py's _apply_column_filter (and routers/
dashboard_builder.py's own _apply_filters, which already wraps that same
function) - not a shared import. This app's services/ modules have never
imported from routers/ anywhere in this codebase; the dependency direction
only ever runs the other way (a router imports a service). Inverting that
just for one helper function was not worth breaking an otherwise
exceptionless rule. Both copies accept the exact same filter-spec
vocabulary - the Data tab's own ColumnFilterSpec shape ("values" / "text" /
"number" / "date" / "boolean", see routers/datasources.py's
_apply_column_filter docstring for the full shape of each) - on purpose;
if that vocabulary ever grows a new operator, add it in both places, the
same tradeoff routers/dashboard_builder.py's own _apply_filters docstring
already accepts for ITS relationship to routers/datasources.py's copy.
"""
from __future__ import annotations

import re

import pandas as pd

# The same five aggregations routers/dashboard_builder.py's manual-build
# form already offers (_MANUAL_AGG_FUNCS there) - deliberately the same
# small, user-facing vocabulary, so "save this KPI as a reusable metric"
# is always a 1:1 translation, never a lossy one.
AGG_FUNCS = {"sum": "sum", "avg": "mean", "count": "count", "min": "min", "max": "max"}
AGG_LABELS = {"sum": "Sum", "avg": "Average", "count": "Count", "min": "Min", "max": "Max"}
AGG_NEEDS_NUMERIC = {"sum", "avg"}


def _apply_filter_criterion(df: pd.DataFrame, column: str, spec) -> pd.DataFrame:
    """Mirrors routers/datasources.py's _apply_column_filter exactly - see
    this module's own docstring for why this is a deliberate duplicate
    rather than an import. Keep both in sync if the filter-spec vocabulary
    ever changes."""
    if isinstance(spec, str):
        needle = spec
        if needle:
            return df[df[column].astype(str).str.contains(str(needle), case=False, na=False, regex=False)]
        return df
    if not isinstance(spec, dict):
        return df
    kind = spec.get("type")

    if kind == "values":
        include = spec.get("include") or []
        if not include:
            return df
        wants_null = any(v is None for v in include)
        want_strs = {str(v) for v in include if v is not None}
        as_str = df[column].astype(str)
        mask = as_str.isin(want_strs) if want_strs else pd.Series(False, index=df.index)
        if wants_null:
            mask = mask | df[column].isna()
        return df[mask]

    if kind == "text":
        op = spec.get("op")
        value = str(spec.get("value") or "")
        as_str = df[column].astype(str)
        if op == "contains":
            return df[as_str.str.contains(value, case=False, na=False, regex=False)]
        if op == "not_contains":
            return df[~as_str.str.contains(value, case=False, na=False, regex=False)]
        if op == "equals":
            return df[as_str.str.lower() == value.lower()]
        if op == "not_equals":
            return df[as_str.str.lower() != value.lower()]
        if op == "starts_with":
            return df[as_str.str.lower().str.startswith(value.lower())]
        if op == "ends_with":
            return df[as_str.str.lower().str.endswith(value.lower())]
        if op == "is_empty":
            return df[df[column].isna() | (as_str.str.strip() == "")]
        if op == "is_not_empty":
            return df[~(df[column].isna() | (as_str.str.strip() == ""))]
        return df

    if kind == "number":
        op = spec.get("op")
        numeric = pd.to_numeric(df[column], errors="coerce")

        def _num(key):
            raw = spec.get(key)
            if raw in (None, ""):
                return None
            try:
                return float(raw)
            except (TypeError, ValueError):
                return None

        value = _num("value")
        value2 = _num("value2")
        if op == "between":
            if value is None or value2 is None:
                return df
            lo, hi = min(value, value2), max(value, value2)
            return df[(numeric >= lo) & (numeric <= hi)]
        if value is None:
            return df
        if op == "eq":
            return df[numeric == value]
        if op == "neq":
            return df[numeric != value]
        if op == "gt":
            return df[numeric > value]
        if op == "gte":
            return df[numeric >= value]
        if op == "lt":
            return df[numeric < value]
        if op == "lte":
            return df[numeric <= value]
        return df

    if kind == "date":
        dt = pd.to_datetime(df[column], errors="coerce")
        mask = pd.Series(True, index=df.index)
        from_str, to_str = spec.get("from"), spec.get("to")
        if from_str:
            try:
                mask &= dt >= pd.Timestamp(from_str)
            except Exception:
                pass
        if to_str:
            try:
                end = pd.Timestamp(to_str) + pd.Timedelta(days=1) - pd.Timedelta(seconds=1)
                mask &= dt <= end
            except Exception:
                pass
        return df[mask]

    if kind == "boolean":
        value = spec.get("value")
        if value == "true":
            return df[df[column] == True]  # noqa: E712
        if value == "false":
            return df[df[column] == False]  # noqa: E712
        return df

    return df


def apply_filters(df: pd.DataFrame, filters: list | None) -> pd.DataFrame:
    """Applies every filter criterion in `filters`, AND'd together - see
    _apply_filter_criterion above. A filter whose column isn't actually in
    this dataframe, or whose spec is malformed, is skipped rather than
    raising - matching routers/dashboard_builder.py's own _apply_filters
    tradeoff (defensive against a metric's saved filter surviving a data
    source's column being renamed or removed)."""
    if not filters:
        return df
    for f in filters:
        column = f.get("column") if isinstance(f, dict) else getattr(f, "column", None)
        spec = f.get("spec") if isinstance(f, dict) else getattr(f, "spec", None)
        if not column or column not in df.columns:
            continue
        try:
            df = _apply_filter_criterion(df, column, spec)
        except Exception:
            continue
    return df


def resolve_metric_value(
    df: pd.DataFrame, metric_column: str | None, agg: str | None, filters: list | None = None,
) -> tuple[float | int | None, str | None]:
    """Computes ONE metric definition's real value against `df` - the
    single canonical computation every consumer listed in this module's
    own docstring calls through, so the exact same metric always produces
    the exact same number wherever it's shown. Returns (value, error) -
    value is a plain, JSON-safe Python number (never a numpy scalar) on
    success; on any problem, value is None and error is a short, honest
    message safe to show as-is. Never raises - a caller resolving several
    metrics at once (or checking whether a chat question can be answered
    by this exact shortcut) can skip a broken one without the whole
    request failing."""
    if not metric_column or agg not in AGG_FUNCS:
        return None, f'Unknown aggregation "{agg}".' if metric_column else "No column set for this metric."
    if metric_column not in df.columns:
        return None, f'Column "{metric_column}" was not found in this data.'
    filtered = apply_filters(df, filters)
    if agg in AGG_NEEDS_NUMERIC and not pd.api.types.is_numeric_dtype(filtered[metric_column]):
        return None, f'"{metric_column}" isn\'t a numeric column, so it can\'t be summed or averaged.'
    if filtered.empty:
        # A count of an empty (post-filter) selection is a real, honest 0 -
        # a sum/average/min/max of nothing is not a real number, so that
        # is reported as an honest "no data" rather than a fabricated 0.
        if agg == "count":
            return 0, None
        return None, "No rows match this metric's filters."
    try:
        value = filtered[metric_column].agg(AGG_FUNCS[agg])
    except Exception as e:
        return None, f"Couldn't compute this metric: {e}"
    value = value.item() if hasattr(value, "item") else value
    if isinstance(value, float) and value != value:  # NaN, without importing math just for this
        return None, "This metric's result isn't a real number for the current data."
    return value, None


def _describe_filter(column: str, spec) -> str | None:
    """One short, honest clause describing a single filter criterion -
    used by describe_metric below. Returns None for a criterion with
    nothing meaningful to say (e.g. an empty value list), matching
    _apply_filter_criterion's own "no-op" treatment of the same case."""
    if isinstance(spec, str):
        return f'{column} contains "{spec}"' if spec else None
    if not isinstance(spec, dict):
        return None
    kind = spec.get("type")
    if kind == "values":
        include = [v for v in (spec.get("include") or []) if v is not None]
        if not include:
            return None
        shown = ", ".join(str(v) for v in include[:5])
        more = f" (+{len(include) - 5} more)" if len(include) > 5 else ""
        return f"{column} is one of {shown}{more}"
    if kind == "text":
        op, value = spec.get("op"), spec.get("value")
        op_words = {
            "contains": "contains", "not_contains": "does not contain", "equals": "equals",
            "not_equals": "does not equal", "starts_with": "starts with", "ends_with": "ends with",
            "is_empty": "is empty", "is_not_empty": "is not empty",
        }
        if op in ("is_empty", "is_not_empty"):
            return f"{column} {op_words[op]}"
        return f'{column} {op_words.get(op, op)} "{value}"' if value not in (None, "") else None
    if kind == "number":
        op, value, value2 = spec.get("op"), spec.get("value"), spec.get("value2")
        if op == "between" and value is not None and value2 is not None:
            return f"{column} is between {value} and {value2}"
        op_words = {"eq": "=", "neq": "!=", "gt": ">", "gte": ">=", "lt": "<", "lte": "<="}
        return f"{column} {op_words.get(op, op)} {value}" if value is not None else None
    if kind == "date":
        frm, to = spec.get("from"), spec.get("to")
        if frm and to:
            return f"{column} is between {frm} and {to}"
        if frm:
            return f"{column} is on or after {frm}"
        if to:
            return f"{column} is on or before {to}"
        return None
    if kind == "boolean":
        value = spec.get("value")
        if value in ("true", "false"):
            return f"{column} is {value}"
        return None
    return None


def describe_metric(name: str, metric_column: str | None, agg: str | None, filters: list | None = None) -> str:
    """Renders one metric definition as a single, plain-English line -
    the one shared, honest description used both by services/ai_engine.py's
    prompt-injected glossary note and its deterministic shortcut's own
    narrative text. Never computes anything - purely descriptive, so it
    never disagrees with what resolve_metric_value actually does (both are
    driven from the same metric_column/agg/filters)."""
    label = AGG_LABELS.get(agg or "", agg or "?")
    text = f'"{name}" = {label} of "{metric_column}"'
    if filters:
        parts = []
        for f in filters:
            column = f.get("column") if isinstance(f, dict) else getattr(f, "column", None)
            spec = f.get("spec") if isinstance(f, dict) else getattr(f, "spec", None)
            if not column:
                continue
            described = _describe_filter(column, spec)
            if described:
                parts.append(described)
        if parts:
            text += " where " + " and ".join(parts)
    return text


# A deliberately small, fixed set of "just tell me the plain number"
# lead-in phrases - see match_metric_by_name below for exactly how these
# are used (stripped from the FRONT of the question, then the remainder
# must equal a metric's name exactly) and why this is intentionally far
# stricter than a simple substring match.
_LEADING_PHRASES = (
    "what is", "what's", "whats", "what are", "show me", "show", "give me",
    "current", "total", "our", "my", "the",
)
# Any of these anywhere in the question routes it to the ordinary AI-planned
# flow instead (still informed by this metric's exact formula via
# describe_metric/the glossary note) - a breakdown, a trend, a comparison,
# or any time-scoping word ("last month", "today", ...) changes what the
# honest answer even IS, and this module's own deterministic shortcut only
# ever computes a metric's plain, all-data value with no way to represent
# any of that - see match_metric_by_name's own docstring.
_BLOCKING_WORDS_RE = re.compile(
    r"\bby\b|\bper\b|\bgroup(ed)?\b|\bbreak\s?down\b|\bover time\b|\btrend\b|\bsplit\b|\bcompare\b|"
    r"\bvs\.?\b|\bversus\b|\blast\b|\bthis (week|month|quarter|year)\b|\byesterday\b|\btoday\b|"
    r"\bytd\b|\bsince\b|\bbetween\b|\bfor\b|\bwhere\b|\bif\b|\bwhen\b|\bwhy\b|\bwhich\b",
    re.IGNORECASE,
)


def match_metric_by_name(prompt: str, metrics: list[dict]) -> dict | None:
    """A deliberately conservative, fully deterministic (never AI) check
    for "is this question just asking for one saved metric's plain
    value" - used by services/ai_engine.py as a pre-LLM shortcut so the
    most common case ("What is our Revenue?", "Show Active Users",
    "current Revenue") gets a guaranteed-exact answer with zero LLM call,
    rather than an AI-generated approximation of a formula this app
    already has on file.

    Matching is intentionally strict, not a substring search: every known
    "just tell me the number" lead-in phrase is stripped off the FRONT of
    the (lowercased, trailing-punctuation-stripped) question, and what
    remains must equal a metric's own `name` EXACTLY. Any question that
    also carries a breakdown/trend/comparison/time-scoping word (see
    _BLOCKING_WORDS_RE) never matches at all, no matter how it's phrased -
    those genuinely change what the honest answer is (a metric filtered
    to last month is a different number from its all-time value), and
    this shortcut only ever computes the plain, unscoped value. A
    question like that still benefits from this app's semantic layer, just
    via the AI-planned path instead (see ai_engine._metric_glossary_text),
    which writes its own fresh, re-verifiable code guided by this metric's
    exact formula rather than guessing at it.

    Returns the matching metric dict, or None to fall through to the
    ordinary AI-planned flow exactly as if this feature didn't exist."""
    if not prompt or not metrics:
        return None
    text = re.sub(r"[?!.]+$", "", prompt.strip().lower()).strip()
    if not text or _BLOCKING_WORDS_RE.search(text):
        return None
    changed = True
    while changed:
        changed = False
        for phrase in _LEADING_PHRASES:
            if text.startswith(phrase + " "):
                text = text[len(phrase):].strip()
                changed = True
    if not text:
        return None
    # Longest name first, so a metric named "Active Users" is checked
    # before a coincidentally shorter one (e.g. "Users") that could
    # otherwise shadow it - moot for an exact-equality check today, but
    # keeps this safe if matching is ever loosened later.
    for metric in sorted(metrics, key=lambda m: len(m.get("name") or ""), reverse=True):
        name = (metric.get("name") or "").strip().lower()
        if name and text == name:
            return metric
    return None
