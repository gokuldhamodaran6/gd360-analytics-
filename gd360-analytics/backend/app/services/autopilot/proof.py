"""2026-10-17 (R53): proof - did the initiative move anything, and what did it produce?

  lift        website sessions (GA4, else GD360's own visit tracking) against what would have happened anyway: a
              regression fitted on the 8 weeks before the start (trend + day of week, and a control series when there
              is one), projected over the initiative's days; the range comes from 2,000 block-bootstrapped replays of
              the pre-period's own errors. Shown as a finding only when the 90% range clears zero.
  geo test    the same, with the regions outside the initiative's scope as the control (a difference-in-differences
              that a planted +20% is recovered by - see the tests)
  pipeline    HubSpot deals at the companies it engaged: sourced, influenced, won
  calibration (events) were the show-up predictions right? predicted vs real, by band, and the Brier score
  learnings   drafted from the numbers, edited by the owner, published into the business brain
  report      the board PDF
"""
from __future__ import annotations

import io
from collections import defaultdict
from datetime import date, datetime, timedelta

import numpy as np
from sqlalchemy import func
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from ... import models

PRE_DAYS = 56


def _design(n: int, dows: list[int], t0: int, x: np.ndarray | None) -> np.ndarray:
    cols = [np.ones(n), np.arange(t0, t0 + n, dtype=float)]
    for d in range(1, 7):
        cols.append(np.array([1.0 if w == d else 0.0 for w in dows]))
    if x is not None:
        cols.append(np.asarray(x, dtype=float))
    return np.column_stack(cols)


def lift_from_series(days: list[date], y: list[float], start: date, end: date, x: list[float] | None = None, seed: int = 53) -> dict:
    """Pure: the lift of y over [start, end] against a counterfactual fitted on the days before start."""
    yd = dict(zip(days, y))
    xd = dict(zip(days, x)) if x is not None else None
    pre_days = [d for d in sorted(yd) if start - timedelta(days=PRE_DAYS) <= d < start]
    post_days = [d for d in sorted(yd) if start <= d <= end]
    if len(pre_days) < 28 or len(post_days) < 7:
        return {"state": "not_enough", "why": f"Needs 28 days before the start and 7 during it (has {len(pre_days)} and {len(post_days)})."}
    yp = np.array([yd[d] for d in pre_days], dtype=float)
    yq = np.array([yd[d] for d in post_days], dtype=float)
    xp = np.array([xd.get(d, 0.0) for d in pre_days], dtype=float) if xd else None
    xq = np.array([xd.get(d, 0.0) for d in post_days], dtype=float) if xd else None
    Xp = _design(len(pre_days), [d.weekday() for d in pre_days], 0, xp)
    Xq = _design(len(post_days), [d.weekday() for d in post_days], (post_days[0] - pre_days[0]).days, xq)
    beta, *_ = np.linalg.lstsq(Xp, yp, rcond=None)
    resid = yp - Xp @ beta
    base = Xq @ beta
    actual = float(yq.sum())
    expected = float(base.sum())
    rng = np.random.default_rng(seed)
    block = 7
    sims = []
    for _ in range(2000):
        draws = []
        while len(draws) < len(post_days):
            s = rng.integers(0, max(1, len(resid) - block))
            draws.extend(resid[s:s + block])
        sims.append(actual - (expected + float(np.sum(draws[:len(post_days)]))))
    sims = np.array(sims)
    lo, mid, hi = (float(np.percentile(sims, q)) for q in (5, 50, 95))
    pct = 100.0 * (actual - expected) / expected if expected > 0 else None
    clears = lo > 0 or hi < 0
    return {"state": "ok", "actual": round(actual), "expected": round(expected), "lift": round(actual - expected), "lo": round(lo), "hi": round(hi),
            "pct": None if pct is None else round(pct, 1), "clears_zero": bool(clears), "pre_days": len(pre_days), "post_days": len(post_days),
            "with_control": x is not None,
            "series": [{"date": d.isoformat(), "actual": round(yd[d], 1), "expected": round(float(b), 1)} for d, b in zip(post_days, base)],
            "verdict": (f"About {actual - expected:+,.0f} ({pct:+.1f}%) against what would have happened anyway; the 90% range "
                        f"{lo:+,.0f} to {hi:+,.0f} {'clears zero' if clears else 'includes zero, so no lift is claimed'}.") if pct is not None else None}


