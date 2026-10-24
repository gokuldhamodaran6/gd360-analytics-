"""2026-10-17 (R53): the morning digest - decisions waiting for you, what Autopilot did overnight, what is behind -
by email, Slack, Microsoft Teams and WhatsApp (whichever the workspace set up), at the hour it chose, once a day.

WhatsApp: a business-initiated message needs an approved template; the digest goes as that template with the summary
as its one parameter (whatsapp_template), else WhatsApp is skipped and the page says why.
"""
from __future__ import annotations

import html
from datetime import datetime, timedelta

import requests
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from ... import models
from . import hooks

TIMEOUT = 15


def build(db: Session, user: models.User, workspace_id: str) -> dict:
    from ..initiatives import metrics
    from . import pace
    since = datetime.utcnow() - timedelta(hours=24)
    mine = db.query(models.Initiative).filter(models.Initiative.workspace_id == workspace_id, models.Initiative.owner_id == user.id,
                                              models.Initiative.status.in_(("active", "planning"))).all()
    ids = [i.id for i in mine]
    decisions = db.query(models.AgentAction).filter(models.AgentAction.initiative_id.in_(ids), models.AgentAction.state == "proposed").count() if ids else 0
    review = db.query(models.InitiativeEvidence).filter(models.InitiativeEvidence.initiative_id.in_(ids), models.InitiativeEvidence.state == "review").count() if ids else 0
    did = db.query(models.AgentAction).filter(models.AgentAction.initiative_id.in_(ids), models.AgentAction.auto.is_(True),
                                              models.AgentAction.created_at >= since).all() if ids else []
    behind = []
    for i in mine:
        try:
            res = metrics.compute(db, i)
            t = metrics.targets_with_actuals(i, res["values"])
            for f in pace.forecast(db, i, t):
                if f.get("prob") is not None and f["prob"] < 0.5:
                    behind.append({"initiative": i.title, "label": f["label"], "prob": f["prob"], "median": f.get("median"), "target": f["target"]})
        except Exception:  # noqa: BLE001 - one initiative never blocks the digest
            db.rollback()
    lines = []
    if decisions or review:
        lines.append(f"{decisions} decision{'s' if decisions != 1 else ''} and {review} match{'es' if review != 1 else ''} wait for you.")
    if did:
        lines.append(f"Autopilot did {len(did)} thing{'s' if len(did) != 1 else ''} overnight: " + "; ".join(list(dict.fromkeys((a.result or a.title).rstrip(".") for a in did))[:3]) + ".")
    for b in behind[:3]:
        lines.append(f"{b['initiative']}: {b['label']} has a {round(100 * b['prob'])}% chance of reaching {b['target']:,.0f} (heading for {b['median']:,.0f}).")
    if not lines:
        lines.append("Nothing needs you today. Everything is on pace.")
    return {"user": user.full_name or user.email, "initiatives": len(mine), "decisions": decisions, "review": review, "did": len(did), "behind": behind[:5], "lines": lines}


