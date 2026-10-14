"""
Dashboards that are TRUE, complete and useful (2026-10-13, R45 workstream E3).

Pure helpers (pandas / dicts in, dicts out - no database, no HTTP, no model
calls) used by routers/dashboard_builder.py and routers/projects.py, so every
rule here is testable on a plain DataFrame:

- meanings          what each block number IS ({role, unit, currency, scale,
                    label}) - from services/semantics.py, never from words in an
                    alias ("$" is never guessed from the word "cost").
- truth_guard       the title of a block must name what was computed. A title
                    that says "cost" over minutes, a KPI from an answer whose
                    number is not the answer's number, a SUM of an ID / year /
                    clock time: retitled honestly from the measure, or dropped
                    with the reason.
- signatures        exact + near-duplicate keys (filters, date parts, bins,
                    grain and block family included).
- seeds             the KPIs that matter for the kind of data (semantics.kpi_pack)
                    and, for a queue / service log, the charts that explain it.
- filters           low-cardinality columns of ANY type (Server 1/2/3, Year,
                    Store, a region) + a real date range.
- analyst blocks    an Analyst answer (result["analyst"]) as dashboard blocks
                    directly: decision KPIs, the live `scenario` block, the main
                    table, the chart, assumptions as scenario inputs.
- friendly errors   raw SQL / driver text never reaches the person.
"""
from __future__ import annotations

import json
import math
import re
from typing import Any

import numpy as np
import pandas as pd

from . import semantics as S

MEASURE_ROLES = ("money", "measure", "count", "duration", "percent", "rate")
DIMENSION_ROLES = ("category", "geo", "boolean", "year", "date")
# never SUM / AVG these (an identifier, a position in a list, a year, a time of day)
NOT_ADDABLE_ROLES = ("id", "sequence", "year", "clock")
AXIS_ROLES = ("sequence", "clock")  # ordered numeric x axes: all points, in order, never top-N

_CURRENCY_BY_SYMBOL = {"$": "USD", "€": "EUR", "£": "GBP", "₹": "INR", "¥": "JPY"}


# ---------------------------------------------------------------------------------------------- meanings

def compact(meaning: dict | None) -> dict:
    """The contract shape the frontend reads: {role, unit, currency, scale} (+ label)."""
    m = meaning or {}
    out = {"role": m.get("role"), "unit": m.get("unit"), "currency": m.get("currency"), "scale": m.get("scale")}
    if m.get("label"):
        out["label"] = m["label"]
    return out


def frame_meanings(df: pd.DataFrame | None, columns: list | None = None) -> dict[str, dict]:
    """{column: full semantics meaning} for the given columns of df (all when None). Never raises."""
    if df is None:
        return {}
    cols = [c for c in (columns if columns is not None else list(df.columns)) if c in df.columns]
    out: dict[str, dict] = {}
    for c in cols:
        out[str(c)] = S.infer_column(c, df[c])
    return out


_TYPE_FAMILY_DATE = re.compile(r"date|time", re.I)
_TYPE_FAMILY_BOOL = re.compile(r"bool|^bit$", re.I)
_TYPE_FAMILY_INT = re.compile(r"int", re.I)
_TYPE_FAMILY_FLOAT = re.compile(r"float|double|real|numeric|decimal|number|money", re.I)
_NAME_ID = re.compile(r"(^|[\s_\-])(id|ids|uuid|guid|key|code|sku|email|e mail|phone|url|hash)$", re.I)


def name_meaning(name: str, col_type: str | None = None, distinct: int | None = None) -> dict:
    """A column's meaning from its NAME and warehouse TYPE only (a warehouse source never loads rows
    into GD360). Conservative: ranges, distinct counts and a percent's scale are unknown here."""
    t = str(col_type or "").lower()
    label = S.human_name(name)
    norm = " ".join(re.split(r"[\s_\-./]+", re.sub(r"([a-z])([A-Z])", r"\1 \2", str(name)).lower())).strip()
    if _TYPE_FAMILY_BOOL.search(t):
        return {"role": "boolean", "unit": None, "currency": None, "scale": None, "label": label, "additive": False}
    if _TYPE_FAMILY_DATE.search(t) and "interval" not in t:
        return {"role": "date", "unit": None, "currency": None, "scale": None, "label": label, "additive": False}
    numeric_int = bool(_TYPE_FAMILY_INT.search(t)) and "interval" not in t and "point" not in t
    numeric_float = bool(_TYPE_FAMILY_FLOAT.search(t))
    if not (numeric_int or numeric_float):
        if _NAME_ID.search(norm):
            role = "id"
        elif re.search(r"\b(country|city|state|region|province|territory|zip|postcode|location|market)\b", norm):
            role = "geo"
        else:
            role = "category"
        return {"role": role, "unit": None, "currency": None, "scale": None, "label": label, "additive": False}
    # a synthetic, neutral series so the NAME decides (integer range that is year-like only when the name says year)
    if numeric_int:
        base = pd.Series(np.arange(2000, 2060, dtype="int64")) if re.search(r"\b(year|yr|fy)\b", norm) else \
            pd.Series(np.tile(np.array([3, 17, 5, 41, 8, 23, 12, 30, 9, 55, 2, 19], dtype="int64"), 5) * 7)
    else:
        base = pd.Series(np.tile(np.array([3.5, 17.25, 5.75, 41.5, 8.125, 23.5, 12.75, 30.5, 9.25, 55.5], dtype=float), 6))
    m = S.infer_column(name, base)
    out = {k: m.get(k) for k in ("role", "unit", "currency", "label", "additive", "agg")}
    out["scale"] = None  # unknown without the values
    if out["role"] == "category":  # "low cardinality" came from the synthetic values, not the data
        out["role"] = "measure"
        out["additive"] = True
    if numeric_int and out["role"] == "measure" and distinct is not None and 2 <= int(distinct) <= 12:
        out["role"], out["additive"] = "category", False  # Server 1/2/3, Store 1-4 (from the profile's distinct count)
    if distinct is not None:
        out["distinct"] = int(distinct)
    return out


def schema_meanings(columns: list[dict]) -> dict[str, dict]:
    """{name: name_meaning} for a schema table's [{name, type}] list."""
    return {str(c.get("name")): name_meaning(str(c.get("name")), c.get("type")) for c in columns or [] if c.get("name")}