def _window(i: models.Initiative) -> tuple[date, date]:
    from ..initiatives.metrics import _d, start_of
    s = start_of(i).date()
    e = _d(i.key_date) or date.today()
    e = min(max(e, s + timedelta(days=7)), date.today())
    return s, e


def daily_sessions(db: Session, workspace_id: str, lo: date, hi: date, by_country: bool = False) -> tuple[str, dict]:
    """{date: sessions} (or {(date, country): sessions}) from GA4, else GD360 visits."""
    from ..synced_sources import load_table
    for ds in db.query(models.DataSource).filter(models.DataSource.workspace_id == workspace_id, models.DataSource.kind == "ga4").all():
        try:
            df = load_table(db, ds.id, "traffic_daily")
        except Exception:  # noqa: BLE001
            continue
        if df is None or not len(df) or "sessions" not in df.columns:
            continue
        out: dict = defaultdict(float)
        for r in df.to_dict("records"):
            try:
                d = date.fromisoformat(str(r.get("date"))[:10])
            except ValueError:
                continue
            if lo <= d <= hi:
                k = (d, str(r.get("country") or "")) if by_country else d
                out[k] += float(r.get("sessions") or 0)
        if out:
            return f"GA4 ({ds.name})", dict(out)
    out = defaultdict(float)
    q = db.query(func.date(models.GtmEngagement.occurred_at), func.count()).filter(models.GtmEngagement.workspace_id == workspace_id,
                                                                                  models.GtmEngagement.kind == "visit",
                                                                                  models.GtmEngagement.occurred_at >= datetime(lo.year, lo.month, lo.day))
    for d, n in q.group_by(func.date(models.GtmEngagement.occurred_at)):
        dd = d if isinstance(d, date) else date.fromisoformat(str(d)[:10])
        if dd <= hi:
            out[dd] += n
    return "GD360 website tracking", dict(out)


def lift(db: Session, i: models.Initiative) -> dict:
    if not i.workspace_id:
        return {"state": "not_enough", "why": "No workspace."}
    s, e = _window(i)
    src, d = daily_sessions(db, i.workspace_id, s - timedelta(days=PRE_DAYS), e)
    if not d:
        return {"state": "not_enough", "why": "No website sessions: connect GA4 or add the GD360 snippet to your site."}
    days = sorted(set(d) | {s - timedelta(days=k) for k in range(1, PRE_DAYS + 1)} | {s + timedelta(days=k) for k in range((e - s).days + 1)})
    days = [x for x in days if x <= e]
    out = lift_from_series(days, [d.get(x, 0.0) for x in days], s, e)
    out["source"], out["metric"] = src, "website sessions"
    return out


def regions_of(i: models.Initiative) -> list[str]:
    reg = [str(x) for x in (((i.details or {}).get("scope") or {}).get("regions") or []) if str(x).strip()]
    if not reg and i.location:
        reg = [i.location.split(",")[-1].strip()]
    return reg


def geo(db: Session, i: models.Initiative) -> dict:
    reg = regions_of(i)
    if not reg or not i.workspace_id:
        return {"state": "not_enough", "why": "Set the initiative's regions (scope) to compare them with the rest."}
    s, e = _window(i)
    src, d = daily_sessions(db, i.workspace_id, s - timedelta(days=PRE_DAYS), e, by_country=True)
    if not d or not any(isinstance(k, tuple) for k in d):
        return {"state": "not_enough", "why": "Needs GA4 sessions by country."}
    want = {r.lower() for r in reg}
    t, c = defaultdict(float), defaultdict(float)
    for (day, country), v in d.items():
        (t if country.lower() in want else c)[day] += v
    days = sorted(set(t) | set(c))
    out = lift_from_series(days, [t.get(x, 0.0) for x in days], s, e, x=[c.get(x, 0.0) for x in days])
    out.update({"source": src, "metric": "website sessions", "treated": reg, "control": "every other country"})
    return out


def pipeline(db: Session, i: models.Initiative) -> dict:
    from . import evidence
    p = evidence.deals(db, i)
    return {k: p.get(k) for k in ("sourced", "sourced_n", "influenced", "influenced_n", "won", "won_n")} | {"deals": (p.get("deals") or [])[:20],
                                                                                                            "sources": p.get("sources") or []}


