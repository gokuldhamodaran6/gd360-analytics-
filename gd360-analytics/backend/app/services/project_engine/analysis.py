"""
The analysis engine: deterministic statistics on the small results the
steps brought back. No language model here - every number an answer may
use is computed in this file and handed to the composer as a "fact".

Analysis types (plan["analysis"]["type"]):
  explain_change - a metric moved between two periods: how much, which
                   parts of it moved (multiplicative or additive split),
                   and which segments of each driver dimension explain it.
  trend          - a measure over time: start, end, change, peak, low,
                   the biggest move between two periods.
  breakdown      - a measure split by a dimension: total, leaders, shares,
                   how concentrated it is.
  lookup / list  - a value or a short table, shown as it is.

Conventions the planner is told to follow for explain_change: every table
in it has a `period` column whose values are exactly 'current' and
'previous'.
"""
from __future__ import annotations

import math

import pandas as pd

from .numbers import fmt, pct_change

MAX_DRIVER_SEGMENTS = 8
_ID_LIKE = __import__('re').compile(r'(^|_)(day|week|month|year|quarter|hour|id|rank|no|number|period)$', __import__('re').I)
MAX_VISUAL_ROWS = 500


class AnalysisError(ValueError):
    pass


# ---- helpers -----------------------------------------------------------------

def _col(df: pd.DataFrame, name: str | None) -> str | None:
    """The real column name for `name`, case-insensitively."""
    if not name or df is None:
        return None
    if name in df.columns:
        return name
    low = str(name).lower()
    for c in df.columns:
        if str(c).lower() == low:
            return c
    return None


def _num(v) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _period_values(df: pd.DataFrame, period_col: str, value_col: str) -> tuple[float, float]:
    p = df[period_col].astype(str).str.strip().str.lower()
    vals = pd.to_numeric(df[value_col], errors="coerce")
    cur = vals[p.isin(["current", "cur", "this", "now"])].sum(min_count=1)
    prev = vals[p.isin(["previous", "prev", "prior", "last", "before"])].sum(min_count=1)
    cur = None if pd.isna(cur) else float(cur)
    prev = None if pd.isna(prev) else float(prev)
    if cur is None or prev is None:
        raise AnalysisError(
            f"Expected rows with {period_col} = 'current' and 'previous' (found: "
            f"{', '.join(sorted(set(p.tolist()))[:6]) or 'no rows'})."
        )
    return cur, prev


def _labels(df: pd.DataFrame, period_col: str) -> dict:
    """'current'/'previous' -> 'start – end' when the table carries
    period_start / period_end columns."""
    s, e = _col(df, "period_start"), _col(df, "period_end")
    out = {}
    if not (s and e):
        return out
    for _, row in df.iterrows():
        key = str(row[period_col]).strip().lower()
        try:
            a, b = pd.to_datetime(row[s]), pd.to_datetime(row[e])
            if a.year == b.year and a.month == b.month:
                out[key] = f"{a.day}–{b.day} {a.strftime('%b %Y')}" if a.day != b.day else a.strftime("%d %b %Y")
            else:
                out[key] = f"{a.strftime('%d %b %Y')} – {b.strftime('%d %b %Y')}"
        except Exception:  # noqa: BLE001
            continue
    return out


def _dtype(series: pd.Series) -> str:
    if pd.api.types.is_bool_dtype(series):
        return "boolean"
    if pd.api.types.is_numeric_dtype(series):
        return "number"
    if pd.api.types.is_datetime64_any_dtype(series):
        return "date"
    sample = series.dropna().astype(str).head(20)
    if len(sample) and sample.str.match(r"^\d{4}-\d{2}(-\d{2})?").all():
        return "date"
    return "string"


def table_payload(df: pd.DataFrame, limit: int = MAX_VISUAL_ROWS) -> dict:
    """A DataFrame as {columns:[{name,dtype,role}], rows:[...], truncated}
    - the ResultColumn shape the frontend's chart and table components
    already read."""
    cols = []
    for c in df.columns:
        dt = _dtype(df[c])
        role = "measure" if dt == "number" else "dimension"
        if dt == "number" and _ID_LIKE.search(str(c)) and pd.api.types.is_integer_dtype(df[c]):
            role = "dimension"  # day 1..7, year, week number, an id: a label, not a quantity
        cols.append({"name": str(c), "dtype": dt, "role": role})
    head = df.head(limit)
    rows = []
    for rec in head.to_dict(orient="records"):
        clean = {}
        for k, v in rec.items():
            if isinstance(v, float) and not math.isfinite(v):
                v = None
            elif isinstance(v, (pd.Timestamp,)):
                v = v.isoformat()[:19].replace("T00:00:00", "")
            elif hasattr(v, "isoformat"):
                v = v.isoformat()
            elif hasattr(v, "item"):
                try:
                    v = v.item()
                except Exception:  # noqa: BLE001
                    v = str(v)
            clean[str(k)] = v
        rows.append(clean)
    return {"columns": cols, "rows": rows, "truncated": len(df) > limit}


