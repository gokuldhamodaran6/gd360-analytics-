import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { dashboardCommentsApi, type CommentAnchor, type CommentCounts, type CommentPeople, type CommentPerson, type CommentThread, type DashboardComment } from "../../api/client";

// 2026-10-07 (analyst canvas round): one hook per dashboard for every
// comment thread on it (GET /dashboard-builder/{id}/comments, resolved
// threads included so "Resolve" can be undone without a refetch). Writes
// are optimistic: a reply / a new thread appears at once with a temporary
// id, resolve flips the thread immediately, delete removes it - each one
// reconciled with the server's thread when the request lands and rolled
// back when it fails. `counts` is derived from the threads held here in
// the exact {block_id: {open, total}} shape DashboardBuilderOut.
// comment_counts uses, so the grid's "2 open" badge and the canvas cell's
// "Comment" count never disagree.
//
// Authenticated only (dashboardCommentsApi): the published view passes
// dashboardId = null and gets an inert hook.

export type CommentsApi = {
  threads: CommentThread[];
  counts: CommentCounts;
  loading: boolean;
  error: string | null;
  enabled: boolean;
  // round 38 (team comments): who is reading, whether they may change the
  // dashboard's charts (accepting a suggestion), and who can be @mentioned.
  me: string | null;
  canEditDashboard: boolean;
  people: CommentPeople | null;
  loadPeople: () => Promise<CommentPerson[]>;
  threadsFor: (blockId: string, opts?: { includeResolved?: boolean }) => CommentThread[];
  countFor: (blockId: string) => { open: number; total: number };
  addThread: (blockId: string, body: string, anchor?: CommentAnchor | null, mentionIds?: string[]) => Promise<CommentThread | null>;
  reply: (threadId: string, body: string, mentionIds?: string[]) => Promise<void>;
  resolve: (threadId: string, resolved: boolean) => Promise<void>;
  editBody: (commentId: string, body: string, mentionIds?: string[]) => Promise<void>;
  remove: (commentId: string) => Promise<void>;
  applySuggestion: (threadId: string, apply: boolean) => Promise<CommentThread | null>;
  refresh: () => Promise<void>;
};

const ME: DashboardComment["author"] = { id: "me", name: "You", initials: "ME", email: null };

function keyOf(c: { block_id: string | null; page_id: string | null }): string {
  if (c.block_id) return c.block_id;
  if (c.page_id) return `page:${c.page_id}`;
  return "dashboard";
}

export function countsOf(threads: CommentThread[]): CommentCounts {
  const out: CommentCounts = {};
  for (const t of threads) {
    const entry = (out[keyOf(t)] ||= { open: 0, total: 0 });
    const n = 1 + t.replies.length;
    entry.total += n;
    if (!t.resolved) entry.open += n;
  }
  return out;
}

function readError(e: any, fallback: string): string {
  const detail = e?.response?.data?.detail;
  return typeof detail === "string" ? detail : fallback;
}

