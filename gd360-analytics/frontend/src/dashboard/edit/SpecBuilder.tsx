import { useEffect, useMemo, useRef, useState } from "react";
import type { BlockSpec, BlockSpecFilter, BlockSpecMeasure, DashboardBlock } from "../../api/client";
import { Button, CloseIcon, Field, IconButton, Input, NumberInput, PlusIcon, Select, Sheet, Switch, WarningIcon, cn } from "../../ui";
import { describeSpec, PERIOD_LABEL, PERIODS } from "../runState";
import { columnKind, type EditorColumn } from "./AskAiSheet";

// 2026-10-07 (dashboard edit mode): "Edit query..." for a warehouse block -
// a form over the block's BlockSpec, exactly the grammar
// backend/app/services/query_builder.py validates (validate_block_spec)
// and nothing else:
//   table      one of the dashboard's tables
//   measures   {agg, column | expr, alias}   count sum avg min max count_distinct
//   group_by   column names
//   time       {column, grain}               day week month quarter year
//   filters    {column, op, value}           the BLOCK_OPS vocabulary
//   order_by   {by, dir}                     a measure alias, a group-by column, or "period"
//   limit      1..5000
//   compare_prior_period / sparkline         KPI tiles
// Saving posts the spec to POST /blocks/{id}/spec; the backend dry-runs it
// in the warehouse first, and a 400's message (the warehouse's own) is
// shown beside the form with the sheet left open.

type Agg = BlockSpecMeasure["agg"];
type Grain = NonNullable<BlockSpec["time"]>["grain"];

const AGGS: { value: Agg; label: string }[] = [
  { value: "count", label: "Count" },
  { value: "sum", label: "Sum" },
  { value: "avg", label: "Average" },
  { value: "min", label: "Min" },
  { value: "max", label: "Max" },
  { value: "count_distinct", label: "Count distinct" },
];

// The operators offered, each one in query_builder.BLOCK_OPS.
type OpKind = "single" | "list" | "pair" | "none";
const OPS: { value: string; label: string; kind: OpKind; for?: ("number" | "date" | "text" | "boolean")[] }[] = [
  { value: "=", label: "is", kind: "single" },
  { value: "!=", label: "is not", kind: "single" },
  { value: ">", label: "greater than", kind: "single", for: ["number", "date"] },
  { value: ">=", label: "at least", kind: "single", for: ["number", "date"] },
  { value: "<", label: "less than", kind: "single", for: ["number", "date"] },
  { value: "<=", label: "at most", kind: "single", for: ["number", "date"] },
  { value: "between", label: "between", kind: "pair", for: ["number", "date"] },
  { value: "in", label: "is one of", kind: "list" },
  { value: "contains", label: "contains", kind: "single", for: ["text"] },
  { value: "not_contains", label: "does not contain", kind: "single", for: ["text"] },
  { value: "starts_with", label: "starts with", kind: "single", for: ["text"] },
  { value: "ends_with", label: "ends with", kind: "single", for: ["text"] },
  { value: "is_true", label: "is true", kind: "none", for: ["boolean"] },
  { value: "is_false", label: "is false", kind: "none", for: ["boolean"] },
  { value: "is_null", label: "is blank", kind: "none" },
  { value: "is_not_null", label: "is not blank", kind: "none" },
];
// In the grammar but not offered as a choice; shown as-is when a spec already uses one.
const OTHER_OPS: Record<string, OpKind> = { in_or_null: "list", equals_ci: "single", not_equals_ci: "single", is_empty: "none", is_not_empty: "none" };

const MAX_MEASURES = 4;
const MAX_GROUP_BY = 2;
const MAX_LIMIT = 5000;
const DEFAULT_LIMIT = 1000;
const ALIAS_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

