"""Event setup, the before / during / after windows, and tickets."""
from __future__ import annotations

import re
from datetime import date, datetime, timedelta

from sqlalchemy.orm import Session

from ... import models

FORMATS = {
    "offline": {"label": "In person", "physical": True, "online": False, "hours": 9},
    "hybrid": {"label": "In person + online", "physical": True, "online": True, "hours": 9},
    "online": {"label": "Online live event", "physical": False, "online": True, "hours": 6},
    "webinar": {"label": "Webinar", "physical": False, "online": True, "hours": 1},
    "meetup": {"label": "Meetup", "physical": True, "online": False, "hours": 3},
    "booth": {"label": "Booth at a show", "physical": True, "online": False, "hours": 8},
    "roadshow": {"label": "Roadshow", "physical": True, "online": False, "hours": 6},
    "launch": {"label": "Product launch", "physical": False, "online": True, "hours": 2},
    "workshop": {"label": "Workshop", "physical": True, "online": False, "hours": 6},
    "festival": {"label": "Festival", "physical": True, "online": False, "hours": 12},
}
MODES = ("solo", "team", "pro", "mega")
TRUTH = ("counted", "matched", "reported", "modelled", "tested")
TIERS = ("free", "paid", "vip", "speaker", "sponsor", "staff", "press")

# venue time -> UTC, for when the server has no time-zone database
_OFFSETS = {"Asia/Kolkata": 5.5, "Asia/Calcutta": 5.5, "UTC": 0, "Europe/London": 0, "Europe/Lisbon": 0,
            "Europe/Berlin": 1, "Europe/Paris": 1, "Europe/Madrid": 1, "Europe/Amsterdam": 1, "Asia/Dubai": 4,
            "Asia/Singapore": 8, "Asia/Kuala_Lumpur": 8, "Asia/Jakarta": 7, "Asia/Bangkok": 7, "Asia/Tokyo": 9,
            "Australia/Sydney": 10, "America/New_York": -5, "America/Chicago": -6, "America/Denver": -7,
            "America/Los_Angeles": -8, "America/Sao_Paulo": -3, "Africa/Lagos": 1, "Africa/Nairobi": 3}


def tz_offset(tz: str | None, at: datetime | None = None) -> timedelta:
    """The venue's offset from UTC at that moment (daylight saving included
    when the server has the time-zone database)."""
    name = tz or "UTC"
    try:
        from zoneinfo import ZoneInfo
        z = ZoneInfo(name)
        off = (at or datetime.utcnow()).replace(tzinfo=z).utcoffset()
        if off is not None:
            return off
    except Exception:  # noqa: BLE001 - no tz database on the server: fixed offsets
        pass
    return timedelta(hours=_OFFSETS.get(name, 0))


def to_utc(local: datetime | None, tz: str | None) -> datetime | None:
    return (local - tz_offset(tz, local)) if local else None


def to_local(utc: datetime | None, tz: str | None) -> datetime | None:
    return (utc + tz_offset(tz, utc)) if utc else None


def is_event(i: models.Initiative) -> bool:
    return i.kind in ("event", "webinar")


def event_code(title: str, key_date: str | None) -> str:
    words = [w for w in re.findall(r"[A-Za-z0-9]+", title or "") if w.lower() not in ("the", "and", "of", "for", "a", "an", "sample")]
    letters = "".join(w[0] for w in words[:4]).upper() or "EVT"
    yy = (key_date or date.today().isoformat())[2:4]
    return f"{letters}{yy}"


def default_hashtag(title: str) -> str:
    words = [w for w in re.findall(r"[A-Za-z0-9]+", title or "") if w.lower() not in ("sample",)]
    return "#" + "".join(w[:1].upper() + w[1:] for w in words[:4]) if words else "#Event"


def ensure_config(db: Session, i: models.Initiative) -> models.EventConfig:
    cfg = db.get(models.EventConfig, i.id)
    if cfg:
        return cfg
    d = i.details or {}
    fmt = "webinar" if i.kind == "webinar" else str(d.get("format") or "offline").lower()
    if fmt not in FORMATS:
        fmt = "online" if "online" in fmt or "virtual" in fmt else "hybrid" if "hybrid" in fmt else "offline"
    start = None
    if i.key_date:
        try:
            kd = date.fromisoformat(i.key_date[:10])
            hh, mm = 9, 30
            m = re.search(r"(\d{1,2})(?::(\d{2}))?\s*(am|pm)?", str(d.get("time") or ""), re.I)
            if m:
                hh = int(m.group(1)) % 24
                mm = int(m.group(2) or 0)
                if (m.group(3) or "").lower() == "pm" and hh < 12:
                    hh += 12
            start = datetime(kd.year, kd.month, kd.day, hh, mm)
        except ValueError:
            start = None
    end = start + timedelta(hours=FORMATS[fmt]["hours"]) if start else None
    cfg = models.EventConfig(
        initiative_id=i.id, format=fmt, mode="team", starts_at=start, ends_at=end, timezone="Asia/Kolkata",
        code=event_code(i.title, i.key_date), hashtags=[default_hashtag(i.title)],
        keywords=[i.title.lower()] if i.title else [], promo_codes=[], handles={"speakers": [], "sponsors": [], "press": []},
        ad_campaigns=[], zones=[], data={})
    db.add(cfg)
    db.flush()
    return cfg


