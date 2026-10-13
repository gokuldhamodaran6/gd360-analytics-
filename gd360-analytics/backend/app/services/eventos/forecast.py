"""Before the event: how many will register, who will really come, and
the odds of meeting each signed goal.

Registrations follow a curve F(f) = f^k - the share of final sign-ups in
by fraction f of the campaign. k is set so that half the sign-ups land in
the last seven days (the benchmark most events follow), or from this
workspace's own finished events once there is one. The band widens the
earlier we are.

Show-up is per person, an explainable score (a few signals, each with a
fixed weight you can read) - not a black box. After the event the same
score is checked against who really came, and the start point is
re-calibrated on the next event.

The odds come from simulating the event 3,000 times."""
from __future__ import annotations

import math
from datetime import datetime, timedelta

from ... import models
from . import score as score_mod
from .ctx import METRICS, Ctx

BASE = {"offline": 0.25, "hybrid": 0.25, "festival": 0.6, "meetup": 0.55, "workshop": 0.55, "booth": 0.4, "roadshow": 0.3,
        "online": -0.15, "webinar": -0.1, "launch": -0.2}
WALKIN_RATE = {"offline": 0.07, "hybrid": 0.05, "meetup": 0.15, "booth": 0.2, "festival": 0.1, "workshop": 0.03, "roadshow": 0.06}


def _sig(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))


def _k(days_total: float) -> float:
    if days_total <= 8:
        return 1.0
    return max(1.0, math.log(0.504) / math.log(1 - 7.0 / days_total))


def _hist_k(ctx: Ctx) -> float | None:
    """The curve of this workspace's last finished event, if any."""
    data = ctx.data
    if data.get("hist_k"):
        return float(data["hist_k"])
    return None


def registrations(ctx: Ctx) -> dict | None:
    w = ctx.w
    if not w.start:
        return None
    reg = sorted(t.registered_at for t in ctx.registered if t.registered_at)
    R = len(reg)
    total_days = max((w.start - w.open).total_seconds() / 86400.0, 1.0)
    if ctx.now >= w.start:
        return {"done": True, "final": R, "median": R, "p10": R, "p90": R, "curve": [], "k": None, "basis": "final count"}
    prior = _hist_k(ctx) or min(_k(total_days), 2.1)
    f_now = max((ctx.now - w.open).total_seconds() / 86400.0 / total_days, 1e-3)
    k_fit, n_days = _fit_k(reg, w.open, total_days, ctx.now)
    if k_fit is not None:
        k = (n_days * k_fit + 2 * prior) / (n_days + 2)
        basis = f"fitted to this event's {R:,} sign-ups over {n_days} days" + (", with your past events" if _hist_k(ctx) else "")
    else:
        k = prior
        basis = "your past events" if _hist_k(ctx) else "benchmark curve (sign-ups speed up near the day)"
    F_now = max(f_now ** k, 0.03)
    if R == 0:
        return {"done": False, "final": None, "median": None, "p10": None, "p90": None, "curve": [], "k": k, "basis": basis,
                "note": "No registrations yet - the forecast starts with the first one."}
    median = R / F_now
    u = min(0.9, (0.12 + 0.45 * (1 - F_now)) * (1.25 if n_days < 7 else 1.0 if n_days < 14 else 0.8))
    remaining = median - R
    p10, p90 = R + remaining * max(0.05, 1 - u), R + remaining * (1 + u)
    curve = []
    d = ctx.now.date()
    end = w.start.date()
    while d <= end and len(curve) < 200:
        f = min(1.0, ((datetime(d.year, d.month, d.day) + timedelta(hours=23)) - w.open).total_seconds() / 86400.0 / total_days)
        Fd = max(f, 0) ** k
        share = (Fd - F_now) / max(1 - F_now, 1e-6)
        share = max(0.0, min(1.0, share))
        curve.append({"date": d.isoformat(), "median": round(R + (median - R) * share),
                      "lo": round(R + (p10 - R) * share), "hi": round(R + (p90 - R) * share)})
        d += timedelta(days=1)
    return {"done": False, "final": None, "median": round(median), "p10": round(p10), "p90": round(p90), "curve": curve, "k": round(k, 2),
            "basis": basis, "f_now": round(f_now, 3), "share_in": round(F_now, 3)}


