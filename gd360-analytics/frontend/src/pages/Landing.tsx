import { Link } from "react-router-dom";
import type { CSSProperties } from "react";
import ThemeToggle from "../components/ThemeToggle";
import { connectionKindMeta } from "../components/DataSourceForm";

// 2026-09-25c (landing page elite pass): a full copy + chrome rewrite,
// replacing the original earnest/explainer tone with the tighter,
// declarative register asked for ("messaging like Google, Nvidia,
// Apple") - short lines, one idea per sentence, real claims only.
// Deliberately NOT added: customer counts, logos or testimonials - GD360
// doesn't have real ones to show yet, and inventing them is exactly the
// kind of thing that backfires the moment someone asks for a source. Once
// there are real numbers or real quotes, they belong in a proper social-
// proof section - this file has room for one (see the comment above the
// final CTA) but doesn't fabricate one now.
//
// Visual system: reuses the same .dash-card/.dash-icon-chip/.dash-accent-N
// premium chrome the Dashboard Builder round already shipped (see
// index.css's own updated comment on that section) rather than inventing
// a second visual language for the marketing page - so the landing page
// and the product it's selling finally look like the same thing.

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
    body: "A database, a warehouse, or a file. Read-only and encrypted, every outbound IP published - so IT signs off before you connect.",
  },
  {
    step: "02",
    title: "Ask",
    body: "“Which region grew fastest?” Plain English in. GD360 cleans what it needs to, picks the chart, and runs the real numbers.",
  },
  {
    step: "03",
    title: "Verify",
    body: "A chart, a plain-English insight, and one button that independently re-audits the answer against the numbers it actually computed - every time.",
  },
];

function CheckMarkIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

function PromptToChartIcon({ className = "w-[18px] h-[18px]" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      <path d="M8 12l2-2 2 2 4-4" />
    </svg>
  );
}

function CleanPrepIcon({ className = "w-[18px] h-[18px]" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 5h16M7 12h10M10 19h4" />
    </svg>
  );
}

