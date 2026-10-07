"""
Insights written from the chart model (2026-10-07, chart-integrity round).

The deterministic insight used to be built from "the first numeric column
and the first other column" of the first preview rows. On a pivoted result
both of those are measures, so it wrote

    "7081020.069999966 leads at 11789581.13, versus 3526408.5099999807 at
     3291100.55 - a gap of 8498480.58 (258.23% relative) (n = 6)"

- one hotel's revenue used as the NAME of the other's. This module writes
the sentence from the same chart model the chart itself is drawn from, so
the two cannot disagree, under these rules:

  labels    are dimension values ("2016", "City Hotel") or measure names -
            never a number standing in for a name
  numbers   are written for people: 11.67M, 673,501, 92.04, 37.0% - never
            11673501.429999981; a currency sign only when the column says
            so; a rate (0-1) as a percentage and its differences in
            percentage points
  time      a period axis gets a trend sentence (first -> last change, peak
            and trough with their periods, the latest period's change) -
            never "leads / versus"
  wide      several comparable series are compared per period ("City Hotel
            is ahead of Resort Hotel in 2016 and 2017 (11.79M vs 7.08M in
            2016); Resort Hotel led in 2015")
  nulls     are skipped, never printed
  n         is stated only when it is a real row count behind the numbers
  too few   fewer than two comparable points is said plainly

validate_insight_numbers() is the guard on the model-written insight: every
number it quotes must be traceable to the result table (or to a figure
computed from it here); otherwise the deterministic sentence is used.
"""
from __future__ import annotations

import math
import re
from statistics import median
from typing import Any

from . import chart_model
from .chart_model import humanize

_PERCENT_TOKENS = {"rate", "pct", "percent", "percentage", "share", "ratio"}
_CURRENCY_HINTS = [("usd", "$"), ("dollar", "$"), ("eur", "€"), ("euro", "€"), ("gbp", "£"), ("pound", "£")]


# ---- numbers for people ----------------------------------------------------

def _trim(text: str) -> str:
    return text.rstrip("0").rstrip(".") if "." in text else text


def format_number(v: float | None, unit: dict | None = None) -> str:
    """11673501.43 -> "11.67M"; 673501.2 -> "673,501"; 1234.5 -> "1,234.5";
    92.0375 -> "92.04"; 0.0375 -> "0.0375"; a rate 0.3704 -> "37.0%"."""
    if v is None or not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v):
        return "n/a"
    unit = unit or {}
    if unit.get("percent") == "fraction":
        return f"{v * 100:.1f}%"
    if unit.get("percent") == "points":
        return f"{v:.1f}%"
    sign = "-" if v < 0 else ""
    a = abs(v)
    cur = unit.get("currency") or ""
    if a >= 1e12:
        body = _trim(f"{a / 1e12:.2f}") + "T"
    elif a >= 1e9:
        body = _trim(f"{a / 1e9:.2f}") + "B"
    elif a >= 1e6:
        body = _trim(f"{a / 1e6:.2f}") + "M"
    elif a >= 10_000:
        body = f"{a:,.0f}"
    elif a >= 1000:
        body = f"{a:,.0f}" if float(a).is_integer() else _trim(f"{a:,.1f}")
    elif a >= 100:
        body = _trim(f"{a:.1f}")
    elif a >= 1 or a == 0:
        body = _trim(f"{a:.2f}")
    else:
        body = _trim(f"{a:.4f}") if a >= 0.0001 else f"{a:.2e}"
    return f"{sign}{cur}{body}"


def format_percent(p: float) -> str:
    """A percentage (already x100) to one decimal: 117.48 -> "117.5%"."""
    return f"{abs(p):,.1f}%"