# ---------------------------------------------------------------- windows --

class Windows:
    """Before = setup -> doors open, during = doors open -> close, after =
    close -> close + the post window (30 days by default). All UTC."""

    def __init__(self, i: models.Initiative, cfg: models.EventConfig):
        self.tz = cfg.timezone or "UTC"
        start_local = cfg.starts_at
        if start_local is None and i.key_date:
            try:
                kd = date.fromisoformat(i.key_date[:10])
                start_local = datetime(kd.year, kd.month, kd.day, 9, 30)
            except ValueError:
                start_local = None
        hours = FORMATS.get(cfg.format, FORMATS["offline"])["hours"]
        end_local = cfg.ends_at or (start_local + timedelta(hours=hours) if start_local else None)
        self.start = to_utc(start_local, self.tz)
        self.end = to_utc(end_local, self.tz)
        self.start_local, self.end_local = start_local, end_local
        created = i.created_at or datetime.utcnow()
        try:
            so = date.fromisoformat(i.starts_on[:10]) if i.starts_on else None
        except ValueError:
            so = None
        self.open = min(created, datetime(so.year, so.month, so.day)) if so else created
        if self.start and self.open > self.start:
            self.open = self.start - timedelta(days=30)
        self.post_days = cfg.post_window_days or 30
        self.close = (self.end + timedelta(days=self.post_days)) if self.end else None

    def phase(self, at: datetime | None) -> str | None:
        if at is None or self.start is None:
            return "before" if at is not None else None
        if at < self.start:
            return "before"
        if self.end and at <= self.end:
            return "during"
        return "after"

    def now_phase(self, now: datetime | None = None) -> str:
        now = now or datetime.utcnow()
        if self.start is None or now < self.start:
            return "before"
        if self.end and now <= self.end:
            return "during"
        if self.close and now > self.close:
            return "done"
        return "after"

    def days_to_go(self, now: datetime | None = None) -> int | None:
        if not self.start:
            return None
        return (self.start.date() - (now or datetime.utcnow()).date()).days

    def as_dict(self) -> dict:
        iso = lambda d: d.isoformat() + "Z" if d else None  # noqa: E731
        return {"open": iso(self.open), "start": iso(self.start), "end": iso(self.end), "close": iso(self.close),
                "start_local": self.start_local.isoformat() if self.start_local else None,
                "end_local": self.end_local.isoformat() if self.end_local else None,
                "timezone": self.tz, "post_days": self.post_days}


# ---------------------------------------------------------------- tickets --

LISTING_SITES = ("konfhub", "district", "bookmyshow", "eventbrite", "luma", "lu.ma", "meetup", "allevents", "townscript", "listing")


def norm_source(raw: str | None) -> str:
    s = (raw or "").strip().lower()
    if not s:
        return "Direct"
    table = [("linkedin", "LinkedIn"), ("instagram", "Instagram"), ("facebook", "Facebook"), ("meta", "Meta ads"),
             ("google", "Google"), ("youtube", "YouTube"), ("whatsapp", "WhatsApp"), ("email", "Email"),
             ("newsletter", "Email"), ("partner", "Partners"), ("speaker", "Speakers"), ("employee", "Employees"),
             ("billboard", "Billboards"), ("qr", "QR codes"), ("poster", "QR codes"), ("press", "Press"),
             ("podcast", "Press"), ("creator", "Creators"), ("walk", "Walk-in"), ("registration page", "Registration page")]
    for k, v in table:
        if k in s:
            return v
    for k in LISTING_SITES:
        if k in s:
            return "Listing sites"
    return s[:1].upper() + s[1:40]


def _icp_of(acc: models.GtmAccount | None) -> bool | None:
    if not acc or not acc.icp_tier:
        return None
    return acc.icp_tier in ("A", "B")


