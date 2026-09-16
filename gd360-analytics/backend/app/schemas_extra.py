"""Small additions to ChatRequest kept separate to avoid a big diff in schemas.py."""
from typing import Optional
from pydantic import BaseModel


class ChatRequestFull(BaseModel):
    conversation_id: Optional[str] = None
    datasource_id: str
    table: Optional[str] = None
    prompt: str
    chart_override: Optional[dict] = None
    # Which step of the guided workflow this prompt came from, if any:
    # "clean" | "explore" | "visualize" | None (freeform / pro mode).
    intent: Optional[str] = None
    # Which saved table (DatasetVersion.id) to run this prompt against.
    # None means the original, untouched data. The person picks this
    # explicitly whenever more than one table exists, so a prompt never
    # silently runs against the wrong one.
    source_version_id: Optional[str] = None
