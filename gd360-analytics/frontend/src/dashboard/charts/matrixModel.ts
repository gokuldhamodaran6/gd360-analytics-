import type { BlockResult, BlockSpec, DashboardBlock } from "../../api/client";
import { humanize, measureFormats, PLAIN_FORMAT, type ValueFormat } from "../format";
import type { ChartTheme } from "../theme/chartTheme";
import { dimInfo, resultDims, valueId, type DimInfo } from "./dimensions";
import { valueScale, type ValueScale } from "./scale";

// 2026-10-07 (chart-types round): a measure by TWO dimensions as a matrix -
// the model behind the heatmap and the pivot table. Pure.
//
//   which way round   a scale (the period, a weekday, a month, a bucket)
//                     runs ACROSS, entities run DOWN; two scales: the one
//                     with more values across (months across, weekdays
//                     down - a calendar); two sets of entities: the one
//                     with fewer values across (its labels have to share
//                     the width).
//   order             scales in their natural order, entities by total,
//                     largest first (dimensions.ts).
//   totals            row, column and grand totals - only for a measure
//                     that can be added up (a sum, a count); an average of
//                     averages is not shown as a "total".
//   colour            one classed scale over every cell of the FIRST
//                     measure (scale.ts).

export type MatrixMeasure = { key: string; name: string; format: ValueFormat; additive: boolean };

export type MatrixModel = {
  rows: DimInfo;
  cols: DimInfo;
  measures: MatrixMeasure[];
  // value(measure index, row index, col index)
  value: (m: number, r: number, c: number) => number | null;
  rowTotals: (number | null)[][];
  colTotals: (number | null)[][];
  grand: (number | null)[];
  scale: ValueScale;
  // Which axis a click cross-filters by (the result's first real
  // dimension), if either.
  cross: { axis: "row" | "col"; column: string } | null;
  summary: string;
};

const ADDITIVE = new Set(["sum", "count", "count_distinct"]);

export function matrixModel(result: BlockResult, block: Pick<DashboardBlock, "config" | "title">, theme: ChartTheme): MatrixModel | null {
  const dims = resultDims(result);
  const measureKeys = result.measures || [];
  if (dims.length < 2 || !measureKeys.length) return null;
  const [a, b] = dims;
  const spec: BlockSpec | null = (block.config?.spec && typeof block.config.spec === "object" ? block.config.spec : null) || result.spec || null;
  const formats = measureFormats(block, result);
  const measures: MatrixMeasure[] = measureKeys.map((key) => ({
    key, name: humanize(key), format: formats[key] || PLAIN_FORMAT,
    additive: ADDITIVE.has(String(spec?.measures?.find((m) => m.alias === key)?.agg || "sum").toLowerCase()),
  }));
  const first = measureKeys[0];
  const totalsOf = (dim: string) => {
    const t = new Map<string, number>();
    for (const row of result.rows || []) {
      const v = row[first];
      if (typeof v === "number" && Number.isFinite(v)) t.set(valueId(row[dim]), (t.get(valueId(row[dim])) ?? 0) + v);
    }
    return t;
  };
  const da = dimInfo(result, a, totalsOf(a)), db = dimInfo(result, b, totalsOf(b));
  const scaleLike = (d: DimInfo) => d.kind !== "category";
  let rows = da, cols = db;
  if (scaleLike(da) && !scaleLike(db)) { rows = db; cols = da; }
  else if (scaleLike(da) && scaleLike(db)) { if (da.values.length > db.values.length || da.kind === "time") { rows = db; cols = da; } }
  else if (!scaleLike(da) && !scaleLike(db)) { if (da.values.length < db.values.length) { rows = db; cols = da; } }

  const rIndex = new Map(rows.values.map((v, i) => [valueId(v), i]));
  const cIndex = new Map(cols.values.map((v, i) => [valueId(v), i]));
  const nr = rows.values.length, nc = cols.values.length;
  const grids: (number | null)[][] = measures.map(() => new Array(nr * nc).fill(null));
  for (const row of result.rows || []) {
    const r = rIndex.get(valueId(row[rows.name])), c = cIndex.get(valueId(row[cols.name]));
    if (r === undefined || c === undefined) continue;
    measures.forEach((m, mi) => {
      const v = row[m.key];
      if (typeof v !== "number" || !Number.isFinite(v)) return;
      const at = r * nc + c;
      grids[mi][at] = m.additive ? (grids[mi][at] ?? 0) + v : v;
    });
  }
  const rowTotals = measures.map((m, mi) => rows.values.map((_, r) => {
    if (!m.additive) return null;
    let s = 0, any = false;
    for (let c = 0; c < nc; c++) { const v = grids[mi][r * nc + c]; if (v !== null) { s += v; any = true; } }
    return any ? s : null;
  }));
  const colTotals = measures.map((m, mi) => cols.values.map((_, c) => {
    if (!m.additive) return null;
    let s = 0, any = false;
    for (let r = 0; r < nr; r++) { const v = grids[mi][r * nc + c]; if (v !== null) { s += v; any = true; } }
    return any ? s : null;
  }));
  const grand = measures.map((m, mi) => (m.additive ? grids[mi].reduce((s: number, v) => s + (v ?? 0), 0) : null));
  const scale = valueScale(grids[0], { sequential: theme.sequential(), diverging: theme.diverging(), marks: "cells" });
  const crossColumn = (result.dimensions || [])[0] || null;
  const cross = crossColumn && rows.kind !== "part" && crossColumn === rows.name ? { axis: "row" as const, column: crossColumn }
    : crossColumn && cols.kind !== "part" && cols.kind !== "time" && crossColumn === cols.name ? { axis: "col" as const, column: crossColumn } : null;
  const nameOf = (d: DimInfo) => (d.kind === "time" ? String(d.grain) : humanize(d.name).toLowerCase());
  return {
    rows, cols, measures,
    value: (m, r, c) => grids[m]?.[r * nc + c] ?? null,
    rowTotals, colTotals, grand, scale, cross,
    summary: `${measures.map((m) => m.name).join(", ")} by ${nameOf(rows)} and ${nameOf(cols)}`,
  };
}
