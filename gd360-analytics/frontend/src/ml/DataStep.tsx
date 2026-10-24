// 2026-10-12 (round 39): the data step - the chat engine's method inside ML
// Studio. The table a model learns from can be shaped by one SELECT: written
// by GD360 from a sentence (each failed try goes back to it with the error,
// and the page shows what was fixed) or typed by the person. It runs in the
// run's sandbox - this table only, read-only, no files - and is previewed on
// the real data before anything trains.
import { useState } from "react";
import { errorText, mlStudioApi, PrepCheck, PrepHint, Spec } from "../api/mlStudio";
import { CodeIcon, PlayIcon, ShieldCheckIcon, SparkleIcon } from "../ui";
import { formatSql, sameSql } from "./formatSql";
import { RowsPreview } from "./StageVisuals";

export default function DataStep({
  spec,
  hint,
  initialSql = "",
  applyLabel = "Use this data step",
  onApply,
  onCancel,
}: {
  spec: Spec;
  hint?: PrepHint | null;
  initialSql?: string;
  applyLabel?: string;
  onApply: (res: PrepCheck) => void;
  onCancel?: () => void;
}) {
  const [request, setRequest] = useState(hint?.request || "");
  const [sql, setSql] = useState(() => formatSql(initialSql));
  const [busy, setBusy] = useState<"" | "write" | "check">("");
  const [res, setRes] = useState<PrepCheck | null>(null);
  const [error, setError] = useState("");
  const base: Spec = { ...spec, prep_sql: null };

  const write = async () => {
    if (!request.trim()) return;
    setBusy("write");
    setError("");
    try {
      const out = await mlStudioApi.prepareSuggest(base, request.trim());
      setRes(out);
      setSql(formatSql(out.sql));
    } catch (e) {
      setError(errorText(e, "Couldn't write the data step."));
    } finally {
      setBusy("");
    }
  };

  const check = async () => {
    if (!sql.trim()) return;
    setBusy("check");
    setError("");
    try {
      const out = await mlStudioApi.prepareCheck(base, sql);
      setRes(out);
      if (!out.ok) setError(out.error || "That SQL didn't run.");
    } catch (e) {
      setError(errorText(e, "Couldn't run the SQL."));
    } finally {
      setBusy("");
    }
  };

  const ready = !!res?.ok && sameSql(res.sql, sql);
  const lines = Math.max(6, Math.min(22, sql.split("\n").length + 1));

  return (
    <section className="rounded-card border p-4 sm:p-5 flex flex-col gap-4 min-w-0" style={{ borderColor: "rgb(var(--auto-tell-border, var(--color-border)))" }} aria-label="Data step">
      <header className="flex items-start gap-3 flex-wrap">
        <span className="w-8 h-8 rounded-ctl grid place-items-center shrink-0" style={{ background: "rgb(var(--auto-tell) / 0.14)", color: "rgb(var(--auto-tell))" }} aria-hidden="true">
          <CodeIcon size={16} />
        </span>
        <div className="flex flex-col gap-0.5 min-w-0 flex-1">
          <h3 className="m-0 text-[16px] font-semibold text-text">Data step · the table the model learns from</h3>
          <p className="m-0 text-caption text-secondary leading-snug">
            {hint?.text || "Shape the rows with one SELECT over “source” - one row per customer, a label from later rows, features from earlier ones."}
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 text-[11.5px] px-2 py-1 rounded-full border border-border text-secondary" title="The SQL can read this run's tables only. It can't change data, read files or reach the network.">
          <ShieldCheckIcon size={13} /> Read-only sandbox
        </span>
      </header>

      <div className="flex flex-col gap-2">
        <label htmlFor="prep-ask" className="text-caption text-muted">Describe each row, and Euliv writes the SQL</label>
        <div className="flex gap-2 flex-wrap">
          <input
            id="prep-ask"
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), write())}
            placeholder="One row per customer: orders, spend, days since last order, and whether they bought again in 90 days"
            className="h-10 flex-1 min-w-[240px] rounded-ctl border border-border bg-base px-3 text-ui text-text placeholder:text-faint"
          />
          <button type="button" className="btn-primary text-sm inline-flex items-center gap-1.5" onClick={write} disabled={!!busy || !request.trim()}>
            <SparkleIcon size={14} /> {busy === "write" ? "Writing and testing…" : "Write it for me"}
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor="prep-sql" className="text-caption text-muted">SQL (DuckDB) · reads <code className="font-mono text-secondary">source</code>{(spec.joins || []).length ? ` and join_1…join_${(spec.joins || []).length}` : ""}</label>
          <span className="text-caption text-muted">{sql.trim() ? `${sql.split("\n").length} lines` : ""}</span>
        </div>
        <textarea
          id="prep-sql"
          value={sql}
          rows={lines}
          spellCheck={false}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              check();
            }
          }}
          placeholder={"SELECT customer_id,\n       COUNT(*) AS orders,\n       SUM(revenue) AS spend\nFROM source\nGROUP BY customer_id"}
          className="w-full rounded-ctl border border-border bg-base px-3.5 py-3 font-mono text-[12.5px] leading-[1.6] text-text placeholder:text-faint resize-y"
        />
        <div className="flex gap-2 flex-wrap items-center">
          <button type="button" className="btn-secondary text-sm inline-flex items-center gap-1.5" onClick={check} disabled={!!busy || !sql.trim()}>
            <PlayIcon size={13} /> {busy === "check" ? "Running…" : "Run on the data"}
          </button>
          <span className="text-caption text-muted">Ctrl + Enter</span>
          <span className="flex-1" />
          {onCancel && <button type="button" className="btn-secondary text-sm" onClick={onCancel} disabled={!!busy}>Cancel</button>}
          <button type="button" className="btn-primary text-sm" onClick={() => res && onApply(res)} disabled={!ready || !!busy}>
            {applyLabel}
          </button>
        </div>
      </div>

      {error && <div role="alert" className="rounded-ctl border border-danger-border bg-danger-fill px-3 py-2.5 text-ui text-text whitespace-pre-wrap">{error}</div>}

      {res?.healed && res.attempts && (
        <div className="rounded-ctl border px-3 py-2.5 flex flex-col gap-1.5" style={{ borderColor: "rgb(var(--auto-tell) / 0.4)", background: "rgb(var(--auto-tell) / 0.08)" }} role="status">
          <span className="text-ui font-medium text-text">Euliv fixed its own SQL {res.attempts.length - 1} time{res.attempts.length > 2 ? "s" : ""} before this ran</span>
          {res.attempts.filter((a) => !a.ok).map((a, i) => (
            <span key={i} className="text-caption text-secondary font-mono break-words">try {i + 1}: {a.error}</span>
          ))}
        </div>
      )}

      {res?.ok && (
        <div className="flex flex-col gap-3">
          {res.explain && <p className="m-0 text-ui text-secondary leading-relaxed">{res.explain}</p>}
          <div className="flex gap-2 flex-wrap text-caption">
            <span className="px-2.5 py-1 rounded-full bg-subtle text-text font-mono">{Number(res.rows || 0).toLocaleString()} rows</span>
            <span className="px-2.5 py-1 rounded-full bg-subtle text-secondary font-mono">from {Number(res.source_rows || 0).toLocaleString()}</span>
            <span className="px-2.5 py-1 rounded-full bg-subtle text-secondary font-mono">{(res.columns || []).length} columns</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(res.columns || []).map((c) => (
              <span key={c.name} className="text-[11.5px] px-2 py-0.5 rounded border border-border text-secondary font-mono">
                {c.name} <span className="text-faint">{c.type}</span>
              </span>
            ))}
          </div>
          <RowsPreview preview={res.preview} note="First rows of the table the model will learn from" />
        </div>
      )}
    </section>
  );
}
