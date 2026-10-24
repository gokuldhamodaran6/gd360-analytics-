"""
Save charts from the AI workspace onto named dashboards, list/view them
later.

Scope history:
  - v1: strictly personal - a dashboard belonged to one user (owner_id)
    with no schema-level notion of sharing, no real "list my dashboards"
    UI beyond opening a /dashboards/<id> link directly, and a bug where
    every "Save chart to dashboard" click created a brand-new dashboard
    (the frontend never actually passed dashboard_id back on a second
    save, so charts never accumulated onto one board).
  - 2026-09-23 (shared dashboards v1): a dashboard can now optionally live
    in a team workspace (Dashboard.workspace_id) instead of staying
    personal, so a team can build one curated board of recurring charts
    together instead of everyone re-saving the same numbers into their own
    private dashboard. Access follows the same view/editable split used
    everywhere else a workspace shares something (see
    services/workspace_access.py for the datasource/conversation version
    of this same rule):
      - "view" tier (any workspace member, any role, viewer included):
        see the dashboard exists, open it, see its charts.
      - "editable" tier (the dashboard's own creator, always, OR a
        workspace member whose role isn't "viewer"): rename it, add a
        chart to it, remove a chart from it.
      - Deleting is narrower still, same reasoning as conversation
        deletion: the dashboard's own creator, or that workspace's owner
        (its admin) - not just any teammate with edit rights, so one
        member can't wipe a board others spent time curating.
      - Re-sharing (changing WHICH workspace, if any, a dashboard is
        visible to - see share_dashboard below) is narrower still: only
        the dashboard's own creator, since it changes who can see the
        thing at all, not just its content.
    A personal dashboard (workspace_id stays NULL) keeps working exactly
    as it always did - owner-only, on every tier. This round also added a
    real POST /dashboards (create an empty one to start pinning into) and
    fixed save-chart to actually reuse an existing dashboard_id instead of
    silently creating a new board every time.
  - 2026-09-24 (Dashboard Builder Phase 1): a dashboard can now ALSO be
    the new pages+blocks kind (Dashboard.layout_version == 2), created by
    routers/dashboard_builder.py rather than anything in this file. This
    file's own endpoints (save-chart, add/remove SavedChart, etc.) still
    only ever operate on the original flat chart-list shape and are
    untouched by that - _dashboard_out below just also reports
    layout_version now, so Dashboards.tsx (the shared list page both kinds
    appear on) knows which viewer to open a given row in.

Every "not accessible at all" case here 404s; a workspace member who CAN
see a dashboard but lacks the tier for the specific action they tried gets
a 403 instead - same info-non-leak convention as workspaces.py and
services/workspace_access.py.
"""
import copy
import json
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user
from ..services import audit, workspace_access
from ..services.data_freshness import data_mode, is_live

router = APIRouter(prefix="/dashboards", tags=["dashboards"])

# Same "viewer is the one role without write access" set as
# services/workspace_access.py - kept local rather than imported since a
# dashboard isn't scoped to a data source at all, just to a workspace.
_EDIT_ROLES = {"owner", "admin", "member"}


def _can_view(db: Session, dash: models.Dashboard, user: models.User) -> bool:
    if dash.owner_id == user.id:
        return True
    if not dash.workspace_id:
        return False
    # 2026-10-19 (R56): a designed dashboard still in draft is its owner's until it is published
    if (dash.layout_version or 0) == 4 and (dash.board_spec or {}).get("draft"):
        return False
    return dash.workspace_id in workspace_access.member_workspace_ids(db, user.id)


def _can_edit(db: Session, dash: models.Dashboard, user: models.User) -> bool:
    if dash.owner_id == user.id:
        return True
    if not dash.workspace_id:
        return False
    return workspace_access.member_role(db, user.id, dash.workspace_id) in _EDIT_ROLES


def _can_delete(db: Session, dash: models.Dashboard, user: models.User) -> bool:
    if dash.owner_id == user.id:
        return True
    if not dash.workspace_id:
        return False
    return workspace_access.member_role(db, user.id, dash.workspace_id) in ("owner", "admin")


