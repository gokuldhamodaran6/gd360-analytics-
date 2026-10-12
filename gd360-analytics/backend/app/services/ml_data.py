"""
ML engine v2 - the data layer (2026-10-12, round 39).

Before this round every ML Studio run read the WHOLE table into pandas on
the web server and then kept its first 50,000 rows: big files ran the
512 MB server out of memory before training even started, and the rows
that were kept were whatever sat at the top of the file. This module is
the one way ML Studio reads data now:

  SNAPSHOT  each source table becomes a read-only DuckDB file on disk, built
            once per version of the data (a synced app's sync, an upload, an
            import re-run) and reused by every run after it. Big CSV uploads
            stream straight into it; nothing holds the whole table in memory.
            Live warehouses and databases are never copied: their SQL runs
            where the data lives and only a fair sample comes back.
  BENCH     one run's DuckDB connection: the snapshots attached READ-ONLY,
            the person's row and column access rules compiled into a view,
            then file access switched off for good - so the SQL a person or
            the LLM writes (spec["prep_sql"]) can read those views and
            nothing else on the machine. Working memory is capped; big sorts
            and joins spill to disk instead of failing.
  BUDGET    how many rows this run can train on, worked out from a 2,000-row
            pilot and the memory really free - not a fixed number.
  SAMPLE    above the budget, a fair sample taken in SQL: stratified on the
            label (rare classes kept), the most recent rows when the model is
            tested on time, whole groups (orders, customers) when the kind
            needs them, otherwise a seeded reservoir sample. The run says
            exactly what it used and why.
  JOINS     joined tables are aggregated per key in SQL over ALL their rows
            (no cap), with the same column names and rules as before.

Every statement that runs is kept (`Bench.log`) so the run page can show the
real code behind each step, and the notebook export can replay it.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shutil
import tempfile
import threading
import time
from dataclasses import dataclass, field

import duckdb
import numpy as np
import pandas as pd
from sqlalchemy import func
from sqlalchemy.orm import Session

from .. import models
from ..config import get_settings
from . import blob_io

logger = logging.getLogger(__name__)

SNAPSHOT_VERSION = 1
LIVE_KINDS = ("postgres", "mysql", "sqlserver", "supabase", "bigquery", "snowflake")
FILE_KINDS = ("csv", "excel", "api")
PILOT_ROWS = 2_000
MIN_BUDGET = 5_000


class DataError(ValueError):
    """Something about the data or the request, said plainly to the person."""


# ------------------------------------------------------------- helpers ----

def q(name: str) -> str:
    """A DuckDB identifier, always quoted."""
    return '"' + str(name).replace('"', '""') + '"'


def lit(v) -> str:
    """A SQL string literal."""
    return "'" + str(v).replace("'", "''") + "'"


def _slug(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]+", "_", str(s or "table"))[:60].strip("_") or "table"


def cache_root() -> str:
    root = get_settings().ML_CACHE_DIR or os.path.join(tempfile.gettempdir(), "gd360_ml")
    os.makedirs(os.path.join(root, "snapshots"), exist_ok=True)
    os.makedirs(os.path.join(root, "spill"), exist_ok=True)
    return root


def _read_int(path: str) -> int | None:
    try:
        with open(path) as f:
            v = f.read().strip()
        return None if v in ("max", "") else int(v)
    except Exception:  # noqa: BLE001
        return None


def memory_free_mb() -> int:
    """Memory this process can still use, in MB: the container's limit minus
    what it uses now (cgroup v2/v1), else the machine's available memory."""
    s = get_settings()
    limit = s.ML_MEMORY_LIMIT_MB * 1024 * 1024 or None
    if not limit:
        for p in ("/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"):
            v = _read_int(p)
            if v and v < 1 << 50:
                limit = v
                break
    used = None
    if limit:
        for p in ("/sys/fs/cgroup/memory.current", "/sys/fs/cgroup/memory/memory.usage_in_bytes"):
            used = _read_int(p)
            if used:
                break
        if not used or s.ML_MEMORY_LIMIT_MB:
            used = _rss_bytes()
        if used is not None:
            return max(0, int((limit - used) / (1024 * 1024)))
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) // 1024
    except Exception:  # noqa: BLE001
        pass
    return 1024


def _rss_bytes() -> int | None:
    try:
        with open("/proc/self/status") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1]) * 1024
    except Exception:  # noqa: BLE001
        return None
    return None


def rss_mb() -> int:
    b = _rss_bytes()
    return int(b / (1024 * 1024)) if b else 0


def _type_family(t: str) -> str:
    t = (t or "").upper()
    if any(x in t for x in ("INT", "DOUBLE", "FLOAT", "DECIMAL", "REAL", "NUMERIC", "HUGEINT")):
        return "number"
    if "BOOL" in t:
        return "bool"
    if "DATE" in t or "TIME" in t:
        return "date"
    return "text"


# ------------------------------------------------------------ snapshots ----

@dataclass
class Snapshot:
    """One source table as a run sees it."""
    source_id: str
    source: str
    kind: str
    table: str
    key: str | None
    mode: str                       # "snapshot" | "live"
    path: str | None = None         # the DuckDB file (mode "snapshot")
    rows: int = 0
    columns: list = field(default_factory=list)   # [(name, duckdb type)]
    how: str = ""                   # how it was read, in words
    reused: bool = False
    build_seconds: float = 0.0
    fingerprint: str = ""
    live_sql: str | None = None     # mode "live": the statements that ran where the data lives


_BUILD_LOCKS: dict[str, threading.Lock] = {}
_BUILD_LOCKS_GUARD = threading.Lock()


