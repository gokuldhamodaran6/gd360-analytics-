"""
Dashboards built from a Project answer (2026-10-08, round 11).

"Make dashboard" turns a finished answer into a live dashboard
(layout_version 3) that spans every source the answer used. The dashboard
keeps the answer's checked plan (project_spec) and re-runs it on refresh -
no language model involved: the same queries, in the same sources, with
the same guards, and the same deterministic analysis. Windows written
relative to the current date in the queries ("this month so far") move
with time, so a refresh is a genuinely current view.

Tiles: headline numbers (KPIs), the analysis charts (the change split into
parts, the drivers, the trend) and the context tables (ad spend, budget
changes ...), each labelled with the source(s) it comes from.
"""
from __future__ import annotations

import secrets
from datetime import datetime

from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from ... import models
from .analysis import table_payload  # noqa: F401  (re-exported for callers)
from .catalog import build_catalog
from .numbers import fmt


class DashboardBuildError(ValueError):
    pass


def _kpis(analysis_type: str, summary: dict, facts: list[dict]) -> list[dict]:
    by_id = {f["id"]: f for f in facts or []}
    out = []
    if analysis_type == "explain_change" and summary.get("fact_ids"):
        ids = summary["fact_ids"]
        cur = by_id.get(ids[0])
        pct = by_id.get(ids[3]) if len(ids) > 3 else None
        if cur:
            out.append({"key": "total", "label": summary.get("metric") or "Value", "display": cur["display"],
                        "delta": pct["display"] if pct else None, "delta_dir": summary.get("direction"),
                        "note": f"vs {summary.get('previous_label')}", "sources": cur.get("sources") or [],
                        "value": cur.get("value"), "kind": cur.get("kind"), "delta_pct": pct.get("value") if pct else None})
        for c in summary.get("components") or []:
            fid = c.get("fact_ids") or []
            f0 = by_id.get(fid[0]) if fid else None
            fp = by_id.get(fid[2]) if len(fid) > 2 else None
            if f0:
                d = c.get("pct")
                out.append({"key": f"component:{c['name']}", "label": c["name"], "display": f0["display"],
                            "delta": fp["display"] if fp else None,
                            "delta_dir": None if d is None else ("down" if d < 0 else "up" if d > 0 else "flat"),
                            "note": f"vs {summary.get('previous_label')}", "sources": f0.get("sources") or [],
                            "value": f0.get("value"), "kind": f0.get("kind"), "delta_pct": d})
    elif analysis_type == "trend":
        for s in summary.get("series") or []:
            ids = s.get("fact_ids") or []
            last = by_id.get(ids[1]) if len(ids) > 1 else None
            pct = by_id.get(ids[3]) if len(ids) > 3 else None
            if last:
                out.append({"key": f"series:{s['name']}", "label": s["name"], "display": last["display"],
                            "sources": last.get("sources") or [], "value": last.get("value"), "kind": last.get("kind"),
                            "delta_pct": s.get("pct"),
                            "delta": pct["display"] if pct and pct.get("kind") == "percent" else None,
                            "delta_dir": None if s.get("pct") is None else ("down" if s["pct"] < 0 else "up"),
                            "note": "latest vs first period"})
    elif analysis_type in ("breakdown", "comparison"):
        ids = summary.get("fact_ids") or []
        if ids and by_id.get(ids[0]):
            out.append({"key": "total", "label": by_id[ids[0]]["label"], "display": by_id[ids[0]]["display"],
                        "sources": by_id[ids[0]].get("sources") or [], "value": by_id[ids[0]].get("value"),
                        "kind": by_id[ids[0]].get("kind")})
        segs = summary.get("segments") or []
        if segs:
            f = by_id.get(segs[0]["fact_ids"][0])
            if f:
                out.append({"key": "top", "label": f"Top: {segs[0]['segment']}", "display": f["display"],
                            "note": by_id.get(segs[0]["fact_ids"][1], {}).get("display", "") + " of total" if len(segs[0]["fact_ids"]) > 1 else ""})
    else:
        for f in (facts or [])[:4]:
            out.append({"key": f"fact:{f['label']}", "label": f["label"], "display": f["display"], "sources": f.get("sources") or [],
                        "value": f.get("value"), "kind": f.get("kind")})
    return out[:6]


def build_snapshot(plan: dict, analysis: dict, evidence: list[dict], steps: list[dict], warnings: list[str]) -> dict:
    ctx_ids = set((plan.get("analysis") or {}).get("context") or [])
    by_id = {e["id"]: e for e in evidence}
    src_of = {s["id"]: s.get("source_name") for s in steps or []}
    return {
        "kpis": _kpis(analysis.get("type"), analysis.get("summary") or {}, analysis.get("facts") or []),
        "visuals": analysis.get("visuals") or [],
        "context": [
            {"id": cid, "title": by_id[cid]["title"], "source": src_of.get(cid), "columns": by_id[cid]["columns"],
             "rows": by_id[cid]["rows"][:200]}
            for cid in ctx_ids if cid in by_id
        ],
        "facts": analysis.get("facts") or [],
        "summary": analysis.get("summary") or {},
        "analysis_type": analysis.get("type"),
        "warnings": warnings,
        "steps": [
            {k: s.get(k) for k in ("id", "kind", "title", "source_name", "source_kind", "mode", "status", "error",
                                   "rows_returned", "duration_ms", "freshness")}
            for s in steps or []
        ],
    }


