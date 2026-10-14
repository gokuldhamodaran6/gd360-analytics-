"""
GD360 dates (2026-10-13, R45): one reader for the periods people write.

Before R45 question_check read English month names and relative phrases
well, but numeric and business dates went wrong silently - and the planner
was then told "use exactly this range":

  "1/3/2025 to 31/3/2025"   -> read as January 2025 (US order) or not at all
  "sales on 2025-03-01"     -> the whole of 2025
  "revenue in 03/2025"      -> 2025
  "H1 2025", "FY 2024/25"   -> 2025 / 2024
  "marzo 2025", "März 2025" -> 2025 (the month was lost)
  "between 5 and 10 March"  -> 10 March only
  "last 30 days vs previous 30 days" -> one period, the comparison lost

This module reads those forms. Anything date-like it cannot read for sure
is reported as UNPARSED so the caller sends NO period rather than a wrong
one (the planner then reads the question itself).

Public API
- parse_period(text, today, prefer_day_first=True, fiscal_start_month=None)
      -> {"start", "end", "label", "compare": {"start", "end", "label"} | None, "assumption": str | None} | None
- normalize(text)              -> lower-case text with es/de/fr/pt/it/hi month names read as English ones
- parse_explicit(text, today, prefer_day_first=True, fiscal_start_month=None)
      -> (status, period) where status is "ok" | "unparsed" | None (nothing explicit in the text)
- fiscal_year(end_year, start_month) -> (start date, end date)
- day_first_from_values(values) -> True (d/m/y) | False (m/d/y) | None (can't tell)

`parse_period` is the clean entry point; question_check.parse_period uses
parse_explicit + normalize and keeps its own English relative-date reader
("last 3 months", "this quarter", "since March") for everything else.
"""
from __future__ import annotations

import re
from calendar import monthrange
from datetime import date, timedelta

MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october",
          "november", "december"]
_MON3 = {m[:3]: i + 1 for i, m in enumerate(MONTHS)} | {"sept": 9}
MONTH_RE = (r"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|"
            r"sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)")

# ---- month names in other languages -------------------------------------------------------------
# Spanish, German, French, Portuguese, Italian and common Hindi/Hinglish transliterations. Names that
# are also ordinary words elsewhere ("mars", "mai", "data") are only read as months next to a day or
# a year ("5 mars", "mars 2025").
_FOREIGN = {
    # es
    "enero": 1, "febrero": 2, "marzo": 3, "abril": 4, "mayo": 5, "junio": 6, "julio": 7, "agosto": 8,
    "septiembre": 9, "setiembre": 9, "octubre": 10, "noviembre": 11, "diciembre": 12,
    # de
    "januar": 1, "jänner": 1, "februar": 2, "märz": 3, "maerz": 3, "marz": 3, "juni": 6, "juli": 7,
    "oktober": 10, "dezember": 12,
    # fr
    "janvier": 1, "février": 2, "fevrier": 2, "avril": 4, "juin": 6, "juillet": 7, "août": 8, "aout": 8,
    "septembre": 9, "octobre": 10, "novembre": 11, "décembre": 12, "decembre": 12,
    # pt
    "janeiro": 1, "fevereiro": 2, "março": 3, "marco": 3, "maio": 5, "junho": 6, "julho": 7,
    "setembro": 9, "outubro": 10, "dezembro": 12,
    # it
    "gennaio": 1, "febbraio": 2, "aprile": 4, "maggio": 5, "giugno": 6, "luglio": 7, "settembre": 9,
    "ottobre": 10, "dicembre": 12,
    # hi (transliterated)
    "janvari": 1, "janwari": 1, "farvari": 2, "farwari": 2, "faravari": 2, "aprail": 4, "joon": 6, "julai": 7,
    "agast": 8, "sitambar": 9, "aktubar": 10, "aktoobar": 10, "navambar": 11, "disambar": 12,
}
_AMBIGUOUS_FOREIGN = {"mars": 3, "mai": 5, "marco": 3, "marz": 3}
_FOREIGN_RE = re.compile(r"(?<![\w])(" + "|".join(sorted((re.escape(k) for k in _FOREIGN), key=len, reverse=True)) + r")(?![\w])",
                         re.I)
