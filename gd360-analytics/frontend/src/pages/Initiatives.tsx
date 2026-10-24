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
import { Ic } from "../studio/icons";
import { Kpi, ListPage, PageHead, Tabs } from "../studio/Page";

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

  const counts = useMemo(() => {
    const all = (hub?.initiatives || []).filter((i) => !events || i.kind === "event" || i.kind === "webinar");
    return { active: all.filter((i) => i.status === "active").length, planning: all.filter((i) => i.status === "planning").length, done: all.filter((i) => i.status === "done").length, all: all.length };
  }, [hub, events]);
  const withEvidence = useMemo(() => {
    const ts = (hub?.initiatives || []).flatMap((i) => i.targets.filter((t) => t.actual !== null));
    if (!ts.length) return null;
    return Math.round((100 * ts.filter((t) => t.truth === "counted" || t.truth === "matched").length) / ts.length);
  }, [hub]);
  void TopNav; void ThemeToggle; void switchWorkspace; void handleWorkspaceCreated; void workspaces; void AppSidebar; void Section; void Stat;
  const side = (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {!(decisions && decisions.total > 0) && (
        <div className="sdp-sidecard"><b style={{ fontSize: 14.5 }}>Decisions for you</b><span className="sd-sub">Nothing waiting. Agents ask here before they act, inside the policy you set in Autopilot.</span></div>
      )}
      <div className="sdp-sidecard" data-needs-you-card="">
        <b style={{ fontSize: 14.5 }}>Needs you today</b>
        {!hub ? <Skeleton rows={3} /> : hub.needs_you.length === 0 ? <span className="sd-sub">Nothing needs you right now.</span> : (
          <ul className="m-0 p-0 list-none flex flex-col" data-needs-you="">
            {hub.needs_you.slice(0, 8).map((n) => (
              <li key={`${n.type}-${n.id}`} style={{ padding: "8px 0", borderTop: "1px solid rgb(var(--color-border))", display: "flex", gap: 8, alignItems: "flex-start" }}>
                <span className={`sd-dot ${n.type === "task" ? (n.overdue ? "bad" : "warn") : n.type === "reminder" ? "good" : "violet"}`} style={{ marginTop: 7 }} />
                <span style={{ minWidth: 0 }}>
                  <Link to={n.type === "surge" ? `/accounts?account=${n.account_id}` : n.initiative_id ? `/initiatives/${n.initiative_id}${n.type === "task" ? "?tab=plan" : ""}` : n.account_id ? `/accounts?account=${n.account_id}` : "/initiatives"} style={{ fontSize: 13.5 }}>{n.title}</Link>
                  <span className="sd-sub" style={{ display: "block", fontSize: 12 }}>{n.type === "task" ? `${n.initiative} · ${n.overdue ? "Overdue since" : "Due"} ${fmtDate(n.due_on)}` : n.type === "reminder" ? `Reminder${n.account ? ` · ${n.account}` : ""}` : n.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {brain && !events && (
        <div className="sdp-sidecard" data-brain-card="">
          <span className="sd-lbl">Business brain</span>
          <span style={{ fontSize: 13.5 }}>{brain.about || "Tell Euliv what you do, and every plan starts from it."}</span>
          <span className="sd-sub" style={{ fontSize: 12 }}>{brain.industry_label ? `${brain.industry_label} · ` : ""}{brain.facts.length} facts from {brain.sources.length} source{brain.sources.length === 1 ? "" : "s"}{brain.website ? ` · ${brain.website.replace(/^https?:\/\//, "")}` : ""}</span>
          <Link to="/initiatives/autopilot" className="sd-pill sm" style={{ alignSelf: "flex-start" }} data-open-brain="">{brain.about ? "Open" : "Set it up"}</Link>
        </div>
      )}
    </div>
  );
  return (
    <ListPage data="initiatives" crumbs={[{ label: events ? "Euliv Events" : "Initiatives", to: "/initiatives" }, { label: events ? "Events" : "Portfolio" }]} side={side}>
      <PageHead title={events ? "Events" : "Portfolio"}
        sub={events ? "In-person events, webinars and meetups - registration, check-in, the live floor and the A–Z report, tracked by themselves."
          : "Events, campaigns, launches, hiring and programs - each measured against its targets, with evidence."}
        actions={<>
          <Link to="/initiatives/autopilot" className="sd-pill" data-go-autopilot=""><Ic n="spark" />Autopilot</Link>
          <Link to="/accounts" className="sd-pill" data-go-accounts="">Accounts{hub ? <span className="sd-mono sd-sub" style={{ fontSize: 12 }}>{hub.counts.accounts.toLocaleString()}</span> : null}</Link>
          <button type="button" className="sd-btnp" onClick={() => start()} data-new-initiative="">New initiative</button>
        </>} />
      {error && <Banner kind="error" onClose={() => setError("")}>{error}</Banner>}
      {decisions && decisions.total > 0 && <DecisionsPanel d={decisions} canEdit onChanged={loadDecisions} showInitiative />}
      <div className="sd-kpis">
        <Kpi label="Active" value={hub ? counts.active : "–"} note={hub && counts.planning ? `${counts.planning} planning` : undefined} />
        <Kpi label="At risk" value={hub ? hub.counts.at_risk : "–"} tone={hub?.counts.at_risk ? "bad" : undefined} note="from the pace forecast" />
        <Kpi label="Finished" value={hub ? counts.done : "–"} />
        <Kpi label="Numbers with evidence" value={withEvidence != null ? `${withEvidence}%` : "–"} note="counted or matched, not typed" />
      </div>
      <form className="sd-card" style={{ padding: 12, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }} onSubmit={(e) => { e.preventDefault(); start(); }} data-planner-composer="">
        <input className="sd-in" style={{ flex: "1 1 320px", border: 0 }} value={brief} onChange={(e) => setBrief(e.target.value)} maxLength={4000}
          placeholder="What are you planning? e.g. A customer showcase in Austin in mid-November" aria-label="What are you planning" data-brief="" />
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }} role="group" aria-label="Kind of initiative">
          {STARTERS.filter((x) => !events || x.kind === "event" || x.kind === "webinar").slice(0, 6).map((x) => (
            <button key={x.kind} type="button" data-starter={x.kind} className={`sd-pill sm${kind === x.kind ? " on" : ""}`} aria-pressed={kind === x.kind}
              onClick={() => { setKind(kind === x.kind ? "" : x.kind); if (!brief.trim() && x.brief) setBrief(x.brief); }}>{x.label}</button>
          ))}
        </div>
        <button type="submit" className="sd-btnp" disabled={!brief.trim() && !kind}>Plan it</button>
      </form>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Tabs<"active" | "done" | "all"> tabs={[{ id: "active", label: "In progress", n: hub ? counts.active + counts.planning : null }, { id: "done", label: "Finished", n: hub ? counts.done : null }, { id: "all", label: "All", n: hub ? counts.all : null }]} value={filter} onChange={setFilter} />
        </div>
        {departments.length > 1 && (
          <select className="sdp-sel" value={dept} onChange={(e) => setDept(e.target.value)} aria-label="Department">
            <option value="">All departments</option>
            {departments.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        )}
      </div>
      {!hub ? <Skeleton rows={4} /> : list.length === 0 ? (
        <Empty title={filter === "done" ? "Nothing finished yet" : "No initiatives yet"}
          body="Plan an event, a webinar, a campaign, a hiring push or a product build. Euliv sets the targets and tracks the numbers for you."
          action={<button type="button" className="sd-btnp" onClick={() => start()}>Plan the first one</button>} />
      ) : (
        <div className="sd-card" style={{ overflow: "hidden" }} data-initiative-grid="">
          <div className="sd-tw">
            <table className="sd-t">
              <thead><tr><th>Initiative</th><th>Dates</th><th>Lead target</th><th>Health</th><th className="r">Tasks</th><th>Evidence</th></tr></thead>
              <tbody>{list.map((i) => <Row key={i.id} i={i} onOpen={() => nav(`/initiatives/${i.id}`)} />)}</tbody>
            </table>
          </div>
          <div className="sdp-tfoot">Health is the chance of reaching the lead target by the end date, from the pace so far.</div>
        </div>
      )}
      <section className="sd-card" style={{ padding: 16, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 14 }} data-event-sample="">
        <div style={{ flex: "1 1 360px", minWidth: 0 }}>
          <span className="sd-lbl">Event OS · sample</span>
          <div style={{ fontSize: 14.5, fontWeight: 600, marginTop: 2 }}>One event, tracked from the first sign-up to the last post</div>
          <div className="sd-sub" style={{ marginTop: 2 }}>Open a sample event with realistic made-up data, clearly labelled as a sample.</div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {([["before", "24 days before"], ["live", "Live day"], ["done", "After the event"]] as const).map(([k, l]) => (
            <button key={k} type="button" className="sd-pill sm" disabled={!!sampleBusy} onClick={() => sample(k)} data-sample-stage={k}>{sampleBusy === k ? "Building…" : l}</button>
          ))}
        </div>
      </section>
    </ListPage>
  );
}

function Row({ i, onOpen }: { i: InitiativeSummary; onOpen: () => void }) {
  const lead = i.targets.find((t) => t.target) || null;
  const pct = lead ? (lead.pct ?? (lead.actual !== null && lead.target ? (100 * Number(lead.actual)) / Number(lead.target) : null)) : null;
  const truth = lead?.truth;
  return (
    <tr className="click" onClick={onOpen} data-initiative-card={i.kind}>
      <td style={{ maxWidth: 320 }}>
        <Link to={`/initiatives/${i.id}`} onClick={(e) => e.stopPropagation()} style={{ fontWeight: 500 }}>{i.title}</Link>
        <span className="sd-sub" style={{ display: "block", fontSize: 12 }}>{KIND_LABEL[i.kind]}{i.department ? ` · ${i.department}` : ""}{i.location ? ` · ${i.location}` : ""}</span>
      </td>
      <td className="sd-sub" style={{ fontSize: 13.5 }}>{i.key_date ? fmtDate(i.key_date, true) : i.starts_on ? fmtDate(i.starts_on, true) : "—"}{i.days_to_go !== null && i.status !== "done" && i.days_to_go >= 0 ? <span style={{ display: "block", fontSize: 12 }}>{i.days_to_go} days to go</span> : null}</td>
      <td style={{ minWidth: 220 }}>{lead ? (
        <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ width: 90, height: 6, borderRadius: 3, background: "rgb(var(--color-surface2))", overflow: "hidden", flex: "0 0 auto" }}><i style={{ display: "block", height: "100%", width: `${Math.max(0, Math.min(100, pct ?? 0))}%`, background: "rgb(var(--sd-c1))" }} /></span>
          <span className="sd-mono" style={{ fontSize: 12.5 }}>{lead.actual != null ? Number(lead.actual).toLocaleString() : "–"} / {Number(lead.target).toLocaleString()} {lead.label.toLowerCase()}</span>
        </span>) : <span className="sd-sub">No targets yet</span>}</td>
      <td style={{ maxWidth: 230, overflow: "hidden" }}><HealthPill health={i.health} /></td>
      <td className="num">{i.tasks_done}/{i.tasks_total}</td>
      <td>{truth && truth !== "none" ? <span className="sd-chip"><span className={`sd-dot ${truth === "counted" ? "good" : truth === "matched" ? "blue" : truth === "modelled" ? "violet" : "warn"}`} />{truth === "typed" ? "Typed by owner" : truth.charAt(0).toUpperCase() + truth.slice(1)}</span> : <span className="sd-sub">—</span>}</td>
    </tr>
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
