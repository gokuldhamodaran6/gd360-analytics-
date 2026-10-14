"""
2026-10-09 (round 14): how an answer is PRESENTED - the layer between the
computed analysis and what a person reads.

Everything here is deterministic and only re-shapes or re-writes numbers
GD360 already computed; it never invents one.

  humanize(col)            arrival_date_month -> "Arrival month", avg_adr -> "Avg ADR"
  column_kind(col, values) currency / percent / ratio / integer / number, from the
                           column's name and the values that came back
  annotate(payload)        every visual column gets a label, a format and - for a
                           helper sort key (month_num beside month names) - is dropped
  focus_visual(...)        a breakdown's chart: the dimension and ONE measure, in
                           calendar order for months/weekdays, plus a detail table
  supporting_visuals(...)  one chart per other step that answers another part of a
                           multi-part question (which year, which month, which channel)
  coverage(tables)         months/years the data covers unevenly ("July and August
                           appear in 3 years, the other months in 2")
  polish(text, index)      776676.8399999982 -> $776.7k, 4122 -> 4,122, 67.0 -> $67.00
                           in the written answer, by the column each number came from
"""
from __future__ import annotations

import math
import re

import pandas as pd

from .. import semantics as _sem
from .numbers import CURRENCY_SYMBOLS, _NUM_RE, _DATE_RE, _finite, _symbol

MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october",
          "november", "december"]
_MONTH_POS = {m: i + 1 for i, m in enumerate(MONTHS)} | {m[:3]: i + 1 for i, m in enumerate(MONTHS)} | {"sept": 9}
WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
_WEEKDAY_POS = {d: i + 1 for i, d in enumerate(WEEKDAYS)} | {d[:3]: i + 1 for i, d in enumerate(WEEKDAYS)}

ACRONYMS = {
    "adr": "ADR", "id": "ID", "usd": "USD", "eur": "EUR", "gbp": "GBP", "inr": "INR", "kpi": "KPI", "sku": "SKU", "ltv": "LTV",
    "cac": "CAC", "arpu": "ARPU", "mrr": "MRR", "arr": "ARR", "roi": "ROI", "roas": "ROAS", "aov": "AOV", "gmv": "GMV",
    "ctr": "CTR", "cpc": "CPC", "cpa": "CPA", "cpm": "CPM", "nps": "NPS", "csat": "CSAT", "dau": "DAU", "mau": "MAU",
    "ota": "OTA", "ta": "TA", "to": "TO", "gds": "GDS", "revpar": "RevPAR", "yoy": "YoY", "mom": "MoM", "ytd": "YTD", "url": "URL",
    "seo": "SEO", "sem": "SEM", "b2b": "B2B", "b2c": "B2C", "vat": "VAT", "cogs": "COGS", "ebitda": "EBITDA", "hr": "HR",
}
WORDS = {"avg": "avg", "num": "number", "cnt": "count", "qty": "quantity", "amt": "amount", "pct": "%", "perc": "%",
         "nbr": "number", "no": "number", "yr": "year", "mo": "month", "dt": "date", "desc": "description"}

_CURRENCY_NAME = re.compile(
    r"(revenue|sales|amount|price|cost|spend|spent|income|profit|earning|turnover|gmv|aov|arpu|ltv|cac|cpc|cpa|cpm|"
    r"revpar|fee|payment|budget|payout|refund|discount_value|order_value|basket_value|adr|daily_rate|room_rate|"
    r"salary|salaries|wage|payroll|invoice|billing|bill|mrr|arr\b)", re.I)
_PERCENT_NAME = re.compile(r"(^|_)(pct|percent|percentage|share|rate|ratio|conversion|ctr|margin_pct)($|_)", re.I)
_NOT_PERCENT = re.compile(r"(daily_rate|room_rate|adr|exchange_rate|hourly_rate|day_rate|rate_amount)", re.I)
_HELPER = re.compile(r"(^|_)(num|number|no|idx|index|order|sort|sort_key|rank|position|pos|seq)$", re.I)
_YEAR_NAME = re.compile(r"(^|_)(year|yr|fiscal_year)$", re.I)
_MONTH_NAME = re.compile(r"(^|_)(month|mon|month_name)$", re.I)
_AVG_NAME = re.compile(r"(^|_)(avg|average|mean|median|rate|pct|percent|share|ratio)(_|$)", re.I)


# ---- names -------------------------------------------------------------------