_AMBIG_RE = re.compile(r"(?<![\w])(\d{1,2}(?:st|nd|rd|th|er|\.)?\s+(?:de\s+)?)?(" + "|".join(_AMBIGUOUS_FOREIGN) +
                       r")(?![\w])(\s*,?\s*(?:de\s+|del\s+)?(?:'\d{2}|\d{4}))?", re.I)
# "5 de marzo de 2025", "marzo del 2025", "März des Jahres"? -> "5 march 2025"
_GLUE = re.compile(rf"\b({MONTH_RE})\s+(?:de|del|di|du|of|des)\s+('?\d{{2}}\b|\d{{4}}\b)", re.I)
_DAY_GLUE = re.compile(rf"\b(\d{{1,2}})(?:\.|º|er)?\s+(?:de|di|du)\s+({MONTH_RE})\b", re.I)


def normalize(text: str) -> str:
    """Lower-case text with other languages' month names read as English ones:
    'ventas de marzo de 2025' -> 'ventas de march 2025'; 'Umsatz im März 2025' -> 'umsatz im march 2025'."""
    t = (text or "").lower()

    def eng(i: int) -> str:
        return MONTHS[i - 1]
    t = _FOREIGN_RE.sub(lambda m: eng(_FOREIGN[m.group(1).lower()]), t)

    def amb(m: re.Match) -> str:
        if not (m.group(1) or m.group(3)):
            return m.group(0)
        return (m.group(1) or "") + eng(_AMBIGUOUS_FOREIGN[m.group(2).lower()]) + (m.group(3) or "")
    t = _AMBIG_RE.sub(amb, t)
    t = _DAY_GLUE.sub(r"\1 \2", t)
    t = _GLUE.sub(r"\1 \2", t)
    return t


# ---- small date helpers --------------------------------------------------------------------------

def _month_end(y: int, m: int) -> date:
    return date(y, m, monthrange(y, m)[1])


def _add_months(y: int, m: int, k: int) -> tuple[int, int]:
    i = y * 12 + (m - 1) + k
    return i // 12, i % 12 + 1


def _valid(y: int, m: int, d: int) -> date | None:
    try:
        return date(y, m, d)
    except ValueError:
        return None


def _year(s: str | None) -> int | None:
    if not s:
        return None
    s = s.strip().strip("'")
    if not s.isdigit():
        return None
    if len(s) == 2:
        return 2000 + int(s)
    if len(s) == 4 and 1900 <= int(s) <= 2100:
        return int(s)
    return None


def _mon(name: str) -> int | None:
    n = name.lower()
    return _MON3.get(n[:4] if n.startswith("sept") else n[:3])


def fmt_day(d: date) -> str:
    return f"{d.day} {MONTHS[d.month - 1][:3].title()} {d.year}"


def fmt_range(a: date, b: date) -> str:
    if a.day == 1 and b == _month_end(b.year, b.month):
        if a.month == 1 and b.month == 12:
            return str(a.year) if a.year == b.year else f"{a.year} – {b.year}"
        if a.year == b.year:
            if a.month == b.month:
                return f"{MONTHS[a.month - 1].title()} {a.year}"
            return f"{MONTHS[a.month - 1].title()} – {MONTHS[b.month - 1].title()} {a.year}"
        return f"{MONTHS[a.month - 1][:3].title()} {a.year} – {MONTHS[b.month - 1][:3].title()} {b.year}"
    if a == b:
        return fmt_day(a)
    if a.year == b.year and a.month == b.month:
        return f"{a.day} – {b.day} {MONTHS[a.month - 1][:3].title()} {a.year}"
    if a.year == b.year:
        return f"{a.day} {MONTHS[a.month - 1][:3].title()} – {b.day} {MONTHS[b.month - 1][:3].title()} {a.year}"
    return f"{fmt_day(a)} – {fmt_day(b)}"


def _recent_year(m: int, d: int | None, today: date) -> int:
    """The most recent year in which (month, day) has started."""
    if d is None:
        return today.year if m <= today.month else today.year - 1
    return today.year if (m, d) <= (today.month, today.day) else today.year - 1


