"""
GD360 data meaning (2026-10-13, R45).

One place that answers "what IS this column?" for every engine: Quick answers,
the Analyst, dashboards, KPI cards and charts. Before R45 each surface guessed
from names on its own, which is how an ID became a chart axis, minutes became
"$21.08", averages were added up and a minutes column was used as a date.

The module is pure (pandas in, plain dicts out), cheap (vectorised, samples
large frames) and conservative: when it is not sure, it says "measure" or
"category" rather than inventing a unit.

Public API
- infer_column(name, series)  -> meaning dict (role, unit, currency, additive, label, ...)
- infer_frame(df)             -> {column: meaning}
- dataset_kind(df, meanings)  -> "queue" | "ledger" | "funnel" | "timeseries" | "inventory" | "people" | "survey" | "generic"
- kpi_pack(df, meanings)      -> the KPIs that matter for this kind of data, computed exactly
- human_name(name)            -> "Waiting time" for "waiting_time" / "Waiting Time (min)"
- round_half_up(v, d)         -> 21.075 -> 21.08 everywhere (the one rounding rule)
- format_value(v, meaning)    -> "21.1 min", "$963", "92.5%", "1.2M"
- catalog_line(name, meaning) -> one compact line an AI planner can read
"""
from __future__ import annotations

import math
import re
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

import numpy as np
import pandas as pd

ROLES = ("id", "sequence", "year", "date", "clock", "duration", "money", "percent", "rate", "count",
         "measure", "category", "boolean", "text", "geo")

# ---- names -------------------------------------------------------------------------------------------------

_SPLIT = re.compile(r"[\s_\-./]+")


def _norm(name: Any) -> str:
    s = re.sub(r"([a-z])([A-Z])", r"\1 \2", str(name))
    return " ".join(w for w in _SPLIT.split(s.lower()) if w)


_UNIT_IN_NAME = re.compile(r"\(([^)]{1,16})\)\s*$")
_ACRONYMS = {"id", "kpi", "roi", "roas", "ctr", "cpc", "cpm", "cpa", "aov", "arpu", "ltv", "cac", "nps", "sku", "url",
             "utm", "gmv", "mrr", "arr", "ebitda", "usd", "eur", "gbp", "inr", "iat", "eta", "sla", "qa", "hr", "ga4", "seo"}


def human_name(name: Any) -> str:
    """'waiting_time' -> 'Waiting time'; 'Wait Cost ($)' -> 'Wait cost'; 'customer_id' -> 'Customer ID'."""
    raw = str(name).strip()
    raw = _UNIT_IN_NAME.sub("", raw).strip() or raw
    words = _norm(raw).split()
    if not words:
        return raw
    out = [w.upper() if w in _ACRONYMS else w for w in words]
    first = out[0]
    out[0] = first if first.isupper() and len(first) > 1 else first[:1].upper() + first[1:]
    return " ".join(out)


# ---- vocabularies (word-level, so "rate" never matches "separated") ------------------------------------------

_W = lambda *ws: re.compile(r"\b(" + "|".join(ws) + r")\b")  # noqa: E731

_ID_W = _W("id", "ids", "uuid", "guid", "key", "code", "sku", "ref", "reference", "number", "no", "num", "zip", "zipcode",
           "postcode", "postal", "phone", "mobile", "ean", "upc", "isbn", "account number", "invoice", "order number")
_ID_PLURAL_ENTITY = _W("customers", "customer", "users", "user", "clients", "client", "patients", "patient", "employees",
                       "employee", "members", "member", "orders", "order", "tickets", "ticket", "visitors", "visitor",
                       "students", "student", "cases", "case", "accounts", "account", "leads", "lead", "rows", "row",
                       "records", "record", "items", "item", "transactions", "transaction", "deals", "deal", "calls", "call")
