"""The event agent: watches the numbers and suggests the next move for the
phase the event is in. Approving a suggestion does it when it can (emails
the confirm links, the survey, the sponsor reports, sign reminders; opens
a follow-up task) - and says plainly when it can't (no email set up).
Every decision is kept."""
from __future__ import annotations

import html
import threading
from datetime import datetime

from ... import models
from . import core, forecast
from .ctx import Ctx

AGENTS = {"before": "Demand", "during": "Ops", "after": "Follow-up"}


def _money(ctx: Ctx, x) -> str:
    return f"{(ctx.data.get('currency') or 'INR').upper()} {x:,.0f}"


def rules(ctx: Ctx) -> list[dict]:
    out: list[dict] = []
    ph = ctx.w.now_phase(ctx.now)
    v = ctx.values()
    if ph == "before":
        su = forecast.showup(ctx, write=False) if ctx.registered else None
        silent = [t for t in ctx.registered if not t.confirmed_at and (t.show_prob if t.show_prob is not None else 0.5) < 0.55]
        if len(silent) >= 5:
            out.append({"key": "confirm_silent", "agent": "Demand", "phase": "before",
                        "title": f"Ask {len(silent):,} quiet registrants to confirm their seat",
                        "detail": "A one-tap confirm link by email. Seats nobody confirms can go to the waitlist.",
                        "impact": f"Show-up model: about {round(sum((t.show_prob or 0.5) for t in silent)):,} of them come today",
                        "payload": {"tickets": [t.id for t in silent][:3000]}, "can_do": True})
        unsigned = [g for g in ctx.goals if not g.signed_at]
        if unsigned:
            out.append({"key": "sign_goals", "agent": "Planner", "phase": "before",
                        "title": f"Remind {len(unsigned)} owner{'s' if len(unsigned) > 1 else ''} to sign their goal",
                        "detail": ", ".join(f"{g.owner_name}: {g.label}" for g in unsigned[:4]),
                        "impact": "A goal nobody signed can be moved after the fact", "payload": {"goals": [g.id for g in unsigned]},
                        "can_do": True})
        priced = [c for c in ctx.channels() if c.get("cost_per_icp") and c.get("registrations", 0) >= 10]
        if len(priced) >= 2:
            best = min(priced, key=lambda c: c["cost_per_icp"])
            worst = max(priced, key=lambda c: c["cost_per_icp"])
            if worst["cost_per_icp"] > 1.8 * best["cost_per_icp"]:
                out.append({"key": f"shift_{best['channel']}", "agent": "Promoter", "phase": "before",
                            "title": f"Move budget from {worst['channel']} to {best['channel']}",
                            "detail": f"{best['channel']}: {_money(ctx, best['cost_per_icp'])} per ICP person · "
                                      f"{worst['channel']}: {_money(ctx, worst['cost_per_icp'])}",
                            "impact": f"About {worst['cost_per_icp'] / best['cost_per_icp']:.1f}× more ICP people per rupee moved",
                            "payload": {}, "can_do": False})
        regs = forecast.registrations(ctx)
        tgt = next((g.target for g in ctx.goals if g.metric == "registrations"), None)
        if regs and tgt and regs.get("median") and regs["median"] < 0.9 * tgt:
            out.append({"key": "behind_pace", "agent": "Demand", "phase": "before",
                        "title": f"Registrations are behind: forecast {regs['median']:,} vs {tgt:,.0f}",
                        "detail": "Personal invites from speakers and partners convert best; send them a new share card.",
                        "impact": f"Range {regs['p10']:,}–{regs['p90']:,}", "payload": {}, "can_do": False})
        if su and ctx.cfg.capacity and su["expected"] > ctx.cfg.capacity:
            out.append({"key": "over_capacity", "agent": "Ops", "phase": "before",
                        "title": f"More people may come ({su['expected']:,}) than the room holds ({ctx.cfg.capacity:,})",
                        "detail": "Close registration or plan overflow and a waitlist.", "impact": "", "payload": {}, "can_do": False})
    if ph in ("before", "during") and not ctx.sample:
        if not ctx.db.query(models.EventAsset.id).filter(models.EventAsset.initiative_id == ctx.i.id).first():
            out.append({"key": "brand_images", "agent": "Analyst", "phase": "before",
                        "title": "Upload the banner or logo so posts without a hashtag are found too",
                        "detail": "The picture check looks for your banner, backdrop or badge in every post.", "impact": "", "payload": {},
                        "can_do": False})
    if (v.get("review_queue") or 0) > 0:
        out.append({"key": "review_posts", "agent": "Analyst", "phase": None,
                    "title": f"Check {v['review_queue']} post{'s' if v['review_queue'] > 1 else ''} that might be about the event",
                    "detail": "They matched on words only, below the 0.90 bar for counting automatically.", "impact": "",
                    "payload": {}, "can_do": False})
    if ph == "during":
        from .views import sessions_rows
        for s in sessions_rows(ctx):
            if s.get("fill") and s["fill"] > 100:
                out.append({"key": f"overflow_{s['id']}", "agent": "Ops", "phase": "during",
                            "title": f"{s['title']} is at {s['fill']}%: open the overflow room",
                            "detail": f"{s['in_room']} in a room for {s['capacity']}", "impact": "", "payload": {}, "can_do": False})
        q = sorted(ctx.by_kind.get("queue", []), key=lambda x: x.occurred_at)
        if q and (q[-1].value or 0) > 10:
            out.append({"key": "queue", "agent": "Ops", "phase": "during",
                        "title": f"{q[-1].zone or 'Gate'} queue is {q[-1].value:.0f} minutes", "detail": "Open more check-in lanes or move staff.",
                        "impact": "", "payload": {}, "can_do": False})
        leads = {}
        for l in ctx.leads:
            leads[l.sponsor_id] = leads.get(l.sponsor_id, 0) + 1
        frac = 0.5
        if ctx.w.start and ctx.w.end and ctx.w.end > ctx.w.start:
            frac = max(0.1, min(1.0, (ctx.now - ctx.w.start) / (ctx.w.end - ctx.w.start)))
        for s in ctx.sponsors:
            if s.goal_leads and leads.get(s.id, 0) < 0.6 * frac * s.goal_leads:
                out.append({"key": f"sponsor_{s.id}", "agent": "Sponsor", "phase": "during",
                            "title": f"Help {s.name}: {leads.get(s.id, 0)} leads of {s.goal_leads}",
                            "detail": "A stage mention before the next session and a meeting-pod slot usually lift booth traffic.",
                            "impact": "", "payload": {}, "can_do": False})
    if ph in ("after", "done"):
        came = [t for t in ctx.came if t.email]
        if came and not ctx.data.get("survey_sent_at"):
            out.append({"key": "send_survey", "agent": "Follow-up", "phase": "after",
                        "title": f"Send the 2-question survey to {len(came):,} people who came",
                        "detail": "NPS and one line on what to change. Answers count on the report as they arrive.",
                        "impact": "", "payload": {}, "can_do": True})
        unsent = [s for s in ctx.sponsors if s.contact_email and not (s.data or {}).get("report_sent_at")]
        if unsent:
            out.append({"key": "sponsor_reports", "agent": "Sponsor", "phase": "after",
                        "title": f"Send {len(unsent)} sponsor report{'s' if len(unsent) > 1 else ''}",
                        "detail": "Each sponsor gets a private link to their own live report, with a renew button.",
                        "impact": "", "payload": {"sponsors": [s.id for s in unsent]}, "can_do": True})
        pos = [m for m in ctx.mentions if m.author_kind == "attendee" and m.sentiment == "positive"]
        if pos:
            out.append({"key": "thank_posters", "agent": "Follow-up", "phase": "after",
                        "title": f"Thank {len(pos)} attendees who posted, and ask for a testimonial",
                        "detail": "Shown in Buzz with links to each post.", "impact": "", "payload": {}, "can_do": False})
        neg = [m for m in ctx.mentions if m.sentiment == "negative"]
        if neg:
            out.append({"key": "reply_complaints", "agent": "Follow-up", "phase": "after",
                        "title": f"Reply to {len(neg)} unhappy post{'s' if len(neg) > 1 else ''}",
                        "detail": "Listed in Buzz → After.", "impact": "", "payload": {}, "can_do": False})
        icp = [t for t in ctx.came if t.icp]
        if icp and not ctx.data.get("followup_task"):
            out.append({"key": "follow_up_icp", "agent": "Follow-up", "phase": "after",
                        "title": f"Follow up with {len(icp):,} ICP people who came",
                        "detail": "Adds a follow-up task with the list, owners first.", "impact": "", "payload": {}, "can_do": True})
    return out


