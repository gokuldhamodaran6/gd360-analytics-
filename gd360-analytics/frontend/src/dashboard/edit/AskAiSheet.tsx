import { useEffect, useMemo, useState } from "react";
import type { DashboardBlock } from "../../api/client";
import { Button, Field, Sheet, SparkleIcon, Textarea, WarningIcon } from "../../ui";
import { describeSpec } from "../runState";
import { type DashboardEditor, errorDetail } from "./useDashboardEditor";

// 2026-10-07 (dashboard edit mode): "Change with AI..." - one sentence in,
// the block rebuilt. The request is the existing POST /blocks/{id}/ask-ai;
// on a warehouse dashboard it writes a query spec that runs over every row
// (never a sample), and a 422 / 400 / 502 carries a `detail` written for
// the person, shown here word for word with two ways forward.

export type ColumnKind = "number" | "date" | "boolean" | "text";

export function columnKind(type: string | null | undefined, name = ""): ColumnKind {
  const t = String(type || "").toLowerCase();
  if (/date|time/.test(t)) return "date";
  if (/bool/.test(t)) return "boolean";
  if (/int|float|numeric|decimal|double|real|number|money/.test(t)) return "number";
  if (!t && /(^|_)(date|time)$|_at$|_on$/.test(name.toLowerCase())) return "date";
  return "text";
}

export type EditorColumn = { name: string; type: string; kind: ColumnKind };

// The columns a block can be built from: its own table on a warehouse
// dashboard (the first table when it has none yet), the datasource's
// columns on a file dashboard.
export function columnsForBlock(editor: DashboardEditor, block?: DashboardBlock | null, table?: string | null): EditorColumn[] {
  if (editor.warehouse) {
    const tables = editor.dash.tables || {};
    const name = table || (block?.config?.spec?.table as string | undefined) || Object.keys(tables)[0];
    const cols = (name && tables[name]) || [];
    return cols.map((c) => ({ name: c.name, type: String(c.type || ""), kind: columnKind(String(c.type || ""), c.name) }));
  }
  return editor.fileColumns.map((c) => ({ name: c.name, type: c.dtype, kind: columnKind(c.dtype, c.name) }));
}

const ID_LIKE = /(^|_)(id|uuid|key|code|zip|phone|number|num|no)$/i;
// A 0/1 flag or a calendar part stored as a number ("is_canceled",
// "arrival_date_year") is a poor thing to total in an example.
const FLAG_OR_DATE_PART = /^(is|has)_|(^|_)(year|month|week|day|hour|quarter)(_number)?$/i;

// Three prompts a person could send as they are, written from the
// dashboard's REAL columns (a measure, a category, a date) - never a
// made-up "revenue by region". `preferred` are the columns the dashboard
// already filters by (the categories its owner cares about); `measured`
// the ones its blocks already aggregate.
export function examplePrompts(columns: EditorColumn[], blockType?: string, preferred: string[] = [], measured: string[] = []): string[] {
  const numericAll = columns.filter((c) => c.kind === "number" && !ID_LIKE.test(c.name));
  const real = numericAll.filter((c) => !FLAG_OR_DATE_PART.test(c.name));
  // First the columns the dashboard already measures, then decimals, then the rest.
  const used = measured.map((n) => real.find((c) => c.name === n)).filter((c): c is EditorColumn => Boolean(c));
  const decimals = real.filter((c) => /float|numeric|decimal|double|real|money/i.test(c.type));
  const numeric = Array.from(new Set([...used, ...decimals, ...real, ...numericAll]));
  const dates = columns.filter((c) => c.kind === "date");
  const catsAll = columns.filter((c) => (c.kind === "text" || c.kind === "boolean") && !ID_LIKE.test(c.name) && !FLAG_OR_DATE_PART.test(c.name));
  const cats = [...preferred.map((n) => catsAll.find((c) => c.name === n)).filter((c): c is EditorColumn => Boolean(c)), ...catsAll.filter((c) => !preferred.includes(c.name))];
  const m1 = numeric[0]?.name, m2 = numeric[1]?.name;
  const c1 = cats[0]?.name, c2 = cats[1]?.name;
  const d1 = dates[0]?.name;
  const out: string[] = [];
  if (blockType === "kpi" || blockType === "gauge") {
    if (m1) out.push(`Average ${m1}`);
    if (m2) out.push(`Total ${m2}`);
    out.push("Number of rows");
    if (c1 && out.length < 3) out.push(`Number of distinct ${c1} values`);
  } else {
    if (m1 && c1) out.push(`Average ${m1} by ${c1}`);
    if (d1) out.push(m1 ? `Average ${m1} by month of ${d1}` : `Number of rows by month of ${d1}`);
    if (c2 || c1) out.push(`Number of rows by ${c2 || c1}, top 10`);
    if (m2 && c1 && out.length < 3) out.push(`Total ${m2} by ${c1}`);
    if (out.length < 3 && m1) out.push(`Total ${m1}`);
  }
  if (out.length === 0) out.push("Number of rows");
  return Array.from(new Set(out)).slice(0, 3);
}

