"""Running a validated spec on real data.

Never writes anything - it returns the output frame and a full account of
what happened (stats, checks, timeline, flagged and set-aside rows); the
runner decides whether to save it."""
from __future__ import annotations

from datetime import datetime

import pandas as pd
from sqlalchemy.orm import Session

from . import values as V
from .profile import FlowError, fill_share, load_source
from .spec import check_words, label_of

SAMPLE = 50
REVIEW_COL = "review_note"


class StepError(FlowError):
    """A step could not run - usually a column that is no longer there."""

    def __init__(self, message: str, *, step_id: str | None = None, alias: str | None = None,
                 column: str | None = None, available: list[str] | None = None):
        super().__init__(message)
        self.step_id, self.alias, self.column, self.available = step_id, alias, column, available or []


def _ts() -> str:
    return datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def source_renames(spec: dict) -> dict[str, dict[str, str]]:
    """{alias: {name used in the flow: raw column in the source}} from source-level rename steps."""
    out: dict[str, dict[str, str]] = {}
    for st in spec.get("steps") or []:
        if st.get("kind") == "rename" and st.get("source") and st.get("enabled", True):
            for raw, used in st["columns"].items():
                out.setdefault(st["source"], {})[used] = raw
    return out


def referenced_columns(spec: dict) -> dict[str, set[str]]:
    """Raw source columns each source's steps rely on (for the 'still filled' guard and fixes)."""
    raw = referenced_columns_used(spec)
    ren = source_renames(spec)
    return {a: {ren.get(a, {}).get(c, c) for c in cols} for a, cols in raw.items()}


def referenced_columns_used(spec: dict) -> dict[str, set[str]]:
    out: dict[str, set[str]] = {s["alias"]: set() for s in spec.get("sources") or []}
    for st in spec.get("steps") or []:
        if not st.get("enabled", True):
            continue
        if st["kind"] == "clean" and st["source"] in out:
            out[st["source"]] |= {op["column"] for op in st["ops"] if op.get("column")}
        elif st["kind"] == "combine":
            if st["left"] in out:
                out[st["left"]].add(st["left_on"])
            if st["right"] in out:
                out[st["right"]].add(st["right_on"])
                out[st["right"]] |= set(st.get("right_columns") or [])
    return out


def _need(df: pd.DataFrame, col: str, *, alias: str, step_id: str, label: str) -> None:
    if col not in df.columns:
        raise StepError(f"“{col}” is no longer in {label}.", step_id=step_id, alias=alias, column=col,
                        available=[str(c) for c in df.columns])


def _clean(df: pd.DataFrame, st: dict, label: str, acc: dict) -> pd.DataFrame:
    alias = st["source"]
    for op in st["ops"]:
        o, c = op["op"], op.get("column")
        if o != "trim_text":
            _need(df, c, alias=alias, step_id=st["id"], label=label)
        if o == "tidy_key":
            before = df[c]
            changed = before.map(V.key_needs_tidy)
            n = int(changed.sum())
            new = before.map(V.tidy_key)
            for v in before[changed].head(3):
                acc["examples"].append({"source": label, "column": c, "before": V.show(v), "after": V.tidy_key(v)})
            non = [v for v in new if v is not None]
            if non and all(v.isdigit() and len(v) < 18 for v in non):
                new = pd.to_numeric(new, errors="coerce").astype("Int64")
            df = df.assign(**{c: new})
            acc["fixed_keys"] += n
        elif o == "to_number":
            before = df[c]
            if pd.api.types.is_numeric_dtype(before):
                continue
            parsed = before.map(V.parse_number)
            texty = before.map(V.looks_like_text_number)
            unreadable = before.map(lambda v: not V.is_empty(v) and V.parse_number(v) is None)
            for v in before[texty].head(3):
                acc["examples"].append({"source": label, "column": c, "before": V.show(v), "after": V.to_plain(V.parse_number(v))})
            for v in before[unreadable].head(3):
                acc["examples"].append({"source": label, "column": c, "before": V.show(v), "after": "(could not read - left empty)"})
            acc["fixed_numbers"] += int(texty.sum())
            acc["unreadable"] += int(unreadable.sum())
            df = df.assign(**{c: pd.to_numeric(parsed, errors="coerce")})
        elif o == "set_aside_missing":
            mask = df[c].map(V.is_empty)
            k = int(mask.sum())
            if k:
                acc["set_aside_n"] += k
                for r in V.records(df[mask], SAMPLE):
                    if len(acc["set_aside"]) < SAMPLE:
                        acc["set_aside"].append({"source": label, "reason": f"No “{c}”", "row": r})
                df = df[~mask]
        elif o == "trim_text":
            for col in df.columns:
                if df[col].dtype == object:
                    df[col] = df[col].map(lambda v: v.strip() if isinstance(v, str) else v)
        elif o == "dedupe":
            keys = df[c].map(V.match_key)
            dup = keys.notna() & keys.duplicated(keep="first")
            k = int(dup.sum())
            if k:
                acc["set_aside_n"] += k
                for r in V.records(df[dup], SAMPLE):
                    if len(acc["set_aside"]) < SAMPLE:
                        acc["set_aside"].append({"source": label, "reason": f"Repeat of “{c}”", "row": r})
                df = df[~dup]
    return df


