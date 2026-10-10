"""
Phase 4 (2026-09-28, "Replacing the Data Team" roadmap - "A/B test design,
assignment, and tracking"): design an experiment, get a public assign/
convert URL pair, and watch live side-by-side results - the first phase of
this roadmap that runs a real experiment itself, rather than only analyzing
one already run somewhere else. See models.Experiment / models.
ExperimentAssignment's own docstrings for the full data-model design.

Two routers, the exact same split routers/dashboard_builder.py already uses:
  - `router` (prefix /experiments): authenticated CRUD + live stats for the
    founder's own GD360 account - create an experiment (already "running"
    the moment it's created - see models.Experiment's own docstring for why
    there is no separate "draft"/"launch" step), list/view it with computed
    significance stats inline, stop it, delete it.
  - `public_router` (prefix /public/experiments): unauthenticated assign/
    convert endpoints. Registered in main.py exactly like
    dashboard_builder.public_router - the existing public_cors_reflection
    middleware there already opens every /public/* path to any origin, so
    nothing in main.py's CORS handling needs to change for this to work
    cross-origin from the founder's own external website.

Public assign/convert security model - this is genuinely DIFFERENT from the
streaming datasource's webhook ingestion endpoint (routers/datasources.py
connect_streaming/ingest_webhook_event), which authenticates with a
server-to-server bearer secret sent in a header. That works there because
the caller is another BACKEND system, which can keep a secret. Here, the
caller is a VISITOR'S BROWSER running client-side JavaScript on the
founder's own website, deciding which variant to render before the page
even renders - and client-side JS in a stranger's browser can never keep a
secret (anyone can view-source it), so a bearer-secret header is the wrong
model entirely for this endpoint.

Instead:
  - Experiment.public_key (a secrets.token_urlsafe(24) random string,
    generated once at creation, stored in plaintext - see that model's own
    docstring for why plaintext is correct here, not an oversight) lives
    directly in the URL path. Its only job is making these endpoints
    non-enumerable to a stranger who doesn't already have the exact link a
    founder pasted into their own site - never confidentiality, which is
    impossible for a client-embeddable snippet in the first place.
  - An unknown public_key always 404s (never 401/403) - matching
    dashboard_builder.py's own public_router "not available" info-non-leak
    convention (see verify_private_dashboard_access there): a stranger
    should not be able to tell "no such experiment" apart from anything
    else.
  - A public_key that resolves to a real experiment whose status isn't
    "running" 400s instead - the id itself is already confirmed valid at
    that point, so 400 (not 404) is the honest answer, and it's what stops
    a stopped/ended experiment from accumulating any further data.
"""
import hashlib
import time
from collections import defaultdict, deque
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import or_, func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .. import models, schemas
from ..config import get_settings
from ..database import get_db
from ..deps import get_current_user
from ..services import workspace_access
from ..services.experiments_stats import compute_experiment_stats

router = APIRouter(prefix="/experiments", tags=["experiments"])

# Separate, unauthenticated router - the assign/convert endpoints must be
# callable by a visitor's browser that has never signed into GD360 at all
# and never will. Registered separately in main.py, same as
# dashboard_builder.public_router.
public_router = APIRouter(prefix="/public/experiments", tags=["public-experiments"])

settings = get_settings()

# Copied verbatim from routers/dashboard_builder.py's own private copy (see
# that file's own comment on it) - this codebase's convention is for each
# router file that needs a simple in-process rate limiter to keep its own
# copy rather than share one (confirmed: routers/auth.py, dashboard_builder.py,
# and chat.py each already do this independently).
_call_log: dict[str, deque] = defaultdict(deque)


def _check_rate_limit(key: str, limit: int, window_seconds: int = 60):
    now = time.time()
    log = _call_log[key]
    while log and now - log[0] > window_seconds:
        log.popleft()
    if len(log) >= limit:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many attempts. Please wait a minute and try again.")
    log.append(now)


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


# ---------- Access control ----------
# Modeled exactly on services/workspace_access.py's can_access_datasource/
# can_edit_datasource - same owner-or-workspace-member logic - but written
# fresh for Experiment rather than importing those DataSource-specific
# helpers, since Experiment is its own brand-new entity type. Every
# Experiment this phase's router ever creates has workspace_id=None (see
# models.Experiment's own docstring - there is no "share to a workspace"
# endpoint in this phase), so in practice these two always reduce to a
# plain owner_id check today; they're written to match the real three-tier
# shape everywhere else in this app already uses, so nothing has to change
# here if that workspace-assignment feature is ever built later.
_EDIT_ROLES = {"owner", "admin", "member"}


