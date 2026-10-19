"""
2026-10-19 (R56, the list pages of the Studio redesign): the two read-only overviews the new pages draw from.

- workspace_items: everything a person can open in a workspace - answers (conversations), dashboards, pipelines,
  models, reports (documents) and initiatives - as one list with a type, a Space, an owner, a status and its
  "proof" (what was checked: the checks a pipeline passed, a model's held-out score, a report's re-checked figures).
  Each type is read with its own access rules, by calling the same functions its own page uses.
- data_overview: every connected source with its tables, the rows GD360 knows of, how it syncs, when it last did,
  whether it is fresh, who owns it, the last syncs and what uses it.

Nothing here is estimated: a number the source never reported is None, and the page shows a dash.
"""
from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from .. import models


def _iso(v) -> str | None:
    if v is None:
        return None
    if isinstance(v, str):
        return v
    return v.isoformat() + ("Z" if v.tzinfo is None else "")


def _people(db: Session, ids: set[str]) -> dict[str, str]:
    if not ids:
        return {}
    out = {}
    for u in db.query(models.User).filter(models.User.id.in_(list(ids))).all():
        out[u.id] = (getattr(u, "full_name", None) or "").strip() or (u.email or "").split("@")[0]
    return out


def workspace_items(db: Session, user: models.User, workspace_id: str | None) -> dict:
    items: list[dict] = []
    errors: list[str] = []
    owners: set[str] = set()

    # answers - the conversations list (its own access rules)
    try:
        from .agent import turns
        for c in turns.list_conversations(db, user, workspace_id, limit=300):
            conv = db.get(models.Conversation, c["id"])
            if conv is not None:
                owners.add(conv.owner_id)
            items.append({"id": c["id"], "type": "answer", "name": c.get("title") or "Conversation", "link": f"/chat/{c['id']}",
                          "space": c.get("space_name"), "space_color": c.get("space_color"), "owner_id": conv.owner_id if conv else None,
                          "status": {"text": "Saved", "tone": "muted"}, "proof": ({"text": c.get("work") or "Answered", "tone": "good"}),
                          "updated_at": _iso(c.get("last_at") or c.get("created_at")), "views": None, "mine": c.get("mine")})
    except Exception as e:  # noqa: BLE001 - one list never breaks the page
        errors.append(f"answers: {e}")

    # dashboards
    try:
        from ..routers.dashboards import list_dashboards
        for d in list_dashboards(db=db, user=user):
            if workspace_id and d.workspace_id and d.workspace_id != workspace_id:
                continue
            dash = db.get(models.Dashboard, d.id)
            spec = (dash.board_spec or {}) if dash else {}
            draft = bool(spec.get("draft")) if (d.layout_version or 0) == 4 else False
            if dash is not None:
                owners.add(dash.owner_id)
            link = f"/boards/{d.id}" if d.layout_version == 4 else f"/dashboard-builder/{d.id}" if d.layout_version == 2 else f"/dashboards/{d.id}"
            srcs = [s.get("name") for s in (d.sources or []) if s.get("name")]
            items.append({"id": d.id, "type": "dashboard", "name": d.name, "link": link, "space": d.workspace_name, "space_color": None,
                          "owner_id": dash.owner_id if dash else None,
                          "status": {"text": "Draft" if draft else ("Published" if d.published else "Live"), "tone": "muted" if draft else "blue"},
                          "proof": {"text": f"Live on {srcs[0]}" if srcs else "Computed from your data", "tone": "good"} if srcs or d.layout_version == 4 else None,
                          "updated_at": _iso(d.updated_at or d.created_at), "views": None, "mine": d.is_own})
    except Exception as e:  # noqa: BLE001
        errors.append(f"dashboards: {e}")

    # pipelines
    try:
        from .flows import service as flows
        for f in flows.list_flows(db, user, workspace_id):
            row = db.get(models.DataFlow, f["id"])
            if row is not None:
                owners.add(row.owner_id)
            st = f.get("last_status")
            status = {"text": "Running", "tone": "blue"} if st == "running" else \
                {"text": f"{'Held' if st == 'held' else 'Stopped'} {(f.get('last_run_at') or '')[11:16]}".strip(), "tone": "bad"} if st in ("held", "failed") else \
                {"text": {"draft": "Draft", "tested": "Tested", "live": "On", "paused": "Paused"}.get(f["status"], f["status"]), "tone": "good" if f["status"] == "live" else "muted"}
            checks = len([c for c in ((row.spec or {}).get("checks") or []) if c.get("enabled", True)]) if row is not None else 0
            proof = {"text": "Fix waiting" if f.get("needs_fix") else f"{checks} check{'s' if checks != 1 else ''}" + (f" · {f['last_flagged']} odd rows" if f.get("last_flagged") else ""),
                     "tone": "bad" if f.get("needs_fix") else "good"}
            items.append({"id": f["id"], "type": "pipeline", "name": f.get("output") or f["name"], "subtitle": f["name"], "link": f"/automate/{f['id']}",
                          "space": None, "owner_id": row.owner_id if row else None, "status": status, "proof": proof,
                          "updated_at": f.get("last_run_at") or f.get("updated_at"), "views": None, "mine": row is not None and row.owner_id == user.id})
    except Exception as e:  # noqa: BLE001
        errors.append(f"pipelines: {e}")

    # models
    try:
        from ..routers.ml_studio import list_projects
        for m in list_projects(db=db, user=user).get("projects") or []:
            row = db.get(models.MLModel, m["id"])
            if workspace_id and row is not None and row.workspace_id and row.workspace_id != workspace_id:
                continue
            if row is not None:
                owners.add(row.owner_id)
            met = m.get("metrics") or {}
            score = met.get("roc_auc") if met.get("roc_auc") is not None else met.get("r2") if met.get("r2") is not None else met.get("accuracy")
            label = "AUC" if met.get("roc_auc") is not None else "R²" if met.get("r2") is not None else "accuracy"
            items.append({"id": m["id"], "type": "model", "name": m.get("name") or "Model", "link": f"/models/{m['id']}", "space": m.get("source"),
                          "owner_id": row.owner_id if row else None,
                          "status": {"text": {"training": "Training", "ready": "Ready", "failed": "Failed"}.get(m.get("status"), m.get("status")),
                                     "tone": "blue" if m.get("status") == "training" else "good" if m.get("status") == "ready" else "bad"},
                          "proof": {"text": f"{label} {score:.2f} held-out", "tone": "violet"} if isinstance(score, (int, float)) else None,
                          "updated_at": _iso(m.get("trained_at") or m.get("created_at")), "views": m.get("predictions") or None,
                          "mine": row is not None and row.owner_id == user.id})
    except Exception as e:  # noqa: BLE001
        errors.append(f"models: {e}")

    # reports (documents) - the person's own, like the Library tab
    try:
        from .agent import docblocks
        q = db.query(models.DocDocument).filter(models.DocDocument.owner_id == user.id)
        if workspace_id:
            q = q.filter((models.DocDocument.workspace_id == workspace_id) | (models.DocDocument.workspace_id.is_(None)))
        for d in q.order_by(models.DocDocument.updated_at.desc()).limit(200).all():
            sm = docblocks.summary(d, user)
            flagged = len(sm.get("flagged") or [])
            owners.add(d.owner_id)
            items.append({"id": d.id, "type": "report", "name": d.title, "link": f"/docs/{d.id}", "space": None, "owner_id": d.owner_id,
                          "status": {"text": "Edited" if d.edited_by_person else "Written", "tone": "muted"},
                          "proof": {"text": f"{flagged} figure{'s' if flagged != 1 else ''} not found" if flagged else f"All {sm.get('checked', 0)} figures re-checked",
                                    "tone": "bad" if flagged else "good"},
                          "updated_at": _iso(d.updated_at or d.created_at), "views": None, "mine": True})
    except Exception as e:  # noqa: BLE001
        errors.append(f"reports: {e}")

    # initiatives
    try:
        if workspace_id:
            from .initiatives import metrics
            for x in metrics.hub(db, user, workspace_id).get("initiatives") or []:
                h = x.get("health") or {}
                items.append({"id": x["id"], "type": "initiative", "name": x.get("title") or "Initiative", "link": f"/initiatives/{x['id']}",
                              "space": x.get("department"), "owner_id": x.get("owner_id"),
                              "status": {"text": {"active": "Live", "planning": "Planning", "done": "Finished"}.get(x.get("status"), x.get("status")),
                                         "tone": "blue" if x.get("status") == "active" else "muted"},
                              "proof": {"text": h.get("label") or h.get("state") or "", "tone": "bad" if h.get("state") == "risk" else "good"} if h else None,
                              "updated_at": _iso(x.get("updated_at")), "views": None, "mine": x.get("owner_id") == user.id})
                if x.get("owner_id"):
                    owners.add(x["owner_id"])
    except Exception as e:  # noqa: BLE001
        errors.append(f"initiatives: {e}")

    names = _people(db, {o for o in owners if o})
    for it in items:
        it["owner"] = "You" if it.get("owner_id") == user.id else names.get(it.get("owner_id") or "", "—")
    items.sort(key=lambda x: x.get("updated_at") or "", reverse=True)
    counts: dict[str, int] = {}
    for it in items:
        counts[it["type"]] = counts.get(it["type"], 0) + 1
    if errors:
        print(f"[overview] workspace_items partial: {errors}")
    return {"items": items, "counts": counts, "total": len(items), "partial": bool(errors)}


