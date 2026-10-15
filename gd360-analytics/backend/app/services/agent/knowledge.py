"""2026-10-14 (R46): the Knowledge tool - a world question in the same conversation
as the data ("who is the chief minister of Tamil Nadu", "what is EBITDA").

The answer comes from web.py (grounded when a provider is configured). The chips
shown with it say only what is true: "N sources" when pages were read, or
"From the model's knowledge, not checked online" when they were not.
"""
from __future__ import annotations

import time
from datetime import date

from .. import ai_meter
from . import web


def answer(question: str, history: list[dict] | None = None, today: date | None = None) -> dict:
    started = time.time()
    provider = web.provider()
    ai_meter.check_budget()
    ai_meter.begin()
    try:
        out = web.answer(question, history or [], today)
    except Exception as exc:
        ai_meter.finish("web", provider, started, "error", str(exc))
        raise
    ai_meter.finish("web", provider, started, "ok", None)
    chips = []
    if out.get("grounded"):
        n = len(out.get("sources") or [])
        chips.append({"key": "sources", "ok": True, "label": f"{n} source{'s' if n != 1 else ''} read", "detail": "Answered from live web pages."})
        chips.append({"key": "as_of", "ok": True, "label": f"As of {(today or date.today()).strftime('%b %d, %Y')}"})
        if out.get("dropped"):
            chips.append({"key": "forums", "ok": True, "label": f"{out['dropped']} forum or social page{'s' if out['dropped'] != 1 else ''} not used",
                          "detail": "Quora, Reddit, Instagram and similar pages are not evidence for a fact answer."})
    else:
        chips.append({"key": "unverified", "ok": False, "label": "From the model's knowledge, not checked online",
                      "detail": out.get("note") or "No live search is configured for this deployment."})
    out["chips"] = chips
    out["elapsed_s"] = round(time.time() - started, 1)
    return out
