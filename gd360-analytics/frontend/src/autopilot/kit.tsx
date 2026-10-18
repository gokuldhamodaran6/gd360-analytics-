// 2026-10-17 (R53): Autopilot pieces shared by the initiative tabs, Event OS and the setup page -
// decisions to approve, the action log with undo, the policy, the tracking contract, forecast ranges,
// moves, response curves, lift and pipeline. Colours come from the theme tokens.
import { ReactNode, useState } from "react";
import { Link } from "react-router-dom";
import { errorText } from "../api/initiatives";
import { Action, autopilotApi, Contract, Decisions, Ev, Forecast, Lift, Mix, Move, Policy } from "../api/autopilot";
import { C, compact, niceMax, TimeArea, useWidth } from "../eventos/charts";
import { CopyField, fmt, fmtDate } from "../initiatives/ui";

export const AGENT_TONE: Record<string, string> = {
  Planner: C.good, Tracker: C.blue, Matcher: C.s(3), Pacer: C.warning, Mixer: C.s(5), Demand: C.s(1), Ops: C.danger, "Follow-up": C.violet, Prover: C.s(6),
};

export function AgentTag({ agent }: { agent: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-[0.08em] text-muted" data-agent={agent}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: AGENT_TONE[agent] || C.primary }} />{agent}
    </span>
  );
}

const TRUTH_WORD: Record<string, string> = { counted: "Counted", matched: "Matched", typed: "Typed", none: "Not connected", modelled: "Modelled" };
const TRUTH_TONE: Record<string, string> = { counted: C.good, matched: C.blue, typed: C.warning, none: C.muted, modelled: C.violet };
export function TruthChip({ truth, title }: { truth?: string | null; title?: string }) {
  if (!truth) return null;
  return (
    <span className="inline-flex items-center gap-1.5 h-[20px] px-2 rounded-full border border-border text-[11px] whitespace-nowrap" style={{ color: TRUTH_TONE[truth] || C.muted }}
      title={title} data-truth-chip={truth}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: TRUTH_TONE[truth] || C.muted }} />{TRUTH_WORD[truth] || truth}
    </span>
  );
}

export function ClosedBy({ by }: { by?: string | null }) {
  if (!by) return null;
  const word = by === "evidence" ? "Closed by evidence" : by === "autopilot" ? "GD360 already did it" : by === "approval" ? "Closed by approval" : by === "you" ? "Closed by you" : `Closed by ${by}`;
  const c = by === "evidence" || by === "autopilot" ? "text-good" : "text-muted";
  return <span className={`text-caption ${c}`} data-closed-by={by}>{by === "evidence" || by === "autopilot" ? "✓ " : ""}{word}</span>;
}

const STATE_WORD: Record<string, [string, string]> = {
  proposed: ["Waiting for you", "text-warning"], done: ["Done", "text-good"], undone: ["Undone", "text-muted"], dismissed: ["Dismissed", "text-muted"], failed: ["Failed", "text-danger"],
};

