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
    # 2026-10-10 (round 19): 2-step sign-in. mfa_setup_required is set on
    # /auth/me when a workspace this person belongs to requires 2-step and
    # they haven't turned it on yet.
    mfa_enabled: bool = False
    mfa_setup_required: bool = False
    email_verified: bool = False

    class Config:
        from_attributes = True


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut
    # 2026-10-10 (round 19): when the account has 2-step sign-in on, /login
    # returns access_token "" with mfa_required true and an mfa_token for
    # POST /auth/login/mfa.
    mfa_required: bool = False
    mfa_token: Optional[str] = None


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
    # 2026-10-07 (identity-colour round): the workspace brand kit (None =
    # none set) - see WorkspaceBrandKitOut. Carried on the list so every
    # page that knows the active workspace also knows its palette.
    brand_kit: Optional[dict] = None


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


# 2026-10-07 (identity-colour round): the workspace brand kit - see
# models.Workspace.brand_kit and services/appearance.normalize_kit.
class WorkspaceBrandKitOut(BaseModel):
    workspace_id: str
    workspace_name: str
    # None = the workspace has no kit (dashboards use the product defaults).
    brand_kit: Optional[dict] = None
    # Only the workspace owner may change it.
    can_edit: bool = False


class WorkspaceBrandKitUpdate(BaseModel):
    # The kit to store: any of the style fields of a dashboard appearance
    # (palette, color_mode, single_color, theme_default, density, radius,
    # font, currency, locale, footer_note) plus brand_primary_color /
    # brand_accent_color. Stored as sent (validated); null clears the kit.
    brand_kit: Optional[dict] = None


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
    # 2026-09-30 (data catalog v1): see models.DataSource.description's
    # own comment - a short, optional, human-written blurb, never
    # computed or inferred.
    description: Optional[str] = None
    # 2026-10-07 (identity-colour round): the workspace this source lives
    # in - the chat workspace and the prompt builder read that workspace's
    # brand kit (palette, number settings) for the charts they draw.
    workspace_id: Optional[str] = None
    # 2026-10-08 (round 11): synced app sources (Shopify, GA4, Meta Ads,
    # Google Ads) - when their records were last copied, when they are due
    # again and, when the last sync failed, why. None for every other kind.
    last_synced_at: Optional[datetime] = None
    next_sync_at: Optional[datetime] = None
    sync_error: Optional[str] = None

    class Config:
        from_attributes = True


class UpdateDataSourceDescriptionRequest(BaseModel):
    description: Optional[str] = Field(default=None, max_length=2000)


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
    # 2026-10-06 (pushdown-honesty round): did this turn run a real query
    # directly against the warehouse/database, or fall back to analyzing a
    # loaded, row-capped in-memory sample - see models.Message.
    # used_pushdown/sample_row_count's own docstring for the full
    # reasoning. used_pushdown is None for a kind pushdown is never
    # attempted for (a file upload) - never a misleading False implying a
    # fallback that was never even possible. sample_row_count is set only
    # when used_pushdown is False AND this kind is pushdown-eligible - a
    # real, already-loaded row count, never a fabricated or re-queried one.
    used_pushdown: Optional[bool] = None
    sample_row_count: Optional[int] = None

    # ---- 2026-10-06 (warehouse-honesty round) -------------------------
    # For a warehouse/database data source (routers/chat.py
    # PUSHDOWN_ELIGIBLE_KINDS), a question is now answered ONLY by a real
    # query that ran inside the warehouse over every row. The app never
    # pulls a row-capped sample and analyzes that - so for those kinds
    # `used_pushdown` is True (answer computed in the warehouse) or the
    # turn is an `action="needs_query_help"` turn (below) with
    # used_pushdown=False and nothing computed. `sample_row_count` is
    # therefore always None for a warehouse kind now; it only ever applied
    # to the sample path those kinds no longer take.
    #
    # Set on a SUCCESSFUL warehouse turn (used_pushdown=True):
    #   pushdown_sql           - the exact SQL (or, for MongoDB, the JSON
    #                            {"collection", "pipeline"}) that produced
    #                            the result. Also set when the person's own
    #                            query_builder/raw_sql request ran.
    #   pushdown_provider      - the data source kind it ran in
    #                            ("bigquery", "snowflake", "postgres", ...).
    #   pushdown_bytes_scanned - real bytes scanned (BigQuery: the dry-run
    #                            estimate the query was admitted on;
    #                            Snowflake: its own post-hoc figure). None
    #                            for kinds with no metered cost.
    #   pushdown_duration_ms   - wall-clock ms for generate+execute.
    #   pushdown_result_rows   - rows in the (already-aggregated) result.
    #   exact_total_rows       - the real COUNT(*) of the one table the
    #                            query was scoped to, IF the Data tab's
    #                            profile already computed and cached it
    #                            (never a fresh count). None otherwise.
    pushdown_sql: Optional[str] = None
    pushdown_provider: Optional[str] = None
    pushdown_bytes_scanned: Optional[int] = None
    pushdown_duration_ms: Optional[int] = None
    pushdown_result_rows: Optional[int] = None
    exact_total_rows: Optional[int] = None
    # Set on an action="needs_query_help" turn - the warehouse query could
    # not be produced, NOTHING was computed (no chart, no insight,
    # ok=True, needs_clarification=False), and reply_text is a short plain
    # explanation. The frontend uses these to let the person finish it:
    #   pushdown_attempts      - list of {"sql": str, "status": str,
    #                            "error": str|None}; status is one of
    #                            "ok" | "rejected_unsafe" |
    #                            "rejected_too_expensive" | "error" |
    #                            "not_possible" | "needs_table" |
    #                            "generation_failed". May be empty when
    #                            pushdown_skipped_reason is set.
    #   pushdown_skipped_reason - why no (or no further) attempt was made:
    #                            "daily_budget" | "empty_schema" |
    #                            "restricted_role" |
    #                            "unsupported_selection" | "needs_table"
    #                            | "not_possible" | "table_failed" | None.
    #                            "needs_table" is MongoDB-only now; for a
    #                            SQL warehouse a row-level request creates
    #                            a saved-query table instead (2026-10-06,
    #                            "generated data is a saved query" layer):
    #                            the turn is action="transform" with
    #                            new_version_id/new_version_name,
    #                            used_pushdown=True, pushdown_sql = the
    #                            table's standalone definition,
    #                            pushdown_result_rows = its exact row
    #                            count (null if the COUNT(*) failed),
    #                            rows_before/rows_after when known, and
    #                            pushdown_attempts = the definition
    #                            attempts. "table_failed" is the honest
    #                            failure of that path: needs_query_help
    #                            with the attempts, builder_suggestion
    #                            always None.
    #   builder_suggestion     - a best-guess QueryBuilderSpec-shaped dict
    #                            (see schemas_extra.QueryBuilderSpec),
    #                            already validated against the data
    #                            source's schema, to prefill the builder.
    #                            None when no safe guess was possible, and
    #                            always None for MongoDB (builder is SQL-
    #                            only) and for a restricted role.
    #   builder_columns        - {table: [{"name", "type"}]} for the
    #                            tables in scope, straight from the data
    #                            source's own schema, so the builder's
    #                            selects need no second request.
    pushdown_attempts: Optional[list] = None
    pushdown_skipped_reason: Optional[str] = None
    builder_suggestion: Optional[dict] = None
    builder_columns: Optional[dict] = None
    # 2026-10-07 (chart-integrity round, "say what was filtered"): the row
    # filters behind this answer - see models.Message.query_filters for the
    # shape. None when there is nothing to report (a file answer) or
    # nothing is known. `chart_type` may now also be "table": the result
    # could not be drawn as the requested chart without misrepresenting
    # it, chart_spec is None, and reply_text ends with the plain sentence
    # that says why - the frontend shows result_rows as a table.
    query_filters: Optional[dict] = None


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


