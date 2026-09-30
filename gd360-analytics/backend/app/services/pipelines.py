"""
2026-09-30 (orchestration v1): the canonical resolver for models.Pipeline -
the one place a pipeline's steps are ever actually executed, mirroring
services/transforms.py's own "one shared resolver" design from the
transformation-layer round (2026-09-30, earlier the same day), and
services/metrics.py's before that.

See models.Pipeline's own docstring for the full design rationale and the
exact shape of each of the three whitelisted step types this module
dispatches: "refresh_datasource", "rebuild_dashboard", "run_quality_checks".

FAIL-STOP, NOT FAIL-DISCARD - deliberately different from
services/transforms.apply_transform_steps: that function discards its
whole in-memory result on the first bad step, because a later transform
step depends on the EXACT shape the previous step produced. A pipeline
step is different in kind - it is a real, already-happened side effect
against the live database (an API fetch actually ran, a dashboard actually
recomputed, a quality rule actually re-evaluated) - so a step that already
succeeded stays done; run_pipeline_steps only ever STOPS running further
steps after the first failure, it never undoes what already worked.
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy.orm import Session

from .. import models

STEP_TYPES = ("refresh_datasource", "rebuild_dashboard", "run_quality_checks")
MAX_STEPS = 10


def _step_label(db: Session, step: dict) -> str | None:
    """A live, human-readable name for this step's target, resolved fresh
    every call - never stored/cached on the step dict itself, so a later
    rename of the underlying data source or dashboard (or its outright
    deletion) is always reflected honestly rather than showing a stale
    name or a bare id."""
    if not isinstance(step, dict):
        return None
    op = step.get("type")
    if op in ("refresh_datasource", "run_quality_checks"):
        ds = db.query(models.DataSource).filter(models.DataSource.id == step.get("datasource_id")).first()
        return ds.name if ds else None
    if op == "rebuild_dashboard":
        d = db.query(models.Dashboard).filter(models.Dashboard.id == step.get("dashboard_id")).first()
        return d.name if d else None
    return None


def describe_pipeline_step(db: Session, step: dict) -> str | None:
    """Plain-English one-liner for one step, mirroring
    services/transforms.describe_transform_step's own pattern - what the
    pipeline builder UI and the run-history detail both render."""
    if not isinstance(step, dict):
        return None
    op = step.get("type")
    label = _step_label(db, step)
    target = f'"{label}"' if label else "a data source/dashboard that no longer exists"
    if op == "refresh_datasource":
        return f"Refresh {target}'s data"
    if op == "rebuild_dashboard":
        return f"Rebuild {target}"
    if op == "run_quality_checks":
        return f"Re-check {target}'s data-quality rules"
    return None


def describe_pipeline(db: Session, steps: list[dict]) -> list[str]:
    return [d for d in (describe_pipeline_step(db, s) for s in (steps or [])) if d]


def _run_refresh_datasource_step(db: Session, step: dict, owner_id: str) -> dict:
    # Local import: services/datasource_refresh.py has no dependency back
    # on this module, so this is just keeping import cost paid only when
    # this specific step type actually runs, matching this file's other
    # two handlers below.
    from .datasource_refresh import refresh_api_datasource

    ds = db.query(models.DataSource).filter(models.DataSource.id == step.get("datasource_id")).first()
    if not ds:
        raise RuntimeError("That data source no longer exists.")
    if ds.kind != "api":
        raise RuntimeError(
            f'"{ds.name}" isn\'t an API data source - only an API-connected source has anything to refresh '
            "(every other kind is read live on every query)."
        )
    df = refresh_api_datasource(db, ds)
    return {"rows": int(len(df)), "columns": int(len(df.columns))}


def _run_rebuild_dashboard_step(db: Session, step: dict, owner_id: str) -> dict:
    # Local import to avoid a circular import: services/scheduler.py will
    # itself locally-import services/pipelines.run_pipeline from inside
    # _tick (see that module), so neither file can import the other at
    # module load time.
    from .scheduler import refresh_dashboard

    dashboard = db.query(models.Dashboard).filter(models.Dashboard.id == step.get("dashboard_id")).first()
    if not dashboard:
        raise RuntimeError("That dashboard no longer exists.")
    job = refresh_dashboard(db, dashboard, job_type="pipeline_step")
    if job.status == "failed":
        raise RuntimeError(job.error_message or "That dashboard's refresh failed.")
    return {"job_run_id": job.id}


def _run_quality_checks_step(db: Session, step: dict, owner_id: str) -> dict:
    from .quality_checks import run_quality_rule

    ds = db.query(models.DataSource).filter(models.DataSource.id == step.get("datasource_id")).first()
    if not ds:
        raise RuntimeError("That data source no longer exists.")
    rules = db.query(models.DataQualityRule).filter(models.DataQualityRule.datasource_id == ds.id).all()
    if not rules:
        return {"checked": 0, "failing": 0, "errored": 0}
    failing = 0
    errored = 0
    for rule in rules:
        run_quality_rule(db, rule)
        if rule.last_status == "fail":
            failing += 1
        elif rule.last_status == "error":
            errored += 1
    # run_quality_rule never commits itself (see its own docstring) - this
    # step is the caller, so it commits once for every rule it just
    # re-evaluated, same "caller controls the transaction" contract
    # routers/quality_checks.py's own endpoints already follow.
    db.commit()
    if failing or errored:
        raise RuntimeError(f"{failing} rule(s) failing, {errored} rule(s) errored, out of {len(rules)} checked.")
    return {"checked": len(rules), "failing": 0, "errored": 0}


STEP_HANDLERS = {
    "refresh_datasource": _run_refresh_datasource_step,
    "rebuild_dashboard": _run_rebuild_dashboard_step,
    "run_quality_checks": _run_quality_checks_step,
}


def run_pipeline_steps(db: Session, steps: list[dict], owner_id: str) -> list[dict]:
    """Runs each step in `steps` STRICTLY IN ORDER, stopping at the first
    one that fails - "linear chain" semantics: step 2 never runs unless
    step 1 genuinely succeeded a moment ago, in this same call. Returns
    one result dict per step ACTUALLY ATTEMPTED (never one for a step
    skipped after an earlier one already failed):
        {"index": i, "type": ..., "label": <live-resolved target name>,
         "status": "success" | "failed", "detail": dict | None,
         "error": str | None}
    Raises nothing itself - every failure (an unknown step type, or a
    handler raising) is caught right here and recorded as that step's own
    "failed" result; the caller (run_pipeline) is what decides what a
    failed/incomplete steps list means for the overall PipelineRun."""
    results: list[dict] = []
    for i, step in enumerate(steps or []):
        op = step.get("type") if isinstance(step, dict) else None
        label = _step_label(db, step)
        handler = STEP_HANDLERS.get(op)
        if handler is None:
            results.append(
                {"index": i, "type": op, "label": label, "status": "failed",
                 "detail": None, "error": f'Unknown step type "{op}".'}
            )
            break
        try:
            detail = handler(db, step, owner_id)
            results.append(
                {"index": i, "type": op, "label": label, "status": "success", "detail": detail, "error": None}
            )
        except Exception as e:
            results.append(
                {"index": i, "type": op, "label": label, "status": "failed",
                 "detail": None, "error": str(e)[:2000]}
            )
            break
    return results


def run_pipeline(db: Session, pipeline: "models.Pipeline", run_type: str) -> "models.PipelineRun":
    """Runs `pipeline`'s steps in order and logs the attempt as a
    PipelineRun (see that model's own docstring) - mirroring
    services/scheduler.refresh_dashboard's own "create the run row with
    status=running and commit BEFORE any real work happens" pattern
    exactly, so a process crash mid-run still leaves an honest "running"
    row behind rather than silently vanishing.

    Called both by services/scheduler.py's _tick (run_type="scheduled")
    and by routers/pipelines.py's "Run now" (run_type="manual") - the
    exact same function either way, the same dual-caller pattern
    refresh_dashboard itself already established for dashboards, so a
    manual run and a scheduled run always behave identically and are both
    fully auditable in the same history."""
    # Local import - see _run_rebuild_dashboard_step's own comment on why
    # services/scheduler.py and this module can't import each other at
    # module load time.
    from .scheduler import compute_next_refresh_at

    run = models.PipelineRun(
        pipeline_id=pipeline.id,
        owner_id=pipeline.owner_id,
        run_type=run_type,
        pipeline_name=pipeline.name,
        status="running",
        started_at=datetime.utcnow(),
        step_results=[],
    )
    db.add(run)
    db.commit()
    db.refresh(run)

    steps = pipeline.steps or []
    try:
        if not steps:
            # An empty chain has nothing to genuinely succeed at - "success"
            # would be a fabricated claim about work that never happened,
            # so this is honestly "failed" with a plain explanation, never
            # a silent vacuous-truth "success" for zero steps attempted.
            run.step_results = []
            run.status = "failed"
            run.error_message = "This pipeline has no steps."
        else:
            step_results = run_pipeline_steps(db, steps, pipeline.owner_id)
            run.step_results = step_results
            all_ran_and_ok = len(step_results) == len(steps) and all(r["status"] == "success" for r in step_results)
            run.status = "success" if all_ran_and_ok else "failed"
            if not all_ran_and_ok:
                failed = next((r for r in step_results if r["status"] == "failed"), None)
                run.error_message = (
                    f'Step {failed["index"] + 1} ({failed["type"]}): {failed["error"]}'
                    if failed else "This pipeline did not complete."
                )
    except Exception as e:
        # Guards against something going wrong outside run_pipeline_steps'
        # own per-step try/except (e.g. the commit above failing) - the
        # same belt-and-suspenders outer catch services/scheduler._tick
        # itself uses around refresh_dashboard.
        run.status = "failed"
        run.error_message = str(e)[:2000]
    finally:
        run.finished_at = datetime.utcnow()
        pipeline.last_run_at = run.finished_at
        # Reschedules the NEXT attempt even after a failure - same "keep
        # retrying on its normal cadence, don't silently stop forever
        # after one bad tick" rule services/scheduler.refresh_dashboard
        # already follows for dashboards.
        pipeline.next_run_at = compute_next_refresh_at(pipeline.schedule_interval, run.finished_at)
        run.next_run_at = pipeline.next_run_at
        db.commit()
        db.refresh(run)
    return run
