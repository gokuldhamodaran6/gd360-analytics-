import { useEffect, useState } from "react";
import { datasourceApi, qualityChecksApi, QualityRule, QualityRuleType } from "../api/client";

// Phase 5, Batch A (2026-09-28, "Data governance & quality" roadmap): the
// Quality Checks tab on Workspace.tsx (centerTab === "quality") - lists
// every automated check already set up on this data source's columns, with
// its most recently computed real result, plus a simple inline "New rule"
// form to add another. See backend models.DataQualityRule's own docstring
// for exactly what each rule_type checks and services/quality_checks.py for
// how a result is actually computed - every pass/fail/error pill and every
// row/failure count on this page comes straight from that real computation,
// never fabricated here.
//
// The column picker reuses the datasource's own preview endpoint
// (datasourceApi.preview) purely to read its `columns` list - no new
// "list columns" endpoint was added just for this form, matching how the
// Dashboard Builder's manual-build column picker already does the same
// thing (see DashboardBuilderDetail's own comment in api/client.ts).

const RULE_TYPE_LABELS: Record<QualityRuleType, string> = {
  not_null: "No blank values",
  unique: "All values unique",
  min_value: "At least a minimum value",
  max_value: "At most a maximum value",
  allowed_values: "Only allowed values",
};

const RULE_TYPE_OPTIONS: { value: QualityRuleType; label: string }[] = [
  { value: "not_null", label: "No blank values" },
  { value: "unique", label: "All values unique" },
  { value: "min_value", label: "At least…" },
  { value: "max_value", label: "At most…" },
  { value: "allowed_values", label: "Only allowed values" },
];

function ruleDescription(rule: QualityRule): string {
  switch (rule.rule_type) {
    case "not_null":
      return "No blank values";
    case "unique":
      return "All values unique";
    case "min_value":
      return `At least ${rule.rule_config?.min ?? "?"}`;
    case "max_value":
      return `At most ${rule.rule_config?.max ?? "?"}`;
    case "allowed_values": {
      const values = rule.rule_config?.values || [];
      const shown = values.slice(0, 3).join(", ");
      return `Only: ${shown}${values.length > 3 ? `, +${values.length - 3} more` : ""}`;
    }
    default:
      return RULE_TYPE_LABELS[rule.rule_type] || rule.rule_type;
  }
}

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function RunIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <path d="M21 3v6h-6" />
    </svg>
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

function StatusPill({ status }: { status: QualityRule["last_status"] }) {
  if (status === "pass") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full bg-green-500/10 text-green-600 dark:text-green-400">
        <span className="w-1.5 h-1.5 rounded-full bg-green-500" /> Pass
      </span>
    );
  }
  if (status === "fail") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full bg-red-500/10 text-red-500 dark:text-red-400">
        <span className="w-1.5 h-1.5 rounded-full bg-red-500" /> Fail
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400">
        <span className="w-1.5 h-1.5 rounded-full bg-amber-500" /> Error
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full bg-surface2 text-muted">
      <span className="w-1.5 h-1.5 rounded-full bg-muted" /> Not run yet
    </span>
  );
}

