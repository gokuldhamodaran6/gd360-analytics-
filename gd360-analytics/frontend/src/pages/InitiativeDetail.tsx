// 2026-10-10: one initiative - the plan, the board, the team and their
// outreach, the people, tracking (links, landing pages, A/B, connected
// data), campaigns, the daily log, and results against targets. The
// assistant answers and acts from the side.
// 2026-10-17 (R53): five tabs - Plan, Evidence, Pace, People, Proof. The old
// nine screens live inside them (old ?tab= links still open the right one).
import ThemeToggle from "../components/ThemeToggle";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import AppSidebar from "../components/AppSidebar";
import TopNav from "../components/TopNav";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";
import { errorText, Initiative, initiativesApi } from "../api/initiatives";
import { Banner, daysLabel, fmtDate, HealthPill, KindBadge, Tabs } from "../initiatives/ui";
import OverviewTab from "../initiatives/OverviewTab";
import PlanTab from "../initiatives/PlanTab";
import BoardTab from "../initiatives/BoardTab";
import TeamTab from "../initiatives/TeamTab";
import AudienceTab from "../initiatives/AudienceTab";
import TrackingTab from "../initiatives/TrackingTab";
import CampaignsPanel from "../initiatives/CampaignsPanel";
import UpdatesTab from "../initiatives/UpdatesTab";
import ResultsTab from "../initiatives/ResultsTab";
import Assistant from "../initiatives/Assistant";
import EventShell from "../eventos/EventShell";
import { Seg } from "../eventos/kit";
import EvidenceTab from "../autopilot/EvidenceTab";
import PaceTab from "../autopilot/PaceTab";
import ProofTab from "../autopilot/ProofTab";
import { DecisionsPanel } from "../autopilot/kit";
import { autopilotApi, Decisions } from "../api/autopilot";

type TabId = "plan" | "evidence" | "pace" | "people" | "proof";
type Legacy = "overview" | "plan" | "board" | "team" | "audience" | "tracking" | "campaigns" | "updates" | "results";
const PEOPLE_KINDS = new Set(["event", "webinar", "campaign", "abm"]);
/** Old tab ids (links in emails, the hub, the account drawer) -> the tab and the view inside it. */
const LEGACY: Record<Legacy, [TabId, string]> = {
  overview: ["plan", "overview"], plan: ["plan", "tasks"], board: ["plan", "board"], team: ["people", "team"], audience: ["people", "audience"],
  tracking: ["evidence", "links"], campaigns: ["people", "campaigns"], updates: ["evidence", "log"], results: ["proof", "results"],
};

