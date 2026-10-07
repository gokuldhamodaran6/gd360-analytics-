"""
Choosing the best view (2026-10-07, chart-types round).

ONE deterministic function decides which chart a block is drawn as:

    recommend(shape)              -> {"chart_type", "reason", "strength"}
    resolve(shape, hint, explicit) -> the same, after weighing a suggestion
    fits(shape, chart_type)       -> (True, None) | (False, "needs ...")

It is used by the proposal commit, Ask AI, build-manually and "swap to
best" (routers/dashboard_builder.py) and mirrored, rule for rule and word
for word, in frontend/src/dashboard/charts/recommend.ts (the chart
gallery's "Recommended" badge and its "needs a country column" lines).
Both sides are run over the same case table in the test suites, so a rule
changed here and not there fails a test.

The rules are deliberately few, conservative and explainable; every result
carries the one line shown to the person ("Country column with 142 values
-> map"). Ties go to the plainer chart. A model may SUGGEST a type
(`hint`): a suggestion the shape cannot draw is overridden; a suggestion
that fits is kept unless a STRONG rule says otherwise (a country column is
a map, two dimensions are a heatmap, a binned column is a histogram) - or
unless the person asked for that form in so many words (`explicit`).

A "shape" is what a block's query returns, described without its rows:

    {"time":     {"grain": "month", "periods": 26 | None} | None,
     "dims":     [{"name": "country", "role": "category" | "ordinal" | "country",
                   "distinct": 142 | None}, ...],     # group-by columns, time excluded
     "measures": [{"name": "bookings", "additive": True, "unit": "number" | "percent" | "currency"}, ...],
     "bins": False,        # the spec bins a numeric column (histogram)
     "target": False,      # the block has a target (config.target)
     "negative": False,    # a measure has values below zero
     "max_ratio": None}    # largest / smallest measure magnitude, when known

shape_from_spec() builds one before a block has run (names and types only:
the schema cache holds no values, so a country column is recognised by its
NAME and confirmed on the first run); shape_from_result() builds one from
a run's result, where the values themselves decide (>= 80% of the distinct
values resolve to a country, and there are more than 6 of them).
"""
from __future__ import annotations

import re

from . import countries

COUNTRY_SCORE_MIN = 0.8
COUNTRY_MIN_COUNT = 6          # a map needs MORE than this many countries
SERIES_MAX = 6                 # lines / stacks a reader can still tell apart
DONUT_MIN, DONUT_MAX = 3, 6
RANKING_MAX = 30
TABLE_MIN_CATEGORIES = 200
HEATMAP_MAX_CELLS = 2500
SCATTER_MIN_POINTS = 6
SCALE_RATIO = 8                # the frontend's chartArrangement threshold

