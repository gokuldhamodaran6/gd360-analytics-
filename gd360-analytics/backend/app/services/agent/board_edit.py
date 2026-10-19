"""
2026-10-19 (R56, Studio board "Dashboard, edit in place"): direct edits to a designed dashboard from its canvas -
make a block wider or narrower, move it, remove it, add a chart of a column, add a note, add a filter - plus
publish (a new dashboard is a draft only its owner sees until published), Undo and Versions.

Every change snapshots the spec first (the same `_history` list "undo" in the conversation already uses, so both
undo each other's changes) and stamps the blocks it touched in `_changed`, which the canvas outlines as
"Changed just now".
"""
from __future__ import annotations

import copy
import re
import time
from datetime import datetime, timedelta

from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from ... import models
from . import analysis, board

SPANS = [3, 4, 6, 8, 12]
MAX_HISTORY = 20


class EditError(ValueError):
    pass


def _now() -> str:
    return datetime.utcnow().isoformat() + "Z"


def _snapshot(spec: dict, label: str) -> list:
    snap = copy.deepcopy({k: v for k, v in spec.items() if k not in ("model", "_history", "_changed")})
    snap["_label"] = label
    snap["_at"] = _now()
    return (list(spec.get("_history") or []) + [snap])[-MAX_HISTORY:]


def _save(db: Session, dash: models.Dashboard, spec: dict, label: str, changed: list[str]) -> dict:
    spec["_history"] = _snapshot(dash.board_spec or {}, label)
    stamp = dict(spec.get("_changed") or {})
    for bid in changed:
        stamp[bid] = _now()
    # keep only the last few minutes of stamps
    cut = datetime.utcnow() - timedelta(minutes=30)
    spec["_changed"] = {k: v for k, v in stamp.items() if _parse(v) and _parse(v) > cut}
    spec["_edited_at"] = _now()
    dash.board_spec = spec
    flag_modified(dash, "board_spec")
    db.commit()
    return {"change": label, "changed": changed}


def _parse(v: str | None) -> datetime | None:
    try:
        return datetime.fromisoformat(str(v).rstrip("Z"))
    except (TypeError, ValueError):
        return None


def _find(spec: dict, block_id: str) -> tuple[dict, dict, int]:
    for p in spec.get("pages") or []:
        for i, b in enumerate(p.get("blocks") or []):
            if b.get("id") == block_id:
                return p, b, i
    raise EditError("That block is not on this dashboard any more.")


def _label(b: dict) -> str:
    """A block's name in plain words, for "made X wider" and the Versions list."""
    if b.get("title"):
        return b["title"]
    col = analysis.label_of(b.get("column") or "") if b.get("column") else ""
    meas = analysis.label_of(b.get("measure") or "") if b.get("measure") else ""
    kind = b.get("kind") or ""
    names = {"o_rate": "the rate tile", "o_count": "the count tile", "g_count": "the count tile", "o_risk": "the risk tile",
             "o_sig": "the signals chart", "o_tiers": "the risk tiers", "o_list": "the high-risk list", "o_importance": "what matters most",
             "note": "the note"}
    if kind in names:
        return names[kind]
    if kind == "g_measure" and col:
        return f"the {col} tile"
    if kind in ("o_dim", "o_band") and col:
        return f"by {col}"
    if kind == "g_dim" and col:
        return f"{meas} by {col}" if meas else f"by {col}"
    if kind == "g_trend" and col:
        return f"{col} over time"
    if kind == "g_table" and col:
        return f"the table by {col}"
    return col or kind.replace("o_", "").replace("g_", "") or "the block"


def layout(db: Session, dash: models.Dashboard, block_id: str, action: str) -> dict:
    spec = copy.deepcopy(dash.board_spec or {})
    page, b, i = _find(spec, block_id)
    blocks = page["blocks"]
    name = _label(b)
    if action in ("wider", "narrower"):
        cur = int(b.get("span", 6))
        bigger = [s for s in SPANS if s > cur]
        smaller = [s for s in SPANS if s < cur]
        new = (bigger[0] if bigger else None) if action == "wider" else (smaller[-1] if smaller else None)
        if new is None:
            raise EditError(f"“{name}” is already as {'wide' if action == 'wider' else 'narrow'} as it goes.")
        b["span"] = new
        label = f"made “{name}” {'wider' if action == 'wider' else 'narrower'}"
    elif action in ("left", "right"):
        j = i - 1 if action == "left" else i + 1
        if j < 0 or j >= len(blocks):
            raise EditError(f"“{name}” is already {'first' if action == 'left' else 'last'} on this page.")
        blocks[i], blocks[j] = blocks[j], blocks[i]
        label = f"moved “{name}” {'earlier' if action == 'left' else 'later'}"
    elif action == "remove":
        if len(blocks) <= 1:
            raise EditError("A page needs at least one block. Remove the page in the conversation instead.")
        blocks.pop(i)
        label = f"removed “{name}”"
        return _save(db, dash, spec, label, [])
    else:
        raise EditError("Unknown layout change.")
    return _save(db, dash, spec, label, [block_id])