function VerifiedIcon({ className = "w-[18px] h-[18px]" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2l8 4v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}

function GuidedIcon({ className = "w-[18px] h-[18px]" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M15 9l-2 5-5 2 2-5z" />
    </svg>
  );
}

// Same 0..5 rotation DashboardBlocks.tsx's KpiTile uses (index.css's
// --dash-accent-0..5) - hardcoded per item here rather than imported,
// since there are only ever exactly 4 features and 4 trust points and a
// shared hashing helper would be more code than the two fixed arrays it
// replaces.
const FEATURES = [
  {
    accent: 0,
    title: "Ask. See it built.",
    body: "Describe what you want, in plain English. GD360 picks the right chart from 24+ types, shapes the data, and renders it — live. No SQL. No drag-and-drop builder.",
    Icon: PromptToChartIcon,
  },
  {
    accent: 1,
    title: "Nothing hidden. Ever.",
    body: "Every prep step — duplicates removed, gaps handled, types fixed — written out in plain English, with the real row counts behind it. Never a black box.",
    Icon: CleanPrepIcon,
  },
  {
    accent: 2,
    title: "Trust, verified twice.",
    body: "Every insight is checked the moment it's written — then you can check it again yourself, anytime. One click re-audits the numbers before you act on them.",
    Icon: VerifiedIcon,
  },
  {
    accent: 4,
    title: "Never start from zero.",
    body: "New to data? Goku shows you what to clean, what to explore, and what to ask next — built for people who've never opened a BI tool.",
    Icon: GuidedIcon,
  },
];

const TRUST_POINTS = [
  {
    accent: 0,
    title: "Minutes. Not meetings.",
    body: "Connect your data, get a finished, verified chart in minutes. No dashboard to build. No analyst to wait on. No learning curve.",
  },
  {
    accent: 2,
    title: "One tool. Every source.",
    body: "Spreadsheets, CSV and Excel files, SQL and NoSQL databases — analyzed the same simple way. No more juggling five different tools.",
  },
  {
    accent: 3,
    title: "Read-only. Always.",
    body: "GD360 never modifies your data. Credentials are encrypted, and every outbound IP address is published — so IT signs off before you connect.",
  },
  {
    accent: 4,
    title: "Free. Genuinely.",
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

// The hero's "proof, not decoration" product preview - a small, static
// stand-in for the real Dashboard Builder chrome (the same KPI-tile and
// smooth-line-chart look DashboardBlocks.tsx actually renders), inside a
// plain browser-chrome frame. Hand-built here rather than importing the
// real chart/dashboard components: this needs no live data source, no
// API calls and no auth to render correctly on a public marketing page
// visited by someone who hasn't signed up yet.
function HeroProductPreview() {
  return (
    <div className="dash-card overflow-hidden text-left max-w-3xl mx-auto">
      <div className="h-9 flex items-center gap-1.5 px-4 border-b border-border">
        <span className="w-2 h-2 rounded-full bg-border" />
        <span className="w-2 h-2 rounded-full bg-border" />
        <span className="w-2 h-2 rounded-full bg-border" />
        <span className="ml-3 text-[10.5px] text-muted">app.gd360analytics.com/workspace</span>
      </div>
      <div className="p-5 sm:p-6 grid grid-cols-3 gap-3.5">
        <div className="dash-card dash-card--accented p-3.5" style={{ "--dash-card-accent-color": "rgb(var(--dash-accent-0))" } as CSSProperties}>
          <div className="text-[9.5px] font-semibold uppercase tracking-wide text-muted">Total Hours Worked</div>
          <div className="dash-kpi-value text-xl font-bold mt-1.5">210.5</div>
        </div>
        <div className="dash-card dash-card--accented p-3.5" style={{ "--dash-card-accent-color": "rgb(var(--dash-accent-2))" } as CSSProperties}>
          <div className="text-[9.5px] font-semibold uppercase tracking-wide text-muted">Total Earnings</div>
          <div className="dash-kpi-value text-xl font-bold mt-1.5">$1,684.00</div>
        </div>
        <div className="dash-card dash-card--accented p-3.5" style={{ "--dash-card-accent-color": "rgb(var(--dash-accent-1))" } as CSSProperties}>
          <div className="text-[9.5px] font-semibold uppercase tracking-wide text-muted">Unpaid Earnings</div>
          <div className="dash-kpi-value text-xl font-bold mt-1.5">$1,048.00</div>
        </div>
        <div className="dash-card col-span-2 p-3.5">
          <div className="text-[9.5px] font-semibold uppercase tracking-wide text-muted mb-2">Hours Worked Over Time</div>
          <svg viewBox="0 0 460 100" className="w-full h-auto" role="img" aria-label="Hours worked trending up over the last two weeks">
            <defs>
              <linearGradient id="heroPreviewGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="rgb(var(--color-accent))" stopOpacity="0.3" />
                <stop offset="100%" stopColor="rgb(var(--color-accent))" stopOpacity="0" />
              </linearGradient>
            </defs>
            <path
              d="M10,80 C40,80 40,26 70,26 C95,26 95,58 120,58 C145,58 145,74 170,74 C195,74 195,40 220,40 C245,40 245,13 270,13 C295,13 295,54 320,54 C345,54 345,29 370,29 C395,29 395,78 420,78 C445,78 445,45 450,45 L450,90 L10,90 Z"
              fill="url(#heroPreviewGrad)"
            />
            <path
              d="M10,80 C40,80 40,26 70,26 C95,26 95,58 120,58 C145,58 145,74 170,74 C195,74 195,40 220,40 C245,40 245,13 270,13 C295,13 295,54 320,54 C345,54 345,29 370,29 C395,29 395,78 420,78 C445,78 445,45 450,45"
              fill="none"
              stroke="rgb(var(--color-accent))"
              strokeWidth="2.5"
              strokeLinecap="round"
            />
          </svg>
        </div>
        <div className="dash-card p-3.5 flex flex-col items-center justify-center">
          <div className="text-[9.5px] font-semibold uppercase tracking-wide text-muted self-start mb-1">Weekly Utilization</div>
          <svg viewBox="0 0 200 118" className="w-full h-auto" role="img" aria-label="Weekly utilization at 82 percent">
            <path d="M28,96 A72,72 0 0 1 172,96" fill="none" stroke="rgb(var(--color-border))" strokeWidth="11" strokeLinecap="round" />
            <path d="M28,96 A72,72 0 0 1 160,56.7" fill="none" stroke="rgb(var(--color-accent))" strokeWidth="11" strokeLinecap="round" />
            <text x="100" y="90" textAnchor="middle" style={{ fontSize: "21px", fontWeight: 700, fill: "rgb(var(--color-text))" }}>
              82%
            </text>
          </svg>
        </div>
      </div>
    </div>
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
          <Link to="/login" className="btn-secondary text-xs sm:text-sm px-3 py-1.5 sm:px-4 sm:py-2" style={{ borderRadius: "999px" }}>
            Log in
          </Link>
          <Link to="/register" className="btn-primary text-xs sm:text-sm px-3 py-1.5 sm:px-4 sm:py-2" style={{ borderRadius: "999px" }}>
            Sign up free
          </Link>
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
            <CheckMarkIcon className="w-3.5 h-3.5" /> Verified. Not guessed.
          </div>
          <h1 className="text-3xl sm:text-5xl md:text-6xl font-extrabold leading-tight tracking-tight">
            Ask anything.
            <br />
            Know it&rsquo;s{" "}
            <span className="relative inline-block whitespace-nowrap">
              <span className="relative z-10">true.</span>
              <span aria-hidden className="absolute left-0 right-0 bottom-1 sm:bottom-2 h-[0.32em] bg-primary/[0.22] -z-0 rounded-sm" />
            </span>
          </h1>
          <p className="text-muted text-base sm:text-lg mt-6 max-w-2xl mx-auto leading-relaxed">
            Connect any database, warehouse or file. Ask in plain English. Get a chart and an insight —
            cleaned, computed and independently checked, never guessed. No SQL. No Python. No code.
          </p>
          <div className="flex items-center justify-center gap-3 mt-8 flex-wrap">
            <Link to="/register" className="btn-primary text-base px-6 py-3" style={{ borderRadius: "999px" }}>
              Create free account &rarr;
            </Link>
            <Link to="/login" className="btn-secondary text-base px-6 py-3" style={{ borderRadius: "999px" }}>
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

          {/* ---- Hero product preview ----
              2026-09-25c: the "app, not a chart" proof the competitor
              comparison asked for - a small live-look preview of the real
              product's premium chrome, right under the fold, instead of
              only claiming it in copy. */}
          <div className="mt-14">
            <HeroProductPreview />
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 sm:px-6 pb-16">
        {/* ---- Feature ledger ----
            2026-09-25c: the same dash-card/dash-icon-chip/accent-hairline
            treatment DashboardBlocks.tsx's KpiTile uses, replacing the
            original spec-sheet/verify-bar layout - see index.css's own
            comment on why these classes are shared now. */}
        <div className="mb-10 mt-4">
          <div className="text-center max-w-2xl mx-auto mb-8">
            <span className="text-[11px] font-bold tracking-[0.15em] text-accent">ONE STANDARD: NEVER GUESS</span>
            <h2 className="text-2xl sm:text-3xl font-bold mt-3 tracking-tight">Answers you can stand behind</h2>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {FEATURES.map((f) => (
              <div
                key={f.title}
                className="dash-card dash-card--accented p-6"
                style={{ "--dash-card-accent-color": `rgb(var(--dash-accent-${f.accent}))` } as CSSProperties}
              >
                <div className={`dash-icon-chip dash-accent-${f.accent} mb-4`}>
                  <f.Icon />
                </div>
                <div className="font-semibold text-[17px] mb-1.5">{f.title}</div>
                <div className="text-sm text-muted leading-relaxed">{f.body}</div>
              </div>
            ))}
          </div>
        </div>

        {/* ---- How it works ---- */}
        <div className="dash-card p-6 sm:p-8 mb-8">
          <div className="text-center mb-8">
            <h2 className="text-xl sm:text-2xl font-bold">Three steps. Zero guesswork.</h2>
          </div>
          <div className="relative grid grid-cols-1 sm:grid-cols-3 gap-8 sm:gap-6">
            <div aria-hidden className="hidden sm:block absolute top-[1.15rem] left-[16.5%] right-[16.5%] h-px bg-border" />
            {HOW_IT_WORKS.map((s) => (
              <div key={s.step} className="relative text-center sm:text-left">
                <div className="mono-figure text-xs text-primary font-semibold mb-3 bg-surface inline-block pr-3 sm:pr-0 sm:bg-transparent">
                  {s.step}
                </div>
                <div className="font-semibold mb-1.5">{s.title}</div>
                <div className="text-sm text-muted leading-relaxed">{s.body}</div>
              </div>
            ))}
          </div>
        </div>

        {/* ---- Chart type chip strip ---- */}
        <div className="dash-card p-6 mb-10 text-center">
          <div className="text-xs font-semibold tracking-widest text-muted mb-4">
            <span className="mono-figure text-primary">{CHART_TYPES.length}+</span> WAYS TO SEE WHAT MATTERS
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
            <h2 className="text-2xl font-bold">Built for the team that refuses to guess</h2>
            <p className="text-muted mt-2 max-w-2xl mx-auto">
              Not a longer feature list — fewer reasons to second-guess your data.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {TRUST_POINTS.map((t) => (
              <div
                key={t.title}
                className="dash-card dash-card--accented p-6"
                style={{ "--dash-card-accent-color": `rgb(var(--dash-accent-${t.accent}))` } as CSSProperties}
              >
                <div className="font-semibold mb-1.5">{t.title}</div>
                <div className="text-sm text-muted leading-relaxed">{t.body}</div>
              </div>
            ))}
          </div>
        </div>

        {/* ---- Final CTA ----
            2026-09-25c: a real social-proof row (logos/testimonials/a
            customer count) belongs right above this once there are real
            ones to show - deliberately not faked here (see this file's
            top comment). The glow band itself is new (.landing-cta-glow,
            index.css) - a themed radial wash instead of a flat card. */}
        <div className="landing-cta-glow rounded-3xl border border-border p-6 sm:p-10 text-center">
          <h2 className="text-xl sm:text-2xl font-bold mb-2">Your data has answers. Go ask it.</h2>
          <p className="text-muted mb-6">Free, unlimited plan. No credit card required.</p>
          <div className="flex items-center justify-center gap-3 flex-wrap">
            <Link to="/register" className="btn-primary text-base px-6 py-3" style={{ borderRadius: "999px" }}>
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
