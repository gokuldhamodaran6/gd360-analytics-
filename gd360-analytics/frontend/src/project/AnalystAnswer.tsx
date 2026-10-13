// 2026-10-13 (R43, Analyst brain): the answer page for a question the
// Analyst worked out (a what-if, a cost to compute, a simulation, finance,
// statistics - with or without data). Decision first; every option side by
// side; the rates as live sliders (recomputed in the browser from the safe
// formulas the analysis returned - no new question); where the choice would
// flip; how it was worked out, with the checks it passed and its code.
import { useMemo, useState } from "react";
import type { ProjectRun } from "../api/projects";
import { API_URL } from "../api/client";
import { VisualCard } from "./Visuals";
import { useAsk } from "./WaysForward";

type Input = { key: string; label: string; value: number; min: number; max: number; step: number; unit: string };
type Row = { label: string; values: Record<string, number>; computed: Record<string, number> };
type Output = { key: string; label: string; expr: string; format: string };
type Model = { inputs: Input[]; rows: Row[]; outputs: Output[]; pick: { output: string; goal: "min" | "max" } };
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

// ---- a tiny, safe expression evaluator (the model's formulas) ----------------------------------------------
function evaluate(expr: string, names: Record<string, number>): number {
  const toks = expr.match(/\d+\.?\d*(?:e[-+]?\d+)?|\.\d+|[A-Za-z_][A-Za-z0-9_]*|\*\*|[-+*/(),]/g) || [];
  let i = 0;
  const peek = () => toks[i];
  const next = () => toks[i++];
  const prim = (): number => {
    const t = next();
    if (t === undefined) throw new Error("end");
    if (t === "(") { const v = add(); next(); return v; }
    if (t === "-") return -power();
    if (t === "+") return power();
    if (/^[\d.]/.test(t)) return parseFloat(t);
    if (peek() === "(") {
      next();
      const args: number[] = [];
      if (peek() !== ")") { args.push(add()); while (peek() === ",") { next(); args.push(add()); } }
      next();
      if (t === "min") return Math.min(...args);
      if (t === "max") return Math.max(...args);
      if (t === "abs") return Math.abs(args[0]);
      if (t === "round") return args.length > 1 ? Math.round(args[0] * 10 ** args[1]) / 10 ** args[1] : Math.round(args[0]);
      throw new Error(t);
    }
    if (!(t in names)) throw new Error(t);
    return names[t];
  };
  const power = (): number => { const b = prim(); if (peek() === "**") { next(); return b ** unary(); } return b; };
  const unary = (): number => (peek() === "-" ? (next(), -unary()) : power());
  const mul = (): number => { let v = unary(); while (peek() === "*" || peek() === "/") { const op = next(); const r = unary(); v = op === "*" ? v * r : v / r; } return v; };
  const add = (): number => { let v = mul(); while (peek() === "+" || peek() === "-") { const op = next(); const r = mul(); v = op === "+" ? v + r : v - r; } return v; };
  return add();
}

function compute(m: Model, vals: Record<string, number>): Row[] {
  return m.rows.map((r) => {
    const names: Record<string, number> = { ...vals, ...r.values };
    const out: Record<string, number> = {};
    for (const o of m.outputs) {
      try { out[o.key] = evaluate(o.expr, { ...names, ...out }); } catch { out[o.key] = NaN; }
    }
    return { ...r, computed: out };
  });
}

function bestIndex(m: Model, rows: Row[]): number {
  let best = -1;
  rows.forEach((r, i) => {
    const v = r.computed[m.pick.output];
    if (!Number.isFinite(v)) return;
    if (best < 0 || (m.pick.goal === "min" ? v < rows[best].computed[m.pick.output] - 1e-9 : v > rows[best].computed[m.pick.output] + 1e-9)) best = i;
  });
  return best;
}