type MeasureDraft = { key: string; agg: Agg; column: string; expr: string; custom: boolean; alias: string; aliasTouched: boolean };
type FilterDraft = { key: string; column: string; op: string; value: string; value2: string };
type Draft = {
  table: string;
  measures: MeasureDraft[];
  groupBy: string[];
  timeOn: boolean;
  timeColumn: string;
  grain: Grain;
  filters: FilterDraft[];
  sortBy: string;
  sortDir: "asc" | "desc";
  extraOrder: { by: string; dir: "asc" | "desc" }[];
  limit: number | null;
  comparePrior: boolean;
  sparkline: boolean;
};

let keySeq = 0;
const nextKey = () => `k${++keySeq}`;

export function defaultAlias(agg: Agg, column: string | null, custom: boolean): string {
  if (custom) return `${agg}_expr`;
  if (agg === "count" && !column) return "count";
  const safe = (column || "").replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "value";
  return `${agg}_${safe}`;
}

function opKind(op: string): OpKind {
  return OPS.find((o) => o.value === op)?.kind ?? OTHER_OPS[op] ?? "single";
}

function valueToText(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v);
}

export function specToDraft(spec: BlockSpec | null | undefined, tables: string[], blockType: string): Draft {
  const table = spec?.table && tables.includes(spec.table) ? spec.table : tables[0] || "";
  const measures: MeasureDraft[] = (spec?.measures?.length ? spec.measures : [{ alias: "count", agg: "count" as Agg, column: null }]).map((m) => {
    const custom = Boolean(m.expr);
    const column = m.column || "";
    const alias = m.alias || defaultAlias(m.agg, column || null, custom);
    return { key: nextKey(), agg: m.agg, column, expr: m.expr || "", custom, alias, aliasTouched: alias !== defaultAlias(m.agg, column || null, custom) };
  });
  const order = spec?.order_by || [];
  const kpi = blockType === "kpi" || blockType === "gauge";
  return {
    table,
    measures,
    groupBy: [...(spec?.group_by || [])],
    timeOn: Boolean(spec?.time),
    timeColumn: spec?.time?.column || "",
    grain: spec?.time?.grain || "month",
    filters: (spec?.filters || []).map((f) => {
      const kind = opKind(f.op);
      const arr = Array.isArray(f.value) ? f.value : [];
      return {
        key: nextKey(), column: f.column, op: f.op,
        value: kind === "list" ? arr.map(valueToText).join(", ") : kind === "pair" ? valueToText(arr[0]) : valueToText(f.value),
        value2: kind === "pair" ? valueToText(arr[1]) : "",
      };
    }),
    sortBy: order[0]?.by || "",
    sortDir: order[0]?.dir || "desc",
    extraOrder: order.slice(1),
    limit: typeof spec?.limit === "number" ? spec.limit : DEFAULT_LIMIT,
    comparePrior: spec ? Boolean(spec.compare_prior_period) : kpi,
    sparkline: spec ? Boolean(spec.sparkline) : kpi,
  };
}

function coerce(text: string, kind: "number" | "date" | "text" | "boolean"): string | number | boolean {
  const t = text.trim();
  if (kind === "number" && t !== "" && Number.isFinite(Number(t))) return Number(t);
  if (kind === "boolean" && /^(true|false)$/i.test(t)) return t.toLowerCase() === "true";
  return t;
}

