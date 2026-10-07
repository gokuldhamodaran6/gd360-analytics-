import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Field, Input, Select, Sheet, WarningIcon } from "../../ui";
import { isSubmitShortcut } from "./Composer";
import { ComputeFooter } from "./ComputeFooter";
import type { ProposalFlow } from "./useProposalFlow";

// "Publish dashboard": the only step that writes. Title (defaults to the
// proposal's title, itself derived from the goal), who can see it
// (private, or the data source's workspace), what will be created, then
// POST /propose/{id}/commit with name + keep (+ visibility) and on to the
// new dashboard's page (/dashboard-builder/{id} - the route a v2
// dashboard opens at everywhere else in the app).

export function defaultTitle(flow: ProposalFlow, goal: string): string {
  const t = flow.proposal?.title?.trim();
  if (t) return t.slice(0, 120);
  return goal.trim().slice(0, 60) || "New dashboard";
}

export function PublishDialog({ open, onClose, flow, goal }: { open: boolean; onClose: () => void; flow: ProposalFlow; goal: string }) {
  const navigate = useNavigate();
  const [name, setName] = useState(() => defaultTitle(flow, goal));
  const [visibility, setVisibility] = useState<"private" | "workspace">("private");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setName(defaultTitle(flow, goal));
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const kept = flow.blocks.filter(flow.isKept);
  const pages = flow.proposal?.pages.filter((p) => p.blocks.some((b) => kept.includes(b))).length || 0;
  const invalid = flow.proposal ? flow.proposal.proposed_blocks - flow.proposal.valid_blocks : 0;
  const canPublish = name.trim().length > 0 && kept.length > 0 && !flow.publishing;

  const publish = async () => {
    if (!canPublish) return;
    setError(null);
    try {
      const created = await flow.publish({ name: name.trim(), visibility });
      onClose();
      navigate(`/dashboard-builder/${created.id}`);
    } catch (e: any) {
      setError(e?.response?.data?.detail || "The dashboard couldn't be created. Try again.");
      // The dialog owns this message while it is open; the refine bar
      // shouldn't repeat it underneath.
      flow.clearError();
    }
  };

  return (
    <Sheet
      open={open}
      onClose={flow.publishing ? () => undefined : onClose}
      title="Publish dashboard"
      subtitle="Creates the dashboard from the kept blocks and computes every number."
      size="sm"
      id="publish-dialog"
      persistent={flow.publishing}
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <Button variant="ghost" onClick={onClose} disabled={flow.publishing}>Back</Button>
          <Button variant="primary" data-publish-confirm="" onClick={publish} loading={flow.publishing} disabled={!canPublish}>
            {flow.publishing ? "Publishing…" : "Publish"}
          </Button>
        </div>
      }
    >
      <form className="flex flex-col gap-4" data-publish-dialog="" onSubmit={(e) => { e.preventDefault(); publish(); }}>
        <Field label="Title" id="publish-title">
          <Input
            data-publish-title=""
            autoFocus
            value={name}
            maxLength={120}
            disabled={flow.publishing}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (isSubmitShortcut(e)) { e.preventDefault(); publish(); } }}
          />
        </Field>
        <Field label="Who can see it" id="publish-visibility" hint={visibility === "workspace" ? "Everyone in the data source's workspace, with the same view/edit split as any shared dashboard." : "Only you. You can share it from the dashboard afterwards."}>
          <Select
            value={visibility}
            disabled={flow.publishing}
            onChange={(e) => setVisibility(e.target.value as "private" | "workspace")}
            options={[{ value: "private", label: "Only me" }, { value: "workspace", label: "The data source's workspace" }]}
          />
        </Field>
        <div className="flex flex-col gap-1.5 rounded-card border border-border bg-base px-3.5 py-3 text-ui text-secondary" data-publish-summary="">
          <div className="text-caption font-semibold uppercase tracking-caps text-muted">What gets created</div>
          <div><span className="font-medium text-text tabular-nums">{kept.length}</span> block{kept.length === 1 ? "" : "s"} on <span className="font-medium text-text tabular-nums">{pages}</span> page{pages === 1 ? "" : "s"}</div>
          {flow.proposal && flow.proposal.parameters.length > 0 && (
            <div><span className="font-medium text-text tabular-nums">{flow.proposal.parameters.length}</span> filter{flow.proposal.parameters.length === 1 ? "" : "s"} in the rail: {flow.proposal.parameters.map((p) => p.label).join(", ")}</div>
          )}
          {invalid > 0 && <div className="text-caption text-muted">{invalid} invalid block{invalid === 1 ? " is" : "s are"} left out.</div>}
          {flow.blocks.length - kept.length > 0 && <div className="text-caption text-muted">{flow.blocks.length - kept.length} removed block{flow.blocks.length - kept.length === 1 ? "" : "s"} left out.</div>}
          <ComputeFooter proposal={flow.proposal} kept={kept} className="mt-1" />
        </div>
        {kept.length === 0 && (
          <div role="alert" className="flex items-start gap-1.5 rounded-ctl border border-warning-border bg-warning-fill px-3 py-2 text-caption text-warning">
            <WarningIcon size={13} className="mt-0.5 shrink-0" /> Keep at least one block to publish.
          </div>
        )}
        {error && (
          <div role="alert" data-publish-error="" className="flex items-start gap-1.5 rounded-ctl border border-danger-border bg-danger-fill px-3 py-2 text-caption text-danger">
            <WarningIcon size={13} className="mt-0.5 shrink-0" /> <span>{error}</span>
          </div>
        )}
      </form>
    </Sheet>
  );
}
