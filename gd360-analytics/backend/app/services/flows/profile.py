"""Reading a flow's sources and finding (a) how they link and (b) the
mistakes in them that would break a spreadsheet: keys typed differently,
numbers saved as text, rows with no key, the same key twice."""
from __future__ import annotations

import re

import pandas as pd
from sqlalchemy.orm import Session

from ... import models
from . import values as V

MAX_PROFILE_ROWS = 200_000
_ID_NAME = re.compile(r"(^|_|\b)(id|no|num|number|code|ref|key|order|invoice|sku|#)($|_|\b)", re.IGNORECASE)


class FlowError(Exception):
    """Something a person can act on, with a plain message."""


def slug(text: str, fallback: str = "data") -> str:
    s = re.sub(r"[^a-z0-9]+", "_", (text or "").lower()).strip("_")
    return (s or fallback)[:32]


def table_names(ds: models.DataSource) -> list[str | None]:
    sc = ds.schema_cache if isinstance(ds.schema_cache, dict) else {}
    if not sc or "columns" in sc:
        return [None]
    return [k for k in sc.keys() if isinstance(k, str)] or [None]


def load_source(db: Session, src: dict) -> pd.DataFrame:
    from ..data_loader import load_dataframe
    ds = db.get(models.DataSource, src.get("datasource_id"))
    if ds is None:
        raise FlowError(f"The source “{src.get('label') or src.get('alias')}” was removed. Pick another one in the plan.")
    try:
        df = load_dataframe(ds, table=src.get("table"), db=db)
    except Exception as e:  # noqa: BLE001 - shown to the person
        raise FlowError(f"GD360 could not read “{src.get('label') or ds.name}”: {str(e)[:240]}") from e
    if not isinstance(df, pd.DataFrame):
        raise FlowError(f"“{src.get('label') or ds.name}” did not return a table.")
    df.columns = [str(c) for c in df.columns]
    return df


def column_kind(s: pd.Series) -> str:
    if pd.api.types.is_bool_dtype(s):
        return "yes/no"
    if pd.api.types.is_numeric_dtype(s):
        return "number"
    if pd.api.types.is_datetime64_any_dtype(s):
        return "date"
    non = [v for v in s.head(500) if not V.is_empty(v)]
    if non and sum(1 for v in non if V.parse_number(v) is not None) >= 0.8 * len(non):
        return "number as text"
    return "text"


def fill_share(s: pd.Series) -> float:
    if len(s) == 0:
        return 0.0
    filled = sum(1 for v in s if not V.is_empty(v))
    return round(filled / len(s), 4)


def describe(alias: str, label: str, df: pd.DataFrame) -> dict:
    cols = []
    for c in list(df.columns)[:80]:
        s = df[c]
        cols.append({
            "name": c, "kind": column_kind(s), "filled": fill_share(s),
            "examples": [V.to_plain(v) for v in s.dropna().head(3).tolist()],
        })
    return {"alias": alias, "label": label, "rows": int(len(df)), "columns": cols,
            "sample": V.records(df, 6)}


def _key_values(s: pd.Series, cap: int = 20000) -> list[str]:
    out = []
    for v in s.head(cap):
        k = V.match_key(v)
        if k is not None:
            out.append(k)
    return out


def _key_candidates(df: pd.DataFrame) -> list[str]:
    out = []
    for c in list(df.columns)[:60]:
        s = df[c]
        if pd.api.types.is_float_dtype(s):
            non = s.dropna().head(500)
            if len(non) and not all(float(v).is_integer() for v in non):
                continue
        if pd.api.types.is_datetime64_any_dtype(s) or pd.api.types.is_bool_dtype(s):
            continue
        if fill_share(s.head(5000)) < 0.4:
            continue
        out.append(c)
    return out


def find_link(frames: dict[str, pd.DataFrame]) -> dict | None:
    """The best pair of columns that link two sources: most of the smaller
    side's values appear on the other side once both are tidied."""
    aliases = list(frames)
    best = None
    memo: dict[tuple[str, str], list[str]] = {}

    def kv(alias: str, col: str) -> list[str]:
        if (alias, col) not in memo:
            memo[(alias, col)] = _key_values(frames[alias][col])
        return memo[(alias, col)]

    for i, a in enumerate(aliases):
        for b in aliases[i + 1:]:
            for left, right in ((a, b), (b, a)):
                L, R = frames[left], frames[right]
                for lc in _key_candidates(L):
                    lvals = kv(left, lc)
                    if not lvals:
                        continue
                    lset = set(lvals)
                    l_unique = len(lset) / len(lvals)
                    if l_unique < 0.95:
                        continue  # the "one row per thing" side must be unique
                    for rc in _key_candidates(R):
                        rvals = kv(right, rc)
                        if not rvals:
                            continue
                        hit = sum(1 for v in rvals if v in lset)
                        overlap = hit / len(rvals)
                        if overlap < 0.3:
                            continue
                        name_bonus = 0.05 if (_ID_NAME.search(lc) and _ID_NAME.search(rc)) else 0.0
                        score = overlap + name_bonus + 0.01 * min(len(L), 10**6) / 10**6
                        if best is None or score > best["score"]:
                            best = {"left": left, "right": right, "left_on": lc, "right_on": rc,
                                    "overlap": round(overlap, 4), "matched": hit, "of": len(rvals), "score": score}
    if best:
        best.pop("score", None)
    return best


