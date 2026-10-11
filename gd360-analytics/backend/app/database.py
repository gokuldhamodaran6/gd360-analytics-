"""
SQLAlchemy engine/session setup for the *application* database
(users, datasource metadata, conversation history, saved charts).

This is separate from any customer database a user connects for analysis -
those are only ever touched read-only, on demand, via services/connectors.py.
"""
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import sessionmaker, declarative_base

from .config import get_settings

settings = get_settings()

connect_args = {"check_same_thread": False} if settings.DATABASE_URL.startswith("sqlite") else {}

engine = create_engine(settings.DATABASE_URL, connect_args=connect_args, pool_pre_ping=True)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    # Creates tables if they do not already exist. For production
    # evolution, swap this for Alembic migrations - noted in README.
    from . import models  # noqa: F401  (ensure models are registered)
    Base.metadata.create_all(bind=engine)
    _ensure_new_columns()
    _ensure_personal_workspaces()


# Every column added to an existing model after it first went live needs an
# entry here (table, column name, SQL type) - see _ensure_new_columns below.
# A brand new TABLE (e.g. dashboard_pages/dashboard_blocks/dashboard_shares,
# added 2026-09-24) needs no entry here at all - create_all() above already
# creates any table that doesn't exist yet; this list is only for a new
# COLUMN on a table that already exists in production.
_NEW_COLUMNS = [
    ("messages", "code", "TEXT"),
    ("messages", "action", "TEXT"),
    ("messages", "chart_type", "TEXT"),
    ("messages", "verified_count", "INTEGER DEFAULT 0"),
    ("conversations", "pinned", "BOOLEAN DEFAULT FALSE"),
    ("messages", "result_columns", "JSON"),
    ("messages", "result_rows", "JSON"),
    ("messages", "result_truncated", "BOOLEAN DEFAULT FALSE"),
    ("messages", "sources", "JSON"),
    ("messages", "new_version_id", "TEXT"),
    ("datasources", "workspace_id", "TEXT"),
    ("dashboards", "workspace_id", "TEXT"),
    ("conversations", "folder_id", "TEXT"),
    ("users", "token_version", "INTEGER DEFAULT 0"),
    ("dashboards", "layout_version", "INTEGER DEFAULT 1"),
    ("dashboards", "source_conversation_id", "TEXT"),
    # Dashboard Builder Phase 3 (2026-09-24): private sharing's optional
    # shared password - dashboard_shares itself is a table added 2026-09-24
    # (Phase 1), already live in production before this column existed, so
    # it needs the normal ALTER-TABLE treatment like any other new column on
    # an existing table. dashboard_share_emails is a brand NEW table added
    # the same round - per this file's own note above, that needs no entry
    # here at all.
    ("dashboard_shares", "password_hash", "TEXT"),
    # Dashboard Builder Phase 4 (2026-09-24): white-label custom domains -
    # see models.DashboardShare's own docstring and services/render_domains.py.
    ("dashboard_shares", "custom_domain", "TEXT"),
    ("dashboard_shares", "render_custom_domain_id", "TEXT"),
    ("dashboard_shares", "custom_domain_status", "TEXT"),
    ("dashboard_shares", "custom_domain_error", "TEXT"),
    # Round 4 (2026-09-25): per-dashboard branding/customization - logo,
    # brand colors, background. logo_image/background_image are BYTEA (the
    # Postgres type LargeBinary maps to - production runs on Supabase
    # Postgres, not SQLite) for the same reason DataSource.file_data is:
    # Render's web services reset their local disk on every deploy, so raw
    # bytes have to live in the database to survive one. See
    # models.Dashboard's own docstring for what each column means.
    ("dashboards", "brand_primary_color", "TEXT"),
    ("dashboards", "brand_accent_color", "TEXT"),
    ("dashboards", "background_style", "TEXT"),
    ("dashboards", "background_color", "TEXT"),
    ("dashboards", "logo_image", "BYTEA"),
    ("dashboards", "logo_image_content_type", "TEXT"),
    ("dashboards", "background_image", "BYTEA"),
    ("dashboards", "background_image_content_type", "TEXT"),
    # Round 4: a page's own background tint override - see
    # models.DashboardPage's own docstring.
    ("dashboard_pages", "background_color", "TEXT"),
    # 2026-09-25g (live-data freshness round): when a block's DATA was last
    # actually recomputed - see models.DashboardBlock's own docstring for
    # exactly which code paths advance it (never a plain drag/resize/
    # rename, and never a chart restyle).
    ("dashboard_blocks", "data_updated_at", "TIMESTAMP"),
    # 2026-09-28 (scheduled auto-refresh round): see models.Dashboard's own
    # docstring for what each of these means.
    ("dashboards", "refresh_interval", "TEXT"),
    ("dashboards", "next_refresh_at", "TIMESTAMP"),
    ("dashboards", "last_refreshed_at", "TIMESTAMP"),
    # 2026-09-28 (streaming/webhook ingestion round): see
    # models.DataSource's own docstring for what each of these means.
    # job_runs and streamed_events are brand NEW tables added the same
    # round - per this file's own note above, a new table needs no entry
    # here at all (create_all() already creates it).
    ("datasources", "webhook_secret_encrypted", "TEXT"),
    ("datasources", "last_event_at", "TIMESTAMP"),
    # Phase 2, feature 1 (shared, reusable models): see
    # models.DatasetVersion's own docstring for what each of these means.
    # dataset_versions is an existing table (live since before this round),
    # so - unlike flow_annotations below - its new columns need the normal
    # ALTER-TABLE treatment here.
    ("dataset_versions", "is_shared_model", "BOOLEAN DEFAULT FALSE"),
    ("dataset_versions", "shared_model_description", "TEXT"),
    ("dataset_versions", "shared_model_promoted_at", "TIMESTAMP"),
    # Phase 2, feature 4 (generic API/webhook PULL connector): see
    # models.DataSource's own docstring for what this means. flow_annotations
    # (feature 2) is a brand NEW table added the same round - per this
    # file's own note above, a new table needs no entry here at all
    # (create_all() already creates it).
    ("datasources", "api_last_refreshed_at", "TIMESTAMP"),
    # Phase 5, Batch A (2026-09-28, data governance & quality): see
    # models.DataSource's own docstring for what these two mean.
    # data_quality_rules and audit_events are brand NEW tables added the
    # same round - per this file's own note above, a new table needs no
    # entry here at all (create_all() already creates it).
    ("datasources", "governance_last_reviewed_at", "TIMESTAMP"),
    ("datasources", "governance_last_reviewed_by_id", "TEXT"),
    # Phase 5, Batch B (data governance & quality - row/column permissions):
    # data_access_rules is a brand NEW table added this round - per this
    # file's own note above, a new table needs no entry here at all
    # (create_all() already creates it).
    # 2026-09-28 (ML Models round): ml_models and ml_predictions are both
    # brand NEW tables added this round - per this file's own note above, a
    # new table needs no entry here at all (create_all() already creates
    # both). See models.MLModel/MLPrediction's own docstrings for what they
    # hold.
    # 2026-09-28 (transparency round): see models.Message.steps' own
    # docstring for what this holds.
    ("messages", "steps", "JSON"),
    # 2026-09-28 (multi-result round): see models.Message.results and
    # models.Message.self_critique's own docstrings for what these hold.
    ("messages", "results", "JSON"),
    ("messages", "self_critique", "TEXT"),
    # 2026-09-28 (Flow tab transparency round): real, honestly-captured
    # timing + a short "what actually ran" summary for the Flow tab's
    # cards - see models.DatasetVersion.duration_ms/method_summary and
    # models.Message.duration_ms/method_summary for what these hold and
    # how they're derived (never fabricated - either a real wall-clock
    # measurement or read straight off the code that actually executed).
    ("dataset_versions", "duration_ms", "INTEGER"),
    ("dataset_versions", "method_summary", "TEXT"),
    ("messages", "duration_ms", "INTEGER"),
    ("messages", "method_summary", "TEXT"),
    # 2026-09-29 (design revamp): single-level per-block undo - see
    # models.DashboardBlock.previous_config's own docstring for exactly
    # what this holds and when it's set/cleared.
    ("dashboard_blocks", "previous_config", "JSON"),
    # 2026-09-30 (model trustworthiness round): ml_models and ml_predictions
    # are both existing tables (live since the 2026-09-28 ML Models round),
    # so their new columns need the normal ALTER-TABLE treatment here - see
    # models.MLModel/MLModelVersion/MLPrediction's own docstrings for what
    # each one means. ml_model_versions is a brand NEW table added this same
    # round - per this file's own note above, a new table needs no entry
    # here at all (create_all() already creates it).
    ("ml_models", "feature_importance", "JSON"),
    ("ml_models", "version_number", "INTEGER DEFAULT 1"),
    ("ml_predictions", "model_version_id", "TEXT"),
    ("ml_predictions", "explanation", "JSON"),
    # 2026-09-30 (data catalog v1): see models.DataSource.description's own
    # comment. pipelines and pipeline_runs are both brand NEW tables added
    # in the orchestration-v1 round just before this one - per this file's
    # own note above, a new table needs no entry here at all
    # (create_all() already creates it).
    ("datasources", "description", "TEXT"),
    # 2026-09-30 (leakage-guardrail round): see models.MLModel/
    # MLModelVersion.quality_warnings's own docstrings for what this holds.
    # Both ml_models and ml_model_versions are existing tables (live since
    # the 2026-09-28/2026-09-30 ML Models rounds), so this new column on
    # each needs the normal ALTER-TABLE treatment here, same as
    # feature_importance did just above.
    ("ml_models", "quality_warnings", "JSON"),
    ("ml_model_versions", "quality_warnings", "JSON"),
    # 2026-10-06 (pushdown-honesty round): see models.DatasetVersion.
    # used_pushdown/sample_row_count and models.Message.used_pushdown/
    # sample_row_count's own docstrings for what these hold and why - the
    # real-vs-sample disclosure for a chat/chart answer. Both messages and
    # dataset_versions are existing tables (live since before this round),
    # so these need the normal ALTER-TABLE treatment here, same as
    # duration_ms/method_summary did for the exact same two tables above.
    ("dataset_versions", "used_pushdown", "BOOLEAN"),
    ("dataset_versions", "sample_row_count", "INTEGER"),
    ("messages", "used_pushdown", "BOOLEAN"),
    ("messages", "sample_row_count", "INTEGER"),
    # 2026-10-06 (warehouse-honesty round): see models.Message.pushdown_sql
    # and friends' own docstring. messages is an existing table, so these
    # need the normal ALTER-TABLE treatment. JSON for pushdown_attempts
    # follows the exact precedent of messages.steps/results above (a
    # Column(JSON) model column added as a plain "JSON" ALTER - works on
    # both Postgres and SQLite). BIGINT for bytes_scanned, not INTEGER: a
    # multi-GiB BigQuery scan overflows a 32-bit INTEGER on Postgres.
    ("messages", "pushdown_sql", "TEXT"),
    ("messages", "pushdown_attempts", "JSON"),
    ("messages", "pushdown_bytes_scanned", "BIGINT"),
    ("messages", "pushdown_duration_ms", "INTEGER"),
    ("messages", "pushdown_result_rows", "INTEGER"),
    ("messages", "pushdown_skipped_reason", "TEXT"),
    # 2026-10-06 ("generated data is a saved query" layer): see
    # models.DatasetVersion.source_kind and friends' own docstring.
    # dataset_versions is an existing table, so these need the normal
    # ALTER-TABLE treatment. All nullable (this helper can only ADD a
    # nullable column - `data` stays NOT NULL and a warehouse version
    # stores b"" there). JSON for columns_json follows messages.steps'
    # precedent; BIGINT for row_count because a warehouse table can
    # exceed 2^31 rows.
    ("dataset_versions", "source_kind", "TEXT"),
    ("dataset_versions", "query_sql", "TEXT"),
    ("dataset_versions", "sql_alias", "TEXT"),
    ("dataset_versions", "source_table", "TEXT"),
    ("dataset_versions", "columns_json", "JSON"),
    ("dataset_versions", "row_count", "BIGINT"),
    # 2026-10-06 (warehouse-native dashboards layer): see models.Dashboard.
    # parameters/saved_views/default_period/date_column and models.
    # DashboardBlock.query_sql/last_run's own docstrings. dashboards and
    # dashboard_blocks are both existing tables, so these need the normal
    # ALTER-TABLE treatment; all nullable, JSON follows messages.steps'
    # precedent.
    ("dashboards", "parameters", "JSON"),
    ("dashboards", "saved_views", "JSON"),
    ("dashboards", "default_period", "TEXT"),
    ("dashboards", "date_column", "TEXT"),
    ("dashboard_blocks", "query_sql", "TEXT"),
    ("dashboard_blocks", "last_run", "JSON"),
    # 2026-10-07 (dashboard-from-prompt round): see models.Dashboard.
    # datasource_id's own comment - the direct data-source link a
    # dashboard built from a goal (no conversation) needs. dashboards is an
    # existing table, so this needs the normal ALTER-TABLE treatment.
    # dashboard_comments is a brand NEW table added the same round - per
    # this file's own note above, a new table needs no entry here at all
    # (create_all() already creates it).
    ("dashboards", "datasource_id", "TEXT"),
    # 2026-10-07 (chart-integrity round, "say what was filtered"): see
    # models.Message.query_filters' own comment. messages is an existing
    # table, so this needs the normal ALTER-TABLE treatment; nullable, and
    # JSON follows messages.steps/pushdown_attempts' precedent (works on
    # both Postgres and SQLite).
    ("messages", "query_filters", "JSON"),
    # 2026-10-07 (identity-colour round): see models.Dashboard.appearance
    # and models.Workspace.brand_kit's own comments - a dashboard's look
    # (palette, colour-by-value registry, pins, density, font, currency...)
    # and the workspace-level default it starts from. dashboards and
    # workspaces are both existing tables, so these need the normal
    # ALTER-TABLE treatment; nullable, and JSON follows dashboards.
    # parameters' precedent (works on both Postgres and SQLite).
    ("dashboards", "appearance", "JSON"),
    ("workspaces", "brand_kit", "JSON"),
    # 2026-10-08 (round 11, multi-source Projects): a Conversation can now
    # be a "project" spanning several data sources (services/project_engine).
    # NULL kind = the original one-source chat analysis, unchanged.
    ("conversations", "kind", "TEXT"),
    ("conversations", "source_ids", "JSON"),
    ("conversations", "workspace_id", "TEXT"),
    # A synced app source (Shopify, GA4, Meta Ads, Google Ads) records when
    # it last pulled data and when it is due again (services/synced_sources).
    ("datasources", "last_synced_at", "TIMESTAMP"),
    ("datasources", "next_sync_at", "TIMESTAMP"),
    ("datasources", "sync_error", "TEXT"),
    ("dashboards", "project_spec", "JSON"),
    ("dashboards", "project_snapshot", "JSON"),
    ("dashboards", "snapshot_at", "TIMESTAMP"),
    # 2026-10-08 (round 13): ML Studio (services/ml_studio.py).
    ("ml_models", "problem_type", "TEXT"),
    ("ml_models", "goal", "TEXT"),
    ("ml_models", "table_name", "TEXT"),
    ("ml_models", "plan", "JSON"),
    ("ml_models", "progress", "JSON"),
    ("ml_models", "results", "JSON"),
    ("ml_models", "started_at", "TIMESTAMP"),
    ("ml_models", "stop_requested", "BOOLEAN"),
    # 2026-10-09 (round 15): Spaces. spaces and app_auth_pending are brand NEW
    # tables (create_all() creates them); conversations is an existing table,
    # so the project's Space needs the normal ALTER-TABLE treatment.
    ("conversations", "space_id", "TEXT"),
    # 2026-10-11 (Ask Journey): which answers are on which dashboard
    ("conversations", "thread_meta", "JSON"),
    # 2026-10-10 (Mission Control): suspension + CRM fields on demo requests.
    ("users", "disabled_at", "TIMESTAMP"),
    ("demo_requests", "owner_email", "TEXT"),
    ("demo_requests", "notes", "TEXT"),
    ("demo_requests", "deal_id", "TEXT"),
    # 2026-10-10 (round 19): Trust Center, Automations approvals, 2-step
    # sign-in, share view counts. (sync_runs, sensitive_columns,
    # login_codes and the workspace_domains/domain_* tables are new tables -
    # create_all() makes them.)
    ("users", "mfa_secret_enc", "TEXT"),
    ("users", "mfa_enabled_at", "TIMESTAMP"),
    ("users", "mfa_recovery_hashes", "JSON"),
    ("users", "email_verified_at", "TIMESTAMP"),
    ("workspaces", "policies", "JSON"),
    ("automations", "approval_status", "TEXT"),
    ("automations", "approval_requested_at", "TIMESTAMP"),
    ("automations", "approval_requested_by_id", "TEXT"),
    ("automations", "approved_by_id", "TEXT"),
    ("automations", "approved_at", "TIMESTAMP"),
    ("automations", "approved_recipients", "JSON"),
    ("automations", "approval_note", "TEXT"),
    ("dashboard_shares", "view_count", "INTEGER DEFAULT 0"),
    ("dashboard_shares", "last_viewed_at", "TIMESTAMP"),
]


