"""2026-10-15 (R50): "alert me if churn in any segment passes 25%" - an alert that watches the outcome rate in
every group of the table's segment columns, not one headline number.

The target lives on the automation like any other threshold target:
    {"kind": "segments", "source_id", "table", "outcome", "positive", "dims": [...], "min_n": 30}
and evaluates to KPIs in the shape services/automations reads: the worst segment first (the number the line is
checked against), then every segment over the line, so the message names them.
"""
from __future__ import annotations

import re

import pandas as pd
from sqlalchemy.orm import Session

from ... import models
from . import analysis, board

MIN_N = 30
MAX_DIMS = 6


class WatchError(Exception):
    pass


def _cap(s: str) -> str:
    return s[:1].upper() + s[1:] if s else s


def _noun(column: str, positive: str) -> str:
    return analysis._outcome_words(column, positive)[1]


def find(db: Session, user: models.User, conv: models.Conversation | None, analysis_state: dict | None = None) -> dict | None:
    """The conversation's table when it has a yes/no outcome: the target an alert would watch, or None."""
    r = (analysis_state or {}).get("analysis") or {}
    source_id = (r.get("table") or {}).get("source_id") or (list(conv.source_ids or []) or [None])[0] if conv is not None else None
    table = (r.get("table") or {}).get("table")
    if not source_id:
        return None
    try:
        if not table:
            from .. import ml_studio
            tables = ml_studio.source_tables(db, user, [source_id])
            table = tables[0]["table"] if tables else None
        df, _ = board.frame(db, user, source_id, table)
    except Exception as e:  # noqa: BLE001 - no table, no segment alert
        print(f"[agent.segment_watch] no table: {e}")
        return None
    prof = board.profile(df)
    outcome = prof.get("outcome")
    if r.get("target", {}).get("column") in df.columns:
        outcome = {"column": r["target"]["column"], "positive": r["target"]["positive"]}
    if not outcome or not prof["dims"]:
        return None
    dims = [d for d in prof["dims"] if d != outcome["column"]][:MAX_DIMS]
    return {"kind": "segments", "source_id": source_id, "table": table, "outcome": outcome["column"], "positive": str(outcome["positive"]),
            "dims": dims, "min_n": MIN_N}


def label(target: dict) -> str:
    noun = _noun(target.get("outcome") or "", target.get("positive") or "")
    return f"Highest segment {noun} rate" if noun in ("churn", "cancellation", "conversion", "default", "fraud", "renewal") else "Highest segment rate"


def segments(df: pd.DataFrame, target: dict) -> list[dict]:
    col, pos = target["outcome"], str(target["positive"])
    if col not in df.columns:
        raise WatchError(f"The column {col} is no longer in {target.get('table')}.")
    y = df[col].astype(str) == pos
    out = []
    for d in target.get("dims") or []:
        if d not in df.columns:
            continue
        g = pd.DataFrame({"g": df[d].astype(str), "y": y}).groupby("g")["y"].agg(["sum", "count"])
        for val, row in g.iterrows():
            n = int(row["count"])
            if n < int(target.get("min_n") or MIN_N) or str(val).lower() in ("nan", "none", ""):
                continue
            out.append({"dim": d, "dim_label": analysis.label_of(d), "value": str(val), "n": n, "hits": int(row["sum"]),
                        "rate": round(100 * float(row["sum"]) / n, 1)})
    out.sort(key=lambda s: -s["rate"])
    return out


def evaluate(db: Session, user: models.User, target: dict, line: float | None = None) -> dict:
    """{kpis, segments, overall, info}. The first KPI is the worst segment."""
    try:
        df, _ = board.frame(db, user, target.get("source_id"), target.get("table"))
    except Exception as e:  # noqa: BLE001
        raise WatchError(f"The table this alert watches could not be read: {e}")
    segs = segments(df, target)
    if not segs:
        raise WatchError(f"No segment has at least {target.get('min_n') or MIN_N} rows to measure.")
    noun = _noun(target["outcome"], target["positive"])
    ent = analysis._entities([str(c) for c in df.columns], target.get("table") or "")
    overall = round(100 * float((df[target["outcome"]].astype(str) == str(target["positive"])).mean()), 1)
    worst = segs[0]
    kpis = [{"key": "worst_segment_rate", "label": label(target), "value": worst["rate"], "display": f"{worst['rate']:.1f}%", "kind": "percent",
             "note": f"{worst['dim_label']}: {worst['value']} · {worst['hits']:,} of {worst['n']:,} {ent}"}]
    over = [s for s in segs if line is not None and s["rate"] > line] or segs[:3]
    for s in over[:5]:
        kpis.append({"key": f"seg:{s['dim']}={s['value']}"[:120], "label": f"{_cap(noun)} rate · {_cap(s['dim_label'])}: {s['value']}",
                     "value": s["rate"], "display": f"{s['rate']:.1f}%", "kind": "percent", "note": f"{s['n']:,} {ent}"})
    ds = db.get(models.DataSource, target.get("source_id") or "")
    return {"kpis": kpis, "segments": segs, "overall": overall, "entities": ent, "noun": noun,
            "info": {"name": f"{(ds.name if ds else target.get('table')) or 'Your data'} · {noun} by segment", "link": "/automations"}}


def first_check(db: Session, user: models.User, target: dict, line: float) -> dict:
    """What the alert would say right now: the segments already over the line, in words."""
    ev = evaluate(db, user, target, line)
    over = [s for s in ev["segments"] if s["rate"] > line]
    groups = len(ev["segments"])
    cols = len({s["dim"] for s in ev["segments"]})
    if over:
        top = over[0]
        rest = f" and {len(over) - 1} more" if len(over) > 1 else ""
        text = (f"{len(over)} segment{'s are' if len(over) != 1 else ' is'} already above {line:g}%: "
                f"{_cap(top['dim_label'])}: {top['value']}, {top['rate']:.1f}% ({top['n']:,} {ev['entities']}){rest}")
    else:
        top = ev["segments"][0]
        text = f"No segment is above {line:g}% yet. The highest is {_cap(top['dim_label'])}: {top['value']} at {top['rate']:.1f}% ({top['n']:,} {ev['entities']})"
    return {"text": text, "over": over[:8], "highest": ev["segments"][0], "groups": groups, "columns": cols, "overall": ev["overall"],
            "noun": ev["noun"], "entities": ev["entities"]}


def watches_text(target: dict, groups: int | None = None, entities: str | None = None) -> str:
    noun = _noun(target.get("outcome") or "", target.get("positive") or "")
    names = [analysis.label_of(d) for d in target.get("dims") or []]
    listed = ", ".join(names[:-1]) + (f" and {names[-1]}" if len(names) > 1 else (names[0] if names else ""))
    many = f"{groups} groups" if groups else "every group"
    return f"{_cap(noun)} rate in {many} of {listed} · groups of {target.get('min_n') or MIN_N}+ {entities or 'rows'}"


def wants_segments(text: str) -> bool:
    return bool(re.search(r"\b(any|every|each|a)\s+(segment|group|category|cohort|band)s?\b|\bsegments?\b|\bby segment\b", text or "", re.I))
