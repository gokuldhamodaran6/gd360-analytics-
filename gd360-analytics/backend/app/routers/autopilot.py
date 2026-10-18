"""2026-10-17 (R53): Initiatives Autopilot API.

Workspace:
  GET  /autopilot/brain                     the business brain (website, audiences, sources' numbers, facts)
  POST /autopilot/brain/refresh             read everything again (optionally a new website)
  PATCH /autopilot/brain                    what the person writes (never overwritten by a refresh)
  GET  /autopilot/packs                     the 14 industry packs
  GET  /autopilot/crew                      the nine agents and what they did in 30 days
  GET  /autopilot/decisions                 everything waiting for a person, across initiatives
  GET  /autopilot/backtest                  did the 80% pace ranges hold on finished initiatives
  GET/PUT /autopilot/integrations           digest channels, conversions APIs, Teams, LinkedIn, Luma (secrets write-only)
  POST /autopilot/digest/preview            the morning digest now (send: true sends it)
One initiative (/autopilot/initiatives/{id}/...):
  GET  ""                                   contract, policy, evidence counts, decisions, last scan
  POST /run                                 scan evidence, close tasks, snapshot - now
  GET  /evidence  POST /evidence/{eid}/decide  POST /evidence/map
  PATCH /contract   GET/PUT /policy
  GET  /actions   POST /actions/{aid}/approve|dismiss|undo
  GET  /pace   POST /moves/{key}            forecast + three moves; do one
  GET  /mix                                 response curves and plan B
  GET  /proof   POST /learnings   GET /report.pdf
  POST /banner                              a banner or logo for the picture check
  POST /teams/import   POST /teams/pull   POST /linkedin/mentions
  GET  /webinar360   GET /online   GET /solo-card
Public:
  POST /public/autopilot/luma/{hook}?code=CODE    Luma webhook
"""
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import models
from ..database import get_db
from ..deps import get_current_user
from ..services.autopilot import brain, contract, crew, digest, events360, evidence, hooks, mix, pace, packs, policy, proof, rules
from ..services.autopilot import run as ap_run
from .initiatives import author, initiative_for, workspace_for

router = APIRouter(prefix="/autopilot", tags=["autopilot"])
public = APIRouter(prefix="/public/autopilot", tags=["autopilot-public"])


def _iso(d):
    return d.isoformat() + "Z" if isinstance(d, datetime) else d


# ---- workspace ------------------------------------------------------------------------------------------------

