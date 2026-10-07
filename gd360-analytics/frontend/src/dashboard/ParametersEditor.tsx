import { useEffect, useMemo, useState } from "react";
import { dashboardBuilderApi, type DashboardBuilderDetail, type DashboardParameter, type DashboardParameterControl } from "../api/client";
import { Button, ChevronDownIcon, ChevronUpIcon, FilterIcon, IconButton, Input, PlusIcon, Select, TrashIcon, cn } from "../ui";
import { PERIOD_LABEL, PERIODS } from "./runState";

// 2026-10-07 (Option A dashboard view, owner edit mode): the small
// "Filters" panel that defines the rail - add / remove / reorder
// parameters (column, label, control) saved through PATCH /parameters -
// and the dashboard's "Date column" + "Default period" (PATCH /{id}).
// Columns come from DashboardBuilderOut.tables (warehouse) or the
// datasource's column list the editor already fetched (file).

const CONTROLS: { value: DashboardParameterControl; label: string }[] = [
  { value: "chips", label: "Chips" },
  { value: "multi", label: "Multi-select" },
  { value: "search", label: "Search" },
  { value: "segmented", label: "Segmented" },
  { value: "checkboxes", label: "Checkboxes" },
  { value: "range", label: "Number range" },
  { value: "date_range", label: "Date range" },
];

type Draft = Partial<DashboardParameter> & { key: string };

export type ParametersEditorProps = {
  dash: DashboardBuilderDetail;
  onChange: (d: DashboardBuilderDetail) => void;
  // File sources: the datasource's columns (the canvas already has them).
  columns?: { name: string; dtype?: string }[];
  className?: string;
  // "panel" (default): a collapsible card. "sheet": the body only, always
  // open - the dashboard editor hosts it in a kit Sheet ("Filters").
  variant?: "panel" | "sheet";
  // Called after a successful save (the sheet closes itself).
  onSaved?: () => void;
};

