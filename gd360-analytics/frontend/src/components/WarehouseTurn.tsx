// 2026-10-06 (warehouse-honesty round). For a warehouse/database data
// source (BigQuery, Snowflake, Postgres, MySQL, SQL Server, Supabase,
// MongoDB) a chat question is either computed INSIDE the warehouse over
// every row, or it is not answered at all - the app never falls back to
// analyzing a row-capped sample. This file holds every piece of UI that
// expresses that rule, shared by the chat transcript (ChatPanel.tsx) and
// the Chart tab (Workspace.tsx) so both tell exactly the same story:
//
//   - the success side: the "Computed in {Provider} · all N rows" badge,
//     the 3-step "what happened" trace, the "SQL that ran" block, the
//     Chart tab's exact-n pill / result header / "how this was calculated"
//     footer;
//   - the honest failure side: the NeedsQueryHelpCard - an amber "no
//     answer yet" banner, the deterministic "finish it yourself" query
//     builder (SQL kinds only - the backend owns the SQL, this form only
//     ever sends a structured QueryBuilderSpec), "write the SQL myself",
//     and the list of what was tried.
//
// Every number shown here is a real field from backend
// schemas.ChatResponse (see api/client.ts WarehouseTurnFields) - nothing
// is estimated or invented client-side. The visual language is the app's
// own (index.css tokens via the primary/accent/muted/border/surface
// Tailwind colors, plus the same amber-500 tint SelfCritiqueNote and the
// Data tab's "loaded rows" caveat already use); no new colors or fonts.
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  BuilderColumns, ChatFinishRequest, PushdownAttempt, PushdownSkippedReason,
  QueryBuilderAgg, QueryBuilderFilter, QueryBuilderOp, QueryBuilderSpec, SAVE_AS_TABLE_PROMPT,
} from "../api/client";
import { connectionKindMeta } from "./DataSourceForm";

// The data source kinds the warehouse rule applies to - mirrors backend
// routers/chat.py PUSHDOWN_ELIGIBLE_KINDS exactly.
export const WAREHOUSE_KINDS = ["bigquery", "snowflake", "postgres", "mysql", "sqlserver", "supabase", "mongodb"];
// The kinds the deterministic query builder can write SQL for - mirrors
// backend services/query_builder.py SQL_KINDS (MongoDB is deliberately
// absent: the builder is SQL-only).
export const BUILDER_KINDS = ["bigquery", "snowflake", "postgres", "mysql", "sqlserver", "supabase"];
// Only these providers bill per scanned byte, so only they get the
// "failed attempts are validated for free, never billed" footer clause
// and a "Scanned X MB" figure (the backend sends bytes only for them).
const METERED_KINDS = ["bigquery", "snowflake"];

// Short provider names, matching the backend's own _PROVIDER_LABELS
// ("Computed in BigQuery", not "Computed in Google BigQuery") - the long
// connectionKindMeta label is only the fallback for an unknown kind.
const SHORT_LABELS: Record<string, string> = {
  bigquery: "BigQuery", snowflake: "Snowflake", postgres: "Postgres", mysql: "MySQL",
  sqlserver: "SQL Server", supabase: "Supabase", mongodb: "MongoDB",
};
export function providerLabel(kind?: string | null): string {
  if (!kind) return "your warehouse";
  return SHORT_LABELS[kind] || connectionKindMeta(kind).label;
}

