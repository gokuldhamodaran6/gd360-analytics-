"""
Number formatting for answers, and the checker that keeps the written
answer honest: every number in the text must be one GD360 computed or read
from the data.

2026-10-13 (R45): formatting goes through services/semantics (round_half_up,
compact) so the backend writes 21.075 as 21.08 and 999,999 as 1M exactly like
the frontend; the checker matches a written number at the precision it was
written with (no more "any number within 51k passes"), checks the direction
words around a change ("rose 12.5%" when the data fell), never hides
"decreased 45%" or "margin 87%" behind a month mask, and only waves a year
through when it reads like a year.
"""
from __future__ import annotations

import math
import re

from .. import semantics as _sem

CURRENCY_SYMBOLS = {"USD": "$", "EUR": "€", "GBP": "£", "INR": "₹", "JPY": "¥", "AUD": "A$", "CAD": "C$", "SGD": "S$"}


def _finite(v) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _symbol(currency: str | None) -> str:
    code = (currency or "USD").upper()
    return CURRENCY_SYMBOLS.get(code) or _sem.SYMBOL.get(code, "")


def abbreviate(v: float, decimals: int = 1) -> str:
    """2026-10-13 (R45): one rule with the frontend - semantics.compact above 10,000 (999,999 -> "1M", never
    "1000.0k"; 9,999,999 -> "10M", never "10.00M"), half-up rounding below it."""
    a = abs(v)
    sign = "−" if v < 0 else ""
    if a >= 9999.5:
        return sign + _sem.compact(a)
    if a >= 100:
        return f"{sign}{int(_sem.round_half_up(a, 0)):,}"
    if a >= 1:
        return sign + _sem.fmt_number(a, 2).rstrip("0").rstrip(".")
    if a == 0:
        return "0"
    return sign + _sem.fmt_number(a, 3).rstrip("0").rstrip(".") if a >= 0.001 else f"{sign}{a:.3g}"


def _pct_text(points: float) -> str:
    a = abs(points)
    d = 2 if 0 < a < 1 else (1 if a < 100 else 0)  # 0.03% stays 0.03%, never "0.0%"
    return f"{_sem.fmt_number(a, d)}%"


def fmt(v, kind: str = "number", currency: str | None = None, signed: bool = False) -> str:
    f = _finite(v)
    if f is None:
        return "—"
    a = abs(f)
    if kind == "percent":  # v is in percentage points (12.4 means 12.4%)
        s = _pct_text(a)
    elif kind == "ratio":  # v is a fraction (0.124 means 12.4%)
        s = _pct_text(a * 100)
    elif kind == "points":  # a change in a rate, in percentage points
        s = f"{_sem.fmt_number(a, 1 if a >= 0.1 or a == 0 else 2)} pts"
    elif kind == "currency":
        sym = _symbol(currency)
        if a < 100:
            body = f"{_sem.round_half_up(a, 2):,.2f}"
        else:
            body = abbreviate(a)
        s = f"{sym}{body}" if sym else f"{body} {currency or ''}".strip()
    elif kind == "integer":
        s = f"{int(_sem.round_half_up(a, 0)):,}"
    else:
        s = abbreviate(a)
    if f < 0 and re.search(r"[1-9]", s):  # never "−0%"
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
# 2026-10-13 (R45): full month words only, and only when a day or a year sits next to them. The old
# "(jan|feb|mar|...|dec)[a-z]*" swallowed "decreased 45%", "declined 33%" and "margin 87%", so those
# numbers were never checked.
_MONTH_WORD = (r"(?:january|february|march|april|may|june|july|august|september|october|november|december|"
               r"jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\.?")
