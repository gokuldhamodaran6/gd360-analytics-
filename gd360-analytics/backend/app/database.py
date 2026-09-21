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


# Every column added to an existing model after it first went live needs an
# entry here (table, column name, SQL type) - see _ensure_new_columns below.
_NEW_COLUMNS = [
    ("messages", "code", "TEXT"),
    ("messages", "action", "TEXT"),
    ("messages", "chart_type", "TEXT"),
    ("messages", "verified_count", "INTEGER DEFAULT 0"),
    ("conversations", "pinned", "BOOLEAN DEFAULT FALSE"),
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
