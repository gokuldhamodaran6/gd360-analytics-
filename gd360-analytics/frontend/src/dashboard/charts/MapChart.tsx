import { useMemo, useState } from "react";
import type { ChartExportApi } from "../../components/ChartCanvas";
import { formatValue } from "../format";
import { shareText } from "./DonutChart";
import { fitText } from "./geometry";
import { AXIS, BORDER, ChartMessage, ChartTip, GRID, INK, markNavigation, MUTED, SECONDARY, SUBTLE, SURFACE, TICK_SIZE, TITLE_SIZE, useChartFrame, wrapText } from "./kit";
import { unplacedLine, type MapCountry, type MapModel } from "./mapModel";
import { layoutScaleLegend, SCALE_SWATCH_H } from "./scaleLegend";
import { WORLD_GRATICULE_D, WORLD_OUTLINE_D, WORLD_POINTS, WORLD_SHAPES, WORLD_VIEWBOX } from "./worldMap";

// 2026-10-07 (chart-types round): the map - a measure by a country column.
//
//   fill        each country its value's CLASS on the theme's sequential
//               ramp (diverging when the measure runs both sides of zero);
//               the legend writes the class breaks in real numbers and,
//               when the classes are quantiles, says so and why (scale.ts);
//   no data     a quiet neutral, named in the legend;
//   territories the 75 places too small for a shape at this scale are a
//               dot at their anchor when they have a value - never dropped;
//   ranked list the top countries with thin bars and their numbers, beside
//               the map (below it on a narrow card): the values are
//               readable without hovering;
//   focus       when every country with a value sits in a small part of
//               the world the frame is fitted to them, with a "World"
//               button to step back out (and "Zoom to data" to return);
//   honesty     values that name no country are counted in a line under
//               the map - "3 values (1,240 bookings) could not be placed:
//               CN?, Unknown";
//   hover/keys  a tooltip with the country's name, value, share and rank;
//               arrow keys walk the countries in rank order, Enter (or a
//               click) cross-filters the page to that country.
// No map library and no network: the shapes are charts/worldMap.ts.

export type MapChartProps = {
  model: MapModel;
  title?: string | null;
  selectedValue?: unknown;
  hasSelection?: boolean;
  onPick?: (raw: unknown) => void;
  onExportApi?: (api: ChartExportApi | null) => void;
  minHeight?: number;
  // A gallery thumbnail: the map alone.
  compact?: boolean;
};

const LIST_ROW = 20;
const LIST_MAX = 10;

