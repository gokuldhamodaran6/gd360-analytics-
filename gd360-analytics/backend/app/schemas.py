"""
Pydantic request/response schemas.
"""
from datetime import datetime
from typing import Optional, Any

from pydantic import BaseModel, EmailStr, Field


# ---------- Auth ----------
class UserCreate(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8)
    full_name: Optional[str] = None
    company: Optional[str] = None
    captcha_id: str
    captcha_answer: str


class UserLogin(BaseModel):
    email: EmailStr
    password: str


class UserOut(BaseModel):
    id: str
    email: EmailStr
    full_name: Optional[str] = None
    company: Optional[str] = None
    created_at: datetime

    class Config:
        from_attributes = True


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


class CaptchaOut(BaseModel):
    captcha_id: str
    question: str


class UpdateProfileRequest(BaseModel):
    full_name: Optional[str] = Field(default=None, max_length=120)
    company: Optional[str] = Field(default=None, max_length=120)


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8)


# ---------- DataSources ----------
class DataSourceCreateDB(BaseModel):
    name: str
    kind: str  # postgres | mysql | mongodb
    host: str
    port: int
    database: str
    username: str
    password: str
    ssl: bool = True


class DataSourceOut(BaseModel):
    id: str
    name: str
    kind: str
    connection_info: dict
    read_only: bool
    schema_cache: Optional[dict] = None
    created_at: datetime

    class Config:
        from_attributes = True


# ---------- Chat / AI ----------
class ChatRequest(BaseModel):
    conversation_id: Optional[str] = None
    datasource_id: str
    prompt: str
    # Optional explicit chart customization instructions layered on top of prompt
    chart_override: Optional[dict] = None


class ChatResponse(BaseModel):
    conversation_id: str
    message_id: str
    role: str = "assistant"
    reply_text: str
    action: str = "analyze"
    chart_spec: Optional[dict] = None
    insight: Optional[str] = None
    suggested_charts: Optional[list] = None
    suggested_stats: Optional[list] = None
    # Specific, contextual "what to try next" buttons tied to this exact
    # result (e.g. an alternative correlation method) - distinct from the
    # generic, dataset-level suggested_charts/suggested_stats above.
    follow_up_suggestions: Optional[list] = None
    needs_clarification: bool = False
    rows_before: Optional[int] = None
    rows_after: Optional[int] = None
    nulls_before: Optional[int] = None
    nulls_after: Optional[int] = None
    # Set only when this prompt created a new saved table (a cleaning/prep
    # transform), so the client can add it as a new tab and switch to it.
    new_version_id: Optional[str] = None
    new_version_name: Optional[str] = None
    # Set only in step-by-step ("guided") analysis mode, right after this
    # turn prepared a table but has NOT yet run the actual analysis on it -
    # the client shows this as a single prominent button; clicking it
    # re-sends "prompt" with skip_prep=true and source_version_ids=
    # [version_id] to run the analysis against the just-prepared table.
    continue_action: Optional[dict] = None


# ---------- Verify ("Double-check this") ----------
class VerifyResponse(BaseModel):
    # "confirmed": reviewed and found correct, nothing changed.
    # "corrected": an issue was found and this message was fixed in place
    #   (reply_text/chart_spec/insight below are the corrected versions).
    # "unavailable": the review itself could not be completed (a transient
    #   AI service issue), or found a bigger problem that needs a fresh
    #   message rather than an in-place fix - the original answer is
    #   unchanged either way.
    status: str
    message: str
    message_id: str
    reply_text: Optional[str] = None
    chart_spec: Optional[dict] = None
    insight: Optional[str] = None
    new_version_id: Optional[str] = None
    new_version_name: Optional[str] = None


# ---------- Dataset versions (saved/named tables) ----------
class RenameVersionRequest(BaseModel):
    name: str = Field(min_length=1, max_length=80)


# ---------- Dashboards ----------
class DashboardCreate(BaseModel):
    name: str


class SaveChartRequest(BaseModel):
    dashboard_id: Optional[str] = None
    dashboard_name: Optional[str] = None
    title: str
    chart_spec: dict
    insight: Optional[str] = None
