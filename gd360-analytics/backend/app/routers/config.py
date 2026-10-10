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

    # 2026-10-06 ("generated data is a saved query" layer): the hard row cap
    # on GET /datasources/{id}/versions/{vid}/download for a warehouse
    # saved-query table. The download streams rows straight from the
    # warehouse's own row iterator to the browser as CSV (never a
    # DataFrame, never the whole result in this process's memory), so the
    # cap is not a memory guard - it bounds how long one request can keep
    # a warehouse connection and a worker thread busy. When hit, the CSV
    # ends with one trailing comment row saying it stopped at the cap.
    WAREHOUSE_DOWNLOAD_MAX_ROWS: int = 1_000_000
    # Rows fetched per round trip while streaming that download (BigQuery
    # page_size, Snowflake fetchmany size, SQLAlchemy yield_per).
    WAREHOUSE_DOWNLOAD_BATCH_ROWS: int = 5_000

    # --- Warehouse-native dashboards (2026-10-06) ---
    # services/dashboard_engine.py: every block of a dashboard on a
    # warehouse/database source is ONE query run inside the warehouse with
    # the page's filters pushed into its SQL - never a sample pulled into
    # pandas. These bound what that costs.
    # How long a block's result stays cached in-process, keyed by
    # (datasource id, sha256 of the exact compiled SQL): a filter change
    # that compiles to the same SQL for a block (or a second viewer of the
    # same page) is free; after this many seconds the warehouse is asked
    # again. Short on purpose - a dashboard is meant to be fresh.
    DASHBOARD_RESULT_CACHE_TTL_SECONDS: int = 120
    # The filter rail's parameter options (distinct values + counts) change
    # far more slowly than block results, so they are cached longer.
    DASHBOARD_OPTIONS_CACHE_TTL_SECONDS: int = 600
    # Hard cap on the rows ONE block's query may return (already-aggregated
    # rows; the LIMIT in its SQL). Matches query_builder.MAX_LIMIT.
    DASHBOARD_MAX_BLOCK_ROWS: int = 5000
    # How many block queries one page run executes concurrently. The
    # connectors are blocking, so a bounded ThreadPoolExecutor runs them;
    # every worker constructs its own connector/client (nothing is shared
    # across threads - a BigQuery client is not safe to share that way).
    DASHBOARD_RUN_MAX_PARALLEL: int = 4

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
    # 2026-10-06: a hard, BigQuery-specific ceiling on top of both limits
    # above - confirmed necessary from Render's own oomKilled events
    # (services/connectors.py BigQueryConnector.load_dataframe's own
    # comment has the full incident). BigQuery's connector pulls rows
    # over its REST API (no BigQuery Storage Read API client - that needs
    # an extra IAM permission this app doesn't request), which is
    # measurably heavier per row than the native wire-protocol drivers
    # every other connector in this app uses (psycopg2/pymysql/pymssql/
    # Snowflake's Arrow-based fetch_pandas_all). PREVIEW_ROW_LIMIT (20,000)
    # is safe for those; it was NOT safe for BigQuery - the crash happened
    # at exactly that cap, on an ordinary preview of a real table.
    # Deliberately conservative rather than finely tuned (there was no
    # safe way to binary-search the real ceiling against the user's own
    # already-crashing live service); raise it only after confirming a
    # real, successful load at the new value via Render's own memory
    # metrics, not by estimating from this table alone.
    BIGQUERY_MAX_ROWS_LOADED: int = 2_000
    # 2026-10-05: how long the Data tab's full-table column profiling
    # (services/profiling.py, routers/datasources.py's `/profile`) keeps a
    # result cached in-process before re-scanning the real table. A real
    # warehouse query (billable on BigQuery) every single time someone
    # reopens the Data tab on the same table would be wasteful and slow;
    # 5 minutes is long enough that normal back-and-forth browsing never
    # re-triggers it, short enough that the numbers shown are never
    # meaningfully stale.
    PROFILE_CACHE_TTL_SECONDS: int = 300
    # 2026-10-06 (NoSQL hybrid round): how many documents
    # MongoConnector.introspect_schema samples per collection to build
    # ds.schema_cache - was hard-coded to exactly ONE document
    # (`find_one()`) before this, which meant any field missing from that
    # one sample (a sparse field present on only some documents - normal
    # in a schemaless database) silently never appeared anywhere in the
    # Data tab, chat's schema awareness, or the AI dashboard builder's
    # column list, no matter how many other documents actually had it.
    # Deliberately capped, not unbounded, the same way BIGQUERY_MAX_ROWS_
    # LOADED above is capped: this runs synchronously inside a connect/
    # refresh request against a customer's own MongoDB server, and 200
    # documents is already enough to see almost every field a real
    # collection uses without turning "connect a data source" into a slow
    # full-collection scan. Raise it only after confirming connect/refresh
    # still feels fast against a real, large collection - not by guessing.
    MONGO_SCHEMA_SAMPLE_SIZE: int = 200
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
    # going to be slow.
    #
    # 2026-09-28 (multi-result round): raised from 30 to 45 after real
    # production logs showed a genuinely legitimate multi-table merge
    # timing out at 30s with no useful error - and separately, the new
    # "multiple results in one answer" capability (see ai_engine.
    # SYSTEM_PROMPT's "Multiple results in one answer" rule) can now ask
    # one sandboxed run to build several distinct analyses (a forecast, a
    # segmentation, a market-basket pass, and so on) in a single pass,
    # which is legitimately more work than the single-chart case this
    # limit was originally tuned for. This is paired with the same
    # 2026-09-28 root-cause fix that requires `validate=` on every merge
    # (see SYSTEM_PROMPT) - a genuinely broken/exploding merge now fails
    # in milliseconds instead of eating the full timeout, so most of what
    # used to silently consume this budget no longer does, which is what
    # makes raising the ceiling here safe rather than just slower-to-fail.
    # Kept below a full minute for two reasons that still apply: the
    # 512MB memory ceiling on a sandboxed child process, and this backend
    # running with a single worker (WEB_CONCURRENCY=1, confirmed via
    # startup logs) - since sandboxed code execution blocks that one
    # worker while it runs, a longer ceiling also means a longer worst-case
    # wait for any OTHER person's request queued behind a slow one, not
    # just a longer wait for the slow request itself.
    SANDBOX_TIMEOUT_SECONDS: int = 45
    MAX_UPLOAD_MB: int = 50
    RATE_LIMIT_PER_MINUTE: int = 30  # per-user AI calls/minute, protects the free AI tier

    # 2026-09-29 (parallel-pieces round): when a request genuinely calls for
    # several INDEPENDENT analyses at once (see ai_engine's result_pieces
    # plan field), how many of them run at the same time instead of one
    # after another. Deliberately conservative - this app's Render instance
    # is a confirmed 0.5 CPU / 512MB box (see SANDBOX_TIMEOUT_SECONDS's own
    # comment above), and each concurrent piece is its own full sandboxed
    # child process (see services/sandbox.py). 2 was chosen with Gokul
    # directly (2026-09-29): real memory-safety headroom on this plan, a
    # genuine if modest wall-clock improvement (pieces overlap their
    # process-startup/import cost even when they end up sharing the same
    # half a CPU core for the actual computation), and zero added OOM risk
    # to the single worker process serving every other request. Raise this
    # only after upgrading the Render plan's CPU/memory - not before.
    PARALLEL_PIECES_MAX_WORKERS: int = 2

    # 2026-09-29 (plain-language findings round): how many per-result
    # "insight" calls (see ai_engine._attach_entry_insights) run at the same
    # time when one multi-result turn has several named results, each now
    # getting its own real, grounded finding instead of only the first one.
    # Unlike PARALLEL_PIECES_MAX_WORKERS just above, this has NOTHING to do
    # with this Render instance's CPU/memory - an insight call is a single
    # outbound HTTPS request to the configured AI provider that this process
    # just waits on, not a local child process, so it doesn't touch the
    # OOM/CPU-contention risk that number exists to manage. This bound
    # exists only so one large multi-result turn (e.g. "build me 6 models")
    # doesn't fire a big, bursty batch of simultaneous requests at the AI
    # provider - a request-shaping courtesy, not a local safety limit.
    INSIGHT_MAX_CONCURRENT: int = 3

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

    # --- 2026-10-08 (round 11): synced app sources (services/synced_sources.py).
    # The API versions each app is called with. Apps retire old versions on a
    # schedule (Shopify quarterly, Google Ads monthly since 2026, Meta about
    # twice a year), so each is a setting: when one is retired, set the newer
    # version in Render's environment - no code change, no redeploy of code.
    SHOPIFY_API_VERSION: str = "2026-07"
    META_GRAPH_VERSION: str = "v26.0"
    GOOGLE_ADS_API_VERSION: str = "v24"
    # Google Ads requires a developer token issued to the company that calls
    # the API (Google Ads > Tools > API Center). Set it here once for every
    # customer, or each customer can paste their own when connecting.
    GOOGLE_ADS_DEVELOPER_TOKEN: str = ""

    # --- 2026-10-09 (round 15): "Sign in with ..." for apps (services/app_oauth.py).
    # Each provider's sign-in button works once its app id and secret are set.
    # The redirect URL to register with each provider is
    # {BACKEND_BASE_URL}/apps/oauth/<meta|google|linkedin|hubspot>/callback.
    # Google reuses GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET above.
    META_APP_ID: str = ""            # Meta for Developers > your app > App settings > Basic
    META_APP_SECRET: str = ""        # same page; used for Instagram, Facebook Pages and Meta Ads
    LINKEDIN_CLIENT_ID: str = ""     # LinkedIn Developers > your app > Auth (needs Community Management API)
    LINKEDIN_CLIENT_SECRET: str = ""
    HUBSPOT_CLIENT_ID: str = ""      # HubSpot developer account > your public app > Auth
    HUBSPOT_CLIENT_SECRET: str = ""
    # API versions the new connectors call; set a newer one when the app retires this one.
    LINKEDIN_API_VERSION: str = "202509"    # LinkedIn-Version header (YYYYMM)
    KLAVIYO_REVISION: str = "2025-07-15"    # Klaviyo "revision" header

    # --- 2026-10-08 (round 11): multi-source Projects (services/project_engine).
    PROJECT_MAX_CONCURRENT_RUNS: int = 3
    PROJECT_STEP_MAX_PARALLEL: int = 4
    PROJECT_DUCKDB_MEMORY_LIMIT: str = "256MB"

    # --- 2026-10-08 (round 12): Automations (services/automations.py).
    # Email: set RESEND_API_KEY (resend.com - simplest) OR the SMTP_* group
    # (any provider: Google Workspace, SendGrid, Postmark, SES ...). EMAIL_FROM
    # must be an address on a domain verified with that provider, e.g.
    # "GD360 <alerts@gd360analytics.com>". Until one is set, automations
    # still run and post to Slack/Teams; email deliveries are marked
    # "email isn't set up yet" on the run instead of failing silently.
    RESEND_API_KEY: str = ""
    EMAIL_FROM: str = ""
    SMTP_HOST: str = ""
    SMTP_PORT: int = 587
    SMTP_USERNAME: str = ""
    SMTP_PASSWORD: str = ""
    SMTP_USE_SSL: bool = False  # True for port 465; otherwise STARTTLS is used
    # Links inside emails and Slack posts ("Open dashboard"). Defaults to
    # FRONTEND_ORIGIN when empty.
    APP_PUBLIC_URL: str = ""
    # Abuse guard: emails one account's automations may send per 24 hours.
    AUTOMATION_DAILY_EMAIL_CAP: int = 300
    AUTOMATION_MAX_PER_TICK: int = 5
    # --- 2026-10-10 (Initiatives): marketing emails one workspace's
    # campaigns may send per 24 hours (uses the same email settings above).
    GTM_DAILY_EMAIL_CAP: int = 2000

    # --- 2026-10-08 (round 13): ML Studio (services/ml_studio.py).
    # Rows one training run loads into this server's memory. A table with
    # more rows trains on the first ML_MAX_TRAIN_ROWS and the run says so
    # plainly - never a silent sample. Raise it on a bigger instance.
    ML_MAX_TRAIN_ROWS: int = 50_000
    # Hyper-parameter trials across all algorithms, and the time budget for
    # the train-and-tune stage (it stops early at whichever comes first).
    ML_TRIALS: int = 24
    ML_TUNE_SECONDS: int = 240
    # Trainings running at the same time on this server (others wait).
    ML_MAX_CONCURRENT: int = 1
    # Memory the server may use, in MB. 0 = read it from the container
    # (cgroup). Training checks how much is free before it starts and uses
    # fewer rows - saying so - rather than run the server out of memory.
    ML_MEMORY_LIMIT_MB: int = 0


