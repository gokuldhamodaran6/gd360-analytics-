"""Everything about one event, loaded once per request, and every number
computed from it - with its truth label."""
from __future__ import annotations

from collections import Counter, defaultdict
from datetime import date, datetime, timedelta

from sqlalchemy.orm import Session

from ... import models
from . import ads as ads_mod
from . import core
from . import pipeline as pipe_mod

ONLINE_FORMATS = ("online", "webinar", "launch")

# key -> (label, unit, truth, phase, higher_is_better)
METRICS = {
    "registrations": ("Registrations", "count", "counted", "before", True),
    "icp_registrations": ("ICP registrations", "count", "counted", "before", True),
    "icp_share_registrations": ("ICP share of registrants", "pct", "counted", "before", True),
    "attended": ("People who came", "count", "counted", "during", True),
    "attendance_rate": ("Show-up rate", "pct", "counted", "during", True),
    "icp_attended": ("ICP people who came", "count", "counted", "during", True),
    "icp_share_attended": ("ICP share in the room", "pct", "counted", "during", True),
    "walk_ins": ("Walk-ins", "count", "counted", "during", True),
    "meetings": ("Meetings held", "count", "counted", "during", True),
    "sponsor_leads_avg": ("Leads per sponsor", "count", "counted", "during", True),
    "sponsor_leads": ("Sponsor leads", "count", "counted", "during", True),
    "sponsors_renewing": ("Sponsors renewing", "count", "reported", "after", True),
    "nps": ("NPS", "score", "reported", "after", True),
    "session_rating": ("Average session rating", "rating", "reported", "during", True),
    "max_queue_minutes": ("Longest queue", "minutes", "counted", "during", False),
    "stream_peak": ("Livestream peak", "count", "counted", "during", True),
    "avg_watch_minutes": ("Average watch time", "minutes", "counted", "during", True),
    "replay_views": ("Replay views", "count", "counted", "after", True),
    "questions": ("Questions asked", "count", "counted", "during", True),
    "cta_clicks": ("Call-to-action clicks", "count", "counted", "during", True),
    "mentions": ("Posts about the event", "count", "matched", "all", True),
    "mentions_before": ("Posts before", "count", "matched", "before", True),
    "mentions_during": ("Posts during", "count", "matched", "during", True),
    "mentions_after": ("Posts after", "count", "matched", "after", True),
    "reach": ("Reach of posts", "count", "reported", "all", True),
    "positive_share": ("Positive posts", "pct", "modelled", "all", True),
    "ad_spend": ("Ad spend (synced)", "money", "counted", "before", False),
    "total_cost": ("Event cost", "money", "counted", "all", False),
    "cost_per_attendee": ("Cost per attendee", "money", "counted", "all", False),
    "cost_per_icp_registration": ("Cost per ICP registration", "money", "counted", "before", False),
    "income": ("Sponsor and ticket income", "money", "counted", "all", True),
    "pipeline_sourced": ("Pipeline sourced", "money", "matched", "after", True),
    "pipeline_influenced": ("Pipeline influenced", "money", "matched", "after", True),
    "won": ("Revenue won", "money", "matched", "after", True),
    "roi_pct": ("ROI", "pct", "modelled", "after", True),
    "email_click_rate": ("Email click rate", "pct", "counted", "before", True),
}


def _d(dt: datetime | None) -> str | None:
    return dt.date().isoformat() if dt else None


