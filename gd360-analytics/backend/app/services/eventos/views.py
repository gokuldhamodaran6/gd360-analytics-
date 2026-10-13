"""The payload behind each Event OS screen."""
from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timedelta

from ... import models
from . import core, forecast
from . import score as score_mod
from .ctx import METRICS, Ctx

iso = core.iso


def kpi(ctx: Ctx, key: str, sub: str | None = None, label: str | None = None, value=None, truth: str | None = None,
        unit: str | None = None) -> dict:
    m = METRICS.get(key, (key, "count", "counted", "all", True))
    v = ctx.values().get(key) if value is None else value
    return {"key": key, "label": label or m[0], "value": v, "unit": unit or m[1], "truth": truth or m[2], "sub": sub}


def money_unit(ctx: Ctx) -> str:
    return (ctx.data.get("currency") or "INR").upper()


def event_head(ctx: Ctx) -> dict:
    i, cfg, w = ctx.i, ctx.cfg, ctx.w
    return {"id": i.id, "title": i.title, "kind": i.kind, "format": cfg.format,
            "format_label": core.FORMATS.get(cfg.format, {}).get("label"), "mode": cfg.mode, "location": i.location,
            "capacity": cfg.capacity, "fire_limit": cfg.fire_limit, "code": cfg.code, "windows": w.as_dict(),
            "phase_now": w.now_phase(ctx.now), "days_to_go": w.days_to_go(ctx.now), "sample": ctx.sample,
            "currency": money_unit(ctx), "online": ctx.online, "physical": core.FORMATS.get(cfg.format, {}).get("physical", True),
            "status": i.status, "registration_link": None}


def _score_block(ctx: Ctx) -> dict:
    goals = score_mod.contract(ctx)
    now = score_mod.event_score(goals)
    regs = forecast.registrations(ctx)
    su = forecast.showup(ctx, write=False) if ctx.registered else None
    sim = forecast.simulate(ctx, goals, regs, su) if goals else None
    for g in goals:
        g["likelihood"] = (sim or {}).get("goals", {}).get(g["id"])
    truth_w = Counter()
    for g in goals:
        if g.get("actual") is not None:
            truth_w[g["truth"]] += g["weight"] or 0
    tw = sum(truth_w.values())
    hist = list((ctx.data.get("score_history") or []))
    today = ctx.now.date().isoformat()
    point = now["score"] if ctx.w.now_phase(ctx.now) in ("after", "done") and now["score"] is not None else (sim or {}).get("median")
    if point is not None and (not hist or hist[-1].get("date") != today):
        if not ctx.sample:
            hist = (hist + [{"date": today, "score": point, "phase": ctx.w.now_phase(ctx.now)}])[-200:]
            ctx.cfg.data = {**(ctx.cfg.data or {}), "score_history": hist}
    return {"goals": goals, "now": now, "predicted": sim, "history": hist,
            "truth_mix": {k: round(100 * v / tw) for k, v in truth_w.items()} if tw else {},
            "signed": sum(1 for g in goals if g["signed"]), "total": len(goals)}


def setup_checks(ctx: Ctx) -> list[dict]:
    i, cfg = ctx.i, ctx.cfg
    db = ctx.db
    social = 0
    if i.workspace_id and not ctx.sample:
        social = db.query(models.DataSource.id).filter(models.DataSource.workspace_id == i.workspace_id,
                                                       models.DataSource.kind.in_(("instagram", "facebook_pages", "linkedin_pages", "youtube"))).count()
    adsrc = len(ctx.ads()["sources"])
    assets = db.query(models.EventAsset.id).filter(models.EventAsset.initiative_id == i.id).count()
    physical = core.FORMATS.get(cfg.format, {}).get("physical", True)
    from ..automations import email_configured
    checks = [
        ("when", "Date and time set", bool(cfg.starts_at), "Set the start and end time"),
        ("goals", "Success agreed and signed", bool(ctx.goals) and all(g.signed_at for g in ctx.goals),
         f"{sum(1 for g in ctx.goals if g.signed_at)} of {len(ctx.goals)} goals signed" if ctx.goals else "Add the expectation contract"),
        ("hashtag", "Hashtag and event code", bool(cfg.hashtags) and bool(cfg.code), "Add a hashtag"),
        ("brand", "Brand images for picture matching", assets > 0 or ctx.sample, "Upload the banner or logo"),
        ("social", "Own social accounts connected", social > 0 or ctx.sample, "Connect Instagram, LinkedIn, Facebook or YouTube"),
        ("ads", "Ad accounts connected", adsrc > 0 or ctx.sample, "Connect Meta Ads or Google Ads"),
        ("registration", "Registration page open", bool(i.registration_open) or ctx.w.now_phase(ctx.now) != "before", "Open registration"),
        ("email", "Email set up (confirmations, survey)", email_configured() or ctx.sample, "Set RESEND_API_KEY"),
    ]
    if physical:
        checks.append(("capacity", "Capacity and fire limit", bool(cfg.capacity), "Add capacity"))
        checks.append(("staff", "Staff app link shared", bool((cfg.data or {}).get("staff_opened")) or ctx.sample, "Open the staff app on a phone"))
    if cfg.format in ("offline", "hybrid", "booth", "festival") and ctx.sponsors == [] and cfg.mode in ("pro", "mega"):
        checks.append(("sponsors", "Sponsors added", False, "Add sponsors and their lead goals"))
    return [{"key": k, "label": l, "ok": bool(ok), "fix": f} for k, l, ok, f in checks]