def measure_meaning(agg: str | None, col_meaning: dict | None, column: str | None = None) -> dict:
    """What an aggregated number is: COUNT -> a count; AVG of a yes/no column -> a share (fraction);
    SUM/AVG/MIN/MAX of minutes -> minutes; of money -> money (same currency)."""
    agg = str(agg or "").lower()
    cm = col_meaning or {}
    if agg in ("count", "count_distinct") or (not column and agg in ("", "count")):
        what = cm.get("label") if column else "Rows"
        return {"role": "count", "unit": None, "currency": None, "scale": None,
                "label": ("Distinct " + str(what).lower()) if agg == "count_distinct" and column else
                ("Number of rows" if not column else f"Count of {str(what).lower()}")}
    if agg == "ratio":
        return {"role": "percent", "unit": "%", "currency": None, "scale": "fraction", "label": cm.get("label")}
    role = cm.get("role")
    if role == "boolean" and agg == "avg":
        return {"role": "percent", "unit": "%", "currency": None, "scale": "fraction",
                "label": f"Share {str(cm.get('label') or column or '').lower()}".strip()}
    word = {"sum": "Total", "avg": "Average", "min": "Minimum", "max": "Maximum"}.get(agg)
    label = cm.get("label") or (S.human_name(column) if column else None)
    return {"role": role or "measure", "unit": cm.get("unit"), "currency": cm.get("currency"), "scale": cm.get("scale"),
            "label": f"{word} {str(label).lower()}" if word and label else label}


def measures_of(block: dict) -> list[dict]:
    """[{alias, agg, column}] of a proposal block (its spec, else its recipe)."""
    spec = block.get("spec") if isinstance(block.get("spec"), dict) else None
    if spec and spec.get("measures"):
        return [{"alias": m.get("alias"), "agg": m.get("agg"), "column": m.get("column"), "expr": m.get("expr")}
                for m in spec["measures"] if isinstance(m, dict)]
    recipe = block.get("recipe") if isinstance(block.get("recipe"), dict) else {}
    if recipe.get("measures"):
        return [{"alias": m.get("alias"), "agg": m.get("agg"), "column": m.get("column")} for m in recipe["measures"] if isinstance(m, dict)]
    if recipe.get("agg") == "kpi_pack":
        return [{"alias": recipe.get("kpi_key"), "agg": "kpi_pack", "column": None}]
    if recipe.get("agg"):
        col = None if recipe.get("count_rows") else recipe.get("metric_column")
        return [{"alias": recipe.get("alias") or col, "agg": recipe.get("agg"), "column": col}]
    return []


def dims_of(block: dict) -> list[str]:
    spec = block.get("spec") if isinstance(block.get("spec"), dict) else None
    if spec:
        out = list(spec.get("group_by") or [])
        out += [p.get("column") for p in spec.get("date_parts") or [] if isinstance(p, dict)]
        return [d for d in out if d]
    recipe = block.get("recipe") if isinstance(block.get("recipe"), dict) else {}
    g = [x for x in (recipe.get("group_by") or []) if x] or ([recipe["group_by_column"]] if recipe.get("group_by_column") else [])
    if recipe.get("time_grain") and g:
        g = g[1:]
    return g


def time_of(block: dict) -> str | None:
    spec = block.get("spec") if isinstance(block.get("spec"), dict) else None
    if spec and isinstance(spec.get("time"), dict):
        return spec["time"].get("column")
    recipe = block.get("recipe") if isinstance(block.get("recipe"), dict) else {}
    if recipe.get("time_grain"):
        g = [x for x in (recipe.get("group_by") or []) if x] or ([recipe["group_by_column"]] if recipe.get("group_by_column") else [])
        return g[0] if g else None
    return None


def bins_of(block: dict) -> str | None:
    for src in (block.get("spec"), block.get("recipe")):
        if isinstance(src, dict) and isinstance(src.get("bins"), dict):
            return src["bins"].get("column")
    return None


def block_meanings(block: dict, col_meanings: dict[str, dict]) -> dict[str, dict]:
    """{result column or alias: compact meaning} for a proposal block - its measures and dimensions."""
    out: dict[str, dict] = {}
    for m in measures_of(block):
        if m.get("agg") == "kpi_pack":
            continue
        alias = m.get("alias") or m.get("column")
        if alias:
            out[str(alias)] = compact(measure_meaning(m.get("agg"), col_meanings.get(m.get("column") or ""), m.get("column")))
    for d in dims_of(block) + ([time_of(block)] if time_of(block) else []) + ([bins_of(block)] if bins_of(block) else []):
        if d and d in col_meanings:
            out[str(d)] = compact(col_meanings[d])
    return out


# ---------------------------------------------------------------------------------------------- truth guard

_MONEY_T = {"cost", "costs", "costing", "revenue", "revenues", "spend", "spending", "spent", "sales", "profit", "profits",
            "price", "prices", "dollar", "dollars", "budget", "wage", "wages", "salary", "salaries", "saving", "savings",
            "expense", "expenses", "income", "payment", "payments", "fee", "fees", "gmv", "aov", "arpu", "ltv", "cac",
            "earnings", "money", "$", "€", "£", "₹", "usd", "eur", "gbp", "inr"}
_TIME_T = {"time", "times", "wait", "waits", "waiting", "waited", "minute", "minutes", "mins", "min", "hour", "hours",
           "hrs", "duration", "durations", "delay", "delays", "second", "seconds", "secs", "latency"}
_RATE_T = {"rate", "rates", "%", "percent", "percentage", "share", "ratio", "utilisation", "utilization", "conversion"}
_COUNT_T = {"count", "counts", "customers", "users", "orders", "visits", "sessions", "records", "rows", "people",
            "bookings", "transactions", "tickets", "visitors", "clients", "patients", "leads", "signups", "headcount"}
_STOP_PHRASES = re.compile(r"\b(over time|through time|time series|timeline|by time|in time|on time|at a glance)\b", re.I)
_TOKEN = re.compile(r"[a-z0-9]+|[$€£₹%]")
_AGG_WORD = {"sum": "Total", "avg": "Average", "min": "Minimum", "max": "Maximum", "count": "Number of",
             "count_distinct": "Distinct"}


def _tokens(text: str) -> set[str]:
    t = _STOP_PHRASES.sub(" ", str(text or "").lower())
    return set(_TOKEN.findall(t))


def _sing(w: str) -> str:
    return w[:-1] if len(w) > 3 and w.endswith("s") else w


def _label_words(names: list[str], col_meanings: dict) -> set[str]:
    words: set[str] = set()
    for n in names:
        if not n:
            continue
        words |= _tokens(str(n)) | _tokens((col_meanings.get(n) or {}).get("label") or "")
    return words | {_sing(w) for w in words}


