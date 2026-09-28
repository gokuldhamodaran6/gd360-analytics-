import { useEffect, useState } from "react";
import {
  AccessRule, AccessRuleKind, AccessRuleRole, ColumnDistinctValue, accessRulesApi, datasourceApi,
} from "../api/client";

// Phase 5, Batch B (data governance & quality - row/column permissions):
// the Access tab on Workspace.tsx (centerTab === "access") - lets a data
// source's own OWNER restrict what their workspace's "member"/"viewer"
// role tiers see of this data source's data: hide a column entirely
// ("column" rule), or restrict a column to an explicit allow-list of
// values ("row" rule). See backend models.DataAccessRule's own docstring
// for exactly what each rule does and services/data_access_rules.py for
// how it's actually enforced - every rule shown here is real and already
// being applied, never just a preview of what would happen.
//
// Owner-only, stricter than every other write on a data source's own row
// (see routers/data_access_rules.py's own module docstring) - a non-owner
// gets a 403 here, shown as a plain forbidden message with nothing else
// rendered, the same pattern Governance.tsx already uses for its own
// owner-only 403 case.
//
// The column picker reuses the datasource's own preview endpoint
// (datasourceApi.preview), the exact same approach QualityChecksPanel.tsx
// already uses for its own column picker - no new "list columns" endpoint
// was added just for this form.

function TrashIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </svg>
  );
}