def _combine(L: pd.DataFrame, R: pd.DataFrame, st: dict, spec: dict, acc: dict) -> pd.DataFrame:
    l_label, r_label = label_of(spec, st["left"]), label_of(spec, st["right"])
    _need(L, st["left_on"], alias=st["left"], step_id=st["id"], label=l_label)
    _need(R, st["right_on"], alias=st["right"], step_id=st["id"], label=r_label)
    cols = list(st.get("right_columns") or [c for c in R.columns if c != st["right_on"]])
    for c in cols:
        _need(R, c, alias=st["right"], step_id=st["id"], label=r_label)
    lk = L[st["left_on"]].map(V.match_key)
    rk = R[st["right_on"]].map(V.match_key)
    work = R[cols].copy()
    work["__k"] = rk.values
    work = work[work["__k"].notna()]
    agg = st.get("aggregate", "sum")
    if agg == "count":
        g = work.groupby("__k").size().to_frame(cols[0] if len(cols) == 1 else "matches")
    else:
        funcs = {}
        for c in cols:
            if agg == "sum":
                num = pd.to_numeric(work[c], errors="coerce")
                if num.notna().sum() >= 0.5 * max(1, work[c].notna().sum()) and work[c].notna().any():
                    work[c] = num
                    funcs[c] = "sum"
                else:
                    funcs[c] = "first"
            else:
                funcs[c] = "first"
        g = work.groupby("__k").agg(funcs)
    rename = {c: f"{c} ({r_label})" for c in g.columns if c in L.columns}
    g = g.rename(columns=rename)
    merged = L.copy()
    merged["__k"] = lk.values
    merged = merged.merge(g, left_on="__k", right_index=True, how="left")
    matched_left = int(merged["__k"].isin(g.index).sum())
    lset = set(lk.dropna())
    r_matched = rk.isin(lset)
    unmatched = R[rk.notna() & ~r_matched]
    merged = merged.drop(columns="__k")
    fill = st.get("fill")
    if fill is not None:
        for c in g.columns:
            if pd.api.types.is_numeric_dtype(merged[c]):
                merged[c] = merged[c].fillna(fill)
    acc["matched_right"] += int(r_matched.sum())
    acc["right_rows"] += int(rk.notna().sum())
    acc["left_rows_matched"] += matched_left
    acc["left_rows"] += int(len(L))
    if len(unmatched):
        acc["unmatched_right"] += int(len(unmatched))
        acc["set_aside_n"] += int(len(unmatched))
        for r in V.records(unmatched, SAMPLE):
            if len(acc["set_aside"]) < SAMPLE:
                acc["set_aside"].append({"source": r_label, "reason": f"No matching row in {l_label}", "row": r})
    acc["renamed"].update(rename)
    acc["combine_label"] = (l_label, r_label)
    return merged


def _num(df: pd.DataFrame, col: str, fill, step_id: str) -> pd.Series:
    _need(df, col, alias="main", step_id=step_id, label="the combined table")
    s = pd.to_numeric(df[col].map(lambda v: V.parse_number(v) if isinstance(v, str) else v), errors="coerce")
    return s.fillna(fill) if fill is not None else s


