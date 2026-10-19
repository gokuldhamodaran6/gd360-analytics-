// 2026-10-14 (R46): one turn - the person's bubble, then GD360's answer: "Worked for N seconds ›", the prose,
// the trust chips (only what was verified), sources, the picture, artifact cards, confirm cards.
import { useEffect, useState } from "react";
import { projectsApi, type ProjectRun } from "../api/projects";
import { downloadTurnList, type Artifact, type Chip, type ReportLength, type ReportStepsConfirm, type TeamConfirm, type Turn as TurnT } from "../api/v2";
import { FollowupCheck } from "../components/QuestionCheck";
import { layoutSql } from "../project/RunPanels";
import { DataAnswer } from "./DataAnswer";
import { GuidedSteps } from "./GuidedSteps";
import { docsApi } from "../api/docs";
import "../doc/doc.css";
import { BrandMark } from "../components/Brand";

function useElapsed(turn: TurnT, live?: boolean): number {
  const working = turn.status === "working" || !!live;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!working) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [working]);
  if (turn.elapsed_s != null && !working) return Math.max(0, Math.round(turn.elapsed_s));
  // R57: the server writes UTC without a zone - read as local time it started hours ahead and the timer sat at 0 s
  const iso = String(turn.created_at || "");
  const start = new Date(/Z$|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`).getTime();
  if (!working && turn.finished_at) {
    const end = new Date(turn.finished_at.endsWith("Z") ? turn.finished_at : `${turn.finished_at}Z`).getTime();
    const begin = new Date(turn.created_at.endsWith("Z") || /[+-]\d\d:?\d\d$/.test(turn.created_at) ? turn.created_at : `${turn.created_at}Z`).getTime();
    if (Number.isFinite(end - begin)) return Math.max(0, Math.round((end - begin) / 1000));
  }
  return Math.max(0, Math.round((now - start) / 1000));
}

export function Chips({ chips }: { chips: Chip[] }) {
  if (!chips?.length) return null;
  return (
    <div className="c2-chips" data-c2-chips="">
      {chips.map((c) => (
        <span key={c.key} className={`c2-chip ${c.ok ? "ok" : c.key === "numbers" || c.key === "raw_error" ? "bad" : "warn"}`} title={c.detail || undefined} data-chip={c.key}>
          {c.ok ? "✓" : "!"} {c.label}
        </span>
      ))}
    </div>
  );
}

function Trail({ turn, open }: { turn: TurnT; open: boolean }) {
  if (!open) return null;
  const items = turn.trail || [];
  return (
    <div className="c2-trail" data-c2-trail="">
      {items.length === 0 && <span>Working…</span>}
      {items.map((t, i) => (
        <div key={i}>
          <span>{t.label}{t.status && t.status !== "done" ? ` · ${t.status}` : ""}{t.ms ? ` · ${(t.ms / 1000).toFixed(1)} s` : ""}</span>
          {t.sql && <pre>{layoutSql(t.sql)}</pre>}
        </div>
      ))}
    </div>
  );
}

const ART_ICON: Record<string, string> = { dashboard: "▦", document: "▤", automation: "⚡", model: "◎", space: "▣", analysis: "◔" };

/** [n] citation markers become small numbered chips. */
export function Cited({ text }: { text: string }) {
  const parts = text.split(/(\[\d+\])/g);
  return <>{parts.map((p, i) => { const m = /^\[(\d+)\]$/.exec(p); return m ? <sup key={i} className="c2-cite">{m[1]}</sup> : <span key={i}>{p}</span>; })}</>;
}

/** The first sentence in bold, the rest plain - the one-sentence answer pattern. */
export function Lead({ text }: { text: string }) {
  const t = text.trim();
  // R50: "Done. Retention pulse now uses ..." / "On it. Confirm below to ..." - the opener and the sentence after it are one bold line
  const opener = /^((?:Done|On it|OK|Got it)[.!]\s+.+?[.!?])(\s+[\s\S]*)?$/.exec(t);
  const m = opener || /^(.+?[.!?])(\s+[\s\S]*)?$/.exec(t);
  if (!m) return <p className="prose">{text}</p>;
  return <p className="prose"><b>{m[1]}</b>{m[2] || ""}</p>;
}

export function ArtifactCard({ a, onOpen }: { a: Artifact; onOpen?: () => void }) {
  const title = a.name || a.title || "Open";
  const meta = a.type === "dashboard" ? (a.live ? `Live · ${a.live.label}` : "Dashboard · live on your data")
    : a.type === "document" ? `Document${a.words ? ` · ${a.words} words` : ""}`
    : a.type === "model" ? `Model${a.score ? ` · ${a.score} on held-out rows` : ""}`
    : a.type === "space" ? `Space${a.rules?.length ? ` · ${a.rules.length} data rule${a.rules.length !== 1 ? "s" : ""}` : ""}`
    : a.type === "analysis" ? `Analysis${a.figures ? ` · ${a.figures} figure${a.figures !== 1 ? "s" : ""}` : ""}${a.scored ? ` · scored ${a.scored.toLocaleString()} rows` : ""}`
    : `Automation${a.next_run_at ? ` · next ${new Date(a.next_run_at).toLocaleString()}` : ""}`;
  const inner = (
    <>
      <span className="ic" aria-hidden="true">{ART_ICON[a.type] || "▣"}</span>
      <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}><span className="t">{title}</span><span className="m">{meta}</span></span>
      <span style={{ marginLeft: "auto", color: "rgb(var(--color-muted))", fontSize: 13 }}>{a.type === "dashboard" || a.type === "document" || a.type === "analysis" ? "Open on canvas ›" : "Open ›"}</span>
    </>
  );
  if (a.type === "automation" || a.type === "model" || a.type === "space") return <a className="c2-art" href={a.url || "#"} data-c2-artifact={a.type}>{inner}</a>;
  return <button type="button" className="c2-art" onClick={onOpen} data-c2-artifact={a.type}>{inner}</button>;
}

export function TeamCard({ c, turn, busy, onDecide }: { c: TeamConfirm; turn: TurnT; busy: boolean; onDecide: (approve: boolean) => void }) {
  return (
    <div className="c2-card" data-c2-confirm="team">
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ width: 34, height: 34, borderRadius: 10, background: "rgb(var(--color-tint))", color: "rgb(var(--color-primary))", display: "grid", placeItems: "center" }}>▣</span>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span style={{ fontSize: 15, fontWeight: 600 }}>{c.body.name}</span>
          <span style={{ fontSize: 12.5, color: "rgb(var(--color-muted))" }}>{c.members.length} member{c.members.length !== 1 ? "s" : ""} · {c.sources.length} source{c.sources.length !== 1 ? "s" : ""} · {c.hidden.length + c.rows.length} data rule{c.hidden.length + c.rows.length !== 1 ? "s" : ""}</span>
        </div>
      </div>
      <div>
        <div className="c2-row"><span>Members</span><span>{c.members.map((m) => `${m.name} (${m.role})`).join(", ") || "only you"}{c.to_invite.length ? ` · to invite: ${c.to_invite.join(", ")}` : ""}</span></div>
        <div className="c2-row"><span>Sources</span><span>{c.sources.map((s) => s.name).join(", ") || "none"}</span></div>
        <div className="c2-row"><span>Hidden</span><span>{c.hidden.length ? c.hidden.map((h) => `${h.column} (${h.source})`).join(", ") : "nothing hidden"}</span></div>
        {c.rows.length > 0 && <div className="c2-row"><span>Rows</span><span>{c.rows.map((r) => `${r.column} limited to ${r.values.join(", ")} on ${r.source} for ${r.role}s`).join("; ")}</span></div>}
        <div className="c2-row"><span>Applies to</span><span style={{ color: "rgb(var(--color-muted))" }}>{c.limits.join(" ")}</span></div>
        {c.shares_conversation && <div className="c2-row"><span>Shares</span><span>This conversation moves into the team's Space</span></div>}
        {c.note && <div className="c2-row"><span>Note</span><span>{c.note}</span></div>}
      </div>
      {turn.error && <div className="c2-err">{turn.error}</div>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" className="c2-nx dark" disabled={busy} onClick={() => onDecide(true)} data-c2-confirm-yes="">Create the team</button>
        <button type="button" className="c2-nx ghost" disabled={busy} onClick={() => onDecide(false)}>Cancel</button>
      </div>
    </div>
  );
}

export function ModelSummary({ turn }: { turn: TurnT }) {
  const m = turn.model_summary;
  if (!m) return null;
  return (
    <div className="c2-card" data-c2-model="">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
        <div className="c2-meter"><span>Held-out {m.metric}</span><span className="c2-mono" style={{ fontSize: 22, fontWeight: 600, color: "rgb(var(--color-text))" }}>{m.test_score != null ? (Math.abs(m.test_score) < 10 ? m.test_score.toFixed(3) : m.test_score.toLocaleString()) : "—"}</span></div>
        {m.baseline?.score != null && <div className="c2-meter"><span>{m.baseline.name || "Baseline"}</span><span className="c2-mono" style={{ fontSize: 22, fontWeight: 600, color: "rgb(var(--color-text))" }}>{Math.abs(m.baseline.score) < 10 ? m.baseline.score.toFixed(3) : m.baseline.score.toLocaleString()}</span></div>}
        {m.rows != null && <div className="c2-meter"><span>Rows learned from</span><span className="c2-mono" style={{ fontSize: 22, fontWeight: 600, color: "rgb(var(--color-text))" }}>{Number(m.rows).toLocaleString()}</span></div>}
      </div>
      {m.drivers.length > 0 && <div style={{ fontSize: 13.5, color: "rgb(var(--color-secondary))" }}><b style={{ color: "rgb(var(--color-text))" }}>Drivers:</b> {m.drivers.join(", ")}</div>}
      {m.leaks.length > 0 && <div style={{ fontSize: 13.5, color: "rgb(var(--color-secondary))" }}><b style={{ color: "rgb(var(--color-text))" }}>Removed as leaks:</b> {m.leaks.join(", ")}</div>}
    </div>
  );
}

const ACT_ICON = {
  bell: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10 21h4" /></svg>,
  clock: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>,
  grid: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></svg>,
  chart: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 19l5-7 4 4 7-9M4 5v14h16" /></svg>,
};

/** R51 (board 05): the document a turn wrote - its page, its size, Word / PDF / shorter. */
export function DocCard({ a, turn, onOpen, onAsk }: { a: Artifact; turn: TurnT; onOpen: () => void; onAsk: (q: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const at = turn.finished_at ? new Date(/Z$/.test(turn.finished_at) ? turn.finished_at : `${turn.finished_at}Z`) : null;
  const mins = at ? (Date.now() - at.getTime()) / 60000 : 0;
  const ago = !at || Number.isNaN(at.getTime()) ? "" : mins < 1.5 ? "Just now" : mins < 60 ? `${Math.round(mins)} min ago` : at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const dl = async (kind: "docx" | "pdf") => { if (!a.doc_id) return; setBusy(kind); try { await docsApi.download(a.doc_id, kind, a.title); } catch { /* the card stays usable */ } finally { setBusy(null); } };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }} data-c2-doc-card="">
      <button type="button" className="c2-doccard" onClick={onOpen} data-c2-artifact="document">
        <span className="pg" aria-hidden="true"><span /><span style={{ width: "90%" }} /><span style={{ width: "85%" }} /><span style={{ width: "70%" }} /></span>
        <span style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
          <span className="t">{a.title || "Document"}</span>
          <span className="m">Document · {a.pages || 1} page{(a.pages || 1) !== 1 ? "s" : ""} · {a.figures || 0} figure{(a.figures || 0) !== 1 ? "s" : ""}</span>
          {ago && <span className="m">{ago}</span>}
        </span>
        <span style={{ marginLeft: "auto", color: "rgb(var(--color-muted))", fontSize: 13, whiteSpace: "nowrap" }}>Open ›</span>
      </button>
      <div className="c2-next">
        <button type="button" className="c2-btn" onClick={() => void dl("docx")} disabled={!!busy} data-c2-doc-word="">{busy === "docx" ? "Building…" : "Download Word"}</button>
        <button type="button" className="c2-btn" onClick={() => void dl("pdf")} disabled={!!busy} data-c2-doc-pdf="">{busy === "pdf" ? "Building…" : "Download PDF"}</button>
        <button type="button" className="c2-btn" onClick={() => onAsk("make the document shorter")} data-c2-doc-shorter="">Make it shorter</button>
      </div>
    </div>
  );
}

/** R57: the steps a detailed report needs - added and run only after "Add them and write". */
function ReportStepsCard({ c, busy, onDecide }: { c: ReportStepsConfirm; busy: boolean; onDecide: (approve: boolean) => void }) {
  return (
    <div className="c2-act" data-c2-confirm="report_steps">
      <div className="h"><span className="ic">{ACT_ICON.chart}</span><span style={{ minWidth: 0 }}>{c.steps.length} step{c.steps.length === 1 ? "" : "s"} to add</span><span className="t">Not run yet</span></div>
      <ol className="c2-rsteps" data-c2-report-steps="">
        {c.steps.map((x, i) => (
          <li key={i}><em>{c.have + i + 1}</em><span><b>{x.instruction.replace(/^./, (ch) => ch.toUpperCase())}</b>{x.why ? <small>{x.why}</small> : null}</span></li>
        ))}
      </ol>
      <div className="row">
        <button type="button" className="c2-btn pri" disabled={busy} onClick={() => onDecide(true)} data-c2-report-add="">Add them and write</button>
        <button type="button" className="c2-btn" disabled={busy} onClick={() => onDecide(false)} data-c2-report-skip="">Write without them</button>
      </div>
    </div>
  );
}

const LENGTHS: { k: ReportLength; l: string; d: string }[] = [
  { k: "brief", l: "Brief", d: "1 page" }, { k: "standard", l: "Standard", d: "3–4" }, { k: "detailed", l: "Detailed", d: "8–12" },
];

/** R57: how long a report is - Brief, Standard or Detailed. Picking another writes it again at that length. */
export function LengthSeg({ value, onPick, disabled }: { value: ReportLength; onPick: (l: ReportLength) => void; disabled?: boolean }) {
  return (
    <div className="c2-lenwrap" data-c2-length={value}>
      <span className="c2-lenlab">How long should it be?</span>
      <span className="c2-seg" role="radiogroup" aria-label="Report length">
        {LENGTHS.map((o) => (
          <button key={o.k} type="button" role="radio" aria-checked={value === o.k} className={value === o.k ? "on" : ""} disabled={disabled || value === o.k}
            onClick={() => onPick(o.k)} data-c2-length-opt={o.k} title={`${o.l}: ${o.d}${o.k === "brief" ? "" : " pages"}`}>{o.l} · {o.d}</button>
        ))}
      </span>
    </div>
  );
}

/** R57: a Guided analysis in the thread - where the steps are, in words; the numbers are on the canvas. */
function guidedLine(run: ProjectRun | null | undefined, turn: TurnT): { text: string; live: boolean } {
  const steps = (run?.steps || []).filter((s) => s.status !== "skipped");
  const n = steps.length;
  if (!run || run.status === "planning") return { text: "Planning the steps", live: true };
  const running = steps.findIndex((s) => s.status === "running");
  if (running >= 0) return { text: `Running step ${running + 1} of ${n}`, live: true };
  if (run.status === "running" || run.busy) return { text: "Writing the answer from the steps", live: true };
  if (run.status === "done") {
    const ok = steps.filter((s) => s.approved).length;
    return { text: `${n} step${n === 1 ? "" : "s"} · ${ok === n ? "all checked by you" : ok ? `${ok} checked by you` : "done"}`, live: false };
  }
  const ready = steps.findIndex((s) => s.status === "done" && !s.approved);
  if (ready >= 0) return { text: `Step ${ready + 1} of ${n} ready · waiting for you`, live: false };
  void turn;
  return { text: `${steps.filter((s) => s.status === "done").length} of ${n} steps done · waiting for you`, live: false };
}

function GuidedProse({ run, sources, onOpen }: { run: ProjectRun | null | undefined; sources: string[]; onOpen?: () => void }) {
  const steps = (run?.steps || []).filter((s) => s.status !== "skipped");
  const src = sources.length ? sources.slice(0, 2).join(" and ") : "your data";
  if (!run || run.status === "planning") {
    return <p className="prose" data-c2-guided-text="planning">I'm planning the steps on <b>{src}</b>. Step 1 runs as soon as the plan is ready. You check its numbers before I go on.</p>;
  }
  if (run.status === "done" || run.status === "failed") return null;
  const running = steps.findIndex((s) => s.status === "running");
  if (running >= 0) return <p className="prose" data-c2-guided-text="running">Running step {running + 1}: {steps[running].title}…</p>;
  const ready = steps.findIndex((s) => s.status === "done" && !s.approved);
  const left = steps.filter((s) => s.status !== "done").length;
  if (ready < 0) return null;
  const s = steps[ready];
  return (
    <>
      <p className="prose" data-c2-guided-text="ready">
        Step {ready + 1} is done: <b>{s.title}</b>{s.rows_returned != null ? ` (${s.rows_returned.toLocaleString()} row${s.rows_returned === 1 ? "" : "s"})` : ""}.
        {" "}Check its numbers on the right. {left === 1 ? "If they look right, I'll run the last step." : left ? `If they look right, I'll run the other ${left} steps.` : "If they look right, I'll write the answer."}
      </p>
      {onOpen && <div className="c2-next"><button type="button" className="c2-nx sm" onClick={onOpen} data-c2-open-steps="">Open the steps</button></div>}
    </>
  );
}

