"""
ML Studio (2026-10-08, round 13): start from a goal in words.

  goal ("Which customers are likely to stop buying?")
    -> understood as a problem type, on a source/table, with a target
    -> a PLAN computed from the real data (rows, label, features, what was
       left out and why, how it will be tested, what it will cost)
    -> a TRAINING JOB on a background thread with live stages, a
       leaderboard against a simple baseline, the best-score-by-trial
       curve, the leak check and the resources it used
    -> RESULTS (scores on held-out data, drivers, segments, anomalies or a
       forecast) and per-row scoring with the top reasons.

Problem types that run today: a yes/no or category outcome, a number,
what drives a number, customer segments, anomalies, forecasting one series
and forecasting many series. The rest of the gallery is shown as coming.

Honesty rules, same as everywhere else in GD360:
  - never a silent sample: a table larger than ML_MAX_TRAIN_ROWS trains on
    the first rows and the run says how many of how many;
  - every score is measured on rows the model never saw - the most recent
    ones when there is a time column;
  - every model is compared with a simple baseline it has to beat;
  - columns that give the answer away are removed, with the reason.

Algorithms are scikit-learn: histogram gradient boosting (the LightGBM
algorithm family, built into scikit-learn), random forest and a regularised
linear model, each tuned by seeded random search within a trial and time
budget. Clustering is k-means with k chosen by silhouette; anomalies are
an isolation forest; forecasts use services/forecast.py (the same
backtested exponential-smoothing engine dashboards use).
"""
from __future__ import annotations

import io
import json
import logging
import math
import os
import re
import resource
import threading
import time
import traceback
from datetime import datetime

import joblib
import numpy as np
import pandas as pd
from sklearn.base import BaseEstimator, TransformerMixin
from sklearn.cluster import KMeans
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import (
    HistGradientBoostingClassifier, HistGradientBoostingRegressor, IsolationForest, RandomForestClassifier,
    RandomForestRegressor,
)
from sklearn.impute import SimpleImputer
from sklearn.inspection import permutation_importance
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.metrics import (
    accuracy_score, f1_score, mean_absolute_error, r2_score, roc_auc_score, silhouette_score,
)
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from .. import models
from ..config import get_settings
from ..database import SessionLocal

logger = logging.getLogger("gd360.ml_studio")

# ------------------------------------------------------------- gallery ----

PROBLEMS = [
    {"id": "yes_no", "family": "Predict", "title": "A yes / no outcome", "sub": "Churn, fraud, conversion, late payment", "ready": True},
    {"id": "number", "family": "Predict", "title": "A number", "sub": "Order value, lifetime value, delivery time", "ready": True},
    {"id": "time_to_event", "family": "Predict", "title": "When something will happen", "sub": "Days until a customer leaves or a machine fails", "ready": False},
    {"id": "forecast_one", "family": "Forecast", "title": "One series", "sub": "Revenue, sign-ups or tickets per day", "ready": True},
    {"id": "forecast_many", "family": "Forecast", "title": "Many series at once", "sub": "Demand for every product or store", "ready": True},
    {"id": "what_if", "family": "Forecast", "title": "What-if scenarios", "sub": "Revenue if ad spend rises 20%", "ready": False},
    {"id": "segments", "family": "Discover", "title": "Customer segments", "sub": "Groups that behave alike", "ready": True},
    {"id": "anomalies", "family": "Discover", "title": "Anomalies", "sub": "Orders, days or stores that look wrong", "ready": True},
    {"id": "drivers", "family": "Discover", "title": "What drives a number", "sub": "Ranked drivers of margin or churn", "ready": True},
    {"id": "recommendations", "family": "Decide", "title": "Recommendations", "sub": "Next product for each customer", "ready": False},
    {"id": "uplift", "family": "Decide", "title": "Who responds to an offer", "sub": "Target only people a discount actually moves", "ready": False},
    {"id": "price", "family": "Decide", "title": "Price sensitivity", "sub": "How demand changes with price", "ready": False},
    {"id": "text_tag", "family": "Language", "title": "Sort and tag text", "sub": "Route tickets, tag reviews, detect sentiment", "ready": False},
    {"id": "themes", "family": "Language", "title": "Find themes", "sub": "Topics customers raise most, by month", "ready": False},
    {"id": "doc_facts", "family": "Language", "title": "Pull facts from documents", "sub": "Fields from invoices, contracts, emails", "ready": False},
]
READY = {p["id"] for p in PROBLEMS if p["ready"]}
SUPERVISED = ("yes_no", "number", "drivers")
NEEDS_TARGET = ("yes_no", "number", "drivers")
NEEDS_TIME = ("forecast_one", "forecast_many")

STAGES = {
    "yes_no": [("data", "Load the data"), ("label", "Build the label"), ("features", "Build features"), ("leaks", "Check for leaks"),
               ("train", "Train and tune"), ("test", "Test on held-out rows"), ("explain", "Explain")],
    "number": [("data", "Load the data"), ("label", "Build the label"), ("features", "Build features"), ("leaks", "Check for leaks"),
               ("train", "Train and tune"), ("test", "Test on held-out rows"), ("explain", "Explain")],
    "drivers": [("data", "Load the data"), ("label", "Build the label"), ("features", "Build features"), ("leaks", "Check for leaks"),
                ("train", "Train and tune"), ("test", "Test on held-out rows"), ("explain", "Rank the drivers")],
    "segments": [("data", "Load the data"), ("features", "Build features"), ("train", "Find the groups"), ("explain", "Describe each group")],
    "anomalies": [("data", "Load the data"), ("features", "Build features"), ("train", "Score every row"), ("explain", "Explain the outliers")],
    "forecast_one": [("data", "Load the data"), ("features", "Build the series"), ("train", "Fit and backtest"), ("explain", "Forecast")],
    "forecast_many": [("data", "Load the data"), ("features", "Build the series"), ("train", "Fit and backtest each"), ("explain", "Forecast")],
}

_SEM: threading.Semaphore | None = None
_SEM_LOCK = threading.Lock()


class StudioError(ValueError):
    """Something about the request or the data, said plainly to the person."""


class Stopped(Exception):
    pass


def _sem() -> threading.Semaphore:
    global _SEM
    with _SEM_LOCK:
        if _SEM is None:
            _SEM = threading.Semaphore(max(1, get_settings().ML_MAX_CONCURRENT))
        return _SEM


# ------------------------------------------------------------ sources ----

def source_tables(db: Session, user: models.User, source_ids: list[str] | None = None) -> list[dict]:
    """[{source_id, source, kind, table, key, columns:[{name,type}]}] the person can train on."""
    from .project_engine.catalog import accessible_sources, build_source
    out = []
    for ds in accessible_sources(db, user):
        if source_ids and ds.id not in source_ids:
            continue
        try:
            src = build_source(db, ds, user)
        except Exception:  # noqa: BLE001 - one unreadable source never hides the others
            continue
        for t in src.tables:
            out.append({"source_id": ds.id, "source": ds.name, "kind": ds.kind, "mode": src.mode, "table": t.name,
                        "key": t.source_key, "columns": t.columns[:80]})
    return out


def _table_entry(db: Session, user: models.User, source_id: str, table: str | None) -> dict:
    tables = source_tables(db, user, [source_id])
    if not tables:
        raise StudioError("Pick a data source you can see.")
    if table:
        for t in tables:
            if t["table"] == table or (t["key"] and t["key"] == table):
                return t
        raise StudioError(f"There is no table called {table} in that source.")
    return tables[0]


def load_frame(db: Session, user: models.User, source_id: str, table: str | None) -> tuple[pd.DataFrame, dict, bool]:
    """(data, table entry, capped?) - the person's access rules applied."""
    from . import data_access_rules, synced_sources
    from .data_loader import load_dataframe
    entry = _table_entry(db, user, source_id, table)
    ds = db.get(models.DataSource, source_id)
    cap = get_settings().ML_MAX_TRAIN_ROWS
    if entry["mode"] == "synced":
        df = synced_sources.load_table(db, ds.id, entry["key"])
    else:
        df = load_dataframe(ds, table=entry["key"], version="original", row_limit=cap + 1, db=db)
    capped = len(df) > cap
    if capped:
        df = df.head(cap)
    df = data_access_rules.filter_dataframe_for_role(db, df, ds, user)
    df = df.reset_index(drop=True)
    return df, entry, capped


# -------------------------------------------------------- understanding ----

ML_SYSTEM = """GD360 ML PLANNER
You turn a business goal into a machine-learning problem on the person's data.
Reply with JSON only:
{"problem_type": one of %s,
 "source_id": "...", "table": "...",
 "target": "column to predict or explain, or null",
 "positive_value": "for a yes/no target, the value that means yes, or null",
 "time_column": "date/time column, or null",
 "value_column": "for a forecast: the number to forecast, or null",
 "group_column": "for many series: the column naming each series, or null",
 "horizon": number of future periods for a forecast or null,
 "summary": "one sentence: what will be predicted or found, for whom"}
Use only sources, tables and columns listed. Prefer a yes/no target when the goal
asks "will/likely/which ... stop/churn/buy/convert"; a number when it asks how much
or how many; drivers when it asks what drives/affects/explains a number; segments
for groups/personas/clusters; anomalies for unusual/wrong/outliers/fraud without a
label; forecasts when it asks about future periods."""


def _schema_text(tables: list[dict]) -> str:
    lines = []
    for t in tables[:30]:
        cols = ", ".join(f"{c['name']} ({c.get('type') or '?'})" for c in t["columns"][:40])
        lines.append(f"- source_id={t['source_id']} source=\"{t['source']}\" table={t['table']}: {cols}")
    return "\n".join(lines)


