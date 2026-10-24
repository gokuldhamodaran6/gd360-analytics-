"""2026-10-15 (R48): which tool a sentence goes to - the model reads the whole message; rules only confirm.

Order:
1. normalise - obvious typos of the words that decide a route are corrected ("dashbaord" -> "dashboard",
   "documnet" -> "document") before anything looks at the text;
2. exact rules - a greeting, a team request, an explicit "train a model", a dashboard edit while one is on
   the canvas, "alert me when", "make a dashboard", "write a report": high-precision patterns that need
   the deciding word spelled (after step 1);
3. the model - everything else goes to the router model with the sources, their columns, the last turn
   and whether a dashboard is open, and it returns {intent, recipe, reason}; a multi-part data question
   ("why ..., predict ..., recommend ...") is the analysis recipe, not three tools;
4. fallbacks - when the model is unavailable, the old word lists decide, and an analysis-sounding question
   over a table with an outcome column still becomes an analysis.

Intents: knowledge | data | analysis | dashboard | dashboard_edit | document | automation | team | model | chat.
"""
from __future__ import annotations

import difflib
import json
import re

from ...config import get_settings
from .. import ai_engine

settings = get_settings()

INTENTS = ("knowledge", "data", "analysis", "dashboard", "dashboard_edit", "document", "automation", "team", "model", "chat")

# ---- 1. typos of the words that decide a route ----------------------------------------------

ROUTE_WORDS = ("dashboard", "dashboards", "document", "report", "alert", "predict", "prediction", "model", "forecast", "automation",
               "automate", "notify", "remind", "schedule", "summary", "brief", "chart", "analyse", "analyze", "analysis", "customers",
               "recommend", "retain", "retention", "churn", "attrition", "revenue", "segment", "compare", "weekly", "monthly", "daily")
_SAFE = {"alter", "modal", "models", "reports", "charts", "briefs", "charts", "modern", "modem", "chat", "cart", "chart", "brie"}


def normalize(text: str) -> str:
    out = []
    for tok in re.split(r"(\W+)", text or ""):
        low = tok.lower()
        if len(low) >= 5 and low.isalpha() and low not in ROUTE_WORDS and low not in _SAFE:
            close = difflib.get_close_matches(low, ROUTE_WORDS, n=1, cutoff=0.86)
            if close and close[0] != low:
                tok = close[0] if tok.islower() else close[0].capitalize()
        out.append(tok)
    return "".join(out)


# ---- 2. the exact rules ---------------------------------------------------------------------

AUTOMATION = re.compile(
    r"\b(alert|notify|warn|ping|text|email|message)\s+(me|us|the team|#?\w+)\b"
    r"|\b(set\s*up|create|make|add)\b.*\b(an?\s+)?(alert|automation|reminder|schedule|watch)\b"
    r"|\bevery\s+(day|morning|evening|week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|hour|month|15 minutes)\b"
    r"|\beach\s+(day|week|month|morning)\b"
    r"|\b(send|email|post|message)\s+(me|us|the team|#?\w+)\b.{0,40}\b(weekly|daily|hourly|monthly|every)\b"
    r"|\b(weekly|daily|hourly|monthly)\s+(alert|reminder|digest|check|email|message|notification)\b"
    r"|\b(if|when|whenever)\b.{0,80}\b(drops?|falls?|rises?|goes|gets|crosses|exceeds?|passes)\b.{0,40}\b(below|above|under|over|by)\b"
    r"|\bwatch\s+(this|that|it|the)\b|\bkeep an eye\b|\bremind me\b", re.I)
DASHBOARD = re.compile(
    r"\b(make|build|create|turn|put|add|give|generate|design|need|want)\b.{0,60}\bdashboards?\b"
    r"|\bdashboards?\b.{0,40}\b(for|from|of|with|showing|that)\b(\s+(this|that|it|them|these|the))?"
    r"|^\s*dashboards?\b|\bas a dashboard\b|\bon (a|the) dashboard\b", re.I)
