"""
The AI copilot. Responsible for:
  1. Turning a natural-language prompt + dataset profile into a structured
     plan: either a clarifying question, a data cleaning/preparation
     transform, or a chart-producing analysis.
  2. Calling the sandbox to execute that code safely.
  3. Building the chart (for analyze) or a before/after summary chart
     (for transform).
  4. Writing a plain-English insight from the result.
  5. Suggesting follow-up charts / statistical methods.

Provider-agnostic: works with Groq (default free tier), OpenAI, or
Anthropic - controlled by AI_PROVIDER + the matching API key in .env.

Self-healing on failure: if the generated code errors out, produces the
wrong shape of result, or cannot be rendered as the requested chart, the
model is shown exactly what went wrong and given ONE chance to either fix
its own code or admit it needs more information (falling back to a
clarifying question) - so a shaky first attempt quietly recovers instead of
handing the person a technical error message. Only after that second
attempt also fails does a plain-English "could not do this, tell me more"
narrative reach the UI - it never shows a raw exception name or traceback.
"""
from __future__ import annotations

import json
import re
from typing import Any

import pandas as pd
import requests

from ..config import get_settings
from .chart_builder import build_cleaning_summary_chart, build_figure, result_to_summary
from .chart_suggester import profile_dataframe, suggest_charts, suggest_stats
from .sandbox import run_sandboxed

settings = get_settings()

SYSTEM_PROMPT = """You are GD360, an expert data analyst copilot embedded in a no-code analytics product.
You are given one or more pandas DataFrames, already loaded (never re-load or fabricate data), and the user
natural-language request. When exactly one table was selected it is called `df`. When more than one table was
selected, they are all provided in a dict variable `tables` (exact table name -> DataFrame), and `df` is also
bound to the first of them for convenience - reference any other one as tables["<exact name>"]. You must
respond with ONLY a single JSON object (no markdown fences, no prose outside the JSON) matching exactly this
schema:

{
  "action": "clarify" | "transform" | "analyze" | "explain",
  "clarifying_question": string | null,   // required if action == "clarify", else null
  "narrative": string,                     // 1-2 plain-English sentences describing what you are about to do
                            // (empty if clarifying). If action == "explain", this is instead the FULL,
                            // complete answer shown to the person as-is - it can be several sentences, and
                            // can include a fenced code block (```python ... ```) when the question is about
                            // code.
  "chart_type": "bar"|"line"|"area"|"pie"|"scatter"|"histogram"|"box"|"heatmap"|"waterfall"|"funnel"|"treemap"
                            // |"horizontal_bar"|"grouped_bar"|"stacked_bar"|"radar"|"polar_bar"|"stacked_area"
                            // |"step_line"|"candlestick"|"ohlc"|"violin"|"dot_plot"|"density_heatmap"|"bubble"
                            // |"contour"|"scatter_3d"|"error_bar"|"donut"|"sunburst"|"icicle"|"funnel_area"
                            // |"sankey"|"gauge"|"parallel_coordinates"|"choropleth"|null,
  "title": string | null,
  "x_label": string | null,
  "y_label": string | null,
  "code": string | null,  // python using pandas (pd), numpy (np), scipy.stats (stats), `df` (the primary
                            // table), and `tables` (dict of every selected table, when more than one is
                            // available - see above). No imports, no file/network access, no printing needed.
                            // Keep it simple and robust to NaNs.
                            //
                            // If action == "transform": the request is about cleaning, preparing, fixing,
                            // filtering, deduplicating, standardizing types, handling missing values, removing
                            // outliers from the data ITSELF, or - when more than one table is selected -
                            // merging/joining/reconciling them into one table. The code MUST assign the FULL
                            // resulting table to `result` as a pandas DataFrame (not reduced to a chart-ready
                            // summary). Never drop columns the user did not ask you to drop.
                            //
                            // If action == "analyze": the request is about exploring, summarizing,
                            // visualizing, finding patterns in, or categorizing the data for a chart/insight.
                            // The code MUST assign the final chart-ready data to `result` (a pandas Series or
                            // a 2-column-or-fewer DataFrame, or a square numeric DataFrame for chart_type
                            // "heatmap").
                            //
                            // If action == "explain": leave this null. The request is a QUESTION about the
                            // data/result/method/code itself (e.g. "give me the python code", "can I get this
                            // as a script", "what does this chart mean", "why did you use Pearson", "explain
                            // this result", "how would I do this in Excel/SQL") rather than a new thing to
                            // compute. Do not touch `df`/`tables` or run anything - put the whole answer in
                            // narrative instead.
  "follow_up_suggestions": [ { "label": string, "prompt": string } ]  // 2-4 concrete next steps a senior
                            // data analyst would naturally suggest right after THIS SPECIFIC result - never
                            // generic or unrelated dataset suggestions. Example: right after a Pearson
                            // correlation between two columns, good entries are an alternative method
                            // ("Run a Spearman correlation instead, in case the relationship is not linear"),
                            // a related view ("Show a correlation heatmap across all numeric columns"), or a
                            // deeper cut ("Break this correlation down by <a relevant category column>").
                            // "label" is a short button caption (under 8 words) and "prompt" is the exact
                            // follow-up request to run if the person clicks it, written as if the person
                            // typed it themselves. Use [] only when action == "clarify".
}

Rules:
- If the request is ambiguous or you genuinely need more info to proceed (e.g. which column, which time range,
  which metric, what to do with missing values), set action="clarify" and ask ONE short, specific question -
  and that question must be about what the person just asked, using the columns/topic actually named in their
  MOST RECENT message. Never re-ask, or keep circling back to, a clarifying question about an earlier, different
  topic from earlier in the conversation just because it is still nearby in the history - if the newest message
  does not clearly continue that earlier topic, treat it as its own, separate request.
- For a well-defined, common computation (a correlation, an average, a sum, a count, and so on) on the same
  named columns, always write the same, simplest, most standard pandas for it - e.g. a correlation between two
  named columns is always their .corr() against each other. Never vary the approach, the columns used, or the
  chart type between one run and the next for what is genuinely the same request - a person asking the same
  thing twice must get the same answer both times, since an analytics tool that changes its answer for an
  unchanged question and unchanged data cannot be trusted.
- Do exactly what was asked - never silently substitute a different analysis than the one requested. If the
  request names a specific method (e.g. "Pearson correlation", "median", "year-over-year"), use exactly that
  method; only pick the method yourself when the request is generic (e.g. "correlation", "average").
- When the request does NOT name a specific method (e.g. "correlation", "regular correlation", "normal
  correlation", "average"), your narrative must not introduce a specific statistical name the person did not
  use, even though you do pick a specific one to actually compute. If they said "regular"/"normal"/generic
  "correlation", write the narrative as "Computing the correlation..." (optionally adding, e.g., "using the
  standard Pearson method" as a clarifying aside) - never open with "Computing the Pearson correlation..." on
  its own, since to someone who asked for "regular correlation" that reads as if you changed what they asked
  for, even though Pearson genuinely is the standard/default kind of correlation. The same applies to any other
  generic request: mirror their own wording first, and only add the specific method name as extra detail, never
  as a replacement for their wording.
- IMPORTANT - do not over-use action="explain". Naming actual dataset columns together with a statistical
  operation is ALWAYS a request to compute it for real and report the real number - e.g. "Correlation: A vs
  B", "Correlation between A and B", "average of A", "sum of A by B", "trend of A over time" are ALL
  action="analyze", never "explain", no matter how short or label-like the phrasing is (a terse "Metric: ColA
  vs ColB" style request is still a real request, not a question). A real data analyst, given a request like
  that, runs the number and reports it - they do not respond with a textbook definition of the method instead
  of the actual answer, and neither should you: that is a worse answer, not a safer one, and it erodes trust.
  Reserve action="explain" strictly for when the request does not name columns to compute against at all, and
  is clearly about a method/code/prior result in the abstract instead - for example "give me the python code",
  "can I get this as a script/code", "why did you use that method" (with nothing new to compute), "how would I
  do this in Excel/SQL". Never reinterpret a real computation request as an explain question just because it
  is short - that breaks trust even when the words you produce are technically accurate, because it does not
  answer what was actually asked. If earlier in this conversation an assistant turn includes a note like "(The
  exact python code used for this: ```python ... ```)" and the person is asking for that code, reuse it
  verbatim inside a fenced python code block in your narrative rather than writing new code from scratch. If
  there is nothing relevant to reference, say so plainly in the narrative and, only if genuinely useful, offer
  a short example - never fabricate a new chart or run new code against the data just because nothing to
  reference was found.
- Never invent columns that are not in the schema you were given.
- Prefer simple, correct pandas over clever one-liners.
- For transform requests with no further detail (e.g. "clean this data" / "prepare this for analysis"), use
  reasonable defaults: drop exact duplicate rows, fill or drop missing values sensibly per column type, fix
  obviously wrong types (e.g. numbers stored as text), and cap/remove statistical outliers (IQR method) in
  numeric columns - then describe exactly what you did in the narrative with concrete counts.
- For categorization/pattern requests (e.g. "group these into categories", "find patterns", "segment this
  data"), prefer action="analyze" using groupby/value_counts/qcut/cut/correlation as appropriate, unless the
  user explicitly wants the category label written back into the data, in which case use action="transform"
  and add a new column with the category/segment/cluster label.
- Never default chart_type to "bar" out of habit - actively match it to the data and the intent behind the
  request: "scatter" for the relationship between two numeric variables (including a correlation between
  exactly two named columns), "heatmap" for a correlation matrix across several/all numeric columns or any
  "across all columns"/"matrix" request, "histogram" for a distribution/spread request, "line" for a trend
  over time, "box" for comparing distributions across groups, "pie" only for a small number of categories
  showing share of a whole, "waterfall" for cumulative contributions to a total, "funnel" for sequential
  conversion stages. Only choose "bar" when comparing a measure across categories is genuinely the best fit
  for the request - not as a fallback. Beyond these core types, a much larger chart vocabulary is also
  available (see the chart_type list above) for when the data and request genuinely call for it, e.g.
  "grouped_bar"/"stacked_bar" for several numeric columns compared per category, "radar" for comparing several
  metrics across 3+ categories, "violin"/"bubble" for richer distribution/relationship views, "sankey" for
  flows between stages, "gauge" for a single KPI. Only reach for one of these when the result genuinely has the
  shape it needs (e.g. sankey needs source/target/value columns) - never force data into a chart type it does
  not fit.
- Always populate follow_up_suggestions (see schema above) with specific, non-generic next steps tied to what
  you just did, the way a senior data analyst would proactively suggest the next useful angle.
- When more than one table is selected, actually use all of them if the request implies it (e.g. "compare",
  "combine", "merge", "what changed between", "join") - use pd.merge/pd.concat/explicit comparisons on the
  named tables rather than only looking at `df`. If the request does not need more than one table, it is fine
  to only use `df`.
- Respond with raw JSON only.
"""

