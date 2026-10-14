// 2026-10-14 (R46): one turn - the person's bubble, then GD360's answer: "Worked for N seconds ›", the prose,
// the trust chips (only what was verified), sources, the picture, artifact cards, confirm cards.
import { useEffect, useState } from "react";
import type { ProjectRun } from "../api/projects";
import type { Artifact, Chip, Turn as TurnT } from "../api/v2";
import { FollowupCheck } from "../components/QuestionCheck";
import { layoutSql } from "../project/RunPanels";
import { DataAnswer } from "./DataAnswer";
import { GuidedSteps } from "./GuidedSteps";

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

const ART_ICON: Record<string, string> = { dashboard: "▦", document: "▤", automation: "⚡" };

export function ArtifactCard({ a, onOpen }: { a: Artifact; onOpen?: () => void }) {
  const title = a.name || a.title || "Open";
  const meta = a.type === "dashboard" ? (a.live ? `Live · ${a.live.label}` : "Dashboard · live on your data") : a.type === "document" ? `Document${a.words ? ` · ${a.words} words` : ""}` : `Automation${a.next_run_at ? ` · next ${new Date(a.next_run_at).toLocaleString()}` : ""}`;
  const inner = (
    <>
      <span className="ic" aria-hidden="true">{ART_ICON[a.type] || "▣"}</span>
      <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}><span className="t">{title}</span><span className="m">{meta}</span></span>
      <span style={{ marginLeft: "auto", color: "rgb(var(--color-muted))", fontSize: 13 }}>{a.type === "automation" ? "Open ›" : "Open on canvas ›"}</span>
    </>
  );
  if (a.type === "automation") return <a className="c2-art" href={a.url || `/automations/${a.id}`} data-c2-artifact={a.type}>{inner}</a>;
  return <button type="button" className="c2-art" onClick={onOpen} data-c2-artifact={a.type}>{inner}</button>;
}

export function ConfirmCard({ turn, busy, onDecide }: { turn: TurnT; busy: boolean; onDecide: (approve: boolean) => void }) {
  const c = turn.confirm;
  if (!c) return null;
  const s = c.sentence || ({} as any);
  const body = c.body || {};
  const trig = body.trigger || {};
  return (
    <div className="c2-card" data-c2-confirm="automation">
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ width: 34, height: 34, borderRadius: 10, background: "rgb(var(--color-warning-fill))", color: "rgb(var(--color-warning))", display: "grid", placeItems: "center" }}>⚡</span>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span style={{ fontSize: 15, fontWeight: 600 }}>{body.name || "Automation"}</span>
          <span style={{ fontSize: 12.5, color: "rgb(var(--color-muted))" }}>{trig.type === "threshold" ? "an alert" : "a schedule"} · nothing runs until you confirm</span>
        </div>
      </div>
      <div>
        <div className="c2-row"><span>When</span><span>{s.when}</span></div>
        {c.watch && <div className="c2-row"><span>Watching</span><span>“{c.watch.question}”</span></div>}
        <div className="c2-row"><span>Do</span><span>{s.do}</span></div>
        <div className="c2-row"><span>Tell</span><span>{s.tell}{c.needs?.includes("slack") ? " · Slack can be added on the automation page after saving" : ""}</span></div>
        {c.note && <div className="c2-row"><span>Note</span><span>{c.note}</span></div>}
      </div>
      {turn.error && <div className="c2-err">{turn.error}</div>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" className="c2-nx dark" disabled={busy} onClick={() => onDecide(true)} data-c2-confirm-yes="">Confirm and start</button>
        <button type="button" className="c2-nx ghost" disabled={busy} onClick={() => onDecide(false)}>Cancel</button>
      </div>
    </div>
  );
}