def _fiscal_start(fiscal_start_month: int | None) -> int:
    if fiscal_start_month and 1 <= int(fiscal_start_month) <= 12:
        return int(fiscal_start_month)
    try:
        from ..config import get_settings
        v = int(getattr(get_settings(), "FISCAL_YEAR_START_MONTH", 4) or 4)
        return v if 1 <= v <= 12 else 4
    except Exception:  # noqa: BLE001 - config is optional here
        return 4


def fiscal_year(end_year: int, start_month: int = 4) -> tuple[date, date]:
    """FY ending in `end_year`: FY2025 (Apr start) = 1 Apr 2024 - 31 Mar 2025. A January start is the calendar year."""
    if start_month == 1:
        return date(end_year, 1, 1), date(end_year, 12, 31)
    a = date(end_year - 1, start_month, 1)
    ye, me = _add_months(end_year - 1, start_month, 11)
    return a, _month_end(ye, me)


def _fy_name(end_year: int, start_month: int) -> str:
    if start_month == 1:
        return f"FY{end_year}"
    return f"FY{end_year - 1}/{str(end_year)[2:]}"


def _fy_assumption(end_year: int, start_month: int) -> str:
    a, b = fiscal_year(end_year, start_month)
    first, last = MONTHS[start_month - 1].title(), MONTHS[(start_month - 2) % 12].title()
    return (f"Fiscal year read as {first}–{last}: {_fy_name(end_year, start_month)} = {fmt_day(a)} – {fmt_day(b)}. "
            "Say so if your fiscal year runs differently.")


def _clip_today(a: date, b: date, today: date, label: str) -> tuple[date, date, str]:
    """A period that is under way ends today ('so far'); a wholly past or future one is kept whole."""
    if a <= today < b:
        return a, today, f"{label} so far"
    return a, b, label


def day_first_from_values(values) -> bool | None:
    """From a column's own text dates: True when they are day-first (31/03/2025), False when month-first
    (03/31/2025), None when nothing decides it."""
    dmy = mdy = 0
    for v in list(values or [])[:500]:
        m = re.match(r"^\s*(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})", str(v))
        if not m:
            continue
        a, b = int(m.group(1)), int(m.group(2))
        if a > 12 >= b:
            dmy += 1
        elif b > 12 >= a:
            mdy += 1
    if dmy and not mdy:
        return True
    if mdy and not dmy:
        return False
    return None


# ---- the explicit forms ---------------------------------------------------------------------------

_NUM3 = re.compile(r"(?<![\d/.\-])(\d{1,4})([/.\-])(\d{1,2})\2(\d{1,4})(?![\d/.\-]*\d)")
_NUM2_YM = re.compile(r"(?<![\d/.\-])((?:19|20)\d\d)[/.\-](\d{1,2})(?![\d/.\-]*\d)")
_NUM2_MY = re.compile(r"(?<![\d/.\-])(\d{1,2})[/\-.]((?:19|20)\d\d)(?![\d/.\-]*\d)")
_NUM2_DM = re.compile(r"(?<![\d/.\-])(\d{1,2})/(\d{1,2})(?![\d/.\-]*\d)")
_JOIN = r"\s*(?:to|until|till|through|thru|and|-|–|—)\s*(?:the\s+)?"
_DM_CONTEXT = re.compile(r"(?:\bon|\bfrom|\bsince|\bbetween|\bto|\buntil|\btill|\bthrough|\bthru|-|–)\s*$")
_FY_PAIR = re.compile(r"\b(?:fy|fiscal(?:\s+year)?|financial\s+year)\s*'?((?:19|20)\d\d)\s*[/\-–]\s*'?(\d{2}|(?:19|20)\d\d)\b")
_FY_ONE = re.compile(r"\b(?:fy|fiscal(?:\s+year)?|financial\s+year)\s*'?((?:19|20)\d\d|\d{2})\b(?!\s*[/\-–]\s*\d)")
_FY_BARE_PAIR = re.compile(r"(?<![\d/.\-])((?:19|20)\d\d)\s*[/\-–]\s*(\d{2})(?![\d/.\-]*\d)")
_FY_REL = re.compile(r"\b(this|current|last|previous|prior|next)\s+(?:fiscal|financial)\s+year\b|\b(this|current|last|previous|prior|next)\s+fy\b")
_FQ = re.compile(r"\bq([1-4])\s*(?:of\s+)?(?:fy|fiscal(?:\s+year)?)\s*'?((?:19|20)\d\d|\d{2})(?:\s*[/\-]\s*\d{2,4})?\b")
_HALF = re.compile(r"\b(?:h([12])\b|(first|second|1st|2nd)\s+half\b)\s*(?:of\s+)?(?:(?:the\s+)?(?:year\s+)?)?"
                   r"(?:(fy|fiscal(?:\s+year)?)\s*'?)?('?\d{2}\b|(?:19|20)\d\d\b)?")
