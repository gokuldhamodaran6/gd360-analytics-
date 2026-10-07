import { useMemo, useState } from "react";
import type { BlockResult, DashboardBlock } from "../../api/client";
import type { ChartExportApi } from "../../components/ChartCanvas";
import { formatValue, humanize, measureFormats, PLAIN_FORMAT, type ValueFormat } from "../format";
import { blockSingleColor, type ChartTheme } from "../theme/chartTheme";
import { dimInfo } from "./dimensions";
import { shareText } from "./DonutChart";
import { fitText } from "./geometry";
import { ChartMessage, ChartTip, INK, markNavigation, MUTED, SECONDARY, SUBTLE, TICK_SIZE, TITLE_SIZE, useChartFrame } from "./kit";

// 2026-10-07 (chart-types round): the funnel - ordered stages and what is
// lost between them.
//
//   stages   from several measures of a one-row result (the stages are the
//            measures, in the order the query lists them), or from one
//            measure by a stage column (in the query's own order when it
//            sorts by that column, else largest first);
//   shape    one centred bar per stage, as wide as its value against the
//            first stage; a quiet band joins each stage to the next;
//   colour   one hue stepping from dark to light down the funnel (the
//            stages are an ORDER, so the colour shows the order - never
//            eight unrelated hues);
//   numbers  each stage's value and its share of the first stage on the
//            right; the stage-to-stage conversion written between the
//            bars; the overall conversion in the caption underneath.

export type FunnelStage = { key: string; label: string; value: number; raw: unknown; ofFirst: number | null; ofPrevious: number | null; color: string };

export type FunnelModel = {
  stages: FunnelStage[];
  format: ValueFormat;
  // The stage column, when the stages are its values (a click filters by it).
  column: string | null;
  overall: number | null;
  caption: string | null;
  summary: string;
};

export function funnelModel(result: BlockResult, block: Pick<DashboardBlock, "config" | "title">, theme: ChartTheme): FunnelModel | null {
  const measures = result.measures || [];
  const dims = result.dimensions || [];
  const formats = measureFormats(block, result);
  let raw: { key: string; label: string; value: number; raw: unknown }[] = [];
  let column: string | null = null;
  let format: ValueFormat = PLAIN_FORMAT;
  if (!dims.length && !result.time_column && measures.length >= 2) {
    const row = (result.rows || [])[0] || {};
    raw = measures.map((m) => ({ key: m, label: humanize(m), value: typeof row[m] === "number" ? row[m] : NaN, raw: m }));
    format = formats[measures[0]] || PLAIN_FORMAT;
  } else if (dims.length === 1 && measures.length >= 1) {
    column = dims[0];
    const m = measures[0];
    format = formats[m] || PLAIN_FORMAT;
    const info = dimInfo(result, column);
    const ordered = Boolean((block.config?.spec || result.spec)?.order_by?.some((o: any) => o.by === column)) || info.kind !== "category";
    raw = (result.rows || []).map((row, i) => ({ key: `${String(row[column as string])}-${i}`, label: info.label(row[column as string]), value: typeof row[m] === "number" ? row[m] : NaN, raw: row[column as string] ?? null }));
    if (!ordered) raw.sort((a, b) => b.value - a.value);
  } else {
    return null;
  }
  raw = raw.filter((s) => Number.isFinite(s.value) && s.value >= 0);
  if (raw.length < 2) return null;
  const single = block.config?.color_mode === "single" ? blockSingleColor(theme, block.config) : null;
  const ramp = single ? theme.rampFor(single) : theme.sequential();
  // Index 6 is the ramp's strongest step: the first stage takes it.
  const step = (i: number) => ramp[Math.max(1, 6 - Math.round((i * 5) / Math.max(1, raw.length - 1)))];
  const first = raw[0].value;
  const stages: FunnelStage[] = raw.map((s, i) => ({
    ...s,
    ofFirst: first > 0 ? s.value / first : null,
    ofPrevious: i > 0 && raw[i - 1].value > 0 ? s.value / raw[i - 1].value : null,
    color: step(i),
  }));
  const last = stages[stages.length - 1];
  const overall = first > 0 ? last.value / first : null;
  return {
    stages, format, column, overall,
    caption: overall !== null ? `Overall: ${shareText(overall)} of ${stages[0].label} reach ${last.label}` : null,
    summary: `Funnel of ${stages.length} stages from ${stages[0].label} to ${last.label}`,
  };
}

