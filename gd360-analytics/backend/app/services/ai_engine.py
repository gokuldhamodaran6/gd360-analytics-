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
You are given a pandas DataFrame called `df` (already loaded - never re-load or fabricate data) and the user
natural-language request. You must respond with ONLY a single JSON object (no markdown fences, no prose
outside the JSON) matching exactly this schema:

{
  "action": "clarify" | "transform" | "analyze",
  "clarifying_question": string | null,   // required if action == "clarify", else null
  "narrative": string,                     // 1-2 plain-English sentences describing what you are about to do (empty if clarifying)
  "chart_type": "bar"|"line"|"area"|"pie"|"scatter"|"histogram"|"box"|"heatmap"|"waterfall"|"funnel"|"treemap"|null,
  "title": string | null,
  "x_label": string | null,
  "y_label": string | null,
  "code": string | null   // python using pandas (pd), numpy (np), scipy.stats (stats), and `df`.
                            // No imports, no file/network access, no printing needed. Keep it simple and
                            // robust to NaNs.
                            //
                            // If action == "transform": the request is about cleaning, preparing, fixing,
                            // filtering, deduplicating, standardizing types, handling missing values, or
                            // removing outliers from the data ITSELF. The code MUST assign the FULL
                            // cleaned/prepared table to `result` as a pandas DataFrame with the same general
                            // row/column meaning as `df` (not reduced to a chart-ready summary). Never drop
                            // columns the user did not ask you to drop.
                            //
                            // If action == "analyze": the request is about exploring, summarizing,
                            // visualizing, finding patterns in, or categorizing the data for a chart/insight.
                            // The code MUST assign the final chart-ready data to `result` (a pandas Series or
                            // a 2-column-or-fewer DataFrame, or a square numeric DataFrame for chart_type
                            // "heatmap").
}

Rules:
- If the request is ambiguous or you genuinely need more info to proceed (e.g. which column, which time range,
  which metric, what to do with missing values), set action="clarify" and ask ONE short, specific question.
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
- Choose the chart type that best fits the data and the statistical intent (e.g. use "waterfall" for
  sequential contributions to a total, "heatmap" for correlation matrices, "histogram" for distributions).
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


def _extract_json(text: str) -> dict:
    text = text.strip()
    text = re.sub(r"^```(json)?|```$", "", text, flags=re.MULTILINE).strip()
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        raise ValueError(f"Model did not return JSON: {text[:300]}")
    return json.loads(match.group(0))


def _call_llm(messages: list[dict], max_tokens: int = 1200) -> str:
    provider = settings.AI_PROVIDER

    if provider == "groq":
        if not settings.GROQ_API_KEY:
            raise RuntimeError("GROQ_API_KEY is not set. Get a free key at https://console.groq.com/keys")
        resp = requests.post(
            "https://api.groq.com/openai/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {settings.GROQ_API_KEY.strip()}",
                "Content-Type": "application/json",
            },
            json={"model": settings.GROQ_MODEL, "messages": messages, "temperature": 0.2, "max_tokens": max_tokens},
            timeout=60,
        )
        _raise_with_body(resp, "Groq")
        return resp.json()["choices"][0]["message"]["content"]

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


def _dataset_schema_text(df: pd.DataFrame) -> str:
    lines = []
    for col in df.columns:
        lines.append(f"- {col} ({df[col].dtype})")
    return "\n".join(lines)


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
    }


def analyze(
    prompt: str,
    df: pd.DataFrame,
    history: list[dict] | None = None,
    chart_override: dict | None = None,
    intent: str | None = None,
) -> dict:
    """
    Main entrypoint. Returns a dict with: needs_clarification, clarifying_question,
    action, narrative, chart_spec, insight, cleaned_df (only for transform),
    rows_before/after, nulls_before/after, suggested_charts, suggested_stats.
    """
    profile = profile_dataframe(df)
    schema_text = _dataset_schema_text(df)

    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    for turn in (history or [])[-6:]:
        messages.append({"role": turn["role"], "content": turn["content"]})

    user_content = (
        f"Dataset schema ({len(df)} rows):\n{schema_text}\n\n"
        f"User request: {prompt}"
    )
    hint = INTENT_HINTS.get(intent or "")
    if hint:
        user_content += f"\n\n(Context: {hint})"
    if chart_override:
        user_content += f"\n\nThe user also explicitly wants these chart customizations applied: {json.dumps(chart_override)}"
    messages.append({"role": "user", "content": user_content})

    raw = _call_llm(messages)
    plan = _extract_json(raw)
    action = plan.get("action") or "analyze"

    if action == "clarify":
        result = _no_result(
            profile,
            "",
            needs_clarification=True,
            clarifying_question=plan.get("clarifying_question") or "Could you clarify what you would like to do?",
        )
        return result

    code = plan.get("code") or ""

    if action == "transform":
        return _run_transform(prompt, df, profile, plan, code)

    return _run_analyze(prompt, df, profile, plan, code, chart_override)


def _run_transform(prompt: str, df: pd.DataFrame, profile: dict, plan: dict, code: str) -> dict:
    cleaned, error = run_sandboxed(code, df, timeout=settings.SANDBOX_TIMEOUT_SECONDS)

    if error:
        error_line = error.splitlines()[-1] if error else "unknown error"
        result = _no_result(profile, f"I ran into an issue while preparing this data: {error_line}. Could you rephrase or simplify the request?")
        result["action"] = "transform"
        return result

    if not isinstance(cleaned, pd.DataFrame):
        result = _no_result(profile, "That did not produce a full table, so I could not save it as a cleaned version. Could you rephrase the request?")
        result["action"] = "transform"
        return result

    rows_before, rows_after = int(len(df)), int(len(cleaned))
    nulls_before, nulls_after = int(df.isna().sum().sum()), int(cleaned.isna().sum().sum())

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
    }


def _run_analyze(prompt: str, df: pd.DataFrame, profile: dict, plan: dict, code: str, chart_override: dict | None) -> dict:
    result, error = run_sandboxed(code, df, timeout=settings.SANDBOX_TIMEOUT_SECONDS)

    if error:
        error_line = error.splitlines()[-1] if error else "unknown error"
        out = _no_result(profile, f"I ran into an issue while analyzing this: {error_line}. Could you rephrase or simplify the request?")
        out["action"] = "analyze"
        return out

    chart_type = (chart_override or {}).get("chart_type") or plan.get("chart_type") or "bar"
    title = (chart_override or {}).get("title") or plan.get("title") or prompt[:80]
    try:
        chart_spec = build_figure(result, chart_type, title, plan.get("x_label"), plan.get("y_label"))
    except Exception as e:
        out = _no_result(profile, f"The analysis ran, but I could not render that as a {chart_type} chart ({e}). Try asking for a different chart type.")
        out["action"] = "analyze"
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
    }


def _generate_insight(prompt: str, summary: dict) -> str:
    try:
        messages = [
            {"role": "system", "content": INSIGHT_SYSTEM_PROMPT},
            {"role": "user", "content": f"The user asked: {prompt}\n\nResult data summary (JSON): {json.dumps(summary)[:4000]}"},
        ]
        return _call_llm(messages, max_tokens=300).strip()
    except Exception:
        return "Insight generation is temporarily unavailable, but the result above reflects the requested analysis."
