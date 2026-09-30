import { useEffect, useRef, useState } from "react";
import { datasourceApi, transformsApi, DataTransform, TransformStep, TransformPreview } from "../api/client";

// 2026-09-30 (transformation layer v1): the "Transforms" tab on
// Workspace.tsx (centerTab === "transforms") - this data source's own
// saved tables. Build a small, ordered pipeline (filter, add a derived
// column, keep only certain columns, rename a column, group + aggregate)
// here once, and that exact same derived table is what a dashboard block
// built from it (DashboardCanvas.tsx's "Use a saved table" option) and a
// chat question that names it (backend services/ai_engine.py) both use -
// see backend models.DataTransform's own docstring and
// services/transforms.py for the full design. Mirrors MetricsPanel.tsx's
// own list+inline-form structure, the established pattern for a
// data-source-scoped feature tab.
//
// A step's own "which columns can I pick from" is whatever the PRIOR
// steps' output actually looks like, not this data source's raw columns -
// see stepInputColumns below, which asks the backend's own live preview
// endpoint for exactly that (the same engine that will actually run this
// pipeline), rather than trying to predict a step's output shape
// client-side and risking it disagreeing with what services/transforms.py
// really does.

const ARITH_OPS: { value: string; label: string }[] = [
  { value: "+", label: "+" },
  { value: "-", label: "−" },
  { value: "*", label: "×" },
  { value: "/", label: "÷" },
];

const AGG_OPTIONS: { value: string; label: string }[] = [
  { value: "sum", label: "Sum" },
  { value: "avg", label: "Average" },
  { value: "count", label: "Count" },
  { value: "min", label: "Min" },
  { value: "max", label: "Max" },
];

const STEP_TYPES: { value: TransformStep["op"]; label: string }[] = [
  { value: "filter", label: "Filter rows" },
  { value: "add_column", label: "Add a derived column" },
  { value: "select_columns", label: "Keep only certain columns" },
  { value: "rename_column", label: "Rename a column" },
  { value: "group_by", label: "Group & aggregate" },
];

function blankStep(op: TransformStep["op"]): TransformStep {
  if (op === "filter") return { op, column: "", spec: { type: "text", op: "equals", value: "" } };
  if (op === "add_column") return { op, name: "", left: "", operator: "+", right_type: "value", right: "" };
  if (op === "select_columns") return { op, columns: [] };
  if (op === "rename_column") return { op, from: "", to: "" };
  return { op, by: [], aggregations: [{ column: "", agg: "sum", output_name: "" }] };
}

// Mirrors backend services/transforms.describe_transform_step exactly
// (same wording) so this panel's own summary never disagrees with the
// plain-English note the AI is actually given.
function describeStep(step: TransformStep): string | null {
  if (step.op === "filter") {
    const spec = step.spec || {};
    if (!step.column || spec.value === "" || spec.value == null) return null;
    return `Filter where ${step.column} ${spec.op || "equals"} "${spec.value}"`;
  }
  if (step.op === "add_column") {
    if (!step.name || !step.left || !step.operator) return null;
    const right = step.right_type === "column" ? step.right : step.right;
    if (right === "" || right == null) return null;
    const opLabel = ARITH_OPS.find((o) => o.value === step.operator)?.label || step.operator;
    return `Add column "${step.name}" = ${step.left} ${opLabel} ${right}`;
  }
  if (step.op === "select_columns") {
    const cols: string[] = step.columns || [];
    if (cols.length === 0) return null;
    return `Keep only: ${cols.slice(0, 6).join(", ")}${cols.length > 6 ? ` (+${cols.length - 6} more)` : ""}`;
  }
  if (step.op === "rename_column") {
    if (!step.from || !step.to) return null;
    return `Rename "${step.from}" to "${step.to}"`;
  }
  if (step.op === "group_by") {
    const by: string[] = step.by || [];
    const aggs = (step.aggregations || []).filter((a: any) => a.column && a.agg);
    if (by.length === 0 || aggs.length === 0) return null;
    const aggText = aggs
      .map((a: any) => `${AGG_OPTIONS.find((o) => o.value === a.agg)?.label || a.agg} of ${a.column}`)
      .join(", ");
    return `Group by ${by.join(", ")}, computing ${aggText}`;
  }
  return null;
}

type ColumnInfo = { name: string; dtype: string };

