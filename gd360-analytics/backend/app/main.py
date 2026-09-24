"""
GD360 Analytics API entrypoint.
"""
from fastapi import FastAPI, Request
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

app.include_router(auth.router)
app.include_router(datasources.router)
app.include_router(chat.router)
app.include_router(dashboards.router)
app.include_router(dashboard_builder.router)
app.include_router(dashboard_builder.public_router)
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
