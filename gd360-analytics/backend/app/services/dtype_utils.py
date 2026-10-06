"""2026-10-06 comprehensive dtype-correctness fix.

Found while chasing down the BigQuery "db-dtypes" error (the Data tab's
DATE columns): two real, separate bugs, verified directly with pandas
rather than guessed, that affect every connector in this app that can
return a date/time column - not just BigQuery.

1. CLASSIFICATION: a column holding plain dates comes back from pandas
   with a dtype string that this app's own date-detection logic doesn't
   recognize, so it gets silently treated as an ordinary text column
   (losing its calendar icon and its date-range filter in the UI).
   Confirmed two different ways this happens:
     - BigQuery's DATE columns (via the db-dtypes package) get the dtype
       string "dbdate" - which doesn't start with "date", so the old
       check missed it.
     - Postgres/MySQL/SQL Server/Supabase DATE columns come back from
       pd.read_sql as plain Python `datetime.date` objects sitting in a
       column pandas labels "object" (confirmed with a real pd.DataFrame
       test) - "object" looks exactly like a text column to any
       dtype-string check.
     - Same shape of bug, a third way: a nullable BOOLEAN column from
       those same plain-SQL connectors also lands in an "object" column
       of True/False/None the moment it has even one NULL in it
       (confirmed the same way) - so a yes/no column with any missing
       values would also have silently lost its true/false filter toggle.
   `normalize_dtype_label` below looks past the ambiguous dtype string at
   the column's actual Python values and returns a clean "date"/"time"
   label whenever that's what's really there - computed once per column,
   not re-derived differently in different places the way the old code
   risked doing.

2. DISPLAY: independent of classification, actually showing a date cell
   in the Data tab was ALSO broken for every connector, not just
   BigQuery. Confirmed directly: pandas' own `DataFrame.to_json()` -
   which is what the Data tab's preview endpoint uses to send rows to
   the browser - turns a date/datetime value into a raw epoch-millisecond
   number (e.g. 1704412800000) by default, not a readable date string.
   That's true whether the column is a real datetime64 column or a
   "dbdate"/plain-object date column. Caught this by actually running
   `df.to_json(orient="records")` on a realistic date column and reading
   the output, not by assuming pandas "just handles it" - it doesn't.
   `coerce_dates_for_json` below rewrites just those columns to ISO
   strings ("2024-01-05", "2024-01-05T10:30:00+00:00") right before
   serialization, which is exactly how this app's own distinct-values
   endpoint (_jsonify_scalar, a few hundred lines below in datasources.py)
   already renders dates - this makes the Data tab's main table consistent
   with that, instead of the two disagreeing with each other.

Both functions are read-only with respect to column dtype decisions -
call normalize_dtype_label on the ORIGINAL dataframe (for the `dtypes`
sent to the frontend) before calling coerce_dates_for_json (which
rewrites those same columns to strings for the `rows` payload) - doing
it in the other order would make every date column's dtype label come
back as "object" after it's already been stringified.
"""

from __future__ import annotations

import datetime

import pandas as pd

# How many non-null values to sample from an "object" dtype column before
# concluding it's uniformly dates/times. Capped so a huge all-text column
# never costs more than a handful of isinstance() checks - this only runs
# once per column per request, on already-row-limited data (the Data tab
# preview and chart preview this feeds are both paginated/capped long
# before this ever sees them).
_SNIFF_SAMPLE_SIZE = 200


