import { useMemo, useState } from "react";
import type { BlockResult, DashboardBlock } from "../../api/client";
import type { ChartExportApi } from "../../components/ChartCanvas";
import { blockFormat, formatValue, humanize, type ValueFormat } from "../format";
import { blockSingleColor, type ChartTheme } from "../theme/chartTheme";
import { dimInfo } from "./dimensions";
import { shareText } from "./DonutChart";
import { fitText } from "./geometry";
import { ChartMessage, ChartTip, INK, markNavigation, MUTED, SECONDARY, SUBTLE, TICK_SIZE, TITLE_SIZE, useChartFrame } from "./kit";

// 2026-10-07 (chart-types round): a number against a target.
//
//   BulletChart   one bar per value (a KPI: one bar; a measure by a
//                 category: one bar a row), the single colour on a lighter
//                 track of the SAME hue, the target as a tick across the
//                 track, and the words that make it readable without the
//                 picture: "4,120 of 5,000 target · 82%".
//   GaugeChart    the gauge block in the same language: one arc on a track
//                 of its own hue, the target tick, the number in the
//                 middle in the block's format. (The old gauge drew its
//                 own accent colours; this one reads the theme.)
// The target is config.target (a number the owner sets); without one the
// bar is drawn against the largest value and says no target is set.

export type BulletRow = { key: string; label: string; value: number; raw: unknown };
export type BulletModel = {
  rows: BulletRow[];
  target: number | null;
  max: number;
  format: ValueFormat;
  measureName: string;
  color: string;
  track: string;
  column: string | null;
  summary: string;
};

export function bulletModel(result: BlockResult, block: Pick<DashboardBlock, "config" | "title">, theme: ChartTheme): BulletModel | null {
  const measure = (result.measures || [])[0];
  if (!measure) return null;
  const cfg = block.config || {};
  const dims = result.dimensions || [];
  const format = blockFormat(block, result);
  const color = blockSingleColor(theme, cfg);
  const ramp = cfg.color_mode === "single" ? theme.rampFor(color) : theme.sequential();
  // The lightest step of the bar's own hue (index 0 is the step nearest
  // the surface in both modes).
  const track = ramp[0];
  let rows: BulletRow[];
  let column: string | null = null;
  if (dims.length >= 1) {
    column = dims[0];
    const info = dimInfo(result, column);
    rows = (result.rows || []).filter((r) => typeof r[measure] === "number").map((r, i) => ({ key: `${String(r[column as string])}-${i}`, label: info.label(r[column as string]), value: r[measure] as number, raw: r[column as string] ?? null }));
    if (info.kind === "category") rows.sort((a, b) => b.value - a.value);
    rows = rows.slice(0, 12);
  } else {
    const v = (result.rows || [])[0]?.[measure];
    rows = typeof v === "number" ? [{ key: measure, label: humanize(cfg.label || measure), value: v, raw: null }] : [];
  }
  if (!rows.length) return null;
  const target = typeof cfg.target === "number" && Number.isFinite(cfg.target) ? cfg.target : typeof cfg.target_value === "number" ? cfg.target_value : null;
  const top = Math.max(...rows.map((r) => r.value), target ?? 0, 0);
  const explicitMax = typeof cfg.max === "number" && cfg.max > 0 ? cfg.max : null;
  const max = explicitMax ?? (top > 0 ? top * (target !== null && target >= top ? 1.1 : 1.15) : 1);
  return {
    rows, target, max, format, measureName: humanize(measure), color, track, column,
    summary: target !== null ? `${humanize(measure)} against a target of ${formatValue(target, format, "auto")}` : `${humanize(measure)}, no target set`,
  };
}

export type BulletChartProps = {
  model: BulletModel;
  title?: string | null;
  selectedValue?: unknown;
  hasSelection?: boolean;
  onPick?: (value: unknown) => void;
  onExportApi?: (api: ChartExportApi | null) => void;
  minHeight?: number;
  compact?: boolean;
};

