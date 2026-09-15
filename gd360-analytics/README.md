# GD360 Analytics

**AI-driven, no-code 360° data analytics.** Connect a database or upload a file, ask questions in
plain English, and GD360 writes the analysis code itself, builds an interactive chart, and explains
what it means — no SQL, no Python, no BI-tool training required.

This repo contains a complete, working product:

- **backend/** — FastAPI service: accounts, encrypted datasource connections, the AI copilot
  (plan → sandboxed pandas execution → chart → insight), dashboards.
- **frontend/** — React + Tailwind app: sign up/sign in, connect data, chat-driven analysis
  workspace with an interactive Plotly canvas, save-to-dashboard.

Everything below has been built and smoke-tested end to end (auth, file upload, the AI
pipeline with mocked and unmocked calls, and the frontend production build) in this environment.

---

## 1. How it works (read this before deploying)

1. You sign up for a free account.
2. You connect a data source — a Postgres/MySQL/MongoDB database (host, port, credentials) or a
   CSV/Excel upload.
3. You type what you want in the chat, e.g. *"show me monthly revenue trend"* or *"break down
   total sales like a waterfall by product line"*.
4. The backend sends your prompt + your dataset's schema (column names/types only — never your
   actual row data, and never your credentials) to an AI model, which returns a short plan: which
   pandas code to run, and which chart type fits best.
5. That code runs **only** in an isolated, resource-limited subprocess with no network, filesystem,
   or `import` access — see [Security model](#3-security-model--limitations) below.
6. The result is turned into an interactive Plotly chart, and a second AI call writes a plain-English
   insight from the result data.
7. You can ask follow-ups, request chart-type changes, or click a suggested chart/stat method, all in
   the same conversation. Charts can be saved to a personal dashboard.

**GD360 never writes to a source database.** Every SQL path is checked to be a single `SELECT`
statement before it runs, and Mongo access only ever uses `find()`. Still, always connect with a
**read-only database user** as a second layer of protection — the connection form reminds you of this.

---

## 2. Run it locally first (10 minutes)

You need Python 3.11+, Node 18+, and a free [Groq](https://console.groq.com/keys) API key (the
default AI provider — free tier, no credit card).

```bash
# Backend
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# Edit .env: paste your GROQ_API_KEY, and generate+paste a CREDENTIAL_ENCRYPTION_KEY with:
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
uvicorn app.main:app --reload --port 8000
```

```bash
# Frontend (new terminal)
cd frontend
npm install
cp .env.example .env   # VITE_API_URL=http://localhost:8000 is already correct for local dev
npm run dev
```

Open http://localhost:5173, create an account, upload a CSV (or connect a database), and start
asking questions. The local backend uses SQLite by default (`gd360.db`, created automatically) so
there's nothing else to set up.

---

## 3. Security model & limitations

Being upfront about this matters more than sounding impressive:

- **Credentials** for any database/ERP/CRM you connect are encrypted at rest with Fernet
  (symmetric AES) using `CREDENTIAL_ENCRYPTION_KEY`, and are only decrypted in memory for the
  duration of a single request. They are never sent to the AI provider or returned to the frontend.
- **Read-only enforcement**: SQL queries are parsed and rejected unless they are a single `SELECT`
  (no `INSERT`/`UPDATE`/`DELETE`/`DROP`/etc.); Mongo access is limited to `find()`. This is
  application-level enforcement — pairing it with a genuinely read-only DB user/role on your side
  is strongly recommended defense-in-depth.
- **Code execution sandbox**: AI-generated pandas code runs in a separate OS process (not the API
  server's own process), with CPU-time and memory limits, a restricted `__builtins__` set (no
  `import`, `open`, `eval`, `exec`, `os`, `subprocess`, or network calls available), and a
  wall-clock timeout enforced by the parent process. This is a **pragmatic sandbox appropriate for
  an MVP talking to a well-behaved LLM** — it is not a hardened multi-tenant execution platform.
  Python's dynamic nature means a sufficiently creative payload could theoretically still find an
  edge case (e.g. via object introspection tricks). For a production/enterprise-grade deployment,
  run this worker inside a locked-down container per request (gVisor, Firecracker, or Docker with
  `--network none` and a read-only filesystem) — the `run_sandboxed()` function in
  `backend/app/services/sandbox.py` is written to be a drop-in replacement point for that.
- **Auth**: passwords are hashed with bcrypt; sessions use signed JWTs. There's no email
  verification or password-reset flow yet — add one before treating this as a public product with
  real user data at scale.
- **Rate limiting**: a simple per-user, per-minute cap on AI calls (`RATE_LIMIT_PER_MINUTE` in
  `.env`, default 30/min) protects your free AI-provider quota from being exhausted by accident. It's
  in-memory, so it resets per server process — fine for a single free-tier instance, swap for
  Redis if you scale to multiple instances.
- **"Unlimited free usage"**: hosting (Render/Vercel/Supabase free tiers) costs you nothing to run.
  The AI calls themselves are billed by whichever provider you use — Groq's free tier is generous
  but is a *rate limit*, not literally infinite compute. If this gets heavy real-world usage, that's
  the point to add a paid AI key or introduce a fair-use cap.

None of this is meant to alarm you — it's meant so you know exactly what you're shipping and what
"harden before scaling to sensitive enterprise data" would involve.

---

## 4. Deploy it for free — step by step

This gets you a live, public URL (e.g. `https://gd360-analytics.vercel.app`) that anyone can sign
up to and use, running on entirely free infrastructure: **Supabase** (Postgres database, free
tier), **Render** (backend API, free web service), **Vercel** (frontend, free), **Groq** (AI, free
tier). No credit card required for any of these at this scale.

### Step 1 — Put the code on GitHub

1. Create a free GitHub account if you don't have one: https://github.com/signup
2. Create a new repository (e.g. `gd360-analytics`) — public or private, either works.
3. From this project's folder:
   ```bash
   git init
   git add .
   git commit -m "Initial commit: GD360 Analytics"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/gd360-analytics.git
   git push -u origin main
   ```

### Step 2 — Create your free database (Supabase)

1. Go to https://supabase.com and sign up free.
2. Click **New project**. Pick any name/region, and set a database password — save it somewhere safe.
3. Once it's created, go to **Project Settings → Database → Connection string → URI**, and copy it.
   It looks like:
   `postgresql://postgres:[YOUR-PASSWORD]@db.xxxxxxxxxxxx.supabase.co:5432/postgres`
4. Turn that into GD360's format by changing `postgresql://` to `postgresql+psycopg2://` — that
   full string is your `DATABASE_URL`.

This is GD360's *own* app database (users, saved dashboards, connection metadata) — separate from
any customer database your users later connect to analyze.

### Step 3 — Get a free AI key (Groq)

1. Go to https://console.groq.com/keys and sign up free.
2. Create an API key and copy it — this is `GROQ_API_KEY`.

### Step 4 — Deploy the backend (Render)

1. Go to https://render.com and sign up free (you can sign in with GitHub).
2. Click **New → Blueprint**, connect your GitHub account, and pick your `gd360-analytics` repo.
   Render will detect `backend/render.yaml` automatically.
3. When prompted for the environment variables marked `sync: false`, fill in:
   - `DATABASE_URL` → the Supabase connection string from Step 2
   - `CREDENTIAL_ENCRYPTION_KEY` → generate one locally and paste it:
     ```bash
     python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
     ```
     **Save this value somewhere safe outside Render too.** If you ever lose it, every stored
     database/ERP credential becomes unreadable and users will need to reconnect their data sources.
   - `GROQ_API_KEY` → your key from Step 3
   - `FRONTEND_ORIGIN` → you can leave this blank for now and come back to set it after Step 5
     (it needs your Vercel URL, which doesn't exist yet)
4. Click **Apply**. Render will build and deploy. First build takes a few minutes. Once live, note
   your backend URL, e.g. `https://gd360-analytics-api.onrender.com`.
5. Visit `https://YOUR-BACKEND-URL/health` — you should see `{"status":"ok",...}`.

   **Free-tier note:** Render's free web services spin down after inactivity and take ~30-50
   seconds to wake up on the next request. Fine for an early product; upgrade to a paid instance
   ($7/mo Starter) later if that cold-start delay becomes a problem.

### Step 5 — Deploy the frontend (Vercel)

1. Go to https://vercel.com and sign up free (sign in with GitHub).
2. Click **Add New → Project**, pick your `gd360-analytics` repo.
3. Set **Root Directory** to `frontend`.
4. Under **Environment Variables**, add:
   - `VITE_API_URL` → your Render backend URL from Step 4 (e.g. `https://gd360-analytics-api.onrender.com`)
5. Click **Deploy**. In a minute or two you'll get a live URL, e.g.
   `https://gd360-analytics.vercel.app`.

### Step 6 — Connect the two

1. Back in Render, open your backend service → **Environment**, set `FRONTEND_ORIGIN` to your
   Vercel URL from Step 5, and save (Render will redeploy automatically).
2. Open your Vercel URL, create an account, and try it: upload a CSV or connect a database, then
   ask a question in the chat.

That's it — GD360 is live on the internet, free, for anyone to sign up and use.

### Optional: a custom free domain

- Vercel gives you a free `*.vercel.app` subdomain automatically (Step 5).
- If you want something like `gd360.yourname.com`, you can use a free subdomain provider (e.g.
  [is-a.dev](https://www.is-a.dev/), or a free tier from Freenom-style registrars where available)
  and point it at Vercel following Vercel's "Add Domain" instructions in Project Settings.

---

## 5. Adding more connectors (MongoDB is already in; here's the pattern for others)

`backend/app/services/connectors.py` defines a simple interface: `test_connection()`,
`introspect_schema()`, `load_dataframe()`. To add Snowflake, BigQuery, or a REST-based ERP/CRM
connector (Salesforce, HubSpot, SAP, etc.), add a new class implementing that same interface, wire
it into `DataSourceCreateDB`'s `kind` options in `schemas.py`, and add a matching option in the
frontend's `DataSourceForm.tsx`. Because the AI engine, sandbox, and chart builder all just operate
on a pandas DataFrame, nothing else needs to change.

## 6. Rotating the credential encryption key

If `CREDENTIAL_ENCRYPTION_KEY` is ever compromised, generate a new one, but note that any
already-stored datasource credentials were encrypted with the *old* key. A simple, safe rotation
approach for this codebase: ask users to reconnect their database/ERP sources after a key
rotation (delete + re-add in the UI) rather than attempting in-place re-encryption, since there is
no key-versioning built in yet.

## 7. What's genuinely production-ready vs. what's MVP-grade

Production-ready as shipped: encrypted credential storage, read-only query enforcement, process-
isolated sandboxed code execution with resource limits, JWT auth with bcrypt, CORS locked to your
frontend origin.

Still MVP-grade, worth hardening before serious scale or sensitive enterprise data: no email
verification/password reset, in-memory (not distributed) rate limiting, sandbox isolation is
process-level rather than container-level, no per-tenant usage analytics/billing, no automated DB
migrations (schema is created with `create_all` — move to Alembic once you need to evolve it
without dropping data).