def send(db: Session, bp: models.BusinessProfile, user: models.User, d: dict, post=requests.post) -> list[dict]:
    from ..automations import app_url, email_configured, send_email
    cur = bp.integrations or {}
    text = f"Euliv morning digest\n\n" + "\n".join(f"• {x}" for x in d["lines"]) + f"\n\nOpen: {app_url()}/initiatives"
    out = []
    to = cur.get("digest_email") or user.email
    if to and email_configured():
        try:
            send_email([to], "Your initiatives this morning",
                       '<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;color:#0B0F0E;max-width:560px">'
                       + "".join(f'<p style="margin:0 0 10px">{html.escape(x)}</p>' for x in d["lines"])
                       + f'<p><a href="{app_url()}/initiatives">Open Initiatives</a></p></div>', text)
            out.append({"channel": "email", "ok": True})
        except Exception as e:  # noqa: BLE001
            out.append({"channel": "email", "ok": False, "why": str(e)[:100]})
    for ch, key in (("slack", "slack_webhook"), ("teams", "teams_webhook")):
        url = hooks.secret(bp, key)
        if url and cur.get(f"digest_{ch}", True):
            try:
                body = {"text": text} if ch == "slack" else {"text": text.replace("\n", "<br>")}
                r = post(url, json=body, timeout=TIMEOUT)
                out.append({"channel": ch, "ok": r.status_code < 300, "status": r.status_code})
            except Exception as e:  # noqa: BLE001
                out.append({"channel": ch, "ok": False, "why": str(e)[:100]})
    tok = hooks.secret(bp, "whatsapp_token")
    if tok and cur.get("whatsapp_phone_id") and cur.get("whatsapp_to"):
        if not cur.get("whatsapp_template"):
            out.append({"channel": "whatsapp", "ok": False, "why": "needs an approved template name"})
        else:
            try:
                r = post(f"https://graph.facebook.com/v19.0/{cur['whatsapp_phone_id']}/messages", timeout=TIMEOUT, headers={"Authorization": f"Bearer {tok}"},
                         json={"messaging_product": "whatsapp", "to": str(cur["whatsapp_to"]), "type": "template",
                               "template": {"name": cur["whatsapp_template"], "language": {"code": "en"},
                                            "components": [{"type": "body", "parameters": [{"type": "text", "text": " ".join(d["lines"])[:900]}]}]}})
                out.append({"channel": "whatsapp", "ok": r.status_code < 300, "status": r.status_code})
            except Exception as e:  # noqa: BLE001
                out.append({"channel": "whatsapp", "ok": False, "why": str(e)[:100]})
    return out


def tick(db: Session, now: datetime | None = None, force_user: str | None = None) -> list[dict]:
    """Once a day per person, at the workspace's digest hour (its timezone)."""
    from ..eventos.core import to_local
    from . import policy
    now = now or datetime.utcnow()
    sent = []
    for bp in db.query(models.BusinessProfile).all():
        cur = dict(bp.integrations or {})
        if cur.get("digest_on") is False:
            continue
        local = to_local(now, cur.get("digest_timezone") or "Asia/Kolkata")
        if not force_user and local.hour != int(cur.get("digest_hour") or 8):
            continue
        day = local.date().isoformat()
        owners = {o for (o,) in db.query(models.Initiative.owner_id).filter(models.Initiative.workspace_id == bp.workspace_id,
                                                                              models.Initiative.status.in_(("active", "planning"))).distinct()}
        if force_user:
            owners = {force_user} & owners or {force_user}
        last = dict(cur.get("_digest_sent") or {})
        for uid in owners:
            if not force_user and last.get(uid) == day:
                continue
            u = db.get(models.User, uid)
            if u is None:
                continue
            d = build(db, u, bp.workspace_id)
            res = send(db, bp, u, d)
            last[uid] = day
            policy.propose(db, None, "Follow-up", "digest", f"Morning digest to {u.full_name or u.email}", detail=" ".join(d["lines"])[:1000],
                           payload={"result": ", ".join(f"{r['channel']} {'sent' if r['ok'] else 'not sent'}" for r in res) or "no channel set up"},
                           workspace_id=bp.workspace_id)
            a = db.query(models.AgentAction).filter(models.AgentAction.workspace_id == bp.workspace_id, models.AgentAction.kind == "digest").order_by(models.AgentAction.created_at.desc()).first()
            if a is not None and a.state == "proposed":
                a.state, a.auto, a.result, a.decided_at, a.decided_by = "done", True, a.payload.get("result"), datetime.utcnow(), "Autopilot (policy)"
            sent.append({"user": u.email, "channels": res, "digest": d})
        bp.integrations = {**cur, "_digest_sent": last}
        flag_modified(bp, "integrations")
        db.commit()
    return sent
