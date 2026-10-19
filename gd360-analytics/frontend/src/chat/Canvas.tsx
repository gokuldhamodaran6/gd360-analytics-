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
import type { DocSource } from "../api/docs";
import { AnalysisMethod, AnalysisView } from "./AnalysisView";
import { Markdown } from "./Markdown";
import { StudioFrame } from "../studio/Frame";
import { Ic } from "../studio/icons";
import { AnalysisStudio, type FrameBits } from "../studio/AnalysisStudio";
import { DashboardStudio } from "../studio/DashboardStudio";
import { DocStudio } from "../studio/DocStudio";
import { ModelStudio } from "../studio/ModelStudio";
import { OutcomeStudio } from "../studio/OutcomeStudio";

export type CanvasItem =
  | { type: "dashboard"; id: string; name: string; url: string; pageId?: string | null }
  | { type: "document"; id: string; turnId: string; title: string; markdown: string; conversationId: string; flagged?: string[] }
  | { type: "method"; turn: Turn }
  | { type: "analysis"; turn: Turn }
  | { type: "board"; id: string; name: string }
  | { type: "doc"; id: string; title: string }
  // 2026-10-19 (R56): a data answer as numbered steps; a trained model
  | { type: "steps"; turn: Turn }
  | { type: "model"; id: string; name: string; turnId?: string };

export function canvasKey(c: CanvasItem): string {
  if (c.type === "steps" || c.type === "analysis" || c.type === "method") return `${c.type}:${c.turn.id}`;
  return `${c.type}:${c.id}`;
}

