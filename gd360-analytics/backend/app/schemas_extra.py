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
    # The person choice of how much control they want over an analysis
    # question that needs its own data preparation step first: "auto" (the
    # default) explains preparation and shows the result in one smooth
    # answer; "guided" pauses right after preparation so they can confirm
    # before the actual analysis runs - see ai_engine.analyze `guided`.
    analysis_mode: Optional[str] = "auto"
    # True only for the follow-up request that continues a paused, guided
    # turn: tells the AI this exact table was already prepared for this
    # exact question, so it should analyze it directly instead of
    # preparing it again - see ai_engine.analyze `skip_prep`.
    skip_prep: bool = False


class VerifyRequest(BaseModel):
    # Which assistant message (a prior analyze/transform answer) to
    # re-check for correctness on demand - the "Double-check this" action.
    message_id: str
    # Same meaning as ChatRequestFull.source_version_ids above - which
    # saved table(s) to re-run the stored code against. The client sends
    # whatever selection was active for that original answer, so
    # verification checks the code against the same data it originally ran
    # against (or that data as it stands now, if it has since changed).
    source_version_ids: Optional[List[str]] = None


class GokuChatRequest(BaseModel):
    # One message sent to Goku, the guided data-assistant chat that lives
    # only in the Workspace page - see routers/goku.py.
    datasource_id: str
    message: str
    # Same meaning as ChatRequestFull.source_version_ids above - which
    # saved table(s) Goku should profile/reason about right now (the
    # person current WORKING ON selection).
    source_version_ids: Optional[List[str]] = None
