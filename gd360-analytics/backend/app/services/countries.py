"""
Country resolution on the server (2026-10-07, chart-types round).

The browser decides "is this a country column, and which country is this
value" with frontend/src/dashboard/charts/worldMap.ts (resolveCountry /
countryColumnScore). The server has to make the SAME decision when it
recommends a chart type ("Country column with 142 values -> map"), so:

  DATA  country_codes.json, beside this file - the asset's own tables
        (ISO3 / ISO2 / numeric / name, the alias lists, the legacy codes,
        the "no country" words), written by
        frontend/scripts/export-country-codes.mjs FROM worldMap.ts. One
        source of truth; re-run the script when the asset is regenerated.
  CODE  this module - a line-by-line port of the asset's norm(),
        resolveCountry() and countryColumnScore(). Parity is tested on 300
        inputs against the TypeScript (test_charts_forecast.py).

Nothing here reads a database or the network.
"""
from __future__ import annotations

import json
import re
import unicodedata
from functools import lru_cache
from pathlib import Path

_DATA_PATH = Path(__file__).with_name("country_codes.json")

# What JavaScript's \s and String.prototype.trim() treat as white space
# (ECMAScript WhiteSpace + LineTerminator) - Python's own \s differs on a
# few code points (U+FEFF), and parity with the browser is the point.
_JS_WS = "\t\n\x0b\x0c\r                  　﻿"
_JS_WS_CLASS = "[" + re.escape(_JS_WS) + "]"

_FOLD = {"ø": "o", "ð": "d", "þ": "th", "ß": "ss", "æ": "ae", "œ": "oe", "ı": "i", "ł": "l", "đ": "d"}
_FOLD_RE = re.compile("[øðþßæœıłđ]")
_COMBINING_RE = re.compile("[̀-ͯ]")
_APOS_RE = re.compile("['’‘`´ʻ]")
_NON_ALNUM_RE = re.compile(r"[^a-z0-9]+")
_ST_RE = re.compile(r"\bst\b")
_DIGITS_1_3_RE = re.compile(r"^[0-9]{1,3}$")
_DIGITS_RE = re.compile(r"^[0-9]+$")
_CODE_STRIP_RE = re.compile(r"[." + re.escape(_JS_WS) + "]")
_CODE_RE = re.compile(r"^[A-Z]{2,3}$")

# "Republic of X", "Kingdom of X", "Federal Democratic Republic of X" ... -> "X"
_PREFIX_RE = re.compile(
    r"^(?:(?:federal|federative|democratic|islamic|united|peoples|socialist|arab|plurinational|bolivarian|cooperative|"
    r"co operative|oriental|independent|hashemite|eastern)" + _JS_WS_CLASS + r")*"
    r"(?:republic|kingdom|state|commonwealth|principality|sultanate|grand duchy|union|federation|emirate|"
    r"federated states|territory|collectivity)" + _JS_WS_CLASS + r"of" + _JS_WS_CLASS + r"(?:the" + _JS_WS_CLASS + r")?"
)
# After stripping a qualifier these stay ambiguous (two Congos, two Koreas,
# PRC vs ROC): they must match an explicit alias, never a guess.
_AMBIGUOUS = frozenset({"congo", "korea", "china"})
# World Bank style suffixes: "Egypt, Arab Rep.", "Venezuela, RB", "Bahamas, The".
_SUFFIX_RE = re.compile(r"^(?:the|rep|rb|arab rep|islamic rep|fed sts|republic of|kingdom of|state of)$")


def _norm(s: str, dots_to_space: bool) -> str:
    """lower-case, strip diacritics and punctuation, "&" -> "and", "St" ->
    "Saint", drop a leading / trailing "the" (worldMap.ts norm())."""
    s = unicodedata.normalize("NFKD", s.lower())
    s = _COMBINING_RE.sub("", s)
    s = _FOLD_RE.sub(lambda m: _FOLD[m.group(0)], s)
    s = s.replace("&", " and ")
    s = _APOS_RE.sub("", s)
    s = s.replace(".", " " if dots_to_space else "")
    s = _NON_ALNUM_RE.sub(" ", s).strip(_JS_WS)
    s = _ST_RE.sub("saint", s)
    if s.startswith("the "):
        s = s[4:]
    if s.endswith(" the"):
        s = s[:-4]
    return s


