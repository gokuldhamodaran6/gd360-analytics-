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
from collections import Counter
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
from . import ml_studio_methods as _m

logger = logging.getLogger("gd360.ml_studio")

# ------------------------------------------------------------- gallery ----

# 2026-10-09 (round 15): all 21 kinds run. Each entry also says what the data
# needs ("needs", shown on the card) and which spec fields the page collects
# ("fields": key, label, type, required). Field types: column, columns (a
# list of column names), value (one value of another column), number, text,
# list (of words) and scenario ({column: percent change, e.g. 20 = +20%}).
def _f(key: str, label: str, type_: str = "column", required: bool = False, hint: str | None = None, of: str | None = None) -> dict:
    out = {"key": key, "label": label, "type": type_, "required": required}
    if hint:
        out["hint"] = hint
    if of:
        out["of"] = of
    return out


_EXCL = _f("exclude", "Columns to leave out", "columns")
_TIME_TEST = _f("time_column", "Date for a fair test (train on older rows, test on newer)", hint="optional")
PROBLEMS = [
    {"id": "yes_no", "family": "Predict", "title": "A yes / no outcome", "sub": "Churn, fraud, conversion, late payment", "needs": "one row per case",
     "fields": [_f("target", "What to predict", required=True), _f("positive_value", "The value that means yes", "value", of="target"), _TIME_TEST, _EXCL]},
    {"id": "which_category", "family": "Predict", "title": "Which category", "sub": "Plan, segment, product line or reason a case will fall in",
     "needs": "one row per case", "fields": [_f("target", "The category column (3 to 30 values)", required=True), _TIME_TEST, _EXCL]},
    {"id": "number", "family": "Predict", "title": "A number", "sub": "Order value, lifetime value, delivery time", "needs": "one row per case",
     "fields": [_f("target", "The number to predict", required=True), _TIME_TEST, _EXCL]},
    {"id": "time_to_event", "family": "Predict", "title": "When something will happen", "sub": "Days until a customer leaves or a machine fails",
     "needs": "start and end dates",
     "fields": [_f("start_column", "When the clock starts (date)", hint="or give a duration column"), _f("end_column", "When it happened or was last seen (date)"),
                _f("duration_column", "Or: duration in days"), _f("event_column", "Has it happened? (1 = yes, 0 or empty = still waiting)"),
                _f("group_column", "Compare groups (optional)"), _f("horizon", "Within how many days?", "number", hint="defaults to the median"), _EXCL]},
    {"id": "forecast_one", "family": "Forecast", "title": "One series", "sub": "Revenue, sign-ups or tickets per day", "needs": "a date and a number",
     "fields": [_f("time_column", "Date", required=True), _f("value_column", "Number to forecast (empty = count rows)"), _f("horizon", "Periods ahead", "number"),
                _f("grain", "day / week / month / quarter", "text")]},
    {"id": "forecast_many", "family": "Forecast", "title": "Many series at once", "sub": "Demand for every product or store", "needs": "date, item, number",
     "fields": [_f("time_column", "Date", required=True), _f("group_column", "What names each series", required=True), _f("value_column", "Number to forecast"),
                _f("horizon", "Periods ahead", "number"), _f("grain", "day / week / month / quarter", "text")]},
    {"id": "what_if", "family": "Forecast", "title": "What-if scenarios", "sub": "Revenue if ad spend rises 20%", "needs": "date, drivers, outcome",
     "fields": [_f("time_column", "Date", required=True), _f("value_column", "Outcome (e.g. revenue)", required=True),
                _f("drivers", "Drivers you could change", "columns", hint="empty = every other number"),
                _f("scenario", "Scenario: % change per driver", "scenario", hint="e.g. {\"ad_spend\": 20}"),
                _f("grain", "day / week / month", "text"), _f("horizon", "Periods to compare (most recent)", "number")]},
    {"id": "marketing_mix", "family": "Forecast", "title": "Spend → sales (marketing mix)", "sub": "What each channel’s spend adds to sales, with diminishing returns",
     "needs": "weekly spend + sales",
     "fields": [_f("time_column", "Date", required=True), _f("value_column", "Sales or revenue", required=True),
                _f("spend_columns", "One spend column per channel", "columns", hint="empty = columns named spend, cost or budget")]},
    {"id": "segments", "family": "Discover", "title": "Customer segments", "sub": "Groups that behave alike", "needs": "one row per entity", "fields": [_EXCL]},
    {"id": "anomalies", "family": "Discover", "title": "Anomalies", "sub": "Orders, days or stores that look wrong", "needs": "any table",
     "fields": [_EXCL, _f("share", "Share of rows to flag (0.02 = 2%)", "number")]},
    {"id": "drivers", "family": "Discover", "title": "What drives a number", "sub": "Ranked drivers of margin or churn", "needs": "outcome + causes",
     "fields": [_f("target", "The outcome", required=True), _TIME_TEST, _EXCL]},
    {"id": "bought_together", "family": "Discover", "title": "Bought together", "sub": "Products that sell together, for bundles and cross-sell",
     "needs": "orders with lines", "fields": [_f("order_column", "Order id", required=True), _f("item_column", "Product", required=True)]},
    {"id": "cohorts", "family": "Discover", "title": "Cohort retention", "sub": "How each month’s new customers keep buying", "needs": "customer + order dates",
     "fields": [_f("entity_column", "Customer", required=True), _f("time_column", "Order date", required=True), _f("value_column", "Order value (optional)")]},
    {"id": "recommendations", "family": "Decide", "title": "Recommendations", "sub": "Next product for each customer", "needs": "who bought or viewed what",
     "fields": [_f("entity_column", "Customer or user", required=True), _f("item_column", "Product or content", required=True),
                _f("value_column", "Weight, e.g. quantity or rating (optional)"), _f("time_column", "Date (optional, for a fairer test)")]},
    {"id": "uplift", "family": "Decide", "title": "Who responds to an offer", "sub": "Target only people a discount actually moves", "needs": "a past test or campaign",
     "fields": [_f("treatment_column", "Who got the offer (two groups)", required=True), _f("treated_value", "The value that means they got it", "value", of="treatment_column"),
                _f("target", "The outcome (yes/no or a number)", required=True), _f("positive_value", "For yes/no: the value that means yes", "value", of="target"), _EXCL]},
    {"id": "price", "family": "Decide", "title": "Price sensitivity", "sub": "How demand changes with price", "needs": "price and units over time",
     "fields": [_f("item_column", "Product", required=True), _f("price_column", "Price", required=True), _f("units_column", "Units sold", required=True),
                _f("time_column", "Date (optional, adds seasonality)")]},
    {"id": "attribution", "family": "Decide", "title": "Channel credit (attribution)", "sub": "Which channels deserve credit for each sale",
     "needs": "touchpoints + orders",
     "fields": [_f("entity_column", "Person (user or customer)", required=True), _f("channel_column", "Channel", required=True), _f("time_column", "Date and time", required=True),
                _f("conversion_column", "Converted on this row? (1 / 0)", hint="or use an event column + value"), _f("event_column", "Or: event column"),
                _f("conversion_value", "Event value that means a sale", "value", of="event_column"), _f("value_column", "Revenue (optional)")]},
    {"id": "text_tag", "family": "Language", "title": "Sort and tag text", "sub": "Route tickets, tag reviews, detect sentiment", "needs": "a text column",
     "fields": [_f("text_column", "Text", required=True), _f("label_column", "Existing tags to learn from (optional)"),
                _f("tags", "Tags to use (optional; otherwise suggested)", "list")]},
    {"id": "sentiment", "family": "Language", "title": "Sentiment", "sub": "Praise, questions and complaints in comments and reviews", "needs": "a text column",
     "fields": [_f("text_column", "Text", required=True), _f("time_column", "Date (optional, for a by-month view)")]},
    {"id": "themes", "family": "Language", "title": "Find themes", "sub": "Topics customers raise most, by month", "needs": "a text column + date",
     "fields": [_f("text_column", "Text", required=True), _f("time_column", "Date (optional)"), _f("k", "Number of themes (4-10, empty = chosen)", "number")]},
    {"id": "doc_facts", "family": "Language", "title": "Pull facts from documents", "sub": "Fields from invoices, contracts, emails", "needs": "document text in a column",
     "fields": [_f("text_column", "Document text", required=True), _f("fields", "Fields to pull out", "list", hint="default: date, amount, party, reference")]},
]
for _p in PROBLEMS:
    _p["ready"] = True
READY = {p["id"] for p in PROBLEMS if p["ready"]}
SUPERVISED = ("yes_no", "number", "drivers", "which_category")
NEEDS_TARGET = ("yes_no", "number", "drivers", "which_category", "uplift")
NEEDS_TIME = ("forecast_one", "forecast_many")
# kinds that run the tuned supervised machinery (leaderboard of trials)
TUNED = SUPERVISED + ("time_to_event",)
SPEC_KEYS = ("problem_type", "source_id", "table", "target", "positive_value", "time_column", "value_column", "group_column", "horizon", "grain",
             "exclude", "share", "goal", "joins", "space_id", "start_column", "end_column", "duration_column", "event_column", "drivers",
             "scenario", "spend_columns", "order_column", "item_column", "entity_column", "treatment_column", "treated_value", "price_column",
             "units_column", "channel_column", "conversion_column", "conversion_value", "text_column", "label_column", "tags", "fields",
             "fields_how", "k")
COLUMN_KEYS = ("target", "time_column", "value_column", "group_column", "start_column", "end_column", "duration_column", "event_column",
               "order_column", "item_column", "entity_column", "treatment_column", "price_column", "units_column", "channel_column",
               "conversion_column", "text_column", "label_column")
LIST_KEYS = ("drivers", "spend_columns")

_SUP_STAGES = [("data", "Load the data"), ("label", "Build the label"), ("features", "Build features"), ("leaks", "Check for leaks"),
               ("train", "Train and tune"), ("test", "Test on held-out rows"), ("explain", "Explain")]
