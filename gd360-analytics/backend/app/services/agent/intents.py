"""2026-10-14 (R46): which tool a sentence goes to.

Rules first (cheap, deterministic, testable); the model only decides the one
hard case - "is this about the world or about this person's data?" - and only
when the rules cannot tell. Intents: knowledge | data | dashboard | document |
automation | chat.
"""
from __future__ import annotations

import json
import re

from ...config import get_settings
from .. import ai_engine

settings = get_settings()

AUTOMATION = re.compile(
    r"\b(alert|notify|warn|ping|text|email|message)\s+(me|us|the team|#?\w+)\b"
    r"|\b(set\s*up|create|make|add)\b.*\b(an?\s+)?(alert|automation|reminder|schedule|watch)\b"
    r"|\bevery\s+(day|morning|evening|week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|hour|month|15 minutes)\b"
    r"|\beach\s+(day|week|month|morning)\b"
    r"|\b(send|email|post|message)\s+(me|us|the team|#?\w+)\b.{0,40}\b(weekly|daily|hourly|monthly|every)\b"
    r"|\b(weekly|daily|hourly|monthly)\s+(alert|reminder|digest|check|email|message|notification)\b"
    r"|\b(if|when|whenever)\b.{0,80}\b(drops?|falls?|rises?|goes|gets|crosses|exceeds?)\b.{0,40}\b(below|above|under|over|by)\b"
    r"|\bwatch\s+(this|that|it|the)\b|\bkeep an eye\b|\bremind me\b", re.I)
DASHBOARD = re.compile(
    r"\b(make|build|create|turn|put|add|give|generate|design)\b.{0,60}\bdashboard\b"
    r"|\bdashboard\b.{0,40}\b(for|from|of|with)\b(\s+(this|that|it|them|these|the))?"
    r"|^\s*dashboard\b|\bas a dashboard\b|\bon (a|the) dashboard\b", re.I)
DOCUMENT = re.compile(
    r"\b(write|draft|prepare|produce|make|create|put together|compose)\b.{0,50}\b(report|document|memo|brief|write-?up|summary|"
    r"review|doc|one-?pager|note for|email to|slides?|presentation)\b"
    r"|\b(board|exec|executive|weekly|monthly)\s+(review|report|summary|update)\b", re.I)
DEFINITION = re.compile(
    r"^\s*(define|definition of|meaning of|what does)\b|\bwhat (is|are) (an?|the)?\s*[\w&-]+( (ratio|rate|margin|index|score|model|method|law|act|tax|rule))?\??\s*$"
    r"|\bwhat does \w+ (mean|stand for)\b|\bexplain the (term|concept|difference between)\b", re.I)
CHAT = re.compile(
    r"^\s*(hi|hello|hey|yo|thanks?|thank you|thx|ok|okay|cool|great|nice|good (morning|evening|afternoon)|bye|cheers)[\s!.,]*$"
    r"|\bwhat can you do\b|\bwho are you\b|\bhow do (you|i) (work|use this)\b|\bhelp\b\s*$", re.I)
DATA_WORDS = re.compile(
    r"\b(our|my|we|us)\b|\b(customers?|orders?|sales|revenue|churn|margin|profit|campaigns?|posts?|reach|engagement|"
    r"leads?|accounts?|invoices?|bookings?|inventory|stock|spend|budget|cohort|retention|conversion|funnel|sessions?|"
    r"users?|signups?|tickets?|employees?|headcount|attrition|kpi|dashboard|table|column|rows?|dataset|data|file|sheet|csv|"
    r"forecast|predict|trend|compare|breakdown|by (month|week|day|region|product|channel|city|country)|last (month|week|quarter|year)|"
    r"this (month|week|quarter|year)|q[1-4]\b|ytd|mtd|what if|simulate|scenario|npv|irr|break-?even)\b", re.I)
