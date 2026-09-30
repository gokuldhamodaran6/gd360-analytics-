"""
2026-09-30 (data catalog v1): the single, account-wide, searchable
inventory this app never had - closing the exact gap
claude/gd360-competitive-gap-analysis-2026-09-29.md's own gap #8 names
plainly: "No searchable, account-wide data catalog exists - lineage/notes
are real but scoped to one data source at a time," and the capability
map's own discoverability note: "the deeper features... are one click
further in, inside a data source's own detail page - reasonable, but a
person has to already know to look there."

search_catalog is deliberately NOT a separate index/table that has to be
kept in sync - it is a live, read-only query fanned out across the real
rows this app already has (DataSource, DataTransform, MetricDefinition,
Dashboard, Pipeline, plus a data source's own schema_cache columns), so a
catalog result can never go stale or point at something that no longer
exists the way a maintained search index could. This mirrors this app's
existing "recompute live, never a frozen snapshot" discipline (see
services/transforms.py, services/metrics.py) applied to SEARCH instead of
computation.

Scope, deliberately: name + description text matching (case-insensitive
substring - no fuzzy/semantic search this round), across six asset kinds.
Access is the exact same "owner, or a member of the workspace it's shared
into" rule every one of these already enforces at its own router -
replicated here directly (never importing a routers/ helper - see
services/datasource_refresh.py's own comment on why services/ never
imports routers/) rather than a new, separate permission model.
"""
from __future__ import annotations

from sqlalchemy import or_
from sqlalchemy.orm import Session

from .. import models
from . import workspace_access

# A column entry is real and useful, but a data source can have dozens of
# columns and an account can have many data sources - unbounded, this
# could dwarf every other asset type in the results. Capped per data
# source so one wide table can't crowd out everything else in a search.
_MAX_COLUMN_MATCHES_PER_DATASOURCE = 25


def _visible(query, model, user: models.User, ws_ids: set[str]):
    """The exact "owner, or a member of the workspace it's shared into"
    rule DataSource/Dashboard/Pipeline all already enforce at their own
    router, applied generically here since all three carry owner_id +
    workspace_id columns directly."""
    if ws_ids:
        return query.filter(or_(model.owner_id == user.id, model.workspace_id.in_(ws_ids)))
    return query.filter(model.owner_id == user.id)


def _matches(q: str, *texts: str | None) -> bool:
    if not q:
        return True
    return any(t and q in t.lower() for t in texts)


def search_catalog(db: Session, user: models.User, query: str) -> list[dict]:
    """Every asset this `user` can at least VIEW whose name or description
    contains `query` (case-insensitive substring), or - when `query` is
    blank - a browsable listing of everything (columns excluded from a
    blank query; see _MAX_COLUMN_MATCHES_PER_DATASOURCE's own comment on
    why columns only ever appear once there's something to actually search
    for). Returns a flat list of plain dicts shaped like
    schemas.CatalogEntryOut - the caller (routers/catalog.py) is what
    turns these into that response model."""
    q = (query or "").strip().lower()
    ws_ids = workspace_access.member_workspace_ids(db, user.id)

    entries: list[dict] = []

    datasources = _visible(db.query(models.DataSource), models.DataSource, user, ws_ids).order_by(
        models.DataSource.name
    ).all()
    ds_by_id = {ds.id: ds for ds in datasources}

    for ds in datasources:
        if _matches(q, ds.name, ds.description):
            entries.append(
                {
                    "asset_type": "datasource",
                    "id": ds.id,
                    "name": ds.name,
                    "subtitle": ds.kind,
                    "description": ds.description,
                    "parent_id": None,
                    "parent_name": None,
                }
            )
        if q:
            columns = (ds.schema_cache or {}).get("columns") or []
            matched = 0
            for col in columns:
                col_name = str(col.get("name", ""))
                if q not in col_name.lower():
                    continue
                entries.append(
                    {
                        "asset_type": "column",
                        # Not a real row id - a column is a fact ABOUT a
                        # data source's schema, not its own database row -
                        # this composite key is only ever used by the
                        # frontend as a React list key, never sent back to
                        # any write endpoint.
                        "id": f"{ds.id}::{col_name}",
                        "name": col_name,
                        "subtitle": str(col.get("type") or ""),
                        "description": None,
                        "parent_id": ds.id,
                        "parent_name": ds.name,
                    }
                )
                matched += 1
                if matched >= _MAX_COLUMN_MATCHES_PER_DATASOURCE:
                    break

    # DataTransform/MetricDefinition have no workspace_id of their own -
    # access to one is really access to its parent data source (the same
    # rule routers/transforms.py's/metric_definitions.py's own
    # _get_accessible_datasource already enforces), so this reuses the
    # accessible-datasource set just computed above rather than a second,
    # parallel access check.
    accessible_ds_ids = list(ds_by_id.keys())

    transforms = (
        db.query(models.DataTransform)
        .filter(models.DataTransform.datasource_id.in_(accessible_ds_ids))
        .order_by(models.DataTransform.name)
        .all()
        if accessible_ds_ids
        else []
    )
    for t in transforms:
        if not _matches(q, t.name, t.description):
            continue
        parent = ds_by_id.get(t.datasource_id)
        entries.append(
            {
                "asset_type": "transform",
                "id": t.id,
                "name": t.name,
                "subtitle": "Saved table",
                "description": t.description,
                "parent_id": t.datasource_id,
                "parent_name": parent.name if parent else None,
            }
        )

    metrics = (
        db.query(models.MetricDefinition)
        .filter(models.MetricDefinition.datasource_id.in_(accessible_ds_ids))
        .order_by(models.MetricDefinition.name)
        .all()
        if accessible_ds_ids
        else []
    )
    for m in metrics:
        if not _matches(q, m.name, m.description):
            continue
        parent = ds_by_id.get(m.datasource_id)
        entries.append(
            {
                "asset_type": "metric",
                "id": m.id,
                "name": m.name,
                "subtitle": f"{m.agg} of {m.metric_column}",
                "description": m.description,
                "parent_id": m.datasource_id,
                "parent_name": parent.name if parent else None,
            }
        )

    # layout_version==2 only - a v1 flat chart-board has no pages/blocks/
    # deep content for a catalog entry to be meaningfully "about", the same
    # scope line routers/jobs.py's own _visible_dashboards already draws.
    dashboards = (
        _visible(db.query(models.Dashboard), models.Dashboard, user, ws_ids)
        .filter(models.Dashboard.layout_version == 2)
        .order_by(models.Dashboard.name)
        .all()
    )
    for d in dashboards:
        if not _matches(q, d.name):
            continue
        entries.append(
            {
                "asset_type": "dashboard",
                "id": d.id,
                "name": d.name,
                "subtitle": "Dashboard",
                "description": None,
                "parent_id": None,
                "parent_name": None,
            }
        )

    pipelines = _visible(db.query(models.Pipeline), models.Pipeline, user, ws_ids).order_by(
        models.Pipeline.name
    ).all()
    for p in pipelines:
        if not _matches(q, p.name, p.description):
            continue
        entries.append(
            {
                "asset_type": "pipeline",
                "id": p.id,
                "name": p.name,
                "subtitle": "Pipeline",
                "description": p.description,
                "parent_id": None,
                "parent_name": None,
            }
        )

    return entries