class _Facts:
    def __init__(self, kind: str, currency: str | None):
        self.items: list[dict] = []
        self.kind = kind
        self.currency = currency

    def add(self, label: str, value, kind: str | None = None, signed: bool = False, table: str | None = None) -> dict:
        k = kind or self.kind
        f = {
            "id": f"f{len(self.items) + 1}",
            "label": label,
            "value": _num(value),
            "kind": k,
            "display": fmt(value, k, self.currency, signed=signed),
        }
        if table:
            f["table"] = table  # which step's result it came from (sources on the answer)
        self.items.append(f)
        return f


# ---- explain_change ----------------------------------------------------------

def _explain_change(spec: dict, tables: dict, facts: _Facts) -> dict:
    total = spec.get("total") or {}
    tname = total.get("table")
    df = tables.get(tname)
    if df is None:
        raise AnalysisError(f"The table {tname!r} for the total was not produced.")
    pcol = _col(df, total.get("period_column") or "period")
    vcol = _col(df, total.get("value_column"))
    if not pcol or not vcol:
        raise AnalysisError("The total table needs a period column and a value column.")
    cur, prev = _period_values(df, pcol, vcol)
    labels = _labels(df, pcol)
    cur_label = spec.get("current_label") or labels.get("current") or "current period"
    prev_label = spec.get("previous_label") or labels.get("previous") or "previous period"
    metric = spec.get("metric_name") or "Value"
    delta = cur - prev
    pct = pct_change(cur, prev)

    f_cur = facts.add(f"{metric}, {cur_label}", cur, table=tname)
    f_prev = facts.add(f"{metric}, {prev_label}", prev, table=tname)
    f_delta = facts.add(f"Change in {metric}", delta, signed=True, table=tname)
    f_pct = facts.add(f"Change in {metric} (%)", pct, kind="percent", signed=True, table=tname) if pct is not None else None

    summary = {
        "metric": metric, "current": cur, "previous": prev, "delta": delta, "pct": pct,
        "current_label": cur_label, "previous_label": prev_label,
        "fact_ids": [f["id"] for f in (f_cur, f_prev, f_delta, f_pct) if f],
        "direction": "down" if delta < 0 else ("up" if delta > 0 else "flat"),
    }
    visuals: list[dict] = []
    warnings: list[str] = []

    # -- components: the parts the metric is made of
    comps = []
    for c in spec.get("components") or []:
        cdf = tables.get(c.get("table"))
        if cdf is None:
            warnings.append(f"Component {c.get('name')!r}: its table was not produced.")
            continue
        cp, cv = _col(cdf, c.get("period_column") or "period"), _col(cdf, c.get("value_column"))
        if not cp or not cv:
            warnings.append(f"Component {c.get('name')!r}: missing period or value column.")
            continue
        try:
            ccur, cprev = _period_values(cdf, cp, cv)
        except AnalysisError as e:
            warnings.append(f"Component {c.get('name')!r}: {e}")
            continue
        ckind = c.get("format") or ("ratio" if max(abs(ccur), abs(cprev)) < 1 else "number")
        if ckind == "currency" and not facts.currency:
            ckind = "number"
        ct = c.get("table")
        fc = facts.add(f"{c.get('name')}, {cur_label}", ccur, kind=ckind, table=ct)
        fp = facts.add(f"{c.get('name')}, {prev_label}", cprev, kind=ckind, table=ct)
        cpct = pct_change(ccur, cprev)
        fx = facts.add(f"Change in {c.get('name')} (%)", cpct, kind="percent", signed=True, table=ct) if cpct is not None else None
        comps.append({"name": c.get("name"), "table": ct, "current": ccur, "previous": cprev, "pct": cpct,
                      "fact_ids": [f["id"] for f in (fc, fp, fx) if f]})

    mode = (spec.get("components_mode") or "multiply").lower()
    effects = []
    if comps:
        if mode.startswith("add"):
            total_prev = sum(c["previous"] for c in comps)
            total_cur = sum(c["current"] for c in comps)
            consistent = _close(total_prev, prev) and _close(total_cur, cur)
            if consistent:
                for c in comps:
                    effects.append((c, c["current"] - c["previous"]))
        else:
            prod_prev = math.prod(c["previous"] for c in comps)
            prod_cur = math.prod(c["current"] for c in comps)
            consistent = _close(prod_prev, prev) and _close(prod_cur, cur) and all(c["previous"] for c in comps)
            if consistent:
                running = prev
                for c in comps:
                    new = running * (c["current"] / c["previous"])
                    effects.append((c, new - running))
                    running = new
        if not consistent:
            warnings.append(
                f"The parts do not multiply/add up to {metric} in both periods, so the change is not split "
                "into them; each part's own change is still shown."
            )
    if effects:
        items = [{"label": prev_label, "value": prev, "kind": "total"}]
        for c, eff in effects:
            fe = facts.add(f"Effect of {c['name']} on {metric}", eff, signed=True, table=c.get("table"))
            c["effect"] = eff
            c["effect_fact_id"] = fe["id"]
            c["share"] = (eff / delta * 100) if delta else None
            if c["share"] is not None:
                fs = facts.add(f"Effect of {c['name']} on {metric}: share of the change", abs(c["share"]),
                               kind="percent", table=c.get("table"))
                c["fact_ids"].append(fs["id"])
            c["fact_ids"].append(fe["id"])
            items.append({"label": c["name"], "value": eff, "kind": "up" if eff >= 0 else "down"})
        items.append({"label": cur_label, "value": cur, "kind": "total"})
        visuals.append({"type": "waterfall", "title": f"Where the {fmt(delta, facts.kind, facts.currency)} change came from",
                        "items": items, "format": facts.kind, "currency": facts.currency,
                        "tables": [tname] + [c.get("table") for c, _ in effects if c.get("table")]})
    summary["components"] = comps

    # -- drivers: which segments of a dimension explain the change
    drivers = []
    for d in spec.get("drivers") or []:
        ddf = tables.get(d.get("table"))
        if ddf is None:
            warnings.append(f"Driver {d.get('label') or d.get('dimension_column')!r}: its table was not produced.")
            continue
        dim = _col(ddf, d.get("dimension_column"))
        dp = _col(ddf, d.get("period_column") or "period")
        dv = _col(ddf, d.get("value_column"))
        if not (dim and dp and dv):
            warnings.append(f"Driver {d.get('label')!r}: missing dimension, period or value column.")
            continue
        work = ddf[[dim, dp, dv]].copy()
        work[dp] = work[dp].astype(str).str.strip().str.lower().replace({"cur": "current", "prev": "previous", "prior": "previous"})
        work[dv] = pd.to_numeric(work[dv], errors="coerce").fillna(0)
        pivot = work.pivot_table(index=dim, columns=dp, values=dv, aggfunc="sum", fill_value=0)
        if "current" not in pivot.columns or "previous" not in pivot.columns:
            warnings.append(f"Driver {d.get('label')!r}: needs both 'current' and 'previous' rows.")
            continue
        pivot["change"] = pivot["current"] - pivot["previous"]
        dkind = d.get("format") or facts.kind
        total_change = float(pivot["change"].sum())
        basis = delta if delta else total_change
        ranked = pivot.reindex(pivot["change"].abs().sort_values(ascending=False).index)
        segs = []
        for seg, row in ranked.head(MAX_DRIVER_SEGMENTS).iterrows():
            ch = float(row["change"])
            share = (ch / basis * 100) if basis else None
            dt = d.get("table")
            fch = facts.add(f"{d.get('label') or dim} = {seg}: change", ch, kind=dkind, signed=True, table=dt)
            fsh = facts.add(f"{d.get('label') or dim} = {seg}: share of the change", share, kind="percent", table=dt) if share is not None else None
            fcur = facts.add(f"{d.get('label') or dim} = {seg}, {cur_label}", float(row["current"]), kind=dkind, table=dt)
            fprv = facts.add(f"{d.get('label') or dim} = {seg}, {prev_label}", float(row["previous"]), kind=dkind, table=dt)
            segs.append({
                "segment": str(seg), "current": float(row["current"]), "previous": float(row["previous"]),
                "change": ch, "share": share, "pct": pct_change(float(row["current"]), float(row["previous"])),
                "fact_ids": [f["id"] for f in (fch, fsh, fcur, fprv) if f],
            })
        top_share = abs(segs[0]["share"]) if segs and segs[0]["share"] is not None else 0
        same_dir = [s for s in segs if basis and s["change"] * basis > 0]
        verdict = "concentrated" if top_share >= 50 else ("partly" if top_share >= 25 else "broad")
        drivers.append({
            "label": d.get("label") or dim, "dimension": dim, "segments": segs, "verdict": verdict,
            "top_share": top_share, "segment_count": int(len(pivot)), "moved_with_change": len(same_dir),
        })
        visuals.append({
            "type": "diverging", "title": f"{metric} change by {str(d.get('label') or dim).lower()}",
            "items": [{"label": s["segment"], "value": s["change"], "share": s["share"]} for s in segs],
            "format": dkind, "currency": facts.currency, "tables": [d.get("table")],
        })
    summary["drivers"] = drivers

    # -- the series behind the change, when the plan asked for one
    series = spec.get("series") or {}
    sdf = tables.get(series.get("table"))
    if sdf is not None and len(sdf):
        visuals.insert(0, {"type": "chart", "title": series.get("title") or f"{metric} over time",
                           "chart_type": series.get("chart_type") or "line", "tables": [series.get("table")],
                           **table_payload(sdf)})
    return {"summary": summary, "visuals": visuals, "warnings": warnings}


