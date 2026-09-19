import { Link } from "react-router-dom";
import ThemeToggle from "../components/ThemeToggle";

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

const HOW_IT_WORKS = [
  {
    step: "1",
    title: "Connect your data",
    body: "A database (Postgres, MySQL, MongoDB) or a file (CSV, Excel, JSON) - read-only, encrypted, and never modified.",
  },
  {
    step: "2",
    title: "Ask in plain English",
    body: "“Which region grew fastest last quarter?” GD360 cleans what it needs to, picks the right chart, and runs the numbers.",
  },
  {
    step: "3",
    title: "Get a verified answer",
    body: "A chart, a plain-English insight, and a “Double-check this” button that re-audits the answer against the real computed numbers.",
  },
];

function SparkIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2l1.8 5.6L19.5 9l-5.7 1.4L12 16l-1.8-5.6L4.5 9l5.7-1.4L12 2z" />
    </svg>
  );
}

function PromptToChartIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      <path d="M8 12l2-2 2 2 4-4" />
    </svg>
  );
}

function CleanPrepIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 5h16M7 12h10M10 19h4" />
    </svg>
  );
}

function VerifiedIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2l8 4v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}

function GuidedIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M15 9l-2 5-5 2 2-5z" />
    </svg>
  );
}

const FEATURES = [
  {
    title: "Prompt to chart",
    body: "Describe what you want in plain English. GD360 picks the right chart from 24+ types, transforms the data, and renders it live.",
    Icon: PromptToChartIcon,
  },
  {
    title: "AI cleaning, fully explained",
    body: "Every prep step – duplicates removed, missing values handled, types fixed – is explained in plain English with real row counts. Never a black box.",
    Icon: CleanPrepIcon,
  },
  {
    title: "Verified, not guessed",
    body: "Every number in an insight traces back to a real computation. Hit “Double-check this” and an independent AI audit re-checks the answer before you trust it.",
    Icon: VerifiedIcon,
  },
  {
    title: "Guided by Goku",
    body: "New to data analysis? Goku walks you through what to clean, what to explore, and what to ask next – one clear step at a time.",
    Icon: GuidedIcon,
  },
];

const TRUST_POINTS = [
  {
    title: "Minutes, not hours",
    body: "Connect your data and get a finished, verified chart in minutes. No dashboard building, no waiting on an analyst, no learning curve.",
  },
  {
    title: "One tool, every data source",
    body: "Spreadsheets, CSV and Excel files, SQL and NoSQL databases, all analyzed the same simple way, instead of juggling separate tools.",
  },
  {
    title: "Read-only, enterprise-ready",
    body: "GD360 never modifies your data. Your password is encrypted, and every outbound IP address is published so IT can whitelist it before you connect.",
  },
  {
    title: "Full access, free",
    body: "Every feature, unlimited, with no credit card and no seat limits, unlike most analytics tools that lock the best parts behind a paid plan.",
  },
];