def humanize(name) -> str:
    """A column name as a label a person reads."""
    s = str(name or "").strip()
    if not s:
        return ""
    if " " in s and s != s.lower():
        return s  # already a label ("Total revenue")
    parts = [p for p in re.split(r"[_\s\-]+", re.sub(r"([a-z])([A-Z])", r"\1_\2", s)) if p]
    low = [p.lower() for p in parts]
    out: list[str] = []
    for i, w in enumerate(low):
        nxt = low[i + 1] if i + 1 < len(low) else ""
        if w in ("date", "dt") and nxt in ("year", "month", "day", "week", "quarter", "hour"):
            continue  # arrival_date_month -> arrival month
        if w in ("pct", "perc", "percent", "percentage") and any(x in low for x in ("rate", "share", "ratio")):
            continue  # cancellation_rate_pct -> cancellation rate (the % is in the number)
        out.append(ACRONYMS.get(w) or WORDS.get(w, w))
    if not out:
        return s
    if out[-1] == "number" and len(out) > 1 and out[-2] in ("month", "week", "day", "quarter"):
        out = out[:-1] + ["number"]
    text = " ".join(out).replace(" %", " %").strip()
    return text[0].upper() + text[1:]


def metric_total_label(metric: str) -> str:
    """'Total revenue', never 'Total Total Revenue'."""
    m = (metric or "").strip()
    if m.lower().startswith(("total", "sum of", "overall")):
        return m[:1].upper() + m[1:]
    return "Total " + (m[:1].lower() + m[1:] if m[:1].isupper() and not m[:2].isupper() else m)


def metric_lower(metric: str) -> str:
    """'total revenue' inside a sentence: 'share of total revenue'."""
    m = (metric or "").strip()
    if not m:
        return m
    m = m if m.lower().startswith("total") else "total " + m
    words = m.split(" ")
    return " ".join(w if (w.isupper() and len(w) > 1) else w.lower() for w in words)


def in_sentence(metric: str) -> str:
    """'Net Sales' -> 'net sales' mid-sentence (acronyms kept: 'AOV', 'ADR'); no 'total' added (round 33)."""
    words = (metric or "").strip().split(" ")
    return " ".join(w if (w.isupper() and len(w) > 1) else w.lower() for w in words if w)


# ---- formats -----------------------------------------------------------------

def _numbers(values) -> list[float]:
    out = []
    for v in values:
        if isinstance(v, bool):
            continue
        f = _finite(v)
        if f is not None:
            out.append(f)
    return out


def column_kind(name, values, default: str | None = None) -> str:
    """currency / percent (12.4 = 12.4%) / ratio (0.124 = 12.4%) / integer / number."""
    n = str(name or "")
    nums = _numbers(values)
    if _CURRENCY_NAME.search(n) and not (_PERCENT_NAME.search(n) and not _NOT_PERCENT.search(n)):
        return "currency"
    if _PERCENT_NAME.search(n) and not _NOT_PERCENT.search(n):
        if nums and all(0 <= x <= 1 for x in nums) and not re.search(r"pct|percent", n, re.I):
            return "ratio"
        if not nums or all(-1000 <= x <= 1000 for x in nums):
            return "percent"
    if nums and all(float(x).is_integer() for x in nums):
        return "integer"
    return default or "number"


def nice(v, kind: str = "number", currency: str | None = "USD") -> str:
    """A number as it is written in a sentence or a table cell.

    2026-10-13 (R45): half-up rounding and semantics.compact, like the frontend (21.075 -> 21.08,
    999,999 -> 1M - never "1000.0K"); a currency GD360 has no symbol for is written as its code."""
    f = _finite(v)
    if f is None:
        return "—"
    a = abs(f)
    sign = "−" if f < 0 else ""
    if kind == "percent":
        return f"{sign}{_sem.fmt_number(a, 1)}%"
    if kind == "ratio":
        return f"{sign}{_sem.fmt_number(a * 100, 1)}%"
    if kind == "currency":
        sym = _symbol(currency)
        if a >= 9999.5:
            body = _sem.compact(a)
        elif a >= 100:
            body = f"{int(_sem.round_half_up(a, 0)):,}"
        else:
            body = f"{_sem.round_half_up(a, 2):,.2f}"
        return f"{sign}{sym}{body}" if sym else f"{sign}{body} {currency}"
    if kind == "integer":
        return f"{sign}{int(_sem.round_half_up(a, 0)):,}"
    if a >= 999_999.5:
        return sign + _sem.compact(a)
    if a >= 1000:
        return f"{sign}{int(_sem.round_half_up(a, 0)):,}"
    if a >= 1:
        return sign + _sem.fmt_number(a, 2).rstrip("0").rstrip(".")
    if a == 0:
        return "0"
    return f"{sign}{a:.3g}"


# ---- calendar dimensions -----------------------------------------------------

_MONTH_YEAR = re.compile(r"([a-z]{3,9})\.?[\s\-/']+'?(\d{2}|\d{4})")
_YEAR_MONTH = re.compile(r"(\d{4})[-/](\d{1,2})")
_QUARTER_YEAR = re.compile(r"(?:(\d{4})[\s\-/]?q([1-4])|q([1-4])[\s\-/]?'?(\d{2}|\d{4}))")