# Every chart form the dashboard draws, in gallery order. `when` is the one
# line the model prompts (and charts/README.md) give for each; `needs` is
# what a tile says when the block's current shape cannot draw it.
CHART_TYPES: list[dict] = [
    {"type": "bar", "label": "Bars", "when": "compare one measure across a few categories or ordered buckets", "needs": "needs a category or a date"},
    {"type": "horizontal_bar", "label": "Horizontal bars", "when": "a ranking of 7-30 named categories (long names fit)", "needs": "needs a category"},
    {"type": "line", "label": "Line", "when": "one or a few measures over time", "needs": "needs a date or an ordered column"},
    {"type": "area", "label": "Area", "when": "one measure over time where the volume matters", "needs": "needs a date or an ordered column"},
    {"type": "stacked_bar", "label": "Stacked bars", "when": "a total split into up to 6 parts across categories or periods", "needs": "needs a second dimension to stack by"},
    {"type": "stacked_bar_100", "label": "100% stacked bars", "when": "how the MIX changes across categories or periods (shares, not totals)", "needs": "needs a second dimension to stack by"},
    {"type": "stacked_area", "label": "Stacked area", "when": "a total and its parts over time", "needs": "needs a date and a dimension to stack by"},
    {"type": "stacked_area_100", "label": "100% stacked area", "when": "how the mix shifts over time", "needs": "needs a date and a dimension to stack by"},
    {"type": "combo", "label": "Bars + line panels", "when": "two measures of different scale over one axis - drawn as aligned panels, never two y-axes", "needs": "needs two measures over one axis"},
    {"type": "donut", "label": "Donut", "when": "share of a whole across 3-6 categories", "needs": "needs one category and one measure"},
    {"type": "pie", "label": "Pie", "when": "share of a whole across 3-6 categories", "needs": "needs one category and one measure"},
    {"type": "treemap", "label": "Treemap", "when": "part-to-whole across many categories (one or two levels)", "needs": "needs one or two categories and one measure"},
    {"type": "map", "label": "Map", "when": "one measure by a country column with more than 6 countries", "needs": "needs a country column"},
    {"type": "heatmap", "label": "Heatmap", "when": "one measure by two dimensions (segment x month, weekday x month)", "needs": "needs two dimensions"},
    {"type": "pivot", "label": "Pivot table", "when": "several measures by a row dimension and a column dimension", "needs": "needs two dimensions"},
    {"type": "scatter", "label": "Scatter", "when": "the relationship between two measures, one point per category", "needs": "needs two measures"},
    {"type": "bubble", "label": "Bubble", "when": "two measures per category with a third as size", "needs": "needs three measures"},
    {"type": "funnel", "label": "Funnel", "when": "ordered stages with the drop between them", "needs": "needs ordered stages (one category, or several measures)"},
    {"type": "waterfall", "label": "Waterfall", "when": "how parts add up to a total, or the change between two periods by category", "needs": "needs one category, or two where one has exactly two values"},
    {"type": "histogram", "label": "Histogram", "when": "the distribution of one numeric column", "needs": "needs a numeric column to bin"},
    {"type": "bullet", "label": "Bullet", "when": "one number against a target", "needs": "needs one measure (and a target)"},
    {"type": "table", "label": "Table", "when": "exact values, many columns, or more categories than a chart reads", "needs": ""},
    {"type": "kpi", "label": "KPI tile", "when": "one headline number", "needs": "needs a single number (no grouping)"},
]
CHART_TYPE_KEYS = tuple(t["type"] for t in CHART_TYPES)
# Aliases a model or an older block may use.
CHART_TYPE_ALIASES = {
    "column": "bar", "grouped_bar": "bar", "hbar": "horizontal_bar", "barh": "horizontal_bar", "choropleth": "map",
    "geo": "map", "matrix": "heatmap", "heat_map": "heatmap", "pivot_table": "pivot", "100_stacked_bar": "stacked_bar_100",
    "percent_stacked_bar": "stacked_bar_100", "stacked_100": "stacked_bar_100", "distribution": "histogram",
    "progress": "bullet", "bridge": "waterfall", "step_line": "line", "tree_map": "treemap",
}
# chart_type values a chart BLOCK may store (config.chart_type). "grouped_bar"
# and "step_line" are forms of bar / line the renderer already draws.
BLOCK_CHART_TYPES = frozenset(t for t in CHART_TYPE_KEYS if t not in ("table", "kpi")) | {"grouped_bar", "step_line"}


def normalize_chart_type(value) -> str | None:
    """A chart type as this module names it, or None when unknown."""
    if not isinstance(value, str):
        return None
    key = re.sub(r"[\s-]+", "_", value.strip().lower())
    if key in ("grouped_bar", "step_line"):
        return key
    key = CHART_TYPE_ALIASES.get(key, key)
    return key if key in CHART_TYPE_KEYS else None


def chart_type_guide() -> str:
    """The chart list the model prompts carry: one line per type."""
    return "\n".join(f'- "{t["type"]}": {t["when"]}' for t in CHART_TYPES)


def block_type_for(chart_type: str) -> str:
    """The block type that draws `chart_type`."""
    if chart_type == "kpi":
        return "kpi"
    if chart_type == "table":
        return "table"
    if chart_type == "donut":
        return "donut"
    return "chart"


# ---- shapes -----------------------------------------------------------------