def overview(ctx: Ctx) -> dict:
    v = ctx.values()
    head = event_head(ctx)
    sc = _score_block(ctx)
    cur = money_unit(ctx)
    online = ctx.online
    before = [kpi(ctx, "registrations", sub=f"{v['icp_registrations']} fit the ICP" if v.get("icp_registrations") else None),
              kpi(ctx, "icp_share_registrations"),
              kpi(ctx, "ad_spend", sub="synced from ad accounts"),
              kpi(ctx, "mentions_before"),
              kpi(ctx, "cost_per_icp_registration")]
    if online:
        during = [kpi(ctx, "attended", label="Joined live"), kpi(ctx, "attendance_rate"), kpi(ctx, "stream_peak", label="Peak at once"),
                  kpi(ctx, "avg_watch_minutes"), kpi(ctx, "questions"), kpi(ctx, "cta_clicks")]
    else:
        during = [kpi(ctx, "attended", sub=f"{v['icp_share_attended']:.0f}% ICP" if v.get("icp_share_attended") is not None else None),
                  kpi(ctx, "walk_ins"), kpi(ctx, "stream_peak"), kpi(ctx, "meetings"),
                  kpi(ctx, "sponsor_leads", sub=f"{v['sponsor_leads_avg']:.0f} per sponsor" if v.get("sponsor_leads_avg") else None),
                  kpi(ctx, "max_queue_minutes")]
    after = [kpi(ctx, "mentions_after"), kpi(ctx, "replay_views"), kpi(ctx, "nps", sub=f"{v['nps_answers']} answers" if v.get("nps_answers") else None),
             kpi(ctx, "pipeline_sourced", sub=f"{ctx.deals()['sourced_n']} deals" if ctx.deals()["sourced_n"] else None),
             kpi(ctx, "won"), kpi(ctx, "roi_pct")]
    reach = v.get("reach")
    funnel = [r for r in [
        {"stage": "Reached by posts", "value": reach, "truth": "reported"},
        {"stage": "Registered", "value": v["registrations"], "truth": "counted"},
        {"stage": "Came" if not online else "Joined", "value": v["attended"], "truth": "counted"},
        {"stage": "ICP who came", "value": v.get("icp_attended"), "truth": "counted"},
        {"stage": "Meetings", "value": v.get("meetings"), "truth": "counted"},
        {"stage": "Deals started", "value": ctx.deals()["sourced_n"] or None, "truth": "matched"},
        {"stage": "Won", "value": ctx.deals()["won_n"] or None, "truth": "matched"},
    ] if r["value"]]
    from . import agent
    acts = agent.list_actions(ctx, refresh=True)
    checks = setup_checks(ctx)
    return {"event": head, "score": sc, "kpis": {"before": before, "during": during, "after": after},
            "daily": ctx.daily(), "funnel": funnel, "channels": ctx.channels()[:8], "currency": cur,
            "setup": {"checks": checks, "ready": round(100 * sum(1 for c in checks if c["ok"]) / len(checks))},
            "actions": [a for a in acts if a["state"] == "proposed"][:6],
            "values": {k: v.get(k) for k in ("registrations", "attended", "mentions", "review_queue", "total_cost", "income")}}


