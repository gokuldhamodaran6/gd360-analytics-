"""
What moved a total: how many vs how much each (2026-10-12, round 33).

"What drives the net sales forecast?", "why did sales fall?" - when the plan
fetched a total AND a count per period (net sales and orders by year, say),
the change between the last two full periods is split exactly into

    the number of orders      (more or fewer orders, at last year's value each)
    the value of each order   (the average order value moving)

with the logarithmic mean (LMDI-I): with S = N x A,
    dS = L(S1, S0) x ln(N1/N0) + L(S1, S0) x ln(A1/A0),   L(a, b) = (a - b) / ln(a / b)
so the two parts always add up to the change, in either direction, with no
residual - the standard index-decomposition method in economics. Customers,
when the result has them, are reported the same way ("active customers
-3.1%").

Before this, the planner fetched exactly these columns and the answer threw
them away: the supporting chart showed net sales only, under a title that
promised "order volume and AOV".
"""
from __future__ import annotations

import math
import re
from datetime import date

import pandas as pd

from .forecasting import DRIVERS_ASKED, _time_of
from .numbers import fmt, pct_change

COUNT_NAME = re.compile(r"(^|_)(orders?|order_count|total_orders|num_orders|n_orders|transactions?|bookings?|purchases?|"
                        r"invoices?|sales_count|deals?)($|_)", re.I)
CUSTOMER_NAME = re.compile(r"(^|_)(customers?|buyers?|clients?|active_customers|users?)($|_)", re.I)
VALUE_NAME = re.compile(r"(net_sales|gross_sales|^sales$|_sales$|revenue|gmv|turnover|income|amount)", re.I)
NOT_TOTAL = re.compile(r"(^|_)(avg|average|mean|median|per|rate|pct|share|ratio|aov)(_|$)", re.I)


def _log_mean(a: float, b: float) -> float:
    if a <= 0 or b <= 0:
        return (a + b) / 2
    return a if abs(a - b) < 1e-12 else (a - b) / math.log(a / b)


def _yearly(df: pd.DataFrame, today: date) -> tuple[pd.DataFrame, str, str, str | None] | None:
    """Per full year: value, count (and customers) - from a table that has them."""
    got = _time_of(df, None)
    if not got:
        return None
    when, tcols = got
    cols = [c for c in df.columns if c not in tcols and pd.api.types.is_numeric_dtype(df[c])]
    value = next((c for c in cols if VALUE_NAME.search(str(c)) and not NOT_TOTAL.search(str(c))), None)
    count = next((c for c in cols if COUNT_NAME.search(str(c)) and not NOT_TOTAL.search(str(c)) and c != value), None)
    cust = next((c for c in cols if CUSTOMER_NAME.search(str(c)) and c not in (value, count)), None)
    if not value or not count:
        return None
    work = pd.DataFrame({"year": pd.to_datetime(when).dt.year, "value": pd.to_numeric(df[value], errors="coerce"),
                         "count": pd.to_numeric(df[count], errors="coerce")})
    if cust:
        # distinct customers can't be added across months: only a yearly table's own figure is used
        work["cust"] = pd.to_numeric(df[cust], errors="coerce")
    months = pd.to_datetime(when).dt.to_period("M")
    per_year = pd.DataFrame({"year": pd.to_datetime(when).dt.year, "m": months}).groupby("year")["m"].nunique()
    yearly_rows = len(df) == per_year.size  # one row per year: the table is already yearly
    g = work.groupby("year").agg(value=("value", "sum"), count=("count", "sum"),
                                 **({"cust": ("cust", "sum")} if cust and yearly_rows else {}))
    if not yearly_rows:
        g = g[per_year.reindex(g.index).fillna(0) >= 12]  # full years only
    g = g[g.index < today.year] if (g.index.max() if len(g) else 0) >= today.year else g
    g = g.dropna()
    if len(g) < 2:
        return None
    return g, value, count, (cust if cust and yearly_rows else None)