def _lock_for(path: str) -> threading.Lock:
    with _BUILD_LOCKS_GUARD:
        return _BUILD_LOCKS.setdefault(path, threading.Lock())


def _fingerprint(db: Session, ds: models.DataSource, entry: dict) -> str:
    key = entry.get("key") or entry.get("table") or ""
    if entry.get("mode") == "synced" or ds.kind not in FILE_KINDS:
        row = (db.query(models.SyncedTable.synced_at, models.SyncedTable.row_count)
               .filter(models.SyncedTable.datasource_id == ds.id, models.SyncedTable.table_name == key).first())
        if row is None:
            row = (db.query(models.SyncedTable.synced_at, models.SyncedTable.row_count, models.SyncedTable.table_name)
                   .filter(models.SyncedTable.datasource_id == ds.id).order_by(models.SyncedTable.table_name).first())
        if row is None:
            raise DataError("No data has been synced from this app yet - sync it first.")
        basis = f"synced|{row[0]}|{row[1]}"
    else:
        size = db.query(func.length(models.DataSource.file_data)).filter(models.DataSource.id == ds.id).scalar() or 0
        info = ds.connection_info or {}
        basis = "file|" + json.dumps([size, (info.get("import_by_sheet") or {}).get(key or "") or None,
                                      info.get("refreshed_at") or info.get("last_refreshed_at"), str(getattr(ds, "created_at", ""))],
                                     sort_keys=True, default=str)
    return hashlib.sha1(f"v{SNAPSHOT_VERSION}|{ds.id}|{key}|{basis}".encode()).hexdigest()


def _frame_for_duckdb(df: pd.DataFrame) -> pd.DataFrame:
    """Object columns with mixed Python types become text (None kept), so
    DuckDB can store them; numbers, booleans and dates keep their types."""
    out = df.copy() if any(df[c].dtype == object for c in df.columns) else df
    for c in out.columns:
        if out[c].dtype == object:
            s = out[c]
            out[c] = s.where(s.isna(), s.astype(str))
    out.columns = [str(c) for c in out.columns]
    return out


def snapshot(db: Session, ds: models.DataSource, entry: dict) -> Snapshot:
    """The read-only DuckDB file for one table, building it when the data
    changed (or never was). Live warehouses are not copied (mode "live")."""
    key = entry.get("key") or entry.get("table")
    snap = Snapshot(source_id=ds.id, source=ds.name, kind=ds.kind, table=entry.get("table") or key or "table", key=key,
                    mode="live" if ds.kind in LIVE_KINDS and entry.get("mode") != "synced" else "snapshot")
    if snap.mode == "live":
        snap.how = f"{_KIND_WORDS.get(ds.kind, ds.kind)} runs the SQL; only the rows the run needs come back"
        return snap
    fp = _fingerprint(db, ds, entry)
    snap.fingerprint = fp
    folder = os.path.join(cache_root(), "snapshots", ds.id)
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, f"{_slug(key or 'table')}-{fp[:16]}.duckdb")
    snap.path = path
    with _lock_for(path):
        if os.path.exists(path):
            snap.reused = True
            os.utime(path, None)
        else:
            t0 = time.time()
            for old in os.listdir(folder):
                if old.startswith(_slug(key or "table") + "-") and old.endswith(".duckdb"):
                    try:
                        os.remove(os.path.join(folder, old))   # an older version of the same table
                    except OSError:
                        pass
            snap.how = _build(db, ds, entry, path)
            snap.build_seconds = round(time.time() - t0, 2)
            _trim_cache()
    con = duckdb.connect(path, read_only=True)
    try:
        snap.rows = int(con.execute("SELECT COUNT(*) FROM data").fetchone()[0])
        snap.columns = [(r[0], r[1]) for r in con.execute("DESCRIBE data").fetchall()]
    finally:
        con.close()
    if snap.reused:
        snap.how = "a snapshot of this exact version of the data, reused"
    return snap


_KIND_WORDS = {"postgres": "PostgreSQL", "mysql": "MySQL", "sqlserver": "SQL Server", "supabase": "Supabase",
               "bigquery": "BigQuery", "snowflake": "Snowflake"}


def _build(db: Session, ds: models.DataSource, entry: dict, path: str) -> str:
    """Writes the snapshot to a temporary file, then moves it into place, so
    a half-built file is never used. Returns how it was read, in words."""
    tmp = f"{path}.{os.getpid()}.{threading.get_ident()}.tmp"
    for p in (tmp, tmp + ".wal"):
        if os.path.exists(p):
            os.remove(p)
    key = entry.get("key") or entry.get("table")
    how = ""
    con = duckdb.connect(tmp)
    try:
        con.execute(f"SET memory_limit='{_duck_memory_mb()}MB'")
        con.execute(f"SET temp_directory={lit(os.path.join(cache_root(), 'spill'))}")
        if entry.get("mode") == "synced" or ds.kind not in FILE_KINDS:
            row = (db.query(models.SyncedTable).filter(models.SyncedTable.datasource_id == ds.id,
                                                      models.SyncedTable.table_name == key).first()
                   or db.query(models.SyncedTable).filter(models.SyncedTable.datasource_id == ds.id)
                   .order_by(models.SyncedTable.table_name).first())
            if row is None:
                raise DataError("No data has been synced from this app yet - sync it first.")
            pq = tmp + ".parquet"
            with open(pq, "wb") as f:
                f.write(row.parquet_data)
            try:
                con.execute(f"CREATE TABLE data AS SELECT * FROM read_parquet({lit(pq)})")
            finally:
                os.remove(pq)
            how = "the app's last sync, read straight from its Parquet copy"
        else:
            how = _build_file(db, ds, entry, con, tmp)
        con.execute("CHECKPOINT")
    except Exception:
        con.close()
        for p in (tmp, tmp + ".wal"):
            if os.path.exists(p):
                os.remove(p)
        raise
    con.close()
    os.replace(tmp, path)
    return how


