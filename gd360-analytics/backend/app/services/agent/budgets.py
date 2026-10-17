"""2026-10-17 (R52): time budgets for every kind of answer.

The target is what a person should expect ("a data answer in under a minute"); the page says when a turn runs past
it, while it is still working and after. The hard stop (three times the target, never under 90 s) ends a turn that is
stuck: the turn fails with a plain sentence and a way to try again, and a result that arrives after that is dropped
rather than quietly replacing the failure.

Targets from the 3.0 plan: data < 60 s, analysis < 120 s, dashboard (first page on screen) < 20 s, document < 40 s.
"""
from __future__ import annotations

TARGETS: dict[str, int] = {
    "data": 60, "guided": 60, "analysis": 120, "dashboard": 20, "document": 40,
    "knowledge": 30, "dashboard_edit": 20, "document_edit": 20, "list": 20, "whatif": 10,
    "automation": 20, "team": 20, "chat": 15, "explain": 20, "check": 20,
}
# trained in the background on its own page; the turn only reports progress
NO_HARD_STOP = {"model", "guided"}


def budget(kind: str | None) -> int | None:
    return TARGETS.get(kind or "")


def hard(kind: str | None) -> int | None:
    if (kind or "") in NO_HARD_STOP:
        return None
    t = budget(kind)
    return max(90, 3 * t) if t else 180


def words(seconds: int | float) -> str:
    s = int(round(seconds))
    if s < 90:
        return f"{s} seconds"
    m = s / 60
    return f"{m:.0f} minutes" if abs(m - round(m)) < 0.05 else f"{m:.1f} minutes"


def timeout_text(kind: str | None) -> str:
    h, t = hard(kind) or 180, budget(kind) or 60
    what = {"data": "this answer", "analysis": "this analysis", "dashboard": "this dashboard", "document": "this document",
            "knowledge": "this answer", "list": "this list"}.get(kind or "", "this")
    return (f"I stopped after {words(h)}: {what} usually takes under {words(t)}, so something is stuck. "
            "Ask again, or narrow it down (one table, one time period).")


def over(kind: str | None, seconds: float | None) -> bool:
    t = budget(kind)
    return bool(t and seconds is not None and seconds > t)