_QWORD = re.compile(r"\b(first|second|third|fourth|1st|2nd|3rd|4th)\s+quarter\s+(?:of\s+)?((?:19|20)\d\d)\b")
_DAYS_IN_MONTH = re.compile(
    rf"\b(?:between\s+|from\s+)?(?:the\s+)?(\d{{1,2}})(?:st|nd|rd|th)?{_JOIN}(\d{{1,2}})(?:st|nd|rd|th)?\s+(?:of\s+)?({MONTH_RE})\b"
    r"(?:\s*,?\s*('\d{2}|(?:19|20)\d\d)\b)?")
_MONTH_DAYS = re.compile(
    rf"\b(?:between\s+|from\s+)?({MONTH_RE})\s+(\d{{1,2}})(?:st|nd|rd|th)?(?!\d){_JOIN}(\d{{1,2}})(?:st|nd|rd|th)?\b"
    r"(?!\s*(?:%|k\b|m\b|units|orders|items|days|weeks|months|customers))(?:\s*,?\s*('\d{2}|(?:19|20)\d\d)\b)?")
_SINCE = re.compile(r"\b(?:since|from|after)\s*$")
_UNTIL = re.compile(r"\b(?:until|till|before|up\s+to|through|by)\s*$")

_ORD = {"first": 1, "1st": 1, "second": 2, "2nd": 2, "third": 3, "3rd": 3, "fourth": 4, "4th": 4}


def _num_date(a: int, b: int, c: int, day_first: bool) -> tuple[date | None, bool]:
    """d/m/y (or m/d/y) -> (date, ambiguous?) ; y/m/d when the first part is a 4-digit year."""
    if a >= 1000:
        return _valid(a, b, c), False
    y = c if c >= 100 else 2000 + c
    if a > 12 and b <= 12:
        return _valid(y, b, a), False
    if b > 12 and a <= 12:
        return _valid(y, a, b), False
    if day_first:
        return _valid(y, b, a), a != b
    return _valid(y, a, b), a != b


def _period(a: date, b: date, label: str | None = None, assumption: str | None = None, assumed: bool = False) -> dict:
    return {"start": a, "end": b, "label": label or fmt_range(a, b), "assumption": assumption, "assumed": assumed}


def _numeric_tokens(t: str) -> list[dict]:
    """Every numeric date in the text with its span: full dates, year-month, month/year and (in a date
    context) day/month."""
    out: list[dict] = []
    taken: list[tuple[int, int]] = []

    def free(s: int, e: int) -> bool:
        return all(e <= x or s >= y for x, y in taken)
    for m in _NUM3.finditer(t):
        g1, g4 = m.group(1), m.group(4)
        a, b, c = int(g1), int(m.group(3)), int(g4)
        if len(g1) == 4 and len(g4) <= 2:
            kind = "ymd"
        elif len(g1) <= 2 and (len(g4) == 4 or (len(g4) == 2 and m.group(2) != ".")):
            kind = "dmy"
        elif len(g1) <= 2 and len(g4) <= 2:
            continue  # "1.5.2", "1-2-3" - a version or a count, not a date
        else:
            kind = "bad"
        out.append({"s": m.start(), "e": m.end(), "kind": kind, "a": a, "b": b, "c": c, "raw": m.group(0)})
        taken.append((m.start(), m.end()))
    for m in _NUM2_YM.finditer(t):
        if not free(m.start(), m.end()):
            continue
        y, mm = int(m.group(1)), int(m.group(2))
        if len(m.group(2)) == 2 and mm == (y + 1) % 100 and mm > 12:
            continue  # "2024-25": a fiscal year, read below
        if mm == (y + 1) % 100 and re.search(r"\b(?:fy|fiscal(?:\s+year)?|financial\s+year)\s*'?$", t[:m.start()]):
            continue
        out.append({"s": m.start(), "e": m.end(), "kind": "ym", "y": y, "m": mm, "raw": m.group(0)})
        taken.append((m.start(), m.end()))
    for m in _NUM2_MY.finditer(t):
        if not free(m.start(), m.end()):
            continue
        out.append({"s": m.start(), "e": m.end(), "kind": "ym", "y": int(m.group(2)), "m": int(m.group(1)),
                    "raw": m.group(0)})
        taken.append((m.start(), m.end()))
    for m in _NUM2_DM.finditer(t):
        if not free(m.start(), m.end()):
            continue
        before = t[:m.start()]
        after = t[m.end():]
        ctx = (_DM_CONTEXT.search(before) or re.match(rf"{_JOIN}\d{{1,2}}/\d{{1,2}}\b", after)
               or re.search(rf"\d{{1,2}}/\d{{1,2}}{_JOIN}$", before))
        if not ctx:
            continue  # "1/3 of customers", "top 10/20" - not dates
        out.append({"s": m.start(), "e": m.end(), "kind": "dm", "a": int(m.group(1)), "b": int(m.group(2)),
                    "raw": m.group(0)})
        taken.append((m.start(), m.end()))
    out.sort(key=lambda x: x["s"])
    return out


