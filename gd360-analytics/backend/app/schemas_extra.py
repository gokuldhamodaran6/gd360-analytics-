"""Small additions to ChatRequest kept separate to avoid a big diff in schemas.py."""
from typing import List, Literal, Optional, Union
from pydantic import BaseModel, Field, model_validator


# --- Warehouse query builder (2026-10-06, warehouse-honesty round) ------------
# For a warehouse/database data source (BigQuery/Snowflake/Postgres/MySQL/
# SQL Server/Supabase), a chat question is answered ONLY by a real query
# that runs inside the warehouse over every row - never by analyzing a
# row-capped sample pulled into the app. When the AI could not write that
# query, /chat answers with action="needs_query_help" (see schemas.
# ChatResponse) and the frontend offers two deterministic ways to finish
# the question in the SAME /chat endpoint:
#   - `query_builder`: this structured spec, turned into SQL with zero
#     language-model involvement by services/query_builder.py (every table/
#     column name must exist in the data source's own schema, otherwise
#     HTTP 400).
#   - `raw_sql`: the person's own SELECT, still subject to the read-only
#     check, the per-query/daily cost guards and the audit log.
# Exactly one of the two may be set; both are optional and absent for an
# ordinary question.

class QueryBuilderFilter(BaseModel):
    column: str
    op: Literal["=", "!=", ">", ">=", "<", "<=", "is_null", "is_not_null", "in"]
    # A single number/string for the comparison ops, a list (at most 50
    # items) for "in", ignored (may be omitted) for is_null/is_not_null.
    value: Optional[Union[str, int, float, List[Union[str, int, float]]]] = None


class QueryBuilderSpec(BaseModel):
    # Must be a key of this data source's schema_cache (one of its tables).
    table: str
    # 0..3 grouping columns, each a real column of `table`.
    group_by: List[str] = Field(default_factory=list, max_length=3)
    # The column to aggregate, or None - only valid with agg="count",
    # which then means COUNT(*).
    measure: Optional[str] = None
    agg: Literal["count", "sum", "avg", "min", "max", "count_distinct"] = "count"
    filters: List[QueryBuilderFilter] = Field(default_factory=list, max_length=20)
    # "measure_desc"/"measure_asc" sort by the aggregate; "group" sorts by
    # the grouping columns; None leaves the warehouse's own order.
    order_by: Optional[Literal["measure_desc", "measure_asc", "group"]] = None
    # Row cap on the RESULT (already-aggregated rows), clamped to 1..5000.
    limit: int = Field(default=1000, ge=1, le=5000)


class ChatRequestFull(BaseModel):
    conversation_id: Optional[str] = None
    datasource_id: str
    table: Optional[str] = None
    prompt: str
    chart_override: Optional[dict] = None
    # Which step of the guided workflow this prompt came from, if any:
    # "clean" | "explore" | "visualize" | None (freeform / pro mode).
    intent: Optional[str] = None
    # Which saved table(s) to run this prompt against. None/empty means the
    # original data alone. The person picks this explicitly whenever more
    # than one table exists, so a prompt never silently runs against the
    # wrong one - and picking more than one lets a single prompt compare or
    # combine several tables, from one data source or several, at once.
    # Each entry is one of (see routers/chat.py _load_selected_tables for
    # exactly how these are resolved):
    #   "original"                          - this datasource's own original data
    #   "sheet:<name>"                      - one sheet of THIS datasource, for a multi-sheet Excel upload
    #   a bare DatasetVersion.id            - a saved table (any datasource the person owns)
    #   "ds:<other_datasource_id>:original" - another, separately-connected data source's original data
    #   "ds:<other_datasource_id>:sheet:<name>" - a specific sheet of that other data source
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
    # 2026-10-06 (warehouse-honesty round): the two deterministic ways to
    # finish a warehouse question the AI could not turn into a query - see
    # QueryBuilderSpec above. Mutually exclusive. Only meaningful for a
    # warehouse/database data source; for a file-based source (csv/excel/
    # api/...) they are rejected with HTTP 400, since there is no warehouse
    # to run them in. `prompt` is still required with either one - it is
    # stored as the person's own message in the conversation (the frontend
    # sends the builder's human-readable summary, or a short label for a
    # hand-written query).
    query_builder: Optional[QueryBuilderSpec] = None
    raw_sql: Optional[str] = Field(default=None, max_length=20000)
    # 2026-10-06 ("generated data is a saved query" layer): with `raw_sql`,
    # True saves that SELECT as a new saved-query table of this warehouse
    # data source (validated read-only, dry-run/zero-row checked, exact
    # COUNT(*) captured - see routers/chat.py _create_warehouse_table)
    # instead of running it and charting the result. The response is then
    # a transform turn (action="transform", new_version_id/new_version_name,
    # pushdown_sql = the definition). Ignored without raw_sql; the builder
    # stays a question path. Rejected (HTTP 400) for mongodb and for
    # file-based kinds.
    save_as_table: bool = False

    @model_validator(mode="after")
    def _one_finish_path(self):
        if self.query_builder is not None and self.raw_sql:
            raise ValueError("Send either query_builder or raw_sql, not both.")
        if self.save_as_table and not self.raw_sql:
            raise ValueError("save_as_table needs raw_sql - the SELECT to save as a table.")
        return self


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
