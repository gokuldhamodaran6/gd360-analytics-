"""
The composer: computed facts -> the written answer.

The language model writes the explanation, but only from the facts the
analysis engine computed and the small result tables the steps returned.
Every number in what it writes is checked (numbers.unsupported_numbers);
a draft that uses a number GD360 did not compute is sent back once with
the offending numbers listed, and if the second draft still does, the
deterministic answer below is used instead. A wrong number is never shown.
"""
from __future__ import annotations

import json
import re

from .. import ai_engine
from .numbers import allowed_values, fmt, unsupported_numbers

WRITER_MARKER = "GD360 ANSWER WRITER"

WRITER_SYSTEM = f"""You are the {WRITER_MARKER}. You explain an analysis GD360 has already
computed, to a busy business person, in plain English.

Rules:
- Use ONLY numbers that appear in FACTS (use their "display" text) or in the RESULT
  TABLES. Never calculate, estimate or round a new number yourself.
- Lead with the direct answer to the question in one or two sentences.
- For a change between periods: name the biggest causes first, each with how much of
  the change it explains; mention what moved the other way; say what was checked and
  is NOT a cause when the facts show it (a dimension whose change is spread evenly,
  or a context table that did not change).
- Confidence: "high" when one segment or part explains most of the change and the data
  is direct; "medium" when it explains part of it or the link is indirect; "low" otherwise.
- Answer EVERY part of the question. "Which hotel, which year, which month and why"
  needs the hotel, the year, the month and the reasons - each from the facts or tables.
- Compare like with like: when groups differ in size, or cover different amounts of
  time, compare rates, averages or per-year figures - not raw counts or totals. If
  COVERAGE says the data covers years or months unevenly, say so in one short clause
  and prefer per-year figures where they are given.
- Write numbers the way a finance team would: money with its currency symbol and at
  most two decimals ($1.08M, $776.7k, $67.00), counts with thousands separators
  (4,122), rates with one decimal (41.7%). Never copy a long decimal from a table.
- A cause's fact_ids are only the facts whose numbers that cause states.
- When the question asks for the lowest / worst / weakest, lead with the lowest.
- Never mention SQL, tables, steps, facts or ids in the text.
- Short sentences. No hedging filler.

Return JSON only:
{{
  "headline": "one sentence, the answer",
  "answer": "2-4 sentences",
  "causes": [{{"title": "short", "detail": "one or two sentences", "fact_ids": ["f3"], "confidence": "high|medium|low", "direction": "down|up"}}],
  "ruled_out": [{{"title": "short", "detail": "one sentence"}}],
  "next_questions": ["three useful follow-up questions"]
}}
"causes" and "ruled_out" may be empty for questions that are not about a change."""


def _tables_text(tables: list[dict], max_rows: int = 25) -> str:
    parts = []
    for t in tables:
        cols = [c["name"] for c in t.get("columns", [])]
        lines = [f"TABLE {t.get('title')} (from {t.get('source')}): " + ", ".join(cols)]
        for row in (t.get("rows") or [])[:max_rows]:
            lines.append(" | ".join(str(row.get(c)) for c in cols))
        if len(t.get("rows") or []) > max_rows:
            lines.append(f"... {len(t['rows']) - max_rows} more rows")
        parts.append("\n".join(lines))
    return "\n\n".join(parts)


def _facts_text(facts: list[dict]) -> str:
    return "\n".join(f'{f["id"]}: {f["label"]} = {f["display"]}' for f in facts)


def _draft(question: str, plan: dict, analysis: dict, tables: list[dict], problems: list[str] | None) -> dict:
    user = (
        f"Question: {question}\n\n"
        f"What GD360 assumed: {json.dumps(plan.get('assumptions') or [])}\n\n"
        f"FACTS\n{_facts_text(analysis.get('facts') or [])}\n\n"
        f"ANALYSIS SUMMARY\n{json.dumps(analysis.get('summary') or {}, default=str)[:5000]}\n\n"
        f"RESULT TABLES\n{_tables_text(tables)}"
    )
    notes = (analysis.get("coverage") or {}).get("notes") or []
    if notes:
        user += "\n\nCOVERAGE\n" + "\n".join(f"- {n}" for n in notes)
    if problems:
        user += "\n\nYour previous draft had problems: " + "; ".join(problems) + \
                ". Rewrite it using only the facts' display values and the ranking the facts show."
    messages = [{"role": "system", "content": WRITER_SYSTEM}, {"role": "user", "content": user}]
    return ai_engine._plan_with_retry(messages, max_tokens=4000)