def list_actions(ctx: Ctx, refresh: bool = False) -> list[dict]:
    A = models.EventAction
    rows = ctx.db.query(A).filter(A.initiative_id == ctx.i.id).order_by(A.created_at.desc()).all()
    if refresh:
        try:
            current = {r["key"]: r for r in rules(ctx)}
        except Exception:  # noqa: BLE001 - suggestions never break a page
            current = {}
        have = {a.key: a for a in rows}
        for k, r in current.items():
            a = have.get(k)
            if a is None:
                a = A(initiative_id=ctx.i.id, key=k, agent=r["agent"], phase=r["phase"], title=r["title"], detail=r["detail"],
                      impact=r.get("impact"), payload={**(r.get("payload") or {}), "can_do": r.get("can_do")})
                ctx.db.add(a)
                rows.insert(0, a)
            elif a.state == "proposed":
                a.title, a.detail, a.impact = r["title"], r["detail"], r.get("impact")
                a.payload = {**(r.get("payload") or {}), "can_do": r.get("can_do")}
        for a in list(rows):
            if a.state == "proposed" and a.key not in current:
                ctx.db.delete(a)
                rows.remove(a)
        ctx.db.flush()
    return [row(a) for a in rows]


def row(a: models.EventAction) -> dict:
    p = a.payload or {}
    return {"id": a.id, "key": a.key, "agent": a.agent, "phase": a.phase, "title": a.title, "detail": a.detail, "impact": a.impact,
            "state": a.state, "can_do": bool(p.get("can_do")), "result": a.result, "decided_by": a.decided_by,
            "decided_at": core.iso(a.decided_at), "created_at": core.iso(a.created_at)}