_SEQ_W = _W("seq", "sequence", "index", "idx", "rank", "position", "pos", "step", "row number", "serial", "s no", "sl no", "sr no", "#")
_YEAR_W = _W("year", "yr", "fy", "fiscal year")
_DATE_W = _W("date", "day", "dt", "timestamp", "datetime", "created", "updated", "at", "on", "time stamp", "period", "month",
             "week", "quarter", "dob", "birth", "joined", "signup", "since", "until", "from", "to")
_CLOCK_W = _W("clock", "clock time", "arrival time", "arrivals clock time", "start", "end", "finish", "begin", "start time",
              "end time", "time of day", "hour of day", "tod")
_DUR_UNITS = [
    ("min", _W("min", "mins", "minute", "minutes", "wait", "waiting", "waiting time", "service time", "duration", "handle time",
               "handling time", "aht", "lead time", "cycle time", "turnaround", "tat", "delay", "iat", "inter arrival",
               "interarrival", "time spent", "dwell", "latency min")),
    ("h", _W("hr", "hrs", "hour", "hours", "shift hours", "hours worked", "billable hours")),
    ("s", _W("sec", "secs", "second", "seconds", "session duration", "avg session duration", "engagement time")),
    ("ms", _W("ms", "millis", "milliseconds", "latency", "response time")),
    ("days", _W("days", "day count", "nights", "length of stay", "los", "tenure days", "age days", "days to", "lead days")),
    ("weeks", _W("weeks",)),
    ("months", _W("months", "tenure months", "tenure")),
]
_MONEY_W = _W("revenue", "sales", "amount", "price", "cost", "costs", "spend", "spent", "budget", "profit", "margin amount",
              "income", "expense", "expenses", "salary", "wage", "wages", "pay", "payment", "payments", "fee", "fees",
              "charge", "charges", "value", "gmv", "mrr", "arr", "ltv", "cac", "cpc", "cpm", "cpa", "aov", "arpu", "ebitda",
              "tax", "discount amount", "refund", "refunds", "balance", "loan", "emi", "premium", "invoice amount",
              "total amount", "net", "gross", "deal value", "pipeline", "bookings", "cash", "debt", "capex", "opex", "rent",
              "usd", "eur", "gbp", "inr", "dollars", "rupees", "euros")
_NOT_MONEY_W = _W("count", "qty", "quantity", "units", "number of", "visits", "sessions", "rate", "pct", "percent", "share",
                  "ratio", "score", "rating", "time", "minutes", "hours", "days", "age", "year")
_PERCENT_W = _W("pct", "percent", "percentage", "share", "rate", "ratio", "conversion", "conversion rate", "ctr", "churn",
                "churn rate", "retention", "margin", "margin pct", "growth", "utilisation", "utilization", "occupancy",
                "bounce rate", "engagement rate", "win rate", "yield", "%")
_NOT_PERCENT_W = _W("daily rate", "room rate", "adr", "exchange rate", "hourly rate", "day rate", "rate amount", "heart rate",
                    "interest amount", "rate card", "pay rate", "tax rate amount")
_COUNT_W = _W("count", "counts", "qty", "quantity", "units", "number of", "visits", "sessions", "users", "clicks",
              "impressions", "views", "pageviews", "orders count", "conversions", "signups", "installs", "leads count",
              "headcount", "stock", "inventory", "on hand", "reorders", "attendees", "registrations", "tickets sold",
              "calls", "emails", "opens", "bookings count")
_AVG_W = _W("avg", "average", "mean", "median", "per", "rate", "pct", "percent", "share", "ratio", "score", "rating",
            "index", "nps", "csat", "aov", "arpu", "price", "unit price", "margin", "utilisation", "utilization", "age",
            "temperature", "latitude", "longitude", "lat", "lng", "lon", "balance", "level", "probability", "likelihood")
_GEO_W = _W("country", "city", "state", "region", "province", "territory", "zip", "postcode", "lat", "latitude", "lng",
            "lon", "longitude", "geo", "location", "address", "store location", "market")
