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
    # Which snapshot of the data to run against: "auto" (prefer the cleaned
    # version if one exists), "original", or "cleaned".
    data_version: Optional[str] = "auto"