export function ParametersEditor({ dash, onChange, columns: fileColumns, className, variant = "panel", onSaved }: ParametersEditorProps) {
  const sheet = variant === "sheet";
  const [openState, setOpen] = useState(false);
  const open = sheet || openState;
  const [drafts, setDrafts] = useState<Draft[]>(() => (dash.parameters || []).map((p, i) => ({ ...p, key: p.id || `new-${i}` })));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dateColumn, setDateColumn] = useState(dash.date_column || "");
  const [period, setPeriod] = useState(dash.default_period || "");

  useEffect(() => {
    if (!dirty) setDrafts((dash.parameters || []).map((p, i) => ({ ...p, key: p.id || `new-${i}` })));
    setDateColumn(dash.date_column || "");
    setPeriod(dash.default_period || "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dash.parameters, dash.date_column, dash.default_period]);

  const columnOptions = useMemo(() => {
    const out: { value: string; label: string; table?: string }[] = [];
    const tables = dash.tables || {};
    const tableNames = Object.keys(tables);
    if (tableNames.length) {
      for (const t of tableNames) for (const c of tables[t]) out.push({ value: tableNames.length > 1 ? `${t}::${c.name}` : c.name, label: tableNames.length > 1 ? `${t} · ${c.name}` : c.name, table: t });
    } else {
      for (const c of fileColumns || []) out.push({ value: c.name, label: c.name });
    }
    return out;
  }, [dash.tables, fileColumns]);
  const dateColumnOptions = useMemo(() => {
    const tables = dash.tables || {};
    const names = new Set<string>();
    for (const t of Object.keys(tables)) for (const c of tables[t]) if (/date|time/i.test(String(c.type || "")) || /date|time|_at$|_on$/i.test(c.name)) names.add(c.name);
    for (const c of fileColumns || []) if (/date|time/i.test(String(c.dtype || "")) || /date|time|_at$|_on$/i.test(c.name)) names.add(c.name);
    if (dash.date_column) names.add(dash.date_column);
    return Array.from(names);
  }, [dash.tables, dash.date_column, fileColumns]);

  const update = (key: string, patch: Partial<Draft>) => {
    setDrafts((ds) => ds.map((d) => (d.key === key ? { ...d, ...patch } : d)));
    setDirty(true);
  };
  const move = (idx: number, dir: -1 | 1) => {
    setDrafts((ds) => {
      const next = [...ds];
      const j = idx + dir;
      if (j < 0 || j >= next.length) return ds;
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
    setDirty(true);
  };
  const add = () => {
    setDrafts((ds) => [...ds, { key: `new-${Date.now()}`, column: "", label: "", control: "chips" }]);
    setDirty(true);
    setOpen(true);
  };
  const remove = (key: string) => {
    setDrafts((ds) => ds.filter((d) => d.key !== key));
    setDirty(true);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const payload = drafts
        .filter((d) => d.column)
        .map((d) => {
          const [table, column] = d.column!.includes("::") ? d.column!.split("::") : [d.table || undefined, d.column!];
          return { id: d.id, name: d.name, column, label: d.label || column, control: d.control || "chips", options_from: d.options_from, default: d.default, table: table || undefined };
        });
      const updated = await dashboardBuilderApi.updateParameters(dash.id, payload);
      const settings: { default_period?: string; date_column?: string } = {};
      if ((dash.default_period || "") !== period) settings.default_period = period;
      if ((dash.date_column || "") !== dateColumn) settings.date_column = dateColumn;
      const final = Object.keys(settings).length ? await dashboardBuilderApi.updateSettings(dash.id, settings) : updated;
      setDirty(false);
      onChange(final);
      onSaved?.();
    } catch (e: any) {
      setError(e?.response?.data?.detail || "Couldn't save the filters.");
    } finally {
      setBusy(false);
    }
  };

  const settingsDirty = (dash.default_period || "") !== period || (dash.date_column || "") !== dateColumn;

  return (
    <section data-parameters-editor="" className={cn(!sheet && "rounded-card border border-border bg-surface", className)}>
      {!sheet && (
        <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="ui-focus-inset flex w-full items-center justify-between gap-3 rounded-card px-4 py-3 text-left">
          <span className="inline-flex items-center gap-2 text-ui font-semibold text-text">
            <FilterIcon size={14} className="text-muted" />
            Filters
            <span className="text-caption font-normal text-muted">{drafts.length} on the rail{dash.date_column ? ` · date column ${dash.date_column}` : ""}</span>
          </span>
          <ChevronDownIcon size={14} className={cn("text-muted transition-transform", open && "rotate-180")} />
        </button>
      )}
      {open && (
        <div className={cn("flex flex-col gap-4", !sheet && "border-t border-subtle px-4 pb-4 pt-3")}>
          {error && <div role="alert" className="rounded-ctl border border-danger-border bg-danger-fill px-3 py-2 text-ui text-danger">{error}</div>}
          <div className="flex flex-col gap-2">
            {drafts.length === 0 && <div className="text-caption text-muted">No filters yet - add a column the viewer can narrow every chart by.</div>}
            {drafts.map((d, i) => (
              <div key={d.key} className="grid grid-cols-1 items-center gap-2 rounded-ctl border border-border px-3 py-2 sm:grid-cols-[1fr_1fr_160px_auto]" data-parameter-row="">
                {columnOptions.length ? (
                  <Select aria-label="Column" value={d.column || ""} onChange={(e) => update(d.key, { column: e.target.value, label: d.label || e.target.value.split("::").pop() })} size="sm">
                    <option value="">Pick a column…</option>
                    {columnOptions.map((c) => (
                      <option key={c.value} value={c.value}>{c.label}</option>
                    ))}
                  </Select>
                ) : (
                  <Input aria-label="Column" placeholder="column" mono value={d.column || ""} onChange={(e) => update(d.key, { column: e.target.value })} className="h-8 text-[13px]" />
                )}
                <Input aria-label="Label" placeholder="Label" value={d.label || ""} onChange={(e) => update(d.key, { label: e.target.value })} className="h-8 text-[13px]" />
                <Select aria-label="Control" value={d.control || "chips"} onChange={(e) => update(d.key, { control: e.target.value as DashboardParameterControl })} size="sm">
                  {CONTROLS.map((c) => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </Select>
                <span className="flex items-center gap-0.5 justify-self-end">
                  <IconButton size="sm" aria-label="Move up" icon={<ChevronUpIcon size={14} />} disabled={i === 0} onClick={() => move(i, -1)} />
                  <IconButton size="sm" aria-label="Move down" icon={<ChevronDownIcon size={14} />} disabled={i === drafts.length - 1} onClick={() => move(i, 1)} />
                  <IconButton size="sm" aria-label="Remove filter" icon={<TrashIcon size={14} />} onClick={() => remove(d.key)} />
                </span>
              </div>
            ))}
            <div>
              <Button size="sm" variant="secondary" icon={<PlusIcon size={14} />} onClick={add}>Add filter</Button>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 border-t border-subtle pt-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-caption font-medium uppercase tracking-caps text-muted">
              Date column
              {dateColumnOptions.length ? (
                <Select value={dateColumn} onChange={(e) => setDateColumn(e.target.value)} size="sm" aria-label="Date column">
                  <option value="">None</option>
                  {dateColumnOptions.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </Select>
              ) : (
                <Input value={dateColumn} onChange={(e) => setDateColumn(e.target.value)} placeholder="arrival_date" mono aria-label="Date column" className="h-8 text-[13px]" />
              )}
            </label>
            <label className="flex flex-col gap-1 text-caption font-medium uppercase tracking-caps text-muted">
              Default period
              <Select value={period} onChange={(e) => setPeriod(e.target.value)} size="sm" aria-label="Default period">
                <option value="">Month (default)</option>
                {PERIODS.map((p) => (
                  <option key={p} value={p}>{PERIOD_LABEL[p]}</option>
                ))}
              </Select>
            </label>
          </div>
          <div className="flex items-center justify-end gap-2">
            {(dirty || settingsDirty) && <span className="text-caption text-muted">Unsaved changes</span>}
            <Button size="sm" variant="primary" loading={busy} disabled={!dirty && !settingsDirty} onClick={save}>Save filters</Button>
          </div>
        </div>
      )}
    </section>
  );
}
