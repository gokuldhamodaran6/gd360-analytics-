"""
Pydantic request/response schemas.
"""
from datetime import datetime
from typing import Optional, Any

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
    goal: Optional[str] = Field(default=None, max_length=500)


# 2026-09-25 (Round 2, "build own"): a blank v2 dashboard tied to a
# conversation's data source but with zero blocks - the person adds and
# fills every block themselves via the existing Phase 2 canvas. See
# routers/dashboard_builder.py's create_blank_dashboard.
class CreateBlankDashboardRequest(BaseModel):
    conversation_id: str = Field(min_length=1)


# 2026-09-25 (Round 2): renaming a v2 dashboard's own name - see
# routers/dashboard_builder.py's update_dashboard.
class UpdateDashboardRequest(BaseModel):
    name: Optional[str] = Field(default=None, max_length=120)


class DashboardBlockOut(BaseModel):
    id: str
    # 2026-09-25 (Round 3): added "gauge" | "donut" | "sparkline" |
    # "avatar_list" - four native widget types, config shapes documented
    # in routers/dashboard_builder.py's own module docstring.
    type: str  # "chart" | "table" | "kpi" | "text" | "filter" | "gauge" | "donut" | "sparkline" | "avatar_list"
    title: Optional[str] = None
    x: int
    y: int
    w: int
    h: int
    config: dict
    position: int


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


class DashboardBuilderOut(BaseModel):
    id: str
    name: str
    layout_version: int
    created_at: datetime
    source_conversation_id: Optional[str] = None
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
    type: str = Field(min_length=1)  # "chart" | "table" | "kpi" | "text" | "filter" | "gauge" | "donut" | "sparkline" | "avatar_list"
    title: Optional[str] = None


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
    """One active cross-filter selection - (which column, which value).
    See routers/dashboard_builder.py's module docstring (Phase 2b) for why
    these are never persisted anywhere: a viewer's current filter
    selections live only in the frontend's own React state and get sent
    fresh on every preview-filtered call."""
    column: str = Field(min_length=1)
    value: str | int | float | bool


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


# ---------- Cross-filtering (2026-09-24, Phase 2b) ----------
class ApplyFiltersRequest(BaseModel):
    filters: list[FilterCriterion] = Field(default_factory=list, max_length=8)


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
