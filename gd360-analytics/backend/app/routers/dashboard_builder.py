"""
Dashboard Builder (2026-09-24, Phase 1 of the "real dashboard" roadmap -
see the published "Dashboard Builder Spec" artifact for the full plan).

This is deliberately a SEPARATE model and a SEPARATE set of endpoints from
routers/dashboards.py's original flat "save a chart to a named board"
feature, not a rewrite of it - every dashboard created before this round
keeps working through routers/dashboards.py exactly as it always did (see
models.Dashboard's own docstring for how layout_version tells the two
apart on the same table). This file only ever creates/reads/publishes
layout_version=2 dashboards.

What Phase 1 actually does, end to end:
  1. generate_dashboard(): takes a finished chat analysis (a Conversation)
     and turns its already-computed answers into a real, laid-out
     dashboard - one page, a handful of kpi/chart/table blocks placed on a
     12-column grid. No new data is queried; every block's numbers are
     exactly what that chat turn already computed and stored (see
     Message.chart_spec/result_columns/result_rows), so this is instant
     and never re-runs the AI's pandas code.
  2. get_builder_dashboard(): the owner/editor's read view - the actual
     drag/resize canvas editor is Phase 2; for now this is what
     DashboardBuilderView.tsx renders read-only, with a Publish button.
  3. publish_dashboard() / unpublish_dashboard(): turns a dashboard into a
     public link (see the separate, no-auth `public_router` at the bottom
     of this file, which is what a viewer with that link actually hits).
     Only "public" mode exists yet - named-email private sharing is
     Phase 3.

AI's job here is narrow and deliberately kept out of the layout math: it
only picks WHICH of the conversation's turns deserve a spot on the
dashboard and what TYPE each should be shown as (kpi/chart/table) - see
_generate_plan. The actual grid coordinates are always computed
deterministically in Python (_layout_blocks), never trusted to the model,
so a dashboard can never come back with overlapping or out-of-bounds
blocks even if the AI's response is imperfect. If the AI call fails
outright or returns something unusable, _generate_plan falls back to a
sensible deterministic plan (include every turn that has a chart or a
result, in order) rather than failing the whole feature - Gokul asked for
"100% perfection, no compromise" on this feature, and a dashboard that
always gets built beats one that occasionally errors out because a single
LLM call hiccuped.
"""
import re
import secrets
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user
from ..services import workspace_access
from ..services.ai_engine import _call_llm_resilient, _extract_json
from .dashboards import _can_edit, _can_view

router = APIRouter(prefix="/dashboard-builder", tags=["dashboard-builder"])

# Separate, unauthenticated router - a public dashboard link must be
# openable by someone who has never signed in at all, so this is never
# wired behind get_current_user. Registered separately in main.py.
public_router = APIRouter(prefix="/public/dashboards", tags=["public-dashboards"])

_MAX_TABLE_ROWS_PER_BLOCK = 200
_GRID_COLUMNS = 12


# ---------- Building the AI's block-selection plan ----------

def _build_plan_messages(conversation_title: str, entries: list[dict]) -> list[dict]:
    lines = [
        f'{i}. "{e["prompt"]}" - has_chart={e["has_chart"]}, rows={e["row_count"]}, '
        f'cols={e["col_count"]}' + (f', insight: {e["insight"]}' if e["insight"] else "")
        for i, e in enumerate(entries)
    ]
    system = (
        "You are laying out a business dashboard from a finished data-analysis chat. "
        "You are given a numbered list of question/answer turns that already have computed "
        "results - you are not computing anything new, only deciding what belongs on the "
        "dashboard and how. Rules: a turn with exactly 1 row and one clear number is best as "
        'a "kpi" tile, not a chart or table. A turn with has_chart=true is usually best as '
        '"chart". Everything else with real rows is a "table". Leave out a turn that is '
        "redundant with another you already included, or that was a minor/exploratory dead "
        "end with no real finding. Prefer 4 to 8 blocks total - too few is thin, too many is "
        "clutter. Give the whole dashboard a short, specific title (not just the chat's own "
        "title verbatim, unless it's already good). Return ONLY compact JSON, no prose, no "
        "markdown fences, in exactly this shape:\n"
        '{"dashboard_title": "short punchy title", "blocks": '
        '[{"index": 0, "type": "kpi", "title": "short block title"}, ...]}'
    )
    user = f"Conversation: {conversation_title}\n\nTurns:\n" + "\n".join(lines)
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def _fallback_plan(entries: list[dict]) -> list[dict]:
    return [
        {
            "index": i,
            "type": "chart" if e["has_chart"] else ("kpi" if e["row_count"] == 1 else "table"),
            "title": e["prompt"][:80],
        }
        for i, e in enumerate(entries)
    ]


