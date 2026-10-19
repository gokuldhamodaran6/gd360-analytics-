// 2026-10-14 (R46): a data answer in the conversation - prose first (the finding, then the reasons as
// sentences), the one picture that helps, the rest one tap away. Reuses the tested chart, table and
// Analyst components so numbers are formatted the same everywhere.
import { useState, type ReactNode } from "react";
import type { ProjectRun, Visual } from "../api/projects";
import { AnalystAnswer, AnalystProgress, isAnalystRun, analystOf } from "../project/AnalystAnswer";
import { ErrorNote } from "../project/RunPanels";
import { KpiRow, VisualCard } from "../project/Visuals";
import WaysForward from "../project/WaysForward";

function leadVisual(visuals: Visual[]): Visual | null {
  // the picture that explains the answer: a waterfall or forecast first, else the first chart that is not a table
  return visuals.find((v) => v.type === "waterfall" || v.type === "forecast") || visuals.find((v) => v.type === "chart" && v.display !== "table") || visuals.find((v) => v.type === "chart") || null;
}

export function DataAnswer({ run, onAsk, chips, compact = false }: { run: ProjectRun; onAsk?: (q: string) => void; chips?: ReactNode; compact?: boolean }) {
  const [more, setMore] = useState(false);
  if (run.status === "failed" || run.status === "stopped") {
    return <ErrorNote error={run.error} fallback="This question couldn't be answered. Please ask it again." className="rounded-card p-4" />;
  }
  if (isAnalystRun(run)) {
    if (run.status === "done" && analystOf(run)) return <div className="c2-a"><AnalystAnswer key={run.id} run={run} />{chips}</div>;
    return <AnalystProgress run={run} compact />;
  }
  const res = run.result;
  if (!res || run.status !== "done") {
    if (run.status === "needs_input" && res?.answer) return <WaysForward answer={res.answer} onAsk={onAsk} compact />;
    return null;
  }
  const ans = res.answer;
  const visuals = (res.visuals || []).filter((v) => v.type !== "kpis");
  const kpis = ((res as any).kpis || []) as any[];
  const lead = leadVisual(visuals);
  const rest = visuals.filter((v) => v !== lead);
  const causes = ans.causes || [];
  if (compact) {
    // R56 (Studio): the steps, charts and tables are on the canvas; the thread keeps the finding in words
    return (
      <div className="c2-a" data-c2-answer="" data-c2-compact="">
        {ans.headline && <h2 className="lead" data-c2-headline="">{ans.headline}</h2>}
        {ans.answer && ans.answer !== ans.headline && <p className="prose">{ans.answer}</p>}
        {chips}
      </div>
    );
  }
  return (
    <div className="c2-a" data-c2-answer="">
      {ans.headline && <h2 className="lead" data-c2-headline="">{ans.headline}</h2>}
      {ans.answer && ans.answer !== ans.headline && <p className="prose" style={{ fontSize: 16.5 }}>{ans.answer}</p>}
      {causes.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {causes.slice(0, 4).map((c, i) => (
            <p key={i} className="sub" style={{ display: "grid", gridTemplateColumns: "18px minmax(0,1fr)", gap: 8 }}>
              <span className="c2-mono" style={{ color: "rgb(var(--color-primary))", fontSize: 12, paddingTop: 3 }}>{i + 1}</span>
              <span>
                <b style={{ color: "rgb(var(--color-text))", fontWeight: 600 }}>{c.title}</b>
                {c.amount && <span className="c2-mono" style={{ marginLeft: 8, color: "rgb(var(--color-text))" }}>{c.amount}{c.share ? ` · ${c.share}` : ""}</span>}
                {c.detail && <span> — {c.detail}</span>}
              </span>
            </p>
          ))}
        </div>
      )}
      {chips}
      {kpis.length > 0 && kpis.length <= 4 && !lead && <KpiRow items={kpis} />}
      {lead && <VisualCard visual={lead} id={`${run.id}:lead`} />}
      {(ans.ruled_out || []).length > 0 && (
        <p className="sub" style={{ fontSize: 14 }}>
          <span style={{ color: "rgb(var(--color-muted))" }}>Ruled out: </span>
          {(ans.ruled_out || []).slice(0, 3).map((r) => r.title + (r.detail ? ` (${r.detail})` : "")).join("; ")}
        </p>
      )}
      {(rest.length > 0 || (kpis.length > 0 && lead) || (res.evidence || []).length > 0) && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <button type="button" className={`c2-w ${more ? "open" : ""}`} onClick={() => setMore((m) => !m)} data-c2-more="">
            <svg className="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M9 18l6-6-6-6" /></svg>
            {more ? "Less" : `More${rest.length ? ` · ${rest.length} chart${rest.length !== 1 ? "s" : ""}` : ""}${(res.evidence || []).length ? ` · ${(res.evidence || []).length} table${(res.evidence || []).length !== 1 ? "s" : ""}` : ""}`}
          </button>
          {more && kpis.length > 0 && lead && <KpiRow items={kpis} />}
          {more && rest.map((v, i) => <VisualCard key={i} visual={v} id={`${run.id}:v${i}`} />)}
          {more && (res.evidence || []).map((t, i) => (
            <VisualCard key={`e${i}`} visual={{ type: "chart", title: t.title, columns: t.columns, rows: t.rows, display: "table", truncated: t.truncated, sources: [t.source] } as any} id={`${run.id}:e${i}`} />
          ))}
        </div>
      )}
      {(res.warnings || []).length > 0 && (
        <p className="sub" style={{ fontSize: 13, color: "rgb(var(--color-warning))" }}>{(res.warnings || []).slice(0, 2).join(" · ")}</p>
      )}
      {onAsk && (ans.next_questions || []).length > 0 && (
        <div className="c2-next" data-c2-next="">
          {(ans.next_questions || []).slice(0, 3).map((q) => (
            <button key={q} type="button" className="c2-nx sm" onClick={() => onAsk(q)}>{q}</button>
          ))}
        </div>
      )}
    </div>
  );
}