_BOOL_VALUES = {"true", "false", "yes", "no", "y", "n", "0", "1", "t", "f"}
_CURRENCY_SYMBOLS = {"$": "USD", "€": "EUR", "£": "GBP", "₹": "INR", "¥": "JPY", "₩": "KRW", "₺": "TRY", "R$": "BRL"}
_CURRENCY_CODES = {"usd": "USD", "eur": "EUR", "gbp": "GBP", "inr": "INR", "jpy": "JPY", "aud": "AUD", "cad": "CAD",
                   "sgd": "SGD", "aed": "AED", "chf": "CHF", "cny": "CNY", "rupees": "INR", "dollars": "USD", "euros": "EUR"}
SYMBOL = {"USD": "$", "EUR": "€", "GBP": "£", "INR": "₹", "JPY": "¥", "KRW": "₩", "TRY": "₺", "BRL": "R$", "AUD": "A$",
          "CAD": "C$", "SGD": "S$", "AED": "AED ", "CHF": "CHF ", "CNY": "¥"}


def _has(rx: re.Pattern, text: str) -> bool:
    return bool(rx.search(text))


def _unit_from_name(raw: str) -> str | None:
    m = _UNIT_IN_NAME.search(raw.strip())
    if not m:
        return None
    u = m.group(1).strip().lower()
    for sym, code in _CURRENCY_SYMBOLS.items():
        if u == sym.lower():
            return code
    if u in _CURRENCY_CODES:
        return _CURRENCY_CODES[u]
    if u in ("%", "pct", "percent"):
        return "%"
    for unit, rx in _DUR_UNITS:
        if rx.fullmatch(u) or u == unit:
            return unit
    if u in ("$/min", "$/h", "$/hr"):
        return "USD"
    return None


# ---- value helpers ----------------------------------------------------------------------------------------

def _sample(s: pd.Series, n: int = 5000) -> pd.Series:
    s = s.dropna()
    return s.sample(n, random_state=7) if len(s) > n else s


def _numeric(s: pd.Series) -> pd.Series | None:
    if pd.api.types.is_bool_dtype(s):
        return None
    if pd.api.types.is_numeric_dtype(s):
        return pd.to_numeric(s, errors="coerce")
    if s.dtype == object:
        cleaned = s.dropna().astype(str).str.strip().str.replace(r"[,$€£₹¥%\s]", "", regex=True)
        if len(cleaned) == 0:
            return None
        num = pd.to_numeric(cleaned, errors="coerce")
        if num.notna().mean() >= 0.95:
            return pd.to_numeric(s.astype(str).str.replace(r"[,$€£₹¥%\s]", "", regex=True), errors="coerce")
    return None


_DATE_TEXT = re.compile(r"^\s*(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{2,4}|"
                        r"[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{2,4}|\d{4}-\d{2}(-\d{2})?[T ]\d{2}:\d{2})")


def _looks_like_dates(s: pd.Series) -> bool:
    if pd.api.types.is_datetime64_any_dtype(s):
        return True
    if s.dtype != object:
        return False
    v = _sample(s, 400).astype(str)
    if len(v) == 0:
        return False
    return v.str.match(_DATE_TEXT).mean() >= 0.9


def _is_integer_like(num: pd.Series) -> bool:
    v = num.dropna()
    return len(v) > 0 and bool(np.all(np.isclose(v.values, np.round(v.values))))


def _strictly_sequential(num: pd.Series) -> bool:
    """1,2,3,...,n (or a constant step) in the file's own order."""
    v = num.dropna().values
    if len(v) < 5:
        return False
    d = np.diff(v)
    return bool(np.all(d == d[0]) and d[0] != 0)


# ---- the classifier ---------------------------------------------------------------------------------------