_GRAIN_PLURAL = {"day": "days", "week": "weeks", "month": "months", "quarter": "quarters", "year": "years"}
_ADDITIVE_AGGS = frozenset({"sum", "count", "count_distinct"})
_NUMERIC_TYPE_RE = re.compile(r"int|float|numeric|decimal|double|real|number|bigint|smallint", re.IGNORECASE)
_DATE_TYPE_RE = re.compile(r"date|time", re.IGNORECASE)
_MONTHS = frozenset("january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec".split())
_WEEKDAYS = frozenset("monday tuesday wednesday thursday friday saturday sunday mon tue tues wed thu thur thurs fri sat sun".split())
_NUMERIC_RE = re.compile(r"^-?\d+([.,]\d+)?%?$")
_DATE_RE = re.compile(r"^\d{4}-\d{1,2}(-\d{1,2})?([t ].*)?$|^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$|^\d{4}$|^(q[1-4]|h[12])([ -]?\d{2,4})?$|^\d{4}[ -]?(q[1-4]|w\d{1,2})$")
_ORDINAL_NAME_RE = re.compile(r"(^|[_\s])(year|yr|month|week|weekday|day|quarter|hour|bucket|band|tier|bin|range|age)([_\s]|$)", re.IGNORECASE)


def is_position_word(text) -> bool:
    """A value that is a position on a scale, not an entity: a number, a
    date, a month, a weekday (frontend chartTheme.isPositionWord)."""
    s = str(text).strip().lower()
    return bool(_NUMERIC_RE.match(s) or _DATE_RE.match(s) or s in _MONTHS or s in _WEEKDAYS)


def dim_from_values(name: str, values: list, weights: list | None = None) -> dict:
    """One dimension of a shape, decided by the values a run returned.
    `weights`: the rows' additive measure (bookings, revenue) - a column
    is a country column when 80% of its distinct values resolve to a
    country, OR 80% of that measure sits on values that do."""
    present = [v for v in values if v is not None and not (isinstance(v, str) and not v.strip())]
    out = {"name": name, "role": "category", "distinct": len({str(v) for v in values}) if values else 0}
    if not present:
        return out
    if all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in present) or all(is_position_word(v) for v in present):
        out["role"] = "ordinal"
        return out
    score = countries.country_column_score(present)
    if weights is not None and score < COUNTRY_SCORE_MIN:
        score = max(score, countries.country_weight_share(values, weights))
    if score >= COUNTRY_SCORE_MIN:
        _hits, count = countries.resolved_distinct(present)
        if count > COUNTRY_MIN_COUNT:
            out["role"] = "country"
            out["countries"] = count
        else:
            out["few_countries"] = count
    return out


def dim_from_schema(name: str, col_type: str | None, distinct: int | None = None, date_part: bool = False) -> dict:
    """The same before any row exists: the column's name and type decide,
    provisionally (shape_from_result confirms on the first run)."""
    role = "category"
    if date_part or _DATE_TYPE_RE.search(str(col_type or "")) or _NUMERIC_TYPE_RE.search(str(col_type or "")) or _ORDINAL_NAME_RE.search(name or ""):
        role = "ordinal"
    elif countries.looks_like_country_name(name):
        role = "country"
    return {"name": name, "role": role, "distinct": distinct}


def _measure_unit(fmt) -> str:
    return fmt if fmt in ("percent", "currency") else "number"


def shape_from_spec(spec: dict, columns: list[dict] | None = None, distinct: dict | None = None, target: bool = False,
                    formats: dict | None = None) -> dict:
    """A shape from a BlockSpec alone. `columns` is the table's schema
    ([{name, type}]); `distinct` an optional {column: count} from the
    profile cache."""
    types = {c.get("name"): c.get("type") for c in (columns or []) if isinstance(c, dict)}
    spec = spec or {}
    dims = []
    for g in spec.get("group_by") or []:
        d = (distinct or {}).get(g)
        limit = spec.get("limit")
        if isinstance(d, int) and isinstance(limit, int) and len(spec.get("group_by") or []) == 1 and not spec.get("time"):
            d = min(d, limit)
        dims.append(dim_from_schema(g, types.get(g), d))
    for p in spec.get("date_parts") or []:
        if isinstance(p, dict):
            dims.append(dim_from_schema(p.get("alias") or f"{p.get('column')}_{p.get('part')}", None, None, date_part=True))
    measures = [
        {"name": m.get("alias"), "additive": str(m.get("agg") or "").lower() in _ADDITIVE_AGGS,
         "unit": _measure_unit((formats or {}).get(m.get("alias")))}
        for m in (spec.get("measures") or []) if isinstance(m, dict)
    ]
    time = spec.get("time")
    return {
        "time": {"grain": time.get("grain") or "month", "periods": None} if isinstance(time, dict) and time.get("column") else None,
        "dims": dims, "measures": measures, "bins": bool(spec.get("bins")), "target": bool(target), "negative": False,
        "max_ratio": None,
    }