/** R50 (board 06): an alert or a schedule, exactly as it will run - nothing runs before Confirm. */
// 2026-10-17 (R52): "the 135 high-risk customers as a list" - a table of the tier with the signals each row trips,
// Excel and CSV of every row. Nothing is recomputed; the rows were scored when the analysis ran.
const fmtCell = (v: unknown) => typeof v === "number" ? (Number.isInteger(v) ? v.toLocaleString("en-US") : v.toLocaleString("en-US", { maximumFractionDigits: 3 })) : Array.isArray(v) ? v.join(" · ") : String(v ?? "");
export function ListCard({ turn, conversationId }: { turn: TurnT; conversationId: string }) {
  const l = turn.list!;
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const cols = l.columns;
  const rows = all ? l.rows : l.rows.slice(0, 8);
  const dl = async (k: "xlsx" | "csv") => { setBusy(k); try { await downloadTurnList(conversationId, turn.id, k, l.title); } finally { setBusy(null); } };
  const head = (c: string) => c === "id" ? l.id_label : c === "score" ? "Score" : c === "tier" ? "Tier" : c.charAt(0).toUpperCase() + c.slice(1);
  return (
    <div className="c2-card c2-list" data-c2-list="">
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 15, fontWeight: 600 }}>{l.title}</span>
          <span style={{ fontSize: 12.5, color: "rgb(var(--color-muted))" }}>{l.total.toLocaleString("en-US")} rows · {l.rule} · highest score first</span>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button type="button" className="c2-nx sm dark" disabled={!!busy || !l.rows.length} onClick={() => void dl("xlsx")} data-c2-list-xlsx="">{busy === "xlsx" ? "Preparing…" : "Excel"}</button>
          <button type="button" className="c2-nx sm" disabled={!!busy || !l.rows.length} onClick={() => void dl("csv")} data-c2-list-csv="">CSV</button>
        </div>
      </div>
      {l.restricted && <span style={{ fontSize: 12.5, color: "rgb(var(--color-warning))" }}>{l.restricted}</span>}
      {rows.length > 0 && (
        <div className="c2-list-scroll" style={{ maxHeight: all ? 420 : undefined }}>
          <table className="c2-list-t">
            <thead><tr>{cols.map((c) => <th key={c} className={c === "score" ? "num" : undefined}>{head(c)}</th>)}<th>Why</th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.id}-${i}`}>
                  {cols.map((c) => <td key={c} className={c === "score" || typeof r[c] === "number" ? "num" : undefined}>{c === "score" ? Number(r[c]).toFixed(2) : fmtCell(r[c])}</td>)}
                  <td className="why">{(r.signals || []).join(" · ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {l.rows.length > 8 && <button type="button" className="c2-link" style={{ alignSelf: "flex-start", background: "none", border: 0, padding: 0, cursor: "pointer" }} onClick={() => setAll((a) => !a)} data-c2-list-all="">
        {all ? "Show fewer" : `Show all ${l.rows.length.toLocaleString("en-US")}${l.total > l.rows.length ? ` of ${l.total.toLocaleString("en-US")} (every row is in the Excel)` : ""}`}</button>}
    </div>
  );
}

// "What if churn fell by a quarter in the low-usage band?" - before and after, and the assumptions, labelled as such.
export function WhatIfCard({ turn }: { turn: TurnT }) {
  const w = turn.whatif!;
  const pct = (v: number) => `${v.toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;
  const n = (v: number) => v.toLocaleString("en-US");
  const Row = ({ k, a, b }: { k: string; a: string; b: string }) => (
    <div className="c2-wi-r"><span>{k}</span><span className="num">{a}</span><span className="num">{b}</span></div>
  );
  return (
    <div className="c2-card c2-wi" data-c2-whatif="">
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ fontSize: 15, fontWeight: 600 }}>{w.noun.charAt(0).toUpperCase() + w.noun.slice(1)} down {w.change.label.replace(/^by /, "by ")}: {w.group.charAt(0).toUpperCase() + w.group.slice(1)}</span>
        <span style={{ fontSize: 12.5, color: "rgb(var(--color-muted))" }}>{n(w.group_n)} {w.entities} in the group · about {n(w.saved)} fewer</span>
      </div>
      <div className="c2-wi-t">
        <div className="c2-wi-r h"><span /><span>Today</span><span>If it happened</span></div>
        <Row k={`${w.noun.charAt(0).toUpperCase() + w.noun.slice(1)} rate in the group`} a={pct(w.before.group_rate)} b={pct(w.after.group_rate)} />
        <Row k={`${w.entities.charAt(0).toUpperCase() + w.entities.slice(1)} lost in the group`} a={n(w.before.group_count)} b={n(w.after.group_count)} />
        <Row k={`Overall ${w.noun}`} a={pct(w.before.overall_rate)} b={pct(w.after.overall_rate)} />
      </div>
      <div className="c2-wi-as" data-c2-assumptions="">
        <span className="c2-eb">Assumptions, not findings</span>
        <ul>{w.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
      </div>
    </div>
  );
}