STAGES = {
    "yes_no": _SUP_STAGES,
    "number": _SUP_STAGES,
    "which_category": _SUP_STAGES[:-1] + [("explain", "Explain each category")],
    "drivers": [("data", "Load the data"), ("label", "Build the label"), ("features", "Build features"), ("leaks", "Check for leaks"),
                ("train", "Train and tune"), ("test", "Test on held-out rows"), ("explain", "Rank the drivers")],
    "segments": [("data", "Load the data"), ("features", "Build features"), ("train", "Find the groups"), ("explain", "Describe each group")],
    "anomalies": [("data", "Load the data"), ("features", "Build features"), ("train", "Score every row"), ("explain", "Explain the outliers")],
    "forecast_one": [("data", "Load the data"), ("features", "Build the series"), ("train", "Fit and backtest"), ("explain", "Forecast")],
    "forecast_many": [("data", "Load the data"), ("features", "Build the series"), ("train", "Fit and backtest each"), ("explain", "Forecast")],
    # 2026-10-09 (round 15): the newer kinds
    "time_to_event": [("data", "Load the data"), ("durations", "Work out durations"), ("curves", "Survival curves"), ("label", "Build the label"),
                      ("features", "Build features"), ("leaks", "Check for leaks"), ("train", "Train and tune"), ("test", "Test on held-out rows"),
                      ("explain", "Explain")],
    "what_if": [("data", "Load the data"), ("series", "Build the periods"), ("train", "Fit and test"), ("scenario", "Run the scenario")],
    "marketing_mix": [("data", "Load the data"), ("series", "Build weekly spend and sales"), ("train", "Fit carry-over and saturation"),
                      ("test", "Test on the last 20% of weeks"), ("explain", "Credit, ROI and reallocation")],
    "bought_together": [("data", "Load the data"), ("baskets", "Build baskets"), ("pairs", "Count pairs"), ("explain", "Rank by lift")],
    "cohorts": [("data", "Load the data"), ("cohorts", "Find first purchases"), ("explain", "Retention by month")],
    "recommendations": [("data", "Load the data"), ("matrix", "Who has what"), ("train", "Item similarity"), ("test", "Hide and recover items"),
                        ("explain", "Recommend")],
    "uplift": [("data", "Load the data"), ("groups", "Check the two groups"), ("features", "Build features"), ("train", "Train two models"),
               ("test", "Test on held-out rows"), ("explain", "Who responds")],
    "price": [("data", "Load the data"), ("series", "Prices and units per product"), ("train", "Fit elasticity per product"), ("explain", "Summarise")],
    "attribution": [("data", "Load the data"), ("journeys", "Build journeys"), ("train", "Credit by five models"), ("explain", "Compare")],
    "text_tag": [("data", "Load the data"), ("labels", "Get labels"), ("train", "Train a text model"), ("test", "Test on held-out rows"),
                 ("explain", "Tag every row")],
    "sentiment": [("data", "Load the data"), ("labels", "Read a sample"), ("train", "Tag every row"), ("explain", "Summarise")],
    "themes": [("data", "Load the data"), ("features", "Read the words"), ("train", "Find themes"), ("explain", "Name and count")],
    "doc_facts": [("data", "Load the data"), ("fields", "Decide the fields"), ("train", "Pull out the facts"), ("explain", "Check completeness")],
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


def load_frame(db: Session, user: models.User, source_id: str, table: str | None, cap: int | None = None) -> tuple[pd.DataFrame, dict, bool]:
    """(data, table entry, capped?) - the person's access rules applied.
    2026-10-09 (round 15): `cap` lets a joined table or a key sample use its
    own row limit (default: the training limit)."""
    from . import data_access_rules, synced_sources
    from .data_loader import load_dataframe
    entry = _table_entry(db, user, source_id, table)
    ds = db.get(models.DataSource, source_id)
    cap = int(cap or get_settings().ML_MAX_TRAIN_ROWS)
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


# ------------------------------------------------- spaces and joins ----
# 2026-10-09 (round 15): learn from a Space and from several tables joined.

def _space_source_ids(db: Session, user: models.User, space_id: str) -> list[str]:
    """The sources in a Space this person can see (services/spaces.py,
    built alongside this round - imported lazily)."""
    try:
        from . import spaces
    except ImportError as e:
        raise StudioError("Spaces aren't available on this server yet.") from e
    return list(spaces.space_source_ids(db, user, space_id) or [])


def scoped_tables(db: Session, user: models.User, space_id: str | None = None, source_ids: list[str] | None = None) -> list[dict]:
    """source_tables, limited to a Space when one is given."""
    if space_id:
        allowed = _space_source_ids(db, user, space_id)
        ids = [i for i in allowed if not source_ids or i in source_ids]
        if not ids:
            return []
        return source_tables(db, user, ids)
    return source_tables(db, user, source_ids)


def _check_space(db: Session, user: models.User, spec: dict) -> None:
    sid = spec.get("space_id")
    if not sid:
        return
    allowed = set(_space_source_ids(db, user, sid))
    for src in [spec.get("source_id")] + [j.get("source_id") for j in (spec.get("joins") or [])]:
        if src and src not in allowed:
            raise StudioError("One of the chosen tables isn't in this Space (or you can't see it there).")


def norm_keys(s: pd.Series) -> pd.Series:
    """Join keys made comparable: text trimmed and lower-cased (emails),
    numbers and numeric-looking text as whole-number strings without “.0”."""
    if pd.api.types.is_bool_dtype(s):
        s = s.astype("string")
    if pd.api.types.is_numeric_dtype(s):
        x = pd.to_numeric(s, errors="coerce")
        whole = x.notna() & np.isfinite(x) & (x == np.floor(x.fillna(0)))
        out = pd.Series([None] * len(x), index=s.index, dtype=object)
        if whole.any():
            out[whole] = x[whole].astype("int64").astype(str)
        rest = x.notna() & ~whole
        if rest.any():
            out[rest] = x[rest].astype(str)
        return out
    st = s.astype("string").str.strip().str.lower()
    st = st.str.replace(r"^(-?\d+)\.0+$", r"\1", regex=True)
    st = st.mask(st.isin(["", "nan", "none", "null"]))
    return st.astype(object).where(st.notna(), None)


def _alias(table: str, used: set[str]) -> str:
    base = re.sub(r"[^a-z0-9]+", "_", (table or "t").split(".")[-1].lower()).strip("_")[:12] or "t"
    a, i = base, 2
    while a in used:
        a, i = f"{base}{i}", i + 1
    used.add(a)
    return a


def _aggregate_per_key(jdf: pd.DataFrame, key: str, alias: str, max_cols: int = 30) -> tuple[pd.DataFrame, list[str]]:
    """Many rows per key -> one row per key: a row count, sums and means of
    numbers, days since the latest date (relative to the newest date in
    that table) and, for text, the number of distinct values and the most
    common one."""
    k = jdf["__k"]
    out = k.value_counts(sort=False).rename(f"{alias}__rows").to_frame()
    made = [f"{alias}__rows"]
    for c in [c for c in jdf.columns if c not in (key, "__k")][:max_cols]:
        s = jdf[c]
        if s.notna().sum() == 0:
            continue
        if pd.api.types.is_bool_dtype(s):
            s = s.astype(float)
        if _datetime_like(s):
            d = pd.to_datetime(s, errors="coerce", utc=True)
            newest = d.max()
            last = d.groupby(k).max()
            out[f"{alias}__{c}_days_since_last"] = (newest - last).dt.total_seconds() / 86400
            made.append(f"{alias}__{c}_days_since_last")
        elif pd.api.types.is_numeric_dtype(s):
            g = pd.to_numeric(s, errors="coerce").groupby(k)
            out[f"{alias}__{c}_sum"] = g.sum(min_count=1)
            out[f"{alias}__{c}_mean"] = g.mean()
            made += [f"{alias}__{c}_sum", f"{alias}__{c}_mean"]
        else:
            st = s.astype(str).where(s.notna())
            out[f"{alias}__{c}_distinct"] = st.groupby(k).nunique()
            made.append(f"{alias}__{c}_distinct")
            if st.nunique() <= 50:
                vc = pd.DataFrame({"k": k, "v": st}).dropna().value_counts().reset_index(name="n")
                top = vc.sort_values(["k", "n"], ascending=[True, False], kind="stable").drop_duplicates("k").set_index("k")["v"]
                out[f"{alias}__{c}_top"] = top
                made.append(f"{alias}__{c}_top")
    out.index.name = "__k"
    return out.reset_index(), made


def apply_joins(db: Session, user: models.User, base: pd.DataFrame, entry: dict, joins: list[dict]) -> tuple[pd.DataFrame, list[dict], list[str], dict]:
    """Left-joins each join table onto the base rows. Returns (data, info per
    join, warnings, column origin {column: table})."""
    joins = [j for j in (joins or []) if j and j.get("source_id")][:6]
    origin = {c: entry["table"] for c in base.columns}
    if not joins:
        return base, [], [], origin
    cap = int(getattr(get_settings(), "ML_MAX_JOIN_ROWS", 0) or get_settings().ML_MAX_TRAIN_ROWS * 2)
    used: set[str] = set()
    info, warnings = [], []
    df = base.copy()
    n = len(df)
    for j in joins:
        jdf, jentry, jcapped = load_frame(db, user, j["source_id"], j.get("table"), cap=cap)
        key, bkey = j.get("key"), j.get("base_key") or j.get("key")
        if not key or key not in jdf.columns:
            raise StudioError(f"There is no column called {key} in {jentry['table']} to join on.")
        if not bkey or bkey not in df.columns:
            raise StudioError(f"There is no column called {bkey} in {entry['table']} to join on.")
        alias = _alias(jentry["table"], used)
        jdf = _coerce_numeric_strings(jdf)
        jdf = jdf.assign(__k=norm_keys(jdf[key]).values).dropna(subset=["__k"])
        many = bool(jdf["__k"].duplicated().any())
        if many:
            agg, made = _aggregate_per_key(jdf, key, alias)
        else:
            keep = [c for c in jdf.columns if c not in (key, "__k")][:60]
            agg = jdf[["__k"] + keep].rename(columns={c: f"{alias}__{c}" for c in keep})
            made = [f"{alias}__{c}" for c in keep]
        agg[f"{alias}__matched"] = 1
        made.append(f"{alias}__matched")
        clash = [c for c in made if c in df.columns]
        if clash:
            agg = agg.drop(columns=clash)
            made = [c for c in made if c not in clash]
        bk = norm_keys(df[bkey])
        merged = df.assign(__k=bk.values).merge(agg, on="__k", how="left", sort=False)
        merged = merged.drop(columns="__k")
        merged[f"{alias}__matched"] = merged[f"{alias}__matched"].fillna(0).astype(int)
        if many:
            merged[f"{alias}__rows"] = merged[f"{alias}__rows"].fillna(0)
            for c in made:
                if c.endswith("_sum"):
                    merged[c] = merged[c].fillna(0)
        df = merged
        for c in made:
            origin[c] = jentry["table"]
        matched = int(df[f"{alias}__matched"].sum())
        rate = matched / n if n else 0.0
        if many:
            how = (f"{len(jdf):,} rows in {jentry['table']} become one row per {key}: a row count ({alias}__rows), sums and averages of numbers, "
                   f"days since the latest date and the number of different values of text. Rows with no match get 0 rows and 0 totals and "
                   f"{alias}__matched = 0, so “none” and “no match” stay distinguishable.")
        else:
            how = (f"One row per {key} in {jentry['table']}; its columns are added with the prefix {alias}__. "
                   f"Rows with no match keep empty values and {alias}__matched = 0.")
        info.append({"source_id": j["source_id"], "source": jentry["source"], "table": jentry["table"], "key": key, "base_key": bkey,
                     "alias": alias, "matched": matched, "base_rows": n, "match_rate": rate, "many_per_key": many,
                     "join_rows": int(len(jdf)), "capped": bool(jcapped), "aggregated": made if many else [], "added": made, "how": how})
        if rate < 0.5:
            warnings.append(f"Only {rate * 100:.1f}% of rows in {entry['table']} found a match in {jentry['table']} on {bkey} = {key} - check that this is the right key.")
        if jcapped:
            warnings.append(f"{jentry['table']} has more than {cap:,} rows; only the first {cap:,} were joined, so its counts and totals are partial.")
    for bk in sorted({j["base_key"] for j in info}):
        if bool(norm_keys(base[bk]).dropna().duplicated().any()):
            warnings.append(f"{entry['table']} has several rows per {bk} - each of those rows gets the same joined values.")
    return df, info, warnings, origin


def joins_text(entry: dict, info: list[dict]) -> str:
    """“3 tables joined on customer_id; 92.4% matched”."""
    if not info:
        return ""
    keys = sorted({j["base_key"] for j in info})
    rate = min(j["match_rate"] for j in info)
    rates = ", ".join(f"{j['table']} {j['match_rate'] * 100:.1f}%" for j in info)
    return (f"{len(info) + 1} tables joined on {', '.join(keys)}; " +
            (f"{rate * 100:.1f}% matched" if len(info) == 1 else f"matched: {rates}"))


def load_spec_frame(db: Session, user: models.User, spec: dict) -> tuple[pd.DataFrame, dict, bool, dict]:
    """The base table with every join applied. Returns (data, entry, capped,
    join summary {joins, warnings, origin, text})."""
    _check_space(db, user, spec)
    df, entry, capped = load_frame(db, user, spec["source_id"], spec.get("table"))
    joined = {"joins": [], "warnings": [], "origin": {}, "text": ""}
    if spec.get("joins"):
        df = _coerce_numeric_strings(df)
        df, info, warnings, origin = apply_joins(db, user, df, entry, spec["joins"])
        joined = {"joins": info, "warnings": warnings, "origin": origin, "text": joins_text(entry, info)}
    return df, entry, capped, joined


def join_preview(db: Session, user: models.User, spec: dict) -> dict:
    df, entry, capped, joined = load_spec_frame(db, user, spec)
    origin = joined["origin"] or {c: entry["table"] for c in df.columns}
    prev = df.head(8)
    rows = [{c: _jsonable(v) for c, v in r.items()} for r in prev.to_dict(orient="records")]
    return _m.clean({
        "rows": int(len(df)), "columns": [{"name": c, "from": origin.get(c, entry["table"])} for c in df.columns], "preview": rows,
        "joins": [{k: j[k] for k in ("source_id", "source", "table", "key", "base_key", "alias", "matched", "base_rows", "match_rate",
                                     "many_per_key", "aggregated", "added", "how", "join_rows", "capped")} for j in joined["joins"]],
        "warnings": joined["warnings"] + ([f"The main table is larger than the training limit; the first {len(df):,} rows are used."] if capped else []),
        "text": joined["text"],
    })


_KEY_NAME = re.compile(r"(id|email|customer|user|order)$")
_KEYISH = re.compile(r"(id|email|customer|user|order|key|code|sku|account|number|no)$")


def suggest_joins(db: Session, user: models.User, source_id: str, table: str | None, space_id: str | None = None, sample: int = 5000) -> dict:
    """Other tables that share a key with this one: the same (normalised)
    column name ending in id / email / customer / user / order, or a high
    share of matching values on a sample of up to 5k rows each."""
    tables = scoped_tables(db, user, space_id)
    base_df, base_entry, _ = load_frame(db, user, source_id, table, cap=sample)
    if base_df.empty:
        return {"candidates": []}

    def key_columns(frame: pd.DataFrame) -> dict[str, set]:
        out = {}
        for c in frame.columns:
            s = frame[c]
            if s.notna().sum() == 0 or pd.api.types.is_float_dtype(s) and not (s.dropna() % 1 == 0).all():
                continue
            if _datetime_like(s):
                continue
            nun = s.nunique(dropna=True)
            # a numeric column is a key only when its name says so (clicks,
            # saves or revenue overlapping by chance is not a join key);
            # a text column may also be a key by being mostly distinct
            keyish = bool(_KEYISH.search(_norm(c)))
            numeric = pd.api.types.is_numeric_dtype(s) and not pd.api.types.is_bool_dtype(s)
            if keyish or (not numeric and nun >= 20 and nun >= 0.3 * s.notna().sum()):
                out[c] = set(v for v in norm_keys(s.dropna()).tolist() if v is not None)
            if len(out) >= 15:
                break
        return out

    base_keys = key_columns(base_df)
    cands = []
    others = [t for t in tables if not (t["source_id"] == source_id and t["table"] == base_entry["table"])]
    # tables sharing a key-like column name first, then the rest (bounded)
    named = lambda t: any(_norm(c["name"]) in {_norm(b) for b in base_df.columns} and _KEY_NAME.search(_norm(c["name"])) for c in t["columns"])
    others.sort(key=lambda t: 0 if named(t) else 1)
    for t in others[:15]:
        try:
            odf, oentry, _ = load_frame(db, user, t["source_id"], t["table"], cap=sample)
        except Exception:  # noqa: BLE001 - one unreadable table never hides the others
            continue
        okeys = key_columns(odf)
        best = None
        for bc, bvals in base_keys.items():
            if not bvals:
                continue
            for oc, ovals in okeys.items():
                same_name = _norm(bc) == _norm(oc) and bool(_KEY_NAME.search(_norm(bc)))
                overlap = len(bvals & ovals) / len(bvals)
                if not same_name and overlap < 0.2:
                    continue
                if not same_name and not (_KEYISH.search(_norm(bc)) or _KEYISH.search(_norm(oc))) and overlap < 0.5:
                    continue
                score = overlap + (0.25 if same_name else 0)
                if best is None or score > best[0]:
                    best = (score, bc, oc, overlap, same_name)
        if best:
            _, bc, oc, overlap, same_name = best
            many = bool(norm_keys(odf[oc]).dropna().duplicated().any())
            why = (f"Both tables have {bc}" if same_name and bc == oc else f"{bc} here matches {oc} there") + \
                  f"; {overlap * 100:.0f}% of sampled {bc} values are found in {oentry['table']}" + \
                  (" (several rows per key - they will be summed and counted per key)" if many else "")
            cands.append({"source_id": t["source_id"], "source": t["source"], "table": oentry["table"], "key": oc, "base_key": bc,
                          "overlap": round(float(overlap), 4), "many_per_key": many, "why": why})
    cands.sort(key=lambda c: -c["overlap"])
    return {"candidates": cands}


# -------------------------------------------------------- understanding ----

ML_SYSTEM = """GD360 ML PLANNER
You turn a business goal into a machine-learning problem on the person's data.
Reply with JSON only:
{"problem_type": one of %s,
 "source_id": "...", "table": "...",
 "target": "column to predict or explain, or null",
 "positive_value": "for a yes/no target, the value that means yes, or null",
 "time_column": "date/time column, or null",
 "value_column": "for a forecast / what-if / marketing mix / cohorts: the number, or null",
 "group_column": "for many series or survival groups: the column naming each series, or null",
 "horizon": number of future periods (or days for time_to_event) or null,
 "start_column": "time_to_event: start date", "end_column": "time_to_event: end date", "duration_column": null,
 "event_column": "time_to_event: has it happened (1/0)", "drivers": ["what_if: columns that could change"],
 "spend_columns": ["marketing_mix: one spend column per channel"], "order_column": "bought_together: order id",
 "item_column": "product/item column", "entity_column": "customer/user column", "treatment_column": "uplift: who got the offer",
 "price_column": "price: price", "units_column": "price: units sold", "channel_column": "attribution: channel",
 "conversion_column": "attribution: 1 on converting rows", "text_column": "language kinds: the text", "label_column": "text_tag: existing tags or null",
 "fields": ["doc_facts: field names to pull out"],
 "summary": "one sentence: what will be predicted or found, for whom"}
Leave any key that doesn't apply as null.
Kinds: yes_no (will/likely/which ... stop/churn/buy/convert), which_category (which of several
categories/plans/teams), number (how much / how many), time_to_event (how long until / when will),
forecast_one / forecast_many (future periods; many = for each product/store), what_if (outcome if a
driver changes by x%%), marketing_mix (what each channel's spend adds to sales, ROI), segments
(groups/personas), anomalies (unusual/wrong/outliers without a label), drivers (what drives a number),
bought_together (products sold together, bundles), cohorts (retention of monthly cohorts),
recommendations (next product per customer), uplift (who responds to an offer/discount),
price (price sensitivity / elasticity), attribution (which channels deserve credit for sales),
text_tag (sort/route/tag text), sentiment (praise/questions/complaints), themes (topics people
raise, by month), doc_facts (pull fields from invoices/contracts/emails).
Use only sources, tables and columns listed."""


def _schema_text(tables: list[dict]) -> str:
    lines = []
    for t in tables[:30]:
        cols = ", ".join(f"{c['name']} ({c.get('type') or '?'})" for c in t["columns"][:40])
        lines.append(f"- source_id={t['source_id']} source=\"{t['source']}\" table={t['table']}: {cols}")
    return "\n".join(lines)


_WORDS = {
    # 2026-10-09 (round 15): the newer kinds are checked first - their words are more specific
    "doc_facts": r"\bextract\b|\bpull (out )?(the )?(fields|facts|details|data)\b|invoice fields|\bfrom (the |our )?(invoices|contracts|emails|documents|pdfs|receipts)\b",
    "sentiment": r"\bsentiment|praise|positive or negative|\bhappy or (unhappy|angry)\b|\btone of\b",
    "themes": r"\btheme|\btopic|complain(ing|ts)? about|what (are|do) (customers|people|users|guests) (say|talk|complain|mention|raise|write)",
    "text_tag": r"\b(tag|route|categori[sz]e|classify|sort|label)\b.*\b(tickets?|reviews?|comments?|emails?|messages?|texts?|feedback|posts?)\b|\bwhich (team|queue|department) should\b",
    "attribution": r"\battribut|channel credit|credit (for|to)\b|deserve(s)? (the )?credit|first.touch|last.touch|touchpoint",
    "what_if": r"\bwhat.if\b|\bscenario|\bif (the |our )?[a-z ]{0,30}\b(rises?|rose|drops?|falls?|increases?|decreases?|goes (up|down)|doubles?|is cut|cut by)\b",
    "marketing_mix": r"\bmarketing mix|\bmmm\b|\bmedia mix|ad spend\b.*\b(bring|return|roi|sales|revenue|worth)|spend\s*(→|->|to)\s*(sales|revenue)|\broi\b.*\b(channel|ad|marketing|campaign)|each extra .*\b(spend|ads?)\b",
    "uplift": r"\buplift|respond(s)? to (an |the |a |our )?(offer|discount|coupon|campaign|email|promotion)|who (responds|reacts)|actually moves|persuad|incremental",
    "price": r"\bpric(e|ing) (sensitiv|elastic)|elasticit|demand change[s]? with price|(demand|sales|units) .*(change|react|respond|drop|fall)s? .*\bpric|optimal price",
    "recommendations": r"\brecommend|next (best )?(product|item|purchase|offer|content|thing)|what (else )?(should|would|will) (each|every)? ?(customer|user|person)s? (buy|like|want|watch|read)",
    "bought_together": r"bought together|purchased together|sold together|sell together|\bbasket|\bbundles?\b|frequently bought|go(es)? together|cross.sell",
    "cohorts": r"\bcohort|\bretention\b|\bretain|keep (buying|ordering|coming back)|come back .* month",
    "time_to_event": r"\bhow long (until|before|till|do|does)|\bwhen will\b|\bdays (until|till|before)|\btime (until|to) (churn|fail|failure|pay|payment|close|leave|cancel)|\bsurvival",
    "forecast_many": r"\b(each|every|per)\b.*\b(forecast|next (week|month|quarter)|demand)\b|\bforecast\b.*\b(each|every|per)\b",
    "forecast_one": r"\bforecast|predict next (week|month|quarter|year)|how (much|many) will .* next|projection\b",
    "segments": r"\bsegment|cluster|group(s)? of|persona|kinds of customers|types of customers\b",
    "anomalies": r"\banomal|outlier|unusual|look(s)? wrong|suspicious|odd\b",
    "drivers": r"\bwhat drives|drivers? of|what affects|why (do|does|is)|what explains|influenc",
    "which_category": r"\bwhich (category|segment|plan|team|product line|reason|type|tier|class|department|bucket)\b|\bwhat (category|type|kind|plan|tier) (of )?.*\bwill\b",
    "yes_no": r"\b(will|likely|which|who)\b.*\b(stop|churn|leave|cancel|buy|convert|default|fraud|late|return|renew|respond)\b|\bchurn|\bprobability\b",
    "number": r"\bhow (much|many)|predict (the )?(value|amount|revenue|price|time|duration|spend)|estimate\b",
}
_ORDER = ("doc_facts", "sentiment", "themes", "text_tag", "attribution", "what_if", "marketing_mix", "uplift", "price", "recommendations",
          "bought_together", "cohorts", "time_to_event", "forecast_many", "forecast_one", "segments", "anomalies", "drivers",
          "which_category", "yes_no", "number")


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def _guess_type(goal: str) -> str:
    g = goal.lower()
    for pid in _ORDER:
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


# 2026-10-09 (round 15): column-name patterns for the newer kinds' fields
_NAMES = {
    "entity_column": r"customer|user|client|member|account|email|visitor|person|contact|guest|buyer|subscriber",
    "order_column": r"order|basket|transaction|invoice|receipt|cart",
    "item_column": r"product|item|sku|article|title|content|name",
    "price_column": r"price",
    "units_column": r"units|quantity|qty|sold|volume|demand",
    "channel_column": r"channel|source|medium|utm|touchpoint|campaign",
    "conversion_column": r"convert|conversion|purchase|sale|signup|goal|order",
    "treatment_column": r"treat|variant|offer|discount|coupon|arm|test|group|promo",
    "event_column": r"churn|event|fail|left|cancel|status|paid|happen|dead|closed|ended",
    "start_column": r"start|signup|sign_up|created|joined|opened|issued|begin|first",
    "end_column": r"end|churn|cancel|closed|left|fail|paid|resolved|last|stop",
    "duration_column": r"duration|tenure|lifetime|days",
    "text_column": r"text|comment|review|message|body|description|feedback|content|note|subject|complaint|ticket|post|caption",
    "label_column": r"tag|label|category|team|queue|topic|type",
    "spend_columns": r"spend|cost|budget|spent|investment",
}
_TIME_KEYS = ("start_column", "end_column")
_NUM_KEYS = ("price_column", "units_column", "duration_column", "spend_columns")


def _guess_fields(ptype: str, cols: list[dict], words: list[str]) -> dict:
    """Name-only guesses for the newer kinds (the plan checks them on the data)."""
    want = {
        "time_to_event": ("start_column", "end_column", "event_column"),
        "bought_together": ("order_column", "item_column"),
        "cohorts": ("entity_column",),
        "recommendations": ("entity_column", "item_column"),
        "uplift": ("treatment_column",),
        "price": ("item_column", "price_column", "units_column"),
        "attribution": ("entity_column", "channel_column", "conversion_column"),
        "text_tag": ("text_column", "label_column"),
        "sentiment": ("text_column",),
        "themes": ("text_column",),
        "doc_facts": ("text_column",),
        "marketing_mix": ("spend_columns",),
    }.get(ptype, ())
    out: dict = {}
    taken: set[str] = set()
    for key in want:
        pat = _NAMES[key]

        def ok(c, key=key):
            if c["name"] in taken:
                return False
            if key in _TIME_KEYS:
                return _is_time(c)
            if key in _NUM_KEYS:
                return _is_num(c) and not _is_time(c)
            if key in ("text_column", "label_column", "item_column", "channel_column"):
                return not _is_num(c) and not _is_time(c)
            return not _is_time(c)

        hits = [c for c in cols if ok(c) and re.search(pat, c["name"].lower())]
        hits.sort(key=lambda c: (-sum(1 for w in words if w in _norm(c["name"])), 0 if _norm(c["name"]).endswith("id") else 1))
        if key == "spend_columns":
            out[key] = [c["name"] for c in hits][:12] or None
            continue
        if hits:
            out[key] = hits[0]["name"]
            taken.add(hits[0]["name"])
    return out


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
        if ptype in NEEDS_TIME or ptype in ("what_if", "marketing_mix"):
            return 1.0 if (has_time and has_num) else 0.0
        if ptype in ("cohorts", "attribution"):
            return 1.0 if has_time else 0.0
        if ptype in ("text_tag", "sentiment", "themes", "doc_facts"):
            return 1.0 if any(re.search(_NAMES["text_column"], c["name"].lower()) for c in cols) else 0.0
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
    value_col = (mentioned(lambda c: _is_num(c) and not _is_time(c))
                 if ptype in NEEDS_TIME or ptype in ("what_if", "marketing_mix") else None)
    group_col = mentioned(lambda c: not _is_num(c) and not _is_time(c)) if ptype == "forecast_many" else None
    out = {"problem_type": ptype, "source_id": t["source_id"], "table": t["table"], "target": target, "positive_value": None,
           "time_column": time_col, "value_column": value_col, "group_column": group_col, "horizon": None, "summary": None}
    out.update(_guess_fields(ptype, cols, words))
    if ptype == "uplift":
        tr = out.get("treatment_column")
        cand = mentioned(lambda c: not _is_time(c) and c["name"] != tr and sum(1 for w in words if w in _norm(c["name"])) > 0)
        out["target"] = cand or mentioned(lambda c: not _is_time(c) and c["name"] != tr and re.search(r"convert|purchas|bought|respon|outcome|revenue|spend|order", c["name"].lower()))
    if ptype == "marketing_mix" and out.get("spend_columns") and value_col in (out.get("spend_columns") or []):
        out["value_column"] = mentioned(lambda c: _is_num(c) and not _is_time(c) and c["name"] not in out["spend_columns"])
    return out


def _goal_match(goal: str, t: dict) -> int:
    words = {w for w in re.findall(r"[a-z0-9]+", goal.lower()) if len(w) > 3}
    words |= {w[:-1] for w in words if w.endswith("s")}
    return (2 * sum(1 for w in words if w in _norm(t["table"]) or w in _norm(t.get("source") or ""))
            + sum(1 for c in t["columns"] for w in words if w in _norm(c["name"])))


def _outside_hint(db: Session, user: models.User, goal: str, chosen: dict, inside: list[dict]) -> dict | None:
    """2026-10-09 (round 15): a goal asked inside a Space whose tables don't
    mention what it is about ("which customers will stop buying" in a
    marketing Space) - name the table outside the Space that does, so the
    person can learn from it instead of training on the wrong thing."""
    here = _goal_match(goal, chosen)
    keys = {(x["source_id"], x["table"]) for x in inside}
    best, score = None, here
    for t in source_tables(db, user, None):
        if (t["source_id"], t["table"]) in keys:
            continue
        s = _goal_match(goal, t)
        if s > score:
            best, score = t, s
    if not best or score < 2:
        return None
    return {"source_id": best["source_id"], "table": best["table"], "source": best.get("source") or "",
            "text": f"“{best['table']}” in {best.get('source') or 'another source'} fits this goal better - it isn't in this Space."}


def understand(db: Session, user: models.User, goal: str, problem_type: str | None = None,
               source_id: str | None = None, table: str | None = None, space_id: str | None = None,
               joins: list[dict] | None = None) -> dict:
    goal = (goal or "").strip()
    # 2026-10-09 (round 15): a Space limits the candidate tables to its sources
    tables = scoped_tables(db, user, space_id, [source_id] if source_id else None)
    if table:
        # round 14: "learn from this table" - the person chose the data
        tables = [t for t in tables if t["table"] == table] or tables
    if not tables:
        raise StudioError("There is no table to learn from in this Space yet." if space_id
                          else "Connect a data source first - there is nothing to learn from yet.")
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
    same = True
    if not t:
        t = next(x for x in tables if x["source_id"] == base["source_id"] and x["table"] == base["table"])
        same = False
    if spec is not base and (spec.get("problem_type") != base["problem_type"]
                             or (base["source_id"], base["table"]) != (t["source_id"], t["table"])):
        # 2026-10-09 (round 15): the model chose another table (or kind) than
        # the heuristic - fill the columns it left empty from *that* table
        base = _heuristic(goal or "", [t], spec["problem_type"])
    names = {c["name"] for c in t["columns"]}
    for k in COLUMN_KEYS:
        if not same or spec.get(k) not in names:
            spec[k] = base.get(k) if base.get(k) in names and base["table"] == t["table"] else None
    for k in LIST_KEYS:
        vals = spec.get(k) if same else None
        vals = [v for v in (vals or []) if v in names] if isinstance(vals, list) else []
        spec[k] = vals or [v for v in (base.get(k) or []) if v in names] or None
    if spec.get("fields") is not None and not isinstance(spec.get("fields"), list):
        spec["fields"] = None
    spec["source_id"], spec["table"] = t["source_id"], t["table"]
    spec["goal"] = goal
    if space_id:
        spec["space_id"] = space_id
        hint = _outside_hint(db, user, goal, t, tables) if goal and not source_id else None
        if hint:
            spec["scope_hint"] = hint
    if joins:
        spec["joins"] = joins
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
    if ptype == "which_category":
        # 2026-10-09 (round 15): several categories, 3 to 30 of them
        vals = y.dropna()
        distinct = vals.astype(str).value_counts()
        if len(distinct) < 3:
            raise StudioError(f"{target} has {len(distinct)} value{'s' if len(distinct) != 1 else ''} - “Which category” needs 3 to 30. "
                              "For two outcomes use “A yes / no outcome”.")
        if len(distinct) > 30:
            raise StudioError(f"{target} has {len(distinct)} different values - “Which category” works with 3 to 30. "
                              "Group the rare ones into “other” first, or predict it as a number if it is one.")
        info.update(kind="multiclass", classes=list(distinct.index))
        return y.astype(str).where(y.notna()), info
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
            excluded.append({"column": c, "reason": (spec.get("exclude_reasons") or {}).get(c, "Left out by you.")})
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
    spec = {k: v for k, v in spec.items() if k != "scope_hint"}  # a note for the page, not part of the project
    ptype = spec.get("problem_type")
    if ptype not in READY:
        raise StudioError("That kind of project isn't available yet - pick one of the others.")
    # 2026-10-09 (round 15): the base table with any joins applied (and the Space checked)
    df, entry, capped, joined = load_spec_frame(db, user, spec)
    df = _coerce_numeric_strings(df)
    n = len(df)
    if n == 0:
        raise StudioError("That table has no rows you can see.")
    cols = list(df.columns)
    rows: list[dict] = []
    plan: dict = {"problem_type": ptype, "source_id": spec["source_id"], "source": entry["source"], "table": entry["table"],
                  "rows": n, "capped": capped, "columns": cols, "warnings": list(joined["warnings"]),
                  "joins": [{k: j[k] for k in ("source", "table", "key", "base_key", "matched", "base_rows", "match_rate", "many_per_key",
                                               "aggregated", "how")} for j in joined["joins"]]}
    cap = get_settings().ML_MAX_TRAIN_ROWS
    data_note = f"{_fmt_int(n)} rows · {len(cols)} columns" + (f" · first {cap:,} rows (server limit)" if capped else "")
    data_v = f"{entry['source']} · {entry['table']}" + (f" + {len(joined['joins'])} joined table{'s' if len(joined['joins']) != 1 else ''}" if joined["joins"] else "")
    if joined["text"]:
        data_note = joined["text"] + " · " + data_note
    if capped:
        plan["warnings"].append(f"The table has more than {cap:,} rows. This server trains on the first {cap:,} and the results will say so.")

    if ptype not in SUPERVISED and ptype not in ("segments", "anomalies") and ptype not in NEEDS_TIME:
        rows, extra = _plan_new(ptype, df, spec, data_v, data_note, n)
        plan["warnings"] += extra.pop("warnings_new", [])
        plan.update(extra)
    elif ptype in SUPERVISED:
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
            {"k": "Data", "v": data_v, "m": data_note},
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
            {"k": "Data", "v": data_v, "m": data_note},
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
            {"k": "Data", "v": data_v, "m": data_note},
            {"k": "Fair test", "v": "Rolling-origin backtest on the last periods, compared with “same period last season”", "m": "MASE below 1 beats the baseline"},
            {"k": "Compute", "v": "In memory on this server", "m": "seconds"},
            {"k": "Output", "v": "Forecast table and chart", "m": ""},
        ]
        plan.update(grain=grain, horizon=horizon, time_column=tcol, value_column=vcol, group_column=group)
    plan["rows_text"] = rows
    plan["spec"] = {k: spec.get(k) for k in SPEC_KEYS}
    return _m.clean(plan)


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


_AGG_SUFFIX = re.compile(r"_(sum|mean|days_since_last|distinct|top)$")


