"""
ORM models for the GD360 Analytics application database.
"""
import secrets
import uuid
from datetime import datetime

from sqlalchemy import (
    Column, String, DateTime, ForeignKey, Text, JSON, Boolean, Integer, LargeBinary, BigInteger,
    Float, UniqueConstraint, Index,
)
from sqlalchemy.orm import relationship

from .database import Base


def gen_uuid() -> str:
    return str(uuid.uuid4())


class User(Base):
    __tablename__ = "users"

    id = Column(String, primary_key=True, default=gen_uuid)
    email = Column(String, unique=True, index=True, nullable=False)
    hashed_password = Column(String, nullable=False)
    full_name = Column(String, nullable=True)
    company = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    # --- Login lockout (slows down password-guessing bots) ---
    failed_login_attempts = Column(Integer, default=0)
    locked_until = Column(DateTime, nullable=True)

    # 2026-09-24 (full-app security round): bumped every time this user
    # changes their password (see routers/auth.py change_password). Baked
    # into every access token issued at login (security.create_access_token
    # / deps.get_current_user) as the "tv" claim - a token whose "tv" no
    # longer matches this column is rejected even though it hasn't expired
    # yet, so changing your password actually signs out every OTHER device/
    # session immediately, not just the one you changed it from. NOT NULL
    # with a server default of 0 so every pre-existing row (and every plain
    # INSERT that omits it) is unambiguously "never changed" rather than
    # NULL, which would otherwise need special-casing everywhere it's read.
    token_version = Column(Integer, default=0, nullable=False, server_default="0")

    # foreign_keys is explicit here for the same reason DataSource.owner's
    # own relationship below states it - DataSource.governance_last_
    # reviewed_by_id (Phase 5, Batch A) is a second column on datasources
    # that also points at users.id, so SQLAlchemy needs to be told which of
    # the two this relationship (the data source's real owner) means.
    datasources = relationship(
        "DataSource", back_populates="owner", cascade="all, delete-orphan",
        foreign_keys="DataSource.owner_id",
    )
    conversations = relationship("Conversation", back_populates="owner", cascade="all, delete-orphan")
    dashboards = relationship("Dashboard", back_populates="owner", cascade="all, delete-orphan")
    learned_answers = relationship("LearnedAnswer", cascade="all, delete-orphan")


class Workspace(Base):
    """
    A workspace groups data sources/projects under one roof with a member
    list - "Personal Workspace" (is_personal=True) vs. a team/project
    workspace the account owner creates and invites people into (see
    routers/workspaces.py). Every account gets exactly one personal
    workspace automatically (created at registration - see routers/auth.py
    - or backfilled for pre-existing accounts by
    database._ensure_personal_workspaces); everything else is created on
    request from the sidebar's workspace switcher.

    Joining works by shareable link, not emailed invite - this app has no
    transactional email sending set up yet (2026-09-23 build notes), so
    invite_token is a single, regenerable token embedded in a
    /invite/<token> link the workspace owner copies and sends themselves.
    """
    __tablename__ = "workspaces"

    id = Column(String, primary_key=True, default=gen_uuid)
    name = Column(String, nullable=False)
    owner_id = Column(String, ForeignKey("users.id"), nullable=False)
    is_personal = Column(Boolean, default=False)
    invite_token = Column(String, unique=True, index=True, nullable=False, default=gen_uuid)
    created_at = Column(DateTime, default=datetime.utcnow)

    members = relationship("WorkspaceMember", back_populates="workspace", cascade="all, delete-orphan")


class WorkspaceMember(Base):
    __tablename__ = "workspace_members"
    __table_args__ = (UniqueConstraint("workspace_id", "user_id", name="uq_workspace_member"),)

    id = Column(String, primary_key=True, default=gen_uuid)
    workspace_id = Column(String, ForeignKey("workspaces.id"), nullable=False)
    user_id = Column(String, ForeignKey("users.id"), nullable=False)
    role = Column(String, default="member")  # "owner" | "member"
    created_at = Column(DateTime, default=datetime.utcnow)

    workspace = relationship("Workspace", back_populates="members")
    user = relationship("User")


class DataSource(Base):
    """
    Metadata + encrypted credentials for a connection a user has added.
    kind: "postgres" | "mysql" | "sqlserver" | "mongodb" | "supabase" | "bigquery" | "csv" | "excel"
    connection_info: non-secret fields (host, port, db name, table allowlist...
        for a database; project_id/dataset_id for the bigquery warehouse) as JSON
    encrypted_secret: encrypted connection string / password (never plaintext) -
        for bigquery this is the whole pasted service-account key JSON instead
    file_path: for uploaded csv/excel files, path on server storage
    """
    __tablename__ = "datasources"

    id = Column(String, primary_key=True, default=gen_uuid)
    owner_id = Column(String, ForeignKey("users.id"), nullable=False)
    # Which Workspace this data source (and every Project built on it, via
    # Conversation.datasource_id) belongs to - nullable because this column
    # was added after datasources already existed in production; every
    # existing row is backfilled into its owner's personal workspace by
    # database._ensure_personal_workspaces on startup, and every access
    # path treats a still-NULL row as belonging to the owner's personal
    # workspace too, so nothing is ever hidden by a missed backfill.
    workspace_id = Column(String, ForeignKey("workspaces.id"), nullable=True)
    name = Column(String, nullable=False)
    kind = Column(String, nullable=False)
    connection_info = Column(JSON, default=dict)
    encrypted_secret = Column(Text, nullable=True)
    file_path = Column(String, nullable=True)  # legacy, no longer written to
    file_data = Column(LargeBinary, nullable=True)  # uploaded csv/excel bytes, stored here so they survive redeploys
    cleaned_data = Column(LargeBinary, nullable=True)  # latest AI-prepared/cleaned snapshot, stored as CSV bytes
    cleaning_log = Column(JSON, nullable=True)  # list of {prompt, summary, rows_before, rows_after, nulls_before, nulls_after, created_at}
    cleaned_updated_at = Column(DateTime, nullable=True)
    read_only = Column(Boolean, default=True)
    schema_cache = Column(JSON, default=dict)
    created_at = Column(DateTime, default=datetime.utcnow)
    # Set the first time the old single-snapshot "cleaned_data" on this row
    # is turned into a proper "Version 1" saved table. Guards that one-time
    # move so two requests arriving at once (e.g. the data table and the
    # tab list both loading on first page view) can never both win the
    # race and create two duplicate "Version 1" tables.
    legacy_migrated_at = Column(DateTime, nullable=True)
    # 2026-09-28 (streaming/webhook ingestion round): only ever set for
    # kind == "streaming" - the per-source bearer secret an external system
    # (Zapier, a small script, another app - whatever is pushing events)
    # must send back on every POST /datasources/{id}/ingest call. Encrypted
    # at rest with the exact same security.encrypt_secret/decrypt_secret
    # helper every other kind's own credential already uses in this column
    # family (see connect_database/connect_warehouse in
    # routers/datasources.py) - a webhook secret is just as much a real
    # credential as a database password, even though it authenticates
    # INBOUND traffic rather than an outbound connection this app makes
    # itself. Regenerable (see regenerate_webhook_secret) the same way a
    # workspace's own invite_token is - if it's ever lost or leaked, a
    # fresh one invalidates the old one immediately.
    webhook_secret_encrypted = Column(Text, nullable=True)
    # Last time this source actually received a real webhook event - the
    # ONLY thing that ever advances this column (see ingest_webhook_event).
    # Drives the "live" pulsing-dot indicator on the Data Sources page
    # (shown when this is within the last few minutes) - deliberately
    # never backdated, defaulted, or simulated, so "live" only ever means a
    # real event genuinely arrived recently, never a fabricated status.
    last_event_at = Column(DateTime, nullable=True)
    # Phase 2, feature 4 (generic API/webhook PULL connector): only ever
    # set for kind == "api" - the last time a real `requests.get` against
    # this source's URL (see services/connectors.ApiConnector) actually
    # succeeded and this row's file_data/schema_cache were overwritten with
    # the fresh result - set at connect time (the first fetch IS a
    # successful refresh) and again on every manual POST
    # /datasources/{id}/api/refresh (routers/datasources.py refresh_api).
    # Deliberately never backdated/defaulted/guessed - null means "never
    # successfully fetched" and the Data Sources page says exactly that
    # rather than inventing a time. This is manual-only, on purpose - see
    # refresh_api's own docstring for why it is NOT wired into
    # services/scheduler.py's 60-second auto-refresh loop this round.
    api_last_refreshed_at = Column(DateTime, nullable=True)
    # Phase 5, Batch A (2026-09-28, data governance & quality): the last
    # time a human on this data source's team actually looked it over and
    # confirmed its access/quality is still what it should be - purely a
    # manual attestation (see routers/governance.py mark_reviewed), never
    # inferred or auto-set by anything else in the app. Both null until the
    # very first "Mark reviewed" click; governance_last_reviewed_by_id is
    # who clicked it, so the Access review table can show "Reviewed by
    # <name> <time> ago" rather than just a bare timestamp.
    governance_last_reviewed_at = Column(DateTime, nullable=True)
    governance_last_reviewed_by_id = Column(String, ForeignKey("users.id"), nullable=True)

    # foreign_keys is explicit here (not needed by any relationship above
    # this one in the file) because governance_last_reviewed_by_id, added
    # just above, is a SECOND column on this table that also points at
    # users.id - without this, SQLAlchemy can no longer tell which of the
    # two FK columns this particular relationship (the data source's real
    # owner) should join on and refuses to configure the mapper at all.
    owner = relationship("User", back_populates="datasources", foreign_keys=[owner_id])
    versions = relationship(
        "DatasetVersion", back_populates="datasource", cascade="all, delete-orphan",
        order_by="DatasetVersion.position",
    )
    streamed_events = relationship("StreamedEvent", cascade="all, delete-orphan")
    # Phase 2, feature 2 (persistent Flow-tab annotations) - see
    # FlowAnnotation's own docstring below. Cascades on delete the same way
    # streamed_events above does: an annotation only ever means anything
    # relative to a live datasource's own Flow map, so it has nothing left
    # to say once that datasource is gone.
    flow_annotations = relationship("FlowAnnotation", cascade="all, delete-orphan")
    # Phase 5, Batch A (data governance & quality): see DataQualityRule's
    # own docstring below. back_populates + cascade="all, delete-orphan"
    # mirrors `versions` above exactly - a quality rule only ever means
    # anything relative to the exact column of the exact data source it
    # checks, so deleting the data source correctly deletes every rule
    # built on it rather than leaving orphan rows behind.
    quality_rules = relationship(
        "DataQualityRule", back_populates="datasource", cascade="all, delete-orphan",
    )


