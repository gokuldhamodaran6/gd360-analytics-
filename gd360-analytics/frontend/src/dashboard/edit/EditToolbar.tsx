import type { ReactNode } from "react";
import type { DashboardBlockType } from "../../api/client";
import { Button, FilterIcon, PaletteIcon, PlusIcon, Popover, cn } from "../../ui";
import { MenuCaption } from "../menu";
import { BlockTypeIcon } from "./EmptyBlock";
import type { DashboardEditor } from "./useDashboardEditor";

// 2026-10-07 (dashboard edit mode): the one calm row under the header
// while editing - "Add block" (a grouped palette), "Filters" (the rail's
// definition, in a sheet), the one-line hint, and the page tabs on the
// right. It sits exactly where the view's "Dashboards / freshness / tabs"
// row sits and is the same height (CONTEXT_ROW_CLASS), so the KPI strip
// and the grid do not move when the page switches between the two.

export const CONTEXT_ROW_CLASS = "mb-4 flex min-h-[52px] flex-wrap items-center gap-x-3 gap-y-2";

export const EDIT_HINT = "Drag a block by its title to move it · drag the corner to resize · changes save automatically";

// `template`: a block that arrives already built (backend create_block).
type PaletteItem = { type: DashboardBlockType; label: string; hint: string; template?: "forecast" };
type PaletteGroup = { label: string; items: PaletteItem[] };

export function paletteGroups(warehouse: boolean): PaletteGroup[] {
  return [
    { label: "Numbers", items: [{ type: "kpi", label: "KPI", hint: "One number, with its change" }] },
    {
      label: "Charts",
      items: [
        { type: "chart", label: "Chart", hint: "Bars, lines, maps, heatmaps…" },
        // 2026-10-07 (chart-types round): a trend with its projection -
        // rows per period over the dashboard's date column, forecast on.
        { type: "chart", label: "Forecast", hint: "A trend and where it is heading", template: "forecast" },
        { type: "donut", label: "Donut", hint: "Share of a whole" },
        { type: "avatar_list", label: "Top list", hint: "A ranked leaderboard" },
      ],
    },
    { label: "Tables", items: [{ type: "table", label: "Table", hint: "Rows and columns" }] },
    ...(warehouse ? [{ label: "SQL", items: [{ type: "sql" as DashboardBlockType, label: "SQL cell", hint: "Your own SELECT" }] }] : []),
    {
      label: "Layout",
      items: [
        { type: "text", label: "Text", hint: "A note" },
        { type: "heading", label: "Heading", hint: "A section title" },
        { type: "divider", label: "Divider", hint: "A rule between sections" },
      ],
    },
  ];
}

export function AddBlockPalette({ editor, align = "start" }: { editor: DashboardEditor; align?: "start" | "end" }) {
  const groups = paletteGroups(editor.warehouse);
  return (
    <Popover
      align={align}
      width={300}
      haspopup="menu"
      role="menu"
      ariaLabel="Add block"
      trigger={(api) => (
        <Button variant="secondary" icon={<PlusIcon size={15} />} loading={editor.adding} data-popover-trigger="" data-add-block="" {...api.props}>
          Add block
        </Button>
      )}
    >
      {({ close }) => (
        <div className="max-h-[70vh] overflow-y-auto py-1" data-add-block-palette="">
          {groups.map((g) => (
            <div key={g.label} role="group" aria-label={g.label}>
              <MenuCaption>{g.label}</MenuCaption>
              {g.items.map((it) => (
                <button
                  key={`${it.type}-${it.template || ""}`}
                  type="button"
                  role="menuitem"
                  data-add-type={it.template ? undefined : it.type}
                  data-add-template={it.template}
                  onClick={() => { close(); editor.addBlock(it.type, it.template); }}
                  className="ui-focus-inset flex w-full items-center gap-3 px-3 py-1.5 text-left hover:bg-subtle"
                >
                  <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] border border-border bg-surface text-secondary">
                    <BlockTypeIcon type={it.type} size={15} />
                  </span>
                  <span className="flex min-w-0 flex-1 items-baseline justify-between gap-3">
                    <span className="text-ui font-medium text-text">{it.label}</span>
                    <span className="truncate text-caption text-muted">{it.hint}</span>
                  </span>
                </button>
              ))}
            </div>
          ))}
          <div className="mt-1 border-t border-subtle px-3 pb-1.5 pt-2 text-caption text-muted">
            Filters live in the rail, not in the grid.{" "}
            <button type="button" role="menuitem" className="ui-focus rounded px-0.5 font-medium text-brand-ink hover:underline" onClick={() => { close(); editor.openSheet({ kind: "filters" }); }}>
              Edit filters
            </button>
          </div>
        </div>
      )}
    </Popover>
  );
}

export function EditToolbar({ editor, trailing, compact = false, className, onAppearance }: { editor: DashboardEditor; trailing?: ReactNode; compact?: boolean; className?: string; onAppearance?: () => void }) {
  return (
    <div
      role="toolbar"
      aria-label="Edit dashboard"
      data-edit-toolbar=""
      className={cn(CONTEXT_ROW_CLASS, "sticky top-2 z-30 rounded-card border border-border bg-surface px-2 py-[7px] shadow-card print:hidden", className)}
    >
      <AddBlockPalette editor={editor} />
      <Button variant="secondary" icon={<FilterIcon size={15} />} onClick={() => editor.openSheet({ kind: "filters" })} data-edit-filters="">
        Filters
      </Button>
      {/* 2026-10-07 (identity-colour round): colours, brand, layout and
          type, numbers and the public link's look - one sheet. */}
      {onAppearance && (
        <Button variant="secondary" icon={<PaletteIcon size={15} />} onClick={onAppearance} data-edit-appearance="">
          Appearance
        </Button>
      )}
      {!compact && (
        <span className="hidden min-w-0 flex-1 truncate pl-1 text-caption text-muted lg:block" title={EDIT_HINT} data-edit-hint="">
          {EDIT_HINT}
        </span>
      )}
      {trailing && <span className={cn("flex min-w-0 items-center", compact ? "w-full" : "ml-auto")}>{trailing}</span>}
    </div>
  );
}