export default function InitiativeDetail() {
  const { initiativeId = "" } = useParams();
  const { workspaces, activeWorkspaceId, switchWorkspace, handleWorkspaceCreated } = useWorkspaceNav();
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const [i, setI] = useState<Initiative | null>(null);
  const [error, setError] = useState("");
  const [notFound, setNotFound] = useState(false);
  const [assistant, setAssistant] = useState(false);
  const raw = params.get("tab") || "";
  const [tab, view] = ((): [TabId, string] => {
    const v = params.get("view") || "";
    if (["evidence", "pace", "people", "proof"].includes(raw)) return [raw as TabId, v];
    if (raw === "plan" && v) return ["plan", v];
    if (raw in LEGACY) return LEGACY[raw as Legacy];
    return ["plan", v || "overview"];
  })();
  const [decisions, setDecisions] = useState<Decisions | null>(null);
  const loadDecisions = useCallback(() => {
    autopilotApi.one(initiativeId).then((r) => setDecisions(r.decisions)).catch(() => undefined);
  }, [initiativeId]);

  const load = useCallback(() => {
    initiativesApi.get(initiativeId).then((x) => { setI(x); setNotFound(false); }).catch((e) => {
      if (e?.response?.status === 404) setNotFound(true);
      else setError(errorText(e, "Couldn't load this initiative."));
    });
  }, [initiativeId]);
  useEffect(load, [load]);
  useEffect(() => { if (i && i.kind !== "event" && i.kind !== "webinar") loadDecisions(); }, [i?.id, i?.kind, tab, loadDecisions]); // eslint-disable-line react-hooks/exhaustive-deps
  const reloadAll = () => { load(); loadDecisions(); };

  const go = (t: TabId, v?: string) => {
    const p = new URLSearchParams(params);
    if (t === "plan" && (!v || v === "overview")) { p.delete("tab"); p.delete("view"); }
    else { p.set("tab", t); if (v) p.set("view", v); else p.delete("view"); }
    setParams(p, { replace: true });
    window.scrollTo({ top: 0 });
  };
  const setTab = (t: TabId) => go(t);
  /** OverviewTab and older screens still ask for the old ids. */
  const goLegacy = (t: Legacy | TabId) => { if (t in LEGACY) { const [a, b] = LEGACY[t as Legacy]; go(a, b); } else go(t as TabId); };

  const people = i ? PEOPLE_KINDS.has(i.kind) : false;
  const overdue = i?.tasks.filter((t) => t.status !== "done" && t.due_on && t.due_on < new Date().toISOString().slice(0, 10)).length || 0;
  const review = decisions ? decisions.review.length : 0;
  const tabs: { id: TabId; label: string; badge?: number | null }[] = i ? [
    { id: "plan", label: "Plan", badge: overdue || null },
    { id: "evidence", label: "Evidence", badge: review || null },
    { id: "pace", label: "Pace", badge: decisions ? (decisions.actions.length + decisions.approvals.length) || null : null },
    { id: "people", label: people ? "People" : "Team" },
    { id: "proof", label: "Proof" },
  ] : [];
  const planViews = i ? [{ id: "overview", label: "Overview" }, { id: "tasks", label: "Tasks", badge: overdue || null }, { id: "board", label: i.board.label, badge: i.items.length || null }] : [];
  const evViews = i ? [{ id: "evidence", label: "Evidence", badge: review || null }, { id: "links", label: "Links & pages", badge: i.tracking_plan.filter((r) => r.state === "setup").length || null }, { id: "log", label: "Log" }] : [];
  const peopleViews = i ? [{ id: "team", label: "Team & outreach" }, ...(people ? [{ id: "audience", label: "People" }] : []),
    ...(people || i.kind === "product" ? [{ id: "campaigns", label: "Campaigns", badge: i.campaigns.length || null }] : [])] : [];
  const proofViews = [{ id: "proof", label: "Proof" }, { id: "results", label: "Targets & numbers" }];
  const pick = (views: { id: string }[], v: string, d: string) => (views.some((x) => x.id === v) ? v : d);

  if (notFound) {
    return (
      <div className="dash-shell flex min-h-screen">
        <AppSidebar workspaces={workspaces} activeWorkspaceId={activeWorkspaceId} onWorkspaceSwitch={switchWorkspace} onWorkspaceCreated={handleWorkspaceCreated} />
        <div className="flex-1 grid place-items-center p-8 text-center">
          <div>
            <div className="text-section font-semibold text-text">This initiative wasn't found</div>
            <p className="text-ui text-muted mt-1">It may have been deleted, or it's in a workspace you're not part of.</p>
            <Link to="/initiatives" className="btn-primary text-sm mt-4 inline-flex">All initiatives</Link>
          </div>
        </div>
      </div>
    );
  }

  // Round 42: an event or webinar opens as Event OS - every screen of the
  // event, before, during and after, in one place.
  if (i && (i.kind === "event" || i.kind === "webinar")) {
    return (
      <div className="dash-shell flex min-h-screen">
        <AppSidebar workspaces={workspaces} activeWorkspaceId={activeWorkspaceId} onWorkspaceSwitch={switchWorkspace} onWorkspaceCreated={handleWorkspaceCreated} />
        <div className="flex-1 min-w-0 flex flex-col" data-event-os="">
          <TopNav breadcrumb={[{ label: "Initiatives", to: "/initiatives" }, { label: i?.title || "Initiative" }]} />
          {error && <div className="px-4 sm:px-8 pt-4"><Banner kind="error" onClose={() => setError("")}>{error}</Banner></div>}
          <EventShell i={i} reload={load} onError={setError} />
        </div>
      </div>
    );
  }

  return (
    <div className="dash-shell flex min-h-screen">
      <AppSidebar workspaces={workspaces} activeWorkspaceId={activeWorkspaceId} onWorkspaceSwitch={switchWorkspace} onWorkspaceCreated={handleWorkspaceCreated} />
      <div className="flex-1 min-w-0 flex flex-col">
        <TopNav breadcrumb={[{ label: "Initiatives", to: "/initiatives" }, { label: i?.title || "Initiative" }]} />
        <header className="px-4 sm:px-8 pt-6 border-b border-border flex flex-col gap-4" data-initiative-header="">
          <div className="flex flex-wrap justify-between items-start gap-4">
            <div className="flex flex-col gap-2 min-w-0 flex-[1_1_420px]">
              <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">
                <Link to="/initiatives" className="hover:text-text">Initiatives</Link>{i?.department ? ` / ${i.department}` : ""}
              </span>
              {i ? (
                <>
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <KindBadge kind={i.kind} />
                    <h1 className="m-0 text-[22px] sm:text-[24px] font-semibold tracking-tight text-text text-balance">{i.title}</h1>
                  </div>
                  <div className="flex items-center gap-x-4 gap-y-2 flex-wrap text-ui text-secondary">
                    <HealthPill health={i.health} />
                    {i.key_date && <span>{fmtDate(i.key_date, true)}{i.days_to_go !== null && i.status !== "done" ? <span className="text-muted"> · {daysLabel(i.days_to_go)}</span> : null}</span>}
                    {i.location && <span>{i.location}</span>}
                    {i.owner && <span className="text-muted">Owner {i.owner}</span>}
                    {(i.scope.regions?.length || 0) > 0 && <span className="text-muted">Scope: {i.scope.regions!.join(", ")}</span>}
                  </div>
                </>
              ) : <div className="h-16 w-[420px] max-w-full rounded-ctl bg-surface2 animate-pulse" />}
            </div>
            {i && (
              <div className="flex gap-2 flex-wrap items-center">
                <ThemeToggle />
                <button type="button" className="btn-secondary text-sm inline-flex items-center gap-2" onClick={() => setAssistant(true)} data-open-assistant="">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z" /><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" /></svg>
                  Ask about this
                </button>
                {i.can_edit && (
                  <StatusMenu i={i} onChanged={load} onDeleted={() => nav("/initiatives")} onError={setError} />
                )}
              </div>
            )}
          </div>
          {i && <Tabs tabs={tabs} value={tabs.some((t) => t.id === tab) ? tab : "plan"} onChange={setTab} label="Initiative sections" />}
        </header>

        <main className="px-4 sm:px-8 py-6 pb-20 flex flex-col gap-5 min-w-0">
          {error && <Banner kind="error" onClose={() => setError("")}>{error}</Banner>}
          {i && !i.can_edit && <Banner>You have view access to this workspace - ask an owner for edit access to make changes.</Banner>}
          {!i ? <div className="grid gap-4">{[160, 260].map((h, k) => <div key={k} className="rounded-card bg-surface2 animate-pulse" style={{ height: h }} />)}</div> : (
            <>
              {tab === "plan" && (() => {
                const v = pick(planViews, view, "overview");
                return (<>
                  <div className="overflow-x-auto [scrollbar-width:none]"><Seg items={planViews} value={v} onChange={(x) => go("plan", x)} label="Plan views" /></div>
                  {v === "overview" && decisions && decisions.total > 0 && <DecisionsPanel d={decisions} canEdit={i.can_edit} onChanged={reloadAll} />}
                  {v === "overview" && <OverviewTab i={i} goto={goLegacy} reload={load} onError={setError} />}
                  {v === "tasks" && <PlanTab i={i} reload={reloadAll} onError={setError} />}
                  {v === "board" && <BoardTab i={i} reload={load} onError={setError} />}
                </>);
              })()}
              {tab === "evidence" && (() => {
                const v = pick(evViews, view, "evidence");
                return (<>
                  <div className="overflow-x-auto [scrollbar-width:none]"><Seg items={evViews} value={v} onChange={(x) => go("evidence", x)} label="Evidence views" /></div>
                  {v === "evidence" && <EvidenceTab i={i} reload={reloadAll} />}
                  {v === "links" && <TrackingTab i={i} reload={load} onError={setError} />}
                  {v === "log" && <UpdatesTab i={i} reload={load} onError={setError} />}
                </>);
              })()}
              {tab === "pace" && <PaceTab i={i} reload={reloadAll} />}
              {tab === "people" && (() => {
                const v = pick(peopleViews, view, "team");
                return (<>
                  {peopleViews.length > 1 && <div className="overflow-x-auto [scrollbar-width:none]"><Seg items={peopleViews} value={v} onChange={(x) => go("people", x)} label="People views" /></div>}
                  {v === "team" && <TeamTab i={i} onError={setError} />}
                  {v === "audience" && people && <AudienceTab i={i} reload={load} onError={setError} />}
                  {v === "campaigns" && <CampaignsPanel workspaceId={i.workspace_id} initiative={i} onChanged={load} onError={setError} />}
                </>);
              })()}
              {tab === "proof" && (() => {
                const v = pick(proofViews, view, "proof");
                return (<>
                  <div className="overflow-x-auto [scrollbar-width:none]"><Seg items={proofViews} value={v} onChange={(x) => go("proof", x)} label="Proof views" /></div>
                  {v === "proof" && <ProofTab i={i} />}
                  {v === "results" && <ResultsTab i={i} reload={load} onError={setError} />}
                </>);
              })()}
            </>
          )}
        </main>
      </div>
      {i && <Assistant open={assistant} onClose={() => setAssistant(false)} i={i} onActed={load} />}
    </div>
  );
}

