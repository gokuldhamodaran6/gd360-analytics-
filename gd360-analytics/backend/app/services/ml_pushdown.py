"""
In-database ML (2026-10-12, round 40): the model goes to the data.

A yes/no model (logistic regression) or a number model (linear regression)
is trained by SQL that runs where the rows live - BigQuery, Snowflake,
PostgreSQL / Supabase, MySQL, SQL Server, or GD360's DuckDB sandbox for files
and synced apps. Each pass is ONE aggregate SELECT whose answer is a few
hundred numbers (a weighted Gram matrix and a gradient); GD360 solves the
small system they describe and sends the next pass.

Round 41 (2026-10-13) - zero rows out, built for big tables:

  - scan: column types come from the catalog; ONE aggregate counts every
    column's filled and distinct values, so ids, constants and free text are
    found without reading a row (round 40 read a 2,000-row sample)
  - a fair test in time when the table has a date: train on the older 80%,
    test on the newest 20% - the cutoff from a histogram of the dates
  - profile: means, spreads, null shares and each column's correlation with
    the outcome over the training rows - one pass. The leak check runs on
    those sums (and, for categories, on per-value outcome rates)
  - levels: the most common values of every category with their outcome
    sums - one statement (GROUPING SETS; UNION ALL on MySQL)
  - features: numbers (standardised), dates as "days before" the newest one,
    missing-value flags, a curvature term for the strongest numbers,
    categories as one column per value - or, when wide, the smoothed
    outcome rate of each value
  - logistic regression by Newton / IRLS. On a big table it starts on a
    sample the engine draws itself (TABLESAMPLE), then needs 2-3 passes over
    every row; the last pass also grades the model on the held-out rows and
    proves the deployable SQL equals the trained model - all in one scan
  - a checkpoint after every pass: a stopped or failed run goes on from it
  - grading: ROC AUC, ROC and precision-recall curves, calibration, lift at
    1/5/10/20%, log loss - or R², MAE, RMSE - from a 1,000-bucket histogram
  - the model as ONE SQL expression (a SELECT, a view, a dbt model), proved
    against the model on the held-out rows inside the database and on made-up
    rows (never the customer's) in SQL and in Python
  - a cost estimate on the plan and a per-run scan limit
    (ML_SQL_MAX_GB_PER_RUN); passes get their own statement timeout

Not one row-level value leaves the database: every statement returns sums,
counts or a histogram. The run page meters it ("customer rows out: 0").
"""
from __future__ import annotations

import datetime as _dt
import hashlib
import json
import logging
import math
import re
import time
from dataclasses import dataclass, field
from typing import Callable

import numpy as np
import pandas as pd
from sklearn.base import BaseEstimator

logger = logging.getLogger(__name__)

SQL_KINDS = ("postgres", "supabase", "mysql", "sqlserver", "bigquery", "snowflake")
DIALECT_OF = {"postgres": "postgres", "supabase": "postgres", "mysql": "mysql", "sqlserver": "tsql", "bigquery": "bigquery",
              "snowflake": "snowflake", "duckdb": "duckdb"}
ENGINE_WORDS = {"postgres": "PostgreSQL", "supabase": "Supabase", "mysql": "MySQL", "sqlserver": "SQL Server", "bigquery": "BigQuery",
                "snowflake": "Snowflake", "duckdb": "GD360's DuckDB sandbox"}
SUPPORTED_TYPES = ("yes_no", "number")
HOLDOUT = 20            # % of rows held out for grading
MAX_NUMERIC = 24        # numbers and dates in the model
MAX_CATEGORIES = 8
MAX_LEVELS = 7          # one-hot columns per category (the most common value is the reference)
MAX_PARAMS = 48         # k(k+1)/2 sums stays under every engine's column limit (PostgreSQL: 1,664)
MAX_ITER = 12
ACCEPT = 1e-3           # a Newton step this small (in standard deviations): the model graded in that pass is kept
ACCEPT_STEP = 5e-3      # ... or, when the pass didn't grade, the step is taken - Newton is then within ~step² of the optimum
FUSE_AT = 0.03          # after a step this small, the next pass also grades and proves the SQL
FUSE_DIALECTS = ("bigquery", "snowflake", "duckdb")   # engines that bill or time by the scan and return columns compactly
Z_CLAMP = 30.0
BUCKETS = 1000
ONEHOT_MAX = 12         # a category with up to this many values: one column per value
WIDE_MAX = 5000         # up to this many: the smoothed outcome rate of each value; more: free text
RATE_LEVELS = 200       # values with their own rate (the rest share the overall rate)
RATE_M = 20.0           # smoothing: a value's rate counts as RATE_M rows at the overall rate
CURVE_TOP = 8           # numbers that also get a curvature term (the most related to the outcome)
CURVE_CLIP = 5.0
MISS_MIN = 0.01         # a missing-value flag when at least 1% of training rows are empty
LEAK_CORR = {"binary": 0.95, "number": 0.98}   # the sample route's bar for numbers is 0.98 too: a strong predictor isn't a leak
WARM_ROWS = 200_000     # training rows above which the run starts on an engine sample
WARM_TARGET = 100_000   # rows in that sample
MAX_SCAN_COLS = 200
NUM_CANDIDATES = 48
CAT_CANDIDATES = 16

_FLOAT = {"duckdb": "DOUBLE", "postgres": "DOUBLE PRECISION", "mysql": "DOUBLE", "tsql": "FLOAT", "bigquery": "FLOAT64", "snowflake": "DOUBLE"}
_TEXT = {"duckdb": "VARCHAR", "postgres": "TEXT", "mysql": "CHAR", "tsql": "NVARCHAR(4000)", "bigquery": "STRING", "snowflake": "VARCHAR"}
_INT = {"duckdb": "INTEGER", "postgres": "INTEGER", "mysql": "SIGNED", "tsql": "INT", "bigquery": "INT64", "snowflake": "INTEGER"}
_TS = {"duckdb": "TIMESTAMP", "postgres": "TIMESTAMP", "mysql": "DATETIME", "tsql": "DATETIME2", "bigquery": "TIMESTAMP", "snowflake": "TIMESTAMP_NTZ"}


class PushdownError(ValueError):
    """A plain sentence for the run page."""


class OverLimit(PushdownError):
    """The warehouse refused a pass before running it: over the scan limit."""


# ------------------------------------------------------------------ dialect

class Dialect:
    """The few places the six engines spell SQL differently."""

    def __init__(self, kind: str):
        self.d = DIALECT_OF.get(kind, kind)
        if self.d not in _FLOAT:
            raise PushdownError(f"{kind} can't run in-database training.")

    def ident(self, name: str) -> str:
        name = str(name)
        if self.d in ("mysql", "bigquery"):
            return "`" + name.replace("`", "``") + "`"
        if self.d == "tsql":
            return "[" + name.replace("]", "]]") + "]"
        return '"' + name.replace('"', '""') + '"'

    def path(self, key: str) -> str:
        """A table name that may carry a schema / dataset prefix."""
        parts = [p for p in str(key).split(".") if p]
        return ".".join(self.ident(p) for p in parts)

    def lit(self, v) -> str:
        s = str(v)
        if self.d == "bigquery":   # BigQuery escapes with a backslash only
            return "'" + s.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n") + "'"
        if self.d == "mysql":
            s = s.replace("\\", "\\\\")
        return "'" + s.replace("'", "''") + "'"

    @property
    def one(self) -> str:
        """1 and 0 as floating point: PostgreSQL would otherwise sum exact decimals, several times slower."""
        return f"CAST(1 AS {_FLOAT[self.d]})"

    @property
    def zero(self) -> str:
        return f"CAST(0 AS {_FLOAT[self.d]})"

    def num(self, e: str) -> str:
        return f"CAST({e} AS {_FLOAT[self.d]})"

    def txt(self, e: str) -> str:
        return f"CAST({e} AS {_TEXT[self.d]})"

    def ln(self, e: str) -> str:
        return f"LOG({e})" if self.d == "tsql" else f"LN({e})"

    def stddev(self, e: str) -> str:
        return f"STDEV({e})" if self.d == "tsql" else f"STDDEV_SAMP({e})"

    def to_int(self, e: str) -> str:
        return f"CAST({e} AS {_INT[self.d]})"

    def epoch_days(self, e: str) -> str:
        """A date or timestamp as days since 1970-01-01 (a float), the same in every engine."""
        return {"duckdb": f"(epoch_ms(CAST({e} AS TIMESTAMP)) / 86400000.0)",
                "postgres": f"(CAST(EXTRACT(EPOCH FROM CAST({e} AS TIMESTAMP)) AS DOUBLE PRECISION) / 86400.0)",
                "mysql": f"(TIMESTAMPDIFF(SECOND, '1970-01-01 00:00:00', {e}) / 86400.0)",
                "tsql": f"(CAST(DATEDIFF_BIG(SECOND, '19700101', {e}) AS FLOAT) / 86400.0)",
                "bigquery": f"(UNIX_SECONDS(CAST({e} AS TIMESTAMP)) / 86400)",
                "snowflake": f"(DATE_PART(EPOCH_SECOND, CAST({e} AS TIMESTAMP_NTZ)) / 86400.0)"}[self.d]

    def ts_lit(self, iso: str | None) -> str:
        if iso is None:
            return f"CAST(NULL AS {_TS[self.d]})"
        return f"CAST({self.lit(iso)} AS {_TS[self.d]})"

    def count_distinct(self, e: str) -> str:
        """Distinct values - approximate (within about 2%) where the engine
        offers it: the scan only needs to tell 3 values from 3 million."""
        if self.d == "bigquery":
            return f"APPROX_COUNT_DISTINCT(CAST({e} AS STRING))"
        if self.d == "snowflake":
            return f"APPROX_COUNT_DISTINCT({e})"
        return f"COUNT(DISTINCT {e})"   # DuckDB counts exactly about as fast

    def hash_mod(self, key_text: str, m: int) -> str:
        """0..m-1 from a stable hash of the key: the same rows on every run."""
        if self.d == "duckdb":
            return f"(hash({key_text}) % {m})"
        h = {"postgres": f"CAST(HASHTEXT({key_text}) AS BIGINT)", "mysql": f"CRC32({key_text})",
             "tsql": f"CAST(CHECKSUM({key_text}) AS BIGINT)", "bigquery": f"FARM_FINGERPRINT({key_text})",
             "snowflake": f"HASH({key_text})"}[self.d]
        if self.d == "tsql":
            return f"((({h}) % {m} + {m}) % {m})"
        return f"MOD(MOD({h}, {m}) + {m}, {m})"

    def hash100(self, key_text: str) -> str:
        return self.hash_mod(key_text, 100)

    def concat(self, parts: list[str]) -> str:
        if len(parts) == 1:
            return parts[0]
        return "CONCAT(" + ", ".join(parts) + ")"

    def fence(self) -> str:
        """PostgreSQL inlines subqueries and MySQL / MariaDB merge derived
        tables, so both would recompute a row's features once per SUM (a
        200-value CASE times 1,000 sums). OFFSET 0 - and on MySQL a LIMIT no
        table reaches - make them compute each row's features once."""
        if self.d == "postgres":
            return " OFFSET 0"
        if self.d == "mysql":
            return " LIMIT 18446744073709551615"
        return ""

    def top(self, n: int) -> str:
        return f"TOP {int(n)} " if self.d == "tsql" else ""

    def limit(self, n: int) -> str:
        return "" if self.d == "tsql" else f" LIMIT {int(n)}"

    def sample(self, rel: str, pct: float) -> str | None:
        """The table with the engine's own sampling (blocks or rows, drawn
        in the engine): None where there is none (MySQL) - a hash filter
        stands in."""
        p = f"{pct:.4g}"
        return {"bigquery": f"{rel} TABLESAMPLE SYSTEM ({p} PERCENT)",
                "postgres": f"{rel} TABLESAMPLE SYSTEM ({p}) REPEATABLE (42)",
                "duckdb": f"{rel} TABLESAMPLE {p}% (bernoulli, 42)",
                "snowflake": f"{rel} SAMPLE ({p})",
                "tsql": f"{rel} TABLESAMPLE ({p} PERCENT) REPEATABLE (42)"}.get(self.d)

    @property
    def grouping_sets(self) -> bool:
        return self.d != "mysql"


def _aliased(exprs: list[str]) -> str:
    """Every output column named (SQL Server can't wrap unnamed ones)."""
    return ", ".join(f"{e} AS a{i}" for i, e in enumerate(exprs))


def _f(x: float) -> str:
    """A float as an SQL literal every engine reads the same way."""
    x = float(x)
    if not math.isfinite(x):
        x = 0.0
    s = repr(x)
    return s if ("e" in s or "." in s) else s + ".0"


def _sigmoid_sql(z: str) -> str:
    return (f"1.0 / (1.0 + EXP(-(CASE WHEN {z} > {_f(Z_CLAMP)} THEN {_f(Z_CLAMP)} WHEN {z} < {_f(-Z_CLAMP)} "
            f"THEN {_f(-Z_CLAMP)} ELSE {z} END)))")


def _iso_day(days: float | None) -> str | None:
    if days is None or not math.isfinite(days):
        return None
    t = _dt.datetime(1970, 1, 1) + _dt.timedelta(days=float(days))
    return t.strftime("%Y-%m-%d %H:%M:%S")


def _nice_day(days: float | None) -> str:
    if days is None:
        return "—"
    t = _dt.datetime(1970, 1, 1) + _dt.timedelta(days=float(days))
    return f"{t.day} {t.strftime('%b %Y')}"


# ------------------------------------------------------------------ source

@dataclass
class Source:
    """Where the passes run: a dialect, the relation to read and a function
    that runs one SELECT and returns its rows."""
    kind: str                      # postgres / bigquery / ... / duckdb
    rel: str                       # FROM text: a table or a view
    filters: list[str]             # the person's access rules, as SQL
    query: Callable[[str], tuple[pd.DataFrame, int | None]]   # one SELECT -> (rows, bytes scanned)
    where_words: str               # "BigQuery", "GD360's DuckDB sandbox"
    table_label: str = ""
    hidden: set = field(default_factory=set)                # columns the person may not see
    types: dict = field(default_factory=dict)               # column -> the engine's type name (the catalog)
    limits: dict = field(default_factory=dict)              # this run's per-statement guards (read by `query`)

    @property
    def dialect(self) -> Dialect:
        return Dialect(self.kind)


def _source_rel(ds, key: str) -> str:
    d = Dialect(ds.kind)
    if ds.kind == "bigquery" and "." not in key:
        return d.path(f"{(ds.connection_info or {}).get('dataset_id')}.{key}")
    return d.path(key)


def warehouse_source(db, user, ds, key: str, columns: list[dict]) -> Source:
    """A live warehouse table, read in place under the person's access rules."""
    from ..config import get_settings
    from . import ml_data as md
    from . import warehouse_exec

    d = Dialect(ds.kind)
    rel = _source_rel(ds, key)
    hidden, rules = md.access_rules(db, ds, user)
    types = {c["name"]: str(c.get("type") or "").lower() for c in columns}
    filters = [_rule_sql(d, col, allowed, types.get(col, "")) for col, allowed in rules]
    sqlalchemy_kind = ds.kind in ("postgres", "supabase", "mysql", "sqlserver")
    limits: dict = {"timeout_seconds": int(get_settings().ML_SQL_STATEMENT_TIMEOUT_SECONDS)}

    def query(sql: str):
        if warehouse_exec.daily_budget_exhausted(db, ds, user.id):
            raise PushdownError("Today's scanned-data budget for this warehouse is used up - training can go on tomorrow (from its last step), "
                                "or after an admin raises it.")
        # SQLAlchemy's text() reads ":word" as a bound parameter, even inside a
        # quoted value ('10:30'); a backslash keeps the colon a colon
        out = warehouse_exec.execute_sql(db, ds, user.id, re.sub(r"(?<!\\):", r"\:", sql) if sqlalchemy_kind else sql, limits=dict(limits))
        if "df" not in out:
            att = out["attempt"]
            if att.get("status") == "rejected_too_expensive":
                raise OverLimit(att.get("error") or "Over the scan limit.")
            raise PushdownError(att.get("error") or "The warehouse rejected a training pass.")
        return out["df"], out.get("bytes_scanned")

    return Source(kind=ds.kind, rel=rel, filters=filters, query=query, where_words=ENGINE_WORDS.get(ds.kind, ds.kind), table_label=key,
                  hidden=set(hidden), types=types, limits=limits)


def duck_source(bench, view: str, label: str) -> Source:
    """A DuckDB view in the run's sandbox (files, synced apps, sheets): the
    access rules are already part of the view."""
    def query(sql: str):
        return bench.con.execute(sql).df(), None
    types = {c: str(t).lower() for c, t in bench.columns(view)}
    return Source(kind="duckdb", rel=f'"{view}"', filters=[], query=query, where_words=ENGINE_WORDS["duckdb"], table_label=label, types=types)


