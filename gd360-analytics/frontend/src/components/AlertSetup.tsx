// 2026-10-11 (Explain & Alerts, canvas B2/B3): GD360 drafts the alert, the
// person confirms who gets it and where.
//
// AlertDraftCard - WHEN / CHECK / TELL in plain words, the number now, and a
// back-test on its own history ("on the last 24 months it would have fired
// twice"). Nothing is switched on until the person confirms.
// AlertConfirmSheet - who gets it (workspace people; whether each can open
// the dashboard, and "Give view access" when not), where (in GD360 and by
// email; Slack, Teams or any app by webhook behind "Add more"), and how often
// (once when it crosses, or a daily reminder while it stays past the line).
// Alerts are delivered the moment they happen - there are no quiet hours.
import { ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import {
  AlertDraft, AlertOp, CreateAlertBody, dashboardAiApi, DraftResult, MetricChoice, Recipient, RecipientsOut,
} from "../api/alerts";
import { CloseIcon, Spinner } from "../thread/parts";

const OP_TEXT: Record<AlertOp, string> = { below: "goes below", above: "goes above", drops_by: "falls by more than", rises_by: "rises by more than" };
const WINDOW_TEXT: Record<string, string> = { last_30_days: "the last 30 days", last_7_days: "the last 7 days", total: "everything the tile shows" };
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/;

export const BellSmall = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
  </svg>
);

const Label = ({ children }: { children: ReactNode }) => (
  <span className="font-mono text-[11px] tracking-[0.14em] text-kind-alert pt-[3px]">{children}</span>
);

/** The watched number month by month, with the line drawn across it. */
export function HistorySpark({ draft }: { draft: AlertDraft }) {
  const pts = draft.history;
  if (pts.length < 3) return null;
  const by = draft.op === "drops_by" || draft.op === "rises_by";
  const vals = pts.map((p) => p.value);
  const line = by ? null : draft.value;
  const lo = Math.min(...vals, ...(line != null ? [line] : []));
  const hi = Math.max(...vals, ...(line != null ? [line] : []));
  const pad = (hi - lo) * 0.12 || Math.abs(hi) * 0.1 || 1;
  const y0 = lo - pad, y1 = hi + pad;
  const W = 400, H = 92;
  const x = (i: number) => (i / (pts.length - 1)) * W;
  const y = (v: number) => H - ((v - y0) / (y1 - y0)) * H;
  const path = pts.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const ext = draft.op === "above" ? pts.reduce((a, b) => (b.value > a.value ? b : a)) : pts.reduce((a, b) => (b.value < a.value ? b : a));
  const ei = pts.indexOf(ext);
  const ly = line != null ? y(line) : null;
  return (
    <svg viewBox={`-6 -14 ${W + 12} ${H + 30}`} role="img" aria-label={`${draft.label} over the last ${pts.length} months, with the alert line at ${draft.line_display}`} className="w-full h-auto">
      <line x1="0" y1={H} x2={W} y2={H} stroke="rgb(var(--color-kind-alert-border))" />
      {ly != null && (
        <>
          <line x1="0" y1={ly} x2={W} y2={ly} stroke="rgb(var(--color-danger))" strokeDasharray="4 4" />
          <text x={W} y={ly - 5} textAnchor="end" fill="rgb(var(--color-danger))" fontSize="10" fontFamily="Geist Mono, monospace">
            {draft.line_display} line
          </text>
        </>
      )}
      <polyline points={path} fill="none" stroke="rgb(var(--color-kind-alert))" strokeWidth="2" strokeLinejoin="round" />
      <circle cx={x(ei)} cy={y(ext.value)} r="3.5" fill="rgb(var(--color-kind-alert))" />
      <text x={Math.min(W - 24, Math.max(24, x(ei)))} y={Math.min(H + 13, y(ext.value) + 15)} textAnchor="middle" fill="rgb(var(--color-muted))" fontSize="9.5" fontFamily="Geist Mono, monospace">
        {ext.label}
      </text>
    </svg>
  );
}