def _close(a: float, b: float, tol: float = 0.03) -> bool:
    if a is None or b is None:
        return False
    if b == 0:
        return abs(a) < 1e-9
    return abs(a - b) / abs(b) <= tol


# ---- trend -------------------------------------------------------------------

def _trend(spec: dict, tables: dict, facts: _Facts) -> dict:
    df = tables.get(spec.get("table"))
    if df is None or not len(df):
        raise AnalysisError("The trend table is empty.")
    tcol = _col(df, spec.get("time_column"))
    vcols = [c for c in (_col(df, v) for v in (spec.get("value_columns") or [])) if c]
    if not tcol or not vcols:
        raise AnalysisError("The trend needs a time column and at least one value column.")
    work = df.copy()
    try:
        work["_t"] = pd.to_datetime(work[tcol])
    except Exception:  # noqa: BLE001
        work["_t"] = work[tcol]
    work = work.sort_values("_t")
    metric = spec.get("metric_name") or vcols[0]
    series_out = []
    for v in vcols:
        s = pd.to_numeric(work[v], errors="coerce")
        valid = work.loc[s.notna()]
        s = s.dropna()
        if s.empty:
            continue
        first, last = float(s.iloc[0]), float(s.iloc[-1])
        name = metric if len(vcols) == 1 else v
        tl = lambda i: str(valid[tcol].iloc[i])[:10]  # noqa: E731
        f1 = facts.add(f"{name}, {tl(0)}", first)
        f2 = facts.add(f"{name}, {tl(-1)}", last)
        ch = facts.add(f"Change in {name} from {tl(0)} to {tl(-1)}", last - first, signed=True)
        pc = pct_change(last, first)
        fp = facts.add(f"Change in {name} from {tl(0)} to {tl(-1)} (%)", pc, kind="percent", signed=True) if pc is not None else None
        imax, imin = int(s.values.argmax()), int(s.values.argmin())
        fmax = facts.add(f"Highest {name} ({tl(imax)})", float(s.iloc[imax]))
        fmin = facts.add(f"Lowest {name} ({tl(imin)})", float(s.iloc[imin]))
        diffs = s.diff().iloc[1:]
        jump = None
        if len(diffs):
            j = int(diffs.abs().values.argmax()) + 1
            fj = facts.add(f"Biggest move in {name}: {tl(j - 1)} to {tl(j)}", float(diffs.iloc[j - 1]), signed=True)
            jump = {"from": tl(j - 1), "to": tl(j), "change": float(diffs.iloc[j - 1]), "fact_id": fj["id"]}
        total = facts.add(f"Total {name} over the period", float(s.sum())) if spec.get("summable", True) else None
        series_out.append({"name": name, "first": first, "last": last, "pct": pc, "jump": jump,
                           "fact_ids": [f["id"] for f in (f1, f2, ch, fp, fmax, fmin, total) if f]})
    visuals = [{"type": "chart", "title": spec.get("title") or f"{metric} over time",
                "chart_type": spec.get("chart_type") or "line", **table_payload(df)}]
    return {"summary": {"metric": metric, "series": series_out}, "visuals": visuals, "warnings": []}


