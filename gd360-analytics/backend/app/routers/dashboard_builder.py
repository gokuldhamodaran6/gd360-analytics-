"""
Dashboard Builder (2026-09-24, Phase 1 + Phase 2 of the "real dashboard"
roadmap - see the published "Dashboard Builder Spec" artifact for the full
plan).

This is deliberately a SEPARATE model and a SEPARATE set of endpoints from
routers/dashboards.py's original flat "save a chart to a named board"
feature, not a rewrite of it - every dashboard created before this round
keeps working through routers/dashboards.py exactly as it always did (see
models.Dashboard's own docstring for how layout_version tells the two
apart on the same table). This file only ever creates/reads/publishes
layout_version=2 dashboards.

Phase 1 (2026-09-24): generate_dashboard() turns a finished chat analysis
into a real, laid-out dashboard in one shot (AI only picks which turns
become blocks and what TYPE each is - the grid layout is always computed
deterministically, see _layout_blocks); get_builder_dashboard() is the
read view; publish_dashboard()/unpublish_dashboard() turn it into a public
link via the separate, no-auth `public_router` at the bottom of this file.

Phase 2 (2026-09-24, the canvas - THIS round's addition): a dashboard is no
longer frozen the moment it's generated.
  - create_block()/update_block()/delete_block(): add a block, persist a
    drag/resize/title/config edit, or remove one. The frontend's canvas
    (react-grid-layout) calls update_block once per completed drag or
    resize gesture, not on every intermediate frame.
  - ask_ai_block(): fills one block in by asking a plain-English question
    against the dashboard's own data source - this reuses the EXACT SAME
    services.ai_engine.analyze() pipeline the main "Ask GD360" chat runs
    (see routers/chat.py), scoped to this dashboard's original data and
    with guided=False so it can never pause mid-answer waiting for a
    step-by-step confirmation the block editor has no UI for. This is a
    deliberate reuse, not a second implementation of the NL-to-pandas
    pipeline - it gets the exact same sandboxed execution, retry-on-
    transient-failure, and self-healing behavior the main chat already has,
    for free and with zero duplicated risk.
  - build_manual_block(): the non-AI path Gokul asked for ("create by own")
    - a plain column + aggregation form (sum/avg/count/min/max, optional
    group-by) computed directly with pandas, no AI call and no sandboxed
    code execution at all, since every operation is a fixed, whitelisted
    pandas call rather than anything AI-authored or user-authored code.
  - restyle_block(): switches a chart block to a different chart type
    using the same tidy result_columns/result_rows already stored on it
    (see _block_config/_ai_result_to_block, both of which now keep the
    tidy data alongside chart_spec for exactly this) - deterministic,
    reuses services.chart_builder.build_figure, no AI call needed to
    "just try it as a bar chart instead."

Scope note, stated plainly rather than left implicit: Phase 2 does NOT yet
include multiple pages - that's Phase 3 (multi-page + private sharing).
Phase 2 also has no automatic collision avoidance between blocks -
react-grid-layout lets a person drag one block, but two blocks CAN be
dropped on top of each other if someone does that on purpose; auto-reflow
to prevent overlaps entirely is a nice future refinement, not core to "a
working canvas."

Phase 2b (2026-09-24, cross-filtering - THIS round's addition): a "filter"
block type, and preview_filtered_blocks() below, which is what actually
makes a filter block do something. Three deliberate design decisions worth
stating plainly:

  1. A filter's current selection is PER-VIEWER and EPHEMERAL, never
     written to the database. preview_filtered_blocks() is a read-only
     POST - it recomputes and returns filtered block content but changes
     nothing in storage. This is exactly how a PowerBI/Tableau slicer
     works: two people looking at the same dashboard can have completely
     different filter selections active at the same time without
     affecting each other or the dashboard's own saved content. The
     frontend holds each viewer's current filter values in React state and
     re-POSTs on every change; a filter block's stored config only ever
     remembers WHICH COLUMN it filters (a structural, shared setting, set
     like any other block edit via update_block), never a currently-active
     value.

  2. Only a block built with "Build manually" (build_manual_block below)
     can respond to a filter - it has a stored `recipe` (metric column,
     aggregation, optional group-by, chart type) that can be safely and
     deterministically re-run against filtered data with plain pandas, no
     AI call. An AI-built block (from "Build Dashboard" or a block's own
     "Ask AI") has no recipe - there is no safe, fast way to "re-run" an
     AI's freeform, sandboxed-generated pandas code against different
     input data on every filter change without either a slow new AI call
     per keystroke or genuinely re-executing arbitrary generated code
     outside the reviewed pipeline, so those blocks are simply left alone
     when a filter changes, and the frontend says so rather than silently
     pretending they responded. build_manual_block itself also now accepts
     an optional `filters` list, so building a brand new block while a
     filter is already active produces correctly-filtered content
     immediately, not a stale unfiltered one that then jumps on the next
     filter change.

  3. Cross-filtering is deliberately NOT exposed on the public, no-login
     link this round. preview_filtered_blocks lives on the authenticated
     `router` (same access check as every other Phase 2 endpoint - view
     access to the dashboard, at minimum), not on `public_router`. The
     reason is concrete, not hypothetical: for a database/warehouse-
     connected data source, "recompute this filter" means running a live
     query against the customer's own connected credentials - allowing
     that from a public, unauthenticated link with no rate limiting would
     let any stranger with the URL trigger unbounded live queries against
     someone's production database. Enabling this safely needs its own
     rate-limiting/caching design, which is real future work, not a gap to
     paper over - the public link continues to show each block's last
     saved content, and a filter block on it renders as a plain, inert
     label rather than an interactive control that would silently do
     nothing.
"""
import re
import secrets
from datetime import datetime

