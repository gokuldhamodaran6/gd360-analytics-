"""2026-10-14 (R47): editing the dashboard on the canvas by talking.

"make it dark", "use the ocean palette", "switch to Inter", "rename it to Retention Q3",
"add a chart of revenue by city", "remove the cancellation chart". Each sentence
becomes one real change through the dashboard builder's own endpoints (appearance,
branding, name, blocks), so what the chat does is exactly what the editor does.
"""
from __future__ import annotations

import re

from fastapi import HTTPException
from sqlalchemy.orm import Session

from ... import models, schemas

EDIT = re.compile(
    r"\b(make|turn|switch|set|change)\b.{0,30}\b(dark|light|darker|lighter|night|auto theme)\b"
    r"|\b(dark|light) (mode|theme)\b"
    r"|\b(use|apply|switch to|change to|set)\b.{0,30}\b(palette|colou?rs?|brand|font|inter|geist|plex|source sans|compact|comfortable|rounded|sharp|soft)\b"
    r"|\b(rename|call|name) (it|this|the dashboard|dashboard)\b"
    r"|\b(add|put|include)\b.{0,40}\b(chart|graph|kpi|table|block|tile|number)\b"
    r"|\b(remove|delete|drop|hide)\b.{0,40}\b(chart|graph|kpi|table|block|tile)\b"
    r"|\b(remove|delete|drop|hide) the (\w+ ){1,4}(chart|graph|kpi|table|block|tile)\b", re.I)

PALETTES = {"gd360": "gd360", "ocean": "ocean", "sunset": "sunset", "forest": "forest", "berry": "berry", "slate": "slate",
            "vivid": "vivid", "colou?r.?blind|cb.?safe|accessible": "cbsafe"}
FONTS = {"inter": "inter", "geist": "geist", "plex": "ibm-plex-sans", "source sans": "source-sans-3"}


def wants_edit(text: str) -> bool:
    return bool(EDIT.search(text or ""))


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9 ]+", " ", (s or "").lower()).strip()


