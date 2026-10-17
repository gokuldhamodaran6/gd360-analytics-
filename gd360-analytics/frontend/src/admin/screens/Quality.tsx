// 2026-10-17 (R52): Mission Control · Quality - the nightly check on the live model (the 12-question set plus four on
// hotel and barista data), each answer checked and timed against its budget, and how fast real answers are.
import { useEffect, useState } from "react";
import { errText, mcGet, mcPost, mcPut, useMC } from "../api";
import { ago, Card, dateTime, Empty, ErrorBox, fmtN, Kpi, Loading, PageHead, Pill, useCan, useToast } from "../ui";

type Check = { label: string; ok: boolean };
type Result = {
  n: string; dataset: string; question: string; expected: string; kind?: string; status?: string; seconds?: number; budget?: number | null;
  over?: boolean; checks: Check[]; text?: string; chips?: string[]; sources?: string[]; passed: boolean; error?: string;
};
type Run = {
  id: string; trigger: string; status: string; provider?: string; model?: string; started_at: string; finished_at?: string | null; error?: string | null;
  started_by?: string | null; summary: { total?: number; passed?: number; failed?: number; over_budget?: number; of?: number; cost_usd?: number | null };
  results?: Result[];
};
type Speed = { kind: string; target: number | null; n: number; p50: number | null; p95: number | null; over_pct: number | null };
type Data = { nightly_on: boolean; next_run_at: string | null; runs: Run[]; latest: Run | null; speed: Speed[]; budgets: Record<string, number> };

const DS: Record<string, string> = { cards: "Credit card", hotel: "Hotel", barista: "Barista" };
const KIND: Record<string, string> = {
  analysis: "Analysis", data: "Data answer", dashboard: "Dashboard", dashboard_edit: "Dashboard edit", document: "Document", document_edit: "Document edit",
  knowledge: "World answer", automation: "Alert", team: "Team", list: "List", whatif: "What-if", chat: "Chat", explain: "Explain", check: "Check", model: "Model", guided: "Step by step",
};
const secs = (s?: number | null) => (s == null ? "—" : s < 10 ? `${s.toFixed(1)} s` : `${Math.round(s)} s`);

function RunBar({ runs, pick, on }: { runs: Run[]; pick: string | null; on: (id: string) => void }) {
  const rows = [...runs].reverse();
  return (
    <div style={{ display: "flex", gap: 4, alignItems: "flex-end", height: 56, overflowX: "auto" }} role="list" aria-label="Recent runs, oldest first">
      {rows.map((r) => {
        const of = r.summary.of || r.summary.total || 1;
        const pct = ((r.summary.passed || 0) / of) * 100;
        const c = r.status === "running" ? "var(--blue)" : pct === 100 ? "var(--g)" : pct >= 80 ? "var(--amber)" : "var(--red)";
        return (
          <button key={r.id} type="button" role="listitem" onClick={() => on(r.id)} title={`${dateTime(r.started_at)} · ${r.summary.passed ?? 0} of ${of} passed`}
            style={{ width: 14, flex: "0 0 14px", height: Math.max(8, (pct / 100) * 52), background: c, borderRadius: 3, border: pick === r.id ? "2px solid var(--ink)" : 0, cursor: "pointer", padding: 0 }} />
        );
      })}
    </div>
  );
}

function ResultRow({ r }: { r: Result }) {
  const [open, setOpen] = useState(!r.passed);
  const bad = r.checks.filter((c) => !c.ok);
  return (
    <div className="mc-card" style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8, borderColor: r.passed ? undefined : "rgba(255,122,107,.35)" }} data-q-result={r.n}>
      <button type="button" onClick={() => setOpen((o) => !o)} style={{ all: "unset", cursor: "pointer", display: "grid", gridTemplateColumns: "34px minmax(0,1fr) auto", gap: 10, alignItems: "center" }} aria-expanded={open}>
        <span className="mc-mono" style={{ color: "var(--ink3)", fontSize: 12 }}>{r.n}</span>
        <span style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
          <span style={{ fontSize: 13.5, fontWeight: 600, overflowWrap: "anywhere" }}>{r.question}</span>
          <span style={{ fontSize: 12, color: "var(--ink3)" }}>{DS[r.dataset] || r.dataset} · expects {KIND[r.expected] || r.expected}{r.kind && r.kind !== r.expected ? ` · got ${KIND[r.kind] || r.kind}` : ""}</span>
        </span>
        <span style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
          <span className="mc-mono" style={{ fontSize: 12, color: r.over ? "var(--amber)" : "var(--ink2)" }}>{secs(r.seconds)}{r.budget ? ` / ${r.budget} s` : ""}</span>
          <Pill tone={r.passed ? "g" : "r"}>{r.passed ? "Pass" : `${bad.length} failed`}</Pill>
        </span>
      </button>
      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingLeft: 44 }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {r.checks.map((c) => <Pill key={c.label} tone={c.ok ? "g" : "r"}>{c.ok ? "✓" : "✕"} {c.label}</Pill>)}
          </div>
          {(r.text || r.error) && <p style={{ margin: 0, fontSize: 13, color: "var(--ink2)", lineHeight: 1.5 }}>{r.text || r.error}</p>}
          {!!r.chips?.length && <span style={{ fontSize: 12, color: "var(--ink3)" }}>Chips: {r.chips.join(" · ")}</span>}
          {!!r.sources?.length && <span style={{ fontSize: 12, color: "var(--ink3)" }}>Sources: {r.sources.join(", ")}</span>}
        </div>
      )}
    </div>
  );
}

