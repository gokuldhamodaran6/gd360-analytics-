import { Link } from "react-router-dom";
import ThemeToggle from "../components/ThemeToggle";

const CHART_TYPES = [
  "Bar", "Line", "Area", "Pie", "Scatter", "Histogram",
  "Box", "Heatmap", "Waterfall", "Funnel", "Treemap",
];

const FEATURES = [
  {
    title: "Prompt to chart",
    body: "Describe what you want to see. GD360 picks the chart, transforms the data, and renders it live.",
  },
  {
    title: "AI cleaning and prep",
    body: "Ask in plain English to fix errors, fill missing values, or remove duplicates and outliers. See the before and after side by side.",
  },
  {
    title: "Studio-grade visuals",
    body: "Waterfall, funnel, heatmap, treemap and more, with one-click export to PNG, JPG, SVG or WEBP.",
  },
];

const TRUST_POINTS = [
  {
    title: "Minutes, not hours",
    body: "Connect your data and get a finished chart in minutes. No dashboard building, no waiting on an analyst, no learning curve.",
  },
  {
    title: "One tool, every data source",
    body: "Spreadsheets, CSV and Excel files, SQL and NoSQL databases, all analyzed the same simple way, instead of juggling separate tools.",
  },
  {
    title: "Answers, not just charts",
    body: "Every chart comes with a plain-English explanation of what it means, so you do not have to interpret the numbers yourself.",
  },
  {
    title: "Full access, free",
    body: "Every feature, unlimited, with no credit card and no seat limits, unlike most analytics tools that lock the best parts behind a paid plan.",
  },
];

function ChartTypeIcon({ chartType }: { chartType: string | null }) {
  const t = (chartType || "").toLowerCase();
  if (t.includes("pie")) {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21.21 15.89A10 10 0 1 1 8 2.83" />
        <path d="M22 12A10 10 0 0 0 12 2v10z" />
      </svg>
    );
  }
  if (t.includes("scatter")) {
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
      {/* ---- Public header ---- */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <Link to="/" className="flex items-center gap-2.5">
          <span className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary to-accent flex items-center justify-center text-white font-bold text-sm shrink-0">
            G
          </span>
          <span className="text-lg font-extrabold gradient-text">GD360 Analytics</span>
        </Link>
        <div className="flex items-center gap-3">
          <ThemeToggle />
          <Link to="/login" className="btn-secondary text-sm">Log in</Link>
          <Link to="/register" className="btn-primary text-sm">Sign up free</Link>
        </div>
      </div>

      {/* ---- Hero ---- */}
      <div className="max-w-5xl mx-auto px-6 pt-16 pb-14 text-center">
        <div className="pill mx-auto mb-6 w-fit">
          <span>&#10024;</span> No-code, AI-driven end-to-end analytics
        </div>
        <h1 className="text-4xl sm:text-5xl md:text-6xl font-extrabold leading-tight tracking-tight">
          Ask your data anything.
          <br />
          <span className="gradient-text">Get answers, insights and charts.</span>
        </h1>
        <p className="text-muted text-base sm:text-lg mt-6 max-w-2xl mx-auto leading-relaxed">
          GD360 connects to your data, writes the queries, cleans and prepares it, picks the right
          visualization, and explains what it means in plain English. No SQL. No Python. No code.
        </p>
        <div className="flex items-center justify-center gap-3 mt-8 flex-wrap">
          <Link to="/register" className="btn-primary text-base px-6 py-3">
            Create free account &rarr;
          </Link>
          <Link to="/login" className="btn-secondary text-base px-6 py-3">
            Log in
          </Link>
        </div>
        <div className="flex items-center justify-center gap-6 mt-8 text-sm text-muted flex-wrap">
          <span className="flex items-center gap-1.5">
            <span className="text-accent">&#128737;</span> Read-only. Your data is never modified.
          </span>
          <span className="hidden sm:inline text-border">|</span>
          <span className="flex items-center gap-1.5">
            <span>&#128451;</span> CSV &middot; Excel &middot; JSON &middot; SQL &middot; NoSQL
          </span>
          <span className="hidden sm:inline text-border">|</span>
          <span className="flex items-center gap-1.5">
            <span>&#128200;</span> {CHART_TYPES.length} chart types
          </span>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-6 pb-16">
        {/* ---- Feature cards ---- */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
          {FEATURES.map((f) => (
            <div key={f.title} className="card p-6">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary/20 to-accent/20 flex items-center justify-center text-lg mb-4">
                &#10024;
              </div>
              <div className="font-semibold mb-1.5">{f.title}</div>
              <div className="text-sm text-muted leading-relaxed">{f.body}</div>
            </div>
          ))}
        </div>

        {/* ---- Chart type chip strip ---- */}
        <div className="card p-6 mb-10 text-center">
          <div className="text-xs font-semibold tracking-wide text-muted mb-4">
            {CHART_TYPES.length} WAYS TO SEE YOUR DATA
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
        <div className="card p-10 text-center">
          <h2 className="text-2xl font-bold mb-2">Ready to see your data differently?</h2>
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
