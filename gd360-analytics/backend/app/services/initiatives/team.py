"""
Team & outreach: who works on an initiative, in which role, which accounts
each person owns, and every personal touch they make - LinkedIn, Sales
Navigator, personal email, calls, WhatsApp - logged in two taps from their
own "My invites" page, or updated automatically when their people register
(through the rep's personal link or any other way), attend, walk in or meet.

Statuses climb a fixed ladder; an automatic signal never moves a row down.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from datetime import date, datetime, timedelta

from sqlalchemy.orm import Session

from ... import models
from . import gtm

LADDER = ["not_contacted", "invited", "replied", "interested", "registered", "attended", "meeting", "opportunity"]
CLOSED = {"declined", "not_now", "bounced"}
STATUS_LABELS = {
    "not_contacted": "Not contacted", "invited": "Invited", "replied": "Replied", "interested": "Interested",
    "registered": "Registered", "attended": "Attended", "meeting": "Meeting booked", "opportunity": "Opportunity",
    "declined": "Declined", "not_now": "Not now", "bounced": "Wrong contact",
}
CHANNELS = {
    "linkedin": "LinkedIn message", "sales_navigator": "Sales Navigator InMail", "email": "Personal email",
    "call": "Call", "whatsapp": "WhatsApp / text", "in_person": "In person", "marketing_email": "Marketing email",
    "personal_link": "Personal invite link", "other": "Other",
}
ROLES = {
    "event": [
        {"role": "Event lead", "does": "Owns the plan, budget, venue and the run of show.", "targets": {}},
        {"role": "Account executive", "does": "Personally invites their Tier A accounts and books meetings on the day.", "targets": {"invites": 25, "registrations": 8, "meetings": 4}},
        {"role": "SDR", "does": "Works Tier B: LinkedIn / Sales Navigator invites, follow-ups to non-openers.", "targets": {"invites": 60, "registrations": 12, "meetings": 3}},
        {"role": "Customer success", "does": "Invites existing customers; turns the day into expansion talks.", "targets": {"invites": 30, "registrations": 10}},
        {"role": "Marketing", "does": "Landing pages, email invites, LinkedIn organic and paid, creative approvals.", "targets": {}},
        {"role": "Booth staff", "does": "Captures every walk-in on the phone page; flags meeting requests.", "targets": {"walk_ins": 20}},
    ],
    "webinar": [
        {"role": "Host", "does": "Owns topic, speakers and the live run.", "targets": {}},
        {"role": "Account executive", "does": "Personally invites Tier A accounts; follows up attendees.", "targets": {"invites": 20, "registrations": 6, "meetings": 2}},
        {"role": "SDR", "does": "LinkedIn / email invites to Tier B; no-show follow-up.", "targets": {"invites": 50, "registrations": 10}},
        {"role": "Marketing", "does": "Registration page, email sequence, social promotion.", "targets": {}},
    ],
    "abm": [
        {"role": "Account executive", "does": "1:1 plays on owned Tier A accounts.", "targets": {"invites": 20, "meetings": 6}},
        {"role": "SDR", "does": "Multi-touch outreach to Tier B buying committees.", "targets": {"invites": 80, "meetings": 6}},
        {"role": "Marketing", "does": "Ads, email, content and the website signals.", "targets": {}},
    ],
    "hiring": [
        {"role": "Hiring manager", "does": "Owns the roles, the scorecards and the final call.", "targets": {}},
        {"role": "Recruiter", "does": "Sources and screens; keeps every candidate moving within 3 days.", "targets": {"invites": 60}},
        {"role": "Interviewer", "does": "Runs interviews and fills the scorecard the same day.", "targets": {}},
    ],
    "product": [
        {"role": "Product owner", "does": "Scope, priorities and sign-off.", "targets": {}},
        {"role": "Designer", "does": "Designs, sent for approval with the Figma link and version.", "targets": {}},
        {"role": "Engineer", "does": "Builds; moves cards on the board or links their tracker.", "targets": {}},
        {"role": "QA", "does": "Test passes and the bug bash before launch.", "targets": {}},
    ],
    "custom": [
        {"role": "Owner", "does": "Owns the goal and the plan.", "targets": {}},
        {"role": "Contributor", "does": "Delivers assigned tasks and logs updates.", "targets": {}},
    ],
    "campaign": [
        {"role": "Campaign owner", "does": "Message, audience and results.", "targets": {}},
        {"role": "SDR", "does": "Follows up accounts that open, click or visit.", "targets": {"invites": 50, "meetings": 5}},
    ],
}


def rank(status: str) -> int:
    return LADDER.index(status) if status in LADDER else -1


def member_row(db: Session, m: models.InitiativeMember, stats: dict | None = None) -> dict:
    return {"id": m.id, "name": m.name, "email": m.email, "role": m.role, "team": m.team, "targets": m.targets or {},
            "token": m.token, "ref": m.ref, "last_update_at": m.last_update_at, "user_id": m.user_id,
            **({"stats": stats} if stats is not None else {})}


def outreach_row(o: models.InitiativeOutreach, accounts: dict, contacts: dict, members: dict) -> dict:
    a = accounts.get(o.account_id)
    c = contacts.get(o.contact_id)
    m = members.get(o.member_id)
    today = date.today().isoformat()
    return {"id": o.id, "status": o.status, "status_label": STATUS_LABELS.get(o.status, o.status), "channel": o.channel,
            "touches": o.touches or 0, "last_touch_at": o.last_touch_at, "next_step": o.next_step,
            "next_step_on": o.next_step_on, "overdue": bool(o.next_step_on and o.next_step_on < today and o.status not in CLOSED),
            "notes": o.notes, "segment": o.segment or "target", "member_id": o.member_id, "member": m.name if m else None,
            "account_id": o.account_id, "account": a.name if a else None, "tier": a.icp_tier if a else None,
            "domain": a.domain if a else None,
            "contact_id": o.contact_id, "person": (c.name or c.email) if c else o.person_name,
            "title": c.title if c else None, "email": c.email if c else None,
            "linkedin_url": (c.linkedin_url if c else None), "history": (o.history or [])[-8:]}


def rows_for(db: Session, initiative_id: str, member_id: str | None = None) -> list[dict]:
    q = db.query(models.InitiativeOutreach).filter(models.InitiativeOutreach.initiative_id == initiative_id)
    if member_id:
        q = q.filter(models.InitiativeOutreach.member_id == member_id)
    rows = q.all()
    accounts = {a.id: a for a in db.query(models.GtmAccount).filter(
        models.GtmAccount.id.in_({o.account_id for o in rows if o.account_id} or {"-"}))}
    contacts = {c.id: c for c in db.query(models.GtmContact).filter(
        models.GtmContact.id.in_({o.contact_id for o in rows if o.contact_id} or {"-"}))}
    members = {m.id: m for m in db.query(models.InitiativeMember).filter(models.InitiativeMember.initiative_id == initiative_id)}
    out = [outreach_row(o, accounts, contacts, members) for o in rows]
    order = {s: n for n, s in enumerate(LADDER)}
    out.sort(key=lambda r: (not r["overdue"], r["status"] in CLOSED, {"A": 0, "B": 1, "C": 2}.get(r["tier"] or "", 3),
                            order.get(r["status"], 9), r["account"] or r["person"] or ""))
    return out


def log_touch(db: Session, o: models.InitiativeOutreach, status: str | None, channel: str | None, note: str | None,
              by: str, next_step: str | None = None, next_step_on: str | None = None, auto: bool = False) -> None:
    now = datetime.utcnow()
    old = o.status
    if status:
        if auto and (o.status in CLOSED or rank(status) <= rank(o.status)):
            status = None  # automatic signals only ever move a row up
        if status:
            o.status = status
    if channel:
        o.channel = channel
    if not auto and (channel or status == "invited"):
        o.touches = (o.touches or 0) + 1
    if not auto:
        o.last_touch_at = now
    if note:
        o.notes = ((o.notes + "\n") if o.notes else "") + f"{now:%d %b}: {note.strip()[:600]}"
    if next_step is not None:
        o.next_step = next_step.strip()[:200] or None
    if next_step_on is not None:
        o.next_step_on = next_step_on or None
    o.history = ((o.history or []) + [{"at": now.isoformat(), "by": by, "from": old, "to": o.status,
                                       "channel": channel, "note": (note or "")[:300] or None, "auto": auto}])[-40:]
    o.updated_at = now
    # the touch is a real signal on the account's timeline
    i = db.get(models.Initiative, o.initiative_id)
    if i and not auto and (status or channel):
        kind = {"replied": "reply", "interested": "reply", "meeting": "meeting", "opportunity": "opportunity"}.get(o.status if status else "", "outreach")
        gtm.record(db, i.workspace_id, kind, account_id=o.account_id, contact_id=o.contact_id, initiative_id=i.id,
                   channel=channel or o.channel or "outreach",
                   detail={"status": o.status, "by": by, "text": (note or "")[:300] or None, "member": o.member_id})


def sync_signal(db: Session, initiative_id: str, kind: str, contact_id: str | None, account_id: str | None,
                ref: str | None = None) -> None:
    """Registration / attendance / walk-in / meeting moves the matching
    outreach rows up. A rep's personal link (ref) credits that rep even when
    the person wasn't on their list yet."""
    status = {"registered": "registered", "attended": "attended", "webinar_attended": "attended", "walk_in": "attended",
              "meeting": "meeting", "opportunity": "opportunity", "reply": "replied", "email_click": None}.get(kind)
    if not status:
        return
    O = models.InitiativeOutreach
    rows = []
    if contact_id:
        rows = db.query(O).filter(O.initiative_id == initiative_id, O.contact_id == contact_id).all()
    if not rows and account_id:
        rows = db.query(O).filter(O.initiative_id == initiative_id, O.account_id == account_id, O.contact_id.is_(None)).all()
    member = None
    if ref:
        member = db.query(models.InitiativeMember).filter(models.InitiativeMember.initiative_id == initiative_id,
                                                          models.InitiativeMember.ref == ref).first()
    if member and not any(r.member_id == member.id for r in rows):
        o = O(initiative_id=initiative_id, member_id=member.id, account_id=account_id, contact_id=contact_id,
              segment=_segment_of(db, account_id), status="invited", channel="personal_link", touches=1,
              last_touch_at=datetime.utcnow())
        db.add(o)
        db.flush()
        rows.append(o)
    for o in rows:
        log_touch(db, o, status, "personal_link" if (member and o.member_id == member.id and status == "registered") else None,
                  None, "GD360", auto=True)


