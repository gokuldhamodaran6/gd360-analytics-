"""
Pydantic request/response schemas.
"""
from datetime import datetime
from typing import Optional, Any, Literal

from pydantic import BaseModel, EmailStr, Field


# ---------- Auth ----------
class UserCreate(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8)
    full_name: Optional[str] = None
    company: Optional[str] = None
    captcha_id: str
    captcha_answer: str


class UserLogin(BaseModel):
    email: EmailStr
    password: str


class UserOut(BaseModel):
    id: str
    email: EmailStr
    full_name: Optional[str] = None
    company: Optional[str] = None
    created_at: datetime
    # 2026-09-24 (full-app security round): computed server-side from
    # deps.is_admin_email and returned on register/login/me/profile, so the
    # frontend never again needs its own hardcoded copy of the admin email
    # list (previously duplicated in TopNav.tsx AND AdminLogin.tsx, shipped
    # in plain text in the public JS bundle). Defaults false so any caller
    # building a UserOut without explicitly setting it never accidentally
    # grants admin UI.
    is_admin: bool = False

    class Config:
        from_attributes = True


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


class CaptchaOut(BaseModel):
    captcha_id: str
    question: str


class UpdateProfileRequest(BaseModel):
    full_name: Optional[str] = Field(default=None, max_length=120)
    company: Optional[str] = Field(default=None, max_length=120)


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8)