def _generate_plan(conversation_title: str, entries: list[dict]) -> tuple[str, list[dict]]:
    fallback_title = (conversation_title or "New dashboard").strip() or "New dashboard"
    fallback_blocks = _fallback_plan(entries)
    try:
        raw = _call_llm_resilient(_build_plan_messages(conversation_title, entries), max_tokens=1200)
        parsed = _extract_json(raw)
    except Exception:
        # Transient AI hiccup, missing/invalid key, malformed JSON - any of
        # these degrade to the deterministic fallback rather than failing
        # the whole "Build with AI" action.
        return fallback_title, fallback_blocks

    title = str(parsed.get("dashboard_title") or fallback_title).strip()[:80] or fallback_title
    raw_blocks = parsed.get("blocks")
    if not isinstance(raw_blocks, list) or not raw_blocks:
        return title, fallback_blocks

    seen_indexes: set[int] = set()
    blocks: list[dict] = []
    for b in raw_blocks:
        if not isinstance(b, dict):
            continue
        idx = b.get("index")
        if not isinstance(idx, int) or idx < 0 or idx >= len(entries) or idx in seen_indexes:
            continue
        seen_indexes.add(idx)
        btype = b.get("type")
        if btype not in ("kpi", "chart", "table"):
            e = entries[idx]
            btype = "chart" if e["has_chart"] else ("kpi" if e["row_count"] == 1 else "table")
        block_title = str(b.get("title") or entries[idx]["prompt"]).strip()[:80] or entries[idx]["prompt"][:80]
        blocks.append({"index": idx, "type": btype, "title": block_title})

    return title, (blocks or fallback_blocks)


# ---------- Turning a chosen (message, type) into a block's stored config ----------

def _block_config(message: models.Message, requested_type: str) -> tuple[str, dict]:
    """Returns (actual_type, config) - actual_type can differ from
    requested_type when the requested type doesn't fit what this message
    actually has (e.g. the AI asked for "chart" on a turn with no
    chart_spec), so the block never ends up empty."""
    if requested_type == "chart" and message.chart_spec:
        return "chart", {"chart_spec": message.chart_spec}

    if requested_type == "kpi":
        cols = message.result_columns or []
        rows = message.result_rows or []
        if rows:
            measure_col = next((c.get("name") for c in cols if c.get("role") == "measure"), None)
            if measure_col is None and cols:
                measure_col = cols[0].get("name")
            if measure_col is not None:
                return "kpi", {"value": rows[0].get(measure_col), "label": measure_col}
        # No usable single value after all - fall through to table below.

    rows = (message.result_rows or [])[:_MAX_TABLE_ROWS_PER_BLOCK]
    return "table", {
        "columns": [c.get("name") for c in (message.result_columns or [])],
        "rows": rows,
        "truncated": len(message.result_rows or []) > _MAX_TABLE_ROWS_PER_BLOCK,
    }