export function draftToSpec(draft: Draft, columns: EditorColumn[], blockType: string): BlockSpec {
  const kindOf = (name: string) => columns.find((c) => c.name === name)?.kind ?? "text";
  const kpi = blockType === "kpi" || blockType === "gauge";
  const measures: BlockSpecMeasure[] = draft.measures.map((m) => {
    const alias = (m.alias || defaultAlias(m.agg, m.column || null, m.custom)).trim();
    if (m.custom) return { alias, agg: m.agg, column: null, expr: m.expr.trim() };
    return { alias, agg: m.agg, column: m.column || null, expr: null };
  });
  const groupBy = kpi ? [] : draft.groupBy.filter(Boolean);
  const time = !kpi && draft.timeOn && draft.timeColumn ? { column: draft.timeColumn, grain: draft.grain } : null;
  const filters: BlockSpecFilter[] = draft.filters
    .filter((f) => f.column)
    .map((f) => {
      const kind = opKind(f.op);
      const k = kindOf(f.column);
      if (kind === "none") return { column: f.column, op: f.op, value: null };
      if (kind === "list") return { column: f.column, op: f.op, value: f.value.split(",").map((s) => s.trim()).filter(Boolean).map((s) => coerce(s, k)) };
      if (kind === "pair") return { column: f.column, op: f.op, value: [coerce(f.value, k), coerce(f.value2, k)] };
      const text = /^(contains|not_contains|starts_with|ends_with|equals_ci|not_equals_ci)$/.test(f.op);
      return { column: f.column, op: f.op, value: text ? f.value : coerce(f.value, k) };
    });
  const sortable = new Set<string>([...groupBy, ...measures.map((m) => m.alias), ...(time ? ["period"] : [])]);
  const order_by = kpi
    ? []
    : [...(draft.sortBy && sortable.has(draft.sortBy) ? [{ by: draft.sortBy, dir: draft.sortDir }] : []), ...draft.extraOrder.filter((o) => sortable.has(o.by) && o.by !== draft.sortBy)].slice(0, 3);
  return {
    table: draft.table,
    time,
    group_by: groupBy,
    measures,
    filters,
    order_by,
    limit: Math.max(1, Math.min(MAX_LIMIT, Math.round(draft.limit ?? DEFAULT_LIMIT))),
    compare_prior_period: draft.comparePrior,
    sparkline: draft.sparkline,
  };
}

// What stops this draft from being saved (the backend would reject it
// too); null when it can be sent.
export function draftProblem(draft: Draft, blockType: string): string | null {
  if (!draft.table) return "Pick a table.";
  const aliases = new Set<string>();
  for (const m of draft.measures) {
    if (m.custom && !m.expr.trim()) return "Write the custom expression, or switch it off.";
    if (!m.custom && m.agg !== "count" && !m.column) return `${AGGS.find((a) => a.value === m.agg)?.label || m.agg} needs a column.`;
    const alias = m.alias.trim();
    if (!ALIAS_RE.test(alias)) return `The name "${alias}" must be letters, digits and underscores, starting with a letter.`;
    if (aliases.has(alias) || alias === "period" || draft.groupBy.includes(alias)) return `The name "${alias}" is used twice.`;
    aliases.add(alias);
  }
  for (const f of draft.filters) {
    if (!f.column) return "Pick a column for every filter, or remove it.";
    const kind = opKind(f.op);
    if (kind === "single" && f.value.trim() === "") return `The filter on ${f.column} needs a value.`;
    if (kind === "list" && f.value.split(",").every((s) => !s.trim())) return `The filter on ${f.column} needs at least one value.`;
    if (kind === "pair" && (f.value.trim() === "" || f.value2.trim() === "")) return `The filter on ${f.column} needs two values.`;
  }
  const kpi = blockType === "kpi" || blockType === "gauge";
  if (draft.timeOn && !kpi && !draft.timeColumn) return "Pick the date column to bucket by, or switch time off.";
  const shaped = draft.groupBy.some(Boolean) || (draft.timeOn && Boolean(draft.timeColumn));
  if (!kpi && !shaped && (blockType === "chart" || blockType === "donut" || blockType === "avatar_list" || blockType === "sparkline")) {
    return "A chart needs a group-by column or a time bucket.";
  }
  return null;
}

function SectionLabel({ children, hint }: { children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <div className="text-caption font-medium uppercase tracking-caps text-muted">{children}</div>
      {hint && <div className="text-caption text-faint">{hint}</div>}
    </div>
  );
}

