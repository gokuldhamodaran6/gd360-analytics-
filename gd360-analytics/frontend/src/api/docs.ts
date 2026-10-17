// 2026-10-15 (R51): block documents - backend/app/routers/v2.py /v2/documents, services/agent/docblocks.py.
import { api } from "./client";

export type DocBar = { label: string; value: number; n?: number; tone?: "bad" | "good" | "neutral" };
export type DocBlock =
  | { id: string; type: "title" | "byline"; text: string }
  | { id: string; type: "heading"; text: string; level?: number }
  | { id: string; type: "paragraph"; text: string; cites?: string[] }
  | { id: string; type: "callout"; text: string; tone?: string; label?: string; cites?: string[] }
  | { id: string; type: "figure"; kind: "bars"; title: string; subtitle?: string; unit?: string; bars: DocBar[]; baseline?: { value: number; label: string } | null; cites?: string[]; pending?: boolean }
  | { id: string; type: "table"; columns: { key: string; label: string; align?: string }[]; rows: Record<string, any>[]; cites?: string[] }
  | { id: string; type: "sources" };
export type DocSource = { id: string; kind: string; label: string; turn_id?: string; step?: string; url?: string };
export type Doc = {
  id: string; title: string; blocks: DocBlock[]; sources: DocSource[]; conversation_id: string | null; message_id: string | null;
  created_at: string; updated_at: string; edited_by_person: boolean; figures: number; tables: number; words: number; pages: number;
  checked: number; flagged: string[]; can_undo: boolean; history: { label: string; at: string }[]; can_edit?: boolean;
};

export const docsApi = {
  get: (id: string) => api.get<Doc>(`/v2/documents/${id}`).then((r) => r.data),
  rename: (id: string, title: string) => api.patch<Doc>(`/v2/documents/${id}`, { title }).then((r) => r.data),
  editBlock: (id: string, blockId: string, instruction: string) =>
    api.post<{ change: { change: string; block_id?: string; inserted?: boolean }; document: Doc }>(`/v2/documents/${id}/blocks/${blockId}/edit`, { instruction }).then((r) => r.data),
  typeBlock: (id: string, blockId: string, text: string) => api.put<Doc>(`/v2/documents/${id}/blocks/${blockId}`, { text }).then((r) => r.data),
  accept: (id: string, blockId: string) => api.post<Doc>(`/v2/documents/${id}/blocks/${blockId}/accept`, {}).then((r) => r.data),
  undo: (id: string) => api.post<{ undid: string; document: Doc }>(`/v2/documents/${id}/undo`, {}).then((r) => r.data),
  shorter: (id: string) => api.post<Doc>(`/v2/documents/${id}/shorter`, {}).then((r) => r.data),
  download: async (id: string, kind: "docx" | "pdf" | "md", name?: string) => {
    const res = await api.get(`/v2/documents/${id}/export.${kind}`, { responseType: "blob" });
    const cd = String(res.headers?.["content-disposition"] || "");
    const m = cd.match(/filename="?([^";]+)"?/);
    const safe = (name || "document").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "document";
    const url = URL.createObjectURL(res.data as Blob);
    const a = document.createElement("a");
    a.href = url; a.download = m ? m[1] : `${safe}.${kind}`; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  },
};