def _layout_blocks(kpi_items: list[dict], other_items: list[dict]) -> list[dict]:
    """Deterministic 12-column grid placement - see this file's own module
    docstring for why this is never left to the AI. KPI tiles (3 columns
    wide) fill a row up to 4 across, then charts/tables (6 columns wide,
    2 across) fill the rows below."""
    laid_out = []
    x = y = 0
    for item in kpi_items:
        if x + 3 > _GRID_COLUMNS:
            x = 0
            y += 3
        laid_out.append({**item, "x": x, "y": y, "w": 3, "h": 3})
        x += 3
    if kpi_items:
        y += 3

    x = 0
    for item in other_items:
        if x + 6 > _GRID_COLUMNS:
            x = 0
            y += 6
        laid_out.append({**item, "x": x, "y": y, "w": 6, "h": 6})
        x += 6

    return laid_out


# ---------- Slugs for public links ----------

def _slugify(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
    return slug[:40] or "dashboard"


def _make_unique_slug(db: Session, name: str) -> str:
    base = _slugify(name)
    for _ in range(25):
        suffix = secrets.token_urlsafe(5).lower().replace("_", "").replace("-", "")[:6]
        candidate = f"{base}-{suffix}"
        exists = db.query(models.DashboardShare).filter(models.DashboardShare.slug == candidate).first()
        if not exists:
            return candidate
    # Astronomically unlikely to ever be reached, but never loop forever.
    return f"{base}-{secrets.token_hex(8)}"


# ---------- Access + serialization shared by the endpoints below ----------

def _get_dashboard_v2(
    db: Session, user: models.User, dashboard_id: str, require_edit: bool = False
) -> models.Dashboard:
    d = db.query(models.Dashboard).filter(models.Dashboard.id == dashboard_id).first()
    if not d or d.layout_version != 2 or not _can_view(db, d, user):
        raise HTTPException(404, "Dashboard not found.")
    if require_edit and not _can_edit(db, d, user):
        raise HTTPException(403, "You have view-only access to this dashboard.")
    return d


def _page_out(page: models.DashboardPage) -> schemas.DashboardPageOut:
    blocks = [
        schemas.DashboardBlockOut(
            id=b.id, type=b.type, title=b.title, x=b.x, y=b.y, w=b.w, h=b.h,
            config=b.config, position=b.position,
        )
        for b in sorted(page.blocks, key=lambda b: b.position)
    ]
    return schemas.DashboardPageOut(id=page.id, name=page.name, position=page.position, blocks=blocks)


def _builder_out(db: Session, d: models.Dashboard, user: models.User) -> schemas.DashboardBuilderOut:
    pages = [_page_out(p) for p in sorted(d.pages, key=lambda p: p.position)]
    share = d.share
    return schemas.DashboardBuilderOut(
        id=d.id,
        name=d.name,
        layout_version=d.layout_version,
        created_at=d.created_at,
        source_conversation_id=d.source_conversation_id,
        pages=pages,
        can_edit=_can_edit(db, d, user),
        is_published=bool(share and share.published_at),
        public_slug=share.slug if share else None,
    )


# ---------- Endpoints ----------

@router.post("/generate", response_model=schemas.DashboardBuilderOut, status_code=201)
def generate_dashboard(
    payload: schemas.GenerateDashboardRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    conv = db.query(models.Conversation).filter(models.Conversation.id == payload.conversation_id).first()
    if not conv or not workspace_access.can_access_conversation(db, conv, user):
        raise HTTPException(404, "Conversation not found.")

    messages = sorted(conv.messages, key=lambda m: m.created_at)
    entries: list[dict] = []
    entry_messages: list[models.Message] = []
    last_user_prompt: str | None = None
    for m in messages:
        if m.role == "user":
            last_user_prompt = m.content
            continue
        if m.role != "assistant" or not (m.chart_spec or m.result_rows):
            continue
        entries.append({
            "prompt": (last_user_prompt or "Analysis")[:200],
            "has_chart": bool(m.chart_spec),
            "row_count": len(m.result_rows) if m.result_rows else 0,
            "col_count": len(m.result_columns) if m.result_columns else 0,
            "insight": (m.insight or "")[:240],
        })
        entry_messages.append(m)

    if not entries:
        raise HTTPException(
            400,
            "This analysis doesn't have any charts or results yet to build a dashboard from - "
            "ask a question in the chat first, then try again.",
        )

    title, plan_blocks = _generate_plan(conv.title, entries)

    dashboard = models.Dashboard(
        owner_id=user.id,
        name=title,
        layout_version=2,
        source_conversation_id=conv.id,
    )
    db.add(dashboard)
    db.flush()

    page = models.DashboardPage(dashboard_id=dashboard.id, name="Overview", position=0)
    db.add(page)
    db.flush()

    kpi_items: list[dict] = []
    other_items: list[dict] = []
    for position, b in enumerate(plan_blocks):
        message = entry_messages[b["index"]]
        actual_type, config = _block_config(message, b["type"])
        item = {"type": actual_type, "title": b["title"], "config": config, "position": position}
        (kpi_items if actual_type == "kpi" else other_items).append(item)

    for item in _layout_blocks(kpi_items, other_items):
        db.add(models.DashboardBlock(
            page_id=page.id,
            type=item["type"],
            title=item["title"],
            x=item["x"], y=item["y"], w=item["w"], h=item["h"],
            config=item["config"],
            position=item["position"],
        ))

    db.commit()
    db.refresh(dashboard)
    return _builder_out(db, dashboard, user)


@router.get("/{dashboard_id}", response_model=schemas.DashboardBuilderOut)
def get_builder_dashboard(
    dashboard_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)
):
    d = _get_dashboard_v2(db, user, dashboard_id)
    return _builder_out(db, d, user)


@router.post("/{dashboard_id}/publish", response_model=schemas.DashboardBuilderOut)
def publish_dashboard(
    dashboard_id: str,
    payload: schemas.PublishDashboardRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    d = _get_dashboard_v2(db, user, dashboard_id, require_edit=True)
    if payload.mode != "public":
        raise HTTPException(
            400,
            "Only a public link is available right now - sharing with specific named people is "
            "coming in a later round.",
        )
    share = d.share
    if not share:
        share = models.DashboardShare(dashboard_id=d.id, slug=_make_unique_slug(db, d.name), mode="public")
        db.add(share)
    share.mode = "public"
    share.published_at = datetime.utcnow()
    db.commit()
    db.refresh(d)
    return _builder_out(db, d, user)


@router.post("/{dashboard_id}/unpublish", response_model=schemas.DashboardBuilderOut)
def unpublish_dashboard(
    dashboard_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)
):
    d = _get_dashboard_v2(db, user, dashboard_id, require_edit=True)
    if d.share:
        # The slug stays put (just goes inactive) rather than being deleted
        # - republishing later keeps the exact same link instead of
        # silently breaking anyone who'd bookmarked it.
        d.share.published_at = None
        db.commit()
    db.refresh(d)
    return _builder_out(db, d, user)


@public_router.get("/{slug}", response_model=schemas.PublicDashboardOut)
def get_public_dashboard(slug: str, db: Session = Depends(get_db)):
    """No auth at all, deliberately - this is the endpoint an anonymous
    person with the public link actually hits. Only ever returns a
    dashboard that is CURRENTLY published (mode == "public" and
    published_at set) - unpublishing takes effect immediately here, even
    though the share row/slug itself is kept around for a possible
    republish (see unpublish_dashboard above)."""
    share = db.query(models.DashboardShare).filter(models.DashboardShare.slug == slug).first()
    if not share or share.mode != "public" or not share.published_at:
        raise HTTPException(404, "This dashboard isn't available.")
    d = db.query(models.Dashboard).filter(models.Dashboard.id == share.dashboard_id).first()
    if not d:
        raise HTTPException(404, "This dashboard isn't available.")
    pages = [_page_out(p) for p in sorted(d.pages, key=lambda p: p.position)]
    return schemas.PublicDashboardOut(name=d.name, pages=pages)
