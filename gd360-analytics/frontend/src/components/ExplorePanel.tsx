import { useMemo, useState } from "react";
import ChartStylePanel from "./ChartStylePanel";
import { ChartStyle } from "../lib/chartStyle";
import {
  AGGREGATIONS, Aggregation, CLIENT_PIVOTABLE_TYPES, ColumnDType, EXPLORE_CHART_LABELS, ExploreChartType,
  ExploreConfig, ExploreFilter, FILTER_OPS, FilterOp, ResultColumn, YField, applyFilters, newFilter,
} from "../lib/exploreEngine";

// GD360's own "Explore" panel - a live, no-AI-round-trip chart configurator
// modeled on the reference flow's own Explore drawer: pick X/Y/series
// fields, split into filters, sort/limit, and see the chart re-render
// instantly from the tidy numbers already in the browser (see
// lib/exploreEngine.ts). Chart-type + color/label/legend styling stays in
// the existing "Style" tab (ChartStylePanel, unchanged) so nothing already
// working gets rebuilt from scratch - this panel only adds the piece that
// never existed before: remapping WHICH fields feed the chart.

function DTypeIcon({ dtype }: { dtype: ColumnDType }) {
  if (dtype === "number") return <span className="mono-figure text-[11px] text-accent w-3.5 inline-block text-center">#</span>;
  if (dtype === "date") return <span className="text-[11px] text-accent w-3.5 inline-block text-center" aria-hidden>&#128197;</span>;
  if (dtype === "boolean") return <span className="text-[11px] text-accent w-3.5 inline-block text-center">?</span>;
  return <span className="text-[11px] text-accent w-3.5 inline-block text-center font-serif">A</span>;
}

function FieldSelect({
  columns, value, onChange, placeholder = "None", filterRole,
}: {
  columns: ResultColumn[];
  value: string | null;
  onChange: (field: string | null) => void;
  placeholder?: string;
  filterRole?: "dimension" | "measure";
}) {
  const options = filterRole ? columns.filter((c) => c.role === filterRole) : columns;
  return (
    <select
      className="input text-sm py-1.5"
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
    >
      <option value="">{placeholder}</option>
      {options.map((c) => (
        <option key={c.name} value={c.name}>{c.name}</option>
      ))}
    </select>
  );
}

