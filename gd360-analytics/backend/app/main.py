"""
GD360 Analytics API entrypoint.
"""
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .database import init_db
from .routers import auth, datasources, chat, dashboards, admin, conversations, goku, connections, workspaces

settings = get_settings()

app = FastAPI(
    title=settings.APP_NAME,
    description="AI-driven, no-code 360 data analytics platform.",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.FRONTEND_ORIGIN, "http://localhost:5173", "http://localhost:3000"],
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
app.include_router(admin.router)
app.include_router(conversations.router)
app.include_router(goku.router)
app.include_router(connections.router)
app.include_router(workspaces.router)


@app.on_event("startup")
def on_startup():
    init_db()


@app.get("/health")
def health():
    return {"status": "ok", "app": settings.APP_NAME}
