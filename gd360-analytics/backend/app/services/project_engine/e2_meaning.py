"""
2026-10-13 (R45, workstream E2): what a column in a small step RESULT means, and how much of the data a
result covers - for the analysis facts, KPI tiles and the template sentences.

services/semantics answers "what is this column?" for whole files. A step result is tiny (one row for a
lookup, a handful for a top-N), so a few things are refined here:
  - a one-row "customers = 40" is a count of customers, not an identifier and not a plain number;
  - a helper column (rank, month_num, sort_key) is never a KPI;
  - the label never repeats the unit the value already carries ("Total wait min" + "843 min").
And result_scope() says whether a result is all of the data or only part of it: a query capped at the
row limit (5,000), or a top-N (LIMIT n) whose total is NOT the total of everything.
"""
from __future__ import annotations

import re

import pandas as pd

from .. import semantics as _sem

ROW_CAP = 5000  # mirrors sqlcheck.ROW_CAP (executor cuts a result to exactly this many rows)
FILE_ROW_CAP = 300_000  # mirrors executor.FILE_ROW_CAP (a file larger than this is read in part)

_HELPER = re.compile(r"(^|[_\s])(num|idx|index|sort|sort_key|sort_order|rank|ranking|position|pos|seq|row_number|rn)$", re.I)
_COUNT_NAME = re.compile(r"^(n|num|number|count|cnt|total|no)?[_\s]*(of[_\s]+)?(distinct[_\s]+|unique[_\s]+)?"
                         r"(customers?|users?|clients?|patients?|employees?|members?|orders?|tickets?|visitors?|"
                         r"students?|cases?|accounts?|leads?|rows?|records?|items?|transactions?|deals?|calls?|"
                         r"stores?|products?|sessions?|visits?|bookings?|units?|days?|months?|events?|people|"
                         r"respondents?|responses?|shipments?|purchases?|signups?|installs?|nights?)"
                         r"([_\s]+(count|cnt|served|total|n))?$", re.I)
_UNIT_WORDS = {
    "min": ("min", "mins", "minute", "minutes"), "h": ("h", "hr", "hrs", "hour", "hours"),
    "s": ("s", "sec", "secs", "second", "seconds"), "ms": ("ms", "millis", "milliseconds"),
    "days": ("days", "day"), "weeks": ("weeks",), "months": ("months",),
}
_CURRENCY_WORDS = ("usd", "eur", "gbp", "inr", "jpy", "aud", "cad", "sgd", "dollars", "rupees", "euros", "amt")


def col_meaning(name, series: pd.Series, currency: str | None = None) -> dict:
    """semantics.infer_column, refined for a small result. Adds role "helper" for sort keys."""
    m = dict(_sem.infer_column(name, series))
    text = str(name)
    if _HELPER.search(text) and m.get("role") not in ("money", "duration", "percent"):
        m["role"] = "helper"
        return m
    num = pd.to_numeric(series, errors="coerce").dropna()
    integer = len(num) > 0 and bool((num % 1 == 0).all())
    if integer and _COUNT_NAME.match(_sem._norm(text).replace(" ", "_")) and m.get("role") in (
            "id", "sequence", "measure", "category", "count", "rate"):
        m.update(role="count", additive=True, agg="sum")
    if m.get("role") == "money" and not m.get("currency") and currency:
        m["currency"] = currency
        m["unit"] = currency
    return m


def label_for(name, meaning: dict | None = None) -> str:
    """The human label for a column, without the unit the formatted value already shows:
    total_wait_min -> "Total wait" (shown "843 min"); revenue_usd -> "Revenue"; avg_wait -> "Avg wait"."""
    label = _sem.human_name(name)
    meaning = meaning or {}
    words = label.split(" ")
    unit = meaning.get("unit")
    drop: tuple = ()
    if meaning.get("role") == "duration" and unit in _UNIT_WORDS:
        drop = _UNIT_WORDS[unit]
    elif meaning.get("role") == "money":
        drop = _CURRENCY_WORDS
    elif meaning.get("role") == "percent":
        drop = ("pct", "percent", "percentage", "%")
    while len(words) > 1 and words[-1].lower() in drop:
        words = words[:-1]
    out = " ".join(words)
    return out[:1].upper() + out[1:]


