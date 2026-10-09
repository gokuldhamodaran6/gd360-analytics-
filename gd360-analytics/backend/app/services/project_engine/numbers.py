"""
Number formatting for answers, and the checker that keeps the written
answer honest: every number in the text must be one GD360 computed or read
from the data.
"""
from __future__ import annotations

import math
import re

CURRENCY_SYMBOLS = {"USD": "$", "EUR": "€", "GBP": "£", "INR": "₹", "JPY": "¥", "AUD": "A$", "CAD": "C$", "SGD": "S$"}


def _finite(v) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def abbreviate(v: float, decimals: int = 1) -> str:
    a = abs(v)
    sign = "−" if v < 0 else ""
    if a >= 1e9:
        return f"{sign}{a / 1e9:.{decimals}f}B"
    if a >= 1e6:
        # $1.32M, $25.9M: three significant figures, as a finance team writes them
        return f"{sign}{a / 1e6:.{decimals + 1 if a < 1e7 else decimals}f}M"
    if a >= 1e4:
        return f"{sign}{a / 1e3:.{decimals}f}k"
    if a >= 100:
        return f"{sign}{a:,.0f}"
    if a >= 1:
        return f"{sign}{a:,.2f}".rstrip("0").rstrip(".")
    if a == 0:
        return "0"
    return f"{sign}{a:.3g}"


def fmt(v, kind: str = "number", currency: str | None = None, signed: bool = False) -> str:
    f = _finite(v)
    if f is None:
        return "—"
    if kind == "percent":  # v is in percentage points (12.4 means 12.4%)
        s = f"{abs(f):.1f}%"
    elif kind == "ratio":  # v is a fraction (0.124 means 12.4%)
        s = f"{abs(f) * 100:.2f}%" if abs(f) < 0.1 else f"{abs(f) * 100:.1f}%"
    elif kind == "currency":
        sym = CURRENCY_SYMBOLS.get((currency or "USD").upper(), "")
        body = f"{abs(f):,.2f}" if abs(f) < 100 else abbreviate(abs(f))
        s = f"{sym}{body}" if sym else f"{body} {currency or ''}".strip()
    elif kind == "integer":
        s = f"{abs(f):,.0f}"
    else:
        s = abbreviate(abs(f))
    if f < 0:
        return "−" + s
    if signed and f > 0:
        return "+" + s
    return s


def pct_change(cur: float, prev: float) -> float | None:
    if prev is None or cur is None or prev == 0:
        return None
    return (cur - prev) / abs(prev) * 100.0


# ---- the checker -------------------------------------------------------------

_NUM_RE = re.compile(
    r"(?<![\w.])([-−+]?)\s?([$€£₹¥]|A\$|C\$|S\$)?\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s?(%|k\b|K\b|M\b|m\b|B\b|bn\b|million\b|billion\b|thousand\b)?",
)
_MONTHS = r"(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*"
_DATE_RE = re.compile(
    rf"\b\d{{1,2}}\s?(?:[–-]\s?\d{{1,2}}\s?)?{_MONTHS}\b|\b{_MONTHS}\s?\d{{1,2}}\b|\b\d{{4}}-\d{{2}}(?:-\d{{2}})?\b|\bQ[1-4]\b",
    re.I,
)


def _scale(unit: str | None) -> float:
    u = (unit or "").lower()
    return {"k": 1e3, "thousand": 1e3, "m": 1e6, "million": 1e6, "b": 1e9, "bn": 1e9, "billion": 1e9}.get(u, 1.0)


def extract_numbers(text: str) -> list[tuple[str, float, bool]]:
    """(token, value, is_percent) for every number written in `text`,
    skipping dates (12 Oct, 2026-10-08, Q3)."""
    if not text:
        return []
    masked = _DATE_RE.sub(lambda m: " " * len(m.group(0)), text)
    out = []
    for m in _NUM_RE.finditer(masked):
        sign, _sym, whole, frac, unit = m.groups()
        try:
            v = float(whole.replace(",", "") + (frac or ""))
        except ValueError:
            continue
        is_pct = unit == "%"
        v *= 1.0 if is_pct else _scale(unit)
        if sign in ("-", "−"):
            v = -v
        out.append((m.group(0).strip(), v, is_pct))
    return out


def allowed_values(facts: list[dict], tables: list[dict], extra_text: str = "") -> list[float]:
    vals: list[float] = []
    for f in facts:
        v = _finite(f.get("value"))
        if v is not None:
            vals.append(v)
            if f.get("kind") == "ratio":
                vals.append(v * 100)
        for _tok, n, _p in extract_numbers(str(f.get("label") or "") + " " + str(f.get("display") or "")):
            vals.append(n)
    for t in tables:
        for row in (t.get("rows") or [])[:200]:
            for cell in (row.values() if isinstance(row, dict) else row):
                v = _finite(cell)
                if v is not None:
                    vals.append(v)
                elif isinstance(cell, str):
                    for _tok, n, _p in extract_numbers(cell):
                        vals.append(n)
    for _tok, n, _p in extract_numbers(extra_text):
        vals.append(n)
    return vals


def _matches(v: float, allowed: list[float]) -> bool:
    a = abs(v)
    for x in allowed:
        ax = abs(x)
        if ax == 0:
            if a < 0.05:
                return True
            continue
        if abs(a - ax) <= max(0.051, ax * 0.006):
            return True
        # written in a rounder unit than computed ($58.5k vs 58,512.3)
        for scale in (1e3, 1e6, 1e9):
            if ax >= scale and abs(a - ax) <= scale * 0.051:
                return True
    return False


def unsupported_numbers(text: str, allowed: list[float]) -> list[str]:
    """Numbers in `text` that match nothing GD360 computed or read. Small
    counting words (up to 12) and years are always fine."""
    bad = []
    for tok, v, is_pct in extract_numbers(text):
        a = abs(v)
        if not is_pct and a <= 12 and float(a).is_integer():
            continue
        if not is_pct and 1900 <= a <= 2100 and float(a).is_integer():
            continue
        if _matches(v, allowed):
            continue
        bad.append(tok)
    return bad