class DatasetVersionOut(BaseModel):
    """One entry of GET /datasources/{id}/versions. The first six fields
    are what the list has always returned; the rest were added 2026-10-06
    ("generated data is a saved query" layer) so the Data tab can render
    a warehouse saved-query table without ever loading it - see
    models.DatasetVersion.source_kind and friends. For a plain file-backed
    version source_kind is "file" and every query field is null."""
    id: str
    name: str
    parent_version_id: Optional[str] = None
    step_count: int = 0
    created_at: Optional[datetime] = None
    conversation_id: Optional[str] = None
    # "file" | "warehouse_query"
    source_kind: str = "file"
    query_sql: Optional[str] = None
    sql_alias: Optional[str] = None
    source_table: Optional[str] = None
    row_count: Optional[int] = None
    # [{"name", "type"}] - the query's result schema captured at creation.
    columns_json: Optional[list] = None
    parent_version_ids: Optional[list] = None


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
    # 2026-10-10 (one kind of dashboard): where it was made from - "answer"
    # (a Home question, /p/:id), "analysis" (a Studio chat) or None - with
    # that item's title and ids, for the "Made from ..." line on its card.
    source_kind: Optional[str] = None
    source_title: Optional[str] = None
    source_id: Optional[str] = None
    source_datasource_id: Optional[str] = None


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
    # 2026-10-10 (one kind of dashboard): a blank dashboard can start from
    # a chat (conversation_id) OR straight from a data source (datasource_id,
    # the Dashboards page's "Blank canvas") - one of the two is required.
    conversation_id: Optional[str] = None
    datasource_id: Optional[str] = None
    name: Optional[str] = Field(default=None, max_length=120)


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
    # 2026-10-06 (warehouse-native dashboards layer): the dashboard's
    # period grain and time column - see models.Dashboard.default_period/
    # date_column. "" clears either back to NULL; None/omitted leaves it.
    default_period: Optional[str] = Field(default=None, max_length=16)
    date_column: Optional[str] = Field(default=None, max_length=200)


class DashboardBlockOut(BaseModel):
    id: str
    # 2026-09-25 (Round 3): added "gauge" | "donut" | "sparkline" |
    # "avatar_list" - four native widget types, config shapes documented
    # in routers/dashboard_builder.py's own module docstring. 2026-09-25
    # (Round 15): added "heading" | "divider" - the element library's two
    # pure-layout widgets, no computed data.
    # 2026-10-07 (analyst canvas round): added "sql" | "input" - see
    # models.DashboardBlock's docstring and routers/dashboard_builder.py
    # ("Canvas cells") for their config shapes; a chart/kpi/table may also
    # carry config.source_block_id to render from a sql cell's result.
    type: str  # "chart" | "table" | "kpi" | "text" | "filter" | "gauge" | "donut" | "sparkline" | "avatar_list" | "heading" | "divider" | "sql" | "input"
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
    # 2026-10-06 (warehouse-native dashboards layer): see models.
    # DashboardBlock.query_sql/last_run. Both None for a block that has no
    # spec (a file-source block, or a warehouse block not yet upgraded).
    query_sql: Optional[str] = None
    last_run: Optional[dict] = None


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


# 2026-10-01 (chat-to-dashboard round): the picker behind "Add to
# dashboard" (PushToDashboardMenu.tsx) - every real (layout_version==2)
# dashboard this person can at least SEE, each with just enough to drive a
# dashboard-then-page picker: its own pages (id+name only, not their
# blocks - a page can have many blocks and this is listing dozens of
# dashboards at once, not opening one). Deliberately broader than
# DashboardBuilderSummaryOut (not scoped to one source conversation - this
# is "every dashboard I can reach", matching GET /dashboards' own v1
# listing query) and deliberately narrower than the full
# DashboardBuilderOut (no branding/sharing/blocks - this never needs to
# RENDER a dashboard, only to be chosen from a list). can_edit is included
# so the frontend can grey out a view-only dashboard the same way
# SaveChartMenu already does for v1 chart boards, rather than letting a
# push fail server-side with a 403 the person never saw coming.
class DashboardPickerPageOut(BaseModel):
    id: str
    name: str