def calibration(db: Session, i: models.Initiative) -> dict:
    tickets = db.query(models.EventTicket).filter(models.EventTicket.initiative_id == i.id, models.EventTicket.show_prob.isnot(None),
                                                  models.EventTicket.walk_in.is_(False)).all()
    from ..initiatives.metrics import _d
    kd = _d(i.key_date)
    if not tickets or (kd and kd >= date.today()):
        return {"state": "not_yet", "why": "After the event: predicted show-up against who really came."}
    bands = [(0, 0.3), (0.3, 0.5), (0.5, 0.7), (0.7, 0.9), (0.9, 1.01)]
    rows = []
    brier = 0.0
    for lo, hi in bands:
        b = [t for t in tickets if lo <= (t.show_prob or 0) < hi]
        if not b:
            continue
        pred = sum(t.show_prob for t in b) / len(b)
        real = sum(1 for t in b if t.checked_in_at is not None) / len(b)
        rows.append({"band": f"{int(lo * 100)}-{min(int(hi * 100), 100)}%", "n": len(b), "predicted": round(100 * pred, 1), "came": round(100 * real, 1),
                     "ok": abs(pred - real) <= 0.1})
    for t in tickets:
        brier += ((t.show_prob or 0) - (1.0 if t.checked_in_at else 0.0)) ** 2
    return {"state": "ok", "bands": rows, "brier": round(brier / len(tickets), 3), "n": len(tickets),
            "verdict": "Calibrated: each band came within 10 points of its prediction" if rows and all(r["ok"] for r in rows)
            else "Off in some bands: the next event starts from these real rates"}


def _num(t: dict, v) -> str:
    try:
        v = float(v)
    except (TypeError, ValueError):
        return "—"
    u = t.get("unit")
    return f"{v:g}%" if u == "pct" else f"${v:,.0f}" if u == "money" else f"{v:,.0f}"


def learnings_draft(db: Session, i: models.Initiative, targets: list[dict], ev_values: dict, lift_out: dict | None) -> list[str]:
    out = []
    hit = [t for t in targets if t.get("pct") is not None and t["pct"] >= 100]
    miss = [t for t in targets if t.get("pct") is not None and t["pct"] < 100]
    if hit:
        out.append("Hit: " + "; ".join(f"{t['label']} {_num(t, t['actual'])} against {_num(t, t['target'])}" for t in hit[:3]) + ".")
    if miss:
        out.append("Missed: " + "; ".join(f"{t['label']} {_num(t, t['actual'])} against {_num(t, t['target'])}" for t in miss[:3]) + ".")
    if ev_values.get("ad_spend"):
        reg = next((t.get("actual") for t in targets if t["key"] in ("registrations", "landing_conversions")), None)
        if reg:
            out.append(f"Ads spent {ev_values['ad_spend']:,.0f}; that is {ev_values['ad_spend'] / max(reg, 1):,.0f} per {('registration' if reg else 'result')}.")
    top = (db.query(models.InitiativeEvidence).filter(models.InitiativeEvidence.initiative_id == i.id, models.InitiativeEvidence.kind == "post",
                                                     models.InitiativeEvidence.state.in_(("auto", "confirmed"))).all())
    if top:
        best = max(top, key=lambda e: float((e.numbers or {}).get("reach") or 0))
        out.append(f"The best post reached {float((best.numbers or {}).get('reach') or 0):,.0f} on {best.source}: “{(best.title or '')[:80]}”.")
    if lift_out and lift_out.get("state") == "ok":
        out.append("Website sessions: " + (lift_out["verdict"] or ""))
    return out[:6] or ["Not enough numbers yet for a learning."]


def publish_learnings(db: Session, i: models.Initiative, text: str) -> None:
    pm = dict(i.plan_meta or {})
    pm["outcome"] = text.strip()[:2000]
    pm["learnings_published_at"] = datetime.utcnow().isoformat() + "Z"
    i.plan_meta = pm
    flag_modified(i, "plan_meta")
    db.commit()