_ORD = r"(?:st|nd|rd|th)?"
_DATE_RE = re.compile(
    rf"\b\d{{1,2}}{_ORD}\s?(?:[–-]\s?\d{{1,2}}{_ORD}\s?)?{_MONTH_WORD}(?![a-z])(?:,?\s+\d{{4}})?"   # 12 Oct, 12-14 Oct 2025
    rf"|\b{_MONTH_WORD}(?![a-z])\s?\d{{1,2}}{_ORD}(?!\d|\s?%|\s?[kKmMbB]\b)(?:,?\s+\d{{4}})?"     # Oct 12, Oct 12, 2025
    rf"|\b{_MONTH_WORD}(?![a-z])\s+(?:\d{{4}}|'\d{{2}})\b"                                       # October 2025, Oct '25
    r"|\b\d{4}-\d{2}(?:-\d{2})?(?:[T ]\d{2}:\d{2}(?::\d{2})?)?\b"                                # 2026-10-08
    r"|\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b"                                                         # 31/12/2025, 12.31.25
    r"|\b(?:Q[1-4]|H[12])(?:\s?(?:FY)?\s?'?\d{2,4})?\b|\bFY\s?'?\d{2,4}\b|\b\d{4}\s?[-–]?\s?Q[1-4]\b"  # Q3, Q3 2025, FY25
    r"|\b\d{1,2}:\d{2}(?::\d{2})?\s?(?:am|pm)?\b"                                                  # 10:30
    r"|\b\d+(?:st|nd|rd|th)\b",                                                                     # 21st (a rank)
    re.I,
)

_UP_BEFORE = re.compile(
    r"\b(rose|risen|rise|rises|rising|increased|increase[sd]?|increasing|up|grew|grown|grows|growing|gained|gains?|"
    r"jumped|jumps?|climbed|climbs?|improved|improves?|higher by|surged|soared|added|adds|lifted)"
    r"\s+(?:by\s+|about\s+|around\s+|nearly\s+|almost\s+|roughly\s+|some\s+|over\s+|more than\s+|just\s+|a further\s+)*$", re.I)
_DOWN_BEFORE = re.compile(
    r"\b(fell|fallen|falls?|falling|dropped|drops?|dropping|declined|declines?|declining|decreased|decreases?|"
    r"decreasing|down|lost|loses|shrank|shrunk|shrinks?|slipped|slips?|slid|dipped|dips?|plunged|plummeted|"
    r"lower by|contracted|sank|sunk|tumbled|cut by|eased)"
    r"\s+(?:by\s+|about\s+|around\s+|nearly\s+|almost\s+|roughly\s+|some\s+|over\s+|more than\s+|just\s+|a further\s+)*$", re.I)
_UP_AFTER = re.compile(r"^\s*(?:increase|rise|growth|gain|jump|higher|uplift|surge|up)\b", re.I)
_DOWN_AFTER = re.compile(r"^\s*(?:drop|decline|decrease|fall|dip|lower|reduction|down|slump|contraction)\b", re.I)
_YEAR_BEFORE = re.compile(
    r"(?:\b(?:in|of|since|from|to|through|thru|until|till|by|during|for|fy|year|vs\.?|versus|and|between|before|after|"
    r"early|late|mid|end|start|across|over|within|q[1-4]|h[12]|january|february|march|april|may|june|july|august|"
    r"september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\.?|[–(/'-])\s*$", re.I)
_YEAR_AFTER = re.compile(r"^\s*(?:[–-]\s*\d{2,4}\b|to\s+\d{4}\b|and\s+\d{4}\b|vs\.?\b|versus\b|[)'’]|'s\b|’s\b|was\b|were\b|"
                         r"is\b|had\b|saw\b|has\b|ended\b|closed\b|brought\b|delivered\b|total\b|totals\b|figures?\b)", re.I)
_CORRECTION_BEFORE = re.compile(r"(?:\bnot|\brather than|\binstead of|\bunlike|\bnot the|\byou (?:said|mentioned|asked about)|"
                                r"\bthe question(?:'s)?(?: says)?|\bas stated|\bas assumed)\s*(?:the\s+|a\s+|an\s+)?$", re.I)


def _scale(unit: str | None) -> float:
    u = (unit or "").lower()
    return {"k": 1e3, "thousand": 1e3, "m": 1e6, "million": 1e6, "b": 1e9, "bn": 1e9, "billion": 1e9}.get(u, 1.0)


def _mask(text: str) -> str:
    return _DATE_RE.sub(lambda m: " " * len(m.group(0)), text)