def infer_column(name: Any, series: pd.Series) -> dict:
    """What a column is, with the evidence. Never raises."""
    try:
        return _infer(str(name), series)
    except Exception:  # noqa: BLE001 - meaning is advisory; never break a caller
        return {"name": str(name), "role": "category", "label": human_name(name), "unit": None, "currency": None,
                "additive": False, "distinct": None, "rows": int(len(series)), "nulls": None}


def _infer(name: str, s: pd.Series) -> dict:
    text = _norm(name)
    rows = int(len(s))
    non_null = s.dropna()
    nn = int(len(non_null))
    distinct = int(non_null.nunique()) if nn else 0
    uniq_ratio = distinct / nn if nn else 0.0
    base = {"name": name, "label": human_name(name), "rows": rows, "nulls": rows - nn, "distinct": distinct,
            "unit": None, "currency": None, "additive": False, "role": "category", "agg": "count"}
    name_unit = _unit_from_name(name)

    if nn == 0:
        return {**base, "role": "text"}

    # booleans
    if pd.api.types.is_bool_dtype(s) or (distinct <= 2 and set(non_null.astype(str).str.lower().unique()) <= _BOOL_VALUES
                                          and not pd.api.types.is_float_dtype(s)):
        return {**base, "role": "boolean", "agg": "share"}

    # dates
    if _looks_like_dates(s) or (s.dtype == object and _has(_DATE_W, text) and not _has(_CLOCK_W, text)
                                and pd.to_datetime(_sample(s, 200), errors="coerce", format="mixed").notna().mean() > 0.9):
        out = {**base, "role": "date", "agg": "min_max"}
        try:
            d = pd.to_datetime(_sample(s, 20000), errors="coerce", format="mixed")
            if d.notna().any():
                out["min"], out["max"] = str(d.min().date()), str(d.max().date())
        except Exception:  # noqa: BLE001
            pass
        return out

    num = _numeric(s)
    if num is None:
        # text: category / geo / id-like text / free text
        avg_len = float(_sample(non_null, 500).astype(str).str.len().mean())
        if _has(_GEO_W, text):
            return {**base, "role": "geo", "agg": "count", "samples": _samples(non_null)}
        if uniq_ratio > 0.95 and nn > 20 and (_has(_ID_W, text) or avg_len <= 40):
            return {**base, "role": "id", "agg": "count_distinct"}
        if avg_len > 60 and uniq_ratio > 0.5:
            return {**base, "role": "text", "agg": "none"}
        return {**base, "role": "category", "agg": "count", "samples": _samples(non_null)}

    v = num.dropna()
    lo, hi = float(v.min()), float(v.max())
    integer = _is_integer_like(v)
    out = {**base, "min": lo, "max": hi}

    # identifiers and sequences (never added up, never a KPI)
    if _has(_SEQ_W, text) or (integer and _strictly_sequential(num) and _has(_ID_PLURAL_ENTITY, text)):
        return {**out, "role": "sequence", "agg": "count"}
    if integer and (_has(_ID_W, text) and not _has(_COUNT_W, text) and not _has(_MONEY_W, text)):
        return {**out, "role": "id", "agg": "count_distinct"}
    if integer and _has(_ID_PLURAL_ENTITY, text) and uniq_ratio >= 0.98 and nn >= 10 and not _has(_COUNT_W, text):
        return {**out, "role": "sequence" if _strictly_sequential(num) else "id", "agg": "count_distinct"}

    # years
    if integer and _has(_YEAR_W, text) and 1800 <= lo and hi <= 2200:
        return {**out, "role": "year", "agg": "none"}
    if integer and not text and 1900 <= lo and hi <= 2100 and distinct <= 60:
        return {**out, "role": "year", "agg": "none"}

    # clock times ("Arrivals Clock Time", "Start", "End") - positions on a timeline, not amounts
    if _has(_CLOCK_W, text) and not _has(_W("duration", "wait", "waiting", "service time", "length"), text):
        return {**out, "role": "clock", "unit": name_unit if name_unit in ("min", "h", "s") else "min" if hi <= 24 * 60 else None,
                "agg": "range"}

    # percentages / rates
    if (name_unit == "%" or (_has(_PERCENT_W, text) and not _has(_NOT_PERCENT_W, text))) and not _has(_MONEY_W, text.replace("margin", "")):
        scale = "fraction" if hi <= 1.0 and lo >= -1.0 else "points"
        return {**out, "role": "percent", "unit": "%", "scale": scale, "agg": "avg"}

    # money
    currency = name_unit if name_unit and name_unit.isupper() and len(name_unit) == 3 else None
    if currency or (_has(_MONEY_W, text) and not _has(_NOT_MONEY_W, text)) or _currency_values(s):
        cur = currency or _currency_values(s) or _currency_word(text)
        avg_like = _has(_AVG_W, text)
        return {**out, "role": "money", "currency": cur, "unit": cur, "additive": not avg_like,
                "agg": "avg" if avg_like else "sum"}

    # durations
    unit = name_unit if name_unit in {u for u, _ in _DUR_UNITS} else next((u for u, rx in _DUR_UNITS if _has(rx, text)), None)
    if unit:
        return {**out, "role": "duration", "unit": unit, "additive": True, "agg": "avg"}

    # counts
    if _has(_COUNT_W, text) and integer and lo >= 0:
        return {**out, "role": "count", "additive": not _has(_AVG_W, text), "agg": "sum"}

    # random-number columns of a simulation ("Rand #") are inputs, not measures
    if _has(_W("rand", "random", "rn", "rand #", "random number"), text):
        return {**out, "role": "sequence", "agg": "none"}

    # low-cardinality integers are categories (Server 1/2/3, Rating 1-5 stays a measure if named so)
    if integer and distinct <= 12 and nn >= 30 and not _has(_AVG_W, text):
        return {**out, "role": "category", "agg": "count", "samples": _samples(non_null)}

    avg_like = _has(_AVG_W, text)
    return {**out, "role": "rate" if avg_like and not integer else "measure", "additive": not avg_like,
            "agg": "avg" if avg_like else "sum"}


