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
    "GD360 KNOWLEDGE. You answer ONE world question for a business user in plain prose: the answer first, in one or two "
    "sentences, then the key facts that support it (at most four short sentences). Use the live search results; prefer "
    "official, reputable and recent sources (government, major news, encyclopedias, company sites) over forums and social "
    "posts; give dates for anything that changes (office holders, prices, laws, rankings). "
    "If sources disagree or the answer may have changed, say so in one sentence. Never invent a source. "
    "Answer only the latest question: earlier questions in the conversation are context, never something to answer again. "
    "No headings, no bullet lists, no markdown tables; plain sentences only. Today is {today}."
)

# 2026-10-15 (R48): forums and social posts are not evidence for a fact answer; they are dropped from the sources
EXCLUDED_DOMAINS = ("quora.com", "reddit.com", "facebook.com", "instagram.com", "tiktok.com", "pinterest.com", "x.com", "twitter.com",
                    "threads.net", "answers.com", "brainly", "scribd.com", "slideshare.net")
PRETTY = {"wikipedia.org": "Wikipedia", "thehindu.com": "The Hindu", "indianexpress.com": "The Indian Express", "timesofindia.indiatimes.com": "The Times of India",
          "ndtv.com": "NDTV", "bbc.com": "BBC", "bbc.co.uk": "BBC", "reuters.com": "Reuters", "hindustantimes.com": "Hindustan Times", "news18.com": "News18",
          "thenewsminute.com": "The News Minute", "dtnext.in": "DT Next", "deccanherald.com": "Deccan Herald", "livemint.com": "Mint", "economictimes.indiatimes.com": "The Economic Times",
          "britannica.com": "Britannica", "youtube.com": "YouTube", "tn.gov.in": "Government of Tamil Nadu", "eci.gov.in": "Election Commission of India",
          "pib.gov.in": "Press Information Bureau", "india.gov.in": "Government of India", "bloomberg.com": "Bloomberg", "theguardian.com": "The Guardian",
          "nytimes.com": "The New York Times", "apnews.com": "AP News", "cnn.com": "CNN", "aljazeera.com": "Al Jazeera", "forbes.com": "Forbes"}


def _domain(url: str) -> str:
    m = re.match(r"https?://([^/]+)", url or "")
    host = (m.group(1) if m else url or "").lower()
    return host[4:] if host.startswith("www.") else host


def _pretty_title(title: str | None, url: str) -> str:
    dom = _domain(url)
    t = (title or "").strip()
    for k, v in PRETTY.items():
        if dom == k or dom.endswith("." + k):
            return v if (not t or t == dom or t.endswith(k) or len(t) < 4) else t
    if not t or t == dom:
        return dom or "source"
    return t


def _history_context(history: list[dict]) -> str:
    if not history:
        return ""
    lines = []
    for h in history[-6:]:
        who = "Person" if h.get("role") == "user" else "Assistant"
        lines.append(f"{who}: {str(h.get('content') or '')[:300]}")
    return "\n\nEarlier in this conversation (context only - do NOT answer these again):\n" + "\n".join(lines)


def _clean(text: str) -> str:
    t = re.sub(r"^\s*#+\s*", "", text or "", flags=re.M)
    t = re.sub(r"\*\*(.+?)\*\*", r"\1", t)
    t = re.sub(r"^\s*[-*•]\s+", "", t, flags=re.M)
    return t.strip()


