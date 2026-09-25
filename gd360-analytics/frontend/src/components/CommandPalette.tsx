import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../api/AuthContext";
import { useTheme } from "../api/ThemeContext";
import { conversationApi, dashboardApi, datasourceApi, ConversationSummary, DashboardSummary, DataSourceSummary } from "../api/client";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";
import { ADMIN_EMAILS } from "./TopNav";

// 2026-09-25f (command palette round): a Cmd+K / Ctrl+K "jump to anything"
// overlay - real Projects, Dashboards, and Data Sources (never placeholder
// rows), plus a handful of quick actions, searchable and fully keyboard-
// navigable. Standard in every premium tool GD360 is being benchmarked
// against (Linear, Notion, Superhuman, Raycast) and flagged as a top
// priority in the design-trends research earlier this round.
//
// Mounted exactly once, at the app root (see App.tsx), rather than by each
// page - a page that renders TopNav (every authenticated page - see
// TopNav.tsx's own new search button) never has to know this component
// exists. Opening from that button (which lives in a completely different
// part of the tree) is a single custom DOM event, "gd360:open-command-
// palette" - the lightest way to reach a component mounted somewhere else
// without standing up a Context provider for one boolean.
//
// Deliberately reads the exact same workspace/session data every other
// page already reads (useWorkspaceNav for which workspace is active,
// conversationApi/dashboardApi/datasourceApi for the real lists) rather
// than a second, parallel "search index" - so a result here always matches
// what clicking through to that page would show, and nothing is ever
// invented to fill the list.

function SearchIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  );
}
function ProjectsIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}
function DashboardsIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3v18h18" />
      <rect x="7" y="12" width="3" height="6" rx="0.5" />
      <rect x="13" y="8" width="3" height="10" rx="0.5" />
      <rect x="18" y="5" width="3" height="13" rx="0.5" />
    </svg>
  );
}
function DataSourcesIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
      <path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" />
    </svg>
  );
}
function PlusIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
function ThemeIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}
function SettingsIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
function ShieldIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2l8 4v6c0 5-3.4 8.4-8 10-4.6-1.6-8-5-8-10V6z" />
    </svg>
  );
}
function CornerReturnIcon({ className = "w-3 h-3" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 10L4 15l5 5" />
      <path d="M4 15h11a4 4 0 0 0 4-4V4" />
    </svg>
  );
}

type Item = {
  id: string;
  section: "Quick actions" | "Projects" | "Dashboards" | "Data sources";
  label: string;
  subtitle?: string;
  icon: JSX.Element;
  run: () => void;
};

// Results are capped per section so the list stays a quick glance rather
// than a second copy of the full Projects/Dashboards/Data Sources pages -
// searching narrows within a section past this cap.
const SECTION_CAP = 6;

