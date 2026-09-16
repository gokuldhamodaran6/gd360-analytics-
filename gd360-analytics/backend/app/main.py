"""
GD360 Analytics API entrypoint.
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .database import init_db
from .routers import auth, datasources, chat, dashboards, admin, conversations

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

app.include_router(auth.router)
app.include_router(datasources.router)
app.include_router(chat.router)
app.include_router(dashboards.router)
app.include_router(admin.router)
app.include_router(conversations.router)


@app.on_event("startup")
def on_startup():
    init_db()


@app.get("/health")
def health():
    return {"status": "ok", "app": settings.APP_NAME}