def _measure_roles(block: dict, col_meanings: dict) -> set[str]:
    roles: set[str] = set()
    for m in measures_of(block):
        agg = str(m.get("agg") or "")
        if agg == "kpi_pack":
            fmt = str((block.get("computed") or {}).get("format") or block.get("kpi_format") or "")
            roles.add({"percent": "percent", "currency": "money", "duration": "duration", "integer": "count"}.get(fmt, "measure"))
            continue
        roles.add(measure_meaning(agg, col_meanings.get(m.get("column") or ""), m.get("column")).get("role") or "measure")
    if bins_of(block):
        roles.add("count")
    return roles


def honest_title(block: dict, col_meanings: dict) -> str:
    """A title built from what the block computes: "Average waiting time", "Total waiting time and
    service time by customers (min)", "Distribution of waiting time"."""
    b = bins_of(block)
    if b:
        lab = (col_meanings.get(b) or {}).get("label") or S.human_name(b)
        unit = (col_meanings.get(b) or {}).get("unit")
        return f"Distribution of {lab.lower()}" + (f" ({unit})" if unit and (col_meanings.get(b) or {}).get("role") == "duration" else "")
    ms = [m for m in measures_of(block) if m.get("agg") != "kpi_pack"]
    if not ms:
        return str(block.get("title") or "Block")
    aggs = {str(m.get("agg") or "") for m in ms}
    labels = []
    units = set()
    for m in ms[:3]:
        cm = col_meanings.get(m.get("column") or "") or {}
        if not m.get("column"):
            labels.append("rows")
            continue
        labels.append(str(cm.get("label") or S.human_name(m.get("column"))).lower())
        if cm.get("role") == "duration" and cm.get("unit"):
            units.add(cm["unit"])
    if len(aggs) == 1:
        agg = next(iter(aggs))
        if agg == "count" and labels == ["rows"]:
            head = "Number of rows"
        else:
            word = _AGG_WORD.get(agg, "")
            joined = labels[0] if len(labels) == 1 else ", ".join(labels[:-1]) + " and " + labels[-1]
            head = f"{word} {joined}".strip()
    else:
        parts = []
        for m, lab in zip(ms, labels):
            word = _AGG_WORD.get(str(m.get("agg") or ""), "")
            parts.append(f"{word.lower()} {lab}".strip() if parts else f"{word} {lab}".strip())
        head = parts[0] if len(parts) == 1 else ", ".join(parts[:-1]) + " and " + parts[-1]
    dims = dims_of(block)
    t = time_of(block)
    tail = ""
    if t:
        tail = " over time"
    if dims:
        dl = [str((col_meanings.get(d) or {}).get("label") or S.human_name(d)).lower() for d in dims[:2]]
        tail += " by " + " and ".join(dl)
    unit = f" ({next(iter(units))})" if len(units) == 1 else ""
    title = (head + tail + unit).strip()
    return title[:1].upper() + title[1:120]


def _close(v: float, a: float) -> bool:
    if v is None or a is None:
        return False
    try:
        v, a = float(v), float(a)
    except (TypeError, ValueError):
        return False
    if not (math.isfinite(v) and math.isfinite(a)):
        return False
    tol = max(abs(a) * 0.006, 0.011)
    if abs(v - a) <= tol:
        return True
    # a fraction shown as a percentage (0.925 vs 92.5)
    return abs(v * 100 - a) <= max(abs(a) * 0.006, 0.011) or abs(v - a * 100) <= max(abs(a * 100) * 0.006, 0.011)


def numbers_agree(computed: dict | None, answer_numbers: list[float] | None) -> bool | None:
    """True when a block's computed number(s) are among the answer's numbers (within rounding), False
    when they are not, None when there is nothing to compare."""
    nums = [float(x) for x in (answer_numbers or []) if isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(float(x))]
    comp = computed or {}
    vals = [comp["value"]] if isinstance(comp.get("value"), (int, float)) else list(comp.get("top") or [])
    if not nums or not vals:
        return None
    return any(_close(v, a) for v in vals for a in nums)


def truth_guard(block: dict, col_meanings: dict[str, dict], answer_numbers: list[float] | None = None) -> dict:
    """Checks that a block's title tells the truth about what it computes. Returns
    {"action": "keep" | "retitle" | "drop", "title": str, "reason": str | None, "drop_measures": [aliases]}.

    - a measure that SUMs / AVGs an identifier, a sequence, a year or a clock time is meaningless:
      the measure is dropped (the block too when nothing else is left);
    - "cost/revenue/spend..." needs a money measure; "time/wait/minutes" a duration; "rate/%/share"
      a percentage; "customers/count" a count - unless the word names one of the block's own columns;
    - a block said to come from an answer (origin "Q1") must show one of that answer's numbers.
    On a mismatch the title is rebuilt from the measure (honest_title)."""
    title = str(block.get("title") or "")
    if block.get("static") or block.get("type") in ("text", "scenario"):
        return {"action": "keep", "title": title, "reason": None, "drop_measures": []}
    ms = measures_of(block)
    bad = []
    for m in ms:
        if m.get("agg") in ("sum", "avg") and m.get("column"):
            role = (col_meanings.get(m["column"]) or {}).get("role")
            if role in NOT_ADDABLE_ROLES:
                bad.append(m)
    if bad and len(bad) == len(ms):
        what = ", ".join(sorted({str((col_meanings.get(m['column']) or {}).get('label') or m['column']) for m in bad}))
        role = (col_meanings.get(bad[0]["column"]) or {}).get("role")
        kind = {"id": "an identifier", "sequence": "a position in a list", "year": "a year", "clock": "a time of day"}.get(role, "not an amount")
        return {"action": "drop", "title": title, "drop_measures": [m.get("alias") for m in bad],
                "reason": f"{what} is {kind} - adding it up or averaging it means nothing."}
    reasons: list[str] = []
    drop_measures = [m.get("alias") for m in bad]
    work = dict(block)
    if bad:
        reasons.append("left out " + ", ".join(str(m.get("column")) for m in bad) + " (not an amount)")
        keep = [m for m in ms if m not in bad]
        if isinstance(work.get("spec"), dict):
            work["spec"] = {**work["spec"], "measures": [m for m in work["spec"].get("measures") or [] if m.get("alias") not in drop_measures]}
        if isinstance(work.get("recipe"), dict) and work["recipe"].get("measures"):
            work["recipe"] = {**work["recipe"], "measures": [m for m in work["recipe"]["measures"] if m.get("alias") not in drop_measures]}
        ms = keep
    words = _tokens(title)
    words_s = words | {_sing(w) for w in words}
    roles = _measure_roles(work, col_meanings)
    cols = [m.get("column") for m in ms if m.get("column")] + dims_of(work) + ([time_of(work)] if time_of(work) else []) + \
        ([bins_of(work)] if bins_of(work) else [])
    own = _label_words(cols, col_meanings)
    mismatch = []
    if (words_s & _MONEY_T) and "money" not in roles and not ((words_s & _MONEY_T) & own):
        mismatch.append("the title says money but the numbers are not money")
    if (words_s & _TIME_T) and not (roles & {"duration", "clock"}) and not ((words_s & _TIME_T) & own):
        mismatch.append("the title says time but the numbers are not a duration")
    if (words_s & _RATE_T) and not (roles & {"percent", "rate"}) and not ((words_s & _RATE_T) & own):
        mismatch.append("the title says rate but the numbers are not a percentage")
    count_words = (words_s & _COUNT_T) | ({"number"} if "number of" in title.lower() else set())
    if count_words and "count" not in roles and not ({_sing(w) for w in count_words} & own) and not (count_words & own):
        mismatch.append("the title says a count but the numbers are not a count")
    origin = str(block.get("origin") or "")
    if re.fullmatch(r"Q\d{1,2}", origin) and answer_numbers is not None:
        agree = numbers_agree(block.get("computed"), answer_numbers)
        if agree is False:
            mismatch.append(f"its numbers are not the numbers of answer {origin}")
    if mismatch or bad:
        new_title = honest_title(work, col_meanings)
        return {"action": "retitle", "title": new_title, "reason": "; ".join(reasons + mismatch) or None,
                "drop_measures": drop_measures, "origin_mismatch": any("answer" in x for x in mismatch)}
    return {"action": "keep", "title": title, "reason": None, "drop_measures": []}


