"""
GD360 Analytics API entrypoint.
"""
from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .database import init_db
from .routers import (
    auth, datasources, chat, dashboards, dashboard_builder, admin, conversations, goku,
    connections, workspaces, folders,
)

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


app.include_router(auth.router)
app.include_router(datasources.router)
app.include_router(chat.router)
app.include_router(dashboards.router)
app.include_router(dashboard_builder.router)
app.include_router(dashboard_builder.public_router)
app.include_router(dashboard_builder.public_domains_router)
app.include_router(admin.router)
app.include_router(conversations.router)
app.include_router(goku.router)
app.include_router(connections.router)
app.include_router(workspaces.router)
app.include_router(folders.router)


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


@app.get("/health")
def health():
    return {"status": "ok", "app": settings.APP_NAME}
