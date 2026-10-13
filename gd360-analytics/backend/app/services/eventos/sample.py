"""A complete sample event - "Euliv AI Summit (sample)" - so every Event OS
screen can be explored with realistic numbers before a real event has
any. Everything is fictional: people, companies, sponsors, posts, deals.
No contacts or accounts are created (your CRM stays clean); emails end in
.example so nothing can ever be sent to them.

One generator writes the whole story of the event, then keeps only what
has happened by "now" for the chosen moment:
  before  24 days to go   (registrations, forecast, show-up, posts before)
  live    day 1, mid-morning (check-ins, rooms, queues, stream, leads)
  done    90 days after    (the final report: score, pipeline, ROI)"""
from __future__ import annotations

import math
import random
from datetime import date, datetime, timedelta

from sqlalchemy.orm import Session

from ... import models
from . import core

FIRST = ["Aarav", "Vivaan", "Aditya", "Arjun", "Sai", "Reyansh", "Krishna", "Ishaan", "Rohan", "Kabir", "Ananya", "Diya", "Priya",
         "Meera", "Kavya", "Sneha", "Riya", "Aditi", "Neha", "Pooja", "Rahul", "Vikram", "Karthik", "Nikhil", "Siddharth", "Varun",
         "Deepa", "Lakshmi", "Shreya", "Tanvi", "Harsh", "Manish", "Sanjay", "Ravi", "Suresh", "Divya", "Nandini", "Ishita", "Zara",
         "Farhan", "Imran", "Ayesha", "Joel", "Maria", "Rachel", "Daniel", "Wei", "Mei", "Hiro", "Lena", "Omar", "Sara", "Arun",
         "Gokul", "Prakash", "Bhavya", "Tejas", "Yash", "Pranav", "Akash"]
LAST = ["Sharma", "Iyer", "Rao", "Reddy", "Nair", "Menon", "Gupta", "Kulkarni", "Patel", "Shah", "Mehta", "Verma", "Singh", "Das",
        "Pillai", "Krishnan", "Joshi", "Bhat", "Kapoor", "Chatterjee", "Banerjee", "Mukherjee", "Agarwal", "Malhotra", "Saxena",
        "Hegde", "Shetty", "Naidu", "Varghese", "Thomas", "D'Souza", "Khan", "Ali", "Sinha", "Mishra", "Pandey", "Chopra", "Bose",
        "Fernandes", "Tan", "Lim", "Wong", "Sato", "Fischer", "Haddad", "Prasad", "Ganesh", "Raman", "Subramanian", "Murthy"]
CO_A = ["Nimbus", "Larkspur", "Orbit", "Corvex", "Tessera", "Quanta", "Helio", "Kestrel", "Arcadia", "Bluefin", "Meridian", "Sable",
        "Vertex", "Lumen", "Cobalt", "Zephyr", "Indigo", "Saffron", "Banyan", "Peacock", "Monsoon", "Cascade", "Granite", "Juniper",
        "Falcon", "Atlas", "Nova", "Polar", "Ember", "Harbor", "Summit", "Pioneer", "Beacon", "Crest", "Delta", "Echo", "Fusion",
        "Ganges", "Horizon", "Ion", "Jade", "Kite", "Lotus", "Maple", "Neem", "Opal", "Prism", "Quill", "Ridge", "Silica", "Tide"]
CO_B = ["Bank", "Pay", "Labs", "Cloud", "Analytics", "Data", "AI", "Health", "Logistics", "Retail", "Insurance", "Motors", "Telecom",
        "Foods", "Systems", "Robotics", "Energy", "Capital", "Software", "Networks", "Media", "Pharma", "Edtech", "Fintech"]
TITLES = {"CXO / founder": ["CTO", "CEO", "Chief Data Officer", "Co-founder", "CIO"],
          "VP / director": ["VP Engineering", "Director of Data", "Head of Analytics", "VP Product", "Head of AI"],
          "Manager / lead": ["Data Platform Lead", "Engineering Manager", "Analytics Manager", "ML Lead", "Product Manager"],
          "Individual": ["Data Scientist", "ML Engineer", "Data Engineer", "Analyst", "Software Engineer"],
          "Student": ["Student", "Research Scholar"]}
SEN_W = [("CXO / founder", 12), ("VP / director", 21), ("Manager / lead", 30), ("Individual", 28), ("Student", 9)]
CITY_W = [("Bengaluru", 64), ("Hyderabad", 10), ("Chennai", 8), ("Mumbai", 4), ("Pune", 3), ("Delhi NCR", 4), ("Singapore", 3), ("Dubai", 2), ("Kochi", 2)]
# source, share of registrations, ICP chance
SOURCES = [("Email", 512, .38), ("Partners", 388, .51), ("LinkedIn", 301, .58), ("Instagram", 244, .33), ("Speakers", 219, .46),
           ("Listing sites", 176, .19), ("Google ads", 142, .44), ("Meta ads", 126, .17), ("Billboards", 84, .31), ("Press", 91, .49),
           ("Creators", 77, .22), ("QR codes", 63, .12), ("Direct", 141, .35)]