def _mail(to_html: list[tuple[str, str, str, str]]) -> None:
    """[(to, subject, html, text)] - sent on a thread, one by one."""
    from ..automations import send_email

    def go():
        for to, subj, h, t in to_html:
            try:
                send_email([to], subj, h, t)
            except Exception:  # noqa: BLE001 - keep going
                pass
    threading.Thread(target=go, daemon=True).start()


def _wrap(body: str) -> str:
    return (f'<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;color:#1B2321;'
            f'max-width:560px;line-height:1.5">{body}</div>')


def _btn(url: str, label: str) -> str:
    return (f'<a href="{html.escape(url)}" style="display:inline-block;background:#0E7C5A;color:#fff;padding:10px 16px;'
            f'border-radius:8px;text-decoration:none">{html.escape(label)}</a>')


def execute(ctx: Ctx, a: models.EventAction, by: str) -> str:
    """Does the approved action. Returns what happened, in a sentence."""
    from ..automations import app_url, email_configured
    i, cfg = ctx.i, ctx.cfg
    base = app_url()
    can_mail = email_configured() and not ctx.sample
    k = a.key
    if k == "confirm_silent":
        ids = set((a.payload or {}).get("tickets") or [])
        ts = [t for t in ctx.registered if t.id in ids and t.email]
        if not can_mail:
            return (f"{len(ts):,} confirm links are ready - email isn't set up here" + (" (sample event)" if ctx.sample else "")
                    + ", so copy them from People.")
        from ..initiatives.campaigns import backend_url
        _mail([(t.email, f"Is your seat at {i.title} still yours?",
                _wrap(f"<p>Hi {html.escape((t.name or 'there').split(' ')[0])},</p><p>You registered for <b>{html.escape(i.title)}</b>. "
                      f"Tap to confirm you're coming - it frees seats for the waitlist if you can't.</p>"
                      f"<p>{_btn(f'{backend_url()}/public/eventos/c/{t.code}', 'Yes, I am coming')}</p>"),
                f"Confirm your seat at {i.title}: {backend_url()}/public/eventos/c/{t.code}") for t in ts])
        return f"Sending {len(ts):,} confirm emails."
    if k == "sign_goals":
        gs = [g for g in ctx.goals if not g.signed_at and g.owner_email]
        if not can_mail or not gs:
            return "Sign links are on the Expectations tab - " + ("add owner emails to send them." if not gs else "email isn't set up, so share them by hand.")
        _mail([(g.owner_email, f"Please sign: {g.label} ({i.title})",
                _wrap(f"<p>Hi {html.escape(g.owner_name.split(' ')[0])},</p><p>For <b>{html.escape(i.title)}</b> you expect: "
                      f"<b>{html.escape(g.label)}</b> - target {g.target:,.0f} (range {g.low:,.0f}–{g.high:,.0f}).</p>"
                      f"<p>{_btn(f'{base}/sign/{g.sign_token}', 'Review and sign')}</p>"),
                f"Sign your goal for {i.title}: {base}/sign/{g.sign_token}") for g in gs])
        return f"Sent {len(gs)} sign reminders."
    if k == "send_survey":
        came = [t for t in ctx.came if t.email]
        if not can_mail:
            return f"Survey link: {base}/f/{cfg.survey_token} - email isn't set up here, so share it by hand."
        _mail([(t.email, f"Two quick questions about {i.title}",
                _wrap(f"<p>Hi {html.escape((t.name or 'there').split(' ')[0])},</p><p>Thanks for coming to <b>{html.escape(i.title)}</b>. "
                      f"How likely are you to recommend it to a colleague?</p><p>{_btn(f'{base}/f/{cfg.survey_token}?t={t.code}', 'Answer in 20 seconds')}</p>"),
                f"Two quick questions about {i.title}: {base}/f/{cfg.survey_token}?t={t.code}") for t in came])
        cfg.data = {**(cfg.data or {}), "survey_sent_at": datetime.utcnow().isoformat()}
        return f"Sending the survey to {len(came):,} people."
    if k == "sponsor_reports":
        ids = set((a.payload or {}).get("sponsors") or [])
        ss = [s for s in ctx.sponsors if s.id in ids and s.contact_email]
        if not can_mail:
            return "Each sponsor's report link is on the Sponsors tab - email isn't set up here, so share them by hand."
        msgs = []
        for s in ss:
            msgs.append((s.contact_email, f"Your results at {i.title}",
                         _wrap(f"<p>Hello {html.escape(s.name)} team,</p><p>Your live report from <b>{html.escape(i.title)}</b> is ready: "
                               f"leads, booth traffic, who you met.</p><p>{_btn(f'{base}/sp/{s.token}', 'Open your report')}</p>"),
                         f"Your report: {base}/sp/{s.token}"))
            s.data = {**(s.data or {}), "report_sent_at": datetime.utcnow().isoformat()}
        _mail(msgs)
        return f"Sent {len(ss)} sponsor reports."
    if k == "follow_up_icp":
        icp = [t for t in ctx.came if t.icp]
        n = ctx.db.query(models.InitiativeTask).filter(models.InitiativeTask.initiative_id == i.id).count()
        names = "; ".join(f"{t.name or t.email} ({t.company or '-'})" for t in icp[:60])
        ctx.db.add(models.InitiativeTask(initiative_id=i.id, title=f"Follow up with {len(icp)} ICP people who came",
                                         detail=names + (" …" if len(icp) > 60 else ""), status="todo", origin="assistant",
                                         position=n + 1, phase_id=(i.phases or [{}])[-1].get("id")))
        cfg.data = {**(cfg.data or {}), "followup_task": True}
        return "Added a follow-up task on the Plan with the list."
    return "Marked as done."

