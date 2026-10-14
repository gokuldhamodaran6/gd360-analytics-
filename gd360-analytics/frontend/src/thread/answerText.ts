// 2026-10-13 (R45): the words an answer page shows about itself - its title,
// who a shared link reaches, how a plan is counted. Pure functions (tested
// with esbuild + node), so the same rules hold everywhere they are used.
import { truncateWords } from "../project/errors";

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The header title. A title the server cut from the first question
 * ("Compute the total daily cost, which includes the cost of customer wa")
 * is shown as the question cut at a word, with "…"; a title someone chose is
 * shown as it is (CSS ellipsis only past `max`).
 */
export function displayTitle(title: string | null | undefined, firstQuestion?: string | null, max = 72): string {
  const t = (title || "").replace(/\s+/g, " ").trim();
  const q = (firstQuestion || "").replace(/\s+/g, " ").trim();
  if (!t) return q ? truncateWords(q, max) : "Untitled answer";
  const stem = t.replace(/(…|\.\.\.)$/, "").trim();
  if (q && q.length > stem.length && q.toLowerCase().startsWith(stem.toLowerCase())) return truncateWords(q, max);
  return t.length > max ? truncateWords(t, max) : t;
}

/** True when the title is (a cut of) the question rather than a name someone gave it. */
export function titleIsQuestion(title: string | null | undefined, firstQuestion?: string | null): boolean {
  const t = (title || "").replace(/\s+/g, " ").trim().replace(/(…|\.\.\.)$/, "").trim().toLowerCase();
  const q = (firstQuestion || "").replace(/\s+/g, " ").trim().toLowerCase();
  return Boolean(t && q && q.startsWith(t));
}

/**
 * Who a copied link reaches. An answer is opened through the data it is built
 * on (its first source): with no data it is only ever its author's; on a
 * personal source only the source's owner; in a workspace, the members who
 * can see that source.
 */
export function shareText(p: { workspace_id?: string | null; sources?: { name: string; workspace_id?: string | null }[] | null } | null): string {
  const sources = p?.sources || [];
  if (!sources.length) return "Only you can open this answer - it was worked out from your question alone, not from shared data.";
  const first = sources[0];
  const inWorkspace = first.workspace_id !== undefined ? Boolean(first.workspace_id) : Boolean(p?.workspace_id);
  if (!inWorkspace) {
    return `Only you can open this answer - ${first.name} is in your personal space. Move it into a workspace on the Data page to share this answer.`;
  }
  if (sources.length === 1) return `Anyone in your workspace who can see ${first.name} can open this answer.`;
  return `Anyone in your workspace who can see ${first.name} can open this answer. They'll see results from all ${sources.length} sources it used.`;
}

/** "Here is the plan - 3 queries across 1 source." */
export function planLine(queries: number, sources: number): string {
  return `Here is the plan — ${plural(queries, "query", "queries")} across ${plural(sources, "source")}.`;
}