import pandas as pd
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user
from ..services import ai_engine, chart_builder, workspace_access
from ..services.ai_engine import _call_llm_resilient, _extract_json
from ..services.data_loader import load_dataframe
from .dashboards import _can_edit, _can_view

router = APIRouter(prefix="/dashboard-builder", tags=["dashboard-builder"])

# Separate, unauthenticated router - a public dashboard link must be
# openable by someone who has never signed in at all, so this is never
# wired behind get_current_user. Registered separately in main.py.
public_router = APIRouter(prefix="/public/dashboards", tags=["public-dashboards"])

_MAX_TABLE_ROWS_PER_BLOCK = 200
_GRID_COLUMNS = 12

# Phase 2's manual-build form only ever offers these five - a small,
# reviewable whitelist dispatched straight to pandas' own Series.agg, never
# anything resembling AI- or user-authored code, so there is no code-
# execution surface here at all (unlike the sandboxed AI path).
_MANUAL_AGG_FUNCS = {"sum": "sum", "avg": "mean", "count": "count", "min": "min", "max": "max"}
_MANUAL_AGG_NEEDS_NUMERIC = {"sum", "avg"}
# The style panel's chart-type choices - deliberately the subset of
# chart_builder.build_figure's chart types that always work from a plain
# two-column (dimension, measure) result, so a restyle can never fail on a
# valid block just because that particular type wanted a different shape
# of data (e.g. grouped_bar needs two numeric columns, heatmap needs a
# wide matrix - neither fits what a dashboard block ever stores).
_RESTYLE_CHART_TYPES = {"bar", "line", "area", "pie", "horizontal_bar", "scatter"}
# A page can carry at most this many active filter blocks at once - plenty
# for any real dashboard, and keeps preview_filtered_blocks' per-request
# work (one boolean mask pass over the dataframe per filter) bounded.
_MAX_FILTERS_PER_REQUEST = 8


def _apply_filters(df: pd.DataFrame, filters: list) -> pd.DataFrame:
    """Applies every (column, value) filter as an AND'd exact-match mask -
    the same semantics as a PowerBI/Tableau slicer. Compares as strings
    (`.astype(str)`) rather than trying to coerce the incoming JSON value
    to the column's own dtype - simpler and more robust than dtype-
    guessing, at the cost of exact float-equality edge cases, which is a
    fine trade for a dropdown-driven exact-match filter. A filter whose
    column isn't actually in this dataframe is skipped rather than
    raising - defensive against a stale filter selection surviving a data
    source change."""
    for f in filters:
        column = f.column if hasattr(f, "column") else f.get("column")
        value = f.value if hasattr(f, "value") else f.get("value")
        if column not in df.columns:
            continue
        df = df[df[column].astype(str) == str(value)]
    return df