function StatusMenu({ i, onChanged, onDeleted, onError }: { i: Initiative; onChanged: () => void; onDeleted: () => void; onError: (s: string) => void }) {
  const [confirm, setConfirm] = useState(false);
  const set = async (status: string) => {
    try { await initiativesApi.patch(i.id, { status }); onChanged(); } catch (e) { onError(errorText(e)); }
  };
  return (
    <div className="flex gap-2 items-center">
      <select className="input !w-auto !py-2 text-caption" value={i.status} onChange={(e) => set(e.target.value)} aria-label="Status" data-status-select="">
        <option value="planning">Planning</option>
        <option value="active">Active</option>
        <option value="done">Finished</option>
        <option value="archived">Archived</option>
      </select>
      {!confirm ? (
        <button type="button" className="btn-secondary text-sm !px-3" onClick={() => setConfirm(true)} aria-label="Delete initiative">Delete</button>
      ) : (
        <span className="inline-flex items-center gap-2 text-caption">
          <span className="text-danger">Delete for everyone?</span>
          <button type="button" className="btn-secondary text-sm !px-3 !text-danger" onClick={async () => {
            try { await initiativesApi.remove(i.id); onDeleted(); } catch (e) { onError(errorText(e)); }
          }}>Delete</button>
          <button type="button" className="text-muted underline" onClick={() => setConfirm(false)}>Keep</button>
        </span>
      )}
    </div>
  );
}
