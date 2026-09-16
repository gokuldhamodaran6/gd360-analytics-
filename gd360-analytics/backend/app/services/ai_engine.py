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
  "action": "clarify" | "transform" | "analyze",
  "clarifying_question": string | null,   // required if action == "clarify", else null
  "narrative": string,                     // 1-2 plain-English sentences describing what you are about to do (empty if clarifying)
  "chart_type": "bar"|"line"|"area"|"pie"|"scatter"|"histogram"|"box"|"heatmap"|"waterfall"|"funnel"|"treemap"|null,
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
  which metric, what to do with missing values), set action="clarify" and ask ONE short, specific question.
- Do exactly what was asked - never silently substitute a different analysis than the one requested. If the
  request names a specific method (e.g. "Pearson correlation", "median", "year-over-year"), use exactly that
  method; only pick the method yourself when the request is generic (e.g. "correlation", "average").
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
  for the request - not as a fallback.
- Always populate follow_up_suggestions (see schema above) with specific, non-generic next steps tied to what
  you just did, the way a senior data analyst would proactively suggest the next useful angle.
- When more than one table is selected, actually use all of them if the request implies it (e.g. "compare",
  "combine", "merge", "what changed between", "join") - use pd.merge/pd.concat/explicit comparisons on the
  named tables rather than only looking at `df`. If the request does not need more than one table, it is fine
  to only use `df`.
- Respond with raw JSON only.
"""

INSIGHT_SYSTEM_PROMPT = """You are the GD360 insight-writing module. Given a summary of a chart underlying
data and the user original question, write a crisp business insight: 2-4 sentences, plain English, no
fluff, lead with the single most important takeaway, include a concrete number where possible, and end with
one practical suggestion or thing to investigate next. Do not describe the chart mechanics ("this bar chart
shows..."); talk about what the data means."""

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


def _call_llm(messages: list[dict], max_tokens: int = 3000) -> str:
    provider = settings.AI_PROVIDER

    if provider == "groq":
        if not settings.GROQ_API_KEY:
            raise RuntimeError("GROQ_API_KEY is not set. Get a free key at https://console.groq.com/keys")
        payload = {
            "model": settings.GROQ_MODEL,
            "messages": messages,
            "temperature": 0.2,
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
        model_lower = settings.GROQ_MODEL.lower()
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
            json={"model": settings.OPENAI_MODEL, "messages": messages, "temperature": 0.2, "max_tokens": max_tokens},
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
            json={"model": settings.ANTHROPIC_MODEL, "system": system, "messages": user_msgs, "max_tokens": max_tokens},
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

    code = plan.get("code") or ""

    if action == "transform":
        return _run_transform(prompt, tables, profile, plan, code)

    return _run_analyze(prompt, tables, profile, plan, code, chart_override)


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
    insight = _generate_insight(prompt, summary)

    return {
        "needs_clarification": False,
        "clarifying_question": None,
        "action": "analyze",
        "narrative": plan.get("narrative") or "Here is your analysis.",
        "chart_spec": chart_spec,
        "insight": insight,
        "rows_before": None,
        "rows_after": None,
        "nulls_before": None,
        "nulls_after": None,
        "suggested_charts": suggest_charts(profile),
        "suggested_stats": suggest_stats(profile),
        "follow_up_suggestions": _sanitize_follow_ups(plan.get("follow_up_suggestions")),
    }


def _generate_insight(prompt: str, summary: dict) -> str:
    try:
        messages = [
            {"role": "system", "content": INSIGHT_SYSTEM_PROMPT},
            {"role": "user", "content": f"The user asked: {prompt}\n\nResult data summary (JSON): {json.dumps(summary)[:4000]}"},
        ]
        return _call_llm(messages, max_tokens=600).strip()
    except Exception:
        return "Insight generation is temporarily unavailable, but the result above reflects the requested analysis."