def _run_manual_recipe(df: pd.DataFrame, recipe: dict, existing_title: str | None = None) -> tuple[str, dict, str]:
    """The actual column + aggregation computation behind both
    build_manual_block (a fresh build) and preview_filtered_blocks (a
    re-run against filtered data) - pulled out into its own function so
    the two share exactly one implementation rather than drifting apart.
    Raises ValueError with a short, friendly message on anything the
    caller should show back as-is (bad column, wrong aggregation for a
    non-numeric column, missing group-by); any other exception is a
    genuine computation failure the caller wraps its own way. Returns
    (actual_type, config, default_title) - default_title is only used by
    the caller when the block doesn't already have one of its own.
    existing_title, when given, is what gets baked into a chart's own
    title text (matching the original build_manual_block behavior of
    preferring an already-set block title over the generated default) -
    the returned default_title is unaffected either way, since the caller
    needs the plain default for its own "no title yet" fallback."""
    metric_column = recipe.get("metric_column")
    agg = recipe.get("agg")
    group_by_column = recipe.get("group_by_column")
    block_type = recipe.get("block_type")
    chart_type = recipe.get("chart_type")

    if agg not in _MANUAL_AGG_FUNCS:
        raise ValueError("Unknown aggregation.")
    if block_type not in ("kpi", "table", "chart"):
        raise ValueError("Unknown block type.")
    if metric_column not in df.columns:
        raise ValueError(f'Column "{metric_column}" was not found in this data.')
    if agg in _MANUAL_AGG_NEEDS_NUMERIC and not pd.api.types.is_numeric_dtype(df[metric_column]):
        raise ValueError(
            f'"{metric_column}" isn\'t a numeric column, so it can\'t be summed or averaged - '
            "try Count, Min, or Max instead, or pick a numeric column."
        )
    agg_func = _MANUAL_AGG_FUNCS[agg]
    agg_label = {"sum": "Sum", "avg": "Average", "count": "Count", "min": "Min", "max": "Max"}[agg]

    if block_type == "kpi":
        value = df[metric_column].agg(agg_func)
        # pandas .agg() returns a numpy scalar (e.g. numpy.float64), not a
        # plain Python number - .item() converts it, since neither the
        # JSON DB column nor the API response can serialize a numpy type
        # directly (this would otherwise 500 on commit).
        value = value.item() if hasattr(value, "item") else value
        default_title = f"{agg_label} of {metric_column}"
        return "kpi", {"value": value, "label": default_title, "recipe": recipe}, default_title

    if not group_by_column:
        raise ValueError("Pick a column to group by for a table or chart.")
    if group_by_column not in df.columns:
        raise ValueError(f'Column "{group_by_column}" was not found in this data.')

    grouped = (
        df.groupby(group_by_column)[metric_column]
        .agg(agg_func)
        .sort_values(ascending=False)
        .head(50 if block_type == "chart" else _MAX_TABLE_ROWS_PER_BLOCK)
    )
    # Named columns, not the generic "label"/"value" that
    # chart_builder.result_to_tidy would otherwise fall back to for a bare
    # Series - so a manually-built table's headers read as "region" /
    # "revenue", not "label" / "value".
    grouped_df = grouped.reset_index()
    grouped_df.columns = [group_by_column, metric_column]
    default_title = f"{agg_label} of {metric_column} by {group_by_column}"

    if block_type == "chart":
        ct = (chart_type or "bar").lower().strip()
        if ct not in _RESTYLE_CHART_TYPES:
            ct = "bar"
        chart_spec = chart_builder.build_figure(grouped_df, ct, title=existing_title or default_title)
        tidy = chart_builder.result_to_tidy(grouped_df)
        config = {"chart_spec": chart_spec, "recipe": recipe}
        if tidy:
            config["result_columns"] = tidy["columns"]
            config["result_rows"] = tidy["rows"]
        return "chart", config, default_title

    tidy = chart_builder.result_to_tidy(grouped_df)
    config = {
        "columns": [c["name"] for c in (tidy["columns"] if tidy else [])],
        "rows": tidy["rows"] if tidy else [],
        "truncated": False,
        "recipe": recipe,
    }
    return "table", config, default_title


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
        # 2026-09-24 (Phase 2): a chart block also keeps the tidy
        # result_columns/result_rows it was built from, when this message
        # has them - not just the already-rendered chart_spec. This is
        # what lets restyle_block below switch chart type later without a
        # second AI call: it rebuilds the figure from this same tidy data
        # via chart_builder.build_figure. A message from before this
        # existed (or one with no tabular result attached) simply omits
        # these keys, and restyle_block degrades honestly for that case
        # instead of guessing.
        config = {"chart_spec": message.chart_spec}
        if message.result_columns and message.result_rows:
            config["result_columns"] = message.result_columns
            config["result_rows"] = message.result_rows
        return "chart", config

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


