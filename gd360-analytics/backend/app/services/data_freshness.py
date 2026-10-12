"""
Live or uploaded: how fresh a dashboard's data can be (2026-10-12, round 35).

A dashboard on a live connection (a warehouse, a database, Google Sheets, a synced app, a stream) can
be refreshed - its numbers move when the source moves. One on an uploaded file (CSV, Excel, JSON,
Parquet) is a fixed copy: there is nothing to refresh until a new version is uploaded. A dashboard
over both is "mixed" - Refresh is offered because part of it is live.
"""
from __future__ import annotations

UPLOAD_KINDS = {"csv", "tsv", "excel", "xlsx", "xls", "json", "parquet", "file", "upload"}


def is_live(kind: str | None) -> bool:
    k = (kind or "").lower().strip()
    return bool(k) and k not in UPLOAD_KINDS


def data_mode(kinds) -> str | None:
    """"live" | "file" | "mixed" | None (no source known)."""
    ks = [k for k in kinds if k]
    if not ks:
        return None
    live = any(is_live(k) for k in ks)
    upload = any(not is_live(k) for k in ks)
    return "mixed" if live and upload else "live" if live else "file"
