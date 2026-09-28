"""
Phase 5, Batch A (2026-09-28, "Data governance & quality" roadmap): actually
evaluates one models.DataQualityRule against its data source's real, current
data - see that model's own docstring for what each rule_type means and the
exact shape of rule_config it expects.

run_quality_rule never crashes: an unreadable column, a source that can't be
loaded, or any other unexpected failure is caught and turned into an honest
last_status="error" with a human-readable last_message, never an unhandled
500 that would leave the rule's stored result silently stale. Every number
it writes (last_checked_row_count, last_failing_row_count) is genuinely
computed from the real DataFrame this call just loaded - never guessed,
estimated, or carried over from a previous run.

This function does NOT call db.commit() itself - see its own docstring
below for why the caller (routers/quality_checks.py) controls the
transaction, the same convention services/audit.log_audit_event follows.
"""
from __future__ import annotations

from datetime import datetime

import pandas as pd
from sqlalchemy.orm import Session

from .. import models
from .data_loader import load_dataframe


def run_quality_rule(db: Session, rule: models.DataQualityRule) -> models.DataQualityRule:
    """Loads `rule`'s data source fresh (via data_loader.load_dataframe,
    the one shared function every other read path in this app already
    uses) and re-evaluates `rule` against it right now, overwriting every
    last_* field on `rule` with a fresh, real result. `db.add(rule)` stages
    the change; the CALLER commits (this function never does), so a
    router's own db.commit() persists both the rule's own creation/edit and
    this first run atomically, exactly the audit-event pattern
    services/audit.py already follows."""
    ds = rule.datasource
    now = datetime.utcnow()

    try:
        df = load_dataframe(ds, db=db)
    except Exception as e:
        rule.last_status = "error"
        rule.last_message = f"Could not load this data source's data: {e}"
        rule.last_checked_row_count = None
        rule.last_failing_row_count = None
        rule.last_run_at = now
        db.add(rule)
        return rule

    if rule.column_name not in df.columns:
        rule.last_status = "error"
        rule.last_message = f"Column '{rule.column_name}' was not found in the current data."
        rule.last_checked_row_count = len(df)
        rule.last_failing_row_count = None
        rule.last_run_at = now
        db.add(rule)
        return rule

    column = df[rule.column_name]
    total = len(df)
    config = rule.rule_config or {}

    try:
        if rule.rule_type == "not_null":
            failing = int(column.isna().sum())
        elif rule.rule_type == "unique":
            # Counts every row that is a duplicate of an earlier value
            # (i.e. every occurrence past the first of a repeated value) -
            # the simpler of two reasonable definitions, and the one that
            # reads most naturally as "N rows failed uniqueness" rather
            # than "N distinct values were repeated". NaN values are left
            # in the duplicate check (pandas treats repeated NaNs as
            # duplicates of each other by default) rather than special-
            # cased out - several blank cells in a column that's supposed
            # to be unique are themselves a legitimate uniqueness problem,
            # not something this rule should silently ignore.
            failing = int(column.duplicated().sum())
        elif rule.rule_type == "min_value":
            threshold = config.get("min")
            if threshold is None:
                raise ValueError("This rule has no minimum value configured.")
            numeric = pd.to_numeric(column, errors="coerce")
            failing = int(((numeric.notna()) & (numeric < float(threshold))).sum())
        elif rule.rule_type == "max_value":
            threshold = config.get("max")
            if threshold is None:
                raise ValueError("This rule has no maximum value configured.")
            numeric = pd.to_numeric(column, errors="coerce")
            failing = int(((numeric.notna()) & (numeric > float(threshold))).sum())
        elif rule.rule_type == "allowed_values":
            allowed = config.get("values") or []
            allowed_set = set(allowed)
            # A blank/NaN value always fails this rule - a null is never
            # itself one of the explicitly allowed values (see this
            # model's own docstring).
            failing = int((~column.isin(allowed_set) | column.isna()).sum())
        else:
            raise ValueError(f"Unknown rule type '{rule.rule_type}'.")
    except Exception as e:
        rule.last_status = "error"
        rule.last_message = f"Could not evaluate this rule: {e}"
        rule.last_checked_row_count = total
        rule.last_failing_row_count = None
        rule.last_run_at = now
        db.add(rule)
        return rule

    rule.last_checked_row_count = total
    rule.last_failing_row_count = failing
    rule.last_status = "fail" if failing > 0 else "pass"
    rule.last_run_at = now
    rule.last_message = "All rows passed" if failing == 0 else f"{failing} of {total} rows failed"
    db.add(rule)
    return rule