def growth(ctx: Ctx) -> dict:
    v = ctx.values()
    regs = forecast.registrations(ctx)
    daily = ctx.daily()
    cum, run = [], 0
    for r in daily:
        run += r["registrations"]
        cum.append({"date": r["date"], "actual": run, "phase": r["phase"]})
    landing = None
    try:
        from ..initiatives import metrics as im
        landing = im.compute(ctx.db, ctx.i)["values"] if not ctx.sample else None
    except Exception:  # noqa: BLE001
        landing = None
    visits = (ctx.data.get("sample_funnel") or {}).get("visits") if ctx.sample else (landing or {}).get("landing_visits")
    started = (ctx.data.get("sample_funnel") or {}).get("started") if ctx.sample else None
    confirmed = sum(1 for t in ctx.registered if t.confirmed_at)
    funnel = [x for x in [
        {"stage": "Page visits", "value": visits},
        {"stage": "Started the form", "value": started},
        {"stage": "Registered", "value": v["registrations"]},
        {"stage": "Confirmed", "value": confirmed or None},
        {"stage": "ICP fit", "value": v.get("icp_registrations") or None},
    ] if x["value"]]
    target = next((g.target for g in ctx.goals if g.metric == "registrations"), None)
    att_goal = next((g for g in ctx.goals if g.metric == "attended"), None)
    if target is None and att_goal:
        su = forecast.showup(ctx, write=False)
        rate = (su.get("rate") or 60) / 100.0
        target = round(att_goal.target / max(rate, 0.2))
    odds = None
    if regs and target and regs.get("median") is not None and not regs.get("done"):
        import math
        sd = max((regs["p90"] - regs["p10"]) / 2.56, 1.0)
        z = (regs["median"] - target) / sd
        odds = round(100 * 0.5 * (1 + math.erf(z / math.sqrt(2))))
    from . import agent
    acts = [a for a in agent.list_actions(ctx, refresh=True) if a["phase"] in ("before", None) and a["state"] == "proposed"]
    spark = [r["registrations"] for r in daily[-14:]]
    return {"event": event_head(ctx), "cumulative": cum, "forecast": regs, "target": target, "odds": odds, "funnel": funnel,
            "channels": ctx.channels(), "ads": ctx.ads(), "kpis": [
                kpi(ctx, "registrations", sub=f"+{daily[-1]['registrations']} today" if daily else None),
                kpi(ctx, "icp_share_registrations"),
                kpi(ctx, "cost_per_icp_registration"),
                {"key": "forecast", "label": "Forecast by the event day", "value": regs.get("median") if regs else None, "unit": "count",
                 "truth": "modelled", "sub": f"{odds}% chance of {target:,.0f}" if odds is not None and target else (regs or {}).get("basis")},
                kpi(ctx, "mentions_before"),
            ], "spark": spark, "actions": acts[:5], "currency": money_unit(ctx)}


def mention_row(m: models.EventMention, ctx: Ctx) -> dict:
    return {"id": m.id, "platform": m.platform, "author": m.author, "author_kind": m.author_kind, "url": m.url,
            "text": (m.text or "")[:600], "media_url": m.media_url, "posted_at": iso(m.posted_at), "reach": m.reach,
            "engagements": m.engagements, "matched_by": m.matched_by, "confidence": m.confidence,
            "why": (m.why or {}).get("text"), "state": m.state, "sentiment": m.sentiment,
            "phase": ctx.phase_of(m.posted_at or m.created_at)}