def rename_block(db: Session, dash: models.Dashboard, block_id: str, title: str) -> dict:
    spec = copy.deepcopy(dash.board_spec or {})
    _page, b, _i = _find(spec, block_id)
    old = _label(b)
    t = (title or "").strip()[:80]
    if not t:
        raise EditError("Give the block a title.")
    b["title"] = t
    return _save(db, dash, spec, f"renamed “{old}” to “{t}”", [block_id])


def columns(db: Session, user: models.User, dash: models.Dashboard) -> dict:
    spec = dash.board_spec or {}
    src = spec.get("source") or {}
    df, _ = board.frame(db, user, src["source_id"], src.get("table"))
    prof = board.profile(df)
    dims = [{"column": c, "label": analysis.label_of(c)} for c in prof["dims"]]
    measures = [{"column": c, "label": analysis.label_of(c)} for c in prof["measures"]]
    used = {f.get("column") for f in spec.get("filters") or []}
    return {"dims": dims, "measures": measures, "outcome": bool(spec.get("outcome")), "date": prof.get("date"),
            "filterable": [d for d in dims if d["column"] not in used]}


def add_chart(db: Session, user: models.User, dash: models.Dashboard, page_id: str | None, column: str, measure: str | None = None) -> dict:
    spec = copy.deepcopy(dash.board_spec or {})
    src = spec.get("source") or {}
    df, _ = board.frame(db, user, src["source_id"], src.get("table"))
    if column not in df.columns:
        raise EditError(f"There is no column “{column}” in {src.get('table') or 'this table'}.")
    if measure and measure not in df.columns:
        raise EditError(f"There is no column “{measure}” in {src.get('table') or 'this table'}.")
    page = next((p for p in spec.get("pages") or [] if p["id"] == page_id and p.get("kind") != "home"), None) \
        or next((p for p in spec.get("pages") or [] if p.get("kind") != "home"), None)
    if page is None:
        raise EditError("This dashboard has no page to add a chart to.")
    bid = f"add{int(time.time() * 1000) % 10_000_000}"
    kind = "o_dim" if spec.get("outcome") else "g_dim"
    blk = {"id": bid, "kind": kind, "span": 6, "column": column}
    if not spec.get("outcome"):
        blk["measure"] = measure or next((b.get("column") for p in spec.get("pages") or [] for b in p.get("blocks") or []
                                          if b.get("kind") == "g_measure" and b.get("column")), None)
    page.setdefault("blocks", []).insert(0, blk)
    what = f"{analysis.label_of(blk['measure'])} by {analysis.label_of(column)}" if blk.get("measure") else analysis.label_of(column)
    out = _save(db, dash, spec, f"added {what} to {page['name']}", [bid])
    return out | {"page_id": page["id"], "block_id": bid}


def add_note(db: Session, dash: models.Dashboard, page_id: str | None, text: str, title: str | None = None) -> dict:
    t = re.sub(r"\s+", " ", (text or "")).strip()[:600]
    if len(t) < 2:
        raise EditError("Write the note first.")
    spec = copy.deepcopy(dash.board_spec or {})
    page = next((p for p in spec.get("pages") or [] if p["id"] == page_id and p.get("kind") != "home"), None) \
        or next((p for p in spec.get("pages") or [] if p.get("kind") != "home"), None)
    if page is None:
        raise EditError("This dashboard has no page to add a note to.")
    bid = f"note{int(time.time() * 1000) % 10_000_000}"
    page.setdefault("blocks", []).append({"id": bid, "kind": "note", "span": 12, "text": t, "title": (title or "Note").strip()[:80]})
    out = _save(db, dash, spec, f"added a note to {page['name']}", [bid])
    return out | {"page_id": page["id"], "block_id": bid}


def edit_note(db: Session, dash: models.Dashboard, block_id: str, text: str) -> dict:
    spec = copy.deepcopy(dash.board_spec or {})
    _p, b, _i = _find(spec, block_id)
    if b.get("kind") != "note":
        raise EditError("Only a note's text can be typed over.")
    t = re.sub(r"\s+", " ", (text or "")).strip()[:600]
    if len(t) < 2:
        raise EditError("Write the note first.")
    b["text"] = t
    return _save(db, dash, spec, "edited a note", [block_id])


def add_filter(db: Session, user: models.User, dash: models.Dashboard, column: str) -> dict:
    spec = copy.deepcopy(dash.board_spec or {})
    src = spec.get("source") or {}
    df, _ = board.frame(db, user, src["source_id"], src.get("table"))
    if column not in df.columns:
        raise EditError(f"There is no column “{column}” to filter by.")
    if any(f.get("column") == column for f in spec.get("filters") or []):
        raise EditError(f"There is already a {analysis.label_of(column)} filter.")
    vals = [str(v) for v in df[column].dropna().astype(str).value_counts().index[:30]]
    if len(vals) < 2:
        raise EditError(f"{analysis.label_of(column)} has only one value, so it can't filter anything.")
    label = analysis.label_of(column)
    flt = {"key": column, "label": label[:1].upper() + label[1:], "column": column, "values": sorted(vals, key=board._natural)}
    fl = list(spec.get("filters") or [])
    # keep the risk tier and period filters last
    pos = next((i for i, f in enumerate(fl) if str(f.get("key", "")).startswith("__")), len(fl))
    fl.insert(pos, flt)
    spec["filters"] = fl
    return _save(db, dash, spec, f"added a {label} filter", [])


