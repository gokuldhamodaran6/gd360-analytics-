// 2026-10-19 (R56, Studio board "Analysis, step by step"): a data answer on the canvas as numbered steps - the
// queries that read the data, the metric, each chart, the findings and the tables - each with Ask / Edit / Run.
// Edits are real: a step's SQL or a plain-English change runs that step again and rewrites the answer from every
// step (backend guided.rework). Nothing here is drawn from made-up numbers; every card is the run's own result.
// 2026-10-19 (R57, "ask flow fixes" boards 3-5): a Guided analysis lives here from the moment it is asked - the
// plan fills in, step 1 runs by itself and shows its numbers ("Do these numbers look right?"), each later step runs
// after "Looks right", and one green button runs the rest. The page never says "worked" while a step still runs.
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { guidedApi, projectsApi, type ProjectRun, type RunStep, type Visual } from "../api/projects";
import type { Turn } from "../api/v2";
import ChartWithControls from "../project/ChartControls";
import ForecastChart from "../project/ForecastChart";
import { formatCell } from "../project/format";
import { DataTable, DivergingBars, WaterfallChart } from "../project/Visuals";
import { layoutSql } from "../project/RunPanels";
import { ago, MenuButton, safeName, saveBlob, StudioFrame, toCsv, type FrameTab } from "./Frame";
import { Ic } from "./icons";
import { useCardActions, type CardTarget } from "../chat/cardActions";

/** R58: a card's two questions. Explain answers at once from the numbers already on screen (no new query);
 *  Ask puts "About: <this card>" in the follow-up box for a question of your own. Explain waits for the answer
 *  (a Guided analysis explains once its steps are checked). */
function CardAsk({ label, prefix, target, runId, canExplain, onPrefill }: {
  label: string; prefix: string; target: CardTarget; runId: string; canExplain: boolean; onPrefill: (q: string) => void;
}) {
  const acts = useCardActions();
  return (
    <>
      {canExplain && acts && (
        <button type="button" className="sd-tool sm" onClick={() => acts.explain(label, target, runId)} data-sd-explain={target.kind}
          title="Explain this from the numbers already here - no new query"><Ic n="spark" />Explain</button>
      )}
      <button type="button" className="sd-tool sm" data-sd-ask={target.kind}
        onClick={() => (acts ? acts.about({ label, prefix, target, runId }) : onPrefill(`${prefix}: `))}
        title="Ask your own question about this"><Ic n="wand" />Ask</button>
    </>
  );
}

/** R58: step names read as plain language - "Fetch Monthly Sales History" becomes "Fetch monthly sales history".
 *  Only a title in Title Case changes; acronyms (USA, SKU) and words with digits stay as they are. */
export function plainTitle(t: string): string {
  const words = t.split(/\s+/);
  const caps = words.filter((w) => /^[A-Z][a-z]/.test(w)).length;
  if (words.length < 3 || caps < Math.ceil(words.length * 0.6)) return t;
  return words.map((w, i) => (i === 0 || /^[A-Z0-9&]+$/.test(w) || /\d/.test(w) ? w : /^[A-Z][a-z]+$/.test(w) ? w.toLowerCase() : w)).join(" ");
}

export type FrameBits = { tabs: FrameTab[]; addMenu?: (close: () => void) => React.ReactNode; onClose: () => void };

const KIND_ICON: Record<string, string> = { data: "db", metric: "test", chart: "bar", text: "text", table: "table", model: "chip" };
const KIND_LABEL: Record<string, string> = { data: "Data", metric: "Metric", chart: "Chart", text: "Text", table: "Table", model: "Model" };

function busyRun(r: ProjectRun | null | undefined): boolean {
  // R57: a Guided analysis rests at "planned" while it waits for the person - that is not busy
  if (r && r.guided && r.status === "planned") return !!r.busy || (r.steps || []).some((s) => s.status === "running");
  return !!r && (["planning", "running", "planned"].includes(r.status) || !!r.busy || (r.steps || []).some((s) => s.status === "running"));
}

