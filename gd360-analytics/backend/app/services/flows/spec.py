"""The shape of a flow spec: validation, plain-word descriptions and the
equivalent SQL shown in the Code view."""
from __future__ import annotations

import copy
import re
import uuid
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .profile import FlowError, slug

CLEAN_OPS = {"tidy_key", "to_number", "set_aside_missing", "trim_text", "dedupe"}
STEP_KINDS = {"clean", "combine", "compute", "keep", "rename"}
CHECK_KINDS = {"unique", "not_empty", "min", "max", "ready_by"}
AGGREGATES = {"sum", "first", "count"}
OPS = {"+": "+", "-": "−", "*": "×", "/": "÷"}
MAX_SOURCES, MAX_STEPS, MAX_CHECKS = 5, 20, 12
_HM = re.compile(r"^(\d{1,2}):(\d{2})$")


def _id(prefix: str) -> str:
    return f"{prefix}{uuid.uuid4().hex[:6]}"


def _str(v, what: str, max_len: int = 200) -> str:
    if not isinstance(v, str) or not v.strip():
        raise FlowError(f"{what} is missing.")
    return v.strip()[:max_len] if what != "column" else v[:max_len]


def _col(v, what: str = "A column") -> str:
    if not isinstance(v, str) or v == "":
        raise FlowError(f"{what} is missing.")
    return v[:200]


def hm(t: str) -> tuple[int, int]:
    m = _HM.match(str(t or "").strip())
    if not m or int(m.group(1)) > 23 or int(m.group(2)) > 59:
        raise FlowError("Times are written like 06:00 or 18:30.")
    return int(m.group(1)), int(m.group(2))


def check_zone(tz: str) -> str:
    try:
        ZoneInfo(tz or "UTC")
    except (ZoneInfoNotFoundError, ValueError):
        raise FlowError(f"“{tz}” is not a time zone Euliv knows.")
    return tz or "UTC"


