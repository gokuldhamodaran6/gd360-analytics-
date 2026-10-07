import { useMemo, useState } from "react";
import type { DashboardBlock, DashboardDateRange, DashboardParameter } from "../api/client";
import { ColumnFilterSpecEditor, describeFilterSpec, isSpecActive } from "../components/DashboardBlocks";
import {
  CheckboxList, DateRangePicker, FilterChip, FilterRail, FilterRailSection, MultiSelect, OptionSearch, RangeSlider, SegmentedControl,
  type CheckboxListOption,
} from "../ui";
import { encodeValueToken, isMultiControl, isParamValueSet, type ParamValue, valueLabel } from "./runState";
import type { DashboardRun, DateBounds, RunSource } from "./useDashboardRun";
import { useParameterOptions } from "./useParameterOptions";

// 2026-10-07 (Option A dashboard view, Main.dc.html's left rail): one
// section per Dashboard.parameters entry, rendered with the control its
// `control` names - chips, a multi-select field, a searchable value list,
// a segmented All/A/B, a two-thumb range, a date range, a checkbox list -
// each fed by GET /parameters/{id}/options (counts included). The footer
// is the honest "Showing N of M rows · Reset" line plus "Filters apply to
// every chart · Pin to URL". A file-source dashboard adds its page's own
// filter blocks as sections (today's behaviour under the new skin).

const SEGMENTED_MAX = 4;

function ParameterControl({ param, value, onChange, source }: { param: DashboardParameter; value: ParamValue | undefined; onChange: (v: ParamValue) => void; source: RunSource }) {
  const needsOptions = param.control !== "range" && param.control !== "date_range";
  const opts = useParameterOptions(source, param, needsOptions, param.control === "search" ? 50 : 200);
  const options = useMemo<CheckboxListOption[]>(
    () => opts.values.map((v) => ({ value: encodeValueToken(v.value), label: valueLabel(v.value), count: typeof v.count === "number" ? v.count : undefined })),
    [opts.values]
  );
  const selected = isMultiControl(param.control) && Array.isArray(value) ? (value as string[]) : [];

  if (param.control === "chips") {
    if (opts.loading && options.length === 0) return <div className="ui-shimmer h-8 w-full" aria-busy="true" />;
    if (opts.error) return <div className="text-caption text-danger">{opts.error}</div>;
    const shown = options.slice(0, 8);
    return (
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={param.label}>
        {shown.map((o) => {
          const active = selected.includes(o.value);
          return (
            <FilterChip
              key={o.value}
              active={active}
              caret={false}
              aria-pressed={active}
              value={o.label}
              onClick={() => onChange(active ? selected.filter((v) => v !== o.value) : [...selected, o.value])}
            >
              {typeof o.count === "number" && <span className="text-caption font-normal text-muted tabular-nums">{o.count.toLocaleString()}</span>}
            </FilterChip>
          );
        })}
        {options.length > shown.length && <span className="self-center text-caption text-muted">+{options.length - shown.length} more</span>}
        {options.length === 0 && !opts.loading && <span className="text-caption text-muted">No values</span>}
      </div>
    );
  }
  if (param.control === "multi") {
    return (
      <MultiSelect
        options={options}
        value={selected}
        onChange={(v) => onChange(v)}
        onSearch={opts.setSearch}
        loading={opts.loading}
        placeholder="All"
        ariaLabel={param.label}
        width="100%"
      />
    );
  }
  if (param.control === "search") {
    return (
      <OptionSearch
        options={options}
        value={selected}
        onChange={(v) => onChange(v)}
        onSearch={opts.setSearch}
        loading={opts.loading}
        total={opts.truncated ? undefined : options.length}
        limit={8}
        placeholder={`Search ${param.label.toLowerCase()}`}
        ariaLabel={param.label}
        emptyText={opts.error || "No matches"}
      />
    );
  }
  if (param.control === "segmented") {
    if (opts.loading && options.length === 0) return <div className="ui-shimmer h-9 w-full" aria-busy="true" />;
    if (options.length > SEGMENTED_MAX) {
      // Too many values for a segmented control to stay readable - the
      // same picks, as a single-select list.
      return (
        <MultiSelect
          options={options}
          value={typeof value === "string" && value ? [value] : []}
          onChange={(v) => onChange(v.length ? v[v.length - 1] : null)}
          placeholder="All"
          ariaLabel={param.label}
          width="100%"
        />
      );
    }
    const current = typeof value === "string" && value ? value : "__all__";
    return (
      <SegmentedControl
        fullWidth
        ariaLabel={param.label}
        value={current}
        onChange={(v) => onChange(v === "__all__" ? null : v)}
        options={[{ value: "__all__", label: "All" }, ...options.map((o) => ({ value: o.value, label: o.label as string }))]}
      />
    );
  }
  if (param.control === "checkboxes") {
    return (
      <CheckboxList
        options={options}
        value={selected}
        onChange={(v) => onChange(v)}
        searchable={options.length > 8 || Boolean(opts.search)}
        onSearch={options.length > 8 || opts.search ? opts.setSearch : undefined}
        loading={opts.loading}
        showFooter={options.length > 3}
        maxHeight={220}
        ariaLabel={param.label}
        emptyText={opts.error || "No values"}
      />
    );
  }
  return null;
}