// The columns the dashboard's blocks already aggregate (a measure's column,
// or the identifiers in its expression), most used first.
export function measuredColumns(dash: { pages: { blocks: DashboardBlock[] }[] }): string[] {
  const count = new Map<string, number>();
  const bump = (n: string) => count.set(n, (count.get(n) || 0) + 1);
  for (const p of dash.pages) {
    for (const b of p.blocks) {
      const measures = (b.config?.spec?.measures || []) as { column?: string | null; expr?: string | null }[];
      for (const m of measures) {
        if (m.column) bump(m.column);
        for (const id of String(m.expr || "").match(/[A-Za-z_][A-Za-z0-9_]*/g) || []) bump(id);
      }
      const recipe = b.config?.recipe;
      if (recipe?.metric_column) bump(recipe.metric_column);
    }
  }
  return Array.from(count.entries()).sort((a, b) => b[1] - a[1]).map(([n]) => n);
}

export function blockDisplayName(block: DashboardBlock): string {
  if (block.title) return block.title;
  if (block.config?.spec) return describeSpec(block.config.spec);
  if (block.type === "sql") return (block.config?.name as string) || "Untitled query";
  return "Untitled block";
}

export function AskAiSheet({ editor, block, onClose, onEditQuery }: { editor: DashboardEditor; block: DashboardBlock; onClose: () => void; onEditQuery: () => void }) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setPrompt("");
    setError(null);
  }, [block.id]);
  const examples = useMemo(
    () => examplePrompts(columnsForBlock(editor, block), block.type, (editor.dash.parameters || []).map((p) => p.column), measuredColumns(editor.dash)),
    [editor, block]
  );
  const canSubmit = prompt.trim().length > 0 && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await editor.askAi(block, prompt);
      onClose();
    } catch (e) {
      setError(errorDetail(e, "That couldn't be built. Try describing it differently."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open
      onClose={busy ? () => undefined : onClose}
      persistent={busy}
      title={blockDisplayName(block)}
      subtitle="Change with AI"
      size="sm"
      id="edit-ask-ai"
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <span className="text-caption text-muted">⌘↵ to build</span>
          <span className="flex items-center gap-2">
            <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button variant="primary" icon={<SparkleIcon size={15} />} onClick={submit} loading={busy} disabled={!canSubmit} data-ask-ai-submit="">
              {busy ? "Building…" : "Build"}
            </Button>
          </span>
        </div>
      }
    >
      <div className="flex flex-col gap-4" data-ask-ai-sheet="">
        <Field label="Describe what this block should show" id="ask-ai-prompt">
          <Textarea
            data-ask-ai-prompt=""
            rows={4}
            value={prompt}
            disabled={busy}
            placeholder={examples[0] ? `e.g. ${examples[0]}` : "e.g. Number of rows per month"}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit();
              }
            }}
          />
        </Field>
        {examples.length > 0 && (
          <div className="flex flex-col gap-2">
            <div className="text-caption font-medium uppercase tracking-caps text-muted">Try one of these</div>
            <div className="flex flex-wrap gap-1.5">
              {examples.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  disabled={busy}
                  data-ask-ai-example=""
                  onClick={() => setPrompt(ex)}
                  className="ui-focus rounded-full border border-border bg-surface px-2.5 py-1 text-left text-caption text-secondary hover:border-border-strong hover:bg-subtle hover:text-text disabled:opacity-60"
                >
                  {ex}
                </button>
              ))}
            </div>
          </div>
        )}
        {editor.warehouse && editor.provider && (
          <p className="text-caption text-muted" data-ask-ai-computed="">Computed in {editor.provider} over every row — never a sample.</p>
        )}
        {error && (
          <div role="alert" data-ask-ai-error="" className="flex flex-col gap-2.5 rounded-ctl border border-danger-border bg-danger-fill px-3 py-2.5 text-ui text-danger">
            <div className="flex items-start gap-2">
              <WarningIcon size={14} className="mt-0.5 shrink-0" />
              <span className="min-w-0 break-words">{error}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" className="h-8 text-caption" onClick={submit} disabled={!canSubmit}>Try again</Button>
              <Button variant="ghost" className="h-8 text-caption" onClick={onEditQuery}>Edit the query instead</Button>
            </div>
          </div>
        )}
      </div>
    </Sheet>
  );
}