def calendar_position(v) -> int | None:
    """Where a calendar label sits in time: Jan=1, Monday=1, Q3=3 - and (2026-10-13, R45) the labels
    GD360 writes for months of several years, "Jan 2025", "2025-01" and "Q1 2025", as yyyymm00 keys so
    they sort in time, never alphabetically."""
    s = str(v if v is not None else "").strip().lower()
    if s in _MONTH_POS:
        return _MONTH_POS[s]
    if s in _WEEKDAY_POS:
        return _WEEKDAY_POS[s]
    m = re.fullmatch(r"q([1-4])", s)
    if m:
        return int(m.group(1))
    m = _MONTH_YEAR.fullmatch(s)
    if m and m.group(1) in _MONTH_POS:
        y = int(m.group(2))
        y = y + 2000 if y < 100 else y
        return y * 10000 + _MONTH_POS[m.group(1)] * 100
    m = _YEAR_MONTH.fullmatch(s)
    if m and 1 <= int(m.group(2)) <= 12:
        return int(m.group(1)) * 10000 + int(m.group(2)) * 100
    m = _QUARTER_YEAR.fullmatch(s)
    if m:
        y, q = (m.group(1), m.group(2)) if m.group(1) else (m.group(4), m.group(3))
        y = int(y) + (2000 if len(y) == 2 else 0)
        return y * 10000 + (int(q) * 3 - 2) * 100
    return None


def sort_key(v) -> tuple:
    """A key that orders any time-like label the way a person reads it (2026-10-13, R45): calendar labels
    by calendar_position, ISO dates in time, numeric strings as numbers ("2" before "10"), the rest as text."""
    pos = calendar_position(v)
    if pos is not None:
        return (0, float(pos), "")
    if isinstance(v, (int, float)) and not isinstance(v, bool) and _finite(v) is not None:
        return (1, float(v), "")
    s = str(v if v is not None else "").strip()
    f = _finite(s.replace(",", "")) if re.fullmatch(r"[-+]?[\d,]*\.?\d+", s) else None
    if f is not None:
        return (1, f, "")
    if re.match(r"^\d{4}-\d{2}-\d{2}", s):
        return (2, 0.0, s)
    return (3, 0.0, s.lower())


def is_month_series(values) -> bool:
    vals = [str(v).strip().lower() for v in values if v is not None and str(v).strip()]
    return bool(vals) and all(v in _MONTH_POS for v in vals)


def _is_calendar(values) -> bool:
    vals = [v for v in values if v is not None and str(v).strip()]
    return len(vals) > 1 and all(calendar_position(v) is not None for v in vals)


def _year_col(df: pd.DataFrame) -> str | None:
    for c in df.columns:
        if _YEAR_NAME.search(str(c)):
            nums = _numbers(df[c].tolist())
            if nums and all(1900 <= x <= 2100 and float(x).is_integer() for x in nums):
                return c
    return None


def _month_col(df: pd.DataFrame) -> str | None:
    for c in df.columns:
        vals = df[c].dropna().tolist()
        if not vals:
            continue
        if is_month_series(vals):
            return c
        if _MONTH_NAME.search(str(c)):
            nums = _numbers(vals)
            if nums and len(nums) == len(vals) and all(1 <= x <= 12 and float(x).is_integer() for x in nums):
                return c
    return None


def _month_number(v) -> int | None:
    s = str(v).strip().lower()
    if s in _MONTH_POS:
        return _MONTH_POS[s]
    f = _finite(v)
    return int(f) if f is not None and 1 <= f <= 12 else None


def helper_columns(df: pd.DataFrame) -> list[str]:
    """Sort keys that only order another column (month_num beside month
    names, a rank beside a ranked label): kept out of charts and tables."""
    out = []
    for c in df.columns:
        if not _HELPER.search(str(c)):
            continue
        nums = _numbers(df[c].tolist())
        if not nums or len(nums) != len(df) or not all(float(x).is_integer() for x in nums):
            continue
        if len(set(nums)) != len(nums):
            continue
        # one-to-one with a label column?
        for other in df.columns:
            if other == c or pd.api.types.is_numeric_dtype(df[other]):
                continue
            if df[other].nunique(dropna=False) == len(df):
                out.append(c)
                break
    return out


def _dims_measures(df: pd.DataFrame) -> tuple[list[str], list[str]]:
    from .analysis import _ID_LIKE
    dims, measures = [], []
    helpers = set(helper_columns(df))
    for c in df.columns:
        if c in helpers:
            continue
        s = df[c]
        if pd.api.types.is_bool_dtype(s) or not pd.api.types.is_numeric_dtype(s):
            dims.append(c)
        elif _ID_LIKE.search(str(c)) and pd.api.types.is_integer_dtype(s):
            dims.append(c)
        else:
            measures.append(c)
    return dims, measures


# ---- visual payloads ---------------------------------------------------------