def _get_viewable(db: Session, user: models.User, dashboard_id: str) -> models.Dashboard:
    d = db.query(models.Dashboard).filter(models.Dashboard.id == dashboard_id).first()
    if not d or not _can_view(db, d, user):
        raise HTTPException(404, "Dashboard not found.")
    return d


def _get_editable(db: Session, user: models.User, dashboard_id: str) -> models.Dashboard:
    d = _get_viewable(db, user, dashboard_id)
    if not _can_edit(db, d, user):
        raise HTTPException(403, "You have view-only access to this dashboard.")
    return d


def _check_can_share_into(db: Session, user: models.User, workspace_id: str) -> None:
    """Raises if `user` can't share a dashboard into `workspace_id` -
    either they aren't a member of it at all (404, same info-non-leak
    reasoning as everywhere else), or they're a "viewer" there (403)."""
    role = workspace_access.member_role(db, user.id, workspace_id)
    if role is None:
        raise HTTPException(404, "Workspace not found.")
    if role not in _EDIT_ROLES:
        raise HTTPException(403, "You have view-only access to that workspace.")


def _source_ref(conv: models.Conversation | None, user: models.User, db: Session) -> dict:
    """2026-10-10: the answer/analysis a dashboard was made from, only when
    the viewer can still open it (never leaks a title they can't see)."""
    if not conv or not workspace_access.can_access_conversation(db, conv, user):
        return {}
    return {
        "source_kind": "answer" if conv.kind == "project" else "analysis",
        # a Guided Analysis opens at /g/:id - no single-source workspace link
        "source_title": conv.title, "source_id": conv.id,
        "source_datasource_id": None if conv.kind == "guided" else conv.datasource_id,
    }


def _board_extras(d: models.Dashboard, srcs: list[dict]) -> dict:
    """R50: a designed board computes live on open - its card shows its pages and its own colours."""
    from ..services.agent import board as board_svc
    spec = d.board_spec or {}
    key = spec.get("theme") or "ink"
    pal = board_svc.THEMES.get(key, board_svc.THEMES["ink"]) | ({"accent": spec["accent"]} if spec.get("accent") else {})
    built = None
    try:
        built = datetime.fromisoformat(str(spec.get("built_at") or "").replace("Z", "+00:00")).replace(tzinfo=None) if spec.get("built_at") else None
    except ValueError:
        built = None
    pages = [p.get("name") for p in spec.get("pages") or []]
    return {
        "sources": srcs, "data_mode": data_mode([s["kind"] for s in srcs]) if srcs else None, "published": False,
        "data_at": built, "updated_at": max([t for t in (d.created_at, built) if t] or [d.created_at]),
        "page_count": len(pages), "block_count": sum(len(p.get("blocks") or []) for p in spec.get("pages") or []),
        "preview": [], "refresh_interval": "off",
        "board": {"theme": key, "theme_label": board_svc.THEMES.get(key, board_svc.THEMES["ink"])["label"], "pages": pages,
                  "palette": {k: pal[k] for k in ("bg", "card", "ink", "accent", "warn", "mode")},
                  "outcome": bool(spec.get("outcome")), "entities": spec.get("entities")},
    }