def _build_file(db: Session, ds: models.DataSource, entry: dict, con, tmp: str) -> str:
    from . import data_loader
    key = entry.get("key") or entry.get("table")
    sheet = data_loader._excel_sheet_name(key, ds.schema_cache) if ds.kind == "excel" else None  # noqa: SLF001
    settings_, _ = data_loader.file_import_settings_for(ds, sheet)
    size = db.query(func.length(models.DataSource.file_data)).filter(models.DataSource.id == ds.id).scalar() or 0
    if ds.kind == "csv" and not settings_ and size > get_settings().ML_FAST_CSV_MB * 1024 * 1024:
        # a big CSV read with the default settings: DuckDB streams it from disk
        csv = tmp + ".csv"
        blob_io.copy_to_file(db, models.DataSource, "file_data", ds.id, csv)  # a slice at a time, never whole
        try:
            con.execute(f"CREATE TABLE data AS SELECT * FROM read_csv({lit(csv)}, header=true, sample_size=20480, ignore_errors=false)")
            return "the uploaded CSV, streamed into a snapshot without loading it whole"
        except Exception as e:  # noqa: BLE001 - an unusual file: the app's own reader below
            logger.info("[ml_data] streaming CSV read fell back to pandas for %s: %s", ds.id, e)
            con.execute("DROP TABLE IF EXISTS data")
        finally:
            if os.path.exists(csv):
                os.remove(csv)
    df = data_loader._load_original(ds, table=key, db=db)  # noqa: SLF001 - the exact frame the Data tab shows
    con.register("frame", _frame_for_duckdb(df))
    con.execute("CREATE TABLE data AS SELECT * FROM frame")
    con.unregister("frame")
    del df
    return "the uploaded file, read with its import settings, kept as a snapshot"


def _trim_cache() -> None:
    """Removes the least recently used snapshots past ML_CACHE_MAX_MB."""
    root = os.path.join(cache_root(), "snapshots")
    files = []
    for d, _, names in os.walk(root):
        for n in names:
            if n.endswith(".duckdb"):
                p = os.path.join(d, n)
                try:
                    st = os.stat(p)
                    files.append((st.st_atime, st.st_size, p))
                except OSError:
                    pass
    total = sum(s for _, s, _ in files)
    cap = get_settings().ML_CACHE_MAX_MB * 1024 * 1024
    for _, size, p in sorted(files):
        if total <= cap:
            break
        try:
            os.remove(p)
            total -= size
        except OSError:
            pass


def forget_source(ds_id: str) -> None:
    """Drops every snapshot of a source (it was deleted)."""
    shutil.rmtree(os.path.join(cache_root(), "snapshots", ds_id), ignore_errors=True)


# --------------------------------------------------------- access rules ----

def access_rules(db: Session, ds: models.DataSource, user: models.User) -> tuple[list[str], list[tuple[str, list]]]:
    """(hidden columns, [(column, allowed values)]) for this person - the same
    rules data_access_rules.filter_dataframe_for_role applies, as data."""
    from . import data_access_rules
    role = data_access_rules.resolve_restriction_role(db, ds, user)
    if role is None:
        return [], []
    rules = (db.query(models.DataAccessRule)
             .filter(models.DataAccessRule.datasource_id == ds.id, models.DataAccessRule.role == role).all())
    hidden = [r.column_name for r in rules if r.kind == "column"]
    rows = [(r.column_name, list(r.allowed_values or [])) for r in rules if r.kind == "row"]
    return hidden, rows


def _rule_sql(col: str, allowed: list) -> str:
    """A row rule as SQL with the pandas `isin` meaning: a value passes when it
    equals one of the allowed values (text or number); empty list = no rows."""
    if not allowed:
        return "FALSE"
    texts = [lit(v) for v in allowed if v is not None]
    nums = []
    for v in allowed:
        try:
            if isinstance(v, bool):
                continue
            nums.append(repr(float(v)))
        except (TypeError, ValueError):
            pass
    parts = []
    if texts:
        parts.append(f"CAST({q(col)} AS VARCHAR) IN ({', '.join(texts)})")
    if nums:
        parts.append(f"TRY_CAST({q(col)} AS DOUBLE) IN ({', '.join(nums)})")
    return "(" + " OR ".join(parts) + ")" if parts else "FALSE"


# --------------------------------------------------------------- bench ----

def _duck_memory_mb() -> int:
    s = get_settings()
    if s.ML_DUCKDB_MEMORY_MB:
        return int(s.ML_DUCKDB_MEMORY_MB)
    return int(max(64, min(1024, memory_free_mb() * 0.3)))


@dataclass
class LogEntry:
    step: str
    title: str
    sql: str
    engine: str
    rows: int | None
    seconds: float
    note: str = ""


