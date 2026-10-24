"""2026-10-19 (R57): reports at the length the person asks for - Brief (1 page), Standard (3-4 pages), Detailed
(8-12 pages) - written section by section from the steps a conversation ran.

Why this exists: until R57 every write-up had one fixed size. Explanations were a headline and 2-4 points, documents
"about 350 words" (600 with more than two answers), and nothing read "detailed", "full report" or "in depth".

How a Standard or Detailed report is made:
  1. The base: the latest answer in the conversation that has SQL steps. With none yet, its question is asked first
     as a guided plan that runs every step (a report needs several angles), so the report has steps to stand on.
  2. The outline (GD360 REPORT PLANNER): sections, each built on one or more steps. A Detailed report may name up to
     3 steps it still needs ("profit and margin by category", "2024 compared with 2023"); those are shown to the
     person first and only run after their OK. Without a model the outline is one section per step.
  3. Section by section (GD360 SECTION WRITER): paragraphs from that section's step results only, a chart drawn from
     the table itself (one colour, the top bar marked; a line for months), the table with exact values. Every number
     a section states is checked against its tables (and the totals, differences and shares worked out from them);
     a section with a number it cannot support is rewritten once, then the number is flagged in the document.
  4. The summary is written last from the sections and put first (GD360 REPORT SUMMARY), then "What to look at next"
     and a "Method and data" section built from the steps themselves (no model).
The document exists from the first second, so the canvas fills in as each section is done; the turn reports
"Writing section 3 of 8: Month by month".
"""
from __future__ import annotations

import json
import math
import re
import time
import traceback
from datetime import date, datetime

import pandas as pd
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from ... import models
from .. import ai_engine
from ..project_engine import numbers, present
from . import docblocks

PLANNER_MARK = "GD360 REPORT PLANNER"
SECTION_MARK = "GD360 SECTION WRITER"
SUMMARY_MARK = "GD360 REPORT SUMMARY"

LENGTHS: dict[str, dict] = {
    "brief": {"label": "Brief", "pages": "1 page", "words": "60-90", "sections": 3, "add": 0, "charts": 1},
    "standard": {"label": "Standard", "pages": "3-4 pages", "words": "110-170", "sections": 6, "add": 0, "charts": 4},
    "detailed": {"label": "Detailed", "pages": "8-12 pages", "words": "220-320", "sections": 10, "add": 3, "charts": 10},
}
DETAIL = re.compile(r"\b(detailed|in[- ]?depth|comprehensive|full|complete|thorough|long|deep[- ]?dive|extensive|everything)\b", re.I)
BRIEF = re.compile(r"\b(one[- ]?page(r)?|1[- ]page|short|brief(ly)?|concise|quick|tl;?dr|summary|summarise|summarize)\b", re.I)
REPORT_WORDS = re.compile(
    r"\b(give|show|send|get|need|want|make|create|write|draft|prepare|produce|put together|compose|build|me|us|a|an|the|please|"
    r"detailed|in[- ]?depth|comprehensive|full|complete|thorough|long|short|brief|quick|one[- ]?page(r)?|1[- ]page|"
    r"report|document|doc|memo|write-?up|summary|pdf|word|in|as|into|on|of|about|for)\b", re.I)


def length_of(text: str | None) -> str | None:
    """"detailed" / "brief" from the words of a request, else None (the caller picks Standard)."""
    t = text or ""
    if DETAIL.search(t):
        return "detailed"
    if BRIEF.search(t):
        return "brief"
    return None


def topic_of(request: str) -> str:
    """"give me a detailed report of 2024 sales" -> "2024 sales"."""
    t = REPORT_WORDS.sub(" ", request or "")
    t = re.sub(r"\s+", " ", re.sub(r"[^\w\s%$€£₹.,&/-]", " ", t)).strip(" ,.-")
    return t[:120]


# ---- the material: the base run and its step tables ----------------------------------------------------------

def base_run(db: Session, conv: models.Conversation) -> models.ProjectRun | None:
    """The latest answer with SQL steps that ran (an Analyst answer has no steps to write sections from)."""
    runs = (db.query(models.ProjectRun).filter(models.ProjectRun.conversation_id == conv.id, models.ProjectRun.status == "done")
            .order_by(models.ProjectRun.created_at.desc()).all())
    for r in runs:
        if (r.plan or {}).get("mode") == "analyst":
            continue
        if any(s.get("status") == "done" for s in r.steps or []):
            return r
    return None


