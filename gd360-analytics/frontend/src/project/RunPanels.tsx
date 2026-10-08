// 2026-10-08 (round 11): the four tabs of a project question - Plan,
// Sources (each query, live), Results (the answer drawn) and Evidence (every
// result table with the exact query that produced it).
import { useEffect, useState } from "react";
import type { DashKpi, EvidenceTable, ProjectRun, RunStep } from "../api/projects";
import { KpiRow, VisualCard } from "./Visuals";
import { autoRunPreference, bytes, ms, MODE_LABEL, setAutoRunPreference } from "./format";

const MODE_CLASS: Record<string, string> = {
  live: "bg-tint text-brand-ink",
  synced: "bg-[rgb(var(--color-series-1)/0.14)] text-[rgb(var(--color-series-1))]",
  file: "bg-subtle text-secondary",
  combine: "bg-[rgb(var(--color-series-4)/0.14)] text-[rgb(var(--color-series-4))]",
};

export function ModeBadge({ mode }: { mode?: string | null }) {
  if (!mode) return null;
  return <span className={`font-mono text-[10px] px-1.5 py-0.5 rounded ${MODE_CLASS[mode] || "bg-subtle text-muted"}`}>{MODE_LABEL[mode] || mode}</span>;
}

export function StatusPill({ status }: { status: RunStep["status"] }) {
  const map: Record<string, [string, string]> = {
    pending: ["QUEUED", "bg-subtle text-muted"],
    running: ["● RUNNING", "bg-[rgb(var(--color-series-1)/0.14)] text-[rgb(var(--color-series-1))]"],
    done: ["✓ DONE", "bg-good-fill text-good"],
    failed: ["FAILED", "bg-danger-fill text-danger"],
    skipped: ["SKIPPED", "bg-subtle text-muted"],
  };
  const [label, cls] = map[status] || [status, "bg-subtle text-muted"];
  return <span className={`font-mono text-[11px] px-2 py-1 rounded-full whitespace-nowrap ${cls}`}>{label}</span>;
}

// Readable layout for a one-line query: each main clause on its own line.
// Display only - Copy always copies the exact query that ran.
export function layoutSql(sql: string): string {
  const t = sql.trim();
  if (t.includes("\n")) return t;
  const KEYS = ["GROUP BY", "ORDER BY", "LEFT JOIN", "RIGHT JOIN", "INNER JOIN", "FULL JOIN", "UNION ALL", "FROM", "WHERE", "HAVING", "LIMIT", "JOIN", "UNION"];
  let out = "";
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && ch === " ") {
      const rest = t.slice(i + 1).toUpperCase();
      const key = KEYS.find((k) => rest.startsWith(k + " "));
      if (key) {
        out += "\n";
        continue;
      }
    }
    out += ch;
  }
  return out;
}

function SqlBlock({ sql, open: initial = false, preview = false }: { sql: string; open?: boolean; preview?: boolean }) {
  const [open, setOpen] = useState(initial);
  const [copied, setCopied] = useState(false);
  const shown = layoutSql(sql);
  const lines = shown.split("\n");
  const short = preview && !open && lines.length > 4;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(sql);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };
  if (preview) {
    return (
      <div className="rounded-ctl border border-border bg-base group">
        <pre className="m-0 px-3 pt-2.5 pb-2 font-mono text-[11.5px] leading-[1.7] text-secondary whitespace-pre-wrap break-words max-h-64 overflow-auto">
          {short ? lines.slice(0, 4).join("\n") + " …" : shown}
        </pre>
        <div className="flex gap-3 px-3 pb-2">
          {lines.length > 4 && (
            <button type="button" onClick={() => setOpen((v) => !v)} className="text-caption text-muted hover:text-text">
              {open ? "Show less" : "Show the whole query"}
            </button>
          )}
          <button type="button" className="text-caption text-muted hover:text-text" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
        </div>
      </div>
    );
  }
  return (
    <div className="rounded-ctl border border-border bg-base">
      <div className="flex items-center justify-between px-3 py-1.5">
        <button type="button" onClick={() => setOpen((v) => !v)} className="text-caption text-muted hover:text-text">
          {open ? "Hide query" : "Show query"}
        </button>
        {open && (
          <button type="button" className="text-caption text-muted hover:text-text" onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </button>
        )}
      </div>
      {open && (
        <pre className="m-0 px-3 pb-3 font-mono text-[11.5px] leading-relaxed text-secondary whitespace-pre-wrap break-words max-h-64 overflow-auto">{shown}</pre>
      )}
    </div>
  );
}

