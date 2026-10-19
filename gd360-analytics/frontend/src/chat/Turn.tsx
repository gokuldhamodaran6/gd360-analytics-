// 2026-10-14 (R46): one turn - the person's bubble, then GD360's answer: "Worked for N seconds ›", the prose,
// the trust chips (only what was verified), sources, the picture, artifact cards, confirm cards.
import { useEffect, useState } from "react";
import type { ProjectRun } from "../api/projects";
import { downloadTurnList, type Artifact, type Chip, type TeamConfirm, type Turn as TurnT } from "../api/v2";
import { FollowupCheck } from "../components/QuestionCheck";
import { layoutSql } from "../project/RunPanels";
import { DataAnswer } from "./DataAnswer";
import { GuidedSteps } from "./GuidedSteps";
import { docsApi } from "../api/docs";
import "../doc/doc.css";
import { BrandMark } from "../components/Brand";

function useElapsed(turn: TurnT): number {
  const working = turn.status === "working";
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!working) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [working]);
  if (turn.elapsed_s != null && !working) return Math.max(0, Math.round(turn.elapsed_s));
  const start = new Date(turn.created_at).getTime();
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

export function TurnView({
  turn, run, conversationId, onAsk, onOpenArtifact, onOpenMethod, onConfirm, onPickCheck, onRunChanged, onMakeDashboard, busy, onRevise,
}: {
  turn: TurnT; run?: ProjectRun | null; conversationId: string; onAsk: (q: string) => void;
  onOpenArtifact: (a: Artifact, t: TurnT) => void; onOpenMethod: (t: TurnT) => void; onConfirm: (t: TurnT, approve: boolean) => void;
  onPickCheck: (q: string, kept?: string) => void; onRunChanged: (r: ProjectRun) => void; onMakeDashboard: (t: TurnT) => void; busy: boolean;
  onRevise?: (t: TurnT, edits: Record<string, unknown>) => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const secs = useElapsed(turn);
  const working = turn.status === "working";
  const isData = turn.kind === "data";
  const showRun = isData && run;
  const canDash = isData && run?.status === "done" && (run.result?.visuals || []).length > 0 && !(turn.placements || []).length;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }} data-c2-turn={turn.kind} data-c2-status={turn.status} data-c2-turn-id={turn.id}>
      {turn.question && <div className="c2-u">{turn.question}</div>}
      <div className="c2-a">
        <div className="c2-who" aria-hidden="true"><BrandMark size={22} radius={6} />GD360</div>
        {(turn.kind !== "chat") && (
          <button type="button" className={`c2-w ${open ? "open" : ""}`} onClick={() => setOpen((o) => !o)} data-c2-worked="">
            <svg className="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M9 18l6-6-6-6" /></svg>
            {working ? <><span className="c2-spin" /> Working · {secs} s</> : secs < 1 ? "Worked for under a second" : `Worked for ${secs} second${secs === 1 ? "" : "s"}`}
            {turn.budget_s && secs > turn.budget_s && !turn.timed_out && (
              <span className="c2-over" data-c2-over="">{working ? ` · longer than usual (under ${turn.budget_s} s is the aim)` : ` · over the ${turn.budget_s} s target`}</span>
            )}
            {turn.mode === "analyst" && !working ? " · the Analyst" : ""}
          </button>
        )}
        <Trail turn={turn} open={open} />
        {turn.status === "failed" && <div className="c2-err" data-c2-error="">{turn.error || "That didn't work. Ask it again."}</div>}
        {turn.kind === "check" && turn.check && turn.status === "needs_input" && (
          <FollowupCheck check={turn.check} busy={busy} onClose={() => undefined} onPick={onPickCheck} />
        )}
        {turn.text && !(turn.kind === "check") && (turn.kind === "analysis" || turn.kind === "dashboard" || turn.kind === "dashboard_edit" || turn.kind === "document" || turn.kind === "document_edit" || turn.kind === "automation" || turn.kind === "team" || turn.kind === "list" || turn.kind === "whatif" ? <Lead text={turn.text} />
          : turn.kind === "knowledge" ? <p className="prose"><Cited text={turn.text} /></p> : <p className="prose">{turn.text}</p>)}
        {turn.kind === "knowledge" && (turn.sources || []).length > 0 && (
          <div className="c2-srcs" data-c2-sources="">
            {(turn.sources || []).map((s, i) => (
              <a key={s.url} href={s.url} target="_blank" rel="noreferrer" className="c2-srcc"><span className="n">{s.n ?? i + 1}</span><span className="t">{s.title}</span><span className="d">{s.domain || s.url.replace(/^https?:\/\/(www\.)?/, "").split("/")[0]}</span></a>
            ))}
          </div>
        )}
        {turn.kind === "analysis" && turn.status === "needs_input" && turn.text && <div className="c2-next"><button type="button" className="c2-nx sm" onClick={() => onAsk(turn.question)}>Try again</button></div>}
        {showRun && <DataAnswer run={run!} onAsk={onAsk} chips={turn.status === "done" ? <Chips chips={turn.chips} /> : null} />}
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
        {(turn.status === "done" && (isData || turn.kind === "guided") && run?.status === "done") && (
          <div className="c2-next">
            {canDash && <button type="button" className="c2-nx sm" onClick={() => onMakeDashboard(turn)} data-c2-make-dashboard="">Make this a dashboard</button>}
            {(turn.placements || []).map((p) => (
              <button key={p.dashboard_id} type="button" className="c2-nx sm" onClick={() => onOpenArtifact({ type: "dashboard", id: p.dashboard_id, name: p.dashboard_name, url: `/dashboard-builder/${p.dashboard_id}`, page_id: p.page_id }, turn)}>Open “{p.dashboard_name}”</button>
            ))}
            {((turn.trail || []).some((t) => t.sql) || turn.mode === "analyst") && <button type="button" className="c2-nx sm ghost" onClick={() => onOpenMethod(turn)}>How I worked it out</button>}
          </div>
        )}
      </div>
    </div>
  );
}