function isNumericDtype(dtype: string | undefined): boolean {
  return !!dtype && /int|float|double|number|decimal/i.test(dtype);
}

export default function TransformsPanel({ datasourceId }: { datasourceId: string }) {
  const [transforms, setTransforms] = useState<DataTransform[] | null>(null);
  const [columns, setColumns] = useState<ColumnInfo[] | null>(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [steps, setSteps] = useState<TransformStep[]>([]);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  // stepInputColumns[i] = the columns available to pick from when editing
  // step i - the RAW data source's columns for i===0, otherwise whatever
  // the live preview of steps[0..i) actually produced. null while loading.
  const [stepInputColumns, setStepInputColumns] = useState<(string[] | null)[]>([]);
  const [preview, setPreview] = useState<TransformPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = () => {
    transformsApi
      .list(datasourceId)
      .then(setTransforms)
      .catch(() => setError("Couldn't load saved tables for this data source. Please try refreshing."));
  };

  useEffect(() => {
    setTransforms(null);
    setError("");
    resetForm();
    load();
    datasourceApi
      .preview(datasourceId, null)
      .then((p) => setColumns(p.columns.map((c) => ({ name: c, dtype: p.dtypes?.[c] || "" }))))
      .catch(() => setColumns(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasourceId]);

  // Debounced: recompute the live full-pipeline preview AND every step's
  // own "columns available at this point" whenever the step list changes.
  useEffect(() => {
    if (!formOpen) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      runPreview();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, 400);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steps, formOpen]);

  async function runPreview() {
    setPreviewLoading(true);
    try {
      const full = await transformsApi.preview(datasourceId, steps);
      setPreview(full);
    } catch {
      setPreview({ columns: [], rows: [], row_count: 0, truncated: false, error: "Couldn't preview this pipeline." });
    }
    // Per-step input columns: raw columns for step 0, otherwise a preview
    // of everything BEFORE that step. Computed sequentially (a handful of
    // steps at most - _MAX_STEPS server-side is 20, but a real pipeline is
    // almost always 2-4) so each depends on the previous already resolving.
    const rawCols = (columns || []).map((c) => c.name);
    const next: (string[] | null)[] = [];
    for (let i = 0; i < steps.length; i++) {
      if (i === 0) {
        next.push(rawCols);
        continue;
      }
      try {
        const p = await transformsApi.preview(datasourceId, steps.slice(0, i));
        next.push(p.error ? rawCols : p.columns);
      } catch {
        next.push(rawCols);
      }
    }
    setStepInputColumns(next);
    setPreviewLoading(false);
  }

  function resetForm() {
    setEditingId(null);
    setFormOpen(false);
    setName("");
    setDescription("");
    setSteps([]);
    setPreview(null);
    setStepInputColumns([]);
    setFormError("");
  }

  function startEdit(t: DataTransform) {
    setEditingId(t.id);
    setFormOpen(true);
    setName(t.name);
    setDescription(t.description || "");
    setSteps(t.steps || []);
    setFormError("");
  }

  function updateStep(i: number, patch: Partial<TransformStep>) {
    setSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }

  function removeStep(i: number) {
    setSteps((prev) => prev.filter((_, idx) => idx !== i));
  }

  function addStep(op: TransformStep["op"]) {
    setSteps((prev) => [...prev, blankStep(op)]);
  }

  function addAggregation(stepIndex: number) {
    setSteps((prev) =>
      prev.map((s, idx) =>
        idx === stepIndex ? { ...s, aggregations: [...(s.aggregations || []), { column: "", agg: "sum", output_name: "" }] } : s
      )
    );
  }

  function updateAggregation(stepIndex: number, aggIndex: number, patch: Record<string, unknown>) {
    setSteps((prev) =>
      prev.map((s, idx) => {
        if (idx !== stepIndex) return s;
        const aggregations = (s.aggregations || []).map((a: any, ai: number) => (ai === aggIndex ? { ...a, ...patch } : a));
        return { ...s, aggregations };
      })
    );
  }

  function removeAggregation(stepIndex: number, aggIndex: number) {
    setSteps((prev) =>
      prev.map((s, idx) => {
        if (idx !== stepIndex) return s;
        return { ...s, aggregations: (s.aggregations || []).filter((_: any, ai: number) => ai !== aggIndex) };
      })
    );
  }

  const save = async () => {
    setFormError("");
    if (!name.trim()) {
      setFormError("Give this saved table a name.");
      return;
    }
    if (preview?.error) {
      setFormError(`Fix the pipeline before saving: ${preview.error}`);
      return;
    }
    setSaving(true);
    try {
      const payload = { name: name.trim(), description: description.trim() || null, steps };
      if (editingId) {
        const updated = await transformsApi.update(datasourceId, editingId, payload);
        setTransforms((prev) => (prev || []).map((t) => (t.id === editingId ? updated : t)));
      } else {
        const created = await transformsApi.create(datasourceId, payload);
        setTransforms((prev) => [...(prev || []), created].sort((a, b) => a.name.localeCompare(b.name)));
      }
      resetForm();
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      setFormError(typeof detail === "string" ? detail : "Couldn't save this table. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const deleteTransform = async (transformId: string) => {
    if (!window.confirm("Delete this saved table? Any dashboard tile or chat answer built from it will stop working.")) return;
    setBusyId(transformId);
    setError("");
    try {
      await transformsApi.delete(datasourceId, transformId);
      setTransforms((prev) => (prev || []).filter((t) => t.id !== transformId));
    } catch {
      setError("Couldn't delete this saved table. Please try again.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="h-full overflow-y-auto flex flex-col gap-4 pr-1">
      {error && <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{error}</div>}

      {transforms === null && !error && <div className="text-sm text-muted">Loading&hellip;</div>}

      {transforms !== null && (
        <div className="space-y-2">
          {transforms.length === 0 && !formOpen && (
            <div className="dash-card p-6 text-center">
              <div className="text-sm text-muted leading-relaxed">
                No saved tables yet. Build one below - e.g. "Revenue by region" filtered to completed orders and
                grouped by region - and reuse it directly on a dashboard tile or by name in chat.
              </div>
            </div>
          )}
          {transforms.map((t) => (
            <div key={t.id} className="dash-card p-3">
              <div className="flex items-start gap-3 flex-wrap">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-sm truncate" title={t.name}>
                      {t.name}
                    </span>
                    {t.preview_row_count != null && !t.preview_error && (
                      <span className="text-xs text-muted">
                        {t.preview_row_count.toLocaleString()} row{t.preview_row_count === 1 ? "" : "s"} · {t.preview_columns?.length ?? 0} column
                        {(t.preview_columns?.length ?? 0) === 1 ? "" : "s"}
                      </span>
                    )}
                  </div>
                  {t.description && <div className="text-xs text-muted mt-1">{t.description}</div>}
                  {t.step_summary.length > 0 && (
                    <ol className="text-xs text-muted mt-1.5 space-y-0.5 list-decimal list-inside">
                      {t.step_summary.map((line, i) => (
                        <li key={i}>{line}</li>
                      ))}
                    </ol>
                  )}
                  {t.preview_error && <div className="text-xs text-amber-500 dark:text-amber-400 mt-1.5">{t.preview_error}</div>}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    className="text-xs px-2.5 py-1.5 rounded-lg text-muted hover:text-text hover:bg-surface2 transition"
                    onClick={() => startEdit(t)}
                  >
                    Edit
                  </button>
                  {t.can_delete && (
                    <button
                      type="button"
                      className="p-1.5 rounded-lg text-muted hover:text-red-400 hover:bg-red-500/10 transition disabled:opacity-40"
                      disabled={busyId === t.id}
                      onClick={() => deleteTransform(t.id)}
                      title="Delete this saved table"
                      aria-label="Delete this saved table"
                    >
                      <TrashIcon />
                    </button>
                  )}
                </div>
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
          + New saved table
        </button>
      ) : (
        <div className="dash-card p-4">
          <div className="font-semibold text-sm mb-3">{editingId ? "Edit saved table" : "New saved table"}</div>

          {formError && (
            <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 mb-3">{formError}</div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold text-muted mb-1.5">Name</label>
              <input className="input text-sm w-full" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Revenue by region" />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold text-muted mb-1.5">Description (optional)</label>
              <input
                className="input text-sm w-full"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What this table represents, for your own reference"
              />
            </div>
          </div>

          <div className="space-y-3">
            {steps.map((step, i) => {
              const available = stepInputColumns[i] ?? (columns || []).map((c) => c.name);
              const numeric = (available || []).filter((name) => isNumericDtype(columns?.find((c) => c.name === name)?.dtype)) || available;
              const summary = describeStep(step);
              return (
                <div key={i} className="rounded-lg border border-border p-3 bg-surface2/40">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold text-muted">
                      Step {i + 1}: {STEP_TYPES.find((s) => s.value === step.op)?.label}
                    </span>
                    <button type="button" className="text-xs text-muted hover:text-red-400" onClick={() => removeStep(i)}>
                      Remove
                    </button>
                  </div>

                  {step.op === "filter" && (
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      <select className="input text-sm" value={step.column} onChange={(e) => updateStep(i, { column: e.target.value })}>
                        <option value="">Column…</option>
                        {available.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                      <select
                        className="input text-sm"
                        value={step.spec?.op || "equals"}
                        onChange={(e) => updateStep(i, { spec: { ...step.spec, type: "text", op: e.target.value } })}
                      >
                        <option value="equals">equals</option>
                        <option value="not_equals">does not equal</option>
                        <option value="contains">contains</option>
                        <option value="not_contains">does not contain</option>
                        <option value="starts_with">starts with</option>
                        <option value="ends_with">ends with</option>
                      </select>
                      <input
                        className="input text-sm"
                        value={step.spec?.value ?? ""}
                        onChange={(e) => updateStep(i, { spec: { ...step.spec, value: e.target.value } })}
                        placeholder="Value"
                      />
                    </div>
                  )}

                  {step.op === "add_column" && (
                    <div className="grid grid-cols-1 sm:grid-cols-5 gap-2 items-center">
                      <input
                        className="input text-sm sm:col-span-2"
                        value={step.name}
                        onChange={(e) => updateStep(i, { name: e.target.value })}
                        placeholder="New column name"
                      />
                      <select className="input text-sm" value={step.left} onChange={(e) => updateStep(i, { left: e.target.value })}>
                        <option value="">Column…</option>
                        {numeric.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                      <select className="input text-sm" value={step.operator} onChange={(e) => updateStep(i, { operator: e.target.value })}>
                        {ARITH_OPS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                      <div className="flex gap-1">
                        <select
                          className="input text-sm w-20"
                          value={step.right_type}
                          onChange={(e) => updateStep(i, { right_type: e.target.value, right: "" })}
                        >
                          <option value="value">Value</option>
                          <option value="column">Column</option>
                        </select>
                        {step.right_type === "column" ? (
                          <select className="input text-sm flex-1" value={step.right} onChange={(e) => updateStep(i, { right: e.target.value })}>
                            <option value="">…</option>
                            {numeric.map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            className="input text-sm flex-1"
                            value={step.right}
                            onChange={(e) => updateStep(i, { right: e.target.value })}
                            placeholder="Number"
                          />
                        )}
                      </div>
                    </div>
                  )}

                  {step.op === "select_columns" && (
                    <div className="flex flex-wrap gap-1.5">
                      {available.map((c) => {
                        const checked = (step.columns || []).includes(c);
                        return (
                          <label
                            key={c}
                            className={`text-xs px-2 py-1 rounded-full border cursor-pointer transition ${
                              checked ? "border-accent bg-accent/10 text-text" : "border-border text-muted hover:text-text"
                            }`}
                          >
                            <input
                              type="checkbox"
                              className="hidden"
                              checked={checked}
                              onChange={(e) => {
                                const next = e.target.checked
                                  ? [...(step.columns || []), c]
                                  : (step.columns || []).filter((x: string) => x !== c);
                                updateStep(i, { columns: next });
                              }}
                            />
                            {c}
                          </label>
                        );
                      })}
                    </div>
                  )}

                  {step.op === "rename_column" && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <select className="input text-sm" value={step.from} onChange={(e) => updateStep(i, { from: e.target.value })}>
                        <option value="">Column…</option>
                        {available.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                      <input className="input text-sm" value={step.to} onChange={(e) => updateStep(i, { to: e.target.value })} placeholder="New name" />
                    </div>
                  )}

                  {step.op === "group_by" && (
                    <div className="space-y-2">
                      <div>
                        <div className="text-[11px] text-muted mb-1">Group by</div>
                        <div className="flex flex-wrap gap-1.5">
                          {available.map((c) => {
                            const checked = (step.by || []).includes(c);
                            return (
                              <label
                                key={c}
                                className={`text-xs px-2 py-1 rounded-full border cursor-pointer transition ${
                                  checked ? "border-accent bg-accent/10 text-text" : "border-border text-muted hover:text-text"
                                }`}
                              >
                                <input
                                  type="checkbox"
                                  className="hidden"
                                  checked={checked}
                                  onChange={(e) => {
                                    const next = e.target.checked ? [...(step.by || []), c] : (step.by || []).filter((x: string) => x !== c);
                                    updateStep(i, { by: next });
                                  }}
                                />
                                {c}
                              </label>
                            );
                          })}
                        </div>
                      </div>
                      <div>
                        <div className="text-[11px] text-muted mb-1">Aggregate</div>
                        <div className="space-y-1.5">
                          {(step.aggregations || []).map((a: any, ai: number) => (
                            <div key={ai} className="grid grid-cols-1 sm:grid-cols-4 gap-1.5 items-center">
                              <select
                                className="input text-sm"
                                value={a.column}
                                onChange={(e) => updateAggregation(i, ai, { column: e.target.value })}
                              >
                                <option value="">Column…</option>
                                {available.map((c) => (
                                  <option key={c} value={c}>
                                    {c}
                                  </option>
                                ))}
                              </select>
                              <select className="input text-sm" value={a.agg} onChange={(e) => updateAggregation(i, ai, { agg: e.target.value })}>
                                {AGG_OPTIONS.map((o) => (
                                  <option key={o.value} value={o.value}>
                                    {o.label}
                                  </option>
                                ))}
                              </select>
                              <input
                                className="input text-sm"
                                value={a.output_name}
                                onChange={(e) => updateAggregation(i, ai, { output_name: e.target.value })}
                                placeholder={`${a.agg}_${a.column || "column"}`}
                              />
                              <button type="button" className="text-xs text-muted hover:text-red-400 justify-self-start" onClick={() => removeAggregation(i, ai)}>
                                Remove
                              </button>
                            </div>
                          ))}
                        </div>
                        <button type="button" className="text-xs text-accent hover:underline mt-1.5" onClick={() => addAggregation(i)}>
                          + Add aggregation
                        </button>
                      </div>
                    </div>
                  )}

                  {summary && <div className="text-[11px] text-muted mt-2 italic">{summary}</div>}
                </div>
              );
            })}
          </div>

          <div className="flex flex-wrap gap-1.5 mt-3">
            {STEP_TYPES.map((s) => (
              <button
                key={s.value}
                type="button"
                className="text-xs px-2.5 py-1.5 rounded-lg border border-border text-muted hover:text-text hover:bg-surface2 transition"
                onClick={() => addStep(s.value)}
              >
                + {s.label}
              </button>
            ))}
          </div>

          <div className="mt-4 pt-3 border-t border-border">
            <div className="text-xs font-semibold text-muted mb-1.5">Preview</div>
            {previewLoading && <div className="text-xs text-muted">Computing…</div>}
            {!previewLoading && preview?.error && (
              <div className="text-xs text-amber-500 dark:text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
                {preview.error}
              </div>
            )}
            {!previewLoading && preview && !preview.error && (
              <div className="text-xs text-muted overflow-x-auto">
                <div className="mb-1.5">
                  {preview.row_count.toLocaleString()} row{preview.row_count === 1 ? "" : "s"}
                  {preview.truncated ? " (showing a preview)" : ""} · {preview.columns.length} column{preview.columns.length === 1 ? "" : "s"}
                </div>
                {preview.rows.length > 0 && (
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr>
                        {preview.columns.map((c) => (
                          <th key={c} className="border-b border-border py-1 pr-3 font-semibold whitespace-nowrap">
                            {c}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.slice(0, 5).map((row, ri) => (
                        <tr key={ri}>
                          {preview.columns.map((c) => (
                            <td key={c} className="border-b border-border/50 py-1 pr-3 whitespace-nowrap">
                              {row[c] === null || row[c] === undefined ? "—" : String(row[c])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
            {!previewLoading && !preview && steps.length === 0 && (
              <div className="text-xs text-muted">Add a step below, or save with no steps to save the data as-is.</div>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 mt-4">
            <button type="button" className="btn-secondary text-sm" onClick={resetForm}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary text-sm disabled:opacity-50"
              disabled={saving || !name.trim() || previewLoading || !!preview?.error}
              onClick={save}
            >
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
