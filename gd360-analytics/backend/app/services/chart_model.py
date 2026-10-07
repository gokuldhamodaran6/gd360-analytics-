"""
The chart contract (2026-10-07, chart-integrity round).

A chart is a deterministic function of the result table. This module is
the ONE place that decides, from `(result_columns, result_rows, chart_type)`
and nothing else, what a standard chart shows:

    x          the category / time dimension (one tick per distinct value)
    series     one per measure column (a WIDE result: dimension + N numbers)
               or one per value of a series dimension (a LONG result:
               dimension, series dimension, one number)
    values     each series' numbers, aligned to x - copied, never recomputed

and it is also the reference every figure is AUDITED against (audit_figure)
before it is stored or shown. The frontend has the same contract in
frontend/src/lib/chartModel.ts; the two are held to each other by a shared
fixture file (see test_chart_integrity.py / workspacechart.test.tsx).

Why it exists: chart_builder.build_figure used to rename "the first two
columns" of whatever frame it was handed to x and y. A pivoted result
(index = year, columns = City Hotel / Resort Hotel) therefore drew City
Hotel revenue on the x axis against Resort Hotel revenue on the y axis -
a line chart that contradicted its own query. Nothing downstream could
notice, because nothing compared the figure with the table. Now the model
is derived from the table first, the figure is built from the model, and
the audit refuses any figure whose traces are not the model's series.

Vocabulary
    kind "cartesian"   line, area, stacked_area, step_line, bar/column,
                       horizontal_bar, grouped_bar, stacked_bar
    kind "pie"         pie, donut
    kind "kpi"         one row, no dimension: a single value (per measure)
    kind "table"       the result cannot be drawn as the requested chart
                       without misrepresenting it; `reason` says why in a
                       plain sentence. Never a wrong chart.
    kind "passthrough" every other chart type (scatter, bubble, histogram,
                       box, heatmap, sankey, maps, facet grids ...): the
                       model does not describe it and chart_builder's own
                       branch draws it.

Everything here is plain Python over JSON-shaped values (no pandas), so it
runs identically on a live result and on a message stored a year ago.
"""
from __future__ import annotations

import math
import re
from typing import Any

LINE_TYPES = {"line", "area", "stacked_area", "step_line"}
BAR_TYPES = {"bar", "horizontal_bar", "grouped_bar", "stacked_bar"}
PIE_TYPES = {"pie", "donut"}
CARTESIAN_TYPES = LINE_TYPES | BAR_TYPES
STANDARD_TYPES = CARTESIAN_TYPES | PIE_TYPES | {"table", "kpi"}
# A long result with more series values than this is not a chart anyone can
# read (and the palette has no hues for it): it is shown as its table.
MAX_SERIES = 12
# A category axis with more ticks than this is a table too.
MAX_CATEGORIES = 500
# One row of numbers: up to this many are shown as single-value tiles.
MAX_KPIS = 4

_TYPE_ALIASES = {"column": "bar", "single_value": "kpi", "number": "kpi", "big_number": "kpi", "indicator": "kpi"}

BLANK_LABEL = "(Blanks)"

_MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]
_MONTH_INDEX = {m: i for i, m in enumerate(_MONTHS)}
_MONTH_INDEX.update({m[:3]: i for i, m in enumerate(_MONTHS)})
_MONTH_INDEX["sept"] = 8
_WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
_WEEKDAY_INDEX = {d: i for i, d in enumerate(_WEEKDAYS)}
_WEEKDAY_INDEX.update({d[:3]: i for i, d in enumerate(_WEEKDAYS)})

# Words that say "this whole-number column is a period" ...
_TIME_TOKENS = {"year", "yr", "fy", "month", "mon", "quarter", "qtr", "week", "wk", "day", "dow", "weekday", "hour", "hr", "date", "period"}
# ... as long as nothing but these follows them ("day_of_month", "week_number").
_TIME_SUFFIX_OK = _TIME_TOKENS | {"number", "num", "no", "of", "index", "name", "start", "end", "id", "key"}
# Words that say "this whole-number column identifies something" (last word only).
_ID_TOKENS = {"id", "code", "zip", "zipcode", "postcode", "postal", "sku", "key", "uuid", "no", "num", "number"}
# Words that say "this is a quantity", whatever else the name contains.
_MEASURE_TOKENS = {
    "total", "sum", "avg", "average", "mean", "median", "count", "cnt", "rate", "pct", "percent", "percentage", "share", "ratio",
    "amount", "revenue", "sales", "price", "cost", "profit", "margin", "qty", "quantity", "per", "min", "max", "std", "stddev",
    "var", "variance", "score", "value", "nights", "stays", "bookings", "orders", "customers", "users", "rows",
}