def _list_extras(db: Session, dashboards: list[models.Dashboard]) -> dict[str, dict]:
    """Round 35: sources, freshness, published, last computed and a thumbnail layout for every
    dashboard in the list - a handful of set queries, not one request per card."""
    ids = [d.id for d in dashboards]
    if not ids:
        return {}
    # an older dashboard knew its source only through the chat it was made from
    via_chat = {d.source_conversation_id for d in dashboards if not d.datasource_id and d.source_conversation_id}
    chat_ds = ({cid: dsid for cid, dsid in db.query(models.Conversation.id, models.Conversation.datasource_id)
                .filter(models.Conversation.id.in_(list(via_chat))).all()} if via_chat else {})
    src_ids: dict[str, list[str]] = {}
    for d in dashboards:
        primary = d.datasource_id or chat_ds.get(d.source_conversation_id)
        sids = [primary] if primary else []
        if d.layout_version == 3:
            sids += [s for s in ((d.project_spec or {}).get("source_ids") or []) if isinstance(s, str)]
        src_ids[d.id] = list(dict.fromkeys(sids))
    all_src = {s for v in src_ids.values() for s in v}
    ds_map = ({r.id: r for r in db.query(models.DataSource.id, models.DataSource.name, models.DataSource.kind)
               .filter(models.DataSource.id.in_(list(all_src))).all()} if all_src else {})
    pages = (db.query(models.DashboardPage.id, models.DashboardPage.dashboard_id, models.DashboardPage.position,
                      models.DashboardPage.datasource_id)
             .filter(models.DashboardPage.dashboard_id.in_(ids)).all())
    # round 35b: a page on its own source counts as one of the dashboard's sources
    for _pid, did, _pos, psid in pages:
        if psid and did in src_ids and psid not in src_ids[did]:
            src_ids[did].append(psid)
    all_src = {s for v in src_ids.values() for s in v}
    ds_map = ({r.id: r for r in db.query(models.DataSource.id, models.DataSource.name, models.DataSource.kind)
               .filter(models.DataSource.id.in_(list(all_src))).all()} if all_src else {})
    pages = [(a, b, c) for a, b, c, _d in pages]
    first: dict[str, tuple] = {}
    page_count: dict[str, int] = {}
    for pid, did, pos in pages:
        page_count[did] = page_count.get(did, 0) + 1
        if did not in first or (pos or 0) < (first[did][1] or 0):
            first[did] = (pid, pos)
    page_ids = [p[0] for p in pages]
    by_page = {p[0]: p[1] for p in pages}
    first_ids = {v[0] for v in first.values()}
    preview: dict[str, list[dict]] = {}
    block_count: dict[str, int] = {}
    data_at: dict[str, datetime] = {}
    if page_ids:
        chart_kind = models.DashboardBlock.config["chart_type"].as_string()
        rows = (db.query(models.DashboardBlock.page_id, models.DashboardBlock.type, models.DashboardBlock.x,
                         models.DashboardBlock.y, models.DashboardBlock.w, models.DashboardBlock.h, chart_kind,
                         models.DashboardBlock.last_run)
                .filter(models.DashboardBlock.page_id.in_(page_ids)).all())
        for pid, btype, x, y, w, h, ck, last_run in rows:
            did = by_page.get(pid)
            block_count[did] = block_count.get(did, 0) + 1
            ran = (last_run or {}).get("ran_at") if isinstance(last_run, dict) else None
            if ran:
                try:
                    t = datetime.fromisoformat(str(ran).replace("Z", "+00:00")).replace(tzinfo=None)
                    if did not in data_at or t > data_at[did]:
                        data_at[did] = t
                except ValueError:
                    pass
            if pid in first_ids and len(preview.setdefault(did, [])) < 24:
                preview[did].append({"t": btype, "x": x or 0, "y": y or 0, "w": w or 6, "h": h or 4, "c": ck})
        snaps = (db.query(models.DashboardPageSnapshot.dashboard_id, func.max(models.DashboardPageSnapshot.computed_at))
                 .filter(models.DashboardPageSnapshot.dashboard_id.in_(ids))
                 .group_by(models.DashboardPageSnapshot.dashboard_id).all())
        for did, t in snaps:
            if t and (did not in data_at or t > data_at[did]):
                data_at[did] = t
    shares = {r.dashboard_id for r in db.query(models.DashboardShare.dashboard_id)
              .filter(models.DashboardShare.dashboard_id.in_(ids), models.DashboardShare.published_at.isnot(None)).all()}
    out: dict[str, dict] = {}
    for d in dashboards:
        srcs = [{"id": s, "name": ds_map[s].name, "kind": ds_map[s].kind, "live": is_live(ds_map[s].kind)}
                for s in src_ids[d.id] if s in ds_map]
        at = data_at.get(d.id)
        if d.layout_version == 4:
            out[d.id] = _board_extras(d, srcs)
            continue
        if d.layout_version == 3 and getattr(d, "snapshot_at", None):
            at = max(at, d.snapshot_at) if at else d.snapshot_at
        if d.layout_version == 1:
            at = None
        out[d.id] = {
            "sources": srcs, "data_mode": data_mode([s["kind"] for s in srcs]) if d.layout_version != 1 else None,
            "published": d.id in shares, "data_at": at,
            "updated_at": max([t for t in (d.created_at, at) if t] or [d.created_at]),
            "page_count": page_count.get(d.id, 0), "block_count": block_count.get(d.id, 0) if d.layout_version != 1 else len(d.charts),
            "preview": sorted(preview.get(d.id, []), key=lambda b: (b["y"], b["x"])),
            "refresh_interval": (d.refresh_interval or "off") if d.layout_version == 2 else "off",
        }
    return out


