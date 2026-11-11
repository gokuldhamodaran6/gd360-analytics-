// 2026-10-15 (R49): a designed dashboard (mockup boards 03 and 04). One header with the page tabs, filters as pills,
// a Home page that explains the dashboard, then pages of blocks on a 12-column grid - all drawn by board/charts.tsx
// from numbers the backend computed live (services/agent/board.py). The same component runs on the canvas beside
// the conversation and full-screen at /boards/:id; the Excel and PowerPoint downloads come from the same spec.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { boardsApi, type Block, type BoardSummary, type HomeData, type PageRun } from "../api/boards";
import { cap, Columns, Donut, fmt, HBars, HeroCurve, LineArea, setBoardCurrency, Spark, toneVar } from "./charts";
import { useThemeMode } from "../api/ThemeContext";
import { LiveMap } from "../dashboard/charts/LiveMap";
import type { BlockResult } from "../api/client";
import "./board.css";

function ago(iso?: string): string {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(iso).toLocaleDateString();
}

function Kpi({ b }: { b: Block }) {
  const big = fmt(b.value, b.unit);
  return (
    <div className={`bd-card bd-kpi${b.hero ? " hero" : ""}`} data-bd-block={b.kind} title={b.definition || undefined}>
      <div className="bd-kh"><span className="t">{b.title}</span>{b.sub && <span className="s">{b.sub}</span>}</div>
      <div className="bd-kb">
        <div className="bd-kv">
          <span className="v" style={b.tone === "bad" ? { color: "var(--bd-warn)" } : undefined}>{b.unit === "pct" ? <>{(b.value ?? 0).toFixed(1)}<small>%</small></> : big}</span>
          {b.note && <span className="n">{b.note}</span>}
        </div>
        {!b.hero && b.spark && b.spark.length > 2 && <div className="bd-ks"><Spark values={b.spark} tone={b.tone === "bad" ? "bad" : "accent"} /></div>}
        {!b.hero && b.stack && (
          <div className="bd-stack" aria-label={b.stack.map((s) => `${s.label} ${s.value}`).join(", ")}>
            {b.stack.map((s) => <i key={s.label} style={{ flex: Math.max(s.value, 1), background: toneVar(s.tone) }} title={`${s.label}: ${s.value.toLocaleString()}`} />)}
          </div>
        )}
      </div>
      {(b.chips || []).length > 0 && <div className="bd-chips">{(b.chips || []).map((c, i) => <span key={i} className={`bd-chip ${c.tone}`}>{c.text}</span>)}</div>}
      {b.hero && b.curve && b.curve.points.length > 1 && (
        <div className="bd-hc"><span className="s">{cap(b.unit === "pct" ? `rate by ${b.curve.label}` : b.curve.label)}</span><HeroCurve points={b.curve.points} unit={b.unit === "pct" ? "pct" : b.unit} /></div>
      )}
    </div>
  );
}

function Head({ b, right }: { b: Block; right?: React.ReactNode }) {
  return (
    <div className="bd-bh">
      <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}><span className="t">{b.title}</span>{b.sub && <span className="s">{b.sub}</span>}</div>
      {right}
    </div>
  );
}

