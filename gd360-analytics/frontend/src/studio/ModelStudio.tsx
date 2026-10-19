// 2026-10-19 (R56, Studio board "Model studio"): a trained model on the canvas - how often it is right on rows it
// never saw, what drives it, "was it right?" (predicted against what really happened, by band), the rows with the
// highest chance first - with Train again, Score every row and ONE green button, Use this model.
import { useCallback, useEffect, useState } from "react";
import { mlStudioApi, type StudioProject } from "../api/mlStudio";
import type { FrameBits } from "./AnalysisStudio";
import { ago, MenuButton, safeName, saveBlob, StudioFrame, toCsv } from "./Frame";
import { Ic } from "./icons";
import { ListPage, PageHead } from "./Page";

type Tab = "overview" | "rows" | "reasons" | "accuracy" | "code";
type Band = { band: string; n: number; predicted: number | null; actual: number | null };

function Calibration({ bands, kind }: { bands: Band[]; kind: "binary" | "number" }) {
  const W = 520, H = 210, L = 40, B = 28, T = 10;
  const vals = bands.flatMap((b) => [b.predicted ?? 0, b.actual ?? 0]);
  const vmax = kind === "binary" ? 100 : Math.max(...vals, 1e-9) * 1.1;
  const pw = W - L - 8, ph = H - T - B;
  const gw = pw / bands.length;
  const y = (v: number) => T + ph - (ph * v) / vmax;
  const ticks = kind === "binary" ? [0, 50, 100] : [0, vmax / 2, vmax];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto" }} role="img"
      aria-label={`Predicted against real, by band: ${bands.map((b) => `${b.band} predicted ${b.predicted ?? "-"} real ${b.actual ?? "-"}`).join("; ")}`}>
      {ticks.map((t) => (
        <g key={t}><line x1={L} x2={W - 8} y1={y(t)} y2={y(t)} stroke="rgb(var(--color-border))" />
          <text x={L - 6} y={y(t) + 4} textAnchor="end" fontSize="10" fill="rgb(var(--color-muted))" fontFamily="Geist Mono, monospace">{kind === "binary" ? `${t}%` : t >= 1000 ? `${Math.round(t / 1000)}k` : Math.round(t * 10) / 10}</text></g>
      ))}
      {bands.map((b, i) => {
        const x0 = L + i * gw + gw * 0.22, bw = gw * 0.26;
        return (
          <g key={b.band}>
            {b.predicted != null && <rect x={x0} y={y(b.predicted)} width={bw} height={Math.max(1, y(0) - y(b.predicted))} rx="3" fill="rgb(var(--color-border-strong))"><title>{`Predicted ${b.predicted}${kind === "binary" ? "%" : ""} · ${b.n} rows`}</title></rect>}
            {b.actual != null && <rect x={x0 + bw + 3} y={y(b.actual)} width={bw} height={Math.max(1, y(0) - y(b.actual))} rx="3" fill="rgb(var(--sd-c1))"><title>{`Really ${b.actual}${kind === "binary" ? "%" : ""} · ${b.n} rows`}</title></rect>}
            <text x={L + i * gw + gw / 2} y={H - 10} textAnchor="middle" fontSize="10" fill="rgb(var(--color-muted))" fontFamily="Geist Mono, monospace">{b.band}</text>
          </g>
        );
      })}
    </svg>
  );
}