# ---------- Workspaces ----------
class WorkspaceCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class WorkspaceRenameRequest(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class WorkspaceOut(BaseModel):
    id: str
    name: str
    is_personal: bool
    role: str  # "owner" | "member" - the CURRENT user's role in this workspace
    member_count: int
    datasource_count: int
    invite_token: str
    created_at: datetime


class WorkspaceMemberOut(BaseModel):
    user_id: str
    email: EmailStr
    full_name: Optional[str] = None
    role: str  # "owner" | "member" | "viewer"
    created_at: datetime


class WorkspaceDetailOut(WorkspaceOut):
    members: list[WorkspaceMemberOut]


class WorkspaceMemberRoleUpdate(BaseModel):
    # Only ever "member" (full collaborate access) or "viewer" (read-only)
    # - a workspace's "owner" role is set once at creation and never
    # changed through this endpoint; see routers/workspaces.py
    # update_member_role for the actual validation.
    role: str


class InvitePreviewOut(BaseModel):
    workspace_id: str
    workspace_name: str
    member_count: int
    already_member: bool


class AssignWorkspaceRequest(BaseModel):
    workspace_id: str


# ---------- DataSources ----------
class DataSourceCreateDB(BaseModel):
    name: str
    kind: str  # postgres | mysql | mongodb | sqlserver | supabase
    host: str
    port: int
    database: str
    username: str
    password: str
    ssl: bool = True


# A data warehouse authenticates completely differently from a database
# connection above (a service-account key, never a host/port/username/
# password), so it gets its own request shape and its own endpoint
# (POST /datasources/warehouse) rather than being squeezed into
# DataSourceCreateDB.
class DataSourceCreateWarehouse(BaseModel):
    name: str
    kind: str  # bigquery | snowflake (more warehouse kinds may be added later)
    # --- BigQuery fields ---
    project_id: str = ""
    dataset_id: str = ""
    service_account_json: str = ""
    # --- Snowflake fields (Enterprise Scale Roadmap, Phase 2) ---
    # Snowflake authenticates completely differently from BigQuery (a
    # username/password against an account, never a service-account key),
    # so it gets its own set of fields here rather than reusing the
    # BigQuery ones above - each kind's handler in routers/datasources.py
    # connect_warehouse only ever reads the fields that apply to it.
    account: str = ""  # e.g. "xy12345.us-east-1" - the account identifier from the Snowflake URL
    snowflake_warehouse: str = ""  # Snowflake's own compute cluster name (unrelated to "kind: warehouse" above)
    database: str = ""
    db_schema: str = ""  # optional - the user's default schema is used when left blank
    role: str = ""  # optional - the user's default role is used when left blank
    username: str = ""
    password: str = ""


# ---------- Live OAuth connectors (Google Sheets, Microsoft Excel) ----------
# See routers/connections.py for the full authorize -> callback -> pick a
# resource -> finish flow these support.
class OAuthAuthorizeOut(BaseModel):
    authorize_url: str


class OAuthResourceOut(BaseModel):
    id: str
    name: str
    modified_at: Optional[str] = None
    # Microsoft only: which drive this item lives in (None for the
    # person's own OneDrive, set for a SharePoint/shared library item) -
    # round-tripped back on OAuthFinishRequest so the workbook can be
    # addressed the same way again on every later live load.
    drive_id: Optional[str] = None


class OAuthResourcesOut(BaseModel):
    provider: str
    resources: list[OAuthResourceOut]


class OAuthFinishRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    resource_id: str
    resource_name: str
    drive_id: Optional[str] = None


# Google Sheets picks its spreadsheet through Google's own file-picker
# widget (see ConnectResourcePicker.tsx) rather than our own search list,
# so the browser needs to hold this connection's own access token just
# long enough to open that widget - never logged, never stored client
# side, and only ever handed to Google's picker.js, the same discipline
# oauth_tokens.py already documents for every other use of this token.
class PickerTokenOut(BaseModel):
    access_token: str


class DataSourceOut(BaseModel):
    id: str
    name: str
    kind: str
    connection_info: dict
    read_only: bool
    schema_cache: Optional[dict] = None
    created_at: datetime
    # 2026-09-28 (streaming/webhook ingestion round): the last time this
    # source actually received a real webhook event - always None for
    # every non-"streaming" kind. The frontend's "live" pulsing-dot
    # indicator is purely a function of this timestamp (see
    # DataSources.tsx) - never a separately-guessed status.
    last_event_at: Optional[datetime] = None
    # Phase 2, feature 4 (generic API/webhook PULL connector): the last
    # time this kind=="api" source's URL was successfully fetched (at
    # connect time, or a later manual refresh) - always None for every
    # other kind, and None for an "api" source that has never successfully
    # fetched. See models.DataSource's own docstring.
    api_last_refreshed_at: Optional[datetime] = None

    class Config:
        from_attributes = True


# ---------- Chat / AI ----------
class ChatRequest(BaseModel):
    conversation_id: Optional[str] = None
    datasource_id: str
    prompt: str
    # Optional explicit chart customization instructions layered on top of prompt
    chart_override: Optional[dict] = None


class ChatResponse(BaseModel):
    conversation_id: str
    message_id: str
    role: str = "assistant"
    reply_text: str
    # 2026-09-28 root-cause fix: false only when nothing real actually
    # happened - every retry was exhausted and reply_text is one of the
    # generic "I was not able to..." failure narratives (see ai_engine.
    # _no_result / _TRANSFORM_FAILURE_NARRATIVE / _ANALYZE_FAILURE_
    # NARRATIVE). A genuine clarifying question is still ok=True - the
    # model just needs more information, which is a normal turn, not a
    # failure. Before this field existed, this response's HTTP 200 status
    # was the ONLY signal the frontend had, so a friendly-but-empty
    # failure narrative looked identical to a real result - see
    # Workspace.tsx runPrompt, which now returns this field's value
    # instead of just "did the HTTP call succeed."
    ok: bool = True
    # 2026-09-28 (transparency round): a real, honest trace of what this
    # turn actually did while it was running - see models.Message.steps'
    # own docstring. None (the common case: one clean attempt, nothing
    # noteworthy to report) means the frontend simply shows no "Show what
    # I did" toggle for this turn, rather than an empty one.
    steps: Optional[list] = None
    # 2026-09-28 (multi-result round): when a request genuinely asks for
    # several distinct analyses in one go (e.g. "build the forecast,
    # profit, and segments models"), the engine can now produce more than
    # one chart/table in a single answer - see ai_engine._build_result_entry
    # and models.Message.results. Each entry is {label, chart_spec,
    # chart_type, result_columns, result_rows, result_row_count,
    # result_truncated} - the same shape the single-result fields below
    # already use, just one per named piece. None/empty means this turn
    # produced exactly one result, same as before this round - the single
    # top-level chart_spec/result_* fields below are always still populated
    # from the first entry, so nothing that only reads those needs to
    # change.
    results: Optional[list] = None
    # A real, honest caveat about whether THIS result is actually
    # trustworthy - see the "Honest self-critique for anything model-like"
    # rule in ai_engine.SYSTEM_PROMPT. None means nothing was fitted or
    # predicted (a plain aggregation/chart), so there is nothing to caveat.
    self_critique: Optional[str] = None
    action: str = "analyze"
    chart_spec: Optional[dict] = None
    # The chart type actually rendered (e.g. "bar", "scatter") - the
    # Explore panel's chart-type picker needs this as its starting
    # selection, since chart_spec itself doesn't reliably name its own type.
    chart_type: Optional[str] = None
    # Tidy, row-level numbers behind this chart (see
    # chart_builder.result_to_tidy) plus per-column dtype/role metadata -
    # what lets the frontend's Explore panel remap axes/chart type/filters
    # instantly, client-side, against the real numbers instead of only ever
    # having the one fixed chart_spec above. None when the result wasn't
    # tabular (e.g. a bare scalar answer).
    result_columns: Optional[list] = None
    result_rows: Optional[list] = None
    result_truncated: bool = False
    insight: Optional[str] = None
    suggested_charts: Optional[list] = None
    suggested_stats: Optional[list] = None
    # Specific, contextual "what to try next" buttons tied to this exact
    # result (e.g. an alternative correlation method) - distinct from the
    # generic, dataset-level suggested_charts/suggested_stats above.
    follow_up_suggestions: Optional[list] = None
    needs_clarification: bool = False
    rows_before: Optional[int] = None
    rows_after: Optional[int] = None
    nulls_before: Optional[int] = None
    nulls_after: Optional[int] = None
    # Set only when this prompt created a new saved table (a cleaning/prep
    # transform), so the client can add it as a new tab and switch to it.
    new_version_id: Optional[str] = None
    new_version_name: Optional[str] = None
    # Set only in step-by-step ("guided") analysis mode, right after this
    # turn prepared a table but has NOT yet run the actual analysis on it -
    # the client shows this as a single prominent button; clicking it
    # re-sends "prompt" with skip_prep=true and source_version_ids=
    # [version_id] to run the analysis against the just-prepared table.
    continue_action: Optional[dict] = None
    # 2026-09-29 (plain-language findings round): the real method label and
    # the real code that produced THIS answer, plus how long the whole turn
    # actually took - all three were already computed every turn (Phase 1)
    # and already saved onto Message for the Flow tab, but never actually
    # included in the live chat response before now, so a "Show calculation"
    # toggle right under an answer had nothing to show without navigating
    # away to the Flow tab first. None only when nothing meaningful
    # classified (see ai_engine._derive_method_summary's own fallback) or
    # this turn is a paused prep-only step (see routers/chat.py's
    # persisted_code note) - never a fabricated label or a made-up duration.
    method_summary: Optional[str] = None
    code: Optional[str] = None
    duration_ms: Optional[int] = None


# ---------- Verify ("Double-check this") ----------
class VerifyResponse(BaseModel):
    # "confirmed": reviewed and found correct, nothing changed.
    # "corrected": an issue was found and this message was fixed in place
    #   (reply_text/chart_spec/insight below are the corrected versions).
    # "unavailable": the review itself could not be completed (a transient
    #   AI service issue), or found a bigger problem that needs a fresh
    #   message rather than an in-place fix - the original answer is
    #   unchanged either way.
    status: str
    message: str
    message_id: str
    reply_text: Optional[str] = None
    chart_spec: Optional[dict] = None
    chart_type: Optional[str] = None
    result_columns: Optional[list] = None
    result_rows: Optional[list] = None
    result_truncated: bool = False
    insight: Optional[str] = None
    new_version_id: Optional[str] = None
    new_version_name: Optional[str] = None


# ---------- Dataset versions (saved/named tables) ----------
class RenameVersionRequest(BaseModel):
    name: str = Field(min_length=1, max_length=80)


# ---------- Data tab: natural-language filter bar ----------
class ParseFilterRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=500)
    table: Optional[str] = None
    version_id: Optional[str] = None


# ---------- Data tab: Saved Views (a named snapshot of the whole Data tab
# display - sort/filter/columns/format - see models.SavedView) ----------
class SavedViewCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    table: Optional[str] = None
    version_id: Optional[str] = None
    config: dict


class SavedViewOut(BaseModel):
    id: str
    name: str
    table: Optional[str] = None
    version_id: Optional[str] = None
    config: dict
    created_at: datetime
    updated_at: datetime
    # Who actually created this view (2026-09-23, workspace roles &
    # attribution round) - saved views are shared team-wide once their data
    # source is, so the Views dropdown can now show "by <name>" instead of
    # every teammate's views looking like they came from whoever's looking
    # at them.
    created_by_id: Optional[str] = None
    created_by_name: Optional[str] = None
    created_by_email: Optional[str] = None


# ---------- Rename a data source (the file/connection name shown as
# "Analyzing: <name>" at the top of the Workspace page, and everywhere else
# that name is displayed) ----------
class RenameDataSourceRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)