@lru_cache(maxsize=1)
def _tables() -> dict:
    data = json.loads(_DATA_PATH.read_text(encoding="utf-8"))
    by3: dict[str, dict] = {}
    by2: dict[str, str] = {}
    bynum: dict[str, str] = {}
    for iso3, iso2, num, name in data["countries"]:
        by3[iso3] = {"iso3": iso3, "iso2": iso2, "num": num, "name": name}
        by2[iso2] = iso3
        if num != "---":
            bynum[num] = iso3
    names: dict[str, str] = {}

    def add(name: str, iso3: str) -> None:
        for key in (_norm(name, False), _norm(name, True)):
            if key and key not in names:
                names[key] = iso3

    # Explicit aliases win over display names (so "Congo" is COG, "Korea"
    # is KOR, "Macedonia" is MKD) - same order as the asset.
    for iso3, joined in data["aliases"].items():
        for alias in joined.split("|"):
            add(alias, iso3)
    for iso3, _iso2, _num, name in data["countries"]:
        add(name, iso3)
    return {
        "by3": by3, "by2": by2, "bynum": bynum, "names": names, "legacy": dict(data["legacy"]),
        "nullish": frozenset(data["nullish"]), "shapes": frozenset(data["shapes"]), "points": frozenset(data["points"]),
    }


def country_name(iso3: str) -> str | None:
    """English display name for an ISO3 code, or None."""
    entry = _tables()["by3"].get(iso3)
    return entry["name"] if entry else None


def has_shape(iso3: str) -> bool:
    """True when the map draws this country as a filled shape (the other
    75 entries are small territories drawn as a dot at their anchor)."""
    return iso3 in _tables()["shapes"]


def resolve_country(value) -> str | None:
    """ISO3 for anything that names a country: ISO3 ("PRT"), ISO2 ("PT"),
    ISO numeric (620 or "620"), an English name or a common alternate.
    None for blank, "NULL", "Unknown", "Other" and anything unrecognised."""
    t = _tables()
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        if isinstance(value, float) and not value.is_integer():
            return None
        n = int(value)
        return t["bynum"].get(str(n).rjust(3, "0")) if 0 < n < 1000 else None
    if not isinstance(value, str):
        return None
    raw = value.strip(_JS_WS)
    if not raw or raw.lower() in t["nullish"]:
        return None
    if _DIGITS_1_3_RE.match(raw):
        return t["bynum"].get(raw.rjust(3, "0"))

    # codes: "PRT", "pt", "U.S.", "U.K.", "U.S.A."
    code = _CODE_STRIP_RE.sub("", raw).upper()
    if _CODE_RE.match(code):
        if code in t["legacy"]:
            return t["legacy"][code]
        if len(code) == 3 and code in t["by3"]:
            return code
        if len(code) == 2 and code in t["by2"]:
            return t["by2"][code]

    names = t["names"]
    a = _norm(raw, False)
    b = _norm(raw, True)
    if a in names:
        return names[a]
    if b in names:
        return names[b]

    # "Iran (Islamic Republic of)" -> "Iran"
    paren = raw.find("(")
    if paren > 0:
        k = _norm(raw[:paren], True)
        if k in names and k not in _AMBIGUOUS:
            return names[k]
    # "Tanzania, United Republic of" -> "United Republic of Tanzania"; "Yemen, Rep." -> "Yemen"
    comma = raw.find(",")
    if comma > 0:
        head = _norm(raw[:comma], True)
        tail = _norm(raw[comma + 1:], True)
        inv = _norm(tail + " " + head, True)
        if inv in names:
            return names[inv]
        if (_SUFFIX_RE.match(tail) or tail == "") and head in names and head not in _AMBIGUOUS:
            return names[head]
    # "Kingdom of Saudi Arabia" -> "Saudi Arabia"
    stripped = _PREFIX_RE.sub("", b, count=1)
    if stripped != b and stripped in names and stripped not in _AMBIGUOUS:
        return names[stripped]
    return None