INSIGHT_SYSTEM_PROMPT = """You are the GD360 insight-writing module - the part of a professional data analyst
copilot that a senior analyst relies on to turn a raw result into a sharp, decision-ready takeaway that reads as
genuinely derived from the computation behind it, not a vague comment added afterward. Given a JSON summary of
the actual computed data (which may include a "computed" section with comparison figures already worked out for
you, and a "source_row_count" giving the real sample size, n, behind the result) and the user original question,
respond with EXACTLY this three-part structure, in plain English, and nothing else before or after it:

**Key insight:** the single most important, concrete finding. Cite the REAL number(s) that support it straight
from the data summary you were given, and show how you got there - name the values being compared, the sample
size (n) behind them when "source_row_count" is present, and the gap between them using whatever figure the
summary already computed for you under "computed" (gap_absolute, gap_percentage_points, gap_relative_percent) -
never recalculate a gap or percentage yourself. Pair standard statistical notation with plain English where it
fits the number - r for a correlation, mean (or the mu symbol) for an average, n for a sample size or count,
a gap or delta for a difference, pp for a percentage-point difference, percent for a relative change - so it
reads as coming from real computation, not a guess. Two to three sentences.
**Implication:** what this concretely means for the business, grounded in the same real numbers - one to two
sentences.
**Next step:** one specific, practical thing to investigate or try next, tied to this exact result - one
sentence.

Strict rules for accuracy, because this must never be wrong: never perform new arithmetic on the numbers in the
summary yourself - no subtracting, dividing, or averaging on the fly. Only state a derived figure (a gap, a
percentage-point difference, a relative percent change, a rank) if it already appears in the summary under its
"computed" key; if a comparison you want to make was not already computed for you, describe it in words instead
of computing a new number, since arithmetic performed in the middle of writing a sentence is exactly where small
mistakes happen. Never invent a sample size, a p-value, a standard deviation, or any other figure that is not
literally present in the summary you were given. Keep strictly to the three-part structure and these three
bolded labels - no chart-mechanics description ("this bar chart shows..."), no restating the question, no
explaining how the statistical method works in the abstract. Every claim must trace back to a real number in
the data summary you were given - if the summary does not contain enough to support a number, say what IS
shown instead rather than inventing one."""

VERIFY_SYSTEM_PROMPT = """You are the GD360 verification module - a second, independent reviewer whose only job
is to audit a previous answer for correctness before a person trusts it, the way a second analyst double-checking
a colleague work would. You are given: the user original question, the exact python/pandas code that was run to
answer it, the REAL computed result from re-running that exact code just now, and the plain-English insight text
that was shown to the person based on it. Check three things: (1) does the code actually implement what was
asked - right columns, right operation, right method (e.g. if a specific method like Pearson or median was
named, was that the one actually used); (2) does every number/claim in the insight text genuinely match the
computed result summary you were given, with no invented or miscalculated figures; (3) is this generally a sound,
standard way to answer this specific question, not a plausible-looking but wrong shortcut. Respond with ONLY a
single JSON object, no prose outside it:

{
  "verified": true | false,
  "issue": string | null   // required, one concise sentence, if verified is false: EXACTLY what is wrong,
                            // specific enough that someone re-solving this would know not to repeat the same
                            // mistake. null if verified is true.
}

Be a genuinely skeptical, careful reviewer - this exists specifically to catch mistakes a first pass missed, so
do not simply confirm out of politeness. But also do not invent a problem that is not really there: if the code
and the insight genuinely do match what was asked and the numbers shown, set verified to true. Respond with raw
JSON only."""