def _leak_siblings(suspects: list[dict], feats: list[str]) -> list[dict]:
    """2026-10-09 (round 15): when one per-key aggregate of a joined column
    gives the answer away (say orders__refund_mean), its siblings built from
    the same column (orders__refund_sum …) carry the same answer - they go too."""
    roots = {}
    for s_ in suspects:
        c = s_["column"]
        if "__" in c and _AGG_SUFFIX.search(c):
            roots[_AGG_SUFFIX.sub("", c)] = c
    have = {s_["column"] for s_ in suspects}
    out = list(suspects)
    for f in feats:
        if f in have or "__" not in f or not _AGG_SUFFIX.search(f):
            continue
        root = _AGG_SUFFIX.sub("", f)
        if root in roots:
            out.append({"column": f, "reason": f"Built from the same column as {roots[root]}, which gives the answer away."})
    return out


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
    return _leak_siblings(out, feats)


# ----------------------------------------------------------- the job ----

def _stage_list(ptype: str) -> list[dict]:
    return [{"id": sid, "title": title, "status": "pending", "note": ""} for sid, title in STAGES[ptype]]


def _target_name(ptype: str, spec: dict) -> str:
    """What the model row's target_column shows (never empty)."""
    for k in ("target", "value_column", "item_column", "text_column", "event_column", "end_column", "duration_column", "units_column",
              "conversion_column", "channel_column", "entity_column"):
        if spec.get(k):
            return str(spec[k])
    return {"segments": "segment", "anomalies": "anomaly", "themes": "theme", "sentiment": "sentiment", "doc_facts": "facts"}.get(ptype, "rows")


def start(db: Session, user: models.User, spec: dict, name: str, goal: str | None, run_now: bool = False) -> models.MLModel:
    """Creates the project and trains it on a background thread (or, with
    run_now, in this thread - tests and scripts)."""
    ptype = spec.get("problem_type")
    if ptype not in READY:
        raise StudioError("That kind of project isn't available yet.")
    ds = db.get(models.DataSource, spec.get("source_id") or "")
    from . import workspace_access
    if not ds or not workspace_access.can_edit_datasource(db, ds, user):
        raise StudioError("You need edit access to that data source to train on it.")
    entry = _table_entry(db, user, ds.id, spec.get("table"))
    target = _target_name(ptype, spec)
    m = models.MLModel(
        owner_id=user.id, workspace_id=ds.workspace_id, datasource_id=ds.id, name=(name or "ML project").strip()[:120],
        target_column=target, status="training", problem_type=ptype, goal=(goal or "").strip() or None,
        table_name=entry["key"], plan={"spec": spec}, started_at=datetime.utcnow(), stop_requested=False,
        progress={"stages": _stage_list(ptype), "leaderboard": [], "curve": [], "trials_done": 0,
                  "trials_total": get_settings().ML_TRIALS if ptype in TUNED else None, "leaks": [], "resources": {},
                  "message": "Waiting for the server…"},
    )
    db.add(m)
    db.commit()
    db.refresh(m)
    if run_now:
        _run(m.id)
        db.refresh(m)
    else:
        threading.Thread(target=_run, args=(m.id,), daemon=True, name=f"ml-{m.id[:8]}").start()
    return m


def restart(db: Session, m: models.MLModel) -> models.MLModel:
    """Train again from the same plan (new data since, same choices)."""
    m.status = "training"
    m.error_message = None
    m.stop_requested = False
    m.started_at = datetime.utcnow()
    m.progress = {"stages": _stage_list(m.problem_type), "leaderboard": [], "curve": [], "trials_done": 0,
                  "trials_total": get_settings().ML_TRIALS if m.problem_type in TUNED else None, "leaks": [],
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
            elif ptype in NEEDS_TIME:
                _train_forecast(db, job, user, spec)
            else:
                # 2026-10-09 (round 15): the newer kinds
                TRAINERS[ptype](db, job, user, spec)
            if isinstance(m.results, dict):
                m.results = _m.clean(m.results)
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


def _load_for_job(db: Session, job: Job, user: models.User, spec: dict, time_col: str | None = None) -> tuple[pd.DataFrame, dict, bool, dict]:
    """2026-10-09 (round 15): the shared “Load the data” stage - base table,
    joins, the server row limit and the memory guard - for every kind."""
    job.stage("data", "running")
    df, entry, capped, joined = load_spec_frame(db, user, spec)
    df = _coerce_numeric_strings(df)
    total = len(df)
    job.stage("data", "done", f"{total:,} rows · {len(df.columns)} columns" + (f" · {joined['text']}" if joined["text"] else "")
              + (" · server row limit reached" if capped else ""))
    job.save(resources={"rows_used": total, "rows_total": total, "capped": capped}, joins=joined["joins"])
    job.check_stop()
    df = fit_memory(job, df, len(df.columns) + 20, time_col if time_col in df.columns else None)
    return df, entry, capped, joined


def _train_supervised(db: Session, job: Job, user: models.User, spec: dict, frame: tuple | None = None) -> None:
    """`frame` = (data, rows before any filtering, capped?, join summary) when
    the caller already loaded and prepared the rows (time_to_event)."""
    s = get_settings()
    m = job.m
    if frame is None:
        df, entry, capped, joined = _load_for_job(db, job, user, spec, spec.get("time_column"))
        total = len(df)
    else:
        df, total, capped, joined = frame

    job.stage("label", "running")
    y_all, info = _label(df, spec)
    keep = y_all.notna().values
    df, y = df[keep].reset_index(drop=True), y_all[keep].reset_index(drop=True)
    if len(df) < 40:
        raise StudioError(f"Only {len(df)} rows have a known {info['target']} - at least 40 are needed to learn and test fairly.")
    dropped_classes: list[str] = []
    if info["kind"] != "number":
        vc = y.value_counts()
        if spec.get("problem_type") == "which_category" and vc.min() < 5:
            # 2026-10-09 (round 15): rare categories are set aside, said plainly
            rare = [str(k) for k, v in vc.items() if v < 5]
            if len(vc) - len(rare) < 2:
                raise StudioError(f"Only {len(vc) - len(rare)} categories of {info['target']} have 5 or more rows - too few to learn from.")
            dropped_classes = rare
            ok = ~y.isin(rare)
            df, y = df[ok.values].reset_index(drop=True), y[ok].reset_index(drop=True)
            info["classes"] = [c for c in info["classes"] if c not in rare]
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
    per_class = confusion = None
    if info["kind"] == "multiclass":
        per_class, confusion = _class_report(winner, X_te, y_te)
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
           if (info["kind"] == "binary" and (w["test_score"] or 0) > 0.995) or (info["kind"] == "number" and (w["test_score"] or 0) > 0.995) else [])
        + ([f"Set aside {len(dropped_classes)} categor{'y' if len(dropped_classes) == 1 else 'ies'} with fewer than 5 rows: {', '.join(dropped_classes[:8])}."]
           if dropped_classes else [])
        + list(joined.get("warnings") or []),
        # 2026-10-09 (round 15)
        "joins": joined.get("joins") or [], "leaderboard": [{k: r.get(k) for k in ("algorithm", "score", "test_score", "baseline", "best")} for r in board],
    }
    if per_class is not None:
        m.results.update(per_class=per_class, confusion=confusion, dropped_classes=dropped_classes)
    m.results.update(_present_supervised(spec.get("problem_type"), m.results))
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
    df, entry, capped, joined = _load_for_job(db, job, user, spec, None)
    if len(df) < 30:
        raise StudioError(f"Only {len(df)} rows - at least 30 are needed.")
    job.stage("features", "running")
    feats, excluded, dates = _feature_columns(df, {**spec, "target": None})
    if not feats:
        raise StudioError("No column is usable - every column is an id, empty or free text.")
    prep, expanded = _preprocessor(df, feats, dates, scale=True)
    X = prep.fit_transform(df[feats])
    job.stage("features", "done", f"{len(feats)} columns")
    job.check_stop()
    return df, feats, excluded, dates, prep, X, capped, joined


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
    df, feats, excluded, dates, prep, X, capped, joined = _unsupervised_frame(db, job, user, spec)
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
                 "warnings": ([] if sil >= 0.15 else ["The groups overlap a lot (low silhouette) - the data may not split into clear groups."])
                 + list(joined.get("warnings") or []), "joins": joined.get("joins") or []}
    m.results.update(_present_segments(m.results))
    job.save(leaderboard=board)


def _train_anomalies(db: Session, job: Job, user: models.User, spec: dict) -> None:
    m = job.m
    df, feats, excluded, dates, prep, X, capped, joined = _unsupervised_frame(db, job, user, spec)
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
                 "threshold": float(np.min(score[flagged])) if flagged.any() else None, "warnings": list(joined.get("warnings") or []),
                 "joins": joined.get("joins") or [], "share": share}
    m.results.update(_present_anomalies(m.results))
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
    df, entry, capped, joined = _load_for_job(db, job, user, spec, spec.get("time_column"))
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
                 "rows_total": int(len(df)), "capped": capped, "warnings": [s["reason"] for s in out if s["status"] != "ok"][:5],
                 "joins": joined.get("joins") or []}
    m.results.update(_present_forecast(m.results))


# ------------------------------------------------- presentation ----
# 2026-10-09 (round 15): every kind's results also carry "headline", "kpis"
# and "sections" (table / bars / line / matrix / text - see
# ml_studio_methods.sec_*), so the page can render any kind the same way.
# The older keys stay exactly as they were.

def _score_disp(kind: str, v) -> str:
    if v is None or (isinstance(v, float) and not math.isfinite(v)):
        return "—"
    if kind == "multiclass":
        return f"{v * 100:.1f}%"
    return f"{v:.3f}"


def _driver_bars(drivers: list[dict], title: str) -> dict | None:
    pos = [d for d in drivers if d.get("importance", 0) > 0][:12]
    if not pos:
        return None
    tot = sum(d["importance"] for d in pos) or 1.0
    items = [_m.bar(d["feature"], d["importance"] / tot, "percent", tone={"up": "up", "down": "down"}.get(d.get("direction") or "", "neutral"),
                    note={"up": "higher values push it up", "down": "higher values push it down"}.get(d.get("direction") or ""))
             for d in pos]
    return _m.sec_bars(title, items, "percent", note="Share of the model's accuracy that depends on each column, measured on held-out rows by shuffling it.")


def _present_supervised(ptype: str | None, r: dict) -> dict:
    kind, info = r["kind"], r["label"]
    target = info["target"]
    n_te = int(r.get("test_rows") or 0)
    base = r.get("baseline") or {}
    sc, sec2 = r.get("test_score"), r.get("test_second")
    beat = "beats" if r.get("beats_baseline") else "does not beat"
    kpis, sections = [], []
    if kind == "binary":
        rate = info.get("rate")
        headline = (f"Ranks every row by the chance that {target} is {r.get('positive')}: ROC AUC {_score_disp(kind, sc)} on {n_te:,} held-out rows - "
                    f"it {beat} the baseline ({_score_disp(kind, base.get('score'))}).")
        kpis = [_m.kpi("ROC AUC on held-out rows", sc, display=_score_disp(kind, sc), note=f"baseline {_score_disp(kind, base.get('score'))} · 0.5 = guessing"),
                _m.kpi("Hit rate in the top 10%", sec2, "percent", note=f"vs {rate * 100:.1f}% of all rows" if rate is not None else None),
                _m.kpi("Rows tested", n_te, "integer", note="never seen in training"),
                _m.kpi("Rows trained", r.get("train_rows"), "integer")]
    elif kind == "multiclass":
        headline = (f"Predicts which of {len(info.get('classes') or [])} values {target} takes: {_score_disp(kind, sc)} right on {n_te:,} held-out rows - "
                    f"it {beat} the baseline ({_score_disp(kind, base.get('score'))}).")
        kpis = [_m.kpi("Accuracy on held-out rows", sc, "percent", note=f"baseline {_score_disp(kind, base.get('score'))}"),
                _m.kpi("Macro F1", sec2, display=_score_disp('binary', sec2), note="average over categories; rare ones count as much as common ones"),
                _m.kpi("Categories", len(info.get("classes") or []), "integer"),
                _m.kpi("Rows tested", n_te, "integer")]
    else:
        headline = (f"Predicts {target} for every row: R² {_score_disp(kind, sc)} on {n_te:,} held-out rows (typical error {_m.num(sec2)}) - "
                    f"it {beat} the baseline (R² {_score_disp(kind, base.get('score'))}).")
        kpis = [_m.kpi("R² on held-out rows", sc, display=_score_disp(kind, sc), note="1 = perfect · 0 = no better than the average"),
                _m.kpi("Mean absolute error", sec2, note=f"{target} averages {_m.num(info.get('mean'))}"),
                _m.kpi("Rows tested", n_te, "integer"), _m.kpi("Rows trained", r.get("train_rows"), "integer")]
    drivers = r.get("drivers") or []
    if ptype == "drivers" and drivers:
        top = drivers[0]
        d = {"up": "higher values push it up", "down": "higher values push it down"}.get(top.get("direction") or "", "its effect isn't one-directional")
        headline = f"The biggest driver of {target} is {top['feature']} ({d}). " + headline
    bars = _driver_bars(drivers, f"What moves {target} most" if ptype != "which_category" else f"What tells the categories of {target} apart")
    if bars:
        sections.append(bars)
    if r.get("per_class"):
        sections.append(_m.sec_table(f"How well each value of {target} is predicted", [
            _m.column("category", "Category"), _m.column("rows", "Held-out rows", "integer"), _m.column("precision", "Precision", "percent"),
            _m.column("recall", "Recall", "percent"), _m.column("f1", "F1", "percent")], r["per_class"],
            note="Precision: of the rows predicted as this category, how many were. Recall: of the rows that were, how many it found."))
    if r.get("confusion"):
        cm = r["confusion"]
        sections.append(_m.sec_matrix("Where it gets confused", cm["labels"], cm["labels"], cm["values"], "percent",
                                      note="Each row is the true category; the columns show what was predicted (share of that row)."))
    board = [b for b in (r.get("leaderboard") or []) if b.get("test_score") is not None or b.get("score") is not None]
    if board:
        sections.append(_m.sec_table("Models compared", [
            _m.column("algorithm", "Model"), _m.column("score", f"Validation {_metric_name(kind)}", "number"),
            _m.column("test_score", f"Held-out {_metric_name(kind)}", "number")],
            [{"algorithm": b["algorithm"] + (" ✓" if b.get("best") else ""), "score": b.get("score"), "test_score": b.get("test_score")} for b in board],
            note=r.get("split")))
    if r.get("leaks"):
        sections.append(_m.sec_table("Left out because they give the answer away", [_m.column("column", "Column"), _m.column("reason", "Why")],
                                     [{"column": x["column"], "reason": x["reason"]} for x in r["leaks"]]))
    return {"headline": headline, "kpis": kpis, "sections": sections}


def _present_segments(r: dict) -> dict:
    groups = r.get("groups") or []
    big = groups[0] if groups else None
    headline = (f"{r['k']} groups that behave alike; the largest ({big['share'] * 100:.0f}% of rows) is “{big['name']}”." if big
                else f"{r['k']} groups.")
    kpis = [_m.kpi("Groups", r["k"], "integer"), _m.kpi("Silhouette", r.get("silhouette"), display=f"{r.get('silhouette', 0):.2f}",
                                                         note="how well separated: above 0.25 is clear, below 0.15 overlaps"),
            _m.kpi("Rows", r.get("rows_total"), "integer")]
    sections = [_m.sec_bars("Size of each group", [_m.bar(g["name"], g["share"], "percent", note=f"{g['rows']:,} rows") for g in groups], "percent"),
                _m.sec_table("What sets each group apart", [_m.column("name", "Group"), _m.column("rows", "Rows", "integer"),
                                                            _m.column("share", "Share", "percent"), _m.column("traits", "Traits")],
                             [{"name": g["name"], "rows": g["rows"], "share": g["share"], "traits": "; ".join(t["text"] for t in g.get("traits") or [])}
                              for g in groups])]
    return {"headline": headline, "kpis": kpis, "sections": sections}


def _present_anomalies(r: dict) -> dict:
    total, flagged = r.get("rows_total") or 0, r.get("flagged") or 0
    headline = f"{flagged:,} of {total:,} rows ({flagged / max(total, 1) * 100:.1f}%) look unusual; the most unusual are listed with the reason."
    kpis = [_m.kpi("Rows flagged", flagged, "integer"), _m.kpi("Share flagged", flagged / max(total, 1), "percent", note="the share you asked for"),
            _m.kpi("Rows checked", total, "integer")]
    top = r.get("top") or []
    sections = [_m.sec_table("The most unusual rows", [_m.column("row", "Row", "integer"), _m.column("score", "Unusualness", "number"),
                                                        _m.column("reasons", "Why")],
                             [{"row": t["row"] + 1, "score": round(t["score"], 3), "reasons": "; ".join(t["reasons"])} for t in top[:25]],
                             note="Row numbers count from 1 in the table as loaded.")]
    return {"headline": headline, "kpis": kpis, "sections": sections}


def _present_forecast(r: dict) -> dict:
    ok = [s for s in r.get("series") or [] if s.get("status") == "ok"]
    grain, h, value = r.get("grain"), r.get("horizon"), r.get("value")
    if not ok:
        return {"headline": "No series had enough history to forecast.", "kpis": [], "sections": []}
    s0 = ok[0]
    pts = s0.get("points") or []
    total = sum(p["value"] for p in pts)
    mases = [s["mase"] for s in ok if isinstance(s.get("mase"), (int, float))]
    hist = (s0.get("history") or [])[-60:]
    x = [p["period"][:10] for p in hist] + [p["period"][:10] for p in pts]
    actual = [p["value"] for p in hist] + [None] * len(pts)
    fc = [None] * (len(hist) - 1) + ([hist[-1]["value"]] if hist else []) + [p["value"] for p in pts]
    band = {"lo": [None] * len(hist) + [p.get("lo80") for p in pts], "hi": [None] * len(hist) + [p.get("hi80") for p in pts]}
    line = _m.sec_line(f"{value} per {grain}" + (f" · {s0['series']}" if s0.get("series") is not None else ""), x,
                       [{"name": "Actual", "values": actual}, {"name": "Forecast", "values": fc, "dashed": True}], "number", band=band,
                       note="Shaded: the 80% range.")
    if r.get("group") is None:
        headline = f"Next {h} {grain}s of {value}: {_m.num(total)} in total ({s0.get('method')})."
        kpis = [_m.kpi(f"Next {grain}", pts[0]["value"] if pts else None, note=f"80% range {_m.num(pts[0].get('lo80'))}–{_m.num(pts[0].get('hi80'))}" if pts else None),
                _m.kpi(f"Next {h} {grain}s", total), _m.kpi("Backtest MASE", s0.get("mase"), display=f"{s0['mase']:.2f}" if s0.get("mase") is not None else "—",
                                                            note="below 1 beats “same as last season”"),
                _m.kpi("Method", None, display=str(s0.get("method") or "—"))]
        return {"headline": headline, "kpis": kpis, "sections": [line]}
    headline = (f"{len(ok)} series forecast for the next {h} {grain}s" +
                (f"; median backtest MASE {float(np.median(mases)):.2f}" if mases else "") + ".")
    kpis = [_m.kpi("Series forecast", len(ok), "integer"), _m.kpi("Median MASE", float(np.median(mases)) if mases else None,
                                                                    display=f"{float(np.median(mases)):.2f}" if mases else "—", note="below 1 beats “same as last season”"),
            _m.kpi(f"Next {h} {grain}s, all series", sum(sum(p["value"] for p in s.get("points") or []) for s in ok))]
    table = _m.sec_table("Every series", [_m.column("series", "Series"), _m.column("next", f"Next {grain}", "number"),
                                          _m.column("total", f"Next {h} {grain}s", "number"), _m.column("mase", "MASE", "number"),
                                          _m.column("method", "Method")],
                         [{"series": s["series"], "next": (s["points"] or [{}])[0].get("value"), "total": sum(p["value"] for p in s["points"]),
                           "mase": s.get("mase"), "method": s.get("method")} for s in ok])
    return {"headline": headline, "kpis": kpis, "sections": [line, table]}


def _class_report(pipe, X_te: pd.DataFrame, y_te: pd.Series) -> tuple[list[dict], dict]:
    from sklearn.metrics import confusion_matrix, precision_recall_fscore_support
    pred = pipe.predict(X_te)
    labels = list(pd.Series(y_te).value_counts().index)
    p, rc, f, sup = precision_recall_fscore_support(y_te, pred, labels=labels, zero_division=0)
    per = [{"category": str(c), "rows": int(n), "precision": float(a), "recall": float(b), "f1": float(x)} for c, a, b, x, n in zip(labels, p, rc, f, sup)]
    show = labels[:15]
    cm = confusion_matrix(y_te, pred, labels=show).astype(float)
    rows = cm.sum(axis=1, keepdims=True)
    rows[rows == 0] = 1
    return per, {"labels": [str(c) for c in show], "values": (cm / rows).round(4).tolist()}


# ===================================================== newer kinds ====
# 2026-10-09 (round 15): time_to_event, what_if, marketing_mix,
# bought_together, cohorts, recommendations, uplift, price, attribution,
# text_tag, sentiment, themes and doc_facts. Each has a resolver (checks the
# columns on the real data and fills in what it can guess - used by both the
# plan and the training job, so they agree), plan rows, and a trainer that
# runs inside the background Job with its own STAGES.

def _dateish(s: pd.Series) -> bool:
    if _datetime_like(s):
        return True
    if s.dtype == object:
        sample = s.dropna().astype(str).head(100)
        if len(sample) < 3 or pd.to_numeric(sample, errors="coerce").notna().mean() > 0.5:
            return False
        return bool(_m.to_time(sample).notna().mean() > 0.9)
    return False


def _numeric(s: pd.Series) -> bool:
    return pd.api.types.is_numeric_dtype(s) and not pd.api.types.is_bool_dtype(s)


def _texty(s: pd.Series) -> bool:
    return not pd.api.types.is_numeric_dtype(s) and not _dateish(s)


def _pick(df: pd.DataFrame, spec: dict, key: str, what: str, pattern: str | None = None, pred=None, required: bool = True,
          exclude=()) -> str | None:
    """The column the person chose (it must exist), else a guess from the
    column names checked on the data, else a plain request to pick one."""
    v = spec.get(key)
    if v:
        if v not in df.columns:
            raise StudioError(f"There is no column called {v} in this data.")
        return v
    if pattern:
        for c in df.columns:
            if c in exclude or str(c).startswith("__"):
                continue
            if re.search(pattern, str(c).lower()) and (pred is None or pred(df[c])):
                spec[key] = c
                return c
    if required:
        raise StudioError(f"Pick {what}.")
    return None


def _text_column(df: pd.DataFrame, spec: dict) -> str:
    v = spec.get("text_column")
    if v:
        if v not in df.columns:
            raise StudioError(f"There is no column called {v} in this data.")
        return v
    best, score = None, 0.0
    for c in df.columns:
        s = df[c]
        if pd.api.types.is_numeric_dtype(s) or _dateish(s):
            continue
        sample = s.dropna().astype(str).head(500)
        if not len(sample):
            continue
        avg = float(sample.str.len().mean())
        words = float(sample.str.count(r"\s+").mean())
        if avg < 15 or words < 2:
            continue
        sc = avg + (200 if re.search(_NAMES["text_column"], str(c).lower()) else 0)
        if sc > score:
            best, score = c, sc
    if not best:
        raise StudioError("Pick the column with the text - no column here holds sentences (at least a few words per row).")
    spec["text_column"] = best
    return best


