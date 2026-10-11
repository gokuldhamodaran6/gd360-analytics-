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

Canvas cells (2026-10-07, analyst canvas + dashboard-from-prompt round):
the Option C canvas renders the SAME DashboardBlock rows as cells, so two
block kinds were added and two config keys bind cells together. The
contract the frontend depends on:

  - type "sql": config {sql: <one SELECT>, name: <identifier, unique per
    page; derived from the title when omitted>, parameters: [names it
    references - server-filled], cells: [cell names it reads], computed_in,
    spec_columns}. Written through create_block/update_block's `config`
    (validated by _validate_cell_config: read-only, every {{name}} / @name
    is a dashboard parameter, every {{cell:name}} exists with no loop, and
    the bound statement passes the warehouse's zero-row check). Run by
    POST /pages/{page_id}/run like any block: the page filters are NOT
    pushed down (raw SQL has no spec); the request's `parameters` {name:
    value} ARE bound (never spliced - services/dashboard_engine.
    bind_parameters); rows are capped at DASHBOARD_MAX_BLOCK_ROWS. Its
    BlockResult carries kind "sql", name, parameters, missing_parameters.
  - type "input": config {parameter_id: <Dashboard.parameters[].id>,
    parameter_name}. Rendered inline, never run.
  - type chart/kpi/table/donut/sparkline/avatar_list with config
    {source_block_id: <sql cell id>}: rendered from that cell's result (the
    run result is the source's, with kind "derived" and source_block_id).
    Dependencies are reported on the run response ({block_id: [source
    ids]}, plus the resolved `order`); a loop is a 400 at write time and
    at run time.
  - Dashboard.parameters entries gained `name` (what a cell references);
    _validate_parameters derives it from the column when omitted.
  - POST /{dashboard_id}/blocks/{block_id}/swap re-renders a spec block
    (or a bound block) as another chart type / block shape, no model call.
  - POST /propose, /propose/{id}/revise, /propose/{id}/commit and GET
    /propose/templates are the Builder's describe -> review -> publish
    flow - see their section below. /generate on a warehouse source now
    delegates to propose + commit, so nothing new ever loads a sample.
  - Comments live in routers/dashboard_comments.py; DashboardBuilderOut.
    comment_counts carries per-block {open, total}.
"""
import copy
import gc
import json
import re
import secrets
import time
from collections import defaultdict, deque
from datetime import datetime
from typing import Any

import pandas as pd
from fastapi import APIRouter, Depends, File, Header, HTTPException, Request, Response, UploadFile, status
from sqlalchemy import or_
from sqlalchemy.orm import Session

from .. import models, schemas, security
from ..database import get_db
from ..deps import get_current_user
from ..services import ai_engine, audit, chart_builder, dashboard_engine, data_access_rules, policies, render_domains, workspace_access
from ..services import appearance as appearance_svc
from ..services import chart_recommender
from ..services import forecast as forecast_svc
from ..services import query_builder
from ..services.profile_cache import profile_cache_get
from ..services.connectors import ReadOnlyViolation, assert_read_only_sql
from ..services.data_loader import load_dataframe, default_table_for_preview
from ..services.metrics import resolve_metric_value
from ..services.transforms import apply_transform_steps
from .chat import _load_selected_tables, _other_sources_catalog, _warehouse_schema_text
from .dashboards import _can_edit, _can_view
# 2026-09-29 (Hex-level filters round): reuses the Data tab's own,
# already-battle-tested column-filter engine (values/text/number/date/
# boolean, including numeric & date RANGES and multi-select) rather than
# hand-rolling a second, narrower one just for dashboards - see
# _apply_filters below and FilterCriterion's own docstring in schemas.py.
# No circular import risk: routers/datasources.py imports nothing from
# this file, the same one-way relationship this file already has with
# routers/chat.py and routers/dashboards.py (see the imports just above).
from .datasources import _apply_column_filter, _jsonify_scalar

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
# 2026-10-01 (filter-engine fix round): preview_filtered_blocks' own safe
# rebuild set is DELIBERATELY WIDER than _RESTYLE_CHART_TYPES above - the
# restyle dropdown is constrained to types that work from ANY plain
# 2-column result (so switching types never fails just because the new
# type wanted a different shape), but rebuilding a filtered block never
# switches type - it only re-renders the SAME chart_type the block
# already is, so it's safe to also cover the two real chart_type values
# this still left unable to ever respond to a page filter: "grouped_bar"/
# "stacked_bar" (the multi-series "value by X, split by Y" comparison -
# exactly what a department-by-gender attrition chart is) and
# "faceted_bar" (the small-multiples panel grid). See
# _rebuild_filtered_chart_spec below for the per-type reconstruction each
# of these three needs beyond the plain 2-column x/y shape every other
# type here already handles.
_FILTER_REBUILD_CHART_TYPES = _RESTYLE_CHART_TYPES | {"grouped_bar", "stacked_bar", "faceted_bar"}
# A page can carry at most this many active filter blocks at once - plenty
# for any real dashboard, and keeps preview_filtered_blocks' per-request
# work (one boolean mask pass over the dataframe per filter) bounded.
_MAX_FILTERS_PER_REQUEST = 8


def _apply_filters(df: pd.DataFrame, filters: list) -> pd.DataFrame:
    """Applies every filter criterion in `filters`, AND'd together -
    the same overall semantics as a PowerBI/Tableau slicer, but (2026-09-29,
    "Hex-level filters" round) through the EXACT SAME operator engine as
    the Data tab's own Excel-style column filter panel
    (_apply_column_filter, imported from routers/datasources.py) instead
    of a second, narrower implementation. Before this round, `filters` was
    always a plain (column, value) equality pair; `spec` now carries
    whatever shape that panel already sends - "values" (multi-select),
    "text" (contains/equals/starts_with/etc), "number" (a comparison OR a
    "between" RANGE), "date" (a range), "boolean" - which is what actually
    gives dashboard filters ranges and multi-select, not just "equals".
    A filter whose column isn't actually in this dataframe, or whose spec
    is malformed or incompatible with the column's real dtype, is skipped
    rather than raising - defensive against a stale filter selection
    surviving a data source change, the same tradeoff the original
    version of this function already made."""
    for f in filters:
        column = f.column if hasattr(f, "column") else f.get("column")
        spec = f.spec if hasattr(f, "spec") else f.get("spec")
        if not column or column not in df.columns:
            continue
        try:
            df = _apply_column_filter(df, column, spec)
        except Exception:
            continue
    return df


# 2026-09-29 (thought-leader filters round): the reverse of
# chart_builder.build_figure's own chart_type vocabulary - reads a chart
# type back off an already-built Plotly spec, purely as a FALLBACK for a
# block saved before this round (2026-10-01) started persisting the real
# chart_type string straight onto block.config at build time (see
# _ai_result_to_block_shape/_block_config_shape/restyle_block, all three
# of which now stamp config["chart_type"]) - preview_filtered_blocks below
# always prefers that stored value when present, and only calls this for
# an older block that predates it.
#
# 2026-10-01 bug fix (Gokul's own report, verbatim: "if i click any filter
# it is not connected with any chart no chart is reacting to the filter it
# feel like useless"): this used to look ONLY at data[0].type, which is
# "bar" for a plain single-series bar AND for a grouped/stacked/faceted
# multi-series bar alike - so a real department-by-gender comparison chart
# (built as "grouped_bar" or "faceted_bar") was confidently misread as
# plain "bar", handed to chart_builder.build_figure with the WRONG type,
# and silently rebuilt into a nonsense chart with the wrong axes - no
# error, no banner, just a chart that quietly stopped matching its own
# filter. Now inspects trace COUNT, each trace's own `meta.role` (the
# explicit "facet_panel" marker _build_faceted_bar stamps on every panel
# trace), and layout.barmode before ever answering "bar" - so a multi-
# series shape is correctly named, not collapsed into the single-series
# case.
#
# Still deliberately honest at its core: anything this can't confidently
# name - a heatmap, a funnel, a radar, any shape outside the vocabulary
# below - returns None, never a guess, and the caller treats None exactly
# like a block with no recipe at all: left out of the filtered response,
# still showing its real, unfiltered content rather than a corrupted one.
def _detect_restyle_chart_type(chart_spec: dict) -> str | None:
    data = chart_spec.get("data") if isinstance(chart_spec, dict) else None
    if not data or not isinstance(data, list):
        return None
    traces = [t for t in data if isinstance(t, dict)]
    if not traces:
        return None
    trace = traces[0]
    t = trace.get("type")

    if t == "bar":
        if any((tr.get("meta") or {}).get("role") == "facet_panel" for tr in traces):
            return "faceted_bar"
        if len(traces) > 1:
            layout = chart_spec.get("layout") if isinstance(chart_spec.get("layout"), dict) else {}
            return "stacked_bar" if layout.get("barmode") == "stack" else "grouped_bar"
        return "horizontal_bar" if trace.get("orientation") == "h" else "bar"
    if t == "pie":
        return "pie"
    if t == "scatter":
        fill = trace.get("fill")
        if fill and fill != "none":
            return "area"
        mode = trace.get("mode") or ""
        if "lines" in mode:
            return "line"
        return "scatter"
    return None


# 2026-10-01 (filter-engine fix round): chart_builder.build_figure's own
# chart-type branches expect two genuinely different input shapes, and
# preview_filtered_blocks' block_df (reconstructed from the block's stored
# tidy result_columns/result_rows - always a flat table of named columns,
# never a pandas index) only ever naturally matches ONE of them. Every
# type in _RESTYLE_CHART_TYPES, plus "faceted_bar", reads its data by
# COLUMN - build_figure's own 2-column x/y rename for the simple types,
# and _build_faceted_bar's fixed (facet, category, value) column order for
# that one - so block_df can be handed to build_figure completely as-is.
# "grouped_bar"/"stacked_bar" are the one exception: build_figure reads
# the category axis off the dataframe's INDEX (result.index, not a named
# column - see its own comment), because that is exactly the shape a
# fresh groupby naturally produces when a chart is first built. A
# reconstructed block_df has no such index (it's a flat records table), so
# without this, those two types would silently rebuild with the wrong
# axis labels - a different, quieter version of the same "filters don't
# work" bug this whole round exists to fix, not a hypothetical one: this
# was caught by tracing exactly what build_figure's grouped_bar/stacked_bar
# branch actually reads before this helper was written. This function is
# the one, single place that bridges that gap, so every caller of
# chart_builder.build_figure in this file goes through the same correct
# shape instead of each needing to remember this distinction itself.
def _rebuild_filtered_chart_spec(block_df: pd.DataFrame, chart_type: str, title: str) -> dict:
    if chart_type in ("grouped_bar", "stacked_bar") and len(block_df.columns) >= 2:
        dimension_col = block_df.columns[0]
        indexed = block_df.set_index(dimension_col)
        indexed.index.name = dimension_col
        return chart_builder.build_figure(indexed, chart_type, title=title)
    return chart_builder.build_figure(block_df, chart_type, title=title)


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


def _kpi_or_gauge_config(
    value: Any, block_type: str, label: str, recipe: dict,
    target_value: Any = None, max_value: Any = None,
) -> tuple[str, dict, str]:
    """2026-09-30 (semantic layer v1): the value -> kpi/gauge config shape,
    pulled out of _run_manual_recipe's own kpi/gauge branch so it's ONE
    shared implementation for both ways a kpi/gauge tile's number can now
    be computed - a plain column+aggregation recipe (_run_manual_recipe
    below) and a saved-metric-backed recipe (build_manual_block's
    metric_id branch, and preview_filtered_blocks' matching recompute
    branch) - rather than two copies that could quietly drift apart on
    exactly the kind of tile a semantic layer exists to keep consistent.
    `recipe` is stored on the returned config as-is (a plain column+agg
    dict for the former, a {"metric_id": ...} dict for the latter) -
    whichever shape it is is what tells preview_filtered_blocks which of
    the two recompute paths to use on a filter change."""
    if block_type == "kpi":
        return "kpi", {"value": value, "label": label, "recipe": recipe}, label

    # "gauge" - a plain number becomes a radial "value out of max, marked
    # at target" read. target_value/max_value are both optional - a gauge
    # is never left un-renderable just because neither was set.
    numeric_value = _safe_float(value, 0.0)
    resolved_target = _safe_float(target_value, None) if target_value is not None else None
    resolved_max = _safe_float(max_value, None) if max_value is not None else None
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
        "target": resolved_target, "label": label, "recipe": recipe,
    }
    return "gauge", config, label


def _metric_kpi_or_gauge_config(
    metric: "models.MetricDefinition", block_type: str, df: pd.DataFrame,
    target_value: Any = None, max_value: Any = None, transform_id: str | None = None,
) -> tuple[str, dict, str]:
    """2026-09-30 (semantic layer v1): the metric-definition-backed
    counterpart to _run_manual_recipe's plain column+aggregation path -
    resolves a SAVED metric (models.MetricDefinition) live through
    services/metrics.resolve_metric_value against `df` (already page/
    own-filtered by the caller, and - 2026-09-30 transformation layer v1 -
    already resolved from a saved transform first when transform_id is set,
    see build_manual_block; the metric's OWN saved filters are then applied
    on top of that, inside resolve_metric_value), then builds the
    identical kpi/gauge config shape via _kpi_or_gauge_config so the two
    ways of building a kpi/gauge tile are visually indistinguishable and,
    critically, always agree with each other and with this same metric's
    own current_value shown on its definition (routers/
    metric_definitions.py) - the entire point of a semantic layer.

    `transform_id`, when given, is stored on the returned recipe alongside
    metric_id purely so preview_filtered_blocks can re-resolve the same
    saved transform (not just the same metric) on a later page-filter
    recompute - see that function's own comment.

    Raises ValueError with a short, friendly message on anything the
    caller should show back as-is - an unsupported block type, or the
    metric's own column/filters failing to resolve against this data
    (e.g. a column it references was since renamed or removed) - matching
    _run_manual_recipe's own error contract exactly, so build_manual_block
    handles both paths with one try/except."""
    if block_type not in ("kpi", "gauge"):
        raise ValueError("A saved metric can only be used for a KPI or gauge block.")
    value, error = resolve_metric_value(df, metric.metric_column, metric.agg, metric.filters)
    if error or value is None:
        raise ValueError(error or "Couldn't compute this metric for the current data.")
    recipe = {
        "metric_id": metric.id, "block_type": block_type, "target_value": target_value, "max_value": max_value,
        "transform_id": transform_id,
    }
    return _kpi_or_gauge_config(value, block_type, metric.name, recipe, target_value, max_value)


# A recipe's `time_grain` -> the pandas period it is bucketed by.
_RECIPE_TIME_FREQ = {"day": "D", "week": "W", "month": "M", "quarter": "Q", "year": "Y"}

# 2026-10-07 (real end-to-end run): what a FILE block's recipe can hold
# beyond the manual form's one measure over one group-by. A proposal's
# "Top markets: bookings, cancellation rate, ADR by country" table is
# several (aggregation, column) measures over one group-by; "Hotel and
# segment detail" groups by two columns; a trend split by segment is a
# time bucket plus a series column. None of that needs an expression or a
# filter, so pandas computes it the same way the warehouse would.
_MAX_RECIPE_MEASURES = 6
_MAX_RECIPE_GROUP_BY = 3
_KPI_SPARKLINE_MAX_POINTS = 60
_RECIPE_AGG_LABEL = {"sum": "Sum", "avg": "Average", "count": "Count", "min": "Min", "max": "Max"}


def _recipe_alias(raw, agg: str, column: str | None, taken: set[str]) -> str:
    """The result column a measure is written to: the proposal's own
    alias ("bookings", "cancellation_rate"), else "<agg>_<column>". Never
    a name another column of the result already has."""
    base = re.sub(r"[^A-Za-z0-9_]+", "_", str(raw or "")).strip("_")
    if not base:
        base = f"{agg}_{re.sub(r'[^A-Za-z0-9_]+', '_', str(column or 'rows')).strip('_') or 'rows'}".lower()
    candidate, n = base, 2
    while candidate in taken:
        candidate = f"{base}_{n}"
        n += 1
    taken.add(candidate)
    return candidate


def _bucket_dates(series: pd.Series, grain: str | None) -> pd.Series | None:
    """`series` as the first day of the period each date falls in
    ("2016-03-01"), or None when the column holds no dates."""
    freq = _RECIPE_TIME_FREQ.get(str(grain or "").lower())
    if not freq:
        return None
    as_dates = series
    if not pd.api.types.is_datetime64_any_dtype(as_dates):
        as_dates = pd.to_datetime(as_dates, errors="coerce")
    if not as_dates.notna().any():
        return None
    try:
        as_dates = as_dates.dt.tz_localize(None)
    except (TypeError, AttributeError):
        pass
    return as_dates.dt.to_period(freq).dt.start_time.dt.strftime("%Y-%m-%d")


def _recipe_order(frame: pd.DataFrame, recipe: dict, group_cols: list[str], default_by: str | None, chronological: bool) -> pd.DataFrame:
    """Rows in the order the recipe asks for (`order_by`: [{by, dir}] - a
    result column, or "period" for the time bucket), else in time order
    for a trend, else by the first measure, largest first."""
    by: list[str] = []
    ascending: list[bool] = []
    for o in recipe.get("order_by") or []:
        if not isinstance(o, dict):
            continue
        name = o.get("by")
        if name == "period" and chronological and group_cols:
            name = group_cols[0]
        if name in frame.columns and name not in by:
            by.append(name)
            ascending.append(str(o.get("dir") or "asc").lower() != "desc")
    if not by:
        if chronological:
            return frame
        if default_by and default_by in frame.columns:
            by, ascending = [default_by], [False]
    if not by:
        return frame
    return frame.sort_values(by=by, ascending=ascending, kind="stable")


def _run_grouped_measures(df: pd.DataFrame, recipe: dict, existing_title: str | None = None) -> tuple[str, dict, str]:
    """A table or a chart over one OR MORE group-by columns with one OR
    MORE plain measures - _run_manual_recipe's branch for a recipe that
    carries `measures` ([{alias, agg, column}]) / `group_by` ([columns]).
    Same error contract (ValueError with the sentence to show)."""
    block_type = recipe.get("block_type")
    raw_measures = [m for m in (recipe.get("measures") or []) if isinstance(m, dict)]
    if not raw_measures:
        raw_measures = [{"alias": recipe.get("alias"), "agg": recipe.get("agg"), "column": recipe.get("metric_column")}]
    if len(raw_measures) > _MAX_RECIPE_MEASURES:
        raise ValueError(f"A block can show at most {_MAX_RECIPE_MEASURES} measures.")
    group_cols = [g for g in (recipe.get("group_by") or []) if g]
    if not group_cols and recipe.get("group_by_column"):
        group_cols = [recipe["group_by_column"]]
    if not group_cols:
        raise ValueError("Pick a column to group by for a table or a chart.")
    if len(group_cols) > _MAX_RECIPE_GROUP_BY:
        raise ValueError(f"A block can group by at most {_MAX_RECIPE_GROUP_BY} columns.")
    for g in group_cols:
        if g not in df.columns:
            raise ValueError(f'Column "{g}" was not found in this data.')

    taken = set(group_cols)
    measures: list[dict] = []
    for i, m in enumerate(raw_measures):
        agg, column = m.get("agg"), m.get("column")
        if agg not in _MANUAL_AGG_FUNCS:
            raise ValueError("Unknown aggregation.")
        count_rows = agg == "count" and (not column or (i == 0 and recipe.get("count_rows")))
        if not count_rows:
            if column not in df.columns:
                raise ValueError(f'Column "{column}" was not found in this data.')
            if agg in _MANUAL_AGG_NEEDS_NUMERIC and not pd.api.types.is_numeric_dtype(df[column]):
                raise ValueError(
                    f'"{column}" isn\'t a numeric column, so it can\'t be summed or averaged - '
                    "try Count, Min, or Max instead, or pick a numeric column."
                )
        measures.append({"alias": _recipe_alias(m.get("alias"), agg, column, taken), "agg": agg,
                         "column": None if count_rows else column})

    work = df
    chronological = False
    bucketed = _bucket_dates(df[group_cols[0]], recipe.get("time_grain"))
    if bucketed is not None:
        work = df.assign(**{group_cols[0]: bucketed})
        chronological = True
    grouped = work.groupby(group_cols, sort=True)
    series: dict[str, pd.Series] = {}
    for m in measures:
        if m["column"] is None:
            series[m["alias"]] = grouped.size()
        else:
            series[m["alias"]] = grouped[m["column"]].agg(_MANUAL_AGG_FUNCS[m["agg"]])
    frame = pd.DataFrame(series)
    frame.index.names = group_cols
    frame = frame.reset_index()
    frame = _recipe_order(frame, recipe, group_cols, measures[0]["alias"], chronological)

    single_category_axis = len(group_cols) == 1 and not chronological
    if block_type == "table":
        cap = _MAX_TABLE_ROWS_PER_BLOCK
    else:
        cap = 50 if single_category_axis else 2000
    try:
        wanted = int(recipe.get("limit")) if recipe.get("limit") else cap
    except (TypeError, ValueError):
        wanted = cap
    limit = max(1, min(cap, wanted))
    truncated = len(frame) > limit
    # A trend keeps its latest periods; anything else its first rows.
    frame = frame.tail(limit) if chronological and not recipe.get("order_by") else frame.head(limit)

    names = ", ".join(
        f"{_RECIPE_AGG_LABEL[m['agg']]} of {m['column']}" if m["column"] else "Count of rows" for m in measures
    )
    default_title = f"{names} by {', '.join(group_cols)}"
    tidy = chart_builder.result_to_tidy(frame)
    stored = {**recipe, "measures": measures, "group_by": group_cols}
    if block_type == "table":
        config = {
            "columns": [c["name"] for c in (tidy["columns"] if tidy else [])],
            "rows": tidy["rows"] if tidy else [],
            "truncated": truncated,
            "recipe": stored,
        }
        return "table", config, default_title

    ct = (recipe.get("chart_type") or ("line" if chronological else "bar")).lower().strip()
    config = {"recipe": stored, "chart_type": ct}
    if tidy:
        config["result_columns"] = tidy["columns"]
        config["result_rows"] = tidy["rows"]
    if chronological:
        bounds = _file_time_bounds(df[group_cols[0]])
        if bounds:
            config["time_bounds"] = bounds
    # A Plotly figure for the surfaces that still read one (exports, the
    # older canvas editor) - best effort; the dashboard draws from the rows.
    try:
        wide = None
        if len(group_cols) == 1:
            wide = frame.set_index(group_cols[0])
        elif len(group_cols) == 2 and len(measures) == 1:
            wide = frame.pivot_table(index=group_cols[0], columns=group_cols[1], values=measures[0]["alias"], aggfunc="sum")
        if wide is not None and not wide.empty:
            wide.index.name = group_cols[0]
            figure_type = ct if ct in ("line", "area", "stacked_bar", "grouped_bar", "stacked_area") else "grouped_bar"
            config["chart_spec"] = chart_builder.build_figure(wide, figure_type, title=existing_title or default_title)
    except Exception as e:
        print(f"[dashboard_builder] no Plotly figure for a multi-measure file chart (non-fatal): {e}")
    return "chart", config, default_title


def _kpi_trend(df: pd.DataFrame, recipe: dict, metric_column: str | None, agg_func: str, count_rows: bool) -> list | None:
    """The KPI's own number per period over `recipe["trend_column"]` (the
    dashboard's date column), oldest first - the tile's sparkline, the same
    line a warehouse KPI draws. None when there is no such column or it
    holds no dates."""
    column = recipe.get("trend_column")
    if not column or column not in df.columns:
        return None
    bucketed = _bucket_dates(df[column], recipe.get("trend_grain") or "month")
    if bucketed is None:
        return None
    grouped = df.groupby(bucketed, sort=True)
    values = grouped.size() if count_rows else grouped[metric_column].agg(agg_func)
    points = [_safe_float(v, None) if pd.notna(v) else None for v in values.tail(_KPI_SPARKLINE_MAX_POINTS).tolist()]
    points = [v for v in points if v is not None]
    return points if len(points) > 1 else None


def _run_histogram_recipe(df: pd.DataFrame, recipe: dict) -> tuple[str, dict, str]:
    """A histogram of one numeric column of a FILE - the same round bin
    edges a warehouse block gets (query_builder.histogram_edges, from the
    column's min / max / mean / standard deviation), the same result rows
    (one per bin, empty bins included, explicit under / overflow), counted
    with pandas because a file's data is complete inside the app."""
    bins = recipe.get("bins") or {}
    column = bins.get("column") or recipe.get("metric_column")
    if not column or column not in df.columns:
        raise ValueError(f'Column "{column}" was not found in this data.')
    values = pd.to_numeric(df[column], errors="coerce").dropna()
    if not pd.api.types.is_numeric_dtype(df[column]) or values.empty:
        raise ValueError(f'"{column}" isn\'t a numeric column, so it can\'t be drawn as a histogram.')
    try:
        count = int(bins.get("count") or query_builder.BIN_COUNT_DEFAULT)
    except (TypeError, ValueError):
        count = query_builder.BIN_COUNT_DEFAULT
    integer = bool(pd.api.types.is_integer_dtype(df[column]))
    stats = {"min": float(values.min()), "max": float(values.max()), "avg": float(values.mean()),
             "std": float(values.std()) if len(values) > 1 else 0.0, "n": int(len(values))}
    edges = query_builder.histogram_edges(stats, count, integer, bins.get("min"), bins.get("max"))
    n, start, width, end = edges["count"], edges["start"], edges["width"], edges["end"]
    arr = values.to_numpy(dtype=float)
    import numpy as _np
    idx = _np.where(arr < start, -1, _np.where(arr > end, n, _np.where(arr == end, n - 1, _np.floor((arr - start) / width).astype("int64"))))
    counts = pd.Series(idx).value_counts().to_dict()

    def edge(i: int):
        v = start + i * width
        return int(v) if integer else round(float(v), 10)

    rows: list[dict] = []
    if counts.get(-1):
        rows.append({column: None, "bin_end": edge(0), "bin": -1, "count": int(counts[-1])})
    for i in range(n):
        rows.append({column: edge(i), "bin_end": edge(i + 1), "bin": i, "count": int(counts.get(i, 0))})
    if counts.get(n):
        rows.append({column: edge(n), "bin_end": None, "bin": n, "count": int(counts[n])})
    default_title = f"Distribution of {column}"
    config = {
        "recipe": {**recipe, "block_type": "chart", "chart_type": "histogram", "bins": {"column": column, "count": count,
                   "min": bins.get("min"), "max": bins.get("max")}},
        "chart_type": "histogram",
        "result_columns": [{"name": column, "dtype": "number", "role": "dimension"}, {"name": "bin_end", "dtype": "number", "role": "dimension"},
                           {"name": "count", "dtype": "number", "role": "measure"}],
        "result_rows": rows,
        "bins": {"column": column, "start": start, "width": width, "count": n, "end": end, "integer": integer,
                 "underflow": bool(counts.get(-1)), "overflow": bool(counts.get(n)), "stats": stats},
    }
    return "chart", config, default_title


_MAP_ROW_CAP = 300


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

    if block_type not in ("kpi", "table", "chart", "gauge", "donut", "sparkline", "avatar_list"):
        raise ValueError("Unknown block type.")
    # 2026-10-07: several measures and/or several group-by columns (a
    # proposal's detail table, a trend split by segment) - see
    # _run_grouped_measures. Every other block type shows one measure over
    # one group-by and keeps the path below.
    if block_type == "chart" and isinstance(recipe.get("bins"), dict):
        return _run_histogram_recipe(df, recipe)
    if block_type in ("table", "chart") and (recipe.get("measures") or len(recipe.get("group_by") or []) > 1):
        return _run_grouped_measures(df, recipe, existing_title)

    if agg not in _MANUAL_AGG_FUNCS:
        raise ValueError("Unknown aggregation.")
    # `count_rows`: a count with no column of its own (a proposal's
    # "bookings") counts ROWS - never the non-null values of whichever
    # column happens to come first in the file.
    count_rows = agg == "count" and bool(recipe.get("count_rows"))
    if not count_rows:
        if metric_column not in df.columns:
            raise ValueError(f'Column "{metric_column}" was not found in this data.')
        if agg in _MANUAL_AGG_NEEDS_NUMERIC and not pd.api.types.is_numeric_dtype(df[metric_column]):
            raise ValueError(
                f'"{metric_column}" isn\'t a numeric column, so it can\'t be summed or averaged - '
                "try Count, Min, or Max instead, or pick a numeric column."
            )
    agg_func = _MANUAL_AGG_FUNCS[agg]
    agg_label = _RECIPE_AGG_LABEL[agg]
    measure_words = "Count of rows" if count_rows else f"{agg_label} of {metric_column}"
    # The result column the measure is written to: the proposal's alias
    # ("bookings") when the recipe carries one, else the source column's
    # own name (what a manually-built block has always used).
    value_name = metric_column
    if recipe.get("alias") and (not group_by_column or recipe["alias"] != group_by_column):
        value_name = re.sub(r"[^A-Za-z0-9_]+", "_", str(recipe["alias"])).strip("_") or metric_column
    if count_rows and not value_name:
        value_name = "rows"

    def _aggregate(grouped):
        return grouped.size() if count_rows else grouped[metric_column].agg(agg_func)

    if block_type in ("kpi", "gauge"):
        value = len(df) if count_rows else df[metric_column].agg(agg_func)
        # pandas .agg() returns a numpy scalar (e.g. numpy.float64), not a
        # plain Python number - .item() converts it, since neither the
        # JSON DB column nor the API response can serialize a numpy type
        # directly (this would otherwise 500 on commit).
        value = value.item() if hasattr(value, "item") else value
        default_title = measure_words
        shaped = _kpi_or_gauge_config(
            value, block_type, default_title, recipe, recipe.get("target_value"), recipe.get("max_value"),
        )
        if block_type == "kpi":
            # 2026-10-07: the tile's sparkline, when the dashboard has a
            # date column (recipe.trend_column) - recomputed with the
            # value on every filter change, like the value itself.
            try:
                trend = _kpi_trend(df, recipe, metric_column, agg_func, count_rows)
            except Exception as e:
                print(f"[dashboard_builder] KPI trend could not be computed (non-fatal): {e}")
                trend = None
            if trend:
                shaped[1]["sparkline"] = trend
                shaped[1]["sparkline_grain"] = str(recipe.get("trend_grain") or "month")
        return shaped

    if not group_by_column:
        raise ValueError("Pick a column to group by for a table, chart, donut, sparkline, or top list.")
    if group_by_column not in df.columns:
        raise ValueError(f'Column "{group_by_column}" was not found in this data.')

    # 2026-10-07: a recipe with a `time_grain` (a trend proposed over a date
    # column - see _spec_to_recipe) groups by the PERIOD each date falls
    # in, in time order, never by the raw dates ranked by value.
    group_key: Any = group_by_column
    chronological = False
    bucketed = _bucket_dates(df[group_by_column], recipe.get("time_grain"))
    if bucketed is not None:
        group_key = bucketed.rename(group_by_column)
        chronological = True
    # The measure's result column must not collide with the group column
    # ("count of Hotel by Hotel").
    if value_name == group_by_column:
        value_name = f"{agg}_{value_name}"

    if block_type == "sparkline":
        # Deliberately NOT value-sorted (unlike every other grouped branch
        # below) - a trend's whole point is order, not rank. pandas'
        # groupby default (sort=True) sorts by the group KEY itself, which
        # reads as chronological for a date/sequence group-by column.
        grouped = _aggregate(df.groupby(group_key, sort=True)).tail(30)
        grouped_df = grouped.reset_index()
        grouped_df.columns = [group_by_column, value_name]
        default_title = f"{measure_words} by {group_by_column}"
        series = [_safe_float(v, None) if pd.notna(v) else None for v in grouped_df[value_name].tolist()]
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

    row_cap = 8 if block_type == "avatar_list" else (50 if block_type in ("chart", "donut") else _MAX_TABLE_ROWS_PER_BLOCK)
    # 2026-10-07 (chart-types round): a map colours EVERY country, not the
    # 50 largest - asked for by name, or likely to be recommended (a
    # country-named column with the form left to GD360).
    wanted_chart = str(recipe.get("chart_type") or "").strip().lower()
    if block_type == "chart" and (wanted_chart in ("map", "choropleth") or (
            wanted_chart in ("", "auto") and chart_recommender.countries.looks_like_country_name(group_by_column))):
        row_cap = _MAP_ROW_CAP
    try:
        wanted = int(recipe.get("limit")) if recipe.get("limit") else row_cap
    except (TypeError, ValueError):
        wanted = row_cap
    limit = max(1, min(row_cap, wanted))
    # Named columns, not the generic "label"/"value" that
    # chart_builder.result_to_tidy would otherwise fall back to for a bare
    # Series - so a manually-built table's headers read as "region" /
    # "revenue", not "label" / "value".
    # (.rename first: counting a column grouped by itself - "bookings by
    # country" as a count of Country - would otherwise collide with the
    # index of the same name in reset_index.)
    if chronological:
        grouped_df = _aggregate(df.groupby(group_key, sort=True)).tail(max(row_cap, 120)).rename("__gd360_value__").reset_index()
        grouped_df.columns = [group_by_column, value_name]
    else:
        grouped_df = _aggregate(df.groupby(group_by_column)).rename("__gd360_value__").reset_index()
        grouped_df.columns = [group_by_column, value_name]
        # 2026-10-07: a recipe that came from a proposal keeps the order
        # and the row limit its spec asked for ("revenue by year", in year
        # order - not the three years ranked by revenue); a manually-built
        # block has neither and stays largest first.
        grouped_df = _recipe_order(grouped_df, recipe, [group_by_column], value_name, False).head(limit)
    default_title = f"{measure_words} by {group_by_column}"
    metric_column = value_name

    if block_type == "chart":
        ct = (chart_type or ("line" if chronological else "bar")).lower().strip()
        # 2026-10-07 (chart-types round): every form the native renderer
        # draws from rows is kept (map, treemap, funnel, waterfall, bullet
        # ...); the Plotly figure stored beside the rows - for the exports
        # that still read one - is the nearest form Plotly's builder has.
        ct = chart_recommender.normalize_chart_type(ct) or "bar"
        if ct not in chart_recommender.BLOCK_CHART_TYPES:
            ct = "bar"
        figure_type = ct if ct in _RESTYLE_CHART_TYPES else ("line" if chronological else "bar")
        chart_spec = chart_builder.build_figure(grouped_df, figure_type, title=existing_title or default_title)
        tidy = chart_builder.result_to_tidy(grouped_df)
        config = {"chart_spec": chart_spec, "recipe": recipe, "chart_type": ct}
        if tidy:
            config["result_columns"] = tidy["columns"]
            config["result_rows"] = tidy["rows"]
        if chronological:
            bounds = _file_time_bounds(df[group_by_column])
            if bounds:
                config["time_bounds"] = bounds
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
def _build_goal_plan_messages(
    goal: str, conversation_title: str, column_summary: str, table_names: list[str] | None = None
) -> list[dict]:
    # 2026-10-01 (multi-table build round, Gokul's own report, verbatim:
    # "i connected with mu bigquery data it has 2 files in it, so i told
    # to build dashboard it shows there are multiple files i cannot able
    # to create"): when the data source has more than one table,
    # column_summary (built by generate_dashboard below, straight from
    # ds.schema_cache - no data load needed) is grouped by table, and the
    # model is told to name which table each block needs, the same way it
    # already names each block's type/title/prompt. table_names is None
    # or empty for an ordinary single-table source, which keeps this
    # prompt byte-for-byte identical to before this round for every
    # dashboard built from a plain CSV/single-table database - no
    # regression for the common case.
    table_rule = (
        ' Every block MUST also name which ONE table it needs, in a "table" field, copied exactly '
        "from the table names given below - a block that needs data from more than one table is not "
        "possible here, so pick whichever single table best answers that block's question instead."
        if table_names
        else ""
    )
    schema_block_shape = (
        '{"page": "short page/tab name", "type": "kpi", "title": "short block title", '
        '"table": "exact table name", "prompt": "the exact question to ask"}'
        if table_names
        else '{"page": "short page/tab name", "type": "kpi", "title": "short block title", '
        '"prompt": "the exact question to ask"}'
    )
    system = (
        "You are planning a business dashboard from a plain-English description of what someone "
        "wants to see, against a specific dataset. You do not compute anything yourself - for each "
        "block you plan, you write ONE precise, self-contained analysis question that a separate "
        "data-analysis AI will run against the real data to produce that block's actual numbers or "
        "chart. Ground every question in the real column names you are given below - never invent a "
        "column that is not listed, and never ask a question the given columns cannot answer."
        + table_rule
        + " Rules: "
        "prefer 4 to 10 blocks total - too few is thin, too many is clutter. Group blocks into PAGES "
        'by topic (give each block a short "page" name like "Overview", "Demand forecast", "Profit", '
        '"Shipping" - blocks sharing a page name land together on their own tab) so related blocks sit '
        "together instead of every block crowding one page - a goal that only really covers one topic "
        'can just put every block on the same page name. A block whose question '
        'clearly produces one headline number should be type "kpi"; a question that compares or '
        'breaks a measure down by a category or over time should be type "chart"; anything better '
        'shown as a detailed list of rows should be type "table". Give the whole dashboard a short, '
        "specific title that reflects what was asked for. Return ONLY compact JSON, no prose, no "
        "markdown fences, in exactly this shape:\n"
        f'{{"dashboard_title": "short punchy title", "blocks": [{schema_block_shape}, ...]}}'
    )
    columns_label = "Available tables and columns in the data" if table_names else "Available columns in the data"
    user = (
        f"What they want this dashboard to show: {goal}\n\n"
        f"{columns_label}: {column_summary}\n\n"
        f'(For background only, not the source of truth: this dashboard is being built from a chat '
        f'analysis titled "{conversation_title}".)'
    )
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def _fallback_goal_plan(goal: str, table_names: list[str] | None = None) -> list[dict]:
    block: dict = {"type": "table", "title": (goal[:80] or "Overview").strip(), "prompt": goal, "page": "Overview"}
    # A multi-table source has no honest single-table default to fall back
    # to silently - pick the first table (same zero-ambiguity choice
    # default_table_for_preview already makes for the Data tab preview)
    # rather than raising, so a planning-call failure still produces SOME
    # buildable block instead of turning a multi-table source's every
    # failure path into a hard error again.
    if table_names:
        block["table"] = table_names[0]
    return [block]


def _generate_goal_plan(
    goal: str, conversation_title: str, column_summary: str, table_names: list[str] | None = None
) -> tuple[str, list[dict]]:
    fallback_title = (goal[:80] or "New dashboard").strip() or "New dashboard"
    fallback_blocks = _fallback_goal_plan(goal, table_names)
    try:
        # 2026-09-28: was a bare _call_llm_resilient(..., max_tokens=1200)
        # with no retry at all - real logs showed a detailed goal (naming
        # SARIMA/Prophet/LightGBM, which gives a reasoning model genuinely
        # more to work through) burning that whole 1200-token budget on
        # hidden reasoning and coming back empty, which silently fell all
        # the way through to fallback_blocks below (a single block asking
        # the ENTIRE raw goal verbatim - a much bigger ask than the model
        # had just failed at, at the default 3000-token budget instead of
        # 1200). ai_engine._plan_with_retry is the exact same "retry once
        # with a plain-language nudge before giving up" protection the
        # main chat's own plan call already relies on safely - reusing it
        # here, at that same 3000-token budget, gives this planning call
        # a real second chance instead of none.
        parsed = ai_engine._plan_with_retry(
            _build_goal_plan_messages(goal, conversation_title, column_summary, table_names), max_tokens=3000
        )
    except Exception as e:
        # Transient AI hiccup, missing/invalid key, still-malformed JSON
        # after ai_engine._plan_with_retry's own internal retry - degrade
        # to a single block asking the goal verbatim rather than failing
        # the whole "Build with AI" action. Logged (this used to be
        # completely silent) so a future failure here is diagnosable from
        # real logs instead of guessed at again.
        print(f"[dashboard_builder] goal-plan LLM call failed for goal={goal[:200]!r}: {e}")
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
        # 2026-09-28 (multi-page round): which tab/page this block belongs
        # on - see _build_goal_plan_messages above for the prompt asking
        # the model to group by topic. Missing/blank/non-string collapses
        # to a single "Overview" page, which is exactly the old (pre-this-
        # round) single-page behavior - so a plan that doesn't group by
        # page at all still builds a perfectly normal one-page dashboard.
        page_name = str(b.get("page") or "Overview").strip()[:60] or "Overview"
        block: dict = {"type": btype, "title": block_title, "prompt": prompt, "page": page_name}
        # 2026-10-01 (multi-table build round): a block's "table" only
        # means anything when this source actually has more than one -
        # table_names is None/empty for a plain single-table source, so
        # this whole branch is simply skipped and every block is
        # byte-for-byte what it always was. When it DOES apply: the
        # model's answer wins only if it's one of the real table names it
        # was given (never trust an invented one - same "ground it in
        # what was actually listed" discipline as every other field here);
        # anything missing or unrecognized falls back to the first table,
        # the same zero-ambiguity default default_table_for_preview
        # already uses for the Data tab, so a block is never silently
        # dropped just because the model left this field out.
        if table_names:
            block_table = str(b.get("table") or "").strip()
            block["table"] = block_table if block_table in table_names else table_names[0]
        blocks.append(block)

    return title, (blocks or fallback_blocks)


def _generate_plan(conversation_title: str, entries: list[dict]) -> tuple[str, list[dict]]:
    fallback_title = (conversation_title or "New dashboard").strip() or "New dashboard"
    fallback_blocks = _fallback_plan(entries)
    try:
        # 2026-09-28: same fix as _generate_goal_plan above - was a bare,
        # unprotected 1200-token call with no retry; now goes through
        # ai_engine._plan_with_retry at the same 3000-token budget the
        # main chat's plan call already uses safely, so a conversation
        # with many/complex turns gets a real second attempt instead of
        # silently degrading to the deterministic (still fine, just less
        # tailored) fallback on the very first hiccup.
        parsed = ai_engine._plan_with_retry(_build_plan_messages(conversation_title, entries), max_tokens=3000)
    except Exception as e:
        # Transient AI hiccup, missing/invalid key, still-malformed JSON
        # after the internal retry - any of these degrade to the
        # deterministic fallback rather than failing the whole "Build
        # with AI" action. Logged (previously silent) for the same reason
        # as _generate_goal_plan above.
        print(f"[dashboard_builder] rearrange-plan LLM call failed for conversation={conversation_title[:120]!r}: {e}")
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
    chart_spec), so the block never ends up empty.

    2026-09-29 (design revamp): also stamps config["ai_explanation"] from
    this message's own already-written `insight` (the same short,
    genuinely-computed finding the ORIGINAL flat dashboards.py view has
    long shown as "Insight: ..." under a chart - see DashboardView.tsx -
    and the live chat panel shows the same way). This is what makes the
    "explain this" icon actually show up on a bulk AI-generated dashboard's
    blocks, which _ai_result_to_block/_attach_ai_explanation (the OTHER
    block-shaping path, used by ask_ai_block/the goal-driven generate path)
    never touches, since a bulk-from-chat-history dashboard never calls
    that function at all - see this file's module docstring. Never
    fabricated or reworded here, exactly whatever ai_engine.analyze()
    wrote for that original chat turn, or simply omitted when that turn
    has no insight."""
    return _attach_block_config_explanation(message, _attach_block_config_lineage(message, _block_config_shape(message, requested_type)))


def _attach_block_config_explanation(message: models.Message, shaped: tuple[str, dict]) -> tuple[str, dict]:
    actual_type, config = shaped
    explanation = (message.insight or "").strip()
    if explanation:
        config = {**config, "ai_explanation": explanation}
    return actual_type, config


def _attach_block_config_lineage(message: models.Message, shaped: tuple[str, dict]) -> tuple[str, dict]:
    """2026-10-01 (lineage round): the bulk-from-chat-history dashboard
    path's own counterpart to _attach_source_lineage below (the AI-result
    path) - models.Message.code already exists (the real code that chat
    turn ran) and was simply never carried onto a block built from it
    until now. See _attach_source_lineage's own docstring for why the real
    code, verbatim, is the honest answer to "which columns/tables does
    this chart use" rather than a reconstructed guess."""
    actual_type, config = shaped
    code = (message.code or "").strip()
    if code and actual_type != "text":
        config = {**config, "source_code": code}
    return actual_type, config