def measure_unit(name: str | None, values: list) -> dict:
    """What kind of number a measure is, from its own name and values only:
    a 0-1 rate, a 0-100 percentage, a currency amount, or a plain number."""
    present = [v for v in values if v is not None]
    toks = set(chart_model._tokens(name or ""))
    raw = str(name or "").lower()
    unit: dict = {}
    if present and (toks & _PERCENT_TOKENS or "%" in raw):
        if all(0 <= v <= 1 for v in present):
            unit["percent"] = "fraction"
        elif all(0 <= v <= 100 for v in present) and ("%" in raw or toks & {"pct", "percent", "percentage"}):
            unit["percent"] = "points"
    if "percent" not in unit:
        if "$" in raw:
            unit["currency"] = "$"
        else:
            for word, symbol in _CURRENCY_HINTS:
                if word in toks:
                    unit["currency"] = symbol
                    break
    return unit


def _gap_text(a: float, b: float, unit: dict) -> str:
    """The difference between two values of one measure, in its own unit."""
    if unit.get("percent") == "fraction":
        return f"{abs(a - b) * 100:.1f} percentage points"
    if unit.get("percent") == "points":
        return f"{abs(a - b):.1f} percentage points"
    return format_number(abs(a - b), unit)


def _pct_change(new: float, old: float) -> float | None:
    if old == 0 or old is None or new is None:
        return None
    return (new - old) / abs(old) * 100


def _signed_pct(p: float | None) -> str:
    if p is None:
        return ""
    return f"{'+' if p >= 0 else '-'}{format_percent(p)}"


def _join(items: list[str]) -> str:
    items = [str(i) for i in items]
    if len(items) <= 1:
        return "".join(items)
    if len(items) == 2:
        return f"{items[0]} and {items[1]}"
    return ", ".join(items[:-1]) + f" and {items[-1]}"


# ---- naming ----------------------------------------------------------------

def _measure_name(name: str | None) -> str:
    if chart_model._is_placeholder(name):
        return "the value"
    return humanize(name)


def _dim_label(model: dict, label: str) -> str:
    """A dimension value in a sentence. A bare identifier ("240") is given
    its column's name ("Agent 240") so a reader never meets a number where
    a name should be; a period ("2016") stands by itself."""
    x = model["x"]
    if x.get("axis") == "ordinal" and not x.get("ordered") and re.fullmatch(r"-?\d+(\.\d+)?", label or "") and not chart_model._is_placeholder(x["name"]):
        return f"{humanize(x['name'])} {label}"
    return label


def _series_label(model: dict, name: Any) -> str:
    """A series in a sentence: a measure name is humanised; a value of a
    series dimension is kept as written (prefixed with the column name when
    it is a bare number)."""
    text = str(name)
    if model.get("series_by"):
        if re.fullmatch(r"-?\d+(\.\d+)?", text) and not chart_model._is_placeholder(model["series_by"]):
            return f"{humanize(model['series_by'])} {text}"
        return text
    return _measure_name(text)


_MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def period_names(model: dict) -> dict[str, str]:
    """How each x label is written in a sentence. Dates are named by their
    period: a column of January 1sts reads "2016", of month starts "Jul
    2016", anything else "Jul 5, 2016". Every other label is itself."""
    x = model.get("x") or {}
    labels = list(x.get("labels") or [])
    if x.get("axis") != "time":
        return {lab: lab for lab in labels}
    parts = []
    for lab in labels:
        m = chart_model._ISO_DATE_RE.match(lab)
        if not m:
            return {lab: lab for lab in labels}
        parts.append((int(m.group(1)), int(m.group(2)), int(m.group(3) or 1), bool(m.group(4))))
    if any(p[3] for p in parts) or any(not 1 <= p[1] <= 12 for p in parts):
        return {lab: lab for lab in labels}
    if all(p[2] == 1 for p in parts):
        if all(p[1] == 1 for p in parts) and len(parts) > 1:
            return {lab: str(p[0]) for lab, p in zip(labels, parts)}
        return {lab: f"{_MONTH_ABBR[p[1] - 1]} {p[0]}" for lab, p in zip(labels, parts)}
    return {lab: f"{_MONTH_ABBR[p[1] - 1]} {p[2]}, {p[0]}" for lab, p in zip(labels, parts)}