export function ConfirmCard({ turn, busy, onDecide, onRevise }: { turn: TurnT; busy: boolean; onDecide: (approve: boolean) => void; onRevise?: (edits: Record<string, unknown>) => Promise<void> | void }) {
  const c = turn.confirm;
  const [editing, setEditing] = useState(false);
  const [line, setLine] = useState<string>(() => (c && c.kind === "automation" && c.threshold?.value != null ? String(c.threshold.value) : ""));
  if (!c) return null;
  if (c.kind === "team") return <TeamCard c={c} turn={turn} busy={busy} onDecide={onDecide} />;
  if (c.kind === "report_steps") return <ReportStepsCard c={c} busy={busy} onDecide={onDecide} />;
  const s = c.sentence || ({} as any);
  const body = c.body || {};
  const trig = body.trigger || {};
  const alert = trig.type === "threshold";
  const unit = c.threshold?.unit || "";
  return (
    <div className="c2-act" data-c2-confirm="automation" data-c2-alert={alert ? "" : undefined}>
      <div className="h">
        <span className="ic">{alert ? ACT_ICON.bell : ACT_ICON.clock}</span>
        <span style={{ minWidth: 0 }}>{alert ? "Alert" : "Schedule"} · {body.name || "Automation"}</span>
        <span className="t">Not yet running</span>
      </div>
      <div className="kv">
        <span className="k">Watches</span><span className="v" data-c2-watches="">{c.watches || (c.watch ? `“${c.watch.question}”` : s.do)}</span>
        <span className="k">When</span><span className="v">{s.when}</span>
        {!alert && <><span className="k">Does</span><span className="v">{s.do}</span></>}
        <span className="k">Sends</span><span className="v">{c.sends || s.tell}{c.needs?.includes("slack") ? " · Slack can be added on the automation page after saving" : ""}</span>
        {c.first_check?.text && <><span className="k">First check</span><span className="v" data-c2-first-check="">Now · {c.first_check.text}</span></>}
        {c.note && <><span className="k">Note</span><span className="v">{c.note}</span></>}
      </div>
      {turn.error && <div className="c2-err">{turn.error}</div>}
      {editing && alert && (
        <form className="c2-line" onSubmit={async (e) => { e.preventDefault(); await onRevise?.({ value: line }); setEditing(false); }} data-c2-line-form="">
          <label htmlFor={`line-${turn.id}`}>Alert when it {trig.op === "below" ? "drops below" : "passes"}</label>
          <span className="in"><input id={`line-${turn.id}`} type="number" step="any" inputMode="decimal" value={line} onChange={(e) => setLine(e.target.value)} autoFocus />{unit && <span>{unit}</span>}</span>
          <button type="submit" className="c2-btn" disabled={busy || !line.trim()}>Update</button>
          <button type="button" className="c2-btn ghost" onClick={() => setEditing(false)}>Cancel</button>
        </form>
      )}
      <div className="row">
        <button type="button" className="c2-btn dark" disabled={busy} onClick={() => onDecide(true)} data-c2-confirm-yes="">Confirm</button>
        {alert && onRevise && !editing && <button type="button" className="c2-btn" disabled={busy} onClick={() => setEditing(true)} data-c2-change-line="">Change the threshold</button>}
        <button type="button" className="c2-btn" disabled={busy} onClick={() => onDecide(false)} data-c2-confirm-no="">Not now</button>
      </div>
    </div>
  );
}

