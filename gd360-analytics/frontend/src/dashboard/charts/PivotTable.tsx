import { useMemo, useState } from "react";
import { columnFormat, formatValue, humanize } from "../format";
import { ChartMessage } from "./kit";
import type { MatrixModel } from "./matrixModel";

// 2026-10-07 (chart-types round): the pivot table - measures by a row
// dimension and a column dimension, as numbers.
//
//   layout    one row per row value, one column per column value (one
//             sub-column per measure when there are several); the row
//             header stays in view while the table scrolls sideways;
//   order     scales in their natural order, entities by total (the same
//             matrixModel the heatmap reads);
//   totals    a Total column and a Total row for every measure that can
//             be added up (toggle);
//   shading   the FIRST measure's cells tinted with their value's class
//             on the theme's sequential ramp (toggle) - a wash under ink
//             text, so the numbers stay the point;
//   numbers   one number of decimals per measure, tabular figures.
// It is a table: it has no PNG export (the card's CSV download is the
// export) and needs no "view as table" twin.

export type PivotTableProps = {
  model: MatrixModel;
  title?: string | null;
  selectedValue?: unknown;
  hasSelection?: boolean;
  onPick?: (value: unknown) => void;
  minHeight?: number;
  defaultShade?: boolean;
  defaultTotals?: boolean;
};

const MAX_COLS = 40, MAX_ROWS = 200;