# ---------- Update a conversation (its title and/or pinned state, wherever
# it's listed - the homepage's Recent conversations, a data source's own
# conversation list, and the Workspace page's own Recent conversations
# panel). Both fields are optional so the same endpoint serves a plain
# rename, a plain pin/unpin, or - in principle - both at once, without the
# caller needing to resend a field it isn't changing. ----------
class UpdateConversationRequest(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=80)
    pinned: bool | None = None


# Kept as an alias so any older caller still referencing the previous name
# keeps working unchanged.
RenameConversationRequest = UpdateConversationRequest


# ---------- Dashboards (2026-09-23: can optionally be shared into a
# workspace instead of staying personal - see models.Dashboard and
# routers/dashboards.py) ----------
class DashboardCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    # Share this brand-new dashboard with a team workspace right away
    # instead of keeping it personal. Omitted/None = personal, same as
    # before shared dashboards existed.
    workspace_id: Optional[str] = None


class DashboardRenameRequest(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class DashboardShareRequest(BaseModel):
    # Sets which workspace this dashboard is shared with - None un-shares
    # it back to personal (visible only to its creator again).
    workspace_id: Optional[str] = None


class SaveChartRequest(BaseModel):
    dashboard_id: Optional[str] = None
    dashboard_name: Optional[str] = None
    # Only used when dashboard_id is omitted (a brand-new dashboard is
    # being created by this save) and the person wants it shared with a
    # workspace right away rather than staying personal.
    workspace_id: Optional[str] = None
    title: str
    chart_spec: dict
    insight: Optional[str] = None


class DashboardOut(BaseModel):
    id: str
    name: str
    workspace_id: Optional[str] = None
    workspace_name: Optional[str] = None
    created_at: datetime
    chart_count: int
    # Whether the CURRENT signed-in user created this dashboard themselves
    # (vs. seeing it because a teammate shared it into a workspace they're
    # both in).
    is_own: bool
    created_by_name: Optional[str] = None
    created_by_email: Optional[str] = None
    can_edit: bool
    can_delete: bool
    # 2026-09-24 (Dashboard Builder Phase 1): 1 = the original flat
    # saved-chart board (routers/dashboards.py, DashboardView.tsx);
    # 2 = a new pages+blocks dashboard (routers/dashboard_builder.py,
    # DashboardBuilderView.tsx). Lets the Dashboards.tsx list page route a
    # click at each dashboard to the right viewer/editor.
    layout_version: int = 1


class SavedChartOut(BaseModel):
    id: str
    title: str
    chart_spec: dict
    insight: Optional[str] = None
    position: int


class DashboardDetailOut(DashboardOut):
    charts: list[SavedChartOut]


# ---------- Dashboard Builder (2026-09-24, Phase 1): the new pages+blocks
# dashboard model - see models.Dashboard/DashboardPage/DashboardBlock/
# DashboardShare and routers/dashboard_builder.py for the full picture. ----------
class GenerateDashboardRequest(BaseModel):
    conversation_id: str = Field(min_length=1)
    # 2026-09-25 (Round 2, the "AI Build" wizard): optional - when set, the
    # dashboard is built FRESH around this plain-English description
    # (GD360 plans a set of blocks and runs a real, new analysis for each
    # one against this conversation's data source) instead of the original
    # one-shot behavior of just laying out whatever charts/tables already
    # happen to be in this chat. Omitted/blank keeps that original
    # behavior exactly as it always worked - see generate_dashboard's own
    # docstring for the full picture.
    # 2026-09-28: raised from 500 to match BuildDashboardModal.tsx's own
    # textarea cap (raised the same round) - this was silently rejecting
    # (422) any longer, genuinely detailed goal description the frontend
    # now happily accepts, which the modal would have shown as raw,
    # unreadable Pydantic error JSON instead of a real message.
    goal: Optional[str] = Field(default=None, max_length=2000)
    # 2026-09-28 (datasource picker round): optional explicit override for
    # which DataSource the goal-driven build loads and analyzes. Real
    # usage showed the previous conversation-only resolution (see
    # _resolve_datasource) silently building a dashboard from whatever
    # data source happened to be behind the currently-open chat, which is
    # not necessarily the data source the person actually meant - e.g. a
    # schema-catalog conversation left open while they meant to build
    # against their real sales data. Omitted/blank keeps the exact
    # original conversation-derived resolution (backward compatible - an
    # old frontend build, or the goal-less "Skip" recap path, never sends
    # this). See generate_dashboard's own docstring for how it's used.
    datasource_id: Optional[str] = Field(default=None)


# 2026-09-25 (Round 2, "build own"): a blank v2 dashboard tied to a
# conversation's data source but with zero blocks - the person adds and
# fills every block themselves via the existing Phase 2 canvas. See
# routers/dashboard_builder.py's create_blank_dashboard.
class CreateBlankDashboardRequest(BaseModel):
    conversation_id: str = Field(min_length=1)


# 2026-09-25 (Round 5, template gallery): the third choice in
# BuildDashboardModal.tsx, alongside "Build with AI" and "Create your
# own" - a v2 dashboard pre-laid-out from one of the fixed catalog
# entries GET /dashboard-builder/templates returns. See
# routers/dashboard_builder.py's _TEMPLATES for why a template only ever
# supplies layout (page names, block types, grid positions, placeholder
# titles), never data.
class CreateFromTemplateRequest(BaseModel):
    conversation_id: str = Field(min_length=1)
    template_key: str = Field(min_length=1)


# 2026-09-25 (Round 5): what GET /dashboard-builder/templates returns -
# the same shape create_from_template reads from, so the gallery's
# preview thumbnails can never drift from what "Use this template"
# actually builds.
class DashboardTemplateBlockOut(BaseModel):
    type: str
    title: Optional[str] = None
    x: int
    y: int
    w: int
    h: int


class DashboardTemplatePageOut(BaseModel):
    name: str
    blocks: list[DashboardTemplateBlockOut]


class DashboardTemplateOut(BaseModel):
    key: str
    name: str
    description: str
    icon: str
    pages: list[DashboardTemplatePageOut]


# 2026-09-25 (Round 2): renaming a v2 dashboard's own name - see
# routers/dashboard_builder.py's update_dashboard.
class UpdateDashboardRequest(BaseModel):
    name: Optional[str] = Field(default=None, max_length=120)


class DashboardBlockOut(BaseModel):
    id: str
    # 2026-09-25 (Round 3): added "gauge" | "donut" | "sparkline" |
    # "avatar_list" - four native widget types, config shapes documented
    # in routers/dashboard_builder.py's own module docstring. 2026-09-25
    # (Round 15): added "heading" | "divider" - the element library's two
    # pure-layout widgets, no computed data.
    type: str  # "chart" | "table" | "kpi" | "text" | "filter" | "gauge" | "donut" | "sparkline" | "avatar_list" | "heading" | "divider"
    title: Optional[str] = None
    x: int
    y: int
    w: int
    h: int
    config: dict
    position: int
    # 2026-09-25g (live-data freshness round): when this block's data was
    # last actually recomputed - None for a block that has never been
    # built yet, or one that existed before this column did (never
    # backfilled with a guessed time - see models.DashboardBlock's own
    # docstring). Read by the frontend's DataFreshnessBadge.
    data_updated_at: Optional[datetime] = None
    # 2026-09-29 (design revamp): whether models.DashboardBlock.previous_config
    # currently holds a real snapshot this block's kebab-menu "Undo last
    # change" option can revert to - never the snapshot itself (that would
    # double this payload's size for every block on every load, for a
    # feature only used right after an edit); the frontend just needs the
    # yes/no to decide whether to show the option at all.
    can_undo: bool = False


class DashboardPageOut(BaseModel):
    id: str
    name: str
    position: int
    blocks: list[DashboardBlockOut]
    # 2026-09-25 (Round 4, branding): this page's own background tint
    # override, or None to inherit the parent dashboard's background - see
    # models.DashboardPage's own docstring.
    background_color: Optional[str] = None


# ---------- Dashboard Builder Phase 3 (2026-09-24): page management +
# private sharing. See routers/dashboard_builder.py for the full design. ----
class DashboardShareEmailOut(BaseModel):
    id: str
    email: str


# 2026-09-28 (senior-UX round): the small, lightweight shape behind
# GET /dashboard-builder/by-conversation/{conversation_id} - see that
# endpoint's own docstring for the real problem this fixes (there was no
# way to find a dashboard again from the same chat it was built from).
# Deliberately NOT the full DashboardBuilderOut (pages/blocks/branding/
# sharing) - the header menu this feeds only ever needs enough to list
# and link to each dashboard, so this stays a cheap, summary-only query.
# Defined here, above DashboardBuilderOut, because that class's own
# sibling_dashboards field (2026-09-29, design revamp) is typed as a list
# of these.
class DashboardBuilderSummaryOut(BaseModel):
    id: str
    name: str
    created_at: datetime
    page_count: int
    block_count: int
    can_edit: bool
    is_published: bool


class DashboardBuilderOut(BaseModel):
    id: str
    name: str
    layout_version: int
    created_at: datetime
    source_conversation_id: Optional[str] = None
    # 2026-09-29 (design revamp): "i want a option like see from which
    # project this dashboard created" - models.Dashboard's own docstring
    # already promised a "Built from: <title>" surface for
    # source_conversation_id but the frontend never actually built it
    # until now. title/datasource_id are resolved server-side (a dashboard
    # itself never stores them, only the id) purely so
    # DashboardBuilderView.tsx can render "Built from: <title>" as a real
    # link - source_conversation_datasource_id is what that link needs
    # (Workspace.tsx's route is /workspace/{datasourceId}?conversation=
    # {conversationId}, not just the conversation id alone). Both None
    # when source_conversation_id is None, or when that conversation has
    # since been deleted - never fabricated, and the frontend just omits
    # the link in that case rather than showing a dead one.
    source_conversation_title: Optional[str] = None
    source_conversation_datasource_id: Optional[str] = None
    # 2026-09-29 (design revamp): "merge with other dashboards in the same
    # project" - every OTHER real (layout_version==2), currently viewable
    # dashboard built from this SAME source conversation, so the frontend
    # can offer "pull this dashboard's pages into mine" without a second
    # round-trip. Same DashboardBuilderSummaryOut shape as GET /by-
    # conversation/{conversation_id} below (this reuses that same query,
    # just scoped from the dashboard side rather than the conversation
    # side) - always empty when source_conversation_id is None, or when
    # this is the only dashboard built from that conversation so far.
    sibling_dashboards: list[DashboardBuilderSummaryOut] = []
    # 2026-09-24 (Phase 2, the canvas): which data source this dashboard's
    # blocks are built against - resolved server-side from
    # source_conversation_id (see routers/dashboard_builder.py
    # _resolve_datasource). The frontend uses this to know whether "Ask AI"/
    # "Build manually" are even available on this dashboard (both need a
    # real data source behind them) and to fetch the column list for the
    # manual-build form via the existing GET /datasources/{id}/preview
    # endpoint - no new backend endpoint needed just to list columns.
    datasource_id: Optional[str] = None
    datasource_name: Optional[str] = None
    pages: list[DashboardPageOut]
    can_edit: bool
    is_published: bool
    public_slug: Optional[str] = None
    # 2026-09-24 (Phase 3): the share row's own settings, always present
    # once a dashboard has ever been published at least once (None/false/
    # empty before that first publish). share_emails is only meaningful
    # when share_mode=="private"; it's harmless (just unused) otherwise.
    # Never includes password_hash itself - share_has_password is a plain
    # boolean so the editor UI can show "a password is set" without the
    # hash ever reaching the frontend.
    share_mode: Optional[str] = None
    share_has_password: bool = False
    share_emails: list[DashboardShareEmailOut] = []
    # 2026-09-24 (Phase 4, white-label): set once a custom domain has ever
    # been attached to this dashboard's share (None before that). status
    # is one of "pending_dns" / "pending_ssl" / "live" - see
    # models.DashboardShare's own docstring. error is the last message
    # from Render, if any, shown as-is in the publish panel.
    custom_domain: Optional[str] = None
    custom_domain_status: Optional[str] = None
    custom_domain_error: Optional[str] = None
    # 2026-09-25 (Round 4, branding/customization): this dashboard's own
    # look - see models.Dashboard's own docstring for exactly what each
    # field means and update_branding/upload_logo/upload_background in
    # routers/dashboard_builder.py for how they're set. has_logo/
    # has_background_image are plain booleans (never the raw bytes, which
    # would bloat every single dashboard fetch) so the frontend knows
    # whether to fetch the actual image at all, avoiding a broken-<img>
    # flash while it decides.
    brand_primary_color: Optional[str] = None
    brand_accent_color: Optional[str] = None
    background_style: Optional[str] = None
    background_color: Optional[str] = None
    has_logo: bool = False
    has_background_image: bool = False


class PublishDashboardRequest(BaseModel):
    # "public" (anyone with the link) or "private" (2026-09-24, Phase 3 -
    # named emails + optional password - see routers/dashboard_builder.py's
    # own module docstring). Validated server-side rather than with a
    # Literal type, so an unrecognized mode fails with a clear, friendly
    # 400 instead of a generic 422 validation error.
    mode: str = "public"
    # Only read when mode=="private". None/omitted = no password (the
    # email allow-list alone is the gate); a non-empty string sets/replaces
    # the current password. There is no separate "leave password
    # unchanged" option - every publish call fully states the password
    # this dashboard should use going forward, so there's never ambiguity
    # about whether an omitted field means "keep the old one" or "clear
    # it." Ignored entirely when mode=="public".
    password: Optional[str] = None


class CreatePageRequest(BaseModel):
    name: str = Field(default="", max_length=80)


class UpdatePageRequest(BaseModel):
    # Both optional - a rename sends just `name`, a reorder (drag a page
    # tab to a new spot) sends just `position`; either or both can be sent
    # in one call. At least one must actually be set, enforced in the
    # endpoint so the error message can be specific.
    name: Optional[str] = Field(default=None, max_length=80)
    position: Optional[int] = None
    # 2026-09-25 (Round 4, branding): this page's own background tint - a
    # hex string to set it, or "" (empty string) to clear it back to
    # "inherit the dashboard's background", the same "empty clears it"
    # convention this codebase already uses elsewhere (e.g. a block's
    # title). None/omitted leaves it unchanged, same as name/position.
    background_color: Optional[str] = None


class AddShareEmailRequest(BaseModel):
    email: EmailStr


class VerifyPrivateAccessRequest(BaseModel):
    email: EmailStr
    password: Optional[str] = None


class VerifyPrivateAccessOut(BaseModel):
    access_token: str


class PublicDashboardOut(BaseModel):
    name: str
    pages: list[DashboardPageOut]
    # 2026-09-25 (Round 4, branding): same fields/meaning as
    # DashboardBuilderOut above, mirrored here so the anonymous public/
    # private viewer renders with the owner's branding too - deliberately
    # never the dashboard's own id (see this class's own module-level
    # reasoning elsewhere in the codebase: PublicDashboardOut never exposes
    # it to an anonymous caller).
    brand_primary_color: Optional[str] = None
    brand_accent_color: Optional[str] = None
    background_style: Optional[str] = None
    background_color: Optional[str] = None
    has_logo: bool = False
    has_background_image: bool = False


class SetCustomDomainRequest(BaseModel):
    domain: str = Field(min_length=1, max_length=255)


class UpdateBrandingRequest(BaseModel):
    # 2026-09-25 (Round 4): every field optional and independently
    # settable - a call can change just the color, just the style, or all
    # of them at once. Each is normalized/validated server-side
    # (_hex_color_or_none / the background_style whitelist) rather than
    # with a strict Pydantic type, so a bad value degrades to "leave it
    # cleared" instead of failing the whole request with a generic 422 -
    # same reasoning as PublishDashboardRequest.mode above. Sending ""
    # (empty string) for a color clears it back to the app's default;
    # omitting/None leaves that field unchanged.
    brand_primary_color: Optional[str] = None
    brand_accent_color: Optional[str] = None
    background_style: Optional[str] = None
    background_color: Optional[str] = None


# ---------- Dashboard Builder Phase 2 (2026-09-24): the real canvas editor
# - add/move/resize/delete a block, fill one in with AI or a manual
# aggregation, restyle a chart's type. See routers/dashboard_builder.py for
# what each does; every one of these still only ever operates on a
# layout_version==2 dashboard the caller can edit. ----------
class CreateBlockRequest(BaseModel):
    page_id: str = Field(min_length=1)
    # 2026-09-25 (Round 15): "heading" | "divider" added - two pure-layout
    # element-library widgets alongside the original data block types.
    type: str = Field(min_length=1)  # "chart" | "table" | "kpi" | "text" | "filter" | "gauge" | "donut" | "sparkline" | "avatar_list" | "heading" | "divider"
    title: Optional[str] = None
    # 2026-09-25 (Round 15, element library): optional - set together when
    # the canvas drags a card from the element library and drops it at a
    # specific grid cell, so it lands exactly where it was dropped instead
    # of always appending at the bottom. See routers/dashboard_builder.py's
    # create_block for why size is still never taken from here.
    x: Optional[int] = None
    y: Optional[int] = None


class UpdateBlockRequest(BaseModel):
    # Every field optional - this is a partial update (drag persists x/y,
    # resize persists w/h, a title edit persists just title, and so on).
    # At least one field must actually be set or there is nothing to do -
    # enforced in the endpoint itself, not here, so the error message can
    # be specific.
    x: Optional[int] = None
    y: Optional[int] = None
    w: Optional[int] = None
    h: Optional[int] = None
    title: Optional[str] = None
    config: Optional[dict] = None


class AskAiBlockRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=2000)


