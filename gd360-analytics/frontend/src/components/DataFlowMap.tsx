// The Flow tab: a premium, pannable/zoomable map of exactly how this data
// source's story unfolded - which raw data (this datasource's own, or
// another separately-connected one pulled in via "+ Add more data") fed
// which prepared table, and which table(s) fed which chart/question -
// across every conversation ever run against this datasource, not just
// the one currently open. Read-only by design (see the engagement's own
// answer on this): every card is a live shortcut back to wherever that
// table or chart actually lives, so renaming/editing always happens in
// exactly one place and can never drift out of sync with this map.
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  Background, BackgroundVariant, Controls, Handle, MiniMap, Node, NodeProps,
  Panel, Position, ReactFlow, ReactFlowProvider, useNodesState,
} from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import { datasourceApi, DataFlow } from "../api/client";
import { buildFlowGraph, FlowCardData, FlowCardKind, FlowCardNode } from "../lib/flowGraph";

// Validated against the app's real dark (surface #121214) and light
// (surface #fffff) backgrounds with the dataviz skill's palette validator
// - all-pairs CVD/contrast checks pass for this exact triad; the aqua
// slot deliberately matches GD360's own accent-green family so the
// "chart" category still reads as this app's own brand color, not a
// generic import. Every card also carries an icon + a full text label, so
// identity is never color-alone (the one CVD pair that lands in the 6-8
// warn band - green vs orange - is explicitly allowed only with that
// secondary encoding, which this always has).
const KIND_STYLE: Record<FlowCardKind, {
  light: string; dark: string; label: string; icon: JSX.Element;
}> = {
  source: {
    light: "#2a78d6", dark: "#3987e5", label: "Raw data",
    icon: (
      <svg viewBox="0 0 20 20" width="15" height="15" fill="none">
        <ellipse cx="10" cy="5" rx="6.5" ry="2.5" stroke="currentColor" strokeWidth="1.4" />
        <path d="M3.5 5v10c0 1.38 2.91 2.5 6.5 2.5s6.5-1.12 6.5-2.5V5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        <path d="M3.5 10c0 1.38 2.91 2.5 6.5 2.5s6.5-1.12 6.5-2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    ),
  },
  external: {
    light: "#2a78d6", dark: "#3987e5", label: "From another data source",
    icon: (
      <svg viewBox="0 0 20 20" width="15" height="15" fill="none">
        <rect x="3" y="3" width="10" height="10" rx="1.6" stroke="currentColor" strokeWidth="1.4" />
        <path d="M9 11l7-7M16 4h-4M16 4v4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  table: {
    light: "#eb6834", dark: "#d95926", label: "Prepared table",
    icon: (
      <svg viewBox="0 0 20 20" width="15" height="15" fill="none">
        <rect x="2.5" y="3.5" width="15" height="13" rx="1.6" stroke="currentColor" strokeWidth="1.4" />
        <path d="M2.5 8h15M8 3.5v13" stroke="currentColor" strokeWidth="1.4" />
      </svg>
    ),
  },
  chart: {
    light: "#1baf7a", dark: "#199e70", label: "Chart & insight",
    icon: (
      <svg viewBox="0 0 20 20" width="15" height="15" fill="none">
        <path d="M3 16.5V3M3 16.5h14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        <rect x="6" y="10.5" width="2.4" height="6" rx="0.6" fill="currentColor" />
        <rect x="10.2" y="6.5" width="2.4" height="10" rx="0.6" fill="currentColor" />
        <rect x="14.4" y="8.8" width="2.4" height="7.7" rx="0.6" fill="currentColor" />
      </svg>
    ),
  },
};

function FlowCard({ data, selected }: NodeProps<Node<FlowCardData, "card">>) {
  const style = KIND_STYLE[data.kind];
  const clickable = !!data.onClick;
  // A person's own saved description (Phase 2, feature 2) is more useful
  // as the hover tooltip than the auto-generated "Asked: ..." detail line
  // once one exists, since it's the thing they deliberately wrote to
  // explain this exact card - the detail line itself still renders below
  // either way, unchanged.
  const tooltip = data.annotationDescription || data.detail || data.title;
  return (
    <div
      className={`flow-card flow-card--${data.kind} ${clickable ? "flow-card--clickable" : ""} ${selected ? "flow-card--selected" : ""}`}
      style={{ ["--card-hue" as string]: `var(--flow-${data.kind})` }}
      title={tooltip}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <div className="flow-card__bar" />
      <div
        className="flow-card__step"
        title={`Step ${data.step} of this chain, counting from the raw data it started from`}
      >
        {data.step}
      </div>
      <div className="flow-card__body">
        <div className="flow-card__top">
          <span className="flow-card__icon">{style.icon}</span>
          <span className="flow-card__title">{data.title}</span>
          {typeof data.durationMs === "number" && (
            <span className="flow-card__timing" title="How long this step actually took to run">
              {data.durationMs < 1000 ? "<1s" : `${(data.durationMs / 1000).toFixed(1)}s`}
            </span>
          )}
        </div>
        <div className="flow-card__subtitle">{data.subtitle}</div>
        {data.methodSummary && <div className="flow-card__method">{data.methodSummary}</div>}
        {data.annotationDescription ? (
          <div className="flow-card__detail">{data.annotationDescription}</div>
        ) : (
          data.detail && <div className="flow-card__detail">{data.detail}</div>
        )}
        {data.meta && <div className="flow-card__meta">{data.meta}</div>}
        {!data.isCurrentDatasource && data.kind !== "source" && (
          <div className="flow-card__badge">External</div>
        )}
      </div>
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
}

const nodeTypes = { card: FlowCard };

export type FlowJumpTarget =
  | { type: "jump-source"; datasourceId: string; sheet: string | null }
  | { type: "jump-version"; datasourceId: string; versionId: string }
  | { type: "jump-chart"; conversationId: string; messageId: string };

export default function DataFlowMap({
  flow, loading, error, currentDatasourceId, currentConversationId, onJump,
}: {
  flow: DataFlow | null;
  loading: boolean;
  error: string;
  currentDatasourceId: string;
  // The conversation currently open in the chat panel next to this map -
  // null only in the brief moment before a brand-new conversation's first
  // message has been sent. Defaulting the map to just this conversation
  // (see `scope` below) is what keeps someone from feeling lost in every
  // other chat's history the moment they open the Flow tab; the toggle
  // lets them deliberately ask for the full picture when they want it.
  currentConversationId: string | null;
  onJump: (target: FlowJumpTarget) => void;
}) {
  const [scope, setScope] = useState<"conversation" | "all">("conversation");
  const effectiveScope = scope === "conversation" && currentConversationId ? currentConversationId : null;

  // Phase 2, feature 2 (persistent, editable semantic layer): read-only by
  // default, exactly as this map always was - "view" mode renders and
  // behaves identically to before this feature existed (nodesDraggable
  // false, no double-click handler wired up), so nobody who never opens
  // Edit mode sees any behavior change at all. Not gated on a can_edit
  // prop the way DashboardBuilderView.tsx gates its own Edit/Preview
  // toggle - this codebase's own convention for datasource-level write
  // actions (see DataTable.tsx's rename/delete buttons, never role-gated
  // client-side either) is to let the backend's _get_editable_datasource
  // reject the write itself; a viewer who opens Edit mode here and tries
  // to drag or rename a card simply gets the same "could not save" error
  // surface as any other failed request.
  const [mode, setMode] = useState<"view" | "edit">("view");

  const graph = useMemo(
    () => (flow ? buildFlowGraph(flow, currentDatasourceId, effectiveScope) : null),
    [flow, currentDatasourceId, effectiveScope]
  );

  // A locally-owned copy of the graph's nodes, fed by `graph` above but
  // then also mutated directly here as a card is dragged (react-flow's own
  // position-change events, applied via onNodesChange) or renamed/described
  // (see saveAnnotation below) - without this, a controlled `nodes` prop
  // that never changed after the initial render would fight every drag
  // frame back to its last computed position. Re-synced from `graph`
  // whenever the underlying flow data or scope actually changes, which
  // also naturally picks up any position/label saved from a DIFFERENT
  // browser tab or teammate on the next fetch.
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<FlowCardNode>([]);
  // Rebuilt from `graph` only when the underlying flow DATA actually
  // changes (a real refetch, or a different scope/cross-pipeline
  // selection) - deliberately NOT also keyed on `mode`, so simply flipping
  // Edit/Preview back and forth never discards a position this same
  // session already dragged, or a label/description this same session
  // already renamed, before the next real refetch comes in and folds them
  // into `flow` properly. The separate effect below handles `mode` instead.
  useEffect(() => {
    // Only a table/chart card (one with a real nodeKey) is ever draggable,
    // and only in Edit mode - a raw-data origin, external, or
    // cross-pipeline reference card has nowhere to persist a position to
    // (see FlowCardData.nodeKey's own comment), so it never becomes
    // draggable no matter what mode this is in.
    setRfNodes(graph ? graph.nodes.map((n) => ({ ...n, draggable: mode === "edit" && !!n.data.nodeKey })) : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph]);
  useEffect(() => {
    setRfNodes((prev) => prev.map((n) => ({ ...n, draggable: mode === "edit" && !!n.data.nodeKey })));
  }, [mode, setRfNodes]);

  const [saveError, setSaveError] = useState("");
  const [editingNode, setEditingNode] = useState<{ id: string; nodeKey: string; label: string; description: string; busy: boolean } | null>(null);

  const handleNodeClick = (_: unknown, node: FlowCardNode) => {
    if (mode === "edit") return; // Edit mode double-click renames instead - see handleNodeDoubleClick.
    if (node.data.onClick) onJump(node.data.onClick);
  };

  // Persists a card's new position - fired from onNodeDragStop below,
  // which - exactly like react-grid-layout's onDragStop that the Dashboard
  // Builder canvas already relies on (see routers/dashboard_builder.py
  // update_block's own docstring: "once per completed drag or resize
  // gesture ... never on every intermediate frame") - only ever fires once
  // a drag gesture actually finishes. That single real event IS the
  // debounce: there is no separate timer here because react-flow, like
  // react-grid-layout, already collapses an entire drag into one call.
  const handleNodeDragStop = (_: unknown, node: FlowCardNode) => {
    if (mode !== "edit" || !node.data.nodeKey) return;
    datasourceApi
      .updateFlowAnnotation(currentDatasourceId, node.data.nodeKey, { position_x: node.position.x, position_y: node.position.y })
      .catch(() => setSaveError("Could not save this card's new position. Please try dragging it again."));
  };

  const handleNodeDoubleClick = (_: unknown, node: FlowCardNode) => {
    if (mode !== "edit" || !node.data.nodeKey) return;
    setEditingNode({
      id: node.id,
      nodeKey: node.data.nodeKey,
      label: node.data.title,
      description: node.data.annotationDescription || "",
      busy: false,
    });
  };

  const saveAnnotation = async () => {
    if (!editingNode) return;
    setEditingNode({ ...editingNode, busy: true });
    try {
      await datasourceApi.updateFlowAnnotation(currentDatasourceId, editingNode.nodeKey, {
        display_label: editingNode.label.trim(),
        description: editingNode.description.trim(),
      });
      // The card's raw, un-annotated default (its real table name, or the
      // real prompt that produced a chart) lives on the original `flow`
      // prop, not on the derived card itself - looked up here so clearing
      // the label field (saving an empty string, which the backend treats
      // as "remove the override") correctly falls back to it locally
      // instead of just going blank until the next full refetch.
      const defaultTitle =
        flow?.versions.find((v) => v.id === editingNode.nodeKey)?.name
        ?? flow?.nodes.find((n) => n.message_id === editingNode.nodeKey)?.prompt
        ?? "Untitled";
      const savedLabel = editingNode.label.trim();
      const savedDescription = editingNode.description.trim();
      setRfNodes((prev) =>
        prev.map((n) =>
          n.data.nodeKey === editingNode.nodeKey
            ? { ...n, data: { ...n.data, title: savedLabel || defaultTitle, annotationDescription: savedDescription || null } }
            : n
        )
      );
      setEditingNode(null);
    } catch {
      setEditingNode({ ...editingNode, busy: false });
      setSaveError("Could not save this card's name/description. Please try again.");
    }
  };

  return (
    <div className="flow-map-root h-full w-full relative rounded-2xl border border-border overflow-hidden">
      <style>{FLOW_CSS}</style>

      <div className="flow-toolbar">
        <div className="flow-scope-toggle" role="group" aria-label="Flow map scope">
          <button
            type="button"
            className={scope === "conversation" ? "flow-scope-toggle__btn flow-scope-toggle__btn--active" : "flow-scope-toggle__btn"}
            onClick={() => setScope("conversation")}
          >
            This conversation
          </button>
          <button
            type="button"
            className={scope === "all" ? "flow-scope-toggle__btn flow-scope-toggle__btn--active" : "flow-scope-toggle__btn"}
            onClick={() => setScope("all")}
          >
            All conversations
          </button>
        </div>

        {/* Phase 2, feature 2: mirrors DashboardBuilderView.tsx's own
            Edit/Preview segmented toggle (same two-button, bordered-pill
            look) rather than inventing a different pattern for the same
            idea in this other tab. */}
        <div className="flow-scope-toggle" role="group" aria-label="Flow map edit mode">
          <button
            type="button"
            className={mode === "edit" ? "flow-scope-toggle__btn flow-scope-toggle__btn--active" : "flow-scope-toggle__btn"}
            onClick={() => setMode("edit")}
          >
            Edit
          </button>
          <button
            type="button"
            className={mode === "view" ? "flow-scope-toggle__btn flow-scope-toggle__btn--active" : "flow-scope-toggle__btn"}
            onClick={() => setMode("view")}
          >
            Preview
          </button>
        </div>
      </div>

      {mode === "edit" && (
        <div className="flow-edit-hint">
          Drag a shared card to reposition it, or double-click it to rename or describe it. Changes save automatically.
        </div>
      )}

      {saveError && (
        <div className="flow-save-error" role="alert">
          {saveError}
          <button type="button" onClick={() => setSaveError("")} aria-label="Dismiss">&times;</button>
        </div>
      )}

      {loading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-surface/70 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-2 text-sm text-muted">
            <div className="h-8 w-8 rounded-full border-2 border-border border-t-primary animate-spin" />
            Mapping how your data flows&hellip;
          </div>
        </div>
      )}

      {!loading && error && (
        <div className="absolute inset-0 flex items-center justify-center px-6">
          <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 max-w-sm text-center">
            {error}
          </div>
        </div>
      )}

      {!loading && !error && graph && graph.isEmpty && (
        <div className="absolute inset-0 flex items-center justify-center px-6">
          <div className="text-center max-w-sm">
            <div className="mx-auto mb-3 h-12 w-12 rounded-2xl bg-surface2 border border-border flex items-center justify-center text-muted">
              <svg viewBox="0 0 20 20" width="22" height="22" fill="none">
                <ellipse cx="10" cy="5" rx="6.5" ry="2.5" stroke="currentColor" strokeWidth="1.4" />
                <path d="M3.5 5v10c0 1.38 2.91 2.5 6.5 2.5s6.5-1.12 6.5-2.5V5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
            </div>
            <div className="text-sm font-semibold text-text mb-1">
              {effectiveScope ? "Nothing in this conversation yet" : "Nothing to map yet"}
            </div>
            <div className="text-xs text-muted leading-relaxed">
              {effectiveScope
                ? "This conversation hasn't built a table or chart yet. Ask a question or clean this data in the chat and it'll show up here."
                : "Ask a question or clean this data in the chat, and every table and chart it creates will show up here, connected to exactly what it came from."}
            </div>
            {effectiveScope && (
              <button type="button" className="flow-empty__all-link" onClick={() => setScope("all")}>
                View all conversations on this data instead
              </button>
            )}
          </div>
        </div>
      )}

      {!loading && !error && graph && !graph.isEmpty && (
        <ReactFlowProvider>
          <ReactFlow
            nodes={rfNodes}
            edges={graph.edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onNodeClick={handleNodeClick}
            onNodeDragStop={handleNodeDragStop}
            onNodeDoubleClick={handleNodeDoubleClick}
            fitView
            fitViewOptions={{ padding: 0.25, maxZoom: 1.1 }}
            minZoom={0.15}
            maxZoom={2}
            proOptions={{ hideAttribution: false }}
            defaultEdgeOptions={{ type: "smoothstep" }}
            panOnScroll
            zoomOnPinch
            // Per-node `draggable` (set above, in the effect that builds
            // rfNodes) is what actually decides whether any given card can
            // move - this global flag only needs to be non-false so
            // react-flow doesn't blanket-veto every node regardless of its
            // own draggable field.
            nodesDraggable
            nodesConnectable={false}
            elementsSelectable
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1} className="flow-bg" />
            <Controls showInteractive={false} className="flow-controls" />
            <MiniMap
              className="flow-minimap"
              pannable
              zoomable
              nodeColor={(n) => {
                const kind = (n.data as FlowCardData).kind;
                return `var(--flow-${kind})`;
              }}
              maskColor="rgba(10,10,11,0.65)"
            />
            <Panel position="top-right" className="flow-legend">
              {(Object.keys(KIND_STYLE) as FlowCardKind[])
                .filter((k) => k !== "external")
                .map((k) => (
                  <div key={k} className="flow-legend__row">
                    <span className="flow-legend__swatch" style={{ background: `var(--flow-${k})` }} />
                    <span>{KIND_STYLE[k].label}</span>
                  </div>
                ))}
              <div className="flow-legend__row flow-legend__row--hint">
                <span className="flow-legend__step-sample">1</span>
                <span>Build order - 1 is the earliest step in that chain</span>
              </div>
            </Panel>
          </ReactFlow>
        </ReactFlowProvider>
      )}

      {/* Phase 2, feature 2: the double-click rename/describe modal - same
          portal + centered-card pattern as BuildDashboardModal.tsx/
          DataTable.tsx's own promote-to-shared-model modal. */}
      {editingNode && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={(e) => { if (e.target === e.currentTarget && !editingNode.busy) setEditingNode(null); }}
        >
          <div className="dash-card w-full max-w-md p-6 relative">
            <button
              className="absolute top-4 right-4 text-muted hover:text-text transition disabled:opacity-40"
              onClick={() => setEditingNode(null)}
              disabled={editingNode.busy}
              aria-label="Close"
            >
              &times;
            </button>
            <h2 className="text-lg font-bold mb-1">Rename &amp; describe this card</h2>
            <p className="text-xs text-muted mb-4 leading-relaxed">
              Only changes how this card looks on the Flow map - the table or chart itself keeps its real name
              everywhere else in the app. Clear a field to go back to its default.
            </p>
            <label className="text-xs font-medium text-muted mb-1 block">Label</label>
            <input
              autoFocus
              className="input text-sm w-full mb-3"
              value={editingNode.label}
              onChange={(e) => setEditingNode({ ...editingNode, label: e.target.value })}
              maxLength={120}
            />
            <label className="text-xs font-medium text-muted mb-1 block">Description</label>
            <textarea
              className="input text-sm w-full min-h-[70px]"
              value={editingNode.description}
              onChange={(e) => setEditingNode({ ...editingNode, description: e.target.value })}
              maxLength={2000}
              placeholder="Optional - what should someone else know about this card?"
            />
            <div className="flex justify-end gap-2 mt-4">
              <button className="btn-secondary text-xs px-3 py-1.5" onClick={() => setEditingNode(null)} disabled={editingNode.busy}>
                Cancel
              </button>
              <button className="btn-primary text-xs px-3 py-1.5" onClick={saveAnnotation} disabled={editingNode.busy}>
                {editingNode.busy ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

// A local, scoped stylesheet (rather than editing the project's global
// index.css) - keeps every rule this one tab needs in the same file that
// defines it. Colors are declared as CSS variables with light/dark pairs
// so the app's existing theme toggle (data-theme="light"/"dark" on the
// root, same mechanism index.css already uses) flips them automatically.
const FLOW_CSS = `
.flow-map-root {
  --flow-source: #2a78d6;
  --flow-external: #2a78d6;
  --flow-table: #eb6834;
  --flow-chart: #1baf7a;
  background: rgb(var(--color-surface));
}
:root[data-theme="dark"] .flow-map-root,
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .flow-map-root {
  --flow-source: #3987e5;
  --flow-external: #3987e5;
  --flow-table: #d95926;
  --flow-chart: #199e70;
} }
.flow-map-root .react-flow { --xy-background-color: transparent; }
.flow-bg { opacity: 0.55; }
.flow-map-root .react-flow__background-pattern { fill: rgb(var(--color-border)); }

.flow-card {
  position: relative;
  width: 258px;
  min-height: 90px;
  display: flex;
  background: rgb(var(--color-surface2));
  border: 1px solid rgb(var(--color-border));
  border-radius: 12px;
  overflow: visible;
  box-shadow: 0 1px 2px rgba(0,0,0,0.15);
  transition: transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease;
}
.flow-card__bar,
.flow-card__body { overflow: hidden; }
.flow-card__bar { border-radius: 12px 0 0 12px; }
.flow-card__body { border-radius: 0 12px 12px 0; }
.flow-card--clickable { cursor: pointer; }
.flow-card--clickable:hover {
  transform: translateY(-2px);
  border-color: var(--card-hue);
  box-shadow: 0 10px 24px rgba(0,0,0,0.28), 0 0 0 1px var(--card-hue) inset;
}
.flow-card--selected { border-color: var(--card-hue); box-shadow: 0 0 0 2px var(--card-hue); }
.flow-card__bar { width: 4px; flex-shrink: 0; background: var(--card-hue); }
.flow-card__step {
  position: absolute;
  top: -7px;
  left: -7px;
  width: 18px;
  height: 18px;
  border-radius: 999px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 700;
  color: rgb(var(--color-surface));
  background: var(--card-hue);
  border: 1.5px solid rgb(var(--color-surface));
  box-shadow: 0 1px 3px rgba(0,0,0,0.35);
  z-index: 1;
}
.flow-card__body { padding: 10px 12px; min-width: 0; flex: 1; }
.flow-card__top { display: flex; align-items: center; gap: 6px; margin-bottom: 3px; color: var(--card-hue); }
.flow-card__title {
  flex: 1 1 auto; min-width: 0;
  font-size: 12.5px; font-weight: 600; color: rgb(var(--color-text));
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.flow-card__timing {
  flex-shrink: 0; font-size: 9.5px; font-weight: 700; font-variant-numeric: tabular-nums;
  color: rgb(var(--color-muted)); background: rgb(var(--color-border) / 0.6);
  border-radius: 999px; padding: 1px 6px;
}
.flow-card__method { font-size: 10.5px; font-weight: 500; color: rgb(var(--color-muted)); margin-bottom: 2px; }
.flow-card__subtitle { font-size: 11px; color: rgb(var(--color-muted)); margin-bottom: 2px; }
.flow-card__detail {
  font-size: 10.5px; color: rgb(var(--color-muted)); font-style: italic;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-bottom: 2px;
}
.flow-card__meta { font-size: 10px; color: rgb(var(--color-muted)); opacity: 0.8; }
.flow-card__badge {
  display: inline-block; margin-top: 4px; font-size: 9.5px; font-weight: 600; letter-spacing: 0.02em;
  color: var(--card-hue); background: color-mix(in srgb, var(--card-hue) 16%, transparent);
  border-radius: 999px; padding: 1px 7px;
}

.flow-map-root .react-flow__edge-path { stroke: rgb(var(--color-border)); }
.flow-map-root .react-flow__edge:hover .react-flow__edge-path { stroke: rgb(var(--color-primary)); }

.flow-controls {
  background: rgb(var(--color-surface2));
  border: 1px solid rgb(var(--color-border));
  border-radius: 10px;
  overflow: hidden;
  box-shadow: 0 4px 14px rgba(0,0,0,0.25);
}
.flow-controls button {
  background: transparent; border: none; border-bottom: 1px solid rgb(var(--color-border));
  color: rgb(var(--color-text)); width: 28px; height: 28px;
}
.flow-controls button:hover { background: rgb(var(--color-border) / 0.5); }
.flow-controls button:last-child { border-bottom: none; }
.flow-controls button path { fill: currentColor; }

.flow-minimap {
  background: rgb(var(--color-surface2));
  border: 1px solid rgb(var(--color-border));
  border-radius: 10px;
  overflow: hidden;
  box-shadow: 0 4px 14px rgba(0,0,0,0.25);
}

.flow-legend {
  background: rgb(var(--color-surface2) / 0.92);
  border: 1px solid rgb(var(--color-border));
  border-radius: 10px;
  padding: 8px 10px;
  display: flex; flex-direction: column; gap: 5px;
  backdrop-filter: blur(6px);
}
.flow-legend__row { display: flex; align-items: center; gap: 6px; font-size: 10.5px; color: rgb(var(--color-muted)); }
.flow-legend__swatch { width: 8px; height: 8px; border-radius: 2px; flex-shrink: 0; }
.flow-legend__row--hint { padding-top: 4px; margin-top: 1px; border-top: 1px solid rgb(var(--color-border)); }

/* Phase 2 (features 2 and 3): the Flow tab grew a second and third
   toggle (Edit/Preview, and "Show across all data sources") alongside the
   pre-existing scope toggle - all three now sit together in one
   absolutely-positioned, wrapping flex row, rather than each one hardcoding
   its own top/left offset and risking overlap. */
.flow-toolbar {
  position: absolute;
  top: 12px;
  left: 12px;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  max-width: calc(100% - 24px);
}
.flow-scope-toggle {
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  background: rgb(var(--color-surface2) / 0.95);
  border: 1px solid rgb(var(--color-border));
  border-radius: 10px;
  box-shadow: 0 4px 14px rgba(0,0,0,0.2);
  backdrop-filter: blur(6px);
}
.flow-edit-hint {
  position: absolute;
  top: 56px;
  left: 12px;
  z-index: 20;
  max-width: min(420px, calc(100% - 24px));
  font-size: 11px;
  line-height: 1.4;
  color: rgb(var(--color-muted));
  background: rgb(var(--color-surface2) / 0.95);
  border: 1px solid rgb(var(--color-border));
  border-radius: 10px;
  padding: 6px 10px;
  backdrop-filter: blur(6px);
}
.flow-save-error {
  position: absolute;
  bottom: 12px;
  left: 12px;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
  color: #fca5a5;
  background: rgba(239,68,68,0.12);
  border: 1px solid rgba(239,68,68,0.35);
  border-radius: 10px;
  padding: 6px 10px;
  max-width: min(360px, calc(100% - 24px));
}
.flow-save-error button {
  background: transparent; border: none; color: inherit; cursor: pointer; font-size: 14px; line-height: 1;
}
.flow-scope-toggle__btn {
  font-size: 11.5px;
  font-weight: 600;
  color: rgb(var(--color-muted));
  background: transparent;
  border: none;
  border-radius: 7px;
  padding: 5px 10px;
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}
.flow-scope-toggle__btn:hover { color: rgb(var(--color-text)); }
.flow-scope-toggle__btn--active {
  color: rgb(var(--color-surface));
  background: rgb(var(--color-primary));
}
.flow-empty__all-link {
  display: inline-block;
  margin-top: 10px;
  font-size: 11.5px;
  font-weight: 600;
  color: rgb(var(--color-primary));
  background: transparent;
  border: none;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.flow-legend__step-sample {
  width: 14px; height: 14px; border-radius: 999px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  font-size: 9px; font-weight: 700; color: rgb(var(--color-surface));
  background: rgb(var(--color-muted));
}

.flow-map-root .react-flow__attribution {
  background: transparent; font-size: 9px; opacity: 0.5;
}
.flow-map-root .react-flow__attribution a { color: rgb(var(--color-muted)); }

@media (max-width: 640px) {
  .flow-card { width: 200px; min-height: 82px; }
  .flow-card__body { padding: 8px 10px; }
  .flow-legend { display: none; }
  .flow-edit-hint { display: none; }
}
`;