function SourceChip({ name, mode }: { name: string; mode?: string | null }) {
  const dot = mode === "live" ? "bg-good" : mode === "synced" ? "bg-[rgb(var(--color-series-1))]" : mode === "combine" ? "bg-warning" : "bg-border-strong";
  return (
    <span className="inline-flex items-center gap-1.5 h-[26px] px-2 rounded-md bg-subtle text-caption text-text">
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} aria-hidden="true" />
      {name}
    </span>
  );
}

// ---- Plan -------------------------------------------------------------------

export function PlanTab({
  run, canEdit, onRun, onReplan, busy, seed,
}: {
  run: ProjectRun; canEdit: boolean; onRun: () => void; onReplan: (note: string) => void; busy: boolean;
  seed?: { text: string; n: number } | null;
}) {
  const plan = run.plan;
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState("");
  const [autoRun, setAutoRun] = useState(autoRunPreference);
  useEffect(() => {
    if (seed) {
      setEditing(true);
      setNote(seed.text);
    }
  }, [seed]);
  if (!plan || !Array.isArray(plan.steps)) {
    return <Empty text={run.status === "planning" ? "Reading your sources and writing a plan…" : "No plan for this question."} spinner={run.status === "planning"} />;
  }
  const steps = run.steps || [];
  const combine = plan.combine || [];
  const sourceCount = new Set(plan.steps.map((s) => s.source_id)).size;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div className="flex flex-col gap-1.5">
          <h2 className="m-0 text-title font-semibold tracking-tight text-text">
            Plan · {plan.steps.length} step{plan.steps.length === 1 ? "" : "s"} across {sourceCount} source{sourceCount === 1 ? "" : "s"}
          </h2>
          <span className="font-mono text-caption text-muted">
            ≈ {plan.steps.length + combine.length} queries · read-only · your access rules apply
          </span>
        </div>
        {canEdit && run.status === "planned" && (
          <div className="flex gap-2">
            <button type="button" className="btn-secondary text-sm" onClick={() => setEditing((v) => !v)} disabled={busy}>Edit plan</button>
            <button type="button" className="btn-primary text-sm" onClick={onRun} disabled={busy}>Run plan →</button>
          </div>
        )}
      </div>
      {editing && (
        <form
          className="flex flex-col gap-2 rounded-card border border-tint-border bg-surface p-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (note.trim().length > 1) {
              onReplan(note.trim());
              setEditing(false);
              setNote("");
            }
          }}
        >
          <label htmlFor="replan-note" className="text-ui text-text">What should change?</label>
          <input
            id="replan-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder='e.g. "Compare with the same week last year" or "Leave out refunded orders"'
            autoFocus
            className="h-10 rounded-ctl border border-border bg-base px-3 text-ui text-text"
          />
          <div className="flex gap-2">
            <button type="submit" className="btn-primary text-sm" disabled={note.trim().length < 2}>Update the plan</button>
            <button type="button" className="btn-secondary text-sm" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </form>
      )}
      {plan.understanding && Object.values(plan.understanding).some(Boolean) && (
        <div className="grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
          {(["metric", "window", "method", "scope"] as const).map((k) =>
            plan.understanding[k] ? (
              <div key={k} className="rounded-card border border-border bg-surface px-3.5 py-3">
                <div className="text-caption uppercase tracking-caps text-muted">{k}</div>
                <div className="text-ui text-text mt-1 leading-snug">{plan.understanding[k]}</div>
              </div>
            ) : null
          )}
        </div>
      )}
      <ol className="m-0 p-0 list-none rounded-card border border-border overflow-hidden">
        {[...plan.steps.map((s) => ({ ...s, kind: "step" as const })), ...combine.map((c) => ({ ...c, kind: "combine" as const }))].map((s, i) => {
          const live = steps.find((x) => x.id === s.id);
          return (
            <li key={s.id} className="grid grid-cols-[40px_1fr] gap-3.5 px-4 py-4 border-t first:border-t-0 border-border bg-surface">
              <span className="w-8 h-8 rounded-[9px] border border-tint-border bg-tint/40 text-brand-ink grid place-items-center font-mono text-caption">
                {String(i + 1).padStart(2, "0")}
              </span>
              <div className="flex flex-col gap-2 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-body font-semibold text-text">{s.title}</span>
                  {live && live.status !== "pending" && <StatusPill status={live.status} />}
                </div>
                {s.purpose && <span className="text-ui text-muted leading-relaxed">{s.purpose}</span>}
                <div className="flex gap-1.5 flex-wrap items-center">
                  {s.kind === "step" ? (
                    <SourceChip name={(s as any).source_name} mode={(s as any).mode} />
                  ) : (
                    <SourceChip name="Joins earlier results" mode="combine" />
                  )}
                </div>
                <SqlBlock sql={live?.sql || s.sql} />
              </div>
            </li>
          );
        })}
      </ol>
      {canEdit && (
        <label className="flex items-center gap-2.5 text-ui text-secondary cursor-pointer select-none">
          <input
            type="checkbox"
            className="w-4 h-4 accent-[rgb(var(--color-primary))]"
            checked={autoRun}
            onChange={(e) => {
              setAutoRun(e.target.checked);
              setAutoRunPreference(e.target.checked);
            }}
          />
          Next time, run plans like this straight away and show me the answer
        </label>
      )}
      {plan.issues && plan.issues.length > 0 && (
        <div className="rounded-card border border-warning-border bg-warning-fill p-3 text-ui text-warning">
          Some planned queries were left out because they did not fit your sources: {plan.issues.slice(0, 3).join(" ")}
        </div>
      )}
    </div>
  );
}

