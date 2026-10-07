import { useMemo, useState } from "react";
import type { BlockResult, DashboardBlock } from "../../api/client";
import { Button, Field, NumberInput, SegmentedControl, Sheet, Switch, WarningIcon } from "../../ui";
import { forecastCaption } from "../charts/model";
import { shapeFromResult, shapeFromSpec, type ChartShape } from "../charts/recommend";
import { adaptFileBlock } from "../fileData";
import { blockDisplayName } from "./AskAiSheet";
import { ChartGallery } from "./ChartGallery";
import { type DashboardEditor, errorDetail } from "./useDashboardEditor";

// 2026-10-07 (chart-types round): two sheets the block menu opens.
//
//   "Chart type..."  the chart gallery for a built chart block: every form
//                    as a thumbnail of THIS block's data, the recommended
//                    one marked with its reason, the forms the data cannot
//                    be drawn as saying what they need. A pick is applied
//                    at once (a swap on a warehouse block, a redraw from
//                    the block's own rows on a file block) and can be undone.
//   "Forecast..."    for a block over time: on / off, how many periods
//                    ahead, which intervals, whether to mark unusual
//                    points. Under the controls it says what the current
//                    forecast is - its method, its backtest error - or why
//                    there is none.

/** The result a block is drawn from right now (a warehouse run's, or a
 *  file block's adapted rows) and the shape the gallery judges against. */
export function blockResultAndShape(editor: DashboardEditor, block: DashboardBlock): { result: BlockResult | null; shape: ChartShape | null; ran: boolean } {
  const cfg = block.config || {};
  const target = typeof cfg.target === "number";
  let result: BlockResult | null = null;
  if (editor.warehouse) {
    const r = editor.run.results[block.id];
    result = r && r.status === "ok" ? r : null;
  } else {
    const adapted = adaptFileBlock(block, editor.run.overrides[block.id]);
    result = adapted.kind === "result" ? adapted.result : null;
  }
  if (result && result.rows?.length) return { result, shape: shapeFromResult(result, cfg.spec || result.spec, { target }), ran: true };
  if (cfg.spec) return { result: null, shape: shapeFromSpec(cfg.spec, cfg.spec_columns || null, { target }), ran: false };
  return { result: null, shape: null, ran: false };
}

export function ChartTypeSheet({ editor, block }: { editor: DashboardEditor; block: DashboardBlock }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { result, shape, ran } = useMemo(() => blockResultAndShape(editor, block), [editor, block]);
  const current = block.type === "donut" ? "donut" : typeof block.config?.chart_type === "string" ? block.config.chart_type : null;
  const pick = async (type: string) => {
    setBusy(true);
    setError(null);
    try {
      await editor.setChartType(block, type);
    } catch (e) {
      setError(errorDetail(e, "That chart type couldn't be applied."));
    } finally {
      setBusy(false);
    }
  };
  const target = typeof block.config?.target === "number" ? block.config.target : null;
  const [draftTarget, setDraftTarget] = useState<number | null>(target);
  return (
    <Sheet open onClose={editor.closeSheet} title={blockDisplayName(block)} subtitle="Chart type" size="lg" id="chart-gallery" footer={<Button variant="secondary" onClick={editor.closeSheet} data-gallery-done="">Done</Button>}>
      <div className="flex flex-col gap-4" data-chart-type-sheet="">
        {shape ? (
          <ChartGallery block={block} shape={shape} ran={ran} result={result} current={current} busy={busy} onPick={pick} />
        ) : (
          <div className="text-ui text-muted">This block has no data to draw yet - build it first.</div>
        )}
        {block.config?.chart_auto && shape && (
          <div className="text-caption text-muted" data-gallery-auto="">GD360 chose this form{block.config?.chart_reason ? `: ${block.config.chart_reason}` : ""}. Pick another and it stays as you set it.</div>
        )}
        {(current === "bullet" || block.type === "gauge") && (
          <Field label="Target" id="chart-target" hint="The mark the value is compared with.">
            <div className="flex items-center gap-2">
              <NumberInput aria-label="Target" data-chart-target="" value={draftTarget} onChange={setDraftTarget} className="max-w-[200px]" />
              <Button variant="secondary" disabled={busy || draftTarget === target} onClick={async () => { setBusy(true); try { await editor.updateConfig(block, { target: draftTarget ?? undefined }); } finally { setBusy(false); } }} data-chart-target-save="">Set target</Button>
            </div>
          </Field>
        )}
        {error && (
          <div role="alert" className="flex items-start gap-2 rounded-ctl border border-danger-border bg-danger-fill px-3 py-2.5 text-ui text-danger" data-gallery-error="">
            <WarningIcon size={14} className="mt-0.5 shrink-0" />
            <span className="min-w-0 break-words">{error}</span>
          </div>
        )}
      </div>
    </Sheet>
  );
}

const GRAIN_PLURAL: Record<string, string> = { day: "days", week: "weeks", month: "months", quarter: "quarters", year: "years" };
const DEFAULT_HORIZON: Record<string, number> = { day: 14, week: 8, month: 6, quarter: 4, year: 3 };
const MAX_HORIZON: Record<string, number> = { day: 90, week: 26, month: 24, quarter: 8, year: 5 };

/** The grain of a block's time axis, or null when it has none (the
 *  backend's _block_time_grain, from what the page already holds). */
