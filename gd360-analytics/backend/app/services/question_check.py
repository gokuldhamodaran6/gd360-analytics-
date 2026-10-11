"""
Understand before answering (2026-10-11, round 24).

Before a question is planned, GD360 reads it back and checks it against
the data - the way a good analyst would before spending an hour on it:

  1. the dates      "last 3 months" -> 1 Jul - 30 Sep 2026, said back in words;
                    "January 20258"  -> "did you mean January 2025?";
                    "October 2027"   -> "that hasn't happened yet";
  2. the data       which sources talk about this (names, tables, columns),
                    and which of those can actually answer it: a history
                    needs dated rows and a number to add up - a customer
                    list with no dates can't show "the last 3 months";
  3. the coverage   does the data reach the period asked about? ("your
                    orders stop in January 2025 - use its last 3 months?")

check() returns what was understood, in plain words, plus the issues that
need the person (each with one-tap options) and the sources it would use.
When nothing needs the person it says `ready` and the question runs at once;
otherwise the person answers first (Home shows a card, Euliv asks out loud).
Rule-based and fast (no model call): it must never slow a clear question
down or block one by guessing.
"""
from __future__ import annotations

import concurrent.futures as cf
import difflib
import re
import time
from calendar import monthrange
from datetime import date, datetime, timedelta

import pandas as pd
from sqlalchemy.orm import Session

from .. import models
from .project_engine.catalog import (
    KIND_LABELS, LIVE_DIALECTS, accessible_sources, build_source, freshness_text, source_mode,
)

MAX_CANDIDATES = 6
COVERAGE_BUDGET_S = 4.0
COVERAGE_TTL_S = 30 * 60

MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october",
          "november", "december"]
MON_ABBR = {m[:3]: i + 1 for i, m in enumerate(MONTHS)} | {"sept": 9}
MONTH_NUM = {m: i + 1 for i, m in enumerate(MONTHS)} | MON_ABBR
MONTH_RE = r"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)"
NUMBER_WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9,
                "ten": 10, "eleven": 11, "twelve": 12, "a": 1, "an": 1}
FORECAST = re.compile(r"\b(forecast|predict|projection|project(?:ed)?|expect(?:ed)?|will|next|budget|target|plan(?:ned)?|goal)\b", re.I)
HISTORY = re.compile(r"\b(history|historical|trend|trends|over time|by (?:day|week|month|quarter|year)|daily|weekly|monthly|"
                     r"quarterly|yearly|growth|grew|grow|change|changed|compare|comparison|vs|versus|since|until|between)\b", re.I)

# words that say what the question is about -> measure-ish column names
MEASURE_WORDS = {
    "revenue", "sales", "sale", "amount", "total", "price", "value", "gmv", "income", "turnover", "profit", "margin",
    "cost", "spend", "spent", "budget", "orders", "order", "quantity", "qty", "units", "clicks", "impressions",
    "conversions", "sessions", "users", "visitors", "pageviews", "bookings", "booking", "adr", "rate", "count",
    "refunds", "returns", "discount", "tax", "net", "gross", "fees", "payment", "payments", "subtotal",
}
TOPIC_WORDS = {
    "ecommerce": {"ecommerce", "commerce", "shop", "store", "online", "orders", "order", "cart", "checkout", "product",
                  "products", "sku", "customers"},
    "sales": {"sales", "revenue", "orders", "income", "turnover", "gmv"},
    "marketing": {"marketing", "campaign", "campaigns", "ads", "spend", "clicks", "impressions", "conversions", "roas"},
    "website": {"traffic", "website", "sessions", "visitors", "pageviews", "seo"},
    "customers": {"customers", "customer", "churn", "retention", "ltv", "signups", "subscribers"},
    "finance": {"profit", "margin", "cost", "costs", "expenses", "cash", "invoice", "invoices", "payments"},
    "hotel": {"hotel", "hotels", "booking", "bookings", "rooms", "adr", "occupancy", "guests", "stays"},
    "inventory": {"inventory", "stock", "sku", "warehouse", "units"},
}
TOPIC_LABEL = {"ecommerce": "e-commerce", "sales": "sales", "marketing": "marketing", "website": "website traffic",
               "customers": "customers", "finance": "finances", "hotel": "hotel bookings", "inventory": "inventory"}
TOPIC_APPS = {"ecommerce": ["shopify", "woocommerce"], "sales": ["shopify", "woocommerce", "stripe"],
              "marketing": ["google_ads", "meta_ads"], "website": ["ga4"], "customers": ["hubspot"],
              "finance": ["stripe"], "inventory": ["shopify"]}

DATE_NAME = re.compile(r"(date|_at$|^at$|time|day|month|week|period|year|created|ordered|placed|purchased|booked|arrival|checkin)", re.I)
DATE_GOOD = re.compile(r"(order|transaction|purchase|sale|invoice|booking|payment|created|placed|event|visit|session|arrival|reservation)", re.I)
DATE_BAD = re.compile(r"(birth|dob|expir|updated|modified|deleted|signup|registered|last_login|valid)", re.I)
ID_NAME = re.compile(r"(^id$|_id$|^order|invoice|transaction|booking)", re.I)
NUMERIC_TYPES = re.compile(r"(int|float|double|decimal|numeric|number|real|money|bigint)", re.I)
DATE_TYPES = re.compile(r"(date|time)", re.I)

_WORD = re.compile(r"[a-z0-9]+")
_STOP = {"the", "a", "an", "of", "in", "on", "for", "to", "and", "or", "by", "is", "are", "our", "my", "we", "what", "why",
         "how", "which", "show", "me", "this", "that", "last", "month", "months", "week", "year", "years", "data", "want",
         "check", "over", "history", "whatever", "have", "can", "you", "please", "tell", "give", "with", "from", "all",
         "get", "see", "about", "past", "previous", "there", "doing", "performance", "perform", "performing", "look"}


def words(text: str) -> set[str]:
    out = set()
    for w in _WORD.findall((text or "").lower().replace("_", " ").replace("e-commerce", "ecommerce")):
        if w in _STOP or len(w) < 3:
            continue
        out.add(w)
        if w.endswith("s") and len(w) > 3:
            out.add(w[:-1])
    return out


# ---- dates -------------------------------------------------------------------------

def _month_end(y: int, m: int) -> date:
    return date(y, m, monthrange(y, m)[1])


def _add_months(y: int, m: int, k: int) -> tuple[int, int]:
    i = y * 12 + (m - 1) + k
    return i // 12, i % 12 + 1


def fmt_day(d: date) -> str:
    return f"{d.day} {MONTHS[d.month - 1][:3].title()} {d.year}"


def fmt_range(a: date, b: date) -> str:
    """'July – September 2026', '4 – 10 Oct 2026', 'Nov 2024 – Jan 2025', '2025'."""
    if a.day == 1 and b == _month_end(b.year, b.month):
        if a.month == 1 and b.month == 12 and a.year == b.year:
            return str(a.year)
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


