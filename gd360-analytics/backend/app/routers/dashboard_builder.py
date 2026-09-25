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

Phase 3 (2026-09-24, scale it - THIS round's addition): multiple pages per
dashboard, and private sharing to named people.

  - Page management: create_page/update_page/delete_page/duplicate_page.
    `position` is the only ordering the model has (see DashboardPage's own
    docstring) - every mutating page endpoint here renumbers the surviving
    pages to a contiguous 0..n-1 sequence before returning, so `position`
    never develops gaps or duplicates no matter how many creates/deletes/
    reorders/duplicates have happened. A dashboard can never be left with
    zero pages - delete_page refuses to remove the last one. duplicate_page
    deep-copies every block on the source page (new ids, identical type/
    position/config) onto a brand new page inserted immediately after the
    source, since that's where a person expects a "duplicate" to land, not
    tacked onto the end of the tab bar.

  - Private sharing: publish_dashboard now accepts mode="private" (named
    emails, optional shared password) alongside the existing "public".
    Three deliberate design decisions, matching the ones already made for
    Phase 2b:

    1. A private dashboard grants NO GD360 account to its viewers - there
       is no signup, no login, nothing added to the `users` table. Passing
       the email/password gate (verify_private_dashboard_access, on
       public_router) issues a short-lived, narrowly-scoped JWT
       (security.create_dashboard_viewer_token) that proves only "this
       browser supplied an allowed email (and the right password, if one
       is set) for THIS ONE share" - nothing more.

    2. Revoke is immediate, not "eventually, once their token expires."
       get_public_dashboard re-checks the viewer's token's email against
       DashboardShareEmail on EVERY SINGLE request, not just once at the
       door - so removing someone's email from the access list (via
       remove_share_email) takes effect on their very next page load,
       regardless of how much longer their still-technically-valid token
       would otherwise have run. The token proves the person once passed
       the gate; the live database row is what actually still grants
       access.

    3. A private link's own content-fetching endpoint is still
       unauthenticated (no GD360 login required to view it at all - that's
       the entire point of "share with people who don't have a GD360
       account"), so verify_private_dashboard_access is rate-limited per
       client IP AND per dashboard slug (the same in-process sliding-
       window limiter routers/auth.py already uses for login) to keep a
       password guess from being tried at unlimited speed. This is the
       same honest MVP-grade tradeoff the rest of this app's auth already
       makes (see routers/auth.py's own docstring) - a determined, slow,
       distributed attacker isn't fully stopped by an in-process limiter,
       but casual/scripted guessing is.

  The viewer's own access token is passed back on GET /public/dashboards/
  {slug} as a custom `X-Dashboard-Access-Token` header, deliberately NOT
  the standard `Authorization` header - the frontend's shared axios
  instance (api/client.ts) auto-attaches a real, logged-in GD360 user's
  own Authorization bearer token to every request if one exists in this
  browser (e.g. Gokul testing his own private link while logged into his
  own account in the same browser), which would silently clobber a
  viewer token passed the normal way. The public dashboard viewer
  deliberately uses its own separate, interceptor-free axios instance for
  exactly this reason - see api/client.ts's own comment on
  dashboardBuilderApi.getPublic/verifyPrivateAccess.

Phase 4 (2026-09-24, white-label - THIS round's addition): a dashboard
owner can point their OWN domain (e.g. dashboards.theircompany.com) at
their already-published dashboard, as an alternative way to reach the
exact same share (public or private) instead of this app's own /d/{slug}
link. set_custom_domain/recheck_custom_domain/remove_custom_domain below
manage it; get_public_dashboard_by_domain/verify_private_dashboard_access_
by_domain on the new `public_domains_router` are the hostname-keyed
counterparts of get_public_dashboard/verify_private_dashboard_access
above, sharing the exact same private-share gating logic via
_render_public_dashboard/_issue_viewer_token_if_allowed so the two paths
can never drift apart in what they allow.

  1. This backend does NOT do DNS verification or certificate issuance
     itself - it registers the domain with Render (services/
     render_domains.py, calling Render's own Custom Domains REST API,
     which has no tool in the Render MCP connector this session also has
     access to) and Render does both automatically from there: checking
     the CNAME record the owner was told to add, then issuing a free TLS
     certificate once that's verified. custom_domain_status on the share
     (pending_dns -> pending_ssl -> live) reflects Render's own progress,
     refreshed on demand by recheck_custom_domain (a "Check again"
     button in the owner's publish panel) - not pushed by a webhook,
     since setting one up is real additional infrastructure outside this
     round's scope.

  2. A custom domain can only be attached to an ALREADY-PUBLISHED share -
     there is no content to serve through it otherwise, and doing so
     also means _make_unique_slug has already minted the share row this
     domain attaches to.

  3. custom_domain is kept globally unique at the application level
     (checked explicitly in set_custom_domain), not via a real database
     UNIQUE constraint - see models.DashboardShare's own docstring for
     why (this column was added to an already-live table through the
     no-migration-tool _NEW_COLUMNS pattern, which can't add a new
     index/constraint, only a plain column).

  4. A custom domain reaching this app's frontend still has to call this
     backend's API cross-origin (the SPA is served from the OWNER's
     domain, e.g. https://dashboards.theircompany.com, but still talks
     to this one shared backend) - see main.py's own comment on why
     /public/* specifically gets a permissive, dynamically-reflected CORS
     policy instead of the app's normal fixed origin allow-list, which
     has no way to know a customer's domain in advance.

Round 2 (2026-09-25, the "AI Build" wizard + "build own"): two additions
to generate_dashboard()'s own entry point, BuildDashboardModal.tsx.

  1. generate_dashboard now takes an optional `goal` (schemas.
     GenerateDashboardRequest) - the one clarifying question Gokul asked
     for ("ai should ask user what we going to build from this data").
     When set, _generate_goal_plan plans a FRESH set of analysis
     questions grounded in the real data source's columns, and every one
     of them is actually run through services.ai_engine.analyze() (same
     call ask_ai_block already makes for a single block) before the
     dashboard is ever created - "build exactly whatever is needed,"
     not just a recap of whichever turns already happened to be in this
     one chat. Omitting `goal` keeps the original Phase 1 one-shot recap
     behavior exactly as it always worked, unchanged.
  2. create_blank_dashboard is the real implementation behind "Create
     your own" in BuildDashboardModal.tsx - shown but disabled since
     Phase 1 ("coming in the next round"). It needed nothing new on the
     canvas side (Phase 2's add-block/Ask AI/build-manually/style flow
     has worked per-block since it shipped) - only this one missing
     entry point: a v2 dashboard with a page and zero blocks, so the
     person builds the whole thing by hand from there.

Round 3 (2026-09-25, four new native widget types): "gauge", "donut",
"sparkline", and "avatar_list" join the original five block types
(chart/table/kpi/text/filter). All four are real, hand-built React
components (see DashboardBlocks.tsx), not a relabeled Plotly chart -
matching the reference dashboards' own radial meters, curved-legend
donuts, half-tone trend bars, and ranked leaderboard lists, which no
generic chart library shape fits.

  - "gauge": one metric read as progress toward a target on a radial arc.
    config: {value, min, max, target, label}. Built the same way "kpi" is
    (one column + aggregation), plus two OPTIONAL numbers the person can
    set - target_value and max_value (new on ManualBuildBlockRequest,
    carried straight through the stored recipe, same pattern as every
    other recipe field). Left unset, _run_manual_recipe fills in a
    sensible max (25% above the target or the value itself) and target
    (defaults to the max) - a gauge is never left un-renderable just
    because the person didn't type a target.
  - "donut": a category breakdown, same (metric, group-by) shape a
    grouped chart/table already produces - capped to the top 6 categories
    plus a rolled-up "Other" slice, since a curved-legend donut with 20
    labels around it is unreadable at any block size. config: {items:
    [{label, value}]}.
  - "sparkline": a compact trend - the SAME (metric, group-by) recipe
    shape, but deliberately NOT value-sorted like chart/table/donut are
    (pandas' own groupby key order instead, which reads as chronological
    for a date/sequence group-by column) and capped to the most recent 30
    points, since a trend's whole point is order, not rank. config:
    {value, series, categories, delta_pct} - delta_pct compares the last
    point to the first.
  - "avatar_list": a ranked top-N leaderboard from that same grouped-and-
    sorted shape "chart"/"table" already use, capped to the top 8 (a
    leaderboard longer than that stops reading as "the leaders").
    config: {items: [{rank, name, value}]}.

  Deliberately NOT wired into ask_ai_block or the goal-driven "AI Build"
  plan this round - _ai_result_to_block's fallback cascade only ever
  produces chart/kpi/table/text, and teaching the AI to reliably choose a
  believable gauge target or curate a donut's categories is real, separate
  prompt-design work, not a rename. Exactly the same scope line Phase 2b
  drew around the "filter" block type (structural, manual-only) - see this
  docstring's own Phase 2b section. All four are available from the "+ Add
  block" toolbar and "Build manually" only; they are also NOT offered in
  the chart restyle panel (restyle_block still only ever targets an
  existing "chart" block's own six chart types) - switching INTO one of
  these four is what "Build manually" with a different Type choice already
  does, reusing the exact same block-type-reassignment build_manual_block
  has always done for kpi/table/chart.

  Because preview_filtered_blocks (Phase 2b) re-runs whatever recipe a
  block has stored through this same _run_manual_recipe, cross-filtering
  works on all four new types for free, with no changes needed to
  preview_filtered_blocks itself.

Round 4 (2026-09-25, branding/customization - "complete freedom" over how a
dashboard looks, not just what's on it). Note the name: this is this
project's fourth numbered ROUND since the widget-types/AI-wizard work
started, an entirely different count from "Phase 4" above (white-label
custom domains, shipped 2026-09-24) - the two happen to share a number by
coincidence of two different people's counting, not because this is more
white-label work. See models.Dashboard's own docstring for exactly what
each new column means.

  - update_branding: PATCHes the non-image fields (brand_primary_color,
    brand_accent_color, background_style, background_color) in one call -
    every field optional and independently settable, each normalized by
    _hex_color_or_none/the background_style whitelist rather than a strict
    Pydantic type, so a bad value just doesn't get set instead of failing
    the whole request (same tradeoff PublishDashboardRequest.mode already
    makes).
  - upload_logo/upload_background (POST, multipart) and remove_logo/
    remove_background (DELETE): store/clear the raw image bytes directly on
    the Dashboard row (_read_and_validate_image whitelists image/png,
    image/jpeg, image/webp - deliberately NOT image/svg+xml, which can
    carry embedded script - and caps size at _MAX_LOGO_BYTES/
    _MAX_BACKGROUND_BYTES). get_logo/get_background (GET, owner/editor-only,
    view access) let the editor preview what's actually stored without
    re-uploading.
  - Public serving: get_public_logo/get_public_background on public_router,
    and their _by_domain counterparts on public_domains_router, mirror the
    existing three-tier id/slug/hostname access pattern Phase 3/4
    established - but deliberately DON'T thread through the private-share
    viewer-token gate _render_public_dashboard uses for real dashboard
    content. A logo or a background image is cosmetic, not data - the
    dashboard's own id is never exposed to these endpoints (they're keyed
    by slug/hostname, same as every other public endpoint), and requiring
    someone to first pass a private share's email/password gate just to
    see the company logo on the gate screen itself would be backwards. Both
    are gated only on "this share is currently published" (via
    _resolve_share_by_slug/_resolve_share_by_domain, the same as every
    other public endpoint here) - unpublishing hides them immediately, same
    as it hides everything else.
  - PublicDashboardOut/DashboardBuilderOut both gained the same branding
    fields (plus has_logo/has_background_image booleans, never the raw
    bytes) so the owner's editor, the owner's preview, and the anonymous
    public/private viewer all render with identical branding logic
    frontend-side - one hexToRgbTriple/background-style switch, reused by
    DashboardBuilderView.tsx and PublicDashboardView.tsx alike.
  - Per-page background_color (DashboardPageOut/UpdatePageRequest): a plain
    hex tint layered UNDER a page's blocks, editable from PageTabsBar's
    active-tab controls. Deliberately color-only, not a second per-page
    image upload - the "complete freedom" ask is fully met by dashboard-
    level logo/colors/background image plus a lightweight per-page
    differentiator, without doubling the upload/storage surface this round
    adds.
"""
import copy
import re
import secrets
import time
from collections import defaultdict, deque
from datetime import datetime
from typing import Any

import pandas as pd
from fastapi import APIRouter, Depends, File, Header, HTTPException, Request, Response, UploadFile, status
from sqlalchemy.orm import Session

from .. import models, schemas, security
from ..database import get_db
from ..deps import get_current_user
from ..services import ai_engine, chart_builder, render_domains, workspace_access
from ..services.ai_engine import _call_llm_resilient, _extract_json
from ..services.data_loader import load_dataframe
from .dashboards import _can_edit, _can_view

router = APIRouter(prefix="/dashboard-builder", tags=["dashboard-builder"])

# Separate, unauthenticated router - a public dashboard link must be
# openable by someone who has never signed in at all, so this is never
# wired behind get_current_user. Registered separately in main.py.
public_router = APIRouter(prefix="/public/dashboards", tags=["public-dashboards"])

# 2026-09-24 (Phase 4, white-label): the hostname-keyed counterpart of
# public_router above - a custom domain resolves through THIS router
# instead of /public/dashboards/{slug}. Kept as its own router (rather
# than a second path on public_router) so main.py's per-router CORS
# handling reads as "every /public/* router is open to any origin," a
# single clear rule, rather than something that has to special-case one
# specific path.
public_domains_router = APIRouter(prefix="/public/domains", tags=["public-domains"])

# Phase 3's private-dashboard password gate (verify_private_dashboard_access
# below) is unauthenticated by necessity, so it gets the same simple
# in-process sliding-window rate limiter routers/auth.py already uses for
# login - kept as its own copy here rather than shared/imported, matching
# that file's own stated reasoning (this file doesn't depend on, or risk
# destabilizing, the working auth rate limiter).
_call_log: dict[str, deque] = defaultdict(deque)


def _check_rate_limit(key: str, limit: int, window_seconds: int = 60):
    now = time.time()
    log = _call_log[key]
    while log and now - log[0] > window_seconds:
        log.popleft()
    if len(log) >= limit:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many attempts. Please wait a minute and try again.")
    log.append(now)


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"

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


def _safe_float(v: Any, default: float = 0.0) -> float:
    """Coerces a pandas/numpy scalar to a plain, JSON-safe Python float,
    substituting `default` for NaN/None/anything non-numeric rather than
    letting a NaN slip into a stored config (not valid JSON, and would
    500 on commit) - used by the donut/sparkline/avatar_list branches
    below, which each build several small numbers per item rather than
    the single value kpi/gauge compute."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    return f if pd.notna(f) else default


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
    needs the plain default for its own "no title yet" fallback.

    2026-09-25 (Round 3): block_type also accepts "gauge" (single-value,
    same branch as "kpi") and "donut"/"sparkline"/"avatar_list" (grouped,
    same branch as "chart"/"table") - see this file's own module
    docstring, Round 3 section, for what each one's config shape is and
    why."""
    metric_column = recipe.get("metric_column")
    agg = recipe.get("agg")
    group_by_column = recipe.get("group_by_column")
    block_type = recipe.get("block_type")
    chart_type = recipe.get("chart_type")

    if agg not in _MANUAL_AGG_FUNCS:
        raise ValueError("Unknown aggregation.")
    if block_type not in ("kpi", "table", "chart", "gauge", "donut", "sparkline", "avatar_list"):
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

    if block_type in ("kpi", "gauge"):
        value = df[metric_column].agg(agg_func)
        # pandas .agg() returns a numpy scalar (e.g. numpy.float64), not a
        # plain Python number - .item() converts it, since neither the
        # JSON DB column nor the API response can serialize a numpy type
        # directly (this would otherwise 500 on commit).
        value = value.item() if hasattr(value, "item") else value
        default_title = f"{agg_label} of {metric_column}"
        if block_type == "kpi":
            return "kpi", {"value": value, "label": default_title, "recipe": recipe}, default_title

        # "gauge" - a plain number becomes a radial "value out of max,
        # marked at target" read. target_value/max_value are both
        # optional (ManualBuildBlockRequest) - a gauge is never left
        # un-renderable just because the person didn't type either one.
        numeric_value = _safe_float(value, 0.0)
        target = recipe.get("target_value")
        resolved_target = _safe_float(target, None) if target is not None else None
        resolved_max = recipe.get("max_value")
        resolved_max = _safe_float(resolved_max, None) if resolved_max is not None else None
        if resolved_max is None:
            basis = max(abs(numeric_value), abs(resolved_target or 0))
            resolved_max = basis * 1.25 if basis > 0 else 1.0
        if resolved_target is None:
            resolved_target = resolved_max
        resolved_min = min(0.0, numeric_value, resolved_target)
        if resolved_max <= resolved_min:
            resolved_max = resolved_min + 1.0
        config = {
            "value": numeric_value, "min": resolved_min, "max": resolved_max,
            "target": resolved_target, "label": default_title, "recipe": recipe,
        }
        return "gauge", config, default_title

    if not group_by_column:
        raise ValueError("Pick a column to group by for a table, chart, donut, sparkline, or top list.")
    if group_by_column not in df.columns:
        raise ValueError(f'Column "{group_by_column}" was not found in this data.')

    if block_type == "sparkline":
        # Deliberately NOT value-sorted (unlike every other grouped branch
        # below) - a trend's whole point is order, not rank. pandas'
        # groupby default (sort=True) sorts by the group KEY itself, which
        # reads as chronological for a date/sequence group-by column.
        grouped = df.groupby(group_by_column, sort=True)[metric_column].agg(agg_func).tail(30)
        grouped_df = grouped.reset_index()
        grouped_df.columns = [group_by_column, metric_column]
        default_title = f"{agg_label} of {metric_column} by {group_by_column}"
        series = [_safe_float(v, None) if pd.notna(v) else None for v in grouped_df[metric_column].tolist()]
        clean = [v for v in series if v is not None]
        current = clean[-1] if clean else None
        first = clean[0] if clean else None
        delta_pct = ((current - first) / abs(first)) * 100 if current is not None and first not in (None, 0) else None
        config = {
            "label": default_title,
            "value": current,
            "series": series,
            "categories": [str(v) for v in grouped_df[group_by_column].tolist()],
            "delta_pct": delta_pct,
            "recipe": recipe,
        }
        return "sparkline", config, default_title

    grouped = (
        df.groupby(group_by_column)[metric_column]
        .agg(agg_func)
        .sort_values(ascending=False)
        .head(8 if block_type == "avatar_list" else (50 if block_type in ("chart", "donut") else _MAX_TABLE_ROWS_PER_BLOCK))
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

    if block_type == "donut":
        # Capped at the top 6 categories plus a rolled-up "Other" slice -
        # a curved-legend donut with 20 labels crowded around it is
        # unreadable at any block size (see this file's own module
        # docstring, Round 3 section).
        top = grouped_df.head(6)
        items = [
            {"label": str(r[group_by_column]), "value": _safe_float(r[metric_column])}
            for _, r in top.iterrows()
        ]
        if len(grouped_df) > 6:
            remainder = _safe_float(grouped_df.iloc[6:][metric_column].sum())
            if remainder > 0:
                items.append({"label": "Other", "value": remainder})
        tidy = chart_builder.result_to_tidy(grouped_df)
        config = {"items": items, "recipe": recipe}
        if tidy:
            config["result_columns"] = tidy["columns"]
            config["result_rows"] = tidy["rows"]
        return "donut", config, default_title

    if block_type == "avatar_list":
        items = [
            {"rank": i + 1, "name": str(r[group_by_column]), "value": _safe_float(r[metric_column])}
            for i, (_, r) in enumerate(grouped_df.iterrows())
        ]
        config = {"items": items, "label": default_title, "recipe": recipe}
        return "avatar_list", config, default_title

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


# ---------- Round 2 (2026-09-25), the "AI Build" wizard's goal-driven plan:
# unlike _generate_plan above (which only ever RE-ARRANGES turns that
# already exist in the chat), this plans a set of BRAND NEW questions to
# ask against the real data, grounded in a plain-English description of
# what the person wants the dashboard to show. Each planned block is a
# self-contained analysis prompt - generate_dashboard runs every one of
# them for real through services.ai_engine.analyze() (the exact same call
# ask_ai_block makes for a single block), so the result is "exactly
# whatever's needed for the dashboard they asked for," not a recap of
# whatever happened to already be in this one chat. ----------
def _build_goal_plan_messages(goal: str, conversation_title: str, column_summary: str) -> list[dict]:
    system = (
        "You are planning a business dashboard from a plain-English description of what someone "
        "wants to see, against a specific dataset. You do not compute anything yourself - for each "
        "block you plan, you write ONE precise, self-contained analysis question that a separate "
        "data-analysis AI will run against the real data to produce that block's actual numbers or "
        "chart. Ground every question in the real column names you are given below - never invent a "
        "column that is not listed, and never ask a question the given columns cannot answer. Rules: "
        "prefer 4 to 8 blocks total - too few is thin, too many is clutter. A block whose question "
        'clearly produces one headline number should be type "kpi"; a question that compares or '
        'breaks a measure down by a category or over time should be type "chart"; anything better '
        'shown as a detailed list of rows should be type "table". Give the whole dashboard a short, '
        "specific title that reflects what was asked for. Return ONLY compact JSON, no prose, no "
        "markdown fences, in exactly this shape:\n"
        '{"dashboard_title": "short punchy title", "blocks": '
        '[{"type": "kpi", "title": "short block title", "prompt": "the exact question to ask"}, ...]}'
    )
    user = (
        f"What they want this dashboard to show: {goal}\n\n"
        f"Available columns in the data: {column_summary}\n\n"
        f'(For background only, not the source of truth: this dashboard is being built from a chat '
        f'analysis titled "{conversation_title}".)'
    )
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def _fallback_goal_plan(goal: str) -> list[dict]:
    return [{"type": "table", "title": (goal[:80] or "Overview").strip(), "prompt": goal}]


def _generate_goal_plan(goal: str, conversation_title: str, column_summary: str) -> tuple[str, list[dict]]:
    fallback_title = (goal[:80] or "New dashboard").strip() or "New dashboard"
    fallback_blocks = _fallback_goal_plan(goal)
    try:
        raw = _call_llm_resilient(
            _build_goal_plan_messages(goal, conversation_title, column_summary), max_tokens=1200
        )
        parsed = _extract_json(raw)
    except Exception:
        # Transient AI hiccup, missing/invalid key, malformed JSON - degrade
        # to a single block asking the goal verbatim rather than failing
        # the whole "Build with AI" action.
        return fallback_title, fallback_blocks

    title = str(parsed.get("dashboard_title") or fallback_title).strip()[:80] or fallback_title
    raw_blocks = parsed.get("blocks")
    if not isinstance(raw_blocks, list) or not raw_blocks:
        return title, fallback_blocks

    blocks: list[dict] = []
    for b in raw_blocks[:10]:
        if not isinstance(b, dict):
            continue
        prompt = str(b.get("prompt") or "").strip()
        if not prompt:
            continue
        btype = b.get("type")
        if btype not in ("kpi", "chart", "table"):
            btype = "chart"
        block_title = str(b.get("title") or prompt).strip()[:80] or prompt[:80]
        blocks.append({"type": btype, "title": block_title, "prompt": prompt})

    return title, (blocks or fallback_blocks)


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


def _default_block_size(block_type: str) -> tuple[int, int]:
    """A freshly-placed block's sensible default (w, h) for its type - the
    sizing half of _place_new_block below, pulled out on its own
    (2026-09-25, Round 15, element library) so create_block can reuse it
    even when the CLIENT supplies where the block goes (x/y, from a drag-
    and-drop) but never how big it starts - size always stays type-driven,
    never something a dropped block's on-screen footprint at drop time
    would otherwise be free to distort."""
    if block_type == "kpi":
        return 3, 3
    if block_type in ("gauge", "sparkline"):
        return 4, 4
    if block_type == "text":
        return 6, 3
    if block_type == "filter":
        return 3, 2
    # 2026-09-25 (Round 15, element library): "heading" reads best as a
    # short full-width banner above whatever follows it; "divider" only
    # ever needs to be a thin full-width rule, the shortest a block can be.
    if block_type == "heading":
        return 12, 2
    if block_type == "divider":
        return 12, 1
    return 6, 6  # chart / table / donut / avatar_list


def _place_new_block(page: models.DashboardPage, block_type: str) -> tuple[int, int, int, int]:
    """Where a freshly-created block lands before the person drags it
    anywhere - always appended below whatever is already on the page
    (never overlapping an existing block), sized sensibly for its type.
    x/y/w/h are all in the same 12-column grid unit system as everywhere
    else in this file."""
    max_bottom = max((b.y + b.h for b in page.blocks), default=0)
    w, h = _default_block_size(block_type)
    return 0, max_bottom, w, h


def _default_block_config(block_type: str) -> dict:
    """The genuinely-empty config a freshly-placed block starts with -
    shared by create_block below and create_from_template further down,
    so a template-created block is indistinguishable from one a person
    added by hand: no value, no rows, nothing computed. Every block
    still has to be filled in for real via Ask AI / build manually / a
    plain text edit before it shows anything but its own empty state.

    2026-09-25 (Round 15, element library): "heading" stores its text the
    same way "text" does (a plain config.text string, edited the same
    way) - purely presentational content the person types themselves,
    same as a text block's own note, never a computed value. "divider"
    needs no config at all - it draws unconditionally, nothing to ever
    be "empty" about - so it falls through to the {} default below."""
    if block_type in ("text", "heading"):
        return {"text": ""}
    if block_type == "filter":
        return {"column": None}
    return {}


# ---------- Template gallery (2026-09-25, Round 5) ----------
#
# Ready-made LAYOUTS, never ready-made data. Each entry below is only
# ever a set of pages + block placements (type, placeholder title,
# x/y/w/h) - the exact same shape a person gets one block at a time from
# the "+ Add block" toolbar, just laid out for them up front. Every
# block a template creates gets _default_block_config's genuinely-empty
# config above, same as create_block - so a template-built dashboard is
# indistinguishable from a hand-built one until its owner fills each
# block in with their own real data via Ask AI or build-manually. This
# catalog never invents a number, a row or a chart.
#
# GET /templates below returns this exact structure (via
# schemas.DashboardTemplateOut) so BuildDashboardModal.tsx's gallery can
# draw an accurate preview thumbnail of each template's layout, and
# create_from_template reads this same catalog to actually build the
# dashboard - one source of truth, so the preview can never drift from
# what "Use this template" produces.
_TEMPLATES: list[dict] = [
    {
        "key": "revenue_overview",
        "name": "Revenue Overview",
        "description": "A KPI row for revenue and growth, plus trend and category charts.",
        "icon": "bar-chart",
        "pages": [
            {
                "name": "Overview",
                "blocks": [
                    {"type": "kpi", "title": "Revenue", "x": 0, "y": 0, "w": 3, "h": 3},
                    {"type": "kpi", "title": "Revenue Growth", "x": 3, "y": 0, "w": 3, "h": 3},
                    {"type": "kpi", "title": "Avg Order Value", "x": 6, "y": 0, "w": 3, "h": 3},
                    {"type": "kpi", "title": "New Customers", "x": 9, "y": 0, "w": 3, "h": 3},
                    {"type": "chart", "title": "Revenue Trend", "x": 0, "y": 3, "w": 6, "h": 6},
                    {"type": "chart", "title": "Revenue by Category", "x": 6, "y": 3, "w": 6, "h": 6},
                ],
            }
        ],
    },
    {
        "key": "sales_pipeline",
        "name": "Sales Pipeline",
        "description": "Open deals, pipeline value and win rate, next to a deal-by-deal table.",
        "icon": "target",
        "pages": [
            {
                "name": "Overview",
                "blocks": [
                    {"type": "kpi", "title": "Open Deals", "x": 0, "y": 0, "w": 3, "h": 3},
                    {"type": "kpi", "title": "Pipeline Value", "x": 3, "y": 0, "w": 3, "h": 3},
                    {"type": "kpi", "title": "Win Rate", "x": 6, "y": 0, "w": 3, "h": 3},
                    {"type": "kpi", "title": "Avg Deal Size", "x": 9, "y": 0, "w": 3, "h": 3},
                    {"type": "chart", "title": "Pipeline by Stage", "x": 0, "y": 3, "w": 6, "h": 6},
                    {"type": "table", "title": "Open Deals", "x": 6, "y": 3, "w": 6, "h": 6},
                ],
            }
        ],
    },
    {
        "key": "customer_health",
        "name": "Customer Health",
        "description": "Active customers, churn and retention, with a segment breakdown.",
        "icon": "users",
        "pages": [
            {
                "name": "Overview",
                "blocks": [
                    {"type": "kpi", "title": "Active Customers", "x": 0, "y": 0, "w": 3, "h": 3},
                    {"type": "kpi", "title": "Churn Rate", "x": 3, "y": 0, "w": 3, "h": 3},
                    {"type": "kpi", "title": "Retention Rate", "x": 6, "y": 0, "w": 3, "h": 3},
                    {"type": "kpi", "title": "Customer LTV", "x": 9, "y": 0, "w": 3, "h": 3},
                    {"type": "donut", "title": "Customers by Segment", "x": 0, "y": 3, "w": 6, "h": 6},
                    {"type": "chart", "title": "Active Customers Trend", "x": 6, "y": 3, "w": 6, "h": 6},
                ],
            }
        ],
    },
    {
        "key": "marketing_performance",
        "name": "Marketing Performance",
        "description": "Traffic, conversion and spend efficiency, with a channel table.",
        "icon": "megaphone",
        "pages": [
            {
                "name": "Overview",
                "blocks": [
                    {"type": "kpi", "title": "Website Traffic", "x": 0, "y": 0, "w": 3, "h": 3},
                    {"type": "kpi", "title": "Conversion Rate", "x": 3, "y": 0, "w": 3, "h": 3},
                    {"type": "kpi", "title": "Cost per Acquisition", "x": 6, "y": 0, "w": 3, "h": 3},
                    {"type": "kpi", "title": "Return on Ad Spend", "x": 9, "y": 0, "w": 3, "h": 3},
                    {"type": "chart", "title": "Traffic Over Time", "x": 0, "y": 3, "w": 6, "h": 6},
                    {"type": "table", "title": "Performance by Channel", "x": 6, "y": 3, "w": 6, "h": 6},
                ],
            }
        ],
    },
    {
        "key": "executive_summary",
        "name": "Executive Summary",
        "description": "A two-page leadership snapshot - headline KPIs, then room for detail and notes.",
        "icon": "briefcase",
        "pages": [
            {
                "name": "Overview",
                "blocks": [
                    {"type": "kpi", "title": "Revenue", "x": 0, "y": 0, "w": 3, "h": 3},
                    {"type": "kpi", "title": "Gross Margin", "x": 3, "y": 0, "w": 3, "h": 3},
                    {"type": "kpi", "title": "Active Customers", "x": 6, "y": 0, "w": 3, "h": 3},
                    {"type": "kpi", "title": "Net Growth", "x": 9, "y": 0, "w": 3, "h": 3},
                    {"type": "chart", "title": "Revenue Trend", "x": 0, "y": 3, "w": 6, "h": 6},
                    {"type": "table", "title": "Key Metrics by Segment", "x": 6, "y": 3, "w": 6, "h": 6},
                ],
            },
            {
                "name": "Details",
                "blocks": [
                    {"type": "text", "title": "Notes", "x": 0, "y": 0, "w": 6, "h": 3},
                    {"type": "table", "title": "Full Data", "x": 0, "y": 3, "w": 12, "h": 6},
                ],
            },
        ],
    },
]

_TEMPLATES_BY_KEY = {t["key"]: t for t in _TEMPLATES}


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


# 2026-09-24 (Phase 4): hostnames rather than slugs. This app never invents
# a custom domain the way it does a slug - the dashboard owner types in a
# domain THEY already own, so all this does is clean up what they typed
# (strip a pasted scheme/path/whitespace, lowercase) and reject the couple
# of shapes that are either meaningless here or would silently collide with
# infrastructure this whole app depends on:
#   - no dots at all ("dashboards") - not a real registrable hostname.
#   - *.onrender.com - every GD360 install already has one of these as its
#     OWN default frontend URL; letting a customer "claim" one as their
#     white-label domain would either fail confusingly against Render's API
#     or, worse, let one customer register another customer's install's
#     default hostname.
#   - localhost / 127.0.0.1 - meaningless as a public custom domain.
# Uniqueness (one custom_domain can only ever point at ONE dashboard) is
# enforced by the caller (set_custom_domain below) at the application level,
# same reasoning as slugs - see models.DashboardShare's own docstring.
def _normalize_domain(raw: str) -> str:
    domain = (raw or "").strip().lower()
    domain = re.sub(r"^https?://", "", domain)
    domain = domain.split("/")[0]
    domain = domain.split(":")[0]  # drop a pasted :port, if any
    if not domain or "." not in domain:
        raise HTTPException(400, "That doesn't look like a real domain - it needs at least one dot, e.g. dashboards.yourcompany.com.")
    if domain.endswith(".onrender.com") or domain in ("localhost", "127.0.0.1"):
        raise HTTPException(400, f'"{domain}" can\'t be used as a custom domain - it belongs to GD360\'s own infrastructure.')
    if not re.match(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$", domain):
        raise HTTPException(400, f'"{domain}" doesn\'t look like a valid domain name.')
    return domain


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
            config=b.config, position=b.position, data_updated_at=b.data_updated_at,
        )
        for b in sorted(page.blocks, key=lambda b: b.position)
    ]
    return schemas.DashboardPageOut(
        id=page.id, name=page.name, position=page.position, blocks=blocks,
        background_color=page.background_color,
    )


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
        share_mode=share.mode if share else None,
        share_has_password=bool(share and share.password_hash),
        share_emails=(
            [schemas.DashboardShareEmailOut(id=e.id, email=e.email) for e in share.allowed_emails]
            if share else []
        ),
        custom_domain=share.custom_domain if share else None,
        custom_domain_status=share.custom_domain_status if share else None,
        custom_domain_error=share.custom_domain_error if share else None,
        brand_primary_color=d.brand_primary_color,
        brand_accent_color=d.brand_accent_color,
        background_style=d.background_style,
        background_color=d.background_color,
        has_logo=bool(d.logo_image),
        has_background_image=bool(d.background_image),
    )


# ---------- Round 4 (2026-09-25) branding helpers ----------

_ALLOWED_IMAGE_CONTENT_TYPES = {"image/png", "image/jpeg", "image/webp"}
_MAX_LOGO_BYTES = 2 * 1024 * 1024  # 2MB
_MAX_BACKGROUND_BYTES = 6 * 1024 * 1024  # 6MB
_ALLOWED_BACKGROUND_STYLES = {"default", "color", "image"}


def _hex_color_or_none(raw: str | None) -> str | None:
    """Normalizes a hex color string ("#2a78d6", "2A78D6", or the 3-digit
    short form "2af") to a lowercase 6-digit "#rrggbb", or None for an
    empty/invalid value. Deliberately never raises - a bad or blank color
    just means "don't set it"/"clear it" rather than a hard error worth
    failing the whole branding save over, same tradeoff every other field
    on UpdateBrandingRequest makes."""
    if not raw:
        return None
    s = raw.strip().lstrip("#")
    if len(s) == 3 and all(c in "0123456789abcdefABCDEF" for c in s):
        s = "".join(c * 2 for c in s)
    if len(s) == 6 and all(c in "0123456789abcdefABCDEF" for c in s):
        return f"#{s.lower()}"
    return None


async def _read_and_validate_image(file: UploadFile, max_bytes: int) -> tuple[bytes, str]:
    """Shared validation for upload_logo/upload_background: whitelists the
    content type (deliberately excluding image/svg+xml, which can carry
    embedded script - the same reasoning any file-upload surface serving
    the result back as image/* needs) and caps the size before ever
    touching the database."""
    content_type = (file.content_type or "").lower()
    if content_type not in _ALLOWED_IMAGE_CONTENT_TYPES:
        raise HTTPException(400, "Please upload a PNG, JPEG, or WEBP image.")
    contents = await file.read()
    if not contents:
        raise HTTPException(400, "That file looks empty.")
    if len(contents) > max_bytes:
        raise HTTPException(400, f"That image is too large - please keep it under {max_bytes // (1024 * 1024)}MB.")
    return contents, content_type


def _image_response(image: bytes | None, content_type: str | None) -> Response:
    if not image:
        raise HTTPException(404, "No image set.")
    return Response(content=image, media_type=content_type or "image/png")


# ---------- Endpoints ----------

@router.post("/generate", response_model=schemas.DashboardBuilderOut, status_code=201)
def generate_dashboard(
    payload: schemas.GenerateDashboardRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Two modes, branching on whether payload.goal was sent:

    - goal set (Round 2, 2026-09-25 - the "AI Build" wizard): GD360 asks
      one question ("what should this dashboard show?") before building,
      then plans and runs a FRESH set of analyses against this
      conversation's real data source for exactly what was described -
      see _generate_goal_plan and the services.ai_engine.analyze() calls
      below. This can produce blocks that have nothing to do with what
      was already asked in this chat.
    - goal omitted/blank: the original Phase 1 behavior, unchanged - picks
      which of this chat's own already-computed turns become blocks and
      lays them out. Never fails just because the AI planning call had a
      transient problem (see _generate_plan's own fallback).
    """
    conv = db.query(models.Conversation).filter(models.Conversation.id == payload.conversation_id).first()
    if not conv or not workspace_access.can_access_conversation(db, conv, user):
        raise HTTPException(404, "Conversation not found.")

    goal = (payload.goal or "").strip()
    if goal:
        # Same probe-object reuse _resolve_datasource is already built
        # for: it only ever reads d.source_conversation_id off whatever's
        # passed in, so a transient, never-added-to-the-session Dashboard
        # resolves the real data source without persisting anything yet -
        # every fallible step below (loading the data, the planning call,
        # every per-block analyze() call) happens BEFORE any row is
        # created, same zero-partial-write discipline as the plain path.
        ds = _resolve_datasource(db, user, models.Dashboard(source_conversation_id=conv.id))
        try:
            original_df = load_dataframe(ds, table=None, version="original", db=db)
        except Exception as e:
            raise HTTPException(400, f"Could not load this data source: {e}")

        column_summary = ", ".join(f"{c} ({original_df[c].dtype})" for c in list(original_df.columns)[:60])
        title, block_specs = _generate_goal_plan(goal, conv.title, column_summary)

        kpi_items: list[dict] = []
        other_items: list[dict] = []
        for position, spec in enumerate(block_specs):
            try:
                result = ai_engine.analyze(
                    spec["prompt"], {"Original data": original_df}, history=[], guided=False,
                    skip_prep=False, original_df=original_df,
                )
            except Exception as e:
                print(f"[dashboard_builder] goal-driven block build failed for {spec['prompt']!r}: {e}")
                continue
            if result.get("needs_clarification"):
                continue
            actual_type, config = _ai_result_to_block(result, spec["type"])
            item = {"type": actual_type, "title": spec["title"], "config": config, "position": position}
            (kpi_items if actual_type == "kpi" else other_items).append(item)

        if not kpi_items and not other_items:
            raise HTTPException(
                400,
                "GD360 couldn't build anything from that description - try naming which numbers or "
                "breakdowns matter most (e.g. \"revenue by region this quarter, and our top 5 "
                "customers\"), then try again.",
            )

        dashboard = models.Dashboard(owner_id=user.id, name=title, layout_version=2, source_conversation_id=conv.id)
        db.add(dashboard)
        db.flush()
        page = models.DashboardPage(dashboard_id=dashboard.id, name="Overview", position=0)
        db.add(page)
        db.flush()
        for item in _layout_blocks(kpi_items, other_items):
            db.add(models.DashboardBlock(
                page_id=page.id,
                type=item["type"], title=item["title"],
                x=item["x"], y=item["y"], w=item["w"], h=item["h"],
                config=item["config"], position=item["position"],
            ))
        db.commit()
        db.refresh(dashboard)
        return _builder_out(db, dashboard, user)

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


# 2026-09-25 (Round 2, "build own"): the "Create your own" tile in
# BuildDashboardModal.tsx has shown this choice since Phase 1 but was
# disabled the whole time ("coming in the next round") - the Phase 2
# canvas it needed (add/fill/edit a block by hand) has been live since
# then, it just had no way to START a dashboard with zero blocks. This is
# that entry point: a real v2 dashboard + one empty page, nothing more.
# Everything after that - adding blocks, Ask AI per block, build
# manually, style, publish - is the exact same canvas every other v2
# dashboard already uses.
@router.post("/create-blank", response_model=schemas.DashboardBuilderOut, status_code=201)
def create_blank_dashboard(
    payload: schemas.CreateBlankDashboardRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    conv = db.query(models.Conversation).filter(models.Conversation.id == payload.conversation_id).first()
    if not conv or not workspace_access.can_access_conversation(db, conv, user):
        raise HTTPException(404, "Conversation not found.")

    dashboard = models.Dashboard(
        owner_id=user.id,
        name="Untitled dashboard",
        layout_version=2,
        source_conversation_id=conv.id,
    )
    db.add(dashboard)
    db.flush()
    page = models.DashboardPage(dashboard_id=dashboard.id, name="Overview", position=0)
    db.add(page)
    db.commit()
    db.refresh(dashboard)
    return _builder_out(db, dashboard, user)


# 2026-09-25 (Round 5, template gallery): the read side of the gallery -
# BuildDashboardModal.tsx's "Start from a template" step calls this to
# draw its cards and preview thumbnails straight from _TEMPLATES above.
# Login-gated like every other endpoint in this file, but not scoped to
# any one dashboard/workspace - the catalog is the same for everyone, so
# there's nothing here to authorize beyond "is signed in". Declared
# ahead of GET /{dashboard_id} below on purpose: FastAPI matches routes
# in declaration order, and "/templates" would otherwise be swallowed by
# "/{dashboard_id}" (dashboard_id="templates") if it came after.
@router.get("/templates", response_model=list[schemas.DashboardTemplateOut])
def list_templates(user: models.User = Depends(get_current_user)):
    return _TEMPLATES


# 2026-09-25 (Round 5, template gallery): the third choice in
# BuildDashboardModal.tsx, alongside "Build with AI" (generate_dashboard)
# and "Create your own" (create_blank_dashboard just above) - a v2
# dashboard whose pages/blocks are pre-laid-out from one of the
# _TEMPLATES entries, still tied to a real conversation's data source the
# exact same way create_blank_dashboard is, and every block still starts
# from _default_block_config's genuinely-empty config. The person fills
# each one in afterward through the exact same canvas (Ask AI / build
# manually) as a block they added by hand - a template only ever saves
# them the layout work, never invents a number.
@router.post("/create-from-template", response_model=schemas.DashboardBuilderOut, status_code=201)
def create_from_template(
    payload: schemas.CreateFromTemplateRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    template = _TEMPLATES_BY_KEY.get(payload.template_key)
    if not template:
        raise HTTPException(404, "Unknown template.")

    conv = db.query(models.Conversation).filter(models.Conversation.id == payload.conversation_id).first()
    if not conv or not workspace_access.can_access_conversation(db, conv, user):
        raise HTTPException(404, "Conversation not found.")

    dashboard = models.Dashboard(
        owner_id=user.id,
        name=template["name"],
        layout_version=2,
        source_conversation_id=conv.id,
    )
    db.add(dashboard)
    db.flush()

    for page_position, page_def in enumerate(template["pages"]):
        page = models.DashboardPage(dashboard_id=dashboard.id, name=page_def["name"], position=page_position)
        db.add(page)
        db.flush()
        for block_position, block_def in enumerate(page_def["blocks"]):
            db.add(models.DashboardBlock(
                page_id=page.id,
                type=block_def["type"],
                title=block_def.get("title"),
                x=block_def["x"], y=block_def["y"], w=block_def["w"], h=block_def["h"],
                config=_default_block_config(block_def["type"]),
                position=block_position,
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


# 2026-09-25 (Round 2): there was previously no way at all to rename a v2
# dashboard's own name after it was created - a real gap that only became
# obviously wrong once create_blank_dashboard above could hand someone a
# dashboard permanently called "Untitled dashboard" with no way to fix it.
# Same pattern as update_page's own name handling just below.
@router.patch("/{dashboard_id}", response_model=schemas.DashboardBuilderOut)
def update_dashboard(
    dashboard_id: str,
    payload: schemas.UpdateDashboardRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    d = _get_dashboard_v2(db, user, dashboard_id, require_edit=True)
    if payload.name is not None:
        trimmed = payload.name.strip()
        if not trimmed:
            raise HTTPException(400, "Dashboard name can't be empty.")
        d.name = trimmed[:120]
    db.commit()
    db.refresh(d)
    return _builder_out(db, d, user)


# ---------- Round 4 (2026-09-25): branding/customization - see this
# file's own module docstring for the full design. Every one of these
# requires edit access (view-only visitors never change branding), and
# every one returns the whole updated DashboardBuilderOut, same convention
# as the rest of this file. ----------

@router.patch("/{dashboard_id}/branding", response_model=schemas.DashboardBuilderOut)
def update_branding(
    dashboard_id: str,
    payload: schemas.UpdateBrandingRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    d = _get_dashboard_v2(db, user, dashboard_id, require_edit=True)
    if payload.brand_primary_color is not None:
        d.brand_primary_color = _hex_color_or_none(payload.brand_primary_color)
    if payload.brand_accent_color is not None:
        d.brand_accent_color = _hex_color_or_none(payload.brand_accent_color)
    if payload.background_style is not None:
        style = payload.background_style.strip().lower()
        d.background_style = style if style in _ALLOWED_BACKGROUND_STYLES else None
    if payload.background_color is not None:
        d.background_color = _hex_color_or_none(payload.background_color)
    db.commit()
    db.refresh(d)
    return _builder_out(db, d, user)


@router.post("/{dashboard_id}/branding/logo", response_model=schemas.DashboardBuilderOut, status_code=201)
async def upload_logo(
    dashboard_id: str,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    d = _get_dashboard_v2(db, user, dashboard_id, require_edit=True)
    contents, content_type = await _read_and_validate_image(file, _MAX_LOGO_BYTES)
    d.logo_image = contents
    d.logo_image_content_type = content_type
    db.commit()
    db.refresh(d)
    return _builder_out(db, d, user)


@router.delete("/{dashboard_id}/branding/logo", response_model=schemas.DashboardBuilderOut)
def remove_logo(dashboard_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    d = _get_dashboard_v2(db, user, dashboard_id, require_edit=True)
    d.logo_image = None
    d.logo_image_content_type = None
    db.commit()
    db.refresh(d)
    return _builder_out(db, d, user)


@router.get("/{dashboard_id}/branding/logo")
def get_logo(dashboard_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    """The owner/editor's own preview fetch (e.g. BrandingPanel showing
    the current logo without re-uploading) - requires only VIEW access,
    same tier as get_builder_dashboard itself. The anonymous public/
    private viewer never calls this; it has its own unauthenticated,
    slug/hostname-keyed counterpart below."""
    d = _get_dashboard_v2(db, user, dashboard_id)
    return _image_response(d.logo_image, d.logo_image_content_type)


@router.post("/{dashboard_id}/branding/background", response_model=schemas.DashboardBuilderOut, status_code=201)
async def upload_background(
    dashboard_id: str,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    d = _get_dashboard_v2(db, user, dashboard_id, require_edit=True)
    contents, content_type = await _read_and_validate_image(file, _MAX_BACKGROUND_BYTES)
    d.background_image = contents
    d.background_image_content_type = content_type
    db.commit()
    db.refresh(d)
    return _builder_out(db, d, user)


@router.delete("/{dashboard_id}/branding/background", response_model=schemas.DashboardBuilderOut)
def remove_background(dashboard_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    d = _get_dashboard_v2(db, user, dashboard_id, require_edit=True)
    d.background_image = None
    d.background_image_content_type = None
    db.commit()
    db.refresh(d)
    return _builder_out(db, d, user)


@router.get("/{dashboard_id}/branding/background")
def get_background(dashboard_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    d = _get_dashboard_v2(db, user, dashboard_id)
    return _image_response(d.background_image, d.background_image_content_type)


@router.post("/{dashboard_id}/blocks", response_model=schemas.DashboardBuilderOut, status_code=201)
def create_block(
    dashboard_id: str,
    payload: schemas.CreateBlockRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Adds one empty block to the canvas - the element library's
    Chart/Table/KPI/Text/Filter/Heading/Divider/... choice. Empty on
    purpose: the person fills it in right after, either with ask_ai_block
    or build_manual_block below (or, for a text/heading block, a plain
    PATCH via update_block; a filter block similarly gets its target
    column set via update_block's config field, never a dedicated
    endpoint).

    2026-09-25 (Round 15, element library): payload.x/payload.y are new -
    when the frontend's canvas drags a card from the element library and
    drops it at a specific grid cell (react-grid-layout's own onDrop),
    it now sends exactly where the person dropped it instead of always
    landing at the bottom via _place_new_block below. Size is still never
    client-controlled - _default_block_size stays the only thing that
    decides how big a fresh block starts, whichever way it was placed."""
    d = _get_dashboard_v2(db, user, dashboard_id, require_edit=True)
    if payload.type not in (
        "chart", "table", "kpi", "text", "filter",
        "gauge", "donut", "sparkline", "avatar_list",
        "heading", "divider",
    ):
        raise HTTPException(400, "Unknown block type.")
    page = next((p for p in d.pages if p.id == payload.page_id), None)
    if not page:
        raise HTTPException(404, "Page not found on this dashboard.")

    if payload.x is not None and payload.y is not None:
        w, h = _default_block_size(payload.type)
        x = max(0, min(payload.x, _GRID_COLUMNS - w))
        y = max(0, payload.y)
    else:
        x, y, w, h = _place_new_block(page, payload.type)
    # A filter block's config only ever remembers WHICH COLUMN it filters -
    # a structural setting, edited the normal way through update_block's
    # `config` field, same as a text block's body. Its currently-selected
    # VALUE is never stored here at all - see this file's own module
    # docstring (Phase 2b, point 1) for why that's per-viewer/ephemeral
    # instead.
    default_config = _default_block_config(payload.type)
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
        # A real content change (a text block's body, a filter block's
        # column) - not a position/title-only edit, which leaves this
        # column untouched. See models.DashboardBlock's own docstring for
        # why this is set explicitly rather than via onupdate.
        block.data_updated_at = datetime.utcnow()

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
    block.data_updated_at = datetime.utcnow()
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
        # 2026-09-25 (Round 3): only read when block_type == "gauge" - see
        # _run_manual_recipe. Carried in the stored recipe itself (not a
        # separate column) so a later cross-filter recompute
        # (preview_filtered_blocks) reproduces the exact same gauge
        # range/target the person originally set, not a re-guessed one.
        "target_value": payload.target_value,
        "max_value": payload.max_value,
    }
    try:
        actual_type, config, default_title = _run_manual_recipe(df, recipe, existing_title=block.title)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(400, f"Couldn't compute that: {e}")

    block.type = actual_type
    block.config = config
    block.data_updated_at = datetime.utcnow()
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


@router.patch("/{dashboard_id}/blocks/{block_id}/accent-color", response_model=schemas.DashboardBuilderOut)
def set_block_accent_color(
    dashboard_id: str,
    block_id: str,
    payload: schemas.SetBlockAccentColorRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """2026-09-25h (inline editing round): the "click a color swatch right
    on the tile" affordance the frontend's KpiTile now offers in edit mode
    - see its own comment in components/DashboardBlocks.tsx. Merges just
    `config.accent_color` into whatever config already exists, exactly the
    same merge-not-replace pattern restyle_block above uses for
    chart_spec, rather than going through the generic update_block (which
    replaces a block's whole config and would silently erase a kpi's real
    computed value/label). Only meaningful for a kpi block today, but
    harmless to store on any block type - a color choice is pure
    presentation, so this deliberately does NOT touch data_updated_at
    (see models.DashboardBlock's own docstring for why that column is
    reserved for real content changes only)."""
    d = _get_dashboard_v2(db, user, dashboard_id, require_edit=True)
    block = _get_block(db, d, block_id)

    color = (payload.color or "").strip()
    if color and not re.fullmatch(r"#[0-9a-fA-F]{6}", color):
        raise HTTPException(400, "Color must be a hex value like #1a7a5c, or empty to reset it.")

    block.config = {**(block.config or {}), "accent_color": color or None}

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
        return schemas.FilteredBlocksOut(blocks=[], matched_rows=0)

    try:
        df = load_dataframe(ds, table=None, version="original", db=db)
    except Exception:
        return schemas.FilteredBlocksOut(blocks=[], matched_rows=0)

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

    # 2026-09-25e (elite pass): `df` above already has payload.filters
    # applied (or is the untouched full dataset when payload.filters is
    # empty - _apply_filters is a no-op on an empty list) - len(df) is
    # therefore the real, exact row count either way, at zero extra query
    # cost. See FilteredBlocksOut.matched_rows for what the frontend does
    # with this.
    return schemas.FilteredBlocksOut(blocks=out, matched_rows=len(df))


@router.post("/{dashboard_id}/pages", response_model=schemas.DashboardBuilderOut, status_code=201)
def create_page(
    dashboard_id: str,
    payload: schemas.CreatePageRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Adds a new, empty page (tab) at the end of the dashboard - the "+
    Add page" button. Named blocks are added to it afterward through the
    normal create_block flow, same as any other page."""
    d = _get_dashboard_v2(db, user, dashboard_id, require_edit=True)
    name = (payload.name or "").strip()[:80] or f"Page {len(d.pages) + 1}"
    page = models.DashboardPage(dashboard_id=d.id, name=name, position=len(d.pages))
    db.add(page)
    db.commit()
    db.refresh(d)
    return _builder_out(db, d, user)


@router.patch("/{dashboard_id}/pages/{page_id}", response_model=schemas.DashboardBuilderOut)
def update_page(
    dashboard_id: str,
    page_id: str,
    payload: schemas.UpdatePageRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Renames a page tab (`name`), reorders it (`position`), sets its own
    background tint (`background_color`, 2026-09-25 Round 4), or any
    combination in one call. A reorder is expressed as "this page's new
    index among all of this dashboard's pages" - every page is then
    renumbered to a contiguous 0..n-1 sequence in that new order, so
    `position` can never end up with a gap or a duplicate regardless of
    where the target index fell."""
    d = _get_dashboard_v2(db, user, dashboard_id, require_edit=True)
    page = next((p for p in d.pages if p.id == page_id), None)
    if not page:
        raise HTTPException(404, "Page not found on this dashboard.")
    if payload.name is None and payload.position is None and payload.background_color is None:
        raise HTTPException(400, "Nothing to update.")

    if payload.name is not None:
        name = payload.name.strip()[:80]
        if not name:
            raise HTTPException(400, "Page name can't be empty.")
        page.name = name

    if payload.position is not None:
        ordered = sorted(d.pages, key=lambda p: p.position)
        ordered.remove(page)
        target = max(0, min(payload.position, len(ordered)))
        ordered.insert(target, page)
        for i, p in enumerate(ordered):
            p.position = i

    # 2026-09-25 (Round 4): "" (empty string) clears it back to "inherit
    # the dashboard's background" - the same empty-string-clears convention
    # this codebase already uses for a block's title.
    if payload.background_color is not None:
        page.background_color = _hex_color_or_none(payload.background_color)

    db.commit()
    db.refresh(d)
    return _builder_out(db, d, user)


@router.delete("/{dashboard_id}/pages/{page_id}", response_model=schemas.DashboardBuilderOut)
def delete_page(
    dashboard_id: str, page_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)
):
    """A dashboard can never be left with zero pages - refuses to delete
    the last remaining one rather than leaving the dashboard in a state
    the frontend has no page to show for."""
    d = _get_dashboard_v2(db, user, dashboard_id, require_edit=True)
    page = next((p for p in d.pages if p.id == page_id), None)
    if not page:
        raise HTTPException(404, "Page not found on this dashboard.")
    other_pages = [p for p in d.pages if p.id != page_id]
    if not other_pages:
        raise HTTPException(400, "A dashboard needs at least one page - add another page before deleting this one.")

    db.delete(page)
    db.flush()
    for i, p in enumerate(sorted(other_pages, key=lambda p: p.position)):
        p.position = i
    db.commit()
    db.refresh(d)
    return _builder_out(db, d, user)


@router.post("/{dashboard_id}/pages/{page_id}/duplicate", response_model=schemas.DashboardBuilderOut, status_code=201)
def duplicate_page(
    dashboard_id: str, page_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)
):
    """Deep-copies a page's blocks onto a brand new page inserted
    immediately after the source page (not appended to the end - that's
    where a person expects a duplicate to land, right next to the
    original). copy.deepcopy on each block's config is deliberate: config
    can hold nested lists/dicts (chart_spec, result_rows, ...), and a
    shallow copy would leave the new block's config aliased to the SAME
    Python objects as the source block's for the rest of this request."""
    d = _get_dashboard_v2(db, user, dashboard_id, require_edit=True)
    source = next((p for p in d.pages if p.id == page_id), None)
    if not source:
        raise HTTPException(404, "Page not found on this dashboard.")

    for p in d.pages:
        if p.position > source.position:
            p.position += 1
    new_page = models.DashboardPage(
        dashboard_id=d.id,
        name=(f"{source.name} copy")[:80],
        position=source.position + 1,
    )
    db.add(new_page)
    db.flush()
    for b in sorted(source.blocks, key=lambda b: b.position):
        db.add(models.DashboardBlock(
            page_id=new_page.id,
            type=b.type,
            title=b.title,
            x=b.x, y=b.y, w=b.w, h=b.h,
            config=copy.deepcopy(b.config),
            position=b.position,
        ))

    db.commit()
    db.refresh(d)
    return _builder_out(db, d, user)


@router.post("/{dashboard_id}/publish", response_model=schemas.DashboardBuilderOut)
def publish_dashboard(
    dashboard_id: str,
    payload: schemas.PublishDashboardRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    d = _get_dashboard_v2(db, user, dashboard_id, require_edit=True)
    if payload.mode not in ("public", "private"):
        raise HTTPException(400, f'Unknown share mode "{payload.mode}".')

    share = d.share
    if not share:
        share = models.DashboardShare(dashboard_id=d.id, slug=_make_unique_slug(db, d.name), mode=payload.mode)
        db.add(share)

    share.mode = payload.mode
    if payload.mode == "private":
        password = (payload.password or "").strip()
        share.password_hash = security.hash_password(password) if password else None
    share.published_at = datetime.utcnow()
    db.commit()
    db.refresh(d)
    return _builder_out(db, d, user)


@router.post("/{dashboard_id}/shares/emails", response_model=schemas.DashboardBuilderOut, status_code=201)
def add_share_email(
    dashboard_id: str,
    payload: schemas.AddShareEmailRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Adds one person to this dashboard's private access list. Works
    whether or not the dashboard has been published yet, and whether it's
    currently public or private - lets someone build up the guest list (or
    switch back and forth) before flipping the share to "private" and
    publishing, rather than forcing that order. Creates the DashboardShare
    row itself (mode="private", unpublished) if this dashboard has never
    been shared at all yet."""
    d = _get_dashboard_v2(db, user, dashboard_id, require_edit=True)
    email = payload.email.strip().lower()

    share = d.share
    if not share:
        share = models.DashboardShare(dashboard_id=d.id, slug=_make_unique_slug(db, d.name), mode="private")
        db.add(share)
        db.flush()

    already = any(e.email.lower() == email for e in share.allowed_emails)
    if already:
        raise HTTPException(400, "That email is already on this dashboard's access list.")

    db.add(models.DashboardShareEmail(share_id=share.id, email=email))
    db.commit()
    db.refresh(d)
    return _builder_out(db, d, user)


@router.delete("/{dashboard_id}/shares/emails/{email_id}", response_model=schemas.DashboardBuilderOut)
def remove_share_email(
    dashboard_id: str,
    email_id: str,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Revokes one person's access immediately - see this file's own
    module docstring (Phase 3, point 2) for why this takes effect on that
    person's very next page load rather than only once some token
    expires."""
    d = _get_dashboard_v2(db, user, dashboard_id, require_edit=True)
    share = d.share
    row = (
        db.query(models.DashboardShareEmail)
        .filter(models.DashboardShareEmail.id == email_id, models.DashboardShareEmail.share_id == (share.id if share else None))
        .first()
        if share else None
    )
    if not row:
        raise HTTPException(404, "That person isn't on this dashboard's access list.")
    db.delete(row)
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


@router.post("/{dashboard_id}/shares/domain", response_model=schemas.DashboardBuilderOut, status_code=201)
def set_custom_domain(
    dashboard_id: str,
    payload: schemas.SetCustomDomainRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Registers a white-label custom domain against this dashboard's
    share (see this file's own module docstring, Phase 4, and
    services/render_domains.py for what actually happens on Render's
    side). Works whether or not the dashboard is currently published -
    same reasoning as add_share_email above - but the share row itself
    must already exist, since a custom domain always points at one
    specific slug's dashboard, never a dashboard with no share at all."""
    d = _get_dashboard_v2(db, user, dashboard_id, require_edit=True)
    share = d.share
    if not share:
        raise HTTPException(400, "Publish this dashboard first, then add a custom domain.")

    domain = _normalize_domain(payload.domain)

    clash = (
        db.query(models.DashboardShare)
        .filter(models.DashboardShare.custom_domain == domain, models.DashboardShare.id != share.id)
        .first()
    )
    if clash:
        raise HTTPException(400, f'"{domain}" is already in use by another dashboard on this account.')

    if share.custom_domain == domain and share.render_custom_domain_id:
        # Re-submitting the same domain (e.g. a double click) is a no-op,
        # not a duplicate-registration error.
        return _builder_out(db, d, user)

    if share.render_custom_domain_id and share.custom_domain != domain:
        # Swapping to a different domain - deregister the old one first
        # so it doesn't linger claimed on Render after this dashboard no
        # longer uses it. Best-effort: render_domains.delete_custom_domain
        # already tolerates the old registration being gone by now.
        try:
            render_domains.delete_custom_domain(share.render_custom_domain_id)
        except render_domains.RenderDomainError:
            pass

    try:
        domain_id, status_value = render_domains.create_custom_domain(domain)
    except render_domains.RenderDomainsNotConfigured as e:
        raise HTTPException(503, str(e))
    except render_domains.RenderDomainError as e:
        raise HTTPException(400, str(e))

    share.custom_domain = domain
    share.render_custom_domain_id = domain_id
    share.custom_domain_status = status_value
    share.custom_domain_error = None
    db.commit()
    db.refresh(d)
    return _builder_out(db, d, user)


@router.post("/{dashboard_id}/shares/domain/recheck", response_model=schemas.DashboardBuilderOut)
def recheck_custom_domain(
    dashboard_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)
):
    """The "Check again" button - re-polls Render for this domain's
    current DNS-verification/SSL state (see render_domains.py's own
    docstring for why this is on-demand rather than a webhook). A Render-
    side error (e.g. the domain got removed by hand in Render's own
    dashboard) is recorded on custom_domain_error and returned as a
    normal 200 rather than failing the request - the frontend shows it
    inline next to the "Check again" button, same as any other domain
    error, rather than as a failed page load."""
    d = _get_dashboard_v2(db, user, dashboard_id, require_edit=True)
    share = d.share
    if not share or not share.render_custom_domain_id:
        raise HTTPException(400, "This dashboard doesn't have a custom domain set up yet.")

    try:
        share.custom_domain_status = render_domains.get_custom_domain_status(share.render_custom_domain_id)
        share.custom_domain_error = None
    except render_domains.RenderDomainsNotConfigured as e:
        raise HTTPException(503, str(e))
    except render_domains.RenderDomainError as e:
        share.custom_domain_error = str(e)

    db.commit()
    db.refresh(d)
    return _builder_out(db, d, user)


@router.delete("/{dashboard_id}/shares/domain", response_model=schemas.DashboardBuilderOut)
def remove_custom_domain(
    dashboard_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)
):
    """Deregisters this dashboard's custom domain, both on Render and in
    this app's own state. Deliberately clears the local fields even if
    the Render call itself fails or isn't configured (see
    services.render_domains.delete_custom_domain's own docstring) - a
    dashboard owner should never be stuck unable to remove a domain from
    their own dashboard just because of something on Render's side."""
    d = _get_dashboard_v2(db, user, dashboard_id, require_edit=True)
    share = d.share
    if not share or not share.custom_domain:
        raise HTTPException(400, "This dashboard doesn't have a custom domain set up.")

    if share.render_custom_domain_id:
        try:
            render_domains.delete_custom_domain(share.render_custom_domain_id)
        except (render_domains.RenderDomainsNotConfigured, render_domains.RenderDomainError):
            pass

    share.custom_domain = None
    share.render_custom_domain_id = None
    share.custom_domain_status = None
    share.custom_domain_error = None
    db.commit()
    db.refresh(d)
    return _builder_out(db, d, user)


# ---------- Shared logic between slug-based and hostname-based public access ----------
# (Phase 4: a custom domain resolves through public_domains_router below
# instead of public_router above - see this file's own module docstring,
# Phase 4 points 2-3, for why they're kept as two routers rather than two
# paths on one. Both funnel through the exact same helpers below so the
# private-share access-check logic is never duplicated between them.)

def _resolve_share_by_slug(db: Session, slug: str) -> models.DashboardShare:
    share = db.query(models.DashboardShare).filter(models.DashboardShare.slug == slug).first()
    if not share or not share.published_at:
        raise HTTPException(404, "This dashboard isn't available.")
    return share


def _resolve_share_by_domain(db: Session, hostname: str) -> models.DashboardShare:
    domain = (hostname or "").strip().lower().split(":")[0]  # drop a browser-supplied :port
    share = (
        db.query(models.DashboardShare)
        .filter(models.DashboardShare.custom_domain == domain, models.DashboardShare.published_at.isnot(None))
        .first()
    )
    if not share:
        raise HTTPException(404, "This dashboard isn't available.")
    return share


def _issue_viewer_token_if_allowed(share: models.DashboardShare, payload: schemas.VerifyPrivateAccessRequest) -> str:
    """The private-dashboard email/password gate itself, shared by both
    the slug and hostname verify endpoints below. Deliberately the SAME
    "not available" / access-denied messages regardless of how the
    dashboard was reached - see verify_private_dashboard_access's own
    docstring for the full reasoning."""
    if share.mode != "private":
        raise HTTPException(404, "This dashboard isn't available.")
    email = payload.email.strip().lower()
    allowed = {e.email.lower() for e in share.allowed_emails}
    if email not in allowed:
        raise HTTPException(403, "This dashboard hasn't been shared with that email address.")
    if share.password_hash and not (payload.password and security.verify_password(payload.password, share.password_hash)):
        raise HTTPException(401, "Incorrect password.")
    return security.create_dashboard_viewer_token(share.id, email)


def _render_public_dashboard(
    db: Session, share: models.DashboardShare, x_dashboard_access_token: str | None
) -> schemas.PublicDashboardOut:
    """The actual dashboard-content fetch, shared by both the slug and
    hostname GET endpoints below. For mode=="private", a valid
    X-Dashboard-Access-Token (from _issue_viewer_token_if_allowed above)
    is required, AND that token's email is re-checked against the
    share's LIVE allowed_emails list on this exact request - not just
    trusted because the token's signature checks out - so a revoke
    (remove_share_email) takes effect on the very next page load, not
    only once the token eventually expires. A missing/invalid token
    401s ("please sign in with your email"); a valid token for an email
    that's since been removed from the list 403s ("access revoked") -
    the frontend shows a different message for each."""
    if share.mode not in ("public", "private"):
        raise HTTPException(404, "This dashboard isn't available.")

    if share.mode == "private":
        email = (
            security.decode_dashboard_viewer_token(x_dashboard_access_token, share.id)
            if x_dashboard_access_token else None
        )
        if not email:
            raise HTTPException(401, "Sign in with your email to view this dashboard.")
        allowed = {e.email.lower() for e in share.allowed_emails}
        if email.lower() not in allowed:
            raise HTTPException(403, "Your access to this dashboard has been revoked or was never granted.")

    d = db.query(models.Dashboard).filter(models.Dashboard.id == share.dashboard_id).first()
    if not d:
        raise HTTPException(404, "This dashboard isn't available.")
    pages = [_page_out(p) for p in sorted(d.pages, key=lambda p: p.position)]
    return schemas.PublicDashboardOut(
        name=d.name,
        pages=pages,
        brand_primary_color=d.brand_primary_color,
        brand_accent_color=d.brand_accent_color,
        background_style=d.background_style,
        background_color=d.background_color,
        has_logo=bool(d.logo_image),
        has_background_image=bool(d.background_image),
    )


# ---------- Round 4 (2026-09-25): branding images, served publicly by slug
# or hostname - see this file's own module docstring for why these are
# gated only on "currently published," never the private-share viewer-
# token check _render_public_dashboard uses for actual dashboard content.
# ----------

def _resolve_dashboard_for_public_branding(db: Session, share: models.DashboardShare) -> models.Dashboard | None:
    return db.query(models.Dashboard).filter(models.Dashboard.id == share.dashboard_id).first()


@public_router.get("/{slug}/branding/logo")
def get_public_logo(slug: str, db: Session = Depends(get_db)):
    share = _resolve_share_by_slug(db, slug)
    d = _resolve_dashboard_for_public_branding(db, share)
    return _image_response(d.logo_image if d else None, d.logo_image_content_type if d else None)


@public_router.get("/{slug}/branding/background")
def get_public_background(slug: str, db: Session = Depends(get_db)):
    share = _resolve_share_by_slug(db, slug)
    d = _resolve_dashboard_for_public_branding(db, share)
    return _image_response(d.background_image if d else None, d.background_image_content_type if d else None)


@public_domains_router.get("/{hostname}/branding/logo")
def get_public_logo_by_domain(hostname: str, db: Session = Depends(get_db)):
    share = _resolve_share_by_domain(db, hostname)
    d = _resolve_dashboard_for_public_branding(db, share)
    return _image_response(d.logo_image if d else None, d.logo_image_content_type if d else None)


@public_domains_router.get("/{hostname}/branding/background")
def get_public_background_by_domain(hostname: str, db: Session = Depends(get_db)):
    share = _resolve_share_by_domain(db, hostname)
    d = _resolve_dashboard_for_public_branding(db, share)
    return _image_response(d.background_image if d else None, d.background_image_content_type if d else None)


@public_router.post("/{slug}/verify", response_model=schemas.VerifyPrivateAccessOut)
def verify_private_dashboard_access(
    slug: str,
    payload: schemas.VerifyPrivateAccessRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    """The private-dashboard email/password gate - unauthenticated (this
    person has no GD360 account and isn't getting one), rate-limited per
    IP and per slug since it's effectively a password-guessing surface
    (see this file's own module docstring, Phase 3, point 3). Deliberately
    the SAME "not available" message whether the slug doesn't exist, isn't
    published, or is published as "public" rather than "private" - no
    information about which case it is leaks to an unauthenticated caller.
    On success, issues a short-lived viewer token scoped to exactly this
    share and email (security.create_dashboard_viewer_token) - see
    get_public_dashboard below for how that token is then re-validated
    against the live access list on every actual content fetch."""
    ip = _client_ip(request)
    _check_rate_limit(f"dashboard-verify:ip:{ip}", limit=20)
    _check_rate_limit(f"dashboard-verify:slug:{slug}", limit=30)

    share = _resolve_share_by_slug(db, slug)
    if share.mode != "private":
        raise HTTPException(404, "This dashboard isn't available.")
    token = _issue_viewer_token_if_allowed(share, payload)
    return schemas.VerifyPrivateAccessOut(access_token=token)


@public_router.get("/{slug}", response_model=schemas.PublicDashboardOut)
def get_public_dashboard(
    slug: str,
    db: Session = Depends(get_db),
    x_dashboard_access_token: str | None = Header(default=None, alias="X-Dashboard-Access-Token"),
):
    """No GD360 login at all, deliberately - this is the endpoint an
    anonymous person with the public OR private link actually hits. Only
    ever returns a dashboard that is CURRENTLY published - unpublishing
    takes effect immediately here, even though the share row/slug itself
    is kept around for a possible republish (see unpublish_dashboard
    above). See _render_public_dashboard above for the actual access
    checks, shared with get_public_dashboard_by_domain below."""
    share = _resolve_share_by_slug(db, slug)
    return _render_public_dashboard(db, share, x_dashboard_access_token)


@public_domains_router.post("/{hostname}/verify", response_model=schemas.VerifyPrivateAccessOut)
def verify_private_dashboard_access_by_domain(
    hostname: str,
    payload: schemas.VerifyPrivateAccessRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    """Hostname-keyed counterpart of verify_private_dashboard_access
    above, for a dashboard reached through its own white-label custom
    domain instead of GD360's own /d/:slug link - see this file's own
    module docstring, Phase 4, for why this is a separate router rather
    than a second path on public_router. Rate-limited the same way,
    keyed by hostname instead of slug."""
    ip = _client_ip(request)
    _check_rate_limit(f"dashboard-verify:ip:{ip}", limit=20)
    _check_rate_limit(f"dashboard-verify:domain:{hostname}", limit=30)

    share = _resolve_share_by_domain(db, hostname)
    if share.mode != "private":
        raise HTTPException(404, "This dashboard isn't available.")
    token = _issue_viewer_token_if_allowed(share, payload)
    return schemas.VerifyPrivateAccessOut(access_token=token)


@public_domains_router.get("/{hostname}", response_model=schemas.PublicDashboardOut)
def get_public_dashboard_by_domain(
    hostname: str,
    db: Session = Depends(get_db),
    x_dashboard_access_token: str | None = Header(default=None, alias="X-Dashboard-Access-Token"),
):
    """Hostname-keyed counterpart of get_public_dashboard above - this is
    what the SPA calls (see api/client.ts's publicDashboardApi.
    getByHostname and pages/PublicDashboardView.tsx) when it's been
    loaded through a customer's own custom domain rather than GD360's
    own onrender.com URL with a /d/:slug path in it."""
    share = _resolve_share_by_domain(db, hostname)
    return _render_public_dashboard(db, share, x_dashboard_access_token)