# ---- breakdown ---------------------------------------------------------------

def _breakdown(spec: dict, tables: dict, facts: _Facts) -> dict:
    df = tables.get(spec.get("table"))
    if df is None or not len(df):
        raise AnalysisError("The breakdown table is empty.")
    dim = _col(df, spec.get("dimension_column"))
    val = _col(df, spec.get("value_column"))
    if not dim or not val:
        raise AnalysisError("The breakdown needs a dimension column and a value column.")
    work = df[[dim, val]].copy()
    work[val] = pd.to_numeric(work[val], errors="coerce")
    work = work.dropna(subset=[val]).groupby(dim, as_index=False)[val].sum().sort_values(val, ascending=False)
    metric = spec.get("metric_name") or val
    total = float(work[val].sum())
    ft = facts.add(f"Total {metric}", total)
    segs = []
    for _, row in work.head(10).iterrows():
        v = float(row[val])
        share = v / total * 100 if total else None
        fv = facts.add(f"{metric} for {row[dim]}", v)
        fs = facts.add(f"{row[dim]}: share of total {metric}", share, kind="percent") if share is not None else None
        segs.append({"segment": str(row[dim]), "value": v, "share": share, "fact_ids": [f["id"] for f in (fv, fs) if f]})
    top3 = float(work[val].head(3).sum() / total * 100) if total else None
    f3 = facts.add(f"Top 3 share of total {metric}", top3, kind="percent") if top3 is not None else None
    fn = facts.add(f"Number of {dim} values", int(len(work)), kind="integer")
    visuals = [{"type": "chart", "title": spec.get("title") or f"{metric} by {dim}",
                "chart_type": spec.get("chart_type") or ("horizontal_bar" if len(work) > 6 else "bar"),
                **table_payload(df)}]
    return {"summary": {"metric": metric, "total": total, "segments": segs, "segment_count": int(len(work)),
                        "fact_ids": [x["id"] for x in (ft, f3, fn) if x]},
            "visuals": visuals, "warnings": []}


