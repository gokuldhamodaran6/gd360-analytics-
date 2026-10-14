// 2026-10-13 (R43, Analyst brain): the answer page for a question the
// Analyst worked out (a what-if, a cost to compute, a simulation, finance,
// statistics - with or without data). Decision first; every option side by
// side; the rates as live sliders (recomputed in the browser from the safe
// formulas the analysis returned - no new question); where the choice would
// flip; how it was worked out, with the checks it passed and its code.
// 2026-10-13 (R44, answer polish): the page is decision -> live chart ->
// one trimmed table; assumptions are a row of chips that open their own
// slider; the work trail lives only in Method; follow-ups sit in the thread.
import { useMemo, useState } from "react";
import type { ProjectRun } from "../api/projects";
import { API_URL } from "../api/client";
import { VisualCard } from "./Visuals";
import { useAsk } from "./WaysForward";
import { shortTitle } from "../thread/DashboardFlow";
import { friendlyError } from "./errors";
import {
  bestIndex, cell, computeRows, leadNum as leadNumShared, normalizeModel, num, ScenarioAssumptions, ScenarioChart,
  ScenarioDecision, ScenarioTable, useScenarioValues, type ScenarioModel,
} from "./ScenarioBlock";
export { cleanLabel } from "./ScenarioBlock";
import { cleanLabel } from "./ScenarioBlock";

type Model = ScenarioModel;
type Table = { title: string; columns: { name: string; dtype: string }[]; rows: Record<string, any>[]; rows_total?: number; truncated?: boolean };
type Check = { label: string; expected: number | null; got: number | null; ok: boolean };
type Progress = { id: string; label: string; status: string; detail?: string | null; at_s?: number };
export type Analyst = {
  title?: string; understanding?: string; reading?: string; other_readings?: string[]; method?: string; assumptions?: string[];
  steps?: string[]; code?: string; attempts?: { attempt: number; ok: boolean; error?: string | null; ms: number }[]; checks?: Check[];
  key_numbers?: Record<string, number>; tables?: Table[]; model?: Model | null; no_data?: boolean; elapsed_s?: number;
  data_used?: { name: string; rows: number; notes?: string[]; checks?: any[] }[]; fallback_note?: string | null;
};

export const analystOf = (run: ProjectRun | null | undefined): Analyst | null => ((run?.result as any)?.analyst as Analyst) || null;
export const isAnalystRun = (run: ProjectRun | null | undefined): boolean =>
  Boolean(run && (((run as any).mode === "analyst") || (run.plan as any)?.mode === "analyst" || (run.result as any)?.analysis_type === "analyst"));
export const progressOf = (run: ProjectRun): Progress[] => ((run as any).analyst_progress || (run.plan as any)?.progress || []) as Progress[];

// 2026-10-13 (R45): the evaluator, ranking, break-even search, chips, chart and options table live in
// ./ScenarioBlock.tsx - one implementation shared with the dashboard "scenario" block.
const leadNum = leadNumShared;
const plural = (n: number, w: string) => (n === 1 ? w : `${w}s`);
const MONEY_COL = /\(\s*[$€£₹¥]\s*\)|[$€£₹¥]|\b(cost|costs|revenue|price|profit|spend|wage|salary|margin|npv|cash)\b/i;
const colSym = (name: string) => (name.match(/[$€£₹¥]/) || ["$"])[0];
/** One formatter per column, so every row of a column shows the same decimals and currency. */
function columnFormat(name: string, values: any[]): (v: any) => string {
  const nums = values.filter((v) => typeof v === "number" && Number.isFinite(v)) as number[];
  const frac = nums.some((v) => Math.abs(v - Math.round(v)) > 1e-9);
  const big = nums.some((v) => Math.abs(v) >= 1000);
  if (MONEY_COL.test(name)) {
    const sym = colSym(name);
    const d = frac && !big ? 2 : 0;
    return (v) => (typeof v === "number" && Number.isFinite(v) ? `${v < 0 ? "−" : ""}${sym}${num(Math.abs(v), d, d)}` : cell(v));
  }
  const d = !frac ? 0 : nums.some((v) => Math.abs(v) < 1 && Math.abs(v) > 0) ? 2 : nums.every((v) => Math.abs(v * 10 - Math.round(v * 10)) < 1e-9) ? 1 : 2;
  return (v) => (typeof v === "number" && Number.isFinite(v) ? num(v, d, d) : cell(v));
}
const headerName = (n: string) => n.replace(/\s*\(\s*[$€£₹¥]\s*\)/, "");