class Bench:
    """One run's sandboxed DuckDB: sources attached read-only as views (access
    rules applied), then file access switched off. `log` keeps every
    statement for the run page and the notebook."""

    def __init__(self, memory_mb: int | None = None):
        self.con = duckdb.connect(database=":memory:")
        self.memory_mb = int(memory_mb or _duck_memory_mb())
        self.con.execute(f"SET memory_limit='{self.memory_mb}MB'")
        self.con.execute(f"SET temp_directory={lit(os.path.join(cache_root(), 'spill'))}")
        self.con.execute(f"SET threads={max(1, min(4, os.cpu_count() or 1))}")
        self.con.execute("SET preserve_insertion_order=false")
        self.views: dict[str, Snapshot] = {}
        self.log: list[LogEntry] = []
        self._n = 0
        self.locked = False

    # sources -------------------------------------------------------------
    def attach(self, db: Session, user: models.User, snap: Snapshot, view: str, frame: pd.DataFrame | None = None) -> str:
        """A view named `view` over the snapshot (or, for a live source, over
        the rows `frame` already holds), with the person's access rules."""
        ds = db.get(models.DataSource, snap.source_id)
        hidden, rows = access_rules(db, ds, user) if ds else ([], [])
        if snap.mode == "snapshot":
            if self.locked:
                raise DataError("Sources must be attached before the run's SQL starts.")
            self._n += 1
            alias = f"s{self._n}"
            self.con.execute(f"ATTACH {lit(snap.path)} AS {alias} (READ_ONLY)")
            base = f"{alias}.data"
            cols = [c for c, _ in snap.columns]
        else:
            if frame is None:
                raise DataError("A live source needs its rows first.")
            self._n += 1
            base = f"live_{self._n}"
            self.con.register(base, _frame_for_duckdb(frame))
            cols = [str(c) for c in frame.columns]
        visible = [c for c in cols if c not in set(hidden)]
        where = " AND ".join(_rule_sql(c, a) for c, a in rows if c in cols)
        sql = f"CREATE OR REPLACE VIEW {q(view)} AS SELECT {', '.join(q(c) for c in visible)} FROM {base}" + (f" WHERE {where}" if where else "")
        self.con.execute(sql)
        self.views[view] = snap
        return view

    def lock(self) -> None:
        """No more files from here on: the run's own SQL (and the person's or
        the LLM's) can read the attached views and nothing else."""
        if not self.locked:
            self.con.execute("SET enable_external_access=false")
            self.con.execute("SET lock_configuration=true")
            self.locked = True

    # running -------------------------------------------------------------
    def run(self, sql: str, *, step: str = "", title: str = "", engine: str = "DuckDB", note: str = "", fetch: bool = True,
            log: bool = True) -> pd.DataFrame | None:
        t0 = time.time()
        res = self.con.execute(sql)
        df = res.df() if fetch else None
        if log:
            self.log.append(LogEntry(step=step, title=title, sql=sql.strip(), engine=engine,
                                     rows=(len(df) if df is not None else None), seconds=round(time.time() - t0, 3), note=note))
        return df

    def scalar(self, sql: str):
        return self.con.execute(sql).fetchone()[0]

    def columns(self, view: str) -> list[tuple[str, str]]:
        return [(r[0], r[1]) for r in self.con.execute(f"DESCRIBE {q(view)}").fetchall()]

    def count(self, view: str) -> int:
        return int(self.scalar(f"SELECT COUNT(*) FROM {q(view)}"))

    def close(self) -> None:
        try:
            self.con.close()
        except Exception:  # noqa: BLE001
            pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()


# ----------------------------------------------------- live warehouses ----

def _live_quote(kind: str, name: str) -> str:
    parts = [p for p in str(name).split(".") if p]
    if kind in ("mysql", "bigquery"):
        return ".".join("`" + p.replace("`", "``") + "`" for p in parts)
    if kind == "sqlserver":
        return ".".join("[" + p.replace("]", "]]") + "]" for p in parts)
    return ".".join('"' + p.replace('"', '""') + '"' for p in parts)


def _live_table(ds: models.DataSource, key: str) -> str:
    if ds.kind == "bigquery" and "." not in key:
        return _live_quote("bigquery", f"{(ds.connection_info or {}).get('dataset_id')}.{key}")
    return _live_quote(ds.kind, key)


def live_rows(db: Session, user: models.User, ds: models.DataSource, key: str, n: int, *, time_col: str | None = None,
              columns: list[str] | None = None) -> tuple[pd.DataFrame, int, str, str]:
    """(rows, total rows, the SQL that ran, how) for a live warehouse table:
    a COUNT, then either every row (small tables) or a fair sample taken BY
    the warehouse - the most recent rows when the run tests on time, a random
    sample otherwise. Access rules apply to what comes back."""
    from . import data_access_rules, warehouse_exec
    if ds.kind not in warehouse_exec.SQL_WAREHOUSE_KINDS:
        # Mongo, Google Sheets, Excel Online: the source's own reader, first n rows
        from .data_loader import load_dataframe
        df = load_dataframe(ds, table=key, version="original", row_limit=n + 1, db=db)
        total = len(df)
        df = data_access_rules.filter_dataframe_for_role(db, df.head(n), ds, user)
        return df.reset_index(drop=True), total, "", f"read through the {ds.kind} connector (first {n:,} rows)"
    tbl = _live_table(ds, key)
    cols = ", ".join(_live_quote(ds.kind, c) for c in columns) if columns else "*"
    count_sql = f"SELECT COUNT(*) AS n FROM {tbl}"
    cdf, _ = warehouse_exec.run_sql(ds, count_sql)
    total = int(cdf.iloc[0, 0]) if len(cdf) else 0
    if total <= n:
        sql = f"SELECT {cols} FROM {tbl}"
        how = f"every row, read from {_KIND_WORDS.get(ds.kind, ds.kind)}"
    elif time_col:
        tc = _live_quote(ds.kind, time_col)
        sql = (f"SELECT TOP {n} {cols} FROM {tbl} ORDER BY {tc} DESC" if ds.kind == "sqlserver"
               else f"SELECT {cols} FROM {tbl} ORDER BY {tc} DESC LIMIT {n}")
        how = f"the most recent {n:,} of {total:,} rows, chosen by {_KIND_WORDS.get(ds.kind, ds.kind)}"
    else:
        pct = max(0.01, min(100.0, n / max(total, 1) * 100 * 1.15))
        if ds.kind == "bigquery":
            sql = f"SELECT {cols} FROM {tbl} WHERE RAND() < {pct / 100:.6f} LIMIT {n}"
        elif ds.kind == "snowflake":
            sql = f"SELECT {cols} FROM {tbl} SAMPLE ({n} ROWS)"
        elif ds.kind == "sqlserver":
            sql = f"SELECT TOP {n} {cols} FROM {tbl} ORDER BY NEWID()"
        elif ds.kind == "mysql":
            sql = f"SELECT {cols} FROM {tbl} ORDER BY RAND() LIMIT {n}"
        else:
            sql = f"SELECT {cols} FROM {tbl} TABLESAMPLE BERNOULLI ({pct:.4f}) LIMIT {n}"
        how = f"a random {n:,} of {total:,} rows, sampled by {_KIND_WORDS.get(ds.kind, ds.kind)}"
    try:
        df, _ = warehouse_exec.run_sql(ds, sql)
    except Exception as e:  # noqa: BLE001
        raise DataError(f"{_KIND_WORDS.get(ds.kind, ds.kind)} couldn't read {key}: {warehouse_exec.clean_warehouse_error(e)}") from e
    df = data_access_rules.filter_dataframe_for_role(db, df, ds, user)
    return df.reset_index(drop=True), total, count_sql + ";\n" + sql, how