export function canvasFromArtifact(a: Artifact, turn: Turn, conversationId: string): CanvasItem | null {
  if (a.type === "dashboard" && (a.board || (a.url || "").startsWith("/boards/"))) return { type: "board", id: a.id, name: a.name || "Dashboard" };
  if (a.type === "dashboard") return { type: "dashboard", id: a.id, name: a.name || "Dashboard", url: a.url || `/dashboard-builder/${a.id}`, pageId: a.page_id };
  if (a.type === "document" && a.doc_id) return { type: "doc", id: a.doc_id, title: a.title || turn.document?.title || "Document" };
  if (a.type === "document" && turn.document) return { type: "document", id: a.id, turnId: turn.id, title: turn.document.title, markdown: turn.document.markdown, conversationId, flagged: turn.document.flagged };
  if (a.type === "analysis" && turn.analysis) return { type: "analysis", turn };
  if (a.type === "model") return { type: "model", id: a.id, name: a.name || "Model", turnId: turn.id };
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

/** The canvases that keep their R46-R51 bodies (a classic dashboard, a markdown document, the method, an outcome
 *  analysis), now inside the Studio frame: the conversation's tabs above, their own buttons on the right. */
function LegacyCanvas({ item, frame, version = 0, run, onAsk, onOpenMethod }: { item: CanvasItem; frame: FrameBits; version?: number; run?: ProjectRun | null; onAsk?: (q: string) => void; onOpenMethod?: (t: Turn) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(item.type === "document" ? item.markdown : "");
  const [copied, setCopied] = useState(false);
  const [frameKey, setFrameKey] = useState(0);
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [view, setView] = useState<"live" | "data">("live");
  useEffect(() => { if (item.type === "document") { setText(item.markdown); setEditing(false); } setView("live"); }, [item]);
  useEffect(() => { setFrameKey((k) => k + 1); }, [version]);
  const title = item.type === "dashboard" || item.type === "board" ? item.name : item.type === "document" || item.type === "doc" ? item.title : item.type === "analysis" ? (item.turn.analysis?.title || "Analysis") : "turn" in item ? `How I worked it out · ${item.turn.question}` : item.name;
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
  const kind = item.type === "analysis" ? "analysis" : item.type;
  return (
    <StudioFrame kind={kind} tabs={frame.tabs} addMenu={frame.addMenu} onClose={frame.onClose} bodyClass="sd-legacy" bodyStyle={{ padding: 0, gap: 0 }}
      status={item.type === "analysis" ? `${item.turn.analysis?.baseline.n.toLocaleString()} rows${item.turn.analysis?.model ? " · model tested" : ""}` : item.type === "dashboard" ? "Live" : undefined}
      tools={<>
        {item.type === "dashboard" && (
          <>
            <button type="button" className={`sd-tool${view === "data" ? " on" : ""}`} onClick={() => setView(view === "data" ? "live" : "data")} data-c2-get-data=""><Ic n="table" />{view === "data" ? "Back to the dashboard" : "Get the data"}</button>
            <span style={{ position: "relative" }}>
              <button type="button" className="sd-tool" onClick={() => setMenu((m) => !m)} data-c2-download="" aria-expanded={menu}><Ic n="dl" />{busy ? "Building…" : "Download"}</button>
              {menu && (
                <div className="sd-menu" style={{ top: 36, left: 0, width: 300 }} data-c2-download-menu="" role="menu">
                  {[
                    { k: "xlsx", t: "Excel · live totals", d: "every block's rows, SUM formulas, Summary sheet", f: () => office("xlsx") },
                    { k: "pptxl", t: "PowerPoint · light", d: "one editable chart per block", f: () => office("pptx", "light") },
                    { k: "pptxd", t: "PowerPoint · dark", d: "the same deck on the dark theme", f: () => office("pptx", "dark") },
                  ].map((o) => (
                    <button key={o.k} type="button" role="menuitem" onClick={() => void o.f()}><span>{o.t}</span><small>{o.d}</small></button>
                  ))}
                </div>
              )}
            </span>
            <button type="button" className="sd-tool" onClick={() => setFrameKey((k) => k + 1)}><Ic n="refresh" />Refresh</button>
            <a className="sd-tool" href={`${item.url}`} target="_blank" rel="noreferrer"><Ic n="ext" />Full screen</a>
          </>
        )}
        {item.type === "analysis" && (
          <>
            {onOpenMethod && <button type="button" className="sd-tool" onClick={() => onOpenMethod(item.turn)} data-c2-open-method=""><Ic n="code" />Method &amp; code</button>}
            <button type="button" className="sd-tool" onClick={() => void download()} title="Download as Markdown"><Ic n="dl" />Download</button>
            {onAsk && <><span className="sd-vr" /><button type="button" className="sd-tool" onClick={() => onAsk("show the high-risk list")}><Ic n="table" />High-risk list</button>
              <button type="button" className="sd-tool" onClick={() => onAsk("make this a dashboard")}><Ic n="grid" />Make a dashboard</button></>}
          </>
        )}
        {item.type === "document" && (
          <>
            <button type="button" className={`sd-tool${editing ? " on" : ""}`} onClick={() => setEditing((e) => !e)}><Ic n="text" />{editing ? "Preview" : "Edit"}</button>
            <button type="button" className="sd-tool" onClick={copy}><Ic n="copy" />{copied ? "Copied" : "Copy"}</button>
            <button type="button" className="sd-tool" onClick={() => void download()} title="Download as Markdown"><Ic n="dl" />Download</button>
          </>
        )}
        {item.type === "method" && <span className="sd-tool" style={{ cursor: "default" }}><Ic n="code" />How I worked it out · {title.replace(/^How I worked it out · /, "")}</span>}
      </>}>
      <div className="pane" style={{ flex: 1, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column" }}>
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
    </StudioFrame>
  );
}

/** R56: one canvas for whatever is open - each kind of work in its own Studio. */
export function CanvasRouter({ item, frame, version = 0, runs, conversationId, busy, onAsk, onPrefill, onRunChanged, onTurnRefresh, onMakeDashboard, onOpenMethod, onOpen, onSource }: {
  item: CanvasItem; frame: FrameBits; version?: number; runs: Record<string, ProjectRun>; conversationId: string; busy: boolean;
  onAsk: (q: string) => void; onPrefill: (q: string) => void; onRunChanged: (r: ProjectRun) => void; onTurnRefresh: (turnId: string) => void;
  onMakeDashboard: (t: Turn) => void; onOpenMethod: (t: Turn) => void; onOpen: (c: CanvasItem) => void; onSource?: (s: DocSource) => void;
}) {
  if (item.type === "steps") {
    const run = item.turn.run_id ? runs[item.turn.run_id] : null;
    if (run) return <AnalysisStudio key={item.turn.id} turn={item.turn} run={run} frame={frame} onAsk={onAsk} onPrefill={onPrefill} onRunChanged={onRunChanged}
      onTurnRefresh={() => onTurnRefresh(item.turn.id)} onMakeDashboard={() => onMakeDashboard(item.turn)} />;
    // R57: a Guided analysis opens before its run has loaded - the frame, already saying what is happening
    return (
      <StudioFrame kind="analysis-steps" tabs={frame.tabs} addMenu={frame.addMenu} onClose={frame.onClose} status="Planning the steps…">
        <div className="sd-nb"><span className="c2-working"><span className="c2-spin" /> Planning the steps…</span></div>
      </StudioFrame>
    );
  }
  if (item.type === "analysis" && item.turn.analysis) return <OutcomeStudio key={item.turn.id} turn={item.turn} frame={frame} onAsk={onAsk} onPrefill={onPrefill} onOpenMethod={() => onOpenMethod(item.turn)} />;
  if (item.type === "board") return <DashboardStudio key={item.id} id={item.id} name={item.name} frame={frame} version={version} onAsk={onAsk} onPrefill={onPrefill} conversationId={conversationId} busy={busy} />;
  if (item.type === "doc") return <DocStudio key={item.id} id={item.id} frame={frame} version={version} onAsk={onAsk} onPrefill={onPrefill} onSource={onSource} busy={busy} />;
  if (item.type === "model") return <ModelStudio key={item.id} id={item.id} frame={frame} onAsk={onAsk} onPrefill={onPrefill} busy={busy} />;
  const run = item.type === "method" && item.turn.run_id ? runs[item.turn.run_id] : null;
  void onOpen;
  return <LegacyCanvas item={item} frame={frame} version={version} run={run} onAsk={onAsk} onOpenMethod={onOpenMethod} />;
}