def report_pdf(i: models.Initiative, payload: dict) -> bytes:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm, topMargin=16 * mm, bottomMargin=16 * mm,
                            title=f"{i.title} - proof")
    ss = getSampleStyleSheet()
    ink = colors.HexColor("#0B0F0E")
    h1 = ParagraphStyle("h1", parent=ss["Title"], fontName="Helvetica-Bold", fontSize=20, leading=24, textColor=ink, alignment=0, spaceAfter=4)
    h2 = ParagraphStyle("h2", parent=ss["Heading2"], fontName="Helvetica-Bold", fontSize=12.5, leading=16, textColor=ink, spaceBefore=10, spaceAfter=4)
    body = ParagraphStyle("b", parent=ss["BodyText"], fontName="Helvetica", fontSize=9.5, leading=13.5, textColor=colors.HexColor("#29302E"))
    muted = ParagraphStyle("m", parent=body, textColor=colors.HexColor("#5E6A66"), fontSize=8.5)

    def esc(s):
        return str(s if s is not None else "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    story = [Paragraph(esc(i.title), h1),
             Paragraph(esc(f"Proof report · {payload.get('period', '')} · every number with where it came from"), muted), Spacer(1, 6)]
    if payload.get("verdict"):
        story.append(Paragraph(esc(payload["verdict"]), body))
    rows = [["Target", "Actual", "Goal", "Reached", "Source"]]
    for t in payload.get("targets") or []:
        rows.append([esc(t["label"]), "—" if t.get("actual") is None else f"{t['actual']:,.0f}" if t.get("unit") != "pct" else f"{t['actual']:g}%",
                     f"{t['target']:,.0f}" if t.get("target") is not None and t.get("unit") != "pct" else f"{t.get('target')}%",
                     "—" if t.get("pct") is None else f"{t['pct']:g}%", esc({"counted": "Counted by GD360", "matched": "Matched evidence",
                                                                            "typed": "Typed by you"}.get(t.get("truth"), t.get("truth") or ""))])
    story += [Paragraph("Targets", h2)]
    tb = Table(rows, colWidths=[62 * mm, 22 * mm, 22 * mm, 20 * mm, 40 * mm], repeatRows=1)
    tb.setStyle(TableStyle([("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 8.5), ("FONT", (0, 1), (-1, -1), "Helvetica", 8.5),
                            ("LINEBELOW", (0, 0), (-1, 0), 0.6, ink), ("LINEBELOW", (0, 1), (-1, -1), 0.25, colors.HexColor("#E3E6E4")),
                            ("ALIGN", (1, 0), (3, -1), "RIGHT"), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4)]))
    story.append(tb)
    ev = payload.get("evidence") or {}
    if ev:
        story += [Paragraph("Evidence", h2), Paragraph(esc(" · ".join(f"{k.replace('_', ' ')} {v:,.0f}" for k, v in ev.items() if isinstance(v, (int, float)))), body)]
    lf = payload.get("lift") or {}
    story += [Paragraph("Lift", h2), Paragraph(esc(lf.get("verdict") or lf.get("why") or "Not measured."), body)]
    gp = payload.get("geo") or {}
    if gp.get("state") == "ok":
        story.append(Paragraph(esc(f"Geo test ({', '.join(gp.get('treated') or [])} against every other country): {gp.get('verdict')}"), body))
    pl = payload.get("pipeline") or {}
    if pl.get("sources"):
        story += [Paragraph("Pipeline (HubSpot)", h2), Paragraph(esc(f"Sourced {pl.get('sourced', 0):,.0f} in {pl.get('sourced_n', 0)} deals · influenced {pl.get('influenced', 0):,.0f} "
                                                                     f"in {pl.get('influenced_n', 0)} · won {pl.get('won', 0):,.0f} in {pl.get('won_n', 0)}. Matched by company name; truth: matched."), body)]
    if payload.get("learnings"):
        story += [Paragraph("Learnings", h2)] + [Paragraph("• " + esc(x), body) for x in payload["learnings"]]
    story += [Spacer(1, 10), Paragraph(esc("Counted: GD360 counted it. Matched: read from a connected source and matched by the tracking contract. "
                                           "Typed: entered by a person. Lift is shown as a finding only when its 90% range clears zero."), muted)]
    doc.build(story)
    return buf.getvalue()