_WORDS = {
    "forecast_many": r"\b(each|every|per)\b.*\b(forecast|next (week|month|quarter)|demand)\b|\bforecast\b.*\b(each|every|per)\b",
    "forecast_one": r"\bforecast|predict next (week|month|quarter|year)|how (much|many) will .* next|projection\b",
    "segments": r"\bsegment|cluster|group(s)? of|persona|kinds of customers|types of customers\b",
    "anomalies": r"\banomal|outlier|unusual|look(s)? wrong|suspicious|odd\b",
    "drivers": r"\bwhat drives|drivers? of|what affects|why (do|does|is)|what explains|influenc",
    "yes_no": r"\b(will|likely|which|who)\b.*\b(stop|churn|leave|cancel|buy|convert|default|fraud|late|return|renew|respond)\b|\bchurn|\bprobability\b",
    "number": r"\bhow (much|many)|predict (the )?(value|amount|revenue|price|time|duration|spend)|estimate\b",
}


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def _guess_type(goal: str) -> str:
    g = goal.lower()
    for pid in ("forecast_many", "forecast_one", "segments", "anomalies", "drivers", "yes_no", "number"):
        if re.search(_WORDS[pid], g):
            return pid
    return "yes_no"


def _is_time(col: dict) -> bool:
    t = (col.get("type") or "").lower()
    n = col["name"].lower()
    return any(x in t for x in ("date", "time")) or bool(re.search(r"(^|_)(date|day|time|month|week|created|at)($|_)", n))


def _is_num(col: dict) -> bool:
    t = (col.get("type") or "").lower()
    return any(x in t for x in ("int", "float", "double", "numeric", "decimal", "number", "real", "bigint"))


def _heuristic(goal: str, tables: list[dict], problem_type: str | None) -> dict:
    """A reasonable starting point without the language model: pick the
    table and columns whose names the goal mentions."""
    ptype = problem_type or _guess_type(goal)
    words = [w for w in re.findall(r"[a-z0-9]+", goal.lower()) if len(w) > 2]
    best, best_score = None, -1.0

    def fits(t: dict) -> float:
        cols = t["columns"]
        has_time = any(_is_time(c) for c in cols)
        has_num = any(_is_num(c) and not _is_time(c) for c in cols)
        if ptype in NEEDS_TIME:
            return 1.0 if (has_time and has_num) else 0.0
        # a richer table is a better place to learn or find structure
        return min(len(cols), 30) / 30

    for t in tables:
        score = sum(1 for w in words if w in _norm(t["table"])) * 2 + sum(1 for c in t["columns"] for w in words if w in _norm(c["name"]))
        score += fits(t)
        if score > best_score:
            best, best_score = t, score
    t = best or (tables[0] if tables else None)
    if not t:
        raise StudioError("Connect a data source first - there is nothing to learn from yet.")
    cols = t["columns"]

    def mentioned(pred):
        ranked = sorted((c for c in cols if pred(c)), key=lambda c: -sum(1 for w in words if w in _norm(c["name"])))
        return ranked[0]["name"] if ranked else None

    time_col = mentioned(_is_time)
    target = None
    if ptype in NEEDS_TARGET:
        target = mentioned(lambda c: not _is_time(c) and sum(1 for w in words if w in _norm(c["name"])) > 0)
        if not target:
            target = mentioned(lambda c: not _is_time(c))
    value_col = mentioned(lambda c: _is_num(c) and not _is_time(c)) if ptype in NEEDS_TIME else None
    group_col = mentioned(lambda c: not _is_num(c) and not _is_time(c)) if ptype == "forecast_many" else None
    return {"problem_type": ptype, "source_id": t["source_id"], "table": t["table"], "target": target, "positive_value": None,
            "time_column": time_col, "value_column": value_col, "group_column": group_col, "horizon": None, "summary": None}


def understand(db: Session, user: models.User, goal: str, problem_type: str | None = None,
               source_id: str | None = None, table: str | None = None) -> dict:
    goal = (goal or "").strip()
    tables = source_tables(db, user, [source_id] if source_id else None)
    if table:
        # round 14: "learn from this table" - the person chose the data
        tables = [t for t in tables if t["table"] == table] or tables
    if not tables:
        raise StudioError("Connect a data source first - there is nothing to learn from yet.")
    spec = None
    if goal and len(goal) > 6:
        try:
            from . import ai_engine
            messages = [
                {"role": "system", "content": ML_SYSTEM % json.dumps(sorted(READY))},
                {"role": "user", "content": f"SOURCES\n{_schema_text(tables)}\n\n"
                 + (f"The person chose the problem type: {problem_type}\n" if problem_type else "")
                 + f"Goal: {goal}"},
            ]
            out = ai_engine._plan_with_retry(messages, max_tokens=1500)
            if isinstance(out, dict):
                spec = out
        except Exception as e:  # noqa: BLE001 - the heuristic below still gives a usable start
            logger.info("[ml_studio] understand fell back to the heuristic: %s", e)
    base = _heuristic(goal or "", tables, problem_type)
    if not spec:
        spec = base
    if problem_type:
        spec["problem_type"] = problem_type
    if spec.get("problem_type") not in READY:
        spec["problem_type"] = base["problem_type"] if base["problem_type"] in READY else "yes_no"
    # keep only names that exist
    t = next((x for x in tables if x["source_id"] == spec.get("source_id") and x["table"] == spec.get("table")), None)
    if not t:
        t = next(x for x in tables if x["source_id"] == base["source_id"] and x["table"] == base["table"])
        for k in ("target", "time_column", "value_column", "group_column"):
            spec[k] = base.get(k)
    names = {c["name"] for c in t["columns"]}
    for k in ("target", "time_column", "value_column", "group_column"):
        if spec.get(k) not in names:
            spec[k] = base.get(k) if base.get(k) in names and base["table"] == t["table"] else None
    spec["source_id"], spec["table"] = t["source_id"], t["table"]
    spec["goal"] = goal
    return spec


# ---------------------------------------------------------------- plan ----

class DateParts(BaseEstimator, TransformerMixin):
    """Turns date columns into month / weekday / day-of-month numbers and
    drops the raw dates (a model can't learn from a timestamp itself)."""

    def __init__(self, columns=None):
        self.columns = columns or []

    def fit(self, X, y=None):
        return self

    def transform(self, X):
        X = X.copy()
        for c in self.columns:
            if c not in X.columns:
                continue
            d = pd.to_datetime(X[c], errors="coerce", utc=True)
            X[f"{c}__month"] = d.dt.month.astype("float")
            X[f"{c}__weekday"] = d.dt.weekday.astype("float")
            X[f"{c}__day"] = d.dt.day.astype("float")
            X = X.drop(columns=[c])
        return X


def _datetime_like(s: pd.Series) -> bool:
    if pd.api.types.is_datetime64_any_dtype(s):
        return True
    if s.dtype == object:
        sample = s.dropna().astype(str).head(50)
        return len(sample) > 0 and bool(sample.str.match(r"^\d{4}-\d{2}-\d{2}").mean() > 0.9)
    return False


def _coerce_numeric_strings(df: pd.DataFrame) -> pd.DataFrame:
    for c in df.columns:
        if df[c].dtype == object:
            sample = df[c].dropna().head(200)
            if len(sample) and pd.to_numeric(sample, errors="coerce").notna().mean() > 0.98:
                df[c] = pd.to_numeric(df[c], errors="coerce")
    return df


def _label(df: pd.DataFrame, spec: dict) -> tuple[pd.Series, dict]:
    """(y, info) for the supervised problem types."""
    target = spec.get("target")
    if not target or target not in df.columns:
        raise StudioError("Pick the column to predict.")
    y = df[target]
    ptype = spec["problem_type"]
    info: dict = {"target": target}
    if ptype == "yes_no" or (ptype == "drivers" and not pd.api.types.is_numeric_dtype(y)):
        vals = y.dropna()
        distinct = vals.astype(str).value_counts()
        if len(distinct) < 2:
            raise StudioError(f"{target} has only one value in this data, so there is nothing to tell apart.")
        if len(distinct) > 20:
            raise StudioError(f"{target} has {len(distinct)} different values - that is a number or an id, not a yes/no outcome. Try “A number”.")
        pos = spec.get("positive_value")
        if len(distinct) == 2:
            if pos is None or str(pos) not in distinct.index:
                pos = _positive_guess(list(distinct.index))
            info.update(kind="binary", positive=str(pos), classes=list(distinct.index),
                        rate=float((vals.astype(str) == str(pos)).mean()))
            return y.astype(str).where(y.notna()), info
        info.update(kind="multiclass", classes=list(distinct.index[:20]))
        return y.astype(str).where(y.notna()), info
    yn = pd.to_numeric(y, errors="coerce")
    if yn.notna().mean() < 0.5:
        raise StudioError(f"{target} isn't a number in most rows. For categories, use “A yes / no outcome”.")
    info.update(kind="number", mean=float(yn.mean()), std=float(yn.std() or 0))
    return yn, info


def _positive_guess(values: list[str]) -> str:
    low = [str(v).lower() for v in values]
    for word in ("1", "true", "yes", "y", "churned", "churn", "fraud", "late", "converted", "positive", "left", "cancelled", "canceled", "default"):
        if word in low:
            return values[low.index(word)]
    return sorted(values, key=lambda v: str(v))[-1]


