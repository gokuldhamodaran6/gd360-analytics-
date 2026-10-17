// 2026-10-14 (R46/R47): the canvas beside the conversation - a dashboard (live, in its own frame, with the
// chat's chrome, a Download menu and "Get the data"), a document (editable text with a download), or the
// method behind an answer (the SQL steps, or the Analyst's method, checks and code).
import { useEffect, useState } from "react";
import type { ProjectRun } from "../api/projects";
import type { Artifact, BlockData, DashboardData, Turn } from "../api/v2";
import { v2Api } from "../api/v2";
import { downloadOffice } from "../dashboard/officeExport";
import { AnalystMethod, isAnalystRun } from "../project/AnalystAnswer";
import { layoutSql } from "../project/RunPanels";
import { BoardView } from "../board/BoardView";
import { DocView } from "../doc/DocView";
import type { DocSource } from "../api/docs";
import { AnalysisMethod, AnalysisView } from "./AnalysisView";
import { Markdown } from "./Markdown";

export type CanvasItem =
  | { type: "dashboard"; id: string; name: string; url: string; pageId?: string | null }
  | { type: "document"; id: string; turnId: string; title: string; markdown: string; conversationId: string; flagged?: string[] }
  | { type: "method"; turn: Turn }
  | { type: "analysis"; turn: Turn }
  | { type: "board"; id: string; name: string }
  | { type: "doc"; id: string; title: string };

export function canvasFromArtifact(a: Artifact, turn: Turn, conversationId: string): CanvasItem | null {
  if (a.type === "dashboard" && (a.board || (a.url || "").startsWith("/boards/"))) return { type: "board", id: a.id, name: a.name || "Dashboard" };
  if (a.type === "dashboard") return { type: "dashboard", id: a.id, name: a.name || "Dashboard", url: a.url || `/dashboard-builder/${a.id}`, pageId: a.page_id };
  if (a.type === "document" && a.doc_id) return { type: "doc", id: a.doc_id, title: a.title || turn.document?.title || "Document" };
  if (a.type === "document" && turn.document) return { type: "document", id: a.id, turnId: turn.id, title: turn.document.title, markdown: turn.document.markdown, conversationId, flagged: turn.document.flagged };
  if (a.type === "analysis" && turn.analysis) return { type: "analysis", turn };
  return null;
}