// ---- formatting ---------------------------------------------------------------------------------------------
const nf = (v: number, d = 0) => v.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: 0 });
function fmtOut(v: number, format: string, sym: string): string {
  if (!Number.isFinite(v)) return "–";
  const a = Math.abs(v);
  const sign = v < 0 ? "−" : "";
  if (format === "money") return `${sign}${sym}${a >= 1000 ? nf(a, 0) : nf(a, a < 10 ? 2 : 0)}`;
  if (format === "percent") return `${nf(v, 1)}%`;
  if (format === "minutes") return `${nf(v, a < 10 ? 1 : 0)} min`;
  if (format === "hours") return `${nf(v, 1)} h`;
  if (format === "integer") return nf(v, 0);
  return a >= 100 ? nf(v, 0) : nf(v, 2);
}
function fmtInput(i: Input, v: number): string {
  const d = i.step < 0.01 ? 3 : i.step < 1 ? 2 : 0;
  if (/^[$€£₹¥]$/.test(i.unit)) return `${i.unit}${v.toLocaleString(undefined, { minimumFractionDigits: d > 0 && v < 100 ? Math.min(d, 2) : 0, maximumFractionDigits: d })}`;
  if (i.unit === "%" || (i.max <= 1 && /rate|share|pct|percent/i.test(i.key + i.label))) return `${nf(i.max <= 1 ? v * 100 : v, 1)}%`;
  return `${nf(v, d)}${i.unit ? ` ${i.unit}` : ""}`;
}
const pretty = (k: string) => k.replace(/_/g, " ").replace(/\bmin\b/, "(min)").replace(/^\w/, (c) => c.toUpperCase());
function cell(v: any): string {
  if (v === null || v === undefined) return "–";
  if (typeof v === "number") return Math.abs(v) >= 1000 ? nf(v, 0) : Number.isInteger(v) ? String(v) : nf(v, Math.abs(v) < 1 ? 3 : 2);
  return String(v);
}

// ---- the page -----------------------------------------------------------------------------------------------
export function AnalystAnswer({ run }: { run: ProjectRun }) {
  const a = analystOf(run) as Analyst;
  const ans = run.result?.answer;
  const ask = useAsk();
  const visuals = run.result?.visuals || [];
  const checks = a.checks || [];
  const passed = checks.filter((c) => c.ok);
  return (
    <div className="flex flex-col gap-5" data-analyst-answer="">
      <section className="relative overflow-hidden rounded-[20px] border border-kind-answer-border bg-surface p-5 sm:p-7 flex flex-col gap-4">
        <div className="pointer-events-none absolute -top-24 -right-16 w-[420px] h-[260px] opacity-70" style={{ background: "radial-gradient(closest-side, rgb(var(--color-kind-answer) / 0.13), transparent)" }} />
        <span className="relative font-mono text-[11px] uppercase tracking-[0.14em] text-kind-answer">The answer{a.no_data ? " · worked out from your question" : ""}</span>
        <h2 className="relative m-0 text-[22px] sm:text-[27px] leading-[1.25] font-semibold tracking-[-0.015em] text-text text-balance" data-analyst-headline="">{ans?.headline}</h2>
        {ans?.answer && <p className="relative m-0 text-body sm:text-[15.5px] leading-[1.65] text-secondary max-w-[900px]">{ans.answer}</p>}
        {((ans as any)?.bullets || []).length > 0 && (
          <ul className="relative m-0 pl-5 flex flex-col gap-1.5 text-ui text-secondary">
            {((ans as any).bullets as string[]).map((b, i) => <li key={i}>{b}</li>)}
          </ul>
        )}
        <div className="relative flex gap-2 flex-wrap">
          {passed.length > 0 && (
            <span className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full bg-good-fill text-good text-caption" data-analyst-check="">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7" /></svg>
              {passed[0].label}{passed[0].expected !== null ? ` (${cell(passed[0].expected)})` : ""}
            </span>
          )}
          {checks.some((c) => !c.ok) && <span className="inline-flex items-center h-8 px-3 rounded-full bg-warning-fill text-warning text-caption">A check didn't match - read the method before relying on this</span>}
          {(a.assumptions || []).length > 0 && (
            <span className="inline-flex items-center h-8 px-3 rounded-full bg-warning-fill/60 text-warning text-caption">{(a.assumptions || []).length} assumption{(a.assumptions || []).length > 1 ? "s" : ""} - change them below</span>
          )}
          {a.reading && <span className="inline-flex items-center h-8 px-3 rounded-full bg-subtle text-caption text-secondary max-w-full truncate" title={a.reading}>Read as: {a.reading}</span>}
          {(a.other_readings || []).slice(0, 1).map((q) => (
            <button key={q} type="button" disabled={!ask} onClick={() => ask && ask(q)} className="ui-focus inline-flex items-center h-8 px-3 rounded-full border border-border-strong text-caption text-text hover:bg-subtle disabled:opacity-50" data-analyst-reading="">
              Meant something else? {q.length > 60 ? `${q.slice(0, 60)}…` : q}
            </button>
          ))}
        </div>
      </section>

      {a.model && <LiveModel model={a.model} runId={run.id} />}

      {visuals.map((v, i) => <VisualCard key={i} visual={v} id={`${run.id}:a${i}`} />)}

      {(a.tables || []).map((t, i) => <DataTable key={i} table={t} open={i === 0 && !a.model} />)}

      {(a.assumptions || []).length > 0 && (
        <section className="rounded-card border border-border bg-surface p-5 flex flex-col gap-3">
          <h3 className="m-0 text-section font-semibold text-text">What I assumed</h3>
          <div className="grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))" }}>
            {(a.assumptions || []).map((x, i) => (
              <div key={i} className="flex gap-2.5 items-start px-3.5 py-3 rounded-ctl bg-base text-ui text-secondary leading-snug">
                <span className="mt-0.5 w-5 h-5 rounded-full bg-warning-fill text-warning grid place-items-center text-[11px] font-semibold shrink-0" aria-hidden="true">{i + 1}</span>{x}
              </div>
            ))}
          </div>
        </section>
      )}

      <WorkedOut a={a} />

      {(ans?.next_questions || []).length > 0 && (
        <section className="flex flex-col gap-2">
          <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">Push it further</span>
          <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))" }}>
            {(ans?.next_questions || []).map((q) => (
              <button key={q} type="button" disabled={!ask} onClick={() => ask && ask(q)} className="ui-focus text-left min-h-11 px-4 py-3 rounded-[14px] border border-border bg-surface text-ui text-text hover:border-kind-answer-border hover:bg-kind-answer-fill/30 disabled:opacity-50" data-analyst-next="">
                {q}
              </button>
            ))}
          </div>
        </section>
      )}
      <p className="m-0 text-caption text-muted">
        {a.no_data ? "No data was attached: every number comes from the stated assumptions and the analysis code, which you can read in Method." : "Every number above was computed by code run on your data; the text was checked against those numbers before it was shown."}
      </p>
    </div>
  );
}