class FilterCriterion(BaseModel):
    """One active cross-filter selection - either on the page-wide filter
    bar or (2026-09-29, "Hex-level filters" round) scoped to just ONE
    block ("per-chart filtering" - see ApplyFiltersRequest.block_filters
    below). `spec` reuses the EXACT SAME operator vocabulary as the Data
    tab's own Excel-style column filter panel - routers/datasources.py's
    _apply_column_filter / frontend DataTable.tsx's ColumnFilterSpec -
    rather than inventing a second, narrower one just for dashboards:
    multi-select ("values"), text contains/equals/starts_with/ends_with/
    is_empty/etc, a numeric comparison OR RANGE ("between"), a date range,
    or a boolean toggle. This is what actually adds ranges and multi-select
    to dashboard filtering - the original version of this class only ever
    supported a single scalar "equals" value.

    Kept as a permissive dict (not a discriminated Pydantic union) for the
    same reason _apply_column_filter's own docstring already accepts that
    tradeoff on the Data tab side: a new operator added to that one shared
    vocabulary later works here immediately, with zero schema change and
    zero risk of the two vocabularies drifting apart from each other.

    See routers/dashboard_builder.py's module docstring (Phase 2b, and the
    2026-09-29 "Hex-level filters" round) for why none of this is ever
    persisted anywhere except a filter block's own target `column` - a
    viewer's actual filter selections (page-wide or per-chart) live only
    in the frontend's own React state and are sent fresh on every
    preview-filtered call."""
    column: str = Field(min_length=1)
    spec: dict