_ISO_DATE_RE = re.compile(r"^(\d{4})-(\d{2})(?:-(\d{2}))?(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$")
_MIDNIGHT_RE = re.compile(r"[T ]00:00(?::00(?:\.0+)?)?(?:Z|[+-]00:?00)?$")
_QUARTER_RE = re.compile(r"^(\d{4})[-\s]?Q([1-4])$|^Q([1-4])[-\s]?(\d{4})$", re.IGNORECASE)
_NUMERIC_TEXT_RE = re.compile(r"^-?\d+(?:\.\d+)?$")


_ACRONYMS = [
    "ADR", "ID", "USD", "EUR", "GBP", "YoY", "MoM", "QoQ", "WoW", "YTD", "MTD", "KPI", "URL", "SKU", "CAC", "LTV", "ARPU", "MRR", "ARR",
    "ROI", "ROAS", "AOV", "GMV", "CTR", "CPC", "CPA", "CPM", "API", "SQL", "UTC", "VAT", "NPS", "CSAT", "DAU", "WAU", "MAU", "B2B",
    "B2C", "IP", "SLA", "UUID", "RevPAR", "OTA", "COGS", "EBITDA", "PII",
]
_ACRONYM_BY_LOWER = {a.lower(): a for a in _ACRONYMS}


def humanize(name: Any) -> str:
    """A column name as a label: "total_revenue" -> "Total revenue",
    "avg_adr" -> "Avg ADR". A name already written for people ("City
    Hotel") is left alone. Same rules as frontend dashboard/format.ts."""
    s = str(name if name is not None else "").strip()
    if not s:
        return ""
    if s.lower() in _ACRONYM_BY_LOWER:
        return _ACRONYM_BY_LOWER[s.lower()]
    shouting = s == s.upper() and any(ch.isalpha() for ch in s)
    if "_" not in s and any(ch.isupper() for ch in s) and not shouting:
        return s
    words = re.sub(r"[_\s]+", " ", s).strip().split(" ")
    out = []
    for i, w in enumerate(words):
        known = _ACRONYM_BY_LOWER.get(w.lower())
        if known:
            out.append(known)
        else:
            low = w.lower()
            out.append(low[:1].upper() + low[1:] if i == 0 else low)
    return " ".join(out)


class ChartNotDrawable(ValueError):
    """The result cannot be drawn as the requested chart without
    misrepresenting it. `str(e)` is a plain sentence for the person; the
    caller shows the table with that sentence instead of a chart."""


# ---- values ----------------------------------------------------------------

def is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _is_blank(v: Any) -> bool:
    if v is None:
        return True
    if isinstance(v, float) and not math.isfinite(v):
        return True
    return isinstance(v, str) and v.strip() == ""


def number_label(v: float) -> str:
    """A number used as a LABEL (a year, an id): no thousands separator,
    no ".0" on a whole number - "2015", never "2,015" or "2015.0"."""
    if float(v).is_integer() and abs(v) < 1e15:
        return str(int(v))
    return repr(float(v))


def value_label(v: Any) -> str:
    """How one dimension value is written on an axis, in a legend, in a
    sentence. The same function labels the model's categories and the
    figure's ticks, so the audit compares like with like."""
    if _is_blank(v):
        return BLANK_LABEL
    if isinstance(v, bool):
        return "Yes" if v else "No"
    if is_number(v):
        return number_label(v)
    s = str(v).strip()
    if _ISO_DATE_RE.match(s):
        # A date written with a midnight time is a calendar day.
        return _MIDNIGHT_RE.sub("", s)
    return s


def _tokens(name: str) -> list[str]:
    spaced = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", str(name))
    return [t for t in re.split(r"[^a-z0-9]+", spaced.lower()) if t]


def _time_named(name: str) -> bool:
    toks = _tokens(name)
    if not toks or any(t in _MEASURE_TOKENS for t in toks):
        return False
    for i, t in enumerate(toks):
        if t in _TIME_TOKENS and all(x in _TIME_SUFFIX_OK for x in toks[i + 1:]):
            return True
    return False