function themeLabel(k?: string) { return k ? k.charAt(0).toUpperCase() + k.slice(1) : ""; }

/** R50 (board 06): what an edit changed - the new look, was / now, Undo. */
export function EditCard({ turn, onAsk, onOpen }: { turn: TurnT; onAsk: (q: string) => void; onOpen: () => void }) {
  const e = turn.edit;
  if (!e) return null;
  const a = e.after;
  const p = a.palette;
  const at = turn.finished_at ? new Date(/Z$/.test(turn.finished_at) ? turn.finished_at : `${turn.finished_at}Z`) : null;
  const was: string[] = [];
  if (e.before.name && e.before.name !== a.name) was.push(`was “${e.before.name}”`);
  if (e.before.theme !== a.theme || (e.before as any).accent !== a.accent) was.push(`theme ${themeLabel(e.before.theme)}${(e.before as any).accent ? " + colour" : ""} → ${a.theme_label}${a.accent ? ` + ${a.accent.toUpperCase()}` : ""}`);
  was.push(`${a.pages.length} pages`);
  return (
    <div className="c2-act" data-c2-edit-card="">
      <div className="h"><span className="ic">{ACT_ICON.grid}</span>{e.undo ? "Dashboard restored" : "Dashboard updated"}<span className="t">{at && !Number.isNaN(at.getTime()) ? at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }) : ""}</span></div>
      <div className="prev">
        <div className="mini" aria-hidden="true" style={{ background: p.bg }}>
          <span style={{ background: p.card }} /><span style={{ background: p.card }} /><span style={{ background: p.card }} />
          <span style={{ background: p.accent, gridColumn: "1 / 3" }} /><span style={{ background: p.card }} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
          <span style={{ fontSize: 16, fontWeight: 600 }} data-c2-edit-name="">{a.name}</span>
          <span style={{ fontSize: 13, color: "rgb(var(--color-muted))" }}>{was.join(" · ")}</span>
        </div>
        <button type="button" className="c2-linkbtn" onClick={onOpen}>View dashboard →</button>
      </div>
      {!e.undo && (
        <div className="row">
          <button type="button" className="c2-btn" onClick={() => onAsk("undo")} data-c2-undo="">Undo</button>
          {!a.accent && <button type="button" className="c2-btn" onClick={() => onAsk("use our brand colours instead")} data-c2-brand="">Use our brand colours instead</button>}
        </div>
      )}
    </div>
  );
}