def _feature_columns(df: pd.DataFrame, spec: dict) -> tuple[list[str], list[dict], list[str]]:
    """(features, excluded with reasons, date columns among the features)."""
    target = spec.get("target")
    exclude = set(spec.get("exclude") or [])
    feats, excluded, dates = [], [], []
    n = len(df)
    for c in df.columns:
        if c == target:
            continue
        if c in exclude:
            excluded.append({"column": c, "reason": "Left out by you."})
            continue
        s = df[c]
        if s.notna().sum() == 0:
            excluded.append({"column": c, "reason": "Empty in every row."})
            continue
        if _datetime_like(s):
            dates.append(c)
            feats.append(c)
            continue
        nun = s.nunique(dropna=True)
        if nun <= 1:
            excluded.append({"column": c, "reason": "The same value in every row."})
            continue
        if not pd.api.types.is_float_dtype(s) and n > 50 and nun >= 0.9 * n:
            excluded.append({"column": c, "reason": "An id (a different value in almost every row) - it can't generalise."})
            continue
        if not pd.api.types.is_numeric_dtype(s) and nun > 200:
            excluded.append({"column": c, "reason": f"Free text or too many categories ({nun:,})."})
            continue
        feats.append(c)
    return feats, excluded, dates


def _preprocessor(df: pd.DataFrame, feats: list[str], dates: list[str], scale: bool) -> tuple[Pipeline, list[str]]:
    expanded = DateParts(dates).transform(df[feats].head(5))
    num = [c for c in expanded.columns if pd.api.types.is_numeric_dtype(expanded[c])]
    cat = [c for c in expanded.columns if c not in num]
    num_steps = [("impute", SimpleImputer(strategy="median"))] + ([("scale", StandardScaler())] if scale else [])
    parts = []
    if num:
        parts.append(("num", Pipeline(num_steps), num))
    if cat:
        parts.append(("cat", Pipeline([
            ("impute", SimpleImputer(strategy="most_frequent")),
            ("onehot", OneHotEncoder(handle_unknown="ignore", sparse_output=False, max_categories=20)),
        ]), cat))
    return Pipeline([("dates", DateParts(dates)), ("prep", ColumnTransformer(parts, remainder="drop"))]), list(expanded.columns)


def _split(df: pd.DataFrame, y: pd.Series, time_col: str | None, classify: bool) -> tuple[np.ndarray, np.ndarray, str]:
    idx = np.arange(len(df))
    if time_col and time_col in df.columns:
        t = pd.to_datetime(df[time_col], errors="coerce", utc=True)
        if t.notna().mean() > 0.9:
            order = np.argsort(t.fillna(t.min()).values, kind="stable")
            cut = int(len(order) * 0.8)
            lo, hi = t.iloc[order[cut]], t.iloc[order[-1]]
            return order[:cut], order[cut:], f"Trained on the older 80% of rows, tested on the most recent 20% ({_d(lo)} → {_d(hi)})"
    strat = y if classify and y.value_counts().min() >= 2 else None
    tr, te = train_test_split(idx, test_size=0.2, random_state=42, stratify=strat)
    return tr, te, "Trained on a random 80% of rows, tested on the other 20% (no time column to test on recent rows)"


def _d(ts) -> str:
    try:
        return pd.Timestamp(ts).strftime("%-d %b %Y")
    except Exception:  # noqa: BLE001
        return str(ts)[:10]


def _fmt_int(n: int) -> str:
    if n >= 1e6:
        return f"{n / 1e6:.1f}M"
    if n >= 1e4:
        return f"{n / 1e3:.1f}k"
    return f"{n:,}"


def make_plan(db: Session, user: models.User, spec: dict) -> dict:
    """The plan shown before training, computed from the real data."""
    ptype = spec.get("problem_type")
    if ptype not in READY:
        raise StudioError("That kind of project isn't available yet - pick one of the others.")
    df, entry, capped = load_frame(db, user, spec["source_id"], spec.get("table"))
    df = _coerce_numeric_strings(df)
    n = len(df)
    if n == 0:
        raise StudioError("That table has no rows you can see.")
    cols = list(df.columns)
    rows: list[dict] = []
    plan: dict = {"problem_type": ptype, "source_id": spec["source_id"], "source": entry["source"], "table": entry["table"],
                  "rows": n, "capped": capped, "columns": cols, "warnings": []}
    cap = get_settings().ML_MAX_TRAIN_ROWS
    data_note = f"{_fmt_int(n)} rows · {len(cols)} columns" + (f" · first {cap:,} rows (server limit)" if capped else "")
    if capped:
        plan["warnings"].append(f"The table has more than {cap:,} rows. This server trains on the first {cap:,} and the results will say so.")

    if ptype in SUPERVISED:
        y, info = _label(df, spec)
        keep = y.notna()
        feats, excluded, dates = _feature_columns(df[keep], spec)
        if spec.get("time_column") in feats:
            pass
        if not feats:
            raise StudioError("No column is usable to learn from - every column is an id, empty or the target itself.")
        suspects = _leak_suspects(df[keep], y[keep], feats, info)
        title, answer, kind = _supervised_titles(spec, info)
        test = ("Trained on older rows, tested on the most recent 20%" if spec.get("time_column") in df.columns
                else "Trained on a random 80% of rows, tested on the other 20%")
        rows = [
            {"k": "Answer", "v": answer, "m": kind},
            {"k": "Label", "v": _label_text(info), "m": f"{int(keep.sum()):,} rows with a known {info['target']}"},
            {"k": "Data", "v": f"{entry['source']} · {entry['table']}", "m": data_note},
            {"k": "Features", "v": f"{len(feats)} columns" + (f", {len(dates)} date{'s' if len(dates) != 1 else ''} turned into month and weekday" if dates else ""),
             "m": ", ".join(feats[:8]) + (" …" if len(feats) > 8 else "")},
            {"k": "Leak check", "v": (f"{len(suspects)} column{'s' if len(suspects) != 1 else ''} look{'s' if len(suspects) == 1 else ''} like the answer itself and will be removed"
                                     if suspects else "No column gives the answer away"),
             "m": ", ".join(s["column"] for s in suspects)},
            {"k": "Fair test", "v": test, "m": f"baseline to beat: {_baseline_name(info, df, feats)}"},
            {"k": "Compute", "v": f"Gradient boosting, random forest and a linear model, tuned in up to {get_settings().ML_TRIALS} trials",
             "m": f"est. {_estimate(n, len(feats))} on this server"},
            {"k": "Output", "v": _output_text(ptype, info), "m": "a new saved table in the same source, with the top reasons per row" if ptype != "drivers" else "ranked drivers with direction"},
        ]
        plan.update(title=title, target=info["target"], label=info, features=feats, excluded=excluded, dates=dates, leak_suspects=suspects)
    elif ptype in ("segments", "anomalies"):
        feats, excluded, dates = _feature_columns(df, {**spec, "target": None})
        if not feats:
            raise StudioError("No column is usable - every column is an id, empty or free text.")
        what = "groups of rows that behave alike" if ptype == "segments" else "the rows that look least like the rest"
        plan["title"] = (f"Find {what} in {entry['table']}")
        rows = [
            {"k": "Answer", "v": "A group for every row, with what makes each group different" if ptype == "segments"
             else "An anomaly score for every row, and the most unusual rows with the reason", "m": "k-means, k chosen by silhouette" if ptype == "segments" else "isolation forest"},
            {"k": "Data", "v": f"{entry['source']} · {entry['table']}", "m": data_note},
            {"k": "Features", "v": f"{len(feats)} columns", "m": ", ".join(feats[:8]) + (" …" if len(feats) > 8 else "")},
            {"k": "Fair test", "v": "Group quality measured by silhouette (how well separated the groups are)" if ptype == "segments"
             else "Each outlier is shown with the columns that make it unusual, so it can be checked", "m": ""},
            {"k": "Compute", "v": "In memory on this server", "m": f"est. {_estimate(n, len(feats), light=True)}"},
            {"k": "Output", "v": "A saved table with each row's group" if ptype == "segments" else "A saved table with each row's anomaly score", "m": ""},
        ]
        plan.update(features=feats, excluded=excluded, dates=dates)
    else:
        spec.setdefault("grain", None)
        tcol, vcol = spec.get("time_column"), spec.get("value_column")
        if not tcol or tcol not in df.columns:
            raise StudioError("Pick the date column the series runs over.")
        if vcol and vcol not in df.columns:
            raise StudioError("Pick the number to forecast.")
        t = pd.to_datetime(df[tcol], errors="coerce", utc=True)
        if t.notna().mean() < 0.8:
            raise StudioError(f"{tcol} isn't a date in most rows.")
        grain = spec.get("grain") or _grain_for(t)
        from . import forecast as fc
        horizon = min(int(spec.get("horizon") or fc.DEFAULT_HORIZON[grain]), fc.MAX_HORIZON[grain])
        periods = t.dt.tz_localize(None).dt.to_period({"day": "D", "week": "W", "month": "M", "quarter": "Q"}[grain]).nunique()
        group = spec.get("group_column")
        if ptype == "forecast_many":
            if not group or group not in df.columns:
                raise StudioError("Pick the column that names each series (product, store …).")
            n_series = int(df[group].nunique())
        what = f"{'sum of ' + vcol if vcol else 'number of rows'} per {grain}"
        plan["title"] = f"Forecast the {what} for the next {horizon} {grain}s" + (f", for each {group}" if ptype == "forecast_many" else "")
        rows = [
            {"k": "Answer", "v": f"The next {horizon} {grain}s with 80% and 95% ranges", "m": "exponential smoothing with seasonality, backtested"},
            {"k": "Series", "v": what + (f" - {min(n_series, 50)} of {n_series} series (the largest)" if ptype == "forecast_many" else ""),
             "m": f"{periods} {grain}s of history · {_d(t.min())} → {_d(t.max())}"},
            {"k": "Data", "v": f"{entry['source']} · {entry['table']}", "m": data_note},
            {"k": "Fair test", "v": "Rolling-origin backtest on the last periods, compared with “same period last season”", "m": "MASE below 1 beats the baseline"},
            {"k": "Compute", "v": "In memory on this server", "m": "seconds"},
            {"k": "Output", "v": "Forecast table and chart", "m": ""},
        ]
        plan.update(grain=grain, horizon=horizon, time_column=tcol, value_column=vcol, group_column=group)
    plan["rows_text"] = rows
    plan["spec"] = {k: spec.get(k) for k in ("problem_type", "source_id", "table", "target", "positive_value", "time_column",
                                             "value_column", "group_column", "horizon", "grain", "exclude", "share", "goal")}
    return plan