def _id_named(name: str) -> bool:
    toks = _tokens(name)
    if not toks or any(t in _MEASURE_TOKENS for t in toks):
        return False
    return toks[-1] in _ID_TOKENS and not (len(toks) > 1 and toks[0] in {"num", "number", "no"})


def _flag_named(name: str) -> bool:
    n = str(name).lower()
    return n.startswith("is_") or n.startswith("has_") or n.endswith("_flag")


def _year_like(values: list) -> bool:
    return bool(values) and all(is_number(v) and float(v).is_integer() and 1900 <= v <= 2100 for v in values)


def _order_key(v: Any) -> tuple | None:
    """A sort key for a value that has a natural order (a number, numeric
    text, a date, a quarter, a month or weekday name); None when it has
    none (free text)."""
    if isinstance(v, bool) or _is_blank(v):
        return None
    if is_number(v):
        return (0, float(v))
    s = str(v).strip()
    if _NUMERIC_TEXT_RE.match(s):
        return (0, float(s))
    m = _ISO_DATE_RE.match(s)
    if m:
        return (1, int(m.group(1)), int(m.group(2)), int(m.group(3) or 1), int(m.group(4) or 0), int(m.group(5) or 0), int(m.group(6) or 0))
    q = _QUARTER_RE.match(s)
    if q:
        year = int(q.group(1) or q.group(4))
        quarter = int(q.group(2) or q.group(3))
        return (2, year, quarter)
    low = s.lower()
    if low in _MONTH_INDEX:
        return (3, _MONTH_INDEX[low])
    if low in _WEEKDAY_INDEX:
        return (4, _WEEKDAY_INDEX[low])
    return None


# ---- columns ---------------------------------------------------------------

def classify_columns(columns: list[dict], rows: list[dict]) -> list[dict]:
    """Every column of a tidy result as {"name", "role": "dimension" |
    "measure", "axis": "time" | "ordinal" | "category" | None, "why"}.

    A measure is a column of numbers that are quantities. A dimension is
    everything else - and also a column of whole numbers that IDENTIFY
    something rather than measure it: a year, a month number, an id, a zip
    code, a 0/1 flag. Those are labels: they go on a category axis, in
    order, written "2015" (never "2,015", never a tick at 2,015.5).

    axis "time"      real dates (ISO strings / a date dtype): sorted
         "ordinal"   values with a natural order that are not dates (years,
                     month numbers, "2015" as text, quarter / month /
                     weekday names): sorted whenever they are periods, and
                     for a line or area (which needs an order) otherwise
         "category"  free text: the result's own row order is kept
    """
    names = [str(c.get("name")) for c in columns]
    out: list[dict] = []
    for c in columns:
        name = str(c.get("name"))
        values = [r.get(name) for r in rows]
        present = [v for v in values if not _is_blank(v)]
        dtype = str(c.get("dtype") or "").lower()
        declared_dimension = str(c.get("role") or "").lower() == "dimension"
        numeric = bool(present) and all(is_number(v) for v in present)
        info: dict = {"name": name, "role": "dimension", "axis": "category", "why": "text", "time_like": False}
        if not present:
            # An all-empty column measures nothing and labels nothing: it is
            # kept out of both the series and the axis choice.
            is_measure = dtype == "number" and not declared_dimension
            info.update(role="measure" if is_measure else "dimension", axis=None if is_measure else "category", why="empty")
        elif numeric:
            whole = all(float(v).is_integer() for v in present)
            if declared_dimension:
                # The backend marks a column that came from the result's own
                # index (a groupby key, a pivot's rows) as a dimension even
                # when it holds numbers.
                info.update(axis="ordinal", why="declared", time_like=_time_named(name) or _year_like(present))
            elif names == ["label", "value"] and name == "label":
                # A Series result: its index is the dimension by construction.
                info.update(axis="ordinal", why="series index", time_like=_year_like(present))
            elif whole and _time_named(name):
                info.update(axis="ordinal", why="period name", time_like=True)
            elif whole and _id_named(name):
                info.update(axis="ordinal", why="identifier name")
            elif whole and _flag_named(name) and all(v in (0, 1) for v in present):
                info.update(axis="ordinal", why="flag")
            else:
                info.update(role="measure", axis=None, why="number")
        elif dtype == "boolean" or all(isinstance(v, bool) for v in present):
            info.update(axis="category", why="boolean")
        else:
            keys = [_order_key(v) for v in present]
            if all(k is not None and k[0] == 1 for k in keys):
                info.update(axis="time", why="dates", time_like=True)
            elif all(k is not None for k in keys) and len({k[0] for k in keys}) == 1:
                kind = keys[0][0]
                # Numeric text ("2015"), quarters, month names, weekday names.
                period = kind in (2, 3, 4) or (kind == 0 and (_time_named(name) or _year_like([k[1] for k in keys])))
                info.update(axis="ordinal", why="ordered text", time_like=period)
            elif dtype == "date":
                info.update(axis="category", why="date-typed text")
        out.append(info)
    return out