def _points(model: dict, series: dict) -> list[tuple[str, float]]:
    names = period_names(model)
    return [(names.get(lab, lab), v) for lab, v in zip(model["x"]["labels"], series["values"]) if v is not None]


def _comparable(model: dict) -> bool:
    """Can this chart's series be compared with each other? Values of one
    series dimension always can. Measure columns only when they are the
    same kind of number and within 8x of each other (revenue next to a
    booking count is not "ahead of" it)."""
    series = model.get("series") or []
    if len(series) < 2:
        return False
    if model.get("series_by"):
        return True
    units = [measure_unit(s["name"], s["values"]) for s in series]
    if len({u.get("percent") for u in units}) > 1:
        return False
    sizes = [max((abs(v) for v in s["values"] if v is not None), default=0) for s in series]
    sizes = [x for x in sizes if x > 0]
    return len(sizes) == len(series) and max(sizes) / min(sizes) <= 8


# ---- sentences -------------------------------------------------------------

def _trend_sentences(model: dict, series: dict, subject: str, unit: dict) -> tuple[list[str], dict]:
    """First -> last, peak / trough, latest period - for one series over a
    period axis. Returns (sentences, facts)."""
    pts = _points(model, series)
    facts: dict = {}
    if len(pts) < 2:
        if len(pts) == 1:
            return [f"{subject} has a value for one period only ({pts[0][0]}: {format_number(pts[0][1], unit)}), so there is no trend to describe yet."], facts
        return [f"{subject} has no values, so there is nothing to summarise."], facts
    (first_p, first_v), (last_p, last_v) = pts[0], pts[-1]
    change = _pct_change(last_v, first_v)
    if last_v > first_v:
        verb = "rose"
    elif last_v < first_v:
        verb = "fell"
    else:
        verb = "was unchanged"
    facts.update(first={"period": first_p, "value": first_v}, last={"period": last_p, "value": last_v}, change_abs=last_v - first_v, change_pct=change)
    if verb == "was unchanged":
        s1 = f"{subject} was the same in {last_p} as in {first_p} ({format_number(last_v, unit)})"
    else:
        s1 = f"{subject} {verb} from {format_number(first_v, unit)} in {first_p} to {format_number(last_v, unit)} in {last_p}"
        if unit.get("percent"):
            s1 += f" ({'+' if last_v >= first_v else '-'}{_gap_text(last_v, first_v, unit)})"
        elif change is not None:
            s1 += f" ({_signed_pct(change)})"
    sentences = [s1 + "."]
    if len(pts) >= 3:
        peak_v = max(v for _, v in pts)
        trough_v = min(v for _, v in pts)
        peaks = [p for p, v in pts if v == peak_v]
        troughs = [p for p, v in pts if v == trough_v]
        facts.update(peak={"period": peaks[0], "value": peak_v}, trough={"period": troughs[0], "value": trough_v})
        if peak_v == trough_v:
            sentences.append(f"It was {format_number(peak_v, unit)} in every period.")
        else:
            peak_txt = f"{format_number(peak_v, unit)} in {peaks[0]}" + (f" (matched in {_join(peaks[1:3])})" if len(peaks) > 1 else "")
            trough_txt = f"{format_number(trough_v, unit)} in {troughs[0]}" + (f" (matched in {_join(troughs[1:3])})" if len(troughs) > 1 else "")
            sentences.append(f"It peaked at {peak_txt} and was lowest at {trough_txt}.")
        (prev_p, prev_v) = pts[-2]
        step = _pct_change(last_v, prev_v)
        facts.update(latest_change_abs=last_v - prev_v, latest_change_pct=step, previous={"period": prev_p, "value": prev_v})
        if last_v == prev_v:
            sentences.append(f"The latest period ({last_p}) is level with {prev_p}.")
        elif unit.get("percent"):
            sentences.append(f"The latest period ({last_p}) is {'up' if last_v > prev_v else 'down'} {_gap_text(last_v, prev_v, unit)} on {prev_p}.")
        elif step is not None:
            sentences.append(f"The latest period ({last_p}) is {'up' if last_v > prev_v else 'down'} {format_percent(step)} on {prev_p}.")
        else:
            sentences.append(f"The latest period ({last_p}) is {'up' if last_v > prev_v else 'down'} {format_number(abs(last_v - prev_v), unit)} on {prev_p}.")
    return sentences, facts