# ---------- Phase 2: turning one ai_engine.analyze() result into a block ----------

def _ai_result_to_block(result: dict, requested_type: str) -> tuple[str, dict]:
    """Same fallback spirit as _block_config above, generalized to a live
    ai_engine.analyze() result dict instead of a stored Message: honor
    what the person actually asked this block to be (requested_type), but
    never leave it empty just because the AI's answer doesn't perfectly
    fit that shape - fall back through chart -> kpi -> table -> a plain
    text block carrying the narrative, so a block is never left blank
    purely because of a type mismatch between what was asked for and what
    the question actually produced (e.g. asking a "chart" block "what is
    total revenue?" - a single number, not a chart - still fills the block
    in as a kpi rather than erroring)."""
    chart_spec = result.get("chart_spec")
    cols = result.get("result_columns") or []
    rows = result.get("result_rows") or []

    def _kpi_from_rows() -> tuple[str, dict] | None:
        if not rows:
            return None
        measure_col = next((c.get("name") for c in cols if c.get("role") == "measure"), None)
        if measure_col is None and cols:
            measure_col = cols[0].get("name")
        if measure_col is None:
            return None
        return "kpi", {"value": rows[0].get(measure_col), "label": measure_col}

    def _table_from_rows() -> tuple[str, dict] | None:
        if not rows:
            return None
        return "table", {
            "columns": [c.get("name") for c in cols],
            "rows": rows[:_MAX_TABLE_ROWS_PER_BLOCK],
            "truncated": len(rows) > _MAX_TABLE_ROWS_PER_BLOCK,
        }

    if requested_type == "chart" and chart_spec:
        config = {"chart_spec": chart_spec}
        if cols and rows:
            config["result_columns"] = cols
            config["result_rows"] = rows
        return "chart", config
    if requested_type == "kpi":
        kpi = _kpi_from_rows()
        if kpi:
            return kpi
    if requested_type == "table":
        table = _table_from_rows()
        if table:
            return table

    # Fallback cascade - a real chart first, then a single clear number,
    # then a table, then just the narrative as text.
    if chart_spec:
        config = {"chart_spec": chart_spec}
        if cols and rows:
            config["result_columns"] = cols
            config["result_rows"] = rows
        return "chart", config
    if rows and len(rows) == 1:
        kpi = _kpi_from_rows()
        if kpi:
            return kpi
    table = _table_from_rows()
    if table:
        return table
    return "text", {"text": result.get("narrative") or "No result."}


def _place_new_block(page: models.DashboardPage, block_type: str) -> tuple[int, int, int, int]:
    """Where a freshly-created block lands before the person drags it
    anywhere - always appended below whatever is already on the page
    (never overlapping an existing block), sized sensibly for its type.
    x/y/w/h are all in the same 12-column grid unit system as everywhere
    else in this file."""
    max_bottom = max((b.y + b.h for b in page.blocks), default=0)
    if block_type == "kpi":
        return 0, max_bottom, 3, 3
    if block_type == "text":
        return 0, max_bottom, 6, 3
    if block_type == "filter":
        return 0, max_bottom, 3, 2
    return 0, max_bottom, 6, 6  # chart / table


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