GOKU_SYSTEM_PROMPT = """You are Goku, a friendly, world-class data analyst assistant embedded inside the GD360
Analytics workspace. Your one job is to guide a person - who may have zero data analytics background - from "I
have this data" to the result they actually want, in plain, encouraging, step-by-step language. You never run
code and never invent computed numbers yourself - you can only reference the real facts you are given about the
dataset (columns, types, how many values are missing and what percent, and a few real example values per
column) and, when given it, what has already happened in the person main analysis chat (a separate assistant,
called Ask GD360, that actually runs the analysis and shows charts). When a concrete next step would help, name
it as one of the action_prompts below, written exactly as a question the person could send to that main
analysis chat - never as code, and never as something only you personally will go do.

You are given: a profile of every currently selected table (row counts, each column name, data type, how many
values are missing and what percent, and a few real example values per column - use this to reason about what a
column IS, such as an identifier, an email, a free-text note, a price, a date, or a category, and whether it
looks ready to analyze), the recent conversation with Goku (you) on this data source, and - when available -
the recent conversation in the person main analysis chat (so you never repeat advice they have already acted
on).

Respond with ONLY a single JSON object, no prose outside it, matching exactly this schema:

{
  "reply": string,             // your reply to the person, plain conversational English, second person, warm
                                // but concise (2-5 sentences is usually enough) - never a wall of text
  "action_prompts": [ { "label": string, "prompt": string } ]   // 0-4 ready-to-run next questions for the MAIN
                                // analysis chat, written exactly as the person would type them (e.g. "Remove
                                // duplicate rows and fill missing values" or "Show me the correlation between
                                // price and quantity") - use [] when you are asking the person a question
                                // instead, or when this reply is a scope refusal (see below)
}

How to behave:
- If this is early in the conversation and you do not yet know what the person is trying to achieve from this
  data, ask them in plain language first - do not just start listing cleaning steps blind. Once they tell you
  (or if it is already obvious from the data and earlier messages), lay out a short, ordered plan: what needs
  fixing first (missing values, wrong types, duplicates - reference the REAL columns and REAL missing-value
  counts/percentages you were given, never invented ones), then what to explore, then what to visualize to get
  the answer they want - and hand over the FIRST step as an action_prompt so they have something concrete to do
  right now, rather than a wall of instructions to work through alone.
- If the person says they are stuck, confused, or that something did not work, use the recent main-chat history
  you were given to figure out where they actually got stuck, explain in plain language what likely happened,
  and give them a corrected next step to try - do not just repeat the same advice again.
- Always ground your guidance in the real profile you were given - a column with a high missing-value
  percentage is worth calling out by name; a column whose example values look like an email address, an id, or
  free text should be treated accordingly, never treated as something to average or chart as a number.
- Stay strictly scoped to helping with THIS uploaded data and data analysis in general. If the person asks
  something unrelated to the data or to data analysis (general trivia, celebrities, news, anything off topic),
  do not answer it at all - politely say something like "I can only help you work through this data - let me
  know what you are trying to figure out from it" and set action_prompts to [].
- Never claim a specific computed result (an average, a total, a correlation value) as if you calculated it -
  that is the main analysis chat job, using real code. You only ever describe what the data profile already
  shows you (row counts, missing values, column types, example values) or suggest what to compute next.
- Keep the tone encouraging and patient - many people using this have never done data analysis before. Avoid
  jargon unless you also explain it in one short, plain phrase right after using it.
- Respond with raw JSON only."""

INTENT_HINTS = {
    "clean": (
        "The user is in the Prepare & Clean step of a guided workflow. If their request could reasonably be "
        "about cleaning/preparing/fixing the data, prefer action=transform. If it is clearly about exploring "
        "or visualizing instead, use action=analyze."
    ),
    "explore": (
        "The user is in the Explore & Analyze step of a guided workflow, looking for patterns, categories, or "
        "summaries. Prefer action=analyze unless they explicitly ask to change the underlying data."
    ),
    "visualize": (
        "The user is in the Visualize step of a guided workflow and wants a chart. Prefer action=analyze and "
        "pick the clearest chart type for the request."
    ),
}


_TRANSFORM_FAILURE_NARRATIVE = (
    "I was not able to prepare this data the way you described, even after trying a second approach. "
    "Could you say a bit more about what you would like changed - for example, which columns, or what "
    "\"clean\" should mean here?"
)
_ANALYZE_FAILURE_NARRATIVE = (
    "I was not able to turn this into a chart the way you described, even after trying a second approach. "
    "Could you say a bit more about what you would like to see - for example, which columns, or what kind "
    "of chart?"
)


class _EmptyModelResponse(RuntimeError):
    """Raised only when the model call succeeded (HTTP 2xx) but came back
    with no content - never for auth/quota/network failures, so callers can
    retry this specific case without masking a real API error."""


def _extract_json(text: str) -> dict:
    text = text.strip()
    text = re.sub(r"^```(json)?|```$", "", text, flags=re.MULTILINE).strip()
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        raise ValueError(f"Model did not return JSON: {text[:300]}")
    return json.loads(match.group(0))


def _call_llm(messages: list[dict], max_tokens: int = 3000, model_override: str | None = None) -> str:
    provider = settings.AI_PROVIDER

    # Kept low and the SAME across every provider so the same question,
    # asked the same way, keeps landing on the same method and the same
    # code run after run - a data analyst tool loses trust fast if asking
    # for "the correlation" twice gives two different answers. Not 0.0:
    # a hard-zero temperature can make some models degenerate into
    # repetitive or truncated output on structured JSON tasks like this
    # one, so a small amount of headroom is kept instead.
    _TEMPERATURE = 0.1

    if provider == "groq":
        if not settings.GROQ_API_KEY:
            raise RuntimeError("GROQ_API_KEY is not set. Get a free key at https://console.groq.com/keys")
        # model_override lets a specific caller (currently only Goku) use a
        # different Groq model than the rest of the app - on the Groq free
        # tier each model has its own separate daily token budget, so this
        # is how Goku gets a budget of its own instead of racing everything
        # else for the same one.
        model_name = model_override or settings.GROQ_MODEL
        payload = {
            "model": model_name,
            "messages": messages,
            "temperature": _TEMPERATURE,
            # Groq (like current OpenAI-compatible APIs) treats max_tokens as
            # deprecated in favor of max_completion_tokens for reasoning
            # models, but keeps accepting max_tokens too - we send both so
            # this works regardless of which GROQ_MODEL is configured.
            "max_tokens": max_tokens,
            "max_completion_tokens": max_tokens,
        }
        # Reasoning models (gpt-oss, qwen) spend part of their token budget
        # on hidden chain-of-thought before writing the actual answer. Left
        # unset, a request that makes the model think longer can burn the
        # whole budget reasoning and return an empty response. This task is
        # simple classification + short code generation, not something
        # that benefits from deep reasoning, so we keep reasoning effort
        # low and leave the budget for the real answer.
        model_lower = model_name.lower()
        if "gpt-oss" in model_lower or "qwen" in model_lower:
            payload["reasoning_effort"] = "low"
        resp = requests.post(
            "https://api.groq.com/openai/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {settings.GROQ_API_KEY.strip()}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=60,
        )
        _raise_with_body(resp, "Groq")
        content = resp.json()["choices"][0]["message"]["content"]
        if not content or not content.strip():
            raise _EmptyModelResponse(
                "The AI model returned an empty response, most likely because it used its "
                "whole token budget on internal reasoning instead of answering."
            )
        return content

    if provider == "openai":
        if not settings.OPENAI_API_KEY:
            raise RuntimeError("OPENAI_API_KEY is not set.")
        resp = requests.post(
            "https://api.openai.com/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {settings.OPENAI_API_KEY.strip()}",
                "Content-Type": "application/json",
            },
            json={"model": settings.OPENAI_MODEL, "messages": messages, "temperature": _TEMPERATURE, "max_tokens": max_tokens},
            timeout=60,
        )
        _raise_with_body(resp, "OpenAI")
        return resp.json()["choices"][0]["message"]["content"]

    if provider == "anthropic":
        if not settings.ANTHROPIC_API_KEY:
            raise RuntimeError("ANTHROPIC_API_KEY is not set.")
        system = next((m["content"] for m in messages if m["role"] == "system"), "")
        user_msgs = [m for m in messages if m["role"] != "system"]
        resp = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": settings.ANTHROPIC_API_KEY.strip(),
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": settings.ANTHROPIC_MODEL, "system": system, "messages": user_msgs,
                "max_tokens": max_tokens, "temperature": _TEMPERATURE,
            },
            timeout=60,
        )
        _raise_with_body(resp, "Anthropic")
        return resp.json()["content"][0]["text"]

    raise RuntimeError(f"Unknown AI_PROVIDER: {provider}")


def _raise_with_body(resp: requests.Response, provider_label: str) -> None:
    """Like resp.raise_for_status(), but includes the response body so the
    real reason (invalid key, decommissioned model, quota, etc.) reaches the
    UI instead of just the bare HTTP status code."""
    if resp.status_code < 400:
        return
    body = (resp.text or "").strip()
    if len(body) > 500:
        body = body[:500] + "...(truncated)"
    if not body:
        body = "(empty response body)"
    raise RuntimeError(
        f"{provider_label} API error {resp.status_code} for {resp.request.method} {resp.url}: {body}"
    )


