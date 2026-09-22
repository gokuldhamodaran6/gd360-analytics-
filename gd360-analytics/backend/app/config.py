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

    # --- Signup protection ---
    # A short one-digit addition question shown once at signup blocks
    # scripted/bot registrations, at no cost and with no third-party
    # service required.
    CAPTCHA_EXPIRE_MINUTES: int = 5

    # --- Auth security ---
    # A failed-login lockout slows down password-guessing bots without
    # permanently locking anyone out.
    LOGIN_LOCKOUT_ATTEMPTS: int = 6
    LOGIN_LOCKOUT_MINUTES: int = 15

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

    # --- Live connector OAuth (Google Sheets, Microsoft Excel/OneDrive) ---
    # This backend's own public base URL, used to build the OAuth redirect
    # URIs Google/Microsoft send the browser back to after the person signs
    # in and grants access (e.g. https://gd360-backend.onrender.com). Must
    # exactly match a redirect URI registered in that provider's own app
    # console/registration, or the provider will refuse the callback.
    BACKEND_BASE_URL: str = "http://localhost:8000"

    # Google Cloud Console -> APIs & Services -> Credentials -> OAuth client
    # ID (Web application). Redirect URI to register there:
    # {BACKEND_BASE_URL}/connections/google/callback. The connected Google
    # Cloud project also needs the Google Sheets API, Google Drive API, and
    # Google Picker API enabled (APIs & Services -> Library) - Picker API
    # powers the "choose a spreadsheet" step in the frontend (see
    # oauth_tokens.GOOGLE_SCOPES for why picking happens through Google's
    # own picker widget instead of our own search list). The OAuth consent
    # screen's scopes list needs .../auth/drive.file, not .../auth/drive.
    # readonly - a separate credential, a Picker API key (Credentials ->
    # Create Credentials -> API key, restricted to the Picker API and to
    # this app's own domain), is also needed, but only on the FRONTEND as
    # VITE_GOOGLE_PICKER_API_KEY - it never touches this backend.
    GOOGLE_OAUTH_CLIENT_ID: str = ""
    GOOGLE_OAUTH_CLIENT_SECRET: str = ""

    # Azure Portal -> App registrations -> New registration. Redirect URI to
    # register there (as a "Web" platform): {BACKEND_BASE_URL}/connections/
    # microsoft/callback. Needs the delegated Microsoft Graph permissions
    # Files.Read.All and offline_access (for a refresh token).
    MS_OAUTH_CLIENT_ID: str = ""
    MS_OAUTH_CLIENT_SECRET: str = ""
    # "common" accepts both personal Microsoft accounts and any work/school
    # (Azure AD) account - the right default unless a specific organization
    # ever needs to restrict this to its own tenant only.
    MS_OAUTH_TENANT: str = "common"

    # How long the signed "state" token that round-trips through the
    # provider's consent screen stays valid for - just long enough for a
    # person to actually look at and approve the consent screen.
    OAUTH_STATE_EXPIRE_MINUTES: int = 15

    # --- BigQuery pushdown (Enterprise Scale Roadmap, Phase 1) ---
    # The most data a single pushdown question is allowed to make
    # BigQuery scan, checked with a free BigQuery dry run before anything
    # is actually run or billed for (see connectors.BigQueryConnector.
    # run_pushdown_query). Default is generous for real use while staying
    # cheap: at BigQuery's on-demand $6.25/TiB list price, 5 GiB costs a
    # small fraction of a cent. Raise this once real usage patterns are
    # known, or make it configurable per customer later.
    BIGQUERY_MAX_BYTES_SCANNED_PER_QUERY: int = 5 * 1024 * 1024 * 1024  # 5 GiB

    # --- AI provider ---
    # Google Gemini (https://aistudio.google.com/apikey) is the app default -
    # its paid rate past the free allowance is a small fraction of a cent
    # per request, so it does not hit the hard daily wall Groq free tier
    # does. Groq is kept fully working below in case it is ever needed
    # again (e.g. switching back, or as a manual fallback).
    AI_PROVIDER: str = "gemini"  # "gemini" | "groq" | "openai" | "anthropic"
    GEMINI_API_KEY: str = ""
    GEMINI_MODEL: str = "gemini-3.8-flash"
    # Goku (the guided data-analytics helper on the Workspace page) talks to
    # this lighter, cheaper Gemini model instead of GEMINI_MODEL above -
    # Goku only ever writes plain guidance chat, never pandas code, so it
    # does not need the extra capability the main analysis chat does. Only
    # used when AI_PROVIDER=="gemini".
    GEMINI_GOKU_MODEL: str = "gemini-3.5-flash-lite"
    GROQ_API_KEY: str = ""
    GROQ_MODEL: str = "openai/gpt-oss-20b"
    # Goku talks to this model instead of GROQ_MODEL above, when
    # AI_PROVIDER=="groq" - see GEMINI_GOKU_MODEL above for why Goku uses a
    # separate, lighter model; on the Groq free tier this also happened to
    # give Goku its own separate daily token budget, since each Groq model
    # has its own. Only used when AI_PROVIDER=="groq".
    GOKU_MODEL: str = "openai/gpt-oss-120b"
    OPENAI_API_KEY: str = ""
    OPENAI_MODEL: str = "gpt-4o-mini"
    ANTHROPIC_API_KEY: str = ""
    ANTHROPIC_MODEL: str = "claude-sonnet-4-5"

    # --- Safety limits (generous defaults; raise/lower as you like) ---
    # 2026-09-22 incident: the backend runs on a single 512MB instance, and
    # this used to default to 200_000. A live-connector query (Postgres/
    # MySQL/SQL Server/Supabase/MongoDB/BigQuery) pulls this many rows into
    # one in-memory pandas DataFrame per request - for a realistically wide
    # table that alone can be several hundred MB, and a normal handful of
    # people loading their workspace at the same moment (each one firing a
    # preview + a chat load) was enough concurrent DataFrames in memory at
    # once to hit the container's memory ceiling, get OOM-killed, and
    # restart - which is what made every user's requests fail with 502s for
    # a few minutes, twice in a row, regardless of which datasource or
    # account they were on. Lowered to a much safer default; still generous
    # for real analysis on the vast majority of tables.
    MAX_ROWS_LOADED_PER_QUERY: int = 75_000
    # The Data tab's preview/export only ever displays a `limit`-sized page
    # (50-5000 rows, see datasources.py) of whatever gets loaded, so it has
    # no need to pull anywhere near MAX_ROWS_LOADED_PER_QUERY rows just to
    # show 50 of them - that mismatch (load 200k rows to show 50) was the
    # single biggest avoidable contributor to the incident above, since
    # preview is by far the most frequently hit of the two. Capped
    # separately and much lower here; chat/AI analysis (which genuinely can
    # need more rows to be accurate) keeps using the higher limit above.
    PREVIEW_ROW_LIMIT: int = 20_000
    SANDBOX_TIMEOUT_SECONDS: int = 20
    MAX_UPLOAD_MB: int = 50
    RATE_LIMIT_PER_MINUTE: int = 30  # per-user AI calls/minute, protects the free AI tier


@lru_cache
def get_settings() -> Settings:
    return Settings()