def _grain_for(t: pd.Series) -> str:
    span = (t.max() - t.min()).days if t.notna().any() else 0
    if span > 365 * 3:
        return "month"
    if span > 120:
        return "week"
    return "day"


def _estimate(n: int, f: int, light: bool = False) -> str:
    s = max(3, n * max(f, 1) / (2_000_000 if light else 250_000))
    s = min(s, get_settings().ML_TUNE_SECONDS + 60) if not light else s
    return f"{int(s)} s" if s < 90 else f"{int(round(s / 60))} min"


def _supervised_titles(spec: dict, info: dict) -> tuple[str, str, str]:
    goal = (spec.get("goal") or "").strip().rstrip("?")
    if spec["problem_type"] == "drivers":
        return (f"Find what drives {info['target']}", f"The columns that move {info['target']} most, ranked, with direction",
                "drivers from a tuned model")
    if info["kind"] == "binary":
        return (goal and f"Predict, for every row, the chance that {info['target']} is {info['positive']}" or f"Predict {info['target']}",
                "Yes / no, with a probability per row", "binary classification")
    if info["kind"] == "multiclass":
        return f"Predict which {info['target']} each row will have", f"One of {len(info['classes'])} values, with a probability", "classification"
    return f"Predict {info['target']} for every row", f"A number per row ({info['target']})", "regression"


def _label_text(info: dict) -> str:
    if info["kind"] == "binary":
        return f"{info['target']} = {info['positive']} counts as yes ({info['rate'] * 100:.1f}% of rows)"
    if info["kind"] == "multiclass":
        return f"{info['target']}: {', '.join(map(str, info['classes'][:5]))}" + (" …" if len(info["classes"]) > 5 else "")
    return f"{info['target']} (average {info['mean']:,.2f})"


def _output_text(ptype: str, info: dict) -> str:
    if ptype == "drivers":
        return f"What moves {info['target']}, ranked"
    if info["kind"] == "binary":
        return f"A probability that {info['target']} is {info['positive']}, and the top 3 reasons, for every row"
    return f"A predicted {info['target']} and the top 3 reasons for every row"


def _baseline_name(info: dict, df: pd.DataFrame, feats: list[str]) -> str:
    return "the single most telling column alone" if any(pd.api.types.is_numeric_dtype(df[c]) for c in feats) else (
        "always the most common answer" if info["kind"] != "number" else "always the average")


def _leak_suspects(df: pd.DataFrame, y: pd.Series, feats: list[str], info: dict) -> list[dict]:
    """Columns that predict the target almost perfectly on their own - they
    are usually the answer recorded after the fact."""
    out = []
    yy = y
    for c in feats:
        s = df[c]
        try:
            if pd.api.types.is_numeric_dtype(s):
                x = pd.to_numeric(s, errors="coerce")
                ok = x.notna() & yy.notna()
                if ok.sum() < 30:
                    continue
                if info["kind"] == "number":
                    r = float(np.corrcoef(x[ok], yy[ok].astype(float))[0, 1])
                    if abs(r) >= 0.98:
                        out.append({"column": c, "reason": f"Moves almost exactly with {info['target']} (correlation {r:.3f}) - it is very likely derived from the answer."})
                elif info["kind"] == "binary":
                    auc = roc_auc_score((yy[ok] == info["positive"]).astype(int), x[ok])
                    auc = max(auc, 1 - auc)
                    if auc >= 0.995:
                        out.append({"column": c, "reason": f"On its own it tells yes from no {auc * 100:.1f}% of the time - it is very likely recorded after the outcome."})
            else:
                if s.nunique() > 50:
                    continue
                ok = s.notna() & yy.notna()
                if ok.sum() < 30:
                    continue
                purity = pd.crosstab(s[ok].astype(str), yy[ok].astype(str)).max(axis=1).sum() / ok.sum()
                if purity >= 0.995 and s[ok].nunique() > 1 and (info["kind"] != "number"):
                    out.append({"column": c, "reason": f"Each of its values maps to one answer {purity * 100:.1f}% of the time - it gives the answer away."})
        except Exception:  # noqa: BLE001 - a check that can't run is skipped, not guessed
            continue
    return out


# ----------------------------------------------------------- the job ----

def _stage_list(ptype: str) -> list[dict]:
    return [{"id": sid, "title": title, "status": "pending", "note": ""} for sid, title in STAGES[ptype]]


def start(db: Session, user: models.User, spec: dict, name: str, goal: str | None) -> models.MLModel:
    ptype = spec.get("problem_type")
    if ptype not in READY:
        raise StudioError("That kind of project isn't available yet.")
    ds = db.get(models.DataSource, spec.get("source_id") or "")
    from . import workspace_access
    if not ds or not workspace_access.can_edit_datasource(db, ds, user):
        raise StudioError("You need edit access to that data source to train on it.")
    entry = _table_entry(db, user, ds.id, spec.get("table"))
    target = spec.get("target") or spec.get("value_column") or ("segment" if ptype == "segments" else "anomaly" if ptype == "anomalies" else "rows")
    m = models.MLModel(
        owner_id=user.id, workspace_id=ds.workspace_id, datasource_id=ds.id, name=(name or "ML project").strip()[:120],
        target_column=target, status="training", problem_type=ptype, goal=(goal or "").strip() or None,
        table_name=entry["key"], plan={"spec": spec}, started_at=datetime.utcnow(), stop_requested=False,
        progress={"stages": _stage_list(ptype), "leaderboard": [], "curve": [], "trials_done": 0,
                  "trials_total": get_settings().ML_TRIALS if ptype in SUPERVISED else None, "leaks": [], "resources": {},
                  "message": "Waiting for the server…"},
    )
    db.add(m)
    db.commit()
    db.refresh(m)
    threading.Thread(target=_run, args=(m.id,), daemon=True, name=f"ml-{m.id[:8]}").start()
    return m


def restart(db: Session, m: models.MLModel) -> models.MLModel:
    """Train again from the same plan (new data since, same choices)."""
    m.status = "training"
    m.error_message = None
    m.stop_requested = False
    m.started_at = datetime.utcnow()
    m.progress = {"stages": _stage_list(m.problem_type), "leaderboard": [], "curve": [], "trials_done": 0,
                  "trials_total": get_settings().ML_TRIALS if m.problem_type in SUPERVISED else None, "leaks": [],
                  "resources": {}, "message": "Waiting for the server…"}
    db.commit()
    threading.Thread(target=_run, args=(m.id,), daemon=True, name=f"ml-{m.id[:8]}").start()
    return m


def request_stop(db: Session, m: models.MLModel) -> None:
    m.stop_requested = True
    db.commit()


class Job:
    """Progress writes for one run (each commit is visible to the page polling it)."""

    def __init__(self, db: Session, m: models.MLModel):
        self.db, self.m = db, m
        self.t0 = time.time()

    @property
    def progress(self) -> dict:
        return dict(self.m.progress or {})

    def save(self, **fields) -> None:
        p = self.progress
        p.update(fields)
        p["elapsed"] = round(time.time() - self.t0, 1)
        p["resources"] = {**(p.get("resources") or {}), "memory_mb": _rss_mb(), "workers": os.cpu_count() or 1}
        self.m.progress = p
        flag_modified(self.m, "progress")
        self.db.commit()

    def stage(self, sid: str, status: str, note: str = "") -> None:
        p = self.progress
        for s in p.get("stages") or []:
            if s["id"] == sid:
                s["status"] = status
                if note:
                    s["note"] = note
            elif status == "running" and s["status"] == "running":
                s["status"] = "done"
        self.save(stages=p.get("stages"), current=sid if status == "running" else p.get("current"))

    def check_stop(self) -> None:
        self.db.refresh(self.m, attribute_names=["stop_requested"])
        if self.m.stop_requested:
            raise Stopped()


def _read_int(path: str) -> int | None:
    try:
        with open(path) as f:
            v = f.read().strip()
        return None if v in ("max", "") else int(v)
    except Exception:  # noqa: BLE001
        return None


def memory_headroom_mb() -> int | None:
    """Free memory this server can still use, in MB (None = unknown)."""
    limit = get_settings().ML_MEMORY_LIMIT_MB * 1024 * 1024 or None
    if not limit:
        for p in ("/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"):
            v = _read_int(p)
            if v and v < 1 << 50:
                limit = v
                break
    if not limit:
        return None
    used = None
    for p in ("/sys/fs/cgroup/memory.current", "/sys/fs/cgroup/memory/memory.usage_in_bytes"):
        used = _read_int(p)
        if used:
            break
    if not used or get_settings().ML_MEMORY_LIMIT_MB:
        try:
            with open("/proc/self/status") as f:
                for line in f:
                    if line.startswith("VmRSS:"):
                        used = int(line.split()[1]) * 1024
                        break
        except Exception:  # noqa: BLE001
            return None
    return max(0, int((limit - used) / (1024 * 1024)))