def _ranking_sentences(model: dict, series: dict, subject: str, unit: dict, with_share: bool) -> tuple[list[str], dict]:
    """Highest / runner-up / lowest - for one series over unordered
    categories."""
    pts = [(_dim_label(model, lab), v) for lab, v in _points(model, series)]
    facts: dict = {}
    measure = subject[0].lower() + subject[1:] if subject and not subject[:2].isupper() else subject
    if not pts:
        return [f"Every {measure} value is empty, so there is nothing to summarise."], facts
    if len(pts) == 1:
        return [f"Only {pts[0][0]} has a value ({format_number(pts[0][1], unit)}), so there is nothing to compare it with yet."], facts
    ranked = sorted(pts, key=lambda p: p[1], reverse=True)
    top_v, bottom_v = ranked[0][1], ranked[-1][1]
    facts.update(top={"label": ranked[0][0], "value": top_v}, bottom={"label": ranked[-1][0], "value": bottom_v}, gap_abs=top_v - bottom_v,
                 gap_pct=_pct_change(top_v, bottom_v))
    if top_v == bottom_v:
        return [f"All {len(pts)} {humanize(model['x']['name']).lower() if not chart_model._is_placeholder(model['x']['name']) else 'categories'} values have the same {measure} ({format_number(top_v, unit)})."], facts
    tops = [p for p, v in ranked if v == top_v]
    total = sum(v for _, v in pts)
    share = f" ({format_percent(top_v / total * 100)} of the total)" if with_share and total > 0 and all(v >= 0 for _, v in pts) else ""
    sentences: list[str] = []
    if len(tops) > 1:
        sentences.append(f"{_join(tops[:3])} are tied for the highest {measure} at {format_number(top_v, unit)}{share}.")
        rest = [p for p in ranked if p[1] != top_v]
    else:
        lead = f"{ranked[0][0]} has the highest {measure} at {format_number(top_v, unit)}{share}"
        rest = ranked[1:]
        if len(pts) == 2:
            gap = _gap_text(top_v, bottom_v, unit)
            rel = _pct_change(top_v, bottom_v)
            rel_txt = f" ({format_percent(rel)} higher)" if rel is not None and not unit.get("percent") and bottom_v > 0 else ""
            sentences.append(f"{lead}, versus {format_number(bottom_v, unit)} for {ranked[1][0]} - a gap of {gap}{rel_txt}.")
            return sentences, facts
        sentences.append(f"{lead}, followed by {rest[0][0]} ({format_number(rest[0][1], unit)}).")
    if rest:
        lows = [p for p, v in ranked if v == bottom_v]
        low_txt = _join(lows[:3]) + (" are" if len(lows) > 1 else " is")
        tail = f"{low_txt} lowest at {format_number(bottom_v, unit)}"
        if not unit.get("percent") and bottom_v > 0:
            tail += f", so the top value is {_trim(f'{top_v / bottom_v:.1f}')}x the lowest"
        elif unit.get("percent"):
            tail += f", {_gap_text(top_v, bottom_v, unit)} below the top"
        # The sentence starts with a label, which is kept exactly as written.
        sentences.append(tail + ".")
    return sentences, facts