function RangeControl({ param, value, onChange, source }: { param: DashboardParameter; value: ParamValue | undefined; onChange: (v: ParamValue) => void; source: RunSource }) {
  // Bounds: the parameter's own default {min, max} when the owner set
  // one, else derived from the column's values (the options endpoint,
  // which is count-ordered and capped - an honest approximation, labelled
  // as such below when it was used).
  const explicit = param.default && typeof param.default === "object" && !Array.isArray(param.default) ? param.default : null;
  const opts = useParameterOptions(source, param, !explicit, 200);
  const bounds = useMemo<[number, number] | null>(() => {
    if (explicit && Number.isFinite(Number(explicit.min)) && Number.isFinite(Number(explicit.max))) return [Number(explicit.min), Number(explicit.max)];
    const nums = opts.values.map((v) => Number(v.value)).filter((n) => Number.isFinite(n));
    if (nums.length < 2) return null;
    return [Math.min(...nums), Math.max(...nums)];
  }, [explicit, opts.values]);
  if (!bounds) {
    if (opts.loading) return <div className="ui-shimmer h-10 w-full" aria-busy="true" />;
    return <div className="text-caption text-muted">No numeric range available for {param.column}.</div>;
  }
  const [min, max] = bounds;
  const step = Number.isInteger(min) && Number.isInteger(max) ? 1 : Math.max((max - min) / 100, 0.01);
  const current: [number, number] = Array.isArray(value) && value.length === 2 && typeof value[0] === "number" ? (value as [number, number]) : [min, max];
  const unit = explicit?.unit ? String(explicit.unit) : undefined;
  return (
    <div className="flex flex-col gap-1">
      <RangeSlider
        min={min}
        max={max}
        step={step}
        value={current}
        unit={unit}
        ariaLabel={param.label}
        inputs={false}
        marker={explicit?.median !== undefined && Number.isFinite(Number(explicit.median)) ? { value: Number(explicit.median), label: `median ${Number(explicit.median).toLocaleString()}` } : undefined}
        onChange={(v) => onChange(v[0] === min && v[1] === max ? null : v)}
      />
      {!explicit && opts.truncated && <div className="text-[11px] text-faint">Bounds from the most common values</div>}
    </div>
  );
}

function DateRangeControl({ param, value, onChange, bounds }: { param: DashboardParameter; value: ParamValue | undefined; onChange: (v: ParamValue) => void; bounds?: DateBounds | null }) {
  const current: DashboardDateRange = value && typeof value === "object" && !Array.isArray(value) ? (value as DashboardDateRange) : { from: null, to: null };
  return (
    <DateRangePicker
      variant="field"
      value={current}
      onChange={(r) => onChange(r.from || r.to ? r : null)}
      ariaLabel={param.label}
      label={param.label}
      months={1}
      className="w-full"
      // The rail (and a canvas input cell) is narrower than the panel and
      // clips what leaves it: the panel is rendered over the page instead.
      portal
      minDate={bounds?.min}
      maxDate={bounds?.max}
    />
  );
}

// The right control for one parameter - the rail's sections and an
// "input" cell on the canvas both render through this. `bounds`: a date
// column's real first and last date (the run's date_bounds).
export function ParameterField({ param, value, onChange, source, bounds }: { param: DashboardParameter; value: ParamValue | undefined; onChange: (v: ParamValue) => void; source: RunSource; bounds?: DateBounds | null }) {
  return (
    <div data-param-control={param.control} data-param-id={param.id}>
      {param.control === "range" ? (
        <RangeControl param={param} value={value} onChange={onChange} source={source} />
      ) : param.control === "date_range" ? (
        <DateRangeControl param={param} value={value} onChange={onChange} bounds={bounds} />
      ) : (
        <ParameterControl param={param} value={value} onChange={onChange} source={source} />
      )}
    </div>
  );
}