def annotate(payload: dict, currency: str | None = "USD", drop_helpers: bool = True) -> dict:
    """Labels and formats on every column of a {columns, rows} payload; a
    helper sort key is used to order the rows and then dropped."""
    cols = payload.get("columns") or []
    rows = payload.get("rows") or []
    if not cols:
        return payload
    if drop_helpers and rows:
        df = pd.DataFrame(rows)
        helpers = [h for h in helper_columns(df) if h in df.columns]
        if helpers:
            df = df.sort_values(helpers[0], kind="stable")
            rows = df.drop(columns=helpers).to_dict(orient="records")
            rows = [{k: (None if isinstance(v, float) and not math.isfinite(v) else v) for k, v in r.items()} for r in rows]
            cols = [c for c in cols if c["name"] not in helpers]
    out_cols = []
    for c in cols:
        c = dict(c)
        c["label"] = humanize(c["name"])
        if c.get("role") == "measure" or c.get("dtype") == "number":
            kind = column_kind(c["name"], [r.get(c["name"]) for r in rows])
            c["format"] = kind
            if kind == "currency":
                c["currency"] = (currency or "USD").upper()
        out_cols.append(c)
    return {**payload, "columns": out_cols, "rows": rows}


def _primary_measure(measures: list[str], prefer: str | None = None) -> str | None:
    if not measures:
        return None
    if prefer and prefer in measures:
        return prefer
    for m in measures:
        if _CURRENCY_NAME.search(str(m)) and _additive(m):
            return m
    for m in measures:
        if _additive(m):
            return m
    return measures[0]


_SUM_WORD = re.compile(r"\b(total|sum)\b")
_AVG_WORD = re.compile(r"\b(avg|average|mean|median|per)\b")
_NEVER_SUM = ("id", "sequence", "year", "clock", "percent", "rate", "date", "boolean", "text", "geo", "category")


def _additive(measure: str, series: pd.Series | None = None) -> bool:
    """Whether a measure may be added up across rows (2026-10-13, R45: from services/semantics, not a
    short name list). Never: averages, per-X ratios, AOV/ARPU, prices, margins, rates, percentages, scores,
    ratings, ages and other levels - "Total revenue per customer $400" and "Total AOV $165" were the old
    result. With the values, an ID, a year, a clock time or a percentage is never summed either."""
    text = _sem._norm(measure)
    if series is not None:
        try:
            role = _sem.infer_column(measure, series).get("role")
        except Exception:  # noqa: BLE001
            role = None
        if role in _NEVER_SUM and not (role == "category" and pd.api.types.is_numeric_dtype(series)):
            return False
    if _AVG_WORD.search(text):
        return False
    if _SUM_WORD.search(text):
        return True
    if _sem._has(_sem._AVG_W, text):
        return False
    if _sem._has(_sem._PERCENT_W, text) and not _sem._has(_sem._NOT_PERCENT_W, text):
        return False
    return True


_WEIGHT_NAME = re.compile(r"\b(orders?|customers?|users?|sessions?|visits?|visitors?|transactions?|count|counts|n|units|"
                          r"quantity|qty|volume|weight|weights|leads|clicks|impressions|bookings|tickets|calls|members|"
                          r"accounts|records|rows|deals|nights|items|responses|respondents|patients|students|employees|"
                          r"shipments|purchases|installs|signups|views|pageviews)\b")


def weight_column(df: pd.DataFrame, measure: str, exclude: tuple | list = ()) -> str | None:
    """The count a non-additive measure is an average over (orders beside avg_order_value), so a segment
    with several rows is averaged weighted by it, not row by row (2026-10-13, R45)."""
    for c in df.columns:
        if c == measure or c in exclude:
            continue
        if not pd.api.types.is_numeric_dtype(df[c]) or pd.api.types.is_bool_dtype(df[c]):
            continue
        text = _sem._norm(c)
        if not _WEIGHT_NAME.search(text) or _AVG_WORD.search(text) or _sem._has(_sem._ID_W, text):
            continue
        w = pd.to_numeric(df[c], errors="coerce")
        if w.notna().any() and (w.dropna() >= 0).all() and w.sum() > 0:
            return c
    return None


def aggregate(df: pd.DataFrame, keys: list, measure: str, additive: bool | None = None) -> pd.DataFrame:
    """One row per key: a sum for an additive measure; for a non-additive one the mean - weighted by its
    count column when the rows have one (2026-10-13, R45: a mean of means let 1 order count as much as 99)."""
    work = df.copy()
    work[measure] = pd.to_numeric(work[measure], errors="coerce")
    work = work.dropna(subset=[measure])
    if additive is None:
        additive = _additive(measure, df[measure])
    if additive:
        return work.groupby(keys, as_index=False, dropna=False)[measure].sum()
    w = weight_column(work, measure, exclude=keys) if work.duplicated(subset=keys).any() else None
    if w is None:
        return work.groupby(keys, as_index=False, dropna=False)[measure].mean()
    work["__w"] = pd.to_numeric(work[w], errors="coerce").fillna(0)
    work["__vw"] = work[measure] * work["__w"]
    g = work.groupby(keys, as_index=False, dropna=False)[["__vw", "__w"]].sum()
    g[measure] = g["__vw"] / g["__w"].where(g["__w"] != 0)
    return g[keys + [measure]]