function ChartTypeIcon({ chartType }: { chartType: string | null }) {
  const t = (chartType || "").toLowerCase();
  if (t.includes("pie") || t.includes("donut")) {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21.21 15.89A10 10 0 1 1 8 2.83" />
        <path d="M22 12A10 10 0 0 0 12 2v10z" />
      </svg>
    );
  }
  if (t.includes("scatter") || t.includes("bubble")) {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
        <circle cx="6" cy="17" r="2" />
        <circle cx="12" cy="9" r="2" />
        <circle cx="18" cy="14" r="2" />
        <circle cx="15" cy="6" r="2" />
      </svg>
    );
  }
  if (t.includes("line") || t.includes("area")) {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 17l5-6 4 3 5-8 4 5" />
      </svg>
    );
  }
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
          text plus 3 controls (theme toggle, Log in, Sign up free) no longer
          fit on one line under ~380px without it. */}
      <div className="flex flex-wrap items-center justify-between gap-y-2 gap-x-3 px-4 sm:px-6 py-4 border-b border-border">
        <Link to="/" className="flex items-center gap-2.5 shrink-0">
          <span className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary to-accent flex items-center justify-center text-white font-bold text-sm shrink-0">
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

      {/* ---- Hero ---- */}
      <div className="relative overflow-hidden">
        <div
          aria-hidden
          className="pointer-events-none absolute -top-24 -left-24 w-72 h-72 rounded-full bg-primary/20 blur-3xl"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -top-16 -right-24 w-80 h-80 rounded-full bg-accent/20 blur-3xl"
        />
        <div className="relative max-w-5xl mx-auto px-4 sm:px-6 pt-12 sm:pt-16 pb-14 text-center">
          <div className="pill mx-auto mb-6 w-fit">
            <SparkIcon className="w-3.5 h-3.5 text-accent" /> AI-native analytics, verified every step
          </div>
          <h1 className="text-3xl sm:text-5xl md:text-6xl font-extrabold leading-tight tracking-tight">
            Ask your data anything.
            <br />
            <span className="gradient-text">Get analyst-grade answers you can trust.</span>
          </h1>
          <p className="text-muted text-base sm:text-lg mt-6 max-w-2xl mx-auto leading-relaxed">
            GD360 connects straight to your databases and files, cleans and prepares the data with a
            plain-English explanation of every step, picks the right chart for what you asked, and writes
            the insight from real computed numbers – never a guess. No SQL. No Python. No code.
          </p>
          <div className="flex items-center justify-center gap-3 mt-8 flex-wrap">
            <Link to="/register" className="btn-primary text-base px-6 py-3">
              Create free account &rarr;
            </Link>
            <Link to="/login" className="btn-secondary text-base px-6 py-3">
              Log in
            </Link>
          </div>
          <div className="flex items-center justify-center gap-3 sm:gap-6 mt-8 text-sm text-muted flex-wrap">
            <span className="flex items-center gap-1.5">
              <span className="text-accent">&#128737;</span> Read-only. Your data is never modified.
            </span>
            <span className="hidden sm:inline text-border">|</span>
            <span className="flex items-center gap-1.5">
              <span className="text-accent">&#10003;</span> Every answer independently verified
            </span>
            <span className="hidden sm:inline text-border">|</span>
            <span className="flex items-center gap-1.5">
              <span>&#128451;</span> Postgres &middot; MySQL &middot; MongoDB &middot; CSV &middot; Excel &middot; JSON
            </span>
            <span className="hidden sm:inline text-border">|</span>
            <span className="flex items-center gap-1.5">
              <span>&#128200;</span> {CHART_TYPES.length}+ chart types
            </span>
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 sm:px-6 pb-16">
        {/* ---- Feature cards ---- */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          {FEATURES.map((f) => (
            <div key={f.title} className="card p-6">
              <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-primary/20 to-accent/20 flex items-center justify-center text-primary mb-4">
                <f.Icon />
              </div>
              <div className="font-semibold mb-1.5">{f.title}</div>
              <div className="text-sm text-muted leading-relaxed">{f.body}</div>
            </div>
          ))}
        </div>

        {/* ---- How it works ---- */}
        <div className="card p-6 sm:p-8 mb-8">
          <div className="text-center mb-6">
            <h2 className="text-xl sm:text-2xl font-bold">From connection to verified chart in three steps</h2>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 sm:gap-4">
            {HOW_IT_WORKS.map((s) => (
              <div key={s.step} className="text-center sm:text-left">
                <div className="w-9 h-9 rounded-full bg-gradient-to-br from-primary to-accent text-white font-bold flex items-center justify-center mx-auto sm:mx-0 mb-3">
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
          <div className="text-xs font-semibold tracking-wide text-muted mb-4">
            {CHART_TYPES.length}+ WAYS TO SEE YOUR DATA
          </div>
          <div className="flex flex-wrap justify-center gap-2.5">
            {CHART_TYPES.map((c) => (
              <span key={c} className="pill">
                <ChartTypeIcon chartType={c} /> {c}
              </span>
            ))}
          </div>
        </div>

        {/* ---- Trust section ---- */}
        <div className="mb-10">
          <div className="text-center mb-6">
            <h2 className="text-2xl font-bold">Why choose GD360 Analytics</h2>
            <p className="text-muted mt-2 max-w-2xl mx-auto">
              Here is what makes this easier than most other analytics tools.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {TRUST_POINTS.map((t) => (
              <div key={t.title} className="card p-6">
                <div className="font-semibold mb-1.5">{t.title}</div>
                <div className="text-sm text-muted leading-relaxed">{t.body}</div>
              </div>
            ))}
          </div>
        </div>

        {/* ---- Final CTA ---- */}
        <div className="card p-6 sm:p-10 text-center">
          <h2 className="text-xl sm:text-2xl font-bold mb-2">Ready to see your data differently?</h2>
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
    </div>
  );
}