def _samples(s: pd.Series, k: int = 8) -> list[str]:
    try:
        vc = s.astype(str).value_counts().head(k)
        return [str(x)[:40] for x in vc.index]
    except Exception:  # noqa: BLE001
        return []


def _currency_values(s: pd.Series) -> str | None:
    if s.dtype != object:
        return None
    v = _sample(s, 300).astype(str).str.strip()
    for sym, code in sorted(_CURRENCY_SYMBOLS.items(), key=lambda kv: -len(kv[0])):
        if len(v) and v.str.startswith(sym).mean() > 0.8:
            return code
    return None


def _currency_word(text: str) -> str | None:
    for w, code in _CURRENCY_CODES.items():
        if re.search(rf"\b{w}\b", text):
            return code
    return None


def infer_frame(df: pd.DataFrame, max_columns: int = 300) -> dict[str, dict]:
    return {str(c): infer_column(c, df[c]) for c in list(df.columns)[:max_columns]}


# ---- what kind of dataset ---------------------------------------------------------------------------------

def _find(meanings: dict, *words: str, roles: tuple[str, ...] | None = None) -> str | None:
    rx = _W(*words)
    for c, m in meanings.items():
        if (roles is None or m["role"] in roles) and rx.search(_norm(c)):
            return c
    return None