# ---------------------------------------------------------------------------------------------- signatures

def _family(btype: str | None) -> str:
    t = str(btype or "chart")
    return "kpi" if t in ("kpi", "sparkline", "gauge") else "table" if t == "table" else "text" if t == "text" else \
        "scenario" if t == "scenario" else "chart"


def block_signature(source: dict | None, btype: str | None = None) -> tuple | None:
    """Exact signature of a spec OR a recipe: table, group-by, time column + grain, date parts, bins,
    measures (agg + column/expr), filters and the block family. None for nothing comparable."""
    if not isinstance(source, dict):
        return None
    if source.get("agg") == "kpi_pack":
        return ("kpi_pack", source.get("table"), source.get("kpi_key"), _family(btype or "kpi"))
    if source.get("measures"):
        meas = tuple(sorted((str(m.get("agg")), str(m.get("column") or m.get("expr") or "")) for m in source["measures"] if isinstance(m, dict)))
    elif source.get("agg"):
        col = "" if source.get("count_rows") else str(source.get("metric_column") or "")
        meas = ((str(source.get("agg")), col),)
    else:
        return None
    t = source.get("time") if isinstance(source.get("time"), dict) else {}
    group = list(source.get("group_by") or []) or ([source["group_by_column"]] if source.get("group_by_column") else [])
    tcol, grain = t.get("column"), t.get("grain")
    if not tcol and source.get("time_grain") and group:
        tcol, grain, group = group[0], source.get("time_grain"), group[1:]
    parts = tuple(sorted((str(p.get("column")), str(p.get("part"))) for p in source.get("date_parts") or [] if isinstance(p, dict)))
    bins = (source.get("bins") or {}).get("column") if isinstance(source.get("bins"), dict) else None
    filters = json.dumps(sorted((json.dumps(f, sort_keys=True, default=str) for f in source.get("filters") or [])), default=str)
    return (source.get("table"), tuple(group), tcol, grain, parts, bins, meas, filters, _family(btype or source.get("block_type")))


def near_signature(source: dict | None, btype: str | None = None) -> tuple | None:
    """Near-duplicate key for multi-row blocks: same table, dimensions, time column, bins and the same
    set of measure COLUMNS (aggregation and title ignored). None for KPIs (an average and a maximum of
    one column are different numbers)."""
    sig = block_signature(source, btype)
    if sig is None or sig[0] == "kpi_pack" or sig[-1] in ("kpi", "text", "scenario"):
        return None
    table, group, tcol, _grain, parts, bins, meas, filters, fam = sig
    cols = frozenset(c for _a, c in meas)
    return (table, frozenset(group), tcol, parts, bins, cols, filters, fam)


# ---------------------------------------------------------------------------------------------- recipes

def recipe_filter(df: pd.DataFrame, filters: list | None) -> pd.DataFrame:
    """Simple block filters for a FILE recipe: = != > >= < <= in, between, is_null, is_not_null.
    A filter on a missing column raises ValueError (said to the person, never ignored)."""
    for f in filters or []:
        if not isinstance(f, dict):
            continue
        col, op, val = f.get("column"), str(f.get("op") or "=").lower(), f.get("value")
        if col not in df.columns:
            raise ValueError(f'The filter column "{col}" was not found in this data.')
        s = df[col]
        num = pd.to_numeric(s, errors="coerce") if not pd.api.types.is_numeric_dtype(s) else s

        def as_num(v):
            try:
                return float(v)
            except (TypeError, ValueError):
                return None
        if op in ("=", "==", "equals"):
            mask = (s.astype(str) == str(val)) if not isinstance(val, (int, float)) or isinstance(val, bool) else (num == float(val))
        elif op == "!=":
            mask = (s.astype(str) != str(val)) if not isinstance(val, (int, float)) or isinstance(val, bool) else (num != float(val))
        elif op == "in":
            vals = val if isinstance(val, list) else [val]
            mask = s.astype(str).isin([str(v) for v in vals])
        elif op in (">", ">=", "<", "<="):
            x = as_num(val)
            if x is None:
                raise ValueError(f'The filter on "{col}" needs a number.')
            mask = {">": num > x, ">=": num >= x, "<": num < x, "<=": num <= x}[op]
        elif op == "between":
            lo, hi = (val or [None, None])[:2] if isinstance(val, list) else (None, None)
            lo, hi = as_num(lo), as_num(hi)
            if lo is None or hi is None:
                raise ValueError(f'The "between" filter on "{col}" needs two numbers.')
            mask = (num >= lo) & (num <= hi)
        elif op == "is_null":
            mask = s.isna()
        elif op == "is_not_null":
            mask = s.notna()
        else:
            raise ValueError(f'The filter "{op}" is not supported on a file - use =, !=, in, >, >=, <, <=, between or is (not) null.')
        df = df[mask.fillna(False) if hasattr(mask, "fillna") else mask]
    return df


_WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def date_part_series(series: pd.Series, part: str) -> pd.Series:
    """weekday -> Monday..Sunday (ordered), month -> Jan..Dec (ordered), quarter -> Q1..Q4,
    day -> 1..31, hour -> 0..23. Raises ValueError when the column holds no dates."""
    d = series if pd.api.types.is_datetime64_any_dtype(series) else pd.to_datetime(series, errors="coerce", format="mixed")
    if not d.notna().any():
        raise ValueError(f'"{series.name}" holds no dates, so its {part} cannot be read.')
    if part == "weekday":
        return pd.Categorical(d.dt.day_name(), categories=_WEEKDAYS, ordered=True)
    if part == "month":
        return pd.Categorical(d.dt.month.map(lambda x: _MONTHS[int(x) - 1] if pd.notna(x) else None), categories=_MONTHS, ordered=True)
    if part == "quarter":
        return pd.Categorical(d.dt.quarter.map(lambda x: f"Q{int(x)}" if pd.notna(x) else None), categories=["Q1", "Q2", "Q3", "Q4"], ordered=True)
    if part == "day":
        return d.dt.day.astype("Int64")
    if part == "hour":
        return d.dt.hour.astype("Int64")
    raise ValueError(f'The date part "{part}" is not supported - use weekday, month, quarter, day or hour.')


def fd_bin_count(values: pd.Series, lo: int = 5, hi: int = 20) -> int:
    """Freedman-Diaconis bin count, capped to [lo, hi] (Sturges when the IQR is 0)."""
    v = pd.to_numeric(values, errors="coerce").dropna().to_numpy(dtype=float)
    n = len(v)
    if n < 2:
        return lo
    span = float(v.max() - v.min())
    if span <= 0:
        return lo
    q75, q25 = np.percentile(v, [75, 25])
    iqr = float(q75 - q25)
    if iqr > 0:
        width = 2 * iqr / (n ** (1 / 3))
        k = int(math.ceil(span / width)) if width > 0 else lo
    else:
        k = int(math.ceil(math.log2(n) + 1))
    return max(lo, min(hi, k))


def bin_label(start: float | None, end: float | None, unit: str | None = None, currency: str | None = None) -> str:
    def f(x):
        if x is None:
            return ""
        if currency:
            return S.format_value(x, {"role": "money", "currency": currency})
        return S.fmt_number(float(x))
    u = f" {unit}" if unit and not currency and unit not in ("%",) else ("%" if unit == "%" else "")
    if start is None:
        return f"under {f(end)}{u}"
    if end is None:
        return f"{f(start)}{u} and over"
    return f"{f(start)}–{f(end)}{u}"


# ---------------------------------------------------------------------------------------------- KPI pack

_FMT = {"integer": "number", "duration": "number", "percent": "percent", "currency": "currency", "number": "number", "text": "text"}


def kpi_pack_config(df: pd.DataFrame, recipe: dict) -> tuple[dict, str]:
    """A KPI tile from semantics.kpi_pack, recomputed on the (filtered) frame every time: value,
    label, format, unit, note ("37 of 40 waited"), tone ("bad" for utilisation over 100%) and its
    meaning. A percentage is stored as a fraction with format "percent" (what every KPI tile reads)."""
    cols = [c for c in (recipe.get("kpi_columns") or []) if c in df.columns] or list(df.columns)
    sub = df[cols]
    pack = S.kpi_pack(sub, limit=50)
    key = recipe.get("kpi_key")
    k = next((x for x in pack["kpis"] if x.get("key") == key), None)
    label = recipe.get("label") or (k or {}).get("label") or str(key)
    if k is None:
        return {"value": None, "label": label, "recipe": recipe, "meaning": compact(recipe.get("meaning")),
                "note": "No rows match the filters" if len(sub) == 0 else None, "tone": None}, label
    fmt = k.get("format") or "number"
    value = k.get("value")
    meaning: dict
    if fmt == "percent":
        value = value / 100.0 if value is not None else None
        meaning = {"role": "percent", "unit": "%", "currency": None, "scale": "fraction"}
    elif fmt == "currency":
        meaning = {"role": "money", "unit": k.get("currency"), "currency": k.get("currency"), "scale": None}
    elif fmt == "duration":
        meaning = {"role": "duration", "unit": k.get("unit"), "currency": None, "scale": None}
    elif fmt == "integer":
        meaning = {"role": "count", "unit": None, "currency": None, "scale": None}
    elif fmt == "text":
        meaning = {"role": "date", "unit": None, "currency": None, "scale": None}
    else:
        meaning = {"role": "measure", "unit": k.get("unit"), "currency": None, "scale": None}
    meaning["label"] = label
    cfg = {"value": float(value) if isinstance(value, (int, float)) and math.isfinite(float(value)) else None,
           "label": label, "recipe": recipe, "meaning": meaning, "note": k.get("note"), "tone": k.get("tone")}
    if _FMT.get(fmt) in ("percent", "currency") and (fmt != "currency" or k.get("currency")):
        cfg["format"] = _FMT[fmt]
    if fmt == "text":
        cfg["display"] = k.get("text")
        cfg["note"] = k.get("text")
    if key == "utilisation":
        cfg["good_direction"] = "down"
    return cfg, label


def kpi_pack_seeds(df: pd.DataFrame, meanings: dict | None = None, table: str | None = None, limit: int = 8) -> dict:
    """{"kind", "blocks": [proposal blocks], "covers": {(column, agg)}, "queue": columns}: the KPI row a
    senior analyst would put first for this kind of data, as file recipes (agg "kpi_pack") that are
    recomputed on every refresh and filter change."""
    m = meanings or S.infer_frame(df)
    pack = S.kpi_pack(df, m, limit=limit)
    kind, q = pack["kind"], pack.get("queue")
    if q:
        kpi_cols = [c for c in (q.get("wait"), q.get("service"), q.get("arrival"), q.get("gap"), q.get("start"), q.get("end")) if c]
    else:
        kpi_cols = None
    covers: set = set()
    blocks: list[dict] = []
    for i, k in enumerate(pack["kpis"]):
        key = k["key"]
        cols = kpi_cols
        if not q:
            col = key.split(":")[0] if ":" in key else None
            cols = [col] if col and col in df.columns else ([c for c, x in m.items() if x["role"] == "date"][:1] if key == "span" else [])
            if key == "rows":
                cols = []
            if ":" in key:
                covers.add((col, key.split(":")[1]))
        else:
            mapping = {"customers": ("", "count"), "total_wait": (q["wait"], "sum"), "avg_wait": (q["wait"], "avg"),
                       "avg_service": (q["service"], "avg"), "avg_gap": (q.get("gap") or "", "avg")}
            if key in mapping:
                covers.add(mapping[key])
        if key == "rows":
            covers.add(("", "count"))
        recipe = {"block_type": "kpi", "agg": "kpi_pack", "kpi_key": key, "kpi_columns": cols or [], "label": k["label"],
                  "metric_column": None, "group_by_column": None}
        if table:
            recipe["table"] = table
        cfg, _label = kpi_pack_config(df, recipe)
        blocks.append({"client_id": f"s{i + 1}", "type": "kpi", "title": k["label"], "intent": f"KPI · {k['label']}",
                       "spec": None, "recipe": recipe, "chart_type": None, "text": None, "from_metric_id": None,
                       "from_metric_name": None, "status": "ok", "error": None, "sql": None, "columns": [],
                       "origin": "suggested", "why": "the number that matters first for this kind of data",
                       "seeded": True, "computed": {"value": cfg.get("value")}, "kpi_format": k.get("format")})
    return {"kind": kind, "blocks": blocks, "covers": covers, "queue": q}


