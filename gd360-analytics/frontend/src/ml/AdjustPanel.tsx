// 2026-10-09 (round 15): ML Studio's "Adjust plan" panel, built from the
// chosen kind's `fields` (GET /ml-studio/types): pick a column, several
// columns, a value of another column, a number, a word, a list of words or
// a scenario ({driver: % change}). Required inputs are checked before the
// plan is made again; the backend's own checks come back as plain text.
import { useId, useMemo, useState } from "react";
import type { ProblemType, Spec, StudioTable, TypeField } from "../api/mlStudio";

const SELECT = "h-9 w-full min-w-0 rounded-ctl border border-border bg-base px-2.5 text-ui text-text";
const INPUT = "h-9 w-full min-w-0 rounded-ctl border border-border bg-base px-2.5 text-ui text-text placeholder:text-faint";
const GRAINS = ["day", "week", "month", "quarter"];

type Props = {
  spec: Spec;
  type: ProblemType | undefined;
  tables: StudioTable[];
  /** columns of the data as planned (joined columns included) */
  planColumns: string[] | null;
  /** example values per column (from the plan's label or the join preview) */
  valuesOf: (column: string) => string[];
  joined: boolean;
  busy: boolean;
  onApply: (s: Spec) => void;
  onCancel: () => void;
};

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return false;
}

