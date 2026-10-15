"""2026-10-14 (R47): example questions for Home, written from the person's own columns
(a measure by a dimension, a measure over time, a why, a prediction) so the first
click already lands on their data. Generic examples only when nothing is connected.
"""
from __future__ import annotations

import re

from ... import models
from ..semantics import human_name
from .analysis import OUTCOME_NAMES, label_of, _entities

_MONEY = re.compile(r"revenue|sales|amount|spend|cost|price|profit|margin|total|net|gross|adr|fee|value|budget", re.I)
_COUNT = re.compile(r"count|orders|bookings|sessions|users|customers|visits|clicks|units|qty|quantity|leads|tickets", re.I)
_ID = re.compile(r"(^|_)id$|_id\b|uuid|key$|code$|number$|zip|postal|phone|email", re.I)
_DIM = re.compile(r"region|country|city|state|channel|segment|category|product|plan|type|status|hotel|store|brand|device|source|campaign|gender|team|agent|market", re.I)
_DATE = re.compile(r"date|time|month|year|week|day|created|updated|_at$", re.I)
_NUM_TYPES = re.compile(r"int|float|numeric|double|decimal|real|bigint|number", re.I)
_DATE_TYPES = re.compile(r"date|time", re.I)
_TEXT_TYPES = re.compile(r"text|char|object|string|varchar|category|bool", re.I)
_YESNO = re.compile(r"churn|cancel|is_|has_|flag|converted|returned|default|fraud", re.I)


def _columns(ds: models.DataSource) -> list[tuple[str, str]]:
    sc = ds.schema_cache if isinstance(ds.schema_cache, dict) else {}
    out = []
    for key, spec in sc.items():
        cols = spec.get("columns") if isinstance(spec, dict) else spec
        for c in cols or []:
            if isinstance(c, dict) and c.get("name"):
                out.append((str(c["name"]), str(c.get("type") or "")))
        if len(out) > 80:
            break
    return out


def for_sources(sources: list[models.DataSource], web: bool) -> list[str]:
    # R50: a table with a yes/no outcome (churn, cancellation) leads - its questions are the richest
    sources = sorted(sources, key=lambda ds: 0 if any(OUTCOME_NAMES.search(n) for n, _ in _columns(ds)) else 1)
    out: list[str] = []
    for ds in sources[:3]:
        cols = _columns(ds)
        if not cols:
            continue
        measures = [n for n, t in cols if (_NUM_TYPES.search(t) and not _ID.search(n)) and (_MONEY.search(n) or _COUNT.search(n))]
        measures = measures or [n for n, t in cols if _NUM_TYPES.search(t) and not _ID.search(n) and not _DATE.search(n)]
        dims = [n for n, t in cols if _TEXT_TYPES.search(t) and _DIM.search(n) and not _ID.search(n)]
        _pri = ("category", "segment", "plan", "product", "region", "channel", "country", "city", "store", "hotel", "campaign", "team", "type", "status")
        dims.sort(key=lambda n: next((i for i, w in enumerate(_pri) if w in n.lower()), len(_pri)))
        dates = [n for n, t in cols if _DATE_TYPES.search(t) or (_DATE.search(n) and not _NUM_TYPES.search(t))]
        yesno = [n for n, t in cols if _YESNO.search(n)]
        outcome = [n for n, t in cols if OUTCOME_NAMES.search(n) and not _NUM_TYPES.search(t)]
        ent = _entities([n for n, _ in cols], ds.name or "")
        d = label_of(dims[0]) if dims else None
        if outcome:
            # 2026-10-15 (R48): an outcome column leads with the analysis questions, in plain words
            noun = "churn" if re.search(r"churn|attrit|lapse", outcome[0], re.I) else "the outcome"
            out.append(f"Why are {ent} leaving, and who is likely to leave next?" if noun == "churn" else f"What drives {label_of(outcome[0])}, and who is most at risk?")
            if d:
                out.append(f"Which {d} loses the most {ent}?" if noun == "churn" else f"How does {label_of(outcome[0])} differ by {d}?")
            sig = next((n for n, t in cols if _NUM_TYPES.search(t) and not _ID.search(n) and re.search(r"inactive|contact|transaction|trans|usage|visits|tenure|months", n, re.I)), None)
            if sig:
                out.append(f"Does {label_of(sig)} predict {noun if noun == 'churn' else label_of(outcome[0])}?")
            out.append("Build a retention dashboard" if noun == "churn" else "Build a dashboard for this")
            break
        money = [n for n in measures if _MONEY.search(n)]
        m = label_of(money[0]) if money else (human_name(measures[0]).lower() if measures else None)
        if m and d:
            out.append(f"{m.capitalize()} by {d}")
        if m and dates:
            out.append(f"Why did {m} change last month?")
        elif m:
            out.append(f"What drives {m}?")
        if yesno and len(out) < 4:
            out.append(f"Predict which {ent} will {human_name(yesno[0]).lower().replace('is ', '').replace('has ', '')}")
        if len(out) >= 4:
            break
    if not out:
        out = ["What if I add two baristas at the morning rush?", "NPV of a $50k machine returning $14k a year for 5 years at 8%"]
    if web:
        out.append("Who is the chief minister of Tamil Nadu?")
    first = next((ds for ds in sources[:3] if _columns(ds)), None)
    first_cols = _columns(first) if first else []
    if any(OUTCOME_NAMES.search(n) for n, _ in first_cols):
        out.append("Alert me if churn in any segment passes 25%")
    else:
        money = [n for n, t in first_cols if _NUM_TYPES.search(t) and not _ID.search(n) and _MONEY.search(n)]
        out.append("Alert me if " + (f"{label_of(money[0])} drops 10%" if money else "churn goes above 3%"))
    seen, uniq = set(), []
    for q in out:
        if q.lower() not in seen:
            seen.add(q.lower())
            uniq.append(q)
    return uniq[:5] if len(uniq) <= 5 else uniq[:4] + [uniq[-1]]  # R50: five, the alert last