export default function Quality() {
  const { data, error, loading, reload } = useMC<Data>("/quality");
  const can = useCan()("health.write");
  const toast = useToast();
  const [pick, setPick] = useState<string | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [busy, setBusy] = useState(false);

  const shown = run || data?.latest || null;
  const running = (data?.runs || []).some((r) => r.status === "running");
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => { reload(); if (pick) void mcGet<Run>(`/quality/runs/${pick}`).then(setRun).catch(() => undefined); }, 4000);
    return () => clearInterval(id);
  }, [running, pick, reload]);
  const choose = (id: string) => { setPick(id); void mcGet<Run>(`/quality/runs/${id}`).then(setRun).catch((e) => toast(errText(e))); };
  const start = async () => {
    setBusy(true);
    try { const r = await mcPost<{ id: string }>("/quality/run"); toast("Started. About ten minutes on the live model."); setPick(r.id); setRun(null); reload(); }
    catch (e) { toast(errText(e)); } finally { setBusy(false); }
  };
  const toggle = async () => {
    try { await mcPut("/quality/nightly", { on: !data?.nightly_on }); reload(); } catch (e) { toast(errText(e)); }
  };
  const s = shown?.summary || {};
  const of = s.of || s.total || 0;
  const results = shown?.results || [];

  return (
    <div className="mc-page" data-mc-quality="">
      <PageHead eyebrow="Platform · the live model" title="Quality"
        sub={data ? (data.nightly_on ? `The 12-question set plus 4 on hotel and barista data runs every night at 02:10 UTC on the live model${data.next_run_at ? ` · next ${dateTime(data.next_run_at)}` : ""}.` : "The nightly run is off. Run it by hand, or switch it back on.") : "The 12-question set on the live model, every night."}>
        <button type="button" className="mc-btn" onClick={reload}>Refresh</button>
        <button type="button" className="mc-btn" disabled={!can} onClick={toggle} data-q-toggle="">{data?.nightly_on ? "Switch nightly off" : "Switch nightly on"}</button>
        <button type="button" className="mc-btn p" disabled={!can || busy || running} onClick={start} data-q-run="">{running ? "Running…" : "Run now"}</button>
      </PageHead>

      {error && <ErrorBox text={error} retry={reload} />}
      {loading && !data && <Loading rows={4} />}
      {data && !data.runs.length && <Empty>No run yet. “Run now” asks all 16 questions of the live model; it takes about ten minutes and a few cents.</Empty>}
      {data && shown && (
        <>
          <section className="mc-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))" }} aria-label="This run">
            <Kpi label={shown.status === "running" ? "RUNNING" : "PASSED"} value={`${s.passed ?? 0} / ${of}`} tone={(s.passed ?? 0) < of && shown.status !== "running" ? "warn" : "good"}
              sub={`${shown.trigger === "nightly" ? "Nightly" : "By hand"} · ${ago(shown.started_at)}`} />
            <Kpi label="OVER BUDGET" value={fmtN(s.over_budget ?? 0)} tone={(s.over_budget ?? 0) > 0 ? "warn" : undefined} sub="answers slower than their target" />
            <Kpi label="MODEL" value={<span style={{ fontSize: 18 }}>{shown.model || "—"}</span>} sub={shown.provider || ""} />
            <Kpi label="AI COST" value={s.cost_usd == null ? "—" : `$${s.cost_usd.toFixed(s.cost_usd < 1 ? 3 : 2)}`} sub="for this run" />
          </section>
          <Card title="RUNS · OLDEST TO NEWEST" right={<span className="mc-tip">Click a bar to open that run.</span>}>
            <RunBar runs={data.runs} pick={pick || shown.id} on={choose} />
          </Card>
          {shown.error && <ErrorBox text={shown.error} />}
          <Card title={`ANSWERS · ${dateTime(shown.started_at)}`} right={<span className="mc-tip">Failures open first. The look is checked by the browser suites against the boards.</span>}>
            {results.length === 0 ? <Empty>Starting…</Empty> : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {[...results].sort((a, b) => Number(a.passed) - Number(b.passed) || a.n.localeCompare(b.n)).map((r) => <ResultRow key={r.n} r={r} />)}
              </div>
            )}
          </Card>
        </>
      )}
      {data && (
        <Card title="ANSWER SPEED · REAL PEOPLE · LAST 7 DAYS" right={<span className="mc-tip">The nightly account is left out. Targets: data 60 s, analysis 120 s, dashboard 20 s, document 40 s.</span>}>
          {data.speed.length === 0 ? <Empty>No answers in the last 7 days.</Empty> : (
            <div className="mc-tablewrap">
              <table className="mc-table" style={{ minWidth: 560 }}>
                <thead><tr><th>KIND</th><th style={{ textAlign: "right" }}>ANSWERS</th><th style={{ textAlign: "right" }}>MEDIAN</th><th style={{ textAlign: "right" }}>95TH</th><th style={{ textAlign: "right" }}>TARGET</th><th style={{ textAlign: "right" }}>OVER</th></tr></thead>
                <tbody>
                  {data.speed.map((r) => (
                    <tr key={r.kind}>
                      <td>{KIND[r.kind] || r.kind}</td>
                      <td className="mc-num" style={{ textAlign: "right" }}>{fmtN(r.n)}</td>
                      <td className="mc-num" style={{ textAlign: "right" }}>{secs(r.p50)}</td>
                      <td className="mc-num" style={{ textAlign: "right", color: r.target && (r.p95 || 0) > r.target ? "var(--amber)" : undefined }}>{secs(r.p95)}</td>
                      <td className="mc-num" style={{ textAlign: "right", color: "var(--ink3)" }}>{r.target ? `${r.target} s` : "—"}</td>
                      <td className="mc-num" style={{ textAlign: "right", color: (r.over_pct || 0) > 5 ? "var(--amber)" : undefined }}>{r.over_pct == null ? "—" : `${r.over_pct}%`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