def _period(a: date, b: date, label: str, assumed: bool = False, key: str = "asked") -> dict:
    return {"start": a.isoformat(), "end": b.isoformat(), "label": label, "text": fmt_range(a, b), "assumed": assumed,
            "key": key}


def _num(s: str) -> int | None:
    s = s.lower()
    if s.isdigit():
        return int(s)
    return NUMBER_WORDS.get(s)


def _year_for_month(m: int, today: date) -> int:
    return today.year if m <= today.month else today.year - 1


# round 25: comparisons ("Jan 2026 vs Jan 2025", "this year so far compared to last year"),
# days ("on March 15", "1 Oct 2025 to 31 Mar 2026"), year ranges ("between 2020 and 2024")
# and years that haven't happened yet are all read correctly; a number that only looks
# like a year ("top 2000 customers", "March 15") is never taken as one.
_CMP = re.compile(r"\b(?:vs\.?|versus|compared\s+(?:to|with)|comparing\s+(?:it\s+|that\s+)?(?:to|with)|against|relative\s+to)\b")
_YOY = re.compile(r"\b(?:yoy|year[\s-]+(?:over|on)[\s-]+year)\b")
_MOM = re.compile(r"\b(?:mom|month[\s-]+(?:over|on)[\s-]+month)\b")
_SAME_LY = re.compile(r"\b(?:the\s+)?same\s+(?:period|time|month|quarter|week|days?|months?|dates?)\s+(?:last|a|the\s+previous|previous|the\s+year\s+before)\s*(?:year)?\b")
_BEFORE = re.compile(r"\b(?:the\s+)?(?:month|week|quarter|year|period|day|days|months|weeks)\s+before\b|"
                     r"\b(?:the\s+)?(?:previous|prior|preceding)\s+(?:month|week|quarter|year|period)\b")
_PREP = r"(?:in|of|since|from|during|for|until|till|to|through|between|on|and|early|late|mid|by|before|after)"
_DAY_MON = re.compile(rf"\b(\d{{1,2}})(?:st|nd|rd|th)?\s+(?:of\s+)?({MONTH_RE})\b(?:\s*,?\s*('\d{{2}}|\d{{4}})\b)?")
_MON_DAY = re.compile(rf"\b({MONTH_RE})\s+(\d{{1,2}})(?:st|nd|rd|th)?\b(?!\s*(?:%|k\b|m\b|units|orders|items))(?:\s*,?\s*(\d{{4}})\b)?")
_MON_YR = re.compile(rf"\b({MONTH_RE})\b(?:\s*,?\s*('\d{{2}}|\d{{4}})\b)?")
_RANGE_JOIN = re.compile(r"^\s*(?:to|until|till|through|thru|and|-|–|—)\s*(?:the\s+)?(?:end\s+of\s+)?$")
_NOT_YEAR_BEFORE = {"top", "bottom", "first", "over", "under", "above", "below", "than", "least", "most", "about", "around",
                    "only", "just", "exactly", "approximately", "approx", "max", "min", "limit", "rows", "row", "id", "number",
                    "no", "code", "sku", "zip", "postcode", "room", "store", "#", "x"}
_UNIT_AFTER = {"customers", "customer", "products", "product", "units", "unit", "items", "item", "rows", "records", "people",
               "users", "dollars", "euros", "pounds", "rupees", "usd", "eur", "gbp", "inr", "stores", "employees", "accounts",
               "km", "kg", "miles", "calories", "times", "pieces", "pcs", "skus", "leads", "rooms", "guests", "visitors"}


def _future(p: dict | None, today: date) -> dict | None:
    if p:
        if date.fromisoformat(p["start"]) > today:
            p["future"] = True
        for part in p.get("parts") or []:
            if date.fromisoformat(part["start"]) > today:
                part["future"] = True
    return p


def parse_period(text: str, today: date) -> tuple[dict | None, list[dict]]:
    """(the period the question asks about, other readings worth offering).
    A comparison comes back as one period with `parts` = [the first, the second]."""
    t = " " + (text or "").lower() + " "
    m = _CMP.search(t)
    if m:
        left, right = t[:m.start()] + " ", " " + t[m.end():]
        p1, a1 = _parse_one(left, today)
        p2 = None
        if p1 and _SAME_LY.search(right):
            p2 = _shift_period(p1, months=12)
        elif p1 and _BEFORE.search(right):
            p2 = _shift_period(p1, back=True)
        else:
            p2, _ = _parse_one(right, today)
            # "this year so far vs last year" means the same dates a year earlier - like for like
            if p1 and p2 and p1["end"] == today.isoformat() and p2.get("label") in ("last year", "last month", "last quarter", "last week"):
                p2 = _shift_period(p1, months={"last year": 12, "last quarter": 3, "last month": 1}.get(p2["label"], 0),
                                   days=7 if p2["label"] == "last week" else 0)
        if p1 and p2 and (p1["start"], p1["end"]) != (p2["start"], p2["end"]):
            return _future(_compare(p1, p2), today), []
        if p1 or p2:
            return _future(p1 or p2, today), (a1 if p1 else [])
    p, alts = _parse_one(t, today)
    if p and _YOY.search(t):
        return _future(_compare(p, _shift_period(p, months=12)), today), []
    if p and _MOM.search(t) and date.fromisoformat(p["end"]) - date.fromisoformat(p["start"]) < timedelta(days=32):
        return _future(_compare(p, _shift_period(p, back=True)), today), []
    return _future(p, today), alts


def _compare(p1: dict, p2: dict) -> dict:
    a = min(date.fromisoformat(p1["start"]), date.fromisoformat(p2["start"]))
    b = max(date.fromisoformat(p1["end"]), date.fromisoformat(p2["end"]))
    text = f"{p1['text']} vs {p2['text']}"
    out = _period(a, b, text, assumed=bool(p1.get("assumed") or p2.get("assumed")), key="compare")
    out["text"] = text
    out["parts"] = [p1, p2]
    return out


def _safe_day(y: int, m: int, d: int) -> date:
    return date(y, m, min(d, monthrange(y, m)[1]))


def _shift_period(p: dict, months: int = 0, days: int = 0, back: bool = False) -> dict:
    """The same period moved earlier: by `months`, `days`, or (back=True) by its own length."""
    a, b = date.fromisoformat(p["start"]), date.fromisoformat(p["end"])
    whole_months = a.day == 1 and b == _month_end(b.year, b.month)
    if back:
        if whole_months:
            months = (b.year - a.year) * 12 + b.month - a.month + 1
        else:
            days = (b - a).days + 1
    if months:
        ya, ma = _add_months(a.year, a.month, -months)
        yb, mb = _add_months(b.year, b.month, -months)
        na = date(ya, ma, 1) if whole_months else _safe_day(ya, ma, a.day)
        nb = _month_end(yb, mb) if whole_months else _safe_day(yb, mb, b.day)
    else:
        na, nb = a - timedelta(days=days), b - timedelta(days=days)
    out = _period(na, nb, fmt_range(na, nb), key="compare_to")
    return out


