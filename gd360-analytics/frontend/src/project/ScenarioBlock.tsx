// 2026-10-13 (R45): the live what-if, as one self-contained block. The
// Analyst answer page (project/AnalystAnswer.tsx) and a dashboard block of
// type "scenario" (dashboard/**) both draw it from here, so there is ONE
// implementation of the safe formula evaluator, the option ranking, the
// break-even search and the way every number in it is written.
//
//   <ScenarioBlock model={analyst.model} />                   own sliders
//   <ScenarioBlock model={m} values={params} />               read-only, driven by dashboard parameters
//   <ScenarioBlock model={m} values={v} onValues={setV} />    controlled, sliders write back
//
// Every number is rounded half-up and grouped by lib/numberFormat.ts.
import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fmtNumber } from "../lib/numberFormat";

// ---- the model ----------------------------------------------------------------------------------------------
export type ScenarioInput = { key: string; label: string; value: number; min: number; max: number; step: number; unit: string };
export type ScenarioRow = { label: string; values: Record<string, number>; computed: Record<string, number> };
export type ScenarioOutput = { key: string; label: string; expr: string; format: string };
export type ScenarioModel = { inputs: ScenarioInput[]; rows: ScenarioRow[]; outputs: ScenarioOutput[]; pick: { output: string; goal: "min" | "max" } };
export type BreakEven = { inp: ScenarioInput; label: string; from: number; to: number; atMin: boolean; atMax: boolean };

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A model from the backend (or a saved dashboard block) made safe to draw - null when it can't be. */
export function normalizeModel(raw: any): ScenarioModel | null {
  if (!raw || typeof raw !== "object") return null;
  const outputs: ScenarioOutput[] = (Array.isArray(raw.outputs) ? raw.outputs : [])
    .filter((o: any) => o && typeof o.key === "string" && typeof o.expr === "string")
    .map((o: any) => ({ key: o.key, label: String(o.label || o.key), expr: o.expr, format: String(o.format || "") }));
  const rows: ScenarioRow[] = (Array.isArray(raw.rows) ? raw.rows : [])
    .filter((r: any) => r && r.label != null)
    .map((r: any) => ({
      label: String(r.label),
      values: Object.fromEntries(Object.entries(r.values || {}).filter(([, v]) => isNum(v))) as Record<string, number>,
      computed: {},
    }));
  if (!outputs.length || !rows.length) return null;
  const inputs: ScenarioInput[] = (Array.isArray(raw.inputs) ? raw.inputs : [])
    .filter((i: any) => i && typeof i.key === "string" && isNum(Number(i.value)))
    .map((i: any) => {
      const value = Number(i.value);
      const min = isNum(Number(i.min)) ? Number(i.min) : Math.min(0, value);
      const max = isNum(Number(i.max)) && Number(i.max) > min ? Number(i.max) : Math.max(min + 1, value * 2 || 1);
      const step = isNum(Number(i.step)) && Number(i.step) > 0 ? Number(i.step) : (max - min) / 100;
      return { key: i.key, label: String(i.label || i.key), value, min, max, step, unit: String(i.unit || "") };
    });
  const pickOut = outputs.some((o) => o.key === raw.pick?.output) ? raw.pick.output : outputs[outputs.length - 1].key;
  return { inputs, rows, outputs, pick: { output: pickOut, goal: raw.pick?.goal === "max" ? "max" : "min" } };
}

