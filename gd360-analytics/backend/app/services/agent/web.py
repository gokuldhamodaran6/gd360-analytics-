"""2026-10-14 (R46): the Web tool - a world question answered with live sources.

Providers (settings.WEB_SEARCH_PROVIDER, see config.py):
- gemini  Google Search grounding on the Gemini API: one call returns the answer
          and the pages it leaned on (groundingMetadata). Needs only GEMINI_API_KEY.
- tavily  Tavily search (TAVILY_API_KEY) gives the pages; the main model writes
          the answer from them.
- none    no live web: the model answers from what it knows and the answer says so.

Every call goes through ai_engine.requests so the local test shim can route it to
the fake provider, exactly like every other model call.
"""
from __future__ import annotations

import json
import re
from datetime import date

from ...config import get_settings
from .. import ai_engine

settings = get_settings()

GEMINI_NATIVE = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
TAVILY_URL = "https://api.tavily.com/search"


def provider() -> str:
    p = (settings.WEB_SEARCH_PROVIDER or "").strip().lower()
    if p in ("gemini", "tavily", "none"):
        if p == "gemini" and not settings.GEMINI_API_KEY:
            return "none"
        if p == "tavily" and not settings.TAVILY_API_KEY:
            return "none"
        return p
    if settings.AI_PROVIDER == "gemini" and settings.GEMINI_API_KEY:
        return "gemini"
    if settings.TAVILY_API_KEY:
        return "tavily"
    return "none"


def available() -> bool:
    return provider() != "none"


_SYSTEM = (
    "GD360 KNOWLEDGE. You answer a world question for a business user in plain prose: the answer first, in one or two "
    "sentences, then the key facts that support it (at most four short sentences). Use the live search results; prefer "
    "official and recent sources; give dates for anything that changes (office holders, prices, laws, rankings). "
    "If sources disagree or the answer may have changed, say so in one sentence. Never invent a source. "
    "No headings, no bullet lists, no markdown tables; plain sentences only. Today is {today}."
)


def _clean(text: str) -> str:
    t = re.sub(r"^\s*#+\s*", "", text or "", flags=re.M)
    t = re.sub(r"\*\*(.+?)\*\*", r"\1", t)
    t = re.sub(r"^\s*[-*•]\s+", "", t, flags=re.M)
    return t.strip()


def _gemini(question: str, history: list[dict], today: date) -> dict:
    model = settings.GEMINI_MODEL
    contents = []
    for h in history[-6:]:
        contents.append({"role": "user" if h.get("role") == "user" else "model", "parts": [{"text": str(h.get("content") or "")[:2000]}]})
    contents.append({"role": "user", "parts": [{"text": question}]})
    resp = ai_engine.requests.post(
        GEMINI_NATIVE.format(model=model),
        headers={"x-goog-api-key": settings.GEMINI_API_KEY.strip(), "Content-Type": "application/json"},
        json={
            "system_instruction": {"parts": [{"text": _SYSTEM.format(today=today.isoformat())}]},
            "contents": contents,
            "tools": [{"google_search": {}}],
            "generationConfig": {"temperature": 0.2, "maxOutputTokens": 1200},
        },
        timeout=60,
    )
    if resp.status_code >= 400:
        raise RuntimeError(f"Gemini grounding failed ({resp.status_code}): {resp.text[:300]}")
    body = resp.json()
    cand = (body.get("candidates") or [{}])[0]
    text = "".join(p.get("text") or "" for p in (cand.get("content") or {}).get("parts") or [])
    meta = cand.get("groundingMetadata") or {}
    sources = []
    seen = set()
    for ch in meta.get("groundingChunks") or []:
        w = ch.get("web") or {}
        url, title = w.get("uri"), w.get("title")
        if url and url not in seen:
            seen.add(url)
            sources.append({"title": title or url, "url": url})
    queries = list(meta.get("webSearchQueries") or [])
    try:
        ai_engine._meter_usage({"usage": {"prompt_tokens": (body.get("usageMetadata") or {}).get("promptTokenCount", 0),
                                          "completion_tokens": (body.get("usageMetadata") or {}).get("candidatesTokenCount", 0)}})
    except Exception:  # noqa: BLE001 - metering never affects the answer
        pass
    return {"text": _clean(text), "sources": sources[:8], "grounded": bool(sources), "queries": queries[:4], "provider": "gemini"}


def _tavily(question: str, history: list[dict], today: date) -> dict:
    resp = ai_engine.requests.post(
        TAVILY_URL, json={"api_key": settings.TAVILY_API_KEY.strip(), "query": question, "max_results": 6,
                          "search_depth": "basic", "include_answer": False}, timeout=30)
    if resp.status_code >= 400:
        raise RuntimeError(f"Tavily search failed ({resp.status_code})")
    results = (resp.json() or {}).get("results") or []
    pages = [{"title": r.get("title") or r.get("url"), "url": r.get("url"), "content": str(r.get("content") or "")[:1500]}
             for r in results if r.get("url")]
    msgs = [{"role": "system", "content": _SYSTEM.format(today=today.isoformat())}]
    for h in history[-6:]:
        msgs.append({"role": "user" if h.get("role") == "user" else "assistant", "content": str(h.get("content") or "")[:2000]})
    msgs.append({"role": "user", "content": f"Question: {question}\n\nSearch results (JSON):\n{json.dumps(pages, ensure_ascii=False)}"})
    text = ai_engine._call_llm_resilient(msgs, max_tokens=900)
    return {"text": _clean(text), "sources": [{"title": p["title"], "url": p["url"]} for p in pages], "grounded": bool(pages),
            "queries": [question], "provider": "tavily"}


def _model_only(question: str, history: list[dict], today: date) -> dict:
    msgs = [{"role": "system", "content": _SYSTEM.format(today=today.isoformat()) +
             " You have NO live search in this deployment: answer from what you know, and if the fact can change over "
             "time say clearly that it should be checked against a current source."}]
    for h in history[-6:]:
        msgs.append({"role": "user" if h.get("role") == "user" else "assistant", "content": str(h.get("content") or "")[:2000]})
    msgs.append({"role": "user", "content": question})
    text = ai_engine._call_llm_resilient(msgs, max_tokens=900)
    return {"text": _clean(text), "sources": [], "grounded": False, "queries": [], "provider": "none"}


def answer(question: str, history: list[dict] | None = None, today: date | None = None) -> dict:
    """{text, sources[{title,url}], grounded, queries, provider}."""
    today = today or date.today()
    p = provider()
    history = history or []
    if p == "gemini":
        try:
            return _gemini(question, history, today)
        except Exception as e:  # noqa: BLE001 - grounding down: still answer, honestly labelled
            print(f"[agent.web] gemini grounding failed, answering from the model: {e}")
            out = _model_only(question, history, today)
            out["note"] = "Live search was unavailable for this answer."
            return out
    if p == "tavily":
        try:
            return _tavily(question, history, today)
        except Exception as e:  # noqa: BLE001
            print(f"[agent.web] tavily failed, answering from the model: {e}")
            out = _model_only(question, history, today)
            out["note"] = "Live search was unavailable for this answer."
            return out
    return _model_only(question, history, today)