def _promote_positional_dimension(cols: list[dict], rows: list[dict]) -> None:
    """No column is a dimension by type or by name, yet a chart needs one
    (`SELECT bucket, COUNT(*)` with an integer bucket; a year column that
    arrived as a plain number). The x axis is then a column whose values
    are WHOLE and distinct: one that reads as years if there is one, else
    the first column - provided its name is not a quantity's. It is drawn
    as ordered categories.

    A column of fractional numbers, or one named like a quantity
    ("avg_lead_time", "bookings", "City Hotel" revenue), is never promoted:
    putting one measure's values on the axis and another measure above
    them is the original wrong chart - numeric against numeric - with
    category labels. Such a result has no axis; it is shown as a table
    (or as a scatter, when a scatter is what was asked for)."""
    measures = [c for c in cols if c["role"] == "measure"]
    if len(measures) < 2:
        return

    def values_of(c: dict) -> list:
        return [r.get(c["name"]) for r in rows if not _is_blank(r.get(c["name"]))]

    def distinct(vals: list) -> bool:
        return len(vals) == len(rows) and len(set(vals)) == len(vals)

    def whole(vals: list) -> bool:
        return bool(vals) and all(is_number(v) and float(v).is_integer() for v in vals)

    pick = None
    for c in measures:
        vals = values_of(c)
        if distinct(vals) and _year_like(vals):
            pick = c
            break
    if pick is None:
        first = measures[0]
        vals = values_of(first)
        if distinct(vals) and whole(vals) and not any(t in _MEASURE_TOKENS for t in _tokens(first["name"])):
            pick = first
    if pick is not None:
        vals = values_of(pick)
        pick.update(role="dimension", axis="ordinal", why="position", time_like=_year_like(vals))


# ---- the model -------------------------------------------------------------

def normalize_chart_type(chart_type: str | None) -> str:
    ct = (chart_type or "bar").lower().strip()
    return _TYPE_ALIASES.get(ct, ct)


def _table(chart_type: str, reason: str | None, measures: list[str] | None = None) -> dict:
    return {
        "kind": "table", "chart_type": chart_type, "x": None, "series_by": None, "measure": None,
        "measures": measures or [], "series": [], "stacked": False, "horizontal": False, "note": None, "reason": reason,
    }


def _clean_number(v: Any) -> float | None:
    if is_number(v):
        return float(v)
    return None


def _friendly_type(chart_type: str) -> str:
    return chart_type.replace("_", " ")