def _comparison_sentences(model: dict) -> tuple[list[str], dict]:
    """Several comparable series: who is ahead, where. For two series the
    periods / categories each one leads in, with the widest gap spelled
    out; for more, the leader of each."""
    series = model["series"]
    labels = model["x"]["labels"]
    unit = measure_unit(model.get("measure") if model.get("series_by") else series[0]["name"], [v for s in series for v in s["values"]])
    names = [_series_label(model, s["name"]) for s in series]
    facts: dict = {"comparisons": []}
    where = "in" if model["x"].get("ordered") else "for"
    names_by_label = period_names(model)
    shown = [_dim_label(model, names_by_label.get(lab, lab)) for lab in labels]

    # ---- two series: head to head ----
    if len(series) == 2:
        a, b = series
        ahead: list[int] = []
        behind: list[int] = []
        tied: list[int] = []
        for i in range(len(labels)):
            va, vb = a["values"][i], b["values"][i]
            if va is None or vb is None:
                continue
            (ahead if va > vb else behind if vb > va else tied).append(i)
            facts["comparisons"].append({"label": labels[i], names[0]: va, names[1]: vb, "gap": va - vb})
        both = len(ahead) + len(behind) + len(tied)
        if both == 0:
            return [f"{names[0]} and {names[1]} never have a value for the same {humanize(model['x']['name']).lower() if not chart_model._is_placeholder(model['x']['name']) else 'row'}, so they cannot be compared."], facts
        # Lead with whichever is ahead more often.
        first, second, f_idx, s_idx = (0, 1, ahead, behind) if len(ahead) >= len(behind) else (1, 0, behind, ahead)

        def widest(idx: list[int]) -> int:
            return max(idx, key=lambda i: abs(a["values"][i] - b["values"][i]))

        def pair(i: int, lead: int) -> str:
            hi = series[lead]["values"][i]
            lo = series[1 - lead]["values"][i]
            return f"{format_number(hi, unit)} vs {format_number(lo, unit)}"

        parts: list[str] = []
        if f_idx:
            w = widest(f_idx)
            detail = f"({pair(w, first)}{'' if len(f_idx) == 1 else f' {where} {shown[w]}'})"
            if len(f_idx) == both and both > 1:
                parts.append(f"{names[first]} is ahead of {names[second]} {where} {'both' if both == 2 else f'all {both}'} {'periods' if model['x'].get('ordered') else 'categories'} {detail}")
            else:
                parts.append(f"{names[first]} is ahead of {names[second]} {where} {_join([shown[i] for i in f_idx[:6]])}{' and others' if len(f_idx) > 6 else ''} {detail}")
        if s_idx:
            w = widest(s_idx)
            detail = f"({pair(w, second)}{'' if len(s_idx) == 1 else f' {where} {shown[w]}'})"
            parts.append(f"{names[second]} led {where} {_join([shown[i] for i in s_idx[:6]])}{' and others' if len(s_idx) > 6 else ''} {detail}")
        if tied:
            parts.append(f"they are level {where} {_join([shown[i] for i in tied[:6]])}")
        return ["; ".join(parts) + "."], facts

    # ---- more than two: the leader of each period / category ----
    leaders: dict[int, list[int]] = {}
    compared = 0
    for i in range(len(labels)):
        vals = [(si, s["values"][i]) for si, s in enumerate(series) if s["values"][i] is not None]
        if len(vals) < 2:
            continue
        compared += 1
        best = max(v for _, v in vals)
        winners = [si for si, v in vals if v == best]
        if len(winners) == 1:
            leaders.setdefault(winners[0], []).append(i)
    if compared == 0 or not leaders:
        return ["There are not enough values to compare the series with each other."], facts
    order = sorted(leaders, key=lambda si: -len(leaders[si]))
    parts = []
    for rank, si in enumerate(order[:3]):
        idx = leaders[si]
        if len(idx) == compared and compared > 1:
            text = f"{names[si]} is the highest of the {len(series)} {where} {'both' if compared == 2 else f'all {compared}'} {'periods' if model['x'].get('ordered') else 'categories'}"
        else:
            text = f"{names[si]} is highest {where} {_join([shown[i] for i in idx[:5]])}{' and others' if len(idx) > 5 else ''}"
        if rank == 0:
            w = max(idx, key=lambda i: series[si]["values"][i])
            runner = max(((sj, s["values"][w]) for sj, s in enumerate(series) if sj != si and s["values"][w] is not None), key=lambda t: t[1], default=None)
            if runner is not None:
                text += f" ({format_number(series[si]['values'][w], unit)} vs {format_number(runner[1], unit)} for {names[runner[0]]}{'' if len(idx) == 1 else f' {where} {shown[w]}'})"
        parts.append(text)
    return ["; ".join(parts) + "."], facts


