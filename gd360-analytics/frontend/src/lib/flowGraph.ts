// Turns the raw /datasources/:id/flow response (see api/client.ts DataFlow)
// into a positioned graph the Flow tab can render: one node per real
// origin (this datasource's original data, one of its sheets, or another
// separately-connected data source pulled in via "+ Add more data"), one
// node per saved/prepared table, one node per chart-producing question -
// wired together with edges that show exactly which table(s) fed which
// table or chart, including a merge across two different data sources.
// Layout is computed with dagre (left-to-right, matching the natural
// "raw data -> prepared -> chart" reading order) so the map always looks
// clean regardless of how tangled the underlying history actually is.
import dagre from "@dagrejs/dagre";
import type { Edge, Node } from "@xyflow/react";
import { DataFlow, FlowNode, FlowSource, FlowVersion } from "../api/client";

export type FlowCardKind = "source" | "external" | "table" | "chart";

export type FlowCardData = {
  kind: FlowCardKind;
  title: string;
  subtitle: string;
  detail?: string;
  meta?: string;
  isCurrentDatasource: boolean;
  // What clicking this card should do - Workspace.tsx supplies the actual
  // handlers; this is just the payload describing the target.
  onClick:
    | { type: "jump-source"; datasourceId: string; sheet: string | null }
    | { type: "jump-version"; datasourceId: string; versionId: string }
    | { type: "jump-chart"; conversationId: string; messageId: string }
    | null;
  [key: string]: unknown;
};

export type FlowCardNode = Node<FlowCardData, "card">;

const NODE_WIDTH = 258;
const NODE_HEIGHT = 96;

function sourceOriginKey(datasourceId: string, sheet: string | null): string {
  return sheet ? `sheet:${datasourceId}:${sheet}` : `orig:${datasourceId}`;
}

function resolveSourceNodeId(
  s: FlowSource, currentDatasourceId: string, versionIds: Set<string>
): string {
  if (s.kind === "version" && s.version_id) {
    if (s.datasource_id === currentDatasourceId && versionIds.has(s.version_id)) {
      return `ver:${s.version_id}`;
    }
    // A saved table from a DIFFERENT, separately-connected data source -
    // not one of THIS datasource's own versions, so it gets its own small
    // "external" origin card instead of a full table card (this map only
    // ever draws one datasource's own prepared-table history in full).
    return `extver:${s.version_id}`;
  }
  return sourceOriginKey(s.datasource_id, s.sheet);
}