def _rule_sql(d: Dialect, col: str, allowed: list, typ: str) -> str:
    """A row rule with the pandas `isin` meaning; an empty list lets no row through."""
    if not allowed:
        return "1 = 0"
    c = d.ident(col)
    texts = [d.lit(v) for v in allowed if v is not None]
    parts = []
    if texts:
        parts.append(f"{d.txt(c)} IN ({', '.join(texts)})")
    if _is_numeric_type(typ):
        nums = []
        for v in allowed:
            try:
                if not isinstance(v, bool):
                    nums.append(_f(float(v)))
            except (TypeError, ValueError):
                pass
        if nums:
            parts.append(f"{d.num(c)} IN ({', '.join(nums)})")
    return "(" + " OR ".join(parts) + ")" if parts else "1 = 0"


_NUM_WORDS = ("int", "float", "double", "numeric", "decimal", "real", "number", "money", "serial")
_DATE_WORDS = ("date", "time", "timestamp", "interval")
_NESTED_WORDS = ("struct", "array", "record", "geography", "geometry", "json", "bytes", "blob", "binary", "variant", "object", "xml",
                 "image", "hierarchyid", "bytea", "map(", "[]", "point", "polygon", "tsvector")


def _is_numeric_type(typ: str) -> bool:
    t = (typ or "").lower()
    return any(w in t for w in _NUM_WORDS) and not any(w in t for w in _DATE_WORDS)


def _is_date_type(typ: str) -> bool:
    t = (typ or "").lower()
    return any(w in t for w in _DATE_WORDS)


def _is_bool_type(typ: str) -> bool:
    t = (typ or "").lower()
    return t in ("bool", "boolean", "bit")


def type_class(typ: str) -> tuple[str, str | None]:
    """(num / date / bool / text / skip, the reason when skipped) from the
    engine's own type name - the catalog, not a sample of rows."""
    t = (typ or "").lower().strip()
    if not t:
        return "text", None
    if any(w in t for w in _NESTED_WORDS):
        return "skip", "A nested, binary or JSON value - in-database training reads plain numbers, dates and text."
    if "interval" in t:
        return "skip", "A length of time - turn it into a number of days in a view to use it."
    if _is_bool_type(t):
        return "bool", None
    if "date" in t or "timestamp" in t:
        return "date", None
    if t.startswith("time"):
        return "skip", "A time of day without a date."
    if _is_numeric_type(t):
        return "num", None
    return "text", None


_ID_NAME = re.compile(r"(^id$|_id$|^id_|uuid|guid|_key$|^key$|_no$|_number$|^number$|email|phone)", re.I)


# ------------------------------------------------------------------ the model's terms

def _x_sql(d: Dialect, t: dict) -> str:
    """The raw value a number or date term is made from."""
    c = d.ident(t["col"])
    if t.get("base", t["t"]) == "date":
        return f"({_f(t['ref'])} - {d.epoch_days(c)})"
    return d.num(c)


def _rate_case(d: Dialect, t: dict) -> str:
    v = d.txt(d.ident(t["col"]))
    whens = " ".join(f"WHEN {d.lit(k)} THEN {_f(x)}" for k, x in t["map"].items())
    return f"(CASE {v} {whens} ELSE {_f(t['prior'])} END)" if whens else f"({_f(t['prior'])})"


def term_sql(d: Dialect, t: dict, ints: bool = False) -> str:
    """One term of the model in SQL, as the model was trained on it
    (numbers and rates standardised)."""
    one, zero = ("1", "0") if ints else (d.one, d.zero)
    c = d.ident(t["col"])
    k = t["t"]
    if k in ("num", "date"):
        return f"COALESCE(({_x_sql(d, t)} - {_f(t['mu'])}) / {_f(t['sd'])}, 0.0)"
    if k == "sq":
        z = f"COALESCE(({_x_sql(d, t)} - {_f(t['mu'])}) / {_f(t['sd'])}, 0.0)"
        zc = f"(CASE WHEN {z} > {_f(CURVE_CLIP)} THEN {_f(CURVE_CLIP)} WHEN {z} < {_f(-CURVE_CLIP)} THEN {_f(-CURVE_CLIP)} ELSE {z} END)"
        return f"({zc} * {zc} - 1.0)"
    if k == "miss":
        return f"CASE WHEN {c} IS NULL THEN {one} ELSE {zero} END"
    v = d.txt(c)
    if k == "lvl":
        return f"CASE WHEN {v} = {d.lit(t['level'])} THEN {one} ELSE {zero} END"
    if k == "other":
        return f"CASE WHEN {v} IS NOT NULL AND {v} NOT IN ({', '.join(d.lit(x) for x in t['top'])}) THEN {one} ELSE {zero} END"
    if k == "rate":
        return f"(({_rate_case(d, t)} - {_f(t['mu'])}) / {_f(t['sd'])})"
    raise PushdownError(f"Unknown model term {k}.")


def term_name(t: dict) -> str:
    k, c = t["t"], t["col"]
    return {"num": c, "date": c, "sq": f"{c} (curve)", "miss": f"{c} is empty", "lvl": f"{c} = {t.get('level')}",
            "other": f"{c} = other", "rate": f"{c} (outcome rate of its value)"}[k]


def _epoch_days_py(values) -> np.ndarray:
    s = pd.Series(values)
    if not pd.api.types.is_datetime64_any_dtype(s):
        s = pd.to_datetime(s.astype(object).where(s.notna(), None), errors="coerce", utc=True, format="mixed")
    if getattr(s.dt, "tz", None) is not None:
        s = s.dt.tz_convert("UTC").dt.tz_localize(None)
    return ((s - pd.Timestamp("1970-01-01")) / pd.Timedelta(days=1)).to_numpy(dtype=float)


def _cat_text(v, dialect: str | None = None) -> str | None:
    """A value as the database prints it when cast to text."""
    if v is None or (isinstance(v, float) and math.isnan(v)) or (v is pd.NA) or (v is pd.NaT):
        return None
    if isinstance(v, (bool, np.bool_)):
        if dialect in ("tsql", "mysql"):
            return "1" if v else "0"
        return "true" if v else "false"
    if isinstance(v, (float, np.floating)) and float(v).is_integer():
        return str(int(v))
    return str(v)


def _term_values(t: dict, X: pd.DataFrame, n: int, dialect: str | None) -> np.ndarray:
    col = X[t["col"]] if t["col"] in X.columns else pd.Series([None] * n, index=X.index, dtype=object)
    k = t["t"]
    if k in ("num", "date", "sq"):
        if t.get("base", k) == "date":
            x = t["ref"] - _epoch_days_py(col.to_numpy())
        else:
            x = pd.to_numeric(col, errors="coerce").to_numpy(dtype=float)
        z = (x - t["mu"]) / (t["sd"] or 1.0)
        z = np.where(np.isfinite(z), z, 0.0)
        if k == "sq":
            z = np.clip(z, -CURVE_CLIP, CURVE_CLIP)
            return z * z - 1.0
        return z
    if k == "miss":
        return pd.isna(col).to_numpy().astype(float)
    vals = [_cat_text(v, dialect) for v in col]
    if k == "lvl":
        return np.array([1.0 if v == t["level"] else 0.0 for v in vals])
    if k == "other":
        top = set(t["top"])
        return np.array([1.0 if (v is not None and v not in top) else 0.0 for v in vals])
    if k == "rate":
        m = t["map"]
        r = np.array([float(m.get(v, t["prior"])) if v is not None else float(t["prior"]) for v in vals])
        return (r - t["mu"]) / (t["sd"] or 1.0)
    raise PushdownError(f"Unknown model term {k}.")


# ------------------------------------------------------------------ the model as python

class SqlGLM(BaseEstimator):
    """The trained in-database model as a scikit-learn style estimator, so the
    rest of GD360 (one prediction, scoring a table, reasons per row) uses it
    like any other model. It computes exactly what the SQL computes.
    Round 41: the model is a list of terms (numbers, dates, curves, missing
    flags, category values, outcome rates); a round-40 model (numbers and
    category values only) still loads and scores the same."""

    def __init__(self, kind: str = "binary", features: list | None = None, numeric: dict | None = None, categories: dict | None = None,
                 beta: list | None = None, names: list | None = None, positive: str | None = None, negative: str | None = None,
                 terms: list | None = None, dialect: str | None = None):
        self.kind = kind
        self.features = features or []
        self.numeric = numeric or {}        # col -> [mean, sd] (numbers only - for the page)
        self.categories = categories or {}  # col -> {"levels", "top", "other", "reference"}
        self.beta = beta or []
        self.names = names or []
        self.positive = positive
        self.negative = negative
        self.terms = terms or []
        self.dialect = dialect

    @property
    def classes_(self):
        return np.array([self.negative, self.positive], dtype=object)

    def fit(self, X=None, y=None):  # trained in the database, never here
        return self

    def all_terms(self) -> list[dict]:
        t = getattr(self, "terms", None)
        if t:
            return t
        out = [{"t": "num", "col": c, "mu": float(mu), "sd": float(sd or 1.0)} for c, (mu, sd) in self.numeric.items()]
        for c, info in self.categories.items():
            out += [{"t": "lvl", "col": c, "level": lv} for lv in info["levels"]]
            if info.get("other"):
                out.append({"t": "other", "col": c, "top": list(info["top"])})
        return out

    def design(self, X: pd.DataFrame) -> np.ndarray:
        n = len(X)
        dia = getattr(self, "dialect", None)
        return np.column_stack([np.ones(n)] + [_term_values(t, X, n, dia) for t in self.all_terms()])

    def decision(self, X: pd.DataFrame) -> np.ndarray:
        return self.design(X) @ np.asarray(self.beta, dtype=float)

    def predict_proba(self, X: pd.DataFrame) -> np.ndarray:
        z = np.clip(self.decision(X), -Z_CLAMP, Z_CLAMP)
        p = 1.0 / (1.0 + np.exp(-z))
        return np.column_stack([1.0 - p, p])

    def contributions(self, row: dict) -> list[dict]:
        """What each column added to this row's score (log-odds for yes/no):
        coefficient times the row's own value - exact for this model."""
        x = self.design(pd.DataFrame([row]))[0]
        b = np.asarray(self.beta, dtype=float)
        acc: dict[str, float] = {}
        for i, t in enumerate(self.all_terms(), start=1):
            acc[t["col"]] = acc.get(t["col"], 0.0) + float(b[i] * x[i])
        out = [{"feature": c, "value": row.get(c), "contribution": v} for c, v in acc.items()]
        return sorted(out, key=lambda e: -abs(e["contribution"]))

    def predict(self, X: pd.DataFrame):
        if self.kind == "binary":
            p = self.predict_proba(X)[:, 1]
            return np.where(p >= 0.5, self.positive, self.negative)
        return self.decision(X)


def _plain(v):
    """A database value as JSON can carry it (dates, decimals, bytes)."""
    import decimal as _dec
    if isinstance(v, (_dt.date, _dt.datetime, _dt.time)):
        return v.isoformat()
    if isinstance(v, _dec.Decimal):
        return float(v)
    if isinstance(v, (bytes, bytearray, memoryview)):
        return f"<{len(bytes(v))} bytes>"
    return v


# ------------------------------------------------------------------ the engine

@dataclass
class Pass:
    step: str
    title: str
    sql: str
    seconds: float
    bytes_back: int
    rows_back: int
    scanned: int | None = None
    row_level: bool = False        # True only if customer rows came back (never, since round 41)


@dataclass
class Design:
    names: list[str] = field(default_factory=list)       # readable names per parameter
    exprs: list[str] = field(default_factory=list)       # SQL per parameter (as trained on)
    terms: list[dict] = field(default_factory=list)      # the terms after the intercept
    owner: list[str] = field(default_factory=list)       # which column each parameter belongs to
    numeric: dict = field(default_factory=dict)          # col -> [mean, sd] (numbers)
    categories: dict = field(default_factory=dict)       # col -> {"levels", "top", "other", "reference"} (one-hot)
    rates: dict = field(default_factory=dict)            # col -> {"levels", "prior"} (wide categories)
    dates: dict = field(default_factory=dict)            # col -> {"ref", "ref_text"}


