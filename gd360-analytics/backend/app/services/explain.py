"""
Explain what is already on screen (2026-10-11, Explain & Alerts).

"Explain this chart" used to start a whole new analysis - a new plan, new
queries, a new question tab - for numbers GD360 had already computed. Now:

  explain_run(...)    an answer, one of its charts, or one cause card,
                      explained from the run's OWN result (no query, about
                      2 seconds);
  route(...)          a typed follow-up: "explain" (answered from the
                      result on screen) or "analyze" (a new run, as before);
  explain_block(...)  one dashboard chart or tile, from the rows it shows;
  answer_page(...)    a question about a dashboard page, from its tiles.

Every number a model writes is checked against the numbers GD360 computed
(plus a few it derives here - totals, shares, gaps, changes). A sentence
with a number that isn't one of them is not shown: the explanation falls
back to one written from the numbers alone (written_by "numbers").
"""
from __future__ import annotations

import logging
import math
import re
import time

from .project_engine import present

logger = logging.getLogger("gd360.explain")

MAX_ROWS = 60
MAX_POINTS = 4

_NUM = re.compile(r"(?<![\w.])([-−]?)([$€£₹¥]?)(\d[\d,]*(?:\.\d+)?)\s*(%|k\b|K\b|M\b|B\b|bn\b|mn\b|pts?\b|points?\b)?")
_YEAR = re.compile(r"^(19|20)\d\d$")
_MON = r"(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?"
_DATES = re.compile(
    rf"\b\d{{4}}-\d{{2}}(?:-\d{{2}})?\b|\b\d{{1,2}}(?:st|nd|rd|th)?\s+{_MON}(?:\s+\d{{4}})?\b|\b{_MON}\s+\d{{1,2}}(?:st|nd|rd|th)?\b|"
    rf"\bq[1-4]\b|\b\d{{1,2}}/\d{{1,2}}/\d{{2,4}}\b|\bweek\s+\d{{1,2}}\b", re.I)


class ExplainError(ValueError):
    pass


# ----------------------------------------------------------------- numbers ----

def _f(v) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def numbers_in(text: str) -> list[tuple[float, str, str]]:
    """(value, unit, raw) for every number written in `text`."""
    out = []
    for m in _NUM.finditer(text or ""):
        sign, sym, whole, unit = m.groups()
        try:
            v = float(whole.replace(",", ""))
        except ValueError:
            continue
        u = (unit or "").lower()
        if u == "k":
            v *= 1e3
        elif u in ("m", "mn"):
            v *= 1e6
        elif u in ("b", "bn"):
            v *= 1e9
        if sign in ("-", "−"):
            v = -v
        out.append((v, "%" if u == "%" else ("pts" if u.startswith("p") else ""), m.group(0)))
    return out


class Allowed:
    """The numbers an explanation may use."""

    def __init__(self):
        self.idx: list[tuple[float, str]] = []

    def add(self, v, kind: str = "number"):
        f = _f(v)
        if f is not None:
            self.idx.append((f, kind))
            if kind == "ratio":
                self.idx.append((f * 100, "percent"))

    def add_text(self, text: str):
        for v, unit, _ in numbers_in(text):
            self.idx.append((v, "percent" if unit == "%" else "number"))

    def ok(self, v: float, raw: str) -> bool:
        digits = re.sub(r"[^\d.]", "", raw)
        if _YEAR.match(digits.split(".")[0]) and "." not in digits and "%" not in raw:
            return True
        if abs(v) <= 12 and float(v).is_integer() and "%" not in raw:
            return True  # "3 causes", "the 2 hotels", "12 months"
        return present.match_index(v, self.idx) is not None or present.match_index(-v, self.idx) is not None

    def check(self, text: str) -> list[str]:
        masked = _DATES.sub(lambda m: " " * len(m.group(0)), text or "")
        return [raw.strip() for v, _, raw in numbers_in(masked) if not self.ok(v, raw)]


# ------------------------------------------------------------- run context ----

def _kind_of(column: str, values: list) -> str:
    try:
        return present.column_kind(column, present._numbers(values))  # noqa: SLF001
    except Exception:  # noqa: BLE001
        return "number"


def _is_dim(c: str, rows: list[dict], known: set[str]) -> bool:
    if c in known:
        return True
    vals = [r.get(c) for r in rows if r.get(c) is not None]
    if not any(isinstance(v, (int, float)) and not isinstance(v, bool) for v in vals):
        return True
    if present._YEAR_NAME.search(str(c)) or present._MONTH_NAME.search(str(c)) or c == "period":  # noqa: SLF001
        return True
    ints = [v for v in vals if isinstance(v, (int, float))]
    return bool(ints) and all(float(v).is_integer() and 1900 <= v <= 2100 for v in ints) and len(set(ints)) == len(ints)


