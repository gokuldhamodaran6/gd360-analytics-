import type { ReactNode } from "react";
import { Button } from "./Button";
import { cn } from "./cn";
import { ChevronLeftIcon, ChevronRightIcon } from "./Icons";

// The table shell (System.dc.html "Table card" + Main's "Bookings — detail"):
// sticky header on the subtle fill, 12/500 muted header text (mono when a
// column is a raw column name), 13 px tabular cells, hairline row
// separators, hover tint, NO zebra, numbers right-aligned. Either pass
// typed `columns` + `rows`, or drop your own <table> in as children and the
// frame only supplies the scroll box, sticky-head styling and footer.

export type DataTableColumn<T> = {
  key: string;
  header: ReactNode;
  align?: "left" | "right" | "center";
  // Treat as a numeric column: right-aligned, tabular.
  numeric?: boolean;
  // Header is a raw column name -> mono.
  mono?: boolean;
  width?: number | string;
  render?: (row: T, index: number) => ReactNode;
  className?: string;
};

export type DataTableFrameProps<T> = {
  columns?: DataTableColumn<T>[];
  rows?: T[];
  rowKey?: (row: T, index: number) => string | number;
  onRowClick?: (row: T, index: number) => void;
  selectedKey?: string | number | null;
  children?: ReactNode;
  footer?: ReactNode;
  maxHeight?: number | string;
  // Smaller row padding for in-card tables (7 px) vs full pages (8 px).
  dense?: boolean;
  emptyText?: ReactNode;
  loading?: boolean;
  // Remove the outer border/radius (when inside a ChartCard with flush body).
  bare?: boolean;
  className?: string;
  ariaLabel?: string;
  caption?: ReactNode;
};