def _tokens(text: str) -> list[dict]:
    """Every number written in `text` with how it was written: value, percent, currency, scale, the
    tolerance its written precision allows, and the words around it. Dates, times, ordinals and quarters
    are not numbers."""
    if not text:
        return []
    masked = _mask(text)
    out = []
    for m in _NUM_RE.finditer(masked):
        sign, sym, whole, frac, unit = m.groups()
        try:
            v = float(whole.replace(",", "") + (frac or ""))
        except ValueError:
            continue
        is_pct = unit == "%"
        scale = 1.0 if is_pct else _scale(unit)
        decimals = len(frac) - 1 if frac else 0
        digits = whole.replace(",", "")
        half = 0.5 * 10 ** (-decimals)
        if not frac and scale == 1.0 and len(digits) > 2:
            tz = len(digits) - len(digits.rstrip("0"))
            tz = min(tz, len(digits) - 2)  # "58,500" may stand for 58,512; "500" never stands for 512
            if tz > 0:
                half = 0.5 * 10 ** tz
        tol = half * scale
        value = v * scale
        if scale > 1 and value and tol / abs(value) > 0.05:
            tol = 0.05 * abs(value)  # "$1M" may stand for 999,960 or 1.04M, not for 1.4M
        if sign in ("-", "−"):
            value = -value
        out.append({"token": m.group(0).strip(), "value": value, "pct": is_pct, "currency": bool(sym), "scale": scale,
                    "tol": tol, "comma": "," in whole, "frac": bool(frac), "explicit_sign": sign or "",
                    "before": masked[max(0, m.start() - 40):m.start()], "after": masked[m.end():m.end() + 30],
                    "start": m.start()})
    return out


def extract_numbers(text: str) -> list[tuple[str, float, bool]]:
    """(token, value, is_percent) for every number written in `text`,
    skipping dates (12 Oct, 2026-10-08, 31/12/2025, Q3), times and ordinals."""
    return [(t["token"], t["value"], t["pct"]) for t in _tokens(text)]


_DOWN_NAME = re.compile(r"(drop|decline|decrease|loss|lost|fall|down|churn|shrink|reduction)", re.I)


def allowed_values(facts: list[dict], tables: list[dict], extra_text: str = "") -> list[float]:
    """Every number GD360 computed or read, plus the forms a careful analyst may write it in: a fraction
    column as a percentage (0.124 -> 12.4), a decline stored as a positive number as a negative change,
    the number of rows a table has and how many distinct values a label column holds ("3 stores")."""
    vals: list[float] = []
    for f in facts:
        v = _finite(f.get("value"))
        if v is not None:
            vals.append(v)
            if f.get("kind") == "ratio" or (f.get("scale") == "fraction"):
                vals.append(v * 100)
            if _DOWN_NAME.search(str(f.get("label") or "")) and v > 0:
                vals.append(-v)
        for _tok, n, _p in extract_numbers(str(f.get("label") or "") + " " + str(f.get("display") or "")):
            vals.append(n)
    for t in tables:
        rows = (t.get("rows") or [])[:200]
        if rows:
            vals.append(float(len(rows)))
        by_col: dict = {}
        for row in rows:
            items = row.items() if isinstance(row, dict) else enumerate(row)
            for k, cell in items:
                if isinstance(cell, bool):
                    continue
                v = _finite(cell)
                if v is not None:
                    vals.append(v)
                    by_col.setdefault(k, []).append(v)
                elif isinstance(cell, str):
                    by_col.setdefault(("text", k), set()).add(cell)
                    for _tok, n, _p in extract_numbers(cell):
                        vals.append(n)
        for k, got in by_col.items():
            if isinstance(k, tuple) and k[0] == "text":
                vals.append(float(len(got)))
                continue
            if got and all(-1.0 <= x <= 1.0 for x in got) and any(not float(x).is_integer() for x in got):
                vals += [x * 100 for x in got]  # 2026-10-13 (R45): 0.124 in a rate column is written "12.4%"
            if _DOWN_NAME.search(str(k)):
                vals += [-abs(x) for x in got if x]
    for _tok, n, _p in extract_numbers(extra_text):
        vals.append(n)
    return vals


def _matches(v: float, allowed: list[float], tol: float | None = None) -> bool:
    """Whether `v` is (the magnitude of) a value in `allowed`. With `tol` the written precision decides;
    without it, a 0.6% / 0.051 slack (the legacy rule for a number given without its text)."""
    a = abs(v)
    for x in allowed:
        ax = abs(x)
        if ax == 0:
            if a < 0.05 and (tol is None or a <= tol):
                return True
            continue
        slack = max(tol, ax * 1e-9) if tol is not None else max(0.051, ax * 0.006)
        if abs(a - ax) <= slack + 1e-12:
            return True
    return False


