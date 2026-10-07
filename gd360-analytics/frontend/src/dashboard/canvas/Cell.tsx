import { forwardRef, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { CommentAnchor } from "../../api/client";
import {
  ArrowDownIcon, ArrowUpIcon, Badge, CommentIcon, CopyIcon, DownloadIcon, EditIcon, IconButton, MoreIcon, Popover, RefreshIcon, SqlIcon, TrashIcon, cn,
} from "../../ui";
import { downloadText, resultOk, rowsToCsv, safeFilename } from "../blockData";
import { MenuRow, SqlSheet, type BlockSqlInfo } from "../BlockGrid";
import { SwapChips } from "../menu";
import { BlockComments } from "../comments/CommentThread";
import { TYPE_LABEL, formatIndexSet, sourcesOf, type CellInfo } from "./cells";
import { DataCell } from "./DataCell";
import { InputCell } from "./InputCell";
import { KIND_ICON } from "./OutlinePanel";
import { SqlCell } from "./SqlCell";
import { TextCell } from "./TextCell";
import type { CellBodyProps } from "./types";

// 2026-10-07 (analyst canvas round, OptionC.dc.html): one numbered cell.
// Left gutter (the number and the kind glyph), a card with the header
// (title - inline-editable for the owner - the type pill, "← cell 2",
// and the toolbar: Show SQL / Edit, Comment with its count, ⋯ with Swap
// chart · Move up / down · Duplicate · Delete), the body for the cell's
// kind, and the comment threads pinned to it. The article is focusable
// (↑/↓ move focus, Enter edits, Esc leaves - handled by CanvasView).

export type CellProps = Omit<CellBodyProps, "pickingAnchor" | "onPickAnchor" | "editing" | "onStartEdit" | "onStopEdit"> & {
  focused: boolean;
  editing: boolean;
  onFocus: () => void;
  onStartEdit: () => void;
  onStopEdit: () => void;
  onMove?: (dir: "up" | "down") => Promise<void>;
  onDuplicate?: () => Promise<void>;
  onDelete?: () => Promise<void>;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  commentCount?: { open: number; total: number };
};

function TitleEditor({ value, onSave, onCancel }: { value: string; onSave: (v: string) => Promise<void>; onCancel: () => void }) {
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  const commit = async () => {
    if (busy) return;
    if (draft.trim() === value.trim()) { onCancel(); return; }
    setBusy(true);
    try { await onSave(draft.trim()); } finally { setBusy(false); }
  };
  return (
    <input
      ref={ref}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        if (e.key === "Escape") onCancel();
      }}
      maxLength={120}
      aria-label="Cell title"
      data-cell-title-input=""
      className="ui-focus h-7 w-full min-w-[160px] rounded-ctl border border-border bg-surface px-2 text-body font-semibold text-text"
    />
  );
}