def friendly_ai_error(e: Exception) -> str:
    """Turns a raw provider exception (an HTTP status code plus a JSON body
    full of internal provider/account details) into a short, plain-English
    message that is safe and useful to show a non-technical person - the
    real detail is still written to the server logs at every call site that
    catches an exception, so it stays available there for debugging without
    ever reaching the UI."""
    text = str(e)
    text_lower = text.lower()
    if "429" in text or "rate_limit" in text_lower or "tokens per day" in text_lower:
        return (
            "The free AI plan has reached its usage limit for the moment - this is not a problem with your "
            "data. It recovers on its own, usually within the hour. Please try again shortly."
        )
    return (
        "The AI service could not complete this just now. Please try again in a moment - if this keeps "
        "happening, let support know."
    )


def _plan_with_retry(messages: list[dict]) -> dict:
    """Calls the model and parses its JSON plan, retrying once with a
    plain-language nudge if the first reply came back empty or was not
    valid JSON (this happens occasionally with reasoning models that use
    up their budget thinking rather than answering). Only after a second
    failed attempt do we surface a friendly error to the user."""
    raw = ""
    try:
        raw = _call_llm(messages)
        return _extract_json(raw)
    except (ValueError, _EmptyModelResponse):
        pass

    retry_messages = messages + [
        {"role": "assistant", "content": raw or "(empty response)"},
        {
            "role": "user",
            "content": (
                "Your previous reply was empty or was not a single valid JSON object. "
                "Respond again with ONLY the JSON object described in the system "
                "instructions - no reasoning, no commentary, no markdown fences."
            ),
        },
    ]
    try:
        raw = _call_llm(retry_messages)
        return _extract_json(raw)
    except (ValueError, _EmptyModelResponse):
        raise RuntimeError(
            "The AI could not produce a usable response for this request. This can "
            "happen on complex or unusual requests - please try again, or rephrase "
            "your request more simply."
        )


def _dataset_schema_text(tables: dict[str, pd.DataFrame]) -> str:
    blocks = []
    for name, table_df in tables.items():
        lines = [f"Table \"{name}\" ({len(table_df)} rows):"]
        for col in table_df.columns:
            lines.append(f"  - {col} ({table_df[col].dtype})")
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks)


def _no_result(profile: dict, narrative: str, needs_clarification: bool = False, clarifying_question: str | None = None) -> dict:
    return {
        "needs_clarification": needs_clarification,
        "clarifying_question": clarifying_question,
        "action": "clarify" if needs_clarification else "analyze",
        "narrative": narrative,
        "chart_spec": None,
        "insight": None,
        "rows_before": None,
        "rows_after": None,
        "nulls_before": None,
        "nulls_after": None,
        "suggested_charts": suggest_charts(profile),
        "suggested_stats": suggest_stats(profile),
        "follow_up_suggestions": [],
        "code": None,
    }


def _sanitize_follow_ups(raw: Any) -> list[dict]:
    """The model is asked for 2-4 {label, prompt} follow-up suggestions with
    every plan; this keeps a malformed or missing entry from ever reaching
    the UI as broken buttons instead of just being dropped."""
    if not isinstance(raw, list):
        return []
    out: list[dict] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        label = str(item.get("label") or "").strip()
        prompt = str(item.get("prompt") or "").strip()
        if label and prompt:
            out.append({"label": label[:80], "prompt": prompt[:300]})
        if len(out) >= 4:
            break
    return out


# A deterministic safety net for the single clearest, most common version of
# a "give me the code" style question - the same layered philosophy as
# _infer_chart_type below (the model is trusted for judgement generally, but
# a plain, unambiguous case gets a guaranteed-correct answer instead of
# depending on a free-tier model classifying it correctly every time). This
# only ever fires for requests that are clearly ABOUT code/a script; it is
# intentionally narrow so it never mistakes a real analysis request for a
# code request.
_CODE_REQUEST_RE = re.compile(
    r"\b(give|show|share|send|get|provide|export|see)\b[^.?!\n]{0,40}\b(python\s+)?(code|script)\b"
    r"|^\s*(what|which)\s+code\b"
    r"|\bcode\s+(you|it)\s+(used|ran|wrote|used to)\b"
    r"|\bas\s+(a\s+)?(python\s+)?script\b",
    re.IGNORECASE,
)
_CODE_BLOCK_RE = re.compile(r"```(?:python)?\n?(.*?)```", re.DOTALL)


def _looks_like_code_request(prompt: str) -> bool:
    return bool(_CODE_REQUEST_RE.search(prompt or ""))


# Another deterministic safety net, for the exact opposite situation: the
# person is not asking a new question at all, they are waving off whatever
# is currently on the table (a stuck clarifying question, a failed attempt,
# an old thread they no longer care about). A small/free model, given a
# short reply like "no leave it" plus several turns of unrelated history,
# can easily latch onto some earlier topic still sitting in that history and
# keep asking about IT instead of just dropping the subject - which is
# exactly the loop this exists to short-circuit. Deliberately narrow (whole
# phrase match, or substring only inside an otherwise very short message) so
# it never swallows a real request that happens to contain one of these
# words as part of a longer sentence.
_RESET_PHRASES = (
    "no leave it", "leave it", "never mind", "nevermind", "forget it", "forget that",
    "cancel", "cancel that", "scrap that", "drop it", "nvm", "start fresh", "start over",
    "reset", "never mind that", "ignore that", "skip it", "skip that", "not now", "no thanks",
)


def _looks_like_reset_request(prompt: str) -> bool:
    normalized = re.sub(r"[^a-z0-9\s]", "", (prompt or "").lower()).strip()
    normalized = re.sub(r"\s+", " ", normalized)
    if not normalized:
        return False
    if normalized in _RESET_PHRASES:
        return True
    if len(normalized.split()) <= 5:
        return any(phrase in normalized for phrase in _RESET_PHRASES)
    return False


def _extract_last_code_from_history(history: list[dict] | None) -> str | None:
    """Looks back through recent conversation history (as built by
    chat._recent_history, which embeds a "(The exact python code used for
    this: ```python ... ```)" note on any assistant turn that had one) for
    the most recent snippet - so a follow-up like "give me the python code"
    can be answered with exactly what was actually run, instead of the
    model having nothing concrete to go on and inventing a brand-new,
    unrelated analysis (which is what it was doing before this existed)."""
    for turn in reversed(history or []):
        if turn.get("role") != "assistant":
            continue
        match = _CODE_BLOCK_RE.search(turn.get("content") or "")
        if match:
            code = match.group(1).strip()
            if code:
                return code
    return None


# Matches the action-tagged code marker chat._recent_history embeds on an
# assistant turn that ran real code, e.g.:
#   (The exact python code used for this - action=analyze chart_type=heatmap: ```python ... ```)
# The chart_type token is only present for an analyze turn (a transform has
# no chart type of its own). Only rows saved after these columns were added
# carry this tag at all; older rows still carry a plain code marker (for
# the "give me the code" shortcut above) but without action=..., and are
# deliberately not matched here - see _find_repeated_prompt_code.
_REPEAT_CODE_RE = re.compile(
    r"\(The exact python code used for this - action=(\w+)(?:\s+chart_type=([^\s:]+))?:\s*```(?:python)?\n?(.*?)```\)",
    re.DOTALL,
)


def _find_repeated_prompt_code(prompt: str, history: list[dict] | None) -> tuple[str, str, str, str | None] | None:
    """Looks back through recent conversation history for an earlier
    occurrence of this EXACT SAME question (normalized for whitespace and
    case) whose reply carries an action-tagged code marker - i.e. a genuine
    analyze/transform this exact question already answered. If found,
    returns (action, narrative, code, chart_type) from that earlier turn
    (chart_type is None for a transform, or for an older row saved before
    that tag existed), so this repeat can re-run the identical code -
    and, for an analyze, redraw it with the identical chart type - instead
    of asking the model to write new code from scratch. Because the code
    would then be the literal same code, and pandas is deterministic, this
    makes "the same question against unchanged data gives the same answer"
    a guarantee of how the code runs, not just a strong likelihood based on
    the model behaving consistently."""
    if not history:
        return None
    normalized_prompt = re.sub(r"\s+", " ", (prompt or "").strip().lower())
    if not normalized_prompt:
        return None
    for i, turn in enumerate(history):
        if turn.get("role") != "user":
            continue
        turn_text = re.sub(r"\s+", " ", (turn.get("content") or "").strip().lower())
        if turn_text != normalized_prompt:
            continue
        if i + 1 >= len(history):
            continue
        reply = history[i + 1]
        if reply.get("role") != "assistant":
            continue
        match = _REPEAT_CODE_RE.search(reply.get("content") or "")
        if not match:
            continue
        action = match.group(1).strip()
        chart_type = match.group(2).strip() if match.group(2) else None
        code = match.group(3).strip()
        if action not in ("analyze", "transform") or not code:
            continue
        narrative = reply.get("content", "")[: match.start()].strip()
        return action, narrative, code, chart_type
    return None


