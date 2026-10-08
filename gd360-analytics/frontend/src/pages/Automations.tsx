// 2026-10-08 (round 12): Automations - work that runs by itself. Each one
// reads as a sentence: WHEN (violet) -> DO (mint) -> TELL (blue). Below the
// list, how fresh every source is, so it is clear what needs a schedule.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import AppSidebar from "../components/AppSidebar";
import TopNav from "../components/TopNav";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";
import { Automation, AutomationRun, automationsApi, FreshnessRow, whenParts } from "../api/automations";
import { timeAgo } from "../project/format";

function errorText(e: any, fallback: string): string {
  const d = e?.response?.data?.detail;
  return typeof d === "string" && d.trim() ? d : fallback;
}

export function Chip({ part, children }: { part: "when" | "do" | "tell"; children: React.ReactNode }) {
  return (
    <span
      className="inline-flex items-center gap-2 min-h-[30px] px-2.5 py-1 rounded-[7px] border text-ui leading-snug"
      style={{
        color: `rgb(var(--auto-${part}))`,
        background: `rgb(var(--auto-${part}-fill))`,
        borderColor: `rgb(var(--auto-${part}-border) / 0.6)`,
      }}
    >
      <span className="font-mono text-[10px] uppercase opacity-75 shrink-0">{part}</span>
      <span>{children}</span>
    </span>
  );
}

export function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!on);
      }}
      className={`ui-focus relative inline-flex h-[26px] w-[44px] shrink-0 items-center rounded-full transition-colors ${on ? "bg-primary" : "bg-border-strong"} disabled:opacity-50`}
    >
      <span className={`absolute top-[3px] left-[3px] h-5 w-5 rounded-full bg-[#F2F6F4] shadow transition-transform ${on ? "translate-x-[18px]" : ""}`} />
    </button>
  );
}

function nextText(a: Automation): string {
  if (!a.enabled) return "Off";
  if (a.trigger.type === "new_data") return "Next: on new data";
  if (!a.next_run_at) return "";
  const p = whenParts(a.next_run_at, a.timezone);
  const d = new Date(a.next_run_at);
  const now = new Date();
  const sameDay = (x: Date, y: Date) => x.toDateString() === y.toDateString();
  const tomorrow = new Date(now.getTime() + 86400000);
  const label = sameDay(d, now) ? "today" : sameDay(d, tomorrow) ? "tomorrow" : p.day;
  return `${a.trigger.type === "threshold" ? "Next check" : "Next"}: ${label} ${p.time}`;
}

function lastLine(a: Automation): { text: string; tone: "good" | "warn" | "bad" | "muted" } | null {
  if (a.running) return { text: "Running now…", tone: "muted" };
  if (a.trigger.type === "threshold") {
    if (a.triggered && a.triggered.count > 0) {
      const since = a.triggered.since ? whenParts(a.triggered.since, a.timezone).day.replace(/^\w+ /, "") : "";
      return { text: `⚠ Triggered ${a.triggered.count} time${a.triggered.count === 1 ? "" : "s"}${since ? ` since ${since}` : ""}`, tone: "warn" };
    }
    if (a.last_checked_at) return { text: `✓ Checked ${timeAgo(a.last_checked_at)} · ${a.last_value ?? "—"}`, tone: "good" };
    return null;
  }
  const r = a.last_run;
  if (!r) return null;
  if (r.status === "failed") return { text: `✕ ${timeAgo(r.finished_at || r.started_at)} · ${r.error || "failed"}`, tone: "bad" };
  const secs = r.seconds != null ? ` · ${Math.max(1, Math.round(r.seconds))} s` : "";
  return { text: `✓ ${timeAgo(r.finished_at || r.started_at)}${secs}`, tone: "good" };
}