class ManualBuildBlockRequest(BaseModel):
    metric_column: str = Field(min_length=1)
    agg: str = "sum"  # "sum" | "avg" | "count" | "min" | "max"
    group_by_column: Optional[str] = None
    block_type: str = "table"  # "kpi" | "table" | "chart" | "gauge" | "donut" | "sparkline" | "avatar_list"
    chart_type: Optional[str] = None  # only read when block_type == "chart"
    # 2026-09-24 (Phase 2b): whichever filters the person building this
    # block currently has active on the page, so a brand-new block built
    # while a filter is active is correctly filtered from the moment it's
    # created, not just on the next filter change.
    filters: list[FilterCriterion] = Field(default_factory=list, max_length=8)
    # 2026-09-25 (Round 3): only read when block_type == "gauge" - both
    # optional, see _run_manual_recipe for the sensible defaults filled in
    # when either (or both) is left unset.
    target_value: Optional[float] = None
    max_value: Optional[float] = None


class RestyleBlockRequest(BaseModel):
    chart_type: str = Field(min_length=1)
    title: Optional[str] = None


# 2026-09-25h (inline editing round): pure presentation, never a data
# change - see routers/dashboard_builder.py's set_block_accent_color for
# why this is its own small endpoint rather than routed through the
# generic update_block (which replaces a block's whole `config`, and would
# silently wipe out a kpi's real value/label). color is a hex string like
# "#1a7a5c", or None/"" to reset back to the automatic per-block color.
class SetBlockAccentColorRequest(BaseModel):
    color: Optional[str] = None