def queue_columns(meanings: dict) -> dict | None:
    """A queue / service log: arrivals, service time and waiting time (start/end optional)."""
    wait = _find(meanings, "wait", "waiting", "waiting time", "queue time", "delay", roles=("duration", "measure", "rate"))
    service = _find(meanings, "service", "service time", "handle time", "handling time", "processing time", "aht",
                    roles=("duration", "measure", "rate"))
    arrival = _find(meanings, "arrival", "arrivals clock time", "arrival time", "clock", "arrivals", roles=("clock", "duration", "measure", "date"))
    gap = _find(meanings, "iat", "inter arrival", "interarrival", "gap", roles=("duration", "measure", "rate"))
    if wait and service and (arrival or gap):
        return {"wait": wait, "service": service, "arrival": arrival, "gap": gap,
                "start": _find(meanings, "start", "begin", roles=("clock", "duration", "measure")),
                "end": _find(meanings, "end", "finish", "completion", roles=("clock", "duration", "measure")),
                "id": next((c for c, m in meanings.items() if m["role"] in ("id", "sequence")), None)}
    return None


def dataset_kind(df: pd.DataFrame, meanings: dict | None = None) -> str:
    m = meanings or infer_frame(df)
    roles = [x["role"] for x in m.values()]
    names = " ".join(_norm(c) for c in m)
    if queue_columns(m):
        return "queue"
    if re.search(r"\b(stage|funnel|step)\b", names) and re.search(r"\b(lead|deal|opportunit|conversion|signup|visit)", names):
        return "funnel"
    if re.search(r"\b(stock|inventory|on hand|reorder|sku)\b", names):
        return "inventory"
    if re.search(r"\b(employee|salary|department|hire|tenure|attrition)\b", names):
        return "people"
    if re.search(r"\b(rating|score|nps|csat|satisfaction|response|answer)\b", names) and roles.count("category") >= 2:
        return "survey"
    if "money" in roles and ("date" in roles or "category" in roles):
        return "ledger"
    if "date" in roles and any(r in roles for r in ("measure", "count", "money", "percent", "rate", "duration")):
        return "timeseries"
    return "generic"


# ---- KPI packs: the metrics that matter, computed exactly -----------------------------------------------

def _kpi(key: str, label: str, value: float | None, fmt: str, unit: str | None = None, note: str | None = None,
         currency: str | None = None, tone: str | None = None) -> dict | None:
    if value is None or (isinstance(value, float) and not math.isfinite(value)):
        return None
    return {"key": key, "label": label, "value": float(value), "format": fmt, "unit": unit, "note": note,
            "currency": currency, "tone": tone}