def _texts(df: pd.DataFrame, col: str) -> pd.Series:
    t = df[col].astype(str).where(df[col].notna(), "").str.slice(0, 1500)
    return t.where(t.str.strip().str.len() > 0)


def _grain_code(grain: str) -> str:
    return {"day": "D", "week": "W-SUN", "month": "M", "quarter": "Q"}[grain]


def _base_results(kind: str, df: pd.DataFrame, capped: bool, joined: dict, warnings: list[str] | None = None, **extra) -> dict:
    return {"kind": kind, "rows_total": int(len(df)), "capped": bool(capped), "joins": joined.get("joins") or [],
            "warnings": list(warnings or []) + list(joined.get("warnings") or []), "memory_note": None, **extra}


def _plan_rows(answer: tuple[str, str], data_v: str, data_note: str, method: tuple[str, str], test: tuple[str, str], output: tuple[str, str],
               extra: list[dict] | None = None) -> list[dict]:
    rows = [{"k": "Answer", "v": answer[0], "m": answer[1]}] + (extra or []) + [
        {"k": "Data", "v": data_v, "m": data_note},
        {"k": "Method", "v": method[0], "m": method[1]},
        {"k": "Fair test", "v": test[0], "m": test[1]},
        {"k": "Output", "v": output[0], "m": output[1]},
    ]
    return rows


class _LLM:
    """The language model, used only where a kind says so - one failure and
    the run uses its built-in fallback for the rest."""

    def __init__(self):
        self.ok, self.calls = True, 0

    def ask(self, system: str, user: str, max_tokens: int = 2500) -> dict | None:
        if not self.ok:
            return None
        try:
            from . import ai_engine
            out = ai_engine._plan_with_retry([{"role": "system", "content": system}, {"role": "user", "content": user}], max_tokens=max_tokens)
            self.calls += 1
            if isinstance(out, dict):
                return out
        except Exception as e:  # noqa: BLE001 - no AI means the fallback, never a failed run
            logger.info("[ml_studio] language model unavailable: %s", e)
        self.ok = False
        return None


# -------- time to event

def _resolve_tte(df: pd.DataFrame, spec: dict) -> dict:
    dur = _pick(df, spec, "duration_column", "", required=False)
    start = end = en = None
    if not dur:
        start = _pick(df, spec, "start_column", "the start date (when the clock starts) - or a column that already holds the duration in days",
                      _NAMES["start_column"], _dateish)
        end = _pick(df, spec, "end_column", "", _NAMES["end_column"], _dateish, required=False, exclude={start})
    chosen_ev = bool(spec.get("event_column"))
    ev = _pick(df, spec, "event_column", "", _NAMES["event_column"], lambda s: not _dateish(s) and s.nunique() <= 10, required=False,
               exclude={start, end, dur})
    if dur:
        d = pd.to_numeric(df[dur], errors="coerce")
        ref = None
        if d.notna().mean() < 0.5:
            raise StudioError(f"{dur} isn't a number of days in most rows.")
    else:
        st = _m.to_time(df[start])
        if st.notna().mean() < 0.8:
            raise StudioError(f"{start} isn't a date in most rows.")
        en = _m.to_time(df[end]) if end else None
        ref = max([x for x in (st.max(), en.max() if en is not None else None) if x is not None and pd.notna(x)])
        stop = en.fillna(ref) if en is not None else pd.Series(ref, index=df.index)
        d = (stop - st).dt.total_seconds() / 86400
    e = None
    if ev:
        try:
            e = _m.flags(df[ev], ev)
        except _m.MethodError as x:
            if chosen_ev or en is None:
                raise StudioError(str(x)) from x
            spec["event_column"], ev = None, None
    if e is None:
        if en is None:
            raise StudioError("Pick the column that says whether it has happened (1 = happened, 0 or empty = still waiting), or the end-date column.")
        e = en.notna().astype(int)
    if ev and en is not None:
        d = d.where(~((e == 1) & en.isna()))  # happened, but when is unknown
    ok = d.notna() & (d >= 0)
    if ok.sum() < 40:
        raise StudioError(f"Only {int(ok.sum())} rows have a usable duration - at least 40 are needed.")
    n_ev = int(e[ok].sum())
    if n_ev < 10:
        raise StudioError(f"Only {n_ev} rows have the event - at least 10 are needed to learn when it happens.")
    group = spec.get("group_column")
    if group and group not in df.columns:
        raise StudioError(f"There is no column called {group} in this data.")
    return {"start": start, "end": end, "duration": dur, "event": ev, "group": group, "d": d, "e": e, "ok": ok, "ref": ref}


def _tte_horizon(cfg: dict, spec: dict, km: dict | None = None) -> tuple[int, str]:
    if spec.get("horizon"):
        return max(1, int(float(spec["horizon"]))), "the number of days you chose"
    km = km or _m.kaplan_meier(cfg["d"][cfg["ok"]], cfg["e"][cfg["ok"]])
    if km["median"] is not None:
        return max(1, int(round(km["median"]))), "the median time"
    dd = cfg["d"][cfg["ok"] & (cfg["e"] == 1)]
    return max(1, int(round(float(dd.median())))), "the median time among those where it happened (fewer than half have so far)"


def _plan_tte(df, spec, data_v, data_note, n):
    cfg = _resolve_tte(df, spec)
    ok, e = cfg["ok"], cfg["e"]
    km = _m.kaplan_meier(cfg["d"][ok], e[ok])
    H, how = _tte_horizon(cfg, spec, km)
    span = f"{cfg['start']} → {cfg['end'] or 'the latest date in the data'}" if cfg["start"] else f"{cfg['duration']} (days)"
    rows = _plan_rows(
        ("How long until it happens, and the chance it happens within " + f"{H} days for every row",
         f"median {km['median']:.0f} days" if km["median"] is not None else "fewer than half have had it yet"),
        data_v, data_note,
        ("Kaplan–Meier survival curves" + (f", for each {cfg['group']} (up to 6)" if cfg["group"] else "") +
         f"; then gradient boosting, random forest and a linear model predict the chance within {H} days ({how})",
         "rows still waiting before that many days are left out of the model - never counted as “no”"),
        ("Trained on older starts, tested on the most recent 20%" if cfg["start"] else "Trained on a random 80% of rows, tested on the other 20%",
         "baseline to beat: the single most telling column alone"),
        (f"chance_within_{H}d for every row, survival curves and the median time", "a new saved table when you score"),
        extra=[{"k": "Durations", "v": span, "m": f"{int(ok.sum()):,} rows · {int(e[ok].sum()):,} happened · {int((ok & (e == 0)).sum()):,} still waiting (counted as waiting, not as never)"}])
    spec["horizon"] = spec.get("horizon") or None
    return rows, {"title": f"When will it happen - and the chance within {H} days", "horizon_days": H}


def _train_tte(db, job, user, spec):
    m = job.m
    df, entry, capped, joined = _load_for_job(db, job, user, spec, spec.get("start_column"))
    job.stage("durations", "running")
    cfg = _resolve_tte(df, spec)
    ok, d, e = cfg["ok"], cfg["d"], cfg["e"]
    job.stage("durations", "done", f"{int(ok.sum()):,} durations · {int(e[ok].sum()):,} happened")
    job.check_stop()
    job.stage("curves", "running")
    km = _m.kaplan_meier(d[ok], e[ok])
    H, how = _tte_horizon(cfg, spec, km)
    q = float(np.nanpercentile(d[ok], 95)) or float(d[ok].max())
    grid = np.unique(np.round(np.linspace(0, max(q, 1.0), 41)))
    curves = [{"name": "Everyone", "values": [round(float(v), 4) for v in _m.survival_at(km, grid)]}]
    band = {"lo": [round(float(v), 4) for v in _m.survival_at(km, grid, "lo")], "hi": [round(float(v), 4) for v in _m.survival_at(km, grid, "hi")]}
    groups = []
    if cfg["group"]:
        gser = df[cfg["group"]].astype(str).where(df[cfg["group"]].notna(), "(empty)")
        for g in gser[ok].value_counts().index[:6]:
            mask = ok & (gser == g)
            if mask.sum() < 10:
                continue
            kg = _m.kaplan_meier(d[mask], e[mask])
            curves.append({"name": str(g), "values": [round(float(v), 4) for v in _m.survival_at(kg, grid)]})
            groups.append({"group": str(g), "rows": int(mask.sum()), "happened": int(e[mask].sum()), "median_days": kg["median"],
                           "still_waiting_at_h": float(_m.survival_at(kg, [H])[0])})
    job.stage("curves", "done", f"median {km['median']:.0f} days" if km["median"] is not None else "fewer than half have had it yet")
    job.check_stop()
    within = pd.Series(None, index=df.index, dtype=object)
    within[ok & (e == 1) & (d <= H)] = "yes"
    within[ok & (d > H)] = "no"
    label = f"within_{H}d"
    work = df[within.notna()].copy()
    work[label] = within[within.notna()].values
    if len(work) < 40 or work[label].value_counts().min() < 5:
        raise StudioError(f"Too few rows have been watched for {H} days to learn the chance within {H} days - try a shorter horizon.")
    drop = [c for c in (cfg["start"], cfg["end"], cfg["duration"], cfg["event"]) if c]
    spec2 = {**spec, "problem_type": "yes_no", "target": label, "positive_value": "yes",
             "time_column": cfg["start"], "exclude": list(spec.get("exclude") or []) + drop,
             "exclude_reasons": {c: "Part of the answer (when it started, ended or whether it happened)." for c in drop}}
    _train_supervised(db, job, user, spec2, frame=(work.reset_index(drop=True), len(df), capped, joined))
    r = dict(m.results or {})
    r.update(problem="time_to_event", horizon_days=H, horizon_how=how,
             survival={"x": [int(x) for x in grid], "curves": curves, "band": band, "median_days": km["median"], "rows": km["n"],
                       "happened": km["events"], "groups": groups})
    sup = _present_supervised("yes_no", r)
    med = km["median"]
    s_h = float(_m.survival_at(km, [H])[0])
    same = med is not None and int(round(med)) == H
    headline = ((f"Half have it happen within {med:.0f} days. " if med is not None else
                 f"Fewer than half have had it happen yet ({km['events']:,} of {km['n']:,}). ") +
                ("" if same else f"{(1 - s_h) * 100:.0f}% happen within {H} days. ") +
                f"The model gives each row its own chance of it happening within {H} days (ROC AUC {_score_disp('binary', r.get('test_score'))} on held-out rows).")
    kpis = [_m.kpi("Median time", med, display=f"{med:.0f} days" if med is not None else "not reached", note="Kaplan–Meier, counting rows still waiting"),
            _m.kpi(f"Happen within {H} days", 1 - s_h, "percent"),
            _m.kpi("Happened so far", km["events"], "integer", note=f"of {km['n']:,} rows"),
            _m.kpi("ROC AUC (held-out)", r.get("test_score"), display=_score_disp("binary", r.get("test_score")), note=f"chance within {H} days")]
    sections = [_m.sec_line("Share still waiting, by days since the start", [str(int(x)) for x in grid], curves, "percent", band=band,
                            note="Kaplan–Meier: rows still waiting count until the day they were last seen. Shaded: 95% range for everyone.")]
    if groups:
        sections.append(_m.sec_table(f"By {cfg['group']}", [_m.column("group", cfg["group"]), _m.column("rows", "Rows", "integer"),
                                                           _m.column("happened", "Happened", "integer"), _m.column("median_days", "Median days", "number"),
                                                           _m.column("still_waiting_at_h", f"Still waiting at {H} days", "percent")], groups))
    r.update(headline=headline, kpis=kpis, sections=sections + sup["sections"])
    m.results = r
    m.target_column = label


# -------- what-if

_MEAN_WORDS = r"price|rate|pct|percent|ratio|avg|average|mean|temp|score|share|index|discount|margin"


def _resolve_what_if(df: pd.DataFrame, spec: dict) -> dict:
    t = _pick(df, spec, "time_column", "the date column", r"date|day|week|month|time|period", _dateish)
    v = _pick(df, spec, "value_column", "the outcome (a number, like revenue)", r"revenue|sales|orders|bookings|signups|conversions|amount|units|value",
              _numeric, exclude={t})
    if not _numeric(df[v]):
        raise StudioError(f"{v} isn't a number.")
    drivers = [c for c in (spec.get("drivers") or []) if c]
    for c in drivers:
        if c not in df.columns:
            raise StudioError(f"There is no column called {c} in this data.")
        if not _numeric(df[c]):
            raise StudioError(f"{c} isn't a number, so it can't be raised or lowered by a percentage.")
    scen = dict(spec.get("scenario") or {})
    for c in scen:
        if c not in df.columns:
            raise StudioError(f"The scenario changes {c}, but there is no such column.")
        if c not in drivers and _numeric(df[c]):
            drivers.append(c)
    if not drivers:
        for c in df.columns:
            if c in (t, v) or str(c).startswith("__") or not _numeric(df[c]):
                continue
            if df[c].nunique() < 5 or (pd.api.types.is_integer_dtype(df[c]) and df[c].nunique() >= 0.9 * len(df) and len(df) > 50):
                continue
            drivers.append(c)
            if len(drivers) >= 8:
                break
    if not drivers:
        raise StudioError("Pick at least one driver - a number that could change, like ad spend or price.")
    if not scen:
        scen = {drivers[0]: 10.0}
    try:
        scen = {c: float(p) for c, p in scen.items()}
    except (TypeError, ValueError) as e:
        raise StudioError("Each scenario change is a percentage, like 20 for +20% or -5 for −5%.") from e
    tt = _m.to_time(df[t])
    if tt.notna().mean() < 0.8:
        raise StudioError(f"{t} isn't a date in most rows.")
    grain = spec.get("grain") if spec.get("grain") in ("day", "week", "month") else _grain_for(tt)
    per = tt.dt.to_period(_grain_code(grain)).dt.start_time
    how = {c: ("mean" if re.search(_MEAN_WORDS, c.lower()) else "sum") for c in drivers}
    work = pd.DataFrame({"p": per, v: pd.to_numeric(df[v], errors="coerce"), **{c: pd.to_numeric(df[c], errors="coerce") for c in drivers}})
    agg = work.dropna(subset=["p"]).groupby("p").agg({v: "sum", **how}).sort_index()
    agg = agg.dropna(subset=[v])
    if len(agg) < 20:
        raise StudioError(f"What-if needs at least 20 {grain}s of history; this data has {len(agg)}. Try a finer grain (day or week) or more history.")
    return {"time": t, "value": v, "drivers": drivers, "scenario": scen, "grain": grain, "agg": agg.fillna(0.0), "how": how}


def _season_features(idx: pd.DatetimeIndex, grain: str) -> pd.DataFrame:
    n = len(idx)
    out = pd.DataFrame({"__trend": np.arange(n, dtype=float)}, index=idx)
    if grain == "month":
        w = 2 * np.pi * (idx.month - 1) / 12
    else:
        w = 2 * np.pi * idx.dayofyear / 365.25
    out["__season_sin"], out["__season_cos"] = np.sin(w), np.cos(w)
    out["__season_sin2"], out["__season_cos2"] = np.sin(2 * w), np.cos(2 * w)
    if grain == "day":
        for k in range(6):
            out[f"__weekday_{k}"] = (idx.weekday == k).astype(float)
    return out


def _plan_what_if(df, spec, data_v, data_note, n):
    cfg = _resolve_what_if(df, spec)
    scen = ", ".join(f"{c} {p:+g}%" for c, p in cfg["scenario"].items())
    periods = len(cfg["agg"])
    rows = _plan_rows((f"{cfg['value']} if {scen}, compared with what actually happened", "per " + cfg["grain"]),
                      data_v, data_note,
                      ("Gradient boosting or a ridge model (whichever tests better; ridge only below 40 periods) on the drivers plus trend and season",
                       ", ".join(f"{c} ({cfg['how'][c]})" for c in cfg["drivers"])),
                      ("Fit on the older 80% of periods, scored on the most recent 20%", f"{periods} {cfg['grain']}s"),
                      ("Scenario vs baseline for the most recent periods, the effect of +10% in each driver, and a chart", "associations, not proof of cause"))
    return rows, {"title": f"What happens to {cfg['value']} if {scen}", "drivers": cfg["drivers"], "scenario": cfg["scenario"], "grain": cfg["grain"]}


