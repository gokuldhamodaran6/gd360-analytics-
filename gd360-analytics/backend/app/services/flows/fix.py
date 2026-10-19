"""When a run is held or stops: say what went wrong in plain words and,
where the data shows a clear answer, propose a one-step repair for a
person to approve. A repair never changes the output's column names -
it reads the new source column under the old name, so dashboards and
docs built on the output keep working."""
from __future__ import annotations

import copy
import difflib
import uuid
from datetime import datetime

from .spec import label_of

MIN_FILL = 0.5


def _similar(a: str, b: str) -> float:
    a2, b2 = a.lower(), b.lower()
    r = difflib.SequenceMatcher(None, a2, b2).ratio()
    wa = {w for w in a2.replace("_", " ").split() if len(w) > 2}
    wb = {w for w in b2.replace("_", " ").split() if len(w) > 2}
    if wa & wb:
        r += 0.3
    return r


def _best_replacement(missing: str, now_fills: dict, old_fills: dict | None) -> str | None:
    best, score = None, 0.0
    for col, fill in (now_fills or {}).items():
        if col == missing or fill < MIN_FILL:
            continue
        is_new = old_fills is not None and col not in old_fills
        s = _similar(missing, col) + (0.6 if is_new else 0.0)
        if s > score:
            best, score = col, s
    return best if score >= 0.75 else None


def propose(spec: dict, *, run_id: str, alias: str | None, column: str | None, cause: str,
            now_fills: dict | None, last_good: dict | None) -> dict | None:
    """A pending fix, or None when the data gives no clear answer."""
    if not alias or not column or alias == "main":
        return None
    src_fills = (now_fills or {}).get(alias) or {}
    old = (last_good or {}).get(alias)
    new_col = _best_replacement(column, src_fills, old)
    if not new_col:
        return None
    # the name the rest of the flow uses for this column
    used = column
    for st in spec.get("steps") or []:
        if st.get("kind") == "rename" and st.get("source") == alias:
            for raw, u in st["columns"].items():
                if raw == column:
                    used = u
    label = label_of(spec, alias)
    return {
        "id": uuid.uuid4().hex[:10], "run_id": run_id, "alias": alias, "cause": cause,
        "summary": f"Read “{new_col}” instead of “{column}” from {label}. Everything after this step keeps using the name “{used}”, so dashboards and docs built on this flow keep working.",
        "changes": [{"alias": alias, "from": column, "to": new_col, "as": used}],
        "diff": [["-", f"{used} ← {label} column “{column}”"], ["+", f"{used} ← {label} column “{new_col}”"]],
        "evidence": f"“{new_col}” is {round(src_fills.get(new_col, 0) * 100)}% filled"
                    + ("; it is new since the last good run." if old is not None and new_col not in old else "."),
        "created_at": datetime.utcnow().replace(microsecond=0).isoformat() + "Z",
    }


def apply(spec: dict, fix: dict) -> dict:
    """The spec with the fix applied: a source-level rename step that reads
    the new raw column under the name the flow already uses."""
    s = copy.deepcopy(spec)
    for ch in fix.get("changes") or []:
        alias, raw_old, raw_new, used = ch["alias"], ch["from"], ch["to"], ch.get("as") or ch["from"]
        step = next((st for st in s["steps"] if st.get("kind") == "rename" and st.get("source") == alias), None)
        if step is None:
            step = {"id": f"read_{alias}"[:40], "kind": "rename", "source": alias, "columns": {}, "enabled": True}
            s["steps"].insert(0, step)
        cols = {a: b for a, b in step["columns"].items() if b != used and a != raw_old}
        cols[raw_new] = used
        step["columns"] = cols
    return s
