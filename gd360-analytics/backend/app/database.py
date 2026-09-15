"""
SQLAlchemy engine/session setup for the *application* database
(users, datasource metadata, conversation history, saved charts).

This is separate from any customer database a user connects for analysis -
those are only ever touched read-only, on demand, via services/connectors.py.
"""
from sqlalchemy import create_engine
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
    # Creates tables if they don't exist. For production evolution, swap
    # this for Alembic migrations - noted in README.
    from . import models  # noqa: F401  (ensure models are registered)
    Base.metadata.create_all(bind=engine)