def shape_from_result(result: dict, spec: dict | None = None, target: bool = False, formats: dict | None = None) -> dict:
    """A shape from a run's result: the values themselves decide."""
    result = result or {}
    spec = spec or result.get("spec") or {}
    rows = result.get("rows") or []
    time_col = result.get("time_column")
    dims = []
    parts = {p.get("alias") for p in (spec.get("date_parts") or []) if isinstance(p, dict)}
    # The first measure weighs the rows when it adds up (see dim_from_values).
    first = (result.get("measures") or [None])[0]
    first_agg = next((str(m.get("agg") or "").lower() for m in (spec.get("measures") or []) if isinstance(m, dict) and m.get("alias") == first), "sum")
    weights = [r.get(first) for r in rows] if first and first_agg in _ADDITIVE_AGGS else None
    for name in result.get("dimensions") or []:
        if name in parts:
            dims.append({"name": name, "role": "ordinal", "distinct": len({str(r.get(name)) for r in rows})})
        else:
            dims.append(dim_from_values(name, [r.get(name) for r in rows], weights))
    aggs = {m.get("alias"): str(m.get("agg") or "").lower() for m in (spec.get("measures") or []) if isinstance(m, dict)}
    measures = []
    negative = False
    sizes = []
    for alias in result.get("measures") or []:
        values = [r.get(alias) for r in rows if isinstance(r.get(alias), (int, float)) and not isinstance(r.get(alias), bool)]
        if any(v < 0 for v in values):
            negative = True
        if values:
            sizes.append(max(abs(v) for v in values))
        measures.append({"name": alias, "additive": aggs.get(alias, "sum") in _ADDITIVE_AGGS, "unit": _measure_unit((formats or {}).get(alias))})
    positive = [s for s in sizes if s > 0]
    time = None
    if time_col:
        grain = result.get("period") or ((spec.get("time") or {}).get("grain") if isinstance(spec.get("time"), dict) else None) or "month"
        time = {"grain": grain, "periods": len({str(r.get(time_col)) for r in rows if r.get(time_col) is not None})}
    return {
        "time": time, "dims": dims, "measures": measures, "bins": bool(spec.get("bins")) or bool(result.get("bins")),
        "target": bool(target), "negative": negative,
        "max_ratio": (max(positive) / min(positive)) if len(positive) > 1 else None,
    }


# ---- can this shape draw that chart? ------------------------------------------

def _needs(chart_type: str) -> str:
    return next((t["needs"] for t in CHART_TYPES if t["type"] == chart_type), "")