def _gemini(question: str, history: list[dict], today: date) -> dict:
    model = settings.GEMINI_MODEL
    resp = ai_engine.requests.post(
        GEMINI_NATIVE.format(model=model),
        headers={"x-goog-api-key": settings.GEMINI_API_KEY.strip(), "Content-Type": "application/json"},
        json={
            "system_instruction": {"parts": [{"text": _SYSTEM.format(today=today.isoformat()) + _history_context(history)}]},
            "contents": [{"role": "user", "parts": [{"text": question}]}],
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
    # sources: numbered, titled, forums dropped; citations placed from groundingSupports
    chunks = list(meta.get("groundingChunks") or [])
    keep: dict[int, int] = {}  # chunk index -> citation number
    sources = []
    seen = set()
    for i, ch in enumerate(chunks):
        w = ch.get("web") or {}
        url, title = w.get("uri"), w.get("title")
        if not url or url in seen:
            continue
        dom = _domain(url)
        tdom = _domain(title or "") if title and "." in (title or "") and " " not in (title or "") else ""
        if any(dom == d or dom.endswith("." + d) or (tdom and (tdom == d or tdom.endswith("." + d))) for d in EXCLUDED_DOMAINS):
            continue
        seen.add(url)
        keep[i] = len(sources) + 1
        sources.append({"n": len(sources) + 1, "title": _pretty_title(title, title if tdom else url), "url": url, "domain": tdom or dom})
    text = _cite(text, list(meta.get("groundingSupports") or []), keep)
    queries = list(meta.get("webSearchQueries") or [])
    try:
        ai_engine._meter_usage({"usage": {"prompt_tokens": (body.get("usageMetadata") or {}).get("promptTokenCount", 0),
                                          "completion_tokens": (body.get("usageMetadata") or {}).get("candidatesTokenCount", 0)}})
    except Exception:  # noqa: BLE001 - metering never affects the answer
        pass
    return {"text": _clean(text), "sources": sources[:8], "grounded": bool(sources) or bool(chunks), "queries": queries[:4], "provider": "gemini",
            "dropped": len(chunks) - len(sources)}


def _cite(text: str, supports: list[dict], keep: dict[int, int]) -> str:
    """[n] after each sentence the grounding metadata ties to a kept source (highest end index first so offsets hold)."""
    if not supports or not keep:
        return text
    raw = text.encode("utf-8")
    marks: list[tuple[int, str]] = []
    for sp in supports:
        seg = sp.get("segment") or {}
        end = seg.get("endIndex")
        nums = sorted({keep[i] for i in (sp.get("groundingChunkIndices") or []) if i in keep})
        if end is None or not nums:
            continue
        marks.append((int(end), "".join(f"[{n}]" for n in nums[:3])))
    if not marks:
        return text
    marks.sort(key=lambda m: -m[0])
    done = set()
    for end, mark in marks:
        if end in done or end > len(raw):
            continue
        done.add(end)
        raw = raw[:end] + mark.encode("utf-8") + raw[end:]
    out = raw.decode("utf-8", errors="ignore")
    return re.sub(r"(\[\d+\])(\1)+", r"\1", out)


def _tavily(question: str, history: list[dict], today: date) -> dict:
    resp = ai_engine.requests.post(
        TAVILY_URL, json={"api_key": settings.TAVILY_API_KEY.strip(), "query": question, "max_results": 6,
                          "search_depth": "basic", "include_answer": False}, timeout=30)
    if resp.status_code >= 400:
        raise RuntimeError(f"Tavily search failed ({resp.status_code})")
    results = (resp.json() or {}).get("results") or []
    pages = [{"title": r.get("title") or r.get("url"), "url": r.get("url"), "content": str(r.get("content") or "")[:1500]}
             for r in results if r.get("url")]
    pages = [p for p in pages if not any(_domain(p["url"]) == d or _domain(p["url"]).endswith("." + d) for d in EXCLUDED_DOMAINS)]
    for i, p in enumerate(pages):
        p["n"] = i + 1
    msgs = [{"role": "system", "content": _SYSTEM.format(today=today.isoformat()) + _history_context(history)
             + " Cite a source after the sentence it supports as [n], using the n of the search result."}]
    msgs.append({"role": "user", "content": f"Question: {question}\n\nSearch results (JSON):\n{json.dumps(pages, ensure_ascii=False)}"})
    text = ai_engine._call_llm_resilient(msgs, max_tokens=900)
    return {"text": _clean(text), "sources": [{"n": p["n"], "title": _pretty_title(p["title"], p["url"]), "url": p["url"], "domain": _domain(p["url"])} for p in pages],
            "grounded": bool(pages), "queries": [question], "provider": "tavily"}


def _model_only(question: str, history: list[dict], today: date) -> dict:
    msgs = [{"role": "system", "content": _SYSTEM.format(today=today.isoformat()) +
             " You have NO live search in this deployment: answer from what you know, and if the fact can change over "
             "time say clearly that it should be checked against a current source." + _history_context(history)}]
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
