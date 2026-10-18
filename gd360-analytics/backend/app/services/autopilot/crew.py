"""2026-10-17 (R53): the Autopilot crew - nine agents, what each does on its own (within the policy) and what it asks
a person first. The activity counts come from agent_actions, so the page shows what really happened."""
from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import func
from sqlalchemy.orm import Session

from ... import models

CREW = [
    {"key": "Planner", "does": "Turns a brief into a plan from your business brain, past initiatives and the industry pack.",
     "alone": ["Drafts plans and targets, each number with its source or marked as an assumption"],
     "asks": ["Anything that commits budget, people or dates"]},
    {"key": "Tracker", "does": "Writes the tracking contract and gathers evidence: posts, ad spend, UTM sessions, deals, registrations.",
     "alone": ["Attaches evidence matched at 90% or more", "Closes tasks when their evidence arrives"],
     "asks": ["Matches under 90% go to your review queue"]},
    {"key": "Matcher", "does": "Reads pictures and words to find posts about an initiative that carry no tag.",
     "alone": ["Checks banners and logos in images"], "asks": ["Every image match under 90%"]},
    {"key": "Pacer", "does": "Snapshots every target daily and forecasts the end value with odds.",
     "alone": ["Forecasts and warns when a target falls behind"], "asks": ["Nothing: it only reads"]},
    {"key": "Mixer", "does": "Fits a response curve per paid channel and finds where the next unit of budget does the most.",
     "alone": ["Proposes a budget move with its expected effect"], "asks": ["Every budget move (cap per move in the policy)"]},
    {"key": "Demand", "does": "Before an event: who will really come, who to confirm, whether to overbook.",
     "alone": ["Sends reminders on the schedule"], "asks": ["New emails to attendees"]},
    {"key": "Ops", "does": "On the day: arrivals against the plan, queues, rooms, the stream.",
     "alone": ["Raises alerts"], "asks": ["Anything sent to attendees"]},
    {"key": "Follow-up", "does": "After: surveys, sponsor reports, meeting follow-ups, the morning digest.",
     "alone": ["Sends the digest you subscribed to"], "asks": ["Emails to attendees or sponsors"]},
    {"key": "Prover", "does": "Proof: lift against what would have happened anyway, pipeline from the CRM, the board report.",
     "alone": ["Writes the report and the learnings draft"], "asks": ["Publishing the report or learnings"]},
]


def crew(db: Session, workspace_id: str | None) -> list[dict]:
    since = datetime.utcnow() - timedelta(days=30)
    counts: dict[tuple, int] = {}
    if workspace_id:
        for agent, state, auto, n in (db.query(models.AgentAction.agent, models.AgentAction.state, models.AgentAction.auto, func.count())
                                      .filter(models.AgentAction.workspace_id == workspace_id, models.AgentAction.created_at >= since)
                                      .group_by(models.AgentAction.agent, models.AgentAction.state, models.AgentAction.auto)):
            counts[(agent, state, bool(auto))] = n
    out = []
    for a in CREW:
        k = a["key"]
        done_alone = sum(n for (ag, st, au), n in counts.items() if ag == k and au and st in ("done", "undone"))
        asked = sum(n for (ag, st, au), n in counts.items() if ag == k and not au)
        undone = sum(n for (ag, st, au), n in counts.items() if ag == k and st == "undone")
        out.append({**a, "last_30_days": {"done_alone": done_alone, "asked": asked, "undone": undone}})
    return out