def _decide_day_first(toks: list[dict], prefer_day_first: bool) -> tuple[bool, bool]:
    """(day first?, was it decided by the numbers themselves?) for a group of d/m tokens read together."""
    for x in toks:
        if x["kind"] in ("dmy", "dm") and x["a"] > 12 >= x["b"]:
            return True, True
        if x["kind"] in ("dmy", "dm") and x["b"] > 12 >= x["a"]:
            return False, True
    return prefer_day_first, False


def _tok_span(x: dict, day_first: bool, today: date, year_hint: int | None = None) -> tuple[date, date] | None:
    if x["kind"] == "ymd":
        d = _valid(x["a"], x["b"], x["c"])
        return (d, d) if d else None
    if x["kind"] == "dmy":
        d, _ = _num_date(x["a"], x["b"], x["c"], day_first)
        return (d, d) if d else None
    if x["kind"] == "ym":
        if not 1 <= x["m"] <= 12:
            return None
        return date(x["y"], x["m"], 1), _month_end(x["y"], x["m"])
    if x["kind"] == "dm":
        dd, mm = (x["a"], x["b"]) if day_first else (x["b"], x["a"])
        if not (1 <= mm <= 12):
            return None
        y = year_hint or _recent_year(mm, dd, today)
        d = _valid(y, mm, dd)
        return (d, d) if d else None
    return None


def _ambiguity_note(toks: list[dict], day_first: bool, decided: bool) -> str | None:
    amb = [x for x in toks if x["kind"] in ("dmy", "dm") and x["a"] <= 12 and x["b"] <= 12 and x["a"] != x["b"]]
    if not amb or decided:
        return None
    order = "day first (dd/mm/yyyy)" if day_first else "month first (mm/dd/yyyy)"
    return f"Read {amb[0]['raw']} as {order}. Say so if you meant it the other way round."


def _numeric(t: str, today: date, prefer_day_first: bool) -> tuple[str | None, dict | None]:
    toks = _numeric_tokens(t)
    if not toks:
        return None, None
    if any(x["kind"] == "bad" for x in toks):
        return "unparsed", None
    day_first, decided = _decide_day_first(toks, prefer_day_first)
    # a range: two dates joined by to / until / and / -
    if len(toks) >= 2:
        x, z = toks[0], toks[1]
        if re.fullmatch(_JOIN, t[x["e"]:z["s"]]) or re.fullmatch(r"\s*(?:-|–|—)\s*", t[x["e"]:z["s"]]):
            year_hint = None
            if z["kind"] in ("dmy", "ymd"):
                sz = _tok_span(z, day_first, today)
                year_hint = sz[0].year if sz else None
            sx = _tok_span(x, day_first, today, year_hint)
            sz = _tok_span(z, day_first, today, (sx[0].year if sx else None) if z["kind"] == "dm" else None)
            if sx and sz and sx[0] > sz[1] and z["kind"] == "dm":
                sz = _tok_span(z, day_first, today, sx[0].year + 1)  # "from 1/12 to 31/1" crosses the new year
            if not sx or not sz or sx[0] > sz[1]:
                return "unparsed", None
            if len(toks) > 2:
                return "unparsed", None
            return "ok", _period(sx[0], sz[1], assumption=_ambiguity_note(toks, day_first, decided),
                                 assumed=any(y["kind"] == "dm" for y in (x, z)))
        return "unparsed", None  # two dates not joined as a range: don't guess which one is meant
    x = toks[0]
    sp = _tok_span(x, day_first, today)
    if not sp:
        return "unparsed", None
    a, b = sp
    note = _ambiguity_note(toks, day_first, decided)
    if _SINCE.search(t[:x["s"]]):
        return "ok", _period(a, today if today >= a else b, f"since {fmt_day(a)}", note)
    if _UNTIL.search(t[:x["s"]]):
        return "unparsed", None  # "until 31/3/2025": no start - the planner reads it from the question
    return "ok", _period(a, b, assumption=note, assumed=x["kind"] == "dm")


