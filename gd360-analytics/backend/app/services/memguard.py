"""2026-10-24 (R60): keep the server inside its memory.

The backend runs in a 512 MB container. Importing pandas, BigQuery, Snowflake and scikit-learn already uses about
330 MB, so a dashboard that read 150,000 rows of a wide table (three copies on the way: the warehouse rows, DuckDB,
the frame) went past the limit and Render killed the server - the dashboard never arrived and any other answer
running at that moment died with it (OOM kills 2026-10-24 05:32 and 05:34, and every night at 02:10).

This module says how much memory is in use and how much is left, sizes how many rows a frame may hold, and gives
memory back after a big job (Python frees a frame, but glibc keeps the pages until malloc_trim asks for them).
"""
from __future__ import annotations

import ctypes
import gc
import os

_FALLBACK_LIMIT_MB = 512.0
_SAFETY_MB = 110.0          # room left for the request threads, the JSON of the answer and DuckDB's own buffers
_BYTES_PER_CELL = 70.0      # a pandas cell of mixed text and numbers, with its index share
_COPIES = 3.0               # warehouse rows -> DuckDB -> the frame, alive together at the peak


def rss_mb() -> float:
    """This process's resident memory, in MB (0 when it can't be read)."""
    try:
        with open("/proc/self/status") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1]) / 1024.0
    except OSError:
        pass
    return 0.0


def limit_mb() -> float:
    """The container's memory limit (cgroup v2, then v1), else MEMORY_LIMIT_MB, else 512."""
    for path in ("/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"):
        try:
            raw = open(path).read().strip()
            if raw and raw != "max":
                v = int(raw) / (1024 * 1024)
                if 64 < v < 1024 * 1024:   # an unset v1 limit reads as a huge number
                    return v
        except (OSError, ValueError):
            continue
    try:
        return float(os.environ.get("MEMORY_LIMIT_MB") or _FALLBACK_LIMIT_MB)
    except ValueError:
        return _FALLBACK_LIMIT_MB


def headroom_mb() -> float:
    used = rss_mb()
    return max(0.0, limit_mb() - used - _SAFETY_MB) if used else limit_mb() / 2


def row_budget(n_columns: int, *, floor: int = 15_000, ceiling: int = 150_000) -> int:
    """How many rows of an `n_columns`-wide table fit in the memory that is left right now."""
    relieve(light=True)
    cols = max(1, int(n_columns or 1))
    fit = int(headroom_mb() * 1024 * 1024 / (cols * _BYTES_PER_CELL * _COPIES))
    return max(floor, min(ceiling, fit))


def relieve(light: bool = False) -> None:
    """Give memory back: drop the frames cached by the dashboard engine (unless light), collect, and trim."""
    if not light:
        try:
            from .agent import board
            board.forget_all()
        except Exception:  # noqa: BLE001 - never let tidying up fail a request
            pass
    gc.collect()
    try:
        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except Exception:  # noqa: BLE001 - not glibc (a Mac in development)
        pass