def validate(spec: dict) -> dict:
    """Returns a cleaned copy, or raises FlowError with a plain message."""
    if not isinstance(spec, dict):
        raise FlowError("The plan is not readable.")
    s = copy.deepcopy(spec)
    sources = s.get("sources")
    if not isinstance(sources, list) or not sources:
        raise FlowError("Pick at least one source.")
    if len(sources) > MAX_SOURCES:
        raise FlowError(f"A flow can read up to {MAX_SOURCES} sources.")
    aliases: list[str] = []
    for src in sources:
        if not isinstance(src, dict):
            raise FlowError("A source is not readable.")
        src["datasource_id"] = _str(src.get("datasource_id"), "A source")
        src["alias"] = slug(src.get("alias") or src.get("label") or "source")
        if src["alias"] in aliases or src["alias"] == "main":
            src["alias"] = f"{src['alias']}_{len(aliases) + 1}"
        aliases.append(src["alias"])
        src["table"] = src.get("table") if isinstance(src.get("table"), str) and src.get("table") else None
        src["label"] = str(src.get("label") or src["alias"])[:120]
    frames = set(aliases)
    steps = s.get("steps") or []
    if not isinstance(steps, list) or len(steps) > MAX_STEPS:
        raise FlowError(f"A flow can have up to {MAX_STEPS} steps.")
    seen_ids: set[str] = set()
    for st in steps:
        if not isinstance(st, dict) or st.get("kind") not in STEP_KINDS:
            raise FlowError("One of the steps is not a kind Euliv can run.")
        st["id"] = str(st.get("id") or _id("s"))[:40]
        if st["id"] in seen_ids:
            st["id"] = _id("s")
        seen_ids.add(st["id"])
        st["enabled"] = st.get("enabled", True) is not False
        k = st["kind"]
        if k == "clean":
            if st.get("source") not in frames:
                raise FlowError("A clean step points at a source that is not in this flow.")
            ops = st.get("ops") or []
            if not isinstance(ops, list) or not ops:
                raise FlowError("A clean step has nothing to fix.")
            for op in ops:
                if not isinstance(op, dict) or op.get("op") not in CLEAN_OPS:
                    raise FlowError("A clean step has a fix Euliv doesn’t know.")
                if op["op"] != "trim_text":
                    op["column"] = _col(op.get("column"))
        elif k == "combine":
            if st.get("left") not in frames or st.get("right") not in frames or st.get("left") == st.get("right"):
                raise FlowError("A combine step must join two different sources.")
            st["left_on"] = _col(st.get("left_on"), "The column to match on")
            st["right_on"] = _col(st.get("right_on"), "The column to match on")
            rc = st.get("right_columns") or []
            if not isinstance(rc, list) or not all(isinstance(c, str) for c in rc):
                raise FlowError("The columns to bring across are not readable.")
            st["right_columns"] = rc[:40]
            st["aggregate"] = st.get("aggregate") if st.get("aggregate") in AGGREGATES else "sum"
            st["fill"] = st.get("fill", 0) if isinstance(st.get("fill", 0), (int, float)) or st.get("fill") is None else 0
            frames.discard(st["right"])
            if st["left"] != "main":
                frames.discard(st["left"])
            frames.add("main")
        elif k == "compute":
            st["column"] = _col(st.get("column"), "The new column’s name")
            st["left"] = _col(st.get("left"), "The first column")
            if st.get("op") not in OPS:
                raise FlowError("A calculation can add, subtract, multiply or divide.")
            r = st.get("right")
            if not (isinstance(r, (int, float)) or (isinstance(r, str) and r)):
                raise FlowError("The second part of the calculation is missing.")
            f = st.get("fill", 0)
            st["fill"] = f if isinstance(f, (int, float)) or f is None else 0
        elif k == "keep":
            cols = st.get("columns") or []
            if not isinstance(cols, list) or not cols or not all(isinstance(c, str) for c in cols):
                raise FlowError("Say which columns to keep.")
        elif k == "rename":
            mp = st.get("columns") or {}
            if not isinstance(mp, dict) or not mp or not all(isinstance(a, str) and isinstance(b, str) and b for a, b in mp.items()):
                raise FlowError("Say which columns to rename.")
            if st.get("source") is not None and st.get("source") not in frames:
                raise FlowError("A rename step points at a source that is not in this flow.")
    checks = s.get("checks") or []
    if not isinstance(checks, list) or len(checks) > MAX_CHECKS:
        raise FlowError(f"A flow can have up to {MAX_CHECKS} checks.")
    for c in checks:
        if not isinstance(c, dict) or c.get("kind") not in CHECK_KINDS:
            raise FlowError("One of the checks is not a kind Euliv can run.")
        c["id"] = str(c.get("id") or _id("c"))[:40]
        c["enabled"] = c.get("enabled", True) is not False
        if c["kind"] == "ready_by":
            hm(c.get("time"))
        else:
            c["column"] = _col(c.get("column"))
        if c["kind"] in ("min", "max"):
            v = c.get("value")
            if not isinstance(v, (int, float)) or isinstance(v, bool):
                raise FlowError("A limit check needs a number.")
    out = s.get("output") or {}
    name = slug(str(out.get("name") or "flow_output"), "flow_output")
    s["output"] = {"name": name}
    sch = s.get("schedule") or {}
    hm(sch.get("time") or "06:00")
    days = sch.get("days")
    days = sorted({int(d) % 7 for d in days}) if isinstance(days, list) and days else list(range(7))
    s["schedule"] = {"time": sch.get("time") or "06:00", "days": days,
                     "timezone": check_zone(sch.get("timezone") or "UTC"), "on_change": bool(sch.get("on_change", True))}
    pol = s.get("policy") or {}
    hold = pol.get("hold_above", 50)
    if not isinstance(hold, int) or isinstance(hold, bool) or hold < 0 or hold > 10_000_000:
        raise FlowError("The safety limit is a whole number of rows, like 50.")
    s["policy"] = {
        "hold_above": hold,
        "flag_to": [str(u) for u in (pol.get("flag_to") or []) if u][:20],
        "alert_to": [str(u) for u in (pol.get("alert_to") or []) if u][:20],
        "daily_summary": bool(pol.get("daily_summary", True)),
    }
    s["steps"], s["checks"] = steps, checks
    return s


# ------------------------------------------------------------ words ----

def label_of(spec: dict, alias: str) -> str:
    if alias == "main":
        return "the combined table"
    for s in spec.get("sources") or []:
        if s["alias"] == alias:
            return s.get("label") or alias
    return alias


def _q(c) -> str:
    return f"“{c}”"


