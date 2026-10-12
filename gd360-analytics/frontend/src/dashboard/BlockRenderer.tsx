import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { BlockResult, CommentAnchor, DashboardBlock, DashboardParameter, FilteredBlock } from "../api/client";
import ChartCanvas, { type ChartExportApi } from "../components/ChartCanvas";
import { AvatarListBlock, DividerBlock, HeadingBlock, SparklineBlock, TextBlock } from "../components/DashboardBlocks";
import { KpiTile, TableFooter, TableFrame, type DataTableColumn } from "../ui";
import {
  ALL_ROWS_WORDING, avatarListItems, buildChartSpec, crossFilterColumn, donutItems, firstDimension, firstMeasure, gaugeConfig, kpiDisplay, PRIOR_PERIOD_WORDING, sparklineConfig,
} from "./blockData";
import { adaptFileBlock } from "./fileData";
import { GaugeChart, gaugeColors } from "./charts/BulletChart";
import { CartesianChart, matchBucket, type ChartNote, type ChartPin } from "./charts/CartesianChart";
import { DonutChart } from "./charts/DonutChart";
import { normalizeGrain, parseDateParts, periodLabel } from "./charts/geometry";
import { kpiForecastLine, planChart } from "./charts/model";
import { effectiveChartType } from "./charts/recommend";
import { SpecialChart } from "./charts/SpecialChart";
import { ParameterField } from "./FilterRailPanel";
import { blockFormat, columnFormat, formatValue, humanize, measureFormats, PLAIN_FORMAT, type ValueFormat } from "./format";
import { type CrossFilter, formatCell, type ParamValue } from "./runState";
import { ColorSwatch, useChartTheme } from "./theme/ChartThemeContext";
import { blockSingleColor, DEFAULT_CHART_THEME, type ChartTheme } from "./theme/chartTheme";
import type { RunSource } from "./useDashboardRun";

// 2026-10-07 (Option A dashboard view): routes one block to its renderer.
//   warehouse mode - a BlockResult (rows computed in the warehouse) drives
//     a native chart (charts/: bars, lines, areas, small multiples, donut),
//     a KpiTile, a paged TableFrame, or the sparkline / gauge / leaderboard
//     components. Scatter plots and histograms still go through Plotly
//     (rows + chart_type through lib/exploreEngine, drawn by ChartCanvas).
//   file mode (round 9) - the block's stored result (or the
//     preview-filtered override) goes through fileData.adaptFileBlock and
//     comes out as the SAME BlockResult, drawn by the same code below: a
//     CSV dashboard and a warehouse dashboard share one renderer. Only a
//     chart with no rows-by-category form keeps its Plotly figure.
// Every Plotly figure drawn here passes `kit` (dashboard/plotlyKit).
// Clicking a bar / slice / row hands the page a cross-filter on the
// block's first dimension.
//
// 2026-10-07 (dashboard polish round): every number here is written by
// format.ts (config.format / config.decimals, or a per-measure inference),
// every column name is humanised for display, and a chart whose measures
// do not belong on one axis becomes small multiples - or, past four
// panels, the table it should have been.
//
// 2026-10-07 (chart-types round): a chart block's form is its
// config.chart_type - bars, lines, areas, 100% stacks, combo panels and
// histograms through the cartesian renderer; a map, a heatmap, a pivot
// table, a scatter / bubble, a treemap, a funnel, a waterfall, a bullet
// through charts/SpecialChart. A form GD360 chose before the block had run
// (config.chart_auto) is confirmed against the first result's values by
// the same rule the server applies (charts/recommend.ts). `viewAsTable`
// swaps any chart for the table of the same result - every chart has one.
// The gauge is drawn natively in the theme's colours.
//
// 2026-10-07 (identity-colour round): every colour a block draws comes
// from useChartTheme() - handed to planChart for a chart, to the donut for
// its slices, to the KPI tile for its sparkline. A table shows a small dot
// beside each dimension value that has a colour of its own, so a row can
// be matched to its bar by more than its name.

export const TABLE_PAGE_SIZE = 50;

