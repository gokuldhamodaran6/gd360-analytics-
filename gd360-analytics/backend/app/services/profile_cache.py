"""
Tiny in-process TTL cache for the Data tab's full-table profile results
(see routers/datasources.py `profile_datasource` and services/profiling.py).

2026-10-06 (warehouse-honesty round): this used to live inline in
routers/datasources.py as `_profile_cache` / `_profile_cache_get` /
`_profile_cache_put`. It moved here, byte-for-byte in behaviour, because
routers/chat.py now also needs to READ it - a chat answer computed
inside the warehouse wants to cite the real total row count of the table
it ran over (`exact_total_rows`), and the only honest, non-billable place
to get that number is this cache: the Data tab's profile already ran the
COUNT(*) and paid for it. Chat must never run a fresh COUNT(*) of its own
just to decorate an insight. Two routers importing each other's private
helpers is a circular-import hazard, so both now import this one small
service module instead. routers/datasources.py keeps using these under
their original names (it imports them from here) so nothing in that
file's own logic changed.

Same spirit as data_loader.py's _df_cache but far smaller - a profile
result is a handful of numbers per column, never a DataFrame, so there is
no memory-footprint concern here. The TTL exists purely so repeatedly
opening/closing the Data tab on the same table does not re-run a real
warehouse query (billable, for BigQuery) every single time.
"""
from __future__ import annotations

import time

from ..config import get_settings

settings = get_settings()

_profile_cache: dict[tuple, tuple[float, dict]] = {}


def profile_cache_get(key: tuple) -> dict | None:
    entry = _profile_cache.get(key)
    if entry is None:
        return None
    stored_at, value = entry
    if time.time() - stored_at > settings.PROFILE_CACHE_TTL_SECONDS:
        _profile_cache.pop(key, None)
        return None
    return value


def profile_cache_put(key: tuple, value: dict) -> None:
    # Cheap unbounded-growth guard: this cache is keyed by (datasource_id,
    # table), which only grows with how many distinct tables get profiled
    # - evict the oldest entries past a generous cap rather than letting a
    # long-running process accumulate one entry per table forever.
    if len(_profile_cache) > 500:
        oldest_key = min(_profile_cache, key=lambda k: _profile_cache[k][0])
        _profile_cache.pop(oldest_key, None)
    _profile_cache[key] = (time.time(), value)


def cached_exact_total_rows(datasource_id: str, table: str) -> int | None:
    """The real, already-paid-for COUNT(*) of one warehouse table, if the
    Data tab's profile ran for it recently enough to still be cached -
    otherwise None. Never triggers a query. Used by routers/chat.py to
    cite n for an answer computed inside the warehouse."""
    cached = profile_cache_get((datasource_id, table))
    if not isinstance(cached, dict):
        return None
    value = cached.get("exact_total_rows")
    return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None
