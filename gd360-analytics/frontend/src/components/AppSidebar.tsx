import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../api/AuthContext";
import { datasourceApi, DataSourceSummary } from "../api/client";
import { connectionKindMeta } from "./DataSourceForm";

// 2026-09-23: the first piece of the workspace-structure revamp Gokul asked
// for, modeled directly on the two reference screenshots he shared (a
// persistent left nav rail; a "Data sources" area styled like a settings/
// integrations list - one row per connected source, its real logo, a click
// straight through to it). This replaces the app's old top-bar-only
// navigation with a real, always-visible left rail, the same shape as
// every serious SaaS product's own app shell.
//
// Scope note for this round: wired into the home page (Dashboard.tsx) only
// for now - Workspace.tsx, Profile.tsx and the admin pages keep their
// current top-bar-only layout until the next round, so this ships as one
// contained, fully-testable step rather than changing every page's chrome
// at once. The plan (confirmed with Gokul) is to roll this out everywhere
// once this round is live and proven.

function ProjectsIcon({ className = "w-[18px] h-[18px]" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}

function PlusIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function ChevronsUpDownIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 15l5 5 5-5M7 9l5-5 5 5" />
    </svg>
  );
}

function CheckIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

function UserPlusIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M19 8v6M22 11h-6" />
    </svg>
  );
}

