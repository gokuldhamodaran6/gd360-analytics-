// 2026-10-08 (round 13): one ML Studio project - live while it trains
// (stages, leaderboard against the baseline, best score by trial, leak
// check, the resources this run uses) and its results when done.
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import AppSidebar from "../components/AppSidebar";
import TopNav from "../components/TopNav";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";
import { BoardRow, mlStudioApi, Progress, StudioProject } from "../api/mlStudio";
import { timeAgo } from "../project/format";

function errorText(e: any, fallback: string): string {
  const d = e?.response?.data?.detail;
  return typeof d === "string" && d.trim() ? d : fallback;
}

function dur(s?: number | null): string {
  if (s == null) return "";
  const t = Math.max(0, Math.round(s));
  if (t < 60) return `${t} s`;
  return `${Math.floor(t / 60)} min ${t % 60} s`;
}

const METRIC: Record<string, [string, string]> = {
  binary: ["ROC AUC", "Top 10% hit"],
  multiclass: ["Accuracy", "Macro F1"],
  number: ["R²", "Mean abs. error"],
  segments: ["Silhouette", ""],
  anomalies: ["Flagged share", ""],
  forecast: ["MASE (lower is better)", ""],
};

export default function MLStudioProject() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { workspaces, activeWorkspaceId, switchWorkspace, handleWorkspaceCreated } = useWorkspaceNav();
  const [p, setP] = useState<StudioProject | null>(null);
  const [error, setError] = useState("");
  const [notFound, setNotFound] = useState(false);
  const [scoring, setScoring] = useState<string>("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = () =>
    mlStudioApi
      .get(id)
      .then(setP)
      .catch((e) => (e?.response?.status === 404 ? setNotFound(true) : setError(errorText(e, "Couldn't load this project."))));

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (p?.status !== "training") return;
    const t = setInterval(load, 1200);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p?.status]);

  if (notFound) {
    return (
      <div className="min-h-screen grid place-items-center bg-base px-6">
        <div className="text-center">
          <div className="text-section font-semibold text-text">This model doesn't exist or isn't shared with you.</div>
          <Link to="/ml-models" className="btn-primary text-sm mt-4 inline-flex">ML Studio</Link>
        </div>
      </div>
    );
  }

  const prog: Progress | null = (p?.progress as Progress) || null;
  const res = p?.results;
  const kind: string = res?.kind || (p?.problem_type === "segments" ? "segments" : p?.problem_type === "anomalies" ? "anomalies" : p?.problem_type?.startsWith("forecast") ? "forecast" : "binary");
  const training = p?.status === "training";
  const rows = prog?.resources?.rows_used;

  const score = async () => {
    setScoring("…");
    try {
      const out = await mlStudioApi.score(id);
      setScoring(`Saved “${out.new_version_name}” · ${out.row_count.toLocaleString()} rows - open it from the data source's saved tables.`);
      load();
    } catch (e: any) {
      setScoring(errorText(e, "Couldn't score the table."));
    }
  };

  return (
    <div className="dash-shell flex min-h-screen">
      <AppSidebar workspaces={workspaces} activeWorkspaceId={activeWorkspaceId} onWorkspaceSwitch={switchWorkspace} onWorkspaceCreated={handleWorkspaceCreated} />
      <div className="flex-1 min-w-0">
        <TopNav hideLogo />
        <main className="px-4 sm:px-8 lg:px-10 py-7 max-w-[1320px] mx-auto flex flex-col gap-6">
          {!p && !error && <div className="text-ui text-muted">Loading…</div>}
          {error && <div role="alert" className="rounded-card border border-danger-border bg-danger-fill px-4 py-3 text-ui text-text">{error}</div>}
          {p && (
            <>
              <div className="flex items-end justify-between gap-4 flex-wrap">
                <div className="flex flex-col gap-1.5 min-w-0 flex-[1_1_420px]">
                  <span className="font-mono text-caption text-muted uppercase tracking-[0.06em] truncate">
                    <Link to="/ml-models" className="hover:text-text">← ML Studio</Link> / {p.name}
                  </span>
                  <h1 className="m-0 text-[24px] sm:text-[30px] font-bold tracking-tight text-text text-balance">
                    {training
                      ? `Training on ${rows ? `all ${rows.toLocaleString()} rows` : "every row"} — ${dur(p.elapsed)}`
                      : p.status === "failed"
                        ? `${p.name} — didn't finish`
                        : p.name}
                  </h1>
                  <span className="text-ui text-muted">
                    {p.source}
                    {p.table ? ` · ${p.table}` : ""}
                    {p.status === "ready" && p.trained_at ? ` · trained ${timeAgo(p.trained_at)} in ${dur(p.elapsed)}` : ""}
                    {training && prog?.message ? ` · ${prog.message}` : ""}
                  </span>
                </div>
                <div className="flex gap-2 flex-wrap">
                  {training ? (
                    <>
                      <button type="button" className="btn-secondary text-sm" onClick={() => navigate("/ml-models")}>Run in background</button>
                      {p.can_edit && (
                        <button type="button" className="btn-secondary text-sm" onClick={() => mlStudioApi.stop(id).then(load).catch((e) => setError(errorText(e, "Couldn't stop it.")))}>
                          Stop
                        </button>
                      )}
                    </>
                  ) : (
                    <>
                      {p.can_edit && <button type="button" className="btn-secondary text-sm" onClick={() => mlStudioApi.retrain(id).then(load).catch((e) => setError(errorText(e, "Couldn't start it.")))}>Train again</button>}
                      {p.status === "ready" && (kind === "binary" || kind === "multiclass" || kind === "number") && (
                        <Link to={`/ml-models/${id}`} className="btn-secondary text-sm">Try a prediction</Link>
                      )}
                      {p.status === "ready" && kind !== "forecast" && (
                        <button type="button" className="btn-primary text-sm" onClick={score} disabled={scoring === "…"}>
                          {scoring === "…" ? "Scoring…" : "Score every row"}
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>

              {scoring && scoring !== "…" && <div role="status" className="rounded-card border border-tint-border bg-tint/40 px-4 py-3 text-ui text-text">{scoring}</div>}
              {p.status === "failed" && <div role="alert" className="rounded-card border border-danger-border bg-danger-fill px-4 py-3 text-ui text-text">{p.error}</div>}

              {prog && <StageRow stages={prog.stages} />}

              <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px] items-start">
                <div className="flex flex-col gap-5 min-w-0">
                  {p.status === "ready" && res && <Results kind={kind} res={res} />}
                  {prog && prog.leaderboard.length > 0 && <Leaderboard prog={prog} kind={kind} done={!training} />}
                </div>
                <aside className="flex flex-col gap-4">
                  <SizeTiers rows={rows} />
                  {prog && <ThisRun prog={prog} elapsed={p.elapsed} />}
                  {prog && (prog.leaks || []).length > 0 && (
                    <section className="rounded-card border border-border bg-surface p-4 flex flex-col gap-3" aria-label="Leak check">
                      <h3 className="m-0 font-mono text-[11px] uppercase tracking-[0.12em] text-warning font-medium">Leak check · {prog.leaks.length} removed</h3>
                      {prog.leaks.map((l) => (
                        <div key={l.column} className="flex flex-col gap-0.5 border-t border-border pt-2.5 first:border-t-0 first:pt-0">
                          <span className="font-mono text-ui text-text">{l.column}</span>
                          <span className="text-caption text-muted leading-snug">{l.reason}</span>
                        </div>
                      ))}
                    </section>
                  )}
                  {!training && p.can_delete && (
                    <div className="flex gap-2">
                      {confirmDelete ? (
                        <>
                          <button type="button" className="btn-secondary text-sm !text-danger" onClick={() => mlStudioApi.remove(id).then(() => navigate("/ml-models"))}>Delete for good</button>
                          <button type="button" className="btn-secondary text-sm" onClick={() => setConfirmDelete(false)}>Keep it</button>
                        </>
                      ) : (
                        <button type="button" className="text-caption text-muted underline hover:text-danger" onClick={() => setConfirmDelete(true)}>Delete this model</button>
                      )}
                    </div>
                  )}
                </aside>
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

function StageRow({ stages }: { stages: Progress["stages"] }) {
  return (
    <ol className="m-0 p-0 list-none grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }} aria-label="Stages">
      {stages.map((s, i) => (
        <li
          key={s.id}
          className="rounded-card border p-3.5 flex flex-col gap-1 min-w-0"
          style={
            s.status === "running"
              ? { borderColor: "rgb(var(--auto-tell-border))", background: "rgb(var(--auto-tell-fill))" }
              : { borderColor: "rgb(var(--color-border))", background: "rgb(var(--color-surface))" }
          }
        >
          <span className="flex items-center justify-between font-mono text-[11px]">
            <span style={{ color: s.status === "pending" ? "rgb(var(--color-muted))" : s.status === "running" ? "rgb(var(--auto-tell))" : "rgb(var(--auto-do))" }}>
              {String(i + 1).padStart(2, "0")}
            </span>
            {s.status === "done" && <span style={{ color: "rgb(var(--auto-do))" }}>✓</span>}
            {s.status === "running" && <span style={{ color: "rgb(var(--auto-tell))" }}>● running</span>}
          </span>
          <span className={`text-ui font-semibold ${s.status === "pending" ? "text-muted" : "text-text"}`}>{s.title}</span>
          <span className="text-caption text-muted leading-snug">{s.note || (s.status === "pending" ? "waiting" : "")}</span>
        </li>
      ))}
    </ol>
  );
}

function fmt(kind: string, v: number | null | undefined, second = false): string {
  if (v == null || Number.isNaN(v)) return "—";
  if (kind === "binary") return second ? `${Math.round(v * 100)}%` : v.toFixed(3);
  if (kind === "multiclass") return `${(v * 100).toFixed(1)}%`;
  if (kind === "number") return second ? (Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : v.toFixed(2)) : v.toFixed(3);
  if (kind === "anomalies") return `${(v * 100).toFixed(1)}%`;
  return v.toFixed(3);
}

function Leaderboard({ prog, kind, done }: { prog: Progress; kind: string; done: boolean }) {
  const [m1, m2] = METRIC[kind] || ["Score", ""];
  const useTest = done && prog.leaderboard.some((r) => r.test_score != null);
  const val = (r: BoardRow) => (useTest ? r.test_score : r.score);
  const scores = prog.leaderboard.map(val).filter((x): x is number => typeof x === "number" && !Number.isNaN(x));
  const max = Math.max(...scores, 0.0001);
  const min = kind === "forecast" ? 0 : Math.min(0, ...scores);
  const isForecast = kind === "forecast";
  return (
    <section className="rounded-card border border-border bg-surface overflow-hidden" aria-label="Leaderboard">
      <div className="flex items-baseline justify-between gap-3 px-5 pt-4 pb-3 flex-wrap">
        <h2 className="m-0 text-[18px] font-semibold text-text">{done ? (isForecast ? "Each series" : "Leaderboard") : "Live leaderboard"}</h2>
        <span className="font-mono text-caption text-muted">
          {useTest ? "scores on held-out rows" : isForecast ? "backtest error per series" : kind === "segments" ? "how well separated each number of groups is" : kind === "anomalies" ? "share of rows flagged" : "scores on a validation slice"}
          {prog.trials_total ? ` · ${prog.trials_done} of ${prog.trials_total} ${isForecast ? "series" : kind === "segments" ? "group counts" : "trials"}` : ""}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-ui border-collapse min-w-[560px]">
          <thead>
            <tr className="text-left border-y border-border">
              {[isForecast ? "Series" : "Algorithm", m1, m2, isForecast ? "Method" : "Trials", "State"].filter((h, i) => h || i === 0).map((h) => (
                <th key={h} className="font-mono text-[11px] uppercase tracking-[0.1em] text-muted font-medium px-5 py-2.5">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {prog.leaderboard.map((r) => {
              const v = val(r);
              const w = typeof v === "number" && !Number.isNaN(v) ? Math.max(2, ((v - min) / (max - min || 1)) * 100) : 0;
              return (
                <tr key={r.key} className={`border-b border-border last:border-b-0 ${r.best ? "bg-[rgb(var(--auto-do-fill)/0.4)]" : ""}`}>
                  <td className="px-5 py-3 text-text">
                    {r.algorithm}
                    {r.best && !isForecast && <span className="ml-2 font-mono text-[10px] uppercase" style={{ color: "rgb(var(--auto-do))" }}>{done ? "chosen" : "best so far"}</span>}
                  </td>
                  <td className="px-5 py-3">
                    <span className="flex items-center gap-3">
                      <span className="font-mono text-text w-[52px]">{fmt(kind, v)}</span>
                      <span className="flex-1 min-w-[80px] max-w-[160px] h-[6px] rounded-full bg-subtle overflow-hidden">
                        <span
                          className="block h-full rounded-full"
                          style={{ width: `${w}%`, background: r.baseline ? "rgb(var(--color-faint))" : r.best ? "rgb(var(--auto-do))" : "rgb(var(--auto-tell))" }}
                        />
                      </span>
                    </span>
                  </td>
                  {m2 && <td className="px-5 py-3 font-mono text-secondary">{fmt(kind, useTest ? r.test_second : r.second, true)}</td>}
                  <td className="px-5 py-3 font-mono text-secondary">{isForecast ? r.method || "—" : r.trials ?? "—"}</td>
                  <td className={`px-5 py-3 font-mono text-caption ${r.state === "running" ? "text-[rgb(var(--auto-tell))]" : "text-muted"}`}>{r.state}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {prog.curve.length > 1 && !isForecast && kind !== "segments" && <Curve prog={prog} kind={kind} />}
      {prog.split && <p className="m-0 px-5 pb-4 text-caption text-muted">{prog.split}.</p>}
    </section>
  );
}

function Curve({ prog, kind }: { prog: Progress; kind: string }) {
  const pts = prog.curve.filter((c) => typeof c.best === "number");
  const base = prog.leaderboard.find((r) => r.baseline)?.score ?? null;
  const ys = pts.map((c) => c.best as number).concat(base != null ? [base] : []);
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  const pad = (hi - lo) * 0.12 || 0.01;
  const y0 = lo - pad;
  const y1 = hi + pad;
  const W = 640;
  const H = 150;
  const n = Math.max(prog.trials_total || pts.length, pts.length, 2);
  const x = (i: number) => 40 + ((i - 1) / (n - 1)) * (W - 60);
  const y = (v: number) => 10 + (1 - (v - y0) / (y1 - y0)) * (H - 30);
  const path = pts.map((c, i) => `${i ? "L" : "M"}${x(c.trial).toFixed(1)},${y(c.best as number).toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  return (
    <figure className="m-0 px-5 pb-3 pt-1" aria-label="Best score so far, by trial">
      <figcaption className="text-ui text-secondary mb-1">Best score so far, by trial</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label={`Best ${METRIC[kind]?.[0] || "score"} rose to ${last ? fmt(kind, last.best) : ""}`}>
        <text x="0" y={y(y1 - pad) + 4} fontSize="11" fill="rgb(var(--color-muted))" fontFamily="Geist Mono, monospace">{fmt(kind, hi)}</text>
        <text x="0" y={y(y0 + pad) + 4} fontSize="11" fill="rgb(var(--color-muted))" fontFamily="Geist Mono, monospace">{fmt(kind, lo)}</text>
        {base != null && (
          <>
            <line x1="40" x2={W - 20} y1={y(base)} y2={y(base)} stroke="rgb(var(--color-faint))" strokeDasharray="4 4" strokeWidth="1.5" />
            <text x={W - 20} y={y(base) - 6} fontSize="11" textAnchor="end" fill="rgb(var(--color-muted))" fontFamily="Geist Mono, monospace">baseline {fmt(kind, base)}</text>
          </>
        )}
        <path d={path} fill="none" stroke="rgb(var(--auto-do))" strokeWidth="2.2" strokeLinejoin="round" />
        {last && <circle cx={x(last.trial)} cy={y(last.best as number)} r="4.5" fill="rgb(var(--auto-do))" />}
      </svg>
    </figure>
  );
}

function SizeTiers({ rows }: { rows?: number }) {
  return (
    <section className="rounded-card border border-border bg-surface p-4 flex flex-col gap-2.5" aria-label="Built for any data size">
      <h3 className="m-0 font-mono text-[11px] uppercase tracking-[0.12em] text-muted font-medium">How data size is handled</h3>
      <div className="rounded-ctl border p-3 flex flex-col gap-1" style={{ borderColor: "rgb(var(--auto-do-border))", background: "rgb(var(--auto-do-fill) / 0.4)" }}>
        <span className="flex justify-between gap-2 text-ui font-semibold text-text">
          In memory on this server
          {rows != null && <span className="font-mono text-[10px] uppercase" style={{ color: "rgb(var(--auto-do))" }}>this run · {rows.toLocaleString()}</span>}
        </span>
        <span className="text-caption text-muted leading-snug">Every row up to the server's limit, seconds to minutes. A bigger table trains on its first rows and says so.</span>
      </div>
      <div className="rounded-ctl border border-border p-3 flex flex-col gap-1">
        <span className="flex justify-between gap-2 text-ui font-semibold text-text">Larger tables <span className="font-mono text-[10px] uppercase text-muted">next</span></span>
        <span className="text-caption text-muted leading-snug">Features built inside your warehouse; training streamed in chunks across workers.</span>
      </div>
      <div className="rounded-ctl border border-border p-3 flex flex-col gap-1">
        <span className="flex justify-between gap-2 text-ui font-semibold text-text">Hundreds of millions of rows <span className="font-mono text-[10px] uppercase text-muted">next</span></span>
        <span className="text-caption text-muted leading-snug">Training runs inside the warehouse (BigQuery ML, Snowflake ML). Data stays where it is.</span>
      </div>
      <p className="m-0 text-caption text-muted leading-snug">Data is never sampled without telling you.</p>
    </section>
  );
}

function Bar({ label, value, pct, tone = "tell" }: { label: string; value: string; pct: number; tone?: "do" | "tell" }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex justify-between text-ui">
        <span className="text-text">{label}</span>
        <span className="font-mono text-secondary">{value}</span>
      </div>
      <span className="h-[5px] rounded-full bg-subtle overflow-hidden">
        <span className="block h-full rounded-full" style={{ width: `${Math.max(2, Math.min(100, pct))}%`, background: `rgb(var(--auto-${tone}))` }} />
      </span>
    </div>
  );
}

function ThisRun({ prog, elapsed }: { prog: Progress; elapsed: number | null }) {
  const r = prog.resources || {};
  return (
    <section className="rounded-card border border-border bg-surface p-4 flex flex-col gap-3" aria-label="This run">
      <h3 className="m-0 font-mono text-[11px] uppercase tracking-[0.12em] text-muted font-medium">This run</h3>
      {r.rows_used != null && (
        <Bar
          label="Rows used"
          value={`${r.rows_used.toLocaleString()} of ${r.rows_total?.toLocaleString()}${r.capped ? "+" : ""}`}
          pct={r.rows_total ? (r.rows_used / r.rows_total) * 100 : 100}
          tone="do"
        />
      )}
      {r.capped && <span className="text-caption text-warning -mt-1">The table is bigger than this server's row limit - it trained on the first rows.</span>}
      {prog.memory_note && <span className="text-caption text-warning -mt-1">{prog.memory_note}</span>}
      {r.workers != null && <Bar label="Workers" value={`${r.workers} CPU`} pct={100} />}
      {r.memory_mb != null && r.memory_mb > 0 && <Bar label="Peak memory" value={`${r.memory_mb.toLocaleString()} MB`} pct={Math.min(100, (r.memory_mb / 1024) * 100)} />}
      {prog.trials_total ? <Bar label="Trials" value={`${prog.trials_done} of ${prog.trials_total}`} pct={(prog.trials_done / prog.trials_total) * 100} /> : null}
      {elapsed != null && <Bar label="Time" value={dur(elapsed)} pct={100} />}
    </section>
  );
}

// ---------------------------------------------------------------- results ----

function Results({ kind, res }: { kind: string; res: any }) {
  return (
    <section className="flex flex-col gap-4" aria-label="Results">
      {(res.warnings || []).map((w: string) => (
        <div key={w} className="rounded-card border border-warning-border bg-warning-fill px-4 py-3 text-ui text-text">{w}</div>
      ))}
      {(kind === "binary" || kind === "multiclass" || kind === "number") && <SupervisedResult res={res} kind={kind} />}
      {kind === "segments" && <Segments res={res} />}
      {kind === "anomalies" && <Anomalies res={res} />}
      {kind === "forecast" && <Forecasts res={res} />}
    </section>
  );
}

function SupervisedResult({ res, kind }: { res: any; kind: string }) {
  const [m1, m2] = METRIC[kind];
  const maxImp = Math.max(...(res.drivers || []).map((d: any) => Math.abs(d.importance)), 1e-9);
  return (
    <>
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}>
        <Kpi label={`${m1} on held-out rows`} value={fmt(kind, res.test_score)} note={res.winner} />
        {m2 && <Kpi label={m2} value={fmt(kind, res.test_second, true)} note={kind === "binary" ? "of the top-scored 10% really were yes" : ""} />}
        <Kpi
          label="Baseline"
          value={fmt(kind, res.baseline?.score)}
          note={res.baseline?.name?.replace("Baseline · ", "")}
          tone={res.beats_baseline ? "good" : "bad"}
          badge={res.beats_baseline ? "beaten" : "not beaten"}
        />
        <Kpi label="Tested on" value={`${Number(res.test_rows).toLocaleString()} rows`} note={`trained on ${Number(res.train_rows).toLocaleString()}`} />
      </div>
      <p className="m-0 text-caption text-muted">{res.split}.</p>
      <section className="rounded-card border border-border bg-surface p-5 flex flex-col gap-3" aria-label="Drivers">
        <h2 className="m-0 text-[18px] font-semibold text-text">What moves {res.label?.target}{res.kind === "binary" ? ` = ${res.positive}` : ""}</h2>
        <p className="m-0 text-caption text-muted">How much the held-out score drops when each column is shuffled - bigger means the model leans on it more. Arrows show which way higher values push.</p>
        <div className="flex flex-col gap-2">
          {(res.drivers || []).slice(0, 12).map((d: any) => (
            <div key={d.feature} className="grid grid-cols-[minmax(110px,30%)_1fr_auto] gap-3 items-center text-ui">
              <span className="text-text truncate" title={d.feature}>{d.feature}</span>
              <span className="h-[8px] rounded-full bg-subtle overflow-hidden">
                <span className="block h-full rounded-full" style={{ width: `${Math.max(2, (Math.abs(d.importance) / maxImp) * 100)}%`, background: "rgb(var(--auto-do))" }} />
              </span>
              <span className="font-mono text-caption text-secondary w-[64px] text-right">
                {d.direction === "up" ? "↑ raises" : d.direction === "down" ? "↓ lowers" : "mixed"}
              </span>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

function Kpi({ label, value, note, tone, badge }: { label: string; value: string; note?: string; tone?: "good" | "bad"; badge?: string }) {
  return (
    <div className="rounded-card border border-border bg-surface px-[18px] py-4 flex flex-col gap-1 min-w-0">
      <span className="flex items-center justify-between gap-2 text-ui text-muted">
        {label}
        {badge && <span className={`font-mono text-[10px] uppercase px-1.5 py-0.5 rounded ${tone === "good" ? "bg-good-fill text-good" : "bg-danger-fill text-danger"}`}>{badge}</span>}
      </span>
      <span className="font-mono text-kpi leading-tight tracking-tight text-text">{value}</span>
      {note && <span className="text-caption text-muted leading-snug line-clamp-2" title={note}>{note}</span>}
    </div>
  );
}

function Segments({ res }: { res: any }) {
  return (
    <section className="flex flex-col gap-3" aria-label="Segments">
      <h2 className="m-0 text-[18px] font-semibold text-text">{res.k} groups</h2>
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))" }}>
        {res.groups.map((g: any, i: number) => (
          <article key={g.id} className="rounded-card border border-border bg-surface p-5 flex flex-col gap-3">
            <span className="flex justify-between items-baseline gap-2">
              <span className="font-mono text-caption uppercase" style={{ color: "rgb(var(--auto-when))" }}>Group {i + 1}</span>
              <span className="font-mono text-caption text-muted">{g.rows.toLocaleString()} rows · {(g.share * 100).toFixed(0)}%</span>
            </span>
            <span className="h-[6px] rounded-full bg-subtle overflow-hidden">
              <span className="block h-full rounded-full" style={{ width: `${g.share * 100}%`, background: "rgb(var(--auto-when))" }} />
            </span>
            <ul className="m-0 pl-4 flex flex-col gap-1 text-ui text-secondary">
              {g.traits.map((t: any) => <li key={t.feature}>{t.text}</li>)}
            </ul>
          </article>
        ))}
      </div>
    </section>
  );
}

function Anomalies({ res }: { res: any }) {
  return (
    <section className="rounded-card border border-border bg-surface p-5 flex flex-col gap-3" aria-label="Anomalies">
      <h2 className="m-0 text-[18px] font-semibold text-text">
        {Number(res.flagged).toLocaleString()} of {Number(res.rows_total).toLocaleString()} rows flagged
      </h2>
      <p className="m-0 text-caption text-muted">The most unusual first, each with the columns that make it stand out.</p>
      <div className="overflow-x-auto">
        <table className="w-full text-ui border-collapse min-w-[520px]">
          <thead>
            <tr className="text-left">
              {["Row", "Score", "Why it stands out"].map((h) => (
                <th key={h} className="font-mono text-[11px] uppercase tracking-[0.1em] text-muted font-medium px-2 py-2 border-b border-border">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {res.top.slice(0, 25).map((r: any) => (
              <tr key={r.row} className="border-b border-border last:border-b-0">
                <td className="px-2 py-2.5 font-mono text-secondary">#{r.row + 1}</td>
                <td className="px-2 py-2.5 font-mono text-text">{r.score.toFixed(3)}</td>
                <td className="px-2 py-2.5 text-secondary">{r.reasons.join(" · ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Forecasts({ res }: { res: any }) {
  const ok = (res.series || []).filter((s: any) => s.status === "ok");
  const [pick, setPick] = useState(0);
  const s = ok[pick] || ok[0];
  if (!s) return null;
  return (
    <section className="rounded-card border border-border bg-surface p-5 flex flex-col gap-4" aria-label="Forecast">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div className="flex flex-col gap-1">
          <h2 className="m-0 text-[18px] font-semibold text-text">
            {res.value} per {res.grain}
            {s.series != null ? ` — ${s.series}` : ""}: next {res.horizon} {res.grain}s
          </h2>
          <span className="text-caption text-muted">
            {s.method}
            {s.backtest?.mase != null ? ` · backtest MASE ${Number(s.backtest.mase).toFixed(2)} (below 1 beats “${s.backtest?.baseline?.method || "same period last season"}”)` : ""}
          </span>
        </div>
        {ok.length > 1 && (
          <label className="flex items-center gap-2 text-caption text-muted">
            Series
            <select className="h-9 rounded-ctl border border-border bg-base px-2 text-ui text-text" value={pick} onChange={(e) => setPick(Number(e.target.value))}>
              {ok.map((x: any, i: number) => <option key={i} value={i}>{String(x.series)}</option>)}
            </select>
          </label>
        )}
      </div>
      <ForecastChart s={s} />
      <div className="overflow-x-auto">
        <table className="w-full text-ui border-collapse min-w-[420px]">
          <thead>
            <tr className="text-left">
              {["Period", "Forecast", "80% range", "95% range"].map((h) => (
                <th key={h} className="font-mono text-[11px] uppercase tracking-[0.1em] text-muted font-medium px-2 py-2 border-b border-border">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {s.points.map((pt: any) => (
              <tr key={pt.period} className="border-b border-border last:border-b-0">
                <td className="px-2 py-2 font-mono text-secondary">{pt.period}</td>
                <td className="px-2 py-2 font-mono text-text">{Math.round(pt.value).toLocaleString()}</td>
                <td className="px-2 py-2 font-mono text-muted">{pt.lo80 != null ? `${Math.round(pt.lo80).toLocaleString()} – ${Math.round(pt.hi80).toLocaleString()}` : "—"}</td>
                <td className="px-2 py-2 font-mono text-muted">{pt.lo95 != null ? `${Math.round(pt.lo95).toLocaleString()} – ${Math.round(pt.hi95).toLocaleString()}` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(s.notes || []).length > 0 && <p className="m-0 text-caption text-muted">{s.notes.join(" ")}</p>}
    </section>
  );
}

function ForecastChart({ s }: { s: any }) {
  const hist = (s.history || []).filter((h: any) => h.value != null).slice(-52);
  const pts = s.points || [];
  const all = [...hist.map((h: any) => h.value), ...pts.map((p: any) => p.hi95 ?? p.hi80 ?? p.value), ...pts.map((p: any) => p.lo95 ?? p.lo80 ?? p.value)];
  const lo = Math.min(...all, 0);
  const hi = Math.max(...all, 1);
  const W = 720;
  const H = 220;
  const n = hist.length + pts.length;
  const x = (i: number) => 46 + (i / Math.max(1, n - 1)) * (W - 60);
  const y = (v: number) => 12 + (1 - (v - lo) / (hi - lo || 1)) * (H - 36);
  const line = hist.map((h: any, i: number) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(h.value).toFixed(1)}`).join(" ");
  const fline = pts.map((p: any, i: number) => `${i ? "L" : "M"}${x(hist.length + i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const band = (loK: string, hiK: string) =>
    pts.length && pts[0][loK] != null
      ? pts.map((p: any, i: number) => `${i ? "L" : "M"}${x(hist.length + i).toFixed(1)},${y(p[hiK]).toFixed(1)}`).join(" ") +
        " " +
        [...pts].reverse().map((p: any, i: number) => `L${x(hist.length + pts.length - 1 - i).toFixed(1)},${y(p[loK]).toFixed(1)}`).join(" ") +
        " Z"
      : "";
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="History and forecast with ranges">
      {[lo, (lo + hi) / 2, hi].map((v, i) => (
        <g key={i}>
          <line x1="46" x2={W - 14} y1={y(v)} y2={y(v)} stroke="rgb(var(--chart-grid))" strokeWidth="1" />
          <text x="0" y={y(v) + 4} fontSize="11" fill="rgb(var(--color-muted))" fontFamily="Geist Mono, monospace">{Math.round(v).toLocaleString()}</text>
        </g>
      ))}
      {band("lo95", "hi95") && <path d={band("lo95", "hi95")} fill="rgb(var(--auto-tell) / 0.12)" />}
      {band("lo80", "hi80") && <path d={band("lo80", "hi80")} fill="rgb(var(--auto-tell) / 0.22)" />}
      <path d={line} fill="none" stroke="rgb(var(--color-secondary))" strokeWidth="1.8" />
      <path d={fline} fill="none" stroke="rgb(var(--auto-tell))" strokeWidth="2.2" />
      {hist.length > 0 && <line x1={x(hist.length - 1)} x2={x(hist.length - 1)} y1="8" y2={H - 22} stroke="rgb(var(--color-border-strong))" strokeDasharray="3 3" />}
      {hist[0] && <text x={x(0)} y={H - 6} fontSize="11" fill="rgb(var(--color-muted))" fontFamily="Geist Mono, monospace">{hist[0].period}</text>}
      {pts.length > 0 && <text x={W - 14} y={H - 6} fontSize="11" textAnchor="end" fill="rgb(var(--color-muted))" fontFamily="Geist Mono, monospace">{pts[pts.length - 1].period}</text>}
    </svg>
  );
}