def _dashboard_out(db: Session, dash: models.Dashboard, user: models.User,
                   conv_cache: dict | None = None, extras: dict | None = None,
                   people: dict | None = None, ws_names: dict | None = None) -> schemas.DashboardOut:
    creator = people.get(dash.owner_id) if people is not None else db.query(models.User).filter(models.User.id == dash.owner_id).first()
    conv = None
    if dash.source_conversation_id:
        if conv_cache is not None and dash.source_conversation_id in conv_cache:
            conv = conv_cache[dash.source_conversation_id]
        else:
            conv = db.get(models.Conversation, dash.source_conversation_id)
    elif dash.layout_version == 3 and (dash.project_spec or {}).get("project_id"):
        conv = db.get(models.Conversation, dash.project_spec["project_id"])
    ws_name = None
    if dash.workspace_id:
        if ws_names is not None and dash.workspace_id in ws_names:
            ws_name = ws_names[dash.workspace_id]
        else:
            ws = db.query(models.Workspace).filter(models.Workspace.id == dash.workspace_id).first()
            ws_name = ws.name if ws else None
    return schemas.DashboardOut(
        id=dash.id,
        name=dash.name,
        workspace_id=dash.workspace_id,
        workspace_name=ws_name,
        created_at=dash.created_at,
        chart_count=len(dash.charts),
        is_own=dash.owner_id == user.id,
        created_by_name=creator.full_name if creator else None,
        created_by_email=creator.email if creator else None,
        can_edit=_can_edit(db, dash, user),
        can_delete=_can_delete(db, dash, user),
        layout_version=dash.layout_version or 1,
        **_source_ref(conv, user, db),
        **(extras or {}),
    )


