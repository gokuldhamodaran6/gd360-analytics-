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
from sqlalchemy.orm import backref, relationship

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
    # 2026-10-10 (Mission Control): set when an admin suspends the account.
    # deps.get_current_user and /auth/login refuse a suspended user.
    disabled_at = Column(DateTime, nullable=True)
    # 2026-10-10 (round 19, Trust Center): optional 2-step sign-in with an
    # authenticator app (TOTP, RFC 6238). The secret is stored encrypted
    # (security.encrypt_secret); mfa_enabled_at is set only after the person
    # proves the app works with a first code. Recovery codes are stored as
    # SHA-256 hashes and each one works once.
    mfa_secret_enc = Column(Text, nullable=True)
    mfa_enabled_at = Column(DateTime, nullable=True)
    mfa_recovery_hashes = Column(JSON, nullable=True)
    # Set the first time this person proves they own their email (a one-time
    # code sent to it). Company domains only trust a verified email.
    email_verified_at = Column(DateTime, nullable=True)

    @property
    def mfa_enabled(self) -> bool:
        return bool(self.mfa_enabled_at)

    @property
    def email_verified(self) -> bool:
        return bool(self.email_verified_at)

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
    # 2026-10-07 (identity-colour round): the workspace brand kit - the
    # look every dashboard of this workspace starts from and follows until
    # its owner customises it (palette, colour mode, density, corner
    # radius, font, currency, locale, footer note, chrome brand colours).
    # NULL = no kit: dashboards use the product defaults. The shape and its
    # validation live in services/appearance.py (normalize_kit).
    brand_kit = Column(JSON, nullable=True)
    # 2026-10-10 (round 19): company rules shown and changed in the Trust
    # Center (services/policies.py has the defaults and their meaning).
    policies = Column(JSON, nullable=True)

    members = relationship("WorkspaceMember", back_populates="workspace", cascade="all, delete-orphan")


