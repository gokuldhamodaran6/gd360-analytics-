"""
2026-09-30 (orchestration v1): the actual "refresh an API data source"
logic, extracted out of routers/datasources.py's refresh_api endpoint body
into its own headless service function - so services/pipelines.py's
"refresh_datasource" step can call the EXACT same logic a person clicking
"Refresh" on an API data source already triggers by hand, rather than a
second, possibly-drifting copy of it. routers/datasources.py refresh_api
is now a thin wrapper: resolve + authorize the data source, call this
function, turn its result (or its RuntimeError) into the HTTP response -
see that endpoint's own comment for why the split happened.

Deliberately takes (db, ds) only - no `user`/HTTPException dependency, and
raises plain RuntimeError on failure rather than HTTPException - the same
headless-service convention services/quality_checks.run_quality_rule and
services/scheduler.refresh_dashboard already follow, so it's callable from
anywhere (a router, the pipeline step runner, a future scheduled trigger)
without dragging FastAPI's request machinery along. This is exactly the
gap routers/datasources.py refresh_api's own docstring named plainly
before this round existed: "Wiring an 'api' source into
services/scheduler.py's existing... loop is real, separate future work...
needs its own design and testing pass rather than a one-line addition
slipped into this round." This module, plus services/pipelines.py's
"refresh_datasource" step type, is that design/testing pass.
"""
from __future__ import annotations

from datetime import datetime

import pandas as pd
from sqlalchemy.orm import Session

from .. import models, security
from .connectors import ApiConnector
from .data_loader import dataframe_to_csv_bytes, warm_cache


def _api_schema_and_bytes(df: pd.DataFrame) -> tuple[dict, bytes]:
    """Same shape routers/datasources.py's own _api_schema_and_bytes
    builds - kept as a private duplicate rather than importing the
    router's helper, since routers/ code is never imported back into
    services/ in this codebase (services are the shared, reusable layer;
    routers are the HTTP-facing leaves that depend on services, never the
    other way around)."""
    schema = {"columns": [{"name": str(c), "type": str(df[c].dtype)} for c in df.columns]}
    return schema, dataframe_to_csv_bytes(df)


def refresh_api_datasource(db: Session, ds: models.DataSource) -> pd.DataFrame:
    """Re-runs the exact same fetch-and-flatten logic connect_api used at
    creation, overwrites ds.file_data/schema_cache with the fresh result,
    sets ds.api_last_refreshed_at to the real time this genuinely just
    succeeded, and commits - the ONLY way an "api" source's data ever
    changes after it is first connected (see models.DataSource's own
    docstring on that column). Also re-warms the in-process data cache
    with the fresh frame, same as the original endpoint always did.

    Raises RuntimeError with a plain, honest message on any failure -
    connection problem, missing URL, unreadable stored credential, or a
    bad response from the API itself - and never silently leaves stale
    data in place while claiming success. The caller (the router endpoint,
    or a pipeline step) decides how to present that error to whoever is
    watching; this function itself never raises HTTPException since it has
    no HTTP request context of its own."""
    if ds.kind != "api":
        raise RuntimeError("This isn't an API data source.")
    info = ds.connection_info or {}
    url = info.get("url")
    if not url:
        raise RuntimeError("This data source has no URL on file - remove it and reconnect instead.")

    headers: dict = {}
    auth_header_name = info.get("auth_header_name")
    if auth_header_name and ds.encrypted_secret:
        try:
            headers[auth_header_name] = security.decrypt_secret(ds.encrypted_secret)
        except Exception:
            raise RuntimeError(
                "This source's auth header value could not be read - remove it and reconnect with a fresh value."
            )

    connector = ApiConnector(url, headers=headers, json_path=info.get("json_path"))
    try:
        df = connector.fetch_dataframe()
    except ValueError as e:
        raise RuntimeError(str(e))
    except Exception as e:
        raise RuntimeError(f"Could not read that API: {e}")

    schema, file_bytes = _api_schema_and_bytes(df)
    ds.schema_cache = schema
    ds.file_data = file_bytes
    ds.api_last_refreshed_at = datetime.utcnow()
    db.commit()
    db.refresh(ds)
    # Overwrites the in-process cache entry this exact same call's fetch
    # just made stale - see data_loader.warm_cache's own comment for why
    # this is what keeps the "file_data is write-once" cache correct in
    # the one case (an API refresh) where it genuinely isn't.
    warm_cache(ds.id, df)
    return df