export type BlockRendererProps = {
  block: DashboardBlock;
  mode: "warehouse" | "file";
  result?: BlockResult;
  override?: FilteredBlock;
  selected?: CrossFilter | null;
  onCrossFilter?: (cf: CrossFilter) => void;
  onExportApi?: (api: ChartExportApi | null) => void;
  // "input" cells: the parameter they are bound to.
  parameters?: DashboardParameter[];
  paramValue?: ParamValue;
  onParamChange?: (paramId: string, v: ParamValue) => void;
  // The run's date bounds by column (an "input" cell bound to a date range).
  dateBounds?: Record<string, { min: string; max: string }>;
  source?: RunSource;
  // File mode: the file's name, for the adapter's spec-shaped description.
  sourceName?: string | null;
  // Height hint (px) for the chart body.
  bodyHeight?: number;
  // The body is as tall as its content (a stacked card, a canvas cell)
  // rather than a fixed grid cell: small multiples may then take the
  // height they need instead of squeezing into `bodyHeight`.
  growToContent?: boolean;
  // 2026-10-07 (dashboard edit mode): the page is being edited - a text or
  // heading block is typed into in place and saved when focus leaves it.
  editing?: { onSaveText: (text: string) => void | Promise<void> };
  // 2026-10-07 (chart-types round): draw the result as its table instead
  // of its chart (the card's "View as table" toggle).
  viewAsTable?: boolean;
  // 2026-10-12 (round 38, team comments): the threads pinned to this
  // block's marks (drawn on the chart; any the current filters hide are
  // counted under it), and - while a comment is being placed - where a
  // click on a mark goes instead of cross-filtering the page.
  pins?: ChartPin[];
  onAnchor?: (anchor: CommentAnchor) => void;
  onHiddenPins?: () => void;
  // Periods marked as one-offs (block.config.one_offs) - read from the
  // stored block by BlockRenderer itself.
  oneOffs?: ChartNote[];
};

// The block types "View as table" applies to.
export function hasTableView(type: string): boolean {
  return type === "chart" || type === "donut";
}

// A text / heading block while the dashboard is being edited: the same
// frame and type as the read-only block, with the words editable in place.
function EditableText({ block, kind, onSave }: { block: DashboardBlock; kind: "text" | "heading"; onSave: (text: string) => void | Promise<void> }) {
  const stored: string = typeof block.config?.text === "string" ? block.config.text : "";
  const [draft, setDraft] = useState(stored);
  const dirty = useRef(false);
  useEffect(() => {
    if (!dirty.current) setDraft(stored);
  }, [stored]);
  const commit = () => {
    if (!dirty.current) return;
    dirty.current = false;
    if (draft !== stored) onSave(draft);
  };
  if (kind === "heading") {
    return (
      <div className="flex h-full items-center px-1">
        <input
          data-no-drag=""
          data-inline-edit="heading"
          aria-label="Heading text"
          value={draft}
          maxLength={200}
          placeholder="Untitled heading"
          onChange={(e) => { dirty.current = true; setDraft(e.target.value); }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
            else if (e.key === "Escape") { e.stopPropagation(); dirty.current = false; setDraft(stored); (e.target as HTMLInputElement).blur(); }
          }}
          className="ui-focus w-full min-w-0 truncate rounded-[6px] border-0 bg-transparent px-1 text-xl font-bold text-text placeholder:font-bold placeholder:italic placeholder:text-muted hover:bg-subtle focus:bg-surface"
        />
      </div>
    );
  }
  return (
    <div className="dash-card h-full overflow-hidden p-5">
      <textarea
        data-no-drag=""
        data-inline-edit="text"
        aria-label="Note text"
        value={draft}
        placeholder="Write a note…"
        onChange={(e) => { dirty.current = true; setDraft(e.target.value); }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.stopPropagation(); dirty.current = false; setDraft(stored); (e.target as HTMLTextAreaElement).blur(); }
        }}
        className="dash-note-quote ui-focus block h-full w-full resize-none rounded-[4px] border-0 bg-transparent pl-3.5 text-sm leading-relaxed text-text placeholder:italic placeholder:text-muted"
      />
    </div>
  );
}

