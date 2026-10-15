// 2026-10-15 (R49): a designed dashboard (mockup boards 03 and 04). One header with the page tabs, filters as pills,
// a Home page that explains the dashboard, then pages of blocks on a 12-column grid - all drawn by board/charts.tsx
// from numbers the backend computed live (services/agent/board.py). The same component runs on the canvas beside
// the conversation and full-screen at /boards/:id; the Excel and PowerPoint downloads come from the same spec.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { boardsApi, type Block, type BoardSummary, type HomeData, type PageRun } from "../api/boards";
import { cap, fmt, HBars, HeroCurve, LineArea, Spark, toneVar } from "./charts";
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

function BlockView({ b, onPick, verb }: { b: Block; onPick: (kind: string, label: string) => void; verb: string }) {
  if (b.type === "kpi") return <Kpi b={b} />;
  if (b.type === "table") return <Table b={b} />;
  if (b.type === "list") return <List b={b} />;
  if (b.type === "tiers") return <Tiers b={b} verb={verb} />;
  if (b.type === "bars") {
    return (
      <div className="bd-card" data-bd-block={b.kind}>
        <Head b={b} right={b.show_n ? <span className="bd-muted" style={{ fontSize: 12 }}>{b.n_label || "rows"}</span> : undefined} />
        <HBars rows={b.rows || []} unit={b.unit} baseline={b.baseline} showN={b.show_n} showShare={b.show_share} decimals={b.decimals}
          onPick={b.kind === "o_dim" || b.kind === "g_dim" ? (l) => onPick(b.kind, l) : undefined} />
        {(b.rows || []).some((r: any) => r.small) && <span className="bd-note">* Under 30 in the group: too few to read much into.</span>}
        {b.note && <span className="bd-note">{b.note}</span>}
      </div>
    );
  }
  if (b.type === "line") {
    return (
      <div className="bd-card" data-bd-block={b.kind}>
        <Head b={b} right={<span className="bd-legend">{b.compare ? <><i className="a" />This year <i className="c" />Year before</> : null}{b.baseline?.value != null ? <><i className="d" />{b.baseline.label}</> : null}</span>} />
        <LineArea points={b.points || []} compare={b.compare} unit={b.unit} baseline={b.baseline} />
      </div>
    );
  }
  return <div className="bd-card" data-bd-block={b.kind || "empty"}><div className="bd-bh"><span className="t">{b.title}</span></div><span className="bd-muted">{b.text}</span></div>;
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

export function BoardView({ id, embedded = false, version = 0, onAsk }: { id: string; embedded?: boolean; version?: number; onAsk?: (q: string) => void }) {
  const [sum, setSum] = useState<BoardSummary | null>(null);
  const [page, setPage] = useState<string>("home");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [run, setRun] = useState<PageRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    let live = true;
    boardsApi.get(id).then((s) => {
      if (!live) return;
      setSum(s);
      setFilters(s.default_filters || {});
      setPage((p) => (s.pages.some((x) => x.id === p) ? p : s.pages[0]?.id || "home"));
    }).catch((e) => setErr(e?.response?.data?.detail || "Couldn't open this dashboard."));
    return () => { live = false; };
  }, [id, version]);

  const load = useCallback(async () => {
    if (!sum) return;
    const my = ++seq.current;
    setLoading(true);
    try {
      const r = await boardsApi.run(id, page, filters);
      if (my === seq.current) { setRun(r); setErr(null); }
    } catch (e: any) {
      if (my === seq.current) setErr(e?.response?.data?.detail || "Couldn't compute this page.");
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [id, page, filters, sum]);
  useEffect(() => { void load(); }, [load]);

  const style = useMemo(() => {
    if (!sum) return undefined;
    const p = sum.palette;
    return { "--bd-bg": p.bg, "--bd-card": p.card, "--bd-ink": p.ink, "--bd-accent": p.accent, "--bd-warn": p.warn, "--bd-good": p.good } as React.CSSProperties;
  }, [sum]);

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
    <div className={`bd ${sum.palette.mode}${embedded ? " embedded" : ""}`} style={style} data-bd-board={id} data-bd-theme={sum.theme}>
      <header className="bd-top">
        <div className="bd-brand">
          <span className="mk" aria-hidden="true"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M4 18l5-6 4 3 7-8" /></svg></span>
          <span className="nm">{sum.title}</span>
          <span className="bd-live"><i />Live{run ? ` · ${ago(run.refreshed_at)}` : ""}</span>
        </div>
        <nav className="bd-tabs" role="tablist" aria-label="Pages">
          {sum.pages.map((p) => (
            <button key={p.id} type="button" role="tab" aria-selected={p.id === page} className={p.id === page ? "on" : ""} onClick={() => setPage(p.id)} data-bd-tab={p.id}>{p.name}</button>
          ))}
        </nav>
        <div className="bd-actions">
          <span style={{ position: "relative" }}>
            <button type="button" className="bd-btn" onClick={() => setMenu((m) => !m)} aria-expanded={menu} data-bd-download="">{busy ? "Building…" : "Download"}</button>
            {menu && (
              <div className="bd-menu" role="menu" data-bd-download-menu="">
                <button type="button" role="menuitem" onClick={() => void dl("xlsx")} data-bd-xlsx=""><b>Excel</b><span>every page, the numbers behind each block, totals as formulas</span></button>
                <button type="button" role="menuitem" onClick={() => void dl("pptx")} data-bd-pptx=""><b>PowerPoint</b><span>one slide per page in this theme, native charts</span></button>
                <span className="foot">Downloads keep the filters you have set.</span>
              </div>
            )}
          </span>
          {!embedded && sum.conversation_id && <a className="bd-btn" href={`/chat/${sum.conversation_id}`}>Open conversation</a>}
          {embedded && <a className="bd-btn" href={`/boards/${id}`} target="_blank" rel="noreferrer" title="Open full screen">Full screen</a>}
        </div>
      </header>

      {page !== "home" && (
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
            <div className={`bd-grid${loading ? " dim" : ""}`} data-bd-page={page}>
              {run.blocks.map((b) => (
                <div key={b.id} className="bd-cell" style={{ gridColumn: `span ${b.span}`, gridRow: b.h > 1 ? `span ${b.h}` : undefined }}>
                  <BlockView b={b} onPick={onPick} verb={sum.outcome?.verb || "had the outcome"} />
                </div>
              ))}
            </div>
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
        {onAsk && page !== "home" && (
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