export default function CommandPalette() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { toggleTheme } = useTheme();
  const { activeWorkspaceId } = useWorkspaceNav();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [dashboards, setDashboards] = useState<DashboardSummary[]>([]);
  const [datasources, setDatasources] = useState<DataSourceSummary[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const isAdmin = !!user?.email && ADMIN_EMAILS.includes(user.email.toLowerCase());

  // Cmd+K / Ctrl+K toggles from anywhere, and the same custom event
  // TopNav's search button dispatches (see that file's own comment) opens
  // it too - kept as a plain window listener, always attached, so the
  // shortcut works the instant the app loads rather than only after
  // something else mounts.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpenEvent = () => setOpen(true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("gd360:open-command-palette", onOpenEvent);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("gd360:open-command-palette", onOpenEvent);
    };
  }, []);

  // Reset to a clean slate and (re)fetch every time the palette opens, so
  // results are never stale from a previous session on the page - Escape,
  // body scroll lock, and focusing the input are all scoped to this same
  // "while open" effect, same pattern as AppSidebar.tsx's mobile drawer.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    setLoading(true);
    Promise.all([
      conversationApi.list(activeWorkspaceId || undefined).catch(() => []),
      dashboardApi.list().catch(() => []),
      datasourceApi.list(activeWorkspaceId || undefined).catch(() => []),
    ]).then(([c, d, ds]) => {
      setConversations(c);
      setDashboards(d);
      setDatasources(ds);
      setLoading(false);
    });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 10);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      window.clearTimeout(focusTimer);
    };
  }, [open, activeWorkspaceId]);

  const openConversation = (c: ConversationSummary) => {
    if (!c.datasource_id) return;
    navigate(`/workspace/${c.datasource_id}?conversation=${c.id}`);
  };
  const openDashboard = (d: DashboardSummary) => {
    navigate(d.layout_version === 2 ? `/dashboard-builder/${d.id}` : `/dashboards/${d.id}`);
  };
  const openDatasource = (ds: DataSourceSummary) => {
    navigate(`/workspace/${ds.id}`);
  };

  const allItems = useMemo<Item[]>(() => {
    const quickActions: Item[] = [
      { id: "qa-new-project", section: "Quick actions", label: "New Project", subtitle: "Start a fresh analysis", icon: <PlusIcon />, run: () => navigate("/project/new") },
      { id: "qa-new-dashboard", section: "Quick actions", label: "New Dashboard", subtitle: "Build a dashboard", icon: <PlusIcon />, run: () => navigate("/dashboards") },
      { id: "qa-connect-data", section: "Quick actions", label: "Connect data", subtitle: "Add a new data source", icon: <PlusIcon />, run: () => navigate("/data") },
      { id: "qa-go-projects", section: "Quick actions", label: "Go to Projects", icon: <ProjectsIcon />, run: () => navigate("/") },
      { id: "qa-go-dashboards", section: "Quick actions", label: "Go to Dashboards", icon: <DashboardsIcon />, run: () => navigate("/dashboards") },
      { id: "qa-go-data", section: "Quick actions", label: "Go to Data Sources", icon: <DataSourcesIcon />, run: () => navigate("/data") },
      { id: "qa-theme", section: "Quick actions", label: "Toggle light / dark theme", icon: <ThemeIcon />, run: () => toggleTheme() },
      { id: "qa-settings", section: "Quick actions", label: "Account Settings", icon: <SettingsIcon />, run: () => navigate("/profile") },
    ];
    if (isAdmin) {
      quickActions.push({ id: "qa-admin", section: "Quick actions", label: "Admin", icon: <ShieldIcon />, run: () => navigate("/admin") });
    }

    const projectItems: Item[] = [...conversations]
      .filter((c) => !!c.datasource_id)
      .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
      .map((c) => ({
        id: `proj-${c.id}`,
        section: "Projects" as const,
        label: c.title || "Untitled Project",
        subtitle: c.datasource_name || undefined,
        icon: <ProjectsIcon />,
        run: () => openConversation(c),
      }));

    const dashboardItems: Item[] = [...dashboards]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .map((d) => ({
        id: `dash-${d.id}`,
        section: "Dashboards" as const,
        label: d.name,
        subtitle: d.workspace_name || "Personal",
        icon: <DashboardsIcon />,
        run: () => openDashboard(d),
      }));

    const datasourceItems: Item[] = [...datasources]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .map((ds) => ({
        id: `ds-${ds.id}`,
        section: "Data sources" as const,
        label: ds.name,
        subtitle: ds.kind,
        icon: <DataSourcesIcon />,
        run: () => openDatasource(ds),
      }));

    return [...quickActions, ...projectItems, ...dashboardItems, ...datasourceItems];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversations, dashboards, datasources, isAdmin, navigate, toggleTheme]);

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = (item: Item) =>
      !q || item.label.toLowerCase().includes(q) || (item.subtitle || "").toLowerCase().includes(q);
    const sections: Item["section"][] = ["Quick actions", "Projects", "Dashboards", "Data sources"];
    return sections
      .map((section) => ({
        section,
        items: allItems.filter((i) => i.section === section && matches(i)).slice(0, q ? SECTION_CAP + 4 : SECTION_CAP),
      }))
      .filter((g) => g.items.length > 0);
  }, [allItems, query]);

  const flatItems = useMemo(() => grouped.flatMap((g) => g.items), [grouped]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${activeIndex}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const runItem = (item: Item) => {
    setOpen(false);
    item.run();
  };

  const onListKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, flatItems.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = flatItems[activeIndex];
      if (item) runItem(item);
    }
  };

  if (!user) return null;

  return createPortal(
    <div
      className={`fixed inset-0 z-50 flex items-start justify-center pt-[12vh] px-4 transition-opacity duration-200 ${
        open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
      }`}
      aria-hidden={!open}
    >
      <div className="absolute inset-0 bg-black/60" onClick={() => setOpen(false)} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search and jump to anything"
        className={`relative w-full max-w-xl card bg-surface shadow-2xl border border-border flex flex-col max-h-[70vh] overflow-hidden transition-transform duration-200 ${
          open ? "translate-y-0" : "-translate-y-2"
        }`}
        onKeyDown={onListKeyDown}
      >
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-border shrink-0">
          <SearchIcon className="w-4 h-4 text-muted shrink-0" />
          <input
            ref={inputRef}
            className="flex-1 min-w-0 bg-transparent text-sm outline-none placeholder:text-muted"
            placeholder="Search Projects, Dashboards, Data Sources, or run a quick action..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <kbd className="shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded border border-border text-muted">esc</kbd>
        </div>

        <div ref={listRef} className="flex-1 overflow-y-auto py-1.5">
          {loading ? (
            <div className="text-xs text-muted text-center py-8">Loading&hellip;</div>
          ) : flatItems.length === 0 ? (
            <div className="text-xs text-muted text-center py-8">No results for &quot;{query}&quot;.</div>
          ) : (
            grouped.map((g) => {
              let base = 0;
              for (const prior of grouped) {
                if (prior.section === g.section) break;
                base += prior.items.length;
              }
              return (
                <div key={g.section} className="mb-1 last:mb-0">
                  <div className="px-4 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted">{g.section}</div>
                  {g.items.map((item, i) => {
                    const idx = base + i;
                    const active = idx === activeIndex;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        data-idx={idx}
                        onClick={() => runItem(item)}
                        onMouseEnter={() => setActiveIndex(idx)}
                        className={`w-full flex items-center gap-2.5 px-4 py-2 text-left transition ${
                          active ? "bg-primary/10" : "hover:bg-surface2"
                        }`}
                      >
                        <span className={`shrink-0 ${active ? "text-primary" : "text-muted"}`}>{item.icon}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm truncate">{item.label}</span>
                          {item.subtitle && <span className="block text-[11px] text-muted truncate">{item.subtitle}</span>}
                        </span>
                        {active && <CornerReturnIcon className="w-3.5 h-3.5 text-muted shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>

        <div className="hidden sm:flex items-center gap-3 px-4 py-2 border-t border-border text-[10px] text-muted shrink-0">
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 rounded border border-border">&uarr;</kbd>
            <kbd className="px-1 py-0.5 rounded border border-border">&darr;</kbd> navigate
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 rounded border border-border">&crarr;</kbd> select
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 rounded border border-border">esc</kbd> close
          </span>
        </div>
      </div>
    </div>,
    document.body
  );
}