SPONSORS = [("Nimbus Cloud", "Gold", 1500000, 120, 162, "signed"), ("Larkspur Bank", "Gold", 1500000, 120, 141, "signed"),
            ("Orbitpay", "Gold", 1500000, 120, 133, "verbal"), ("Bluefin Data", "Silver", 900000, 120, 175, "signed"),
            ("Arcadia Robotics", "Silver", 900000, 120, 168, "signed"), ("Meridian HR Tech", "Silver", 900000, 120, 150, "verbal"),
            ("Sable Insights", "Silver", 900000, 120, 145, "signed"), ("Corvex Labs", "Silver", 900000, 120, 128, "signed"),
            ("Tessera AI", "Bronze", 500000, 120, 118, "signed"), ("Quanta DB", "Bronze", 500000, 120, 104, "verbal"),
            ("Helio Analytics", "Bronze", 500000, 120, 96, "declined"), ("Kestrel Security", "Bronze", 500000, 120, 88, "none")]
SPEAKERS = ["Dr. Ananya Rao", "Vikram Menon", "Priya Shah", "Karthik Iyer", "Meera Kulkarni", "Rohan Gupta", "Sana Patel", "Joel Thomas",
            "Divya Krishnan", "Arjun Reddy", "Lena Fischer", "Omar Haddad"]
PRESS = ["TechWire India", "The Data Daily", "StartupScope", "AI Bulletin", "Bengaluru Tech Times"]
CREATORS = ["Ankit Tech", "DataWithDev", "ML Mondays", "The Code Chai"]
OWN = ["Euliv AI", "Euliv Technologies"]


def _pick(rng: random.Random, weighted):
    tot = sum(w for _, w, *_ in weighted)
    x = rng.uniform(0, tot)
    for item in weighted:
        x -= item[1]
        if x <= 0:
            return item
    return weighted[-1]