def chart_payload(df: pd.DataFrame, dim: str, measure: str, series: str | None = None, currency: str | None = "USD",
                  limit: int = 12) -> tuple[dict, str, str | None]:
    """One measure by one dimension (and an optional series): the chart's
    own table, aggregated, in calendar order for months/weekdays/quarters,
    largest first otherwise. Returns (payload, chart_type, note)."""
    from .analysis import table_payload
    keys = [dim] + ([series] if series else [])
    work = aggregate(df, keys, measure)  # 2026-10-13 (R45): weighted when the measure is an average
    note = None
    calendar = _is_calendar(work[dim].tolist())
    if calendar:
        work["__pos"] = work[dim].map(calendar_position)
        work = work.sort_values(["__pos"] + ([series] if series else [])).drop(columns="__pos")
        chart_type = "grouped_bar" if series else "bar"
    else:
        order = work.groupby(dim)[measure].sum().sort_values(ascending=False)
        if len(order) > limit:
            keep = list(order.index[:limit])
            note = f"Showing the {limit} largest of {len(order)} {humanize(dim).lower()} values; every value is in the table."
            work = work[work[dim].isin(keep)]
        rank = {k: i for i, k in enumerate(order.index)}
        work = work.assign(__r=work[dim].map(rank)).sort_values("__r").drop(columns="__r")
        n = work[dim].nunique()
        chart_type = ("grouped_bar" if series else ("horizontal_bar" if n > 6 else "bar"))
    payload = annotate(table_payload(work), currency, drop_helpers=False)
    return payload, chart_type, note


def details_payload(df: pd.DataFrame, currency: str | None = "USD", limit: int = 60) -> dict:
    from .analysis import table_payload
    p = annotate(table_payload(df, limit=limit), currency)
    rows = p.get("rows") or []
    # calendar order for a month / weekday column
    dim = next((c["name"] for c in p["columns"] if c.get("dtype") != "number" and _is_calendar([r.get(c["name"]) for r in rows])), None)
    if dim:
        rows = sorted(rows, key=lambda r: sort_key(r.get(dim)))
    return {**p, "rows": rows}


def focus_visuals(spec: dict, df: pd.DataFrame, title: str | None, currency: str | None) -> list[dict]:
    """A breakdown drawn the way an analyst would: the dimension and the ONE
    measure the question is about (never a helper column as a series, never
    a top-N cut of a calendar axis), and the other measures as a table."""
    dims, measures = _dims_measures(df)
    dim = spec.get("dimension_column")
    val = spec.get("value_column")
    if dim not in df.columns or val not in df.columns:
        return []
    out = []
    payload, chart_type, note = chart_payload(df, dim, val, None, currency, limit=15)
    if spec.get("chart_type") in ("line", "area") and _is_calendar(df[dim].tolist()):
        chart_type = spec["chart_type"]
    metric = spec.get("metric_name") or humanize(val)
    out.append({"type": "chart", "title": title or f"{metric} by {humanize(dim).lower()}", "chart_type": chart_type,
                **payload, **({"note": note} if note else {})})
    others = [m for m in measures if m != val]
    if others and len(df) <= 60:
        out.append({"type": "chart", "title": f"All measures by {humanize(dim).lower()}", "chart_type": "table", "display": "table",
                    **details_payload(df, currency)})
    return out


_TIME_FILTER = re.compile(r"\bwhere\b[\s\S]*?\b(\w*date\w*|\w*_at|\w*time\w*|year|month|day|week|quarter|period|between|"
                          r"interval|current_date|now\s*\(|timestamp)\b", re.I)


def data_span(tables: dict) -> str | None:
    """'2021–2025': the years the dated results cover (round 33), or None."""
    from .forecasting import _time_of
    lo = hi = None
    for df in (tables or {}).values():
        if df is None or not len(df):
            continue
        try:
            got = _time_of(df, None)
        except Exception:  # noqa: BLE001
            got = None
        if not got:
            continue
        years = pd.to_datetime(got[0], errors="coerce").dt.year.dropna()
        if years.empty:
            continue
        lo = int(years.min()) if lo is None else min(lo, int(years.min()))
        hi = int(years.max()) if hi is None else max(hi, int(years.max()))
    if lo is None:
        return None
    return str(lo) if lo == hi else f"{lo}–{hi}"