def find_issues(alias: str, label: str, df: pd.DataFrame, key: str | None, key_must_be_unique: bool) -> list[dict]:
    issues: list[dict] = []
    if key and key in df.columns:
        s = df[key]
        if s.dtype == object:
            bad = [(i, v) for i, v in s.items() if V.key_needs_tidy(v)]
            if bad:
                issues.append({
                    "id": f"{alias}:key_format", "alias": alias, "kind": "key_format", "column": key,
                    "count": len(bad), "title": "Typed differently",
                    "detail": f"{len(bad)} value{'s' if len(bad) != 1 else ''} in “{key}” have extra characters (#, spaces), so a lookup misses them.",
                    "examples": [{"before": V.show(v), "after": V.tidy_key(v)} for _, v in bad[:3]],
                })
        missing = [i for i, v in s.items() if V.is_empty(v)]
        if missing:
            rows = df.loc[missing[:3]]
            issues.append({
                "id": f"{alias}:missing_key", "alias": alias, "kind": "missing_key", "column": key,
                "count": len(missing), "title": "Missing the link",
                "detail": f"{len(missing)} row{'s' if len(missing) != 1 else ''} have no “{key}”, so they can’t be matched. They will be set aside and listed, not lost.",
                "rows": V.records(rows, 3),
            })
        if key_must_be_unique:
            keys = s.map(V.match_key)
            dup = keys[keys.notna() & keys.duplicated(keep=False)]
            if len(dup):
                n = int(dup.nunique())
                issues.append({
                    "id": f"{alias}:duplicates", "alias": alias, "kind": "duplicates", "column": key,
                    "count": n, "title": "Counted twice",
                    "detail": f"{n} value{'s' if n != 1 else ''} of “{key}” appear more than once. A check will flag them on every run.",
                    "examples": [{"before": str(k), "after": "appears more than once"} for k in dup.unique()[:3]],
                })
    for c in list(df.columns)[:80]:
        if c == key:
            continue
        s = df[c]
        if s.dtype != object:
            continue
        non = [v for v in s if not V.is_empty(v)]
        if not non:
            continue
        parsed = [v for v in non if V.parse_number(v) is not None]
        if len(parsed) < 0.8 * len(non):
            continue
        texty = [v for v in parsed if V.looks_like_text_number(v)]
        if not texty:
            continue
        issues.append({
            "id": f"{alias}:text_number:{c}", "alias": alias, "kind": "text_number", "column": c,
            "count": len(texty), "title": "Numbers saved as text",
            "detail": f"{len(texty)} value{'s' if len(texty) != 1 else ''} in “{c}” are text (commas, currency signs), so totals skip them.",
            "examples": [{"before": V.show(v), "after": V.to_plain(V.parse_number(v))} for v in texty[:3]],
        })
    return issues


def profile(db: Session, sources: list[dict]) -> tuple[dict, dict[str, pd.DataFrame]]:
    """Read every source once and return what a person needs to see before
    a plan: rows, columns, the link between sources and the mistakes."""
    frames: dict[str, pd.DataFrame] = {}
    out_sources = []
    for src in sources:
        df = load_source(db, src)
        if len(df) > MAX_PROFILE_ROWS:
            df = df.head(MAX_PROFILE_ROWS)
        frames[src["alias"]] = df
        out_sources.append(describe(src["alias"], src.get("label") or src["alias"], df))
    link = find_link(frames) if len(frames) >= 2 else None
    issues: list[dict] = []
    for src in sources:
        a = src["alias"]
        key = None
        unique = False
        if link:
            if link["left"] == a:
                key, unique = link["left_on"], True
            elif link["right"] == a:
                key = link["right_on"]
        issues += find_issues(a, src.get("label") or a, frames[a], key, unique)
    return {"sources": out_sources, "link": link, "issues": issues}, frames