def buzz(ctx: Ctx, phase: str | None = None, state: str | None = None, platform: str | None = None,
         limit: int = 60, offset: int = 0) -> dict:
    v = ctx.values()
    ms = ctx.mentions
    per = {ph: ctx.mentions_in(ph) for ph in ("before", "during", "after")}
    w = ctx.w
    lo = (w.start - timedelta(days=14)) if w.start else ctx.now - timedelta(days=30)
    hi = min(ctx.now, (w.end + timedelta(days=21)) if w.end else ctx.now)
    days = []
    d = lo.date()
    by_day: dict[str, Counter] = defaultdict(Counter)
    for m in ms:
        at = m.posted_at or m.created_at
        if at:
            by_day[at.date().isoformat()][m.author_kind or "public"] += 1
    while d <= hi.date() and len(days) < 120:
        k = d.isoformat()
        c = by_day.get(k, Counter())
        days.append({"date": k, "phase": ctx.phase_of(datetime(d.year, d.month, d.day, 12)),
                     "attendee": c.get("attendee", 0), "speaker": c.get("speaker", 0) + c.get("sponsor", 0),
                     "own": c.get("own", 0), "press": c.get("press", 0) + c.get("creator", 0) + c.get("public", 0)})
        d += timedelta(days=1)
    kinds = Counter(m.author_kind or "public" for m in ms)
    plats = Counter(m.platform for m in ms)
    how = Counter(m.matched_by or "manual" for m in ms)
    sel = ctx.mentions_all
    if state:
        sel = [m for m in sel if m.state == state]
    else:
        sel = [m for m in sel if m.state != "rejected"]
    if phase in ("before", "during", "after"):
        sel = [m for m in sel if ctx.phase_of(m.posted_at or m.created_at) == phase]
    if platform:
        sel = [m for m in sel if m.platform == platform]
    sel.sort(key=lambda m: -((m.reach or 0) + 50 * (m.engagements or 0)) if not state else -(m.posted_at or m.created_at).timestamp())
    voices = defaultdict(lambda: {"posts": 0, "reach": 0.0})
    for m in ms:
        voices[m.author_kind or "public"]["posts"] += 1
        voices[m.author_kind or "public"]["reach"] += m.reach or 0
    snt = Counter(m.sentiment or "neutral" for m in ms)
    negs = [mention_row(m, ctx) for m in ms if m.sentiment == "negative"][:5]
    posted_tickets = {m.ticket_id for m in ms if m.ticket_id}
    att = ctx.came
    return {"event": event_head(ctx), "counts": {ph: len(x) for ph, x in per.items()}, "total": len(ms),
            "review": v.get("review_queue") or 0, "reach": v.get("reach"), "engagements": v.get("engagements"),
            "positive_share": v.get("positive_share"), "sentiment": dict(snt), "kinds": dict(kinds), "platforms": dict(plats),
            "matched_by": dict(how), "days": days,
            "voices": [{"kind": k, **x, "reach": round(x["reach"])} for k, x in sorted(voices.items(), key=lambda kv: -kv[1]["posts"])],
            "items": [mention_row(m, ctx) for m in sel[offset:offset + limit]], "items_total": len(sel),
            "complaints": negs, "scan": (ctx.data or {}).get("last_scan"), "last_scan_at": (ctx.data or {}).get("last_scan_at"),
            "attendee_posters": sum(1 for m in ms if m.author_kind == "attendee"), "attendees": len(att),
            "matched_to_ticket": len(posted_tickets)}


def demand(ctx: Ctx) -> dict:
    v = ctx.values()
    su = forecast.showup(ctx, write=True)
    regs = forecast.registrations(ctx)
    accounts = None
    if not ctx.sample and ctx.i.workspace_id:
        from ..initiatives import metrics as im
        aud = ctx.i.audience or {"tiers": ["A"]}
        ids = [r[0] for r in im.audience_query(ctx.db, ctx.i.workspace_id, aud).with_entities(models.GtmAccount.id).limit(5000)]
        have = {t.account_id for t in ctx.registered if t.account_id}
        covered = [x for x in ids if x in have]
        accounts = {"target": len(ids), "covered": len(covered), "missing": len(ids) - len(covered)}
    elif ctx.sample:
        accounts = ctx.data.get("sample_accounts")
    mult = (regs["median"] / max(v["registrations"], 1)) if regs and regs.get("median") and not regs.get("done") else 1.0
    predicted = round((su["expected"] + su["walkins_expected"]) * mult)
    seniority = Counter((t.seniority or "Unknown") for t in ctx.registered)
    cities = Counter((t.city or "Unknown") for t in ctx.registered)
    from . import agent
    acts = [a for a in agent.list_actions(ctx, refresh=True) if a["phase"] in ("before", None)]
    cap = ctx.cfg.capacity
    return {"event": event_head(ctx), "showup": su, "forecast": regs, "predicted_attendance": predicted,
            "icp_predicted": round(predicted * (v.get("icp_share_registrations") or 0) / 100) if v.get("icp_share_registrations") else None,
            "capacity": cap, "fire_limit": ctx.cfg.fire_limit, "accounts": accounts,
            "seniority": [{"label": k, "n": n} for k, n in seniority.most_common(6)],
            "cities": [{"label": k, "n": n} for k, n in cities.most_common(6)],
            "meetings_booked": sum(1 for t in ctx.registered if (t.data or {}).get("meeting")),
            "actions": acts[:6]}