def queue_chart_seeds(df: pd.DataFrame, meanings: dict, q: dict, table: str | None = None) -> list[dict]:
    """The charts that explain a queue: wait by customer in arrival order (every customer, a line),
    the waiting-time distribution (real bins), time between arrivals vs service time per customer,
    and wait over the clock. Every one is a file recipe, so filters and refreshes recompute it."""
    out: list[dict] = []
    seq = q.get("id")
    wait, service, gap, arrival = q.get("wait"), q.get("service"), q.get("gap"), q.get("arrival")
    unit = (meanings.get(wait) or {}).get("unit") or "min"
    label = lambda c: str((meanings.get(c) or {}).get("label") or S.human_name(c))  # noqa: E731

    def blk(cid, title, intent, recipe, chart_type, why):
        if table:
            recipe["table"] = table
        return {"client_id": cid, "type": "chart", "title": title, "intent": intent, "spec": None, "recipe": recipe,
                "chart_type": chart_type, "text": None, "from_metric_id": None, "from_metric_name": None, "status": "ok",
                "error": None, "sql": None, "columns": [], "origin": "suggested", "why": why, "seeded": True}
    if seq and wait:
        out.append(blk("q1", f"{label(wait)} by {label(seq).lower()} in arrival order ({unit})", "Trend · wait per customer",
                       {"block_type": "chart", "chart_type": "line", "metric_column": wait, "agg": "sum", "group_by_column": seq,
                        "alias": re.sub(r"[^a-z0-9]+", "_", label(wait).lower()).strip("_") or "wait",
                        "order_by": [{"by": seq, "dir": "asc"}], "limit": 500, "x_axis": "numeric"},
                       "line", "does the wait keep growing as customers arrive?"))
    if wait:
        out.append(blk("q2", f"How long customers waited ({unit})", "Distribution · wait",
                       {"block_type": "chart", "chart_type": "histogram", "metric_column": wait, "agg": "count",
                        "bins": {"column": wait, "count": None, "auto": True}},
                       "histogram", "how many waited a little, how many a lot"))
    if seq and service and gap:
        out.append(blk("q3", f"{label(gap)} vs {label(service).lower()} by {label(seq).lower()} ({unit})", "Comparison · arrivals vs service",
                       {"block_type": "chart", "chart_type": "line", "metric_column": gap, "agg": "sum", "group_by_column": seq,
                        "measures": [{"alias": "time_between_arrivals", "agg": "sum", "column": gap},
                                     {"alias": "service_time", "agg": "sum", "column": service}],
                        "group_by": [seq], "order_by": [{"by": seq, "dir": "asc"}], "limit": 500, "x_axis": "numeric"},
                       "line", "service slower than arrivals means a queue builds"))
    if arrival and wait and (meanings.get(arrival) or {}).get("role") in ("clock", "duration", "measure"):
        out.append(blk("q4", f"{label(wait)} by {label(arrival).lower()} ({unit})", "Trend · wait over the day",
                       {"block_type": "chart", "chart_type": "line", "metric_column": wait, "agg": "sum", "group_by_column": arrival,
                        "alias": "waiting_time", "order_by": [{"by": arrival, "dir": "asc"}], "limit": 500, "x_axis": "numeric"},
                       "line", "when in the day the queue is longest"))
    return out


# ---------------------------------------------------------------------------------------------- filters

def seed_parameters(meanings: dict[str, dict], date_column: str | None = None, prefer: list[str] | None = None,
                    max_filters: int = 4, distinct: dict | None = None) -> list[dict]:
    """Rail filters from low-cardinality columns of ANY type (category / geo / boolean / year with 2-50
    distinct values - "Server" 1/2/3, Year, Store, a region), columns some block uses first, then
    fewest values first; plus a date range when a REAL date column exists."""
    prefer = list(prefer or [])
    cands: list[tuple] = []
    for c, m in meanings.items():
        role = m.get("role")
        if role not in ("category", "geo", "boolean", "year"):
            continue
        n = (distinct or {}).get(c, m.get("distinct"))
        if n is not None and not (2 <= int(n) <= 50):
            continue
        if n is None and role == "category" and c not in prefer:
            continue  # a text column of unknown size is only a filter when a block already splits by it
        cands.append((0 if c in prefer else 1, int(n) if n is not None else 25, c))
    cands.sort()
    out: list[dict] = []
    used_ids: set[str] = set()
    for _p, _n, c in cands[:max_filters]:
        pid = "p_" + (re.sub(r"[^A-Za-z0-9_]+", "_", c).strip("_").lower()[:24] or "f")
        while pid in used_ids:
            pid += "_2"
        used_ids.add(pid)
        out.append({"id": pid, "name": re.sub(r"[^A-Za-z0-9_]+", "_", c).strip("_") or pid, "column": c,
                    "label": str(meanings[c].get("label") or c)[:80], "control": "chips", "options_from": "distinct",
                    "default": None, "table": None})
    if date_column and (meanings.get(date_column) or {}).get("role") == "date":
        out.append({"id": "p_date_range", "name": "date_range", "column": date_column, "label": "Date range",
                    "control": "date_range", "options_from": None, "default": None, "table": None})
    return out


def real_date_column(meanings: dict[str, dict], proposed: str | None = None) -> str | None:
    """The proposed date column when it really holds dates, else the first column that does."""
    if proposed and (meanings.get(proposed) or {}).get("role") == "date":
        return proposed
    return next((c for c, m in meanings.items() if m.get("role") == "date"), None)


# ---------------------------------------------------------------------------------------------- catalog