# --------------------------------------------------------------- budget ----

@dataclass
class Budget:
    rows: int
    free_mb: int
    per_row_bytes: int
    reason: str


def row_budget(bench: Bench, view: str, *, kind: str = "", factor: float = 1.0) -> Budget:
    """How many rows this run can hold and train on, from a 2,000-row pilot
    measured in pandas and the memory really free right now."""
    s = get_settings()
    total = bench.count(view)
    pilot = bench.run(f"SELECT * FROM {q(view)} USING SAMPLE reservoir({PILOT_ROWS} ROWS) REPEATABLE (7)", log=False)
    per_row = float(pilot.memory_usage(deep=True).sum()) / max(len(pilot), 1) if len(pilot) else 200.0
    cats = sum(1 for c in pilot.columns if pilot[c].dtype == object)
    nums = len(pilot.columns) - cats
    # raw frame + the cleaned copy + the model matrix (numbers, one-hot up to 20 per category, date parts)
    peak = per_row * 2.6 + nums * 8 * 3 + cats * 20 * 8 + 64
    free = memory_free_mb()
    inline = s.ML_WORKER_MODE != "external"
    usable_mb = (free - (s.ML_RESERVE_MB if inline else 0)) * (0.75 if inline else 0.8)
    rows = int(max(0.0, usable_mb) * 1024 * 1024 / max(peak, 1) * max(0.05, factor))
    ceiling = int(s.ML_MAX_TRAIN_ROWS * max(0.05, factor))
    reason = f"about {int(max(0, usable_mb)):,} MB free for this run at ~{int(peak):,} bytes a row"
    if kind in _KIND_CEILINGS:
        ceiling = min(ceiling, _KIND_CEILINGS[kind])
    fits = min(rows, ceiling)
    rows = max(MIN_BUDGET, fits)
    if fits < MIN_BUDGET < total:
        reason = (f"memory is tight on this server right now (about {int(max(0, free)):,} MB free), so it learns from "
                  f"a fair {MIN_BUDGET:,}-row sample - the smallest that still trains a reliable model")
    if rows >= total:
        reason = "every row fits in the memory this run has"
    return Budget(rows=rows, free_mb=free, per_row_bytes=int(peak), reason=reason)


# kinds whose own maths grows faster than linearly with rows (a pairwise
# distance, a per-row LLM call) keep a lower ceiling - their trainers sample
# further themselves and say so
_KIND_CEILINGS = {"segments": 400_000, "anomalies": 1_000_000, "themes": 200_000, "text_tag": 200_000, "sentiment": 200_000,
                  "doc_facts": 50_000, "recommendations": 1_000_000, "bought_together": 2_000_000}


# --------------------------------------------------------------- sample ----

@dataclass
class SampleInfo:
    strategy: str      # all | stratified | recent | groups | uniform
    rows_total: int
    rows_used: int
    text: str          # one sentence for the run page
    sql: str
    balance: list | None = None   # [{value, total, used}] for a stratified sample


