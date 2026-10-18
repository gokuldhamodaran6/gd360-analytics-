"""2026-10-17 (R53): pace - every target snapshotted daily, the end value forecast with an 80% range and the odds of
hitting the target, and three ranked moves.

The model, plainly: a count grows along C(f) = N * f^k, where f is the share of the initiative's time gone (k > 1:
it speeds up near the date, as registrations do; k = 1: steady). k comes from this initiative's own snapshots when
there are enough, else from the workspace's finished initiatives, else from the kind's benchmark. The total N is
uncertain: with c counted so far at F = f^k, N follows Gamma(c + 1, F) (Bayesian, flat prior), and 3,000 draws give
the median, the 10th and 90th percentiles and P(N >= target). Rates (percentages) keep their current value with a
Beta interval. The back-test runs the same forecast at the half-way point of finished initiatives and reports how
often the 80% range held the real end value.
"""
from __future__ import annotations

import math
from datetime import date, datetime, timedelta

import numpy as np
from sqlalchemy.orm import Session

from ... import models
from . import policy

K_KIND = {"event": 2.1, "webinar": 2.1, "campaign": 1.2, "abm": 1.0, "hiring": 1.0, "product": 1.0, "custom": 1.0}
RATE_UNITS = ("pct",)


def _frac(i: models.Initiative, when: datetime | None = None) -> float | None:
    from ..initiatives.metrics import _d, start_of
    end = _d(i.key_date)
    if not end:
        return None
    start = start_of(i)
    endt = datetime(end.year, end.month, end.day, 23, 59)
    total = (endt - start).total_seconds()
    if total <= 0:
        return 1.0
    return max(0.0, min(1.0, ((when or datetime.utcnow()) - start).total_seconds() / total))


def snapshot(db: Session, i: models.Initiative, values: dict, day: date | None = None) -> int:
    d = (day or date.today()).isoformat()
    keys = {t.get("key") for t in i.targets or [] if t.get("key")} | {k for k in ("social_reach", "ad_spend", "utm_sessions", "pipeline_value") if values.get(k) is not None}
    existing = {r.key: r for r in db.query(models.InitiativeMetricDaily).filter(models.InitiativeMetricDaily.initiative_id == i.id,
                                                                                models.InitiativeMetricDaily.day == d)}
    n = 0
    for k in keys:
        v = values.get(k)
        if v is None:
            t = next((t for t in i.targets or [] if t.get("key") == k), None)
            v = t.get("actual") if t else None
        try:
            v = float(v) if v is not None else None
        except (TypeError, ValueError):
            v = None
        if k in existing:
            existing[k].value = v
        else:
            db.add(models.InitiativeMetricDaily(initiative_id=i.id, day=d, key=k, value=v))
        n += 1
    db.commit()
    return n


def series(db: Session, i: models.Initiative, key: str) -> list[tuple[str, float]]:
    return [(r.day, r.value) for r in db.query(models.InitiativeMetricDaily).filter(models.InitiativeMetricDaily.initiative_id == i.id,
                                                                                     models.InitiativeMetricDaily.key == key)
            .order_by(models.InitiativeMetricDaily.day) if r.value is not None]


def _fit_k(points: list[tuple[float, float]]) -> float | None:
    pts = [(math.log(f), math.log(c)) for f, c in points if f > 0.02 and c > 0]
    if len(pts) < 5:
        return None
    xs, ys = np.array([p[0] for p in pts]), np.array([p[1] for p in pts])
    if float(np.var(xs)) < 1e-6:
        return None
    k = float(np.polyfit(xs, ys, 1)[0])
    return max(0.5, min(k, 4.0))


def forecast_one(current: float | None, target: float | None, frac: float | None, k: float, unit: str, seed: int = 53,
                 n_rate: int | None = None) -> dict:
    if current is None:
        return {"state": "no_data", "note": "No number yet - the forecast starts with the first one."}
    if unit in RATE_UNITS:
        n = max(int(n_rate or 50), 1)
        p = max(min(current / 100.0, 0.999), 0.001)
        a, b = p * n + 1, (1 - p) * n + 1
        draws = np.random.default_rng(seed).beta(a, b, 3000) * 100
        lo, mid, hi = (float(np.percentile(draws, q)) for q in (10, 50, 90))
        prob = float((draws >= target).mean()) if target else None
        return {"state": "rate", "median": round(mid, 1), "p10": round(lo, 1), "p90": round(hi, 1), "prob": None if prob is None else round(prob, 2)}
    if frac is None:
        return {"state": "undated", "median": current, "note": "No end date: progress only, no forecast."}
    if frac >= 0.999:
        prob = (1.0 if current >= target else 0.0) if target else None
        return {"state": "final", "median": current, "p10": current, "p90": current, "prob": prob}
    F = max(frac ** k, 0.02)
    rng = np.random.default_rng(seed)
    N = rng.gamma(current + 1.0, 1.0 / F, 3000)
    N = np.maximum(N, current)
    lo, mid, hi = (float(np.percentile(N, q)) for q in (10, 50, 90))
    prob = float((N >= target).mean()) if target else None
    return {"state": "forecast", "median": round(mid), "p10": round(lo), "p90": round(hi), "prob": None if prob is None else round(prob, 2),
            "share_done": round(F, 3)}


