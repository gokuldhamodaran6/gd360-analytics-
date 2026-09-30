import { useEffect, useMemo, useState } from "react";
import {
  datasourceApi,
  metricDefinitionsApi,
  MetricDefinition,
  MetricAgg,
  FilterCriterion,
  FilterTextOp,
  FilterNumberOp,
} from "../api/client";

// 2026-09-30 (semantic layer v1): the "Metrics" tab on Workspace.tsx
// (centerTab === "metrics") - this data source's own saved metric
// glossary. Define "Revenue" or "Active Users" once here with an exact
// column, aggregation, and (optional) filter, and that exact definition
// is what a dashboard kpi/gauge tile built from it (DashboardCanvas.tsx's
// "Use a saved metric" option) and a chat question naming it by name
// (backend services/ai_engine.py) both use - see backend
// models.MetricDefinition's own docstring and services/metrics.py for the
// full design. Mirrors QualityChecksPanel.tsx's own list+inline-form
// structure, the established pattern for a data-source-scoped feature
// tab, rather than inventing a new one.
//
// v1's filter support is deliberately ONE optional criterion, not the
// Data tab's full multi-criterion Excel-style panel - a metric is meant
// to be a simple, memorable definition ("Revenue where status =
// completed"), not a place to rebuild an arbitrary query. The backend
// (models.MetricDefinition.filters, services/metrics.py) already stores
// and resolves a full LIST of criteria using the exact same vocabulary
// the Data tab's own filter panel uses, so a future round can offer more
// than one here with no backend change at all - this form just doesn't
// expose that yet.

const AGG_OPTIONS: { value: MetricAgg; label: string }[] = [
  { value: "sum", label: "Sum" },
  { value: "avg", label: "Average" },
  { value: "count", label: "Count" },
  { value: "min", label: "Min" },
  { value: "max", label: "Max" },
];

const TEXT_OPS: { value: FilterTextOp; label: string }[] = [
  { value: "equals", label: "equals" },
  { value: "not_equals", label: "does not equal" },
  { value: "contains", label: "contains" },
  { value: "not_contains", label: "does not contain" },
];

const NUMBER_OPS: { value: FilterNumberOp; label: string }[] = [
  { value: "eq", label: "=" },
  { value: "neq", label: "!=" },
  { value: "gt", label: ">" },
  { value: "gte", label: ">=" },
  { value: "lt", label: "<" },
  { value: "lte", label: "<=" },
];

function isNumericDtype(dtype: string | undefined): boolean {
  return !!dtype && /int|float|double|number|decimal/i.test(dtype);
}

// Mirrors backend services/metrics.describe_metric exactly (same wording,
// same "where" clause shape) so this panel's own summary line never
// disagrees with the plain-English glossary note the AI is actually given -
// see that function's own docstring.
function describeMetric(m: Pick<MetricDefinition, "agg" | "metric_column" | "filters">): string {
  const aggLabel = AGG_OPTIONS.find((o) => o.value === m.agg)?.label || m.agg;
  let text = `${aggLabel} of "${m.metric_column}"`;
  const parts = (m.filters || [])
    .map((f) => {
      const spec = f.spec as any;
      if (!spec || typeof spec !== "object") return null;
      if (spec.type === "text") {
        const opLabel = TEXT_OPS.find((o) => o.value === spec.op)?.label || spec.op;
        return spec.value ? `${f.column} ${opLabel} "${spec.value}"` : null;
      }
      if (spec.type === "number") {
        const opLabel = NUMBER_OPS.find((o) => o.value === spec.op)?.label || spec.op;
        return spec.value !== "" && spec.value != null ? `${f.column} ${opLabel} ${spec.value}` : null;
      }
      return null;
    })
    .filter((p): p is string => !!p);
  if (parts.length > 0) text += ` where ${parts.join(" and ")}`;
  return text;
}