@lru_cache
def get_settings() -> Settings:
    return Settings()


def effective_preview_cap(kind: str) -> int:
    """2026-10-06 (NoSQL hybrid round 2) real bug fix: the TRUE row
    ceiling the Data tab's preview can ever actually show for a given
    datasource `kind`, after accounting for any per-connector cap layered
    on top of the generic PREVIEW_ROW_LIMIT above.

    routers/datasources.py's preview_datasource used to compare
    loaded_row_count against PREVIEW_ROW_LIMIT (20,000) alone to decide
    `stats_capped` - correct for most kinds, but wrong for BigQuery:
    BigQueryConnector.load_dataframe (services/connectors.py) separately,
    internally clamps row_limit to BIGQUERY_MAX_ROWS_LOADED (2,000) no
    matter what row_limit it was called with. So a real BigQuery table
    with, say, 119,386 rows would silently load only ~2,000 rows, and
    2,000 >= 20,000 is False - `stats_capped` came back False even though
    the preview WAS heavily truncated, and the Data tab's one honest
    "this is a sample, not the whole table" disclaimer never fired for
    BigQuery at all.

    Call this instead of reading PREVIEW_ROW_LIMIT directly wherever code
    needs to know "how many rows could this kind's preview load ever
    actually contain." A future connector-specific cap (another warehouse
    with its own memory ceiling, say) is a one-line addition to the
    `caps` dict below, not a rewrite of this function or its callers."""
    settings = get_settings()
    caps = {
        "bigquery": min(settings.PREVIEW_ROW_LIMIT, settings.BIGQUERY_MAX_ROWS_LOADED),
    }
    return caps.get(kind, settings.PREVIEW_ROW_LIMIT)
