"""Turning messy cell values into join keys and numbers.

Pure functions, no database - every rule here is easy to test on its own."""
from __future__ import annotations

import math
import re

import pandas as pd

_CURRENCY = re.compile(r"(₹|\$|€|£|rs\.?|inr|usd|eur|gbp)", re.IGNORECASE)
_NUMERIC = re.compile(r"^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$")


def is_empty(v) -> bool:
    if v is None:
        return True
    if isinstance(v, float) and math.isnan(v):
        return True
    try:
        if v is pd.NA or v is pd.NaT:
            return True
    except TypeError:
        pass
    return isinstance(v, str) and not v.strip()


def tidy_key(v) -> str | None:
    """'#40218 ' -> '40218', 40218.0 -> '40218', '' -> None."""
    if is_empty(v):
        return None
    if isinstance(v, bool):
        return str(v)
    if isinstance(v, (int,)) or (hasattr(v, "dtype") and str(getattr(v, "dtype", "")).startswith("int")):
        return str(int(v))
    if isinstance(v, float):
        return str(int(v)) if v.is_integer() else repr(v)
    s = str(v).strip().strip('"').strip("'").strip()
    s = s.lstrip("#").strip()
    s = re.sub(r"\s+", " ", s)
    if s.endswith(".0") and s[:-2].isdigit():
        s = s[:-2]
    return s or None


def match_key(v) -> str | None:
    """The key used only for matching - case does not matter."""
    k = tidy_key(v)
    return k.upper() if k else None


def parse_number(v) -> float | None:
    """'1,920' -> 1920.0, '₹ 1,550.50' -> 1550.5, '(120)' -> -120.0, 'abc' -> None."""
    if is_empty(v):
        return None
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        f = float(v)
        return None if math.isnan(f) else f
    s = str(v).strip().strip('"').strip("'").strip()
    neg = False
    if s.startswith("(") and s.endswith(")"):
        neg, s = True, s[1:-1]
    s = _CURRENCY.sub("", s).replace(",", "").replace(" ", "").replace(" ", "")
    if s.endswith("-") and _NUMERIC.match(s[:-1] or "x"):
        neg, s = True, s[:-1]
    if not _NUMERIC.match(s):
        return None
    f = float(s)
    return -f if neg else f


def looks_like_text_number(v) -> bool:
    """A value a person typed as text that is really a number ('1,920', '₹300')."""
    if is_empty(v) or isinstance(v, (int, float, bool)):
        return False
    s = str(v)
    return parse_number(s) is not None and bool(re.search(r"[,₹$€£\s'\"()]|rs|inr", s, re.IGNORECASE))


def key_needs_tidy(v) -> bool:
    if is_empty(v) or not isinstance(v, str):
        return False
    t = tidy_key(v)
    return t is not None and t != v


def show(v) -> str:
    """How a value is shown to a person in a before/after example."""
    if is_empty(v):
        return "(empty)"
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    s = str(v)
    if s != s.strip():
        s = s.replace(" ", "␣") if s.strip() else "(spaces)"
    return f"“{s}”" if isinstance(v, str) and parse_number(v) is not None and not _NUMERIC.match(v.strip()) else s


def to_plain(v):
    """JSON-safe version of one cell."""
    if is_empty(v):
        return None
    if isinstance(v, (bool, int, str)):
        return v
    if isinstance(v, float):
        return int(v) if v.is_integer() and abs(v) < 1e15 else round(v, 6)
    if hasattr(v, "isoformat"):
        try:
            return v.isoformat()
        except Exception:  # noqa: BLE001
            return str(v)
    try:
        f = float(v)
        if math.isnan(f):
            return None
        return int(f) if f.is_integer() else round(f, 6)
    except (TypeError, ValueError):
        return str(v)


def records(df: pd.DataFrame, limit: int = 20) -> list[dict]:
    out = []
    for row in df.head(limit).to_dict(orient="records"):
        out.append({str(k): to_plain(v) for k, v in row.items()})
    return out