def catalog_text(table: str, meanings: dict[str, dict], extra: dict | None = None) -> str:
    """`Table `t`:` then one semantics.catalog_line per column - roles, units, ranges, samples,
    distinct counts - what the dashboard proposer plans from."""
    lines = [f"Table `{table}`:"]
    for c, m in meanings.items():
        line = "  - " + S.catalog_line(c, m)
        if extra and extra.get(c):
            line += f" - {extra[c]}"
        lines.append(line)
    return "\n".join(lines)


# ---------------------------------------------------------------------------------------------- analyst answers

def _money_code(model: dict | None) -> str | None:
    for i in (model or {}).get("inputs") or []:
        u = str(i.get("unit") or "").strip()
        if u in _CURRENCY_BY_SYMBOL:
            return _CURRENCY_BY_SYMBOL[u]
    return None


def _out_meaning(fmt: str | None, currency: str | None, label: str | None = None) -> dict:
    fmt = fmt or "number"
    if fmt == "money":
        return {"role": "money", "unit": currency, "currency": currency, "scale": None, "label": label}
    if fmt == "percent":
        return {"role": "percent", "unit": "%", "currency": None, "scale": "points", "label": label}
    if fmt in ("minutes", "hours"):
        return {"role": "duration", "unit": "min" if fmt == "minutes" else "h", "currency": None, "scale": None, "label": label}
    if fmt == "integer":
        return {"role": "count", "unit": None, "currency": None, "scale": None, "label": label}
    return {"role": "measure", "unit": None, "currency": None, "scale": None, "label": label}


def _best_row(model: dict) -> dict | None:
    pick = model.get("pick") or {}
    key = pick.get("output")
    rows = [r for r in model.get("rows") or [] if isinstance((r.get("computed") or {}).get(key), (int, float))
            and math.isfinite(float(r["computed"][key]))]
    if not rows:
        return None
    return (max if pick.get("goal") == "max" else min)(rows, key=lambda r: r["computed"][key])


def _table_meanings(columns: list, rows: list) -> dict:
    names = [c.get("name") if isinstance(c, dict) else str(c) for c in columns or []]
    try:
        df = pd.DataFrame([r for r in rows or [] if isinstance(r, dict)], columns=names)
    except Exception:  # noqa: BLE001
        return {}
    out = {}
    for n in names:
        try:
            out[n] = compact(S.infer_column(n, df[n]))
        except Exception:  # noqa: BLE001
            out[n] = {"role": None, "unit": None, "currency": None, "scale": None}
    return out


def analyst_numbers(result: dict | None) -> list[float]:
    """Every number an answer showed: its KPIs and facts, the Analyst's key numbers, model outputs and
    the numbers in its tables (the truth guard's reference)."""
    r = result or {}
    out: list[float] = []

    def add(v):
        if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(float(v)):
            out.append(float(v))
    for k in r.get("kpis") or []:
        if isinstance(k, dict):
            add(k.get("value"))
    for f in r.get("facts") or []:
        if isinstance(f, dict):
            add(f.get("value"))
    a = r.get("analyst") or {}
    for v in (a.get("key_numbers") or {}).values():
        add(v)
    m = a.get("model") or {}
    for row in m.get("rows") or []:
        for v in (row.get("computed") or {}).values():
            add(v)
        for v in (row.get("values") or {}).values():
            add(v)
    for t in (a.get("tables") or [])[:4]:
        for row in (t.get("rows") or [])[:200]:
            if isinstance(row, dict):
                for v in row.values():
                    add(v)
    for vis in r.get("visuals") or []:
        for row in (vis.get("rows") or [])[:200] if isinstance(vis, dict) else []:
            if isinstance(row, dict):
                for v in row.values():
                    add(v)
    return out


def is_analyst(result: dict | None) -> bool:
    r = result or {}
    return r.get("analysis_type") == "analyst" and isinstance(r.get("analyst"), dict)


def analyst_source_ids(result: dict | None) -> list[str]:
    a = (result or {}).get("analyst") or {}
    return [str(d.get("source_id")) for d in a.get("data_used") or [] if isinstance(d, dict) and d.get("source_id")]