def _segment_of(db: Session, account_id: str | None) -> str:
    if not account_id:
        return "target"
    a = db.get(models.GtmAccount, account_id)
    seg = ((a.segment or "") + " " + (a.list_name or "")).lower() if a else ""
    return "customer" if "customer" in seg or "client" in seg else "target"


def assign(db: Session, i: models.Initiative, member_ids: list[str], account_ids: list[str] | None, tiers: list[str] | None,
           strategy: str, segment: str | None, limit: int) -> dict:
    """Puts accounts on members' lists: round-robin, or by the account owner's
    name when it matches a member. Accounts already on someone's list stay."""
    from .metrics import audience_query
    members = [m for m in db.query(models.InitiativeMember).filter(models.InitiativeMember.initiative_id == i.id)
               if not member_ids or m.id in member_ids]
    if not members:
        return {"assigned": 0, "skipped": 0}
    q = db.query(models.GtmAccount).filter(models.GtmAccount.workspace_id == i.workspace_id)
    if account_ids:
        q = q.filter(models.GtmAccount.id.in_(account_ids[:5000]))
    else:
        aud = dict(i.audience or {})
        if tiers:
            aud["tiers"] = tiers
        q = audience_query(db, i.workspace_id, aud)
        if segment == "customer":
            q = q.filter((models.GtmAccount.segment.ilike("%customer%")) | (models.GtmAccount.list_name.ilike("%customer%")))
    accounts = q.order_by(models.GtmAccount.icp_score.desc().nullslast(), models.GtmAccount.engagement_score.desc()).limit(max(1, min(limit, 5000))).all()
    taken = {r[0] for r in db.query(models.InitiativeOutreach.account_id).filter(
        models.InitiativeOutreach.initiative_id == i.id, models.InitiativeOutreach.contact_id.is_(None))}
    by_name = {m.name.strip().lower(): m for m in members}
    load = Counter({m.id: 0 for m in members})
    assigned = skipped = 0
    for a in accounts:
        if a.id in taken:
            skipped += 1
            continue
        m = by_name.get((a.owner_name or "").strip().lower()) if strategy == "owner" else None
        if m is None:
            mid = min(load, key=lambda k: load[k])
            m = next(x for x in members if x.id == mid)
        load[m.id] += 1
        db.add(models.InitiativeOutreach(initiative_id=i.id, member_id=m.id, account_id=a.id,
                                         segment=segment or _segment_of(db, a.id), status="not_contacted"))
        assigned += 1
    db.flush()
    # bring up anything that already happened
    for o in db.query(models.InitiativeOutreach).filter(models.InitiativeOutreach.initiative_id == i.id,
                                                        models.InitiativeOutreach.status == "not_contacted"):
        best = None
        for (kind,) in db.query(models.GtmEngagement.kind).filter(models.GtmEngagement.initiative_id == i.id,
                                                                  models.GtmEngagement.account_id == o.account_id):
            st = {"registered": "registered", "attended": "attended", "webinar_attended": "attended", "walk_in": "attended",
                  "meeting": "meeting", "opportunity": "opportunity"}.get(kind)
            if st and (best is None or rank(st) > rank(best)):
                best = st
        if best:
            log_touch(db, o, best, None, None, "GD360", auto=True)
    return {"assigned": assigned, "skipped": skipped}