def fits(shape: dict, chart_type: str) -> tuple[bool, str | None]:
    """(True, None) when the shape can be drawn as `chart_type`, else
    (False, the one line a disabled tile shows)."""
    ct = normalize_chart_type(chart_type)
    if ct is None:
        return False, "not a chart type GD360 draws"
    if ct in ("grouped_bar", "step_line"):
        ct = "bar" if ct == "grouped_bar" else "line"
    t = shape.get("time")
    dims = shape.get("dims") or []
    nd, nm = len(dims), len(shape.get("measures") or [])
    axes = nd + (1 if t else 0)
    no = (False, _needs(ct))
    if shape.get("bins"):
        return ((True, None) if ct in ("histogram", "table") else (False, "a binned column is drawn as a histogram"))
    if ct == "histogram":
        return no
    if ct == "table":
        return True, None
    if nm < 1:
        return False, "needs a measure"
    if ct == "kpi":
        return ((True, None) if axes == 0 else no)
    if ct == "bullet":
        return ((True, None) if (axes == 0 and nm >= 1) or (axes == 1 and not t and nm == 1) else no)
    # A form made of several marks needs several: one category is a number,
    # not a funnel / treemap / waterfall (known only once the values are).
    lone = nd == 1 and not t and dims[0].get("distinct") is not None and dims[0]["distinct"] < 2
    if lone and ct in ("funnel", "treemap", "waterfall"):
        return False, "needs at least two categories"
    if ct == "funnel":
        return ((True, None) if (axes == 0 and nm >= 2) or (nd == 1 and not t and nm == 1) else no)
    if axes == 0:
        return False, "needs a category or a date to draw across"
    if ct in ("bar", "line", "area"):
        return ((True, None) if axes <= 2 else (False, "three dimensions read best as a table"))
    if ct == "horizontal_bar":
        return ((True, None) if axes <= 2 and not (t and nd == 0) else no)
    if ct in ("stacked_bar", "stacked_bar_100"):
        return ((True, None) if (axes == 2 and nm >= 1) or (axes == 1 and nm >= 2) else no)
    if ct in ("stacked_area", "stacked_area_100"):
        ordered = bool(t) or (nd >= 1 and dims[0].get("role") == "ordinal")
        return ((True, None) if ordered and ((axes == 2 and nm >= 1) or (axes == 1 and nm >= 2)) else no)
    if ct == "combo":
        return ((True, None) if axes == 1 and nm >= 2 else no)
    if ct in ("donut", "pie"):
        return ((True, None) if nd == 1 and not t and nm == 1 else no)
    if ct == "treemap":
        return ((True, None) if nd in (1, 2) and not t and nm >= 1 else no)
    if ct == "map":
        if nd == 1 and not t and dims[0].get("role") == "country":
            return True, None
        if nd == 1 and not t and dims[0].get("few_countries") is not None:
            return False, f"only {dims[0]['few_countries']} countries - bars read better"
        return no
    if ct in ("heatmap", "pivot"):
        return ((True, None) if axes == 2 else no)
    if ct == "scatter":
        return ((True, None) if axes == 1 and nm >= 2 else no)
    if ct == "bubble":
        return ((True, None) if axes == 1 and nm >= 3 else no)
    if ct == "waterfall":
        if axes == 2 and nm == 1:
            # A bridge: one of the two dimensions has exactly two values
            # (two years, plan and actual) - checked once the values are known.
            sizes = [d.get("distinct") for d in dims] + ([t.get("periods")] if t else [])
            if all(isinstance(s, int) for s in sizes) and 2 not in sizes:
                return no
            return True, None
        return ((True, None) if axes == 1 and nm == 1 else no)
    return no


# ---- the recommendation ---------------------------------------------------------

def _n(value: int) -> str:
    return f"{int(value):,}"


def _periods(time: dict) -> str:
    grain = time.get("grain") or "month"
    periods = time.get("periods")
    plural = _GRAIN_PLURAL.get(grain, f"{grain}s")
    if isinstance(periods, int):
        return f"{_n(periods)} {plural if periods != 1 else grain}"
    return f"time (by {grain})"


def _rec(chart_type: str, reason: str, strength: str = "weak") -> dict:
    return {"chart_type": chart_type, "block_type": block_type_for(chart_type), "reason": reason, "strength": strength}