class Ctx:
    def __init__(self, db: Session, i: models.Initiative, now: datetime | None = None):
        self.db, self.i = db, i
        self.cfg = core.ensure_config(db, i)
        core.ensure_tickets(db, i, self.cfg)
        self.data = self.cfg.data or {}
        self.sample = bool(self.data.get("sample"))
        self.w = core.Windows(i, self.cfg)
        self.now = now or datetime.utcnow()
        self.online = self.cfg.format in ONLINE_FORMATS
        T = models.EventTicket
        self.all_tickets = db.query(T).filter(T.initiative_id == i.id).all()
        self.tickets = [t for t in self.all_tickets if t.status != "cancelled"]
        self.touches = db.query(models.EventTouch).filter(models.EventTouch.initiative_id == i.id).all()
        self.by_kind: dict[str, list] = defaultdict(list)
        for x in self.touches:
            self.by_kind[x.kind].append(x)
        self.mentions_all = db.query(models.EventMention).filter(models.EventMention.initiative_id == i.id).all()
        self.mentions = [m for m in self.mentions_all if m.state in ("auto", "confirmed")]
        self.sessions = db.query(models.EventSession).filter(models.EventSession.initiative_id == i.id) \
            .order_by(models.EventSession.starts_at).all()
        self.sponsors = db.query(models.EventSponsor).filter(models.EventSponsor.initiative_id == i.id) \
            .order_by(models.EventSponsor.name).all()
        self.leads = db.query(models.EventLead).filter(models.EventLead.initiative_id == i.id).all()
        self.goals = db.query(models.EventGoal).filter(models.EventGoal.initiative_id == i.id) \
            .order_by(models.EventGoal.position, models.EventGoal.created_at).all()
        self._ads = None
        self._deals = None
        self._values = None

    # ------------------------------------------------------------ helpers --
    def phase_of(self, at: datetime | None) -> str | None:
        return self.w.phase(at)

    @property
    def registered(self) -> list:
        return [t for t in self.tickets if not t.walk_in]

    @property
    def came(self) -> list:
        if self.online:
            return [t for t in self.tickets if t.status == "checked_in" or (t.online_minutes or 0) > 0]
        return [t for t in self.tickets if t.status == "checked_in"]

    def ads(self) -> dict:
        if self._ads is None:
            lo = (self.w.open - timedelta(days=7)).date()
            hi = (self.w.close or self.now).date()
            try:
                self._ads = ads_mod.campaigns_for(self.db, self.i, self.cfg, lo, hi)
            except Exception as e:  # noqa: BLE001 - a broken sync never breaks the page
                self._ads = {"rows": [], "campaigns": [], "unmatched": [], "sources": [], "total": 0.0, "error": str(e)[:200]}
        return self._ads

    def deals(self) -> dict:
        if self._deals is None:
            companies = {t.company for t in self.came if t.company}
            try:
                self._deals = pipe_mod.deals_for(self.db, self.i, self.cfg, companies, self.w.start)
            except Exception as e:  # noqa: BLE001
                self._deals = {"deals": [], "sources": [], "sourced": 0, "influenced": 0, "won": 0, "sourced_n": 0,
                               "influenced_n": 0, "won_n": 0, "error": str(e)[:200]}
        return self._deals

    def costs(self) -> list[dict]:
        out = [{"label": str(c.get("label") or "Cost")[:80], "amount": float(c.get("amount") or 0),
                "channel": c.get("channel"), "kind": c.get("kind") or "cost"} for c in (self.data.get("costs") or [])
               if isinstance(c, dict)]
        spend = self.ads()["total"]
        if spend and not any(c.get("channel") == "_ads_synced" for c in out):
            out.append({"label": "Ad spend (synced from Meta / Google)", "amount": spend, "channel": "_ads_synced", "kind": "marketing"})
        return out

    def income_lines(self) -> list[dict]:
        prices = self.data.get("prices") or {}
        lines = []
        sp = sum(float(s.amount or 0) for s in self.sponsors)
        if sp:
            lines.append({"label": f"Sponsors · {len(self.sponsors)}", "amount": sp})
        for tier in ("vip", "paid"):
            price = float(prices.get(tier) or 0)
            n = sum(1 for t in self.registered if t.tier == tier)
            if price and n:
                lines.append({"label": f"{tier.upper() if tier == 'vip' else 'Paid'} passes · {n} × {price:,.0f}", "amount": price * n})
        for x in self.data.get("income") or []:
            if isinstance(x, dict) and x.get("amount"):
                lines.append({"label": str(x.get("label") or "Income")[:80], "amount": float(x["amount"])})
        return lines

    def mentions_in(self, phase: str) -> list:
        return [m for m in self.mentions if self.phase_of(m.posted_at or m.created_at) == phase]

    # ------------------------------------------------------------- values --
    def values(self) -> dict:
        if self._values is not None:
            return self._values
        v: dict[str, float | None] = {}
        reg, came = self.registered, self.came
        v["registrations"] = len(reg)
        icp_known = [t for t in reg if t.icp is not None]
        v["icp_registrations"] = sum(1 for t in reg if t.icp)
        v["icp_share_registrations"] = round(100 * v["icp_registrations"] / len(icp_known), 1) if icp_known else None
        v["attended"] = len(came)
        came_reg = [t for t in came if not t.walk_in]
        v["attendance_rate"] = round(100 * len(came_reg) / len(reg), 1) if reg else None
        ck = [t for t in came if t.icp is not None]
        v["icp_attended"] = sum(1 for t in came if t.icp)
        v["icp_share_attended"] = round(100 * v["icp_attended"] / len(ck), 1) if ck else None
        v["walk_ins"] = sum(1 for t in self.tickets if t.walk_in)
        meet = len(self.by_kind.get("meeting", []))
        if not self.sample and self.i.workspace_id:
            E = models.GtmEngagement
            lo = self.w.start - timedelta(days=1) if self.w.start else None
            q = self.db.query(E.id).filter(E.initiative_id == self.i.id, E.kind == "meeting")
            if lo:
                q = q.filter(E.occurred_at >= lo)
            meet += q.count()
        v["meetings"] = meet
        v["sponsor_leads"] = len(self.leads)
        v["sponsor_leads_avg"] = round(len(self.leads) / len(self.sponsors), 1) if self.sponsors else None
        v["sponsors_renewing"] = sum(1 for s in self.sponsors if s.renewal in ("signed", "verbal")) if self.sponsors else None
        sv = [x.value for x in self.by_kind.get("survey", []) if x.value is not None]
        if sv:
            pro = sum(1 for x in sv if x >= 9)
            det = sum(1 for x in sv if x <= 6)
            v["nps"] = round(100 * (pro - det) / len(sv))
        else:
            v["nps"] = None
        v["nps_answers"] = len(sv)
        rt = [x.value for x in self.by_kind.get("rating", []) if x.value]
        v["session_rating"] = round(sum(rt) / len(rt), 2) if rt else None
        q = [x.value for x in self.by_kind.get("queue", []) if x.value is not None]
        v["max_queue_minutes"] = round(max(q), 1) if q else None
        sv2 = [x.value for x in self.by_kind.get("stream_viewers", []) if x.value is not None]
        v["stream_peak"] = int(max(sv2)) if sv2 else None
        om = [t.online_minutes for t in self.tickets if (t.online_minutes or 0) > 0]
        v["avg_watch_minutes"] = round(sum(om) / len(om), 1) if om else None
        v["replay_views"] = int(sum(x.value or 1 for x in self.by_kind.get("replay_view", []))) or None
        v["questions"] = len(self.by_kind.get("question", [])) or None
        v["cta_clicks"] = len(self.by_kind.get("cta_click", [])) or None
        v["polls"] = len(self.by_kind.get("poll", [])) or None
        v["chat"] = len(self.by_kind.get("chat", [])) or None
        m = self.mentions
        v["mentions"] = len(m)
        for ph in ("before", "during", "after"):
            v[f"mentions_{ph}"] = len(self.mentions_in(ph))
        v["reach"] = round(sum(x.reach or 0 for x in m)) or None
        v["engagements"] = round(sum(x.engagements or 0 for x in m)) or None
        snt = [x.sentiment for x in m if x.sentiment]
        v["positive_share"] = round(100 * sum(1 for s in snt if s == "positive") / len(snt), 1) if snt else None
        v["review_queue"] = sum(1 for x in self.mentions_all if x.state == "review")
        a = self.ads()
        v["ad_spend"] = a["total"] or None
        costs = self.costs()
        total_cost = sum(c["amount"] for c in costs)
        v["total_cost"] = round(total_cost, 2) if total_cost else None
        v["cost_per_attendee"] = round(total_cost / len(came)) if total_cost and came else None
        mk = sum(c["amount"] for c in costs if c.get("kind") == "marketing" or c.get("channel"))
        v["marketing_cost"] = round(mk, 2) if mk else None
        if self.w.now_phase(self.now) == "before":
            # before the day, only what has really been spent: the synced ad accounts
            v["cost_per_icp_registration"] = round(a["total"] / v["icp_registrations"]) if a["total"] and v["icp_registrations"] else None
        else:
            v["cost_per_icp_registration"] = round(mk / v["icp_registrations"]) if mk and v["icp_registrations"] else None
        inc = sum(x["amount"] for x in self.income_lines())
        v["income"] = round(inc, 2) if inc else None
        d = self.deals()
        v["pipeline_sourced"] = d["sourced"] or None
        v["pipeline_influenced"] = d["influenced"] or None
        v["won"] = d["won"] or None
        win = float(self.data.get("win_rate") or 0.22)
        if total_cost and d["sourced"]:
            v["expected_revenue"] = round(d["sourced"] * win)
            v["roi_pct"] = round(100 * (d["sourced"] * win + inc - total_cost) / total_cost)
        else:
            v["expected_revenue"] = None
            v["roi_pct"] = None
        v["checked_in_now"] = len(came)
        self._values = v
        return v

    # --------------------------------------------------------- breakdowns --
    def channels(self) -> list[dict]:
        rows: dict[str, dict] = {}
        for t in self.tickets:
            src = "Walk-in" if t.walk_in else (t.source or "Direct")
            r = rows.setdefault(src, {"channel": src, "registrations": 0, "icp": 0, "icp_known": 0, "came": 0, "spend": 0.0})
            if not t.walk_in:
                r["registrations"] += 1
            if t.icp is not None:
                r["icp_known"] += 1
                r["icp"] += int(bool(t.icp))
            if t.status == "checked_in" or (self.online and (t.online_minutes or 0) > 0):
                r["came"] += 1
        for c in self.costs():
            ch = c.get("channel")
            if ch and ch != "_ads_synced":
                rows.setdefault(ch, {"channel": ch, "registrations": 0, "icp": 0, "icp_known": 0, "came": 0, "spend": 0.0})["spend"] += c["amount"]
        for camp in self.ads()["campaigns"]:
            ch = camp["platform"]
            rows.setdefault(ch, {"channel": ch, "registrations": 0, "icp": 0, "icp_known": 0, "came": 0, "spend": 0.0})["spend"] += camp["spend"]
        out = []
        for r in rows.values():
            icp_share = round(100 * r["icp"] / r["icp_known"], 1) if r["icp_known"] else None
            out.append({**r, "icp_share": icp_share,
                        "cost_per_icp": round(r["spend"] / r["icp"]) if r["spend"] and r["icp"] else None,
                        "cost_per_reg": round(r["spend"] / r["registrations"]) if r["spend"] and r["registrations"] else None,
                        "show_rate": round(100 * r["came"] / r["registrations"], 1) if r["registrations"] else None})
        out.sort(key=lambda r: -(r["registrations"] + r["came"] * 0.01))
        return out

    def daily(self) -> list[dict]:
        """One row per day from the open of registration to now (or the end
        of the after window): registrations, check-ins, posts, spend."""
        lo = self.w.open.date()
        hi = min(self.now, self.w.close or self.now).date()
        if hi < lo:
            hi = lo
        days: dict[str, dict] = {}
        d = lo
        while d <= hi and len(days) < 400:
            days[d.isoformat()] = {"date": d.isoformat(), "registrations": 0, "checkins": 0, "mentions": 0, "spend": 0.0}
            d += timedelta(days=1)
        for t in self.tickets:
            if not t.walk_in and t.registered_at:
                k = _d(t.registered_at)
                if k in days:
                    days[k]["registrations"] += 1
            if t.checked_in_at:
                k = _d(t.checked_in_at)
                if k in days:
                    days[k]["checkins"] += 1
        for m in self.mentions:
            k = _d(m.posted_at or m.created_at)
            if k in days:
                days[k]["mentions"] += 1
        for r in self.ads()["rows"]:
            if r["date"] in days:
                days[r["date"]]["spend"] += float(r["spend"] or 0)
        out = list(days.values())
        for r in out:
            r["spend"] = round(r["spend"], 2)
            r["phase"] = self.phase_of(datetime.fromisoformat(r["date"]) + timedelta(hours=12))
        return out
