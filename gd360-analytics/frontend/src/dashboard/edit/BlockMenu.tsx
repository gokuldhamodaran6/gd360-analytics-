import { useEffect, useRef, useState, type ReactNode } from "react";
import { dashboardBuilderApi, type DashboardBlock, type RestyleChartType } from "../../api/client";
import {
  ArrowDownIcon, ArrowLeftIcon, ArrowRightIcon, ArrowUpIcon, BarChartIcon, ChartIcon, CodeIcon, CopyIcon, EditIcon, IconButton, MinusIcon, MoreIcon, PlusIcon, Popover, SparkleIcon, Switch, TrashIcon, cn,
} from "../../ui";
import { isDataBlock, isEmptyBlock } from "../blockData";
import { adaptFileBlock, fileChartType, plotlyFallbackReason } from "../fileData";
import { blockFormat } from "../format";
import { MenuCaption, MenuDivider, MenuRow, SwapChips } from "../menu";
import { blockTimeGrain } from "./ChartSheets";
import { useChartTheme } from "../theme/ChartThemeContext";
import { PALETTES, parseHex } from "../theme/palettes";
import { canMove, canResize, minSizeOf, type MoveDir, type SizeDir } from "./layout";
import type { DashboardEditor } from "./useDashboardEditor";

// 2026-10-07 (dashboard edit mode): the "..." menu of a block (and of a KPI
// tile) while the dashboard is being edited. Everything a pointer can do
// on the card has a keyboard path here: "Move up / down / left / right"
// for a drag, "Make wider / narrower / taller / shorter" for the corner
// handle, "Move left / right" for a KPI tile.

// File dashboards: the AI answer comes back as a chart / KPI / table, so
// these native widgets are only ever built step by step (asking would
// silently turn them into another type).
const FILE_MANUAL_ONLY = new Set(["gauge", "donut", "sparkline", "avatar_list"]);

export function canAskAi(editor: DashboardEditor, block: DashboardBlock): boolean {
  if (!isDataBlock(block)) return false;
  if (!editor.dash.datasource_id) return false;
  return editor.warehouse || !FILE_MANUAL_ONLY.has(block.type);
}

export function canEditQuery(editor: DashboardEditor, block: DashboardBlock): boolean {
  if (block.type === "sql") return true;
  return isDataBlock(block) && Boolean(editor.dash.datasource_id);
}

// 2026-10-07 (round 9): a FILE chart's "Chart type" - what is left of the
// old "Style..." panel. Its palette and per-bar colour pickers styled a
// Plotly figure the dashboard no longer draws (one measure is one colour
// now, on every source), so they are gone; the chart type is honoured by
// the native renderer and lives here, in the menu, next to "Swap to" on a
// warehouse block. PATCH /blocks/{id}/style rebuilds from the block's own
// rows, so only the forms that work from any category-by-measure result
// are offered, and only for a chart the native renderer draws.
const FILE_CHART_TYPES: { value: RestyleChartType; label: string }[] = [
  { value: "bar", label: "Bars" },
  { value: "horizontal_bar", label: "Horizontal bars" },
  { value: "line", label: "Line" },
  { value: "area", label: "Area" },
  { value: "pie", label: "Pie" },
];

export function canChangeFileChartType(editor: DashboardEditor, block: DashboardBlock): boolean {
  if (editor.warehouse || block.type !== "chart") return false;
  const cfg = block.config || {};
  if (!Array.isArray(cfg.result_columns) || !Array.isArray(cfg.result_rows) || !cfg.result_rows.length) return false;
  if (plotlyFallbackReason(block, cfg)) return false;
  // The five forms need ONE measure over ONE category / period.
  const adapted = adaptFileBlock(block);
  if (adapted.kind !== "result") return false;
  const r = adapted.result;
  return (r.measures || []).length === 1 && (r.dimensions || []).length + (r.time_column ? 1 : 0) === 1;
}

const KPI_FORMATS: { value: string; label: string }[] = [
  { value: "number", label: "Number" },
  { value: "percent", label: "Percent" },
  { value: "currency", label: "Currency" },
  { value: "compact", label: "Compact" },
];

function Chip({ pressed, onClick, children, disabled, label }: { pressed: boolean; onClick: () => void; children: ReactNode; disabled?: boolean; label?: string }) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={pressed}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "ui-focus inline-flex h-7 min-w-[28px] items-center justify-center rounded-full border px-2.5 text-caption font-medium disabled:opacity-60",
        pressed ? "border-tint-border bg-tint text-brand-ink" : "border-border bg-surface text-secondary hover:border-border-strong hover:bg-subtle hover:text-text"
      )}
    >
      {children}
    </button>
  );
}

function StepRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className="flex items-center justify-between gap-3 px-3 py-1">
      <span className="text-ui text-text">{label}</span>
      <span className="flex items-center gap-0.5">{children}</span>
    </div>
  );
}

function Step({ label, icon, onClick, disabled }: { label: string; icon: ReactNode; onClick: () => void; disabled?: boolean }) {
  return <IconButton size="sm" role="menuitem" aria-label={label} title={label} icon={icon} disabled={disabled} onClick={onClick} variant="secondary" />;
}

export type BlockMenuProps = {
  editor: DashboardEditor;
  block: DashboardBlock;
  // "grid": a block in the 12-column grid. "kpi": a tile in the KPI strip.
  variant: "grid" | "kpi";
  onRename?: () => void;
  // Stacked (narrow) layout: no positions to move or resize.
  stacked?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
};

// 2026-10-07 (identity-colour round): "Colour" - this block's own answer to
// the dashboard's colour mode. Follow dashboard (no override stored), By
// value, or Single with a colour of its own; saved on the block's config
// (color_mode / single_color) and read by the chart planner.
function ColourControl({ editor, block, busy, setBusy }: { editor: DashboardEditor; block: DashboardBlock; busy: boolean; setBusy: (b: boolean) => void }) {
  const theme = useChartTheme();
  const cfg = block.config || {};
  const own: "follow" | "by_value" | "single" = cfg.color_mode === "by_value" || cfg.color_mode === "single" ? cfg.color_mode : "follow";
  const stored = parseHex(cfg.single_color);
  const [draft, setDraft] = useState<string | null>(null);
  const save = async (patch: Record<string, any>) => {
    setBusy(true);
    try { await editor.updateConfig(block, patch); } finally { setBusy(false); }
  };
  // A colour picker reports every step of a drag: the last one is saved,
  // once it has rested.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const pick = (hex: string) => {
    setDraft(hex);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; void save({ color_mode: "single", single_color: hex }); }, 450);
  };
  const options: { value: "follow" | "by_value" | "single"; label: string }[] = [
    { value: "follow", label: "Follow dashboard" },
    { value: "by_value", label: "By value" },
    { value: "single", label: "Single" },
  ];
  return (
    <>
      <MenuDivider />
      <MenuCaption>Colour</MenuCaption>
      <div className="flex flex-wrap gap-1 px-3 pb-1.5" role="group" aria-label="Colour" data-block-colour="">
        {options.map((o) => (
          <Chip
            key={o.value}
            pressed={own === o.value}
            disabled={busy}
            onClick={() => {
              if (own === o.value) return;
              void save(o.value === "follow" ? { color_mode: undefined, single_color: undefined } : o.value === "single" ? { color_mode: "single", single_color: stored || undefined } : { color_mode: "by_value", single_color: undefined });
            }}
          >
            {o.label}
          </Chip>
        ))}
      </div>
      {own === "single" && (
        <div className="flex items-center gap-2 px-3 pb-2" data-block-single-colour="">
          <input
            type="color"
            aria-label="This block's colour"
            disabled={busy}
            value={draft || stored || parseHex(theme.primary) || PALETTES[0].light[0]}
            onChange={(e) => pick(e.target.value.toLowerCase())}
            className="ui-focus h-7 w-9 shrink-0 cursor-pointer rounded-[6px] border border-border bg-transparent p-0"
          />
          <input
            aria-label="This block's colour, hex code"
            disabled={busy}
            maxLength={7}
            placeholder="Palette colour"
            defaultValue={draft || stored || ""}
            key={draft || stored || "none"}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }}
            onBlur={(e) => { const text = e.target.value.trim(); const hex = parseHex(text); if (hex && hex !== stored) void save({ color_mode: "single", single_color: hex }); else if (!text && stored) void save({ color_mode: "single", single_color: undefined }); }}
            className="ui-focus h-7 w-[92px] rounded-[6px] border border-border bg-surface px-1.5 font-mono text-[12.5px] text-text placeholder:font-sans placeholder:text-faint"
          />
        </div>
      )}
    </>
  );
}