def _can_view_experiment(db: Session, exp: models.Experiment, user: models.User) -> bool:
    if exp.owner_id == user.id:
        return True
    if not exp.workspace_id:
        return False
    return exp.workspace_id in workspace_access.member_workspace_ids(db, user.id)


def _can_edit_experiment(db: Session, exp: models.Experiment, user: models.User) -> bool:
    if exp.owner_id == user.id:
        return True
    if not exp.workspace_id:
        return False
    return workspace_access.member_role(db, user.id, exp.workspace_id) in _EDIT_ROLES


def _get_viewable_experiment(db: Session, user: models.User, experiment_id: str) -> models.Experiment:
    exp = db.query(models.Experiment).filter(models.Experiment.id == experiment_id).first()
    if not exp or not _can_view_experiment(db, exp, user):
        raise HTTPException(404, "Experiment not found.")
    return exp


# ---------- URL building ----------
# Same pattern routers/datasources.py's connect_streaming already uses for
# its own "here's your webhook URL" response (_webhook_url there) - a plain
# f-string off settings.BACKEND_BASE_URL, this app's own public base URL,
# rather than request.url_for (which would reflect whatever host the
# AUTHENTICATED create call happened to be made through, not necessarily
# this backend's real public address).
def _assign_url(public_key: str) -> str:
    return f"{settings.BACKEND_BASE_URL}/public/experiments/{public_key}/assign"


def _convert_url(public_key: str) -> str:
    return f"{settings.BACKEND_BASE_URL}/public/experiments/{public_key}/convert"


# ---------- Stats + response assembly ----------
def _experiment_stats(db: Session, exp: models.Experiment) -> schemas.ExperimentStatsOut:
    counts = {"a": {"assigned": 0, "converted": 0}, "b": {"assigned": 0, "converted": 0}}
    rows = (
        db.query(
            models.ExperimentAssignment.variant,
            func.count(models.ExperimentAssignment.id),
            func.count(models.ExperimentAssignment.converted_at),
        )
        .filter(models.ExperimentAssignment.experiment_id == exp.id)
        .group_by(models.ExperimentAssignment.variant)
        .all()
    )
    for variant, assigned, converted in rows:
        if variant in counts:
            counts[variant] = {"assigned": assigned, "converted": converted}

    stats = compute_experiment_stats(
        n_a=counts["a"]["assigned"], conv_a=counts["a"]["converted"],
        n_b=counts["b"]["assigned"], conv_b=counts["b"]["converted"],
    )

    def _rate(assigned: int, converted: int):
        return (converted / assigned) if assigned else None

    return schemas.ExperimentStatsOut(
        variant_a=schemas.ExperimentVariantStats(
            variant_name=exp.variant_a_name,
            assigned_count=counts["a"]["assigned"],
            converted_count=counts["a"]["converted"],
            conversion_rate=_rate(counts["a"]["assigned"], counts["a"]["converted"]),
        ),
        variant_b=schemas.ExperimentVariantStats(
            variant_name=exp.variant_b_name,
            assigned_count=counts["b"]["assigned"],
            converted_count=counts["b"]["converted"],
            conversion_rate=_rate(counts["b"]["assigned"], counts["b"]["converted"]),
        ),
        p_value=stats["p_value"],
        is_significant=stats["is_significant"],
        insufficient_data=stats["insufficient_data"],
    )


def _experiment_out(db: Session, exp: models.Experiment, user: models.User) -> schemas.ExperimentOut:
    return schemas.ExperimentOut(
        id=exp.id,
        name=exp.name,
        metric_name=exp.metric_name,
        variant_a_name=exp.variant_a_name,
        variant_b_name=exp.variant_b_name,
        status=exp.status,
        public_key=exp.public_key,
        assign_url=_assign_url(exp.public_key),
        convert_url=_convert_url(exp.public_key),
        created_at=exp.created_at,
        started_at=exp.started_at,
        stopped_at=exp.stopped_at,
        stats=_experiment_stats(db, exp),
        can_edit=_can_edit_experiment(db, exp, user),
    )