function relativeDate(iso: string): string {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const day = 86400000;
  if (diffMs < 3600000) return "just now";
  if (diffMs < day) return `${Math.max(1, Math.round(diffMs / 3600000))}h ago`;
  if (diffMs < 7 * day) return `${Math.round(diffMs / day)}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const CHART_TYPE_LABELS: Record<string, string> = {
  bar: "Bar", horizontal_bar: "Bar", grouped_bar: "Grouped bar", stacked_bar: "Stacked bar",
  faceted_bar: "Faceted bar", line: "Line", step_line: "Line", area: "Area", stacked_area: "Area",
  pie: "Pie", donut: "Donut", scatter: "Scatter", bubble: "Bubble", histogram: "Histogram",
  box: "Box plot", violin: "Violin", heatmap: "Heatmap", density_heatmap: "Heatmap",
  waterfall: "Waterfall", funnel: "Funnel", funnel_area: "Funnel", treemap: "Treemap",
  sunburst: "Sunburst", icicle: "Icicle", radar: "Radar", polar_bar: "Polar bar",
  sankey: "Sankey", gauge: "Gauge", candlestick: "Candlestick", ohlc: "OHLC",
  dot_plot: "Dot plot", contour: "Contour", scatter_3d: "3D scatter", error_bar: "Error bar",
  parallel_coordinates: "Parallel coords", choropleth: "Map",
};

export function buildFlowGraph(
  flow: DataFlow, currentDatasourceId: string
): { nodes: FlowCardNode[]; edges: Edge[]; isEmpty: boolean } {
  const versionIds = new Set(flow.versions.map((v) => v.id));
  const versionById = new Map(flow.versions.map((v) => [v.id, v]));

  // A version's creating turn (the transform/prep message whose
  // new_version_id points at it) - used both to caption the table card
  // with the real question that built it, and, when available, as the
  // authoritative source list for that table's incoming edges (richer
  // than parent_version_ids alone, since it also captures "from the
  // untouched original data" and cross-datasource merges).
  const creatorByVersionId = new Map<string, FlowNode>();
  for (const n of flow.nodes) {
    if (n.new_version_id) creatorByVersionId.set(n.new_version_id, n);
  }

  const nodes: FlowCardNode[] = [];
  const edges: Edge[] = [];
  const seenOrigin = new Set<string>();
  const seenExternalVersion = new Set<string>();
  let edgeSeq = 0;

  const addOriginNode = (datasourceId: string, sheet: string | null, label: string) => {
    const id = sourceOriginKey(datasourceId, sheet);
    if (seenOrigin.has(id)) return id;
    seenOrigin.add(id);
    const isCurrent = datasourceId === currentDatasourceId;
    nodes.push({
      id,
      type: "card",
      position: { x: 0, y: 0 },
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      data: {
        kind: "source",
        title: label,
        subtitle: isCurrent ? "Original data" : "Connected data source",
        isCurrentDatasource: isCurrent,
        onClick: { type: "jump-source", datasourceId, sheet },
      },
    });
    return id;
  };

  const addExternalVersionNode = (s: FlowSource) => {
    const id = `extver:${s.version_id}`;
    if (seenExternalVersion.has(id)) return id;
    seenExternalVersion.add(id);
    nodes.push({
      id,
      type: "card",
      position: { x: 0, y: 0 },
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      data: {
        kind: "external",
        title: s.label,
        subtitle: "Saved table, another data source",
        isCurrentDatasource: false,
        onClick: s.version_id ? { type: "jump-version", datasourceId: s.datasource_id, versionId: s.version_id } : null,
      },
    });
    return id;
  };

  const addEdge = (source: string, target: string) => {
    const id = `e${edgeSeq++}:${source}->${target}`;
    edges.push({
      id, source, target, type: "smoothstep", animated: false,
      style: { stroke: "rgb(var(--color-border))", strokeWidth: 1.5 },
    });
  };

  const drawSourcesInto = (sources: FlowSource[] | null | undefined, targetId: string, fallbackParents: string[]) => {
    if (sources && sources.length) {
      for (const s of sources) {
        const nodeId = resolveSourceNodeId(s, currentDatasourceId, versionIds);
        if (nodeId.startsWith("extver:")) addExternalVersionNode(s);
        else if (nodeId.startsWith("orig:") || nodeId.startsWith("sheet:")) addOriginNode(s.datasource_id, s.sheet, s.label);
        addEdge(nodeId, targetId);
      }
      return;
    }
    // Legacy row (saved before Message.sources existed) or a table with no
    // recorded creator at all: fall back to parent_version_ids, and if
    // even that is empty, assume it came from this datasource's own
    // original data - always true for the very first table anyone builds.
    if (fallbackParents.length) {
      for (const pid of fallbackParents) {
        if (versionIds.has(pid)) addEdge(`ver:${pid}`, targetId);
      }
    } else {
      const originId = addOriginNode(currentDatasourceId, null, "Original data");
      addEdge(originId, targetId);
    }
  };

  // Always anchor the map on this datasource's own original data, even if
  // every table so far happens to chain from another table - it is where
  // the whole story starts.
  addOriginNode(currentDatasourceId, null, "Original data");

  for (const v of flow.versions) {
    const targetId = `ver:${v.id}`;
    const creator = creatorByVersionId.get(v.id);
    const fallbackParents = v.parent_version_ids && v.parent_version_ids.length
      ? v.parent_version_ids
      : v.parent_version_id ? [v.parent_version_id] : [];
    nodes.push({
      id: targetId,
      type: "card",
      position: { x: 0, y: 0 },
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      data: {
        kind: "table",
        title: v.name,
        subtitle: `${v.step_count} cleaning step${v.step_count === 1 ? "" : "s"}`,
        detail: creator?.prompt ? `Asked: "${creator.prompt}"` : undefined,
        meta: relativeDate(v.created_at),
        isCurrentDatasource: true,
        onClick: { type: "jump-version", datasourceId: currentDatasourceId, versionId: v.id },
      },
    });
    drawSourcesInto(creator?.sources ?? null, targetId, fallbackParents);
  }

  for (const n of flow.nodes) {
    if (!n.has_chart) continue;
    const targetId = `msg:${n.message_id}`;
    nodes.push({
      id: targetId,
      type: "card",
      position: { x: 0, y: 0 },
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      data: {
        kind: "chart",
        title: n.prompt || "Untitled question",
        subtitle: CHART_TYPE_LABELS[n.chart_type || ""] || (n.chart_type ? n.chart_type : "Chart"),
        meta: `${relativeDate(n.created_at)} · ${n.conversation_title}`,
        isCurrentDatasource: true,
        onClick: { type: "jump-chart", conversationId: n.conversation_id, messageId: n.message_id },
      },
    });
    drawSourcesInto(n.sources, targetId, []);
  }

  const isEmpty = flow.versions.length === 0 && flow.nodes.every((n) => !n.has_chart);
  return { nodes: layoutNodes(nodes, edges), edges, isEmpty };
}

export function layoutNodes(nodes: FlowCardNode[], edges: Edge[]): FlowCardNode[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 36, ranksep: 110, marginx: 16, marginy: 16 });
  g.setDefaultEdgeLabel(() => ({}));
  nodes.forEach((n) => g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT }));
  edges.forEach((e) => g.setEdge(e.source, e.target));
  dagre.layout(g);
  return nodes.map((n) => {
    const pos = g.node(n.id);
    return pos ? { ...n, position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 } } : n;
  });
}

export const FLOW_NODE_SIZE = { width: NODE_WIDTH, height: NODE_HEIGHT };