def _fit_k(reg: list, open_at: datetime, total_days: float, now: datetime) -> tuple[float | None, int]:
    """The curve's shape from this event's own sign-ups: for C = N f^k,
    log C against log f is a line with slope k (N cancels out)."""
    if len(reg) < 30:
        return None, 0
    days = {}
    run = 0
    for r in reg:
        run += 1
        d = (r - open_at).total_seconds() / 86400.0
        days[int(d)] = run
    pts = [(math.log(max((d + 1) / total_days, 1e-3)), math.log(c)) for d, c in sorted(days.items()) if c >= 5]
    if len(pts) < 6:
        return None, 0
    pts = pts[len(pts) // 3:]  # the early trickle says little
    n = len(pts)
    mx = sum(x for x, _ in pts) / n
    my = sum(y for _, y in pts) / n
    sxx = sum((x - mx) ** 2 for x, _ in pts)
    if sxx <= 1e-9:
        return None, 0
    k = sum((x - mx) * (y - my) for x, y in pts) / sxx
    return max(0.6, min(k, 6.0)), min(30, len(days))


# ------------------------------------------------------------- show-up --

def _signals(ctx: Ctx) -> dict:
    """email clicks and meetings per contact (real events)."""
    out = {"clicked": set(), "meeting": set()}
    if ctx.sample or not ctx.i.workspace_id:
        return out
    E = models.GtmEngagement
    ids = [t.contact_id for t in ctx.registered if t.contact_id]
    if not ids:
        return out
    for cid, kind in ctx.db.query(E.contact_id, E.kind).filter(E.workspace_id == ctx.i.workspace_id, E.contact_id.in_(ids[:5000]),
                                                               E.kind.in_(("email_click", "meeting", "link_click"))):
        out["meeting" if kind == "meeting" else "clicked"].add(cid)
    return out


def show_prob(ctx: Ctx, t: models.EventTicket, sig: dict, venue_city: str | None = None) -> tuple[float, list[str]]:
    x = BASE.get(ctx.cfg.format, 0.2) + float(ctx.data.get("showup_shift") or 0)
    why = []
    d = t.data or {}
    if t.tier in ("vip", "paid"):
        x += 1.4
        why.append("paid pass")
    elif t.tier in ("speaker", "sponsor", "staff", "press"):
        x += 2.6
        why.append(t.tier)
    if t.confirmed_at:
        x += 0.9
        why.append("confirmed")
    if d.get("meeting") or (t.contact_id and t.contact_id in sig["meeting"]):
        x += 1.2
        why.append("meeting booked")
    if d.get("clicked") or (t.contact_id and t.contact_id in sig["clicked"]):
        x += 0.4
        why.append("clicked our emails")
    if d.get("repeat"):
        x += 0.6
        why.append("came before")
    if (t.source or "") == "Listing sites":
        x -= 0.6
        why.append("from a listing site")
    if ctx.w.start and t.registered_at:
        lead = (ctx.w.start - t.registered_at).days
        if lead > 30:
            x -= 0.35
            why.append("signed up over a month ago")
        elif lead <= 7:
            x += 0.35
            why.append("signed up this week")
    if venue_city and t.city and t.city.lower() != venue_city.lower():
        x -= 0.4
        why.append(f"travelling from {t.city}")
    return _sig(x), why


def showup(ctx: Ctx, write: bool = True) -> dict:
    sig = _signals(ctx)
    venue_city = (ctx.data.get("city") or "").strip() or None
    probs = []
    groups: dict[str, dict] = {}
    for t in ctx.registered:
        if ctx.now >= (ctx.w.end or ctx.now) and t.show_prob is not None and not write:
            p, why = t.show_prob, []
        else:
            p, why = show_prob(ctx, t, sig, venue_city)
            if write and (t.show_prob is None or abs((t.show_prob or 0) - p) > 0.01) and ctx.now < (ctx.w.start or ctx.now + timedelta(days=1)):
                t.show_prob = round(p, 3)
        probs.append(p)
        g = ("Paid / VIP" if t.tier in ("vip", "paid") else "Speakers, sponsors, press" if t.tier in ("speaker", "sponsor", "staff", "press")
             else "Booked a meeting" if "meeting booked" in why else "Confirmed" if t.confirmed_at
             else "Listing sites" if (t.source or "") == "Listing sites" else "Engaged (clicked emails)" if "clicked our emails" in why
             else "Silent since sign-up")
        gg = groups.setdefault(g, {"group": g, "people": 0, "prob_sum": 0.0, "came": 0})
        gg["people"] += 1
        gg["prob_sum"] += p
        if t.status == "checked_in":
            gg["came"] += 1
    bins = [0] * 10
    for p in probs:
        bins[min(9, int(p * 10))] += 1
    expected = sum(probs)
    rows = sorted(({"group": g["group"], "people": g["people"], "will_come": round(100 * g["prob_sum"] / g["people"]),
                    "came": g["came"]} for g in groups.values()), key=lambda r: -r["will_come"])
    return {"bins": bins, "groups": rows, "expected": round(expected), "registered": len(probs),
            "rate": round(100 * expected / len(probs), 1) if probs else None,
            "likely_no": sum(1 for p in probs if p < 0.4), "undecided": sum(1 for p in probs if 0.4 <= p < 0.6),
            "coming": sum(1 for p in probs if p >= 0.6),
            "walkins_expected": round(WALKIN_RATE.get(ctx.cfg.format, 0) * max(len(probs), 1)),
            "model": "explainable score: paid pass, confirmed, meeting booked, email clicks, past attendance, source, "
                     "how early they signed up, travel"}


# --------------------------------------------------------- simulations --

def _predicted(ctx: Ctx, metric: str, regs: dict | None, su: dict | None) -> float | None:
    v = ctx.values()
    if metric == "registrations" and regs and regs.get("median") is not None:
        return float(regs["median"])
    if metric in ("attended", "icp_attended") and su and su["registered"]:
        mult = (regs["median"] / max(v["registrations"], 1)) if regs and regs.get("median") and not regs.get("done") else 1.0
        att = su["expected"] * mult + su["walkins_expected"] * mult
        if ctx.w.now_phase(ctx.now) == "during":
            att = max(float(v["attended"]), att)
        if metric == "attended":
            return att
        share = (v.get("icp_share_registrations") or 0) / 100.0
        return att * share
    if metric == "attendance_rate" and su and su.get("rate") is not None:
        return su["rate"]
    if metric == "icp_share_attended" and v.get("icp_share_registrations") is not None:
        return v["icp_share_registrations"]
    if metric == "cost_per_attendee" and v.get("total_cost") and su and su["registered"]:
        mult = (regs["median"] / max(v["registrations"], 1)) if regs and regs.get("median") else 1.0
        att = (su["expected"] + su["walkins_expected"]) * mult
        return v["total_cost"] / att if att else None
    return None


def _elapsed(ctx: Ctx, phase: str) -> float:
    w = ctx.w
    if phase == "during" and w.start and w.end and w.end > w.start and w.start_local and w.end_local:
        # active hours only: each day runs from the start time to the end time
        days = (w.end_local.date() - w.start_local.date()).days + 1
        per = (datetime.combine(w.start_local.date(), w.end_local.time()) - datetime.combine(w.start_local.date(), w.start_local.time())).total_seconds()
        if days <= 1 or per <= 0:
            return max(0.0, min(1.0, (ctx.now - w.start) / (w.end - w.start)))
        from . import core
        now_l = core.to_local(ctx.now, w.tz)
        done = 0.0
        for d in range(days):
            day = w.start_local.date() + timedelta(days=d)
            a = datetime.combine(day, w.start_local.time())
            b = a + timedelta(seconds=per)
            done += max(0.0, (min(now_l, b) - a).total_seconds()) if now_l > a else 0.0
        return max(0.0, min(1.0, done / (days * per)))
    if phase == "after" and w.end and w.close and w.close > w.end:
        return max(0.0, min(1.0, (ctx.now - w.end) / (w.close - w.end)))
    return 1.0


def simulate(ctx: Ctx, goals: list[dict], regs: dict | None = None, su: dict | None = None, runs: int = 3000) -> dict:
    import numpy as np
    if not goals:
        return {"median": None, "p10": None, "p90": None, "hist": [], "odds70": None, "goals": {}}
    rng = np.random.default_rng(42)
    after_close = ctx.w.close is not None and ctx.now > ctx.w.close
    phase_now = ctx.w.now_phase(ctx.now)
    cols, weights, ids = [], [], []
    likely = {}
    for g in goals:
        meta = score_mod.metric_meta(g["metric"])
        lo, tgt, hi = g["low"], g["target"], g["high"]
        spread = abs(hi - lo) / 2.56 or abs(tgt) * 0.15 or 1.0
        final = g["actual"] is not None and g.get("final")
        if final:
            vals = np.full(runs, float(g["actual"]))
        else:
            mean = _predicted(ctx, g["metric"], regs, su)
            if mean is None and g["actual"] is not None:
                if meta["unit"] in ("count", "money") and meta["phase"] in ("during", "after") and g["metric"] != "cost_per_attendee":
                    frac = _elapsed(ctx, meta["phase"])
                    mean = min(float(g["actual"]) / max(frac, 0.15), max(float(g["actual"]), max(hi, lo) * 1.5))
                    spread = max(spread, abs(mean - float(g["actual"])) * 0.35)
                else:
                    mean = float(g["actual"])
            if mean is None:
                mean = float(tgt)
            if g["metric"] == "registrations" and regs and regs.get("p10") is not None:
                spread = max((regs["p90"] - regs["p10"]) / 2.56, 1.0)
            vals = rng.normal(mean, spread, runs)
        sc = np.array([score_mod.goal_score(float(x), lo, tgt, hi) for x in vals])
        meets = (vals <= tgt) if g["lower_is_better"] else (vals >= tgt)
        likely[g["id"]] = round(float(meets.mean()) * 100)
        cols.append(sc)
        weights.append(g["weight"] or 0)
        ids.append(g["id"])
    W = np.array(weights, dtype=float)
    if W.sum() <= 0:
        return {"median": None, "p10": None, "p90": None, "hist": [], "odds70": None, "goals": likely}
    M = np.vstack(cols)
    total = (M * W[:, None]).sum(axis=0) / W.sum()
    for n, g in enumerate(goals):
        if g.get("safety"):
            total = np.where(M[n] < 70, np.minimum(total, 60), total)
    hist = [0] * 24  # 40 .. 100 by 2.5
    for x in total:
        if x >= 40:
            hist[min(23, int((x - 40) / 2.5))] += 1
    return {"median": round(float(np.median(total))), "p10": round(float(np.percentile(total, 10))),
            "p90": round(float(np.percentile(total, 90))), "hist": hist, "below40": int((total < 40).sum()),
            "odds70": round(float((total >= 70).mean()) * 100), "goals": likely, "runs": runs}


def odds_text(p: float | None) -> str:
    if p is None:
        return "–"
    return f"{p:.0f}% likely"


__all__ = ["registrations", "showup", "simulate", "METRICS"]