def take(bench: Bench, view: str, n: int, *, label: str | None = None, time_col: str | None = None,
         group_col: str | None = None, prefer: str | None = None, step: str = "sample") -> tuple[pd.DataFrame, SampleInfo]:
    """The rows a run trains on: every row when they fit, else a fair sample
    taken in SQL. `prefer` names the strategy the kind needs (recent / groups /
    stratified); without one, stratified when there is a label, else uniform."""
    seed = get_settings().ML_SAMPLE_SEED
    total = bench.count(view)
    v = q(view)
    if total <= n:
        sql = f"SELECT * FROM {v}"
        df = bench.run(sql, step=step, title="Read every row", note=f"{total:,} rows")
        return df, SampleInfo("all", total, len(df), f"All {total:,} rows - the whole table fits this run's memory.", sql)
    strategy = prefer or ("stratified" if label else "recent" if time_col else "uniform")
    if strategy == "recent" and time_col:
        sql = f"SELECT * FROM {v} ORDER BY TRY_CAST({q(time_col)} AS TIMESTAMP) DESC NULLS LAST LIMIT {n}"
        df = bench.run(sql, step=step, title="Keep the most recent rows")
        text = (f"The most recent {len(df):,} of {total:,} rows by {time_col} - the model is tested on the newest rows, "
                "so the newest history is what matters.")
        return df, SampleInfo("recent", total, len(df), text, sql)
    if strategy == "groups" and group_col:
        groups = int(bench.scalar(f"SELECT approx_count_distinct({q(group_col)}) FROM {v}") or 1)
        keep = max(1, int(groups * n / total))
        sql = (f"SELECT * FROM {v} WHERE {q(group_col)} IN (SELECT g FROM (SELECT DISTINCT {q(group_col)} AS g FROM {v}) "
               f"ORDER BY hash(g, {seed}) LIMIT {keep})")
        df = bench.run(sql, step=step, title=f"Keep whole {group_col} groups")
        text = (f"{len(df):,} of {total:,} rows: {keep:,} whole {group_col} groups chosen at random (seed {seed}), "
                "so every group keeps all of its rows.")
        return df, SampleInfo("groups", total, len(df), text, sql)
    if strategy == "stratified" and label:
        counts = bench.run(f"SELECT CAST({q(label)} AS VARCHAR) AS v, COUNT(*) AS n FROM {v} GROUP BY 1 ORDER BY 2 DESC", log=False)
        if 1 < len(counts) <= 60:
            floor = int(max(200, n * 0.02))
            quotas = []
            for _, r in counts.iterrows():
                share = int(round(n * r["n"] / total))
                quotas.append((r["v"], int(r["n"]), int(min(r["n"], max(share, min(floor, r["n"]))))))
            over = sum(x[2] for x in quotas) - n
            if over > 0:   # take the extra kept for rare classes back from the biggest one
                big = max(range(len(quotas)), key=lambda i: quotas[i][1])
                v0, t0, k0 = quotas[big]
                quotas[big] = (v0, t0, max(1, k0 - over))
            case = " ".join(f"WHEN __lv = {lit(val)} THEN {k}" for val, _, k in quotas if val is not None)
            null_k = next((k for val, _, k in quotas if val is None), 0)
            # each row's place in its class comes from a seeded hash of the row itself: the same data and seed
            # always give the same sample, however many threads DuckDB uses
            sql = (f"SELECT * EXCLUDE (__rn, __lv) FROM (SELECT __r.*, CAST(__r.{q(label)} AS VARCHAR) AS __lv, ROW_NUMBER() OVER "
                   f"(PARTITION BY CAST(__r.{q(label)} AS VARCHAR) ORDER BY hash(__r, {seed})) AS __rn FROM {v} AS __r) "
                   f"WHERE __rn <= CASE WHEN __lv IS NULL THEN {null_k} {case} ELSE 0 END")
            df = bench.run(sql, step=step, title=f"Stratified sample on {label}")
            balance = [{"value": "(empty)" if val is None else str(val), "total": t, "used": k} for val, t, k in quotas]
            text = (f"{len(df):,} of {total:,} rows, stratified on {label}: every outcome keeps its share and rare ones keep "
                    f"at least {min(floor, min(t for _, t, _ in quotas)):,} rows (seed {seed}).")
            return df, SampleInfo("stratified", total, len(df), text, sql, balance)
    sql = f"SELECT * FROM {v} USING SAMPLE reservoir({n} ROWS) REPEATABLE ({seed})"
    df = bench.run(sql, step=step, title="Random sample")
    return df, SampleInfo("uniform", total, len(df), f"A random {len(df):,} of {total:,} rows (seed {seed}, repeatable).", sql)


# -------------------------------------------------------------- profile ----

def profile(bench: Bench, view: str, *, time_col: str | None = None, label: str | None = None, max_cols: int = 40) -> dict:
    """What the data looks like, for the run page's visuals: column types,
    missing shares, distinct counts, rows over time and the label's mix."""
    v = q(view)
    cols = bench.columns(view)[:max_cols]
    total = bench.count(view)
    out: dict = {"rows": total, "columns": len(bench.columns(view)), "types": {}, "per_column": [], "over_time": None, "label": None}
    if not cols or total == 0:
        return out
    parts = []
    for c, _t in cols:
        parts.append(f"COUNT({q(c)})")
        parts.append(f"approx_count_distinct({q(c)})")
    row = bench.con.execute(f"SELECT {', '.join(parts)} FROM {v}").fetchone()
    for i, (c, t) in enumerate(cols):
        fam = _type_family(t)
        out["types"][fam] = out["types"].get(fam, 0) + 1
        filled = int(row[2 * i] or 0)
        out["per_column"].append({"name": c, "type": fam, "missing": round(1 - filled / total, 4) if total else 0.0,
                                  "distinct": int(row[2 * i + 1] or 0)})
    if time_col and time_col in {c for c, _ in cols}:
        try:
            df = bench.run(f"SELECT date_trunc('month', TRY_CAST({q(time_col)} AS TIMESTAMP)) AS period, COUNT(*) AS rows "
                           f"FROM {v} WHERE TRY_CAST({q(time_col)} AS TIMESTAMP) IS NOT NULL GROUP BY 1 ORDER BY 1", log=False)
            out["over_time"] = [{"period": str(p)[:7], "rows": int(r)} for p, r in zip(df["period"], df["rows"])][-60:]
        except Exception:  # noqa: BLE001
            pass
    if label and label in {c for c, _ in cols}:
        try:
            df = bench.run(f"SELECT CAST({q(label)} AS VARCHAR) AS value, COUNT(*) AS rows FROM {v} GROUP BY 1 ORDER BY 2 DESC LIMIT 12", log=False)
            out["label"] = {"name": label, "values": [{"value": "(empty)" if x is None else str(x), "rows": int(r)}
                                                       for x, r in zip(df["value"], df["rows"])]}
        except Exception:  # noqa: BLE001
            pass
    return out


