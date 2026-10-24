"""2026-10-24 (R62): year over year, every year.

"YoY sales" on 2021-2025 data was answered as 2025 vs 2024 only - the headline, the first chart and the findings
all read the last two years, while the table of every year sat lower down unread. A year-over-year question with no
years named is about the whole run of years: each year, its change on the year before, the biggest rise and fall,
and the overall span. This module finds the step that has one row per year (planner rule: "add one more step with
the metric for EVERY year"), computes each change in code, adds them as facts the writer must use, and puts a
"by year" chart first. The latest year's drivers (explain_change) stay as they were, after it.
"""
from __future__ import annotations

import re

import pandas as pd

from .numbers import fmt

YOY_Q = re.compile(r"\b(yoy|y-o-y|y/y|year[\s-]*(over|on|to)[\s-]*year|annual(ly)?\s+growth|growth\s+(by|per|each)\s+year|"
                   r"by\s+year|each\s+year|every\s+year|per\s+year|yearly|annual\s+(sales|revenue|trend|change)|over\s+the\s+years)\b", re.I)
_YEAR = re.compile(r"(^|_)(year|yr|fy)$|^(year|yr|fy)(_|$)", re.I)
_YEARS_NAMED = re.compile(r"\b(?:19|20)\d{2}\b")


def wanted(question: str) -> bool:
    """A year-over-year question that names at most one year (two named years are a two-period comparison)."""
    q = question or ""
    return bool(YOY_Q.search(q)) and len(set(_YEARS_NAMED.findall(q))) < 2


def _year_col(df: pd.DataFrame) -> str | None:
    for c in df.columns:
        if _YEAR.search(str(c)):
            v = pd.to_numeric(df[c], errors="coerce").dropna()
            if len(v) and ((v % 1) == 0).all() and v.between(1900, 2100).all():
                return c
    return None


def _measure(df: pd.DataFrame, year: str, prefer: str | None) -> str | None:
    nums = [c for c in df.columns if c != year and pd.api.types.is_numeric_dtype(df[c])
            and not re.search(r"(^|_)(month|quarter|week|day|count_years|years_covered|rank|pos)$", str(c), re.I)]
    if prefer and prefer in nums:
        return prefer
    money = [c for c in nums if re.search(r"sales|revenue|amount|gmv|profit|spend|value|total", str(c), re.I)]
    return (money or nums or [None])[0]


def find_table(tables: dict, prefer_measure: str | None = None) -> tuple[str, str, str] | None:
    """(table id, year column, measure) of the step with one row per year - 3 years or more."""
    best = None
    for tid, df in (tables or {}).items():
        if df is None or not len(df):
            continue
        y = _year_col(df)
        if not y:
            continue
        other_dims = [c for c in df.columns if c != y and not pd.api.types.is_numeric_dtype(df[c])]
        if other_dims or df[y].nunique() < 3 or df[y].nunique() != len(df):
            continue
        m = _measure(df, y, prefer_measure)
        if m and (best is None or df[y].nunique() > best[3]):
            best = (tid, y, m, df[y].nunique())
    return best[:3] if best else None


def attach(analysis: dict, plan: dict, tables: dict, question: str, currency: str | None) -> bool:
    """Adds the every-year facts, the summary the writer reads and the lead chart. True when it did."""
    if not wanted(question):
        return False
    spec = plan.get("analysis") or {}
    prefer = (spec.get("total") or {}).get("value_column") or spec.get("value_column")
    hit = find_table(tables, prefer)
    if not hit:
        return False
    tid, ycol, mcol = hit
    df = tables[tid][[ycol, mcol]].copy()
    df[ycol] = pd.to_numeric(df[ycol], errors="coerce").astype(int)
    df[mcol] = pd.to_numeric(df[mcol], errors="coerce")
    df = df.dropna().sort_values(ycol)
    kind = spec.get("format") if spec.get("format") in ("currency", "number", "integer") else (
        "currency" if re.search(r"sales|revenue|amount|gmv|profit|spend|price", mcol, re.I) else "number")
    cur = currency if kind == "currency" else None
    metric = spec.get("metric_name") or re.sub(r"_", " ", mcol).strip().capitalize()
    facts = analysis.setdefault("facts", [])

    def add(label: str, value, k: str, display: str) -> None:
        facts.append({"id": f"f{len(facts) + 1}", "label": label, "value": float(value), "kind": k, "display": display,
                      "table": tid, **({"currency": cur} if cur else {})})

    years = []
    prev = None
    for _, r in df.iterrows():
        y, v = int(r[ycol]), float(r[mcol])
        add(f"{metric} in {y}", v, kind, fmt(v, kind, cur))
        row = {"year": y, "value": fmt(v, kind, cur)}
        if prev is not None and prev[1]:
            ch, pct = v - prev[1], (v - prev[1]) / abs(prev[1]) * 100
            add(f"{metric} {y} vs {prev[0]}: change", ch, kind, fmt(ch, kind, cur, signed=True))
            add(f"{metric} {y} vs {prev[0]}: % change", pct, "percent", fmt(pct, "percent", signed=True))
            row.update({"change": fmt(ch, kind, cur, signed=True), "pct": fmt(pct, "percent", signed=True), "_pct": pct})
        years.append(row)
        prev = (y, v)
    first, last = df.iloc[0], df.iloc[-1]
    span_ch = float(last[mcol]) - float(first[mcol])
    span_pct = span_ch / abs(float(first[mcol])) * 100 if float(first[mcol]) else None
    add(f"{metric} {int(last[ycol])} vs {int(first[ycol])}: change", span_ch, kind, fmt(span_ch, kind, cur, signed=True))
    if span_pct is not None:
        add(f"{metric} {int(last[ycol])} vs {int(first[ycol])}: % change", span_pct, "percent", fmt(span_pct, "percent", signed=True))
    moves = [r for r in years if "_pct" in r]
    up = max(moves, key=lambda r: r["_pct"]) if moves else None
    down = min(moves, key=lambda r: r["_pct"]) if moves else None
    analysis.setdefault("summary", {})["years"] = {
        "metric": metric, "first": int(first[ycol]), "last": int(last[ycol]),
        "each": [{k: v for k, v in r.items() if k != "_pct"} for r in years],
        "biggest_rise": up and {"year": up["year"], "pct": up["pct"]}, "biggest_fall": down and {"year": down["year"], "pct": down["pct"]},
        "span_change": fmt(span_ch, kind, cur, signed=True), "span_pct": fmt(span_pct, "percent", signed=True) if span_pct is not None else None,
    }
    # the lead chart: every year, with each year's change written under it
    from .analysis import table_payload
    from .present import annotate
    chart = df.rename(columns={ycol: "year", mcol: mcol}).copy()
    chart["year"] = chart["year"].astype(str)
    payload = annotate(table_payload(chart), currency, drop_helpers=False)
    note = " · ".join(f"{r['year']} {r['pct']}" for r in years if r.get("pct"))
    vis = {"type": "chart", "title": f"{metric} by year", "chart_type": "bar", "tables": [tid], "yoy": True, **payload,
           **({"note": f"Change on the year before: {note}"} if note else {})}
    analysis["visuals"] = [vis] + [v for v in analysis.get("visuals") or [] if (v.get("tables") or [None]) != [tid]]
    return True
