"""
Scheduled dashboard auto-refresh (2026-09-28).

This app had no auto-refreshing data pipeline at all before this round -
models.DashboardBlock's own docstring says so plainly: "a block's numbers
only change when someone rebuilds them." This module is what closes that
gap, honestly, for real - not a fabricated "live" indicator, but a real
60-second loop that finds dashboards whose schedule is due and actually
recomputes them.

GRANULARITY: per-DASHBOARD, not per-block. See models.Dashboard's own
docstring for the full reasoning - every block on a dashboard already
shares the exact same one data source, so "refresh this dashboard" already
means "recompute everything on it that can be safely recomputed", and a
per-block schedule would only add UI complexity for zero real benefit.

MECHANISM: there is no separate background-job runner/worker process in
this app (no Celery, no separate worker dyno on Render) - just this one
FastAPI web service. APScheduler's BackgroundScheduler runs `_tick` on its
own thread INSIDE this same process, started once from main.py's startup
event (see start_scheduler below).

HONEST LIMITATION, stated plainly rather than left implicit, because a
non-technical founder deserves to know exactly what he's getting: this
only works while this web process is actually running. If Render ever
spins this service down for inactivity (the free/starter plan does, after
a period with no incoming HTTP traffic), this loop stops running entirely
until the next real request wakes the service back up - a scheduled
refresh due during that window simply does not happen on time; it happens
whenever the service next wakes up and this loop resumes its normal
60-second cadence. This is not a bug to quietly work around - it is a real
constraint of running a scheduler inside a web dyno instead of a separate
always-on worker (which costs more and is real future work, not a gap to
paper over).

WHAT ACTUALLY GETS RECOMPUTED: refresh_dashboard() reuses the exact same
recompute logic routers/dashboard_builder.py's ask_ai_block and
build_manual_block already use for a person clicking "Ask AI"/"Build
manually" by hand - it does not reimplement that logic a second time:
  - A block built with "Build manually" has a stored `recipe` in its
    config (see build_manual_block) - re-run through
    dashboard_builder._run_manual_recipe, deterministic, no AI call, the
    exact same function preview_filtered_blocks (cross-filtering) already
    reuses for the same reason.
  - A block built with "Ask AI" now also remembers the exact prompt it was
    built from (config["ai_prompt"] - see ask_ai_block's own comment for
    why this was added) - re-run through services.ai_engine.analyze with
    guided=False (same as ask_ai_block itself, since nobody is present
    here to answer a clarifying question) and
    dashboard_builder._ai_result_to_block.
  - Anything else (an untouched placeholder block, a text/filter/heading/
    divider block, or an older AI-built block from before ai_prompt
    existed) is left exactly as it is - the same "leave it alone rather
    than guess" rule Phase 2b's cross-filtering already established for an
    AI block with no recipe to safely re-run.
"""
import logging
from datetime import datetime, timedelta
from typing import Optional

from apscheduler.schedulers.background import BackgroundScheduler
from sqlalchemy.orm import Session

from .. import models
from ..database import SessionLocal
from . import ai_engine, chart_builder
from .data_loader import load_dataframe

logger = logging.getLogger("gd360.scheduler")

_REFRESH_INTERVAL_DELTAS = {
    "15m": timedelta(minutes=15),
    "1h": timedelta(hours=1),
    "6h": timedelta(hours=6),
    "daily": timedelta(days=1),
}


def compute_next_refresh_at(interval: Optional[str], from_time: datetime) -> Optional[datetime]:
    """The next time a dashboard with this `interval` is due, measured
    from `from_time` (always the moment its LAST refresh actually
    finished, or now for a schedule being turned on for the first time -
    see routers/jobs.py update_schedule). None/an unrecognized interval
    means no schedule at all."""
    if not interval or interval not in _REFRESH_INTERVAL_DELTAS:
        return None
    return from_time + _REFRESH_INTERVAL_DELTAS[interval]