def fact_format(meaning: dict, default_kind: str = "number") -> tuple[str, dict]:
    """(fact kind, meaning to display with): currency / ratio / percent / integer / number (durations stay
    "number" for the frontend and carry their unit in the display text)."""
    role = meaning.get("role")
    if role == "money":
        return "currency", meaning
    if role == "percent":
        return ("ratio" if meaning.get("scale") == "fraction" else "percent"), meaning
    if role == "count":
        return "integer", meaning
    if role == "duration":
        return "number", meaning
    return default_kind, meaning


def display(value, kind: str, meaning: dict, currency: str | None) -> str | None:
    """A duration with its unit ("843 min", "21.1 min"); None = let numbers.fmt write it."""
    if meaning.get("role") == "duration":
        return _sem.format_value(value, {"role": "duration", "unit": meaning.get("unit")})
    return None


# ---- how much of the data a result covers -------------------------------------------------------

_LIMIT = re.compile(r"\blimit\s+(\d+)\s*(?:offset\s+\d+\s*)?;?\s*$", re.I)
_TOP = re.compile(r"^\s*select\s+(?:distinct\s+)?top\s*\(?\s*(\d+)", re.I)
_FETCH = re.compile(r"\bfetch\s+(?:first|next)\s+(\d+)\s+rows?\s+only\s*;?\s*$", re.I)
_FULL_TOTAL = re.compile(r"(^|_)(grand_total|overall_total|total_all|all_total|full_total|total_of_all|total)(_|$)", re.I)


def sql_limit(sql: str | None) -> int | None:
    s = (sql or "").strip()
    for rx in (_LIMIT, _FETCH, _TOP):
        m = rx.search(s)
        if m:
            return int(m.group(1))
    return None


def result_scope(df: pd.DataFrame, table: str | None, spec: dict, dim: str | None = None,
                 val: str | None = None) -> dict:
    """{"capped": the row cap cut it, "limit": n when the query kept only its top n rows (and got n),
    "rows": rows returned, "full_total": the grand total the result itself carries, if any}."""
    rows = int(len(df)) if df is not None else 0
    attrs = getattr(df, "attrs", {}) or {}
    sql = ((spec or {}).get("_sql_by_table") or {}).get(table) or ""
    lim = sql_limit(sql)
    capped = bool(attrs.get("truncated")) or rows == ROW_CAP or rows == FILE_ROW_CAP
    if attrs.get("rows_total") and int(attrs["rows_total"]) > rows:
        capped = True
    limit = lim if lim is not None and rows >= lim and lim < ROW_CAP else None
    full = attrs.get("full_total")
    if full is None and df is not None and rows and val is not None:
        shown = pd.to_numeric(df[val], errors="coerce").sum()
        for c in df.columns:
            if c in (dim, val) or not _FULL_TOTAL.search(str(c)):
                continue
            col = pd.to_numeric(df[c], errors="coerce").dropna()
            if len(col) == rows and col.nunique() == 1 and float(col.iloc[0]) >= float(shown) * (1 - 1e-9) > 0:
                full = float(col.iloc[0])
                break
    return {"capped": capped, "limit": limit, "rows": rows, "full_total": full}


def scope_caveat(scope: dict, what: str = "") -> str | None:
    if scope.get("capped"):
        return (f"Only the first {scope['rows']:,} rows of this result came back (the row limit), so totals and "
                f"shares{(' of ' + what) if what else ''} cover those rows, not all of the data.")
    if scope.get("limit") and not scope.get("full_total"):
        return (f"Only the top {scope['limit']:,} rows are shown, so the total and the shares are of those "
                f"{scope['limit']:,}, not of everything.")
    return None
