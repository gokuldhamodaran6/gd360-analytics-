// 2026-10-11: Euliv, the voice assistant (backend routers/assistant.py).
import { api } from "./client";

export type EulivSource = { id: string; name: string; kind: string; label: string; freshness?: string };
export type EulivConnect = { kind: string | null; label: string; url: string };

export type EulivState = {
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
  action: "chat" | "choose" | "connect_offer" | "connect" | "connect_wait" | "run" | "explain" | "end" | "wait";
  state: EulivState;
  candidates?: EulivSource[];
  connect?: EulivConnect;
  run_id?: string;
  project_id?: string;
  question?: string;
  sources?: EulivSource[];
  explain?: { headline: string | null; points: { text: string; ref: string | null }[]; takeaway: string | null; followups: string[]; link: string };
};

export type EulivKpi = { label: string; display: string; delta: string | null; dir: string | null; note: string | null };

export type EulivAnswer = {
  status: "working" | "done" | "failed" | "stopped" | string;
  stage?: string;
  done?: number;
  total?: number;
  say?: string;
  speak?: string;
  link: string;
  project_id?: string;
  card?: { headline: string | null; answer: string | null; kpis: EulivKpi[]; next_questions: string[]; sources_used: string[]; question: string };
};

export type EulivMemory = { topic: string; label: string; sources: EulivSource[]; updated_at: string };

export const assistantApi = {
  hello: () => api.get<{ say: string; first_name: string }>("/assistant/hello").then((r) => r.data),
  turn: (body: { text: string; state: EulivState; workspace_id?: string | null; event?: string }) =>
    api.post<EulivTurn>("/assistant/turn", body, { timeout: 30000 }).then((r) => r.data),
  answer: (runId: string) => api.get<EulivAnswer>(`/assistant/answer/${runId}`, { timeout: 15000 }).then((r) => r.data),
  connected: (kind?: string | null, workspaceId?: string | null) =>
    api
      .get<{ connected: boolean; source: EulivSource | null; label: string | null }>("/assistant/connected", {
        params: { kind: kind || undefined, workspace_id: workspaceId || undefined },
      })
      .then((r) => r.data),
  memory: () => api.get<EulivMemory[]>("/assistant/memory").then((r) => r.data),
  forget: (topic?: string) => api.delete<{ forgotten: number }>("/assistant/memory", { params: { topic: topic || undefined } }).then((r) => r.data),
};