def refresh_dashboard(db: Session, dashboard: models.Dashboard, job_type: str) -> models.JobRun:
    """Recomputes every block on `dashboard` that can be safely recomputed
    with nobody present to answer a clarifying question, and logs the
    attempt as a JobRun (see that model's own docstring). Called both by
    _tick below (job_type="scheduled_refresh") and by routers/jobs.py's
    "Run now" endpoint (job_type="manual_refresh") - the exact same
    function either way, so a manual run and a scheduled run always behave
    identically and are both fully auditable in the same history.

    The JobRun row is created with status="running" and committed BEFORE
    any real work happens, so a process crash mid-refresh still leaves an
    honest "running" row behind in the Jobs page rather than silently
    vanishing. A single block failing to recompute never aborts the whole
    run - it is logged and skipped, and the JobRun only ever reports
    "failed" for something that stopped the ENTIRE refresh outright (most
    commonly: this dashboard has no data source, or that data source could
    not be loaded at all)."""
    # Local imports - dashboard_builder.py imports from services.ai_engine
    # (this module's own sibling), so importing it back at module load time
    # here would risk a circular import; importing inside the function body
    # avoids that entirely and costs nothing at this call frequency (once
    # per due dashboard per minute, at most).
    from ..routers.dashboard_builder import _ai_result_to_block, _dashboard_datasource, _run_manual_recipe

    ds = _dashboard_datasource(db, dashboard)
    job = models.JobRun(
        dashboard_id=dashboard.id,
        owner_id=dashboard.owner_id,
        job_type=job_type,
        target_label=dashboard.name,
        source_label=ds.name if ds else None,
        status="running",
        started_at=datetime.utcnow(),
    )
    db.add(job)
    db.commit()
    db.refresh(job)

    try:
        if not ds:
            raise RuntimeError("This dashboard has no data source to refresh from yet.")
        original_df = load_dataframe(ds, table=None, version="original", db=db)

        for page in dashboard.pages:
            for block in page.blocks:
                config = block.config or {}
                recipe = config.get("recipe")
                ai_prompt = config.get("ai_prompt")
                # Captured BEFORE either branch below replaces block.config
                # wholesale - both _run_manual_recipe and _ai_result_to_block
                # return a fresh config built only from the recomputed data,
                # with no idea these presentation-only fields (set through
                # their own separate endpoints - set_block_accent_color and
                # set_block_analysis) exist at all, so a scheduled refresh
                # would otherwise silently erase them every single time a
                # dashboard on a schedule recomputes.
                old_accent_color = config.get("accent_color")
                old_forecast = bool(config.get("forecast_enabled"))
                old_anomalies = bool(config.get("anomalies_enabled"))
                try:
                    if recipe:
                        actual_type, new_config, _default_title = _run_manual_recipe(
                            original_df, recipe, existing_title=block.title
                        )
                        block.type = actual_type
                        block.config = new_config
                        block.data_updated_at = datetime.utcnow()
                    elif ai_prompt:
                        result = ai_engine.analyze(
                            ai_prompt, {"Original data": original_df}, history=[], guided=False,
                            skip_prep=False, original_df=original_df,
                        )
                        if result.get("needs_clarification"):
                            # Nobody here to answer it - leave this block
                            # exactly as it was, same as ask_ai_block would
                            # 422 back to a person if this happened live.
                            continue
                        actual_type, new_config = _ai_result_to_block(result, block.type)
                        new_config["ai_prompt"] = ai_prompt
                        block.type = actual_type
                        block.config = new_config
                        block.data_updated_at = datetime.utcnow()
                    else:
                        # No recipe, no remembered prompt - nothing safe to
                        # recompute unattended, leave it alone entirely
                        # (including whatever presentation fields it has).
                        continue

                    # Carry the presentation-only fields forward onto the
                    # freshly recomputed config - a scheduled refresh must
                    # never silently turn off a person's accent color or
                    # forecast/anomaly toggles just because the underlying
                    # data changed.
                    if old_accent_color:
                        # Pure presentation, no re-render needed - same
                        # one-line merge set_block_accent_color itself uses.
                        block.config["accent_color"] = old_accent_color
                    if (old_forecast or old_anomalies) and block.config.get("chart_spec"):
                        try:
                            new_spec, anomaly_count = chart_builder.apply_analysis_overlays(
                                block.config["chart_spec"], old_forecast, old_anomalies
                            )
                            block.config["chart_spec"] = new_spec
                            block.config["forecast_enabled"] = old_forecast
                            block.config["anomalies_enabled"] = old_anomalies
                            block.config["anomaly_count"] = anomaly_count
                        except Exception as overlay_err:
                            # A scheduled refresh must never crash or abort
                            # over a presentation overlay - same "log and
                            # skip" philosophy as the rest of this function.
                            # The block's real, freshly recomputed data is
                            # kept exactly as-is; only the overlay is left
                            # off, honestly reflected by leaving the flags
                            # False rather than claiming they're still on.
                            logger.warning(
                                "[scheduler] block %s on dashboard %s: couldn't reapply "
                                "forecast/anomaly overlay after refresh: %s",
                                block.id, dashboard.id, overlay_err,
                            )
                            block.config["forecast_enabled"] = False
                            block.config["anomalies_enabled"] = False
                except Exception as e:
                    logger.warning(
                        "[scheduler] block %s on dashboard %s failed to refresh: %s", block.id, dashboard.id, e
                    )
                    continue

        dashboard.last_refreshed_at = datetime.utcnow()
        dashboard.next_refresh_at = compute_next_refresh_at(dashboard.refresh_interval, dashboard.last_refreshed_at)
        job.status = "success"
    except Exception as e:
        logger.warning("[scheduler] dashboard %s refresh failed: %s", dashboard.id, e)
        job.status = "failed"
        job.error_message = str(e)[:2000]
        # Still reschedule the NEXT attempt even after a failure (e.g. a
        # database that's briefly unreachable, or a data source deleted
        # out from under a scheduled dashboard) - a broken refresh should
        # keep retrying on its normal cadence, not silently stop forever
        # after one bad tick.
        dashboard.next_refresh_at = compute_next_refresh_at(dashboard.refresh_interval, datetime.utcnow())
    finally:
        job.finished_at = datetime.utcnow()
        job.next_run_at = dashboard.next_refresh_at
        db.commit()
        db.refresh(job)

    return job


