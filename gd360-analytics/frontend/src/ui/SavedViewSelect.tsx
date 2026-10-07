import type { ReactNode } from "react";
import { cn } from "./cn";
import { ChevronDownIcon, EditIcon, PlusIcon, TrashIcon } from "./Icons";
import { MenuSelect, type SelectOption } from "./Select";

// "View: Revenue focus v" - a MenuSelect listing saved filter views, with
// per-row Rename/Delete affordances (real buttons, visible on hover/focus)
// and a "Save current view..." action row. Everything is a callback: this
// component never owns the view list.

export type SavedView = { id: string; name: string; description?: ReactNode; readonly?: boolean };

export type SavedViewSelectProps = {
  views: SavedView[];
  value: string | null;
  onChange: (id: string) => void;
  onSaveCurrent?: () => void;
  onRename?: (id: string) => void;
  onDelete?: (id: string) => void;
  // Shown when `value` is null (filters changed since the view was applied).
  placeholder?: ReactNode;
  prefix?: ReactNode;
  // True when the current filters differ from the selected view.
  dirty?: boolean;
  size?: "sm" | "md";
  width?: number | string | "trigger";
  align?: "start" | "end";
  className?: string;
  disabled?: boolean;
};

export function SavedViewSelect({
  views,
  value,
  onChange,
  onSaveCurrent,
  onRename,
  onDelete,
  placeholder = "Unsaved view",
  prefix = "View:",
  dirty = false,
  size = "md",
  width = 280,
  align = "start",
  className,
  disabled,
}: SavedViewSelectProps) {
  const options: SelectOption[] = views.map((v) => ({
    value: v.id,
    label: v.name,
    description: v.description,
  }));
  const selectedName = views.find((v) => v.id === value)?.name;

  return (
    <MenuSelect
      options={options}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      prefix={prefix}
      size={size}
      width={width}
      align={align}
      className={className}
      disabled={disabled}
      ariaLabel="Saved views"
      trigger={({ open }) => (
        <>
          <span className="flex min-w-0 items-center gap-1.5 truncate">
            {prefix && <span className="shrink-0 text-muted">{prefix}</span>}
            <span className={cn("truncate", !selectedName && "text-muted")}>{selectedName || placeholder}</span>
            {dirty && selectedName && <span className="shrink-0 text-caption font-normal text-muted">· edited</span>}
          </span>
          <ChevronDownIcon size={14} className={cn("shrink-0 text-muted transition-transform", open && "rotate-180")} />
        </>
      )}
      renderOptionExtra={
        onRename || onDelete
          ? (o, { close }) => {
              const v = views.find((x) => x.id === o.value);
              if (!v || v.readonly) return null;
              return (
                <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100">
                  {onRename && (
                    <button
                      type="button"
                      aria-label={`Rename ${v.name}`}
                      title="Rename"
                      tabIndex={-1}
                      onClick={(e) => { e.stopPropagation(); close(); onRename(v.id); }}
                      className="ui-focus inline-flex h-6 w-6 items-center justify-center rounded-[5px] text-muted hover:bg-subtle hover:text-text"
                    >
                      <EditIcon size={13} />
                    </button>
                  )}
                  {onDelete && (
                    <button
                      type="button"
                      aria-label={`Delete ${v.name}`}
                      title="Delete"
                      tabIndex={-1}
                      onClick={(e) => { e.stopPropagation(); close(); onDelete(v.id); }}
                      className="ui-focus inline-flex h-6 w-6 items-center justify-center rounded-[5px] text-muted hover:bg-danger-fill hover:text-danger"
                    >
                      <TrashIcon size={13} />
                    </button>
                  )}
                </span>
              );
            }
          : undefined
      }
      footer={
        onSaveCurrent
          ? ({ close }) => (
              <button
                type="button"
                role="menuitem"
                onClick={() => { close(); onSaveCurrent(); }}
                className="ui-focus-inset flex w-full items-center gap-2.5 px-3 py-2 text-left text-ui font-medium text-brand-ink hover:bg-subtle"
              >
                <PlusIcon size={14} />
                Save current view…
              </button>
            )
          : undefined
      }
    />
  );
}