def _block_config_shape(message: models.Message, requested_type: str) -> tuple[str, dict]:
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
            # 2026-10-07 (chart-integrity round): the figure copied onto a
            # dashboard passes the same audit as the one shown in chat - a
            # message stored before the audit existed can hold a figure
            # that contradicts its own rows; the block gets the figure
            # rebuilt from the rows instead (or, when the rows cannot be
            # drawn as that chart at all, the table below).
            checked, _reason, problems = chart_builder.checked_chart_spec(
                message.chart_spec, message.result_columns, message.result_rows, message.chart_type,
                context=f"message={message.id} (to dashboard)", truncated=bool(message.result_truncated),
            )
            if problems:
                config["chart_spec"] = checked
        if config["chart_spec"] is None:
            rows = (message.result_rows or [])[:_MAX_TABLE_ROWS_PER_BLOCK]
            return "table", {
                "columns": [c.get("name") for c in (message.result_columns or [])],
                "rows": rows,
                "truncated": len(message.result_rows or []) > _MAX_TABLE_ROWS_PER_BLOCK,
            }
        # 2026-10-01 (filter-engine fix round): message.chart_type already
        # exists (the real type this chat turn's chart was rendered as -
        # see models.Message's own chart_type column) and was simply never
        # carried onto the block before now. Stamping it here is what lets
        # preview_filtered_blocks rebuild this exact block correctly when a
        # page filter changes, instead of having to re-detect it from the
        # rendered spec (see _detect_restyle_chart_type's own docstring for
        # why that fallback can't always be trusted).
        if message.chart_type:
            config["chart_type"] = message.chart_type
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


# 2026-09-29 (design revamp): a freshly bulk-generated chart's own legend
# (chart_builder.py always turns one on for 2+ series - see chart_builder's
# closing update_layout) plus its title/axis-label bands genuinely need
# more than 6 grid rows (6 * ROW_UNIT_PX=48 ~= 288px of cell, minus the
# block card's own header bar and padding, was landing BELOW Plotly's own
# ~380px floor - see frontend lib/chartStyle.ts's suggestedChartMinHeight -
# so a bulk-generated chart routinely rendered with its bottom axis/ticks
# clipped off inside the card's overflow-hidden edge, exactly like Gokul's
# own screenshot of this dashboard showed. Bumped to 8 rows (~480px of
# cell) so the common case fits without anyone having to drag-resize it
# open first; see _default_block_size below for the matching bump on a
# block added one at a time after generation, and DashboardCanvas.tsx's
# BlockCard for the one-time auto-grow that still catches the rarer chart
# that needs even more room than this (a many-entry legend, a tilted axis).
_OTHER_ITEM_HEIGHT = 8


def _layout_blocks(kpi_items: list[dict], other_items: list[dict], y_offset: int = 0) -> list[dict]:
    """Deterministic 12-column grid placement - see this file's own module
    docstring for why this is never left to the AI. KPI tiles (3 columns
    wide) fill a row up to 4 across, then charts/tables (6 columns wide,
    2 across, _OTHER_ITEM_HEIGHT rows tall) fill the rows below.

    y_offset (2026-09-29, thought-leader filters round): how many grid
    rows to start below y=0 - every row this function itself computes is
    still relative to 0, then shifted down by this amount at the end. The
    one caller today passes _FILTER_ROW_HEIGHT here whenever
    _suggest_filter_columns found something to put in a real top-of-page
    filter row (see _layout_filter_row below) - leaving that row's own
    space untouched by this function's own KPI/chart math, and 0 (the
    default, unchanged from before this existed) for every dashboard with
    no auto-suggested filters."""
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
            y += _OTHER_ITEM_HEIGHT
        laid_out.append({**item, "x": x, "y": y, "w": 6, "h": _OTHER_ITEM_HEIGHT})
        x += 6

    if y_offset:
        laid_out = [{**item, "y": item["y"] + y_offset} for item in laid_out]
    return laid_out


# 2026-09-29 (thought-leader filters round): "we as a professional thought
# leaders to them when we build dashboard we should have build filters
# which they want to see... like hex how it gave... overall filter in
# top" - Gokul's own words.
#
# 2026-09-29 (round 5, real-bug fix): this was 2 rows (96px) until a
# direct report - "the filter options is merging with other boxes and
# also no proper alignment" - traced to real arithmetic, not a vague
# styling complaint. The Dashboard Builder's edit-mode card (BlockCard in
# DashboardCanvas.tsx) renders a filter block's header (~33px) PLUS its
# own column picker PLUS the value control stacked below it - unlike the
# live/Preview view, which only ever shows the compact value control
# alone (see DashboardBlocks.tsx's FilterControl and its own
# STACK_MIN_HEIGHT["filter"] = 88, tuned for exactly that one-control
# case). 33 + picker + control never fit in 96px, so the block's own
# `overflow-hidden` clipped it mid-control - the visual "merging" Gokul
# saw. 3 rows (144px) - still a full row shorter than a KPI tile's own 3
# rows would look if this used the *same* height, since a filter's
# column picker collapses to a single compact line once a column is set
# (see FilterColumnPicker's own comment in DashboardCanvas.tsx) - is the
# smallest bump that keeps header + collapsed picker + control clear of
# each other with real margin, not the bare minimum that just barely
# avoids clipping again the next time a column name runs long. Matches
# _default_block_size("filter") below, same as before.
_FILTER_ROW_HEIGHT = 3
_MAX_AUTO_FILTERS = 2


def _layout_filter_row(filter_items: list[dict]) -> list[dict]:
    """Lays out 1-2 auto-suggested filter blocks in their own dedicated
    row pinned at y=0, the actual top of the page - full width (12
    columns) split evenly across however many were suggested (see
    _suggest_filter_columns, capped at _MAX_AUTO_FILTERS) - the "overall
    filter in top" a professional BI build already has by default,
    instead of leaving a person to notice a filter option exists at all
    and add one by hand later. Every OTHER block on the page is laid out
    starting _FILTER_ROW_HEIGHT rows below this one (see _layout_blocks'
    own y_offset) so this row never overlaps anything."""
    n = len(filter_items)
    if n == 0:
        return []
    w = _GRID_COLUMNS // n
    return [{**item, "x": i * w, "y": 0, "w": w, "h": _FILTER_ROW_HEIGHT} for i, item in enumerate(filter_items)]


def _suggest_filter_columns(df: pd.DataFrame, max_filters: int = _MAX_AUTO_FILTERS) -> list[str]:
    """Picks up to `max_filters` genuinely useful columns to auto-add as
    top-of-page filter blocks when a dashboard is generated, instead of
    requiring a person to notice a filter is even possible and add one
    themselves via "+ Add block" afterward (they still can, for anything
    beyond these first one or two - see this function's own caller sites).

    _apply_filters/FilterControl (see their own docstrings) only support
    a single-select "equals" filter over a column's own distinct values -
    never a numeric/date RANGE - so a good candidate here is a column with
    a genuinely small, human-scannable number of distinct values (a
    region, category, status, year) - never a near-unique column (an id,
    a name, a raw timestamp, a free-text field), which would turn into an
    unusably long dropdown and isn't what a filter is for. This never
    fabricates a filter that doesn't fit what the mechanism actually
    supports today - it only ever picks real columns that are honestly
    good candidates for the one filter TYPE this app has.

    Ranked by ascending cardinality (fewest, most meaningful buckets
    first), so the single most useful slicer is suggested first when only
    one filter is being added."""
    n_rows = len(df)
    if n_rows == 0:
        return []
    candidates: list[tuple[int, str]] = []
    for col in df.columns:
        series = df[col]
        try:
            nunique = int(series.nunique(dropna=True))
        except TypeError:
            continue  # an unhashable column type (rare) can't be a dropdown filter at all
        # A genuinely useful slicer has more than one value to choose
        # between, but few enough to scan in a dropdown, and nowhere near
        # one-row-per-value (that's an id/name column, not a category) -
        # 40 is the same "low cardinality" ballpark this codebase already
        # treats as "grouping-worthy" elsewhere (see chart_builder.py).
        if nunique < 2 or nunique > 40:
            continue
        if nunique > max(20, n_rows * 0.5):
            continue  # still too close to one-per-row even under 40, on a small table
        candidates.append((nunique, col))
    candidates.sort(key=lambda t: t[0])
    return [col for _, col in candidates[:max_filters]]


def _filter_block_items(columns: list[str]) -> list[dict]:
    """The plain {type, title, config} shape _layout_filter_row/
    _layout_blocks both expect - config matches exactly what a person
    manually adding a filter block and picking a column from
    FilterColumnPicker would end up with (see _default_block_config's own
    "filter" case), so an auto-suggested filter behaves identically to a
    hand-added one in every other way (restyle, delete, and - the actual
    point - responding to preview_filtered_blocks) from this point on."""
    return [{"type": "filter", "title": col, "config": {"column": col}} for col in columns]


def _block_item_columns(item: dict) -> set[str]:
    """The real column names one goal-driven page ITEM's own AI-analyzed
    content actually touches, read from exactly the same config shapes
    _ai_result_to_block_shape already writes - never guessed or inferred
    from a title/prompt. A chart block carries config["result_columns"]
    (a list of {"name":..., "role":...} dicts - the same tidy-column
    shape ai_engine.analyze itself returns); a table block carries
    config["columns"] (a plain list of name strings) instead - different
    key, same underlying idea. KPI/gauge/donut/sparkline/avatar_list
    blocks carry neither (see preview_filtered_blocks' own docstring on
    exactly why a bare AI-built KPI has no tidy data left to filter by) -
    this correctly returns an empty set for one rather than pretending to
    know what column its single number came from."""
    config = item.get("config") or {}
    names = {c.get("name") for c in (config.get("result_columns") or []) if isinstance(c, dict) and c.get("name")}
    names.update(c for c in (config.get("columns") or []) if isinstance(c, str))
    return names


def _page_relevant_filter_columns(
    candidates: list[str], page_items: dict[str, list[dict]], max_filters: int = _MAX_AUTO_FILTERS
) -> list[str]:
    """2026-09-29 (per-page filter relevance round): real complaint -
    every page of a multi-page goal-driven dashboard showed the exact
    same auto-suggested filter pair (e.g. "Country/Region"/"Division"),
    even a page like "Product Affinity" whose charts have nothing to do
    with either column, because the old code computed one global filter
    pair from the whole dataset and reused it identically on every page
    (see this function's only caller, generate_dashboard's goal-driven
    branch). `candidates` is a WIDER pool of genuinely filter-worthy
    columns (still the same honest low/mid-cardinality heuristic as
    _suggest_filter_columns - this never widens what counts as a
    reasonable filter column, only how many are considered) - this picks
    the first `max_filters` of THOSE that some real chart/table block on
    THIS page actually references (via _block_item_columns), so a page
    gets filters that can actually move something on it. Falls back to
    the first `max_filters` global candidates only when this page has no
    usable signal at all (e.g. an all-KPI overview page, where no block
    carries column info to check against) - a page that could otherwise
    show a real, page-relevant filter is never left worse off than the
    old blanket behavior, only pages that can be precise now are."""
    used: set[str] = set()
    for item in page_items.get("kpi", []) + page_items.get("other", []):
        used |= _block_item_columns(item)
    relevant = [c for c in candidates if c in used]
    return relevant[:max_filters] if relevant else candidates[:max_filters]


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
    in as a kpi rather than erroring).

    2026-09-29 (design revamp): every real shape below (chart/kpi/table -
    not the final plain-text fallback, which already IS the narrative) also
    keeps analyze()'s own written explanation of what it found, under
    config["ai_explanation"], when one exists - never fabricated or
    reworded here, exactly whatever ai_engine.analyze() itself wrote for
    this turn, or simply omitted when it returned no narrative. This is
    what DashboardCanvas.tsx's BlockCard "Explain" affordance reads, so a
    person looking at a chart/number/table on their own dashboard can see
    the same plain-English read of it the AI already gave once, instead of
    having to re-ask."""
    return _attach_ai_explanation(result, _attach_source_lineage(result, _ai_result_to_block_shape(result, requested_type)))


def _attach_source_lineage(result: dict, shaped: tuple[str, dict]) -> tuple[str, dict]:
    """2026-10-01 (lineage round, Gokul's own report: "i cannot able to know
    how and which data columns are connect in this table... i want that
    detailing in chart i want to know how this chart formed and which
    column and tables connects"): persists the REAL pandas/python code
    ai_engine.analyze() actually ran to produce this block, verbatim and
    character-for-character, under config["source_code"] - never a guessed
    or reconstructed summary of "which columns were used" (that would risk
    showing something that isn't literally true - see this codebase's
    "never fabricate" rule). The real code already names every column and
    table it touches, so showing it IS the honest answer to "which columns
    connect" without this needing its own static-analysis pass that could
    get it wrong. Only attached to a real chart/kpi/table block - the
    plain-text fallback has no computed result to show code for.
    DashboardCanvas.tsx's new "How this was built" panel reads this."""
    actual_type, config = shaped
    code = (result.get("code") or "").strip()
    if code and actual_type != "text":
        config = {**config, "source_code": code}
    return actual_type, config


def _attach_ai_explanation(result: dict, shaped: tuple[str, dict]) -> tuple[str, dict]:
    actual_type, config = shaped
    # 2026-09-30 bug fix (Gokul's own report, verbatim: "it us onlu showing
    # data prep details not insights are there so oropel wont get
    # clarity"): this used to stamp ai_explanation straight from
    # result["narrative"], which on the prep+analyze path (the common case
    # for a chart/kpi block) is literally "**Data prep:** <what columns/
    # rows were kept>\n\n**Analysis:** <what was computed>" - a description
    # of the STEPS taken, never the actual finding. That is exactly why the
    # "Explain this chart" popover only ever showed data-prep detail.
    #
    # result["insight"] is the separate, already-generated "**Key
    # insight:** ..." finding that cites the real computed number(s) (see
    # _generate_insight/_fallback_insight) - the SAME field
    # _attach_block_config_explanation above already uses correctly for the
    # bulk-from-chat-history dashboard path. Prefer it here too, so both
    # block-shaping paths show the same kind of explanation, and fall back
    # to narrative only when a turn genuinely produced no insight (e.g. a
    # direct chat answer with no computed result) so a block is never left
    # with no explanation at all rather than a weaker one.
    explanation = (result.get("insight") or result.get("narrative") or "").strip()
    # The plain-text fallback's own {"text": narrative or "No result."} IS
    # the narrative already (see _ai_result_to_block_shape's own final
    # return) - stamping it a second time onto the same block as
    # ai_explanation would be pure duplication, so this only ever adds the
    # key for a real chart/kpi/table shape.
    if explanation and actual_type != "text":
        config = {**config, "ai_explanation": explanation}
    return actual_type, config


def _ai_result_to_block_shape(result: dict, requested_type: str) -> tuple[str, dict]:
    chart_spec = result.get("chart_spec")
    cols = result.get("result_columns") or []
    rows = result.get("result_rows") or []
    # 2026-10-01 (filter-engine fix round): ai_engine.analyze()'s result
    # already carries the real chart_type it built ("bar", "grouped_bar",
    # "faceted_bar", ...) - this was simply never copied onto the block
    # before now. See _detect_restyle_chart_type's docstring for exactly
    # what silently broke without it (a multi-series chart misread as a
    # plain single-series one on every filter change), and
    # preview_filtered_blocks for where this value is read back.
    chart_type = result.get("chart_type")

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
        if chart_type:
            config["chart_type"] = chart_type
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
        if chart_type:
            config["chart_type"] = chart_type
        return "chart", config
    if rows and len(rows) == 1:
        kpi = _kpi_from_rows()
        if kpi:
            return kpi
    table = _table_from_rows()
    if table:
        return table
    return "text", {"text": result.get("narrative") or "No result."}


# 2026-09-28 (Hex-parity round): a demand-forecast-style chart is exactly
# what set_block_analysis's manual "Show forecast" kebab-menu toggle
# already draws (chart_builder.apply_analysis_overlays - a real dashed
# projected line + shaded confidence band, computed honestly from the
# chart's own real y-values, never fabricated) - it was just never turned
# ON by default for a goal-driven block that is plainly ABOUT forecasting.
# This is a narrow, keyword-based nudge, not a new AI-output-shape
# requirement: it only fires for a chart block whose own title/prompt says
# "forecast"/"predict"/"projection", and it degrades completely safely
# (apply_analysis_overlays raises ValueError on any chart shape it can't
# honestly project from - not a line/area chart, or fewer than 4 real
# points - caught below and left as the plain, correct chart).
_FORECAST_KEYWORDS = ("forecast", "predict", "projection", "projected")


def _maybe_add_forecast_overlay(spec: dict, actual_type: str, config: dict) -> dict:
    if actual_type != "chart" or not config.get("chart_spec"):
        return config
    text = f"{spec.get('title', '')} {spec.get('prompt', '')}".lower()
    if not any(k in text for k in _FORECAST_KEYWORDS):
        return config
    # 2026-10-07 (chart-types round): a chart whose stored rows are a time
    # series gets the NATIVE forecast (services/forecast.py, drawn by the
    # dashboard's own renderer) - the option is stored, the numbers are
    # computed when the block is read. Only a chart with no such rows
    # still gets the old overlay drawn into its Plotly figure.
    layout = _file_series_layout(config)
    if layout is not None:
        return {**config, "forecast": {"horizon": forecast_svc.DEFAULT_HORIZON[layout["grain"]], "interval": "both", "anomalies": False},
                "chart_type": "line"}
    try:
        new_spec, _anomaly_count = chart_builder.apply_analysis_overlays(
            config["chart_spec"], forecast_enabled=True, anomalies_enabled=False
        )
    except ValueError:
        return config
    # Same shape set_block_analysis stores, so the block's own kebab-menu
    # "Show forecast" toggle correctly starts checked (see
    # DashboardCanvas.tsx's block.config?.forecast_enabled reads) instead
    # of the chart looking forecasted but the toggle disagreeing with it.
    return {**config, "chart_spec": new_spec, "forecast_enabled": True, "anomalies_enabled": False, "anomaly_count": None}


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
        return 3, _FILTER_ROW_HEIGHT
    # 2026-10-07 (analyst canvas round): a SQL cell reads best full-width
    # (the statement + a result preview); an input is one rail control.
    if block_type == "sql":
        return 12, 5
    if block_type == "input":
        return 3, _FILTER_ROW_HEIGHT
    # 2026-09-25 (Round 15, element library): "heading" reads best as a
    # short full-width banner above whatever follows it; "divider" only
    # ever needs to be a thin full-width rule, the shortest a block can be.
    if block_type == "heading":
        return 12, 2
    if block_type == "divider":
        return 12, 1
    # 2026-09-29 (design revamp): see _OTHER_ITEM_HEIGHT's own comment above
    # _layout_blocks - the same clipped-chart problem applies to a block
    # added one at a time via the "+ Add block" popover, so it gets the
    # same taller default.
    return 6, _OTHER_ITEM_HEIGHT  # chart / table / donut / avatar_list


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
    # 2026-10-07 (analyst canvas round) - see models.DashboardBlock.
    if block_type == "sql":
        return {"sql": "", "name": None, "parameters": []}
    if block_type == "input":
        return {"parameter_id": None}
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


# 2026-09-29 (design revamp): "just now i changed something and i cannot
# able to get that old version back" - a single-level undo. Called at the
# top of every one of the six endpoints that overwrite block.config
# (update_block, ask_ai_block, build_manual_block, restyle_block,
# set_block_accent_color, set_block_analysis), BEFORE they touch config,
# so block.previous_config always holds exactly what config was one change
# ago. Deliberately just one level (see models.DashboardBlock.
# previous_config's own docstring for why) - snapshotting again here on
# the very next change is what makes it "one step back," not a full
# history stack. A plain reference assignment (not a deep copy) is safe
# here specifically because every one of those six call sites always
# REPLACES config with a brand new dict (a wholesale reassignment or a
# `{**block.config, ...}` spread) rather than mutating the existing dict
# in place - so the old dict this snapshot points to is never touched
# again after this runs.
def _snapshot_block_config(block: models.DashboardBlock) -> None:
    block.previous_config = {"type": block.type, "config": block.config}


# 2026-10-07 (real end-to-end run): a block's title used to be written
# once - from the question it was first built with, or from its first
# query - and never again, so after "Change with AI" or "Edit query" the
# card still carried the OLD question as its name. config.title_auto marks
# a title GD360 wrote: while it is set, a new prompt / a new query writes
# the title again; the moment the person renames the block (update_block,
# or an explicit title on set_block_spec) the mark is removed and the
# title is theirs for good. A block whose title was typed is never touched.

def _title_is_auto(block: models.DashboardBlock) -> bool:
    return not block.title or bool((block.config or {}).get("title_auto"))


def _set_auto_title(block: models.DashboardBlock, title: str | None) -> None:
    """Writes a system-generated title and marks it (config.title_auto).
    Call AFTER block.config has been assigned its new value."""
    clean = (title or "").strip()[:120]
    if not clean:
        return
    block.title = clean
    block.config = {**(block.config or {}), "title_auto": True}


def _clear_auto_title(block: models.DashboardBlock) -> None:
    if (block.config or {}).get("title_auto") is not None:
        block.config = {k: v for k, v in (block.config or {}).items() if k != "title_auto"}


def _file_time_bounds(series: pd.Series) -> dict | None:
    """{"min", "max"} (ISO days) of a date column's real values - what a
    period bucket can be covered by (partial first / last period)."""
    try:
        as_dates = series if pd.api.types.is_datetime64_any_dtype(series) else pd.to_datetime(series, errors="coerce")
        as_dates = as_dates.dropna()
        if as_dates.empty:
            return None
        return {"min": as_dates.min().strftime("%Y-%m-%d"), "max": as_dates.max().strftime("%Y-%m-%d")}
    except Exception:
        return None


_ISO_DAY_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})")


def _infer_period_grain(values: list) -> str | None:
    """The grain a column of period starts is in, read off the dates (the
    frontend's fileData.inferGrain, same rules): every date a 1 January ->
    years; every date the 1st of a quarter's first month (three or more)
    -> quarters; every date a 1st -> months; dates whole weeks apart ->
    weeks; else days. None when a value is not an ISO date."""
    parts = []
    for v in values:
        if v is None or v == "":
            continue
        m = _ISO_DAY_RE.match(str(v))
        if not m:
            return None
        parts.append((int(m.group(1)), int(m.group(2)), int(m.group(3))))
    if len(parts) < 2:
        return None
    if all(d == 1 for _y, _m, d in parts):
        if all(m == 1 for _y, m, _d in parts):
            return "year"
        if len(parts) >= 3 and all((m - 1) % 3 == 0 for _y, m, _d in parts):
            return "quarter"
        return "month"
    from datetime import date as _date
    try:
        days = sorted({_date(y, m, d).toordinal() for y, m, d in parts})
    except ValueError:
        return None
    steps = [b - a for a, b in zip(days, days[1:])]
    if len(steps) >= 2 and all(step % 7 == 0 for step in steps):
        return "week"
    return "day"


def _file_series_layout(config) -> dict | None:
    """How a FILE chart block's stored rows form a time series:
    {"time", "series", "measures": [{alias, additive, rate}], "grain"} -
    from its recipe (a time_grain) or, for a chart nobody described (an
    AI answer), from a first column of ISO dates. None when the block is
    not a time series (or is a warehouse block)."""
    if not isinstance(config, dict) or isinstance(config.get("spec"), dict):
        return None
    rows = config.get("result_rows")
    cols = [c.get("name") for c in (config.get("result_columns") or []) if isinstance(c, dict)]
    if not isinstance(rows, list) or len(rows) < 2 or not cols:
        return None
    recipe = config.get("recipe") if isinstance(config.get("recipe"), dict) else None
    numeric = [c for c in cols if any(isinstance(r.get(c), (int, float)) and not isinstance(r.get(c), bool) for r in rows if isinstance(r, dict))]
    if recipe and recipe.get("time_grain") and not recipe.get("metric_id"):
        groups = [g for g in (recipe.get("group_by") or []) if g] or ([recipe["group_by_column"]] if recipe.get("group_by_column") else [])
        groups = [g for g in groups if g in cols]
        if not groups or len(groups) > 2:
            return None
        measure_cols = [c for c in cols if c not in groups]
        listed = [m for m in (recipe.get("measures") or []) if isinstance(m, dict)]
        aggs = {m.get("alias"): m.get("agg") for m in listed} if listed else {c: recipe.get("agg") for c in measure_cols}
        measures = [{"alias": c, "additive": str(aggs.get(c) or "sum") in ("sum", "count"), "rate": False} for c in measure_cols]
        grain = str(recipe["time_grain"])
        time_col, series_col = groups[0], (groups[1] if len(groups) > 1 else None)
    elif recipe is None:
        time_col = cols[0]
        grain = _infer_period_grain([r.get(time_col) for r in rows if isinstance(r, dict)])
        if grain is None:
            return None
        others = [c for c in cols[1:] if c not in numeric]
        if len(others) > 1:
            return None
        series_col = others[0] if others else None
        # An answer's aggregation is unknown: a missing period is a gap, not a zero.
        measures = [{"alias": c, "additive": False, "rate": False} for c in numeric if c != time_col]
    else:
        return None
    if not measures or grain not in forecast_svc.GRAINS:
        return None
    if series_col:
        measures = measures[:1]
    return {"time": time_col, "series": series_col, "measures": measures, "grain": grain}


def _decorate_file_time_series(block_type: str, config):
    """A FILE block's time series gets what a warehouse run adds to its
    result (services/dashboard_engine.attach_time_analysis): `partial`
    (buckets the data only partly covers) and, with config.forecast, the
    `forecast_result` + `anomalies` computed on its stored, aggregated
    rows. Computed when the block is read (cached by the rows' own
    fingerprint), never stored - so it can never go stale against the
    rows beside it. Any other block is returned untouched."""
    if block_type != "chart":
        return config
    layout = _file_series_layout(config)
    if layout is None:
        return config
    try:
        rows = [r for r in config["result_rows"] if isinstance(r, dict)]
        grain, time_col = layout["grain"], layout["time"]
        periods = sorted({str(r.get(time_col))[:10] for r in rows if r.get(time_col) is not None})
        partial = forecast_svc.partial_periods(periods, grain, config.get("time_bounds"), today=datetime.utcnow().date())
        out = dict(config)
        if partial.get("first") or partial.get("last"):
            out["partial"] = partial
        options = forecast_svc.normalize_options(config.get("forecast"), grain) if config.get("forecast") else None
        if options:
            key = forecast_svc.fingerprint("file", rows, layout, options, config.get("time_bounds"))
            cached = dashboard_engine._forecast_cache.get(key)
            if cached is None:
                clean = [{**r, time_col: str(r.get(time_col))[:10]} for r in rows if r.get(time_col) is not None]
                cached = forecast_svc.forecast_result(clean, time_col, layout["measures"], layout["series"], grain, options, partial=partial)
                dashboard_engine._forecast_cache.put(key, cached)
            out["forecast_result"] = cached
            out["anomalies"] = cached.get("anomalies") or []
        return out
    except Exception as e:
        print(f"[dashboard_builder] file time-series analysis skipped (non-fatal): {e}")
        return config