def data_overview(db: Session, user: models.User, workspace_id: str | None) -> dict:
    from .project_engine.catalog import accessible_sources, build_source
    sources = accessible_sources(db, user, workspace_id)[:200]
    owners = _people(db, {s.owner_id for s in sources if getattr(s, "owner_id", None)})
    rows_out: list[dict] = []
    total_tables = total_rows = 0
    fresh_hour = 0
    issues = 0
    since = datetime.utcnow() - timedelta(hours=1)
    sids = [s.id for s in sources]
    syncs: dict[str, list] = {}
    if sids:
        for r in (db.query(models.SyncRun).filter(models.SyncRun.datasource_id.in_(sids))
                  .order_by(models.SyncRun.started_at.desc()).limit(2000).all()):
            lst = syncs.setdefault(r.datasource_id, [])
            if len(lst) < 12:
                lst.append({"status": r.status, "at": _iso(r.started_at), "rows": r.rows, "error": (r.error_message or "")[:200] or None})
    dash_by: dict[str, int] = {}
    for d in db.query(models.Dashboard.datasource_id, models.Dashboard.board_spec).all():
        sid = d[0] or ((d[1] or {}).get("source") or {}).get("source_id")
        if sid:
            dash_by[sid] = dash_by.get(sid, 0) + 1
    flow_by: dict[str, int] = {}
    for (spec,) in db.query(models.DataFlow.spec).all():
        for s in (spec or {}).get("sources") or []:
            if s.get("datasource_id"):
                flow_by[s["datasource_id"]] = flow_by.get(s["datasource_id"], 0) + 1
    model_by: dict[str, int] = {}
    for (sid,) in db.query(models.MLModel.datasource_id).all():
        model_by[sid] = model_by.get(sid, 0) + 1
    sensitive: dict[str, list[str]] = {}
    try:
        for c in db.query(models.SensitiveColumn).filter(models.SensitiveColumn.datasource_id.in_(sids or [""])).all():
            if getattr(c, "status", "flagged") != "dismissed":
                sensitive.setdefault(c.datasource_id, []).append(getattr(c, "category", None) or "personal")
    except Exception:  # noqa: BLE001 - the Trust Center may not have scanned yet
        pass
    for s in sources:
        tables, rows = None, None
        mode, freshness, note = "", "", ""
        try:
            cs = build_source(db, s, user)
            mode, freshness, note = cs.mode, cs.freshness, cs.note
            tables = len(cs.tables)
            known = [t.rows for t in cs.tables if t.rows is not None]
            rows = sum(known) if known else None
            if rows is None:
                # an uploaded file: the rows its import counted (import_summary), else the profile cache's exact count
                summ = (s.connection_info or {}).get("import_summary") or {}
                if isinstance(summ.get("rows"), int):
                    rows = summ["rows"]
                else:
                    from .profile_cache import cached_exact_total_rows
                    got = [cached_exact_total_rows(s.id, t.source_key or t.name) for t in cs.tables]
                    rows = sum(g for g in got if g) or None
            label = cs.label
        except Exception as e:  # noqa: BLE001 - a source that can't be read still lists
            label = s.kind
            note = str(e)[:160]
        last = getattr(s, "last_synced_at", None) or getattr(s, "cleaned_updated_at", None) or s.created_at
        err = getattr(s, "sync_error", None)
        state = "bad" if err else ("live" if mode == "live" else "fresh" if mode == "synced" else "static")
        if err:
            issues += 1
        if mode == "live" or (last and last >= since):
            fresh_hour += 1
        total_tables += tables or 0
        total_rows += rows or 0
        rows_out.append({
            "id": s.id, "name": s.name, "kind": s.kind, "label": label, "mode": mode, "tables": tables, "rows": rows,
            "sync": "Queried in place" if mode == "live" else ("On upload" if mode == "file" else f"Synced · {((s.connection_info or {}).get('interval') or (s.connection_info or {}).get('sync_interval') or 'on a schedule')}"),
            "last_sync": _iso(last) if mode != "live" else None, "next_sync": _iso(getattr(s, "next_sync_at", None)),
            "freshness": freshness, "state": state, "error": err, "note": note, "owner": "You" if s.owner_id == user.id else owners.get(s.owner_id, "—"),
            "syncs": list(reversed(syncs.get(s.id, []))), "used_by": {"dashboards": dash_by.get(s.id, 0), "pipelines": flow_by.get(s.id, 0), "models": model_by.get(s.id, 0)},
            "personal": sorted(set(sensitive.get(s.id, [])))[:6], "workspace_id": s.workspace_id,
        })
    kinds: dict[str, int] = {}
    for r in rows_out:
        g = "warehouse" if r["kind"] in ("bigquery", "snowflake", "redshift", "databricks") else \
            "database" if r["kind"] in ("postgres", "postgresql", "mysql", "mssql", "sqlserver", "sqlite") else \
            "file" if r["mode"] == "file" or r["kind"] in ("csv", "excel", "file", "parquet", "json") else "app"
        r["group"] = g
        kinds[g] = kinds.get(g, 0) + 1
    return {"sources": rows_out, "kpis": {"tables": total_tables, "rows": total_rows, "fresh_hour": fresh_hour, "total": len(rows_out), "issues": issues},
            "groups": kinds}