function rowsToCsv(cols: string[], rows: Record<string, unknown>[]): string {
  const esc = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.map(esc).join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
}
function saveText(name: string, text: string) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function DataPane({ dashboardId, pageId }: { dashboardId: string; pageId?: string | null }) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { v2Api.dashboardData(dashboardId, pageId).then((d) => { setData(d); setOpen(d.blocks[0]?.id || null); }).catch((e) => setErr(e?.response?.data?.detail || "Couldn't read the data.")); }, [dashboardId, pageId]);
  if (err) return <div className="c2-doc"><div className="c2-err">{err}</div></div>;
  if (!data) return <div className="c2-doc"><span className="c2-working"><span className="c2-spin" /> Reading the rows behind every block…</span></div>;
  const fmt = (v: unknown) => (typeof v === "number" ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : v == null ? "" : String(v));
  return (
    <div className="c2-doc" style={{ maxWidth: "none" }} data-c2-data-pane="">
      <p style={{ margin: "0 0 14px", fontSize: 13, color: "rgb(var(--color-muted))" }}>
        {data.source ? `${data.source.name} · ` : ""}{data.page.name} · the exact rows each block is drawn from, with the definition behind it. Only rows you may see.
      </p>
      {data.blocks.map((b: BlockData) => (
        <div key={b.id} style={{ borderTop: "1px solid rgb(var(--color-border))", padding: "12px 0" }} data-c2-data-block="">
          <button type="button" onClick={() => setOpen(open === b.id ? null : b.id)} style={{ display: "flex", width: "100%", alignItems: "baseline", gap: 10, background: "transparent", border: 0, padding: 0, font: "inherit", color: "inherit", cursor: "pointer", textAlign: "left" }}>
            <span style={{ fontSize: 15, fontWeight: 600 }}>{b.title}</span>
            <span style={{ fontSize: 12.5, color: "rgb(var(--color-muted))" }}>{b.kpi ? b.kpi.display : `${b.row_count.toLocaleString()} rows · ${b.columns.length} columns`}</span>
            <span style={{ marginLeft: "auto", fontSize: 12.5, color: "rgb(var(--color-muted))" }}>{open === b.id ? "Hide" : "Show"}</span>
          </button>
          {b.definition && <div className="c2-mono" style={{ fontSize: 11.5, color: "rgb(var(--color-muted))", marginTop: 4 }}>{b.definition}</div>}
          {open === b.id && b.columns.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                <button type="button" className="c2-nx sm" onClick={() => saveText(`${b.title.replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-") || "block"}.csv`, rowsToCsv(b.columns, b.rows))}>↓ CSV</button>
              </div>
              <div style={{ overflowX: "auto", maxHeight: 360, overflowY: "auto", background: "rgb(var(--color-surface))", borderRadius: 12, padding: "4px 12px" }}>
                <table>
                  <thead><tr>{b.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                  <tbody>{b.rows.slice(0, 200).map((r, i) => <tr key={i}>{b.columns.map((c) => <td key={c} className={typeof r[c] === "number" ? "c2-mono" : undefined} style={typeof r[c] === "number" ? { textAlign: "right" } : undefined}>{fmt(r[c])}</td>)}</tr>)}</tbody>
                </table>
                {b.row_count > 200 && <div style={{ fontSize: 12, color: "rgb(var(--color-muted))", padding: "6px 0" }}>First 200 of {b.row_count.toLocaleString()} rows shown; CSV and Excel carry all of them.</div>}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function Canvas({ item, onClose, version = 0, run, onAsk, onOpenMethod, onSource }: { item: CanvasItem; onClose: () => void; version?: number; run?: ProjectRun | null; onAsk?: (q: string) => void; onOpenMethod?: (t: Turn) => void; onSource?: (s: DocSource) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(item.type === "document" ? item.markdown : "");
  const [copied, setCopied] = useState(false);
  const [frameKey, setFrameKey] = useState(0);
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [view, setView] = useState<"live" | "data">("live");
  useEffect(() => { if (item.type === "document") { setText(item.markdown); setEditing(false); } setView("live"); }, [item]);
  useEffect(() => { setFrameKey((k) => k + 1); }, [version]);
  const title = item.type === "dashboard" || item.type === "board" ? item.name : item.type === "document" || item.type === "doc" ? item.title : item.type === "analysis" ? (item.turn.analysis?.title || "Analysis") : `How I worked it out · ${item.turn.question}`;
  const download = async () => {
    if (item.type !== "document" && item.type !== "analysis") return;
    const safe = title.replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "document";
    const blob = new Blob([item.type === "analysis" ? (item.turn.document?.markdown || "") : text], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `${safe}.md`; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };
  const office = async (kind: "xlsx" | "pptx", theme: "light" | "dark" = "light") => {
    if (item.type !== "dashboard") return;
    setBusy(kind + theme); setMenu(false);
    try { await downloadOffice(item.id, item.pageId || undefined, kind, theme); } catch { /* the menu stays usable */ } finally { setBusy(null); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* fine */ }
  };
  const analyst = item.type === "method" && run && isAnalystRun(run) && run.status === "done";
  return (
    <aside className="c2-canvas" aria-label="Canvas" data-c2-canvas={item.type}>
      <div className="chrome">
        <button type="button" onClick={onClose} aria-label="Close canvas" title="Close">×</button>
        {item.type === "board" ? <span className="t" style={{ color: "rgb(var(--color-muted))", fontWeight: 500 }}>Dashboard · live on your data</span>
          : item.type === "doc" ? <span className="t" style={{ color: "rgb(var(--color-muted))", fontWeight: 500 }}>Document · written from this conversation</span>
          : <span className="t" title={title}>{title}</span>}
        {item.type === "doc" && <a href={`/docs/${item.id}`} target="_blank" rel="noreferrer" title="Open full page" style={{ marginLeft: "auto" }}>Full page ⤢</a>}
        {item.type === "dashboard" && <span style={{ color: "rgb(var(--color-muted))" }}>· live</span>}
        <span style={{ flex: 1 }} />
        {item.type === "dashboard" && (
          <>
            <button type="button" className={view === "data" ? "on" : ""} onClick={() => setView(view === "data" ? "live" : "data")} data-c2-get-data="" style={view === "data" ? { background: "rgb(var(--c2-ink))", color: "rgb(var(--color-base))" } : undefined}>{view === "data" ? "Back to the dashboard" : "Get the data"}</button>
            <span style={{ position: "relative" }}>
              <button type="button" onClick={() => setMenu((m) => !m)} data-c2-download="" aria-expanded={menu}>{busy ? "Building…" : "↓ Download ▾"}</button>
              {menu && (
                <div style={{ position: "absolute", right: 0, top: 36, zIndex: 20, width: 300, borderRadius: 16, background: "rgb(var(--color-surface))", border: "1px solid rgb(var(--color-border))", boxShadow: "var(--shadow-pop)", padding: 8, display: "flex", flexDirection: "column" }} data-c2-download-menu="" role="menu">
                  {[
                    { k: "xlsx", t: "Excel · live totals", d: "every block's rows, SUM formulas, Summary sheet", f: () => office("xlsx") },
                    { k: "pptxl", t: "PowerPoint · light", d: "one editable chart per block", f: () => office("pptx", "light") },
                    { k: "pptxd", t: "PowerPoint · dark", d: "the same deck on the dark theme", f: () => office("pptx", "dark") },
                  ].map((o) => (
                    <button key={o.k} type="button" role="menuitem" onClick={() => void o.f()} style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2, padding: "9px 10px", border: 0, background: "transparent", borderRadius: 10, font: "inherit", color: "inherit", cursor: "pointer", height: "auto", textAlign: "left" }}>
                      <span style={{ fontSize: 13.5 }}>{o.t}</span><span style={{ fontSize: 12, color: "rgb(var(--color-muted))" }}>{o.d}</span>
                    </button>
                  ))}
                  <span style={{ fontSize: 12, color: "rgb(var(--color-muted))", padding: "6px 10px 4px" }}>PDF, PNG and CSV per block: the Export button inside the dashboard.</span>
                </div>
              )}
            </span>
            <button type="button" onClick={() => setFrameKey((k) => k + 1)} title="Refresh">↺</button>
            <a href={`${item.url}`} target="_blank" rel="noreferrer" title="Open full-screen">Open ⤡</a>
          </>
        )}
        {item.type === "analysis" && (
          <>
            <span style={{ color: "rgb(var(--color-muted))" }}>· {item.turn.analysis?.baseline.n.toLocaleString()} rows{item.turn.analysis?.model ? " · model tested" : ""}</span>
            <span style={{ flex: 1 }} />
            {onOpenMethod && <button type="button" onClick={() => onOpenMethod(item.turn)} data-c2-open-method="">Method &amp; code</button>}
            <button type="button" onClick={() => void download()} title="Download as Markdown">Download</button>
          </>
        )}
        {item.type === "document" && (
          <>
            <button type="button" onClick={() => setEditing((e) => !e)}>{editing ? "Preview" : "Edit"}</button>
            <button type="button" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
            <button type="button" onClick={() => void download()} title="Download as Markdown">Download</button>
          </>
        )}
      </div>
      <div className="pane">
        {item.type === "dashboard" && view === "live" && (
          <iframe key={frameKey} title={item.name} src={`${item.url}${item.url.includes("?") ? "&" : "?"}embed=1${item.pageId ? `&page=${item.pageId}` : ""}`} />
        )}
        {item.type === "dashboard" && view === "data" && <DataPane dashboardId={item.id} pageId={item.pageId} />}
        {item.type === "document" && (
          editing ? (
            <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck
              style={{ width: "100%", minHeight: "100%", border: 0, outline: 0, resize: "none", padding: "28px 36px", font: "inherit", fontSize: 15, lineHeight: 1.65, background: "transparent", color: "rgb(var(--color-text))", fontFamily: "Geist Mono, ui-monospace, monospace" }} />
          ) : (
            <div className="c2-doc" data-c2-document="">
              <Markdown text={text} />
            </div>
          )
        )}
        {item.type === "board" && <BoardView id={item.id} embedded version={version} onAsk={onAsk} />}
        {item.type === "doc" && <DocView id={item.id} embedded version={version} onSource={onSource} />}
        {item.type === "analysis" && item.turn.analysis && (
          <div className="an-wrap" data-c2-analysis-canvas="">
            <AnalysisView a={item.turn.analysis} onAsk={onAsk} onOpenMethod={onOpenMethod ? () => onOpenMethod(item.turn) : undefined} />
          </div>
        )}
        {item.type === "method" && item.turn.kind === "analysis" && item.turn.analysis && <AnalysisMethod a={item.turn.analysis} />}
        {item.type === "method" && analyst && run && (
          <div className="c2-doc" style={{ maxWidth: "none" }} data-c2-notebook="">
            <AnalystMethod run={run} />
          </div>
        )}
        {item.type === "method" && !analyst && item.turn.kind !== "analysis" && (
          <div className="c2-doc">
            <h1 style={{ fontSize: 24 }}>How I worked it out</h1>
            <p style={{ color: "rgb(var(--color-secondary))" }}>{item.turn.question}</p>
            {(item.turn.trail || []).length === 0 && <p>No steps were recorded for this answer.</p>}
            {(item.turn.trail || []).map((t, i) => (
              <div key={i} style={{ marginBottom: 18 }}>
                <h3 style={{ margin: "0 0 4px" }}>{i + 1}. {t.label}{t.status ? <span style={{ fontWeight: 400, color: "rgb(var(--color-muted))", fontSize: 13 }}> · {t.status}</span> : null}{t.ms ? <span style={{ fontWeight: 400, color: "rgb(var(--color-muted))", fontSize: 13 }}> · {(t.ms / 1000).toFixed(1)} s</span> : null}</h3>
                {t.sql && <pre className="c2-mono" style={{ whiteSpace: "pre-wrap", fontSize: 12.5, lineHeight: 1.5, background: "rgb(var(--color-surface))", borderRadius: 12, padding: "12px 14px", overflow: "auto", margin: 0 }}>{layoutSql(t.sql)}</pre>}
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