/** R50 (board 06): a dashboard build - its pages, ticked as they are ready; the typo it understood. */
export function BuiltCard({ turn, onOpen }: { turn: TurnT; onOpen: () => void }) {
  const working = turn.status === "working";
  const b = turn.built;
  const pages = b?.pages || [];
  const steps = working ? (turn.trail || []).map((t) => t.label) : [];
  return (
    <div className="c2-act" data-c2-built="">
      <div className="h">
        <span className="ic">{ACT_ICON.chart}</span>
        <span style={{ minWidth: 0 }}>Dashboard{b ? ` · ${b.name}` : ""}</span>
        {(b?.typo || turn.normalized) && <span className="t">typo understood{b?.typo ? `: ${b.typo}` : ""}</span>}
      </div>
      <div className="tiles">
        {working && steps.map((l, i) => <div key={i} className={`tile ${i === 0 ? "now" : "wait"}`}>{l}{i === 0 ? " …" : ""}</div>)}
        {!working && pages.map((pg) => <div key={pg} className="tile done">{pg} <span aria-hidden="true">✓</span></div>)}
      </div>
      {!working && b && (
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span style={{ fontSize: 13, color: "rgb(var(--color-muted))" }}>{b.theme} theme · live on your data</span>
          <button type="button" className="c2-linkbtn" onClick={onOpen} data-c2-view-board="">View dashboard →</button>
        </div>
      )}
    </div>
  );
}