def fit_memory(job: "Job", df: pd.DataFrame, n_cols: int, time_col: str | None) -> pd.DataFrame:
    """Keeps a run inside the server's free memory: when the data would not
    fit, it trains on fewer rows (the most recent, when there is a date
    column) and says so on the run - never a silent sample, never a crash
    that takes the whole server down."""
    head = memory_headroom_mb()
    if head is None:
        return df
    per_row = df.memory_usage(deep=True).sum() / max(len(df), 1) * 2 + max(n_cols, 1) * 8 * 14
    need_mb = len(df) * per_row / (1024 * 1024) + 40
    usable = head - 60  # leave room for everything else the server is doing
    if need_mb <= usable:
        return df
    rows_ok = int(len(df) * max(usable, 0) / need_mb * 0.9)
    if rows_ok < 2000:
        raise StudioError(
            f"This server has only about {head} MB of memory free right now, which isn't enough to train on this table. "
            "Try again in a minute, leave out some columns, or move the backend to a larger instance."
        )
    if time_col and time_col in df.columns:
        order = pd.to_datetime(df[time_col], errors="coerce", utc=True).sort_values(na_position="first").index
        df = df.loc[order[-rows_ok:]].reset_index(drop=True)
        which = "the most recent"
    else:
        df = df.head(rows_ok).reset_index(drop=True)
        which = "the first"
    res = dict(job.progress.get("resources") or {})
    res.update(rows_used=rows_ok, memory_limited=True)
    job.save(resources=res, memory_note=f"This server had about {head} MB free, so it trained on {which} {rows_ok:,} rows.")
    return df


def _rss_mb() -> int:
    try:
        return int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024)
    except Exception:  # noqa: BLE001
        return 0


def _run(model_id: str) -> None:
    db = SessionLocal()
    sem = _sem()
    try:
        m = db.get(models.MLModel, model_id)
        if not m:
            return
        job = Job(db, m)
        got = sem.acquire(timeout=1)
        if not got:
            job.save(message="Another training is running on this server - this one starts when it finishes.")
            sem.acquire()
        job.t0 = time.time()
        try:
            user = db.get(models.User, m.owner_id)
            spec = dict((m.plan or {}).get("spec") or {})
            job.save(message="Loading the data…")
            ptype = m.problem_type
            if ptype in SUPERVISED:
                _train_supervised(db, job, user, spec)
            elif ptype == "segments":
                _train_segments(db, job, user, spec)
            elif ptype == "anomalies":
                _train_anomalies(db, job, user, spec)
            else:
                _train_forecast(db, job, user, spec)
            m.status = "ready"
            m.trained_at = datetime.utcnow()
            m.error_message = None
            job.save(message="Done.", current=None)
            try:
                from .ml_training import _record_version
                _record_version(db, m)
            except Exception:  # noqa: BLE001
                logger.warning("[ml_studio] could not record a version for %s", m.id)
            db.commit()
        except Stopped:
            db.rollback()
            m = db.get(models.MLModel, model_id)
            m.status = "failed"
            m.error_message = "Stopped before it finished."
            Job(db, m).save(message="Stopped.")
        except StudioError as e:
            db.rollback()
            m = db.get(models.MLModel, model_id)
            m.status = "failed"
            m.error_message = str(e)
            Job(db, m).save(message=str(e))
        except Exception as e:  # noqa: BLE001
            logger.warning("[ml_studio] training %s failed: %s\n%s", model_id, e, traceback.format_exc())
            db.rollback()
            m = db.get(models.MLModel, model_id)
            m.status = "failed"
            m.error_message = f"Training stopped with an error: {type(e).__name__}: {str(e)[:300]}"
            Job(db, m).save(message=m.error_message)
        finally:
            sem.release()
            import gc
            gc.collect()
    finally:
        db.close()


def _dump(pipe) -> bytes:
    buf = io.BytesIO()
    joblib.dump(pipe, buf)
    return buf.getvalue()


# -------- supervised

def _candidates(kind: str, rng: np.random.RandomState, n_rows: int):
    """(name, label, sampler) - each sampler returns a fresh estimator."""
    classify = kind != "number"
    big = n_rows > 20_000

    def hgb():
        params = dict(learning_rate=float(rng.choice([0.03, 0.05, 0.08, 0.12])), max_leaf_nodes=int(rng.choice([15, 31, 63])),
                      min_samples_leaf=int(rng.choice([10, 20, 50, 100])), l2_regularization=float(rng.choice([0.0, 0.1, 1.0])),
                      max_iter=int(rng.choice([150, 300])), early_stopping=True, random_state=int(rng.randint(1e6)))
        return (HistGradientBoostingClassifier if classify else HistGradientBoostingRegressor)(**params), params

    def forest():
        # depth and leaf size are bounded so a forest stays small in memory and
        # in the saved model, whatever the table size
        depths = [8, 12, 16] if big else [None, 8, 14, 20]
        leaves = [5, 10, 25] if big else [1, 3, 10]
        params = dict(n_estimators=int(rng.choice([100, 200] if not big else [60, 100])), max_depth=depths[int(rng.randint(len(depths)))],
                      min_samples_leaf=int(rng.choice(leaves)), max_features=["sqrt", 0.5][int(rng.randint(2))], n_jobs=1,
                      random_state=int(rng.randint(1e6)))
        return (RandomForestClassifier if classify else RandomForestRegressor)(**params), params

    def linear():
        c = float(rng.choice([0.03, 0.1, 0.3, 1.0, 3.0]))
        if classify:
            return LogisticRegression(C=c, max_iter=2000), {"C": c}
        return Ridge(alpha=1 / c), {"alpha": round(1 / c, 3)}

    return [("hgb", "Gradient boosting", hgb), ("forest", "Random forest", forest),
            ("linear", "Logistic regression" if classify else "Linear (ridge)", linear)]


def _score(kind: str, y_true, model, X, positive=None) -> tuple[float, float | None]:
    """(main score, second score). Binary: ROC AUC, top-10% hit rate.
    Multiclass: accuracy, macro F1. Number: R², MAE."""
    if kind == "binary":
        p = _positive_proba(model, X, positive)
        yt = (np.asarray(y_true) == positive).astype(int)
        auc = roc_auc_score(yt, p) if len(np.unique(yt)) > 1 else float("nan")
        k = max(1, int(len(p) * 0.1))
        top = np.argsort(-p)[:k]
        return float(auc), float(yt[top].mean())
    if kind == "multiclass":
        pred = model.predict(X)
        return float(accuracy_score(y_true, pred)), float(f1_score(y_true, pred, average="macro"))
    pred = model.predict(X)
    return float(r2_score(y_true, pred)), float(mean_absolute_error(y_true, pred))


def _positive_proba(model, X, positive) -> np.ndarray:
    proba = model.predict_proba(X)
    classes = list(model.classes_)
    return proba[:, classes.index(positive)] if positive in classes else proba[:, -1]


