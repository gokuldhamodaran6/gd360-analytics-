// The Flow tab: a premium, pannable/zoomable map of exactly how this data
// source's story unfolded - which raw data (this datasource's own, or
// another separately-connected one pulled in via "+ Add more data") fed
// which prepared table, and which table(s) fed which chart/question -
// across every conversation ever run against this datasource, not just
// the one currently open. Read-only by design (see the engagement's own
// answer on this): every card is a live shortcut back to wherever that
// table or chart actually lives, so renaming/editing always happens in
// exactly one place and can never drift out of sync with this map.
import { useMemo } from "react";
import {
  Background, BackgroundVariant, Controls, Handle, MiniMap, Node, NodeProps,
  Panel, Position, ReactFlow, ReactFlowProvider,
} from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import { DataFlow } from "../api/client";
import { buildFlowGraph, FlowCardData, FlowCardKind } from "../lib/flowGraph";

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
  return (
    <div
      className={`flow-card flow-card--${data.kind} ${clickable ? "flow-card--clickable" : ""} ${selected ? "flow-card--selected" : ""}`}
      style={{ ["--card-hue" as string]: `var(--flow-${data.kind})` }}
      title={data.detail || data.title}
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
        </div>
        <div className="flow-card__subtitle">{data.subtitle}</div>
        {data.detail && <div className="flow-card__detail">{data.detail}</div>}
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
  flow, loading, error, currentDatasourceId, onJump,
}: {
  flow: DataFlow | null;
  loading: boolean;
  error: string;
  currentDatasourceId: string;
  onJump: (target: FlowJumpTarget) => void;
}) {
  const graph = useMemo(
    () => (flow ? buildFlowGraph(flow, currentDatasourceId) : null),
    [flow, currentDatasourceId]
  );

  const handleNodeClick = (_: unknown, node: Node<FlowCardData>) => {
    if (node.data.onClick) onJump(node.data.onClick);
  };

  return (
    <div className="flow-map-root h-full w-full relative rounded-2xl border border-border overflow-hidden">
      <style>{FLOW_CSS}</style>

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
            <div className="text-sm font-semibold text-text mb-1">Nothing to map yet</div>
            <div className="text-xs text-muted leading-relaxed">
              Ask a question or clean this data in the chat, and every table and chart it creates will show up here, connected to exactly what it came from.
            </div>
          </div>
        </div>
      )}

      {!loading && !error && graph && !graph.isEmpty && (
        <ReactFlowProvider>
          <ReactFlow
            nodes={graph.nodes}
            edges={graph.edges}
            nodeTypes={nodeTypes}
            onNodeClick={handleNodeClick}
            fitView
            fitViewOptions={{ padding: 0.25, maxZoom: 1.1 }}
            minZoom={0.15}
            maxZoom={2}
            proOptions={{ hideAttribution: false }}
            defaultEdgeOptions={{ type: "smoothstep" }}
            panOnScroll
            zoomOnPinch
            nodesDraggable={false}
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
  font-size: 12.5px; font-weight: 600; color: rgb(var(--color-text));
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
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
}
`;