def ticket_from_contact(db: Session, i: models.Initiative, c: models.GtmContact | None, *, source: str | None,
                        when: datetime | None, walk_in: bool = False, ref: str | None = None,
                        tier: str = "free", consent: bool = False, extra: dict | None = None) -> models.EventTicket:
    acc = db.get(models.GtmAccount, c.account_id) if c and c.account_id else None
    t = models.EventTicket(
        initiative_id=i.id, contact_id=c.id if c else None, account_id=acc.id if acc else None,
        name=(c.name if c else None) or (extra or {}).get("name"), email=c.email if c else (extra or {}).get("email"),
        company=(acc.name if acc else None) or (extra or {}).get("company"), title=(c.title if c else None) or (extra or {}).get("title"),
        seniority=c.seniority if c else None, city=(acc.city if acc else None), tier=tier if tier in TIERS else "free",
        icp=_icp_of(acc), source=norm_source(source), ref=ref, walk_in=walk_in, consent=consent,
        registered_at=when or datetime.utcnow(), data=None)
    db.add(t)
    return t


def ensure_tickets(db: Session, i: models.Initiative, cfg: models.EventConfig) -> int:
    """Every registration, check-in and walk-in GD360 already counted (the
    registration page, imports, the walk-in page, the team's invite links)
    gets a ticket. Runs incrementally: only engagements since the last run."""
    E = models.GtmEngagement
    data = dict(cfg.data or {})
    if data.get("sample"):
        return 0
    since = data.get("tickets_synced_at")
    q = db.query(E).filter(E.initiative_id == i.id, E.kind.in_(("registered", "attended", "webinar_attended", "walk_in")))
    if since:
        try:
            q = q.filter(E.occurred_at >= datetime.fromisoformat(since) - timedelta(minutes=5))
        except ValueError:
            pass
    rows = q.order_by(E.occurred_at).limit(20000).all()
    if not rows:
        return 0
    T = models.EventTicket
    by_contact = {t.contact_id: t for t in db.query(T).filter(T.initiative_id == i.id, T.contact_id.isnot(None))}
    made = 0
    for e in rows:
        t = by_contact.get(e.contact_id) if e.contact_id else None
        d = e.detail or {}
        if t is None:
            if not e.contact_id and e.kind != "walk_in":
                continue
            c = db.get(models.GtmContact, e.contact_id) if e.contact_id else None
            acc = db.get(models.GtmAccount, e.account_id) if (e.account_id and not c) else None
            t = ticket_from_contact(db, i, c, source=d.get("source") or e.channel, when=e.occurred_at,
                                    walk_in=e.kind == "walk_in", ref=d.get("ref"), consent=bool(d.get("consent")),
                                    extra={"company": acc.name if acc else None})
            if acc and not t.account_id:
                t.account_id, t.icp = acc.id, _icp_of(acc)
            made += 1
            if e.contact_id:
                by_contact[e.contact_id] = t
        if e.kind in ("attended", "webinar_attended", "walk_in") and t.status != "checked_in":
            t.status, t.checked_in_at = "checked_in", e.occurred_at
            t.checked_in_by = d.get("captured_by") or d.get("by") or e.channel
            if e.kind == "walk_in":
                t.walk_in = True
    data["tickets_synced_at"] = datetime.utcnow().isoformat()
    cfg.data = data
    db.flush()
    return made


def ticket_qr_svg(code: str, scale: int = 6) -> str:
    import io

    import segno
    buf = io.BytesIO()
    segno.make(code, error="m").save(buf, kind="svg", scale=scale, border=2, dark="#06150F", light="#ffffff", omitsize=True)
    out = buf.getvalue().decode()
    return out[out.find("<svg"):] if "<svg" in out else out


def check_in(db: Session, i: models.Initiative, t: models.EventTicket, by: str | None, gate: str | None,
             when: datetime | None = None, client_id: str | None = None) -> bool:
    """Checks a ticket in (once) and counts it the way the rest of GD360
    does: an "attended" signal on the person and their company."""
    if t.status == "checked_in":
        return False
    t.status, t.checked_in_at, t.checked_in_by, t.gate = "checked_in", when or datetime.utcnow(), (by or "")[:80] or None, gate
    if t.contact_id and i.workspace_id:
        from ..initiatives import gtm
        E = models.GtmEngagement
        kind = "webinar_attended" if i.kind == "webinar" else "attended"
        if not db.query(E.id).filter(E.initiative_id == i.id, E.contact_id == t.contact_id, E.kind == kind).first():
            gtm.record(db, i.workspace_id, kind, account_id=t.account_id, contact_id=t.contact_id, initiative_id=i.id,
                       channel="check-in", detail={"by": by, "gate": gate, "ticket": t.code})
    db.add(models.EventTouch(initiative_id=i.id, kind="gate_scan", ticket_id=t.id, zone=gate, source="staff app",
                             occurred_at=t.checked_in_at, client_id=(client_id or None)))
    return True


def iso(d) -> str | None:
    if d is None:
        return None
    if isinstance(d, datetime):
        return d.isoformat() + "Z"
    return d.isoformat()