def _mentions(t: str, today: date) -> list[dict]:
    """Every date a question names: '15 March', 'Mar 15, 2025', 'March 2025', "Jan '26", 'October'."""
    found: list[dict] = []
    taken: list[tuple[int, int]] = []

    def free(s: int, e: int) -> bool:
        return all(e <= a or s >= b for a, b in taken)

    def add(s, e, mon, day, yr):
        mm = MONTH_NUM.get(mon[:4] if mon.startswith("sept") else mon[:3])
        if not mm:
            return
        if day is not None and not (1 <= day <= 31):
            return
        found.append({"s": s, "e": e, "m": mm, "d": day, "y": yr})
        taken.append((s, e))

    for m in _DAY_MON.finditer(t):
        if free(m.start(), m.end()):
            add(m.start(), m.end(), m.group(2), int(m.group(1)), _yr(m.group(3)))
    for m in _MON_DAY.finditer(t):
        if free(m.start(), m.end()):
            if m.group(1) == "may" and not m.group(3) and not re.search(rf"\b{_PREP}\s*$", t[:m.start()]):
                continue
            add(m.start(), m.end(), m.group(1), int(m.group(2)), _yr(m.group(3)))
    for m in _MON_YR.finditer(t):
        if free(m.start(), m.end()):
            if m.group(1) == "may" and not m.group(2) and not re.search(rf"\b{_PREP}\s*$", t[:m.start()]):
                continue
            add(m.start(), m.end(), m.group(1), None, _yr(m.group(2)))
    found.sort(key=lambda x: x["s"])
    return found


def _resolve_year(mm: int, dd: int | None, today: date) -> int:
    if dd is None:
        return _year_for_month(mm, today)
    return today.year if (mm, dd) <= (today.month, today.day) else today.year - 1


def _span_of(x: dict, y: int) -> tuple[date, date]:
    if x["d"] is not None and x["d"] <= monthrange(y, x["m"])[1]:
        d = date(y, x["m"], x["d"])
        return d, d
    return date(y, x["m"], 1), _month_end(y, x["m"])


def _mention_label(x: dict, y: int) -> str:
    a, b = _span_of(x, y)
    return fmt_range(a, b)


def _year_ok(t: str, m: re.Match) -> bool:
    """Is this 4-digit number meant as a year? 'in 2025', '2025 revenue' yes; 'top 2000 customers' no."""
    before = re.findall(r"[a-z#$£€]+|\d+", t[:m.start()])
    after = re.findall(r"[a-z]+|\d+", t[m.end():])
    pre, post = t[max(0, m.start() - 1):m.start()], t[m.end():m.end() + 2]
    if pre in ("$", "£", "€", "#", "₹") or post[:1] == "%" or re.match(r"[.,]\d", post):
        return False
    prev = before[-1] if before else ""
    nxt = after[0] if after else ""
    if prev in ("in", "for", "during", "of", "year", "fy", "since", "from", "between", "until", "till", "through", "to", "and", "vs"):
        return True
    if prev in _NOT_YEAR_BEFORE or nxt in _UNIT_AFTER:
        return False
    return True


def _year_period(yr: int, today: date) -> dict:
    if yr < today.year:
        return _period(date(yr, 1, 1), date(yr, 12, 31), str(yr))
    if yr == today.year:
        return _period(date(yr, 1, 1), today, f"{yr} so far")
    return _period(date(yr, 1, 1), date(yr, 12, 31), str(yr))


def _parse_one(t: str, today: date) -> tuple[dict | None, list[dict]]:
    t = " " + t.strip() + " "
    alts: list[dict] = []
    y0, m0 = today.year, today.month

    m = re.search(r"\b(?:last|past|previous|prior|recent)\s+(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(day|week|month|quarter|year)s?\b", t)
    if m:
        n = max(1, min(_num(m.group(1)) or 1, 120))
        unit = m.group(2)
        if unit == "day":
            a, b = today - timedelta(days=n), today - timedelta(days=1)
            return _period(a, b, f"the last {n} days"), []
        if unit == "week":
            a, b = today - timedelta(days=7 * n), today - timedelta(days=1)
            return _period(a, b, f"the last {n} weeks"), []
        months = n * (3 if unit == "quarter" else 12 if unit == "year" else 1)
        ys, ms = _add_months(y0, m0, -months)
        ye, me = _add_months(y0, m0, -1)
        full = _period(date(ys, ms, 1), _month_end(ye, me), f"the last {n} full {unit}s" if n > 1 else f"the last full {unit}",
                       key="full")
        roll_a = date(*_add_months(y0, m0, -months), min(today.day, monthrange(*_add_months(y0, m0, -months))[1]))
        rolling = _period(roll_a, today, f"the last {n} {unit}s up to today" if n > 1 else f"the last {unit} up to today",
                          key="rolling")
        return full, [rolling]

    if re.search(r"\b(ytd|year to date|so far this year|this year so far)\b", t):
        return _period(date(y0, 1, 1), today, "this year so far"), []
    if re.search(r"\b(mtd|month to date|so far this month|this month so far)\b", t):
        return _period(date(y0, m0, 1), today, "this month so far"), []
    if re.search(r"\byesterday\b", t):
        d = today - timedelta(days=1)
        return _period(d, d, "yesterday"), []
    if re.search(r"\btoday\b", t) and not re.search(r"\b(?:up )?to today\b", t):
        return _period(today, today, "today"), []
    if re.search(r"\b(last|previous|past) week\b", t):
        start = today - timedelta(days=today.weekday() + 7)
        return _period(start, start + timedelta(days=6), "last week"), []
    if re.search(r"\bthis week\b", t):
        start = today - timedelta(days=today.weekday())
        return _period(start, today, "this week so far"), []
    if re.search(r"\b(last|previous|past) month\b", t):
        y, mm = _add_months(y0, m0, -1)
        return _period(date(y, mm, 1), _month_end(y, mm), "last month"), []
    if re.search(r"\bthis month\b", t):
        return _period(date(y0, m0, 1), today, "this month so far"), []
    q_now = (m0 - 1) // 3
    if re.search(r"\b(last|previous|past) quarter\b", t):
        y, mm = _add_months(y0, q_now * 3 + 1, -3)
        return _period(date(y, mm, 1), _month_end(*_add_months(y, mm, 2)), "last quarter"), []
    if re.search(r"\bthis quarter\b", t):
        return _period(date(y0, q_now * 3 + 1, 1), today, "this quarter so far"), []
    if re.search(r"\b(last|previous|past) year\b", t):
        return _period(date(y0 - 1, 1, 1), date(y0 - 1, 12, 31), "last year"), []
    if re.search(r"\bthis year\b", t):
        return _period(date(y0, 1, 1), today, "this year so far"), []

    m = re.search(r"\bq([1-4])(?:\s*(?:of\s*)?(?:fy\s*)?('?\d{2}\b|\d{4}\b))?", t)
    if m:
        q = int(m.group(1))
        yr = _yr(m.group(2)) or (y0 if q <= q_now + 1 else y0 - 1)
        if yr:
            a = date(yr, (q - 1) * 3 + 1, 1)
            return _period(a, _month_end(yr, (q - 1) * 3 + 3), f"Q{q} {yr}", assumed=not m.group(2)), []

    ms = _mentions(t, today)
    # two dates joined by "to / until / and / -": a range ("1 Oct 2025 to 31 Mar 2026", "from June to August")
    for x, z in zip(ms, ms[1:]):
        if not _RANGE_JOIN.match(t[x["e"]:z["s"]]):
            continue
        y2 = z["y"] or (None if x["y"] else _resolve_year(z["m"], z["d"], today))
        y1 = x["y"]
        if y1 and not y2:
            y2 = y1 if (z["m"], z["d"] or 31) >= (x["m"], x["d"] or 1) else y1 + 1
        if not y1:
            y1 = y2 if (x["m"], x["d"] or 1) <= (z["m"], z["d"] or 31) else y2 - 1
        a, _ = _span_of(x, y1)
        _, b = _span_of(z, y2)
        if a <= b:
            assumed = not (x["y"] or z["y"])
            return _period(a, b, fmt_range(a, b), assumed=assumed), []
    if ms:
        x = ms[0]
        yr = x["y"] or _resolve_year(x["m"], x["d"], today)
        a, b = _span_of(x, yr)
        if re.search(r"\bsince\s*$", t[:x["s"]]):
            return _period(a, today, f"since {fmt_range(a, b) if x['d'] else MONTHS[x['m'] - 1].title()}", assumed=not x["y"]), []
        label = fmt_range(a, b)
        return _period(a, b, label, assumed=not x["y"]), []

    m = re.search(r"\b(?:from|between)?\s*((?:19|20)\d\d)\s*(?:-|–|to|and|until|till|through)\s*((?:19|20)\d\d)\b", t)
    if m:
        y1, y2 = int(m.group(1)), int(m.group(2))
        if 1990 <= y1 < y2 <= y0 + 5:
            b = date(y2, 12, 31) if y2 != y0 else today
            return _period(date(y1, 1, 1), b, f"{y1} – {y2}"), []
    m = re.search(r"\bsince\s+((?:19|20)\d\d)\b", t)
    if m and 1990 <= int(m.group(1)) <= y0:
        return _period(date(int(m.group(1)), 1, 1), today, f"since {m.group(1)}"), []
    for m in re.finditer(r"(?<![\d.,])\b((?:19|20)\d\d)\b", t):
        yr = int(m.group(1))
        if 1990 <= yr <= y0 + 10 and _year_ok(t, m):
            return _year_period(yr, today), []
    return None, alts