@router.get("/brain")
def get_brain(workspace_id: str | None = None, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    ws = workspace_for(db, user, workspace_id)
    return brain.out(brain.get(db, ws, refresh_if_older_h=None if db.get(models.BusinessProfile, ws) else 0))


class RefreshBody(BaseModel):
    workspace_id: str | None = None
    website: str | None = Field(default=None, max_length=300)


@router.post("/brain/refresh")
def refresh_brain(body: RefreshBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    ws = workspace_for(db, user, body.workspace_id, edit=True)
    return brain.out(brain.refresh(db, ws, website=body.website))


class BrainPatch(BaseModel):
    workspace_id: str | None = None
    website: str | None = Field(default=None, max_length=300)
    about: str | None = Field(default=None, max_length=800)
    products: list[str] | None = None
    voice: str | None = Field(default=None, max_length=200)
    industry: str | None = None


@router.patch("/brain")
def patch_brain(body: BrainPatch, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    ws = workspace_for(db, user, body.workspace_id, edit=True)
    return brain.out(brain.edit(db, ws, body.model_dump(exclude_none=True)))


@router.get("/packs")
def get_packs(user: models.User = Depends(get_current_user)):
    return {"packs": packs.catalog()}


@router.get("/crew")
def get_crew(workspace_id: str | None = None, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    ws = workspace_for(db, user, workspace_id)
    return {"crew": crew.crew(db, ws), "mcp": {"url": "/mcp", "tools": [t["name"] for t in MCP_TOOLS]}}


def _decisions(db: Session, ws: str, initiative_id: str | None = None) -> dict:
    q = db.query(models.Initiative).filter(models.Initiative.workspace_id == ws, models.Initiative.status.in_(("active", "planning")))
    if initiative_id:
        q = q.filter(models.Initiative.id == initiative_id)
    inits = {i.id: i for i in q}
    ids = list(inits)
    if not ids:
        return {"actions": [], "review": [], "approvals": [], "total": 0}
    acts = db.query(models.AgentAction).filter(models.AgentAction.initiative_id.in_(ids), models.AgentAction.state == "proposed") \
        .order_by(models.AgentAction.created_at.desc()).limit(50).all()
    rev = db.query(models.InitiativeEvidence).filter(models.InitiativeEvidence.initiative_id.in_(ids), models.InitiativeEvidence.state == "review") \
        .order_by(models.InitiativeEvidence.confidence.desc()).limit(50).all()
    appr = db.query(models.InitiativeTask).filter(models.InitiativeTask.initiative_id.in_(ids), models.InitiativeTask.status != "done").all()
    appr = [t for t in appr if (t.approval or {}).get("state") == "submitted"][:30]
    title = lambda iid: inits[iid].title if iid in inits else ""  # noqa: E731
    return {"actions": [{**policy.row(a), "initiative": title(a.initiative_id)} for a in acts],
            "review": [{**evidence.row(e), "initiative_id": e.initiative_id, "initiative": title(e.initiative_id)} for e in rev],
            "approvals": [{"task_id": t.id, "title": t.title, "initiative_id": t.initiative_id, "initiative": title(t.initiative_id),
                           "approver": (t.approval or {}).get("approver")} for t in appr],
            "total": len(acts) + len(rev) + len(appr)}


@router.get("/decisions")
def decisions(workspace_id: str | None = None, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    ws = workspace_for(db, user, workspace_id)
    return _decisions(db, ws)


@router.get("/backtest")
def backtest(workspace_id: str | None = None, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    return pace.backtest(db, workspace_for(db, user, workspace_id))


class IntegrationsBody(BaseModel):
    workspace_id: str | None = None
    values: dict


@router.get("/integrations")
def get_integrations(workspace_id: str | None = None, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    ws = workspace_for(db, user, workspace_id)
    bp = brain.get(db, ws, refresh_if_older_h=None)
    if bp not in db:
        db.add(bp)
        db.commit()
    return hooks.status(bp)


@router.put("/integrations")
def put_integrations(body: IntegrationsBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    ws = workspace_for(db, user, body.workspace_id, edit=True)
    bp = brain.get(db, ws, refresh_if_older_h=None)
    if bp not in db:
        db.add(bp)
    return hooks.save(db, bp, body.values or {})


class DigestBody(BaseModel):
    workspace_id: str | None = None
    send: bool = False


@router.post("/digest/preview")
def digest_preview(body: DigestBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    ws = workspace_for(db, user, body.workspace_id)
    d = digest.build(db, user, ws)
    if body.send:
        bp = brain.get(db, ws, refresh_if_older_h=None)
        d["sent"] = digest.send(db, bp, user, d)
    return d


# ---- one initiative -------------------------------------------------------------------------------------------

def _ini(db, user, iid, edit=False) -> models.Initiative:
    return initiative_for(db, user, iid, edit=edit)


@router.get("/initiatives/{iid}")
def one(iid: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    i = _ini(db, user, iid)
    c = contract.ensure(db, i)
    db.commit()
    counts = {}
    for e in db.query(models.InitiativeEvidence.kind, models.InitiativeEvidence.state).filter(models.InitiativeEvidence.initiative_id == i.id):
        counts.setdefault(e[0], {"accepted": 0, "review": 0, "rejected": 0})
        counts[e[0]]["accepted" if e[1] in ("auto", "confirmed") else e[1] if e[1] in ("review", "rejected") else "accepted"] += 1
    return {"contract": contract.out(c), "policy": policy.get(i), "counts": counts, "decisions": _decisions(db, i.workspace_id, i.id),
            "last_scan": (c.data or {}).get("last_scan"), "sources": (c.data or {}).get("sources") or [],
            "rules": {t.id: {"rule": t.auto_rule, "closes_on": rules.label(t.auto_rule, c.code), "completed_by": t.completed_by}
                      for t in db.query(models.InitiativeTask).filter(models.InitiativeTask.initiative_id == i.id)}}


@router.post("/initiatives/{iid}/run")
def run_now(iid: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    i = _ini(db, user, iid, edit=True)
    out = ap_run(db, i)
    out.pop("values", None)
    return out


@router.get("/initiatives/{iid}/evidence")
def list_evidence(iid: str, state: str | None = None, kind: str | None = None, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    i = _ini(db, user, iid)
    q = db.query(models.InitiativeEvidence).filter(models.InitiativeEvidence.initiative_id == i.id)
    if state == "accepted":
        q = q.filter(models.InitiativeEvidence.state.in_(("auto", "confirmed")))
    elif state:
        q = q.filter(models.InitiativeEvidence.state == state)
    if kind:
        q = q.filter(models.InitiativeEvidence.kind == kind)
    rows = q.order_by(models.InitiativeEvidence.occurred_at.desc().nullslast()).limit(300).all()
    return {"evidence": [evidence.row(e) for e in rows], "values": evidence.values(db, i)}


class Decide(BaseModel):
    decision: str = Field(pattern="^(confirm|reject)$")


@router.post("/initiatives/{iid}/evidence/{eid}/decide")
def decide(iid: str, eid: str, body: Decide, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    i = _ini(db, user, iid, edit=True)
    e = db.get(models.InitiativeEvidence, eid)
    if e is None or e.initiative_id != i.id:
        raise HTTPException(404, "Evidence not found.")
    e.state, e.decided_by = ("confirmed" if body.decision == "confirm" else "rejected"), author(user)
    db.commit()
    res = ap_run(db, i, scan=False)
    return {"evidence": evidence.row(e), "closed": res["closed"]}


class MapBody(BaseModel):
    kind: str = Field(pattern="^(ad|post)$")
    value: str = Field(min_length=2, max_length=300)


@router.post("/initiatives/{iid}/evidence/map")
def map_item(iid: str, body: MapBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    i = _ini(db, user, iid, edit=True)
    c = contract.ensure(db, i)
    m = dict(c.mapped or {})
    key = "ads" if body.kind == "ad" else "posts"
    m[key] = list(dict.fromkeys((m.get(key) or []) + [body.value.strip()]))[:100]
    c.mapped = m
    db.commit()
    out = ap_run(db, i)
    return {"contract": contract.out(c), "found": out["evidence"]}


@router.patch("/initiatives/{iid}/contract")
def patch_contract(iid: str, body: dict, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    i = _ini(db, user, iid, edit=True)
    return contract.out(contract.update(db, i, body or {}))


@router.get("/initiatives/{iid}/policy")
def get_policy(iid: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    return policy.get(_ini(db, user, iid))


@router.put("/initiatives/{iid}/policy")
def put_policy(iid: str, body: dict, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    i = _ini(db, user, iid, edit=True)
    return policy.set_policy(db, i, body or {})


@router.get("/initiatives/{iid}/actions")
def actions(iid: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    i = _ini(db, user, iid)
    rows = db.query(models.AgentAction).filter(models.AgentAction.initiative_id == i.id).order_by(models.AgentAction.created_at.desc()).limit(200).all()
    return {"actions": [policy.row(a) for a in rows]}


@router.post("/actions/{aid}/{verb}")
def act(aid: str, verb: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    a = db.get(models.AgentAction, aid)
    if a is None:
        raise HTTPException(404, "Action not found.")
    if a.initiative_id:
        _ini(db, user, a.initiative_id, edit=True)
    else:
        workspace_for(db, user, a.workspace_id, edit=True)
    if verb == "approve":
        if a.state != "proposed":
            raise HTTPException(409, "Already decided.")
        policy.do(db, a, by=author(user))
        db.commit()
    elif verb == "dismiss":
        if a.state != "proposed":
            raise HTTPException(409, "Already decided.")
        a.state, a.decided_by, a.decided_at = "dismissed", author(user), datetime.utcnow()
        db.commit()
    elif verb == "undo":
        try:
            policy.undo(db, a, by=author(user))
        except ValueError as e:
            raise HTTPException(409, str(e))
    else:
        raise HTTPException(404, "Unknown action.")
    return policy.row(a)


def _targets(db, i):
    from ..services.initiatives import metrics
    res = metrics.compute(db, i)
    return res, metrics.targets_with_actuals(i, res["values"])


@router.get("/initiatives/{iid}/pace")
def get_pace(iid: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    i = _ini(db, user, iid)
    res, t = _targets(db, i)
    fc = pace.forecast(db, i, t)
    try:
        mx = mix.model(db, i)
    except Exception:  # noqa: BLE001
        db.rollback()
        mx = None
    snaps = {}
    for r in db.query(models.InitiativeMetricDaily).filter(models.InitiativeMetricDaily.initiative_id == i.id).order_by(models.InitiativeMetricDaily.day):
        snaps.setdefault(r.key, []).append({"day": r.day, "value": r.value})
    return {"forecast": fc, "moves": pace.moves(db, i, fc, res["values"], mx), "snapshots": snaps, "share_of_time": pace._frac(i)}


@router.post("/initiatives/{iid}/moves/{key}")
def do_move(iid: str, key: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    i = _ini(db, user, iid, edit=True)
    res, t = _targets(db, i)
    fc = pace.forecast(db, i, t)
    mv = next((m for m in pace.moves(db, i, fc, res["values"], mix.model(db, i)) if m["key"] == key), None)
    if mv is None:
        raise HTTPException(404, "That move is no longer suggested.")
    payload = {"title": mv["title"], "detail": mv["detail"], "task": mv["title"], "name": mv["title"], "subject": mv["title"], "body": mv["detail"]}
    if mv["kind"] == "reminder":
        payload.update({"owner_id": i.owner_id, "note": mv["title"]})
    a = policy.propose(db, i, mv["agent"], mv["kind"], mv["title"], detail=mv["detail"], payload=payload,
                       impact=f"+{mv['lift']} {mv['helps'].replace('_', ' ')}" if mv.get("lift") else None, cost=mv.get("cost"), key=f"move:{i.id}:{key}:{datetime.utcnow().date()}")
    if a.state == "proposed":
        policy.do(db, a, by=author(user))
        db.commit()
    return policy.row(a)


@router.get("/initiatives/{iid}/mix")
def get_mix(iid: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    return mix.model(db, _ini(db, user, iid))


def _proof(db, i):
    res, t = _targets(db, i)
    ev = evidence.values(db, i)
    lf = proof.lift(db, i)
    gp = proof.geo(db, i)
    out = {"targets": t, "evidence": {k: v for k, v in ev.items()}, "lift": lf, "geo": gp, "pipeline": proof.pipeline(db, i),
           "calibration": proof.calibration(db, i) if i.kind in ("event", "webinar") else None,
           "learnings": proof.learnings_draft(db, i, t, ev, lf), "published": (i.plan_meta or {}).get("outcome"),
           "period": f"{i.starts_on or ''} to {i.key_date or 'today'}"}
    hit = sum(1 for x in t if (x.get("pct") or 0) >= 100)
    out["verdict"] = f"{hit} of {len(t)} targets reached." + (" " + lf["verdict"] if lf.get("state") == "ok" and lf.get("verdict") else "")
    return out


@router.get("/initiatives/{iid}/proof")
def get_proof(iid: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    return _proof(db, _ini(db, user, iid))


class LearnBody(BaseModel):
    text: str = Field(min_length=3, max_length=2000)


@router.post("/initiatives/{iid}/learnings")
def publish(iid: str, body: LearnBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    i = _ini(db, user, iid, edit=True)
    proof.publish_learnings(db, i, body.text)
    try:
        brain.refresh(db, i.workspace_id)  # the learnings feed the brain's history
    except Exception:  # noqa: BLE001
        db.rollback()
    return {"published": True}


@router.get("/initiatives/{iid}/report.pdf")
def report(iid: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    i = _ini(db, user, iid)
    pdf = proof.report_pdf(i, _proof(db, i))
    name = "".join(ch if ch.isalnum() or ch in " -_" else "" for ch in i.title).strip().replace(" ", "-")[:60] or "initiative"
    return Response(content=pdf, media_type="application/pdf", headers={"Content-Disposition": f'attachment; filename="{name}-proof.pdf"'})


@router.post("/initiatives/{iid}/banner")
async def banner(iid: str, file: UploadFile = File(...), db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    i = _ini(db, user, iid, edit=True)
    data = await file.read()
    if len(data) > 3_000_000 or not (file.content_type or "").startswith("image/"):
        raise HTTPException(400, "An image up to 3 MB.")
    db.add(models.EventAsset(initiative_id=i.id, kind="banner", label=file.filename, mime=file.content_type, data=data))
    db.commit()
    return {"ok": True}


@router.post("/initiatives/{iid}/teams/import")
async def teams_import(iid: str, file: UploadFile = File(...), db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    i = _ini(db, user, iid, edit=True)
    return hooks.teams_csv(db, i, await file.read())


class TeamsPull(BaseModel):
    organizer: str = Field(min_length=3, max_length=200)
    meeting_id: str = Field(min_length=3, max_length=400)


@router.post("/initiatives/{iid}/teams/pull")
def teams_pull(iid: str, body: TeamsPull, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    return hooks.teams_pull(db, _ini(db, user, iid, edit=True), body.organizer, body.meeting_id)


@router.post("/initiatives/{iid}/linkedin/mentions")
def li_mentions(iid: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    return hooks.linkedin_mentions(db, _ini(db, user, iid, edit=True))


@router.get("/initiatives/{iid}/webinar360")
def w360(iid: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    i = _ini(db, user, iid)
    if i.kind not in ("event", "webinar"):
        raise HTTPException(400, "Webinar 360 is for events and webinars.")
    return events360.webinar360(db, i)


@router.get("/initiatives/{iid}/online")
def online(iid: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    return events360.online(db, _ini(db, user, iid))


@router.get("/initiatives/{iid}/solo-card")
def solo(iid: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    return events360.solo_card(db, _ini(db, user, iid))


# ---- public: Luma webhook ---------------------------------------------------------------------------------------

@public.post("/luma/{hook}")
async def luma(hook: str, request: Request, code: str = Query(..., min_length=3, max_length=20), db: Session = Depends(get_db)):
    bp = next((b for b in db.query(models.BusinessProfile).all() if (b.integrations or {}).get("luma_hook") == hook), None)
    if bp is None:
        raise HTTPException(404, "Unknown hook.")
    c = db.query(models.InitiativeContract).join(models.Initiative, models.Initiative.id == models.InitiativeContract.initiative_id) \
        .filter(models.Initiative.workspace_id == bp.workspace_id, models.InitiativeContract.code == code.upper()).first()
    if c is None:
        raise HTTPException(404, "No initiative with that code.")
    try:
        payload = await request.json()
    except Exception:  # noqa: BLE001
        raise HTTPException(400, "JSON expected.")
    return hooks.luma_event(db, db.get(models.Initiative, c.initiative_id), payload if isinstance(payload, dict) else {})


# ---- MCP: initiatives for other agents --------------------------------------------------------------------------

MCP_TOOLS = [
    {"name": "list_initiatives", "description": "The workspace's active initiatives with health and days to go.",
     "inputSchema": {"type": "object", "properties": {"workspace_id": {"type": "string"}}}},
    {"name": "initiative_status", "description": "One initiative: targets with actuals and how true each number is, the forecast and the next moves.",
     "inputSchema": {"type": "object", "properties": {"initiative_id": {"type": "string"}}, "required": ["initiative_id"]}},
    {"name": "decisions", "description": "Everything waiting for a person: proposed actions, matches to review, approvals.",
     "inputSchema": {"type": "object", "properties": {"workspace_id": {"type": "string"}}}},
    {"name": "evidence", "description": "The evidence attached to one initiative (posts, ad spend, sessions, deals).",
     "inputSchema": {"type": "object", "properties": {"initiative_id": {"type": "string"}}, "required": ["initiative_id"]}},
]
mcp = APIRouter(tags=["mcp"])


def _mcp_call(db: Session, user: models.User, name: str, args: dict) -> dict:
    from ..services.initiatives import metrics
    if name == "list_initiatives":
        ws = workspace_for(db, user, args.get("workspace_id"))
        h = metrics.hub(db, user, ws)
        return {"initiatives": [{k: x.get(k) for k in ("id", "title", "kind", "status", "key_date", "days_to_go", "health")} for x in h["initiatives"]]}
    if name == "initiative_status":
        i = _ini(db, user, str(args.get("initiative_id") or ""))
        res, t = _targets(db, i)
        fc = pace.forecast(db, i, t)
        return {"title": i.title, "targets": [{k: x.get(k) for k in ("label", "target", "actual", "pct", "truth")} for x in t],
                "forecast": [{k: f.get(k) for k in ("label", "median", "p10", "p90", "prob")} for f in fc],
                "moves": [{k: m.get(k) for k in ("title", "helps", "lift", "alone")} for m in pace.moves(db, i, fc, res["values"], None)]}
    if name == "decisions":
        return _decisions(db, workspace_for(db, user, args.get("workspace_id")))
    if name == "evidence":
        i = _ini(db, user, str(args.get("initiative_id") or ""))
        return {"evidence": [evidence.row(e) for e in evidence.accepted(db, i).limit(100)], "values": evidence.values(db, i)}
    raise HTTPException(404, f"Unknown tool {name}.")


@mcp.post("/mcp")
async def mcp_endpoint(request: Request, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    """A Model Context Protocol server (streamable HTTP, JSON responses): other agents can read initiatives with the
    person's own GD360 token. Read-only."""
    import json as _json
    try:
        msg = await request.json()
    except Exception:  # noqa: BLE001
        return Response(status_code=400)

    def reply(mid, result=None, error=None):
        body = {"jsonrpc": "2.0", "id": mid}
        body["error" if error else "result"] = error or result
        return body
    msgs = msg if isinstance(msg, list) else [msg]
    out = []
    for m in msgs:
        mid, method, params = m.get("id"), m.get("method"), m.get("params") or {}
        if mid is None:  # a notification (e.g. notifications/initialized)
            continue
        if method == "initialize":
            out.append(reply(mid, {"protocolVersion": params.get("protocolVersion") or "2025-06-18", "capabilities": {"tools": {}},
                                   "serverInfo": {"name": "gd360-initiatives", "version": "53"}}))
        elif method == "ping":
            out.append(reply(mid, {}))
        elif method == "tools/list":
            out.append(reply(mid, {"tools": MCP_TOOLS}))
        elif method == "tools/call":
            try:
                res = _mcp_call(db, user, params.get("name"), params.get("arguments") or {})
                out.append(reply(mid, {"content": [{"type": "text", "text": _json.dumps(res, default=str)[:60000]}], "isError": False}))
            except HTTPException as e:
                out.append(reply(mid, {"content": [{"type": "text", "text": str(e.detail)}], "isError": True}))
        else:
            out.append(reply(mid, error={"code": -32601, "message": f"Method not found: {method}"}))
    if not out:
        return Response(status_code=202)
    from fastapi.responses import JSONResponse
    return JSONResponse(out if isinstance(msg, list) else out[0])
