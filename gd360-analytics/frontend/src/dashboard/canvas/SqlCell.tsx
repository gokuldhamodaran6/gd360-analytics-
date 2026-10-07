import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { BlockResult } from "../../api/client";
import { Button, PlayIcon, SaveIcon, TableFrame, cn, type DataTableColumn } from "../../ui";
import { formatCell } from "../runState";
import { PARAM_TOKEN_RE, isValidCellName, referencedParams, slimConfig, statusLine } from "./cells";
import type { CellBodyProps } from "./types";

// 2026-10-07 (analyst canvas round, OptionC.dc.html cell 2): a SQL cell.
// Owner: the statement in a mono editor with {{param}} / @param tokens
// highlighted, the cell's mono `name` (what other cells read it as -
// {{cell:name}}), "Run cell" (⌘↵) and "Save" (PATCH /blocks/{id} with
// config.sql / config.name - the backend validates: one read-only SELECT,
// every parameter known, no dependency loop, zero-row check - and its 400
// message is shown inline). Under it the status line from the BlockResult
// ("Ran in BigQuery · 28.6 MB · 1.2 s · 26 rows") and a result preview
// (first 5 rows, "Show all"). Viewer: the same, read-only.

const PREVIEW_ROWS = 5;

// The editor's highlight layer: the same text, with parameter tokens
// wrapped. Both layers share font/padding/wrapping so they line up.
function Highlighted({ sql, known }: { sql: string; known: Set<string> }) {
  const parts = useMemo(() => {
    const out: ReactNode[] = [];
    let last = 0;
    let i = 0;
    for (const m of sql.matchAll(PARAM_TOKEN_RE)) {
      const start = m.index ?? 0;
      if (start > last) out.push(sql.slice(last, start));
      const tok = m[1];
      const name = (tok.startsWith("@") ? tok.slice(1) : tok.slice(2, -2).trim()).split(".")[0];
      const isCell = name.startsWith("cell:");
      const ok = isCell || known.has(name);
      out.push(
        <span key={i++} data-sql-token={isCell ? "cell" : ok ? "param" : "unknown"} className={cn("rounded-[3px] px-[1px]", isCell ? "bg-subtle text-secondary" : ok ? "bg-tint text-brand-ink" : "bg-warning-fill text-warning")}>
          {tok}
        </span>
      );
      last = start + tok.length;
    }
    if (last < sql.length) out.push(sql.slice(last));
    // A trailing newline needs a visible line so the layers stay the same height.
    if (sql.endsWith("\n")) out.push(" ");
    return out;
  }, [sql, known]);
  return <>{parts}</>;
}