def build_insight(model: dict | None, n_phrase: str = "") -> dict | None:
    """The deterministic insight of a chart model, as
    {"key", "implication", "next", "text", "facts"}; None when the model is
    not something a sentence can be written from (a table, a passthrough
    chart). `n_phrase` is appended to the first sentence as written - or, when
    that sentence already ends in a bracket, as a closing sentence of its own (the
    caller decides whether a row count is meaningful - see
    ai_engine._n_phrase)."""
    if not model or model.get("kind") not in ("cartesian", "pie", "kpi"):
        return None
    series = model.get("series") or []
    facts: dict = {"shape": model["kind"]}
    key: list[str] = []
    implication = ""
    nxt = ""

    if model["kind"] == "kpi":
        bits = []
        for s in series:
            v = s["values"][0] if s["values"] else None
            if v is None:
                continue
            bits.append(f"{_measure_name(s['name'])} is {format_number(v, measure_unit(s['name'], [v]))}")
        if not bits:
            key = ["The result is a single empty value, so there is nothing to summarise."]
        else:
            first = bits[0][0].upper() + bits[0][1:]
            key = [_join([first] + bits[1:]) + "."]
        implication = "This is one figure for the whole selection, with nothing to compare it against yet."
        nxt = "Break it down by a category or over time to see what is driving it."
    else:
        x = model["x"]
        ordered = bool(x.get("ordered"))
        xname = "period" if ordered else (humanize(x["name"]).lower() if not chart_model._is_placeholder(x["name"]) else "category")
        if len(series) >= 2 and _comparable(model):
            key, f = _comparison_sentences(model)
            facts.update(f)
            unit = measure_unit(model.get("measure") if model.get("series_by") else series[0]["name"], [v for s in series for v in s["values"]])
            if ordered:
                # How each of the (first two) series moved over the period.
                for s in series[:2]:
                    sentences, tf = _trend_sentences(model, s, _series_label(model, s["name"]), measure_unit(s["name"], s["values"]) or unit)
                    if tf.get("first"):
                        key.append(sentences[0])
                        facts.setdefault("trends", {})[str(s["name"])] = tf
            comps = facts.get("comparisons") or []
            if comps:
                widest = max(comps, key=lambda c: abs(c["gap"]))
                where_label = _dim_label(model, period_names(model).get(widest["label"], widest["label"]))
                implication = f"The gap between the two is widest {'in' if ordered else 'for'} {where_label} ({_gap_text(widest['gap'], 0, unit)})."
            else:
                implication = "Which series is on top changes across the chart, so no single one leads throughout." if len(key) and ";" in key[0] else "One series is on top throughout."
            nxt = f"Look at what differs between the series in the {xname} where the lead changes or the gap is widest."
        elif len(series) >= 2:
            # Measures that are not comparable with each other (different
            # kinds or sizes of number): each is described by itself.
            for s in series[:3]:
                unit = measure_unit(s["name"], s["values"])
                subject = _measure_name(s["name"])
                subject = subject[0].upper() + subject[1:]
                if ordered:
                    sentences, f = _trend_sentences(model, s, subject, unit)
                    key.append(sentences[0])
                else:
                    sentences, f = _ranking_sentences(model, s, subject, unit, False)
                    key.append(sentences[0])
                facts.setdefault("measures", {})[str(s["name"])] = f
            implication = "These measures are on different scales, so each is read against its own axis rather than against the others."
            nxt = f"Pick one measure and break it down further for the {xname} that stands out."
        else:
            s = series[0]
            name = model.get("measure") or s["name"]
            unit = measure_unit(name, s["values"])
            subject = _measure_name(name)
            subject = subject[0].upper() + subject[1:]
            if ordered:
                key, f = _trend_sentences(model, s, subject, unit)
                facts.update(f)
                pts = _points(model, s)
                if len(pts) >= 3:
                    steps = [(pts[i - 1][0], pts[i][0], pts[i][1] - pts[i - 1][1]) for i in range(1, len(pts))]
                    big = max(steps, key=lambda t: abs(t[2]))
                    facts["largest_step"] = {"from": big[0], "to": big[1], "change": big[2]}
                    implication = f"The largest single move is between {big[0]} and {big[1]} ({'+' if big[2] >= 0 else '-'}{_gap_text(big[2], 0, unit)})."
                    nxt = f"Break {subject[0].lower() + subject[1:] if not subject[:2].isupper() else subject} down by another column for {big[1]} to see what drove that move."
                elif len(pts) == 2:
                    implication = "With two periods there is a direction but not yet a pattern."
                    nxt = "Add more periods, or split by a category, to see whether the change is broad or concentrated."
            else:
                key, f = _ranking_sentences(model, s, subject, unit, model["kind"] == "pie")
                facts.update(f)
                if f.get("top") and f.get("bottom") and f["top"]["value"] != f["bottom"]["value"]:
                    implication = f"{f['top']['label']} and {f['bottom']['label']} are the two ends of the range; everything else sits between them."
                    nxt = f"Look at what is different about {f['top']['label']} compared with {f['bottom']['label']}."
    if not key:
        return None
    if n_phrase:
        first = key[0].rstrip(".")
        if first.endswith(")"):
            # The first sentence already closes with its own bracket ("(13.2M
            # vs 6.03M in 2016)"); a second bracket straight after it reads
            # as noise, so the row count becomes a plain closing sentence.
            inner = n_phrase.strip()
            if inner.startswith("(") and inner.endswith(")"):
                inner = inner[1:-1].strip()
            key.append((f"Based on {inner[4:]}" if inner.startswith("n = ") else f"This was {inner}") + ".")
        else:
            key[0] = first + f"{n_phrase}."
    text = f"**Key insight:** {' '.join(key)}"
    if implication:
        text += f"\n**Implication:** {implication}"
    if nxt:
        text += f"\n**Next step:** {nxt}"
    return {"key": " ".join(key), "implication": implication, "next": nxt, "text": text, "facts": facts}