function YAxisRow({
  y, columns, onChange, onRemove, removable,
}: {
  y: YField;
  columns: ResultColumn[];
  onChange: (next: YField) => void;
  onRemove: () => void;
  removable: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <div className="flex-1">
        <FieldSelect columns={columns} value={y.field} onChange={(f) => f && onChange({ ...y, field: f })} placeholder="Choose a field" />
      </div>
      {/* A plain width utility on the <select> itself loses to .input's own
          width:100% rule (same specificity, .input wins on source order) -
          wrapping it in a fixed-width div, same trick as the flex-1 wrapper
          above, is what actually constrains it. */}
      <div className="w-28 shrink-0">
        <select
          className="input text-sm py-1.5"
          value={y.agg}
          onChange={(e) => onChange({ ...y, agg: e.target.value as Aggregation })}
        >
          {AGGREGATIONS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
        </select>
      </div>
      {removable && (
        <button className="text-muted hover:text-text px-1 shrink-0" title="Remove" onClick={onRemove}>&times;</button>
      )}
    </div>
  );
}

function FilterChip({
  filter, columns, onChange, onRemove,
}: {
  filter: ExploreFilter;
  columns: ResultColumn[];
  onChange: (next: ExploreFilter) => void;
  onRemove: () => void;
}) {
  const col = columns.find((c) => c.name === filter.field);
  const ops = FILTER_OPS.filter((o) => !col || o.forDtype.includes(col.dtype));
  return (
    <div className="flex items-center gap-1 pill !py-1 !px-1.5 flex-wrap">
      <select
        className="bg-transparent text-xs font-medium outline-none max-w-[110px]"
        value={filter.field}
        onChange={(e) => onChange({ ...filter, field: e.target.value })}
      >
        {columns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
      </select>
      <select
        className="bg-transparent text-xs outline-none"
        value={filter.op}
        onChange={(e) => onChange({ ...filter, op: e.target.value as FilterOp })}
      >
        {ops.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
      <input
        className="bg-transparent text-xs outline-none w-20 border-b border-border focus:border-primary"
        value={filter.value}
        placeholder="value"
        onChange={(e) => onChange({ ...filter, value: e.target.value })}
      />
      <button className="text-muted hover:text-text px-0.5" onClick={onRemove} aria-label="Remove filter">&times;</button>
    </div>
  );
}

// A compact, fully in-browser data grid over the SAME tidy rows behind the
// chart (post-filter) - click a header to sort, type to search across every
// column. No server round trip: everything here is already in memory, which
// is what makes it feel instant even on a few thousand rows, unlike the Data
// tab's server-paginated preview (DataTable.tsx), which is a different,
// much larger table.
function ExploreTable({ columns, rows }: { columns: ResultColumn[]; rows: Record<string, any>[] }) {
  const [search, setSearch] = useState("");
  const [sortField, setSortField] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const filtered = useMemo(() => {
    let out = rows;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      out = out.filter((r) => columns.some((c) => String(r[c.name] ?? "").toLowerCase().includes(q)));
    }
    if (sortField) {
      out = [...out].sort((a, b) => {
        const av = a[sortField], bv = b[sortField];
        const an = Number(av), bn = Number(bv);
        const cmp = !Number.isNaN(an) && !Number.isNaN(bn) ? an - bn : String(av ?? "").localeCompare(String(bv ?? ""));
        return sortDir === "asc" ? cmp : -cmp;
      });
    }
    return out;
  }, [rows, search, sortField, sortDir, columns]);

  const toggleSort = (field: string) => {
    if (sortField === field) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortField(field); setSortDir("asc"); }
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <input
        className="input text-xs py-1.5 mb-2 shrink-0"
        placeholder={`Search ${rows.length} rows…`}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="flex-1 min-h-0 overflow-auto rounded-lg border border-border">
        <table className="w-full text-xs border-collapse">
          <thead className="sticky top-0 bg-surface2 z-10">
            <tr>
              {columns.map((c) => (
                <th
                  key={c.name}
                  className="text-left px-2.5 py-2 font-semibold whitespace-nowrap cursor-pointer select-none border-b border-border"
                  onClick={() => toggleSort(c.name)}
                >
                  <span className="inline-flex items-center gap-1">
                    <DTypeIcon dtype={c.dtype} /> {c.name}
                    {sortField === c.name && <span className="text-primary">{sortDir === "asc" ? "↑" : "↓"}</span>}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, 1000).map((row, i) => (
              <tr key={i} className="odd:bg-surface2/40 hover:bg-surface2/80">
                {columns.map((c) => (
                  <td key={c.name} className="px-2.5 py-1.5 whitespace-nowrap border-b border-border/60 text-muted">
                    {String(row[c.name] ?? "")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="text-[11px] text-muted mt-1.5 shrink-0">
        {filtered.length.toLocaleString()} of {rows.length.toLocaleString()} rows{filtered.length > 1000 ? " · showing first 1,000" : ""}
      </div>
    </div>
  );
}

export default function ExplorePanel({
  columns, rows, truncated, config, onConfigChange,
  chartSpec, style, onStyleChange, onChartTypeChange, onReset, disabled,
}: {
  columns: ResultColumn[] | null;
  rows: Record<string, any>[] | null;
  truncated?: boolean;
  config: ExploreConfig | null;
  onConfigChange: (next: ExploreConfig) => void;
  chartSpec: any;
  style: ChartStyle;
  onStyleChange: (next: Partial<ChartStyle>) => void;
  onChartTypeChange: (type: string) => void;
  onReset: () => void;
  disabled?: boolean;
}) {
  const [tab, setTab] = useState<"data" | "style" | "table">("data");
  const hasTidyData = !!(columns && columns.length && rows && config);
  const filteredCount = useMemo(
    () => (hasTidyData ? applyFilters(rows!, config!.filters, columns!).length : 0),
    [hasTidyData, rows, config, columns]
  );

  const update = (patch: Partial<ExploreConfig>) => {
    if (!config) return;
    onConfigChange({ ...config, ...patch });
  };

  const addYField = () => {
    if (!config || !columns) return;
    const used = new Set(config.yFields.map((y) => y.field));
    const next = columns.find((c) => c.role === "measure" && !used.has(c.name));
    if (next) update({ yFields: [...config.yFields, { field: next.name, agg: "sum" }] });
  };

  const addFilter = () => {
    if (!config || !columns) return;
    update({ filters: [...config.filters, newFilter(columns[0]?.name || "")] });
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex gap-1 shrink-0 px-1 pt-1">
        {(["data", "style", "table"] as const).map((t) => (
          <button
            key={t}
            className={`text-xs font-semibold px-3 py-2 rounded-t-lg transition ${
              tab === t ? "bg-surface2 text-text" : "text-muted hover:text-text"
            }`}
            onClick={() => setTab(t)}
            disabled={t === "table" && !hasTidyData}
          >
            {t === "data" ? "Data" : t === "style" ? "Style" : "Table"}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto bg-surface2 rounded-b-2xl rounded-tr-2xl p-4">
        {tab === "data" && (
          hasTidyData ? (
            <div className="space-y-5 text-sm">
              <div>
                <div className="text-xs font-semibold text-muted mb-1.5">CHART TYPE</div>
                <select
                  className="input text-sm py-1.5 font-medium"
                  value={config!.chartType}
                  onChange={(e) => update({ chartType: e.target.value as ExploreChartType })}
                >
                  {CLIENT_PIVOTABLE_TYPES.map((t) => (
                    <option key={t} value={t}>{EXPLORE_CHART_LABELS[t]}</option>
                  ))}
                </select>
                <div className="text-[11px] text-muted mt-1">
                  Switches instantly. For a heatmap, sankey, radar or other specialized shape, use the{" "}
                  <button className="text-accent hover:underline" onClick={() => setTab("style")}>Style tab</button>.
                </div>
              </div>

              <div>
                <div className="text-xs font-semibold text-muted mb-1.5">X-AXIS</div>
                <FieldSelect columns={columns!} value={config!.xField} onChange={(f) => update({ xField: f })} placeholder="Choose a field" />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <div className="text-xs font-semibold text-muted">Y-AXIS</div>
                  <button className="text-xs text-accent hover:underline" onClick={addYField}>+ Y-axis</button>
                </div>
                <div className="space-y-1.5">
                  {config!.yFields.map((y, i) => (
                    <YAxisRow
                      key={i}
                      y={y}
                      columns={columns!}
                      removable={config!.yFields.length > 1}
                      onChange={(next) => {
                        const yFields = [...config!.yFields];
                        yFields[i] = next;
                        update({ yFields });
                      }}
                      onRemove={() => update({ yFields: config!.yFields.filter((_, idx) => idx !== i) })}
                    />
                  ))}
                  {!config!.yFields.length && (
                    <button className="text-xs text-accent hover:underline" onClick={addYField}>+ Add a Y-axis field</button>
                  )}
                </div>
              </div>

              <div>
                <div className="text-xs font-semibold text-muted mb-1.5">SERIES / COLOR BY</div>
                <FieldSelect
                  columns={columns!}
                  value={config!.colorField}
                  onChange={(f) => update({ colorField: f })}
                  placeholder="None — one series"
                  filterRole="dimension"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-xs font-semibold text-muted mb-1.5">SORT</div>
                  <select
                    className="input text-sm py-1.5"
                    value={config!.sortDir}
                    onChange={(e) => update({ sortDir: e.target.value as ExploreConfig["sortDir"] })}
                  >
                    <option value="none">Unsorted</option>
                    <option value="desc">Highest first</option>
                    <option value="asc">Lowest first</option>
                  </select>
                </div>
                <div>
                  <div className="text-xs font-semibold text-muted mb-1.5">TOP N</div>
                  <input
                    type="number"
                    min={1}
                    className="input text-sm py-1.5"
                    value={config!.limit ?? ""}
                    placeholder="All"
                    onChange={(e) => update({ limit: e.target.value ? Math.max(1, Number(e.target.value)) : null })}
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <div className="text-xs font-semibold text-muted">FILTERS</div>
                  <button className="text-xs text-accent hover:underline" onClick={addFilter}>+ Add filter</button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {config!.filters.map((f) => (
                    <FilterChip
                      key={f.id}
                      filter={f}
                      columns={columns!}
                      onChange={(next) => update({ filters: config!.filters.map((x) => (x.id === f.id ? next : x)) })}
                      onRemove={() => update({ filters: config!.filters.filter((x) => x.id !== f.id) })}
                    />
                  ))}
                  {!config!.filters.length && <div className="text-xs text-muted">No filters — showing every row.</div>}
                </div>
              </div>

              <div className="text-[11px] text-muted pt-2 border-t border-border">
                {filteredCount.toLocaleString()} of {rows!.length.toLocaleString()} rows plotted
                {truncated ? " (source result was truncated to the first rows for speed)" : ""}. Every change above
                redraws instantly — no AI call.
              </div>
            </div>
          ) : (
            <div className="text-xs text-muted leading-relaxed p-2">
              This chart's underlying rows aren't available to remap directly (either it's an older answer from
              before this feature, or its chart type needs a specific server-built shape). Use the{" "}
              <button className="text-accent hover:underline" onClick={() => setTab("style")}>Style tab</button>{" "}
              to change its chart type — GD360 will rebuild it.
            </div>
          )
        )}

        {tab === "style" && (
          <ChartStylePanel
            chartSpec={chartSpec}
            style={style}
            onStyleChange={onStyleChange}
            onChartTypeChange={onChartTypeChange}
            onReset={onReset}
            disabled={disabled}
          />
        )}

        {tab === "table" && hasTidyData && (
          <div className="h-full min-h-[320px]">
            <ExploreTable columns={columns!} rows={applyFilters(rows!, config!.filters, columns!)} />
          </div>
        )}
      </div>
    </div>
  );
}