function formatValue(v: number | null): string {
  if (v === null) return "—";
  return Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

type ColumnInfo = { name: string; dtype: string };

export default function MetricsPanel({ datasourceId }: { datasourceId: string }) {
  const [metrics, setMetrics] = useState<MetricDefinition[] | null>(null);
  const [columns, setColumns] = useState<ColumnInfo[] | null>(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [column, setColumn] = useState("");
  const [agg, setAgg] = useState<MetricAgg>("sum");
  const [filterEnabled, setFilterEnabled] = useState(false);
  const [filterColumn, setFilterColumn] = useState("");
  const [filterTextOp, setFilterTextOp] = useState<FilterTextOp>("equals");
  const [filterNumberOp, setFilterNumberOp] = useState<FilterNumberOp>("eq");
  const [filterValue, setFilterValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  const numericColumns = useMemo(() => (columns || []).filter((c) => isNumericDtype(c.dtype)).map((c) => c.name), [columns]);
  const needsNumeric = agg === "sum" || agg === "avg";
  const filterColumnIsNumeric = useMemo(
    () => numericColumns.includes(filterColumn),
    [numericColumns, filterColumn]
  );

  const load = () => {
    metricDefinitionsApi
      .list(datasourceId)
      .then(setMetrics)
      .catch(() => setError("Couldn't load metrics for this data source. Please try refreshing."));
  };

  useEffect(() => {
    setMetrics(null);
    setError("");
    resetForm();
    load();
    datasourceApi
      .preview(datasourceId, null)
      .then((p) => setColumns(p.columns.map((c) => ({ name: c, dtype: p.dtypes?.[c] || "" }))))
      .catch(() => setColumns(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasourceId]);

  useEffect(() => {
    if (columns && columns.length > 0 && !column) setColumn(columns[0].name);
    if (columns && columns.length > 0 && !filterColumn) setFilterColumn(columns[0].name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns]);

  function resetForm() {
    setEditingId(null);
    setFormOpen(false);
    setName("");
    setDescription("");
    setColumn(columns?.[0]?.name || "");
    setAgg("sum");
    setFilterEnabled(false);
    setFilterColumn(columns?.[0]?.name || "");
    setFilterTextOp("equals");
    setFilterNumberOp("eq");
    setFilterValue("");
    setFormError("");
  }

  function startEdit(m: MetricDefinition) {
    setEditingId(m.id);
    setFormOpen(true);
    setName(m.name);
    setDescription(m.description || "");
    setColumn(m.metric_column);
    setAgg(m.agg);
    const f = m.filters?.[0];
    if (f && f.spec && typeof f.spec === "object") {
      setFilterEnabled(true);
      setFilterColumn(f.column);
      const spec = f.spec as any;
      if (spec.type === "number") {
        setFilterNumberOp(spec.op);
        setFilterValue(String(spec.value ?? ""));
      } else {
        setFilterTextOp(spec.op || "equals");
        setFilterValue(String(spec.value ?? ""));
      }
    } else {
      setFilterEnabled(false);
    }
    setFormError("");
  }

  function buildFilters(): FilterCriterion[] {
    if (!filterEnabled || !filterColumn || filterValue.trim() === "") return [];
    if (filterColumnIsNumeric) {
      return [{ column: filterColumn, spec: { type: "number", op: filterNumberOp, value: filterValue.trim() } }];
    }
    return [{ column: filterColumn, spec: { type: "text", op: filterTextOp, value: filterValue.trim() } }];
  }

  const save = async () => {
    setFormError("");
    if (!name.trim()) {
      setFormError("Give this metric a name.");
      return;
    }
    if (!column) {
      setFormError("Pick a column.");
      return;
    }
    if (needsNumeric && !numericColumns.includes(column)) {
      setFormError('Sum/Average need a numeric column - try Count, Min, or Max instead.');
      return;
    }
    if (filterEnabled && (!filterColumn || filterValue.trim() === "")) {
      setFormError("Finish the filter (pick a column and a value), or turn it off.");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        description: description.trim() || null,
        metric_column: column,
        agg,
        filters: buildFilters(),
      };
      if (editingId) {
        const updated = await metricDefinitionsApi.update(datasourceId, editingId, payload);
        setMetrics((prev) => (prev || []).map((m) => (m.id === editingId ? updated : m)));
      } else {
        const created = await metricDefinitionsApi.create(datasourceId, payload);
        setMetrics((prev) => [...(prev || []), created].sort((a, b) => a.name.localeCompare(b.name)));
      }
      resetForm();
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      setFormError(typeof detail === "string" ? detail : "Couldn't save this metric. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const deleteMetric = async (metricId: string) => {
    if (!window.confirm("Delete this metric? Any dashboard tile or chat answer built from it will stop updating.")) return;
    setBusyId(metricId);
    setError("");
    try {
      await metricDefinitionsApi.delete(datasourceId, metricId);
      setMetrics((prev) => (prev || []).filter((m) => m.id !== metricId));
    } catch {
      setError("Couldn't delete this metric. Please try again.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="h-full overflow-y-auto flex flex-col gap-4 pr-1">
      {error && <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{error}</div>}

      {metrics === null && !error && <div className="text-sm text-muted">Loading&hellip;</div>}

      {metrics !== null && (
        <div className="space-y-2">
          {metrics.length === 0 && !formOpen && (
            <div className="dash-card p-6 text-center">
              <div className="text-sm text-muted leading-relaxed">
                No saved metrics yet. Define one below - e.g. "Revenue" as the sum of your amount column - and
                every dashboard KPI tile and chat answer built from it will always agree, exactly.
              </div>
            </div>
          )}
          {metrics.map((m) => (
            <div key={m.id} className="dash-card p-3 flex items-center gap-3 flex-wrap">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-sm truncate" title={m.name}>
                    {m.name}
                  </span>
                  <span className="text-xs text-muted truncate">{describeMetric(m)}</span>
                </div>
                {m.description && <div className="text-xs text-muted mt-1 truncate">{m.description}</div>}
                {m.current_value_error && (
                  <div className="text-xs text-amber-500 dark:text-amber-400 mt-1">{m.current_value_error}</div>
                )}
              </div>
              <div className="text-right shrink-0">
                <div className="text-lg font-bold tabular-nums">{formatValue(m.current_value)}</div>
                <div className="text-[10px] text-muted uppercase tracking-wide">current value</div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  className="text-xs px-2.5 py-1.5 rounded-lg text-muted hover:text-text hover:bg-surface2 transition"
                  onClick={() => startEdit(m)}
                >
                  Edit
                </button>
                {m.can_delete && (
                  <button
                    type="button"
                    className="p-1.5 rounded-lg text-muted hover:text-red-400 hover:bg-red-500/10 transition disabled:opacity-40"
                    disabled={busyId === m.id}
                    onClick={() => deleteMetric(m.id)}
                    title="Delete this metric"
                    aria-label="Delete this metric"
                  >
                    <TrashIcon />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {!formOpen ? (
        <button
          type="button"
          className="btn-secondary text-sm w-full"
          onClick={() => {
            resetForm();
            setFormOpen(true);
          }}
        >
          + New metric
        </button>
      ) : (
        <div className="dash-card p-4">
          <div className="font-semibold text-sm mb-3">{editingId ? "Edit metric" : "New metric"}</div>

          {formError && (
            <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 mb-3">
              {formError}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold text-muted mb-1.5">Name</label>
              <input className="input text-sm w-full" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Revenue" />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold text-muted mb-1.5">Description (optional)</label>
              <input
                className="input text-sm w-full"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What this metric means, for your own reference"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-muted mb-1.5">Column</label>
              {columns && columns.length > 0 ? (
                <select className="input text-sm w-full" value={column} onChange={(e) => setColumn(e.target.value)}>
                  {columns.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="text-xs text-muted py-2">{columns === null ? "Loading columns…" : "No columns found."}</div>
              )}
            </div>
            <div>
              <label className="block text-xs font-semibold text-muted mb-1.5">Aggregation</label>
              <select className="input text-sm w-full" value={agg} onChange={(e) => setAgg(e.target.value as MetricAgg)}>
                {AGG_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value} disabled={(o.value === "sum" || o.value === "avg") && numericColumns.length === 0}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {needsNumeric && column && !numericColumns.includes(column) && (
            <div className="text-[11px] text-amber-500 mt-1.5">Sum/Average need a numeric column.</div>
          )}

          <div className="mt-4 pt-3 border-t border-border">
            <label className="flex items-center gap-2 text-xs font-semibold text-muted mb-2 cursor-pointer">
              <input type="checkbox" checked={filterEnabled} onChange={(e) => setFilterEnabled(e.target.checked)} />
              Only count rows matching a filter (optional)
            </label>
            {filterEnabled && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <select className="input text-sm" value={filterColumn} onChange={(e) => setFilterColumn(e.target.value)}>
                  {(columns || []).map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                </select>
                {filterColumnIsNumeric ? (
                  <select className="input text-sm" value={filterNumberOp} onChange={(e) => setFilterNumberOp(e.target.value as FilterNumberOp)}>
                    {NUMBER_OPS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <select className="input text-sm" value={filterTextOp} onChange={(e) => setFilterTextOp(e.target.value as FilterTextOp)}>
                    {TEXT_OPS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                )}
                <input
                  className="input text-sm"
                  value={filterValue}
                  onChange={(e) => setFilterValue(e.target.value)}
                  placeholder="Value"
                />
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 mt-4">
            <button type="button" className="btn-secondary text-sm" onClick={resetForm}>
              Cancel
            </button>
            <button type="button" className="btn-primary text-sm disabled:opacity-50" disabled={saving || !name.trim() || !column} onClick={save}>
              {saving ? "Saving…" : editingId ? "Save changes" : "Create"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function TrashIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </svg>
  );
}
