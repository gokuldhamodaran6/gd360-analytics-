// 2026-10-10: quick chart controls for every chart in Instant Answers and
// Guided Analysis (answers, step results, answer dashboards). One click
// switches the view (Auto, Bar, Horizontal, Line, Area, Pie, Table); "Style"
// sets the palette, data labels, legend and grid. The choice is remembered
// per chart in this browser. The drawing itself is the shared chart engine
// (components/WorkspaceChart) - a view it cannot draw honestly falls back
// to the table, with the reason.
import { useEffect, useMemo, useRef, useState } from "react";
import WorkspaceChart from "../components/WorkspaceChart";
import { PALETTES, type ChartStyle, type PaletteId } from "../lib/chartStyle";
import type { ResultColumn } from "../api/projects";
import { DataTable } from "./Visuals";

type View = "auto" | "bar" | "horizontal_bar" | "line" | "area" | "pie" | "table";
type Prefs = { view: View; style: Partial<ChartStyle> };

const VIEWS: { id: View; label: string; icon: JSX.Element }[] = [
  { id: "auto", label: "Auto", icon: <path d="M12 3l2.2 5.3L20 9l-4.4 3.8L17 18.5 12 15.6 7 18.5l1.4-5.7L4 9l5.8-.7z" /> },
  { id: "bar", label: "Bars", icon: <path d="M5 20V10M12 20V4M19 20v-7" /> },
  { id: "horizontal_bar", label: "Horizontal bars", icon: <path d="M4 5h9M4 12h16M4 19h6" /> },
  { id: "line", label: "Line", icon: <path d="M3 17l5-6 4 3 8-9" /> },
  { id: "area", label: "Area", icon: <path d="M3 18l5-7 4 3 8-8v12z" /> },
  { id: "pie", label: "Pie", icon: <><path d="M12 3a9 9 0 1 0 9 9h-9z" /><path d="M15 3.5A9 9 0 0 1 20.5 9H15z" /></> },
  { id: "table", label: "Table", icon: <><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="M3.5 10h17M3.5 15h17M10 10v9.5" /></> },
];

const key = (id: string) => `gd360_chart_prefs:${id}`;

function loadPrefs(id: string, fallback: View): Prefs {
  try {
    const raw = localStorage.getItem(key(id));
    if (raw) {
      const p = JSON.parse(raw);
      if (p && typeof p === "object") return { view: VIEWS.some((v) => v.id === p.view) ? p.view : fallback, style: p.style || {} };
    }
  } catch {
    /* a per-browser convenience */
  }
  return { view: fallback, style: {} };
}

