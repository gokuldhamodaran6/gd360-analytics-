import { useState } from "react";
import { Button, CheckIcon, PlayIcon, cn } from "../../ui";
import { ParameterField } from "../FilterRailPanel";
import { isParamValueSet, type ParamValue } from "../runState";
import type { DashboardRun, RunSource } from "../useDashboardRun";
import { formatSeconds } from "./cells";

// 2026-10-07 (analyst canvas round, OptionC.dc.html's top strip):
// "Parameters — every cell below uses these". One inline control per
// Dashboard.parameters entry, labelled by its mono `name` (what a SQL
// cell references as {{name}}), driven by the SAME run state the filter
// rail uses - changing one here schedules exactly one debounced run with
// `parameters` in the body. Right side: "Parameters in URL ✓" (the run
// state is mirrored into the URL; click copies the link) and "Run all
// cells · 0.9 s".

export type ParametersStripProps = {
  run: DashboardRun;
  source: RunSource;
  className?: string;
};

export function ParametersStrip({ run, source, className }: ParametersStripProps) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const ok = await run.copyLink();
    setCopied(ok);
    if (ok) setTimeout(() => setCopied(false), 1800);
  };
  const seconds = formatSeconds(run.totalDurationMs);
  const anySet = run.parameters.some((p) => isParamValueSet(p, run.state.paramValues[p.id]));
  return (
    <section aria-label="Parameters" data-parameters-strip="" className={cn("rounded-card border border-border bg-surface shadow-card", className)}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-subtle px-4 py-2.5">
        <div className="flex items-baseline gap-2">
          <h2 className="text-ui font-semibold text-text">Parameters</h2>
          <span className="text-caption text-muted">— every cell below uses these</span>
          {run.missingParameters.length > 0 && (
            <span className="text-caption text-warning" data-missing-parameters="">Waiting for a value: {run.missingParameters.join(", ")}</span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={copy}
            title="The current parameter values are in this page's URL - click to copy the link"
            data-parameters-in-url={anySet ? "true" : "false"}
            className={cn("ui-focus inline-flex h-8 items-center gap-1.5 rounded-ctl px-2 text-caption font-medium", anySet ? "text-brand-ink hover:bg-tint" : "text-muted hover:bg-subtle hover:text-text")}
          >
            <CheckIcon size={13} />
            {copied ? "Link copied" : "Parameters in URL"}
          </button>
          <Button
            size="sm"
            variant="secondary"
            icon={<PlayIcon size={14} />}
            onClick={run.refresh}
            loading={run.loading}
            data-run-all=""
            title="Recompute every cell in the warehouse"
          >
            Run all cells{seconds ? <span className="font-normal text-muted"> · {seconds}</span> : null}
          </Button>
        </div>
      </div>
      {run.parameters.length === 0 ? (
        <div className="px-4 py-3 text-caption text-muted">No parameters on this dashboard yet. Add them from the filter rail's editor; a SQL cell references one as <code className="font-mono">{"{{name}}"}</code>.</div>
      ) : (
        <div className="flex flex-wrap items-start gap-x-6 gap-y-3 px-4 py-3">
          {run.parameters.map((param) => {
            const value = run.state.paramValues[param.id];
            const set = isParamValueSet(param, value);
            const onChange = (v: ParamValue) => run.setParamValue(param.id, v);
            const wide = param.control === "range" || param.control === "date_range" || param.control === "checkboxes";
            return (
              <div key={param.id} className={cn("flex min-w-[180px] flex-col gap-1.5", wide ? "flex-[1_1_260px]" : "flex-[1_1_200px] max-w-[360px]")} data-strip-param={param.name || param.id}>
                <div className="flex items-center justify-between gap-2">
                  <label className="flex items-baseline gap-1.5 text-caption">
                    <code className="font-mono font-medium text-text">{param.name || param.column}</code>
                    {param.label && param.label !== (param.name || param.column) && <span className="text-muted">{param.label}</span>}
                  </label>
                  {set && (
                    <button type="button" className="ui-focus rounded px-0.5 text-[11px] text-muted hover:text-text hover:underline" onClick={() => onChange(null)}>Clear</button>
                  )}
                </div>
                <ParameterField param={param} value={value} onChange={onChange} source={source} bounds={run.dateBounds?.[param.column]} />
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