def create(db: Session, user: models.User, workspace_id: str, stage: str = "done", now: datetime | None = None) -> models.Initiative:
    rng = random.Random(42)
    now = now or datetime.utcnow()
    tz = "Asia/Kolkata"
    off = core.tz_offset(tz)
    now_local = now + off
    if stage == "before":
        day1 = (now_local + timedelta(days=24)).date()
    elif stage == "live":
        day1 = now_local.date() if now_local.hour >= 10 else (now_local - timedelta(days=1)).date()
    else:
        stage = "done"
        day1 = (now_local - timedelta(days=90)).date()
    start_l = datetime(day1.year, day1.month, day1.day, 9, 30)
    end_l = start_l + timedelta(days=1, hours=8, minutes=30)
    start, end = start_l - off, end_l - off
    open_at = start - timedelta(days=45)
    title = "Euliv AI Summit (sample)"
    i = models.Initiative(owner_id=user.id, workspace_id=workspace_id, title=title, kind="event", department="Marketing",
                          status="done" if stage == "done" else "active",
                          brief="Two days in Bengaluru: 3,000 AI and data leaders, 12 sponsors, keynote livestreamed. Goal: pipeline for Euliv Cloud.",
                          summary="A sample event with fictional data - explore every Event OS screen.", starts_on=open_at.date().isoformat(),
                          key_date=day1.isoformat(), location="KTPO Convention Centre, Whitefield, Bengaluru", budget=13860000,
                          details={"format": "hybrid", "time": "9:30 am"}, targets=[], phases=[
                              {"id": "plan", "title": "Plan", "window": "6 weeks out"}, {"id": "promote", "title": "Promote", "window": "until doors open"},
                              {"id": "event", "title": "Event days", "window": "2 days"}, {"id": "follow", "title": "Follow-up", "window": "90 days"}],
                          tools=[], plan_meta={"sample": True}, created_at=open_at, updated_at=now, registration_open=stage == "before")
    db.add(i)
    db.flush()
    stream_room = "Main stage"
    zones = [{"id": "main", "name": "Main stage", "capacity": 1800}, {"id": "b1", "name": "Breakout 1", "capacity": 400},
             {"id": "b2", "name": "Breakout 2", "capacity": 300}, {"id": "expo", "name": "Expo · 40 booths", "capacity": 1000},
             {"id": "pods", "name": "Meeting pods · 22", "capacity": 44}, {"id": "food", "name": "Food court", "capacity": 1000},
             {"id": "gate_a", "name": "Gate A", "capacity": None, "outside": True}, {"id": "gate_b", "name": "Gate B", "capacity": None, "outside": True}]
    cfg = models.EventConfig(initiative_id=i.id, format="hybrid", mode="mega", starts_at=start_l, ends_at=end_l, timezone=tz,
                             capacity=3000, fire_limit=3200, post_window_days=30, code="AIS26", hashtags=["#EulivAISummit", "#AIS26"],
                             keywords=["euliv ai summit", "euliv summit", "ais26"], promo_codes=["PODCAST26", "NIMBUS26", "YT-ANKIT"],
                             handles={"speakers": SPEAKERS, "sponsors": [s[0] for s in SPONSORS], "press": PRESS, "creators": CREATORS},
                             ad_campaigns=[], zones=zones, share_enabled=True, data={})
    db.add(cfg)
    db.flush()
    data: dict = {"sample": True, "sample_stage": stage, "currency": "INR", "win_rate": 0.22, "city": "Bengaluru",
                  "prices": {"vip": 17000}, "stream_room": stream_room,
                  "sample_funnel": {"visits": 92300, "started": 10400},
                  "sample_accounts": {"target": 312, "covered": 241, "missing": 71},
                  "costs": [{"label": "Venue and production", "amount": 6200000}, {"label": "Food and drinks", "amount": 2800000},
                            {"label": "Staff and travel", "amount": 1400000}, {"label": "Tech, kiosks and sensors", "amount": 900000},
                            {"label": "Contingency", "amount": 700000},
                            {"label": "LinkedIn ads", "amount": 460000, "channel": "LinkedIn", "kind": "marketing"},
                            {"label": "Partner co-promotion", "amount": 110000, "channel": "Partners", "kind": "marketing"},
                            {"label": "Billboards · 6 sites", "amount": 600000, "channel": "Billboards", "kind": "marketing"},
                            {"label": "Press and podcasts", "amount": 180000, "channel": "Press", "kind": "marketing"},
                            {"label": "Creators", "amount": 150000, "channel": "Creators", "kind": "marketing"},
                            {"label": "Campus promoters", "amount": 60000, "channel": "QR codes", "kind": "marketing"},
                            {"label": "Email and WhatsApp", "amount": 30000, "channel": "Email", "kind": "marketing"}]}

    def keep(at: datetime | None) -> bool:
        return at is not None and at <= now

    # ---------------------------------------------------------- sessions --
    S = []
    plan_s = [(0, 10, 0, 45, "Keynote: AI that pays for itself", "Dr. Ananya Rao", "Main stage", 1800, True),
              (0, 11, 15, 45, "LLMs on your warehouse", "Karthik Iyer", "Breakout 2", 300, False),
              (0, 11, 15, 45, "Data contracts in practice", "Meera Kulkarni", "Breakout 1", 400, False),
              (0, 12, 0, 50, "CIO panel: buy vs build", "Vikram Menon", "Main stage", 1800, True),
              (0, 14, 0, 45, "Fraud models at UPI scale", "Sana Patel (Orbitpay)", "Breakout 2", 300, False),
              (0, 14, 0, 45, "Hiring your first ML team", "Joel Thomas", "Breakout 1", 400, False),
              (0, 15, 30, 45, "Building with agents", "Rohan Gupta", "Main stage", 1800, True),
              (1, 10, 0, 45, "Day 2 keynote: the AI-native company", "Priya Shah", "Main stage", 1800, True),
              (1, 11, 30, 45, "Evals that matter (Nimbus Cloud)", "Divya Krishnan", "Breakout 1", 400, False),
              (1, 14, 0, 50, "Closing panel: what's next", "Lena Fischer", "Main stage", 1800, True)]
    fills = [0.94, 1.04, 0.48, 0.73, 0.99, 0.37, 0.61, 0.82, 0.71, 0.55]
    for (dd, hh, mm, dur, t, sp, room, cap, online) in plan_s:
        sl = datetime(day1.year, day1.month, day1.day, hh, mm) + timedelta(days=dd)
        s = models.EventSession(initiative_id=i.id, title=t, speaker=sp, room=room, track="Main" if room == "Main stage" else room,
                                starts_at=sl, ends_at=sl + timedelta(minutes=dur), capacity=cap, online=online)
        db.add(s)
        S.append(s)
    # ---------------------------------------------------------- sponsors --
    SP = []
    for n, (name, tier, amt, goal, leads, ren) in enumerate(SPONSORS):
        sp = models.EventSponsor(initiative_id=i.id, name=name, tier=tier, booth=str(12 + n), goal_leads=goal, amount=amt,
                                 contact_email=f"events@{name.lower().replace(' ', '')}.example",
                                 renewal=ren if stage == "done" else "none",
                                 renewal_at=(end + timedelta(days=5)) if stage == "done" and ren in ("signed", "verbal") else None,
                                 data={"crm": {"pipeline": 32000000, "cost_per_lead": 7400}} if name == "Nimbus Cloud" else {})
        db.add(sp)
        SP.append(sp)
    db.flush()

    # ------------------------------------------------------------ tickets --
    total_reg = 4120
    days_total = (start - open_at).total_seconds() / 86400
    k = 1.6  # the sample's sign-ups: a steady build that speeds up near the day
    companies = [f"{rng.choice(CO_A)} {rng.choice(CO_B)}" for _ in range(900)]
    companies = list(dict.fromkeys(companies))
    tickets = []
    base_p = {"free": 0.52}
    for n in range(total_reg):
        src = _pick(rng, SOURCES)
        sen = _pick(rng, SEN_W)[0]
        f = rng.random() ** (1 / k)
        reg_at = open_at + timedelta(days=f * days_total, minutes=rng.randint(0, 600))
        fn, ln = rng.choice(FIRST), rng.choice(LAST)
        co = rng.choice(companies)
        tier = "free"
        r = rng.random()
        if n < 212:
            tier = "vip"
        elif n < 236:
            tier = "speaker"
        elif n < 272:
            tier = "sponsor"
        elif n < 282:
            tier = "press"
        icp = rng.random() < (src[2] + (0.15 if sen in ("CXO / founder", "VP / director") else 0) - (0.3 if sen == "Student" else 0))
        clicked = rng.random() < 0.42
        meeting = icp and rng.random() < 0.27
        repeat = rng.random() < 0.22
        conf_p = 0.25 + 0.3 * clicked + 0.25 * meeting + (0.3 if tier != "free" else 0)
        confirmed = (start - timedelta(days=rng.uniform(1, 7))) if rng.random() < conf_p else None
        if confirmed and confirmed < reg_at:
            confirmed = reg_at + timedelta(hours=2)
        x = 0.25 + (1.4 if tier == "vip" else 2.6 if tier != "free" else 0) + (0.9 if confirmed else 0) + (1.2 if meeting else 0) \
            + (0.4 if clicked else 0) + (0.6 if repeat else 0) - (0.6 if src[0] == "Listing sites" else 0)
        lead = (start - reg_at).days
        x += -0.35 if lead > 30 else (0.35 if lead <= 7 else 0)
        p = 1 / (1 + math.exp(-x))
        came = rng.random() < min(0.97, p * 0.883)
        city = _pick(rng, CITY_W)[0]
        tickets.append({"n": n, "src": src[0], "sen": sen, "reg_at": reg_at, "name": f"{fn} {ln}", "email": f"{fn.lower()}.{ln.lower().replace(chr(39), '')}{n}@{co.lower().replace(' ', '')}.example",
                        "company": co, "title": rng.choice(TITLES[sen]), "tier": tier, "icp": icp, "confirmed": confirmed, "came": came,
                        "meeting": meeting, "clicked": clicked, "repeat": repeat, "city": city, "p": p, "walk_in": False})
    for n in range(312):
        sen = _pick(rng, SEN_W[:4])[0]
        fn, ln = rng.choice(FIRST), rng.choice(LAST)
        co = rng.choice(companies)
        tickets.append({"n": total_reg + n, "src": "Walk-in", "sen": sen, "reg_at": None, "name": f"{fn} {ln}",
                        "email": f"{fn.lower()}.{ln.lower().replace(chr(39), '')}.w{n}@{co.lower().replace(' ', '')}.example", "company": co,
                        "title": rng.choice(TITLES[sen]), "tier": "free", "icp": rng.random() < 0.68, "confirmed": None, "came": True,
                        "meeting": False, "clicked": False, "repeat": False, "city": "Bengaluru", "p": None, "walk_in": True})
    # arrival times: 85% first come on day 1 (curve around 9:40), the rest on day 2
    for t in tickets:
        if not t["came"]:
            t["in_at"] = None
            continue
        d = 0 if rng.random() < 0.85 else 1
        mins = rng.gauss(10, 32) if not t["walk_in"] else rng.uniform(20, 300)
        if t["tier"] in ("speaker", "sponsor", "press"):
            mins = rng.uniform(-60, -10)
        in_l = start_l + timedelta(days=d, minutes=max(-60, min(mins, 420)))
        t["in_at"] = in_l - off
        t["gate"] = "Gate A" if rng.random() < 0.65 else "Gate B"
    ticket_rows = []
    for t in tickets:
        reg_at = t["reg_at"] if t["reg_at"] else t["in_at"]
        if not keep(reg_at):
            continue
        came = t["came"] and keep(t["in_at"])
        ticket_rows.append({"id": models.gen_uuid(), "initiative_id": i.id, "code": models._short_code(), "name": t["name"],
                            "email": t["email"], "company": t["company"], "title": t["title"], "seniority": t["sen"], "city": t["city"],
                            "tier": t["tier"], "icp": t["icp"], "source": t["src"], "status": "checked_in" if came else "registered",
                            "walk_in": t["walk_in"], "consent": True, "registered_at": reg_at,
                            "confirmed_at": t["confirmed"] if keep(t["confirmed"]) else None,
                            "checked_in_at": t["in_at"] if came else None, "checked_in_by": "Gate staff" if came else None,
                            "gate": t.get("gate") if came else None, "show_prob": round(t["p"], 3) if t["p"] else None,
                            "data": {"meeting": t["meeting"], "clicked": t["clicked"], "repeat": t["repeat"]}})
        t["id"] = ticket_rows[-1]["id"]
    db.bulk_insert_mappings(models.EventTicket, ticket_rows)
    came_t = [t for t in tickets if t.get("id") and t["came"] and keep(t["in_at"])]

    # ------------------------------------------------------------ touches --
    touches = []

    def touch(kind, at, **kw):
        if keep(at):
            touches.append({"id": models.gen_uuid(), "initiative_id": i.id, "kind": kind, "occurred_at": at,
                            "truth": kw.pop("truth", "counted"), **kw})
    for t in came_t:
        touch("gate_scan", t["in_at"], ticket_id=t["id"], zone=t["gate"], source="staff app")
    # sessions: door scans and ratings
    for s, fill in zip(S, fills):
        s_utc = s.starts_at - off
        n_in = int(s.capacity * fill)
        pool = [t for t in came_t if t["in_at"] <= s_utc + timedelta(minutes=20)]
        for t in rng.sample(pool, min(n_in, len(pool))):
            touch("session_scan", s_utc + timedelta(minutes=rng.uniform(-12, 8)), ticket_id=t["id"], session_id=s.id, zone=s.room)
            if rng.random() < 0.3:
                touch("rating", s.ends_at - off + timedelta(minutes=rng.uniform(1, 30)), ticket_id=t["id"], session_id=s.id,
                      value=max(1, min(5, round(rng.gauss(4.45 if fill > 0.7 else 4.1, 0.6)))), truth="reported")
    # queues at the gates, every 10 minutes on the mornings
    for d in (0, 1):
        for m in range(-60, 181, 10):
            at = start + timedelta(days=d, minutes=m)
            for gate, peak in (("Gate A", 9 if d == 0 else 5), ("Gate B", 4 if d == 0 else 3)):
                v = peak * math.exp(-((m - 10) / 40) ** 2) + rng.uniform(0, 0.8)
                touch("queue", at, zone=gate, value=round(v, 1))
    # occupancy per zone every 10 minutes during both days
    for d in (0, 1):
        for m in range(-30, 8 * 60 + 31, 10):
            at = start + timedelta(days=d, minutes=m)
            hr = 9.5 + m / 60
            base = (1 - (0.15 if d else 0)) * 2380 / (1 + math.exp(-(m - 20) / 25)) * (1 if hr < 17 else max(0.2, 1 - (hr - 17) / 1.5))
            shares = {"main": 0.5 if (10 <= hr < 11 or 12 <= hr < 13) else 0.28, "b1": 0.08, "b2": 0.11 if 11 <= hr < 12.2 else 0.06,
                      "expo": 0.27 if not (12.6 <= hr < 13.6) else 0.12, "pods": 0.016, "food": 0.38 if 12.6 <= hr < 13.6 else 0.08}
            for zid, sh in shares.items():
                cap = next(z["capacity"] for z in zones if z["id"] == zid)
                touch("occupancy", at, zone=zid, value=min(cap * 1.05, round(base * sh * rng.uniform(0.93, 1.07))), source="sensor")
    # livestream: viewers per minute through each streamed session
    for s in S:
        if not s.online:
            continue
        s_utc = s.starts_at - off
        dur = int((s.ends_at - s.starts_at).total_seconds() // 60)
        peak = 3400 if "Keynote" in s.title and s.starts_at.date() == day1 else 2100
        for m in range(dur + 1):
            v = peak * (1 - math.exp(-m / 2.2)) * (1 - 0.006 * max(0, m - 6))
            if "Keynote" in s.title and 17 <= m <= 21:
                v += [0, 180, 260, 200, 90][m - 17]
            if m > dur - 7:
                v -= (m - (dur - 7)) * 14
            touch("stream_viewers", s_utc + timedelta(minutes=m), session_id=s.id, value=round(max(v, 0)), data={"minute": m}, source="stream")
    # questions and CTA clicks from the stream
    for s in S:
        if s.online:
            for _ in range(rng.randint(30, 90)):
                touch("question", s.starts_at - off + timedelta(minutes=rng.uniform(5, 45)), session_id=s.id, source="stream",
                      text=rng.choice(["Pricing for data sovereignty in India?", "How to start with a small team?", "How do you stop hallucinations in reports?",
                                       "Does it integrate with SAP?", "What does it cost to run per month?", "Can it run on our own cloud?"]))
    # meetings at the pods
    meet_t = [t for t in came_t if t["meeting"]]
    extra = [t for t in came_t if t["icp"] and not t["meeting"]]
    pool = meet_t + rng.sample(extra, min(len(extra), max(0, 512 - len(meet_t))))
    for t in pool[:512]:
        touch("meeting", t["in_at"] + timedelta(minutes=rng.uniform(30, 420)), ticket_id=t["id"], zone="pods")
    # booth visits and sponsor leads
    lead_rows = []
    for sp, (name, tier, amt, goal, n_leads, ren) in zip(SP, SPONSORS):
        visits = int(n_leads * rng.uniform(6.5, 8.5))
        for _ in range(visits):
            t = rng.choice(came_t) if came_t else None
            if not t:
                break
            at = max(t["in_at"], start) + timedelta(minutes=rng.uniform(20, 480))
            if rng.random() < 0.45:
                at += timedelta(days=1)
            touch("booth_visit", at, ticket_id=t["id"], sponsor_id=sp.id, value=round(max(0.5, rng.gauss(3.6, 1.6)), 1), source="rfid")
        for _ in range(n_leads):
            t = rng.choice(came_t) if came_t else None
            if not t:
                break
            at = max(t["in_at"], start) + timedelta(minutes=rng.uniform(20, 480)) + (timedelta(days=1) if rng.random() < 0.45 else timedelta())
            if keep(at):
                lead_rows.append({"id": models.gen_uuid(), "initiative_id": i.id, "sponsor_id": sp.id, "ticket_id": t["id"], "name": t["name"],
                                  "email": t["email"], "company": t["company"], "title": t["title"],
                                  "rating": rng.choices([5, 4, 3, 2], [18, 28, 38, 16])[0],
                                  "interests": rng.sample(["migration", "Q1 budget", "demo", "pricing", "POC", "security", "integration"], 2),
                                  "note": rng.choice([None, None, "Wants a POC call next week", "Moving off on-prem by March", "Send pricing"]),
                                  "scanned_by": f"{name.split()[0]} booth", "created_at": at})
    db.bulk_insert_mappings(models.EventLead, lead_rows)
    # survey (NPS ~52) and replay views
    if stage == "done":
        resp = rng.sample(came_t, min(1410, len(came_t)))
        for t in resp:
            r = rng.random()
            val = rng.choice([9, 10]) if r < 0.63 else (rng.choice([7, 8]) if r < 0.905 else rng.randint(2, 6))
            touch("survey", end + timedelta(hours=rng.uniform(2, 96)), ticket_id=t["id"], value=val, truth="reported",
                  text=rng.choice([None, None, "Great speakers", "Parking on day 1 was hard", "More hands-on sessions please", "Best AI event in Bengaluru"]))
        for d in range(1, 60):
            touch("replay_view", end + timedelta(days=d), value=round(4200 * math.exp(-d / 9) + 40), source="YouTube")
    db.bulk_insert_mappings(models.EventTouch, touches)

    # ----------------------------------------------------------- mentions --
    mentions = []
    texts = {
        "before": ["Speaking at #EulivAISummit next month - see you in Bengaluru!", "Agenda for the Euliv AI Summit is stacked. Registered! #AIS26",
                   "Early bird for #EulivAISummit ends Friday. Code PODCAST26 for 10% off.", "Who else is going to the Euliv AI Summit? #AIS26",
                   "Meet us at booth 14 at #EulivAISummit", "3,000 AI leaders, 2 days, 1 city. #EulivAISummit"],
        "during": ["Packed room for the keynote at #EulivAISummit", "Live from the Euliv AI Summit - the demo just got a standing ovation",
                   "Day 1 at #AIS26: great conversations at the expo", "Queue at Gate A moved fast, nice. #EulivAISummit",
                   "Our CTO on the CIO panel at #EulivAISummit"],
        "after": ["Grateful to speak at #EulivAISummit - here are my 5 takeaways", "I attended the Euliv AI Summit: 2 days, 30 conversations, 1 big idea",
                  "Recap: 162 great conversations at our booth. Thank you #EulivAISummit", "My summit vlog is up! Code YT-ANKIT for next year",
                  "Parking on day 1 at the Euliv summit was a mess", "Highlights from #AIS26 - the best AI event in Bengaluru this year",
                  "What 3,000 AI leaders said at the Euliv AI Summit"],
    }

    def mentions_on(d: int) -> int:
        if d < 0:
            return round(18 + 55 * math.exp(d / 12))
        if d in (0, 1):
            return 380 if d == 0 else 420
        return round(250 * math.exp(-(d - 2) / 3.2) + 9)
    media_n = 8
    for d in range(-45, 31):
        n = mentions_on(d)
        n = max(1, round(n * 0.35))  # stored sample: about a third of the curve, so the database stays light
        for _ in range(n):
            ph = "before" if d < 0 else "during" if d <= 1 else "after"
            at = start + timedelta(days=d, hours=rng.uniform(-2, 10))
            if not keep(at):
                continue
            r = rng.random()
            if ph == "before":
                kind = "own" if r < 0.35 else "speaker" if r < 0.55 else "sponsor" if r < 0.65 else "public" if r < 0.85 else "press"
            elif ph == "during":
                kind = "attendee" if r < 0.4 else "own" if r < 0.6 else "speaker" if r < 0.75 else "sponsor" if r < 0.85 else "press"
            else:
                kind = "attendee" if r < 0.52 else "speaker" if r < 0.68 else "sponsor" if r < 0.74 else "own" if r < 0.9 else "press" if r < 0.96 else "creator"
            author = (rng.choice(OWN) if kind == "own" else rng.choice(SPEAKERS) if kind == "speaker" else rng.choice([s[0] for s in SPONSORS])
                      if kind == "sponsor" else rng.choice(PRESS) if kind == "press" else rng.choice(CREATORS) if kind == "creator"
                      else (rng.choice(came_t)["name"] if came_t and kind == "attendee" else f"@{rng.choice(FIRST).lower()}{rng.randint(1, 99)}"))
            plat = rng.choices(["linkedin", "instagram", "x", "youtube", "facebook", "news"], [45, 25, 15, 5, 5, 5])[0]
            if kind == "press":
                plat = "news"
            if kind == "creator":
                plat = "youtube"
            how = rng.choices(["hashtag", "link", "code", "keyword", "banner"], [50, 15, 8, 12, 15])[0]
            conf = {"hashtag": 0.97, "link": 0.98, "code": 0.95, "keyword": 0.93, "banner": round(rng.uniform(0.9, 0.98), 2)}[how]
            state = "auto"
            if rng.random() < 0.025:
                how, conf, state = "keyword", 0.8, "review"
            text = rng.choice(texts[ph])
            if kind == "attendee" and ph == "after" and "Parking" not in text and rng.random() < 0.6:
                text = rng.choice(["I attended the Euliv AI Summit: 2 days, 30 conversations, 1 big idea",
                                   "My takeaways from #EulivAISummit", "Thanks for having us at #AIS26!"])
            if ph == "after" and rng.random() < 0.06:
                text = rng.choice(["Parking on day 1 at the Euliv summit was a mess", "The queue for lunch was long at #AIS26, otherwise great"])
            reach = round(rng.lognormvariate(7.2, 1.1) * (6 if kind in ("press", "creator") else 2.5 if kind in ("own", "speaker", "sponsor") else 1))
            media = f"/eventos-sample/{rng.randint(1, media_n)}.svg" if (how == "banner" or rng.random() < 0.55) else None
            mentions.append({"id": models.gen_uuid(), "initiative_id": i.id, "platform": plat, "external_id": models.gen_uuid()[:18],
                             "author": author, "author_kind": kind, "url": f"https://example.com/post/{rng.randint(10**6, 10**7)}",
                             "text": text, "media_url": media, "posted_at": at, "reach": reach, "engagements": round(reach * rng.uniform(0.02, 0.08)),
                             "matched_by": how, "confidence": conf, "why": {"text": {"hashtag": "#EulivAISummit in the text", "link": "a tracked link of this event",
                                                                                      "code": "code PODCAST26", "keyword": "the event's name",
                                                                                      "banner": "banner seen in the picture"}[how] if state == "auto" else "words: euliv, summit"},
                             "state": state, "sentiment": None, "created_at": at})
    from .social import sentiment
    for m in mentions:
        m["sentiment"] = sentiment(m["text"])
    db.bulk_insert_mappings(models.EventMention, mentions)

    # -------------------------------------------------------- ads + deals --
    ads = []
    d = open_at.date()
    while d <= min(start.date(), now.date()):
        f = (datetime(d.year, d.month, d.day) - open_at).days / days_total
        w_ = 0.4 + 1.2 * f
        for plat, camp, total in (("Meta ads", "INIT-AIS26-META-broad", 70000), ("Meta ads", "INIT-AIS26-META-retarget", 40000),
                                  ("Google ads", "INIT-AIS26-GOOG-search", 160000)):
            sp = total / 45 * w_ / 1.0
            ads.append({"date": d.isoformat(), "platform": plat, "campaign": camp, "campaign_id": camp, "how": "naming rule",
                        "spend": round(sp, 2), "clicks": round(sp / 18), "impressions": round(sp * 9), "conversions": round(sp / 900)})
        d += timedelta(days=1)
    data["sample_ads"] = ads
    deals = []
    came_icp = [t for t in came_t if t["icp"]]
    if came_icp:
        amounts = [rng.lognormvariate(math.log(4000000), 0.7) for _ in range(41)]
        scale = 214000000 / sum(amounts)
        for n, a in enumerate(amounts):
            t = rng.choice(came_icp)
            created = end + timedelta(days=rng.uniform(2, 40) if n < 9 else rng.uniform(2, 80))
            if not keep(created):
                continue
            won = n < 9 and keep(created + timedelta(days=30))
            deals.append({"deal_id": f"S{n}", "name": f"{t['company']} - {rng.choice(['data platform', 'AI pilot', 'analytics', 'expansion'])}",
                          "amount": round(a * scale), "stage": "Closed won" if won else rng.choice(["Discovery", "Proposal", "POC", "Negotiation"]),
                          "kind": "sourced", "won": won, "created_at": created.isoformat() + "Z", "company": t["company"].lower(),
                          "how": "company in deal name"})
        for n in range(18):
            t = rng.choice(came_icp)
            deals.append({"deal_id": f"I{n}", "name": f"{t['company']} - renewal", "amount": round(rng.uniform(1000000, 3200000)),
                          "stage": "Negotiation", "kind": "influenced", "won": False,
                          "created_at": (start - timedelta(days=rng.uniform(10, 120))).isoformat() + "Z", "company": t["company"].lower(),
                          "how": "company in deal name"})
    data["sample_deals"] = deals
    # the score over time, as it was recorded
    hist = []
    for dd, sc in ((-45, 68), (-30, 71), (-24, 74), (-14, 76), (-7, 79), (0, 82), (3, 81), (30, 84), (60, 86), (90, 87)):
        at = start + timedelta(days=dd)
        if keep(at):
            hist.append({"date": at.date().isoformat(), "score": sc, "phase": "before" if dd < 0 else "during" if dd < 2 else "after"})
    data["score_history"] = hist
    data["sample_plan_day"] = 2310 * 1.06
    if stage == "done":
        data["survey_sent_at"] = (end + timedelta(hours=2)).isoformat()
        data["followup_task"] = True
        for sp in SP:
            sp.data = {**(sp.data or {}), "report_sent_at": (end + timedelta(days=2)).isoformat()}
    cfg.data = data

    # -------------------------------------------------------------- goals --
    G = [("Kiran · CEO", "CEO", "Pipeline sourced in 90 days", "pipeline_sourced", 180000000, 140000000, 220000000, 30, False),
         ("Meera · Sales", "Sales", "Meetings held with target accounts", "meetings", 500, 420, 560, 15, False),
         ("Neha · Marketing", "Marketing", "People in the room", "attended", 2800, 2500, 3100, 15, False),
         ("Sponsors · 12", "Sponsors", "Leads per sponsor", "sponsor_leads_avg", 120, 90, 150, 15, False),
         ("Attendees", "Attendees", "NPS", "nps", 45, 35, 60, 10, False),
         ("Sanjay · Finance", "Finance", "Cost per attendee", "cost_per_attendee", 5000, 5600, 4400, 15, True)]
    for n, (owner, role, label, metric, tgt, lo, hi, wgt, lower) in enumerate(G):
        signed = open_at + timedelta(days=17 + n % 2)
        db.add(models.EventGoal(initiative_id=i.id, owner_name=owner, owner_role=role, label=label, metric=metric, target=tgt, low=lo,
                                high=hi, weight=wgt, lower_is_better=lower, position=n,
                                signed_at=signed if (keep(signed) and not (stage == "before" and role == "Finance")) else None,
                                signed_by=owner.split(" · ")[0] if keep(signed) else None,
                                owner_email=f"{role.lower()}@euliv.example"))
    # -------------------------------------------------------------- tasks --
    T = [("Venue contract and fire NOC", "plan", -40, "done", "Venue team"), ("Agenda page live with 24 speakers", "plan", -30, "done", "Neha"),
         ("LinkedIn campaign running (INIT-AIS26-*)", "promote", -28, "done", "Neha"), ("12 sponsor contracts signed", "plan", -21, "done", "Sanjay"),
         ("Kiosks: 10 at Gate A", "plan", -20, "done", "Ops"), ("Staff app on 40 phones", "event", -2, "done", "Ops"),
         ("Caterer headcount from show-up forecast", "event", -5, "done", "Ops"), ("Send sponsor reports", "follow", 2, "done", "Euliv agent"),
         ("Survey to attendees", "follow", 1, "done", "Euliv agent"), ("Follow up with ICP attendees", "follow", 5, "doing", "Meera")]
    for n, (t, ph, dd, st, owner) in enumerate(T):
        due = (start + timedelta(days=dd)).date()
        status = st if keep(start + timedelta(days=dd)) else "todo"
        db.add(models.InitiativeTask(initiative_id=i.id, phase_id=ph, title=t, due_on=due.isoformat(), status=status, owner_name=owner,
                                     position=n, origin="planner", done_at=(start + timedelta(days=dd)) if status == "done" else None,
                                     evidence=[{"label": "closed by evidence", "url": None, "kind": "auto"}] if status == "done" and n in (1, 2, 5) else None))
    db.flush()
    return i
