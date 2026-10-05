"""
Restricted execution environment for AI-generated pandas code.

Defense in depth, in order:
  1. Code runs in a *separate process* (multiprocessing), not the API
     process itself - a crash or runaway loop cannot take down the app.
  2. That process has CPU-time and memory resource limits (Linux `resource`
     module) so it cannot spin forever or exhaust the host.
  3. The exec() globals only expose a curated set of safe builtins plus
     pandas/numpy/scipy.stats - there is no `import`, `open`, `os`, `sys`,
     `subprocess`, `__import__`, `eval`, `exec`, or network access available
     to the generated code.
  4. A wall-clock timeout on the parent side terminates the process if it
     does not finish in time.

This is a *pragmatic* sandbox suitable for an MVP talking to a
well-behaved LLM, not a hardened multi-tenant code execution platform.
For production hardening, run this worker inside its own locked-down
container (gVisor/Firecracker/Docker with no network + read-only fs) - see
README "Security roadmap".
"""
from __future__ import annotations

import multiprocessing as mp
import time
import traceback
from typing import Any

import numpy as np
import pandas as pd
from scipy import stats

SAFE_BUILTINS = {
    "len": len, "range": range, "enumerate": enumerate, "sum": sum,
    "min": min, "max": max, "sorted": sorted, "list": list, "dict": dict,
    "set": set, "tuple": tuple, "str": str, "int": int, "float": float,
    "bool": bool, "abs": abs, "round": round, "zip": zip, "map": map,
    "filter": filter, "True": True, "False": False, "None": None,
    "isinstance": isinstance, "any": any, "all": all,
    # 2026-09-22 root-cause fix: added after a real production failure -
    # `next`/`iter` are ordinary, extremely common pandas/python idioms
    # (e.g. `next(iter(some_dict.values()))`, walking a groupby/itertuples
    # result) that generated code reaches for constantly, especially for
    # multi-table merge requests. They were missing from this list, so any
    # generated code that used them failed with a raw `NameError: name
    # 'next' is not defined` - a crash caused by an incomplete allowlist,
    # not by anything wrong with the code itself. The rest below this line
    # are the same kind of ordinary, pure-computation builtins (no file,
    # network, process, or interpreter access - nothing here can read,
    # write, import, or introspect anything outside the values already
    # passed in) added proactively for the same reason, so the next common,
    # safe idiom does not have to fail in production first to be noticed.
    "next": next, "iter": iter, "reversed": reversed, "divmod": divmod,
    "pow": pow, "frozenset": frozenset, "format": format, "repr": repr,
    "hash": hash, "complex": complex, "bin": bin, "hex": hex, "oct": oct,
    "chr": chr, "ord": ord, "slice": slice,
    # Exception TYPES only (not any I/O-capable builtin) - generated code
    # very commonly wraps a risky step in try/except as a defensive habit,
    # and without these names even in scope that raises NameError the
    # moment it is actually hit. Exposing the class objects themselves adds
    # no capability beyond catching/raising them - no new access to files,
    # network, or the interpreter is granted by this list.
    "Exception": Exception, "ValueError": ValueError, "TypeError": TypeError,
    "KeyError": KeyError, "IndexError": IndexError, "AttributeError": AttributeError,
    "ZeroDivisionError": ZeroDivisionError, "StopIteration": StopIteration,
    "RuntimeError": RuntimeError, "ArithmeticError": ArithmeticError,
    "NotImplementedError": NotImplementedError, "OverflowError": OverflowError,
}


def _read_container_memory_limit_bytes() -> int:
    """Best-effort read of this CONTAINER's real memory ceiling (the cgroup
    limit), not a number picked in isolation from it. cgroup v2 (modern
    Docker/Render) exposes this at /sys/fs/cgroup/memory.max; cgroup v1
    (older) at /sys/fs/cgroup/memory/memory.limit_in_bytes. Falls back to
    this app's currently-confirmed Render plan (0.5c-512mb, see config.py)
    if neither is readable - a different host, or the plan changes later -
    so this never silently computes a budget against the wrong ceiling."""
    _FALLBACK_BYTES = 512 * 1024 * 1024
    for path in ("/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"):
        try:
            with open(path) as f:
                raw = f.read().strip()
            if raw and raw != "max":
                value = int(raw)
                # cgroup v1 reports an absurd sentinel (effectively
                # "unset"), not a real limit, when no limit is configured -
                # treat that the same as "max" and keep looking/falling back.
                if 0 < value < (1 << 53):
                    return value
        except Exception:
            continue
    return _FALLBACK_BYTES


