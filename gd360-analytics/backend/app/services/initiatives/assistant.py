"""
The initiative assistant: answers from everything GD360 knows about the
initiative (plan, owners, approvals, today's activity, results against
targets, tracked pages and links, campaigns) and acts on the plan when asked
- adds or moves tasks, sets reminders, logs updates with their numbers,
drafts emails, adds board cards, updates targets. It never sends anything:
emails are drafted for a person to review and send.
"""
from __future__ import annotations

import json
import logging
import re
from datetime import date, datetime, timedelta

from sqlalchemy.orm import Session

from ... import models
from .. import ai_engine
from . import catalog, connected, metrics, team, tracking

logger = logging.getLogger(__name__)
MARKER = "GD360 INITIATIVE ASSISTANT"

SYSTEM = f"""{MARKER}
You are the assistant inside one GD360 initiative. Answer the person's
message from CONTEXT only - never invent numbers; when something isn't
tracked, say so and say how to start tracking it. Be brief and specific,
professional, no emojis. Dates are YYYY-MM-DD.

Reply with ONE JSON object:
{{"reply": "your answer (short paragraphs or '- ' bullets)",
  "actions": [ ... zero or more of:
   {{"type": "add_task", "title": "...", "due_on": "YYYY-MM-DD"|null, "owner": "..."|null}},
   {{"type": "update_task", "task_id": "...", "status": "todo|doing|done|blocked"|null, "due_on": "..."|null, "owner": "..."|null}},
   {{"type": "add_reminder", "note": "...", "remind_at": "YYYY-MM-DDTHH:MM"}},
   {{"type": "log_update", "text": "what happened, with numbers"}},
   {{"type": "draft_email", "name": "...", "subject": "...", "body": "plain text; may use {{{{first_name}}}} {{{{company}}}} {{{{registration_link}}}}", "people": "registered|attended|no_shows|walk_ins"|null, "tiers": ["A","B"]|null}},
   {{"type": "set_target", "key": "metric key", "target": number}},
   {{"type": "set_actual", "key": "metric key", "actual": number}},
   {{"type": "add_item", "title": "...", "group": "..."|null, "stage": "..."|null}},
   {{"type": "ask_data", "source_id": "id from connected_data", "question": "the exact question to ask that source"}}
 ]}}
When the answer lives in a CONNECTED data source (GA4, ads, LinkedIn page,
CRM ...), say which one and add an ask_data action - the page opens Ask
anything on that source with the question filled in.
Only include actions the person asked for or clearly implied ("log that ...",
"remind me ...", "add a task ...", "draft a follow-up ..."). A message that
reports what happened ("LinkedIn post went live, 4k reach") is a log_update.
"""


def context(db: Session, i: models.Initiative, user: models.User | None = None) -> dict:
    res = metrics.compute(db, i)
    tg = metrics.targets_with_actuals(i, res["values"])
    tasks = db.query(models.InitiativeTask).filter(models.InitiativeTask.initiative_id == i.id) \
        .order_by(models.InitiativeTask.due_on).all()
    td = date.today().isoformat()
    ups = db.query(models.InitiativeUpdate).filter(models.InitiativeUpdate.initiative_id == i.id) \
        .order_by(models.InitiativeUpdate.occurred_at.desc()).limit(25).all()
    camps = db.query(models.GtmCampaign).filter(models.GtmCampaign.initiative_id == i.id).all()
    return {
        "today": td,
        "initiative": {"title": i.title, "kind": i.kind, "status": i.status, "key_date": i.key_date,
                       "location": i.location, "summary": i.summary, "budget": i.budget,
                       "audience": metrics.audience_text(i.audience) if i.audience else None},
        "targets": [{"key": t["key"], "label": t["label"], "target": t["target"], "actual": t["actual"],
                     "tracked": t["auto"]} for t in tg],
        "tasks": [{"id": t.id, "title": t.title, "status": t.status, "due_on": t.due_on, "owner": t.owner_name,
                   "overdue": bool(t.due_on and t.due_on < td and t.status != "done"),
                   "approval": (t.approval or {}).get("state"), "approver": (t.approval or {}).get("approver"),
                   "deliverables": [e.get("label") + (f" v{e['version']}" if e.get("version") else "") for e in (t.evidence or [])]}
                  for t in tasks][:60],
        "today_activity": tracking.today(db, i),
        "recent_updates": [{"at": u.occurred_at.isoformat(timespec="minutes"), "text": u.text, "numbers": u.numbers}
                           for u in ups],
        "links": [{k: l[k] for k in ("label", "kind", "variant", "clicks", "visits", "visitors", "conversions",
                                      "conversion_rate")} | {"tracking": (l.get("tracking") or {}).get("state")}
                  for l in res.get("links") or []],
        "ab_test": tracking.ab_verdict(res.get("links") or []),
        "board": dict(res.get("board") or {}),
        "campaigns": [{"name": c.name, "status": c.status} for c in camps],
        "metric_keys": list(catalog.METRICS),
        "team": [{k: m[k] for k in ("name", "role", "team")} | {"stats": m["stats"], "stale": m["stale"]}
                 for m in team.stats(db, i)["members"]],
        "connected_data": ([{"source_id": c["id"], "name": c["name"], "covers": c["covers"], "questions": c["questions"]}
                            for c in connected.for_initiative(db, user, i)] if user else []),
    }