function LockIcon({ className = "w-[18px] h-[18px]" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="10" width="16" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

function timeAgo(iso: string): string {
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

function ruleDescription(rule: AccessRule): string {
  if (rule.kind === "column") {
    return `Hide column "${rule.column_name}"`;
  }
  const values = rule.allowed_values || [];
  const shown = values.slice(0, 5).map((v) => String(v)).join(", ");
  return `Restrict "${rule.column_name}" to: ${shown}${values.length > 5 ? `, +${values.length - 5} more` : ""}`;
}

const ROLE_SECTIONS: { role: AccessRuleRole; label: string }[] = [
  { role: "member", label: "Member" },
  { role: "viewer", label: "Viewer" },
];

export default function AccessRulesPanel({ datasourceId }: { datasourceId: string }) {
  const [rules, setRules] = useState<AccessRule[] | null>(null);
  const [columns, setColumns] = useState<string[] | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const [formRole, setFormRole] = useState<AccessRuleRole>("viewer");
  const [formKind, setFormKind] = useState<AccessRuleKind>("column");
  const [formColumn, setFormColumn] = useState("");
  const [distinctValues, setDistinctValues] = useState<ColumnDistinctValue[] | null>(null);
  const [distinctLoading, setDistinctLoading] = useState(false);
  const [selectedValues, setSelectedValues] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState("");

  const load = () => {
    accessRulesApi
      .list(datasourceId)
      .then((data) => {
        setRules(data);
        setForbidden(false);
      })
      .catch((err: any) => {
        if (err?.response?.status === 403) {
          setForbidden(true);
        } else {
          setError("Couldn't load access rules for this data source. Please try refreshing.");
        }
      });
  };

  useEffect(() => {
    setRules(null);
    setForbidden(false);
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

  useEffect(() => {
    if (formKind !== "row" || !formColumn) {
      setDistinctValues(null);
      setSelectedValues(new Set());
      return;
    }
    setDistinctLoading(true);
    setDistinctValues(null);
    setSelectedValues(new Set());
    datasourceApi
      .getColumnDistinctValues(datasourceId, formColumn, null)
      .then((res) => setDistinctValues(res.values))
      .catch(() => setDistinctValues(null))
      .finally(() => setDistinctLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formKind, formColumn, datasourceId]);

  const toggleValue = (value: string) => {
    setSelectedValues((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  };

  const deleteRule = async (ruleId: string) => {
    if (!window.confirm("Delete this access rule? This immediately restores full visibility for that role.")) return;
    setBusyId(ruleId);
    setError("");
    try {
      await accessRulesApi.delete(datasourceId, ruleId);
      setRules((prev) => (prev || []).filter((r) => r.id !== ruleId));
    } catch {
      setError("Couldn't delete this rule. Please try again.");
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
    let allowed_values: (string | number | boolean)[] | undefined;
    if (formKind === "row") {
      if (selectedValues.size === 0) {
        setFormError("Check at least one allowed value.");
        return;
      }
      allowed_values = Array.from(selectedValues);
    }

    setCreating(true);
    try {
      const rule = await accessRulesApi.create(datasourceId, {
        role: formRole, kind: formKind, column_name: formColumn, allowed_values,
      });
      setRules((prev) => [rule, ...(prev || [])]);
      setSelectedValues(new Set());
    } catch (err: any) {
      setFormError(err?.response?.data?.detail || "Couldn't create this rule. Please try again.");
    } finally {
      setCreating(false);
    }
  };

  if (forbidden) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="dash-card p-8 text-center max-w-md">
          <div className="flex items-center justify-center gap-2 text-muted mb-2">
            <LockIcon />
          </div>
          <div className="text-sm text-muted">Only this data source's owner can manage access rules.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto flex flex-col gap-4 pr-1">
      {error && (
        <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{error}</div>
      )}

      {rules === null && !error && <div className="text-sm text-muted">Loading&hellip;</div>}

      {rules !== null && (
        <div className="space-y-4">
          {rules.length === 0 && (
            <div className="dash-card p-6 text-center">
              <div className="text-sm text-muted leading-relaxed">
                No access rules yet. Add one below to hide a column, or restrict a column to specific values, for
                your team's "Member" or "Viewer" role.
              </div>
            </div>
          )}
          {rules.length > 0 &&
            ROLE_SECTIONS.map(({ role, label }) => {
              const roleRules = rules.filter((r) => r.role === role);
              if (roleRules.length === 0) return null;
              return (
                <div key={role}>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted mb-2">{label}</h3>
                  <div className="space-y-2">
                    {roleRules.map((rule) => (
                      <div key={rule.id} className="dash-card p-3 flex items-center gap-3 flex-wrap">
                        <div className="min-w-0 flex-1">
                          <div className="text-sm truncate" title={ruleDescription(rule)}>
                            {ruleDescription(rule)}
                          </div>
                          <div className="text-xs text-muted mt-1">
                            Added by {rule.created_by_name || "someone"} &middot; {timeAgo(rule.created_at)}
                          </div>
                        </div>
                        <button
                          type="button"
                          className="p-1.5 rounded-lg text-muted hover:text-red-400 hover:bg-red-500/10 transition disabled:opacity-40 shrink-0"
                          disabled={busyId === rule.id}
                          onClick={() => deleteRule(rule.id)}
                          title="Delete this rule"
                          aria-label="Delete this rule"
                        >
                          <TrashIcon />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
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
            <label className="block text-xs font-semibold text-muted mb-1.5">Role</label>
            <select
              className="input text-sm w-full"
              value={formRole}
              onChange={(e) => setFormRole(e.target.value as AccessRuleRole)}
            >
              <option value="member">Member</option>
              <option value="viewer">Viewer</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-muted mb-1.5">Rule type</label>
            <select
              className="input text-sm w-full"
              value={formKind}
              onChange={(e) => setFormKind(e.target.value as AccessRuleKind)}
            >
              <option value="column">Hide a column</option>
              <option value="row">Restrict to specific values</option>
            </select>
          </div>

          <div className="sm:col-span-2">
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

          {formKind === "row" && (
            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold text-muted mb-1.5">Allowed values</label>
              {distinctLoading && <div className="text-xs text-muted py-2">Loading values&hellip;</div>}
              {!distinctLoading && distinctValues && distinctValues.length === 0 && (
                <div className="text-xs text-muted py-2">No values found for this column.</div>
              )}
              {!distinctLoading && distinctValues && distinctValues.length > 0 && (
                <div className="max-h-48 overflow-y-auto border border-border rounded-lg p-2 space-y-1">
                  {distinctValues.map((dv) => {
                    const value = String(dv.value);
                    return (
                      <label key={value} className="flex items-center gap-2 text-sm px-1 py-0.5 rounded hover:bg-surface2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selectedValues.has(value)}
                          onChange={() => toggleValue(value)}
                        />
                        <span className="truncate">{value}</span>
                        <span className="text-xs text-muted ml-auto shrink-0">{dv.count.toLocaleString()}</span>
                      </label>
                    );
                  })}
                </div>
              )}
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