def stats(db: Session, i: models.Initiative) -> dict:
    members = db.query(models.InitiativeMember).filter(models.InitiativeMember.initiative_id == i.id) \
        .order_by(models.InitiativeMember.created_at).all()
    rows = db.query(models.InitiativeOutreach).filter(models.InitiativeOutreach.initiative_id == i.id).all()
    today = date.today().isoformat()
    per: dict[str, Counter] = defaultdict(Counter)
    total = Counter()
    by_channel: dict[str, Counter] = defaultdict(Counter)
    by_segment: dict[str, Counter] = defaultdict(Counter)
    for o in rows:
        c = per[o.member_id or "-"]
        r = rank(o.status)
        # "invited" and "replied" count only real outreach (a logged touch);
        # people who registered on their own still count as registered
        touched = (o.touches or 0) > 0 or o.status in CLOSED
        flags = {"assigned": True, "invited": touched, "replied": touched and r >= rank("replied"),
                 "registered": r >= rank("registered"), "attended": r >= rank("attended"),
                 "meetings": r >= rank("meeting"), "declined": o.status in ("declined", "not_now"),
                 "reg_from_outreach": touched and r >= rank("registered")}
        for key, hit in flags.items():
            if hit:
                c[key] += 1
                total[key] += 1
        if o.next_step_on and o.next_step_on < today and o.status not in CLOSED and r < rank("registered"):
            c["overdue"] += 1
            total["overdue"] += 1
        if o.status == "not_contacted":
            c["untouched"] += 1
        c["touches"] += o.touches or 0
        ch = o.channel or "none"
        if touched:
            by_channel[ch]["invited"] += 1
            if r >= rank("replied"):
                by_channel[ch]["replied"] += 1
            if r >= rank("registered"):
                by_channel[ch]["registered"] += 1
        seg = o.segment or "target"
        by_segment[seg]["assigned"] += 1
        if r >= rank("registered"):
            by_segment[seg]["registered"] += 1
        if r >= rank("meeting"):
            by_segment[seg]["meetings"] += 1

    def rate(a, b):
        return round(100 * a / b, 1) if b else None

    stale_after = datetime.utcnow() - timedelta(days=3)
    board = []
    for m in members:
        c = per.get(m.id, Counter())
        board.append({**member_row(db, m), "last_update_at": m.last_update_at,
                      "stale": bool(c.get("assigned")) and (m.last_update_at is None or m.last_update_at < stale_after),
                      "stats": {k: c.get(k, 0) for k in ("assigned", "invited", "replied", "registered", "attended",
                                                         "meetings", "declined", "overdue", "untouched", "touches")}
                      | {"reply_rate": rate(c.get("replied", 0), c.get("invited", 0)),
                         "registration_rate": rate(c.get("reg_from_outreach", 0), c.get("invited", 0))}})
    teams: dict[str, Counter] = defaultdict(Counter)
    for b in board:
        t = teams[b["team"] or "No team"]
        for k in ("assigned", "invited", "replied", "registered", "attended", "meetings"):
            t[k] += b["stats"][k]
        t["people"] += 1
    return {
        "members": board,
        "teams": [{"team": k, **dict(v), "reply_rate": rate(v["replied"], v["invited"])} for k, v in sorted(teams.items())],
        "total": dict(total) | {"reply_rate": rate(total.get("replied", 0), total.get("invited", 0))},
        "channels": [{"channel": k, "label": CHANNELS.get(k, k), **dict(v), "reply_rate": rate(v["replied"], v["invited"]),
                      "registration_rate": rate(v["registered"], v["invited"])} for k, v in by_channel.items() if k != "none"],
        "segments": {k: dict(v) for k, v in by_segment.items()},
        "roles": ROLES.get(i.kind) or ROLES["custom"],
    }
