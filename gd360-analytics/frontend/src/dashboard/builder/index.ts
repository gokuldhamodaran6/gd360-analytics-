// 2026-10-07 (dashboard from a prompt, Builder.dc.html): describe ->
// propose -> refine -> publish. pages/NewDashboard.tsx composes these.
export { Composer, EXAMPLE_GOALS, GOAL_MAX, isSubmitShortcut, useSourceStats, sourceStatsText } from "./Composer";
export type { ComposerProps, SourceStats } from "./Composer";
export { StepRail } from "./StepRail";
export { ProposalPreview, PreviewSkeleton, PreviewEmpty } from "./ProposalPreview";
export { ProposedBlockFrame, PROPOSAL_TYPE_LABEL, splitIntent, whyOf, swapLabel } from "./ProposedBlockFrame";
export { RefineBar, DEFAULT_REVISIONS } from "./RefineBar";
export { PublishDialog, defaultTitle } from "./PublishDialog";
export { ComputeFooter, computeSummary } from "./ComputeFooter";
export { useProposalFlow, diffProposals, describeDiff, matchCommittedBlocks, proposalBlocks, errorDetail } from "./useProposalFlow";
export type { ProposalFlow, BuilderStep, SwapPayload, RevisionDiff } from "./useProposalFlow";
export { proposalSupport, kindLabel, schemaSummary, WAREHOUSE_KINDS, FILE_LIKE_KINDS } from "./sourceSupport";
export type { SourceSupport } from "./sourceSupport";
