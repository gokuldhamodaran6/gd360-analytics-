import type { BlockResult, DashboardBlock, DashboardBlockType, DashboardBuilderDetail } from "../../api/client";
import type { CommentsApi } from "../comments/useComments";

// 2026-10-07 (analyst canvas round): the pure helpers behind the canvas -
// cell order and numbering, the dependency lines, the SQL cell status
// line, the config a PATCH / duplicate sends. Framework-free so the test
// can check them directly.

export type CanvasCellKind = "sql" | "chart" | "kpi" | "text" | "input" | "table";

export type CellInfo = {
  id: string;
  index: number; // 1-based, the number in the gutter
  block: DashboardBlock;
  kind: CanvasCellKind;
  // A SQL cell's identifier (config.name), else null.
  name: string | null;
  label: string;
};

// What the owner can do from the canvas. Each call persists through the
// existing block endpoints and hands the parent the updated dashboard
// (the parent's setDash) - the canvas never holds its own copy of the
// blocks.
export type CanvasOwnerActions = {
  updateBlock: (blockId: string, payload: { title?: string; config?: Record<string, any>; x?: number; y?: number; w?: number; h?: number }) => Promise<DashboardBuilderDetail | void>;
  createBlock: (type: DashboardBlockType, title?: string, config?: Record<string, any>) => Promise<DashboardBuilderDetail | void>;
  deleteBlock: (blockId: string) => Promise<DashboardBuilderDetail | void>;
  swapBlock?: (blockId: string, payload: { chart_type?: string; type?: DashboardBlockType }) => Promise<DashboardBuilderDetail | void>;
};

export const TYPE_LABEL: Record<string, string> = {
  sql: "SQL", chart: "Chart", kpi: "KPI", text: "Text", input: "Input", table: "Table", donut: "Chart", sparkline: "Chart", gauge: "Chart", avatar_list: "Chart", heading: "Text", divider: "Text", filter: "Input",
};

export function cellKindOf(type: DashboardBlockType | string): CanvasCellKind {
  if (type === "sql" || type === "kpi" || type === "text" || type === "input" || type === "table") return type;
  if (type === "heading" || type === "divider") return "text";
  if (type === "filter") return "input";
  return "chart";
}

// The canvas reads the page top-to-bottom: y, then x, then the stored
// position (the only order the grid has, so the two renderings agree).
// Rail-only "filter" blocks are not cells.
export function orderCells(blocks: DashboardBlock[]): CellInfo[] {
  return [...blocks]
    .filter((b) => b.type !== "filter")
    .sort((a, b) => a.y - b.y || a.x - b.x || a.position - b.position)
    .map((block, i) => ({
      id: block.id,
      index: i + 1,
      block,
      kind: cellKindOf(block.type),
      name: block.type === "sql" ? (block.config?.name as string) || null : null,
      label: cellLabel(block),
    }));
}

export function cellLabel(block: DashboardBlock): string {
  if (block.title) return block.title;
  if (block.type === "sql") return (block.config?.name as string) || "Untitled query";
  if (block.type === "text" || block.type === "heading") {
    const text = String(block.config?.text || "").replace(/^#+\s*/, "").split("\n")[0].trim();
    if (text) return text.length > 48 ? `${text.slice(0, 47)}…` : text;
    return "Text";
  }
  if (block.type === "input") return block.config?.parameter_name ? `Input · ${block.config.parameter_name}` : "Input";
  return `${TYPE_LABEL[block.type] || "Cell"} cell`;
}

// "5–7" for a contiguous run, "6, 8" otherwise.
export function formatIndexSet(indexes: number[]): string {
  const sorted = Array.from(new Set(indexes)).sort((a, b) => a - b);
  const parts: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(j - i >= 2 ? `${sorted[i]}–${sorted[j]}` : sorted.slice(i, j + 1).join(", "));
    i = j + 1;
  }
  return parts.join(", ");
}

// The run response's {target: [sources]} as "2 → 3" lines in cell
// numbers, one per target, in target order. Edges to blocks that are not
// on the canvas are dropped.
export function dependencyLines(dependencies: Record<string, string[]>, cells: CellInfo[]): { targetId: string; sources: number[]; target: number; text: string }[] {
  const index = new Map(cells.map((c) => [c.id, c.index]));
  const out: { targetId: string; sources: number[]; target: number; text: string }[] = [];
  for (const [targetId, sourceIds] of Object.entries(dependencies || {})) {
    const target = index.get(targetId);
    if (!target) continue;
    const sources = (sourceIds || []).map((s) => index.get(s)).filter((n): n is number => typeof n === "number");
    if (!sources.length) continue;
    out.push({ targetId, sources, target, text: `${formatIndexSet(sources)} → ${target}` });
  }
  return out.sort((a, b) => a.target - b.target);
}

