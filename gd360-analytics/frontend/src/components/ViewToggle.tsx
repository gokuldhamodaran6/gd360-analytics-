import { useState } from "react";

// 2026-09-23 (sidebar redesign round): a small grid/list switch, shared by
// every page that lists cards (Projects, Dashboards, Data Sources) instead
// of each page growing its own copy of the same two icon buttons. "list"
// reuses the exact same card component each page already renders - it just
// collapses the grid to one full-width column - so this never needs a
// second, differently-shaped row component to stay in sync with the card
// version.
export type ViewMode = "grid" | "list";

// Remembers the choice per person, per page (storageKey scopes it - e.g.
// "gd360_view_projects" vs "gd360_view_dashboards" - so picking list view
// on one page doesn't silently change another). Falls back to `initial`
// (and never throws) if localStorage is unavailable, matching every other
// per-viewer convenience in this app.
export function useViewMode(storageKey: string, initial: ViewMode = "grid"): [ViewMode, (m: ViewMode) => void] {
  const [mode, setModeState] = useState<ViewMode>(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved === "grid" || saved === "list") return saved;
    } catch {
      /* per-viewer convenience only */
    }
    return initial;
  });
  const setMode = (m: ViewMode) => {
    setModeState(m);
    try {
      localStorage.setItem(storageKey, m);
    } catch {
      /* per-viewer convenience only */
    }
  };
  return [mode, setMode];
}

function GridIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}

function ListIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 6h13M8 12h13M8 18h13" />
      <path d="M3 6h.01M3 12h.01M3 18h.01" />
    </svg>
  );
}

export default function ViewToggle({ mode, onChange }: { mode: ViewMode; onChange: (m: ViewMode) => void }) {
  const btn = (active: boolean) =>
    `p-1.5 rounded-md transition ${active ? "bg-primary text-white" : "text-muted hover:text-text hover:bg-surface2"}`;
  return (
    <div className="inline-flex items-center gap-0.5 rounded-lg border border-border p-0.5 shrink-0" role="group" aria-label="Layout">
      <button type="button" title="Grid view" className={btn(mode === "grid")} onClick={() => onChange("grid")}>
        <GridIcon />
      </button>
      <button type="button" title="List view" className={btn(mode === "list")} onClick={() => onChange("list")}>
        <ListIcon />
      </button>
    </div>
  );
}