def derive_chart_model(columns: list[dict] | None, rows: list[dict] | None, chart_type: str | None) -> dict:
    """(result_columns, result_rows, chart_type) -> the chart model.

    Returns a JSON-serialisable dict:
      kind, chart_type,
      x:        {"name", "axis": "time" | "ordinal" | "category", "labels": [str], "values": [raw]} | None
      series_by: the series dimension's column name (long results) | None
      measure:  the one measure a long result / a pie plots | None
      measures: every measure column of the result, in order
      series:   [{"name", "values": [float | None] aligned to x.labels}]
      stacked, horizontal, note, reason
      kpi results carry series = [{"name", "values": [v]}] and x = None.
    """
    ct = normalize_chart_type(chart_type)
    columns = [c for c in (columns or []) if isinstance(c, dict) and c.get("name") is not None]
    rows = [r for r in (rows or []) if isinstance(r, dict)]
    if ct not in STANDARD_TYPES:
        return {
            "kind": "passthrough", "chart_type": ct, "x": None, "series_by": None, "measure": None, "measures": [],
            "series": [], "stacked": False, "horizontal": False, "note": None, "reason": None,
        }
    if not columns or not rows:
        return _table(ct, "There are no rows to draw.")

    cols = classify_columns(columns, rows)
    if not any(c["role"] == "dimension" for c in cols) and len(rows) > 1:
        _promote_positional_dimension(cols, rows)
    dims = [c for c in cols if c["role"] == "dimension"]
    measures = [c["name"] for c in cols if c["role"] == "measure" and c["why"] != "empty"]

    if ct == "table":
        return _table(ct, None, measures)
    if not measures:
        empty = [c["name"] for c in cols if c["why"] == "empty"]
        if empty:
            return _table(ct, f"Every value of {', '.join(empty)} is empty, so there is nothing to draw; the result is shown as a table.")
        return _table(ct, "This result has no numeric column to plot, so it is shown as a table.")

    # ---- one row, no dimension ----
    if not dims:
        if len(rows) == 1:
            values = [_clean_number(rows[0].get(m)) for m in measures]
            if len(measures) >= 2 and (ct in BAR_TYPES or ct in PIE_TYPES):
                # One row of several numbers asked for as bars / a pie: each
                # COLUMN is a category ("City Hotel" 79,330 | "Resort Hotel"
                # 40,060). The column names are the axis.
                if ct in PIE_TYPES and (any(v is not None and v < 0 for v in values) or not any(v for v in values if v is not None)):
                    return _table(ct, f"A {_friendly_type(ct)} chart needs positive values to divide a whole; this result is shown as a table.", measures)
                return {
                    "kind": "pie" if ct in PIE_TYPES else "cartesian", "chart_type": ct,
                    "x": {"name": "measure", "axis": "category", "ordered": False, "labels": [str(m) for m in measures], "values": [str(m) for m in measures]},
                    "series_by": None, "measure": "value", "measures": ["value"], "transposed": True,
                    "series": [{"name": "value", "values": values}],
                    "stacked": False, "horizontal": ct == "horizontal_bar", "note": None, "reason": None,
                }
            if len(measures) > MAX_KPIS:
                return _table(ct, f"This result is one row of {len(measures)} numbers, which reads best as a table.", measures)
            return {
                "kind": "kpi", "chart_type": "kpi", "x": None, "series_by": None, "measure": measures[0], "measures": measures,
                "series": [{"name": m, "values": [v]} for m, v in zip(measures, values)],
                "stacked": False, "horizontal": False, "note": None, "reason": None,
            }
        return _table(ct, f"This result has {len(rows):,} rows of numbers and no category or date column to put on the axis, so it is shown as a table.", measures)
    if ct == "kpi":
        return _table(ct, "A single-value tile needs one row with one number; this result has a breakdown, so it is shown as a table.", measures)

    # ---- which dimension is the axis ----
    x = next((d for d in dims if d["axis"] == "time"), None) or next((d for d in dims if d.get("time_like")), None) or dims[0]
    others = [d for d in dims if d is not x]
    if len(others) > 1:
        names = ", ".join(d["name"] for d in dims)
        return _table(ct, f"This result is broken down by {len(dims)} columns ({names}); a {_friendly_type(ct)} chart can show one axis and one series split, so it is shown as a table.", measures)
    series_dim = others[0] if others else None
    xname = x["name"]

    # ---- the categories, in order ----
    sortable = x["axis"] == "time" or (x["axis"] == "ordinal" and (x.get("time_like") or ct in LINE_TYPES))
    work = rows
    if sortable:
        # A period with no value cannot be placed on an ordered axis.
        work = [r for r in rows if not _is_blank(r.get(xname))]
        if not work:
            return _table(ct, f"Every {xname} value is empty, so there is nothing to put on the axis.", measures)
    labels: list[str] = []
    raw_values: list = []
    index: dict[str, int] = {}
    for r in work:
        lab = value_label(r.get(xname))
        if lab not in index:
            index[lab] = len(labels)
            labels.append(lab)
            raw_values.append(None if _is_blank(r.get(xname)) else r.get(xname))
    if sortable:
        keyed = [(_order_key(v), i) for i, v in enumerate(raw_values)]
        if all(k is not None for k, _ in keyed):
            order = [i for _, i in sorted(keyed, key=lambda t: (t[0], t[1]))]
            labels = [labels[i] for i in order]
            raw_values = [raw_values[i] for i in order]
            index = {lab: i for i, lab in enumerate(labels)}
    if len(labels) > MAX_CATEGORIES:
        return _table(ct, f"{len(labels):,} distinct {xname} values are too many for one axis, so this is shown as a table.", measures)

    stacked = ct in ("stacked_bar", "stacked_area")
    horizontal = ct == "horizontal_bar"
    note = None
    ordered = x["axis"] == "time" or bool(x.get("time_like"))
    base = {"chart_type": ct, "x": {"name": xname, "axis": x["axis"], "ordered": ordered, "labels": labels, "values": raw_values}, "measures": measures,
            "stacked": stacked, "horizontal": horizontal, "reason": None}

    # ---- long: one series per value of the series dimension ----
    if series_dim is not None:
        sname = series_dim["name"]
        measure = measures[0]
        if len(measures) > 1:
            rest = ", ".join(measures[1:])
            note = f"Showing {measure}. {rest} {'is' if len(measures) == 2 else 'are'} in the table."
        order: list[str] = []
        cells: dict[str, list] = {}
        seen: set[tuple[str, str]] = set()
        for r in work:
            xl = value_label(r.get(xname))
            sl = value_label(r.get(sname))
            if (xl, sl) in seen:
                return _table(ct, f"Several rows share the same {xname} and {sname}, so one mark per pair would hide rows; this is shown as a table.", measures)
            seen.add((xl, sl))
            if sl not in cells:
                cells[sl] = [None] * len(labels)
                order.append(sl)
            cells[sl][index[xl]] = _clean_number(r.get(measure))
        if len(order) > MAX_SERIES:
            return _table(ct, f"{len(order)} {sname} values are too many series to tell apart on one chart, so this is shown as a table.", measures)
        if ct in PIE_TYPES:
            return _table(ct, f"A {_friendly_type(ct)} chart shows one breakdown; this result is split by both {xname} and {sname}, so it is shown as a table.", measures)
        return {**base, "kind": "cartesian", "series_by": sname, "measure": measure, "note": note,
                "series": [{"name": s, "values": cells[s]} for s in order]}

    # ---- wide: one series per measure ----
    if len(labels) != len(work):
        return _table(ct, f"Several rows share the same {xname}, so one mark per {xname} would hide rows; this is shown as a table.", measures)
    by_label = {value_label(r.get(xname)): r for r in work}

    def column(m: str) -> list:
        return [_clean_number(by_label[lab].get(m)) for lab in labels]

    if ct in PIE_TYPES:
        measure = measures[0]
        values = column(measure)
        if any(v is not None and v < 0 for v in values):
            return _table(ct, f"A {_friendly_type(ct)} chart cannot show negative values ({measure} has some), so this is shown as a table.", measures)
        if not any(v for v in values if v is not None):
            return _table(ct, f"Every {measure} value is zero or empty, so there is no whole to divide; this is shown as a table.", measures)
        if len(measures) > 1:
            rest = ", ".join(measures[1:])
            note = f"Showing {measure}. {rest} {'is' if len(measures) == 2 else 'are'} in the table."
        return {**base, "kind": "pie", "series_by": None, "measure": measure, "note": note, "stacked": False, "horizontal": False,
                "series": [{"name": measure, "values": values}]}
    return {**base, "kind": "cartesian", "series_by": None, "measure": measures[0] if len(measures) == 1 else None, "note": None,
            "series": [{"name": m, "values": column(m)} for m in measures]}