def scope_suffix(sql: str | None, plan: dict, span: str | None) -> str:
    """What period a total covers, said in its title (round 33): an all-time total read under a 2026
    forecast must not look like a year. ' · 2021–2025 total', ' · Q1 2025', or '' when unknown."""
    brief = (plan.get("brief") or {}).get("period") if isinstance(plan.get("brief"), dict) else None
    filtered = bool(_TIME_FILTER.search(sql or ""))
    if not filtered:
        return f" · {span} total" if span and "–" in span else (f" · {span}" if span else "")
    if brief and brief.get("text") and not brief.get("forecast") and not brief.get("parts"):
        return f" · {brief['text']}"
    return ""


def honest_title(step_title: str, measure: str, dim: str | None, others: list[str]) -> str:
    """The step's own title when the chart shows what it promises; otherwise what is really drawn
    ("Net sales by customer segment", not "Segment performance and order economics" over net sales alone)."""
    if not others:
        return step_title
    mw = humanize(measure)
    return f"{mw} by {humanize(dim).lower()}" if dim else mw


def supporting_visuals(plan: dict, tables: dict, used: set, currency: str | None, focus_dim: str | None = None,
                       limit: int = 4) -> list[dict]:
    """One chart for each other step that answers another part of the
    question: a monthly trend (year + month columns become a period axis), a
    split by the most telling dimension, or - for a few rows of averages - a
    small table. Steps already drawn, the context of a change and empty or
    raw-row results are left to the Evidence tab."""
    from .analysis import table_payload
    titles = {s.get("id"): s.get("title") for s in (plan.get("steps") or []) + (plan.get("combine") or [])}
    sqls = {s.get("id"): s.get("sql") for s in plan.get("steps") or []}
    span = data_span(tables)
    # a step a shown combine was built from is already on the page
    for cb in plan.get("combine") or []:
        if cb.get("id") in used:
            for sid in list(titles):
                if sid and sid != cb.get("id") and re.search(rf"\b{re.escape(sid)}\b", cb.get("sql") or ""):
                    used = used | {sid}
    ctx = set((plan.get("analysis") or {}).get("context") or [])
    out: list[dict] = []
    order = [s.get("id") for s in (plan.get("combine") or [])][::-1] + [s.get("id") for s in plan.get("steps") or []]
    seen_shapes: set = set()
    for tid in order:
        if len(out) >= limit:
            break
        if not tid or tid in used or tid in ctx or tid not in tables:
            continue
        df = tables[tid]
        if df is None or len(df) == 0 or len(df) > 5000:
            continue
        dims, measures = _dims_measures(df)
        if not measures:
            continue
        title = titles.get(tid) or humanize(tid)
        year, month = _year_col(df), _month_col(df)
        measure = _primary_measure(measures)
        try:
            if year and month and measure:
                others = [d for d in dims if d not in (year, month)]
                series = next((d for d in others if 1 < df[d].nunique() <= 6), None)
                keys = [year, month] + ([series] if series else [])
                work = aggregate(df, keys, measure)
                mnum = work[month].map(_month_number)
                work = work[mnum.notna()]
                work["period"] = [f"{int(y):04d}-{int(m):02d}-01" for y, m in zip(work[year], mnum[mnum.notna()])]
                work = work.sort_values("period")[["period"] + ([series] if series else []) + [measure]]
                shape = ("time", series, measure)
                if shape in seen_shapes:
                    continue
                seen_shapes.add(shape)
                payload = annotate(table_payload(work, limit=600), currency, drop_helpers=False)
                for c in payload["columns"]:
                    if c["name"] == "period":
                        c["dtype"], c["role"], c["label"] = "date", "dimension", "Month"
                others = [m for m in measures if m != measure and m not in (year, month)]
                vis = {"type": "chart", "title": honest_title(title, measure, "month", others), "chart_type": "line",
                       "tables": [tid], "time_column": "period", **payload}
                if others and len(df) <= 120:
                    vis["details"] = details_payload(df, currency, limit=120)
                out.append(vis)
                continue
            nominal = [d for d in dims if d != focus_dim and 1 < df[d].nunique() <= 40]
            if not nominal and dims and len(df) <= 12:
                payload = details_payload(df, currency)
                suffix = scope_suffix(sqls.get(tid), plan, span) if tid in sqls and not _year_col(df) else ""
                out.append({"type": "chart", "title": title + suffix, "chart_type": "table", "display": "table", "tables": [tid],
                            **payload})
                continue
            if not nominal or not measure:
                continue
            words = set(re.findall(r"[a-z]+", (title or "").lower()))
            named = lambda d: bool(set(str(d).lower().split("_")) & words)  # noqa: E731
            nominal.sort(key=lambda d: (not named(d), not (2 < df[d].nunique() <= 15), -min(df[d].nunique(), 12)))
            dim = nominal[0]
            series = next((d for d in dims if d not in (dim,) and 1 < df[d].nunique() <= 4), None)
            if not _additive(measure, df[measure]) and weight_column(df, measure, [dim]) is None \
                    and df.duplicated(subset=[dim] + ([series] if series else [])).any():
                series = None
                if df.duplicated(subset=[dim]).any():
                    continue  # averages cannot be re-added; leave it to the evidence tab
            shape = ("split", dim, series, measure)
            if shape in seen_shapes:
                continue
            seen_shapes.add(shape)
            payload, chart_type, note = chart_payload(df, dim, measure, series, currency)
            others = [m for m in measures if m != measure]
            suffix = scope_suffix(sqls.get(tid), plan, span) if tid in sqls and not _year_col(df) else ""
            vis = {"type": "chart", "title": honest_title(title, measure, dim, others) + suffix, "chart_type": chart_type,
                   "tables": [tid], **payload, **({"note": note} if note else {})}
            if others and len(df) <= 60:
                vis["details"] = details_payload(df, currency)
            out.append(vis)
        except Exception as e:  # noqa: BLE001 - a supporting chart is never worth a failed answer
            print(f"[present] supporting visual for {tid} skipped: {e}")
    return out