class Trainer:
    """The passes of one in-database training run, in order: label (yes/no),
    scan, time split, profile, features, train, grade."""

    def __init__(self, src: Source, *, kind: str, target: str, positive: str | None = None, negative: str | None = None,
                 key: str | None = None, on_pass: Callable[["Pass"], None] | None = None, check_stop: Callable[[], None] | None = None):
        self.src, self.d = src, src.dialect
        self.kind, self.target, self.positive, self.negative = kind, target, positive, negative
        self.key = key
        self.split_cols: list[str] = []
        self.time_col: str | None = None
        self.cutoff: float | None = None
        self.split_info: dict = {"how": "hash"}
        self.on_pass, self.check_stop = on_pass, check_stop
        self.on_step: Callable[[list], None] | None = None
        self.on_ckpt: Callable[[dict], None] | None = None
        self.passes: list[Pass] = []
        self.design = Design()
        self.last_columns: list[str] = []
        self.cols: dict[str, dict] = {}
        self.n_labelled = 0
        self.leaks: list[dict] = []
        self.left_out: list[dict] = []
        self.warm_from: str | None = None
        self.warm_filter: str | None = None
        self.cap_bytes: float = 0.0
        self.label_counts: list[tuple[str, int]] = []

    # -------------------------------------------------------------- plumbing
    def scanned(self) -> int:
        return sum(p.scanned or 0 for p in self.passes)

    def run(self, step: str, title: str, sql: str) -> list[tuple]:
        if self.check_stop:
            self.check_stop()
        if self.cap_bytes:
            left = self.cap_bytes - self.scanned()
            if left <= 0:
                raise PushdownError(self._over_cap_words())
            self.src.limits["max_bytes"] = int(left)
        t = time.time()
        try:
            df, scanned = self.src.query(sql)
            self.last_columns = [str(c) for c in df.columns]
            rows = [tuple(None if (isinstance(v, float) and math.isnan(v)) else v for v in r) for r in df.itertuples(index=False, name=None)]
        except OverLimit as e:
            raise PushdownError(self._over_cap_words() if self.cap_bytes else str(e)) from e
        except PushdownError:
            raise
        except Exception as e:  # noqa: BLE001
            from .warehouse_exec import clean_warehouse_error
            raise PushdownError(f"{self.src.where_words} stopped the step “{title}”: {clean_warehouse_error(e)}") from e
        p = Pass(step=step, title=title, sql=sql, seconds=round(time.time() - t, 2),
                 bytes_back=len(json.dumps([[v for v in r if v is not None] for r in rows], default=str)), rows_back=len(rows),
                 scanned=int(scanned) if scanned else None)
        self.passes.append(p)
        if self.on_pass:
            self.on_pass(p)
        return rows

    def _over_cap_words(self) -> str:
        return (f"This run reached its scan limit of {self.cap_bytes / 1e9:,.0f} GB ({self.scanned() / 1e9:,.1f} GB used). "
                "An admin can raise ML_SQL_MAX_GB_PER_RUN; training again goes on from the last finished step.")

    def _where(self, extra: list[str] | None = None) -> str:
        conds = [f"{self.d.ident(self.target)} IS NOT NULL"] + list(self.src.filters) + [x for x in (extra or []) if x]
        return " WHERE " + " AND ".join(conds)

    def y_expr(self) -> str:
        t = self.d.ident(self.target)
        if self.kind == "binary":
            return f"CASE WHEN {self.d.txt(t)} = {self.d.lit(self.positive)} THEN {self.d.one} ELSE {self.d.zero} END"
        return self.d.num(t)

    def split_key(self) -> str:
        d = self.d
        if self.key:
            return f"COALESCE({d.txt(d.ident(self.key))}, '')"
        cols = (self.split_cols or [self.target])[:6]
        return d.concat([f"COALESCE({d.txt(d.ident(c))}, '')" for c in cols])

    def split_expr(self) -> str:
        return self.d.hash100(self.split_key())

    def part_cond(self, part: str) -> str | None:
        if part == "all":
            return None
        if self.cutoff is not None:
            c = self.d.ident(self.time_col)
            e = self.d.epoch_days(c)
            return f"({c} IS NULL OR {e} < {_f(self.cutoff)})" if part == "train" else f"{e} >= {_f(self.cutoff)}"
        s = self.split_expr()
        return f"{s} >= {HOLDOUT}" if part == "train" else f"{s} < {HOLDOUT}"

    def train_flag(self) -> str:
        return f"CASE WHEN {self.part_cond('train')} THEN 1 ELSE 0 END"

    def _rows(self, part: str, cols: list[str], sample: bool = False) -> str:
        """The labelled rows of one part (train / test / all), with the given
        per-row expressions computed once each."""
        rel = self.warm_from if (sample and self.warm_from) else self.src.rel
        extra = [self.part_cond(part)] + ([self.warm_filter] if sample and self.warm_filter else [])
        return f"SELECT {', '.join(cols)} FROM {rel}{self._where(extra)}{self.d.fence()}"

    # -------------------------------------------------------------- 0. the label
    def label_values(self) -> list[tuple[str, int]]:
        d = self.d
        t = d.txt(d.ident(self.target))
        sql = f"SELECT {d.top(25)}{t} AS gd_v, COUNT(*) AS gd_n FROM {self.src.rel}{self._where()} GROUP BY {t} ORDER BY COUNT(*) DESC{d.limit(25)}"
        rows = self.run("data", f"How many rows have each value of {self.target}", sql)
        self.label_counts = [(str(r[0]), int(r[1] or 0)) for r in rows if r[0] is not None]
        return self.label_counts

    # -------------------------------------------------------------- 1. scan: types from the catalog, counts in the database
    def scan(self, spec: dict) -> dict:
        d = self.d
        exclude = set(spec.get("exclude") or [])
        reasons = spec.get("exclude_reasons") or {}
        time_col = spec.get("time_column")
        cands: list[str] = []
        for c, typ in self.src.types.items():
            if c == self.target or c in self.src.hidden:
                continue
            cls, why = type_class(typ)
            meta = {"column": c, "type": typ or "unknown", "cls": cls}
            self.cols[c] = meta
            if c in exclude:
                meta.update(use="left out", reason=reasons.get(c, "Left out by you."))
            elif cls == "skip":
                meta.update(use="left out", reason=why)
            elif len(cands) >= MAX_SCAN_COLS:
                meta.update(use="left out", reason=f"Past the first {MAX_SCAN_COLS} columns.")
            else:
                cands.append(c)
        if self.target not in self.src.types and self.src.types:
            raise PushdownError(f"{self.target} isn't a column of this table.")
        tt = self.src.types.get(self.target, "")
        if self.kind == "number" and tt and not _is_numeric_type(tt):
            raise PushdownError(f"{self.target} is stored as {tt}, not a number - a number model needs a numeric column.")
        aggs = ["COUNT(*)"]
        for c in cands:
            e = d.ident(c)
            cls = self.cols[c]["cls"]
            aggs += [f"COUNT({e})", d.count_distinct(e if cls in ("num", "date") else d.txt(e))]
            if cls == "date":
                aggs += [f"MIN({d.epoch_days(e)})", f"MAX({d.epoch_days(e)})"]
        r = self.run("scan", "Count every column's filled and distinct values - one pass, no row comes back",
                     f"SELECT {_aliased(aggs)} FROM {self.src.rel}{self._where()}")[0]
        n = int(r[0] or 0)
        self.n_labelled = n
        if n < 60:
            raise PushdownError(f"Only {n} rows have a {self.target} you can see - in-database training needs at least 60.")
        i = 1
        for c in cands:
            m = self.cols[c]
            m["filled"], m["distinct"] = int(r[i] or 0), min(int(r[i + 1] or 0), int(r[i] or 0))
            i += 2
            if m["cls"] == "date":
                m["min"] = float(r[i]) if r[i] is not None else None
                m["max"] = float(r[i + 1]) if r[i + 1] is not None else None
                i += 2
        key = None
        for c in cands:
            m = self.cols[c]
            f, dn, cls = m["filled"], m["distinct"], m["cls"]
            idname = bool(_ID_NAME.search(str(c)))
            if f == 0:
                m.update(use="left out", reason="Empty in every row.")
            elif dn <= 1:
                m.update(use="left out", reason="The same value in every row.")
            elif c == time_col and cls == "date":
                m.update(use="fair test", reason="Splits older rows (to learn from) from the newest (to test on).")
            elif cls == "num":
                if idname and f > 50 and dn >= 0.9 * f:
                    m.update(use="left out", reason="An id (a different value in almost every row) - it can't generalise.")
                else:
                    m.update(use="number")
            elif cls == "date":
                if m.get("max") is None or m.get("min") is None or m["max"] - m["min"] <= 0:
                    m.update(use="left out", reason="The same date in every row.")
                else:
                    m.update(use="date")
            elif cls == "bool":
                m.update(use="category")
            elif f > 50 and dn >= 0.9 * f:
                m.update(use="left out", reason="An id (a different value in almost every row) - it can't generalise." if idname or dn >= 0.99 * f
                         else f"Free text ({dn:,} different values).")
            elif dn <= ONEHOT_MAX:
                m.update(use="category")
            elif dn <= WIDE_MAX:
                m.update(use="rate")
            else:
                m.update(use="left out", reason=f"Free text or too many categories ({dn:,}).")
            if m.get("use") == "left out" and f >= 0.98 * n and dn >= 0.9 * f and (key is None or (idname and not _ID_NAME.search(str(key)))):
                key = c
        self.key = self.key or key
        used = [c for c in cands if self.cols[c].get("use") in ("number", "date", "category", "rate")]
        self.split_cols = [self.target] + used[:5]
        self.left_out = [{"column": c, "reason": m["reason"]} for c, m in self.cols.items() if m.get("use") == "left out"]
        return {"rows": n, "key": self.key, "used": used}

    # -------------------------------------------------------------- 2. the fair test
    def time_split(self, col: str | None) -> dict:
        """The newest 20% of rows by `col` held out (a cutoff from a histogram
        of the dates, computed in the database). Otherwise a fixed hash."""
        d = self.d
        m = self.cols.get(col or "")
        if not col or not m or m.get("cls") != "date" or m.get("min") is None or m.get("max") is None or m["max"] <= m["min"]:
            self.split_info = {"how": "hash", "key": self.key}
            if col and col in self.src.types:
                self.split_info["note"] = f"{col} isn't a date in the database, so a fixed 20% of rows is held out instead."
            return self.split_info
        lo, hi = m["min"], m["max"]
        width = max((hi - lo) / 2000.0, 1.0 / 1440)
        e = d.epoch_days(d.ident(col))
        b = d.to_int(f"FLOOR(({e} - {_f(lo)}) / {_f(width)})")
        sql = (f"SELECT gd_b, COUNT(*) AS gd_n FROM (SELECT {b} AS gd_b FROM {self.src.rel}{self._where([f'{d.ident(col)} IS NOT NULL'])}{d.fence()}) gd_s "
               "GROUP BY gd_b")
        rows = sorted((int(r[0]), int(r[1] or 0)) for r in self.run("scan", f"Rows per date band of {col} (to find the newest 20%)", sql) if r[0] is not None)
        dated = sum(nn for _, nn in rows)
        nulls = self.n_labelled - dated
        best, cum = None, 0
        for bi, nn in rows:
            train = cum + nulls
            test = self.n_labelled - train
            if train >= 50 and test >= 20:
                gap = abs(train / self.n_labelled - (1 - HOLDOUT / 100))
                if best is None or gap < best[0]:
                    best = (gap, bi, train, test)
            cum += nn
        if best is None:
            m.update(use="date")
            self.split_info = {"how": "hash", "key": self.key, "note": f"{col} has too few distinct dates to hold out the newest rows - a fixed 20% is held out instead."}
            return self.split_info
        _, bi, train, test = best
        self.time_col, self.cutoff = col, lo + bi * width
        self.split_info = {"how": "time", "column": col, "cutoff": self.cutoff, "cutoff_iso": _iso_day(self.cutoff), "cutoff_text": _nice_day(self.cutoff),
                           "newest_text": _nice_day(hi), "train_share": train / self.n_labelled, "nulls": nulls}
        return self.split_info

    # -------------------------------------------------------------- 3. profile
    def profile(self) -> dict:
        d = self.d
        nums = [c for c, m in self.cols.items() if m.get("use") in ("number", "date")]
        cats = [c for c, m in self.cols.items() if m.get("use") in ("category", "rate")]
        for c in nums[NUM_CANDIDATES:]:
            self.cols[c].update(use="left out", reason=f"Past the first {NUM_CANDIDATES} numbers and dates.")
        for c in cats[CAT_CANDIDATES:]:
            self.cols[c].update(use="left out", reason=f"Past the first {CAT_CANDIDATES} categories.")
        nums, cats = nums[:NUM_CANDIDATES], cats[:CAT_CANDIDATES]
        self.nums, self.cats = nums, cats
        inner = [f"{self.y_expr()} AS gd_y"]
        for i, c in enumerate(nums):
            m = self.cols[c]
            spec = {"col": c, "t": "date" if m["use"] == "date" else "num", "ref": m.get("max")}
            inner.append(f"{_x_sql(d, spec)} AS gd_n{i}")
        inner += [f"{d.txt(d.ident(c))} AS gd_c{j}" for j, c in enumerate(cats)]
        aggs = ["COUNT(*)", "SUM(gd_y)", "SUM(gd_y * gd_y)"]
        for i, _ in enumerate(nums):
            x = f"gd_n{i}"
            aggs += [f"COUNT({x})", f"AVG({x})", d.stddev(x), f"AVG({x} * gd_y)",
                     f"AVG(CASE WHEN {x} IS NOT NULL THEN gd_y END)", d.stddev(f"CASE WHEN {x} IS NOT NULL THEN gd_y END")]
        for j, _ in enumerate(cats):
            x = f"gd_c{j}"
            aggs += [f"COUNT({x})", f"AVG(CASE WHEN {x} IS NOT NULL THEN gd_y END)", d.stddev(f"CASE WHEN {x} IS NOT NULL THEN gd_y END")]
        sql = f"SELECT {_aliased(aggs)} FROM ({self._rows('train', inner)}) gd_s"
        r = self.run("profile", "Means, spreads, empty shares and each column's link to the outcome - one pass over the training rows", sql)[0]
        n_tr = int(r[0] or 0)
        if n_tr < 50:
            raise PushdownError(f"Only {n_tr} labelled training rows - in-database training needs at least 50.")
        sy, syy = float(r[1] or 0), float(r[2] or 0)
        y_mean = sy / n_tr
        y_sd = math.sqrt(max(0.0, syy / n_tr - y_mean * y_mean))
        out = {"rows": self.n_labelled, "train_rows": n_tr, "test_rows": self.n_labelled - n_tr, "y_mean": y_mean, "y_sd": y_sd,
               "numeric": {}, "categories": {}}
        if out["test_rows"] < 20:
            raise PushdownError(f"Only {out['test_rows']} rows are held out for the test - in-database training needs at least 20.")
        if self.kind == "binary":
            if y_mean <= 0 or y_mean >= 1:
                raise PushdownError(f"Every training row has the same {self.target} - there is nothing to tell apart.")
            out["rate"] = y_mean
        elif y_sd <= 1e-12:
            raise PushdownError(f"{self.target} has the same value in every training row - there is nothing to predict.")
        i = 3
        for c in nums:
            cnt, mu, sd, mxy, my, sdy = (r[i + k] for k in range(6))
            i += 6
            cnt = int(cnt or 0)
            st = {"filled": cnt, "miss": 1 - cnt / n_tr, "use": self.cols[c]["use"], "ref": self.cols[c].get("max")}
            if mu is None or sd is None or not math.isfinite(float(sd)) or float(sd) <= 1e-12:
                self.cols[c].update(use="left out", reason="The same value in every training row (or empty).")
                continue
            mu, sd = float(mu), float(sd)
            my = float(my) if my is not None else y_mean
            sdy = float(sdy) if sdy is not None else y_sd
            cov = float(mxy or 0) - mu * my
            st.update(mean=mu, sd=sd, corr=(cov / (sd * sdy)) if sdy > 1e-12 else 0.0)
            q = st["miss"]
            if 0 < q < 1 and y_sd > 1e-12:
                y_miss = (sy - my * cnt) / max(1.0, n_tr - cnt)
                st["miss_corr"] = (q * y_miss - q * y_mean) / (math.sqrt(q * (1 - q)) * y_sd)
            out["numeric"][c] = st
        for c in cats:
            cnt, my, sdy = int(r[i] or 0), r[i + 1], r[i + 2]
            i += 3
            out["categories"][c] = {"filled": cnt, "miss": 1 - cnt / n_tr, "y_mean": float(my) if my is not None else y_mean,
                                    "y_sd": float(sdy) if sdy is not None else y_sd, "use": self.cols[c]["use"]}
        self.prof = out
        return out

    # -------------------------------------------------------------- 4. features: levels, the leak check, the design
    def levels(self, cats: list[str]) -> dict[str, list[tuple[str, int, float]]]:
        """The most common values of every category (on the training rows)
        with their row count and outcome sum - one statement."""
        if not cats:
            return {}
        d = self.d
        inner = [f"{self.y_expr()} AS gd_y"] + [f"{d.txt(d.ident(c))} AS gd_c{j}" for j, c in enumerate(cats)]
        keep = RATE_LEVELS + 1
        if d.grouping_sets:
            gsets = ", ".join(f"(gd_c{j})" for j in range(len(cats)))
            s_set = "CASE " + " ".join(f"WHEN GROUPING(gd_c{j}) = 0 THEN {j}" for j in range(len(cats))) + " END"
            s_val = "CASE " + " ".join(f"WHEN GROUPING(gd_c{j}) = 0 THEN gd_c{j}" for j in range(len(cats))) + " END"
            q1 = (f"SELECT {s_set} AS gd_set, {s_val} AS gd_v, COUNT(*) AS gd_n, SUM(gd_y) AS gd_sy "
                  f"FROM ({self._rows('train', inner)}) gd_s GROUP BY GROUPING SETS ({gsets})")
            q2 = (f"SELECT gd_set, gd_v, gd_n, gd_sy, ROW_NUMBER() OVER (PARTITION BY gd_set ORDER BY gd_n DESC, gd_v) AS gd_rk "
                  f"FROM ({q1}) gd_g WHERE gd_v IS NOT NULL")
            sql = f"SELECT gd_set, gd_v, gd_n, gd_sy FROM ({q2}) gd_r WHERE gd_rk <= {keep}"
        else:
            parts = [f"SELECT * FROM (SELECT {j} AS gd_set, gd_c{j} AS gd_v, COUNT(*) AS gd_n, SUM(gd_y) AS gd_sy FROM ({self._rows('train', inner)}) gd_s{j} "
                     f"WHERE gd_c{j} IS NOT NULL GROUP BY gd_c{j} ORDER BY COUNT(*) DESC, gd_c{j} LIMIT {keep}) gd_u{j}" for j in range(len(cats))]
            sql = " UNION ALL ".join(parts)
        rows = self.run("profile", "The most common values of every category, with their outcome - one statement", sql)
        out: dict[str, list] = {c: [] for c in cats}
        for s_, v, n_, sy_ in rows:
            if s_ is None or v is None:
                continue
            out[cats[int(s_)]].append((str(v), int(n_ or 0), float(sy_ or 0)))
        for c in out:
            out[c].sort(key=lambda x: (-x[1], x[0]))
        return out

    def features(self) -> Design:
        """Leak check, ranking and the model's terms - from the profile and
        one levels statement."""
        prof = self.prof
        n_tr, y_mean = prof["train_rows"], prof["y_mean"]
        tgt = self.target
        bar = LEAK_CORR[self.kind]
        leaks = []
        # numbers and dates: correlation with the outcome (and of being empty)
        for c, st in list(prof["numeric"].items()):
            r = st.get("corr", 0.0)
            if abs(r) >= bar:
                leaks.append({"column": c, "reason": (f"Moves almost exactly with {tgt} (correlation {r:.3f}) - it is very likely derived from the answer."
                                                      if self.kind == "number" else
                                                      f"On its own it separates the outcomes almost perfectly (correlation {r:.3f}) - it is very likely recorded after the outcome."),
                              "how": "correlation, in the database"})
            elif abs(st.get("miss_corr", 0.0)) >= bar:
                leaks.append({"column": c, "reason": f"Whether it is empty tells the answer (correlation {st['miss_corr']:.3f}) - it is very likely filled in after the outcome.",
                              "how": "empty vs filled, in the database"})
        # categories: levels with their outcome
        cats = [c for c in prof["categories"]]
        lv = self.levels(cats)
        for c in cats:
            st = prof["categories"][c]
            levels = lv.get(c) or []
            st["levels"] = levels
            nf, my, sdy = st["filled"], st["y_mean"], st["y_sd"]
            groups = [(n_, sy_) for _, n_, sy_ in levels if n_ >= 20]
            rest_n = nf - sum(n_ for n_, _ in groups)
            rest_sy = my * nf - sum(sy_ for _, sy_ in groups)
            if rest_n > 0:
                groups.append((rest_n, rest_sy))
            between = sum(n_ * (sy_ / n_ - my) ** 2 for n_, sy_ in groups if n_ > 0)
            eta2 = between / (nf * sdy * sdy) if nf > 0 and sdy > 1e-12 else 0.0
            st["eta2"] = eta2
            if len(groups) >= 2 and eta2 >= bar ** 2:
                leaks.append({"column": c, "reason": f"Its values map to the answer almost one to one (they explain {eta2 * 100:.1f}% of {tgt}) - it gives the answer away.",
                              "how": "outcome per value, in the database"})
            if len(levels) < 2:
                self.cols[c].update(use="left out", reason="One value in every training row.")
        gone = {x["column"] for x in leaks}
        for c in gone:
            self.cols[c].update(use="left out", reason="Gives the answer away (see the leak check).")
        self.leaks = leaks
        # the strongest numbers and categories, within the limits
        nums = sorted([c for c in prof["numeric"] if c not in gone and self.cols[c].get("use") in ("number", "date")],
                      key=lambda c: -abs(prof["numeric"][c].get("corr", 0.0)))
        for c in nums[MAX_NUMERIC:]:
            self.cols[c].update(use="left out", reason=f"Over the {MAX_NUMERIC}-number limit of in-database training (one of the least linked to {tgt}).")
        nums = nums[:MAX_NUMERIC]
        cats = sorted([c for c in prof["categories"] if c not in gone and self.cols[c].get("use") in ("category", "rate")],
                      key=lambda c: -prof["categories"][c].get("eta2", 0.0))
        for c in cats[MAX_CATEGORIES:]:
            self.cols[c].update(use="left out", reason=f"Over the {MAX_CATEGORIES}-category limit of in-database training (one of the least linked to {tgt}).")
        cats = cats[:MAX_CATEGORIES]
        # terms: each column's own terms, strongest column first (share of the outcome's variance it explains on
        # its own: corr² for numbers, eta² for categories); then missing flags; then curves - while there is room
        cores: list[tuple[float, list[dict]]] = []
        flags, curves = [], []
        des = Design()
        for c in nums:
            st = prof["numeric"][c]
            base = "date" if st["use"] == "date" else "num"
            t = {"t": base, "col": c, "mu": st["mean"], "sd": st["sd"], "var": 1 - st["miss"]}
            if base == "date":
                t["ref"] = st["ref"]
            cores.append((st.get("corr", 0.0) ** 2, [t]))
            if MISS_MIN <= st["miss"] <= 1 - MISS_MIN:
                flags.append({"t": "miss", "col": c, "var": st["miss"] * (1 - st["miss"])})
            if self.cols[c].get("distinct", 0) > 10 and len(curves) < CURVE_TOP:
                curves.append({**{k: v for k, v in t.items() if k != "var"}, "t": "sq", "base": base, "var": 2 * (1 - st["miss"])})
        for c in cats:
            st = prof["categories"][c]
            levels = st["levels"]
            if st["use"] == "category":
                top = [v for v, _, _ in levels[:MAX_LEVELS + 1]]
                other = len(levels) > len(top)
                group = [{"t": "lvl", "col": c, "level": v} for v in top[1:]] + ([{"t": "other", "col": c, "top": top}] if other else [])
                info = {"levels": top[1:], "top": top, "other": bool(other), "reference": top[0],
                        "counts": [n_ for _, n_, _ in levels[:MAX_LEVELS + 1]], "filled": st["filled"]}
            else:
                prior = y_mean
                kept = levels[:RATE_LEVELS]
                mp = {v: (sy_ + RATE_M * prior) / (n_ + RATE_M) for v, n_, sy_ in kept}
                n_in = sum(n_ for _, n_, _ in kept)
                s1 = sum(n_ * mp[v] for v, n_, _ in kept) + (n_tr - n_in) * prior
                s2 = sum(n_ * mp[v] ** 2 for v, n_, _ in kept) + (n_tr - n_in) * prior * prior
                mu = s1 / n_tr
                sd = math.sqrt(max(0.0, s2 / n_tr - mu * mu))
                if sd <= 1e-9:
                    self.cols[c].update(use="left out", reason="Its values all have about the same outcome.")
                    continue
                group = [{"t": "rate", "col": c, "map": {k: round(v, 10) for k, v in mp.items()}, "prior": prior, "mu": mu, "sd": sd, "var": 1.0}]
                info = {"levels": len(kept), "prior": prior, "values": self.cols[c].get("distinct")}
            st["info"] = info
            cores.append((st.get("eta2", 0.0), group))
            if MISS_MIN <= st["miss"] <= 1 - MISS_MIN:
                flags.append({"t": "miss", "col": c, "var": st["miss"] * (1 - st["miss"])})
        cores.sort(key=lambda x: -x[0])
        terms: list[dict] = []
        for group in [g_ for _, g_ in cores] + [flags, curves]:
            for t in group:
                if 1 + len(terms) >= MAX_PARAMS:
                    break
                terms.append(t)
        if not terms:
            raise PushdownError("No column is usable to learn from in the database - every column was empty, constant, an id, free text or a leak.")
        cols_in = {t["col"] for t in terms if t["t"] != "miss"}
        terms = [t for t in terms if t["t"] != "miss" or t["col"] in cols_in]   # a flag never stands without its column
        for c in nums:
            if c in cols_in:
                st = prof["numeric"][c]
                if st["use"] == "date":
                    des.dates[c] = {"ref": st["ref"], "ref_text": _nice_day(st["ref"])}
                else:
                    des.numeric[c] = [st["mean"], st["sd"]]
        for c in cats:
            st = prof["categories"][c]
            if c not in cols_in or "info" not in st:
                continue
            if st["use"] == "category":
                info = dict(st["info"])
                info["levels"] = [t["level"] for t in terms if t["t"] == "lvl" and t["col"] == c]   # what fitted under the limit
                des.categories[c] = info
            else:
                des.rates[c] = st["info"]
        for c in list(nums) + list(cats):
            if c in cols_in:
                self.cols[c]["in_model"] = True
            elif self.cols[c].get("use") != "left out":
                self.cols[c].update(use="left out", reason="Over the in-database limit of model terms (one of the least linked to the outcome).")
        d = self.d
        des.terms = terms
        des.names = ["intercept"] + [term_name(t) for t in terms]
        des.exprs = [d.one] + [term_sql(d, t) for t in terms]
        des.owner = ["intercept"] + [t["col"] for t in terms]
        self.design = des
        self.left_out = [{"column": c, "reason": m["reason"]} for c, m in self.cols.items() if m.get("use") == "left out" and c not in gone]
        return des

    def signature(self) -> str:
        """What a checkpoint must match to be reused: the same terms (their
        means and spreads to 9 digits - sums in parallel engines differ in the
        last bits between runs), the same split, the same table and rules."""
        def norm(v):
            if isinstance(v, float):
                return float(f"{v:.9g}")
            if isinstance(v, dict):
                return {k: norm(x) for k, x in sorted(v.items()) if k != "var"}
            if isinstance(v, list):
                return [norm(x) for x in v]
            return v
        payload = json.dumps([norm(self.design.terms), self.src.rel, self.src.filters, self.split_info.get("how"), norm(self.cutoff),
                              self.key, self.split_cols, self.positive, self.kind], default=str)
        return hashlib.sha1(payload.encode()).hexdigest()

    # -------------------------------------------------------------- 5a. logistic regression
    def _pairs(self) -> list[tuple[int, int]]:
        """The (i, j) cross sums the database computes. Two values of the same
        one-hot category never sit on one row, so their sum is 0 - not asked for."""
        kinds = ["one"] + [t["t"] for t in self.design.terms]
        own = self.design.owner
        k = len(own)

        def onehot(i):
            return kinds[i] in ("lvl", "other")
        return [(i, j) for i in range(k) for j in range(i, k) if i == j or not (onehot(i) and onehot(j) and own[i] == own[j])]

    def _eta(self, beta: np.ndarray) -> str:
        return " + ".join(f"{_f(b)} * gd_x{i}" for i, b in enumerate(beta))

    def _x_cols(self) -> list[str]:
        return [f"{e} AS gd_x{i}" for i, e in enumerate(self.design.exprs)] + [f"{self.y_expr()} AS gd_y"]

    def raw_z(self, beta: np.ndarray) -> str:
        """The deployable model's score (original units), to prove it equals the trained one."""
        b0, terms = raw_terms(self.d, self.glm(beta))
        return " + ".join([_f(b0)] + [f"({_f(b)}) * {t}" for _, b, t in terms])

    def _sums(self, wrap: Callable[[str], str] = lambda s: s) -> list[str]:
        k = len(self.design.exprs)
        sums = ["SUM(gd_w)" if i == 0 and j == 0 else f"SUM(gd_w * gd_x{j})" if i == 0 else f"SUM(gd_w * gd_x{i} * gd_x{j})" for i, j in self._pairs()]
        sums += ["SUM(gd_e)" if i == 0 else f"SUM(gd_x{i} * gd_e)" for i in range(k)]
        return [wrap(s) for s in sums]

    def newton_sql(self, beta: np.ndarray, *, sample: bool = False, fused: bool = False) -> str:
        d, k = self.d, len(self.design.exprs)
        xs = ", ".join(f"gd_x{i}" for i in range(k))
        ll = f"gd_y * {d.ln('gd_p')} + (1.0 - gd_y) * {d.ln('1.0 - gd_p')}"
        if not fused:
            s0 = self._rows("train", self._x_cols(), sample=sample)
            s1 = f"SELECT {xs}, gd_y, {self._eta(beta)} AS gd_z FROM ({s0}) gd_a{d.fence()}"
            s2 = f"SELECT {xs}, gd_y, {_sigmoid_sql('gd_z')} AS gd_p FROM ({s1}) gd_b{d.fence()}"
            s3 = f"SELECT {xs}, gd_y, gd_p, gd_p * (1.0 - gd_p) AS gd_w, gd_y - gd_p AS gd_e FROM ({s2}) gd_c{d.fence()}"
            return f"SELECT {_aliased(self._sums() + [f'SUM({ll})', 'COUNT(*)'])} FROM ({s3}) gd_d"
        # one scan: the Newton sums over the training rows (group -1) AND the
        # 1,000-bucket histogram of the held-out rows (groups 0-999), with the
        # largest gap between the deployable SQL and the trained model
        s0 = self._rows("all", self._x_cols() + [f"{self.train_flag()} AS gd_t", f"{self.raw_z(beta)} AS gd_r"])
        s1 = f"SELECT {xs}, gd_y, gd_t, gd_r, {self._eta(beta)} AS gd_z FROM ({s0}) gd_a{d.fence()}"
        s2 = f"SELECT {xs}, gd_y, gd_t, {_sigmoid_sql('gd_z')} AS gd_p, {_sigmoid_sql('gd_r')} AS gd_q FROM ({s1}) gd_b{d.fence()}"
        s3 = (f"SELECT {xs}, gd_y, gd_p, gd_q, CASE WHEN gd_t = 1 THEN gd_p * (1.0 - gd_p) ELSE 0.0 END AS gd_w, "
              f"CASE WHEN gd_t = 1 THEN gd_y - gd_p ELSE 0.0 END AS gd_e, "
              f"CASE WHEN gd_t = 1 THEN -1 WHEN gd_p >= 1.0 THEN {BUCKETS - 1} ELSE {d.to_int(f'FLOOR(gd_p * {BUCKETS})')} END AS gd_g "
              f"FROM ({s2}) gd_c{d.fence()}")
        head = ["COUNT(*)", "SUM(gd_y)", f"SUM({ll})", "MAX(ABS(gd_q - gd_p))"]
        return f"SELECT gd_g, {_aliased(head + self._sums(lambda s: f'CASE WHEN gd_g < 0 THEN {s} END'))} FROM ({s3}) gd_d GROUP BY gd_g"

    def _solve(self, vals: list[float], ridge: float, n_rows: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        k = len(self.design.exprs)
        pairs = self._pairs()
        H = np.zeros((k, k))
        for n_, (i, j) in enumerate(pairs):
            H[i, j] = H[j, i] = vals[n_]
        g = np.array(vals[len(pairs):len(pairs) + k])
        try:
            step = np.linalg.solve(H + ridge * max(1.0, n_rows) * np.eye(k), g)
        except np.linalg.LinAlgError as e:
            raise PushdownError("The columns are too closely tied to each other to solve - leave out duplicates and train again.") from e
        return H, g, step

    def _warm_start(self, beta: np.ndarray, n_train: int, history: list, ridge: float) -> tuple[np.ndarray, dict]:
        """Newton to convergence on a sample the engine draws itself: the full
        passes then start next to the answer and need 2-3 steps, not 6-12."""
        d = self.d
        pct = min(50.0, max(0.01, 100.0 * WARM_TARGET / max(1, n_train)))
        tries = []
        eng = d.sample(self.src.rel, pct)
        if eng:
            tries.append(("engine", eng, None))
        tries.append(("hash", None, f"{d.hash_mod(d.concat([self.split_key(), d.lit('gd360-warm')]), 10000)} < {int(round(pct * 100))}"))
        last_err = None
        for how, frm, flt in tries:
            self.warm_from, self.warm_filter = frm, flt
            b = beta.copy()
            steps = []
            try:
                for it in range(MAX_ITER):
                    vals = [float(v or 0) for v in self.run("train", f"Warm start {it + 1}: a Newton step on a {pct:.3g}% sample drawn by {self.src.where_words}",
                                                             self.newton_sql(b, sample=True))[0]]
                    n_s = max(1.0, vals[-1])
                    if it == 0 and how == "engine" and n_s < 2000 and n_train >= WARM_ROWS:
                        raise PushdownError("the engine's sample came back too small")
                    _, _, step = self._solve(vals, ridge, n_s)
                    norm = float(np.max(np.abs(step)))
                    if norm > 5:
                        step *= 5 / norm
                    b = b + step
                    steps.append({"step": len(history) + len(steps) + 1, "log_loss": -vals[-2] / n_s, "change": norm, "rows": int(n_s), "sample": True})
                    if self.on_step:
                        self.on_step(history + steps)
                    if norm < 1e-4:
                        break
                history += steps
                return b, {"how": how, "percent": pct, "steps": len(steps), "rows": steps[-1]["rows"] if steps else 0}
            except PushdownError as e:
                last_err = e
                if how != "engine":
                    raise
                logger.info("[ml_pushdown] engine sample failed (%s) - hash sample instead", e)
            finally:
                self.warm_from = self.warm_filter = None
        raise last_err or PushdownError("The warm start failed.")

    def train_logistic(self, prof: dict, ckpt: dict | None = None, ridge: float = 1e-6, warm: bool | None = None) -> dict:
        k = len(self.design.exprs)
        rate = prof["rate"]
        beta = np.zeros(k)
        beta[0] = math.log(rate / (1 - rate))
        history: list[dict] = []
        sig = self.signature()
        resumed = 0
        if ckpt and ckpt.get("sig") == sig and len(ckpt.get("beta") or []) == k:
            beta = np.array(ckpt["beta"], dtype=float)
            history = list(ckpt.get("history") or [])
            resumed = len(history)
        warm_info = None
        if not resumed and (warm if warm is not None else prof["train_rows"] >= WARM_ROWS):
            beta, warm_info = self._warm_start(beta, prof["train_rows"], history, ridge)
        # where the engine bills or times by the scan, the pass after a small step also grades the model and proves the SQL
        can_fuse = self.d.d in FUSE_DIALECTS
        fuse = bool(warm_info) or bool(resumed and history and history[-1].get("change", 1) < FUSE_AT)
        graded, H, converged, full = None, np.eye(k), False, 0
        while full < MAX_ITER:
            fused = fuse and can_fuse
            if fused:
                rows = self.run("train", f"Pass {full + 1} over every row: Newton sums on the training rows, and the held-out rows graded",
                                self.newton_sql(beta, fused=True))
                tr_row = next((r for r in rows if r[0] is not None and int(r[0]) < 0), None)
                if tr_row is None:
                    raise PushdownError("No training rows came back from the pass.")
                vals = [float(v or 0) for v in tr_row[5:]]
                n_rows, ll = float(tr_row[1] or 0), float(tr_row[3] or 0)
                buckets = [(int(r[0]), float(r[1] or 0), float(r[2] or 0), float(r[3] or 0)) for r in rows if r[0] is not None and int(r[0]) >= 0]
                agree = max([float(r[4] or 0) for r in rows if r[0] is not None and int(r[0]) >= 0] or [0.0])
            else:
                vals = [float(v or 0) for v in self.run("train", f"Pass {full + 1} over every training row: the Newton sums",
                                                        self.newton_sql(beta))[0]]
                n_rows, ll = max(1.0, vals[-1]), vals[-2]
            H, _, step = self._solve(vals, ridge, n_rows)
            norm = float(np.max(np.abs(step)))
            history.append({"step": len(history) + 1, "log_loss": -ll / max(1.0, n_rows), "change": norm, "rows": int(n_rows), "sample": False})
            full += 1
            if self.on_step:
                self.on_step(history)
            if fused and norm < ACCEPT:   # the model graded in this pass is the one kept
                converged = True
                graded = binary_metrics(buckets)
                graded["agree"] = {"rows": int(sum(b[1] for b in buckets)), "max_diff": agree, "where": "held-out rows, inside the database"}
                break
            if not can_fuse and norm < ACCEPT_STEP:   # take the last step; a grading pass follows
                converged = True
                beta = beta + step
                break
            if norm > 5:
                step *= 5 / norm
            beta = beta + step
            if self.on_ckpt:
                self.on_ckpt({"sig": sig, "beta": [float(x) for x in beta], "history": history, "at": time.time()})
            fuse = norm < FUSE_AT
        cov = np.linalg.pinv(H + ridge * max(1.0, prof["train_rows"]) * np.eye(k))
        return {"beta": beta, "cov": cov, "history": history, "converged": converged, "graded": graded, "warm": warm_info,
                "resumed": resumed, "full_passes": full}

    # -------------------------------------------------------------- 5b. linear regression
    def train_linear(self, prof: dict, ridge: float = 1e-8) -> dict:
        k = len(self.design.exprs)
        s0 = self._rows("train", self._x_cols())
        pairs = self._pairs()
        sums = ["COUNT(*)" if i == 0 and j == 0 else f"SUM(gd_x{j})" if i == 0 else f"SUM(gd_x{i} * gd_x{j})" for i, j in pairs]
        sums += ["SUM(gd_y)" if i == 0 else f"SUM(gd_x{i} * gd_y)" for i in range(k)] + ["SUM(gd_y * gd_y)"]
        r = self.run("train", "One pass over every training row: the normal equations", f"SELECT {_aliased(sums)} FROM ({s0}) gd_a")[0]
        vals = [float(v or 0) for v in r]
        XtX = np.zeros((k, k))
        for n, (i, j) in enumerate(pairs):
            XtX[i, j] = XtX[j, i] = vals[n]
        n = len(pairs)
        Xty = np.array(vals[n:n + k])
        yty = vals[n + k]
        cnt = max(1.0, XtX[0, 0])
        A = XtX + ridge * cnt * np.eye(k)
        try:
            beta = np.linalg.solve(A, Xty)
        except np.linalg.LinAlgError as e:
            raise PushdownError("The columns are too closely tied to each other to solve - leave out duplicates and train again.") from e
        rss = max(0.0, yty - 2 * beta @ Xty + beta @ XtX @ beta)
        sigma2 = rss / max(1.0, cnt - k)
        cov = sigma2 * np.linalg.pinv(A)
        return {"beta": beta, "cov": cov, "history": [{"step": 1, "rmse": math.sqrt(rss / cnt)}], "converged": True, "train_rmse": math.sqrt(rss / cnt),
                "graded": None, "warm": None, "resumed": 0, "full_passes": 1}

    # -------------------------------------------------------------- 6. grading
    def grade_binary(self, beta: np.ndarray) -> dict:
        d = self.d
        s0 = self._rows("test", self._x_cols() + [f"{self.raw_z(beta)} AS gd_r"])
        s1 = f"SELECT gd_y, gd_r, {self._eta(beta)} AS gd_z FROM ({s0}) gd_a{d.fence()}"
        s2 = f"SELECT gd_y, {_sigmoid_sql('gd_z')} AS gd_p, {_sigmoid_sql('gd_r')} AS gd_q FROM ({s1}) gd_b{d.fence()}"
        s3 = (f"SELECT gd_y, gd_p, gd_q, CASE WHEN gd_p >= 1.0 THEN {BUCKETS - 1} ELSE {d.to_int(f'FLOOR(gd_p * {BUCKETS})')} END AS gd_bucket "
              f"FROM ({s2}) gd_c{d.fence()}")
        sql = (f"SELECT gd_bucket, COUNT(*) AS gd_n, SUM(gd_y) AS gd_pos, SUM(gd_y * {d.ln('gd_p')} + (1.0 - gd_y) * {d.ln('1.0 - gd_p')}) AS gd_ll, "
               f"MAX(ABS(gd_q - gd_p)) AS gd_gap FROM ({s3}) gd_e GROUP BY gd_bucket")
        rows = self.run("grade", "Score every held-out row in the database: a 1,000-bucket histogram (and the SQL checked against the model)", sql)
        g = binary_metrics([(int(r[0]), float(r[1] or 0), float(r[2] or 0), float(r[3] or 0)) for r in rows])
        g["agree"] = {"rows": g["test_rows"], "max_diff": max([float(r[4] or 0) for r in rows] or [0.0]), "where": "held-out rows, inside the database"}
        return g

    def grade_number(self, beta: np.ndarray, prof: dict) -> dict:
        d = self.d
        lo = prof["y_mean"] - 2.5 * (prof["y_sd"] or 1.0)
        width = 5 * (prof["y_sd"] or 1.0) / 20
        s0 = self._rows("test", self._x_cols() + [f"{self.raw_z(beta)} AS gd_r"])
        s1 = f"SELECT gd_y, gd_r, {self._eta(beta)} AS gd_h FROM ({s0}) gd_a{d.fence()}"
        b = d.to_int(f"FLOOR((gd_h - {_f(lo)}) / {_f(width)})")
        s2 = (f"SELECT gd_y, gd_h, gd_r, CASE WHEN gd_h < {_f(lo)} THEN 0 WHEN gd_h >= {_f(lo + 20 * width)} THEN 19 ELSE {b} END AS gd_bucket "
              f"FROM ({s1}) gd_b{d.fence()}")
        sql = ("SELECT gd_bucket, COUNT(*) AS gd_n, SUM(gd_y) AS gd_sy, SUM(gd_y * gd_y) AS gd_syy, SUM(gd_h) AS gd_sh, "
               "SUM((gd_y - gd_h) * (gd_y - gd_h)) AS gd_sse, "
               f"SUM(ABS(gd_y - gd_h)) AS gd_sae, MAX(ABS(gd_r - gd_h)) AS gd_gap FROM ({s2}) gd_c GROUP BY gd_bucket")
        rows = self.run("grade", "Score every held-out row in the database: errors, predicted-vs-actual bands (and the SQL checked against the model)", sql)
        g = number_metrics([tuple(float(x or 0) for x in r[:7]) for r in rows], lo, width)
        g["agree"] = {"rows": g["test_rows"], "max_diff": max([float(r[7] or 0) for r in rows] or [0.0]), "where": "held-out rows, inside the database"}
        return g

    # -------------------------------------------------------------- 7. proof on made-up rows
    def synthetic_check(self, glm: "SqlGLM", out_col: str) -> dict:
        """Runs the scoring SQL on a dozen made-up rows (never the customer's:
        values built from the model's own means, spreads and categories) and
        scores the same rows in Python - the numbers must match."""
        rows = synthetic_rows(glm)
        d = self.d
        classes = _term_classes(glm)
        selects = []
        for i, row in enumerate(rows):
            parts = []
            for c, cls in classes.items():
                v = row.get(c)
                if cls == "num":
                    parts.append(f"{d.num(_f(v)) if v is not None else d.num('NULL')} AS {d.ident(c)}")
                elif cls == "date":
                    parts.append(f"{d.ts_lit(v)} AS {d.ident(c)}")
                else:
                    parts.append(f"{d.txt(d.lit(v)) if v is not None else d.txt('NULL')} AS {d.ident(c)}")
            parts.append(f"{i} AS gd360_i")
            selects.append("SELECT " + ", ".join(parts))
        rel = "(" + " UNION ALL ".join(selects) + ")"
        sql = scoring_sql(d, glm, rel, out_col)["select"]
        got = self.run("sql", f"Score {len(rows)} made-up rows (not your data) with the deployable SQL", sql)
        cols = list(self.last_columns)
        df = pd.DataFrame(got, columns=cols)
        if not len(df):
            return {"rows": 0, "max_diff": None}
        df = df.sort_values("gd360_i").reset_index(drop=True)
        X = pd.DataFrame(rows)
        for c, cls in classes.items():
            if cls == "date":
                X[c] = pd.to_datetime(X[c], errors="coerce")
        mine = glm.predict_proba(X)[:, 1] if glm.kind == "binary" else glm.decision(X)
        theirs = pd.to_numeric(df[out_col], errors="coerce").to_numpy(dtype=float)
        return {"rows": int(len(df)), "max_diff": float(np.nanmax(np.abs(mine - theirs))), "where": "made-up rows, in SQL and in Python"}

    # -------------------------------------------------------------- the model, out
    def glm(self, beta: np.ndarray) -> "SqlGLM":
        des = self.design
        feats = list(dict.fromkeys(t["col"] for t in des.terms))
        clean_terms = [{k: v for k, v in t.items() if k != "var"} for t in des.terms]
        return SqlGLM(kind="binary" if self.kind == "binary" else "number", features=feats,
                      numeric={c: list(v) for c, v in des.numeric.items()},
                      categories={c: {"levels": list(i["levels"]), "top": list(i["top"]), "other": bool(i["other"]), "reference": i["reference"]}
                                  for c, i in des.categories.items()},
                      beta=[float(b) for b in beta], names=list(des.names), positive=self.positive, negative=self.negative,
                      terms=clean_terms, dialect=self.d.d)


def _term_classes(glm: SqlGLM) -> dict[str, str]:
    out: dict[str, str] = {}
    for t in glm.all_terms():
        b = t.get("base", t["t"])
        cls = "num" if b == "num" else "date" if b == "date" else "cat" if t["t"] in ("lvl", "other", "rate") else None
        if cls:
            out[t["col"]] = cls
        else:
            out.setdefault(t["col"], "num")
    return out


def synthetic_rows(glm: SqlGLM, n: int = 12) -> list[dict]:
    """Made-up rows that reach every branch of the model: empty values, every
    kept category value, an unseen one, numbers past the curve's clip."""
    classes = _term_classes(glm)
    spread = [None, -2.0, -1.0, -0.5, 0.0, 0.5, 1.0, 2.0, 3.0, -3.0, 6.5, 0.25]
    rows = []
    for i in range(n):
        row = {}
        for c, cls in classes.items():
            k = spread[i % len(spread)]
            if cls == "num":
                t = next(t for t in glm.all_terms() if t["col"] == c and t["t"] in ("num", "sq"))
                row[c] = None if k is None else round(t["mu"] + k * t["sd"], 6)
            elif cls == "date":
                t = next(t for t in glm.all_terms() if t["col"] == c and t["t"] in ("date", "sq"))
                row[c] = None if k is None else _iso_day(round((t["ref"] - (t["mu"] + k * t["sd"])) * 86400) / 86400)
            else:
                vals: list = []
                for t in glm.all_terms():
                    if t["col"] != c:
                        continue
                    if t["t"] == "lvl":
                        vals.append(t["level"])
                    elif t["t"] == "other":
                        vals += list(t["top"][:1])
                    elif t["t"] == "rate":
                        vals += list(t["map"])[:6]
                vals = list(dict.fromkeys(vals)) + ["gd360 unseen value", None]
                row[c] = vals[i % len(vals)]
        rows.append(row)
    return rows


# ------------------------------------------------------------------ the model as SQL

def raw_terms(d: Dialect, glm: SqlGLM) -> tuple[float, list[tuple[str, float, str]]]:
    """(intercept, [(term, coefficient, SQL)]) in the original units: what the
    scoring SQL multiplies. A missing number counts as the training mean, a
    missing category as the most common one - the same as in training."""
    beta = list(glm.beta)
    b0 = float(beta[0])
    out = []
    for i, t in enumerate(glm.all_terms(), start=1):
        b = float(beta[i])
        if t["t"] in ("num", "date"):
            coef = b / (t["sd"] or 1.0)
            b0 -= coef * t["mu"]
            out.append((term_name(t), coef, f"COALESCE({_x_sql(d, t)}, {_f(t['mu'])})"))
        elif t["t"] == "rate":
            coef = b / (t["sd"] or 1.0)
            b0 -= coef * t["mu"]
            out.append((term_name(t), coef, _rate_case(d, t)))
        else:
            out.append((term_name(t), b, term_sql(d, t, ints=True)))
    return b0, out


def scoring_sql(d: Dialect, glm: SqlGLM, rel: str, out_col: str) -> dict:
    """The deployable model: a SELECT, a view and a dbt model, each ONE
    statement that scores every row where it lives."""
    b0, terms = raw_terms(d, glm)
    z = "\n".join([f"      {_f(b0)}"] + [f"    + ({_f(b)}) * {t}" for _, b, t in terms])
    if glm.kind == "binary":
        zc = f"CASE WHEN gd360_z > {_f(Z_CLAMP)} THEN {_f(Z_CLAMP)} WHEN gd360_z < {_f(-Z_CLAMP)} THEN {_f(-Z_CLAMP)} ELSE gd360_z END"
        outer = f"1.0 / (1.0 + EXP(-({zc})))"
    else:
        outer = "gd360_z"
    col = d.ident(out_col)
    select = f"SELECT gd360_t.*, {outer} AS {col}\nFROM (\n  SELECT gd360_s.*,\n{z}\n    AS gd360_z\n  FROM {rel} gd360_s\n) gd360_t"
    view_name = f"gd360_models.{re.sub(r'[^a-z0-9_]+', '_', out_col.lower())[:60]}"
    create = "CREATE OR ALTER VIEW" if d.d == "tsql" else "CREATE OR REPLACE VIEW"
    view = f"{create} {d.path(view_name)} AS\n{select}"
    dbt = ("{{ config(materialized='view') }}\n-- A GD360 model, trained in the database. Point the FROM at your dbt source() or ref().\n" + select)
    return {"dialect": d.d, "engine": ENGINE_WORDS.get(d.d if d.d != "tsql" else "sqlserver", d.d), "select": select, "view": view, "dbt": dbt,
            "column": out_col, "view_name": view_name, "terms": len(terms)}


def check_sql(d: Dialect, glm: SqlGLM, rel: str, out_col: str) -> str:
    """A read-only run of the scoring SQL over every row: how many it scores
    and how the scores spread."""
    col = d.ident(out_col)
    sel = scoring_sql(d, glm, rel, out_col)["select"]
    if glm.kind == "binary":
        b = f"CASE WHEN {col} >= 1.0 THEN 9 ELSE {d.to_int(f'FLOOR({col} * 10)')} END"
        return (f"SELECT gd_b, COUNT(*) AS gd_n, AVG({col}) AS gd_avg FROM (SELECT {col}, {b} AS gd_b FROM ({sel}) gd_x) gd_y "
                "GROUP BY gd_b")
    return f"SELECT COUNT(*) AS gd_n, AVG({col}) AS gd_avg, MIN({col}) AS gd_min, MAX({col}) AS gd_max FROM ({sel}) gd_x"


def python_code(glm: SqlGLM, title: str, engine: str, rows: int, positive) -> str:
    """The model in plain Python - the same numbers the SQL multiplies, so
    anyone can score a row by hand and check it."""
    binary = glm.kind == "binary"
    terms = [{k: v for k, v in t.items() if k != "var"} for t in glm.all_terms()]
    return "\n".join([
        "# " + (title or "ML project"),
        f"# {'Logistic' if binary else 'Linear'} regression trained inside {engine} on {int(rows or 0):,} rows.",
        "# These are the exact numbers the scoring SQL uses: a row's score is the same here and in the database.",
        "import math", "from datetime import datetime, timezone", "",
        f"terms = {json.dumps(terms, default=str)}",
        f"weights = {json.dumps([round(float(b), 12) for b in glm.beta])}  # the intercept, then one per term", "",
        "def _days(v):  # a date as days since 1970-01-01",
        "    t = v if isinstance(v, datetime) else datetime.fromisoformat(str(v))",
        "    if t.tzinfo:",
        "        t = t.astimezone(timezone.utc).replace(tzinfo=None)",
        "    return (t - datetime(1970, 1, 1)).total_seconds() / 86400",
        "",
        "def _text(v):",
        "    if v is None: return None",
        "    if isinstance(v, bool): return 'true' if v else 'false'",
        "    if isinstance(v, float) and v.is_integer(): return str(int(v))",
        "    return str(v)",
        "",
        "def score(row: dict) -> float:",
        "    z = weights[0]",
        "    for w, t in zip(weights[1:], terms):",
        "        v, kind = row.get(t['col']), t['t']",
        "        if kind in ('num', 'date', 'sq'):",
        "            x = None if v is None else (t['ref'] - _days(v) if t.get('base', kind) == 'date' else float(v))",
        "            s = 0.0 if x is None else (x - t['mu']) / t['sd']  # a missing value counts as the mean",
        "            if kind == 'sq':",
        f"                s = max(-{CURVE_CLIP}, min({CURVE_CLIP}, s)) ** 2 - 1.0",
        "        elif kind == 'miss':",
        "            s = 1.0 if v is None else 0.0",
        "        elif kind == 'lvl':",
        "            s = 1.0 if _text(v) == t['level'] else 0.0",
        "        elif kind == 'other':",
        "            s = 1.0 if v is not None and _text(v) not in t['top'] else 0.0",
        "        else:  # 'rate': the smoothed outcome rate of the value",
        "            s = (t['map'].get(_text(v), t['prior']) - t['mu']) / t['sd']",
        "        z += w * s",
        ("    return 1.0 / (1.0 + math.exp(-max(-30.0, min(30.0, z))))  # the chance of " + json.dumps(positive) if binary else "    return z"),
    ])


# ------------------------------------------------------------------ metrics from histograms

def binary_metrics(buckets: list[tuple[int, float, float, float]]) -> dict:
    """ROC AUC (ties within a bucket counted half), the ROC and
    precision-recall curves, average precision, calibration by tenths, lift
    at 1/5/10/20% and the log loss - all from the per-bucket counts the
    database returned."""
    if not buckets:
        raise PushdownError("No held-out rows to grade on.")
    b = np.array(sorted(buckets), dtype=float)
    idx, n, pos, ll = b[:, 0], b[:, 1], b[:, 2], b[:, 3]
    neg = n - pos
    P, N, total = pos.sum(), neg.sum(), n.sum()
    if P == 0 or N == 0:
        raise PushdownError("The held-out rows are all one outcome - grading needs both.")
    neg_below = np.cumsum(neg) - neg
    auc = float((pos * (neg_below + 0.5 * neg)).sum() / (P * N))
    # ROC from the highest scores down, sampled on a fixed grid
    order = slice(None, None, -1)
    tp = np.cumsum(pos[order])
    fp = np.cumsum(neg[order])
    tpr = np.concatenate([[0.0], tp / P])
    fpr = np.concatenate([[0.0], fp / N])
    grid = np.linspace(0, 1, 21)
    roc = [[float(x), float(np.interp(x, fpr, tpr))] for x in grid]
    # precision-recall: one point per bucket, highest scores first
    prec = tp / np.maximum(tp + fp, 1e-12)
    rec = tp / P
    ap = float(np.sum(np.diff(np.concatenate([[0.0], rec])) * prec))
    pr = []
    for x in grid[1:]:
        j = int(np.searchsorted(rec, x - 1e-12))
        pr.append([float(x), float(prec[min(j, len(prec) - 1)])])
    # lift: the outcome rate among the top k% of rows (a bucket split pro rata)
    cum = np.cumsum(n[order])
    rate = P / total

    def top_rate(share: float) -> float:
        want = share * total
        before = np.concatenate([[0.0], cum[:-1]])
        take = np.clip(want - before, 0, n[order])
        got = take.sum()
        return float((pos[order] * np.divide(take, n[order], out=np.zeros_like(take), where=n[order] > 0)).sum() / got) if got else 0.0
    lift = [{"top": s, "rate": top_rate(s), "lift": top_rate(s) / rate if rate else None} for s in (0.01, 0.05, 0.1, 0.2)]
    top_hit = next(x["rate"] for x in lift if x["top"] == 0.1)
    # calibration: ten groups of rows, lowest scores first
    mids = (idx + 0.5) / BUCKETS
    cal, acc, grp = [], np.zeros(3), 0
    cum_n = np.cumsum(n)
    for i in range(len(n)):
        acc += (mids[i] * n[i], n[i], pos[i])
        if cum_n[i] >= (grp + 1) * total / 10 or i == len(n) - 1:
            if acc[1]:
                cal.append({"predicted": float(acc[0] / acc[1]), "actual": float(acc[2] / acc[1]), "rows": int(acc[1])})
            acc, grp = np.zeros(3), grp + 1
    base_ll = -(rate * math.log(rate) + (1 - rate) * math.log(1 - rate))
    step = max(1, len(idx) // 200)
    return {"auc": auc, "top10_hit": top_hit, "rate": float(rate), "test_rows": int(total), "positives": int(P),
            "log_loss": float(-ll.sum() / total), "baseline_log_loss": float(base_ll), "roc": roc, "pr": pr, "average_precision": ap,
            "calibration": cal, "lift": lift, "lift_top10": float(top_hit / rate) if rate else None,
            "histogram": [{"bucket": int(i), "rows": int(c), "positives": int(p)} for i, c, p in zip(idx[::step], n[::step], pos[::step])]}


def number_metrics(rows: list[tuple], lo: float, width: float) -> dict:
    if not rows:
        raise PushdownError("No held-out rows to grade on.")
    a = np.array(sorted(rows), dtype=float)
    n, sy, syy, sh, sse, sae = (a[:, i].sum() for i in range(1, 7))
    if n < 2:
        raise PushdownError("Too few held-out rows to grade on.")
    mean = sy / n
    sst = syy - n * mean * mean
    r2 = float(1 - sse / sst) if sst > 0 else 0.0
    buckets = [{"from": float(lo + int(r[0]) * width), "to": float(lo + (int(r[0]) + 1) * width), "rows": int(r[1]),
                "actual": float(r[2] / r[1]) if r[1] else None, "predicted": float(r[4] / r[1]) if r[1] else None} for r in a]
    return {"r2": r2, "mae": float(sae / n), "rmse": float(math.sqrt(sse / n)), "test_rows": int(n), "mean": float(mean),
            "buckets": buckets}


def out_column(kind: str, target: str, positive: str | None) -> str:
    base = f"chance_{target}_{positive}" if kind == "binary" else f"predicted_{target}"
    return re.sub(r"[^A-Za-z0-9_]+", "_", base).strip("_")[:60] or "gd360_score"


# ------------------------------------------------------------------ the plan: what the catalog says, what a run costs

def catalog_columns(types: dict, spec: dict, hidden: set | None = None) -> dict:
    """The plan's view of the columns from the catalog alone (the run counts
    them in the database): numbers, dates, categories and what is left out."""
    target, tcol = spec.get("target"), spec.get("time_column")
    exclude = set(spec.get("exclude") or [])
    out = {"numbers": [], "dates": [], "categories": [], "left_out": []}
    for c, typ in types.items():
        if c == target or c in (hidden or set()) or c in exclude:
            continue
        cls, why = type_class(typ)
        if cls == "skip":
            out["left_out"].append({"column": c, "reason": why})
        elif cls == "date":
            if c != tcol:
                out["dates"].append(c)
        elif cls == "num":
            if _ID_NAME.search(str(c)):
                out["left_out"].append({"column": c, "reason": "Named like an id - checked by its distinct values in the run."})
            else:
                out["numbers"].append(c)
        else:
            out["categories"].append(c)
    return out


# rows per second for one training pass (a few hundred SUMs per row): measured on this round's test engines
# (DuckDB 1M/s, PostgreSQL 16 120k/s, MariaDB 20k/s on one core); the warehouses from their usual scale-out
_ROWS_PER_SECOND = {"duckdb": 1e6, "postgres": 1.2e5, "mysql": 2e4, "tsql": 3e5, "snowflake": 1e7, "bigquery": 2.5e7}
_PASS_OVERHEAD = {"duckdb": 0.05, "postgres": 0.2, "mysql": 0.2, "tsql": 0.3, "snowflake": 1.5, "bigquery": 2.5}


def planned_passes(ptype: str, rows: int, timed: bool) -> float:
    """Full-table scans a run needs: scan, profile, levels (+ the date
    histogram), then training and grading."""
    base = 3 + (1 if timed else 0)
    if ptype == "number":
        return base + 2
    if rows >= WARM_ROWS * 1.25:
        return base + 2.5 + 6 * min(0.5, WARM_TARGET / max(1, rows))   # warm start on a sample, then 2-3 passes (the last also grades)
    return base + 6.0


def estimate(db, user, spec: dict, ptype: str, rows: int, entry: dict, ds, live: bool) -> dict:
    """What a run will cost before it starts: passes, time, and - on
    BigQuery - the bytes it will scan (a dry run of one pass, times the
    passes). Says whether it is over the per-run limit or today's budget."""
    from ..config import get_settings
    s = get_settings()
    d = Dialect(ds.kind if live else "duckdb")
    tcol = spec.get("time_column")
    timed = bool(tcol) and any(c["name"] == tcol and type_class(str(c.get("type") or ""))[0] == "date" for c in entry.get("columns") or [])
    passes = planned_passes(ptype, rows, timed)
    secs = passes * (_PASS_OVERHEAD[d.d] + rows / _ROWS_PER_SECOND[d.d])
    out: dict = {"passes": round(passes, 1), "seconds": round(secs, 1), "bytes": None, "cap_gb": float(s.ML_SQL_MAX_GB_PER_RUN or 0),
                 "over_cap": False, "budget_left": None, "over_budget": False, "rows": rows}
    if live and ds.kind == "bigquery":
        try:
            from . import ml_data as md
            from . import warehouse_exec
            hidden, _rules = md.access_rules(db, ds, user)
            cols = [c["name"] for c in entry.get("columns") or [] if c["name"] not in hidden and type_class(str(c.get("type") or ""))[0] != "skip"]
            one = warehouse_exec.describe_sql(ds, f"SELECT {', '.join(d.ident(c) for c in cols) or '*'} FROM {_source_rel(ds, entry.get('key') or entry['table'])}")[1]
            if one:
                out["bytes"] = int(one * passes)
                out["bytes_per_pass"] = int(one)
        except Exception as e:  # noqa: BLE001 - an estimate that can't run never blocks the plan
            logger.info("[ml_pushdown] dry run for the estimate failed: %s", e)
    if live and ds.kind in ("bigquery", "snowflake"):
        try:
            from .pushdown_budget import todays_pushdown_bytes
            out["budget_left"] = max(0, int(s.PUSHDOWN_MAX_BYTES_SCANNED_PER_DAY_PER_USER) - int(todays_pushdown_bytes(db, user.id)))
        except Exception:  # noqa: BLE001
            pass
    if out["bytes"] is not None:
        if out["cap_gb"] and out["bytes"] > out["cap_gb"] * 1e9:
            out["over_cap"] = True
        if out["budget_left"] is not None and out["bytes"] > out["budget_left"]:
            out["over_budget"] = True
    mins = secs / 60
    when = "under a minute" if mins < 1 else f"about {mins:,.0f} minute{'s' if round(mins) != 1 else ''}" if mins < 90 else f"about {mins / 60:,.1f} hours"
    out["text"] = (f"{when} · " + (f"about {_gb(out['bytes'])} scanned · " if out["bytes"] is not None else "")
                   + f"about {round(passes)} passes over the table")
    if out["over_cap"]:
        out["why"] = (f"This run would scan about {_gb(out['bytes'])}, over the {out['cap_gb']:,.0f} GB per-run limit. "
                      "An admin can raise ML_SQL_MAX_GB_PER_RUN - or train on a sample.")
    elif out["over_budget"]:
        out["why"] = (f"This run would scan about {_gb(out['bytes'])}; today's scan budget has {_gb(out['budget_left'])} left. "
                      "Train tomorrow, ask an admin to raise the daily budget - or train on a sample.")
    return out


def _gb(b: float | None) -> str:
    if b is None:
        return "—"
    if b < 1e9:
        return f"{b / 1e6:,.0f} MB"
    return f"{b / 1e9:,.1f} GB"


# ------------------------------------------------------------------ where a run can train

def routes(ptype: str | None, spec: dict, data: dict, rows_total: int, budget_rows: int, label_kind: str | None = None,
           est: dict | None = None) -> dict:
    """The two places a yes/no or number model can train, for the plan page:
    in the database (every row, where it lives) or on a fair sample in
    GD360 (tuned boosting, forest and linear). Says why when one can't."""
    src = data.get("source") or {}
    kind, mode = src.get("kind"), src.get("mode")
    where = ENGINE_WORDS.get(kind, kind) if mode == "live" else ENGINE_WORDS["duckdb"]
    why = None
    if ptype not in SUPPORTED_TYPES:
        why = "In-database training covers yes/no outcomes and numbers."
    elif label_kind == "multiclass":
        why = "The outcome has more than two values - in-database training predicts two. Group them into two in a view, or train on a sample."
    elif spec.get("joins"):
        why = "Joined tables are combined in GD360's sandbox - in-database training reads one table. Make the join a view in your database, or train on a sample."
    elif mode == "live" and kind not in SQL_KINDS:
        why = f"{ENGINE_WORDS.get(kind, kind)} can't run the training SQL."
    elif mode == "live" and (spec.get("prep_sql") or "").strip():
        why = "Your data step runs in GD360's sandbox, not in the warehouse. Make it a view in the warehouse and train on that view - or train on a sample."
    elif est and est.get("why"):
        why = est["why"]
    sampled = rows_total > budget_rows
    sql_ok = why is None
    # a live warehouse: train where the rows live (they never leave). A file or an app GD360 already holds: the tuned
    # sample run is usually the more accurate model, so it stays the default and every-row SQL is one click away.
    recommended = "sql" if sql_ok and mode == "live" else "sample"
    rows_txt = f"{rows_total:,}"
    return {
        "recommended": recommended,
        "sql": {"available": sql_ok, "why": why, "where": where, "live": mode == "live", "estimate": est,
                "title": f"Train inside {where}" if mode == "live" else "Train on every row, in SQL",
                "text": (f"Every one of the {rows_txt} rows, read where it lives. Each step is one SELECT that returns sums and counts - "
                         "not one row leaves." if mode == "live" else
                         f"Every one of the {rows_txt} rows, in GD360's DuckDB sandbox - no sample. Each step is one SELECT that returns sums and counts."),
                "model": "Logistic regression" if ptype == "yes_no" else "Linear regression",
                "gives": ("ROC, precision-recall, calibration, lift and coefficients with confidence intervals - graded on held-out rows "
                          "(the newest 20% when there is a date) - and the model as SQL to run in your own database")},
        "sample": {"available": True, "where": "GD360",
                   "title": "Train on a fair sample" if sampled else "Train in GD360",
                   "text": (f"A fair sample of {budget_rows:,} of the {rows_txt} rows, with the outcome's balance kept." if sampled
                            else f"All {rows_txt} rows, read into GD360."),
                   "model": "Gradient boosting, random forest and a linear model, tuned",
                   "gives": "The most accurate of three models, with drivers and reasons per row"},
    }


# ------------------------------------------------------------------ one run

def _open_source(db, user, spec: dict, bench) -> tuple[Source, dict]:
    """The Source a run trains on: the warehouse table itself, or the
    snapshot (and the person's data step) in the run's DuckDB bench."""
    from . import ml_data as md
    from .. import models
    from .ml_studio import StudioError, _table_entry
    if spec.get("joins"):
        raise StudioError("In-database training reads one table - joined tables run on a sample. Train on a sample, or make the join a view in your database.")
    entry = _table_entry(db, user, spec["source_id"], spec.get("table"))
    ds = db.get(models.DataSource, spec["source_id"])
    try:
        snap = md.snapshot(db, ds, entry)
    except md.DataError as e:
        raise StudioError(str(e)) from e
    info = {"name": entry["source"], "table": entry["table"], "kind": ds.kind, "mode": snap.mode, "key": entry.get("key") or entry["table"]}
    if snap.mode == "live":
        if ds.kind not in SQL_KINDS:
            raise StudioError(f"{ENGINE_WORDS.get(ds.kind, ds.kind)} can't run the training SQL - train on a sample instead.")
        if (spec.get("prep_sql") or "").strip():
            raise StudioError("Your data step runs in GD360's sandbox, not in the warehouse - make it a view in the warehouse and train on that view, or train on a sample.")
        info["how"] = f"{ENGINE_WORDS.get(ds.kind, ds.kind)} runs every pass; only sums and counts come back"
        return warehouse_source(db, user, ds, entry.get("key") or entry["table"], entry["columns"]), info
    view = "source"
    try:
        bench.attach(db, user, snap, "source")
        bench.lock()
        if (spec.get("prep_sql") or "").strip():
            view = "model"
            md.run_select(bench, spec["prep_sql"], {"source"}, out_view="model", step="prepare", title="The table the model learns from (your SQL)")
    except md.DataError as e:
        raise StudioError(f"The data step's SQL didn't run: {e}" if view == "model" else str(e)) from e
    info["how"] = "every row of the snapshot, in GD360's DuckDB sandbox" + (" (after your data step)" if view == "model" else "")
    info["prep"] = view == "model"
    return duck_source(bench, view, entry.get("key") or entry["table"]), info


def _visual_line(title: str, x: list, series: list[dict], fmt: str = "number", note: str | None = None) -> dict:
    out = {"type": "line", "title": title, "x": [str(v) for v in x], "series": series, "format": fmt}
    if note:
        out["note"] = note
    return out


def _pass_code(passes: list[Pass], step: str, engine: str, limit: int = 6) -> list[dict]:
    got = [p for p in passes if p.step == step]
    if len(got) > limit:   # the first and the last few: the rest are the same statement with new numbers
        got = got[:2] + got[-(limit - 2):]
    return [{"title": p.title, "lang": "sql", "engine": engine, "code": p.sql + ";", "rows": p.rows_back, "seconds": p.seconds,
             "note": f"{p.bytes_back:,} bytes came back" + (f" · {p.scanned / 1e6:,.1f} MB scanned" if p.scanned else "")} for p in got]


def _set_stage_visual(job, sid: str, visual: list[dict], note: str | None = None) -> None:
    from . import ml_studio_methods as _m
    p = job.progress
    for s_ in p.get("stages") or []:
        if s_["id"] == sid:
            s_["visual"] = _m.clean(visual[:8])
            if note:
                s_["note"] = note
    job.save(stages=p.get("stages"))


def train(db, job, user, spec: dict) -> None:
    """Trains a yes/no or number model inside the database and fills the
    project's results. Raises StudioError with a plain sentence."""
    from . import ml_data as md
    from . import ml_studio as st
    from . import ml_studio_methods as _m
    try:
        with md.Bench() as bench:
            _train(db, job, user, spec, bench, st, _m)
    except PushdownError as e:
        raise st.StudioError(str(e)) from e


def _use_words(m: dict) -> str:
    u = m.get("use") or "left out"
    if u == "left out":
        return "left out"
    if u == "fair test":
        return "the fair test"
    if not m.get("in_model"):
        return "left out"
    return {"number": "number", "date": "date (days before the newest)", "category": "category", "rate": "outcome rate per value"}.get(u, u)


def _train(db, job, user, spec, bench, st, _m) -> None:
    from ..config import get_settings
    m = job.m
    ptype = spec.get("problem_type")
    if ptype not in SUPPORTED_TYPES:
        raise st.StudioError("In-database training covers yes/no outcomes and numbers - train this one on a sample.")
    t_start = time.time()
    job.stage("data", "running", "Reading the table where it lives…")
    job.save(message="Opening the table where it lives…")
    src, info = _open_source(db, user, spec, bench)
    d = src.dialect
    engine = src.where_words
    target = spec.get("target")
    if not target:
        raise st.StudioError("Pick the column to predict.")
    if target in src.hidden:
        raise st.StudioError(f"You can't see {target} in this source, so you can't train on it.")
    live_info: dict = {"live": info["mode"] == "live"}
    passes: list[Pass] = []

    def on_pass(p: Pass) -> None:
        passes.append(p)
        job.save(message=f"{p.title} · {p.seconds:.1f} s · {p.bytes_back:,} bytes back",
                 pushdown={"engine": engine, "dialect": d.d, "passes": len(passes), "bytes_back": sum(x.bytes_back for x in passes),
                           "model_bytes": sum(x.bytes_back for x in passes if x.step in ("scan", "profile", "train", "grade")),
                           "rows_out": sum(x.rows_back for x in passes if x.row_level),
                           "seconds": round(sum(x.seconds for x in passes), 2), "scanned": sum(x.scanned or 0 for x in passes) or None,
                           **live_info})

    kind = "binary" if ptype == "yes_no" else "number"
    tr = Trainer(src, kind=kind, target=target, on_pass=on_pass, check_stop=job.check_stop)
    cap_gb = float(get_settings().ML_SQL_MAX_GB_PER_RUN or 0)
    if info["mode"] == "live" and src.kind in ("bigquery", "snowflake") and cap_gb > 0:
        tr.cap_bytes = cap_gb * 1e9

    # 1. the label, then every column counted where it lives
    vals: list[tuple[str, int]] = []
    if kind == "binary":
        vals = tr.label_values()
        if len(vals) < 2:
            raise st.StudioError(f"{target} has only one value in this data, so there is nothing to tell apart.")
        if len(vals) > 2:
            raise st.StudioError(f"{target} has {len(vals) if len(vals) < 25 else '25+'} different values - in-database training predicts two outcomes. "
                                 "Group them into two in a view, or train on a sample (which handles several categories).")
        names = [v for v, _ in vals]
        pos = spec.get("positive_value")
        if pos is None or str(pos) not in names:
            pos = st._positive_guess(names)
        tr.positive, tr.negative = str(pos), next(v for v in names if v != str(pos))
        label_info = {"target": target, "kind": "binary", "positive": tr.positive, "classes": names,
                      "rate": next(n for v, n in vals if v == tr.positive) / max(1, sum(n for _, n in vals))}
    else:
        label_info = {"target": target, "kind": "number"}
    job.save(message=f"Counting every column in {engine}…")
    tr.scan(spec)
    split = tr.time_split(spec.get("time_column"))
    job.save(message=f"Profiling the training rows in {engine}…")
    prof = tr.profile()
    live_info.update(rows=prof["rows"], train_rows=prof["train_rows"], test_rows=prof["test_rows"])
    if kind == "number":
        label_info.update(mean=prof["y_mean"], std=prof["y_sd"])
    else:
        label_info["rate"] = prof.get("rate", label_info["rate"])
    n_all, n_tr, n_te = prof["rows"], prof["train_rows"], prof["test_rows"]
    split_words = (f"Trained on rows before {split['cutoff_text']} (by {split['column']}), tested on the newest {100 - split['train_share'] * 100:.0f}% "
                   f"({split['cutoff_text']} → {split['newest_text']})" if split["how"] == "time" else
                   f"Trained on {n_tr:,} rows; tested on {n_te:,} held out by a fixed hash of {tr.key or 'the row values'}")
    data_code = [{"title": "Where the rows live", "lang": "sql", "engine": engine,
                  "code": f"-- {info['name']} · {info['table']}\n-- {info['how']}\n-- Every statement below ran inside {engine}; GD360 kept only the sums and counts each returned."}]
    data_code += _pass_code(tr.passes, "data", engine) + _pass_code(tr.passes, "scan", engine) + _pass_code(tr.passes, "profile", engine, limit=2)
    lab_vis = ({"type": "bars", "title": f"{target}: rows per outcome",
                "items": [{"label": v, "value": n, "note": "the outcome to predict" if v == tr.positive else ""} for v, n in vals]}
               if kind == "binary" else
               {"type": "kpis", "items": [{"label": f"{target}: average", "value": _m.num(prof["y_mean"])},
                                          {"label": "Spread (SD)", "value": _m.num(prof["y_sd"])}]})
    col_rows = [[c, mm.get("type") or "", (f"{mm['filled'] / max(1, n_all) * 100:.0f}%" if "filled" in mm else "—"),
                 (f"{mm['distinct']:,}" if "distinct" in mm else "—"), mm.get("use") or "left out"] for c, mm in tr.cols.items()][:60]
    job.stage("data", "done", f"{n_all:,} labelled rows read in {engine} · {len(tr.passes)} queries · "
                              f"{sum(p.bytes_back for p in tr.passes):,} bytes back · no row left {engine}",
              code=data_code,
              visual=[{"type": "funnel", "title": "Every row, where it lives",
                       "items": [{"label": f"Rows with a known {target}", "value": n_all},
                                 {"label": "Learned from" + (f" (before {split['cutoff_text']})" if split["how"] == "time" else " (80%, fixed by a hash)"), "value": n_tr},
                                 {"label": "Held out for grading" + (" (the newest rows)" if split["how"] == "time" else " (20%)"), "value": n_te}],
                       "note": (f"Nothing was sampled or copied: {engine} counted every row. "
                                + (f"The newest rows by {split['column']} are held out, so the test is the future the model hasn't seen."
                                   if split["how"] == "time" else
                                   f"The split is a hash of {tr.key or 'the row values'}, so the same rows are held out on every run.")
                                + (" " + split["note"] if split.get("note") else ""))},
                      {"type": "kpis", "items": [
                          {"label": "Rows read in place", "value": n_all, "tone": "good"},
                          {"label": "Customer rows out", "value": 0, "tone": "good", "note": "only sums and counts came back"},
                          {"label": "Queries so far", "value": len(tr.passes)},
                          {"label": "Where", "value": engine}]},
                      lab_vis,
                      {"type": "table", "title": "Every column, profiled inside the database",
                       "columns": ["Column", f"Type in {engine}", "Filled", "Distinct values", "Used as"], "rows": col_rows}])
    job.check_stop()

    # 2. the columns: levels, the leak check, the model's terms
    job.stage("features", "running", f"Most common values and the leak check, in {engine}")
    des = tr.features()
    leaks, left_out = tr.leaks, tr.left_out
    feat_rows = []
    for c, v in des.numeric.items():
        st_ = prof["numeric"][c]
        feat_rows.append([c, "number", f"mean {_m.num(v[0])} · SD {_m.num(v[1])}" + (f" · {st_['miss'] * 100:.0f}% empty" if st_["miss"] >= MISS_MIN else ""),
                          "standardised in SQL" + ("; plus a curve" if any(t["t"] == "sq" and t["col"] == c for t in des.terms) else "")])
    for c, v in des.dates.items():
        feat_rows.append([c, "date", f"days before {v['ref_text']}", "standardised in SQL" + ("; plus a curve" if any(t["t"] == "sq" and t["col"] == c for t in des.terms) else "")])
    for c, i_ in des.categories.items():
        feat_rows.append([c, "category", f"{len(i_['levels']) + 1} values kept" + (" + other" if i_["other"] else ""), f"compared with “{i_['reference']}”"])
    for c, i_ in des.rates.items():
        feat_rows.append([c, "category (wide)", f"{i_['values']:,} values · the {i_['levels']} most common get their own rate",
                          f"smoothed outcome rate (counts as {RATE_M:.0f} rows at the overall rate)"])
    flags = [t["col"] for t in des.terms if t["t"] == "miss"]
    if flags:
        feat_rows.append([", ".join(flags[:6]) + (" …" if len(flags) > 6 else ""), "empty flag", f"{len(flags)} column{'s' if len(flags) != 1 else ''}",
                          "being empty can carry signal of its own"])
    feat_rows += [[x["column"], "left out", "", x["reason"]] for x in (leaks + left_out)][:30]
    leak_vis = ({"type": "table", "title": "Leak check (inside the database)", "columns": ["Column", "Why it is left out", "How it was found"],
                 "rows": [[x["column"], x["reason"], x.get("how") or ""] for x in leaks]} if leaks else
                {"type": "note", "title": "Leak check (inside the database)",
                 "text": "No column gives the answer away: every number's correlation with the outcome, every column's empty-vs-filled link to it "
                         "and every category's outcome per value were computed as sums in the database."})
    job.stage("features", "done", f"{len(des.numeric)} numbers · {len(des.dates)} dates · {len(des.categories) + len(des.rates)} categories · "
                                  f"{len(des.names) - 1} model terms" + (f" · {len(leaks)} leak{'s' if len(leaks) != 1 else ''} removed" if leaks else ""),
              code=_pass_code(tr.passes, "profile", engine, limit=3)[-1:],
              visual=[{"type": "table", "title": "What the model can use", "columns": ["Column", "As", "From the data", "How"], "rows": feat_rows},
                      leak_vis,
                      {"type": "note", "title": "Why this is enough",
                       "text": f"{len(des.names)} numbers describe the whole model, so every training step is a {len(des.names)}×{len(des.names)} "
                               f"system GD360 solves in microseconds - the heavy lifting is the SUMs, and {engine} does those over every row."}])
    job.check_stop()

    # 3. training
    ckpt = (job.progress or {}).get("pushdown_ckpt")
    tr.on_ckpt = lambda state: job.save(pushdown_ckpt=state)
    job.stage("train", "running", f"Each step is one SELECT in {engine}")
    if kind == "binary":
        tr.on_step = lambda history: _set_stage_visual(job, "train", [
            _visual_line("Log loss after each Newton step", [h["step"] for h in history],
                         [{"name": "Log loss", "values": [h["log_loss"] for h in history]}], "number")
            if len(history) > 1 else
            {"type": "kpis", "items": [{"label": "Newton step", "value": 1}, {"label": "Log loss", "value": f"{history[0]['log_loss']:.5f}"},
                                       {"label": "Rows in the step", "value": history[0].get("rows")}]}],
            note=f"Step {len(history)}{' (sample)' if history[-1].get('sample') else ''}: log loss {history[-1]['log_loss']:.5f}")
        fit = tr.train_logistic(prof, ckpt=ckpt)
        hist = [h["log_loss"] for h in fit["history"]]
    else:
        fit = tr.train_linear(prof)
        hist = []
    beta, cov = fit["beta"], fit["cov"]
    se = np.sqrt(np.clip(np.diag(cov), 0, None))
    steps = len(fit["history"])
    train_passes = [p for p in tr.passes if p.step == "train"]
    full_passes = [p for p in train_passes if not p.title.startswith("Warm start")]
    warm = fit.get("warm")
    train_vis = []
    if kind == "binary":
        train_vis.append(_visual_line("Log loss after each Newton step", list(range(1, len(hist) + 1)),
                                      [{"name": "Log loss", "values": hist}], "number",
                                      note=("The first steps ran on a sample drawn by the engine; the last ones over every training row. "
                                            if warm else "Each point is one SELECT over every training row. ") + "It flattens when the model has settled."))
    train_vis.append({"type": "kpis", "items": [
        {"label": "Steps" if kind == "binary" else "Passes", "value": steps, "note": "converged" if fit["converged"] else "stopped at the step limit",
         "tone": "good" if fit["converged"] else None},
        {"label": "Passes over every row", "value": len(full_passes),
         "note": (f"after a warm start on a {warm['percent']:.3g}% sample ({warm['rows']:,} rows)" if warm else
                  f"went on from step {fit['resumed']} of the last run" if fit.get("resumed") else None)},
        {"label": "Time in the database", "value": f"{sum(p.seconds for p in train_passes):.1f} s"},
        {"label": "Bytes back per step", "value": f"{int(np.mean([p.bytes_back for p in train_passes])):,}" if train_passes else "—"}]})
    job.stage("train", "done", (f"{'Converged' if fit['converged'] else 'Stopped'} after {steps} step{'s' if steps != 1 else ''}"
                                + (f" ({fit['full_passes']} over every row)" if warm else "") + " · "
                                if kind == "binary" else "Solved in one pass · ") + f"{n_tr:,} training rows",
              code=_pass_code(tr.passes, "train", engine), visual=train_vis)
    job.check_stop()

    # 4. grading on the held-out rows (already done by the last pass when it converged)
    job.stage("test", "running", f"Scoring the held-out rows in {engine}")
    if kind == "binary":
        g = fit.get("graded") or tr.grade_binary(beta)
        score, second = g["auc"], g["top10_hit"]
        base_score = 0.5
        test_vis = [
            {"type": "kpis", "items": [
                {"label": "ROC AUC", "value": f"{g['auc']:.3f}", "tone": "good" if g["auc"] > 0.6 else None, "note": "0.5 = guessing"},
                {"label": "Hit rate in the top 10%", "value": f"{g['top10_hit'] * 100:.1f}%", "note": f"vs {g['rate'] * 100:.1f}% overall"},
                {"label": "Average precision", "value": f"{g['average_precision']:.3f}", "note": f"{g['rate']:.3f} = guessing"},
                {"label": "Held-out rows", "value": g["test_rows"]}]},
            _visual_line("ROC curve on held-out rows", [f"{x:.2f}" for x, _ in g["roc"]],
                         [{"name": "Model", "values": [y for _, y in g["roc"]]}, {"name": "Guessing", "values": [x for x, _ in g["roc"]], "dashed": True}],
                         "percent", note="Share of the real positives found (up) against the share of negatives wrongly flagged (across)."),
            _visual_line("Precision vs recall on held-out rows", [f"{x:.2f}" for x, _ in g["pr"]],
                         [{"name": "Precision", "values": [y for _, y in g["pr"]]}, {"name": "Guessing", "values": [g["rate"]] * len(g["pr"]), "dashed": True}],
                         "percent", note="Of the rows flagged (up), how many are real - as more of the real ones are found (across)."),
            {"type": "table", "title": "Lift: the outcome rate among the highest scores", "columns": ["Top of the list", "Outcome rate", "Lift"],
             "rows": [[f"{x['top'] * 100:.0f}%", f"{x['rate'] * 100:.1f}%", f"{x['lift']:.2f}×" if x["lift"] else "—"] for x in g["lift"]]},
            _visual_line("Calibration: predicted vs actual, by tenths of the rows", [str(i + 1) for i in range(len(g["calibration"]))],
                         [{"name": "Predicted", "values": [c["predicted"] for c in g["calibration"]]},
                          {"name": "Actual", "values": [c["actual"] for c in g["calibration"]]}], "percent",
                         note="When the two lines sit together, a 30% score really means about 30 in 100.")]
        tnote = f"ROC AUC {g['auc']:.3f} on {g['test_rows']:,} held-out rows · top 10% hit {g['top10_hit'] * 100:.1f}% vs {g['rate'] * 100:.1f}%"
    else:
        g = tr.grade_number(beta, prof)
        score, second = g["r2"], g["mae"]
        base_score = 0.0
        bk = [b for b in g["buckets"] if b["rows"]]
        test_vis = [
            {"type": "kpis", "items": [
                {"label": "R²", "value": f"{g['r2']:.3f}", "tone": "good" if g["r2"] > 0.1 else None, "note": "0 = no better than the average"},
                {"label": "Typical error (MAE)", "value": _m.num(g["mae"])},
                {"label": "RMSE", "value": _m.num(g["rmse"])},
                {"label": "Held-out rows", "value": g["test_rows"]}]},
            _visual_line("Predicted vs actual, by predicted band", [_m.num((b["from"] + b["to"]) / 2) for b in bk],
                         [{"name": "Predicted", "values": [b["predicted"] for b in bk]}, {"name": "Actual", "values": [b["actual"] for b in bk]}],
                         "number", note="Held-out rows grouped by their prediction: the actual average should track the predicted one.")]
        tnote = f"R² {g['r2']:.3f} on {g['test_rows']:,} held-out rows · typical error {_m.num(g['mae'])}"
    job.stage("test", "done", tnote + (" · graded in the last training pass" if fit.get("graded") else ""),
              code=_pass_code(tr.passes, "grade", engine) or _pass_code(tr.passes, "train", engine, limit=1)[-1:], visual=test_vis)
    job.check_stop()

    # 5. the model as SQL - proved inside the database (held-out rows) and on made-up rows (SQL vs Python)
    job.stage("sql", "running", f"Compiling the model into one {engine} expression")
    glm = tr.glm(beta)
    out_col = out_column(kind, target, tr.positive)
    deploy_rel = d.path(info["key"]) if src.kind == "duckdb" else src.rel
    sql_pack = scoring_sql(d, glm, deploy_rel, out_col)
    sql_pack["notebook_select"] = scoring_sql(Dialect("duckdb"), glm, "source", out_col)["select"]
    agree = dict(g.get("agree") or {})
    try:
        agree["synthetic"] = tr.synthetic_check(glm, out_col)
    except PushdownError as e:
        agree["synthetic"] = {"error": str(e)}
    b0_raw, terms = raw_terms(d, glm)
    z95 = 1.959963984540054
    coef_rows = []
    for j, name in enumerate(des.names):
        if j == 0:
            continue
        b, s_e = float(beta[j]), float(se[j])
        coef_rows.append({"term": name, "column": des.owner[j], "kind": des.terms[j - 1]["t"], "coef": b, "se": s_e, "lo": b - z95 * s_e, "hi": b + z95 * s_e,
                          "odds": float(math.exp(max(-50, min(50, b)))) if kind == "binary" else None,
                          "raw": terms[j - 1][1], "sure": (b - z95 * s_e) * (b + z95 * s_e) > 0})
    coef_rows.sort(key=lambda r: -abs(r["coef"]))
    coef_vis = {"type": "table", "title": "Coefficients, with 95% confidence intervals",
                "columns": ["Term", "Effect", "95% interval", "Odds ×" if kind == "binary" else "In original units", "Clear?"],
                "rows": [[r["term"], f"{r['coef']:+.3f}", f"{r['lo']:+.3f} … {r['hi']:+.3f}",
                          (f"{r['odds']:.2f}" if kind == "binary" else _m.num(r["raw"])), "yes" if r["sure"] else "not clear"] for r in coef_rows[:24]]}
    syn = agree.get("synthetic") or {}
    ok_db = agree.get("max_diff") is not None and agree["max_diff"] < 1e-6
    ok_syn = syn.get("max_diff") is not None and syn["max_diff"] < 1e-6
    model_bytes = len(json.dumps(glm.beta)) + len(json.dumps(glm.terms, default=str))
    sql_vis = [{"type": "kpis", "items": [
        {"label": "Model terms", "value": len(des.names)},
        {"label": "SQL = model, in the database", "value": (f"to {agree['max_diff']:.0e}" if agree.get("max_diff") is not None else "—"),
         "note": f"on all {agree.get('rows', 0):,} held-out rows, scored by {engine}", "tone": "good" if ok_db else None},
        {"label": "SQL = Python", "value": (f"to {syn['max_diff']:.0e}" if syn.get("max_diff") is not None else "—"),
         "note": f"on {syn.get('rows', 0)} made-up rows (never your data)" if syn.get("rows") else syn.get("error"), "tone": "good" if ok_syn else None},
        {"label": "What GD360 keeps", "value": f"{model_bytes:,} bytes", "note": "the coefficients - never a row"}]}, coef_vis]
    job.stage("sql", "done", f"One SELECT scores every row in {engine}" + (f" · matches the model to {agree['max_diff']:.0e}" if agree.get("max_diff") is not None else ""),
              code=[{"title": "Score every row (SELECT)", "lang": "sql", "engine": engine, "code": sql_pack["select"] + ";"},
                    {"title": "Keep it as a view", "lang": "sql", "engine": engine, "code": sql_pack["view"] + ";"},
                    {"title": "As a dbt model", "lang": "sql", "engine": "dbt", "code": sql_pack["dbt"]}]
              + _pass_code(tr.passes, "sql", engine, limit=1),
              visual=sql_vis)

    # results
    drivers = _drivers(des, beta, prof, kind)
    all_passes = tr.passes
    total_back = sum(p.bytes_back for p in all_passes)
    pushdown = {
        "engine": engine, "dialect": d.d, "kind": src.kind, "live": info["mode"] == "live", "table": info["key"],
        "passes": len(all_passes), "train_steps": steps, "full_passes": fit.get("full_passes"), "converged": bool(fit["converged"]),
        "seconds": round(time.time() - t_start, 1), "db_seconds": round(sum(p.seconds for p in all_passes), 2),
        "bytes_back": total_back, "rows_out": sum(p.rows_back for p in all_passes if p.row_level), "sample_rows_looked_at": 0,
        "model_bytes": sum(p.bytes_back for p in all_passes if p.step in ("scan", "profile", "train", "grade")),
        "scanned": sum(p.scanned or 0 for p in all_passes) or None,
        "history": fit["history"], "rows": n_all, "train_rows": n_tr, "test_rows": n_te, "key": tr.key,
        "split": split, "warm": warm, "resumed": fit.get("resumed") or 0,
        "metrics": {k: v for k, v in g.items() if k not in ("histogram",)},
        "coefficients": coef_rows, "intercept": float(beta[0]), "intercept_raw": b0_raw,
        "sql": sql_pack, "agree": agree, "out_column": out_col, "leaks": leaks,
        "columns": [{"column": c, "type": mm.get("type"), "filled": mm.get("filled"), "distinct": mm.get("distinct"), "use": _use_words(mm)}
                    for c, mm in list(tr.cols.items())[:120]],
        "log": [{"step": p.step, "title": p.title, "seconds": p.seconds, "bytes_back": p.bytes_back, "rows": p.rows_back, "scanned": p.scanned}
                for p in all_passes],
        "glm": {"numeric": glm.numeric, "categories": glm.categories, "beta": glm.beta, "names": glm.names, "terms": glm.terms, "dialect": glm.dialect},
    }
    m.model_artifact = st._dump(glm)
    m.feature_columns = list(glm.features)
    m.excluded_columns = [{"column": x["column"], "reason": x["reason"]} for x in (leaks + left_out)]
    m.algorithm = "studio_sql_logistic" if kind == "binary" else "studio_sql_linear"
    m.task_type = "classification" if kind == "binary" else "regression"
    m.trained_row_count = int(n_tr)
    m.target_column = target
    tot = sum(dv["importance"] for dv in drivers) or 1.0
    m.feature_importance = [{"feature": dv["feature"], "importance": round(dv["importance"] / tot, 4)} for dv in drivers]
    w = {"test_score": score, "test_second": second}
    m.metrics = st._legacy_metrics(kind, w)
    model_words = "Logistic regression" if kind == "binary" else "Linear regression"
    beat = score > base_score
    warnings = [] if beat else ["The model did not beat the simple baseline on held-out rows - the columns it can use don't carry the signal. "
                                "Try a sample run, which can find non-linear patterns."]
    if kind == "binary" and score > 0.995:
        warnings.append("A near-perfect score usually means a column still gives the answer away - check the coefficients.")
    if not fit["converged"]:
        warnings.append(f"Training stopped at {MAX_ITER} steps before it fully settled - the scores are usable, but check for columns that duplicate each other.")
    if split.get("note"):
        warnings.append(split["note"])
    res = {
        "engine": "sql", "kind": kind, "label": label_info, "metric": st._metric_name(kind), "second_metric": st._second_name(kind),
        "winner": f"{model_words} in {engine}", "test_score": score, "test_second": second,
        "baseline": {"name": "Guessing (the average rate)" if kind == "binary" else "Always the average", "score": base_score, "second": None},
        "beats_baseline": bool(beat), "split": split_words + f" - inside {engine}",
        "train_rows": int(n_tr), "test_rows": int(n_te), "rows_total": int(n_all), "capped": False,
        "drivers": drivers[:15], "leaks": leaks, "excluded": left_out, "features": list(glm.features), "positive": tr.positive,
        "dates": list(des.dates), "warnings": warnings, "joins": [],
        "leaderboard": [{"algorithm": f"{model_words} in {engine}", "test_score": score, "best": True}],
        "pushdown": pushdown,
    }
    pres = st._present_supervised(ptype, res)
    pres["headline"] = pres["headline"].replace("Ranks every row", f"Trained inside {engine} on all {n_all:,} rows - ranks every row", 1) \
        if kind == "binary" else f"Trained inside {engine} on all {n_all:,} rows. " + pres["headline"]
    for sec in pres["sections"]:
        if sec.get("type") == "bars" and "shuffling" in (sec.get("note") or ""):
            sec["note"] = ("How much each column moves the prediction across rows (the spread of its terms in the model, "
                           "on the log-odds scale for yes/no) - from the coefficients and the database's own counts.")
    pres["sections"] = [s_ for s_ in pres["sections"] if s_.get("title") != "Models compared"]
    pres["sections"] += _evidence_sections(_m, kind, g, coef_rows, pushdown)
    res.update(pres)
    m.results = res
    job.save(data={"source": {"name": info["name"], "table": info["table"], "kind": info["kind"], "mode": info["mode"], "how": info["how"]},
                   "rows_total": int(n_all), "rows_used": int(n_all), "columns": len(src.types),
                   "sample": {"strategy": "in_database", "text": f"Every one of the {n_all:,} rows, read inside {engine}. Nothing was copied out."},
                   "budget": None, "prep": {"rows": n_all} if info.get("prep") else None, "seconds": pushdown["seconds"]},
             resources={**(job.progress.get("resources") or {}), "rows_used": int(n_all), "rows_total": int(n_all), "capped": False,
                        "model_mb": round(len(m.model_artifact) / 1e6, 3)},
             pushdown_ckpt=None)


def _drivers(des: Design, beta: np.ndarray, prof: dict, kind: str) -> list[dict]:
    """Each column's importance: how far its terms move the prediction across
    rows (the standard deviation of their sum, from the coefficients and the
    database's own counts - no row needed)."""
    var: dict[str, float] = {}
    sign: dict[str, list[float]] = {}
    onehot: dict[str, list[tuple[float, float]]] = {}
    n_tr = float(prof.get("train_rows") or 1)
    for i, t in enumerate(des.terms, start=1):
        b = float(beta[i])
        c = t["col"]
        if t["t"] in ("lvl", "other"):
            info = des.categories.get(c) or {}
            counts = info.get("counts") or []
            top = info.get("top") or []
            if t["t"] == "lvl" and t["level"] in top:
                share = counts[top.index(t["level"])] / n_tr if top.index(t["level"]) < len(counts) else 0.0
            else:
                share = max(0.0, (info.get("filled") or n_tr) - sum(counts)) / n_tr
            onehot.setdefault(c, []).append((share, b))
            continue
        var[c] = var.get(c, 0.0) + b * b * float(t.get("var", 1.0))
        if t["t"] in ("num", "date", "rate"):
            sign.setdefault(c, []).append(b)
    for c, items in onehot.items():
        mean = sum(p * b for p, b in items)
        var[c] = var.get(c, 0.0) + max(0.0, sum(p * b * b for p, b in items) - mean * mean)
    out = []
    for c, v in var.items():
        s = sign.get(c) or []
        direction = ("up" if s[0] > 0 else "down") if len(s) == 1 and c not in onehot and not any(t["t"] == "sq" and t["col"] == c for t in des.terms) else "mixed"
        if c in des.dates and direction in ("up", "down"):
            direction = "down" if direction == "up" else "up"   # the term is "days before": more days = an earlier date
        out.append({"feature": c, "importance": math.sqrt(max(0.0, v)), "direction": direction})
    out.sort(key=lambda x: -x["importance"])
    return out


def _evidence_sections(_m, kind: str, g: dict, coef_rows: list[dict], pd_: dict) -> list[dict]:
    secs = []
    if kind == "binary":
        secs.append(_m.sec_line("ROC curve on held-out rows", [f"{x:.2f}" for x, _ in g["roc"]],
                                [{"name": "Model", "values": [y for _, y in g["roc"]]}, {"name": "Guessing", "values": [x for x, _ in g["roc"]], "dashed": True}],
                                "percent", note=f"ROC AUC {g['auc']:.3f}, computed in the database from a 1,000-bucket histogram of the held-out scores."))
        secs.append(_m.sec_line("Precision vs recall on held-out rows", [f"{x:.2f}" for x, _ in g["pr"]],
                                [{"name": "Precision", "values": [y for _, y in g["pr"]]},
                                 {"name": "Guessing", "values": [g["rate"]] * len(g["pr"]), "dashed": True}],
                                "percent", note=f"Average precision {g['average_precision']:.3f} (guessing: {g['rate']:.3f}). "
                                                "Read across: as more of the real cases are found, how many of the flagged rows are real."))
        secs.append(_m.sec_table("Lift: the outcome rate among the highest scores", [
            _m.column("top", "Top of the list"), _m.column("rate", "Outcome rate", "percent"), _m.column("lift", "Lift ×", "number")],
            [{"top": f"{x['top'] * 100:.0f}% of rows", "rate": x["rate"], "lift": x["lift"]} for x in g["lift"]],
            note=f"Overall rate {g['rate'] * 100:.1f}%. Lift 3× means the top of the list has three times the outcome of a random pick."))
        secs.append(_m.sec_line("Calibration: predicted vs actual", [str(i + 1) for i in range(len(g["calibration"]))],
                                [{"name": "Predicted", "values": [c["predicted"] for c in g["calibration"]]},
                                 {"name": "Actual", "values": [c["actual"] for c in g["calibration"]]}], "percent",
                                note="Held-out rows in ten equal groups, lowest scores first."))
    else:
        bk = [b for b in g["buckets"] if b["rows"]]
        secs.append(_m.sec_line("Predicted vs actual on held-out rows", [_m.num((b["from"] + b["to"]) / 2) for b in bk],
                                [{"name": "Predicted", "values": [b["predicted"] for b in bk]}, {"name": "Actual", "values": [b["actual"] for b in bk]}],
                                "number"))
    secs.append(_m.sec_table("Coefficients, with 95% confidence intervals", [
        _m.column("term", "Term"), _m.column("coef", "Effect", "number"), _m.column("lo", "95% from", "number"),
        _m.column("hi", "95% to", "number")] + ([_m.column("odds", "Odds ×", "number")] if kind == "binary" else [_m.column("raw", "In original units", "number")])
        + [_m.column("clear", "Clear effect?")],
        [{**{k: r[k] for k in ("term", "coef", "lo", "hi", "odds", "raw")}, "clear": "yes" if r["sure"] else "not clear"} for r in coef_rows[:40]],
        note="Numbers and dates are standardised (the effect of one standard deviation); a category value's effect is against its most common value; "
             "an outcome rate is standardised too. An interval that crosses zero means the data can't tell the direction."))
    secs.append(_m.sec_table("How it ran: every query", [
        _m.column("title", "Query"), _m.column("seconds", "Seconds", "number"), _m.column("bytes_back", "Bytes back", "integer")],
        [{"title": x["title"], "seconds": x["seconds"], "bytes_back": x["bytes_back"]} for x in pd_["log"]],
        note=f"{pd_['passes']} queries in {pd_['engine']}, {pd_['bytes_back']:,} bytes back in all. Not one of your rows left the database: "
             "every query returned sums, counts or a histogram (the SQL check uses made-up rows)."))
    return secs


def test_in_database(db, user, m) -> dict:
    """Runs the model's scoring SQL over every row the person can see, read
    only: how many rows it scores and how the scores spread."""
    from . import ml_data as md
    from . import ml_studio as st
    res = m.results if isinstance(m.results, dict) else {}
    pdn = res.get("pushdown") or {}
    if res.get("engine") != "sql" or not pdn.get("glm"):
        raise st.StudioError("This model wasn't trained in the database.")
    spec = dict((m.plan or {}).get("spec") or {})
    g = pdn["glm"]
    glm = SqlGLM(kind="binary" if res.get("kind") == "binary" else "number", numeric=g["numeric"], categories=g["categories"], beta=g["beta"],
                 names=g["names"], terms=g.get("terms"), dialect=g.get("dialect"))
    t0 = time.time()
    try:
        with md.Bench() as bench:
            src, info = _open_source(db, user, spec, bench)
            d = src.dialect
            rel = src.rel if not src.filters else f"(SELECT * FROM {src.rel} WHERE {' AND '.join(src.filters)})"
            sql = check_sql(d, glm, rel, pdn.get("out_column") or "gd360_score")
            try:
                df, scanned = src.query(sql)
            except PushdownError:
                raise
            except Exception as e:  # noqa: BLE001
                from .warehouse_exec import clean_warehouse_error
                raise PushdownError(f"{src.where_words} stopped the check: {clean_warehouse_error(e)}") from e
    except PushdownError as e:
        raise st.StudioError(str(e)) from e
    rows = [tuple(r) for r in df.itertuples(index=False, name=None)]
    out = {"engine": src.where_words, "dialect": d.d, "sql": sql, "seconds": round(time.time() - t0, 2),
           "scanned": int(scanned) if scanned else None, "checked_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    if glm.kind == "binary":
        bk = {int(r[0]): (int(r[1] or 0), float(r[2] or 0)) for r in rows if r[0] is not None}
        out["rows"] = sum(n for n, _ in bk.values())
        out["buckets"] = [{"from": i / 10, "to": (i + 1) / 10, "rows": bk.get(i, (0, 0))[0], "avg": bk.get(i, (0, None))[1]} for i in range(10)]
        out["mean"] = (sum(n * a for n, a in bk.values()) / out["rows"]) if out["rows"] else None
    else:
        r = rows[0] if rows else (0, None, None, None)
        out.update(rows=int(r[0] or 0), mean=float(r[1]) if r[1] is not None else None, min=float(r[2]) if r[2] is not None else None,
                   max=float(r[3]) if r[3] is not None else None)
    return out