WORLD_WORDS = re.compile(
    r"\b(who is|who was|who are|what is the (capital|population|gdp|currency|time)|chief minister|prime minister|president|"
    r"ceo of|founder of|headquarter|when (did|was|is)|how (old|tall|far|many people)|define|definition of|meaning of|"
    r"what does \w+ (mean|stand for)|explain (what|how) \w+ (is|works)|news|latest|weather|exchange rate|stock price|"
    r"inflation rate|interest rate|rbi|sebi|gst|tax rate|law|regulation|wikipedia|history of)\b", re.I)


def _mentions_data(question: str, names: list[str]) -> bool:
    q = f" {question.lower()} "
    for n in names:
        n = (n or "").strip().lower()
        if len(n) >= 4 and f" {n} " in q.replace("_", " "):
            return True
    return False


def route(question: str, *, has_sources: bool, source_names: list[str] | None = None, column_names: list[str] | None = None,
          last_kind: str | None = None, mode: str = "auto") -> dict:
    """{intent, by: "rule"|"model"|"default", reason}."""
    q = (question or "").strip()
    if not q:
        return {"intent": "chat", "by": "rule", "reason": "empty"}
    if CHAT.search(q) and len(q) < 60:
        return {"intent": "chat", "by": "rule", "reason": "greeting or help"}
    if AUTOMATION.search(q):
        return {"intent": "automation", "by": "rule", "reason": "asks to be told when something happens"}
    if DASHBOARD.search(q):
        return {"intent": "dashboard", "by": "rule", "reason": "asks for a dashboard"}
    if DOCUMENT.search(q):
        return {"intent": "document", "by": "rule", "reason": "asks for a written document"}
    if DEFINITION.search(q) and not re.search(r"\b(our|my|this|these|the (data|table|file|column|chart|number))\b", q, re.I):
        return {"intent": "knowledge", "by": "rule", "reason": "asks for a definition"}
    names = list(source_names or []) + list(column_names or [])
    if has_sources and _mentions_data(q, names):
        return {"intent": "data", "by": "rule", "reason": "names a source or column"}
    data_hit = bool(DATA_WORDS.search(q))
    world_hit = bool(WORLD_WORDS.search(q))
    if world_hit and not data_hit:
        return {"intent": "knowledge", "by": "rule", "reason": "a world question"}
    if data_hit and (has_sources or re.search(r"\b(what if|simulate|scenario|npv|irr|break-?even|random|model)\b", q, re.I)):
        return {"intent": "data", "by": "rule", "reason": "about this person's data"}
    if not has_sources:
        return {"intent": "knowledge", "by": "rule", "reason": "no data connected"}
    # the hard case: the model decides, with the source names in front of it
    try:
        return _model_route(q, source_names or [], last_kind)
    except Exception as e:  # noqa: BLE001 - routing must never fail a question
        print(f"[agent.intents] model route skipped: {e}")
        return {"intent": "data" if last_kind == "data" else "knowledge", "by": "default", "reason": "router unavailable"}


_ROUTER_SYSTEM = (
    "GD360 INTENT ROUTER. Decide whether a message is a question about the WORLD (general knowledge, public facts, "
    "definitions, news, people, places, laws) or about the person's own DATA (the connected sources listed). "
    'Reply with JSON only: {"intent": "knowledge" | "data", "reason": "<8 words>"}. '
    "Prefer data when the message could be answered from the listed sources."
)


def _model_route(question: str, source_names: list[str], last_kind: str | None) -> dict:
    model = settings.GEMINI_GOKU_MODEL if settings.AI_PROVIDER == "gemini" else None
    user = f"Connected sources: {', '.join(source_names[:12]) or 'none'}\nLast turn was about: {last_kind or 'nothing yet'}\nMessage: {question}"
    raw = ai_engine._call_llm_resilient([{"role": "system", "content": _ROUTER_SYSTEM}, {"role": "user", "content": user}],
                                        max_tokens=80, model_override=model)
    m = re.search(r"\{.*\}", raw or "", re.S)
    data = json.loads(m.group(0)) if m else {}
    intent = data.get("intent") if data.get("intent") in ("knowledge", "data") else "data"
    return {"intent": intent, "by": "model", "reason": str(data.get("reason") or "")[:80]}
