import { Link } from "react-router-dom";
import type { CSSProperties } from "react";
import ThemeToggle from "../components/ThemeToggle";
import { connectionKindMeta } from "../components/DataSourceForm";

// Kept in sync with Dashboard.tsx's own CHART_TYPES list (the authenticated
// homepage) so a person never sees a bigger, different claim once they log
// in than what this, their very first page, already showed them.
const CHART_TYPES = [
  "Bar", "Horizontal Bar", "Grouped Bar", "Stacked Bar",
  "Line", "Step Line", "Area", "Stacked Area",
  "Pie", "Donut", "Scatter", "Bubble",
  "Histogram", "Box", "Violin", "Heatmap",
  "Waterfall", "Funnel", "Sankey", "Treemap",
  "Sunburst", "Radar", "Gauge", "Candlestick",
];

// The real connector logos already drawn for the "Connect data" picker
// inside the app (see DataSourceForm.tsx) - reused here instead of a
// separate marketing graphic, so this claim is provably true rather than
// decorative: this is what you'll actually click on once you sign up.
const CONNECTOR_KINDS = ["postgres", "mysql", "sqlserver", "mongodb", "supabase", "bigquery", "excel", "csv"];

const HOW_IT_WORKS = [
  {
    step: "01",
    title: "Connect",
    body: "A database (Postgres, MySQL, SQL Server, MongoDB, Supabase), a warehouse (BigQuery), or a file (CSV, Excel, JSON). Read-only and encrypted - every outbound IP is published so IT can whitelist it before you connect.",
  },
  {
    step: "02",
    title: "Ask",
    body: "“Which region grew fastest last quarter?” Plain English in. GD360 cleans what it needs to, picks the right chart, and runs the real numbers.",
  },
  {
    step: "03",
    title: "Verify",
    body: "A chart, a plain-English insight, and a “Double-check this” button that independently re-audits the answer against the numbers it actually computed.",
  },
];

function CheckMarkIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

function PromptToChartIcon({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      <path d="M8 12l2-2 2 2 4-4" />
    </svg>
  );
}

function CleanPrepIcon({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 5h16M7 12h10M10 19h4" />
    </svg>
  );
}

function VerifiedIcon({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2l8 4v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}

function GuidedIcon({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M15 9l-2 5-5 2 2-5z" />
    </svg>
  );
}

const FEATURES = [
  {
    n: "01",
    title: "Prompt to chart",
    body: "Describe what you want in plain English. GD360 picks the right chart from 24+ types, transforms the data, and renders it live — no SQL, no drag-and-drop dashboard builder.",
    Icon: PromptToChartIcon,
  },
  {
    n: "02",
    title: "Cleaning, explained line by line",
    body: "Every prep step — duplicates removed, missing values handled, types fixed — is written out in plain English with the real row counts behind it. Never a black box.",
    Icon: CleanPrepIcon,
  },
  {
    n: "03",
    title: "Double-check this",
    body: "Every insight is checked once when it's written — and you can check it again yourself, anytime, with one click. An independent audit re-runs the numbers before you act on them.",
    Icon: VerifiedIcon,
  },
  {
    n: "04",
    title: "Guided by Goku",
    body: "New to data analysis? Goku suggests what to clean, what to explore and what to ask next, one clear step at a time — built for people who've never opened a BI tool.",
    Icon: GuidedIcon,
  },
];

const TRUST_POINTS = [
  {
    title: "Minutes, not hours",
    body: "Connect your data and get a finished, verified chart in minutes. No dashboard to build, no analyst to wait on, no learning curve.",
  },
  {
    title: "One tool, every source",
    body: "Spreadsheets, CSV and Excel files, SQL and NoSQL databases — all analyzed the same simple way instead of juggling separate tools.",
  },
  {
    title: "Read-only, enterprise-ready",
    body: "GD360 never modifies your data. Credentials are encrypted, and every outbound IP address is published so IT can whitelist it before you connect.",
  },
  {
    title: "Full access, free",
    body: "Every feature, unlimited, no credit card and no seat limits — unlike most analytics tools that meter the parts worth having.",
  },
];

function ChartTypeIcon({ chartType }: { chartType: string | null }) {
  const t = (chartType || "").toLowerCase();
  if (t.includes("pie") || t.includes("donut")) {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21.21 15.89A10 10 0 1 1 8 2.83" />
        <path d="M22 12A10 10 0 0 0 12 2v10z" />
      </svg>
    );
  }
  if (t.includes("scatter") || t.includes("bubble")) {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
        <circle cx="6" cy="17" r="2" />
        <circle cx="12" cy="9" r="2" />
        <circle cx="18" cy="14" r="2" />
        <circle cx="15" cy="6" r="2" />
      </svg>
    );
  }
  if (t.includes("line") || t.includes("area")) {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 17l5-6 4 3 5-8 4 5" />
      </svg>
    );
  }
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </svg>
  );
}