def _rows_facts(title: str, columns: list[str], rows: list[dict], allowed: Allowed, currency: str | None,
                dimensions: list[str] | None = None) -> list[str]:
    """A few derived numbers for a chart's rows: total, top, bottom, gap, share, first->last."""
    if not rows or not columns:
        return []
    dims = [c for c in columns if _is_dim(c, rows, set(dimensions or []))]
    meas = [c for c in columns if c not in dims]
    if not meas:
        return []
    m = meas[0]
    dim = dims[0] if dims else None
    vals = [(r.get(dim) if dim else i, _f(r.get(m))) for i, r in enumerate(rows)]
    vals = [(k, v) for k, v in vals if v is not None]
    if not vals:
        return []
    kind = _kind_of(m, [v for _, v in vals])
    nice = lambda v: present.nice(v, kind, currency)  # noqa: E731
    facts = []
    total = sum(v for _, v in vals)
    top = max(vals, key=lambda x: x[1])
    low = min(vals, key=lambda x: x[1])
    additive = kind not in ("percent", "ratio") and not re.search(r"avg|average|rate|ratio|mean|pct|share", m, re.I)
    if additive and len(vals) > 1:
        allowed.add(total, kind)
        facts.append(f"{present.humanize(m)} in total: {nice(total)}")
    if dim and len(vals) > 1:
        allowed.add(top[1], kind)
        allowed.add(low[1], kind)
        facts.append(f"Highest: {top[0]} at {nice(top[1])}; lowest: {low[0]} at {nice(low[1])}")
        gap = top[1] - low[1]
        allowed.add(gap, kind)
        if low[1]:
            allowed.add((top[1] / low[1] - 1) * 100, "percent")
            facts.append(f"Gap between them: {nice(gap)} ({(top[1] / low[1] - 1) * 100:.1f}% more)")
        if additive and total:
            share = top[1] / total * 100
            allowed.add(share, "percent")
            facts.append(f"{top[0]} is {share:.1f}% of the total")
        first, last = vals[0], vals[-1]
        if first[1]:
            ch = (last[1] - first[1]) / abs(first[1]) * 100
            allowed.add(ch, "percent")
            allowed.add(last[1] - first[1], kind)
            facts.append(f"From {first[0]} to {last[0]}: {nice(first[1])} -> {nice(last[1])} ({ch:+.1f}%)")
    return facts


def _visual_brief(v: dict, i: int, allowed: Allowed, currency: str | None) -> dict:
    t = v.get("type")
    title = v.get("title") or ("Key numbers" if t == "kpis" else f"Chart {i + 1}")
    if t == "waterfall":
        items = v.get("items") or []
        fmt = v.get("format") or "currency"
        cur = v.get("currency") or currency
        for it in items:
            allowed.add(it.get("value"), fmt)
        start = next((it for it in items if it.get("kind") == "total"), None)
        end = next((it for it in reversed(items) if it.get("kind") == "total"), None)
        moves = [it for it in items if it.get("kind") != "total"]
        net = sum(_f(it.get("value")) or 0 for it in moves)
        allowed.add(net, fmt)
        facts = []
        summary = None
        if start and end and start is not end:
            summary = (f"The total went from {present.nice(start.get('value'), fmt, cur)} ({start.get('label')}) to "
                       f"{present.nice(end.get('value'), fmt, cur)} ({end.get('label')}) - a net change of {present.nice(net, fmt, cur)}")
            facts.append(summary)
            if _f(start.get("value")):
                pct = net / abs(float(start["value"])) * 100
                allowed.add(pct, "percent")
                facts.append(f"Net change as a share of the start: {pct:+.1f}%")
        for it in moves:
            val = _f(it.get("value")) or 0
            share = (abs(val) / abs(net) * 100) if net else None
            if share is not None:
                allowed.add(share, "percent")
            if share is not None and share > 100:
                note = f" - more than the whole net change ({share:.1f}% of it), so moves the other way made up the difference"
            elif share is not None:
                note = f" ({share:.1f}% of the net change)"
            else:
                note = ""
            facts.append(f"{it.get('label')} {'added' if val >= 0 else 'took away'} {present.nice(abs(val), fmt, cur)}{note}")
        return {"index": i, "type": "waterfall", "title": title, "facts": facts, "summary": summary}
    if t == "forecast":
        # round 32: a forecast chart - what it forecasts, its range, how it was made, year by year
        h = v.get("headline") or {}
        m = v.get("method") or {}
        fmt_ = v.get("format") or "number"
        cur = v.get("currency") or currency
        for k in ("value", "lo80", "hi80", "lo95", "hi95"):
            allowed.add(h.get(k), fmt_)
        allowed.add_text(" ".join(str(h.get(k) or "") for k in ("display", "range_display", "wide_display", "total_display",
                                                                 "cagr_display")))
        facts = [f"Forecast for {h.get('label')}: {h.get('display')} - likely between {h.get('range_display')} (8 in 10 "
                 f"outcomes), and almost surely between {h.get('wide_display')}"]
        vs = h.get("vs") or {}
        if vs.get("display"):
            allowed.add(vs.get("value"), fmt_)
            allowed.add(vs.get("pct"), "percent")
            facts.append(f"Actual {vs.get('label')}: {vs.get('display')}" + (f" ({vs['pct_display']} to the forecast)" if vs.get("pct_display") else ""))
        facts.append(f"Method: {m.get('label')}, from {m.get('history')}")
        if m.get("mape") is not None:
            allowed.add(m["mape"], "percent")
            facts.append(f"When tested on past periods it hadn't seen, it was typically {m['mape']:.1f}% off"
                         + (f" (a {m.get('baseline')} guess: {m['baseline_mape']:.1f}%)" if m.get("baseline_mape") is not None else ""))
        if m.get("long_range_from"):
            facts.append(f"From {m['long_range_from']} it is a long-range projection: growth fades and the range widens each year")
        rows = []
        for y in (v.get("years") or [])[-14:]:
            allowed.add(y.get("value"), fmt_)
            for k in ("lo80", "hi80"):
                allowed.add(y.get(k), fmt_)
            word = {"actual": "actual", "forecast": "forecast", "mixed": "actual so far + forecast"}.get(y.get("kind"), "")
            rng = f" (likely {present.nice(y.get('lo80'), fmt_, cur)} – {present.nice(y.get('hi80'), fmt_, cur)})" if y.get("lo80") is not None else ""
            facts.append(f"{y.get('period')}: {present.nice(y.get('value'), fmt_, cur)} {word}{rng}")
            rows.append({"year": y.get("period"), "value": y.get("value"), "kind": y.get("kind")})
        return {"index": i, "type": "forecast", "title": title, "facts": facts, "rows": rows}
    if t == "kpis":
        facts = []
        for k in v.get("items") or []:
            allowed.add(k.get("value"), k.get("kind") or "number")
            allowed.add_text(str(k.get("display") or ""))
            facts.append(f"{k.get('label')}: {k.get('display')}" + (f" ({k.get('delta')})" if k.get("delta") else ""))
        return {"index": i, "type": "kpis", "title": title, "facts": facts}
    rows = (v.get("rows") or [])[:MAX_ROWS]
    cols = [c.get("name") if isinstance(c, dict) else c for c in v.get("columns") or []] or (list(rows[0].keys()) if rows else [])
    for r in rows:
        for c in cols:
            if isinstance(r.get(c), (int, float)) and not isinstance(r.get(c), bool):
                allowed.add(r[c], _kind_of(c, [r[c]]))
    facts = _rows_facts(title, cols, rows, allowed, currency)
    preview = [{c: r.get(c) for c in cols} for r in rows[:24]]
    return {"index": i, "type": v.get("chart_type") or "chart", "title": title, "facts": facts, "rows": preview}