def _child_worker(code: str, tables: dict[str, pd.DataFrame], conn, timeout: int) -> None:
    try:
        try:
            import resource
            # 2026-09-28: investigated whether a flat 1GB figure was
            # dangerously loose given this Render instance's confirmed
            # 512MB TOTAL container RAM - measured directly rather than
            # guessing, by profiling a real worker process (pandas/numpy/
            # scipy imported, several tables loaded, a realistic 4-table
            # merge like the kind that actually timed out in production).
            # That measurement showed just importing pandas/numpy/scipy
            # already puts a fresh process's VIRTUAL memory size (VmSize -
            # exactly what RLIMIT_AS constrains) around 490MB before
            # touching any data at all, while real RSS for that same merge
            # stayed under 200MB - so a flat number anywhere near 512MB
            # would make ordinary, successful requests fail immediately.
            #
            # 2026-10-05 root-cause fix: that investigation only ever asked
            # "is 1GB too tight for THIS CHILD alone" - it never checked
            # the number against what else is sharing the SAME 512MB
            # container at the same time. `multiprocessing`'s default
            # start method on Linux is fork(): this child's address space
            # starts as a copy-on-write duplicate of the PARENT's entire
            # heap at the moment of fork - every table this chat request
            # already pulled (up to config.MAX_ROWS_LOADED_PER_QUERY rows),
            # FastAPI/SQLAlchemy's own baseline, anything else in flight -
            # and the parent keeps running and allocating concurrently
            # while this child computes. RLIMIT_AS=1GB only ever bounded
            # this child's OWN virtual address space in isolation, so a
            # child "given 1GB to itself" could let combined parent+child
            # RSS sail past the real 512MB cgroup ceiling long before its
            # own rlimit ever tripped - at which point it is the Linux
            # cgroup OOM-killer that responds, by killing a process in the
            # container. Confirmed directly against real incidents: Render's
            # own memory graph showed usage climbing past 400MB+ during a
            # single large BigQuery-backed chat request, immediately
            # followed by "Instance restarted" in the logs - the whole app
            # going down for every concurrent user, not a clean, isolated
            # failure of just this one request (which is exactly what this
            # sandbox exists to guarantee - see the module docstring).
            #
            # The fix: size this child's cap against what is ACTUALLY left
            # in the container's real ceiling, not a number chosen without
            # reference to it. Two different things are being measured
            # here and they must not be blended into one floor/ceiling
            # clamp (an earlier version of this fix did exactly that, and
            # a floor meant to protect bare imports ended up overriding
            # the safety math in precisely the dangerous case - parent
            # already near the limit - defeating the fix):
            #   1. A roughly CONSTANT ~450MB of VIRTUAL overhead
            #      (`_LIBRARY_VIRTUAL_OVERHEAD_BYTES`) just from importing
            #      pandas/numpy/scipy/BLAS, per the 2026-09-28 measurement
            #      - mostly address space that is reserved but never made
            #      resident, so it does not meaningfully compete with the
            #      parent for the container's real physical RAM. This part
            #      does not shrink even when the parent is under pressure.
            #   2. The REAL resident headroom actually left in the shared
            #      512MB container once the parent's own current RSS
            #      (already "spent" from that shared budget, since fork()
            #      just inherited it into this child) and a fixed
            #      concurrency reserve (the parent keeps running and
            #      allocating while this child computes) are subtracted.
            #      This part DOES shrink - all the way to zero - when the
            #      parent is already using most of the container, which is
            #      exactly the case that must fail fast and safely instead
            #      of racing the parent to the real ceiling.
            # Adding them (then capping at the old 1GB safe ceiling) gives
            # the child enough virtual room for its libraries while making
            # any computation beyond the real remaining headroom hit its
            # OWN RLIMIT_AS and raise a clean, catchable MemoryError - see
            # the module docstring's "defense in depth" list - rather than
            # letting the Linux cgroup OOM-killer kill a process in the
            # shared container (observed twice in real incidents: the
            # whole app going down for every concurrent user, not a clean,
            # isolated failure of just this one request).
            container_limit = _read_container_memory_limit_bytes()
            try:
                parent_rss_bytes = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024
            except Exception:
                parent_rss_bytes = 0
            _LIBRARY_VIRTUAL_OVERHEAD_BYTES = 450 * 1024 * 1024
            _PARENT_CONCURRENCY_RESERVE_BYTES = 100 * 1024 * 1024
            _MAX_CHILD_BYTES = 1024 * 1024 * 1024  # the 2026-09-28 safe ceiling, never exceeded
            real_headroom_bytes = max(0, container_limit - parent_rss_bytes - _PARENT_CONCURRENCY_RESERVE_BYTES)
            mem_bytes = min(_MAX_CHILD_BYTES, _LIBRARY_VIRTUAL_OVERHEAD_BYTES + real_headroom_bytes)
            resource.setrlimit(resource.RLIMIT_CPU, (timeout + 2, timeout + 5))
            resource.setrlimit(resource.RLIMIT_AS, (mem_bytes, mem_bytes))
        except Exception:
            pass  # resource module is POSIX-only; skip gracefully elsewhere

        # `df` is always the first/primary selected table, so single-table
        # code (still the overwhelming majority of requests) is completely
        # unaffected. `tables` additionally exposes every selected table by
        # name, for code that compares, merges, or joins more than one.
        primary = next(iter(tables.values()))
        scope = {
            "__builtins__": SAFE_BUILTINS,
            "pd": pd,
            "np": np,
            "stats": stats,
            "tables": tables,
            "df": primary,
            "result": None,
        }
        exec(code, scope)  # noqa: S102 - intentional, restricted scope above
        conn.send(("ok", scope.get("result")))
    except Exception:
        conn.send(("error", traceback.format_exc(limit=3)))
    finally:
        conn.close()