# ---------- Authenticated endpoints ----------
@router.post("", response_model=schemas.ExperimentOut)
def create_experiment(
    payload: schemas.CreateExperimentRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """The wizard's "Launch experiment" step - creates the row ALREADY
    status="running", started_at=now. There is no separate "launch" call:
    the roadmap's wizard is metric -> variants -> launch, with no "save as
    draft" step in between, so a created Experiment is a live one from its
    very first moment (see models.Experiment's own docstring)."""
    name = payload.name.strip()
    metric_name = payload.metric_name.strip()
    if not name:
        raise HTTPException(400, "Experiment name is required.")
    if not metric_name:
        raise HTTPException(400, "Metric name is required.")
    variant_a_name = (payload.variant_a_name or "").strip() or "Control"
    variant_b_name = (payload.variant_b_name or "").strip() or "Treatment"

    now = datetime.utcnow()
    exp = models.Experiment(
        owner_id=user.id,
        workspace_id=None,
        name=name,
        metric_name=metric_name,
        variant_a_name=variant_a_name,
        variant_b_name=variant_b_name,
        status="running",
        created_at=now,
        started_at=now,
    )
    db.add(exp)
    db.commit()
    db.refresh(exp)
    return _experiment_out(db, exp, user)


@router.get("", response_model=list[schemas.ExperimentOut])
def list_experiments(db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    """Every experiment this person can at least view - their own, plus any
    shared into a workspace they belong to (see _can_view_experiment's own
    comment for why that second half never actually matches anything in
    this phase yet) - newest first, each with its live computed stats
    inline, since the roadmap's UI wants both KPI cards visible right on
    the list rather than gated behind a second click per experiment."""
    ws_ids = workspace_access.member_workspace_ids(db, user.id)
    q = db.query(models.Experiment)
    if ws_ids:
        q = q.filter(or_(models.Experiment.owner_id == user.id, models.Experiment.workspace_id.in_(ws_ids)))
    else:
        q = q.filter(models.Experiment.owner_id == user.id)
    experiments = q.order_by(models.Experiment.created_at.desc()).all()
    return [_experiment_out(db, exp, user) for exp in experiments]


@router.get("/{experiment_id}", response_model=schemas.ExperimentOut)
def get_experiment(
    experiment_id: str,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    exp = _get_viewable_experiment(db, user, experiment_id)
    return _experiment_out(db, exp, user)


@router.patch("/{experiment_id}/status", response_model=schemas.ExperimentOut)
def set_experiment_status(
    experiment_id: str,
    payload: schemas.SetExperimentStatusRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Ends data collection on a running experiment - the ONLY status
    transition this phase exposes (see schemas.SetExperimentStatusRequest's
    own comment: the request body's Literal["stopped"] type already makes
    any other value fail before this function ever runs). Idempotent:
    stopping an already-stopped experiment is a harmless no-op that still
    returns 200 with the current state, rather than erroring on a double
    click."""
    exp = _get_viewable_experiment(db, user, experiment_id)
    if not _can_edit_experiment(db, exp, user):
        raise HTTPException(403, "You have view-only access to this experiment.")

    if exp.status != "stopped":
        exp.status = "stopped"
        exp.stopped_at = datetime.utcnow()
        db.commit()
        db.refresh(exp)
    return _experiment_out(db, exp, user)


@router.delete("/{experiment_id}", status_code=204)
def delete_experiment(
    experiment_id: str,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Owner-only - mirrors routers/dashboards.py delete_dashboard's own
    precedent of a narrower tier than plain "editable" for permanently
    destroying a row (there, "creator or the workspace's owner role"; here,
    simply the experiment's own owner_id, since no workspace-sharing
    endpoint for an Experiment exists in this phase at all - see
    _can_edit_experiment's own comment). Cascade-deletes every
    ExperimentAssignment row through the relationship's own
    cascade="all, delete-orphan"."""
    exp = _get_viewable_experiment(db, user, experiment_id)
    if exp.owner_id != user.id:
        raise HTTPException(403, "Only the experiment's creator can delete it.")
    db.delete(exp)
    db.commit()
    return None


# ---------- Public endpoints (no auth at all - see this module's own
# docstring for the full security model) ----------
def _get_running_experiment_by_public_key(db: Session, public_key: str) -> models.Experiment:
    exp = db.query(models.Experiment).filter(models.Experiment.public_key == public_key).first()
    if not exp:
        raise HTTPException(404, "This experiment isn't available.")
    return exp


@public_router.get("/{public_key}/assign", response_model=schemas.PublicAssignOut)
def assign_variant(
    public_key: str,
    subject_id: str,
    request: Request,
    db: Session = Depends(get_db),
):
    """Called from a visitor's browser, before the founder's page decides
    which variant to render. Deterministic + sticky: the variant is a
    sha256 hash of f"{experiment_id}:{subject_id}" mod 2, so the exact same
    subject_id always hashes to the exact same variant even before any row
    exists for it - the DB row (created on first call, read back on every
    later one) is what actually makes repeat calls fast and is the
    long-term source of truth, but even a brand-new never-seen-before
    subject_id would independently re-derive the identical answer if the
    row were ever lost."""
    if not subject_id or len(subject_id) > 200:
        raise HTTPException(400, "subject_id is required and must be at most 200 characters.")

    # Rate limits here are sized very differently from dashboard_builder.py's
    # verify_private_dashboard_access (20/min per IP) - that endpoint is a
    # password-guessing surface where one real person should only ever need
    # a handful of tries. This one is the opposite kind of traffic: EVERY
    # distinct real visitor to the founder's own site calls this once per
    # page load, and many genuine visitors routinely share one apparent IP
    # (office wifi, a campus network, a mobile carrier's NAT, a CDN/proxy in
    # front of the site) - a tight per-IP ceiling here would start silently
    # rejecting real traffic the moment an experiment succeeds and a site
    # gets real concurrent visitors, which is the one time this feature
    # matters most. These limits exist only to bound a genuinely runaway
    # script hammering one experiment, not to gate normal usage.
    ip = _client_ip(request)
    _check_rate_limit(f"exp-assign:ip:{ip}", limit=600)
    _check_rate_limit(f"exp-assign:key:{public_key}", limit=1200)

    exp = _get_running_experiment_by_public_key(db, public_key)
    if exp.status != "running":
        raise HTTPException(400, "This experiment is no longer running.")

    existing = (
        db.query(models.ExperimentAssignment)
        .filter(
            models.ExperimentAssignment.experiment_id == exp.id,
            models.ExperimentAssignment.subject_id == subject_id,
        )
        .first()
    )
    if existing:
        variant_name = exp.variant_a_name if existing.variant == "a" else exp.variant_b_name
        return schemas.PublicAssignOut(variant=existing.variant, variant_name=variant_name)

    digest = hashlib.sha256(f"{exp.id}:{subject_id}".encode()).hexdigest()
    variant = "a" if int(digest, 16) % 2 == 0 else "b"

    assignment = models.ExperimentAssignment(experiment_id=exp.id, subject_id=subject_id, variant=variant)
    db.add(assignment)
    try:
        db.commit()
    except IntegrityError:
        # A concurrent duplicate insert for the same (experiment_id,
        # subject_id) raced this one and won - roll back and re-read the
        # now-existing row instead of erroring, so two near-simultaneous
        # first-ever calls for the same visitor both get a consistent
        # answer. The re-queried row's own `variant` is the source of
        # truth from here on (it will match the hash above today, but
        # this stays correct even if a future feature ever let variant
        # names/assignments be edited after the fact).
        db.rollback()
        assignment = (
            db.query(models.ExperimentAssignment)
            .filter(
                models.ExperimentAssignment.experiment_id == exp.id,
                models.ExperimentAssignment.subject_id == subject_id,
            )
            .first()
        )
        variant = assignment.variant

    variant_name = exp.variant_a_name if variant == "a" else exp.variant_b_name
    return schemas.PublicAssignOut(variant=variant, variant_name=variant_name)


@public_router.post("/{public_key}/convert")
def convert_subject(
    public_key: str,
    payload: schemas.PublicConvertRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    """Records a conversion for a visitor who was already assigned a
    variant. Never auto-creates an assignment here - a conversion must
    always follow a real prior assign call, or someone could spam
    conversions with made-up subject_ids and corrupt the results.
    Idempotent: converting an already-converted subject is a harmless,
    silent no-op that still returns 200 - a duplicate pixel fire on the
    founder's own site must never error or double-count (see
    models.ExperimentAssignment's own docstring)."""
    subject_id = (payload.subject_id or "").strip()
    if not subject_id or len(subject_id) > 200:
        raise HTTPException(400, "subject_id is required and must be at most 200 characters.")

    # Same reasoning as assign_variant's own rate limits above - a
    # conversion fires once per converting real visitor, so this needs the
    # same generous headroom, not the tight per-IP ceiling that makes sense
    # for a password-guessing surface elsewhere in this app.
    ip = _client_ip(request)
    _check_rate_limit(f"exp-convert:ip:{ip}", limit=600)
    _check_rate_limit(f"exp-convert:key:{public_key}", limit=1200)

    exp = _get_running_experiment_by_public_key(db, public_key)
    if exp.status != "running":
        raise HTTPException(400, "This experiment is no longer running.")

    assignment = (
        db.query(models.ExperimentAssignment)
        .filter(
            models.ExperimentAssignment.experiment_id == exp.id,
            models.ExperimentAssignment.subject_id == subject_id,
        )
        .first()
    )
    if not assignment:
        raise HTTPException(400, "This visitor hasn't been assigned a variant yet.")

    if assignment.converted_at is None:
        assignment.converted_at = datetime.utcnow()
        db.commit()

    return {"success": True}
