// 2026-10-15 (R49): designed dashboards ("boards") - backend/app/routers/v2.py /v2/boards, services/agent/board.py.
import { api } from "./client";

export type Unit = "count" | "pct" | "money" | "ratio" | "num" | "pp";
export type Tone = "bad" | "good" | "warn" | "neutral" | "accent";
export type Chip = { text: string; tone: Tone };
export type BoardFilter = { key: string; label: string; column: string | null; values: string[] };
export type BoardPalette = { label: string; mode: "light" | "dark"; accent: string; warn: string; good: string; bg: string; card: string; ink: string };
export type BoardSummary = {
  id: string; name: string; title: string; subtitle?: string | null; theme: string; palette: BoardPalette; themes: Record<string, string>;
  source: { source_id: string; table: string; name: string }; entities: string;
  outcome?: { column: string; positive: string; verb: string; noun: string } | null; dates?: { column: string } | null;
  filters: BoardFilter[]; default_filters: Record<string, string>; pages: { id: string; name: string; blurb?: string | null; kind: string }[];
  definitions: string[]; about: string[]; model?: { ap: number; auc: number; test_n: number; baseline_ap: number } | null;
  built_at?: string; sampled?: boolean; conversation_id?: string | null; can_edit?: boolean;
  // 2026-10-19 (R56): the Dashboard studio
  draft?: boolean; published_at?: string | null; edited_at?: string | null; can_undo?: boolean; versions?: number; changed?: Record<string, string>;
  access?: { draft: boolean; published_at?: string | null; people: number; workspace: boolean };
};
export type BoardEdit = { summary: BoardSummary; change: string; changed: string[]; page_id?: string; block_id?: string };
export type BoardColumns = { dims: { column: string; label: string }[]; measures: { column: string; label: string }[]; outcome: boolean; date?: string | null;
  filterable: { column: string; label: string }[] };
export type BoardVersion = { index: number; label: string; at?: string | null; current: boolean };
export type Point = { label: string; value: number | null; n?: number };
export type Block = {
  id: string; kind: string; type: "kpi" | "bars" | "line" | "table" | "list" | "tiers" | "empty" | "note"; span: number; h: number; hero: boolean;
  title?: string; sub?: string; note?: string; definition?: string; text?: string;
  value?: number | null; unit?: Unit; tone?: Tone; chips?: Chip[]; spark?: (number | null)[] | null;
  curve?: { label: string; points: Point[] } | null; stack?: { label: string; value: number; tone: Tone }[];
  rows?: any[]; points?: Point[]; compare?: Point[] | null; baseline?: { value: number | null; label: string } | null;
  show_n?: boolean; show_share?: boolean; decimals?: number; n_label?: string;
  columns?: { key: string; label: string; align?: string; unit?: Unit }[]; total?: Record<string, any> | null;
  tiers?: { key: string; label: string; count: number; hist: number | null; rule: string }[]; id_label?: string;
};
export type HomeData = {
  title: string; subtitle?: string; kpis: { label: string; value: number | null; unit: Unit; note?: string }[];
  pages: { id: string; name: string; blurb: string; kinds: string[] }[]; definitions: string[]; about: string[]; theme: string;
};
export type PageRun = {
  id: string; name: string; page: { id: string; name: string }; rows_in_view: number; rows_total: number; applied: string[];
  refreshed_at: string; blocks: Block[]; home?: HomeData; empty?: string;
};

export const boardsApi = {
  get: (id: string) => api.get<BoardSummary>(`/v2/boards/${id}`).then((r) => r.data),
  run: (id: string, pageId: string | null, filters: Record<string, string>) =>
    api.post<PageRun>(`/v2/boards/${id}/run`, { page_id: pageId, filters }).then((r) => r.data),
  patch: (id: string, body: { name?: string; theme?: string; default_filters?: Record<string, string> }) =>
    api.patch<BoardSummary>(`/v2/boards/${id}`, body).then((r) => r.data),
  refresh: (id: string) => api.post(`/v2/boards/${id}/refresh`, {}).then((r) => r.data),
  // R56: edit in place
  columns: (id: string) => api.get<BoardColumns>(`/v2/boards/${id}/columns`).then((r) => r.data),
  layout: (id: string, blockId: string, action: "wider" | "narrower" | "left" | "right" | "remove") =>
    api.post<BoardEdit>(`/v2/boards/${id}/blocks/${blockId}/layout`, { action }).then((r) => r.data),
  retitle: (id: string, blockId: string, title: string) => api.put<BoardEdit>(`/v2/boards/${id}/blocks/${blockId}`, { title }).then((r) => r.data),
  noteText: (id: string, blockId: string, text: string) => api.put<BoardEdit>(`/v2/boards/${id}/blocks/${blockId}`, { text }).then((r) => r.data),
  addChart: (id: string, pageId: string | null, column: string, measure?: string | null) =>
    api.post<BoardEdit>(`/v2/boards/${id}/blocks`, { page_id: pageId, column, measure: measure || null }).then((r) => r.data),
  addNote: (id: string, pageId: string | null, note: string, title?: string) => api.post<BoardEdit>(`/v2/boards/${id}/blocks`, { page_id: pageId, note, title }).then((r) => r.data),
  addFilter: (id: string, column: string) => api.post<BoardEdit>(`/v2/boards/${id}/filters`, { column }).then((r) => r.data),
  removeFilter: (id: string, key: string) => api.delete<BoardEdit>(`/v2/boards/${id}/filters/${encodeURIComponent(key)}`).then((r) => r.data),
  undo: (id: string) => api.post<BoardEdit>(`/v2/boards/${id}/undo`, {}).then((r) => r.data),
  versions: (id: string) => api.get<{ versions: BoardVersion[] }>(`/v2/boards/${id}/versions`).then((r) => r.data.versions),
  restore: (id: string, index: number) => api.post<BoardEdit>(`/v2/boards/${id}/versions/restore`, { index }).then((r) => r.data),
  publish: (id: string, on = true) => api.post<BoardEdit>(`/v2/boards/${id}/${on ? "publish" : "unpublish"}`, {}).then((r) => r.data),
  download: async (id: string, kind: "xlsx" | "pptx", filters: Record<string, string>, name?: string) => {
    const res = await api.get(`/v2/boards/${id}/export.${kind}`, { params: { filters: JSON.stringify(filters || {}) }, responseType: "blob" });
    const cd = String(res.headers?.["content-disposition"] || "");
    const m = cd.match(/filename="?([^";]+)"?/);
    const url = URL.createObjectURL(res.data as Blob);
    const a = document.createElement("a");
    const safe = (name || "dashboard").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "dashboard";
    a.href = url; a.download = m ? m[1] : `${safe}.${kind}`; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  },
};
