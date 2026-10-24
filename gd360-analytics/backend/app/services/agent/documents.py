"""2026-10-14 (R46): the Document tool - "write the board review", "draft a memo
on this" - written from the answers already in the conversation, never from
numbers the model makes up. Every figure in the draft is checked against the
numbers GD360 computed (truth_guard.guard_text); a draft with an unsupported
figure is rewritten once, then the figure is flagged in the document itself.
"""
from __future__ import annotations

import json
import re
from datetime import date

from ... import models
from .. import ai_engine
from ..project_engine import numbers
from . import truth_guard

_SYSTEM = (
    "Euliv DOCUMENT WRITER. Write the document the person asked for, for a business reader, from the ANSWERS supplied "
    "(each with its question, headline, prose and key numbers). Use only numbers that appear in the answers; never "
    "invent a figure, a date or a name. Markdown: a title line starting with '# ', short section headings with '## ', "
    "paragraphs of plain prose, and a markdown table only where numbers compare. No bullet lists longer than 5 items. "
    "Length: {length}. Finish with a one-line 'Sources' section naming the data sources used. Today is {today}."
)


def _facts_of(run: models.ProjectRun) -> list[dict]:
    r = run.result or {}
    facts = list(r.get("facts") or [])
    a = r.get("analyst") or {}
    for k in (a.get("key_numbers") or []) if isinstance(a, dict) else []:
        if isinstance(k, dict):
            facts.append({"label": k.get("label"), "value": k.get("value"), "display": k.get("display")})
    for k in r.get("kpis") or []:
        if isinstance(k, dict):
            facts.append({"label": k.get("label"), "value": k.get("value"), "display": k.get("display")})
    return facts


def _answers_payload(runs: list[models.ProjectRun], knowledge: list[dict]) -> tuple[list[dict], list[float]]:
    payload, allowed = [], []
    for run in runs:
        r = run.result or {}
        ans = r.get("answer") or {}
        facts = _facts_of(run)
        tables = [{"rows": v.get("rows")} for v in (r.get("visuals") or []) if isinstance(v, dict) and v.get("rows")]
        allowed += numbers.allowed_values(facts, tables, "")
        payload.append({
            "question": run.question, "headline": ans.get("headline"), "answer": ans.get("answer"),
            "bullets": ans.get("bullets") or [], "causes": [c.get("text") or c.get("label") for c in (ans.get("causes") or []) if isinstance(c, dict)][:6],
            "key_numbers": [{"label": f.get("label"), "display": f.get("display") or f.get("value")} for f in facts[:16]],
            "sources": r.get("sources_used") or [],
        })
    for k in knowledge:
        payload.append({"question": k.get("question"), "answer": k.get("text"), "sources": [s.get("title") for s in (k.get("sources") or [])][:4]})
        allowed += [n for _t, n, _p in numbers.extract_numbers(str(k.get("text") or ""))]
    return payload, allowed


def write(request: str, runs: list[models.ProjectRun], knowledge: list[dict], today: date | None = None) -> dict:
    """{title, markdown, flagged: [numbers], words}."""
    today = today or date.today()
    length = "about 600 words" if len(runs) + len(knowledge) > 2 else "about 350 words"
    payload, allowed = _answers_payload(runs, knowledge)
    if not payload:
        return {"title": "Nothing to write yet", "markdown": "# Nothing to write yet\n\nAsk a question first; the document is written from the answers in this conversation.",
                "flagged": [], "words": 0}
    user = f"Request: {request}\n\nANSWERS (JSON):\n{json.dumps(payload, ensure_ascii=False, default=str)[:24000]}"
    msgs = [{"role": "system", "content": _SYSTEM.format(length=length, today=today.isoformat())}, {"role": "user", "content": user}]
    text = ai_engine._call_llm_resilient(msgs, max_tokens=2200)
    flagged = truth_guard.guard_text(re.sub(r"\|", " ", text), allowed) if allowed else []
    if flagged:
        msgs.append({"role": "assistant", "content": text})
        msgs.append({"role": "user", "content": "These figures are not in the answers: " + ", ".join(flagged[:8]) +
                     ". Rewrite the whole document using only figures from the answers; drop any sentence you cannot support."})
        text2 = ai_engine._call_llm_resilient(msgs, max_tokens=2200)
        flagged2 = truth_guard.guard_text(re.sub(r"\|", " ", text2), allowed)
        if len(flagged2) <= len(flagged):
            text, flagged = text2, flagged2
    text = text.strip()
    m = re.match(r"^#\s+(.+)$", text, re.M)
    title = (m.group(1).strip() if m else "") or ""
    if not title or title.strip().lower().rstrip(".") == request.strip().lower().rstrip("."):
        # the writer echoed the request: name the document after what it is about
        first = runs[0].question if runs else (knowledge[0].get("question") if knowledge else "")
        kind = "Report" if re.search(r"\breport\b", request, re.I) else "Memo" if re.search(r"\bmemo\b", request, re.I) else "Brief" if re.search(r"\bbrief\b", request, re.I) else "Review"
        title = f"{kind}: {str(first or 'this conversation').strip().rstrip('?')[:70]}"
        text = re.sub(r"^#\s+.+$", f"# {title}", text, count=1, flags=re.M) if m else f"# {title}\n\n{text}"
    if flagged:
        text += "\n\n> Check before sharing: these figures were not found in the answers this was written from: " + ", ".join(flagged[:8])
    return {"title": title[:120], "markdown": text, "flagged": flagged[:8], "words": len(text.split())}