function ResultPreview({ result, blockTitle }: { result: BlockResult; blockTitle: string }) {
  const [all, setAll] = useState(false);
  useEffect(() => setAll(false), [result]);
  const columns = useMemo<DataTableColumn<Record<string, any>>[]>(
    () =>
      (result.columns || []).map((c) => {
        const numeric = result.rows?.some((r) => typeof r[c.name] === "number") ?? false;
        // A whole number in a column the result calls a dimension (a year,
        // an id) is printed as it is - "2015", not "2,015" - the same rule
        // a table block's cells follow (BlockRenderer resultTableColumns).
        const dimension = (result.dimensions || []).includes(c.name);
        return {
          key: c.name, header: c.name, mono: true, numeric,
          render: (row) => { const v = row[c.name]; return dimension && typeof v === "number" && Number.isInteger(v) ? String(v) : formatCell(v); },
        };
      }),
    [result]
  );
  const rows = result.rows || [];
  if (!columns.length) return <div className="px-4 py-3 text-caption text-muted">The statement ran but returned no columns.</div>;
  const visible = all ? rows : rows.slice(0, PREVIEW_ROWS);
  const total = result.row_count ?? rows.length;
  return (
    <div data-sql-preview="" className="border-t border-subtle">
      <div className="flex flex-wrap items-center gap-x-1.5 px-4 py-2 text-caption text-muted">
        <span>Result preview</span>
        <span aria-hidden="true">·</span>
        <span>{all ? `all ${rows.length.toLocaleString()} rows` : `first ${Math.min(PREVIEW_ROWS, rows.length)} of ${total.toLocaleString()} rows`}</span>
        {rows.length > PREVIEW_ROWS && (
          <>
            <span aria-hidden="true">·</span>
            <button type="button" className="ui-focus rounded px-0.5 font-medium text-brand-ink hover:underline" onClick={() => setAll((a) => !a)}>{all ? "Show first 5" : "Show all"}</button>
          </>
        )}
        {result.truncated && <span className="text-faint">(capped by the cell's row limit)</span>}
      </div>
      <TableFrame bare dense columns={columns} rows={visible} rowKey={(_r, i) => i} ariaLabel={`${blockTitle} result`} maxHeight={all ? 420 : 260} />
    </div>
  );
}

export function SqlCell({ cell, cells, run, owner, editing, onStartEdit, onStopEdit, rerunWithDependents, mode, parameters, source }: CellBodyProps) {
  const block = cell.block;
  const storedSql: string = typeof block.config?.sql === "string" ? block.config.sql : "";
  const storedName: string = (block.config?.name as string) || "";
  const [sql, setSql] = useState(storedSql);
  const [name, setName] = useState(storedName);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedTick, setSavedTick] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLPreElement>(null);
  // The stored statement changed underneath (another save, an undo): follow it.
  useEffect(() => { setSql(storedSql); }, [storedSql]);
  useEffect(() => { setName(storedName); }, [storedName]);
  useEffect(() => { if (editing) textareaRef.current?.focus(); }, [editing]);

  const result = run.results[block.id];
  const dirty = sql !== storedSql || name !== storedName;
  const known = useMemo(() => new Set(parameters.map((p) => p.name || p.column)), [parameters]);
  const unknown = useMemo(() => referencedParams(sql).filter((n) => !known.has(n)), [sql, known]);
  const nameTaken = cells.some((c) => c.id !== cell.id && c.name === name);
  const nameInvalid = name !== "" && !isValidCellName(name);
  const status = statusLine(result, block.config?.computed_in);
  const canEdit = Boolean(owner);

  const save = async (thenRun: boolean) => {
    if (!owner) return;
    setSaving(true);
    setSaveError(null);
    try {
      await owner.updateBlock(block.id, { config: { ...slimConfig(block.config), sql: sql.trim(), name: name.trim() || undefined } });
      setSavedTick(true);
      setTimeout(() => setSavedTick(false), 1500);
      if (thenRun) rerunWithDependents(block.id);
    } catch (e: any) {
      const detail = e?.response?.data?.detail;
      setSaveError(typeof detail === "string" ? detail : "Couldn't save this cell.");
    } finally {
      setSaving(false);
    }
  };
  const runCell = () => {
    if (dirty && canEdit) save(true);
    else rerunWithDependents(block.id);
  };

  return (
    <div data-sql-cell="" className="flex flex-col">
      {canEdit ? (
        <div className="px-4 pb-2 pt-1">
          <div className="relative rounded-ctl border border-border bg-subtle/60 focus-within:border-accent">
            <pre
              ref={scrollRef}
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 m-0 overflow-hidden whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-[12.5px] leading-[1.55] text-text"
            >
              {sql ? <Highlighted sql={sql} known={known} /> : <span className="text-faint">{"SELECT …\n-- reference a parameter as {{name}}, another cell as {{cell:name}}"}</span>}
            </pre>
            <textarea
              ref={textareaRef}
              value={sql}
              onChange={(e) => setSql(e.target.value)}
              onFocus={onStartEdit}
              onScroll={(e) => { if (scrollRef.current) scrollRef.current.scrollTop = (e.target as HTMLTextAreaElement).scrollTop; }}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); e.stopPropagation(); runCell(); }
                else if (e.key === "Escape") { e.stopPropagation(); (e.target as HTMLTextAreaElement).blur(); onStopEdit(); }
                else if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "Enter") e.stopPropagation();
              }}
              spellCheck={false}
              rows={Math.min(18, Math.max(4, sql.split("\n").length + 1))}
              aria-label={`SQL for ${cell.label}`}
              data-sql-editor=""
              className="ui-focus relative block w-full resize-y bg-transparent px-3 py-2.5 font-mono text-[12.5px] leading-[1.55] text-transparent caret-text outline-none"
              style={{ WebkitTextFillColor: "transparent" }}
            />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-caption text-muted">
              as
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); save(true); } if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "Escape") e.stopPropagation(); }}
                aria-label="Cell name"
                aria-invalid={nameTaken || nameInvalid || undefined}
                spellCheck={false}
                data-sql-name=""
                className={cn("ui-focus h-7 w-[180px] rounded-ctl border bg-surface px-2 font-mono text-caption text-text", nameTaken || nameInvalid ? "border-danger-border" : "border-border")}
                placeholder="cell_name"
              />
            </label>
            {nameTaken && <span className="text-caption text-danger">Another cell has this name.</span>}
            {nameInvalid && <span className="text-caption text-danger">Letters, digits and underscores only.</span>}
            {unknown.length > 0 && <span className="text-caption text-warning" data-unknown-params="">Not a parameter: {unknown.join(", ")}</span>}
            <span className="ml-auto flex items-center gap-2">
              {dirty && !saving && <span className="text-caption text-muted">Unsaved changes</span>}
              {savedTick && !dirty && <span className="text-caption text-good">Saved</span>}
              <Button size="sm" variant="ghost" icon={<PlayIcon size={14} />} onClick={runCell} disabled={saving || (dirty && (nameTaken || nameInvalid))} title="Run this cell (⌘↵)" data-run-cell="">Run cell</Button>
              <Button size="sm" variant={dirty ? "primary" : "secondary"} icon={<SaveIcon size={14} />} onClick={() => save(true)} loading={saving} disabled={!dirty || nameTaken || nameInvalid} data-save-cell="">Save</Button>
            </span>
          </div>
          {saveError && <div role="alert" data-sql-save-error="" className="mt-2 rounded-ctl border border-danger-border bg-danger-fill px-3 py-2 text-caption text-danger">{saveError}</div>}
        </div>
      ) : (
        <div className="px-4 pb-2 pt-1">
          {/* 2026-10-07 (round 9): a published link shows what the cell
              returned, never the statement (which names tables and
              columns) - the public endpoints do not send it either. */}
          {!source?.hideSql && (
            <pre data-sql-readonly="" className="m-0 overflow-x-auto whitespace-pre-wrap break-words rounded-ctl border border-border bg-subtle/60 px-3 py-2.5 font-mono text-[12.5px] leading-[1.55] text-text">
              {storedSql ? <Highlighted sql={storedSql} known={known} /> : <span className="text-faint">This cell has no statement yet.</span>}
            </pre>
          )}
          {mode === "warehouse" && result && (
            <div className="mt-2 flex justify-end">
              <Button size="sm" variant="ghost" icon={<PlayIcon size={14} />} onClick={() => rerunWithDependents(block.id)} title="Recompute this cell" data-run-cell="">Run cell</Button>
            </div>
          )}
        </div>
      )}
      {result && result.status !== "ok" && (
        <div role="alert" data-sql-error="" className="mx-4 mb-3 rounded-ctl border border-danger-border bg-danger-fill px-3 py-2 text-ui text-danger">
          {result.error || "This cell couldn't run."}
        </div>
      )}
      {status && (
        <div data-sql-status="" className="flex flex-wrap items-center gap-x-1.5 px-4 pb-2 text-caption text-muted">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-good" aria-hidden="true" />
          {status}
          {result?.missing_parameters && result.missing_parameters.length > 0 && <span className="text-warning">· waiting for {result.missing_parameters.join(", ")}</span>}
        </div>
      )}
      {!result && run.loading && mode === "warehouse" && storedSql && <div className="px-4 pb-3"><div className="ui-shimmer h-3.5 w-1/2" aria-busy="true" /></div>}
      {result && result.status === "ok" && <ResultPreview result={result} blockTitle={cell.label} />}
    </div>
  );
}
