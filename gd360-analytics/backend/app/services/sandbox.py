"""
Restricted execution environment for AI-generated pandas code.

Defense in depth, in order:
  1. Code runs in a *separate process* (multiprocessing), not the API
     server's own process - a crash or runaway loop can't take down the app.
  2. That process has CPU-time and memory resource limits (Linux `resource`
     module) so it can't spin forever or exhaust the host.
  3. The exec() globals only expose a curated set of safe builtins plus
     pandas/numpy/scipy.stats - there is no `import`, `open`, `os`, `sys`,
     `subprocess`, `__import__`, `eval`, `exec`, or network access available
     to the generated code.
  4. A wall-clock timeout on the parent side terminates the process if it
     doesn't finish in time.

This is a *pragmatic* sandbox suitable for an MVP talking to a
well-behaved LLM, not a hardened multi-tenant code execution platform.
For production hardening, run this worker inside its own locked-down
container (gVisor/Firecracker/Docker with no network + read-only fs) - see
README "Security roadmap".
"""
from __future__ import annotations

import multiprocessing as mp
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
}


def _child_worker(code: str, df: pd.DataFrame, conn, timeout: int) -> None:
    try:
        try:
            import resource
            mem_bytes = 1024 * 1024 * 1024  # 1GB
            resource.setrlimit(resource.RLIMIT_CPU, (timeout + 2, timeout + 5))
            resource.setrlimit(resource.RLIMIT_AS, (mem_bytes, mem_bytes))
        except Exception:
            pass  # resource module is POSIX-only; skip gracefully elsewhere

        scope = {
            "__builtins__": SAFE_BUILTINS,
            "pd": pd,
            "np": np,
            "stats": stats,
            "df": df,
            "result": None,
        }
        exec(code, scope)  # noqa: S102 - intentional, restricted scope above
        conn.send(("ok", scope.get("result")))
    except Exception:
        conn.send(("error", traceback.format_exc(limit=3)))
    finally:
        conn.close()


def run_sandboxed(code: str, df: pd.DataFrame, timeout: int = 20) -> tuple[Any, str | None]:
    """Runs `code` against `df` in an isolated process. Returns (result, error)."""
    parent_conn, child_conn = mp.Pipe()
    process = mp.Process(target=_child_worker, args=(code, df, child_conn, timeout), daemon=True)
    process.start()
    process.join(timeout)

    if process.is_alive():
        process.terminate()
        process.join(2)
        return None, f"Analysis code timed out after {timeout}s. Try a simpler request."

    if parent_conn.poll():
        status, payload = parent_conn.recv()
        if status == "ok":
            return payload, None
        return None, payload

    return None, "Sandbox process exited unexpectedly with no result."
