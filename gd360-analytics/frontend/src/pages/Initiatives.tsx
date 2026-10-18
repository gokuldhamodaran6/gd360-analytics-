// 2026-10-10: Initiatives hub - every event, webinar, campaign, account-based
// push, hire and build in one place: what needs you today, how each one is
// pacing against its targets, and one line to plan the next.
import ThemeToggle from "../components/ThemeToggle";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import AppSidebar from "../components/AppSidebar";
import TopNav from "../components/TopNav";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";
import { Hub, initiativesApi, InitiativeSummary, Kind, errorText } from "../api/initiatives";
import { eventApi } from "../api/eventos";
import { Banner, daysLabel, Empty, fmtDate, HealthPill, KIND_LABEL, KindBadge, KindGlyph, KindTile, Meter, Section, Stat, tone } from "../initiatives/ui";
import { autopilotApi, Brain, Decisions } from "../api/autopilot";
import { DecisionsPanel } from "../autopilot/kit";

const STARTERS: { kind: Kind; label: string; brief: string }[] = [
  { kind: "event", label: "Event", brief: "Host an in-person customer event" },
  { kind: "webinar", label: "Webinar", brief: "Run a webinar for our target accounts" },
  { kind: "campaign", label: "Campaign", brief: "Launch an email and LinkedIn campaign" },
  { kind: "abm", label: "Account-based", brief: "Target our top 500 accounts" },
  { kind: "hiring", label: "Hiring", brief: "Hire engineers for the team" },
  { kind: "product", label: "Product build", brief: "Build and launch a new product feature" },
  { kind: "custom", label: "Anything else", brief: "" },
];