// The workspace switcher, styled after the reference screenshots Gokul
// shared: click the current workspace's name to open a small dropdown.
// Today every account has exactly one, real "Personal Workspace" - there is
// no multi-tenant team-workspace backend yet (that needs its own data
// model, membership roles, and a real transactional email provider for
// invites, none of which exist in this app yet). Rather than build a
// switcher that pretends to switch between workspaces that don't exist,
// this shows the one real workspace plus two clearly-labeled "coming soon"
// actions - the same shape as the reference UI, honestly filled in.
function WorkspaceSwitcher() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node) || btnRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const workspaceName = user?.company ? `${user.company}` : "Personal Workspace";

  return (
    <div className="relative px-3 pt-4 pb-2 shrink-0">
      <button
        ref={btnRef}
        type="button"
        title="Switch workspace"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2.5 px-1.5 py-1.5 rounded-lg hover:bg-surface2 transition"
      >
        <span className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center text-white font-bold text-sm shrink-0">
          G
        </span>
        <span className="min-w-0 flex-1 text-left">
          <span className="block text-sm font-bold gradient-text truncate">GD360 Analytics</span>
          <span className="block text-[11px] text-muted truncate">{workspaceName}</span>
        </span>
        <ChevronsUpDownIcon className="w-3.5 h-3.5 text-muted shrink-0" />
      </button>

      {open && (
        <div
          ref={menuRef}
          className="absolute left-3 right-3 top-full mt-1 card bg-surface shadow-2xl border border-border py-1.5 z-40"
          role="menu"
        >
          <div className="px-3.5 pt-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
            Your workspaces
          </div>
          <div className="w-full flex items-center gap-2.5 px-3.5 py-2 text-sm">
            <span className="w-6 h-6 rounded-md bg-primary flex items-center justify-center text-white font-bold text-[11px] shrink-0">
              G
            </span>
            <span className="flex-1 truncate text-left">{workspaceName}</span>
            <CheckIcon className="w-3.5 h-3.5 text-primary shrink-0" />
          </div>
          <div className="border-t border-border my-1.5" />
          <button
            type="button"
            disabled
            title="Team workspaces are coming soon"
            className="w-full flex items-center justify-between gap-2.5 px-3.5 py-2 text-sm text-left text-muted cursor-not-allowed"
          >
            <span className="flex items-center gap-2.5">
              <PlusIcon className="w-3.5 h-3.5 text-muted" /> Create workspace
            </span>
            <span className="text-[10px] font-semibold uppercase tracking-wide bg-surface2 rounded-full px-2 py-0.5">
              Soon
            </span>
          </button>
          <button
            type="button"
            disabled
            title="Inviting teammates is coming soon"
            className="w-full flex items-center justify-between gap-2.5 px-3.5 py-2 text-sm text-left text-muted cursor-not-allowed"
          >
            <span className="flex items-center gap-2.5">
              <UserPlusIcon className="w-3.5 h-3.5 text-muted" /> Invite teammates
            </span>
            <span className="text-[10px] font-semibold uppercase tracking-wide bg-surface2 rounded-full px-2 py-0.5">
              Soon
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

export default function AppSidebar({
  onConnectNew,
  refreshKey,
}: {
  // Opens the same "Connect a data source" flow the home page's own
  // "+ Connect data" button already uses (DataSourceForm inside a portaled
  // modal, owned by whichever page renders this sidebar) - kept as a
  // callback rather than owning that modal itself, so there is exactly one
  // connect flow in the app, not a second copy living in the sidebar.
  onConnectNew: () => void;
  // Bumped by the parent page whenever a new source is connected, so the
  // sidebar's own list refetches without needing its own polling.
  refreshKey?: number;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const [sources, setSources] = useState<DataSourceSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    datasourceApi
      .list()
      .then((list) => {
        if (cancelled) return;
        // Newest first - matches every other "your data" list in the app.
        setSources([...list].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()));
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [refreshKey]);

  const onProjects = location.pathname === "/";

  return (
    // Hidden below the `lg` breakpoint rather than becoming a hamburger/
    // drawer nav - this app's other pages (Workspace.tsx) already have an
    // established mobile pattern (stack full-width, no fixed side rail),
    // so hiding it here keeps mobile exactly as good as it was before this
    // round rather than half-building a second, different mobile nav
    // pattern under time pressure. A real mobile drawer version of this
    // sidebar is a reasonable next step, not done in this round - caught by
    // an actual 390px-width Playwright check before delivery, not assumed.
    <div className="hidden lg:flex w-60 shrink-0 h-screen sticky top-0 border-r border-border bg-surface flex-col">
      <WorkspaceSwitcher />

      <div className="px-3 mt-1">
        <Link
          to="/"
          className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition ${
            onProjects ? "bg-primary text-white" : "text-text hover:bg-surface2"
          }`}
        >
          <ProjectsIcon />
          Projects
        </Link>
      </div>

      <div className="flex-1 min-h-0 flex flex-col mt-6 px-3 pb-4">
        <div className="flex items-center justify-between px-1 mb-2 shrink-0">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">Data sources</span>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto space-y-0.5 pr-0.5">
          {loading && sources.length === 0 && (
            <div className="text-xs text-muted px-2 py-2">Loading...</div>
          )}
          {!loading && sources.length === 0 && (
            <div className="text-xs text-muted px-2 py-2 leading-relaxed">
              Nothing connected yet.
            </div>
          )}
          {sources.map((ds) => {
            const meta = connectionKindMeta(ds.kind);
            return (
              <button
                key={ds.id}
                type="button"
                onClick={() => navigate(`/workspace/${ds.id}`)}
                title={ds.name}
                className="w-full flex items-center gap-2.5 px-2 py-2 rounded-lg text-left hover:bg-surface2 transition group"
              >
                <span
                  className="w-6 h-6 rounded-md flex items-center justify-center shrink-0"
                  style={{ backgroundColor: `${meta.color}1a`, color: meta.color }}
                >
                  <meta.Logo className="w-3.5 h-3.5" />
                </span>
                <span className="text-sm truncate flex-1 text-text/90 group-hover:text-text">{ds.name}</span>
              </button>
            );
          })}
        </div>

        <button
          type="button"
          onClick={onConnectNew}
          className="mt-2 shrink-0 w-full flex items-center gap-2.5 px-2 py-2 rounded-lg text-left text-sm font-medium text-muted hover:text-text hover:bg-surface2 transition border border-dashed border-border"
        >
          <PlusIcon className="w-3.5 h-3.5 text-muted" />
          Connect new
        </button>
      </div>
    </div>
  );
}