// ---- a tiny, safe expression evaluator (the model's formulas) ----------------------------------------------
export function evaluate(expr: string, names: Record<string, number>): number {
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

export function computeRows(m: ScenarioModel, vals: Record<string, number>): ScenarioRow[] {
  return m.rows.map((r) => {
    const names: Record<string, number> = { ...vals, ...r.values };
    const out: Record<string, number> = {};
    for (const o of m.outputs) {
      try { out[o.key] = evaluate(o.expr, { ...names, ...out }); } catch { out[o.key] = NaN; }
    }
    return { ...r, computed: out };
  });
}

export function bestIndex(m: ScenarioModel, rows: ScenarioRow[]): number {
  let best = -1;
  rows.forEach((r, i) => {
    const v = r.computed[m.pick.output];
    if (!Number.isFinite(v)) return;
    if (best < 0 || (m.pick.goal === "min" ? v < rows[best].computed[m.pick.output] - 1e-9 : v > rows[best].computed[m.pick.output] + 1e-9)) best = i;
  });
  return best;
}

/** For the first three inputs: the range (others held) where today's best option stays best. */
export function breakEvens(model: ScenarioModel, vals: Record<string, number>): BreakEven[] {
  const rows = computeRows(model, vals);
  const best = bestIndex(model, rows);
  if (best < 0) return [];
  const label = rows[best].label;
  return model.inputs.slice(0, 3).map((inp) => {
    const steps = 240;
    const lo = inp.min, hi = inp.max;
    const cur = vals[inp.key] ?? inp.value;
    const bestAt = (x: number) => { const rr = computeRows(model, { ...vals, [inp.key]: x }); const b = bestIndex(model, rr); return b >= 0 ? rr[b].label : ""; };
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
    const from = l > 0 ? edge(xs[l], xs[l - 1]) : xs[l];
    const to = r < steps ? edge(xs[r], xs[r + 1]) : xs[r];
    return { inp, label, from, to, atMin: from <= lo + 1e-9, atMax: to >= hi - 1e-9 };
  }).filter((f): f is BreakEven => Boolean(f) && !(f!.atMin && f!.atMax));
}

// ---- formatting (every number through lib/numberFormat) ----------------------------------------------------
/** Half-up rounded, grouped, at most `maxD` decimals and at least `minD` (trailing zeros trimmed between). */
export function num(v: number, maxD = 0, minD = 0): string {
  if (!Number.isFinite(v)) return "–";
  const s = fmtNumber(v, maxD);
  if (maxD <= minD || !s.includes(".")) return s;
  const [whole, frac0] = s.split(".");
  let frac = frac0;
  while (frac.length > minD && frac.endsWith("0")) frac = frac.slice(0, -1);
  return frac.length ? `${whole}.${frac}` : whole;
}

export function fmtOut(v: number, format: string, sym: string): string {
  if (!Number.isFinite(v)) return "–";
  const a = Math.abs(v);
  const sign = v < 0 ? "−" : "";
  if (format === "money") return `${sign}${sym}${a >= 10 ? num(a, 0) : num(a, 2, 2)}`;
  if (format === "percent") return `${num(v, 1)}%`;
  if (format === "minutes") return `${num(v, a < 10 ? 1 : 0)} min`;
  if (format === "hours") return `${num(v, 1)} h`;
  if (format === "integer") return num(v, 0);
  return a >= 100 ? num(v, 0) : num(v, 2);
}

export function fmtInput(i: ScenarioInput, v: number): string {
  if (!Number.isFinite(v)) return "–";
  const d = i.step < 0.01 ? 3 : i.step < 1 ? 2 : 0;
  if (/^[$€£₹¥]$/.test(i.unit)) return `${v < 0 ? "−" : ""}${i.unit}${num(Math.abs(v), d, d > 0 && Math.abs(v) < 100 ? Math.min(d, 2) : 0)}`;
  if (i.unit === "%" || (i.max <= 1 && /rate|share|pct|percent/i.test(i.key + i.label))) return `${num(i.max <= 1 ? v * 100 : v, 1)}%`;
  return `${num(v, d)}${i.unit ? ` ${i.unit}` : ""}`;
}

/** A plain table cell: grouped, half-up, a sensible number of decimals. */
export function cell(v: any): string {
  if (v === null || v === undefined) return "–";
  if (typeof v === "number") return Math.abs(v) >= 1000 || Number.isInteger(v) ? num(v, 0) : num(v, Math.abs(v) < 1 ? 3 : 2);
  return String(v);
}

// "2 Baristas (Add 1)" reads two ways; name the level only. "(Baseline)" -> "(today)".
export const cleanLabel = (s: string) => s.replace(/\s*\((?:add|plus|\+)\s*\d+[^)]*\)/gi, "").replace(/\((?:baseline|current)\)/gi, "(today)").trim();
export const leadNum = (s: string) => { const m = String(s).trim().match(/^(-?\d+(?:\.\d+)?)/); return m ? Number(m[1]) : NaN; };
const pretty = (k: string) => k.replace(/_/g, " ").replace(/\bmin\b/, "(min)").replace(/^\w/, (c) => c.toUpperCase());
const shortLabel = (label: string) => label.replace(/\s*\([^)]*\)\s*$/, "");
const perUnit = (label: string) => { const m = label.match(/\(\s*[$€£₹¥%]?\s*\/\s*([a-z]+)\s*\)\s*$/i); return m ? `/${m[1].toLowerCase()}` : ""; };
export const symbolOf = (m: ScenarioModel) => m.inputs.find((i) => /^[$€£₹¥]$/.test(i.unit))?.unit || "$";
const moved = (i: ScenarioInput, vals: Record<string, number>) => Math.abs((vals[i.key] ?? i.value) - i.value) > 1e-12;

