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
    # Dashboard Builder Phase 3 (2026-09-24): how long a private dashboard
    # viewer's signed access token stays valid before they need to re-enter
    # their email (and password, if one is set) - see security.py's
    # create_dashboard_viewer_token/decode_dashboard_viewer_token and
    # routers/dashboard_builder.py's get_public_dashboard. Deliberately
    # short relative to ACCESS_TOKEN_EXPIRE_MINUTES above (that one's for a
    # real signed-in GD360 account) - this token grants no account access
    # at all, only "may view this one dashboard", and the email allow-list
    # is re-checked against the database on every single request regardless
    # of this token's own remaining lifetime, so a revoke always takes
    # effect immediately rather than waiting for this to expire.
    DASHBOARD_VIEWER_TOKEN_EXPIRE_HOURS: int = 24

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

    # --- Snowflake pushdown (Enterprise Scale Roadmap, Phase 2) ---
    # Snowflake has no free "dry run" cost estimate the way BigQuery does
    # (BigQuery bills by bytes scanned; Snowflake bills by warehouse
    # compute-time instead, so a bytes estimate up front isn't a natural
    # fit for it the way it is for BigQuery). Instead, a Snowflake
    # pushdown query is capped by wall-clock time: this many seconds
    # after it starts, Snowflake itself cancels it, which directly caps
    # the worst-case compute-time (and therefore cost) any single
    # question can run up, regardless of how much data it touches. See
    # connectors.SnowflakeConnector.run_pushdown_query. The query's real
    # bytes_scanned is still recorded afterward (from Snowflake's own
    # QUERY_HISTORY_BY_SESSION) for the audit log and the daily budget
    # below - just measured after the fact rather than estimated first.
    SNOWFLAKE_STATEMENT_TIMEOUT_SECONDS: int = 30

    # --- Pushdown audit log + per-customer daily cost budget (Enterprise
    # Scale Roadmap, Phase 2) ---
    # The most data one person's pushdown questions (BigQuery, Snowflake -
    # any future warehouse the same way) are allowed to make their
    # warehouse scan in a rolling day, added across every question they
    # ask and every warehouse they use - on top of BigQuery's per-query
    # ceiling above and Snowflake's per-query timeout above. Enforced by
    # summing today's PushdownQueryLog.bytes_scanned for that person
    # before a new pushdown query is even attempted (see routers/chat.py
    # _todays_pushdown_bytes). This is what keeps one very chatty user
    # from running up a real warehouse bill across many small questions,
    # the way a single per-query safeguard alone cannot. Generous by
    # default; make it configurable per customer once real enterprise
    # usage patterns are known.
    PUSHDOWN_MAX_BYTES_SCANNED_PER_DAY_PER_USER: int = 50 * 1024 * 1024 * 1024  # 50 GiB

    # --- MongoDB pushdown (Enterprise Scale Roadmap, Phase 2) ---
    # Like the plain SQL databases (Postgres/MySQL/SQL Server/Supabase),
    # a customer's own MongoDB server has no per-query metered billing to
    # guard against, so this isn't a cost cap - it's a runtime safety net,
    # passed as the aggregation's maxTimeMS so a slow, unindexed pipeline
    # (an unbounded $lookup "join," say) can't hang against the customer's
    # own database indefinitely. See connectors.MongoConnector.
    # run_pushdown_query. Same 30s default as Snowflake's per-query
    # timeout above, chosen for the same reason (comfortably longer than
    # any real interactive question should take, short enough to fail
    # fast and fall back to the normal path otherwise).
    MONGO_AGGREGATION_TIMEOUT_SECONDS: int = 30

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
    # 2026-09-23: raised from 20 after real production logs showed
    # "Analysis code timed out" firing repeatedly for ordinary requests
    # (a plain groupby, a two-table merge) against tables of only tens of
    # thousands of rows - work that should be near-instant for genuinely
    # vectorized pandas. This app's backend runs on a shared 0.5 CPU /
    # 512MB Render instance (confirmed via the Render API, not a guess),
    # so real CPU contention under load is a real, live constraint here,
    # not a theoretical one. This is paired with two real fixes, not a
    # band-aid on its own: SYSTEM_PROMPT now explicitly forbids the slow
    # per-row Python patterns (`.apply(axis=1)`, `.iterrows()`, manual row
    # loops) that are the other common cause of an unexpectedly slow run,
    # and a genuine timeout now gets a specific, actionable retry message
    # instead of a generic one (see ai_engine.analyze's retry loop) - so
    # this higher ceiling is there to let legitimately-fine work finish
    # under real CPU pressure, not to wait longer on code that was always
    # going to be slow. Kept well short of a full minute given the 512MB
    # memory ceiling - a sandboxed child process held alive longer under
    # real traffic is memory held longer too.
    SANDBOX_TIMEOUT_SECONDS: int = 30
    MAX_UPLOAD_MB: int = 50
    RATE_LIMIT_PER_MINUTE: int = 30  # per-user AI calls/minute, protects the free AI tier

    # --- White-label custom domains (Dashboard Builder Phase 4, 2026-09-24) ---
    # Both are required for the "custom domain" publish option to work at
    # all - see services/render_domains.py for exactly how they're used.
    # Neither is set by default, so this feature 503s with a clear message
    # until both are configured, rather than silently pretending to work.
    #
    # RENDER_API_KEY: a Render account API key with permission to manage
    # this account's services. Generate one at
    # https://dashboard.render.com/u/settings#api-keys (Account Settings ->
    # API Keys -> Create API Key) and set it as a Render environment
    # variable on THIS backend service - never commit it to git.
    RENDER_API_KEY: str = ""
    # RENDER_FRONTEND_SERVICE_ID: the Render service id of the FRONTEND
    # static site every custom domain gets registered against (this
    # installation's is srv-dakh7ebm8hqs73ejhcmg, "gd360-analytics-web" -
    # visible in that service's Render dashboard URL). Every custom domain
    # across every dashboard on this whole installation points at this one
    # service, since Render serves the exact same built JS bundle no
    # matter which hostname it was reached through - the frontend itself
    # (see PublicDashboardView.tsx/App.tsx) is what looks at
    # window.location.hostname at runtime and resolves it to the right
    # dashboard by calling this backend.
    RENDER_FRONTEND_SERVICE_ID: str = ""


@lru_cache
def get_settings() -> Settings:
    return Settings()