export function PivotTable({ model, title, selectedValue, hasSelection = false, onPick, minHeight, defaultShade = true, defaultTotals = true }: PivotTableProps) {
  const anyAdditive = model.measures.some((m) => m.additive);
  const [shade, setShade] = useState(defaultShade);
  const [totals, setTotals] = useState(defaultTotals);
  const showTotals = totals && anyAdditive;
  const nm = model.measures.length;
  const cols = model.cols.values.slice(0, MAX_COLS);
  const rows = model.rows.values.slice(0, MAX_ROWS);
  const formats = useMemo(
    () => model.measures.map((m, mi) => {
      const values: (number | null)[] = [];
      for (let r = 0; r < rows.length; r++) for (let c = 0; c < cols.length; c++) values.push(model.value(mi, r, c));
      return columnFormat(m.format, values);
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model]
  );
  if (!rows.length || !cols.length) return <ChartMessage kind="pivot-empty" minHeight={minHeight}>No rows to show.</ChartMessage>;

  const selectedKey = hasSelection && model.cross ? String(selectedValue) : null;
  const rowName = model.rows.kind === "time" ? humanize(String(model.rows.grain)) : humanize(model.rows.name);
  const colName = model.cols.kind === "time" ? humanize(String(model.cols.grain)) : humanize(model.cols.name);
  // A wash under ink text: ONE light-to-mid step of the ramp, stronger
  // class by class (12% to 52%). Mixing each class's own colour would turn the dark
  // steps grey at this strength.
  const classes = model.scale.classes;
  const hue = classes.length ? classes[Math.floor((classes.length - 1) * 0.4)].color : null;
  const tint = (v: number | null) => {
    if (!shade || v === null || !hue) return undefined;
    const c = model.scale.classOf(v);
    if (!c) return undefined;
    const strength = classes.length > 1 ? 12 + (c.index / (classes.length - 1)) * 40 : 30;
    return { background: `color-mix(in srgb, ${hue} ${Math.round(strength)}%, transparent)` };
  };
  const pill = (on: boolean) => `ui-focus rounded-full border px-2 py-[1px] text-caption ${on ? "border-tint-border bg-tint text-brand-ink" : "border-border bg-surface text-secondary hover:border-border-strong hover:text-text"}`;
  const th = "border-b border-border px-2.5 py-1.5 text-caption font-medium text-muted whitespace-nowrap bg-surface";
  const td = "border-b border-subtle px-2.5 py-1.5 text-right tabular-nums whitespace-nowrap";
  const clipped = model.cols.values.length > cols.length || model.rows.values.length > rows.length;

  return (
    <div data-chart="pivot" className="flex h-full min-h-0 w-full flex-col" style={{ minHeight }}>
      <div className="flex shrink-0 items-center gap-1.5 pb-1.5 text-caption text-muted" data-no-drag="">
        <span className="min-w-0 flex-1 truncate" title={model.summary}>{rowName} down, {colName.toLowerCase()} across</span>
        <button type="button" data-pivot-shade="" aria-pressed={shade} className={pill(shade)} onClick={() => setShade((s) => !s)}>Shade</button>
        {anyAdditive && <button type="button" data-pivot-totals="" aria-pressed={showTotals} className={pill(showTotals)} onClick={() => setTotals((t) => !t)}>Totals</button>}
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded-ctl border border-border" tabIndex={0} role="region" aria-label={`${title || "Pivot table"}: ${model.summary}`}>
        <table className="w-full border-separate border-spacing-0 text-ui text-text" data-pivot-table="">
          <thead className="sticky top-0 z-[2]">
            <tr>
              <th scope="col" rowSpan={nm > 1 ? 2 : 1} className={`${th} sticky left-0 z-[3] text-left`}>{rowName}</th>
              {cols.map((c, ci) => (
                <th key={ci} scope="col" colSpan={nm} className={`${th} ${nm > 1 ? "text-center" : "text-right"}`} data-pivot-col={model.cols.label(c)} title={model.cols.label(c)}>{model.cols.short(c)}</th>
              ))}
              {showTotals && <th scope="col" colSpan={nm} className={`${th} ${nm > 1 ? "text-center" : "text-right"} text-secondary`}>Total</th>}
            </tr>
            {nm > 1 && (
              <tr>
                {[...cols, ...(showTotals ? [null] : [])].map((_, ci) => model.measures.map((m) => (
                  <th key={`${ci}-${m.key}`} scope="col" className={`${th} text-right font-normal`} title={m.key}>{m.name}</th>
                )))}
              </tr>
            )}
          </thead>
          <tbody>
            {rows.map((rv, r) => {
              const isSel = selectedKey !== null && model.cross?.axis === "row" && String(rv) === selectedKey;
              const dimmed = selectedKey !== null && model.cross?.axis === "row" && !isSel;
              const clickable = Boolean(onPick && model.cross?.axis === "row");
              return (
                <tr key={r} data-pivot-row={model.rows.label(rv)} className={clickable ? "cursor-pointer hover:bg-subtle" : undefined} style={{ opacity: dimmed ? 0.5 : 1 }} onClick={clickable ? () => onPick!(rv) : undefined}>
                  <th scope="row" className="sticky left-0 z-[1] max-w-[220px] truncate border-b border-subtle bg-surface px-2.5 py-1.5 text-left font-medium text-text" title={model.rows.label(rv)}>{model.rows.label(rv)}</th>
                  {cols.map((_, c) => model.measures.map((m, mi) => {
                    const v = model.value(mi, r, c);
                    return <td key={`${c}-${m.key}`} className={td} data-pivot-cell="" data-cell-value={v ?? undefined} style={mi === 0 ? tint(v) : undefined}>{v === null ? "" : formatValue(v, formats[mi], "full")}</td>;
                  }))}
                  {showTotals && model.measures.map((m, mi) => (
                    <td key={`t-${m.key}`} className={`${td} font-medium`} data-pivot-row-total="">{model.rowTotals[mi][r] === null ? "" : formatValue(model.rowTotals[mi][r], formats[mi], "full")}</td>
                  ))}
                </tr>
              );
            })}
          </tbody>
          {showTotals && (
            <tfoot className="sticky bottom-0 z-[2]">
              <tr data-pivot-total-row="">
                <th scope="row" className="sticky left-0 z-[3] border-t border-border bg-surface px-2.5 py-1.5 text-left font-medium text-secondary">Total</th>
                {cols.map((_, c) => model.measures.map((m, mi) => (
                  <td key={`${c}-${m.key}`} className="border-t border-border bg-surface px-2.5 py-1.5 text-right font-medium tabular-nums whitespace-nowrap" data-pivot-col-total="">{model.colTotals[mi][c] === null ? "" : formatValue(model.colTotals[mi][c], formats[mi], "full")}</td>
                )))}
                {model.measures.map((m, mi) => (
                  <td key={`g-${m.key}`} className="border-t border-border bg-surface px-2.5 py-1.5 text-right font-semibold tabular-nums whitespace-nowrap" data-pivot-grand="">{model.grand[mi] === null ? "" : formatValue(model.grand[mi], formats[mi], "full")}</td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {clipped && <div className="shrink-0 pt-1 text-caption text-muted" data-chart-note="">Showing the first {rows.length.toLocaleString()} rows and {cols.length.toLocaleString()} columns; download the CSV for all of them.</div>}
    </div>
  );
}
