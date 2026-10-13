"""The expectation contract and the Event Success Score.

A goal has an agreed range: `low` is the bad end and `high` the good end
(for a goal where lower is better, like cost per attendee, low is the
larger number). Its score is 0 at the bad end, 70 exactly on target and
100 at the good end, straight lines in between, held at 0 and 100 beyond.

The event score is the weighted average over goals that have a number.
Confidence is the share of that weight backed by counted, matched or
tested numbers (not reported or modelled ones). A missed safety goal caps
the event score at 60."""
from __future__ import annotations

from .ctx import METRICS, Ctx

BACKED = ("counted", "matched", "tested")


def goal_score(actual: float | None, low: float, target: float, high: float) -> float | None:
    if actual is None:
        return None
    d = 1.0 if high >= low else -1.0
    x, w, t, b = actual * d, low * d, target * d, high * d
    if t < w:
        t = w
    if b < t:
        b = t
    if x <= w:
        return 0.0
    if x <= t:
        return 70.0 * (x - w) / (t - w) if t > w else 70.0
    if x <= b:
        return 70.0 + 30.0 * (x - t) / (b - t) if b > t else 100.0
    return 100.0


def metric_meta(key: str) -> dict:
    m = METRICS.get(key)
    if not m:
        return {"label": key.replace("_", " ").capitalize(), "unit": "count", "truth": "reported", "phase": "after", "higher": True}
    return {"label": m[0], "unit": m[1], "truth": m[2], "phase": m[3], "higher": m[4]}


def goal_actual(ctx: Ctx, g) -> tuple[float | None, str]:
    if g.metric == "custom" or g.metric not in METRICS:
        return g.actual_typed, "reported"
    v = ctx.values().get(g.metric)
    if v is None and g.actual_typed is not None:
        return g.actual_typed, "reported"
    return v, metric_meta(g.metric)["truth"]


RANK = {"before": 0, "during": 1, "after": 2, "done": 3}


def availability(ctx: Ctx, metric: str) -> tuple[bool, bool]:
    """-> (has a number yet, the number is final). A goal measured on the
    event day has no number before it; one measured after (pipeline, NPS,
    cost per attendee) keeps moving until the after window closes."""
    now = RANK.get(ctx.w.now_phase(ctx.now), 0)
    ph = metric_meta(metric)["phase"]
    if metric == "custom" or metric not in METRICS:
        return True, now >= 2
    start = {"before": 0, "during": 1, "after": 2, "all": 1}.get(ph, 0)
    final_at = {"before": 1, "during": 2, "after": 3, "all": 3}.get(ph, 3)
    return now >= start, now >= final_at


def contract(ctx: Ctx) -> list[dict]:
    out = []
    for g in ctx.goals:
        actual, truth = goal_actual(ctx, g)
        has, final = availability(ctx, g.metric)
        if not has and g.actual_typed is None:
            actual = None
        s = goal_score(actual, g.low, g.target, g.high) if (final or g.metric == "custom") else None
        meets = None
        if actual is not None:
            meets = actual <= g.target if g.lower_is_better else actual >= g.target
        out.append({"id": g.id, "owner_name": g.owner_name, "owner_role": g.owner_role, "owner_email": g.owner_email,
                    "label": g.label, "metric": g.metric, "metric_label": metric_meta(g.metric)["label"],
                    "unit": g.unit or metric_meta(g.metric)["unit"], "target": g.target, "low": g.low, "high": g.high,
                    "weight": g.weight, "lower_is_better": bool(g.lower_is_better), "safety": bool(g.safety),
                    "actual": actual, "actual_typed": g.actual_typed, "truth": truth,
                    "score": round(s, 1) if s is not None else None, "meets": meets if final else None,
                    "final": bool(final), "so_far": actual is not None and not final,
                    "score_so_far": None,
                    "signed": bool(g.signed_at), "signed_at": g.signed_at.isoformat() + "Z" if g.signed_at else None,
                    "signed_by": g.signed_by, "version": g.version or 1, "history": g.history or [],
                    "sign_token": g.sign_token})
    return out