def _get_block(db: Session, dashboard: models.Dashboard, block_id: str) -> models.DashboardBlock:
    """A block scoped to THIS dashboard specifically - joined through its
    page rather than trusted from the URL alone, so a block id belonging
    to some OTHER dashboard (even one this same person owns) 404s here
    instead of being readable/editable through the wrong dashboard's
    endpoints."""
    page_ids = [p.id for p in dashboard.pages]
    block = (
        db.query(models.DashboardBlock)
        .filter(models.DashboardBlock.id == block_id, models.DashboardBlock.page_id.in_(page_ids))
        .first()
    )
    if not block:
        raise HTTPException(404, "Block not found on this dashboard.")
    return block


def _page_out(page: models.DashboardPage) -> schemas.DashboardPageOut:
    blocks = [
        schemas.DashboardBlockOut(
            id=b.id, type=b.type, title=b.title, x=b.x, y=b.y, w=b.w, h=b.h,
            config=b.config, position=b.position,
        )
        for b in sorted(page.blocks, key=lambda b: b.position)
    ]
    return schemas.DashboardPageOut(id=page.id, name=page.name, position=page.position, blocks=blocks)


def _dashboard_datasource(db: Session, d: models.Dashboard) -> models.DataSource | None:
    """The data source this dashboard's blocks are (or can be) built
    against - resolved from source_conversation_id, best-effort: returns
    None for a dashboard with no source conversation, or whose original
    conversation/datasource has since been deleted, rather than raising -
    _builder_out uses this just to REPORT the datasource (id/name) so the
    frontend knows whether Ask AI/manual-build are even offered; the
    endpoints that actually NEED it (ask_ai_block, build_manual_block) use
    the stricter _resolve_datasource below, which raises instead."""
    if not d.source_conversation_id:
        return None
    conv = db.query(models.Conversation).filter(models.Conversation.id == d.source_conversation_id).first()
    if not conv or not conv.datasource_id:
        return None
    return db.query(models.DataSource).filter(models.DataSource.id == conv.datasource_id).first()


def _resolve_datasource(db: Session, user: models.User, d: models.Dashboard) -> models.DataSource:
    """Same resolution as _dashboard_datasource, but for an endpoint that
    is about to actually RUN something against the data (ask-ai/manual-
    build) - raises a clear, friendly error instead of quietly returning
    None, and re-checks that the current user still has edit access to
    that specific data source (not just to the dashboard - a dashboard
    shared into a workspace doesn't automatically mean every editor there
    also has access to the original data source it was generated from)."""
    ds = _dashboard_datasource(db, d)
    if not ds:
        raise HTTPException(
            400,
            "This dashboard has no linked data source to build blocks from - it may have been "
            "created before this feature, or its original analysis was deleted.",
        )
    if not workspace_access.can_edit_datasource(db, ds, user):
        raise HTTPException(403, "You have view-only access to this dashboard's data source.")
    return ds


def _resolve_datasource_for_read(db: Session, user: models.User, d: models.Dashboard) -> models.DataSource | None:
    """The read-only counterpart to _resolve_datasource, for
    preview_filtered_blocks - cross-filtering doesn't change any stored
    data, so it only needs VIEW access to the data source (can_access_
    datasource, the same "viewer" tier check used everywhere else), not
    edit access. Returns None instead of raising on anything that would
    stop this from working (no linked data source, no view access, or the
    data source itself failing to load) - the caller degrades to an empty
    filtered-blocks response rather than surfacing an error for what is,
    from the viewer's perspective, just "nothing filtered."."""
    ds = _dashboard_datasource(db, d)
    if not ds or not workspace_access.can_access_datasource(db, ds, user):
        return None
    return ds