def _ensure_new_columns():
    # create_all() above only creates missing TABLES - it never alters a
    # table that already exists, and this project has no Alembic. On a live
    # database that already has data, a newly added model column (like
    # Message.code or Message.action) needs an explicit ALTER TABLE the
    # first time this runs against it, or every insert referencing that
    # column would fail. This is written to be safe to run on every
    # startup: it only ever adds a column that is genuinely missing, and
    # does nothing once every column in _NEW_COLUMNS already exists.
    inspector = inspect(engine)
    existing_tables = set(inspector.get_table_names())
    for table, column, sql_type in _NEW_COLUMNS:
        if table not in existing_tables:
            continue
        existing_columns = {c["name"] for c in inspector.get_columns(table)}
        if column in existing_columns:
            continue
        with engine.begin() as conn:
            conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {sql_type}"))


def _ensure_personal_workspaces():
    """One-time-per-row (idempotent, safe to run every startup) backfill
    for accounts that existed before workspaces did: gives every user
    without one a real "Personal Workspace" (with themselves as its owner
    member), then assigns every still-unassigned data source to its
    owner's personal workspace. A brand new signup doesn't need this -
    routers/auth.py register() creates the personal workspace immediately
    - this only ever does work for rows that predate that change, and does
    nothing once every user/data source already has one."""
    from . import models  # local import - keeps database.py import-order-safe

    db = SessionLocal()
    try:
        users_without_workspace = (
            db.query(models.User)
            .outerjoin(
                models.Workspace,
                (models.Workspace.owner_id == models.User.id) & (models.Workspace.is_personal.is_(True)),
            )
            .filter(models.Workspace.id.is_(None))
            .all()
        )
        for user in users_without_workspace:
            ws = models.Workspace(name="Personal Workspace", owner_id=user.id, is_personal=True)
            db.add(ws)
            db.flush()
            db.add(models.WorkspaceMember(workspace_id=ws.id, user_id=user.id, role="owner"))
        if users_without_workspace:
            db.commit()

        unassigned = db.query(models.DataSource).filter(models.DataSource.workspace_id.is_(None)).all()
        if unassigned:
            personal_by_owner = {
                ws.owner_id: ws.id
                for ws in db.query(models.Workspace).filter(models.Workspace.is_personal.is_(True)).all()
            }
            for ds in unassigned:
                personal_id = personal_by_owner.get(ds.owner_id)
                if personal_id:
                    ds.workspace_id = personal_id
            db.commit()
    finally:
        db.close()