/** R56 (Studio): what the turn did, in one line - "Built 4 steps from Sales · 14 s". */
function workedLine(turn: TurnT, run: ProjectRun | null | undefined): string | null {
  if (turn.kind === "data" && turn.guided) return null;
  if (turn.kind === "data" && run?.status === "done") {
    const steps = (run.steps || []).length;
    const srcs = Array.from(new Set((run.steps || []).filter((s) => s.kind !== "combine").map((s) => s.source_name).filter(Boolean))) as string[];
    if (steps) return `Built ${steps} step${steps === 1 ? "" : "s"}${srcs.length ? ` from ${srcs.slice(0, 2).join(" and ")}${srcs.length > 2 ? ` +${srcs.length - 2}` : ""}` : ""}`;
  }
  if (turn.kind === "dashboard" && turn.built) return `Built ${turn.built.pages.length} page${turn.built.pages.length === 1 ? "" : "s"} · ${turn.built.name}`;
  if (turn.kind === "document") {
    const a = (turn.artifacts || []).find((x) => x.type === "document");
    if (a) return `Drafted ${a.words ? `${a.words.toLocaleString()} words` : "the document"}${a.figures ? ` · ${a.figures} chart${a.figures === 1 ? "" : "s"}` : ""}`;
  }
  if (turn.kind === "model" && turn.model_summary) {
    const m = turn.model_summary;
    return `Trained${m.rows ? ` on ${Number(m.rows).toLocaleString()} rows` : ""}, tested on rows it never saw`;
  }
  if (turn.kind === "analysis" && turn.analysis) return `Read ${turn.analysis.table.rows_used.toLocaleString()} ${turn.analysis.table.entities || "rows"} from ${turn.analysis.table.source}`;
  return null;
}

/** R58: an explanation of the answer on screen - what it shows, the points behind it, the takeaway. Written from the
 *  numbers already computed; "Explain in detail" asks for the longer version of the same card. */
function ExplainView({ turn, onMore, busy }: { turn: TurnT; onMore?: () => void; busy: boolean }) {
  const ex = turn.explain || {};
  const points = ((ex.points || []) as { text: string }[]).filter((p) => p && p.text);
  const detailed = points.length > 4 || /\bdetail/i.test(String(turn.question || ""));
  return (
    <div className="c2-xpl" data-c2-explain="">
      {ex.title && <span className="about">About {String(ex.title).replace(/^The /, "the ")}</span>}
      {ex.headline && <p className="h">{ex.headline}</p>}
      {points.length > 0 && <ul>{points.map((p, i) => <li key={i}>{p.text}</li>)}</ul>}
      {ex.takeaway && <p className="tk">{ex.takeaway}</p>}
      {!detailed && onMore && (
        <div className="c2-next"><button type="button" className="c2-nx sm" onClick={onMore} disabled={busy} data-c2-explain-more="">Explain in detail</button></div>
      )}
    </div>
  );
}