/** R57: a one-row result is read as key numbers ("Net sales $35.5M · Orders 27,768"), not a one-row table. */
function StepKpis({ step }: { step: RunStep }) {
  const cols = (step.columns || []).filter((c) => c.dtype === "number").slice(0, 4);
  const row = (step.preview || [])[0];
  if (!row || (step.preview || []).length !== 1 || !cols.length) return null;
  return (
    <div className="sd-kpis sd-stepkpis" data-sd-step-kpis="">
      {cols.map((c) => (
        <div key={c.name} className="sd-card sd-kpi"><span className="sd-lbl">{c.label || humanHeader(c.name)}</span>
          <b className="sd-mono">{formatCell(row[c.name], c.format || "number", c.currency)}</b></div>
      ))}
    </div>
  );
}

export function StepCard({ n, kind, title, badge, cls, acts, children, foot, id }: {
  n: number; kind: string; title: string; badge?: React.ReactNode; cls?: string; acts?: React.ReactNode; children: React.ReactNode; foot?: React.ReactNode; id?: string;
}) {
  return (
    <div className={`sd-sb${cls ? ` ${cls}` : ""}`} data-sd-step={kind} data-sd-step-id={id}>
      <span className="sd-nm">{n}</span>
      <div className={`sd-card${cls?.includes("new") ? " changed" : ""}`}>
        <div className="sd-sh">
          <span className="k"><Ic n={KIND_ICON[kind] || "spark"} />{KIND_LABEL[kind] || kind}</span>
          <b title={title}>{title}</b>
          {badge}
          <span className="x">{acts}</span>
        </div>
        <div className="sd-sbody">
          {children}
          {foot && <div className="sd-sfoot">{foot}</div>}
        </div>
      </div>
    </div>
  );
}