export function BulletChart({ model, title, selectedValue, hasSelection = false, onPick, onExportApi, minHeight, compact = false }: BulletChartProps) {
  const frame = useChartFrame({ w: 480, h: 160 }, title, onExportApi);
  const { size, measure } = frame;
  const [active, setActive] = useState<number | null>(null);
  const W = Math.max(120, Math.floor(size.w)), H = Math.max(64, Math.floor(size.h));
  const single = model.rows.length === 1 && !model.column;

  const scene = useMemo(() => {
    const n = model.rows.length;
    const nameW = single || compact ? 0 : Math.ceil(Math.min(Math.max(...model.rows.map((r) => measure(r.label, TITLE_SIZE))), Math.max(64, W * 0.32))) + 10;
    const valueTexts = model.rows.map((r) => formatValue(r.value, model.format, single ? "auto" : W < 420 ? "compact" : "full"));
    const pctTexts = model.rows.map((r) => (model.target ? shareText(r.value / model.target) : ""));
    const tail = single || compact ? 0 : Math.ceil(Math.max(...valueTexts.map((t, i) => measure(t, TICK_SIZE, 500) + (pctTexts[i] ? measure(` · ${pctTexts[i]}`, TICK_SIZE) : 0)))) + 10;
    const trackW = Math.max(40, W - nameW - tail);
    const headH = single && !compact ? 44 : 0;
    const footH = !compact ? 18 : 0;
    const rowH = single ? Math.min(40, Math.max(18, H - headH - footH)) : Math.min(40, Math.max(18, (H - footH) / n));
    return { nameW, tail, trackW, valueTexts, pctTexts, headH, footH, rowH };
  }, [model, W, H, measure, single, compact]);

  if (!model.rows.length) return <ChartMessage kind="bullet-empty" minHeight={minHeight}>No value to show.</ChartMessage>;

  const { nameW, trackW, valueTexts, pctTexts, headH, rowH } = scene;
  const barH = single ? 14 : Math.max(6, Math.min(12, rowH * 0.4));
  const px = (v: number) => nameW + Math.min(1, Math.max(0, v / model.max)) * trackW;
  const blockH = headH + rowH * model.rows.length;
  const top = single ? Math.max(0, (H - scene.footH - blockH) / 2) : 0;
  const selectedKey = hasSelection ? String(selectedValue) : null;
  const pickable = Boolean(onPick && model.column);
  const live = active !== null && active < model.rows.length ? active : null;
  const targetText = model.target !== null ? `Target ${formatValue(model.target, model.format, "auto")}` : "No target set";
  const first = model.rows[0];
  const headline = single ? `${valueTexts[0]}` : "";
  const sub = single ? (model.target ? `of ${formatValue(model.target, model.format, "auto")} target · ${shareText(first.value / model.target)}` : "No target set - add one in the block menu") : "";

  return (
    <div ref={frame.setRoot} data-chart="bullet" className="relative h-full w-full" style={{ minHeight }}>
      <svg
        ref={frame.svgRef}
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${title ? `${title}. ` : ""}${model.summary}. ${model.rows.map((r, i) => `${r.label} ${valueTexts[i]}${pctTexts[i] ? `, ${pctTexts[i]} of target` : ""}`).join("; ")}.`}
        tabIndex={compact ? -1 : 0}
        className={`ui-focus absolute left-0 top-0 block select-none rounded-[6px] ${pickable ? "cursor-pointer" : "cursor-default"}`}
        style={{ fontFamily: "inherit" }}
        onKeyDown={compact ? undefined : markNavigation(model.rows.length, live, setActive, pickable ? (i) => onPick!(model.rows[i].raw) : undefined, false)}
        onBlur={() => setActive(null)}
        onPointerLeave={() => setActive(null)}
      >
        {single && !compact && (
          <>
            <text x={0} y={top + 24} fontSize={26} fontWeight={600} data-bullet-headline="" style={{ fill: INK }}>{headline}</text>
            <text x={measure(headline, 26, 600) + 10} y={top + 24} fontSize={TITLE_SIZE} data-bullet-sub="" style={{ fill: MUTED }}>{fitText(sub, Math.max(0, W - measure(headline, 26, 600) - 10), measure, TITLE_SIZE).text}</text>
          </>
        )}
        {model.rows.map((r, i) => {
          const y = top + headH + rowH * i + (rowH - barH) / 2;
          const name = fitText(r.label, Math.max(0, nameW - 10), measure, TITLE_SIZE);
          const dimmed = selectedKey !== null && model.column ? String(r.raw) !== selectedKey : live !== null && live !== i;
          const fillW = Math.max(r.value > 0 ? 2 : 0, px(r.value) - nameW);
          return (
            <g key={r.key} data-bullet-row={r.label} style={{ opacity: dimmed ? 0.4 : 1 }} onPointerEnter={compact ? undefined : () => setActive(i)} onClick={pickable ? () => onPick!(r.raw) : undefined}>
              {live === i && !single && <rect x={0} y={top + headH + rowH * i} width={W} height={rowH} rx={4} style={{ fill: SUBTLE }} />}
              {!single && !compact && (
                <text x={nameW - 10} y={y + barH / 2 + 4} textAnchor="end" fontSize={TITLE_SIZE} style={{ fill: SECONDARY }}>
                  {name.text}
                  {name.cut && <title>{r.label}</title>}
                </text>
              )}
              <rect x={nameW} y={y} width={trackW} height={barH} rx={barH / 2} data-bullet-track="" style={{ fill: model.track, fillOpacity: 0.45 }} />
              <rect x={nameW} y={y} width={fillW} height={barH} rx={barH / 2} data-bullet-bar="" data-bullet-value={r.value} style={{ fill: model.color }} />
              {model.target !== null && model.target <= model.max && (
                <line x1={px(model.target)} y1={y - 4} x2={px(model.target)} y2={y + barH + 4} strokeWidth={2} strokeLinecap="round" data-bullet-target="" style={{ stroke: INK }} />
              )}
              {!single && !compact && (
                <text x={W} y={y + barH / 2 + 4} textAnchor="end" fontSize={TICK_SIZE} data-bullet-label="">
                  <tspan fontWeight={500} style={{ fill: INK }}>{valueTexts[i]}</tspan>
                  {pctTexts[i] && <tspan style={{ fill: MUTED }}>{` · ${pctTexts[i]}`}</tspan>}
                </text>
              )}
            </g>
          );
        })}
        {!compact && !single && <text x={nameW} y={H - 4} fontSize={TICK_SIZE} data-chart-note="" style={{ fill: MUTED }}>{model.target !== null ? `${targetText} (the mark across each bar)` : "No target set - add one in the block menu"}</text>}
        {!compact && single && model.target !== null && model.target <= model.max && (
          <text x={Math.min(Math.max(px(model.target), 24), W - 24)} y={top + headH + rowH / 2 + barH / 2 + 18} textAnchor="middle" fontSize={TICK_SIZE} style={{ fill: MUTED }}>Target</text>
        )}
      </svg>
      {live !== null && !compact && (
        <ChartTip
          x={px(model.rows[live].value)}
          y={top + headH + rowH * live + rowH / 2}
          width={W}
          height={H}
          side="above"
          content={{
            title: model.rows[live].label,
            rows: [
              { key: "v", name: model.measureName, value: formatValue(model.rows[live].value, model.format, "full"), color: model.color },
              ...(model.target !== null ? [{ key: "t", name: "Target", value: formatValue(model.target, model.format, "full"), muted: true }, { key: "p", name: "Of target", value: shareText(model.rows[live].value / model.target), muted: true }] : []),
            ],
          }}
        />
      )}
    </div>
  );
}

// ---- gauge -----------------------------------------------------------------------

export type GaugeChartProps = {
  // blockData.gaugeConfig's result: {value, min, max, target, display, target_display, label}.
  value: number;
  min: number;
  max: number;
  target: number | null;
  display: string;
  targetDisplay?: string | null;
  label: string;
  color: string;
  track: string;
  title?: string | null;
  minHeight?: number;
};

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

export function GaugeChart({ value, min, max, target, display, targetDisplay, label, color, track, title, minHeight }: GaugeChartProps) {
  const frame = useChartFrame({ w: 240, h: 200 }, title);
  const { size, measure } = frame;
  const W = Math.max(96, Math.floor(size.w)), H = Math.max(80, Math.floor(size.h));
  const span = max > min ? max - min : 1;
  const pct = Math.min(1, Math.max(0, (value - min) / span));
  // A 240 degree arc, open at the bottom, sized to the box.
  const start = 150, sweep = 240;
  const stroke = Math.max(8, Math.min(14, Math.min(W, H) * 0.07));
  const captionH = 18;
  const r = Math.max(24, Math.min((W - stroke) / 2 - 4, (H - captionH - stroke) / 1.55));
  const cx = W / 2, cy = Math.min(H - captionH - r * 0.5 - stroke / 2, r + stroke / 2 + 2);
  const arc = (from: number, to: number) => {
    const [x0, y0] = polar(cx, cy, r, from), [x1, y1] = polar(cx, cy, r, to);
    return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  };
  const tick = target !== null && target >= min && target <= max ? start + sweep * ((target - min) / span) : null;
  const numSize = Math.max(16, Math.min(30, r * 0.42));
  const shown = [display].find((t) => measure(t, numSize, 600) <= r * 1.5) ?? fitText(display, r * 1.5, measure, numSize, 600).text;
  const caption = target !== null ? `of ${targetDisplay || target.toLocaleString()} target · ${shareText(target ? value / target : 0)}` : `${shareText(pct)} of the range`;
  return (
    <div ref={frame.setRoot} data-chart="gauge" className="relative h-full w-full" style={{ minHeight }}>
      <svg ref={frame.svgRef} width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title || label}: ${display}${target !== null ? `, ${caption}` : ""}`} className="absolute left-0 top-0 block" style={{ fontFamily: "inherit" }}>
        <path d={arc(start, start + sweep)} fill="none" strokeWidth={stroke} strokeLinecap="round" data-gauge-track="" style={{ stroke: track, strokeOpacity: 0.45 }} />
        {pct > 0 && <path d={arc(start, start + sweep * pct)} fill="none" strokeWidth={stroke} strokeLinecap="round" data-gauge-value={value} style={{ stroke: color }} />}
        {tick !== null && (() => {
          const [x0, y0] = polar(cx, cy, r - stroke / 2 - 4, tick), [x1, y1] = polar(cx, cy, r + stroke / 2 + 4, tick);
          return <line x1={x0} y1={y0} x2={x1} y2={y1} strokeWidth={2} strokeLinecap="round" data-gauge-target="" style={{ stroke: INK }} />;
        })()}
        <text x={cx} y={cy + numSize * 0.2} textAnchor="middle" fontSize={numSize} fontWeight={600} data-gauge-number="" style={{ fill: INK }}>{shown}</text>
        <text x={cx} y={cy + numSize * 0.2 + 18} textAnchor="middle" fontSize={TICK_SIZE} style={{ fill: MUTED }}>{fitText(label, r * 1.5, measure, TICK_SIZE).text}</text>
        <text x={cx} y={H - 5} textAnchor="middle" fontSize={TICK_SIZE} data-gauge-caption="" style={{ fill: SECONDARY }}>{fitText(caption, W - 8, measure, TICK_SIZE).text}</text>
      </svg>
    </div>
  );
}

/** The gauge's colours from the theme: the block's single colour on the
 *  lightest step of its own ramp. */
export function gaugeColors(theme: ChartTheme, config: any): { color: string; track: string } {
  const color = blockSingleColor(theme, config);
  const ramp = config?.color_mode === "single" ? theme.rampFor(color) : theme.sequential();
  return { color, track: ramp[0] };
}