// The cells this block reads, by number ("← cell 2", "← cells 5 · 6 · 7").
export function sourcesOf(blockId: string, dependencies: Record<string, string[]>, cells: CellInfo[], block?: DashboardBlock): number[] {
  const index = new Map(cells.map((c) => [c.id, c.index]));
  const fromRun = (dependencies?.[blockId] || []).map((s) => index.get(s)).filter((n): n is number => typeof n === "number");
  if (fromRun.length) return fromRun.sort((a, b) => a - b);
  // Before the first run: the binding stored on the block itself.
  const src = block?.config?.source_block_id as string | undefined;
  const n = src ? index.get(src) : undefined;
  return n ? [n] : [];
}

export function formatBytes(n: number | null | undefined): string | null {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`;
  return `${(n / (1024 * 1024 * 1024)).toLocaleString(undefined, { maximumFractionDigits: 2 })} GB`;
}

export function formatSeconds(ms: number | null | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  if (ms < 100) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toLocaleString(undefined, { minimumFractionDigits: ms < 10000 ? 1 : 0, maximumFractionDigits: ms < 10000 ? 1 : 0 })} s`;
}

const PROVIDER: Record<string, string> = { bigquery: "BigQuery", snowflake: "Snowflake", postgres: "Postgres", postgresql: "Postgres", redshift: "Redshift", mysql: "MySQL", duckdb: "GD360" };
export function providerName(kind: string | null | undefined): string {
  if (!kind) return "the warehouse";
  return PROVIDER[kind.toLowerCase()] || kind;
}

// "Ran in BigQuery · 28.6 MB · 1.2 s · 26 rows" (OptionC.dc.html's SQL
// cell status line). "Cached from BigQuery" when the result was served
// from the cache; "26 of 119,386 rows" when the cell hit its row cap.
export function statusLine(result: BlockResult | undefined, fallbackProvider?: string | null): string | null {
  if (!result || result.status !== "ok") return null;
  const parts: string[] = [`${result.cached ? "Cached from" : "Ran in"} ${providerName(result.computed_in || fallbackProvider)}`];
  const bytes = formatBytes(result.bytes_scanned);
  if (bytes && !result.cached) parts.push(bytes);
  const secs = formatSeconds(result.duration_ms);
  if (secs) parts.push(secs);
  const rows = result.row_count ?? result.rows?.length ?? 0;
  parts.push(result.truncated && typeof result.exact_total_rows === "number" ? `${rows.toLocaleString()} of ${result.exact_total_rows.toLocaleString()} rows` : `${rows.toLocaleString()} row${rows === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

// Keys a PATCH never resends: the cached render data older block shapes
// carry (large, and recomputed from the run anyway).
const HEAVY_KEYS = new Set(["chart_spec", "result_rows", "result_columns", "rows", "columns"]);
export function slimConfig(config: Record<string, any> | null | undefined): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(config || {})) if (!HEAVY_KEYS.has(k)) out[k] = v;
  return out;
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function isValidCellName(name: string): boolean {
  return NAME_RE.test(name);
}

// A fresh, unique SQL cell name ("query_1", "query_2", …; "<base>_copy",
// "<base>_copy2" for a duplicate).
export function uniqueCellName(cells: CellInfo[], base = "query"): string {
  const taken = new Set(cells.map((c) => c.name).filter(Boolean) as string[]);
  const root = base.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^(\d)/, "_$1") || "query";
  if (!taken.has(root) && base !== "query") return root;
  let i = 1;
  let candidate = base === "query" ? `${root}_${i}` : `${root}${i === 1 ? "" : i}`;
  while (taken.has(candidate)) {
    i++;
    candidate = base === "query" ? `${root}_${i}` : `${root}${i}`;
  }
  return candidate;
}

// Everything the "{{param}}" highlighter marks up: {{name}}, {{name.from}},
// {{cell:name}} and @name.
export const PARAM_TOKEN_RE = /(\{\{\s*[A-Za-z_][\w.:]*\s*\}\}|@[A-Za-z_]\w*)/g;

export function referencedParams(sql: string): string[] {
  const out: string[] = [];
  for (const m of (sql || "").matchAll(PARAM_TOKEN_RE)) {
    const tok = m[1];
    const name = tok.startsWith("@") ? tok.slice(1) : tok.slice(2, -2).trim();
    if (name.startsWith("cell:")) continue;
    const base = name.split(".")[0];
    if (!out.includes(base)) out.push(base);
  }
  return out;
}

export const FINDING_RE = /^\s*(?:#+\s*)?(?:\*\*)?finding:?(?:\*\*)?:?\s*/i;
export function isFinding(text: string | null | undefined): boolean {
  return FINDING_RE.test(text || "");
}

export function openCommentCount(comments: CommentsApi | null | undefined, blockId: string, fallback?: { open: number; total: number }): { open: number; total: number } {
  if (comments?.enabled) return comments.countFor(blockId);
  return fallback || { open: 0, total: 0 };
}
