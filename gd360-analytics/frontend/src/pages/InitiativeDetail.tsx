// 2026-10-10: one initiative - the plan, the board, the team and their
// outreach, the people, tracking (links, landing pages, A/B, connected
// data), campaigns, the daily log, and results against targets. The
// assistant answers and acts from the side.
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import AppSidebar from "../components/AppSidebar";
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

type TabId = "overview" | "plan" | "board" | "team" | "audience" | "tracking" | "campaigns" | "updates" | "results";
const PEOPLE_KINDS = new Set(["event", "webinar", "campaign", "abm"]);

export default function InitiativeDetail() {
  const { initiativeId = "" } = useParams();
  const { workspaces, activeWorkspaceId, switchWorkspace, handleWorkspaceCreated } = useWorkspaceNav();
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const [i, setI] = useState<Initiative | null>(null);
  const [error, setError] = useState("");
  const [notFound, setNotFound] = useState(false);
  const [assistant, setAssistant] = useState(false);
  const tab = (params.get("tab") as TabId) || "overview";

  const load = useCallback(() => {
    initiativesApi.get(initiativeId).then((x) => { setI(x); setNotFound(false); }).catch((e) => {
      if (e?.response?.status === 404) setNotFound(true);
      else setError(errorText(e, "Couldn't load this initiative."));
    });
  }, [initiativeId]);
  useEffect(load, [load]);

  const setTab = (t: TabId) => {
    const p = new URLSearchParams(params);
    if (t === "overview") p.delete("tab");
    else p.set("tab", t);
    setParams(p, { replace: true });
    window.scrollTo({ top: 0 });
  };

  const people = i ? PEOPLE_KINDS.has(i.kind) : false;
  const overdue = i?.tasks.filter((t) => t.status !== "done" && t.due_on && t.due_on < new Date().toISOString().slice(0, 10)).length || 0;
  const tabs: { id: TabId; label: string; badge?: number | null }[] = i ? [
    { id: "overview", label: "Overview" },
    { id: "plan", label: "Plan", badge: overdue || null },
    { id: "board", label: i.board.label, badge: i.items.length || null },
    { id: "team", label: "Team & outreach" },
    ...(people ? [{ id: "audience" as TabId, label: "People" }] : []),
    { id: "tracking", label: "Tracking", badge: i.tracking_plan.filter((r) => r.state === "setup").length || null },
    ...(people || i.kind === "product" ? [{ id: "campaigns" as TabId, label: "Campaigns", badge: i.campaigns.length || null }] : []),
    { id: "updates", label: "Today & updates" },
    { id: "results", label: "Results" },
  ] : [];

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

  return (
    <div className="dash-shell flex min-h-screen">
      <AppSidebar workspaces={workspaces} activeWorkspaceId={activeWorkspaceId} onWorkspaceSwitch={switchWorkspace} onWorkspaceCreated={handleWorkspaceCreated} />
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="px-4 sm:px-8 pt-16 lg:pt-6 border-b border-border flex flex-col gap-4" data-initiative-header="">
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
          {i && <Tabs tabs={tabs} value={tabs.some((t) => t.id === tab) ? tab : "overview"} onChange={setTab} label="Initiative sections" />}
        </header>

        <main className="px-4 sm:px-8 py-6 pb-20 flex flex-col gap-5 min-w-0">
          {error && <Banner kind="error" onClose={() => setError("")}>{error}</Banner>}
          {i && !i.can_edit && <Banner>You have view access to this workspace - ask an owner for edit access to make changes.</Banner>}
          {!i ? <div className="grid gap-4">{[160, 260].map((h, k) => <div key={k} className="rounded-card bg-surface2 animate-pulse" style={{ height: h }} />)}</div> : (
            <>
              {tab === "overview" && <OverviewTab i={i} goto={setTab} reload={load} onError={setError} />}
              {tab === "plan" && <PlanTab i={i} reload={load} onError={setError} />}
              {tab === "board" && <BoardTab i={i} reload={load} onError={setError} />}
              {tab === "team" && <TeamTab i={i} onError={setError} />}
              {tab === "audience" && people && <AudienceTab i={i} reload={load} onError={setError} />}
              {tab === "tracking" && <TrackingTab i={i} reload={load} onError={setError} />}
              {tab === "campaigns" && <CampaignsPanel workspaceId={i.workspace_id} initiative={i} onChanged={load} onError={setError} />}
              {tab === "updates" && <UpdatesTab i={i} reload={load} onError={setError} />}
              {tab === "results" && <ResultsTab i={i} reload={load} onError={setError} />}
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