export function TurnView({
  turn, run, conversationId, onAsk, onOpenArtifact, onOpenMethod, onConfirm, onPickCheck, onRunChanged, onMakeDashboard, busy,
}: {
  turn: TurnT; run?: ProjectRun | null; conversationId: string; onAsk: (q: string) => void;
  onOpenArtifact: (a: Artifact, t: TurnT) => void; onOpenMethod: (t: TurnT) => void; onConfirm: (t: TurnT, approve: boolean) => void;
  onPickCheck: (q: string, kept?: string) => void; onRunChanged: (r: ProjectRun) => void; onMakeDashboard: (t: TurnT) => void; busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const secs = useElapsed(turn);
  const working = turn.status === "working";
  const isData = turn.kind === "data";
  const showRun = isData && run;
  const canDash = isData && run?.status === "done" && (run.result?.visuals || []).length > 0 && !(turn.placements || []).length;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }} data-c2-turn={turn.kind} data-c2-status={turn.status}>
      {turn.question && <div className="c2-u">{turn.question}</div>}
      <div className="c2-a">
        {(turn.kind !== "chat") && (
          <button type="button" className={`c2-w ${open ? "open" : ""}`} onClick={() => setOpen((o) => !o)} data-c2-worked="">
            <svg className="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M9 18l6-6-6-6" /></svg>
            {working ? <><span className="c2-spin" /> Working · {secs} s</> : secs < 1 ? "Worked for under a second" : `Worked for ${secs} second${secs === 1 ? "" : "s"}`}
            {turn.mode === "analyst" && !working ? " · the Analyst" : ""}
          </button>
        )}
        <Trail turn={turn} open={open} />
        {turn.status === "failed" && <div className="c2-err" data-c2-error="">{turn.error || "That didn't work. Ask it again."}</div>}
        {turn.kind === "check" && turn.check && turn.status === "needs_input" && (
          <FollowupCheck check={turn.check} busy={busy} onClose={() => undefined} onPick={onPickCheck} />
        )}
        {turn.text && !(turn.kind === "check") && <p className="prose">{turn.text}</p>}
        {turn.kind === "knowledge" && (turn.sources || []).length > 0 && (
          <div className="c2-src" data-c2-sources="">
            {(turn.sources || []).map((s, i) => (
              <a key={s.url} href={s.url} target="_blank" rel="noreferrer"><span className="n">{i + 1}</span><span>{s.title}</span></a>
            ))}
          </div>
        )}
        {showRun && <DataAnswer run={run!} onAsk={onAsk} chips={turn.status === "done" ? <Chips chips={turn.chips} /> : null} />}
        {turn.kind === "guided" && run && turn.guided_project_id && (
          <GuidedSteps run={run} projectId={turn.guided_project_id} onChanged={onRunChanged} onAsk={onAsk} />
        )}
        {turn.kind === "guided" && !run && working && <span className="c2-working"><span className="c2-spin" /> Planning the steps…</span>}
        {turn.status === "confirm" && <ConfirmCard turn={turn} busy={busy} onDecide={(ok) => onConfirm(turn, ok)} />}
        {(turn.artifacts || []).map((a) => <ArtifactCard key={a.id} a={a} onOpen={() => onOpenArtifact(a, turn)} />)}
        {turn.status === "done" && !showRun && <Chips chips={turn.chips} />}
        {(turn.status === "done" && (isData || turn.kind === "guided") && run?.status === "done") && (
          <div className="c2-next">
            {canDash && <button type="button" className="c2-nx sm" onClick={() => onMakeDashboard(turn)} data-c2-make-dashboard="">Make this a dashboard</button>}
            {(turn.placements || []).map((p) => (
              <button key={p.dashboard_id} type="button" className="c2-nx sm" onClick={() => onOpenArtifact({ type: "dashboard", id: p.dashboard_id, name: p.dashboard_name, url: `/dashboard-builder/${p.dashboard_id}`, page_id: p.page_id }, turn)}>Open “{p.dashboard_name}”</button>
            ))}
            {(turn.trail || []).some((t) => t.sql) && <button type="button" className="c2-nx sm ghost" onClick={() => onOpenMethod(turn)}>How I worked it out</button>}
            <a className="c2-nx sm ghost" href={`/p/${conversationId}?run=${turn.run_id}`}>Classic view</a>
          </div>
        )}
      </div>
    </div>
  );
}