def _candidates(v: float, allowed: list[float], tol: float) -> list[float]:
    a = abs(v)
    return [x for x in allowed if abs(abs(x) - a) <= max(tol, abs(x) * 1e-9) + 1e-12]


def _direction(tok: dict) -> str | None:
    before, after = tok["before"], tok["after"]
    if _DOWN_BEFORE.search(before):
        return "down"
    if _UP_BEFORE.search(before):
        return "up"
    if re.search(r"\b(a|an|the)\s*[$€£₹¥]?\s*$", before, re.I) or tok["pct"]:
        if _DOWN_AFTER.search(after):
            return "down"
        if _UP_AFTER.search(after):
            return "up"
    if tok["explicit_sign"] in ("-", "−"):
        return "down"
    if tok["explicit_sign"] == "+":
        return "up"
    return None


def _is_year(tok: dict) -> bool:
    v = abs(tok["value"])
    if tok["pct"] or tok["currency"] or tok["scale"] != 1.0 or tok["comma"] or tok["frac"] or tok["explicit_sign"]:
        return False
    if not (1900 <= v <= 2100 and float(v).is_integer()):
        return False
    return bool(_YEAR_BEFORE.search(tok["before"]) or _YEAR_AFTER.search(tok["after"])
                or not tok["before"].strip() or re.search(r"[.;:!?]\s*$", tok["before"]))


def _derived_pct(v: float, tol: float, pool: list[float]) -> bool:
    """A percentage worked out from two numbers the same text states: a share (a of b) or a change."""
    a = abs(v)
    for i, x in enumerate(pool):
        for j, y in enumerate(pool):
            if i == j or not y:
                continue
            for cand in (x / y * 100, (x - y) / abs(y) * 100):
                if abs(abs(cand) - a) <= tol + 1e-9:
                    return True
    return False


def unsupported_numbers(text: str, allowed: list[float], premise: list[float] | None = None) -> list[str]:
    """Numbers in `text` that match nothing GD360 computed or read, at the precision they are written
    with. Small counting words (up to 12), years written as years, and a percentage worked out from two
    numbers the same text states are fine. A change whose direction word contradicts the data's sign
    ("rose 12.5%" when it fell 12.5%) is wrong. `premise` holds numbers from the question that the data
    does not show: they may appear only where the text corrects them ("12%, not 40%")."""
    bad = []
    toks = _tokens(text)
    supported: list[float] = []
    for tok in toks:
        v = tok["value"]
        if (not tok["pct"] and not tok["currency"] and tok["scale"] == 1.0 and abs(v) <= 12
                and float(abs(v)).is_integer() and not tok["frac"]):
            continue
        if _is_year(tok):
            continue
        cands = _candidates(v, allowed, tok["tol"])
        if cands:
            d = _direction(tok)
            if d is not None:
                right = [x for x in cands if x == 0 or (x < 0) == (d == "down")]
                if not right:
                    bad.append(tok["token"])
                    continue
            if not tok["pct"]:
                supported.append(abs(v))
            continue
        if premise and _matches(v, premise, tok["tol"]) and _CORRECTION_BEFORE.search(tok["before"]):
            continue
        if tok["pct"] and _derived_pct(v, tok["tol"], supported[-8:] + [abs(t["value"]) for t in toks
                                                                      if not t["pct"] and t is not tok][:8]):
            continue
        bad.append(tok["token"])
    return bad


def premise_numbers(question: str, allowed: list[float]) -> list[float]:
    """Amounts and percentages the question states that the data does not show ("Why did revenue drop
    40%?" when it fell 12%). Plain counts and thresholds ("top 5", "last 28 days") are not premises."""
    out = []
    for tok in _tokens(question or ""):
        strong = tok["pct"] or tok["currency"] or tok["scale"] != 1.0 or _direction(tok) is not None
        if not strong or _is_year(tok):
            continue
        if not _candidates(tok["value"], allowed, tok["tol"]):
            out.append(abs(tok["value"]))
    return out


def premise_tokens(question: str, allowed: list[float]) -> list[str]:
    toks = []
    for tok in _tokens(question or ""):
        strong = tok["pct"] or tok["currency"] or tok["scale"] != 1.0 or _direction(tok) is not None
        if strong and not _is_year(tok) and not _candidates(tok["value"], allowed, tok["tol"]):
            toks.append(tok["token"].lstrip("+-−"))
    return toks