# ---- lookup / list -----------------------------------------------------------

def _lookup(spec: dict, tables: dict, facts: _Facts) -> dict:
    df = tables.get(spec.get("table"))
    if df is None:
        raise AnalysisError("The result table was not produced.")
    kpis = []
    if len(df) == 1:
        for c in df.columns:
            v = _num(df.iloc[0][c])
            if v is not None and not isinstance(df.iloc[0][c], bool):
                f = facts.add(str(c).replace("_", " "), v)
                kpis.append({"label": f["label"], "display": f["display"], "fact_id": f["id"]})
    visuals = []
    if kpis:
        visuals.append({"type": "kpis", "items": kpis})
    if len(df) > 1 or not kpis:
        visuals.append({"type": "chart", "title": spec.get("title") or "Result",
                        "chart_type": spec.get("chart_type") or "table", **table_payload(df)})
    return {"summary": {"rows": int(len(df))}, "visuals": visuals, "warnings": []}


def run_analysis(spec: dict, tables: dict[str, pd.DataFrame]) -> dict:
    kind = (spec or {}).get("format") or "number"
    if kind not in ("currency", "number", "integer", "percent", "ratio"):
        kind = "number"
    facts = _Facts(kind, (spec or {}).get("currency") if kind == "currency" else None)
    atype = (spec or {}).get("type") or "lookup"
    if atype == "explain_change":
        out = _explain_change(spec, tables, facts)
    elif atype == "trend":
        out = _trend(spec, tables, facts)
    elif atype in ("breakdown", "comparison"):
        out = _breakdown(spec, tables, facts)
    else:
        out = _lookup(spec, tables, facts)
    if atype != "explain_change" and (spec or {}).get("table"):
        for f in facts.items:
            f.setdefault("table", spec["table"])
        for v in out.get("visuals") or []:
            v.setdefault("tables", [spec["table"]])
    out["facts"] = facts.items
    out["type"] = atype
    return out