export function SpecBuilder({
  block, tables, columnsOf, onSave, onCancel, provider, initialError, title,
}: {
  block: DashboardBlock;
  tables: string[];
  columnsOf: (table: string) => EditorColumn[];
  onSave: (spec: BlockSpec) => Promise<void>;
  onCancel: () => void;
  provider?: string | null;
  initialError?: string | null;
  // The sheet's title (the block's name).
  title: string;
}) {
  const [draft, setDraft] = useState<Draft>(() => specToDraft(block.config?.spec, tables, block.type));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setDraft(specToDraft(block.config?.spec, tables, block.type));
    setError(initialError ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [block.id]);

  const columns = useMemo(() => columnsOf(draft.table), [columnsOf, draft.table]);
  const kpi = block.type === "kpi" || block.type === "gauge";
  const numeric = columns.filter((c) => c.kind === "number");
  const dates = columns.filter((c) => c.kind === "date");
  const spec = useMemo(() => draftToSpec(draft, columns, block.type), [draft, columns, block.type]);
  const problem = draftProblem(draft, block.type);
  const sortable = [...(spec.time ? [{ value: "period", label: "Period" }] : []), ...(spec.group_by || []).map((g) => ({ value: g, label: g })), ...spec.measures.map((m) => ({ value: m.alias, label: m.alias }))];

  const patch = (p: Partial<Draft>) => { setDraft((d) => ({ ...d, ...p })); setError(null); };
  const patchMeasure = (key: string, p: Partial<MeasureDraft>) =>
    patch({
      measures: draft.measures.map((m) => {
        if (m.key !== key) return m;
        const next = { ...m, ...p };
        if (p.alias !== undefined) next.aliasTouched = true;
        // The name follows the pick until the person names it themselves.
        if (!next.aliasTouched) next.alias = defaultAlias(next.agg, next.column || null, next.custom);
        return next;
      }),
    });
  const patchFilter = (key: string, p: Partial<FilterDraft>) => patch({ filters: draft.filters.map((f) => (f.key === key ? { ...f, ...p } : f)) });

  // Columns an aggregation makes sense on: sum / average need a number;
  // min / max a number or a date; the two counts take anything.
  const columnsFor = (agg: Agg): EditorColumn[] => (agg === "sum" || agg === "avg" ? numeric : agg === "min" || agg === "max" ? columns.filter((c) => c.kind === "number" || c.kind === "date") : columns);

  const changeTable = (table: string) => {
    const cols = new Set(columnsOf(table).map((c) => c.name));
    patch({
      table,
      measures: draft.measures.map((m) => (m.custom || !m.column || cols.has(m.column) ? m : { ...m, column: "", alias: m.aliasTouched ? m.alias : defaultAlias(m.agg, null, false) })),
      groupBy: draft.groupBy.filter((g) => cols.has(g)),
      timeColumn: cols.has(draft.timeColumn) ? draft.timeColumn : "",
      filters: draft.filters.filter((f) => cols.has(f.column)),
    });
  };

  const save = async () => {
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(spec);
    } catch (e: any) {
      const detail = e?.response?.data?.detail;
      setError(typeof detail === "string" && detail.trim() ? detail : "This query couldn't be saved.");
      setTimeout(() => errorRef.current?.scrollIntoView?.({ block: "nearest" }), 0);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open
      onClose={busy ? () => undefined : onCancel}
      persistent={busy}
      title={title}
      subtitle={`Edit query${provider ? ` · ${provider}` : ""}`}
      size="md"
      id="edit-query"
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button type="submit" form="spec-builder-form" variant="primary" loading={busy} disabled={Boolean(problem)} data-spec-save="">
            {busy ? "Checking in the warehouse…" : "Save query"}
          </Button>
        </>
      }
    >
    <form
      id="spec-builder-form"
      data-spec-builder=""
      className="flex flex-col gap-5"
      onSubmit={(e) => { e.preventDefault(); save(); }}
    >
      <Field label="Table" id="spec-table">
        <Select value={draft.table} onChange={(e) => changeTable(e.target.value)} data-spec-table="" disabled={busy}>
          {tables.length === 0 && <option value="">No tables on this data source</option>}
          {tables.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </Select>
      </Field>

      <section className="flex flex-col gap-2" data-spec-measures="">
        <SectionLabel hint={`${draft.measures.length} of ${Math.max(MAX_MEASURES, draft.measures.length)}`}>Measures</SectionLabel>
        {draft.measures.map((m, i) => {
          const options = columnsFor(m.agg);
          return (
            <div key={m.key} data-spec-measure="" className="flex flex-col gap-2 rounded-ctl border border-border p-2.5">
              <div className="flex items-center gap-2">
                <div className="w-[148px] shrink-0">
                  <Select aria-label={`Aggregation ${i + 1}`} value={m.agg} disabled={busy} onChange={(e) => {
                    const agg = e.target.value as Agg;
                    const ok = columnsFor(agg).some((c) => c.name === m.column);
                    patchMeasure(m.key, { agg, column: ok ? m.column : "" });
                  }}>
                    {AGGS.map((a) => (
                      <option key={a.value} value={a.value}>{a.label}</option>
                    ))}
                  </Select>
                </div>
                <div className="min-w-0 flex-1">
                  {m.custom ? (
                    <Input aria-label={`Expression ${i + 1}`} mono value={m.expr} disabled={busy} placeholder={numeric.length >= 2 ? `${numeric[0].name} * ${numeric[1].name}` : "column_a * column_b"} onChange={(e) => patchMeasure(m.key, { expr: e.target.value })} />
                  ) : (
                    <Select aria-label={`Column ${i + 1}`} value={m.column} disabled={busy} onChange={(e) => patchMeasure(m.key, { column: e.target.value })}>
                      <option value="">{m.agg === "count" ? "All rows" : "Pick a column…"}</option>
                      {options.map((c) => (
                        <option key={c.name} value={c.name}>{c.name}</option>
                      ))}
                    </Select>
                  )}
                </div>
                <IconButton size="sm" className="shrink-0" aria-label={`Remove measure ${i + 1}`} icon={<CloseIcon size={14} />} disabled={busy || draft.measures.length <= 1} onClick={() => patch({ measures: draft.measures.filter((x) => x.key !== m.key) })} />
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <label className="flex min-w-[180px] flex-1 items-center gap-2 text-caption text-muted">
                  <span className="shrink-0">Named</span>
                  <Input aria-label={`Name ${i + 1}`} mono value={m.alias} disabled={busy} className="h-8" invalid={!ALIAS_RE.test(m.alias.trim())} onChange={(e) => patchMeasure(m.key, { alias: e.target.value })} />
                </label>
                <Switch
                  checked={m.custom}
                  disabled={busy}
                  onChange={(custom) => patchMeasure(m.key, { custom, column: custom ? "" : m.column, expr: custom ? m.expr || m.column : m.expr })}
                  label={<span className="text-caption text-secondary">Custom expression</span>}
                />
              </div>
              {m.custom && <div className="text-caption text-muted">Column names, numbers, + − × ÷ and parentheses - no functions.</div>}
            </div>
          );
        })}
        {draft.measures.length < MAX_MEASURES && (
          <div>
            <Button variant="ghost" className="h-8 px-2 text-caption" icon={<PlusIcon size={13} />} disabled={busy} onClick={() => patch({ measures: [...draft.measures, { key: nextKey(), agg: "count", column: "", expr: "", custom: false, alias: uniqueAlias("count", draft.measures), aliasTouched: false }] })}>
              Add a measure
            </Button>
          </div>
        )}
      </section>

      {!kpi && (
        <section className="flex flex-col gap-2" data-spec-group="">
          <SectionLabel hint="up to 2 columns">Group by</SectionLabel>
          {Array.from({ length: Math.max(MAX_GROUP_BY, draft.groupBy.length) }, (_, i) => {
            if (i > 0 && !draft.groupBy[i - 1]) return null;
            const value = draft.groupBy[i] || "";
            return (
              <Select key={i} aria-label={`Group by ${i + 1}`} value={value} disabled={busy} onChange={(e) => {
                const next = [...draft.groupBy];
                if (e.target.value) next[i] = e.target.value;
                else next.splice(i, 1);
                patch({ groupBy: next.filter(Boolean) });
              }}>
                <option value="">{i === 0 ? "No grouping" : "No second column"}</option>
                {columns.filter((c) => c.name === value || !draft.groupBy.includes(c.name)).map((c) => (
                  <option key={c.name} value={c.name}>{c.name}</option>
                ))}
              </Select>
            );
          })}
        </section>
      )}

      {!kpi && (
        <section className="flex flex-col gap-2" data-spec-time="">
          <SectionLabel>Time</SectionLabel>
          <Switch
            checked={draft.timeOn}
            disabled={busy}
            onChange={(timeOn) => patch({ timeOn, timeColumn: timeOn ? draft.timeColumn || dates[0]?.name || "" : draft.timeColumn })}
            label={<span className="text-ui text-text">Bucket by a date column</span>}
          />
          {draft.timeOn && (
            <>
              <div className="grid grid-cols-[minmax(0,1fr)_130px] gap-2">
                <Select aria-label="Date column" value={draft.timeColumn} disabled={busy} onChange={(e) => patch({ timeColumn: e.target.value })}>
                  <option value="">Pick a date column…</option>
                  {(dates.length ? dates : columns).map((c) => (
                    <option key={c.name} value={c.name}>{c.name}</option>
                  ))}
                </Select>
                <Select aria-label="Grain" value={draft.grain} disabled={busy} onChange={(e) => patch({ grain: e.target.value as Grain })}>
                  {PERIODS.map((p) => (
                    <option key={p} value={p}>{PERIOD_LABEL[p]}</option>
                  ))}
                </Select>
              </div>
              <div className="text-caption text-muted">The page's Day · Week · Month · Year control replaces this grain while the dashboard is viewed.</div>
            </>
          )}
        </section>
      )}

      {kpi && (
        <section className="flex flex-col gap-2.5" data-spec-kpi="">
          <SectionLabel>On the tile</SectionLabel>
          <Switch checked={draft.comparePrior} disabled={busy} onChange={(comparePrior) => patch({ comparePrior })} label={<span className="text-ui text-text">Compare with the prior period</span>} />
          <Switch checked={draft.sparkline} disabled={busy} onChange={(sparkline) => patch({ sparkline })} label={<span className="text-ui text-text">Show a sparkline</span>} />
        </section>
      )}

      <section className="flex flex-col gap-2" data-spec-filters="">
        <SectionLabel hint="always applied to this block">Filters</SectionLabel>
        {draft.filters.map((f, i) => {
          const col = columns.find((c) => c.name === f.column);
          const kind = col?.kind ?? "text";
          const ops = OPS.filter((o) => !o.for || o.for.includes(kind) || o.value === f.op);
          const known = ops.some((o) => o.value === f.op);
          const ok = opKind(f.op);
          return (
            <div key={f.key} data-spec-filter="" className="flex flex-col gap-2 rounded-ctl border border-border p-2.5">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <Select aria-label={`Filter column ${i + 1}`} value={f.column} disabled={busy} onChange={(e) => {
                    const k = columnKind(columns.find((c) => c.name === e.target.value)?.type, e.target.value);
                    const stillOk = OPS.some((o) => o.value === f.op && (!o.for || o.for.includes(k)));
                    patchFilter(f.key, { column: e.target.value, op: stillOk ? f.op : k === "boolean" ? "is_true" : "=" });
                  }}>
                    <option value="">Pick a column…</option>
                    {columns.map((c) => (
                      <option key={c.name} value={c.name}>{c.name}</option>
                    ))}
                  </Select>
                </div>
                <div className="w-[160px] shrink-0">
                  <Select aria-label={`Filter operator ${i + 1}`} value={f.op} disabled={busy} onChange={(e) => patchFilter(f.key, { op: e.target.value })}>
                    {!known && <option value={f.op}>{f.op.replace(/_/g, " ")}</option>}
                    {ops.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </Select>
                </div>
                <IconButton size="sm" className="shrink-0" aria-label={`Remove filter ${i + 1}`} icon={<CloseIcon size={14} />} disabled={busy} onClick={() => patch({ filters: draft.filters.filter((x) => x.key !== f.key) })} />
              </div>
              {ok !== "none" && (
                <div className={cn("grid gap-2", ok === "pair" ? "grid-cols-2" : "grid-cols-1")}>
                  <Input
                    aria-label={`Filter value ${i + 1}`}
                    value={f.value}
                    disabled={busy}
                    type={kind === "date" && ok !== "list" ? "date" : "text"}
                    inputMode={kind === "number" && ok !== "list" ? "decimal" : undefined}
                    placeholder={ok === "list" ? "Values, separated by commas" : ok === "pair" ? "From" : "Value"}
                    onChange={(e) => patchFilter(f.key, { value: e.target.value })}
                  />
                  {ok === "pair" && (
                    <Input aria-label={`Filter second value ${i + 1}`} value={f.value2} disabled={busy} type={kind === "date" ? "date" : "text"} inputMode={kind === "number" ? "decimal" : undefined} placeholder="To" onChange={(e) => patchFilter(f.key, { value2: e.target.value })} />
                  )}
                </div>
              )}
            </div>
          );
        })}
        <div>
          <Button variant="ghost" className="h-8 px-2 text-caption" icon={<PlusIcon size={13} />} disabled={busy || columns.length === 0} onClick={() => patch({ filters: [...draft.filters, { key: nextKey(), column: "", op: "=", value: "", value2: "" }] })}>
            Add a filter
          </Button>
        </div>
      </section>

      {!kpi && (
        <section className="flex flex-col gap-2" data-spec-sort="">
          <SectionLabel>Sort and limit</SectionLabel>
          <div className="grid grid-cols-[minmax(0,1fr)_130px_110px] gap-2">
            <Select aria-label="Sort by" value={sortable.some((s) => s.value === draft.sortBy) ? draft.sortBy : ""} disabled={busy} onChange={(e) => patch({ sortBy: e.target.value })}>
              <option value="">{spec.time ? "Default (oldest first)" : (spec.group_by || []).length ? "Default (largest first)" : "Default"}</option>
              {sortable.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </Select>
            <Select aria-label="Sort direction" value={draft.sortDir} disabled={busy || !draft.sortBy} onChange={(e) => patch({ sortDir: e.target.value as "asc" | "desc" })}>
              <option value="desc">Descending</option>
              <option value="asc">Ascending</option>
            </Select>
            <NumberInput aria-label="Row limit" value={draft.limit} min={1} max={MAX_LIMIT} disabled={busy} unit="rows" onChange={(limit) => patch({ limit })} />
          </div>
        </section>
      )}

      <div className="rounded-ctl border border-border bg-subtle px-3 py-2.5" data-spec-sentence="">
        <div className="text-caption font-medium uppercase tracking-caps text-muted">This block computes</div>
        <div className="mt-1 break-words text-ui text-text">{describeSpec(spec) || "Nothing yet."}</div>
        {provider && <div className="mt-1 text-caption text-muted">In {provider}, over every row.</div>}
      </div>

      {(error || problem) && (
        <div
          ref={errorRef}
          role={error ? "alert" : "status"}
          data-spec-error={error ? "" : undefined}
          data-spec-problem={!error ? "" : undefined}
          className={cn("flex items-start gap-2 rounded-ctl border px-3 py-2.5 text-ui", error ? "border-danger-border bg-danger-fill text-danger" : "border-border bg-surface text-secondary")}
        >
          <WarningIcon size={14} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{error || problem}</span>
        </div>
      )}

    </form>
    </Sheet>
  );
}

function uniqueAlias(base: string, measures: MeasureDraft[]): string {
  const taken = new Set(measures.map((m) => m.alias));
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}_${i}`)) i++;
  return `${base}_${i}`;
}