export function formatBytes(bytes?: number | null): string | null {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return null;
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
  const mb = bytes / 1024 ** 2;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  if (bytes === 0) return "0 MB";
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function formatSeconds(ms?: number | null): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

const fmtInt = (n: number) => n.toLocaleString();

// {table: [{name, type}]} from a data source's own schema_cache - the
// client-side twin of backend services/query_builder.builder_columns, used
// when a conversation is reopened (the messages endpoint deliberately does
// not repeat builder_columns per message - see api/client.ts). Tolerates
// every schema_cache shape the app has: SQL/BigQuery ({table: [{name,
// type}]}), MongoDB ({collection: ["field", ...]}) and the single-table
// {columns: [...]} form.
export function builderColumnsFromSchema(
  schemaCache: Record<string, unknown> | null | undefined,
  scopeTables?: string[] | null,
): BuilderColumns {
  const out: BuilderColumns = {};
  if (!schemaCache || typeof schemaCache !== "object") return out;
  const names = scopeTables && scopeTables.length
    ? scopeTables.filter((t) => t in schemaCache)
    : Object.keys(schemaCache);
  for (const t of names) {
    const raw = (schemaCache as Record<string, unknown>)[t];
    if (!Array.isArray(raw)) continue;
    const cols: { name: string; type: string | null }[] = [];
    for (const c of raw) {
      if (c && typeof c === "object" && (c as any).name != null) {
        cols.push({ name: String((c as any).name), type: (c as any).type ?? null });
      } else if (typeof c === "string") {
        cols.push({ name: c, type: null });
      }
    }
    if (cols.length) out[t] = cols;
  }
  return out;
}

// --- Success side -----------------------------------------------------------

export const AGG_LABELS: Record<QueryBuilderAgg, string> = {
  count: "Count", sum: "Sum", avg: "Average", min: "Minimum", max: "Maximum", count_distinct: "Count distinct",
};
const OP_LABELS: Record<QueryBuilderOp, string> = {
  "=": "=", "!=": "≠", ">": ">", ">=": "≥", "<": "<", "<=": "≤",
  is_null: "is empty", is_not_null: "is not empty", in: "is one of",
};
const NULL_OPS: QueryBuilderOp[] = ["is_null", "is_not_null"];

// The plain-words preview of what a builder spec will run - deliberately
// NOT SQL (the backend owns the SQL; this is the one honest thing the
// frontend can promise about the query without writing it). Also sent as
// the `prompt` of the finish request, so the conversation's own user
// message reads like a question, e.g. "Sum of adr by arrival_date_year
// where is_canceled = 0".
export function describeBuilderSpec(spec: QueryBuilderSpec): string {
  const what = spec.agg === "count" && !spec.measure
    ? "Count of rows"
    : `${AGG_LABELS[spec.agg] || spec.agg} of ${spec.measure || "…"}`;
  let text = what;
  if (spec.group_by.length) text += ` by ${spec.group_by.join(", ")}`;
  const parts = spec.filters
    .filter((f) => f.column)
    .map((f) => {
      if (NULL_OPS.includes(f.op)) return `${f.column} ${f.op === "is_null" ? "is empty" : "is not empty"}`;
      if (f.op === "in") {
        const vals = Array.isArray(f.value) ? f.value : f.value != null && f.value !== "" ? [f.value] : [];
        return `${f.column} in (${vals.join(", ")})`;
      }
      return `${f.column} ${f.op} ${f.value ?? ""}`;
    });
  if (parts.length) text += ` where ${parts.join(" and ")}`;
  return text;
}

// The "✓ Computed in BigQuery · all 119,386 rows" pill. Exported so
// ChatPanel's PushdownBadge and the Chart tab render the identical thing.
export function ComputedInBadge({
  provider, exactTotalRows, className = "", variant = "answer",
}: {
  provider?: string | null;
  exactTotalRows?: number | null;
  className?: string;
  // 2026-10-06 ("generated data is a saved query" layer): "table" for a
  // saved-query table turn - "Built as a saved query in BigQuery · 75,166
  // rows" (exactTotalRows is then the new table's own exact COUNT(*)).
  variant?: "answer" | "table";
}) {
  const label = providerLabel(provider);
  if (variant === "table") {
    return (
      <span
        className={`inline-flex items-center gap-1 text-[10px] font-bold px-2.5 py-1 rounded-full bg-primary/10 text-primary ${className}`}
        title="This table is a SQL definition stored by GD360 and run inside your warehouse whenever it is used - no rows were copied out."
      >
        &#10003; Built as a saved query in {label}{exactTotalRows != null ? ` · ${fmtInt(exactTotalRows)} rows` : ""}
      </span>
    );
  }
  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] font-bold px-2.5 py-1 rounded-full bg-primary/10 text-primary ${className}`}
      title="This answer came from one real query run inside your connected source over every row - no sample was loaded."
    >
      &#10003; Computed in {label} · {exactTotalRows != null ? `all ${fmtInt(exactTotalRows)} rows` : "every row"}
    </span>
  );
}

// The Chart tab's own "n = 119,386 rows · exact · ran in BigQuery" pill
// next to the chart title.
export function ExactRowsPill({ provider, exactTotalRows }: { provider?: string | null; exactTotalRows?: number | null }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-full bg-primary/10 text-primary tabular-nums shrink-0"
      title="The query ran over the full table inside your warehouse - this is not a sample."
    >
      <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden />
      {exactTotalRows != null ? `n = ${fmtInt(exactTotalRows)} rows · exact` : "every row"} · ran in {providerLabel(provider)}
    </span>
  );
}

// The compact 3-step "what happened" list under a warehouse-computed
// answer - same numbered-step shape as the approved mockup; every figure
// is a real response field, and a figure the provider does not report
// (bytes for Postgres, say) is simply left out, never faked.
export function WarehouseTrace({
  provider, bytesScanned, durationMs, resultRows, variant = "answer",
}: {
  provider?: string | null;
  bytesScanned?: number | null;
  durationMs?: number | null;
  resultRows?: number | null;
  // 2026-10-06 ("generated data is a saved query" layer): "table" for a
  // saved-query table turn - the three steps then describe a definition
  // that was validated, saved and counted, not an answer that was run.
  variant?: "answer" | "table";
}) {
  const label = providerLabel(provider);
  const bytes = formatBytes(bytesScanned);
  const secs = formatSeconds(durationMs);
  const ranDetail = [bytes, secs].filter(Boolean).join(" · ");
  const steps = variant === "table" ? [
    <><strong>Wrote one query</strong> that defines the new table.</>,
    <><strong>Saved it as a query, not a copy.</strong> Nothing was downloaded — {label} runs it whenever this table is used{ranDetail ? ` (${ranDetail} to validate and count)` : ""}.</>,
    <>
      <strong>{resultRows != null ? `${fmtInt(resultRows)} row${resultRows === 1 ? "" : "s"} counted` : "Row count pending"}</strong>
      {" "}— {resultRows != null ? "an exact COUNT(*) inside your warehouse; the rows themselves never left it." : "it will appear once the Data tab profiles the table."}
    </>,
  ] : [
    <><strong>Wrote one SQL query</strong> from your question.</>,
    <><strong>Ran it inside {label}</strong>{ranDetail ? ` — ${ranDetail}` : ""}.</>,
    <>
      <strong>{resultRows != null ? `${fmtInt(resultRows)} row${resultRows === 1 ? "" : "s"} came back` : "Only the result came back"}</strong>
      {" "}— the table itself never left your warehouse.
    </>,
  ];
  return (
    <ol className="warehouse-trace mt-1.5 space-y-1.5 text-[11px] text-text/80 list-none m-0 p-0">
      {steps.map((s, i) => (
        <li key={i} className="flex items-start gap-2">
          <span className="shrink-0 h-4 w-4 rounded-full bg-primary text-white text-[9px] font-bold flex items-center justify-center mt-px">
            {i + 1}
          </span>
          <span>{s}</span>
        </li>
      ))}
    </ol>
  );
}

// Clipboard copy with the execCommand fallback for browsers/contexts that
// block navigator.clipboard - called INSIDE the click handler so the user
// gesture is still live either way.
function copyText(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text);
  }
  return new Promise<void>((resolve, reject) => {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand && document.execCommand("copy");
      ta.remove();
      ok ? resolve() : reject(new Error("copy failed"));
    } catch (e) {
      reject(e);
    }
  });
}

// The monospace "SQL that ran in {Provider}" block with a Copy button -
// collapsed by default in the chat bubble, expanded (defaultOpen) in the
// Chart tab's calculation area. For MongoDB the "SQL" is the JSON
// {collection, pipeline} the backend ran; the label says so.
export function SqlThatRan({
  sql, provider, defaultOpen = false, label, maxHeightClass = "", action,
}: {
  sql: string;
  provider?: string | null;
  defaultOpen?: boolean;
  label?: string;
  maxHeightClass?: string;
  // 2026-10-06 ("generated data is a saved query" layer): an optional
  // extra control rendered before Copy - the generated-table Data tab's
  // "Edit & re-run" link next to a saved query's Definition. Omitted
  // everywhere else, so the existing block renders exactly as before.
  action?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [copied, setCopied] = useState(false);
  const heading = label || (provider === "mongodb" ? `Pipeline that ran in ${providerLabel(provider)}` : `SQL that ran in ${providerLabel(provider)}`);
  const copy = () => {
    copyText(sql)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        // The text stays fully visible and selectable; a blocked clipboard
        // is a soft failure.
      });
  };
  return (
    <div className="sql-that-ran mt-1.5 rounded-xl border border-border bg-surface2/60 overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-border">
        <button
          type="button"
          className="text-[11px] text-muted hover:text-text font-medium flex items-center gap-1 min-w-0"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          <span className={`inline-block transition-transform ${open ? "rotate-90" : ""}`}>&#9656;</span>
          <span className="truncate">{heading}</span>
        </button>
        {action ? (
          <span className="flex items-center gap-3 shrink-0">
            {action}
            <button
              type="button"
              className="text-[11px] text-accent hover:opacity-80 font-medium shrink-0"
              onClick={copy}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="text-[11px] text-accent hover:opacity-80 font-medium shrink-0"
            onClick={copy}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        )}
      </div>
      {open && (
        <pre className={`m-0 px-3 py-2 text-[11px] leading-relaxed font-mono text-text/90 whitespace-pre-wrap break-words overflow-auto ${maxHeightClass}`}>
          {sql}
        </pre>
      )}
    </div>
  );
}

// Client-side CSV of the (already-aggregated) result rows - the only data
// GD360 ever received for a warehouse turn, so "Download CSV (N rows)" is
// honest about what it hands over.
export function downloadRowsAsCsv(
  columns: { name: string }[],
  rows: Record<string, unknown>[],
  filename = "gd360-result.csv",
) {
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = columns.map((c) => esc(c.name)).join(",");
  const body = rows.map((r) => columns.map((c) => esc(r[c.name])).join(",")).join("\n");
  const blob = new Blob([`${header}\n${body}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

// The Chart tab's "Result · 3 rows · this is the only data GD360 received"
// block with the CSV download and a compact preview of those rows.
// 2026-10-07 (chart-integrity round): a fractional number is shown rounded
// and grouped ("5,171,503.51"), with the exact value on hover and in the
// CSV - a SUM of doubles otherwise prints its floating-point noise
// ("5171503.509999998") right under a chart that says 5.17M. Whole numbers
// (years, ids, counts) and text are printed exactly as before.
function resultCellText(v: unknown): string {
  if (typeof v === "number" && Number.isFinite(v) && !Number.isInteger(v)) {
    return v.toLocaleString("en-US", { maximumFractionDigits: Math.abs(v) >= 100 ? 2 : 4 });
  }
  return String(v ?? "");
}
function resultCellTitle(v: unknown): string | undefined {
  return typeof v === "number" && Number.isFinite(v) && !Number.isInteger(v) ? String(v) : undefined;
}

export function WarehouseResultTable({
  columns, rows, resultRows, truncated,
}: {
  columns: { name: string }[];
  rows: Record<string, unknown>[];
  resultRows?: number | null;
  truncated?: boolean;
}) {
  const n = resultRows ?? rows.length;
  return (
    <div className="warehouse-result rounded-xl border border-border bg-surface2/60 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 border-b border-border">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="text-[12px] font-semibold">Result</span>
          <span className="text-[11px] text-muted truncate">
            {fmtInt(n)} row{n === 1 ? "" : "s"} · this is the only data GD360 received
            {/* 2026-10-07: a pandas step after the query (a pivot, a
                shift) can reshape those rows - say so, instead of a "6
                rows" caption sitting on a 3-row table. */}
            {!truncated && rows.length > 0 && rows.length !== n ? ` · shown as the ${fmtInt(rows.length)}-row table the chart is drawn from` : ""}
          </span>
        </div>
        <button
          type="button"
          className="text-[11px] px-2.5 py-1 rounded-lg btn-secondary font-medium shrink-0"
          disabled={!columns.length || !rows.length}
          onClick={() => downloadRowsAsCsv(columns, rows)}
        >
          Download CSV ({fmtInt(rows.length)} row{rows.length === 1 ? "" : "s"})
        </button>
      </div>
      {columns.length > 0 && rows.length > 0 ? (
        <div className="overflow-auto max-h-40">
          <table className="w-full text-[11px] border-collapse tabular-nums">
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c.name} className="text-left px-3 py-1 border-b border-border text-muted font-medium font-mono sticky top-0 bg-surface2">
                    {c.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 50).map((r, ri) => (
                <tr key={ri} className="border-b border-border/50">
                  {columns.map((c) => (
                    <td key={c.name} className="px-3 py-1 text-text/80" title={resultCellTitle(r[c.name])}>{resultCellText(r[c.name])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {(truncated || rows.length > 50) && (
            <div className="text-[10px] text-muted px-3 py-1">Showing the first rows only.</div>
          )}
        </div>
      ) : (
        <div className="text-[11px] text-muted px-3 py-2">No rows to show.</div>
      )}
    </div>
  );
}

// "How this was calculated: one query, run where the data lives · Scanned
// 28.6 MB · 1.2 s" - the Chart tab's footer line.
export function WarehouseFooter({
  bytesScanned, durationMs,
}: {
  bytesScanned?: number | null;
  durationMs?: number | null;
}) {
  const bytes = formatBytes(bytesScanned);
  const secs = formatSeconds(durationMs);
  return (
    <div className="warehouse-footer flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted px-0.5">
      <span><span className="font-medium text-text/80">How this was calculated:</span> one query, run where the data lives</span>
      {bytes && <><span>·</span><span>Scanned {bytes}</span></>}
      {secs && <><span>·</span><span>{secs}</span></>}
    </div>
  );
}

// --- Failure side: the "no sample, ever" card -------------------------------

const ATTEMPT_STATUS_LABELS: Record<string, (provider: string, error: string | null) => string> = {
  rejected_unsafe: () => "Rejected as unsafe",
  rejected_too_expensive: () => "Too expensive to run",
  error: (provider, error) => `${provider}: ${error || "the query failed"}`,
  not_possible: () => "The AI could not map this question to the table",
  needs_table: () => "This asks for a new table, not a summary",
  generation_failed: () => "The SQL writer failed",
  ok: () => "Ran",
  validated: () => "Validated and saved as the table's definition",
};

export function attemptStatusLabel(attempt: PushdownAttempt, provider?: string | null): string {
  const fn = ATTEMPT_STATUS_LABELS[attempt.status];
  if (fn) return fn(providerLabel(provider), attempt.error);
  return attempt.error || attempt.status;
}

const SKIPPED_REASON_LINES: Record<PushdownSkippedReason, string> = {
  daily_budget: "Nothing was tried: today's warehouse query budget for your account is already used up.",
  empty_schema: "Nothing was tried: this data source's table and column list is not available yet.",
  restricted_role: "Nothing was tried: your access to this source is limited by row/column rules, which cannot be applied inside the warehouse.",
  unsupported_selection: "Nothing was tried: this selection mixes in a saved table or another data source, which cannot be queried inside the warehouse.",
  needs_table: "Nothing was run: this asks for a new table of rows, not a summary.",
  not_possible: "Nothing was run: the AI could not map this question to the table.",
  table_failed: "No table was created: no safe definition for it could be written and validated inside the warehouse.",
};

export function AttemptsList({
  attempts, skippedReason, provider,
}: {
  attempts?: PushdownAttempt[] | null;
  skippedReason?: PushdownSkippedReason | null;
  provider?: string | null;
}) {
  const list = attempts || [];
  return (
    <div className="warehouse-attempts rounded-xl border border-border overflow-hidden">
      <div className="px-3 py-1.5 border-b border-border text-[11px] font-semibold bg-surface2/60">What was tried</div>
      {list.length === 0 ? (
        <div className="px-3 py-2 text-[11px] text-muted">
          {skippedReason && SKIPPED_REASON_LINES[skippedReason]
            ? SKIPPED_REASON_LINES[skippedReason]
            : "No query was attempted."}
        </div>
      ) : (
        <div>
          {list.map((a, i) => (
            <div key={i} className={`flex items-start gap-2.5 px-3 py-2 ${i < list.length - 1 ? "border-b border-border/50" : ""}`}>
              <span className="shrink-0 text-[10px] font-bold text-amber-500 bg-amber-500/10 rounded-md px-1.5 py-0.5 mt-px">
                Attempt {i + 1}
              </span>
              <div className="min-w-0 flex-1 space-y-1">
                {a.sql ? (
                  <code className="block font-mono text-[11px] text-text/90 whitespace-pre-wrap break-words">{a.sql}</code>
                ) : (
                  <span className="block text-[11px] text-muted italic">No query was written.</span>
                )}
                <div className="text-[11px] text-amber-500">{attemptStatusLabel(a, provider)}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// --- The deterministic query builder form -----------------------------------

type FilterDraft = { column: string; op: QueryBuilderOp; value: string };

const AGG_OPTIONS: QueryBuilderAgg[] = ["count", "sum", "avg", "min", "max", "count_distinct"];
const OP_OPTIONS: QueryBuilderOp[] = ["=", "!=", ">", ">=", "<", "<=", "is_null", "is_not_null", "in"];

function filterToDraft(f: QueryBuilderFilter): FilterDraft {
  const value = Array.isArray(f.value) ? f.value.join(", ") : f.value == null ? "" : String(f.value);
  return { column: f.column, op: f.op, value };
}

function draftToFilter(d: FilterDraft): QueryBuilderFilter {
  if (NULL_OPS.includes(d.op)) return { column: d.column, op: d.op, value: null };
  if (d.op === "in") {
    return { column: d.column, op: d.op, value: d.value.split(",").map((v) => v.trim()).filter((v) => v !== "") };
  }
  return { column: d.column, op: d.op, value: d.value };
}

function draftIsComplete(d: FilterDraft): boolean {
  if (!d.column) return false;
  if (NULL_OPS.includes(d.op)) return true;
  if (d.op === "in") return d.value.split(",").some((v) => v.trim() !== "");
  return d.value.trim() !== "";
}

const selectClass = "input text-xs py-1.5 px-2";

export function QueryBuilderForm({
  columns, suggestion, exactTotalRows, busy, onRun, onChange,
}: {
  columns: BuilderColumns;
  suggestion?: QueryBuilderSpec | null;
  exactTotalRows?: number | null;
  busy?: boolean;
  // Resolves to the backend's 400 detail when the request was rejected
  // (shown inline, and the Run button stays disabled until the form
  // changes), or to null/undefined when it was accepted.
  onRun: (spec: QueryBuilderSpec, summary: string) => Promise<string | null | void> | void;
  onChange?: (spec: QueryBuilderSpec) => void;
}) {
  const tables = Object.keys(columns);
  const [table, setTable] = useState<string>(() =>
    suggestion?.table && columns[suggestion.table] ? suggestion.table : tables[0] || "",
  );
  const [groupBy, setGroupBy] = useState<string[]>(() => (suggestion?.group_by || []).slice(0, 3));
  const [agg, setAgg] = useState<QueryBuilderAgg>(() => suggestion?.agg || "count");
  const [measure, setMeasure] = useState<string>(() => suggestion?.measure || "");
  const [filters, setFilters] = useState<FilterDraft[]>(() => (suggestion?.filters || []).map(filterToDraft));
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const cols = columns[table] || [];
  const colNames = cols.map((c) => c.name);

  // Switching tables drops any column choice that no longer exists.
  const changeTable = (next: string) => {
    setTable(next);
    const names = new Set((columns[next] || []).map((c) => c.name));
    setGroupBy((g) => g.filter((c) => names.has(c)));
    setMeasure((m) => (names.has(m) ? m : ""));
    setFilters((fs) => fs.filter((f) => names.has(f.column)));
    setError(null);
  };

  const spec: QueryBuilderSpec = useMemo(() => ({
    table,
    group_by: groupBy,
    measure: agg === "count" ? null : measure || null,
    agg,
    filters: filters.filter(draftIsComplete).map(draftToFilter),
    order_by: suggestion?.order_by ?? null,
    limit: suggestion?.limit ?? 1000,
  }), [table, groupBy, agg, measure, filters, suggestion?.order_by, suggestion?.limit]);

  const summary = describeBuilderSpec(spec);
  useEffect(() => { onChange?.(spec); }, [spec]); // eslint-disable-line react-hooks/exhaustive-deps

  const incompleteFilter = filters.some((f) => !draftIsComplete(f));
  const canRun = !!table && (agg === "count" || !!measure) && !incompleteFilter && !busy && !running && !error;

  const run = async () => {
    if (!canRun) return;
    setRunning(true);
    try {
      const detail = await onRun(spec, summary);
      if (typeof detail === "string" && detail) setError(detail);
    } catch (e: any) {
      setError(e?.message || "That could not be run.");
    } finally {
      setRunning(false);
    }
  };

  const touch = () => setError(null);

  return (
    <div className="query-builder rounded-xl border border-primary/30 bg-primary/5 overflow-hidden">
      <div className="px-3 py-2 border-b border-primary/20 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <div className="text-[12px] font-semibold text-primary">Finish it yourself — every row included</div>
        <div className="text-[10px] text-accent">GD360 fills in its best guess; you confirm. No AI guessing in the SQL.</div>
      </div>
      <div className="p-3 grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        {tables.length > 1 && (
          <label className="flex flex-col gap-1 text-[11px] text-muted sm:col-span-2">
            Table
            <select className={selectClass} value={table} onChange={(e) => changeTable(e.target.value)} disabled={busy}>
              {tables.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
        )}
        <div className="flex flex-col gap-1 text-[11px] text-muted">
          <span>Group by <span className="text-muted/70">(up to 3)</span></span>
          <div className="flex flex-wrap items-center gap-1" data-testid="group-by">
            {groupBy.map((g) => (
              <span key={g} className="group-by-chip inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-lg border border-border bg-surface2 text-[11px] text-text">
                {g}
                <button
                  type="button"
                  className="text-muted hover:text-text px-0.5"
                  aria-label={`Remove ${g} from group by`}
                  disabled={busy}
                  onClick={() => { setGroupBy((gs) => gs.filter((x) => x !== g)); touch(); }}
                >
                  &times;
                </button>
              </span>
            ))}
            {groupBy.length < 3 && (
              <select
                className={`${selectClass} flex-1 min-w-[120px]`}
                value=""
                aria-label="Add a group-by column"
                disabled={busy}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v && !groupBy.includes(v)) { setGroupBy((gs) => [...gs, v]); touch(); }
                }}
              >
                <option value="">{groupBy.length ? "Add a column…" : "(no grouping)"}</option>
                {colNames.filter((c) => !groupBy.includes(c)).map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            )}
          </div>
        </div>
        <label className="flex flex-col gap-1 text-[11px] text-muted">
          Calculation
          <select className={selectClass} value={agg} aria-label="Calculation" disabled={busy} onChange={(e) => { setAgg(e.target.value as QueryBuilderAgg); touch(); }}>
            {AGG_OPTIONS.map((a) => <option key={a} value={a}>{AGG_LABELS[a]}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-muted">
          Of
          {agg === "count" ? (
            <select className={`${selectClass} opacity-60`} value="rows" aria-label="Of" disabled>
              <option value="rows">rows</option>
            </select>
          ) : (
            <select className={selectClass} value={measure} aria-label="Of" disabled={busy} onChange={(e) => { setMeasure(e.target.value); touch(); }}>
              <option value="">Pick a column…</option>
              {colNames.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
        </label>
        <div className="flex flex-col gap-1 text-[11px] text-muted sm:col-span-2">
          <span>Only where</span>
          <div className="space-y-1.5" data-testid="filters">
            {filters.map((f, i) => (
              <div key={i} className="filter-row flex flex-wrap items-center gap-1.5">
                <select
                  className={`${selectClass} flex-1 min-w-[110px]`}
                  value={f.column}
                  aria-label={`Filter ${i + 1} column`}
                  disabled={busy}
                  onChange={(e) => { const v = e.target.value; setFilters((fs) => fs.map((x, j) => (j === i ? { ...x, column: v } : x))); touch(); }}
                >
                  <option value="">Column…</option>
                  {colNames.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                <select
                  className={`${selectClass} w-auto flex-none`}
                  value={f.op}
                  aria-label={`Filter ${i + 1} operator`}
                  disabled={busy}
                  onChange={(e) => { const v = e.target.value as QueryBuilderOp; setFilters((fs) => fs.map((x, j) => (j === i ? { ...x, op: v } : x))); touch(); }}
                >
                  {OP_OPTIONS.map((o) => <option key={o} value={o}>{OP_LABELS[o]}</option>)}
                </select>
                {!NULL_OPS.includes(f.op) && (
                  <input
                    className={`${selectClass} flex-1 min-w-[90px]`}
                    value={f.value}
                    aria-label={`Filter ${i + 1} value`}
                    placeholder={f.op === "in" ? "a, b, c" : "value"}
                    disabled={busy}
                    onChange={(e) => { const v = e.target.value; setFilters((fs) => fs.map((x, j) => (j === i ? { ...x, value: v } : x))); touch(); }}
                  />
                )}
                <button
                  type="button"
                  className="text-muted hover:text-text px-1 text-sm leading-none"
                  aria-label={`Remove filter ${i + 1}`}
                  disabled={busy}
                  onClick={() => { setFilters((fs) => fs.filter((_, j) => j !== i)); touch(); }}
                >
                  &times;
                </button>
              </div>
            ))}
            <button
              type="button"
              className="text-[11px] text-accent hover:opacity-80 font-medium"
              disabled={busy || !colNames.length}
              onClick={() => { setFilters((fs) => [...fs, { column: colNames[0] || "", op: "=", value: "" }]); touch(); }}
            >
              + Add a condition
            </button>
          </div>
        </div>
      </div>
      <div className="px-3 pb-3 flex flex-wrap items-center justify-between gap-2">
        <code className="builder-preview font-mono text-[11px] text-primary whitespace-pre-wrap break-words flex-1 min-w-[160px]" data-testid="builder-preview">
          {summary}
        </code>
        <button
          type="button"
          className="btn-primary text-xs px-3 py-1.5 shrink-0 whitespace-nowrap"
          disabled={!canRun}
          onClick={run}
        >
          {running ? "Running…" : exactTotalRows != null ? `Run on all ${fmtInt(exactTotalRows)} rows` : "Run on all rows"}
        </button>
      </div>
      {error && (
        <div className="builder-error mx-3 mb-3 text-[11px] text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-2.5 py-1.5" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

// --- The whole card ----------------------------------------------------------

export function NeedsQueryHelpCard({
  replyText, provider, attempts, skippedReason, builderSuggestion, builderColumns, exactTotalRows,
  originalPrompt, busy, condensed, onFinish, onRephrase, onRetry,
}: {
  replyText: string;
  provider?: string | null;
  attempts?: PushdownAttempt[] | null;
  skippedReason?: PushdownSkippedReason | null;
  builderSuggestion?: QueryBuilderSpec | null;
  builderColumns?: BuilderColumns | null;
  exactTotalRows?: number | null;
  // The question this turn failed to answer - what "Rephrase" prefills
  // and "Try again" re-sends.
  originalPrompt?: string;
  busy?: boolean;
  // The Chart tab's version: banner + attempts + footer only, pointing at
  // the chat for the builder (so there is one builder, with one state).
  condensed?: boolean;
  onFinish?: (finish: ChatFinishRequest, prompt: string) => Promise<string | null | void> | void;
  onRephrase?: (prompt: string) => void;
  onRetry?: () => void;
}) {
  const [sqlOpen, setSqlOpen] = useState(false);
  const lastSql = useMemo(() => {
    const withSql = (attempts || []).filter((a) => a.sql);
    return withSql.length ? withSql[withSql.length - 1].sql || "" : "";
  }, [attempts]);
  const [rawSql, setRawSql] = useState(lastSql);
  const [rawError, setRawError] = useState<string | null>(null);
  const [rawRunning, setRawRunning] = useState(false);
  const rawRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (sqlOpen) rawRef.current?.focus(); }, [sqlOpen]);

  // 2026-10-06 ("generated data is a saved query" layer): a table that
  // could not be built ("table_failed") has no builder (builder_suggestion
  // is always null - an aggregate builder cannot define a table of rows);
  // the way forward is the person's own SELECT saved as a table, so the
  // checkbox starts ticked there and off for an ordinary failed question.
  const tableFailed = skippedReason === "table_failed";
  const [saveAsTable, setSaveAsTable] = useState(tableFailed);

  const hasColumns = !!builderColumns && Object.keys(builderColumns).length > 0;
  // The group-by/calculation builder can only produce a summary, never a
  // table of rows - so it is not offered for a failed TABLE request.
  const builderAllowed = hasColumns && (!provider || BUILDER_KINDS.includes(provider)) && !tableFailed;
  const rawSqlAllowed = !provider || provider !== "mongodb";
  const saveAsTableAllowed = rawSqlAllowed && (!provider || BUILDER_KINDS.includes(provider));
  const metered = !!provider && METERED_KINDS.includes(provider);

  const runRaw = async () => {
    const sql = rawSql.trim();
    if (!sql || !onFinish || busy || rawRunning) return;
    setRawRunning(true);
    setRawError(null);
    try {
      const firstLine = sql.split("\n").map((l) => l.trim()).find((l) => l) || "My own SQL";
      const asTable = saveAsTableAllowed && saveAsTable;
      const detail = await onFinish(
        asTable ? { raw_sql: sql, save_as_table: true } : { raw_sql: sql },
        asTable ? SAVE_AS_TABLE_PROMPT : firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine,
      );
      if (typeof detail === "string" && detail) setRawError(detail);
    } catch (e: any) {
      setRawError(e?.message || "That could not be run.");
    } finally {
      setRawRunning(false);
    }
  };

  return (
    <div className="needs-query-help space-y-2.5">
      <div className="rounded-xl bg-amber-500/10 border border-amber-500/30 px-3.5 py-2.5 flex items-start gap-2.5" role="status">
        <span className="shrink-0 text-amber-500 mt-px" aria-hidden>&#9888;</span>
        <div className="min-w-0 space-y-1">
          <div className="text-[12.5px] font-semibold text-amber-500">
            {tableFailed ? "No table yet — nothing was built from your data" : "No answer yet — this question has not been run on your data"}
          </div>
          <div className="text-[12px] text-text/85 whitespace-pre-wrap">{replyText}</div>
        </div>
      </div>

      {!condensed && builderAllowed && onFinish && (
        <QueryBuilderForm
          columns={builderColumns as BuilderColumns}
          suggestion={builderSuggestion}
          exactTotalRows={exactTotalRows}
          busy={busy}
          onRun={(spec, summary) => onFinish({ query_builder: spec }, summary)}
        />
      )}

      {!condensed && (
        <div className="flex flex-wrap gap-1.5">
          {originalPrompt && onRephrase && (
            <button type="button" className="text-xs px-2.5 py-1.5 rounded-lg btn-secondary font-medium" disabled={busy} onClick={() => onRephrase(originalPrompt)}>
              Rephrase the question
            </button>
          )}
          {rawSqlAllowed && onFinish && (
            <button type="button" className="text-xs px-2.5 py-1.5 rounded-lg btn-secondary font-medium" disabled={busy} onClick={() => setSqlOpen((o) => !o)} aria-expanded={sqlOpen}>
              {sqlOpen ? "Hide SQL editor" : "Write the SQL myself"}
            </button>
          )}
          {onRetry && (
            <button type="button" className="text-xs px-2.5 py-1.5 rounded-lg btn-secondary font-medium" disabled={busy} onClick={onRetry}>
              Try again
            </button>
          )}
        </div>
      )}

      {!condensed && sqlOpen && rawSqlAllowed && onFinish && (
        <div className="raw-sql rounded-xl border border-border bg-surface2/60 overflow-hidden">
          <div className="px-3 py-1.5 border-b border-border text-[11px] font-semibold">
            Your SQL — runs inside {providerLabel(provider)} over every row (read-only, same cost guards)
          </div>
          <div className="p-2 space-y-2">
            <textarea
              ref={rawRef}
              className="input font-mono text-[11px] leading-relaxed min-h-[110px] resize-y"
              value={rawSql}
              aria-label="Your SQL"
              placeholder="SELECT …"
              disabled={busy || rawRunning}
              onChange={(e) => { setRawSql(e.target.value); setRawError(null); }}
            />
            {rawError && (
              <div className="text-[11px] text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-2.5 py-1.5" role="alert">{rawError}</div>
            )}
            <div className={`flex flex-wrap items-center gap-2 ${saveAsTableAllowed ? "justify-between" : "justify-end"}`}>
              {saveAsTableAllowed && (
                <label className="flex items-center gap-1.5 text-[11px] text-text cursor-pointer" title="Turns this SELECT into a saved query inside your warehouse - a table you can ask about next, with no rows copied into GD360">
                  <input
                    type="checkbox"
                    checked={saveAsTable}
                    disabled={busy || rawRunning}
                    onChange={(e) => setSaveAsTable(e.target.checked)}
                    data-testid="card-save-as-table"
                  />
                  Save as table
                  <span className="text-muted">(a saved query, not a copy)</span>
                </label>
              )}
              <button type="button" className="btn-primary text-xs px-3 py-1.5" disabled={busy || rawRunning || !rawSql.trim() || !!rawError} onClick={runRaw}>
                {rawRunning ? "Running…" : saveAsTableAllowed && saveAsTable ? "Save as table" : "Run"}
              </button>
            </div>
          </div>
        </div>
      )}

      <AttemptsList attempts={attempts} skippedReason={skippedReason} provider={provider} />

      <div className="warehouse-footer flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted tabular-nums px-0.5">
        <span className="h-2 w-2 rounded-full bg-amber-500 shrink-0" aria-hidden />
        <span>0 rows loaded into GD360</span>
        {metered && <><span>·</span><span>failed attempts are validated for free, never billed</span></>}
      </div>

      {condensed && (
        <div className="text-[11px] text-muted px-0.5">
          Finish it from the chat on the left: adjust the builder, rephrase, or write the SQL yourself.
        </div>
      )}
    </div>
  );
}
