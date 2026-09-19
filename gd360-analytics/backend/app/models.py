"""
ORM models for the GD360 Analytics application database.
"""
import uuid
from datetime import datetime

from sqlalchemy import (
    Column, String, DateTime, ForeignKey, Text, JSON, Boolean, Integer, LargeBinary
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


class DataSource(Base):
    """
    Metadata + encrypted credentials for a connection a user has added.
    kind: "postgres" | "mysql" | "mongodb" | "csv" | "excel"
    connection_info: non-secret fields (host, port, db name, table allowlist...) as JSON
    encrypted_secret: encrypted connection string / password (never plaintext)
    file_path: for uploaded csv/excel files, path on server storage
    """
    __tablename__ = "datasources"

    id = Column(String, primary_key=True, default=gen_uuid)
    owner_id = Column(String, ForeignKey("users.id"), nullable=False)
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


class Conversation(Base):
    __tablename__ = "conversations"

    id = Column(String, primary_key=True, default=gen_uuid)
    owner_id = Column(String, ForeignKey("users.id"), nullable=False)
    datasource_id = Column(String, ForeignKey("datasources.id"), nullable=True)
    title = Column(String, default="New analysis")
    created_at = Column(DateTime, default=datetime.utcnow)

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
    __tablename__ = "dashboards"

    id = Column(String, primary_key=True, default=gen_uuid)
    owner_id = Column(String, ForeignKey("users.id"), nullable=False)
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
