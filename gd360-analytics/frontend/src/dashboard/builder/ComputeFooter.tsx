import type { ReactNode } from "react";
import type { DashboardProposal, ProposalBlock } from "../../api/client";
import { DatabaseIcon, cn, providerDisplayName } from "../../ui";
import { formatBytes } from "../canvas/cells";

// Builder.dc.html's cost line, "Will compute in BigQuery · 7 queries · est.
// 180 MB per run". A proposal block carries no byte estimate today
// (ProposalBlockOut has sql + columns, no estimated_bytes), so the line
// reads "N queries · estimate on publish" and only ever shows a size when
// a block reports one.

export function computeSummary(proposal: DashboardProposal | null, kept: ProposalBlock[]): { provider: string; queries: number; bytes: number | null } {
  const provider = proposal ? (proposal.warehouse_native ? providerDisplayName(proposal.datasource_kind) : "GD360") : "";
  const queries = kept.filter((b) => b.type !== "text" && (b.sql || b.recipe || b.spec)).length;
  let bytes: number | null = null;
  for (const b of kept) {
    const est = (b as any).estimated_bytes;
    if (typeof est === "number" && Number.isFinite(est)) bytes = (bytes || 0) + est;
  }
  return { provider, queries, bytes };
}

export function ComputeFooter({ proposal, kept, trailing, className }: { proposal: DashboardProposal | null; kept: ProposalBlock[]; trailing?: ReactNode; className?: string }) {
  if (!proposal) return null;
  const { provider, queries, bytes } = computeSummary(proposal, kept);
  const pages = new Set(proposal.pages.filter((p) => p.blocks.some((b) => kept.includes(b))).map((p) => p.title)).size;
  return (
    <div data-compute-footer="" className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-muted tabular-nums", className)}>
      <DatabaseIcon size={13} className="text-brand-ink" />
      <span>Will compute in <span className="font-medium text-secondary">{provider}</span></span>
      <span aria-hidden="true">·</span>
      <span>{queries} {queries === 1 ? "query" : "queries"}{proposal.warehouse_native ? " per run" : " on publish"}</span>
      <span aria-hidden="true">·</span>
      <span>{bytes !== null ? `est. ${formatBytes(bytes)} per run` : "estimate on publish"}</span>
      {pages > 1 && (
        <>
          <span aria-hidden="true">·</span>
          <span>{pages} pages</span>
        </>
      )}
      {trailing}
    </div>
  );
}