def _tick() -> None:
    """Runs every 60 seconds on APScheduler's own background thread inside
    THIS web process (see start_scheduler) - there is no separate worker
    process. Opens its own short-lived DB session (the request-scoped one
    from database.get_db only exists for the lifetime of an HTTP request,
    which this is not), finds every dashboard whose schedule is due right
    now, and refreshes each one in turn, one at a time (never in parallel -
    this app has no need for that at the volume a single small SaaS
    product's dashboards run at, and it keeps the log/JobRun ordering
    simple and easy to reason about)."""
    db = SessionLocal()
    try:
        now = datetime.utcnow()
        due = (
            db.query(models.Dashboard)
            .filter(models.Dashboard.layout_version == 2)
            .filter(models.Dashboard.refresh_interval.isnot(None))
            .filter(models.Dashboard.next_refresh_at.isnot(None))
            .filter(models.Dashboard.next_refresh_at <= now)
            .all()
        )
        for dashboard in due:
            try:
                refresh_dashboard(db, dashboard, job_type="scheduled_refresh")
            except Exception as e:
                # refresh_dashboard already catches and records everything
                # it can into the JobRun row itself - this outer catch only
                # guards against something going wrong before/after that
                # (e.g. the commit that creates the JobRun row itself
                # failing), so one dashboard's bad luck can never stop the
                # rest of this tick's due dashboards from being checked.
                logger.warning("[scheduler] tick failed for dashboard %s: %s", dashboard.id, e)
    finally:
        db.close()


_scheduler: Optional[BackgroundScheduler] = None


def start_scheduler() -> None:
    """Called once from main.py's startup event. Idempotent via the
    module-level _scheduler singleton, so a startup event that somehow
    fires more than once in the same process (or a test harness importing
    main more than once) never ends up with two overlapping schedulers
    both ticking against the same database."""
    global _scheduler
    if _scheduler is not None:
        return
    _scheduler = BackgroundScheduler(daemon=True)
    # max_instances=1: if a tick somehow takes longer than 60 seconds (a
    # slow warehouse query, several due dashboards at once), the next
    # scheduled tick is skipped rather than piling up a second one running
    # concurrently against the same rows.
    _scheduler.add_job(_tick, "interval", seconds=60, id="gd360_dashboard_refresh_tick", max_instances=1)
    _scheduler.start()
    logger.info("[scheduler] started - checking for due dashboard refreshes every 60 seconds.")