export function TurnView({
  turn, run, conversationId, onAsk, onOpenArtifact, onOpenMethod, onConfirm, onPickCheck, onRunChanged, onMakeDashboard, busy, onRevise, onCanvas = false, onOpenSteps, onLength, onExplainMore,
}: {
  turn: TurnT; run?: ProjectRun | null; conversationId: string; onAsk: (q: string) => void;
  onOpenArtifact: (a: Artifact, t: TurnT) => void; onOpenMethod: (t: TurnT) => void; onConfirm: (t: TurnT, approve: boolean) => void;
  onPickCheck: (q: string, kept?: string) => void; onRunChanged: (r: ProjectRun) => void; onMakeDashboard: (t: TurnT) => void; busy: boolean;
  onRevise?: (t: TurnT, edits: Record<string, unknown>) => Promise<void> | void;
  /** R56: this turn's steps are open on the canvas - the thread keeps the prose only */
  onCanvas?: boolean; onOpenSteps?: (t: TurnT) => void;
  /** R57: write this report again at another length */
  onLength?: (t: TurnT, length: ReportLength) => void;
  /** R58: the same card explained at length */
  onExplainMore?: (t: TurnT) => void;
}) {
  const [open, setOpen] = useState(false);
  // R58: the question card's × closes it (it used to do nothing)
  const [dismissed, setDismissed] = useState(false);
  const guided = turn.kind === "data" && !!turn.guided;
  const g = guided ? guidedLine(run, turn) : null;
  const secs = useElapsed(turn, !!g?.live && turn.status !== "done");
  const working = turn.status === "working" || !!g?.live;
  const isData = turn.kind === "data";
  const showRun = isData && run;
  const canDash = isData && run?.status === "done" && (run.result?.visuals || []).length > 0 && !(turn.placements || []).length;
  const line = !working && turn.status === "done" ? workedLine(turn, run) : null;
  const hasSteps = isData && run?.status === "done" && (run.steps || []).length > 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }} data-c2-turn={turn.kind} data-c2-status={turn.status} data-c2-turn-id={turn.id}>
      {turn.question && <div className="c2-u">{turn.question}</div>}
      <div className="c2-a">
        <div className="c2-who" aria-hidden="true"><BrandMark size={22} radius={6} />GD360</div>
        {(turn.kind !== "chat") && (
          <button type="button" className={`sd-st c2-wst${working ? " work" : ""}${turn.status === "failed" ? " bad" : ""}${open ? " open" : ""}`} onClick={() => setOpen((o) => !o)} data-c2-worked="" aria-expanded={open}>
            {working ? <span className="c2-spin" style={{ width: 13, height: 13 }} />
              : turn.status === "failed" ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
              : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7" /></svg>}
            <span className="lb">
              {g ? g.text : working && turn.kind === "document" && turn.report?.current ? turn.report.current
                : working ? `Working · ${secs} s` : line ? line : secs < 1 ? "Worked for under a second" : `Worked for ${secs} second${secs === 1 ? "" : "s"}`}
              {turn.budget_s && secs > turn.budget_s && !turn.timed_out && !working && (
                <span className="c2-over" data-c2-over="">{` · over the ${turn.budget_s} s target`}</span>
              )}
              {turn.mode === "analyst" && !working ? " · the Analyst" : ""}
            </span>
            {((!working && line) || g?.live || (working && turn.kind === "document" && turn.report?.current)) && <em>{secs < 1 ? "under a second" : secs < 90 ? `${secs} s` : `${Math.floor(secs / 60)} min ${secs % 60} s`}</em>}
          </button>
        )}
        {working && turn.budget_s && secs > turn.budget_s && !turn.timed_out && (
          <div className="c2-overline" data-c2-over="">
            <span>Taking longer than usual - most answers like this take under {turn.budget_s} s.</span>
            {turn.run_id && isData && (
              <button type="button" onClick={() => { void projectsApi.stop(turn.run_id!).then(() => projectsApi.run(turn.run_id!)).then(onRunChanged).catch(() => undefined); }} data-c2-stop="">Stop</button>
            )}
          </div>
        )}
        <Trail turn={turn} open={open} />
        {guided && run?.status !== "done" && <GuidedProse run={run} sources={Array.from(new Set((run?.steps || []).filter((x) => x.kind !== "combine").map((x) => x.source_name).filter(Boolean))) as string[]}
          onOpen={!onCanvas && onOpenSteps ? () => onOpenSteps(turn) : undefined} />}
        {turn.kind === "document" && turn.length && onLength && turn.status !== "failed" && (
          <LengthSeg value={turn.length} onPick={(l) => onLength(turn, l)} disabled={busy || working || turn.status === "confirm"} />
        )}
        {turn.status === "failed" && <div className="c2-err" data-c2-error="">{turn.error || "That didn't work. Ask it again."}</div>}
        {turn.kind === "check" && turn.check && turn.status === "needs_input" && (
          !dismissed ? <FollowupCheck check={turn.check} busy={busy} onClose={() => setDismissed(true)} onPick={onPickCheck} />
            : <p className="c2-settled" data-c2-settled="">Skipped - ask it again whenever you like.</p>
        )}
        {turn.kind === "check" && turn.status !== "needs_input" && turn.settled && (
          <p className="c2-settled" data-c2-settled="">Settled by your next message: “{turn.settled}”.</p>
        )}
        {turn.kind === "explain" && turn.explain && <ExplainView turn={turn} busy={busy} onMore={onExplainMore ? () => onExplainMore(turn) : undefined} />}
        {turn.text && !(turn.kind === "check") && !(turn.kind === "explain" && turn.explain) && (turn.kind === "analysis" || turn.kind === "dashboard" || turn.kind === "dashboard_edit" || turn.kind === "document" || turn.kind === "document_edit" || turn.kind === "automation" || turn.kind === "team" || turn.kind === "list" || turn.kind === "whatif" ? <Lead text={turn.text} />
          : turn.kind === "knowledge" ? <p className="prose"><Cited text={turn.text} /></p> : <p className="prose">{turn.text}</p>)}
        {turn.kind === "knowledge" && (turn.sources || []).length > 0 && (
          <div className="c2-srcs" data-c2-sources="">
            {(turn.sources || []).map((s, i) => (
              <a key={s.url} href={s.url} target="_blank" rel="noreferrer" className="c2-srcc"><span className="n">{s.n ?? i + 1}</span><span className="t">{s.title}</span><span className="d">{s.domain || s.url.replace(/^https?:\/\/(www\.)?/, "").split("/")[0]}</span></a>
            ))}
          </div>
        )}
        {turn.kind === "analysis" && turn.status === "needs_input" && turn.text && <div className="c2-next"><button type="button" className="c2-nx sm" onClick={() => onAsk(turn.question)}>Try again</button></div>}
        {showRun && <DataAnswer run={run!} onAsk={onAsk} compact={onCanvas} chips={turn.status === "done" ? <Chips chips={turn.chips} /> : null} />}
        {onCanvas && hasSteps && <p className="prose c2-onright" style={{ color: "rgb(var(--color-secondary))" }}>Every step is on the right. You can edit, rerun or remove any of them.</p>}
        {turn.kind === "guided" && run && turn.guided_project_id && (
          <GuidedSteps run={run} projectId={turn.guided_project_id} onChanged={onRunChanged} onAsk={onAsk} />
        )}
        {turn.kind === "guided" && !run && working && <span className="c2-working"><span className="c2-spin" /> Planning the steps…</span>}
        {turn.status === "confirm" && <ConfirmCard turn={turn} busy={busy} onDecide={(ok) => onConfirm(turn, ok)} onRevise={onRevise ? (e) => onRevise(turn, e) : undefined} />}
        {turn.kind === "model" && turn.status === "done" && <ModelSummary turn={turn} />}
        {turn.kind === "list" && turn.status === "done" && turn.list && <ListCard turn={turn} conversationId={conversationId} />}
        {turn.kind === "whatif" && turn.status === "done" && turn.whatif && <WhatIfCard turn={turn} />}
        {turn.timed_out && turn.status === "failed" && <div className="c2-next"><button type="button" className="c2-nx sm" onClick={() => onAsk(turn.question)} data-c2-retry="">Ask again</button></div>}
        {turn.kind === "dashboard_edit" && turn.status === "done" && turn.edit && (
          <EditCard turn={turn} onAsk={onAsk} onOpen={() => { const a = (turn.artifacts || [])[0]; if (a) onOpenArtifact({ ...a, refresh: false } as Artifact, turn); }} />
        )}
        {turn.kind === "dashboard" && (turn.built || (working && (turn.trail || []).length > 0)) && (
          <BuiltCard turn={turn} onOpen={() => { const a = (turn.artifacts || [])[0]; if (a) onOpenArtifact(a, turn); }} />
        )}
        {(turn.artifacts || []).filter((a) => a.type !== "list" && !(turn.kind === "dashboard_edit" && turn.edit) && !(turn.kind === "dashboard" && turn.built))
          .map((a) => (a.type === "document" && a.doc_id
            ? <DocCard key={a.id} a={a} turn={turn} onAsk={onAsk} onOpen={() => onOpenArtifact({ ...a, refresh: false } as Artifact, turn)} />
            : <ArtifactCard key={a.id} a={a} onOpen={() => onOpenArtifact(a, turn)} />))}
        {turn.status === "done" && !showRun && <Chips chips={turn.chips} />}
        {(turn.status === "done" && (isData || turn.kind === "guided") && run?.status === "done") && !onCanvas && (
          <div className="c2-next">
            {canDash && <button type="button" className="c2-nx sm" onClick={() => onMakeDashboard(turn)} data-c2-make-dashboard="">Make this a dashboard</button>}
            {(turn.placements || []).map((p) => (
              <button key={p.dashboard_id} type="button" className="c2-nx sm" onClick={() => onOpenArtifact({ type: "dashboard", id: p.dashboard_id, name: p.dashboard_name, url: `/dashboard-builder/${p.dashboard_id}`, page_id: p.page_id }, turn)}>Open “{p.dashboard_name}”</button>
            ))}
            {hasSteps && !onCanvas && onOpenSteps && <button type="button" className="c2-nx sm" onClick={() => onOpenSteps(turn)} data-c2-open-steps="">Open the steps</button>}
            {((turn.trail || []).some((t) => t.sql) || turn.mode === "analyst") && !hasSteps && <button type="button" className="c2-nx sm ghost" onClick={() => onOpenMethod(turn)}>How I worked it out</button>}
          </div>
        )}
      </div>
    </div>
  );
}