def _train_supervised(db: Session, job: Job, user: models.User, spec: dict) -> None:
    s = get_settings()
    m = job.m
    job.stage("data", "running")
    df, entry, capped = load_frame(db, user, spec["source_id"], spec.get("table"))
    df = _coerce_numeric_strings(df)
    total = len(df)
    job.stage("data", "done", f"{total:,} rows · {len(df.columns)} columns" + (" · server row limit reached" if capped else ""))
    job.save(resources={"rows_used": total, "rows_total": total, "capped": capped})
    job.check_stop()
    df = fit_memory(job, df, len(df.columns) + 20, spec.get("time_column"))

    job.stage("label", "running")
    y_all, info = _label(df, spec)
    keep = y_all.notna().values
    df, y = df[keep].reset_index(drop=True), y_all[keep].reset_index(drop=True)
    if len(df) < 40:
        raise StudioError(f"Only {len(df)} rows have a known {info['target']} - at least 40 are needed to learn and test fairly.")
    if info["kind"] != "number":
        vc = y.value_counts()
        if vc.min() < 5:
            raise StudioError(f"“{vc.idxmin()}” appears only {int(vc.min())} times - too few to learn from.")
    job.stage("label", "done", _label_text(info))

    job.stage("features", "running")
    feats, excluded, dates = _feature_columns(df, spec)
    tcol = spec.get("time_column") if spec.get("time_column") in df.columns else None
    if not feats:
        raise StudioError("No column is usable to learn from.")
    job.stage("features", "done", f"{len(feats)} features" + (f" · {len(dates)} date{'s' if len(dates) != 1 else ''} as month/weekday" if dates else ""))
    job.check_stop()

    job.stage("leaks", "running")
    leaks = _leak_suspects(df, y, feats, info)
    leak_cols = {x["column"] for x in leaks}
    feats = [c for c in feats if c not in leak_cols]
    dates = [c for c in dates if c in feats]
    if not feats:
        raise StudioError("Every usable column gives the answer away, so there is nothing fair to learn from.")
    job.stage("leaks", "done", f"{len(leaks)} column{'s' if len(leaks) != 1 else ''} removed" if leaks else "nothing removed")
    job.save(leaks=leaks)

    classify = info["kind"] != "number"
    tr, te, split_text = _split(df, y, tcol, classify)
    X_tr, X_te, y_tr, y_te = df.iloc[tr][feats], df.iloc[te][feats], y.iloc[tr], y.iloc[te]
    # a validation slice of the training rows for tuning (the test rows stay untouched)
    vcut = int(len(tr) * 0.8)
    if tcol:
        fit_idx, val_idx = np.arange(vcut), np.arange(vcut, len(tr))
    else:
        fit_idx, val_idx = train_test_split(np.arange(len(tr)), test_size=0.2, random_state=7,
                                            stratify=y_tr if classify and y_tr.value_counts().min() >= 2 else None)
    X_fit, X_val, y_fit, y_val = X_tr.iloc[fit_idx], X_tr.iloc[val_idx], y_tr.iloc[fit_idx], y_tr.iloc[val_idx]

    job.stage("train", "running")
    positive = info.get("positive")
    board: list[dict] = []
    # baseline: the single most telling numeric column (or the most common answer / the average)
    base_row = _baseline(info, X_fit, y_fit, X_val, y_val, X_te, y_te, positive)
    board.append(base_row)
    job.save(leaderboard=board, split=split_text)

    rng = np.random.RandomState(42)
    cands = _candidates(info["kind"], rng, len(df))
    best: dict | None = None
    curve: list[dict] = []
    trials = 0
    budget_end = time.time() + s.ML_TUNE_SECONDS
    total_trials = max(len(cands), s.ML_TRIALS)
    pattern = [0, 1, 2, 0, 1, 0, 2, 0, 1, 0]  # boosting gets most trials, every algorithm gets some early
    order = [cands[pattern[i % len(pattern)]] for i in range(total_trials)]
    per_alg: dict[str, dict] = {}
    for key, label, _ in cands:
        per_alg[key] = {"algorithm": label, "key": key, "score": None, "second": None, "trials": 0, "state": "waiting"}
        board.append(per_alg[key])
    job.save(leaderboard=board, trials_total=total_trials)
    for key, label, sampler in order:
        if time.time() > budget_end:
            break
        job.check_stop()
        est, params = sampler()
        prep, _expanded = _preprocessor(X_fit, feats, dates, scale=key == "linear")
        pipe = Pipeline([("pre", prep), ("model", est)])
        per_alg[key]["state"] = "running"
        try:
            pipe.fit(X_fit, y_fit)
            sc, second = _score(info["kind"], y_val, pipe, X_val, positive)
        except Exception as e:  # noqa: BLE001 - one bad trial is skipped, not fatal
            logger.info("[ml_studio] trial %s failed: %s", key, e)
            per_alg[key]["state"] = "done" if per_alg[key]["trials"] else "failed"
            continue
        trials += 1
        a = per_alg[key]
        a["trials"] += 1
        if a["score"] is None or _better(info["kind"], sc, a["score"]):
            a.update(score=sc, second=second, params=_json(params))
        a["state"] = "running"
        if best is None or _better(info["kind"], sc, best["score"]):
            best = {"key": key, "label": label, "score": sc, "params": params, "sampler": sampler, "est_params": est.get_params()}
        curve.append({"trial": trials, "best": best["score"], "score": sc, "algorithm": label})
        for k2 in per_alg.values():
            k2["best"] = k2["key"] == best["key"]
        job.save(leaderboard=board, curve=curve, trials_done=trials,
                 message=f"Trial {trials} of {total_trials} · best so far {label} {_metric_text(info['kind'], best['score'])}")
    for a in per_alg.values():
        a["state"] = "done" if a["trials"] else "skipped"
    if best is None:
        raise StudioError("None of the algorithms could be trained on this data.")
    job.stage("train", "done", f"{len(cands)} algorithms · {trials} trials")
    job.save(leaderboard=board)
    job.check_stop()

    # refit every algorithm's best settings on all training rows; test once on the held-out rows
    job.stage("test", "running")
    finals = {}
    for key, label, _ in cands:
        a = per_alg[key]
        if not a["trials"]:
            continue
        est_cls = {"hgb": HistGradientBoostingClassifier if classify else HistGradientBoostingRegressor,
                   "forest": RandomForestClassifier if classify else RandomForestRegressor,
                   "linear": LogisticRegression if classify else Ridge}[key]
        params = dict(a.get("params") or {})
        if key == "linear" and classify:
            params = {"C": params.get("C", 1.0), "max_iter": 2000}
        prep, _ = _preprocessor(X_tr, feats, dates, scale=key == "linear")
        pipe = Pipeline([("pre", prep), ("model", est_cls(**params))])
        pipe.fit(X_tr, y_tr)
        sc, second = _score(info["kind"], y_te, pipe, X_te, positive)
        a["test_score"], a["test_second"] = sc, second
        finals[key] = pipe
    base_row["test_score"], base_row["test_second"] = base_row.get("test_score"), base_row.get("test_second")
    # the winner is chosen on the VALIDATION score (choosing on the test score would flatter it)
    win_key = best["key"] if best["key"] in finals else next(iter(finals))
    winner = finals[win_key]
    w = per_alg[win_key]
    job.stage("test", "done", f"{w['algorithm']}: {_metric_text(info['kind'], w['test_score'])} on {len(te):,} held-out rows "
                              f"vs baseline {_metric_text(info['kind'], base_row.get('test_score'))}")
    job.save(leaderboard=board)
    job.check_stop()

    job.stage("explain", "running")
    drivers = _drivers(winner, X_te, y_te, info, positive, feats)
    job.stage("explain", "done", f"top driver: {drivers[0]['feature']}" if drivers else "")

    m.model_artifact = _dump(winner)
    job.save(resources={**(job.progress.get("resources") or {}), "model_mb": round(len(m.model_artifact) / 1e6, 1)})
    m.feature_columns = feats
    m.excluded_columns = excluded + [{"column": x["column"], "reason": x["reason"]} for x in leaks]
    m.algorithm = f"studio_{win_key}"
    m.task_type = "regression" if info["kind"] == "number" else "classification"
    m.trained_row_count = int(len(tr))
    m.target_column = info["target"]
    total_imp = sum(abs(d["importance"]) for d in drivers) or 1
    m.feature_importance = [{"feature": d["feature"], "importance": round(abs(d["importance"]) / total_imp, 4)} for d in drivers]
    m.metrics = _legacy_metrics(info["kind"], w)
    beat = _better(info["kind"], w["test_score"], base_row.get("test_score")) if base_row.get("test_score") is not None else True
    m.results = {
        "kind": info["kind"], "label": info, "metric": _metric_name(info["kind"]), "second_metric": _second_name(info["kind"]),
        "winner": w["algorithm"], "test_score": w["test_score"], "test_second": w["test_second"],
        "baseline": {"name": base_row["algorithm"], "score": base_row.get("test_score"), "second": base_row.get("test_second")},
        "beats_baseline": bool(beat), "split": split_text, "train_rows": int(len(tr)), "test_rows": int(len(te)),
        "rows_total": total, "capped": capped, "memory_note": job.progress.get("memory_note"),
        "drivers": drivers[:15], "leaks": leaks, "excluded": excluded,
        "features": feats, "positive": positive,
        "warnings": ([] if beat else ["The model did not beat the simple baseline on held-out rows - its scores are no better than a one-column rule. Check the columns it can use."])
        + (["A near-perfect score usually means a column still gives the answer away - check the drivers."]
           if (info["kind"] == "binary" and (w["test_score"] or 0) > 0.995) or (info["kind"] == "number" and (w["test_score"] or 0) > 0.995) else []),
    }
    job.save(leaderboard=board)


def _json(params: dict) -> dict:
    out = {}
    for k, v in params.items():
        if isinstance(v, (np.integer,)):
            v = int(v)
        elif isinstance(v, (np.floating,)):
            v = float(v)
        elif isinstance(v, np.str_):
            v = str(v)
        out[k] = v
    return out


def _better(kind: str, a, b) -> bool:
    if b is None or (isinstance(b, float) and math.isnan(b)):
        return True
    if a is None or (isinstance(a, float) and math.isnan(a)):
        return False
    return a > b  # AUC, accuracy and R² are all "higher is better"


def _metric_name(kind: str) -> str:
    return {"binary": "ROC AUC", "multiclass": "Accuracy", "number": "R²"}[kind]


def _second_name(kind: str) -> str:
    return {"binary": "Top 10% hit rate", "multiclass": "Macro F1", "number": "Mean absolute error"}[kind]


def _metric_text(kind: str, v) -> str:
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return "—"
    if kind == "multiclass":
        return f"{v * 100:.1f}% accuracy"
    return f"{_metric_name(kind)} {v:.3f}"


def _legacy_metrics(kind: str, w: dict) -> dict:
    """The older model page reads accuracy / r2 / mae."""
    if kind == "number":
        return {"r2": w["test_score"], "mae": w["test_second"]}
    if kind == "multiclass":
        return {"accuracy": w["test_score"], "f1_macro": w["test_second"]}
    return {"roc_auc": w["test_score"], "top10_hit_rate": w["test_second"]}