def recommend(shape: dict) -> dict:
    """The recommended chart for a shape, with the line shown to the
    person. Deterministic; no data is read."""
    t = shape.get("time")
    dims = shape.get("dims") or []
    measures = shape.get("measures") or []
    nd, nm = len(dims), len(measures)

    if shape.get("bins"):
        return _rec("histogram", "Distribution of one numeric column → histogram", "strong")
    if nm == 0:
        return _rec("table", "No measure to draw → table", "strong")

    if nd == 0 and not t:
        if shape.get("target") and nm == 1:
            return _rec("bullet", "One number against a target → bullet")
        return _rec("kpi", "One headline number → KPI tile", "strong")

    if t and nd == 0:
        periods = t.get("periods")
        if isinstance(periods, int) and periods <= 3:
            return _rec("bar", f"Only {_periods(t)} → bars")
        if nm == 1:
            return _rec("line", f"One measure over {_periods(t)} → line")
        units = {m.get("unit") or "number" for m in measures}
        ratio = shape.get("max_ratio")
        if len(units) > 1 or (isinstance(ratio, (int, float)) and ratio > SCALE_RATIO):
            return _rec("line", f"{_n(nm)} measures of different scale over {_periods(t)} → aligned panels, never two y-axes")
        return _rec("line", f"{_n(nm)} measures over {_periods(t)} → lines")

    if t and nd == 1:
        d = dims[0]
        if nm >= 2:
            return _rec("table", "Several measures by period and category → table", "strong")
        distinct = d.get("distinct")
        if isinstance(distinct, int) and distinct > SERIES_MAX:
            return _rec("heatmap", f"{_n(distinct)} series over {_periods(t)} → heatmap", "strong")
        return _rec("line", f"One measure over {_periods(t)}, one line per category → lines")

    if t and nd >= 2:
        return _rec("table", "Three dimensions → table", "strong")

    if nd == 1:
        d = dims[0]
        distinct = d.get("distinct")
        known = isinstance(distinct, int)
        if nm == 1:
            m = measures[0]
            if d.get("role") == "country":
                count = d.get("countries") if isinstance(d.get("countries"), int) else distinct
                if isinstance(count, int):
                    return _rec("map", f"Country column with {_n(count)} values → map", "strong")
                return _rec("map", "Country column → map", "strong")
            if d.get("few_countries") is not None:
                return _rec("bar", f"Only {_n(d['few_countries'])} countries → bars")
            if known and distinct <= 1:
                return _rec("bar", "A single value → one bar")
            if d.get("role") == "ordinal":
                if known and distinct > RANKING_MAX:
                    return _rec("line", f"Ordered scale with {_n(distinct)} values → line")
                return _rec("bar", f"{_n(distinct)} ordered values → bars" if known else "Ordered values → bars")
            if not known:
                return _rec("bar", "One measure across a category → bars")
            if distinct > TABLE_MIN_CATEGORIES:
                return _rec("table", f"{_n(distinct)} categories → table", "strong")
            if distinct > RANKING_MAX:
                return _rec("horizontal_bar", f"{_n(distinct)} categories → horizontal bars of the largest")
            if distinct > DONUT_MAX:
                return _rec("horizontal_bar", f"Ranking of {_n(distinct)} → horizontal bars")
            if distinct >= DONUT_MIN and m.get("additive") and not shape.get("negative"):
                return _rec("donut", f"Share across {_n(distinct)} categories → donut")
            return _rec("bar", f"Comparison across {_n(distinct)} categories → bars")
        if nm == 2:
            if known and distinct >= SCATTER_MIN_POINTS:
                return _rec("scatter", "Two measures per item → scatter")
            return _rec("bar", "Two measures across a few categories → side-by-side bars")
        if known and distinct <= 12 and nm <= 4:
            return _rec("bar", f"{_n(nm)} measures across {_n(distinct)} categories → one panel each")
        return _rec("table", f"{_n(nm)} measures per item → table", "strong")

    if nd == 2:
        if nm >= 2:
            return _rec("pivot", f"Two dimensions and {_n(nm)} measures → pivot table", "strong")
        a, b = dims[0].get("distinct"), dims[1].get("distinct")
        if isinstance(a, int) and isinstance(b, int):
            if a * b > HEATMAP_MAX_CELLS:
                return _rec("table", f"Too many combinations ({_n(a * b)}) → table", "strong")
            return _rec("heatmap", f"Two dimensions ({_n(a)} × {_n(b)}) → heatmap", "strong")
        return _rec("heatmap", "Two dimensions → heatmap", "strong")

    return _rec("table", "Three dimensions → table", "strong")


def resolve(shape: dict, hint: str | None = None, explicit: bool = False) -> dict:
    """recommend(), after weighing a suggested chart type. `explicit`: the
    person asked for that form (a question that names it, a pick in the
    builder) - it wins whenever the shape can draw it. A model's own
    suggestion wins only over a WEAK rule. The result adds "suggested",
    "overrode" (the suggestion was replaced) and "override_reason"."""
    rec = dict(recommend(shape))
    rec["suggested"] = None
    rec["overrode"] = False
    rec["override_reason"] = None
    raw = hint
    hint = normalize_chart_type(hint) if hint else None
    if raw and not hint:
        rec.update({"suggested": str(raw)[:40], "overrode": True, "override_reason": "not a chart type GD360 draws"})
        return rec
    if not hint:
        return rec
    rec["suggested"] = hint
    plain = "bar" if hint == "grouped_bar" else "line" if hint == "step_line" else hint
    if plain == rec["chart_type"]:
        rec["chart_type"] = hint
        return rec
    ok, why = fits(shape, hint)
    if not ok:
        rec.update({"overrode": True, "override_reason": why})
        return rec
    if explicit or rec["strength"] == "weak":
        label = next((t["label"] for t in CHART_TYPES if t["type"] == plain), plain)
        return {
            "chart_type": hint, "block_type": block_type_for(plain), "strength": "weak",
            "reason": f"{label}, as asked" if explicit else f"{label}, as suggested for this block",
            "suggested": hint, "overrode": False, "override_reason": None,
        }
    rec.update({"overrode": True, "override_reason": rec["reason"]})
    return rec
