"""
Central configuration for GD360 Analytics backend.

All secrets are read from environment variables so nothing sensitive is
ever committed to source control. See backend/.env.example for the full
list of variables you need to set.
"""
from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # --- App ---
    APP_NAME: str = "GD360 Analytics"
    ENVIRONMENT: str = "development"
    FRONTEND_ORIGIN: str = "http://localhost:5173"

    # --- Admin ---
    # Comma-separated list of email addresses allowed to view the /admin
    # dashboard (user count, prompt usage, etc). Change or extend this via
    # the ADMIN_EMAILS environment variable, no code change needed.
    ADMIN_EMAILS: str = "gokuldhamodaran6@gmail.com,gokuldhamodaranb@gmail.com"

    # --- App database (stores users, datasource metadata, chat history) ---
    # Example (Supabase/Postgres): postgresql+psycopg2://user:pass@host:5432/postgres
    DATABASE_URL: str = "sqlite:///./gd360.db"

    # --- Auth ---
    JWT_SECRET: str = "change-me-please-in-production"
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24 * 7  # 7 days

    # --- Credential encryption (for storing customer DB passwords at rest) ---
    # Generate with: python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
    CREDENTIAL_ENCRYPTION_KEY: str = ""

    # --- AI provider ---
    # Free-tier default: Groq (https://console.groq.com) - generous free rate limits.
    AI_PROVIDER: str = "groq"  # "groq" | "openai" | "anthropic"
    GROQ_API_KEY: str = ""
    GROQ_MODEL: str = "openai/gpt-oss-20b"
    OPENAI_API_KEY: str = ""
    OPENAI_MODEL: str = "gpt-4o-mini"
    ANTHROPIC_API_KEY: str = ""
    ANTHROPIC_MODEL: str = "claude-sonnet-4-5"

    # --- Safety limits (generous defaults; raise/lower as you like) ---
    MAX_ROWS_LOADED_PER_QUERY: int = 200_000
    SANDBOX_TIMEOUT_SECONDS: int = 20
    MAX_UPLOAD_MB: int = 50
    RATE_LIMIT_PER_MINUTE: int = 30  # per-user AI calls/minute, protects the free AI tier


@lru_cache
def get_settings() -> Settings:
    return Settings()
