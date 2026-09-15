"""
The AI copilot. Responsible for:
  1. Turning a natural-language prompt + dataset profile into a structured
     plan (either a clarifying question, or pandas code + chart choice).
  2. Calling the sandbox to execute that code safely.
  3. Building the chart.
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
from .chart_builder import build_figure, result_to_summary
from .chart_suggester import profile_dataframe, suggest_charts, suggest_stats
from .sandbox import run_sandboxed

settings = get_settings()

SYSTEM_PROMPT = """You are GD360, an expert data analyst copilot embedded in a no-code analytics product.
You are given a pandas DataFrame called `df` (already loaded - never re-load or fabricate data) and a user's
natural-language request. You must respond with ONLY a single JSON object (no markdown fences, no prose
outside the JSON) matching exactly this schema:

{
  "action": "clarify" | "analyze",
  "clarifying_question": string | null,   // required if action == "clarify", else null
  "narrative": string,                     // 1-2 plain-English sentences describing what you're about to do (empty if clarifying)
  "chart_type": "bar"|"line"|"area"|"pie"|"scatter"|"histogram"|"box"|"heatmap"|"waterfall"|"funnel"|"treemap"|null,
  "title": string | null,
  "x_label": string | null,
  "y_label": string | null,
  "code": string | null   // python using pandas (pd), numpy (np), scipy.stats (stats), and `df`.
                            // MUST assign the final chart-ready data to a variable named `result`
                            // (a pandas Series or a 2-column-or-fewer DataFrame, or a square numeric
                            // DataFrame for chart_type "heatmap"). No imports, no file/network access,
                            // no printing needed. Keep it simple and robust to NaNs.
}

Rules:
- If the request is ambiguous or you genuinely need more info to proceed (e.g. which column, which time range,
  which metric), set action="clarify" and ask ONE short, specific question. Otherwise set action="analyze".
- Never invent columns that are not in the schema you were given.
- Prefer simple, correct pandas over clever one-liners.
- Choose the chart type that best fits the data and the statistical intent (e.g. use "waterfall" for
  sequential contributions to a total, "heatmap" for correlation matrices, "histogram" for distributions).
- Respond with raw JSON only.
"""

INSIGHT_SYSTEM_PROMPT = """You are GD360's insight-writing module. Given a summary of a chart's underlying
data and the user's original question, write a crisp business insight: 2-4 sentences, plain English, no
fluff, lead with the single most important takeaway, include a concrete number where possible, and end with
one practical suggestion or thing to investigate next. Do not describe the chart mechanics ("this bar chart
shows..."); talk about what the data means."""


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
            headers={"Authorization": f"Bearer {settings.GROQ_API_KEY}"},
            json={"model": settings.GROQ_MODEL, "messages": messages, "temperature": 0.2, "max_tokens": max_tokens},
            timeout=60,
        )
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"]

    if provider == "openai":
        if not settings.OPENAI_API_KEY:
            raise RuntimeError("OPENAI_API_KEY is not set.")
        resp = requests.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {settings.OPENAI_API_KEY}"},
            json={"model": settings.OPENAI_MODEL, "messages": messages, "temperature": 0.2, "max_tokens": max_tokens},
            timeout=60,
        )
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"]

    if provider == "anthropic":
        if not settings.ANTHROPIC_API_KEY:
            raise RuntimeError("ANTHROPIC_API_KEY is not set.")
        system = next((m["content"] for m in messages if m["role"] == "system"), "")
        user_msgs = [m for m in messages if m["role"] != "system"]
        resp = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": settings.ANTHROPIC_API_KEY,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={"model": settings.ANTHROPIC_MODEL, "system": system, "messages": user_msgs, "max_tokens": max_tokens},
            timeout=60,
        )
        resp.raise_for_status()
        return resp.json()["content"][0]["text"]

    raise RuntimeError(f"Unknown AI_PROVIDER: {provider}")


def _dataset_schema_text(df: pd.DataFrame) -> str:
    lines = []
    for col in df.columns:
        lines.append(f"- {col} ({df[col].dtype})")
    return "\n".join(lines)


def analyze(prompt: str, df: pd.DataFrame, history: list[dict] | None = None, chart_override: dict | None = None) -> dict:
    """
    Main entrypoint. Returns a dict with: needs_clarification, clarifying_question,
    narrative, chart_spec, insight, suggested_charts, suggested_stats, error.
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
    if chart_override:
        user_content += f"\n\nThe user also explicitly wants these chart customizations applied: {json.dumps(chart_override)}"
    messages.append({"role": "user", "content": user_content})

    raw = _call_llm(messages)
    plan = _extract_json(raw)

    if plan.get("action") == "clarify":
        return {
            "needs_clarification": True,
            "clarifying_question": plan.get("clarifying_question") or "Could you clarify what you'd like to analyze?",
            "narrative": "",
            "chart_spec": None,
            "insight": None,
            "suggested_charts": suggest_charts(profile),
            "suggested_stats": suggest_stats(profile),
        }

    code = plan.get("code") or ""
    result, error = run_sandboxed(code, df, timeout=settings.SANDBOX_TIMEOUT_SECONDS)

    if error:
        return {
            "needs_clarification": False,
            "clarifying_question": None,
            "narrative": f"I ran into an issue while analyzing this: {error.splitlines()[-1] if error else 'unknown error'}. "
                         f"Could you rephrase or simplify the request?",
            "chart_spec": None,
            "insight": None,
            "suggested_charts": suggest_charts(profile),
            "suggested_stats": suggest_stats(profile),
        }

    chart_type = (chart_override or {}).get("chart_type") or plan.get("chart_type") or "bar"
    title = (chart_override or {}).get("title") or plan.get("title") or prompt[:80]
    try:
        chart_spec = build_figure(result, chart_type, title, plan.get("x_label"), plan.get("y_label"))
    except Exception as e:
        return {
            "needs_clarification": False,
            "clarifying_question": None,
            "narrative": f"The analysis ran, but I couldn't render that as a {chart_type} chart ({e}). Try asking for a different chart type.",
            "chart_spec": None,
            "insight": None,
            "suggested_charts": suggest_charts(profile),
            "suggested_stats": suggest_stats(profile),
        }

    summary = result_to_summary(result)
    insight = _generate_insight(prompt, summary)

    return {
        "needs_clarification": False,
        "clarifying_question": None,
        "narrative": plan.get("narrative") or "Here's your analysis.",
        "chart_spec": chart_spec,
        "insight": insight,
        "suggested_charts": suggest_charts(profile),
        "suggested_stats": suggest_stats(profile),
    }


def _generate_insight(prompt: str, summary: dict) -> str:
    try:
        messages = [
            {"role": "system", "content": INSIGHT_SYSTEM_PROMPT},
            {"role": "user", "content": f"User's question: {prompt}\n\nResult data summary (JSON): {json.dumps(summary)[:4000]}"},
        ]
        return _call_llm(messages, max_tokens=300).strip()
    except Exception:
        return "Insight generation is temporarily unavailable, but your chart above reflects the requested analysis."