def _clean(d: dict, facts_by_id: dict) -> dict:
    causes = []
    for c in (d.get("causes") or [])[:5]:
        if not isinstance(c, dict) or not c.get("title"):
            continue
        ids = [i for i in (c.get("fact_ids") or []) if i in facts_by_id]
        causes.append({
            "title": str(c["title"])[:120], "detail": str(c.get("detail") or "")[:500], "fact_ids": ids,
            "confidence": c.get("confidence") if c.get("confidence") in ("high", "medium", "low") else "medium",
            "direction": c.get("direction") if c.get("direction") in ("up", "down") else None,
        })
    ruled = [
        {"title": str(r.get("title"))[:80], "detail": str(r.get("detail") or "")[:300]}
        for r in (d.get("ruled_out") or [])[:6] if isinstance(r, dict) and r.get("title")
    ]
    nxt = [str(q)[:140] for q in (d.get("next_questions") or [])[:3] if str(q).strip()]
    return {
        "headline": str(d.get("headline") or "")[:300], "answer": str(d.get("answer") or "")[:1500],
        "causes": causes, "ruled_out": ruled, "next_questions": nxt,
    }


_LOW_WORDS = re.compile(r"\b(lowest|weakest|worst|least|smallest|poorest|slowest|fewest|bottom|low[- ]performing|underperform\w*)\b", re.I)
_HIGH_WORDS = re.compile(r"\b(highest|best|strongest|largest|biggest|top|leading|most|peak|top[- ]performing|leads)\b", re.I)


def claim_problems(draft: dict, analysis: dict) -> list[str]:
    """The headline's "X is the lowest / highest" must be what the data
    ranks lowest / highest. A breakdown knows its ranking; a headline that
    names another segment as the extreme is sent back."""
    s = analysis.get("summary") or {}
    if analysis.get("type") not in ("breakdown", "comparison") or not s.get("segments"):
        return []
    names = [x["segment"] for x in s["segments"]] + [x["segment"] for x in s.get("per_year") or []]
    names = sorted({n for n in names if n and len(n) > 1}, key=len, reverse=True)
    out = []
    for sentence in re.split(r"(?<=[.;!?])\s+", draft.get("headline") or ""):
        mentioned = [n for n in names if re.search(rf"\b{re.escape(n)}\b", sentence, re.I)]
        if not mentioned:
            continue
        first = mentioned[0] if len(mentioned) == 1 else min(mentioned, key=lambda n: sentence.lower().find(n.lower()))
        dim = s.get("dimension") or "value"
        lo, hi = s.get("lowest") or {}, s.get("highest") or {}
        ok_lo = {lo.get("segment")} | {x["segment"] for x in (s.get("segments") or []) if x.get("rank") == s.get("segment_count")}
        ok_hi = {hi.get("segment")} | {s["segments"][0]["segment"]}
        if _LOW_WORDS.search(sentence) and first not in ok_lo and lo.get("segment"):
            out.append(f"the headline calls {first} the lowest {dim}, but the data's lowest is {lo['segment']}")
        elif _HIGH_WORDS.search(sentence) and not _LOW_WORDS.search(sentence) and first not in ok_hi and hi.get("segment"):
            if re.search(rf"\b{re.escape(first)}\b[^.]*\b(highest|best|top|leads|largest|biggest|most)\b", sentence, re.I):
                out.append(f"the headline calls {first} the highest {dim}, but the data's highest is {hi['segment']}")
    return out


def _all_text(a: dict) -> str:
    bits = [a["headline"], a["answer"]]
    for c in a["causes"]:
        bits += [c["title"], c["detail"]]
    for r in a["ruled_out"]:
        bits += [r["title"], r["detail"]]
    return "\n".join(bits)


