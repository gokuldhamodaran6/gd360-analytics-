import { useCallback, useMemo, useRef, useState } from "react";
import {
  dashboardBuilderApi, dashboardProposalApi, type DashboardBlockType, type DashboardBuilderDetail, type DashboardProposal, type ProposalBlock,
} from "../../api/client";

// 2026-10-07 (dashboard from a prompt, Builder.dc.html): the state machine
// behind pages/NewDashboard.tsx. Describe -> POST /propose -> Refine
// (keep / swap / remove locally, POST /revise for a new revision) ->
// Publish (POST /commit with the kept client_ids, then one
// POST /blocks/{id}/swap per locally-swapped block, then navigate).
//
// Keep/remove survives a revision: the backend re-numbers client_ids on
// every build (b1..bN in order), so a removed block is remembered by its
// title as well as its id and stays removed when the revised proposal
// brings the same block back. Removed blocks are never sent in `keep`.

export type BuilderStep = "describe" | "propose" | "refine" | "publish";
export type SwapPayload = { chart_type?: string; type?: DashboardBlockType };
export type RevisionDiff = { changed: number; added: number; removed: number; revision: number };

export type ProposalFlow = {
  step: BuilderStep;
  proposal: DashboardProposal | null;
  loading: boolean;
  revising: boolean;
  publishing: boolean;
  error: string | null;
  diff: RevisionDiff | null;
  // Every ok block (both pages) in grid order.
  blocks: ProposalBlock[];
  keep: string[];
  isKept: (b: ProposalBlock) => boolean;
  swapOf: (b: ProposalBlock) => SwapPayload | null;
  setKept: (b: ProposalBlock, kept: boolean) => void;
  swap: (b: ProposalBlock, payload: SwapPayload | null) => void;
  propose: (payload: { datasource_id: string; goal: string; template_id?: string | null; conversation_id?: string | null }) => Promise<void>;
  revise: (instruction: string) => Promise<void>;
  publish: (opts: { name: string; visibility: "private" | "workspace" }) => Promise<DashboardBuilderDetail>;
  reset: () => void;
  clearError: () => void;
};

export function errorDetail(e: any, fallback: string): string {
  const d = e?.response?.data?.detail;
  if (typeof d === "string" && d.trim()) return d;
  if (Array.isArray(d) && d.length && typeof d[0]?.msg === "string") return d[0].msg;
  if (typeof e?.message === "string" && e.message && !/Network Error|Request failed/.test(e.message)) return e.message;
  return fallback;
}

export function proposalBlocks(p: DashboardProposal | null): ProposalBlock[] {
  if (!p) return [];
  return p.pages.flatMap((page) => page.blocks);
}

function blockSignature(b: ProposalBlock): string {
  return JSON.stringify([b.type, b.chart_type, b.spec, b.text]);
}

// Compares two revisions by title (ids are re-numbered per revision).
export function diffProposals(prev: DashboardProposal | null, next: DashboardProposal): RevisionDiff {
  const before = new Map<string, ProposalBlock>();
  for (const b of proposalBlocks(prev)) before.set(b.title.trim().toLowerCase(), b);
  const after = new Map<string, ProposalBlock>();
  for (const b of proposalBlocks(next)) after.set(b.title.trim().toLowerCase(), b);
  let changed = 0;
  let added = 0;
  let removed = 0;
  for (const [title, b] of after) {
    const old = before.get(title);
    if (!old) added++;
    else if (blockSignature(old) !== blockSignature(b)) changed++;
  }
  for (const title of before.keys()) if (!after.has(title)) removed++;
  return { changed, added, removed, revision: next.revision };
}

export function describeDiff(d: RevisionDiff | null): string | null {
  if (!d) return null;
  const parts: string[] = [];
  if (d.changed) parts.push(`${d.changed} block${d.changed === 1 ? "" : "s"} changed`);
  if (d.added) parts.push(`${d.added} added`);
  if (d.removed) parts.push(`${d.removed} removed`);
  return parts.length ? parts.join(" · ") : "No blocks changed";
}

// Maps each kept proposal block to the block the commit created, by page
// order and position (commit creates kept ok blocks in proposal order,
// position = index), double-checked by title.
export function matchCommittedBlocks(proposal: DashboardProposal, keep: string[], created: DashboardBuilderDetail): Map<string, string> {
  const map = new Map<string, string>();
  const keepSet = new Set(keep);
  const keptPages = proposal.pages
    .map((p) => p.blocks.filter((b) => b.status === "ok" && keepSet.has(b.client_id)))
    .filter((blocks) => blocks.length > 0);
  const createdPages = [...created.pages].sort((a, b) => a.position - b.position);
  keptPages.forEach((blocks, pi) => {
    const page = createdPages[pi];
    if (!page) return;
    const sorted = [...page.blocks].sort((a, b) => a.position - b.position);
    blocks.forEach((b, i) => {
      const target = sorted[i];
      if (target && (target.title || "") === b.title) map.set(b.client_id, target.id);
    });
  });
  return map;
}