# 2026-09-28: the "Show forecast" / "Show anomalies" chart-block toggles -
# see routers/dashboard_builder.py's set_block_analysis for why this is its
# own endpoint (an analysis LENS applied to an already-built chart_spec,
# not a data recompute) rather than routed through the generic update_block.
# Both flags are sent together every time, even though only one may have
# changed - the endpoint (and chart_builder.apply_analysis_overlays) always
# needs to know the full, current state of both toggles to rebuild the
# figure correctly.
class SetBlockAnalysisRequest(BaseModel):
    forecast_enabled: bool
    anomalies_enabled: bool


# ---------- Cross-filtering (2026-09-24, Phase 2b) ----------
class ApplyFiltersRequest(BaseModel):
    filters: list[FilterCriterion] = Field(default_factory=list, max_length=8)
    # 2026-09-29 (Hex-level filters round): "per-chart filtering" - extra
    # criteria scoped to just ONE block, layered on top of `filters` above
    # for that block only, never affecting any other block on the page.
    # Keyed by block id. Exactly as ephemeral as `filters` itself - see
    # FilterCriterion's own docstring - a viewer sets these live in the
    # editor/preview UI and they're gone on the next page load, never
    # written to the dashboard's stored config. A dict's per-key list
    # length isn't expressible as a Field constraint, so both the per-block
    # criteria count and the number of blocks are capped in the endpoint
    # itself (preview_filtered_blocks) rather than here - a real dashboard
    # page has nowhere near enough blocks or per-block filters to hit
    # either cap, so this is purely an abuse guard.
    block_filters: dict[str, list[FilterCriterion]] = Field(default_factory=dict)


class FilteredBlockOut(BaseModel):
    id: str
    type: str
    config: dict


class FilteredBlocksOut(BaseModel):
    # Only ever includes a block that actually has a stored `recipe` (see
    # build_manual_block) and successfully recomputed - see
    # preview_filtered_blocks' own docstring for why everything else is
    # simply left out rather than echoed back unchanged.
    blocks: list[FilteredBlockOut]
    # 2026-09-25e (elite pass, real filter-bar row count): the real number
    # of rows in the datasource that match `payload.filters` - literally
    # `len(df)` after preview_filtered_blocks applies those filters, no
    # separate query. This is what lets the frontend show an honest
    # "Showing 6,709 rows" next to the filter row (the reference dashboard
    # screenshots Gokul sent) instead of a fabricated number - see this
    # engagement's standing rule against ever inventing stats. 0 whenever
    # the datasource couldn't be loaded at all (frontend treats 0 as "no
    # count to show", same as any other empty state).
    matched_rows: int = 0


# ---------- Folders (2026-09-23, folders round: organizes Projects on the
# home page - see models.Folder and routers/folders.py) ----------
class FolderCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    workspace_id: str