def run_context(result: dict, currency: str | None = "USD") -> tuple[dict, Allowed]:
    allowed = Allowed()
    ans = result.get("answer") or {}
    for f in result.get("facts") or []:
        allowed.add(f.get("value"), f.get("kind") or "number")
    for k in result.get("kpis") or []:
        allowed.add(k.get("value"), k.get("kind") or "number")
        allowed.add_text(str(k.get("display") or "") + " " + str(k.get("note") or "") + " " + str(k.get("delta") or ""))
    for e in result.get("evidence") or []:
        for r in (e.get("rows") or [])[:300]:
            for val in r.values():
                if isinstance(val, (int, float)) and not isinstance(val, bool):
                    allowed.add(val)
    texts = [ans.get("headline"), ans.get("answer")] + [f"{c.get('title')} {c.get('detail')} {c.get('amount')} {c.get('share')}"
                                                       for c in ans.get("causes") or []]
    texts += [f"{r.get('title')} {r.get('detail')}" for r in ans.get("ruled_out") or []]
    for t in texts:
        allowed.add_text(str(t or ""))
    visuals = [_visual_brief(v, i, allowed, currency) for i, v in enumerate(result.get("visuals") or [])]
    ctx = {
        "headline": ans.get("headline"), "answer": ans.get("answer"),
        "causes": [{"index": i, "title": c.get("title"), "detail": c.get("detail"), "amount": c.get("amount"),
                    "share": c.get("share"), "direction": c.get("direction"), "confidence": c.get("confidence")}
                   for i, c in enumerate(ans.get("causes") or [])],
        "ruled_out": [{"title": r.get("title"), "detail": r.get("detail")} for r in ans.get("ruled_out") or []],
        "kpis": [{"label": k.get("label"), "display": k.get("display"), "note": k.get("note"), "delta": k.get("delta")}
                 for k in result.get("kpis") or []],
        "visuals": visuals,
        "warnings": list(result.get("warnings") or [])[:4],
        # R58: every step's table, so one step can be explained on its own
        "steps": [{"id": e.get("id"), **_visual_brief({"type": "chart", "title": e.get("title"), "columns": e.get("columns"),
                                                        "rows": e.get("rows")}, i, allowed, currency)}
                  for i, e in enumerate(result.get("evidence") or []) if e.get("id")],
    }
    return ctx, allowed


# ---------------------------------------------------------------- routing ----

_EXPLAIN = re.compile(
    r"^\s*(please\s+|can you\s+|could you\s+)?(explain|what does|what do|what's this|what is this|what am i looking at|help me understand|"
    r"walk me through|tell me more|break (it|this|that) down for me|summari[sz]e|interpret|in simple (words|terms)|eli5|elaborate|"
    r"clarify|what does (it|this|that) mean|why is (it|this|that)|why did (it|this|that)|how do i read|how should i read|"
    r"so what|what's the takeaway|what is the takeaway|key takeaways?|meaning)\b", re.I)
