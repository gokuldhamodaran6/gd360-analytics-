/** @type {import("tailwindcss").Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  // The sequential ramp and status tones are often picked by index at
  // runtime (heatmap cells, a pill whose tone comes from the API), which
  // the JIT scanner can't see - keep every step compiled.
  safelist: [{ pattern: /^(bg|text|border)-(seq-[1-6]|series-[1-6]|good|warning|danger|good-fill|warning-fill|danger-fill|good-border|warning-border|danger-border)$/ }],
  theme: {
    extend: {
      colors: {
        base: "rgb(var(--color-base) / <alpha-value>)",
        surface: "rgb(var(--color-surface) / <alpha-value>)",
        surface2: "rgb(var(--color-surface2) / <alpha-value>)",
        border: "rgb(var(--color-border) / <alpha-value>)",
        primary: "rgb(var(--color-primary) / <alpha-value>)",
        accent: "rgb(var(--color-accent) / <alpha-value>)",
        text: "rgb(var(--color-text) / <alpha-value>)",
        muted: "rgb(var(--color-muted) / <alpha-value>)",
        // 2026-10-06 design-system tokens (see the matching block in
        // src/index.css for what each one is for and its light/dark values).
        subtle: "rgb(var(--color-subtle) / <alpha-value>)",
        "border-strong": "rgb(var(--color-border-strong) / <alpha-value>)",
        secondary: "rgb(var(--color-secondary) / <alpha-value>)",
        faint: "rgb(var(--color-faint) / <alpha-value>)",
        tint: "rgb(var(--color-tint) / <alpha-value>)",
        "tint-border": "rgb(var(--color-tint-border) / <alpha-value>)",
        "brand-ink": "rgb(var(--color-brand-ink) / <alpha-value>)",
        "on-primary": "rgb(var(--color-on-primary) / <alpha-value>)",
        good: "rgb(var(--color-good) / <alpha-value>)",
        "good-fill": "rgb(var(--color-good-fill) / <alpha-value>)",
        "good-border": "rgb(var(--color-good-border) / <alpha-value>)",
        warning: "rgb(var(--color-warning) / <alpha-value>)",
        "warning-fill": "rgb(var(--color-warning-fill) / <alpha-value>)",
        "warning-border": "rgb(var(--color-warning-border) / <alpha-value>)",
        danger: "rgb(var(--color-danger) / <alpha-value>)",
        "danger-fill": "rgb(var(--color-danger-fill) / <alpha-value>)",
        "danger-border": "rgb(var(--color-danger-border) / <alpha-value>)",
        "seq-1": "rgb(var(--color-seq-1) / <alpha-value>)",
        "seq-2": "rgb(var(--color-seq-2) / <alpha-value>)",
        "seq-3": "rgb(var(--color-seq-3) / <alpha-value>)",
        "seq-4": "rgb(var(--color-seq-4) / <alpha-value>)",
        "seq-5": "rgb(var(--color-seq-5) / <alpha-value>)",
        "seq-6": "rgb(var(--color-seq-6) / <alpha-value>)",
        // Chart series 1..6 (brief order: blue, orange, aqua, yellow,
        // magenta, green) - for legend swatches, direct labels, CSS bars.
        "series-1": "rgb(var(--color-series-1) / <alpha-value>)",
        "series-2": "rgb(var(--color-series-2) / <alpha-value>)",
        "series-3": "rgb(var(--color-series-3) / <alpha-value>)",
        "series-4": "rgb(var(--color-series-4) / <alpha-value>)",
        "series-5": "rgb(var(--color-series-5) / <alpha-value>)",
        "series-6": "rgb(var(--color-series-6) / <alpha-value>)",
        // 2026-10-10: the three kinds of work (see src/lib/kinds.tsx).
        "kind-answer": "rgb(var(--color-kind-answer) / <alpha-value>)",
        "kind-answer-fill": "rgb(var(--color-kind-answer-fill) / <alpha-value>)",
        "kind-answer-border": "rgb(var(--color-kind-answer-border) / <alpha-value>)",
        "kind-analysis": "rgb(var(--color-kind-analysis) / <alpha-value>)",
        "kind-analysis-fill": "rgb(var(--color-kind-analysis-fill) / <alpha-value>)",
        "kind-analysis-border": "rgb(var(--color-kind-analysis-border) / <alpha-value>)",
        "kind-dashboard": "rgb(var(--color-kind-dashboard) / <alpha-value>)",
        "kind-dashboard-fill": "rgb(var(--color-kind-dashboard-fill) / <alpha-value>)",
        "kind-dashboard-border": "rgb(var(--color-kind-dashboard-border) / <alpha-value>)",
      },
      fontFamily: {
        sans: ["Geist", "system-ui", "sans-serif"],
        mono: ["Geist Mono", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      fontSize: {
        // The brief's type scale, each with its line-height baked in.
        caption: ["12px", { lineHeight: "1.45" }],
        ui: ["13.5px", { lineHeight: "1.45" }],
        body: ["14px", { lineHeight: "1.45" }],
        section: ["16px", { lineHeight: "1.35" }],
        title: ["20px", { lineHeight: "1.3" }],
        kpi: ["28px", { lineHeight: "1.2" }],
      },
      borderRadius: {
        ctl: "var(--radius-ctl)",
        card: "var(--radius-card)",
      },
      letterSpacing: {
        caps: "0.04em",
      },
      boxShadow: {
        glow: "0 0 40px rgba(20,122,92,0.2)",
        card: "var(--shadow-card)",
        pop: "var(--shadow-pop)",
      },
      height: {
        ctl: "36px",
        "ctl-lg": "40px",
        chip: "32px",
        topbar: "56px",
      },
      width: {
        rail: "56px",
        "filter-rail": "260px",
        sheet: "420px",
      },
    },
  },
  plugins: [],
};