def _yr(s: str | None) -> int | None:
    if not s:
        return None
    s = s.strip("'")
    if not s.isdigit():
        return None
    if len(s) == 2:
        return 2000 + int(s)
    if len(s) == 4 and 1900 <= int(s) <= 2100:
        return int(s)
    return None


def date_issues(text: str, today: date, accepted: list[str] | None = None) -> list[dict]:
    """Years and months that can't be right: 20258, 202, 2027 (future), 'Janury 2025'.
    `accepted`: what the person already said to keep as written - never asked about twice."""
    out: list[dict] = []
    keep = {str(a).lower() for a in accepted or []}
    low = (text or "").lower()
    forecast = bool(FORECAST.search(low))
    strong = rf"(?:{MONTH_RE}|year|fy|q[1-4])"
    weak = r"(?:in|since|during|for|of|until|till|from|to)"
    # after a month / "year" / Q1 any 3-6 digit number is meant as a year; after
    # "in", "since" ... only a 5-6 digit one that ends the phrase ("sales in 20258?"),
    # so "orders of 20150 units" is left alone
    pat = (rf"\b{strong}\s*,?\s*'?(\d{{3,6}})\b"
           rf"|\b{weak}\s+((?:19|20)\d{{2,4}})(?=\s*(?:$|[.,?!;)]|and\b|to\b|vs\b|versus\b|compared\b|until\b))")
    seen = set()
    for m in re.finditer(pat, low):
        if not (m.group(1) or m.group(2)):
            continue
        raw = m.group(1) or m.group(2)
        if raw in seen or raw in keep:
            continue
        seen.add(raw)
        n = int(raw)
        if len(raw) == 4 and 1990 <= n <= today.year:
            continue
        if len(raw) == 4 and n > today.year and forecast:
            continue
        if len(raw) == 3 and not re.match(rf"{MONTH_RE}|year|fy", m.group(0).strip()):
            continue  # "in 250 stores" - a number, not a year
        sugg = _year_guesses(raw, today)
        if len(raw) == 4 and n > today.year:
            text_ = f"{raw} hasn't happened yet."
            kind = "future_year"
        else:
            text_ = f"“{raw}” doesn't look like a year."
            kind = "year_typo"
        if not sugg:
            continue
        opts = [{"id": f"y{y}", "label": str(y), "value": str(y)} for y in sugg[:3]]
        if kind == "future_year":
            opts.append({"id": "keep", "label": f"Keep {raw} - it's a forecast", "value": raw})
        out.append({"id": f"year:{raw}", "kind": kind, "said": raw, "title": f"Did you mean {sugg[0]}?",
                    "text": f"{text_} Did you mean {_or(sugg[:2])}?", "options": opts, "fix": {"from": raw}})
    # a misspelt month right before a year: "Janury 2025"
    for m in re.finditer(r"\b([a-z]{4,10})\s+'?(\d{4})\b", low):
        tok = m.group(1)
        if tok in keep or tok in MONTHS or tok[:3] in MON_ABBR and len(tok) <= 4 or tok in ("year", "since", "during", "until", "from"):
            continue
        close = difflib.get_close_matches(tok, MONTHS, n=1, cutoff=0.78)
        if close:
            right = close[0].title()
            out.append({"id": f"month:{tok}", "kind": "month_typo", "said": tok, "title": f"Did you mean {right}?",
                        "text": f"Did you mean {right} {m.group(2)}?",
                        "options": [{"id": "fix", "label": f"{right} {m.group(2)}", "value": right},
                                    {"id": "keep", "label": "Keep as written", "value": tok}],
                        "fix": {"from": tok}})
    return out


def _year_guesses(raw: str, today: date) -> list[int]:
    cands = set()
    if len(raw) >= 5:
        for i in range(len(raw)):
            s = raw[:i] + raw[i + 1:]
            if len(s) == 4:
                cands.add(int(s))
        if len(raw) == 6:
            cands.add(int(raw[:4]))
    elif len(raw) == 3:
        for d in "0123456789":
            for i in range(4):
                cands.add(int(raw[:i] + d + raw[i:]))
    else:
        n = int(raw)
        if n > today.year:
            cands |= {today.year, today.year - 1}
    good = [y for y in cands if 2000 <= y <= today.year]
    good.sort(key=lambda y: (abs(today.year - y), -y))
    return good