# ---- the audit -------------------------------------------------------------

OVERLAY_ROLES = {"forecast_line", "forecast_band", "trend_line", "trend_band", "anomaly_markers"}
_REL_TOL = 1e-6


def numbers_equal(a: Any, b: Any) -> bool:
    if a is None or b is None:
        return a is None and b is None
    try:
        fa, fb = float(a), float(b)
    except (TypeError, ValueError):
        return False
    if not math.isfinite(fa) or not math.isfinite(fb):
        return not math.isfinite(fa) and not math.isfinite(fb)
    return abs(fa - fb) <= _REL_TOL * max(1.0, abs(fa), abs(fb))


def _plotly_array(v: Any) -> list | None:
    """A trace's x / y / labels / values as a plain list. Plotly's own JSON
    may carry a typed array ({"dtype", "bdata"}) - not something this audit
    can read, so it is treated as "not the model's values"."""
    if isinstance(v, (list, tuple)):
        return list(v)
    return None


def _title_text(t: Any) -> str:
    if isinstance(t, str):
        return t
    if isinstance(t, dict) and isinstance(t.get("text"), str):
        return t["text"]
    return ""


def name_tokens(s: str) -> set[str]:
    return {t[:-1] if len(t) > 3 and t.endswith("s") else t for t in _tokens(s) if len(t) > 1}


