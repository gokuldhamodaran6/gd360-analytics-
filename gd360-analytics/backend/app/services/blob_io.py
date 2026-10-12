"""
Big byte columns in and out of Postgres without big memory (2026-10-12,
round 39).

Handing a 60 MB `bytes` value to psycopg2 as a query parameter escapes it
into the SQL text: measured, the Python process peaks ~460 MB above where it
started for one 60 MB insert. On a 512 MB server that is the crash behind
"large files struggle" - an upload, or saving a scored table.

`put_bytes` streams the bytes to the server with COPY (1 MB of hex at a
time) into a temporary table and moves them into the row there, so the
process never holds more than the source plus one chunk. `copy_to_file`
reads a stored value back in 8 MB slices straight to a file. Both fall back
to the plain ORM read/write on other databases (SQLite in local runs).
"""
from __future__ import annotations

import binascii
import io
from typing import BinaryIO

from sqlalchemy import func
from sqlalchemy.orm import Session

CHUNK = 1 << 20
READ_SLICE = 8 << 20
_STAGE = "gd360_blob_stage"


class _CopyHexReader(io.RawIOBase):
    """A file the COPY reads: one row, one bytea field in hex, made a chunk
    at a time from the source."""

    def __init__(self, src: BinaryIO, chunk: int = CHUNK):
        self.src = src
        self.chunk = chunk
        self.parts = [b"\\\\x"]  # "\\x" - COPY's text format halves the backslash
        self.done = False

    def readable(self) -> bool:
        return True

    def read(self, size: int = -1) -> bytes:  # noqa: D401 - file protocol
        while not self.parts and not self.done:
            raw = self.src.read(self.chunk)
            if raw:
                self.parts.append(binascii.hexlify(raw))
            else:
                self.parts.append(b"\n")
                self.done = True
        if not self.parts:
            return b""
        return self.parts.pop(0)


def _is_postgres(db: Session) -> bool:
    try:
        return db.get_bind().dialect.name == "postgresql"
    except Exception:  # noqa: BLE001
        return False


def put_bytes(db: Session, model, column: str, row_id: str, data: bytes | bytearray | memoryview | BinaryIO) -> None:
    """Sets `model.column` of row `row_id` to `data` (bytes or a binary
    file), inside the session's transaction. The row must exist (flushed)."""
    db.flush()
    if not _is_postgres(db):
        raw = data.read() if hasattr(data, "read") else bytes(data)
        db.query(model).filter(model.id == row_id).update({getattr(model, column): raw}, synchronize_session=False)
        return
    src = data if hasattr(data, "read") else io.BytesIO(memoryview(data))
    raw_conn = db.connection().connection.dbapi_connection
    with raw_conn.cursor() as cur:
        cur.execute(f"CREATE TEMP TABLE IF NOT EXISTS {_STAGE} (d bytea)")
        cur.execute(f"DELETE FROM {_STAGE}")
        cur.copy_expert(f"COPY {_STAGE} (d) FROM STDIN", _CopyHexReader(src))
        cur.execute(f'UPDATE "{model.__table__.name}" SET "{column}" = (SELECT d FROM {_STAGE} LIMIT 1) WHERE id = %s', (row_id,))
        cur.execute(f"DELETE FROM {_STAGE}")
    # the ORM must not keep (or later write back) an old value for it
    try:
        obj = db.identity_map.get(Session.identity_key(model, row_id))
    except Exception:  # noqa: BLE001
        obj = None
    if obj is not None:
        db.expire(obj, [column])


def copy_to_file(db: Session, model, column: str, row_id: str, path: str) -> int:
    """Writes the stored value to `path`, a slice at a time. Returns bytes written."""
    col = getattr(model, column)
    if not _is_postgres(db):
        raw = db.query(col).filter(model.id == row_id).scalar() or b""
        with open(path, "wb") as f:
            f.write(raw)
        return len(raw)
    size = db.query(func.length(col)).filter(model.id == row_id).scalar() or 0
    written = 0
    with open(path, "wb") as f:
        while written < size:
            part = db.query(func.substring(col, written + 1, READ_SLICE)).filter(model.id == row_id).scalar() or b""
            if not part:
                break
            f.write(part)
            written += len(part)
            del part
    return written


def size_of(db: Session, model, column: str, row_id: str) -> int:
    return int(db.query(func.length(getattr(model, column))).filter(model.id == row_id).scalar() or 0)


__all__ = ["put_bytes", "copy_to_file", "size_of"]
