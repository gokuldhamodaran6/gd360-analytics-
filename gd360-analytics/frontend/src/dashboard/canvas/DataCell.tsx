import { useState } from "react";
import { ComputedIn, Select, cn } from "../../ui";
import { resultOk } from "../blockData";
import { BlockRenderer } from "../BlockRenderer";
import { fileBlockSpec } from "../fileData";
import { describeSpecShort } from "../format";
import { describeSpec, type CrossFilter } from "../runState";
import { formatIndexSet, slimConfig, sourcesOf } from "./cells";
import type { CellBodyProps } from "./types";

// 2026-10-07 (analyst canvas round, OptionC.dc.html cells 3, 4, 8): a
// chart / KPI / table / donut / sparkline / gauge / leaderboard cell,
// rendered from a SQL cell's result when config.source_block_id is set
// (the run result is the source's, kind "derived") or from its own spec.
// Reuses BlockRenderer - the SAME component the dashboard grid draws with.
// Subtitle: "from cell 2 · parameters applied"; owner: "Bind to cell ▾"
// lists the page's SQL cells by name and PATCHes config.source_block_id.
// Clicking a bar after "Comment" hands the cell an anchor instead of a
// cross-filter.

export function DataCell({ cell, cells, run, source, mode, parameters, owner, pickingAnchor, onPickAnchor, compact, rerunWithDependents }: CellBodyProps) {
  const block = cell.block;
  const result = run.results[block.id];
  const [binding, setBinding] = useState(false);
  const [bindError, setBindError] = useState<string | null>(null);
  const sqlCells = cells.filter((c) => c.kind === "sql");
  const sources = sourcesOf(block.id, run.dependencies, cells, block);
  const bound = Boolean(block.config?.source_block_id);
  const spec = block.config?.spec;
  const crossColumn = resultOk(result) ? result.dimensions?.[0] || null : null;
  const selected: CrossFilter | null = crossColumn ? run.state.crossFilters[crossColumn] || null : null;
  const kind = block.type === "donut" ? "slice" : block.type === "table" ? "row" : block.type === "sparkline" || (block.config?.chart_type === "line" || block.config?.chart_type === "area") ? "point" : "bar";

  const subtitleParts: string[] = [];
  if (sources.length) subtitleParts.push(`from cell${sources.length > 1 ? "s" : ""} ${formatIndexSet(sources)}`);
  if (sources.length || (spec && run.parameters.length)) subtitleParts.push("parameters applied");
  else if (spec && mode === "warehouse") subtitleParts.push(describeSpecShort(spec, resultOk(result) ? result.period : null));
  else if (mode === "file") {
    // The same sentence the dashboard grid gives a file block (round 9).
    const fileSpec = fileBlockSpec(block, run.overrides[block.id], { sourceName: source.name });
    if (fileSpec) subtitleParts.push(describeSpecShort(fileSpec));
  }
  if (run.activeFilterCount > 0 && !sources.length) subtitleParts.push("filtered");

  const bind = async (sourceId: string) => {
    if (!owner) return;
    setBinding(true);
    setBindError(null);
    try {
      const next = slimConfig(block.config);
      if (sourceId) next.source_block_id = sourceId;
      else delete next.source_block_id;
      await owner.updateBlock(block.id, { config: next });
      rerunWithDependents(block.id);
    } catch (e: any) {
      const detail = e?.response?.data?.detail;
      setBindError(typeof detail === "string" ? detail : "Couldn't bind this cell.");
    } finally {
      setBinding(false);
    }
  };

  const computed = mode === "warehouse" && resultOk(result)
    ? { provider: result.computed_in || run.computedIn || undefined, rows: result.exact_total_rows ?? (result.spec ? undefined : result.row_count), durationMs: result.duration_ms ?? undefined, cached: Boolean(result.cached) }
    : mode === "file" ? { provider: "GD360", rows: typeof run.matchedRows === "number" ? run.matchedRows : undefined } : null;
  const height = compact ? 120 : block.type === "kpi" ? 140 : block.type === "table" ? 360 : 300;
  const noData = mode === "warehouse" && !result && run.ready && !bound && !spec;

  return (
    <div data-data-cell={block.type} className="flex flex-col">
      {(subtitleParts.length > 0 || owner) && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 pb-2 text-[12.5px] text-muted">
          {subtitleParts.length > 0 && <span data-cell-subtitle="" className="min-w-0 truncate" title={spec && mode === "warehouse" ? `${subtitleParts.join(" · ")}\n${describeSpec(spec)}` : subtitleParts.join(" · ")}>{subtitleParts.join(" · ")}</span>}
          {owner && !compact && (
            <label className="ml-auto flex items-center gap-1.5 text-caption">
              <span className="text-muted">Bind to cell</span>
              <Select
                size="sm"
                aria-label="Bind to cell"
                data-bind-select=""
                value={(block.config?.source_block_id as string) || ""}
                disabled={binding}
                onChange={(e) => bind(e.target.value)}
                className="h-7 w-[200px] font-mono text-caption"
              >
                <option value="">{spec ? "Own query" : "— none —"}</option>
                {sqlCells.filter((c) => c.id !== block.id).map((c) => (
                  <option key={c.id} value={c.id}>{c.index} · {c.name || c.label}</option>
                ))}
              </Select>
            </label>
          )}
        </div>
      )}
      {bindError && <div role="alert" className="mx-4 mb-2 rounded-ctl border border-danger-border bg-danger-fill px-3 py-2 text-caption text-danger">{bindError}</div>}
      {pickingAnchor && (
        <div data-anchor-hint="" className="mx-4 mb-2 rounded-ctl border border-tint-border bg-tint px-3 py-1.5 text-caption text-brand-ink">
          Click a {kind} to pin the comment to it, or write below to comment on the whole cell.
        </div>
      )}
      <div className={cn("relative min-h-0 px-4", block.type === "table" && "px-0")} style={{ minHeight: height }} data-block-id={block.id} data-block-type={block.type}>
        {noData ? (
          <div className="flex h-full min-h-[120px] items-center justify-center text-caption text-muted">
            {owner ? "Bind this cell to a SQL cell to give it data." : "This cell has no data source."}
          </div>
        ) : mode === "warehouse" && !result && !run.ready ? (
          <div className="ui-shimmer h-full min-h-[120px] rounded-ctl" aria-busy="true" />
        ) : (
          <BlockRenderer
            block={block}
            mode={mode}
            result={result}
            override={run.overrides[block.id]}
            selected={selected}
            onCrossFilter={
              pickingAnchor && onPickAnchor
                ? (cf) => onPickAnchor({ kind, key: cf.value, column: cf.column })
                : crossColumn && mode === "warehouse" ? (cf) => run.setCrossFilter(cf) : undefined
            }
            parameters={parameters}
            source={source}
            sourceName={source.name}
            bodyHeight={height}
            growToContent
          />
        )}
        {run.loading && run.ready && result && <div aria-hidden="true" className="ui-shimmer pointer-events-none absolute inset-0 rounded-ctl opacity-30" />}
      </div>
      {computed && !compact && (
        <div className="border-t border-subtle">
          <ComputedIn {...computed} />
        </div>
      )}
    </div>
  );
}