def chat(db: Session, i: models.Initiative, user: models.User, message: str, can_act: bool = True) -> dict:
    hist = db.query(models.InitiativeMessage).filter(models.InitiativeMessage.initiative_id == i.id) \
        .order_by(models.InitiativeMessage.created_at.desc()).limit(8).all()[::-1]
    ctx = context(db, i, user)
    msgs = [{"role": "system", "content": SYSTEM},
            {"role": "user", "content": "CONTEXT:\n" + json.dumps(ctx, default=str)[:30000]}]
    for m in hist:
        msgs.append({"role": m.role, "content": m.content[:2000]})
    msgs.append({"role": "user", "content": message})
    db.add(models.InitiativeMessage(initiative_id=i.id, role="user", content=message[:4000]))
    out = None
    try:
        out = ai_engine._plan_with_retry(msgs, max_tokens=2500)
    except Exception as e:  # noqa: BLE001
        logger.warning("[initiatives] assistant fell back: %s", e)
    if not isinstance(out, dict) or not out.get("reply"):
        out = fallback(ctx, message)
    acts = out.get("actions") or []
    if not can_act:  # viewers can ask; only editors' requests change the plan
        acts = [a for a in acts if isinstance(a, dict) and a.get("type") == "ask_data"]
    done = apply(db, i, user, acts)
    reply = str(out.get("reply") or "").strip()[:6000]
    db.add(models.InitiativeMessage(initiative_id=i.id, role="assistant", content=reply, actions=done or None))
    db.commit()
    return {"reply": reply, "actions": done}


def fallback(ctx: dict, message: str) -> dict:
    """Without the AI: still log updates and summarise the day."""
    m = message.lower()
    kind, _ = tracking.classify(message)
    if kind in ("post", "approval", "milestone", "metric", "risk") and not m.strip().endswith("?"):
        return {"reply": "Logged. It's on today's timeline and any numbers are added to the results.",
                "actions": [{"type": "log_update", "text": message}]}
    t = ctx["today_activity"]
    lines = [f"Today ({t['date']}):"]
    for tile in t["tiles"]:
        lines.append(f"- {tile['label']}: {tile['value']:,.0f}")
    for u in t["updates"][:6]:
        lines.append(f"- {u['text']}")
    for a in t["approvals"]:
        lines.append(f"- {a['task']}: {a['action']} by {a['by']}")
    if len(lines) == 1:
        lines.append("- Nothing recorded yet today.")
    over = [x for x in ctx["tasks"] if x["overdue"]]
    if over:
        lines.append(f"Overdue: {', '.join(x['title'] for x in over[:4])}.")
    return {"reply": "\n".join(lines), "actions": []}


def _date(v) -> str | None:
    try:
        return date.fromisoformat(str(v)[:10]).isoformat() if v else None
    except ValueError:
        return None


