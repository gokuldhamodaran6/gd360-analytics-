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
  // Which step of the story this card is, counting from 1 at the raw data
  // this chain started from (see assignStepNumbers below). Purely
  // mechanical - the longest chain of real recorded edges leading into
  // this card, nothing inferred or guessed - so a person can tell "first,
  // then second, then third" at a glance instead of having to read the
  // left-to-right layout as a proxy for order.
  step: number;
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
  flow: DataFlow, currentDatasourceId: string,
  // When set, the map only shows this conversation's own tables/charts,
  // plus - walking backward through the real recorded edges - whatever
  // upstream raw data/tables actually fed them, even if THAT upstream
  // table happened to be built in a different conversation (you still
  // need to see what you built on top of). It deliberately does NOT walk
  // forward: a table this conversation built that some OTHER, later
  // conversation went on to use is left out, since that is not this
  // conversation's own story. Omit/null to see every conversation ever
  // run against this datasource, exactly as before.
  scopeConversationId?: string | null
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
        step: 1,
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
        step: 1,
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
        step: 1,
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
        step: 1,
        isCurrentDatasource: true,
        onClick: { type: "jump-chart", conversationId: n.conversation_id, messageId: n.message_id },
      },
    });
    // An "analyze" question often preps its OWN small table first (see
    // backend ai_engine._run_analyze_with_prep) before charting from it -
    // that prepped table is already drawn above (in the versions loop,
    // with its own correct incoming edges from n.sources). When that
    // happened, the chart must connect FROM that table, not bypass it and
    // duplicate a second edge straight back to the raw original/selected
    // sources - otherwise the map looks like every chart came directly
    // from the raw data even when it was really built from a cleaned
    // table one step earlier, which is exactly the "loop through the
    // table it was created from" flow this map is supposed to show.
    if (n.new_version_id && versionIds.has(n.new_version_id)) {
      addEdge(`ver:${n.new_version_id}`, targetId);
    } else {
      drawSourcesInto(n.sources, targetId, []);
    }
  }

  let scopedNodes = nodes;
  let scopedEdges = edges;
  if (scopeConversationId) {
    const keep = conversationAncestorScope(flow, creatorByVersionId, scopeConversationId, edges);
    scopedNodes = nodes.filter((n) => keep.has(n.id));
    scopedEdges = edges.filter((e) => keep.has(e.source) && keep.has(String(e.target)));
  }

  assignStepNumbers(scopedNodes, scopedEdges);

  const isEmpty = scopeConversationId
    ? !flow.nodes.some((n) => n.has_chart && n.conversation_id === scopeConversationId)
      && !flow.versions.some((v) => creatorByVersionId.get(v.id)?.conversation_id === scopeConversationId)
    : flow.versions.length === 0 && flow.nodes.every((n) => !n.has_chart);

  return { nodes: layoutNodes(scopedNodes, scopedEdges), edges: scopedEdges, isEmpty };
}

// Every card that is genuinely part of THIS conversation's own story: any
// chart it produced, any table it built (charted or not), plus - by
// walking real edges backward - everything those actually came from. A
// plain graph reachability walk over the exact same edges the rest of
// this file already drew from recorded Message.sources/new_version_id, so
// scoping to one conversation never invents or guesses a connection; it
// only ever hides cards that truly have no recorded path into this
// conversation's own work.
function conversationAncestorScope(
  flow: DataFlow,
  creatorByVersionId: Map<string, FlowNode>,
  scopeConversationId: string,
  edges: Edge[],
): Set<string> {
  const keep = new Set<string>();
  for (const n of flow.nodes) {
    if (n.has_chart && n.conversation_id === scopeConversationId) keep.add(`msg:${n.message_id}`);
  }
  for (const v of flow.versions) {
    if (creatorByVersionId.get(v.id)?.conversation_id === scopeConversationId) keep.add(`ver:${v.id}`);
  }

  const parentsOf = new Map<string, string[]>();
  for (const e of edges) {
    const target = String(e.target);
    if (!parentsOf.has(target)) parentsOf.set(target, []);
    parentsOf.get(target)!.push(e.source);
  }

  const queue = Array.from(keep);
  let head = 0;
  while (head < queue.length) {
    const id = queue[head++];
    for (const parentId of parentsOf.get(id) || []) {
      if (!keep.has(parentId)) { keep.add(parentId); queue.push(parentId); }
    }
  }
  return keep;
}

// Labels every card "Step 1", "Step 2", "Step 3"... purely from the real
// edges already drawn above (which themselves come straight from recorded
// Message.sources / new_version_id / parent_version_ids - never guessed).
// A raw-data card that nothing points into is always Step 1. Anything else
// is one more than the LONGEST chain of real edges leading into it, so a
// chart built from a table that was itself built from another table reads
// as Step 3, not Step 2 - the count always matches how many real hops back
// to raw data that specific card actually took, even when a shorter path
// into the same card also exists (e.g. it also lists the untouched
// original data as one of several sources alongside a prepared table).
// This is a plain topological (Kahn's-algorithm) longest-path pass - no AI
// involved, no heuristics, just counting real recorded hops - so the
// number on screen is always something the underlying data can prove.
function assignStepNumbers(nodes: FlowCardNode[], edges: Edge[]) {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const n of nodes) { children.set(n.id, []); indegree.set(n.id, 0); }
  for (const e of edges) {
    if (!nodeById.has(e.source) || !nodeById.has(String(e.target))) continue;
    children.get(e.source)!.push(String(e.target));
    indegree.set(String(e.target), (indegree.get(String(e.target)) || 0) + 1);
  }

  const queue: string[] = [];
  for (const n of nodes) {
    n.data.step = 1;
    if ((indegree.get(n.id) || 0) === 0) queue.push(n.id);
  }

  // Kahn's algorithm: only ever visits a node once every one of its
  // incoming edges has already been relaxed, so by the time it is
  // processed its step already reflects the longest chain into it -
  // immune to cycles too (a card simply keeps its default Step 1 if one
  // ever slipped through, rather than looping forever).
  let head = 0;
  while (head < queue.length) {
    const id = queue[head++];
    const fromStep = nodeById.get(id)!.data.step;
    for (const childId of children.get(id) || []) {
      const child = nodeById.get(childId)!;
      child.data.step = Math.max(child.data.step, fromStep + 1);
      const remaining = (indegree.get(childId) || 0) - 1;
      indegree.set(childId, remaining);
      if (remaining === 0) queue.push(childId);
    }
  }
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