// 2026-10-17 (R53): `events` renders the same hub as GD360 Events - only events and webinars, its own name.
export default function Initiatives({ events = false }: { events?: boolean } = {}) {
  const { workspaces, activeWorkspaceId, switchWorkspace, handleWorkspaceCreated } = useWorkspaceNav();
  const nav = useNavigate();
  const [hub, setHub] = useState<Hub | null>(null);
  const [error, setError] = useState("");
  const [brief, setBrief] = useState("");
  const [kind, setKind] = useState<Kind | "">("");
  const [filter, setFilter] = useState<"active" | "done" | "all">("active");
  const [dept, setDept] = useState("");
  const [sampleBusy, setSampleBusy] = useState<string | null>(null);
  const sample = async (stage: "before" | "live" | "done") => {
    setSampleBusy(stage); setError("");
    try { const r = await eventApi.sample(stage, activeWorkspaceId); nav(`/initiatives/${r.id}`); }
    catch (e) { setError(errorText(e, "Couldn't create the sample event.")); setSampleBusy(null); }
  };

  const [decisions, setDecisions] = useState<Decisions | null>(null);
  const [brain, setBrain] = useState<Brain | null>(null);
  const loadDecisions = () => { if (activeWorkspaceId) autopilotApi.decisions(activeWorkspaceId).then(setDecisions).catch(() => undefined); };
  useEffect(() => {
    if (!activeWorkspaceId) return;
    setHub(null);
    initiativesApi.hub(activeWorkspaceId).then(setHub).catch((e) => setError(errorText(e, "Couldn't load initiatives.")));
    loadDecisions();
    autopilotApi.brain(activeWorkspaceId).then(setBrain).catch(() => undefined);
  }, [activeWorkspaceId]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = (k?: Kind, b?: string) => {
    const text = (b ?? brief).trim();
    const p = new URLSearchParams();
    if (text) p.set("brief", text);
    if (k || kind || events) p.set("kind", (k || kind || "event") as string);
    nav(`/initiatives/new?${p.toString()}`);
  };

  const list = useMemo(() => {
    const all = (hub?.initiatives || []).filter((i) => !events || i.kind === "event" || i.kind === "webinar");
    return all.filter((i) => (filter === "all" ? true : filter === "done" ? i.status === "done" : i.status !== "done"))
      .filter((i) => !dept || (i.department || "Other") === dept);
  }, [hub, filter, dept, events]);
  const departments = useMemo(() => Array.from(new Set((hub?.initiatives || []).map((i) => i.department || "Other"))).sort(), [hub]);

  return (
    <div className="dash-shell flex min-h-screen">
      <AppSidebar workspaces={workspaces} activeWorkspaceId={activeWorkspaceId} onWorkspaceSwitch={switchWorkspace} onWorkspaceCreated={handleWorkspaceCreated} />
      <div className="flex-1 min-w-0 flex flex-col">
        <TopNav breadcrumb={[{ label: events ? "GD360 Events" : "Initiatives" }]} />
        <header className="flex flex-wrap justify-between items-end gap-4 px-4 sm:px-8 pt-7 pb-5 border-b border-border">
          <div className="flex flex-col gap-1.5 min-w-0">
            <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">Plan · Run · Prove{events ? " · GD360 Events" : ""}</span>
            <h1 className="m-0 text-[24px] font-semibold tracking-tight text-text">{events ? "Events" : "Initiatives"}</h1>
            <p className="m-0 text-ui text-secondary max-w-[640px]">{events ? "In-person events, webinars, online events and meetups - registration, check-in, buzz, the live floor, Webinar 360 and the A–Z report, tracked by themselves."
              : "Events, webinars, campaigns, account-based marketing, hiring and product builds - planned with you, tracked automatically, measured against their targets."}</p>
          </div>
          <div className="flex gap-2 flex-wrap items-center">
            <ThemeToggle />
            <Link to="/initiatives/autopilot" className="btn-secondary text-sm inline-flex items-center gap-2" data-go-autopilot="">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" /></svg>
              Autopilot
            </Link>
            <Link to="/accounts" className="btn-secondary text-sm inline-flex items-center gap-2" data-go-accounts="">
              <KindGlyph kind="abm" size={15} /> Accounts{hub ? <span className="text-muted tabular-nums">{hub.counts.accounts.toLocaleString()}</span> : null}
            </Link>
            <button type="button" className="btn-primary text-sm" onClick={() => start()} data-new-initiative="">New initiative</button>
          </div>
        </header>

        <main className="px-4 sm:px-8 py-6 flex flex-col gap-6 pb-16">
          {error && <Banner kind="error" onClose={() => setError("")}>{error}</Banner>}

          <section className="rounded-card border border-border bg-surface p-5 sm:p-6 flex flex-col gap-4" data-planner-composer="">
            <div>
              <div className="text-section font-semibold text-text">What are you planning?</div>
              <p className="m-0 mt-1 text-caption text-muted">Describe it in a sentence. GD360 writes the plan, the targets, the team roles and how every number will be tracked.</p>
            </div>
            <form className="flex gap-2 flex-wrap sm:flex-nowrap" onSubmit={(e) => { e.preventDefault(); start(); }}>
              <input className="input flex-1 min-w-0" value={brief} onChange={(e) => setBrief(e.target.value)} maxLength={4000}
                placeholder="e.g. A customer showcase in Austin in mid-November for our US accounts" aria-label="What are you planning" data-brief="" />
              <button type="submit" className="btn-primary text-sm shrink-0" disabled={!brief.trim() && !kind}>Plan it</button>
            </form>
            <div className="flex gap-2 flex-wrap" role="group" aria-label="Kind of initiative">
              {STARTERS.filter((s) => !events || s.kind === "event" || s.kind === "webinar").map((s) => {
                const on = kind === s.kind;
                const c = tone(s.kind);
                return (
                  <button key={s.kind} type="button" data-starter={s.kind}
                    onClick={() => { setKind(on ? "" : s.kind); if (!brief.trim() && s.brief) setBrief(s.brief); }}
                    className="ui-focus inline-flex items-center gap-1.5 h-[32px] px-3 rounded-full border text-caption transition-colors"
                    style={on ? { color: `rgb(${c})`, background: `rgb(${c} / 0.12)`, borderColor: `rgb(${c} / 0.45)` } : undefined}
                    aria-pressed={on}>
                    <span style={{ color: `rgb(${c})` }}><KindGlyph kind={s.kind} size={14} /></span>
                    <span className={on ? "" : "text-secondary"}>{s.label}</span>
                  </button>
                );
              })}
            </div>
          </section>

          {decisions && decisions.total > 0 && <DecisionsPanel d={decisions} canEdit onChanged={loadDecisions} showInitiative />}
          {brain && !events && (
            <section className="rounded-card border border-border bg-surface p-4 sm:p-5 flex flex-wrap items-center gap-4 justify-between" data-brain-card="">
              <div className="min-w-0 flex-[1_1_420px]">
                <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">Business brain</span>
                <div className="text-ui text-text mt-0.5">{brain.about || "Tell GD360 what you do, and every plan starts from it."}</div>
                <div className="text-caption text-muted mt-0.5">{brain.industry_label ? `${brain.industry_label} · ` : ""}{brain.facts.length} facts from {brain.sources.length} source{brain.sources.length === 1 ? "" : "s"}{brain.website ? ` · ${brain.website.replace(/^https?:\/\//, "")}` : ""}</div>
              </div>
              <Link to="/initiatives/autopilot" className="btn-secondary text-sm shrink-0" data-open-brain="">{brain.about ? "Open" : "Set it up"}</Link>
            </section>
          )}
          <section className="relative overflow-hidden rounded-card border border-border bg-surface p-5 sm:p-6 flex flex-wrap items-center gap-5" data-event-sample="">
            <div className="pointer-events-none absolute -right-16 -top-20 w-[420px] h-[240px]" style={{ background: "radial-gradient(closest-side, rgb(var(--color-primary) / 0.14), transparent)" }} />
            <div className="flex flex-col gap-1 min-w-0 flex-[1_1_380px] relative">
              <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-brand-ink">New · Event OS</span>
              <div className="text-section font-semibold text-text">One event, tracked from the first sign-up to the last post</div>
              <p className="m-0 text-caption text-muted max-w-[620px]">Event 360, the success score, registrations against forecast, every post with its picture, the live floor, sponsors and the A–Z report. Open a sample to see every screen with realistic made-up data.</p>
            </div>
            <div className="flex gap-2 flex-wrap relative">
              {([["before", "24 days before"], ["live", "Live day"], ["done", "After the event"]] as const).map(([k, l]) => (
                <button key={k} type="button" className={k === "done" ? "btn-primary text-sm" : "btn-secondary text-sm"} disabled={!!sampleBusy} onClick={() => sample(k)} data-sample-stage={k}>
                  {sampleBusy === k ? "Building…" : l}</button>
              ))}
            </div>
          </section>

          <div className="flex gap-6 flex-wrap items-start">
            <Section title="Needs you today" sub="Overdue and due tasks, reminders, and accounts that just got active." className="flex-[2_1_480px]">
              {!hub ? <Skeleton rows={3} /> : hub.needs_you.length === 0 ? (
                <p className="m-0 text-ui text-muted">Nothing needs you right now.</p>
              ) : (
                <ul className="m-0 p-0 list-none flex flex-col divide-y divide-border" data-needs-you="">
                  {hub.needs_you.slice(0, 10).map((n) => (
                    <li key={`${n.type}-${n.id}`} className="py-2.5 flex items-center gap-3 min-w-0">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${n.type === "task" ? (n.overdue ? "bg-danger" : "bg-warning") : n.type === "reminder" ? "bg-primary" : "bg-series-2"}`} />
                      <div className="min-w-0 flex-1">
                        <Link to={n.type === "surge" ? `/accounts?account=${n.account_id}` : n.initiative_id ? `/initiatives/${n.initiative_id}${n.type === "task" ? "?tab=plan" : ""}` : n.account_id ? `/accounts?account=${n.account_id}` : "/initiatives"}
                          className="text-ui text-text hover:underline block truncate">{n.title}</Link>
                        <span className="text-caption text-muted">
                          {n.type === "task" ? `${n.initiative} · ${n.overdue ? "Overdue since" : "Due"} ${fmtDate(n.due_on)}`
                            : n.type === "reminder" ? `Reminder${n.account ? ` · ${n.account}` : ""}` : n.detail}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
            <Section title="At a glance" className="flex-[1_1_260px]">
              {!hub ? <Skeleton rows={2} /> : (
                <div className="grid grid-cols-2 gap-5">
                  <Stat label="Active" value={hub.counts.active} />
                  <Stat label="At risk" value={hub.counts.at_risk} tone={hub.counts.at_risk ? "danger" : undefined} />
                  <Stat label="Finished" value={hub.counts.done} />
                  <Stat label="Target accounts" value={hub.counts.accounts.toLocaleString()} />
                </div>
              )}
            </Section>
          </div>

          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="inline-flex p-[3px] rounded-full border border-border bg-base" role="tablist" aria-label="Status">
              {(["active", "done", "all"] as const).map((f) => (
                <button key={f} type="button" role="tab" aria-selected={filter === f} onClick={() => setFilter(f)}
                  className={`ui-focus h-8 px-3.5 rounded-full text-caption ${filter === f ? "bg-surface2 text-text font-medium" : "text-muted hover:text-text"}`}>
                  {f === "active" ? "In progress" : f === "done" ? "Finished" : "All"}
                </button>
              ))}
            </div>
            {departments.length > 1 && (
              <select className="input !w-auto !py-1.5 text-caption" value={dept} onChange={(e) => setDept(e.target.value)} aria-label="Department">
                <option value="">All departments</option>
                {departments.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            )}
          </div>

          {!hub ? <div className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(320px,1fr))]">{[0, 1, 2].map((i) => <div key={i} className="h-[220px] rounded-card bg-surface2 animate-pulse" />)}</div>
            : list.length === 0 ? (
              <Empty title={filter === "done" ? "Nothing finished yet" : "No initiatives yet"}
                body="Plan an event, a webinar, a campaign, a hiring push or a product build. GD360 sets the targets and tracks the numbers for you."
                action={<button type="button" className="btn-primary text-sm" onClick={() => start()}>Plan the first one</button>} />
            ) : (
              <div className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(320px,1fr))]" data-initiative-grid="">
                {list.map((i) => <Card key={i.id} i={i} />)}
              </div>
            )}
        </main>
      </div>
    </div>
  );
}

function Card({ i }: { i: InitiativeSummary }) {
  const lead = i.targets.find((t) => t.target) || null;
  const pct = i.tasks_total ? Math.round((100 * i.tasks_done) / i.tasks_total) : 0;
  return (
    <Link to={`/initiatives/${i.id}`} className="ui-focus group rounded-card border border-border bg-surface p-5 flex flex-col gap-4 hover:border-border-strong transition-colors min-w-0" data-initiative-card={i.kind}>
      <div className="flex items-start gap-3 min-w-0">
        <KindTile kind={i.kind} />
        <div className="min-w-0 flex-1">
          <div className="text-section font-semibold text-text leading-snug line-clamp-2 group-hover:underline decoration-border-strong underline-offset-4">{i.title}</div>
          <div className="text-caption text-muted mt-0.5 truncate">
            {KIND_LABEL[i.kind]}{i.department ? ` · ${i.department}` : ""}{i.key_date ? ` · ${fmtDate(i.key_date, true)}` : ""}{i.location ? ` · ${i.location}` : ""}
          </div>
        </div>
        {i.days_to_go !== null && i.status !== "done" && i.days_to_go >= 0 && (
          <span className="shrink-0 text-right">
            <span className="block text-[20px] leading-none font-semibold tabular-nums text-text">{i.days_to_go}</span>
            <span className="text-[11px] text-muted">days</span>
          </span>
        )}
      </div>
      <HealthPill health={i.health} />
      {lead ? <Meter t={lead} compact /> : <span className="text-caption text-muted">No targets yet</span>}
      <div className="mt-auto pt-3 border-t border-border flex items-center justify-between gap-3 text-caption">
        <span className="text-secondary truncate min-w-0">{i.next_task ? <>Next: {i.next_task.title}{i.next_task.due_on ? <span className="text-muted"> · {daysLabel(dayDiff(i.next_task.due_on))}</span> : null}</> : "All tasks done"}</span>
        <span className="tabular-nums text-muted shrink-0">{i.tasks_done}/{i.tasks_total} · {pct}%</span>
      </div>
    </Link>
  );
}

function dayDiff(iso: string): number {
  const d = new Date(`${iso}T00:00:00`);
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - t.getTime()) / 86400000);
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return <div className="flex flex-col gap-2">{Array.from({ length: rows }).map((_, i) => <div key={i} className="h-9 rounded-ctl bg-surface2 animate-pulse" />)}</div>;
}

export { KindBadge };
