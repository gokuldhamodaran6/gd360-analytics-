"""
GD360 Analytics API entrypoint.
"""
from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .database import init_db
from .routers import (
    auth, datasources, chat, dashboards, dashboard_builder, dashboard_comments, admin, conversations, goku,
    connections, workspaces, folders, jobs, experiments, quality_checks, governance,
    data_access_rules, ml_models, metric_definitions, transforms, pipelines, projects, apps, automations, ml_studio,
    spaces, site, admin_v2, admin_ops, admin_biz, inapp, guided, initiatives, gtm, gtm_public,
    ops, trust, domains,
)
from .services.scheduler import start_scheduler

settings = get_settings()

app = FastAPI(
    title=settings.APP_NAME,
    description="AI-driven, no-code 360 data analytics platform.",
    version="0.1.0",
)

# 2026-09-24 (full-app security round): in production this is now ONLY the
# real frontend origin - the two localhost dev origins used to be allowed
# unconditionally in every environment, which meant a malicious site
# running on a person's own machine at one of those exact ports could have
# made authenticated cross-origin requests against the live production
# API. Still allowed outside production (ENVIRONMENT != "production") so
# local development against a deployed backend keeps working unchanged.
# (/public/* is carved out of this strict list below by public_cors_reflection,
# not by adding to it - see that middleware's own comment for why.)
_cors_origins = [settings.FRONTEND_ORIGIN]
if settings.ENVIRONMENT != "production":
    _cors_origins += ["http://localhost:5173", "http://localhost:3000"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Baseline hardening headers on every response. These do not replace proper
# auth/authorization checks (which every route already has) - they reduce
# the blast radius of common browser-side attacks like clickjacking and
# content-type sniffing.
@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    if settings.ENVIRONMENT != "development":
        response.headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains"
    return response


# 2026-09-24 (Phase 4, white-label custom domains): the CORSMiddleware
# above is a strict allow-list of this app's own known frontend origin(s) -
# correct for every authenticated route, but it would reject the SPA's own
# API calls to /public/* when the SPA is loaded through a CUSTOMER's
# arbitrary custom domain, since that origin can never be known in advance
# and added to a fixed allow-list.
#
# /public/* (both public_router and public_domains_router in
# routers/dashboard_builder.py) is safe to open to any origin: every
# endpoint under it is already unauthenticated by design - no GD360 login,
# no cookies at all. The private-dashboard gate uses a bearer-style
# X-Dashboard-Access-Token HEADER rather than a cookie (see
# dashboard_builder.py's own module docstring), so there is no session to
# leak cross-site, and reflecting the caller's Origin here grants no more
# access than any of these endpoints already hand an anonymous caller with
# the right slug/hostname (+ email/password for a private share).
#
# Registered as a plain @app.middleware("http") function AFTER
# app.add_middleware(CORSMiddleware, ...) and the security_headers
# middleware above - Starlette builds its middleware stack so the LAST
# middleware ADDED ends up OUTERMOST (it sees every request first and every
# response last, confirmed empirically against this exact app with
# FastAPI's TestClient - an app.add_middleware() call placed before an
# @app.middleware("http") function is INNER to it, not outer, despite
# reading top-to-bottom the other way). Being outermost is what lets this
# middleware answer a /public/* OPTIONS preflight itself, before
# CORSMiddleware's own stricter preflight handling (which 400s an origin
# outside _cors_origins above with "Disallowed CORS origin") ever sees it.
# For a real (non-OPTIONS) /public/* request, it lets the request proceed
# through the normal stack (including CORSMiddleware and security_headers,
# neither of which touch a /public/* request from an origin outside the
# allow-list) and then adds the one header a browser actually checks -
# Access-Control-Allow-Origin - onto the real response. Every other path is
# completely untouched: call_next runs the normal stack and the response
# goes back exactly as it always did, unchanged from before this round.
_PUBLIC_PATH_PREFIX = "/public/"


@app.middleware("http")
async def public_cors_reflection(request: Request, call_next):
    origin = request.headers.get("origin")
    is_public_path = request.url.path.startswith(_PUBLIC_PATH_PREFIX)

    if is_public_path and origin and request.method == "OPTIONS":
        requested_headers = request.headers.get("access-control-request-headers", "*")
        return Response(
            status_code=200,
            headers={
                "Access-Control-Allow-Origin": origin,
                "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
                "Access-Control-Allow-Headers": requested_headers,
                "Access-Control-Max-Age": "600",
                "Vary": "Origin",
            },
        )

    response = await call_next(request)
    if is_public_path and origin:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers.setdefault("Vary", "Origin")
    return response


# 2026-10-10 (Mission Control): every request carries who is asking and which
# feature it belongs to, so model calls can be metered (services/ai_meter.py),
# and a feature an admin has paused answers 503 instead of running.
@app.middleware("http")
async def ai_context_and_kill_switches(request: Request, call_next):
    from .services import ai_meter
    from .security import decode_access_token
    path = request.url.path
    paused = ai_meter.killed_feature(path, request.method)
    if paused:
        from fastapi.responses import JSONResponse
        resp = JSONResponse(status_code=503, content={"detail": f"{paused} is paused for a few minutes while we fix something. Please try again shortly."})
        origin = request.headers.get("origin")
        if origin and origin in _cors_origins:  # this middleware sits outside CORSMiddleware
            resp.headers["Access-Control-Allow-Origin"] = origin
            resp.headers["Access-Control-Allow-Credentials"] = "true"
            resp.headers["Vary"] = "Origin"
        return resp
    user_id = None
    auth_header = request.headers.get("authorization", "")
    if auth_header.lower().startswith("bearer "):
        user_id = decode_access_token(auth_header[7:].strip())
    token = ai_meter.set_context(user_id, ai_meter.feature_for_path(path))
    try:
        return await call_next(request)
    finally:
        ai_meter.reset_context(token)


# 2026-10-10 (round 19, company domains): a company's own address
# (data.acmeretail.com) runs this same SPA, which signs viewers in with their
# GD360 account and opens dashboards through /viewer/*. Those origins can't
# be in the fixed list above, so - like /public/* - they are answered here,
# outermost, but ONLY for an origin that is a LIVE company domain and only
# for the sign-in endpoints and /viewer/*. Tokens travel as a bearer header
# (no cookies), so reflecting the origin grants nothing a viewer's own token
# doesn't already. /viewer/site (which site is this address?) answers any
# origin: it is what a not-yet-known address asks first.
import re as _re  # noqa: E402
import time as _time  # noqa: E402
from urllib.parse import urlparse as _urlparse  # noqa: E402

_DOMAIN_AUTH_PATHS = _re.compile(
    r"^/auth/(login|login/mfa|register|captcha|me|code/request|code/verify|verify-email/request|verify-email/confirm)$"
)
_LIVE_HOSTS: dict = {"at": 0.0, "hosts": set()}


def _live_company_hosts() -> set:
    if _time.time() - _LIVE_HOSTS["at"] > 30:
        from .database import SessionLocal
        from . import models as _models
        db = SessionLocal()
        try:
            _LIVE_HOSTS["hosts"] = {h for (h,) in db.query(_models.WorkspaceDomain.hostname)
                                    .filter(_models.WorkspaceDomain.status == "live").all()}
            _LIVE_HOSTS["at"] = _time.time()
        except Exception as e:  # noqa: BLE001
            print(f"[main] company domain list unavailable: {e}")
        finally:
            db.close()
    return _LIVE_HOSTS["hosts"]


@app.middleware("http")
async def company_domain_cors(request: Request, call_next):
    origin = request.headers.get("origin")
    path = request.url.path
    allowed = False
    if origin and origin not in _cors_origins and (path.startswith("/viewer/") or _DOMAIN_AUTH_PATHS.match(path)):
        if path == "/viewer/site":
            allowed = True
        else:
            host = (_urlparse(origin).hostname or "").lower()
            allowed = bool(host) and host in _live_company_hosts()
    if allowed and request.method == "OPTIONS":
        return Response(status_code=200, headers={
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": request.headers.get("access-control-request-headers", "*"),
            "Access-Control-Max-Age": "600", "Vary": "Origin",
        })
    response = await call_next(request)
    if allowed:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers.setdefault("Vary", "Origin")
    return response


app.include_router(auth.router)
app.include_router(datasources.router)
app.include_router(chat.router)
app.include_router(dashboards.router)
app.include_router(dashboard_builder.router)
app.include_router(dashboard_builder.public_router)
app.include_router(dashboard_builder.public_domains_router)
# 2026-10-07 (analyst canvas round): block/page/dashboard comment threads -
# authenticated only, see routers/dashboard_comments.py.
app.include_router(dashboard_comments.router)
app.include_router(admin.router)
app.include_router(conversations.router)
app.include_router(goku.router)
app.include_router(connections.router)
app.include_router(workspaces.router)
app.include_router(folders.router)
app.include_router(jobs.router)
app.include_router(experiments.router)
app.include_router(experiments.public_router)
# Phase 5, Batch A (2026-09-28, data governance & quality): quality_checks
# nests under /datasources/{id}/quality-rules/quality-status (see that
# file's own module docstring); governance nests under both
# /datasources/{id}/mark-reviewed and /workspaces/{id}/audit-log|governance-
# overview - two small, focused routers rather than growing datasources.py/
# workspaces.py further.
app.include_router(quality_checks.router)
app.include_router(governance.router)
# Phase 5, Batch B (data governance & quality - row/column permissions):
# nests under /datasources/{id}/access-rules, owner-only - see that
# router's own module docstring for why this is stricter than the usual
# "editable" tier every other write on a data source's own row uses.
app.include_router(data_access_rules.router)
# 2026-09-28 (ML Models round): the real ML feature - train/predict/score
# with a real scikit-learn model.
app.include_router(ml_models.router)
app.include_router(metric_definitions.router)
# 2026-09-30 (transformation layer v1): saved, reusable data-shaping
# pipelines - see models.DataTransform's own docstring.
app.include_router(transforms.router)
# 2026-09-30 (orchestration v1): named, saved, linear chains of a few
# whitelisted actions (refresh an API source, rebuild a dashboard, re-run
# quality checks), run strictly in order, on demand or on a schedule - see
# models.Pipeline's own docstring.
app.include_router(pipelines.router)
# 2026-10-08 (round 11): multi-source Projects (services/project_engine) and
# the synced app sources they can draw on (Shopify, GA4, Meta Ads, Google Ads).
app.include_router(projects.router)
# 2026-10-10: Guided Analysis - the same engine, one step at a time.
app.include_router(guided.router)
app.include_router(apps.router)
# 2026-10-08 (round 12): Automations - WHEN -> DO -> TELL (services/automations.py).
app.include_router(automations.router)
# 2026-10-08 (round 13): ML Studio - a model from a goal in words (services/ml_studio.py).
app.include_router(ml_studio.router)
# 2026-10-09 (round 15): Spaces - named groups of sources (services/spaces.py).
app.include_router(spaces.router)
# 2026-10-09: the public website (Enterprise demo requests)
app.include_router(site.router)
# 2026-10-10: Mission Control (admin portal v2) and the in-app announcements/flags it publishes.
app.include_router(admin_v2.router)
app.include_router(admin_ops.router)
app.include_router(admin_biz.router)
app.include_router(inapp.router)
# 2026-10-10: Initiatives + the account-based marketing centre (+ public pages/tracking)
app.include_router(initiatives.router)
app.include_router(gtm.router)
app.include_router(gtm_public.router)
# 2026-10-10 (round 19): the Automations home, the Trust Center and company domains.
app.include_router(ops.router)
app.include_router(trust.router)
app.include_router(domains.router)
app.include_router(domains.viewer_router)
# 2026-09-30 (Gokul's own bug report - Governance/Jobs redesign + Pipelines/
# Catalog removal round): the standalone /catalog router is gone - Gokul's
# own words were that it duplicated the Projects filter and Data Sources
# page and "leads to confusion." Its one real, non-redundant capability
# (editing a data source's short description) was never part of catalog.py
# itself - it already lived on datasources.router (PATCH
# /datasources/{id}/description, see that router's own endpoint) - so
# nothing needed to move here; only the standalone search UI (pages/
# Catalog.tsx) and this registration are gone. The standalone /pipelines
# page is also gone from the sidebar (its real, unique capability - named,
# multi-step chains, not just one dashboard's schedule - now lives in the
# Jobs page's own "Chains" tab, see pages/Jobs.tsx), but this router stays
# registered exactly as it was: Jobs' Chains tab calls the same
# /pipelines/* endpoints unchanged.


@app.on_event("startup")
def on_startup():
    # 2026-09-24 (full-app security round): refuses to even start in
    # production against the insecure default JWT_SECRET, rather than
    # silently signing every login token with a value that ships in this
    # repo's own config.py - see security.py/deps.py for how tokens are
    # signed/verified. Outside production this stays a no-op so local
    # development never needs a real secret configured.
    if settings.ENVIRONMENT == "production" and settings.JWT_SECRET == "change-me-please-in-production":
        raise RuntimeError(
            "JWT_SECRET is still set to its insecure default. Set a real, random JWT_SECRET "
            "environment variable before starting in production."
        )
    init_db()
    # 2026-09-28 (scheduled auto-refresh round): starts the in-process
    # 60-second dashboard-refresh loop - see services/scheduler.py's own
    # module docstring for exactly what this does and its one real
    # limitation (it only runs while this web process is actually up; see
    # that file for the full explanation, worth reading before assuming
    # scheduled refreshes are as reliable as a real always-on worker).
    start_scheduler()
    # A project question whose background thread died with the previous
    # process can never finish: mark it, so its page says so.
    projects.recover_interrupted_runs()
    from .services.automations import recover_interrupted as recover_automation_runs
    recover_automation_runs()
    from .services.ml_studio import recover_interrupted as recover_ml_jobs
    recover_ml_jobs()


@app.get("/health")
def health():
    return {"status": "ok", "app": settings.APP_NAME}
