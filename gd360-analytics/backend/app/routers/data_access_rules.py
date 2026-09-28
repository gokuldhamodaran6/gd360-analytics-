"""
Phase 5, Batch B (governance & data permissions): row/column-level data
permissions, built directly on top of Batch A's role model
(services/workspace_access.py) - a data source's own OWNER can restrict what
that workspace's "member" or "viewer" role tier sees of the data, either by
hiding a column entirely or by restricting a column to an explicit allow-
list of values (row filtering). See models.DataAccessRule's own docstring
for the exact shape of a rule and how role/kind/column_name/allowed_values
are used.

This module is the enforcement core - resolve_restriction_role and
has_active_restrictions decide WHO is restricted and whether there is
anything to enforce at all, and filter_dataframe_for_role is the one
function that actually does the enforcing, applied to a real, already-
loaded pandas DataFrame.

Every read path in this app that could hand real row data back to someone
other than a data source's own owner must call filter_dataframe_for_role
immediately after its own services.data_loader.load_dataframe (or
load_version_dataframe) call returns - load_dataframe itself stays a pure,
caller/role-unaware "resolve a DataSource into a DataFrame" function and is
never touched by this module. As of this round, every such call site has
been updated:
  - routers/chat.py: the standalone "original data as a merge fallback"
    loads (in both chat() and verify_message()), and every branch of
    _load_selected_tables (the "original"/"sheet:"/"ds:"/bare-version-id
    selections) - each filtered through whichever DataSource actually owns
    the data just loaded (the primary `ds`, or `other_ds` for a separately-
    connected data source pulled in via "+ Add more data").
  - routers/dashboard_builder.py: generate_dashboard's goal-mode data load,
    ask_ai_block, build_manual_block, and preview_filtered_blocks.
  - routers/datasources.py: preview_datasource, get_column_distinct_values,
    parse_filter, and export_datasource - each filters once, right after
    the existing `load_version_dataframe(...) if active_version else
    load_dataframe(...)` ternary, so both a live original-data view and a
    saved/cleaned version view are covered by the same call. KNOWN
    LIMITATION, documented rather than papered over: if a saved/cleaned
    version renamed a restricted column, the rule's column_name silently no
    longer matches anything in that version's own columns and the rule has
    no effect on that renamed column in that saved version - see
    filter_dataframe_for_role's own docstring on why this is a deliberate,
    silent no-op rather than an error.

Critically, warehouse/database SQL "pushdown" (routers/chat.py's
_try_bigquery_pushdown/_try_snowflake_pushdown/_try_sql_pushdown/
_try_mongo_pushdown) is NOT filtered after the fact at all - it is gated
OFF entirely (never attempted) for a restricted role, via
has_active_restrictions, at the single dispatch point that decides whether
to try pushdown in the first place. A pushdown query runs directly inside
the customer's own warehouse/database/Mongo server and its result never
passes through load_dataframe or this module - there is no reliable way to
filter it after the fact and be sure nothing restricted ever reached the
AI's reasoning or the chat reply, so the only correct fix is to never run
it in the first place when the caller is restricted.
"""
from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy.orm import Session

from .. import models
from . import workspace_access

if TYPE_CHECKING:
    import pandas as pd


def resolve_restriction_role(db: Session, ds: models.DataSource, user: models.User) -> str | None:
    """Returns "member" or "viewer" if `user` is subject to restriction
    rules on `ds`, or None if unrestricted (the data source's own owner is
    ALWAYS unrestricted, full stop - a rule can never apply to ds.owner_id
    itself). A None result also covers "no workspace_id to resolve a role
    against" - a still-personal, never-shared data source has no one but
    its owner able to access it at all (see workspace_access.
    can_access_datasource), so there is no one left to restrict."""
    if user.id == ds.owner_id:
        return None
    if not ds.workspace_id:
        return None
    role = workspace_access.member_role(db, user.id, ds.workspace_id)
    if role not in ("member", "viewer"):
        return None
    return role


def has_active_restrictions(db: Session, ds: models.DataSource, user: models.User) -> bool:
    """Cheap existence check - used to gate warehouse/database SQL pushdown
    in routers/chat.py, which must be skipped ENTIRELY (never attempted,
    not filtered after the fact) for a restricted role, since a pushdown
    query runs directly inside the customer's own warehouse/database/Mongo
    server and returns its result completely outside this app's own
    row/column filtering. See this module's own module docstring."""
    role = resolve_restriction_role(db, ds, user)
    if role is None:
        return False
    return (
        db.query(models.DataAccessRule.id)
        .filter(models.DataAccessRule.datasource_id == ds.id, models.DataAccessRule.role == role)
        .first()
        is not None
    )


def filter_dataframe_for_role(db: Session, df: "pd.DataFrame", ds: models.DataSource, user: models.User) -> "pd.DataFrame":
    """The one function every read path that could hand real row data back
    to someone other than a data source's owner must call, immediately
    after services.data_loader.load_dataframe (or load_version_dataframe)
    returns - never inside load_dataframe itself, which stays a pure
    "resolve a DataSource into a DataFrame" function with no caller/role
    awareness. Cheap no-op (returns df unchanged, no query at all) when the
    caller is unrestricted or has zero active rules for their role on this
    data source - the overwhelmingly common case.

    Column rules are unioned and dropped first (a column rule for a column
    no longer present in df - e.g. it was renamed by a save/cleaning step -
    silently has nothing to do; it is not an error). Row rules are then
    AND-combined across different columns (a row must pass every column's
    allow-list to remain visible); a row rule whose column_name is no
    longer present in df is skipped the same way. A row rule with an empty/
    null allowed_values matches nothing (fail-safe: an incompletely-
    configured row rule hides all rows rather than leaking all of them)."""
    role = resolve_restriction_role(db, ds, user)
    if role is None:
        return df

    rules = (
        db.query(models.DataAccessRule)
        .filter(models.DataAccessRule.datasource_id == ds.id, models.DataAccessRule.role == role)
        .all()
    )
    if not rules:
        return df

    column_rules = [r for r in rules if r.kind == "column"]
    row_rules = [r for r in rules if r.kind == "row"]

    hide_columns = [r.column_name for r in column_rules if r.column_name in df.columns]
    if hide_columns:
        df = df.drop(columns=hide_columns, errors="ignore")

    for rule in row_rules:
        if rule.column_name not in df.columns:
            continue
        allowed = rule.allowed_values or []
        # A blank/NaN cell never matches an allow-list, same convention
        # services/quality_checks.py's own "allowed_values" rule already
        # follows - a null is never itself one of the explicitly allowed
        # values, so an empty/null allowed_values (an incompletely-
        # configured row rule) correctly hides every row rather than
        # leaking all of them.
        mask = df[rule.column_name].isin(allowed)
        df = df[mask]

    return df