/** One agent action: approve / dismiss while proposed, undo once done (when it can be undone). */
export function ActionRow({ a, canEdit, onChanged, showInitiative = false }: { a: Action; canEdit: boolean; onChanged: (a: Action) => void; showInitiative?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const go = async (verb: "approve" | "dismiss" | "undo") => {
    setBusy(true); setErr("");
    try { onChanged(await autopilotApi.act(a.id, verb)); } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  };
  const [word, cls] = STATE_WORD[a.state] || [a.state, "text-muted"];
  return (
    <div className="py-3 flex flex-col gap-1.5 border-t border-border first:border-t-0" data-ap-action={a.kind} data-ap-state={a.state}>
      <div className="flex items-start gap-3 min-w-0">
        <div className="min-w-0 flex-1 flex flex-col gap-0.5">
          <div className="flex items-center gap-2 flex-wrap"><AgentTag agent={a.agent} />
            {a.auto && a.state === "done" && <span className="text-[11px] text-muted">did it alone (your policy)</span>}
            {showInitiative && a.initiative && a.initiative_id && <Link to={`/initiatives/${a.initiative_id}?tab=pace`} className="text-[11px] text-muted hover:underline truncate max-w-[260px]">{a.initiative}</Link>}
          </div>
          <div className="text-ui text-text font-medium leading-snug">{a.title}</div>
          {a.detail && <div className="text-caption text-muted">{a.detail}</div>}
          {(a.impact || a.cost) && <div className="text-caption text-secondary">{a.impact}{a.impact && a.cost ? " · " : ""}{a.cost ? `costs ${fmt(a.cost, "money")}` : ""}</div>}
          {a.result && a.state !== "proposed" && <div className="text-caption text-secondary">{a.result}</div>}
          {err && <div className="text-caption text-danger">{err}</div>}
        </div>
        <span className={`text-caption shrink-0 ${cls}`}>{word}</span>
      </div>
      {canEdit && a.state === "proposed" && (
        <div className="flex gap-2">
          <button type="button" className="btn-primary !py-1.5 !px-3 text-caption" disabled={busy} onClick={() => go("approve")} data-approve="">{busy ? "Working…" : "Approve and do it"}</button>
          <button type="button" className="btn-secondary !py-1.5 !px-3 text-caption" disabled={busy} onClick={() => go("dismiss")}>Dismiss</button>
        </div>
      )}
      {canEdit && a.state === "done" && a.reversible && (
        <div><button type="button" className="text-caption text-muted underline hover:text-text" disabled={busy} onClick={() => go("undo")} data-undo="">Undo</button></div>
      )}
    </div>
  );
}

/** A match waiting for a person: confirm adds its numbers, reject keeps it out (and teaches the next scan nothing new). */
export function ReviewRow({ e, initiativeId, canEdit, onChanged, showInitiative = false }: { e: Ev; initiativeId: string; canEdit: boolean; onChanged: () => void; showInitiative?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const go = async (d: "confirm" | "reject") => {
    setBusy(true); setErr("");
    try { await autopilotApi.decide(initiativeId, e.id, d); onChanged(); } catch (x) { setErr(errorText(x)); setBusy(false); }
  };
  const nums = Object.entries(e.numbers || {}).filter(([, v]) => v !== null && v !== undefined);
  return (
    <div className="py-3 flex gap-3 items-start border-t border-border first:border-t-0" data-review={e.id}>
      <EvKindIcon kind={e.kind} />
      <div className="min-w-0 flex-1 flex flex-col gap-0.5">
        <div className="flex items-center gap-2 flex-wrap text-[11px] text-muted">
          <span>{e.source}</span>{e.occurred_at && <span>· {fmtDate(e.occurred_at)}</span>}
          {showInitiative && e.initiative && <span className="truncate max-w-[240px]">· {e.initiative}</span>}
        </div>
        <div className="text-ui text-text leading-snug line-clamp-2">{e.title || e.text}</div>
        <div className="text-caption text-muted">Matched by {e.matched_by || "?"}{e.confidence !== null ? ` · ${Math.round(100 * (e.confidence || 0))}% sure` : ""}{e.why ? ` · ${e.why}` : ""}</div>
        {nums.length > 0 && <div className="text-caption text-secondary tabular-nums">{nums.map(([k, v]) => `${compact(Number(v))} ${k.replace(/_/g, " ")}`).join(" · ")}</div>}
        {err && <div className="text-caption text-danger">{err}</div>}
      </div>
      {canEdit && (
        <div className="flex gap-1.5 shrink-0">
          <button type="button" className="btn-primary !py-1.5 !px-3 text-caption" disabled={busy} onClick={() => go("confirm")} data-confirm="">It's ours</button>
          <button type="button" className="btn-secondary !py-1.5 !px-3 text-caption" disabled={busy} onClick={() => go("reject")} data-reject="">Not ours</button>
        </div>
      )}
    </div>
  );
}

export function EvKindIcon({ kind }: { kind: string }) {
  const p = { width: 15, height: 15, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  const g = kind === "post" ? <svg {...p}><rect x="4" y="4" width="16" height="16" rx="4" /><circle cx="12" cy="12" r="3.5" /></svg>
    : kind === "ad" ? <svg {...p}><path d="M4 10v4l11 5V5L4 10Z" /></svg>
    : kind === "web" ? <svg {...p}><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c3 3.2 3 13.8 0 17M12 3.5c-3 3.2-3 13.8 0 17" /></svg>
    : kind === "deal" ? <svg {...p}><path d="M4 7h16v12H4z" /><path d="M9 7V5h6v2" /></svg>
    : kind === "email" ? <svg {...p}><rect x="3.5" y="5.5" width="17" height="13" rx="2" /><path d="m4 7 8 6 8-6" /></svg>
    : kind === "page" ? <svg {...p}><path d="M6 3.5h8l4 4V20.5H6z" /><path d="M14 3.5V8h4" /></svg>
    : <svg {...p}><circle cx="12" cy="12" r="3" /></svg>;
  return <span className="w-8 h-8 rounded-[9px] grid place-items-center shrink-0 bg-surface2 text-secondary" data-ev-kind={kind}>{g}</span>;
}

/** Everything waiting for a person, for one initiative or the whole workspace. */
export function DecisionsPanel({ d, canEdit, onChanged, showInitiative = false, title = "Decisions for you", empty }: {
  d: Decisions | null; canEdit: boolean; onChanged: () => void; showInitiative?: boolean; title?: string; empty?: string;
}) {
  const total = d ? d.total : 0;
  return (
    <section className="rounded-card border border-tint-border bg-gradient-to-b from-tint/60 to-surface p-4 sm:p-5 flex flex-col gap-2 min-w-0" data-decisions="">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="m-0 text-section font-semibold text-text">{title}{total ? <span className="ml-2 text-muted font-normal tabular-nums">{total}</span> : null}</h2>
          <p className="m-0 mt-0.5 text-caption text-muted">What the agents want to do and the matches they weren't sure about. Your policy decides what they do alone.</p>
        </div>
      </div>
      {!d ? <div className="h-16 rounded-ctl bg-surface2 animate-pulse" /> : total === 0 ? (
        <p className="m-0 text-ui text-muted">{empty || "Nothing waits for you. The agents are working inside your policy."}</p>
      ) : (
        <div className="flex flex-col">
          {d.actions.map((a) => <ActionRow key={a.id} a={a} canEdit={canEdit} onChanged={onChanged} showInitiative={showInitiative} />)}
          {d.review.slice(0, 8).map((e) => <ReviewRow key={e.id} e={e} initiativeId={e.initiative_id || ""} canEdit={canEdit} onChanged={onChanged} showInitiative={showInitiative} />)}
          {d.approvals.map((x) => (
            <div key={x.task_id} className="py-3 border-t border-border first:border-t-0 flex items-center gap-3" data-approval-wait={x.task_id}>
              <span className="w-2 h-2 rounded-full bg-warning shrink-0" />
              <div className="min-w-0 flex-1"><div className="text-ui text-text truncate">{x.title}</div>
                <div className="text-caption text-muted">Waiting for {x.approver || "an approver"}{showInitiative ? ` · ${x.initiative}` : ""}</div></div>
              <Link to={`/initiatives/${x.initiative_id}?tab=plan`} className="text-caption text-brand-ink hover:underline shrink-0">Open</Link>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** The policy: what the agents may do alone and what they must ask. */
export function PolicyEditor({ p, canEdit, onSave }: { p: Policy; canEdit: boolean; onSave: (body: Partial<Policy>) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const save = async (body: Partial<Policy>) => { setBusy(true); try { await onSave(body); } finally { setBusy(false); } };
  const ALONE: [string, string][] = [["attach", "Attach evidence it is sure of"], ["close_task", "Close tasks when their evidence arrives"], ["reminder", "Set reminders for overdue work"],
    ["digest", "Send the morning digest"], ["task", "Add tasks to the plan"]];
  const ASK: [string, string][] = [["email", "Emails to people outside the team"], ["budget", "Budget moves"]];
  return (
    <div className="flex flex-col gap-4" data-policy="">
      <label className="flex items-center justify-between gap-3 rounded-ctl border border-border px-3 py-2.5">
        <span><span className="text-ui text-text font-medium">Autopilot {p.paused ? "paused" : "on"}</span>
          <span className="block text-caption text-muted">{p.paused ? "Nothing happens alone; everything waits for you." : "The agents act inside the rules below."}</span></span>
        <input type="checkbox" className="w-5 h-5 accent-[rgb(var(--color-primary))]" checked={!p.paused} disabled={!canEdit || busy} onChange={(e) => save({ paused: !e.target.checked })} data-policy-on="" />
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">Does alone</span>
          {ALONE.map(([k, l]) => (
            <label key={k} className="flex items-center gap-2.5 text-ui text-text">
              <input type="checkbox" className="accent-[rgb(var(--color-primary))]" checked={!!p.alone[k]} disabled={!canEdit || busy}
                onChange={(e) => save({ alone: { ...p.alone, [k]: e.target.checked } })} data-policy-alone={k} />{l}
            </label>
          ))}
        </div>
        <div className="flex flex-col gap-2">
          <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">Always asks</span>
          {ASK.map(([k, l]) => (
            <span key={k} className="flex items-center gap-2.5 text-ui text-text" data-policy-ask={k}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted" aria-hidden><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>{l}
            </span>
          ))}
          <span className="text-[11.5px] text-muted">These always wait for a person, whatever the settings.</span>
          <label className="flex flex-col gap-1 mt-1">
            <span className="text-caption text-secondary">Attach alone when at least this sure</span>
            <select className="input !py-1.5 text-caption !w-auto" value={String(p.auto_attach_at)} disabled={!canEdit || busy} onChange={(e) => save({ auto_attach_at: Number(e.target.value) })} data-policy-sure="">
              {[0.8, 0.85, 0.9, 0.95, 0.99].map((v) => <option key={v} value={v}>{Math.round(v * 100)}%</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-caption text-secondary">Largest budget move it may suggest</span>
            <input type="number" min={0} step={50} className="input !py-1.5 text-caption !w-[140px]" defaultValue={p.budget_cap} disabled={!canEdit || busy}
              onBlur={(e) => { const v = Number(e.target.value); if (v !== p.budget_cap && v >= 0) save({ budget_cap: v }); }} data-policy-cap="" />
          </label>
        </div>
      </div>
    </div>
  );
}

/** The tracking contract: the code, the ad naming rule, the hashtag and UTM every number is matched by. */
export function ContractCard({ c, canEdit, onPatch, extra }: { c: Contract; canEdit: boolean; onPatch?: (body: Record<string, any>) => Promise<void>; extra?: ReactNode }) {
  const [edit, setEdit] = useState(false);
  const [tag, setTag] = useState(c.hashtag || "");
  const [kw, setKw] = useState(c.keywords.join(", "));
  const rows: [string, string, string][] = [
    ["Ad naming rule", c.ad_rule, "Put this in the name of every Meta or Google Ads campaign for it. Spend and results attach on their own."],
    ["UTM campaign", c.utm_campaign, `Links that carry it count as this initiative's sessions: ${c.utm_example}`],
    ["Code", c.code, "Use it in posts, emails and sign-up forms; anything carrying it is matched."],
  ];
  return (
    <div className="flex flex-col gap-3" data-contract={c.code}>
      <div className="grid gap-3 sm:grid-cols-3">
        {rows.map(([l, v, h]) => (
          <div key={l} className="rounded-ctl border border-border p-3 flex flex-col gap-1.5 min-w-0">
            <span className="text-caption text-muted">{l}</span>
            <CopyField value={v} label={l} testId={`contract-${l.split(" ")[0].toLowerCase()}`} />
            <span className="text-[11.5px] text-muted leading-snug [overflow-wrap:anywhere]">{h}</span>
          </div>
        ))}
      </div>
      {!edit ? (
        <div className="flex items-center gap-3 flex-wrap text-caption text-secondary">
          <span>Hashtag <b className="text-text font-medium">{c.hashtag || "none"}</b></span>
          <span>Words <span className="text-text">{c.keywords.join(", ") || "none"}</span></span>
          {(c.mapped.ads?.length || 0) + (c.mapped.posts?.length || 0) > 0 && <span>{(c.mapped.ads?.length || 0) + (c.mapped.posts?.length || 0)} mapped by hand</span>}
          {canEdit && onPatch && <button type="button" className="text-brand-ink hover:underline" onClick={() => setEdit(true)}>Edit</button>}
          {extra}
        </div>
      ) : (
        <form className="flex gap-2 flex-wrap items-end" onSubmit={async (e) => { e.preventDefault(); await onPatch?.({ hashtag: tag, keywords: kw.split(",").map((x) => x.trim()).filter(Boolean) }); setEdit(false); }}>
          <label className="flex flex-col gap-1"><span className="text-caption text-secondary">Hashtag</span><input className="input !py-1.5 text-caption !w-[220px]" value={tag} onChange={(e) => setTag(e.target.value)} /></label>
          <label className="flex flex-col gap-1 flex-1 min-w-[200px]"><span className="text-caption text-secondary">Words (two or more in a post count as a likely match)</span><input className="input !py-1.5 text-caption" value={kw} onChange={(e) => setKw(e.target.value)} /></label>
          <button type="submit" className="btn-primary text-caption !py-2">Save</button>
          <button type="button" className="btn-secondary text-caption !py-2" onClick={() => setEdit(false)}>Cancel</button>
        </form>
      )}
    </div>
  );
}

/** One target's 80% range at the end date against the target, with where it stands now. */
export function RangeRow({ f }: { f: Forecast }) {
  const lower = f.direction === "down";
  const hasRange = f.p10 !== undefined && f.p90 !== undefined && f.median !== undefined;
  const max = niceMax(Math.max(f.target || 0, f.p90 || 0, f.actual || 0, 1) * 1.08);
  const X = (v: number) => `${Math.max(0, Math.min(100, (100 * v) / max))}%`;
  const prob = f.prob;
  const tone = prob === null || prob === undefined ? "text-muted" : prob >= 0.5 ? (prob >= 0.7 ? "text-good" : "text-warning") : "text-danger";
  return (
    <div className="flex flex-col gap-2 py-3 border-t border-border first:border-t-0" data-forecast={f.key}>
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <span className="text-ui text-text font-medium inline-flex items-center gap-2">{f.label}<TruthChip truth={f.truth} /></span>
        <span className="text-caption tabular-nums">
          {hasRange && f.state === "level" ? <>today <b className="text-text">{fmt(f.median!, f.unit)}</b> against {lower ? "at most " : ""}{fmt(f.target, f.unit)}</>
            : hasRange ? <>likely <b className="text-text">{fmt(f.median!, f.unit)}</b> <span className="text-muted">({fmt(f.p10!, f.unit)}–{fmt(f.p90!, f.unit)})</span> of {fmt(f.target, f.unit)}</>
            : <span className="text-muted">{f.note || "No forecast yet"}</span>}
          {prob !== null && prob !== undefined && <span className={`ml-2 font-medium ${tone}`}>{Math.round(prob * 100)}% chance{lower ? " of staying under" : ""}</span>}
        </span>
      </div>
      {hasRange && f.state !== "level" && (
        <div className="relative h-5" aria-hidden>
          <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1.5 rounded-full bg-surface2" />
          <div className="absolute top-1/2 -translate-y-1/2 h-2.5 rounded-full" style={{ left: X(f.p10!), width: `calc(${X(f.p90!)} - ${X(f.p10!)})`, background: "rgb(var(--color-primary) / 0.28)", minWidth: 3 }} />
          {f.actual !== null && <div className="absolute top-1/2 -translate-y-1/2 h-1.5 rounded-full bg-primary" style={{ left: 0, width: X(f.actual) }} />}
          <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 rounded-full border-2 border-surface bg-primary" style={{ left: X(f.median!) }} title={`Likely ${fmt(f.median!, f.unit)}`} />
          <div className="absolute top-0 bottom-0 w-[2px] bg-text" style={{ left: X(f.target) }} title={`Target ${fmt(f.target, f.unit)}`} />
        </div>
      )}
      <div className="text-[11.5px] text-muted flex gap-3 flex-wrap">
        <span>Now {fmt(f.actual, f.unit)}</span>
        {f.expected_now !== null && f.expected_now !== undefined && <span>{lower ? "spending evenly you'd be at" : "on a steady pace you'd have"} {fmt(f.expected_now, f.unit)}</span>}
        {f.state === "level" && f.note && <span>· {f.note}</span>}
        {f.basis && <span>· {f.basis}</span>}
      </div>
    </div>
  );
}

export function MoveRow({ m, canEdit, onDo }: { m: Move; canEdit: boolean; onDo: (m: Move) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");
  return (
    <div className="py-3 border-t border-border first:border-t-0 flex gap-3 items-start" data-move={m.key}>
      <span className="w-6 h-6 rounded-full grid place-items-center text-[11.5px] font-semibold tabular-nums bg-tint text-brand-ink shrink-0">{m.rank}</span>
      <div className="min-w-0 flex-1 flex flex-col gap-0.5">
        <AgentTag agent={m.agent} />
        <div className="text-ui text-text font-medium leading-snug">{m.title}</div>
        <div className="text-caption text-muted">{m.detail}</div>
        <div className="text-caption text-secondary">{m.lift ? `About +${compact(m.lift)} ${m.helps.replace(/_/g, " ")}` : `Helps ${m.helps.replace(/_/g, " ")}`}{m.cost ? ` · ${fmt(m.cost, "money")}` : " · no cost"}{m.alone ? " · it may do this alone" : ""}</div>
        {done && <div className="text-caption text-good">✓ {done}</div>}
      </div>
      {canEdit && !done && (
        <button type="button" className="btn-primary !py-1.5 !px-3 text-caption shrink-0" disabled={busy} data-do-move={m.key}
          onClick={async () => { setBusy(true); try { await onDo(m); setDone(m.kind === "budget" ? "Added as a task - change it in the ad platform" : "Done"); } finally { setBusy(false); } }}>
          {busy ? "Working…" : "Do it"}</button>
      )}
    </div>
  );
}

/** Response curves: results per day against spend per day, one line per platform, today's spend marked. */
export function CurveChart({ mix, height = 240 }: { mix: Mix; height?: number }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ ch: number; pt: number } | null>(null);
  const chs = mix.channels || [];
  const pl = 46, pr = 14, pt = 14, pb = 30;
  const iw = Math.max(10, w - pl - pr), ih = height - pt - pb;
  const xmax = niceMax(Math.max(1, ...chs.flatMap((c) => [...c.curve.map((p) => p.spend), ...c.observed.map((p) => p.spend)])));
  const ymax = niceMax(Math.max(0.1, ...chs.flatMap((c) => [...c.curve.map((p) => p.results), ...c.observed.map((p) => p.results)])) * 1.08);
  const X = (v: number) => pl + (v / xmax) * iw;
  const Y = (v: number) => pt + ih - (v / ymax) * ih;
  const color = (k: number) => C.s([1, 5, 3, 2][k % 4]);
  return (
    <div className="flex flex-col gap-2">
      <div ref={ref} className="relative w-full" style={{ height }}>
        {w > 0 && (
          <svg width={w} height={height} role="img" aria-label="Results per day against spend per day, per platform" className="block" onMouseLeave={() => setHover(null)}>
            {[0, 0.25, 0.5, 0.75, 1].map((f) => (
              <g key={f}><line x1={pl} x2={w - pr} y1={Y(f * ymax)} y2={Y(f * ymax)} stroke={C.grid} />
                <text x={pl - 6} y={Y(f * ymax) + 4} textAnchor="end" fontSize="10" fill={C.muted} className="font-mono">{compact(f * ymax)}</text></g>
            ))}
            {[0, 0.5, 1].map((f) => (
              <text key={f} x={X(f * xmax)} y={height - 8} textAnchor={f === 0 ? "start" : f === 1 ? "end" : "middle"} fontSize="10" fill={C.muted} className="font-mono">${compact(f * xmax)}/day</text>
            ))}
            {chs.map((c, k) => (
              <g key={c.platform}>
                {c.observed.map((p, j) => <circle key={j} cx={X(p.spend)} cy={Y(p.results)} r={3} fill={color(k)} opacity={0.35} />)}
                <path d={c.curve.map((p, j) => `${j ? "L" : "M"}${X(p.spend).toFixed(1)},${Y(p.results).toFixed(1)}`).join(" ")} fill="none" stroke={color(k)} strokeWidth={2.2} />
                <line x1={X(c.daily_spend)} x2={X(c.daily_spend)} y1={pt} y2={pt + ih} stroke={color(k)} strokeDasharray="3 4" opacity={0.7} />
                {c.curve.map((p, j) => (
                  <rect key={j} x={X(p.spend) - 6} y={pt} width={12} height={ih} fill="transparent" onMouseEnter={() => setHover({ ch: k, pt: j })} />
                ))}
              </g>
            ))}
            {hover && chs[hover.ch] && <circle cx={X(chs[hover.ch].curve[hover.pt].spend)} cy={Y(chs[hover.ch].curve[hover.pt].results)} r={4.5} fill={color(hover.ch)} stroke={C.surface} strokeWidth={2} />}
          </svg>
        )}
        {hover && chs[hover.ch] && w > 0 && (
          <div className="pointer-events-none absolute z-20 rounded-ctl border border-border bg-surface/95 shadow-pop px-3 py-2 text-caption"
            style={{ left: Math.min(Math.max(X(chs[hover.ch].curve[hover.pt].spend) - 80, 0), w - 170), top: 0 }}>
            <div className="text-text font-medium">{chs[hover.ch].platform}</div>
            <div className="text-secondary tabular-nums">${compact(chs[hover.ch].curve[hover.pt].spend)}/day → {compact(chs[hover.ch].curve[hover.pt].results)} results/day</div>
          </div>
        )}
      </div>
      <div className="flex gap-4 flex-wrap">
        {chs.map((c, k) => (
          <span key={c.platform} className="inline-flex items-center gap-1.5 text-caption text-secondary">
            <span className="w-2.5 h-2.5 rounded-[3px]" style={{ background: color(k) }} />{c.platform}
            <span className="text-muted">· dashed line = today's spend</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** Lift: what happened against what would have happened anyway, with the 90% range. */
export function LiftPanel({ l, title }: { l: Lift; title: string }) {
  if (l.state !== "ok") {
    return (
      <div className="rounded-ctl border border-dashed border-border-strong p-4 text-caption text-muted" data-lift-state={l.state}>
        <div className="text-ui text-text font-medium mb-0.5">{title}</div>{l.why || "Not enough data yet."}
      </div>
    );
  }
  const s = l.series || [];
  const good = l.clears_zero && (l.lift || 0) > 0;
  return (
    <div className="flex flex-col gap-3" data-lift={title}>
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <span className="text-ui text-text font-medium">{title}</span>
        <span className={`text-ui font-semibold tabular-nums ${good ? "text-good" : "text-muted"}`} data-lift-pct={l.pct ?? ""}>
          {(l.lift || 0) >= 0 ? "+" : ""}{compact(l.lift)} {l.pct !== null && l.pct !== undefined ? `(${l.pct >= 0 ? "+" : ""}${l.pct}%)` : ""}
          <span className="text-caption text-muted font-normal ml-2">90% range {compact(l.lo)} to {compact(l.hi)}</span>
        </span>
      </div>
      {s.length > 1 && (
        <TimeArea dates={s.map((x) => x.date)} height={200} ariaLabel={`${title}: actual against expected`}
          series={[{ key: "actual", label: "What happened", color: C.primary, kind: "area", values: s.map((x) => x.actual) },
            { key: "expected", label: "Expected anyway", color: C.muted, kind: "dash", values: s.map((x) => x.expected) }]} />
      )}
      <p className="m-0 text-caption text-secondary">{l.verdict}{l.treated ? ` Treated: ${l.treated.join(", ")}; control: ${l.control}.` : ""}{l.source ? ` Source: ${l.source}, ${l.metric}.` : ""}</p>
    </div>
  );
}