DOCUMENT = re.compile(
    r"\b(write|draft|prepare|produce|make|create|put together|compose)\b.{0,50}\b(report|document|memo|brief|write-?up|summary|"
    r"review|doc|one-?pager|note for|email to|slides?|presentation)\b"
    r"|\b(board|exec|executive|weekly|monthly)\s+(review|report|summary|update)\b"
    # R57: "give me a summary in doc", "a detailed report of 2024 sales", "send it as a PDF"
    r"|\b(give|send|get|need|want|show)\b.{0,40}\b(report|document|doc|memo|write-?up|one-?pager)\b"
    r"|\b(in|as|into)\s+(a\s+|the\s+)?(doc|document|word|pdf|report|memo)\b"
    r"|\b(detailed|full|complete|in-?depth|comprehensive|thorough)\s+(report|write-?up|document|doc|summary)\b", re.I)
DEFINITION = re.compile(
    r"^\s*(define|definition of|meaning of|what does)\b|\bwhat (is|are) (an?|the)?\s*[\w&-]+( (ratio|rate|margin|index|score|model|method|law|act|tax|rule))?\??\s*$"
    r"|\bwhat does \w+ (mean|stand for)\b|\bexplain the (term|concept|difference between)\b", re.I)
CHAT = re.compile(
    r"^\s*(hi|hello|hey|yo|thanks?|thank you|thx|ok|okay|cool|great|nice|good (morning|evening|afternoon)|bye|cheers)[\s!.,]*$"
    r"|\bwhat can you do\b|\bwho are you\b|\bhow do (you|i) (work|use this)\b|\bhelp\b\s*$", re.I)
EXPLICIT_MODEL = re.compile(r"\b(train|build|fit|create)\s+(a |an |the )?(ml |machine.learning |prediction |predictive )?(model|classifier|predictor)\b|\bml studio\b", re.I)
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

# the analysis recipes
OUTCOME_Q = re.compile(r"\b(why|reasons?|drivers?|what drives|what (causes|explains)|predict|likely to|at risk|risk|retain|retention|recommend|prevent|"
                       r"reduce|stop|who (will|is|are|might) (going to )?(leave|churn|cancel|stop|default)|leav(e|ing)|lose|losing)\b", re.I)
OUTCOME_WORD = re.compile(r"\b(churn|churned|attrition|attrited|cancel+(s|ed|ation|ing)?|leav(e|ing)|left|lost|lose|losing|default|defaulted|convert(ed|s|ion)?|fraud|renew(al|ed)?|lapse[ds]?)\b", re.I)
SEGMENT_Q = re.compile(r"\bwhich\b.{0,60}\b(loses?|lost|has|have|had|is|are|show|shows|churns?|cancels?|leaves?|defaults?|converts?|renews?)\b.{0,40}\b(most|least|highest|lowest|biggest|worst|best)\b|\b(by|per|across)\s+(card|income|region|segment|category|plan|tier|gender|age|product|channel|country|city|team|department|type|group)\b", re.I)
SIGNAL_Q = re.compile(r"\b(does|do|is|are|did|can|could|how (much|well) does)\b.{0,50}\b(predict|affect|drive|matter|relate|correlate|explain|cause|lead to|associated|influence|impact)\b", re.I)
MEASURE_Q = re.compile(r"\b(revenue|sales|sold|amount|spend|spent|price|prices|profit|cost|costs|units|orders|volume|adr|margin|average|total|sum|"
                       r"mean|median|month|months|monthly|week|weekly|day|daily|year|yearly|quarter|trend|trended|over time)\b", re.I)
OUTCOME_COL = re.compile(r"churn|attrit|exit|cancel|lost|left|retain|status|flag|outcome|default|fraud|convert|renew|active|lapse|closed", re.I)


