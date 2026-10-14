// 2026-10-14 (R46): Step by step, inside the conversation. The Guided engine (routers/guided.py) runs one
// step at a time; this shows every step, its result preview, and lets the person run, approve, change or
// re-run from any step. The full editor (/g/:id) is one link away.
import { useState } from "react";
import { Link } from "react-router-dom";
import { guidedApi, type ProjectRun, type RunStep } from "../api/projects";
import { DataAnswer } from "./DataAnswer";

function Preview({ step }: { step: RunStep }) {
  const rows = (step.preview || []).slice(0, 5);
  const cols = (step.columns || []).slice(0, 6);
  if (!rows.length || !cols.length) return null;
  return (
    <div className="res">
      <table style={{ borderCollapse: "collapse", fontSize: 12.5 }}>
        <thead><tr>{cols.map((c) => <th key={c.name} style={{ textAlign: "left", fontWeight: 500, color: "rgb(var(--color-muted))", padding: "2px 14px 4px 0" }}>{c.label || c.name}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{cols.map((c) => <td key={c.name} className="c2-mono" style={{ padding: "3px 14px 3px 0", whiteSpace: "nowrap" }}>{String((r as any)[c.name] ?? "")}</td>)}</tr>)}</tbody>
      </table>
      <span style={{ fontSize: 12, color: "rgb(var(--color-muted))" }}>{step.rows_returned != null ? `${step.rows_returned.toLocaleString()} rows` : ""}{step.truncated ? " · capped" : ""}</span>
    </div>
  );
}

export function GuidedSteps({ run, projectId, onChanged, onAsk }: { run: ProjectRun; projectId: string; onChanged: (r: ProjectRun) => void; onAsk?: (q: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [revising, setRevising] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const steps = run.steps || [];
  const act = async (label: string, fn: () => Promise<ProjectRun>) => {
    setBusy(label); setErr(null);
    try { onChanged(await fn()); } catch (e: any) { setErr(e?.response?.data?.detail || e?.message || "That didn't work."); } finally { setBusy(null); }
  };
  const next = steps.find((s) => s.status === "pending" || s.status === "stale");
  const allDone = steps.length > 0 && steps.every((s) => s.status === "done" || s.status === "skipped");
  if (run.status === "planning") return <span className="c2-working"><span className="c2-spin" /> Planning the steps…</span>;
  return (
    <div className="c2-a" data-c2-guided="">
      {run.plan?.title && <p className="sub" style={{ color: "rgb(var(--color-text))", fontWeight: 500 }}>{run.plan.title}</p>}
      <div className="c2-steps">
        {steps.map((s, i) => {
          const cls = s.status === "done" ? "done" : s === next ? "now" : "";
          return (
            <div key={s.id} className="c2-step" data-c2-step={s.status}>
              <span className={`n ${cls}`}>{s.status === "done" ? "✓" : i + 1}</span>
              <div>
                <h4>{s.title}</h4>
                {s.purpose && <p>{s.purpose}</p>}
                {s.source_name && <p style={{ fontSize: 12.5, color: "rgb(var(--color-muted))" }}>{s.source_name}{s.reused ? " · reused from an earlier answer" : ""}{s.repaired ? " · query repaired" : ""}</p>}
                {s.status === "running" && <span className="c2-working" style={{ marginTop: 6 }}><span className="c2-spin" /> working</span>}
                {s.status === "failed" && s.error && <p style={{ color: "rgb(var(--color-danger))" }}>{s.error}</p>}
                {s.status === "done" && <Preview step={s} />}
                {revising === s.id ? (
                  <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                    <input value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="What should change? e.g. exclude refunds, use contribution margin"
                      style={{ flex: "1 1 240px", height: 34, borderRadius: 999, border: "1px solid rgb(var(--color-border))", padding: "0 12px", font: "inherit", fontSize: 13.5, background: "rgb(var(--color-surface))", color: "rgb(var(--color-text))" }} />
                    <button type="button" className="c2-nx sm dark" disabled={!instruction.trim() || !!busy} onClick={() => { const t = instruction; setInstruction(""); setRevising(null); void act("revise", () => guidedApi.revise(run.id, s.id, t)); }}>Change and re-run from here</button>
                    <button type="button" className="c2-nx sm ghost" onClick={() => setRevising(null)}>Cancel</button>
                  </div>
                ) : (
                  <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                    {(s.status === "pending" || s.status === "stale" || s.status === "failed") && (
                      <button type="button" className="c2-nx sm dark" disabled={!!busy} onClick={() => void act(s.id, () => guidedApi.runStep(run.id, s.id))}>{busy === s.id ? "Running…" : s.status === "failed" ? "Run again" : "Run this step"}</button>
                    )}
                    {s.status === "done" && !s.approved && (
                      <button type="button" className="c2-nx sm" disabled={!!busy} onClick={() => void act(`ok-${s.id}`, () => guidedApi.approve(run.id, s.id, true))}>Looks right, next</button>
                    )}
                    <button type="button" className="c2-nx sm ghost" disabled={!!busy} onClick={() => { setRevising(s.id); setInstruction(""); }}>Change this step</button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {err && <div className="c2-err">{err}</div>}
      {run.status !== "done" && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {!allDone && <button type="button" className="c2-nx" disabled={!!busy} onClick={() => void act("rest", () => guidedApi.runRest(run.id))}>{busy === "rest" ? "Running…" : "Run the remaining steps"}</button>}
          {allDone && <button type="button" className="c2-nx dark" disabled={!!busy} onClick={() => void act("finish", () => guidedApi.finish(run.id))}>{busy === "finish" ? "Writing…" : "Write the answer"}</button>}
          <Link to={`/g/${projectId}`} className="c2-nx ghost">Open the full step editor</Link>
        </div>
      )}
      {run.status === "done" && (
        <div style={{ borderTop: "1px solid rgb(var(--color-border))", paddingTop: 16 }}>
          <DataAnswer run={run} onAsk={onAsk} />
        </div>
      )}
    </div>
  );
}