export default function Automations() {
  const navigate = useNavigate();
  const { workspaces, activeWorkspaceId, switchWorkspace, handleWorkspaceCreated } = useWorkspaceNav();
  const [items, setItems] = useState<Automation[] | null>(null);
  const [emailReady, setEmailReady] = useState(true);
  const [fresh, setFresh] = useState<FreshnessRow[] | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const out = await automationsApi.list();
      setItems(out.automations);
      setEmailReady(out.email_ready);
    } catch (e: any) {
      setError(errorText(e, "Couldn't load your automations."));
      setItems([]);
    }
  }, []);

  useEffect(() => {
    load();
    automationsApi.freshness().then(setFresh).catch(() => setFresh([]));
  }, [load]);

  // while anything is running, follow it
  useEffect(() => {
    if (!items?.some((a) => a.running)) return;
    const t = setInterval(load, 1500);
    return () => clearInterval(t);
  }, [items, load]);

  const on = items?.filter((a) => a.enabled).length || 0;
  const off = (items?.length || 0) - on;
  const failing = items?.filter((a) => a.enabled && a.last_status === "failed").length || 0;
  const usesEmail = items?.some((a) => a.tell.email.length > 0);

  const toggle = async (a: Automation, v: boolean) => {
    setItems((list) => list?.map((x) => (x.id === a.id ? { ...x, enabled: v } : x)) || null);
    try {
      const next = await automationsApi.toggle(a.id, v);
      setItems((list) => list?.map((x) => (x.id === a.id ? next : x)) || null);
    } catch (e: any) {
      setError(errorText(e, "Couldn't change that."));
      load();
    }
  };

  return (
    <div className="dash-shell flex min-h-screen">
      <AppSidebar workspaces={workspaces} activeWorkspaceId={activeWorkspaceId} onWorkspaceSwitch={switchWorkspace} onWorkspaceCreated={handleWorkspaceCreated} />
      <div className="flex-1 min-w-0">
        <TopNav hideLogo />
        <main className="px-4 sm:px-8 lg:px-10 py-8 max-w-[1160px] mx-auto flex flex-col gap-7">
          <div className="flex items-end justify-between gap-4 flex-wrap">
            <div className="flex flex-col gap-2">
              <h1 className="m-0 text-[30px] sm:text-[34px] font-bold tracking-tight text-text">Automations</h1>
              <p className="m-0 text-body text-secondary max-w-[60ch]">
                Work that runs by itself. Every automation is three parts — read each one like a sentence.
              </p>
            </div>
            <Link to="/automations/new" className="btn-primary text-sm">+ New automation</Link>
          </div>

          <div className="grid gap-3 grid-cols-1 md:grid-cols-3">
            {([
              ["when", "1 · When", "When it runs", "On a schedule, when new data lands, or when a number crosses a line."],
              ["do", "2 · Do", "What it does", "Refresh a dashboard, check quality, re-run a question, re-score a model — one step or a chain."],
              ["tell", "3 · Tell", "Who hears about it", "Email, Slack or Teams — every time, only when something changes, or only if it fails."],
            ] as const).map(([part, kicker, title, text]) => (
              <div key={part} className="rounded-card border bg-surface p-5 flex flex-col gap-1.5" style={{ borderColor: `rgb(var(--auto-${part}-border))` }}>
                <span className="font-mono text-[11px] uppercase tracking-[0.08em]" style={{ color: `rgb(var(--auto-${part}))` }}>{kicker}</span>
                <span className="text-section font-semibold text-text">{title}</span>
                <span className="text-ui text-muted leading-relaxed">{text}</span>
              </div>
            ))}
          </div>

          {!emailReady && usesEmail && (
            <div role="status" className="rounded-card border border-warning-border bg-warning-fill px-4 py-3 text-ui text-text">
              Email isn't switched on for this GD360 server yet, so email deliveries are recorded but not sent. Slack and Teams work now.
              <span className="text-muted"> (The server needs RESEND_API_KEY or SMTP settings, plus EMAIL_FROM.)</span>
            </div>
          )}
          {error && <div role="alert" className="rounded-card border border-danger-border bg-danger-fill px-4 py-3 text-ui text-text">{error}</div>}

          <section className="flex flex-col gap-3" aria-label="Your automations">
            <div className="flex items-baseline justify-between gap-3 flex-wrap">
              <h2 className="m-0 text-title font-semibold text-text">Your automations{items ? ` · ${items.length}` : ""}</h2>
              {items && items.length > 0 && (
                <span className="text-ui text-muted">
                  {on} on · {off} off · {failing ? <span className="text-danger">{failing} need{failing === 1 ? "s" : ""} attention</span> : "all healthy"}
                </span>
              )}
            </div>
            {!items && <div className="text-ui text-muted">Loading…</div>}
            {items && items.length === 0 && <EmptyState />}
            {items?.map((a) => (
              <AutomationCard
                key={a.id}
                a={a}
                open={open === a.id}
                onOpen={() => setOpen(open === a.id ? null : a.id)}
                onToggle={(v) => toggle(a, v)}
                onEdit={() => navigate(`/automations/${a.id}`)}
                onChanged={load}
                onError={setError}
              />
            ))}
          </section>

          <FreshnessTable rows={fresh} />

          <p className="m-0 text-caption text-muted">
            Looking for dashboard refresh schedules or pipelines made before Automations? They still run — <Link to="/jobs" className="underline hover:text-text">see them here</Link>.
          </p>
        </main>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-card border border-dashed border-border-strong p-6 flex flex-col gap-4">
      <div className="text-section font-semibold text-text">Nothing runs by itself yet</div>
      <p className="m-0 text-ui text-muted max-w-[62ch]">
        Start from a project dashboard (“Deliver on a schedule…”) or an answer (“Set an alert”), or build one here. A few that teams set up first:
      </p>
      <div className="flex flex-col gap-2">
        {[
          ["Every weekday at 6:00 AM", "Refresh a dashboard and summarise what changed", "Email the team"],
          ["Every hour", "Check if mobile conversion drops below 2%", "Slack, only if it happens"],
          ["When new Shopify orders land", "Re-run the revenue question", "Email the owner if it fails"],
        ].map(([w, d, t]) => (
          <div key={w} className="flex flex-wrap items-center gap-2">
            <Chip part="when">{w}</Chip>
            <span className="text-muted" aria-hidden="true">→</span>
            <Chip part="do">{d}</Chip>
            <span className="text-muted" aria-hidden="true">→</span>
            <Chip part="tell">{t}</Chip>
          </div>
        ))}
      </div>
      <Link to="/automations/new" className="btn-primary text-sm self-start">+ New automation</Link>
    </div>
  );
}