export function ModelStudio({ id, frame, onAsk, onPrefill, busy, page = false }: {
  id: string; frame?: FrameBits; onAsk: (q: string) => void; onPrefill: (q: string) => void; busy: boolean;
  /** R56: the same model as a full page (/models/:id) - the list board's model page */
  page?: boolean;
}) {
  const [m, setM] = useState<StudioProject | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [working, setWorking] = useState(false);
  const load = useCallback(async () => { try { setM(await mlStudioApi.get(id)); setErr(null); } catch (e: any) { setErr(e?.response?.data?.detail || "Couldn't open this model."); } }, [id]);
  useEffect(() => { void load(); }, [load]);
  const scoring = (m?.progress as any)?.scoring as { state?: string; done?: number; total?: number | null; rows?: number; version_name?: string; error?: string } | undefined;
  const live = m?.status === "training" || scoring?.state === "queued" || scoring?.state === "running";
  useEffect(() => { if (!live) return; const t = window.setInterval(() => void load(), 2500); return () => window.clearInterval(t); }, [live, load]);

  const r = (m?.results || {}) as any;
  const kpis: { label: string; display: string; note?: string | null }[] = r.kpis || [];
  const drivers: { label: string; value: number; display: string; note?: string; tone?: string }[] = ((r.sections || []).find((x: any) => x.type === "bars")?.items) || [];
  const cal = r.calibration as { kind: "binary" | "number"; bands: Band[]; positive?: string } | undefined;
  const top = r.top_rows as { id_label: string; columns: string[]; rows: Record<string, any>[]; high: number | null; of: number } | undefined;
  const board: { algorithm: string; score: number | null; test_score: number | null; baseline?: boolean; best?: boolean }[] = r.leaderboard || [];
  const target = m?.target || r.label?.target || "the outcome";
  const positive = r.positive || cal?.positive;
  const scoreAll = async () => { setWorking(true); try { await mlStudioApi.scoreJob(id); await load(); } catch (e: any) { setErr(e?.response?.data?.detail || "Couldn't start scoring."); } finally { setWorking(false); } };
  const retrain = async () => { setWorking(true); try { await mlStudioApi.retrain(id); await load(); } catch (e: any) { setErr(e?.response?.data?.detail || "Couldn't start training."); } finally { setWorking(false); } };
  const status = !m ? "" : m.status === "training" ? `Training · ${(m.progress as any)?.message || "working"}` : m.status === "failed" ? "Training failed"
    : scoring?.state === "running" || scoring?.state === "queued" ? `Scoring every row · ${(scoring.done || 0).toLocaleString()}${scoring.total ? ` of ${scoring.total.toLocaleString()}` : ""}`
    : `Version ${m.version} · ${m.predictions ? `${m.predictions.toLocaleString()} rows scored` : "not used yet"}${m.trained_at ? ` · trained ${ago(m.trained_at)}` : ""}`;
  const T = (k: Tab, icon: string, label: string) => <button type="button" className={`sd-tool${tab === k ? " on" : ""}`} onClick={() => setTab(k)} aria-pressed={tab === k} data-sd-model-tab={k}><Ic n={icon} />{label}</button>;
  const fmtCell = (v: any) => (v == null ? "–" : typeof v === "number" ? v.toLocaleString(undefined, { maximumFractionDigits: 3 }) : String(v));

  const rowsTable = top && top.rows.length > 0 ? (
    <div className="sd-card" style={{ overflow: "hidden" }} data-sd-top-rows="">
      <div className="sd-cardh"><b>Highest {cal?.kind === "number" ? "prediction" : "chance"} first</b><span className="sd-chip">{top.rows.length} of {top.of.toLocaleString()} test rows</span>
        <span className="x">
          <button type="button" className="sd-tool sm" onClick={() => saveBlob(`${safeName(m?.name || "model")}-top.csv`, toCsv(Object.keys(top.rows[0]), top.rows))}><Ic n="dl" />Export</button>
          {!page && <button type="button" className="sd-tool sm" onClick={() => onAsk(`Who is most likely to have ${target} = ${positive || "yes"}? Show the list`)} disabled={busy}><Ic n="users" />Every row</button>}
        </span>
      </div>
      <div className="sd-tw">
        <table className="sd-t">
          <thead><tr><th>{top.id_label}</th>{cal?.kind === "number" ? <><th className="r">Predicted</th><th className="r">Really</th></> : <><th className="r">Chance</th><th>Really happened</th></>}{top.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
          <tbody>{top.rows.slice(0, tab === "rows" ? 25 : 6).map((x, i) => (
            <tr key={i}><td className="sd-mono" style={{ fontSize: 13 }}>{fmtCell(x.id)}</td>
              {cal?.kind === "number" ? <><td className="num">{fmtCell(x.predicted)}</td><td className="num">{fmtCell(x.actual)}</td></>
                : <><td className="num">{x.chance}%</td><td>{x.happened ? <span className="sd-chip good"><span className="sd-dot good" />Yes</span> : <span className="sd-chip">No</span>}</td></>}
              {top.columns.map((c) => <td key={c} className={typeof x[c] === "number" ? "num" : undefined}>{fmtCell(x[c])}</td>)}</tr>
          ))}</tbody>
        </table>
      </div>
      <div className="sdp-tfoot">These are held-out rows the model never saw while it learned, so “Really happened” shows whether it was right.</div>
    </div>
  ) : (
    <div className="sd-card sd-empty">The ranked list appears after this model is trained again with the Studio checks. <button type="button" className="sd-pill sm" onClick={() => void retrain()} disabled={working || m?.can_edit === false}>Train again</button></div>
  );

  const actions = (
    <>
        <a className="sd-pill" href={`/ml-studio/${id}`} target="_blank" rel="noreferrer"><Ic n="ext" />Open in ML Studio</a>
        {m?.can_edit !== false && <button type="button" className="sd-btnp" onClick={() => void scoreAll()} disabled={working || live || m?.status !== "ready"} data-sd-use-model="">{scoring?.state === "done" ? "Score again" : "Use this model"}</button>}
    </>
  );
  const tools = (
    <>
        {T("overview", "chip", "Overview")}{T("rows", "users", "Rows")}{T("reasons", "bar", "Reasons")}{T("accuracy", "trend", "Accuracy")}{T("code", "code", "Code")}
        <span className="sd-vr" />
        <button type="button" className="sd-tool" onClick={() => void retrain()} disabled={working || live || m?.can_edit === false} data-sd-retrain=""><Ic n="play" />Train again</button>
        {!page && <button type="button" className="sd-tool" onClick={() => onPrefill(`Change what the model predicts: `)}><Ic n="test" />Change definition</button>}
        {!page && <MenuButton icon="cal" label="Re-check" data="recheck">
          {(close) => <>
            <button type="button" onClick={() => { close(); onAsk("Re-train this model every Monday at 6am"); }}><span>Every Monday</span><small>trains again on the latest rows</small></button>
            <button type="button" onClick={() => { close(); onAsk("Re-train this model on the 1st of every month"); }}><span>Every month</span></button>
          </>}
        </MenuButton>}
        {page && <a className="sd-tool" href={`/ml-studio/${id}`}><Ic n="code" />Training details</a>}
    </>
  );
  const body = (
    <>
      {err && <div className="sd-err">{err}</div>}
      {!m && !err && <span className="c2-working"><span className="c2-spin" /> Opening the model…</span>}
      {m && m.status === "training" && <div className="sd-card sd-empty"><span className="c2-spin" />{(m.progress as any)?.message || "Training"} · the results appear here when it is tested.</div>}
      {m && m.status === "failed" && <div className="sd-err">{m.error || "Training failed."}</div>}
      {scoring?.state === "done" && <div className="sd-card" style={{ padding: "12px 16px", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }} data-sd-scored="">
        <Ic n="check" /><span>Scored {(scoring.rows || scoring.done || 0).toLocaleString()} rows · saved as “{scoring.version_name || "a new version"}” of {m?.source || "the source"}.</span>
        <a className="sd-pill sm" href="/data">Open in Data</a></div>}
      {scoring?.state === "failed" && <div className="sd-err">Scoring stopped: {scoring.error || "try again"}</div>}
      {m && m.status === "ready" && tab === "overview" && <>
        <div className="sd-kpis" data-sd-model-kpis="">
          {kpis.slice(0, 4).map((k) => <div key={k.label} className="sd-kpi"><span className="sd-lbl">{k.label}</span><span className="v">{k.display}</span>{k.note && <span className="n">{k.note}</span>}</div>)}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 14 }}>
          <div className="sd-card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}><b style={{ fontSize: 14.5 }}>What drives it</b><span className="sd-sp" /><span className="sd-lbl">share of effect</span></div>
            <div className="sd-bars">
              {drivers.slice(0, 6).map((d) => (
                <div key={d.label} className="sd-bar" title={d.note || undefined}><span className="l">{d.label}</span><span className="tr"><i style={{ width: `${Math.max(2, Math.min(100, d.value * 100 / Math.max(drivers[0]?.value || 1, 1e-9)))}%` }} /></span><span className="v">{d.display}</span></div>
              ))}
              {!drivers.length && <span className="sd-note">No drivers recorded for this model.</span>}
            </div>
          </div>
          <div className="sd-card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}><b style={{ fontSize: 14.5 }}>Was it right? Predicted vs real</b><span className="sd-sp" />
              <span className="sd-proof"><span className="sd-dot" style={{ background: "rgb(var(--color-border-strong))" }} />Predicted</span><span className="sd-proof"><span className="sd-dot blue" />Really {cal?.kind === "binary" ? positive || "happened" : ""}</span></div>
            {cal ? <Calibration bands={cal.bands} kind={cal.kind} /> : <div className="sd-note">This check appears after the model is trained again.</div>}
            <span className="sd-note">On the held-out rows: each band groups rows by what the model predicted; the blue bar is what really happened.</span>
          </div>
        </div>
        {rowsTable}
      </>}
      {m && m.status === "ready" && tab === "rows" && rowsTable}
      {m && m.status === "ready" && tab === "reasons" && (
        <div className="sd-card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          <b style={{ fontSize: 14.5 }}>Every column the model uses, by how much it moves {target}</b>
          <div className="sd-bars">{drivers.map((d) => <div key={d.label} className="sd-bar"><span className="l" title={d.label}>{d.label}</span><span className="tr"><i style={{ width: `${Math.max(2, d.value * 100 / Math.max(drivers[0]?.value || 1, 1e-9))}%` }} /></span><span className="v">{d.display}</span></div>)}</div>
          <div className="sd-note">{drivers.filter((d) => d.note).slice(0, 4).map((d) => `${d.label}: ${d.note}`).join(" · ")}</div>
          {(r.leaks || []).length > 0 && <div className="sd-note">Left out because they give the answer away: {(r.leaks || []).map((l: any) => String(l.column || l).slice(0, 40)).join(", ")}.</div>}
        </div>
      )}
      {m && m.status === "ready" && tab === "accuracy" && <>
        <div className="sd-card" style={{ overflow: "hidden" }}>
          <div className="sd-cardh"><b>Models compared on rows they never saw</b><span className="sd-chip">{r.metric || "score"}</span></div>
          <table className="sd-t"><thead><tr><th>Model</th><th className="r">While tuning</th><th className="r">Held-out test</th><th /></tr></thead>
            <tbody>{board.map((x) => <tr key={x.algorithm}><td>{x.algorithm}</td><td className="num">{x.score != null ? x.score.toFixed(3) : "–"}</td><td className="num">{x.test_score != null ? x.test_score.toFixed(3) : "–"}</td>
              <td>{x.best ? <span className="sd-badge">Chosen</span> : x.baseline ? <span className="sd-chip">Baseline</span> : null}</td></tr>)}</tbody></table>
          <div className="sdp-tfoot">{r.split}</div>
        </div>
        {cal && <div className="sd-card" style={{ padding: 16 }}><b style={{ fontSize: 14.5 }}>Predicted against real, by band</b>
          <table className="sd-t" style={{ marginTop: 10 }}><thead><tr><th>Band</th><th className="r">Rows</th><th className="r">Predicted</th><th className="r">Really</th></tr></thead>
            <tbody>{cal.bands.map((b) => <tr key={b.band}><td className="sd-mono">{b.band}</td><td className="num">{b.n.toLocaleString()}</td><td className="num">{b.predicted ?? "–"}{cal.kind === "binary" && b.predicted != null ? "%" : ""}</td><td className="num">{b.actual ?? "–"}{cal.kind === "binary" && b.actual != null ? "%" : ""}</td></tr>)}</tbody></table></div>}
        {(r.warnings || []).length > 0 && <div className="sd-note">{(r.warnings || []).join(" ")}</div>}
      </>}
      {m && m.status === "ready" && tab === "code" && <pre className="sd-code" style={{ maxHeight: "none" }} data-sd-model-code="">{r.code || "No code recorded for this model."}</pre>}
    </>
  );
  if (page && err && !m) {
    return (
      <ListPage data="model" crumbs={[{ label: "Models", to: "/ml-models" }, { label: "Model" }]}>
        <PageHead title="Model" />
        <div className="sd-err">{err}</div>
        <div><a className="sd-pill" href="/ml-models">See all models</a></div>
      </ListPage>
    );
  }
  if (page) {
    return (
      <ListPage data="model" crumbs={[{ label: "Models", to: "/ml-models" }, { label: m?.name || "Model" }]}>
        <PageHead title={m?.name || "Model"} chips={<>
          {m && <span className="sd-chip sd-mono" style={{ fontSize: 11.5 }}>v{m.version}</span>}
          {m && <span className={`sd-chip ${m.status === "ready" ? "good" : m.status === "failed" ? "bad" : ""}`}><span className={`sd-dot ${m.status === "ready" ? "good" : m.status === "failed" ? "bad" : "blue"}`} />{m.status === "ready" ? "Ready" : m.status === "failed" ? "Failed" : "Training"}</span>}
        </>}
          sub={m ? [r.label?.kind === "binary" ? "Yes / no" : r.kind === "number" ? "A number" : r.kind === "multiclass" ? "A category" : m.problem_type, r.winner, m.rows ? `trained on ${m.rows.toLocaleString()} rows of ${m.source || "your data"}` : m.source, status].filter(Boolean).join(" · ") : undefined}
          actions={actions} />
        <div className="sd-tb" style={{ borderRadius: 12, border: "1px solid rgb(var(--color-border))" }}>{tools}</div>
        {body}
      </ListPage>
    );
  }
  return (
    <StudioFrame kind="model" tabs={frame!.tabs} addMenu={frame!.addMenu} onClose={frame!.onClose} status={status} actions={actions} tools={tools}>
      {body}
    </StudioFrame>
  );
}