def _fiscal(t: str, today: date, start_month: int) -> tuple[str | None, dict | None]:
    m = _FQ.search(t)
    if m:
        q = int(m.group(1))
        ey = _year(m.group(2))
        if not ey:
            return "unparsed", None
        fa, _ = fiscal_year(ey, start_month)
        ys, ms = _add_months(fa.year, fa.month, 3 * (q - 1))
        ye, me = _add_months(ys, ms, 2)
        a, b = date(ys, ms, 1), _month_end(ye, me)
        label = f"Q{q} {_fy_name(ey, start_month)}"
        a, b, label = _clip_today(a, b, today, label)
        return "ok", _period(a, b, label, _fy_assumption(ey, start_month))
    m = _FY_PAIR.search(t) or (None if re.search(r"\b(?:fy|fiscal|financial)\b", t) else _FY_BARE_PAIR.search(t))
    if m:
        y1 = int(m.group(1))
        y2 = _year(m.group(2)) if len(m.group(2)) == 4 else 2000 + int(m.group(2)) if y1 >= 2000 else 1900 + int(m.group(2))
        if not y2 or y2 != y1 + 1:
            return ("unparsed", None) if m.re is _FY_PAIR else (None, None)
        if m.re is _FY_BARE_PAIR and int(m.group(2)) <= 12:
            return None, None  # "2024-12" is December 2024 - read as a month elsewhere
        a, b = fiscal_year(y2, start_month)
        label = _fy_name(y2, start_month)
        a, b, label = _clip_today(a, b, today, label)
        return "ok", _period(a, b, label, _fy_assumption(y2, start_month))
    m = _FY_ONE.search(t)
    if m:
        ey = _year(m.group(1))
        if not ey:
            return "unparsed", None
        a, b = fiscal_year(ey, start_month)
        label = _fy_name(ey, start_month)
        a, b, label = _clip_today(a, b, today, label)
        return "ok", _period(a, b, label, _fy_assumption(ey, start_month))
    m = _FY_REL.search(t)
    if m:
        word = m.group(1) or m.group(2)
        cur_end = today.year + (1 if today.month >= start_month and start_month != 1 else 0)
        ey = cur_end + {"last": -1, "previous": -1, "prior": -1, "next": 1}.get(word, 0)
        a, b = fiscal_year(ey, start_month)
        label = _fy_name(ey, start_month)
        a, b, label = _clip_today(a, b, today, label)
        return "ok", _period(a, b, label, _fy_assumption(ey, start_month))
    return None, None