function FilterBlockSection({ block, run, source, onRemove }: { block: DashboardBlock; run: DashboardRun; source: RunSource; onRemove?: (block: DashboardBlock) => void }) {
  const column: string | null = block.config?.column || null;
  const value = run.state.filterBlockValues[block.id] ?? null;
  const [open, setOpen] = useState(false);
  if (!column) return null;
  const active = isSpecActive(value);
  return (
    <FilterRailSection
      label={block.title || column}
      trailing={
        active || onRemove ? (
          <span className="inline-flex items-center gap-2">
            {active && <button type="button" className="ui-focus rounded px-0.5 text-caption text-muted hover:text-text hover:underline" onClick={() => run.setFilterBlockValue(block.id, null)}>Clear</button>}
            {onRemove && <button type="button" className="ui-focus rounded px-0.5 text-caption text-muted hover:text-danger hover:underline" onClick={() => onRemove(block)}>Remove</button>}
          </span>
        ) : undefined
      }
    >
      <FilterChip active={active} value={describeFilterSpec(value)} onClick={() => setOpen((o) => !o)} aria-expanded={open} className="w-full [&>button]:w-full [&>button]:justify-between" />
      {open && (
        <div className="rounded-ctl border border-border bg-surface">
          <ColumnFilterSpecEditor
            datasourceId={source.datasourceId || null}
            column={column}
            spec={value}
            onChange={(spec) => run.setFilterBlockValue(block.id, spec)}
            fetchDistinctValues={source.distinctValues ? (c) => source.distinctValues!(c) : () => Promise.resolve({ values: [] })}
          />
        </div>
      )}
    </FilterRailSection>
  );
}

export type FilterRailPanelProps = {
  run: DashboardRun;
  source: RunSource;
  page: { blocks: DashboardBlock[] } | undefined;
  onPinToUrl?: () => void;
  pinned?: boolean;
  className?: string;
  width?: number;
  // "embedded": no rail chrome (the page shows it inside a Sheet on a narrow screen).
  variant?: "rail" | "embedded";
  // 2026-10-07 (dashboard edit mode): the owner is editing - "Edit filters"
  // at the top of the rail opens the rail's definition, and a legacy
  // filter block (file dashboards) can be removed from here.
  onEditFilters?: () => void;
  onRemoveFilterBlock?: (block: DashboardBlock) => void;
};

export function FilterRailPanel({ run, source, page, onPinToUrl, pinned = false, className, width, variant = "rail", onEditFilters, onRemoveFilterBlock }: FilterRailPanelProps) {
  const filterBlocks = (page?.blocks || []).filter((b) => b.type === "filter");
  const shown = run.matchedRows;
  // 2026-10-07 (real end-to-end run): the backend's total_rows is null when
  // it has no count of the whole table. Substituting the matched count
  // printed "Showing 37,518 of 37,518 rows · 1 filter" under a filter -
  // only an unfiltered page may say its matched rows are all the rows.
  const unfiltered = run.activeFilterCount === 0 && !run.state?.dateRange?.from && !run.state?.dateRange?.to;
  const total = run.totalRows ?? (unfiltered ? run.matchedRows : null);
  return (
    <FilterRail
      className={className}
      width={width}
      variant={variant}
      titleExtra={
        onEditFilters ? (
          <button type="button" data-edit-filters-link="" onClick={onEditFilters} className="ui-focus rounded px-0.5 text-caption font-medium text-brand-ink hover:underline">Edit filters</button>
        ) : undefined
      }
      summary={
        typeof shown === "number"
          ? { shown, total: typeof total === "number" ? total : null, filterCount: run.activeFilterCount, onReset: run.activeFilterCount ? run.resetFilters : undefined, loading: run.loading }
          : undefined
      }
      footer={
        typeof shown !== "number" && run.activeFilterCount > 0 ? (
          <button type="button" onClick={run.resetFilters} className="ui-focus self-start rounded px-1 text-[12.5px] font-medium text-brand-ink hover:underline">Reset filters</button>
        ) : undefined
      }
      note={
        <span className="inline-flex flex-wrap items-center gap-x-1.5">
          <span>Filters apply to every chart</span>
          {onPinToUrl && (
            <>
              <span aria-hidden="true">·</span>
              <button type="button" onClick={onPinToUrl} className="ui-focus rounded px-0.5 font-medium text-brand-ink hover:underline">{pinned ? "Link copied" : "Pin to URL"}</button>
            </>
          )}
        </span>
      }
    >
      {run.parameters.length === 0 && filterBlocks.length === 0 && (
        <div className="text-caption text-muted">No filters on this dashboard yet.</div>
      )}
      {run.parameters.map((param) => {
        const value = run.state.paramValues[param.id];
        const set = isParamValueSet(param, value);
        const onChange = (v: ParamValue) => run.setParamValue(param.id, v);
        return (
          <FilterRailSection
            key={param.id}
            label={param.label || param.column}
            trailing={set ? <button type="button" className="ui-focus rounded px-0.5 text-caption text-muted hover:text-text hover:underline" onClick={() => onChange(null)}>Clear</button> : undefined}
          >
            <ParameterField param={param} value={value} onChange={onChange} source={source} bounds={run.dateBounds?.[param.column]} />
          </FilterRailSection>
        );
      })}
      {filterBlocks.map((b) => (
        <FilterBlockSection key={b.id} block={b} run={run} source={source} onRemove={onRemoveFilterBlock} />
      ))}
    </FilterRail>
  );
}