function AutomationCard({
  a, open, onOpen, onToggle, onEdit, onChanged, onError,
}: {
  a: Automation; open: boolean; onOpen: () => void; onToggle: (v: boolean) => void; onEdit: () => void; onChanged: () => void; onError: (m: string) => void;
}) {
  const last = lastLine(a);
  const [runs, setRuns] = useState<AutomationRun[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (open) automationsApi.runs(a.id).then(setRuns).catch(() => setRuns([]));
  }, [open, a.id, a.last_run?.id, a.last_run?.status]);

  const runNow = async () => {
    setBusy(true);
    try {
      await automationsApi.runNow(a.id);
      onChanged();
    } catch (e: any) {
      onError(errorText(e, "Couldn't start it."));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    try {
      await automationsApi.remove(a.id);
      onChanged();
    } catch (e: any) {
      onError(errorText(e, "Couldn't delete it."));
    }
  };

  return (
    <article className={`rounded-card border border-border bg-surface transition-opacity ${a.enabled ? "" : "opacity-60"}`}>
      <div className="p-4 sm:p-5 flex flex-col md:flex-row md:items-center gap-4">
        <div className="flex-1 min-w-0 flex flex-col gap-3">
          <button type="button" onClick={onOpen} className="text-left text-section font-semibold text-text hover:underline self-start" aria-expanded={open}>
            {a.name}
          </button>
          <div className="flex flex-wrap items-center gap-2">
            <Chip part="when">{a.sentence.when}</Chip>
            <span className="text-muted" aria-hidden="true">→</span>
            <Chip part="do">{a.sentence.do}</Chip>
            <span className="text-muted" aria-hidden="true">→</span>
            <Chip part="tell">{a.sentence.tell}</Chip>
          </div>
        </div>
        <div className="flex items-center gap-4 md:justify-end shrink-0">
          <div className="flex flex-col items-start md:items-end gap-0.5 text-ui">
            <span className="text-text">{nextText(a)}</span>
            {last && (
              <span className={`text-caption ${last.tone === "good" ? "text-muted" : last.tone === "warn" ? "text-warning" : last.tone === "bad" ? "text-danger" : "text-muted"} max-w-[280px] truncate`} title={last.text}>
                {last.text}
              </span>
            )}
            {!a.enabled && a.last_run_at && <span className="text-caption text-muted">Last ran {timeAgo(a.last_run_at)}</span>}
          </div>
          <Toggle on={a.enabled} onChange={onToggle} label={a.enabled ? `Turn off ${a.name}` : `Turn on ${a.name}`} />
        </div>
      </div>
      {open && (
        <div className="border-t border-border px-4 sm:px-5 py-4 flex flex-col gap-4">
          <div className="flex gap-2 flex-wrap">
            <button type="button" className="btn-secondary text-sm" onClick={runNow} disabled={busy || a.running}>
              {a.running ? "Running…" : a.trigger.type === "threshold" ? "Check now" : "Run now"}
            </button>
            <button type="button" className="btn-secondary text-sm" onClick={onEdit}>Edit</button>
            {confirmDelete ? (
              <>
                <button type="button" className="btn-secondary text-sm !text-danger" onClick={remove}>Delete for good</button>
                <button type="button" className="btn-secondary text-sm" onClick={() => setConfirmDelete(false)}>Keep it</button>
              </>
            ) : (
              <button type="button" className="btn-secondary text-sm" onClick={() => setConfirmDelete(true)}>Delete</button>
            )}
          </div>
          <RunHistory runs={runs} />
        </div>
      )}
    </article>
  );
}