def k_for(db: Session, i: models.Initiative, key: str) -> tuple[float, str]:
    pts = []
    for d, v in series(db, i, key):
        f = _frac(i, datetime.fromisoformat(d) + timedelta(hours=23))
        if f is not None and v:
            pts.append((f, v))
    k = _fit_k(pts)
    if k is not None:
        return k, f"fitted to {len(pts)} days of this initiative"
    return K_KIND.get(i.kind, 1.0), ("benchmark curve: most sign-ups come near the date" if i.kind in ("event", "webinar") else "steady pace assumed")


def forecast(db: Session, i: models.Initiative, targets: list[dict]) -> list[dict]:
    frac = _frac(i)
    out = []
    for n, t in enumerate(targets):
        if t.get("target") is None:
            continue
        k, basis = k_for(db, i, t["key"])
        n_rate = None
        if t.get("unit") == "pct":
            reg = next((x for x in targets if x["key"] in ("registrations", "emails_sent")), None)
            n_rate = int(reg["actual"]) if reg and reg.get("actual") else None
        from ..initiatives.catalog import LOWER_IS_BETTER, NOT_CUMULATIVE
        lower = t["key"] in LOWER_IS_BETTER
        if t["key"] in NOT_CUMULATIVE:
            # a ratio or a score doesn't pile up: today's value is the best guess, no range
            cur = t.get("actual")
            f = {"state": "no_data", "note": "No number yet - the forecast starts with the first one."} if cur is None else \
                {"state": "level", "median": cur, "p10": cur, "p90": cur,
                 "prob": (1.0 if (cur <= float(t["target"]) if lower else cur >= float(t["target"])) else 0.0),
                 "note": "A ratio: today's value, not a running total"}
        else:
            f = forecast_one(t.get("actual"), float(t["target"]), frac, k, t.get("unit") or "count", seed=53 + n, n_rate=n_rate)
            if lower and f.get("prob") is not None and f.get("state") in ("forecast", "final", "rate"):
                f["prob"] = round(1.0 - f["prob"], 2) if f["state"] != "final" else (1.0 if float(t.get("actual") or 0) <= float(t["target"]) else 0.0)
        f["direction"] = "down" if lower else "up"
        f.update({"key": t["key"], "label": t["label"], "target": t["target"], "actual": t.get("actual"), "unit": t.get("unit"),
                  "truth": t.get("truth"), "basis": basis if f.get("state") == "forecast" else None,
                  "expected_now": round(float(t["target"]) * (frac ** k), 1) if frac is not None and f.get("state") == "forecast" else None})
        out.append(f)
    return out