def run_sandboxed(code: str, tables: dict[str, pd.DataFrame], timeout: int = 20) -> tuple[Any, str | None]:
    """Runs `code` against one or more named tables in an isolated process.
    Returns (result, error)."""
    # 2026-09-23: real production logs showed "Analysis code timed out"
    # firing for ordinary requests against tables of only tens of
    # thousands of rows - operations that should be well under a second
    # for genuinely vectorized pandas. This app's Render instance is a
    # shared 0.5 CPU / 512MB box (confirmed via the Render API), so a slow
    # per-row Python loop in generated code and real CPU contention under
    # this container's own small share of a core can both plausibly turn
    # "should take milliseconds" into "took over 20 real seconds" - but
    # without ever timing a run, there was no data to tell those apart, or
    # to know whether the fix in SYSTEM_PROMPT above (vectorized-only
    # pandas, safe merge keys) is actually helping in practice. Logging the
    # real elapsed wall-clock time on every call - success AND timeout -
    # turns "it's slow sometimes" into an actual measurable trend the next
    # investigation can look at, instead of starting from zero again.
    start = time.monotonic()
    parent_conn, child_conn = mp.Pipe()
    process = mp.Process(target=_child_worker, args=(code, tables, child_conn, timeout), daemon=True)
    process.start()

    # 2026-09-29 (parallel-pieces round): root-caused during Phase 3 testing
    # - reproduced reliably (not a rare flake) whenever the selected
    # table(s) had 3+ columns. The child genuinely finished fast and really
    # did send its real result down the pipe (confirmed directly: the pipe
    # had a correct, complete payload waiting), but the CHILD PROCESS ITSELF
    # did not exit promptly afterward - almost certainly a native
    # BLAS/OpenMP worker thread pulled in by a wider dataframe's pandas
    # operation, which does not survive fork() in a working state and can
    # leave the forked child unable to shut down cleanly, even though its
    # actual Python code (and the answer it computed) already finished.
    # The previous version of this function waited on `process.join(timeout)`
    # - which waits for the CHILD PROCESS TO EXIT - before ever looking at
    # the pipe, so it declared a timeout and threw away an already-correct,
    # already-computed answer every single time this happened. Waiting on
    # the PIPE itself (parent_conn.poll(timeout)) is the actual correctness
    # fix: that is the real communication channel for "is an answer ready,"
    # and it does not require the child process to have exited, only to
    # have finished computing and called conn.send() - which is what
    # genuinely marks the work as done. This was not something the
    # dict-in-`code`/single-result paths had ever been caught by before
    # (every dataframe this app runs against already has 3+ columns in
    # practice, so this was very likely already silently costing a full
    # timeout on some real production requests before failing) - Phase 3's
    # parallel pieces just made it reproducible in testing by running more
    # sandboxed calls back to back. Fixed here at the shared root, not
    # worked around per-caller, so every caller of run_sandboxed benefits,
    # not only the new parallel-pieces path.
    if parent_conn.poll(timeout):
        status, payload = parent_conn.recv()
        elapsed = time.monotonic() - start
        # The answer is already in hand from the pipe above - this is just
        # best-effort cleanup of the child process, not part of deciding
        # whether the call succeeded. A short grace period covers the
        # ordinary case (the process exits right after conn.close()); if it
        # is still lingering after that (the native-thread situation this
        # fix exists for), terminate it rather than waiting on it further.
        if process.is_alive():
            process.join(0.5)
            if process.is_alive():
                process.terminate()
                process.join(2)
        if status == "ok":
            if elapsed > 3:
                # Finished, but slower than any normal vectorized pandas
                # operation on this app's tables should be - worth a log
                # line even on success, since a "successful but very slow"
                # run is exactly the kind of case that times out for the
                # next, slightly bigger request.
                print(f"[sandbox] slow but completed: {elapsed:.1f}s")
            return payload, None
        return None, payload

    # Nothing arrived on the pipe within the timeout budget - now it is a
    # genuine timeout (the code itself did not finish in time), not just
    # the child process being slow to exit after finishing.
    elapsed = time.monotonic() - start
    if process.is_alive():
        process.terminate()
        process.join(2)
    print(f"[sandbox] timed out after {elapsed:.1f}s (limit {timeout}s)")
    return None, f"Analysis code timed out after {timeout}s. Try a simpler request."