def run_spec(db: Session, spec: dict, *, last_good_columns: dict | None = None) -> dict:
    events: list[dict] = []

    def ev(text: str, status: str = "ok", detail: str | None = None):
        events.append({"at": _ts(), "text": text, "status": status, **({"detail": detail} if detail else {})})

    acc = {"examples": [], "fixed_keys": 0, "fixed_numbers": 0, "unreadable": 0, "set_aside": [], "set_aside_n": 0,
           "matched_right": 0, "right_rows": 0, "left_rows_matched": 0, "left_rows": 0, "unmatched_right": 0,
           "renamed": {}, "combine_label": None}
    ev("Started")
    frames: dict[str, pd.DataFrame] = {}
    fills: dict[str, dict] = {}
    src_stats = {}
    refs = referenced_columns(spec)
    health: list[dict] = []
    for src in spec["sources"]:
        df = load_source(db, src)
        frames[src["alias"]] = df
        src_stats[src["alias"]] = {"label": src.get("label"), "rows": int(len(df))}
        fills[src["alias"]] = {c: fill_share(df[c]) for c in list(df.columns)[:120]}
        ev(f"Read {len(df):,} rows from {src.get('label')}")
        prev = (last_good_columns or {}).get(src["alias"]) or {}
        for c in sorted(refs.get(src["alias"]) or []):
            if c in df.columns and prev.get(c, 0) >= 0.5 and fills[src["alias"]].get(c, 0) <= 0.1:
                health.append({"alias": src["alias"], "label": src.get("label"), "column": c,
                               "was": prev.get(c), "now": fills[src["alias"]].get(c, 0)})
    order = [s["alias"] for s in spec["sources"]]
    try:
        final, checks, reasons = _steps_and_checks(spec, frames, order, acc, ev, last_good_columns, health)
    except StepError as err:
        err.fills, err.events = fills, events
        ev(f"Stopped: {err}", "bad")
        raise
    return _finish(spec, final, checks, reasons, acc, ev, events, fills, src_stats, health, last_good_columns)


def _steps_and_checks(spec, frames, order, acc, ev, last_good_columns, health):
    for st in spec.get("steps") or []:
        if not st.get("enabled", True):
            continue
        k = st["kind"]
        if k == "clean":
            label = label_of(spec, st["source"])
            before_fix = acc["fixed_keys"] + acc["fixed_numbers"]
            before_aside = acc["set_aside_n"]
            frames[st["source"]] = _clean(frames[st["source"]], st, label, acc)
            fixed = acc["fixed_keys"] + acc["fixed_numbers"] - before_fix
            aside = acc["set_aside_n"] - before_aside
            parts = []
            if fixed:
                parts.append(f"fixed {fixed} typing mistake{'s' if fixed != 1 else ''}")
            if aside:
                parts.append(f"set aside {aside} row{'s' if aside != 1 else ''}")
            ev(f"{label}: " + (", ".join(parts) if parts else "nothing needed fixing"))
        elif k == "rename" and st.get("source") in frames:
            df = frames[st["source"]]
            mp = {a: b for a, b in st["columns"].items() if a in df.columns}
            for a in st["columns"]:
                if a not in df.columns:
                    _need(df, a, alias=st["source"], step_id=st["id"], label=label_of(spec, st["source"]))
            drop = [b for a, b in mp.items() if b in df.columns and b != a]
            frames[st["source"]] = df.drop(columns=drop).rename(columns=mp)
        elif k == "combine":
            L, R = frames.pop(st["left"]), frames.pop(st["right"])
            frames["main"] = _combine(L, R, st, spec, acc)
            l_label, r_label = acc["combine_label"]
            ev(f"Matched {acc['matched_right']:,} of {acc['right_rows']:,} {r_label} rows to {l_label}")
        else:
            cur = "main" if "main" in frames else next(a for a in order if a in frames)
            df = frames[cur]
            if k == "compute":
                left = _num(df, st["left"], st.get("fill"), st["id"])
                right = (pd.Series(float(st["right"]), index=df.index) if isinstance(st["right"], (int, float))
                         else _num(df, st["right"], st.get("fill"), st["id"]))
                op = st["op"]
                res = left + right if op == "+" else left - right if op == "-" else left * right if op == "*" else left / right.replace(0, pd.NA)
                df = df.assign(**{st["column"]: pd.to_numeric(res, errors="coerce").round(6)})
                ev(f"Worked out “{st['column']}”")
            elif k == "keep":
                for c in st["columns"]:
                    _need(df, c, alias=cur, step_id=st["id"], label=label_of(spec, cur))
                df = df[st["columns"]]
            elif k == "rename":
                df = df.rename(columns=st["columns"])
            frames[cur] = df
    final = frames["main"] if "main" in frames else frames[next(a for a in order if a in frames)]
    final = final.reset_index(drop=True)

    reasons: dict[int, list[str]] = {}
    checks = []
    for c in spec.get("checks") or []:
        if not c.get("enabled", True):
            continue
        res = {"id": c["id"], "kind": c["kind"], "label": check_words(c), "column": c.get("column")}
        if c["kind"] == "ready_by":
            checks.append({**res, "status": "later", "count": 0})
            continue
        col = c["column"]
        if col not in final.columns:
            raise StepError(f"The check “{check_words(c)}” needs “{col}”, which is no longer there.",
                            step_id=c["id"], alias="main", column=col, available=[str(x) for x in final.columns])
        s = final[col]
        if c["kind"] == "unique":
            keys = s.map(V.match_key)
            bad = keys.notna() & keys.duplicated(keep=False)
            msg = lambda i: f"“{col}” appears more than once"  # noqa: E731
        elif c["kind"] == "not_empty":
            bad = s.map(V.is_empty)
            msg = lambda i: f"No “{col}”"  # noqa: E731
        else:
            num = pd.to_numeric(s, errors="coerce")
            bad = (num < c["value"]) if c["kind"] == "min" else (num > c["value"])
            bad = bad.fillna(False)
            word = "below" if c["kind"] == "min" else "above"
            msg = lambda i, num=num, word=word, c=c: f"“{col}” is {V.to_plain(num.iloc[i])} ({word} {c['value']:g})"  # noqa: E731
        idx = [int(i) for i in final.index[bad.astype(bool)]]
        for i in idx:
            reasons.setdefault(i, []).append(msg(i))
        checks.append({**res, "status": "flagged" if idx else "passed", "count": len(idx)})
    return final, checks, reasons