// Columns of a result as a table reads them: humanised headers (the raw
// name stays as the header's tooltip), numbers right-aligned in tabular
// figures with one number of decimals per column, each measure in its own
// format ("56.6%" beside "48,590" beside "92.04"). A numeric DIMENSION (a
// year, a bucket) is a label, not a quantity: no thousands separator.
export function resultTableColumns(result: BlockResult, block: Pick<DashboardBlock, "config" | "title">, theme: ChartTheme = DEFAULT_CHART_THEME): DataTableColumn<Record<string, any>>[] {
  const formats = measureFormats(block, result);
  const dotted = theme.colorMode === "by_value";
  const rows = result.rows || [];
  const dims = new Set(result.dimensions || []);
  return (result.columns || []).map((c) => {
    const values = rows.map((r) => r[c.name]);
    const numeric = values.some((v) => typeof v === "number");
    const isTime = Boolean(result.time_column) && c.name === result.time_column;
    const grain = normalizeGrain(result.period || result.spec?.time?.grain);
    const fmt: ValueFormat | null = numeric && !dims.has(c.name) ? columnFormat(formats[c.name] || PLAIN_FORMAT, values) : null;
    const header = isTime && c.name === "period" ? humanize(grain) : humanize(c.name);
    return {
      key: c.name,
      header: <span title={header === c.name ? undefined : c.name}>{header}</span>,
      numeric,
      render: (row) => {
        const v = row[c.name];
        if (v === null || v === undefined) return "";
        if (fmt && typeof v === "number") return formatValue(v, fmt, "full");
        if (isTime) {
          const parts = parseDateParts(v);
          if (parts) return periodLabel(parts, grain);
        }
        if (typeof v === "number" && dims.has(c.name)) return Number.isInteger(v) ? String(v) : formatCell(v);
        if (dotted && dims.has(c.name) && theme.hasColor(c.name, v)) {
          const text = formatCell(v);
          return (
            <span className="inline-flex max-w-full items-center gap-1.5" data-value-dot={c.name}>
              <ColorSwatch column={c.name} value={v} label={text} color={theme.colorFor(c.name, v)} shape="dot" size={8} inert />
              <span className="min-w-0 truncate">{text}</span>
            </span>
          );
        }
        return formatCell(v);
      },
    };
  });
}