def _or(items: list) -> str:
    items = [str(i) for i in items]
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + " or " + items[-1]


# ---- the data --------------------------------------------------------------------------

def _source_tables(db: Session, ds: models.DataSource, user: models.User) -> list[tuple[str, str | None, list[dict]]]:
    """(display name, load key, [{name, type}]) for each table of a source."""
    try:
        src = build_source(db, ds, user)
    except Exception:  # noqa: BLE001 - a broken source never breaks the check
        return []
    return [(t.name, t.source_key, t.columns) for t in src.tables]


def _date_col(cols: list[dict]) -> str | None:
    best, score = None, 0
    for c in cols:
        name, typ = str(c.get("name") or ""), str(c.get("type") or "")
        s = 0
        if DATE_TYPES.search(typ) and not re.search(r"interval", typ, re.I):
            s += 3
        if DATE_NAME.search(name):
            s += 2
        if s == 0:
            continue
        if DATE_GOOD.search(name):
            s += 2
        if DATE_BAD.search(name):
            s -= 4
        if s > score:
            best, score = name, s
    return best if score >= 2 else None


def _measures(cols: list[dict], q_words: set[str]) -> list[str]:
    out = []
    for c in cols:
        name, typ = str(c.get("name") or ""), str(c.get("type") or "")
        w = words(name)
        numeric = bool(NUMERIC_TYPES.search(typ)) or not typ
        if numeric and (w & MEASURE_WORDS) and not ID_NAME.search(name):
            out.append(name)
    out.sort(key=lambda n: -len(words(n) & q_words))
    return out


def _topic(qw: set[str]) -> str | None:
    best, score = None, 0
    for k, ws in TOPIC_WORDS.items():
        s = len(qw & ws)
        if s > score:
            best, score = k, s
    return best


def _named(question: str, ds: models.DataSource) -> bool:
    low = " " + re.sub(r"[^a-z0-9]+", " ", question.lower()) + " "
    name = re.sub(r"[^a-z0-9]+", " ", (ds.name or "").lower()).strip()
    if len(name) >= 4 and (f" {name} " in low or name.replace(" ", "") in low.replace(" ", "")):
        return True
    return False


def _score(ds: models.DataSource, tables, qw: set[str], topic: str | None, named: bool) -> tuple[int, str]:
    name_w = words(ds.name or "")
    table_w, col_w = set(), set()
    for tname, _key, cols in tables[:60]:
        table_w |= words(tname)
        for c in cols[:120]:
            col_w |= words(str(c.get("name") or ""))
    s = 4 * len(qw & name_w) + 2 * len(qw & table_w) + 2 * len(qw & col_w)
    if topic:
        tw = TOPIC_WORDS[topic] - qw
        s += 2 * len(tw & name_w) + len(tw & table_w) + min(3, len(tw & col_w))
        if ds.kind in TOPIC_APPS.get(topic, []):
            s += 5
    why = "named in your question" if named else ""
    if named:
        s += 100
    return s, why


# coverage cache: (ds id, table, column) -> (at, lo, hi, rows)
_COV: dict[tuple, tuple] = {}


COVERAGE_FAIL_TTL_S = 2 * 60
COVERAGE_CACHE_MAX = 500


def _cov_version(ds: models.DataSource) -> str:
    """Changes when the data does (a sync, a re-upload, a clean) - so a fresh sync is never judged by an old range."""
    v = getattr(ds, "last_synced_at", None) or getattr(ds, "cleaned_updated_at", None) or getattr(ds, "created_at", None)
    return str(v or "")