export type FunnelChartProps = {
  model: FunnelModel;
  title?: string | null;
  selectedValue?: unknown;
  hasSelection?: boolean;
  onPick?: (value: unknown) => void;
  onExportApi?: (api: ChartExportApi | null) => void;
  minHeight?: number;
  compact?: boolean;
};

export function FunnelChart({ model, title, selectedValue, hasSelection = false, onPick, onExportApi, minHeight, compact = false }: FunnelChartProps) {
  const frame = useChartFrame({ w: 520, h: 280 }, title, onExportApi);
  const { size, measure } = frame;
  const [active, setActive] = useState<number | null>(null);
  const W = Math.max(120, Math.floor(size.w)), H = Math.max(96, Math.floor(size.h));
  const n = model.stages.length;

  const scene = useMemo(() => {
    const labels = model.stages.map((s) => s.label);
    const nameW = compact ? 0 : Math.ceil(Math.min(Math.max(...labels.map((l) => measure(l, TITLE_SIZE))), Math.max(72, W * 0.3))) + 12;
    const valueTexts = model.stages.map((s) => formatValue(s.value, model.format, W < 420 ? "compact" : "full"));
    const shareTexts = model.stages.map((s) => (s.ofFirst === null ? "" : shareText(s.ofFirst)));
    const valueW = compact ? 0 : Math.ceil(Math.max(...valueTexts.map((t) => measure(t, TICK_SIZE, 500)))) + 10;
    const shareW = compact ? 0 : Math.ceil(Math.max(...shareTexts.map((t) => measure(t, TICK_SIZE)))) + 12;
    const captionH = !compact && model.caption ? 18 : 0;
    const plotW = Math.max(40, W - nameW - valueW - shareW);
    const availH = H - captionH;
    // A bar and the band under it share a stage's height.
    const stageH = Math.min(64, availH / n);
    const barH = Math.max(compact ? 4 : 14, Math.min(30, stageH * 0.58));
    const stepLabels = model.stages.map((s) => (s.ofPrevious === null ? null : `${shareText(s.ofPrevious)} continue`));
    const showSteps = !compact && stageH - barH >= 15;
    return { nameW, valueW, shareW, plotW, stageH, barH, valueTexts, shareTexts, stepLabels, showSteps, captionH };
  }, [model, W, H, measure, compact, n]);

  if (n < 2) return <ChartMessage kind="funnel-empty" minHeight={minHeight}>A funnel needs at least two stages.</ChartMessage>;

  const { nameW, plotW, stageH, barH, valueTexts, shareTexts, stepLabels, showSteps, captionH } = scene;
  const top = Math.max(0, (H - captionH - stageH * n + (stageH - barH)) / 2);
  const max = Math.max(...model.stages.map((s) => s.value), 0) || 1;
  const cx = nameW + plotW / 2;
  const widthOf = (v: number) => Math.max(2, (v / max) * plotW);
  const yOf = (i: number) => top + i * stageH;
  const selectedKey = hasSelection ? String(selectedValue) : null;
  const dim = (i: number) => (selectedKey !== null && model.column ? String(model.stages[i].raw) !== selectedKey : active !== null && active !== i);
  const pickable = Boolean(onPick && model.column);
  const live = active !== null && active < n ? active : null;

  return (
    <div ref={frame.setRoot} data-chart="funnel" className="relative h-full w-full" style={{ minHeight }}>
      <svg
        ref={frame.svgRef}
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${title ? `${title}. ` : ""}${model.summary}.${model.caption ? ` ${model.caption}.` : ""}`}
        tabIndex={compact ? -1 : 0}
        className={`ui-focus absolute left-0 top-0 block select-none rounded-[6px] ${pickable ? "cursor-pointer" : "cursor-default"}`}
        style={{ fontFamily: "inherit", fontVariantNumeric: "tabular-nums" }}
        onKeyDown={compact ? undefined : markNavigation(n, live, setActive, pickable ? (i) => onPick!(model.stages[i].raw) : undefined, false)}
        onBlur={() => setActive(null)}
        onPointerLeave={() => setActive(null)}
      >
        {model.stages.map((s, i) => {
          const w = widthOf(s.value), y = yOf(i);
          const next = model.stages[i + 1];
          const nw = next ? widthOf(next.value) : 0;
          const name = fitText(s.label, Math.max(0, nameW - 12), measure, TITLE_SIZE);
          return (
            <g key={s.key} data-funnel-stage={s.label} style={{ opacity: dim(i) ? 0.4 : 1 }} onPointerEnter={compact ? undefined : () => setActive(i)} onClick={pickable ? () => onPick!(s.raw) : undefined}>
              {live === i && <rect x={0} y={y - (stageH - barH) / 2} width={W} height={stageH} rx={4} style={{ fill: SUBTLE }} />}
              {next && (
                <path
                  d={`M${(cx - w / 2).toFixed(1)} ${(y + barH).toFixed(1)}L${(cx + w / 2).toFixed(1)} ${(y + barH).toFixed(1)}L${(cx + nw / 2).toFixed(1)} ${(y + stageH).toFixed(1)}L${(cx - nw / 2).toFixed(1)} ${(y + stageH).toFixed(1)}Z`}
                  data-funnel-band=""
                  style={{ fill: s.color, fillOpacity: 0.14 }}
                />
              )}
              <rect x={cx - w / 2} y={y} width={w} height={barH} rx={3} data-funnel-bar="" data-stage-value={s.value} style={{ fill: s.color }} />
              {!compact && (
                <>
                  <text x={nameW - 12} y={y + barH / 2 + 4} textAnchor="end" fontSize={TITLE_SIZE} style={{ fill: SECONDARY }}>
                    {name.text}
                    {name.cut && <title>{s.label}</title>}
                  </text>
                  <text x={nameW + plotW + scene.valueW} y={y + barH / 2 + 4} textAnchor="end" fontSize={TICK_SIZE} fontWeight={500} data-funnel-value="" style={{ fill: INK }}>{valueTexts[i]}</text>
                  <text x={W} y={y + barH / 2 + 4} textAnchor="end" fontSize={TICK_SIZE} data-funnel-share="" style={{ fill: MUTED }}>{shareTexts[i]}</text>
                </>
              )}
              {showSteps && next && stepLabels[i + 1] && (
                <text x={cx} y={y + barH + (stageH - barH) / 2 + 4} textAnchor="middle" fontSize={TICK_SIZE} data-funnel-step="" style={{ fill: SECONDARY }}>↓ {stepLabels[i + 1]}</text>
              )}
            </g>
          );
        })}
        {!compact && model.caption && <text x={0} y={H - 4} fontSize={TICK_SIZE} data-chart-note="" style={{ fill: MUTED }}>{fitText(model.caption, W, measure, TICK_SIZE).text}<title>{model.caption}</title></text>}
      </svg>
      {live !== null && !compact && (
        <ChartTip
          x={cx}
          y={yOf(live) + barH / 2}
          width={W}
          height={H}
          content={{
            title: model.stages[live].label,
            rows: [
              { key: "v", name: "Value", value: formatValue(model.stages[live].value, model.format, "full"), color: model.stages[live].color },
              ...(model.stages[live].ofPrevious !== null ? [{ key: "p", name: `Of ${model.stages[live - 1].label}`, value: shareText(model.stages[live].ofPrevious as number), muted: true }] : []),
              ...(live > 0 ? [{ key: "d", name: "Lost at this step", value: formatValue(model.stages[live - 1].value - model.stages[live].value, model.format, "full"), muted: true }] : []),
              ...(model.stages[live].ofFirst !== null && live > 1 ? [{ key: "f", name: `Of ${model.stages[0].label}`, value: shareText(model.stages[live].ofFirst as number), muted: true }] : []),
            ],
          }}
        />
      )}
    </div>
  );
}