export function RunHistory({ runs }: { runs: AutomationRun[] | null }) {
  if (!runs) return <div className="text-ui text-muted">Loading runs…</div>;
  if (!runs.length) return <div className="text-ui text-muted">No runs yet.</div>;
  return (
    <div className="flex flex-col gap-2" aria-label="Recent runs">
      <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">Recent runs</span>
      {runs.slice(0, 8).map((r) => (
        <RunRow key={r.id} r={r} />
      ))}
    </div>
  );
}

const REASON: Record<string, string> = { schedule: "On schedule", manual: "Run by hand", test: "Test", new_data: "New data", threshold: "Alert" };

export function RunRow({ r }: { r: AutomationRun }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-ctl border border-border bg-base">
      <button type="button" onClick={() => setOpen((v) => !v)} className="w-full flex items-center gap-3 px-3 py-2.5 text-left" aria-expanded={open}>
        <span className={`w-2 h-2 rounded-full shrink-0 ${r.status === "success" ? "bg-good" : r.status === "failed" ? "bg-danger" : "bg-warning animate-pulse"}`} aria-hidden="true" />
        <span className="text-ui text-text">{REASON[r.reason] || r.reason}</span>
        <span className="text-caption text-muted">{timeAgo(r.started_at)}{r.seconds != null ? ` · ${r.seconds} s` : ""}</span>
        <span className="ml-auto text-caption text-muted truncate max-w-[50%]">
          {r.status === "failed" ? r.error : r.deliveries.length ? r.deliveries.map((d) => `${d.channel} ${d.status === "sent" ? "✓" : d.status === "not_configured" ? "(not set up)" : d.status}`).join(" · ") : r.status === "running" ? "running…" : "nothing to send"}
        </span>
      </button>
      {open && (
        <div className="px-3 pb-3 flex flex-col gap-2.5">
          {r.message?.headline && <p className="m-0 text-ui text-text">{r.message.headline}</p>}
          <ol className="m-0 p-0 list-none flex flex-col gap-1">
            {r.steps.map((s) => (
              <li key={s.index} className="flex gap-2 text-caption">
                <span className={s.status === "done" ? "text-good" : s.status === "failed" ? "text-danger" : "text-muted"}>{s.status === "done" ? "✓" : s.status === "failed" ? "✕" : "–"}</span>
                <span className="text-secondary">{s.label}</span>
                {s.error && <span className="text-danger">— {s.error}</span>}
                {s.seconds != null && s.status !== "skipped" && <span className="text-muted ml-auto font-mono">{s.seconds} s</span>}
              </li>
            ))}
          </ol>
          {r.deliveries.map((d, i) => (
            <div key={i} className="text-caption text-muted">
              {d.channel === "email" ? "Email" : d.channel === "slack" ? "Slack" : "Teams"} → {d.to}:{" "}
              <span className={d.status === "sent" ? "text-good" : d.status === "failed" ? "text-danger" : "text-warning"}>
                {d.status === "sent" ? "sent" : d.status === "not_configured" ? "not set up on the server yet" : d.status}
              </span>
              {d.detail && d.status !== "not_configured" ? ` — ${d.detail}` : ""}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FreshnessTable({ rows }: { rows: FreshnessRow[] | null }) {
  const sorted = useMemo(() => {
    const order: Record<string, number> = { LIVE: 0, SYNCED: 1, API: 2, STREAM: 3, FILE: 4 };
    return [...(rows || [])].sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9));
  }, [rows]);
  return (
    <section className="rounded-card border border-border bg-surface p-5 sm:p-6 flex flex-col gap-4" aria-label="How fresh is your data">
      <div className="flex flex-col gap-1.5">
        <h2 className="m-0 text-title font-semibold text-text">How fresh is your data?</h2>
        <p className="m-0 text-ui text-secondary max-w-[75ch] leading-relaxed">
          Live sources are always current — nothing to schedule. Synced apps copy new records on the timing below. Dashboards built on live sources show
          current numbers whenever they are opened; a schedule only matters for emails, reports and alerts.
        </p>
      </div>
      {!rows && <div className="text-ui text-muted">Loading…</div>}
      {rows && rows.length === 0 && <div className="text-ui text-muted">No data sources yet. <Link to="/data" className="underline">Connect one</Link>.</div>}
      {rows && rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-ui border-collapse min-w-[560px]">
            <thead>
              <tr className="text-left">
                {["Source", "Type", "New data arrives", "Last updated"].map((h) => (
                  <th key={h} className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted font-medium px-1 pb-2.5 border-b border-border">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.id} className="border-b border-border last:border-b-0">
                  <td className="px-1 py-3 text-text">{r.name}</td>
                  <td className="px-1 py-3">
                    <span
                      className={`font-mono text-[10.5px] px-1.5 py-0.5 rounded ${r.type === "LIVE" ? "bg-good-fill text-good" : r.type === "SYNCED" ? "bg-[rgb(var(--auto-tell-fill))] text-[rgb(var(--auto-tell))]" : "bg-subtle text-secondary"}`}
                    >
                      {r.type}
                    </span>
                  </td>
                  <td className="px-1 py-3 text-text">{r.arrives}{r.error ? <span className="block text-caption text-danger">{r.error}</span> : null}</td>
                  <td className="px-1 py-3 font-mono text-caption text-muted">{r.type === "LIVE" ? "Now" : r.updated_at ? timeAgo(r.updated_at) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
