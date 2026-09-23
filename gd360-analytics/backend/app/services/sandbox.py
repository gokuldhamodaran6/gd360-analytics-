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


def _child_worker(code: str, tables: dict[str, pd.DataFrame], conn, timeout: int) -> None:
    try:
        try:
            import resource
            mem_bytes = 1024 * 1024 * 1024  # 1GB
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
    process.join(timeout)
    elapsed = time.monotonic() - start

    if process.is_alive():
        process.terminate()
        process.join(2)
        print(f"[sandbox] timed out after {elapsed:.1f}s (limit {timeout}s)")
        return None, f"Analysis code timed out after {timeout}s. Try a simpler request."

    if parent_conn.poll():
        status, payload = parent_conn.recv()
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

    return None, "Sandbox process exited unexpectedly with no result."
