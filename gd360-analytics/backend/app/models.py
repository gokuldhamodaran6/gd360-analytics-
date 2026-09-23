"""
ORM models for the GD360 Analytics application database.
"""
import uuid
from datetime import datetime

from sqlalchemy import (
    Column, String, DateTime, ForeignKey, Text, JSON, Boolean, Integer, LargeBinary, BigInteger,
    UniqueConstraint, Index,
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

    datasources = relationship("DataSource", back_populates="owner", cascade="all, delete-orphan")
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

    owner = relationship("User", back_populates="datasources")
    versions = relationship(
        "DatasetVersion", back_populates="datasource", cascade="all, delete-orphan",
        order_by="DatasetVersion.position",
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
    A named board of pinned charts, built by clicking "Save chart to
    dashboard" from the AI workspace (see routers/dashboards.py).

    owner_id is always who CREATED this dashboard - that never changes.
    workspace_id (added 2026-09-23, shared dashboards v1) is optional and
    separate: NULL keeps a dashboard exactly as it always worked, visible
    and editable only by its creator; set, it shares the whole dashboard
    with every member of that workspace on the same view/editable split
    used everywhere else a workspace shares something (see
    routers/dashboards.py for the exact rule) - so a team can build one
    curated set of charts together instead of everyone re-saving the same
    numbers into their own private dashboard.
    """
    __tablename__ = "dashboards"

    id = Column(String, primary_key=True, default=gen_uuid)
    owner_id = Column(String, ForeignKey("users.id"), nullable=False)
    workspace_id = Column(String, ForeignKey("workspaces.id"), nullable=True)
    name = Column(String, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    owner = relationship("User", back_populates="dashboards")
    charts = relationship("SavedChart", back_populates="dashboard", cascade="all, delete-orphan")


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