// ---- state --------------------------------------------------------------------------------------------------
export type SetVals = (f: (v: Record<string, number>) => Record<string, number>) => void;

/** The assumption values a scenario is drawn with: its own (sliders), or the ones passed in. */
export function useScenarioValues(model: ScenarioModel | null, values?: Record<string, number>, onValues?: (v: Record<string, number>) => void) {
  const init = useMemo(() => Object.fromEntries((model?.inputs || []).map((i) => [i.key, i.value])) as Record<string, number>, [model]);
  const [own, setOwn] = useState<Record<string, number>>(init);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    setOwn(init); // a different model starts from its own values
  }, [init]);
  const external = values !== undefined && values !== null;
  const vals = useMemo<Record<string, number>>(() => {
    if (!external) return own;
    const out = { ...init };
    for (const [k, v] of Object.entries(values || {})) if (isNum(v)) out[k] = v;
    return out;
  }, [external, init, values, own]);
  const setVals = useCallback<SetVals>((f) => {
    const next = f(vals);
    if (!external) setOwn(next);
    onValues?.(next);
  }, [vals, external, onValues]);
  return { init, vals, setVals, external, editable: !external || Boolean(onValues) };
}

// ---- the pieces ---------------------------------------------------------------------------------------------
/** The assumptions as one row of small chips; a chip opens its own slider (or just shows its value when read-only). */
export function ScenarioAssumptions({ model, vals, setVals, init, notes = [], editable = true, bordered = true }: {
  model: ScenarioModel | null; vals: Record<string, number>; setVals: SetVals; init: Record<string, number>; notes?: string[]; editable?: boolean; bordered?: boolean;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent) {
        if (e.key === "Escape") {
          const chip = box.current?.querySelector<HTMLButtonElement>(`[data-assume-chip="${open}"]`);
          setOpen(null);
          chip?.focus();
        }
        return;
      }
      if (box.current && !box.current.contains(e.target as Node)) setOpen(null);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", close); };
  }, [open]);
  const inputs = model?.inputs || [];
  if (!inputs.length && !notes.length) return null;
  const changed = inputs.some((i) => moved(i, vals));
  return (
    <div ref={box} className={`relative flex flex-col gap-2.5 ${bordered ? "pt-4 border-t border-border" : ""}`} data-analyst-assumptions="">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-caption text-muted mr-0.5">{inputs.length ? (editable ? "Assumed" : "Using") : "Assumptions"}</span>
        {inputs.map((i) => {
          const m = moved(i, vals);
          const body = (
            <>
              <span className="text-secondary">{shortLabel(i.label)}</span>
              <b className={`font-mono font-medium tabular-nums ${m ? "text-kind-answer" : ""}`}>{fmtInput(i, vals[i.key] ?? i.value)}{perUnit(i.label)}</b>
            </>
          );
          const cls = `inline-flex items-center gap-1.5 h-8 pl-3 pr-2.5 rounded-full border text-caption transition-colors max-w-full ${m ? "border-kind-answer-border bg-kind-answer-fill/50 text-text" : "border-border-strong bg-surface text-text"}`;
          if (!editable) return <span key={i.key} className={cls} data-assume-chip={i.key} title={i.label}>{body}</span>;
          return (
            <div key={i.key} className="relative max-w-full">
              <button type="button" aria-expanded={open === i.key} aria-haspopup="dialog" onClick={() => setOpen((o) => (o === i.key ? null : i.key))}
                className={`ui-focus ${cls} ${m ? "" : "hover:bg-subtle"}`} data-assume-chip={i.key}>
                {body}
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`text-muted transition-transform ${open === i.key ? "rotate-180" : ""}`}><path d="M6 9l6 6 6-6" /></svg>
              </button>
              {open === i.key && (
                <div role="dialog" aria-label={i.label} className="absolute left-0 top-[calc(100%+6px)] z-30 w-[300px] max-w-[calc(100vw-48px)] rounded-card border border-border bg-surface shadow-pop p-4 flex flex-col gap-2" data-assume-pop={i.key}>
                  <span className="flex items-baseline justify-between gap-2 text-ui"><span className="text-secondary">{i.label}</span><b className="font-mono font-medium text-text tabular-nums">{fmtInput(i, vals[i.key] ?? i.value)}</b></span>
                  <input type="range" min={i.min} max={i.max} step={i.step} value={vals[i.key] ?? i.value} autoFocus
                    onChange={(e) => { const x = Number(e.target.value); setVals((v) => ({ ...v, [i.key]: x })); }}
                    className="w-full accent-[rgb(var(--color-kind-answer))] h-6" aria-label={i.label} aria-valuetext={fmtInput(i, vals[i.key] ?? i.value)} data-model-input={i.key} />
                  <span className="flex justify-between text-caption text-muted font-mono tabular-nums"><span>{fmtInput(i, i.min)}</span><span>{fmtInput(i, i.max)}</span></span>
                  <span className="flex items-center justify-between gap-2 pt-1">
                    <span className="text-caption text-muted">Updates the answer instantly</span>
                    {m && <button type="button" onClick={() => setVals((v) => ({ ...v, [i.key]: init[i.key] }))} className="ui-focus text-caption text-kind-answer hover:underline">Reset</button>}
                  </span>
                </div>
              )}
            </div>
          );
        })}
        {editable && changed && <button type="button" onClick={() => setVals(() => init)} className="ui-focus h-8 px-2 text-caption text-kind-answer hover:underline" data-assume-reset="">Reset all</button>}
        {inputs.length > 0 && notes.length > 0 && (
          <button type="button" onClick={() => setMore((x) => !x)} aria-expanded={more} className="ui-focus h-8 px-2 text-caption text-muted hover:text-text" data-assume-more="">
            {more ? "Hide details" : "Details"}
          </button>
        )}
      </div>
      {notes.length > 0 && (!inputs.length || more) && (
        <ul className="m-0 p-0 list-none flex flex-col gap-1 text-caption text-secondary leading-snug max-w-[900px]" data-assume-notes="">
          {notes.map((n, k) => <li key={k} className="flex gap-2"><span className="text-muted" aria-hidden="true">·</span>{n}</li>)}
        </ul>
      )}
    </div>
  );
}