def analyst_blocks(result: dict, *, label: str, run_id: str, question: str | None = None, prefix: str = "a") -> dict:
    """An Analyst answer as dashboard blocks, straight from what it computed (never re-planned as SQL):
    {"blocks": [...], "parameters": [...]} - decision KPIs (best option, today, saving), the live
    `scenario` block, the main table, the chart, and the assumptions (text) + scenario inputs."""
    a = result.get("analyst") or {}
    model = a.get("model") if isinstance(a.get("model"), dict) else None
    cur = _money_code(model)
    blocks: list[dict] = []
    n = 0

    def add(btype: str, title: str, config: dict, intent: str, why: str) -> dict:
        nonlocal n
        n += 1
        b = {"client_id": f"{prefix}{n}", "type": btype, "title": str(title)[:120], "intent": intent, "spec": None, "recipe": None,
             "chart_type": config.get("chart_type"), "text": config.get("text"), "from_metric_id": None, "from_metric_name": None,
             "status": "ok", "error": None, "sql": None, "columns": [], "origin": label, "why": why, "static": True,
             "config": {**config, "static": True, "origin": label, "source_run_id": run_id}}
        if question:
            b["origin_question"] = question
            b["config"]["origin_question"] = question
        blocks.append(b)
        return b

    # 1) the decision, as KPI tiles
    if model and model.get("rows") and model.get("outputs"):
        key = (model.get("pick") or {}).get("output")
        out = next((o for o in model["outputs"] if o.get("key") == key), None)
        best = _best_row(model)
        base = model["rows"][0]
        if out and best is not None:
            mean = _out_meaning(out.get("format"), cur, out.get("label"))
            fmt = "currency" if mean["role"] == "money" and cur else None
            word = "Cheapest" if (model.get("pick") or {}).get("goal") != "max" else "Best"
            bl = re.sub(r"\s*\((today|baseline)\)", "", str(best.get("label") or ""), flags=re.I).strip()
            cfg = {"value": float(best["computed"][key]), "label": f"{word}: {bl}", "meaning": mean,
                   "note": f"{out.get('label')} with {bl}", "tone": "good"}
            if fmt:
                cfg["format"] = fmt
            add("kpi", f"{word} option: {bl}", cfg, f"KPI · {out.get('label')}", "the decision")
            bv = base.get("computed", {}).get(key)
            if isinstance(bv, (int, float)):
                bbl = re.sub(r"\s*\((today|baseline)\)", "", str(base.get("label") or ""), flags=re.I).strip()
                cfg2 = {"value": float(bv), "label": f"Today: {bbl}", "meaning": mean, "note": f"{out.get('label')} today",
                        "tone": None}
                if fmt:
                    cfg2["format"] = fmt
                add("kpi", f"{out.get('label')} today ({bbl})", cfg2, f"KPI · {out.get('label')} today", "where you are now")
                if best is not base:
                    diff = (float(bv) - float(best["computed"][key])) if (model.get("pick") or {}).get("goal") != "max" else \
                        (float(best["computed"][key]) - float(bv))
                    word2 = "Saving" if (model.get("pick") or {}).get("goal") != "max" else "Gain"
                    cfg3 = {"value": diff, "label": f"{word2} vs today", "meaning": mean,
                            "note": f"{bl} vs {bbl}", "tone": "good" if diff > 0 else None}
                    if fmt:
                        cfg3["format"] = fmt
                    add("kpi", f"{word2} vs today", cfg3, f"KPI · {word2.lower()}", "what the decision is worth")
    elif a.get("key_numbers"):
        for k, v in list((a.get("key_numbers") or {}).items())[:4]:
            if not isinstance(v, (int, float)):
                continue
            mean = compact(name_meaning(str(k), "float"))
            mean["label"] = S.human_name(k)
            cfg = {"value": float(v), "label": S.human_name(k), "meaning": mean, "note": None, "tone": None}
            if mean.get("role") == "money" and mean.get("currency"):
                cfg["format"] = "currency"
            add("kpi", S.human_name(k), cfg, f"KPI · {S.human_name(k)}", "a key number of the answer")
    # 2) the live what-if
    scenario = None
    if model and model.get("inputs") and model.get("rows") and model.get("outputs"):
        meanings = {o["key"]: _out_meaning(o.get("format"), cur, o.get("label")) for o in model["outputs"] if o.get("key")}
        scenario = add("scenario", a.get("title") or "What if", {"model": model, "title": a.get("title") or "What if",
                                                                 "meanings": meanings, "currency": cur},
                       "Scenario · live what-if", "change the assumptions and see the decision move")
    # 3) the main table
    tables = [t for t in a.get("tables") or [] if isinstance(t, dict) and t.get("rows")]
    if tables:
        t = tables[0]
        cols = [c.get("name") if isinstance(c, dict) else str(c) for c in t.get("columns") or []]
        total = int(t.get("rows_total") or len(t["rows"]))
        add("table", t.get("title") or "Every option", {"columns": cols, "rows": t["rows"][:200],
                                                         "meanings": _table_meanings(t.get("columns"), t["rows"]),
                                                         "truncated": total > len(t["rows"][:200]), "total_groups": total,
                                                         "shown_groups": len(t["rows"][:200])},
            "Table · options", "every option side by side")
    # 4) the chart the answer drew
    for vis in (result.get("visuals") or [])[:1]:
        if not isinstance(vis, dict) or vis.get("type") != "chart" or not vis.get("rows"):
            continue
        rows = vis["rows"][:200]
        add("chart", vis.get("title") or "Chart", {"chart_type": vis.get("chart_type") or "bar",
                                                    "result_columns": vis.get("columns") or [], "result_rows": rows,
                                                    "meanings": _table_meanings(vis.get("columns"), rows),
                                                    "truncated": bool(vis.get("truncated")), "total_groups": len(vis["rows"]),
                                                    "shown_groups": len(rows)},
            "Chart · answer", "the answer's chart")
    # 5) assumptions: a note, and every numeric one as a scenario input on the filter rail
    if a.get("assumptions"):
        text = "Assumptions: " + " ".join(str(x).strip().rstrip(".") + "." for x in a["assumptions"][:8])
        add("text", "Assumptions", {"text": text}, "Text · assumptions", "what the numbers rest on")
    params: list[dict] = []
    if model and scenario is not None:
        for i in model.get("inputs") or []:
            pid = f"s_{re.sub(r'[^A-Za-z0-9_]+', '_', str(run_id))[:8]}_{i.get('key')}"[:48]
            params.append({"id": pid, "name": re.sub(r"[^A-Za-z0-9_]", "_", pid), "kind": "scenario_input", "key": i.get("key"),
                           "label": i.get("label"), "value": i.get("value"), "min": i.get("min"), "max": i.get("max"),
                           "step": i.get("step"), "unit": i.get("unit"), "block_ids": [scenario["client_id"]],
                           "control": "scenario_input", "column": None})
    return {"blocks": blocks, "parameters": params}


def analyst_summary(result: dict, label: str, question: str) -> str:
    """One compact line for a dashboard goal: the question, the decision and its key numbers."""
    a = result.get("analyst") or {}
    ans = result.get("answer") or {}
    bits = [f'{label}) "{str(question or "").strip()[:160]}"']
    if ans.get("headline"):
        bits.append(f"found: {str(ans['headline'])[:160]}")
    kn = list((a.get("key_numbers") or {}).items())[:4]
    if kn:
        bits.append("numbers: " + "; ".join(f"{S.human_name(k)} = {S.fmt_number(float(v))}" for k, v in kn if isinstance(v, (int, float))))
    bits.append("(an Analyst answer - already on the dashboard as its own decision, table and live what-if; do not rebuild its numbers)")
    return " - ".join(bits)


# ---------------------------------------------------------------------------------------------- friendly errors

_SQLISH = re.compile(r"\b(select|from|where|group by|psycopg2|sqlalchemy|programmingerror|syntax error|traceback|"
                     r"undefinedcolumn|snowflake|bigquery error|sqlstate|ora-\d+|background on this error|line \d+ at position)\b", re.I)


def friendly_error(text: str | None) -> str:
    """A block/build error as a sentence for a person - never SQL, a driver message or a traceback."""
    t = str(text or "").strip()
    if not t:
        return "This block could not be built on this data."
    if not _SQLISH.search(t) and len(t) <= 300:
        return t
    low = t.lower()
    m = re.search(r'column "?([A-Za-z0-9_ .]+?)"? (does not exist|not found)', t, re.I) or \
        re.search(r"unrecognized name: ([A-Za-z0-9_]+)", t, re.I) or re.search(r"invalid identifier '?([A-Za-z0-9_\".]+)", t, re.I)
    if m:
        return f'A column this block needs ("{m.group(1).strip(chr(34))}") is not in the data - it may have been renamed.'
    if "permission" in low or "access denied" in low or "not authorized" in low:
        return "GD360 is not allowed to read this table with the connection's credentials."
    if "timeout" in low or "timed out" in low:
        return "The data source took too long to answer this block."
    if "does not exist" in low or "not found" in low:
        return "A table or column this block needs is not in the data source any more."
    return "The data source could not compute this block."