def histogram(values, bins: int = 20) -> list[dict]:
    """[{x0, x1, count}] for a numeric series (NaN dropped)."""
    a = np.asarray(pd.to_numeric(pd.Series(values), errors="coerce").dropna(), dtype=float)
    if not len(a):
        return []
    lo, hi = float(np.nanmin(a)), float(np.nanmax(a))
    if lo == hi:
        return [{"x0": lo, "x1": hi, "count": int(len(a))}]
    counts, edges = np.histogram(a, bins=bins, range=(lo, hi))
    return [{"x0": float(edges[i]), "x1": float(edges[i + 1]), "count": int(counts[i])} for i in range(len(counts))]


# ------------------------------------------------------------ user SQL ----

_DENY_FUNCS = re.compile(r"^(read_\w+|glob|sniff_csv|parquet_\w+|duckdb_\w+|pragma_\w+|query_table|query|getenv|"
                         r"current_setting|httpfs_\w*|iceberg_\w*|delta_\w*|load|install)$", re.I)


def check_select(bench: Bench, sql: str, allowed: set[str]) -> str:
    """Accepts one SELECT (or WITH ... SELECT) that reads only the run's own
    views. Returns it cleaned; raises DataError with a plain reason."""
    text = (sql or "").strip().rstrip(";").strip()
    if not text:
        raise DataError("The SQL is empty.")
    if len(text) > 20_000:
        raise DataError("The SQL is too long (20,000 characters at most).")
    try:
        stmts = bench.con.extract_statements(text)
    except Exception as e:  # noqa: BLE001
        raise DataError(f"The SQL doesn't parse: {str(e).splitlines()[0][:200]}") from e
    if len(stmts) != 1:
        raise DataError("Write one SELECT statement - no semicolons between several.")
    if stmts[0].type != duckdb.StatementType.SELECT:
        raise DataError("Only a SELECT is allowed here - it reads the data, it never changes it.")
    try:
        tree = json.loads(bench.scalar(f"SELECT json_serialize_sql({lit(text)})"))
    except Exception as e:  # noqa: BLE001
        raise DataError(f"The SQL doesn't parse: {str(e)[:200]}") from e
    if tree.get("error"):
        raise DataError(f"The SQL doesn't parse: {tree.get('error_message', '')[:200]}")
    ctes: set[str] = set()
    bad: list[str] = []

    def walk(node):
        if isinstance(node, dict):
            cm = node.get("cte_map")
            if isinstance(cm, dict):
                for item in cm.get("map") or []:
                    if isinstance(item, dict) and item.get("key"):
                        ctes.add(str(item["key"]).lower())
            typ = node.get("type")
            if typ == "TABLE_FUNCTION":
                bad.append("a table function")
            if typ == "BASE_TABLE":
                name = str(node.get("table_name") or "")
                schema = str(node.get("schema_name") or "")
                cat = str(node.get("catalog_name") or "")
                if schema or cat or (name.lower() not in allowed and name.lower() not in ctes):
                    bad.append(f"the table {'.'.join(x for x in (cat, schema, name) if x)}")
            fn = node.get("function_name")
            if isinstance(fn, str) and _DENY_FUNCS.match(fn):
                bad.append(f"the function {fn}")
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(tree)
    # a CTE may be referenced before the walk reaches its definition - check again
    bad = [b for b in bad if not (b.startswith("the table ") and b[len("the table "):].lower() in ctes)]
    if bad:
        names = ", ".join(sorted(allowed))
        raise DataError(f"The SQL can only read this run's tables ({names}); it used {bad[0]}.")
    return text


def run_select(bench: Bench, sql: str, allowed: set[str], *, out_view: str, step: str, title: str) -> tuple[int, list[tuple[str, str]]]:
    """Runs a checked SELECT into a view (no rows are pulled into memory) and
    returns (rows, columns)."""
    text = check_select(bench, sql, allowed)
    t0 = time.time()
    bench.con.execute(f"CREATE OR REPLACE TEMP VIEW {q(out_view)} AS {text}")
    try:
        rows = bench.count(out_view)
    except Exception as e:  # noqa: BLE001
        bench.con.execute(f"DROP VIEW IF EXISTS {q(out_view)}")
        raise DataError(_clean_duck_error(e)) from e
    bench.log.append(LogEntry(step=step, title=title, sql=text, engine="DuckDB", rows=rows, seconds=round(time.time() - t0, 3)))
    return rows, bench.columns(out_view)


def _clean_duck_error(e: Exception) -> str:
    msg = str(e).strip().splitlines()[0] if str(e).strip() else type(e).__name__
    msg = re.sub(r"^(Binder|Parser|Catalog|Conversion|Invalid Input|Out of Memory) Error:\s*", "", msg)
    return msg[:300]


# ---------------------------------------------------------------- joins ----

def _norm_key_sql(col: str) -> str:
    """Join keys made comparable the same way ml_studio.norm_keys does:
    trimmed lower-case text, "12.0" -> "12", empty / nan / none / null -> NULL."""
    s = f"lower(trim(CAST({q(col)} AS VARCHAR)))"
    s = f"regexp_replace({s}, '^(-?[0-9]+)\\.0+$', '\\1')"
    return f"CASE WHEN {s} IN ('', 'nan', 'none', 'null') THEN NULL ELSE {s} END"


def _is_dateish(bench: Bench, view: str, col: str, typ: str) -> bool:
    fam = _type_family(typ)
    if fam == "date":
        return True
    if fam != "text":
        return False
    share = bench.scalar(f"SELECT AVG(CASE WHEN regexp_matches(CAST({q(col)} AS VARCHAR), '^\\d{{4}}-\\d{{2}}-\\d{{2}}') THEN 1.0 ELSE 0.0 END) "
                         f"FROM (SELECT {q(col)} FROM {q(view)} WHERE {q(col)} IS NOT NULL LIMIT 50)")
    return bool(share is not None and share > 0.9)