def _infer_chart_type(prompt: str, result: Any, chart_type: str | None) -> str:
    """A deterministic safety net on top of the model own chart_type choice.
    Smaller/free models sometimes write a narrative describing one chart
    (e.g. "visualizing it with a scatter plot") while leaving the actual
    chart_type field at the generic "bar" default. This only steps in for
    that ambiguous case - chart_type missing or still "bar" - and only when
    the prompt itself gives a clear, specific signal for a better fit; it
    never overrides an explicit, deliberate choice the model already made,
    and never overrides an explicit chart_override the person picked
    themselves (that is applied by the caller before this is ever reached)."""
    if chart_type not in (None, "", "bar"):
        return chart_type
    fallback = chart_type or "bar"
    p = (prompt or "").lower()

    is_matrix = (
        isinstance(result, pd.DataFrame)
        and result.shape[0] > 1
        and result.shape[0] == result.shape[1]
        and list(result.columns) == list(result.index)
        and all(pd.api.types.is_numeric_dtype(result[c]) for c in result.columns)
    )
    two_numeric_cols = (
        isinstance(result, pd.DataFrame)
        and result.shape[1] == 2
        and all(pd.api.types.is_numeric_dtype(result[c]) for c in result.columns)
    )
    relationship_language = any(k in p for k in ("correlation", "relationship between", " vs ", " versus "))

    if relationship_language and is_matrix:
        return "heatmap"
    if relationship_language and two_numeric_cols:
        return "scatter"
    if any(k in p for k in ("distribution", "spread of", "histogram")):
        return "histogram"
    if any(k in p for k in ("trend", "over time", "time series", "month by month", "monthly", "year over year")):
        return "line"
    if any(k in p for k in ("share of", "proportion", "percentage breakdown", "% breakdown")):
        return "pie"
    if any(k in p for k in ("funnel", "conversion stage", "conversion rate by stage")):
        return "funnel"
    if any(k in p for k in ("cumulative", "waterfall", "build-up", "build up", "contribution to total")):
        return "waterfall"
    return fallback


def analyze(
    prompt: str,
    tables: dict[str, pd.DataFrame],
    history: list[dict] | None = None,
    chart_override: dict | None = None,
    intent: str | None = None,
) -> dict:
    """
    Main entrypoint. `tables` maps display name -> DataFrame for every table
    the person selected (almost always just one; more than one when they
    picked several to compare/combine in a single prompt). Returns a dict
    with: needs_clarification, clarifying_question, action, narrative,
    chart_spec, insight, cleaned_df (only for transform), rows_before/after,
    nulls_before/after, suggested_charts, suggested_stats.

    If the first attempt fails (sandbox error, wrong result shape, or an
    unrenderable chart), the model is given one retry with the exact error
    attached before any of that reaches the caller - see module docstring.
    """
    df = next(iter(tables.values()))  # the primary table - profiling/suggestions are based on this one
    profile = profile_dataframe(df)

    # A deterministic shortcut for when the person is simply waving off
    # whatever is currently pending (a stuck clarifying question, a failed
    # attempt, an old thread) - "no leave it", "start fresh", "never mind",
    # and the like. Answered with a plain, on-topic acknowledgment and
    # nothing else, without ever calling the model - so it can never drift
    # into re-asking about some unrelated leftover topic still sitting in
    # the conversation history, which is what a smaller/free model would
    # otherwise sometimes do with a short, low-content reply like this.
    if _looks_like_reset_request(prompt):
        return {
            "needs_clarification": False,
            "clarifying_question": None,
            "action": "explain",
            "narrative": "No problem, that is dropped. Let me know what you would like to look at next.",
            "chart_spec": None,
            "insight": None,
            "rows_before": None,
            "rows_after": None,
            "nulls_before": None,
            "nulls_after": None,
            "suggested_charts": suggest_charts(profile),
            "suggested_stats": suggest_stats(profile),
            "follow_up_suggestions": [],
            "code": None,
        }

    # A deterministic shortcut for the clearest, most common case this
    # covers: the person just got a result and is now asking to see the
    # code behind it (e.g. "can you give python code", "show me the
    # code"). Answered directly from what was actually run last time,
    # without even calling the model - both faster, and immune to a
    # smaller/free model misreading the question as a request for a new,
    # unrelated analysis. If there is nothing to hand back (e.g. this is
    # the very first message in the conversation), this falls through to
    # the normal model-driven flow below, which still has an
    # action="explain" rule to fall back on.
    if _looks_like_code_request(prompt):
        prior_code = _extract_last_code_from_history(history)
        if prior_code:
            narrative = (
                "Here is the exact Python code used for that result:\n\n"
                f"```python\n{prior_code}\n```"
            )
            return {
                "needs_clarification": False,
                "clarifying_question": None,
                "action": "explain",
                "narrative": narrative,
                "chart_spec": None,
                "insight": None,
                "rows_before": None,
                "rows_after": None,
                "nulls_before": None,
                "nulls_after": None,
                "suggested_charts": suggest_charts(profile),
                "suggested_stats": suggest_stats(profile),
                "follow_up_suggestions": [
                    {"label": "Explain this code", "prompt": "Explain what this code does, step by step, in plain English."},
                    {"label": "Show that result again", "prompt": "Show me that last result again."},
                ],
                "code": None,
            }

    # A deterministic shortcut for the exact same question being asked
    # again: rather than asking the model to write pandas code for it a
    # second time (which, even at low randomness, is still an AI decision
    # and not a hard guarantee of picking the identical approach), just
    # re-run the identical code that answered it last time. Pandas is
    # deterministic, so replaying the same code against the same data is
    # guaranteed to give the same number, not just very likely to. If the
    # data has changed since (a column renamed, a row count different), the
    # replay naturally reflects that - it is the code that is fixed, not a
    # cached answer. If replaying old code no longer works at all (e.g. a
    # column it used no longer exists), this quietly falls through to the
    # normal AI-planned flow below instead of surfacing an error for what
    # looks, to the person, like an entirely reasonable repeat question.
    repeat = _find_repeated_prompt_code(prompt, history)
    if repeat:
        repeat_action, repeat_narrative, repeat_code, repeat_chart_type = repeat
        replay_plan = {
            "action": repeat_action,
            "narrative": repeat_narrative or "Re-running the same analysis as before, since this is the same question against the same data.",
            # Reusing the exact chart_type from last time (when known) keeps
            # the chart visually consistent too, not just the number behind
            # it - without this, re-deriving a chart type fresh could
            # independently land on a different, still-valid choice (e.g.
            # a correlation matrix could be redrawn as a heatmap instead of
            # the scatter it was shown as before) and look like a changed
            # answer even though the math is identical.
            "chart_type": repeat_chart_type,
            "title": None,
            "x_label": None,
            "y_label": None,
            "code": repeat_code,
            "follow_up_suggestions": [],
        }
        replay_result = _execute_plan(prompt, tables, profile, replay_plan, chart_override)
        if not replay_result.get("_retry_needed"):
            return replay_result

    schema_text = _dataset_schema_text(tables)

    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    for turn in (history or [])[-6:]:
        messages.append({"role": turn["role"], "content": turn["content"]})

    user_content = f"Dataset schema:\n{schema_text}\n\nUser request: {prompt}"
    if len(tables) > 1:
        names = list(tables.keys())
        all_names = ", ".join(repr(n) for n in names)
        other_names = ", ".join(repr(n) for n in names[1:])
        user_content += (
            f"\n\nMore than one table was selected for this request: {all_names}. "
            f"They are all available in the `tables` dict by exact name (e.g. tables[{names[1]!r}]); "
            f"\"{names[0]}\" is also available as `df`. If the request implies comparing, combining, merging, "
            f"or reconciling tables, actually use {other_names} together with `df`, not just `df` alone."
        )
    hint = INTENT_HINTS.get(intent or "")
    if hint:
        user_content += f"\n\n(Context: {hint})"
    if chart_override:
        user_content += f"\n\nThe user also explicitly wants these chart customizations applied: {json.dumps(chart_override)}"
    messages.append({"role": "user", "content": user_content})

    plan = _plan_with_retry(messages)
    result = _execute_plan(prompt, tables, profile, plan, chart_override)

    if result.pop("_retry_needed", False):
        # Give the model one chance to see exactly what went wrong with its
        # own plan/code and either fix it or recognize it genuinely needs
        # more information from the person - so a shaky first attempt (a
        # coding slip, or a request that turns out to be ambiguous once it
        # is actually run) quietly recovers instead of surfacing a
        # technical failure right away.
        retry_detail = result.pop("_retry_detail", "unknown error")
        retry_messages = messages + [
            {"role": "assistant", "content": json.dumps(plan)},
            {
                "role": "user",
                "content": (
                    "Running that did not work. The error was:\n"
                    f"{retry_detail}\n\n"
                    "Please reconsider the request. If your approach had a mistake, fix it and respond "
                    "with corrected JSON (same schema as before). If you genuinely cannot tell what the "
                    "person wants without more information, respond with action=\"clarify\" and ask ONE "
                    "short, specific question instead."
                ),
            },
        ]
        try:
            fixed_plan = _plan_with_retry(retry_messages)
            result = _execute_plan(prompt, tables, profile, fixed_plan, chart_override)
        except Exception:
            pass  # keep the first attempt friendly failure message already in `result`
        result.pop("_retry_needed", None)
        result.pop("_retry_detail", None)

    return result