function savePrefs(id: string, p: Prefs) {
  try {
    localStorage.setItem(key(id), JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

export default function ChartWithControls({
  id, title, columns, rows, truncated, chartType, minHeight = 260, tableAlongside = false,
}: {
  id: string;
  title: string;
  columns: ResultColumn[];
  rows: Record<string, unknown>[];
  truncated?: boolean;
  chartType?: string | null;
  minHeight?: number;
  // the table is already shown next to the chart (a Guided step): no Table view
  tableAlongside?: boolean;
}) {
  const initial: View = chartType === "table" ? "table" : "auto";
  const [prefs, setPrefs] = useState<Prefs>(() => loadPrefs(id, initial));
  const [styleOpen, setStyleOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const update = (next: Partial<Prefs>) =>
    setPrefs((cur) => {
      const merged = { ...cur, ...next, style: { ...cur.style, ...(next.style || {}) } };
      savePrefs(id, merged);
      return merged;
    });

  useEffect(() => {
    if (!styleOpen) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent) {
        if (e.key === "Escape") setStyleOpen(false);
        return;
      }
      if (!ref.current?.contains(e.target as Node)) setStyleOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [styleOpen]);

  const views = tableAlongside ? VIEWS.filter((v) => v.id !== "table") : VIEWS;
  const view = tableAlongside && prefs.view === "table" ? "auto" : prefs.view;
  const effectiveType = view === "auto" ? (chartType && chartType !== "table" ? chartType : null) : view;
  const style = prefs.style;
  const styled = Object.keys(style).length > 0;
  const overrides = useMemo(() => (styled ? style : null), [styled, style]);
  const palette = (style.paletteId as PaletteId | undefined) || "original";

  return (
    <div className="flex flex-col gap-2.5 min-w-0" data-chart-controls="">
      <div className="flex items-center justify-between gap-2 flex-wrap" ref={ref}>
        <div role="radiogroup" aria-label="Chart view" className="flex gap-0.5 p-[3px] rounded-ctl border border-border bg-base">
          {views.map((v) => {
            const on = view === v.id;
            return (
              <button
                key={v.id}
                type="button"
                role="radio"
                aria-checked={on}
                aria-label={v.label}
                title={v.label}
                onClick={() => update({ view: v.id })}
                className={`ui-focus w-8 h-7 grid place-items-center rounded-[7px] transition-colors ${on ? "bg-subtle text-text" : "text-muted hover:text-text"}`}
                data-chart-view={v.id}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{v.icon}</svg>
              </button>
            );
          })}
        </div>
        {view !== "table" && (
          <div className="relative">
            <button
              type="button"
              onClick={() => setStyleOpen((o) => !o)}
              aria-expanded={styleOpen}
              className={`ui-focus h-8 px-3 rounded-ctl border text-caption inline-flex items-center gap-1.5 ${styled ? "border-kind-analysis-border text-text" : "border-border text-secondary hover:text-text"}`}
              data-chart-style=""
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="13.5" cy="6.5" r="2" /><circle cx="17.5" cy="11.5" r="2" /><circle cx="8.5" cy="7.5" r="2" /><path d="M12 22a10 10 0 1 1 10-10c0 2-1.5 3-3.5 3H16a2 2 0 0 0-1.5 3.3A2 2 0 0 1 12 22z" /></svg>
              Style
            </button>
            {styleOpen && (
              <div role="dialog" aria-label="Chart style" className="absolute right-0 top-[calc(100%+6px)] z-30 w-[260px] rounded-card border border-border bg-surface shadow-pop p-3 flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <span className="text-caption text-muted">Colours</span>
                  <div className="grid grid-cols-2 gap-1.5">
                    <button type="button" onClick={() => update({ style: { paletteId: "original" } })}
                      className={`ui-focus h-8 px-2 rounded-ctl border text-caption text-left ${palette === "original" ? "border-kind-analysis-border text-text" : "border-border text-secondary"}`}>
                      GD360
                    </button>
                    {PALETTES.map((p) => (
                      <button key={p.id} type="button" onClick={() => update({ style: { paletteId: p.id } })} title={p.name}
                        className={`ui-focus h-8 px-2 rounded-ctl border flex items-center gap-1.5 ${palette === p.id ? "border-kind-analysis-border" : "border-border"}`}>
                        <span className="flex gap-0.5" aria-hidden="true">
                          {p.colors.slice(0, 4).map((c) => <span key={c} className="w-2.5 h-2.5 rounded-[3px]" style={{ background: c }} />)}
                        </span>
                        <span className="text-caption text-secondary truncate">{p.name}</span>
                      </button>
                    ))}
                  </div>
                </div>
                {([
                  ["dataLabels", "Values on the chart"],
                  ["showLegend", "Legend"],
                  ["showGrid", "Grid lines"],
                ] as const).map(([k, label]) => {
                  const on = style[k] !== undefined ? Boolean(style[k]) : k !== "dataLabels";
                  return (
                    <label key={k} className="flex items-center justify-between gap-2 text-ui text-text cursor-pointer">
                      {label}
                      <input type="checkbox" checked={on} onChange={(e) => update({ style: { [k]: e.target.checked } as Partial<ChartStyle> })} className="w-4 h-4 accent-[rgb(var(--color-kind-analysis))]" />
                    </label>
                  );
                })}
                {styled && (
                  <button type="button" className="self-start text-caption text-muted hover:text-text underline" onClick={() => { setPrefs({ view: prefs.view, style: {} }); savePrefs(id, { view: prefs.view, style: {} }); }}>
                    Reset style
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      {view === "table" ? (
        <DataTable visual={{ type: "chart", title, columns, rows, truncated }} />
      ) : (
        <div className="min-w-0 [&>div.card]:border-0 [&>div.card]:bg-transparent [&>div.card]:p-0 [&>div.card]:shadow-none [&>div.card]:rounded-none [&>div.card:hover]:shadow-none">
          <WorkspaceChart
            columns={columns as any}
            rows={rows as any}
            truncated={truncated}
            chartType={effectiveType}
            styleOverrides={overrides}
            title={title}
            id={id}
            variant="full"
            minHeight={minHeight}
          />
        </div>
      )}
    </div>
  );
}
