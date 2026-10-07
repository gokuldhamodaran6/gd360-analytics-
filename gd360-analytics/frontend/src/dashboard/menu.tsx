import type { ReactNode } from "react";
import type { DashboardBlockType } from "../api/client";
import { cn } from "../ui";

// The menu vocabulary the block grid, the canvas cells and the dashboard
// editor share (split out of BlockGrid.tsx so the editor's menus can use
// it without importing the grid).

export const SWAP_OPTIONS: { label: string; payload: { chart_type?: string; type?: DashboardBlockType } }[] = [
  { label: "Bar chart", payload: { type: "chart", chart_type: "bar" } },
  { label: "Horizontal bars", payload: { type: "chart", chart_type: "horizontal_bar" } },
  { label: "Line chart", payload: { type: "chart", chart_type: "line" } },
  { label: "Area chart", payload: { type: "chart", chart_type: "area" } },
  { label: "Stacked bars", payload: { type: "chart", chart_type: "stacked_bar" } },
  { label: "Pie chart", payload: { type: "chart", chart_type: "pie" } },
  { label: "Donut", payload: { type: "donut" } },
  { label: "Table", payload: { type: "table" } },
  { label: "Top list", payload: { type: "avatar_list" } },
  { label: "KPI tile", payload: { type: "kpi" } },
];

export function MenuRow({ children, onClick, disabled, danger, icon, trailing }: { children: ReactNode; onClick?: () => void; disabled?: boolean; danger?: boolean; icon?: ReactNode; trailing?: ReactNode }) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "ui-focus-inset flex w-full items-center gap-2.5 px-3 py-2 text-left text-ui hover:bg-subtle disabled:cursor-default disabled:text-faint disabled:hover:bg-transparent",
        danger ? "text-danger hover:bg-danger-fill" : "text-text"
      )}
    >
      {icon && <span className={cn("inline-flex shrink-0 [&>svg]:block", danger ? "text-danger" : "text-muted")}>{icon}</span>}
      <span className="min-w-0 flex-1">{children}</span>
      {trailing && <span className="shrink-0 text-caption text-faint">{trailing}</span>}
    </button>
  );
}

export function MenuCaption({ children }: { children: ReactNode }) {
  return <div className="px-3 pb-1 pt-2 text-caption font-medium uppercase tracking-caps text-muted">{children}</div>;
}

export function MenuDivider() {
  return <div className="my-1 border-t border-subtle" role="separator" />;
}