_DEICTIC = re.compile(r"\b(this|that|these|those|it|above|chart|graph|answer|result|number|bar|bars|waterfall|card|cause|drop|dip|spike)\b", re.I)
_NEW_DATA = re.compile(
    r"\b(by|per|split|compare|versus|vs\.?|forecast|predict|next (month|year|quarter)|last (month|year|quarter)|in 20\d\d|for 20\d\d|"
    r"show me|list|which|how many|top \d+|filter|only|exclude|segment|drill|what about|break (it )?down by)\b", re.I)


# R58: the studio's Ask puts what the question is about in front - "About the chart “Net Sales: forecast for 2026”: why?".
# That prefix is context, not the question: its quoted title must never read as "forecast" / "2026" / new data.
ABOUT = re.compile(r"^\s*about\s+(?P<what>the chart|the (?:key )?numbers|the findings|the table|step\s+\d+)\s*,?\s*"
                   r"(?:“[^”]*”|\"[^\"]*\"|\([^)]*\))?\s*[:,\-–]\s*", re.I)


def strip_about(question: str | None) -> tuple[str | None, str]:
    """("chart" | "numbers" | "findings" | "table" | "step" | None, the question without the prefix)"""
    q = (question or "").strip()
    m = ABOUT.match(q)
    if not m:
        return None, q
    what = m.group("what").lower().replace("the ", "").replace("key ", "")
    return ("step" if what.startswith("step") else what), q[m.end():].strip()


def route_heuristic(question: str) -> str | None:
    about, q = strip_about(question)
    if not q:
        return "explain" if about else None
    # R58: a short why / what / explain about the card the person pointed at is an explanation of that card
    if about and len(q.split()) <= 10 and re.search(r"\b(why|explain|mean|means|meaning|how come|what (is|are|does|do|happened)|"
                                                   r"tell me|summar|so what|takeaway|interpret|read)\b", q, re.I) and not _NEW_DATA.search(q):
        return "explain"
    if _EXPLAIN.search(q):
        rest = _EXPLAIN.sub("", q, count=1)
        if _NEW_DATA.search(rest) and not re.search(r"\b(this|that|it)\b", rest, re.I):
            return None
        return "explain"
    if len(q.split()) <= 6 and _DEICTIC.search(q) and re.search(r"\b(why|mean|means|explain)\b", q, re.I) and not _NEW_DATA.search(q):
        return "explain"
    return None


_ROUTER = """You are the Euliv FOLLOW-UP ROUTER. A person is reading an answer Euliv already computed and typed a follow-up.
Decide whether it can be answered by EXPLAINING the numbers already on screen, or needs a NEW ANALYSIS with new data
(another breakdown, period, filter, metric, comparison, forecast or anything not in the answer).
Reply with ONE JSON object only: {"route": "explain"|"analyze", "target": {"kind": "answer"|"visual"|"cause", "index": <int>} | null}"""


def route(question: str, ctx: dict) -> dict:
    """{"route": "explain"|"analyze", "target": {...}|None, "by": "rule"|"model"|"default"}"""
    h = route_heuristic(question)
    if h:
        return {"route": h, "target": _guess_target(question, ctx), "by": "rule"}
    from . import ai_engine
    brief = {"headline": ctx.get("headline"), "visuals": [{"index": v["index"], "title": v["title"], "type": v["type"]} for v in ctx["visuals"]],
             "causes": [{"index": c["index"], "title": c["title"]} for c in ctx["causes"]]}
    try:
        out = ai_engine._plan_with_retry([  # noqa: SLF001
            {"role": "system", "content": _ROUTER},
            {"role": "user", "content": f"On screen: {brief}\n\nFollow-up: {question.strip()[:500]}"},
        ], max_tokens=300)
    except Exception as e:  # noqa: BLE001 - when unsure, analyze (what GD360 always did)
        logger.info("[explain] router unavailable: %s", e)
        return {"route": "analyze", "target": None, "by": "default"}
    r = out.get("route") if isinstance(out, dict) else None
    if r not in ("explain", "analyze"):
        return {"route": "analyze", "target": None, "by": "default"}
    t = out.get("target") if isinstance(out.get("target"), dict) else None
    return {"route": r, "target": _valid_target(t, ctx) if t else _guess_target(question, ctx), "by": "model"}


def _valid_target(t: dict | None, ctx: dict) -> dict:
    if not t:
        return {"kind": "answer", "index": 0}
    kind, idx = t.get("kind"), t.get("index")
    try:
        idx = int(idx or 0)
    except (TypeError, ValueError):
        idx = 0
    if kind == "visual" and 0 <= idx < len(ctx["visuals"]):
        return {"kind": "visual", "index": idx}
    if kind == "cause" and 0 <= idx < len(ctx["causes"]):
        return {"kind": "cause", "index": idx}
    # R58: one step's table, or the key numbers - the studio's cards
    if kind == "step" and any(x["id"] == t.get("id") for x in ctx.get("steps") or []):
        return {"kind": "step", "id": t.get("id"), "index": 0}
    if kind == "kpis" and ctx.get("kpis"):
        return {"kind": "kpis", "index": 0}
    return {"kind": "answer", "index": 0}


