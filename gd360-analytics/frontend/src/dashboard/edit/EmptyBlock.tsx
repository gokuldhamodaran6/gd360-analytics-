import { useEffect, useRef, useState, type ReactNode } from "react";
import type { DashboardBlock, DashboardBlockType } from "../../api/client";
import {
  BarChartIcon, Button, ChartIcon, DividerIcon, DonutIcon, FilterIcon, HashIcon, HeadingIcon, Input, ListIcon, SqlIcon, TableIcon, TextIcon, WarningIcon, cn,
} from "../../ui";
import { canAskAi, canEditQuery } from "./BlockMenu";
import { type DashboardEditor, errorDetail } from "./useDashboardEditor";

// 2026-10-07 (dashboard edit mode): a block that was added but not built
// yet. In the editor its card body is this composed empty state - the
// block's icon, "Describe what this block should show" with a Build
// button (the same ask-AI call the sheet makes) and "or build it step by
// step" (the query builder). In the VIEW the owner sees a slim dashed
// placeholder and a viewer sees nothing at all.

const ICONS: Partial<Record<DashboardBlockType, (p: { size?: number }) => ReactNode>> = {
  kpi: (p) => <HashIcon {...p} />,
  gauge: (p) => <ChartIcon {...p} />,
  sparkline: (p) => <ChartIcon {...p} />,
  chart: (p) => <BarChartIcon {...p} />,
  donut: (p) => <DonutIcon {...p} />,
  avatar_list: (p) => <ListIcon {...p} />,
  table: (p) => <TableIcon {...p} />,
  sql: (p) => <SqlIcon {...p} />,
  text: (p) => <TextIcon {...p} />,
  heading: (p) => <HeadingIcon {...p} />,
  divider: (p) => <DividerIcon {...p} />,
  input: (p) => <FilterIcon {...p} />,
  filter: (p) => <FilterIcon {...p} />,
};

export function BlockTypeIcon({ type, size = 16 }: { type: DashboardBlockType; size?: number }) {
  const render = ICONS[type] || ICONS.chart!;
  return <>{render({ size })}</>;
}

export const BLOCK_NOUN: Record<DashboardBlockType, string> = {
  kpi: "KPI", gauge: "gauge", sparkline: "sparkline", chart: "chart", donut: "donut", avatar_list: "top list", table: "table", sql: "SQL cell",
  text: "text", heading: "heading", divider: "divider", input: "input", filter: "filter",
};

export function EmptyBlockBody({ editor, block, compact = false }: { editor: DashboardEditor; block: DashboardBlock; compact?: boolean }) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  const ai = canAskAi(editor, block);
  const query = canEditQuery(editor, block);

  // A block that was just added: bring it on screen and put the caret in
  // its "Describe..." input, once.
  const wanted = editor.focusBlockId === block.id;
  useEffect(() => {
    if (!wanted) return;
    rootRef.current?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    (inputRef.current || actionRef.current)?.focus({ preventScroll: true });
    editor.clearFocusBlock();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted]);

  const build = async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await editor.askAi(block, prompt);
    } catch (e) {
      setError(errorDetail(e, "That couldn't be built. Try describing it differently."));
    } finally {
      setBusy(false);
    }
  };
  const openQuery = () => editor.openSheet({ kind: "query", blockId: block.id });

  return (
    <div ref={rootRef} data-empty-block={block.id} data-no-drag="" className={cn("flex h-full min-h-0 flex-col items-center justify-center gap-2.5 text-center", compact ? "px-0 py-1" : "px-2 py-3")}>
      {!compact && (
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-ctl bg-subtle text-muted">
          <BlockTypeIcon type={block.type} size={18} />
        </span>
      )}
      {ai ? (
        <form className={cn("flex w-full max-w-[440px] gap-2", compact ? "flex-col" : "flex-row items-center")} onSubmit={(e) => { e.preventDefault(); build(); }}>
          <Input
            ref={inputRef}
            data-describe-input=""
            aria-label="Describe what this block should show"
            placeholder={compact ? "Describe it" : "Describe what this block should show"}
            value={prompt}
            disabled={busy}
            onChange={(e) => { setPrompt(e.target.value); setError(null); }}
            className={compact ? "h-8 text-[13px]" : undefined}
          />
          <Button type="submit" variant="primary" loading={busy} disabled={!prompt.trim()} className={cn("shrink-0", compact && "h-8")} data-build-block="">
            {busy ? "Building…" : "Build"}
          </Button>
        </form>
      ) : query ? (
        <>
          <div className="text-ui text-secondary">{block.type === "sql" ? "Write the query for this cell." : `Pick what this ${BLOCK_NOUN[block.type]} shows.`}</div>
          <Button ref={actionRef} variant="primary" onClick={openQuery} data-build-steps="">{block.type === "sql" ? "Write SQL" : "Build step by step"}</Button>
        </>
      ) : (
        <div className="max-w-[360px] text-ui text-muted">This dashboard has no data source linked, so there is nothing to build this block from.</div>
      )}
      {error && (
        <div role="alert" data-empty-error="" className="flex w-full max-w-[440px] items-start gap-2 rounded-ctl border border-danger-border bg-danger-fill px-3 py-2 text-left text-caption text-danger">
          <WarningIcon size={13} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </div>
      )}
      {ai && query && (
        <button type="button" className="ui-focus rounded px-1 text-caption font-medium text-brand-ink hover:underline" onClick={openQuery} data-build-steps="">
          {compact ? "or step by step" : "or build it step by step"}
        </button>
      )}
      {!compact && ai && editor.warehouse && editor.provider && (
        <div className="text-caption text-faint">Computed in {editor.provider} over every row.</div>
      )}
    </div>
  );
}

// The owner's view-mode stand-in for an empty block (a viewer gets nothing).
export function EmptyBlockPlaceholder({ onEdit, noun = "block", className }: { onEdit?: () => void; noun?: string; className?: string }) {
  return (
    <div data-empty-placeholder="" className={cn("flex h-full min-h-[48px] items-center rounded-card border border-dashed border-border-strong px-4 text-caption text-muted", className)}>
      <span>
        Empty {noun} —{" "}
        {onEdit ? (
          <button type="button" className="ui-focus rounded px-0.5 font-medium text-brand-ink hover:underline" onClick={onEdit}>Edit dashboard</button>
        ) : (
          "Edit dashboard"
        )}{" "}
        to build it
      </span>
    </div>
  );
}