def analysis_spec(question: str, column_names: list[str] | None) -> dict | None:
    """The recipe a question asks for over a table with an outcome column, or None."""
    q = question or ""
    cols = list(column_names or [])
    has_outcome = any(OUTCOME_COL.search(c) for c in cols)
    if not OUTCOME_WORD.search(q) and not has_outcome:
        return None
    # R52: "which month had the lowest revenue" on a table that also has an outcome column is a question about revenue,
    # not about the outcome - the analysis recipes need the outcome named when another measure or a time unit is
    if not OUTCOME_WORD.search(q) and MEASURE_Q.search(q):
        return None
    if SIGNAL_Q.search(q) and OUTCOME_WORD.search(q):
        return {"recipe": "signal"}
    if SEGMENT_Q.search(q) and (OUTCOME_WORD.search(q) or has_outcome):
        return {"recipe": "segment"}
    if OUTCOME_Q.search(q) and (OUTCOME_WORD.search(q) or has_outcome):
        return {"recipe": "outcome"}
    return None


def _mentions_data(question: str, names: list[str]) -> bool:
    q = f" {question.lower()} "
    for n in names:
        n = (n or "").strip().lower()
        if len(n) >= 4 and f" {n} " in q.replace("_", " "):
            return True
    return False


def route(question: str, *, has_sources: bool, source_names: list[str] | None = None, column_names: list[str] | None = None,
          last_kind: str | None = None, mode: str = "auto", has_dashboard: bool = False, wants_team=None, wants_edit=None) -> dict:
    """{intent, by: "rule"|"model"|"default", reason, recipe?, text}."""
    raw = (question or "").strip()
    q = normalize(raw)
    base = {"text": q, "normalized": q != raw}
    if not q:
        return base | {"intent": "chat", "by": "rule", "reason": "empty"}
    if CHAT.search(q) and len(q) < 60:
        return base | {"intent": "chat", "by": "rule", "reason": "greeting or help"}
    if wants_team and wants_team(q):
        return base | {"intent": "team", "by": "rule", "reason": "creates a team or data rules"}
    if EXPLICIT_MODEL.search(q):
        return base | {"intent": "model", "by": "rule", "reason": "asks to train a model"}
    if AUTOMATION.search(q):
        return base | {"intent": "automation", "by": "rule", "reason": "asks to be told when something happens"}
    # R50: "make the dashbaord navy and call it Retention pulse" changes the open one - "the/this/my dashboard"
    # with an edit is an edit, even though "make ... dashboard" also reads like a request for one
    if has_dashboard and wants_edit and wants_edit(q) and (not DASHBOARD.search(q) or re.search(r"\b(the|this|that|my|our|its)\s+dashboards?\b", q, re.I)) \
            and not re.search(r"\b(new|another|second|separate)\s+dashboards?\b", q, re.I):
        return base | {"intent": "dashboard_edit", "by": "rule", "reason": "changes the dashboard on the canvas"}
    if DASHBOARD.search(q):
        return base | {"intent": "dashboard", "by": "rule", "reason": "asks for a dashboard"}
    if DOCUMENT.search(q):
        return base | {"intent": "document", "by": "rule", "reason": "asks for a written document"}
    if DEFINITION.search(q) and not re.search(r"\b(our|my|this|these|the (data|table|file|column|chart|number))\b", q, re.I):
        return base | {"intent": "knowledge", "by": "rule", "reason": "asks for a definition"}
    spec = analysis_spec(q, column_names) if has_sources else None
    if spec:
        return base | {"intent": "analysis", "by": "rule", "reason": f"an analysis of an outcome ({spec['recipe']})", **spec}
    # 3. the model reads the whole message
    try:
        out = _model_route(q, source_names or [], column_names or [], last_kind, has_sources, has_dashboard)
        if out:
            if out["intent"] == "analysis" and not has_sources:
                out["intent"] = "knowledge"
            if out["intent"] == "dashboard_edit" and not has_dashboard:
                out["intent"] = "dashboard"
            if out["intent"] == "data" and not has_sources and not WORLD_WORDS.search(q):
                out["intent"] = "data"  # the Analyst works from the question alone (what-if); turns.py decides
            return base | out
    except Exception as e:  # noqa: BLE001 - routing must never fail a question
        print(f"[agent.intents] model route skipped: {e}")
    # 4. fallbacks
    names = list(source_names or []) + list(column_names or [])
    if has_sources and _mentions_data(q, names):
        return base | {"intent": "data", "by": "default", "reason": "names a source or column"}
    data_hit = bool(DATA_WORDS.search(q))
    world_hit = bool(WORLD_WORDS.search(q))
    if world_hit and not data_hit:
        return base | {"intent": "knowledge", "by": "default", "reason": "a world question"}
    if data_hit and (has_sources or re.search(r"\b(what if|simulate|scenario|npv|irr|break-?even|random|model)\b", q, re.I)):
        return base | {"intent": "data", "by": "default", "reason": "about this person's data"}
    if not has_sources:
        return base | {"intent": "knowledge", "by": "default", "reason": "no data connected"}
    return base | {"intent": "data" if last_kind in ("data", "analysis") else "knowledge", "by": "default", "reason": "router unavailable"}


