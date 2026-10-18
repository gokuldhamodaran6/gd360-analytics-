"""2026-10-17 (R53): budget and mix - a response curve per paid channel, and where the next unit of budget does most.

For each channel (Meta ads, Google ads), from its own days: results = a * (1 - exp(-spend / b)) - more spend, more
results, each extra unit doing a little less (diminishing returns). With fewer than 6 spending days, or a fit that
won't hold, the channel falls back to a straight line (its cost per result) and says so. The marginal return - extra
results from the next unit at today's daily spend - decides the move: shift daily budget from the channel where it
does least to where it does most, in steps, until they even out, capped by the Autopilot policy's per-move limit.
Expected extra results are counted over the days left. Labelled "modelled"; the next scans show what really happened.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date

import numpy as np
from sqlalchemy.orm import Session

from ... import models
from . import evidence, policy


def _curve(xs: np.ndarray, ys: np.ndarray) -> dict:
    """Fits y = a(1-exp(-x/b)); returns {a, b, kind, r2}."""
    pos = xs > 0
    if pos.sum() >= 6 and ys[pos].sum() > 0:
        try:
            from scipy.optimize import curve_fit
            f = lambda x, a, b: a * (1 - np.exp(-x / b))  # noqa: E731
            a0 = max(float(ys.max()) * 1.5, 1e-3)
            b0 = max(float(np.median(xs[pos])), 1e-3)
            (a, b), _ = curve_fit(f, xs, ys, p0=(a0, b0), bounds=([1e-6, 1e-3], [a0 * 50, float(xs.max()) * 50 + 1]), maxfev=4000)
            pred = f(xs, a, b)
            ss_res = float(((ys - pred) ** 2).sum())
            ss_tot = float(((ys - ys.mean()) ** 2).sum()) or 1e-9
            r2 = 1 - ss_res / ss_tot
            if r2 > 0.1:
                return {"a": float(a), "b": float(b), "kind": "curve", "r2": round(r2, 2)}
        except Exception:  # noqa: BLE001 - falls back to the straight line
            pass
    spend, res = float(xs.sum()), float(ys.sum())
    slope = res / spend if spend > 0 else 0.0
    return {"slope": slope, "kind": "line", "r2": None}


def _y(c: dict, x: float) -> float:
    if c["kind"] == "curve":
        return c["a"] * (1 - np.exp(-x / c["b"]))
    return c["slope"] * x


def _marginal(c: dict, x: float) -> float:
    if c["kind"] == "curve":
        return c["a"] / c["b"] * float(np.exp(-x / c["b"]))
    return c["slope"]


def model(db: Session, i: models.Initiative, days: list[dict] | None = None) -> dict:
    rows = days if days is not None else evidence.ad_days(db, i)
    if not rows:
        c = db.get(models.InitiativeContract, i.id)
        return {"available": False, "why": f"No Meta or Google Ads campaign named INIT-{c.code if c else 'CODE'} has spent yet. "
                                          "Name a campaign that way (or map one in Evidence) and the curves appear after six days of spend."}
    per: dict[str, dict[str, list]] = defaultdict(lambda: {"x": [], "y": []})
    by_day: dict[tuple, dict] = {}
    for r in rows:
        k = (r["platform"], r["day"])
        d = by_day.setdefault(k, {"spend": 0.0, "conversions": 0.0})
        d["spend"] += float(r.get("spend") or 0)
        d["conversions"] += float(r.get("conversions") or 0)
    for (platform, _day), v in sorted(by_day.items(), key=lambda x: x[0][1]):
        per[platform]["x"].append(v["spend"])
        per[platform]["y"].append(v["conversions"])
    channels = []
    for platform, d in per.items():
        xs, ys = np.array(d["x"], dtype=float), np.array(d["y"], dtype=float)
        c = _curve(xs, ys)
        recent = xs[-7:] if len(xs) else xs
        daily = float(recent.mean()) if len(recent) else 0.0
        top = max(float(xs.max()) * 1.6, daily * 2, 1.0)
        pts = [{"spend": round(float(x), 2), "results": round(float(_y(c, x)), 2)} for x in np.linspace(0, top, 24)]
        channels.append({"platform": platform, "days": int(len(xs)), "spend": round(float(xs.sum()), 2), "results": round(float(ys.sum()), 1),
                         "cost_per_result": round(float(xs.sum()) / float(ys.sum()), 2) if ys.sum() > 0 else None, "daily_spend": round(daily, 2),
                         "marginal": round(_marginal(c, daily), 4), "fit": c["kind"], "r2": c.get("r2"), "curve": pts,
                         "observed": [{"spend": round(float(x), 2), "results": round(float(y), 2)} for x, y in zip(xs, ys)][-60:],
                         "_c": c})
    out = {"available": True, "channels": channels, "truth": "modelled",
           "note": "Curves fitted to each channel's own days; a straight line is used where there aren't enough days for a curve."}
    out["plan_b"] = _plan_b(i, channels)
    for ch in channels:
        ch.pop("_c", None)
    return out


def _plan_b(i: models.Initiative, channels: list[dict]) -> dict | None:
    live = [c for c in channels if c["daily_spend"] > 0]
    if len(live) < 2:
        return None
    from ..initiatives.metrics import _d
    kd = _d(i.key_date)
    days_left = max(1, (kd - date.today()).days) if kd else 14
    cap_total = policy.get(i)["budget_cap"]
    alloc = {c["platform"]: c["daily_spend"] for c in live}
    curves = {c["platform"]: c["_c"] for c in live}
    total = sum(alloc.values())
    step = total * 0.05
    moved = 0.0
    for _ in range(20):
        m = {p: _marginal(curves[p], alloc[p]) for p in alloc}
        lo, hi = min(m, key=m.get), max(m, key=m.get)
        if lo == hi or m[hi] <= m[lo] * 1.05 or alloc[lo] - step < total * 0.1:
            break
        if (moved + step) * days_left > cap_total and moved > 0:
            break
        alloc[lo] -= step
        alloc[hi] += step
        moved += step
    if moved <= 0:
        return None
    before = sum(_y(curves[p], c["daily_spend"]) for p, c in ((c["platform"], c) for c in live))
    after = sum(_y(curves[p], alloc[p]) for p in alloc)
    extra = round((after - before) * days_left)
    src = min(live, key=lambda c: alloc[c["platform"]] - c["daily_spend"])["platform"]
    dst = max(live, key=lambda c: alloc[c["platform"]] - c["daily_spend"])["platform"]
    if extra <= 0:
        return None
    return {"from": src, "to": dst, "per_day": round(moved, 2), "days": days_left, "amount": round(moved * days_left, 2), "extra": extra,
            "helps": "registrations", "title": f"Move {moved:,.0f} a day from {src} to {dst}",
            "detail": f"At today's spend, the next unit does more on {dst} than on {src}. Over the {days_left} days left: about {extra:,} more results "
                      f"(modelled). The move is {moved * days_left:,.0f} in total, within the {cap_total:,.0f} cap per move.",
            "allocation": {p: round(v, 2) for p, v in alloc.items()}}