_PLACEHOLDER_NAMES = {"label", "value", "index", "x", "y", "0", "1", "count", "level", "unnamed"}


def _is_placeholder(name: str | None) -> bool:
    return not name or str(name).strip().lower() in _PLACEHOLDER_NAMES or str(name).lower().startswith("level_")


def axis_label_ok(label: str | None, own_names: list[str], other_names: list[str]) -> bool:
    """Does an axis title name the column(s) actually on that axis?

    Accepted: it shares a word with one of the axis's own columns - or the
    axis's columns have no real name of their own (a Series' "label" /
    "value"), in which case there is nothing to contradict. Rejected: it
    shares no word with them, or it names a column of the OTHER axis
    instead ("Total revenue" under an axis of years)."""
    text = (label or "").strip()
    if not text:
        return True
    want = name_tokens(text)
    if not want:
        return True
    own = set().union(*[name_tokens(n) for n in own_names]) if own_names else set()
    other = set().union(*[name_tokens(n) for n in other_names]) if other_names else set()
    if want & own:
        return True
    if want & other:
        return False
    return all(_is_placeholder(n) for n in own_names)


def y_axis_names(model: dict) -> list[str]:
    """The column names a value-axis title may refer to."""
    names = list(model.get("measures") or [])
    if model.get("measure") and model["measure"] not in names:
        names.append(model["measure"])
    return names