function ResultTable({ result, selected, column, onCrossFilter, block, capped = false }: { result: BlockResult; selected?: CrossFilter | null; column: string | null; onCrossFilter?: (cf: CrossFilter) => void; block: DashboardBlock; capped?: boolean }) {
  const [shown, setShown] = useState(TABLE_PAGE_SIZE);
  const theme = useChartTheme();
  useEffect(() => setShown(TABLE_PAGE_SIZE), [result]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const columns = useMemo(() => resultTableColumns(result, block, theme), [result, block, theme.key]);
  const rows = result.rows || [];
  const visible = rows.slice(0, shown);
  // 2026-10-07 (real end-to-end run): the footer counts the rows this table
  // HAS. It used to switch to result.exact_total_rows - the row count of
  // the underlying warehouse table - whenever the result reached its
  // limit, so a "top 10 countries" table read "1–10 of ~119,386": there
  // are 175 countries, and 119,386 is bookings, not groups.
  const total = rows.length;
  return (
    <TableFrame
      bare
      dense
      columns={columns}
      rows={visible}
      rowKey={(_r, i) => i}
      ariaLabel={block.title || "Rows"}
      maxHeight="100%"
      onRowClick={column && onCrossFilter ? (row) => onCrossFilter({ column, value: row[column] ?? null, blockId: block.id }) : undefined}
      selectedKey={column && selected ? visible.findIndex((r) => String(r[column]) === String(selected.value)) : null}
      className="h-full"
      footer={
        <>
          <TableFooter
            start={rows.length ? 1 : 0}
            end={Math.min(shown, rows.length)}
            total={total}
            pageSize={TABLE_PAGE_SIZE}
            onLoadMore={shown < rows.length ? () => setShown((n) => n + TABLE_PAGE_SIZE) : undefined}
            approximate={total !== rows.length}
          />
          {/* A stored (file) result that ended at its row cap says so. */}
          {capped && <div data-table-capped="" className="px-4 pb-2 text-caption text-muted">Only the first {rows.length.toLocaleString()} rows are kept for this table.</div>}
        </>
      }
    />
  );
}

const EMPTY_BODY = "flex h-full min-h-[96px] items-center justify-center text-caption text-muted";

// A file block: adapted once per (block, filtered copy), then the shared
// body. Anything the adapter cannot express as a result is a Plotly
// figure (restyled through the kit) or the honest empty line.
function FileBlockBody(props: BlockRendererProps) {
  const { block, override, sourceName, onExportApi, bodyHeight } = props;
  const adapted = useMemo(() => adaptFileBlock(block, override, { sourceName }), [block, override, sourceName]);
  if (adapted.kind === "plotly") {
    return (
      <div className="h-full" data-plotly-fallback="" title={`Drawn as saved: ${adapted.reason}.`}>
        <ChartCanvas chartSpec={adapted.figure} title={block.title || undefined} bare kit minHeight={bodyHeight ? Math.max(120, bodyHeight - 8) : 200} onExportApi={onExportApi} />
      </div>
    );
  }
  if (adapted.kind === "empty") {
    return <div className={EMPTY_BODY}>{override ? "No rows match these filters." : "Nothing to show yet."}</div>;
  }
  return <ResultBody {...props} block={adapted.block} result={adapted.result} capped={adapted.truncated} filtered={Boolean(override)} />;
}

export function BlockRenderer(props: BlockRendererProps) {
  const { block, mode, result, override, parameters, paramValue, onParamChange, source, editing } = props;
  const type = override?.type ?? block.type;
  const cfg = override?.config ?? block.config ?? {};

  // Layout-only blocks render the same everywhere.
  if (type === "text") return editing ? <EditableText block={block} kind="text" onSave={editing.onSaveText} /> : <TextBlock title={null} config={cfg} />;
  if (type === "heading") return editing ? <EditableText block={block} kind="heading" onSave={editing.onSaveText} /> : <HeadingBlock title={block.title} config={cfg} />;
  if (type === "divider") return <DividerBlock />;
  if (type === "filter") return null;
  if (type === "input") {
    const param = parameters?.find((p) => p.id === cfg.parameter_id || p.name === cfg.parameter_name);
    if (!param) return <div className="text-caption text-muted">This input is not bound to a filter yet.</div>;
    if (!source || !onParamChange) return <div className="text-caption text-muted">{param.label}</div>;
    return <ParameterField param={param} value={paramValue} onChange={(v) => onParamChange(param.id, v)} source={source} bounds={props.dateBounds?.[param.column]} />;
  }

  const oneOffs: ChartNote[] | undefined = Array.isArray(block.config?.one_offs)
    ? block.config!.one_offs.filter((o: any) => o && o.key).map((o: any) => ({ key: String(o.key), label: String(o.label || o.key) }))
    : undefined;
  const withComments = { ...props, oneOffs: props.oneOffs ?? oneOffs };

  if (mode === "file") return <FileBlockBody {...withComments} />;

  if (!result) return null;
  return <ResultBody {...withComments} result={result} />;
}

// round 38: a comment on one day reads the way people say it - "3 Oct"
// ("3 Oct 2025" in another year). A week or month keeps the chart's label.
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function dayLabel(key: unknown, label?: string): string | null {
  if (typeof key !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(key)) return null;
  if (label && !/^[A-Za-z]{3,9}\.? \d{1,2},? \d{4}$|^\d{4}-\d{2}-\d{2}/.test(label.trim())) return null;
  const [y, m, d] = key.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return null;
  return `${d} ${MON[m - 1]}${y !== new Date().getFullYear() ? ` ${y}` : ""}`;
}

// round 38: the threads pinned to values this result does not hold (a
// filter or the date range left them out) - said under the chart, never
// silently dropped.
function hiddenPins(pins: ChartPin[] | undefined, result: BlockResult, columns: (string | null | undefined)[]): ChartPin[] {
  if (!pins?.length) return [];
  const cols = columns.filter(Boolean) as string[];
  if (!cols.length) return [];
  const rows = result.rows || [];
  const values = cols.map((c) => Array.from(new Set(rows.map((r) => r[c]))));
  return pins.filter((p) => !values.some((vs) => matchBucket(vs, p.key) >= 0));
}

export function PinNote({ hidden, onShow }: { hidden: ChartPin[]; onShow?: () => void }) {
  if (!hidden.length) return null;
  const names = hidden.slice(0, 2).map((p) => p.label).join(", ") + (hidden.length > 2 ? ` and ${hidden.length - 2} more` : "");
  return (
    <div
      data-hidden-pins={hidden.length}
      title={`${hidden.length === 1 ? "1 comment is" : `${hidden.length} comments are`} on ${names}, hidden by the current filters.`}
      className="mt-1 inline-flex h-[22px] max-w-full shrink-0 items-center gap-1.5 self-start rounded-full border border-border bg-surface py-0.5 pl-2 pr-1 text-[11.5px] text-muted"
    >
      <span aria-hidden="true" className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
      <span className="truncate">{hidden.length === 1 ? "1 comment" : `${hidden.length} comments`} hidden by your filters</span>
      <span className="sr-only">: on {names}, hidden by the current filters.</span>
      {onShow && <button type="button" className="ui-focus shrink-0 rounded-full px-1.5 font-medium text-brand-ink hover:bg-subtle" onClick={onShow}>Show</button>}
    </div>
  );
}

// round 38: pins on a chart that draws no category axis of its own (a
// donut, a map, a table...): a row of the same bubbles under it.
function PinStrip({ pins }: { pins: ChartPin[] }) {
  if (!pins.length) return null;
  return (
    <div data-pin-strip="" className="flex flex-wrap items-center gap-1.5 px-1 pt-1.5">
      {pins.map((p) => (
        <button key={p.key} type="button" data-comment-pin={p.key} data-pin-active={p.active ? "" : undefined} title={p.title} aria-label={p.title} onClick={p.onClick}
          className={`ui-focus inline-flex h-6 items-center gap-1.5 rounded-full border pl-0.5 pr-2 text-caption ${p.active ? "border-primary bg-tint text-text" : "border-border bg-surface text-secondary hover:border-border-strong"} ${p.open ? "" : "opacity-60"}`}>
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-semibold text-[#07090A]" style={{ background: p.color || "rgb(var(--color-primary))" }}>{p.initials}</span>
          <span className="max-w-[140px] truncate">{p.label}</span>
          {p.count > 1 && <span className="tabular-nums text-muted">{p.count}</span>}
        </button>
      ))}
    </div>
  );
}

// One block's body from its result - the warehouse run's, or a file
// block's adapted one. `capped`: a stored table that ended at its row cap;
// `filtered`: a file block showing its filtered copy (its KPI delta is
// then "vs all rows").
function ResultBody(props: BlockRendererProps & { result: BlockResult; capped?: boolean; filtered?: boolean }) {
  const { mode, result, override, selected, onCrossFilter, onExportApi, bodyHeight, growToContent = false, capped = false, viewAsTable = false } = props;
  const theme = useChartTheme();
  // A form GD360 chose from column names is confirmed against the values
  // (see the note at the top of this file); every other block is as stored.
  const stored = props.block;
  const storedType = override?.type ?? stored.type;
  const eff = useMemo(() => effectiveChartType(stored.config, result, storedType), [stored.config, result, storedType]);
  const block = useMemo(
    () => (eff.blockType === storedType && eff.chartType === (storedType === "donut" ? "donut" : stored.config?.chart_type ?? null) ? stored : { ...stored, type: eff.blockType as DashboardBlock["type"], config: { ...stored.config, chart_type: eff.chartType } }),
    [stored, eff, storedType]
  );
  const type = eff.blockType !== storedType ? (eff.blockType as DashboardBlock["type"]) : storedType;
  // A donut with the block's own "Single" colour: steps of that one hue.
  const mono = block.config?.color_mode === "single" ? blockSingleColor(theme, block.config) : null;
  // The token theme's sparkline keeps its class colour (the brand primary).
  const sparkColor = theme.tokens ? undefined : theme.primary;
  if (result.status !== "ok") {
    return (
      <div role="alert" className="flex h-full min-h-[96px] items-center justify-center rounded-ctl border border-danger-border bg-danger-fill px-4 py-3 text-center text-ui text-danger">
        {result.error || "This block couldn't be computed."}
      </div>
    );
  }
  const column = crossFilterColumn(result, block);
  const pick = (value: unknown) => {
    if (column && onCrossFilter) onCrossFilter({ column, value: (value === undefined ? null : value) as CrossFilter["value"], blockId: block.id });
  };
  // round 38: placing a comment - a click on a mark pins it there instead.
  const { pins, onAnchor, onHiddenPins, oneOffs } = props;
  const anchorColumn = result.time_column || column || firstDimension(result) || null;
  const anchorTo = (kind: string) => (value: unknown, label?: string) => {
    const key = value === undefined ? null : (value as CommentAnchor["key"]);
    onAnchor?.({ kind, key, label: dayLabel(key, label) ?? label ?? (key === null ? "(Blanks)" : String(key)), column: anchorColumn });
  };
  const hidden = hiddenPins(pins, result, [result.time_column, column, firstDimension(result)]);
  const shownPins = (pins || []).filter((p) => !hidden.includes(p));
  const withPins = (body: ReactNode, strip = true) =>
    pins?.length || onAnchor ? (
      <div className="relative flex h-full min-h-0 flex-col" data-pinnable={onAnchor ? "" : undefined}>
        <div className="min-h-0 flex-1">{body}</div>
        {strip && <PinStrip pins={shownPins} />}
        <PinNote hidden={hidden} onShow={onHiddenPins} />
      </div>
    ) : body;

  if (type === "kpi") {
    const kpi = kpiDisplay(result, block, mode === "file" ? ALL_ROWS_WORDING : PRIOR_PERIOD_WORDING);
    return (
      <KpiTile
        label={block.title || humanize(block.config?.label || firstMeasure(result)) || "Value"}
        value={kpi.value}
        delta={kpi.delta ?? undefined}
        reserveDeltaRow
        sparkline={kpi.sparkline}
        sparklineColor={sparkColor}
        caption={kpiForecastLine(result, block) ? <span data-kpi-forecast="">{kpiForecastLine(result, block)}</span> : undefined}
        className="h-full border-0 shadow-none"
      />
    );
  }
  if (type === "table" || type === "sql" || (viewAsTable && hasTableView(type))) {
    return withPins(
      <div className="h-full min-h-0" data-view-as-table={viewAsTable && hasTableView(type) ? "" : undefined}>
        <ResultTable result={result} selected={selected} column={column} onCrossFilter={onAnchor ? (column ? (cf) => anchorTo("row")(cf.value) : undefined) : onCrossFilter} block={block} capped={capped} />
      </div>
    );
  }
  if (type === "chart") {
    const plan = planChart(result, block, theme);
    // round 38: the hidden-comment note and the pin strip take their line
    // from the plot, so the card never overflows
    const noteRoom = hidden.length ? 26 : 0, stripRoom = shownPins.length ? 32 : 0;
    const base = bodyHeight ? Math.max(120, bodyHeight - 8 - noteRoom) : 160;
    const baseStrip = bodyHeight ? Math.max(120, bodyHeight - 8 - noteRoom - stripRoom) : 160;
    if (plan.kind === "special") {
      // The map and the scatter want a little more height where the card
      // sizes to its content (a stacked, narrow page).
      const tall = plan.type === "map" || plan.type === "treemap" || plan.type === "heatmap";
      return withPins(
        <SpecialChart
          type={plan.type}
          result={result}
          block={block}
          crossColumn={column}
          selectedValue={selected?.value}
          hasSelection={Boolean(selected)}
          onPick={onAnchor ? anchorTo(plan.type === "map" ? "area" : "bar") : column && onCrossFilter ? (value) => pick(value) : undefined}
          onExportApi={plan.type === "pivot" ? undefined : onExportApi}
          minHeight={growToContent && tall ? Math.max(baseStrip, 300) : baseStrip}
        />
      );
    }
    if (plan.kind === "empty") return <div className="flex h-full min-h-[96px] items-center justify-center text-caption text-muted">No rows to chart.</div>;
    if (plan.kind === "table") {
      // More measures than a chart can hold honestly: the table it is.
      return (
        <div className="flex h-full min-h-0 flex-col" data-chart-as-table="">
          <div className="px-4 pb-1.5 text-caption text-muted">{plan.reason}</div>
          <div className="min-h-0 flex-1">
            <ResultTable result={result} selected={selected} column={column} onCrossFilter={onCrossFilter} block={block} />
          </div>
        </div>
      );
    }
    if (plan.kind === "donut") {
      return withPins(
        <DonutChart
          title={block.title}
          items={donutItems(result)}
          format={blockFormat(block, result)}
          scope={block.id}
          column={firstDimension(result)}
          mono={mono}
          pie={plan.pie}
          minHeight={baseStrip}
          onItemClick={onAnchor ? (label) => anchorTo("slice")(label === "(Blanks)" ? null : label, label) : column && onCrossFilter ? (label) => pick(label === "(Blanks)" ? null : label) : undefined}
          selectedLabel={selected ? String(selected.value ?? "(Blanks)") : null}
        />
      );
    }
    if (plan.kind === "plotly") {
      const spec = buildChartSpec(result, block, selected);
      if (!spec) return <div className="flex h-full min-h-[96px] items-center justify-center text-caption text-muted">No rows to chart.</div>;
      return (
        <ChartCanvas
          chartSpec={spec}
          title={block.title || undefined}
          bare
          kit
          minHeight={base}
          onPointClick={column && onCrossFilter ? (p) => pick(p.x) : undefined}
          onExportApi={onExportApi}
        />
      );
    }
    const panels = plan.model.panels.length;
    return withPins(
      <CartesianChart
        model={plan.model}
        title={block.title || undefined}
        // Small multiples need about 110 px a panel; a card that sizes to
        // its content gives them that, a fixed grid cell shares what it has.
        minHeight={growToContent && panels > 1 ? Math.max(base, panels * 110 + 48) : base}
        hasSelection={Boolean(selected) && result.dimensions?.[0] !== undefined && !plan.model.time}
        selectedValue={selected?.value}
        onPick={onAnchor ? anchorTo(plan.model.time ? "point" : "bar") : column && onCrossFilter && !plan.model.time ? (value) => pick(value) : undefined}
        onExportApi={onExportApi}
        pins={shownPins}
        notes={oneOffs}
        pinning={Boolean(onAnchor)}
      />,
      false
    );
  }
  if (type === "donut") {
    return withPins(
      <DonutChart
        title={block.title}
        items={donutItems(result)}
        format={blockFormat(block, result)}
        scope={block.id}
        column={firstDimension(result)}
        mono={mono}
        onItemClick={onAnchor ? (label) => anchorTo("slice")(label === "(Blanks)" ? null : label, label) : column && onCrossFilter ? (label) => pick(label === "(Blanks)" ? null : label) : undefined}
        selectedLabel={selected ? String(selected.value ?? "(Blanks)") : null}
      />
    );
  }
  if (type === "sparkline") {
    if (mode === "file") {
      // The stored series IS the sparkline (its last point is the value);
      // only the number's format comes from the shared formatter.
      const cfg = override?.config ?? block.config ?? {};
      const format = blockFormat(block, result);
      const pct = format.format === "percent";
      return (
        <SparklineBlock
          title={block.title}
          config={{
            ...cfg,
            label: block.config?.label || humanize(firstMeasure(result)),
            display: typeof cfg.value === "number" ? formatValue(cfg.value, format, "auto") : undefined,
            delta_label: pct && typeof cfg.delta_pct === "number" ? undefined : cfg.delta_label,
          }}
          bare
        />
      );
    }
    return <SparklineBlock title={block.title} config={sparklineConfig(result, block)} bare />;
  }
  if (type === "gauge") {
    const g = gaugeConfig(result, block);
    const hasTarget = typeof block.config?.target === "number" || typeof block.config?.target_value === "number";
    return (
      <GaugeChart
        title={block.title}
        value={g.value}
        min={g.min}
        max={g.max}
        target={hasTarget ? g.target : null}
        display={g.display}
        targetDisplay={g.target_display}
        label={humanize(g.label) || "Value"}
        {...gaugeColors(theme, block.config)}
      />
    );
  }
  if (type === "avatar_list") {
    const items = avatarListItems(result);
    const format = columnFormat(blockFormat(block, result), items.map((it) => it.value));
    return withPins(
      <AvatarListBlock
        title={block.title}
        config={{ items: items.map((it) => ({ ...it, display: formatValue(it.value, format, "full") })) }}
        bare
        onItemClick={onAnchor ? (name) => anchorTo("row")(name === "(Blanks)" ? null : name, name) : column && onCrossFilter ? (name) => pick(name === "(Blanks)" ? null : name) : undefined}
        selectedName={selected ? String(selected.value ?? "(Blanks)") : null}
      />
    );
  }
  return null;
}