// ---- Sources ----------------------------------------------------------------

export function SourcesTab({ run }: { run: ProjectRun }) {
  const steps = run.steps || [];
  if (!steps.length) return <Empty text="Nothing has run yet." spinner={run.status === "planning"} />;
  const scanned = steps.reduce((a, s) => a + (s.bytes_scanned || 0), 0);
  const returned = steps.filter((s) => s.kind === "step").reduce((a, s) => a + (s.rows_returned || 0), 0);
  const running = steps.some((s) => s.status === "running");
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h2 className="m-0 text-title font-semibold tracking-tight text-text">
          {running ? `Asking ${new Set(steps.filter((s) => s.kind === "step").map((s) => s.source_id)).size} sources at once` : "What each source answered"}
        </h2>
        <span className="font-mono text-caption text-muted">
          {returned.toLocaleString()} rows returned{scanned ? ` · ${bytes(scanned)} scanned` : ""}
        </span>
      </div>
      <div className="grid gap-3.5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))" }}>
        {steps.map((s) => (
          <div key={s.id} className={`rounded-card border bg-surface p-4 flex flex-col gap-3 min-w-0 ${s.status === "running" ? "border-[rgb(var(--color-series-1)/0.5)]" : s.status === "failed" ? "border-danger-border" : "border-border"}`}>
            <div className="flex justify-between items-start gap-2">
              <span className="flex flex-col gap-1 min-w-0">
                <span className="text-section font-semibold text-text truncate">{s.kind === "combine" ? "Combined" : s.source_name}</span>
                <span className="font-mono text-[10.5px] text-muted uppercase tracking-[0.06em]">
                  {sourceLine(s)}
                </span>
              </span>
              <StatusPill status={s.status} />
            </div>
            <span className="text-body text-secondary leading-snug">{s.purpose || s.title}</span>
            <SqlBlock sql={s.sql} preview />
            {s.error && <span className="text-ui text-danger leading-snug">{s.error}</span>}
            {s.note && <span className="text-caption text-warning">{s.note}</span>}
            <div className="flex justify-between gap-2 font-mono text-caption text-muted flex-wrap">
              <span>
                {s.bytes_scanned ? `${bytes(s.bytes_scanned)} scanned → ` : s.rows_read ? `${s.rows_read.toLocaleString()} rows read → ` : ""}
                {s.rows_returned != null ? `${s.rows_returned.toLocaleString()} rows` : s.status === "pending" ? "—" : s.status === "running" ? "running" : "—"}
                {s.truncated ? " · first 5,000" : ""}
              </span>
              <span>{s.repaired ? "fixed once · " : ""}{s.status === "pending" ? "queued" : ms(s.duration_ms)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function sourceLine(s: RunStep): string {
  if (s.kind === "combine") return "In memory · joins the results";
  if (s.mode === "live") return `Live · ${(s.source_kind || s.dialect || "database").replace(/_/g, " ")}`;
  if (s.mode === "synced") return s.freshness || "Synced";
  return `${MODE_LABEL[s.mode || ""] || "File"}${s.freshness ? ` · ${s.freshness}` : ""}`;
}

// ---- Results ----------------------------------------------------------------

export function ResultsTab({ run }: { run: ProjectRun }) {
  const res = run.result;
  if (!res || run.status !== "done") {
    if (run.status === "needs_input" && res?.answer) {
      return (
        <div className="rounded-card border border-warning-border bg-warning-fill p-5">
          <div className="text-section font-semibold text-text">{res.answer.headline}</div>
          <p className="text-ui text-secondary mt-2 mb-0">{res.answer.answer}</p>
        </div>
      );
    }
    return <Empty text={run.status === "running" || run.status === "planning" ? "The answer appears here when every source has replied." : "No results for this question."} spinner={run.status === "running"} />;
  }
  const ans = res.answer;
  const facts = new Map((res.facts || []).map((f) => [f.id, f]));
  const kpis = ((res as any).kpis || []) as DashKpi[];
  const visuals = res.visuals || [];
  const lead = visuals.filter((v) => v.type === "waterfall");
  const rest = visuals.filter((v) => v.type !== "waterfall");
  const overall = (res.summary as any)?.direction as string | undefined;
  const changeWord = overall === "up" ? "rise" : overall === "down" ? "drop" : "change";
  let causeNo = 0;
  return (
    <div className="flex flex-col gap-5">
      {lead.map((v, i) => (
        <VisualCard key={`w${i}`} visual={v} id={`${run.id}:w${i}`} />
      ))}
      {!lead.length && kpis.length > 0 && <KpiRow items={kpis} />}
      {ans.causes.length > 0 && (
        <div className="grid gap-3.5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))" }}>
          {ans.causes.map((c, i) => {
            const offset = overall && c.direction && c.direction !== overall;
            const label = offset ? "Offset" : `Cause ${++causeNo}`;
            const amount = c.amount || c.fact_ids.map((id) => facts.get(id)).find((f) => f && f.kind !== "percent")?.display;
            const tone = c.direction === "down" ? "text-danger" : c.direction === "up" ? "text-good" : "text-text";
            return (
              <article key={i} className="rounded-card border border-border bg-surface p-5 flex flex-col gap-3 min-w-0">
                <div className="flex justify-between items-center gap-2">
                  <span className={`font-mono text-caption uppercase tracking-[0.06em] ${offset ? "text-good" : "text-danger"}`}>{label}</span>
                  <span
                    className={`font-mono text-[10.5px] px-1.5 py-0.5 rounded uppercase ${
                      c.confidence === "high" ? "bg-good-fill text-good" : c.confidence === "medium" ? "bg-warning-fill text-warning" : "bg-subtle text-muted"
                    }`}
                  >
                    {c.confidence} confidence
                  </span>
                </div>
                <h3 className="m-0 text-section font-semibold text-text leading-snug">{c.title}</h3>
                {amount && (
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className={`font-mono text-[26px] leading-none tracking-tight ${tone}`}>{amount}</span>
                    {c.share && <span className="text-ui text-muted">{offset ? `made up ${c.share}` : `${c.share} of the ${changeWord}`}</span>}
                  </div>
                )}
                {c.detail && <p className="m-0 text-ui text-secondary leading-relaxed">{c.detail}</p>}
                {(c.sources || []).length > 0 && (
                  <div className="flex gap-1.5 flex-wrap mt-auto pt-1">
                    {c.sources!.map((n) => (
                      <span key={n} className="inline-flex items-center h-[22px] px-2 rounded-md bg-subtle text-caption text-secondary">{n}</span>
                    ))}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
      {ans.ruled_out.length > 0 && (
        <section className="rounded-card border border-border bg-surface p-5 flex flex-col gap-3.5">
          <h3 className="m-0 text-section font-semibold text-text">Checked and ruled out</h3>
          <div className="grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 230px), 1fr))" }}>
            {ans.ruled_out.map((r, i) => (
              <div key={i} className="flex gap-2.5 items-start px-3.5 py-3 rounded-ctl bg-base">
                <span className="mt-0.5 shrink-0 w-4 h-4 rounded-full border border-border-strong grid place-items-center text-[10px] text-muted" aria-hidden="true">–</span>
                <span className="flex flex-col gap-0.5 min-w-0">
                  <span className="text-ui font-semibold text-text">{r.title}</span>
                  <span className="text-caption text-muted leading-snug">{r.detail}</span>
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
      {lead.length > 0 && kpis.length > 0 && <KpiRow items={kpis} />}
      {rest.map((v, i) => (
        <VisualCard key={`v${i}`} visual={v} id={`${run.id}:${i}`} />
      ))}
      {(res.warnings || []).length > 0 && (
        <div className="rounded-card border border-warning-border bg-warning-fill p-3.5 text-ui text-warning flex flex-col gap-1">
          {res.warnings!.map((w, i) => <span key={i}>{w}</span>)}
        </div>
      )}
      <p className="m-0 text-caption text-muted">
        {ans.written_by === "template"
          ? "Written from the computed numbers (the AI writer was unavailable or used a number it was not given)."
          : "Every number above was computed from your data; the text was checked against those numbers before it was shown."}
      </p>
    </div>
  );
}

// ---- Evidence ---------------------------------------------------------------

function toCsv(t: EvidenceTable): string {
  const cols = t.columns.map((c) => c.name);
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...t.rows.map((r) => cols.map((c) => esc((r as any)[c])).join(","))].join("\n");
}

export function EvidenceTab({ run }: { run: ProjectRun }) {
  const ev = run.result?.evidence || [];
  const steps = run.steps || [];
  if (!ev.length) return <Empty text="Evidence appears when the queries have run." />;
  return (
    <div className="flex flex-col gap-5">
      <p className="m-0 text-ui text-muted">
        Every table the answer was computed from, with the exact query that produced it and where it ran.
      </p>
      {ev.map((t) => {
        const step = steps.find((s) => s.id === t.id);
        return (
          <section key={t.id} className="rounded-card border border-border bg-surface overflow-hidden">
            <div className="flex justify-between items-center gap-3 px-4 py-3 flex-wrap">
              <span className="flex flex-col gap-0.5">
                <span className="text-body font-semibold text-text">{t.title}</span>
                <span className="text-caption text-muted">
                  {t.source} · {t.rows.length.toLocaleString()} row{t.rows.length === 1 ? "" : "s"}{t.truncated ? " (first 200 shown)" : ""}
                </span>
              </span>
              <span className="flex items-center gap-2">
                <ModeBadge mode={step?.mode} />
                <button
                  type="button"
                  className="btn-secondary text-xs"
                  onClick={() => {
                    const blob = new Blob([toCsv(t)], { type: "text/csv" });
                    const a = document.createElement("a");
                    a.href = URL.createObjectURL(blob);
                    a.download = `${t.title.replace(/[^\w]+/g, "_").toLowerCase()}.csv`;
                    a.click();
                    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
                  }}
                >
                  Download CSV
                </button>
              </span>
            </div>
            {step && <div className="px-4 pb-3"><SqlBlock sql={step.sql} /></div>}
            <div className="overflow-auto max-h-80 border-t border-border">
              <table className="w-full text-ui border-collapse">
                <thead className="sticky top-0 bg-surface2">
                  <tr>
                    {t.columns.map((c) => (
                      <th key={c.name} className={`px-3 py-2 font-medium text-muted whitespace-nowrap ${c.dtype === "number" ? "text-right" : "text-left"}`}>{c.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {t.rows.slice(0, 50).map((r, i) => (
                    <tr key={i} className="border-t border-border">
                      {t.columns.map((c) => {
                        const v = (r as any)[c.name];
                        return (
                          <td key={c.name} className={`px-3 py-1.5 whitespace-nowrap ${c.dtype === "number" ? "text-right font-mono" : "text-secondary"}`}>
                            {v == null ? "—" : typeof v === "number" ? v.toLocaleString(undefined, { maximumFractionDigits: 4 }) : String(v)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </div>
  );
}

export function Empty({ text, spinner = false }: { text: string; spinner?: boolean }) {
  return (
    <div className="rounded-card border border-dashed border-border p-10 text-center text-ui text-muted flex flex-col items-center gap-3">
      {spinner && <span className="w-5 h-5 rounded-full border-2 border-border border-t-[rgb(var(--color-accent))] animate-spin" />}
      {text}
    </div>
  );
}