def _train_what_if(db, job, user, spec):
    from sklearn.pipeline import make_pipeline
    m = job.m
    df, entry, capped, joined = _load_for_job(db, job, user, spec, spec.get("time_column"))
    job.stage("series", "running")
    cfg = _resolve_what_if(df, spec)
    agg, v, drivers, grain = cfg["agg"], cfg["value"], cfg["drivers"], cfg["grain"]
    n = len(agg)
    X = pd.concat([agg[drivers], _season_features(pd.DatetimeIndex(agg.index), grain)], axis=1)
    y = agg[v].values.astype(float)
    job.stage("series", "done", f"{n} {grain}s · {len(drivers)} driver{'s' if len(drivers) != 1 else ''}")
    job.check_stop()
    job.stage("train", "running")
    cut = max(int(n * 0.8), n - max(4, int(n * 0.2)))
    inner = max(int(cut * 0.8), 8)
    cands = {"ridge": ("Ridge (linear)", lambda: make_pipeline(StandardScaler(), Ridge(alpha=1.0)))}
    if n >= 40:
        cands["hgb"] = ("Gradient boosting", lambda: HistGradientBoostingRegressor(max_iter=300, learning_rate=0.05, min_samples_leaf=max(3, n // 15),
                                                                                    random_state=0))
    board = []
    for key, (label, make) in cands.items():
        mdl = make().fit(X.iloc[:inner], y[:inner])
        val = _m.r2(y[inner:cut], mdl.predict(X.iloc[inner:cut]))
        mdl = make().fit(X.iloc[:cut], y[:cut])
        pred = mdl.predict(X.iloc[cut:])
        test = _m.r2(y[cut:], pred)
        mape = float(np.mean(np.abs(pred - y[cut:]) / np.maximum(np.abs(y[cut:]), 1e-9)))
        board.append({"algorithm": label, "key": key, "score": val, "test_score": test, "test_second": mape, "trials": 1, "state": "done"})
    win = max(board, key=lambda b: b["score"] if b["score"] is not None and math.isfinite(b["score"]) else -1e9)
    for b in board:
        b["best"] = b is win
    job.save(leaderboard=_m.clean(board))
    job.stage("train", "done", f"{win['algorithm']}: R² {_score_disp('number', win['test_score'])} on the last {n - cut} {grain}s")
    job.check_stop()
    job.stage("scenario", "running")
    model = cands[win["key"]][1]().fit(X, y)
    fitted = model.predict(X)
    N = int(spec.get("horizon") or max(4, min(13, n // 5)))
    N = min(N, n)
    last = X.iloc[-N:].copy()
    base = model.predict(last)
    scen = last.copy()
    out_of_range = 0
    for c, p in cfg["scenario"].items():
        scen[c] = scen[c] * (1 + p / 100.0)
        out_of_range += int(((scen[c] > X[c].max()) | (scen[c] < X[c].min())).sum())
    alt = model.predict(scen)
    b_tot, s_tot = float(base.sum()), float(alt.sum())
    diff = (s_tot - b_tot) / abs(b_tot) if b_tot else None
    sens = []
    for c in drivers:
        t2 = last.copy()
        t2[c] = t2[c] * 1.10
        ch = float(model.predict(t2).sum() - base.sum())
        sens.append({"driver": c, "change": ch, "pct": ch / abs(b_tot) if b_tot else None})
    sens.sort(key=lambda s: -abs(s["change"]))
    job.stage("scenario", "done", f"{diff * 100:+.1f}% over the last {N} {grain}s" if diff is not None else "")
    warnings = []
    if win["key"] == "hgb" and out_of_range:
        warnings.append(f"{out_of_range} scenario values are outside anything seen in the history; a tree model holds them at the edge of what it saw, so the effect may be understated.")
    if (win["test_score"] or 0) < 0.3:
        warnings.append(f"The model explains little of {v} on the held-out periods (R² {_score_disp('number', win['test_score'])}), so treat the scenario as a rough direction.")
    scen_txt = ", ".join(f"{c} {p:+g}%" for c, p in cfg["scenario"].items())
    labels = [d.strftime("%Y-%m-%d") for d in agg.index]
    show = slice(max(0, n - 104), n)
    scen_line = [None] * (n - N) + [float(x) for x in alt]
    m.model_artifact = None
    m.feature_columns, m.excluded_columns, m.algorithm, m.task_type = drivers, [], f"studio_whatif_{win['key']}", "scenario"
    m.trained_row_count = int(n)
    m.metrics = {"r2": win["test_score"], "mape": win["test_second"], "scenario_change_pct": diff}
    m.results = _base_results("what_if", df, capped, joined, warnings, value=v, drivers=drivers, scenario=cfg["scenario"], grain=grain,
                              periods=n, compare_periods=N, baseline_total=b_tot, scenario_total=s_tot, change_pct=diff,
                              test_r2=win["test_score"], test_mape=win["test_second"], model=win["algorithm"], sensitivity=sens,
                              aggregation=cfg["how"], leaderboard=board)
    m.results.update(
        headline=(f"If {scen_txt}, {v} over the last {N} {grain}s would have been about {_m.num(s_tot)} instead of {_m.num(b_tot)} "
                  f"({diff * 100:+.1f}%) - an association learnt from history, not proof of cause." if diff is not None else "No baseline to compare with."),
        kpis=[_m.kpi("Baseline", b_tot, note=f"model, actual drivers, last {N} {grain}s"), _m.kpi("Scenario", s_tot, note=scen_txt),
              _m.kpi("Difference", diff, "percent", display=f"{diff * 100:+.1f}%" if diff is not None else "—"),
              _m.kpi("Fit on held-out periods", win["test_score"], display=f"R² {_score_disp('number', win['test_score'])}", note=win["algorithm"])],
        sections=[
            _m.sec_line(f"{v} per {grain}", labels[show], [
                {"name": "Actual", "values": [float(x) for x in y[show]]},
                {"name": "Model", "values": [float(x) for x in fitted[show]]},
                {"name": "Scenario", "values": scen_line[show], "dashed": True}], "number"),
            _m.sec_bars(f"Effect of +10% in each driver on {v} (last {N} {grain}s)",
                        [_m.bar(s["driver"], s["pct"], "percent", tone="up" if s["change"] > 0 else "down" if s["change"] < 0 else "neutral",
                                display=f"{(s['pct'] or 0) * 100:+.1f}%") for s in sens], "percent"),
            _m.sec_text("How to read this", f"The model learnt how {v} moved with {', '.join(drivers)} (plus trend and season) over {n} {grain}s. "
                        "It shows what usually went with higher or lower values in the past; it cannot tell whether changing a driver causes the change - "
                        "for that, run a test (see “Who responds to an offer”) or a marketing mix model.")])


# -------- marketing mix

def _resolve_mmm(df: pd.DataFrame, spec: dict) -> dict:
    t = _pick(df, spec, "time_column", "the date column", r"date|day|week|month|time|period", _dateish)
    v = _pick(df, spec, "value_column", "the sales or revenue column", r"revenue|sales|orders|conversions|bookings|units|value", _numeric, exclude={t})
    spend = [c for c in (spec.get("spend_columns") or []) if c and c != v]
    for c in spend:
        if c not in df.columns:
            raise StudioError(f"There is no column called {c} in this data.")
    if not spend:
        spend = [c for c in df.columns if c not in (t, v) and _numeric(df[c]) and re.search(_NAMES["spend_columns"], str(c).lower())]
    if not spend:
        raise StudioError("Pick the spend columns - one column of spend per channel (for example search_spend, tv_spend). "
                          "None is named spend, cost or budget.")
    if not _numeric(df[v]):
        raise StudioError(f"{v} isn't a number.")
    tt = _m.to_time(df[t])
    if tt.notna().mean() < 0.8:
        raise StudioError(f"{t} isn't a date in most rows.")
    wk = tt.dt.to_period("W-SUN").dt.start_time
    work = pd.DataFrame({"w": wk, "day": tt.dt.normalize(), "y": pd.to_numeric(df[v], errors="coerce").fillna(0.0),
                         **{c: pd.to_numeric(df[c], errors="coerce").fillna(0.0) for c in spend}}).dropna(subset=["w"])
    agg = work.groupby("w").agg({"y": "sum", **{c: "sum" for c in spend}}).sort_index()
    days = work.groupby("w")["day"].nunique()
    notes = []
    if days.median() >= 5:  # daily data: a partly covered first/last week would look like a slump
        for end in (agg.index[0], agg.index[-1]):
            if days.get(end, 7) < days.median() and len(agg) > 2:
                agg = agg.drop(index=end)
                notes.append(f"The week of {_d(end)} is only partly covered, so it was left out.")
    full = pd.date_range(agg.index.min(), agg.index.max(), freq="7D")
    gaps = len(full) - len(agg)
    if gaps > 0:
        notes.append(f"{gaps} week{'s' if gaps != 1 else ''} in the range have no rows; spend there counts as 0 for carry-over.")
    if len(agg) < 26:
        raise StudioError(f"A marketing mix model needs at least 26 weeks of spend and sales; this data covers {len(agg)} week{'s' if len(agg) != 1 else ''}.")
    zero = [c for c in spend if agg[c].sum() <= 0]
    spend = [c for c in spend if c not in zero]
    if not spend:
        raise StudioError("Every spend column is zero in this data.")
    if zero:
        notes.append(f"No spend at all in {', '.join(zero)}, so {'it was' if len(zero) == 1 else 'they were'} left out.")
    if len(spend) > 12:
        spend = list(agg[spend].sum().sort_values(ascending=False).index[:12])
        notes.append("Only the 12 channels with the most spend are modelled.")
    return {"time": t, "value": v, "spend": spend, "agg": agg, "notes": notes}


def _plan_mmm(df, spec, data_v, data_note, n):
    cfg = _resolve_mmm(df, spec)
    weeks = len(cfg["agg"])
    rows = _plan_rows((f"What each channel's spend adds to {cfg['value']}, its return per unit spent, and where an extra unit earns most",
                       f"{len(cfg['spend'])} channels: {', '.join(cfg['spend'])}"),
                      data_v, data_note,
                      ("Weekly carry-over (adstock, decay 0–0.8 chosen per channel on a validation slice) and diminishing returns (log), with "
                       "channel effects kept at zero or above, plus trend and season", "least squares with bounds"),
                      ("Fit on the older 80% of weeks, R² on the most recent 20%", f"{weeks} weeks"),
                      ("Contribution, ROI and marginal ROI per channel, and a suggested 10% move of budget", "observational: channels that always move together can't be fully separated"))
    return rows, {"title": f"How much {cfg['value']} each channel's spend brings", "spend_columns": cfg["spend"], "weeks": weeks,
                  "warnings_extra": cfg["notes"]}


def _train_mmm(db, job, user, spec):
    m = job.m
    df, entry, capped, joined = _load_for_job(db, job, user, spec, spec.get("time_column"))
    job.stage("series", "running")
    cfg = _resolve_mmm(df, spec)
    agg, names = cfg["agg"], cfg["spend"]
    woy = np.asarray(pd.DatetimeIndex(agg.index).isocalendar().week, dtype=float)
    job.stage("series", "done", f"{len(agg)} weeks · {len(names)} channels")
    job.check_stop()
    job.stage("train", "running")
    curve = []

    def on_trial(trial, sc, best, ch, g):
        curve.append({"trial": trial, "best": best, "score": sc, "algorithm": f"{ch} decay {g:.1f}"})
        if trial % 6 == 0:
            job.save(curve=_m.clean(curve[-200:]), trials_done=trial, message=f"Trial {trial} · best validation R² {best:.3f}")

    res = _m.marketing_mix(agg["y"].values, agg[names].values, woy, names, on_trial=on_trial)
    job.save(curve=_m.clean(curve[-200:]), trials_done=len(curve), trials_total=len(curve))
    job.stage("train", "done", "decay: " + ", ".join(f"{k} {v:.1f}" for k, v in res["decays"].items()))
    job.stage("test", "running")
    job.stage("test", "done", f"R² {_score_disp('number', res['test_r2'])} on the last {res['weeks'] - res['test_from']} weeks")
    job.stage("explain", "running")
    ch = sorted(res["channels"], key=lambda c: -(c["roi"] or 0))
    total_sales = float(agg["y"].sum())
    mk = sum(c["contribution"] for c in ch)
    warnings = list(cfg["notes"])
    if (res["test_r2"] or 0) < 0.3:
        warnings.append(f"The model explains little of the most recent weeks (R² {_score_disp('number', res['test_r2'])}); treat ROI figures as rough.")
    corr = np.corrcoef(agg[names].values.T) if len(names) > 1 else np.array([[1.0]])
    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            if corr[i, j] > 0.85:
                warnings.append(f"{names[i]} and {names[j]} almost always move together (correlation {corr[i, j]:.2f}), so the split of credit between them is uncertain.")
    ra = res["realloc"]
    job.stage("explain", "done", f"best ROI: {ch[0]['channel']}" if ch else "")
    m.model_artifact = None
    m.feature_columns, m.excluded_columns, m.algorithm, m.task_type = names, [], "studio_mmm_adstock", "marketing_mix"
    m.trained_row_count = int(res["weeks"])
    m.metrics = {"r2": res["test_r2"], "weeks": res["weeks"]}
    weeks = [d.strftime("%Y-%m-%d") for d in agg.index]
    m.results = _base_results("marketing_mix", df, capped, joined, warnings, value=cfg["value"], weeks=res["weeks"], channels=ch,
                              test_r2=res["test_r2"], validation_r2=res["validation_r2"], decays=res["decays"], reallocation=ra,
                              marketing_share=mk / total_sales if total_sales else None, base_sales=res["base"])
    realloc_text = (f"Moving 10% of {ra['from']}'s spend ({_m.num(ra['moved'])}) to {ra['to']} would have changed {cfg['value']} by about "
                    f"{_m.num(ra['change'])} ({ra['change_pct'] * 100:+.2f}%) over these {res['weeks']} weeks, by this model."
                    if ra else "There is only one channel, so there is nothing to move between.")
    m.results.update(
        headline=(f"{ch[0]['channel']} returns the most per unit spent ({_m.num(ch[0]['roi'])} of {cfg['value']} per 1 spent); "
                  f"marketing accounts for about {mk / max(total_sales, 1e-9) * 100:.0f}% of {cfg['value']}. Held-out R² {_score_disp('number', res['test_r2'])}."),
        kpis=[_m.kpi("R² on the last 20% of weeks", res["test_r2"], display=_score_disp("number", res["test_r2"])),
              _m.kpi("Total spend", float(agg[names].values.sum())),
              _m.kpi(f"Share of {cfg['value']} from marketing", mk / total_sales if total_sales else None, "percent"),
              _m.kpi("Best ROI", ch[0]["roi"], note=ch[0]["channel"])],
        sections=[
            _m.sec_table("Each channel", [_m.column("channel", "Channel"), _m.column("spend", "Spend", "number"), _m.column("contribution", f"Adds to {cfg['value']}", "number"),
                                          _m.column("share_of_sales", f"Share of {cfg['value']}", "percent"), _m.column("roi", "ROI (per 1 spent)", "number"),
                                          _m.column("marginal_roi", "Next 1 spent returns", "number"), _m.column("decay", "Carry-over (decay)", "number")],
                         ch, note="ROI = what the channel adds ÷ what it cost. Marginal ROI = what one more unit would add at today's spend (diminishing returns)."),
            _m.sec_bars("Return per unit spent", [_m.bar(c["channel"], c["roi"], tone="up" if (c["roi"] or 0) >= 1 else "down") for c in ch], "number"),
            _m.sec_line(f"{cfg['value']} per week: actual and model", weeks, [{"name": "Actual", "values": [float(x) for x in agg["y"].values]},
                                                                             {"name": "Model", "values": [float(x) for x in res["fitted"]], "dashed": True}], "number"),
            _m.sec_text("Suggested reallocation", realloc_text + " This is learnt from history, not a test: channels' effects are estimated from how sales moved "
                        "with spend, so a planned test is the way to confirm it.")])


# -------- bought together

def _resolve_pairs(df, spec):
    o = _pick(df, spec, "order_column", "the order id column", _NAMES["order_column"], lambda s: s.nunique() > 1)
    i = _pick(df, spec, "item_column", "the product column", _NAMES["item_column"], lambda s: not _dateish(s) and s.nunique() > 1, exclude={o})
    orders = df[o].nunique()
    if orders < 30:
        raise StudioError(f"Only {orders} orders - at least 30 are needed to see which products go together.")
    if not (df.groupby(o)[i].nunique() >= 2).any():
        raise StudioError(f"No {o} has two different {i} values - this looks like one row per order, not one row per order line.")
    return {"order": o, "item": i, "orders": int(orders)}


def _plan_pairs(df, spec, data_v, data_note, n):
    cfg = _resolve_pairs(df, spec)
    thr = max(3, min(int(math.ceil(0.005 * cfg["orders"])), 20))
    rows = _plan_rows((f"Pairs of {cfg['item']} bought in the same {cfg['order']}, ranked by lift", f"{cfg['orders']:,} orders"),
                      data_v, data_note,
                      ("Support, confidence both ways and lift for every pair", f"a pair needs {thr}+ orders together (0.5% of orders, at most 20)"),
                      ("Lift above 1 means more often together than chance would give", "counts, not a model - nothing to overfit"),
                      ("The top 50 pairs, and up to 3 “bought with” products per product when you score", ""))
    return rows, {"title": f"Which {cfg['item']} are bought together"}


def _train_pairs(db, job, user, spec):
    m = job.m
    df, entry, capped, joined = _load_for_job(db, job, user, spec)
    job.stage("baskets", "running")
    cfg = _resolve_pairs(df, spec)
    job.stage("baskets", "done", f"{cfg['orders']:,} orders")
    job.stage("pairs", "running")
    res = _m.basket_pairs(df[cfg["order"]], df[cfg["item"]])
    job.stage("pairs", "done", f"{res['pairs_found']:,} pairs above {res['threshold']} orders together")
    job.stage("explain", "running")
    pairs = res["pairs"]
    warnings = []
    if capped:
        warnings.append("Only the first rows of the table were read (server limit); orders cut at the limit may be missing lines.")
    if not pairs:
        warnings.append(f"No pair of products appears together in {res['threshold']}+ orders.")
    job.stage("explain", "done", f"top lift {pairs[0]['lift']:.1f}" if pairs else "no strong pairs")
    m.model_artifact = _dump({"type": "pairs", "partners": res["partners"], "item": cfg["item"]})
    m.feature_columns, m.excluded_columns, m.algorithm, m.task_type = [cfg["item"]], [], "studio_association_pairs", "association"
    m.trained_row_count = int(len(df))
    m.metrics = {"orders": res["orders"], "pairs": res["pairs_found"]}
    top = pairs[0] if pairs else None
    m.results = _base_results("bought_together", df, capped, joined, warnings, order=cfg["order"], item=cfg["item"],
                              **{k: res[k] for k in ("orders", "products", "multi_share", "threshold", "frequent_items", "pairs_found", "pairs")})
    m.results.update(
        headline=(f"{top['item_a']} and {top['item_b']} are bought together {top['lift']:.1f}× more often than chance "
                  f"({top['orders_together']:,} orders; {top['confidence_a_to_b'] * 100:.0f}% of {top['item_a']} orders include {top['item_b']})."
                  if top else "No pair of products is bought together often enough to call it a pattern."),
        kpis=[_m.kpi("Orders", res["orders"], "integer"), _m.kpi("Products", res["products"], "integer"),
              _m.kpi("Orders with 2+ products", res["multi_share"], "percent"), _m.kpi("Pairs found", res["pairs_found"], "integer",
                                                                                     note=f"together in {res['threshold']}+ orders")],
        sections=[
            _m.sec_table("Products bought together", [_m.column("item_a", "Product A"), _m.column("item_b", "Product B"),
                                                      _m.column("orders_together", "Orders with both", "integer"), _m.column("support", "Share of all orders", "percent"),
                                                      _m.column("confidence_a_to_b", "A orders that include B", "percent"),
                                                      _m.column("confidence_b_to_a", "B orders that include A", "percent"), _m.column("lift", "Lift", "number")],
                         pairs, note="Lift: how many times more often the two are bought together than if they were unrelated."),
            _m.sec_bars("Strongest pairs (lift)", [_m.bar(f"{p['item_a']} + {p['item_b']}", p["lift"], note=f"{p['orders_together']:,} orders") for p in pairs[:10]],
                        "number")])


# -------- cohorts

def _resolve_cohorts(df, spec):
    e = _pick(df, spec, "entity_column", "the customer column", _NAMES["entity_column"], lambda s: not _dateish(s) and s.nunique() > 1)
    t = _pick(df, spec, "time_column", "the order date column", r"date|day|time|created|ordered|purchased", _dateish, exclude={e})
    v = spec.get("value_column")
    if v and v not in df.columns:
        raise StudioError(f"There is no column called {v} in this data.")
    if v and not _numeric(df[v]):
        raise StudioError(f"{v} isn't a number.")
    tt = _m.to_time(df[t])
    if tt.notna().mean() < 0.8:
        raise StudioError(f"{t} isn't a date in most rows.")
    months = (tt.dt.year * 12 + tt.dt.month).nunique()
    if months < 3:
        raise StudioError(f"Cohorts need at least 3 months of orders; this data covers {months}.")
    if df[e].nunique() >= 0.98 * len(df) and len(df) > 50:
        raise StudioError(f"Almost every row has a different {e}, so no customer has a second order to follow - is this one row per customer rather than per order?")
    return {"entity": e, "time": t, "value": v, "months": int(months)}


def _plan_cohorts(df, spec, data_v, data_note, n):
    cfg = _resolve_cohorts(df, spec)
    rows = _plan_rows(("For each month's new customers, the share still buying 1, 2 … 12 months later" + (f", and {cfg['value']} per customer" if cfg["value"] else ""),
                       f"{df[cfg['entity']].nunique():,} customers · {cfg['months']} months"),
                      data_v, data_note,
                      ("Monthly cohorts by first order; a customer is active in a month if they ordered in it", "counts, not a model"),
                      ("Months a cohort hasn't reached yet are left empty, never counted as zero", "the latest month may still be in progress"),
                      ("A retention grid, the average curve" + (" and revenue per customer" if cfg["value"] else ""), "each customer's cohort when you score"))
    return rows, {"title": f"How each month's new {cfg['entity']}s keep buying"}


def _train_cohorts(db, job, user, spec):
    m = job.m
    df, entry, capped, joined = _load_for_job(db, job, user, spec, spec.get("time_column"))
    job.stage("cohorts", "running")
    cfg = _resolve_cohorts(df, spec)
    res = _m.cohort_table(df[cfg["entity"]], df[cfg["time"]], df[cfg["value"]] if cfg["value"] else None)
    job.stage("cohorts", "done", f"{res['customers']:,} customers in {res['cohorts']} cohorts")
    job.stage("explain", "running")
    avg = res["avg"]
    ks = [f"Month {k}" for k in range(res["max_k"] + 1)]
    sections = [
        _m.sec_matrix("Share of each cohort buying, by months since their first order", res["row_labels"], ks, res["matrix"], "percent",
                      note="Rows: the month of the first order (and how many customers started then). Empty: not reached yet."),
        _m.sec_line("Average retention", ks[1:], [{"name": "Share buying", "values": avg[1:]}], "percent",
                    note="Weighted by cohort size, over the cohorts that have reached each month."),
    ]
    kpis = [_m.kpi("Customers", res["customers"], "integer"), _m.kpi("Cohorts", res["cohorts"], "integer", note=f"{res['first_month']} → {res['last_month']}"),
            _m.kpi("Buying again in month 1", avg[1] if len(avg) > 1 else None, "percent"),
            _m.kpi("Buying in month 3", avg[3] if len(avg) > 3 else None, "percent")]
    if res.get("avg_revenue"):
        sections.append(_m.sec_line(f"{cfg['value']} per customer by months since first order", ks,
                                    [{"name": "In that month", "values": res["avg_revenue"]},
                                     {"name": "Running total", "values": res["cum_revenue"], "dashed": True}], "number"))
        cum = [v for v in res["cum_revenue"] if v is not None]
        kpis.append(_m.kpi(f"{cfg['value']} per customer, first {len(cum)} months", cum[-1] if cum else None))
    warnings = ["The latest month may still be in progress, so its retention can look low."]
    if capped:
        warnings.append("Only the first rows of the table were read (server limit), so later orders may be missing.")
    job.stage("explain", "done", f"month-1 retention {avg[1] * 100:.0f}%" if len(avg) > 1 and avg[1] is not None else "")
    m.model_artifact = None
    m.feature_columns, m.excluded_columns, m.algorithm, m.task_type = [cfg["entity"], cfg["time"]], [], "studio_cohorts", "cohorts"
    m.trained_row_count = int(len(df))
    m.metrics = {"customers": res["customers"], "month1_retention": avg[1] if len(avg) > 1 else None}
    m.results = _base_results("cohorts", df, capped, joined, warnings, entity=cfg["entity"], time=cfg["time"], value=cfg["value"],
                              **{k: res[k] for k in ("customers", "cohorts", "first_month", "last_month", "row_labels", "cohort_sizes", "matrix",
                                                     "avg", "avg_revenue", "cum_revenue", "cohorts_observed")})
    m1 = avg[1] if len(avg) > 1 else None
    m.results.update(headline=(f"On average {m1 * 100:.0f}% of new customers buy again in their second month" +
                               (f" and {avg[3] * 100:.0f}% in their fourth" if len(avg) > 3 and avg[3] is not None else "") + "."
                               if m1 is not None else "Not enough months yet to see anyone come back."),
                     kpis=kpis, sections=sections)


# -------- recommendations

def _resolve_recs(df, spec):
    e = _pick(df, spec, "entity_column", "the customer or user column", _NAMES["entity_column"], lambda s: not _dateish(s) and s.nunique() > 1)
    i = _pick(df, spec, "item_column", "the product or content column", _NAMES["item_column"], lambda s: not _dateish(s) and s.nunique() > 1, exclude={e})
    v = spec.get("value_column")
    if v and (v not in df.columns or not _numeric(df[v])):
        raise StudioError(f"{v} isn't a number column in this data.")
    t = spec.get("time_column")
    if t and t not in df.columns:
        raise StudioError(f"There is no column called {t} in this data.")
    if not t:
        t = next((c for c in df.columns if c not in (e, i) and _dateish(df[c])), None)
    per = df.groupby(e)[i].nunique()
    if (per >= 2).sum() < 20:
        raise StudioError(f"Fewer than 20 {e}s have two or more different {i}s - there is too little overlap to learn what goes with what.")
    if df[i].nunique() < 5:
        raise StudioError(f"Only {df[i].nunique()} different {i}s - recommendations need at least 5.")
    return {"entity": e, "item": i, "value": v, "time": t}


def _plan_recs(df, spec, data_v, data_note, n):
    cfg = _resolve_recs(df, spec)
    rows = _plan_rows((f"The next 5 {cfg['item']}s for every {cfg['entity']}, never ones they already have", f"{df[cfg['entity']].nunique():,} {cfg['entity']}s · {df[cfg['item']].nunique():,} {cfg['item']}s"),
                      data_v, data_note,
                      ("Item-to-item similarity (cosine) on who has what" + (f", weighted by {cfg['value']}" if cfg["value"] else ""), "the 2,000 most common items"),
                      (("Each person's most recent item is hidden" if cfg["time"] else "A random 20% of each person's items are hidden") +
                       " and must come back in their top 5", "compared with simply recommending the most popular items"),
                      ("recommendation_1 … recommendation_5 for every row when you score", ""))
    return rows, {"title": f"Recommend the next {cfg['item']} for each {cfg['entity']}"}


def _train_recs(db, job, user, spec):
    m = job.m
    df, entry, capped, joined = _load_for_job(db, job, user, spec, spec.get("time_column"))
    job.stage("matrix", "running")
    cfg = _resolve_recs(df, spec)
    X, users, items, d = _m.user_item_matrix(df[cfg["entity"]], df[cfg["item"]], df[cfg["value"]] if cfg["value"] else None)
    job.stage("matrix", "done", f"{len(users):,} people × {len(items):,} items")
    job.check_stop()
    job.stage("train", "running")
    Sim = _m.item_similarity(X)
    job.stage("train", "done", f"{Sim.nnz:,} item links")
    job.stage("test", "running")
    ev = _m.recommend_eval(d, items, df[cfg["time"]] if cfg["time"] else None)
    job.save(leaderboard=_m.clean([{"algorithm": "Popular items (baseline)", "key": "baseline", "score": ev["popular_hit_rate"], "baseline": True, "trials": 1, "state": "done"},
                                   {"algorithm": "Item similarity", "key": "itemcf", "score": ev["hit_rate"], "trials": 1, "state": "done", "best": True}]))
    job.stage("test", "done", f"hit rate @5 {ev['hit_rate'] * 100:.1f}% vs {ev['popular_hit_rate'] * 100:.1f}% for popular items")
    job.stage("explain", "running")
    recs = _m.recommend(X, Sim, n=5)
    activity = np.asarray((X > 0).sum(axis=1)).ravel()
    sample_rows = []
    for r in np.argsort(-activity, kind="stable")[:20]:
        sample_rows.append({cfg["entity"]: users[r], "has": int(activity[r]), **{f"recommendation_{k + 1}": items[x] for k, x in enumerate(recs[r])}})
    counts = Counter(items[x] for row in recs for x in row)
    covered = sum(1 for row in recs if row) / max(len(recs), 1)
    sim_rows = []
    pop = np.argsort(-np.asarray((X > 0).sum(axis=0)).ravel(), kind="stable")[:10]
    for j in pop:
        a, b = Sim.indptr[j], Sim.indptr[j + 1]
        idx, val = Sim.indices[a:b], Sim.data[a:b]
        top = idx[np.argsort(-val)[:3]]
        sim_rows.append({"item": items[j], "similar": ", ".join(items[t] for t in top)})
    beat = ev["hit_rate"] > ev["popular_hit_rate"]
    warnings = [] if beat else ["Recommending the most popular items did as well as the model on hidden items - the data may have too little overlap between people."]
    job.stage("explain", "done", f"{covered * 100:.0f}% of people get recommendations")
    m.model_artifact = _dump({"type": "recs", "items": items, "sim": Sim, "entity": cfg["entity"], "item": cfg["item"], "weight": cfg["value"]})
    m.feature_columns, m.excluded_columns, m.algorithm, m.task_type = [cfg["entity"], cfg["item"]], [], "studio_item_similarity", "recommendation"
    m.trained_row_count = int(len(d))
    m.metrics = {"hit_rate_at_5": ev["hit_rate"], "popular_hit_rate_at_5": ev["popular_hit_rate"]}
    m.results = _base_results("recommendations", df, capped, joined, warnings, entity=cfg["entity"], item=cfg["item"], users=len(users), items=len(items),
                              hit_rate=ev["hit_rate"], popular_hit_rate=ev["popular_hit_rate"], users_tested=ev["users_tested"], test_how=ev["how"],
                              coverage=covered, beats_baseline=beat)
    m.results.update(
        headline=(f"When one item per person was hidden, it came back in their top 5 for {ev['hit_rate'] * 100:.0f}% of people, "
                  f"vs {ev['popular_hit_rate'] * 100:.0f}% when recommending the most popular items."),
        kpis=[_m.kpi("Hit rate in top 5", ev["hit_rate"], "percent", note=f"{ev['users_tested']:,} people tested · {ev['how']}"),
              _m.kpi("Popular-items baseline", ev["popular_hit_rate"], "percent"),
              _m.kpi("People", len(users), "integer"), _m.kpi("Items", len(items), "integer")],
        sections=[
            _m.sec_table(f"Recommendations for the most active {cfg['entity']}s", [_m.column(cfg["entity"], cfg["entity"]), _m.column("has", "Items they have", "integer")]
                         + [_m.column(f"recommendation_{k}", f"#{k}") for k in range(1, 6)], sample_rows),
            _m.sec_bars("Most recommended", [_m.bar(k, v, "integer") for k, v in counts.most_common(10)], "integer"),
            _m.sec_table("Items most like the popular ones", [_m.column("item", cfg["item"]), _m.column("similar", "Most similar")], sim_rows)])


# -------- uplift

_TREAT_WORDS = ("1", "true", "yes", "y", "treated", "treatment", "variant", "b", "test", "offer", "discount", "got", "sent", "exposed", "promo", "coupon")


def _resolve_uplift(df, spec):
    tr = _pick(df, spec, "treatment_column", "the column saying who got the offer (two groups)", _NAMES["treatment_column"],
               lambda s: s.nunique(dropna=True) == 2)
    vals = [str(v) for v in df[tr].dropna().astype(str).value_counts().index]
    if len(vals) != 2:
        raise StudioError(f"{tr} has {len(vals)} values - “Who responds to an offer” needs exactly two groups (got it / didn't).")
    tv = spec.get("treated_value")
    if tv is None or str(tv) not in vals:
        low = [v.lower() for v in vals]
        tv = next((vals[low.index(w)] for w in _TREAT_WORDS if w in low), None) or sorted(vals)[-1]
    tv = str(tv)
    target = _pick(df, spec, "target", "the outcome (did they buy, how much they spent …)",
                   r"convert|purchas|bought|respon|outcome|revenue|spend|order|redeem|churn", None, exclude={tr})
    y = df[target]
    if _numeric(y) and y.nunique() > 2:
        kind, pos = "number", None
    else:
        distinct = y.dropna().astype(str).value_counts()
        if len(distinct) != 2:
            raise StudioError(f"{target} has {len(distinct)} values - the outcome must be yes/no or a number.")
        pos = spec.get("positive_value")
        if pos is None or str(pos) not in distinct.index:
            pos = _positive_guess(list(distinct.index))
        kind, pos = "binary", str(pos)
    sizes = df[tr].astype(str).value_counts()
    if sizes.min() < 50:
        raise StudioError(f"One group has only {int(sizes.min())} rows - at least 50 in each are needed to compare them.")
    return {"treatment": tr, "treated": tv, "control": next(v for v in vals if v != tv), "target": target, "kind": kind, "positive": pos}


def _plan_uplift(df, spec, data_v, data_note, n):
    cfg = _resolve_uplift(df, spec)
    feats, excluded, _ = _feature_columns(df, {**spec, "target": cfg["target"], "exclude": list(spec.get("exclude") or []) + [cfg["treatment"]]})
    what = f"{cfg['target']} = {cfg['positive']}" if cfg["kind"] == "binary" else cfg["target"]
    rows = _plan_rows((f"How much getting {cfg['treatment']} = {cfg['treated']} changes {what}, for every row - and who it moves most",
                       f"treated: {cfg['treatment']} = {cfg['treated']} · control: {cfg['control']}"),
                      data_v, data_note,
                      ("Two gradient boosting models (one per group); a row's uplift = its prediction if treated − if not", f"{len(feats)} features: " + ", ".join(feats[:6]) + (" …" if len(feats) > 6 else "")),
                      ("Held-out 30%: the rows predicted to respond most must show the biggest real difference between groups",
                       "plus a balance check - if the groups differed before the offer, the effect is partly who got it"),
                      ("uplift_score and a persuadable flag (top 30%) per row when you score", ""))
    return rows, {"title": f"Who {cfg['treatment']} actually moves", "features": feats, "excluded": excluded}


def _uplift_predict(pipe, X, kind):
    if kind == "binary":
        return pipe.predict_proba(X)[:, list(pipe.classes_).index(1)] if 1 in list(pipe.classes_) else np.zeros(len(X))
    return pipe.predict(X)


def _train_uplift(db, job, user, spec):
    m = job.m
    df, entry, capped, joined = _load_for_job(db, job, user, spec)
    job.stage("groups", "running")
    cfg = _resolve_uplift(df, spec)
    df = df[df[cfg["treatment"]].notna() & df[cfg["target"]].notna()].reset_index(drop=True)
    T = (df[cfg["treatment"]].astype(str) == cfg["treated"]).values
    y = ((df[cfg["target"]].astype(str) == cfg["positive"]).astype(int) if cfg["kind"] == "binary"
         else pd.to_numeric(df[cfg["target"]], errors="coerce")).values.astype(float)
    ok = np.isfinite(y)
    df, T, y = df[ok].reset_index(drop=True), T[ok], y[ok]
    feats, excluded, dates = _feature_columns(df, {**spec, "target": cfg["target"], "exclude": list(spec.get("exclude") or []) + [cfg["treatment"]]})
    if not feats:
        raise StudioError("No column is usable to tell people apart - every column is an id, empty or the outcome itself.")
    balance = _m.smd(df, T, feats[:30])
    imbalanced = [b for b in balance if (abs(b["difference"]) > 0.2 if b["kind"].startswith("standardised") else abs(b["difference"]) > 0.15)]
    job.stage("groups", "done", f"{int(T.sum()):,} treated · {int((~T).sum()):,} control" + (f" · {len(imbalanced)} imbalanced" if imbalanced else " · balanced"))
    job.stage("features", "running")
    job.stage("features", "done", f"{len(feats)} features")
    job.check_stop()
    job.stage("train", "running")
    strat = T.astype(int) * 2 + (y > np.median(y)).astype(int) if cfg["kind"] == "number" else T.astype(int) * 2 + y.astype(int)
    tr, te = train_test_split(np.arange(len(df)), test_size=0.3, random_state=0, stratify=strat if np.bincount(strat).min() >= 2 else T)

    def fit(idx):
        prep, _ = _preprocessor(df.iloc[idx], feats, dates, scale=False)
        est = (HistGradientBoostingClassifier if cfg["kind"] == "binary" else HistGradientBoostingRegressor)(
            max_iter=200, learning_rate=0.06, min_samples_leaf=max(20, len(idx) // 200), max_leaf_nodes=15, random_state=0)
        yy = y[idx].astype(int) if cfg["kind"] == "binary" else y[idx]
        return Pipeline([("pre", prep), ("model", est)]).fit(df.iloc[idx][feats], yy)

    tr_t, tr_c = tr[T[tr]], tr[~T[tr]]
    m1, m0 = fit(tr_t), fit(tr_c)
    job.stage("train", "done", "a model for each group")
    job.check_stop()
    job.stage("test", "running")
    Xte = df.iloc[te][feats]
    u = _uplift_predict(m1, Xte, cfg["kind"]) - _uplift_predict(m0, Xte, cfg["kind"])
    order = np.argsort(-u, kind="stable")
    deciles = np.array_split(order, 10)
    bars, dec_rows = [], []
    for k, idx in enumerate(deciles):
        tt, yy = T[te][idx], y[te][idx]
        obs = float(yy[tt].mean() - yy[~tt].mean()) if tt.any() and (~tt).any() else None
        dec_rows.append({"decile": k + 1, "rows": int(len(idx)), "predicted": float(u[idx].mean()), "observed": obs})
        bars.append(_m.bar(f"{k * 10}–{k * 10 + 10}%", obs, "percent" if cfg["kind"] == "binary" else "number",
                           tone="up" if (obs or 0) > 0 else "down" if (obs or 0) < 0 else "neutral",
                           note=f"predicted {u[idx].mean() * (100 if cfg['kind'] == 'binary' else 1):+.1f}{' pts' if cfg['kind'] == 'binary' else ''}"))
    cut = int(len(order) * 0.3)
    top, rest = order[:cut], order[cut:]
    obs_top = _m.diff_ci(y[te][top][T[te][top]], y[te][top][~T[te][top]]) if T[te][top].any() and (~T[te][top]).any() else None
    obs_rest = _m.diff_ci(y[te][rest][T[te][rest]], y[te][rest][~T[te][rest]]) if T[te][rest].any() and (~T[te][rest]).any() else None
    overall = _m.diff_ci(y[T], y[~T])
    job.stage("test", "done", f"top 30%: {obs_top['diff']:+.3f} vs rest {obs_rest['diff']:+.3f}" if obs_top and obs_rest else "")
    job.stage("explain", "running")
    m1f, m0f = fit(np.arange(len(df))[T]), fit(np.arange(len(df))[~T])
    u_all = _uplift_predict(m1f, df[feats], cfg["kind"]) - _uplift_predict(m0f, df[feats], cfg["kind"])
    thr = float(np.quantile(u_all, 0.7))
    pers = u_all >= thr
    profile = _profile(df, pers, feats)
    job.stage("explain", "done", "persuadable: " + "; ".join(p["text"] for p in profile[:2]))
    warnings = []
    if imbalanced:
        warnings.append("The two groups differed before the offer (" + ", ".join(f"{b['feature']}" for b in imbalanced[:4]) +
                        "), so it probably wasn't given at random - part of the difference may be who got it rather than what it did.")
    if obs_top and obs_rest and obs_top["diff"] <= obs_rest["diff"]:
        warnings.append("On held-out rows, the people predicted to respond most did not respond more than the rest - the model can't tell who it moves.")
    pct = cfg["kind"] == "binary"
    unit = (lambda v: f"{v * 100:+.1f} pts" if v is not None else "—") if pct else (lambda v: f"{v:+,.2f}" if v is not None else "—")
    m.model_artifact = _dump({"type": "uplift", "treated": m1f, "control": m0f, "threshold": thr, "kind": cfg["kind"]})
    m.feature_columns, m.excluded_columns, m.algorithm, m.task_type = feats, excluded, "studio_uplift_t_learner", "uplift"
    m.trained_row_count = int(len(df))
    m.metrics = {"effect": overall["diff"], "effect_lo": overall["lo"], "effect_hi": overall["hi"],
                 "top30_observed": obs_top["diff"] if obs_top else None, "rest_observed": obs_rest["diff"] if obs_rest else None}
    m.results = _base_results("uplift", df, capped, joined, warnings, treatment=cfg["treatment"], treated=cfg["treated"], control=cfg["control"],
                              target=cfg["target"], outcome=cfg["kind"], positive=cfg["positive"], effect=overall, top30=obs_top, rest=obs_rest,
                              deciles=dec_rows, balance=balance[:12], persuadable_profile=profile, threshold=thr, features=feats, excluded=excluded,
                              treated_rows=int(T.sum()), control_rows=int((~T).sum()))
    sig = overall["lo"] > 0 or overall["hi"] < 0
    m.results.update(
        headline=(f"Overall, {cfg['treatment']} = {cfg['treated']} changed {cfg['target']} by {unit(overall['diff'])} "
                  f"(95% range {unit(overall['lo'])} to {unit(overall['hi'])}{'' if sig else ' - could be no effect'}). "
                  + (f"The 30% predicted to respond most showed {unit(obs_top['diff'])} on held-out rows, vs {unit(obs_rest['diff'])} for the rest."
                     if obs_top and obs_rest else "")),
        kpis=[_m.kpi("Overall effect", overall["diff"], display=unit(overall["diff"]), note=f"95% range {unit(overall['lo'])} to {unit(overall['hi'])}"),
              _m.kpi("Effect in the top 30%", obs_top["diff"] if obs_top else None, display=unit(obs_top["diff"] if obs_top else None), note="held-out rows"),
              _m.kpi("Effect in the other 70%", obs_rest["diff"] if obs_rest else None, display=unit(obs_rest["diff"] if obs_rest else None), note="held-out rows"),
              _m.kpi("Treated / control", int(T.sum()), "integer", display=f"{int(T.sum()):,} / {int((~T).sum()):,}")],
        sections=[
            _m.sec_bars("Real difference between groups, by predicted response (held-out rows)", bars, "percent" if pct else "number",
                        note="Rows ranked by predicted uplift, highest first; each bar is the actual treated − control difference in that tenth."),
            _m.sec_table("Who the offer moves most (top 30%)", [_m.column("text", "Compared with everyone")], [{"text": p["text"]} for p in profile]),
            _m.sec_table("Were the groups alike before the offer?", [_m.column("feature", "Column"), _m.column("kind", "Measure"),
                                                                     _m.column("difference", "Difference", "number")], balance[:12],
                         note="Standardised mean differences above 0.2 (or share gaps above 15 points) suggest the offer wasn't given at random."),
        ])


# -------- price sensitivity

def _resolve_price(df, spec):
    i = _pick(df, spec, "item_column", "the product column", _NAMES["item_column"], lambda s: not _dateish(s) and not _numeric(s) and s.nunique() > 1)
    p = _pick(df, spec, "price_column", "the price column", _NAMES["price_column"], _numeric, exclude={i})
    u = _pick(df, spec, "units_column", "the units sold column", _NAMES["units_column"], _numeric, exclude={i, p})
    for c in (p, u):
        if not _numeric(df[c]):
            raise StudioError(f"{c} isn't a number.")
    t = spec.get("time_column")
    if t and t not in df.columns:
        raise StudioError(f"There is no column called {t} in this data.")
    return {"item": i, "price": p, "units": u, "time": t}


def _plan_price(df, spec, data_v, data_note, n):
    cfg = _resolve_price(df, spec)
    rows = _plan_rows((f"For each {cfg['item']}: how much {cfg['units']} changes when {cfg['price']} changes (elasticity), with a 95% range",
                       "−1.5 means a 10% price rise loses about 15% of units"),
                      data_v, data_note,
                      ("A log-log regression per product" + (f", with month effects from {cfg['time']}" if cfg["time"] else ""),
                       "products need 8+ different prices; the rest are listed separately"),
                      ("The 95% range shows how sure each estimate is; a range crossing 0 means no clear effect", "observational - promotions and stock-outs can blur it"),
                      ("A table per product and price_elasticity per row when you score", ""))
    return rows, {"title": f"How {cfg['units']} responds to {cfg['price']}, by {cfg['item']}"}


def _train_price(db, job, user, spec):
    m = job.m
    df, entry, capped, joined = _load_for_job(db, job, user, spec, spec.get("time_column"))
    job.stage("series", "running")
    cfg = _resolve_price(df, spec)
    work = pd.DataFrame({"i": df[cfg["item"]].astype(str).where(df[cfg["item"]].notna()), "p": pd.to_numeric(df[cfg["price"]], errors="coerce"),
                         "u": pd.to_numeric(df[cfg["units"]], errors="coerce")})
    if cfg["time"]:
        tt = _m.to_time(df[cfg["time"]])
        work["w"] = tt.dt.to_period("W-SUN").dt.start_time
        work["month"] = tt.dt.month
        work = work.dropna(subset=["i", "p", "u", "w"])
        work = work.groupby(["i", "w", "p"], as_index=False).agg(u=("u", "sum"), month=("month", "first"))
    work = work.dropna(subset=["i", "p", "u"])
    work = work[(work["p"] > 0) & (work["u"] > 0)]
    counts = work["i"].value_counts()
    items = list(counts.index[:200])
    job.stage("series", "done", f"{len(items)} products · {len(work):,} price points")
    job.stage("train", "running")
    out, thin = [], []
    for k, it in enumerate(items):
        g = work[work["i"] == it]
        nprices = int(g["p"].round(4).nunique())
        if nprices < 8 or len(g) < 12:
            thin.append({"item": it, "rows": int(len(g)), "distinct_prices": nprices,
                         "why": "fewer than 8 different prices" if nprices < 8 else "fewer than 12 observations"})
            continue
        try:
            r = _m.elasticity(g["p"].values, g["u"].values, g["month"].values.astype(float) if "month" in g else None)
        except _m.MethodError:
            thin.append({"item": it, "rows": int(len(g)), "distinct_prices": nprices, "why": "too few observations"})
            continue
        clear = r["hi"] < 0 or r["lo"] > 0
        e = r["elasticity"]
        out.append({"item": it, "rows": r["rows"], "distinct_prices": r["distinct_prices"], "elasticity": e, "lo": r["lo"], "hi": r["hi"],
                    "r2": r["r2"], "seasonal": r["seasonal"],
                    "reading": (f"10% higher price → about {abs(e) * 10:.0f}% {'fewer' if e < 0 else 'more'} units" if clear
                                else "no clear effect (the range includes 0)")})
        if k % 20 == 0:
            job.save(message=f"Product {k + 1} of {len(items)}")
    if not out:
        raise StudioError(f"No {cfg['item']} has 8 or more different prices with units sold, so price sensitivity can't be measured. "
                          "It needs price changes over time (or across stores) for the same product.")
    out.sort(key=lambda r: r["elasticity"])
    job.stage("train", "done", f"{len(out)} products measured · {len(thin)} with too little price variation")
    job.stage("explain", "running")
    med = float(np.median([r["elasticity"] for r in out]))
    clear = [r for r in out if r["hi"] < 0 or r["lo"] > 0]
    job.stage("explain", "done", f"median elasticity {med:.2f}")
    m.model_artifact = _dump({"type": "elasticity", "item": cfg["item"], "by_item": {r["item"]: r["elasticity"] for r in out}})
    m.feature_columns, m.excluded_columns, m.algorithm, m.task_type = [cfg["item"], cfg["price"], cfg["units"]], [], "studio_loglog_elasticity", "elasticity"
    m.trained_row_count = int(len(work))
    m.metrics = {"products": len(out), "median_elasticity": med}
    warnings = ["Elasticities come from how sales moved with price in the past; promotions, stock-outs or competitors changing at the same time can blur them."]
    m.results = _base_results("price", df, capped, joined, warnings, item=cfg["item"], price=cfg["price"], units=cfg["units"], products=out,
                              too_little_variation=thin, median_elasticity=med)
    most = out[0]
    m.results.update(
        headline=(f"Across {len(out)} products the typical elasticity is {med:.2f}: a 10% price rise loses about {abs(med) * 10:.0f}% of units. "
                  f"Most sensitive: {most['item']} ({most['elasticity']:.2f})."),
        kpis=[_m.kpi("Products measured", len(out), "integer", note=f"{len(thin)} with too little price variation"),
              _m.kpi("Median elasticity", med, display=f"{med:.2f}"),
              _m.kpi("Most sensitive", most["elasticity"], display=f"{most['elasticity']:.2f}", note=most["item"]),
              _m.kpi("With a clear effect", len(clear) / len(out), "percent", note="95% range excludes 0")],
        sections=[
            _m.sec_table("Price sensitivity by product", [_m.column("item", cfg["item"]), _m.column("elasticity", "Elasticity", "number"),
                                                          _m.column("lo", "95% low", "number"), _m.column("hi", "95% high", "number"),
                                                          _m.column("reading", "What it means"), _m.column("rows", "Observations", "integer"),
                                                          _m.column("distinct_prices", "Different prices", "integer")], out),
            _m.sec_bars("Elasticity (more negative = more sensitive)", [_m.bar(r["item"], r["elasticity"], tone="down" if r["elasticity"] < 0 else "up",
                                                                                display=f"{r['elasticity']:.2f}") for r in out[:20]], "number"),
        ] + ([_m.sec_table("Not enough price variation", [_m.column("item", cfg["item"]), _m.column("rows", "Observations", "integer"),
                                                           _m.column("distinct_prices", "Different prices", "integer"), _m.column("why", "Why")], thin[:100])] if thin else []))


# -------- attribution

def _resolve_attr(df, spec):
    e = _pick(df, spec, "entity_column", "the person column (user or customer)", _NAMES["entity_column"], lambda s: not _dateish(s) and s.nunique() > 1)
    c = _pick(df, spec, "channel_column", "the channel column", _NAMES["channel_column"], lambda s: _texty(s) and 1 < s.nunique() <= 200, exclude={e})
    t = _pick(df, spec, "time_column", "the date and time column", r"date|time|ts|timestamp|created|at$", _dateish, exclude={e, c})
    conv_col, ev_col, cv = spec.get("conversion_column"), spec.get("event_column"), spec.get("conversion_value")
    if ev_col and cv is not None:
        if ev_col not in df.columns:
            raise StudioError(f"There is no column called {ev_col} in this data.")
        conv = (df[ev_col].astype(str).str.strip().str.lower() == str(cv).strip().lower()).astype(int)
        how = f"{ev_col} = {cv}"
        include_touch = False
    else:
        conv_col = _pick(df, spec, "conversion_column", "the column marking conversions (1 on rows where a sale happened) - or an event column and the value that means a sale",
                         _NAMES["conversion_column"], lambda s: s.nunique() <= 3, exclude={e, c, t})
        try:
            conv = _m.flags(df[conv_col], conv_col)
        except _m.MethodError as x:
            raise StudioError(str(x)) from x
        how = f"{conv_col} = 1"
        include_touch = True
    if conv.sum() < 20:
        raise StudioError(f"Only {int(conv.sum())} conversions ({how}) - at least 20 are needed to share out credit.")
    v = spec.get("value_column")
    if v and (v not in df.columns or not _numeric(df[v])):
        raise StudioError(f"{v} isn't a number column in this data.")
    return {"entity": e, "channel": c, "time": t, "conv": conv, "how": how, "value": v, "include_touch": include_touch}


def _plan_attr(df, spec, data_v, data_note, n):
    cfg = _resolve_attr(df, spec)
    rows = _plan_rows((f"How many conversions{' and how much ' + cfg['value'] if cfg['value'] else ''} each {cfg['channel']} deserves credit for",
                       f"{int(cfg['conv'].sum()):,} conversions ({cfg['how']})"),
                      data_v, data_note,
                      ("Five ways side by side: first touch, last touch, linear, position-based (40/20/40) and a data-driven Markov chain (what is lost when a channel is removed)",
                       f"journeys per {cfg['entity']}, cut at each conversion"),
                      ("The Markov model also learns from journeys that didn't convert", "no single right answer - the models are compared"),
                      ("A channel × model table of credited conversions", ""))
    return rows, {"title": f"Which {cfg['channel']} deserves credit for conversions"}


def _train_attr(db, job, user, spec):
    m = job.m
    df, entry, capped, joined = _load_for_job(db, job, user, spec, spec.get("time_column"))
    job.stage("journeys", "running")
    cfg = _resolve_attr(df, spec)
    j = _m.journeys(df[cfg["entity"]], df[cfg["time"]], df[cfg["channel"]], cfg["conv"], df[cfg["value"]] if cfg["value"] else None,
                    include_converting_touch=cfg["include_touch"])
    if len(j["converting"]) < 20:
        raise StudioError(f"Only {len(j['converting'])} conversions have at least one channel touch before them - at least 20 are needed.")
    job.stage("journeys", "done", f"{len(j['converting']):,} converting · {len(j['non_converting']):,} not converting")
    job.stage("train", "running")
    res = _m.attribution(j["converting"], j["non_converting"])
    job.stage("train", "done", "5 models")
    job.stage("explain", "running")
    models_ = [("first_touch", "First touch"), ("last_touch", "Last touch"), ("linear", "Linear"), ("position", "Position 40/20/40"), ("markov", "Markov (data-driven)")]
    tot = res["conversions"] or 1
    table = []
    for ch in res["channels"]:
        row = {"channel": ch}
        for k, _lbl in models_:
            row[k] = res["credit"][k].get(ch, 0.0) / tot
        if cfg["value"]:
            row["markov_value"] = res["value"]["markov"].get(ch, 0.0)
        table.append(row)
    table.sort(key=lambda r: -r["markov"])
    top = table[0]
    last = max(table, key=lambda r: r["last_touch"])
    job.stage("explain", "done", f"most credit (Markov): {top['channel']}")
    m.model_artifact = None
    m.feature_columns, m.excluded_columns, m.algorithm, m.task_type = [cfg["entity"], cfg["channel"], cfg["time"]], [], "studio_attribution_markov", "attribution"
    m.trained_row_count = int(len(df))
    m.metrics = {"conversions": res["conversions"], "journeys": res["journeys"]}
    m.results = _base_results("attribution", df, capped, joined, [], entity=cfg["entity"], channel=cfg["channel"], conversion=cfg["how"],
                              conversions=res["conversions"], journeys=res["journeys"], avg_touches=res["avg_touches"], total_value=res["total_value"] if cfg["value"] else None,
                              credit={k: {c: v for c, v in res["credit"][k].items()} for k, _ in models_}, table=table)
    cols = [_m.column("channel", cfg["channel"])] + [_m.column(k, lbl, "percent") for k, lbl in models_]
    if cfg["value"]:
        cols.append(_m.column("markov_value", f"{cfg['value']} (Markov)", "number"))
    m.results.update(
        headline=(f"The data-driven (Markov) model gives {top['channel']} the most credit ({top['markov'] * 100:.0f}% of conversions); "
                  f"last-touch would give {last['channel']} {last['last_touch'] * 100:.0f}%."),
        kpis=[_m.kpi("Conversions", res["conversions"], "integer"), _m.kpi("Journeys", res["journeys"], "integer", note="including ones that didn't convert"),
              _m.kpi("Touches per conversion", res["avg_touches"], display=f"{res['avg_touches']:.1f}" if res["avg_touches"] else "—"),
              _m.kpi("Most credit (Markov)", top["markov"], "percent", note=top["channel"])],
        sections=[
            _m.sec_table("Share of conversions credited to each channel", cols, table,
                         note="First/last touch: all credit to one touch. Linear: equal shares. Position: 40% first, 40% last, 20% between. "
                              "Markov: how many conversions would be lost without the channel."),
            _m.sec_bars("Data-driven credit (Markov)", [_m.bar(r["channel"], r["markov"], "percent") for r in table], "percent"),
        ])


# -------- language: shared

TAGGER_PROPOSE = """GD360 TEXT TAGGER
Read the texts and propose up to 8 short tags (1-3 words each) that sort them usefully for the person's goal.
Reply with JSON only: {"tags": ["...", "..."]}"""

TAGGER_LABEL = """GD360 TEXT TAGGER
Label each numbered text with exactly one tag from this list: TAGS.
Reply with JSON only: {"labels": [{"i": 0, "tag": "..."}, ...]} - one entry per text."""


def _llm_labels(llm: _LLM, texts: list[str], tags: list[str], note: str = "") -> list[str | None]:
    out: list[str | None] = [None] * len(texts)
    low = {t.lower(): t for t in tags}
    for s in range(0, len(texts), 40):
        chunk = texts[s:s + 40]
        body = (note + "\n" if note else "") + "\n".join(f"[{k}] {str(t)[:300].replace(chr(10), ' ')}" for k, t in enumerate(chunk))
        got = llm.ask(TAGGER_LABEL.replace("TAGS", json.dumps(tags)), body, max_tokens=2500)
        if not got:
            break
        for k, item in enumerate(got.get("labels") or []):
            if isinstance(item, dict):
                i, tag = item.get("i", k), item.get("tag")
            else:
                i, tag = k, item
            try:
                i = int(i)
            except (TypeError, ValueError):
                continue
            if 0 <= i < len(chunk) and isinstance(tag, str) and tag.strip().lower() in low:
                out[s + i] = low[tag.strip().lower()]
    return out


def _text_rows(most: int) -> int:
    """How many texts a word model may learn from right now: up to `most`,
    fewer when the server is short of free memory (about 60 texts per MB is
    a safe bound even for text where almost every word pair is new)."""
    head = memory_headroom_mb()
    if head is None:
        return most
    return int(min(most, max(2000, (head - 80) * 60)))


def _text_model(texts: list[str], labels: list[str], n_rows: int):
    vec = _m.tfidf(min_df=2 if n_rows > 200 else 1)
    pipe = Pipeline([("tfidf", vec), ("clf", LogisticRegression(C=4.0, max_iter=2000, class_weight="balanced"))]).fit(texts, labels)
    _m.slim(vec)
    return pipe


def _fit_and_test_text(texts: pd.Series, labels: pd.Series) -> dict:
    """Train/test split, scores, per-class table and top words; then a refit on every labelled row."""
    from sklearn.metrics import precision_recall_fscore_support
    vc = labels.value_counts()
    rare = [c for c, k in vc.items() if k < 3]
    keep = ~labels.isin(rare)
    texts, labels = texts[keep], labels[keep]
    sampled = None
    cap = _text_rows(10_000)
    if len(labels) > cap:  # bounded memory for the word vocabulary on a 512 MB server
        pick = labels.sample(n=cap, random_state=0).index
        sampled = (cap, int(len(labels)))
        texts, labels = texts.loc[pick], labels.loc[pick]
    if labels.nunique() < 2:
        raise StudioError("At least two tags with 3 or more examples each are needed to learn from.")
    strat = labels if labels.value_counts().min() >= 2 else None
    tr, te = train_test_split(np.arange(len(labels)), test_size=0.2, random_state=0, stratify=strat)
    pipe = _text_model(texts.iloc[tr].tolist(), labels.iloc[tr].tolist(), len(tr))
    pred = pipe.predict(texts.iloc[te].tolist())
    yt = labels.iloc[te].values
    acc = float(accuracy_score(yt, pred))
    f1 = float(f1_score(yt, pred, average="macro"))
    base = float((yt == labels.iloc[tr].value_counts().idxmax()).mean())
    classes = list(labels.value_counts().index)
    p, rc, f, sup = precision_recall_fscore_support(yt, pred, labels=classes, zero_division=0)
    per = [{"category": c, "rows": int(s), "precision": float(a), "recall": float(b), "f1": float(x)} for c, a, b, x, s in zip(classes, p, rc, f, sup)]
    final = _text_model(texts.tolist(), labels.tolist(), len(labels))
    words = []
    clf, vec = final.named_steps["clf"], final.named_steps["tfidf"]
    terms = np.asarray(vec.get_feature_names_out())
    coefs = clf.coef_ if clf.coef_.shape[0] > 1 else np.vstack([-clf.coef_[0], clf.coef_[0]])
    for k, c in enumerate(clf.classes_):
        words.append({"category": str(c), "words": ", ".join(terms[np.argsort(-coefs[k])[:8]])})
    return {"pipe": final, "accuracy": acc, "f1": f1, "baseline": base, "per_class": per, "words": words, "rare": rare,
            "train_rows": int(len(tr)), "test_rows": int(len(te)), "sampled": sampled}


def _tag_all(pipe, texts: pd.Series) -> tuple[np.ndarray, np.ndarray]:
    proba = _m.transform_chunks(pipe.predict_proba, texts.fillna("").tolist())
    classes = np.asarray(pipe.classes_)
    return classes[proba.argmax(axis=1)], proba.max(axis=1)


def _by_month(dates: pd.Series | None, tags: pd.Series, title: str, order: list[str]) -> dict | None:
    if dates is None:
        return None
    t = _m.to_time(dates)
    if t.notna().mean() < 0.8:
        return None
    mon = t.dt.to_period("M").astype(str)
    tab = pd.crosstab(mon, tags, normalize="index").sort_index()
    if len(tab) < 2:
        return None
    tab = tab.tail(24)
    return _m.sec_line(title, list(tab.index), [{"name": str(c), "values": [float(v) for v in tab[c].values]} for c in order if c in tab.columns], "percent")


def _examples(texts: pd.Series, tags: pd.Series, conf: np.ndarray | None, order: list[str], k: int = 3) -> list[dict]:
    out = []
    for c in order:
        idx = np.nonzero((tags == c).values)[0]
        if conf is not None and len(idx):
            idx = idx[np.argsort(-conf[idx])]
        for i in idx[:k]:
            out.append({"tag": c, "text": str(texts.iloc[i])[:240]})
    return out


def _share_bars(tags: pd.Series, title: str) -> tuple[dict, list[str]]:
    vc = tags.value_counts(normalize=True)
    cnt = tags.value_counts()
    return _m.sec_bars(title, [_m.bar(k, float(v), "percent", note=f"{int(cnt[k]):,} rows") for k, v in vc.items()], "percent"), list(vc.index)


# -------- themes

THEME_NAMER = """GD360 THEME NAMER
Each theme below is a list of words that appear together in customers' text, with example texts.
Give each theme a short, plain name (2-4 words). Reply with JSON only: {"names": ["...", "..."]} in the same order."""


def _themes_core(job: Job, texts: pd.Series, k: int | None, llm: _LLM | None) -> dict:
    curve = []

    def on_trial(kk, coh, err):
        curve.append({"trial": len(curve) + 1, "best": max([c["score"] for c in curve] + [coh]), "score": coh, "algorithm": f"{kk} themes"})
        job.save(curve=_m.clean(curve), trials_done=len(curve), message=f"Tried {kk} themes")

    k_min, k_max = (int(k), int(k)) if k else (4, 10)
    try:
        res = _m.nmf_themes(texts.tolist(), k_min, k_max, on_trial=on_trial, max_fit=_text_rows(8000))
    except _m.MethodError as e:
        raise StudioError(str(e)) from e
    W = res["W"]
    theme = W.argmax(axis=1)
    weight = W.max(axis=1) / np.maximum(W.sum(axis=1), 1e-12)
    names = [" · ".join(t[:3]) for t in res["top_terms"]]
    named_by = "top words"
    if llm is not None:
        ex = []
        for j in range(res["k"]):
            idx = np.argsort(-W[:, j])[:3]
            ex.append({"words": res["top_terms"][j], "examples": [str(texts.iloc[i])[:160] for i in idx]})
        got = llm.ask(THEME_NAMER, json.dumps(ex, ensure_ascii=False), max_tokens=800)
        if got and isinstance(got.get("names"), list) and len(got["names"]) == res["k"] and all(isinstance(x, str) and x.strip() for x in got["names"]):
            names = [x.strip()[:60] for x in got["names"]]
            named_by = "AI"
    seen: dict[str, int] = {}
    for j, nme in enumerate(names):
        if nme in seen:
            names[j] = f"{nme} ({j + 1})"
        seen[nme] = j
    labels = np.where(W.sum(axis=1) > 0, np.asarray(names, dtype=object)[theme], "no clear theme")
    board = [{"algorithm": f"{b['k']} themes", "key": f"k{b['k']}", "score": b["coherence"], "second": b["error"], "trials": 1, "state": "done",
              "best": b["k"] == res["k"]} for b in res["board"]]
    return {"k": res["k"], "names": names, "named_by": named_by, "labels": pd.Series(labels, index=texts.index), "weight": weight,
            "top_terms": res["top_terms"], "board": board, "vectorizer": res["vectorizer"], "model": res["model"], "W": W}


def _resolve_text(df, spec, need_time=False):
    col = _text_column(df, spec)
    t = spec.get("time_column")
    if t and t not in df.columns:
        raise StudioError(f"There is no column called {t} in this data.")
    if not t:
        t = next((c for c in df.columns if c != col and _dateish(df[c])), None)
    texts = _texts(df, col)
    n = int(texts.notna().sum())
    if n < 30:
        raise StudioError(f"Only {n} rows have text in {col} - at least 30 are needed.")
    return {"text": col, "time": t, "rows": n}


def _plan_themes(df, spec, data_v, data_note, n):
    cfg = _resolve_text(df, spec)
    rows = _plan_rows((f"The topics people raise most in {cfg['text']}" + (", and how they move by month" if cfg["time"] else ""), f"{cfg['rows']:,} texts"),
                      data_v, data_note,
                      ("Word weights (TF-IDF) split into themes with NMF; 4–10 themes, the number chosen by how well each theme's words occur together",
                       "names from the AI when available, else each theme's top words"),
                      ("Each theme is shown with its words and example texts so it can be checked", "unsupervised - there is no right answer to score against"),
                      ("Share per theme" + (", by month" if cfg["time"] else "") + ", and theme + theme_weight per row when you score", ""))
    return rows, {"title": f"Themes in {cfg['text']}"}


def _train_themes(db, job, user, spec):
    m = job.m
    df, entry, capped, joined = _load_for_job(db, job, user, spec, spec.get("time_column"))
    job.stage("features", "running")
    cfg = _resolve_text(df, spec)
    texts = _texts(df, cfg["text"]).dropna()
    job.stage("features", "done", f"{len(texts):,} texts")
    job.stage("train", "running")
    th = _themes_core(job, texts, spec.get("k"), _LLM())
    job.save(leaderboard=_m.clean(th["board"]))
    job.stage("train", "done", f"{th['k']} themes")
    job.stage("explain", "running")
    labels = th["labels"]
    bars, order = _share_bars(labels, "Share of texts per theme")
    themes = []
    for j, nme in enumerate(th["names"]):
        idx = np.argsort(-th["W"][:, j])[:3]
        themes.append({"theme": nme, "share": float((labels == nme).mean()), "words": ", ".join(th["top_terms"][j][:8]),
                       "example": " | ".join(str(texts.iloc[i])[:140] for i in idx)})
    themes.sort(key=lambda r: -r["share"])
    sections = [bars, _m.sec_table("Each theme", [_m.column("theme", "Theme"), _m.column("share", "Share", "percent"), _m.column("words", "Its words"),
                                                  _m.column("example", "Examples")], themes)]
    line = _by_month(df.loc[texts.index, cfg["time"]] if cfg["time"] else None, labels, "Share of texts per theme, by month", order)
    if line:
        sections.append(line)
    job.stage("explain", "done", f"largest: {themes[0]['theme']}")
    m.model_artifact = _dump({"type": "nmf", "vectorizer": th["vectorizer"], "model": th["model"], "names": th["names"]})
    m.feature_columns, m.excluded_columns, m.algorithm, m.task_type = [cfg["text"]], [], "studio_tfidf_nmf", "text_topics"
    m.trained_row_count = int(len(texts))
    m.metrics = {"themes": th["k"]}
    m.results = _base_results("themes", df, capped, joined, [], text=cfg["text"], k=th["k"], themes=themes, named_by=th["named_by"])
    m.results.update(headline=f"{th['k']} themes in {cfg['text']}; the most common is “{themes[0]['theme']}” ({themes[0]['share'] * 100:.0f}% of texts).",
                     kpis=[_m.kpi("Texts", len(texts), "integer"), _m.kpi("Themes", th["k"], "integer", note="chosen by how well each theme's words occur together"),
                           _m.kpi("Largest theme", themes[0]["share"], "percent", note=themes[0]["theme"]),
                           _m.kpi("Named by", None, display="AI" if th["named_by"] == "AI" else "top words")],
                     sections=sections)


# -------- text tag

def _plan_tag(df, spec, data_v, data_note, n):
    cfg = _resolve_text(df, spec)
    lab = spec.get("label_column")
    if lab and lab not in df.columns:
        raise StudioError(f"There is no column called {lab} in this data.")
    if lab:
        nl = int(df[lab].notna().sum())
        how = (f"Learns from {nl:,} rows already tagged in {lab}", "TF-IDF words and word pairs + logistic regression")
        test = ("Held-out 20% of the tagged rows", "compared with always the most common tag")
    else:
        how = ("The AI suggests up to 8 tags (or uses yours) and tags a sample of up to 400 rows; a text model learns from that sample and tags every row",
               "without the AI: themes found in the words become the tags")
        test = ("Held-out 20% of the AI-tagged sample", "how often the model agrees with the AI")
    rows = _plan_rows((f"A tag for every row of {cfg['text']}, with a confidence", f"{cfg['rows']:,} texts"), data_v, data_note, how, test,
                      ("tag and tag_confidence per row when you score", ""))
    return rows, {"title": f"Tag {cfg['text']}"}


def _train_tag(db, job, user, spec):
    m = job.m
    df, entry, capped, joined = _load_for_job(db, job, user, spec, spec.get("time_column"))
    cfg = _resolve_text(df, spec)
    texts = _texts(df, cfg["text"])
    has = texts.notna()
    lab = spec.get("label_column")
    if lab and lab not in df.columns:
        raise StudioError(f"There is no column called {lab} in this data.")
    job.stage("labels", "running")
    warnings: list[str] = []
    source = "yours"
    if lab:
        y = df[lab].astype(str).where(df[lab].notna())
        sel = has & y.notna()
        if sel.sum() < 30:
            raise StudioError(f"Only {int(sel.sum())} rows have both text and a tag in {lab} - at least 30 are needed.")
        if y[sel].nunique() > 30:
            raise StudioError(f"{lab} has {y[sel].nunique()} different tags - up to 30 can be learnt.")
        tr_texts, tr_labels = texts[sel], y[sel]
        job.stage("labels", "done", f"{int(sel.sum()):,} tagged rows · {tr_labels.nunique()} tags")
    else:
        llm = _LLM()
        pool = texts[has]
        sample = pool.sample(n=min(400, len(pool)), random_state=0)
        tags = [str(t).strip() for t in (spec.get("tags") or []) if str(t).strip()][:12]
        if not tags:
            got = llm.ask(TAGGER_PROPOSE, f"Goal: {spec.get('goal') or 'sort these texts'}\n\n" +
                          "\n".join(f"- {str(t)[:200]}" for t in sample.head(60)), max_tokens=600)
            tags = [str(t).strip()[:40] for t in (got or {}).get("tags") or [] if str(t).strip()][:8]
        labels = _llm_labels(llm, sample.tolist(), tags, note=f"Goal: {spec.get('goal') or ''}") if tags and llm.ok else []
        got_n = sum(1 for x in labels if x)
        if not tags or got_n < max(30, int(0.6 * len(sample))):
            # no AI: themes become the tags
            job.stage("labels", "done", "the AI isn't available - themes found in the words become the tags")
            job.stage("train", "running")
            th = _themes_core(job, pool, None, None)
            job.stage("train", "done", f"{th['k']} themes as tags")
            job.stage("test", "running")
            job.stage("test", "done", "no labels to test against")
            job.stage("explain", "running")
            bars, order = _share_bars(th["labels"], "Share of rows per tag")
            m.model_artifact = _dump({"type": "nmf", "vectorizer": th["vectorizer"], "model": th["model"], "names": th["names"]})
            m.feature_columns, m.excluded_columns, m.algorithm, m.task_type = [cfg["text"]], [], "studio_tfidf_nmf", "text"
            m.trained_row_count = int(len(pool))
            m.metrics = {"tags": th["k"]}
            m.results = _base_results("text_tag", df, capped, joined,
                                      ["The AI wasn't available to suggest and apply tags, so the tags are themes found in the words themselves - rename them as you like."],
                                      text=cfg["text"], tags=th["names"], label_source="themes", shares={k: float(v) for k, v in th["labels"].value_counts(normalize=True).items()})
            m.results.update(headline=f"Tagged {len(pool):,} texts into {th['k']} groups found in the words (the AI wasn't available to name tags).",
                             kpis=[_m.kpi("Rows tagged", len(pool), "integer"), _m.kpi("Tags", th["k"], "integer"),
                                   _m.kpi("Largest tag", float(th["labels"].value_counts(normalize=True).iloc[0]), "percent", note=order[0])],
                             sections=[bars, _m.sec_table("Examples", [_m.column("tag", "Tag"), _m.column("text", "Text")],
                                                          _examples(pool, th["labels"], th["weight"], order))])
            job.stage("explain", "done", "")
            return
        lab_s = pd.Series(labels, index=sample.index)
        sel = lab_s.notna()
        tr_texts, tr_labels = sample[sel], lab_s[sel]
        source = "AI"
        job.stage("labels", "done", f"the AI tagged {int(sel.sum())} sample rows into {tr_labels.nunique()} tags")
    job.check_stop()
    job.stage("train", "running")
    fitres = _fit_and_test_text(tr_texts, tr_labels)
    job.stage("train", "done", f"{fitres['train_rows']:,} rows")
    job.stage("test", "running")
    job.save(leaderboard=_m.clean([{"algorithm": "Always the most common tag", "key": "baseline", "score": fitres["baseline"], "baseline": True, "trials": 1, "state": "done"},
                                   {"algorithm": "TF-IDF + logistic regression", "key": "tfidf_lr", "score": fitres["accuracy"], "second": fitres["f1"],
                                    "trials": 1, "state": "done", "best": True}]))
    job.stage("test", "done", f"{fitres['accuracy'] * 100:.1f}% {'right' if source == 'yours' else 'agreement with the AI'} on {fitres['test_rows']} held-out rows")
    job.stage("explain", "running")
    pred, conf = _tag_all(fitres["pipe"], texts[has])
    tags_s = pd.Series(pred, index=texts[has].index)
    bars, order = _share_bars(tags_s, "Share of rows per tag")
    if fitres["rare"]:
        warnings.append(f"Tags with fewer than 3 examples were left out: {', '.join(fitres['rare'][:8])}.")
    if fitres.get("sampled"):
        warnings.append(f"The text model learnt from a random {fitres['sampled'][0]:,} of the {fitres['sampled'][1]:,} tagged rows (server memory limit); every row is still tagged.")
    if source == "AI":
        warnings.append(f"The scores measure agreement with the AI's tags on a sample of {len(tr_labels)} rows, not with a person's judgement.")
    sections = [bars,
                _m.sec_table("How well each tag is recognised (held-out rows)", [_m.column("category", "Tag"), _m.column("rows", "Held-out rows", "integer"),
                                                                                   _m.column("precision", "Precision", "percent"), _m.column("recall", "Recall", "percent"),
                                                                                   _m.column("f1", "F1", "percent")], fitres["per_class"]),
                _m.sec_table("Words that point to each tag", [_m.column("category", "Tag"), _m.column("words", "Words")], fitres["words"]),
                _m.sec_table("Examples", [_m.column("tag", "Tag"), _m.column("text", "Text")], _examples(texts[has], tags_s, conf, order))]
    line = _by_month(df.loc[tags_s.index, cfg["time"]] if cfg["time"] else None, tags_s, "Share per tag, by month", order)
    if line:
        sections.append(line)
    job.stage("explain", "done", f"{len(tags_s):,} rows tagged")
    m.model_artifact = _dump({"type": "text_clf", "pipe": fitres["pipe"]})
    m.feature_columns, m.excluded_columns, m.algorithm, m.task_type = [cfg["text"]], [], "studio_tfidf_logreg", "text"
    m.trained_row_count = int(len(tr_labels))
    m.metrics = {"accuracy": fitres["accuracy"], "f1_macro": fitres["f1"]}
    m.results = _base_results("text_tag", df, capped, joined, warnings, text=cfg["text"], tags=order, label_source=source,
                              accuracy=fitres["accuracy"], f1_macro=fitres["f1"], baseline=fitres["baseline"], per_class=fitres["per_class"],
                              shares={k: float(v) for k, v in tags_s.value_counts(normalize=True).items()}, test_rows=fitres["test_rows"])
    m.results.update(headline=(f"Tagged {len(tags_s):,} rows into {len(order)} tags; on held-out rows the model "
                               f"{'matches your tags' if source == 'yours' else 'agrees with the AI'} {fitres['accuracy'] * 100:.0f}% of the time "
                               f"(always guessing the most common tag: {fitres['baseline'] * 100:.0f}%)."),
                     kpis=[_m.kpi("Accuracy (held-out)", fitres["accuracy"], "percent", note="vs your tags" if source == "yours" else "agreement with the AI's tags"),
                           _m.kpi("Macro F1", fitres["f1"], "percent"), _m.kpi("Most common tag", float(tags_s.value_counts(normalize=True).iloc[0]), "percent", note=order[0]),
                           _m.kpi("Rows tagged", len(tags_s), "integer")],
                     sections=sections)


# -------- sentiment

def _plan_sentiment(df, spec, data_v, data_note, n):
    cfg = _resolve_text(df, spec)
    rows = _plan_rows((f"Praise, question, complaint or neutral for every row of {cfg['text']}" + (", and the mix by month" if cfg["time"] else ""), f"{cfg['rows']:,} texts"),
                      data_v, data_note,
                      ("The AI reads a sample of up to 400 rows; a text model learns from it and tags every row", "without the AI: a built-in word list and question marks"),
                      ("Held-out 20% of the AI-read sample", "agreement with the AI (none when the word list is used)"),
                      ("sentiment and sentiment_confidence per row when you score", ""))
    return rows, {"title": f"Sentiment in {cfg['text']}"}


def _train_sentiment(db, job, user, spec):
    m = job.m
    df, entry, capped, joined = _load_for_job(db, job, user, spec, spec.get("time_column"))
    cfg = _resolve_text(df, spec)
    texts = _texts(df, cfg["text"])
    pool = texts.dropna()
    job.stage("labels", "running")
    llm = _LLM()
    sample = pool.sample(n=min(400, len(pool)), random_state=0)
    labels = _llm_labels(llm, sample.tolist(), _m.SENTIMENT_TAGS,
                         note="praise = positive about the product/service; complaint = negative; question = asks something; neutral = none of these")
    lab = pd.Series(labels, index=sample.index).dropna()
    fitres = None
    if len(lab) >= max(30, int(0.6 * len(sample))) and lab.nunique() >= 2:
        job.stage("labels", "done", f"the AI read {len(lab)} sample rows")
        job.stage("train", "running")
        fitres = _fit_and_test_text(sample.loc[lab.index], lab)
        pred, conf = _tag_all(fitres["pipe"], pool)
        tags_s = pd.Series(pred, index=pool.index)
        method = "AI sample + text model"
        job.stage("train", "done", f"{fitres['accuracy'] * 100:.0f}% agreement with the AI on held-out rows")
    else:
        job.stage("labels", "done", "the AI isn't available - using the built-in word list")
        job.stage("train", "running")
        tg, sc = _m.lexicon_sentiment(pool.tolist())
        tags_s = pd.Series(tg, index=pool.index)
        conf = None
        method = "built-in word list"
        job.stage("train", "done", "word list applied")
    job.stage("explain", "running")
    shares = tags_s.value_counts(normalize=True)
    order = [t for t in _m.SENTIMENT_TAGS if t in shares.index]
    bars = _m.sec_bars("Share of rows", [_m.bar(t, float(shares[t]), "percent", tone={"praise": "up", "complaint": "down"}.get(t, "neutral"),
                                                note=f"{int((tags_s == t).sum()):,} rows") for t in order], "percent")
    sections = [bars, _m.sec_table("Examples", [_m.column("tag", "Sentiment"), _m.column("text", "Text")], _examples(pool, tags_s, conf, order))]
    line = _by_month(df.loc[pool.index, cfg["time"]] if cfg["time"] else None, tags_s, "Share by month", order)
    if line:
        sections.append(line)
    warnings = []
    if fitres is None:
        warnings.append("The AI wasn't available, so a built-in word list was used: it catches clear praise and complaints but misses sarcasm and context, "
                        "and gives no confidence score.")
    else:
        warnings.append(f"The scores measure agreement with the AI on a sample of {len(lab)} rows, not with a person's judgement.")
    job.stage("explain", "done", "")
    m.model_artifact = _dump({"type": "text_clf", "pipe": fitres["pipe"]} if fitres else {"type": "lexicon"})
    m.feature_columns, m.excluded_columns, m.algorithm, m.task_type = [cfg["text"]], [], "studio_sentiment_" + ("tfidf_logreg" if fitres else "lexicon"), "text"
    m.trained_row_count = int(len(pool))
    m.metrics = {"accuracy": fitres["accuracy"] if fitres else None, **{f"share_{t}": float(shares.get(t, 0.0)) for t in _m.SENTIMENT_TAGS}}
    m.results = _base_results("sentiment", df, capped, joined, warnings, text=cfg["text"], method=method,
                              shares={t: float(shares.get(t, 0.0)) for t in _m.SENTIMENT_TAGS},
                              accuracy=fitres["accuracy"] if fitres else None, per_class=fitres["per_class"] if fitres else None)
    kp = [_m.kpi(t.capitalize(), float(shares.get(t, 0.0)), "percent", note=f"{int((tags_s == t).sum()):,} rows") for t in _m.SENTIMENT_TAGS]
    m.results.update(headline=(f"{shares.get('praise', 0) * 100:.0f}% praise, {shares.get('complaint', 0) * 100:.0f}% complaints and "
                               f"{shares.get('question', 0) * 100:.0f}% questions across {len(pool):,} texts ({method})."),
                     kpis=kp, sections=sections)


# -------- doc facts

FACT_EXTRACTOR = """GD360 FACT EXTRACTOR
Pull the requested fields out of each numbered document. Use only what the text says; if a field isn't there, use null.
Dates as YYYY-MM-DD, amounts as plain numbers (no currency symbol).
Reply with JSON only: {"rows": [{"i": 0, FIELDS}, ...]} - one entry per document."""

FIELD_PROPOSER = """GD360 FACT EXTRACTOR
Suggest the fields (snake_case names, at most 8) that should be pulled out of these documents for the person's goal.
Reply with JSON only: {"fields": ["...", "..."]}"""


def _resolve_facts(df, spec, llm: _LLM | None = None):
    cfg = _resolve_text(df, spec)
    fields = [re.sub(r"[^a-z0-9_]+", "_", str(f).strip().lower()).strip("_") for f in (spec.get("fields") or []) if str(f).strip()]
    how = spec.get("fields_how") or "your list"
    if not fields and llm is not None and spec.get("goal"):
        sample = _texts(df, cfg["text"]).dropna().head(5)
        got = llm.ask(FIELD_PROPOSER, f"Goal: {spec['goal']}\n\n" + "\n---\n".join(str(t)[:600] for t in sample), max_tokens=400)
        fields = [re.sub(r"[^a-z0-9_]+", "_", str(f).strip().lower()).strip("_") for f in (got or {}).get("fields") or [] if str(f).strip()][:8]
        how = "suggested by the AI"
    if not fields:
        fields, how = ["date", "amount", "party", "reference"], "the default list"
    return {**cfg, "fields": fields[:12], "fields_how": how}


def _plan_facts(df, spec, data_v, data_note, n):
    cfg = _resolve_facts(df, spec, _LLM())
    spec["fields"], spec["fields_how"] = cfg["fields"], cfg["fields_how"]  # training uses exactly the fields the plan showed
    norule = [f for f in cfg["fields"] if _m.field_kind(f) is None]
    rows = _plan_rows((f"{', '.join(cfg['fields'])} pulled out of each row of {cfg['text']} into a table", f"{cfg['rows']:,} documents · fields: {cfg['fields_how']}"),
                      data_v, data_note,
                      ("The AI reads up to 300 documents (20 at a time); built-in patterns cover dates, amounts, emails, reference numbers and parties",
                       ("no built-in pattern for " + ", ".join(norule) + " - those need the AI") if norule else "every field has a built-in pattern too"),
                      ("Completeness per field: the share of documents where it was found", "spot-check the table against the documents"),
                      ("A table of the fields and, when you score, the fields as new columns (built-in patterns)", ""))
    return rows, {"title": f"Pull {', '.join(cfg['fields'][:4])} out of {cfg['text']}", "fields": cfg["fields"]}


def _train_facts(db, job, user, spec):
    m = job.m
    df, entry, capped, joined = _load_for_job(db, job, user, spec)
    job.stage("fields", "running")
    llm = _LLM()
    cfg = _resolve_facts(df, spec, llm if not spec.get("fields") else None)
    fields = cfg["fields"]
    job.stage("fields", "done", ", ".join(fields) + f" ({cfg['fields_how']})")
    texts = _texts(df, cfg["text"]).dropna()
    job.stage("train", "running")
    head = texts.head(300)
    rows: list[dict] = []
    by = "built-in patterns"
    ai_rows = 0
    if llm.ok:
        fields_json = ", ".join(f'"{f}": ...' for f in fields)
        extracted: dict[int, dict] = {}
        for s in range(0, len(head), 20):
            chunk = head.iloc[s:s + 20]
            body = "\n\n".join(f"[{k}] {str(t)[:1500]}" for k, t in enumerate(chunk))
            got = llm.ask(FACT_EXTRACTOR.replace("FIELDS", fields_json), f"Fields: {', '.join(fields)}\n\n{body}", max_tokens=3000)
            if not got:
                break
            for k, item in enumerate(got.get("rows") or []):
                if not isinstance(item, dict):
                    continue
                try:
                    i = int(item.get("i", k))
                except (TypeError, ValueError):
                    continue
                if 0 <= i < len(chunk):
                    extracted[s + i] = {f: (item.get(f) if not isinstance(item.get(f), (dict, list)) else json.dumps(item.get(f))) for f in fields}
            job.save(message=f"Read {min(s + 20, len(head))} of {len(head)} documents")
            job.check_stop()
        if len(extracted) >= 0.6 * len(head):
            ai_rows = len(extracted)
            by = "the AI"
            for k in range(len(head)):
                rows.append({"row": int(head.index[k]) + 1, **(extracted.get(k) or _m.regex_facts(head.iloc[k], fields))})
    if not rows:
        rows = [{"row": int(i) + 1, **_m.regex_facts(t, fields)} for i, t in head.items()]
    job.stage("train", "done", f"{len(rows):,} documents read by {by}")
    job.stage("explain", "running")
    # completeness over every document by the built-in patterns, and over the AI-read ones when the AI was used
    rx_all = [_m.regex_facts(t, fields) for t in texts.head(5000)]
    comp = []
    for f in fields:
        shown = float(np.mean([r.get(f) not in (None, "") for r in rows])) if rows else 0.0
        allr = float(np.mean([r.get(f) not in (None, "") for r in rx_all])) if rx_all else 0.0
        comp.append({"field": f, "found": shown, "found_by_patterns": allr, "rule": _m.field_kind(f) or "none (needs the AI)"})
    warnings = []
    norule = [c["field"] for c in comp if c["rule"].startswith("none")]
    if norule and by != "the AI":
        warnings.append(f"Without the AI there is no pattern for {', '.join(norule)}, so {'it stays' if len(norule) == 1 else 'they stay'} empty.")
    if len(texts) > len(head):
        warnings.append(f"The table shows the first {len(head)} documents; scoring the table pulls the fields out of every row with the built-in patterns.")
    avg = float(np.mean([c["found"] for c in comp])) if comp else 0.0
    job.stage("explain", "done", f"{avg * 100:.0f}% of fields found")
    m.model_artifact = _dump({"type": "facts", "fields": fields})
    m.feature_columns, m.excluded_columns, m.algorithm, m.task_type = [cfg["text"]], [], "studio_fact_" + ("ai" if by == "the AI" else "patterns"), "extraction"
    m.trained_row_count = int(len(head))
    m.metrics = {"completeness": avg, "documents": int(len(texts))}
    m.results = _base_results("doc_facts", df, capped, joined, warnings, text=cfg["text"], fields=fields, fields_how=cfg["fields_how"], extracted_by=by,
                              ai_rows=ai_rows, completeness=comp, rows_extracted=rows)
    m.results.update(headline=f"Pulled {len(fields)} fields out of {len(rows):,} documents ({by}); on average {avg * 100:.0f}% of fields were found.",
                     kpis=[_m.kpi("Documents", len(texts), "integer"), _m.kpi("Fields", len(fields), "integer", note=cfg["fields_how"]),
                           _m.kpi("Fields found", avg, "percent", note=f"by {by}"), _m.kpi("Read by", None, display=by)],
                     sections=[_m.sec_bars("How often each field was found", [_m.bar(c["field"], c["found"], "percent", note=f"rule: {c['rule']}") for c in comp], "percent"),
                               _m.sec_table("Extracted", [_m.column("row", "Row", "integer")] + [_m.column(f, f, "number" if _m.field_kind(f) == "amount" else "text") for f in fields],
                                            rows[:300])])


# -------- dispatch

_PLANNERS = {"time_to_event": _plan_tte, "what_if": _plan_what_if, "marketing_mix": _plan_mmm, "bought_together": _plan_pairs,
             "cohorts": _plan_cohorts, "recommendations": _plan_recs, "uplift": _plan_uplift, "price": _plan_price, "attribution": _plan_attr,
             "text_tag": _plan_tag, "sentiment": _plan_sentiment, "themes": _plan_themes, "doc_facts": _plan_facts}
TRAINERS = {"time_to_event": _train_tte, "what_if": _train_what_if, "marketing_mix": _train_mmm, "bought_together": _train_pairs,
            "cohorts": _train_cohorts, "recommendations": _train_recs, "uplift": _train_uplift, "price": _train_price, "attribution": _train_attr,
            "text_tag": _train_tag, "sentiment": _train_sentiment, "themes": _train_themes, "doc_facts": _train_facts}


def _plan_new(ptype: str, df: pd.DataFrame, spec: dict, data_v: str, data_note: str, n: int) -> tuple[list[dict], dict]:
    try:
        rows, extra = _PLANNERS[ptype](df, spec, data_v, data_note, n)
    except _m.MethodError as e:
        raise StudioError(str(e)) from e
    extra = dict(extra)
    warn = extra.pop("warnings_extra", None)
    out = {**extra, "warnings_new": warn or []}
    return rows, out


# ---------------------------------------------------------- scoring ----

def _rejoin_for_scoring(m: models.MLModel, df: pd.DataFrame) -> pd.DataFrame:
    """2026-10-09 (round 15): a model that learnt from joined tables needs the
    same joined columns to score. They are rebuilt with the model owner's
    access and used only as the model's inputs - never added to the output."""
    spec = (m.plan or {}).get("spec") or {}
    db = SessionLocal()
    try:
        owner = db.get(models.User, m.owner_id)
        base = _coerce_numeric_strings(df.copy().reset_index(drop=True))
        out, *_ = apply_joins(db, owner, base, {"table": m.table_name or "table"}, spec.get("joins") or [])
        out.index = df.index
        return out
    except StudioError:
        raise
    except Exception as e:  # noqa: BLE001
        raise StudioError(f"This model learns from joined tables and the join couldn't be rebuilt to score: {str(e)[:200]}") from e
    finally:
        db.close()


def score_frame(m: models.MLModel, df: pd.DataFrame) -> pd.DataFrame:
    """Every row scored - with the top 3 reasons for supervised models.
    2026-10-09 (round 15): every newer kind either writes its own columns or
    says plainly why it scores periods / channels, not rows."""
    ptype = m.problem_type
    res = m.results or {}
    if m.task_type == "forecast":
        raise StudioError("A forecast predicts periods, not rows - its forecast table is on the results page.")
    if ptype in ("what_if", "marketing_mix"):
        raise StudioError("This model works on whole periods (weeks or months), not on rows - its scenario and charts are on the results page.")
    if ptype == "attribution":
        raise StudioError("Attribution shares credit between channels, not rows - the channel table is on the results page.")
    out = df.copy()
    if ptype == "cohorts":
        e, t = res.get("entity"), res.get("time")
        if e not in df.columns or t not in df.columns:
            raise StudioError(f"Scoring needs the {e} and {t} columns.")
        tt = _m.to_time(df[t])
        mon = tt.dt.year * 12 + tt.dt.month - 1
        first = mon.groupby(df[e].astype(str)).transform("min")
        out["cohort"] = [None if pd.isna(x) else _m._month_label(int(x)) for x in first]
        out["months_since_first"] = (mon - first).astype("Int64")
        return out
    if not m.model_artifact:
        raise StudioError("This model has nothing to score rows with - train it again.")
    art = joblib.load(io.BytesIO(m.model_artifact))
    if isinstance(art, dict):
        typ = art.get("type")
        if typ == "pairs":
            col = art["item"]
            if col not in df.columns:
                raise StudioError(f"Scoring needs the {col} column.")
            partners = art.get("partners") or {}
            got = [partners.get(str(v), []) if pd.notna(v) else [] for v in df[col]]
            for k in range(3):
                out[f"bought_with_{k + 1}"] = [g[k] if len(g) > k else None for g in got]
            return out
        if typ == "elasticity":
            col = art["item"]
            if col not in df.columns:
                raise StudioError(f"Scoring needs the {col} column.")
            out["price_elasticity"] = [art["by_item"].get(str(v)) if pd.notna(v) else None for v in df[col]]
            return out
        if typ == "recs":
            e, i = art["entity"], art["item"]
            if e not in df.columns or i not in df.columns:
                raise StudioError(f"Scoring needs the {e} and {i} columns.")
            items = art["items"]
            index = {it: k for k, it in enumerate(items)}
            d = pd.DataFrame({"u": df[e].astype(str).where(df[e].notna()), "i": df[i].astype(str).map(index)})
            d["w"] = pd.to_numeric(df[art["weight"]], errors="coerce").fillna(0).clip(lower=0) if art.get("weight") and art["weight"] in df.columns else 1.0
            d = d.dropna(subset=["u", "i"])
            u_codes, u_uni = pd.factorize(d["u"])
            from scipy import sparse as _sp
            X = _sp.csr_matrix((d["w"].astype(float).values, (u_codes, d["i"].astype(int).values)), shape=(len(u_uni), len(items)))
            X.sum_duplicates()
            X.data = np.log1p(X.data)
            recs = _m.recommend(X, art["sim"], n=5)
            by_user = {u: [items[x] for x in r] for u, r in zip(u_uni, recs)}
            got = [by_user.get(str(v), []) if pd.notna(v) else [] for v in df[e]]
            for k in range(5):
                out[f"recommendation_{k + 1}"] = [g[k] if len(g) > k else None for g in got]
            return out
        if typ in ("text_clf", "nmf", "lexicon", "facts"):
            col = (m.feature_columns or [None])[0]
            if col not in df.columns:
                raise StudioError(f"Scoring needs the {col} column.")
            texts = df[col].astype(str).where(df[col].notna(), "").str.slice(0, 1500)
            name = {"sentiment": "sentiment", "themes": "theme"}.get(ptype, "tag")
            if typ == "facts":
                fields = art["fields"]
                got = [_m.regex_facts(t, fields) for t in texts]
                for f in fields:
                    c = f if f not in df.columns else f"extracted_{f}"
                    out[c] = [g.get(f) for g in got]
                return out
            if typ == "lexicon":
                tags, _scores = _m.lexicon_sentiment(texts.tolist())
                out[name] = tags
                out[f"{name}_confidence"] = None
                return out
            if typ == "text_clf":
                lab, conf = _tag_all(art["pipe"], texts)
                out[name] = lab
                out[f"{name}_confidence"] = np.round(conf, 4)
                return out
            W = _m.transform_chunks(lambda part: art["model"].transform(art["vectorizer"].transform(part)), texts.tolist())
            names = np.asarray(art["names"], dtype=object)
            has = W.sum(axis=1) > 0
            out[name] = np.where(has, names[W.argmax(axis=1)], None)
            out[f"{name}_weight" if name == "theme" else f"{name}_confidence"] = np.round(np.where(has, W.max(axis=1) / np.maximum(W.sum(axis=1), 1e-12), 0.0), 4)
            return out
        if typ == "uplift":
            feats = m.feature_columns or []
            src = _rejoin_for_scoring(m, df) if ((m.plan or {}).get("spec") or {}).get("joins") and any(f not in df.columns for f in feats) else df
            X = _coerce_numeric_strings(src.copy()).reindex(columns=feats)
            u = _uplift_predict(art["treated"], X, art["kind"]) - _uplift_predict(art["control"], X, art["kind"])
            out["uplift_score"] = np.round(u, 4)
            out["persuadable"] = u >= art["threshold"]
            return out
        raise StudioError("This model can't score rows.")
    pipe = art
    feats = m.feature_columns or []
    src = df
    if ((m.plan or {}).get("spec") or {}).get("joins") and any(f not in df.columns for f in feats):
        src = _rejoin_for_scoring(m, df)
    X = _coerce_numeric_strings(src.copy()).reindex(columns=feats)
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
        if ptype == "time_to_event":
            out[f"chance_within_{res.get('horizon_days')}d"] = np.round(p, 4)
        else:
            out[f"chance_{target}_{res.get('positive')}"] = np.round(p, 4)
        base = p
    else:
        pred = pipe.predict(X)
        out[f"predicted_{target}"] = pred
        if ptype == "which_category":
            out[f"{target}_confidence"] = np.round(pipe.predict_proba(X).max(axis=1), 4)
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