def step_words(spec: dict, st: dict) -> dict:
    k = st["kind"]
    if k == "clean":
        parts = []
        for op in st["ops"]:
            o = op["op"]
            if o == "tidy_key":
                parts.append(f"Tidy {_q(op['column'])}: remove # and extra spaces")
            elif o == "to_number":
                parts.append(f"Turn {_q(op['column'])} into numbers (commas and currency signs removed)")
            elif o == "set_aside_missing":
                parts.append(f"Set aside rows with no {_q(op['column'])} and list them")
            elif o == "trim_text":
                parts.append("Trim spaces from every text cell")
            elif o == "dedupe":
                parts.append(f"Keep one row per {_q(op['column'])}")
        return {"title": f"Fix the mistakes in {label_of(spec, st['source'])}", "detail": " · ".join(parts)}
    if k == "combine":
        cols = ", ".join(_q(c) for c in st.get("right_columns") or []) or "every column"
        how = {"sum": "added up", "first": "first value", "count": "counted"}[st.get("aggregate", "sum")]
        return {"title": f"Match {label_of(spec, st['right'])} to {label_of(spec, st['left'])}",
                "detail": f"{_q(st['left_on'])} = {_q(st['right_on'])} · brings across {cols} ({how} per match)"
                          + (" · no match counts as 0" if st.get("fill") == 0 else "")}
    if k == "compute":
        r = st["right"] if isinstance(st["right"], (int, float)) else _q(st["right"])
        return {"title": f"Work out {_q(st['column'])}",
                "detail": f"= {_q(st['left'])} {OPS[st['op']]} {r}" + (" · empty counts as 0" if st.get("fill") == 0 else "")}
    if k == "keep":
        return {"title": f"Keep {len(st['columns'])} columns", "detail": ", ".join(_q(c) for c in st["columns"][:8])}
    if k == "rename":
        if st.get("source"):
            return {"title": f"Read the right columns from {label_of(spec, st['source'])}",
                    "detail": ", ".join(f"use {_q(a)} as {_q(b)}" for a, b in list(st["columns"].items())[:6])}
        return {"title": "Rename columns", "detail": ", ".join(f"{_q(a)} → {_q(b)}" for a, b in list(st["columns"].items())[:6])}
    return {"title": k, "detail": ""}


def check_words(c: dict) -> str:
    k = c["kind"]
    if k == "unique":
        return f"No {_q(c['column'])} counted twice"
    if k == "not_empty":
        return f"Every row has {_q(c['column'])}"
    if k == "min":
        return f"{_q(c['column'])} never below {c['value']:g}"
    if k == "max":
        return f"{_q(c['column'])} never above {c['value']:g}"
    if k == "ready_by":
        return f"Ready by {c['time']}"
    return k


# -------------------------------------------------------------- SQL ----

def _qi(c: str) -> str:
    return '"' + str(c).replace('"', '""') + '"'


