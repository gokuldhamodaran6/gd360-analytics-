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

from .numbers import CURRENCY_SYMBOLS, _NUM_RE, _DATE_RE, _finite

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
    """A number as it is written in a sentence or a table cell."""
    f = _finite(v)
    if f is None:
        return "—"
    a = abs(f)
    sign = "−" if f < 0 else ""
    if kind == "percent":
        return f"{sign}{a:.1f}%"
    if kind == "ratio":
        return f"{sign}{a * 100:.1f}%"
    if kind == "currency":
        sym = CURRENCY_SYMBOLS.get((currency or "USD").upper(), "")
        if a >= 1e9:
            body = f"{a / 1e9:.2f}B"
        elif a >= 1e6:
            body = f"{a / 1e6:.2f}M" if a < 1e7 else f"{a / 1e6:.1f}M"
        elif a >= 1e4:
            body = f"{a / 1e3:.1f}k"
        elif a >= 100:
            body = f"{a:,.0f}"
        else:
            body = f"{a:,.2f}"
        return f"{sign}{sym}{body}" if sym else f"{sign}{body} {currency}"
    if kind == "integer":
        return f"{sign}{a:,.0f}"
    if a >= 1e9:
        return f"{sign}{a / 1e9:.2f}B"
    if a >= 1e6:
        return f"{sign}{a / 1e6:.2f}M" if a < 1e7 else f"{sign}{a / 1e6:.1f}M"
    if a >= 1000:
        return f"{sign}{a:,.0f}"
    if a >= 1:
        return f"{sign}{a:,.2f}".rstrip("0").rstrip(".")
    if a == 0:
        return "0"
    return f"{sign}{a:.3g}"


# ---- calendar dimensions -----------------------------------------------------

def calendar_position(v) -> int | None:
    s = str(v or "").strip().lower()
    if s in _MONTH_POS:
        return _MONTH_POS[s]
    if s in _WEEKDAY_POS:
        return _WEEKDAY_POS[s]
    m = re.fullmatch(r"q([1-4])", s)
    return int(m.group(1)) if m else None


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
        if _CURRENCY_NAME.search(str(m)) and not _AVG_NAME.search(str(m)):
            return m
    for m in measures:
        if not _AVG_NAME.search(str(m)):
            return m
    return measures[0]


def _additive(measure: str) -> bool:
    return not _AVG_NAME.search(str(measure))


def chart_payload(df: pd.DataFrame, dim: str, measure: str, series: str | None = None, currency: str | None = "USD",
                  limit: int = 12) -> tuple[dict, str, str | None]:
    """One measure by one dimension (and an optional series): the chart's
    own table, aggregated, in calendar order for months/weekdays/quarters,
    largest first otherwise. Returns (payload, chart_type, note)."""
    from .analysis import table_payload
    keys = [dim] + ([series] if series else [])
    work = df[keys + [measure]].copy()
    work[measure] = pd.to_numeric(work[measure], errors="coerce")
    agg = "sum" if _additive(measure) else "mean"
    work = work.dropna(subset=[measure]).groupby(keys, as_index=False, dropna=False)[measure].agg(agg)
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
        rows = sorted(rows, key=lambda r: calendar_position(r.get(dim)) or 99)
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


def supporting_visuals(plan: dict, tables: dict, used: set, currency: str | None, focus_dim: str | None = None,
                       limit: int = 4) -> list[dict]:
    """One chart for each other step that answers another part of the
    question: a monthly trend (year + month columns become a period axis), a
    split by the most telling dimension, or - for a few rows of averages - a
    small table. Steps already drawn, the context of a change and empty or
    raw-row results are left to the Evidence tab."""
    from .analysis import table_payload
    titles = {s.get("id"): s.get("title") for s in (plan.get("steps") or []) + (plan.get("combine") or [])}
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
                work = df[keys + [measure]].copy()
                work[measure] = pd.to_numeric(work[measure], errors="coerce")
                work = work.groupby(keys, as_index=False)[measure].agg("sum" if _additive(measure) else "mean")
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
                out.append({"type": "chart", "title": title, "chart_type": "line", "tables": [tid], "time_column": "period",
                            **payload})
                continue
            nominal = [d for d in dims if d != focus_dim and 1 < df[d].nunique() <= 40]
            if not nominal and dims and len(df) <= 12:
                payload = details_payload(df, currency)
                out.append({"type": "chart", "title": title, "chart_type": "table", "display": "table", "tables": [tid], **payload})
                continue
            if not nominal or not measure:
                continue
            words = set(re.findall(r"[a-z]+", (title or "").lower()))
            named = lambda d: bool(set(str(d).lower().split("_")) & words)  # noqa: E731
            nominal.sort(key=lambda d: (not named(d), not (2 < df[d].nunique() <= 15), -min(df[d].nunique(), 12)))
            dim = nominal[0]
            series = next((d for d in dims if d not in (dim,) and 1 < df[d].nunique() <= 4), None)
            if not _additive(measure) and df.duplicated(subset=[dim] + ([series] if series else [])).any():
                series = None
                if df.duplicated(subset=[dim]).any():
                    continue  # averages cannot be re-added; leave it to the evidence tab
            shape = ("split", dim, series, measure)
            if shape in seen_shapes:
                continue
            seen_shapes.add(shape)
            payload, chart_type, note = chart_payload(df, dim, measure, series, currency)
            out.append({"type": "chart", "title": title, "chart_type": chart_type, "tables": [tid], **payload,
                        **({"note": note} if note else {})})
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
                  r"low[- ]performing|drop(ped)?|declin\w+)\b", re.I)
_HIGH = re.compile(r"\b(highest|best|top|most|largest|biggest|strongest|maximum|max|leading|peak|perform(s|ed)? (good|well|best))\b", re.I)


def question_rank(question: str) -> str:
    q = question or ""
    lo, hi = len(_LOW.findall(q)), len(_HIGH.findall(q))
    return "lowest" if lo > hi else "highest"
