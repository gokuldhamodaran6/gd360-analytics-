"""
Forecasts inside an answer (2026-10-12, round 32).

"2026 forecast", "forecast the next 10 years", "what will revenue be in
2030", "2016 forcast in sales" (read as 2026): the planner fetches the
metric's history - by month when it can - and this module turns it into a
forecast for exactly the period asked, with an honest range. An answer
about the future is never history alone.

HOW
  1. THE SERIES   The history table the plan returned: a date column (or a
                  year and a month column, a "2024-Q1", or a year), one
                  measure - summed per period, averaged for a rate or an
                  average. The grain is read from the spacing of the dates.
                  Daily data is summed into months for anything beyond a
                  quarter ahead; a month the data only partly covers is left
                  out of the fit and forecast in full.
  2. THE MODEL    services/forecast.py - the dashboards' forecaster: damped
                  Holt-Winters / damped Holt / seasonal naive, chosen by a
                  rolling-origin backtest, with 80% and 95% bands from the
                  model's own out-of-sample errors - for as far as it allows
                  (24 months, 8 quarters, 26 weeks, half the history).
  3. LONG RANGE   Beyond that (5 or 10 years ahead) the yearly trend carries
                  on with DAMPED growth: the history's average yearly growth
                  (log CAGR), keeping 90% of it each further year (the damped
                  trend of Gardner & McKenzie, the most robust long-range
                  default in forecasting competitions). The band widens every
                  year: year-to-year growth noise (a random walk), plus the
                  uncertainty of the growth estimate itself, plus the model's
                  own range at the hand-over. Months of a long-range year
                  follow the history's seasonal shape. It is called a
                  long-range projection, never a prediction.
  4. NEVER A DEAD END
                  When the model refuses (too little history, or no better
                  than repeating the last value) a plain least-squares trend
                  with a prediction interval is used, and the answer says so.
                  Only with fewer than 3 periods is there no forecast - and
                  the answer says what it needs.

A forecast year's total is the sum of its months; its band is half way
between the fully correlated and the independent sum of the monthly bands
(monthly errors are positively correlated, but not perfectly).
Everything here is deterministic numpy - the same history gives the same
forecast.
"""
from __future__ import annotations

import math
import re
from datetime import date, timedelta

import numpy as np
import pandas as pd

from .. import forecast as fc
from .numbers import fmt, pct_change

Z80, Z95 = fc._Z80, fc._Z95  # noqa: SLF001 - the same quantiles as the dashboards
PHI = 0.9                   # each further year keeps 90% of the previous year's growth
SIGMA_FLOOR = 0.03          # yearly growth is never assumed steadier than +-3%
SIGMA_FLOOR_SHORT = 0.06    # ... or +-6% when there are fewer than 4 full years to measure it
MIN_POINTS = 3
MAX_YEARS_AHEAD = 30
HISTORY_SHOWN = 60          # history buckets kept in the chart payload
PPY = {"day": 365, "week": 52, "month": 12, "quarter": 4, "year": 1}
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

_TIME_NAME = re.compile(r"(date|day|week|month|period|quarter|year|time|_at$|^dt$|^ts$)", re.I)
_YEAR_NAME = re.compile(r"(^|_)(year|yr|fy|fiscal_year)($|_)", re.I)
_MONTH_NAME = re.compile(r"(^|_)(month|mon|mth|month_num|month_number|month_name)($|_)", re.I)
_QUARTER_NAME = re.compile(r"(^|_)(quarter|qtr|q)($|_)", re.I)
_MEAN_NAME = re.compile(r"(^|_)(avg|average|mean|median|rate|pct|percent|share|ratio|margin|aov|adr|ctr|cpc|cpm|cpa|roas|"
                        r"conversion|per)(_|$)", re.I)
_ID_NAME = re.compile(r"(^id$|_id$|^rank$|_rank$|_num$|^num_|sort|_index$|^idx)", re.I)
_MON_POS = {m.lower(): i + 1 for i, m in enumerate(MONTHS)} | {
    n: i + 1 for i, n in enumerate(["january", "february", "march", "april", "may", "june", "july", "august",
                                    "september", "october", "november", "december"])} | {"sept": 9}


# ---- dates ---------------------------------------------------------------------------------

def _month_end(y: int, m: int) -> date:
    return fc.period_end(date(y, m, 1), "month")