def _finish(spec, final, checks, reasons, acc, ev, events, fills, src_stats, health, last_good_columns):
    if health:
        h = health[0]
        checks.insert(0, {"id": "health", "kind": "health", "label": "Columns that were filled are still filled",
                          "status": "failed", "count": len(health),
                          "detail": f"“{h['column']}” in {h['label']} was filled in {round(h['was'] * 100)}% of rows last time and is "
                                    f"{round(h['now'] * 100)}% filled now."})
    elif last_good_columns:
        checks.insert(0, {"id": "health", "kind": "health", "label": "Columns that were filled are still filled",
                          "status": "passed", "count": 0})
    if any(c["kind"] != "ready_by" for c in spec.get("checks") or [] if c.get("enabled", True)):
        final[REVIEW_COL] = ["; ".join(reasons.get(i, [])) for i in range(len(final))]
    flagged_idx = sorted(reasons)
    flagged = [{"reasons": reasons[i], "row": V.records(final.iloc[[i]].drop(columns=[REVIEW_COL], errors="ignore"), 1)[0]}
               for i in flagged_idx[:SAMPLE]]
    if flagged_idx:
        ev(f"{len(flagged_idx):,} row{'s' if len(flagged_idx) != 1 else ''} look odd", "warn")
    hold_above = (spec.get("policy") or {}).get("hold_above", 50)
    status, hold_reason = "success", None
    if health:
        status = "held"
        h = health[0]
        hold_reason = (f"“{h['column']}” in {h['label']} is empty now (it was filled in {round(h['was'] * 100)}% of rows), "
                       "so the numbers would be wrong.")
    elif len(final) == 0:
        status, hold_reason = "held", "No rows came out, so yesterday’s table was kept."
    elif acc["right_rows"] and acc["matched_right"] == 0:
        status, hold_reason = "held", "None of the rows matched, so the link between the sources looks broken."
    elif len(flagged_idx) > hold_above:
        status, hold_reason = "held", f"{len(flagged_idx):,} rows look odd - more than your limit of {hold_above}."
    if status == "held":
        ev(f"Held: {hold_reason}", "bad")
    stats = {
        "sources": src_stats, "fixed_keys": acc["fixed_keys"], "fixed_numbers": acc["fixed_numbers"],
        "fixed": acc["fixed_keys"] + acc["fixed_numbers"], "unreadable": acc["unreadable"],
        "set_aside": acc["set_aside_n"], "unmatched_right": acc["unmatched_right"],
        "matched_right": acc["matched_right"], "right_rows": acc["right_rows"],
        "left_rows": acc["left_rows"], "left_rows_matched": acc["left_rows_matched"],
        "flagged": len(flagged_idx), "rows_out": int(len(final)), "columns_out": [str(c) for c in final.columns],
        "hold_above": hold_above, "renamed": acc["renamed"],
    }
    return {
        "status": status, "hold_reason": hold_reason, "stats": stats, "checks": checks, "events": events,
        "flagged": flagged, "set_aside": acc["set_aside"], "examples": acc["examples"][:8],
        "preview": {"columns": [str(c) for c in final.columns], "rows": V.records(final, 20)},
        "fills": fills, "frame": final, "ev": ev, "health": health,
    }