export const Cell = forwardRef<HTMLElement, CellProps>(function Cell(props, ref) {
  const {
    cell, cells, run, source, mode, parameters, owner, comments, focused, editing, onFocus, onStartEdit, onStopEdit, rerunWithDependents, fetchSql,
    onMove, onDuplicate, onDelete, canMoveUp = true, canMoveDown = true, compact = false, commentCount,
  } = props;
  const block = cell.block;
  const Icon = KIND_ICON[cell.kind];
  const [renaming, setRenaming] = useState(false);
  const [sqlOpen, setSqlOpen] = useState(false);
  const [sqlInfo, setSqlInfo] = useState<BlockSqlInfo | null>(null);
  const [sqlLoading, setSqlLoading] = useState(false);
  const [sqlError, setSqlError] = useState<string | null>(null);
  const [sqlCollapsed, setSqlCollapsed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const count = commentCount ?? (comments.enabled ? comments.countFor(block.id) : { open: 0, total: 0 });
  const [commentsOpen, setCommentsOpen] = useState(count.open > 0);
  // Threads load after the cell mounts: open the section the first time an
  // unresolved thread shows up, unless the person already hid it.
  const hiddenByUser = useRef(false);
  const hasOpen = count.open > 0;
  useEffect(() => { if (hasOpen && !hiddenByUser.current) setCommentsOpen(true); }, [hasOpen]);
  const [composing, setComposing] = useState(false);
  const [anchor, setAnchor] = useState<CommentAnchor | null>(null);
  const result = run.results[block.id];
  const sources = sourcesOf(block.id, run.dependencies, cells, block);
  const isData = cell.kind === "chart" || cell.kind === "kpi" || cell.kind === "table";
  const swappable = Boolean(owner?.swapBlock) && (Boolean(block.config?.spec) || Boolean(block.config?.source_block_id)) && isData;

  const openSql = async () => {
    setSqlOpen(true);
    setSqlError(null);
    if (fetchSql) {
      setSqlLoading(true);
      try { setSqlInfo(await fetchSql(block)); } catch (e: any) { setSqlError(e?.response?.data?.detail || "Couldn't load this cell's SQL."); } finally { setSqlLoading(false); }
    } else if (result?.sql) {
      setSqlInfo({ sql: result.sql, dialect: result.computed_in });
    } else {
      setSqlInfo({ sql: block.query_sql || block.config?.sql || "", dialect: block.config?.computed_in });
    }
  };
  const startComment = () => {
    setCommentsOpen(true);
    setComposing(true);
    setAnchor(null);
  };
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setActionError(null);
    try { await fn(); } catch (e: any) { const d = e?.response?.data?.detail; setActionError(typeof d === "string" ? d : e?.message || "That didn't work."); } finally { setBusy(false); }
  };
  const stored = mode === "file" ? run.overrides[block.id]?.config ?? block.config ?? {} : null;
  const storedColumns: string[] = stored
    ? (Array.isArray(stored.columns) ? stored.columns : Array.isArray(stored.result_columns) ? stored.result_columns : []).map((c: any) => (typeof c === "string" ? c : String(c?.name ?? "")))
    : [];
  const storedRows: Record<string, any>[] = stored ? (Array.isArray(stored.rows) ? stored.rows : Array.isArray(stored.result_rows) ? stored.result_rows : []) : [];
  const canDownload = resultOk(result) || storedColumns.length > 0;
  const downloadCsv = () => {
    if (resultOk(result)) downloadText(`${safeFilename(block.title || cell.name)}.csv`, rowsToCsv(result.columns.map((c) => c.name), result.rows));
    else if (storedColumns.length) downloadText(`${safeFilename(block.title || cell.name)}.csv`, rowsToCsv(storedColumns, storedRows));
  };

  const bodyProps: CellBodyProps = {
    cell, cells, run, source, mode, parameters, owner, comments, editing, onStartEdit, onStopEdit, rerunWithDependents, fetchSql, compact,
    pickingAnchor: composing && isData && cell.kind !== "kpi" && !anchor && comments.enabled,
    onPickAnchor: (a) => setAnchor(a),
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    // Only when the article itself has focus (not a control inside it).
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" && owner) { e.preventDefault(); onStartEdit(); }
  };

  return (
    <article
      ref={ref}
      tabIndex={0}
      data-cell-id={block.id}
      data-cell-index={cell.index}
      data-cell-kind={cell.kind}
      data-focused={focused ? "" : undefined}
      data-editing={editing ? "" : undefined}
      aria-label={`Cell ${cell.index}: ${cell.label}`}
      onFocus={(e) => { if (e.target === e.currentTarget || !focused) onFocus(); }}
      onKeyDown={onKeyDown}
      className={cn("group/cell ui-focus flex gap-3 rounded-card outline-none", compact && "min-w-0 flex-1")}
    >
      <div className={cn("flex w-8 shrink-0 flex-col items-center gap-1 pt-3", compact && "w-6")} aria-hidden="true" data-cell-gutter="">
        <span className={cn("font-mono text-caption font-medium tabular-nums", focused ? "text-brand-ink" : "text-muted")}>{cell.index}</span>
        <Icon size={13} className={cn(focused ? "text-brand-ink" : "text-faint")} />
      </div>
      <div className={cn("flex min-w-0 flex-1 flex-col rounded-card border bg-surface shadow-card transition-colors", focused ? "border-primary/60 ring-1 ring-primary/30" : "border-border")}>
        <header className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 pb-2 pt-3">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {renaming && owner ? (
              <TitleEditor
                value={block.title || ""}
                onCancel={() => setRenaming(false)}
                onSave={async (v) => { await act(() => owner.updateBlock(block.id, { title: v }).then(() => undefined)); setRenaming(false); }}
              />
            ) : (
              <h3
                className={cn("min-w-0 truncate text-body font-semibold text-text", cell.kind === "sql" && !block.title && "font-mono", owner && "cursor-text")}
                onClick={owner ? () => setRenaming(true) : undefined}
                title={owner ? "Click to rename" : undefined}
                data-cell-title=""
              >
                {cell.label}
              </h3>
            )}
            <Badge variant="neutral" className="shrink-0" title={block.type}>{TYPE_LABEL[block.type] || block.type}{cell.kind === "kpi" ? "" : " cell"}</Badge>
            {sources.length > 0 && (
              <span className="shrink-0 font-mono text-caption text-muted" data-cell-sources="">← cell{sources.length > 1 ? "s" : ""} {formatIndexSet(sources).replace(/, /g, " · ")}</span>
            )}
            {block.type === "sql" && block.config?.computed_in && !compact && <span className="shrink-0 text-caption text-muted">{String(block.config.computed_in)}</span>}
          </div>
          <div className="flex shrink-0 items-center gap-0.5" data-cell-toolbar="">
            {cell.kind === "sql" ? (
              // A published link never shows (or receives) the statement.
              !source.hideSql && (
                <button type="button" className="ui-focus h-7 rounded-ctl px-2 text-caption font-medium text-secondary hover:bg-subtle hover:text-text" onClick={() => setSqlCollapsed((c) => !c)} aria-expanded={!sqlCollapsed} data-toggle-sql="">
                  {sqlCollapsed ? "Show SQL" : "Hide SQL"}
                </button>
              )
            ) : cell.kind === "text" ? (
              owner && !editing && <button type="button" className="ui-focus inline-flex h-7 items-center gap-1 rounded-ctl px-2 text-caption font-medium text-secondary hover:bg-subtle hover:text-text" onClick={onStartEdit} data-edit-cell=""><EditIcon size={13} /> Edit</button>
            ) : isData && mode === "warehouse" && !source.hideSql ? (
              <button type="button" className="ui-focus inline-flex h-7 items-center gap-1 rounded-ctl px-2 text-caption font-medium text-secondary hover:bg-subtle hover:text-text" onClick={openSql} data-show-sql=""><SqlIcon size={13} /> Show SQL</button>
            ) : null}
            {comments.enabled && (
              <button type="button" className="ui-focus inline-flex h-7 items-center gap-1 rounded-ctl px-2 text-caption font-medium text-secondary hover:bg-subtle hover:text-text" onClick={startComment} data-comment-button="" aria-label={`Comment${count.total ? ` (${count.total})` : ""}`}>
                <CommentIcon size={13} /> Comment
                {count.total > 0 && <span className={cn("ml-0.5 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums", count.open > 0 ? "bg-primary text-white" : "bg-subtle text-muted")} data-comment-count="">{count.total}</span>}
              </button>
            )}
            <Popover
              align="end"
              width={220}
              haspopup="menu"
              role="menu"
              ariaLabel="Cell options"
              trigger={(api) => <IconButton size="sm" aria-label="More options" title="More options" icon={<MoreIcon size={15} />} data-popover-trigger="" {...api.props} />}
            >
              {({ close }) => (
                <div className="py-1" data-cell-menu="">
                  {mode === "warehouse" && (cell.kind === "sql" || isData) && (
                    <MenuRow icon={<RefreshIcon size={14} />} onClick={() => { close(); rerunWithDependents(block.id); }}>Recompute</MenuRow>
                  )}
                  {(cell.kind === "sql" || isData) && (
                    <MenuRow icon={<DownloadIcon size={14} />} onClick={() => { close(); downloadCsv(); }} disabled={!canDownload}>Download CSV</MenuRow>
                  )}
                  {owner && (
                    <>
                      <div className="my-1 border-t border-subtle" />
                      {swappable && (
                        <div className="pt-2">
                          <div className="mb-1 px-3 text-caption font-medium uppercase tracking-caps text-muted">Swap chart</div>
                          <SwapChips block={block} result={run.results[block.id]} busy={busy} onSwap={(payload) => act(async () => { await owner.swapBlock!(block.id, payload); rerunWithDependents(block.id); close(); })} />
                        </div>
                      )}
                      {onMove && <MenuRow icon={<ArrowUpIcon size={14} />} disabled={busy || !canMoveUp} onClick={() => { close(); act(() => onMove("up")); }}>Move up</MenuRow>}
                      {onMove && <MenuRow icon={<ArrowDownIcon size={14} />} disabled={busy || !canMoveDown} onClick={() => { close(); act(() => onMove("down")); }}>Move down</MenuRow>}
                      {onDuplicate && <MenuRow icon={<CopyIcon size={14} />} disabled={busy} onClick={() => { close(); act(onDuplicate); }}>Duplicate</MenuRow>}
                      {onDelete && (
                        <MenuRow danger icon={<TrashIcon size={14} />} disabled={busy} onClick={() => { close(); if (window.confirm(`Delete cell ${cell.index} (${cell.label})?`)) act(onDelete); }}>
                          Delete
                        </MenuRow>
                      )}
                    </>
                  )}
                </div>
              )}
            </Popover>
          </div>
        </header>
        {actionError && <div role="alert" className="mx-4 mb-2 rounded-ctl border border-danger-border bg-danger-fill px-3 py-2 text-caption text-danger">{actionError}</div>}
        <div className="min-w-0" data-cell-body="">
          {cell.kind === "sql" ? (
            sqlCollapsed ? <SqlCollapsed {...bodyProps} /> : <SqlCell {...bodyProps} />
          ) : cell.kind === "text" ? (
            <TextCell {...bodyProps} />
          ) : cell.kind === "input" ? (
            <InputCell {...bodyProps} />
          ) : (
            <DataCell {...bodyProps} />
          )}
        </div>
        {comments.enabled && (commentsOpen || composing) && !compact && (
          <div className="border-t border-subtle bg-subtle/40 px-4 py-3" data-cell-comments="">
            <div className="mb-2 flex items-center justify-between text-caption text-muted">
              <span>{count.total ? `${count.total} comment${count.total === 1 ? "" : "s"} · ${count.open} open` : "Comments"}</span>
              <button type="button" className="ui-focus rounded px-0.5 hover:text-text hover:underline" onClick={() => { hiddenByUser.current = true; setCommentsOpen(false); setComposing(false); setAnchor(null); }}>Hide</button>
            </div>
            <BlockComments
              blockId={block.id}
              comments={comments}
              anchor={anchor}
              onClearAnchor={() => setAnchor(null)}
              composing={composing}
              onDoneComposing={() => { setComposing(false); setAnchor(null); }}
              pickHint={isData && cell.kind !== "kpi" ? <span>New comment on this cell — or click a mark on the chart to pin it there</span> : undefined}
            />
          </div>
        )}
        {comments.enabled && !commentsOpen && !composing && count.total > 0 && !compact && (
          <button type="button" className="ui-focus flex items-center gap-1.5 border-t border-subtle px-4 py-2 text-left text-caption text-muted hover:bg-subtle hover:text-text" onClick={() => setCommentsOpen(true)} data-show-comments="">
            <CommentIcon size={13} /> {count.total} comment{count.total === 1 ? "" : "s"}{count.open ? ` · ${count.open} open` : " · all resolved"}
          </button>
        )}
      </div>
      {sqlOpen && <SqlSheet open={sqlOpen} onClose={() => setSqlOpen(false)} block={block} info={sqlInfo} loading={sqlLoading} error={sqlError} />}
    </article>
  );
});

// A SQL cell with its statement folded away: just the status line and
// the preview (OptionC.dc.html's "3 SQL cells, collapsed" reads like this).
function SqlCollapsed(props: CellBodyProps) {
  const { cell, run } = props;
  const result = run.results[cell.id];
  const rows = resultOk(result) ? result.row_count ?? result.rows.length : null;
  return (
    <div className="px-4 pb-3 text-caption text-muted" data-sql-collapsed="">
      <code className="font-mono text-text">{cell.name || cell.label}</code>
      {typeof rows === "number" && <> · {rows.toLocaleString()} row{rows === 1 ? "" : "s"}</>}
      {resultOk(result) && typeof result.duration_ms === "number" && <> · {(result.duration_ms / 1000).toFixed(1)} s</>}
      {result && result.status !== "ok" && <span className="text-danger"> · {result.error || "failed"}</span>}
    </div>
  );
}