export default function QualityChecksPanel({ datasourceId }: { datasourceId: string }) {
  const [rules, setRules] = useState<QualityRule[] | null>(null);
  const [columns, setColumns] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const [formColumn, setFormColumn] = useState("");
  const [formType, setFormType] = useState<QualityRuleType>("not_null");
  const [formMin, setFormMin] = useState("");
  const [formMax, setFormMax] = useState("");
  const [formValues, setFormValues] = useState("");
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState("");

  const load = () => {
    qualityChecksApi
      .list(datasourceId)
      .then(setRules)
      .catch(() => setError("Couldn't load quality checks for this data source. Please try refreshing."));
  };

  useEffect(() => {
    setRules(null);
    setError("");
    load();
    datasourceApi
      .preview(datasourceId, null)
      .then((p) => setColumns(p.columns))
      .catch(() => setColumns(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasourceId]);

  useEffect(() => {
    if (columns && columns.length > 0 && !formColumn) setFormColumn(columns[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns]);

  const runRule = async (ruleId: string) => {
    setBusyId(ruleId);
    setError("");
    try {
      const updated = await qualityChecksApi.run(datasourceId, ruleId);
      setRules((prev) => (prev || []).map((r) => (r.id === ruleId ? updated : r)));
    } catch {
      setError("Couldn't re-run this check. Please try again.");
    } finally {
      setBusyId(null);
    }
  };

  const deleteRule = async (ruleId: string) => {
    if (!window.confirm("Delete this quality check? This can't be undone.")) return;
    setBusyId(ruleId);
    setError("");
    try {
      await qualityChecksApi.delete(datasourceId, ruleId);
      setRules((prev) => (prev || []).filter((r) => r.id !== ruleId));
    } catch {
      setError("Couldn't delete this check. Please try again.");
    } finally {
      setBusyId(null);
    }
  };

  const createRule = async () => {
    setFormError("");
    if (!formColumn) {
      setFormError("Pick a column first.");
      return;
    }
    let rule_config: Record<string, unknown> = {};
    if (formType === "min_value") {
      if (formMin.trim() === "" || Number.isNaN(Number(formMin))) {
        setFormError("Enter a minimum value.");
        return;
      }
      rule_config = { min: Number(formMin) };
    } else if (formType === "max_value") {
      if (formMax.trim() === "" || Number.isNaN(Number(formMax))) {
        setFormError("Enter a maximum value.");
        return;
      }
      rule_config = { max: Number(formMax) };
    } else if (formType === "allowed_values") {
      const values = formValues
        .split(",")
        .map((v) => v.trim())
        .filter((v) => v.length > 0);
      if (values.length === 0) {
        setFormError("Enter at least one allowed value, separated by commas.");
        return;
      }
      rule_config = { values };
    }

    setCreating(true);
    try {
      const rule = await qualityChecksApi.create(datasourceId, { column_name: formColumn, rule_type: formType, rule_config });
      setRules((prev) => [...(prev || []), rule]);
      setFormMin("");
      setFormMax("");
      setFormValues("");
    } catch (err: any) {
      setFormError(err?.response?.data?.detail || "Couldn't create this check. Please try again.");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto flex flex-col gap-4 pr-1">
      {error && (
        <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{error}</div>
      )}

      {rules === null && !error && <div className="text-sm text-muted">Loading&hellip;</div>}

      {rules !== null && (
        <div className="space-y-2">
          {rules.length === 0 && (
            <div className="dash-card p-6 text-center">
              <div className="text-sm text-muted leading-relaxed">
                No quality checks yet. Add one below - e.g. make sure a column is never blank, or that its
                values stay within a range you expect.
              </div>
            </div>
          )}
          {rules.map((rule) => (
            <div key={rule.id} className="dash-card p-3 flex items-center gap-3 flex-wrap">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-sm truncate" title={rule.column_name}>
                    {rule.column_name}
                  </span>
                  <span className="text-xs text-muted truncate">{ruleDescription(rule)}</span>
                </div>
                <div className="text-xs text-muted mt-1">
                  {rule.last_checked_row_count !== null ? (
                    <>
                      {rule.last_checked_row_count.toLocaleString()} row(s) checked
                      {rule.last_failing_row_count !== null ? `, ${rule.last_failing_row_count.toLocaleString()} failed` : ""}
                      {" · "}
                      {timeAgo(rule.last_run_at)}
                    </>
                  ) : (
                    "Not checked yet"
                  )}
                  {rule.last_status === "error" && rule.last_message && (
                    <span className="text-amber-500 dark:text-amber-400"> · {rule.last_message}</span>
                  )}
                </div>
              </div>
              <StatusPill status={rule.last_status} />
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  className="p-1.5 rounded-lg text-muted hover:text-text hover:bg-surface2 transition disabled:opacity-40"
                  disabled={busyId === rule.id}
                  onClick={() => runRule(rule.id)}
                  title="Run now"
                  aria-label="Run now"
                >
                  <RunIcon />
                </button>
                <button
                  type="button"
                  className="p-1.5 rounded-lg text-muted hover:text-red-400 hover:bg-red-500/10 transition disabled:opacity-40"
                  disabled={busyId === rule.id}
                  onClick={() => deleteRule(rule.id)}
                  title="Delete this check"
                  aria-label="Delete this check"
                >
                  <TrashIcon />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="dash-card p-4">
        <div className="font-semibold text-sm mb-3">New rule</div>

        {formError && (
          <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 mb-3">
            {formError}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-semibold text-muted mb-1.5">Column</label>
            {columns && columns.length > 0 ? (
              <select
                className="input text-sm w-full"
                value={formColumn}
                onChange={(e) => setFormColumn(e.target.value)}
              >
                {columns.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            ) : (
              <div className="text-xs text-muted py-2">
                {columns === null ? "Loading columns…" : "No columns found for this data source."}
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs font-semibold text-muted mb-1.5">Check</label>
            <select
              className="input text-sm w-full"
              value={formType}
              onChange={(e) => setFormType(e.target.value as QualityRuleType)}
            >
              {RULE_TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {formType === "min_value" && (
            <div>
              <label className="block text-xs font-semibold text-muted mb-1.5">Minimum value</label>
              <input
                type="number"
                className="input text-sm w-full"
                value={formMin}
                onChange={(e) => setFormMin(e.target.value)}
                placeholder="e.g. 0"
              />
            </div>
          )}
          {formType === "max_value" && (
            <div>
              <label className="block text-xs font-semibold text-muted mb-1.5">Maximum value</label>
              <input
                type="number"
                className="input text-sm w-full"
                value={formMax}
                onChange={(e) => setFormMax(e.target.value)}
                placeholder="e.g. 100"
              />
            </div>
          )}
          {formType === "allowed_values" && (
            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold text-muted mb-1.5">Allowed values (comma-separated)</label>
              <input
                className="input text-sm w-full"
                value={formValues}
                onChange={(e) => setFormValues(e.target.value)}
                placeholder="e.g. US, EU, APAC"
              />
            </div>
          )}
        </div>

        <div className="flex items-center justify-end mt-4">
          <button
            type="button"
            className="btn-primary text-sm disabled:opacity-50"
            disabled={creating || !formColumn}
            onClick={createRule}
          >
            {creating ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