def _bucket(d: date, grain: str) -> date:
    if grain == "month":
        return date(d.year, d.month, 1)
    if grain == "quarter":
        return date(d.year, ((d.month - 1) // 3) * 3 + 1, 1)
    if grain == "year":
        return date(d.year, 1, 1)
    if grain == "week":
        return d - timedelta(days=d.weekday())
    return d


def _label(d: date, grain: str) -> str:
    if grain == "year":
        return str(d.year)
    if grain == "quarter":
        return f"Q{(d.month - 1) // 3 + 1} {d.year}"
    if grain == "month":
        return f"{MONTHS[d.month - 1]} {d.year}"
    return f"{d.day} {MONTHS[d.month - 1]} {d.year}"


def span_text(a: date, b: date) -> str:
    """'2026', '2027 – 2036', 'Jan – Jun 2027', 'Nov 2026 – Oct 2027', '13 – 19 Oct 2026'."""
    if a.day == 1 and b == _month_end(b.year, b.month):
        if a.month == 1 and b.month == 12:
            return str(a.year) if a.year == b.year else f"{a.year} – {b.year}"
        if a.year == b.year:
            return f"{MONTHS[a.month - 1]} {a.year}" if a.month == b.month else f"{MONTHS[a.month - 1]} – {MONTHS[b.month - 1]} {a.year}"
        return f"{MONTHS[a.month - 1]} {a.year} – {MONTHS[b.month - 1]} {b.year}"
    if a == b:
        return f"{a.day} {MONTHS[a.month - 1]} {a.year}"
    return f"{a.day} {MONTHS[a.month - 1]} {a.year} – {b.day} {MONTHS[b.month - 1]} {b.year}"


def _infer_grain(dates: list[date]) -> str:
    u = sorted(set(dates))
    if len(u) < 2:
        return "year" if u and u[0].month == 1 and u[0].day == 1 else "month"
    gaps = sorted((b - a).days for a, b in zip(u, u[1:]))
    g = gaps[len(gaps) // 2]
    if g <= 1:
        return "day"
    if g <= 8:
        return "week"
    if g <= 40:
        return "month"
    if g <= 120:
        return "quarter"
    return "year"


# ---- finding the history in the plan's tables -------------------------------------------------

def _as_dates(col: pd.Series, name: str) -> pd.Series | None:
    """The column as dates, or None. Numbers are never read as dates here (a year column is handled apart)."""
    if pd.api.types.is_datetime64_any_dtype(col):
        d = pd.to_datetime(col, errors="coerce")
    elif pd.api.types.is_numeric_dtype(col) or pd.api.types.is_bool_dtype(col):
        return None
    else:
        s = col.astype(str).str.strip()
        q = s.str.extract(r"^(\d{4})\s*-?\s*[Qq]([1-4])$")
        q2 = s.str.extract(r"^[Qq]([1-4])\s*-?\s*(\d{4})$")
        if len(s) and q.notna().all(axis=None):
            d = pd.to_datetime(q[0] + "-" + ((q[1].astype(int) - 1) * 3 + 1).astype(str).str.zfill(2) + "-01", errors="coerce")
        elif len(s) and q2.notna().all(axis=None):
            d = pd.to_datetime(q2[1] + "-" + ((q2[0].astype(int) - 1) * 3 + 1).astype(str).str.zfill(2) + "-01", errors="coerce")
        elif s.str.match(r"^\d{4}-\d{1,2}(-\d{1,2})?([ T].*)?$").all() or _TIME_NAME.search(name):
            with pd.option_context("mode.chained_assignment", None):
                try:
                    d = pd.to_datetime(s, errors="coerce", format="mixed")
                except (TypeError, ValueError):
                    d = pd.to_datetime(s, errors="coerce")
        else:
            return None
    try:
        d = d.dt.tz_localize(None) if getattr(d.dt, "tz", None) is not None else d
    except (AttributeError, TypeError):
        pass
    if not len(d) or d.isna().mean() > 0.1:
        return None
    return d


def _year_values(col: pd.Series) -> pd.Series | None:
    v = pd.to_numeric(col, errors="coerce")
    if v.isna().any() or not len(v):
        return None
    if not ((v >= 1900) & (v <= 2100) & (v == v.round())).all():
        return None
    return v.astype(int)


def _month_values(col: pd.Series) -> pd.Series | None:
    if pd.api.types.is_numeric_dtype(col):
        v = pd.to_numeric(col, errors="coerce")
        if v.isna().any() or not ((v >= 1) & (v <= 12) & (v == v.round())).all():
            return None
        return v.astype(int)
    m = col.astype(str).str.strip().str.lower().map(lambda x: _MON_POS.get(x) or _MON_POS.get(x[:3]))
    return None if m.isna().any() else m.astype(int)


def _time_of(df: pd.DataFrame, prefer: str | None) -> tuple[pd.Series, list[str]] | None:
    """(the date of every row, the columns that made it)."""
    cols = list(df.columns)
    order = ([prefer] if prefer in cols else []) + [c for c in cols if c != prefer]
    year_c = next((c for c in cols if _YEAR_NAME.search(str(c)) and _year_values(df[c]) is not None), None)
    month_c = next((c for c in cols if c != year_c and _MONTH_NAME.search(str(c)) and _month_values(df[c]) is not None), None)
    quarter_c = next((c for c in cols if c != year_c and _QUARTER_NAME.search(str(c))), None)
    if year_c and month_c:
        y, m = _year_values(df[year_c]), _month_values(df[month_c])
        return pd.to_datetime({"year": y, "month": m, "day": 1}), [year_c, month_c]
    for c in order:
        if c in (year_c,):
            continue
        d = _as_dates(df[c], str(c))
        if d is not None:
            return d, [c]
    if year_c and quarter_c:
        q = pd.to_numeric(df[quarter_c].astype(str).str.extract(r"([1-4])")[0], errors="coerce")
        if q.notna().all():
            return pd.to_datetime({"year": _year_values(df[year_c]), "month": (q.astype(int) - 1) * 3 + 1, "day": 1}), [year_c, quarter_c]
    if year_c:
        return pd.to_datetime({"year": _year_values(df[year_c]), "month": 1, "day": 1}), [year_c]
    return None


def _value_col(df: pd.DataFrame, used: list[str], prefer: list[str], hint: str) -> str | None:
    nums = [c for c in df.columns if c not in used and pd.api.types.is_numeric_dtype(df[c])
            and not pd.api.types.is_bool_dtype(df[c]) and not _ID_NAME.search(str(c))]
    if not nums:
        return None
    low = {str(c).lower(): c for c in nums}
    for p in prefer:
        if str(p).lower() in low:
            return low[str(p).lower()]
    words = set(re.findall(r"[a-z]+", (hint or "").lower())) - {"total", "the", "of", "in", "and"}
    scored = sorted(nums, key=lambda c: (-len(words & set(re.findall(r"[a-z]+", str(c).lower()))),
                                         bool(_MEAN_NAME.search(str(c))), nums.index(c)))
    return scored[0]


def find_series(spec: dict, tables: dict, hint: str = "") -> dict | None:
    """The history to forecast: the analysis table when it holds one, else the plan's longest dated table."""
    first = spec.get("table")
    names = ([first] if first in tables else []) + [k for k in reversed(list(tables)) if k != first]
    best = None
    for name in names:
        df = tables.get(name)
        if df is None or len(df) < 2:
            continue
        prefer_t = spec.get("time_column") if name == first else None
        prefer_v = list(spec.get("value_columns") or []) + ([spec["value_column"]] if spec.get("value_column") else []) \
            if name == first else []
        got = _time_of(df, prefer_t)
        if not got:
            continue
        when, tcols = got
        vcol = _value_col(df, tcols, prefer_v, hint or spec.get("metric_name") or "")
        if not vcol:
            continue
        work = pd.DataFrame({"t": when, "v": pd.to_numeric(df[vcol], errors="coerce")}).dropna()
        if work.empty:
            continue
        dates = [x.date() for x in work["t"]]
        grain = _infer_grain(dates)
        additive = not _MEAN_NAME.search(str(vcol)) and (spec.get("format") not in ("percent", "ratio") or name != first)
        work["b"] = [_bucket(d, grain) for d in dates]
        agg = work.groupby("b")["v"].sum() if additive else work.groupby("b")["v"].mean()
        cand = {"table": name, "time_columns": tcols, "value_column": str(vcol), "grain": grain, "additive": additive,
                "dates": list(agg.index), "values": [float(x) for x in agg.values], "n": len(agg),
                "first_day": min(dates), "last_day": max(dates)}
        if name == first and cand["n"] >= MIN_POINTS:
            return cand
        if best is None or cand["n"] > best["n"]:
            best = cand
    return best


def _regrain(series: dict, grain: str) -> dict:
    """Days or weeks summed (or averaged) into months, partial months at either end noted."""
    by: dict[date, list[float]] = {}
    for d, v in zip(series["dates"], series["values"]):
        by.setdefault(_bucket(d, grain), []).append(v)
    keys = sorted(by)
    vals = [float(np.sum(by[k]) if series["additive"] else np.mean(by[k])) for k in keys]
    out = dict(series, grain=grain, dates=keys, values=vals, n=len(keys))
    first_d, last_d = series["first_day"], series["last_day"]
    partial = {"first": None, "last": None}
    if keys and series["grain"] == "day":
        if first_d > keys[0]:
            partial["first"] = {"period": keys[0].isoformat()}
        if last_d < fc.period_end(keys[-1], grain):
            partial["last"] = {"period": keys[-1].isoformat(), "through": last_d.isoformat()}
    out["partial"] = partial
    out["regrained_from"] = series["grain"]
    return out


# ---- what is asked ---------------------------------------------------------------------------

def wanted(question: str, brief: dict | None, today: date) -> dict | None:
    """{"target": {start, end, label} | None} when the question looks ahead, else None."""
    from .. import question_check as qc
    brief = brief or {}
    p = brief.get("period") if isinstance(brief.get("period"), dict) else None
    looks_ahead = qc.wants_forecast(question or "")
    if p and p.get("parts"):
        fut = [x for x in p["parts"] if isinstance(x, dict) and (x.get("future") or x.get("forecast"))]
        if fut:
            return {"target": fut[-1], "explicit": True}
        p = None if looks_ahead else p
    if p and p.get("start") and p.get("end") and (p.get("forecast") or p.get("future") or brief.get("forecast")):
        return {"target": p, "explicit": True}
    if p and p.get("start") and not looks_ahead:
        return None
    parsed, _ = qc.parse_period(question or "", today)
    if parsed and parsed.get("parts"):
        fut = [x for x in parsed["parts"] if x.get("future")]
        parsed = qc.forecast_span(fut[-1], today) if fut else None
    if looks_ahead:
        if parsed:
            return {"target": qc.forecast_span(parsed, today), "explicit": True}
        if p and p.get("start"):
            return {"target": p, "explicit": True}
        return {"target": None, "explicit": False}
    if parsed and parsed.get("future"):
        return {"target": parsed, "explicit": True}
    return None


# ---- the models ------------------------------------------------------------------------------

def _trend_projection(y: np.ndarray, h: int, lo_b: float | None, hi_b: float | None) -> list[dict]:
    """Least-squares line with its prediction interval - used when the smoother refuses."""
    n = len(y)
    x = np.arange(n, dtype=float)
    use_log = bool(np.all(y > 0))
    z = np.log(y) if use_log else y
    xm = x.mean()
    sxx = float(((x - xm) ** 2).sum()) or 1.0
    b = float(((x - xm) * (z - z.mean())).sum() / sxx)
    a = float(z.mean() - b * xm)
    resid = z - (a + b * x)
    dof = max(1, n - 2)
    s = float(math.sqrt((resid ** 2).sum() / dof)) if n > 2 else float(abs(z).mean() * 0.1 or 1.0)
    small = math.sqrt(n / max(1, n - 2)) if n < 12 else 1.0  # few points: a t-like widening
    out = []
    for k in range(1, h + 1):
        xh = n - 1 + k
        mu = a + b * xh
        se = s * small * math.sqrt(1 + 1 / n + (xh - xm) ** 2 / sxx)
        pt = {}
        for name, zq in (("80", Z80), ("95", Z95)):
            lo, hi = mu - zq * se, mu + zq * se
            if use_log:
                lo, hi = math.exp(lo), math.exp(hi)
            pt[f"lo{name}"], pt[f"hi{name}"] = _clip(lo, lo_b, hi_b), _clip(hi, lo_b, hi_b)
        v = _clip(math.exp(mu) if use_log else mu, lo_b, hi_b)
        out.append({"value": v, **pt})
    return out


def _clip(v: float, lo: float | None, hi: float | None) -> float:
    if lo is not None and v < lo:
        v = lo
    if hi is not None and v > hi:
        v = hi
    return float(v)


def _agg_band(points: list[dict], additive: bool, n_total: int) -> dict:
    """The band of a sum (or mean) of forecast buckets."""
    out = {}
    model = [p for p in points if p.get("source") != "long"]
    long = [p for p in points if p.get("source") == "long"]
    for name in ("80", "95"):
        def part(ps: list[dict], side: str) -> float:
            d = np.array([max(0.0, (p["value"] - p.get(f"lo{name}", p["value"])) if side == "lo"
                              else (p.get(f"hi{name}", p["value"]) - p["value"])) for p in ps])
            return float(0.5 * (d.sum() + math.sqrt(float((d ** 2).sum())))) if len(d) else 0.0
        # long-range months are one yearly figure split by the seasonal shape: fully correlated, so they add up
        lo = part(model, "lo") + sum(max(0.0, p["value"] - p.get(f"lo{name}", p["value"])) for p in long)
        hi = part(model, "hi") + sum(max(0.0, p.get(f"hi{name}", p["value"]) - p["value"]) for p in long)
        if not additive and n_total:
            lo, hi = lo / n_total, hi / n_total
        out[f"dlo{name}"], out[f"dhi{name}"] = float(lo), float(hi)
    return out


def forecast(series: dict, target: dict | None, today: date) -> dict:
    """The forecast through the end of `target` (or the next 12 months / next year).
    Returns {"status": "ok" | "refused" | "covered", ...} - see attach() for how it is used."""
    grain = series["grain"]
    last_day = series["last_day"]
    # anything more than a quarter ahead is read in months, not days or weeks
    t_end = date.fromisoformat(target["end"]) if target else None
    if grain in ("day", "week") and (t_end is None or (t_end - last_day).days > (90 if grain == "day" else 182)
                                     or (target and (date.fromisoformat(target["end"]) - date.fromisoformat(target["start"])).days >= 60)):
        series = _regrain(series, "month")
        grain = "month"
    dates, values = list(series["dates"]), list(series["values"])
    additive = series["additive"]
    if len(dates) < MIN_POINTS:
        return {"status": "refused", "reason": f"Only {len(dates)} {fc.grain_word(grain, len(dates))} of history - a forecast needs "
                f"at least {MIN_POINTS}.", "grain": grain}
    # partial buckets: from the daily data when there was some, else the bucket holding today
    partial = series.get("partial") or fc.partial_periods([d.isoformat() for d in dates], grain, None, today)
    excluded = {(partial.get(k) or {}).get("period") for k in ("first", "last")} - {None}
    complete = [(d, v) for d, v in zip(dates, values) if d.isoformat() not in excluded]
    if len(complete) < MIN_POINTS:
        return {"status": "refused", "reason": f"Only {len(complete)} complete {fc.grain_word(grain, len(complete))} of history - "
                f"a forecast needs at least {MIN_POINTS}.", "grain": grain}
    last_full = complete[-1][0]
    # default target: the next calendar year when the data ends with one, else the next 12 months
    if target is None:
        nb = fc.next_period(last_full, grain)
        if grain == "year":
            a = nb
            b = date(nb.year, 12, 31)
        elif nb.month == 1 and grain in ("month", "quarter"):
            a, b = date(nb.year, 1, 1), date(nb.year, 12, 31)
        else:
            a = date(nb.year, nb.month, 1)
            b = fc.period_end(fc.next_period(a, "month", 11), "month")
        target = {"start": a.isoformat(), "end": b.isoformat(),
                  "label": str(a.year) if (a.month == 1 and b.month == 12 and a.year == b.year) else "the next 12 months",
                  "text": span_text(a, b), "default": True}
    ts, te = date.fromisoformat(target["start"]), date.fromisoformat(target["end"])
    if te.year - last_full.year > MAX_YEARS_AHEAD:
        te = date(last_full.year + MAX_YEARS_AHEAD, 12, 31)
    if te <= fc.period_end(last_full, grain):
        return {"status": "covered", "grain": grain}
    # how many buckets to forecast: through the bucket holding the target's end
    end_bucket = _bucket(te, grain)
    h_need, cur = 0, last_full
    while cur < end_bucket and h_need < 5000:
        cur = fc.next_period(cur, grain)
        h_need += 1

    y = np.array([v for _d, v in complete], dtype=float)
    lo_b = 0.0 if float(np.min(y)) >= 0 else None
    hi_b = None
    if not additive and lo_b == 0.0 and float(np.max(y)) <= 1.0 and re.search(r"(rate|ratio|share|pct|conversion|ctr)",
                                                                               series["value_column"], re.I):
        hi_b = 1.0
    notes: list[str] = []
    model = fc.forecast_series([d.isoformat() for d in dates], values, grain, horizon=h_need, interval="both",
                               additive=additive, lower=lo_b, upper=hi_b, partial=partial, want_anomalies=False)
    near: list[dict] = []
    method_key = None
    backtest = None
    if model.get("status") == "ok":
        near = [{"period": p["period"], "value": p["value"], "lo80": p["lo80"], "hi80": p["hi80"], "lo95": p["lo95"],
                 "hi95": p["hi95"]} for p in model["points"]]
        method_key = model.get("method_key")
        backtest = model.get("backtest")
        notes += [n for n in model.get("notes") or [] if "backtest" not in n.lower() or "no error" in n.lower()]
        method = {"hw": "Seasonal exponential smoothing (damped Holt-Winters)", "holt": "Exponential smoothing with a damped trend (Holt)",
                  "snaive": "Seasonal naive - the same period last year", "naive": "Last value"}.get(method_key, model.get("method") or "")
    else:
        cap = min(h_need, fc.MAX_HORIZON.get(grain, 24))
        proj = _trend_projection(y, cap, lo_b, hi_b)
        cur = last_full
        for p in proj:
            cur = fc.next_period(cur, grain)
            near.append({"period": cur.isoformat(), **p})
        method_key = "trend"
        method = "Straight-line trend (least squares)"
        notes.append((model.get("reason") or "The smoothing model could not be used") .rstrip(".")
                     + " - so this is a straight-line trend with a wide range. Treat it as a rough guide.")
    for p in near:
        p["kind"] = "forecast"
        p["source"] = "model"

    hist = [{"period": d.isoformat(), "value": v, "kind": "partial" if d.isoformat() in excluded else "actual"}
            for d, v in zip(dates, values)]
    points = list(near)
    long_from = None
    # ---- long range: past what the model allows, in whole years ----------------------------
    model_end = date.fromisoformat(near[-1]["period"]) if near else last_full
    if model_end < end_bucket:
        ext = _long_range(series, grain, complete, near, end_bucket, additive, lo_b, hi_b, notes)
        if ext.get("status") == "refused":
            return ext | {"grain": grain}
        points = ext["points"]
        long_from = ext["from_year"]
    years = _yearly(grain, hist, points, additive)
    out = {
        "status": "ok", "grain": grain, "regrained_from": series.get("regrained_from"), "target": target,
        "target_start": ts.isoformat(), "target_end": te.isoformat(), "history": hist, "points": points, "years": years,
        "method_key": method_key, "method": method, "backtest": backtest, "notes": notes, "long_range_from": long_from,
        "last_full": last_full.isoformat(), "first": dates[0].isoformat(), "additive": additive,
        "table": series["table"], "value_column": series["value_column"], "history_points": len(complete),
    }
    return out


def _long_range(series: dict, grain: str, complete: list, near: list[dict], end_bucket: date, additive: bool,
                lo_b, hi_b, notes: list[str]) -> dict:
    """Whole years past the model's horizon: damped yearly growth, widening band, the history's seasonal shape."""
    ppy = PPY[grain]
    # full actual years
    by_year: dict[int, list[tuple[date, float]]] = {}
    for d, v in complete:
        by_year.setdefault(d.year, []).append((d, v))
    full = {yr: rows for yr, rows in by_year.items() if len(rows) == ppy}
    agg = (lambda vs: float(np.sum(vs))) if additive else (lambda vs: float(np.mean(vs)))
    annual = sorted((yr, agg([v for _d, v in rows])) for yr, rows in full.items())
    # the model's years that it covers completely
    near_by_year: dict[int, list[dict]] = {}
    for p in near:
        d = date.fromisoformat(p["period"])
        near_by_year.setdefault(d.year, []).append(p)
    base_year, base_val, s0 = None, None, 0.0
    for yr in sorted(near_by_year):
        rows = near_by_year[yr]
        have_actual = [v for d, v in complete if d.year == yr]
        if len(rows) + len(have_actual) == ppy:
            val = agg([p["value"] for p in rows] + have_actual)
            band = _agg_band(rows, additive, ppy)
            if val > 0:
                s0 = max(0.0, (math.log(val + band["dhi80"]) - math.log(max(1e-12, val - band["dlo80"]))) / (2 * Z80)) \
                    if val - band["dlo80"] > 0 else band["dhi80"] / val / Z80
            base_year, base_val = yr, val
    if base_year is None:
        if annual:
            base_year, base_val, s0 = annual[-1][0], annual[-1][1], 0.0
        else:
            # not one full year of anything: a yearly figure from the last 12 months of the trend
            if not near:
                return {"status": "refused", "reason": "Not enough history to look that far ahead."}
            last = date.fromisoformat(near[-1]["period"])
            tail = [p["value"] for p in near[-ppy:]]
            base_year, s0 = last.year, 0.1
            base_val = float(np.mean(tail)) * (ppy if additive else 1)
    # yearly growth from the history (log CAGR); its noise from year-to-year changes
    vals = [v for _y, v in annual]
    positive = all(v > 0 for v in vals) and (base_val or 0) > 0
    n_g = 0
    if len(vals) >= 2 and positive:
        lg = np.diff(np.log(vals))
        g0 = float(lg.mean())
        n_g = len(lg)
        sigma = max(SIGMA_FLOOR if n_g >= 3 else SIGMA_FLOOR_SHORT, float(lg.std(ddof=1)) if n_g >= 2 else 0.0)
        mode = "log"
    elif len(vals) >= 2:
        dv = np.diff(vals)
        g0 = float(dv.mean())
        n_g = len(dv)
        scale = float(np.mean(np.abs(vals))) or 1.0
        sigma = max(SIGMA_FLOOR_SHORT * scale, float(dv.std(ddof=1)) if n_g >= 2 else 0.0)
        mode = "level"
    else:
        # under two full years: the slope of the buckets themselves, per year
        y = np.array([v for _d, v in complete], dtype=float)
        x = np.arange(len(y), dtype=float)
        if np.all(y > 0):
            b = float(np.polyfit(x, np.log(y), 1)[0])
            g0, mode = b * ppy, "log"
            sigma = SIGMA_FLOOR_SHORT * 1.5
        else:
            b = float(np.polyfit(x, y, 1)[0])
            g0, mode = b * ppy * (ppy if additive else 1), "level"
            sigma = SIGMA_FLOOR_SHORT * 1.5 * (float(np.mean(np.abs(y))) * (ppy if additive else 1) or 1.0)
        n_g = 1
    se_g = sigma / math.sqrt(max(1, n_g))
    last_actual_year = annual[-1][0] if annual else complete[-1][0].year
    # seasonal shape of a year (share of the year's total, or ratio to its mean)
    shape = np.ones(ppy) / ppy if additive else np.ones(ppy)
    if ppy > 1 and full:
        rows_ = []
        for _yr, rows in full.items():
            v = np.array([x for _d, x in sorted(rows)], dtype=float)
            tot = v.sum() if additive else v.mean()
            if tot > 0 and np.all(v >= 0):
                rows_.append(v / tot)
        if rows_:
            shape = np.mean(rows_, axis=0)
            shape = shape / shape.sum() if additive else shape / shape.mean()
    points = [p for p in near if date.fromisoformat(p["period"]).year <= base_year]
    level = math.log(base_val) if mode == "log" else base_val
    var_walk, g_cum, j = 0.0, 0.0, 0
    for yr in range(base_year + 1, end_bucket.year + 1):
        j += 1
        damp = PHI ** max(0, yr - last_actual_year - 1)
        level += g0 * damp
        g_cum += damp
        var_walk += sigma ** 2
        s0_term = (s0 * base_val) ** 2 if mode == "level" else s0 ** 2
        sd = math.sqrt(s0_term + var_walk + (se_g * g_cum) ** 2)
        if mode == "log":
            val = math.exp(level)
            band = {f"lo{n}": math.exp(level - z * sd) for n, z in (("80", Z80), ("95", Z95))} | \
                   {f"hi{n}": math.exp(level + z * sd) for n, z in (("80", Z80), ("95", Z95))}
        else:
            val = level
            band = {f"lo{n}": level - z * sd for n, z in (("80", Z80), ("95", Z95))} | \
                   {f"hi{n}": level + z * sd for n, z in (("80", Z80), ("95", Z95))}
        start = date(yr, 1, 1)
        cur = _bucket(start, grain)
        k = 0
        while cur.year == yr and cur <= end_bucket and k < ppy:
            w = float(shape[k]) if ppy > 1 else 1.0
            pt = {"period": cur.isoformat(), "value": _clip(val * w, lo_b, hi_b), "kind": "forecast", "source": "long"}
            for key, bv in band.items():
                pt[key] = _clip(bv * w, lo_b, hi_b)
            points.append(pt)
            cur = fc.next_period(cur, grain)
            k += 1
    notes.append(
        f"From {base_year + 1} the forecast carries the yearly trend on with fading growth (each year keeps 90% of the "
        "previous year's growth), and its range widens every year - a long-range projection, not a prediction.")
    if end_bucket.year - last_actual_year > max(1, len(vals)):
        notes.append(f"This looks {end_bucket.year - last_actual_year} years ahead from {len(vals) or 'less than one'} full "
                     f"year{'s' if len(vals) != 1 else ''} of history - read the later years as a scenario, not a plan.")
    return {"status": "ok", "points": points, "from_year": base_year + 1}


def _yearly(grain: str, hist: list[dict], points: list[dict], additive: bool) -> list[dict]:
    """One row per calendar year: actual, forecast, or mixed (actual months + forecast months)."""
    ppy = PPY[grain]
    years: dict[int, dict] = {}
    for h in hist:
        if h["kind"] == "partial":
            continue
        d = date.fromisoformat(h["period"])
        years.setdefault(d.year, {"actual": [], "forecast": []})["actual"].append(h)
    for p in points:
        d = date.fromisoformat(p["period"])
        years.setdefault(d.year, {"actual": [], "forecast": []})["forecast"].append(p)
    out = []
    for yr in sorted(years):
        a, f = years[yr]["actual"], years[yr]["forecast"]
        n = len(a) + len(f)
        if grain != "year" and n < ppy:
            if not f:
                out.append({"period": str(yr), "kind": "partial_actual", "value": None, "count": n})
            continue
        vals = [x["value"] for x in a] + [x["value"] for x in f]
        val = float(np.sum(vals)) if additive else float(np.mean(vals))
        row = {"period": str(yr), "value": val, "kind": "actual" if not f else ("forecast" if not a else "mixed")}
        if f:
            band = _agg_band(f, additive, n)
            for name in ("80", "95"):
                row[f"lo{name}"] = val - band[f"dlo{name}"]
                row[f"hi{name}"] = val + band[f"dhi{name}"]
            row["actual_part"] = (float(np.sum([x["value"] for x in a])) if additive else None) if a else None
            row["long_range"] = any(x.get("source") == "long" for x in f)
        out.append(row)
    return [r for r in out if r["kind"] != "partial_actual"]


# ---- into the answer -----------------------------------------------------------------------

def _range_display(lo: float, hi: float, kind: str, currency: str | None) -> str:
    return f"{fmt(lo, kind, currency)} – {fmt(hi, kind, currency)}"


def attach(analysis: dict, plan: dict, tables: dict, question: str, today: date | None = None) -> dict | None:
    """When the question looks ahead: the forecast as facts, a summary, a visual and notes - added to
    `analysis` in place (its type becomes "forecast"). Returns what was done, or None."""
    today = today or date.today()
    want = wanted(question, plan.get("brief"), today)
    if not want:
        return None
    spec = dict(plan.get("analysis") or {})
    from . import present
    hint = spec.get("metric_name") or ""
    series = find_series(spec, tables, hint)
    kind = spec.get("format") if spec.get("format") in ("currency", "number", "integer", "percent", "ratio") else "number"
    currency = spec.get("currency") or "USD"
    target = want.get("target")
    if not series:
        msg = ("I couldn't find a dated history in the results to forecast from - ask for the metric by month "
               "(for example 'monthly sales, all dates') and I'll forecast from that.")
        analysis.setdefault("summary", {})["forecast"] = {"status": "refused", "reason": msg}
        return {"status": "refused", "reason": msg}
    if kind == "number":
        kind = present.column_kind(series["value_column"], series["values"], "number")
        if kind == "currency" and not spec.get("currency"):
            currency = "USD"
    metric = spec.get("metric_name") or present.humanize(series["value_column"])
    res = forecast(series, target, today)
    if res["status"] == "covered":
        return None  # the data already has that period - the history answers it
    if res["status"] != "ok":
        analysis.setdefault("summary", {})["forecast"] = {"status": "refused", "reason": res["reason"]}
        analysis.setdefault("warnings", []).append(res["reason"])
        return res
    _write(analysis, res, metric, kind, currency, target, question)
    try:
        _by_dimension(analysis, spec, tables, series, res, metric, kind, currency, question, today)
    except Exception as e:  # noqa: BLE001 - a per-segment forecast never fails the answer
        print(f"[forecasting] per-segment forecast skipped: {e}")
    return res


def _sum_period(res: dict, a: date, b: date) -> dict | None:
    """Actual + forecast over [a, b], with the forecast part's band."""
    grain = res["grain"]
    acts = [h for h in res["history"] if h["kind"] == "actual" and a <= date.fromisoformat(h["period"]) <= b]
    fcs = [p for p in res["points"] if a <= date.fromisoformat(p["period"]) <= b]
    if not fcs:
        return None
    n = len(acts) + len(fcs)
    vals = [x["value"] for x in acts] + [x["value"] for x in fcs]
    val = float(np.sum(vals)) if res["additive"] else float(np.mean(vals))
    band = _agg_band(fcs, res["additive"], n)
    return {"value": val, "lo80": val - band["dlo80"], "hi80": val + band["dhi80"], "lo95": val - band["dlo95"],
            "hi95": val + band["dhi95"], "actual_buckets": len(acts), "forecast_buckets": len(fcs),
            "long_range": any(p.get("source") == "long" for p in fcs), "grain": grain}


def _actual_period(res: dict, a: date, b: date, grain: str) -> float | None:
    acts = [h for h in res["history"] if h["kind"] == "actual" and a <= date.fromisoformat(h["period"]) <= b]
    want = 0
    cur = _bucket(a, grain)
    while cur <= b and want < 5000:
        want += 1
        cur = fc.next_period(cur, grain)
    if not acts or len(acts) < want:
        return None
    vals = [x["value"] for x in acts]
    return float(np.sum(vals)) if res["additive"] else float(np.mean(vals))


BY_PERIOD = re.compile(r"\b(?:by|per|each|every|for\s+each)\s+(?:the\s+)?(month|quarter|week)s?\b|\b(monthly|quarterly|weekly)\b|"
                       r"\bmonth[\s-]+(?:by|on)[\s-]+month\b", re.I)
DRIVERS_ASKED = re.compile(r"\b(drive|drives|driving|driven|driver|drivers|why|because|reason|reasons|behind|factor|factors|"
                           r"contribut\w*|explain\w*|cause[sd]?)\b", re.I)


def _write(analysis: dict, res: dict, metric: str, kind: str, currency: str | None, asked: dict | None,
           question: str = "") -> None:
    facts = analysis.setdefault("facts", [])
    cur = currency if kind == "currency" else None

    def add(label: str, value, k: str | None = None, signed: bool = False) -> dict:
        f = {"id": f"f{len(facts) + 1}", "label": label, "value": float(value) if value is not None else None,
             "kind": k or kind, "display": fmt(value, k or kind, cur, signed=signed), "table": res["table"]}
        facts.append(f)
        return f

    grain = res["grain"]
    target = res["target"]
    ts, te = date.fromisoformat(res["target_start"]), date.fromisoformat(res["target_end"])
    multi_year = te.year > ts.year and ts.month == 1 and ts.day == 1 and te.month == 12 and te.day == 31
    label = target.get("text") or span_text(ts, te)
    if target.get("label") and str(target.get("label")).startswith("the next"):
        label = f"{target['label']} ({span_text(ts, te)})"
    years = res["years"]
    actual_years = [r for r in years if r["kind"] == "actual"]
    last_actual = actual_years[-1] if actual_years else None
    ids: dict[str, str] = {}
    head_label = label
    if multi_year:
        final = next((r for r in years if r["period"] == str(te.year)), None)
        whole = _sum_period(res, ts, te)
        main = final or whole
        head_label = str(te.year)
        f_main = add(f"Forecast {metric}, {te.year}", main["value"])
        ids["main"] = f_main["id"]
        f_lo = add(f"Forecast {metric}, {te.year}: likely range low (80%)", main["lo80"])
        f_hi = add(f"Forecast {metric}, {te.year}: likely range high (80%)", main["hi80"])
        add(f"Forecast {metric}, {te.year}: wide range low (95%)", main["lo95"])
        add(f"Forecast {metric}, {te.year}: wide range high (95%)", main["hi95"])
        ids["lo"], ids["hi"] = f_lo["id"], f_hi["id"]
        if whole and res["additive"]:
            ids["total"] = add(f"Total forecast {metric}, {span_text(ts, te)}", whole["value"])["id"]
        for r in [r for r in years if r["kind"] != "actual" and ts.year <= int(r["period"]) <= te.year][:12]:
            if r["period"] != str(te.year):
                add(f"Forecast {metric}, {r['period']}", r["value"])
        main_v = main["value"]
        main_band = main
    else:
        whole = _sum_period(res, ts, te)
        if not whole:
            analysis.setdefault("summary", {})["forecast"] = {"status": "refused", "reason": "Nothing to forecast in that period."}
            return
        f_main = add(f"Forecast {metric}, {label}", whole["value"])
        ids["main"] = f_main["id"]
        ids["lo"] = add(f"Forecast {metric}, {label}: likely range low (80%)", whole["lo80"])["id"]
        ids["hi"] = add(f"Forecast {metric}, {label}: likely range high (80%)", whole["hi80"])["id"]
        add(f"Forecast {metric}, {label}: wide range low (95%)", whole["lo95"])
        add(f"Forecast {metric}, {label}: wide range high (95%)", whole["hi95"])
        if whole["actual_buckets"]:
            act = [h for h in res["history"] if h["kind"] == "actual" and ts <= date.fromisoformat(h["period"]) <= te]
            v = float(np.sum([h["value"] for h in act])) if res["additive"] else None
            if v is not None:
                ids["so_far"] = add(f"Actual {metric} already in the data for {label} ({len(act)} "
                                    f"{fc.grain_word(grain, len(act))})", v)["id"]
        main_v = whole["value"]
        main_band = whole
    # compared with the same period a year earlier, when the data has all of it
    vs = None
    try:
        pa, pb = date(ts.year - 1, ts.month, ts.day), date(te.year - 1, te.month, min(te.day, 28) if te.month == 2 else te.day)
    except ValueError:
        pa = pb = None
    if multi_year and last_actual:
        prev_v, prev_label = last_actual["value"], last_actual["period"]
    elif pa:
        prev_v, prev_label = _actual_period(res, pa, pb, grain), span_text(pa, pb)
    else:
        prev_v, prev_label = None, None
    if prev_v is None and last_actual and not multi_year and ts.month == 1 and te.month == 12 and ts.year == te.year:
        prev_v, prev_label = last_actual["value"], last_actual["period"]
    if prev_v is not None:
        ids["prev"] = add(f"Actual {metric}, {prev_label}", prev_v)["id"]
        pc = pct_change(main_v, prev_v)
        if pc is not None:
            ids["pct"] = add(f"Forecast change in {metric}: {prev_label} to {head_label} (%)", pc, "percent", signed=True)["id"]
            vs = {"label": prev_label, "value": prev_v, "pct": pc}
        years_apart = (int(head_label) - int(prev_label)) if head_label.isdigit() and str(prev_label).isdigit() else 0
        if years_apart >= 2 and prev_v > 0 and main_v > 0:
            cagr = ((main_v / prev_v) ** (1 / years_apart) - 1) * 100
            ids["cagr_ahead"] = add(f"Implied yearly growth in {metric}, {prev_label} to {head_label} (%)", cagr, "percent", signed=True)["id"]
    # the history's own yearly growth
    hist_growth = None
    if len(actual_years) >= 2 and actual_years[0]["value"] > 0 and actual_years[-1]["value"] > 0:
        n = int(actual_years[-1]["period"]) - int(actual_years[0]["period"])
        if n >= 1:
            hist_growth = ((actual_years[-1]["value"] / actual_years[0]["value"]) ** (1 / n) - 1) * 100
            ids["cagr_hist"] = add(f"Average yearly growth in {metric}, {actual_years[0]['period']}–{actual_years[-1]['period']} (%)",
                                   hist_growth, "percent", signed=True)["id"]
    bt = res.get("backtest") or {}
    if bt.get("mape") is not None:
        ids["mape"] = add(f"Forecast model's typical error when tested on past {fc.grain_word(grain, 2)} (%)",
                          bt["mape"] * 100, "percent")["id"]

    # round 33: the asked period month by month (peak, low; every month when asked "by month") and
    # how concentrated it is - so "Forecast 2026 by month" is answered in words, not only on the chart
    tgt_pts = [p for p in res["points"] if ts <= date.fromisoformat(p["period"]) <= te]
    by_period: list[dict] = []
    peak_label = low_label = None
    wants_periods = bool(BY_PERIOD.search(question or ""))
    if grain in ("month", "quarter", "week") and 3 <= len(tgt_pts) and not multi_year:
        pk = max(tgt_pts, key=lambda p: p["value"])
        lw = min(tgt_pts, key=lambda p: p["value"])
        peak_label, low_label = _label(date.fromisoformat(pk["period"]), grain), _label(date.fromisoformat(lw["period"]), grain)
        ids["peak"] = add(f"Highest forecast {grain}: {peak_label}", pk["value"])["id"]
        ids["low"] = add(f"Lowest forecast {grain}: {low_label}", lw["value"])["id"]
        if res["additive"] and main_v > 0 and len(tgt_pts) >= 6 and DRIVERS_ASKED.search(question or ""):
            top2 = sorted(tgt_pts, key=lambda p: -p["value"])[:2]
            names = " and ".join(_label(date.fromisoformat(p["period"]), grain).split(" ")[0] for p in
                                 sorted(top2, key=lambda p: p["period"]))
            ids["top2"] = add(f"Share of the {label} forecast in {names} (%)", sum(p["value"] for p in top2) / main_v * 100,
                              "percent")["id"]
        if wants_periods and len(tgt_pts) <= 24:
            for p in tgt_pts:
                pl = _label(date.fromisoformat(p["period"]), grain)
                f = add(f"Forecast {metric}, {pl}", p["value"])
                by_period.append({"label": pl, "fact_id": f["id"]})

    hist_start, hist_end = date.fromisoformat(res["first"]), date.fromisoformat(res["last_full"])
    history_text = (f"{res['history_points']} {fc.grain_word(grain, res['history_points'])} of history, "
                    f"{span_text(hist_start, fc.period_end(hist_end, grain))}")
    if res.get("regrained_from") in ("day", "week"):
        history_text += f" ({res['regrained_from']}ly figures added up into months)"
    sure = "long-range" if main_band.get("long_range") or (multi_year and res.get("long_range_from")
                                                             and te.year >= res["long_range_from"]) else (
        "tested" if bt.get("mape") is not None else "rough" if res["method_key"] == "trend" else "untested")
    summary = {
        "status": "ok", "metric": metric, "target": head_label if multi_year else label, "asked": label,
        "multi_year": multi_year, "method": res["method"], "history": history_text, "certainty": sure,
        "long_range_from": res.get("long_range_from"), "fact_ids": ids, "notes": res["notes"][:4],
        "vs": vs and {"label": vs["label"], "pct": vs["pct"]}, "history_growth_pct": hist_growth,
        "peak_label": peak_label, "low_label": low_label, "by_period": by_period,
        # the backtest scores months (or the series' own grain), never the yearly total
        "error_grain": grain,
    }
    analysis.setdefault("summary", {})["forecast"] = summary
    analysis["type"] = "forecast"
    by_id = {f["id"]: f for f in facts}
    summary["kpis"] = _kpis(by_id, ids, metric, head_label if multi_year else label, vs, sure)

    # ---- the visual: history + forecast with its bands; yearly rows double as the table ----
    rows = []
    for r in res["years"]:
        rows.append({"year": r["period"], "actual": r["value"] if r["kind"] == "actual" else (r.get("actual_part") if r["kind"] == "mixed" else None),
                     "forecast": r["value"] if r["kind"] != "actual" else None,
                     "low_80": r.get("lo80"), "high_80": r.get("hi80"), "low_95": r.get("lo95"), "high_95": r.get("hi95")})
    hist_pts = [h for h in res["history"]][-HISTORY_SHOWN:]
    visual = {
        "type": "forecast", "title": f"{metric}: forecast for {head_label if multi_year else label}",
        "metric": metric, "format": kind, "currency": cur, "grain": grain,
        "target": {"label": label, "start": ts.isoformat(), "end": te.isoformat(), "multi_year": multi_year,
                   "headline_label": head_label},
        "headline": {"label": head_label if multi_year else label, "value": main_v, "lo80": main_band["lo80"],
                     "hi80": main_band["hi80"], "lo95": main_band["lo95"], "hi95": main_band["hi95"],
                     "display": by_id[ids["main"]]["display"],
                     "range_display": _range_display(main_band["lo80"], main_band["hi80"], kind, cur),
                     "wide_display": _range_display(main_band["lo95"], main_band["hi95"], kind, cur),
                     "vs": vs and {"label": vs["label"], "display": by_id[ids["prev"]]["display"],
                                   "pct_display": by_id[ids["pct"]]["display"] if ids.get("pct") else None, "pct": vs["pct"]},
                     "total_display": by_id[ids["total"]]["display"] if ids.get("total") else None,
                     "cagr_display": by_id[ids["cagr_ahead"]]["display"] if ids.get("cagr_ahead") else None},
        "years": res["years"],
        "points": [{"period": h["period"], "value": h["value"], "kind": h["kind"]} for h in hist_pts] + res["points"],
        # round 33: open on the months when the question asked for them
        "view": "months" if wants_periods and grain != "year" else None,
        "error_grain": grain,
        "method": {"label": res["method"], "history": history_text, "certainty": sure,
                   "mape": (bt.get("mape") * 100) if bt.get("mape") is not None else None,
                   "baseline_mape": ((bt.get("baseline") or {}).get("mape") or 0) * 100 if (bt.get("baseline") or {}).get("mape") is not None else None,
                   "baseline": (bt.get("baseline") or {}).get("method"), "long_range_from": res.get("long_range_from"),
                   "notes": res["notes"][:5]},
        "columns": [{"name": "year", "dtype": "string", "role": "dimension", "label": "Year"},
                    {"name": "actual", "dtype": "number", "role": "measure", "label": f"Actual {metric}", "format": kind},
                    {"name": "forecast", "dtype": "number", "role": "measure", "label": f"Forecast {metric}", "format": kind},
                    {"name": "low_80", "dtype": "number", "role": "measure", "label": "Likely low (80%)", "format": kind},
                    {"name": "high_80", "dtype": "number", "role": "measure", "label": "Likely high (80%)", "format": kind},
                    {"name": "low_95", "dtype": "number", "role": "measure", "label": "Wide low (95%)", "format": kind},
                    {"name": "high_95", "dtype": "number", "role": "measure", "label": "Wide high (95%)", "format": kind}],
        "rows": rows, "tables": [res["table"]],
    }
    visuals = [v for v in analysis.get("visuals") or []
               if not (v.get("type") == "chart" and (v.get("tables") or []) == [res["table"]])]
    analysis["visuals"] = [visual] + visuals
    warn = analysis.setdefault("warnings", [])
    if sure == "long-range":
        warn.append(f"{head_label if multi_year else label} is a long-range projection: the trend carried forward with "
                    "fading growth and a range that widens every year.")


def _kpis(by_id: dict, ids: dict, metric: str, label: str, vs: dict | None, sure: str) -> list[dict]:
    out = []
    m = by_id.get(ids.get("main"))
    if m:
        out.append({"key": "forecast", "label": f"Forecast {metric}, {label}", "display": m["display"], "value": m["value"],
                    "kind": m["kind"], "sources": [], "delta": by_id[ids["pct"]]["display"] if ids.get("pct") else None,
                    "delta_dir": None if not vs else ("down" if vs["pct"] < 0 else "up"),
                    "delta_pct": vs["pct"] if vs else None, "note": f"vs {vs['label']}" if vs else "forecast"})
    lo, hi = by_id.get(ids.get("lo")), by_id.get(ids.get("hi"))
    if lo and hi:
        out.append({"key": "range", "label": "Likely range (80%)", "display": f"{lo['display']} – {hi['display']}",
                    "value": None, "kind": lo["kind"], "sources": [], "note": "8 in 10 outcomes land here"})
    p = by_id.get(ids.get("prev"))
    if p:
        out.append({"key": "prev", "label": p["label"], "display": p["display"], "value": p["value"], "kind": p["kind"],
                    "sources": [], "note": "actual"})
    e = by_id.get(ids.get("mape"))
    if e:
        out.append({"key": "error", "label": "Typical error in testing", "display": f"±{e['display']}", "value": e["value"],
                    "kind": "percent", "sources": [], "note": "on past periods it didn't see"})
    return out


# ---- one forecast per segment (round 33) ------------------------------------------------------

_DIM_ASKED = re.compile(r"\b(?:by|per|for\s+each|each|across|split\s+by|broken\s+down\s+by)\s+((?:[a-z]+\s+){0,2}[a-z]+)", re.I)
MAX_SEGMENTS = 8


def _asked_dimension(question: str, df: pd.DataFrame, skip: list[str]) -> str | None:
    """The text column a "by customer segment" / "per channel" question names, in a dated table."""
    words = set()
    for m in _DIM_ASKED.finditer(question or ""):
        words |= {w.lower().rstrip("s") for w in m.group(1).split() if w.lower() not in ("the", "a", "each", "year", "month",
                                                                                          "quarter", "week", "day")}
    if not words:
        return None
    best, score = None, 0
    for c in df.columns:
        if c in skip or pd.api.types.is_numeric_dtype(df[c]):
            continue
        n = df[c].nunique(dropna=True)
        if not (2 <= n <= 40):
            continue
        cw = {w.rstrip("s") for w in re.findall(r"[a-z]+", str(c).lower())}
        hit = len(cw & words)
        if hit > score:
            best, score = c, hit
    return best


def _by_dimension(analysis: dict, spec: dict, tables: dict, series: dict, total: dict, metric: str, kind: str,
                  currency: str | None, question: str, today: date) -> None:
    if not _DIM_ASKED.search(question or ""):
        return
    target = total["target"]
    ts, te = date.fromisoformat(total["target_start"]), date.fromisoformat(total["target_end"])
    vcol_name = series["value_column"]
    for name, df in tables.items():
        if df is None or len(df) < 6:
            continue
        got = _time_of(df, None)
        if not got:
            continue
        when, tcols = got
        dim = _asked_dimension(question, df, tcols)
        if not dim:
            continue
        vcol = vcol_name if vcol_name in df.columns else _value_col(df, tcols + [dim], [], metric)
        if not vcol:
            continue
        work = df.assign(__t=when)
        totals = work.groupby(dim)[vcol].apply(lambda x: pd.to_numeric(x, errors="coerce").sum()).sort_values(ascending=False)
        items = []
        for seg in list(totals.index)[:MAX_SEGMENTS]:
            sub = work[work[dim] == seg].drop(columns="__t")
            sseries = find_series({"table": name, "time_column": tcols[0], "value_columns": [vcol]}, {name: sub}, metric)
            if not sseries:
                continue
            r = forecast(sseries, target, today)
            if r.get("status") != "ok":
                continue
            agg = _sum_period(r, ts, te)
            if not agg:
                continue
            pa, pb = date(ts.year - 1, ts.month, 1), date(te.year - 1, te.month, min(te.day, 28))
            prev = _actual_period(r, pa, fc.period_end(_bucket(pb, r["grain"]), r["grain"]), r["grain"]) \
                if not (te.year > ts.year) else None
            items.append({"name": str(seg), **agg, "prev": prev})
        if len(items) < 2:
            continue
        facts = analysis.setdefault("facts", [])
        cur = currency if kind == "currency" else None
        label = (analysis.get("summary") or {}).get("forecast", {}).get("asked") or target.get("text") or span_text(ts, te)
        from .present import humanize
        dim_h = humanize(dim).lower()
        out_items = []
        for it in items:
            f = {"id": f"f{len(facts) + 1}", "label": f"Forecast {metric}, {label}: {it['name']}", "value": it["value"], "kind": kind,
                 "display": fmt(it["value"], kind, cur), "table": name}
            facts.append(f)
            entry = {"name": it["name"], "fact_id": f["id"]}
            pc = pct_change(it["value"], it["prev"]) if it.get("prev") else None
            if pc is not None:
                g = {"id": f"f{len(facts) + 1}", "label": f"Forecast change for {it['name']} vs a year earlier (%)", "value": pc,
                     "kind": "percent", "display": fmt(pc, "percent", None, signed=True), "table": name}
                facts.append(g)
                entry["pct_fact_id"] = g["id"]
            out_items.append(entry)
        prev_label = span_text(date(ts.year - 1, ts.month, 1), date(te.year - 1, te.month, te.day)) if te.year == ts.year else None
        rows, details = [], []
        for it in items:
            row = {dim: it["name"]}
            if prev_label and it.get("prev") is not None:
                row[f"actual_{prev_label}"] = round(it["prev"], 2)
            row[f"forecast_{label}"] = round(it["value"], 2)
            rows.append(row)
            details.append({dim: it["name"], "forecast": round(it["value"], 2), "likely_low": round(it["lo80"], 2),
                            "likely_high": round(it["hi80"], 2), **({"actual_last_year": round(it["prev"], 2)} if it.get("prev") is not None else {})})
        cols = [{"name": dim, "dtype": "string", "role": "dimension", "label": dim_h.capitalize()}]
        if prev_label and any(f"actual_{prev_label}" in r for r in rows):
            cols.append({"name": f"actual_{prev_label}", "dtype": "number", "role": "measure", "label": f"{prev_label} actual", "format": kind,
                         **({"currency": cur} if cur else {})})
        cols.append({"name": f"forecast_{label}", "dtype": "number", "role": "measure", "label": f"{label} forecast", "format": kind,
                     **({"currency": cur} if cur else {})})
        dcols = [{"name": dim, "dtype": "string", "role": "dimension", "label": dim_h.capitalize()},
                 {"name": "forecast", "dtype": "number", "role": "measure", "label": f"{label} forecast", "format": kind},
                 {"name": "likely_low", "dtype": "number", "role": "measure", "label": "Likely low (80%)", "format": kind},
                 {"name": "likely_high", "dtype": "number", "role": "measure", "label": "Likely high (80%)", "format": kind}]
        if any("actual_last_year" in d for d in details):
            dcols.append({"name": "actual_last_year", "dtype": "number", "role": "measure", "label": f"{prev_label} actual", "format": kind})
        together = sum(it["value"] for it in items) if total.get("additive") else None
        note = (f"Each {dim_h} is forecast from its own history" +
                (f"; together they come to {fmt(together, kind, cur)}." if together is not None else ".") +
                (f" Showing the {MAX_SEGMENTS} largest." if len(totals) > MAX_SEGMENTS else ""))
        visual = {"type": "chart", "title": f"{metric}: {label} forecast by {dim_h}", "chart_type": "grouped_bar" if len(cols) > 2 else "bar",
                  "columns": cols, "rows": rows, "tables": [name], "note": note,
                  "details": {"columns": dcols, "rows": details}}
        vis = analysis.setdefault("visuals", [])
        vis.insert(1 if vis and vis[0].get("type") == "forecast" else 0, visual)
        analysis.setdefault("summary", {}).setdefault("forecast", {})["by_dimension"] = {"dimension": dim_h, "items": out_items}
        return