def apply(db: Session, i: models.Initiative, user: models.User, actions: list) -> list[dict]:
    done: list[dict] = []
    author = user.full_name or user.email
    for a in actions[:8]:
        if not isinstance(a, dict):
            continue
        t = a.get("type")
        try:
            if t == "add_task" and a.get("title"):
                n = db.query(models.InitiativeTask).filter(models.InitiativeTask.initiative_id == i.id).count()
                task = models.InitiativeTask(initiative_id=i.id, title=str(a["title"])[:200], due_on=_date(a.get("due_on")),
                                             owner_name=(str(a.get("owner") or "")[:120] or None), origin="assistant",
                                             position=n + 1, phase_id=(i.phases or [{}])[-1].get("id"))
                db.add(task)
                db.flush()
                done.append({"type": t, "text": f"Added task “{task.title}”" + (f" due {task.due_on}" if task.due_on else ""), "id": task.id})
            elif t == "update_task" and a.get("task_id"):
                task = db.get(models.InitiativeTask, a["task_id"])
                if task and task.initiative_id == i.id:
                    if a.get("status") in ("todo", "doing", "done", "blocked"):
                        task.status = a["status"]
                        task.done_at = datetime.utcnow() if a["status"] == "done" else None
                    if _date(a.get("due_on")):
                        task.due_on = _date(a["due_on"])
                    if a.get("owner"):
                        task.owner_name = str(a["owner"])[:120]
                    done.append({"type": t, "text": f"Updated “{task.title}”", "id": task.id})
            elif t == "add_reminder" and a.get("note"):
                try:
                    at = datetime.fromisoformat(str(a.get("remind_at"))[:16])
                except ValueError:
                    at = datetime.utcnow() + timedelta(days=1)
                r = models.GtmReminder(workspace_id=i.workspace_id, owner_id=user.id, initiative_id=i.id,
                                       note=str(a["note"])[:300], remind_at=at)
                db.add(r)
                db.flush()
                done.append({"type": t, "text": f"Reminder set for {at.strftime('%-d %b, %H:%M')}: {r.note}", "id": r.id})
            elif t == "log_update" and a.get("text"):
                u = tracking.log(db, i, str(a["text"]), author)
                db.flush()
                nums = ", ".join(f"{k} {v:,.0f}" for k, v in (u.numbers or {}).items())
                done.append({"type": t, "text": "Logged update" + (f" ({nums})" if nums else ""), "id": u.id})
            elif t == "draft_email" and a.get("subject"):
                aud = {"initiative_id": i.id, "people": a["people"]} if a.get("people") else (
                    {"tiers": [x for x in (a.get("tiers") or []) if x in ("A", "B", "C")]} if a.get("tiers") else (i.audience or {}))
                c = models.GtmCampaign(workspace_id=i.workspace_id, initiative_id=i.id, owner_id=user.id,
                                       name=str(a.get("name") or a["subject"])[:120], subject=str(a["subject"])[:200],
                                       body=str(a.get("body") or "")[:20000], audience=aud, status="draft")
                db.add(c)
                db.flush()
                done.append({"type": t, "text": f"Drafted email “{c.name}” - review it on the Campaigns tab", "id": c.id})
            elif t in ("set_target", "set_actual") and a.get("key"):
                tg = list(i.targets or [])
                field = "target" if t == "set_target" else "actual"
                val = float(a.get(field))
                hit = next((x for x in tg if x.get("key") == a["key"]), None)
                if hit is None and t == "set_target":
                    m = catalog.METRICS.get(a["key"]) or {}
                    hit = {"key": a["key"], "label": catalog.metric_label(a["key"]), "unit": m.get("unit", "count"),
                           "auto": bool(m.get("auto"))}
                    tg.append(hit)
                if hit is not None:
                    hit[field] = val
                    i.targets = [dict(x) for x in tg]
                    done.append({"type": t, "text": f"{hit.get('label') or a['key']}: {field} set to {val:,.0f}"})
            elif t == "ask_data" and a.get("source_id") and a.get("question"):
                done.append({"type": t, "text": f"Ask: {str(a['question'])[:200]}", "source_id": str(a["source_id"])[:60],
                             "question": str(a["question"])[:500]})
            elif t == "add_item" and a.get("title"):
                stages = (catalog.KINDS.get(i.kind) or catalog.KINDS["custom"])["stages"]
                it = models.InitiativeItem(initiative_id=i.id, title=str(a["title"])[:200],
                                           group_name=(str(a.get("group") or "")[:60] or None),
                                           stage=a.get("stage") if a.get("stage") in stages else stages[0])
                db.add(it)
                db.flush()
                done.append({"type": t, "text": f"Added “{it.title}” to the board", "id": it.id})
        except (TypeError, ValueError) as e:
            logger.info("[initiatives] skipped action %s: %s", t, e)
    if done:
        i.updated_at = datetime.utcnow()
    return done