# ---- coverage ----------------------------------------------------------------

def _range_text(months: list[int]) -> str:
    names = [MONTHS[m - 1][:3].title() for m in sorted(months)]
    return f"{names[0]}–{names[-1]}" if len(names) > 1 else names[0]


def coverage(tables: dict) -> dict:
    """How evenly the data covers the calendar, read off any result that
    has a year and a month column. {"years": {2015: [7..12]}, "partial_years":
    [...], "uneven_months": bool, "notes": [...]}"""
    best = None
    for tid, df in (tables or {}).items():
        if df is None or not len(df):
            continue
        y, m = _year_col(df), _month_col(df)
        if y and m:
            best = (df, y, m)
            break
    if not best:
        return {"notes": []}
    df, y, m = best
    pairs = set()
    for yy, mm in zip(df[y], df[m]):
        n = _month_number(mm)
        fy = _finite(yy)
        if n and fy:
            pairs.add((int(fy), n))
    if not pairs:
        return {"notes": []}
    years: dict[int, list[int]] = {}
    for yy, mm in pairs:
        years.setdefault(yy, []).append(mm)
    per_month: dict[int, int] = {}
    for yy, mm in pairs:
        per_month[mm] = per_month.get(mm, 0) + 1
    notes = []
    partial = [yy for yy, ms in years.items() if len(set(ms)) < 12]
    if len(years) > 1 and partial:
        bits = [f"{yy} only {_range_text(sorted(set(years[yy])))}" for yy in sorted(partial)]
        notes.append(f"The data does not cover whole years ({'; '.join(bits)}), so yearly totals are not like for like.")
    counts = sorted(set(per_month.values()))
    if len(counts) > 1:
        most = max(counts)
        heavy = [MONTHS[k - 1].title() for k in sorted(per_month) if per_month[k] == most]
        rest = min(counts)
        notes.append(f"{', '.join(heavy)} appear{'s' if len(heavy) == 1 else ''} in {most} years of data and other months in "
                     f"as few as {rest}, so month totals favour {', '.join(heavy)}; compare the average per year.")
    return {"years": {k: sorted(set(v)) for k, v in years.items()}, "years_per_month": per_month,
            "partial_years": sorted(partial), "uneven_months": len(counts) > 1, "notes": notes}


# ---- numbers in the written answer -------------------------------------------

def number_index(facts: list[dict], tables: list[dict], currency: str | None) -> list[tuple[float, str]]:
    """(value, kind) for every number GD360 computed or read, so a number
    the writer copied can be written the way its column means it."""
    idx: list[tuple[float, str]] = []
    for f in facts or []:
        v = _finite(f.get("value"))
        if v is not None:
            idx.append((v, f.get("kind") or "number"))
    for t in tables or []:
        cols = list(t.get("columns") or [])
        rows = (t.get("rows") or [])[:300]
        known = {c.get("name") for c in cols}
        for r in rows:
            if isinstance(r, dict):
                for k in r:
                    if k not in known:
                        known.add(k)
                        cols.append({"name": k})
        for c in cols:
            name = c.get("name")
            vals = [r.get(name) for r in rows if isinstance(r, dict)]
            nums = _numbers(vals)
            if not nums:
                continue
            kind = c.get("format") or column_kind(name, nums)
            if _YEAR_NAME.search(str(name)):
                continue
            for v in nums:
                idx.append((v, kind))
    return idx


def _lookup_kind(v: float, idx: list[tuple[float, str]]) -> str | None:
    best = None
    for x, kind in idx:
        tol = max(0.006, abs(x) * 1e-6)
        if abs(v - x) <= tol:
            if kind == "currency":
                return kind
            best = best or kind
    return best


