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