def audit_figure(figure: Any, model: dict) -> list[str]:
    """Every way `figure` (a Plotly {"data", "layout"} dict) disagrees with
    `model`. An empty list means the figure draws exactly the model: the
    right number of traces, each trace's categories from the dimension,
    each trace's values one of the model's series, axis titles that name
    the columns on them, straight segments, a category (or date) axis.

    kind "passthrough" and "table" are not auditable here (returns [])."""
    kind = model.get("kind")
    if kind not in ("cartesian", "pie", "kpi"):
        return []
    problems: list[str] = []
    if not isinstance(figure, dict):
        return ["the figure is not a Plotly figure"]
    data = figure.get("data")
    layout = figure.get("layout") if isinstance(figure.get("layout"), dict) else {}
    traces = [t for t in (data or []) if isinstance(t, dict) and not (isinstance(t.get("meta"), dict) and t["meta"].get("role") in OVERLAY_ROLES)]
    series = model.get("series") or []

    if kind == "kpi":
        shown = [s for s in series if s["values"] and s["values"][0] is not None]
        if len(traces) != len(shown) or any(t.get("type") != "indicator" for t in traces):
            return [f"{len(shown)} single value(s) should be {len(shown)} indicator(s); the figure has {len(traces)} trace(s) of type {traces[0].get('type') if traces else None}"]
        for t, s in zip(traces, shown):
            if not numbers_equal(t.get("value"), s["values"][0]):
                problems.append(f"the indicator for {s['name']} shows {t.get('value')!r}, the table says {s['values'][0]!r}")
        return problems

    labels = list(model["x"]["labels"])
    label_set = set(labels)

    if kind == "pie":
        if len(traces) != 1 or traces[0].get("type") != "pie":
            return [f"a pie should be one pie trace, the figure has {len(traces)} trace(s)"]
        t = traces[0]
        tl, tv = _plotly_array(t.get("labels")), _plotly_array(t.get("values"))
        if tl is None or tv is None or len(tl) != len(tv):
            return ["the pie's labels and values are not readable lists of the same length"]
        want = {lab: v for lab, v in zip(labels, series[0]["values"])}
        used: set[str] = set()
        other_total = None
        for lab, v in zip(tl, tv):
            key = value_label(lab)
            if key in want and key not in used:
                used.add(key)
                if not numbers_equal(v, want[key] if want[key] is not None else 0) and not (want[key] is None and v is None):
                    problems.append(f"slice {key!r} is {v!r}, the table says {want[key]!r}")
            elif re.match(r"^Other( \(\d+\))?$", str(lab)) and other_total is None:
                other_total = v
            else:
                problems.append(f"slice {str(lab)!r} is not a {model['x']['name']} value")
        rest = [want[k] or 0 for k in labels if k not in used]
        if other_total is not None:
            if not numbers_equal(other_total, sum(rest)):
                problems.append(f"the 'Other' slice is {other_total!r}, the remaining rows add up to {sum(rest)!r}")
        elif any(rest):
            problems.append(f"{len(rest)} {model['x']['name']} value(s) are missing from the pie")
        return problems

    # ---- cartesian ----
    if len(traces) != len(series):
        problems.append(f"{len(traces)} trace(s) drawn, the table has {len(series)} series")
    unmatched = list(range(len(series)))
    for ti, t in enumerate(traces):
        ttype = t.get("type") or "scatter"
        if ttype not in ("scatter", "bar", "scattergl"):
            problems.append(f"trace {ti + 1} is a {ttype} trace")
            continue
        horizontal = t.get("orientation") == "h"
        cats = _plotly_array(t.get("y") if horizontal else t.get("x"))
        vals = _plotly_array(t.get("x") if horizontal else t.get("y"))
        if cats is None or vals is None or len(cats) != len(vals):
            problems.append(f"trace {ti + 1} has no readable category / value lists")
            continue
        cat_labels = [value_label(c) for c in cats]
        stray = [c for c in cat_labels if c not in label_set]
        if stray:
            problems.append(f"trace {ti + 1} ({t.get('name') or 'unnamed'}) plots {stray[0]!r} on the {model['x']['name']} axis, which is not a {model['x']['name']} value")
            continue
        if len(set(cat_labels)) != len(cat_labels):
            problems.append(f"trace {ti + 1} repeats a {model['x']['name']} value")
            continue
        got = dict(zip(cat_labels, vals))

        def same(si: int) -> bool:
            want = series[si]["values"]
            for lab, w in zip(labels, want):
                g = got.get(lab)
                if isinstance(g, float) and not math.isfinite(g):
                    g = None
                if not numbers_equal(g, w):
                    return False
            return True

        named = next((si for si in unmatched if str(series[si]["name"]) == str(t.get("name"))), None)
        match = named if named is not None and same(named) else next((si for si in unmatched if same(si)), None)
        if match is None:
            problems.append(f"trace {ti + 1} ({t.get('name') or 'unnamed'}) does not equal any series of the table")
        else:
            unmatched.remove(match)
        line = t.get("line") if isinstance(t.get("line"), dict) else {}
        if ttype != "bar" and line.get("shape") == "spline":
            problems.append(f"trace {ti + 1} is drawn as a smoothed curve, which invents values between points")

    horizontal_fig = any(t.get("orientation") == "h" for t in traces)
    cat_key, val_key = ("yaxis", "xaxis") if horizontal_fig else ("xaxis", "yaxis")
    for key, axis in layout.items():
        if not isinstance(axis, dict) or not re.match(rf"^{cat_key}\d*$", key):
            continue
        want_type = "date" if model["x"]["axis"] == "time" else "category"
        if axis.get("type") not in (want_type, "category"):
            problems.append(f"the {model['x']['name']} axis is not a category axis (type {axis.get('type')!r}), so its ticks may fall between values")
    cat_title = _title_text((layout.get(cat_key) or {}).get("title") if isinstance(layout.get(cat_key), dict) else None)
    val_title = _title_text((layout.get(val_key) or {}).get("title") if isinstance(layout.get(val_key), dict) else None)
    measure_names = y_axis_names(model)
    if not axis_label_ok(cat_title, [model["x"]["name"]], measure_names):
        problems.append(f"the axis titled {cat_title!r} does not name the column on it ({model['x']['name']})")
    if not value_axis_label_ok(val_title, model):
        problems.append(f"the axis titled {val_title!r} does not name the values on it")
    return problems


def value_axis_label_ok(label: str | None, model: dict) -> bool:
    """A value-axis title is accepted when it names a measure, or when it
    names no column at all on a chart whose series are columns of one
    pivoted quantity (the quantity's own name is not in the table then, so
    a unit caption like "Total Revenue (USD)" cannot be contradicted). It
    is rejected when it names the dimension, or - with a single measure -
    when it names something that is not that measure."""
    text = (label or "").strip()
    if not text:
        return True
    names = y_axis_names(model)
    dim_names = [model["x"]["name"]] + ([model["series_by"]] if model.get("series_by") else [])
    want = name_tokens(text)
    if not want:
        return True
    own = set().union(*[name_tokens(n) for n in names]) if names else set()
    other = set().union(*[name_tokens(n) for n in dim_names])
    if want & own:
        return True
    if want & other:
        return False
    if len(model.get("series") or []) > 1 and not model.get("series_by"):
        return True
    return all(_is_placeholder(n) for n in names)
