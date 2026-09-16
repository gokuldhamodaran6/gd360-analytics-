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


def _ensure_new_columns():
    # create_all() above only creates missing TABLES - it never alters a
    # table that already exists, and this project has no Alembic. On a live
    # database that already has data, a newly added model column (like
    # Message.code) needs an explicit ALTER TABLE the first time this runs
    # against it, or every insert referencing that column would fail. This
    # is written to be safe to run on every startup: it only ever adds a
    # column that is genuinely missing, and does nothing once it exists.
    inspector = inspect(engine)
    if "messages" not in inspector.get_table_names():
        return
    existing_columns = {c["name"] for c in inspector.get_columns("messages")}
    if "code" in existing_columns:
        return
    with engine.begin() as conn:
        conn.execute(text("ALTER TABLE messages ADD COLUMN code TEXT"))