class DashboardPickerOut(BaseModel):
    id: str
    name: str
    can_edit: bool
    datasource_name: Optional[str] = None
    # 2026-10-10: lets "Add to an existing dashboard" offer only the ones
    # built on the same data source.
    datasource_id: Optional[str] = None
    pages: list[DashboardPickerPageOut]


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
    # 2026-10-10: "answer" (a Home question, /p/:id) or "analysis" (a Studio
    # chat, /workspace/...) - what the dashboard's "Made from" chip opens.
    source_conversation_kind: Optional[str] = None
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
    # 2026-10-06 (warehouse-native dashboards layer) - see
    # WarehouseDashboardFields below.
    datasource_kind: Optional[str] = None
    warehouse_native: bool = False
    parameters: list[dict] = []
    saved_views: list[dict] = []
    default_period: Optional[str] = None
    date_column: Optional[str] = None
    # Every table the dashboard's blocks could be built from, with its
    # columns ({table: [{name, type}]}) - what the filter-rail/spec editors
    # need to populate selects. Empty for a file source.
    tables: dict[str, list[dict]] = {}
    # 2026-10-07 (comments round): {block_id: {"open": n, "total": n}} for
    # every block that has at least one comment thread, so the canvas can
    # show "2 replies" without a second request. Page-level threads are
    # keyed "page:<page_id>", dashboard-level ones "dashboard". Counts are
    # of threads' comments (root + replies); "open" counts those on an
    # unresolved thread. See routers/dashboard_comments.py.
    comment_counts: dict[str, dict] = {}
    # 2026-10-07 (identity-colour round): how the dashboard looks, RESOLVED
    # (services/appearance.effective_appearance): the chart palette, colour
    # mode, pins, the colour registry, density / radius / font, currency /
    # locale, the published link's default theme and footer note, plus
    # `source` ("dashboard" | "workspace" | "default") and `brand` (the
    # chrome colours in force). workspace_brand_kit is the kit this
    # dashboard would follow after "Reset to workspace brand" (None when
    # the workspace has none), brand_workspace_name whose kit that is.
    appearance: Optional[dict] = None
    workspace_brand_kit: Optional[dict] = None
    brand_workspace_id: Optional[str] = None
    brand_workspace_name: Optional[str] = None


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
    # 2026-10-06 (warehouse-native dashboards layer): the published view
    # renders the same filter rail / period control / saved views as the
    # editor, so it needs the same definitions (never the datasource id,
    # never credentials). warehouse_native tells the viewer to call the
    # public run endpoint instead of preview-filtered.
    datasource_kind: Optional[str] = None
    warehouse_native: bool = False
    parameters: list[dict] = []
    saved_views: list[dict] = []
    default_period: Optional[str] = None
    date_column: Optional[str] = None
    # 2026-10-07 (identity-colour round): the same resolved appearance the
    # owner's payload carries (DashboardBuilderOut.appearance), so an
    # anonymous viewer sees the same colours, type and number formats.
    appearance: Optional[dict] = None


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


# 2026-10-07 (identity-colour round): PATCH /dashboard-builder/{id}/appearance.
# Every field optional; only the keys actually sent are applied (the
# router reads model_fields_set), so "density": "compact" alone changes
# nothing else. The shape of each field and every validation message is
# services/appearance.py - loose types here on purpose, so a bad value is
# answered with that module's plain sentence rather than a generic 422.
#   palette        {"kind": "preset", "id"} | {"kind": "brand", "color"} |
#                  {"kind": "custom", "colors": [<=10 hex], "adjust": bool}
#   color_mode     "by_value" | "single"          single_color  hex | null
#   theme_default  "auto" | "light" | "dark"      density  "comfortable" | "compact"
#   radius         "sharp" | "soft" | "round"     font     a preset id
#   currency       ISO 4217                       locale   BCP-47 | "auto"
#   footer_note    <= 160 characters
#   value_colors   {column: {value: hex | slot 0-9}} - REPLACES the pins
#   reset          "workspace" (follow the workspace brand kit again) |
#                  "colors" (forget the pins and the colour registry)
# The colour registry (`assignments`) is never accepted from a client.
class UpdateAppearanceRequest(BaseModel):
    palette: Optional[Any] = None
    color_mode: Optional[Any] = None
    single_color: Optional[Any] = None
    theme_default: Optional[Any] = None
    density: Optional[Any] = None
    radius: Optional[Any] = None
    font: Optional[Any] = None
    currency: Optional[Any] = None
    locale: Optional[Any] = None
    footer_note: Optional[str] = Field(default=None, max_length=400)
    value_colors: Optional[Any] = None
    reset: Optional[Any] = None


class DashboardAppearanceOut(BaseModel):
    # The resolved appearance after the change, and the workspace kit the
    # dashboard follows / would follow (see DashboardBuilderOut).
    appearance: dict
    workspace_brand_kit: Optional[dict] = None
    brand_workspace_id: Optional[str] = None
    brand_workspace_name: Optional[str] = None


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
    # 2026-10-01 (chat-to-dashboard round): optional - lets a block be
    # created ALREADY FILLED with a real, already-computed result (a chart/
    # table a person just got in the chat panel, or on the data workspace's
    # own "current chart"), instead of always starting empty and needing a
    # second ask-ai/build-manual call. The caller (PushToDashboardMenu.tsx)
    # builds this from the exact same ChartEntry/ResultEntry data already
    # rendered on screen - chart_spec, result_columns/result_rows,
    # chart_type, source_code, ai_prompt, ai_explanation, source_table -
    # never a second AI call, so this is honest, real data the person
    # already saw, just relocated onto a dashboard. None/omitted keeps
    # create_block's original always-empty behavior exactly as before.
    config: Optional[dict] = None
    # 2026-10-07 (chart-types round): "forecast" - the Add-block template
    # that creates a time-series chart with its forecast already on (rows
    # by period over the dashboard's date column; the person then edits
    # the query). Only read for type "chart".
    template: Optional[str] = Field(default=None, max_length=40)


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