# ---- validating a model-written insight ------------------------------------

_NUMBER_RE = re.compile(
    r"(?<![A-Za-z0-9_])([-+−]?)\s?([$€£]?)(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s?"
    r"(%|percentage points?|percent|pp\b|[KkMBT]\b|thousand|million|billion|trillion|x\b|×)?"
)
_SCALE = {"k": 1e3, "K": 1e3, "thousand": 1e3, "M": 1e6, "million": 1e6, "B": 1e9, "billion": 1e9, "T": 1e12, "trillion": 1e12}


def allowed_numbers(model: dict | None, extra: list | None = None) -> list[float]:
    """Every number an insight about this chart may quote: the table's own
    values, the numbers in its labels, and the figures that follow from
    them by one step of arithmetic (differences, ratios and percentage
    changes between two values of a series or of two series at one
    position, each series' total / mean / min / max / median, shares of a
    total), plus `extra` (row counts)."""
    out: list[float] = [float(v) for v in (extra or []) if isinstance(v, (int, float)) and not isinstance(v, bool)]
    if not model or model.get("kind") not in ("cartesian", "pie", "kpi"):
        return out
    series = [[v for v in s["values"]] for s in model.get("series") or []]
    flat = [v for vals in series for v in vals if v is not None]
    out.extend(flat)
    x = model.get("x") or {}
    for lab in x.get("labels") or []:
        for m in re.finditer(r"\d+(?:\.\d+)?", str(lab)):
            out.append(float(m.group(0)))
    out.append(float(len(x.get("labels") or [])))
    out.append(float(len(series)))

    def derive(a: float, b: float) -> None:
        out.append(a - b)
        out.append(b - a)
        if b:
            out.append(a / b)
            out.append((a - b) / abs(b) * 100)
            out.append(a / b * 100)
        if a:
            out.append(b / a)
            out.append((b - a) / abs(a) * 100)
            out.append(b / a * 100)

    for vals in series:
        present = [v for v in vals if v is not None]
        if not present:
            continue
        total = sum(present)
        out.extend([total, total / len(present), min(present), max(present), median(present), float(len(present))])
        if total:
            out.extend(v / total * 100 for v in present)
        if len(present) <= 60:
            for i in range(len(present)):
                for j in range(i + 1, len(present)):
                    derive(present[i], present[j])
    if len(series) <= 12:
        for i in range(len(series)):
            for j in range(i + 1, len(series)):
                for a, b in zip(series[i], series[j]):
                    if a is not None and b is not None:
                        derive(a, b)
        n = len(series[0]) if series else 0
        for k in range(n):
            col = [s[k] for s in series if s[k] is not None]
            if len(col) > 1:
                tot = sum(col)
                out.append(tot)
                if tot:
                    out.extend(v / tot * 100 for v in col)
    return [v for v in out if isinstance(v, float) and math.isfinite(v)]