function LiveModel({ model, runId }: { model: Model; runId: string }) {
  const init = useMemo(() => Object.fromEntries(model.inputs.map((i) => [i.key, i.value])), [model]);
  const [vals, setVals] = useState<Record<string, number>>(init);
  const rows = useMemo(() => compute(model, vals), [model, vals]);
  const best = bestIndex(model, rows);
  const sym = model.inputs.find((i) => /^[$€£₹¥]$/.test(i.unit))?.unit || "$";
  const pick = model.outputs.find((o) => o.key === model.pick.output) || model.outputs[model.outputs.length - 1];
  const changed = model.inputs.some((i) => Math.abs((vals[i.key] ?? i.value) - i.value) > 1e-12);
  // the parts the picked number is the sum of ("waiting_cost + labor") - drawn as a stacked bar
  const parts = useMemo(() => {
    const ids = pick.expr.split("+").map((x) => x.trim());
    return ids.length > 1 && ids.every((x) => model.outputs.some((o) => o.key === x)) ? ids : [];
  }, [pick, model]);
  const maxV = Math.max(1e-9, ...rows.map((r) => Math.abs(r.computed[pick.key] || 0)));
  const valueKeys = Object.keys(model.rows[0]?.values || {}).filter((k) => !/^(k|n|id)$/.test(k));
  const flips = useMemo(() => model.inputs.slice(0, 3).map((inp) => {
    // the range of this input (others held) where today's best option stays best
    if (best < 0) return null;
    const label = rows[best].label;
    const steps = 240;
    const lo = inp.min, hi = inp.max;
    const cur = vals[inp.key];
    const bestAt = (x: number) => { const rr = compute(model, { ...vals, [inp.key]: x }); const b = bestIndex(model, rr); return b >= 0 ? rr[b].label : ""; };
    const xs = Array.from({ length: steps + 1 }, (_, s) => lo + ((hi - lo) * s) / steps);
    const ok = xs.map((x) => bestAt(x) === label);
    let c = 0;
    xs.forEach((x, k) => { if (Math.abs(x - cur) < Math.abs(xs[c] - cur)) c = k; });
    if (!ok[c]) return null;
    let l = c, r = c;
    while (l > 0 && ok[l - 1]) l--;
    while (r < steps && ok[r + 1]) r++;
    // the exact edge between a grid point that keeps the choice and the next that doesn't
    const edge = (inside: number, outside: number) => {
      let a = inside, b = outside;
      for (let k = 0; k < 40; k++) { const m = (a + b) / 2; if (bestAt(m) === label) a = m; else b = m; }
      return a;
    };
    const from: number | null = l > 0 ? edge(xs[l], xs[l - 1]) : xs[l];
    const to: number | null = r < steps ? edge(xs[r], xs[r + 1]) : xs[r];
    if (from === null || to === null) return null;
    return { inp, label, from, to, atMin: from <= lo + 1e-9, atMax: to >= hi - 1e-9 };
  }).filter(Boolean) as { inp: Input; label: string; from: number; to: number; atMin: boolean; atMax: boolean }[], [model, vals, rows, best]);
  const COLORS = ["rgb(var(--color-series-2))", "rgb(var(--color-series-1))", "rgb(var(--color-series-3))", "rgb(var(--color-series-4))"];
  return (
    <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_330px] items-start" data-analyst-model="">
      <div className="rounded-card border border-border bg-surface flex flex-col min-w-0 overflow-hidden">
        <div className="px-5 pt-5 pb-3 flex items-baseline justify-between gap-3 flex-wrap">
          <h3 className="m-0 text-section font-semibold text-text">Every option, side by side</h3>
          <span className="text-caption text-muted">{changed ? "with your rates" : "updates as you move the rates"}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-ui border-collapse">
            <thead>
              <tr className="text-left text-caption text-muted border-y border-border bg-base/40">
                <th className="font-normal px-5 py-2.5">Option</th>
                {valueKeys.map((k) => <th key={k} className="font-normal px-3 text-right">{pretty(k)}</th>)}
                {model.outputs.map((o) => <th key={o.key} className={`font-normal px-3 text-right ${o.key === pick.key ? "text-text" : ""}`}>{o.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.label} className={`border-b border-border last:border-b-0 ${i === best ? "bg-kind-answer-fill/40" : ""}`} data-model-row={i === best ? "best" : ""}>
                  <td className="px-5 py-3 whitespace-nowrap">
                    <span className="text-text font-medium">{r.label}</span>
                    {i === best && <span className="ml-2 inline-flex items-center h-5 px-1.5 rounded-md bg-kind-answer text-[rgb(var(--color-base))] text-[10.5px] font-semibold uppercase tracking-[0.04em]">{model.pick.goal === "min" ? "Cheapest" : "Best"}</span>}
                  </td>
                  {valueKeys.map((k) => <td key={k} className="px-3 text-right font-mono tabular-nums text-secondary">{cell(r.values[k])}</td>)}
                  {model.outputs.map((o) => (
                    <td key={o.key} className={`px-3 text-right font-mono tabular-nums ${o.key === pick.key ? (i === best ? "text-kind-answer font-semibold" : "text-text font-semibold") : "text-secondary"}`}>
                      {fmtOut(r.computed[o.key], o.format, sym)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="px-5 py-4 border-t border-border flex flex-col gap-2.5">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <span className="text-ui font-semibold text-text">{pick.label}{parts.length ? " - where it goes" : ""}</span>
            {parts.length > 0 && (
              <span className="flex gap-3 text-caption text-secondary flex-wrap">
                {parts.map((p, i) => <span key={p} className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-[3px]" style={{ background: COLORS[i % 4] }} />{model.outputs.find((o) => o.key === p)?.label}</span>)}
              </span>
            )}
          </div>
          {rows.map((r, i) => (
            <div key={r.label} className="grid grid-cols-[minmax(0,110px)_minmax(0,1fr)_84px] gap-3 items-center">
              <span className={`text-caption truncate ${i === best ? "text-text font-medium" : "text-muted"}`}>{r.label}</span>
              <span className="flex h-[20px] gap-[2px]" role="img" aria-label={`${r.label}: ${fmtOut(r.computed[pick.key], pick.format, sym)}`}>
                {(parts.length ? parts : [pick.key]).map((p, j) => (
                  <span key={p} className="block h-full rounded-[4px] transition-[width] duration-300" style={{ width: `${Math.max(0, (100 * (r.computed[p] || 0)) / maxV)}%`, background: parts.length ? COLORS[j % 4] : i === best ? "rgb(var(--color-kind-answer))" : "rgb(var(--color-series-1))" }} />
                ))}
              </span>
              <span className={`font-mono text-caption text-right tabular-nums ${i === best ? "text-kind-answer" : "text-secondary"}`}>{fmtOut(r.computed[pick.key], pick.format, sym)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <div className="rounded-card border border-border bg-surface p-5 flex flex-col gap-4">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-section font-semibold text-text">Change the assumptions</span>
            {changed && <button type="button" onClick={() => setVals(init)} className="text-caption text-kind-answer hover:underline">Reset</button>}
          </div>
          <span className="text-caption text-muted -mt-3">Instant - no new question needed.</span>
          {model.inputs.map((i) => (
            <label key={i.key} className="flex flex-col gap-1.5">
              <span className="flex items-baseline justify-between gap-2 text-ui"><span className="text-secondary">{i.label}</span><b className="font-mono font-medium text-text tabular-nums">{fmtInput(i, vals[i.key])}</b></span>
              <input type="range" min={i.min} max={i.max} step={i.step} value={vals[i.key]} onChange={(e) => setVals((v) => ({ ...v, [i.key]: Number(e.target.value) }))}
                className="w-full accent-[rgb(var(--color-kind-answer))] h-6" aria-label={i.label} data-model-input={i.key} />
            </label>
          ))}
          <a href={`${API_URL}/projects/runs/${runId}/analyst.xlsx?${new URLSearchParams({ inputs: JSON.stringify(vals) })}`}
            onClick={(e) => { e.preventDefault(); void downloadXlsx(runId, vals); }}
            className="ui-focus self-start inline-flex items-center gap-2 h-9 px-3.5 rounded-ctl border border-border-strong text-ui text-text hover:bg-subtle" data-analyst-xlsx="">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 4v12M7 11l5 5 5-5M5 20h14" /></svg>
            Excel with live formulas
          </a>
        </div>
        {flips.length > 0 && (
          <div className="rounded-card border border-border bg-surface p-5 flex flex-col gap-2.5" data-analyst-flip="">
            <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">When would the choice change?</span>
            {flips.map((f) => (
              <p key={f.inp.key} className="m-0 text-ui text-secondary leading-relaxed">
                <b className="text-text font-semibold">{f.label}</b> stays {model.pick.goal === "min" ? "cheapest" : "best"} while {f.inp.label.toLowerCase()} is{" "}
                {f.atMin && f.atMax ? <>anywhere from {fmtInput(f.inp, f.inp.min)} to {fmtInput(f.inp, f.inp.max)}</> : f.atMin ? <>below {fmtInput(f.inp, f.to)}</> : f.atMax ? <>above {fmtInput(f.inp, f.from)}</> : <>between {fmtInput(f.inp, f.from)} and {fmtInput(f.inp, f.to)}</>}.
              </p>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

async function downloadXlsx(runId: string, vals: Record<string, number>) {
  const { api } = await import("../api/client");
  const r = await api.get(`/projects/runs/${runId}/analyst.xlsx`, { params: { inputs: JSON.stringify(vals) }, responseType: "blob" });
  const url = URL.createObjectURL(r.data as Blob);
  const el = document.createElement("a");
  el.href = url;
  el.download = "GD360 analysis.xlsx";
  document.body.appendChild(el);
  el.click();
  el.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function DataTable({ table, open: initial }: { table: Table; open: boolean }) {
  const [open, setOpen] = useState(initial);
  const [all, setAll] = useState(false);
  const rows = all ? table.rows : table.rows.slice(0, 12);
  return (
    <section className="rounded-card border border-border bg-surface overflow-hidden" data-analyst-table="">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="ui-focus w-full px-5 py-4 flex items-center justify-between gap-3 text-left hover:bg-subtle/30">
        <span className="flex flex-col"><span className="text-section font-semibold text-text">{table.title}</span>
          <span className="text-caption text-muted">{(table.rows_total ?? table.rows.length).toLocaleString()} rows · {table.columns.length} columns</span></span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`text-muted transition-transform ${open ? "rotate-180" : ""}`}><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {open && (
        <>
          <div className="overflow-x-auto border-t border-border">
            <table className="w-full text-ui border-collapse">
              <thead><tr className="text-left text-caption text-muted bg-base/40">{table.columns.map((c) => <th key={c.name} className={`font-normal px-4 py-2.5 whitespace-nowrap ${c.dtype === "number" ? "text-right" : ""}`}>{c.name}</th>)}</tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className="border-t border-border">
                    {table.columns.map((c) => <td key={c.name} className={`px-4 py-2 whitespace-nowrap ${c.dtype === "number" ? "text-right font-mono tabular-nums" : "text-text"}`}>{cell(r[c.name])}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {table.rows.length > 12 && (
            <button type="button" onClick={() => setAll((x) => !x)} className="ui-focus w-full px-5 py-3 border-t border-border text-caption text-kind-answer hover:bg-subtle/30 text-left">
              {all ? "Show fewer rows" : `Show all ${table.rows.length.toLocaleString()} rows`}
            </button>
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
              <span className="text-ui text-text">{d.name} <span className="text-muted">· {d.rows.toLocaleString()} rows</span></span>
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