def _js_string(v) -> str:
    """String(v) as JavaScript writes a number (5.0 -> "5")."""
    if isinstance(v, float):
        if v != v:
            return "NaN"
        if v.is_integer() and abs(v) < 1e21:
            return str(int(v))
    return str(v)


def country_column_score(values) -> float:
    """Share (0-1) of the DISTINCT non-blank values that resolve to a
    country. Blank / "NULL" / "Unknown" / "Other" are ignored; purely
    numeric values are counted but never as a match (a column of ISO
    numeric codes cannot be told apart from any other small-integer
    column by its values). About 0.8 is the threshold for "a country
    column"."""
    nullish = _tables()["nullish"]
    seen: set[str] = set()
    total = hit = 0
    for v in values or []:
        if v is None or isinstance(v, bool):
            continue
        is_number = isinstance(v, (int, float))
        if not is_number and not isinstance(v, str):
            continue
        raw = _js_string(v).strip(_JS_WS) if is_number else v.strip(_JS_WS)
        key = raw.lower()
        if not raw or key in nullish or key in seen:
            continue
        seen.add(key)
        total += 1
        if is_number or _DIGITS_RE.match(raw):
            continue
        if resolve_country(raw):
            hit += 1
    return hit / total if total else 0.0


def country_weight_share(values, weights) -> float:
    """Share (0-1) of the WEIGHT (an additive measure: bookings, revenue)
    that sits on values resolving to a country. A long tail of unknown
    codes with a handful of rows each does not stop a column whose rows
    are 9 in 10 real countries from being a country column. Blank values
    and non-positive weights are left out; numeric values never match
    (as in country_column_score). Mirrors charts/recommend.ts
    countryWeightShare."""
    total = hit = 0.0
    for v, w in zip(values or [], weights or []):
        if v is None or isinstance(v, bool):
            continue
        is_number = isinstance(v, (int, float))
        if not is_number and not isinstance(v, str):
            continue
        raw = _js_string(v).strip(_JS_WS) if is_number else v.strip(_JS_WS)
        if not raw:
            continue
        if isinstance(w, bool) or not isinstance(w, (int, float)) or w != w or w in (float("inf"), float("-inf")) or w <= 0:
            continue
        total += w
        if is_number or _DIGITS_RE.match(raw):
            continue
        if resolve_country(raw):
            hit += w
    return hit / total if total > 0 else 0.0


def resolved_distinct(values) -> tuple[int, int]:
    """(distinct values that resolve to a country, distinct ISO3 they
    resolve to) - what a recommendation reason quotes."""
    codes: set[str] = set()
    seen: set[str] = set()
    hits = 0
    for v in values or []:
        if v is None or isinstance(v, bool) or not isinstance(v, (str, int, float)):
            continue
        key = _js_string(v).strip(_JS_WS).lower() if not isinstance(v, str) else v.strip(_JS_WS).lower()
        if not key or key in seen:
            continue
        seen.add(key)
        iso = resolve_country(v)
        if iso:
            hits += 1
            codes.add(iso)
    return hits, len(codes)


# A column NAME that says "country" - the only geography signal there is
# before a block has run (the schema cache holds names and types, never
# values). Word-wise, so "country_code" and "Guest Country" count and
# "county" / "accountry" do not.
_CAMEL_RE = re.compile(r"(?<=[a-z0-9])(?=[A-Z])")
_WORD_RE = re.compile(r"[A-Za-z]+")


def looks_like_country_name(column: str | None) -> bool:
    """Does the column's NAME say it holds countries? ("country",
    "Country Code", "guest_country", "shipCountry", "nationality")."""
    if not column or not isinstance(column, str):
        return False
    words = [w.lower() for w in _WORD_RE.findall(_CAMEL_RE.sub(" ", column))]
    if not words:
        return False
    if any(w in ("country", "countries", "nation", "nationality") for w in words):
        return True
    return False