def code_for(spec: dict) -> str:
    """The same plan written as SQL, for people who read SQL. It is shown,
    not run - the engine runs the steps directly."""
    lines = ["-- " + "Equivalent SQL for this flow (read-only view of the plan)", ""]
    current = {s["alias"]: s["alias"] for s in spec.get("sources") or []}
    n = 0
    for s in spec.get("sources") or []:
        lines.append(f"-- source {s['alias']}: {s.get('label')}")
    lines.append("")
    for st in spec.get("steps") or []:
        if not st.get("enabled", True):
            continue
        n += 1
        w = step_words(spec, st)
        lines.append(f"-- {n}. {w['title']}")
        k = st["kind"]
        if k == "clean":
            src = current.get(st["source"], st["source"])
            name = f"{st['source']}_fixed"
            exprs, where = [], []
            touched = set()
            for op in st["ops"]:
                c = op.get("column")
                if op["op"] == "tidy_key":
                    exprs.append(f"  NULLIF(TRIM(LEADING '#' FROM TRIM(CAST({_qi(c)} AS VARCHAR))), '') AS {_qi(c)}")
                    touched.add(c)
                elif op["op"] == "to_number":
                    exprs.append(f"  TRY_CAST(REGEXP_REPLACE(CAST({_qi(c)} AS VARCHAR), '[,₹$€£ ]', '', 'g') AS DOUBLE) AS {_qi(c)}")
                    touched.add(c)
                elif op["op"] == "set_aside_missing":
                    where.append(f"NULLIF(TRIM(CAST({_qi(c)} AS VARCHAR)), '') IS NOT NULL")
            excl = f" EXCLUDE ({', '.join(_qi(c) for c in sorted(touched))})" if touched else ""
            lines.append(f"CREATE TEMP VIEW {name} AS SELECT *{excl},")
            lines.append(",\n".join(exprs) if exprs else "  1 AS _keep")
            lines.append(f"FROM {src}" + (f"\nWHERE {' AND '.join(where)}" if where else "") + ";")
            current[st["source"]] = name
        elif k == "combine":
            L, R = current.get(st["left"], st["left"]), current.get(st["right"], st["right"])
            cols = st.get("right_columns") or []
            agg = {"sum": "SUM", "first": "ANY_VALUE", "count": "COUNT"}[st.get("aggregate", "sum")]
            sel = ", ".join(f"{agg}({_qi(c)}) AS {_qi(c)}" for c in cols) or "COUNT(*) AS matches"
            fill = st.get("fill")
            outs = ", ".join((f"COALESCE(r.{_qi(c)}, {fill}) AS {_qi(c)}" if fill is not None else f"r.{_qi(c)}") for c in cols) or "r.matches"
            lines.append("CREATE TEMP VIEW main AS")
            lines.append(f"SELECT l.*, {outs}")
            lines.append(f"FROM {L} l")
            lines.append(f"LEFT JOIN (SELECT UPPER(CAST({_qi(st['right_on'])} AS VARCHAR)) AS k, {sel} FROM {R} GROUP BY 1) r")
            lines.append(f"  ON UPPER(CAST(l.{_qi(st['left_on'])} AS VARCHAR)) = r.k;")
            current["main"] = "main"
        elif k == "compute":
            r = st["right"] if isinstance(st["right"], (int, float)) else _qi(st["right"])
            if st.get("fill") is not None and not isinstance(st["right"], (int, float)):
                r = f"COALESCE({r}, {st['fill']})"
            left = f"COALESCE({_qi(st['left'])}, {st['fill']})" if st.get("fill") is not None else _qi(st["left"])
            lines.append(f"CREATE OR REPLACE TEMP VIEW main AS SELECT *, {left} {st['op']} {r} AS {_qi(st['column'])} FROM main;")
        elif k == "keep":
            lines.append(f"CREATE OR REPLACE TEMP VIEW main AS SELECT {', '.join(_qi(c) for c in st['columns'])} FROM main;")
        elif k == "rename" and st.get("source"):
            src = current.get(st["source"], st["source"])
            name = f"{st['source']}_read"
            lines.append(f"CREATE TEMP VIEW {name} AS SELECT * EXCLUDE ({', '.join(_qi(b) for b in st['columns'].values())}) RENAME ("
                         + ", ".join(f"{_qi(a)} AS {_qi(b)}" for a, b in st["columns"].items()) + f") FROM {src};")
            current[st["source"]] = name
        elif k == "rename":
            lines.append("CREATE OR REPLACE TEMP VIEW main AS SELECT * RENAME (" + ", ".join(f"{_qi(a)} AS {_qi(b)}" for a, b in st["columns"].items()) + ") FROM main;")
        lines.append("")
    last = "main" if "main" in current else next(iter(current.values()), "data")
    lines.append("-- checks (rows that fail are flagged, not dropped)")
    for c in spec.get("checks") or []:
        if not c.get("enabled", True):
            continue
        if c["kind"] == "unique":
            lines.append(f"SELECT {_qi(c['column'])}, COUNT(*) FROM {last} GROUP BY 1 HAVING COUNT(*) > 1;")
        elif c["kind"] == "min":
            lines.append(f"SELECT * FROM {last} WHERE {_qi(c['column'])} < {c['value']};")
        elif c["kind"] == "max":
            lines.append(f"SELECT * FROM {last} WHERE {_qi(c['column'])} > {c['value']};")
        elif c["kind"] == "not_empty":
            lines.append(f"SELECT * FROM {last} WHERE {_qi(c['column'])} IS NULL;")
        elif c["kind"] == "ready_by":
            lines.append(f"-- finished before {c['time']} ({spec.get('schedule', {}).get('timezone', 'UTC')})")
    hold = (spec.get("policy") or {}).get("hold_above", 50)
    lines.append("")
    lines.append(f"-- save: if more than {hold} rows are flagged, keep yesterday’s table and alert")
    lines.append(f"CREATE OR REPLACE TABLE {spec.get('output', {}).get('name', 'flow_output')} AS SELECT * FROM {last};")
    return "\n".join(lines)