/** "2 Baristas is the cheapest - $268 a day, $41 less than 3 Baristas." */
export function decisionText(model: ScenarioModel, rows: ScenarioRow[], best: number): { lead: string; rest: string } | null {
  if (best < 0) return null;
  const pick = model.outputs.find((o) => o.key === model.pick.output) || model.outputs[model.outputs.length - 1];
  const sym = symbolOf(model);
  const v = rows[best].computed[pick.key];
  const others = rows.map((r, i) => ({ r, i })).filter(({ r, i }) => i !== best && Number.isFinite(r.computed[pick.key]))
    .sort((a, b) => (model.pick.goal === "min" ? a.r.computed[pick.key] - b.r.computed[pick.key] : b.r.computed[pick.key] - a.r.computed[pick.key]));
  const second = others[0];
  const word = model.pick.goal === "min" ? "the cheapest" : "the best";
  let rest = ` is ${word} option — ${pick.label.toLowerCase()} ${fmtOut(v, pick.format, sym)}`;
  if (second) {
    const gap = Math.abs(v - second.r.computed[pick.key]);
    if (gap > 1e-9) rest += `, ${fmtOut(gap, pick.format, sym)} ${model.pick.goal === "min" ? "less" : "more"} than ${cleanLabel(second.r.label)}`;
  }
  return { lead: cleanLabel(rows[best].label), rest: `${rest}.` };
}

export function ScenarioDecision({ model, rows, best, note }: { model: ScenarioModel; rows: ScenarioRow[]; best: number; note?: string }) {
  const d = decisionText(model, rows, best);
  return (
    <p className="m-0 text-ui text-secondary leading-relaxed" data-scenario-decision="" aria-live="polite">
      {note && <span className="text-kind-answer font-medium">{note} </span>}
      {d ? <><b className="text-text font-semibold">{d.lead}</b>{d.rest}</> : "No option can be worked out with these assumptions."}
    </p>
  );
}

const COLORS = ["rgb(var(--color-series-2))", "rgb(var(--color-series-1))", "rgb(var(--color-series-3))", "rgb(var(--color-series-4))"];