def kpi_pack(df: pd.DataFrame, meanings: dict | None = None, limit: int = 8) -> dict:
    """The KPIs a senior analyst would put first for this kind of data. Every value is computed here,
    from the frame, so titles and numbers can never disagree."""
    m = meanings or infer_frame(df)
    kind = dataset_kind(df, m)
    out: list[dict | None] = []
    n = len(df)
    q = queue_columns(m) if kind == "queue" else None
    if q:
        w = pd.to_numeric(df[q["wait"]], errors="coerce")
        sv = pd.to_numeric(df[q["service"]], errors="coerce")
        wu = m[q["wait"]].get("unit") or "min"
        waited = int((w > 0).sum())
        if q["gap"]:
            gap = pd.to_numeric(df[q["gap"]], errors="coerce").mean()
        elif q["arrival"] and m[q["arrival"]]["role"] != "date":
            arr = pd.to_numeric(df[q["arrival"]], errors="coerce").dropna()
            gap = (arr.max() - arr.min()) / max(1, len(arr) - 1)
        else:
            gap = None
        util = (sv.mean() / gap) if gap and gap > 0 else None
        out += [
            _kpi("customers", "Customers served", n, "integer"),
            _kpi("total_wait", "Total waiting time", w.sum(), "duration", wu),
            _kpi("avg_wait", "Average wait", w.mean(), "duration", wu, note=f"max {fmt_number(w.max())} {wu}"),
            _kpi("share_waited", "Customers who waited", waited / n * 100 if n else None, "percent", "%",
                 note=f"{waited} of {n}"),
            _kpi("avg_service", "Average service time", sv.mean(), "duration", m[q["service"]].get("unit") or wu),
            _kpi("avg_gap", "Average time between arrivals", gap, "duration", wu) if gap else None,
            _kpi("utilisation", "Server busy (utilisation)", util * 100 if util is not None else None, "percent", "%",
                 note="over 100% means the queue keeps growing" if util and util > 1 else None,
                 tone="bad" if util and util > 1 else "good" if util is not None and util < 0.85 else None),
        ]
    else:
        out.append(_kpi("rows", "Records", n, "integer"))
        for c, meta in m.items():
            if len([x for x in out if x]) >= limit:
                break
            role = meta["role"]
            col = pd.to_numeric(df[c], errors="coerce") if role in ("money", "measure", "count", "duration", "percent", "rate") else None
            if col is None or col.notna().sum() == 0:
                continue
            label = meta["label"]
            if role == "money":
                out.append(_kpi(f"{c}:sum" if meta["additive"] else f"{c}:avg",
                                f"Total {label.lower()}" if meta["additive"] else f"Average {label.lower()}",
                                col.sum() if meta["additive"] else col.mean(), "currency", meta.get("currency"),
                                currency=meta.get("currency")))
            elif role == "count" and meta["additive"]:
                out.append(_kpi(f"{c}:sum", f"Total {label.lower()}", col.sum(), "integer"))
            elif role == "duration":
                out.append(_kpi(f"{c}:avg", f"Average {label.lower()}", col.mean(), "duration", meta.get("unit")))
            elif role == "percent":
                v = col.mean() * (100 if meta.get("scale") == "fraction" else 1)
                out.append(_kpi(f"{c}:avg", f"Average {label.lower()}", v, "percent", "%"))
            elif role in ("measure", "rate"):
                additive = meta["additive"]
                out.append(_kpi(f"{c}:{'sum' if additive else 'avg'}", f"{'Total' if additive else 'Average'} {label.lower()}",
                                col.sum() if additive else col.mean(), "number"))
        dates = [c for c, x in m.items() if x["role"] == "date" and x.get("min")]
        if dates:
            d = m[dates[0]]
            out.append({"key": "span", "label": "Period covered", "value": None, "format": "text",
                        "text": f"{d['min']} to {d['max']}", "unit": None, "note": None, "currency": None, "tone": None})
    return {"kind": kind, "kpis": [k for k in out if k][:limit], "queue": q}


# ---- numbers: one rounding rule, one formatter ----------------------------------------------------------

def round_half_up(v: float, digits: int = 0) -> float:
    """21.075 -> 21.08 (not 21.07 as binary floats + banker's rounding give). The ONE rule for every surface."""
    if v is None or not math.isfinite(float(v)):
        return v
    q = Decimal(1).scaleb(-digits)
    return float(Decimal(repr(float(v))).quantize(q, rounding=ROUND_HALF_UP))


def _decimals_for(v: float, fmt: str) -> int:
    a = abs(v)
    if fmt in ("integer",):
        return 0
    if fmt == "percent":
        return 1 if a < 100 else 0
    if fmt == "currency":
        return 0 if a >= 1000 or float(a).is_integer() else 2
    if a >= 100:
        return 0
    if a >= 10:
        return 1
    if a >= 1:
        return 2
    return 3 if a else 0


def fmt_number(v: float, decimals: int | None = None) -> str:
    if v is None or not math.isfinite(float(v)):
        return "–"
    d = _decimals_for(float(v), "number") if decimals is None else decimals
    r = round_half_up(float(v), d)
    s = f"{r:,.{d}f}"
    if "." in s and decimals is None:
        s = s.rstrip("0").rstrip(".")
    return s