def _builder_out(db: Session, d: models.Dashboard, user: models.User) -> schemas.DashboardBuilderOut:
    pages = [_page_out(p) for p in sorted(d.pages, key=lambda p: p.position)]
    share = d.share
    ds = _dashboard_datasource(db, d)
    return schemas.DashboardBuilderOut(
        id=d.id,
        name=d.name,
        layout_version=d.layout_version,
        created_at=d.created_at,
        source_conversation_id=d.source_conversation_id,
        datasource_id=ds.id if ds else None,
        datasource_name=ds.name if ds else None,
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


@router.post("/{dashboard_id}/blocks", response_model=schemas.DashboardBuilderOut, status_code=201)
def create_block(
    dashboard_id: str,
    payload: schemas.CreateBlockRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Adds one empty block to the canvas - the "+ Add block" toolbar's
    Chart/Table/KPI/Text/Filter choice. Empty on purpose: the person fills
    it in right after, either with ask_ai_block or build_manual_block
    below (or, for a text block, a plain PATCH via update_block; a filter
    block similarly gets its target column set via update_block's config
    field, never a dedicated endpoint)."""
    d = _get_dashboard_v2(db, user, dashboard_id, require_edit=True)
    if payload.type not in ("chart", "table", "kpi", "text", "filter"):
        raise HTTPException(400, "Unknown block type.")
    page = next((p for p in d.pages if p.id == payload.page_id), None)
    if not page:
        raise HTTPException(404, "Page not found on this dashboard.")

    x, y, w, h = _place_new_block(page, payload.type)
    # A filter block's config only ever remembers WHICH COLUMN it filters -
    # a structural setting, edited the normal way through update_block's
    # `config` field, same as a text block's body. Its currently-selected
    # VALUE is never stored here at all - see this file's own module
    # docstring (Phase 2b, point 1) for why that's per-viewer/ephemeral
    # instead.
    if payload.type == "text":
        default_config = {"text": ""}
    elif payload.type == "filter":
        default_config = {"column": None}
    else:
        default_config = {}
    block = models.DashboardBlock(
        page_id=page.id,
        type=payload.type,
        title=(payload.title or "").strip()[:120] or None,
        x=x, y=y, w=w, h=h,
        config=default_config,
        position=len(page.blocks),
    )
    db.add(block)
    db.commit()
    db.refresh(d)
    return _builder_out(db, d, user)


@router.patch("/{dashboard_id}/blocks/{block_id}", response_model=schemas.DashboardBuilderOut)
def update_block(
    dashboard_id: str,
    block_id: str,
    payload: schemas.UpdateBlockRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Partial update - the canvas calls this once per completed drag
    (x/y) or resize (w/h) gesture, the title field's inline edit calls it
    with just `title`, and a text block's own body is written through
    `config` (e.g. {"text": "..."}) the same way a chart/table/kpi
    block's config is written by ask_ai_block/build_manual_block/
    restyle_block - this is the one generic setter all of those specific
    endpoints ultimately share for the position/title/config fields."""
    d = _get_dashboard_v2(db, user, dashboard_id, require_edit=True)
    block = _get_block(db, d, block_id)

    if payload.x is None and payload.y is None and payload.w is None and payload.h is None \
            and payload.title is None and payload.config is None:
        raise HTTPException(400, "Nothing to update.")

    if payload.w is not None and not (1 <= payload.w <= _GRID_COLUMNS):
        raise HTTPException(400, f"Width must be between 1 and {_GRID_COLUMNS} columns.")
    if payload.h is not None and payload.h < 1:
        raise HTTPException(400, "Height must be at least 1.")
    if payload.x is not None:
        block.x = max(0, payload.x)
    if payload.y is not None:
        block.y = max(0, payload.y)
    if payload.w is not None:
        block.w = payload.w
    if payload.h is not None:
        block.h = payload.h
    if payload.title is not None:
        block.title = payload.title.strip()[:120] or None
    if payload.config is not None:
        block.config = payload.config

    db.commit()
    db.refresh(d)
    return _builder_out(db, d, user)


@router.delete("/{dashboard_id}/blocks/{block_id}", response_model=schemas.DashboardBuilderOut)
def delete_block(
    dashboard_id: str, block_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)
):
    d = _get_dashboard_v2(db, user, dashboard_id, require_edit=True)
    block = _get_block(db, d, block_id)
    db.delete(block)
    db.commit()
    db.refresh(d)
    return _builder_out(db, d, user)


@router.post("/{dashboard_id}/blocks/{block_id}/ask-ai", response_model=schemas.DashboardBuilderOut)
def ask_ai_block(
    dashboard_id: str,
    block_id: str,
    payload: schemas.AskAiBlockRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Fills one block in by asking a plain-English question against this
    dashboard's own data source - "place a block and then have GD360
    build whatever chart/table the customer wants in it", per Gokul's own
    spec for this feature. Reuses services.ai_engine.analyze() directly -
    the exact same function the main "Ask GD360" chat calls (see
    routers/chat.py) - rather than a second NL-to-pandas implementation,
    so this gets the same sandboxed execution, transient-failure retry,
    and self-healing behavior the main chat already has, for free.

    Always runs against this data source's ORIGINAL data (never a saved/
    cleaned table, and never the specific WORKING ON selection the
    original chat conversation happened to have picked) - a dashboard
    block is a fresh question against the real data, not a continuation
    of that old chat's own table selection. guided=False so the analysis
    always completes in one call and can never come back
    paused_for_continue (there is no step-by-step confirmation UI here to
    pause into)."""
    d = _get_dashboard_v2(db, user, dashboard_id, require_edit=True)
    block = _get_block(db, d, block_id)
    ds = _resolve_datasource(db, user, d)

    try:
        original_df = load_dataframe(ds, table=None, version="original", db=db)
    except Exception as e:
        raise HTTPException(400, f"Could not load this dashboard's data: {e}")

    try:
        result = ai_engine.analyze(
            payload.prompt, {"Original data": original_df}, history=[], guided=False, skip_prep=False,
            original_df=original_df,
        )
    except Exception as e:
        print(f"[dashboard_builder] Ask AI failed: {e}")
        raise HTTPException(502, ai_engine.friendly_ai_error(e))

    if result.get("needs_clarification"):
        raise HTTPException(422, result.get("clarifying_question") or "Could you rephrase that question?")

    actual_type, config = _ai_result_to_block(result, block.type)
    block.type = actual_type
    block.config = config
    if not block.title:
        block.title = payload.prompt.strip()[:120]

    db.commit()
    db.refresh(d)
    return _builder_out(db, d, user)


@router.post("/{dashboard_id}/blocks/{block_id}/build-manual", response_model=schemas.DashboardBuilderOut)
def build_manual_block(
    dashboard_id: str,
    block_id: str,
    payload: schemas.ManualBuildBlockRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """The non-AI "create by own" path - a plain column + aggregation
    form, computed directly with pandas against this dashboard's original
    data. Every operation dispatches through the small, fixed
    _MANUAL_AGG_FUNCS whitelist rather than anything AI- or user-authored,
    so unlike ask_ai_block above, there is no sandboxed code execution
    here at all - there is no code to execute, just a parameterized
    groupby/agg call.

    The computation itself lives in _run_manual_recipe (shared with
    preview_filtered_blocks below) - this endpoint's own job is just to
    load the data, apply any filters the person currently has active on
    the page (payload.filters - optional, so building while no filter is
    active behaves exactly as before), persist the result, and store the
    RECIPE (not just the computed output) on the block. That stored
    recipe is what makes this specific block respond to a filter change
    later - see the module docstring's Phase 2b section, point 2."""
    d = _get_dashboard_v2(db, user, dashboard_id, require_edit=True)
    block = _get_block(db, d, block_id)
    ds = _resolve_datasource(db, user, d)

    try:
        df = load_dataframe(ds, table=None, version="original", db=db)
    except Exception as e:
        raise HTTPException(400, f"Could not load this dashboard's data: {e}")

    if payload.filters:
        df = _apply_filters(df, payload.filters)

    recipe = {
        "metric_column": payload.metric_column,
        "agg": payload.agg,
        "group_by_column": payload.group_by_column,
        "block_type": payload.block_type,
        "chart_type": payload.chart_type,
    }
    try:
        actual_type, config, default_title = _run_manual_recipe(df, recipe, existing_title=block.title)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(400, f"Couldn't compute that: {e}")

    block.type = actual_type
    block.config = config
    if not block.title:
        block.title = default_title

    db.commit()
    db.refresh(d)
    return _builder_out(db, d, user)


@router.patch("/{dashboard_id}/blocks/{block_id}/style", response_model=schemas.DashboardBuilderOut)
def restyle_block(
    dashboard_id: str,
    block_id: str,
    payload: schemas.RestyleBlockRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Switches a chart block to a different chart type - deterministic,
    no AI call, rebuilt from the same tidy result_columns/result_rows the
    block was originally built from (see _block_config/_ai_result_to_block/
    build_manual_block, all three of which now store that tidy data
    alongside chart_spec for exactly this). A chart block from before that
    existed (or a message with no tabular result attached) has no tidy
    data to rebuild from - this fails with a clear, honest message rather
    than guessing or silently doing nothing."""
    d = _get_dashboard_v2(db, user, dashboard_id, require_edit=True)
    block = _get_block(db, d, block_id)

    if block.type != "chart":
        raise HTTPException(400, "Only a chart block can be restyled.")
    chart_type = payload.chart_type.lower().strip()
    if chart_type not in _RESTYLE_CHART_TYPES:
        raise HTTPException(400, f"Unsupported chart type for restyling: {chart_type}.")

    cols = (block.config or {}).get("result_columns")
    rows = (block.config or {}).get("result_rows")
    if not cols or not rows:
        raise HTTPException(
            400,
            "This chart doesn't have restyle data attached yet (it was built before this option existed) - "
            "ask GD360's AI to rebuild it, or build a new chart block, to enable style options.",
        )

    title = payload.title.strip()[:120] if payload.title else block.title
    try:
        df = pd.DataFrame(rows, columns=[c["name"] for c in cols])
        new_spec = chart_builder.build_figure(df, chart_type, title=title or "")
    except Exception as e:
        raise HTTPException(400, f"Couldn't restyle to that chart type: {e}")

    block.config = {**block.config, "chart_spec": new_spec}
    if title != block.title:
        block.title = title

    db.commit()
    db.refresh(d)
    return _builder_out(db, d, user)


@router.post("/{dashboard_id}/pages/{page_id}/preview-filtered", response_model=schemas.FilteredBlocksOut)
def preview_filtered_blocks(
    dashboard_id: str,
    page_id: str,
    payload: schemas.ApplyFiltersRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Cross-filtering (Phase 2b) - READ-ONLY, changes nothing in the
    database. See this file's own module docstring for the three design
    decisions behind this endpoint (per-viewer/ephemeral, recipe-only,
    never exposed on the public link). Only view access to the dashboard
    is required (not edit) - filtering is not editing.

    Every filterable block on this page (one with a stored `recipe` - see
    build_manual_block) is recomputed against the data filtered by
    `payload.filters` and returned; every other block on the page (AI-
    built, text, the filter blocks themselves) is simply left out of the
    response, and the frontend leaves whatever it's currently showing for
    those alone. A block that fails to recompute for any reason (a filter
    happens to remove every matching row, a stale group-by column, etc.)
    is also just left out, rather than failing the whole request over one
    block - the frontend's existing content for it stays put."""
    d = _get_dashboard_v2(db, user, dashboard_id)  # view access only
    page = next((p for p in d.pages if p.id == page_id), None)
    if not page:
        raise HTTPException(404, "Page not found on this dashboard.")

    ds = _resolve_datasource_for_read(db, user, d)
    if not ds:
        return schemas.FilteredBlocksOut(blocks=[])

    try:
        df = load_dataframe(ds, table=None, version="original", db=db)
    except Exception:
        return schemas.FilteredBlocksOut(blocks=[])

    df = _apply_filters(df, payload.filters[:_MAX_FILTERS_PER_REQUEST])

    out: list[schemas.FilteredBlockOut] = []
    for block in page.blocks:
        recipe = (block.config or {}).get("recipe")
        if not recipe:
            continue
        try:
            actual_type, config, _default_title = _run_manual_recipe(df, recipe, existing_title=block.title)
        except Exception:
            continue
        out.append(schemas.FilteredBlockOut(id=block.id, type=actual_type, config=config))

    return schemas.FilteredBlocksOut(blocks=out)


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