def remove_filter(db: Session, dash: models.Dashboard, key: str) -> dict:
    spec = copy.deepcopy(dash.board_spec or {})
    fl = [f for f in spec.get("filters") or [] if f.get("key") != key]
    if len(fl) == len(spec.get("filters") or []):
        raise EditError("That filter is not on this dashboard.")
    spec["filters"] = fl
    spec["default_filters"] = {k: v for k, v in (spec.get("default_filters") or {}).items() if k != key}
    return _save(db, dash, spec, f"removed the {key.lstrip('_')} filter", [])


def undo(db: Session, dash: models.Dashboard) -> dict:
    spec = dash.board_spec or {}
    history = list(spec.get("_history") or [])
    if not history:
        raise EditError("There is nothing to undo on this dashboard yet.")
    prev = history.pop()
    restored = {k: v for k, v in prev.items() if k not in ("_label", "_at")}
    restored["model"] = spec.get("model")
    restored["_history"] = history
    restored["_changed"] = {}
    for k in ("draft", "published_at", "published_by"):
        if k in spec:
            restored[k] = spec[k]
    dash.board_spec = restored
    dash.name = (restored.get("title") or dash.name)[:80]
    flag_modified(dash, "board_spec")
    db.commit()
    return {"change": f"undid “{prev.get('_label') or 'the last change'}”", "changed": []}


def versions(dash: models.Dashboard) -> list[dict]:
    spec = dash.board_spec or {}
    hist = list(spec.get("_history") or [])
    out = [{"index": len(hist), "label": "Current version", "at": spec.get("_edited_at") or spec.get("built_at"), "current": True}]
    for i in range(len(hist) - 1, -1, -1):
        h = hist[i]
        # the snapshot at i is the dashboard BEFORE change i was made
        out.append({"index": i, "label": f"Before: {h.get('_label') or 'a change'}", "at": h.get("_at"), "current": False})
    return out


def restore(db: Session, dash: models.Dashboard, index: int) -> dict:
    spec = dash.board_spec or {}
    hist = list(spec.get("_history") or [])
    if index < 0 or index >= len(hist):
        raise EditError("That version is not kept any more.")
    target = hist[index]
    new = {k: v for k, v in target.items() if k not in ("_label", "_at")}
    new["model"] = spec.get("model")
    for k in ("draft", "published_at", "published_by"):
        if k in spec:
            new[k] = spec[k]
    label = f"restored the version before “{target.get('_label') or 'a change'}”"
    new["_history"] = _snapshot(spec, label)
    new["_changed"] = {}
    new["_edited_at"] = _now()
    dash.board_spec = new
    dash.name = (new.get("title") or dash.name)[:80]
    flag_modified(dash, "board_spec")
    db.commit()
    return {"change": label, "changed": []}


def publish(db: Session, dash: models.Dashboard, user: models.User, on: bool = True) -> dict:
    spec = copy.deepcopy(dash.board_spec or {})
    if on:
        if not dash.workspace_id:
            raise EditError("This dashboard is in your personal space. Move its data to a team workspace to publish it to people.")
        spec["draft"] = False
        spec["published_at"] = _now()
        spec["published_by"] = user.id
    else:
        spec["draft"] = True
        spec.pop("published_at", None)
    dash.board_spec = spec
    flag_modified(dash, "board_spec")
    db.commit()
    return {"change": "published to the workspace" if on else "back to a draft only you see", "changed": []}


def access(db: Session, dash: models.Dashboard) -> dict:
    """Who can open it: the owner while it is a draft; every workspace member once it is published."""
    spec = dash.board_spec or {}
    draft = bool(spec.get("draft"))
    members = 0
    if dash.workspace_id:
        try:
            members = db.query(models.WorkspaceMember).filter(models.WorkspaceMember.workspace_id == dash.workspace_id).count()
        except Exception:  # noqa: BLE001 - a count never breaks the page
            members = 0
    return {"draft": draft, "published_at": spec.get("published_at"), "people": 1 if draft or not dash.workspace_id else max(members, 1),
            "workspace": bool(dash.workspace_id)}


def changed_recently(dash: models.Dashboard, minutes: int = 10) -> dict:
    cut = datetime.utcnow() - timedelta(minutes=minutes)
    return {k: v for k, v in ((dash.board_spec or {}).get("_changed") or {}).items() if (_parse(v) or datetime.min) > cut}