def compact(v: float, prefix: str = "") -> str:
    """1,234,567 -> 1.2M; 999,960 -> 1M (never '1000.0k')."""
    a, sign = abs(v), "-" if v < 0 else ""
    for div, suf in ((1e12, "T"), (1e9, "B"), (1e6, "M"), (1e3, "K")):
        if a >= div * 0.9995:
            x = round_half_up(a / div, 1)
            if x >= 1000 and suf != "T":
                continue
            return f"{sign}{prefix}{fmt_number(x, 1).rstrip('0').rstrip('.')}{suf}"
    return f"{sign}{prefix}{fmt_number(a)}"


_UNIT_TEXT = {"min": "min", "h": "h", "s": "s", "ms": "ms", "days": "days", "weeks": "weeks", "months": "months"}


def format_value(v: Any, meaning: dict | None = None, fmt: str | None = None, short: bool = False) -> str:
    """Format a number the way the meaning says: '$963', '21.1 min', '92.5%', '1.2M customers' -> never raw floats."""
    if v is None:
        return "–"
    try:
        x = float(v)
    except (TypeError, ValueError):
        return str(v)
    if not math.isfinite(x):
        return "–"
    meaning = meaning or {}
    role = meaning.get("role")
    kind = fmt or {"money": "currency", "percent": "percent", "duration": "duration", "count": "integer",
                   "id": "integer", "sequence": "integer", "year": "year"}.get(role or "", "number")
    if kind == "year":
        return str(int(round(x)))
    if kind == "currency":
        sym = SYMBOL.get(meaning.get("currency") or "USD", "$")
        if short and abs(x) >= 10000:
            return compact(x, sym)
        d = _decimals_for(x, "currency")
        body = f"{round_half_up(abs(x), d):,.{d}f}"
        return f"{'-' if x < 0 else ''}{sym}{body}"
    if kind == "percent":
        pts = x * 100 if meaning.get("scale") == "fraction" else x
        return f"{fmt_number(pts, _decimals_for(pts, 'percent'))}%"
    if kind == "duration":
        unit = _UNIT_TEXT.get(meaning.get("unit") or "", meaning.get("unit") or "")
        body = compact(x) if short and abs(x) >= 10000 else fmt_number(x, 1 if abs(x) < 100 and not float(x).is_integer() else 0)
        return f"{body} {unit}".strip()
    if kind == "integer":
        return compact(x) if short and abs(x) >= 10000 else f"{int(round_half_up(x, 0)):,}"
    return compact(x) if short and abs(x) >= 10000 else fmt_number(x)


def catalog_line(name: str, meaning: dict) -> str:
    """'Waiting Time' (duration, min, avg of 40 rows, 0-51; never sum as a KPI title without 'total')."""
    role = meaning.get("role")
    bits = [role or "?"]
    if meaning.get("unit"):
        bits.append(str(meaning["unit"]))
    if role in ("id", "sequence"):
        bits.append("identifier - count distinct, never sum/avg, never a chart measure")
    elif role == "year":
        bits.append("year - group by it, never sum it")
    elif role == "clock":
        bits.append("clock time - a position on a timeline, not an amount")
    elif role in ("money", "measure", "count", "duration") and not meaning.get("additive", True):
        bits.append("non-additive - use AVG, never SUM")
    elif meaning.get("additive"):
        bits.append("additive")
    if meaning.get("min") is not None and meaning.get("max") is not None and role not in ("category", "geo", "text"):
        f = lambda x: fmt_number(float(x)) if isinstance(x, (int, float)) else str(x)  # noqa: E731
        bits.append(f"range {f(meaning['min'])}..{f(meaning['max'])}")
    if meaning.get("samples"):
        bits.append("values: " + ", ".join(meaning["samples"][:6]))
    if meaning.get("distinct") is not None:
        bits.append(f"{meaning['distinct']} distinct")
    return f'"{name}" ({"; ".join(bits)})'


def is_measure(meaning: dict) -> bool:
    return meaning.get("role") in ("money", "measure", "count", "duration", "percent", "rate")


def is_dimension(meaning: dict) -> bool:
    return meaning.get("role") in ("category", "geo", "boolean", "year", "date")
