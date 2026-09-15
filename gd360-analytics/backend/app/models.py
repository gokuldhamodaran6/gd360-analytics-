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
    read_only = Column(Boolean, default=True)
    schema_cache = Column(JSON, default=dict)
    created_at = Column(DateTime, default=datetime.utcnow)

    owner = relationship("User", back_populates="datasources")


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
    created_at = Column(DateTime, default=datetime.utcnow)

    conversation = relationship("Conversation", back_populates="messages")


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