def default_tiles(snapshot: dict, plan: dict) -> list[dict]:
    tiles = []
    for k in snapshot.get("kpis") or []:
        tiles.append({"id": f"t_{secrets.token_hex(3)}", "kind": "kpi", "ref": k["key"], "title": k["label"], "hidden": False, "span": 1})
    for i, v in enumerate(snapshot.get("visuals") or []):
        if v.get("type") == "kpis":
            continue
        tiles.append({"id": f"t_{secrets.token_hex(3)}", "kind": "visual", "ref": i, "title": v.get("title") or "Chart",
                      "hidden": False, "span": 2, "chart_type": v.get("chart_type")})
    for c in snapshot.get("context") or []:
        tiles.append({"id": f"t_{secrets.token_hex(3)}", "kind": "context", "ref": c["id"], "title": c["title"],
                      "hidden": False, "span": 2, "chart_type": None})
    return tiles


def dashboard_from_run(db: Session, conv: models.Conversation, run: models.ProjectRun, user: models.User,
                       name: str | None = None) -> models.Dashboard:
    plan = dict(run.plan or {})
    plan.pop("replaced_plan", None)
    result = run.result or {}
    if not plan.get("steps") or not result:
        raise DashboardBuildError("This answer has nothing to put on a dashboard.")
    analysis = {
        "type": result.get("analysis_type"), "facts": result.get("facts"), "summary": result.get("summary"),
        "visuals": result.get("visuals"),
    }
    snapshot = build_snapshot(plan, analysis, result.get("evidence") or [], run.steps or [], result.get("warnings") or [])
    spec = {
        "version": 1,
        "project_id": conv.id,
        "run_id": run.id,
        "question": run.question,
        "source_ids": list(conv.source_ids or []),
        "plan": {k: plan.get(k) for k in ("title", "understanding", "assumptions", "steps", "combine", "analysis")},
        "tiles": default_tiles(snapshot, plan),
        "headline": (result.get("answer") or {}).get("headline"),
    }
    dash = models.Dashboard(
        # private until shared (PATCH /dashboards/{id}/workspace), like every new dashboard
        owner_id=user.id, workspace_id=None,
        name=(name or plan.get("title") or run.question)[:120], layout_version=3,
        source_conversation_id=conv.id, datasource_id=(conv.source_ids or [None])[0],
        project_spec=spec, project_snapshot=snapshot, snapshot_at=run.finished_at or datetime.utcnow(),
    )
    db.add(dash)
    db.commit()
    db.refresh(dash)
    return dash


def rerun_snapshot(db: Session, plan: dict, user: models.User, source_ids: list[str]) -> dict:
    """Runs a saved, checked plan again in every source - no language model -
    and returns a fresh snapshot (KPIs, charts, context, steps). Used by a
    dashboard refresh and by automations. Raises DashboardBuildError when
    none of the queries could run."""
    from . import executor  # local: executor imports this module's siblings
    plan = {k: v for k, v in (plan or {}).items() if k != "replaced_plan"}
    catalog = build_catalog(db, user, source_ids or [])
    steps = {s["id"]: dict(s) for s in executor.initial_steps(plan)}

    def set_step(step_id, **fields):
        if step_id in steps:
            steps[step_id].update(fields)

    tables, evidence = executor.run_plan(db, plan, user, catalog, set_step, lambda: False)
    if not tables:
        failed = [s for s in steps.values() if s.get("status") == "failed"]
        raise DashboardBuildError("None of the queries could run. " + ((failed[0].get("error") or "") if failed else ""))
    analysis, warnings = executor.analyse(plan, tables, list(steps.values()))
    return build_snapshot(plan, analysis, evidence, list(steps.values()), warnings)


def refresh(db: Session, dash: models.Dashboard, user: models.User) -> models.Dashboard:
    """Re-runs the dashboard's plan in every source and stores the new
    snapshot. Synchronous; raises DashboardBuildError when nothing ran."""
    spec = dash.project_spec or {}
    plan = spec.get("plan") or {}
    snapshot = rerun_snapshot(db, plan, user, spec.get("source_ids") or [])
    dash.project_snapshot = snapshot
    dash.snapshot_at = datetime.utcnow()
    # keep the tiles, add any new visual the refresh produced
    tiles = spec.get("tiles") or []
    if len(snapshot.get("visuals") or []) > len([t for t in tiles if t["kind"] == "visual"]):
        known = {t["ref"] for t in tiles if t["kind"] == "visual"}
        for i, v in enumerate(snapshot["visuals"]):
            if i not in known and v.get("type") != "kpis":
                tiles.append({"id": f"t_{secrets.token_hex(3)}", "kind": "visual", "ref": i, "title": v.get("title") or "Chart",
                              "hidden": False, "span": 2, "chart_type": v.get("chart_type")})
        spec["tiles"] = tiles
        dash.project_spec = spec
        flag_modified(dash, "project_spec")
    flag_modified(dash, "project_snapshot")
    db.commit()
    db.refresh(dash)
    return dash


def headline_for(snapshot: dict) -> str | None:
    kpis = snapshot.get("kpis") or []
    if kpis and kpis[0].get("display"):
        k = kpis[0]
        line = f"{k.get('label')}: {k['display']}"
        if k.get("delta"):
            line += " (" + f"{k['delta']} {k.get('note') or ''}".strip() + ")"
        return line + "."
    s = snapshot.get("summary") or {}
    if snapshot.get("analysis_type") == "explain_change" and "delta" in s:
        return f"{s.get('metric')}: {fmt(s.get('current'))} in {s.get('current_label')} vs {fmt(s.get('previous'))} in {s.get('previous_label')}."
    return None
