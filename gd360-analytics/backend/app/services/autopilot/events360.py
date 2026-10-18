"""2026-10-17 (R53): the event types Event OS was missing.

  webinar 360   registered, joined, attendance rate, viewers minute by minute, minutes watched, a hot / warm / cold
                score per attendee (hot: watched 80% or more, or asked while watching 40%; warm: 40%; cold: less), CTA clicks and replay views (tracked links), questions, pipeline - completed by
                itself 10 minutes after the webinar ends (the job marks it ready and tells the owner)
  online event  viewers per track (sessions) minute by minute, peak and drops
  meetup (solo) a report card by 9 am the next morning: came vs expected, walk-ins, the score, three lines
"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta

from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from ... import models


def _cfg(db: Session, i: models.Initiative):
    from ..eventos import core
    cfg = core.ensure_config(db, i)
    return cfg, core.Windows(i, cfg)


def _minute_curve(touches: list[models.EventTouch], start: datetime, end: datetime, key=None) -> dict:
    """Viewers per minute from join / leave touches (and viewer-count touches when a platform sends counts)."""
    groups: dict = defaultdict(list)
    for t in touches:
        groups[key(t) if key else "all"].append(t)
    out = {}
    for g, ts in groups.items():
        counts = [t for t in ts if t.kind == "stream_viewers"]
        mins = max(1, int((end - start).total_seconds() // 60))
        curve = [0.0] * mins
        if counts:
            for t in counts:
                m = int((t.occurred_at - start).total_seconds() // 60)
                if 0 <= m < mins:
                    curve[m] = max(curve[m], float(t.value or 0))
        else:
            live = defaultdict(int)
            for t in sorted(ts, key=lambda x: x.occurred_at):
                m = int((t.occurred_at - start).total_seconds() // 60)
                if t.kind == "stream_join":
                    live[max(m, 0)] += 1
                elif t.kind == "stream_leave":
                    live[max(m, 0)] -= 1
            run = 0
            for m in range(mins):
                run += live.get(m, 0)
                curve[m] = max(run, 0)
        peak = max(curve) if curve else 0
        drops = [{"minute": m, "from": curve[m - 5], "to": curve[m]} for m in range(5, mins) if curve[m - 5] > 10 and curve[m] < 0.7 * curve[m - 5]]
        out[g] = {"curve": [{"minute": m, "viewers": v} for m, v in enumerate(curve)][::max(1, mins // 180)], "peak": peak,
                  "avg": round(sum(curve) / len(curve), 1) if curve else 0, "drops": drops[:5]}
    return out


def webinar360(db: Session, i: models.Initiative) -> dict:
    cfg, w = _cfg(db, i)
    tickets = db.query(models.EventTicket).filter(models.EventTicket.initiative_id == i.id).all()
    touches = db.query(models.EventTouch).filter(models.EventTouch.initiative_id == i.id).all()
    reg = [t for t in tickets if t.status != "cancelled"]
    joined = [t for t in reg if (t.online_minutes or 0) > 0 or t.checked_in_at is not None]
    E = models.GtmEngagement
    att = db.query(E.contact_id).filter(E.initiative_id == i.id, E.kind == "webinar_attended").distinct().count()
    n_joined = max(len(joined), att)
    start, end = w.start, w.end
    curve = _minute_curve([t for t in touches if t.kind.startswith("stream")], start, end) if start and end else {}
    dur = max(1.0, (end - start).total_seconds() / 60) if start and end else 60.0
    people = []
    for t in joined:
        share = min(1.0, (t.online_minutes or 0) / dur)
        q = sum(1 for x in touches if x.ticket_id == t.id and x.kind in ("question", "poll_answer", "chat"))
        score = min(100, round(100 * share) + 20 * min(q, 2))
        heat = "hot" if share >= 0.8 or (q and share >= 0.4) else "warm" if share >= 0.4 else "cold"
        people.append({"name": t.name, "company": t.company, "minutes": round(t.online_minutes or 0), "questions": q, "score": score, "heat": heat})
    people.sort(key=lambda p: -p["score"])
    links = db.query(models.InitiativeLink).filter(models.InitiativeLink.initiative_id == i.id).all()
    cta = sum(l.clicks or 0 for l in links if (l.kind or "") in ("other", "landing_page") and "replay" not in (l.label or "").lower())
    replay = sum(l.clicks or 0 for l in links if "replay" in (l.label or "").lower() or "recording" in (l.label or "").lower())
    from . import evidence
    pipe = evidence.deals(db, i)
    qs = [x.text for x in touches if x.kind == "question" and x.text][:30]
    data = cfg.data or {}
    return {"ready": bool(data.get("webinar360_at")), "ready_at": data.get("webinar360_at"), "registered": len(reg), "joined": n_joined,
            "attendance_rate": round(100 * n_joined / len(reg), 1) if reg else None,
            "avg_minutes": round(sum(p["minutes"] for p in people) / len(people), 1) if people else None, "minutes_planned": round(dur),
            "viewers": curve.get("all") or {"curve": [], "peak": 0, "avg": 0, "drops": []},
            "heat": {"hot": sum(1 for p in people if p["heat"] == "hot"), "warm": sum(1 for p in people if p["heat"] == "warm"),
                     "cold": sum(1 for p in people if p["heat"] == "cold")},
            "people": people[:100], "cta_clicks": cta, "replay_views": replay, "questions": qs,
            "pipeline": {k: pipe.get(k) for k in ("sourced", "sourced_n", "influenced", "won")},
            "truth": "counted (Zoom / Teams attendance, GD360 links), pipeline matched"}


def online(db: Session, i: models.Initiative) -> dict:
    cfg, w = _cfg(db, i)
    sessions = {s.id: s.title for s in db.query(models.EventSession).filter(models.EventSession.initiative_id == i.id)}
    touches = [t for t in db.query(models.EventTouch).filter(models.EventTouch.initiative_id == i.id) if t.kind.startswith("stream")]
    if not (w.start and w.end):
        return {"tracks": [], "note": "Set the start and end times in Setup."}
    by = _minute_curve(touches, w.start, w.end, key=lambda t: sessions.get(t.session_id, "Main stage") if t.session_id else "Main stage")
    return {"tracks": [{"track": k, **v} for k, v in sorted(by.items(), key=lambda kv: -kv[1]["peak"])],
            "note": "Viewers from the stream platform's join and leave events (Zoom webhook, or counts posted to the occupancy hook)."}


def solo_card(db: Session, i: models.Initiative) -> dict:
    cfg, w = _cfg(db, i)
    tickets = db.query(models.EventTicket).filter(models.EventTicket.initiative_id == i.id).all()
    came = [t for t in tickets if t.checked_in_at is not None]
    walk = [t for t in came if t.walk_in]
    reg = [t for t in tickets if not t.walk_in and t.status != "cancelled"]
    expected = round(sum((t.show_prob if t.show_prob is not None else 0.6) for t in reg)) if reg else None
    target = next((t.get("target") for t in i.targets or [] if t.get("key") in ("attended", "registrations")), None)
    score = None
    if target:
        score = round(min(100.0, 70.0 * len(came) / float(target)) if len(came) <= float(target) else min(100.0, 70 + 30 * (len(came) - float(target)) / max(float(target) * 0.3, 1)))
    lines = [f"{len(came)} came" + (f" of {expected} expected" if expected else "") + f", {len(walk)} walked in."]
    if reg:
        lines.append(f"{round(100 * (len(came) - len(walk)) / len(reg))}% of registrations showed up.")
    lines.append("Thank-you note and the photo post are drafted in Follow-up.")
    return {"came": len(came), "expected": expected, "walk_ins": len(walk), "registered": len(reg), "score": score, "lines": lines,
            "ready_at": (cfg.data or {}).get("solo_card_at")}


def tick(db: Session, now: datetime | None = None) -> list[str]:
    """Webinar 360 ten minutes after the end; the solo meetup card at 9 am the next morning (local)."""
    from ..eventos import core
    from . import policy
    now = now or datetime.utcnow()
    done = []
    for cfg in db.query(models.EventConfig).all():
        data = dict(cfg.data or {})
        if data.get("sample"):
            continue
        i = db.get(models.Initiative, cfg.initiative_id)
        if i is None or i.status == "archived":
            continue
        w = core.Windows(i, cfg)
        if not w.end:
            continue
        if (cfg.format in ("webinar", "online") or i.kind == "webinar") and not data.get("webinar360_at") and now >= w.end + timedelta(minutes=10):
            r = webinar360(db, i)
            data["webinar360_at"] = now.isoformat() + "Z"
            cfg.data = data
            flag_modified(cfg, "data")
            policy.propose(db, i, "Follow-up", "digest", f"Webinar 360 ready: {r['joined']} joined of {r['registered']}",
                           detail=f"Attendance {r['attendance_rate']}%, peak {r['viewers']['peak']:g} viewers, {r['heat']['hot']} hot attendees.",
                           payload={"result": "Webinar 360 completed"}, key=f"w360:{i.id}")
            done.append(f"webinar360:{i.id}")
        local_end = core.to_local(w.end, w.tz)
        if cfg.mode == "solo" and not data.get("solo_card_at") and local_end:
            nine = datetime(local_end.year, local_end.month, local_end.day, 9, 0) + timedelta(days=1)
            if core.to_local(now, w.tz) >= nine:
                card = solo_card(db, i)
                data["solo_card_at"] = now.isoformat() + "Z"
                cfg.data = data
                flag_modified(cfg, "data")
                policy.propose(db, i, "Follow-up", "digest", f"Meetup report card: {card['came']} came" + (f", score {card['score']:g}" if card["score"] is not None else ""),
                               detail=" ".join(card["lines"]), payload={"result": "Report card ready"}, key=f"solo:{i.id}")
                done.append(f"solo:{i.id}")
    db.commit()
    return done