class WorkspaceMember(Base):
    __tablename__ = "workspace_members"
    __table_args__ = (UniqueConstraint("workspace_id", "user_id", name="uq_workspace_member"),)

    id = Column(String, primary_key=True, default=gen_uuid)
    workspace_id = Column(String, ForeignKey("workspaces.id"), nullable=False)
    user_id = Column(String, ForeignKey("users.id"), nullable=False)
    role = Column(String, default="member")  # "owner" | "admin" | "member" | "viewer"
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
    # 2026-09-30 (data catalog v1): a short, plain-English blurb of what
    # this data source actually is/holds - "the Stripe export our finance
    # team refreshes every Monday", not a technical schema description
    # (that's what schema_cache is for). Purely optional, purely
    # descriptive, never computed or inferred - PATCH
    # /datasources/{id}/description sets it, editable tier (see
    # FlowAnnotation's own docstring for why a descriptive fact like this
    # is shared/collaborative rather than owner-only, unlike rename_
    # datasource above which stays owner-only).
    # 2026-09-30 (Governance/Jobs redesign + Pipelines/Catalog removal
    # round): the standalone Catalog page that used to search this field is
    # gone (Gokul's own report - it duplicated the Projects filter and Data
    # Sources page). This column and its PATCH endpoint are untouched -
    # DataSources.tsx now carries the same inline "add/edit description"
    # control the Catalog page used to.
    description = Column(Text, nullable=True)
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
    # 2026-10-08 (round 11): synced app sources (shopify, ga4, meta_ads,
    # google_ads - services/synced_sources.py) copy their records into
    # SyncedTable rows on a schedule; these say when that last happened,
    # when it is due again and, if the last sync failed, why.
    last_synced_at = Column(DateTime, nullable=True)
    next_sync_at = Column(DateTime, nullable=True)
    sync_error = Column(Text, nullable=True)

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
    # Phase 5, Batch B (data governance & quality - row/column permissions):
    # see DataAccessRule's own docstring below. Same back_populates +
    # cascade="all, delete-orphan" style as quality_rules just above - an
    # access rule only ever means anything relative to the exact data
    # source it restricts, so deleting the data source correctly deletes
    # every rule built on it rather than leaving orphan rows behind.
    access_rules = relationship("DataAccessRule", cascade="all, delete-orphan")


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

    # 2026-09-28 (Flow tab transparency round): how long this table
    # actually took to build (wall-clock ms, measured around the real
    # analyze/transform call in routers/chat.py - never estimated), and a
    # short, honest one-line description of what operation actually ran
    # (derived from the real executed code in routers/chat.py's
    # _derive_method_summary - e.g. "Joined tables", "Grouped &
    # aggregated" - never invented). Both null for any version saved
    # before this column existed, or built through a path that doesn't
    # measure/classify yet (see _NEW_COLUMNS in database.py). Shown on
    # the Flow tab's cards.
    duration_ms = Column(Integer, nullable=True)
    method_summary = Column(String, nullable=True)

    # 2026-10-06 (pushdown-honesty round): whether the turn that BUILT this
    # table ran a real query directly against the warehouse/database
    # (used_pushdown=True), or fell back to analyzing a loaded, row-capped
    # in-memory sample (used_pushdown=False) - see models.Message.
    # used_pushdown/sample_row_count's own docstring just below for the
    # full reasoning (this mirrors it exactly, just captured for a
    # table-producing turn instead of a chart-producing one). Both null for
    # any version saved before this column existed, or for a version not
    # built from a live-connector datasource at all (a CSV/Excel upload has
    # nothing to disclose either way).
    used_pushdown = Column(Boolean, nullable=True)
    sample_row_count = Column(Integer, nullable=True)

    # 2026-10-06 ("generated data is a saved query" layer): for a warehouse
    # /database data source GD360 never loads rows into the app, so a
    # table generated from a prompt ("keep only non-canceled bookings and
    # add a total nights column") is NOT a copied dataset - it is ONE
    # standalone, read-only SELECT re-run inside the warehouse whenever
    # the table is used. See services/warehouse_tables.py.
    #   source_kind   - "file" (every CSV-backed version; NULL means file)
    #                   or "warehouse_query".
    #   query_sql     - the complete, standalone definition: optional
    #                   top-level `WITH ...` (every parent's SQL already
    #                   inlined - never a reference to another version at
    #                   run time, so a deleted parent cannot break a
    #                   child) then one SELECT. Read-only, no LIMIT.
    #   sql_alias     - the safe identifier later SQL references this
    #                   query by (`WITH <sql_alias> AS (<query_sql>)`):
    #                   lowercase [a-z0-9_], starts with a letter, <= 40
    #                   chars, unique within the data source.
    #   source_table  - the warehouse table it ultimately reads.
    #   columns_json  - [{name, type}] of the query's result schema,
    #                   captured at creation (BigQuery dry run / a
    #                   zero-row run) - what the Data tab and the SQL
    #                   writers use instead of ever loading rows.
    #   row_count     - exact COUNT(*) at creation (billable on BigQuery,
    #                   so it may be NULL when that query failed); the
    #                   Data-tab profile fills it in later if NULL.
    # `data` stays NOT NULL in the database (there is no migration tool
    # to relax it) - a warehouse version stores b"" there, and
    # data_loader.is_warehouse_query() is the one check every reader uses.
    source_kind = Column(String, nullable=True)
    query_sql = Column(Text, nullable=True)
    sql_alias = Column(String, nullable=True)
    source_table = Column(String, nullable=True)
    columns_json = Column(JSON, nullable=True)
    row_count = Column(BigInteger, nullable=True)

    # 2026-09-28: the "promote to shared model" feature (Saved Tables /
    # models_library.py) these three columns belonged to was removed -
    # it turned out to duplicate a capability chat's own cross-datasource
    # "+ Add more data" picker already provided for free (any table, not
    # just a promoted one), while adding its own confusing "shared model"
    # concept right next to the real ML Models feature. Left in place,
    # unused, rather than dropped: there's no migration tool in this app
    # (see _NEW_COLUMNS below) to safely drop a column, and these are
    # harmless dead weight, not a liability, sitting here.
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
    # 2026-10-08 (round 11): NULL = the original one-source analysis chat
    # (pages/Workspace.tsx); "project" = a multi-source Project answered by
    # services/project_engine across every id in source_ids. For a project,
    # datasource_id is its FIRST source, so every existing access rule that
    # keys off datasource_id keeps working; workspace_id is the workspace
    # it was asked in.
    kind = Column(String, nullable=True)
    source_ids = Column(JSON, nullable=True)
    workspace_id = Column(String, nullable=True)
    # 2026-10-09 (round 15): the Space (models.Space) a project was asked in,
    # if any. Its source_ids are the Space's sources the person could use at
    # the time; the Space itself never grants access to data.
    space_id = Column(String, nullable=True, index=True)

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
    # 2026-09-28 (transparency round, Gokul's own bug report: an AI
    # response with no visibility into what actually happened while it was
    # running, especially when it silently retried once or twice before
    # succeeding or giving up). A real, honest trace of what this turn
    # actually did - a list of {"label", "detail"} dicts, in the order the
    # real events happened (never fabricated, never reordered for effect -
    # see services/ai_engine.analyze's own steps-building comment). None
    # for a turn that predates this column, or that had nothing worth
    # reporting beyond its own narrative.
    steps = Column(JSON, nullable=True)
    # 2026-09-28 (multi-result round): when this turn's answer genuinely
    # covers several distinct analyses in one go (see the "Multiple results
    # in one answer" rule in ai_engine.SYSTEM_PROMPT and
    # ai_engine._build_result_entry), the extra chart/table cards beyond the
    # first are stored here as a list of {label, chart_spec, chart_type,
    # result_columns, result_rows, result_row_count, result_truncated}
    # dicts, in the same shape as this row's own single chart/result_*
    # fields. None for the overwhelming majority of ordinary single-result
    # turns, and for any turn saved before this column existed.
    results = Column(JSON, nullable=True)
    # A real, honest caveat about whether this turn's result is actually
    # trustworthy (overfit, deterministic, a weak/noisy fit) - see the
    # "Honest self-critique for anything model-like" rule in
    # ai_engine.SYSTEM_PROMPT. None when nothing was fitted or predicted.
    self_critique = Column(String, nullable=True)
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

    # 2026-09-28 (Flow tab transparency round): see DatasetVersion.
    # duration_ms/method_summary just above for what these mean and how
    # they're derived - the same real measurement/classification, just
    # captured for a chart-producing turn instead of a table-producing one.
    duration_ms = Column(Integer, nullable=True)
    method_summary = Column(String, nullable=True)

    # 2026-10-06 (pushdown-honesty round, Gokul's own confirmed bug report:
    # a chat answer against his BigQuery source silently analyzed a 2,000-
    # row in-memory sample instead of running a real query against his
    # full table - with zero indication of this to him). `used_pushdown`
    # is the one thing that actually answers "did this turn run a real
    # query directly against the warehouse/database, or analyze a loaded
    # sample" - True when routers/chat.py's own pushdown attempt
    # (_try_bigquery_pushdown/_try_snowflake_pushdown/_try_sql_pushdown/
    # _try_mongo_pushdown) actually succeeded for this turn, False when it
    # was attempted-and-fell-back OR never attempted at all (a CSV/Excel
    # upload, a saved table, or a plain pull-and-pandas kind that has no
    # pushdown path). Null only for a turn saved before this column
    # existed. `sample_row_count` is set ONLY when used_pushdown is False
    # AND this datasource's kind is one pushdown is ever attempted for
    # (bigquery/snowflake/postgres/mysql/sqlserver/supabase/mongodb) - the
    # real, already-loaded row count of the table this turn actually
    # analyzed (never a fresh "what's the real total" query - that would
    # reintroduce the exact cost/latency problem the row cap exists to
    # avoid; this is simply an honest report of what was already loaded,
    # the same restrained approach Round 2's Data-tab loaded_row_count
    # already uses). Null whenever used_pushdown is not False (True -
    # nothing to disclose, this ran directly against the real data; or
    # null - either the kind isn't pushdown-eligible at all, a file
    # upload has no bigger "real" table hiding behind what was loaded, or
    # this turn never loaded a live table at all, e.g. the person picked
    # only an already-saved table as their selection - see routers/
    # chat.py's own comment on this exact three-way split). Never a vague
    # "may be a sample" message - always a real number when there is one
    # to show.
    used_pushdown = Column(Boolean, nullable=True)
    sample_row_count = Column(Integer, nullable=True)

    # 2026-10-06 (warehouse-honesty round): for a warehouse/database
    # kind, a chat answer is now ONLY ever computed inside the warehouse
    # (used_pushdown=True) or not computed at all (action=
    # "needs_query_help", used_pushdown=False, code=None) - never on a
    # loaded sample, so sample_row_count above is always NULL for those
    # kinds from this round on. These record what actually happened, so
    # reopening a conversation shows the same information the live
    # response did (see schemas.ChatResponse's own comment for each
    # field's meaning):
    #   pushdown_sql            - the exact SQL/pipeline that produced the
    #                             result (AI-written, builder-built, or the
    #                             person's own raw_sql).
    #   pushdown_attempts       - [{"sql", "status", "error"}] for every
    #                             attempt made this turn, success or not.
    #   pushdown_bytes_scanned  - real bytes scanned, when metered.
    #   pushdown_duration_ms    - wall-clock ms of generate+execute.
    #   pushdown_result_rows    - rows in the already-aggregated result.
    #   pushdown_skipped_reason - why no attempt (or no further attempt)
    #                             was made, on a needs_query_help turn.
    # All NULL for every file-based kind and for rows saved before this
    # round. The builder prefill (builder_suggestion) is stored inside the
    # existing `suggestions` JSON under key "builder_suggestion" rather
    # than as yet another column.
    pushdown_sql = Column(Text, nullable=True)
    pushdown_attempts = Column(JSON, nullable=True)
    # BigInteger, not Integer: a BigQuery scan can legitimately be several
    # GiB (settings.BIGQUERY_MAX_BYTES_SCANNED_PER_QUERY is 5 GiB), which
    # overflows Postgres' 32-bit INTEGER - same reason
    # PushdownQueryLog.bytes_scanned below is BigInteger.
    pushdown_bytes_scanned = Column(BigInteger, nullable=True)
    pushdown_duration_ms = Column(Integer, nullable=True)
    pushdown_result_rows = Column(Integer, nullable=True)
    pushdown_skipped_reason = Column(Text, nullable=True)

    # 2026-10-07 (chart-integrity round, "say what was filtered"): the row
    # filters behind this answer's numbers, so a chart that excludes
    # cancelled bookings says so and still says so after a reload:
    #   {"parsed": bool,           False = the statement could not be read;
    #                              nothing is claimed about its filters
    #    "filters": [{"kind": "where" | "conditional" | "having",
    #                 "predicate": "is_canceled = 0",
    #                 "label": "canceled rows excluded" | None,
    #                 "table": str | None, "applies_to": alias | None,
    #                 "source": "query" | "saved_table",
    #                 "saved_table": the saved table's name | None}],
    #    "tables": [base tables read], "text": the one line shown,
    #    "writer_note": the SQL writer's own statement of a filter it
    #                   added unasked | None,
    #    "carried": True when read from the source table(s)' cleaning log
    #               (a pandas answer over saved tables)}
    # Written by routers/chat.py from services/sql_filters.py. NULL for a
    # file-based answer with nothing to report and for rows saved before
    # this column existed.
    query_filters = Column(JSON, nullable=True)

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

    # 2026-10-06 (warehouse-native dashboards layer): the dashboard-level
    # definitions behind the filter rail, period control and saved views
    # of the redesigned dashboard view (see services/dashboard_engine.py
    # and routers/dashboard_builder.py's run_page / parameters / saved-
    # views endpoints). All nullable, all only meaningful on a
    # layout_version==2 dashboard whose data source is a warehouse/
    # database; every pre-existing row is untouched (NULL = no rail, no
    # period control, no saved views).
    #   parameters  - [{id, column, label, control: "chips"|"multi"|
    #                 "search"|"segmented"|"range"|"date_range"|
    #                 "checkboxes", options_from: "distinct"|null,
    #                 default}] - one entry per control on the rail.
    #   saved_views - [{id, name, filters, period, date_range, created_by}]
    #                 - a named snapshot of the rail's state.
    #   default_period - "day"|"week"|"month"|"quarter"|"year": the grain
    #                 time charts and KPI sparklines bucket by unless the
    #                 viewer picks another.
    #   date_column - the table column the period/date-range controls
    #                 apply to (every block's date_range filter is pushed
    #                 down on this column when its table has it).
    parameters = Column(JSON, nullable=True)
    saved_views = Column(JSON, nullable=True)
    default_period = Column(String, nullable=True)
    date_column = Column(String, nullable=True)
    # 2026-10-07 (dashboard-from-prompt round): the data source this
    # dashboard is built against, recorded DIRECTLY. Before this round a
    # dashboard only knew its data source through source_conversation_id
    # (routers/dashboard_builder._dashboard_datasource walked
    # dashboard -> conversation -> datasource), which meant a dashboard
    # could not exist without a chat. The propose/commit flow starts from
    # a data source and a goal, no conversation, so this column is the
    # primary link now and the conversation walk is the fallback for every
    # pre-existing row (NULL here). Never required. Deliberately a plain
    # String, not a ForeignKey: the production column is added through
    # _NEW_COLUMNS (a bare ALTER TABLE ADD COLUMN, which cannot add a
    # constraint), and a hard FK would also block deleting a data source
    # that a dashboard still points at - _dashboard_datasource simply
    # resolves to None for a deleted source, the same way the
    # conversation walk always has.
    datasource_id = Column(String, nullable=True)
    # 2026-10-07 (identity-colour round): how this dashboard looks - the
    # chart palette, colour by value or single colour, the owner's pinned
    # value colours, the registry that keeps "City Hotel" on one colour on
    # every chart, page and device, and the presentation settings (density,
    # corner radius, font, currency, locale, default theme and footer note
    # of the published link). One JSON document; its shape, validation and
    # the only code that writes it are services/appearance.py. NULL on
    # every pre-existing row = follow the workspace brand kit (or the
    # product defaults). brand_primary_color / brand_accent_color /
    # background_* / logo above are unchanged and still honoured.
    appearance = Column(JSON, nullable=True)
    # 2026-10-08 (round 11): layout_version 3 = a dashboard built from a
    # multi-source Project answer (services/project_engine/dashboards.py).
    # project_spec keeps the plan it re-runs and the tiles it shows;
    # project_snapshot the latest computed result, refreshed on demand or
    # by an automation.
    project_spec = Column(JSON, nullable=True)
    project_snapshot = Column(JSON, nullable=True)
    snapshot_at = Column(DateTime, nullable=True)

    owner = relationship("User", back_populates="dashboards")
    charts = relationship("SavedChart", back_populates="dashboard", cascade="all, delete-orphan")
    pages = relationship(
        "DashboardPage", back_populates="dashboard", cascade="all, delete-orphan",
        order_by="DashboardPage.position",
    )
    share = relationship(
        "DashboardShare", back_populates="dashboard", uselist=False, cascade="all, delete-orphan",
    )
    # 2026-10-07: block/page/dashboard comments - see DashboardComment.
    comments = relationship("DashboardComment", cascade="all, delete-orphan")


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
    schema change.

    2026-10-07 (analyst canvas round): the canvas renders these SAME rows
    as cells, so two more kinds exist and two config keys bind cells
    together - see routers/dashboard_builder.py's module docstring
    ("Canvas cells") for the full contract:
      - "sql": {sql: <the person's own SELECT>, name?: <cte-safe cell
        name>, parameters?: [names it references]} - run inside the
        warehouse as a raw statement through services/dashboard_engine
        with the page's filter rail NOT pushed down (raw SQL has no spec)
        but with dashboard parameters bound ({{name}} / @name - see
        services/dashboard_engine.bind_parameters: values are always
        bound, never spliced into the text). A sql cell may read another
        sql cell's result as a CTE with {{cell:<name>}}.
      - "input": {parameter_id: <Dashboard.parameters[].id>} - a rail
        parameter rendered inline on the canvas; never executed.
      - "chart" | "kpi" | "table" | "donut" | "sparkline" | "avatar_list"
        with config.source_block_id: rendered from THAT sql cell's result
        instead of an own spec. run_page resolves the dependency order
        and rejects loops."""
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
    # 2026-09-29 (design revamp): a single-level "undo my last change"
    # snapshot, taken right before any of the six endpoints that overwrite
    # config (update_block, ask_ai_block, build_manual_block, restyle_block,
    # set_block_accent_color, set_block_analysis - see routers/
    # dashboard_builder.py's shared _snapshot_block_config helper, called
    # at the top of every one of them) replaces it. Holds a small envelope
    # {"type": <str>, "config": <dict>} rather than just the bare config -
    # ask_ai_block/build_manual_block can also change `type` itself (e.g. a
    # requested "chart" block that only had one row and came back as a
    # "kpi" instead), and undoing only config while leaving the NEW type in
    # place would leave the block showing content for the wrong renderer
    # (a "chart" type with a kpi's {value,label} config). Deliberately just
    # ONE level, not a full history table: this is meant to undo the one
    # accidental edit that just happened ("just now i changed something and
    # i cannot able to get that old version back"), not to be a version-
    # control system - a second change after an undo overwrites this
    # snapshot again the same way, so undo is not itself undoable (there is
    # nothing left to revert TO). NULL until the block's config has been
    # changed at least once since this column existed, and set back to NULL
    # by undo_block itself once used, so the frontend's kebab-menu "Undo
    # last change" option only ever shows when there is genuinely something
    # to revert to.
    previous_config = Column(JSON, nullable=True)
    # 2026-10-06 (warehouse-native dashboards layer): for a block on a
    # warehouse/database source, config["spec"] holds its BlockSpec (see
    # services/query_builder.validate_block_spec) and the engine compiles
    # that spec plus the page's live filters into one query per run. These
    # two columns are the block's OWN record of its last compile/run,
    # kept on the row rather than inside `config` on purpose:
    #   - `config` is what _snapshot_block_config/undo_block snapshot and
    #     restore, and what update_block lets a client replace wholesale.
    #     The last compiled SQL and the last run's cost are observations
    #     about the block, not part of its definition - undoing an edit
    #     must not "undo" an audit fact, and a client PATCHing config must
    #     not be able to forge one.
    #   - query_sql is the SQL compiled for the block's OWN spec with no
    #     page filters (what "Show SQL" shows at rest; the filtered variant
    #     is GET /blocks/{id}/sql). last_run is {bytes_scanned,
    #     duration_ms, rows, ran_at, cached} from the most recent run_page
    #     that executed it.
    query_sql = Column(Text, nullable=True)
    last_run = Column(JSON, nullable=True)

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
    # 2026-10-10 (round 19): how often the published link is opened, for the
    # Trust Center's sharing list (counted by the public GET, not per block).
    view_count = Column(Integer, nullable=True, default=0)
    last_viewed_at = Column(DateTime, nullable=True)

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


class DashboardComment(Base):
    """2026-10-07 (analyst canvas + dashboard-from-prompt round): one
    comment on a layout_version=2 dashboard - see routers/
    dashboard_comments.py for the endpoints and the permission rules.

    Where it hangs:
      - block_id set: on that block (a chart, a SQL cell, a KPI row...).
        The canvas and the dashboard both show a block's thread count
        from DashboardBuilderOut.comment_counts without a second request.
      - block_id NULL, page_id set: on the page as a whole.
      - both NULL: on the dashboard as a whole.
    anchor (optional, free-form JSON) is the chart ELEMENT the comment is
    pinned to, so it stays on the data point rather than a pixel:
    {"kind": "bar" | "point" | "cell", "key": <the x value / row key /
    cell id>, ...}. The backend stores it as given; only the renderer
    interprets it.

    Threads: parent_id NULL = a top-level comment (a thread root);
    parent_id set = a reply to that root (replies are flat - one level,
    never a reply to a reply - the same shape every comment UI the
    designs reference uses). A reply inherits its root's block/page/
    anchor; its own block_id/page_id are copied from the root at insert
    time so counting per block stays one query.

    resolved_at is set on the ROOT only (resolving a thread resolves all
    of it); mentions is ["name", ...] - the @tokens parsed out of body at
    write time (no notification is sent yet: Notifications v1 exists but
    SMTP is off, so this just records who was named). block_id/page_id
    carry no FK on purpose: a deleted block or page leaves its comments
    orphaned-but-readable at the dashboard level rather than failing the
    delete, and the dashboard-level cascade below is the only thing that
    removes them."""
    __tablename__ = "dashboard_comments"

    id = Column(String, primary_key=True, default=gen_uuid)
    dashboard_id = Column(String, ForeignKey("dashboards.id"), nullable=False, index=True)
    block_id = Column(String, nullable=True, index=True)
    page_id = Column(String, nullable=True)
    parent_id = Column(String, ForeignKey("dashboard_comments.id"), nullable=True, index=True)
    author_id = Column(String, ForeignKey("users.id"), nullable=False)
    body = Column(Text, nullable=False)
    anchor = Column(JSON, nullable=True)
    mentions = Column(JSON, nullable=True)
    resolved_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    author = relationship("User")
    replies = relationship(
        "DashboardComment", cascade="all, delete-orphan", backref=backref("parent", remote_side=[id]),
        order_by="DashboardComment.created_at",
    )


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


class DataAccessRule(Base):
    """
    Phase 5, Batch B (governance/data permissions): a data source owner's
    restriction on what one workspace ROLE TIER (never a named individual -
    see WorkspaceMember.role) can see of this data source's data. Two kinds:
      - "column": column_name is hidden entirely from that role.
      - "row": only rows whose column_name value is in allowed_values are
        visible to that role (allowed_values null/empty means nothing
        matches - the safe default is "show nothing" while a row rule with
        no values yet is being set up, never "show everything").
    Enforced by services/data_access_rules.py::filter_dataframe_for_role,
    called right after every services/data_loader.load_dataframe (or
    load_version_dataframe) call that could hand real row data back to a
    non-owner - see that module's own docstring for the full list of call
    sites and, critically, why warehouse/database SQL "pushdown" in
    routers/chat.py must be skipped entirely (not filtered after the fact)
    whenever a restricted role is asking.

    Uniquely keyed on (datasource_id, role, kind, column_name) - creating a
    second rule for the same (data source, role, kind, column) is rejected
    by the router with a clear error rather than silently stacking; the UI
    deletes the old one first to replace it. Only ever created/deleted by
    the data source's own owner (see routers/data_access_rules.py) - never
    self-service by the restricted member/viewer.
    """
    __tablename__ = "data_access_rules"
    __table_args__ = (
        UniqueConstraint("datasource_id", "role", "kind", "column_name", name="uq_access_rule_scope"),
    )

    id = Column(String, primary_key=True, default=gen_uuid)
    datasource_id = Column(String, ForeignKey("datasources.id"), nullable=False)
    role = Column(String, nullable=False)  # "member" | "viewer"
    kind = Column(String, nullable=False)  # "row" | "column"
    column_name = Column(String, nullable=False)
    allowed_values = Column(JSON, nullable=True)  # only meaningful for kind == "row"
    created_at = Column(DateTime, default=datetime.utcnow)
    created_by_id = Column(String, ForeignKey("users.id"), nullable=False)

    datasource = relationship("DataSource", back_populates="access_rules")


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


class MLModel(Base):
    """
    2026-09-28 (ML Models round): a trained, ready-to-use machine learning
    model - the real ML feature this app has never had before. Earlier
    this same day, this app also had a "Saved Tables" feature (promoted,
    reusable data TABLES - nothing to do with machine learning) sitting
    right next to this one in the sidebar under a confusingly similar
    name; it was removed shortly after this feature shipped, once that
    naming collision (plus the fact "Saved Tables" duplicated a capability
    chat's own cross-datasource picker already provided for free) made it
    clear it wasn't earning its place. This table - and every user-facing
    string about it - is still always called "ML Models" or "ML Model",
    never just "Models" or "Model", as a matter of habit even though the
    collision it was guarding against is gone.

    Training is entirely deterministic - a small, fixed, well-tested
    shortlist of real scikit-learn algorithms per task_type (see
    services/ml_training.py for the exact list and why), picked by real
    held-out test performance, never AI-generated or user-authored code,
    and never routed through this app's AI code-execution sandbox
    (services/sandbox.py/services/ai_engine.py) at all - matching the exact
    same "small fixed whitelist, zero code-execution risk" philosophy
    routers/dashboard_builder.py's manual block building already
    established for this codebase (see that file's own _MANUAL_AGG_FUNCS).
    Training an ML model is a plain, deterministic backend computation the
    user configures through a form (see components/TrainModelWizard.tsx),
    exactly like manual dashboard block building already is - not a chat/
    AI feature.

    task_type ("classification" | "regression") is auto-detected from the
    target column's own real values at training time (see
    services/ml_training.infer_task_type) unless a caller ever states one -
    this phase's own wizard never does, so it is always auto-detected in
    practice. algorithm is the SPECIFIC winning algorithm's real name (e.g.
    "random_forest_classifier") - always the one that actually won on this
    model's own held-out test data, shown plainly to the user, never hidden
    as an opaque "AI model".

    model_artifact is the fitted scikit-learn Pipeline (preprocessing +
    model chained together, so predict()/score() never have to redo
    feature engineering by hand) serialized with joblib into raw bytes -
    the exact same "no external blob storage, just a LargeBinary column"
    pattern DataSource.file_data/cleaned_data already use in this app (see
    that model's own docstring) - this app has no S3/blob storage.

    feature_columns/excluded_columns are both real, computed at training
    time by services/ml_training.select_features - a column that looks
    like a unique id, or has too many distinct categorical values to
    one-hot-encode sanely, is excluded and WHY is recorded in
    excluded_columns so the UI can always honestly answer "why wasn't this
    column used?" - never silently dropped with no explanation.

    metrics is the real, computed held-out test performance - keys depend
    on task_type (classification: accuracy/precision/recall/f1;
    regression: mae/rmse/r2) - NEVER a fabricated or estimated number; see
    this app's own strict "never fabricate a stat" discipline, unbroken
    here.

    status is "training" | "ready" | "failed" - "training" only ever
    exists for the brief moment between this row's own creation and
    services/ml_training.train_model returning (training runs synchronously
    inside the same request, matching how quality-rule creation already
    runs its own first check synchronously - see routers/quality_checks.py)
    - by the time POST /ml-models/train responds, status is always either
    "ready" or "failed". "failed" always keeps error_message set to a real,
    honest explanation (e.g. "Not enough data to train a reliable model -
    need at least 30 rows with a value in both the target and feature
    columns, this data only has 12."), never a generic/blank failure.

    prediction_count/last_predicted_at are real running counters, bumped by
    every actual predict/score call (see routers/ml_models.py) - never
    simulated or seeded with a fabricated starting number.

    owner_id is whoever trained this model - the only person who can
    delete it (see routers/ml_models.py delete_ml_model); datasource_id
    ties it to the exact data source it was trained from and re-trains
    against, following the same owner_id/datasource_id split
    DataQualityRule already uses for the identical reason (a workspace
    member with edit access can train a model on a teammate's shared data
    source, attributed to themselves).

    feature_importance (added 2026-09-30, model trustworthiness round):
    real, computed global feature importance - list[{"feature": str,
    "importance": float}], sorted highest first, weights normalized to
    sum to 1.0 - see services/ml_training._extract_feature_importance for
    exactly how each algorithm's own real attribute (RandomForest*'s
    feature_importances_, LogisticRegression/LinearRegression's coef_) is
    read and mapped back to the original column names (collapsing a
    one-hot-encoded categorical column's several dummy weights back into
    one entry per real column). This is GLOBAL importance - "what this
    model leans on overall" - never a per-prediction explanation; see
    MLPrediction.explanation below for the one thing this app can
    honestly say about a SPECIFIC prediction, and services/
    ml_training._explain_prediction's own docstring for exactly why that
    is only ever computed for a linear/logistic model, never a random
    forest.

    version_number/versions (added 2026-09-30, model trustworthiness
    round): this row always mirrors whichever MLModelVersion (below) has
    is_current=True - every other part of this app (predict/score/the
    detail page's headline stats) keeps reading MLModel exactly as
    before, unaware MLModelVersion exists at all. A retrain no longer
    overwrites this row's history away - see MLModelVersion's own
    docstring and routers/ml_models.py retrain_ml_model/
    promote_ml_model_version for what actually changed.

    quality_warnings (added 2026-09-30, leakage-guardrail round): a real,
    computed list[{"type": str, ...}] flagging things about THIS trained
    result worth a second look before trusting it - added after this app's
    first real, confirmed case of target leakage: a "predict Sales" model
    that scored r2=0.9999999999913826 because two of its own auto-included
    features (Gross Profit, Cost) are literally Sales = Gross Profit +
    Cost in that data. See services/ml_training.py's own module docstring
    for the full story, and services/ml_training.train_model's own
    comments for exactly how each entry is computed: "near_perfect_score"
    (the held-out test score itself was suspiciously high),
    "dominant_feature" (one feature holds almost all of this model's own
    real feature_importance), "high_correlation_feature" (a feature this
    run actually used is still highly correlated with the target it's
    predicting). Always a real list for a run that reached status="ready"
    (empty when nothing tripped), never omitted. None of these BLOCK
    training or silently drop a feature - a person can always keep a
    flagged column on purpose; this is a warning shown plainly, never an
    invisible correction, matching this table's own "never fabricate,
    never silently fix" discipline everywhere else.
    """
    __tablename__ = "ml_models"

    id = Column(String, primary_key=True, default=gen_uuid)
    owner_id = Column(String, ForeignKey("users.id"), nullable=False)
    workspace_id = Column(String, ForeignKey("workspaces.id"), nullable=True)
    datasource_id = Column(String, ForeignKey("datasources.id"), nullable=False)
    name = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    task_type = Column(String, nullable=True)  # "classification" | "regression" - set once training completes
    target_column = Column(String, nullable=False)
    feature_columns = Column(JSON, nullable=True)  # list[str] actually used, set at training time
    excluded_columns = Column(JSON, nullable=True)  # list[{"column": str, "reason": str}]
    algorithm = Column(String, nullable=True)  # e.g. "random_forest_classifier", set once training completes
    model_artifact = Column(LargeBinary, nullable=True)  # joblib-serialized fitted sklearn Pipeline
    metrics = Column(JSON, nullable=True)
    # See this model's own docstring above - global, never per-prediction.
    feature_importance = Column(JSON, nullable=True)
    # See this model's own docstring above (leakage-guardrail round) -
    # list[{"type": str, ...}], real, never fabricated. None for a model
    # trained before this round existed; [] for one trained since with
    # nothing to flag.
    quality_warnings = Column(JSON, nullable=True)
    status = Column(String, nullable=False, default="training")  # "training" | "ready" | "failed"
    error_message = Column(Text, nullable=True)
    trained_row_count = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    trained_at = Column(DateTime, nullable=True)
    prediction_count = Column(Integer, nullable=False, default=0)
    last_predicted_at = Column(DateTime, nullable=True)
    # Which MLModelVersion.version_number is currently active - starts at
    # 1 for a model's own initial training run. See this model's own
    # docstring above.
    version_number = Column(Integer, nullable=False, default=1)
    # 2026-10-08 (round 13, ML Studio): a model started from a goal in
    # words. problem_type is the gallery choice (yes_no, number, drivers,
    # segments, anomalies, forecast_one, forecast_many); plan is the
    # checked plan it trained from; progress the live stages, leaderboard
    # and trial curve; results what it found (test scores, drivers,
    # segments, anomalies or forecast). NULL for models from the older
    # wizard, which keep working exactly as before.
    problem_type = Column(String, nullable=True)
    goal = Column(Text, nullable=True)
    table_name = Column(String, nullable=True)
    plan = Column(JSON, nullable=True)
    progress = Column(JSON, nullable=True)
    results = Column(JSON, nullable=True)
    started_at = Column(DateTime, nullable=True)
    stop_requested = Column(Boolean, nullable=True)

    datasource = relationship("DataSource")
    predictions = relationship("MLPrediction", cascade="all, delete-orphan")
    versions = relationship(
        "MLModelVersion", back_populates="ml_model", cascade="all, delete-orphan",
        order_by="MLModelVersion.version_number.desc()",
    )


class MLModelVersion(Base):
    """2026-09-30 (model trustworthiness round): one full, honest snapshot
    of an MLModel every time training genuinely produces a usable model -
    the fix for the exact limitation models.MLModel/routers/ml_models.py
    used to state plainly: "retraining overwrites the previous model's
    metrics/artifact with no history kept." It no longer does.

    A row is appended here every time services/ml_training.train_model
    finishes with status="ready" - the model's very first training run
    included, so an never-retrained model still has exactly one version
    (version_number=1), never zero. Retraining (routers/ml_models.py
    retrain_ml_model) appends a new row at the next version_number and
    flips is_current; it never edits or deletes an earlier version's row.
    "Promote to active" (routers/ml_models.py promote_ml_model_version)
    copies an older version's own fields back onto the live MLModel row
    AND appends one more new version (created_reason="promoted") rather
    than reaching back and re-activating history in place - so the
    version list is always a true, append-only timeline of what this
    model actually was, in the order it actually happened, and "what's
    active right now" always has exactly one real answer.

    Every column here is a snapshot of the matching MLModel column at the
    moment this version was created - see that model's own docstring for
    what each one means. is_current=True on exactly one version per
    ml_model_id at any time; MLModel's own version_number/algorithm/
    metrics/feature_importance/model_artifact/feature_columns/
    excluded_columns/trained_row_count/quality_warnings always match
    whichever version that is, so nothing else in this app has to know
    this table exists."""
    __tablename__ = "ml_model_versions"

    id = Column(String, primary_key=True, default=gen_uuid)
    ml_model_id = Column(String, ForeignKey("ml_models.id"), nullable=False, index=True)
    version_number = Column(Integer, nullable=False)
    is_current = Column(Boolean, nullable=False, default=False)
    # "trained": a real training/retraining run. "promoted": an earlier
    # version was made active again with no new training involved. See
    # this model's own docstring above.
    created_reason = Column(String, nullable=False, default="trained")
    algorithm = Column(String, nullable=True)
    feature_columns = Column(JSON, nullable=True)
    excluded_columns = Column(JSON, nullable=True)
    model_artifact = Column(LargeBinary, nullable=True)
    metrics = Column(JSON, nullable=True)
    feature_importance = Column(JSON, nullable=True)
    # See MLModel.quality_warnings's own docstring - a version snapshot's
    # own copy, so promoting an old version restores its real warnings
    # too, never silently dropping them.
    quality_warnings = Column(JSON, nullable=True)
    trained_row_count = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    ml_model = relationship("MLModel", back_populates="versions")


class MLPrediction(Base):
    """2026-09-28 (ML Models round): one real prediction made against a
    trained MLModel - powers that model's own usage stats
    (prediction_count/last_predicted_at on MLModel) honestly, and is the
    foundation a later round can build real accuracy-over-time monitoring
    on top of. Written both by a single POST /ml-models/{id}/predict call
    and, once per row, by a POST /ml-models/{id}/score call against a whole
    table (see routers/ml_models.py) - either way, `input_values` and
    `predicted_value` are always the real values that call actually used/
    produced, never sampled or reconstructed after the fact.

    actual_value stays null until someone later confirms the real outcome -
    never guessed, backfilled, or auto-filled by anything in this app; this
    round builds no UI for setting it, it is just left ready for that
    honest, human-confirmed future feature rather than modeled around a
    fabricated placeholder in the meantime.

    confidence is predict_proba's top-class probability, only ever set for
    a classification model whose underlying winning algorithm actually
    supports predict_proba - null for every regression prediction, and null
    for a classification prediction from an algorithm that doesn't expose
    one, rather than a fabricated confidence number.

    model_version_id (added 2026-09-30, model trustworthiness round):
    which MLModelVersion was actually active at the moment this
    prediction was made - set on every new prediction going forward,
    left null on rows written before this column existed (an honest gap
    rather than a guessed backfill). This is what makes a prediction's
    lineage real: a model can be retrained a dozen times, and every past
    prediction still honestly says which exact version produced it,
    rather than silently being reattributed to whatever is active today.

    explanation (added 2026-09-30, model trustworthiness round): the
    real, computed per-feature contribution breakdown for THIS
    prediction - list[{"feature": str, "value": Any, "contribution":
    float}] - only ever populated for a linear/logistic winning
    algorithm (see services/ml_training._explain_prediction's own
    docstring for exactly why a random forest's prediction leaves this
    null instead of a fabricated approximation)."""
    __tablename__ = "ml_predictions"

    id = Column(String, primary_key=True, default=gen_uuid)
    ml_model_id = Column(String, ForeignKey("ml_models.id"), nullable=False, index=True)
    model_version_id = Column(String, ForeignKey("ml_model_versions.id"), nullable=True, index=True)
    input_values = Column(JSON, nullable=False)
    predicted_value = Column(JSON, nullable=False)  # the raw predicted value (string/number/bool)
    confidence = Column(Float, nullable=True)  # predict_proba's top-class probability, classification only
    # Real per-feature contributions for THIS prediction - linear/logistic
    # models only. See this model's own docstring above.
    explanation = Column(JSON, nullable=True)
    # Never auto-filled - see this model's own docstring above.
    actual_value = Column(JSON, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    created_by_id = Column(String, ForeignKey("users.id"), nullable=False)

    ml_model = relationship("MLModel", back_populates="predictions")
    model_version = relationship("MLModelVersion")


class MetricDefinition(Base):
    """
    2026-09-30 (semantic layer v1 round): a named, reusable metric - "the
    single highest-leverage gap" identified in this app's own competitive
    gap analysis (claude/gd360-competitive-gap-analysis-2026-09-29.md,
    gap #6). Define "Revenue" or "Active Users" ONCE, with an exact column,
    aggregation, and filter criteria, and every consumer resolves it
    through the exact same computation - see services/metrics.py's own
    module docstring for the full list of consumers (a metric-backed
    dashboard kpi/gauge tile, this metric's own live current-value display,
    and services/ai_engine.py's chat integration) and why this is the ONE
    place that computation lives.

    Deliberately NOT a free-form formula string (e.g. "SUM(amount) WHERE
    status='completed'") that would need its own expression parser and its
    own code-execution surface - matching this app's existing "small fixed
    whitelist, zero code-execution risk" philosophy that routers/
    dashboard_builder.py's manual block building already established (see
    that file's own _MANUAL_AGG_FUNCS) and services/ml_training.py's
    training pipeline follows for the identical reason. agg is one of
    exactly five values (services/metrics.AGG_FUNCS: sum/avg/count/min/
    max) - the same five the manual dashboard-block builder already offers,
    so "save this KPI as a reusable metric" is always a lossless, 1:1
    translation. filters uses the exact same criterion shape (list of
    {"column": str, "spec": {...}}) as a dashboard's own cross-filters
    (see schemas.FilterCriterion) - the Data tab's own Excel-style column
    filter vocabulary, not a second, narrower one invented just for this.

    Scoped to datasource_id (not workspace_id) - the same split
    DataQualityRule/DataAccessRule/MLModel already use for an identical
    reason: a workspace member with edit access to a shared data source
    can define a metric on it, attributed to themselves (owner_id), and
    every other member with at least view access to that data source can
    see and use it (routers/metric_definitions.py enforces this the same
    two-tier way those other routers already do).

    A metric's name is unique per data source (see __table_args__ below) -
    two different metrics named "Revenue" on the SAME data source would
    defeat the entire point (which formula does "Revenue" mean here?);
    the same name on two DIFFERENT data sources is fine and expected (each
    data source's own "Revenue" is its own thing).
    """
    __tablename__ = "metric_definitions"
    __table_args__ = (UniqueConstraint("datasource_id", "name", name="uq_metric_definition_datasource_name"),)

    id = Column(String, primary_key=True, default=gen_uuid)
    datasource_id = Column(String, ForeignKey("datasources.id"), nullable=False, index=True)
    owner_id = Column(String, ForeignKey("users.id"), nullable=False)
    name = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    metric_column = Column(String, nullable=False)
    agg = Column(String, nullable=False, default="sum")  # "sum" | "avg" | "count" | "min" | "max"
    # list[{"column": str, "spec": {...}}] - see this model's own docstring
    # above; empty/None means "no filter, the whole data source."
    filters = Column(JSON, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    datasource = relationship("DataSource")
    owner = relationship("User")


class DataTransform(Base):
    """
    2026-09-30 (transformation layer v1): a named, reusable, ordered
    pipeline of small, whitelisted operations that turns one data source's
    raw table into a new, named DERIVED table - the "T" in ETL this app has
    never had a dedicated place for (claude/gd360-competitive-gap-analysis-
    2026-09-29.md, gap #4: "a dedicated place to define reusable
    transformation logic ... this overlaps heavily with gap #6 [the
    semantic layer] and is worth designing together rather than
    separately" - which is exactly what this does: the filter step below
    resolves through the exact same services/metrics.apply_filters every
    metric definition's own filter already uses, not a third copy of it).

    `steps` is a JSON list of small dicts, each one of a FIXED, reviewable
    vocabulary - "filter" (reuses services/metrics.apply_filters' exact
    criterion shape), "add_column" (a derived column from one of four basic
    arithmetic operators against another column or a constant - never a
    free-form formula string), "select_columns", "rename_column", and
    "group_by" (a group + one of the same five aggregations every other
    computed feature in this app already offers) - see
    services/transforms.py's STEP_HANDLERS for the authoritative shape of
    each. Applied in array order, each step's output feeding the next.
    Deliberately NOT a free-form formula string or any executable code -
    the same "small fixed whitelist, zero code-execution risk" philosophy
    services/metrics.py, services/ml_training.py, and dashboard_builder.py's
    own _MANUAL_AGG_FUNCS already follow.

    Consumers, as of this round:
      - routers/transforms.py - this transform's own live preview/result,
        and the live preview used while building/editing one (unsaved
        steps, via the /preview endpoint).
      - routers/dashboard_builder.py - a manual-build block
        (config["recipe"]["transform_id"] set) resolves this transform's
        OUTPUT dataframe FIRST, then builds its kpi/gauge/chart/table on
        top of THAT - "a tile built from a saved table" - recomputed live
        on every rebuild or page-filter change, never a frozen snapshot,
        the same live-recomputation guarantee a metric-backed block already
        has (see _metric_kpi_or_gauge_config's own docstring).
      - services/ai_engine.py / routers/chat.py - a saved transform's
        already-computed output is made available to the AI as an
        additional named table (alongside the raw data) with a plain-
        English note on what it represents, so a question that would
        benefit from it can reference it directly instead of the AI
        re-deriving the same logic from scratch every time.

    Scoped to datasource_id (not workspace_id), unique name per data
    source, and the same two-tier access split (editable to define/change,
    view to see and use, creator-only to delete) - all for the identical
    reasons MetricDefinition's own docstring above already gives; see that
    docstring for the full rationale rather than repeating it here.
    """
    __tablename__ = "data_transforms"
    __table_args__ = (UniqueConstraint("datasource_id", "name", name="uq_data_transform_datasource_name"),)

    id = Column(String, primary_key=True, default=gen_uuid)
    datasource_id = Column(String, ForeignKey("datasources.id"), nullable=False, index=True)
    owner_id = Column(String, ForeignKey("users.id"), nullable=False)
    name = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    # list[{"op": str, ...}] - see this model's own docstring above and
    # services/transforms.py's STEP_HANDLERS for the exact shape of each
    # "op". Kept as a permissive JSON list (not a discriminated Pydantic
    # union in schemas.py either) for the same reason schemas.FilterCriterion.
    # spec already accepts that tradeoff: five genuinely different step
    # shapes, and services/transforms.py's own validation is the single
    # source of truth for what is and isn't a valid step - never executed
    # as code, always dispatched through a fixed op -> handler mapping.
    steps = Column(JSON, nullable=False, default=list)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    datasource = relationship("DataSource")
    owner = relationship("User")


class Pipeline(Base):
    """
    2026-09-30 (orchestration v1): a named, saved, ORDERED chain of a few
    whitelisted actions run strictly in sequence - "run step B only after
    step A succeeds" (claude/gd360-competitive-gap-analysis-2026-09-29.md
    gap #5: "Orchestration (pipeline/job scheduling with dependencies)"),
    the single biggest data-engineer-facing gap per
    claude/gd360-capability-map-2026-09-28.md's own priority ranking, and
    the gap routers/datasources.py's own refresh_api endpoint had already
    named plainly before this round existed: "Wiring an 'api' source into
    services/scheduler.py's existing... loop is real, separate future
    work... needs its own design and testing pass."

    Deliberately v1-scoped to a LINEAR chain, not a full dependency graph
    (DAG) - no branching, no fan-out/fan-in, no retries/backfill. Real,
    useful orchestration ("every morning: refresh this API source, then
    rebuild this dashboard so its AI-answered blocks see the fresh data,
    then re-check this source's quality rules and flag anything broken")
    without the complexity of a general scheduler like Airflow/Dagster/
    Prefect - matching this app's "smallest thing genuinely useful" build
    discipline every prior phase has followed (see, e.g., DataTransform's
    own docstring choosing five fixed step types over a free-form formula
    language).

    `steps` is a JSON list of small dicts, each one of a FIXED, reviewable
    vocabulary of THREE step types - never a free-form script or arbitrary
    code:
      - "refresh_datasource": {"type": "refresh_datasource",
        "datasource_id": "..."} - re-fetches an "api"-kind data source's
        live snapshot (services/datasource_refresh.refresh_api_datasource,
        the exact same logic routers/datasources.py's refresh_api "Run
        now" button already uses by hand - only ever applies to
        kind=="api" sources; every other kind is read live on every query
        and has nothing to "refresh").
      - "rebuild_dashboard": {"type": "rebuild_dashboard", "dashboard_id":
        "..."} - reuses services/scheduler.refresh_dashboard wholesale
        (the exact function the existing 60-second dashboard-only
        scheduler and the Jobs page's own "Run now" already call), so a
        pipeline-triggered rebuild behaves identically to those and is
        logged into the same models.JobRun history too.
      - "run_quality_checks": {"type": "run_quality_checks",
        "datasource_id": "..."} - re-runs every models.DataQualityRule
        already defined on that data source (services/quality_checks.
        run_quality_rule, one call per rule) and fails this step (stopping
        the chain) if any rule comes back "fail" or "error" - an honest
        signal a broken chain should stop on, never silently swallowed.
    See services/pipelines.py's STEP_HANDLERS for the authoritative
    dispatch and exact behavior of each.

    Applied in array order via services/pipelines.run_pipeline_steps,
    which - UNLIKE services/transforms.apply_transform_steps - does not
    discard prior work on a failure: each step here is a real,
    already-happened side effect against the live database (an API fetch
    actually ran, a dashboard actually recomputed), so a later step
    failing never undoes an earlier step that already succeeded; it only
    stops anything further in the chain from running this time.

    NOT scoped to one datasource_id (unlike DataTransform/MetricDefinition)
    because a chain's steps can each target a DIFFERENT data source or
    dashboard - scoped to owner_id (+ optional workspace_id, mirroring
    Dashboard's own optional workspace scoping) instead, matching this
    app's existing two-tier access convention (services/workspace_access.py)
    applied at the WORKSPACE-membership level rather than through one
    parent datasource, the same way routers/jobs.py already scopes the
    dashboard-schedule feature account-wide rather than per-datasource.

    schedule_interval reuses the exact same four-value vocabulary
    (schemas.REFRESH_INTERVALS / schemas.PIPELINE_SCHEDULE_INTERVALS,
    minus "off") services/scheduler.py's dashboard auto-refresh already
    established, and next_run_at/last_run_at are computed via that same
    module's compute_next_refresh_at - one shared interval vocabulary and
    clock, not two competing ones. See services/scheduler.py's _tick,
    extended in this round to also find due Pipelines alongside due
    Dashboards - still one 60-second loop, one HONEST LIMITATION (only
    runs while this web process is awake - see that module's own
    docstring, unchanged by this round).
    """
    __tablename__ = "pipelines"
    __table_args__ = (UniqueConstraint("owner_id", "name", name="uq_pipeline_owner_name"),)

    id = Column(String, primary_key=True, default=gen_uuid)
    owner_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    workspace_id = Column(String, ForeignKey("workspaces.id"), nullable=True, index=True)
    name = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    steps = Column(JSON, nullable=False, default=list)
    # None ("off") | "15m" | "1h" | "6h" | "daily" - see this model's own
    # docstring above.
    schedule_interval = Column(String, nullable=True)
    next_run_at = Column(DateTime, nullable=True)
    last_run_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    owner = relationship("User")
    workspace = relationship("Workspace")


class PipelineRun(Base):
    """One execution record of a Pipeline (see that model's own docstring)
    - mirrors models.JobRun's own "created before any work happens, status
    starts running, finally always sets finished_at" honesty pattern
    exactly, generalized to a chain of MULTIPLE steps instead of one
    dashboard refresh. pipeline_id is nullable (not NOT NULL) for the same
    reason JobRun.dashboard_id is - a deleted pipeline keeps its run
    history rather than cascading it away. pipeline_name is the pipeline's
    name AT THE TIME this ran, denormalized on purpose (same as JobRun.
    target_label), so a later rename - or the pipeline's own deletion -
    never rewrites what an old run's history says it was.

    step_results is a JSON list, one dict per step ACTUALLY ATTEMPTED
    (never one for a step skipped after an earlier one already failed -
    see services/pipelines.run_pipeline_steps), each shaped
    {"index", "type", "label", "status", "detail", "error"} - "label" is
    the target's real name AT THE TIME this step ran (e.g. the data
    source's or dashboard's actual name), resolved live, never guessed or
    left as a bare id; "detail" is a small dict of real, honest facts
    about what that step actually did (e.g. {"rows": 4213, "columns": 9}
    for a refresh, {"checked": 5, "failing": 0} for a quality-check pass) -
    never a fabricated summary.

    status is "running" | "success" | "failed" - "success" only when
    EVERY step in the pipeline's steps list was attempted and succeeded;
    a chain that stops partway through (one or more steps never reached)
    is always "failed", even though the steps that did run may have
    themselves succeeded - the step_results list itself is what shows
    exactly how far it got, so nothing about a partial run is hidden
    behind a single pass/fail flag."""
    __tablename__ = "pipeline_runs"

    id = Column(String, primary_key=True, default=gen_uuid)
    pipeline_id = Column(String, ForeignKey("pipelines.id"), nullable=True, index=True)
    owner_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    run_type = Column(String, nullable=False)  # "scheduled" | "manual"
    pipeline_name = Column(String, nullable=False)
    status = Column(String, nullable=False, default="running")  # "running" | "success" | "failed"
    error_message = Column(Text, nullable=True)
    step_results = Column(JSON, nullable=False, default=list)
    started_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    finished_at = Column(DateTime, nullable=True)
    next_run_at = Column(DateTime, nullable=True)

    @property
    def duration_seconds(self) -> float | None:
        """None while status=="running" (finished_at not set yet) - the
        Pipelines page shows a live spinner instead of a duration for
        those rows rather than a fabricated 0.0s, same convention
        JobRun.duration_seconds already established."""
        if self.finished_at is None:
            return None
        return (self.finished_at - self.started_at).total_seconds()


class SyncedTable(Base):
    """2026-10-08 (round 11): one table of a synced app source (Shopify
    orders, GA4 daily traffic, Meta Ads campaign insights, Google Ads
    campaign stats...). services/synced_sources.py fetches the records
    from the app's API on a schedule, normalises them into a standard
    layout and stores the whole table here as Parquet bytes; the project
    engine and the Data tab query it with DuckDB exactly like an uploaded
    file. One row per (datasource, table) - a sync replaces it."""
    __tablename__ = "synced_tables"

    id = Column(String, primary_key=True, default=gen_uuid)
    datasource_id = Column(String, ForeignKey("datasources.id", ondelete="CASCADE"), nullable=False, index=True)
    table_name = Column(String, nullable=False)
    parquet_data = Column(LargeBinary, nullable=False)
    row_count = Column(Integer, nullable=False, default=0)
    columns = Column(JSON, nullable=False, default=list)  # [{name, type}]
    synced_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    __table_args__ = (UniqueConstraint("datasource_id", "table_name", name="uq_synced_table"),)


class ProjectRun(Base):
    """2026-10-08 (round 11): one question asked inside a multi-source
    Project (a Conversation with kind="project") and everything GD360 did
    to answer it - the plan, each step's query and result, the analysis and
    the written answer - so the Plan / Sources / Results / Evidence tabs
    can show it live while it runs and exactly as it was afterwards.

    status: planning -> planned -> running -> done | failed | stopped,
    or needs_input when the question cannot be answered from the sources
    in the project (the answer says what is missing)."""
    __tablename__ = "project_runs"

    id = Column(String, primary_key=True, default=gen_uuid)
    conversation_id = Column(String, ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False, index=True)
    owner_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    question = Column(Text, nullable=False)
    status = Column(String, nullable=False, default="planning")
    plan = Column(JSON, nullable=True)
    steps = Column(JSON, nullable=True)        # live per-step status/results
    result = Column(JSON, nullable=True)       # analysis facts, visuals, answer
    error_message = Column(Text, nullable=True)
    note = Column(Text, nullable=True)         # the person's correction to the plan, if any
    auto_run = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    started_at = Column(DateTime, nullable=True)
    finished_at = Column(DateTime, nullable=True)


class Automation(Base):
    """2026-10-08 (round 12): work that runs by itself, read as one sentence:
    WHEN (trigger) -> DO (steps, in order) -> TELL (email / Slack / Teams).

    trigger (JSON), one of:
      {"type": "schedule", "every": "hour"|"day"|"week"|"month", "time": "06:00",
       "minute": 0, "days": [0..6] (Mon=0), "day_of_month": 1}
      {"type": "new_data", "datasource_id": "..."} - runs when a synced app,
        API source or file gets new data (live databases are always current)
      {"type": "threshold", "target": {"kind": "project_run", "run_id": "..."}
                                    | {"kind": "dashboard", "dashboard_id": "..."},
       "kpi": "total" | "component:<name>" ..., "op": "below"|"above"|"drops_by"|"rises_by",
       "value": 2.0, "check": {schedule fields}} - checked on its own schedule;
        fires when the condition BECOMES true (not on every check while it stays true)
    timezone: IANA name the schedule is read in.
    steps (JSON list) - see services/automations.STEP_TYPES.
    tell (JSON): {"email": [...], "slack": {"url_enc": "...", "label": "#revenue"} | null,
                  "teams": {...} | null, "mode": "always"|"on_change"|"on_failure"}
    Webhook URLs are stored encrypted (security.encrypt_secret).
    """
    __tablename__ = "automations"

    id = Column(String, primary_key=True, default=gen_uuid)
    owner_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    workspace_id = Column(String, ForeignKey("workspaces.id"), nullable=True, index=True)
    name = Column(String, nullable=False)
    enabled = Column(Boolean, default=True, nullable=False)
    trigger = Column(JSON, nullable=False, default=dict)
    timezone = Column(String, nullable=False, default="UTC")
    steps = Column(JSON, nullable=False, default=list)
    stop_on_quality_fail = Column(Boolean, default=True, nullable=False)
    tell = Column(JSON, nullable=False, default=dict)
    next_run_at = Column(DateTime, nullable=True, index=True)
    last_run_at = Column(DateTime, nullable=True)
    last_status = Column(String, nullable=True)
    last_digest = Column(String, nullable=True)          # what was last sent, for "only if something changed"
    last_seen_data_at = Column(DateTime, nullable=True)  # new-data trigger: the data version already handled
    last_condition = Column(Boolean, nullable=True)      # threshold trigger: was it true at the last check
    last_checked_at = Column(DateTime, nullable=True)
    last_value = Column(String, nullable=True)           # threshold trigger: the value seen at the last check
    # 2026-10-10 (round 19): in a team workspace, an automation a member
    # builds that emails people outside the company waits for an owner or
    # admin's OK (workspace policy external_email_needs_approval). While
    # "pending" it stays switched off. approved_recipients is the list that
    # was approved, so adding a new outside address asks again.
    approval_status = Column(String, nullable=True)      # None | pending | approved | rejected
    approval_requested_at = Column(DateTime, nullable=True)
    approval_requested_by_id = Column(String, nullable=True)
    approved_by_id = Column(String, nullable=True)
    approved_at = Column(DateTime, nullable=True)
    approved_recipients = Column(JSON, nullable=True)
    approval_note = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class AutomationRun(Base):
    """One run of an Automation: what each step did, the message built from
    it, and what happened to each delivery. Created (status "running")
    before any work starts, like JobRun/PipelineRun, so a crash still
    leaves an honest record."""
    __tablename__ = "automation_runs"

    id = Column(String, primary_key=True, default=gen_uuid)
    automation_id = Column(String, ForeignKey("automations.id", ondelete="SET NULL"), nullable=True, index=True)
    owner_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    automation_name = Column(String, nullable=False)
    reason = Column(String, nullable=False)  # schedule | manual | test | new_data | threshold
    status = Column(String, nullable=False, default="running")  # running | success | failed
    step_results = Column(JSON, nullable=False, default=list)
    message = Column(JSON, nullable=True)       # {subject, headline, lines, kpis, link}
    deliveries = Column(JSON, nullable=False, default=list)  # [{channel, to, status, detail}]
    notified = Column(Boolean, default=False, nullable=False)
    error_message = Column(Text, nullable=True)
    started_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    finished_at = Column(DateTime, nullable=True)


class Space(Base):
    """2026-10-09 (round 15): a named, coloured group of data sources for one
    team or subject - "Marketing & Brand", "Sales", "Finance", "HR & People".
    People pick a Space when they ask a question, start ML Studio or open the
    Space's overview, instead of choosing sources one by one.

    A Space only groups sources; it never grants access to data. Whoever can
    see a Space still sees only the sources they could already access
    (services/spaces.py filters every list), so an HR Space shared with the
    whole workspace shows nothing to someone without access to the HR data.

    access: "private" (only its owner), "workspace" (every member of
    workspace_id) or "members" (its owner plus the user ids in member_ids).
    source_ids: data source ids, in the order they were added."""
    __tablename__ = "spaces"

    id = Column(String, primary_key=True, default=gen_uuid)
    owner_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    workspace_id = Column(String, ForeignKey("workspaces.id"), nullable=True, index=True)
    name = Column(String, nullable=False)
    color = Column(String, nullable=False, default="#C9A7FF")
    description = Column(Text, nullable=True)
    icon = Column(String, nullable=True)
    access = Column(String, nullable=False, default="private")
    member_ids = Column(JSON, nullable=False, default=list)
    source_ids = Column(JSON, nullable=False, default=list)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)


class AppAuthPending(Base):
    """2026-10-09 (round 15): the hand-off between an app's "Sign in with ..."
    page and the connect form (services/app_oauth.py). The OAuth callback
    stores the tokens here, encrypted, and sends the browser back to the
    connect sheet with this row's id; POST /apps (or /apps/discover) then
    turns it into the source's credentials. Only the user who signed in can
    use it, and only for 30 minutes; connecting deletes it."""
    __tablename__ = "app_auth_pending"

    id = Column(String, primary_key=True, default=gen_uuid)
    user_id = Column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    provider = Column(String, nullable=False)      # meta | google | linkedin | hubspot
    kind = Column(String, nullable=False)          # the app being connected, e.g. instagram
    encrypted_tokens = Column(Text, nullable=False)
    state_note = Column(JSON, nullable=True)       # non-secret details: scopes granted, expiry, account name
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class DemoRequest(Base):
    """2026-10-09: an Enterprise demo request from the public Pricing page
    (POST /site/demo-request). Listed for the owner on the admin page."""
    __tablename__ = "demo_requests"

    id = Column(String, primary_key=True, default=gen_uuid)
    name = Column(String, nullable=False)
    email = Column(String, nullable=False, index=True)
    company = Column(String, nullable=True)
    team_size = Column(String, nullable=True)
    question = Column(Text, nullable=True)
    status = Column(String, default="new", nullable=False)  # new | contacted | qualified | closed
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    # 2026-10-10 (Mission Control CRM): who owns the lead, notes, and the deal it became.
    owner_email = Column(String, nullable=True)
    notes = Column(Text, nullable=True)
    deal_id = Column(String, nullable=True)


# ---------------------------------------------------------------------------
# 2026-10-10: Mission Control (the internal admin portal). Every table below
# is new, so create_all() creates them; nothing here touches customer data.
# ---------------------------------------------------------------------------

class StaffMember(Base):
    """A member of the GD360 team with a role in Mission Control. Emails in
    settings.ADMIN_EMAILS are always Owners, even without a row here. A row
    can exist before its user signs up (status "invited"); access starts the
    moment someone signs in with that email."""
    __tablename__ = "staff_members"

    id = Column(String, primary_key=True, default=gen_uuid)
    email = Column(String, nullable=False, unique=True, index=True)
    role = Column(String, nullable=False, default="auditor")
    status = Column(String, nullable=False, default="active")  # active | disabled
    invited_by = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    last_seen_at = Column(DateTime, nullable=True)


class AdminAuditEvent(Base):
    """Append-only log of every action taken in Mission Control. Each row
    carries the hash of the previous one (row_hash = sha256(prev_hash + body))
    so a deleted or edited row breaks the chain and shows up."""
    __tablename__ = "admin_audit_events"

    id = Column(String, primary_key=True, default=gen_uuid)
    staff_email = Column(String, nullable=False, index=True)
    action = Column(String, nullable=False)
    target_type = Column(String, nullable=True)
    target_id = Column(String, nullable=True)
    summary = Column(Text, nullable=True)
    reason = Column(Text, nullable=True)
    before = Column(JSON, nullable=True)
    after = Column(JSON, nullable=True)
    ip = Column(String, nullable=True)
    prev_hash = Column(String, nullable=True)
    row_hash = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)


class AccessRequest(Base):
    """Just-in-time elevation: a staff member asks for one extra permission
    for a limited time; an Owner or Admin approves or denies it."""
    __tablename__ = "admin_access_requests"

    id = Column(String, primary_key=True, default=gen_uuid)
    staff_email = Column(String, nullable=False, index=True)
    permission = Column(String, nullable=False)
    reason = Column(Text, nullable=True)
    minutes = Column(Integer, nullable=False, default=60)
    status = Column(String, nullable=False, default="pending")  # pending | approved | denied | expired
    decided_by = Column(String, nullable=True)
    expires_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class AdminSetting(Base):
    """Small key/value store for Mission Control: the plan matrix, goals,
    AI caps, kill switches. Values are JSON."""
    __tablename__ = "admin_settings"

    key = Column(String, primary_key=True)
    value = Column(JSON, nullable=True)
    updated_by = Column(String, nullable=True)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class CrmDeal(Base):
    __tablename__ = "crm_deals"

    id = Column(String, primary_key=True, default=gen_uuid)
    name = Column(String, nullable=False)
    company = Column(String, nullable=True)
    domain = Column(String, nullable=True, index=True)
    contact_name = Column(String, nullable=True)
    contact_email = Column(String, nullable=True)
    stage = Column(String, nullable=False, default="new")  # new | qualified | demo | proposal | won | lost
    amount = Column(Float, nullable=True)                  # annual contract value, USD
    seats = Column(Integer, nullable=True)
    owner_email = Column(String, nullable=True)
    close_date = Column(DateTime, nullable=True)
    next_step = Column(Text, nullable=True)
    source = Column(String, nullable=True)                 # demo_request | signup | referral | manual
    demo_request_id = Column(String, nullable=True)
    lost_reason = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class CrmActivity(Base):
    __tablename__ = "crm_activities"

    id = Column(String, primary_key=True, default=gen_uuid)
    deal_id = Column(String, nullable=True, index=True)
    demo_request_id = Column(String, nullable=True, index=True)
    kind = Column(String, nullable=False, default="note")  # note | call | email | meeting | stage
    body = Column(Text, nullable=True)
    staff_email = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class SupportTicket(Base):
    __tablename__ = "support_tickets"

    id = Column(String, primary_key=True, default=gen_uuid)
    number = Column(Integer, nullable=False, unique=True, index=True)
    subject = Column(String, nullable=False)
    requester_email = Column(String, nullable=True, index=True)
    requester_user_id = Column(String, nullable=True)
    channel = Column(String, nullable=False, default="email")  # email | in_app | phone | auto
    priority = Column(String, nullable=False, default="P3")    # P1..P4
    status = Column(String, nullable=False, default="open")    # open | pending | solved | closed
    assignee_email = Column(String, nullable=True)
    tags = Column(JSON, nullable=True)
    related_type = Column(String, nullable=True)               # datasource | automation | pipeline | ml_model
    related_id = Column(String, nullable=True)
    first_response_due_at = Column(DateTime, nullable=True)
    resolution_due_at = Column(DateTime, nullable=True)
    first_responded_at = Column(DateTime, nullable=True)
    solved_at = Column(DateTime, nullable=True)
    csat = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class SupportMessage(Base):
    __tablename__ = "support_messages"

    id = Column(String, primary_key=True, default=gen_uuid)
    ticket_id = Column(String, nullable=False, index=True)
    author_kind = Column(String, nullable=False, default="customer")  # customer | staff | internal | system
    author_email = Column(String, nullable=True)
    body = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class EntitlementOverride(Base):
    __tablename__ = "entitlement_overrides"

    id = Column(String, primary_key=True, default=gen_uuid)
    workspace_id = Column(String, nullable=False, index=True)
    key = Column(String, nullable=False)
    value = Column(String, nullable=False)
    reason = Column(Text, nullable=True)
    status = Column(String, nullable=False, default="pending")  # pending | active | revoked
    requested_by = Column(String, nullable=True)
    approved_by = Column(String, nullable=True)
    expires_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class Segment(Base):
    __tablename__ = "segments"

    id = Column(String, primary_key=True, default=gen_uuid)
    name = Column(String, nullable=False)
    rules = Column(JSON, nullable=False)
    created_by = Column(String, nullable=True)
    last_count = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class FeatureFlag(Base):
    __tablename__ = "feature_flags"

    key = Column(String, primary_key=True)
    name = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    enabled = Column(Boolean, nullable=False, default=False)
    rollout_pct = Column(Integer, nullable=False, default=0)
    staff_only = Column(Boolean, nullable=False, default=False)
    segment_id = Column(String, nullable=True)
    owner_email = Column(String, nullable=True)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class Announcement(Base):
    __tablename__ = "announcements"

    id = Column(String, primary_key=True, default=gen_uuid)
    kind = Column(String, nullable=False, default="banner")  # banner | modal
    title = Column(String, nullable=False)
    body = Column(Text, nullable=True)
    cta_label = Column(String, nullable=True)
    cta_url = Column(String, nullable=True)
    segment_id = Column(String, nullable=True)                # None = everyone
    status = Column(String, nullable=False, default="draft")   # draft | live | ended
    starts_at = Column(DateTime, nullable=True)
    ends_at = Column(DateTime, nullable=True)
    created_by = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class AnnouncementReceipt(Base):
    __tablename__ = "announcement_receipts"

    id = Column(String, primary_key=True, default=gen_uuid)
    announcement_id = Column(String, nullable=False, index=True)
    user_id = Column(String, nullable=False, index=True)
    seen_at = Column(DateTime, nullable=True)
    clicked_at = Column(DateTime, nullable=True)
    dismissed_at = Column(DateTime, nullable=True)


class PrivacyRequest(Base):
    __tablename__ = "privacy_requests"

    id = Column(String, primary_key=True, default=gen_uuid)
    email = Column(String, nullable=False, index=True)
    user_id = Column(String, nullable=True)
    kind = Column(String, nullable=False, default="export")  # export | delete | correct
    status = Column(String, nullable=False, default="received")  # received | in_review | completed | rejected
    notes = Column(Text, nullable=True)
    handled_by = Column(String, nullable=True)
    received_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    due_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)


class Incident(Base):
    __tablename__ = "incidents"

    id = Column(String, primary_key=True, default=gen_uuid)
    title = Column(String, nullable=False)
    severity = Column(String, nullable=False, default="SEV-3")
    status = Column(String, nullable=False, default="open")  # open | resolved
    owner_email = Column(String, nullable=True)
    updates = Column(JSON, nullable=True)
    started_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    resolved_at = Column(DateTime, nullable=True)


class AICall(Base):
    """One model call, metered: who, which feature, which model, tokens,
    estimated cost and speed. Written by services/ai_meter.py."""
    __tablename__ = "ai_calls"

    id = Column(String, primary_key=True, default=gen_uuid)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    user_id = Column(String, nullable=True, index=True)
    feature = Column(String, nullable=True)
    provider = Column(String, nullable=True)
    model = Column(String, nullable=True)
    input_tokens = Column(Integer, nullable=True)
    output_tokens = Column(Integer, nullable=True)
    cost_usd = Column(Float, nullable=True)
    latency_ms = Column(Integer, nullable=True)
    status = Column(String, nullable=False, default="ok")  # ok | error
    error = Column(String, nullable=True)


# ---------------------------------------------------------------------------
# 2026-10-10: Initiatives - plan, run and prove any activity (an event, a
# webinar, a campaign, account-based marketing, hiring, a product build),
# plus the go-to-market layer they share: target accounts with ICP tiers,
# contacts, every engagement signal (website visits, email opens and clicks,
# registrations, attendance, walk-ins, meetings), native email campaigns,
# reminders, and the connections that bring data in (Apollo, HubSpot, CSV
# exports from ZoomInfo / Salesforce / any tool). See services/initiatives/.
# ---------------------------------------------------------------------------

def _token() -> str:
    return secrets.token_urlsafe(18)


class Initiative(Base):
    __tablename__ = "initiatives"

    id = Column(String, primary_key=True, default=gen_uuid)
    owner_id = Column(String, ForeignKey("users.id"), nullable=False)
    workspace_id = Column(String, nullable=True, index=True)
    title = Column(String, nullable=False)
    kind = Column(String, nullable=False, default="custom")  # event|webinar|campaign|abm|hiring|product|custom
    department = Column(String, nullable=True)
    status = Column(String, nullable=False, default="active")  # planning|active|done|archived
    brief = Column(Text, nullable=True)
    summary = Column(Text, nullable=True)
    starts_on = Column(String, nullable=True)   # YYYY-MM-DD
    key_date = Column(String, nullable=True)    # the event / launch / start date
    location = Column(String, nullable=True)
    budget = Column(Float, nullable=True)
    details = Column(JSON, nullable=True)       # format, audience, goal, answers
    targets = Column(JSON, nullable=True)       # [{key,label,target,unit,actual?,why}]
    phases = Column(JSON, nullable=True)        # [{id,title,window}]
    tools = Column(JSON, nullable=True)         # [{key,why}]
    plan_meta = Column(JSON, nullable=True)     # why, assumptions, learned
    audience = Column(JSON, nullable=True)      # accounts in scope: {tiers,segments,lists,all}
    public_token = Column(String, unique=True, index=True, default=_token)
    walkin_key = Column(String, nullable=False, default=_token)
    registration_open = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow)


class InitiativeTask(Base):
    __tablename__ = "initiative_tasks"

    id = Column(String, primary_key=True, default=gen_uuid)
    initiative_id = Column(String, ForeignKey("initiatives.id"), nullable=False, index=True)
    phase_id = Column(String, nullable=True)
    title = Column(String, nullable=False)
    detail = Column(Text, nullable=True)
    owner_name = Column(String, nullable=True)
    due_on = Column(String, nullable=True)      # YYYY-MM-DD
    status = Column(String, nullable=False, default="todo")  # todo|doing|review|done|blocked
    tool_key = Column(String, nullable=True)
    # deliverables: [{label, url, version, kind, added_at}] - the Figma file,
    # the doc, the build; approval: {state none|submitted|approved|changes,
    # approver, approver_email, token, note, decided_by, decided_at, history[]}
    evidence = Column(JSON, nullable=True)
    approval = Column(JSON, nullable=True)
    approval_token = Column(String, nullable=True, index=True)
    position = Column(Integer, default=0)
    origin = Column(String, default="planner")  # planner|you|assistant
    done_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class InitiativeMessage(Base):
    __tablename__ = "initiative_messages"

    id = Column(String, primary_key=True, default=gen_uuid)
    initiative_id = Column(String, ForeignKey("initiatives.id"), nullable=False, index=True)
    role = Column(String, nullable=False)  # user|assistant
    content = Column(Text, nullable=False)
    actions = Column(JSON, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class GtmProfile(Base):
    """One per workspace: the ideal customer profile accounts are scored on."""
    __tablename__ = "gtm_profiles"

    id = Column(String, primary_key=True, default=gen_uuid)
    workspace_id = Column(String, nullable=False, unique=True)
    icp = Column(JSON, nullable=True)  # industries, countries, min_employees, max_employees, titles, keywords
    site_key = Column(String, unique=True, default=_token)  # website tracking
    site_domains = Column(JSON, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow)


class GtmAccount(Base):
    __tablename__ = "gtm_accounts"
    __table_args__ = (UniqueConstraint("workspace_id", "key", name="uq_gtm_account_key"),)

    id = Column(String, primary_key=True, default=gen_uuid)
    workspace_id = Column(String, nullable=False, index=True)
    key = Column(String, nullable=False)  # domain, else normalised name
    name = Column(String, nullable=False)
    domain = Column(String, nullable=True, index=True)
    industry = Column(String, nullable=True)
    employees = Column(Integer, nullable=True)
    revenue = Column(Float, nullable=True)
    country = Column(String, nullable=True)
    region = Column(String, nullable=True)
    city = Column(String, nullable=True)
    segment = Column(String, nullable=True)
    list_name = Column(String, nullable=True)
    linkedin_url = Column(String, nullable=True)
    owner_name = Column(String, nullable=True)
    source = Column(String, nullable=True)  # csv|apollo|hubspot|registration|walk_in|manual|website
    external_ids = Column(JSON, nullable=True)
    icp_score = Column(Integer, nullable=True)
    icp_tier = Column(String, nullable=True)  # A|B|C
    icp_reasons = Column(JSON, nullable=True)
    engagement_score = Column(Float, default=0)
    engagement_7d = Column(Float, default=0)
    last_engaged_at = Column(DateTime, nullable=True)
    notes = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow)


class GtmContact(Base):
    __tablename__ = "gtm_contacts"
    __table_args__ = (UniqueConstraint("workspace_id", "email", name="uq_gtm_contact_email"),)

    id = Column(String, primary_key=True, default=gen_uuid)
    workspace_id = Column(String, nullable=False, index=True)
    account_id = Column(String, ForeignKey("gtm_accounts.id"), nullable=True, index=True)
    email = Column(String, nullable=True)
    name = Column(String, nullable=True)
    title = Column(String, nullable=True)
    seniority = Column(String, nullable=True)
    phone = Column(String, nullable=True)
    linkedin_url = Column(String, nullable=True)
    country = Column(String, nullable=True)
    source = Column(String, nullable=True)
    subscribed = Column(Boolean, default=False)   # on the newsletter list
    unsubscribed = Column(Boolean, default=False)  # never email again
    lists = Column(JSON, nullable=True)
    visitor_ids = Column(JSON, nullable=True)  # website visitor ids stitched to this person
    created_at = Column(DateTime, default=datetime.utcnow)


class GtmEngagement(Base):
    __tablename__ = "gtm_engagements"

    id = Column(String, primary_key=True, default=gen_uuid)
    workspace_id = Column(String, nullable=False, index=True)
    account_id = Column(String, nullable=True, index=True)
    contact_id = Column(String, nullable=True, index=True)
    initiative_id = Column(String, nullable=True, index=True)
    campaign_id = Column(String, nullable=True)
    kind = Column(String, nullable=False)
    channel = Column(String, nullable=True)
    detail = Column(JSON, nullable=True)
    visitor_id = Column(String, nullable=True, index=True)
    occurred_at = Column(DateTime, default=datetime.utcnow, index=True)


class GtmCampaign(Base):
    __tablename__ = "gtm_campaigns"

    id = Column(String, primary_key=True, default=gen_uuid)
    workspace_id = Column(String, nullable=False, index=True)
    initiative_id = Column(String, nullable=True, index=True)
    owner_id = Column(String, nullable=False)
    name = Column(String, nullable=False)
    subject = Column(String, nullable=False, default="")
    body = Column(Text, nullable=False, default="")
    audience = Column(JSON, nullable=True)
    status = Column(String, nullable=False, default="draft")  # draft|scheduled|sending|sent|failed
    scheduled_at = Column(DateTime, nullable=True)
    sent_at = Column(DateTime, nullable=True)
    error = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class GtmCampaignSend(Base):
    __tablename__ = "gtm_campaign_sends"

    id = Column(String, primary_key=True, default=gen_uuid)
    campaign_id = Column(String, ForeignKey("gtm_campaigns.id"), nullable=False, index=True)
    contact_id = Column(String, nullable=True)
    email = Column(String, nullable=False)
    token = Column(String, unique=True, index=True, default=_token)
    status = Column(String, nullable=False, default="queued")  # queued|sent|failed|skipped
    error = Column(String, nullable=True)
    sent_at = Column(DateTime, nullable=True)
    opened_at = Column(DateTime, nullable=True)
    clicked_at = Column(DateTime, nullable=True)


class GtmConnection(Base):
    __tablename__ = "gtm_connections"
    __table_args__ = (UniqueConstraint("workspace_id", "provider", name="uq_gtm_connection"),)

    id = Column(String, primary_key=True, default=gen_uuid)
    workspace_id = Column(String, nullable=False, index=True)
    provider = Column(String, nullable=False)  # apollo|hubspot|ipinfo
    secret_enc = Column(Text, nullable=True)
    masked = Column(String, nullable=True)
    status = Column(String, default="connected")
    last_sync_at = Column(DateTime, nullable=True)
    last_error = Column(Text, nullable=True)
    meta = Column(JSON, nullable=True)
    created_by = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class GtmReminder(Base):
    __tablename__ = "gtm_reminders"

    id = Column(String, primary_key=True, default=gen_uuid)
    workspace_id = Column(String, nullable=True, index=True)
    owner_id = Column(String, nullable=False, index=True)
    initiative_id = Column(String, nullable=True, index=True)
    task_id = Column(String, nullable=True)
    account_id = Column(String, nullable=True)
    note = Column(String, nullable=False)
    remind_at = Column(DateTime, nullable=False, index=True)
    sent_at = Column(DateTime, nullable=True)
    done = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)


class InitiativeItem(Base):
    """A card on an initiative's board: a candidate (hiring), a feature or
    story (product build), a target account moving through the pipeline
    (ABM, events, campaigns) or anything else a custom initiative tracks."""
    __tablename__ = "initiative_items"

    id = Column(String, primary_key=True, default=gen_uuid)
    initiative_id = Column(String, ForeignKey("initiatives.id"), nullable=False, index=True)
    group_name = Column(String, nullable=True)   # the role, the milestone, the segment
    title = Column(String, nullable=False)
    subtitle = Column(String, nullable=True)
    stage = Column(String, nullable=False)
    email = Column(String, nullable=True)
    link = Column(String, nullable=True)
    account_id = Column(String, nullable=True)
    owner_name = Column(String, nullable=True)
    notes = Column(Text, nullable=True)
    data = Column(JSON, nullable=True)
    position = Column(Integer, default=0)
    stage_changed_at = Column(DateTime, default=datetime.utcnow)
    created_at = Column(DateTime, default=datetime.utcnow)


class InitiativeUpdate(Base):
    """The initiative's running log - what happened, with numbers: "design
    approved", "LinkedIn post live, reach 4,200, 63 clicks", "landing page
    B live". Feeds Today, the results and the assistant."""
    __tablename__ = "initiative_updates"

    id = Column(String, primary_key=True, default=gen_uuid)
    initiative_id = Column(String, ForeignKey("initiatives.id"), nullable=False, index=True)
    kind = Column(String, nullable=False, default="update")  # update|approval|post|metric|milestone|risk|deliverable|system
    text = Column(Text, nullable=False)
    channel = Column(String, nullable=True)
    link = Column(String, nullable=True)
    numbers = Column(JSON, nullable=True)   # {"reach": 4200, "clicks": 63, ...}
    task_id = Column(String, nullable=True)
    link_id = Column(String, nullable=True)  # the tracked post / ad / page the numbers belong to
    paid = Column(Boolean, nullable=True)
    region = Column(String, nullable=True)
    author = Column(String, nullable=True)
    occurred_at = Column(DateTime, default=datetime.utcnow, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class InitiativeLink(Base):
    """A tracked asset: a landing page, a social post, an ad, any link. Each
    gets a short GD360 link (/public/gtm/l/{code}) that counts clicks and
    tags the visit, and landing pages report visits and conversions."""
    __tablename__ = "initiative_links"

    id = Column(String, primary_key=True, default=gen_uuid)
    initiative_id = Column(String, ForeignKey("initiatives.id"), nullable=False, index=True)
    workspace_id = Column(String, nullable=False, index=True)
    kind = Column(String, nullable=False, default="landing_page")  # landing_page|social_post|ad|email|other
    label = Column(String, nullable=False)
    url = Column(String, nullable=False)
    channel = Column(String, nullable=True)   # linkedin, instagram, google_ads ...
    variant = Column(String, nullable=True)   # A / B
    paid = Column(Boolean, default=False)     # organic post vs paid promotion
    region = Column(String, nullable=True)    # e.g. US - only what this initiative is about
    code = Column(String, unique=True, index=True, default=lambda: secrets.token_urlsafe(6))
    clicks = Column(Integer, default=0)
    last_click_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class InitiativeMember(Base):
    """A person working on an initiative - a GD360 user or not - with a role,
    a team, their own targets, and a private link to their own "My invites"
    page (/r/{token}) where they log personal outreach in two taps."""
    __tablename__ = "initiative_members"

    id = Column(String, primary_key=True, default=gen_uuid)
    initiative_id = Column(String, ForeignKey("initiatives.id"), nullable=False, index=True)
    name = Column(String, nullable=False)
    email = Column(String, nullable=True)
    user_id = Column(String, nullable=True)
    role = Column(String, nullable=True)       # Account executive, SDR, Booth staff ...
    team = Column(String, nullable=True)       # "Team West", "Enterprise"
    targets = Column(JSON, nullable=True)      # {"invites": 30, "registrations": 10, "meetings": 4}
    token = Column(String, unique=True, index=True, default=lambda: secrets.token_urlsafe(18))
    ref = Column(String, unique=True, index=True, default=lambda: secrets.token_urlsafe(5))
    last_update_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class InitiativeOutreach(Base):
    """One account / person a team member is working for this initiative,
    and where it stands: not contacted -> invited -> replied -> interested
    -> registered -> attended -> meeting -> opportunity (or declined)."""
    __tablename__ = "initiative_outreach"

    id = Column(String, primary_key=True, default=gen_uuid)
    initiative_id = Column(String, ForeignKey("initiatives.id"), nullable=False, index=True)
    member_id = Column(String, nullable=True, index=True)
    account_id = Column(String, nullable=True, index=True)
    contact_id = Column(String, nullable=True, index=True)
    person_name = Column(String, nullable=True)
    segment = Column(String, nullable=True)    # target | customer
    status = Column(String, nullable=False, default="not_contacted")
    channel = Column(String, nullable=True)    # last channel used
    touches = Column(Integer, default=0)
    last_touch_at = Column(DateTime, nullable=True)
    next_step = Column(String, nullable=True)
    next_step_on = Column(String, nullable=True)
    notes = Column(Text, nullable=True)
    history = Column(JSON, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow)



# ============================================================================
# 2026-10-10 (round 19): Automations home, Trust Center, company domain.
# ============================================================================

class SyncRun(Base):
    """One sync of a synced app source (Shopify, GA4, Meta Ads, Google Ads):
    written by services/synced_sources.sync_datasource so the Automations
    home can show the same run history for syncs as for everything else."""
    __tablename__ = "sync_runs"

    id = Column(String, primary_key=True, default=gen_uuid)
    datasource_id = Column(String, ForeignKey("datasources.id", ondelete="CASCADE"), nullable=False, index=True)
    owner_id = Column(String, nullable=True, index=True)
    reason = Column(String, nullable=False, default="schedule")   # schedule | manual | automation
    status = Column(String, nullable=False, default="running")    # running | success | failed
    error_message = Column(Text, nullable=True)
    rows = Column(Integer, nullable=True)
    started_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    finished_at = Column(DateTime, nullable=True)


class SensitiveColumn(Base):
    """A column the Trust Center found (or a person marked) as holding
    personal or sensitive data. status: flagged (found, nobody decided yet),
    confirmed (yes, sensitive) or dismissed (not sensitive - never flagged
    again). category: email | phone | name | address | birth_date | salary |
    government_id | payment | ip_address | health | other."""
    __tablename__ = "sensitive_columns"
    __table_args__ = (UniqueConstraint("datasource_id", "table_name", "column_name", name="uq_sensitive_column"),)

    id = Column(String, primary_key=True, default=gen_uuid)
    datasource_id = Column(String, ForeignKey("datasources.id", ondelete="CASCADE"), nullable=False, index=True)
    table_name = Column(String, nullable=False, default="")
    column_name = Column(String, nullable=False)
    category = Column(String, nullable=False, default="other")
    reason = Column(String, nullable=True)          # "column name", "values look like emails" ...
    source = Column(String, nullable=False, default="auto")   # auto | manual
    status = Column(String, nullable=False, default="flagged")
    decided_by_id = Column(String, nullable=True)
    decided_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class LoginCode(Base):
    """A one-time 6-digit sign-in code sent by email (viewers on a company
    domain can sign in with one instead of a password). Only a SHA-256 hash
    of the code is stored; five wrong tries burn it."""
    __tablename__ = "login_codes"

    id = Column(String, primary_key=True, default=gen_uuid)
    email = Column(String, nullable=False, index=True)
    code_hash = Column(String, nullable=False)
    purpose = Column(String, nullable=False, default="sign_in")
    host = Column(String, nullable=True)
    attempts = Column(Integer, nullable=False, default=0)
    expires_at = Column(DateTime, nullable=False)
    used_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class WorkspaceDomain(Base):
    """A company's own address for its dashboards (e.g. data.acmeretail.com):
    one per workspace. Owners and admins connect it with two DNS records -
    a CNAME to GD360 and a TXT record proving they control the domain - and
    GD360 then registers it with Render, which issues the HTTPS certificate.

    status: pending_dns (records not found yet) -> pending_ssl (records
    found, certificate being issued) -> live; or error.
    audience: who may open dashboards here by default -
      "company"  : anyone signing in with an email at one of allowed_email_domains
      "invited"  : only invited_emails (plus workspace members)
      "public"   : anyone, no sign-in (refused while sensitive data is published)
    Each published dashboard can be stricter, never looser."""
    __tablename__ = "workspace_domains"

    id = Column(String, primary_key=True, default=gen_uuid)
    workspace_id = Column(String, ForeignKey("workspaces.id"), nullable=False, unique=True, index=True)
    hostname = Column(String, nullable=False, unique=True, index=True)
    verify_token = Column(String, nullable=False, default=lambda: secrets.token_hex(8))
    status = Column(String, nullable=False, default="pending_dns")
    dns_cname_ok = Column(Boolean, nullable=False, default=False)
    dns_txt_ok = Column(Boolean, nullable=False, default=False)
    render_custom_domain_id = Column(String, nullable=True)
    last_error = Column(Text, nullable=True)
    last_checked_at = Column(DateTime, nullable=True)
    verified_at = Column(DateTime, nullable=True)
    live_at = Column(DateTime, nullable=True)
    audience = Column(String, nullable=False, default="company")
    allowed_email_domains = Column(JSON, nullable=True)
    invited_emails = Column(JSON, nullable=True)
    site_title = Column(String, nullable=True)        # "Acme Retail Data"
    show_powered_by = Column(Boolean, nullable=False, default=True)
    publish_needs_approval = Column(Boolean, nullable=False, default=True)
    logo_image = Column(LargeBinary, nullable=True)
    logo_content_type = Column(String, nullable=True)
    created_by_id = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class DomainPublication(Base):
    """One dashboard published at a path on a WorkspaceDomain
    (data.acmeretail.com/sales). status: pending (a member asked; an owner
    or admin decides), live, rejected, removed.
    audience: "domain" (the domain's default), "invited" (invited_emails
    only) or "members" (members of the workspace only).
    row_rule: optional per-viewer row filter -
      {"column": "region", "table": null, "by_email": {"dana@x.com": ["North"]},
       "by_domain": {"x.com": [...]}, "default": [] }  (empty = sees nothing)"""
    __tablename__ = "domain_publications"
    __table_args__ = (UniqueConstraint("domain_id", "path", name="uq_domain_publication_path"),)

    id = Column(String, primary_key=True, default=gen_uuid)
    domain_id = Column(String, ForeignKey("workspace_domains.id", ondelete="CASCADE"), nullable=False, index=True)
    workspace_id = Column(String, nullable=False, index=True)
    dashboard_id = Column(String, ForeignKey("dashboards.id", ondelete="CASCADE"), nullable=False, index=True)
    path = Column(String, nullable=False)              # "sales" (no slashes at the ends)
    title = Column(String, nullable=True)
    audience = Column(String, nullable=False, default="domain")
    invited_emails = Column(JSON, nullable=True)
    row_rule = Column(JSON, nullable=True)
    status = Column(String, nullable=False, default="live")
    requested_by_id = Column(String, nullable=True)
    requested_at = Column(DateTime, nullable=True)
    request_note = Column(Text, nullable=True)
    decided_by_id = Column(String, nullable=True)
    decided_at = Column(DateTime, nullable=True)
    decision_note = Column(Text, nullable=True)
    published_at = Column(DateTime, nullable=True)
    view_count = Column(Integer, nullable=False, default=0)
    last_viewed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class DomainView(Base):
    """One signed-in visit to a published dashboard on a company domain -
    who opened what and when (for "viewers, 30 days" and the audit log)."""
    __tablename__ = "domain_views"

    id = Column(String, primary_key=True, default=gen_uuid)
    publication_id = Column(String, ForeignKey("domain_publications.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(String, nullable=True, index=True)
    email = Column(String, nullable=True)
    viewed_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)


class DomainAccessRequest(Base):
    """A viewer on the company domain asking to open a dashboard they can't
    see yet ("Ask for access"). Owners, admins and the publisher decide."""
    __tablename__ = "domain_access_requests"

    id = Column(String, primary_key=True, default=gen_uuid)
    publication_id = Column(String, ForeignKey("domain_publications.id", ondelete="CASCADE"), nullable=False, index=True)
    workspace_id = Column(String, nullable=False, index=True)
    user_id = Column(String, nullable=True)
    email = Column(String, nullable=False)
    note = Column(Text, nullable=True)
    status = Column(String, nullable=False, default="pending")   # pending | approved | declined
    decided_by_id = Column(String, nullable=True)
    decided_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class DomainSubscription(Base):
    """A viewer's weekly email with the link to a published dashboard
    ("Email me on Mondays"). Sent Mondays 08:00 in the viewer's time zone."""
    __tablename__ = "domain_subscriptions"
    __table_args__ = (UniqueConstraint("publication_id", "user_id", name="uq_domain_subscription"),)

    id = Column(String, primary_key=True, default=gen_uuid)
    publication_id = Column(String, ForeignKey("domain_publications.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(String, nullable=False, index=True)
    email = Column(String, nullable=False)
    timezone = Column(String, nullable=False, default="UTC")
    next_send_at = Column(DateTime, nullable=True, index=True)
    last_sent_at = Column(DateTime, nullable=True)
    last_error = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