export function MapChart({ model, title, selectedValue, hasSelection = false, onPick, onExportApi, minHeight, compact = false }: MapChartProps) {
  const frame = useChartFrame({ w: 560, h: 300 }, title, onExportApi);
  const { size, measure } = frame;
  const [active, setActive] = useState<string | null>(null);
  const [world, setWorld] = useState(false);
  const W = Math.max(120, Math.floor(size.w)), H = Math.max(96, Math.floor(size.h));

  const layout = useMemo(() => {
    const fmtBreak = (v: number) => formatValue(v, model.format, "compact");
    const side = !compact && W >= 560 && H >= 200;
    const listW = side ? Math.round(Math.min(Math.max(W * 0.34, 200), 290)) : W;
    const mapW = side ? W - listW - 24 : W;
    const legend = layoutScaleLegend(model.scale, fmtBreak, Math.max(120, Math.min(mapW - 84, 360)), measure);
    const notes: string[] = [];
    if (!compact) {
      if (model.scale.note) notes.push(model.scale.note);
      const lost = unplacedLine(model);
      if (lost) notes.push(lost);
      if (model.merged && !model.additive) notes.push(`${model.merged} ${model.merged === 1 ? "value names" : "values name"} a country already listed; the larger number is shown.`);
    }
    let noteLines = notes.flatMap((t) => wrapText(t, side ? mapW : W, measure, TICK_SIZE, 2).map((line) => ({ line, full: t })));
    const legendH = compact ? 0 : legend.height + 12;
    let notesH = noteLines.length * 15 + (noteLines.length ? 4 : 0);
    // Stacked: the list takes what the map leaves, at least three rows.
    let rows = Math.min(LIST_MAX, model.countries.length);
    let mapH: number;
    if (compact) {
      mapH = H;
      rows = 0;
    } else if (side) {
      mapH = Math.max(80, H - legendH - notesH);
      rows = Math.max(0, Math.min(rows, Math.floor((H - 22) / LIST_ROW)));
    } else {
      const ideal = mapW / 2;
      const want = Math.min(3, model.countries.length);
      const fit = (noteHeight: number) => {
        const left = H - legendH - noteHeight - 8;
        let r = Math.max(0, Math.min(rows, Math.floor((left - Math.min(ideal, left * 0.6) - 22) / LIST_ROW)));
        if (r < 3) r = Math.min(3, model.countries.length, Math.max(0, Math.floor((left - 90 - 22) / LIST_ROW)));
        return { left, r };
      };
      let f = fit(notesH);
      if (f.r < want && noteLines.length > notes.length) {
        // A short card: the notes go to one line each (their full text is
        // the hover title) so the ranked list keeps its three rows.
        noteLines = notes.map((t) => ({ line: fitText(t, W, measure, TICK_SIZE).text, full: t }));
        notesH = noteLines.length * 15 + (noteLines.length ? 4 : 0);
        f = fit(notesH);
      }
      // A "top 1" is not a ranking: three rows, or the map alone (the
      // table view has every country).
      rows = f.r < want ? 0 : f.r;
      mapH = Math.max(72, Math.min(ideal, f.left - (rows ? rows * LIST_ROW + 22 : 0)));
    }
    return { side, listW, mapW, mapH, legend, legendH, noteLines, notesH, rows };
  }, [model, W, H, measure, compact]);

  if (!model.countries.length) {
    return <ChartMessage kind="map-empty" minHeight={minHeight}>None of the {model.columnName.toLowerCase()} values could be placed on the map{model.unplaced.count ? ` (${model.unplaced.labels.slice(0, 3).join(", ")}${model.unplaced.count > 3 ? ", …" : ""})` : ""}. View it as a table, or pick another chart.</ChartMessage>;
  }

  const { side, listW, mapW, mapH, legend, legendH, noteLines, rows } = layout;
  const focus = !world && model.focus ? model.focus : null;
  const vb = focus || { x: 0, y: 0, w: WORLD_VIEWBOX.width, h: WORLD_VIEWBOX.height };
  // One viewBox unit in px (the nested svg keeps the aspect ratio).
  const unit = Math.min(mapW / vb.w, mapH / vb.h);
  const px = (n: number) => n / (unit || 1);
  const ranked = model.countries;
  const activeCountry = active ? model.byIso.get(active) || null : null;
  const selectedIso = hasSelection ? ranked.find((c) => String(c.raw) === String(selectedValue))?.iso3 ?? null : null;
  const dim = (iso: string) => (selectedIso ? selectedIso !== iso : active !== null && active !== iso);
  const activeIndex = active ? ranked.findIndex((c) => c.iso3 === active) : -1;
  const onKey = markNavigation(ranked.length, activeIndex >= 0 ? activeIndex : null, (i) => setActive(i === null ? null : ranked[i].iso3), onPick ? (i) => onPick(ranked[i].raw) : undefined, false);

  // Small territories with a value: dots sized by their class, largest last
  // so a big one is never hidden under a small neighbour's ring.
  const dots = WORLD_POINTS.filter((p) => model.byIso.has(p.iso3)).map((p) => ({ p, c: model.byIso.get(p.iso3) as MapCountry }));
  const listTop = side ? 0 : mapH + legendH + layout.notesH + 8;
  const listX = side ? mapW + 24 : 0;
  const maxValue = Math.max(...ranked.map((c) => Math.abs(c.value)), 0);
  const valueTexts = ranked.slice(0, rows).map((c) => formatValue(c.value, model.format, listW < 240 ? "compact" : "full"));
  const valueW = Math.max(0, ...valueTexts.map((t) => measure(t, TICK_SIZE, 500)));
  const rankW = measure(String(rows), TICK_SIZE) + 6;
  const nameW = Math.max(48, Math.min(listW * 0.42, Math.max(...ranked.slice(0, rows).map((c) => measure(c.name, TITLE_SIZE)), 0)));
  const barX = listX + rankW + nameW + 8;
  const barW = Math.max(16, listW - rankW - nameW - 8 - valueW - 8);

  // Tooltip anchor: the country's anchor in px (or its list row).
  const anchors = new Map<string, { cx: number; cy: number }>();
  for (const s of WORLD_SHAPES) anchors.set(s.iso3, s);
  for (const p of WORLD_POINTS) anchors.set(p.iso3, p);
  let tip: { x: number; y: number } | null = null;
  if (activeCountry) {
    const a = anchors.get(activeCountry.iso3);
    const offX = (mapW - vb.w * unit) / 2, offY = (mapH - vb.h * unit) / 2;
    if (a) tip = { x: offX + (a.cx - vb.x) * unit, y: offY + (a.cy - vb.y) * unit };
    if (tip && (tip.x < 0 || tip.x > mapW || tip.y < 0 || tip.y > mapH)) {
      const row = ranked.indexOf(activeCountry);
      tip = row >= 0 && row < rows ? { x: listX + listW / 2, y: listTop + 22 + row * LIST_ROW + 10 } : { x: mapW / 2, y: mapH / 2 };
    }
  }
  const legendY = mapH + 10;

  return (
    <div ref={frame.setRoot} data-chart="map" data-map-method={model.scale.method} data-map-focus={focus ? "data" : "world"} className="relative h-full w-full" style={{ minHeight }}>
      <svg
        ref={frame.svgRef}
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${title ? `${title}. ` : ""}${model.summary}. Largest: ${ranked.slice(0, 3).map((c) => `${c.name} ${formatValue(c.value, model.format, "full")}`).join(", ")}.`}
        tabIndex={compact ? -1 : 0}
        className={`ui-focus absolute left-0 top-0 block select-none rounded-[6px] ${onPick ? "cursor-pointer" : "cursor-default"}`}
        style={{ fontFamily: "inherit", fontVariantNumeric: "tabular-nums" }}
        onKeyDown={compact ? undefined : onKey}
        onBlur={() => setActive(null)}
        onPointerLeave={() => setActive(null)}
      >
        <svg x={0} y={0} width={mapW} height={mapH} viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`} preserveAspectRatio="xMidYMid meet" data-map-plot="">
          {!focus && <path d={WORLD_OUTLINE_D} fill="none" strokeWidth={px(1)} style={{ stroke: AXIS }} />}
          <path d={WORLD_GRATICULE_D} fill="none" strokeWidth={px(0.75)} style={{ stroke: GRID }} />
          {WORLD_SHAPES.map((s) => {
            const c = model.byIso.get(s.iso3);
            if (c) return null;
            return <path key={s.iso3} d={s.d} data-map-nodata={s.iso3} strokeWidth={px(0.6)} strokeLinejoin="round" style={{ fill: BORDER, stroke: SURFACE }} />;
          })}
          {WORLD_SHAPES.map((s) => {
            const c = model.byIso.get(s.iso3);
            if (!c) return null;
            const on = active === s.iso3 || selectedIso === s.iso3;
            return (
              <path
                key={s.iso3}
                d={s.d}
                data-map-country={s.iso3}
                data-map-class={model.scale.classOf(c.value)?.index}
                strokeWidth={px(on ? 1.5 : 0.6)}
                strokeLinejoin="round"
                style={{ fill: c.color, stroke: on ? INK : SURFACE, opacity: dim(s.iso3) ? 0.4 : 1 }}
                onPointerEnter={compact ? undefined : () => setActive(s.iso3)}
                onClick={onPick ? () => onPick(c.raw) : undefined}
              />
            );
          })}
          {/* The hovered country is drawn again on top so its outline is whole. */}
          {activeCountry?.shape && (() => {
            const s = WORLD_SHAPES.find((x) => x.iso3 === activeCountry.iso3);
            return s ? <path d={s.d} fill="none" strokeWidth={px(1.5)} strokeLinejoin="round" pointerEvents="none" style={{ stroke: INK }} /> : null;
          })()}
          {dots.map(({ p, c }) => {
            const on = active === p.iso3 || selectedIso === p.iso3;
            return (
              <g key={p.iso3} data-map-point={p.iso3} style={{ opacity: dim(p.iso3) ? 0.4 : 1 }} onPointerEnter={compact ? undefined : () => setActive(p.iso3)} onClick={onPick ? () => onPick(c.raw) : undefined}>
                {/* A 24 px hit area around an 8 px dot. */}
                <circle cx={p.cx} cy={p.cy} r={px(12)} fill="transparent" />
                <circle cx={p.cx} cy={p.cy} r={px(4)} strokeWidth={px(on ? 2 : 1.5)} style={{ fill: c.color, stroke: on ? INK : SURFACE }} />
              </g>
            );
          })}
        </svg>

        {!compact && (
          <g data-map-legend="" transform={`translate(0 ${legendY})`}>
            {legend.swatches.map((s, i) => (
              <rect key={i} x={s.x} y={0} width={s.w} height={SCALE_SWATCH_H} rx={2} data-legend-swatch={i} style={{ fill: s.color }} />
            ))}
            {legend.labels.map((l, i) => (
              <text key={i} x={l.x} y={SCALE_SWATCH_H + 13} textAnchor={l.anchor} fontSize={TICK_SIZE} data-legend-break="" style={{ fill: MUTED }}>{l.text}</text>
            ))}
            {legend.width + 84 <= mapW && (
              <g transform={`translate(${legend.width + 18} 0)`} data-legend-nodata="">
                <rect x={0} y={0} width={18} height={SCALE_SWATCH_H} rx={2} style={{ fill: BORDER }} />
                <text x={24} y={SCALE_SWATCH_H} fontSize={TICK_SIZE} style={{ fill: MUTED }}>No data</text>
              </g>
            )}
          </g>
        )}
        {noteLines.map((n, i) => (
          <text key={i} x={0} y={mapH + legendH + 14 + i * 15} fontSize={TICK_SIZE} data-map-note="" style={{ fill: MUTED }}>
            {n.line}
            {n.line !== n.full && <title>{n.full}</title>}
          </text>
        ))}

        {rows > 0 && (
          <g data-map-list="">
            <text x={listX} y={listTop + 12} fontSize={TITLE_SIZE} fontWeight={500} style={{ fill: SECONDARY }}>
              {ranked.length > rows ? `Top ${rows} of ${ranked.length.toLocaleString()}` : `${ranked.length} ${ranked.length === 1 ? "country" : "countries"}`}
            </text>
            {ranked.slice(0, rows).map((c, i) => {
              const y = listTop + 22 + i * LIST_ROW;
              const name = fitText(c.name, nameW, measure, TITLE_SIZE);
              const w = maxValue > 0 ? Math.max(2, (Math.abs(c.value) / maxValue) * barW) : 0;
              const on = active === c.iso3 || selectedIso === c.iso3;
              return (
                <g key={c.iso3} data-map-row={c.iso3} style={{ opacity: dim(c.iso3) ? 0.5 : 1 }} onPointerEnter={() => setActive(c.iso3)} onClick={onPick ? () => onPick(c.raw) : undefined}>
                  <rect x={listX - 4} y={y} width={listW + 4} height={LIST_ROW} rx={4} style={{ fill: on ? SUBTLE : "transparent" }} />
                  <text x={listX} y={y + 14} fontSize={TICK_SIZE} style={{ fill: MUTED }}>{i + 1}</text>
                  <text x={listX + rankW} y={y + 14} fontSize={TITLE_SIZE} style={{ fill: SECONDARY }}>
                    {name.text}
                    {name.cut && <title>{c.name}</title>}
                  </text>
                  <rect x={barX} y={y + 7} width={w} height={6} rx={2} data-map-bar="" style={{ fill: c.color }} />
                  <text x={listX + listW} y={y + 14} textAnchor="end" fontSize={TICK_SIZE} fontWeight={500} data-map-value="" style={{ fill: INK }}>{valueTexts[i]}</text>
                </g>
              );
            })}
          </g>
        )}
      </svg>

      {!compact && model.focus && (
        <button
          type="button"
          data-map-zoom=""
          data-no-drag=""
          className="ui-focus absolute left-1.5 top-1.5 rounded-full border border-border bg-surface px-2 py-[2px] text-caption text-secondary shadow-card hover:border-border-strong hover:text-text"
          onClick={() => setWorld((w) => !w)}
        >
          {world ? "Zoom to data" : "World"}
        </button>
      )}
      {activeCountry && tip && !compact && (
        <ChartTip
          x={tip.x}
          y={tip.y}
          width={W}
          height={H}
          content={{
            title: activeCountry.name,
            rows: [
              { key: "v", name: model.measureName, value: formatValue(activeCountry.value, model.format, "full"), color: activeCountry.color },
              ...(activeCountry.share !== null ? [{ key: "s", name: "Share of total", value: shareText(activeCountry.share), muted: true }] : []),
              { key: "r", name: "Rank", value: `${activeCountry.rank} of ${ranked.length}`, muted: true },
            ],
          }}
        />
      )}
    </div>
  );
}