export function blockTimeGrain(editor: DashboardEditor, block: DashboardBlock): string | null {
  const cfg = block.config || {};
  if (cfg.spec && typeof cfg.spec === "object") {
    if (cfg.spec.time?.column) {
      const r = editor.run.results[block.id];
      return (r && r.status === "ok" && r.period) || cfg.spec.time.grain || "month";
    }
    if ((block.type === "kpi" || block.type === "sparkline") && cfg.spec.sparkline) return editor.dash.default_period || "month";
    return null;
  }
  if (block.type !== "chart") return null;
  const adapted = adaptFileBlock(block, editor.run.overrides[block.id]);
  return adapted.kind === "result" && adapted.result.time_column ? adapted.result.period || "month" : null;
}

export function ForecastSheet({ editor, block }: { editor: DashboardEditor; block: DashboardBlock }) {
  const grain = blockTimeGrain(editor, block) || "month";
  const stored = block.config?.forecast && typeof block.config.forecast === "object" ? block.config.forecast : null;
  // Opening this sheet is asking for a forecast: on, until switched off.
  const [enabled, setEnabled] = useState<boolean>(true);
  const [horizon, setHorizon] = useState<number | null>(typeof stored?.horizon === "number" ? stored.horizon : DEFAULT_HORIZON[grain] ?? 6);
  const [interval, setIntervalChoice] = useState<"80" | "95" | "both">(stored?.interval === "80" || stored?.interval === "95" ? stored.interval : "both");
  const [anomalies, setAnomalies] = useState(Boolean(stored?.anomalies));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = useMemo(() => {
    if (editor.warehouse) return editor.run.results[block.id]?.forecast || null;
    const adapted = adaptFileBlock(block, editor.run.overrides[block.id]);
    return adapted.kind === "result" ? adapted.result.forecast || null : null;
  }, [editor, block]);
  const plural = GRAIN_PLURAL[grain] || `${grain}s`;
  const max = MAX_HORIZON[grain] ?? 24;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await editor.setForecast(block, { enabled, horizon: enabled ? Math.max(1, Math.min(max, Math.round(horizon ?? DEFAULT_HORIZON[grain] ?? 6))) : null, interval, anomalies });
      editor.closeSheet();
    } catch (e) {
      setError(errorDetail(e, "The forecast couldn't be saved."));
    } finally {
      setBusy(false);
    }
  };
  const head = live?.series?.find((s) => s.status === "ok") || null;
  return (
    <Sheet
      open
      onClose={busy ? () => undefined : editor.closeSheet}
      persistent={busy}
      title={blockDisplayName(block)}
      subtitle="Forecast"
      size="sm"
      id="forecast-sheet"
      footer={
        <>
          <Button variant="ghost" onClick={editor.closeSheet} disabled={busy}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={save} data-forecast-save="">Save</Button>
        </>
      }
    >
      <div className="flex flex-col gap-5" data-forecast-sheet="">
        <Switch
          checked={enabled}
          disabled={busy}
          onChange={setEnabled}
          label={<span className="text-ui font-medium text-text">Show a forecast</span>}
          description="Computed from this block's own series, on the server"
          data-forecast-enabled=""
        />
        <Field label={`How far ahead (${plural})`} id="forecast-horizon" hint={`Up to ${max} ${plural}, and never more than half the history.`}>
          <NumberInput aria-label="Forecast horizon" data-forecast-horizon="" value={horizon} min={1} max={max} disabled={busy || !enabled} unit={plural} onChange={setHorizon} />
        </Field>
        <div className="flex flex-col gap-1.5">
          <div className="text-ui font-medium text-text">Prediction interval</div>
          <SegmentedControl<"80" | "95" | "both">
            ariaLabel="Prediction interval"
            size="sm"
            disabled={busy || !enabled}
            value={interval}
            onChange={setIntervalChoice}
            options={[{ value: "80", label: "80%" }, { value: "95", label: "95%" }, { value: "both", label: "Both" }]}
          />
          <div className="text-caption text-muted">The band the value is expected to fall in 80% (or 95%) of the time.</div>
        </div>
        <Switch
          checked={anomalies}
          disabled={busy || !enabled}
          onChange={setAnomalies}
          label={<span className="text-ui font-medium text-text">Mark unusual points</span>}
          description="Past periods far from what the same model expected"
          data-forecast-anomalies=""
        />
        {stored && live && (
          <div className="rounded-ctl border border-border bg-subtle px-3 py-2.5 text-caption text-secondary" data-forecast-status={live.status}>
            <div className="mb-0.5 font-medium uppercase tracking-caps text-muted">Now</div>
            {live.status === "ok" && head ? forecastCaption(head, grain, live.series.filter((s) => s.status === "ok").length) : live.reason || "No forecast could be made for this series."}
            {live.status === "ok" && head?.backtest?.baseline?.mape != null && head.backtest.mape != null && (
              <div className="mt-1 text-muted">Baseline ({head.backtest.baseline.method}) error: {(head.backtest.baseline.mape * 100).toFixed(1)}%.</div>
            )}
          </div>
        )}
        {error && (
          <div role="alert" className="flex items-start gap-2 rounded-ctl border border-danger-border bg-danger-fill px-3 py-2.5 text-ui text-danger" data-forecast-error="">
            <WarningIcon size={14} className="mt-0.5 shrink-0" />
            <span className="min-w-0 break-words">{error}</span>
          </div>
        )}
      </div>
    </Sheet>
  );
}