def _payload_of(run: models.ProjectRun, step: dict) -> dict | None:
    """{columns, rows} for a step: its stored full result, else the evidence table (first 200 rows), else the preview."""
    from ..project_engine import guided
    df = guided.load_table(run, step["id"])
    if df is not None:
        from ..project_engine.analysis import table_payload
        p = table_payload(df, limit=200)
        try:
            return present.annotate(p)
        except Exception:  # noqa: BLE001
            return p
    ev = next((e for e in (run.result or {}).get("evidence") or [] if e.get("id") == step["id"]), None)
    if ev and ev.get("rows") is not None:
        p = {"columns": ev.get("columns") or [], "rows": ev.get("rows") or []}
        try:
            return present.annotate(p)
        except Exception:  # noqa: BLE001
            return p
    if step.get("columns"):
        return {"columns": step.get("columns") or [], "rows": step.get("preview") or []}
    return None


def step_tables(run: models.ProjectRun) -> list[dict]:
    """[{id, n, title, purpose, source, columns, rows}] for every step that ran, in order."""
    out = []
    n = 0
    for s in run.steps or []:
        if s.get("status") == "skipped":
            continue
        n += 1
        if s.get("status") != "done":
            continue
        p = _payload_of(run, s)
        if not p or not p.get("columns"):
            continue
        out.append({"id": s["id"], "n": n, "title": s.get("title") or f"Step {n}", "purpose": s.get("purpose"),
                    "source": s.get("source_name") or ("Combined" if s.get("kind") == "combine" else ""),
                    "rows_returned": s.get("rows_returned"), "columns": p["columns"], "rows": p["rows"]})
    return out


def _col_kind(c: dict, rows: list[dict]) -> str:
    if c.get("format"):
        return c["format"]
    if c.get("dtype") == "number":
        return present.column_kind(c["name"], [r.get(c["name"]) for r in rows])
    return "text"


def _cell(v, kind: str, currency: str | None) -> str:
    if v is None:
        return "—"
    if kind in ("currency", "percent", "ratio", "integer", "number"):
        try:
            return present.nice(v, kind, currency)
        except Exception:  # noqa: BLE001
            return str(v)
    s = str(v)
    m = re.match(r"^(\d{4}-\d{2}-\d{2})[T ]00:00:00", s)
    return m.group(1) if m else s


def _is_num(c: dict) -> bool:
    return c.get("dtype") == "number" or c.get("role") == "measure"


def _years_overview(t: dict, cols: list[dict]) -> list[dict] | None:
    """R60: per-year totals of each number column when the table has dates - the whole span at a glance."""
    date_col = next((c["name"] for c in cols if c.get("dtype") == "date" or re.search(r"(date|month|day|period|week)$", c["name"], re.I)), None)
    nums = [c["name"] for c in cols if _is_num(c)]
    if not date_col or not nums:
        return None
    acc: dict[str, dict] = {}
    for r in t["rows"]:
        m = re.match(r"(\d{4})", str(r.get(date_col) or ""))
        if not m:
            continue
        y = acc.setdefault(m.group(1), {"year": m.group(1), "rows": 0, **{n: 0.0 for n in nums}})
        y["rows"] += 1
        for n in nums:
            v = r.get(n)
            if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(float(v)):
                y[n] += float(v)
    if len(acc) < 2:
        return None
    return [{k: (round(v, 2) if isinstance(v, float) else v) for k, v in acc[y].items()} for y in sorted(acc)]