def _baseline(info, X_fit, y_fit, X_val, y_val, X_te, y_te, positive) -> dict:
    kind = info["kind"]
    num = [c for c in X_fit.columns if pd.api.types.is_numeric_dtype(X_fit[c]) and X_fit[c].notna().mean() > 0.5]
    best_col, best_sc = None, None
    for c in num[:40]:
        try:
            mdl = _one_col_model(kind)
            mdl.fit(X_fit[[c]].fillna(X_fit[c].median()), y_fit)
            sc, _ = _score(kind, y_val, mdl, X_val[[c]].fillna(X_fit[c].median()), positive)
            if best_sc is None or _better(kind, sc, best_sc):
                best_col, best_sc = c, sc
        except Exception:  # noqa: BLE001
            continue
    row = {"algorithm": f"Baseline · {best_col} alone" if best_col else ("Baseline · always the average" if kind == "number" else "Baseline · always the most common"),
           "key": "baseline", "trials": None, "state": "done", "baseline": True, "score": best_sc}
    try:
        if best_col:
            mdl = _one_col_model(kind)
            med = X_fit[best_col].median()
            mdl.fit(pd.concat([X_fit, X_val])[[best_col]].fillna(med), pd.concat([y_fit, y_val]))
            sc, second = _score(kind, y_te, mdl, X_te[[best_col]].fillna(med), positive)
        else:
            if kind == "number":
                pred = np.full(len(y_te), float(pd.concat([y_fit, y_val]).mean()))
                sc, second = float(r2_score(y_te, pred)), float(mean_absolute_error(y_te, pred))
            else:
                common = pd.concat([y_fit, y_val]).value_counts().idxmax()
                if kind == "binary":
                    sc, second = 0.5, float((np.asarray(y_te) == positive).mean())
                else:
                    pred = np.full(len(y_te), common, dtype=object)
                    sc, second = float(accuracy_score(y_te, pred)), float(f1_score(y_te, pred, average="macro"))
        row.update(test_score=sc, test_second=second)
        if row["score"] is None:
            row["score"] = sc
    except Exception:  # noqa: BLE001
        pass
    return row


def _one_col_model(kind: str):
    if kind == "number":
        return Ridge(alpha=1.0)
    return LogisticRegression(max_iter=1000)


def _drivers(pipe, X_te: pd.DataFrame, y_te: pd.Series, info: dict, positive, feats: list[str]) -> list[dict]:
    """Permutation importance on held-out rows (how much the score drops
    when a column is shuffled) and the direction each one pushes."""
    n = min(len(X_te), 4000)
    Xs, ys = X_te.iloc[:n], y_te.iloc[:n]
    scoring = "roc_auc" if info["kind"] == "binary" else "accuracy" if info["kind"] == "multiclass" else "r2"
    yy = (ys == positive).astype(int) if info["kind"] == "binary" else ys
    try:
        if info["kind"] == "binary":
            def scoring(est, X, y):
                return roc_auc_score(y, _positive_proba(est, X, positive))
        r = permutation_importance(pipe, Xs, yy, scoring=scoring, n_repeats=3, random_state=0, n_jobs=1)
        imp = r.importances_mean
    except Exception as e:  # noqa: BLE001
        logger.info("[ml_studio] permutation importance failed: %s", e)
        return []
    pred = _positive_proba(pipe, Xs, positive) if info["kind"] == "binary" else (pipe.predict(Xs) if info["kind"] == "number" else None)
    out = []
    for c, v in zip(feats, imp):
        direction = None
        if pred is not None and pd.api.types.is_numeric_dtype(Xs[c]) and Xs[c].nunique() > 1:
            try:
                rho = pd.Series(Xs[c].values).rank().corr(pd.Series(np.asarray(pred, dtype=float)).rank())
                direction = "up" if rho > 0.05 else "down" if rho < -0.05 else None
            except Exception:  # noqa: BLE001
                direction = None
        out.append({"feature": c, "importance": float(v), "direction": direction})
    out.sort(key=lambda d: -d["importance"])
    return [d for d in out if d["importance"] > 0][:20] or out[:5]


# -------- segments / anomalies

def _unsupervised_frame(db, job, user, spec):
    job.stage("data", "running")
    df, entry, capped = load_frame(db, user, spec["source_id"], spec.get("table"))
    df = _coerce_numeric_strings(df)
    job.stage("data", "done", f"{len(df):,} rows · {len(df.columns)} columns" + (" · server row limit reached" if capped else ""))
    job.save(resources={"rows_used": len(df), "rows_total": len(df), "capped": capped})
    if len(df) < 30:
        raise StudioError(f"Only {len(df)} rows - at least 30 are needed.")
    df = fit_memory(job, df, len(df.columns) + 20, None)
    job.stage("features", "running")
    feats, excluded, dates = _feature_columns(df, {**spec, "target": None})
    if not feats:
        raise StudioError("No column is usable - every column is an id, empty or free text.")
    prep, expanded = _preprocessor(df, feats, dates, scale=True)
    X = prep.fit_transform(df[feats])
    job.stage("features", "done", f"{len(feats)} columns")
    job.check_stop()
    return df, feats, excluded, dates, prep, X, capped


def _profile(df: pd.DataFrame, mask: np.ndarray, feats: list[str]) -> list[dict]:
    """What sets a group of rows apart from all rows."""
    out = []
    for c in feats:
        s = df[c]
        if pd.api.types.is_numeric_dtype(s):
            mu, sd = s.mean(), s.std() or 0
            if not sd or not np.isfinite(sd):
                continue
            g = s[mask].mean()
            z = (g - mu) / sd
            out.append({"feature": c, "z": float(z), "text": f"{c} {'higher' if z > 0 else 'lower'} than usual ({_n(g)} vs {_n(mu)})"})
        elif not _datetime_like(s):
            vc_all = s.astype(str).value_counts(normalize=True)
            vc = s[mask].astype(str).value_counts(normalize=True)
            if not len(vc):
                continue
            top = vc.index[0]
            lift = vc.iloc[0] - vc_all.get(top, 0)
            out.append({"feature": c, "z": float(lift * 4), "text": f"{c} = {top} for {vc.iloc[0] * 100:.0f}% (vs {vc_all.get(top, 0) * 100:.0f}% overall)"})
    out.sort(key=lambda d: -abs(d["z"]))
    return out[:4]


def _n(v) -> str:
    try:
        v = float(v)
    except (TypeError, ValueError):
        return str(v)
    a = abs(v)
    if not math.isfinite(v):
        return "—"
    if a >= 1e6:
        return f"{v / 1e6:.1f}M"
    if v.is_integer() and a < 1e4:
        return f"{int(v):,}"
    if a >= 1e4:
        return f"{v / 1e3:.1f}k"
    if a >= 100:
        return f"{v:,.0f}"
    return f"{v:,.2f}"


def _train_segments(db: Session, job: Job, user: models.User, spec: dict) -> None:
    m = job.m
    df, feats, excluded, dates, prep, X, capped = _unsupervised_frame(db, job, user, spec)
    job.stage("train", "running")
    rng = np.random.RandomState(0)
    sample = rng.choice(len(X), size=min(len(X), 8000), replace=False)
    board, curve, best = [], [], None
    for k in range(2, 9):
        job.check_stop()
        km = KMeans(n_clusters=k, n_init=5, random_state=0)
        km.fit(X)
        sil = float(silhouette_score(X[sample], km.labels_[sample])) if len(set(km.labels_[sample])) > 1 else -1
        board.append({"algorithm": f"{k} groups", "key": f"k{k}", "score": sil, "second": None, "trials": 1, "state": "done"})
        if best is None or sil > best[1]:
            best = (k, sil, km)
        curve.append({"trial": k - 1, "best": best[1], "score": sil, "algorithm": f"k={k}"})
        for r in board:
            r["best"] = r["key"] == f"k{best[0]}"
        job.save(leaderboard=board, curve=curve, trials_done=k - 1, trials_total=7, message=f"Tried {k} groups · best so far {best[0]} (silhouette {best[1]:.3f})")
    k, sil, km = best
    job.stage("train", "done", f"{k} groups · silhouette {sil:.3f}")
    job.stage("explain", "running")
    labels = km.labels_
    groups = []
    for g in range(k):
        mask = labels == g
        prof = _profile(df, mask, feats)
        name = " · ".join(p["text"].split(" (")[0] for p in prof[:2]) or f"Group {g + 1}"
        groups.append({"id": int(g), "name": name, "rows": int(mask.sum()), "share": float(mask.mean()), "traits": prof})
    groups.sort(key=lambda gr: -gr["rows"])
    job.stage("explain", "done", f"{k} groups described")
    m.model_artifact = _dump(Pipeline([("pre", prep), ("model", km)]))
    m.feature_columns, m.excluded_columns, m.algorithm, m.task_type = feats, excluded, "studio_kmeans", "clustering"
    m.trained_row_count = int(len(df))
    m.metrics = {"silhouette": sil, "groups": k}
    m.results = {"kind": "segments", "groups": groups, "silhouette": sil, "k": k, "rows_total": int(len(df)), "capped": capped,
                 "features": feats, "excluded": excluded,
                 "warnings": [] if sil >= 0.15 else ["The groups overlap a lot (low silhouette) - the data may not split into clear groups."]}
    job.save(leaderboard=board)