_ROUTER_SYSTEM = (
    "Euliv INTENT ROUTER. You read one message in a conversation with a data assistant and decide which tool answers it. "
    "Tools: knowledge (a question about the world, public facts, people, places, definitions, news); "
    "data (a question answered by querying the person's connected tables: totals, breakdowns, trends, comparisons, what-ifs); "
    "analysis (why an outcome happens, what drives it, who is at risk, predict who will churn/cancel/convert, recommend what to do - a deeper "
    "study of a yes/no outcome column; a message that asks for reasons AND prediction AND recommendations is ONE analysis); "
    "dashboard (make/build a dashboard); dashboard_edit (change the dashboard that is open: theme, name, add or remove a chart, filters); "
    "document (write a report, brief, memo, summary); automation (alert/notify/remind on a schedule or threshold); "
    "team (create a team, space, or data access rules); model (explicitly train a machine-learning model); chat (greeting, thanks, help). "
    "Typos and long sentences are normal: read the meaning. "
    'Reply with JSON only: {"intent": "<tool>", "recipe": "outcome"|"segment"|"signal"|null, "reason": "<8 words>"}. '
    "recipe only for analysis: outcome = reasons/prediction/recommendations overall; segment = 'which <group> has the most/least'; "
    "signal = 'does <one column> predict/affect <outcome>'."
)


def _model_route(question: str, source_names: list[str], column_names: list[str], last_kind: str | None, has_sources: bool, has_dashboard: bool) -> dict | None:
    model = settings.GEMINI_GOKU_MODEL if settings.AI_PROVIDER == "gemini" else None
    user = (f"Connected sources: {', '.join(source_names[:12]) or 'none'}\n"
            f"Columns: {', '.join(column_names[:60]) or 'none'}\n"
            f"A dashboard is open on the canvas: {'yes' if has_dashboard else 'no'}\n"
            f"Last turn was: {last_kind or 'nothing yet'}\nMessage: {question}")
    raw = ai_engine._call_llm_resilient([{"role": "system", "content": _ROUTER_SYSTEM}, {"role": "user", "content": user}],
                                        max_tokens=100, model_override=model)
    m = re.search(r"\{.*\}", raw or "", re.S)
    data = json.loads(m.group(0)) if m else {}
    intent = data.get("intent")
    if intent not in INTENTS:
        return None
    out = {"intent": intent, "by": "model", "reason": str(data.get("reason") or "")[:80]}
    if intent == "analysis":
        out["recipe"] = data.get("recipe") if data.get("recipe") in ("outcome", "segment", "signal") else "outcome"
    return out