def _guess_target(question: str, ctx: dict) -> dict:
    q = (question or "").lower()
    for c in ctx["causes"]:
        words = [w for w in re.findall(r"[a-z]{4,}", str(c.get("title") or "").lower())]
        if words and sum(w in q for w in words) >= max(1, len(words) // 2):
            return {"kind": "cause", "index": c["index"]}
    for v in ctx["visuals"]:
        words = [w for w in re.findall(r"[a-z]{4,}", str(v.get("title") or "").lower()) if w not in ("where", "came", "from", "change")]
        if words and sum(w in q for w in words) >= max(1, len(words) // 2):
            return {"kind": "visual", "index": v["index"]}
    if re.search(r"\b(chart|graph|waterfall|bars?)\b", q) and ctx["visuals"]:
        return {"kind": "visual", "index": 0}
    return {"kind": "answer", "index": 0}


# --------------------------------------------------------------- explaining ----

_EXPLAINER = """You are the Euliv EXPLAINER. Explain numbers Euliv already computed to a busy business reader -
plainly, like a sharp analyst sitting next to them. Use ONLY numbers that appear in the material (copy them as written).
Never invent a number, a cause or a comparison that is not in the material. Reply with ONE JSON object only:
{"headline": "<one sentence: what this shows>",
 "points": [{"text": "<one or two sentences>", "ref": "<the label/bar/row it is about, or null>"}],   (2 to 4 points)
 "takeaway": "<one sentence: what it means for the reader, or null>",
 "followups": ["<a short next question>", ...],   (0 to 3)
 "needs_new_data": false,
 "new_question": null}
If the person's question cannot be answered from this material, set needs_new_data true and put the analysis they
need in new_question (and still explain what the material does show)."""


_FALL_WORDS = r"dip|dips|dipped|drop|drops|dropped|decline|declines|declined|decrease|decreased|fall|falls|fell|down|lower|loss|shrank|shrink|slip|slipped|contraction|contracted"
_DOUBLE_NEG = re.compile(rf"\b({_FALL_WORDS})(\s+(?:of|by))?\s+[-−](?=[$€£₹¥]?\d)", re.I)
_DOUBLE_POS = re.compile(r"\b(up|rose|rise|rises|grew|growth|gain|gained|increase|increased|higher)(\s+(?:of|by))?\s+\+(?=[$€£₹¥]?\d)", re.I)


def tidy_signs(text: str) -> str:
    """Round 35: "a slight dip of -1.5%" reads "a slight dip of 1.5%", "down −$2M" reads "down $2M",
    "up +3%" reads "up 3%" - the word already carries the direction."""
    if not text:
        return text
    return _DOUBLE_POS.sub(lambda m: f"{m.group(1)}{m.group(2) or ''} ", _DOUBLE_NEG.sub(lambda m: f"{m.group(1)}{m.group(2) or ''} ", text))


# R57: "explain in detail", "elaborate", "walk me through it" - a longer explanation (up to 8 points, 2-4 sentences each)
DETAIL_ASK = re.compile(r"\b(in (more |full )?detail|detailed|elaborate|more depth|in[- ]depth|walk me through|explain (it |this )?(fully|properly|more)|"
                        r"tell me more|deep[- ]?dive|everything|thorough(ly)?|step by step)\b", re.I)
MAX_POINTS_DETAIL = 8
_LONG_MONEY = re.compile(r"(?<![\w.])([$€£₹¥]?)(\d{1,3}(?:,\d{3}){2,})(\.\d+)?(?![\d,])")


def compact_long_numbers(text: str | None) -> str | None:
    """R57: "$7,990,862.32" reads "$8.0M" in a sentence (the table keeps the exact value) - one number format with
    the rest of the answer."""
    if not text:
        return text

    def rep(m: re.Match) -> str:
        v = float(m.group(2).replace(",", "") + (m.group(3) or ""))
        body = f"{v / 1e9:.1f}B" if v >= 1e9 else f"{v / 1e6:.1f}M"
        return f"{m.group(1)}{body}"
    return _LONG_MONEY.sub(rep, text)


def _clean_points(raw: dict, allowed: Allowed, problems: list | None = None, max_points: int = MAX_POINTS) -> dict | None:
    if not isinstance(raw, dict):
        return None
    head = str(raw.get("headline") or "").strip()
    pts = [p for p in raw.get("points") or [] if isinstance(p, dict) and str(p.get("text") or "").strip()][:max_points]
    take = str(raw.get("takeaway") or "").strip() or None
    texts = [head, take or ""] + [str(p.get("text")) for p in pts]
    bad = [b for t in texts for b in allowed.check(t)]
    if not head or len(pts) < 1 or bad:
        if bad:
            # round 33: said where it can be seen (INFO never reached production logs)
            logger.warning("[explain] model wrote numbers that aren't in the result: %s", bad[:5])
            if problems is not None:
                problems.extend(bad[:8])
        return None
    return {
        "headline": compact_long_numbers(tidy_signs(head))[:300],
        "points": [{"text": compact_long_numbers(tidy_signs(str(p["text"]).strip()))[:900], "ref": (str(p.get("ref"))[:80] if p.get("ref") else None)} for p in pts],
        "takeaway": compact_long_numbers(tidy_signs(take))[:300] if take else None,
        "followups": [str(f).strip()[:140] for f in raw.get("followups") or [] if str(f).strip()][:3],
        "needs_new_data": bool(raw.get("needs_new_data")),
        "new_question": (str(raw.get("new_question")).strip()[:300] if raw.get("new_question") else None),
    }


def _model(material: dict, question: str | None, allowed: Allowed) -> dict | None:
    from . import ai_engine
    import json
    ask = question.strip()[:500] if question else "Explain this."
    user = f"Material:\n{json.dumps(material, default=str)[:12000]}\n\nThe person asks: {ask}"
    detail = bool(DETAIL_ASK.search(ask))
    system = _EXPLAINER if not detail else _EXPLAINER.replace(
        '"<one or two sentences>"', '"<two to four sentences: the number, its comparison and what drives it>"').replace(
        "(2 to 4 points)", "(5 to 8 points - the person asked for detail: cover every part of the material)")
    # round 33: a draft with a number that isn't in the material gets ONE more try, told which numbers -
    # before, the first slip went straight to the plain fallback
    for attempt in range(2):
        problems: list = []
        try:
            raw = ai_engine._plan_with_retry([  # noqa: SLF001
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ], max_tokens=2600 if detail else 1400)
        except Exception as e:  # noqa: BLE001
            logger.warning("[explain] model unavailable: %s", e)
            return None
        out = _clean_points(raw, allowed, problems, MAX_POINTS_DETAIL if detail else MAX_POINTS)
        if out is not None or not problems:
            return out
        user += ("\n\nYour previous draft used numbers that are not in the material: " + ", ".join(map(str, problems))
                 + ". Rewrite it using ONLY numbers written in the material, copied exactly as written there.")
    return None


def _fallback_visual(v: dict, ctx: dict) -> dict:
    facts = v.get("facts") or []
    if v["type"] == "waterfall":
        summary = v.get("summary")
        moves = [f for f in facts if f != summary and not f.startswith("Net change")]
        pts = [{"text": summary + ".", "ref": None}] if summary else []
        pts += [{"text": m + ".", "ref": None} for m in moves[:3]]
        return {"headline": v["title"] + " - each bar is one reason the total moved, in the same units as the total.",
                "points": pts or [{"text": "This chart walks from the first total to the last, one reason at a time.", "ref": None}],
                "takeaway": "The longest bars are the reasons that mattered most.", "followups": [], "needs_new_data": False,
                "new_question": None}
    pts = [{"text": f + ".", "ref": None} for f in facts[:MAX_POINTS]]
    return {"headline": f"{v['title']}.", "points": pts or [{"text": "This chart shows the rows the answer was computed from.", "ref": None}],
            "takeaway": None, "followups": [], "needs_new_data": False, "new_question": None}


def _fallback_cause(c: dict) -> dict:
    pts = []
    if c.get("detail"):
        pts.append({"text": str(c["detail"]), "ref": c.get("title")})
    if c.get("amount"):
        share = _f(str(c.get("share") or "").rstrip("%"))
        if share is not None and share > 100:
            tail = f" - more than the whole change ({c['share']} of it); moves the other way made up the difference."
        else:
            tail = f" - {c['share']} of the change." if c.get("share") else "."
        pts.append({"text": f"On its own it accounts for {c['amount']}{tail}", "ref": None})
    if c.get("confidence"):
        pts.append({"text": f"Euliv's confidence in this reason: {c['confidence']}.", "ref": None})
    return {"headline": str(c.get("title") or "This reason"), "points": pts or [{"text": "One of the reasons behind the change.", "ref": None}],
            "takeaway": None, "followups": [], "needs_new_data": False, "new_question": None}


def _fallback_answer(ctx: dict) -> dict:
    pts = [{"text": f"{c['title']}: {c['detail']}", "ref": c["title"]} for c in ctx["causes"][:3] if c.get("detail")]
    if not pts and ctx.get("answer"):
        pts = [{"text": str(ctx["answer"])[:400], "ref": None}]
    return {"headline": str(ctx.get("headline") or "Here is what the answer says."), "points": pts or [{"text": "See the answer above.", "ref": None}],
            "takeaway": None, "followups": [], "needs_new_data": False, "new_question": None}


def explain_run(result: dict, target: dict | None, question: str | None = None, currency: str | None = "USD",
                use_model: bool = True) -> dict:
    t0 = time.perf_counter()
    if not result:
        raise ExplainError("This question has no answer to explain yet.")
    ctx, allowed = run_context(result, currency)
    target = _valid_target(target, ctx)
    if target["kind"] == "visual":
        v = ctx["visuals"][target["index"]]
        material = {"chart": v, "answer_headline": ctx["headline"], "causes": ctx["causes"][:4], "warnings": ctx["warnings"]}
        title = v["title"]
        fb = lambda: _fallback_visual(v, ctx)  # noqa: E731
    elif target["kind"] == "cause":
        c = ctx["causes"][target["index"]]
        material = {"cause": c, "answer_headline": ctx["headline"], "other_causes": [x for x in ctx["causes"] if x is not c][:3],
                    "charts": [{"title": v["title"], "facts": v["facts"]} for v in ctx["visuals"][:3]]}
        title = c.get("title") or "This reason"
        fb = lambda: _fallback_cause(c)  # noqa: E731
    elif target["kind"] == "step":
        st = next(x for x in ctx["steps"] if x["id"] == target["id"])
        material = {"step": st, "answer_headline": ctx["headline"], "key_numbers": ctx["kpis"], "warnings": ctx["warnings"]}
        title = st["title"]
        fb = lambda: _fallback_visual(st, ctx)  # noqa: E731
    elif target["kind"] == "kpis":
        material = {"key_numbers": ctx["kpis"], "answer_headline": ctx["headline"], "answer": ctx["answer"],
                    "charts": [{"title": v["title"], "facts": v["facts"][:8]} for v in ctx["visuals"][:3]], "warnings": ctx["warnings"]}
        title = "The key numbers"
        fb = lambda: _fallback_answer(ctx)  # noqa: E731
    else:
        material = ctx
        title = "The answer"
        fb = lambda: _fallback_answer(ctx)  # noqa: E731
    question = strip_about(question)[1] or question
    out = _model(material, question, allowed) if use_model else None
    by = "model"
    if out is None:
        out, by = fb(), "numbers"
    return {**out, "target": target, "title": title, "written_by": by, "question": (question or "").strip() or None,
            "seconds": round(time.perf_counter() - t0, 1)}


# --------------------------------------------------------- dashboard tiles ----

def block_material(block: dict, allowed: Allowed) -> dict:
    """{title, type, facts, rows} for one dashboard tile as the page shows it."""
    title = str(block.get("title") or "This chart")[:120]
    btype = str(block.get("type") or "chart")
    cols = [str(c.get("name") if isinstance(c, dict) else c) for c in (block.get("columns") or [])][:12]
    rows = [r for r in (block.get("rows") or [])[:200] if isinstance(r, dict)]
    if rows and not cols:
        cols = list(rows[0].keys())[:12]
    rows = [{c: r.get(c) for c in cols} for r in rows]
    currency = block.get("currency") or "USD"
    facts = []
    kpi = block.get("kpi") if isinstance(block.get("kpi"), dict) else None
    if kpi:
        allowed.add(kpi.get("value"))
        allowed.add_text(" ".join(str(kpi.get(k) or "") for k in ("display", "delta", "prior_display", "sparkline_text")))
        scope = f" ({block['filters_text']})" if block.get("filters_text") else ""
        facts.append(f"{title}: {kpi.get('display')}{scope}" + (f" ({kpi.get('delta')} {kpi.get('delta_caption') or 'vs prior period'})" if kpi.get("delta") else ""))
        facts += _spark_facts(kpi, title, allowed, currency)
    for r in rows:
        for c in cols:
            if isinstance(r.get(c), (int, float)) and not isinstance(r.get(c), bool):
                allowed.add(r[c], _kind_of(c, [r[c]]))
    facts += _rows_facts(title, cols, rows, allowed, currency, block.get("dimensions"))
    return {"title": title, "type": btype if btype != "chart" else (block.get("chart_type") or "chart"), "facts": facts,
            "rows": rows[:MAX_ROWS], "filters": block.get("filters_text")}


_GRAIN_WORD = {"day": "days", "week": "weeks", "month": "months", "quarter": "quarters", "year": "years"}
_MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def _spark_facts(kpi: dict, title: str, allowed: Allowed, currency: str | None) -> list[str]:
    """Round 33: what a KPI's trend line says, in its own units and periods - its range over the WHOLE line
    the page draws (not "the last 36 periods"), the last 12 months against the 12 before, and the month that
    peaks most years."""
    vals = [_f(x) for x in (kpi.get("sparkline") or [])]
    periods = [str(p) for p in (kpi.get("spark_periods") or [])]
    pairs = [(periods[i] if i < len(periods) else None, v) for i, v in enumerate(vals) if v is not None][-120:]
    if len(pairs) < 3:
        return []
    kind = {"currency": "currency", "percent": "ratio"}.get(str(kpi.get("format") or ""), None) or _kind_of(title, [v for _p, v in pairs])
    nice = lambda v: present.nice(v, kind, currency or "USD")  # noqa: E731
    grain = str(kpi.get("grain") or "")
    unit = _GRAIN_WORD.get(grain, "periods")
    out = []
    lo = min(pairs, key=lambda x: x[1])
    hi = max(pairs, key=lambda x: x[1])
    for x in (lo[1], hi[1]):
        allowed.add(x, kind)
    def ym(t: str | None) -> str | None:
        m = re.match(r"^(\d{4})-(\d{2})", t or "")
        return f"{_MON[int(m.group(2)) - 1]} {m.group(1)}" if m and 1 <= int(m.group(2)) <= 12 else (t[:10] if t else None)
    span = f" ({ym(pairs[0][0])} to {ym(pairs[-1][0])})" if pairs[0][0] and pairs[-1][0] else ""
    when = lambda p: f" in {ym(p[0])}" if p[0] else ""  # noqa: E731
    out.append(f"Across the {len(pairs)} {unit} on the trend line{span} it ranged from {nice(lo[1])}{when(lo)} to {nice(hi[1])}{when(hi)}")
    allowed.add(len(pairs))
    additive = kind != "ratio" and not re.search(r"(avg|average|mean|rate|ratio|per|aov|value)", title, re.I)
    if grain == "month" and len(pairs) >= 24:
        last, prev = [v for _p, v in pairs[-12:]], [v for _p, v in pairs[-24:-12]]
        a, b = (sum(last), sum(prev)) if additive else (sum(last) / 12, sum(prev) / 12)
        if b:
            ch = (a - b) / abs(b) * 100
            allowed.add(a, kind)
            allowed.add(b, kind)
            allowed.add(ch, "percent")
            word = "in total" if additive else "on average"
            out.append(f"The last 12 months came to {nice(a)} {word}, against {nice(b)} in the 12 months before ({ch:+.1f}%)")
        dated = [(int(p[5:7]), int(p[:4]), v) for p, v in pairs if p and re.match(r"^\d{4}-\d{2}", p)]
        years: dict[int, list[tuple[int, float]]] = {}
        for m, y, v in dated:
            years.setdefault(y, []).append((m, v))
        full = {y: ms for y, ms in years.items() if len(ms) == 12}
        if len(full) >= 2:
            tops = [max(ms, key=lambda t: t[1])[0] for ms in full.values()]
            best = max(set(tops), key=tops.count)
            n = tops.count(best)
            if n >= max(2, len(full) * 2 / 3):
                allowed.add(n)
                allowed.add(len(full))
                out.append(f"{_MON[best - 1]} is its strongest month in {n} of {len(full)} full years - a yearly peak")
    return out


def explain_block(block: dict, question: str | None = None, use_model: bool = True) -> dict:
    t0 = time.perf_counter()
    allowed = Allowed()
    mat = block_material(block, allowed)
    if not mat["rows"] and not mat["facts"]:
        raise ExplainError("This tile has nothing to explain yet - it hasn't shown any numbers.")
    out = _model({"tile": mat, "dashboard": block.get("dashboard_name")}, question, allowed) if use_model else None
    by = "model"
    if out is None:
        by = "numbers"
        facts = mat["facts"][:MAX_POINTS + 1]
        # round 33: the headline says the number, not just the tile's name
        head = facts[0] if facts else mat["title"]
        out = {"headline": head + ".", "points": [{"text": f + ".", "ref": None} for f in facts[1:MAX_POINTS + 1]]
               or [{"text": "This tile shows the rows below.", "ref": None}],
               "takeaway": None, "followups": [], "needs_new_data": False, "new_question": None}
    return {**out, "block_id": block.get("id"), "title": mat["title"], "written_by": by, "question": (question or "").strip() or None,
            "seconds": round(time.perf_counter() - t0, 1)}


def answer_page(question: str, blocks: list[dict], dashboard_name: str | None = None, use_model: bool = True) -> dict:
    """A question about a dashboard page, answered from its tiles."""
    t0 = time.perf_counter()
    allowed = Allowed()
    mats = []
    for b in blocks[:16]:
        m = block_material(b, allowed)
        if m["facts"] or m["rows"]:
            mats.append({"id": b.get("id"), **{k: m[k] for k in ("title", "type", "facts")},
                         "rows": m["rows"][:12] if len(m["rows"]) <= 24 else []})
    if not mats:
        raise ExplainError("This page hasn't shown any numbers yet.")
    out = _model({"dashboard": dashboard_name, "tiles": mats}, question, allowed) if use_model else None
    by = "model"
    if out is None:
        by = "numbers"
        pts = [{"text": (m["facts"][0] if m["facts"][0].lower().startswith(m["title"].lower()) else f"{m['title']} - {m['facts'][0]}") + ".",
                "ref": m["title"]} for m in mats if m["facts"]][:MAX_POINTS]
        out = {"headline": f"Here is what {dashboard_name or 'this page'} shows right now.", "points": pts
               or [{"text": "The tiles on this page are listed above.", "ref": None}], "takeaway": None, "followups": [],
               "needs_new_data": False, "new_question": None}
    refs = {m["title"].lower(): m["id"] for m in mats}
    for p in out["points"]:
        r = (p.get("ref") or "").lower()
        p["block_id"] = refs.get(r) or next((bid for t, bid in refs.items() if r and (r in t or t in r)), None)
    return {**out, "written_by": by, "question": question.strip(), "seconds": round(time.perf_counter() - t0, 1)}
