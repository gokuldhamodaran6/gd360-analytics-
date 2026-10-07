import { useMemo, useState, type ReactNode } from "react";
import { Checkbox } from "./Checkbox";
import { cn } from "./cn";
import { SearchInput } from "./Input";

// The "Checkbox list · with counts" block: optional search at the top,
// one row per option (label + right-aligned count), "Select all N / Clear"
// in the footer. Fully controlled: `value` (alias `selected`) in,
// `onChange(next)` out. With `onSearch` the list no longer filters locally
// - the parent re-queries the warehouse for the typed text and passes the
// new `options` back (with `loading` while it does).

// `swatch`: a small mark drawn before the label (a value's chart colour) -
// decorative; the label still names the value.
export type CheckboxListOption = { value: string; label?: ReactNode; count?: number | string; disabled?: boolean; swatch?: ReactNode };

/** A row's label with its optional swatch in front. */
export function optionLabelNode(o: CheckboxListOption): ReactNode {
  if (!o.swatch) return o.label ?? o.value;
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 align-top">
      {o.swatch}
      <span className="min-w-0 truncate">{o.label ?? o.value}</span>
    </span>
  );
}

export type CheckboxListProps = {
  options: CheckboxListOption[];
  value?: string[];
  // Earlier name of `value`.
  selected?: string[];
  onChange: (selected: string[]) => void;
  searchable?: boolean;
  searchPlaceholder?: string;
  // Controlled search, if the parent wants to own it.
  query?: string;
  onQueryChange?: (q: string) => void;
  // Server-side search: called with the query; local filtering is skipped.
  onSearch?: (query: string) => void;
  loading?: boolean;
  maxHeight?: number | string;
  showFooter?: boolean;
  emptyText?: ReactNode;
  formatCount?: (count: number | string) => ReactNode;
  // Frame the list with a border (default) or render it flush inside a popover.
  framed?: boolean;
  className?: string;
  ariaLabel?: string;
};

const defaultFormat = (c: number | string) => (typeof c === "number" ? c.toLocaleString() : c);

export function labelText(label: ReactNode | undefined, value: string): string {
  return typeof label === "string" || typeof label === "number" ? String(label) : value;
}

export function CheckboxList({
  options,
  value,
  selected: selectedProp,
  onChange,
  searchable = true,
  searchPlaceholder = "Search values",
  query: queryProp,
  onQueryChange,
  onSearch,
  loading = false,
  maxHeight = 240,
  showFooter = true,
  emptyText = "No matches",
  formatCount = defaultFormat,
  framed = true,
  className,
  ariaLabel,
}: CheckboxListProps) {
  const selected = value ?? selectedProp ?? [];
  const [innerQuery, setInnerQuery] = useState("");
  const query = queryProp ?? innerQuery;
  const setQuery = (q: string) => { setInnerQuery(q); onQueryChange?.(q); onSearch?.(q); };

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || onSearch) return options;
    return options.filter((o) => labelText(o.label, o.value).toLowerCase().includes(q));
  }, [options, query, onSearch]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const toggle = (value: string) => {
    if (selectedSet.has(value)) onChange(selected.filter((v) => v !== value));
    else onChange([...selected, value]);
  };
  const selectAllVisible = () => {
    const next = new Set(selected);
    visible.forEach((o) => { if (!o.disabled) next.add(o.value); });
    onChange(Array.from(next));
  };
  const clear = () => onChange([]);
  const allVisibleSelected = visible.length > 0 && visible.every((o) => o.disabled || selectedSet.has(o.value));

  return (
    <div className={cn("flex flex-col overflow-hidden bg-surface", framed && "rounded-ctl border border-border", className)}>
      {searchable && (
        <div className="border-b border-subtle">
          <SearchInput value={query} onChange={setQuery} placeholder={searchPlaceholder} size="sm" flush aria-label={searchPlaceholder} />
        </div>
      )}
      <div role="group" aria-label={ariaLabel} aria-busy={loading || undefined} className="overflow-y-auto py-1" style={{ maxHeight: typeof maxHeight === "number" ? `${maxHeight}px` : maxHeight }}>
        {loading && visible.length === 0 ? (
          <div className="flex flex-col gap-2 px-2.5 py-2" aria-hidden="true">
            {[0, 1, 2, 3].map((i) => <div key={i} className="ui-shimmer h-3.5" style={{ width: `${78 - i * 9}%` }} />)}
          </div>
        ) : visible.length === 0 ? (
          <div className="px-2.5 py-2 text-caption text-muted">{emptyText}</div>
        ) : (
          visible.map((o) => (
            <Checkbox
              key={o.value}
              label={optionLabelNode(o)}
              count={o.count !== undefined ? formatCount(o.count) : undefined}
              checked={selectedSet.has(o.value)}
              disabled={o.disabled}
              onChange={() => toggle(o.value)}
              className="px-2.5 py-[7px] hover:bg-subtle"
            />
          ))
        )}
      </div>
      {showFooter && (
        <div className="flex items-center justify-between border-t border-subtle px-2.5 py-[7px] text-caption">
          <button type="button" onClick={selectAllVisible} disabled={allVisibleSelected} className="ui-focus rounded font-medium text-brand-ink hover:underline disabled:text-faint disabled:no-underline">
            Select all {query.trim() ? `${visible.length} shown` : visible.length}
          </button>
          <button type="button" onClick={clear} disabled={selected.length === 0} className="ui-focus rounded text-muted hover:text-text hover:underline disabled:text-faint disabled:no-underline">
            Clear
          </button>
        </div>
      )}
    </div>
  );
}
