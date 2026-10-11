// 2026-10-11: Euliv, the voice assistant (backend routers/assistant.py).
import { api } from "./client";
import type { CheckIssue, CheckPeriod } from "./projects";

export type EulivSource = { id: string; name: string; kind: string; label: string; freshness?: string };
export type EulivConnect = { kind: string | null; label: string; url: string };

// round 24: the read-back being agreed - the numbered data options and what is ticked
export type PlanOption = { id: string; name: string; kind?: string | null; label?: string; why?: string; fit?: string; note?: string; says?: string; recommended?: boolean };
export type PlanCard = {
  type: "plan"; question?: string; options: PlanOption[]; selected: string[]; period: CheckPeriod | null; period_options: CheckPeriod[];
  restated: string; needs_pick: boolean; connect: { kind: string; label: string; url: string }[]; mode?: string | null;
  what?: string | null; needs_time?: boolean;
};

export type EulivState = {
  brief?: (Record<string, any> & { selected?: string[]; options?: PlanOption[]; period?: CheckPeriod | null }) | null;
  talk_id?: string | null;
  awaiting?: string | null;
  pending_question?: string | null;
  candidates?: EulivSource[];
  connect?: EulivConnect | null;
  project_id?: string | null;
  last_run_id?: string | null;
  topic?: string | null;
  retries?: number;
};

export type EulivTurn = {
  say: string;
  speak: string;
  action: "chat" | "choose" | "plan" | "fix_date" | "rephrase" | "connect_offer" | "connect" | "connect_wait" | "run" | "explain" | "end" | "wait" | "ignore";
  plan?: PlanCard;
  issue?: CheckIssue;
  title?: string;
  talk_id?: string;
  talk_title?: string;
  state: EulivState;
  candidates?: EulivSource[];
  connect?: EulivConnect;
  run_id?: string;
  project_id?: string;
  question?: string;
  sources?: EulivSource[];
  explain?: { headline: string | null; points: { text: string; ref: string | null }[]; takeaway: string | null; followups: string[]; link: string; run_id?: string | null };
};

export type EulivKpi = { label: string; display: string; delta: string | null; dir: string | null; note: string | null };

export type EulivAnswer = {
  status: "working" | "done" | "failed" | "stopped" | "needs_input" | string;
  missing?: string;
  run_id?: string;
  stage?: string;
  done?: number;
  total?: number;
  say?: string;
  speak?: string;
  link: string;
  project_id?: string;
  card?: { headline: string | null; answer: string | null; kpis: EulivKpi[]; next_questions: string[]; sources_used: string[]; question: string; period?: CheckPeriod | null };
};

export type TalkMessage = { id: string; role: "user" | "assistant"; text: string; at: string; card: any | null };
export type Talk = {
  id: string; title: string; created_at: string; updated_at: string; workspace_id: string | null; questions: number;
  sources: string[]; state: EulivState | null; messages: TalkMessage[];
};

export type EulivMemory = { topic: string; label: string; sources: EulivSource[]; updated_at: string };

/** This computer's date (YYYY-MM-DD) - "last month" means the person's last month, whatever the server's time zone. */
export function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export const assistantApi = {
  hello: (talkId?: string | null) =>
    api.get<{ say: string; first_name: string }>("/assistant/hello", { params: { talk_id: talkId || undefined } }).then((r) => r.data),
  turn: (body: { text: string; state: EulivState; workspace_id?: string | null; event?: string; run_id?: string; save?: boolean; greeting?: string }) =>
    api.post<EulivTurn>("/assistant/turn", { ...body, today: localToday() }, { timeout: 30000 }).then((r) => r.data),
  answer: (runId: string, talkId?: string | null) =>
    api.get<EulivAnswer>(`/assistant/answer/${runId}`, { timeout: 15000, params: { talk_id: talkId || undefined } }).then((r) => r.data),
  talk: (id: string) => api.get<Talk>(`/assistant/talks/${id}`).then((r) => r.data),
  renameTalk: (id: string, title: string) => api.patch<{ id: string; title: string }>(`/assistant/talks/${id}`, { title }).then((r) => r.data),
  deleteTalk: (id: string) => api.delete<{ deleted: boolean }>(`/assistant/talks/${id}`).then((r) => r.data),
  connected: (kind?: string | null, workspaceId?: string | null, since?: string) =>
    api
      .get<{ connected: boolean; source: EulivSource | null; label: string | null }>("/assistant/connected", {
        params: { kind: kind || undefined, workspace_id: workspaceId || undefined, since: since || undefined },
      })
      .then((r) => r.data),
  memory: () => api.get<EulivMemory[]>("/assistant/memory").then((r) => r.data),
  forget: (topic?: string) => api.delete<{ forgotten: number }>("/assistant/memory", { params: { topic: topic || undefined } }).then((r) => r.data),
};
