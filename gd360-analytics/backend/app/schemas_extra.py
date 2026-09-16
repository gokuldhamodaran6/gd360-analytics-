"""Small additions to ChatRequest kept separate to avoid a big diff in schemas.py."""
from typing import List, Optional
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
    # Which saved table(s) to run this prompt against: each entry is either
    # the literal string "original" (the untouched original data) or a
    # DatasetVersion.id. None/empty means the original data alone. The
    # person picks this explicitly whenever more than one table exists, so
    # a prompt never silently runs against the wrong one - and picking more
    # than one lets a single prompt compare or combine several tables.
    source_version_ids: Optional[List[str]] = None