export function useProposalFlow(): ProposalFlow {
  const [step, setStep] = useState<BuilderStep>("describe");
  const [proposal, setProposal] = useState<DashboardProposal | null>(null);
  const [loading, setLoading] = useState(false);
  const [revising, setRevising] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diff, setDiff] = useState<RevisionDiff | null>(null);
  // client_id -> title at the time it was removed.
  const [removed, setRemoved] = useState<Record<string, string>>({});
  const [swaps, setSwaps] = useState<Record<string, SwapPayload>>({});
  const seq = useRef(0);

  const blocks = useMemo(() => proposalBlocks(proposal).filter((b) => b.status === "ok"), [proposal]);
  const removedTitles = useMemo(() => new Set(Object.values(removed).map((t) => t.trim().toLowerCase())), [removed]);

  const isKept = useCallback(
    (b: ProposalBlock) => {
      if (b.status !== "ok") return false;
      if (removed[b.client_id] === b.title) return false;
      return !removedTitles.has(b.title.trim().toLowerCase());
    },
    [removed, removedTitles]
  );
  const keep = useMemo(() => blocks.filter(isKept).map((b) => b.client_id), [blocks, isKept]);
  const swapOf = useCallback((b: ProposalBlock) => swaps[b.client_id] ?? null, [swaps]);

  const setKept = useCallback((b: ProposalBlock, kept: boolean) => {
    setRemoved((r) => {
      const next = { ...r };
      if (kept) {
        for (const [id, title] of Object.entries(next)) if (id === b.client_id || title.trim().toLowerCase() === b.title.trim().toLowerCase()) delete next[id];
      } else {
        next[b.client_id] = b.title;
      }
      return next;
    });
  }, []);

  const swap = useCallback((b: ProposalBlock, payload: SwapPayload | null) => {
    setSwaps((s) => {
      const next = { ...s };
      if (payload) next[b.client_id] = payload;
      else delete next[b.client_id];
      return next;
    });
  }, []);

  const propose = useCallback(async (payload: { datasource_id: string; goal: string; template_id?: string | null; conversation_id?: string | null }) => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    setStep("propose");
    try {
      const p = await dashboardProposalApi.propose(payload);
      if (mine !== seq.current) return;
      setProposal(p);
      setRemoved({});
      setSwaps({});
      setDiff(null);
      setStep("refine");
    } catch (e: any) {
      if (mine !== seq.current) return;
      setError(errorDetail(e, "GD360 couldn't build a proposal from that description. Try again, or name the numbers that matter most."));
      setStep("describe");
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  const revise = useCallback(
    async (instruction: string) => {
      if (!proposal) return;
      const mine = ++seq.current;
      setRevising(true);
      setError(null);
      try {
        const next = await dashboardProposalApi.revise(proposal.proposal_id, { instruction, keep });
        if (mine !== seq.current) return;
        setDiff(diffProposals(proposal, next));
        setProposal(next);
        // Swaps are keyed by id; a re-numbered revision invalidates them
        // unless the block at that id still has the same title.
        setSwaps((s) => {
          const byId = new Map(proposalBlocks(next).map((b) => [b.client_id, b] as const));
          const prevById = new Map(proposalBlocks(proposal).map((b) => [b.client_id, b] as const));
          const kept: Record<string, SwapPayload> = {};
          for (const [id, payload] of Object.entries(s)) {
            if (byId.get(id)?.title === prevById.get(id)?.title) kept[id] = payload;
          }
          return kept;
        });
      } catch (e: any) {
        if (mine !== seq.current) return;
        setError(errorDetail(e, "That revision couldn't be applied - the proposal is unchanged."));
      } finally {
        if (mine === seq.current) setRevising(false);
      }
    },
    [proposal, keep]
  );

  const publish = useCallback(
    async ({ name, visibility }: { name: string; visibility: "private" | "workspace" }) => {
      if (!proposal) throw new Error("Nothing to publish yet.");
      setPublishing(true);
      setError(null);
      setStep("publish");
      try {
        const created = await dashboardProposalApi.commit(proposal.proposal_id, { name, keep, visibility });
        const ids = matchCommittedBlocks(proposal, keep, created);
        const pending = Object.entries(swaps)
          .filter(([cid]) => keep.includes(cid) && ids.has(cid))
          .map(([cid, payload]) => dashboardBuilderApi.swapBlock(created.id, ids.get(cid)!, payload).catch(() => undefined));
        if (pending.length) await Promise.all(pending);
        return created;
      } catch (e: any) {
        setError(errorDetail(e, "The dashboard couldn't be created. Try again."));
        setStep("refine");
        throw e;
      } finally {
        setPublishing(false);
      }
    },
    [proposal, keep, swaps]
  );

  const reset = useCallback(() => {
    seq.current++;
    setStep("describe");
    setProposal(null);
    setRemoved({});
    setSwaps({});
    setDiff(null);
    setError(null);
    setLoading(false);
    setRevising(false);
  }, []);

  return {
    step, proposal, loading, revising, publishing, error, diff, blocks, keep, isKept, swapOf, setKept, swap, propose, revise, publish, reset,
    clearError: () => setError(null),
  };
}