def attach(analysis: dict, plan: dict, tables: dict, question: str, today: date | None = None) -> dict | None:
    """When the question asks why / what drives: the orders vs order-value split of the last full year's change."""
    if not DRIVERS_ASKED.search(question or ""):
        return None
    today = today or date.today()
    spec = plan.get("analysis") or {}
    kind = spec.get("format") if spec.get("format") in ("currency", "number") else "currency"
    currency = spec.get("currency") or "USD"
    cur = currency if kind == "currency" else None
    metric = spec.get("metric_name") or "Net sales"
    from .present import humanize, in_sentence
    for name, df in (tables or {}).items():
        if df is None or len(df) < 2:
            continue
        try:
            got = _yearly(df, today)
        except Exception:  # noqa: BLE001 - not this table
            got = None
        if not got:
            continue
        g, vcol, ccol, custcol = got
        y0, y1 = int(g.index[-2]), int(g.index[-1])
        s0, s1 = float(g.loc[y0, "value"]), float(g.loc[y1, "value"])
        n0, n1 = float(g.loc[y0, "count"]), float(g.loc[y1, "count"])
        if min(s0, s1, n0, n1) <= 0:
            continue
        a0, a1 = s0 / n0, s1 / n1
        lm = _log_mean(s1, s0)
        eff_n = lm * math.log(n1 / n0)
        eff_a = lm * math.log(a1 / a0)
        facts = analysis.setdefault("facts", [])
        count_word = humanize(ccol).lower().replace("total ", "")
        count_word = "orders" if "order" in count_word else count_word

        def add(label: str, value, k: str = "number", signed: bool = False) -> dict:
            f = {"id": f"f{len(facts) + 1}", "label": label, "value": float(value), "kind": k,
                 "display": fmt(value, k, cur if k == "currency" else None, signed=signed), "table": name}
            facts.append(f)
            return f
        m_l = in_sentence(metric)
        one = count_word.rstrip("s")
        avg_name = "average order value" if one == "order" else f"average {m_l} per {one}"
        ids = {
            "s0": add(f"{metric}, {y0}", s0, kind)["id"], "s1": add(f"{metric}, {y1}", s1, kind)["id"],
            "ds": add(f"Change in {m_l}, {y0} to {y1}", s1 - s0, kind, True)["id"],
            "n0": add(f"{count_word.capitalize()}, {y0}", n0, "integer")["id"],
            "n1": add(f"{count_word.capitalize()}, {y1}", n1, "integer")["id"],
            "pn": add(f"Change in {count_word}, {y0} to {y1} (%)", pct_change(n1, n0), "percent", True)["id"],
            "a0": add(f"{avg_name.capitalize()}, {y0}", a0, kind)["id"],
            "a1": add(f"{avg_name.capitalize()}, {y1}", a1, kind)["id"],
            "pa": add(f"Change in {avg_name}, {y0} to {y1} (%)", pct_change(a1, a0), "percent", True)["id"],
            "en": add(f"Effect of the number of {count_word} on {m_l}, {y0} to {y1}", eff_n, kind, True)["id"],
            "ea": add(f"Effect of the value per {count_word.rstrip('s')} on {m_l}, {y0} to {y1}", eff_a, kind, True)["id"],
        }
        if custcol and float(g.loc[y0, "cust"]) > 0:
            ids["pc"] = add(f"Change in {humanize(custcol).lower()}, {y0} to {y1} (%)",
                            pct_change(float(g.loc[y1, "cust"]), float(g.loc[y0, "cust"])), "percent", True)["id"]
        by = {f["id"]: f for f in facts}
        d = lambda k: by[ids[k]]["display"]  # noqa: E731
        bigger = "number of " + count_word if abs(eff_n) >= abs(eff_a) else "value of each " + count_word.rstrip("s")
        sentence = (f"From {y0} to {y1}, {m_l} moved {d('ds')}: {count_word} changed {d('pn')} ({d('en')}) and the average "
                    f"{one} value changed {d('pa')} ({d('ea')}) - most of the move came from the {bigger}.")
        if s1 == s0:
            sentence = sentence.replace(" - most of the move came from", " - they offset each other; the larger push was the")
        analysis.setdefault("summary", {})["mix"] = {  # orders vs value per order; "drivers" holds the segment list
            "sentence": sentence, "from_label": str(y0), "to_label": str(y1), "fact_ids": ids, "count": count_word,
            "bigger": bigger,
        }
        visual = {
            "type": "waterfall", "title": f"What moved {m_l}, {y0} → {y1}: number of {count_word} vs value per {count_word.rstrip('s')}",
            "items": [{"label": f"{metric} {y0}", "value": s0, "kind": "total"},
                      {"label": f"Number of {count_word}", "value": eff_n, "kind": "up" if eff_n >= 0 else "down"},
                      {"label": f"Value per {count_word.rstrip('s')}", "value": eff_a, "kind": "up" if eff_a >= 0 else "down"},
                      {"label": f"{metric} {y1}", "value": s1, "kind": "total"}],
            "format": kind, "currency": cur, "tables": [name],
        }
        vis = analysis.setdefault("visuals", [])
        lead = 1 if vis and vis[0].get("type") in ("forecast", "waterfall") else 0
        while lead < len(vis) and vis[lead].get("type") == "chart" and "forecast by" in str(vis[lead].get("title") or ""):
            lead += 1
        vis.insert(lead, visual)
        # the per-year table the split came from, every measure (it was fetched - now it's shown)
        rows = [{"year": str(int(y)), vcol: round(float(r["value"]), 2), ccol: int(r["count"]),
                 "avg_per_" + count_word.rstrip("s"): round(float(r["value"]) / float(r["count"]), 2) if r["count"] else None,
                 **({custcol: int(r["cust"])} if custcol else {})} for y, r in g.iterrows()]
        cols = [{"name": "year", "dtype": "string", "role": "dimension", "label": "Year"},
                {"name": vcol, "dtype": "number", "role": "measure", "label": humanize(vcol), "format": kind},
                {"name": ccol, "dtype": "number", "role": "measure", "label": humanize(ccol), "format": "integer"},
                {"name": "avg_per_" + count_word.rstrip("s"), "dtype": "number", "role": "measure",
                 "label": f"Average per {count_word.rstrip('s')}", "format": kind}]
        if custcol:
            cols.append({"name": custcol, "dtype": "number", "role": "measure", "label": humanize(custcol), "format": "integer"})
        visual["details"] = {"columns": cols, "rows": rows}
        return analysis["summary"]["mix"]
    return None