def apply(db: Session, user: models.User, dash: models.Dashboard, text: str, conv: models.Conversation) -> dict:
    """Applies one or more edits; returns {changes: [str], page_id, blocks_added: [ids], reload: bool}."""
    from ...routers import dashboard_builder as dbr
    t = (text or "").strip()
    tl = t.lower()
    changes: list[str] = []
    added: list[str] = []
    appearance: dict = {}
    branding: dict = {}

    if re.search(r"\b(dark|darker|night)\b", tl) and not re.search(r"\blight(er)?\b", tl):
        appearance["theme_default"] = "dark"
    elif re.search(r"\blight(er)?\b", tl) and not re.search(r"\bdark(er)?\b", tl):
        appearance["theme_default"] = "light"
    elif re.search(r"\bauto theme\b|\bfollow (the )?(system|viewer)\b", tl):
        appearance["theme_default"] = "auto"
    for pat, pid in PALETTES.items():
        if re.search(rf"\b({pat})\b", tl) and re.search(r"palette|colou?rs?|theme|look", tl):
            appearance["palette"] = {"kind": "preset", "id": pid}
            break
    if re.search(r"\b(our|the|my) brand (colou?rs?|palette)\b|\bbrand palette\b", tl):
        appearance["palette"] = {"kind": "brand"}
    for word, fid in FONTS.items():
        if re.search(rf"\b{word}\b", tl):
            appearance["font"] = fid
            break
    if re.search(r"\bcompact\b", tl):
        appearance["density"] = "compact"
    elif re.search(r"\bcomfortable|roomier|more space\b", tl):
        appearance["density"] = "comfortable"
    if re.search(r"\b(sharp|square) (corners|edges)\b", tl):
        appearance["radius"] = "sharp"
    elif re.search(r"\b(round|rounded) (corners|edges)\b", tl):
        appearance["radius"] = "round"
    m = re.search(r"\b(?:brand|primary|accent) colou?r\b.{0,20}?(#[0-9a-f]{6})", tl)
    if m:
        branding["brand_primary_color"] = m.group(1)
    m = re.search(r"\b(?:single|one) colou?r\b", tl)
    if m:
        appearance["color_mode"] = "single"
    if re.search(r"\bby value\b|\bcolou?r by value\b", tl):
        appearance["color_mode"] = "by_value"

    if appearance:
        dbr.update_appearance(dash.id, schemas.UpdateAppearanceRequest(**appearance), db=db, user=user)
        words = {"theme_default": lambda v: f"theme set to {v}", "palette": lambda v: f"{(v.get('id') or v.get('kind')) if isinstance(v, dict) else v} palette", "font": lambda v: f"font {v}",
                 "density": lambda v: f"{v} density", "radius": lambda v: f"{v} corners", "color_mode": lambda v: "colour " + v.replace("_", " ")}
        changes += [words[k](v) for k, v in appearance.items()]
    if branding:
        dbr.update_branding(dash.id, schemas.UpdateBrandingRequest(**branding), db=db, user=user)
        changes.append(f"brand colour {branding['brand_primary_color']}")

    m = re.search(r"\b(?:rename|call|name)\s+(?:it|this|the dashboard|dashboard)\s+(?:to\s+|as\s+)?[\"“']?([^\"”']{2,80})[\"”']?\s*$", t, re.I)
    if m:
        new_name = m.group(1).strip().rstrip(".")
        dbr.update_dashboard(dash.id, schemas.UpdateDashboardRequest(name=new_name), db=db, user=user)
        changes.append(f"renamed to “{new_name}”")

    page = sorted(dash.pages, key=lambda p: p.position)[0] if dash.pages else None
    m = re.search(r"\b(?:remove|delete|drop|hide)\s+(?:the\s+)?(.+?)\s*(?:chart|graph|kpi|table|block|tile)s?\b", t, re.I)
    if m and page is not None:
        want = _norm(m.group(1))
        best, score = None, 0
        for b in page.blocks:
            title = _norm(b.title or "")
            hits = sum(1 for w in want.split() if len(w) > 2 and w in title)
            if hits > score:
                best, score = b, hits
        if best is not None and score:
            label = best.title or best.type
            dbr.delete_block(dash.id, best.id, db=db, user=user)
            changes.append(f"removed “{label}”")
        else:
            raise HTTPException(400, f"I couldn't find a block called “{m.group(1).strip()}” on this page.")

    m = re.search(r"\b(?:add|put|include)\s+(?:a |an |the )?(?:new )?(?:chart|graph|kpi|table|block|tile|number)\s+(?:of|for|showing|with)\s+(.+?)\s*$", t, re.I) \
        or re.search(r"\b(?:add|put|include)\s+(.+?)\s+(?:as a |as an )?(?:chart|graph|kpi|table|block|tile)\s*$", t, re.I)
    if m and page is not None:
        goal = m.group(1).strip().rstrip(".")
        ds = db.get(models.DataSource, dash.datasource_id) if dash.datasource_id else None
        if ds is None:
            raise HTTPException(400, "This dashboard has no data source to compute a new block on.")
        from ...routers.projects import _merge_pages_into
        _d, page_ids = dbr.build_dashboard_from_goal(db, user, ds, goal, conversation_id=conv.id, add_to=dash, pages=1)
        db.refresh(dash)
        target = next((p for p in dash.pages if p.id == page.id), page)
        added = _merge_pages_into(db, dash, page_ids, target)
        db.commit()
        # the builder plans a whole page for the goal; keep the one or two blocks that answer it
        words = [w for w in re.findall(r"[a-z0-9]+", goal.lower()) if len(w) > 2 and w not in ("the", "and", "for", "with", "chart", "graph")]
        scored = []
        for bid in added:
            b = db.get(models.DashboardBlock, bid)
            if b is None:
                continue
            title = _norm(b.title or "")
            hits = sum(1 for w in words if w in title)
            scored.append((hits, 0 if b.type == "chart" else 1, b))
        scored.sort(key=lambda x: (-x[0], x[1]))
        keep = [b for h, _k, b in scored if h > 0][:2] or [b for _h, _k, b in scored[:1]]
        keep_ids = {b.id for b in keep}
        for _h, _k, b in scored:
            if b.id not in keep_ids:
                db.delete(b)
        db.commit()
        added = [b.id for b in keep]
        changes.append(f"added “{keep[0].title}”" if len(keep) == 1 and keep[0].title else f"added {len(added)} block{'s' if len(added) != 1 else ''} for “{goal}”")

    if not changes:
        raise HTTPException(400, "Tell me what to change: the theme (dark, light), a palette, the font, the name, or add / remove a chart.")
    db.refresh(dash)
    return {"changes": changes, "page_id": page.id if page else None, "blocks_added": added, "reload": True, "name": dash.name}