@router.get("", response_model=list[schemas.DashboardOut])
def list_dashboards(db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    """Every dashboard this person can see - their own personal ones, plus
    any dashboard shared into a workspace they belong to (regardless of
    who created it). Includes both layout kinds (see this file's own
    docstring) - Dashboards.tsx branches on layout_version to open the
    right viewer."""
    ws_ids = workspace_access.member_workspace_ids(db, user.id)
    if ws_ids:
        dashboards = (
            db.query(models.Dashboard)
            .filter(or_(models.Dashboard.owner_id == user.id, models.Dashboard.workspace_id.in_(list(ws_ids))))
            .all()
        )
    else:
        dashboards = db.query(models.Dashboard).filter(models.Dashboard.owner_id == user.id).all()
    # R56: someone else's draft dashboard is not listed until it is published
    dashboards = [d for d in dashboards if d.owner_id == user.id or not ((d.layout_version or 0) == 4 and (d.board_spec or {}).get("draft"))]
    conv_ids = {d.source_conversation_id for d in dashboards if d.source_conversation_id}
    conv_cache = {c.id: c for c in db.query(models.Conversation).filter(models.Conversation.id.in_(list(conv_ids))).all()} if conv_ids else {}
    extras = _list_extras(db, dashboards)
    owner_ids = {d.owner_id for d in dashboards}
    people = {u.id: u for u in db.query(models.User).filter(models.User.id.in_(list(owner_ids))).all()} if owner_ids else {}
    w_ids = {d.workspace_id for d in dashboards if d.workspace_id}
    ws_names = {w.id: w.name for w in db.query(models.Workspace).filter(models.Workspace.id.in_(list(w_ids))).all()} if w_ids else {}
    out = [_dashboard_out(db, d, user, conv_cache, extras.get(d.id), people, ws_names) for d in dashboards]
    out.sort(key=lambda d: d.updated_at or d.created_at, reverse=True)
    return out


_DUP_SKIP = {"id", "created_at", "owner_id", "name", "workspace_id", "source_conversation_id", "next_refresh_at", "last_refreshed_at"}


def _unique_name(db: Session, owner_id: str, base: str) -> str:
    taken = {n for (n,) in db.query(models.Dashboard.name).filter(models.Dashboard.owner_id == owner_id).all()}
    if base not in taken:
        return base
    i = 2
    while f"{base} ({i})" in taken:
        i += 1
    return f"{base} ({i})"


@router.post("/merge", response_model=schemas.DashboardOut, status_code=201)
def merge_dashboards(payload: schemas.MergeDashboardsRequest, db: Session = Depends(get_db),
                     user: models.User = Depends(get_current_user)):
    """2026-10-12 (round 35b): "New dashboard → Merge existing dashboards". One new dashboard with
    every page of the chosen ones, in the order given - each page still reads the source it was
    built on, filters on the same column become one shared filter, the first one's look is kept.
    The originals stay unless keep_originals is false (and then only those this person may delete)."""
    from .dashboard_builder import copy_dashboard_into, _dashboard_datasource
    if len(payload.dashboard_ids) < 2:
        raise HTTPException(400, "Pick at least two dashboards to merge.")
    sources: list[models.Dashboard] = []
    for sid in dict.fromkeys(payload.dashboard_ids):
        src = db.query(models.Dashboard).filter(models.Dashboard.id == sid).first()
        if not src or not _can_view(db, src, user):
            raise HTTPException(404, "One of the dashboards to merge wasn't found.")
        if (src.layout_version or 1) != 2:
            raise HTTPException(400, f"“{src.name}” is a classic dashboard - upgrade it first, then merge.")
        sources.append(src)
    first = sources[0]
    first_ds = _dashboard_datasource(db, first)
    look = {c.name: getattr(first, c.name) for c in models.Dashboard.__table__.columns
            if c.name in ("brand_primary_color", "brand_accent_color", "background_style", "background_color", "logo_image",
                          "logo_image_content_type", "background_image", "background_image_content_type", "appearance")}
    base = (payload.name or "").strip()[:120] or f"{first.name} + {len(sources) - 1} more"
    merged = models.Dashboard(owner_id=user.id, name=_unique_name(db, user.id, base), layout_version=2,
                              datasource_id=first_ds.id if first_ds else None, parameters=[], **look)
    db.add(merged)
    db.flush()
    for src in sources:
        copy_dashboard_into(db, merged, src)
    audit.log_audit_event(db, actor=user, action="dashboard_merged", workspace_id=None, target_type="dashboard",
                          target_id=merged.id)
    if not payload.keep_originals:
        for src in sources:
            if _can_delete(db, src, user):
                db.query(models.DashboardPageSnapshot).filter(models.DashboardPageSnapshot.dashboard_id == src.id).delete(synchronize_session=False)
                db.delete(src)
    db.commit()
    db.refresh(merged)
    return _dashboard_out(db, merged, user, None, _list_extras(db, [merged]).get(merged.id))


@router.post("/{dashboard_id}/duplicate", response_model=schemas.DashboardOut, status_code=201)
def duplicate_dashboard(dashboard_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    """2026-10-12 (round 35): a full copy of a dashboard - its look, rail, saved views, pages and
    blocks - owned by the person copying it, kept in the same workspace when they can edit there.
    Never copied: its published link, comments, the run history and where it was made from."""
    src = _get_viewable(db, user, dashboard_id)
    if (src.layout_version or 1) != 2:
        raise HTTPException(400, "Only live dashboards can be duplicated. Upgrade this one first.")
    ids: dict[str, str] = {}
    import uuid
    for p in src.pages:
        ids[p.id] = str(uuid.uuid4())
        for b in p.blocks:
            ids[b.id] = str(uuid.uuid4())

    def remap(value):
        if value is None:
            return None
        text = json.dumps(value, default=str)
        for old, new in ids.items():
            if old in text:
                text = text.replace(old, new)
        return json.loads(text)

    fields = {c.name: getattr(src, c.name) for c in models.Dashboard.__table__.columns if c.name not in _DUP_SKIP}
    for k, v in list(fields.items()):
        if isinstance(v, (dict, list)):
            fields[k] = remap(copy.deepcopy(v))
    keep_ws = src.workspace_id if (src.workspace_id and _can_edit(db, src, user)) else None
    new = models.Dashboard(**fields, owner_id=user.id, workspace_id=keep_ws,
                           name=_unique_name(db, user.id, f"{src.name} copy"[:120]))
    db.add(new)
    db.flush()
    page_skip = {"id", "dashboard_id"}
    block_skip = {"id", "page_id", "last_run"}
    for p in src.pages:
        pf = {c.name: getattr(p, c.name) for c in models.DashboardPage.__table__.columns if c.name not in page_skip}
        np_ = models.DashboardPage(id=ids[p.id], dashboard_id=new.id, **pf)
        db.add(np_)
        for b in p.blocks:
            bf = {c.name: getattr(b, c.name) for c in models.DashboardBlock.__table__.columns if c.name not in block_skip}
            for k, v in list(bf.items()):
                if isinstance(v, (dict, list)):
                    bf[k] = remap(copy.deepcopy(v))
            db.add(models.DashboardBlock(id=ids[b.id], page_id=np_.id, **bf))
    db.commit()
    db.refresh(new)
    extras = _list_extras(db, [new])
    return _dashboard_out(db, new, user, None, extras.get(new.id))


@router.post("", response_model=schemas.DashboardOut, status_code=201)
def create_dashboard(
    payload: schemas.DashboardCreate, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)
):
    """Starts a brand-new, empty dashboard - charts get pinned onto it
    afterward from the AI workspace's "Save chart to dashboard" flow (see
    save_chart below). Always the original flat layout (layout_version=1,
    the model default) - a new pages+blocks dashboard is only ever created
    by routers/dashboard_builder.py's own generate endpoint."""
    if payload.workspace_id:
        _check_can_share_into(db, user, payload.workspace_id)
    dash = models.Dashboard(
        owner_id=user.id, name=payload.name.strip()[:80] or "Untitled dashboard", workspace_id=payload.workspace_id
    )
    db.add(dash)
    db.flush()
    audit.log_audit_event(
        db, actor=user, action="dashboard_created", workspace_id=dash.workspace_id,
        target_type="dashboard", target_id=dash.id,
    )
    db.commit()
    db.refresh(dash)
    return _dashboard_out(db, dash, user)


@router.get("/{dashboard_id}", response_model=schemas.DashboardDetailOut)
def get_dashboard(dashboard_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    d = _get_viewable(db, user, dashboard_id)
    base = _dashboard_out(db, d, user)
    charts = [
        schemas.SavedChartOut(id=c.id, title=c.title, chart_spec=c.chart_spec, insight=c.insight, position=c.position)
        for c in sorted(d.charts, key=lambda c: c.position)
    ]
    return schemas.DashboardDetailOut(**base.model_dump(), charts=charts)


@router.post("/{dashboard_id}/upgrade", response_model=schemas.DashboardOut)
def upgrade_chart_board(dashboard_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    """2026-10-10 (one kind of dashboard): turns a classic chart board
    (layout 1) into a full dashboard IN PLACE - same id, so every old link
    keeps working, same name, owner and sharing. Every pinned chart becomes
    a chart block on a "Pinned charts" page, in the same order, with its
    insight kept. Nothing is recomputed and nothing is lost."""
    d = _get_editable(db, user, dashboard_id)
    if (d.layout_version or 1) != 1:
        raise HTTPException(409, "This is already a full dashboard.")
    from .dashboard_builder import _layout_blocks  # local: dashboard_builder imports this module
    charts = sorted(d.charts, key=lambda c: c.position)
    page = models.DashboardPage(dashboard_id=d.id, name="Pinned charts", position=0)
    db.add(page)
    db.flush()
    items = []
    for i, c in enumerate(charts):
        config = {"chart_spec": c.chart_spec}
        if (c.insight or "").strip():
            config["ai_explanation"] = c.insight.strip()
        items.append({"type": "chart", "title": c.title or "Chart", "config": config, "position": i})
    for item in _layout_blocks([], items):
        db.add(models.DashboardBlock(
            page_id=page.id, type=item["type"], title=item["title"], x=item["x"], y=item["y"],
            w=item["w"], h=item["h"], config=item["config"], position=item["position"],
        ))
    for c in charts:
        db.delete(c)
    d.layout_version = 2
    audit.log_audit_event(
        db, actor=user, action="dashboard_upgraded", workspace_id=d.workspace_id,
        target_type="dashboard", target_id=d.id,
    )
    db.commit()
    db.refresh(d)
    return _dashboard_out(db, d, user)


@router.patch("/{dashboard_id}", response_model=schemas.DashboardOut)
def rename_dashboard(
    dashboard_id: str,
    payload: schemas.DashboardRenameRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    d = _get_editable(db, user, dashboard_id)
    d.name = payload.name.strip()[:80] or d.name
    db.commit()
    db.refresh(d)
    return _dashboard_out(db, d, user)


@router.patch("/{dashboard_id}/workspace", response_model=schemas.DashboardOut)
def share_dashboard(
    dashboard_id: str,
    payload: schemas.DashboardShareRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Shares this dashboard into a workspace (payload.workspace_id set)
    or un-shares it back to personal (payload.workspace_id omitted/None).
    Deliberately narrower than the "editable" tier used for renaming/
    adding charts - only the dashboard's own creator can change WHO can
    see it at all, same as a workspace "viewer" can't reassign a data
    source's workspace even though they can view it."""
    d = _get_viewable(db, user, dashboard_id)
    if d.owner_id != user.id:
        raise HTTPException(403, "Only the dashboard's creator can change who it's shared with.")
    if payload.workspace_id:
        _check_can_share_into(db, user, payload.workspace_id)
    before = d.workspace_id
    d.workspace_id = payload.workspace_id
    if before != d.workspace_id:
        # 2026-10-10 (round 19): who can see a dashboard is a Trust Center fact.
        audit.log_audit_event(db, actor=user, action="dashboard_moved_to_workspace",
                              workspace_id=d.workspace_id or before, target_type="dashboard", target_id=d.id,
                              metadata={"name": d.name, "shared": bool(d.workspace_id)})
    db.commit()
    db.refresh(d)
    return _dashboard_out(db, d, user)


@router.post("/save-chart")
def save_chart(
    payload: schemas.SaveChartRequest, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)
):
    if payload.dashboard_id:
        dashboard = _get_editable(db, user, payload.dashboard_id)
    else:
        if payload.workspace_id:
            _check_can_share_into(db, user, payload.workspace_id)
        dashboard = models.Dashboard(
            owner_id=user.id,
            name=(payload.dashboard_name or "My dashboard").strip()[:80] or "My dashboard",
            workspace_id=payload.workspace_id,
        )
        db.add(dashboard)
        db.commit()
        db.refresh(dashboard)

    position = len(dashboard.charts)
    chart = models.SavedChart(
        dashboard_id=dashboard.id,
        title=payload.title,
        chart_spec=payload.chart_spec,
        insight=payload.insight,
        position=position,
    )
    db.add(chart)
    db.commit()
    db.refresh(chart)
    return {"dashboard_id": dashboard.id, "dashboard_name": dashboard.name, "chart_id": chart.id}


@router.delete("/{dashboard_id}/charts/{chart_id}", status_code=204)
def remove_chart(
    dashboard_id: str,
    chart_id: str,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    d = _get_editable(db, user, dashboard_id)
    chart = (
        db.query(models.SavedChart)
        .filter(models.SavedChart.id == chart_id, models.SavedChart.dashboard_id == d.id)
        .first()
    )
    if not chart:
        raise HTTPException(404, "Chart not found on this dashboard.")
    db.delete(chart)
    db.commit()
    return None


@router.delete("/{dashboard_id}", status_code=204)
def delete_dashboard(dashboard_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    d = _get_viewable(db, user, dashboard_id)
    if not _can_delete(db, d, user):
        raise HTTPException(403, "Only the dashboard's creator or the workspace owner can delete it.")
    audit.log_audit_event(
        db, actor=user, action="dashboard_deleted", workspace_id=d.workspace_id,
        target_type="dashboard", target_id=d.id,
    )
    # R61: to the Bin (its page snapshots go when it is deleted for good - services/bin.purge)
    from ..services import bin as trash
    trash.move_to_bin(db, user, "dashboard", d)
    return None
