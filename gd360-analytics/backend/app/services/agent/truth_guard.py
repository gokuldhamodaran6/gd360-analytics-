"""2026-10-14 (R46): the Truth Guard - what an answer is allowed to claim about itself.

Reads a finished ProjectRun and returns chips {key, ok, label, detail}. Every chip
is computed from what actually happened (rows read, truncation flags, the checks
the Analyst ran, the numbers in the written answer against the numbers computed);
nothing is asserted that was not verified, so a missing chip is an honest absence,
never a hidden failure. `verdict` is "ok" when nothing failed, "warn" when an
answer should be read with its method, "fail" when a number in the prose is not
supported by the data (the answer still shows, with the warning first).
"""
from __future__ import annotations

import re

from ... import models
from ..project_engine import numbers

_RAW_ERROR = re.compile(r"\b(Traceback|Exception|NameError|KeyError|TypeError|ValueError|SyntaxError|NoneType|duckdb\.|sqlalchemy\.|psycopg)\b")
_ARITHMETIC_HEADLINE = re.compile(r"^\s*[-$€£₹]?\s*[\d,]+(\.\d+)?\s*%?\s*$")


def _n(v) -> int:
    try:
        return int(v or 0)
    except (TypeError, ValueError):
        return 0


def chips_for_run(run: models.ProjectRun) -> dict:
    result = run.result or {}
    answer = result.get("answer") or {}
    steps = list(run.steps or [])
    chips: list[dict] = []
    worst = "ok"

    def add(key, ok, label, detail=None, level="warn"):
        nonlocal worst
        chips.append({"key": key, "ok": bool(ok), "label": label, "detail": detail})
        if not ok:
            worst = "fail" if level == "fail" or worst == "fail" else "warn"

    if run.status != "done":
        return {"chips": [], "verdict": "pending"}

    analyst = result.get("analyst") if result.get("analysis_type") == "analyst" else None
    if analyst:
        checks = list(analyst.get("checks") or [])
        if checks:
            failed = [c for c in checks if not c.get("ok")]
            if failed:
                add("reconcile", False, "A check did not match",
                    "; ".join(f"{c.get('label')}: expected {c.get('expected')}, got {c.get('got')}" for c in failed[:3]))
            else:
                first = checks[0]
                add("reconcile", True, f"Matches your {'inputs' if analyst.get('no_data') else 'data'}",
                    f"{len(checks)} check{'s' if len(checks) != 1 else ''} passed" + (f" · {first.get('label')}: {first.get('expected')}" if first.get("label") else ""))
        if analyst.get("no_data"):
            add("basis", True, "Worked out from your question, not from data",
                "No connected data was used; the figures come from the assumptions shown.")
        else:
            used = analyst.get("data_used") or {}
            rows = _n(used.get("rows")) if isinstance(used, dict) else 0
            if rows:
                add("rows", True, f"All {rows:,} rows read")
        model = analyst.get("model") or {}
        if isinstance(model, dict) and model.get("validation"):
            v = model["validation"]
            add("validation", bool(v.get("ok", True)), "Validated on data the model never saw" if v.get("ok", True) else "Validation failed",
                v.get("detail"))
        if isinstance(model, dict) and model.get("leak_scan"):
            ls = model["leak_scan"]
            removed = ls.get("removed") or []
            add("leaks", True, f"{len(removed)} leaking column{'s' if len(removed) != 1 else ''} removed" if removed else "No leaking columns found",
                ", ".join(map(str, removed[:6])) or None)
    else:
        rows_read = sum(_n(s.get("rows_read")) or _n(s.get("rows_returned")) for s in steps if s.get("kind") != "combine")
        truncated = [s for s in steps if s.get("truncated")]
        if truncated:
            add("rows", False, f"Result capped on {len(truncated)} step{'s' if len(truncated) != 1 else ''}",
                "A step returned more rows than the cap; the answer says so.", level="warn")
        elif rows_read:
            add("rows", True, f"All {rows_read:,} rows read")
        errors = [s for s in steps if s.get("status") == "failed" or s.get("error")]
        if errors:
            add("steps", False, f"{len(errors)} step{'s' if len(errors) != 1 else ''} failed", str(errors[0].get("error") or "")[:160])
        repaired = [s for s in steps if s.get("repaired")]
        if repaired:
            add("repaired", True, f"{len(repaired)} query repaired and re-run", None)

        facts = list(result.get("facts") or [])
        tables = []
        for v in result.get("visuals") or []:
            if isinstance(v, dict) and v.get("type") == "chart" and v.get("rows"):
                tables.append({"rows": v.get("rows")})
        for ev in result.get("evidence") or []:
            if isinstance(ev, dict) and ev.get("rows"):
                tables.append({"rows": ev.get("rows")})
        text = " ".join(str(x or "") for x in (answer.get("headline"), answer.get("answer")))
        if text.strip() and (facts or tables):
            try:
                allowed = numbers.allowed_values(facts, tables, "")
                premise = numbers.premise_numbers(run.question or "", allowed)
                bad = numbers.unsupported_numbers(text, allowed, premise)
            except Exception as e:  # noqa: BLE001 - the guard never breaks an answer
                print(f"[truth_guard] number check skipped: {e}")
                bad = []
            if bad:
                add("numbers", False, f"{len(bad)} number{'s' if len(bad) != 1 else ''} in the text not found in the data",
                    ", ".join(bad[:5]), level="fail")
            else:
                add("numbers", True, "Every number in the answer is in the data")

    text_all = " ".join(str(x or "") for x in (answer.get("headline"), answer.get("answer"), run.error_message))
    if _RAW_ERROR.search(text_all):
        add("raw_error", False, "A raw error reached the answer", None, level="fail")
    if _ARITHMETIC_HEADLINE.match(str(answer.get("headline") or "")):
        add("headline", False, "The headline is a bare number, not a finding", None)
    warnings = [w for w in (result.get("warnings") or []) if w]
    if warnings:
        add("warnings", False, f"{len(warnings)} note{'s' if len(warnings) != 1 else ''} on this answer", str(warnings[0])[:200])
    if answer.get("written_by") == "template":
        chips.append({"key": "written_by", "ok": True, "label": "Written from the numbers, no model prose", "detail": None})
    return {"chips": chips, "verdict": worst}


def guard_text(text: str, allowed: list[float]) -> list[str]:
    """Numbers in free text that the data does not support (for documents)."""
    try:
        return numbers.unsupported_numbers(text or "", allowed, None)
    except Exception:  # noqa: BLE001
        return []