def table_for_prompt(t: dict, limit: int = 120) -> dict:
    """The rows the writer sees. R60: up to 120 rows (was 40 - a 5-year monthly table lost everything after April of
    year 4, and the report said nothing about the last two years); a longer table keeps its first and last rows and
    says how many were left out, and dated tables add per-year totals so no year is missed."""
    cols = t["columns"][:8]
    kinds = {c["name"]: _col_kind(c, t["rows"]) for c in cols}
    cur = next((c.get("currency") for c in cols if c.get("currency")), None)
    src = t["rows"]
    if len(src) > limit:
        head = max(1, limit // 4)
        picked, left_out = src[:head] + src[-(limit - head):], len(src) - limit
    else:
        picked, left_out = src, 0
    rows = [{(c.get("label") or c["name"]): _cell(r.get(c["name"]), kinds[c["name"]], cur) for c in cols} for r in picked]
    out = {"step": t["n"], "id": t["id"], "title": t["title"], "purpose": t.get("purpose"), "source": t["source"],
           "rows_total": len(src), "rows": rows}
    if left_out:
        out["rows_left_out"] = f"{left_out} rows in the middle are not shown; the first {limit // 4} and the last {limit - limit // 4} are"
    years = _years_overview(t, cols)
    if years:
        out["totals_by_year"] = years
    return out


def derived_allowed(tables: list[dict]) -> list[float]:
    """Numbers a careful analyst works out from a table: column totals, the change between neighbouring rows (in
    units and in %), each row's share of its column, and averages - so "+$1.5M from October to November" or
    "58% of sales" are supported when the table holds the two figures."""
    vals: list[float] = []
    for t in tables:
        rows = t["rows"][:120]
        for c in t["columns"]:
            if not _is_num(c):
                continue
            xs = [float(v) for v in (r.get(c["name"]) for r in rows) if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(float(v))]
            if not xs:
                continue
            tot = sum(xs)
            vals += [tot, tot / len(xs), max(xs), min(xs), max(xs) - min(xs)]
            for a, b in zip(xs, xs[1:]):
                vals.append(b - a)
                if a:
                    vals.append(100 * (b - a) / abs(a))
            if xs[0] and len(xs) > 1:
                vals.append(100 * (xs[-1] - xs[0]) / abs(xs[0]))
                vals.append(xs[-1] - xs[0])
            if tot:
                vals += [100 * x / tot for x in xs]
            for i, x in enumerate(xs[:40]):
                for y in xs[i + 1:40]:
                    if y:
                        vals.append(x / y)
                    if x:
                        vals.append(y / x)
        # R60: the per-year totals the writer is shown, and each year's change on the year before
        years = _years_overview(t, t["columns"][:8]) or []
        for c in t["columns"][:8]:
            ys = [y[c["name"]] for y in years if isinstance(y.get(c["name"]), (int, float))]
            vals += ys
            for a, b in zip(ys, ys[1:]):
                vals.append(b - a)
                if a:
                    vals.append(100 * (b - a) / abs(a))
    return vals


def allowed_for(tables: list[dict], extra: list[dict] | None = None) -> list[float]:
    raw = [{"rows": t["rows"][:400]} for t in tables]
    return numbers.allowed_values(extra or [], raw, "") + derived_allowed(tables)


# ---- blocks drawn from a table ---------------------------------------------------------------------------------

def _calendar(values: list) -> bool:
    try:
        if present.is_month_series(values):
            return True
    except Exception:  # noqa: BLE001
        pass
    vs = [str(v) for v in values if v is not None][:24]
    return len(vs) >= 3 and all(re.match(r"^\d{4}-\d{2}(-\d{2})?", v) for v in vs)


def figure_from(t: dict, cite: str, label_col: str | None = None, value_col: str | None = None, kind: str | None = None) -> dict | None:
    """A chart from the table itself: bars (the 12 largest, one colour, the top one marked) or a line for a series
    over time. None when the table has no label column and number column to draw."""
    cols, rows = t["columns"], t["rows"]
    if len(rows) < 2:
        return None
    labels = [c for c in cols if not _is_num(c)]
    nums = [c for c in cols if _is_num(c)]
    if not nums:
        return None
    lab = next((c for c in cols if c["name"] == label_col), None) or (labels[0] if labels else None)
    if lab is None:
        return None
    val = next((c for c in nums if c["name"] == value_col), None)
    if val is None:
        val = next((c for c in nums if _col_kind(c, rows) == "currency"), None) or nums[0]
    vk = _col_kind(val, rows)
    cur = val.get("currency")
    pts = [(r.get(lab["name"]), r.get(val["name"])) for r in rows]
    pts = [(str(_cell(a, "text", None)), float(b)) for a, b in pts if isinstance(b, (int, float)) and not isinstance(b, bool) and math.isfinite(float(b)) and a is not None]
    if len(pts) < 2:
        return None
    line = kind == "line" or (kind is None and _calendar([a for a, _ in pts]))
    unit = "%" if vk in ("percent", "ratio") else ""
    scale = 100 if vk == "ratio" else 1
    if line:
        pts = pts[:60]
        bars = [{"label": a, "value": round(v * scale, 4), "display": present.nice(v, vk, cur), "tone": "main"} for a, v in pts]
        title = f"{val.get('label') or present.humanize(val['name'])} by {str(lab.get('label') or present.humanize(lab['name'])).lower()}"
        return {"id": docblocks._bid(), "type": "figure", "kind": "line", "title": title, "unit": unit, "bars": bars,
                "subtitle": f"Step {t['n']} · {t['title']}", "baseline": None, "cites": [cite], "column": val["name"]}
    pairs = sorted(pts, key=lambda x: -x[1])
    total = len(pairs)
    pairs = pairs[:12]
    top = pairs[0][1]
    bars = [{"label": a, "value": round(v * scale, 4), "display": present.nice(v, vk, cur), "tone": "top" if v == top else "main"} for a, v in pairs]
    title = f"{val.get('label') or present.humanize(val['name'])} by {str(lab.get('label') or present.humanize(lab['name'])).lower()}"
    sub = f"Step {t['n']} · {t['title']}" + (f" · the {len(pairs)} largest of {total}" if total > len(pairs) else "")
    return {"id": docblocks._bid(), "type": "figure", "kind": "bars", "title": title, "unit": unit, "bars": bars,
            "subtitle": sub, "baseline": None, "cites": [cite], "column": val["name"]}


def table_from(t: dict, cite: str, limit: int = 10) -> dict | None:
    cols = t["columns"][:6]
    rows = t["rows"]
    if not rows or not cols:
        return None
    kinds = {c["name"]: _col_kind(c, rows) for c in cols}
    cur = next((c.get("currency") for c in cols if c.get("currency")), None)
    out_rows = []
    for r in rows[:limit]:
        row = {}
        for c in cols:
            v = r.get(c["name"])
            k = kinds[c["name"]]
            if k == "currency" and isinstance(v, (int, float)) and not isinstance(v, bool):
                sym = numbers._symbol(cur)
                row[c["name"]] = f"{'−' if v < 0 else ''}{sym}{abs(v):,.0f}" if abs(v) >= 100 else _cell(v, k, cur)
            else:
                row[c["name"]] = _cell(v, k, cur)
        out_rows.append(row)
    return {"id": docblocks._bid(), "type": "table", "cites": [cite],
            "columns": [{"key": c["name"], "label": c.get("label") or present.humanize(c["name"]), **({"align": "right"} if _is_num(c) else {})} for c in cols],
            "rows": out_rows, "note": (f"First {limit} of {len(rows)} rows · every row is in step {t['n']}" if len(rows) > limit else None)}


# ---- the model calls -------------------------------------------------------------------------------------------

def _llm_json(system: str, user: str, max_tokens: int = 2500) -> dict | None:
    try:
        raw = ai_engine._plan_with_retry([{"role": "system", "content": system}, {"role": "user", "content": user}], max_tokens=max_tokens)
        return raw if isinstance(raw, dict) else None
    except Exception as e:  # noqa: BLE001 - every call has a plain fallback
        print(f"[agent.report] model call skipped: {str(e)[:200]}")
        return None


PLANNER_SYSTEM = f"""You are the {PLANNER_MARK}. Plan a business report from the analysis steps of a conversation.
You get the person's request, the report length, and every step that ran (its title, what it computes and its result rows).

Return JSON only:
{{"title": "<a plain title, at most 8 words, e.g. '2024 sales report'>",
  "sections": [{{"title": "<plain heading, at most 6 words>", "steps": [<step numbers it uses>], "angle": "<one sentence: what the section explains>"}}],
  "add": [{{"instruction": "<one new step to run, in plain words, e.g. 'profit and margin by product category for 2024'>", "why": "<one short reason>"}}]}}

Rules:
- Order sections the way a reader needs them: the overall numbers first, then how they moved over time, then the breakdowns.
- Every section uses at least one step; use each step at most twice. No section without data.
- "add" lists steps a {{length}} report still needs to be complete (comparison with the year before, margins, returns or discounts),
  only when the request or the length calls for depth and the data plausibly has the columns. At most {{max_add}}; [] when none.
- Never invent numbers."""

SECTION_SYSTEM = f"""You are the {SECTION_MARK}. Write ONE section of a business report from the tables you are given - and only from them.

Return JSON only:
{{"paragraphs": ["<paragraph>", "..."], "chart": {{"step": <step number>, "label": "<label column as given>", "value": "<number column as given>", "kind": "bars|line"}} or null}}

Rules:
- {{words}} words in {{paras}} paragraph(s). Plain sentences for a busy manager: the finding first, then the comparison, then why it matters.
- Use only numbers that appear in the tables, or that follow directly from two of them (a difference, a share, a % change).
  Write money compactly ($35.5M, $8.0M, $1,278); never invent a figure, a date, a cause or a name.
- Say what the numbers show, not what you did. No headings, no bullet lists, no markdown except **bold** for at most two key figures.
- "chart": the one chart that best shows this section's point (a line for a series over months or dates), or null."""

SUMMARY_SYSTEM = f"""You are the {SUMMARY_MARK}. From the finished sections of a report, write its opening.

Return JSON only:
{{"lead": "<one or two sentences: the overall result, with its key numbers>",
  "findings": ["<one sentence each, 3 to 5, the most important points, each with its number>"],
  "next": "<one or two sentences: what to look at or do next, following from the findings>"}}

Use only numbers that appear in the sections. No markdown except **bold** for a key figure."""


def plan(request: str, length: str, tables: list[dict]) -> dict:
    spec = LENGTHS[length]
    fallback = {"title": None, "sections": [{"title": t["title"], "steps": [t["n"]], "angle": t.get("purpose") or ""} for t in tables][: spec["sections"]], "add": []}
    payload = {"request": request, "length": spec["label"], "steps": [table_for_prompt(t, 12) for t in tables]}
    raw = _llm_json(PLANNER_SYSTEM.replace("{length}", spec["label"]).replace("{max_add}", str(spec["add"])),
                    json.dumps(payload, ensure_ascii=False, default=str)[:24000], 2000)
    if not raw:
        return fallback
    by_n = {t["n"] for t in tables}
    secs = []
    for s in raw.get("sections") or []:
        if not isinstance(s, dict):
            continue
        steps = [int(x) for x in (s.get("steps") or []) if str(x).lstrip("-").isdigit() and int(x) in by_n]
        if not steps or not str(s.get("title") or "").strip():
            continue
        secs.append({"title": str(s["title"]).strip()[:70], "steps": steps[:3], "angle": str(s.get("angle") or "")[:240]})
    if not secs:
        secs = fallback["sections"]
    used = {n for s in secs for n in s["steps"]}
    for t in tables:  # a step the outline left out still gets its section, at the end
        if t["n"] not in used and len(secs) < spec["sections"]:
            secs.append({"title": t["title"], "steps": [t["n"]], "angle": t.get("purpose") or ""})
    add = []
    for a in (raw.get("add") or [])[: spec["add"]]:
        if isinstance(a, dict) and len(str(a.get("instruction") or "").strip()) > 6:
            add.append({"instruction": str(a["instruction"]).strip()[:200], "why": str(a.get("why") or "")[:160]})
    title = str(raw.get("title") or "").strip()[:80] or None
    return {"title": title, "sections": secs[: spec["sections"]], "add": add}


def _section_fallback(sec: dict, tables: list[dict]) -> dict:
    """Without a model: the facts the table states, in plain sentences - the top row and the total."""
    paras = []
    for t in tables:
        nums = [c for c in t["columns"] if _is_num(c)]
        labs = [c for c in t["columns"] if not _is_num(c)]
        if not nums:
            continue
        v = next((c for c in nums if _col_kind(c, t["rows"]) == "currency"), nums[0])
        kind = _col_kind(v, t["rows"])
        cur = v.get("currency")
        if labs and len(t["rows"]) > 1:
            best = max(t["rows"], key=lambda r: float(r.get(v["name"]) or 0) if isinstance(r.get(v["name"]), (int, float)) else float("-inf"))
            paras.append(f"{_cell(best.get(labs[0]['name']), 'text', None)} has the highest {str(v.get('label') or v['name']).lower()}, "
                         f"{_cell(best.get(v['name']), kind, cur)}, of the {len(t['rows'])} {str(labs[0].get('label') or labs[0]['name']).lower()} values in {t['title'].lower()}.")
        elif t["rows"]:
            r = t["rows"][0]
            bits = [f"{str(c.get('label') or c['name']).lower()} {_cell(r.get(c['name']), _col_kind(c, t['rows']), c.get('currency'))}" for c in nums[:4]]
            paras.append(f"{t['title']}: " + ", ".join(bits) + ".")
    return {"paragraphs": paras or [sec.get("angle") or "The step's result is in the table below."], "chart": None}


def write_section(sec: dict, tables: list[dict], length: str, request: str) -> tuple[dict, list[str]]:
    """({paragraphs, chart}, flagged numbers)."""
    spec = LENGTHS[length]
    paras = "1" if length == "brief" else ("2" if length == "standard" else "3 to 4")
    system = SECTION_SYSTEM.replace("{words}", spec["words"]).replace("{paras}", paras)
    payload = {"request": request, "section": sec["title"], "angle": sec.get("angle"), "tables": [table_for_prompt(t) for t in tables]}
    allowed = allowed_for(tables)
    msgs_user = json.dumps(payload, ensure_ascii=False, default=str)[:60000]
    raw = _llm_json(system, msgs_user, 2500)
    if not raw or not [p for p in raw.get("paragraphs") or [] if str(p).strip()]:
        return _section_fallback(sec, tables), []

    def bad_of(r: dict) -> list[str]:
        txt = " ".join(docblocks.plain(str(p)) for p in r.get("paragraphs") or [])
        return numbers.unsupported_numbers(txt, allowed, None) if allowed else []

    flagged = bad_of(raw)
    if flagged:
        again = _llm_json(system, msgs_user + "\n\nYour last draft stated numbers that are not in the tables: " + ", ".join(flagged[:8])
                          + ". Write the section again using only numbers from the tables (or a difference/share of two of them).", 2500)
        if again and [p for p in again.get("paragraphs") or [] if str(p).strip()]:
            f2 = bad_of(again)
            if len(f2) <= len(flagged):
                raw, flagged = again, f2
    out = {"paragraphs": [str(p).strip() for p in raw.get("paragraphs") or [] if str(p).strip()][:5], "chart": raw.get("chart") if isinstance(raw.get("chart"), dict) else None}
    return out, flagged


def write_summary(sections_text: list[dict], allowed: list[float]) -> dict | None:
    raw = _llm_json(SUMMARY_SYSTEM, json.dumps({"sections": sections_text}, ensure_ascii=False)[:24000], 1500)
    if not raw or not str(raw.get("lead") or "").strip():
        return None
    return {"lead": str(raw["lead"]).strip(), "findings": [str(x).strip() for x in raw.get("findings") or [] if str(x).strip()][:5],
            "next": str(raw.get("next") or "").strip() or None}


# ---- the job ---------------------------------------------------------------------------------------------------

class NeedsSteps(Exception):
    """A Detailed report needs steps the conversation does not have yet; the turn asks the person first."""

    def __init__(self, add: list[dict], base: models.ProjectRun, outline: dict):
        super().__init__("needs steps")
        self.add, self.base, self.outline = add, base, outline


def ensure_base(db: Session, user: models.User, conv: models.Conversation, request: str, progress) -> models.ProjectRun | None:
    """The answer the report stands on. With none yet and data connected, the topic is asked first as a plan that
    runs every step (up to 3 minutes)."""
    run = base_run(db, conv)
    if run is not None or not (conv.source_ids or []):
        return run
    from ...routers import projects as projects_router
    topic = topic_of(request) or (conv.title or "the data")
    question = f"{topic[:1].upper() + topic[1:]}: the overall numbers, how they moved over time and the main breakdowns"
    progress(f"Reading the data first: {topic}")
    out = projects_router.ask(conv.id, projects_router.AskRequest(question=question, auto_run=True, route=False, understand=False),
                              db=db, user=user)
    if out.get("kind") != "run":
        return None
    rid = out["run_id"]
    r = db.get(models.ProjectRun, rid)
    r.plan = dict(r.plan or {}) | {"report_base": True}
    flag_modified(r, "plan")
    db.commit()
    deadline = time.time() + 180
    while time.time() < deadline:
        time.sleep(1.5)
        db.expire_all()
        r = db.get(models.ProjectRun, rid)
        if r is None or r.status in ("done", "failed", "stopped", "needs_input"):
            break
    return r if r is not None and r.status == "done" else None


def run_added(db: Session, run: models.ProjectRun, add: list[dict], progress) -> list[str]:
    """Adds the approved steps to the answer's steps and runs them. The answer itself stays as it was written; the
    new steps are there for the report (and on the canvas). Returns the titles that ran."""
    from ..project_engine import guided
    was_done = run.status == "done"
    if not guided._claim(run.id):
        raise docblocks.DocError("The steps are still running. Try again when they are done.")
    titles = []
    try:
        for i, a in enumerate(add):
            progress(f"Running added step {i + 1} of {len(add)}: {a['instruction'][:60]}")
            try:
                st = guided.add_step(db, run, a["instruction"])
            except guided.GuidedError as e:
                print(f"[agent.report] step not added: {e}")
                continue
            guided.run_step(db, run.id, st["id"])
            db.refresh(run)
            done = guided.find(run, st["id"]) or {}
            if done.get("status") == "done":
                titles.append(done.get("title") or a["instruction"])
        if was_done:
            db.refresh(run)
            run.status = "done"
            res = dict(run.result or {})
            res["answer_stale"] = False
            run.result = res
            flag_modified(run, "result")
            run.steps = [{**s, "approved": True} if s.get("status") == "done" else s for s in run.steps or []]
            flag_modified(run, "steps")
            db.commit()
    finally:
        guided._release(run.id)
    return titles


def _today_words(d: date) -> str:
    return f"{d.day} {docblocks.MONTHS[d.month - 1]} {d.year}"


def write(db: Session, user: models.User, conv: models.Conversation, msg: models.Message, request: str, length: str,
          today: date | None = None, approved: bool | None = None, on_progress=None) -> models.DocDocument:
    """Builds the document section by section. Raises NeedsSteps (a Detailed report that needs steps the person has
    not approved yet) or docblocks.DocError."""
    today = today or date.today()
    spec = LENGTHS[length]

    def progress(label: str, **kw):
        if on_progress:
            on_progress(label, **kw)

    run = ensure_base(db, user, conv, request, progress)
    if run is None:
        raise docblocks.DocError("There is nothing to write a report from yet. Ask a question about your data first; "
                                 "the report is written from the steps that answer it.")
    tables = step_tables(run)
    if not tables:
        raise docblocks.DocError("The answer above has no step results to write from. Run its steps again, then ask for the report.")
    progress("Planning the sections")
    outline = plan(request, length, tables)
    if outline["add"] and approved is None:
        raise NeedsSteps(outline["add"], run, outline)
    added_titles: list[str] = []
    if outline["add"] and approved:
        added_titles = run_added(db, run, outline["add"], progress)
        db.refresh(run)
        tables = step_tables(run)
        new_ns = [t["n"] for t in tables if t["title"] in added_titles]
        # the added steps get their own sections, before "Method and data"
        for t in tables:
            if t["n"] in new_ns and not any(t["n"] in s["steps"] for s in outline["sections"]):
                outline["sections"].append({"title": t["title"], "steps": [t["n"]], "angle": t.get("purpose") or ""})
    by_n = {t["n"]: t for t in tables}
    sections = [s for s in outline["sections"] if any(n in by_n for n in s["steps"])][: spec["sections"] + len(added_titles)]
    topic = topic_of(request) or (run.question or "").rstrip("?")
    title = outline.get("title") or (f"{topic[:1].upper() + topic[1:]} report" if topic else "Report")
    srcs = sorted({t["source"] for t in tables if t["source"] and t["source"] != "Combined"})

    sources: list[dict] = []
    cite_of = {t["n"]: docblocks._src(sources, kind="step", turn_id=run.id, step=t["id"], label=f"Step {t['n']} · {t['title']}") for t in tables}
    blocks: list[dict] = [
        {"id": docblocks._bid(), "type": "title", "text": title},
        {"id": docblocks._bid(), "type": "byline", "text": f"{spec['label']} report · prepared {_today_words(today)} · from {', '.join(srcs) or 'this conversation'}"
                                                            f" · {len(tables)} step{'s' if len(tables) != 1 else ''}, every number linked"},
    ]
    heads = [{"id": docblocks._bid(), "title": s["title"], "status": "waiting"} for s in sections]
    plan_rows = [{"title": "Summary", "status": "waiting", "id": docblocks._bid()}] + heads + [{"title": "Method and data", "status": "waiting", "id": docblocks._bid()}]
    allowed_all = allowed_for(tables, (run.result or {}).get("facts") or [])
    meta = {"allowed": sorted(set(round(float(a), 6) for a in allowed_all if a is not None and math.isfinite(float(a))))[:8000],
            "short": length == "brief", "kind": "report", "request": request[:300], "analysis_turn": None,
            "report": {"length": length, "status": "writing", "sections": plan_rows, "run_id": run.id, "added": added_titles}}
    doc = models.DocDocument(owner_id=user.id, workspace_id=conv.workspace_id, conversation_id=conv.id, message_id=msg.id,
                             title=title, blocks=blocks + [{"id": docblocks._bid(), "type": "sources"}], sources=sources, meta=meta, history=[])
    db.add(doc)
    db.commit()
    db.refresh(doc)
    progress("Writing", doc=doc, total=len(plan_rows), done=0)

    def save(body: list[dict]):
        doc.blocks = blocks + body + [{"id": docblocks._bid(), "type": "sources"}]
        doc.sources = sources
        doc.meta = dict(meta)
        flag_modified(doc, "blocks")
        flag_modified(doc, "sources")
        flag_modified(doc, "meta")
        doc.updated_at = datetime.utcnow()
        db.commit()

    def mark(i: int, status: str):
        meta["report"]["sections"][i]["status"] = status

    body: list[dict] = []
    texts: list[dict] = []
    flagged_all: list[str] = []
    charts = 0
    # the key numbers come first, from the answer's own figures
    kpis = [k for k in (run.result or {}).get("kpis") or [] if isinstance(k, dict) and k.get("display")][:4]
    for i, sec in enumerate(sections):
        row = i + 1
        mark(row, "writing")
        save(body)
        progress(f"Writing section {row + 1} of {len(plan_rows)}: {sec['title']}", doc=doc, total=len(plan_rows), done=row)
        ts = [by_n[n] for n in sec["steps"] if n in by_n]
        try:
            out, flagged = write_section(sec, ts, length, request)
        except Exception:  # noqa: BLE001 - one section never sinks the report
            traceback.print_exc()
            out, flagged = _section_fallback(sec, ts), []
        flagged_all += flagged
        cites = [cite_of[t["n"]] for t in ts]
        hid = heads[i]["id"]
        body.append({"id": hid, "type": "heading", "level": 2, "text": sec["title"]})
        if i == 0 and kpis:
            body.append({"id": docblocks._bid(), "type": "kpis", "cites": cites,
                         "items": [{"label": k.get("label"), "value": k.get("display"), "note": k.get("note")} for k in kpis]})
        for p in out["paragraphs"]:
            body.append({"id": docblocks._bid(), "type": "paragraph", "text": docblocks.bold_numbers(docblocks.plain(p)) if "**" not in p else p, "cites": cites})
        fig = None
        if charts < spec["charts"]:
            ch = out.get("chart") or {}
            src_t = next((t for t in ts if str(ch.get("step")) == str(t["n"])), ts[0] if ts else None)
            if src_t is not None:
                lab = next((c["name"] for c in src_t["columns"] if c["name"] == ch.get("label") or (c.get("label") or "") == ch.get("label")), None)
                val = next((c["name"] for c in src_t["columns"] if c["name"] == ch.get("value") or (c.get("label") or "") == ch.get("value")), None)
                fig = figure_from(src_t, cite_of[src_t["n"]], lab, val, ch.get("kind") if ch.get("kind") in ("bars", "line") else None)
        if fig:
            body.append(fig)
            charts += 1
        if length != "brief":
            for t in ts[:2 if length == "detailed" else 1]:
                if len(t["rows"]) > 1 or length == "detailed":
                    tb = table_from(t, cite_of[t["n"]], 12 if length == "detailed" else 8)
                    if tb:
                        body.append(tb)
        texts.append({"section": sec["title"], "text": " ".join(out["paragraphs"])})
        mark(row, "done")
        save(body)

    # the opening, written last from what the sections say
    mark(0, "writing")
    save(body)
    progress(f"Writing the summary ({len(plan_rows)} of {len(plan_rows)})", doc=doc, total=len(plan_rows), done=len(plan_rows) - 1)
    allowed_sum = allowed_all + [n for _t, n, _p in numbers.extract_numbers(" ".join(x["text"] for x in texts))]
    summ = write_summary(texts, allowed_sum)
    opening: list[dict] = [{"id": plan_rows[0]["id"], "type": "heading", "level": 2, "text": "Summary"}]
    all_cites = list(cite_of.values())
    if summ:
        # the summary restates the sections, so it carries no step chips of its own - each number in it was checked
        # against the steps, and every section below links its own step
        opening.append({"id": docblocks._bid(), "type": "paragraph", "text": summ["lead"] if "**" in summ["lead"] else docblocks.bold_numbers(summ["lead"]), "cites": []})
        if summ["findings"]:
            opening.append({"id": docblocks._bid(), "type": "list", "items": [f if "**" in f else docblocks.bold_numbers(f) for f in summ["findings"]], "cites": []})
        if summ.get("next"):
            opening.append({"id": docblocks._bid(), "type": "callout", "tone": "next", "label": "What to look at next", "text": summ["next"], "cites": []})
    else:
        ans = (run.result or {}).get("answer") or {}
        lead = " ".join(x for x in (ans.get("headline"), ans.get("answer")) if x) or (texts[0]["text"] if texts else "")
        opening.append({"id": docblocks._bid(), "type": "paragraph", "text": docblocks.bold_numbers(str(lead)[:900]), "cites": all_cites[:3]})
    body = opening + body
    mark(0, "done")

    # method and data: from the steps themselves
    mark(len(plan_rows) - 1, "writing")
    items = [f"**Source{'s' if len(srcs) != 1 else ''}:** {', '.join(srcs) or 'the data in this conversation'}. Read in place, read-only."]
    for t in tables:
        rows = t.get("rows_returned")
        items.append(f"**Step {t['n']} · {t['title']}**" + (f" — {t['purpose'].rstrip('.')}" if t.get("purpose") else "")
                     + (f" ({rows:,} row{'s' if rows != 1 else ''})" if isinstance(rows, int) else "") + ".")
    nf = len(set(flagged_all))
    items.append("**Checks:** every number in a section was compared with that section's step results before the next section was "
                 "written" + (f"; {nf} figure{'s' if nf != 1 else ''} could not be matched and {'is' if nf == 1 else 'are'} flagged." if nf else "."))
    if added_titles:
        items.append(f"**Added for this report:** {', '.join(added_titles)} (approved before they ran).")
    items.append("**Not included:** forecasts or targets, unless a step above computes them. These are the recorded figures only.")
    body += [{"id": plan_rows[-1]["id"], "type": "heading", "level": 2, "text": "Method and data"},
             {"id": docblocks._bid(), "type": "list", "items": items, "cites": all_cites}]
    mark(len(plan_rows) - 1, "done")
    meta["report"]["status"] = "done"
    meta["report"]["flagged"] = list(dict.fromkeys(flagged_all))[:10]
    save(body)
    db.refresh(doc)
    return doc