export function DataTableFrame<T>({
  columns, rows, rowKey, onRowClick, selectedKey, children, footer, maxHeight = 480, dense = false, emptyText = "No rows", loading = false, bare = false, className, ariaLabel, caption,
}: DataTableFrameProps<T>) {
  const cellPad = dense ? "px-3 py-[6px]" : "px-3.5 py-2";
  const headPad = dense ? "px-3 py-[6px]" : "px-3.5 py-2";
  return (
    <div className={cn("flex min-w-0 flex-col overflow-hidden bg-surface", !bare && "rounded-card border border-border shadow-card", className)}>
      <div className="min-h-0 overflow-auto" style={{ maxHeight: typeof maxHeight === "number" ? `${maxHeight}px` : maxHeight }}>
        {children ? (
          <div className="ui-table-shell [&_table]:w-full [&_table]:border-collapse [&_table]:text-[13px] [&_table]:tabular-nums [&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:z-10 [&_thead_th]:bg-subtle [&_thead_th]:text-left [&_thead_th]:text-caption [&_thead_th]:font-medium [&_thead_th]:text-muted [&_thead_th]:border-b [&_thead_th]:border-border [&_tbody_tr]:border-t [&_tbody_tr]:border-subtle [&_tbody_tr:hover]:bg-subtle/60 [&_th]:px-3 [&_th]:py-[7px] [&_td]:px-3 [&_td]:py-[7px]">
            {children}
          </div>
        ) : (
          <table className="w-full border-collapse text-[13px] tabular-nums" aria-label={ariaLabel} aria-busy={loading || undefined}>
            {caption && <caption className="sr-only">{caption}</caption>}
            <thead>
              <tr>
                {columns?.map((c) => (
                  <th
                    key={c.key}
                    scope="col"
                    style={c.width !== undefined ? { width: typeof c.width === "number" ? `${c.width}px` : c.width } : undefined}
                    className={cn(
                      "sticky top-0 z-10 border-b border-border bg-subtle text-caption font-medium text-muted whitespace-nowrap",
                      headPad,
                      c.numeric || c.align === "right" ? "text-right" : c.align === "center" ? "text-center" : "text-left",
                      c.mono && "font-mono text-[11.5px]",
                      c.className
                    )}
                  >
                    {c.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading && (!rows || rows.length === 0)
                ? Array.from({ length: 5 }, (_, i) => (
                    <tr key={`s-${i}`} className="border-t border-subtle">
                      {columns?.map((c) => (
                        <td key={c.key} className={cellPad}><div className="ui-shimmer h-3.5 w-3/4" /></td>
                      ))}
                    </tr>
                  ))
                : rows && rows.length > 0
                  ? rows.map((row, i) => {
                      const key = rowKey ? rowKey(row, i) : i;
                      const selected = selectedKey !== undefined && selectedKey !== null && key === selectedKey;
                      return (
                        <tr
                          key={key}
                          onClick={onRowClick ? () => onRowClick(row, i) : undefined}
                          aria-selected={selected || undefined}
                          className={cn(
                            "border-t border-subtle transition-colors",
                            onRowClick && "cursor-pointer",
                            selected ? "bg-tint" : "hover:bg-subtle/60"
                          )}
                        >
                          {columns?.map((c) => (
                            <td
                              key={c.key}
                              className={cn(
                                cellPad,
                                "text-text",
                                c.numeric || c.align === "right" ? "text-right" : c.align === "center" ? "text-center" : "text-left",
                                c.className
                              )}
                            >
                              {c.render ? c.render(row, i) : (row as Record<string, ReactNode>)[c.key]}
                            </td>
                          ))}
                        </tr>
                      );
                    })
                  : (
                    <tr>
                      <td colSpan={columns?.length || 1} className="px-4 py-8 text-center text-caption text-muted">{emptyText}</td>
                    </tr>
                  )}
            </tbody>
          </table>
        )}
      </div>
      {footer && <div className="shrink-0 border-t border-subtle bg-subtle/60">{footer}</div>}
    </div>
  );
}

export type PaginationFooterProps = {
  start: number; // 1-based
  end: number;
  total: number;
  pageSize?: number;
  onLoadMore?: () => void;
  // Classic prev/next paging as an alternative to "Load N more".
  onPrev?: () => void;
  onNext?: () => void;
  loading?: boolean;
  noun?: string;
  // "exact" or "approximate" row count wording ("of ~119,386").
  approximate?: boolean;
  className?: string;
};

export function PaginationFooter({ start, end, total, pageSize = 50, onLoadMore, onPrev, onNext, loading = false, noun = "", approximate = false, className }: PaginationFooterProps) {
  const remaining = Math.max(0, total - end);
  const loadCount = Math.min(pageSize, remaining);
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-2 px-3.5 py-2 text-caption text-muted tabular-nums", className)}>
      <span>
        {total === 0 ? "0" : `${start.toLocaleString()}–${end.toLocaleString()}`} of {approximate ? "~" : ""}{total.toLocaleString()}{noun ? ` ${noun}` : ""}
      </span>
      <span className="flex items-center gap-1.5">
        {onLoadMore && remaining > 0 && (
          <>
            <span aria-hidden="true">·</span>
            <button type="button" onClick={onLoadMore} disabled={loading} className="ui-focus rounded px-1 font-medium text-brand-ink hover:underline disabled:text-faint disabled:no-underline">
              {loading ? "Loading…" : `Load ${loadCount.toLocaleString()} more`}
            </button>
          </>
        )}
        {(onPrev || onNext) && (
          <>
            <Button variant="secondary" size="sm" iconOnly className="h-6 w-6 rounded-[6px]" disabled={!onPrev || loading} onClick={onPrev} aria-label="Previous page" icon={<ChevronLeftIcon size={12} />}>
              Previous page
            </Button>
            <Button variant="secondary" size="sm" iconOnly className="h-6 w-6 rounded-[6px]" disabled={!onNext || loading} onClick={onNext} aria-label="Next page" icon={<ChevronRightIcon size={12} />}>
              Next page
            </Button>
          </>
        )}
      </span>
    </div>
  );
}