// ---- the page -----------------------------------------------------------------------------------------------
export function AnalystAnswer({ run }: { run: ProjectRun }) {
  const a = analystOf(run) as Analyst;
  const ans = run.result?.answer;
  const ask = useAsk();
  const model = useMemo(() => normalizeModel(a.model), [a.model]);
  const { init, vals, setVals } = useScenarioValues(model);
  const rows = useMemo(() => (model ? computeRows(model, vals) : []), [model, vals]);
  const best = model ? bestIndex(model, rows) : -1;
  const changed = Boolean(model?.inputs.some((i) => Math.abs((vals[i.key] ?? i.value) - i.value) > 1e-12));
  // a static chart of the same options as the live model is redundant (and goes stale when a rate moves)
  const visuals = (run.result?.visuals || []).filter((v: any) => !model || (v.rows || []).length !== model.rows.length);
  const checks = a.checks || [];
  const passed = checks.filter((c) => c.ok);
  return (
    <div className="flex flex-col gap-5" data-analyst-answer="">
      <section className="relative rounded-[20px] border border-kind-answer-border bg-surface p-5 sm:p-7 flex flex-col gap-4">
        <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-[20px]" aria-hidden="true">
          <div className="absolute -top-24 -right-16 w-[420px] h-[260px] opacity-70" style={{ background: "radial-gradient(closest-side, rgb(var(--color-kind-answer) / 0.13), transparent)" }} />
        </div>
        <span className="relative font-mono text-[11px] uppercase tracking-[0.14em] text-kind-answer">The answer{a.no_data ? " · worked out from your question" : ""}</span>
        <h2 className="relative m-0 text-[22px] sm:text-[27px] leading-[1.25] font-semibold tracking-[-0.015em] text-text text-balance" data-analyst-headline="">{ans?.headline}</h2>
        {ans?.answer && <p className="relative m-0 text-body sm:text-[15.5px] leading-[1.65] text-secondary max-w-[900px]">{ans.answer}</p>}
        {((ans as any)?.bullets || []).length > 0 && (
          <ul className="relative m-0 pl-5 flex flex-col gap-1.5 text-ui text-secondary">
            {((ans as any).bullets as string[]).map((b, i) => <li key={i}>{b}</li>)}
          </ul>
        )}
        {(passed.length > 0 || checks.some((c) => !c.ok) || (a.other_readings || []).length > 0) && (
          <div className="relative flex gap-2 flex-wrap">
            {passed.length > 0 && (
              <span className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full bg-good-fill text-good text-caption" title={passed.map((c) => `${c.label}: expected ${cell(c.expected)}, got ${cell(c.got)}`).join("\n")} data-analyst-check="">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7" /></svg>
                Matches your {a.no_data ? "inputs" : "data"}{passed[0].expected !== null ? <b className="font-mono font-medium tabular-nums">· {cell(passed[0].expected)}</b> : null}
              </span>
            )}
            {checks.some((c) => !c.ok) && <span className="inline-flex items-center h-8 px-3 rounded-full bg-warning-fill text-warning text-caption">A check didn't match - see Method before relying on this</span>}
            {(a.other_readings || []).slice(0, 1).map((q) => (
              <button key={q} type="button" disabled={!ask} onClick={() => ask && ask(q)} title={a.reading ? `Read as: ${a.reading}` : q}
                className="ui-focus inline-flex items-center h-8 px-3 rounded-full border border-border-strong text-caption text-text hover:bg-subtle disabled:opacity-50 max-w-full" data-analyst-reading="">
                <span className="truncate">Meant something else? {q.length > 64 ? `${q.slice(0, 64).replace(/\s+\S*$/, "")}…` : q}</span>
              </button>
            ))}
          </div>
        )}
        <ScenarioAssumptions model={model} vals={vals} setVals={setVals} init={init} notes={a.assumptions || []} />
      </section>

      {/* 2026-10-13 (R45): the live what-if is project/ScenarioBlock's chart + table (the same pieces a dashboard draws) */}
      {model && (
        <ScenarioChart
          model={model}
          rows={rows}
          best={best}
          decision={changed ? <ScenarioDecision model={model} rows={rows} best={best} note="With your changes:" /> : undefined}
        />
      )}
      {model && <ScenarioTable model={model} rows={rows} best={best} vals={vals} changed={changed} actions={<ExcelButton run={run} vals={vals} />} />}

      {visuals.map((v, i) => <VisualCard key={i} visual={v} id={`${run.id}:a${i}`} />)}

      {(a.tables || []).map((t, i) => <DataTable key={i} table={t} open={i === 0 && !model} />)}
    </div>
  );
}

/** Follow-up chips for the thread, next to the question box. */
export function AnalystNext({ run, onAsk, disabled }: { run: ProjectRun; onAsk: (q: string) => void; disabled?: boolean }) {
  const qs = (run.result?.answer?.next_questions || []).slice(0, 3);
  if (!qs.length) return null;
  return (
    <div className="flex flex-col gap-1.5" data-analyst-next-chips="">
      <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-muted">Ask next</span>
      <div className="flex flex-col items-start gap-1.5">
        {qs.map((q) => (
          <button key={q} type="button" disabled={disabled} onClick={(e) => { e.stopPropagation(); onAsk(q); }} title={q}
            className="ui-focus max-w-full text-left px-3 py-1.5 rounded-[12px] border border-border bg-surface text-caption text-text leading-snug hover:border-kind-answer-border hover:bg-kind-answer-fill/30 disabled:opacity-50" data-analyst-next="">
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---- Excel --------------------------------------------------------------------------------------------------
/** 2026-10-13 (R45): "attachment; filename*=UTF-8''Barista%20costs.xlsx" -> "Barista costs.xlsx" (null when absent). */
export function filenameFromDisposition(header: string | null | undefined): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*([^;]+)/i.exec(header);
  if (star) {
    let v = star[1].trim().replace(/^"(.*)"$/, "$1");
    const m = /^([\w-]+)'[^']*'(.*)$/.exec(v);
    if (m) v = m[2];
    try { const d = decodeURIComponent(v); if (d.trim()) return d.trim(); } catch { /* fall through to filename= */ }
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(header);
  const v = (plain?.[2] ?? plain?.[1] ?? "").trim();
  return v || null;
}

/** "<short title>.xlsx", safe for every file system. */
export function xlsxName(title: string): string {
  const base = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80).trim();
  return `${base || "GD360 analysis"}.xlsx`;
}

function ExcelButton({ run, vals }: { run: ProjectRun; vals: Record<string, number> }) {
  const [state, setState] = useState<"" | "busy" | "error">("");
  const [err, setErr] = useState("");
  const download = async () => {
    if (state === "busy") return;
    setState("busy");
    setErr("");
    try {
      const { api } = await import("../api/client");
      const r = await api.get(`/projects/runs/${run.id}/analyst.xlsx`, { params: { inputs: JSON.stringify(vals) }, responseType: "blob" });
      const name = filenameFromDisposition(r.headers?.["content-disposition"]) || xlsxName(shortTitle(run));
      const url = URL.createObjectURL(r.data as Blob);
      const el = document.createElement("a");
      el.href = url;
      el.download = name;
      document.body.appendChild(el);
      el.click();
      el.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 2000);
      setState("");
    } catch (e: any) {
      setErr(friendlyError(e?.response?.data?.detail, "The Excel file couldn't be made. Please try again.").text);
      setState("error");
    }
  };
  return (
    <span className="flex flex-col items-end gap-1">
      <a href={`${API_URL}/projects/runs/${run.id}/analyst.xlsx?${new URLSearchParams({ inputs: JSON.stringify(vals) })}`}
        onClick={(e) => { e.preventDefault(); void download(); }}
        aria-busy={state === "busy"}
        className="ui-focus inline-flex items-center gap-2 h-8 px-3 rounded-ctl border border-border-strong text-caption text-text hover:bg-subtle" data-analyst-xlsx="">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 4v12M7 11l5 5 5-5M5 20h14" /></svg>
        {state === "busy" ? "Preparing…" : "Excel"}
      </a>
      {state === "error" && <span role="alert" className="text-caption text-danger max-w-[260px] text-right" data-analyst-xlsx-error="">{err}</span>}
    </span>
  );
}

const MAX_COLS = 6;
function DataTable({ table, open: initial }: { table: Table; open: boolean }) {
  const [open, setOpen] = useState(initial);
  const [all, setAll] = useState(false);
  const [wide, setWide] = useState(false);
  const rows = all ? table.rows : table.rows.slice(0, 12);
  const cols = table.columns;
  // a number column that only repeats the start of a text column ("Baristas" 2 | "2 Baristas") is hidden
  const dup = new Set(cols.filter((c) => c.dtype === "number" && table.rows.length > 0 && cols.some((s) => s.dtype !== "number" && table.rows.every((r) => leadNum(String(r[s.name] ?? "")) === r[c.name]))).map((c) => c.name));
  const usable = cols.filter((c) => !dup.has(c.name));
  // the default view: the label, then the columns a decision is made on
  const score = (n: string) => (/total/i.test(n) ? 4 : 0) + (MONEY_COL.test(n) ? 3 : 0) + (/avg|average|mean|rate|share|%/i.test(n) ? 2 : 0) + (/max|min\b|count|delayed/i.test(n) ? -1 : 0);
  const keep = usable.length <= MAX_COLS ? usable : (() => {
    const text = usable.filter((c) => c.dtype !== "number").slice(0, 1);
    const nums = usable.filter((c) => c.dtype === "number").map((c, i) => ({ c, s: score(c.name), i }))
      .sort((x, y) => y.s - x.s || x.i - y.i).slice(0, MAX_COLS - text.length).map((x) => x.c.name);
    return usable.filter((c) => text.includes(c) || nums.includes(c.name));
  })();
  const shown = wide ? cols : keep;
  const fmt = useMemo(() => Object.fromEntries(cols.map((c) => [c.name, c.dtype === "number" ? columnFormat(c.name, table.rows.map((r) => r[c.name])) : (v: any) => (typeof v === "string" ? cleanLabel(v) : cell(v))])), [table]);
  return (
    <section className="rounded-card border border-border bg-surface overflow-hidden" data-analyst-table="">
      <div className="flex items-center gap-2 pr-3 hover:bg-subtle/30">
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="ui-focus flex-1 min-w-0 px-5 py-4 flex items-center justify-between gap-3 text-left">
          <span className="flex flex-col min-w-0"><span className="text-section font-semibold text-text">{table.title}</span>
            <span className="text-caption text-muted">{num(table.rows_total ?? table.rows.length)} {plural(table.rows_total ?? table.rows.length, "row")} · {cols.length} {plural(cols.length, "column")}</span></span>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`}><path d="M6 9l6 6 6-6" /></svg>
        </button>
      </div>
      {open && (
        <>
          <div className="overflow-x-auto border-t border-border">
            <table className="w-full text-ui border-collapse">
              <thead><tr className="text-left text-caption text-muted bg-base/40">{shown.map((c) => <th key={c.name} className={`font-normal px-4 first:pl-5 last:pr-5 py-2.5 whitespace-nowrap ${c.dtype === "number" ? "text-right" : ""}`}>{c.dtype === "number" ? headerName(c.name) : c.name}</th>)}</tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className="border-t border-border">
                    {shown.map((c) => <td key={c.name} className={`px-4 first:pl-5 last:pr-5 py-2.5 whitespace-nowrap ${c.dtype === "number" ? "text-right font-mono tabular-nums text-secondary" : "text-text"}`}>{fmt[c.name](r[c.name])}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(table.rows.length > 12 || keep.length < cols.length) && (
            <div className="flex items-center gap-4 px-5 py-3 border-t border-border flex-wrap">
              {keep.length < cols.length && (
                <button type="button" onClick={() => setWide((x) => !x)} className="ui-focus text-caption text-kind-answer hover:underline" data-table-all-cols="">
                  {wide ? "Fewer columns" : `All columns (${cols.length})`}
                </button>
              )}
              {table.rows.length > 12 && (
                <button type="button" onClick={() => setAll((x) => !x)} className="ui-focus text-caption text-kind-answer hover:underline">
                  {all ? "Show fewer rows" : `Show all ${num(table.rows.length)} rows`}
                </button>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function WorkedOut({ a }: { a: Analyst }) {
  const checks = a.checks || [];
  const tries = (a.attempts || []).length;
  return (
    <section className="rounded-card border border-border bg-surface p-5 flex flex-col gap-3" data-analyst-worked="">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h3 className="m-0 text-section font-semibold text-text">How I worked it out</h3>
        <span className="text-caption text-muted">{a.elapsed_s ? `${a.elapsed_s} s` : ""}{tries > 1 ? ` · fixed itself after ${tries - 1} failed run${tries > 2 ? "s" : ""}` : ""} · full code in Method</span>
      </div>
      {a.understanding && <p className="m-0 text-ui text-secondary leading-relaxed">{a.understanding}</p>}
      <ol className="m-0 p-0 list-none flex flex-col">
        {(a.steps || []).map((s, i) => (
          <li key={i} className="flex gap-3 py-2.5 border-t border-border first:border-t-0 text-ui">
            <span className="font-mono text-caption text-kind-answer w-5 shrink-0 pt-px">{String(i + 1).padStart(2, "0")}</span>
            <span className="text-text leading-snug">{s}</span>
          </li>
        ))}
      </ol>
      {checks.length > 0 && (
        <div className="flex flex-col gap-1.5 pt-1">
          {checks.map((c, i) => (
            <div key={i} className={`flex items-center gap-2 text-ui ${c.ok ? "text-good" : "text-warning"}`}>
              <span aria-hidden="true">{c.ok ? "✓" : "!"}</span>
              <span className="text-text">{c.label}</span>
              <span className="text-caption text-muted font-mono">expected {cell(c.expected)} · got {cell(c.got)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ---- while it works ---------------------------------------------------------------------------------------
export function AnalystProgress({ run, compact = false }: { run: ProjectRun; compact?: boolean }) {
  const prog = progressOf(run);
  const steps = ((run.plan as any)?.analyst_steps || []) as string[];
  if (!prog.length) {
    return (
      <div className="flex items-center gap-2.5 text-ui text-muted">
        <span className="w-4 h-4 rounded-full border-2 border-border border-t-[rgb(var(--color-kind-answer))] animate-spin" />
        Reading the question…
      </div>
    );
  }
  return (
    <div className={`flex flex-col ${compact ? "gap-2" : "gap-0 rounded-card border border-border bg-surface p-5"}`} data-analyst-progress="">
      {!compact && <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-kind-answer pb-3">Working it out like an analyst</span>}
      {prog.map((p) => (
        <div key={p.id} className={`grid grid-cols-[22px_1fr] gap-2.5 items-start ${compact ? "" : "py-2.5 border-t border-border first-of-type:border-t-0"}`}>
          <span className={`mt-[2px] w-[18px] h-[18px] rounded-full grid place-items-center ${p.status === "done" ? "bg-good text-[rgb(var(--color-base))]" : p.status === "failed" ? "bg-warning text-[rgb(var(--color-base))]" : p.status === "running" ? "border-2 border-kind-answer border-t-transparent animate-spin" : "border-2 border-border-strong"}`} aria-hidden="true">
            {p.status === "done" ? <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 7" /></svg> : p.status === "failed" ? <span className="text-[10px] font-bold">!</span> : null}
          </span>
          <span className="flex flex-col min-w-0">
            <span className={`text-ui ${p.status === "pending" ? "text-muted" : "text-text"}`}>{p.label}{p.at_s != null && p.status === "done" ? <span className="text-caption text-muted"> · {p.at_s} s</span> : null}</span>
            {p.detail && <span className="text-caption text-muted leading-snug">{p.detail}</span>}
            {!compact && p.id === "plan" && p.status === "done" && steps.length > 0 && (
              <ol className="m-0 mt-1.5 pl-4 text-caption text-secondary flex flex-col gap-0.5">{steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---- the Method tab ---------------------------------------------------------------------------------------
export function AnalystMethod({ run }: { run: ProjectRun }) {
  const a = analystOf(run);
  if (!a) return <AnalystProgress run={run} />;
  return (
    <div className="flex flex-col gap-5" data-analyst-method="">
      <section className="rounded-card border border-border bg-surface p-5 flex flex-col gap-2">
        <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">Method</span>
        <p className="m-0 text-body text-text leading-relaxed">{a.method}</p>
        {a.reading && <p className="m-0 text-ui text-secondary">Read the question as: {a.reading}</p>}
        {a.fallback_note && <p className="m-0 text-caption text-muted">A single database query couldn't answer this ({a.fallback_note.slice(0, 160)}), so GD360 worked it out with code.</p>}
      </section>
      <WorkedOut a={a} />
      {(a.data_used || []).length > 0 && (
        <section className="rounded-card border border-border bg-surface p-5 flex flex-col gap-2.5">
          <h3 className="m-0 text-section font-semibold text-text">Data used</h3>
          {(a.data_used || []).map((d) => (
            <div key={d.name} className="flex flex-col gap-1 py-2 border-t border-border first-of-type:border-t-0">
              <span className="text-ui text-text">{d.name} <span className="text-muted">· {num(d.rows)} {plural(d.rows, "row")}</span></span>
              {(d.notes || []).map((n, i) => <span key={i} className="text-caption text-muted">{n}</span>)}
            </div>
          ))}
        </section>
      )}
      {a.code && (
        <section className="rounded-card border border-border bg-surface overflow-hidden">
          <div className="px-5 py-3.5 flex items-center justify-between gap-3 border-b border-border">
            <span className="text-section font-semibold text-text">The code GD360 ran</span>
            <button type="button" onClick={() => navigator.clipboard?.writeText(a.code || "").catch(() => undefined)} className="text-caption text-kind-answer hover:underline">Copy</button>
          </div>
          <pre className="m-0 p-5 overflow-x-auto text-[12.5px] leading-[1.6] font-mono text-secondary bg-base/50 max-h-[520px]">{a.code}</pre>
        </section>
      )}
    </div>
  );
}