export function BlockMenu({ editor, block, variant, onRename, stacked = false, onOpenChange, className }: BlockMenuProps) {
  const [busy, setBusy] = useState(false);
  const empty = isEmptyBlock(block) || editor.run.emptyBlockIds.includes(block.id);
  const data = isDataBlock(block);
  const cfg = block.config || {};
  const built = !empty && data;
  const swappable = built && Boolean(cfg.spec || cfg.source_block_id);
  const fileChart = built && canChangeFileChartType(editor, block);
  const fileChartNow = fileChart ? fileChartType(block, cfg) : null;
  const layout = editor.gridLayout;
  const item = layout.find((it) => it.i === block.id);
  const min = minSizeOf(block.type);
  const kpiIndex = variant === "kpi" ? editor.kpis.findIndex((b) => b.id === block.id) : -1;
  const shownFormat = blockFormat(block, editor.run.results[block.id]);
  const forecastGrain = built ? blockTimeGrain(editor, block) : null;

  const move = (dir: MoveDir) => editor.moveBlock(block.id, dir);
  const size = (dir: SizeDir) => editor.resizeBlock(block.id, dir);

  return (
    <Popover
      portal
      align="end"
      width={248}
      haspopup="menu"
      role="menu"
      ariaLabel={variant === "kpi" ? "KPI options" : "Block options"}
      onOpenChange={onOpenChange}
      className={className}
      trigger={(api) => <IconButton size="sm" aria-label="More options" title="More options" icon={<MoreIcon size={15} />} data-popover-trigger="" data-block-menu="" {...api.props} />}
    >
      {({ close }) => (
        <div className="py-1" data-block-menu-panel="">
          {onRename && block.type !== "divider" && (
            <MenuRow icon={<EditIcon size={14} />} onClick={() => { close(); onRename(); }}>Rename</MenuRow>
          )}
          {canAskAi(editor, block) && (
            <MenuRow icon={<SparkleIcon size={14} />} onClick={() => { close(); editor.openSheet({ kind: "ai", blockId: block.id }); }}>Change with AI…</MenuRow>
          )}
          {canEditQuery(editor, block) && (
            <MenuRow icon={<CodeIcon size={14} />} onClick={() => { close(); editor.openSheet({ kind: "query", blockId: block.id }); }}>Edit query…</MenuRow>
          )}
          {/* 2026-10-07 (chart-types round): the chart gallery, and the
              forecast of a block over time (offered only for one). */}
          {variant === "grid" && built && (block.type === "chart" || block.type === "donut") && (
            <MenuRow icon={<BarChartIcon size={14} />} onClick={() => { close(); editor.openSheet({ kind: "chart", blockId: block.id }); }}>Chart type…</MenuRow>
          )}
          {built && (block.type === "chart" || block.type === "kpi") && forecastGrain && (
            <MenuRow icon={<ChartIcon size={14} />} trailing={cfg.forecast ? "On" : undefined} onClick={() => { close(); editor.openSheet({ kind: "forecast", blockId: block.id }); }}>Forecast…</MenuRow>
          )}

          {variant === "kpi" && data && (
            <>
              <MenuDivider />
              <MenuCaption>Number format</MenuCaption>
              <div className="flex flex-wrap gap-1 px-3 pb-1.5" role="group" aria-label="Number format">
                {/* The pressed chip is the format the tile is SHOWN in - the
                    owner's, the backend's, or the one inferred here. Picking
                    one makes it the owner's: `format_inferred` is dropped
                    from the saved config so it is never re-inferred away. */}
                {KPI_FORMATS.map((f) => (
                  <Chip key={f.value} pressed={shownFormat.format === f.value} disabled={busy} onClick={async () => { setBusy(true); try { await editor.updateConfig(block, { format: f.value, format_inferred: undefined }); } finally { setBusy(false); } }}>
                    {f.label}
                  </Chip>
                ))}
              </div>
              <div className="flex items-center justify-between gap-3 px-3 pb-1.5" role="group" aria-label="Decimals">
                <span className="text-ui text-text">Decimals</span>
                <span className="flex items-center gap-1">
                  {[0, 1, 2].map((d) => (
                    <Chip key={d} label={`${d} decimals`} pressed={cfg.decimals === d} disabled={busy} onClick={async () => { setBusy(true); try { await editor.updateConfig(block, { decimals: d }); } finally { setBusy(false); } }}>
                      {d}
                    </Chip>
                  ))}
                </span>
              </div>
              <div className="px-3 py-1.5">
                <Switch
                  checked={cfg.good_direction === "down"}
                  disabled={busy}
                  onChange={async (on) => { setBusy(true); try { await editor.updateConfig(block, { good_direction: on ? "down" : "up", good_direction_inferred: undefined }); } finally { setBusy(false); } }}
                  label={<span className="text-ui text-text">Lower is better</span>}
                  description="A fall reads as good news"
                />
              </div>
            </>
          )}

          {variant === "grid" && swappable && (
            <>
              <MenuDivider />
              <MenuCaption>Swap to</MenuCaption>
              {/* Only the forms this block's data can be drawn as; the
                  rest say what they need (menu.tsx swapChoices). */}
              <SwapChips block={block} result={editor.run.results[block.id]} busy={busy} onSwap={async (payload) => { setBusy(true); try { await editor.swapBlock(block, payload); } finally { setBusy(false); close(); } }} />
            </>
          )}

          {variant === "grid" && fileChart && (
            <>
              <MenuDivider />
              <MenuCaption>Chart type</MenuCaption>
              <div className="flex flex-wrap gap-1 px-3 pb-1.5" role="group" aria-label="Chart type" data-file-chart-types="">
                {FILE_CHART_TYPES.map((o) => (
                  <Chip
                    key={o.value}
                    pressed={fileChartNow === o.value || (o.value === "bar" && fileChartNow === "column")}
                    disabled={busy}
                    onClick={async () => {
                      if (fileChartNow === o.value) return;
                      setBusy(true);
                      try {
                        editor.applyDash(await dashboardBuilderApi.restyleBlock(editor.dash.id, block.id, o.value), { blockId: block.id });
                        close();
                      } catch {
                        // The block is unchanged; the menu stays open to try another form.
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    {o.label}
                  </Chip>
                ))}
              </div>
            </>
          )}

          {variant === "grid" && built && (block.type === "chart" || block.type === "donut") && (
            <ColourControl editor={editor} block={block} busy={busy} setBusy={setBusy} />
          )}

          {variant === "grid" && !stacked && item && (
            <>
              <MenuDivider />
              <StepRow label="Move">
                {(["up", "down", "left", "right"] as MoveDir[]).map((dir) => {
                  const Icon = dir === "up" ? ArrowUpIcon : dir === "down" ? ArrowDownIcon : dir === "left" ? ArrowLeftIcon : ArrowRightIcon;
                  return <Step key={dir} label={`Move ${dir}`} icon={<Icon size={13} />} disabled={!canMove(layout, block.id, dir)} onClick={() => move(dir)} />;
                })}
              </StepRow>
              <StepRow label="Width">
                <Step label="Make narrower" icon={<MinusIcon size={13} />} disabled={!canResize(layout, block.id, "narrower", min)} onClick={() => size("narrower")} />
                <span className="w-9 text-center text-caption tabular-nums text-muted" aria-hidden="true">{item.w}/12</span>
                <Step label="Make wider" icon={<PlusIcon size={13} />} disabled={!canResize(layout, block.id, "wider", min) || item.w >= 12} onClick={() => size("wider")} />
              </StepRow>
              <StepRow label="Height">
                <Step label="Make shorter" icon={<MinusIcon size={13} />} disabled={!canResize(layout, block.id, "shorter", min)} onClick={() => size("shorter")} />
                <span className="w-9 text-center text-caption tabular-nums text-muted" aria-hidden="true">{item.h}</span>
                <Step label="Make taller" icon={<PlusIcon size={13} />} disabled={!canResize(layout, block.id, "taller", min)} onClick={() => size("taller")} />
              </StepRow>
            </>
          )}

          {variant === "kpi" && editor.kpis.length > 1 && (
            <>
              <MenuDivider />
              <MenuRow icon={<ArrowLeftIcon size={14} />} disabled={kpiIndex <= 0} onClick={() => editor.moveKpi(block.id, kpiIndex - 1)}>Move left</MenuRow>
              <MenuRow icon={<ArrowRightIcon size={14} />} disabled={kpiIndex < 0 || kpiIndex >= editor.kpis.length - 1} onClick={() => editor.moveKpi(block.id, kpiIndex + 1)}>Move right</MenuRow>
            </>
          )}

          <MenuDivider />
          <MenuRow icon={<CopyIcon size={14} />} disabled={busy} onClick={async () => { close(); await editor.duplicateBlock(block); }}>Duplicate</MenuRow>
          <MenuRow danger icon={<TrashIcon size={14} />} onClick={() => { close(); editor.requestRemove(block); }}>Remove</MenuRow>
        </div>
      )}
    </Popover>
  );
}