def _halves(t: str, today: date, start_month: int) -> tuple[str | None, dict | None]:
    m = _HALF.search(t)
    if m and re.match(rf"\s*(?:of\s+)?(?:the\s+)?{MONTH_RE}\b", t[m.end():]):
        return "unparsed", None  # "first half of March" - days, not a half year
    if m:
        h = int(m.group(1)) if m.group(1) else (1 if m.group(2) in ("first", "1st") else 2)
        yr = _year(m.group(4))
        fiscal = bool(m.group(3))
        if fiscal:
            if not yr:
                return "unparsed", None
            fa, _ = fiscal_year(yr, start_month)
            ys, ms = _add_months(fa.year, fa.month, 6 * (h - 1))
            ye, me = _add_months(ys, ms, 5)
            a, b = date(ys, ms, 1), _month_end(ye, me)
            label = f"H{h} {_fy_name(yr, start_month)}"
            a, b, label = _clip_today(a, b, today, label)
            return "ok", _period(a, b, label, _fy_assumption(yr, start_month))
        assumed = yr is None
        if yr is None:
            start = date(today.year, 1 if h == 1 else 7, 1)
            yr = today.year if start <= today else today.year - 1
        a = date(yr, 1 if h == 1 else 7, 1)
        b = _month_end(yr, 6 if h == 1 else 12)
        label = f"H{h} {yr}"
        a, b, label = _clip_today(a, b, today, label)
        return "ok", _period(a, b, label, None, assumed)
    m = _QWORD.search(t)
    if m:
        q, yr = _ORD[m.group(1)], int(m.group(2))
        a = date(yr, 3 * (q - 1) + 1, 1)
        b = _month_end(yr, 3 * q)
        label = f"Q{q} {yr}"
        a, b, label = _clip_today(a, b, today, label)
        return "ok", _period(a, b, label)
    return None, None


def _day_ranges(t: str, today: date) -> tuple[str | None, dict | None]:
    m = _DAYS_IN_MONTH.search(t)
    if m:
        d1, d2, mon, yr = int(m.group(1)), int(m.group(2)), _mon(m.group(3)), _year(m.group(4))
    else:
        m = _MONTH_DAYS.search(t)
        if not m:
            return None, None
        mon, d1, d2, yr = _mon(m.group(1)), int(m.group(2)), int(m.group(3)), _year(m.group(4))
    if not mon:
        return None, None
    y = yr or _recent_year(mon, d1, today)
    a, b = _valid(y, mon, d1), _valid(y, mon, d2)
    if not a or not b or a > b:
        return "unparsed", None
    return "ok", _period(a, b, assumed=yr is None)


def parse_explicit(text: str, today: date | None = None, prefer_day_first: bool = True,
                   fiscal_start_month: int | None = None) -> tuple[str | None, dict | None]:
    """The explicit forms only: numeric dates and ranges, fiscal years and quarters, halves, "third quarter of
    2025", "between 5 and 10 March". Returns ("ok", period), ("unparsed", None) when date-like text is
    there but can't be read for sure, or (None, None) when there is nothing of these forms.
    `period` = {"start": date, "end": date, "label", "assumption", "assumed"}."""
    today = today or date.today()
    t = " " + normalize(text) + " "
    start_month = _fiscal_start(fiscal_start_month)
    for fn in (lambda: _fiscal(t, today, start_month), lambda: _halves(t, today, start_month),
               lambda: _numeric(t, today, prefer_day_first), lambda: _day_ranges(t, today)):
        status, p = fn()
        if status:
            return status, p
    return None, None


# ---- the clean public API ------------------------------------------------------------------------

def _iso(p: dict) -> dict:
    return {"start": p["start"] if isinstance(p["start"], str) else p["start"].isoformat(),
            "end": p["end"] if isinstance(p["end"], str) else p["end"].isoformat(),
            "label": p.get("label") or p.get("text")}


def parse_period(text: str, today: date | None = None, prefer_day_first: bool = True,
                 fiscal_start_month: int | None = None) -> dict | None:
    """The period a question asks about, or None (nothing asked, or date-like text that can't be read for sure).
    {"start": "2025-03-01", "end": "2025-03-31", "label": "March 2025",
     "compare": {"start", "end", "label"} | None, "assumption": str | None}"""
    today = today or date.today()
    from . import question_check as qc  # the English relative-date reader lives there
    p, _alts = qc.parse_period(text, today, prefer_day_first=prefer_day_first, fiscal_start_month=fiscal_start_month)
    if not p:
        return None
    parts = p.get("parts") or []
    if len(parts) >= 2:
        a, b = parts[0], parts[1]
        out = _iso(a)
        out["compare"] = _iso(b)
        notes = [x for x in (a.get("assumption"), b.get("assumption")) if x]
        out["assumption"] = p.get("assumption") or " ".join(dict.fromkeys(notes)) or None
        return out
    out = _iso(p)
    out["compare"] = None
    out["assumption"] = p.get("assumption")
    return out
