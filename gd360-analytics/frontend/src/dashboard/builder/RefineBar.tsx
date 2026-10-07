import { useState } from "react";
import { Button, CheckIcon, Input, SparkleIcon, WarningIcon, cn } from "../../ui";
import { isSubmitShortcut } from "./Composer";
import { describeDiff, type ProposalFlow } from "./useProposalFlow";

// Builder.dc.html's "Refine" bar under the proposal: revision chips (the
// proposal's own `suggestions` from the model, else a sensible default
// set), a free-text instruction ("Change anything…") and Send - both go
// to POST /propose/{id}/revise with the current keep list. After a
// revision the bar reports the diff ("3 blocks changed · 1 added").

export const DEFAULT_REVISIONS = ["Make it one page", "Use last 12 months only", "Shorter: 6 blocks", "Add a table of the top groups"];

export function RefineBar({ flow, className }: { flow: ProposalFlow; className?: string }) {
  const [text, setText] = useState("");
  const { proposal, revising, publishing, diff } = flow;
  if (!proposal) return null;
  const chips = proposal.suggestions?.length ? proposal.suggestions : DEFAULT_REVISIONS;
  const busy = revising || publishing;
  const diffText = describeDiff(diff);

  const send = async (instruction: string) => {
    const trimmed = instruction.trim();
    if (!trimmed || busy) return;
    await flow.revise(trimmed);
    setText("");
  };

  return (
    <section data-refine-bar="" aria-label="Refine the proposal" className={cn("flex flex-col gap-3 rounded-card border border-border bg-surface px-4 py-3.5 shadow-card", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex items-center gap-1.5 text-caption font-semibold uppercase tracking-caps text-secondary">
          <SparkleIcon size={13} className="text-brand-ink" /> Refine
        </div>
        {revising ? (
          <span className="text-caption text-muted" role="status">Revising…</span>
        ) : diffText ? (
          <span data-revision-diff="" role="status" className="inline-flex items-center gap-1.5 text-caption text-secondary">
            <CheckIcon size={12} className="text-brand-ink" /> Revision {diff!.revision}: {diffText}
            {proposal.warning && <span className="text-warning">· {proposal.warning}</span>}
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Suggested changes" data-revision-chips="">
        {chips.map((c) => (
          <button
            key={c}
            type="button"
            disabled={busy}
            className="ui-focus rounded-ctl border border-border bg-surface px-2.5 py-[6px] text-[12.5px] font-medium text-text hover:border-border-strong hover:bg-subtle disabled:text-faint"
            onClick={() => send(c)}
          >
            {c}
          </button>
        ))}
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => { e.preventDefault(); send(text); }}
      >
        <Input
          data-refine-input=""
          aria-label="Change anything"
          placeholder="Change anything… e.g. group the trend by hotel, add a cancellation KPI"
          value={text}
          maxLength={1000}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (isSubmitShortcut(e)) { e.preventDefault(); send(text); } }}
          className="min-w-0 flex-1"
        />
        <Button type="submit" variant="primary" data-refine-send="" loading={revising} disabled={!text.trim() || busy}>Send</Button>
      </form>
      {flow.error && flow.step === "refine" && (
        <div role="alert" data-refine-error="" className="flex items-start gap-1.5 rounded-ctl border border-danger-border bg-danger-fill px-3 py-2 text-caption text-danger">
          <WarningIcon size={13} className="mt-0.5 shrink-0" /> <span>{flow.error}</span>
        </div>
      )}
    </section>
  );
}