# 2026-10-07 (block editing round): PATCH /dashboard-builder/{id}/pages/
# {page_id}/layout - every block the canvas moved/resized in ONE gesture
# (react-grid-layout reports the whole compacted layout at once), stored
# in one transaction instead of one PATCH per block. Layout only: never a
# content change, so no undo snapshot and no data_updated_at bump. The
# ranges (1-200 items, w 1..12, h >= 1, x/y >= 0, x + w <= 12, unique ids
# that all belong to that page) are checked in the endpoint so every
# violation is a 400 with a specific message.
class PageLayoutItem(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    x: int
    y: int
    w: int
    h: int


class UpdatePageLayoutRequest(BaseModel):
    items: list[PageLayoutItem]


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
    # 2026-09-30 (semantic layer v1): metric_id, when set, builds this
    # kpi/gauge block from a SAVED metric definition (models.
    # MetricDefinition) instead of a fresh column+agg pick - see
    # routers/dashboard_builder.py's build_manual_block for how the two
    # paths differ (a metric-backed block always resolves live through
    # services/metrics.py, even after a page filter change or an edit to
    # the metric itself, rather than freezing a one-shot recipe the way a
    # plain column+agg kpi/gauge already does). Mutually exclusive with
    # metric_column/agg in practice (the frontend only ever sends one or
    # the other) - metric_column/agg are therefore optional now, only
    # required when metric_id is absent, checked in the endpoint itself
    # rather than here since a Pydantic model can't express "required
    # unless this OTHER field is set."
    metric_id: Optional[str] = None
    # 2026-09-30 (transformation layer v1): when set, this block is built
    # from a SAVED transform's (models.DataTransform) output table instead
    # of this data source's raw data - see routers/dashboard_builder.py's
    # build_manual_block for exactly where this is resolved (BEFORE
    # payload.filters and any metric_id/metric_column pick, so a transform
    # can feed either path: a plain column+agg tile, or a metric-backed
    # one, built on top of its derived columns). Like metric_id, this
    # always resolves live (services/transforms.apply_transform_steps)
    # rather than freezing a one-shot snapshot - editing the transform, not
    # just changing a page filter, is reflected the next time this block is
    # rebuilt or the page's filters are (re)applied.
    transform_id: Optional[str] = None
    metric_column: Optional[str] = Field(default=None, min_length=1)
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
    # 2026-10-07 (block editing on a warehouse source): WAREHOUSE/DATABASE
    # sources only - which table (or saved-query alias) metric_column/
    # group_by_column belong to. Omitted = the dashboard's own table (the
    # one most of its blocks already use, else the data source's first
    # table). A file source ignores it (its recipe runs on the file's
    # data exactly as before).
    table: Optional[str] = Field(default=None, max_length=300)
    # 2026-10-07 (chart-types round) - what the new chart forms need on top
    # of "one measure by one column". All optional; a request without them
    # builds exactly what it always did.
    #   group_by_column_2   a second dimension (heatmap, pivot, stacked,
    #                       treemap levels, a waterfall bridge)
    #   extra_measures      [{agg, column}] more measures (scatter, bubble,
    #                       combo panels), at most 5
    #   time_grain          bucket group_by_column (a date column) by
    #                       day / week / month / quarter / year
    #   bins                {"column", "count"} - a histogram of a numeric
    #                       column (group_by_column is then ignored)
    #   forecast            turn the forecast on (needs time_grain)
    group_by_column_2: Optional[str] = None
    extra_measures: list[dict] = Field(default_factory=list, max_length=5)
    time_grain: Optional[str] = Field(default=None, max_length=12)
    bins: Optional[dict] = None
    forecast: Optional[bool] = None


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


# 2026-10-07 (chart-types round): the "Forecast..." sheet of a time-series
# block - see routers/dashboard_builder.py set_block_forecast and
# services/forecast.py. `horizon` is in periods of the block's grain;
# `interval` is "80" | "95" | "both".
class SetBlockForecastRequest(BaseModel):
    enabled: bool = True
    horizon: Optional[int] = Field(default=None, ge=1, le=90)
    interval: str = Field(default="both", max_length=8)
    anomalies: bool = False


# A forecast of a series the caller already holds (a chat answer's
# aggregated time series): stateless, the same forecaster.
class ForecastSeriesItem(BaseModel):
    key: str = Field(min_length=1, max_length=200)
    values: list[Optional[float]] = Field(min_length=1, max_length=2000)


class ForecastSeriesRequest(BaseModel):
    periods: list[str] = Field(min_length=1, max_length=2000)
    # ONE series (`values`), or several over the same periods (`series`):
    # with `series_by` they are the values of one breakdown column of the
    # measure named `measure`; without it each is a measure of its own.
    values: Optional[list[Optional[float]]] = Field(default=None, max_length=2000)
    series: Optional[list[ForecastSeriesItem]] = Field(default=None, max_length=24)
    series_by: bool = False
    measure: str = Field(default="value", min_length=1, max_length=200)
    grain: str = Field(default="month", max_length=12)
    horizon: Optional[int] = Field(default=None, ge=1, le=90)
    interval: str = Field(default="both", max_length=8)
    anomalies: bool = False
    # A count or a sum (a period with no rows is a zero) vs an average.
    additive: bool = True
    # A rate: held within [0, 1].
    rate: bool = False


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
    # 2026-10-07 (identity-colour round): the dashboard's colour registry
    # as it stands after this request ({"assignments": {column: {value:
    # slot}}, "overflow": [columns], "registry_full": bool}) - see
    # services/appearance.py. None when the dashboard is not known here.
    colors: Optional[dict] = None
    # 2026-09-25e (elite pass, real filter-bar row count): the real number
    # of rows in the datasource that match `payload.filters` - literally
    # `len(df)` after preview_filtered_blocks applies those filters, no
    # separate query. This is what lets the frontend show an honest
    # "Showing 6,709 rows" next to the filter row (the reference dashboard
    # screenshots Gokul sent) instead of a fabricated number - see this
    # engagement's standing rule against ever inventing stats.
    #
    # 2026-10-02 fix: now `int | None`, was `int = 0`. The comment used to
    # claim "0 whenever the datasource couldn't be loaded... frontend
    # treats 0 as no count to show" - that was never actually true: the
    # frontend only ever checked `!== null`, so a literal 0 rendered as the
    # real UI string "0 rows match," reading as "nothing matches" instead
    # of the intended "no count available right now." None is the honest
    # value for "couldn't load the live datasource this request" - a
    # genuine zero-match filter result (the data loaded fine, nothing
    # happened to match) still correctly returns the integer 0 and still
    # correctly shows "0 rows match."
    matched_rows: int | None = None
    # 2026-10-07: {column: {"min": "YYYY-MM-DD", "max": "YYYY-MM-DD"}} for
    # the dashboard's date column and its date_range controls, from the
    # complete (unfiltered) file - what the date pickers open on. {} when
    # the file could not be loaded or holds no dates.
    date_bounds: dict = {}


# ---------- Warehouse-native dashboards (2026-10-06) ----------
# For a dashboard on a warehouse/database source every block is a BlockSpec
# (services/query_builder.validate_block_spec) compiled into ONE query that
# runs inside the warehouse with the page's filters pushed down - see
# services/dashboard_engine.py and routers/dashboard_builder.py's run_page.
# The filter payload reuses FilterCriterion/ApplyFiltersRequest's shapes
# exactly (the Data tab's own _apply_column_filter vocabulary), so the
# same rail drives the pandas path for a file source and the SQL path for a
# warehouse source.

class DateRangeIn(BaseModel):
    # Inclusive ISO dates ("YYYY-MM-DD"); either end may be omitted for an
    # open-ended range. The engine pushes this down on the dashboard's
    # date_column as >= from AND < to + 1 day.
    from_: Optional[str] = Field(default=None, alias="from", max_length=40)
    to: Optional[str] = Field(default=None, max_length=40)
    model_config = {"populate_by_name": True}

    def as_dict(self) -> dict:
        return {"from": self.from_, "to": self.to}


class RunPageRequest(BaseModel):
    filters: list[FilterCriterion] = Field(default_factory=list, max_length=12)
    block_filters: dict[str, list[FilterCriterion]] = Field(default_factory=dict)
    # The time grain for time charts and KPI sparklines this run
    # ("day"|"week"|"month"|"quarter"|"year"); None = the dashboard's
    # default_period, else "month".
    period: Optional[str] = Field(default=None, max_length=16)
    date_range: Optional[DateRangeIn] = None
    # Only these blocks (e.g. the one a person just edited); None = every
    # warehouse block on the page.
    block_ids: Optional[list[str]] = Field(default=None, max_length=100)
    # Skip the result cache for this run (the "Refresh" button).
    force_refresh: bool = False
    # 2026-10-07 (analyst canvas round): the viewer's current value for
    # each rail parameter, keyed by the parameter's name (or id) - what a
    # SQL cell's {{name}} / @name references are BOUND to (never spliced
    # into the SQL). A list for a multi-select, {from, to} for a
    # date_range control (the request's own date_range fills a
    # date_range parameter that has no explicit value here).
    parameters: dict[str, Any] = Field(default_factory=dict)


class RunPageOut(BaseModel):
    # {block_id: BlockResult} - see services/dashboard_engine.BlockResult
    # for the exact shape: {status, columns, rows, row_count, truncated,
    # sql, bytes_scanned, duration_ms, cached, prior, delta, sparkline,
    # exact_total_rows, computed_in, error, dimensions, measures,
    # time_column, spec}.
    blocks: dict[str, dict]
    # COUNT(*) of the dashboard's table under the page filters (cached),
    # None when it could not be computed this run.
    matched_rows: int | None = None
    # The unfiltered row count of the dashboard's table when the Data tab's
    # profile already paid for it (never a fresh query), else None.
    total_rows: int | None = None
    computed_in: str
    total_duration_ms: int
    period: str
    date_range: Optional[dict] = None
    # Blocks on the page that were skipped because they have no spec yet
    # (an AI-built block from before this layer - see POST /upgrade-blocks)
    # or are not data blocks.
    skipped_block_ids: list[str] = []
    # 2026-10-07 (block editing round): the subset of skipped_block_ids
    # that are simply EMPTY - a data block added to a warehouse dashboard
    # and not built yet (config.empty == true: no spec, no bound cell, no
    # stored result). Not a legacy block and not an error: render "empty,
    # not built yet". Every id here is also in skipped_block_ids.
    empty_block_ids: list[str] = []
    # 2026-10-07 (analyst canvas round): {block_id: [block ids it needs
    # first]} - a chart bound to a sql cell, a sql cell reading another
    # as a CTE; `order` is the resolved run order. A loop is rejected
    # with a 400 before anything runs.
    dependencies: dict[str, list[str]] = {}
    order: list[str] = []
    # The parameter values the SQL cells were bound to, by name, and the
    # referenced parameters that had no value (bound as NULL / empty).
    parameters_used: dict[str, Any] = {}
    missing_parameters: list[str] = []
    # 2026-10-07: {column: {"min": "YYYY-MM-DD", "max": "YYYY-MM-DD"}} -
    # the real first and last date of the dashboard's date column and of
    # every date_range control's column (one cached MIN/MAX query in the
    # warehouse). The date pickers open on `max`, disable days outside the
    # bounds and anchor their presets to `max` for data that ended a while
    # ago. {} on a partial run (block_ids) or when it could not be read.
    date_bounds: dict = {}
    # 2026-10-07 (identity-colour round): the dashboard's colour registry
    # after this run - {"assignments": {column: {value: slot 0-9}},
    # "overflow": [columns with more values than slots], "registry_full"}.
    # New values this run showed are already in it (services/appearance.
    # assign_colors), so the page can colour what it just received.
    colors: Optional[dict] = None


class ParameterOptionsOut(BaseModel):
    parameter_id: str
    column: str
    table: str
    search: Optional[str] = None
    values: list[dict]  # [{value, count}]
    truncated: bool = False
    cached: bool = False
    error: Optional[str] = None


class UpdateParametersRequest(BaseModel):
    # The whole rail, replaced: [{id, column, label, control, options_from,
    # default, table?}] - validated server-side (column must exist on the
    # dashboard's table; control must be a known kind).
    parameters: list[dict] = Field(default_factory=list, max_length=24)


class UpdateSavedViewsRequest(BaseModel):
    # The whole list, replaced: [{id, name, filters, period, date_range,
    # created_by}]. id/created_by are filled in server-side when missing.
    saved_views: list[dict] = Field(default_factory=list, max_length=50)


class SetBlockSpecRequest(BaseModel):
    spec: dict
    title: Optional[str] = Field(default=None, max_length=200)
    # Chart type for a chart block (bar/line/area/pie/...); kpi/table are
    # inferred from the spec's shape when omitted.
    chart_type: Optional[str] = Field(default=None, max_length=40)
    block_type: Optional[str] = Field(default=None, max_length=40)


class BlockSqlOut(BaseModel):
    block_id: str
    sql: str
    prior_sql: Optional[str] = None
    sparkline_sql: Optional[str] = None
    dialect: str
    period: str
    date_range: Optional[dict] = None
    filters_applied: list[dict] = []


class UpgradeBlockResult(BaseModel):
    block_id: str
    title: Optional[str] = None
    status: str  # "upgraded" | "already_has_spec" | "skipped" | "failed"
    error: Optional[str] = None
    spec: Optional[dict] = None
    sql: Optional[str] = None


class UpgradeBlocksOut(BaseModel):
    results: list[UpgradeBlockResult]
    upgraded: int
    failed: int
    skipped: int


# ---------- Block comments (2026-10-07) - see models.DashboardComment and
# routers/dashboard_comments.py ----------
class CommentCreateRequest(BaseModel):
    body: str = Field(min_length=1, max_length=5000)
    # Where it hangs: a block, else a page, else the dashboard. A reply
    # (parent_id set) inherits its root's block/page/anchor.
    block_id: Optional[str] = None
    page_id: Optional[str] = None
    parent_id: Optional[str] = None
    # The chart element it is pinned to - {kind: "bar"|"point"|"cell",
    # key: <value>, ...}, stored as given.
    anchor: Optional[dict] = None


class CommentUpdateRequest(BaseModel):
    # body: author only. resolved: author or a dashboard editor; applies
    # to the whole thread (set on the root).
    body: Optional[str] = Field(default=None, min_length=1, max_length=5000)
    resolved: Optional[bool] = None


class CommentAuthorOut(BaseModel):
    id: str
    name: str
    initials: str
    email: Optional[str] = None


class CommentOut(BaseModel):
    id: str
    dashboard_id: str
    block_id: Optional[str] = None
    page_id: Optional[str] = None
    parent_id: Optional[str] = None
    author: CommentAuthorOut
    body: str
    anchor: Optional[dict] = None
    mentions: list[str] = []
    resolved_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime
    # What the CALLER may do with this comment.
    can_edit: bool = False
    can_resolve: bool = False
    can_delete: bool = False


class CommentThreadOut(CommentOut):
    replies: list[CommentOut] = []
    reply_count: int = 0
    resolved: bool = False


class CommentsOut(BaseModel):
    threads: list[CommentThreadOut]
    # {block_id | "page:<id>" | "dashboard": {"open", "total"}} - the same
    # shape as DashboardBuilderOut.comment_counts, for the scope queried.
    counts: dict[str, dict] = {}
    total: int = 0
    open: int = 0


# ---------- Dashboard from prompt (2026-10-07) - propose / revise / commit.
# See routers/dashboard_builder.py's propose_dashboard for the flow. ----------
class ProposeDashboardRequest(BaseModel):
    datasource_id: str = Field(min_length=1)
    goal: str = Field(min_length=3, max_length=2000)
    # "auto" lets the model decide (1 or 2); 1 or 2 forces it.
    pages: Any = "auto"
    # The dashboard's default period grain ("day"|"week"|"month"|
    # "quarter"|"year"); None = month.
    period: Optional[str] = Field(default=None, max_length=16)
    # One of GET /dashboard-builder/propose/templates' ids - its goal
    # text and layout hints are merged into the request.
    template_id: Optional[str] = None
    # Optional: the chat this dashboard should link back to ("Built from").
    conversation_id: Optional[str] = None


class ProposalBlockOut(BaseModel):
    client_id: str
    type: str  # "kpi" | "chart" | "table" | "text" | "sparkline" | "donut"
    title: str
    # A short label like "KPI · Revenue metric" / "Trend · revenue by month".
    intent: str
    # The validated BlockSpec (warehouse) or None for a text block / an
    # invalid block. For a file source: the spec the recipe was derived
    # from (see `recipe`).
    spec: Optional[dict] = None
    # File sources only: the deterministic pandas recipe (manual-build
    # shape) that will compute this block at commit time.
    recipe: Optional[dict] = None
    chart_type: Optional[str] = None
    # Text blocks: the note's body.
    text: Optional[str] = None
    layout: dict  # {x, y, w, h} on a 12-column grid
    from_metric_id: Optional[str] = None
    from_metric_name: Optional[str] = None
    status: str  # "ok" | "invalid"
    error: Optional[str] = None
    # The compiled at-rest SQL for an ok warehouse block (what "see its
    # query" shows before commit).
    sql: Optional[str] = None
    columns: list[dict] = []
    # 2026-10-07 (chart-types round): why this chart form was chosen, in
    # one line ("Country column -> map") - services/chart_recommender.py -
    # and the forecast options when the goal asked for one.
    chart_reason: Optional[str] = None
    forecast: Optional[dict] = None


class ProposalPageOut(BaseModel):
    title: str
    blocks: list[ProposalBlockOut]


class ProposalOut(BaseModel):
    proposal_id: str
    datasource_id: str
    datasource_name: Optional[str] = None
    datasource_kind: Optional[str] = None
    warehouse_native: bool
    title: str
    pages: list[ProposalPageOut]
    used: dict  # {"metrics": [names], "columns": [names], "tables": [names]}
    suggestions: list[str] = []
    date_column: Optional[str] = None
    period: str = "month"
    # Parameters the commit will create (one per filterable dimension the
    # kept blocks use + a date_range on the date column) - so the review
    # screen can show them.
    parameters: list[dict] = []
    revision: int = 1
    # How long the server keeps this proposal (seconds from creation).
    expires_in_seconds: int = 1800
    generated_in_ms: int = 0
    # Honest counts: how many blocks the model proposed vs. survived
    # validation.
    proposed_blocks: int = 0
    valid_blocks: int = 0
    # Set when the model call failed outright (the proposal is then a
    # deterministic fallback built from the schema alone).
    warning: Optional[str] = None


class ProposalTemplateOut(BaseModel):
    id: str
    name: str
    description: str
    goal: str
    pages: int
    period: str
    layout_hints: list[str] = []


class ReviseProposalRequest(BaseModel):
    instruction: str = Field(min_length=1, max_length=1000)


class CommitProposalRequest(BaseModel):
    # The client_ids to keep; everything else in the proposal is dropped.
    # Empty/omitted = every valid block.
    keep: Optional[list[str]] = None
    name: Optional[str] = Field(default=None, max_length=120)
    # "private" (only you) | "workspace" (shared with the data source's
    # workspace, same view/edit split as every shared dashboard).
    visibility: Optional[str] = Field(default="private", max_length=20)


class SwapBlockRequest(BaseModel):
    # Either/both: a new chart_type for a chart block, or a new block type
    # (chart/table/kpi/donut/sparkline/avatar_list/gauge) for the same
    # spec. No model call - the same query, another shape.
    chart_type: Optional[str] = Field(default=None, max_length=40)
    type: Optional[str] = Field(default=None, max_length=40)


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


# ---------- 2026-09-30 (leakage-guardrail round) ----------
# See models.MLModel.quality_warnings/services/ml_training.py's own module
# docstring for the full story (the "predict Sales" leakage case this
# round exists because of) and services/ml_training.preview_features/
# train_model for exactly how everything below is computed. Every field is
# a real number already sitting in metrics/feature_importance/a real
# pandas correlation - this schema never carries a pre-written sentence;
# see frontend lib/mlModelText.ts's own docstring for why every plain-
# language sentence in this feature is built in exactly one place, on the
# frontend, from raw numbers like these.
class MLQualityWarning(BaseModel):
    # "near_perfect_score" | "dominant_feature" | "high_correlation_feature"
    # - see services/ml_training.train_model's own comments for what
    # triggers each one.
    type: str
    metric: Optional[str] = None       # near_perfect_score only: "r2" | "accuracy"
    value: Optional[float] = None      # near_perfect_score only: that metric's real value
    feature: Optional[str] = None      # dominant_feature / high_correlation_feature only
    importance: Optional[float] = None  # dominant_feature only: that feature's real share (0-1)
    correlation: Optional[float] = None  # high_correlation_feature only: real, signed Pearson correlation


class MLFeatureCandidate(BaseModel):
    # One real, computed row of a preview-features result - see
    # services/ml_training.preview_features's own docstring.
    column: str
    is_numeric: bool
    distinct_count: int
    # Real Pearson correlation with the target - only ever computed for a
    # REGRESSION target's numeric candidates (see preview_features's own
    # docstring for why classification has no equivalent honest number
    # here); None otherwise, never a fabricated placeholder.
    correlation: Optional[float] = None
    # "high" | "medium" | None - see services/ml_training._risk_for_
    # correlation's own docstring for the exact, stated thresholds.
    risk: Optional[str] = None


class PreviewMLFeaturesRequest(BaseModel):
    datasource_id: str
    target_column: str = Field(min_length=1, max_length=200)


class PreviewMLFeaturesResponse(BaseModel):
    # Real, auto-detected from the target column's own values - see
    # services/ml_training.infer_task_type. Never trained on; this is a
    # preview, no MLModel row is created or touched by this endpoint.
    task_type: str  # "classification" | "regression"
    usable: list[MLFeatureCandidate]
    excluded: list[MLExcludedColumn]


class MLModelVersionOut(BaseModel):
    id: str
    version_number: int
    is_current: bool
    created_reason: str  # "trained" | "promoted" - see models.MLModelVersion's own docstring
    algorithm: Optional[str] = None
    metrics: Optional[dict] = None
    feature_importance: Optional[list[FeatureImportanceEntry]] = None
    # See models.MLModel.quality_warnings's own docstring - this version's
    # own real snapshot, travels with it (promoting an old version
    # restores its own warnings too, never someone else's).
    quality_warnings: Optional[list[MLQualityWarning]] = None
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
    # See models.MLModel.quality_warnings's own docstring. None for a
    # model trained before this round existed; [] for one trained since
    # with nothing to flag - the frontend treats both as "nothing to show"
    # but only [] actually means "checked, and it's clean".
    quality_warnings: Optional[list[MLQualityWarning]] = None
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
    # 2026-10-08 (round 13): set for models started in ML Studio.
    problem_type: Optional[str] = None
    goal: Optional[str] = None


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


# 2026-09-30 (leakage-guardrail round): request body for POST /ml-models/
# {id}/retrain, now optional (a plain "Retrain with latest data" click
# still sends no body at all, matching this endpoint's exact behavior
# before this round). See routers/ml_models.py retrain_ml_model's own
# docstring for why this exists: without it, the only way to change which
# columns an EXISTING model uses was to edit feature_columns directly in
# the database (exactly what this round's own live "predict Sales" fix
# needed) - a real gap for a model someone wants to correct rather than
# delete and recreate from scratch.
class RetrainMLModelRequest(BaseModel):
    # None (the default) means "reuse whichever real columns this model's
    # last training run actually used" - the original, unchanged behavior.
    # A list here narrows the CANDIDATE features before this retrain runs,
    # same as feature_columns on the original POST /train - every one
    # still goes through services/ml_training.select_features's exact same
    # exclusion checks, so an explicitly requested column can still
    # legitimately end up excluded.
    feature_columns: Optional[list[str]] = None


class ScoreTableOut(BaseModel):
    new_version_id: str
    new_version_name: str
    row_count: int


# ---------- Semantic layer v1 (2026-09-30) ----------
# See models.MetricDefinition's own docstring for the full design and
# services/metrics.py for how a metric is actually resolved. Schema
# convention mirrors MLModel's own Create/Out split above exactly:
# metric_column/agg/filters are the same fixed, small vocabulary
# routers/dashboard_builder.py's manual-build form already uses (agg is
# one of AGG_OPTIONS' five values; filters reuses FilterCriterion, the
# same shape a dashboard's own cross-filters already use), so there is no
# new filter vocabulary to learn here.

class MetricDefinitionCreate(BaseModel):
    datasource_id: str
    name: str = Field(min_length=1, max_length=120)
    description: Optional[str] = Field(default=None, max_length=2000)
    metric_column: str = Field(min_length=1)
    agg: str = "sum"  # "sum" | "avg" | "count" | "min" | "max"
    filters: list[FilterCriterion] = Field(default_factory=list, max_length=8)


class MetricDefinitionUpdate(BaseModel):
    # A full-replace update (like ManualBuildBlockRequest, not a PATCH-
    # style partial) - the metric editor form always has every field
    # loaded already, so there is no case where a caller genuinely wants
    # to leave one unspecified.
    name: str = Field(min_length=1, max_length=120)
    description: Optional[str] = Field(default=None, max_length=2000)
    metric_column: str = Field(min_length=1)
    agg: str = "sum"
    filters: list[FilterCriterion] = Field(default_factory=list, max_length=8)


class MetricDefinitionOut(BaseModel):
    id: str
    datasource_id: str
    datasource_name: str
    name: str
    description: Optional[str] = None
    metric_column: str
    agg: str
    filters: list[FilterCriterion] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime
    owner_id: str
    created_by_name: Optional[str] = None
    # Resolved server-side, live, every time this metric is listed/fetched
    # (services/metrics.resolve_metric_value against this data source's
    # current data) - never a stale, cached number. None (with
    # current_value_error explaining why) rather than a fabricated 0 when
    # it can't currently be computed (e.g. the saved column was renamed).
    current_value: Optional[float] = None
    current_value_error: Optional[str] = None
    # Same creator-only convention as MLModel.can_delete above - resolved
    # server-side (owner_id === the caller) so the frontend never has to
    # re-derive ownership logic itself.
    can_delete: bool


# ---------- Transformation layer v1 (2026-09-30) ----------
# See models.DataTransform's own docstring for the full design and
# services/transforms.py for how a transform is actually applied. `steps`
# is kept as a permissive list[dict] rather than a discriminated Pydantic
# union - the same tradeoff FilterCriterion.spec's own docstring already
# accepts, for the same reason: five genuinely different step shapes, and
# services/transforms.py's own validation (never executed as code, always
# dispatched through its fixed op -> handler mapping) is the single source
# of truth for what is and isn't a valid step.

class DataTransformCreate(BaseModel):
    datasource_id: str
    name: str = Field(min_length=1, max_length=120)
    description: Optional[str] = Field(default=None, max_length=2000)
    steps: list[dict] = Field(default_factory=list, max_length=20)


class DataTransformUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: Optional[str] = Field(default=None, max_length=2000)
    steps: list[dict] = Field(default_factory=list, max_length=20)


class DataTransformOut(BaseModel):
    id: str
    datasource_id: str
    datasource_name: str
    name: str
    description: Optional[str] = None
    steps: list[dict] = Field(default_factory=list)
    # One plain-English line per step, in order - services/transforms.
    # describe_transform - so the panel's own summary never disagrees with
    # what the AI is told (services/ai_engine._transform_glossary_text).
    step_summary: list[str] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime
    owner_id: str
    created_by_name: Optional[str] = None
    # Resolved server-side, live, every time this transform is listed/
    # fetched (services/transforms.apply_transform_steps against this data
    # source's current data) - never a stale, cached result. None (with
    # preview_error explaining why) rather than a fabricated empty table
    # when it can't currently be computed (e.g. a referenced column was
    # renamed or removed).
    preview_columns: Optional[list[str]] = None
    preview_row_count: Optional[int] = None
    preview_error: Optional[str] = None
    can_delete: bool


class TransformPreviewRequest(BaseModel):
    """Live preview of UNSAVED steps while building/editing a transform -
    posts the in-progress `steps` list directly rather than a saved
    transform id, so the builder's preview stays in sync with every edit
    before the person ever clicks Save."""
    steps: list[dict] = Field(default_factory=list, max_length=20)


class TransformPreviewOut(BaseModel):
    columns: list[str] = Field(default_factory=list)
    rows: list[dict] = Field(default_factory=list)
    row_count: int = 0
    truncated: bool = False
    error: Optional[str] = None


# ---------- Orchestration v1 (2026-09-30) ----------
# See models.Pipeline's own docstring for the full design - a named,
# saved, linear chain of a few whitelisted step types, run in strict
# order. PIPELINE_STEP_TYPES/PIPELINE_SCHEDULE_INTERVALS are the single
# source of truth both this file's own validation-by-convention and
# routers/pipelines.py's explicit checks refer back to; kept separate from
# schemas.REFRESH_INTERVALS above (rather than reusing it directly) since
# a Pipeline's schedule is conceptually its own thing even though the
# four real interval values happen to be identical to a Dashboard's.
PIPELINE_STEP_TYPES = ("refresh_datasource", "rebuild_dashboard", "run_quality_checks")
PIPELINE_SCHEDULE_INTERVALS = ("off", "15m", "1h", "6h", "daily")


class PipelineStepResultOut(BaseModel):
    """One entry of a PipelineRun.step_results list - see that model's own
    docstring for exactly what each field means."""
    index: int
    type: Optional[str] = None
    label: Optional[str] = None
    status: str  # "success" | "failed"
    detail: Optional[dict] = None
    error: Optional[str] = None


class PipelineRunOut(BaseModel):
    id: str
    pipeline_id: Optional[str] = None
    run_type: str  # "scheduled" | "manual"
    pipeline_name: str
    status: str  # "running" | "success" | "failed"
    error_message: Optional[str] = None
    step_results: list[PipelineStepResultOut] = Field(default_factory=list)
    started_at: datetime
    finished_at: Optional[datetime] = None
    duration_seconds: Optional[float] = None
    next_run_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class PipelineRunsPage(BaseModel):
    runs: list[PipelineRunOut]
    total: int
    page: int
    page_size: int


class PipelineOut(BaseModel):
    id: str
    name: str
    description: Optional[str] = None
    steps: list[dict] = Field(default_factory=list)
    # Plain-English one-liner per step (services/pipelines.describe_
    # pipeline), resolved live from each step's current target name -
    # never stale, same convention DataTransformOut.step_summary already
    # established.
    step_summary: list[str] = Field(default_factory=list)
    schedule_interval: str = "off"
    next_run_at: Optional[datetime] = None
    last_run_at: Optional[datetime] = None
    last_run_status: Optional[str] = None
    can_edit: bool = True
    can_delete: bool = False
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class PipelineCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: Optional[str] = None
    steps: list[dict] = Field(default_factory=list)
    schedule_interval: str = "off"
    workspace_id: Optional[str] = None


class PipelineUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=200)
    description: Optional[str] = None
    steps: Optional[list[dict]] = None
    schedule_interval: Optional[str] = None


# ---------- Data catalog v1 (2026-09-30) - REMOVED (Governance/Jobs
# redesign + Pipelines/Catalog removal round) ----------
# CatalogEntryOut used to live here. Gokul's own report: the Catalog page
# duplicated the Projects filter and Data Sources page and "leads to
# confusion" - removed entirely (routers/catalog.py, services/catalog.py,
# pages/Catalog.tsx all deleted). Its one real, non-redundant capability
# (editing a data source's short description) was never defined here in
# the first place - see UpdateDataSourceDescriptionRequest above, which
# routers/datasources.py's own PATCH /datasources/{id}/description already
# used independently of this file.