def _page_out(page: models.DashboardPage) -> schemas.DashboardPageOut:
    blocks = [
        schemas.DashboardBlockOut(
            id=b.id, type=b.type, title=b.title, x=b.x, y=b.y, w=b.w, h=b.h,
            config=_decorate_file_time_series(b.type, b.config), position=b.position, data_updated_at=b.data_updated_at,
            can_undo=b.previous_config is not None,
            query_sql=getattr(b, "query_sql", None), last_run=getattr(b, "last_run", None),
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
    # 2026-10-07 (dashboard-from-prompt round): a dashboard committed from
    # a proposal records its data source directly (models.Dashboard.
    # datasource_id) - no conversation needed. The conversation walk below
    # stays the fallback for every pre-existing row.
    direct_id = getattr(d, "datasource_id", None)
    if direct_id:
        ds = db.query(models.DataSource).filter(models.DataSource.id == direct_id).first()
        if ds:
            return ds
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


def _dashboards_for_conversation(
    db: Session, conversation_id: str, user: models.User, exclude_dashboard_id: str | None = None
) -> list[schemas.DashboardBuilderSummaryOut]:
    """Every real (layout_version==2), currently-viewable-by-this-user
    dashboard built from this one conversation ("Project") - shared by
    list_dashboards_for_conversation below (the chat side's "View
    Dashboards" menu) and _builder_out's own sibling_dashboards field (the
    dashboard side's "merge with other dashboards in the same project"
    picker), so the two surfaces can never quietly disagree about which
    dashboards belong to the same Project."""
    rows = (
        db.query(models.Dashboard)
        .filter(models.Dashboard.source_conversation_id == conversation_id, models.Dashboard.layout_version == 2)
        .order_by(models.Dashboard.created_at.desc())
        .all()
    )
    out: list[schemas.DashboardBuilderSummaryOut] = []
    for d in rows:
        if d.id == exclude_dashboard_id:
            continue
        # Same view-tier check _get_dashboard_v2 uses for a single
        # dashboard - a v2 row this person can no longer actually open
        # (e.g. shared into a workspace they've since left) is silently
        # left out rather than listed as a dead link.
        if not _can_view(db, d, user):
            continue
        share = d.share
        out.append(schemas.DashboardBuilderSummaryOut(
            id=d.id,
            name=d.name,
            created_at=d.created_at,
            page_count=len(d.pages),
            block_count=sum(len(p.blocks) for p in d.pages),
            can_edit=_can_edit(db, d, user),
            is_published=bool(share and share.published_at),
        ))
    return out


# ---------- 2026-10-07 (identity-colour round): appearance ----------
# services/appearance.py owns the document, its validation and the colour
# registry; these are the router's thin ends of it.

def _brand_workspace(db: Session, d: models.Dashboard, ds: models.DataSource | None = None) -> models.Workspace | None:
    """The workspace whose brand kit a dashboard follows: the one it is
    shared into, else its data source's, else its owner's personal one."""
    ws_id = d.workspace_id or (ds.workspace_id if ds is not None else None)
    ws = db.query(models.Workspace).filter(models.Workspace.id == ws_id).first() if ws_id else None
    if ws is None:
        ws = (
            db.query(models.Workspace)
            .filter(models.Workspace.owner_id == d.owner_id, models.Workspace.is_personal.is_(True))
            .first()
        )
    return ws


def _appearance_fields(db: Session, d: models.Dashboard, ds: models.DataSource | None, include_kit: bool = True) -> dict:
    """`appearance` (resolved) for a dashboard payload - plus, for the
    editor, the workspace kit it follows or would follow."""
    try:
        ws = _brand_workspace(db, d, ds)
        kit = appearance_svc.normalize_kit(ws.brand_kit, strict=False) if ws is not None and ws.brand_kit else None
        out = {
            "appearance": appearance_svc.effective_appearance(
                d.appearance, kit, brand_primary=d.brand_primary_color, brand_accent=d.brand_accent_color
            ),
        }
        if include_kit:
            out.update({
                "workspace_brand_kit": kit,
                "brand_workspace_id": ws.id if ws is not None else None,
                "brand_workspace_name": ws.name if ws is not None else None,
            })
        return out
    except Exception as e:  # an older database without the columns: defaults
        print(f"[dashboard_builder] appearance unavailable (non-fatal): {e}")
        return {"appearance": appearance_svc.effective_appearance(None, None)}


def _assign_stored_colors(db: Session, d: models.Dashboard) -> None:
    """Registers the values of every result a block stores on itself (a
    file dashboard's blocks, a pre-layer AI block). Canonical by
    construction - nothing of the request takes part - so it is safe on
    the public link too. Writes only when a value is new."""
    try:
        obs = appearance_svc.Observations()
        for page in sorted(d.pages, key=lambda p: p.position):
            for block in page.blocks:
                appearance_svc.observe_stored_block(obs, block.type, block.config)
        appearance_svc.assign_colors(db, d, obs)
    except Exception as e:  # colour must never stand between a viewer and the dashboard
        print(f"[dashboard_builder] stored colours not registered (non-fatal): {e}")


def _builder_out(db: Session, d: models.Dashboard, user: models.User) -> schemas.DashboardBuilderOut:
    pages = [_page_out(p) for p in sorted(d.pages, key=lambda p: p.position)]
    share = d.share
    ds = _dashboard_datasource(db, d)
    # 2026-09-29 (design revamp): "from which project this dashboard
    # created" + "merge with other dashboards in the same project" - see
    # DashboardBuilderOut's own field comments for exactly what each of
    # these three feeds. source_conv is looked up directly (not through
    # _resolve_datasource, which already 404-swallows a deleted source) so
    # a dashboard whose original conversation was since deleted just gets
    # None here rather than an error - the dashboard itself still renders
    # fine either way, it simply has nothing to link back to.
    source_conv = (
        db.query(models.Conversation).filter(models.Conversation.id == d.source_conversation_id).first()
        if d.source_conversation_id else None
    )
    sibling_dashboards = (
        _dashboards_for_conversation(db, d.source_conversation_id, user, exclude_dashboard_id=d.id)
        if d.source_conversation_id else []
    )
    return schemas.DashboardBuilderOut(
        id=d.id,
        name=d.name,
        layout_version=d.layout_version,
        created_at=d.created_at,
        source_conversation_id=d.source_conversation_id,
        source_conversation_title=source_conv.title if source_conv else None,
        # a Guided Analysis opens at /g/:id, so it carries no workspace source
        source_conversation_datasource_id=source_conv.datasource_id if source_conv and source_conv.kind != "guided" else None,
        # 2026-10-10 (one kind of dashboard): "Made from answer" vs "Made
        # from analysis" - which page the provenance chip opens.
        source_conversation_kind=(("answer" if source_conv.kind == "project" else "analysis") if source_conv else None),
        sibling_dashboards=sibling_dashboards,
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
        comment_counts=_comment_counts(db, d.id),
        **_appearance_fields(db, d, ds),
        **_warehouse_dashboard_fields(db, d, ds, include_tables=True),
    )


def _comment_counts(db: Session, dashboard_id: str) -> dict:
    """{block_id | "page:<id>" | "dashboard": {"open", "total"}} over
    every comment of the dashboard - one query; never raises (an older
    database without the table just yields {})."""
    try:
        from .dashboard_comments import comment_counts
        return comment_counts(db, dashboard_id)
    except Exception as e:
        print(f"[dashboard_builder] comment counts unavailable (non-fatal): {e}")
        return {}


# 2026-10-06 (warehouse-native dashboards layer): the dashboard-level
# definitions the redesigned view renders - filter rail, saved views,
# period, date column - plus the flags that tell the frontend which run
# path to use. Shared by _builder_out (editor) and _render_public_dashboard
# (published view) so both read the same truth. `tables` ({table:
# [{name, type}]}, real tables plus saved-query aliases) is only included
# for the editor: the public viewer never needs the schema.
def _warehouse_dashboard_fields(db: Session, d: models.Dashboard, ds: models.DataSource | None, include_tables: bool) -> dict:
    native = dashboard_engine.is_warehouse_native(ds)
    out = {
        "datasource_kind": ds.kind if ds else None,
        "warehouse_native": native,
        "parameters": list(d.parameters or []) if isinstance(d.parameters, list) else [],
        "saved_views": list(d.saved_views or []) if isinstance(d.saved_views, list) else [],
        "default_period": d.default_period,
        "date_column": d.date_column,
    }
    if include_tables:
        tables: dict = {}
        if native:
            versions = dashboard_engine.load_versions(db, ds)
            schema, _aliases = query_builder.with_version_aliases(ds.schema_cache, versions)
            tables = query_builder.builder_columns(schema, None)
        out["tables"] = tables
    return out


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

@router.get("", response_model=list[schemas.DashboardPickerOut])
def list_my_dashboards(db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    """2026-10-01 (chat-to-dashboard round): "in which dashboard, which
    page, i want to push" (Gokul's own words) - the picker behind
    PushToDashboardMenu.tsx's "Add to dashboard" action. Every real
    (layout_version==2) dashboard this person can at least see, scoped the
    exact same way GET /dashboards (routers/dashboards.py's own
    list_dashboards) already scopes its v1 listing - their own, plus
    anything shared into a workspace they belong to - so this never leaks
    a dashboard outside that boundary. Each entry carries just enough to
    drive a two-step dashboard-then-page picker (id/name plus its pages'
    id/name) - never the full pages/blocks/branding (see
    DashboardPickerOut's own docstring for why that's deliberate)."""
    ws_ids = workspace_access.member_workspace_ids(db, user.id)
    query = db.query(models.Dashboard).filter(models.Dashboard.layout_version == 2)
    if ws_ids:
        query = query.filter(
            or_(models.Dashboard.owner_id == user.id, models.Dashboard.workspace_id.in_(list(ws_ids)))
        )
    else:
        query = query.filter(models.Dashboard.owner_id == user.id)
    rows = query.order_by(models.Dashboard.created_at.desc()).all()
    out: list[schemas.DashboardPickerOut] = []
    for d in rows:
        if not _can_view(db, d, user):
            continue
        ds = _dashboard_datasource(db, d)
        out.append(schemas.DashboardPickerOut(
            id=d.id,
            name=d.name,
            can_edit=_can_edit(db, d, user),
            datasource_name=ds.name if ds else None,
            datasource_id=ds.id if ds else None,
            pages=[
                schemas.DashboardPickerPageOut(id=p.id, name=p.name)
                for p in sorted(d.pages, key=lambda p: p.position)
            ],
        ))
    return out


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
        # 2026-09-28 (datasource picker round): an explicit datasource_id
        # from BuildDashboardModal's picker always wins over the
        # conversation-derived guess below - real usage showed the guess
        # silently building from whatever data source happened to be
        # behind the currently-open chat, which is not necessarily the
        # one the person actually meant (e.g. a schema-catalog
        # conversation left open while they meant their real sales data).
        # Access is re-checked here exactly like _resolve_datasource does
        # for its own guess, so picking a data source from the dropdown
        # can never grant edit access to one the person doesn't already
        # have it on.
        requested_ds_id = (payload.datasource_id or "").strip()
        if requested_ds_id:
            ds = db.query(models.DataSource).filter(models.DataSource.id == requested_ds_id).first()
            if not ds:
                raise HTTPException(404, "That data source could not be found.")
            if not workspace_access.can_edit_datasource(db, ds, user):
                raise HTTPException(403, "You have view-only access to that data source.")
        else:
            # Same probe-object reuse _resolve_datasource is already built
            # for: it only ever reads d.source_conversation_id off
            # whatever's passed in, so a transient, never-added-to-the-
            # session Dashboard resolves the real data source without
            # persisting anything yet - every fallible step below (loading
            # the data, the planning call, every per-block analyze() call)
            # happens BEFORE any row is created, same zero-partial-write
            # discipline as the plain path.
            ds = _resolve_datasource(db, user, models.Dashboard(source_conversation_id=conv.id))

        # 2026-10-01 (multi-table build round, Gokul's own report,
        # verbatim: "i connected with mu bigquery data it has 2 files in
        # it, so i told to build dashboard it shows there are multiple
        # files i cannot able to create"): this used to always eagerly
        # load table=None up front - load_dataframe's own _pick_single
        # raises NeedsTableSelection for any source with more than one
        # table (a multi-table Postgres/MySQL/SQL Server/Supabase/Mongo/
        # BigQuery/Snowflake connection, or a multi-sheet Excel workbook),
        # which the bare except below turned into exactly the blunt
        # "Could not load this data source: Multiple tables/collections
        # available; please specify one." error he hit - with no way to
        # pick a table anywhere in this flow, so a multi-table source
        # could never build a goal-driven dashboard at all.
        #
        # default_table_for_preview(ds) is the same kind-agnostic,
        # zero-ambiguity check datasources.py's own Data tab preview
        # already uses to tell a genuinely multi-table source apart from
        # an ordinary single-table one - it returns the first table's name
        # for a multi-table source, None otherwise. For a multi-table
        # source, nothing is loaded here at all: ds.schema_cache already
        # has every table's real column names from connect time (see
        # connectors.py's own introspect_schema), so the goal-planning
        # call below can see every table up front with zero extra data
        # pulls, and ai_engine.analyze() per block still gets a real,
        # specific DataFrame - just loaded lazily, per block, by
        # _load_table_for_block further down, once the plan says which
        # table each block actually needs.
        # 2026-10-07 (dashboard-from-prompt round): a WAREHOUSE source never
        # loads a sample here any more - the goal goes through the same
        # propose -> commit path the Builder uses (one structured model
        # call, every block a validated BlockSpec computed inside the
        # warehouse), committed in one go with every valid block kept.
        if dashboard_engine.is_warehouse_native(ds):
            proposal = _build_proposal(db, user, ds, goal, conversation_id=conv.id)
            if proposal["valid_blocks"] == 0:
                reasons = [f'"{b["title"]}": {b["error"]}' for p in proposal["pages"] for b in p["blocks"] if b.get("error")]
                detail = (
                    "GD360 couldn't build anything from that description - try naming which numbers or "
                    "breakdowns matter most (e.g. \"revenue by region this quarter, and our top 5 "
                    "customers\"), then try again."
                )
                if reasons:
                    detail += " Specifically: " + "; ".join(reasons[:3])
                raise HTTPException(400, detail)
            dashboard = _commit_proposal(db, user, ds, proposal, None, None, "private", source_conversation_id=conv.id)
            return _builder_out(db, dashboard, user)

        table_names: list[str] = []
        original_df: pd.DataFrame | None = None
        if default_table_for_preview(ds) is not None:
            table_names = list((ds.schema_cache or {}).keys())
            column_summary = "; ".join(
                f'table "{t}": ' + ", ".join(
                    f"{c.get('name')} ({c.get('type') or 'unknown'})" for c in (ds.schema_cache.get(t) or [])[:40]
                )
                for t in table_names[:20]
            )
        else:
            try:
                original_df = load_dataframe(ds, table=None, version="original", db=db)
                original_df = data_access_rules.filter_dataframe_for_role(db, original_df, ds, user)
            except Exception as e:
                raise HTTPException(400, f"Could not load this data source: {e}")
            column_summary = ", ".join(f"{c} ({original_df[c].dtype})" for c in list(original_df.columns)[:60])

        title, block_specs = _generate_goal_plan(goal, conv.title, column_summary, table_names)

        # Per-block lazy table loading for a multi-table source - each
        # table is only ever loaded once per request even if several
        # blocks target it, and every load still goes through the exact
        # same access-rule filtering every other load in this app does.
        # For an ordinary single-table source, table_names is empty and
        # this is never consulted - block_original_df just reuses the one
        # original_df already loaded above, identical to before this round.
        _loaded_tables: dict[str, pd.DataFrame] = {}

        def _load_table_for_block(table_name: str | None) -> pd.DataFrame:
            key = table_name or "__default__"
            if key not in _loaded_tables:
                df = load_dataframe(ds, table=table_name, version="original", db=db)
                _loaded_tables[key] = data_access_rules.filter_dataframe_for_role(db, df, ds, user)
            return _loaded_tables[key]

        # 2026-09-28 (multi-page round): grouped by spec["page"] in
        # first-seen order rather than laid onto one shared "Overview"
        # page - see _build_goal_plan_messages/_generate_goal_plan above
        # for where that grouping comes from. A plan that never sets a
        # distinct page name collapses every block into "Overview" here,
        # so this is a strict superset of the old single-page behavior,
        # never a regression for a simple goal.
        page_order: list[str] = []
        page_items: dict[str, dict[str, list[dict]]] = {}
        # 2026-09-28: real production evidence (a goal like "aggregate by
        # month, region, or product" - genuinely open to three different
        # readings) showed every planned block getting silently dropped
        # here because analyze()'s own, correct-in-chat action="clarify"
        # rule fired for each one - there is no person in this loop to
        # answer a clarifying question, so unattended=True below tells the
        # model to commit to its best reasonable assumption and produce a
        # real result instead (see ai_engine._UNATTENDED_NOTE for exactly
        # what this changes). skipped_reasons is the defense-in-depth half
        # of the same fix: if a block is STILL skipped anyway (an
        # unhandled exception, or the model asking to clarify despite the
        # instruction above), keep the real reason instead of throwing it
        # away, so a total failure below can tell the person WHAT actually
        # went wrong on real blocks, not just a generic "couldn't build
        # anything" with no clue why.
        # Automatic cross-source context (2026-09-29 - see routers/chat.py's
        # identical mechanism, which this reuses): the same lightweight,
        # access-checked list of every OTHER data source this person has
        # connected - not just the one "Build with AI" resolved above -
        # so a planned block that needs a table outside this dashboard's
        # own data source (e.g. a goal naming "refund rate" when refunds
        # live in a separately-connected source) gets it automatically
        # instead of either being silently skipped (the old behavior: it
        # would fail/clarify and land in skipped_reasons) or the person
        # having to notice and manually switch which data source this
        # whole dashboard is built from.
        exclude_ids = {ds.id}
        catalog = _other_sources_catalog(db, user, exclude_ids)

        skipped_reasons: list[str] = []
        for position, spec in enumerate(block_specs):
            # Multi-table source: load (or reuse, if an earlier block
            # already needed it) exactly the one table this block's own
            # plan item named - see _load_table_for_block above. A
            # single-table source never reaches this branch at all
            # (table_names is empty), so block_original_df is just
            # original_df, unchanged from before this round.
            try:
                block_original_df = _load_table_for_block(spec.get("table")) if table_names else original_df
            except Exception as e:
                print(f"[dashboard_builder] could not load table {spec.get('table')!r} for block {spec['prompt']!r}: {e}")
                skipped_reasons.append(f'"{spec["title"]}": could not load table "{spec.get("table")}": {e}')
                continue
            try:
                result = ai_engine.analyze(
                    spec["prompt"], {"Original data": block_original_df}, history=[], guided=False,
                    skip_prep=False, original_df=block_original_df, unattended=True, catalog=catalog,
                )
            except Exception as e:
                print(f"[dashboard_builder] goal-driven block build failed for {spec['prompt']!r}: {e}")
                skipped_reasons.append(f'"{spec["title"]}": {e}')
                continue

            if result.get("action") == "needs_data" and result.get("needs_datasource_ids"):
                # See routers/chat.py's identical block for the full
                # reasoning - loads the named source(s) for real (through
                # the exact same "ds:" mechanism, so the same access
                # checks apply) and asks again, once, with it available.
                # `catalog` is not passed on this retry, so it cannot loop.
                extra_ids = [str(i) for i in result["needs_datasource_ids"] if i and str(i) not in exclude_ids]
                expanded = None
                if extra_ids:
                    try:
                        expanded = _load_selected_tables(
                            db, user, ds, ["original"] + [f"ds:{i}:original" for i in extra_ids]
                        )
                    except HTTPException as e:
                        print(
                            f"[dashboard_builder] could not auto-load {extra_ids} for block "
                            f"{spec['prompt']!r}: {e.detail}"
                        )
                if expanded:
                    block_tables = expanded[0]
                    try:
                        result = ai_engine.analyze(
                            spec["prompt"], block_tables, history=[], guided=False,
                            skip_prep=False, original_df=block_original_df, unattended=True,
                        )
                    except Exception as e:
                        print(f"[dashboard_builder] goal-driven block build failed after auto-loading data for {spec['prompt']!r}: {e}")
                        skipped_reasons.append(f'"{spec["title"]}": {e}')
                        continue

            if result.get("needs_clarification") or result.get("action") == "needs_data":
                question = result.get("clarifying_question") or "needed data that could not be found or loaded"
                print(
                    f"[dashboard_builder] goal-driven block asked to clarify despite unattended=True "
                    f"for {spec['prompt']!r}: {question}"
                )
                skipped_reasons.append(f'"{spec["title"]}": {question}')
                continue
            actual_type, config = _ai_result_to_block(result, spec["type"])
            # 2026-10-01 (lineage round): a multi-table source's own real
            # table name for this specific block - spec["table"] is the
            # exact, already-validated table _generate_goal_plan picked for
            # it (see that function's own table_names handling above), not
            # a guess. table_names is only non-empty for a multi-table
            # source at all (see this branch's own setup above), so a
            # single-table dashboard's blocks are completely unaffected -
            # that case is already honestly covered by the dashboard's own
            # datasource_name the frontend already has (DashboardBuilderOut
            # .datasource_name), with nothing per-block to add.
            if table_names and actual_type != "text":
                config = {**config, "source_table": spec.get("table")}
            # 2026-09-29 (design revamp): _ai_result_to_block's own fallback
            # cascade lands on a plain "text" block, carrying whatever
            # narrative analyze() wrote, only when this plan item didn't
            # resolve to a real chart/kpi/table - and that text IS still a
            # useful summary block when analyze() actually wrote one. But
            # when it did NOT (a genuinely empty/failed turn, where
            # _ai_result_to_block's own "No result." placeholder is the
            # only thing in it), keeping that block just plants an
            # unexplained blank "Note" on the dashboard - exactly what was
            # reported as always turning up on the last page with no
            # visible reason. Skip it the same way every other unbuildable
            # plan item in this loop is already skipped (append + continue)
            # instead of manufacturing a hollow placeholder block.
            # 2026-09-29 (leaked-failure-message fix): real production
            # evidence - a market-basket-analysis goal put a block titled
            # "Top Recommended Items for Best-Selling Products" onto a
            # live dashboard whose entire visible content was ai_engine's
            # own internal RETRY-EXHAUSTED failure message ("I was not
            # able to turn this into a chart the way you described, even
            # after trying a second approach...") - a real, non-empty
            # string, so the emptiness check above alone let it through.
            # These two constants are ai_engine's OWN, exact, literal
            # "nothing real happened" sentinels (see analyze()'s retry
            # loop and _no_result's own docstring) - never templated with
            # per-request text, so comparing for an exact match is precise
            # and can't accidentally catch a real narrative that merely
            # mentions "chart" or "approach".
            narrative_text = (result.get("narrative") or "").strip()
            is_failure_sentinel = narrative_text in (
                ai_engine._ANALYZE_FAILURE_NARRATIVE,
                ai_engine._TRANSFORM_FAILURE_NARRATIVE,
            )
            if actual_type == "text" and (not narrative_text or is_failure_sentinel):
                reason = "produced no result to show" if not narrative_text else "could not build this the way it was described, even after retrying"
                print(f"[dashboard_builder] goal-driven block produced no real result for {spec['prompt']!r}, skipping ({reason})")
                skipped_reasons.append(f'"{spec["title"]}": {reason}')
                continue
            # 2026-09-28 (Hex-parity round): a plainly forecast-labeled
            # chart block gets the real dashed-projection + confidence-
            # band overlay automatically - see _maybe_add_forecast_overlay
            # above for exactly when this does (and safely doesn't) apply.
            config = _maybe_add_forecast_overlay(spec, actual_type, config)
            page_name = spec.get("page") or "Overview"
            if page_name not in page_items:
                page_order.append(page_name)
                page_items[page_name] = {"kpi": [], "other": []}
            item = {"type": actual_type, "title": spec["title"], "config": config, "position": position}
            (page_items[page_name]["kpi"] if actual_type == "kpi" else page_items[page_name]["other"]).append(item)
            # 2026-09-29 (memory-safety round): real production evidence -
            # a "market-basket analysis" goal against a real, multi-item-
            # per-order dataset crashed the whole backend instance mid-
            # request (502 + instance restart, confirmed via Render's own
            # memory metrics: this box runs its ~400MB idle baseline out of
            # a hard 512MB container ceiling before this endpoint even
            # starts, per sandbox.py's own RLIMIT_AS comment on this same
            # instance). Each analyze() call above forks a new sandboxed
            # child process (see services/sandbox.py) that inherits this
            # PARENT process's current memory via copy-on-write - so a
            # multi-block goal (up to 10 planned blocks) that leaves large,
            # no-longer-needed objects (`result`'s cleaned_df/named_tables,
            # which can be full untruncated DataFrames - see
            # ai_engine.analyze's own docstring) referenced in this loop's
            # locals only grows what every SUBSEQUENT block's fork has to
            # inherit. Dropping the reference and forcing a collection here,
            # right after this block's real output (`item`) has already
            # been extracted from it, keeps the parent's own footprint from
            # ratcheting up block-over-block - it cannot fix a single
            # block's own sandboxed computation exceeding what's left of
            # the container's real RAM (that individual cap is
            # sandbox.py's job, not this loop's), but it removes THIS
            # loop's own contribution to the problem, which is the part
            # actually within this endpoint's control.
            del result
            gc.collect()

        if not page_order:
            detail = (
                "GD360 couldn't build anything from that description - try naming which numbers or "
                "breakdowns matter most (e.g. \"revenue by region this quarter, and our top 5 "
                "customers\"), then try again."
            )
            if skipped_reasons:
                # Show up to 3 real reasons rather than an unbounded list -
                # enough to actually explain what happened without turning
                # this modal's error box into a wall of text.
                detail += " Specifically: " + "; ".join(skipped_reasons[:3])
            raise HTTPException(400, detail)

        dashboard = models.Dashboard(owner_id=user.id, name=title, layout_version=2, source_conversation_id=conv.id)
        db.add(dashboard)
        db.flush()
        # 2026-09-29 (thought-leader filters round; widened in the
        # per-page filter relevance round the same day): a real live
        # dataframe (original_df) is already loaded above for this
        # goal-driven path - see _suggest_filter_columns' own docstring
        # for the honest, never-fabricated heuristic behind which
        # columns are even eligible. Computed once (best-effort - an odd
        # dtype that trips nunique() just means no filters get
        # suggested, never a failed dashboard build over this bonus
        # feature), but this is now a wider CANDIDATE POOL, not the
        # final pair - _page_relevant_filter_columns below picks each
        # page's own subset of it, so pages stop all showing the exact
        # same filters regardless of what they actually contain.
        # 2026-10-01 (multi-table build round): original_df is None for a
        # multi-table source (nothing was eagerly loaded - see above), so
        # this falls back to whichever real table a block actually ended
        # up using first (_loaded_tables is populated in the same
        # first-needed order the blocks above ran in) - still a real,
        # already-loaded dataframe, never a fabricated one, just not
        # necessarily every table's columns. A single-table source is
        # completely unaffected: original_df is already the right thing.
        filter_source_df = original_df if original_df is not None else next(iter(_loaded_tables.values()), None)
        try:
            filter_candidates = _suggest_filter_columns(filter_source_df, max_filters=8) if filter_source_df is not None else []
        except Exception as e:
            print(f"[dashboard_builder] filter suggestion skipped: {e}")
            filter_candidates = []
        for page_position, page_name in enumerate(page_order):
            page = models.DashboardPage(dashboard_id=dashboard.id, name=page_name, position=page_position)
            db.add(page)
            db.flush()
            items = page_items[page_name]
            page_filter_cols = _page_relevant_filter_columns(filter_candidates, items)
            filter_row = _layout_filter_row(_filter_block_items(page_filter_cols))
            laid_out = filter_row + _layout_blocks(
                items["kpi"], items["other"], y_offset=_FILTER_ROW_HEIGHT if filter_row else 0
            )
            for block_position, item in enumerate(laid_out):
                db.add(models.DashboardBlock(
                    page_id=page.id,
                    type=item["type"], title=item["title"],
                    x=item["x"], y=item["y"], w=item["w"], h=item["h"],
                    config=item["config"], position=block_position,
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

    # 2026-09-29 (thought-leader filters round): unlike the goal-driven
    # path above, this chat-history path never otherwise loads a live
    # dataframe at all (every block here is reshaped from already-stored
    # message data) - so a real one is loaded here specifically to look
    # for good filter candidates, best-effort: conv.datasource_id can be
    # null (a conversation predating datasources, or one whose source was
    # since deleted), and any load/access failure just means no filters
    # get suggested rather than a failed dashboard generation.
    suggested_filter_cols: list[str] = []
    if conv.datasource_id:
        try:
            hist_ds = db.query(models.DataSource).filter(models.DataSource.id == conv.datasource_id).first()
            # 2026-10-07: never for a warehouse/database source - its rows
            # are not loaded into the app, not even to suggest filters
            # (a warehouse dashboard's filters are its parameter rail).
            if hist_ds and not dashboard_engine.is_warehouse_native(hist_ds) \
                    and workspace_access.can_edit_datasource(db, hist_ds, user):
                hist_df = load_dataframe(hist_ds, table=None, version="original", db=db)
                hist_df = data_access_rules.filter_dataframe_for_role(db, hist_df, hist_ds, user)
                suggested_filter_cols = _suggest_filter_columns(hist_df)
        except Exception as e:
            print(f"[dashboard_builder] filter suggestion skipped: {e}")

    filter_row = _layout_filter_row(_filter_block_items(suggested_filter_cols))
    for filter_position, item in enumerate(filter_row):
        db.add(models.DashboardBlock(
            page_id=page.id,
            type=item["type"], title=item["title"],
            x=item["x"], y=item["y"], w=item["w"], h=item["h"],
            config=item["config"], position=filter_position,
        ))
    position_offset = len(filter_row)
    for item in _layout_blocks(kpi_items, other_items, y_offset=_FILTER_ROW_HEIGHT if filter_row else 0):
        db.add(models.DashboardBlock(
            page_id=page.id,
            type=item["type"],
            title=item["title"],
            x=item["x"], y=item["y"], w=item["w"], h=item["h"],
            config=item["config"],
            position=item["position"] + position_offset,
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
    name = (payload.name or "").strip()[:120] or "Untitled dashboard"
    if payload.conversation_id:
        conv = db.query(models.Conversation).filter(models.Conversation.id == payload.conversation_id).first()
        if not conv or not workspace_access.can_access_conversation(db, conv, user):
            raise HTTPException(404, "Conversation not found.")
        dashboard = models.Dashboard(
            owner_id=user.id,
            name=name,
            layout_version=2,
            source_conversation_id=conv.id,
        )
    elif payload.datasource_id:
        ds = _resolve_proposal_datasource(db, user, payload.datasource_id)
        dashboard = models.Dashboard(
            owner_id=user.id, name=name, layout_version=2, datasource_id=ds.id, default_period="month",
        )
    else:
        raise HTTPException(400, "Pick a data source for the new dashboard.")
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

    # 2026-09-29 (thought-leader filters round): same auto-suggested
    # top-of-page filter row generate_dashboard's own two paths get - see
    # _suggest_filter_columns' own docstring. A template's own blocks are
    # still blank stubs at this point (_default_block_config - nothing is
    # built yet), but the data source itself is already known, so there is
    # already a real, honest basis to suggest from. Best-effort exactly
    # like the chat-history path above: no data source, or a load/access
    # failure, just means no filters get suggested.
    suggested_filter_cols: list[str] = []
    tmpl_native = False
    if conv.datasource_id:
        try:
            tmpl_ds = db.query(models.DataSource).filter(models.DataSource.id == conv.datasource_id).first()
            # 2026-10-07: never for a warehouse/database source - its rows
            # are not loaded into the app, not even to suggest filters
            # (a warehouse dashboard's filters are its parameter rail).
            tmpl_native = dashboard_engine.is_warehouse_native(tmpl_ds)
            if tmpl_ds and not tmpl_native and workspace_access.can_edit_datasource(db, tmpl_ds, user):
                tmpl_df = load_dataframe(tmpl_ds, table=None, version="original", db=db)
                tmpl_df = data_access_rules.filter_dataframe_for_role(db, tmpl_df, tmpl_ds, user)
                suggested_filter_cols = _suggest_filter_columns(tmpl_df)
        except Exception as e:
            print(f"[dashboard_builder] filter suggestion skipped: {e}")

    for page_position, page_def in enumerate(template["pages"]):
        page = models.DashboardPage(dashboard_id=dashboard.id, name=page_def["name"], position=page_position)
        db.add(page)
        db.flush()
        filter_row = _layout_filter_row(_filter_block_items(suggested_filter_cols))
        y_shift = _FILTER_ROW_HEIGHT if filter_row else 0
        block_position = 0
        for item in filter_row:
            db.add(models.DashboardBlock(
                page_id=page.id,
                type=item["type"], title=item["title"],
                x=item["x"], y=item["y"], w=item["w"], h=item["h"],
                config=item["config"], position=block_position,
            ))
            block_position += 1
        for block_def in page_def["blocks"]:
            db.add(models.DashboardBlock(
                page_id=page.id,
                type=block_def["type"],
                title=block_def.get("title"),
                x=block_def["x"], y=block_def["y"] + y_shift, w=block_def["w"], h=block_def["h"],
                # A template's data block on a warehouse source is "empty,
                # not built yet" exactly like one create_block adds.
                config=(
                    {**_default_block_config(block_def["type"]), "empty": True}
                    if tmpl_native and block_def["type"] in _DATA_BLOCK_TYPES
                    else _default_block_config(block_def["type"])
                ),
                position=block_position,
            ))
            block_position += 1

    db.commit()
    db.refresh(dashboard)
    return _builder_out(db, dashboard, user)


# 2026-09-28 (senior-UX round): a real, specific gap Gokul flagged - once
# a dashboard was built from a chat analysis, there was no way back to it
# from that SAME chat. BuildDashboardModal navigates away to the new
# dashboard right after building it, but coming back to this conversation
# later (a new visit, a page refresh, a different chart in the same chat)
# left no trace it even happened - the only path back was leaving the
# chat entirely and hunting for it by name in the global Dashboards list.
# Workspace.tsx calls this once a conversation is loaded (and again any
# time it's revisited) so it can show a "View Dashboard(s)" entry point
# right next to "Build Dashboard" in the same header, instead of the
# dashboard silently vanishing from view the moment the build finishes.
# Deliberately its own small query rather than reusing generate_dashboard's
# any-Dashboard-with-this-source_conversation_id logic inline - see
# DashboardBuilderSummaryOut's own docstring for why this stays summary-only.
@router.get("/by-conversation/{conversation_id}", response_model=list[schemas.DashboardBuilderSummaryOut])
def list_dashboards_for_conversation(
    conversation_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)
):
    conv = db.query(models.Conversation).filter(models.Conversation.id == conversation_id).first()
    if not conv or not workspace_access.can_access_conversation(db, conv, user):
        raise HTTPException(404, "Conversation not found.")

    return _dashboards_for_conversation(db, conv.id, user)


# ---------- Dashboard from prompt (2026-10-07): propose / revise / commit ----------
#
# The Builder design: describe -> GD360 proposes typed blocks from the REAL
# schema + saved metrics -> the person keeps / swaps / removes -> publish.
# Nothing is created until commit; a proposal lives in an in-process cache
# for 30 minutes under a proposal_id the client carries between the three
# calls. Every proposed block is validated structurally (validate_block_
# spec, strict) and, for a warehouse source, dry-run inside the warehouse
# (zero rows, not billed) before it is shown; a block that fails is
# reported as "invalid" with the real reason, never silently repaired or
# dropped. No sample is ever loaded for a warehouse source - a file source
# (whose data is complete inside the app) gets a deterministic pandas
# recipe per block instead, computed at commit time by _run_manual_recipe.

_PROPOSAL_TTL_SECONDS = 1800
_PROPOSALS = dashboard_engine.TTLCache(_PROPOSAL_TTL_SECONDS, max_entries=256)
_PROPOSAL_TYPES = {"kpi", "chart", "table", "text", "sparkline", "donut"}
# Proposal block types whose chart form the recommender decides.
_PROPOSAL_CHARTED_TYPES = ("chart", "donut")
_PROPOSAL_MAX_BLOCKS = 12
_MAX_PROPOSAL_PARAMETERS = 4

_PROPOSE_TEMPLATES: list[dict] = [
    {
        "id": "executive_weekly", "name": "Executive weekly", "pages": 1, "period": "week",
        "description": "A one-page leadership snapshot: the headline numbers, the trend, the two breakdowns that explain it.",
        "goal": "A weekly executive summary for the leadership team: the four headline numbers with week-over-week change, "
                "the main trend over time, where the volume comes from (the two most important breakdowns), and a compact "
                "detail table.",
        "layout_hints": ["KPI row of 4 across the top", "one wide trend chart", "two breakdowns side by side", "one detail table"],
    },
    {
        "id": "operations_daily", "name": "Operations daily", "pages": 2, "period": "day",
        "description": "Today vs. yesterday at a glance, then the operational detail by team, status and region.",
        "goal": "A daily operations dashboard: page 1 is today's volume, completion/failure rates and backlog with day-over-day "
                "change and a daily trend; page 2 is the operational detail - counts by status, by owner/team and by region, "
                "and a table of the largest groups.",
        "layout_hints": ["page 1: KPIs + daily trend", "page 2: three breakdowns and a table", "status breakdown as a donut"],
    },
    {
        "id": "finance_monthly", "name": "Finance monthly", "pages": 1, "period": "month",
        "description": "Monthly revenue, cost and margin with the month-over-month movement and the category split.",
        "goal": "A monthly finance review: revenue, cost, margin and average value per record with month-over-month change, "
                "a monthly trend for revenue, the split by category/segment and by region, and a monthly detail table.",
        "layout_hints": ["KPI row", "monthly trend as an area chart", "category split as horizontal bars", "detail table by month and category"],
    },
]
_PROPOSE_TEMPLATES_BY_ID = {t["id"]: t for t in _PROPOSE_TEMPLATES}


def _metric_glossary(metrics: list) -> str:
    from ..services.metrics import describe_metric
    lines = []
    for m in metrics:
        try:
            lines.append("- " + describe_metric(m.name, m.metric_column, m.agg, m.filters or []))
        except Exception:
            lines.append(f'- "{m.name}" = {m.agg} of "{m.metric_column}"')
    return "\n".join(lines)


def _file_schema(db: Session, ds: models.DataSource, user: models.User) -> tuple[dict, pd.DataFrame | None]:
    """({table: [{name, type}]}, df) for a FILE source: the cached schema
    when it has one, else derived from the loaded data (which is complete
    inside the app for a file - never a sample of a warehouse)."""
    cache = ds.schema_cache or {}
    table_name = ds.name or "data"
    if isinstance(cache, dict) and cache.get("columns") and isinstance(cache["columns"], list):
        return {table_name: [{"name": c.get("name"), "type": c.get("type")} for c in cache["columns"] if c.get("name")]}, None
    if isinstance(cache, dict) and cache and all(isinstance(v, list) for v in cache.values()):
        return {str(k): [{"name": c.get("name"), "type": c.get("type")} for c in v if isinstance(c, dict)] for k, v in cache.items()}, None
    df = load_dataframe(ds, table=None, version="original", db=db)
    df = data_access_rules.filter_dataframe_for_role(db, df, ds, user)
    return {table_name: [{"name": str(c), "type": str(df[c].dtype)} for c in df.columns]}, df


def _spec_to_recipe(spec: dict) -> dict | None:
    """A validated BlockSpec as the recipe a FILE source's block runs
    through _run_manual_recipe (pandas, on the complete file): plain
    measures - sum / average / count / min / max of a column, or a count
    of rows - over up to three group-by columns, the first of which may be
    a date bucketed by the spec's time grain. None when the spec needs
    more than that (an expression, a filter, another aggregation).

    The legacy keys (metric_column / agg / group_by_column) always describe
    the FIRST measure over the FIRST group-by, so everything that reads a
    manual recipe keeps working; `measures` / `group_by` are only present
    when there is more than one of either (2026-10-07 - a proposed
    multi-measure table used to come back "invalid" on every CSV)."""
    measures = [m for m in (spec.get("measures") or []) if isinstance(m, dict)]
    if not measures or len(measures) > _MAX_RECIPE_MEASURES:
        return None
    if any(m.get("expr") or m.get("agg") not in _MANUAL_AGG_FUNCS for m in measures):
        return None
    if any(m.get("agg") != "count" and not m.get("column") for m in measures):
        return None
    if spec.get("filters"):
        return None
    group = list(spec.get("group_by") or [])
    time_col = (spec.get("time") or {}).get("column") if spec.get("time") else None
    if time_col:
        group = [time_col] + group
    if len(group) > _MAX_RECIPE_GROUP_BY:
        return None
    m = measures[0]
    recipe = {"metric_column": m.get("column"), "agg": m["agg"], "group_by_column": group[0] if group else None}
    if m.get("alias"):
        recipe["alias"] = m["alias"]
    if m["agg"] == "count" and not m.get("column"):
        recipe["count_rows"] = True
    if time_col:
        # 2026-10-07 (real end-to-end run): keep the trend's grain. Without
        # it "bookings by month" on a file became a group-by on every single
        # DATE, ranked by count - the fifty busiest days joined by a line.
        recipe["time_grain"] = (spec.get("time") or {}).get("grain") or "month"
    if len(measures) > 1 or len(group) > 1:
        recipe["measures"] = [{"alias": x.get("alias"), "agg": x["agg"], "column": x.get("column")} for x in measures]
        recipe["group_by"] = group
    order = [{"by": o.get("by"), "dir": o.get("dir") or "asc"} for o in (spec.get("order_by") or []) if isinstance(o, dict) and o.get("by")]
    if order:
        recipe["order_by"] = order
    if spec.get("limit") and group:
        recipe["limit"] = spec["limit"]
    return recipe


def _metric_to_spec(metric, table: str) -> dict:
    """A saved MetricDefinition as a single-row KPI BlockSpec on `table`
    (its filters translated through the same page-filter translation
    the rail uses)."""
    agg = metric.agg if metric.agg in query_builder.AGGS else "count"
    measure = {"alias": re.sub(r"[^A-Za-z0-9_]+", "_", metric.name).strip("_").lower() or "value", "agg": agg,
               "column": metric.metric_column if agg != "count" or metric.metric_column else None}
    filters = query_builder.page_filters_to_block_filters(metric.filters or [])
    return {"table": table, "measures": [measure], "filters": filters, "compare_prior_period": True, "sparkline": True}


def _layout_proposal_page(blocks: list[dict]) -> None:
    """Places a page's blocks on the 12-column grid in place: the KPI row
    first (3x3 tiles, 4 per row), then charts/donuts/sparklines in pairs
    (6x6), tables and text full width. 2026-10-07 (chart-types round): a
    map carries a ranked list - its row is two units taller (both cards,
    so the row stays even), and a map left alone in a row takes the whole
    width (the list then sits beside the map)."""
    y = 0
    x = 0
    kpis = [b for b in blocks if b["type"] in ("kpi", "sparkline")]
    others = [b for b in blocks if b["type"] not in ("kpi", "sparkline")]
    for b in kpis:
        if x + 3 > _GRID_COLUMNS:
            x, y = 0, y + 3
        b["layout"] = {"x": x, "y": y, "w": 3, "h": 3}
        x += 3
    if kpis:
        y += 3
    x = 0
    row_h = 0
    row: list[dict] = []

    def close_row() -> None:
        if len(row) == 1 and row[0].get("chart_type") == "map":
            row[0]["layout"]["w"] = _GRID_COLUMNS

    for b in others:
        if b["type"] in ("table", "text"):
            if x:
                close_row()
                x, y = 0, y + row_h
                row_h = 0
                row = []
            h = 2 if b["type"] == "text" else 6
            b["layout"] = {"x": 0, "y": y, "w": 12, "h": h}
            y += h
            continue
        if x + 6 > _GRID_COLUMNS:
            close_row()
            x, y = 0, y + row_h
            row_h = 0
            row = []
        b["layout"] = {"x": x, "y": y, "w": 6, "h": 6}
        row.append(b)
        if any(r.get("chart_type") == "map" for r in row):
            for r in row:
                r["layout"]["h"] = 8
            row_h = 8
        else:
            row_h = 6
        x += 6
    close_row()
    for b in blocks:
        b.setdefault("layout", {"x": 0, "y": y, "w": 6, "h": 6})


def _fallback_proposal(goal: str, schema: dict, period: str) -> dict:
    """A deterministic proposal from the schema alone, used only when the
    model call failed outright: count KPI, a trend on the first date
    column, breakdowns on the first text columns, a table. Honestly
    labelled by the caller (ProposalOut.warning)."""
    table = next(iter(schema.keys()), None)
    if not table:
        return {"title": "New dashboard", "pages": [{"title": "Overview", "blocks": []}], "suggestions": []}
    cols = query_builder.table_columns(schema, table) or []
    date_col = next((c["name"] for c in cols if any(k in str(c.get("type") or "").lower() for k in ("date", "time"))), None)
    text_cols = [c["name"] for c in cols if any(k in str(c.get("type") or "").lower() for k in ("string", "object", "text", "char", "category"))][:2]
    num_cols = [c["name"] for c in cols if any(k in str(c.get("type") or "").lower() for k in ("int", "float", "numeric", "decimal", "double"))][:2]
    blocks = [{"type": "kpi", "title": "Rows", "intent": "KPI · count", "spec": {
        "table": table, "measures": [{"alias": "rows", "agg": "count"}], "compare_prior_period": True, "sparkline": True}}]
    for n in num_cols:
        blocks.append({"type": "kpi", "title": f"Total {n}", "intent": f"KPI · sum of {n}", "spec": {
            "table": table, "measures": [{"alias": f"sum_{n}", "agg": "sum", "column": n}], "compare_prior_period": True, "sparkline": True}})
    if date_col:
        blocks.append({"type": "chart", "title": f"Rows by {period}", "intent": f"Trend · rows by {period}", "chart_type": "line",
                       "spec": {"table": table, "time": {"column": date_col, "grain": period}, "measures": [{"alias": "rows", "agg": "count"}],
                                "order_by": [{"by": "period", "dir": "asc"}], "limit": 500}})
    for t in text_cols:
        blocks.append({"type": "chart", "title": f"Rows by {t}", "intent": f"Breakdown · {t}", "chart_type": "horizontal_bar",
                       "spec": {"table": table, "group_by": [t], "measures": [{"alias": "rows", "agg": "count"}],
                                "order_by": [{"by": "rows", "dir": "desc"}], "limit": 15}})
    if text_cols:
        blocks.append({"type": "table", "title": "Detail", "intent": "Table · detail", "spec": {
            "table": table, "group_by": text_cols, "measures": [{"alias": "rows", "agg": "count"}] + [{"alias": f"sum_{n}", "agg": "sum", "column": n} for n in num_cols[:1]],
            "order_by": [{"by": "rows", "dir": "desc"}], "limit": 100}})
    return {"title": (goal or "New dashboard")[:80], "date_column": date_col, "pages": [{"title": "Overview", "blocks": blocks}],
            "parameters": text_cols, "suggestions": []}


def _build_proposal(
    db: Session, user: models.User, ds: models.DataSource, goal: str, pages="auto", period: str | None = None,
    template: dict | None = None, conversation_id: str | None = None, current: dict | None = None,
    instruction: str | None = None,
) -> dict:
    """The proposal dict _PROPOSALS stores and ProposalOut is built from.
    ONE model call (ai_engine.propose_dashboard), then every block is
    validated for real - see the section comment above."""
    started = time.perf_counter()
    native = dashboard_engine.is_warehouse_native(ds)
    period = dashboard_engine.normalize_period(period, template.get("period") if template else None)
    versions = dashboard_engine.load_versions(db, ds) if native else []
    file_df = None
    file_df_failed = False
    if native:
        schema, _ = query_builder.with_version_aliases(ds.schema_cache, versions)
        schema_text = _warehouse_schema_text(ds, None, versions)
    else:
        schema, file_df = _file_schema(db, ds, user)
        schema_text = "\n".join(
            f"Table `{t}`:\n" + "\n".join(f"  - {c.get('name')} ({c.get('type')})" for c in cols)
            for t, cols in schema.items()
        )
    metrics = db.query(models.MetricDefinition).filter(models.MetricDefinition.datasource_id == ds.id).all()
    metrics_by_name = {m.name.strip().lower(): m for m in metrics}

    effective_goal = goal.strip()
    if template and not effective_goal:
        effective_goal = template["goal"]
    if template:
        pages = template.get("pages") or pages
    raw = ai_engine.propose_dashboard(
        effective_goal, schema_text, _metric_glossary(metrics), ds.kind, pages=pages, period=period,
        template=template, current_proposal=current, instruction=instruction,
    )
    warning = None
    if not isinstance(raw, dict) or not isinstance(raw.get("pages"), list):
        if current and instruction:
            raw = current
            warning = "The model could not apply that instruction - the proposal is unchanged."
        else:
            raw = _fallback_proposal(effective_goal, schema, period)
            warning = "The model did not answer, so this is a plain starting point built from the schema alone - revise it or describe the goal again."

    primary_table = next(iter(schema.keys()), None)
    date_column = raw.get("date_column") if isinstance(raw.get("date_column"), str) else None
    if date_column and not any(c["name"] == date_column for t in schema for c in (query_builder.table_columns(schema, t) or [])):
        date_column = None

    used_metrics: list[str] = []
    used_columns: list[str] = []
    used_tables: list[str] = []
    out_pages: list[dict] = []
    proposed = valid = 0
    counter = 0
    mentioned_metrics = [m for m in metrics if m.name.strip().lower() in effective_goal.lower()]
    metric_blocks_seen: set[str] = set()
    raw_pages = [p for p in raw.get("pages") if isinstance(p, dict)]
    if pages in (1, "1") and len(raw_pages) > 1:
        merged = {"title": raw_pages[0].get("title") or "Overview", "blocks": [b for p in raw_pages for b in (p.get("blocks") or [])]}
        raw_pages = [merged]
    for pi, page in enumerate(raw_pages[:2]):
        blocks_out: list[dict] = []
        raw_blocks = [b for b in (page.get("blocks") or []) if isinstance(b, dict)]
        # Saved metrics named in the goal that the model did not already
        # turn into a KPI get one, in front of the KPI row (first page).
        if pi == 0 and mentioned_metrics:
            named = {str(b.get("from_metric") or "").strip().lower() for b in raw_blocks}
            for m in mentioned_metrics:
                if m.name.strip().lower() not in named and primary_table:
                    raw_blocks.insert(0, {"type": "kpi", "title": m.name, "intent": f"KPI · {m.name} metric",
                                          "from_metric": m.name, "spec": _metric_to_spec(m, primary_table)})
        for rb in raw_blocks[:_PROPOSAL_MAX_BLOCKS]:
            counter += 1
            proposed += 1
            btype = str(rb.get("type") or "chart").lower()
            if btype not in _PROPOSAL_TYPES:
                btype = "chart"
            title = str(rb.get("title") or "").strip()[:120] or f"Block {counter}"
            intent = str(rb.get("intent") or "").strip()[:80] or (
                "KPI" if btype == "kpi" else "Table · detail" if btype == "table" else "Chart")
            block = {
                "client_id": f"b{counter}", "type": btype, "title": title, "intent": intent, "spec": None, "recipe": None,
                "chart_type": rb.get("chart_type") if isinstance(rb.get("chart_type"), str) else None,
                "text": None, "from_metric_id": None, "from_metric_name": None, "status": "ok", "error": None,
                "sql": None, "columns": [],
            }
            if btype == "text":
                block["text"] = str(rb.get("text") or "").strip()[:2000] or title
                blocks_out.append(block)
                valid += 1
                continue
            spec = rb.get("spec")
            metric_name = str(rb.get("from_metric") or "").strip().lower()
            metric = metrics_by_name.get(metric_name) if metric_name else None
            if metric is not None:
                block["from_metric_id"] = metric.id
                block["from_metric_name"] = metric.name
                if metric.name not in used_metrics:
                    used_metrics.append(metric.name)
                if not isinstance(spec, dict) and primary_table:
                    spec = _metric_to_spec(metric, primary_table)
                metric_blocks_seen.add(metric.id)
            if not isinstance(spec, dict):
                block["status"], block["error"] = "invalid", "The model gave this block no query spec."
                blocks_out.append(block)
                continue
            try:
                normalised = query_builder.validate_block_spec(spec, schema, strict=True)
                public = query_builder.public_spec(normalised)
            except query_builder.QueryBuilderError as e:
                block["status"], block["error"], block["spec"] = "invalid", str(e), spec
                blocks_out.append(block)
                continue
            block["spec"] = public
            if btype == "kpi" and (public.get("group_by") or public.get("time")):
                block["type"] = "chart" if public.get("time") else "table"
            # 2026-10-07 (chart-types round): the chart form is decided by
            # the ONE deterministic recommender - the model's chart_type is
            # a suggestion it validates (and replaces, with a log line,
            # when the block's shape calls for something else: a country
            # column is a map, two dimensions a heatmap, ...). A file block
            # keeps the forms its recipe path draws.
            if block["type"] in _PROPOSAL_CHARTED_TYPES:
                choice = _choose_chart(_spec_shape(ds if native else None, schema, public), block["chart_type"], False,
                                       f"proposal block {block['client_id']}")
                if choice["block_type"] in _PROPOSAL_CHARTED_TYPES:
                    block["type"] = choice["block_type"]
                    block["chart_type"] = None if choice["block_type"] == "donut" else choice["chart_type"]
                elif choice["block_type"] == "table" and native:
                    block["type"], block["chart_type"] = "table", None
                else:
                    block["chart_type"] = chart_recommender.normalize_chart_type(block["chart_type"]) or ("line" if public.get("time") else "bar")
                block["chart_reason"] = choice["reason"]
                if block["chart_type"] == "map":
                    public = _map_ready_spec(public)
                    block["spec"] = public
                if public.get("time") and _wants_forecast(title, intent, rb.get("chart_type")):
                    block["forecast"] = _default_forecast_options(period)
            if native:
                check = dashboard_engine.validate_spec_in_warehouse(ds, public, versions, date_column=date_column)
                if not check["ok"]:
                    block["status"], block["error"] = "invalid", f"The warehouse rejected this block's query: {check['error']}"
                    blocks_out.append(block)
                    continue
                block["sql"], block["columns"] = check["sql"], check["columns"]
            else:
                recipe = _spec_to_recipe(public)
                if recipe is None:
                    block["status"], block["error"] = "invalid", (
                        "A block on a file needs plain measures (sum, average, count, min or max of a column), at most "
                        f"{_MAX_RECIPE_GROUP_BY} group-by columns, and no filters or expressions."
                    )
                    blocks_out.append(block)
                    continue
                recipe["block_type"] = "kpi" if block["type"] == "kpi" else block["type"]
                if block["type"] == "chart":
                    recipe["chart_type"] = block["chart_type"] or ("line" if public.get("time") else "bar")
                elif block["type"] == "donut":
                    recipe["block_type"] = "donut"
                if recipe["agg"] == "count" and not recipe.get("metric_column"):
                    recipe["metric_column"] = (query_builder.table_columns(schema, public["table"]) or [{}])[0].get("name")
                # 2026-10-07: validated for real, like a warehouse block's
                # zero-row check - the recipe is computed once on the file's
                # own rows (complete inside the app), so a block that cannot
                # be computed says why HERE instead of silently missing from
                # the published dashboard.
                if file_df is None and not file_df_failed:
                    try:
                        file_df = load_dataframe(ds, table=None, version="original", db=db)
                        file_df = data_access_rules.filter_dataframe_for_role(db, file_df, ds, user)
                    except Exception as e:
                        print(f"[dashboard_builder] proposal: the file could not be loaded to check its blocks (non-fatal): {e}")
                        file_df, file_df_failed = None, True
                if file_df is not None:
                    try:
                        _run_manual_recipe(file_df, dict(recipe), existing_title=title)
                    except ValueError as e:
                        block["status"], block["error"] = "invalid", str(e)
                        blocks_out.append(block)
                        continue
                    except Exception as e:
                        block["status"], block["error"] = "invalid", f"This block could not be computed on the file: {e}"
                        blocks_out.append(block)
                        continue
                block["recipe"] = recipe
            if block["type"] == "chart" and not block["chart_type"]:
                block["chart_type"] = "line" if public.get("time") else "bar"
            if not date_column and public.get("time"):
                date_column = public["time"]["column"]
            valid += 1
            if public["table"] not in used_tables:
                used_tables.append(public["table"])
            for col in list(public.get("group_by") or []) + [m.get("column") for m in public.get("measures") or [] if m.get("column")] + ([public["time"]["column"]] if public.get("time") else []):
                if col and col not in used_columns:
                    used_columns.append(col)
            blocks_out.append(block)
        _layout_proposal_page(blocks_out)
        out_pages.append({"title": str(page.get("title") or ("Overview" if pi == 0 else f"Page {pi + 1}"))[:80], "blocks": blocks_out})
    if not out_pages:
        out_pages = [{"title": "Overview", "blocks": []}]

    # Parameters the commit will create: the model's suggestions that are
    # real text columns the kept blocks group by, else the group-by text
    # columns themselves (max 4), plus a date_range on the date column.
    text_types = ("string", "object", "text", "char", "category", "varchar")
    group_cols: list[str] = []
    for page in out_pages:
        for b in page["blocks"]:
            if b["status"] == "ok" and b.get("spec"):
                for g in b["spec"].get("group_by") or []:
                    if g not in group_cols:
                        group_cols.append(g)

    def _is_text(col: str) -> bool:
        for t in schema:
            for c in query_builder.table_columns(schema, t) or []:
                if c["name"] == col:
                    return any(k in str(c.get("type") or "").lower() for k in text_types)
        return False

    suggested = [c for c in (raw.get("parameters") or []) if isinstance(c, str) and c in group_cols and _is_text(c)]
    for c in group_cols:
        if c not in suggested and _is_text(c):
            suggested.append(c)
    parameters: list[dict] = []
    for c in suggested[:_MAX_PROPOSAL_PARAMETERS]:
        parameters.append({"id": f"p_{re.sub(r'[^A-Za-z0-9_]+', '_', c).strip('_').lower()[:24]}", "name": dashboard_engine.parameter_name({"column": c}),
                           "column": c, "label": c.replace("_", " ").title()[:80], "control": "chips", "options_from": "distinct",
                           "default": None, "table": None})
    if date_column:
        parameters.append({"id": "p_date_range", "name": "date_range", "column": date_column, "label": "Date range",
                           "control": "date_range", "options_from": None, "default": None, "table": None})
    # 2026-10-10 (cross-table filters): a filter whose column is not in the
    # main table records the table that has it, so its options load.
    for prm in parameters:
        col = prm.get("column")
        if prm.get("table") or not col or not primary_table:
            continue
        if not any(c["name"] == col for c in (query_builder.table_columns(schema, primary_table) or [])):
            holders = query_builder.tables_with_column(schema, col)
            if holders:
                prm["table"] = holders[0]

    suggestions = [str(x).strip()[:120] for x in (raw.get("suggestions") or []) if isinstance(x, str) and str(x).strip()][:4]
    return {
        "proposal_id": current.get("proposal_id") if current else f"prop_{secrets.token_hex(8)}",
        "owner_id": user.id, "datasource_id": ds.id, "datasource_name": ds.name, "datasource_kind": ds.kind,
        "warehouse_native": native, "title": str(raw.get("title") or effective_goal[:60] or "New dashboard")[:120],
        "pages": out_pages, "used": {"metrics": used_metrics, "columns": used_columns, "tables": used_tables},
        "suggestions": suggestions, "date_column": date_column, "period": period, "parameters": parameters,
        "revision": (current.get("revision", 0) + 1) if current else 1, "expires_in_seconds": _PROPOSAL_TTL_SECONDS,
        "generated_in_ms": int((time.perf_counter() - started) * 1000), "proposed_blocks": proposed, "valid_blocks": valid,
        "warning": warning, "conversation_id": conversation_id, "goal": effective_goal,
    }


def _proposal_out(p: dict) -> schemas.ProposalOut:
    return schemas.ProposalOut(**{k: v for k, v in p.items() if k in schemas.ProposalOut.model_fields})


def _resolve_proposal_datasource(db: Session, user: models.User, datasource_id: str) -> models.DataSource:
    ds = db.query(models.DataSource).filter(models.DataSource.id == (datasource_id or "").strip()).first()
    if not ds:
        raise HTTPException(404, "That data source could not be found.")
    if not workspace_access.can_edit_datasource(db, ds, user):
        raise HTTPException(403, "You have view-only access to that data source.")
    return ds


def _get_proposal(proposal_id: str, user: models.User) -> dict:
    p = _PROPOSALS.get(proposal_id)
    if not p:
        raise HTTPException(404, "That proposal has expired (proposals are kept for 30 minutes) - describe the dashboard again.")
    if p.get("owner_id") != user.id:
        raise HTTPException(404, "That proposal has expired (proposals are kept for 30 minutes) - describe the dashboard again.")
    return p


@router.get("/propose/templates", response_model=list[schemas.ProposalTemplateOut])
def list_propose_templates(user: models.User = Depends(get_current_user)):
    """The three built-in starting points of the Builder ("Start from a
    template"): a goal text + layout hints the proposer is given, never
    pre-made data."""
    return [schemas.ProposalTemplateOut(**t) for t in _PROPOSE_TEMPLATES]


@router.post("/propose", response_model=schemas.ProposalOut)
def propose_dashboard(
    payload: schemas.ProposeDashboardRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Describe -> proposal. Creates NOTHING: returns a validated
    Proposal (cached 30 minutes under proposal_id) the person reviews,
    revises (POST /propose/{id}/revise) and commits (POST /propose/{id}/
    commit). See the section comment above for exactly what "validated"
    means per block."""
    ds = _resolve_proposal_datasource(db, user, payload.datasource_id)
    template = None
    if payload.template_id:
        template = _PROPOSE_TEMPLATES_BY_ID.get(payload.template_id)
        if not template:
            raise HTTPException(400, f"Unknown template \"{payload.template_id}\".")
    pages = payload.pages
    if pages not in ("auto", 1, 2, "1", "2"):
        raise HTTPException(400, 'pages must be "auto", 1 or 2.')
    if payload.period is not None and payload.period not in query_builder.GRAINS:
        raise HTTPException(400, f'The period must be one of {", ".join(query_builder.GRAINS)}.')
    if payload.conversation_id:
        conv = db.query(models.Conversation).filter(models.Conversation.id == payload.conversation_id).first()
        if not conv or not workspace_access.can_access_conversation(db, conv, user):
            raise HTTPException(404, "Conversation not found.")
    try:
        proposal = _build_proposal(db, user, ds, payload.goal, pages=pages, period=payload.period, template=template,
                                   conversation_id=payload.conversation_id)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(400, f"Could not build a proposal from this data source: {e}")
    _PROPOSALS.put(proposal["proposal_id"], proposal)
    return _proposal_out(proposal)


@router.post("/propose/{proposal_id}/revise", response_model=schemas.ProposalOut)
def revise_proposal(
    proposal_id: str,
    payload: schemas.ReviseProposalRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """"Make it one page" / "Use last 12 months only" / "Add a cancellation
    heatmap": one model call with the current proposal as context, the
    result validated exactly like a fresh proposal. Same proposal_id,
    revision + 1."""
    current = _get_proposal(proposal_id, user)
    ds = _resolve_proposal_datasource(db, user, current["datasource_id"])
    instruction = payload.instruction.strip()
    pages = current.get("pages_requested", "auto")
    lowered = instruction.lower()
    if "one page" in lowered or "single page" in lowered or "1 page" in lowered:
        pages = 1
    elif "two pages" in lowered or "2 pages" in lowered:
        pages = 2
    context = {k: current[k] for k in ("title", "date_column", "pages", "suggestions") if k in current}
    context["pages"] = [{"title": p["title"], "blocks": [
        {k: b.get(k) for k in ("client_id", "type", "title", "intent", "chart_type", "spec", "text", "from_metric_name", "status", "error")}
        for b in p["blocks"]]} for p in current["pages"]]
    try:
        proposal = _build_proposal(
            db, user, ds, current.get("goal") or "", pages=pages, period=current.get("period"),
            conversation_id=current.get("conversation_id"), current={**context, "proposal_id": current["proposal_id"], "revision": current.get("revision", 1)},
            instruction=instruction,
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(400, f"Could not revise this proposal: {e}")
    proposal["pages_requested"] = pages
    _PROPOSALS.put(proposal_id, proposal)
    return _proposal_out(proposal)


def _commit_proposal(
    db: Session, user: models.User, ds: models.DataSource, proposal: dict, keep: list[str] | None, name: str | None,
    visibility: str | None, source_conversation_id: str | None = None,
) -> models.Dashboard:
    """Creates the real Dashboard + pages + blocks from a proposal's kept
    blocks (invalid blocks are never created, kept or not). Warehouse
    blocks get their spec + at-rest SQL; file blocks run their recipe
    once, here, against the file's complete data; parameters, the date
    column and the default period come from the proposal."""
    keep_set = set(keep) if keep else None
    native = proposal["warehouse_native"]
    file_df = None
    format_schema = None
    if not native:
        file_df = load_dataframe(ds, table=None, version="original", db=db)
        file_df = data_access_rules.filter_dataframe_for_role(db, file_df, ds, user)
        # Column types for infer_number_format, the same way the proposal saw them.
        format_schema, _ = _file_schema(db, ds, user)
    else:
        # Column types for infer_number_format (real tables + saved-query aliases).
        format_schema, _ = query_builder.with_version_aliases(ds.schema_cache, dashboard_engine.load_versions(db, ds))
    kept_pages: list[tuple[str, list[dict]]] = []
    for page in proposal["pages"]:
        blocks = [b for b in page["blocks"] if b["status"] == "ok" and (keep_set is None or b["client_id"] in keep_set)]
        if blocks:
            kept_pages.append((page["title"], blocks))
    if not kept_pages:
        raise HTTPException(400, "Nothing to create - keep at least one valid block.")
    workspace_id = None
    if (visibility or "private") == "workspace":
        if ds.workspace_id and ds.workspace_id in workspace_access.member_workspace_ids(db, user.id):
            workspace_id = ds.workspace_id
        else:
            raise HTTPException(400, "This data source is not in a workspace you belong to, so the dashboard can only be private.")
    elif visibility not in (None, "private"):
        raise HTTPException(400, 'visibility must be "private" or "workspace".')
    used_group_cols = {g for _, blocks in kept_pages for b in blocks if b.get("spec") for g in (b["spec"].get("group_by") or [])}
    parameters = [p for p in proposal.get("parameters") or [] if p.get("control") == "date_range" or p.get("column") in used_group_cols]
    dashboard = models.Dashboard(
        owner_id=user.id, name=(name or proposal["title"]).strip()[:120] or "New dashboard", layout_version=2,
        source_conversation_id=source_conversation_id or proposal.get("conversation_id"), datasource_id=ds.id,
        workspace_id=workspace_id, parameters=parameters, date_column=proposal.get("date_column"),
        default_period=proposal.get("period") or "month",
    )
    db.add(dashboard)
    db.flush()
    for position, (title, blocks) in enumerate(kept_pages):
        page = models.DashboardPage(dashboard_id=dashboard.id, name=title, position=position)
        db.add(page)
        db.flush()
        for bpos, b in enumerate(blocks):
            layout = b.get("layout") or {}
            btype = b["type"]
            query_sql = None
            if btype == "text":
                config = {"text": b.get("text") or b["title"]}
            elif native:
                config = {"spec": b["spec"], "computed_in": ds.kind, "spec_columns": b.get("columns") or [], "intent": b.get("intent")}
                if btype == "chart":
                    config["chart_type"] = b.get("chart_type") or ("line" if b["spec"].get("time") else "bar")
                if btype in _PROPOSAL_CHARTED_TYPES and b.get("chart_reason"):
                    # GD360 chose this form; the first run confirms it
                    # against the real values (see _confirm_auto_charts).
                    config["chart_auto"] = True
                    config["chart_reason"] = b["chart_reason"]
                if btype == "chart" and b.get("forecast") and b["spec"].get("time"):
                    config["forecast"] = b["forecast"]
                if btype in ("kpi", "sparkline"):
                    config["label"] = b["spec"]["measures"][0]["alias"]
                    # 2026-10-07: a KPI that is certainly a share of a
                    # whole (the average of a 0/1 flag) is shown as a
                    # percentage; anything less certain is left unset.
                    inferred = query_builder.infer_number_format(b["spec"], b.get("title"), format_schema)
                    if inferred:
                        config["format"] = inferred
                        config["format_inferred"] = True
                    if query_builder.infer_good_direction(b["spec"], b.get("title")):
                        config["good_direction"] = "down"
                        config["good_direction_inferred"] = True
                if b.get("from_metric_id"):
                    config["metric_id"] = b["from_metric_id"]
                    config["metric_name"] = b.get("from_metric_name")
                query_sql = b.get("sql")
            else:
                recipe = dict(b.get("recipe") or {})
                if recipe.get("block_type") == "kpi" and proposal.get("date_column") and proposal["date_column"] in file_df.columns:
                    # The tile's sparkline: the same number per period over
                    # the dashboard's date column (see _kpi_trend).
                    recipe["trend_column"] = proposal["date_column"]
                    recipe["trend_grain"] = proposal.get("period") or "month"
                try:
                    btype, config, _default_title = _run_manual_recipe(file_df, recipe, existing_title=b["title"])
                except Exception as e:
                    print(f"[dashboard_builder] proposal block {b['client_id']!r} could not be computed on commit: {e}")
                    continue
                config = {**config, "intent": b.get("intent")}
                if btype == "chart" and b.get("chart_reason"):
                    config["chart_auto"] = True
                    config["chart_reason"] = b["chart_reason"]
                if btype == "chart" and b.get("forecast") and (b.get("spec") or {}).get("time"):
                    config["forecast"] = b["forecast"]
                if btype == "kpi" and b.get("spec"):
                    # 2026-10-07 (real end-to-end run): same certainty rule
                    # as a warehouse KPI just above - a file dashboard's
                    # "Cancellation rate" read 0.37 next to a warehouse
                    # one's 37.3%.
                    inferred = query_builder.infer_number_format(b["spec"], b.get("title"), format_schema)
                    if inferred:
                        config["format"] = inferred
                        config["format_inferred"] = True
                    if query_builder.infer_good_direction(b["spec"], b.get("title")):
                        config["good_direction"] = "down"
                        config["good_direction_inferred"] = True
                if b.get("from_metric_id"):
                    config["metric_id"] = b["from_metric_id"]
            db.add(models.DashboardBlock(
                page_id=page.id, type=btype, title=b["title"], x=int(layout.get("x", 0)), y=int(layout.get("y", 0)),
                w=int(layout.get("w", 6)), h=int(layout.get("h", 6)), config=config, position=bpos, query_sql=query_sql,
            ))
    db.commit()
    db.refresh(dashboard)
    return dashboard


@router.post("/propose/{proposal_id}/commit", response_model=schemas.DashboardBuilderOut, status_code=201)
def commit_proposal(
    proposal_id: str,
    payload: schemas.CommitProposalRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Creates the real dashboard from the kept blocks of a proposal - the
    only step of the flow that writes anything."""
    proposal = _get_proposal(proposal_id, user)
    ds = _resolve_proposal_datasource(db, user, proposal["datasource_id"])
    dashboard = _commit_proposal(db, user, ds, proposal, payload.keep, payload.name, payload.visibility)
    return _builder_out(db, dashboard, user)


# 2026-10-10 (one kind of dashboard - Clarity Blueprint, Option 1): every
# way of making a dashboard now ends in this same full kind (layout 2:
# filters, cross-filter, canvas, publish). An Answer's "Create dashboard"
# and the one-click upgrade of a classic answer dashboard (layout 3) both
# come through here: describe -> validated proposal -> committed blocks,
# exactly the /dashboards/new flow, just without the review step.

def _move_pages(db: Session, source: models.Dashboard, target: models.Dashboard, suffix: str | None = None) -> list[str]:
    """Moves every page (with its blocks, SQL and all) from `source` onto
    `target`, after target's own pages, and merges source's filter
    parameters into target's by id. Returns the moved page ids. The caller
    deletes `source` afterwards."""
    next_position = max((p.position for p in target.pages), default=-1) + 1
    taken = {p.name for p in target.pages}
    moved: list[str] = []
    for page in sorted(list(source.pages), key=lambda p: p.position):
        name = page.name
        if suffix and name in taken:
            name = f"{name} ({suffix})"[:120]
        page.name = name
        page.position = next_position
        next_position += 1
        target.pages.append(page)  # re-parents (never orphaned, so never deleted)
        moved.append(page.id)
    params = list(target.parameters or []) if isinstance(target.parameters, list) else []
    known = {p.get("id") for p in params if isinstance(p, dict)}
    for p in source.parameters or []:
        if isinstance(p, dict) and p.get("id") not in known:
            params.append(p)
            known.add(p.get("id"))
    target.parameters = params
    if not target.date_column and source.date_column:
        target.date_column = source.date_column
    if not target.default_period and source.default_period:
        target.default_period = source.default_period
    db.flush()
    return moved


def build_dashboard_from_goal(
    db: Session, user: models.User, ds: models.DataSource, goal: str, *, name: str | None = None,
    conversation_id: str | None = None, add_to: models.Dashboard | None = None,
    replace: models.Dashboard | None = None, pages="auto",
) -> tuple[models.Dashboard, list[str]]:
    """Builds a full dashboard on `ds` from a plain-English goal. Returns
    (dashboard, page ids that were created).

    - default: a new private dashboard, linked back to conversation_id.
    - add_to: the new pages are added to that existing dashboard (same
      data source only - a dashboard computes against one source).
    - replace: the classic dashboard row `replace` becomes this full
      dashboard IN PLACE - same id (old links keep working), name,
      owner and sharing - with the new pages and filters."""
    if add_to is not None and add_to.datasource_id and add_to.datasource_id != ds.id:
        raise HTTPException(400, "That dashboard is built on a different data source - pick one built on the same source, or create a new dashboard.")
    try:
        # pages: "auto", or 1 / 2 (2026-10-11 - an answer added as one page)
        proposal = _build_proposal(db, user, ds, goal, pages=pages if pages in (1, 2) else "auto",
                                   conversation_id=conversation_id)
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Could not plan a dashboard on {ds.name}: {e}")
    if proposal["valid_blocks"] == 0:
        reasons = [f'"{b["title"]}": {b["error"]}' for p in proposal["pages"] for b in p["blocks"] if b.get("error")]
        detail = f"GD360 couldn't build a dashboard from this on {ds.name}."
        if reasons:
            detail += " Specifically: " + "; ".join(reasons[:3])
        raise HTTPException(400, detail)
    fresh = _commit_proposal(db, user, ds, proposal, None, name, "private", source_conversation_id=conversation_id)
    if add_to is None and replace is None:
        return fresh, [p.id for p in fresh.pages]
    target = add_to if add_to is not None else replace
    if replace is not None:
        target.layout_version = 2
        target.datasource_id = ds.id
        target.parameters = []
        target.date_column = None
        target.default_period = None
        target.project_spec = None
        target.project_snapshot = None
        target.snapshot_at = None
        if conversation_id:
            target.source_conversation_id = conversation_id
        for old_page in list(target.pages):  # a classic answer dashboard has none; be safe
            db.delete(old_page)
        db.flush()
    moved = _move_pages(db, fresh, target, suffix=None if replace is not None else "new")
    if not target.datasource_id:
        target.datasource_id = ds.id
    db.delete(fresh)
    db.commit()
    db.refresh(target)
    return target, moved


@router.post("/{dashboard_id}/blocks/{block_id}/swap", response_model=schemas.DashboardBuilderOut)
def swap_block(
    dashboard_id: str,
    block_id: str,
    payload: schemas.SwapBlockRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """"Swap chart": the SAME spec (or the same bound sql cell) rendered
    as another chart type and/or another block shape (chart/table/kpi/
    donut/sparkline/avatar_list/gauge). No model call, no new query - the
    next run renders the same result differently. Undo-able."""
    d = _get_dashboard_v2(db, user, dashboard_id, require_edit=True)
    block = _get_block(db, d, block_id)
    config = block.config or {}
    if not isinstance(config.get("spec"), dict) and not config.get("source_block_id"):
        raise HTTPException(400, "Only a block with a query spec (or one bound to a SQL cell) can be swapped - rebuild it instead.")
    if payload.chart_type is None and payload.type is None:
        raise HTTPException(400, "Nothing to swap - send chart_type and/or type.")
    new_type = block.type
    if payload.type is not None:
        if payload.type not in _DATA_BLOCK_TYPES:
            raise HTTPException(400, f"type must be one of {', '.join(sorted(_DATA_BLOCK_TYPES))}.")
        new_type = payload.type
    chart_type = config.get("chart_type")
    reason = None
    auto = False
    spec = config.get("spec") if isinstance(config.get("spec"), dict) else None
    if payload.chart_type is not None:
        asked = payload.chart_type.strip().lower()
        if asked != "auto":
            asked = chart_recommender.normalize_chart_type(asked) or asked
        if asked not in _SWAP_CHART_TYPES:
            raise HTTPException(400, f"chart_type must be one of {', '.join(sorted(_SWAP_CHART_TYPES))}.")
        # 2026-10-07 (chart-types round): a swap is only made to a form the
        # block's data can be drawn as - the reason is the 400's message.
        # "auto" is "swap to best": the recommender's pick for the block's
        # CURRENT result (one block run - a cache hit when the page has
        # just shown it; the same query the page runs, never anything more).
        shape = None
        if spec is not None:
            ds = _resolve_datasource(db, user, d)
            schema, _ = query_builder.with_version_aliases(ds.schema_cache, dashboard_engine.load_versions(db, ds))
            shape = _spec_shape(ds, schema, spec, config)
            if asked == "auto" and dashboard_engine.is_warehouse_native(ds):
                try:
                    res = dashboard_engine.run_block(db, ds, spec, user_id=user.id, date_column=d.date_column,
                                                     default_period=d.default_period)
                    if res.get("status") == "ok":
                        target = isinstance(config.get("target"), (int, float)) and not isinstance(config.get("target"), bool)
                        shape = chart_recommender.shape_from_result(res, spec, target=target)
                except Exception as e:
                    print(f"[dashboard_builder] swap-to-best ran on the spec's shape only (non-fatal): {e}")
        if asked == "auto":
            if shape is None:
                raise HTTPException(400, "This block is drawn from a SQL cell - pick the chart type yourself.")
            choice = _choose_chart(shape, None, False, "swap-to-best")
            chart_type, reason, auto = choice["chart_type"], choice["reason"], True
            new_type = choice["block_type"]
        else:
            if shape is not None:
                ok, why = _fits_before_run(shape, asked)
                if not ok:
                    label = next((t["label"] for t in chart_recommender.CHART_TYPES if t["type"] == asked), asked)
                    raise HTTPException(400, f"{label}: this block {why}.")
            chart_type = asked
            if payload.type is None and new_type not in ("chart",):
                new_type = "donut" if chart_type == "donut" else "chart"
    if chart_type == "donut" and new_type == "chart":
        new_type = "donut"
    _snapshot_block_config(block)
    new_config = {k: v for k, v in config.items() if k not in ("chart_spec", "result_rows", "result_columns", "rows", "columns")}
    if new_type == "chart":
        new_config["chart_type"] = chart_type or ("line" if (spec or {}).get("time") else "bar")
    else:
        new_config.pop("chart_type", None)
    if payload.chart_type is not None or payload.type is not None:
        if auto:
            new_config["chart_auto"] = True
            new_config["chart_checked"] = True
            new_config["chart_reason"] = reason
        else:
            # The person picked it.
            for key in ("chart_auto", "chart_checked", "chart_reason"):
                new_config.pop(key, None)
    if new_type in ("kpi", "gauge", "sparkline") and spec is not None:
        new_config["label"] = new_config.get("label") or spec["measures"][0]["alias"]
    # A forecast is drawn on a line / area / bar over time (or a KPI's
    # sparkline); another form drops it rather than keep computing it unseen.
    if new_config.get("forecast") and not (
        (new_type == "chart" and new_config.get("chart_type") in ("line", "area", "bar", "step_line") and (spec or {}).get("time"))
        or new_type in ("kpi", "sparkline")
    ):
        new_config.pop("forecast", None)
    block.type = new_type
    block.config = new_config
    if new_type == "chart" and new_config.get("chart_type") == "map" and spec is not None:
        # A map colours every country: a "top 10" spec is widened (the
        # ranked list beside the map still shows the top ones). Same
        # validation as any spec; the block's title is left alone.
        widened = _map_ready_spec(spec)
        if widened != spec:
            try:
                ds = _resolve_datasource(db, user, d)
                if dashboard_engine.is_warehouse_native(ds):
                    check = dashboard_engine.validate_spec_in_warehouse(ds, widened, dashboard_engine.load_versions(db, ds), date_column=d.date_column)
                    if check["ok"]:
                        block.config = {**new_config, "spec": check["spec"]}
                        block.query_sql = check["sql"]
            except HTTPException:
                pass
    db.commit()
    db.refresh(d)
    return _builder_out(db, d, user)


@router.get("/{dashboard_id}", response_model=schemas.DashboardBuilderOut)
def get_builder_dashboard(
    dashboard_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)
):
    d = _get_dashboard_v2(db, user, dashboard_id)
    # 2026-10-07 (identity-colour round): a block that stores its result
    # (every block of a file dashboard) has its values registered here, so
    # the very first paint already has its colours.
    _assign_stored_colors(db, d)
    return _builder_out(db, d, user)


# 2026-09-29 (design revamp): "merge with other dashboards in the same
# project" - Gokul's own words. Deliberately scoped to dashboards that
# share the exact same source_conversation_id (the same chat "Project" -
# see DashboardBuilderOut.sibling_dashboards's own comment for why that's
# what "same project" means here): merging is only ever offered between
# dashboards the person can already see listed as siblings of each other,
# never an arbitrary dashboard-id typed in from anywhere else, so this
# re-checks that same-conversation constraint server-side too rather than
# trusting whatever the frontend's own picker happened to show.
#
# ADDITIVE, never destructive: every page (and every block on it) from
# `source_dashboard_id` is COPIED into `dashboard_id` as brand new rows,
# appended after this dashboard's existing pages - the source dashboard
# itself is left completely untouched, so merging is safe to try and easy
# to walk back (just delete the newly-added page(s) again) rather than an
# irreversible one-way combine. Each merged-in page's name is suffixed
# with where it came from ("Overview (from Q3 Forecast)") - two
# dashboards from the same chat can easily both have a page called
# "Overview", and silently landing two same-named, unrelated page tabs
# next to each other on the merged result would be far more confusing
# than one honestly-labeled extra word.
@router.post("/{dashboard_id}/merge-from/{source_dashboard_id}", response_model=schemas.DashboardBuilderOut, status_code=201)
def merge_dashboard(
    dashboard_id: str,
    source_dashboard_id: str,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    target = _get_dashboard_v2(db, user, dashboard_id, require_edit=True)
    source = db.query(models.Dashboard).filter(models.Dashboard.id == source_dashboard_id).first()
    if not source or source.layout_version != 2 or not _can_view(db, source, user):
        raise HTTPException(404, "The dashboard to merge from wasn't found.")
    if source.id == target.id:
        raise HTTPException(400, "A dashboard can't be merged into itself.")
    if not target.source_conversation_id or target.source_conversation_id != source.source_conversation_id:
        raise HTTPException(400, "You can only merge dashboards that were built from the same chat Project.")

    next_position = (max((p.position for p in target.pages), default=-1)) + 1
    for src_page in sorted(source.pages, key=lambda p: p.position):
        new_page = models.DashboardPage(
            dashboard_id=target.id,
            name=f"{src_page.name} (from {source.name})",
            position=next_position,
            background_color=src_page.background_color,
        )
        db.add(new_page)
        db.flush()
        next_position += 1
        for src_block in src_page.blocks:
            db.add(models.DashboardBlock(
                page_id=new_page.id,
                type=src_block.type,
                title=src_block.title,
                x=src_block.x, y=src_block.y, w=src_block.w, h=src_block.h,
                config=src_block.config,
                position=src_block.position,
                data_updated_at=src_block.data_updated_at,
                # previous_config deliberately NOT copied - an undo snapshot
                # from the source dashboard means nothing on this brand new
                # copy, which has no "last change" of its own yet to revert.
            ))

    db.commit()
    db.refresh(target)
    return _builder_out(db, target, user)


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
    # 2026-10-06 (warehouse-native dashboards layer): "" clears, None leaves.
    if payload.default_period is not None:
        grain = payload.default_period.strip().lower()
        if grain and grain not in query_builder.GRAINS:
            raise HTTPException(400, f"The period must be one of: {', '.join(query_builder.GRAINS)}.")
        d.default_period = grain or None
    if payload.date_column is not None:
        column = payload.date_column.strip()
        if column:
            ds = _dashboard_datasource(db, d)
            if dashboard_engine.is_warehouse_native(ds) and not _column_exists_anywhere(db, ds, column):
                raise HTTPException(400, f'The column "{column}" is not in any table of this dashboard\'s data source.')
        d.date_column = column or None
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
    # 2026-10-07 (identity-colour round): a dashboard that never had a
    # brand colour and gets its first one keeps the chart colours it shows
    # now (see services/appearance.materialize) - only a dashboard branded
    # BEFORE that round resolves to the single-colour look.
    first_brand_color = (
        not d.brand_primary_color and payload.brand_primary_color is not None and bool(_hex_color_or_none(payload.brand_primary_color))
    )
    style_before = _appearance_fields(db, d, _dashboard_datasource(db, d), include_kit=False)["appearance"] if first_brand_color else None
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
    if style_before is not None:
        appearance_svc.mutate(db, d.id, lambda doc: appearance_svc.materialize(doc, style_before))
    db.refresh(d)
    return _builder_out(db, d, user)


# 2026-10-07 (identity-colour round): the dashboard's appearance - chart
# palette, colour by value / single colour, pinned value colours, density,
# corner radius, font, currency, locale, the published link's default
# theme and footer note. Owner / editor only. Only the fields sent are
# changed; `reset` undoes ("workspace": follow the workspace brand kit
# again; "colors": forget the pins and the colour registry). Answers with
# the resolved appearance alone (not the whole dashboard): the Appearance
# sheet saves on every change, debounced, and applies it optimistically.
@router.patch("/{dashboard_id}/appearance", response_model=schemas.DashboardAppearanceOut)
def update_appearance(
    dashboard_id: str,
    payload: schemas.UpdateAppearanceRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    d = _get_dashboard_v2(db, user, dashboard_id, require_edit=True)
    patch = {key: getattr(payload, key) for key in payload.model_fields_set}
    ds = _dashboard_datasource(db, d)
    before = _appearance_fields(db, d, ds, include_kit=False)["appearance"]
    try:
        appearance_svc.mutate(db, d.id, lambda doc: appearance_svc.apply_patch(doc, patch, before))
    except appearance_svc.AppearanceError as e:
        raise HTTPException(422, str(e))
    db.refresh(d)
    return schemas.DashboardAppearanceOut(**_appearance_fields(db, d, ds))


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
    if payload.type not in _ALL_BLOCK_TYPES:
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
    # 2026-10-01 (chat-to-dashboard round): payload.config lets this block
    # be created ALREADY FILLED with a real result - see CreateBlockRequest
    # .config's own docstring for exactly why (PushToDashboardMenu.tsx's
    # "Add to dashboard" action from the chat panel / the current chart).
    # A truthy, non-empty dict is used as-is in place of the usual empty
    # starting shape; anything falsy (None, {}, omitted) keeps create_block
    # behaving exactly as it always has - every other caller (the element-
    # library drag-drop, BuildDashboardModal's blank/template starts) never
    # sends this field at all.
    default_config = payload.config if payload.config else _default_block_config(payload.type)
    # 2026-10-07 (analyst canvas round): a cell created already filled
    # (a sql cell with its statement, an input with its parameter, a
    # chart bound to a cell) is validated exactly like a PATCH would be.
    if payload.type in ("sql", "input") or (payload.config and payload.type in _DATA_BLOCK_TYPES):
        probe = models.DashboardBlock(id=f"new-{secrets.token_hex(4)}", type=payload.type, title=payload.title, config={})
        default_config = _validate_cell_config(db, user, d, page, probe, default_config)
        probe_query_sql = probe.query_sql
    else:
        probe_query_sql = None
    # 2026-10-07 (block editing round): on a WAREHOUSE dashboard a data
    # block that starts with nothing in it is marked config.empty so the
    # run response can tell "added, not built yet" (RunPageOut.
    # empty_block_ids) apart from a pre-layer block that has a stored
    # result but no spec (skipped_block_ids alone - "upgrade it").
    # _store_block_spec removes the marker the moment the block is built.
    # A file dashboard's empty block is unchanged ({}).
    if not payload.config and payload.type in _DATA_BLOCK_TYPES \
            and dashboard_engine.is_warehouse_native(_dashboard_datasource(db, d)):
        default_config = {**default_config, "empty": True}
    block = models.DashboardBlock(
        page_id=page.id,
        type=payload.type,
        title=(payload.title or "").strip()[:120] or None,
        x=x, y=y, w=w, h=h,
        config=default_config,
        position=len(page.blocks),
        query_sql=probe_query_sql,
        # Not set explicitly here either way - models.DashboardBlock
        # .data_updated_at already carries its own column-level default
        # (datetime.utcnow at insert time, pre-existing, unrelated to this
        # round), so a block created already filled with a real pushed
        # result (payload.config truthy) correctly reads as just-built
        # without this endpoint needing to stamp it a second time.
    )
    db.add(block)
    if payload.type == "chart" and (payload.template or "").strip().lower() == "forecast" and not payload.config:
        db.flush()
        _fill_forecast_template(db, user, d, block)
    db.commit()
    db.refresh(d)
    return _builder_out(db, d, user)


def _fill_forecast_template(db: Session, user: models.User, d: models.Dashboard, block: models.DashboardBlock) -> None:
    """Add block -> "Forecast": a time-series chart that works the moment
    it lands - rows per period over the dashboard's date column (else the
    table's first date column), with the forecast on. Deterministic, no
    model call; the person edits the query (the measure, the grain)
    afterwards. With no date column to draw over, the block is left empty
    with its forecast option set, and the empty state says what it needs."""
    ds = _dashboard_datasource(db, d)
    grain = d.default_period if d.default_period in forecast_svc.GRAINS else "month"
    options = _default_forecast_options(grain)
    if ds is not None and dashboard_engine.is_warehouse_native(ds):
        versions = dashboard_engine.load_versions(db, ds)
        schema, _ = query_builder.with_version_aliases(ds.schema_cache, versions)
        table = _dashboard_primary_table(d, ds) or next(iter(schema.keys()), None)
        columns = query_builder.table_columns(schema, table) or [] if table else []
        names = {c["name"] for c in columns}
        date_col = d.date_column if d.date_column in names else next(
            (c["name"] for c in columns if re.search(r"date|time", str(c.get("type") or ""), re.IGNORECASE)), None)
        if table and date_col:
            spec = {"table": table, "time": {"column": date_col, "grain": grain},
                    "measures": [{"alias": "rows", "agg": "count", "column": None}], "limit": query_builder.MAX_LIMIT}
            try:
                _store_block_spec(db, d, ds, block, spec, block_type="chart", chart_type="line", versions=versions,
                                  extra_config={"forecast": options, "template": "forecast"},
                                  auto_title=f"Rows by {grain} - forecast")
                if not block.title:
                    block.title = f"Rows by {grain} - forecast"
                    block.config = {**block.config, "title_auto": True}
                return
            except BlockSpecStoreError as e:
                print(f"[dashboard_builder] forecast template could not be prefilled (non-fatal): {e.message}")
        block.config = {**(block.config or {}), "forecast": options, "template": "forecast", "chart_type": "line"}
        return
    # A file dashboard: the same series from the file's own rows.
    block.config = {**(block.config or {}), "forecast": options, "template": "forecast", "chart_type": "line"}
    if ds is None:
        return
    try:
        df = load_dataframe(ds, table=None, version="original", db=db)
        df = data_access_rules.filter_dataframe_for_role(db, df, ds, user)
        date_col = d.date_column if d.date_column in df.columns else next(
            (c for c in df.columns if pd.api.types.is_datetime64_any_dtype(df[c])), None)
        if not date_col:
            return
        recipe = {"block_type": "chart", "chart_type": "line", "group_by_column": date_col, "time_grain": grain, "agg": "count",
                  "count_rows": True, "metric_column": date_col, "alias": "rows"}
        _btype, config, _title = _run_manual_recipe(df, recipe, existing_title=f"Rows by {grain} - forecast")
        block.config = {**config, "forecast": options, "template": "forecast", "chart_type": "line"}
        if not block.title:
            block.title = f"Rows by {grain} - forecast"
        block.data_updated_at = datetime.utcnow()
    except Exception as e:
        print(f"[dashboard_builder] forecast template could not be prefilled on the file (non-fatal): {e}")


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
    renamed = payload.title is not None and (payload.title.strip()[:120] or None) != block.title
    if payload.title is not None:
        block.title = payload.title.strip()[:120] or None
    if payload.config is not None:
        # 2026-10-07 (identity-colour round): a block's own colour override
        # ("color_mode": "by_value" | "single", "single_color": hex) is
        # stored clean or not at all.
        new_config = appearance_svc.clean_block_color(payload.config)
        if block.type in ("sql", "input") or (block.type in _DATA_BLOCK_TYPES and "source_block_id" in new_config):
            new_config = _validate_cell_config(db, user, d, block.page, block, new_config)
        _snapshot_block_config(block)
        block.config = new_config
        # A real content change (a text block's body, a filter block's
        # column) - not a position/title-only edit, which leaves this
        # column untouched. See models.DashboardBlock's own docstring for
        # why this is set explicitly rather than via onupdate.
        block.data_updated_at = datetime.utcnow()
    if renamed:
        # The person typed this title: it is no longer GD360's to rewrite.
        _clear_auto_title(block)

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


def _free_slot_below(page: models.DashboardPage, source: models.DashboardBlock) -> tuple[int, int]:
    """Where a copy of `source` lands: directly below it (same column,
    same size) when that space is free, else at the bottom of the page in
    the same column - _place_new_block's own "append below everything"
    rule. Never overlaps a block and never moves one."""
    x, y, w, h = source.x, source.y + source.h, source.w, source.h
    overlaps = any(
        b.x < x + w and x < b.x + b.w and b.y < y + h and y < b.y + b.h
        for b in page.blocks
    )
    if overlaps:
        y = max((b.y + b.h for b in page.blocks), default=0)
    return x, y


def _unique_cell_name(page: models.DashboardPage, name: str | None) -> str:
    """A SQL cell name for a copy: "<name>_copy", then "<name>_copy2",
    ... - a plain identifier no other sql cell on the page uses (a cell
    is referenced by name as {{cell:<name>}}, so two cannot share one)."""
    taken = {(b.config or {}).get("name") for b in page.blocks if b.type == "sql"}
    base = re.sub(r"[^A-Za-z0-9_]+", "_", str(name or "cell")).strip("_") or "cell"
    if not re.match(r"[A-Za-z_]", base):
        base = f"cell_{base}"
    base = f"{base[:48]}_copy"
    candidate, n = base, 2
    while candidate in taken:
        candidate = f"{base}{n}"
        n += 1
    return candidate


@router.post("/{dashboard_id}/blocks/{block_id}/duplicate", response_model=schemas.DashboardBuilderOut, status_code=201)
def duplicate_block(
    dashboard_id: str, block_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)
):
    """Copies one block onto the same page: its type, title ("<title>
    copy"), config (a deep copy - a spec, a chart type, a stored result,
    all of it), compiled query_sql and size. The copy lands directly
    below the original when that space is free, else at the bottom of
    the page; no other block moves. A SQL cell's copy gets its own
    unique config.name (cells are referenced by name). Nothing is run or
    loaded - a spec block's copy computes on the next page run like any
    other. Comments, the undo snapshot and last_run are not copied."""
    d = _get_dashboard_v2(db, user, dashboard_id, require_edit=True)
    source = _get_block(db, d, block_id)
    page = next((p for p in d.pages if p.id == source.page_id), None)
    if not page:
        raise HTTPException(404, "Block not found on this dashboard.")
    config = copy.deepcopy(source.config) if source.config is not None else {}
    if source.type == "sql":
        config["name"] = _unique_cell_name(page, config.get("name"))
    x, y = _free_slot_below(page, source)
    db.add(models.DashboardBlock(
        page_id=page.id,
        type=source.type,
        title=(f"{source.title} copy")[:120] if source.title else None,
        x=x, y=y, w=source.w, h=source.h,
        config=config,
        position=max((b.position or 0 for b in page.blocks), default=-1) + 1,
        query_sql=source.query_sql,
        # The copy's numbers are exactly as old as the original's.
        data_updated_at=source.data_updated_at,
    ))
    db.commit()
    db.refresh(d)
    return _builder_out(db, d, user)


@router.post("/{dashboard_id}/blocks/{block_id}/undo", response_model=schemas.DashboardBuilderOut)
def undo_block(
    dashboard_id: str, block_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)
):
    """"i want a option in each chart like undo or redo because just now i
    changed something and i cannot able to get that old version back" -
    swaps this block's config (and type, see models.DashboardBlock.
    previous_config's own docstring for why type comes along too) back to
    whatever _snapshot_block_config captured right before its most recent
    change, across any of the six endpoints that make one. Position/size
    (x/y/w/h) and title are deliberately left untouched - those are never
    snapshotted in the first place (only a content/style change is), so a
    drag/resize/rename a person made after the content edit they want to
    undo is kept exactly as they left it, not silently reverted along with
    it. Single-level by design: this clears previous_config on the way
    out, so undo is not itself undoable - a second click with nothing left
    to revert to 400s with a clear message rather than silently doing
    nothing."""
    d = _get_dashboard_v2(db, user, dashboard_id, require_edit=True)
    block = _get_block(db, d, block_id)

    snapshot = block.previous_config
    if not snapshot:
        raise HTTPException(400, "There's no previous version of this block to undo back to.")

    block.type = snapshot.get("type") or block.type
    block.config = snapshot.get("config") or {}
    block.previous_config = None

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

    # 2026-10-07 (block editing on a warehouse source): a warehouse/
    # database source NEVER reaches load_dataframe/analyze below. The
    # question becomes a BlockSpec the warehouse computes (validated and
    # dry-run before it is stored, one bounded retry), or a 422 that says
    # nothing was computed - see _ask_ai_block_warehouse. Everything
    # below this branch is the file-source path, unchanged.
    if dashboard_engine.is_warehouse_native(ds):
        _ask_ai_block_warehouse(db, d, ds, block, payload.prompt)
        db.commit()
        db.refresh(d)
        return _builder_out(db, d, user)

    # 2026-10-01 (lineage round): this used to pass table=None unconditionally,
    # which load_dataframe silently turns into "raise NeedsTableSelection" for
    # ANY multi-table source (BigQuery/Snowflake/a multi-table SQL connection/
    # multi-sheet Excel/MongoDB with more than one collection picked) - caught
    # below only as a generic "Could not load this dashboard's data" 400, with
    # no way to recover. That's the exact same bug class Gokul originally
    # reported for the goal-driven /generate path (see default_table_for_
    # preview's own docstring and this file's multi-table fix round), just in
    # the two OTHER places a dashboard touches its data - Ask AI on an
    # existing block, and Build Manually just below. default_table_for_
    # preview(ds) is the SAME deterministic "first table" convention the Data
    # tab preview already uses for exactly this situation - never a guess,
    # and honestly disclosed via config["source_table"] below (see
    # ai_result_to_block/_attach_source_lineage) rather than silently picked
    # with no record of which table actually answered the question. A real
    # per-block table PICKER (letting a person choose a different table than
    # the first one) is a natural next step, not attempted here - this round
    # is scoped to "stop 400ing," matching how the goal-driven path's own
    # fix was scoped to table_names rather than full cross-table joins.
    multi_table_default = default_table_for_preview(ds)
    try:
        original_df = load_dataframe(ds, table=multi_table_default, version="original", db=db)
        original_df = data_access_rules.filter_dataframe_for_role(db, original_df, ds, user)
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
    if multi_table_default and actual_type != "text":
        config = {**config, "source_table": multi_table_default}
    # 2026-09-29 (design revamp): if the person's own question here already
    # says "forecast"/"predict"/"projection" ("forecast next quarter's
    # shipping delay"), turn the forecast overlay on automatically, the
    # same nudge generate_dashboard's bulk/goal-driven path already gets
    # from _maybe_add_forecast_overlay - so a single "Ask AI" block honors
    # the same "the user shouldn't have to know the Show-forecast toggle
    # exists" rule the bulk path follows. block.title is usually still
    # blank at this point (it only gets set a few lines below when empty),
    # so pass the prompt as both title and prompt - the keyword check reads
    # them concatenated either way.
    config = _maybe_add_forecast_overlay({"title": block.title or "", "prompt": payload.prompt}, actual_type, config)
    # 2026-09-28 (scheduled auto-refresh round): remembers the exact prompt
    # this block was built from, alongside its computed content - a
    # manually-built block already carries everything needed to safely
    # recompute it unattended (its stored `recipe` - see build_manual_block
    # below), but until now an AI-built block carried only its RESULT, with
    # no way for services/scheduler.py's automatic refresh to know what
    # question to re-ask. This is purely additive: nothing here changes
    # what ask_ai_block itself returns or how this block renders today.
    config["ai_prompt"] = payload.prompt.strip()
    auto_title = _title_is_auto(block)
    _snapshot_block_config(block)
    block.type = actual_type
    block.config = config
    block.data_updated_at = datetime.utcnow()
    if auto_title:
        _set_auto_title(block, payload.prompt)

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

    # 2026-10-07 (block editing on a warehouse source): a warehouse/
    # database source NEVER reaches load_dataframe below - the recipe is
    # translated into a BlockSpec the warehouse computes (see
    # _build_manual_block_warehouse); a recipe feature that only exists as
    # an in-app pandas computation is a 400 naming it. Everything below
    # this branch is the file-source path, unchanged.
    if dashboard_engine.is_warehouse_native(ds):
        _build_manual_block_warehouse(db, d, ds, block, payload)
        db.commit()
        db.refresh(d)
        return _builder_out(db, d, user)

    # 2026-10-01 (lineage round): see ask_ai_block's identical comment just
    # above in this file - the same NeedsTableSelection-becomes-a-bare-400
    # bug, for the same reason, fixed the same honest way (default to the
    # first table, disclose it via config["source_table"] below).
    multi_table_default = default_table_for_preview(ds)
    try:
        df = load_dataframe(ds, table=multi_table_default, version="original", db=db)
        df = data_access_rules.filter_dataframe_for_role(db, df, ds, user)
    except Exception as e:
        raise HTTPException(400, f"Could not load this dashboard's data: {e}")

    # 2026-09-30 (transformation layer v1): a saved transform (models.
    # DataTransform) swaps in its own derived table as the working data for
    # this block, BEFORE any page filter or metric/column pick is applied
    # on top of it - "a tile built from a saved table," not just from this
    # data source's raw data. See models.DataTransform's own docstring for
    # why this always resolves live (services/transforms.py) rather than
    # freezing a one-shot snapshot, and preview_filtered_blocks below for
    # how it stays live across a page filter change AND a later edit to
    # the transform itself.
    if payload.transform_id:
        transform = (
            db.query(models.DataTransform)
            .filter(models.DataTransform.id == payload.transform_id, models.DataTransform.datasource_id == ds.id)
            .first()
        )
        if not transform:
            raise HTTPException(404, "That saved table no longer exists.")
        df, transform_error = apply_transform_steps(df, transform.steps or [])
        if transform_error:
            raise HTTPException(400, f'Could not build "{transform.name}": {transform_error}')

    if payload.filters:
        df = _apply_filters(df, payload.filters)

    # 2026-09-30 (semantic layer v1): a saved metric (models.
    # MetricDefinition) builds a kpi/gauge tile from THIS data source's
    # own metric glossary instead of a fresh column+aggregation pick - see
    # _metric_kpi_or_gauge_config's own docstring for why this always
    # resolves live (through services/metrics.py) rather than freezing a
    # one-shot number, and preview_filtered_blocks below for how it stays
    # live across a page filter change too.
    if payload.metric_id:
        metric = (
            db.query(models.MetricDefinition)
            .filter(models.MetricDefinition.id == payload.metric_id, models.MetricDefinition.datasource_id == ds.id)
            .first()
        )
        if not metric:
            raise HTTPException(404, "That metric no longer exists.")
        try:
            actual_type, config, default_title = _metric_kpi_or_gauge_config(
                metric, payload.block_type, df, payload.target_value, payload.max_value, payload.transform_id,
            )
        except ValueError as e:
            raise HTTPException(400, str(e))
    else:
        if not payload.metric_column and not (payload.bins and payload.bins.get("column")):
            raise HTTPException(400, "Pick a column, or a saved metric, to build from.")
        # 2026-10-07 (chart-types round): the optional extras of the new
        # chart forms - a second group-by, more measures, a time bucket, a
        # histogram's bins (see ManualBuildBlockRequest).
        extras: dict = {}
        if payload.block_type == "chart" and payload.bins and payload.bins.get("column"):
            extras["bins"] = {"column": payload.bins.get("column"), "count": payload.bins.get("count"),
                              "min": payload.bins.get("min"), "max": payload.bins.get("max")}
        if payload.time_grain and payload.time_grain in _RECIPE_TIME_FREQ:
            extras["time_grain"] = payload.time_grain
        if payload.block_type in ("chart", "table") and (payload.group_by_column_2 or payload.extra_measures):
            groups = [g for g in (payload.group_by_column, payload.group_by_column_2) if g]
            extras["group_by"] = groups
            extras["measures"] = [{"agg": payload.agg, "column": payload.metric_column}] + [
                {"agg": str(m.get("agg") or "sum"), "column": m.get("column")} for m in payload.extra_measures if isinstance(m, dict)
            ]
        recipe = {
            "metric_column": payload.metric_column or (payload.bins or {}).get("column"),
            "agg": payload.agg,
            "group_by_column": payload.group_by_column,
            "block_type": payload.block_type,
            "chart_type": payload.chart_type,
            **extras,
            # 2026-10-07: a KPI's sparkline runs over the dashboard's date
            # column when it has one (see _kpi_trend); absent otherwise.
            **({"trend_column": d.date_column, "trend_grain": d.default_period or "month"}
               if payload.block_type == "kpi" and d.date_column and d.date_column in df.columns else {}),
            # 2026-09-25 (Round 3): only read when block_type == "gauge" - see
            # _run_manual_recipe. Carried in the stored recipe itself (not a
            # separate column) so a later cross-filter recompute
            # (preview_filtered_blocks) reproduces the exact same gauge
            # range/target the person originally set, not a re-guessed one.
            "target_value": payload.target_value,
            "max_value": payload.max_value,
            # 2026-09-30 (transformation layer v1): which saved transform
            # (if any) this block's data comes from - see the resolution
            # above and preview_filtered_blocks below, both of which
            # re-apply it fresh on every recompute rather than baking its
            # output into this recipe as a frozen snapshot.
            "transform_id": payload.transform_id,
        }
        try:
            actual_type, config, default_title = _run_manual_recipe(df, recipe, existing_title=block.title)
        except ValueError as e:
            raise HTTPException(400, str(e))
        except Exception as e:
            raise HTTPException(400, f"Couldn't compute that: {e}")

    if multi_table_default and actual_type != "text":
        config = {**config, "source_table": multi_table_default}
    # 2026-10-07 (chart-types round): the chart form - what the builder
    # picked when the result can be drawn as it, else (and for "auto") the
    # recommender's choice for the rows just computed.
    if actual_type == "chart" and config.get("result_rows") and not payload.metric_id:
        config = _apply_file_chart_choice(config, payload.chart_type)
        if payload.forecast and (config.get("recipe") or {}).get("time_grain"):
            config["forecast"] = _default_forecast_options((config.get("recipe") or {}).get("time_grain"))
    auto_title = _title_is_auto(block)
    # Presentation the person chose for this block outlives a rebuild of
    # its numbers (the same keys a warehouse rebuild keeps).
    for key in ("format", "decimals", "currency", "good_direction", "accent_color", "color_mode", "single_color"):
        if key in (block.config or {}) and key not in config and not (block.config or {}).get(f"{key}_inferred"):
            config[key] = block.config[key]
    _snapshot_block_config(block)
    block.type = actual_type
    block.config = config
    block.data_updated_at = datetime.utcnow()
    if auto_title:
        _set_auto_title(block, default_title)

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
    # 2026-10-07 (chart-types round): every form the native renderer draws
    # from the block's rows may be chosen - when the rows can be drawn as
    # it (services/chart_recommender.fits; the 400 says what is missing).
    # "auto" is the recommender's own pick.
    native = chart_recommender.normalize_chart_type(chart_type) if chart_type != "auto" else "auto"
    if chart_type not in _RESTYLE_CHART_TYPES and native is None:
        raise HTTPException(400, f"Unsupported chart type for restyling: {chart_type}.")
    if native is not None and (chart_type == "auto" or chart_type not in _RESTYLE_CHART_TYPES):
        shape = _file_result_shape(block.config or {})
        if shape is not None:
            if native != "auto":
                ok, why = chart_recommender.fits(shape, native)
                if not ok:
                    label = next((t["label"] for t in chart_recommender.CHART_TYPES if t["type"] == native), native)
                    raise HTTPException(400, f"{label}: this block {why}.")
            _snapshot_block_config(block)
            new_config = _apply_file_chart_choice(block.config or {}, None if native == "auto" else native)
            if not ((new_config.get("recipe") or {}).get("time_grain") and new_config.get("chart_type") in ("line", "area", "bar")):
                new_config.pop("forecast", None)
            for key in ("forecast_enabled", "anomalies_enabled", "anomaly_count"):
                new_config.pop(key, None)
            block.config = new_config
            db.commit()
            db.refresh(d)
            return _builder_out(db, d, user)
        if chart_type not in _RESTYLE_CHART_TYPES:
            raise HTTPException(400, "This chart was saved without its rows, so it cannot be redrawn as another type.")

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

    _snapshot_block_config(block)
    # 2026-09-30 bug fix: build_figure above returns a brand new chart_spec
    # with none of apply_analysis_overlays' forecast/anomaly traces on it -
    # this used to just merge that fresh spec in, leaving a STALE
    # forecast_enabled/anomalies_enabled=true sitting in config with no
    # matching overlay actually drawn (e.g. restyle a line chart with
    # forecast on to a bar chart: the toggle would still read "on" even
    # though nothing was projected on the new bar chart, and switching back
    # to a line chart later would show a checked-but-never-recomputed
    # toggle). A restyle is a genuinely different chart, so any prior
    # overlay decision no longer honestly applies to it - clear it the same
    # way idempotent re-runs of apply_analysis_overlays already do, rather
    # than carrying a flag forward that no longer matches what's drawn.
    restyled_recipe = (block.config or {}).get("recipe")
    block.config = {
        **block.config,
        # 2026-10-07: a recipe block is recomputed from its recipe on every
        # filter change - the recipe has to say the new chart type too, or
        # the first filter draws the old one again.
        **({"recipe": {**restyled_recipe, "chart_type": chart_type}} if isinstance(restyled_recipe, dict) and not restyled_recipe.get("metric_id") else {}),
        "chart_spec": new_spec,
        # 2026-10-01 (filter-engine fix round): restyle always targets one
        # of _RESTYLE_CHART_TYPES, so the new type is already known with
        # certainty here - stamping it keeps config["chart_type"] in sync
        # with what was actually just rebuilt, so a later filter change
        # rebuilds THIS type, not whatever the block used to be.
        "chart_type": chart_type,
        "forecast_enabled": False,
        "anomalies_enabled": False,
        "anomaly_count": None,
    }
    # The person picked this form (chart-types round); a native forecast
    # is drawn on a line / area / bar only.
    block.config = {k: v for k, v in block.config.items() if k not in ("chart_auto", "chart_checked", "chart_reason")
                    and not (k == "forecast" and chart_type not in ("line", "area", "bar"))}
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

    _snapshot_block_config(block)
    block.config = {**(block.config or {}), "accent_color": color or None}

    db.commit()
    db.refresh(d)
    return _builder_out(db, d, user)


@router.patch("/{dashboard_id}/blocks/{block_id}/analysis", response_model=schemas.DashboardBuilderOut)
def set_block_analysis(
    dashboard_id: str,
    block_id: str,
    payload: schemas.SetBlockAnalysisRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """The "Show forecast" / "Show anomalies" chart-block kebab-menu
    toggles (2026-09-28). This is a SEPARATE endpoint from restyle_block
    and set_block_accent_color above for the same reason each of those is
    separate from the generic update_block: update_block replaces a
    block's whole `config`, which would silently wipe out whatever real
    computed data (chart_spec, result_columns/result_rows, recipe, ...) is
    already sitting there.

    But this is also a genuinely different kind of change from either of
    those two siblings, not just another copy of the same pattern:
    restyle_block rebuilds chart_spec from scratch from the block's tidy
    data (a different chart TYPE), and set_block_accent_color only ever
    touches a plain string field. This endpoint instead hands the block's
    EXISTING chart_spec to chart_builder.apply_analysis_overlays and gets
    a MODIFIED chart_spec back (the same figure, with 0-2 extra traces
    drawn on top) - a presentation/analysis LENS on already-built data, not
    a data recompute and not a wholesale rebuild. Like set_block_accent_color,
    this deliberately does NOT touch data_updated_at (see
    models.DashboardBlock's own docstring for why that column is reserved
    for real content changes only) - toggling a forecast on or off doesn't
    change what the chart's real numbers are, only how they're drawn.
    """
    d = _get_dashboard_v2(db, user, dashboard_id, require_edit=True)
    block = _get_block(db, d, block_id)

    if block.type != "chart":
        raise HTTPException(400, "Forecast and anomaly toggles are only available on chart blocks.")

    # 2026-10-07 (chart-types round): a block the native renderer draws as
    # a time series takes the native forecast (config.forecast - what the
    # "Forecast..." sheet sets through PATCH .../forecast); only a chart
    # that is still a stored Plotly figure keeps the overlay below.
    grain = _block_time_grain(d, block)
    if grain is not None:
        _snapshot_block_config(block)
        config = {k: v for k, v in (block.config or {}).items() if k not in ("forecast_enabled", "anomalies_enabled", "anomaly_count")}
        if payload.forecast_enabled or payload.anomalies_enabled:
            previous = config.get("forecast") if isinstance(config.get("forecast"), dict) else {}
            config["forecast"] = {**_default_forecast_options(grain), **previous, "anomalies": bool(payload.anomalies_enabled)}
        else:
            config.pop("forecast", None)
        block.config = config
        db.commit()
        db.refresh(d)
        return _builder_out(db, d, user)

    existing_spec = (block.config or {}).get("chart_spec")
    if not existing_spec:
        raise HTTPException(400, "This chart doesn't have a spec to analyze yet.")

    try:
        new_spec, anomaly_count = chart_builder.apply_analysis_overlays(
            existing_spec, payload.forecast_enabled, payload.anomalies_enabled
        )
    except ValueError as e:
        raise HTTPException(400, str(e))

    _snapshot_block_config(block)
    block.config = {
        **(block.config or {}),
        "chart_spec": new_spec,
        "forecast_enabled": payload.forecast_enabled,
        "anomalies_enabled": payload.anomalies_enabled,
        "anomaly_count": anomaly_count,
    }

    db.commit()
    db.refresh(d)
    return _builder_out(db, d, user)


def _file_result_shape(config: dict) -> dict | None:
    """The recommender's shape for a FILE chart block, read off its recipe
    and its stored rows (the values decide, as on a warehouse run)."""
    recipe = config.get("recipe") if isinstance(config.get("recipe"), dict) else None
    rows = config.get("result_rows")
    cols = [c.get("name") for c in (config.get("result_columns") or []) if isinstance(c, dict)]
    if not recipe or not isinstance(rows, list) or not cols:
        return None
    if isinstance(config.get("bins"), dict):
        return {"time": None, "dims": [], "measures": [{"name": "count", "additive": True, "unit": "number"}], "bins": True,
                "target": False, "negative": False, "max_ratio": None}
    groups = [g for g in (recipe.get("group_by") or []) if g] or ([recipe["group_by_column"]] if recipe.get("group_by_column") else [])
    groups = [g for g in groups if g in cols]
    measure_cols = [c for c in cols if c not in groups]
    listed = [m for m in (recipe.get("measures") or []) if isinstance(m, dict)]
    aggs = {m.get("alias"): m.get("agg") for m in listed} if listed else {c: recipe.get("agg") for c in measure_cols}
    timed = bool(recipe.get("time_grain")) and bool(groups)
    result = {
        "rows": rows, "dimensions": groups[1:] if timed else groups, "measures": measure_cols,
        "time_column": groups[0] if timed else None, "period": recipe.get("time_grain") if timed else None,
    }
    spec = {"measures": [{"alias": c, "agg": aggs.get(c) or "sum"} for c in measure_cols]}
    return chart_recommender.shape_from_result(result, spec)


def _apply_file_chart_choice(config: dict, asked: str | None) -> dict:
    """config with chart_type / chart_reason / chart_auto set by the
    recommender for a file chart's rows (see _choose_chart)."""
    shape = _file_result_shape(config)
    if shape is None:
        return config
    hint = (asked or "").strip().lower()
    hint = None if hint in ("", "auto") else hint
    choice = _choose_chart(shape, hint, True, "build-manual (file)")
    out = dict(config)
    chart_type = choice["chart_type"] if choice["block_type"] in ("chart", "donut") else ("line" if shape.get("time") else "bar")
    out["chart_type"] = chart_type
    out["chart_reason"] = choice["reason"]
    if hint and chart_type == chart_recommender.normalize_chart_type(hint):
        out.pop("chart_auto", None)
    else:
        out["chart_auto"] = True
        out["chart_checked"] = True
    if isinstance(out.get("recipe"), dict):
        out["recipe"] = {**out["recipe"], "chart_type": chart_type}
    return out


def _block_time_grain(d: models.Dashboard, block: models.DashboardBlock) -> str | None:
    """The grain of the block's time axis, or None when it has none: a
    warehouse spec's time bucket (or a KPI's sparkline over the
    dashboard's date column), a file recipe's time_grain."""
    config = block.config or {}
    spec = config.get("spec") if isinstance(config.get("spec"), dict) else None
    if spec:
        if isinstance(spec.get("time"), dict) and spec["time"].get("column"):
            return spec["time"].get("grain") or "month"
        if block.type in ("kpi", "sparkline") and spec.get("sparkline"):
            return d.default_period or "month"
        return None
    layout = _file_series_layout(config)
    return layout["grain"] if layout else None


@router.patch("/{dashboard_id}/blocks/{block_id}/forecast", response_model=schemas.DashboardBuilderOut)
def set_block_forecast(
    dashboard_id: str,
    block_id: str,
    payload: schemas.SetBlockForecastRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """The "Forecast..." sheet (2026-10-07): turns the forecast of a
    time-series block on or off and stores its options on
    config.forecast = {horizon, interval, anomalies}. Nothing is computed
    here: the next run of the block carries `forecast` and `anomalies`
    in its result (services/dashboard_engine.attach_time_analysis); a
    file block's are computed from its stored series when the dashboard
    is read (_decorate_file_time_series). A block with no time axis is
    refused with the reason. Does not touch data_updated_at - the block's
    numbers are unchanged."""
    d = _get_dashboard_v2(db, user, dashboard_id, require_edit=True)
    block = _get_block(db, d, block_id)
    grain = _block_time_grain(d, block)
    if block.type not in ("chart", "kpi", "sparkline") or grain is None:
        raise HTTPException(400, "A forecast needs a measure over time - this block has no date axis. Add a time bucket in \"Edit query\" first.")
    if payload.interval not in forecast_svc.INTERVALS:
        raise HTTPException(400, 'interval must be "80", "95" or "both".')
    _snapshot_block_config(block)
    config = dict(block.config or {})
    if payload.enabled:
        g = grain if grain in forecast_svc.GRAINS else "month"
        horizon = payload.horizon or forecast_svc.DEFAULT_HORIZON[g]
        if horizon > forecast_svc.MAX_HORIZON[g]:
            raise HTTPException(400, f"A forecast by {g} can look at most {forecast_svc.MAX_HORIZON[g]} {forecast_svc.GRAIN_PLURAL[g]} ahead.")
        config["forecast"] = {"horizon": int(horizon), "interval": payload.interval, "anomalies": bool(payload.anomalies)}
        # A forecast is drawn on a line (history solid, forecast dashed).
        if block.type == "chart" and config.get("chart_type") not in ("line", "area", "bar", "step_line"):
            config["chart_type"] = "line"
    else:
        config.pop("forecast", None)
    # The old Plotly overlay flags describe a figure nobody draws any more.
    for key in ("forecast_enabled", "anomalies_enabled", "anomaly_count"):
        config.pop(key, None)
    block.config = config
    db.commit()
    db.refresh(d)
    return _builder_out(db, d, user)


@router.post("/forecast/series", response_model=dict)
def forecast_series_endpoint(
    payload: schemas.ForecastSeriesRequest,
    user: models.User = Depends(get_current_user),
):
    """A forecast of a series the caller already holds - the chat
    workspace's "Add forecast" on an answer that is a time series (its
    aggregated rows are already on the page; nothing is queried). The same
    forecaster, the same refusals, the same result shape as a block's
    `forecast` + `anomalies`."""
    items = payload.series or ([schemas.ForecastSeriesItem(key=payload.measure, values=payload.values)] if payload.values else [])
    if not items:
        raise HTTPException(400, "Send the series to forecast: values, or series.")
    if any(len(it.values) != len(payload.periods) for it in items):
        raise HTTPException(400, "periods and values must be the same length.")
    if len({it.key for it in items}) != len(items):
        raise HTTPException(400, "Every series needs its own key.")
    grain = payload.grain if payload.grain in forecast_svc.GRAINS else "month"
    options = forecast_svc.normalize_options(
        {"horizon": payload.horizon, "interval": payload.interval, "anomalies": payload.anomalies}, grain)
    kind = {"additive": payload.additive, "rate": payload.rate}
    series_column = None
    if payload.series and payload.series_by:
        # One measure split by a breakdown column: a row per (period, series).
        series_column = "series"
        rows = [
            {"period": p, "series": it.key, payload.measure: v}
            for it in items for p, v in zip(payload.periods, it.values) if v is not None
        ]
        measures = [{"alias": payload.measure, **kind}]
    else:
        rows = [{"period": p, **{it.key: it.values[i] for it in items}} for i, p in enumerate(payload.periods)]
        measures = [{"alias": it.key, **kind} for it in items]
    from datetime import date as _date
    return forecast_svc.forecast_result(rows, "period", measures, series_column, grain, options, today=_date.today())


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

    Every filterable block on this page is recomputed against the data
    filtered by `payload.filters` and returned; every other block on the
    page (a kpi with no recorded aggregation to re-derive, text, the
    filter blocks themselves) is simply left out of the response, and the
    frontend leaves whatever it's currently showing for those alone. A
    block that fails to recompute for any reason (a filter happens to
    remove every matching row, a stale group-by column, etc.) is also
    just left out, rather than failing the whole request over one block -
    the frontend's existing content for it stays put.

    2026-09-29 (thought-leader filters round): "chart wise filters" -
    Gokul's own words. Two ways a block responds to a filter now, not
    just one:
      - a stored `recipe` (build_manual_block) - unchanged from before,
        recomputed straight from the live, filtered `df` below.
      - no recipe, but real tidy result_columns/result_rows are still
        attached (an AI-built table or chart - see _block_config/
        _ai_result_to_block, both of which store this alongside
        chart_spec) - filtered directly from that block's OWN already-
        computed rows (never a live re-query, never a second AI call), so
        this is always a real subset of what analyze() actually found,
        never a fabricated or re-guessed number. Deliberately excludes
        "kpi": a kpi's config.value is a single number with no recorded
        aggregation function (sum/avg/count/...) attached to it, so there
        is no honest way to know what a "filtered" version of it should
        even mean - showing SOME number there anyway would risk it being
        the wrong one, worse than the honest "not filter-aware yet"
        status quo it keeps instead.

    2026-09-29 (Hex-level filters round): `payload.block_filters` -
    "per-chart filtering." Extra criteria scoped to just ONE block,
    layered on top of `payload.filters` for that block only - a chart can
    now be sliced further than whatever the page-wide filter bar shows,
    without that extra slice affecting any other block on the page. Every
    criterion (page-wide or per-chart) also supports the Data tab's full
    operator vocabulary now, not just equality - see FilterCriterion's own
    docstring and _apply_filters above for the "ranges, multi-select"
    part of this round. `matched_rows` below stays PAGE-WIDE only (never
    narrowed by a per-chart filter) - it's meant to answer "how much of
    the dataset does the page-wide filter bar currently show," which a
    single chart's own extra slice has no bearing on."""
    d = _get_dashboard_v2(db, user, dashboard_id)  # view access only
    page = next((p for p in d.pages if p.id == page_id), None)
    if not page:
        raise HTTPException(404, "Page not found on this dashboard.")

    # 2026-10-02 fix: the live datasource is now OPTIONAL for this request,
    # not required for the whole thing. d.source_conversation_id is "purely
    # for reference... never required" (see Dashboard's own docstring) -
    # every block's own config is meant to be self-contained - but this
    # endpoint used to abort the ENTIRE request, every block on the page,
    # the instant _resolve_datasource_for_read couldn't resolve a
    # datasource through it (which happens whenever the dashboard's
    # original chat/analysis has since been deleted, archived, or is
    # otherwise unreachable - not rare on an older dashboard). An AI-built
    # chart/table block never touches `df` at all below - it recomputes
    # entirely from its own already-stored tidy result_columns/result_rows
    # - so it was being taken down by a failure it never actually depended
    # on. Only a `recipe`-based block (built manually, or backed by a saved
    # metric/transform) genuinely needs the live `df` to recompute against;
    # see the `if recipe and df is None: continue` guard below for how that
    # one real dependency is now handled per-block instead of up front.
    ds = _resolve_datasource_for_read(db, user, d)
    # 2026-10-06 (warehouse-native dashboards layer): for a warehouse/
    # database source the live rows are NEVER loaded into the app -
    # load_dataframe would have pulled a row-capped SAMPLE here and
    # recomputed recipe blocks on it, which the product rule forbids.
    # Instead every block with a spec is computed inside the warehouse
    # with these same filters pushed into its SQL (the engine), and
    # df stays None so a recipe block is honestly left out rather than
    # computed on a sample. The existing frontend keeps working on this
    # endpoint until the redesigned view (which calls /run) lands.
    if ds and dashboard_engine.is_warehouse_native(ds):
        return _filter_page_blocks_warehouse(db, d, page, ds, payload, user.id)
    df = None
    if ds:
        try:
            df = load_dataframe(ds, table=None, version="original", db=db)
            df = data_access_rules.filter_dataframe_for_role(db, df, ds, user)
        except Exception:
            df = None

    out = _filter_page_blocks(db, page, df, ds, payload, dashboard=d)
    return _with_file_colors(db, d, page, out, payload, anonymous=False)


def _with_file_colors(
    db: Session, d: models.Dashboard, page: models.DashboardPage, out: schemas.FilteredBlocksOut,
    payload: schemas.ApplyFiltersRequest, anonymous: bool,
) -> schemas.FilteredBlocksOut:
    """2026-10-07 (identity-colour round): the file-dashboard half of the
    colour registry (see services/appearance.py, rule 7). The results the
    page's blocks STORE are always registered - they are the dashboard's
    own content. The filtered copies this request produced are registered
    for a signed-in viewer, and for an anonymous one only when the request
    carried no filter at all (then they are the same canonical results)."""
    try:
        obs = appearance_svc.Observations()
        for block in page.blocks:
            appearance_svc.observe_stored_block(obs, block.type, block.config)
        if not anonymous or (not payload.filters and not payload.block_filters):
            for fb in out.blocks:
                appearance_svc.observe_stored_block(obs, fb.type, fb.config)
        doc = appearance_svc.assign_colors(db, d, obs)
        out.colors = appearance_svc.registry_payload(doc if doc is not None else getattr(d, "appearance", None))
    except Exception as e:  # colour must never fail a filter request
        print(f"[dashboard_builder] colour registry skipped (non-fatal): {e}")
    return out


# 2026-10-05 (public-filters round): factored out of preview_filtered_blocks
# above so the authenticated editor path and the new anonymous public-link
# path (preview_filtered_blocks_public below) share the exact same
# per-block recompute logic instead of two copies that could silently
# drift apart. Takes an ALREADY-resolved df/ds (either may be None) rather
# than a `user` - preview_filtered_blocks resolves them via the logged-in
# user's own workspace access; preview_filtered_blocks_public always
# passes df=None, ds=None (see that function's own docstring for why
# that's a deliberate security boundary, not a missing feature - a
# recipe-based block is skipped below exactly like it already is when the
# editor's own live datasource fails to load, and a self-contained
# AI-built table/chart block never reads df/ds at all).
def _date_bound_columns(d: models.Dashboard | None) -> list[str]:
    """The columns a dashboard's date pickers range over: its own date
    column (the header's range) and every date_range control on the rail."""
    if d is None:
        return []
    out: list[str] = []
    if d.date_column:
        out.append(d.date_column)
    for p in (d.parameters or []) if isinstance(d.parameters, list) else []:
        if isinstance(p, dict) and p.get("control") == "date_range" and p.get("column") and p["column"] not in out:
            out.append(p["column"])
    return out


def _file_date_bounds(d: models.Dashboard | None, ds: models.DataSource | None, df: pd.DataFrame | None) -> dict:
    """{column: {"min": "YYYY-MM-DD", "max": "YYYY-MM-DD"}} for a FILE
    dashboard's date columns, from the complete, UNFILTERED frame - what
    the date pickers open on and disable days outside of (2026-10-07: a
    picker used to open on today's month for data that ends years ago).
    Cached with the options TTL; a column with no dates is left out."""
    columns = _date_bound_columns(d)
    if df is None or not columns:
        return {}
    out: dict = {}
    for column in columns:
        if column not in df.columns:
            continue
        key = ("file-date-bounds", getattr(ds, "id", None), column, int(len(df)))
        hit = dashboard_engine._options_cache.get(key)
        if hit is None:
            try:
                series = df[column]
                if not pd.api.types.is_datetime64_any_dtype(series):
                    series = pd.to_datetime(series, errors="coerce")
                series = series.dropna()
                hit = {"min": series.min().strftime("%Y-%m-%d"), "max": series.max().strftime("%Y-%m-%d")} if len(series) else {}
            except Exception as e:
                print(f"[dashboard_builder] date bounds for {column!r} could not be read (non-fatal): {e}")
                hit = {}
            dashboard_engine._options_cache.put(key, hit)
        if hit:
            out[column] = hit
    return out


def _filter_page_blocks(
    db: Session,
    page: models.DashboardPage,
    df: pd.DataFrame | None,
    ds: models.DataSource | None,
    payload: schemas.ApplyFiltersRequest,
    dashboard: models.Dashboard | None = None,
) -> schemas.FilteredBlocksOut:
    active_filters = payload.filters[:_MAX_FILTERS_PER_REQUEST]
    date_bounds = _file_date_bounds(dashboard, ds, df)
    if df is not None:
        df = _apply_filters(df, active_filters)

    # Per-chart filters - capped defensively (a real dashboard page has
    # nowhere near this many blocks or per-block criteria; see
    # ApplyFiltersRequest.block_filters' own docstring in schemas.py).
    block_filters: dict[str, list] = {
        block_id: crits[:_MAX_FILTERS_PER_REQUEST]
        for block_id, crits in list(payload.block_filters.items())[:20]
    }

    out: list[schemas.FilteredBlockOut] = []
    for block in page.blocks:
        own_filters = block_filters.get(block.id) or []
        recipe = (block.config or {}).get("recipe")
        if recipe and df is None:
            # 2026-10-02 fix: the live datasource couldn't be loaded this
            # request - a recipe-based block has no other source of truth
            # to recompute from, so it's left out exactly like any other
            # block this endpoint can't currently recompute (see this
            # function's own docstring above). A self-contained AI-built
            # table/chart block further down is NOT affected by this at
            # all - it never reads `df`.
            continue
        # 2026-09-30 (semantic layer v1): a metric-backed kpi/gauge
        # (recipe["metric_id"] set - see build_manual_block) is looked up
        # fresh here every time, not just recomputed from a frozen column/
        # agg pair - so editing the metric's own definition, not just
        # changing a page filter, is also reflected live the next time
        # this page's filters are (re)applied. A metric that's since been
        # deleted is treated exactly like any other block this endpoint
        # can't currently recompute: left out of the response, the
        # frontend's existing content for it stays put (see this
        # function's own docstring above).
        # 2026-09-30 (transformation layer v1): a recipe built from a saved
        # transform (recipe["transform_id"] set - see build_manual_block)
        # is re-applied fresh here too, before either branch below runs -
        # so editing the TRANSFORM's own steps, not just changing a page
        # filter, is also reflected live the next time this page's filters
        # are (re)applied. A transform that's since been deleted, or that
        # now fails to resolve (e.g. a column it references was renamed),
        # is treated exactly like any other block this endpoint can't
        # currently recompute: left out of the response, the frontend's
        # existing content for it stays put (see this function's own
        # docstring above).
        base_df = df
        if recipe and recipe.get("transform_id"):
            transform = (
                db.query(models.DataTransform)
                .filter(models.DataTransform.id == recipe["transform_id"], models.DataTransform.datasource_id == ds.id)
                .first()
            )
            if not transform:
                continue
            base_df, transform_error = apply_transform_steps(df, transform.steps or [])
            if transform_error:
                continue

        if recipe and recipe.get("metric_id"):
            metric = (
                db.query(models.MetricDefinition)
                .filter(models.MetricDefinition.id == recipe["metric_id"], models.MetricDefinition.datasource_id == ds.id)
                .first()
            )
            if not metric:
                continue
            try:
                block_df = _apply_filters(base_df, own_filters)
                actual_type, config, _default_title = _metric_kpi_or_gauge_config(
                    metric, recipe.get("block_type") or block.type, block_df,
                    recipe.get("target_value"), recipe.get("max_value"), recipe.get("transform_id"),
                )
            except Exception:
                continue
            out.append(schemas.FilteredBlockOut(id=block.id, type=actual_type, config=config))
            continue
        if recipe:
            try:
                block_df = _apply_filters(base_df, own_filters)
                actual_type, config, _default_title = _run_manual_recipe(block_df, recipe, existing_title=block.title)
            except Exception:
                continue
            out.append(schemas.FilteredBlockOut(id=block.id, type=actual_type, config=config))
            continue

        if block.type not in ("table", "chart"):
            continue
        cols = (block.config or {}).get("result_columns")
        rows = (block.config or {}).get("result_rows")
        if not cols or not rows:
            continue
        try:
            block_df = pd.DataFrame(rows, columns=[c["name"] for c in cols])
            block_df = _apply_filters(block_df, active_filters)
            block_df = _apply_filters(block_df, own_filters)
        except Exception:
            continue

        if block.type == "table":
            out.append(schemas.FilteredBlockOut(
                id=block.id, type="table",
                config={
                    "columns": [c.get("name") for c in cols],
                    "rows": block_df.to_dict("records")[:_MAX_TABLE_ROWS_PER_BLOCK],
                    "truncated": len(block_df) > _MAX_TABLE_ROWS_PER_BLOCK,
                },
            ))
            continue

        # A chart block: rebuild the SAME chart type it already is - never
        # guessed, and never silently switched to a different type just
        # because a filter changed. 2026-10-01 (filter-engine fix round):
        # prefer the chart_type stored directly on the block (stamped by
        # _ai_result_to_block_shape/_block_config_shape/restyle_block as of
        # this round) and only fall back to detecting it from the rendered
        # spec for an older block saved before that existed (see
        # _detect_restyle_chart_type's own docstring for what that
        # detection does and doesn't catch). Either way, a type outside
        # _FILTER_REBUILD_CHART_TYPES (a heatmap, a funnel, any shape this
        # app can't safely reconstruct from the block's own stored tidy
        # data) is left out here exactly like a block with no recipe
        # always has been - it keeps showing its real, unfiltered content
        # rather than a mis-rebuilt one.
        chart_type = (block.config or {}).get("chart_type") or _detect_restyle_chart_type(
            (block.config or {}).get("chart_spec") or {}
        )
        if not chart_type or chart_type not in _FILTER_REBUILD_CHART_TYPES:
            continue
        try:
            new_spec = _rebuild_filtered_chart_spec(block_df, chart_type, block.title or "")
        except Exception:
            continue
        # 2026-10-07: the filtered ROWS go back too (not only the rebuilt
        # figure) - the dashboard draws its native chart from them, and the
        # block's CSV export is then the filtered result as well.
        try:
            filtered_rows = json.loads(block_df.to_json(orient="records", date_format="iso"))
        except Exception:
            filtered_rows = None
        out.append(schemas.FilteredBlockOut(
            id=block.id, type="chart",
            config={**(block.config or {}), "chart_spec": new_spec, "chart_type": chart_type,
                    **({"result_rows": filtered_rows} if filtered_rows is not None else {})},
        ))

    # 2026-09-25e (elite pass): `df` above already has payload.filters
    # applied (or is the untouched full dataset when payload.filters is
    # empty - _apply_filters is a no-op on an empty list) - len(df) is
    # therefore the real, exact row count either way, at zero extra query
    # cost. See FilteredBlocksOut.matched_rows for what the frontend does
    # with this.
    #
    # 2026-10-02 fix: `df` can now genuinely be None (the live datasource
    # couldn't be loaded this request) - matched_rows is None in that case,
    # NOT a fabricated 0. A literal 0 means "the filter bar matched zero
    # rows," which is a real, meaningful answer the frontend should show;
    # None means "no count available right now," which the frontend's
    # existing `!== null` guard already knows how to hide instead of
    # rendering as a misleading "0 rows match."
    for fb in out:
        fb.config = _decorate_file_time_series(fb.type, fb.config)
    return schemas.FilteredBlocksOut(blocks=out, matched_rows=len(df) if df is not None else None, date_bounds=date_bounds)


# ============================================================================
# 2026-10-06 (warehouse-native dashboards layer).
#
# The product rule: for a warehouse/database source rows are NEVER loaded
# into GD360 for analysis. A dashboard on such a source computes EVERY
# block inside the warehouse, with the page's filter rail pushed into the
# SQL, on every refresh/filter change - services/dashboard_engine.py.
# What lives here is the HTTP surface around that engine:
#
#   POST  /{id}/pages/{page_id}/run                 run every warehouse block
#   GET   /{id}/parameters/{param_id}/options       a rail control's values+counts
#   PATCH /{id}/parameters                          the filter rail definition
#   PATCH /{id}/saved-views                         named rail states
#   POST  /{id}/blocks/{block_id}/spec              set/replace a block's BlockSpec
#   GET   /{id}/blocks/{block_id}/sql               "Show SQL" for the current filters
#   POST  /{id}/upgrade-blocks                      give pre-layer blocks a spec
#   (+ public slug/hostname twins of run and options further down)
#
# A block's spec lives in block.config["spec"]; the last compiled SQL and
# the last run's cost live on the row (DashboardBlock.query_sql/last_run -
# see that model's docstring for why not inside config).
# ============================================================================

_PARAM_CONTROLS = {"chips", "multi", "search", "segmented", "range", "date_range", "checkboxes"}
_DATA_BLOCK_TYPES = {"chart", "table", "kpi", "gauge", "donut", "sparkline", "avatar_list"}
# 2026-10-07 (analyst canvas round): every block type create_block accepts.
# "sql" and "input" are the two cell kinds the canvas adds - see models.
# DashboardBlock and the "Canvas cells" section of this module's docstring.
_ALL_BLOCK_TYPES = _DATA_BLOCK_TYPES | {"text", "filter", "heading", "divider", "sql", "input"}
# 2026-10-07 (chart-types round): every chart form the native renderer
# draws (services/chart_recommender.CHART_TYPES) plus "auto" - "swap to
# best", the recommender's own pick for the block's current result.
_SWAP_CHART_TYPES = set(chart_recommender.BLOCK_CHART_TYPES) | {"auto"}
_PUBLIC_RUN_RATE_LIMIT = 30  # per minute per ip / per slug - every run is real warehouse work


def _column_exists_anywhere(db: Session, ds: models.DataSource, column: str) -> bool:
    versions = dashboard_engine.load_versions(db, ds)
    schema, _ = query_builder.with_version_aliases(ds.schema_cache, versions)
    return any(any(c["name"] == column for c in (query_builder.table_columns(schema, t) or [])) for t in schema)


def _warehouse_page_blocks(page: models.DashboardPage, block_ids: list[str] | None = None) -> tuple[list[dict], list[str]]:
    """([{"id", "spec"}] for every data block on the page that has a
    spec, [ids of data blocks without one])."""
    wanted = set(block_ids) if block_ids else None
    runnable, skipped = [], []
    # 2026-10-07 (analyst canvas round): a sql cell and a block bound to
    # one (config.source_block_id) run too. A dependency is always pulled
    # in even when `block_ids` narrows the run, so a re-run of one chart
    # still has its source cell's result.
    by_id = {b.id: b for b in page.blocks}
    needed: set[str] = set()
    if wanted is not None:
        pending = list(wanted)
        while pending:
            bid = pending.pop()
            b = by_id.get(bid)
            if not b or bid in needed:
                continue
            needed.add(bid)
            cfg = b.config or {}
            if cfg.get("source_block_id"):
                pending.append(cfg["source_block_id"])
            if b.type == "sql":
                for nm in dashboard_engine.referenced_cells(cfg.get("sql") or ""):
                    src = next((o for o in page.blocks if o.type == "sql" and (o.config or {}).get("name") == nm), None)
                    if src:
                        pending.append(src.id)
    for block in page.blocks:
        if wanted is not None and block.id not in needed:
            continue
        config = block.config or {}
        if block.type == "sql":
            runnable.append({"id": block.id, "type": "sql", "sql": config.get("sql") or "", "name": config.get("name")})
            continue
        if block.type not in _DATA_BLOCK_TYPES:
            continue
        if config.get("source_block_id"):
            runnable.append({"id": block.id, "type": block.type, "source_block_id": config["source_block_id"]})
            continue
        spec = config.get("spec")
        if isinstance(spec, dict) and spec.get("table"):
            entry = {"id": block.id, "spec": spec}
            # 2026-10-07 (chart-types round): a block with config.forecast
            # gets its forecast (and anomalies) computed with its result.
            if isinstance(config.get("forecast"), dict) and (block.type in ("chart", "kpi", "sparkline")):
                entry["forecast"] = config["forecast"]
                first = (spec.get("measures") or [{}])[0].get("alias")
                if first and config.get("format"):
                    entry["formats"] = {first: config.get("format")}
            runnable.append(entry)
        else:
            skipped.append(block.id)
    return runnable, skipped


def _is_empty_warehouse_block(block) -> bool:
    """True for a data block that was added to a warehouse dashboard and
    has not been built yet: it carries create_block's config.empty marker
    and still has no spec and no bound cell. (A pre-layer block - a stored
    result or a recipe with no spec - never carries the marker.)"""
    config = block.config or {}
    return (
        block.type in _DATA_BLOCK_TYPES and config.get("empty") is True
        and not isinstance(config.get("spec"), dict) and not config.get("source_block_id")
    )


def _dashboard_primary_table(d: models.Dashboard, ds: models.DataSource) -> str | None:
    """The table the page-wide COUNT(*) ("Showing X of Y rows") and the
    filter rail refer to: the most common spec table across the
    dashboard's blocks, else the rail's own table, else the data source's
    first table."""
    counts: dict[str, int] = defaultdict(int)
    for page in d.pages:
        for block in page.blocks:
            spec = (block.config or {}).get("spec")
            if isinstance(spec, dict) and spec.get("table"):
                counts[spec["table"]] += 1
    if counts:
        return max(counts.items(), key=lambda kv: kv[1])[0]
    for p in (d.parameters or []) if isinstance(d.parameters, list) else []:
        if isinstance(p, dict) and p.get("table"):
            return p["table"]
    try:
        return default_table_for_preview(ds)
    except Exception:
        return None


def _is_canonical_run(payload: schemas.RunPageRequest, d: models.Dashboard) -> bool:
    """Nothing in the request shapes what the run computes: no filter, no
    per-chart filter, no date range, no parameter value, every block, the
    dashboard's own period. Then the results are a function of the
    dashboard's definition and data alone."""
    if payload.filters or payload.block_filters or payload.block_ids:
        return False
    if payload.date_range and any(v for v in payload.date_range.as_dict().values()):
        return False
    if any(v not in (None, "", [], {}) for v in (payload.parameters or {}).values()):
        return False
    default = dashboard_engine.normalize_period(None, d.default_period)
    return not payload.period or dashboard_engine.normalize_period(payload.period, d.default_period) == default


def _run_page_for(
    db: Session, d: models.Dashboard, page: models.DashboardPage, ds: models.DataSource,
    payload: schemas.RunPageRequest, user_id: str, persist_last_run: bool, anonymous: bool = False,
    hidden_block_ids: set[str] | None = None,
) -> schemas.RunPageOut:
    """The shared body of the authenticated and public run endpoints.
    `anonymous`: the published link - the run may register new chart
    colours only when it is canonical (services/appearance.py, rule 7).
    `hidden_block_ids` (2026-10-10, company domain row rules): blocks this
    viewer may not see - never compiled, never run."""
    runnable, skipped = _warehouse_page_blocks(page, payload.block_ids)
    if hidden_block_ids:
        runnable = [r for r in runnable if r["id"] not in hidden_block_ids]
        skipped = [b for b in skipped if b not in hidden_block_ids]
    # Reading order (top to bottom, left to right): the order the colour
    # registry meets this page's blocks in, whatever order they ran in.
    reading_order = [(b.id, b.type) for b in sorted(page.blocks, key=lambda b: (b.y or 0, b.x or 0, b.position or 0, b.id))]
    # 2026-10-07 (block editing round): of the skipped (spec-less) data
    # blocks, the ones that are simply empty - see create_block.
    skipped_set = set(skipped)
    empty = [b.id for b in page.blocks if b.id in skipped_set and _is_empty_warehouse_block(b)]
    block_filters = {bid: crits[:_MAX_FILTERS_PER_REQUEST] for bid, crits in list(payload.block_filters.items())[:20]}
    try:
        result = dashboard_engine.run_page(
            db, ds, runnable, page_filters=payload.filters[:12], period=payload.period,
            date_range=payload.date_range.as_dict() if payload.date_range else None, user_id=user_id,
            date_column=d.date_column, block_filters=block_filters, force_refresh=payload.force_refresh,
            count_table=_dashboard_primary_table(d, ds), default_period=d.default_period,
            parameters=dict(list(payload.parameters.items())[:24]) if payload.parameters else None,
            dashboard_parameters=d.parameters if isinstance(d.parameters, list) else [],
        )
    except dashboard_engine.DependencyCycleError as e:
        raise HTTPException(400, str(e))
    if persist_last_run and result["blocks"]:
        by_id = {b.id: b for b in page.blocks}
        changed = _confirm_auto_charts(page, result["blocks"], payload, d)
        for bid, res in result["blocks"].items():
            block = by_id.get(bid)
            if block is None or res.get("status") != "ok":
                continue
            block.last_run = {
                "bytes_scanned": res.get("bytes_scanned"), "duration_ms": res.get("duration_ms"),
                "rows": res.get("row_count"), "ran_at": res.get("ran_at"), "cached": res.get("cached", False),
            }
            changed = True
        if changed:
            try:
                db.commit()
            except Exception as e:
                print(f"[dashboard_builder] last_run persist failed (non-fatal): {e}")
                db.rollback()
    # 2026-10-07 (real end-to-end run): the real first and last date of
    # the dashboard's date column(s) - one cached MIN/MAX query - so the
    # date pickers open on the data, not on today. A partial run (one
    # block) does not repeat it.
    date_bounds: dict = {}
    if not payload.block_ids:
        table = _dashboard_primary_table(d, ds)
        params = [p for p in (d.parameters or []) if isinstance(p, dict)] if isinstance(d.parameters, list) else []
        by_table: dict[str, list[str]] = defaultdict(list)
        for column in _date_bound_columns(d):
            owner = next((p.get("table") for p in params if p.get("column") == column and p.get("table")), None) or table
            if owner and column not in by_table[owner]:
                by_table[owner].append(column)
        for owner, columns in by_table.items():
            date_bounds.update(dashboard_engine.column_bounds(db, ds, owner, columns, user_id=user_id))
    # 2026-10-07 (identity-colour round): the values this run's charts and
    # donuts showed, in the order of their measure, get their palette slot
    # here - before the response leaves, so the page colours them at once.
    colors = None
    try:
        obs = appearance_svc.Observations()
        if not anonymous or _is_canonical_run(payload, d):
            for bid, btype in reading_order:
                res = result["blocks"].get(bid)
                if res is not None:
                    appearance_svc.observe_result(obs, btype, res)
        doc = appearance_svc.assign_colors(db, d, obs)
        colors = appearance_svc.registry_payload(doc if doc is not None else getattr(d, "appearance", None))
    except Exception as e:
        print(f"[dashboard_builder] colour registry skipped (non-fatal): {e}")
    return schemas.RunPageOut(
        blocks=result["blocks"], matched_rows=result["matched_rows"], total_rows=result.get("total_rows"),
        computed_in=result["computed_in"], total_duration_ms=result["total_duration_ms"], period=result["period"],
        date_range=result.get("date_range"), skipped_block_ids=skipped, empty_block_ids=empty,
        dependencies=result.get("dependencies") or {}, order=result.get("order") or [],
        parameters_used=result.get("parameters_used") or {}, missing_parameters=result.get("missing_parameters") or [],
        date_bounds=date_bounds, colors=colors,
    )


def _confirm_auto_charts(page: models.DashboardPage, results: dict, payload: schemas.RunPageRequest, d: models.Dashboard) -> bool:
    """A chart type GD360 chose before the block had run (config.chart_auto
    without chart_checked: a proposal, Ask AI) was chosen from column NAMES
    and types. The first unfiltered run has the values, so the same
    recommender is asked again with them - "is this column really
    countries, and more than six of them?" - and the block's type is
    corrected if the data says otherwise (logged). Done once
    (chart_checked), on an unfiltered run only, so a filter never changes
    a chart's form. The frontend applies the same rule to the same result
    (charts/recommend.ts), so the page it draws right now already agrees.
    Returns True when a block changed."""
    if not _is_canonical_run(payload, d):
        return False
    changed = False
    for block in page.blocks:
        config = block.config or {}
        if block.type not in ("chart", "donut") or not config.get("chart_auto") or config.get("chart_checked"):
            continue
        res = results.get(block.id)
        if not isinstance(res, dict) or res.get("status") != "ok" or not res.get("rows"):
            continue
        current = "donut" if block.type == "donut" else config.get("chart_type")
        target = isinstance(config.get("target"), (int, float)) and not isinstance(config.get("target"), bool)
        try:
            shape = chart_recommender.shape_from_result(res, config.get("spec"), target=target)
            rec = chart_recommender.recommend(shape)
            ok, why = chart_recommender.fits(shape, current) if current else (False, "has no chart type")
        except Exception as e:
            print(f"[dashboard_builder] auto chart check skipped for block {block.id} (non-fatal): {e}")
            continue
        new_config = {**config, "chart_checked": True}
        if (not ok or (rec["strength"] == "strong" and rec["chart_type"] != current)) and rec["block_type"] in ("chart", "donut"):
            print(f"[dashboard_builder] chart type corrected on first run (block {block.id}): {current!r} -> "
                  f"{rec['chart_type']!r} ({rec['reason']}{'' if ok else '; ' + str(why)})")
            new_config["chart_reason"] = rec["reason"]
            if rec["block_type"] == "donut":
                block.type = "donut"
                new_config.pop("chart_type", None)
            else:
                block.type = "chart"
                new_config["chart_type"] = rec["chart_type"]
        elif ok and rec["chart_type"] == current:
            new_config["chart_reason"] = rec["reason"]
        block.config = new_config
        changed = True
    return changed


def _block_result_to_filtered(block: models.DashboardBlock, res: dict) -> schemas.FilteredBlockOut | None:
    """Reshapes a BlockResult into the FilteredBlockOut config the
    existing frontend renders for each block type, so preview-filtered
    keeps working for a warehouse dashboard until the new view lands."""
    if res.get("status") != "ok":
        return None
    rows, measures = res.get("rows") or [], res.get("measures") or []
    config = block.config or {}
    if block.type in ("kpi", "gauge"):
        if not rows or not measures:
            return None
        value = rows[0].get(measures[0])
        out = {**config, "value": value, "label": config.get("label") or measures[0]}
        delta = (res.get("delta") or {}).get(measures[0]) if res.get("delta") else None
        if delta:
            out["prior_value"] = delta.get("prior")
            out["delta_pct"] = delta.get("pct")
        if res.get("sparkline") and res["sparkline"].get("rows"):
            out["sparkline_series"] = [r.get(measures[0]) for r in res["sparkline"]["rows"]]
        return schemas.FilteredBlockOut(id=block.id, type=block.type, config=out)
    columns = [c["name"] for c in res.get("columns") or []]
    if block.type == "table":
        return schemas.FilteredBlockOut(id=block.id, type="table", config={
            "columns": columns, "rows": rows[:_MAX_TABLE_ROWS_PER_BLOCK],
            "truncated": len(rows) > _MAX_TABLE_ROWS_PER_BLOCK or bool(res.get("truncated")),
        })
    if block.type == "chart":
        chart_type = config.get("chart_type") or ("line" if res.get("time_column") else "bar")
        if chart_type not in _FILTER_REBUILD_CHART_TYPES:
            chart_type = "bar"
        try:
            block_df = pd.DataFrame(rows, columns=columns)
            dims = ([res["time_column"]] if res.get("time_column") else []) + list(res.get("dimensions") or [])
            if len(dims) >= 2 and measures:
                # period/group x measure -> wide (period rows, one column per group)
                block_df = block_df.pivot_table(index=dims[0], columns=dims[1], values=measures[0], aggfunc="sum").reset_index()
                chart_type = chart_type if chart_type in ("grouped_bar", "stacked_bar", "line", "area") else "grouped_bar"
            elif dims and measures:
                block_df = block_df[[dims[0]] + measures[:1]]
            new_spec = _rebuild_filtered_chart_spec(block_df, chart_type, block.title or "")
        except Exception as e:
            print(f"[dashboard_builder] warehouse chart rebuild failed for block {block.id} (non-fatal): {e}")
            return None
        return schemas.FilteredBlockOut(
            id=block.id, type="chart",
            config={**config, "chart_spec": new_spec, "chart_type": chart_type, "result_columns": [{"name": c} for c in columns],
                    "result_rows": rows[:_MAX_TABLE_ROWS_PER_BLOCK], "computed_in": res.get("computed_in"),
                    "run": {k: res.get(k) for k in ("bytes_scanned", "duration_ms", "row_count", "cached", "exact_total_rows")}},
        )
    return None


def _filter_page_blocks_warehouse(
    db: Session, d: models.Dashboard, page: models.DashboardPage, ds: models.DataSource,
    payload: schemas.ApplyFiltersRequest, user_id: str, anonymous: bool = False,
) -> schemas.FilteredBlocksOut:
    """preview-filtered for a warehouse dashboard: spec'd blocks run in
    the warehouse through the engine; spec-less AI-built blocks keep
    filtering their OWN stored result rows (a real computed result, not a
    sample - unchanged from before); recipe blocks are left out (no live
    rows exist in the app to recompute them on)."""
    run_req = schemas.RunPageRequest(filters=payload.filters, block_filters=payload.block_filters)
    run = _run_page_for(db, d, page, ds, run_req, user_id, persist_last_run=False, anonymous=anonymous)
    out: list[schemas.FilteredBlockOut] = []
    spec_ids = set(run.blocks.keys())
    by_id = {b.id: b for b in page.blocks}
    for bid, res in run.blocks.items():
        shaped = _block_result_to_filtered(by_id[bid], res)
        if shaped:
            out.append(shaped)
    # Spec-less blocks: the pre-layer static path, on their own stored rows.
    static_page = SimpleNamespaceBlocks([b for b in page.blocks if b.id not in spec_ids and not (b.config or {}).get("recipe")])
    static = _filter_page_blocks(db, static_page, None, None, payload)
    out.extend(static.blocks)
    return schemas.FilteredBlocksOut(blocks=out, matched_rows=run.matched_rows, colors=run.colors)


class SimpleNamespaceBlocks:
    """A page stand-in with only `.blocks` - what _filter_page_blocks reads."""

    def __init__(self, blocks):
        self.blocks = blocks


def _validate_parameters(db: Session, ds: models.DataSource | None, params: list) -> list[dict]:
    native = dashboard_engine.is_warehouse_native(ds)
    schema, _ = (query_builder.with_version_aliases(ds.schema_cache, dashboard_engine.load_versions(db, ds)) if native else ({}, set()))
    out: list[dict] = []
    seen: set[str] = set()
    seen_names: set[str] = set()
    for i, p in enumerate(params):
        if not isinstance(p, dict):
            raise HTTPException(400, f"Parameter #{i + 1} is not an object.")
        column = (p.get("column") or "").strip()
        control = (p.get("control") or "chips").strip().lower()
        if not column:
            raise HTTPException(400, f"Parameter #{i + 1} needs a column.")
        if control not in _PARAM_CONTROLS:
            raise HTTPException(400, f'Parameter "{column}": the control must be one of {", ".join(sorted(_PARAM_CONTROLS))}.')
        table = (p.get("table") or "").strip() or None
        if native:
            if table and not query_builder.table_columns(schema, table):
                raise HTTPException(400, f'Parameter "{column}": the table "{table}" is not in this data source.')
            tables = [table] if table else list(schema.keys())
            if not any(any(c["name"] == column for c in (query_builder.table_columns(schema, t) or [])) for t in tables):
                raise HTTPException(400, f'Parameter "{column}": that column is not in this dashboard\'s data source.')
        pid = str(p.get("id") or "").strip() or f"p_{secrets.token_hex(4)}"
        if pid in seen:
            raise HTTPException(400, f'Parameter ids must be unique ("{pid}" appears twice).')
        seen.add(pid)
        options_from = p.get("options_from")
        if options_from not in (None, "distinct"):
            raise HTTPException(400, f'Parameter "{column}": options_from must be "distinct" or null.')
        # 2026-10-07 (analyst canvas round): `name` is what a SQL cell
        # references ({{name}} / @name) - a plain identifier, unique on
        # the dashboard; derived from the column when not given.
        name = dashboard_engine.parameter_name({"name": p.get("name"), "column": column})
        if not name or not dashboard_engine._PARAM_NAME_RE.match(name):
            raise HTTPException(400, f'Parameter "{column}": the name must be a plain identifier (letters, digits, underscores).')
        if name in seen_names:
            raise HTTPException(400, f'Parameter names must be unique ("{name}" appears twice).')
        seen_names.add(name)
        out.append({
            "id": pid, "name": name, "column": column, "label": (str(p.get("label") or column))[:80], "control": control,
            "options_from": options_from if options_from else ("distinct" if control in ("chips", "multi", "search", "segmented", "checkboxes") else None),
            "default": p.get("default"), "table": table,
        })
    return out


def _page_cells(page: models.DashboardPage) -> list[dict]:
    return [{"id": b.id, "type": "sql", "sql": (b.config or {}).get("sql") or "", "name": (b.config or {}).get("name")}
            for b in page.blocks if b.type == "sql"]


def _page_graph_blocks(page: models.DashboardPage, override: dict | None = None) -> list[dict]:
    """The page's blocks in run_page's input shape, with `override`
    ({"id", ...}) standing in for the block being edited - what the
    dependency/cycle check runs on before a change is stored."""
    out: list[dict] = []
    for b in page.blocks:
        if override and b.id == override["id"]:
            continue
        cfg = b.config or {}
        if b.type == "sql":
            out.append({"id": b.id, "type": "sql", "sql": cfg.get("sql") or "", "name": cfg.get("name")})
        elif cfg.get("source_block_id"):
            out.append({"id": b.id, "type": b.type, "source_block_id": cfg["source_block_id"]})
        else:
            out.append({"id": b.id, "type": b.type or "spec", "spec": cfg.get("spec")})
    if override:
        out.append(override)
    return out


def _validate_cell_config(
    db: Session, user: models.User, d: models.Dashboard, page: models.DashboardPage, block: models.DashboardBlock,
    config: dict,
) -> dict:
    """2026-10-07 (analyst canvas round): the write-time checks for the
    canvas cell kinds, shared by create_block and update_block:
      - "sql": config.sql is a single read-only SELECT; config.name is a
        plain identifier unique among the page's sql cells (derived from
        the title when missing); every {{param}} / @param it references
        is a dashboard parameter; every {{cell:name}} exists and creates
        no loop; the bound statement passes the warehouse's zero-row
        validation (defaults bound, nothing read). Stores the compiled
        statement on block.query_sql and the referenced parameter names
        on config.parameters. An EMPTY statement is allowed (the person
        is still typing) and skips validation.
      - "input": config.parameter_id names one of the dashboard's
        parameters (by id or name), or is null.
      - a data block with config.source_block_id: the source is a sql
        cell (or a spec block) on the same page, not itself, and the
        binding creates no loop.
    Raises 400 with the real reason; returns the normalised config."""
    config = dict(config or {})
    if block.type == "sql":
        sql = config.get("sql")
        if sql is None:
            sql = ""
        if not isinstance(sql, str):
            raise HTTPException(400, "A SQL cell's `sql` must be a string.")
        sql = sql.strip()
        config["sql"] = sql
        raw_name = config.get("name") or _slugify(block.title or "").replace("-", "_") or None
        name = dashboard_engine.parameter_name({"name": raw_name}) if raw_name else None
        if name is None:
            name = f"cell_{(block.id or secrets.token_hex(3))[:6].replace('-', '')}"
        if not dashboard_engine._PARAM_NAME_RE.match(name):
            raise HTTPException(400, f'The cell name "{name}" must be a plain identifier (letters, digits, underscores).')
        for other in page.blocks:
            if other.id != block.id and other.type == "sql" and (other.config or {}).get("name") == name:
                raise HTTPException(400, f'Another SQL cell on this page is already named "{name}" - pick a different name.')
        config["name"] = name
        if not sql:
            config["parameters"] = []
            block.query_sql = None
            return config
        try:
            assert_read_only_sql(sql)
        except ReadOnlyViolation as e:
            raise HTTPException(400, f"A SQL cell can only run a single SELECT: {e}")
        ds = _resolve_datasource(db, user, d)
        if not dashboard_engine.is_warehouse_native(ds):
            raise HTTPException(400, "SQL cells run inside a warehouse/database - this dashboard's source is a file.")
        others = [c for c in _page_cells(page) if c["id"] != block.id]
        # A chart bound to this cell, plus this cell reading that chart's
        # source... cannot happen (charts are never sources), but a loop
        # through other sql cells can - check the whole page's graph.
        graph = _page_graph_blocks(page, {"id": block.id, "type": "sql", "sql": sql, "name": name})
        try:
            dashboard_engine.topological_order(dashboard_engine.dependency_graph(graph))
        except dashboard_engine.DependencyCycleError as e:
            raise HTTPException(400, str(e))
        versions = dashboard_engine.load_versions(db, ds)
        check = dashboard_engine.validate_sql_cell(
            ds, sql, d.parameters if isinstance(d.parameters, list) else [], versions, cells=others, name=name,
            block_id=block.id,
        )
        if not check["ok"]:
            raise HTTPException(400, f"This SQL cell did not validate: {check['error']}")
        config["parameters"] = check["parameters"]
        config["cells"] = check["cells"]
        config["computed_in"] = ds.kind
        config["spec_columns"] = check["columns"]
        block.query_sql = check["sql"]
        return config
    if block.type == "input":
        pid = config.get("parameter_id")
        if pid is not None:
            params = d.parameters if isinstance(d.parameters, list) else []
            match = next((p for p in params if isinstance(p, dict) and (p.get("id") == pid or p.get("name") == pid)), None)
            if not match:
                raise HTTPException(400, f'The parameter "{pid}" is not on this dashboard\'s filter rail - add it first.')
            config["parameter_id"] = match.get("id")
            config["parameter_name"] = match.get("name") or dashboard_engine.parameter_name(match)
        return config
    source_id = config.get("source_block_id")
    if source_id:
        if source_id == block.id:
            raise HTTPException(400, "A block cannot read from itself.")
        source = next((b for b in page.blocks if b.id == source_id), None)
        if source is None:
            raise HTTPException(400, "The cell this block should read from is not on this page.")
        if source.type != "sql" and not isinstance((source.config or {}).get("spec"), dict):
            raise HTTPException(400, "A block can only read from a SQL cell (or a block with a query spec).")
        graph = _page_graph_blocks(page, {"id": block.id, "type": block.type, "source_block_id": source_id})
        try:
            dashboard_engine.topological_order(dashboard_engine.dependency_graph(graph))
        except dashboard_engine.DependencyCycleError as e:
            raise HTTPException(400, str(e))
        # A block bound to a cell has no spec of its own - and is no
        # longer an empty, not-built-yet block.
        config.pop("spec", None)
        config.pop("empty", None)
        block.query_sql = None
    return config


@router.post("/{dashboard_id}/pages/{page_id}/run", response_model=schemas.RunPageOut)
def run_page(
    dashboard_id: str,
    page_id: str,
    payload: schemas.RunPageRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Runs every warehouse block on the page (or `block_ids`) inside the
    warehouse under the page's filters/period/date range - view access
    only (running is not editing). 400 for a dashboard whose source is a
    file (those use preview-filtered's pandas path). The audit log and
    the daily scan budget are the caller's own."""
    d = _get_dashboard_v2(db, user, dashboard_id)
    page = next((p for p in d.pages if p.id == page_id), None)
    if not page:
        raise HTTPException(404, "Page not found on this dashboard.")
    ds = _resolve_datasource_for_read(db, user, d)
    if not ds:
        raise HTTPException(400, "This dashboard has no linked data source you can access.")
    if not dashboard_engine.is_warehouse_native(ds):
        raise HTTPException(400, "This dashboard's data source is a file - use preview-filtered for it.")
    return _run_page_for(db, d, page, ds, payload, user.id, persist_last_run=True)


@router.get("/{dashboard_id}/parameters/{param_id}/options", response_model=schemas.ParameterOptionsOut)
def get_parameter_options(
    dashboard_id: str,
    param_id: str,
    search: str | None = None,
    limit: int = 50,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """A rail control's distinct values with counts (chips, multi-select,
    the country search) - one GROUP BY query, cached 10 minutes."""
    d = _get_dashboard_v2(db, user, dashboard_id)
    ds = _resolve_datasource_for_read(db, user, d)
    if not ds or not dashboard_engine.is_warehouse_native(ds):
        raise HTTPException(400, "Parameter options are computed in the warehouse - this dashboard's source is a file.")
    return _parameter_options_for(db, d, ds, param_id, search, limit, user.id)


def _parameter_options_for(db, d, ds, param_id, search, limit, user_id) -> schemas.ParameterOptionsOut:
    params = d.parameters if isinstance(d.parameters, list) else []
    param = next((p for p in params if isinstance(p, dict) and p.get("id") == param_id), None)
    if not param:
        raise HTTPException(404, "Parameter not found on this dashboard.")
    table = param.get("table") or _dashboard_primary_table(d, ds)
    # 2026-10-10 (cross-table filters): the filter's column may live in a
    # different table than the dashboard's main one (product_category in
    # product_catalog) - read the options from the table that has it.
    if table and param.get("column"):
        schema, _aliases = query_builder.with_version_aliases(ds.schema_cache, dashboard_engine.load_versions(db, ds))
        if not any(c["name"] == param["column"] for c in (query_builder.table_columns(schema, table) or [])):
            holders = query_builder.tables_with_column(schema, param["column"])
            if holders:
                table = holders[0]
            else:
                # Not in any table of this source (renamed or removed since):
                # say so plainly instead of a raw SQL error.
                label = param.get("label") or param["column"]
                return schemas.ParameterOptionsOut(
                    parameter_id=param_id, column=param["column"], table=table, search=search, values=[],
                    truncated=False, cached=False,
                    error=f"“{label}” isn't in this data source any more. Edit filters and choose another column.",
                )
    if not table:
        raise HTTPException(400, "This dashboard has no table to read parameter options from.")
    res = dashboard_engine.distinct_values(
        db, ds, table, param["column"], user_id=user_id, search=search, limit=max(1, min(200, int(limit))),
    )
    return schemas.ParameterOptionsOut(
        parameter_id=param_id, column=param["column"], table=table, search=res.get("search"), values=res["values"],
        truncated=res.get("truncated", False), cached=res.get("cached", False), error=res.get("error"),
    )


@router.patch("/{dashboard_id}/parameters", response_model=schemas.DashboardBuilderOut)
def update_parameters(
    dashboard_id: str,
    payload: schemas.UpdateParametersRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    d = _get_dashboard_v2(db, user, dashboard_id, require_edit=True)
    ds = _dashboard_datasource(db, d)
    d.parameters = _validate_parameters(db, ds, payload.parameters)
    db.commit()
    db.refresh(d)
    return _builder_out(db, d, user)


@router.patch("/{dashboard_id}/saved-views", response_model=schemas.DashboardBuilderOut)
def update_saved_views(
    dashboard_id: str,
    payload: schemas.UpdateSavedViewsRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    d = _get_dashboard_v2(db, user, dashboard_id, require_edit=True)
    existing = {v.get("id"): v for v in (d.saved_views or []) if isinstance(v, dict)}
    out: list[dict] = []
    seen: set[str] = set()
    for i, v in enumerate(payload.saved_views):
        if not isinstance(v, dict):
            raise HTTPException(400, f"Saved view #{i + 1} is not an object.")
        name = str(v.get("name") or "").strip()
        if not name:
            raise HTTPException(400, f"Saved view #{i + 1} needs a name.")
        vid = str(v.get("id") or "").strip() or f"v_{secrets.token_hex(4)}"
        if vid in seen:
            raise HTTPException(400, f'Saved view ids must be unique ("{vid}" appears twice).')
        seen.add(vid)
        period = v.get("period")
        if period is not None and period not in query_builder.GRAINS:
            raise HTTPException(400, f'Saved view "{name}": the period must be one of {", ".join(query_builder.GRAINS)}.')
        filters = v.get("filters") if isinstance(v.get("filters"), list) else []
        try:
            filters = [schemas.FilterCriterion(**f).model_dump() if isinstance(f, dict) else None for f in filters[:12]]
        except Exception:
            raise HTTPException(400, f'Saved view "{name}": its filters are malformed.')
        filters = [f for f in filters if f]
        prev = existing.get(vid) or {}
        out.append({
            "id": vid, "name": name[:80], "filters": filters, "period": period,
            "date_range": query_builder.normalize_date_range(v.get("date_range")),
            "created_by": prev.get("created_by") or v.get("created_by") or user.id,
        })
    d.saved_views = out
    db.commit()
    db.refresh(d)
    return _builder_out(db, d, user)


# ---------- choosing the chart (2026-10-07, chart-types round) ----------
#
# services/chart_recommender.py is the ONE deterministic function that
# decides which chart a block is drawn as. Every place a block gets its
# type goes through _choose_chart below: the proposal (and its commit),
# Ask AI, build-manually and "swap to best". A model's suggestion is a
# hint that function validates; when it overrides one, that is logged.
#
# config keys this writes:
#   chart_type     the form drawn
#   chart_reason   the one line shown to the person ("Country column with
#                  142 values -> map")
#   chart_auto     True while GD360 chose the type (never set when the
#                  person picked it). The first owner run confirms an auto
#                  choice against the real values (see _confirm_auto_charts)
#                  and sets chart_checked.

def _profile_distinct(ds: models.DataSource | None, table: str | None) -> dict:
    """{column: distinct count} from the Data tab's profile cache - a
    number already paid for; {} when the table was not profiled recently.
    Never runs a query."""
    if ds is None or not table:
        return {}
    cached = profile_cache_get((ds.id, table))
    cols = cached.get("columns") if isinstance(cached, dict) else None
    if not isinstance(cols, dict):
        return {}
    return {name: info.get("distinct") for name, info in cols.items() if isinstance(info, dict) and isinstance(info.get("distinct"), int)}


def _spec_shape(ds: models.DataSource | None, schema, spec: dict, config: dict | None = None) -> dict:
    """The recommender's shape for a spec that has not run: names and
    types from the schema, distinct counts from the profile cache."""
    columns = query_builder.table_columns(schema, spec.get("table")) if schema is not None else None
    cfg = config or {}
    target = isinstance(cfg.get("target"), (int, float)) and not isinstance(cfg.get("target"), bool)
    first = (spec.get("measures") or [{}])[0].get("alias")
    formats = {first: cfg.get("format")} if first and cfg.get("format") else None
    return chart_recommender.shape_from_spec(spec, columns, _profile_distinct(ds, spec.get("table")), target=target, formats=formats)


def _choose_chart(shape: dict, hint: str | None, explicit: bool, where: str) -> dict:
    """chart_recommender.resolve + the log line for an override."""
    choice = chart_recommender.resolve(shape, hint, explicit)
    if choice.get("overrode"):
        print(
            f"[dashboard_builder] chart type overridden ({where}): suggested {choice.get('suggested')!r} -> "
            f"{choice['chart_type']!r} ({choice.get('override_reason')})"
        )
    return choice


_MAP_MIN_LIMIT = 300


def _map_ready_spec(spec: dict) -> dict:
    """A map colours EVERY country, so a "top 10 countries" spec is widened
    to all of them (largest first); the ranked list beside the map still
    shows the top ones."""
    if not isinstance(spec, dict) or not spec.get("group_by"):
        return spec
    out = dict(spec)
    try:
        limit = int(out.get("limit") or 0)
    except (TypeError, ValueError):
        limit = 0
    if limit < _MAP_MIN_LIMIT:
        out["limit"] = _MAP_MIN_LIMIT
    measures = out.get("measures") or []
    if measures and not out.get("order_by"):
        out["order_by"] = [{"by": measures[0]["alias"], "dir": "desc"}]
    return out


def _fits_before_run(shape: dict, chart_type: str) -> tuple[bool, str | None]:
    """chart_recommender.fits for a spec that has not run. One leniency: a
    map is accepted for any single category - whether its values are
    countries is only known from the data, and the map itself says which
    values it could not place."""
    ok, why = chart_recommender.fits(shape, chart_type)
    if not ok and chart_recommender.normalize_chart_type(chart_type) == "map":
        if len(shape.get("dims") or []) == 1 and not shape.get("time") and (shape.get("measures") or []):
            return True, None
    return ok, why


# The words by which a QUESTION names a chart form ("as a pie chart",
# "show a map of ..."). When the question names the form the model
# returned, that form is the person's own choice; a form the model picked
# by itself is only a suggestion the recommender weighs.
_CHART_WORDS = {
    "bar": ("bar", "column"), "horizontal_bar": ("bar",), "line": ("line", "trend line"), "area": ("area",),
    "stacked_bar": ("stacked",), "stacked_bar_100": ("100%", "percent stacked", "stacked"), "stacked_area": ("stacked area", "area"),
    "stacked_area_100": ("100%", "stacked area"), "combo": ("combo", "bars and line", "bar and line"),
    "donut": ("donut", "doughnut"), "pie": ("pie",), "treemap": ("treemap", "tree map"), "map": ("map", "choropleth"),
    "heatmap": ("heatmap", "heat map", "matrix"), "pivot": ("pivot",), "scatter": ("scatter",), "bubble": ("bubble",),
    "funnel": ("funnel",), "waterfall": ("waterfall", "bridge"), "histogram": ("histogram", "distribution"),
    "bullet": ("bullet", "progress"), "table": ("table",), "kpi": ("kpi", "tile", "single number"),
}


def _prompt_names_chart(prompt: str | None, chart_type: str | None) -> bool:
    text = f" {str(prompt or '').lower()} "
    plain = {"grouped_bar": "bar", "step_line": "line"}.get(chart_type or "", chart_type or "")
    return any(re.search(rf"(?<![a-z]){re.escape(w)}(?![a-z])", text) or re.search(rf"(?<![a-z]){re.escape(w)}s(?![a-z])", text)
               for w in _CHART_WORDS.get(plain, ()))


def _wants_forecast(*texts) -> bool:
    text = " ".join(str(t or "") for t in texts).lower()
    return any(k in text for k in _FORECAST_KEYWORDS)


def _default_forecast_options(grain: str | None, anomalies: bool = False) -> dict:
    g = grain if grain in forecast_svc.GRAINS else "month"
    return {"horizon": forecast_svc.DEFAULT_HORIZON[g], "interval": "both", "anomalies": bool(anomalies)}


def _infer_block_type_for_spec(spec: dict, requested: str | None, current: str | None) -> str:
    """An explicit block_type wins; otherwise the spec's shape decides: a
    single-row spec (no group_by, no time) is a kpi (a gauge stays a
    gauge), a shaped spec keeps the block's current multi-row type (chart/
    table/donut/...) or becomes a chart."""
    if requested in _DATA_BLOCK_TYPES:
        return requested
    # 2026-10-07 (chart-types round): a histogram (bins) and a date-part
    # grouping are shaped results too - many rows, never a KPI tile.
    single_row = not spec.get("group_by") and not spec.get("time") and not spec.get("date_parts") and not spec.get("bins")
    if single_row:
        return current if current in ("kpi", "gauge") else "kpi"
    if current in _DATA_BLOCK_TYPES and current not in ("kpi", "gauge"):
        return current
    return "chart"


class BlockSpecStoreError(Exception):
    """A candidate BlockSpec that _store_block_spec refused, with the
    plain reason. `stage` is "spec" (it failed query_builder's structural
    validation against the schema - `message` is that error as-is) or
    "warehouse" (it compiled but the warehouse's own zero-row check
    rejected it - `message` is "The warehouse rejected this block's
    query: <the warehouse's error>", `sql` the statement it rejected).
    Nothing was stored and nothing was read. Typed (not an HTTPException)
    so a caller can feed the reason back to the model and try once more."""

    def __init__(self, message: str, stage: str, spec=None, sql: str | None = None):
        super().__init__(message)
        self.message = message
        self.stage = stage
        self.spec = spec
        self.sql = sql


# What a pre-layer block rendered from (a stored result / a pandas recipe) -
# gone the moment the block has a spec the warehouse computes.
_LEGACY_RENDER_KEYS = ("result_rows", "result_columns", "recipe", "chart_spec", "rows", "columns")
# A block that shows ONE number (config.label / config.format apply to it).
_SINGLE_VALUE_BLOCK_TYPES = ("kpi", "gauge", "sparkline")


def _store_block_spec(
    db: Session, d: models.Dashboard, ds: models.DataSource, block: models.DashboardBlock, spec, *,
    block_type: str | None = None, chart_type: str | None = None, title: str | None = None,
    extra_config: dict | None = None, drop_keys: tuple = (), infer_format: bool = False, versions=None,
    auto_title: str | None = None,
) -> dict:
    """The ONE way a BlockSpec gets onto a block (set_block_spec, Ask AI
    and build-manually on a warehouse source): validate structurally
    against the schema (strict), dry-run inside the warehouse with the
    connector's zero-row check (nothing read, nothing billed), and only
    then write config.spec / computed_in / spec_columns, the compiled
    at-rest SQL on block.query_sql, the inferred block type and the
    title. Raises BlockSpecStoreError - and changes NOTHING - when either
    check fails. Never loads a row and never commits (the caller does).

    `block_type`/`chart_type`/`title` mean exactly what SetBlockSpecRequest's
    fields mean (an explicit block type wins over the spec's shape; a
    title of None keeps the block's own, or describes the spec when it
    has none or its title is one GD360 wrote - config.title_auto).
    `auto_title` is a title the CALLER generated (the question asked, a
    manual build's "Sum of adr by hotel"): it replaces the block's title
    only while that title is GD360's own. `extra_config` is merged over the kept config (after the
    spec keys, before the chart-type/label defaults); `drop_keys` are
    extra config keys the caller knows are stale (a previous build's
    label, its bound cell, ...). `infer_format` asks for a number format
    on a single-value block (query_builder.infer_number_format). Returns
    the normalised spec that was stored."""
    if versions is None:
        versions = dashboard_engine.load_versions(db, ds)
    try:
        schema, _ = query_builder.with_version_aliases(ds.schema_cache, versions)
        normalised = query_builder.public_spec(query_builder.validate_block_spec(spec, schema, strict=True))
    except query_builder.QueryBuilderError as e:
        raise BlockSpecStoreError(str(e), "spec", spec=spec if isinstance(spec, dict) else None)
    check = dashboard_engine.validate_spec_in_warehouse(ds, normalised, versions, date_column=d.date_column)
    if not check["ok"]:
        raise BlockSpecStoreError(
            f"The warehouse rejected this block's query: {check['error']}", "warehouse", spec=normalised, sql=check.get("sql"),
        )

    _snapshot_block_config(block)
    new_type = _infer_block_type_for_spec(normalised, block_type, block.type)
    dropped = set(_LEGACY_RENDER_KEYS) | set(drop_keys) | {"empty"}
    config = {k: v for k, v in (block.config or {}).items() if k not in dropped}
    # A number format GD360 inferred belongs to the spec it was inferred
    # from - it never outlives it (a format the person chose is kept).
    if config.pop("format_inferred", None):
        config.pop("format", None)
    if config.pop("good_direction_inferred", None):
        config.pop("good_direction", None)
    config["spec"] = normalised
    config["computed_in"] = ds.kind
    config["spec_columns"] = check["columns"]
    if extra_config:
        config.update(extra_config)
    if chart_type:
        config["chart_type"] = chart_type
        # A type the caller named: GD360 is no longer choosing it.
        if not (extra_config or {}).get("chart_auto"):
            config.pop("chart_auto", None)
            config.pop("chart_checked", None)
            if "chart_reason" not in (extra_config or {}):
                config.pop("chart_reason", None)
    elif new_type == "chart" and normalised.get("bins"):
        config["chart_type"] = "histogram"
    elif new_type == "chart" and not config.get("chart_type"):
        config["chart_type"] = "line" if normalised.get("time") else "bar"
    # A chart type the new spec's shape cannot draw does not survive it
    # (a histogram whose bins were removed, a map whose column changed).
    if new_type == "chart" and config.get("chart_type"):
        ok, _why = _fits_before_run(_spec_shape(ds, schema, normalised, config), config["chart_type"])
        if not ok:
            choice = chart_recommender.recommend(_spec_shape(ds, schema, normalised, config))
            config["chart_type"] = choice["chart_type"] if choice["block_type"] == "chart" else ("line" if normalised.get("time") else "bar")
            config["chart_reason"] = choice["reason"]
    # A forecast needs a time axis (or a KPI's sparkline).
    if config.get("forecast") and not (normalised.get("time") or (new_type in ("kpi", "sparkline") and normalised.get("sparkline"))):
        config.pop("forecast", None)
    if new_type in ("kpi", "gauge"):
        config["label"] = config.get("label") or normalised["measures"][0]["alias"]
    if infer_format and new_type in _SINGLE_VALUE_BLOCK_TYPES and not config.get("format"):
        inferred = query_builder.infer_number_format(normalised, None, schema)
        if inferred:
            config["format"] = inferred
            config["format_inferred"] = True
    if new_type in _SINGLE_VALUE_BLOCK_TYPES and not config.get("good_direction"):
        direction_title = auto_title if (auto_title is not None and _title_is_auto(block)) else (title if title is not None else block.title)
        if query_builder.infer_good_direction(normalised, direction_title):
            config["good_direction"] = "down"
            config["good_direction_inferred"] = True
    was_auto = _title_is_auto(block)
    config.pop("title_auto", None)
    block.type = new_type
    block.config = config
    block.query_sql = check["sql"]
    block.data_updated_at = datetime.utcnow()
    if auto_title is not None:
        # The caller's own generated title (the question, "Sum of adr by
        # hotel"): written only while the block's title is GD360's.
        if was_auto:
            _set_auto_title(block, auto_title)
    elif title is not None:
        # An explicit title is the person's.
        block.title = title.strip()[:200] or None
    elif was_auto:
        _set_auto_title(block, query_builder.describe_block_spec(normalised))
    return normalised


# ---------- Ask AI / build-manually on a WAREHOUSE source (2026-10-07) ----------
#
# The product rule: for a warehouse/database source GD360 never loads rows
# into pandas to compute an answer - not a sample, not the table. Both
# block-editing endpoints therefore branch on dashboard_engine.
# is_warehouse_native(ds) BEFORE anything is loaded and end in
# _store_block_spec: the block gets a BlockSpec the engine computes inside
# the warehouse (one SQL query per block, on run), or the request fails
# with the plain reason and computes nothing. A file source never reaches
# these functions.

# Config keys a previous build of the block left behind that a NEW build
# must not inherit: a pre-layer block's frozen numbers, the old build's
# label/explanation/lineage, the saved metric or SQL cell it used to read
# from. (Presentation the person set - accent_color, chart_style, a
# gauge's target/max, a number format they chose - is kept.)
_REBUILD_DROP_KEYS = (
    "value", "prior_value", "delta_pct", "sparkline_series", "items", "series", "categories", "truncated", "label",
    "source_code", "ai_explanation", "source_table", "source_block_id", "metric_id", "metric_name", "intent", "text",
)
# The chart forms a spec block can be drawn as - what the spec writer may
# suggest when the QUESTION names one (see BLOCK_SPEC_SYSTEM_PROMPT).
_SPEC_CHART_TYPES = set(chart_recommender.BLOCK_CHART_TYPES)
_NON_NUMERIC_TYPE_RE = re.compile(r"char|text|string|date|time|bool|json|uuid|byte|binary|array|struct", re.IGNORECASE)


def _ask_ai_block_warehouse(
    db: Session, d: models.Dashboard, ds: models.DataSource, block: models.DashboardBlock, prompt: str,
) -> None:
    """Ask AI on a warehouse source: the model writes a BlockSpec (never
    SQL, never pandas) from the question and the real schema - real
    tables plus saved-query aliases, exactly what upgrade_blocks/propose
    hand it - and _store_block_spec validates + dry-runs it before it is
    stored. ONE bounded retry: when the first spec fails structural
    validation or the warehouse's zero-row check, the exact spec and the
    exact error go back to the model for one corrected attempt (the same
    shape as chat's _run_sql_pushdown_cycle). No retry when the model
    produced no spec at all. Two failures -> 422 with the last error;
    the block is untouched and nothing was read. Mutates the block; the
    caller commits."""
    prompt = (prompt or "").strip()
    if not prompt:
        raise HTTPException(400, "Type a question for this block first.")
    if block.type not in _DATA_BLOCK_TYPES and block.type != "text":
        raise HTTPException(400, "Ask AI fills a chart, table or KPI block - add one of those and ask there.")
    versions = dashboard_engine.load_versions(db, ds)
    schema_text = _warehouse_schema_text(ds, None, versions)
    schema_now, _ = query_builder.with_version_aliases(ds.schema_cache, versions)
    last_error = None
    previous_spec = None
    for attempt in (1, 2):
        if attempt == 1:
            candidate = ai_engine.generate_block_spec(prompt, schema_text, ds.kind, title=block.title)
        else:
            candidate = ai_engine.generate_block_spec(
                prompt, schema_text, ds.kind, title=block.title, previous_spec=previous_spec, previous_error=last_error,
            )
        if not isinstance(candidate, dict):
            # No spec to correct: the model said the question does not fit
            # one aggregate query (or did not answer). Keep the first
            # attempt's real error when this is the retry.
            last_error = last_error or (
                "the question could not be expressed as one aggregate query over this data source's tables"
            )
            break
        suggested_chart = candidate.get("chart_type")
        suggested_chart = suggested_chart.strip().lower() if isinstance(suggested_chart, str) else None
        # The block's type follows the spec's shape unless its current
        # type can show that shape (_infer_block_type_for_spec). One case
        # that rule does not know: a SPARKLINE block shows a one-row spec
        # too, through the spec's own sparkline series - it stays one.
        keep_type = None
        if block.type == "sparkline" and candidate.get("sparkline") and not candidate.get("group_by") and not candidate.get("time"):
            keep_type = "sparkline"
        # 2026-10-07 (chart-types round): the chart form is decided by the
        # ONE recommender, BEFORE the spec is stored (so a map's spec is
        # widened to every country in the same single dry run). What it
        # weighs, in order: a form the question itself named (the model's
        # "chart_type"), then the form the person had already given this
        # block - both honoured whenever the new shape can draw them - and
        # otherwise its own rules ("Country column -> map").
        prior_cfg = block.config or {}
        prior_form = None
        if not prior_cfg.get("chart_auto") and not prior_cfg.get("empty"):
            if block.type == "chart" and prior_cfg.get("chart_type"):
                prior_form = str(prior_cfg["chart_type"])
            elif block.type == "donut" and (prior_cfg.get("spec") or prior_cfg.get("items") or prior_cfg.get("recipe")):
                prior_form = "donut"
        chart_kw: str | None = None
        chart_extra: dict = {}
        chart_drop: list[str] = []
        try:
            probe = query_builder.public_spec(query_builder.validate_block_spec(candidate, schema_now, strict=True))
        except query_builder.QueryBuilderError:
            probe = None  # _store_block_spec below reports the real error
        to_store = candidate
        if probe is not None and _infer_block_type_for_spec(probe, keep_type, block.type) in ("chart", "donut"):
            named = chart_recommender.normalize_chart_type(suggested_chart) if suggested_chart else None
            if suggested_chart and not named:
                print(f"[dashboard_builder] chart type ignored (ask-ai): {suggested_chart!r} is not a chart GD360 draws")
            # A form the QUESTION names, or the one the person had already
            # given this block, is theirs (kept whenever the shape can draw
            # it); a form the model chose on its own is a suggestion.
            asked = bool(named) and _prompt_names_chart(prompt, named)
            hint = named if asked else (prior_form or named)
            explicit = asked or (hint is not None and hint == prior_form)
            choice = _choose_chart(_spec_shape(ds, schema_now, probe, prior_cfg), hint, explicit, "ask-ai")
            if choice["block_type"] in ("chart", "donut"):
                keep_type = choice["block_type"]
                chart_extra["chart_reason"] = choice["reason"]
                if choice["block_type"] == "chart":
                    chart_kw = choice["chart_type"]
                    if chart_kw == "map":
                        to_store = {**candidate, **{k: v for k, v in _map_ready_spec(probe).items() if k in ("limit", "order_by")}}
                else:
                    chart_drop.append("chart_type")
                if hint and choice["chart_type"] == chart_recommender.normalize_chart_type(hint):
                    chart_drop += ["chart_auto", "chart_checked"]
                else:
                    chart_extra["chart_auto"] = True
                    chart_drop.append("chart_checked")
            # "forecast", "predict", "projection" in the question turn the
            # forecast on for a time series (the existing keyword rule).
            if probe.get("time") and keep_type in (None, "chart") and _wants_forecast(prompt):
                chart_extra["forecast"] = _default_forecast_options(probe["time"].get("grain"))
                if chart_kw not in ("line", "area", "bar"):
                    chart_kw = "line"
        try:
            _store_block_spec(
                db, d, ds, block, to_store, block_type=keep_type, chart_type=chart_kw, auto_title=prompt[:120],
                extra_config={"ai_prompt": prompt, **chart_extra}, drop_keys=tuple(_REBUILD_DROP_KEYS) + tuple(chart_drop),
                infer_format=True, versions=versions,
            )
        except BlockSpecStoreError as e:
            print(f"[dashboard_builder] Ask AI spec attempt {attempt} rejected ({e.stage}): {e.message}")
            last_error, previous_spec = e.message, candidate
            continue
        return
    reason = str(last_error or "").strip().rstrip(".")
    raise HTTPException(
        422,
        f"Nothing was computed: GD360 could not turn that question into a valid {ds.kind} query for this block "
        f"({reason}). Try rephrasing the question, or use \"Edit query\" to build this block's query yourself.",
    )


def _warehouse_block_table(d: models.Dashboard, ds: models.DataSource, schema: dict, requested: str | None) -> str:
    """The table a manually-built warehouse block reads: the one the
    request names, else the dashboard's own table (the one most of its
    blocks already use, else its filter rail's, else the data source's
    first table - _dashboard_primary_table), else the first table of the
    schema (what the propose/generate path starts from)."""
    if requested:
        if not query_builder.table_columns(schema, requested):
            raise HTTPException(400, f'The table "{requested}" is not one of this data source\'s tables.')
        return requested
    primary = _dashboard_primary_table(d, ds)
    if primary and query_builder.table_columns(schema, primary):
        return primary
    first = next((t for t in schema if query_builder.table_columns(schema, t)), None) if isinstance(schema, dict) else None
    if not first:
        raise HTTPException(400, "This data source has no tables to build a block from yet.")
    return first


def _build_manual_block_warehouse(
    db: Session, d: models.Dashboard, ds: models.DataSource, block: models.DashboardBlock,
    payload: schemas.ManualBuildBlockRequest,
) -> None:
    """Build-manually on a warehouse source: the form's recipe (column +
    aggregation + optional group-by, or a saved metric) is translated
    deterministically into a BlockSpec - the same numbers the pandas
    recipe would give a file, as ONE aggregate query the warehouse runs:

      kpi / gauge            -> one row: <agg>(<column>), prior-period
                                comparison + sparkline on
      table/chart/donut/     -> GROUP BY <group_by_column>, ordered by the
        avatar_list             measure descending, the same row caps the
                                recipe uses (200 / 50 / 50 / 8)
      sparkline              -> GROUP BY <group_by_column>, ordered by
                                the group ascending (a trend's point is
                                its order)
      "count"                -> COUNT(<column>) - the non-null count,
                                exactly what the pandas recipe counts
      a saved metric         -> its column/aggregation/filters as a
                                one-row spec (kpi/gauge only)

    payload.filters (the page filters active while building) are not
    baked in: the engine pushes the page's live filters into every run.
    A feature that only exists as an in-app pandas computation (a saved
    table / transform) is refused by name with a 400 - never computed on
    loaded rows. Mutates the block; the caller commits."""
    if payload.transform_id:
        raise HTTPException(
            400,
            "Saved tables (transform_id) are not supported on a warehouse/database source: a saved table is computed "
            "inside the app from loaded rows, and GD360 never loads a warehouse's rows. Pick the warehouse table "
            "(or a saved query) directly instead. Nothing was computed.",
        )
    block_type = payload.block_type
    if block_type not in ("kpi", "table", "chart", "gauge", "donut", "sparkline", "avatar_list"):
        raise HTTPException(400, "Unknown block type.")
    single_value = block_type in ("kpi", "gauge")
    versions = dashboard_engine.load_versions(db, ds)
    schema, _ = query_builder.with_version_aliases(ds.schema_cache, versions)
    table = _warehouse_block_table(d, ds, schema, (payload.table or "").strip() or None)
    columns = {c["name"]: c for c in query_builder.table_columns(schema, table) or []}
    extra: dict = {}

    if payload.metric_id:
        metric = (
            db.query(models.MetricDefinition)
            .filter(models.MetricDefinition.id == payload.metric_id, models.MetricDefinition.datasource_id == ds.id)
            .first()
        )
        if not metric:
            raise HTTPException(404, "That metric no longer exists.")
        if not single_value:
            raise HTTPException(400, "A saved metric can only be used for a KPI or gauge block.")
        if metric.agg not in _MANUAL_AGG_FUNCS:
            raise HTTPException(400, f'The saved metric "{metric.name}" uses an aggregation ("{metric.agg}") a warehouse block cannot run.')
        # Every one of the metric's own filters must make it into the
        # query - a filter the translation would skip is refused by name,
        # never dropped (that would be a different number).
        for f in metric.filters or []:
            if not query_builder.page_filters_to_block_filters([f]):
                column = f.get("column") if isinstance(f, dict) else None
                raise HTTPException(
                    400,
                    f'The saved metric "{metric.name}" has a filter on "{column}" that cannot be expressed as a '
                    "warehouse query, so this block was not built. Nothing was computed.",
                )
        spec = _metric_to_spec(metric, table)
        default_title = metric.name
        extra["metric_id"] = metric.id
        extra["metric_name"] = metric.name
    else:
        histogram = block_type == "chart" and bool(payload.bins and payload.bins.get("column"))
        column = payload.metric_column or ((payload.bins or {}).get("column") if histogram else None)
        agg = "count" if histogram else payload.agg
        if not column:
            raise HTTPException(400, "Pick a column, or a saved metric, to build from.")
        if agg not in _MANUAL_AGG_FUNCS:
            raise HTTPException(400, "Unknown aggregation.")
        if column not in columns:
            raise HTTPException(400, f'Column "{column}" was not found in the table "{table}".')
        if agg in _MANUAL_AGG_NEEDS_NUMERIC and _NON_NUMERIC_TYPE_RE.search(str(columns[column].get("type") or "")):
            raise HTTPException(
                400,
                f'"{column}" isn\'t a numeric column, so it can\'t be summed or averaged - '
                "try Count, Min, or Max instead, or pick a numeric column.",
            )
        agg_label = {"sum": "Sum", "avg": "Average", "count": "Count", "min": "Min", "max": "Max"}[agg]
        alias = f"{agg}_{re.sub(r'[^A-Za-z0-9_]+', '_', column).strip('_') or 'value'}"
        measure = {"alias": alias, "agg": agg, "column": column}
        spec = {"table": table, "measures": [measure], "filters": []}
        if single_value:
            spec["compare_prior_period"] = True
            spec["sparkline"] = True
            default_title = f"{agg_label} of {column}"
        elif histogram:
            # A histogram: the bins are computed in the warehouse.
            spec = {"table": table, "filters": [], "bins": {"column": payload.bins.get("column"), "count": payload.bins.get("count"),
                                                              "min": payload.bins.get("min"), "max": payload.bins.get("max")}}
            default_title = f"Distribution of {payload.bins.get('column')}"
        else:
            group = payload.group_by_column
            if not group:
                raise HTTPException(400, "Pick a column to group by for a table, chart, donut, sparkline, or top list.")
            if group not in columns:
                raise HTTPException(400, f'Column "{group}" was not found in the table "{table}".')
            spec["group_by"] = [group]
            # 2026-10-07 (chart-types round): a time bucket, a second
            # dimension and more measures - see ManualBuildBlockRequest.
            grain = (payload.time_grain or "").lower().strip()
            if grain:
                if grain not in query_builder.GRAINS:
                    raise HTTPException(400, f"time_grain must be one of {', '.join(query_builder.GRAINS)}.")
                spec["time"] = {"column": group, "grain": grain}
                spec["group_by"] = []
            if payload.group_by_column_2:
                if payload.group_by_column_2 not in columns:
                    raise HTTPException(400, f'Column "{payload.group_by_column_2}" was not found in the table "{table}".')
                if block_type not in ("chart", "table"):
                    raise HTTPException(400, "A second group-by column is for a chart or a table.")
                spec["group_by"] = spec["group_by"] + [payload.group_by_column_2]
            for extra_m in payload.extra_measures:
                e_agg, e_col = str(extra_m.get("agg") or "sum").lower(), extra_m.get("column")
                if e_agg not in _MANUAL_AGG_FUNCS or (e_col is not None and e_col not in columns):
                    raise HTTPException(400, f"The extra measure {e_agg} of {e_col!r} cannot be built on this table.")
                e_alias = f"{e_agg}_{re.sub(r'[^A-Za-z0-9_]+', '_', e_col or 'rows').strip('_') or 'value'}"
                spec["measures"].append({"alias": e_alias, "agg": e_agg, "column": e_col})
            if spec.get("time"):
                spec["order_by"] = [{"by": query_builder.PERIOD_ALIAS, "dir": "asc"}]
                spec["limit"] = query_builder.MAX_LIMIT
                default_title = f"{agg_label} of {column} by {grain}" + (f" and {payload.group_by_column_2}" if payload.group_by_column_2 else "")
            elif block_type == "sparkline":
                spec["order_by"] = [{"by": group, "dir": "asc"}]
                spec["limit"] = query_builder.MAX_LIMIT
            else:
                spec["order_by"] = [{"by": alias, "dir": "desc"}]
                spec["limit"] = 8 if block_type == "avatar_list" else (50 if block_type in ("chart", "donut") else _MAX_TABLE_ROWS_PER_BLOCK)
                if payload.group_by_column_2:
                    spec["limit"] = query_builder.MAX_LIMIT
            if not spec.get("time"):
                default_title = f"{agg_label} of {column} by {group}" + (f" and {payload.group_by_column_2}" if payload.group_by_column_2 else "")

    drop = list(_REBUILD_DROP_KEYS) + ["ai_prompt", "min", "max", "target", "target_value", "max_value"]
    chart_type = None
    if block_type == "chart":
        # 2026-10-07 (chart-types round): the form picked in the builder is
        # honoured when this spec's shape can draw it; "auto" (or nothing)
        # asks the recommender.
        asked = (payload.chart_type or "").lower().strip()
        asked = None if asked in ("", "auto") else asked
        choice = _choose_chart(_spec_shape(ds, schema, spec, block.config), asked, True, "build-manual")
        chart_type = choice["chart_type"] if choice["block_type"] == "chart" else ("bar" if not spec.get("time") else "line")
        extra["chart_reason"] = choice["reason"]
        if asked and chart_type == chart_recommender.normalize_chart_type(asked):
            drop.extend(["chart_auto", "chart_checked"])
        else:
            extra["chart_auto"] = True
            drop.append("chart_checked")
        if chart_type == "map":
            spec = _map_ready_spec(spec)
        if payload.forecast and spec.get("time"):
            extra["forecast"] = _default_forecast_options(spec["time"].get("grain"))
    else:
        drop.append("chart_type")
    if block_type in ("kpi", "gauge", "sparkline", "avatar_list"):
        extra["label"] = default_title
    if block_type == "gauge":
        # The live value decides the rest (the gauge's range is drawn
        # from the run's number); only what the person set is stored.
        if payload.target_value is not None:
            extra["target"] = _safe_float(payload.target_value, None)
        if payload.max_value is not None:
            extra["max"] = _safe_float(payload.max_value, None)
        extra = {k: v for k, v in extra.items() if v is not None}
    try:
        _store_block_spec(
            db, d, ds, block, spec, block_type=block_type, chart_type=chart_type,
            auto_title=default_title, extra_config=extra, drop_keys=tuple(drop), versions=versions,
        )
    except BlockSpecStoreError as e:
        raise HTTPException(400, f"{e.message.rstrip('.')}. Nothing was computed.")


@router.post("/{dashboard_id}/blocks/{block_id}/spec", response_model=schemas.DashboardBuilderOut)
def set_block_spec(
    dashboard_id: str,
    block_id: str,
    payload: schemas.SetBlockSpecRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Sets/replaces a block's BlockSpec. The spec is validated
    structurally (every table/column must exist in the schema; `expr`
    must be plain column arithmetic), compiled, and dry-validated inside
    the warehouse with the connector's zero-row check (nothing read,
    nothing billed) before anything is stored. Stores the compiled
    at-rest SQL on block.query_sql. 400 with the warehouse's own message
    when the spec does not compile or validate. (_store_block_spec does
    the work - shared with Ask AI and build-manually.)"""
    d = _get_dashboard_v2(db, user, dashboard_id, require_edit=True)
    block = _get_block(db, d, block_id)
    ds = _resolve_datasource(db, user, d)
    if not dashboard_engine.is_warehouse_native(ds):
        raise HTTPException(400, "Block specs are for dashboards on a warehouse/database source.")
    chart_type = payload.chart_type
    if chart_type is not None:
        normal = chart_recommender.normalize_chart_type(chart_type)
        if normal is None or normal not in chart_recommender.BLOCK_CHART_TYPES:
            raise HTTPException(400, f"chart_type {chart_type!r} is not a chart GD360 draws.")
        chart_type = normal
        if isinstance(payload.spec, dict):
            schema, _ = query_builder.with_version_aliases(ds.schema_cache, dashboard_engine.load_versions(db, ds))
            try:
                probe = query_builder.public_spec(query_builder.validate_block_spec(payload.spec, schema, strict=True))
            except query_builder.QueryBuilderError as e:
                raise HTTPException(400, str(e))
            ok, why = _fits_before_run(_spec_shape(ds, schema, probe, block.config), chart_type)
            if not ok:
                label = next((t["label"] for t in chart_recommender.CHART_TYPES if t["type"] == chart_type), chart_type)
                raise HTTPException(400, f"{label}: this query {why}.")
    try:
        _store_block_spec(
            db, d, ds, block, payload.spec, block_type=payload.block_type, chart_type=chart_type,
            title=payload.title,
        )
    except BlockSpecStoreError as e:
        raise HTTPException(400, e.message)
    db.commit()
    db.refresh(d)
    return _builder_out(db, d, user)


@router.get("/{dashboard_id}/blocks/{block_id}/sql", response_model=schemas.BlockSqlOut)
def get_block_sql(
    dashboard_id: str,
    block_id: str,
    request: Request,
    period: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """"Show SQL": the exact statement the engine would run for this
    block under the given filters. Filters come as repeated query params
    `f=<column>:<json spec>` (same specs as preview-filtered) so a plain
    GET can carry the rail's state; none = the block's own SQL at rest."""
    d = _get_dashboard_v2(db, user, dashboard_id)
    block = _get_block(db, d, block_id)
    ds = _resolve_datasource_for_read(db, user, d)
    if not ds or not dashboard_engine.is_warehouse_native(ds):
        raise HTTPException(400, "Show SQL is for dashboards on a warehouse/database source.")
    config = block.config or {}
    # 2026-10-07 (analyst canvas round): a sql cell (or a block bound to
    # one) shows the cell's statement with the parameter placeholders in
    # the warehouse's own form - values are bound at run time, never
    # shown spliced in.
    source_id = config.get("source_block_id")
    cell = block if block.type == "sql" else (_get_block(db, d, source_id) if source_id else None)
    if cell is not None:
        cells = [{"id": b.id, "type": "sql", "sql": (b.config or {}).get("sql") or "", "name": (b.config or {}).get("name")}
                 for b in cell.page.blocks if b.type == "sql"]
        values, defs = dashboard_engine.resolve_parameter_values(d.parameters if isinstance(d.parameters, list) else [])
        schema, _ = query_builder.with_version_aliases(ds.schema_cache, dashboard_engine.load_versions(db, ds))
        by_id = {c["id"]: c for c in cells}
        deps = dashboard_engine.dependency_graph(cells)
        try:
            dashboard_engine.topological_order(deps)
        except dashboard_engine.DependencyCycleError as e:
            raise HTTPException(400, str(e))
        compiled = dashboard_engine.compile_sql_cell(ds, by_id[cell.id], by_id, deps, values, defs, schema,
                                                     dashboard_engine.load_versions(db, ds))
        if compiled["error"]:
            raise HTTPException(400, compiled["error"])
        return schemas.BlockSqlOut(
            block_id=block.id, sql=compiled["sql"], prior_sql=None, sparkline_sql=None, dialect=ds.kind,
            period=d.default_period or "month", date_range=None,
            filters_applied=[{"parameter": n, "bound": True} for n in compiled["parameters"]],
        )
    spec = config.get("spec")
    if not isinstance(spec, dict):
        raise HTTPException(404, "This block has no query spec yet - upgrade it first.")
    filters = _filters_from_query_params(request)
    date_range = {"from": date_from, "to": date_to} if (date_from or date_to) else None
    versions = dashboard_engine.load_versions(db, ds)
    # A histogram's statement carries its real bin edges (the cached MIN /
    # MAX read the run used), never a placeholder grid.
    edges, edge_error = dashboard_engine.resolve_bin_edges(db, ds, spec, versions, user.id)
    if edge_error:
        raise HTTPException(400, edge_error)
    compiled = dashboard_engine.compile_block(
        ds, spec, filters, period, date_range, d.date_column, versions,
        default_period=d.default_period, bin_edges=edges,
    )
    if compiled.error:
        raise HTTPException(400, compiled.error)
    return schemas.BlockSqlOut(
        block_id=block.id, sql=compiled.sql, prior_sql=compiled.prior_sql, sparkline_sql=compiled.sparkline_sql,
        dialect=ds.kind, period=compiled.period, date_range=compiled.date_range, filters_applied=compiled.filters_applied,
    )


def _filters_from_query_params(request: Request) -> list[dict]:
    import json as _json
    out: list[dict] = []
    for raw in request.query_params.getlist("f"):
        column, _, spec_text = raw.partition(":")
        if not column:
            continue
        spec: Any = spec_text
        if spec_text:
            try:
                spec = _json.loads(spec_text)
            except Exception:
                spec = spec_text
        out.append({"column": column, "spec": spec})
    return out[:12]


def _recipe_to_spec(recipe: dict, table: str | None) -> dict | None:
    """A manual-build recipe ({metric_column, agg, group_by_column,
    block_type}) is already a spec in all but name - converted
    deterministically, no model call."""
    if not table or not isinstance(recipe, dict):
        return None
    agg = recipe.get("agg")
    column = recipe.get("metric_column")
    if agg not in ("sum", "avg", "count", "min", "max") or not column:
        return None
    measure = {"alias": f"{agg}_{re.sub(r'[^A-Za-z0-9_]+', '_', column).strip('_') or 'value'}", "agg": agg, "column": column}
    if agg == "count":
        measure = {"alias": "count", "agg": "count", "column": None}
    spec: dict = {"table": table, "measures": [measure], "filters": []}
    group = recipe.get("group_by_column")
    if group and recipe.get("block_type") not in ("kpi", "gauge"):
        spec["group_by"] = [group]
        spec["order_by"] = [{"by": measure["alias"], "dir": "desc"}]
        spec["limit"] = 200
    else:
        spec["compare_prior_period"] = True
        spec["sparkline"] = True
    return spec


@router.post("/{dashboard_id}/upgrade-blocks", response_model=schemas.UpgradeBlocksOut)
def upgrade_blocks(
    dashboard_id: str,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Gives every pre-layer warehouse block (an AI-built chart/table/kpi
    carrying static result_rows, or a manual recipe) a BlockSpec so it
    computes inside the warehouse from now on. A recipe block is
    converted deterministically; an AI-built block's stored question
    (config.ai_prompt, else its title) is handed to
    ai_engine.generate_block_spec. Every candidate spec is validated
    against the schema and dry-run inside the warehouse (zero rows, not
    billed) before it is stored; failures are reported per block, never
    hidden, and never change that block."""
    d = _get_dashboard_v2(db, user, dashboard_id, require_edit=True)
    ds = _resolve_datasource(db, user, d)
    if not dashboard_engine.is_warehouse_native(ds):
        raise HTTPException(400, "Only a dashboard on a warehouse/database source has blocks to upgrade.")
    versions = dashboard_engine.load_versions(db, ds)
    schema, _ = query_builder.with_version_aliases(ds.schema_cache, versions)
    schema_text = _warehouse_schema_text(ds, None, versions)
    primary_table = _dashboard_primary_table(d, ds)
    results: list[schemas.UpgradeBlockResult] = []
    upgraded = failed = skipped = 0
    for page in sorted(d.pages, key=lambda p: p.position):
        for block in sorted(page.blocks, key=lambda b: b.position):
            config = block.config or {}
            if block.type not in _DATA_BLOCK_TYPES:
                continue
            if isinstance(config.get("spec"), dict):
                results.append(schemas.UpgradeBlockResult(block_id=block.id, title=block.title, status="already_has_spec", spec=config["spec"]))
                skipped += 1
                continue
            # 2026-10-07 (block editing round): an empty, not-built-yet
            # block (create_block's config.empty) has nothing to upgrade -
            # it is not a pre-layer block.
            if _is_empty_warehouse_block(block):
                results.append(schemas.UpgradeBlockResult(block_id=block.id, title=block.title, status="skipped"))
                skipped += 1
                continue
            candidate = None
            if isinstance(config.get("recipe"), dict):
                candidate = _recipe_to_spec(config["recipe"], config.get("source_table") or primary_table)
                if candidate is None:
                    results.append(schemas.UpgradeBlockResult(
                        block_id=block.id, title=block.title, status="failed",
                        error="This manual block's recipe (a saved metric/transform, or an unsupported aggregation) cannot be expressed as a warehouse query yet.",
                    ))
                    failed += 1
                    continue
            else:
                question = (config.get("ai_prompt") or block.title or "").strip()
                if not question:
                    results.append(schemas.UpgradeBlockResult(block_id=block.id, title=block.title, status="failed", error="This block has no stored question or title to build a query from."))
                    failed += 1
                    continue
                candidate = ai_engine.generate_block_spec(question, schema_text, ds.kind, title=block.title)
                if candidate is None:
                    results.append(schemas.UpgradeBlockResult(block_id=block.id, title=block.title, status="failed", error="The AI could not express this block as a warehouse query spec."))
                    failed += 1
                    continue
            try:
                normalised = query_builder.public_spec(query_builder.validate_block_spec(candidate, schema, strict=False))
            except query_builder.QueryBuilderError as e:
                results.append(schemas.UpgradeBlockResult(block_id=block.id, title=block.title, status="failed", error=str(e), spec=candidate))
                failed += 1
                continue
            check = dashboard_engine.validate_spec_in_warehouse(ds, normalised, versions, date_column=d.date_column)
            if not check["ok"]:
                results.append(schemas.UpgradeBlockResult(block_id=block.id, title=block.title, status="failed", error=f"The warehouse rejected the query: {check['error']}", spec=normalised, sql=check.get("sql")))
                failed += 1
                continue
            _snapshot_block_config(block)
            new_config = {k: v for k, v in config.items() if k not in ("result_rows", "result_columns", "rows", "columns")}
            new_config["spec"] = normalised
            new_config["computed_in"] = ds.kind
            new_config["spec_columns"] = check["columns"]
            if block.type == "chart" and not new_config.get("chart_type"):
                new_config["chart_type"] = "line" if normalised.get("time") else "bar"
            block.config = new_config
            block.query_sql = check["sql"]
            results.append(schemas.UpgradeBlockResult(block_id=block.id, title=block.title, status="upgraded", spec=normalised, sql=check["sql"]))
            upgraded += 1
    db.commit()
    return schemas.UpgradeBlocksOut(results=results, upgraded=upgraded, failed=failed, skipped=skipped)


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


_MAX_LAYOUT_ITEMS = 200
_MAX_LAYOUT_Y = 100_000
_MAX_LAYOUT_H = 1_000


# Registered BEFORE PATCH /{dashboard_id}/pages/{page_id} (update_page,
# just below). The two cannot actually collide - a path parameter never
# matches a "/", so ".../pages/<id>/layout" is never read as a page id -
# but the more specific route goes first so that stays obvious.
@router.patch("/{dashboard_id}/pages/{page_id}/layout", response_model=schemas.DashboardBuilderOut)
def update_page_layout(
    dashboard_id: str,
    page_id: str,
    payload: schemas.UpdatePageLayoutRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Moves/resizes many blocks of ONE page in one transaction - what the
    canvas sends after a drag or resize re-flows several blocks at once
    (instead of one PATCH per block that could leave the page half-moved).
    Body: {"items": [{"id", "x", "y", "w", "h"}, ...]} - 1 to 200 items,
    each id once, every id a block of THIS page; w 1..12, h >= 1,
    x >= 0, y >= 0, x + w <= 12. Everything is checked before anything is
    written: one bad item (400) or one id that is not on this page (400)
    and no block moves. Layout only - block content, the undo snapshot
    and data_updated_at are untouched. Blocks not listed keep their
    place. Edit rights required, like update_block."""
    d = _get_dashboard_v2(db, user, dashboard_id, require_edit=True)
    page = next((p for p in d.pages if p.id == page_id), None)
    if not page:
        raise HTTPException(404, "Page not found on this dashboard.")
    items = payload.items
    if not items:
        raise HTTPException(400, "Nothing to update - send at least one block's position.")
    if len(items) > _MAX_LAYOUT_ITEMS:
        raise HTTPException(400, f"At most {_MAX_LAYOUT_ITEMS} blocks can be moved in one request.")
    by_id = {b.id: b for b in page.blocks}
    seen: set[str] = set()
    for it in items:
        if it.id in seen:
            raise HTTPException(400, f'Block "{it.id}" appears more than once in this layout.')
        seen.add(it.id)
        if not (1 <= it.w <= _GRID_COLUMNS):
            raise HTTPException(400, f'Block "{it.id}": width must be between 1 and {_GRID_COLUMNS} columns.')
        if not (1 <= it.h <= _MAX_LAYOUT_H):
            raise HTTPException(400, f'Block "{it.id}": height must be between 1 and {_MAX_LAYOUT_H}.')
        if it.x < 0 or not (0 <= it.y <= _MAX_LAYOUT_Y):
            raise HTTPException(400, f'Block "{it.id}": x and y cannot be negative (y at most {_MAX_LAYOUT_Y}).')
        if it.x + it.w > _GRID_COLUMNS:
            raise HTTPException(400, f'Block "{it.id}": x + width cannot exceed the {_GRID_COLUMNS}-column grid.')
    foreign = [it.id for it in items if it.id not in by_id]
    if foreign:
        raise HTTPException(
            400, "These blocks are not on this page, so nothing was moved: " + ", ".join(foreign[:10]) + ".",
        )
    for it in items:
        block = by_id[it.id]
        block.x, block.y, block.w, block.h = it.x, it.y, it.w, it.h
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
    # 2026-10-10 (round 19): a workspace can turn "anyone with the link" off
    # (Trust Center > Policies). Named people and the company domain stay.
    if payload.mode == "public" and d.workspace_id and policies.for_workspace_id(db, d.workspace_id).get("block_public_links"):
        raise HTTPException(403, "This workspace doesn't allow \"anyone with the link\" dashboards. "
                                 "Share it with named people, or publish it on the company domain.")

    share = d.share
    if not share:
        share = models.DashboardShare(dashboard_id=d.id, slug=_make_unique_slug(db, d.name), mode=payload.mode)
        db.add(share)

    share.mode = payload.mode
    if payload.mode == "private":
        password = (payload.password or "").strip()
        share.password_hash = security.hash_password(password) if password else None
    else:
        # A public link has no password - drop one left from private mode.
        share.password_hash = None
    share.published_at = datetime.utcnow()
    audit.log_audit_event(db, actor=user, action="dashboard_published", workspace_id=d.workspace_id,
                          target_type="dashboard", target_id=d.id,
                          metadata={"name": d.name, "mode": payload.mode, "password": bool(share.password_hash)})
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
    audit.log_audit_event(db, actor=user, action="dashboard_share_email_added", workspace_id=d.workspace_id,
                          target_type="dashboard", target_id=d.id, metadata={"name": d.name, "email": email})
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
    audit.log_audit_event(db, actor=user, action="dashboard_share_email_removed", workspace_id=d.workspace_id,
                          target_type="dashboard", target_id=d.id, metadata={"name": d.name, "email": row.email})
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
        audit.log_audit_event(db, actor=user, action="dashboard_unpublished", workspace_id=d.workspace_id,
                              target_type="dashboard", target_id=d.id, metadata={"name": d.name})
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
    if db.query(models.WorkspaceDomain).filter(models.WorkspaceDomain.hostname == domain).first():
        raise HTTPException(400, f'"{domain}" is a company domain on GD360 - publish to it from "Publish to company domain" instead.')

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
    audit.log_audit_event(db, actor=user, action="dashboard_custom_domain_set", workspace_id=d.workspace_id,
                          target_type="dashboard", target_id=d.id, metadata={"name": d.name, "domain": domain})
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

    audit.log_audit_event(db, actor=user, action="dashboard_custom_domain_removed", workspace_id=d.workspace_id,
                          target_type="dashboard", target_id=d.id, metadata={"name": d.name, "domain": share.custom_domain})
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


# 2026-10-05 (public-filters round): pulled out of _render_public_dashboard
# below so preview_filtered_blocks_public and get_public_filter_options
# (further down) can run the exact same access check - mode gate, plus the
# private-dashboard live-token re-verification - without duplicating this
# security-sensitive logic a second (and third) time. Raises the same
# 401/403s _render_public_dashboard always has; callers don't need to
# catch anything, just call it before touching share.dashboard_id.
def _authorize_public_share(share: models.DashboardShare, x_dashboard_access_token: str | None) -> None:
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


# 2026-10-07 (real end-to-end run): what a published link must never carry.
# "Show SQL" on the public view handed table and column names - and a SQL
# cell's whole statement - to anyone with the link. Hiding the button is
# not enough (the text was still in the response), so the public endpoints
# strip it server-side: every compiled statement of a block result (`sql`,
# `prior.sql`, `sparkline.sql`), a block's stored `query_sql`, a SQL cell's
# own `config.sql` and the pandas `source_code` an AI-built file block kept
# for its owner's lineage panel - and a failed block's error is the plain
# "couldn't be computed" (the database's own sentence names columns and
# may quote the statement). The owner's endpoints are unchanged.
_PUBLIC_RESULT_SQL_KEYS = ("sql", "query_sql")
_PUBLIC_GENERIC_ERROR_STATUSES = ("error", "invalid_spec", "invalid_sql", "rejected_unsafe")
_PUBLIC_BLOCK_ERROR = "This block couldn't be computed right now."
_PUBLIC_CONFIG_DROP_KEYS = ("sql", "source_code", "query_sql")


def _strip_sql_from_result(result: dict) -> dict:
    """A BlockResult without any SQL text (a copy; the engine's cached
    result is never mutated)."""
    if not isinstance(result, dict):
        return result
    out = {k: v for k, v in result.items() if k not in _PUBLIC_RESULT_SQL_KEYS}
    for nested in ("prior", "sparkline"):
        if isinstance(out.get(nested), dict):
            out[nested] = {k: v for k, v in out[nested].items() if k not in _PUBLIC_RESULT_SQL_KEYS}
            if out[nested].get("error"):
                out[nested]["error"] = _PUBLIC_BLOCK_ERROR
    # A database's own error sentence names columns and can quote a line
    # of the statement - an anonymous viewer cannot act on either.
    if out.get("status") in _PUBLIC_GENERIC_ERROR_STATUSES and out.get("error"):
        out["error"] = _PUBLIC_BLOCK_ERROR
    return out


def _public_block_config(block_type: str, config) -> dict:
    """A block's config as an anonymous viewer may receive it. A SQL cell
    keeps `has_sql` so the page still knows the cell is built (and shows
    its result) without ever holding the statement."""
    if not isinstance(config, dict):
        return {}
    out = {k: v for k, v in config.items() if k not in _PUBLIC_CONFIG_DROP_KEYS}
    if block_type == "sql":
        out["has_sql"] = bool(str(config.get("sql") or "").strip())
    return out


def _public_page_out(page: models.DashboardPage) -> schemas.DashboardPageOut:
    out = _page_out(page)
    for b in out.blocks:
        b.query_sql = None
        b.config = _public_block_config(b.type, b.config)
    return out


def _public_filtered_out(out: schemas.FilteredBlocksOut) -> schemas.FilteredBlocksOut:
    for b in out.blocks:
        b.config = _public_block_config(b.type, b.config)
    return out


def _count_view(db: Session, share: models.DashboardShare) -> None:
    """2026-10-10 (round 19): views of a published link, for the Trust
    Center's Sharing tab. Best effort - a view is never refused over it."""
    try:
        share.view_count = (share.view_count or 0) + 1
        share.last_viewed_at = datetime.utcnow()
        db.commit()
    except Exception as e:  # noqa: BLE001
        print(f"[dashboard_builder] view count skipped (non-fatal): {e}")
        db.rollback()


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
    _authorize_public_share(share, x_dashboard_access_token)

    d = db.query(models.Dashboard).filter(models.Dashboard.id == share.dashboard_id).first()
    if not d:
        raise HTTPException(404, "This dashboard isn't available.")
    # 2026-10-07 (identity-colour round): the same colours the owner sees.
    # Stored results are registered here too (canonical - see
    # _assign_stored_colors), then the resolved appearance goes out.
    _assign_stored_colors(db, d)
    ds = _dashboard_datasource(db, d)
    pages = [_public_page_out(p) for p in sorted(d.pages, key=lambda p: p.position)]
    return schemas.PublicDashboardOut(
        name=d.name,
        pages=pages,
        brand_primary_color=d.brand_primary_color,
        brand_accent_color=d.brand_accent_color,
        background_style=d.background_style,
        background_color=d.background_color,
        has_logo=bool(d.logo_image),
        has_background_image=bool(d.background_image),
        **_appearance_fields(db, d, ds, include_kit=False),
        **_warehouse_dashboard_fields(db, d, ds, include_tables=False),
    )


# 2026-10-06 (warehouse-native dashboards layer): the published view of a
# warehouse dashboard has no static rows to show - every block is a spec
# that must be computed inside the warehouse. So, unlike the pre-layer
# public preview (which deliberately never touched a live connection),
# the public run/options endpoints below DO run queries, with these
# boundaries: only for a currently-published share that passes the same
# mode/token gate as the content fetch; only the dashboard OWNER's
# connection, spending the OWNER's daily scan budget and writing the
# OWNER's audit rows (an anonymous viewer has no account to charge);
# tighter per-ip and per-slug rate limits than the content fetch; the
# result cache absorbs repeat views of the same filter state; and nothing
# is persisted from this path (no last_run writes).
def _public_warehouse_context(db: Session, share: models.DashboardShare, x_dashboard_access_token: str | None):
    _authorize_public_share(share, x_dashboard_access_token)
    d = db.query(models.Dashboard).filter(models.Dashboard.id == share.dashboard_id).first()
    if not d:
        raise HTTPException(404, "This dashboard isn't available.")
    ds = _dashboard_datasource(db, d)
    if not ds or not dashboard_engine.is_warehouse_native(ds):
        raise HTTPException(400, "This dashboard's blocks are not computed in a warehouse.")
    return d, ds


def _public_run(db, share, page_id, payload, x_dashboard_access_token) -> schemas.RunPageOut:
    d, ds = _public_warehouse_context(db, share, x_dashboard_access_token)
    page = next((p for p in d.pages if p.id == page_id), None)
    if not page:
        raise HTTPException(404, "Page not found on this dashboard.")
    out = _run_page_for(db, d, page, ds, payload, d.owner_id, persist_last_run=False, anonymous=True)
    out.blocks = {bid: _strip_sql_from_result(res) for bid, res in (out.blocks or {}).items()}
    return out


def _public_options(db, share, param_id, search, limit, x_dashboard_access_token) -> schemas.ParameterOptionsOut:
    d, ds = _public_warehouse_context(db, share, x_dashboard_access_token)
    return _parameter_options_for(db, d, ds, param_id, search, limit, d.owner_id)


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
    out = _render_public_dashboard(db, share, x_dashboard_access_token)
    _count_view(db, share)
    return out


# 2026-10-05 (public-filters round): "in published dashboard i cannot
# able to use the filters" - Gokul's own words, with a screenshot of the
# inert "All" dropdown StaticFilterNote renders on this view (see
# DashboardBlocks.tsx's own comment on it). This was never a missing
# onClick handler - see this file's module docstring (Phase 2b, point 3)
# for the real reason filtering was never wired up here: the authenticated
# preview_filtered_blocks above can touch a customer's own live, credentialed
# warehouse/database connection, which is not something an anonymous
# stranger with the public link should ever be able to trigger with no
# rate limit.
#
# This endpoint closes that gap WITHOUT crossing that line: df/ds are
# always None here, so _filter_page_blocks (shared with the authenticated
# endpoint above) skips every recipe-based block exactly like it already
# does whenever the editor's own live datasource fails to load - no live
# query, no customer credentials, ever reachable from this anonymous
# route. What it DOES make work: every self-contained AI-built table/chart
# block, which carries its own already-computed result_columns/result_rows
# and recomputes straight from those. That covers the common case (an
# AI-auto-built dashboard) - a hand-built "Build manually" recipe block
# stays un-filterable on the public link for now, same as before this
# round, which is the honest remaining gap rather than something this
# endpoint silently papers over.
@public_router.post("/{slug}/pages/{page_id}/preview-filtered", response_model=schemas.FilteredBlocksOut)
def preview_filtered_blocks_public(
    slug: str,
    page_id: str,
    payload: schemas.ApplyFiltersRequest,
    request: Request,
    db: Session = Depends(get_db),
    x_dashboard_access_token: str | None = Header(default=None, alias="X-Dashboard-Access-Token"),
):
    ip = _client_ip(request)
    _check_rate_limit(f"public-filter:ip:{ip}", limit=90)
    _check_rate_limit(f"public-filter:slug:{slug}", limit=60)

    share = _resolve_share_by_slug(db, slug)
    _authorize_public_share(share, x_dashboard_access_token)
    d = db.query(models.Dashboard).filter(models.Dashboard.id == share.dashboard_id).first()
    if not d:
        raise HTTPException(404, "This dashboard isn't available.")
    page = next((p for p in d.pages if p.id == page_id), None)
    if not page:
        raise HTTPException(404, "Page not found on this dashboard.")

    # 2026-10-06 (warehouse-native dashboards layer): a warehouse dashboard
    # computes its spec'd blocks in the warehouse (owner's connection and
    # budget - see _public_warehouse_context); a file dashboard keeps the
    # static, no-live-connection path exactly as before.
    ds = _dashboard_datasource(db, d)
    if ds and dashboard_engine.is_warehouse_native(ds):
        _check_rate_limit(f"public-run:ip:{ip}", limit=_PUBLIC_RUN_RATE_LIMIT)
        _check_rate_limit(f"public-run:slug:{slug}", limit=_PUBLIC_RUN_RATE_LIMIT)
        return _public_filtered_out(_filter_page_blocks_warehouse(db, d, page, ds, payload, d.owner_id, anonymous=True))
    out = _filter_page_blocks(db, page, df=None, ds=None, payload=payload)
    return _public_filtered_out(_with_file_colors(db, d, page, out, payload, anonymous=True))


@public_router.post("/{slug}/pages/{page_id}/run", response_model=schemas.RunPageOut)
def run_page_public(
    slug: str,
    page_id: str,
    payload: schemas.RunPageRequest,
    request: Request,
    db: Session = Depends(get_db),
    x_dashboard_access_token: str | None = Header(default=None, alias="X-Dashboard-Access-Token"),
):
    """The published view's run endpoint - same request/response as the
    authenticated POST /dashboard-builder/{id}/pages/{page_id}/run. See
    _public_warehouse_context for the boundaries."""
    ip = _client_ip(request)
    _check_rate_limit(f"public-run:ip:{ip}", limit=_PUBLIC_RUN_RATE_LIMIT)
    _check_rate_limit(f"public-run:slug:{slug}", limit=_PUBLIC_RUN_RATE_LIMIT)
    share = _resolve_share_by_slug(db, slug)
    return _public_run(db, share, page_id, payload, x_dashboard_access_token)


@public_router.get("/{slug}/parameters/{param_id}/options", response_model=schemas.ParameterOptionsOut)
def get_parameter_options_public(
    slug: str,
    param_id: str,
    request: Request,
    search: str | None = None,
    limit: int = 50,
    db: Session = Depends(get_db),
    x_dashboard_access_token: str | None = Header(default=None, alias="X-Dashboard-Access-Token"),
):
    ip = _client_ip(request)
    _check_rate_limit(f"public-options:ip:{ip}", limit=60)
    _check_rate_limit(f"public-options:slug:{slug}", limit=60)
    share = _resolve_share_by_slug(db, slug)
    return _public_options(db, share, param_id, search, limit, x_dashboard_access_token)


@public_domains_router.post("/{hostname}/pages/{page_id}/run", response_model=schemas.RunPageOut)
def run_page_public_by_domain(
    hostname: str,
    page_id: str,
    payload: schemas.RunPageRequest,
    request: Request,
    db: Session = Depends(get_db),
    x_dashboard_access_token: str | None = Header(default=None, alias="X-Dashboard-Access-Token"),
):
    ip = _client_ip(request)
    _check_rate_limit(f"public-run:ip:{ip}", limit=_PUBLIC_RUN_RATE_LIMIT)
    _check_rate_limit(f"public-run:domain:{hostname}", limit=_PUBLIC_RUN_RATE_LIMIT)
    share = _resolve_share_by_domain(db, hostname)
    return _public_run(db, share, page_id, payload, x_dashboard_access_token)


@public_domains_router.get("/{hostname}/parameters/{param_id}/options", response_model=schemas.ParameterOptionsOut)
def get_parameter_options_public_by_domain(
    hostname: str,
    param_id: str,
    request: Request,
    search: str | None = None,
    limit: int = 50,
    db: Session = Depends(get_db),
    x_dashboard_access_token: str | None = Header(default=None, alias="X-Dashboard-Access-Token"),
):
    ip = _client_ip(request)
    _check_rate_limit(f"public-options:ip:{ip}", limit=60)
    _check_rate_limit(f"public-options:domain:{hostname}", limit=60)
    share = _resolve_share_by_domain(db, hostname)
    return _public_options(db, share, param_id, search, limit, x_dashboard_access_token)


@public_domains_router.post("/{hostname}/pages/{page_id}/preview-filtered", response_model=schemas.FilteredBlocksOut)
def preview_filtered_blocks_public_by_domain(
    hostname: str,
    page_id: str,
    payload: schemas.ApplyFiltersRequest,
    request: Request,
    db: Session = Depends(get_db),
    x_dashboard_access_token: str | None = Header(default=None, alias="X-Dashboard-Access-Token"),
):
    """Hostname-keyed twin of preview_filtered_blocks_public (the slug
    router had one, the domain router did not)."""
    ip = _client_ip(request)
    _check_rate_limit(f"public-filter:ip:{ip}", limit=90)
    _check_rate_limit(f"public-filter:domain:{hostname}", limit=60)
    share = _resolve_share_by_domain(db, hostname)
    _authorize_public_share(share, x_dashboard_access_token)
    d = db.query(models.Dashboard).filter(models.Dashboard.id == share.dashboard_id).first()
    if not d:
        raise HTTPException(404, "This dashboard isn't available.")
    page = next((p for p in d.pages if p.id == page_id), None)
    if not page:
        raise HTTPException(404, "Page not found on this dashboard.")
    ds = _dashboard_datasource(db, d)
    if ds and dashboard_engine.is_warehouse_native(ds):
        _check_rate_limit(f"public-run:ip:{ip}", limit=_PUBLIC_RUN_RATE_LIMIT)
        _check_rate_limit(f"public-run:domain:{hostname}", limit=_PUBLIC_RUN_RATE_LIMIT)
        return _public_filtered_out(_filter_page_blocks_warehouse(db, d, page, ds, payload, d.owner_id, anonymous=True))
    out = _filter_page_blocks(db, page, df=None, ds=None, payload=payload)
    return _public_filtered_out(_with_file_colors(db, d, page, out, payload, anonymous=True))


# Companion to preview_filtered_blocks_public above: a filter block's own
# "Values" checklist and dtype-aware "Condition" tab (ColumnFilterSpecEditor
# on the frontend) need to know what values a column actually has BEFORE
# any filter is applied - the authenticated editor gets that from
# datasources.py's get_column_distinct_values, which queries the live
# datasource directly. That's exactly the live-query-from-an-anonymous-
# link exposure this file avoids everywhere else on the public router, so
# this endpoint answers the same question a different way: it looks at
# every table/chart block ALREADY on this page that happens to include
# the requested column, and computes distinct values/dtype from THEIR
# already-materialized result_rows (unioned across however many blocks
# have that column) - never the live datasource. A page where no block
# happens to carry this column returns an honest empty list rather than
# an error - the frontend's Values tab shows "no data available to filter
# by" and the Condition tab still works as a plain freeform input.
@public_router.get("/{slug}/pages/{page_id}/filter-options")
def get_public_filter_options(
    slug: str,
    page_id: str,
    column: str,
    request: Request,
    db: Session = Depends(get_db),
    x_dashboard_access_token: str | None = Header(default=None, alias="X-Dashboard-Access-Token"),
):
    ip = _client_ip(request)
    _check_rate_limit(f"public-filter-options:ip:{ip}", limit=90)
    _check_rate_limit(f"public-filter-options:slug:{slug}", limit=60)

    share = _resolve_share_by_slug(db, slug)
    _authorize_public_share(share, x_dashboard_access_token)
    d = db.query(models.Dashboard).filter(models.Dashboard.id == share.dashboard_id).first()
    if not d:
        raise HTTPException(404, "This dashboard isn't available.")
    page = next((p for p in d.pages if p.id == page_id), None)
    if not page:
        raise HTTPException(404, "Page not found on this dashboard.")
    return _page_filter_options(page, column)


def _page_filter_options(page: models.DashboardPage, column: str) -> dict:
    """Distinct values of `column` from the page's own stored block rows
    (never the live datasource) - shared by the slug link and the company
    domain viewer (routers/domains.py)."""
    frames: list[pd.DataFrame] = []
    for block in page.blocks:
        if block.type not in ("table", "chart"):
            continue
        cols = (block.config or {}).get("result_columns")
        rows = (block.config or {}).get("result_rows")
        if not cols or not rows:
            continue
        col_names = [c.get("name") for c in cols]
        if column not in col_names:
            continue
        try:
            frames.append(pd.DataFrame(rows, columns=col_names)[[column]])
        except Exception:
            continue

    if not frames:
        return {"column": column, "values": [], "null_count": 0, "distinct_total": 0, "truncated": False, "dtype": ""}

    series = pd.concat(frames, ignore_index=True)[column]
    null_count = int(series.isna().sum())
    counts = series.value_counts(dropna=True)
    limit = 200
    truncated = bool(len(counts) > limit)
    top = counts.iloc[:limit]
    values = [{"value": _jsonify_scalar(idx), "count": int(cnt)} for idx, cnt in top.items()]

    return {
        "column": column,
        "values": values,
        "null_count": null_count,
        "distinct_total": int(counts.shape[0]),
        "truncated": truncated,
        "dtype": str(series.dtype),
    }


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
    out = _render_public_dashboard(db, share, x_dashboard_access_token)
    _count_view(db, share)
    return out