def event_score(goals: list[dict], key: str = "score") -> dict:
    scored = [g for g in goals if g.get(key) is not None and (g.get("weight") or 0) > 0]
    tw = sum(g["weight"] for g in goals if (g.get("weight") or 0) > 0)
    if not scored:
        return {"score": None, "confidence": None, "coverage": 0.0, "capped": False}
    w = sum(g["weight"] for g in scored)
    s = sum(g[key] * g["weight"] for g in scored) / w
    backed = sum(g["weight"] for g in scored if g.get("truth") in BACKED)
    capped = any(g.get("safety") and g.get(key) is not None and g[key] < 70 for g in scored)
    if capped:
        s = min(s, 60.0)
    return {"score": round(s), "confidence": round(100 * backed / w), "coverage": round(100 * w / tw) if tw else 0,
            "capped": capped}


TEMPLATES = {
    # format -> suggested contract (owner, label, metric, target, low, high, weight, lower_is_better)
    "offline": [
        ("CEO", "Pipeline sourced in 90 days", "pipeline_sourced", None, None, None, 30, False),
        ("Sales", "Meetings held with target accounts", "meetings", None, None, None, 15, False),
        ("Marketing", "People in the room", "attended", None, None, None, 15, False),
        ("Sponsors", "Leads per sponsor", "sponsor_leads_avg", 120, 90, 150, 15, False),
        ("Attendees", "NPS", "nps", 45, 35, 60, 10, False),
        ("Finance", "Cost per attendee", "cost_per_attendee", None, None, None, 15, True),
    ],
    "webinar": [
        ("Marketing", "Registrations", "registrations", None, None, None, 25, False),
        ("Marketing", "Show-up rate", "attendance_rate", 50, 35, 65, 20, False),
        ("Sales", "Demo requests (CTA clicks)", "cta_clicks", None, None, None, 25, False),
        ("Product", "Average watch time", "avg_watch_minutes", None, None, None, 15, False),
        ("Attendees", "NPS", "nps", 40, 25, 60, 15, False),
    ],
    "meetup": [
        ("You", "People who came", "attended", None, None, None, 40, False),
        ("You", "Leads noted", "sponsor_leads", 3, 1, 6, 30, False),
        ("You", "Posts about it", "mentions", 10, 3, 25, 30, False),
    ],
}


def suggest(ctx: Ctx) -> list[dict]:
    """A starting contract for this format, sized from the plan's targets
    and the capacity - the owners change it before signing."""
    fmt = ctx.cfg.format
    tpl = TEMPLATES.get("webinar" if fmt in ("webinar", "online", "launch") else "meetup" if fmt == "meetup" else "offline")
    targets = {t.get("key"): t.get("target") for t in (ctx.i.targets or []) if t.get("target")}
    cap = ctx.cfg.capacity or (targets.get("attended") or 0) or 200
    regs = targets.get("registrations") or round(cap * 1.4)
    budget = ctx.i.budget or 0
    out = []
    for n, (owner, label, metric, tgt, lo, hi, wgt, lower) in enumerate(tpl):
        if tgt is None:
            if metric == "attended":
                tgt = targets.get("attended") or round(cap * 0.9)
            elif metric == "registrations":
                tgt = regs
            elif metric == "meetings":
                tgt = targets.get("meetings") or max(10, round(cap * 0.15))
            elif metric == "pipeline_sourced":
                tgt = targets.get("pipeline") or (budget * 10 if budget else 1000000)
            elif metric == "cost_per_attendee":
                tgt = round(budget / max(cap * 0.9, 1)) if budget else 2000
            elif metric == "cta_clicks":
                tgt = max(10, round(regs * 0.08))
            elif metric == "avg_watch_minutes":
                tgt = 30
            else:
                tgt = 10
            lo = tgt * (1.12 if lower else 0.8)
            hi = tgt * (0.88 if lower else 1.2)
        out.append({"owner_name": owner, "owner_role": owner, "label": label, "metric": metric, "target": float(tgt),
                    "low": float(round(lo, 2)), "high": float(round(hi, 2)), "weight": float(wgt), "lower_is_better": lower,
                    "position": n})
    return out