export default function AdjustPanel({ spec, type, tables, planColumns, valuesOf, joined, busy, onApply, onCancel }: Props) {
  const [s, setS] = useState<Spec>(spec);
  const [missing, setMissing] = useState<string[]>([]);
  const sameTable = s.source_id === spec.source_id && s.table === spec.table;
  const t = tables.find((x) => x.source_id === s.source_id && x.table === s.table) || tables.find((x) => x.source_id === s.source_id);
  const cols = useMemo(() => (sameTable && planColumns?.length ? planColumns : (t?.columns || []).map((c) => c.name)), [sameTable, planColumns, t]);
  const fields: TypeField[] = type?.fields || [];
  const set = (key: string, v: unknown) => {
    setS((cur) => ({ ...cur, [key]: v }));
    setMissing((m) => m.filter((k) => k !== key));
  };
  const chosenCols = new Set(
    fields.filter((f) => f.type === "column").map((f) => s[f.key]).filter((v): v is string => typeof v === "string" && !!v),
  );

  const apply = () => {
    const miss = fields.filter((f) => f.required && isEmpty(s[f.key])).map((f) => f.key);
    setMissing(miss);
    if (miss.length) return;
    onApply(s);
  };

  return (
    <div className="rounded-card border border-border-strong bg-base p-3.5 flex flex-col gap-3.5 min-w-0" aria-label="Adjust the plan">
      {joined ? (
        <p className="m-0 text-caption text-muted leading-snug">
          Main table: <span className="text-text">{spec.table}</span> with {spec.joins?.length || 0} joined table{(spec.joins?.length || 0) === 1 ? "" : "s"} - change them with “Change tables”.
        </p>
      ) : (
        <Field label="Table">
          {(id) => (
            <select
              id={id}
              className={SELECT}
              value={`${s.source_id}::${s.table}`}
              onChange={(e) => {
                const [sid, tb] = e.target.value.split("::");
                const cleared: Spec = { ...s, source_id: sid, table: tb, exclude: [] };
                for (const f of fields) if (f.type === "column" || f.type === "columns" || f.type === "value" || f.type === "scenario") cleared[f.key] = null;
                cleared.exclude = [];
                setS(cleared);
                setMissing([]);
              }}
            >
              {tables.map((x) => (
                <option key={`${x.source_id}::${x.table}`} value={`${x.source_id}::${x.table}`}>
                  {x.source} · {x.table}
                </option>
              ))}
            </select>
          )}
        </Field>
      )}

      {fields.map((f) => (
        <FieldEditor
          key={f.key}
          f={f}
          value={s[f.key]}
          spec={s}
          cols={cols}
          chosen={chosenCols}
          valuesOf={valuesOf}
          invalid={missing.includes(f.key)}
          onChange={(v) => set(f.key, v)}
        />
      ))}

      {missing.length > 0 && (
        <p role="alert" className="m-0 text-caption text-danger">
          Fill in {fields.filter((f) => missing.includes(f.key)).map((f) => f.label.toLowerCase()).join(", ")} first.
        </p>
      )}
      <div className="flex gap-2 flex-wrap">
        <button type="button" className="btn-primary text-sm" onClick={apply} disabled={busy}>Update the plan</button>
        <button type="button" className="btn-secondary text-sm" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function Field({ label, hint, required, invalid, children }: { label: string; hint?: string; required?: boolean; invalid?: boolean; children: (id: string) => React.ReactNode }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <label htmlFor={id} className={`text-caption ${invalid ? "text-danger" : "text-secondary"}`}>
        {label}
        {required && <span className="text-muted"> · required</span>}
      </label>
      {children(id)}
      {hint && <span className="text-[11px] text-muted leading-snug">{hint}</span>}
    </div>
  );
}

function FieldEditor({
  f,
  value,
  spec,
  cols,
  chosen,
  valuesOf,
  invalid,
  onChange,
}: {
  f: TypeField;
  value: unknown;
  spec: Spec;
  cols: string[];
  chosen: Set<string>;
  valuesOf: (c: string) => string[];
  invalid: boolean;
  onChange: (v: unknown) => void;
}) {
  const ring = invalid ? " !border-danger" : "";
  if (f.type === "column") {
    return (
      <Field label={f.label} hint={f.hint} required={f.required} invalid={invalid}>
        {(id) => (
          <select id={id} className={SELECT + ring} value={(value as string) || ""} onChange={(e) => onChange(e.target.value || null)}>
            <option value="">{f.required ? "Pick a column…" : "None"}</option>
            {cols.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        )}
      </Field>
    );
  }
  if (f.type === "columns") {
    const list = Array.isArray(value) ? (value as string[]) : [];
    const leaveOut = f.key === "exclude";
    const options = cols.filter((c) => !chosen.has(c));
    return (
      <fieldset className="m-0 p-0 border-0 flex flex-col gap-1.5 min-w-0">
        <legend className={`text-caption mb-1 ${invalid ? "text-danger" : "text-secondary"}`}>
          {f.label}
          {f.required && <span className="text-muted"> · required</span>}
          {list.length > 0 && <span className="text-muted"> · {list.length} chosen</span>}
        </legend>
        <div className="flex flex-wrap gap-1.5 max-h-[168px] overflow-y-auto pr-1">
          {options.map((c) => {
            const on = list.includes(c);
            return (
              <button
                key={c}
                type="button"
                aria-pressed={on}
                onClick={() => onChange(on ? list.filter((x) => x !== c) : [...list, c])}
                className={`h-7 max-w-full truncate px-2 rounded-md border text-caption ${
                  on ? (leaveOut ? "border-danger-border bg-danger-fill text-danger line-through" : "text-text") : "border-border text-secondary hover:text-text"
                }`}
                style={on && !leaveOut ? { borderColor: "rgb(var(--auto-do-border))", background: "rgb(var(--auto-do-fill))" } : undefined}
              >
                {c}
              </button>
            );
          })}
          {!options.length && <span className="text-caption text-muted">No columns to choose from.</span>}
        </div>
        {f.hint && <span className="text-[11px] text-muted leading-snug">{f.hint}</span>}
      </fieldset>
    );
  }
  if (f.type === "value") {
    const of = f.of ? (spec[f.of] as string | null) : null;
    const opts = of ? valuesOf(of) : [];
    return (
      <Field label={f.label} hint={of ? `A value of ${of}${opts.length ? "" : " - type it exactly as it appears"}` : `Pick ${f.of ? f.of.replace(/_/g, " ") : "the column"} first`} required={f.required} invalid={invalid}>
        {(id) =>
          opts.length > 0 && opts.length <= 40 ? (
            <select id={id} className={SELECT + ring} value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value || null)} disabled={!of}>
              <option value="">{f.required ? "Pick a value…" : "Let GD360 decide"}</option>
              {opts.map((o) => (
                <option key={o} value={o}>{o}</option>
              ))}
              {typeof value === "string" && value && !opts.includes(value) && <option value={value}>{value}</option>}
            </select>
          ) : (
            <input id={id} className={INPUT + ring} value={(value as string) ?? ""} disabled={!of} placeholder={of ? "e.g. yes" : ""} onChange={(e) => onChange(e.target.value || null)} />
          )
        }
      </Field>
    );
  }
  if (f.type === "number") {
    return (
      <Field label={f.label} hint={f.hint} required={f.required} invalid={invalid}>
        {(id) => (
          <input
            id={id}
            type="number"
            inputMode="decimal"
            step="any"
            className={INPUT + ring}
            value={value === null || value === undefined ? "" : String(value)}
            placeholder="Automatic"
            onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
          />
        )}
      </Field>
    );
  }
  if (f.type === "text") {
    if (f.key === "grain") {
      // the label lists the periods this kind accepts, e.g. "day / week / month"
      const listed = f.label.split("/").map((x) => x.trim().toLowerCase()).filter((x) => GRAINS.includes(x));
      const grains = listed.length ? listed : GRAINS;
      return (
        <Field label="Period" hint={f.hint} required={f.required} invalid={invalid}>
          {(id) => (
            <select id={id} className={SELECT + ring} value={(value as string) || ""} onChange={(e) => onChange(e.target.value || null)}>
              <option value="">Automatic</option>
              {grains.map((g) => (
                <option key={g} value={g}>{g}</option>
              ))}
            </select>
          )}
        </Field>
      );
    }
    return (
      <Field label={f.label} hint={f.hint} required={f.required} invalid={invalid}>
        {(id) => <input id={id} className={INPUT + ring} value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value || null)} />}
      </Field>
    );
  }
  if (f.type === "list") {
    return <ListEditor f={f} value={Array.isArray(value) ? (value as string[]) : []} invalid={invalid} onChange={onChange} />;
  }
  if (f.type === "scenario") {
    const drivers = Array.isArray(spec.drivers) && spec.drivers.length ? (spec.drivers as string[]) : cols.filter((c) => !chosen.has(c));
    return <ScenarioEditor f={f} value={(value as Record<string, number>) || {}} drivers={drivers} invalid={invalid} onChange={onChange} />;
  }
  return null;
}

