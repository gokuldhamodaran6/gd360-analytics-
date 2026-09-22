"""
Permanent, per-account memory of exactly-correct answers - the realistic
version of "the app learns and gets faster over time."

What this deliberately is NOT: a custom-trained AI model. Actually training
a model (collecting a labeled dataset, running real training compute,
hosting and versioning the result, monitoring it for drift) is a genuinely
different, much larger undertaking than this product needs right now - a
single small backend instance calling a hosted AI provider - and reaching
for it here would trade a real, working, verifiable improvement for a
speculative and expensive one. See the 2026-09-22 conversation this module
came out of: the honest options were "build this" or "scope out real model
training as separate, future work," and this is "build this."

What this IS: whenever a real question (action "analyze" or "transform")
is answered correctly for a person's data, the exact question text and the
exact table/column shape it ran against are remembered alongside the exact
pandas code that produced it. The next time that SAME person asks that
SAME question against a still-matching schema - even in a brand new
conversation, even weeks later - the app replays that already-proven code
directly instead of asking the AI to write it again.

Why this is safe (the part that matters most, given this app's history of
one earlier speed optimization getting rolled back after it hurt accuracy):
  - It never caches an ANSWER, only CODE. The code still runs for real,
    fresh, in the same sandbox, against whatever the current data actually
    is - so a memory never goes stale the way a cached number would. If
    the underlying data changed since the code was learned (more rows, a
    corrected value), the replayed code reflects that immediately, because
    it is really running again, not returning a number pulled from storage.
  - It never replays a NEAR match, only an EXACT one - the exact same
    normalized question text, against a schema fingerprint (table name(s) +
    column name(s) + dtype(s), see schema_fingerprint below) that matches
    exactly. Any difference at all - a reworded question, a renamed/added/
    removed/retyped column, a different table - simply misses the lookup
    and falls straight through to the normal AI-planned flow, unaffected.
    This is the same guarantee ai_engine._find_repeated_prompt_code already
    relies on for the in-conversation version of this idea; this module
    only makes that memory durable and cross-conversation instead of
    scoped to one chat history.
  - It is scoped to one owner_id. Two different people's memories are never
    shared, even if their schemas happen to look identical.
  - A lookup or save failure here is always non-fatal - every function
    below catches its own exceptions and falls back to "as if this feature
    did not exist," never breaking the actual chat request over it.
"""
from __future__ import annotations

import hashlib
import re
from datetime import datetime

from sqlalchemy.orm import Session

from .. import models

# A sane per-account ceiling so one very active account's memory cannot
# grow without bound - evicts the least-recently-replayed rows first once
# hit, same LRU principle used elsewhere in this app (see the table preview
# cache in routers/datasources.py). At a few hundred bytes of code per row,
# even the full cap is a trivial amount of storage - this exists to bound
# an unusual usage pattern, not because normal use is expected to get
# anywhere near it.
_MAX_ENTRIES_PER_OWNER = 5000


def normalize_prompt(prompt: str) -> str:
    """Same normalization ai_engine._find_repeated_prompt_code already uses
    for its in-conversation version of this - kept identical on purpose so
    "the same question" means the same thing in both places."""
    return re.sub(r"\s+", " ", (prompt or "").strip().lower())


def schema_fingerprint(tables: dict) -> str:
    """A stable fingerprint of exactly which table(s) (by exact name, in
    selection order) and which column(s) (by exact name and pandas dtype,
    in their real column order) a request ran against. Two requests only
    ever share a fingerprint when their table/column shape genuinely
    matches - this is the mechanism that makes a schema change safe: a
    renamed, added, removed, or retyped column produces a different
    fingerprint, so any code learned against the old shape is simply never
    looked up again, never replayed against data it was not written for."""
    parts = []
    for name, df in tables.items():
        try:
            cols = ",".join(f"{c}:{df[c].dtype}" for c in df.columns)
        except Exception:
            cols = ""
        parts.append(f"{name}|{cols}")
    blob = "\n".join(parts)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def find_learned_answer(
    db: Session, owner_id: str, tables: dict, prompt: str
) -> tuple[str, str, str, str | None] | None:
    """Returns (action, narrative, code, chart_type) - the same shape
    ai_engine._find_repeated_prompt_code returns - if this owner has
    already answered this exact question against a matching schema before,
    else None. Never raises: any lookup failure (a DB hiccup, an odd
    dataframe) falls back to None, which just means "ask the AI as
    normal," never a broken request."""
    norm = normalize_prompt(prompt)
    if not norm:
        return None
    try:
        fp = schema_fingerprint(tables)
        row = (
            db.query(models.LearnedAnswer)
            .filter(
                models.LearnedAnswer.owner_id == owner_id,
                models.LearnedAnswer.schema_fingerprint == fp,
                models.LearnedAnswer.normalized_prompt == norm,
            )
            .first()
        )
        if not row:
            return None
        row.hit_count = (row.hit_count or 0) + 1
        row.last_used_at = datetime.utcnow()
        db.commit()
        return row.action, row.narrative or "", row.code, row.chart_type
    except Exception as e:
        print(f"[learned_answers] lookup failed (non-fatal, falling back to the AI): {e}")
        try:
            db.rollback()
        except Exception:
            pass
        return None


def save_learned_answer(
    db: Session, owner_id: str, tables: dict, prompt: str,
    action: str | None, narrative: str | None, code: str | None, chart_type: str | None,
) -> None:
    """Upserts the (owner, schema, question) -> code memory after a real,
    freshly AI-planned success (never call this for a turn that was itself
    a replay - there is nothing new to learn from replaying an already-
    learned answer). Only ever a no-op, an insert, or an update - never
    raises out into the caller, so a save failure can never break the
    actual chat response the person is waiting on."""
    if action not in ("analyze", "transform"):
        return
    code = (code or "").strip()
    if not code:
        return
    norm = normalize_prompt(prompt)
    if not norm:
        return
    try:
        fp = schema_fingerprint(tables)
        row = (
            db.query(models.LearnedAnswer)
            .filter(
                models.LearnedAnswer.owner_id == owner_id,
                models.LearnedAnswer.schema_fingerprint == fp,
                models.LearnedAnswer.normalized_prompt == norm,
            )
            .first()
        )
        if row:
            row.action = action
            row.narrative = narrative
            row.code = code
            row.chart_type = chart_type
            row.last_used_at = datetime.utcnow()
        else:
            _enforce_owner_cap(db, owner_id)
            row = models.LearnedAnswer(
                owner_id=owner_id, schema_fingerprint=fp, normalized_prompt=norm,
                action=action, narrative=narrative, code=code, chart_type=chart_type,
            )
            db.add(row)
        db.commit()
    except Exception as e:
        print(f"[learned_answers] save failed (non-fatal): {e}")
        try:
            db.rollback()
        except Exception:
            pass


def _enforce_owner_cap(db: Session, owner_id: str) -> None:
    count = db.query(models.LearnedAnswer).filter(models.LearnedAnswer.owner_id == owner_id).count()
    if count < _MAX_ENTRIES_PER_OWNER:
        return
    to_evict = count - _MAX_ENTRIES_PER_OWNER + 1
    oldest = (
        db.query(models.LearnedAnswer)
        .filter(models.LearnedAnswer.owner_id == owner_id)
        .order_by(models.LearnedAnswer.last_used_at.asc())
        .limit(to_evict)
        .all()
    )
    for r in oldest:
        db.delete(r)
