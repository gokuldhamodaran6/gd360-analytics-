import { useMemo, useState, type ReactNode } from "react";
import { Checkbox } from "./Checkbox";
import { labelText, optionLabelNode, type CheckboxListOption } from "./CheckboxList";
import { cn } from "./cn";
import { SearchInput } from "./Input";

// The rail's "search a high-cardinality column" control (Main.dc.html
// "Country": a search box, the top N values with counts as checkable rows,
// and a "+173 more" line). Controlled like MultiSelect: `options` are the
// values the parent currently knows about (top-N from the warehouse),
// `total` is how many distinct values exist so the overflow line can say
// "+N more"; `onSearch` re-queries, `loading` shows a shimmer. Selected
// values that the current search would hide (picked earlier, then searched
// away, or no longer in the top N) stay pinned at the top so they can
// always be unchecked.

export type OptionSearchProps = {
  options: CheckboxListOption[];
  value: string[];
  onChange: (value: string[]) => void;
  onSearch?: (query: string) => void;
  loading?: boolean;
  // Total distinct values in the column (for "+N more").
  total?: number;
  // Rows to show before the "+N more" line (default 8).
  limit?: number;
  // Called when the person clicks "+N more" (e.g. open the full list).
  onShowMore?: () => void;
  placeholder?: string;
  emptyText?: ReactNode;
  mono?: boolean;
  formatCount?: (count: number | string) => ReactNode;
  ariaLabel?: string;
  className?: string;
};

const defaultFormat = (c: number | string) => (typeof c === "number" ? c.toLocaleString() : c);

export function OptionSearch({
  options, value, onChange, onSearch, loading = false, total, limit = 8, onShowMore, placeholder = "Search values", emptyText = "No matches", mono = false, formatCount = defaultFormat, ariaLabel = "Values", className,
}: OptionSearchProps) {
  const [query, setQuery] = useState("");
  const selectedSet = useMemo(() => new Set(value), [value]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || onSearch) return options;
    return options.filter((o) => labelText(o.label, o.value).toLowerCase().includes(q));
  }, [options, query, onSearch]);

  // Pinned: selected values the visible slice would otherwise hide.
  const shown = filtered.slice(0, limit);
  const pinned = useMemo<CheckboxListOption[]>(
    () => value.filter((v) => !shown.some((o) => o.value === v)).map((v) => options.find((o) => o.value === v) ?? { value: v, label: v }),
    [value, shown, options] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const rows: CheckboxListOption[] = [...pinned, ...shown];
  const hiddenLocal = Math.max(0, filtered.length - limit);
  const more = typeof total === "number" ? Math.max(0, total - Math.min(limit, filtered.length)) : hiddenLocal;

  const toggle = (v: string) => {
    if (selectedSet.has(v)) onChange(value.filter((x) => x !== v));
    else onChange([...value, v]);
  };

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <SearchInput
        value={query}
        onChange={(q) => { setQuery(q); onSearch?.(q); }}
        placeholder={placeholder}
        aria-label={placeholder}
        size="sm"
      />
      <div role="group" aria-label={ariaLabel} aria-busy={loading || undefined} className="flex flex-col">
        {loading && rows.length === 0 ? (
          <div className="flex flex-col gap-2 py-1.5" aria-hidden="true">
            {[0, 1, 2, 3, 4].map((i) => <div key={i} className="ui-shimmer h-3.5" style={{ width: `${80 - i * 8}%` }} />)}
          </div>
        ) : rows.length === 0 ? (
          <div className="py-1.5 text-caption text-muted">{emptyText}</div>
        ) : (
          rows.map((o) => (
            <Checkbox
              key={o.value}
              label={optionLabelNode(o)}
              count={o.count !== undefined ? formatCount(o.count) : undefined}
              checked={selectedSet.has(o.value)}
              disabled={o.disabled}
              onChange={() => toggle(o.value)}
              className={cn("-mx-1 rounded-[5px] px-1 py-[5px] hover:bg-subtle", mono && "[&>span>span]:font-mono [&>span>span]:text-[12.5px]")}
            />
          ))
        )}
        {more > 0 && (
          onShowMore ? (
            <button type="button" onClick={onShowMore} className="ui-focus mt-0.5 self-start rounded px-0.5 text-caption font-medium text-brand-ink hover:underline">
              +{more.toLocaleString()} more
            </button>
          ) : (
            <div className="mt-0.5 text-caption text-muted">+{more.toLocaleString()} more</div>
          )
        )}
      </div>
      {value.length > 0 && (
        <div className="flex items-center justify-between text-caption">
          <span className="text-muted">{value.length} selected</span>
          <button type="button" onClick={() => onChange([])} className="ui-focus rounded px-0.5 text-muted hover:text-text hover:underline">Clear</button>
        </div>
      )}
    </div>
  );
}