def _coverage(db: Session, ds: models.DataSource, table_name: str, key: str | None, col: str) -> tuple[date, date] | None:
    ck = (ds.id, key or table_name, col, _cov_version(ds))
    hit = _COV.get(ck)
    if hit and time.time() - hit[0] < (COVERAGE_TTL_S if hit[1] else COVERAGE_FAIL_TTL_S):
        return (hit[1], hit[2]) if hit[1] else None
    if len(_COV) > COVERAGE_CACHE_MAX:
        for k in sorted(_COV, key=lambda k: _COV[k][0])[: COVERAGE_CACHE_MAX // 2]:
            _COV.pop(k, None)
    mode = source_mode(ds.kind)
    if mode == "file" and ds.kind not in ("csv", "excel", "file"):
        # read-on-demand sources (Google Sheets, Excel Online, MongoDB, APIs) would be fetched just to
        # check dates - not worth the wait here; the answer itself still reads them
        return None
    lo = hi = None
    try:
        if mode == "live":
            from . import warehouse_exec
            from .profiling import _quote_ident
            ref = key or table_name
            tref = f"`{ref}`" if ds.kind == "bigquery" else ".".join(_quote_ident(ds.kind, p) for p in ref.split("."))
            qc = _quote_ident(ds.kind, col)
            df, _ = warehouse_exec.run_sql(ds, f"SELECT MIN({qc}) AS lo, MAX({qc}) AS hi FROM {tref}")
            if len(df):
                lo, hi = _as_date(df.iloc[0, 0]), _as_date(df.iloc[0, 1])
        else:
            if mode == "synced":
                from . import synced_sources
                frame = synced_sources.load_table(db, ds.id, key)
            else:
                from . import data_loader
                frame = data_loader.load_dataframe(ds, table=key, db=db)
            if col in frame.columns:
                s = pd.to_datetime(frame[col], errors="coerce", utc=False)
                s = s.dropna()
                if len(s):
                    lo, hi = _as_date(s.min()), _as_date(s.max())
    except Exception as e:  # noqa: BLE001 - coverage is a nice-to-have
        print(f"[question_check] coverage of {ds.name}.{table_name}.{col} unavailable: {str(e)[:160]}")
        _COV[ck] = (time.time(), None, None)
        return None
    _COV[ck] = (time.time(), lo, hi)
    return (lo, hi) if lo and hi else None


def _as_date(v) -> date | None:
    if v is None:
        return None
    try:
        if isinstance(v, datetime):
            return v.date()
        if isinstance(v, date):
            return v
        ts = pd.to_datetime(v, errors="coerce")
        if pd.isna(ts):
            return None
        return ts.date()
    except Exception:  # noqa: BLE001
        return None


def _source_brief(ds: models.DataSource) -> dict:
    return {"id": ds.id, "name": ds.name, "kind": ds.kind, "label": KIND_LABELS.get(ds.kind, ds.kind),
            "freshness": freshness_text(ds)}


# ---- the check ---------------------------------------------------------------------------

def check(db: Session, user: models.User, question: str, *, source_ids: list[str] | None = None,
          space_id: str | None = None, workspace_id: str | None = None, today: date | None = None,
          coverage: bool = True, accepted: list[str] | None = None) -> dict:
    today = today or date.today()
    q = (question or "").strip()
    issues: list[dict] = []
    issues += date_issues(q, today, accepted)
    period, alts = (None, []) if any(i["kind"] in ("year_typo", "month_typo") for i in issues) else parse_period(q, today)
    qw = words(q)
    topic = _topic(qw)
    needs_time = bool(period) or bool(HISTORY.search(q))

    # the sources in play: the ones picked on Home (a Space or chosen sources), else everything this person can use
    scoped = False
    if space_id:
        from . import spaces as spaces_service
        space = spaces_service.get_space(db, user, space_id)
        ids = spaces_service.space_source_ids(db, user, space.id) if space else []
        pool = [s for s in accessible_sources(db, user) if s.id in set(ids)]
        scoped = True
    elif source_ids:
        allowed = {s.id: s for s in accessible_sources(db, user)}
        pool = [allowed[i] for i in source_ids if i in allowed]
        scoped = True
    else:
        pool = accessible_sources(db, user, workspace_id)

    scored = []
    for ds in pool:
        tables = _source_tables(db, ds, user)
        named = _named(q, ds)
        s, why = _score(ds, tables, qw, topic, named)
        scored.append((s, ds, tables, named, why))
    scored.sort(key=lambda r: -r[0])
    relevant = [r for r in scored if r[0] > 0][:MAX_CANDIDATES] if not scoped else scored[:MAX_CANDIDATES]

    t_start = time.time()
    cands: list[dict] = []
    for s, ds, tables, named, why in relevant:
        best_t = None
        for tname, key, cols in tables:
            dcol = _date_col(cols)
            meas = _measures(cols, qw)
            tw = len(words(tname) & (qw | TOPIC_WORDS.get(topic or "", set())))
            rank = (2 if dcol else 0) + (2 if meas else 0) + tw + (1 if any(ID_NAME.search(str(c.get("name"))) for c in cols) else 0)
            if best_t is None or rank > best_t[0]:
                best_t = (rank, tname, key, dcol, meas)
        c = _source_brief(ds) | {"score": s, "named": named, "table": best_t[1] if best_t else None,
                                 "date_column": best_t[3] if best_t else None,
                                 "measures": (best_t[4] if best_t else [])[:4], "coverage": None, "fit": "good",
                                 "why": why}
        if not tables:
            c["fit"], c["why"] = "none", "no tables I can read yet"
        elif needs_time and not c["date_column"]:
            c["fit"] = "no_dates"
            c["why"] = "has no dates, so it can't show a period or a trend"
        elif not c["measures"] and not any(ID_NAME.search(str(col.get("name"))) for _t, _k, cols in tables for col in cols):
            c["fit"] = "weak"
            c["why"] = c["why"] or "has nothing to count or add up"
        cands.append(c)

    # coverage for the strongest few that have dates (time-boxed)
    if coverage and needs_time and period and not period.get("future"):
        todo = [c for c in cands if c["fit"] == "good" and c["date_column"]][:3]
        # round 25b: a person with row/column rules on a source never hears its full date range
        # (it would describe rows they can't see) - unknown coverage is never a blocker
        try:
            from . import data_access_rules
            restricted = {r[1].id for r in relevant if data_access_rules.has_active_restrictions(db, r[1], user)}
        except Exception:  # noqa: BLE001
            restricted = {r[1].id for r in relevant}
        todo = [c for c in todo if c["id"] not in restricted]
        if todo:
            by_id = {r[1].id: r for r in relevant}
            from .project_engine.executor import _detached
            pool_ex = cf.ThreadPoolExecutor(max_workers=3)
            futs = {}
            try:
                for c in todo:
                    r = by_id[c["id"]]
                    key = next((k for n, k, _ in r[2] if n == c["table"]), None)
                    if source_mode(r[1].kind) == "live":
                        # warehouses run in worker threads, on a detached copy of the source
                        futs[pool_ex.submit(_coverage, None, _detached(r[1]), c["table"], key, c["date_column"])] = c
                    elif time.time() - t_start < COVERAGE_BUDGET_S:
                        # files and synced apps read through the session - here, in order
                        c["coverage"] = _cov_out(_coverage(db, r[1], c["table"], key, c["date_column"]))
                for f, c in futs.items():
                    try:
                        c["coverage"] = _cov_out(f.result(timeout=max(0.2, COVERAGE_BUDGET_S - (time.time() - t_start))))
                    except Exception:  # noqa: BLE001 - too slow: unknown, never a blocker
                        c["coverage"] = None
            finally:
                pool_ex.shutdown(wait=False, cancel_futures=True)
            a, b = date.fromisoformat(period["start"]), date.fromisoformat(period["end"])
            for c in todo:
                cov = c.get("coverage")
                if not cov:
                    continue
                lo, hi = date.fromisoformat(cov["start"]), date.fromisoformat(cov["end"])
                if hi < a or lo > b:
                    c["fit"] = "out_of_range"
                    c["why"] = f"its dates run {cov['text']} - nothing in {period['text']}"
                elif hi < b - timedelta(days=3) and b <= today and not period.get("parts"):
                    c["partial"] = f"its data stops on {fmt_day(hi)}"
                if period.get("parts") and c["fit"] == "good":
                    # a comparison needs both periods: which of them does this data have?
                    has = [i for i, p in enumerate(period["parts"])
                           if not (hi < date.fromisoformat(p["start"]) or lo > date.fromisoformat(p["end"]))]
                    c["covers_parts"] = has
                    if len(has) < len(period["parts"]):
                        c["only"] = " and ".join(period["parts"][i]["text"] for i in has)

    for c in cands:
        if c["fit"] == "good" and not c["why"]:
            bits = []
            if c["date_column"] and needs_time:
                bits.append(f"dated by {c['date_column']}")
            if c["measures"]:
                bits.append(", ".join(c["measures"][:2]))
            if c.get("coverage"):
                bits.append(c["coverage"]["text"])
            c["why"] = " · ".join(bits) or (f"table {c['table']}" if c["table"] else "")

    # a word the question names that only some sources have as a column ("customers by city"):
    # the ones without it can't split by it
    colwords = []
    for _s, _ds, tables, _n, _w in relevant:
        cw = set()
        for _t, _k, cols in tables:
            for col in cols:
                cw |= words(str(col.get("name") or ""))
        colwords.append(cw)
    generic = MEASURE_WORDS | set().union(*TOPIC_WORDS.values()) | {"customer", "customers", "order", "orders", "product",
                                                                     "products", "date", "time", "name", "type"}
    dims = [w for w in qw - generic if len(w) >= 3 and any(w in cw for cw in colwords) and not all(w in cw for cw in colwords)]
    if dims:
        for c, cw in zip(cands, colwords):
            c["dims"] = [d for d in dims if d in cw]
            if c["fit"] == "good" and not any(d in cw for d in dims):
                c["fit"], c["why"] = "weak", f"has no {dims[0]} column"

    for c in cands:
        c["says"] = _says_fit(c, needs_time)
    good = [c for c in cands if c["fit"] == "good"]
    unfit = [c for c in cands if c["fit"] != "good"]
    picked: list[dict] = []
    connect = [{"kind": k, "label": KIND_LABELS.get(k, k), "url": f"/data?tab=catalog&connect={k}"}
               for k in TOPIC_APPS.get(topic or "", []) if not any(s.kind == k for s in pool)][:2]
    what = _what(q, qw, topic)
    if dims and not what.startswith("“"):
        what += " by " + " and ".join(dims[:2])
    top_score = cands[0]["score"] if cands else 0
    for_period = f" for {period['text']}" if period else ""

    def opt(c: dict, rec: bool = False) -> dict:
        return {"id": c["id"], "label": c["name"], "detail": f"{c['label']} · {c['why']}" if c.get("why") else c["label"],
                "value": c["id"], "recommended": rec, "fit": c["fit"], "why": c.get("why") or ""}

    named_good = [c for c in good if c["named"]]
    named_bad = [c for c in unfit if c["named"]]
    if scoped and len(pool) == 1:
        c = cands[0] if cands else None
        if c and c["fit"] != "good":
            issues.append(_cant_issue([c], [], period, what, connect))
        elif c:
            picked = [c]
    elif named_good:
        picked = named_good
    elif named_bad and good:
        # they named data that can't answer this - say so, and offer what can
        bad, alt = named_bad[0], good[0]
        picked = [alt]
        issues.append({
            "id": "swap", "kind": "swap", "title": f"{bad['name']} can't answer that",
            "text": f"{bad['says']}. {alt['says']}. Shall I use {alt['name']} instead?",
            "options": [opt(alt, True)] + [opt(c) for c in good[1:3]] + [opt(bad)], "multi": True,
        })
    elif not good:
        issues.append(_cant_issue(unfit, [], period, what, connect))
    else:
        gtop = good[0]["score"]
        close = [c for c in good if c["score"] >= max(1, gtop * 0.5)]
        notable = [c for c in unfit if c["score"] >= max(1, top_score * 0.5)]
        if scoped:
            picked = close
        elif len(close) >= 2:
            picked = [close[0]]
            issues.append({
                "id": "choose", "kind": "choose", "title": "Which data should I use?",
                "text": f"I found {what} in {len(close)} places. Which should I use?",
                "options": [opt(c, i == 0) for i, c in enumerate(close)] + [opt(c) for c in notable[:2]],
                "multi": True,
            })
        elif notable:
            picked = [close[0]]
            reasons = "; ".join(c["says"] for c in notable[:2])
            issues.append({
                "id": "confirm_pick", "kind": "confirm_pick", "title": f"Only {close[0]['name']} can answer this",
                "text": (f"Only {close[0]['name']} has {what}{for_period}" + (f" - {reasons}." if reasons else ".")
                         + f" Shall I use {close[0]['name']}?"),
                "options": [opt(close[0], True)] + [opt(c) for c in notable[:3]], "multi": True,
            })
        else:
            picked = close[:1]

    # the period vs the data: offer the data's own latest window
    if period and not period.get("parts"):
        oor = [c for c in cands if c["fit"] == "out_of_range"]
        if oor and not good:
            c = oor[0]
            cov = c["coverage"]
            hi = date.fromisoformat(cov["end"])
            span = (date.fromisoformat(period["end"]) - date.fromisoformat(period["start"])).days
            shifted = _shift_to(hi, span, period)
            for i in (issues if shifted else []):
                if i["kind"] == "cant_answer":
                    i["options"].insert(0, {"id": "shift", "label": f"Use its latest {_span_words(period)}: {shifted['text']}",
                                            "value": c["id"], "period": shifted, "recommended": True})
                    i["text"] = (f"{c['name']} has {what}, but its dates run {cov['text']} - nothing in {period['text']}. "
                                 f"I can use its latest {_span_words(period)} instead ({shifted['text']}).")

    # a comparison no single source can make: put together the sources that have each period
    if period and period.get("parts") and not any(i["kind"] in ("cant_answer", "swap") for i in issues):
        whole = [c for c in good if "covers_parts" in c and not c.get("only")]
        halves = [c for c in good if c.get("only")]
        if not whole and halves and not (picked and all(not c.get("only") for c in picked)):
            combo, got = [], set()
            for c in halves:
                new = set(c["covers_parts"]) - got
                if new:
                    combo.append(c)
                    got |= new
            if len(got) == len(period["parts"]) and len(combo) >= 2:
                picked = combo
                issues = [i for i in issues if i["kind"] not in ("choose", "confirm_pick")]
                bits = "; ".join(f"{c['name']} has {c['only']}" for c in combo)
                issues.append({
                    "id": "combine", "kind": "confirm_pick", "title": "No one source has both periods",
                    "text": f"No one source has both periods: {bits}. Shall I use them together?",
                    "options": [opt(c, True) for c in combo], "multi": True,
                })
            elif picked and picked[0].get("only"):
                issues = [i for i in issues if i["kind"] not in ("choose", "confirm_pick")]
                issues.append({
                    "id": "half", "kind": "confirm_pick", "title": "Only part of the comparison",
                    "text": f"{picked[0]['name']} only has {picked[0]['only']}, so I can't compare both periods from it. "
                            "Shall I use it anyway, or pick other data?",
                    "options": [opt(c, n == 0) for n, c in enumerate(good[:4])], "multi": True,
                })

    ready = not issues
    restated = _restate(what, period, picked, needs_time)
    return {
        "question": q,
        "ready": ready,
        "what": what,
        "topic": topic,
        "period": period,
        "period_options": ([period] + alts) if period and alts else [],
        "needs_time": needs_time,
        "issues": issues,
        "candidates": cands,
        "picked": [c["id"] for c in picked],
        "picked_sources": [{"id": c["id"], "name": c["name"], "label": c["label"]} for c in picked],
        "restated": restated,
        "connect": connect,
        "sources_considered": len(pool),
    }


def _human(col: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[_\-]+", " ", col)).strip().lower()


def _says_fit(c: dict, needs_time: bool) -> str:
    """One plain sentence about a source and this question - "Shop_Orders has revenue by date, Nov 2025 – Oct 2026"."""
    name, cov = c["name"], c.get("coverage")
    fit = c.get("fit")
    if fit == "no_dates":
        return f"{name} has no dates, so it can't show a period or a trend"
    if fit == "out_of_range" and cov:
        return f"{name} only covers {cov['text']}"
    if fit in ("weak", "none"):
        return f"{name} {c.get('why') or 'can not answer this'}"
    meas = [_human(m) for m in (c.get("measures") or [])[:2]]
    what = " and ".join(meas) if meas else "the records"
    if c.get("dims"):
        what += " by " + " and ".join(c["dims"][:2])
    if needs_time and c.get("date_column"):
        tail = f" ({cov['text']})" if cov else ""
        if c.get("only"):
            return f"{name} has {what} by date{tail} - only {c['only']} of the two periods"
        return f"{name} has {what} by date{tail}"
    return f"{name} has {what}"


def _cov_out(cov: tuple[date, date] | None) -> dict | None:
    if not cov:
        return None
    lo, hi = cov
    text = fmt_range(date(lo.year, lo.month, 1), _month_end(hi.year, hi.month))
    return {"start": lo.isoformat(), "end": hi.isoformat(), "text": text}


def _shift_to(hi: date, span_days: int, period: dict) -> dict:
    """The same length of time, ending where the data ends (None when the period makes no sense)."""
    a0, b0 = date.fromisoformat(period["start"]), date.fromisoformat(period["end"])
    if b0 < a0 or span_days < 0:
        return None
    if a0.day == 1 and b0 == _month_end(b0.year, b0.month):
        months = (b0.year - a0.year) * 12 + b0.month - a0.month + 1
        ye, me = hi.year, hi.month
        ys, ms = _add_months(ye, me, -(months - 1))
        return _period(date(ys, ms, 1), _month_end(ye, me), "its latest month" if months == 1 else f"its latest {months} months", key="shift")
    return _period(hi - timedelta(days=span_days), hi, f"its latest {span_days + 1} days", key="shift")


def _span_words(period: dict) -> str:
    a, b = date.fromisoformat(period["start"]), date.fromisoformat(period["end"])
    months = (b.year - a.year) * 12 + b.month - a.month + 1
    if a.day == 1 and b == _month_end(b.year, b.month):
        return "month" if months == 1 else f"{months} months"
    return f"{(b - a).days + 1} days"


def _others(db, user, workspace_id, pool, exclude: set | None = None) -> list[dict]:
    exclude = exclude or set()
    rows = accessible_sources(db, user, workspace_id)
    return [_source_brief(s) for s in rows if s.id not in exclude][:12]


def _cant_issue(weak: list[dict], others: list[dict], period: dict | None, what: str, connect: list[dict]) -> dict:
    if weak:
        c = weak[0]
        text = f"{c['name']} {c['why']}." if c.get("why") else f"{c['name']} can't answer this."
        if len(weak) > 1:
            text += " " + " ".join(f"{x['name']} {x['why']}." for x in weak[1:3] if x.get("why"))
        text += " Which data should I use instead?"
    else:
        text = f"I couldn't find {what} in your sources. Which data should I use?"
    opts = [{"id": o["id"], "label": o["name"], "detail": o["label"], "value": o["id"]} for o in others[:6]]
    opts.append({"id": "more", "label": "Show all my data", "value": "more", "action": "more"})
    opts += [{"id": f"connect:{c['kind']}", "label": f"Connect {c['label']}", "value": c["url"], "action": "connect"}
             for c in connect]
    opts.append({"id": "upload", "label": "Upload a file", "value": "/data?tab=catalog&upload=1", "action": "upload"})
    if weak:
        opts.append({"id": "anyway", "label": f"Try {weak[0]['name']} anyway", "value": weak[0]["id"]})
    return {"id": "cant", "kind": "cant_answer", "title": "This data can't answer that yet", "text": text,
            "options": opts, "multi": False}


def _what(q: str, qw: set[str], topic: str | None) -> str:
    meas = [w for w in ("revenue", "sales", "orders", "profit", "spend", "conversions", "bookings", "traffic", "customers")
            if w in qw or w.rstrip("s") in qw]
    if topic and meas:
        base = TOPIC_LABEL[topic]
        lead = [m for m in meas if m not in base][:2]
        return f"your {base} {' and '.join(lead)}".strip() if lead else f"your {base} numbers"
    if meas:
        return "your " + " and ".join(meas[:2])
    if topic:
        return f"your {TOPIC_LABEL[topic]} data"
    core = _strip_period(q)
    return f"“{core}”" if core else "your question"


_PERIOD_WORDS = re.compile(
    rf"\b(?:(?:in|for|during|over|from|since|of)\s+)?(?:the\s+)?(?:(?:last|past|previous|prior|this|next)\s+(?:\d+\s+|"
    rf"(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+)?(?:full\s+)?(?:days?|weeks?|months?|quarters?|years?)|"
    rf"ytd|year to date|so far this year|yesterday|today|q[1-4](?:\s*\d{{2,4}})?|{MONTH_RE}(?:\s+\d{{4}})?|(?:19|20)\d\d)\b",
    re.I)


def _strip_period(q: str) -> str:
    s = _PERIOD_WORDS.sub(" ", q or "")
    s = re.sub(r"\s+", " ", s).strip(" ?.!,")
    return s[:90]


def _part_words(p: dict) -> str:
    return p["label"] + (f" ({p['text']})" if p.get("label") != p.get("text") else "")


def _restate(what: str, period: dict | None, picked: list[dict], needs_time: bool) -> str:
    s = what[0].upper() + what[1:]
    if period and period.get("parts"):
        a, b = period["parts"][:2]
        s += f", comparing {_part_words(a)} with {_part_words(b)}"
        if a.get("future") or b.get("future"):
            s += " (part of it is a forecast - it hasn't happened yet)"
    elif period:
        s += f" for {_part_words(period)}"
        if period.get("future"):
            s += " (a forecast - it hasn't happened yet)"
    elif needs_time:
        s += " over all the dates in the data"
    if picked:
        names = [c["name"] for c in picked]
        s += ", from " + (names[0] if len(names) == 1 else ", ".join(names[:-1]) + " and " + names[-1])
    return s + "."


def apply_fixes(question: str, fixes: dict[str, str]) -> str:
    """{"20258": "2025", "janury": "January"} -> the question with those words replaced."""
    out = question
    for raw, value in (fixes or {}).items():
        if raw and value and raw != value:
            out = re.sub(rf"\b{re.escape(raw)}\b", value, out, flags=re.I)
    return out


def planner_context(brief: dict | None) -> str:
    """The agreement made before planning, as the planner reads it."""
    if not brief:
        return ""
    lines = []
    p = brief.get("period")
    parts = [x for x in (p or {}).get("parts") or [] if isinstance(x, dict) and x.get("start") and x.get("end")]
    if len(parts) >= 2:
        a, b = parts[:2]
        lines.append(f"- Compare two periods, exactly these date ranges (inclusive): {a['start']} to {a['end']} "
                     f"({a.get('text') or ''}) versus {b['start']} to {b['end']} ({b.get('text') or ''}). "
                     "Show both side by side and the change between them.")
    elif p and p.get("start") and p.get("end"):
        lines.append(f"- Period: {p['start']} to {p['end']} inclusive ({p.get('text') or ''}). Use exactly this date range.")
    if p and (p.get("future") or any(x.get("future") for x in parts)):
        lines.append("- Some of that period hasn't happened yet: forecast it from the history and say it is a forecast; "
                     "never treat the missing future rows as zero.")
    if brief.get("restated"):
        lines.append(f"- What the person confirmed they want: {brief['restated']}")
    for n in brief.get("notes") or []:
        lines.append(f"- {n}")
    if not lines:
        return ""
    return "\n\nAgreed with the person before planning:\n" + "\n".join(lines)