function ListEditor({ f, value, invalid, onChange }: { f: TypeField; value: string[]; invalid: boolean; onChange: (v: unknown) => void }) {
  const [draft, setDraft] = useState("");
  const id = useId();
  const add = () => {
    const parts = draft.split(",").map((x) => x.trim()).filter(Boolean);
    if (!parts.length) return;
    onChange(Array.from(new Set([...value, ...parts])));
    setDraft("");
  };
  return (
    <div className="flex flex-col gap-1.5 min-w-0">
      <label htmlFor={id} className={`text-caption ${invalid ? "text-danger" : "text-secondary"}`}>
        {f.label}
        {f.required && <span className="text-muted"> · required</span>}
      </label>
      {value.length > 0 && (
        <ul className="m-0 p-0 list-none flex flex-wrap gap-1.5">
          {value.map((v) => (
            <li key={v} className="inline-flex items-center gap-1 h-7 pl-2 pr-1 rounded-md border border-border bg-surface text-caption text-text max-w-full">
              <span className="truncate">{v}</span>
              <button type="button" aria-label={`Remove ${v}`} className="w-5 h-5 grid place-items-center rounded text-muted hover:text-danger" onClick={() => onChange(value.filter((x) => x !== v))}>
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                  <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <input
          id={id}
          className={INPUT + (invalid ? " !border-danger" : "")}
          value={draft}
          placeholder="Type a word and press Enter"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className="btn-secondary text-sm !py-0 h-9 shrink-0" onClick={add} disabled={!draft.trim()}>
          Add
        </button>
      </div>
      {f.hint && <span className="text-[11px] text-muted leading-snug">{f.hint.replace(/^default:/, "If empty:")}</span>}
    </div>
  );
}

function ScenarioEditor({ f, value, drivers, invalid, onChange }: { f: TypeField; value: Record<string, number>; drivers: string[]; invalid: boolean; onChange: (v: unknown) => void }) {
  const entries = Object.entries(value);
  const free = drivers.filter((d) => !(d in value));
  const put = (next: [string, number][]) => onChange(next.length ? Object.fromEntries(next) : null);
  return (
    <fieldset className="m-0 p-0 border-0 flex flex-col gap-2 min-w-0">
      <legend className={`text-caption mb-1 ${invalid ? "text-danger" : "text-secondary"}`}>
        {f.label}
        {f.required && <span className="text-muted"> · required</span>}
      </legend>
      {entries.map(([col, pct], i) => (
        <div key={col} className="grid grid-cols-[minmax(0,1fr)_92px_28px] gap-2 items-center">
          <select
            aria-label="Driver"
            className={SELECT}
            value={col}
            onChange={(e) => put(entries.map(([c, p], j) => (j === i ? [e.target.value, p] : [c, p])) as [string, number][])}
          >
            <option value={col}>{col}</option>
            {free.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
          <span className="relative">
            <input
              aria-label={`Change in ${col}, percent`}
              type="number"
              step="any"
              inputMode="decimal"
              className={`${INPUT} pr-6 text-right font-mono`}
              value={Number.isFinite(pct) ? String(pct) : ""}
              onChange={(e) => put(entries.map(([c, p], j) => (j === i ? [c, e.target.value === "" ? 0 : Number(e.target.value)] : [c, p])) as [string, number][])}
            />
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-caption text-muted pointer-events-none">%</span>
          </span>
          <button type="button" aria-label={`Remove ${col} from the scenario`} className="w-7 h-7 grid place-items-center rounded text-muted hover:text-danger" onClick={() => put(entries.filter((_, j) => j !== i))}>
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      ))}
      {free.length > 0 && (
        <button type="button" className="self-start text-caption underline text-secondary hover:text-text" onClick={() => put([...entries, [free[0], 10]])}>
          + Add a driver change
        </button>
      )}
      <span className="text-[11px] text-muted leading-snug">20 means +20%, -5 means 5% lower. Empty = a 10% rise in the first driver.</span>
    </fieldset>
  );
}