def _matches(quoted: float, decimals: int, scale: float, percent: bool, candidates: list[float]) -> bool:
    tol = 0.5 * 10 ** (-decimals) + 1e-9
    for c in candidates:
        for value in ((c, c * 100) if percent else (c,)):
            if abs(abs(value) / scale - quoted) <= tol:
                return True
    return False


def validate_insight_numbers(text: str | None, model: dict | None, extra: list | None = None) -> list[str]:
    """The numbers quoted in `text` that are NOT traceable to the chart
    model (within the rounding the text itself uses: "11.7M" matches
    11,673,501; "37%" matches a rate of 0.3704). Small whole numbers
    (0-12: "two hotels", "top 5") and list markers are never checked. A
    number printed with more than four decimals (a raw float) is always
    reported, whatever it equals. An empty list means every quoted number
    checks out."""
    if not text:
        return []
    candidates = allowed_numbers(model, extra)
    bad: list[str] = []
    for m in _NUMBER_RE.finditer(text):
        _sign, _cur, digits, suffix = m.group(1), m.group(2), m.group(3), (m.group(4) or "")
        raw = digits.replace(",", "")
        try:
            quoted = float(raw)
        except ValueError:
            continue
        decimals = len(raw.split(".")[1]) if "." in raw else 0
        if decimals > 4:
            # 7081020.069999966 - a float printed raw, not a number written
            # for a reader. Whatever it equals, the sentence is not usable.
            bad.append(m.group(0).strip())
            continue
        percent = suffix in ("%", "percent", "pp") or suffix.startswith("percentage point")
        scale = _SCALE.get(suffix, 1.0)
        if decimals == 0 and scale == 1.0 and not percent and quoted <= 12:
            continue
        if not _matches(quoted, decimals, scale, percent, candidates):
            bad.append(m.group(0).strip())
    return bad