def match_index(n: float, idx: list[tuple[float, str]]) -> tuple[float, str] | None:
    """The computed value a written number stands for, allowing for the
    rounding it was written with ($1.08M for 1,084,751.27)."""
    best = None
    a = abs(n)
    for x, kind in idx:
        ax = abs(x)
        ok = abs(a - ax) <= max(0.051, ax * 0.006)
        if not ok:
            for scale in (1e3, 1e6, 1e9):
                if ax >= scale and abs(a - ax) <= scale * 0.0051:
                    ok = True
                    break
        if ok and (best is None or abs(ax - a) < abs(abs(best[0]) - a)):
            best = (x, kind)
    return best


def polish(text: str, idx: list[tuple[float, str]], currency: str | None = "USD") -> str:
    """Rewrite raw numbers the writer copied out of a table ("776676.8399999982",
    "4122", "at 67.0") the way their column means them ("$776.7k", "4,122",
    "$67.00"). Numbers already written with a unit, a % or separators, and
    years, are left alone."""
    if not text:
        return text
    masked = _DATE_RE.sub(lambda m: "\u0000" * len(m.group(0)), text)
    out, last = [], 0
    for m in _NUM_RE.finditer(masked):
        sign, sym, whole, frac, unit = m.groups()
        if sym or unit or "," in (whole or ""):
            continue
        # the token text without leading/trailing spaces
        start, end = m.start(3), (m.end(4) if frac else m.end(3))
        if start > 0 and masked[start - 1] in "$€£₹¥":
            continue
        after = masked[end:end + 2]
        if after.startswith("%") or after.strip().startswith("%"):
            continue
        try:
            v = float(whole + (frac or ""))
        except ValueError:
            continue
        if not frac and v < 1000:
            continue  # small whole numbers (30 days, 3 hotels) are written as they are
        if not frac and 1900 <= v <= 2100:
            continue
        kind = _lookup_kind(v, idx)
        long_frac = bool(frac) and len(frac) > 3
        if kind is None:
            if not long_frac and v < 10000:
                continue
            kind = "integer" if float(v).is_integer() else "number"
        if kind in ("integer",) and v < 1000 and not frac:
            continue
        if kind == "number" and not long_frac and v < 1000:
            continue
        if kind == "ratio":
            continue  # a fraction written as-is is the writer's choice of words
        if kind == "percent":
            rep = f"{v:.1f}%" if long_frac else None
            if rep is None:
                continue
        else:
            rep = nice(v, kind, currency)
        if sign in ("-", "−"):
            start = m.start(1) if m.start(1) >= 0 else start
            rep = "−" + rep.lstrip("−")
        out.append(text[last:start])
        out.append(rep)
        last = end
    out.append(text[last:])
    return "".join(out)


def polish_answer(answer: dict, idx: list[tuple[float, str]], currency: str | None) -> dict:
    a = dict(answer)
    for k in ("headline", "answer"):
        if a.get(k):
            a[k] = polish(a[k], idx, currency)
    a["causes"] = [{**c, "detail": polish(c.get("detail") or "", idx, currency), "title": polish(c.get("title") or "", idx, currency)}
                   for c in a.get("causes") or []]
    a["ruled_out"] = [{**r, "detail": polish(r.get("detail") or "", idx, currency)} for r in a.get("ruled_out") or []]
    a["next_questions"] = [polish(q, idx, currency) for q in a.get("next_questions") or []]
    return a


# ---- direction of the question -----------------------------------------------

_LOW = re.compile(r"\b(lowest|low|least|worst|weakest|bottom|poorest|slowest|smallest|minimum|min|fewest|underperform\w*|"
                  r"low[- ]performing|drop(ped|s)?|declin\w+|fell|fall(en|ing|s)?|decreas\w+|shrank|lost the most)\b", re.I)
_HIGH = re.compile(r"\b(highest|best|top|most|largest|biggest|strongest|maximum|max|leading|peak|perform(s|ed)? (good|well|best))\b", re.I)
# 2026-10-13 (R45): "top" and "most" only say "rank them"; the word that says WHICH end wins. "top 5 worst
# performing stores", "top 10 products with the least returns" and "which stores dropped the most" ask for
# the low end (the biggest decline). Only an explicit high superlative competes with a low word.
_STRONG_HIGH = re.compile(r"\b(highest|best|largest|biggest|strongest|maximum|max|leading|peak|grew the most|"
                          r"rose the most|increased the most|perform(s|ed)? (good|well|best))\b", re.I)
_NOT_LOW = re.compile(r"\bat least\b|\bat (the )?(very )?least\b|\bleast \d", re.I)


def question_rank(question: str) -> str:
    q = _NOT_LOW.sub(" ", question or "")
    lo = len(_LOW.findall(q))
    if not lo:
        return "highest"
    strong = len(_STRONG_HIGH.findall(q))
    if not strong:
        return "lowest"
    return "lowest" if lo > strong else "highest"