def _arrival_plan(expected: float, start_local: datetime) -> list[float]:
    """Share of the day's arrivals by each 10 minutes from 1 h before the
    start to 3 h after (a typical conference arrival curve)."""
    import math
    out = []
    for k in range(25):
        t = -60 + 10 * k  # minutes from the start
        out.append(expected / (1 + math.exp(-(t - 5) / 22)))
    return out


def live(ctx: Ctx) -> dict:
    v = ctx.values()
    w = ctx.w
    tz = w.tz
    day_start = None
    if w.start:
        # the event day we're on (or the first)
        now_local = core.to_local(ctx.now, tz)
        d0 = w.start_local
        day_start = d0.replace(year=now_local.year, month=now_local.month, day=now_local.day) if (w.start <= ctx.now <= (w.end or ctx.now)) else d0
    arrivals, plan = [], []
    if day_start:
        start_utc = core.to_utc(day_start, tz)
        first = start_utc - timedelta(minutes=60)
        buckets = [0] * 25
        for t in ctx.tickets:
            if t.checked_in_at and first <= t.checked_in_at < first + timedelta(minutes=250):
                buckets[int((t.checked_in_at - first).total_seconds() // 600)] += 1
        run = 0
        su_rate = (forecast.showup(ctx, write=False).get("expected") or 0) if ctx.registered else 0
        expected_day = su_rate if not ctx.sample else (ctx.data.get("sample_plan_day") or su_rate)
        pl = _arrival_plan(expected_day, day_start)
        for k in range(25):
            run += buckets[k]
            label = (day_start - timedelta(minutes=60) + timedelta(minutes=10 * k)).strftime("%H:%M")
            at = first + timedelta(minutes=10 * k)
            arrivals.append({"t": label, "actual": run if at <= ctx.now else None, "plan": round(pl[k])})
    zones_cfg = ctx.cfg.zones or []
    latest: dict[str, models.EventTouch] = {}
    for x in ctx.by_kind.get("occupancy", []):
        if x.zone and (x.zone not in latest or x.occurred_at > latest[x.zone].occurred_at):
            latest[x.zone] = x
    zones = []
    for z in zones_cfg:
        zid = str(z.get("id") or z.get("name"))
        last = latest.get(zid)
        cap = z.get("capacity") or None
        n = int(last.value) if last and last.value is not None else None
        zones.append({**z, "id": zid, "now": n, "pct": round(100 * n / cap) if n is not None and cap else None,
                      "at": iso(last.occurred_at) if last else None})
    in_hall = sum(z["now"] or 0 for z in zones if not z.get("outside")) if zones else None
    sess = sessions_rows(ctx)
    queue = sorted(ctx.by_kind.get("queue", []), key=lambda x: x.occurred_at)[-12:]
    stream = sorted(ctx.by_kind.get("stream_viewers", []), key=lambda x: x.occurred_at)
    feed = []
    for t in sorted([t for t in ctx.tickets if t.checked_in_at], key=lambda t: t.checked_in_at, reverse=True)[:12]:
        feed.append({"at": iso(t.checked_in_at), "kind": "walk_in" if t.walk_in else "check_in", "who": t.name or "Guest",
                     "company": t.company, "tier": t.tier, "gate": t.gate, "icp": t.icp})
    from . import agent
    acts = [a for a in agent.list_actions(ctx, refresh=True) if a["phase"] == "during"]
    return {"event": event_head(ctx), "kpis": [
        kpi(ctx, "attended", label="Checked in" if not ctx.online else "Joined"),
        kpi(ctx, "walk_ins"),
        {"key": "in_hall", "label": "In the venue now", "value": in_hall, "unit": "count", "truth": "counted",
         "sub": f"fire limit {ctx.cfg.fire_limit:,}" if ctx.cfg.fire_limit else None},
        kpi(ctx, "max_queue_minutes"), kpi(ctx, "meetings"), kpi(ctx, "stream_peak")],
        "arrivals": arrivals, "zones": zones, "sessions": sess,
        "queue": [{"at": iso(x.occurred_at), "zone": x.zone, "minutes": x.value} for x in queue],
        "stream": [{"at": iso(x.occurred_at), "viewers": x.value, "minute": (x.data or {}).get("minute"), "session_id": x.session_id} for x in stream[-300:]],
        "feed": feed, "actions": acts[:8], "staff": {"key_set": True}}


def sessions_rows(ctx: Ctx) -> list[dict]:
    scans = Counter(x.session_id for x in ctx.by_kind.get("session_scan", []) if x.session_id)
    ratings = defaultdict(list)
    for x in ctx.by_kind.get("rating", []):
        if x.session_id and x.value:
            ratings[x.session_id].append(x.value)
    peak = defaultdict(float)
    for x in ctx.by_kind.get("stream_viewers", []):
        if x.session_id:
            peak[x.session_id] = max(peak[x.session_id], x.value or 0)
    out = []
    for s in ctx.sessions:
        n = scans.get(s.id, 0)
        r = ratings.get(s.id) or []
        out.append({"id": s.id, "title": s.title, "speaker": s.speaker, "room": s.room, "track": s.track,
                    "starts_at": s.starts_at.isoformat() if s.starts_at else None, "ends_at": s.ends_at.isoformat() if s.ends_at else None,
                    "capacity": s.capacity, "online": bool(s.online), "in_room": n,
                    "fill": round(100 * n / s.capacity) if s.capacity else None, "online_peak": int(peak[s.id]) if peak.get(s.id) else None,
                    "rating": round(sum(r) / len(r), 1) if r else None, "ratings": len(r)})
    return out


def sponsors(ctx: Ctx) -> dict:
    leads_by = defaultdict(list)
    for l in ctx.leads:
        leads_by[l.sponsor_id].append(l)
    visits = Counter(x.sponsor_id for x in ctx.by_kind.get("booth_visit", []) if x.sponsor_id)
    dwell = defaultdict(list)
    for x in ctx.by_kind.get("booth_visit", []):
        if x.sponsor_id and x.value:
            dwell[x.sponsor_id].append(x.value)
    from ..automations import app_url
    rows = []
    for s in ctx.sponsors:
        ls = leads_by.get(s.id, [])
        hot = sum(1 for l in ls if (l.rating or 0) >= 4)
        rows.append({"id": s.id, "name": s.name, "tier": s.tier, "booth": s.booth, "goal": s.goal_leads, "leads": len(ls), "hot": hot,
                     "pct": round(100 * len(ls) / s.goal_leads) if s.goal_leads else None, "visits": visits.get(s.id, 0),
                     "dwell_min": round(sum(dwell[s.id]) / len(dwell[s.id]), 1) if dwell.get(s.id) else None,
                     "renewal": s.renewal, "amount": s.amount, "contact_email": s.contact_email,
                     "report_link": f"{app_url()}/sp/{s.token}", "scan_link": f"{app_url()}/staff/{ctx.i.public_token}?k={s.staff_key}&sp={s.id}"})
    rows.sort(key=lambda r: -(r["leads"]))
    sen = Counter()
    for l in ctx.leads:
        sen[_seniority(l.title)] += 1
    return {"event": event_head(ctx), "sponsors": rows, "total_leads": len(ctx.leads),
            "avg": round(len(ctx.leads) / len(ctx.sponsors), 1) if ctx.sponsors else None,
            "renewing": sum(1 for s in ctx.sponsors if s.renewal in ("signed", "verbal")),
            "seniority": [{"label": k, "n": n} for k, n in sen.most_common()]}


def _seniority(title: str | None) -> str:
    t = (title or "").lower()
    if any(x in t for x in ("chief", "cxo", "ceo", "cto", "cfo", "coo", "cio", "founder", "president", "owner")):
        return "CXO / founder"
    if any(x in t for x in ("vp", "vice president", "director", "head")):
        return "VP / director"
    if "manager" in t or "lead" in t:
        return "Manager / lead"
    return "Individual" if t else "Unknown"


def sponsor_report(ctx: Ctx, s: models.EventSponsor) -> dict:
    ls = [l for l in ctx.leads if l.sponsor_id == s.id]
    visits = [x for x in ctx.by_kind.get("booth_visit", []) if x.sponsor_id == s.id]
    by_hour = defaultdict(lambda: defaultdict(int))
    for x in visits:
        loc = core.to_local(x.occurred_at, ctx.w.tz)
        by_hour[loc.date().isoformat()][loc.hour] += 1
    days = sorted(by_hour)
    hours = sorted({h for d in by_hour.values() for h in d}) or list(range(9, 18))
    sen = Counter(_seniority(l.title) for l in ls)
    dwell = [x.value for x in visits if x.value]
    sess = [s2 for s2 in sessions_rows(ctx) if s.name.lower() in (s2.get("speaker") or "").lower() or s.name.lower() in (s2.get("title") or "").lower()]
    return {"sponsor": {"id": s.id, "name": s.name, "tier": s.tier, "booth": s.booth, "goal": s.goal_leads, "renewal": s.renewal,
                        "renewal_at": iso(s.renewal_at)},
            "event": {"title": ctx.i.title, "start": ctx.w.as_dict()["start_local"], "location": ctx.i.location, "sample": ctx.sample, "currency": money_unit(ctx)},
            "leads": len(ls), "hot": sum(1 for l in ls if (l.rating or 0) >= 4), "visits": len(visits),
            "dwell_min": round(sum(dwell) / len(dwell), 1) if dwell else None,
            "by_hour": {"days": days, "hours": hours, "rows": [[by_hour[d].get(h, 0) for h in hours] for d in days]},
            "seniority": [{"label": k, "n": n} for k, n in sen.most_common()],
            "interests": Counter(i for l in ls for i in (l.interests or [])).most_common(8),
            "sessions": sess, "crm": (s.data or {}).get("crm")}


def report(ctx: Ctx) -> dict:
    v = ctx.values()
    sc = _score_block(ctx)
    deltas = []
    for g in sc["goals"]:
        if g["actual"] is None or g["score"] is None:
            continue
        deltas.append({"label": g["label"], "owner": g["owner_name"], "delta": round(g["score"] - 70, 1), "score": g["score"],
                       "actual": g["actual"], "target": g["target"], "unit": g["unit"]})
    deltas.sort(key=lambda d: -abs(d["delta"]))
    learnings = list((ctx.data or {}).get("learnings") or [])
    if not learnings:
        learnings = draft_learnings(ctx)
    return {"event": event_head(ctx), "score": sc, "values": v, "costs": ctx.costs(), "income": ctx.income_lines(),
            "deals": ctx.deals(), "channels": ctx.channels(), "drivers": deltas[:6], "learnings": learnings,
            "sessions": sessions_rows(ctx)[:12], "sponsors": sponsors(ctx)["sponsors"][:12], "currency": money_unit(ctx),
            "buzz": {"before": v.get("mentions_before"), "during": v.get("mentions_during"), "after": v.get("mentions_after"),
                     "reach": v.get("reach"), "positive_share": v.get("positive_share")}}


def draft_learnings(ctx: Ctx) -> list[dict]:
    """Learnings with their proof, drafted from the numbers - the owner
    keeps, edits or deletes them."""
    out = []
    ch = [c for c in ctx.channels() if c.get("registrations", 0) >= 10]
    priced = [c for c in ch if c.get("cost_per_icp")]
    if priced:
        best = min(priced, key=lambda c: c["cost_per_icp"])
        worst = max(priced, key=lambda c: c["cost_per_icp"])
        out.append({"kind": "keep", "title": f"{best['channel']} brought ICP people for the least",
                    "proof": f"{money_unit(ctx)} {best['cost_per_icp']:,} per ICP registration, {best.get('icp_share') or 0:.0f}% ICP"})
        if worst["channel"] != best["channel"]:
            out.append({"kind": "change", "title": f"{worst['channel']} cost the most per ICP person",
                        "proof": f"{money_unit(ctx)} {worst['cost_per_icp']:,} per ICP registration"})
    shows = [c for c in ch if c.get("show_rate") is not None]
    if shows:
        low = min(shows, key=lambda c: c["show_rate"])
        if low["show_rate"] < 55:
            out.append({"kind": "change", "title": f"Registrants from {low['channel']} often didn't come",
                        "proof": f"{low['show_rate']:.0f}% came · ask them to confirm a week before"})
    neg = [m for m in ctx.mentions if m.sentiment == "negative"]
    if neg:
        words = Counter(w for m in neg for w in ("parking", "queue", "wifi", "food", "late", "crowded", "audio", "sound") if w in (m.text or "").lower())
        if words:
            w, n = words.most_common(1)[0]
            out.append({"kind": "fix", "title": f"People complained about {w}", "proof": f"{n} posts mention it"})
    v = ctx.values()
    if v.get("nps") is not None:
        out.append({"kind": "keep" if v["nps"] >= 40 else "change", "title": f"NPS {v['nps']}",
                    "proof": f"{v.get('nps_answers')} answers"})
    return out[:9]