// R58: a step's rows read like a table a person made - "Net sales" not "net_sales", "Jan 2021" not "2021-01-01",
// money with its currency. The values themselves are the step's own; only how they are written changes.
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]00:00(?::00(?:\.0+)?)?(?:Z|\+00:?00)?)?$/;
const MONEY_NAME = /(sales|revenue|amount|amt|price|cost|profit|spend|income|gmv|limit|balance|fee|margin_value|value_usd)/i;
export function humanHeader(name: string): string {
  if (/[a-z][A-Z]|\s/.test(name) && !/_/.test(name)) return name;
  const t = name.replace(/_/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
}
function dateStyle(values: unknown[]): "month" | "day" | null {
  const vs = values.filter((v) => v !== null && v !== undefined && v !== "");
  if (!vs.length || !vs.every((v) => typeof v === "string" && ISO_DAY.test(v))) return null;
  return vs.every((v) => (v as string).slice(8, 10) === "01") && vs.length > 1 ? "month" : "day";
}
function showDate(v: unknown, style: "month" | "day"): string {
  const m = typeof v === "string" ? ISO_DAY.exec(v) : null;
  if (!m) return v === null || v === undefined || v === "" ? "—" : String(v);
  const mon = MON[Number(m[2]) - 1] || m[2];
  return style === "month" ? `${mon} ${m[1]}` : `${Number(m[3])} ${mon} ${m[1]}`;
}

function PreviewTable({ step, rows = 5, currency }: { step: RunStep; rows?: number; currency?: string | null }) {
  const cols = (step.columns || []).slice(0, 7);
  const data = (step.preview || []).slice(0, rows);
  if (!cols.length) return <div className="sd-note">{step.status === "done" ? "This step returned no rows." : "Not run yet."}</div>;
  const dates = Object.fromEntries(cols.map((c) => [c.name, c.dtype === "number" ? null : dateStyle((step.preview || []).map((r) => r[c.name]))]));
  const fmt = (c: (typeof cols)[number]) => c.format || (c.dtype === "number" ? (currency && MONEY_NAME.test(c.name) ? "currency" : "number") : null);
  return (
    <div className="sd-card sd-tw" style={{ borderRadius: 10 }}>
      <table className="sd-t">
        <thead><tr>{cols.map((c) => <th key={c.name} className={c.dtype === "number" ? "r" : undefined} title={c.name}>{c.label || humanHeader(c.name)}</th>)}</tr></thead>
        <tbody>
          {data.map((r, i) => (
            <tr key={i}>{cols.map((c) => <td key={c.name} className={c.dtype === "number" ? "num" : dates[c.name] ? undefined : "sd-mono"} style={c.dtype === "number" ? undefined : { fontSize: 13 }}>
              {dates[c.name] ? showDate(r[c.name], dates[c.name]!) : formatCell(r[c.name], fmt(c), c.currency || currency)}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ChartBody({ v, id }: { v: Visual; id: string }) {
  if (v.type === "waterfall") return <WaterfallChart visual={v} />;
  if (v.type === "diverging") return <DivergingBars visual={v} />;
  if (v.type === "forecast") return <ForecastChart visual={v} />;
  if (v.type === "chart") {
    return (
      <>
        <ChartWithControls id={id} title={v.title} columns={v.columns} rows={v.rows} truncated={v.truncated}
          chartType={v.display === "table" ? "table" : v.chart_type || null} />
        {v.note && <div className="sd-note">{v.note}</div>}
      </>
    );
  }
  return null;
}

function DataStep({ n, step, runId, canEdit, showCode, onAsk, onChanged, onError, busy, removable, check, nextLabel, canExplain = false, currency }: {
  n: number; step: RunStep; runId: string; canEdit: boolean; showCode: boolean; onAsk: (q: string) => void; onChanged: (r: ProjectRun) => void;
  onError: (m: string) => void; busy: boolean; removable: boolean; canExplain?: boolean; currency?: string | null;
  /** R57: this step's numbers wait for the person's OK (Guided analysis) */
  check?: boolean; nextLabel?: string;
}) {
  const [mode, setMode] = useState<"none" | "sql" | "say">("none");
  const [sql, setSql] = useState(step.sql);
  const [say, setSay] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (mode === "none") setSql(step.sql); }, [step.sql, mode]);
  const act = async (fn: () => Promise<ProjectRun>) => {
    setSaving(true);
    try { onChanged(await fn()); setMode("none"); setSay(""); } catch (e: any) { onError(e?.response?.data?.detail || "That change didn't apply."); } finally { setSaving(false); }
  };
  const running = step.status === "running";
  const title = plainTitle(step.title || `Step ${n}`);
  const src = step.kind === "combine" ? "Combined from earlier steps" : [step.source_name, step.dialect].filter(Boolean).join(" · ");
  const kpiView = (step.preview || []).length === 1 && (step.columns || []).some((c) => c.dtype === "number");
  return (
    <StepCard n={n} kind="data" id={step.id} title={title}
      cls={[step.added ? "new" : "", running ? "run" : "", step.status === "failed" ? "bad" : "", check ? "focus" : "", step.approved ? "ok" : ""].join(" ").trim()}
      badge={running ? <span className="sd-chip"><span className="c2-spin" /> Running</span> : step.status === "stale" ? <span className="sd-chip warn">Out of date</span>
        : check ? <span className="sd-chip good" data-sd-ready="">Ready to check</span>
        : step.added ? <span className="sd-badge">Added</span> : step.reused ? <span className="sd-chip">Reused</span> : null}
      acts={<>
        <CardAsk label={`step ${n}, “${title}”`} prefix={`About step ${n}, “${title}”`} target={{ kind: "step", id: step.id }} runId={runId}
          canExplain={canExplain && step.status === "done"} onPrefill={onAsk} />
        {canEdit && <button type="button" className={`sd-tool sm${mode !== "none" ? " on" : ""}`} onClick={() => setMode(mode === "none" ? "say" : "none")} disabled={busy} data-sd-edit=""><Ic n="text" />Edit</button>}
        {canEdit && <button type="button" className="sd-tool sm" onClick={() => void act(() => guidedApi.runStep(runId, step.id))} disabled={busy || saving} data-sd-run=""><Ic n="play" />Run</button>}
        <MenuButton className="sd-tool sm" icon="more" caret={false} align="right" title="More">
          {(close) => <>
            <button type="button" onClick={() => { void navigator.clipboard?.writeText(step.sql).catch(() => undefined); close(); }}>Copy the SQL</button>
            {(step.preview || []).length > 0 && <button type="button" onClick={() => { const cols = (step.columns || []).map((c) => c.name); saveBlob(`${safeName(title)}.csv`, toCsv(cols, step.preview || [])); close(); }}>
              Download these rows<small>the {(step.preview || []).length} shown here, as CSV</small></button>}
            {canEdit && removable && <><span className="sep" /><button type="button" onClick={() => { close(); void act(() => guidedApi.remove(runId, step.id)); }} data-sd-remove="">Remove this step<small>the answer is rewritten without it</small></button></>}
          </>}
        </MenuButton>
      </>}
      foot={<>
        {step.rows_returned != null && <span className="sd-chip">{step.rows_returned.toLocaleString()} row{step.rows_returned === 1 ? "" : "s"}{step.truncated ? " (first shown)" : ""}</span>}
        {src && <span className="sd-chip"><Ic n={step.kind === "combine" ? "flow" : "db"} />{src}</span>}
        {step.duration_ms != null && <span className="sd-chip">{step.duration_ms < 1000 ? `${step.duration_ms} ms` : `${(step.duration_ms / 1000).toFixed(1)} s`}</span>}
        {step.repaired && <span className="sd-chip warn" title="The first query failed and was fixed automatically">Query fixed</span>}
        <span className="sd-sp" />
        {step.freshness && <span className="sd-proof"><span className="sd-dot good" />{step.freshness}</span>}
      </>}>
      {step.purpose && <div className="sd-sub" style={{ marginTop: -2 }}>{step.purpose}</div>}
      {step.error && <div className="sd-err">{step.error}</div>}
      {mode === "say" && (
        <form onSubmit={(e) => { e.preventDefault(); if (say.trim().length > 2) void act(() => guidedApi.revise(runId, step.id, say.trim())); }} style={{ display: "flex", gap: 8, flexWrap: "wrap" }} data-sd-revise="">
          <input className="sd-in" style={{ flex: 1, minWidth: 220 }} value={say} onChange={(e) => setSay(e.target.value)} autoFocus
            placeholder="Say the change: “only the South region”, “by week instead of month”…" aria-label="Describe the change" />
          <button type="submit" className="sd-btnp" disabled={saving || say.trim().length < 3}>{saving ? "Changing…" : "Change and run"}</button>
          <button type="button" className="sd-pill" onClick={() => setMode("sql")}>Edit the SQL</button>
        </form>
      )}
      {mode === "sql" && (
        <form onSubmit={(e) => { e.preventDefault(); void act(() => guidedApi.setSql(runId, step.id, sql)); }} style={{ display: "flex", flexDirection: "column", gap: 8 }} data-sd-sql-form="">
          <textarea className="sd-code" value={sql} onChange={(e) => setSql(e.target.value)} spellCheck={false} rows={Math.min(16, Math.max(5, sql.split("\n").length + 1))} aria-label="SQL" />
          <div style={{ display: "flex", gap: 8 }}>
            <button type="submit" className="sd-btnp" disabled={saving || sql.trim().length < 6}>{saving ? "Running…" : "Run this SQL"}</button>
            <button type="button" className="sd-pill" onClick={() => setMode("none")}>Cancel</button>
            <span className="sd-note" style={{ alignSelf: "center" }}>Read-only: a query that writes is refused.</span>
          </div>
        </form>
      )}
      {kpiView && <StepKpis step={step} />}
      {(showCode || check) && mode === "none" && <pre className="sd-code" data-sd-code="">{layoutSql(step.sql)}</pre>}
      {!kpiView && <PreviewTable step={step} currency={currency} />}
      {check && mode === "none" && (
        <div className="sd-okbar" data-sd-okbar="">
          <b>Do these numbers look right?</b>
          <span className="sd-sp" />
          {canEdit && <button type="button" className="sd-pill" onClick={() => setMode("say")} disabled={busy || saving} data-sd-change="">Change this step</button>}
          <button type="button" className="sd-btnp" onClick={() => void act(() => guidedApi.approve(runId, step.id, true))} disabled={busy || saving} data-sd-approve="">
            {saving ? "Starting…" : nextLabel || "Looks right"}</button>
        </div>
      )}
    </StepCard>
  );
}

/** R57: a step that has not run yet in a Guided analysis - its title and what it will compute. */
function WaitingStep({ n, step, next }: { n: number; step: RunStep; next: boolean }) {
  return (
    <div className="sd-sb wait" data-sd-step="data" data-sd-step-id={step.id} data-sd-waiting="">
      <span className="sd-nm">{n}</span>
      <div className="sd-card sd-waitcard">
        <div className="sd-sh"><span className="k"><Ic n="db" />Data</span><b title={step.title}>{plainTitle(step.title || `Step ${n}`)}</b><span className="sd-chip">{next ? "Next" : "Waits"}</span></div>
        {step.purpose && <div className="sd-sub">{step.purpose}</div>}
      </div>
    </div>
  );
}

export function AnalysisStudio({ turn, run, frame, onAsk, onPrefill, onRunChanged, onTurnRefresh, onMakeDashboard, canEdit = true }: {
  turn: Turn; run: ProjectRun; frame: FrameBits; onAsk: (q: string) => void; onPrefill: (q: string) => void; onRunChanged: (r: ProjectRun) => void;
  onTurnRefresh: () => void; onMakeDashboard: () => void; canEdit?: boolean;
}) {
  const navigate = useNavigate();
  const [showCode, setShowCode] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addText, setAddText] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [poll, setPoll] = useState(0);
  const wasBusy = useRef(false);
  const res = run.result;
  const busy = busyRun(run);

  // after an edit the run works in the background: follow it until the answer is rewritten
  useEffect(() => {
    if (!busy && !poll) return;
    const id = window.setInterval(async () => {
      try {
        const r = await projectsApi.run(run.id);
        onRunChanged(r);
        if (!busyRun(r)) { setPoll(0); onTurnRefresh(); }
      } catch { /* next tick */ }
    }, 1200);
    return () => window.clearInterval(id);
  }, [busy, poll, run.id, onRunChanged, onTurnRefresh]);
  useEffect(() => { if (wasBusy.current && !busy) onTurnRefresh(); wasBusy.current = busy; }, [busy, onTurnRefresh]);

  const changed = useCallback((r: ProjectRun) => { setErr(null); onRunChanged(r); setPoll((p) => p + 1); }, [onRunChanged]);
  const steps = (run.steps || []).filter((s) => s.status !== "skipped");
  // R58: each chart keeps its place in the answer's list - Explain points at it by that index
  const visuals = (res?.visuals || []).map((v, i) => ({ v, i })).filter((x) => x.v.type !== "kpis");
  const canExplain = run.status === "done" && !!res?.answer && !res?.answer_stale && !busy;
  const currency = (run.plan as any)?.analysis?.currency || null;
  const kpis = (((res as any)?.kpis || []) as { label: string; display: string; fact_id?: string }[]).slice(0, 4);
  const ans = res?.answer;
  const evidence = res?.evidence || [];
  const und = run.plan?.understanding || {};
  const sources = Array.from(new Set(steps.filter((s) => s.kind !== "combine").map((s) => s.source_name).filter(Boolean))) as string[];
  const scope = [und.scope, und.window].filter(Boolean).join(" · ");
  let n = 0;
  const next = () => ++n;

  const add = async () => {
    if (addText.trim().length < 3) return;
    setAddBusy(true);
    try { const r = await guidedApi.add(run.id, addText.trim(), steps.length ? steps[steps.length - 1].id : null); changed(r); setAdding(false); setAddText(""); }
    catch (e: any) { setErr(e?.response?.data?.detail || "Couldn't add that step."); } finally { setAddBusy(false); }
  };
  const runAll = async () => { try { changed(await guidedApi.rework(run.id)); } catch (e: any) { setErr(e?.response?.data?.detail || "Couldn't run the steps."); } };
  const title = (turn.question || "Analysis").replace(/\?$/, "");
  // R57: a Guided analysis before its answer is written - step by step, each step waits for the person's OK
  const stepwise = !!run.guided && run.status !== "done";
  const planning = run.status === "planning";
  const checkIdx = stepwise && !busy ? steps.findIndex((s) => s.status === "done" && !s.approved) : -1;
  const firstWaiting = steps.findIndex((s) => s.status !== "done");
  const left = steps.filter((s) => s.status !== "done").length;
  const runRest = async () => { try { changed(await guidedApi.runRest(run.id)); } catch (e: any) { setErr(e?.response?.data?.detail || "Couldn't run the rest."); } };
  const runningIdx = steps.findIndex((s) => s.status === "running");
  const status = planning ? "Planning the steps…"
    : stepwise && runningIdx >= 0 ? `Running step ${runningIdx + 1} of ${steps.length}…`
    : stepwise && busy ? "Writing the answer from the steps…"
    : stepwise && checkIdx >= 0 ? `Step ${checkIdx + 1} of ${steps.length} ready · checked against the source`
    : busy ? `Working · ${steps.filter((s) => s.status === "running").map((s) => s.title).join(", ") || "rewriting the answer"}…`
    : run.finished_at ? `Saved ${ago(run.finished_at)}` : "";

  return (
    <StudioFrame kind="analysis-steps" tabs={frame.tabs} addMenu={frame.addMenu} onClose={frame.onClose} status={status}
      actions={stepwise ? (
        <button type="button" className="sd-btnp" disabled={busy || planning || (!left && checkIdx < 0)} onClick={() => void runRest()} data-sd-run-rest=""
          title="What has run is approved; every step left runs, then the answer is written">{left ? "Looks right, run the rest" : "Looks right, write the answer"}</button>
      ) : <>
        <button type="button" className="sd-pill" onClick={() => { void navigator.clipboard?.writeText(window.location.href).catch(() => undefined); }} title="Copy the link to this conversation"><Ic n="share" />Share</button>
        <MenuButton className="sd-btnp" label="Turn into" align="right" data="turn-into">
          {(close) => <>
            <button type="button" onClick={() => { close(); onMakeDashboard(); }} data-sd-into="dashboard"><span>A dashboard</span><small>live charts from these steps, to share</small></button>
            <button type="button" onClick={() => { close(); onAsk("Write this up as a document"); }} data-sd-into="doc"><span>A document</span><small>a write-up with the numbers linked to these steps</small></button>
            <button type="button" onClick={() => { close(); onPrefill(`Alert me when ${(ans?.headline || title).replace(/\.$/, "").toLowerCase()} changes by more than `); }} data-sd-into="alert"><span>An alert</span><small>check it on a schedule and tell me</small></button>
            <button type="button" onClick={() => { close(); navigate(`/automate?q=${encodeURIComponent(`Every morning, ${title.charAt(0).toLowerCase()}${title.slice(1)}, and save the result as a table`)}`); }} data-sd-into="pipeline"><span>A pipeline</span><small>run these steps every day and keep the table</small></button>
          </>}
        </MenuButton>
      </>}
      tools={<>
        {canEdit && <button type="button" className={`sd-tool${adding ? " on" : ""}`} onClick={() => setAdding((a) => !a)} disabled={busy} data-sd-add-step=""><Ic n="plus" />Add step</button>}
        {canEdit && !stepwise && <button type="button" className="sd-tool" onClick={() => void runAll()} disabled={busy} data-sd-run-all=""><Ic n="play" />Run all</button>}
        <span className="sd-vr" />
        <MenuButton icon="db" label={sources.length ? sources.slice(0, 2).join(", ") + (sources.length > 2 ? ` +${sources.length - 2}` : "") : "Sources"} data="sources">
          {(close) => <>
            {sources.map((s) => <button key={s} type="button" onClick={close}><span>{s}</span><small>read in place, read-only</small></button>)}
            <span className="sep" />
            <button type="button" onClick={() => { close(); navigate("/data"); }}>Manage data sources</button>
          </>}
        </MenuButton>
        {scope && <span className="sd-tool" title="The scope this answer used. Ask to change it."><Ic n="filter" />{scope}</span>}
        <span className="sd-vr" />
        <button type="button" className={`sd-tool${showCode ? " on" : ""}`} onClick={() => setShowCode((s) => !s)} aria-pressed={showCode} data-sd-show-code=""><Ic n="code" />{showCode ? "Hide code" : "Show code"}</button>
      </>}>
      <div className="sd-nb" data-c2-analysis-steps="">
        {err && <div className="sd-err" style={{ marginBottom: 12 }}>{err}</div>}
        {adding && (
          <form className="sd-card" style={{ padding: 14, marginBottom: 16, display: "flex", gap: 8, flexWrap: "wrap" }} onSubmit={(e) => { e.preventDefault(); void add(); }} data-sd-add-form="">
            <input className="sd-in" style={{ flex: 1, minWidth: 240 }} autoFocus value={addText} onChange={(e) => setAddText(e.target.value)}
              placeholder="Describe the step: “split the change by store”, “add last year for comparison”…" aria-label="Describe the new step" />
            <button type="submit" className="sd-btnp" disabled={addBusy || addText.trim().length < 3}>{addBusy ? "Writing the step…" : "Add and run"}</button>
          </form>
        )}
        {stepwise && (
          <div className="sd-plan" data-sd-plan="">
            <span className="sd-lbl">The plan</span>
            <b>{run.plan?.title || title}</b>
            {planning && <span className="sd-chip"><span className="c2-spin" /> Planning the steps · step 1 runs as soon as the plan is ready</span>}
          </div>
        )}
        {planning && !steps.length && [0, 1, 2].map((i) => (
          <div key={i} className="sd-sb wait" aria-hidden="true"><span className="sd-nm">{i + 1}</span><div className="sd-card sd-waitcard sd-skel"><i style={{ width: `${46 + i * 12}%` }} /><i style={{ width: `${70 - i * 8}%` }} /></div></div>
        ))}
        {steps.map((s, i) => (stepwise && s.status === "pending"
          ? <WaitingStep key={s.id} n={next()} step={s} next={i === firstWaiting} />
          : <DataStep key={s.id} n={next()} step={s} runId={run.id} canEdit={canEdit} showCode={showCode} onAsk={onPrefill} onChanged={changed} onError={setErr} busy={busy} removable={steps.length > 1}
              canExplain={canExplain} currency={currency}
              check={i === checkIdx} nextLabel={i === checkIdx ? (steps.slice(i + 1).some((x) => x.status !== "done") ? `Looks right, run step ${steps.findIndex((x, j) => j > i && x.status !== "done") + 1}` : "Looks right, write the answer") : undefined} />))}
        {kpis.length > 0 && (
          <StepCard n={next()} kind="metric" title={und.metric ? String(und.metric).replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "The numbers"}
            acts={<CardAsk label="the key numbers" prefix="About the key numbers" target={{ kind: "kpis" }} runId={run.id} canExplain={canExplain} onPrefill={onPrefill} />}>
            {und.method && <p className="sd-sub sd-method">{String(und.method).replace(/^./, (c) => c.toUpperCase()).replace(/\.?$/, ".")}</p>}
            <div className="sd-kpitiles" data-sd-kpis="">
              {kpis.map((k) => <div key={k.label} className="t"><span>{k.label}</span><b>{k.display}</b></div>)}
            </div>
          </StepCard>
        )}
        {visuals.map(({ v, i }) => (
          <StepCard key={`v${i}`} n={next()} kind="chart" title={(v as any).title || "Chart"}
            acts={<CardAsk label={`the chart “${(v as any).title || "Chart"}”`} prefix={`About the chart “${(v as any).title || "Chart"}”`}
              target={{ kind: "visual", index: i }} runId={run.id} canExplain={canExplain} onPrefill={onPrefill} />}
            foot={(v as any).sources?.length ? <><span className="sd-proof"><span className="sd-dot good" />Counted from {(v as any).sources.join(", ")}</span></> : undefined}>
            <ChartBody v={v} id={`${run.id}:sd${i}`} />
          </StepCard>
        ))}
        {ans && (ans.headline || ans.answer) && (
          <StepCard n={next()} kind="text" title="Findings" cls={res?.answer_stale ? "" : undefined}
            badge={res?.answer_stale ? <span className="sd-chip warn">Being rewritten</span> : ans.written_by === "template" ? <span className="sd-chip">Written from the numbers</span> : null}
            acts={<CardAsk label="the findings" prefix="About the findings" target={{ kind: "answer" }} runId={run.id} canExplain={canExplain} onPrefill={onPrefill} />}>
            <div className="sd-prose" data-sd-findings="">
              <p><b>{ans.headline}</b>{ans.answer && ans.answer !== ans.headline ? ` ${ans.answer}` : ""}</p>
              {(ans.causes || []).length > 0 && (
                <ol>{(ans.causes || []).slice(0, 6).map((c, i) => <li key={i}><b style={{ fontWeight: 600 }}>{c.title}</b>{c.amount ? <span className="sd-mono"> {c.amount}{c.share ? ` · ${c.share}` : ""}</span> : null}{c.detail ? ` — ${c.detail}` : ""}</li>)}</ol>
              )}
              {(ans.ruled_out || []).length > 0 && <p className="sd-sub" style={{ marginTop: 8 }}>Ruled out: {(ans.ruled_out || []).slice(0, 3).map((r) => r.title).join("; ")}</p>}
            </div>
          </StepCard>
        )}
        {evidence.map((t, i) => (
          <StepCard key={`e${t.id || i}`} n={next()} kind="table" title={t.title || "Table"}
            acts={<button type="button" className="sd-tool sm" onClick={() => saveBlob(`${safeName(t.title)}.csv`, toCsv(t.columns.map((c) => c.name), t.rows))}><Ic n="dl" />CSV</button>}
            foot={<span className="sd-chip"><Ic n="db" />{t.source}{t.truncated ? " · first rows" : ""}</span>}>
            <DataTable visual={{ type: "chart", title: t.title, columns: t.columns, rows: t.rows.slice(0, 50) } as any} />
          </StepCard>
        ))}
        {!steps.length && !ans && <div className="sd-empty">This answer has no steps to show.</div>}
        {(res?.warnings || []).length > 0 && <div className="sd-note" style={{ marginLeft: 44 }}>{(res?.warnings || []).slice(0, 3).join(" · ")}</div>}
      </div>
    </StudioFrame>
  );
}