export function useComments(dashboardId: string | null, options: { enabled?: boolean } = {}): CommentsApi {
  const enabled = Boolean(dashboardId) && options.enabled !== false;
  const [threads, setThreads] = useState<CommentThread[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [me, setMe] = useState<string | null>(null);
  const [canEditDashboard, setCanEditDashboard] = useState(false);
  const [people, setPeople] = useState<CommentPeople | null>(null);
  const peopleReq = useRef<Promise<CommentPerson[]> | null>(null);
  const seq = useRef(0);
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  // The optimistic comment wears the writer's real name (and so colour) once known.
  const peopleRef = useRef(people);
  peopleRef.current = people;
  const meAuthor = (): DashboardComment["author"] => {
    const m = peopleRef.current?.people.find((p) => p.is_me);
    return m ? { id: m.id, name: m.name, initials: m.initials, email: m.email ?? null } : ME;
  };

  const refresh = useCallback(async () => {
    if (!dashboardId || !enabled) return;
    const n = ++seq.current;
    setLoading(true);
    try {
      const res = await dashboardCommentsApi.list(dashboardId, { include_resolved: true });
      if (n !== seq.current) return;
      setThreads(res.threads || []);
      setMe(res.me ?? null);
      setCanEditDashboard(Boolean(res.can_edit_dashboard));
      setError(null);
    } catch (e: any) {
      if (n !== seq.current) return;
      if (e?.name === "CanceledError" || e?.code === "ERR_CANCELED") return;
      setError(readError(e, "Couldn't load comments."));
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [dashboardId, enabled]);

  useEffect(() => {
    setThreads([]);
    setPeople(null);
    peopleReq.current = null;
    if (enabled) refresh();
    return () => { seq.current++; };
  }, [enabled, refresh]);

  // A team works on the same dashboard: pick up their comments when the
  // tab comes back into view, and every minute while it is open.
  useEffect(() => {
    if (!enabled) return;
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    const id = window.setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 60000);
    return () => { document.removeEventListener("visibilitychange", onVisible); window.clearInterval(id); };
  }, [enabled, refresh]);

  const loadPeople = useCallback(async (): Promise<CommentPerson[]> => {
    if (!dashboardId || !enabled) return [];
    if (!peopleReq.current) {
      peopleReq.current = dashboardCommentsApi.people(dashboardId).then((p) => { setPeople(p); return p.people; }).catch(() => { peopleReq.current = null; return []; });
    }
    return peopleReq.current;
  }, [dashboardId, enabled]);

  const counts = useMemo(() => countsOf(threads), [threads]);

  const threadsFor = useCallback((blockId: string, opts: { includeResolved?: boolean } = {}) => {
    return threads.filter((t) => t.block_id === blockId && (opts.includeResolved || !t.resolved));
  }, [threads]);

  const countFor = useCallback((blockId: string) => counts[blockId] || { open: 0, total: 0 }, [counts]);

  const replaceThread = useCallback((tempId: string, next: CommentThread | null) => {
    setThreads((prev) => {
      const idx = prev.findIndex((t) => t.id === tempId);
      if (idx < 0) return next ? [...prev, next] : prev;
      const copy = [...prev];
      if (next) copy[idx] = next;
      else copy.splice(idx, 1);
      return copy;
    });
  }, []);

  const addThread = useCallback(async (blockId: string, body: string, anchor: CommentAnchor | null = null, mentionIds: string[] = []) => {
    if (!dashboardId || !enabled) return null;
    const text = body.trim();
    if (!text) return null;
    const tempId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const now = new Date().toISOString();
    const temp: CommentThread = {
      id: tempId, dashboard_id: dashboardId, block_id: blockId, page_id: null, parent_id: null, author: meAuthor(), body: text, anchor,
      mentions: [], resolved_at: null, created_at: now, updated_at: now, can_edit: true, can_resolve: true, can_delete: true,
      replies: [], reply_count: 0, resolved: false,
    };
    setThreads((prev) => [...prev, temp]);
    try {
      const stored = await dashboardCommentsApi.create(dashboardId, { body: text, block_id: blockId, anchor: anchor || undefined, mention_ids: mentionIds });
      replaceThread(tempId, stored);
      return stored;
    } catch (e: any) {
      replaceThread(tempId, null);
      throw new Error(readError(e, "Couldn't post this comment."));
    }
  }, [dashboardId, enabled, replaceThread]);

  const reply = useCallback(async (threadId: string, body: string, mentionIds: string[] = []) => {
    if (!dashboardId || !enabled) return;
    const text = body.trim();
    if (!text) return;
    const tempId = `tmp-${Date.now()}`;
    const now = new Date().toISOString();
    const parent = threadsRef.current.find((t) => t.id === threadId);
    const temp: DashboardComment = {
      id: tempId, dashboard_id: dashboardId, block_id: parent?.block_id ?? null, page_id: parent?.page_id ?? null, parent_id: threadId, author: meAuthor(), body: text,
      anchor: null, mentions: [], resolved_at: null, created_at: now, updated_at: now, can_edit: true, can_resolve: true, can_delete: true,
    };
    setThreads((prev) => prev.map((t) => (t.id === threadId ? { ...t, replies: [...t.replies, temp], reply_count: t.reply_count + 1 } : t)));
    try {
      const stored = await dashboardCommentsApi.create(dashboardId, { body: text, parent_id: threadId, mention_ids: mentionIds });
      replaceThread(threadId, stored);
    } catch (e: any) {
      setThreads((prev) => prev.map((t) => (t.id === threadId ? { ...t, replies: t.replies.filter((r) => r.id !== tempId), reply_count: Math.max(0, t.reply_count - 1) } : t)));
      throw new Error(readError(e, "Couldn't post this reply."));
    }
  }, [dashboardId, enabled, replaceThread]);

  const resolve = useCallback(async (threadId: string, resolved: boolean) => {
    if (!dashboardId || !enabled) return;
    const before = threadsRef.current.find((t) => t.id === threadId);
    setThreads((prev) => prev.map((t) => (t.id === threadId ? { ...t, resolved, resolved_at: resolved ? new Date().toISOString() : null } : t)));
    try {
      const stored = await dashboardCommentsApi.update(dashboardId, threadId, { resolved });
      replaceThread(threadId, stored);
    } catch (e: any) {
      if (before) replaceThread(threadId, before);
      throw new Error(readError(e, resolved ? "Couldn't resolve this thread." : "Couldn't reopen this thread."));
    }
  }, [dashboardId, enabled, replaceThread]);

  const editBody = useCallback(async (commentId: string, body: string, mentionIds?: string[]) => {
    if (!dashboardId || !enabled) return;
    const text = body.trim();
    if (!text) return;
    const stored = await dashboardCommentsApi.update(dashboardId, commentId, { body: text, ...(mentionIds ? { mention_ids: mentionIds } : {}) }).catch((e) => { throw new Error(readError(e, "Couldn't save this edit.")); });
    replaceThread(stored.id, stored);
  }, [dashboardId, enabled, replaceThread]);

  const applySuggestion = useCallback(async (threadId: string, apply: boolean) => {
    if (!dashboardId || !enabled) return null;
    const stored = await dashboardCommentsApi.suggestion(dashboardId, threadId, apply).catch((e) => { throw new Error(readError(e, apply ? "Couldn't apply this." : "Couldn't undo this.")); });
    replaceThread(stored.id, stored);
    return stored;
  }, [dashboardId, enabled, replaceThread]);

  const remove = useCallback(async (commentId: string) => {
    if (!dashboardId || !enabled) return;
    const snapshot = threadsRef.current;
    setThreads((prev) =>
      prev
        .filter((t) => t.id !== commentId)
        .map((t) => (t.replies.some((r) => r.id === commentId) ? { ...t, replies: t.replies.filter((r) => r.id !== commentId), reply_count: Math.max(0, t.reply_count - 1) } : t))
    );
    try {
      await dashboardCommentsApi.remove(dashboardId, commentId);
    } catch (e: any) {
      setThreads(snapshot);
      throw new Error(readError(e, "Couldn't delete this comment."));
    }
  }, [dashboardId, enabled]);

  return { threads, counts, loading, error, enabled, me, canEditDashboard, people, loadPeople, threadsFor, countFor, addThread, reply, resolve, editBody, remove, applySuggestion, refresh };
}

// The inert twin for views with no identity (the published link).
export const NO_COMMENTS: CommentsApi = {
  threads: [], counts: {}, loading: false, error: null, enabled: false, me: null, canEditDashboard: false, people: null, loadPeople: async () => [],
  threadsFor: () => [], countFor: () => ({ open: 0, total: 0 }),
  addThread: async () => null, reply: async () => undefined, resolve: async () => undefined, editBody: async () => undefined, remove: async () => undefined,
  applySuggestion: async () => null, refresh: async () => undefined,
};