class FolderRenameRequest(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class FolderOut(BaseModel):
    id: str
    name: str
    workspace_id: str
    created_at: datetime
    # How many Projects are filed into this folder right now - lets the
    # frontend show a count without a second request per folder.
    project_count: int
    can_edit: bool


class BulkMoveConversationsRequest(BaseModel):
    conversation_ids: list[str] = Field(min_length=1, max_length=200)
    # The folder to move every listed Project into - None files them back
    # to "no folder" (the Projects page's default, unfiled view).
    folder_id: Optional[str] = None


# ---------- Scheduled auto-refresh + background jobs (2026-09-28) ----------
# See services/scheduler.py's own module docstring for the full design:
# per-DASHBOARD refresh intervals (not per-block - see models.Dashboard's
# own docstring for why), executed by reusing the exact same
# ask_ai_block/build_manual_block recompute logic the manual, on-demand
# block editor already uses - never a second implementation of it.
REFRESH_INTERVALS = ("off", "15m", "1h", "6h", "daily")


class DashboardScheduleOut(BaseModel):
    """One row of the Jobs page's own schedule table - one per
    layout_version==2 dashboard this person can at least view, its current
    refresh setting, and its most recent run (if it has ever run at all)."""
    dashboard_id: str
    dashboard_name: str
    source_label: Optional[str] = None
    refresh_interval: str = "off"  # "off" | "15m" | "1h" | "6h" | "daily"
    next_refresh_at: Optional[datetime] = None
    last_refreshed_at: Optional[datetime] = None
    # The most recent JobRun for this dashboard, if any - lets the Jobs
    # page's table show a live status pill/duration per dashboard without a
    # second request per row.
    last_run_status: Optional[str] = None
    last_run_duration_seconds: Optional[float] = None
    last_run_error: Optional[str] = None
    # Whether the CALLER (not just anyone) can change this schedule or hit
    # "Run now" - a workspace "viewer" can see this row but not act on it,
    # same "editable" tier every other write action on a shared dashboard
    # already checks (see routers/dashboards.py).
    can_edit: bool


class UpdateDashboardScheduleRequest(BaseModel):
    refresh_interval: str = Field(min_length=1)  # must be one of REFRESH_INTERVALS


class JobRunOut(BaseModel):
    id: str
    dashboard_id: Optional[str] = None
    job_type: str  # "scheduled_refresh" | "manual_refresh"
    target_label: str
    source_label: Optional[str] = None
    status: str  # "running" | "success" | "failed"
    error_message: Optional[str] = None
    started_at: datetime
    finished_at: Optional[datetime] = None
    duration_seconds: Optional[float] = None
    next_run_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class JobRunsPage(BaseModel):
    runs: list[JobRunOut]
    total: int
    page: int
    page_size: int


# ---------- Streaming (webhook) ingestion (2026-09-28) ----------
# The honest, achievable version of "real-time ingestion" for a small SaaS
# product - a per-source secret webhook URL an external system (Zapier, a
# script, another app) posts JSON rows to - not a Kafka/message-broker
# integration this app has no infrastructure to run. See
# routers/datasources.py's connect_streaming/ingest_webhook_event and
# models.StreamedEvent for the full design.
class DataSourceCreateStreaming(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class StreamingDataSourceOut(DataSourceOut):
    """Returned ONLY right after creation (or right after a deliberate
    regenerate) - never again afterwards, the same "never returned to the
    client after creation" rule every other credential in this app already
    follows (see this file's own module note on DataSourceCreateDB/
    DataSourceCreateWarehouse). The frontend shows this once, in a
    "copy this somewhere safe" panel, exactly like a workspace's invite
    link/token."""
    webhook_url: str
    webhook_secret: str


class StreamedEventIngestResult(BaseModel):
    accepted: int
    received_at: datetime


# ---------- Phase 2, feature 2: persistent Flow-tab annotations ----------
# A partial update to one FlowAnnotation - see models.FlowAnnotation's own
# docstring and routers/datasources.py upsert_flow_annotation. Every field
# is optional so a caller can send just the one thing that changed (a
# rename, or a drag, never both at once in this app's own edit UI) without
# resending everything else; at least one must actually be set, enforced in
# the endpoint itself so the error message can be specific.
class FlowAnnotationUpdate(BaseModel):
    display_label: Optional[str] = Field(default=None, max_length=120)
    description: Optional[str] = Field(default=None, max_length=2000)
    position_x: Optional[float] = None
    position_y: Optional[float] = None


class FlowAnnotationOut(BaseModel):
    node_key: str
    display_label: Optional[str] = None
    description: Optional[str] = None
    position_x: Optional[float] = None
    position_y: Optional[float] = None
    updated_at: datetime

    class Config:
        from_attributes = True


# ---------- Phase 2, feature 4: generic API/webhook PULL connector ----------
# A read-only REST connector - GET only, always (see
# services/connectors.ApiConnector and routers/datasources.py connect_api
# for exactly why method is never a field here). auth_header_name/
# auth_header_value are both optional and independent: a public API needs
# neither; a bearer-token API sets auth_header_name="Authorization" and
# auth_header_value="Bearer <token>". json_path is only needed when the
# array of records is nested inside the response body rather than being
# the whole body itself (e.g. "data.items") - see ApiConnector._extract_array.
class DataSourceCreateApi(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    url: str = Field(min_length=1, max_length=2000)
    auth_header_name: Optional[str] = Field(default=None, max_length=200)
    auth_header_value: Optional[str] = Field(default=None, max_length=4000)
    json_path: Optional[str] = Field(default=None, max_length=300)


# ---------- Phase 4: Experimentation / A/B testing (2026-09-28) ----------
# See models.Experiment / models.ExperimentAssignment's own docstrings for
# the full data-model design, and routers/experiments.py's own module
# docstring for the public assign/convert security model these last three
# schemas serve.
class CreateExperimentRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    metric_name: str = Field(min_length=1, max_length=200)
    variant_a_name: str = Field(default="Control", max_length=80)
    variant_b_name: str = Field(default="Treatment", max_length=80)


class SetExperimentStatusRequest(BaseModel):
    # The only transition this phase's wizard/UI ever exposes is
    # running -> stopped - there is no "resume a stopped experiment"
    # feature (see models.Experiment's own docstring). Literal["stopped"]
    # means any other value fails request validation before it ever
    # reaches the endpoint, the same effect as the router explicitly
    # rejecting it.
    status: Literal["stopped"]


class ExperimentVariantStats(BaseModel):
    variant_name: str
    assigned_count: int
    converted_count: int
    # None when assigned_count is 0 - a conversion rate is genuinely
    # undefined with zero visitors assigned yet, never a fabricated 0.0
    # (see services/experiments_stats.compute_experiment_stats).
    conversion_rate: Optional[float] = None


class ExperimentStatsOut(BaseModel):
    variant_a: ExperimentVariantStats
    variant_b: ExperimentVariantStats
    p_value: Optional[float] = None
    is_significant: bool
    insufficient_data: bool


class ExperimentOut(BaseModel):
    id: str
    name: str
    metric_name: str
    variant_a_name: str
    variant_b_name: str
    status: str  # "running" | "stopped"
    public_key: str
    # Ready-to-paste URLs for the founder's own external website's
    # client-side assign/convert calls - see routers/experiments.py's
    # _assign_url/_convert_url, built the same way connect_streaming's own
    # webhook_url already is.
    assign_url: str
    convert_url: str
    created_at: datetime
    started_at: datetime
    stopped_at: Optional[datetime] = None
    stats: ExperimentStatsOut
    can_edit: bool


class PublicAssignOut(BaseModel):
    variant: str  # "a" | "b"
    variant_name: str


class PublicConvertRequest(BaseModel):
    subject_id: str = Field(min_length=1, max_length=200)


# ---------- Phase 5, Batch A (2026-09-28, data governance & quality) ----------
class CreateQualityRuleRequest(BaseModel):
    column_name: str = Field(min_length=1, max_length=200)
    rule_type: Literal["not_null", "unique", "min_value", "max_value", "allowed_values"]
    # Shape depends on rule_type - {} for not_null/unique, {"min": <number>}
    # for min_value, {"max": <number>} for max_value, {"values": [...]} for
    # allowed_values. Left loosely typed (a plain dict) same as
    # DashboardBlock.config/SavedView.config elsewhere in this file - the
    # backend (services/quality_checks.run_quality_rule) is the one place
    # that ever reads inside it.
    rule_config: dict = Field(default_factory=dict)


class QualityRuleOut(BaseModel):
    id: str
    datasource_id: str
    column_name: str
    rule_type: str
    rule_config: dict
    created_at: datetime
    last_run_at: Optional[datetime] = None
    last_status: Optional[str] = None  # "pass" | "fail" | "error" | None
    last_checked_row_count: Optional[int] = None
    last_failing_row_count: Optional[int] = None
    last_message: Optional[str] = None
    # Who created this rule - resolved server-side so the panel can show
    # "Added by <name>" without a second round trip, same convention
    # SavedViewOut.created_by_* already follows.
    created_by_name: Optional[str] = None
    created_by_email: Optional[str] = None


class QualityStatusOut(BaseModel):
    # Computed purely from each rule's own stored last_status - never
    # triggers a live re-run (see routers/quality_checks.py
    # get_quality_status's own docstring). This is what a dashboard polls
    # per data source to decide whether to show its "quality checks are
    # failing" banner, so it has to stay cheap and fast.
    has_failing_rules: bool
    failing_count: int


class MarkReviewedOut(BaseModel):
    datasource_id: str
    governance_last_reviewed_at: datetime
    governance_last_reviewed_by_id: str
    governance_last_reviewed_by_name: Optional[str] = None
    governance_last_reviewed_by_email: Optional[str] = None


class CreateAccessRuleRequest(BaseModel):
    role: Literal["member", "viewer"]
    kind: Literal["row", "column"]
    column_name: str = Field(min_length=1, max_length=200)
    # Required (non-empty) when kind == "row" - the router validates this,
    # since it depends on `kind`. None/omitted for a "column" rule, which
    # doesn't use it at all.
    allowed_values: Optional[list] = None


class AccessRuleOut(BaseModel):
    id: str
    datasource_id: str
    role: str
    kind: str
    column_name: str
    allowed_values: Optional[list] = None
    created_at: datetime
    created_by_id: str
    # Who created this rule - resolved server-side, same convention
    # QualityRuleOut.created_by_name already follows.
    created_by_name: Optional[str] = None


class AuditEventOut(BaseModel):
    id: str
    workspace_id: Optional[str] = None
    action: str
    target_type: Optional[str] = None
    target_id: Optional[str] = None
    event_metadata: Optional[dict] = None
    created_at: datetime
    # The actor's display name/email joined in server-side - never a raw
    # user id the frontend can't render on its own (see the Batch A spec's
    # own note on this).
    actor_name: Optional[str] = None
    actor_email: Optional[str] = None


class AuditLogPageOut(BaseModel):
    events: list[AuditEventOut]
    total: int
    page: int
    page_size: int


class GovernanceMemberAccessOut(BaseModel):
    user_id: str
    name: Optional[str] = None
    email: str
    role: str  # "owner" | "member" | "viewer"


class GovernanceDataSourceOut(BaseModel):
    id: str
    name: str
    kind: str
    member_access: list[GovernanceMemberAccessOut]
    governance_last_reviewed_at: Optional[datetime] = None
    governance_last_reviewed_by: Optional[str] = None  # display name/email, or None if never reviewed


class GovernanceOverviewOut(BaseModel):
    datasources: list[GovernanceDataSourceOut]


# ---------- 2026-09-28 (ML Models round) ----------
# See models.MLModel/MLPrediction's own docstrings for the full design and
# services/ml_training.py for how training/prediction/scoring actually
# work. Always called "ML Model"/"ML Models" in every field and endpoint
# name here - never just "Model(s)" - to keep this permanently distinct
# from Saved Tables (routers/datasources.py's version listing), which are
# reusable data TABLES and have nothing to do with machine learning.
class TrainMLModelRequest(BaseModel):
    datasource_id: str
    target_column: str = Field(min_length=1, max_length=200)
    # None (the default, and what this phase's own wizard sends in its
    # zero-configuration path) means "let the backend pick every usable
    # column automatically" - see services/ml_training.select_features.
    # When given, only these are ever considered, and each one still goes
    # through the exact same exclusion logic (see that function's own
    # docstring) - an explicitly requested column can still legitimately
    # end up in excluded_columns.
    feature_columns: Optional[list[str]] = None
    name: str = Field(min_length=1, max_length=120)
    description: Optional[str] = Field(default=None, max_length=2000)


class MLExcludedColumn(BaseModel):
    column: str
    reason: str


# ---------- 2026-09-30 (model trustworthiness round) ----------
# See models.MLModel.feature_importance/MLModelVersion/MLPrediction.
# explanation's own docstrings for the full design; services/
# ml_training._extract_feature_importance and .explain_prediction for how
# each one is actually computed. Both are real numbers read straight off
# the trained scikit-learn estimator - never fabricated, never a fixed
# placeholder list.
class FeatureImportanceEntry(BaseModel):
    feature: str
    # Normalized to sum to 1.0 across a model's own feature_importance
    # list - see services/ml_training._extract_feature_importance.
    importance: float


class PredictionExplanationEntry(BaseModel):
    feature: str
    # This prediction's own real (coerced) input value for this feature -
    # exactly what services/ml_training._coerce_form_value produced for it.
    value: Any
    # coefficient x this prediction's own value, real and signed - a
    # positive number pushed the prediction up, negative pushed it down.
    # See services/ml_training._explain_prediction's own docstring.
    contribution: float


class MLModelVersionOut(BaseModel):
    id: str
    version_number: int
    is_current: bool
    created_reason: str  # "trained" | "promoted" - see models.MLModelVersion's own docstring
    algorithm: Optional[str] = None
    metrics: Optional[dict] = None
    feature_importance: Optional[list[FeatureImportanceEntry]] = None
    trained_row_count: Optional[int] = None
    created_at: datetime


class MLModelOut(BaseModel):
    id: str
    datasource_id: str
    datasource_name: str
    name: str
    description: Optional[str] = None
    task_type: Optional[str] = None  # "classification" | "regression" | None (not trained yet)
    target_column: str
    feature_columns: Optional[list[str]] = None
    excluded_columns: Optional[list[MLExcludedColumn]] = None
    algorithm: Optional[str] = None
    # Keys depend on task_type - see services/ml_training.py's own module
    # docstring for exactly which. Always real, computed numbers - never
    # fabricated (see this app's own "never fabricate a stat" discipline).
    metrics: Optional[dict] = None
    # Real, global feature importance for the currently-active version -
    # see models.MLModel.feature_importance's own docstring. None for a
    # model trained before this round, or one still training/failed.
    feature_importance: Optional[list[FeatureImportanceEntry]] = None
    status: str  # "training" | "ready" | "failed"
    error_message: Optional[str] = None
    trained_row_count: Optional[int] = None
    created_at: datetime
    trained_at: Optional[datetime] = None
    prediction_count: int
    last_predicted_at: Optional[datetime] = None
    # Which MLModelVersion.version_number is currently active - see
    # models.MLModel.version_number's own docstring.
    version_number: int
    # Whoever trained this model, resolved server-side (same convention as
    # QualityRuleOut.created_by_name) - also what the frontend uses to
    # decide whether to show the delete button at all (creator-only).
    owner_id: str
    can_delete: bool


class PredictRequest(BaseModel):
    # Column name -> raw value typed into the "Try it" form - loosely typed
    # (a plain dict), same convention as DataQualityRule.rule_config/
    # DashboardBlock.config elsewhere in this file; services/ml_training.py
    # is the one place that ever reads inside it.
    input_values: dict


class PredictOut(BaseModel):
    predicted_value: Any
    # None for a regression model, or a classification model whose winning
    # algorithm doesn't expose predict_proba - never a fabricated number.
    confidence: Optional[float] = None
    # Real per-feature contribution breakdown for THIS prediction - only
    # ever set for a linear/logistic winning algorithm. See
    # models.MLPrediction.explanation's own docstring for why a random
    # forest's prediction leaves this None rather than an approximation.
    explanation: Optional[list[PredictionExplanationEntry]] = None


class ScoreTableRequest(BaseModel):
    # Which table/sheet of the SAME datasource to score - None scores the
    # datasource's own original data, matching datasourceApi.preview's own
    # "no table means the default one" convention on the frontend.
    table: Optional[str] = None


class ScoreTableOut(BaseModel):
    new_version_id: str
    new_version_name: str
    row_count: int