def moves(db: Session, i: models.Initiative, fc: list[dict], values: dict, mix: dict | None = None) -> list[dict]:
    """Three ranked moves, each with the target it helps, its expected effect and cost - and whether Autopilot may
    do it alone (most need you)."""
    from ..initiatives.metrics import overdue_count
    cands: list[dict] = []
    behind = sorted([f for f in fc if f.get("prob") is not None and f["prob"] < 0.7], key=lambda f: f["prob"])
    gap = {f["key"]: max(0.0, float(f["target"]) - float(f.get("median") or 0)) for f in behind}
    # warm accounts who have not registered
    if "registrations" in gap or "attended" in gap:
        engaged = {a for (a,) in db.query(models.GtmEngagement.account_id).filter(models.GtmEngagement.initiative_id == i.id,
                   models.GtmEngagement.kind.in_(("email_open", "email_click", "visit", "link_click")), models.GtmEngagement.account_id.isnot(None)).distinct()}
        regd = {a for (a,) in db.query(models.GtmEngagement.account_id).filter(models.GtmEngagement.initiative_id == i.id,
                models.GtmEngagement.kind == "registered", models.GtmEngagement.account_id.isnot(None)).distinct()}
        warm = len(engaged - regd)
        if warm:
            lift = round(warm * 0.25)
            cands.append({"key": "warm_invites", "agent": "Demand", "kind": "email", "title": f"Invite the {warm} engaged accounts that haven't registered",
                          "detail": "They opened, clicked or visited but did not sign up. A short personal invite from their owner converts about one in four (warm-invite benchmark).",
                          "helps": "registrations", "lift": lift, "cost": 0.0, "score": lift / max(gap.get("registrations", 1), 1)})
    # budget: the mix model's plan B
    if mix and mix.get("plan_b"):
        pb = mix["plan_b"]
        cands.append({"key": "mix_move", "agent": "Mixer", "kind": "budget", "title": pb["title"], "detail": pb["detail"], "helps": pb.get("helps", "results"),
                      "lift": pb.get("extra", 0), "cost": pb.get("amount", 0.0), "score": (pb.get("extra", 0) or 0) / max(gap.get("registrations", 10), 1) + 0.2})
    # social reach behind
    if "social_reach" in gap:
        bp = db.get(models.BusinessProfile, i.workspace_id) if i.workspace_id else None
        avg = next((f["value"] for f in (bp.facts if bp else []) or [] if str(f.get("key", "")).endswith("avg_reach") and isinstance(f.get("value"), (int, float))), None)
        c = db.get(models.InitiativeContract, i.id)
        lift = round(avg) if avg else None
        cands.append({"key": "post_again", "agent": "Tracker", "kind": "task", "title": f"Post again with {c.hashtag if c and c.hashtag else 'the hashtag'}",
                      "detail": f"Your posts reach about {avg:,.0f} people each (brain fact)." if avg else "Each post counts when it carries the hashtag or the tracked link.",
                      "helps": "social_reach", "lift": lift, "cost": 0.0, "score": (lift or 1000) / max(gap["social_reach"], 1)})
    # meetings
    if "meetings" in gap:
        top = db.query(models.GtmAccount).filter(models.GtmAccount.workspace_id == i.workspace_id).order_by(models.GtmAccount.engagement_7d.desc()).limit(5).all()
        if top:
            cands.append({"key": "book_meetings", "agent": "Follow-up", "kind": "task", "title": f"Ask for meetings with the {len(top)} most engaged accounts",
                          "detail": "Most engaged this week: " + ", ".join(a.name for a in top), "helps": "meetings", "lift": max(1, len(top) // 2),
                          "cost": 0.0, "score": max(1, len(top) // 2) / max(gap["meetings"], 1)})
    # overdue work
    tasks = db.query(models.InitiativeTask).filter(models.InitiativeTask.initiative_id == i.id).all()
    od = overdue_count(tasks)
    if od:
        cands.append({"key": "overdue", "agent": "Pacer", "kind": "reminder", "title": f"Nudge the owners of {od} overdue task{'s' if od != 1 else ''}",
                      "detail": "A reminder to each owner today.", "helps": "tasks_done_pct", "lift": od, "cost": 0.0, "score": 0.3 + 0.05 * od})
    cands.sort(key=lambda c: -(c["score"] or 0))
    out = []
    for n, c in enumerate(cands[:3]):
        out.append({**{k: v for k, v in c.items() if k != "score"}, "rank": n + 1,
                    "alone": policy.allowed_alone(i, c["kind"])})
    return out


def backtest(db: Session, workspace_id: str) -> dict:
    """At the half-way point of every finished, dated initiative with snapshots: did the 80% range hold the end value?"""
    held = total = 0
    rows = []
    for i in db.query(models.Initiative).filter(models.Initiative.workspace_id == workspace_id, models.Initiative.key_date.isnot(None)):
        if (_frac(i) or 0) < 1:
            continue
        for t in i.targets or []:
            s = series(db, i, t.get("key"))
            if len(s) < 4:
                continue
            final = s[-1][1]
            mid_day = None
            for d, v in s:
                f = _frac(i, datetime.fromisoformat(d) + timedelta(hours=23))
                if f is not None and f >= 0.5:
                    mid_day = (d, v, f)
                    break
            if not mid_day or (t.get("unit") or "count") in RATE_UNITS:
                continue
            fc = forecast_one(mid_day[1], t.get("target"), mid_day[2], K_KIND.get(i.kind, 1.0), "count")
            if fc.get("state") != "forecast":
                continue
            ok = fc["p10"] <= final <= fc["p90"]
            held += int(ok)
            total += 1
            rows.append({"initiative": i.title, "target": t.get("label") or t.get("key"), "at_half": mid_day[1], "range": [fc["p10"], fc["p90"]], "final": final, "held": ok})
    return {"tested": total, "held": held, "coverage": round(held / total, 2) if total else None, "rows": rows[-20:],
            "verdict": None if not total else ("The 80% ranges hold" if held / total >= 0.75 else "The ranges are too narrow - widening is due")}