def fallback_answer(question: str, analysis: dict) -> dict:
    """The answer built without the language model - used when it is
    unavailable or keeps writing numbers it was not given."""
    s = analysis.get("summary") or {}
    facts = {f["id"]: f for f in analysis.get("facts") or []}
    atype = analysis.get("type")
    causes, ruled = [], []
    if atype == "explain_change" and "delta" in s:
        f = lambda i: facts.get(s["fact_ids"][i], {}).get("display", "")  # noqa: E731
        word = "down" if s["delta"] < 0 else "up"
        pct = f" ({f(3)})" if len(s.get("fact_ids", [])) > 3 else ""
        headline = f"{s['metric']} is {word} {f(2).lstrip('+−')}{pct}: {f(0)} in {s['current_label']} vs {f(1)} in {s['previous_label']}."
        for c in s.get("components") or []:
            if c.get("effect_fact_id"):
                causes.append({"title": f"{c['name']} changed", "detail": f"Effect on {s['metric']}: {facts[c['effect_fact_id']]['display']}.",
                               "fact_ids": [c["effect_fact_id"]], "confidence": "high",
                               "direction": "down" if c["effect"] < 0 else "up"})
        for d in s.get("drivers") or []:
            if d["segments"] and d["verdict"] != "broad":
                seg = d["segments"][0]
                causes.append({"title": f"{d['label']}: {seg['segment']}", "detail": f"Changed by {facts[seg['fact_ids'][0]]['display']}.",
                               "fact_ids": seg["fact_ids"][:2], "confidence": "high" if d["verdict"] == "concentrated" else "medium",
                               "direction": "down" if seg["change"] < 0 else "up"})
            elif d["segments"]:
                ruled.append({"title": d["label"], "detail": f"The change is spread across {d['label'].lower()} values rather than coming from one."})
        answer = headline
    elif atype == "trend" and s.get("series"):
        se = s["series"][0]
        ids = se["fact_ids"]
        headline = f"{se['name']} went from {facts[ids[0]]['display']} to {facts[ids[1]]['display']}."
        answer = headline + (f" Highest: {facts[ids[4]]['label'].split('(')[-1].rstrip(')')} at {facts[ids[4]]['display']}." if len(ids) > 4 else "")
    elif atype in ("breakdown", "comparison") and s.get("segments"):
        def said(seg: dict) -> tuple[str, str | None]:
            ids = seg.get("fact_ids") or []
            share = facts.get(ids[1], {}).get("display") if len(ids) > 1 else None
            return facts[ids[0]]["display"], share
        top = s.get("highest") or s["segments"][0]
        low = s.get("lowest")
        per = " per year of data" if top.get("per_year") else ""
        if s.get("rank") == "lowest" and low:
            v, share = said(low)
            headline = f"{low['segment']} is the lowest at {v}{per}" + (f" ({share} of the total)." if share else ".")
            tv, _ = said(top)
            answer = headline + f" The highest is {top['segment']} at {tv}{per}."
        else:
            v, share = said(top)
            headline = f"{top['segment']} leads with {v}{per}" + (f" ({share} of the total)." if share else ".")
            answer = headline
            if low and low.get("segment") != top.get("segment"):
                lv, _ = said(low)
                answer += f" The lowest is {low['segment']} at {lv}{per}."
    else:
        kpis = [f for f in analysis.get("facts") or []][:3]
        headline = "; ".join(f"{k['label']}: {k['display']}" for k in kpis) or "Here is the result."
        answer = headline
    return {"headline": headline, "answer": answer, "causes": causes[:4], "ruled_out": ruled[:4], "next_questions": [],
            "written_by": "template"}


def compose(question: str, plan: dict, analysis: dict, tables: list[dict]) -> dict:
    facts = analysis.get("facts") or []
    facts_by_id = {f["id"]: f for f in facts}
    allowed = allowed_values(facts, tables, extra_text=question)
    problems = None
    for _attempt in range(2):
        try:
            draft = _clean(_draft(question, plan, analysis, tables, problems), facts_by_id)
        except Exception as e:  # noqa: BLE001
            print(f"[project_engine] answer writer unavailable, using the template: {e}")
            break
        if not draft["headline"]:
            problems = ["(empty headline)"]
            continue
        bad = unsupported_numbers(_all_text(draft), allowed)
        wrong = claim_problems(draft, analysis)
        if not bad and not wrong:
            draft["written_by"] = "model"
            return draft
        print(f"[project_engine] answer used unsupported numbers {bad} / wrong claims {wrong}; retrying once")
        problems = bad + wrong
    return fallback_answer(question, analysis)


def fmt_value(v, kind="number", currency=None):
    return fmt(v, kind, currency)