class DatasetVersion(Base):
    """
    A named, saved snapshot of a datasource cleaned/prepared data.

    Every AI cleaning/preparation prompt used to silently overwrite the one
    "cleaned" snapshot a datasource could have. Instead, each prompt now
    creates a new row here - its own reusable, renameable table, like a new
    sheet - so earlier results are never lost and the person can pick any
    of them (or the untouched original data), or several of them together,
    as the starting point for the next prompt. parent_version_ids records
    every table it was built from (empty/null means the original data, or
    only the original data) purely for reference; it does not need to be
    walked to read this version, since cleaning_log already carries the
    full step-by-step history up to this point.
    """
    __tablename__ = "dataset_versions"

    id = Column(String, primary_key=True, default=gen_uuid)
    datasource_id = Column(String, ForeignKey("datasources.id"), nullable=False)
    name = Column(String, nullable=False)
    parent_version_id = Column(String, nullable=True)  # first/primary source, kept for simple display
    parent_version_ids = Column(JSON, nullable=True)  # every source table this was built from (can be several)
    data = Column(LargeBinary, nullable=False)  # CSV bytes for this snapshot
    cleaning_log = Column(JSON, nullable=True)
    position = Column(Integer, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Phase 2, feature 1 (shared, reusable models): a version is normally
    # scoped to just the one datasource it lives on - promoting it (see
    # routers/datasources.py promote_version/unpromote_version) marks it as
    # a reusable, named "model" that shows up for anyone with access to it
    # on the new /models library page (routers/models_library.py),
    # regardless of which datasource's Data tab they'd otherwise have had
    # to go find it on. is_shared_model/shared_model_description are the
    # two fields the roadmap called for; shared_model_promoted_at is one
    # small addition beyond that literal list - without it, the only
    # candidate timestamp to show as "promoted on" on a model's card would
    # be `updated_at` above, which this SAME row already reuses for a plain
    # rename or any other edit (SQLAlchemy's onupdate fires on ANY UPDATE
    # to the row, not just a promote), so it would silently start lying
    # ("promoted 2 minutes ago") the moment someone renamed an
    # already-promoted table. A dedicated, honestly-scoped timestamp - set
    # exactly once per promote, cleared on un-promote - costs one more
    # column via the same no-migration-tool _NEW_COLUMNS mechanism
    # everything else in this file already uses, and is the only way to
    # show a genuinely accurate "promoted on" date rather than an
    # approximate one that can drift for an unrelated reason.
    is_shared_model = Column(Boolean, default=False, nullable=False, server_default="false")
    shared_model_description = Column(Text, nullable=True)
    shared_model_promoted_at = Column(DateTime, nullable=True)

    datasource = relationship("DataSource", back_populates="versions")


class SavedView(Base):
    """
    A named snapshot of the Data tab's own per-viewer display state - sort,
    filters (including the values-checklist/condition filters and anything
    the natural-language filter bar built), column order/widths/hidden
    set, pinned columns, wrap-text set, per-column display format and
    conditional formatting, totals-row selection, row density, and page
    size. Everything DataTable.tsx already keeps in React state for "how
    this table currently looks/is filtered", bundled into one JSON blob so
    it can be named and come back exactly as it was, the way a saved view
    works in a spreadsheet or BI tool.

    `config` is intentionally opaque to the backend: it is whatever shape
    DataTable.tsx's own state serializes to today, and the frontend is
    free to add new fields to it later (a new pro-table feature) without
    ever needing a migration here - this table only stores and returns the
    blob, never reads inside it. Scoped to (datasource, table/version,
    owner) rather than to one conversation, since a display preference
    like "always show Sales as currency, pinned to the left" is a property
    of how a person likes to look at this table, not of any one chat about it.
    """
    __tablename__ = "saved_views"

    id = Column(String, primary_key=True, default=gen_uuid)
    datasource_id = Column(String, ForeignKey("datasources.id"), nullable=False)
    owner_id = Column(String, ForeignKey("users.id"), nullable=False)
    name = Column(String, nullable=False)
    # Which specific table this view applies to: a DatasetVersion.id for a
    # saved/AI-built table, or the original table/sheet name (None for a
    # single-table source's one and only original table). Never both -
    # exactly one of version_id/table_name is meaningful for a given row,
    # mirroring how the Data tab itself addresses "which table" everywhere
    # else (see datasources.py's preview_datasource `version_id`/`table`).
    version_id = Column(String, nullable=True)
    table_name = Column(String, nullable=True)
    config = Column(JSON, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class Folder(Base):
    """A Project (Conversation) organizer, 2026-09-23 (folders round) -
    purely a grouping label scoped to one workspace, same as Dashboard's
    own workspace_id. Deliberately NOT nullable here (unlike DataSource/
    Dashboard.workspace_id, which stayed nullable to cover rows that
    predate workspaces existing at all) - this is a brand-new table with no
    legacy rows to backfill, so every Folder is created with a real
    workspace_id from day one (see routers/folders.py create_folder,
    which always writes the caller's currently-active workspace).

    Deleting a folder never deletes the Projects inside it - see
    routers/folders.py delete_folder, which unfiles them (sets
    Conversation.folder_id back to NULL) before removing the folder row
    itself. A folder is purely an organizing label, never a container
    whose removal should take anyone's chat history down with it."""
    __tablename__ = "folders"

    id = Column(String, primary_key=True, default=gen_uuid)
    owner_id = Column(String, ForeignKey("users.id"), nullable=False)
    workspace_id = Column(String, ForeignKey("workspaces.id"), nullable=False)
    name = Column(String, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)


class Conversation(Base):
    __tablename__ = "conversations"

    id = Column(String, primary_key=True, default=gen_uuid)
    owner_id = Column(String, ForeignKey("users.id"), nullable=False)
    datasource_id = Column(String, ForeignKey("datasources.id"), nullable=True)
    title = Column(String, default="New analysis")
    created_at = Column(DateTime, default=datetime.utcnow)
    # Pinned conversations sort to the top of every "Recent conversations"
    # list (the homepage, a data source's own popup, and the Workspace
    # page's panel all read this same column) - see routers/conversations.py.
    pinned = Column(Boolean, default=False)
    # Which Folder (see above) this Project has been filed into on the
    # Projects home page - NULL means "not in any folder" (the default,
    # and also where a Project lands again if its folder is ever deleted).
    # 2026-09-23 (folders round).
    folder_id = Column(String, ForeignKey("folders.id"), nullable=True)

    owner = relationship("User", back_populates="conversations")
    messages = relationship("Message", back_populates="conversation", cascade="all, delete-orphan")


class Message(Base):
    __tablename__ = "messages"

    id = Column(String, primary_key=True, default=gen_uuid)
    conversation_id = Column(String, ForeignKey("conversations.id"), nullable=False)
    role = Column(String, nullable=False)  # user | assistant | system
    content = Column(Text, nullable=False)
    chart_spec = Column(JSON, nullable=True)
    insight = Column(Text, nullable=True)
    suggestions = Column(JSON, nullable=True)
    needs_clarification = Column(Boolean, default=False)
    # The exact python/pandas code actually run for this message (only set
    # on a successful transform/analyze assistant turn) - kept so a later
    # follow-up like "give me the python code" or "show me the code you
    # used" can be answered with the real code, instead of the AI having
    # nothing to go on and guessing at a brand-new, unrelated analysis.
    # Internal only - never returned directly by the API.
    code = Column(Text, nullable=True)
    # Which kind of turn this was (analyze | transform | clarify | explain).
    # Kept alongside code so that if the exact same question is asked again
    # later, the app can tell whether the earlier code produced a chart
    # (analyze) or a cleaned table (transform) - the two are replayed
    # differently, and guessing wrong would misuse the code. Internal only -
    # never returned directly by the API.
    action = Column(String, nullable=True)
    # The chart_type actually rendered for an analyze turn (e.g. "scatter",
    # "heatmap"). Kept alongside code/action so that replaying the exact
    # same question later reuses the same chart type too, not just the
    # same numbers - without this, the same underlying code re-run fresh
    # could independently pick a different (still valid) chart type and
    # look, to the person, like a different answer even though the number
    # behind it is identical. Internal only - never returned directly by
    # the API.
    chart_type = Column(String, nullable=True)
    # The tidy, row-level numbers this chart was actually built from (see
    # chart_builder.result_to_tidy), alongside per-column dtype/role
    # metadata - persisted so the frontend's Explore panel keeps working
    # (switch chart type/axis/filters instantly, client-side) even after
    # reopening a saved conversation, not only on the live turn that
    # produced it. None for turns whose result wasn't tabular, or that
    # predate this feature.
    result_columns = Column(JSON, nullable=True)
    result_rows = Column(JSON, nullable=True)
    result_truncated = Column(Boolean, default=False)
    # Exactly which table(s) this turn ran against, in the order they were
    # selected - a list of small dicts, one per source: {"kind": "original"
    # | "sheet" | "version", "label": the human-readable name shown at the
    # time (e.g. "Original data", "SalesDB — Customers", "Cleaned Orders"),
    # "datasource_id": which datasource that source belongs to (this one,
    # or another separately-connected one pulled in via "+ Add more data"),
    # "version_id": the DatasetVersion id when kind == "version", else
    # null, "sheet": the sheet name when kind == "sheet", else null}. This
    # is the one place the app records "this chart/table was built FROM
    # these tables" precisely enough to draw an accurate lineage diagram
    # later (see routers/datasources.py get_data_flow) - parent_version_id
    # on DatasetVersion alone cannot do this, since it only chains one
    # saved table to another and has no way to represent "built from the
    # untouched original data" or "merged in a table from a different,
    # separately-connected data source". None for turns saved before this
    # column existed, and for turns with nothing to record (e.g. a
    # clarifying question never loaded any table).
    sources = Column(JSON, nullable=True)
    # The DatasetVersion this turn's own cleaning/prep work created, if
    # any (both a "transform" and an "analyze" that had to prepare its own
    # table first can create one - see ai_engine._run_analyze_with_prep).
    # Kept as a plain id (not a ForeignKey) for the same "simple display,
    # not a hard reference" reason DatasetVersion.parent_version_id
    # already is - this is what lets the lineage diagram draw "this
    # question produced that exact table" without re-deriving it.
    new_version_id = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    # How many times "Double-check this" has been run on this message (see
    # routers/chat.py verify_message, which increments this on every
    # completed audit regardless of whether it found anything to correct).
    # Only ever set on an assistant analyze/transform turn - the thing being
    # measured is real trust-feature usage for the admin dashboard, not
    # anything shown back to the person who owns the message.
    verified_count = Column(Integer, default=0)

    conversation = relationship("Conversation", back_populates="messages")


class GokuMessage(Base):
    """
    Goku is the guided, beginner-friendly AI helper that lives only inside
    the Workspace page (never the main Ask GD360 analysis chat, and never
    anywhere else in the app). Its one job is to help someone who may have
    zero data-analytics background go from "I have this data" to the
    result they actually want, by explaining - in plain language, one
    concrete step at a time - what to do next, and handing them a
    ready-to-run question for the main analysis chat when that helps. Goku
    never runs code or computes anything itself - see
    services/ai_engine.py goku_chat for exactly what it is given and how
    it decides what to say.

    There is only ever ONE Goku conversation per (datasource, owner) -
    unlike the main analysis chat, which can have several separate
    conversations for the same data source, Goku always picks back up
    exactly where the person left off on a given data source.
    """
    __tablename__ = "goku_messages"

    id = Column(String, primary_key=True, default=gen_uuid)
    datasource_id = Column(String, ForeignKey("datasources.id"), nullable=False)
    owner_id = Column(String, ForeignKey("users.id"), nullable=False)
    role = Column(String, nullable=False)  # user | assistant
    content = Column(Text, nullable=False)
    # 0-4 ready-to-run suggestions Goku is offering right now, each shaped
    # like {"label": short button text, "prompt": the exact question to
    # send to the main Ask GD360 chat} - only ever set on an assistant
    # message, null otherwise.
    action_prompts = Column(JSON, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class Dashboard(Base):
    """
    A named, shareable dashboard.

    owner_id is always who CREATED this dashboard - that never changes.
    workspace_id (added 2026-09-23, shared dashboards v1) is optional and
    separate: NULL keeps a dashboard exactly as it always worked, visible
    and editable only by its creator; set, it shares the whole dashboard
    with every member of that workspace on the same view/editable split
    used everywhere else a workspace shares something (see
    routers/dashboards.py for the exact rule) - so a team can build one
    curated set of charts together instead of everyone re-saving the same
    numbers into their own private dashboard.

    layout_version (2026-09-24, Dashboard Builder Phase 1) distinguishes
    the two shapes a Dashboard row can have, so the two live side by side
    without a disruptive migration:
      - 1 (the default, every pre-existing row): the original flat model -
        a plain, ordered list of SavedChart snapshots, no pages, no
        publishing. routers/dashboards.py and DashboardView.tsx keep
        working on these completely unchanged.
      - 2: the new model - one or more DashboardPage rows, each holding
        its own laid-out DashboardBlock grid, and an optional DashboardShare
        for publishing. Built by routers/dashboard_builder.py and rendered
        by DashboardBuilderView.tsx / the public viewer. A v2 dashboard's
        `charts` list is always empty; a v1 dashboard's `pages` list is
        always empty - the two are never mixed on the same row.
    source_conversation_id records which chat analysis a v2 dashboard was
    generated from, purely for reference (e.g. "Built from: <title>" in the
    UI) - never required, since every block's own config is self-contained.

    Round 4 (2026-09-25, branding/customization) columns are all optional
    and only meaningful on a layout_version==2 dashboard, same as pages/
    share above: brand_primary_color/brand_accent_color are hex strings
    ("#2a78d6") that override this dashboard's --color-primary/--color-
    accent CSS tokens wherever it's rendered (owner editor, preview, and
    the public viewer alike - see routers/dashboard_builder.py's
    _hex_color_or_none and the frontend's hexToRgbTriple). background_style
    is "default" (the app's normal surface, the same as before this round
    existed), "color" (background_color, same hex-string convention), or
    "image" (background_image below); NULL behaves exactly like "default"
    so every pre-existing row needs no backfill. logo_image/background_image
    are raw image bytes stored directly in this table - same reasoning as
    DataSource.file_data (see that model's own comment): Render's web
    services have ephemeral local disks that reset on every deploy, so
    anything saved to local disk would silently vanish on the next deploy;
    Postgres is the only durable place to put it. *_content_type is
    whichever of image/png, image/jpeg, image/webp was actually uploaded
    (validated in _read_and_validate_image - deliberately NOT image/svg+xml,
    which can carry embedded script) so the serving endpoints can send back
    the right Content-Type instead of guessing. Branding images are served
    to the public viewer whenever this dashboard's share is currently
    published, with no email/password gate even on a private share (see
    _resolve_dashboard_for_public_branding's own comment) - purely
    cosmetic, non-sensitive assets, deliberately kept simple rather than
    threaded through the viewer-token machinery real dashboard content
    uses.
    """
    __tablename__ = "dashboards"

    id = Column(String, primary_key=True, default=gen_uuid)
    owner_id = Column(String, ForeignKey("users.id"), nullable=False)
    workspace_id = Column(String, ForeignKey("workspaces.id"), nullable=True)
    name = Column(String, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    layout_version = Column(Integer, default=1, nullable=False, server_default="1")
    source_conversation_id = Column(String, ForeignKey("conversations.id"), nullable=True)
    brand_primary_color = Column(String, nullable=True)
    brand_accent_color = Column(String, nullable=True)
    background_style = Column(String, nullable=True)  # "default" | "color" | "image"
    background_color = Column(String, nullable=True)
    logo_image = Column(LargeBinary, nullable=True)
    logo_image_content_type = Column(String, nullable=True)
    background_image = Column(LargeBinary, nullable=True)
    background_image_content_type = Column(String, nullable=True)

    # 2026-09-28 (scheduled auto-refresh round): optional automatic refresh
    # for a layout_version==2 (Dashboard Builder) dashboard - see
    # services/scheduler.py's own module docstring for the full design and
    # services/scheduler.refresh_dashboard for what actually happens on a
    # refresh. Chosen at the DASHBOARD level rather than per-block: every
    # block on a dashboard is already built against the exact same one
    # data source (see _resolve_datasource in routers/dashboard_builder.py -
    # a dashboard has no notion of "this block's data comes from somewhere
    # else"), so "refresh this dashboard" and "recompute every block on it
    # that can be safely recomputed unattended" are the same real-world
    # action a person would actually ask for. A per-block schedule would
    # only mean picking the same interval over and over, block by block,
    # for zero real benefit, while multiplying how many rows the 60-second
    # tick has to scan every minute. refresh_interval is None ("off" - the
    # value on every pre-existing row, since this feature never existed
    # before this round) or one of "15m" | "1h" | "6h" | "daily".
    refresh_interval = Column(String, nullable=True)
    # When the next scheduled refresh is due - recomputed every time this
    # dashboard actually finishes a refresh (see services/scheduler.py
    # compute_next_refresh_at), always measured from that real completion
    # time, not from whenever someone happened to change the interval - so
    # switching from "1h" to "6h" right after a refresh waits the full new
    # 6 hours from that refresh, never less. NULL whenever refresh_interval
    # is NULL (no schedule set at all).
    next_refresh_at = Column(DateTime, nullable=True)
    # When a refresh (scheduled OR a manual "Run now" click) last actually
    # completed for this dashboard - the Jobs page's own "Last run" column.
    # Distinct from any one block's DashboardBlock.data_updated_at above -
    # this is the dashboard-level rollup, set once per refresh run
    # regardless of how many (or which) of its blocks were actually
    # recomputed that time.
    last_refreshed_at = Column(DateTime, nullable=True)

    owner = relationship("User", back_populates="dashboards")
    charts = relationship("SavedChart", back_populates="dashboard", cascade="all, delete-orphan")
    pages = relationship(
        "DashboardPage", back_populates="dashboard", cascade="all, delete-orphan",
        order_by="DashboardPage.position",
    )
    share = relationship(
        "DashboardShare", back_populates="dashboard", uselist=False, cascade="all, delete-orphan",
    )


class SavedChart(Base):
    __tablename__ = "saved_charts"

    id = Column(String, primary_key=True, default=gen_uuid)
    dashboard_id = Column(String, ForeignKey("dashboards.id"), nullable=False)
    title = Column(String, nullable=False)
    chart_spec = Column(JSON, nullable=False)
    insight = Column(Text, nullable=True)
    position = Column(Integer, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)

    dashboard = relationship("Dashboard", back_populates="charts")


class DashboardPage(Base):
    """One page (tab) of a layout_version=2 Dashboard - see Dashboard's own
    docstring. Phase 1 only ever created a single page per dashboard
    ("Overview"); Phase 3 (2026-09-24) adds add/rename/reorder/duplicate/
    delete through routers/dashboard_builder.py's page endpoints - this
    model itself needed no schema change for that, since `position` (the
    ordering) and multi-page support were already here from the start.

    background_color (2026-09-25, Round 4 branding) is this one page's own
    override of the dashboard-level background - a hex string, or NULL to
    just inherit whatever the parent Dashboard's background_style/
    background_color/background_image says. Deliberately color-only (no
    per-page image) to keep this round's scope bounded: a per-page tint is
    enough to tell pages apart at a glance without a second image-upload
    surface per page."""
    __tablename__ = "dashboard_pages"

    id = Column(String, primary_key=True, default=gen_uuid)
    dashboard_id = Column(String, ForeignKey("dashboards.id"), nullable=False)
    name = Column(String, nullable=False, default="Overview")
    position = Column(Integer, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)
    background_color = Column(String, nullable=True)

    dashboard = relationship("Dashboard", back_populates="pages")
    blocks = relationship(
        "DashboardBlock", back_populates="page", cascade="all, delete-orphan",
        order_by="DashboardBlock.position",
    )


class DashboardBlock(Base):
    """One tile on a DashboardPage's grid.

    type: "chart" | "table" | "kpi" | "text" | "filter" | "gauge" | "donut"
    | "sparkline" | "avatar_list" - see routers/dashboard_builder.py for
    exactly what `config` holds for each (a Plotly chart_spec for "chart",
    {columns, rows} for "table", {value, label} for "kpi", {text} for
    "text", {column} for "filter"; the four Round 3 (2026-09-25) native
    widget types are {value, min, max, target, label} for "gauge", {items:
    [{label, value}]} for "donut", {value, series, categories, delta_pct}
    for "sparkline", and {items: [{rank, name, value}]} for "avatar_list" -
    all four are plain, hand-built React components, not a relabeled
    chart_spec, and are only ever produced by build_manual_block, never
    the AI paths - see that file's own module docstring for why).
    x/y/w/h place this block on a 12-column grid, in grid units (not
    pixels) - the same coordinate system PowerBI/Hex-style canvases use, so
    Phase 2's drag/resize editor can read and write these directly with no
    schema change."""
    __tablename__ = "dashboard_blocks"

    id = Column(String, primary_key=True, default=gen_uuid)
    page_id = Column(String, ForeignKey("dashboard_pages.id"), nullable=False)
    type = Column(String, nullable=False)
    title = Column(String, nullable=True)
    x = Column(Integer, default=0, nullable=False)
    y = Column(Integer, default=0, nullable=False)
    w = Column(Integer, default=6, nullable=False)
    h = Column(Integer, default=4, nullable=False)
    config = Column(JSON, nullable=False, default=dict)
    position = Column(Integer, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)
    # 2026-09-25g (live-data freshness round): when this block's DATA was
    # last actually (re)computed - set at creation, then explicitly
    # advanced only by the code paths that recompute real content
    # (ask_ai_block, build_manual_block, and update_block's `config` field,
    # which also covers a text block's own body / a filter block's column)
    # - see routers/dashboard_builder.py for exactly where. Deliberately
    # NOT a SQLAlchemy onupdate=datetime.utcnow on this column: that would
    # fire on every UPDATE of this row for ANY reason, including a plain
    # drag/resize/rename via update_block's x/y/w/h/title fields - which
    # would make "data last updated" silently lie every time someone just
    # repositions a tile. restyle_block deliberately does not touch this
    # either - restyling only changes chart TYPE, never the underlying
    # numbers (see that endpoint's own docstring). The frontend's
    # DataFreshnessBadge (components/DashboardBlocks.tsx) reads this to
    # show a real, honest "Data updated Xm ago" - never a fabricated or
    # simulated "live" signal, since this app has no auto-refreshing data
    # pipeline; a block's numbers only change when someone rebuilds them.
    data_updated_at = Column(DateTime, default=datetime.utcnow)

    page = relationship("DashboardPage", back_populates="blocks")


class DashboardShare(Base):
    """Publish settings for a layout_version=2 Dashboard - at most one row
    per dashboard. published_at is the on/off switch: a share row can
    exist (holding a stable slug) while unpublished (published_at NULL),
    so publishing and unpublishing never change the dashboard's URL.

    mode: "public" (anyone with the link, no login) or "private" (2026-
    09-24, Phase 3 - named emails + optional shared password, see
    DashboardShareEmail below and routers/dashboard_builder.py's own
    module docstring for the full access-check design). password_hash is
    only ever read when mode=="private" - bcrypt via security.hash_password/
    verify_password, same as a real account password, never stored or
    compared in plaintext. A private share with password_hash NULL means
    "email only, no password" - a deliberately allowed configuration, not
    a bug: the email allow-list is itself the access control.

    custom_domain* (2026-09-24, Phase 4 - white-label): an alternate way
    to reach this SAME published share (public or private - the domain
    doesn't change which mode it's in, just how it's reached) through a
    dashboard owner's own domain instead of this app's own /d/{slug}
    link. See services/render_domains.py for how this backend actually
    registers/checks/removes the domain with Render, and
    routers/dashboard_builder.py's module docstring (Phase 4 section) for
    the full design. custom_domain is kept globally unique at the
    APPLICATION level (checked explicitly in set_custom_domain, the same
    pattern _make_unique_slug already uses for `slug` above) rather than
    a real database UNIQUE constraint - this column was added to an
    already-live table via the no-migration-tool _NEW_COLUMNS pattern
    (see database.py), which can add a plain column but not a new index/
    constraint on one. custom_domain_status is one of "pending_dns"
    (Render hasn't verified the owner's DNS record yet), "pending_ssl"
    (DNS verified, certificate still being issued), or "live" (verified
    AND HTTPS is actually being served for it) - NULL means no custom
    domain has ever been attached. custom_domain_error holds the last
    error message from Render, if any, purely for display in the owner's
    publish panel."""
    __tablename__ = "dashboard_shares"

    id = Column(String, primary_key=True, default=gen_uuid)
    dashboard_id = Column(String, ForeignKey("dashboards.id"), nullable=False, unique=True)
    slug = Column(String, nullable=False, unique=True, index=True)
    mode = Column(String, nullable=False, default="public")
    password_hash = Column(String, nullable=True)
    published_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    custom_domain = Column(String, nullable=True, index=True)
    render_custom_domain_id = Column(String, nullable=True)
    custom_domain_status = Column(String, nullable=True)
    custom_domain_error = Column(String, nullable=True)

    dashboard = relationship("Dashboard", back_populates="share")
    allowed_emails = relationship(
        "DashboardShareEmail", back_populates="share", cascade="all, delete-orphan",
    )


class DashboardShareEmail(Base):
    """One named person allowed to open a "private" DashboardShare - see
    its own docstring. Deleting this row revokes that specific person's
    access immediately: routers/dashboard_builder.py's get_public_dashboard
    re-checks this table against the viewer's token on EVERY request (not
    just at the moment they first entered their email/password), so a
    revoke here takes effect on that person's very next page load, not
    only once whatever short-lived viewer token they already have expires.
    A dashboard can have several of these; there is deliberately no cap
    matching a real "team-sized" access list (a few dozen names at most in
    practice), so none is enforced here."""
    __tablename__ = "dashboard_share_emails"

    id = Column(String, primary_key=True, default=gen_uuid)
    share_id = Column(String, ForeignKey("dashboard_shares.id"), nullable=False)
    email = Column(String, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    share = relationship("DashboardShare", back_populates="allowed_emails")


class PushdownQueryLog(Base):
    """
    Enterprise Scale Roadmap, Phase 2: an audit trail of every governed SQL
    query GD360 has run directly inside a customer's own warehouse (see
    services/connectors.py BigQueryConnector.run_pushdown_query, and the
    same pattern any future warehouse connector - Snowflake, Databricks,
    Redshift - will follow). One row per attempt that actually produced a
    real SQL query, success or not, so there is always a real record of
    what SQL ran against a customer's data, when, whether it was allowed
    to run, and roughly what it cost - the kind of audit log an enterprise
    security review expects to see.

    Also doubles as the source of truth for the per-user daily pushdown
    cost budget (see routers/chat.py _todays_pushdown_bytes) - summing
    bytes_scanned for "ok" rows since midnight needs no separate
    running-totals table to keep in sync.
    """
    __tablename__ = "pushdown_query_logs"

    id = Column(String, primary_key=True, default=gen_uuid)
    owner_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    datasource_id = Column(String, ForeignKey("datasources.id"), nullable=False, index=True)
    # "bigquery" today; "snowflake" | "databricks" | "redshift" once those
    # connectors exist - this table's shape does not need to change then.
    provider = Column(String, nullable=False)
    sql_text = Column(Text, nullable=False)
    # What the warehouse's own dry run estimated this query would scan, in
    # bytes. Null when a dry run never ran (e.g. rejected by the daily
    # budget check, or by the read-only safety check, before that point).
    bytes_scanned = Column(BigInteger, nullable=True)
    # "ok" | "rejected_unsafe" | "rejected_too_expensive" | "rejected_daily_budget" | "error"
    status = Column(String, nullable=False)
    error_message = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)


class LearnedAnswer(Base):
    """
    2026-09-22: the app's permanent, growing memory of exactly-correct
    answers. Whenever a real question (action "analyze" or "transform" -
    never a clarifying question) is answered successfully, the exact
    question text together with a fingerprint of the exact table/column
    shape it ran against is remembered alongside the exact pandas code
    that produced it (see services/learned_answers.py). The next time -
    even in a brand new conversation, even weeks later - that SAME person
    asks that SAME question against a still-matching schema, the app
    replays this already-proven code directly instead of asking the AI to
    write it again: instant, free, and just as correct as the first time,
    since the code runs fresh against whatever the data actually is right
    now rather than replaying a stored answer. This is what "the app
    learns and gets faster over time" honestly means here - not a custom-
    trained model (a much bigger, different undertaking - see the
    services/learned_answers.py module docstring), but a durable version
    of the exact-repeat shortcut ai_engine._find_repeated_prompt_code
    already does within a single conversation from chat history alone.

    Deliberately scoped to one owner_id - never shared across different
    people's accounts, even if two unrelated schemas happen to look
    identical - so this can never blur one customer's naming/structure
    into another's results. A schema change (a column renamed, added,
    removed, or retyped) simply produces a different schema_fingerprint,
    so an old row for the previous shape is just never looked up again -
    nothing here needs to be actively invalidated, and nothing here can
    silently go stale and return a wrong answer for a changed dataset.
    """
    __tablename__ = "learned_answers"
    __table_args__ = (
        UniqueConstraint("owner_id", "schema_fingerprint", "normalized_prompt", name="uq_learned_answer_key"),
        Index("ix_learned_answer_lookup", "owner_id", "schema_fingerprint", "normalized_prompt"),
    )

    id = Column(String, primary_key=True, default=gen_uuid)
    owner_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    # sha256 of the exact table name(s) + column name(s) + dtype(s) this
    # question ran against, in selection order - see
    # services/learned_answers.schema_fingerprint for exactly how this is
    # built and why it is what keeps a stored answer schema-safe.
    schema_fingerprint = Column(String, nullable=False)
    # Whitespace/case-normalized prompt text - see
    # services/learned_answers.normalize_prompt.
    normalized_prompt = Column(String, nullable=False)
    action = Column(String, nullable=False)  # "analyze" | "transform"
    narrative = Column(Text, nullable=True)
    code = Column(Text, nullable=False)
    chart_type = Column(String, nullable=True)
    # How many times this exact memory has been replayed since it was
    # first learned - purely informational (worth surfacing on an admin/
    # usage view later as "questions answered from memory"), not read by
    # any lookup/eviction logic itself.
    hit_count = Column(Integer, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)
    last_used_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, index=True)


class JobRun(Base):
    """One execution record of a background dashboard-refresh job - the
    Jobs page's entire run history (2026-09-28). Logged for both a
    scheduled tick (services/scheduler.py's 60-second loop) and an
    on-demand "Run now" click (routers/jobs.py run_now) through the exact
    same services.scheduler.refresh_dashboard function, so a row here
    always reflects something that genuinely ran against real data - never
    a simulated or sampled event.

    job_type is "scheduled_refresh" | "manual_refresh" - which of the two
    triggered this run. target_label/source_label are the dashboard's name
    and its data source's name AT THE TIME this ran, denormalized on
    purpose: a dashboard (or its data source) can be renamed or deleted
    later, and a job history entry should still read sensibly then, not
    show a blank or a dangling id. status starts as "running" the moment
    this row is created (before anything else happens - see
    refresh_dashboard), so a process crash mid-run still leaves an honest
    "running" row behind rather than no record at all, and settles to
    "success" or "failed" once the run actually finishes. error_message is
    only ever set on "failed". next_run_at snapshots what
    Dashboard.next_refresh_at was recomputed to right after this run,
    purely so the Jobs page can show "Next run: ..." on each history row
    without a second query back to the live Dashboard.

    dashboard_id is nullable (not NOT NULL) in case a dashboard is deleted
    after being refreshed - the run history for it is kept rather than
    cascading away, since "what happened, and when" stays true even after
    the thing it happened to is gone; a deleted dashboard's rows just stop
    being reachable through the Jobs page's own per-dashboard listing
    (which resolves visibility through the live Dashboard row) and only
    ever showed up there historically through target_label anyway."""
    __tablename__ = "job_runs"

    id = Column(String, primary_key=True, default=gen_uuid)
    dashboard_id = Column(String, ForeignKey("dashboards.id"), nullable=True, index=True)
    owner_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    job_type = Column(String, nullable=False)  # "scheduled_refresh" | "manual_refresh"
    target_label = Column(String, nullable=False)
    source_label = Column(String, nullable=True)
    status = Column(String, nullable=False, default="running")  # "running" | "success" | "failed"
    error_message = Column(Text, nullable=True)
    started_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    finished_at = Column(DateTime, nullable=True)
    next_run_at = Column(DateTime, nullable=True)

    @property
    def duration_seconds(self) -> float | None:
        """None while status=="running" (finished_at not set yet) - the
        Jobs page shows a live spinner instead of a duration for those
        rows rather than a fabricated 0.0s."""
        if self.finished_at is None:
            return None
        return (self.finished_at - self.started_at).total_seconds()


class StreamedEvent(Base):
    """One inbound batch received by a "streaming" DataSource's webhook
    ingestion endpoint (routers/datasources.py ingest_webhook_event,
    2026-09-28). See DataSource.kind == "streaming" and that endpoint's own
    docstring for the full design and why this is a real, honestly-scoped
    webhook buffer rather than a fake Kafka/message-broker integration -
    there is no message-queue infrastructure behind this, just an
    authenticated HTTP endpoint appending rows to this table.

    `payload` is the exact JSON array of row objects the caller posted,
    stored as-is - never reshaped, typed, or validated against a fixed
    schema, since a streaming source has no fixed columns the way a
    connected database does (whatever is pushing events is free to send
    whatever shape it wants, and may change shape over time). `row_count`
    is len(payload) at receipt time, kept alongside it purely so a listing
    of recent events can show "42 rows" without re-parsing the JSON blob
    every time. This is a plain, append-only log for now - a live "N events
    received" / "is this source live" signal - not yet wired into the
    chat/analysis pipeline as a queryable table; doing that honestly (a
    real schema, a real load path in services/data_loader.py) is a
    separate, larger piece of future work, not something to silently fake
    here."""
    __tablename__ = "streamed_events"

    id = Column(String, primary_key=True, default=gen_uuid)
    datasource_id = Column(String, ForeignKey("datasources.id"), nullable=False, index=True)
    payload = Column(JSON, nullable=False)
    row_count = Column(Integer, default=0, nullable=False)
    received_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)


class FlowAnnotation(Base):
    """One user-set override for exactly one card on one datasource's Flow
    tab (Phase 2, feature 2) - a business-friendly display name, a free-text
    description, and/or a manually-dragged layout position, persisted so it
    survives leaving and reopening the tab, unlike today's Flow map (see
    routers/datasources.py get_data_flow / components/DataFlowMap.tsx),
    which recomputes its whole graph fresh on every load with no memory of
    anything a person set on it before.

    `node_key` is deliberately a plain string, not a second foreign key
    pointing at one specific table - a Flow-tab card is one of two
    genuinely different kinds of thing (see lib/flowGraph.ts's own
    FlowCardKind): a saved/prepared TABLE, identified by its real
    DatasetVersion.id, or a CHART/analysis card, identified by the
    Message.id of the assistant turn that produced it. Reusing whichever id
    already, uniquely identifies that exact node elsewhere in this app -
    rather than inventing a third, parallel id scheme just for annotations -
    is what lets get_data_flow embed these fields directly onto the
    existing version/node entries it already returns (see that endpoint),
    with nothing extra for the frontend to join client-side. A node_key is
    NOT itself a foreign key to dataset_versions/messages: a version or
    message can be deleted (see delete_version) without this app needing to
    also go hunt down and delete any annotation that happened to reference
    it - an orphaned annotation for an id that no longer appears in a given
    /flow response is simply never read back, exactly like a SavedView
    scoped to a table that no longer exists.

    One row per (datasource_id, node_key) - enforced by the unique
    constraint below - upserted in place by
    PATCH /datasources/{id}/flow/annotations/{node_key} rather than ever
    accumulating a history of edits, since only the CURRENT label/
    description/position is ever meaningful here, the same "just store and
    return the latest state" contract models.SavedView.config already
    follows for a different per-viewer... except this one is shared team-
    wide the moment the datasource itself is (editable tier - see
    _get_editable_datasource), matching how a saved table's own name is a
    shared, collaborative fact about the data, not a private display
    preference.

    position_x/position_y are NULL until someone in Edit mode actually
    drags that card - null means "let the existing dagre auto-layout
    (lib/flowGraph.ts layoutNodes) keep deciding, exactly as it does today
    for everyone who never opens Edit mode", never a fabricated (0, 0)
    default that would silently stack every unedited card on top of each
    other."""
    __tablename__ = "flow_annotations"
    __table_args__ = (UniqueConstraint("datasource_id", "node_key", name="uq_flow_annotation_node"),)

    id = Column(String, primary_key=True, default=gen_uuid)
    datasource_id = Column(String, ForeignKey("datasources.id"), nullable=False, index=True)
    node_key = Column(String, nullable=False)
    display_label = Column(String, nullable=True)
    description = Column(Text, nullable=True)
    position_x = Column(Float, nullable=True)
    position_y = Column(Float, nullable=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class Experiment(Base):
    """
    Phase 4 (2026-09-28, "Replacing the Data Team" roadmap - "A/B test
    design, assignment, and tracking"): one running (or stopped) A/B test a
    founder designs and runs from GD360 itself, rather than the earlier
    "analyze a test already run elsewhere" workflow. Created by the
    3-step wizard (metric -> variants -> launch - see
    routers/experiments.py create_experiment) already fully "running" the
    moment it's created; the wizard has no separate "save as draft, launch
    later" step, so there is no draft state to model here at all.

    owner_id/workspace_id follow the EXACT same split as DataSource.owner_id/
    workspace_id and Dashboard.owner_id/workspace_id above: owner_id is
    always who created this experiment, and never changes; workspace_id is a
    SEPARATE, later, deliberate act that shares a whole row with a team, the
    same way a brand-new DataSource or Dashboard stays personal-only until
    someone explicitly shares it. This phase's router creates every
    Experiment with workspace_id=None and builds NO endpoint that ever sets
    it to anything else - sharing an experiment into a workspace is real,
    plausible future work (Phase 5+), but it is a genuinely separate feature
    (who can see/edit it, what "editable" should mean for a live test) and
    is deliberately left unbuilt here rather than bolted on as a side effect
    of creation.

    public_key exists as a SEPARATE, purpose-built random field from `id`
    for one specific reason: it is meant to be pasted directly into
    client-side JavaScript on the founder's OWN external website (see
    routers/experiments.py's module docstring for the full public
    assign/convert security model), where literally any visitor can read it
    straight out of the page's own source or network requests. `id` is what
    every one of this app's own AUTHENTICATED UI URLs and API calls already
    use to address this exact row - reusing that same string as the
    public, visitor-facing identifier would mean an internal id and a
    stranger-facing one are permanently the same value, with no way to ever
    treat the public one as separately rotatable/revocable (e.g. "reissue a
    fresh embed snippet without disturbing the row's own identity")
    without a bigger change later. Splitting them from day one costs one
    extra column now and avoids ever needing that split retrofitted under
    live traffic. It is stored in PLAINTEXT, on purpose - it is not a
    credential the way DataSource.encrypted_secret/webhook_secret_encrypted
    are (see that model's own comment): it is functionally an unguessable
    public id embedded in a public web page, not a secret whose disclosure
    would expose anything beyond what a visitor to the founder's own site
    can already see in their browser's network tab. Regenerated never (this
    phase builds no "rotate" endpoint - a founder who needs a fresh one
    today would delete and recreate the experiment, same as this phase's
    scope for everything else).
    """
    __tablename__ = "experiments"

    id = Column(String, primary_key=True, default=gen_uuid)
    owner_id = Column(String, ForeignKey("users.id"), nullable=False)
    workspace_id = Column(String, ForeignKey("workspaces.id"), nullable=True)
    name = Column(String, nullable=False)
    metric_name = Column(String, nullable=False)
    variant_a_name = Column(String, nullable=False, default="Control")
    variant_b_name = Column(String, nullable=False, default="Treatment")
    public_key = Column(String, unique=True, index=True, nullable=False, default=lambda: secrets.token_urlsafe(24))
    status = Column(String, nullable=False, default="running")  # "running" | "stopped" - see this class's own docstring for why there is no "draft"
    created_at = Column(DateTime, default=datetime.utcnow)
    started_at = Column(DateTime, default=datetime.utcnow)
    stopped_at = Column(DateTime, nullable=True)

    assignments = relationship("ExperimentAssignment", cascade="all, delete-orphan")


class ExperimentAssignment(Base):
    """
    One visitor's sticky variant assignment for one Experiment (Phase 4) -
    see routers/experiments.py's public assign/convert endpoints for
    exactly how a row here is created and read, and for the deterministic
    sha256-hash-based 50/50 split that decides `variant`.

    subject_id is whatever identifier the founder's OWN external website
    already uses to recognize that one visitor across page loads (a cookie/
    localStorage id, a logged-in customer id - anything stable) - this app
    never issues or generates one itself, and never learns anything about
    who that visitor actually is beyond this opaque, caller-supplied
    string. `variant` is always the literal "a" or "b", never the display
    name copied from Experiment.variant_a_name/variant_b_name - resolving
    to a display name always happens at READ time, by joining back to the
    parent Experiment, so nothing here ever needs to be updated in bulk if
    those names were ever changed later.

    converted_at is set exactly once, on the FIRST successful convert call
    for this subject_id - see routers/experiments.py's convert_subject for
    why every call after that is a harmless, deliberately silent no-op
    (still 200 OK) rather than an error or a second row: a duplicate
    conversion-pixel fire from a flaky connection, a page reload, or a
    double click on the founder's own site must never inflate the
    conversion count for either variant.
    """
    __tablename__ = "experiment_assignments"
    __table_args__ = (UniqueConstraint("experiment_id", "subject_id", name="uq_experiment_subject"),)

    id = Column(String, primary_key=True, default=gen_uuid)
    experiment_id = Column(String, ForeignKey("experiments.id"), nullable=False, index=True)
    subject_id = Column(String, nullable=False)
    variant = Column(String, nullable=False)  # "a" | "b"
    assigned_at = Column(DateTime, default=datetime.utcnow)
    converted_at = Column(DateTime, nullable=True)


class DataQualityRule(Base):
    """
    Phase 5, Batch A (2026-09-28, "Data governance & quality" roadmap): one
    automated check a person has set up on one column of one connected data
    source - "this column should never be blank", "these values should be
    unique", "this number should be at least/at most X", "only these exact
    values are allowed here". Modeled closely on Experiment above: created
    already "live" (routers/quality_checks.py runs it once, immediately, at
    creation time - there is no separate "save a rule, run it later" step),
    and re-run either on demand (the panel's own "Run now" button) or right
    after creation, never on a background schedule this round - see
    services/quality_checks.run_quality_rule for exactly how a rule is
    evaluated.

    rule_type is one of "not_null" (no blank/NaN values), "unique" (no
    duplicate values), "min_value"/"max_value" (every numeric value is at
    least/at most a threshold - non-numeric/blank cells are never counted
    as failing THESE, only "not_null" is about blankness), or
    "allowed_values" (every value must be one of an explicit list; a blank
    value always fails this one, since NULL is never itself one of the
    allowed values). rule_config holds whatever that rule_type needs -
    {} for not_null/unique, {"min": <number>} for min_value, {"max":
    <number>} for max_value, {"values": [...]} for allowed_values - kept as
    one loosely-typed JSON blob (like DashboardBlock.config) rather than
    five mostly-empty dedicated columns, since only one shape is ever
    meaningful for a given row.

    The last_* columns are this rule's most recently computed result,
    always all written together in the same evaluation (see
    run_quality_rule) so they can never show a stale mix of numbers from
    two different runs - last_status is "pass" | "fail" | "error" | None
    (never run - not possible in practice today, since creation always runs
    it once immediately, but modeled as nullable for a rule that somehow
    never got its first run). last_message is a short, human-readable
    summary ("42 of 1,203 rows failed", "All rows passed", or an honest
    explanation of why the check couldn't run, e.g. a since-renamed
    column) - NEVER a fabricated or guessed number, only ever set from a
    real value the last run actually computed against the real data.

    owner_id is whoever created the rule - kept distinct from
    datasource_id's own owner (a workspace member with edit access can
    create a rule on a teammate's shared data source) purely for
    attribution, the same reasoning SavedView.owner_id already follows.
    """
    __tablename__ = "data_quality_rules"

    id = Column(String, primary_key=True, default=gen_uuid)
    datasource_id = Column(String, ForeignKey("datasources.id"), nullable=False, index=True)
    owner_id = Column(String, ForeignKey("users.id"), nullable=False)
    column_name = Column(String, nullable=False)
    rule_type = Column(String, nullable=False)  # not_null | unique | min_value | max_value | allowed_values
    rule_config = Column(JSON, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    last_run_at = Column(DateTime, nullable=True)
    last_status = Column(String, nullable=True)  # "pass" | "fail" | "error" | None
    last_checked_row_count = Column(Integer, nullable=True)
    last_failing_row_count = Column(Integer, nullable=True)
    last_message = Column(String, nullable=True)

    datasource = relationship("DataSource", back_populates="quality_rules")


class AuditEvent(Base):
    """
    Phase 5, Batch A (2026-09-28, "Data governance & quality" roadmap): a
    real, PERSISTED action log - one row per significant thing someone did
    (signed up, logged in, created a workspace, changed a teammate's role,
    joined via an invite link, connected/removed a data source, created/
    deleted a dashboard, added/removed a quality check, marked a data
    source reviewed). This is genuinely NOT the same thing as /admin's
    "Recent activity" feed (routers/admin.py get_activity_feed,
    AdminDashboard.tsx) - that feed is GD360-STAFF-ONLY, platform-wide
    across every customer's account, and computed LIVE on every request by
    querying a handful of other tables (users/datasources/dashboards) for
    their own timestamps; it stores nothing of its own and has no idea
    which workspace anything happened in or who else was affected. This
    table is the opposite on every one of those points: written once, at
    the moment the action happens (see services/audit.log_audit_event),
    scoped to a specific workspace's own governance page
    (routers/governance.py's audit-log endpoint, owner-only), and durable -
    it is the actual source of truth a workspace owner's audit log reads
    from, not a live re-computation.

    workspace_id is nullable because not every audited action has one yet
    (a brand-new signup's own personal workspace is attached at signup,
    but there's nothing that stops a future audited action from being
    genuinely workspace-less) - the governance page's own audit-log query
    filters on a real workspace_id, so a null-workspace event simply never
    shows up on any one workspace's own log. actor_user_id is who DID the
    thing (never nullable - every audited action here has a real signed-in
    actor; the one unauthenticated write path in this app, the streaming
    webhook ingest, is deliberately NOT audited here, since it isn't a
    person doing something in the product). target_type/target_id name
    WHAT was acted on ("user"/"workspace"/"workspace_member"/"datasource"/
    "dashboard"/"quality_rule", plus that row's own id) - both nullable for
    an action with no single target (there is none in this round's list,
    but the shape stays general for whatever's audited next).

    event_metadata is a small, purely descriptive JSON blob - e.g.
    {"new_role": "viewer"} or {"kind": "postgres"} - never a place to put
    anything sensitive: NO password, token, secret, or full credential
    payload belongs in here, ever, only short descriptive values safe to
    show back to a workspace owner reading their own audit log.

    Composite index on (workspace_id, created_at) - the one real query
    pattern this table serves: "this workspace's events, newest first."
    """
    __tablename__ = "audit_events"
    __table_args__ = (Index("ix_audit_event_workspace_created", "workspace_id", "created_at"),)

    id = Column(String, primary_key=True, default=gen_uuid)
    workspace_id = Column(String, ForeignKey("workspaces.id"), nullable=True)
    actor_user_id = Column(String, ForeignKey("users.id"), nullable=False)
    action = Column(String, nullable=False)
    target_type = Column(String, nullable=True)
    target_id = Column(String, nullable=True)
    event_metadata = Column(JSON, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