export function AlertDraftCard({
  draft, choices, busy, onChange, onNext, onCancel, done,
}: {
  draft: AlertDraft;
  choices: MetricChoice[];
  busy: boolean;
  onChange: (patch: { block_id?: string; den_block_id?: string | null; ratio_as?: string | null; op?: AlertOp; value?: number; window?: string; label?: string | null }) => void;
  onNext: () => void;
  onCancel?: () => void;
  done?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [op, setOp] = useState<AlertOp>(draft.op);
  const [value, setValue] = useState(String(draft.value));
  const [win, setWin] = useState(draft.window);
  const [metric, setMetric] = useState(draft.ratio ? `ratio:${draft.target.block_id}:${draft.target.den_block_id}` : draft.target.block_id);
  useEffect(() => {
    setOp(draft.op);
    setValue(String(draft.value));
    setWin(draft.window);
    setMetric(draft.ratio ? `ratio:${draft.target.block_id}:${draft.target.den_block_id}` : draft.target.block_id);
  }, [draft]);
  const by = draft.op === "drops_by" || draft.op === "rises_by";
  const bt = draft.backtest;
  return (
    <section className="rounded-[18px] border border-kind-alert-border bg-kind-alert-fill overflow-hidden" data-alert-draft="">
      <div className="p-4 flex flex-col gap-3">
        <div className="grid grid-cols-[64px_minmax(0,1fr)] gap-x-3 gap-y-2.5 text-[14px] leading-5 text-text">
          <Label>WHEN</Label>
          <span>
            <b>{draft.label}</b> {OP_TEXT[draft.op]} <b>{draft.line_display}</b>
            {draft.formula && <><br /><span className="text-[12px] text-secondary">{draft.formula} - worked out from two numbers on this dashboard</span></>}
          </span>
          <Label>CHECK</Label>
          <span>
            Every hour, day and night
            <br />
            <span className="text-[12px] text-secondary">
              On {WINDOW_TEXT[draft.window] || draft.window_text}{draft.window !== "total" ? ", so one odd day doesn't set it off" : ""} - you hear the moment it crosses
            </span>
          </span>
          <Label>TELL</Label>
          <span>
            You, in Euliv and by email <span className="text-secondary">- choose more people next</span>
          </span>
        </div>

        <div className="rounded-[12px] bg-[rgb(var(--color-base))] border border-kind-alert-border/70 p-3 flex flex-col gap-2">
          <div className="flex justify-between gap-3 text-[12px] text-secondary">
            <span>{draft.label} · {by ? "month to month" : `last ${draft.history.length || 0} months`}</span>
            <span className="font-mono text-text">{draft.current.display} now</span>
          </div>
          <HistorySpark draft={draft} />
          <span className="text-[12px] leading-[17px] text-secondary" data-backtest="">{bt.text}</span>
        </div>

        {draft.met_now && (
          <div className="rounded-[10px] border border-warning-border bg-warning-fill px-3 py-2 text-[12.5px] text-warning leading-snug" data-met-now="">
            It's already past the line ({draft.current.display} now) - once it's on, you'll be told within a minute.
          </div>
        )}

        <div className="flex flex-wrap gap-1.5">
          <span className="h-[26px] px-2.5 rounded-full bg-[rgb(var(--color-kind-alert)/0.14)] text-[12px] text-kind-alert inline-flex items-center">Fires once when it crosses</span>
          <span className="h-[26px] px-2.5 rounded-full bg-[rgb(var(--color-kind-alert)/0.14)] text-[12px] text-kind-alert inline-flex items-center">Tells you again only after it recovers</span>
        </div>

        {editing && (
          <div className="rounded-[12px] border border-kind-alert-border bg-surface p-3 grid gap-2.5 sm:grid-cols-2" data-draft-editor="">
            <label className="flex flex-col gap-1 text-caption text-muted sm:col-span-2">
              Number
              <select className="h-9 rounded-ctl border border-border bg-base px-2 text-ui text-text" value={metric} onChange={(e) => setMetric(e.target.value)}>
                {draft.ratio && <option value={`ratio:${draft.target.block_id}:${draft.target.den_block_id}`}>{draft.label} ({draft.formula})</option>}
                {choices.map((c) => (
                  <option key={c.block_id} value={c.block_id}>{c.label}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-caption text-muted">
              When it
              <select className="h-9 rounded-ctl border border-border bg-base px-2 text-ui text-text" value={op} onChange={(e) => setOp(e.target.value as AlertOp)}>
                <option value="below">goes below</option>
                <option value="above">goes above</option>
                <option value="drops_by">falls by more than</option>
                <option value="rises_by">rises by more than</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-caption text-muted">
              {op === "drops_by" || op === "rises_by" ? "Percent" : `Line${draft.unit === "%" ? " (%)" : ""}`}
              <input className="h-9 rounded-ctl border border-border bg-base px-2 text-ui text-text font-mono" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-caption text-muted sm:col-span-2">
              Measured over
              <select className="h-9 rounded-ctl border border-border bg-base px-2 text-ui text-text" value={win} onChange={(e) => setWin(e.target.value as AlertDraft["window"])}>
                <option value="last_30_days">the last 30 days</option>
                <option value="last_7_days">the last 7 days</option>
                <option value="total">everything the tile shows</option>
              </select>
            </label>
            <div className="sm:col-span-2 flex gap-2 justify-end">
              <button type="button" className="btn-secondary text-sm" onClick={() => setEditing(false)}>Cancel</button>
              <button
                type="button"
                className="btn-primary text-sm"
                disabled={busy || !Number.isFinite(parseFloat(value))}
                onClick={() => {
                  const ratio = metric.startsWith("ratio:");
                  onChange({
                    block_id: ratio ? draft.target.block_id : metric,
                    den_block_id: ratio ? draft.target.den_block_id : null,
                    ratio_as: ratio ? draft.target.ratio_as : null,
                    label: ratio ? draft.label : null,
                    op, value: parseFloat(value), window: win,
                  });
                  setEditing(false);
                }}
              >
                {busy ? "Updating…" : "Update the draft"}
              </button>
            </div>
          </div>
        )}
      </div>
      {!done && (
        <div className="px-4 py-3 border-t border-kind-alert-border/70 flex items-center gap-2 flex-wrap">
          <span className="flex-1 min-w-[160px] text-[12px] text-secondary">Nothing is switched on until you confirm.</span>
          {onCancel && <button type="button" onClick={onCancel} className="ui-focus h-[34px] px-3 rounded-[10px] text-[13px] text-muted hover:text-text">Not now</button>}
          {!editing && (
            <button type="button" onClick={() => setEditing(true)} className="ui-focus h-[34px] px-3 rounded-[10px] border border-kind-alert-border text-[13px] text-text hover:bg-surface" data-change-draft="">
              Change it
            </button>
          )}
          <button type="button" onClick={onNext} disabled={busy} className="ui-focus h-[34px] px-3.5 rounded-[10px] bg-kind-alert text-[rgb(var(--color-base))] text-[13px] font-semibold disabled:opacity-60" data-choose-recipients="">
            Choose who gets it →
          </button>
        </div>
      )}
    </section>
  );
}

/** "Which number?" / "Below or above what?" - when the words weren't enough. */
export function DraftQuestion({
  result, onPick, busy,
}: {
  result: Extract<DraftResult, { status: "need_metric" | "need_line" }>;
  onPick: (patch: { block_id: string; op?: AlertOp; value?: number; den_block_id?: string | null; ratio_as?: string | null; label?: string | null }) => void;
  busy: boolean;
}) {
  const [op, setOp] = useState<AlertOp>((result.status === "need_metric" && result.op) || "below");
  const [value, setValue] = useState(result.status === "need_metric" && result.value != null ? String(result.value) : "");
  const [block, setBlock] = useState(result.status === "need_line" ? result.target.block_id : "");
  const ok = block && Number.isFinite(parseFloat(value));
  return (
    <section className="rounded-[16px] border border-kind-alert-border bg-surface p-4 flex flex-col gap-3" data-draft-question={result.status}>
      <p className="m-0 text-ui text-text">{result.message}</p>
      {result.status === "need_line" && <span className="text-caption text-muted">Now: {result.current.display} over {result.current.window_text}</span>}
      {result.status === "need_metric" && (
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Which number">
          {result.choices.map((c) => (
            <button
              key={c.block_id}
              type="button"
              role="radio"
              aria-checked={block === c.block_id}
              onClick={() => setBlock(c.block_id)}
              className={`ui-focus h-8 px-3 rounded-full border text-[12.5px] ${block === c.block_id ? "border-kind-alert bg-kind-alert-fill text-kind-alert" : "border-border-strong text-secondary hover:text-text"}`}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <select aria-label="When it" className="h-9 rounded-ctl border border-border bg-base px-2 text-ui text-text" value={op} onChange={(e) => setOp(e.target.value as AlertOp)}>
          <option value="below">goes below</option>
          <option value="above">goes above</option>
          <option value="drops_by">falls by more than (%)</option>
          <option value="rises_by">rises by more than (%)</option>
        </select>
        <input aria-label="The line" placeholder="e.g. 20" className="h-9 w-[120px] rounded-ctl border border-border bg-base px-2 text-ui text-text font-mono" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />
        <button type="button" className="btn-primary text-sm" disabled={!ok || busy} onClick={() => onPick({ block_id: block, op, value: parseFloat(value) })}>
          {busy ? "Drafting…" : "Draft the alert"}
        </button>
      </div>
    </section>
  );
}

// ---- confirm ------------------------------------------------------------------

function Modal({ open, onClose, busy, children }: { open: boolean; onClose: () => void; busy: boolean; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);
  if (!open) return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[80] bg-[rgb(3_5_5/0.72)] backdrop-blur-[2px] flex items-start justify-center overflow-y-auto px-3 py-6 sm:py-[5vh]"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <div role="dialog" aria-modal="true" aria-labelledby="alert-confirm-title" className="w-full max-w-[780px] rounded-[24px] border border-border-strong bg-surface shadow-pop flex flex-col">
        {children}
      </div>
    </div>,
    document.body,
  );
}

const initials = (name: string) => name.split(/[\s.@_-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
const AVATAR_TONES = ["bg-kind-answer-fill text-kind-answer", "bg-kind-analysis-fill text-kind-analysis", "bg-kind-dashboard-fill text-kind-dashboard", "bg-kind-alert-fill text-kind-alert"];

type Extra = { kind: "slack" | "teams" | "webhook"; url: string; label: string };
const EXTRA_INFO: Record<Extra["kind"], { name: string; hint: string; urlHint: string; labelHint: string }> = {
  slack: { name: "Slack channel", hint: "Posts in a channel through an incoming webhook", urlHint: "https://hooks.slack.com/services/…", labelHint: "#sales-alerts" },
  teams: { name: "Microsoft Teams channel", hint: "Posts in a channel through a Teams workflow webhook", urlHint: "https://…webhook.office.com/…", labelHint: "Sales" },
  webhook: { name: "Any app (webhook)", hint: "Zapier, Make, n8n or your own endpoint - Euliv sends the alert as JSON", urlHint: "https://hooks.zapier.com/…", labelHint: "Ops pager" },
};

export function AlertConfirmSheet({
  open, onClose, dashboardId, draft, workspaceId, onCreated,
}: {
  open: boolean;
  onClose: () => void;
  dashboardId: string;
  draft: AlertDraft;
  workspaceId?: string | null;
  onCreated: (out: { id: string; name: string; people: number; pending: boolean; tell: string }) => void;
}) {
  const [rec, setRec] = useState<RecipientsOut | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [emails, setEmails] = useState<string[]>([]);
  const [entry, setEntry] = useState("");
  const [inApp, setInApp] = useState(true);
  const [byEmail, setByEmail] = useState(true);
  const [remind, setRemind] = useState<"once" | "daily">("once");
  const [extras, setExtras] = useState<Extra[]>([]);
  const [moreOpen, setMoreOpen] = useState(false);
  const [granting, setGranting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // people just given access through the dashboard's private link
  const [guestOk, setGuestOk] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    setErr("");
    setRec(null);
    dashboardAiApi
      .recipients(dashboardId)
      .then((r) => {
        setRec(r);
        setPicked(new Set(r.people.filter((p) => p.me).map((p) => p.id)));
        if (!r.email_ready) setByEmail(true);
      })
      .catch(() => setLoadErr("Couldn't load the people in this workspace."));
  }, [open, dashboardId]);

  const people = rec?.people || [];
  const chosen = people.filter((p) => picked.has(p.id));
  const placeCount = (inApp ? 1 : 0) + (byEmail ? 1 : 0) + extras.filter((x) => x.url.trim()).length;
  const personCount = chosen.length + emails.length;
  const blocked = chosen.filter((p) => p.access === "none");

  const addEmail = () => {
    const e = entry.trim().replace(/[,;]$/, "");
    if (!e) return;
    if (!EMAIL_RE.test(e)) {
      setErr(`“${e}” doesn't look like an email address.`);
      return;
    }
    const member = people.find((p) => p.email.toLowerCase() === e.toLowerCase());
    if (member) setPicked((s) => new Set(s).add(member.id));
    else if (!emails.some((x) => x.toLowerCase() === e.toLowerCase())) setEmails((cur) => [...cur, e]);
    setEntry("");
    setErr("");
  };

  const grant = async (who: { id?: string; email: string }) => {
    setGranting(who.email);
    setErr("");
    try {
      await dashboardAiApi.giveAccess(dashboardId, who.email);
      setRec((r) => (r ? { ...r, people: r.people.map((p) => (p.email.toLowerCase() === who.email.toLowerCase() ? { ...p, access: "link" } : p)) } : r));
      setGuestOk((s) => new Set(s).add(who.email.toLowerCase()));
    } catch (e: any) {
      const d = e?.response?.data?.detail;
      setErr(typeof d === "string" ? d : "Couldn't share the dashboard just now.");
    } finally {
      setGranting(null);
    }
  };
  const submit = async () => {
    if (!personCount) {
      setErr("Choose at least one person.");
      return;
    }
    if (!placeCount) {
      setErr("Choose at least one place - in Euliv or by email.");
      return;
    }
    setBusy(true);
    setErr("");
    const body: CreateAlertBody = {
      target: draft.target, op: draft.op, value: draft.value, name: draft.name, check: draft.check,
      user_ids: chosen.map((p) => p.id), emails: byEmail ? emails : [], in_app: inApp, email: byEmail, remind,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", workspace_id: workspaceId || undefined,
    };
    for (const x of extras) {
      if (!x.url.trim()) continue;
      if (x.kind === "slack") Object.assign(body, { slack_url: x.url.trim(), slack_label: x.label.trim() || undefined });
      if (x.kind === "teams") Object.assign(body, { teams_url: x.url.trim(), teams_label: x.label.trim() || undefined });
      if (x.kind === "webhook") Object.assign(body, { webhook_url: x.url.trim(), webhook_label: x.label.trim() || undefined });
    }
    try {
      const out = await dashboardAiApi.createAlert(dashboardId, body);
      onCreated({ id: out.id, name: out.name, people: out.people, pending: out.approval?.status === "pending", tell: out.sentence?.tell_sentence || out.sentence?.tell || "" });
    } catch (e: any) {
      const d = e?.response?.data?.detail;
      setErr(typeof d === "string" ? d : "Couldn't turn the alert on. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const accessLine = (p: Recipient) =>
    p.access === "app" ? (
      <span className="text-[12px] text-kind-answer">Can see the dashboard</span>
    ) : p.access === "link" || guestOk.has(p.email.toLowerCase()) ? (
      <span className="text-[12px] text-kind-answer">Opens it through its private link</span>
    ) : null;

  return (
    <Modal open={open} onClose={onClose} busy={busy}>
      <div className="px-6 sm:px-7 pt-6 pb-4 flex gap-3.5 items-start">
        <span className="w-11 h-11 shrink-0 rounded-[12px] bg-kind-alert-fill text-kind-alert grid place-items-center"><BellSmall size={20} /></span>
        <div className="flex-1 min-w-0 flex flex-col gap-1.5">
          <h2 id="alert-confirm-title" className="m-0 text-[21px] font-semibold text-text">Turn on this alert</h2>
          <span className="text-ui text-secondary">
            When <b className="text-text">{draft.label}</b> {OP_TEXT[draft.op]} <b className="text-text">{draft.line_display}</b> · checked every hour · on{" "}
            <b className="text-text">{draft.dashboard.name}</b>
          </span>
        </div>
        <button type="button" aria-label="Close" onClick={onClose} disabled={busy} className="ui-focus w-9 h-9 rounded-[10px] grid place-items-center text-muted hover:text-text">
          <CloseIcon size={16} />
        </button>
      </div>

      <div className="px-6 sm:px-7 flex flex-col gap-2.5">
        <span className="font-mono text-[11px] tracking-[0.14em] text-muted">WHO GETS IT</span>
        {loadErr && <div className="text-ui text-danger">{loadErr}</div>}
        {!rec && !loadErr && <div className="text-ui text-muted inline-flex items-center gap-2"><Spinner /> Loading people…</div>}
        {rec && (
          <div className="rounded-[14px] border border-border overflow-hidden max-h-[280px] overflow-y-auto" data-recipients="">
            {people.map((p, i) => {
              const on = picked.has(p.id);
              const cant = p.access === "none" && !guestOk.has(p.email.toLowerCase());
              return (
                <div key={p.id} className={`flex items-center gap-3 px-3.5 py-2.5 border-b border-border last:border-b-0 ${on && cant ? "bg-warning-fill/50" : ""}`}>
                  <input
                    type="checkbox"
                    id={`rcp-${p.id}`}
                    checked={on}
                    onChange={() => setPicked((s) => { const n = new Set(s); if (n.has(p.id)) n.delete(p.id); else n.add(p.id); return n; })}
                    className="w-[18px] h-[18px] accent-[rgb(var(--color-kind-alert))] m-0"
                  />
                  <label htmlFor={`rcp-${p.id}`} className="flex items-center gap-3 flex-1 min-w-0 cursor-pointer">
                    <span className={`w-[30px] h-[30px] rounded-full grid place-items-center text-[12px] font-bold shrink-0 ${AVATAR_TONES[i % AVATAR_TONES.length]}`}>{initials(p.name)}</span>
                    <span className="flex flex-col min-w-0">
                      <span className="text-ui text-text truncate">{p.name}{p.me && <span className="text-muted"> · you</span>}</span>
                      <span className="text-[12px] text-muted truncate">{p.role ? `${p.role[0].toUpperCase()}${p.role.slice(1)} · ` : ""}{p.email}</span>
                      {on && cant && <span className="text-[12px] text-warning">Can't open this dashboard - they'd get the alert, but not the dashboard</span>}
                    </span>
                  </label>
                  {cant ? (
                    rec.can_edit && on ? (
                      <button type="button" disabled={granting !== null} onClick={() => grant(p)} className="ui-focus h-[30px] px-2.5 rounded-[9px] border border-warning-border text-[12px] text-warning shrink-0" data-give-access={p.email}>
                        {granting === p.email ? "Sharing…" : "Give view access"}
                      </button>
                    ) : (
                      <span className="shrink-0 hidden sm:inline text-[12px] text-muted">Can't open the dashboard</span>
                    )
                  ) : (
                    <span className="shrink-0 hidden sm:inline">{accessLine(p)}</span>
                  )}
                </div>
              );
            })}
            {emails.map((e) => (
              <div key={e} className="flex items-center gap-3 px-3.5 py-2.5 border-b border-border last:border-b-0">
                <span className="w-[18px]" />
                <span className="w-[30px] h-[30px] rounded-full grid place-items-center text-[12px] font-bold bg-subtle text-secondary shrink-0">{initials(e)}</span>
                <span className="flex flex-col min-w-0 flex-1">
                  <span className="text-ui text-text truncate">{e}</span>
                  <span className="text-[12px] text-muted">{guestOk.has(e.toLowerCase()) ? "Opens it through its private link" : "By email · not in this workspace"}</span>
                </span>
                {rec.can_edit && !guestOk.has(e.toLowerCase()) && (
                  <button type="button" disabled={granting !== null} onClick={() => grant({ email: e })} className="ui-focus h-[30px] px-2.5 rounded-[9px] border border-border-strong text-[12px] text-secondary hover:text-text shrink-0">
                    {granting === e ? "Sharing…" : "Give view access"}
                  </button>
                )}
                <button type="button" aria-label={`Remove ${e}`} onClick={() => setEmails((cur) => cur.filter((x) => x !== e))} className="ui-focus w-7 h-7 rounded-[8px] grid place-items-center text-muted hover:text-text">
                  <CloseIcon size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
        <label className="h-10 px-3 rounded-[12px] border border-dashed border-border-strong flex items-center gap-2 text-muted text-ui">
          +
          <input
            type="email"
            value={entry}
            onChange={(e) => setEntry(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                addEmail();
              }
            }}
            onBlur={addEmail}
            placeholder="Add a person or an email"
            aria-label="Add a person or an email"
            className="flex-1 bg-transparent border-0 outline-none text-text placeholder:text-faint"
          />
        </label>
      </div>

      <div className="px-6 sm:px-7 pt-5 flex flex-col gap-2.5">
        <span className="font-mono text-[11px] tracking-[0.14em] text-muted">WHERE</span>
        <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 200px), 1fr))" }}>
          <Place on={inApp} onToggle={() => setInApp((v) => !v)} title="In Euliv" text="The bell, and a pop-up on any Euliv tab" data="in_app" />
          <Place
            on={byEmail}
            onToggle={() => setByEmail((v) => !v)}
            title="Email"
            text={rec && !rec.email_ready ? "Email isn't set up on this server yet - the bell still works" : "Each person's inbox"}
            data="email"
          />
          {extras.map((x, i) => (
            <div key={x.kind} className="rounded-[14px] border border-kind-alert bg-kind-alert-fill p-3 flex flex-col gap-2" data-extra={x.kind}>
              <span className="flex items-center justify-between gap-2">
                <b className="text-ui text-text">{EXTRA_INFO[x.kind].name}</b>
                <button type="button" aria-label={`Remove ${EXTRA_INFO[x.kind].name}`} onClick={() => setExtras((cur) => cur.filter((_, j) => j !== i))} className="ui-focus w-6 h-6 rounded-[7px] grid place-items-center text-muted hover:text-text">
                  <CloseIcon size={12} />
                </button>
              </span>
              <input
                value={x.url}
                onChange={(e) => setExtras((cur) => cur.map((y, j) => (j === i ? { ...y, url: e.target.value } : y)))}
                placeholder={EXTRA_INFO[x.kind].urlHint}
                aria-label={`${EXTRA_INFO[x.kind].name} webhook link`}
                className="h-8 rounded-[9px] border border-border bg-base px-2 text-[12px] text-text font-mono"
              />
              <input
                value={x.label}
                onChange={(e) => setExtras((cur) => cur.map((y, j) => (j === i ? { ...y, label: e.target.value } : y)))}
                placeholder={EXTRA_INFO[x.kind].labelHint}
                aria-label={`${EXTRA_INFO[x.kind].name} name`}
                className="h-8 rounded-[9px] border border-border bg-base px-2 text-[12px] text-text"
              />
            </div>
          ))}
          {extras.length < 3 && (
            <div className="relative">
              <button
                type="button"
                onClick={() => setMoreOpen((v) => !v)}
                aria-expanded={moreOpen}
                className="ui-focus w-full h-full min-h-[76px] rounded-[14px] border border-dashed border-border-strong p-3 flex flex-col items-start justify-center gap-1 text-left hover:border-kind-alert-border"
                data-add-more=""
              >
                <b className="text-ui text-text">+ Add more</b>
                <span className="text-[12px] text-muted">Another app your team uses</span>
              </button>
              {moreOpen && (
                <div role="menu" className="absolute z-10 left-0 right-0 top-[calc(100%+6px)] rounded-[14px] border border-border-strong bg-surface shadow-pop p-1.5 flex flex-col min-w-[240px]">
                  {(["slack", "teams", "webhook"] as Extra["kind"][]).filter((k) => !extras.some((x) => x.kind === k)).map((k) => (
                    <button
                      key={k}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setExtras((cur) => [...cur, { kind: k, url: "", label: "" }]);
                        setMoreOpen(false);
                      }}
                      className="ui-focus text-left px-3 py-2 rounded-[10px] hover:bg-subtle flex flex-col"
                    >
                      <span className="text-ui text-text">{EXTRA_INFO[k].name}</span>
                      <span className="text-[12px] text-muted">{EXTRA_INFO[k].hint}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="px-6 sm:px-7 pt-5 grid gap-4 sm:grid-cols-2">
        <fieldset className="m-0 p-0 border-0 flex flex-col gap-2">
          <legend className="font-mono text-[11px] tracking-[0.14em] text-muted pb-2">HOW OFTEN</legend>
          <label className="flex items-start gap-2.5 text-ui text-text cursor-pointer">
            <input type="radio" name="alert-remind" checked={remind === "once"} onChange={() => setRemind("once")} className="mt-[3px] w-4 h-4 accent-[rgb(var(--color-kind-alert))] m-0" />
            <span>Once when it crosses <span className="text-muted">· recommended</span><br /><span className="text-[12px] text-muted">Again only after it recovers and crosses again</span></span>
          </label>
          <label className="flex items-start gap-2.5 text-ui text-text cursor-pointer">
            <input type="radio" name="alert-remind" checked={remind === "daily"} onChange={() => setRemind("daily")} className="mt-[3px] w-4 h-4 accent-[rgb(var(--color-kind-alert))] m-0" data-remind-daily="" />
            <span>Every day while it's past the line<br /><span className="text-[12px] text-muted">A reminder each day until it recovers</span></span>
          </label>
        </fieldset>
        <div className="flex flex-col gap-2">
          <span className="font-mono text-[11px] tracking-[0.14em] text-muted pb-2">WHEN IT ARRIVES</span>
          <span className="text-ui text-text">The moment it happens - day or night</span>
          <span className="text-[12px] text-muted leading-snug">No quiet hours: Euliv checks every hour and tells people as soon as the number crosses, so nobody hears about it the next morning.</span>
        </div>
      </div>

      {(err || blocked.length > 0) && (
        <div className="px-6 sm:px-7 pt-4 flex flex-col gap-1.5">
          {blocked.length > 0 && !blocked.every((p) => guestOk.has(p.email.toLowerCase())) && (
            <span className="text-caption text-warning">
              {blocked.filter((p) => !guestOk.has(p.email.toLowerCase())).map((p) => p.name).join(", ")} can't open the dashboard - they'll get the numbers in the alert only.
            </span>
          )}
          {err && <span role="alert" className="text-ui text-danger">{err}</span>}
        </div>
      )}

      <div className="mt-5 px-6 sm:px-7 py-4 border-t border-border flex items-center gap-2.5 flex-wrap">
        <span className="flex-1 min-w-[200px] text-caption text-muted">
          {personCount} {personCount === 1 ? "person" : "people"} · {placeCount} {placeCount === 1 ? "place" : "places"}. Pause or change it any time in{" "}
          <Link to="/automations" className="underline hover:text-text">Automations</Link>.
        </span>
        <button type="button" className="btn-secondary text-sm" onClick={onClose} disabled={busy}>Back</button>
        <button
          type="button"
          onClick={submit}
          disabled={busy || !rec}
          className="ui-focus h-[42px] px-[18px] rounded-[12px] bg-kind-alert text-[rgb(var(--color-base))] text-[14px] font-semibold disabled:opacity-60 inline-flex items-center gap-2"
          data-turn-on-alert=""
        >
          {busy && <Spinner className="!w-3.5 !h-3.5" />} Turn on alert
        </button>
      </div>
    </Modal>
  );
}

function Place({ on, onToggle, title, text, data }: { on: boolean; onToggle: () => void; title: string; text: string; data: string }) {
  return (
    <label className={`rounded-[14px] border p-3 flex flex-col gap-1.5 cursor-pointer transition-colors ${on ? "border-kind-alert bg-kind-alert-fill" : "border-border hover:border-border-strong"}`} data-place={data}>
      <span className="flex items-center justify-between gap-2">
        <b className="text-ui text-text">{title}</b>
        <input type="checkbox" checked={on} onChange={onToggle} className="w-4 h-4 accent-[rgb(var(--color-kind-alert))] m-0" />
      </span>
      <span className="text-[12px] text-secondary leading-snug">{text}</span>
    </label>
  );
}