function Table({ b }: { b: Block }) {
  const cols = b.columns || [];
  const cell = (v: any, unit?: string) => (unit ? fmt(typeof v === "number" ? v : null, unit as any) : v ?? "—");
  return (
    <div className="bd-card" data-bd-block={b.kind}>
      <Head b={b} />
      <div className="bd-tw">
        <table className="bd-table">
          <thead><tr>{cols.map((c) => <th key={c.key} className={c.align === "left" ? "l" : ""}>{c.label}</th>)}</tr></thead>
          <tbody>
            {(b.rows || []).map((r, i) => (
              <tr key={i}>{cols.map((c) => (
                <td key={c.key} className={c.align === "left" ? "l" : "n"} style={c.unit === "pp" && r[c.key] != null ? { color: r[c.key] > 0 ? "var(--bd-warn)" : "var(--bd-good)" } : undefined}>{cell(r[c.key], c.unit)}</td>
              ))}</tr>
            ))}
            {b.total && <tr className="tot">{cols.map((c) => <td key={c.key} className={c.align === "left" ? "l" : "n"}>{c.unit === "pp" ? "—" : cell(b.total![c.key], c.unit)}</td>)}</tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function List({ b }: { b: Block }) {
  return (
    <div className="bd-card" data-bd-block={b.kind}>
      <Head b={b} right={b.total != null ? <span className="bd-chip neutral">{Number(b.total).toLocaleString()} high risk</span> : undefined} />
      <div className="bd-list">
        {(b.rows || []).map((r: any, i: number) => (
          <div key={i} className="bd-li">
            <span className="rk">{i + 1}</span>
            <span className="who"><span className="id">{b.id_label ? `${cap(b.id_label)} ` : ""}{r.id}</span>{r.meta && <span className="mt">{r.meta}</span>}</span>
            <span className="tags">{(r.tags || []).map((t: string, j: number) => <span key={j} className="bd-tag">{t}</span>)}</span>
            <span className="sc">{r.score?.toFixed(2)}</span>
          </div>
        ))}
        {(b.rows || []).length === 0 && <span className="bd-muted">No current rows in the high tier with these filters.</span>}
      </div>
    </div>
  );
}

function Tiers({ b, verb }: { b: Block; verb: string }) {
  return (
    <div className="bd-card" data-bd-block={b.kind}>
      <Head b={b} />
      <div className="bd-tiers">
        {(b.tiers || []).map((t) => (
          <div key={t.key} className={`bd-tier ${t.key}`}>
            <span className="v">{t.count.toLocaleString()}</span><span className="l">{t.label}</span>
            <span className="m">{t.rule}{t.hist != null ? ` · ${t.hist.toFixed(1)}% of this band ${verb} historically` : ""}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** R66: the live street map - the rows the backend grouped (one per location, or one per place name for the browser
 *  to place), drawn by the same LiveMap the chat and the classic dashboards use, in the board's light or dark theme. */
function MapBlock({ b, mode }: { b: Block; mode: string }) {
  const mKey = b.measure_label || "value";
  const result = useMemo<BlockResult>(() => {
    const rows = b.rows || [];
    const hasLL = rows.some((r: any) => r.lat != null && r.lon != null);
    const columns = [{ name: "place" }, ...(hasLL ? [{ name: "lat" }, { name: "lon" }] : []), { name: mKey }];
    const out = rows.map((r: any) => ({ place: r.place ?? "", ...(hasLL ? { lat: r.lat, lon: r.lon } : {}), [mKey]: r.value }));
    return { status: "ok", columns, rows: out, row_count: out.length } as BlockResult;
  }, [b.rows, mKey]);
  const block = useMemo(() => ({ id: b.id, title: b.title ?? null, config: {
    chart_type: "live_map", format: b.unit === "money" ? "currency" : "number", ...(b.unit === "money" ? { currency: b.currency || "USD" } : {}),
    ...(b.style && ["bubbles", "heat", "points"].includes(b.style) ? { map_mode: b.style } : {}),
  } }), [b.id, b.title, b.unit, b.currency, b.style]);
  return (
    <div className="bd-card bd-map" data-bd-block={b.kind}>
      <Head b={b} />
      {(b.rows || []).length ? <LiveMap result={result} block={block as any} minHeight={(b.h || 1) >= 2 ? 500 : 340} theme={mode === "dark" ? "dark" : "light"} />
        : <span className="bd-muted">Nothing to place on the map with these filters.</span>}
    </div>
  );
}

function BlockView({ b, onPick, verb, mode = "light" }: { b: Block; onPick: (kind: string, label: string) => void; verb: string; mode?: string }) {
  // R67: a block's own colour (from the editor) rides the same --bd-accent every chart already draws with
  const inner = <BlockInner b={b} onPick={onPick} verb={verb} mode={mode} />;
  return b.color ? <div className="bd-tint" style={{ "--bd-accent": b.color, "--bd-brand": b.color } as React.CSSProperties}>{inner}</div> : inner;
}

function BlockInner({ b, onPick, verb, mode = "light" }: { b: Block; onPick: (kind: string, label: string) => void; verb: string; mode?: string }) {
  if (b.type === "map") return <MapBlock b={b} mode={mode} />;
  if (b.type === "kpi") return <Kpi b={b} />;
  if (b.type === "table") return <Table b={b} />;
  if (b.type === "list") return <List b={b} />;
  if (b.type === "tiers") return <Tiers b={b} verb={verb} />;
  if (b.type === "bars") {
    const pick = b.kind === "o_dim" || b.kind === "g_dim" ? (l: string) => onPick(b.kind, l) : undefined;
    return (
      <div className="bd-card" data-bd-block={b.kind} data-bd-style={b.style || "bars"}>
        <Head b={b} right={b.show_n ? <span className="bd-muted" style={{ fontSize: 12 }}>{b.n_label || "rows"}</span> : undefined} />
        {b.style === "columns" ? <Columns rows={b.rows || []} unit={b.unit} onPick={pick} labels={b.labels !== false} />
          : b.style === "donut" ? <Donut rows={b.rows || []} unit={b.unit} onPick={pick} />
          : <HBars rows={b.rows || []} unit={b.unit} baseline={b.baseline} showN={b.show_n} showShare={b.show_share} decimals={b.decimals}
            onPick={pick} lollipop={b.style === "lollipop"} labels={b.labels !== false} />}
        {(b.rows || []).some((r: any) => r.small) && <span className="bd-note">* Under 30 in the group: too few to read much into.</span>}
        {b.note && <span className="bd-note">{b.note}</span>}
      </div>
    );
  }
  if (b.type === "line") {
    return (
      <div className="bd-card" data-bd-block={b.kind} data-bd-style={b.style || "area"}>
        <Head b={b} right={<span className="bd-legend">{b.compare ? <><i className="a" />This year <i className="c" />Year before</> : null}{b.baseline?.value != null ? <><i className="d" />{b.baseline.label}</> : null}</span>} />
        {b.style === "columns" ? <Columns rows={(b.points || []).map((p) => ({ label: p.label, value: p.value }))} unit={b.unit} height={210} labels={b.labels !== false} />
          : <LineArea points={b.points || []} compare={b.compare} unit={b.unit} baseline={b.baseline} fill={b.style !== "line"} labels={b.labels !== false} />}
      </div>
    );
  }
  if (b.type === "note") {
    return <div className="bd-card bd-note-card" data-bd-block="note"><div className="bd-bh"><span className="t">{b.title || "Note"}</span></div><p className="bd-notetext">{b.text}</p></div>;
  }
  return <div className="bd-card" data-bd-block={b.kind || "empty"}><div className="bd-bh"><span className="t">{b.title}</span></div><span className="bd-muted">{b.text}</span></div>;
}

/** R56: what the Dashboard studio adds around the board - a selected block with its edit bar, the "changed just now"
 *  outlines, the page and filters reported up so the canvas toolbar can act on them. */
export type BoardStudio = {
  selected: string | null; onSelect: (b: Block | null) => void; changed: Record<string, string>; float?: (b: Block) => ReactNode;
  onPage?: (id: string) => void; onFilters?: (f: Record<string, string>) => void; onRun?: (r: PageRun) => void; right?: ReactNode; editable?: boolean;
  // R67: Power BI-style editing - drag a block to move it, drag its corner to resize it, add and manage pages
  onMove?: (blockId: string, toIndex: number) => void; onResize?: (blockId: string, span: number, h: number) => void;
  onAddPage?: () => void; onPageMenu?: (pageId: string, action: "rename" | "delete") => void; page?: string | null;
  /** the editor's "draw a thumbnail of this dashboard" - called once the first page has drawn */
  onSnapshot?: (el: HTMLElement) => void;
  /** a comment chip on each block */
  blockExtra?: (b: Block) => ReactNode;
};

/** R67: the board in the app's own dark mode - a light theme's colours swapped for Midnight & Cobalt, keeping the
 *  board's own accent (a brand colour stays the brand colour). Exports keep the theme the owner chose. */
const MIDNIGHT = { bg: "#0A0A0B", card: "#131316", ink: "#EDEDEF", good: "#4ADE80", warn: "#F87171" };

function fresh(iso?: string): boolean {
  if (!iso) return false;
  const t = new Date(/Z$/.test(iso) ? iso : `${iso}Z`).getTime();
  return Number.isFinite(t) && Date.now() - t < 10 * 60 * 1000;
}

function PagePreview({ kinds }: { kinds: string[] }) {
  const k = kinds.join(",");
  if (/o_rate|g_measure/.test(k) && /o_count|g_count/.test(k)) return <div className="bd-pv grid"><i className="a" /><i /><i /><i /><i /></div>;
  if (/o_band|o_importance/.test(k)) return <div className="bd-pv bars"><i style={{ width: "92%" }} className="w" /><i style={{ width: "76%" }} className="w" /><i style={{ width: "50%" }} /><i style={{ width: "18%" }} className="a" /></div>;
  if (/o_dim|g_dim/.test(k)) return <div className="bd-pv cols">{[90, 100, 58, 40, 44, 34].map((h, i) => <i key={i} style={{ height: `${h}%` }} className={i < 2 ? "w" : "a"} />)}</div>;
  if (/o_tiers|o_list/.test(k)) return <div className="bd-pv people">{[0, 1, 2].map((i) => <span key={i}><b /><i style={{ width: `${86 - i * 14}%` }} /></span>)}</div>;
  if (/g_trend/.test(k)) return <div className="bd-pv line"><svg viewBox="0 0 100 40" preserveAspectRatio="none"><path d="M0,30 C20,26 30,18 50,20 C70,22 80,10 100,8" fill="none" stroke="var(--bd-accent)" strokeWidth="3" /></svg></div>;
  return <div className="bd-pv grid"><i /><i /><i /><i /></div>;
}

function Home({ h, sum, onOpen }: { h: HomeData; sum: BoardSummary; onOpen: (id: string) => void }) {
  return (
    <div className="bd-home" data-bd-home="">
      <div className="bd-hero">
        <div className="bd-hl">
          <span className="eb">{sum.source?.name}</span>
          <h1>{h.title}</h1>
          {h.subtitle && <p>{h.subtitle}</p>}
          <div className="bd-row">
            {h.pages[0] && <button type="button" className="bd-btn dark" onClick={() => onOpen(h.pages[0].id)} data-bd-open-overview="">Open {h.pages[0].name.toLowerCase()}</button>}
          </div>
        </div>
        <div className="bd-card bd-snap">
          <div className="bd-kh"><span className="t">Snapshot</span><span className="s">{sum.dates ? "latest data" : "group against group"}</span></div>
          <div className="bd-snapg">
            {h.kpis.map((k, i) => (
              <div key={i} className="bd-snapk">
                <span className="s">{k.label}</span>
                <span className="v">{fmt(k.value, k.unit)}</span>
                {k.note && <span className="bd-chip neutral">{k.note}</span>}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="bd-pages">
        {h.pages.map((p, i) => (
          <button key={p.id} type="button" className="bd-pagecard" onClick={() => onOpen(p.id)} data-bd-pagecard={p.id}>
            <PagePreview kinds={p.kinds} />
            <span className="t">{p.name}<span className="n">{String(i + 1).padStart(2, "0")}</span></span>
            <span className="m">{p.blurb}</span>
            <span className="o">Open page →</span>
          </button>
        ))}
      </div>
      <div className="bd-info">
        <div className="bd-card" data-bd-definitions=""><span className="bd-it">Definitions</span><ul>{h.definitions.map((d, i) => <li key={i}>{d}</li>)}</ul></div>
        <div className="bd-card"><span className="bd-it">About the data</span><ul>{h.about.map((d, i) => <li key={i}>{d}</li>)}</ul></div>
      </div>
    </div>
  );
}

const KIND_LABEL: Record<string, string> = {
  csv: "CSV file", excel: "Excel file", file: "File", bigquery: "BigQuery", postgres: "PostgreSQL", postgresql: "PostgreSQL", mysql: "MySQL",
  snowflake: "Snowflake", redshift: "Redshift", databricks: "Databricks", sqlserver: "SQL Server", ga4: "Google Analytics 4", sheets: "Google Sheets",
};

/** R67: which data a dashboard was built from - always on screen, with the table, rows and a way to open the source. */
function SourceChip({ sum, run }: { sum: BoardSummary; run: PageRun | null }) {
  const si = sum.source_info;
  const name = si?.name || sum.source?.name;
  if (!name) return null;
  const kind = si?.kind ? (KIND_LABEL[String(si.kind).toLowerCase()] || cap(String(si.kind).replace(/_/g, " "))) : null;
  const rows = run?.rows_total ?? si?.rows ?? null;
  const tip = [`Built from ${name}`, kind, si?.table ? `table ${si.table}` : null, rows != null ? `${rows.toLocaleString()} rows` : null,
    run ? `computed ${new Date(run.refreshed_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}` : null].filter(Boolean).join(" · ");
  const body = (
    <>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
      </svg>
      <span className="k">Data</span><b>{name}</b>{kind && <span className="t">{kind}</span>}{rows != null && <span className="t">{rows.toLocaleString()} rows</span>}
    </>
  );
  return si?.id
    ? <a className="bd-src" href={`/data?report=${encodeURIComponent(si.id)}`} title={`${tip} · open the source`} data-bd-source="">{body}</a>
    : <span className="bd-src" title={tip} data-bd-source="">{body}</span>;
}

export function BoardView({ id, embedded = false, version = 0, onAsk, studio, summary, runFn, publicView = false }: {
  id: string; embedded?: boolean; version?: number; onAsk?: (q: string) => void; studio?: BoardStudio;
  /** R67: a published link hands the summary in and computes pages through the public endpoint */
  summary?: BoardSummary; runFn?: (pageId: string | null, filters: Record<string, string>) => Promise<PageRun>; publicView?: boolean;
}) {
  const [sum, setSum] = useState<BoardSummary | null>(summary || null);
  const [page, setPage] = useState<string>(summary?.pages[0]?.id || "");
  const appMode = useThemeMode();
  const runRef = useRef(runFn);
  runRef.current = runFn;
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [run, setRun] = useState<PageRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    let live = true;
    if (summary) { setSum(summary); setPage((p) => (summary.pages.some((x) => x.id === p) ? p : summary.pages[0]?.id || "")); return () => { live = false; }; }
    boardsApi.get(id).then((s) => {
      if (!live) return;
      setSum(s);
      setFilters(s.default_filters || {});
      setPage((p) => (studio?.page && s.pages.some((x) => x.id === studio.page) ? studio.page : s.pages.some((x) => x.id === p) ? p : s.pages[0]?.id || ""));
    }).catch((e) => setErr(e?.response?.data?.detail || "Couldn't open this dashboard."));
    return () => { live = false; };
  }, [id, version]);

  const load = useCallback(async () => {
    if (!sum) return;
    const my = ++seq.current;
    setLoading(true);
    try {
      const r = runRef.current ? await runRef.current(page || null, filters) : await boardsApi.run(id, page || null, filters);
      if (my === seq.current) { setRun(r); setErr(null); }
    } catch (e: any) {
      if (my === seq.current) setErr(e?.response?.data?.detail || "Couldn't compute this page.");
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [id, page, filters, sum]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { studio?.onPage?.(page); }, [page]); // eslint-disable-line react-hooks/exhaustive-deps
  // R66: every number on this page is written in the board's currency (₹ for revenue_inr) - set before the blocks draw
  setBoardCurrency(run?.currency);
  useEffect(() => { studio?.onFilters?.(filters); }, [filters]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (run) studio?.onRun?.(run); }, [run]); // eslint-disable-line react-hooks/exhaustive-deps

  // R67: the app in dark mode shows a light-themed board dark too (the owner's theme still decides the exports)
  const dark = !!sum && (sum.palette.mode === "dark" || appMode === "dark");
  const style = useMemo(() => {
    if (!sum) return undefined;
    const p = sum.palette;
    const swap = appMode === "dark" && p.mode === "light";
    const accent = swap && !sum.accent && p.accent.toUpperCase() === "#2F6FE4" ? "#3D66FF" : p.accent;
    return { "--bd-bg": swap ? MIDNIGHT.bg : p.bg, "--bd-card": swap ? MIDNIGHT.card : p.card, "--bd-ink": swap ? MIDNIGHT.ink : p.ink,
      "--bd-accent": accent, "--bd-brand": accent, "--bd-warn": swap ? MIDNIGHT.warn : p.warn, "--bd-good": swap ? MIDNIGHT.good : p.good } as React.CSSProperties;
  }, [sum, appMode]);

  // R67: drag to move, drag the corner to resize - a live preview while the mouse is down, one save on release
  const gridRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number; over: number | null } | null>(null);
  const [size, setSize] = useState<{ id: string; span: number; h: number } | null>(null);
  const dragged = useRef(false);
  const startDrag = (e: React.PointerEvent, b: Block, index: number) => {
    if (!studio?.editable || !studio.onMove || e.button !== 0) return;
    const t = e.target as HTMLElement;
    if (t.closest(".sd-float, .sd-handle, button, select, a, input, textarea, .eu-map, .bd-cmt")) return;
    const x0 = e.clientX, y0 = e.clientY;
    let moving = false;
    dragged.current = false;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0, dy = ev.clientY - y0;
      if (!moving && Math.hypot(dx, dy) < 7) return;
      moving = true; dragged.current = true;
      const under = document.elementsFromPoint(ev.clientX, ev.clientY).map((el) => (el as HTMLElement).closest?.("[data-bd-cell]") as HTMLElement | null)
        .find((el) => el && el.dataset.bdCell !== b.id) || null;
      const over = under ? Number(under.dataset.bdIndex) : null;
      setDrag({ id: b.id, dx, dy, over: Number.isFinite(over as number) ? over : null });
    };
    const up = () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      setDrag((d) => {
        if (d && d.over != null && d.over !== index) studio.onMove?.(b.id, d.over);
        return null;
      });
      setTimeout(() => { dragged.current = false; }, 0);
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  const startResize = (e: React.PointerEvent, b: Block, cell: HTMLElement) => {
    e.preventDefault(); e.stopPropagation();
    const grid = gridRef.current;
    if (!grid || !studio?.onResize) return;
    const gw = grid.getBoundingClientRect().width;
    const col = (gw + 14) / 12;
    const r = cell.getBoundingClientRect();
    const rowH = r.height / Math.max(b.h || 1, 1);
    const x0 = e.clientX, y0 = e.clientY;
    let cur = { span: b.span, h: b.h || 1 };
    const move = (ev: PointerEvent) => {
      const span = Math.max(2, Math.min(12, Math.round((r.width + 14 + ev.clientX - x0) / col)));
      const h = Math.max(1, Math.min(4, Math.round((r.height + ev.clientY - y0) / Math.max(rowH, 120))));
      cur = { span, h };
      setSize({ id: b.id, span, h });
    };
    const up = () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      setSize(null);
      if (cur.span !== b.span || cur.h !== (b.h || 1)) studio.onResize?.(b.id, cur.span, cur.h);
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };

  // R67: a real picture of the dashboard for its card on the Dashboards list - drawn once the first page settles
  const snapped = useRef(false);
  useEffect(() => {
    if (snapped.current || !studio?.onSnapshot || !run || loading || !sum || page !== sum.pages[0]?.id || !run.blocks.length) return;
    const t = setTimeout(() => {
      const el = (gridRef.current?.parentElement as HTMLElement | null) || rootRef.current;
      if (el && !snapped.current) { snapped.current = true; studio.onSnapshot?.(el); }
    }, 3500);
    return () => clearTimeout(t);
  }, [run, loading, page, sum]); // eslint-disable-line react-hooks/exhaustive-deps

  const setF = (k: string, v: string) => setFilters((f) => { const n = { ...f }; if (!v || v === "All") delete n[k]; else n[k] = v; return n; });
  const onPick = (kind: string, label: string) => {
    void kind;
    const f = sum?.filters.find((x) => x.values.includes(label));
    if (f) setF(f.key, label);
  };
  const dl = async (kind: "xlsx" | "pptx") => {
    setBusy(kind); setMenu(false);
    try { await boardsApi.download(id, kind, filters, sum?.title); } catch { /* the menu stays usable */ } finally { setBusy(null); }
  };
  const nActive = Object.keys(filters).length;

  if (err && !sum) return <div className="bd bd-err" data-bd-error="">{err}</div>;
  if (!sum) return <div className="bd bd-loading"><span className="bd-spin" /> Opening the dashboard…</div>;
  return (
    <div ref={rootRef} className={`bd ${dark ? "dark" : "light"}${embedded ? " embedded" : ""}${studio ? " studio" : ""}${publicView ? " public" : ""}`} style={style} data-bd-board={id} data-bd-theme={sum.theme}
      onClick={studio ? (e) => { if (!(e.target as HTMLElement).closest(".bd-cell, .sd-float, .sd-menu")) studio.onSelect(null); } : undefined}>
      {studio && (
        <div className="bd-sbar" data-bd-studio-bar="">
          <nav className="bd-segs" role="tablist" aria-label="Pages">
            {sum.pages.map((p) => (
              <button key={p.id} type="button" role="tab" aria-selected={p.id === page} className={p.id === page ? "on" : ""} onClick={() => setPage(p.id)}
                onDoubleClick={studio.editable && studio.onPageMenu ? () => studio.onPageMenu?.(p.id, "rename") : undefined}
                onContextMenu={studio.editable && studio.onPageMenu ? (e) => { e.preventDefault(); studio.onPageMenu?.(p.id, "rename"); } : undefined}
                title={studio.editable ? "Double-click to rename" : undefined} data-bd-tab={p.id}>{p.name}</button>
            ))}
            {studio.editable && studio.onAddPage && <button type="button" className="bd-addpage" onClick={() => studio.onAddPage?.()} aria-label="Add a page" title="Add a page" data-bd-add-page="">+ Page</button>}
          </nav>
          {page !== "home" && sum.filters.map((f) => (
            <label key={f.key} className={`bd-pill${filters[f.key] ? " on" : ""}`}>
              <span className="k">{f.label}</span>
              <select value={filters[f.key] || "All"} onChange={(e) => setF(f.key, e.target.value)} data-bd-filter={f.key}>
                <option value="All">All</option>
                {f.values.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
          ))}
          {page !== "home" && nActive > 0 && <button type="button" className="bd-reset" onClick={() => setFilters({})} data-bd-reset="">Reset</button>}
          <SourceChip sum={sum} run={run} />
          <span className="bd-scope">{run ? `Computed ${new Date(run.refreshed_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}${page !== "home" ? ` · ${run.rows_in_view.toLocaleString()} of ${run.rows_total.toLocaleString()} ${sum.entities} in view` : ""}` : ""}</span>
          {studio.right}
        </div>
      )}
      {!studio && <header className="bd-top">
        <div className="bd-brand">
          <span className="mk" aria-hidden="true"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M4 18l5-6 4 3 7-8" /></svg></span>
          <span className="nm">{sum.title}</span>
          <span className="bd-live"><i />Live{run ? ` · ${ago(run.refreshed_at)}` : ""}</span>
          <SourceChip sum={sum} run={run} />
        </div>
        <nav className="bd-tabs" role="tablist" aria-label="Pages">
          {sum.pages.map((p) => (
            <button key={p.id} type="button" role="tab" aria-selected={p.id === page} className={p.id === page ? "on" : ""} onClick={() => setPage(p.id)} data-bd-tab={p.id}>{p.name}</button>
          ))}
        </nav>
        <div className="bd-actions">
          {!publicView && <span style={{ position: "relative" }}>
            <button type="button" className="bd-btn" onClick={() => setMenu((m) => !m)} aria-expanded={menu} data-bd-download="">{busy ? "Building…" : "Download"}</button>
            {menu && (
              <div className="bd-menu" role="menu" data-bd-download-menu="">
                <button type="button" role="menuitem" onClick={() => void dl("xlsx")} data-bd-xlsx=""><b>Excel</b><span>every page, the numbers behind each block, totals as formulas</span></button>
                <button type="button" role="menuitem" onClick={() => void dl("pptx")} data-bd-pptx=""><b>PowerPoint</b><span>one slide per page in this theme, native charts</span></button>
                <span className="foot">Downloads keep the filters you have set.</span>
              </div>
            )}
          </span>}
          {!embedded && !publicView && sum.conversation_id && <a className="bd-btn" href={`/chat/${sum.conversation_id}`}>Open conversation</a>}
          {embedded && <a className="bd-btn" href={`/boards/${id}`} target="_blank" rel="noreferrer" title="Open full screen">Full screen</a>}
        </div>
      </header>}

      {page !== "home" && !studio && (
        <div className="bd-filters" data-bd-filters="">
          {sum.filters.map((f) => (
            <label key={f.key} className={`bd-pill${filters[f.key] ? " on" : ""}`}>
              <span className="k">{f.label}</span>
              <select value={filters[f.key] || "All"} onChange={(e) => setF(f.key, e.target.value)} data-bd-filter={f.key}>
                <option value="All">All</option>
                {f.values.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
          ))}
          {nActive > 0 && <button type="button" className="bd-reset" onClick={() => setFilters({})} data-bd-reset="">Reset</button>}
          <span className="bd-scope">{run ? `${run.rows_in_view.toLocaleString()} of ${run.rows_total.toLocaleString()} ${sum.entities}` : ""}</span>
        </div>
      )}

      <main className="bd-body" aria-busy={loading}>
        {err && <div className="bd-err">{err}</div>}
        {run?.home && page === "home" && <Home h={run.home} sum={sum} onOpen={setPage} />}
        {page !== "home" && run && run.page.id === page && (
          run.empty ? <div className="bd-card bd-muted" style={{ padding: 40, textAlign: "center" }}>{run.empty} <button type="button" className="bd-reset" onClick={() => setFilters({})}>Reset filters</button></div> : (
            run.blocks.length === 0 ? (
              <div className="bd-emptypage" data-bd-empty-page="">
                <b>This page is empty</b>
                <span>{studio?.editable ? "Add a chart or a note from the toolbar above (Add chart · Text), or ask for one in the conversation." : "Nothing on this page yet."}</span>
              </div>
            ) : (
            <div ref={gridRef} className={`bd-grid${loading ? " dim" : ""}${drag ? " dragging" : ""}`} data-bd-page={page}>
              {run.blocks.map((b, index) => {
                const sel = studio?.selected === b.id;
                const ch = studio && fresh(studio.changed[b.id]);
                const sz = size && size.id === b.id ? size : null;
                const span = sz ? sz.span : b.span, h = sz ? sz.h : b.h;
                const moving = drag?.id === b.id;
                return (
                  <div key={b.id} className={`bd-cell${sel ? " sel" : ""}${ch ? " changed" : ""}${studio?.editable ? " pick" : ""}${moving ? " moving" : ""}${drag && drag.over === index ? " drop" : ""}${sz ? " sizing" : ""}`}
                    style={{ gridColumn: `span ${span}`, gridRow: h > 1 ? `span ${h}` : undefined, ...(moving ? { transform: `translate(${drag!.dx}px, ${drag!.dy}px)` } : {}) }}
                    data-bd-cell={b.id} data-bd-index={index}
                    onPointerDown={studio?.editable ? (e) => startDrag(e, b, index) : undefined}
                    onClick={studio?.editable ? (e) => { if (dragged.current || (e.target as HTMLElement).closest(".sd-float, select, a, .sd-handle, .bd-cmt")) return; studio.onSelect(sel ? null : b); } : undefined}>
                    {ch && <span className="bd-changed" data-bd-changed="">Changed just now</span>}
                    <BlockView b={{ ...b, span, h }} onPick={onPick} verb={sum.outcome?.verb || "had the outcome"} mode={dark ? "dark" : "light"} />
                    {studio?.blockExtra && <span className="bd-cmt">{studio.blockExtra(b)}</span>}
                    {sel && studio?.float && studio.float(b)}
                    {studio?.editable && studio.onResize && (
                      <i className="sd-handle sd-resize" title="Drag to resize" aria-label="Resize" data-bd-resize={b.id}
                        onPointerDown={(e) => startResize(e, b, (e.currentTarget.parentElement as HTMLElement))} />
                    )}
                    {sz && <span className="bd-sizetag">{span} / 12 · {h} {h === 1 ? "row" : "rows"}</span>}
                  </div>
                );
              })}
            </div>
            )
          )
        )}
        {(!run || (page !== "home" && run.page.id !== page)) && (
          <div className="bd-grid">{[6, 3, 3, 3, 3, 6, 6].map((s, i) => <div key={i} className="bd-cell" style={{ gridColumn: `span ${s}` }}><div className="bd-card bd-skel" /></div>)}</div>
        )}
        {page !== "home" && (
          <footer className="bd-foot">
            <span>{sum.definitions[0]}{sum.dates ? "" : " · no dates in the table, so comparisons are group against group"}</span>
            <span>{sum.source?.name} · {run ? `${run.rows_total.toLocaleString()} rows` : ""}{run?.applied.length ? ` · ${run.applied.join(", ")}` : ""}</span>
          </footer>
        )}
        {onAsk && page !== "home" && !studio && (
          <div className="bd-ask">
            <span>Change it by saying so in the conversation:</span>
            {["make it navy", sum.outcome ? `add ${sum.outcome.noun} by ${sum.filters[2]?.label?.toLowerCase() || "segment"}` : "add a breakdown by region", "undo"].map((q) => (
              <button key={q} type="button" className="bd-chip neutral" onClick={() => onAsk(q)}>{q}</button>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

export default BoardView;