def _execute_plan(prompt: str, tables: dict[str, pd.DataFrame], profile: dict, plan: dict, chart_override: dict | None) -> dict:
    action = plan.get("action") or "analyze"

    if action == "clarify":
        return _no_result(
            profile,
            "",
            needs_clarification=True,
            clarifying_question=plan.get("clarifying_question") or "Could you clarify what you would like to do?",
        )

    if action == "explain":
        return _run_explain(profile, plan)

    code = plan.get("code") or ""

    if action == "transform":
        return _run_transform(prompt, tables, profile, plan, code)

    return _run_analyze(prompt, tables, profile, plan, code, chart_override)


def _run_explain(profile: dict, plan: dict) -> dict:
    """Handles action="explain": a question ABOUT the data/a prior
    result/a method/code, not a new thing to compute. No sandbox, no
    chart - its narrative IS the complete answer, exactly the way a
    knowledgeable analyst would just answer a question in words instead
    of running a fresh, unrelated analysis for it."""
    narrative = (plan.get("narrative") or "").strip()
    if not narrative:
        narrative = "I do not have anything specific to reference for that yet - could you tell me a bit more about what you would like to know?"
    return {
        "needs_clarification": False,
        "clarifying_question": None,
        "action": "explain",
        "narrative": narrative,
        "chart_spec": None,
        "insight": None,
        "rows_before": None,
        "rows_after": None,
        "nulls_before": None,
        "nulls_after": None,
        "suggested_charts": suggest_charts(profile),
        "suggested_stats": suggest_stats(profile),
        "follow_up_suggestions": _sanitize_follow_ups(plan.get("follow_up_suggestions")),
        "code": None,
    }


def _run_transform(prompt: str, tables: dict[str, pd.DataFrame], profile: dict, plan: dict, code: str) -> dict:
    cleaned, error = run_sandboxed(code, tables, timeout=settings.SANDBOX_TIMEOUT_SECONDS)

    if error:
        result = _no_result(profile, _TRANSFORM_FAILURE_NARRATIVE)
        result["action"] = "transform"
        result["_retry_needed"] = True
        result["_retry_detail"] = error.splitlines()[-1] if error else "unknown error"
        return result

    if not isinstance(cleaned, pd.DataFrame):
        result = _no_result(profile, _TRANSFORM_FAILURE_NARRATIVE)
        result["action"] = "transform"
        result["_retry_needed"] = True
        result["_retry_detail"] = "The code ran but did not assign a full table to `result`."
        return result

    # With a single table selected this is exactly the old before/after
    # comparison; with several selected, "before" reflects everything that
    # went in, since e.g. a merge or a comparison legitimately starts from
    # the combined rows across every selected table.
    rows_before = sum(len(t) for t in tables.values())
    rows_after = int(len(cleaned))
    nulls_before = sum(int(t.isna().sum().sum()) for t in tables.values())
    nulls_after = int(cleaned.isna().sum().sum())

    try:
        chart_spec = build_cleaning_summary_chart(rows_before, rows_after, nulls_before, nulls_after, title=plan.get("title") or "Before vs after")
    except Exception:
        chart_spec = None

    new_profile = profile_dataframe(cleaned)
    summary = result_to_summary(cleaned)
    # The real row count behind this result, so the insight can cite an
    # actual sample size (n) instead of leaving it unstated.
    summary["source_row_count"] = rows_after
    insight = _generate_insight(prompt, summary)

    return {
        "needs_clarification": False,
        "clarifying_question": None,
        "action": "transform",
        "narrative": plan.get("narrative") or "Data prepared.",
        "chart_spec": chart_spec,
        "insight": insight,
        "cleaned_df": cleaned,
        "rows_before": rows_before,
        "rows_after": rows_after,
        "nulls_before": nulls_before,
        "nulls_after": nulls_after,
        "suggested_charts": suggest_charts(new_profile),
        "suggested_stats": suggest_stats(new_profile),
        "follow_up_suggestions": _sanitize_follow_ups(plan.get("follow_up_suggestions")),
        "code": code,
    }


def _run_analyze(prompt: str, tables: dict[str, pd.DataFrame], profile: dict, plan: dict, code: str, chart_override: dict | None) -> dict:
    result, error = run_sandboxed(code, tables, timeout=settings.SANDBOX_TIMEOUT_SECONDS)

    if error:
        out = _no_result(profile, _ANALYZE_FAILURE_NARRATIVE)
        out["action"] = "analyze"
        out["_retry_needed"] = True
        out["_retry_detail"] = error.splitlines()[-1] if error else "unknown error"
        return out

    chart_type = (chart_override or {}).get("chart_type") or plan.get("chart_type") or "bar"
    if not (chart_override or {}).get("chart_type"):
        # Only ever corrects the model own ambiguous "bar" default toward a
        # better fit for this specific request - never overrides a chart
        # type the person explicitly picked, and never fights a deliberate,
        # specific choice the model already made.
        chart_type = _infer_chart_type(prompt, result, chart_type)
    title = (chart_override or {}).get("title") or plan.get("title") or prompt[:80]
    try:
        chart_spec = build_figure(result, chart_type, title, plan.get("x_label"), plan.get("y_label"))
    except Exception as e:
        out = _no_result(profile, _ANALYZE_FAILURE_NARRATIVE)
        out["action"] = "analyze"
        out["_retry_needed"] = True
        out["_retry_detail"] = f"Could not render the result as a {chart_type} chart: {e}"
        return out

    summary = result_to_summary(result)
    # The real row count of the table this was computed from, so the
    # insight can cite an actual sample size (n) instead of leaving it
    # unstated or, worse, the model guessing one.
    summary["source_row_count"] = int(len(next(iter(tables.values()))))
    insight = _generate_insight(prompt, summary)

    return {
        "needs_clarification": False,
        "clarifying_question": None,
        "action": "analyze",
        "narrative": plan.get("narrative") or "Here is your analysis.",
        "chart_spec": chart_spec,
        # The chart_type actually used, after any override/inference - kept
        # so an exact repeat of this same question later can reuse it and
        # stay visually consistent, not just numerically consistent.
        "chart_type": chart_type,
        "insight": insight,
        "rows_before": None,
        "rows_after": None,
        "nulls_before": None,
        "nulls_after": None,
        "suggested_charts": suggest_charts(profile),
        "suggested_stats": suggest_stats(profile),
        "follow_up_suggestions": _sanitize_follow_ups(plan.get("follow_up_suggestions")),
        "code": code,
    }