export default function Landing() {
  return (
    <div>
      {/* ---- Public header ----
          flex-wrap + shrinking gaps/padding on small screens keep this row
          from overflowing horizontally on a phone-width viewport - the logo
          text plus 3 controls (theme toggle, Log in, Sign up) no longer
          fit on one line under ~380px without it. */}
      <div className="flex flex-wrap items-center justify-between gap-y-2 gap-x-3 px-4 sm:px-6 py-4 border-b border-border">
        <Link to="/" className="flex items-center gap-2.5 shrink-0">
          <span className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center text-white font-bold text-sm shrink-0">
            G
          </span>
          <span className="text-base sm:text-lg font-extrabold gradient-text">GD360 Analytics</span>
        </Link>
        <div className="flex items-center gap-2 sm:gap-3">
          <ThemeToggle />
          <Link to="/login" className="btn-secondary text-xs sm:text-sm px-3 py-1.5 sm:px-4 sm:py-2">Log in</Link>
          <Link to="/register" className="btn-primary text-xs sm:text-sm px-3 py-1.5 sm:px-4 sm:py-2">Sign up free</Link>
        </div>
      </div>

      {/* ---- Hero ----
          No blurred color orbs here on purpose - that's the one visual
          trick nearly every "AI-native" product site now shares. Instead:
          a faint dot grid (a data/graph-paper texture, not a decoration)
          and a solid, confident headline with a single highlighter-style
          mark instead of a gradient fill. */}
      <div className="relative overflow-hidden">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage: "radial-gradient(rgb(var(--color-border)) 1px, transparent 1px)",
            backgroundSize: "22px 22px",
            maskImage: "radial-gradient(ellipse 70% 60% at 50% 0%, black 40%, transparent 100%)",
            WebkitMaskImage: "radial-gradient(ellipse 70% 60% at 50% 0%, black 40%, transparent 100%)",
          }}
        />
        <div className="relative max-w-5xl mx-auto px-4 sm:px-6 pt-12 sm:pt-16 pb-14 text-center">
          <div className="pill mx-auto mb-6 w-fit !text-primary">
            <CheckMarkIcon className="w-3.5 h-3.5" /> Verified, not guessed
          </div>
          <h1 className="text-3xl sm:text-5xl md:text-6xl font-extrabold leading-tight tracking-tight">
            Ask your data anything.
            <br />
            Get an answer{" "}
            <span className="relative inline-block whitespace-nowrap">
              <span className="relative z-10">worth trusting.</span>
              <span aria-hidden className="absolute left-0 right-0 bottom-1 sm:bottom-2 h-[0.32em] bg-primary/[0.22] -z-0 rounded-sm" />
            </span>
          </h1>
          <p className="text-muted text-base sm:text-lg mt-6 max-w-2xl mx-auto leading-relaxed">
            GD360 connects to your databases, warehouses and files, cleans what it needs to with a
            plain-English explanation of every step, picks the right chart for what you asked, and writes
            the insight from numbers it actually computed — never a guess. No SQL. No Python. No code.
          </p>
          <div className="flex items-center justify-center gap-3 mt-8 flex-wrap">
            <Link to="/register" className="btn-primary text-base px-6 py-3">
              Create free account &rarr;
            </Link>
            <Link to="/login" className="btn-secondary text-base px-6 py-3">
              Log in
            </Link>
          </div>

          {/* ---- Real connector logo strip ----
              These are the exact same logo components rendered inside the
              app's own "Connect data" picker - not stock marketing icons -
              so this is evidence, not decoration. Muted by default,
              brand-colored on hover. */}
          <div className="mt-12">
            <div className="text-xs font-semibold tracking-widest text-muted mb-4">CONNECTS DIRECTLY TO</div>
            <div className="flex items-center justify-center gap-5 sm:gap-7 flex-wrap">
              {CONNECTOR_KINDS.map((kind) => {
                const meta = connectionKindMeta(kind);
                return (
                  <div
                    key={kind}
                    className="group flex items-center gap-1.5 text-muted transition-colors"
                    style={{ "--hover-color": meta.color } as CSSProperties}
                  >
                    <meta.Logo className="w-5 h-5 shrink-0 transition-colors group-hover:[color:var(--hover-color)]" />
                    <span className="text-xs sm:text-sm font-medium transition-colors group-hover:text-text">{meta.label}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 sm:px-6 pb-16">
        {/* ---- Feature ledger ----
            A spec-sheet layout instead of icon-in-colored-box cards: a
            numbered row with a thin left accent bar (GD360's recurring
            "verification mark" - see index.css's .verify-bar) rather than
            a floating icon tile. */}
        <div className="mb-10">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {FEATURES.map((f) => (
              <div key={f.title} className="verify-bar card p-6 pl-7">
                <div className="flex items-start gap-3">
                  <div className="text-muted shrink-0 mt-0.5">
                    <f.Icon />
                  </div>
                  <div>
                    <div className="flex items-baseline gap-2 mb-1.5">
                      <span className="mono-figure text-xs text-muted">{f.n}</span>
                      <span className="font-semibold">{f.title}</span>
                    </div>
                    <div className="text-sm text-muted leading-relaxed">{f.body}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ---- How it works ---- */}
        <div className="card p-6 sm:p-8 mb-8">
          <div className="text-center mb-8">
            <h2 className="text-xl sm:text-2xl font-bold">From connection to verified chart in three steps</h2>
          </div>
          <div className="relative grid grid-cols-1 sm:grid-cols-3 gap-8 sm:gap-6">
            <div aria-hidden className="hidden sm:block absolute top-[1.15rem] left-[16.5%] right-[16.5%] h-px bg-border" />
            {HOW_IT_WORKS.map((s) => (
              <div key={s.step} className="relative text-center sm:text-left">
                <div className="mono-figure text-xs text-primary font-semibold mb-3 bg-base inline-block pr-3 sm:pr-0 sm:bg-transparent">
                  {s.step}
                </div>
                <div className="font-semibold mb-1.5">{s.title}</div>
                <div className="text-sm text-muted leading-relaxed">{s.body}</div>
              </div>
            ))}
          </div>
        </div>

        {/* ---- Chart type chip strip ---- */}
        <div className="card p-6 mb-10 text-center">
          <div className="text-xs font-semibold tracking-widest text-muted mb-4">
            <span className="mono-figure text-primary">{CHART_TYPES.length}+</span> WAYS TO SEE YOUR DATA
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            {CHART_TYPES.map((c) => (
              <span
                key={c}
                className="inline-flex items-center gap-1.5 text-xs text-muted border border-border rounded-md px-2.5 py-1.5"
              >
                <ChartTypeIcon chartType={c} /> {c}
              </span>
            ))}
          </div>
        </div>

        {/* ---- Trust section ---- */}
        <div className="mb-10">
          <div className="text-center mb-6">
            <h2 className="text-2xl font-bold">Why teams pick GD360</h2>
            <p className="text-muted mt-2 max-w-2xl mx-auto">
              Not a longer feature list — fewer reasons to second-guess it.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {TRUST_POINTS.map((t) => (
              <div key={t.title} className="verify-bar card p-6 pl-7">
                <div className="font-semibold mb-1.5">{t.title}</div>
                <div className="text-sm text-muted leading-relaxed">{t.body}</div>
              </div>
            ))}
          </div>
        </div>

        {/* ---- Final CTA ---- */}
        <div className="card p-6 sm:p-10 text-center">
          <h2 className="text-xl sm:text-2xl font-bold mb-2">Connect your first data source in under five minutes.</h2>
          <p className="text-muted mb-6">Free, unlimited plan. No credit card required.</p>
          <div className="flex items-center justify-center gap-3 flex-wrap">
            <Link to="/register" className="btn-primary text-base px-6 py-3">
              Create free account &rarr;
            </Link>
            <Link to="/login" className="text-primary text-sm font-medium hover:underline self-center">
              Already have an account? Log in
            </Link>
          </div>
        </div>
      </div>

      {/* ---- Footer ---- */}
      <div className="border-t border-border mt-4">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 flex flex-wrap items-center justify-between gap-3 text-sm text-muted">
          <div>&copy; {new Date().getFullYear()} GD360 Analytics. All rights reserved.</div>
          <Link to="/privacy" className="hover:text-text hover:underline">
            Privacy Policy
          </Link>
        </div>
      </div>
    </div>
  );
}
