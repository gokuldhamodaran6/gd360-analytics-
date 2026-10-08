"""
The catalog: what every source in a Project holds and how it is queried.

Three ways a source is reached (the "mode"):
  live    - a warehouse or database (BigQuery, Snowflake, Postgres, MySQL,
            SQL Server, Supabase). Queried where it lives, in its own SQL
            dialect, through services/warehouse_exec. Always current.
  synced  - an app with an API (Shopify, GA4, Meta Ads, Google Ads). Its
            records are copied on a schedule into SyncedTable rows
            (services/synced_sources) and queried with DuckDB.
  file    - an upload, a spreadsheet, a REST API snapshot, a stream or a
            MongoDB collection: loaded through services/data_loader and
            queried with DuckDB.

Table names the planner may use are the names shown here. For live
sources they are the warehouse's own table names; for DuckDB sources they
are safe identifiers derived from the sheet / file / table name, mapped
back to the real table when the data is loaded.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy.orm import Session

from ... import models
from .. import data_access_rules, workspace_access

LIVE_DIALECTS = {
    "bigquery": "bigquery",
    "snowflake": "snowflake",
    "postgres": "postgres",
    "supabase": "postgres",
    "mysql": "mysql",
    "sqlserver": "tsql",
}
SYNCED_KINDS = ("shopify", "ga4", "meta_ads", "google_ads")
LOADED_KINDS = ("csv", "excel", "api", "google_sheets", "microsoft_excel", "streaming", "mongodb")

KIND_LABELS = {
    "bigquery": "BigQuery", "snowflake": "Snowflake", "postgres": "PostgreSQL", "supabase": "Supabase",
    "mysql": "MySQL", "sqlserver": "SQL Server", "csv": "CSV file", "excel": "Excel file", "api": "REST API",
    "google_sheets": "Google Sheets", "microsoft_excel": "Excel Online", "streaming": "Event stream",
    "mongodb": "MongoDB", "shopify": "Shopify", "ga4": "Google Analytics 4", "meta_ads": "Meta Ads",
    "google_ads": "Google Ads",
}

MAX_TABLES_PER_SOURCE = 40
MAX_COLUMNS_PER_TABLE = 80


@dataclass
class CatalogTable:
    name: str                 # what the planner writes in SQL
    source_key: str | None    # the real table / sheet key to load (DuckDB sources)
    columns: list[dict]       # [{name, type}]


@dataclass
class CatalogSource:
    id: str
    name: str
    kind: str
    mode: str                 # live | synced | file
    dialect: str              # sqlglot dialect the planner must write
    tables: list[CatalogTable] = field(default_factory=list)
    freshness: str = ""
    restricted: bool = False  # the person has row/column rules on this source
    note: str = ""

    @property
    def label(self) -> str:
        return KIND_LABELS.get(self.kind, self.kind)

    def table(self, name: str) -> CatalogTable | None:
        low = name.strip().strip('`"[]').lower()
        for t in self.tables:
            if t.name.lower() == low or t.name.lower().split(".")[-1] == low.split(".")[-1]:
                return t
        return None


def safe_identifier(name: str, taken: set[str]) -> str:
    base = re.sub(r"[^0-9a-zA-Z_]+", "_", (name or "").strip()).strip("_").lower() or "data"
    if base[0].isdigit():
        base = f"t_{base}"
    out, i = base, 2
    while out in taken:
        out, i = f"{base}_{i}", i + 1
    taken.add(out)
    return out


def source_mode(kind: str) -> str:
    if kind in LIVE_DIALECTS:
        return "live"
    if kind in SYNCED_KINDS:
        return "synced"
    return "file"


def _ago(ts: datetime | None) -> str:
    if not ts:
        return "never"
    secs = max(0, int((datetime.utcnow() - ts).total_seconds()))
    if secs < 90:
        return "just now"
    if secs < 3600:
        return f"{secs // 60} min ago"
    if secs < 86400:
        return f"{secs // 3600} h ago"
    return f"{secs // 86400} d ago"


def freshness_text(ds: models.DataSource) -> str:
    mode = source_mode(ds.kind)
    if mode == "live":
        return "live"
    if mode == "synced":
        if ds.sync_error and not ds.last_synced_at:
            return "sync failed"
        return f"synced {_ago(ds.last_synced_at)}"
    if ds.kind == "api":
        return f"fetched {_ago(ds.api_last_refreshed_at or ds.created_at)}"
    if ds.kind == "streaming":
        return f"last event {_ago(ds.last_event_at)}"
    if ds.kind in ("google_sheets", "microsoft_excel", "mongodb"):
        return "read when asked"
    return f"uploaded {_ago(ds.created_at)}"


def _schema_tables(ds: models.DataSource) -> list[tuple[str, list[dict]]]:
    """(table key, columns) pairs from the cached schema, in either of the
    two shapes schema_cache comes in."""
    cache = ds.schema_cache if isinstance(ds.schema_cache, dict) else {}
    if not cache:
        return []
    if list(cache.keys()) == ["columns"] and isinstance(cache.get("columns"), list):
        return [(None, cache["columns"])]  # one implicit table
    out = []
    for key, cols in cache.items():
        if isinstance(cols, list):
            out.append((key, cols))
    return out


def _columns(cols: list) -> list[dict]:
    out = []
    for c in cols[:MAX_COLUMNS_PER_TABLE]:
        if isinstance(c, dict) and c.get("name") is not None:
            out.append({"name": str(c["name"]), "type": str(c.get("type") or "")})
        elif isinstance(c, str):
            out.append({"name": c, "type": ""})
    return out


def build_source(db: Session, ds: models.DataSource, user: models.User) -> CatalogSource:
    mode = source_mode(ds.kind)
    dialect = LIVE_DIALECTS.get(ds.kind, "duckdb")
    src = CatalogSource(
        id=ds.id, name=ds.name, kind=ds.kind, mode=mode, dialect=dialect, freshness=freshness_text(ds),
    )
    try:
        src.restricted = bool(data_access_rules.has_active_restrictions(db, ds, user))
    except Exception:  # noqa: BLE001 - a rules lookup must never hide a source
        src.restricted = False

    if mode == "synced":
        rows = (
            db.query(models.SyncedTable.table_name, models.SyncedTable.columns, models.SyncedTable.row_count)
            .filter(models.SyncedTable.datasource_id == ds.id)
            .order_by(models.SyncedTable.table_name)
            .all()
        )
        for name, cols, _n in rows[:MAX_TABLES_PER_SOURCE]:
            src.tables.append(CatalogTable(name=name, source_key=name, columns=_columns(cols or [])))
        if not rows:
            src.note = "No data has been synced from this app yet."
        return src

    pairs = _schema_tables(ds)
    if mode == "live":
        for key, cols in pairs[:MAX_TABLES_PER_SOURCE]:
            src.tables.append(CatalogTable(name=key or ds.name, source_key=key, columns=_columns(cols)))
        if src.restricted:
            src.note = "You have row or column rules on this source; GD360 can only use it in ways those rules allow."
        return src

    taken: set[str] = set()
    for key, cols in pairs[:MAX_TABLES_PER_SOURCE]:
        name = safe_identifier(key if key else ds.name, taken)
        src.tables.append(CatalogTable(name=name, source_key=key, columns=_columns(cols)))
    if ds.kind == "mongodb":
        src.note = "MongoDB collections are read up to the first 75,000 documents."
    return src


def accessible_sources(db: Session, user: models.User, workspace_id: str | None = None) -> list[models.DataSource]:
    """Every data source this person may ask about, newest first. With a
    workspace id: the sources in that workspace (or, for the personal
    workspace, their own unshared ones)."""
    q = db.query(models.DataSource).filter(workspace_access.datasource_access_filter(db, user))
    rows = q.order_by(models.DataSource.created_at.desc()).all()
    if workspace_id:
        ids = set(workspace_access.accessible_datasource_ids_in_workspace(db, user, workspace_id))
        rows = [r for r in rows if r.id in ids]
    return rows


@dataclass
class Catalog:
    sources: list[CatalogSource]

    def source(self, source_id: str) -> CatalogSource | None:
        for s in self.sources:
            if s.id == source_id:
                return s
        return None

    def shared_keys(self) -> list[str]:
        """Column names that appear in two or more sources - the likely join
        keys (date, channel, campaign, order_id ...)."""
        seen: dict[str, set[str]] = {}
        for s in self.sources:
            names = set()
            for t in s.tables:
                for c in t.columns:
                    names.add(c["name"].lower())
            for n in names:
                seen.setdefault(n, set()).add(s.id)
        keys = [n for n, ids in seen.items() if len(ids) > 1]
        return sorted(keys)[:30]

    def prompt_text(self, max_chars: int = 24000) -> str:
        """The catalog as the planner reads it."""
        lines: list[str] = []
        for s in self.sources:
            lines.append(
                f'SOURCE id="{s.id}" name="{s.name}" type={s.label} mode={s.mode} '
                f"sql_dialect={s.dialect} freshness={s.freshness!r}"
            )
            if s.note:
                lines.append(f"  note: {s.note}")
            for t in s.tables:
                cols = ", ".join(f"{c['name']} ({c['type'] or '?'})" for c in t.columns)
                lines.append(f"  TABLE {t.name}: {cols}")
            if not s.tables:
                lines.append("  (no tables available)")
        keys = self.shared_keys()
        if keys:
            lines.append("COLUMNS SHARED BY MORE THAN ONE SOURCE (likely join keys): " + ", ".join(keys))
        text = "\n".join(lines)
        if len(text) > max_chars:
            text = text[:max_chars] + "\n  ... (catalog truncated)"
        return text


def build_catalog(db: Session, user: models.User, source_ids: list[str]) -> Catalog:
    out: list[CatalogSource] = []
    for sid in source_ids:
        ds = db.query(models.DataSource).filter(models.DataSource.id == sid).first()
        if not ds or not workspace_access.can_access_datasource(db, ds, user):
            continue
        out.append(build_source(db, ds, user))
    return Catalog(sources=out)