def _augment_summary_with_computed_stats(summary: dict) -> dict:
    """Pre-computes a small set of comparison statistics in Python - the
    gap between the top and bottom category, that gap expressed as
    percentage points (when the values are ratios/proportions between 0
    and 1) and as a relative percent change, plus the full ranking - and
    attaches them under summary["computed"]. This exists specifically so
    the insight-writing model is never the one doing the subtraction: a
    model composing a sentence and doing arithmetic in the same breath is
    exactly where a wrong number (e.g. writing "6.4 percentage points" for
    a gap that is actually 3.4) can slip in even when every input number it
    was given was correct. Every figure here is computed with plain Python
    arithmetic on numbers already present in the summary, so it is
    guaranteed correct; the model is only ever asked to narrate it."""
    preview = summary.get("preview") or []
    if not isinstance(preview, list) or len(preview) < 2 or len(preview) > 12:
        return summary
    first = preview[0]
    if not isinstance(first, dict):
        return summary

    numeric_col = None
    label_col = None
    for key, val in first.items():
        if numeric_col is None and isinstance(val, (int, float)) and not isinstance(val, bool):
            numeric_col = key
        elif label_col is None:
            label_col = key
    if numeric_col is None:
        return summary

    rows = []
    for r in preview:
        if not isinstance(r, dict) or numeric_col not in r:
            continue
        val = r.get(numeric_col)
        if not isinstance(val, (int, float)) or isinstance(val, bool):
            continue
        rows.append((str(r.get(label_col, "item")), float(val)))
    if len(rows) < 2:
        return summary

    ranked = sorted(rows, key=lambda x: x[1], reverse=True)
    top_label, top_val = ranked[0]
    bottom_label, bottom_val = ranked[-1]
    gap = top_val - bottom_val

    computed = {
        "ranked": [{"label": lbl, "value": round(v, 4)} for lbl, v in ranked],
        "top": {"label": top_label, "value": round(top_val, 4)},
        "bottom": {"label": bottom_label, "value": round(bottom_val, 4)},
        "gap_absolute": round(gap, 4),
    }
    if bottom_val:
        computed["gap_relative_percent"] = round(gap / bottom_val * 100, 2)
    if all(0 <= v <= 1 for _, v in rows):
        computed["gap_percentage_points"] = round(gap * 100, 2)

    summary = dict(summary)
    summary["computed"] = computed
    return summary


def _fallback_insight(summary: dict) -> str:
    """Used only if the model genuinely could not write an insight after
    every retry below (e.g. a transient provider error) - builds a plain,
    still-structured insight straight from the computed summary instead of
    a message with no real content in it. Every number here is read
    directly out of the summary (including the Python-computed "computed"
    section, when present), never invented, so it stays accurate even
    though it is simpler than what the model would normally write."""
    scalar = summary.get("scalar_result")
    if isinstance(scalar, (int, float)):
        value = round(scalar, 3)
        n = summary.get("source_row_count")
        n_text = f" (n = {n})" if isinstance(n, int) else ""
        return (
            f"**Key insight:** The computed result for this request is {value}{n_text}.\n"
            f"**Implication:** Compare this figure against what you would expect for these columns to judge "
            f"whether it is strong, weak, or typical.\n"
            f"**Next step:** Break this down further - for example by a category or over time - to see what is "
            f"driving this number."
        )
    computed = summary.get("computed") or {}
    top = computed.get("top")
    bottom = computed.get("bottom")
    if top and bottom:
        top_label = top.get("label")
        top_value = top.get("value")
        bottom_label = bottom.get("label")
        bottom_value = bottom.get("value")
        gap_points = computed.get("gap_percentage_points")
        gap_abs = computed.get("gap_absolute")
        gap_rel = computed.get("gap_relative_percent")
        gap_desc = f"{gap_points} percentage points" if gap_points is not None else f"{gap_abs}"
        relative = f" ({gap_rel}% relative)" if gap_rel is not None else ""
        return (
            f"**Key insight:** {top_label} leads at {top_value}, versus {bottom_label} at "
            f"{bottom_value} - a gap of {gap_desc}{relative}.\n"
            f"**Implication:** {top_label} is meaningfully ahead of {bottom_label} on this measure.\n"
            f"**Next step:** Look into what is different about {top_label} versus {bottom_label} to "
            f"understand what is driving this gap."
        )
    preview = summary.get("preview") or []
    if preview:
        first = preview[0]
        pairs = ", ".join(f"{k}: {v}" for k, v in list(first.items())[:4])
        return (
            f"**Key insight:** The leading result shown above is {pairs}.\n"
            f"**Implication:** This is the top figure in the breakdown you asked for.\n"
            f"**Next step:** Compare it against the rest of the results in the chart above to see how much it "
            f"stands out."
        )
    return "Insight generation is temporarily unavailable, but the result above reflects the requested analysis."


def _generate_insight(prompt: str, summary: dict) -> str:
    summary = _augment_summary_with_computed_stats(summary)
    messages = [
        {"role": "system", "content": INSIGHT_SYSTEM_PROMPT},
        {"role": "user", "content": f"The user asked: {prompt}\n\nResult data summary (JSON): {json.dumps(summary)[:4000]}"},
    ]
    # One attempt, with a generous token budget - the default free model
    # reasons before it answers, and a small budget could be used up
    # entirely by that hidden reasoning on a request with a longer/more
    # detailed prompt like this one, coming back empty and silently falling
    # back with no real numbers in it. Kept to a single try to conserve the
    # shared free daily token budget (a second attempt would nearly double
    # the worst-case cost of every insight); the rare empty response still
    # falls back to a safe, honest message below rather than an error, and
    # every failure is logged so a genuine, repeated provider problem is
    # visible in the service logs.
    for attempt in (1,):
        try:
            text = _call_llm(messages, max_tokens=1400).strip()
            if text:
                return text
        except Exception as e:
            print(f"[ai_engine] insight generation attempt {attempt} failed: {e}")
    return _fallback_insight(summary)


def _reverify_via_replan(
    prompt: str, tables: dict[str, pd.DataFrame], history: list[dict] | None, action: str, issue_detail: str
) -> dict:
    """Used by verify_answer below when a previously-shown answer needs to
    be redone from scratch - either its code no longer runs against the
    current data, or a fresh review pass found a genuine logic problem with
    it. Re-plans the request with the model from a clean slate, explicitly
    telling it what was wrong with the first attempt so it does not simply
    repeat the same mistake. This intentionally calls the model/execute
    steps directly rather than going through analyze() above, so it never
    hits the exact-repeat replay shortcut in analyze() - replaying would
    just find and reuse that very same flawed code again."""
    profile = profile_dataframe(next(iter(tables.values())))
    schema_text = _dataset_schema_text(tables)
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    for turn in (history or [])[-6:]:
        messages.append({"role": turn["role"], "content": turn["content"]})
    messages.append({
        "role": "user",
        "content": (
            f"Dataset schema:\n{schema_text}\n\nUser request: {prompt}\n\n"
            f"(A review of a previous answer to this exact request found a problem: {issue_detail} "
            "Please solve this correctly from scratch - do not repeat that mistake.)"
        ),
    })
    plan = _plan_with_retry(messages)
    result = _execute_plan(prompt, tables, profile, plan, None)
    result.pop("_retry_needed", None)
    result.pop("_retry_detail", None)

    if result.get("action") != action:
        # The corrected plan disagrees about what KIND of request this even
        # is (e.g. now thinks it should be a transform, not an analyze) -
        # too big a change to silently swap into the existing message in
        # place, so this surfaces as guidance instead of an auto-fix.
        return {
            "status": "unavailable",
            "message": (
                f"The review found that this needs a different kind of approach than before ({issue_detail}). "
                "Rather than silently swap this in place, please ask the question again as a new message so "
                "you can see the corrected approach clearly."
            ),
            "result": None,
        }

    return {
        "status": "corrected",
        "message": f"Found and corrected an issue: {issue_detail}",
        "result": result,
    }