def aggregate_join(bench: Bench, view: str, key: str, alias: str, out_view: str, max_cols: int = 30) -> tuple[list[str], bool, int]:
    """(added columns, many rows per key?, rows in the join table) - the join
    table becomes one row per normalised key, over ALL of its rows, with the
    same columns ml_studio._aggregate_per_key makes."""
    v = q(view)
    cols = [(c, t) for c, t in bench.columns(view) if c != key]
    nk = _norm_key_sql(key)
    jrows = bench.count(view)
    dup = int(bench.scalar(f"SELECT COUNT(*) - COUNT(DISTINCT {nk}) FROM {v} WHERE {nk} IS NOT NULL") or 0)
    many = dup > 0
    made: list[str] = []
    sel = [f"{nk} AS __k"]
    if many:
        sel.append(f"COUNT(*)::DOUBLE AS {q(alias + '__rows')}")
        made.append(f"{alias}__rows")
        newest_cache: dict[str, str] = {}
        for c, t in cols[:max_cols]:
            filled = bench.scalar(f"SELECT COUNT({q(c)}) FROM {v}")
            if not filled:
                continue
            fam = _type_family(t)
            if _is_dateish(bench, view, c, t):
                newest = bench.scalar(f"SELECT MAX(TRY_CAST({q(c)} AS TIMESTAMP)) FROM {v}")
                newest_cache[c] = str(newest)
                sel.append(f"date_diff('second', MAX(TRY_CAST({q(c)} AS TIMESTAMP)), TIMESTAMP {lit(newest)}) / 86400.0 "
                           f"AS {q(f'{alias}__{c}_days_since_last')}")
                made.append(f"{alias}__{c}_days_since_last")
            elif fam in ("number", "bool"):
                x = f"TRY_CAST({q(c)} AS DOUBLE)"
                sel.append(f"SUM({x}) AS {q(f'{alias}__{c}_sum')}")
                sel.append(f"AVG({x}) AS {q(f'{alias}__{c}_mean')}")
                made += [f"{alias}__{c}_sum", f"{alias}__{c}_mean"]
            else:
                sel.append(f"COUNT(DISTINCT CAST({q(c)} AS VARCHAR))::DOUBLE AS {q(f'{alias}__{c}_distinct')}")
                made.append(f"{alias}__{c}_distinct")
                nun = int(bench.scalar(f"SELECT approx_count_distinct({q(c)}) FROM {v}") or 0)
                if nun <= 50:
                    sel.append(f"mode(CAST({q(c)} AS VARCHAR)) AS {q(f'{alias}__{c}_top')}")
                    made.append(f"{alias}__{c}_top")
        sql = f"CREATE OR REPLACE TEMP TABLE {q(out_view)} AS SELECT {', '.join(sel)} FROM {v} WHERE {nk} IS NOT NULL GROUP BY 1"
    else:
        keep = [c for c, _ in cols][:60]
        for c in keep:
            sel.append(f"{q(c)} AS {q(f'{alias}__{c}')}")
            made.append(f"{alias}__{c}")
        sql = f"CREATE OR REPLACE TEMP TABLE {q(out_view)} AS SELECT {', '.join(sel)} FROM {v} WHERE {nk} IS NOT NULL"
    t0 = time.time()
    bench.con.execute(sql)
    bench.log.append(LogEntry(step="joins", title=f"One row per {key} in the joined table", sql=sql, engine="DuckDB",
                              rows=bench.count(out_view), seconds=round(time.time() - t0, 3)))
    return made, many, jrows


def join_onto(bench: Bench, base: pd.DataFrame, base_key: str, agg_view: str, alias: str, made: list[str], many: bool) -> pd.DataFrame:
    """Left-joins the per-key table onto the run's rows (in DuckDB), keeping
    the base rows' order; unmatched rows get matched = 0 (and 0 rows / 0
    totals for a many-per-key table)."""
    clash = [c for c in made if c in base.columns]
    made = [c for c in made if c not in clash]
    frame = base.copy()
    frame["__ord"] = np.arange(len(frame))
    bench.con.register("__base", _frame_for_duckdb(frame))
    try:
        picks = ", ".join(f"a.{q(c)}" for c in made)
        sql = (f"SELECT b.*, {picks + ', ' if picks else ''}CASE WHEN a.__k IS NULL THEN 0 ELSE 1 END AS {q(alias + '__matched')} "
               f"FROM __base b LEFT JOIN {q(agg_view)} a ON {_norm_key_sql(base_key).replace(q(base_key), 'b.' + q(base_key))} = a.__k "
               f"ORDER BY b.__ord")
        t0 = time.time()
        out = bench.con.execute(sql).df()
        bench.log.append(LogEntry(step="joins", title=f"Join it onto the rows on {base_key}", sql=sql.replace("__base", "rows"),
                                  engine="DuckDB", rows=len(out), seconds=round(time.time() - t0, 3)))
    finally:
        bench.con.unregister("__base")
    out = out.drop(columns="__ord")
    # the base frame's own dtypes win (DuckDB may have widened ints / text)
    for c in base.columns:
        if c in out.columns:
            try:
                out[c] = base[c].values
            except Exception:  # noqa: BLE001
                pass
    out[f"{alias}__matched"] = out[f"{alias}__matched"].fillna(0).astype(int)
    if many:
        if f"{alias}__rows" in out.columns:
            out[f"{alias}__rows"] = out[f"{alias}__rows"].fillna(0)
        for c in made:
            if c.endswith("_sum"):
                out[c] = out[c].fillna(0)
    return out
