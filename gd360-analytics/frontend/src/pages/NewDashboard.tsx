import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { dashboardProposalApi, datasourceApi, type DataSourceSummary, type ProposalTemplate } from "../api/client";
import AppSidebar from "../components/AppSidebar";
import TopNav from "../components/TopNav";
import { Composer, ComputeFooter, ProposalPreview, PublishDialog, RefineBar, StepRail, useProposalFlow } from "../dashboard/builder";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";
import { ArrowRightIcon, Button, ChevronLeftIcon, StatusPill } from "../ui";

// 2026-10-07 (dashboard from a prompt, Builder.dc.html): /dashboards/new.
// Left: the Describe composer (source, goal, examples, templates). Right:
// the live proposal in the real dashboard chrome with Keep / Swap / Remove
// per block, the Refine bar under it. Bottom: Back · "Will compute in
// BigQuery · 7 queries" · Publish dashboard. The flow is useProposalFlow;
// nothing is created until Publish commits.
//
// Query params: ?datasource=<id> preselects the source (the chat's
// "Build Dashboard" → "Build with AI" lands here with its own source),
// ?conversation=<id> links the dashboard back to that chat ("Built
// from"), ?goal=<text> prefills the description.

export default function NewDashboard() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { workspaces, activeWorkspaceId, switchWorkspace, handleWorkspaceCreated } = useWorkspaceNav();
  const flow = useProposalFlow();

  const [sources, setSources] = useState<DataSourceSummary[] | null>(null);
  const [sourcesError, setSourcesError] = useState<string | null>(null);
  const [templates, setTemplates] = useState<ProposalTemplate[] | null>(null);
  const [sourceId, setSourceId] = useState<string>(params.get("datasource") || "");
  const [goal, setGoal] = useState<string>(params.get("goal") || "");
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const conversationId = params.get("conversation");

  useEffect(() => {
    let cancelled = false;
    datasourceApi
      .list()
      .then((list) => {
        if (cancelled) return;
        setSources(list);
        setSourceId((cur) => {
          if (cur && list.some((d) => d.id === cur)) return cur;
          return list.length === 1 ? list[0].id : "";
        });
      })
      .catch(() => { if (!cancelled) { setSources([]); setSourcesError("Couldn't load your data sources. Refresh to try again."); } });
    dashboardProposalApi
      .templates()
      .then((t) => { if (!cancelled) setTemplates(t); })
      .catch(() => { if (!cancelled) setTemplates([]); });
    return () => { cancelled = true; };
  }, []);

  const kept = useMemo(() => flow.blocks.filter(flow.isKept), [flow.blocks, flow.isKept]);
  const hasProposal = Boolean(flow.proposal);
  const canPublish = hasProposal && kept.length > 0 && !flow.revising && !flow.publishing;

  const propose = () => {
    if (!sourceId) return;
    flow.propose({ datasource_id: sourceId, goal: goal.trim(), template_id: templateId, conversation_id: conversationId });
  };

  return (
    <div className="dash-shell flex min-h-screen" data-new-dashboard="">
      <AppSidebar workspaces={workspaces} activeWorkspaceId={activeWorkspaceId} onWorkspaceSwitch={switchWorkspace} onWorkspaceCreated={handleWorkspaceCreated} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopNav
          hideLogo
          breadcrumb={[{ label: "Dashboards", to: "/dashboards" }, { label: "New dashboard" }]}
          leading={hasProposal ? <StatusPill tone="neutral" icon={null} className="ml-2">Unsaved proposal</StatusPill> : undefined}
          actions={
            hasProposal ? (
              <Button variant="primary" data-topbar-publish="" disabled={!canPublish} onClick={() => setPublishOpen(true)}>
                Publish
              </Button>
            ) : undefined
          }
        />

        <div className="flex flex-1 flex-col gap-5 px-4 pt-6 sm:px-6 lg:px-8">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-col gap-0.5">
              <h1 className="text-title font-semibold text-text">New dashboard</h1>
              <p className="text-ui text-muted">Describe what the team needs; GD360 proposes a dashboard from your data, you refine it, then publish.</p>
            </div>
            <StepRail step={flow.step} />
          </div>

          <div className="grid min-w-0 grid-cols-1 items-start gap-6 min-[1100px]:grid-cols-[380px_minmax(0,1fr)]" data-builder-columns="">
            <Composer
              sources={sources}
              sourcesError={sourcesError}
              sourceId={sourceId}
              onSourceChange={(id) => { setSourceId(id); flow.clearError(); }}
              goal={goal}
              onGoalChange={setGoal}
              templates={templates}
              templateId={templateId}
              onTemplateChange={setTemplateId}
              onSubmit={propose}
              busy={flow.loading}
              error={flow.step === "describe" ? flow.error : null}
              proposal={flow.proposal}
              onDescribeAgain={() => flow.reset()}
              className="min-[1100px]:sticky min-[1100px]:top-4"
            />
            <div className="flex min-w-0 flex-col gap-4">
              <ProposalPreview flow={flow} />
              <RefineBar flow={flow} />
            </div>
          </div>

          <div className="sticky bottom-0 mt-auto flex flex-wrap items-center justify-between gap-3 rounded-t-card border border-b-0 border-border bg-surface px-5 py-3 shadow-card" data-builder-footer="">
            <Button variant="secondary" icon={<ChevronLeftIcon size={15} />} onClick={() => navigate("/dashboards")}>
              Back
            </Button>
            <div className="flex flex-wrap items-center gap-4">
              {hasProposal ? (
                <ComputeFooter proposal={flow.proposal} kept={kept} />
              ) : (
                <span className="text-caption text-muted">Nothing is created until you publish.</span>
              )}
              <Button variant="primary" size="lg" data-publish-open="" disabled={!canPublish} onClick={() => setPublishOpen(true)} trailingIcon={<ArrowRightIcon size={15} />}>
                Publish dashboard
              </Button>
            </div>
          </div>
        </div>
      </div>

      {publishOpen && flow.proposal && <PublishDialog open={publishOpen} onClose={() => setPublishOpen(false)} flow={flow} goal={goal} />}
    </div>
  );
}