def verify_answer(
    prompt: str,
    tables: dict[str, pd.DataFrame],
    code: str,
    action: str,
    chart_type: str | None,
    insight: str | None,
    history: list[dict] | None = None,
) -> dict:
    """Re-checks a previously computed, already-shown answer for
    correctness, on demand (the "Double-check this" action) - rather than
    the person having to trust a first pass indefinitely. Two things are
    checked: that the exact code still runs and gives the same computed
    numbers against the current data, and that a fresh, independent AI
    audit pass - given the REAL freshly-recomputed numbers, not the old
    ones - agrees the code and the insight genuinely are correct for the
    question. Returns {"status": "confirmed"|"corrected"|"unavailable",
    "message": str, "result": dict|None} - "result" (in the same shape
    _execute_plan returns) is only present for "corrected", ready for the
    caller to persist in place of the original message fields."""
    df = next(iter(tables.values()))

    result, error = run_sandboxed(code, tables, timeout=settings.SANDBOX_TIMEOUT_SECONDS)
    if error:
        detail = error.splitlines()[-1] if error else "unknown error"
        return _reverify_via_replan(
            prompt, tables, history, action,
            f"the original code no longer runs against the current data ({detail}).",
        )
    if action == "transform" and not isinstance(result, pd.DataFrame):
        return _reverify_via_replan(
            prompt, tables, history, action,
            "the code ran but did not produce a full table as a transform should.",
        )

    summary = result_to_summary(result)
    summary["source_row_count"] = int(len(result)) if action == "transform" else int(len(df))
    summary = _augment_summary_with_computed_stats(summary)

    not_applicable = "n/a"
    none_shown = "(none)"
    audit_user_content = (
        f"The user originally asked: {prompt}\n\n"
        f"The python code that was run to answer it:\n```python\n{code}\n```\n\n"
        f"The chart type used to display this (only meaningful for an analyze request): {chart_type or not_applicable}\n\n"
        f"The computed result, freshly re-run just now against the current data (JSON): "
        f"{json.dumps(summary)[:4000]}\n\n"
        f"The plain-English insight text that was shown to the user based on this result: {insight or none_shown}"
    )
    audit_messages = [
        {"role": "system", "content": VERIFY_SYSTEM_PROMPT},
        {"role": "user", "content": audit_user_content},
    ]

    # A single attempt, to conserve the shared free daily token budget (see
    # _generate_insight above for why) - the rare empty/unparseable response
    # still falls back to the safe "could not verify right now" message
    # below rather than an error, and the failure is logged.
    verdict = None
    for attempt in (1,):
        try:
            raw = _call_llm(audit_messages, max_tokens=700)
            verdict = _extract_json(raw)
            break
        except Exception as e:
            print(f"[ai_engine] verify audit attempt {attempt} failed: {e}")

    if verdict is None:
        return {
            "status": "unavailable",
            "message": (
                "Automatic verification could not be completed right now (the AI service did not respond). "
                "The original answer is unchanged - please try again in a moment."
            ),
            "result": None,
        }

    if bool(verdict.get("verified")):
        return {
            "status": "confirmed",
            "message": (
                "Verified: the code correctly computes what was asked, and every number in the insight "
                "matches the freshly recomputed result. No changes were needed."
            ),
            "result": None,
        }

    issue = (verdict.get("issue") or "").strip() or "the original approach did not correctly answer the question."
    return _reverify_via_replan(prompt, tables, history, action, issue)


def _goku_profile_text(tables: dict[str, pd.DataFrame], max_cols: int = 40) -> str:
    """Builds the real, concrete facts Goku reasons from - unlike
    _dataset_schema_text above (used by the main analysis chat, which just
    needs column names/types), this includes how much of each column is
    missing and a few real example values, so Goku can actually judge what
    a column IS (an id, an email, a price, free text) and whether the data
    looks ready to analyze - the whole point of a beginner-guidance
    assistant is grounded, specific advice, never a generic checklist.
    Capped at max_cols per table (same cap chart_suggester.profile_dataframe
    already uses elsewhere) so a very wide dataset cannot blow up the token
    cost of every single Goku message - Goku still gets the real column
    count and can ask the person to point out which specific columns
    matter, rather than silently reasoning over dozens of unshown ones."""
    blocks = []
    for name, table_df in tables.items():
        total = len(table_df)
        all_cols = list(table_df.columns)
        shown_cols = all_cols[:max_cols]
        lines = [f"Table \"{name}\": {total} rows, {len(all_cols)} columns."]
        for col in shown_cols:
            series = table_df[col]
            nulls = int(series.isna().sum())
            null_pct = round(nulls / total * 100, 1) if total else 0.0
            sample_values = series.dropna().astype(str).unique()[:3].tolist()
            sample_text = ", ".join(sample_values) if sample_values else "(no non-empty values)"
            lines.append(
                f"  - {col} ({series.dtype}): {nulls} missing ({null_pct}%). Example values: {sample_text}"
            )
        if len(all_cols) > max_cols:
            lines.append(
                f"  (...and {len(all_cols) - max_cols} more columns not shown here - ask the person which "
                "ones matter most if you need to reason about them.)"
            )
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks)


def goku_chat(
    user_message: str,
    tables: dict[str, pd.DataFrame],
    goku_history: list[dict] | None,
    main_chat_history: list[dict] | None,
) -> dict:
    """Goku: the guided, beginner-friendly helper that lives only in the
    Workspace page (see routers/goku.py). Unlike the main analysis chat,
    Goku never runs code or computes anything itself - it only reasons
    over a real profile of the currently selected data (columns, types,
    missing values, example values) plus its own recent conversation and -
    when available - what has already happened in the person main
    analysis chat, so it can give concrete, grounded, step-by-step
    guidance instead of generic advice. Returns {"reply": str,
    "action_prompts": [{"label": str, "prompt": str}, ...]}."""
    profile_text = _goku_profile_text(tables)

    messages = [{"role": "system", "content": GOKU_SYSTEM_PROMPT}]
    for turn in (goku_history or [])[-12:]:
        messages.append({"role": turn["role"], "content": turn["content"]})

    context_parts = [f"Current data profile:\n{profile_text}"]
    if main_chat_history:
        chat_lines = []
        for turn in main_chat_history[-10:]:
            speaker = "Person" if turn["role"] == "user" else "Main analysis chat"
            turn_content = turn["content"]
            chat_lines.append(f"{speaker}: {turn_content}")
        context_parts.append("Recent activity in the main analysis chat:\n" + "\n".join(chat_lines))
    else:
        context_parts.append("The person has not asked the main analysis chat anything yet.")
    context_parts.append(f"The person just said to you, Goku: {user_message}")

    messages.append({"role": "user", "content": "\n\n".join(context_parts)})

    # Goku uses settings.GOKU_MODEL rather than the default GROQ_MODEL - a
    # separate model on the Groq free tier means a separate daily token
    # budget, so Goku no longer competes with the main analysis chat,
    # Double-check, and insight-writing for the same shared budget. A
    # single attempt (not two) conserves that budget further; the rare
    # empty/unparseable response still falls back to a friendly message
    # below rather than an error, and the failure is logged.
    parsed = None
    for attempt in (1,):
        try:
            raw = _call_llm(messages, max_tokens=900, model_override=settings.GOKU_MODEL)
            parsed = _extract_json(raw)
            break
        except Exception as e:
            print(f"[ai_engine] goku_chat attempt {attempt} failed: {e}")

    if parsed is None:
        return {
            "reply": (
                "I am having trouble reaching the AI service right now - please try asking again in a moment."
            ),
            "action_prompts": [],
        }

    reply = (parsed.get("reply") or "").strip() or "Could you tell me a bit more about what you would like to do with this data?"
    action_prompts = _sanitize_follow_ups(parsed.get("action_prompts"))
    return {"reply": reply, "action_prompts": action_prompts}