def _train_anomalies(db: Session, job: Job, user: models.User, spec: dict) -> None:
    m = job.m
    df, feats, excluded, dates, prep, X, capped = _unsupervised_frame(db, job, user, spec)
    job.stage("train", "running")
    share = min(max(float(spec.get("share") or 0.02), 0.001), 0.2)
    iso = IsolationForest(n_estimators=200, contamination=share, random_state=0, n_jobs=1)
    iso.fit(X)
    score = -iso.score_samples(X)  # higher = more unusual
    flagged = iso.predict(X) == -1
    job.stage("train", "done", f"{int(flagged.sum()):,} of {len(df):,} rows flagged (the most unusual {share * 100:g}%)")
    job.check_stop()
    job.stage("explain", "running")
    num = [c for c in feats if pd.api.types.is_numeric_dtype(df[c])]
    mu = df[num].mean() if num else pd.Series(dtype=float)
    sd = df[num].std().replace(0, np.nan) if num else pd.Series(dtype=float)
    top = np.argsort(-score)[:50]
    rows = []
    for i in top:
        reasons = []
        if num:
            z = ((df.iloc[i][num] - mu) / sd).astype(float).abs().sort_values(ascending=False)
            for c in z.index[:3]:
                if np.isfinite(z[c]) and z[c] >= 2:
                    reasons.append(f"{c} = {_n(df.iloc[i][c])} (usually {_n(mu[c])})")
        rows.append({"row": int(i), "score": float(score[i]), "reasons": reasons or ["an unusual combination of values"],
                     "values": {c: _jsonable(df.iloc[i][c]) for c in feats[:8]}})
    job.stage("explain", "done", "top 50 explained")
    m.model_artifact = _dump(Pipeline([("pre", prep), ("model", iso)]))
    m.feature_columns, m.excluded_columns, m.algorithm, m.task_type = feats, excluded, "studio_isolation_forest", "anomaly"
    m.trained_row_count = int(len(df))
    m.metrics = {"flagged": int(flagged.sum()), "flagged_share": float(flagged.mean())}
    m.results = {"kind": "anomalies", "flagged": int(flagged.sum()), "rows_total": int(len(df)), "capped": capped, "top": rows,
                 "features": feats, "excluded": excluded,
                 "threshold": float(np.min(score[flagged])) if flagged.any() else None, "warnings": []}
    job.save(leaderboard=[{"algorithm": "Isolation forest", "key": "iso", "score": float(flagged.mean()), "trials": 1, "state": "done", "best": True}])


def _jsonable(v):
    if v is None or (isinstance(v, float) and not math.isfinite(v)):
        return None
    if hasattr(v, "item"):
        try:
            return v.item()
        except Exception:  # noqa: BLE001
            return str(v)
    if isinstance(v, (pd.Timestamp, datetime)):
        return str(v)[:19]
    return v


# -------- forecasts

def _train_forecast(db: Session, job: Job, user: models.User, spec: dict) -> None:
    from . import forecast as fc
    m = job.m
    job.stage("data", "running")
    df, entry, capped = load_frame(db, user, spec["source_id"], spec.get("table"))
    df = _coerce_numeric_strings(df)
    job.stage("data", "done", f"{len(df):,} rows" + (" · server row limit reached" if capped else ""))
    job.save(resources={"rows_used": len(df), "rows_total": len(df), "capped": capped})
    tcol, vcol, gcol = spec.get("time_column"), spec.get("value_column"), spec.get("group_column")
    if not tcol or tcol not in df.columns:
        raise StudioError("Pick the date column the series runs over.")
    job.stage("features", "running")
    t = pd.to_datetime(df[tcol], errors="coerce", utc=True).dt.tz_localize(None)
    grain = spec.get("grain") or _grain_for(t)
    horizon = min(int(spec.get("horizon") or fc.DEFAULT_HORIZON[grain]), fc.MAX_HORIZON[grain])
    work = pd.DataFrame({"t": t, "v": pd.to_numeric(df[vcol], errors="coerce") if vcol else 1.0})
    if gcol:
        work["g"] = df[gcol].astype(str)
    work = work.dropna(subset=["t"])

    code = {"day": "D", "week": "W-SUN", "month": "M", "quarter": "Q"}[grain]

    def series_of(frame: pd.DataFrame) -> tuple[list[str], list]:
        start = frame["t"].dt.to_period(code).dt.start_time
        s = frame.groupby(start)["v"].sum(min_count=1).sort_index()
        return [d.date().isoformat() for d in s.index], [None if pd.isna(v) else float(v) for v in s.values]

    groups = [None]
    if spec.get("problem_type") == "forecast_many":
        if not gcol or gcol not in df.columns:
            raise StudioError("Pick the column that names each series.")
        totals = work.groupby("g")["v"].sum().sort_values(ascending=False)
        groups = list(totals.index[:50])
    job.stage("features", "done", f"{len(groups) if groups != [None] else 1} series by {grain}")
    job.stage("train", "running")
    out, board, curve = [], [], []
    for i, g in enumerate(groups):
        job.check_stop()
        frame = work if g is None else work[work["g"] == g]
        periods, values = series_of(frame)
        try:
            partial = fc.partial_periods(periods, grain, {"max": frame["t"].max().date().isoformat(), "min": frame["t"].min().date().isoformat()})
        except Exception:  # noqa: BLE001
            partial = None
        r = fc.forecast_series(periods, values, grain=grain, horizon=horizon, additive=True, partial=partial, want_anomalies=False)
        bt = r.get("backtest") or {}
        mase = bt.get("mase")
        out.append({"series": g, "status": r.get("status"), "reason": r.get("reason"), "method": r.get("method"),
                    "history": [{"period": p, "value": v} for p, v in zip(periods, values) if p not in (r.get("excluded") or [])][-120:],
                    "excluded": r.get("excluded") or [],
                    "points": r.get("points") or [], "backtest": bt, "mase": mase, "notes": r.get("notes") or []})
        board.append({"algorithm": str(g) if g is not None else (vcol or "rows"), "key": f"s{i}", "score": mase, "second": None,
                      "trials": 1, "state": "done" if r.get("status") == "ok" else "skipped", "method": r.get("method")})
        curve.append({"trial": i + 1, "best": None, "score": mase, "algorithm": str(g)})
        job.save(leaderboard=board[-60:], trials_done=i + 1, trials_total=len(groups),
                 message=f"Series {i + 1} of {len(groups)}")
    ok = [s for s in out if s["status"] == "ok"]
    if not ok:
        raise StudioError(out[0]["reason"] if out and out[0].get("reason") else "Not enough history to forecast.")
    job.stage("train", "done", f"{len(ok)} of {len(out)} series forecast")
    job.stage("explain", "done", f"next {horizon} {grain}s")
    m.model_artifact = None
    m.feature_columns, m.algorithm, m.task_type = [c for c in (tcol, vcol, gcol) if c], "studio_ets", "forecast"
    m.trained_row_count = int(len(work))
    mases = [s["mase"] for s in ok if isinstance(s.get("mase"), (int, float))]
    m.metrics = {"series": len(ok), "median_mase": float(np.median(mases)) if mases else None}
    m.results = {"kind": "forecast", "grain": grain, "horizon": horizon, "value": vcol or "rows", "group": gcol, "series": out,
                 "rows_total": int(len(df)), "capped": capped, "warnings": [s["reason"] for s in out if s["status"] != "ok"][:5]}


# ---------------------------------------------------------- scoring ----

def score_frame(m: models.MLModel, df: pd.DataFrame) -> pd.DataFrame:
    """Every row scored - with the top 3 reasons for supervised models."""
    if m.task_type == "forecast":
        raise StudioError("A forecast predicts periods, not rows - its forecast table is on the results page.")
    pipe = joblib.load(io.BytesIO(m.model_artifact))
    feats = m.feature_columns or []
    X = _coerce_numeric_strings(df.copy()).reindex(columns=feats)
    out = df.copy()
    res = m.results or {}
    if m.task_type == "clustering":
        labels = pipe.predict(X)
        names = {g["id"]: g["name"] for g in res.get("groups") or []}
        out["segment"] = labels
        out["segment_name"] = [names.get(int(x), f"Group {int(x) + 1}") for x in labels]
        return out
    if m.task_type == "anomaly":
        out["anomaly_score"] = -pipe.score_samples(X)
        out["is_anomaly"] = pipe.predict(X) == -1
        return out
    target = m.target_column
    kind = res.get("kind")
    if kind == "binary":
        p = _positive_proba(pipe, X, res.get("positive"))
        out[f"chance_{target}_{res.get('positive')}"] = np.round(p, 4)
        base = p
    else:
        pred = pipe.predict(X)
        out[f"predicted_{target}"] = pred
        base = pred if kind == "number" else None
    if base is not None and len(X) <= 50_000:
        reasons = _row_reasons(pipe, X, kind, res.get("positive"), [d["feature"] for d in (res.get("drivers") or [])][:8], base)
        for i in range(3):
            out[f"reason_{i + 1}"] = [r[i] if len(r) > i else None for r in reasons]
    return out


def _row_reasons(pipe, X: pd.DataFrame, kind, positive, top_feats: list[str], base) -> list[list[str]]:
    """For each row: the columns whose usual value would move its score
    the most (each top column set to its median / most common value)."""
    effects = {}
    for c in top_feats:
        if c not in X.columns:
            continue
        Xc = X.copy()
        s = X[c]
        Xc[c] = s.median() if pd.api.types.is_numeric_dtype(s) else (s.mode().iloc[0] if s.notna().any() else None)
        alt = _positive_proba(pipe, Xc, positive) if kind == "binary" else pipe.predict(Xc)
        effects[c] = np.asarray(base, dtype=float) - np.asarray(alt, dtype=float)
    if not effects:
        return [[] for _ in range(len(X))]
    cols = list(effects)
    mat = np.column_stack([effects[c] for c in cols])
    out = []
    for i in range(len(X)):
        order = np.argsort(-np.abs(mat[i]))[:3]
        reasons = []
        for j in order:
            e = mat[i, j]
            if abs(e) < 1e-9:
                continue
            c = cols[j]
            amount = f"{e * 100:+.0f} pts" if kind == "binary" else f"{e:+,.2f}"
            reasons.append(f"{c} = {_n(X.iloc[i][c]) if X.iloc[i][c] is not None else '—'} ({amount})")
        out.append(reasons)
    return out


def recover_interrupted() -> None:
    db = SessionLocal()
    try:
        rows = db.query(models.MLModel).filter(models.MLModel.status == "training", models.MLModel.problem_type.isnot(None)).all()
        for m in rows:
            m.status = "failed"
            m.error_message = "The server restarted while this was training - start it again."
        if rows:
            db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()
    finally:
        db.close()