def normalize_dtype_label(series: pd.Series) -> str:
    """Returns a dtype label that's safe to classify columns by - "date"
    or "time" whenever the column's real values are dates/times, even
    when pandas' own dtype string wouldn't tell you that (see module
    docstring). Every other column's normal dtype string (e.g. "int64",
    "float64", "object" for real text, "bool") passes through unchanged,
    so this is always a strict improvement over `str(series.dtype)`,
    never a regression."""
    raw = str(series.dtype)
    if raw == "dbdate":
        return "date"
    if raw == "dbtime":
        return "time"
    if raw == "object":
        non_null = series.dropna()
        if len(non_null) == 0:
            return raw
        sample = non_null.iloc[: min(len(non_null), _SNIFF_SAMPLE_SIZE)]
        # datetime.datetime is a subclass of datetime.date, so the
        # `not isinstance(v, datetime.datetime)` guard is what keeps a
        # real timestamp column (which pandas already classifies
        # correctly as datetime64, and never lands here as "object" -
        # see the module docstring) from ever being double-counted as
        # the plain-date case.
        if all(isinstance(v, datetime.date) and not isinstance(v, datetime.datetime) for v in sample):
            return "date"
        if all(isinstance(v, datetime.time) for v in sample):
            return "time"
        # A third, same-shape bug found while verifying the two above: a
        # nullable BOOLEAN column (any NULL at all, not just "all NULL")
        # from Postgres/MySQL/SQL Server/Supabase comes back from
        # pd.read_sql as plain Python True/False/None sitting in a column
        # pandas also calls "object" (confirmed directly - a column of
        # [True, False, None] gets dtype "object", not "bool", the moment
        # a single None is mixed in). Without this, that column would
        # also silently fall through to "text" below and lose its
        # true/false filter toggle. `isinstance(v, bool)` deliberately
        # does NOT also match plain ints - bool is a subclass of int in
        # Python, but int is not a subclass of bool, so a real 0/1
        # integer column is never misread as booleans here.
        if all(isinstance(v, bool) for v in sample):
            return "boolean"
        # 2026-10-06 (NoSQL hybrid round): a MongoDB array field - e.g.
        # {"tags": ["a", "b"]} - lands in pandas, after
        # MongoConnector.load_dataframe's pandas.json_normalize flattening,
        # as an "object" column of plain Python list/tuple values (list
        # fields are deliberately left unexpanded - see that function's own
        # comment on why). Without this, such a column would silently fall
        # through to "text" below, and the frontend would try to render a
        # raw Python list repr in every cell instead of a real "N items"
        # count. tuple is included for the same reason bool is checked
        # above it - defensive, not because any connector in this app
        # currently produces tuples; a real test (not just this reasoning)
        # confirms list columns hit this branch.
        if all(isinstance(v, (list, tuple)) for v in sample):
            return "array"
    return raw


def normalize_dtypes_dict(df: pd.DataFrame) -> dict[str, str]:
    """The `{column: dtype_label}` map this app sends the frontend -
    always build it from this helper (not `str(df[c].dtype)` directly),
    and always build it from the ORIGINAL dataframe, before
    coerce_dates_for_json has rewritten any date columns to strings."""
    return {str(c): normalize_dtype_label(df[c]) for c in df.columns}


def _iso_or_none(v):
    """One cell's value -> a JSON-safe ISO string, or None for any kind
    of "no value" (Python None, NaN, pandas NaT all go through
    `pd.isna`)."""
    if v is None:
        return None
    try:
        if pd.isna(v):
            return None
    except (TypeError, ValueError):
        # pd.isna raises on a handful of exotic/array-like inputs that
        # can never actually appear in a single DataFrame cell; treat
        # those as "has a value" rather than letting this raise.
        pass
    if hasattr(v, "isoformat"):
        return v.isoformat()
    return v


def coerce_dates_for_json(df: pd.DataFrame) -> pd.DataFrame:
    """Returns a COPY of df where every date/time/datetime column -
    real pandas datetime64 (naive or timezone-aware), BigQuery's
    dbdate/dbtime, or a plain-object column of datetime.date/
    datetime.time values - has been rewritten to ISO-8601 strings, so
    that calling `.to_json(orient="records")` afterwards shows a real
    date instead of pandas' default raw epoch-millisecond number (see
    module docstring for how this was confirmed, not assumed). Every
    other column is left completely untouched."""
    df = df.copy()
    for col in df.columns:
        series = df[col]
        raw = str(series.dtype)
        needs_coercion = (
            pd.api.types.is_datetime64_any_dtype(series)
            or raw in ("dbdate", "dbtime")
            or normalize_dtype_label(series) in ("date", "time")
        )
        if needs_coercion:
            df[col] = series.apply(_iso_or_none)
    return df