/** The picked number per option - stacked by its parts ("waiting cost + labour") when it is their sum. */
export function ScenarioChart({ model, rows, best, decision, compact = false, title }: {
  model: ScenarioModel; rows: ScenarioRow[]; best: number; decision?: ReactNode; compact?: boolean; title?: string;
}) {
  const sym = symbolOf(model);
  const pick = model.outputs.find((o) => o.key === model.pick.output) || model.outputs[model.outputs.length - 1];
  const parts = useMemo(() => {
    const ids = pick.expr.split("+").map((x) => x.trim());
    return ids.length > 1 && ids.every((x) => model.outputs.some((o) => o.key === x)) ? ids : [];
  }, [pick, model]);
  const maxV = Math.max(1e-9, ...rows.map((r) => Math.abs(r.computed[pick.key] || 0)));
  return (
    <section className={`rounded-card border border-border bg-surface flex flex-col gap-3 min-w-0 ${compact ? "p-4" : "p-5"}`} data-analyst-chart="">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h3 className="m-0 text-section font-semibold text-text">{title || `${pick.label}${parts.length ? " — where it goes" : ""}`}</h3>
        {parts.length > 0 && (
          <span className="flex gap-3 text-caption text-secondary flex-wrap">
            {parts.map((p, i) => <span key={p} className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-[3px]" style={{ background: COLORS[i % 4] }} aria-hidden="true" />{model.outputs.find((o) => o.key === p)?.label}</span>)}
          </span>
        )}
      </div>
      {decision}
      <div className="flex flex-col gap-2.5">
        {rows.map((r, i) => (
          <div key={r.label} className="grid grid-cols-[minmax(0,110px)_minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,140px)_minmax(0,1fr)_88px] gap-3 items-center">
            <span className={`text-caption truncate ${i === best ? "text-text font-medium" : "text-muted"}`} title={cleanLabel(r.label)}>{cleanLabel(r.label)}</span>
            <span className="flex h-[22px] gap-[2px] min-w-0" role="img" aria-label={`${cleanLabel(r.label)}: ${fmtOut(r.computed[pick.key], pick.format, sym)}`}>
              {(parts.length ? parts : [pick.key]).map((p, j) => (
                <span key={p} className="block h-full rounded-[4px] transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${Math.max(0, (100 * (r.computed[p] || 0)) / maxV)}%`, background: parts.length ? COLORS[j % 4] : i === best ? "rgb(var(--color-kind-answer))" : "rgb(var(--color-series-1))" }} />
              ))}
            </span>
            <span className={`font-mono text-caption text-right tabular-nums whitespace-nowrap ${i === best ? "text-kind-answer font-semibold" : "text-secondary"}`}>{fmtOut(r.computed[pick.key], pick.format, sym)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Every option side by side, then where the choice would flip. */
export function ScenarioTable({ model, rows, best, vals, changed, actions, compact = false }: {
  model: ScenarioModel; rows: ScenarioRow[]; best: number; vals: Record<string, number>; changed: boolean; actions?: ReactNode; compact?: boolean;
}) {
  const sym = symbolOf(model);
  const pick = model.outputs.find((o) => o.key === model.pick.output) || model.outputs[model.outputs.length - 1];
  // a value that only repeats the option's own number ("2 Baristas" | baristas = 2) is not a column
  const valueKeys = compact ? [] : Object.keys(model.rows[0]?.values || {}).filter((k) => !/^(k|n|id)$/.test(k) && !model.rows.every((r) => leadNum(r.label) === r.values[k]));
  const outputs = compact ? model.outputs.filter((o) => o.key === pick.key || pick.expr.split("+").map((x) => x.trim()).includes(o.key)) : model.outputs;
  const flips = useMemo(() => breakEvens(model, vals), [model, vals]);
  const word = model.pick.goal === "min" ? "cheapest" : "best";
  return (
    <section className="rounded-card border border-border bg-surface flex flex-col min-w-0 overflow-hidden" data-analyst-model="">
      <div className={`${compact ? "px-4 pt-4" : "px-5 pt-5"} pb-3 flex items-center justify-between gap-3 flex-wrap`}>
        <span className="flex flex-col">
          <h3 className="m-0 text-section font-semibold text-text">Every option, side by side</h3>
          <span className="text-caption text-muted">{changed ? "With your changed assumptions" : "Change an assumption and this updates"}</span>
        </span>
        {actions}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-ui border-collapse">
          <thead>
            <tr className="text-left text-caption text-muted border-y border-border bg-base/40">
              <th scope="col" className={`font-normal ${compact ? "px-4" : "px-5"} py-2.5`}>Option</th>
              {valueKeys.map((k) => <th scope="col" key={k} className="font-normal px-3 text-right whitespace-nowrap">{pretty(k)}</th>)}
              {outputs.map((o) => <th scope="col" key={o.key} className={`font-normal px-3 last:pr-5 text-right whitespace-nowrap ${o.key === pick.key ? "text-text" : ""}`}>{o.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.label} className={`border-b border-border last:border-b-0 ${i === best ? "bg-kind-answer-fill/40" : ""}`} data-model-row={i === best ? "best" : ""}>
                <th scope="row" className={`${compact ? "px-4" : "px-5"} py-3 whitespace-nowrap text-left font-normal`}>
                  <span className="text-text font-medium">{cleanLabel(r.label)}</span>
                  {i === best && <span className="ml-2 inline-flex items-center h-5 px-1.5 rounded-md bg-kind-answer text-[rgb(var(--color-base))] text-[10.5px] font-semibold uppercase tracking-[0.04em]">{model.pick.goal === "min" ? "Cheapest" : "Best"}</span>}
                </th>
                {valueKeys.map((k) => <td key={k} className="px-3 text-right font-mono tabular-nums text-secondary">{cell(r.values[k])}</td>)}
                {outputs.map((o) => (
                  <td key={o.key} className={`px-3 last:pr-5 text-right font-mono tabular-nums whitespace-nowrap ${o.key === pick.key ? (i === best ? "text-kind-answer font-semibold" : "text-text font-semibold") : "text-secondary"}`}>
                    {fmtOut(r.computed[o.key], o.format, sym)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {flips.length > 0 && (
        <div className={`${compact ? "px-4" : "px-5"} py-4 border-t border-border flex flex-col gap-1.5`} data-analyst-flip="">
          <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">When would the choice change?</span>
          {flips.map((f) => (
            <p key={f.inp.key} className="m-0 text-ui text-secondary leading-relaxed">
              <b className="text-text font-semibold">{cleanLabel(f.label)}</b> stays {word} while {shortLabel(f.inp.label).toLowerCase()} is{" "}
              {f.atMin ? <>below {fmtInput(f.inp, f.to)}</> : f.atMax ? <>above {fmtInput(f.inp, f.from)}</> : <>between {fmtInput(f.inp, f.from)} and {fmtInput(f.inp, f.to)}</>}.
            </p>
          ))}
        </div>
      )}
    </section>
  );
}

// ---- the block ----------------------------------------------------------------------------------------------
export function ScenarioBlock({ model: raw, title, compact = false, values, onValues }: {
  model: any; title?: string; compact?: boolean; values?: Record<string, number>; onValues?: (v: Record<string, number>) => void;
}) {
  const model = useMemo(() => normalizeModel(raw), [raw]);
  const { init, vals, setVals, editable } = useScenarioValues(model, values, onValues);
  const rows = useMemo(() => (model ? computeRows(model, vals) : []), [model, vals]);
  const best = model ? bestIndex(model, rows) : -1;
  if (!model) {
    return (
      <div className="rounded-card border border-dashed border-border p-6 text-ui text-muted text-center" data-scenario-block="empty">
        This what-if has no options to compare yet.
      </div>
    );
  }
  const changed = model.inputs.some((i) => moved(i, vals));
  return (
    <div className={`flex flex-col min-w-0 ${compact ? "gap-3" : "gap-4"}`} data-scenario-block="">
      {title && <h3 className="m-0 text-section font-semibold text-text">{title}</h3>}
      <ScenarioChart
        model={model}
        rows={rows}
        best={best}
        compact={compact}
        decision={<ScenarioDecision model={model} rows={rows} best={best} note={changed && editable ? "With your changes:" : undefined} />}
      />
      {model.inputs.length > 0 && (
        <div className={`rounded-card border border-border bg-surface ${compact ? "px-4 py-3" : "px-5 py-4"}`}>
          <ScenarioAssumptions model={model} vals={vals} setVals={setVals} init={init} editable={editable} bordered={false} />
          {!editable && <span className="block mt-2 text-caption text-muted">Set by this dashboard's filters.</span>}
        </div>
      )}
      <ScenarioTable model={model} rows={rows} best={best} vals={vals} changed={changed} compact={compact} />
    </div>
  );
}

export default ScenarioBlock;
