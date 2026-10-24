import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../api/AuthContext";
import { BrandMark } from "./Brand";
import { datasourceApi, DataSourceSummary, WorkspaceDetail, WorkspaceSummary, workspaceApi } from "../api/client";
import DataSourceForm, { connectionKindMeta, dataSourceCategory, DATA_SOURCE_CATEGORIES } from "./DataSourceForm";
import { ChipCloseIcon, SourceDot } from "./ChatPanel";
// 2026-10-06 (design-system kit): the rail's nav glyphs now come from the
// shared stroke icon set in src/ui/Icons.tsx (same 24-unit, 1.8-stroke
// drawings as before - just one copy for the whole app) and the rail's
// chrome is restyled to the System.dc.html spec: a 56 px icon rail with the
// 30 px "G" mark, muted stroke icons, the active one in brand ink on the
// brand tint. Navigation, routes, the workspace switcher and the mobile
// drawer behave exactly as they did.
import { ClockIcon, DatabaseIcon, FlaskIcon, GridIcon, NetworkIcon, PaletteIcon, ShieldCheckIcon, SidebarIcon } from "../ui";
import { BrandKitSheet } from "../dashboard/theme/BrandKitSheet";
import { eulivAvailable, openEuliv } from "./Euliv";
import { v2Api, type ConversationRow } from "../api/v2";
import { opsApi } from "../api/ops";
import { flowsApi } from "../api/flows";
import "../shell/shell.css";

// 2026-09-23: the persistent left nav rail from the workspace-structure
// revamp, modeled on the reference screenshots Gokul shared (a "Data
// sources" area styled like a settings/integrations list; a workspace
// switcher at the top).
//
// 2026-09-23, round two: the workspace switcher is now real - real
// workspaces, real membership, a real shareable invite link (see
// backend routers/workspaces.py). There is still no transactional email
// sending in this app, so "inviting" someone works by copying a link and
// sending it yourself, not by an emailed invite - and a workspace's other
// members can't yet see or open each other's data sources/Projects (every
// data source/conversation is still scoped to its own owner) - that's the
// next, security-sensitive piece, called out in workspaces.py's own
// module docstring rather than silently left half-done.
//
// Scope note: still wired into the home page (Dashboard.tsx) only -
// Workspace.tsx, Profile.tsx and the admin pages keep their current
// top-bar-only layout until a later round.

// 2026-10-10 (Clarity Blueprint): Library - every answer and analysis - is
// drawn as a stack of layers, so it never looks like the Dashboards grid.
const ProjectsIcon = () => (
  <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3l9 5-9 5-9-5z" />
    <path d="M3 13l9 5 9-5" />
  </svg>
);

// 2026-09-23 (shared dashboards v1): a second top-level nav entry next to
// Projects, for the new /dashboards list page.
const DashboardsIcon = () => <GridIcon size={18} />;

// 2026-09-28 (scheduled auto-refresh + background jobs round): the Jobs
// page's own nav entry, between Dashboards and Data Sources - a scheduled
// refresh is "a dashboard doing something automatically", which reads
// closer to Dashboards than to browsing/connecting data.
const JobsIcon = () => <ClockIcon size={18} />;

// 2026-09-30 (Governance/Jobs redesign + Pipelines/Catalog removal round,
// Gokul's own report): PipelinesIcon and CatalogIcon used to live here,
// backing their own standalone sidebar entries right after Jobs. Removed:
// Gokul's own words were that Pipelines and Catalog duplicated the
// Projects filter and Data Sources page and "leads to confusion".
// Pipelines' one real, unique capability (named, multi-step chains, not
// just one dashboard's schedule) now lives in a "Chains" tab inside the
// Jobs page below - reached through the Jobs nav entry, no separate icon
// needed. Catalog's one real, non-redundant capability (editing a data
// source's short description) moved inline onto DataSources.tsx instead.

// 2026-09-23 (sidebar redesign round): a third top-level nav entry, for the
// new /data page - every connected source, browsable by category, replaces
// this sidebar's old always-expanded flat list.
const DataSourcesIcon = () => <DatabaseIcon size={18} />;

function SearchIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  );
}

// Phase 2, feature 1 (shared, reusable models): the /models library page's
// own nav entry, placed right after Data Sources - a promoted table is one
// step further removed from "browsing connections" than Data Sources
// itself, but still squarely about data rather than analysis/dashboards,
// so it reads best as the last item in this data-oriented group. A stack
// of layered cards - "reusable, built-on-top-of" - kept distinct from
// DashboardsIcon's bar chart and DataSourcesIcon's database cylinder.
//
// 2026-09-28 (ML Models round, later same day): the real ML feature's own
// nav entry - see models.MLModel's own docstring for the full history.
// (This app used to also have a "Saved Tables" entry right here - a
// gallery of promoted/reusable saved data TABLES with nothing to do with
// machine learning. It was removed the same day once the confusing
// "Saved Tables" vs. "ML Models" naming collision made clear it wasn't
// pulling its weight, especially since it duplicated a capability chat's
// own cross-datasource picker already provided for free.) A simple
// sparkle/circuit-node glyph - "something computed/inferred" - kept
// distinct from every icon above it (a flask, a shield) rather than
// reusing a generic chart/brain cliché.
const MLModelsIcon = () => <NetworkIcon size={18} />;

// Phase 4 (2026-09-28, Experimentation / A/B testing): the /experiments
// page's own nav entry - one of the "Replacing the Data Team" roadmap
// features in this data-oriented group. A flask, distinct from every icon
// above it (DashboardsIcon's bar chart, DataSourcesIcon's database
// cylinder, MLModelsIcon's sparkle nodes) - "testing/experimenting" reads
// clearly as its own thing rather than a variant of any of those.
const ExperimentsIcon = () => <FlaskIcon size={18} />;

// Phase 5, Batch A (2026-09-28, "Data governance & quality" roadmap): the
// /governance page - access review + audit log, owner-only (see this
// file's own SidebarNav for the visibility gate).
const GovernanceIcon = () => <ShieldCheckIcon size={18} />;

// 2026-09-23, round two of Gokul's own explicit design feedback: this
// popup's "Your data" tab used to just be a tiny muted "FILES" label over a
// plain flat list - no way to filter by category at all, next to a "New
// data" tab whose own DataSourceForm content already looks properly built
// and aligned. These four icons back a segmented category picker for
// "Your data" that matches that same graphic, icon-plus-label picker style
// DataSourceForm's own Database/Warehouse/Connect/Upload file tabs use
// (also mirrored on the /data page's own Existing data view) - one
// consistent "pick a kind of thing" control everywhere in this app, not a
// plain list with no way to narrow it down.
function AllGlyph({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}

function DatabaseGlyph({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
      <path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" />
    </svg>
  );
}

function WarehouseGlyph({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 10.5 12 4l9 6.5" />
      <path d="M5 9.5V20h14V9.5" />
      <path d="M9 20v-6h6v6" />
    </svg>
  );
}

function FileGlyph({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 2h9l5 5v15H6z" />
      <path d="M15 2v5h5" />
    </svg>
  );
}

function AppsGlyph({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 11a8 8 0 0 0-14.3-4.9L4 8" />
      <path d="M4 4v4h4" />
      <path d="M4 13a8 8 0 0 0 14.3 4.9L20 16" />
      <path d="M20 20v-4h-4" />
    </svg>
  );
}

function categoryGlyph(cat: "Files" | "Databases" | "Warehouses" | "Apps") {
  if (cat === "Apps") return AppsGlyph;
  if (cat === "Databases") return DatabaseGlyph;
  if (cat === "Warehouses") return WarehouseGlyph;
  return FileGlyph;
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

function CopyIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function TrashIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </svg>
  );
}

function CloseIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}

// 2026-09-23, round four (Gokul's own explicit ask: "after 6 rows make
// option for page 2,3"): the same Prev/Next-plus-numbers pager DataSources.tsx
// uses for its own Existing data view, duplicated here per this codebase's
// established per-file icon/small-component convention.
function ChevronLeftIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

function ChevronRightIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}

// PAGE_SIZE=6 is Gokul's own explicit number ("after 6 rows") - deliberately
// smaller than the Data Sources page's own PAGE_SIZE=12, since this popup's
// list sits inside a much smaller, already-scrollable modal pane.
const CONNECT_POPUP_PAGE_SIZE = 6;

function Pager({ page, totalPages, onChange }: { page: number; totalPages: number; onChange: (p: number) => void }) {
  if (totalPages <= 1) return null;

  const pages: (number | "gap")[] = [];
  const push = (p: number) => { if (!pages.includes(p)) pages.push(p); };
  push(1);
  for (let p = page - 1; p <= page + 1; p++) if (p > 1 && p < totalPages) push(p);
  push(totalPages);
  const withGaps: (number | "gap")[] = [];
  let prev = 0;
  for (const p of pages) {
    if (typeof p === "number" && p - prev > 1) withGaps.push("gap");
    withGaps.push(p);
    if (typeof p === "number") prev = p;
  }

  const btn = (active: boolean) =>
    `min-w-[2rem] h-8 px-2 text-sm rounded-lg border transition ${
      active ? "bg-primary text-on-primary border-primary font-semibold" : "border-border text-muted hover:text-text hover:bg-surface2"
    }`;

  return (
    <div className="flex items-center justify-center gap-1.5 mt-4">
      <button
        type="button"
        className="h-8 px-2 rounded-lg border border-border text-muted hover:text-text hover:bg-surface2 transition disabled:opacity-40 disabled:cursor-not-allowed"
        onClick={() => onChange(page - 1)}
        disabled={page <= 1}
        aria-label="Previous page"
      >
        <ChevronLeftIcon />
      </button>
      {withGaps.map((p, i) =>
        p === "gap" ? (
          <span key={`gap-${i}`} className="px-1 text-muted text-sm select-none">&hellip;</span>
        ) : (
          <button key={p} type="button" className={btn(p === page)} onClick={() => onChange(p)}>
            {p}
          </button>
        )
      )}
      <button
        type="button"
        className="h-8 px-2 rounded-lg border border-border text-muted hover:text-text hover:bg-surface2 transition disabled:opacity-40 disabled:cursor-not-allowed"
        onClick={() => onChange(page + 1)}
        disabled={page >= totalPages}
        aria-label="Next page"
      >
        <ChevronRightIcon />
      </button>
    </div>
  );
}

// 2026-09-28 (collapsible icon rail, round 2 - Gokul's own explicit
// follow-up after trying round 1): round 1 made the collapsed/expanded
// state a single flag remembered globally across the whole app - collapse
// it once on the busy Workspace.tsx analysis canvas and it stayed
// collapsed on Dashboards too, which is exactly backwards from what he
// wants. He asked for this instead: Dashboards should default OPEN
// (that's where he wants to see full labels/workspace context), while
// every other page - the chat/analysis canvas (Workspace.tsx) included -
// should default to the small icon-only rail, and this should switch
// automatically as he navigates, not stay stuck on whatever he last
// manually picked. So the collapsed/expanded state is now DERIVED from
// the current route every time it changes, not read from localStorage -
// isDashboardsPath mirrors the exact same pathname check SidebarNav
// already uses to highlight the Dashboards nav link (startsWith
// "/dashboards" or "/dashboard-builder" - see that link's own comment for
// why dashboard-builder counts as "being in Dashboards" too), so "which
// pages count as Dashboards" can never drift out of sync between the nav
// highlight and this default. The manual toggle button still works - a
// person can still collapse Dashboards or expand the analysis canvas for
// the page they're currently looking at - it just no longer PERSISTS that
// override once they navigate elsewhere; the next page always starts from
// its own route's sensible default again.
function isDashboardsPath(pathname: string): boolean {
  return pathname.startsWith("/dashboards") || pathname.startsWith("/dashboard-builder");
}

function initials(nameOrEmail: string): string {
  const trimmed = (nameOrEmail || "").trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return trimmed.slice(0, 2).toUpperCase();
}

// The workspace switcher: click the current workspace's name/logo to open
// a dropdown listing every real workspace the account belongs to (its own
// personal one, plus any team workspace it created or joined), switch
// between them, create a new one, or invite people to the active one.
function GlobeGlyph() {
  return (
    <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" className="text-muted" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z" />
    </svg>
  );
}

function WorkspaceSwitcher({
  workspaces,
  activeWorkspaceId,
  onSwitch,
  onOpenCreate,
  onOpenInvite,
  onOpenBrandKit,
  collapsed = false,
}: {
  workspaces: WorkspaceSummary[];
  activeWorkspaceId: string;
  onSwitch: (id: string) => void;
  onOpenCreate: () => void;
  onOpenInvite: () => void;
  // 2026-10-07 (identity-colour round): the active workspace's brand kit.
  onOpenBrandKit: () => void;
  // 2026-09-28 (collapsible icon rail): desktop-only, defaulted false so
  // the mobile drawer (which never passes this) keeps today's always-full
  // avatar+name+chevron button exactly as-is.
  collapsed?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
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

  const active = workspaces.find((w) => w.id === activeWorkspaceId) || workspaces[0];
  const activeName = active?.name || "Personal Workspace";

  return (
    <div className={`relative pt-3 pb-2 shrink-0 ${collapsed ? "px-2" : "px-3"}`}>
      <button
        ref={btnRef}
        type="button"
        title={collapsed ? `${activeName}${active?.role === "viewer" ? " · View only" : ""} - switch workspace` : "Switch workspace"}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`ui-focus flex items-center rounded-ctl hover:bg-subtle transition-colors ${
          collapsed ? "w-10 h-10 mx-auto justify-center" : "w-full gap-2.5 px-1.5 py-1.5"
        }`}
      >
        <span className="w-[30px] h-[30px] rounded-ctl bg-primary flex items-center justify-center text-on-primary font-bold text-body shrink-0">
          G
        </span>
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1 text-left">
              <span className="block text-ui font-semibold text-text truncate">GD360 Analytics</span>
              <span className="block text-[11px] text-muted truncate">
                {activeName}
                {active?.role === "viewer" && " · View only"}
              </span>
            </span>
            <ChevronsUpDownIcon className="w-3.5 h-3.5 text-muted shrink-0" />
          </>
        )}
      </button>

      {open && (
        <div
          ref={menuRef}
          // Collapsed (64px rail): the usual `left-3 right-3` anchoring
          // would crush this to ~40px wide since it's relative to the
          // narrow rail itself - fly out to the right of the rail instead,
          // with its own comfortable min-width, same as a Notion/Linear-
          // style icon rail's flyout menus.
          className={`absolute rounded-card bg-surface shadow-pop border border-border py-1.5 z-40 ${
            collapsed ? "left-full top-0 ml-2 w-64" : "left-3 right-3 top-full mt-1"
          }`}
          role="menu"
        >
          <div className="px-3.5 pt-1 pb-1.5 text-caption font-medium uppercase tracking-caps text-muted">
            Your workspaces
          </div>
          <div className="max-h-56 overflow-y-auto">
            {workspaces.map((ws) => (
              <button
                key={ws.id}
                type="button"
                onClick={() => { onSwitch(ws.id); setOpen(false); }}
                className="ui-focus-inset w-full flex items-center gap-2.5 px-3.5 py-2 text-ui text-left hover:bg-subtle transition-colors"
              >
                <span className="w-6 h-6 rounded-[6px] bg-primary flex items-center justify-center text-on-primary font-bold text-[11px] shrink-0">
                  {ws.is_personal ? "G" : ws.name.charAt(0).toUpperCase()}
                </span>
                <span className="flex-1 truncate">
                  {ws.name}
                  {ws.role === "viewer" && <span className="text-muted"> · View only</span>}
                </span>
                {ws.id === activeWorkspaceId && <CheckIcon className="w-3.5 h-3.5 text-brand-ink shrink-0" />}
              </button>
            ))}
          </div>
          <div className="border-t border-border my-1.5" />
          <button
            type="button"
            onClick={() => { setOpen(false); onOpenCreate(); }}
            className="ui-focus-inset w-full flex items-center gap-2.5 px-3.5 py-2 text-ui text-left hover:bg-subtle transition-colors"
          >
            <PlusIcon className="w-3.5 h-3.5 text-muted" /> Create workspace
          </button>
          <button
            type="button"
            disabled={!!active?.is_personal}
            title={active?.is_personal ? "Personal Workspace is just for you - create or switch to a team workspace to invite people" : "Invite teammates"}
            onClick={() => { setOpen(false); onOpenInvite(); }}
            className={`ui-focus-inset w-full flex items-center gap-2.5 px-3.5 py-2 text-ui text-left transition-colors ${
              active?.is_personal ? "text-faint cursor-not-allowed" : "hover:bg-subtle"
            }`}
          >
            <UserPlusIcon className="w-3.5 h-3.5 text-muted" /> Invite teammates
          </button>
          {/* 2026-10-07 (identity-colour round): the look every dashboard of
              this workspace starts from - palette, colour by value, type,
              numbers. Any member can open it; the owner can change it. */}
          <button
            type="button"
            data-open-brand-kit=""
            onClick={() => { setOpen(false); onOpenBrandKit(); }}
            className="ui-focus-inset w-full flex items-center gap-2.5 px-3.5 py-2 text-ui text-left hover:bg-subtle transition-colors"
          >
            <PaletteIcon size={14} className="text-muted" /> Brand kit…
          </button>
          {/* 2026-10-10 (round 19): the workspace's own address for dashboards. */}
          <button
            type="button"
            data-open-domain=""
            onClick={() => { setOpen(false); navigate("/settings/domains"); }}
            className="ui-focus-inset w-full flex items-center gap-2.5 px-3.5 py-2 text-ui text-left hover:bg-subtle transition-colors"
          >
            <GlobeGlyph /> Company domain…
          </button>
        </div>
      )}
    </div>
  );
}

function CreateWorkspaceModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (ws: WorkspaceSummary) => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setError("");
    try {
      const ws = await workspaceApi.create(trimmed);
      onCreated(ws);
    } catch {
      setError("Couldn't create that workspace. Please try again.");
      setBusy(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="card w-full max-w-sm p-6 relative">
        <button className="absolute top-4 right-4 text-muted hover:text-text transition" onClick={onClose} aria-label="Close">
          <CloseIcon className="w-5 h-5" />
        </button>
        <h2 className="text-lg font-bold mb-1">New workspace</h2>
        <p className="text-xs text-muted mb-5 leading-relaxed">
          A separate space for a team or project - its own Projects and data sources, kept apart from
          your personal workspace and anything else you create.
        </p>
        <form onSubmit={submit} className="space-y-3">
          {error && <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{error}</div>}
          <input
            autoFocus
            className="input text-sm w-full"
            placeholder="e.g. Marketing Team, Client X"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
          />
          <button className="btn-primary w-full text-sm" type="submit" disabled={busy || !name.trim()}>
            {busy ? "Creating…" : "Create workspace"}
          </button>
        </form>
      </div>
    </div>,
    document.body
  );
}

function InviteMembersModal({
  workspaceId,
  currentUserId,
  onClose,
}: {
  workspaceId: string;
  currentUserId: string;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<WorkspaceDetail | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = () => {
    workspaceApi.get(workspaceId).then(setDetail).catch(() => setError("Couldn't load this workspace."));
  };
  useEffect(load, [workspaceId]);

  const inviteUrl = detail ? `${window.location.origin}/invite/${detail.invite_token}` : "";
  const isOwner = detail?.role === "owner";
  // 2026-10-10 (round 19): admins manage members and viewers too; only the
  // owner makes or changes admins.
  const isManager = isOwner || detail?.role === "admin";

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Couldn't copy automatically - select and copy the link above instead.");
    }
  };

  const regenerate = async () => {
    setBusy(true);
    setError("");
    try {
      await workspaceApi.regenerateInvite(workspaceId);
      load();
    } catch {
      setError("Couldn't reset the link. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const removeMember = async (userId: string) => {
    setBusy(true);
    setError("");
    try {
      await workspaceApi.removeMember(workspaceId, userId);
      load();
    } catch {
      setError("Couldn't remove that person. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  // "Can edit" (role="member") is everything a teammate could already do;
  // "Can view" (role="viewer", 2026-09-23) sees the same data/Projects but
  // can't chat/analyze, create or change anything - owner-only to change,
  // same as removing someone.
  const updateRole = async (userId: string, role: "admin" | "member" | "viewer") => {
    setBusy(true);
    setError("");
    try {
      await workspaceApi.updateMemberRole(workspaceId, userId, role);
      load();
    } catch {
      setError("Couldn't change that person's access. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start sm:items-center justify-center bg-black/60 p-4 overflow-y-auto"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="card w-full max-w-md my-8 sm:my-0 p-6 relative">
        <button className="absolute top-4 right-4 text-muted hover:text-text transition" onClick={onClose} aria-label="Close">
          <CloseIcon className="w-5 h-5" />
        </button>
        <h2 className="text-lg font-bold mb-1">{detail ? `Invite to ${detail.name}` : "Invite teammates"}</h2>
        <p className="text-xs text-muted mb-5 leading-relaxed">
          Share this link with anyone you want in this workspace - they'll join as soon as they open it
          and sign in, with full access to everything in it. There's no emailed invite yet, so send it
          however you'd like. You can switch anyone to view-only below at any time.
        </p>

        {error && <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 mb-3">{error}</div>}

        {detail && (
          <>
            <div className="flex items-center gap-2 mb-2">
              <input readOnly className="input text-xs flex-1 font-mono" value={inviteUrl} onFocus={(e) => e.target.select()} />
              <button type="button" className="btn-secondary text-xs px-3 py-2.5 shrink-0 inline-flex items-center gap-1.5" onClick={copyLink}>
                <CopyIcon className="w-3.5 h-3.5" /> {copied ? "Copied!" : "Copy"}
              </button>
            </div>
            {isManager && (
              <button type="button" disabled={busy} className="text-xs text-muted hover:text-text transition mb-5" onClick={regenerate}>
                Reset link (old link stops working)
              </button>
            )}
            {!isManager && <div className="mb-5" />}

            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted mb-2">
              Members &middot; {detail.member_count}
            </div>
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {detail.members.map((m) => (
                <div key={m.user_id} className="flex items-center gap-2.5 px-1 py-1.5">
                  <span className="w-7 h-7 rounded-full bg-primary/20 text-primary text-[11px] font-bold flex items-center justify-center shrink-0">
                    {initials(m.full_name || m.email)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm truncate">{m.full_name || m.email}</span>
                    {m.full_name && <span className="block text-[11px] text-muted truncate">{m.email}</span>}
                  </span>
                  {isManager && m.user_id !== currentUserId && m.role !== "owner" && (isOwner || m.role !== "admin") ? (
                    <select
                      className="text-[11px] bg-surface2 border border-border rounded-md px-1.5 py-1 shrink-0 cursor-pointer"
                      value={m.role}
                      disabled={busy}
                      title="What this person can do in this workspace"
                      onChange={(e) => updateRole(m.user_id, e.target.value as "admin" | "member" | "viewer")}
                    >
                      {isOwner && <option value="admin">Admin</option>}
                      <option value="member">Can edit</option>
                      <option value="viewer">Can view</option>
                    </select>
                  ) : (
                    <span className="text-[10px] uppercase tracking-wide text-muted shrink-0">
                      {m.role === "owner" ? "Owner" : m.role === "admin" ? "Admin" : m.role === "viewer" ? "Can view" : "Can edit"}
                    </span>
                  )}
                  {isManager && m.user_id !== currentUserId && m.role !== "owner" && (isOwner || m.role !== "admin") && (
                    <button
                      type="button"
                      disabled={busy}
                      title="Remove from workspace"
                      className="p-1.5 rounded-lg text-muted hover:text-red-400 hover:bg-red-500/10 transition shrink-0"
                      onClick={() => removeMember(m.user_id)}
                    >
                      <TrashIcon className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}

// The sidebar's own "Connect data" popup (2026-09-23, sidebar redesign
// round). Two tabs: every source already connected in the active
// workspace, grouped by category (Files / Databases / Warehouses, see
// DataSourceForm.dataSourceCategory) instead of one flat unsorted scroll,
// or connect a brand-new one (the same DataSourceForm used everywhere
// else).
//
// 2026-09-23, round three: genuine multi-select at connect time, the same
// "pick several, see them as chips, then continue" pattern ChatGPT uses for
// attachments (and the same one the mid-conversation "+ Add data" popup,
// AddDataPicker.tsx, already used for adding sources to a live chat).
// Clicking a row toggles it into a running `selected` list instead of
// navigating immediately - existing rows AND a brand-new connection both
// land in that same list, so someone can tick two already-connected
// sources, then switch to "Upload / connect new" and add a third, all
// before ever leaving this popup. "Continue" carries the whole selection
// into Workspace.tsx as one primary datasourceId plus a `?extra=id,id`
// query param (see otherDsSourceId's callers in Workspace.tsx), which seeds
// the chat's WORKING ON selection with every source picked here already
// checked - never a plain single-source landing when more than one was
// chosen.
export function ConnectDataPopup({
  activeWorkspaceId,
  onClose,
  draft,
}: {
  activeWorkspaceId: string;
  onClose: () => void;
  // A pending, not-yet-sent chat prompt this popup was opened on top of
  // (see pages/NewProject.tsx) - when set, continuing carries it along in
  // the URL instead of landing on a plain empty workspace, so Workspace.tsx
  // can auto-run it the moment the primary data source is ready (see its
  // own draft-param effect). Omitted everywhere else (the sidebar's own
  // "Connect data" button below has no pending prompt).
  draft?: string;
}) {
  const navigate = useNavigate();
  const [tab, setTab] = useState<"existing" | "new">("existing");
  const [sources, setSources] = useState<DataSourceSummary[] | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<"all" | "Files" | "Databases" | "Warehouses" | "Apps">("all");
  const [page, setPage] = useState(1);
  // Every source picked so far this popup session, in click order - the
  // first one becomes the URL's :datasourceId, the rest ride along as
  // ?extra=. A plain array (not a Set) because order matters (first-picked
  // stays primary even if someone deselects and reselects a different one
  // first) and the list is always small enough that an .some()/.filter()
  // scan per click is unnoticeable.
  // Only the id (for the URL and de-duping) and name (for the chip label)
  // are ever read off a selected entry - a lighter type than the full
  // DataSourceSummary on purpose, so a brand-new connection (handleCreated
  // below only ever gets id/name/kind/created_at back from the server, not
  // a complete DataSourceSummary) can be pushed in directly rather than
  // needing fabricated placeholder fields just to satisfy the type.
  const [selected, setSelected] = useState<{ id: string; name: string }[]>([]);

  const loadSources = () => {
    if (!activeWorkspaceId) return;
    datasourceApi
      .list(activeWorkspaceId)
      .then((list) => setSources([...list].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())))
      .catch(() => setSources([]));
  };

  useEffect(loadSources, [activeWorkspaceId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // A fresh search/category (or the list itself changing) always lands back
  // on page 1, same reasoning as the Data Sources page's own pager - never
  // leave the pager pointed at a page that just emptied out from under it.
  useEffect(() => { setPage(1); }, [query, category, sources]);

  const isSelected = (dsId: string) => selected.some((s) => s.id === dsId);

  // Typed to the same minimal { id, name } shape `selected` itself uses
  // (see its own comment above) rather than the full DataSourceSummary -
  // every real call site (an existing-data row below, and the chip row's
  // own remove button) already passes something with at least those two
  // fields, and this is also what lets the chip row remove a selection by
  // handing back one of `selected`'s own already-lighter entries.
  const toggleSource = (ds: { id: string; name: string }) => {
    setSelected((prev) => (prev.some((s) => s.id === ds.id) ? prev.filter((s) => s.id !== ds.id) : [...prev, ds]));
  };

  // A brand-new connection is added to the running selection exactly like
  // an existing-row click, then this hops back to "Your data" so the fresh
  // chip is visible and another source can be added right away - it never
  // navigates away on its own the way it used to.
  const handleCreated = (ds: { id: string; name: string; kind: string; created_at: string }) => {
    setSelected((prev) => (prev.some((s) => s.id === ds.id) ? prev : [...prev, ds]));
    loadSources();
    setTab("existing");
  };

  const continueWithSelection = () => {
    if (selected.length === 0) return;
    const [primary, ...rest] = selected;
    const params = new URLSearchParams();
    if (draft && draft.trim()) params.set("draft", draft.trim());
    if (rest.length) params.set("extra", rest.map((s) => s.id).join(","));
    const qs = params.toString();
    onClose();
    navigate(`/workspace/${primary.id}${qs ? `?${qs}` : ""}`);
  };

  const filtered = (sources || []).filter((ds) => {
    if (query.trim() && !ds.name.toLowerCase().includes(query.trim().toLowerCase())) return false;
    if (category !== "all" && dataSourceCategory(ds.kind) !== category) return false;
    return true;
  });
  // Paginate the flat filtered list FIRST, then group only this page's
  // sources into category sections - same order as DataSources.tsx's own
  // Existing data view, so "page 2" is always a real, bounded slice rather
  // than however many rows one huge category happens to have.
  const totalPages = Math.max(1, Math.ceil(filtered.length / CONNECT_POPUP_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageSlice = filtered.slice((currentPage - 1) * CONNECT_POPUP_PAGE_SIZE, currentPage * CONNECT_POPUP_PAGE_SIZE);
  const groupCats = category === "all" ? DATA_SOURCE_CATEGORIES : [category];
  const grouped = groupCats
    .map((cat) => ({ category: cat, sources: pageSlice.filter((ds) => dataSourceCategory(ds.kind) === cat) }))
    .filter((g) => g.sources.length > 0);
  const hasFiltersApplied = query.trim() !== "" || category !== "all";

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start sm:items-center justify-center bg-black/60 p-4 overflow-y-auto"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="card w-full max-w-lg my-8 sm:my-0 flex flex-col max-h-[85vh]">
        <div className="p-4 border-b border-border flex items-center justify-between gap-3 shrink-0">
          <div className="font-bold text-[16px]">Connect data</div>
          <button type="button" className="text-muted hover:text-text transition shrink-0" onClick={onClose} aria-label="Close">
            <CloseIcon className="w-5 h-5" />
          </button>
        </div>

        <div className="px-4 pt-3 flex items-center gap-4 shrink-0 border-b border-border">
          <button
            type="button"
            onClick={() => setTab("existing")}
            className={`px-1 py-2 text-sm font-medium border-b-2 -mb-px transition ${
              tab === "existing" ? "border-primary text-primary" : "border-transparent text-muted hover:text-text"
            }`}
          >
            Your data{sources ? ` (${sources.length})` : ""}
          </button>
          <button
            type="button"
            onClick={() => setTab("new")}
            className={`px-1 py-2 text-sm font-medium border-b-2 -mb-px transition ${
              tab === "new" ? "border-primary text-primary" : "border-transparent text-muted hover:text-text"
            }`}
          >
            Upload / connect new
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {tab === "new" ? (
            <DataSourceForm onCreated={handleCreated} />
          ) : sources === null ? (
            <div className="text-xs text-muted py-4 text-center">Loading&hellip;</div>
          ) : sources.length === 0 ? (
            <div className="text-center py-6">
              <div className="text-xs text-muted mb-3">Nothing connected in this workspace yet.</div>
              <button type="button" className="btn-primary text-sm px-4 py-2" onClick={() => setTab("new")}>
                + Connect your first data source
              </button>
            </div>
          ) : (
            <>
              {/* 2026-09-23, round two: search always shown (was hidden
                  under 6 sources, which meant the category picker below was
                  the only filter most people ever saw) - `.input-icon-sm`
                  (see index.css) keeps its icon from sitting on top of the
                  placeholder text, same fix as every other search box in
                  this app. */}
              <div className="relative mb-3">
                <SearchIcon className="w-3.5 h-3.5 text-muted absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  autoFocus
                  className="input input-icon-sm text-sm w-full py-2"
                  placeholder="Search your data..."
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>

              {/* Same segmented, icon-plus-label category picker as
                  DataSourceForm's own Database/Warehouse/Connect/Upload
                  file tabs (and the /data page's Existing data view) - not
                  a plain list with no way to narrow it down. Each slot has
                  its own generous padding so the four never crowd each
                  other or the words inside them. */}
              <div className="grid grid-cols-5 gap-1.5 p-1.5 mb-4 rounded-xl bg-surface2 border border-border">
                {(
                  [
                    { key: "all" as const, label: "All", Icon: AllGlyph },
                    { key: "Files" as const, label: "Files", Icon: categoryGlyph("Files") },
                    { key: "Databases" as const, label: "Databases", Icon: categoryGlyph("Databases") },
                    { key: "Warehouses" as const, label: "Warehouses", Icon: categoryGlyph("Warehouses") },
                    { key: "Apps" as const, label: "Apps", Icon: categoryGlyph("Apps") },
                  ]
                ).map((t) => (
                  <button
                    type="button"
                    key={t.key}
                    onClick={() => setCategory(t.key)}
                    aria-pressed={category === t.key}
                    className={`flex flex-col items-center justify-center gap-1 px-1 py-2.5 rounded-lg text-[11px] font-medium leading-tight transition ${
                      category === t.key ? "bg-primary text-on-primary shadow-sm" : "text-muted hover:text-text"
                    }`}
                  >
                    <t.Icon className="w-4 h-4 shrink-0" />
                    <span className="w-full text-center truncate">{t.label}</span>
                  </button>
                ))}
              </div>

              {grouped.length === 0 ? (
                <div className="text-xs text-muted text-center py-6">
                  No sources match your filters.{" "}
                  {hasFiltersApplied && (
                    <button
                      type="button"
                      className="text-primary font-medium hover:underline"
                      onClick={() => { setQuery(""); setCategory("all"); }}
                    >
                      Clear filters
                    </button>
                  )}
                </div>
              ) : (
                grouped.map((g) => (
                  <div key={g.category} className="mb-4 last:mb-0">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-muted mb-1.5 px-0.5">
                      {g.category}
                    </div>
                    <div className="space-y-1">
                      {g.sources.map((ds) => {
                        const meta = connectionKindMeta(ds.kind);
                        const picked = isSelected(ds.id);
                        return (
                          <button
                            key={ds.id}
                            type="button"
                            aria-pressed={picked}
                            onClick={() => toggleSource(ds)}
                            className={`w-full flex items-center gap-2.5 px-2.5 py-2.5 rounded-lg text-left transition group border ${
                              picked
                                ? "bg-primary/10 border-primary/40"
                                : "border-transparent hover:bg-surface2"
                            }`}
                          >
                            <span
                              className="w-7 h-7 rounded-md flex items-center justify-center shrink-0"
                              style={{ backgroundColor: `${meta.color}1a`, color: meta.color }}
                            >
                              <meta.Logo className="w-3.5 h-3.5" />
                            </span>
                            <span className="text-sm truncate flex-1 text-text/90 group-hover:text-text">{ds.name}</span>
                            <span
                              className={`w-5 h-5 rounded-md flex items-center justify-center shrink-0 border transition ${
                                picked ? "bg-primary border-primary text-on-primary" : "border-border text-transparent"
                              }`}
                              aria-hidden
                            >
                              <CheckIcon className="w-3 h-3" />
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))
              )}

              <Pager page={currentPage} totalPages={totalPages} onChange={setPage} />
            </>
          )}
        </div>

        {/* The running selection, shown as the same chip pattern as the
            in-chat WORKING ON control (ChatPanel.tsx) - a colored dot,
            truncated name, and a remove x per source - plus one "Continue"
            action that carries every picked source into the new workspace
            at once. Only rendered once something is actually selected, so
            the popup looks exactly as before until someone picks a first
            source. */}
        {selected.length > 0 && (
          <div className="p-4 border-t border-border shrink-0 bg-surface1/60">
            <div className="flex flex-wrap items-center gap-1.5 mb-3">
              {selected.map((ds) => (
                <span
                  key={ds.id}
                  className="inline-flex items-center gap-1.5 max-w-[200px] pl-2 pr-1 py-1 rounded-lg border border-border bg-surface2 text-xs"
                  title={ds.name}
                >
                  <SourceDot generated={false} />
                  <span className="truncate">{ds.name}</span>
                  <button
                    type="button"
                    className="shrink-0 rounded p-0.5 text-muted hover:text-text hover:bg-border/60 transition"
                    onClick={() => toggleSource(ds)}
                    aria-label={`Remove ${ds.name}`}
                  >
                    <ChipCloseIcon />
                  </button>
                </span>
              ))}
            </div>
            <button type="button" className="btn-primary w-full text-sm py-2.5 font-semibold" onClick={continueWithSelection}>
              Continue with {selected.length} {selected.length === 1 ? "source" : "sources"} &rarr;
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

// ===========================================================================================
// 2026-10-15 (R50, GD360 3.0): the one shell. Every signed-in page renders this rail - a 72 px column of
// labelled icons (mockup boards 01 and 06) - and, on phones, a bottom tab bar instead. The "G" mark opens the
// workspace menu (switch, create, invite, brand kit, domain); "More" holds the rest of the product. The older
// 240 px sidebar with its own Spaces list and drawer is gone: Spaces live on Home and on the Data page.
// ===========================================================================================

// R56 (mobile board): the phone tab bar reads as the day - Today, Ask, Saved
const PHONE_LABEL: Record<string, string> = { home: "Today", new: "Ask", library: "Saved" };
const GX = {
  home: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" /></svg>,
  plus: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>,
  lib: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 5h16v14H4zM8 5v14M4 10h16" /></svg>,
  grid: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></svg>,
  db: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><ellipse cx="12" cy="6" rx="7" ry="3" /><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3" /></svg>,
  bolt: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M13 3L5 14h6l-1 7 8-11h-6l1-7z" /></svg>,
  mic: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>,
  more: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></svg>,
  gear: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" /></svg>,
  team: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-5-6.3" /></svg>,
  ml: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="6" cy="6" r="2.2" /><circle cx="18" cy="6" r="2.2" /><circle cx="12" cy="18" r="2.2" /><path d="M7.8 7.4l3.2 8.6M16.2 7.4L13 16M8.2 6h7.6" /></svg>,
  target: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4.5" /><path d="M12 12 19 5M16 5h3v3" /></svg>,
  flask: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.7 3h10.6A2 2 0 0 0 19 18l-5-9V3" /></svg>,
  shield: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" /><path d="M9 12l2 2 4-4" /></svg>,
  help: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01" /></svg>,
  palette: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.6-.8 1.3-1.7-.4-1 .2-2.3 1.6-2.3H17a4 4 0 0 0 4-4c0-5.5-4-10-9-10z" /><circle cx="7.5" cy="11" r="1" /><circle cx="11" cy="7" r="1" /><circle cx="16" cy="8.5" r="1" /></svg>,
  globe: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z" /></svg>,
  check: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7" /></svg>,
  close: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>,
  invite: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="10" cy="8" r="3.5" /><path d="M3.5 20a6.5 6.5 0 0 1 13 0M19 8v6M16 11h6" /></svg>,
};

type RailMenu = { kind: "ws" | "more"; x: number; y: number; sheet: boolean } | null;

/** Where each place in the product is "on" - one list, used by the rail and the phone tabs. */
export function railActive(pathname: string): string {
  const p = pathname;
  if (p === "/") return "home";
  if (p.startsWith("/chat")) return "new";
  if (p.startsWith("/library") || p.startsWith("/docs/") || p.startsWith("/projects") || p.startsWith("/p/") || p.startsWith("/g/") || p.startsWith("/v/") || p.startsWith("/workspace/")) return "library";
  if (p.startsWith("/dashboards") || p.startsWith("/boards") || p.startsWith("/dashboard-builder") || p.startsWith("/project-dashboards")) return "dashboards";
  if (p.startsWith("/data") || p.startsWith("/spaces") || p.startsWith("/connect")) return "data";
  if (p.startsWith("/automations") || p.startsWith("/automate") || p.startsWith("/jobs")) return "automations";
  if (p.startsWith("/ml-") || p.startsWith("/ml/") || p.startsWith("/models")) return "models";
  if (p.startsWith("/initiatives") || p.startsWith("/events/app")) return "initiatives";
  if (p.startsWith("/profile") || p.startsWith("/settings")) return "settings";
  return "more";
}

function MenuPanel({ menu, onClose, children, label }: { menu: NonNullable<RailMenu>; onClose: () => void; children: React.ReactNode; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: menu.x, top: menu.y });
  useEffect(() => {
    const el = ref.current;
    if (!el || menu.sheet) return;
    const h = el.offsetHeight, w = el.offsetWidth;
    setPos({ left: Math.min(menu.x, window.innerWidth - w - 12), top: Math.max(12, Math.min(menu.y, window.innerHeight - h - 12)) });
  }, [menu]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest("[data-gx-menu-trigger]")) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [onClose]);
  return createPortal(
    <div ref={ref} className={`gx-menu${menu.sheet ? " sheet" : ""}`} role="menu" aria-label={label} style={menu.sheet ? undefined : { left: pos.left, top: pos.top }} data-gx-menu={menu.kind}>
      {children}
    </div>,
    document.body,
  );
}

// ===========================================================================================
// 2026-10-19 (R57, "ask flow fixes" board 3): the labelled sidebar. One tap on the GD360 mark (or ☰ on a phone)
// slides it out over the page - New question, every place by its name, what needs you, your recent questions,
// Euliv (with "or say Hi Euliv" - the hint that used to float over the avatar), Settings and you. It closes on a
// tap outside, Esc, the arrow, or going anywhere. Nothing it shows is made up: the Automate count is the same
// "needs you" list Home reads, the recents are your real conversations.
// ===========================================================================================
export const OPEN_SIDEBAR_EVENT = "gx:open-sidebar";
export const openSidebar = () => window.dispatchEvent(new Event(OPEN_SIDEBAR_EVENT));

function SidePanel({ on, workspaceId, wsLabel, initials, name, items, onClose, onWorkspace }: {
  on: string; workspaceId: string; wsLabel: string; initials: string; name: string;
  items: { key: string; label: string; to: string; icon: React.ReactNode }[];
  onClose: () => void; onWorkspace: (el: HTMLElement) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const [recent, setRecent] = useState<ConversationRow[] | null>(null);
  const [needs, setNeeds] = useState(0);
  const { pathname } = useLocation();
  useEffect(() => {
    let live = true;
    v2Api.list(workspaceId || null).then((r) => live && setRecent(r.slice(0, 6))).catch(() => live && setRecent([]));
    Promise.all([
      opsApi.overview(workspaceId || null).then((o) => (o.attention || []).length).catch(() => 0),
      flowsApi.list(workspaceId || null).then((f) => f.filter((x) => x.needs_fix).length).catch(() => 0),
    ]).then(([a, b]) => live && setNeeds(a + b));
    return () => { live = false; };
  }, [workspaceId]);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeRef.current(); };
    document.addEventListener("keydown", onKey);
    // focus the first thing in the panel, and give it back to the mark on close
    const back = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("[data-gx-sb-new]")?.focus({ preventScroll: true });
    return () => { document.removeEventListener("keydown", onKey); if (back && document.contains(back)) back.focus({ preventScroll: true }); };
  }, []);
  const convId = pathname.startsWith("/chat/") ? pathname.split("/")[2] : "";
  return createPortal(
    <>
      <div className="gx-sb-dim" onClick={onClose} aria-hidden="true" data-gx-sb-dim="" />
      <aside ref={ref} className="gx-sb" aria-label="Sidebar" data-gx-sidebar="" role="dialog" aria-modal="true">
        <div className="gx-sb-hd">
          <BrandMark size={30} />
          <b className="gx-sb-word">GD<span>360</span></b>
          <span style={{ flex: 1 }} />
          <button type="button" className="gx-sb-x" onClick={onClose} aria-label="Close the sidebar" data-gx-sb-close="">{GX.close}</button>
        </div>
        <Link to="/chat" className="gx-sb-new" onClick={onClose} data-gx-sb-new="">{GX.plus}New question</Link>
        <nav className="gx-sb-nav" aria-label="Places">
          {items.map((it) => (
            <Link key={it.key} to={it.to} onClick={onClose} className={`gx-sb-i${on === it.key ? " on" : ""}`} aria-current={on === it.key ? "page" : undefined} data-gx-sb-item={it.key}>
              {it.icon}<span>{it.label}</span>
              {it.key === "automations" && needs > 0 && <span className="gx-sb-badge" aria-label={`${needs} need you`} data-gx-sb-needs="">{needs}</span>}
            </Link>
          ))}
        </nav>
        <div className="gx-sb-k">Recent</div>
        <div className="gx-sb-recent" data-gx-sb-recent="">
          {recent === null && <><span className="gx-sb-skel" /><span className="gx-sb-skel" /><span className="gx-sb-skel" /></>}
          {recent && !recent.length && <span className="gx-sb-none">Your questions will show here.</span>}
          {recent?.map((c) => (
            <Link key={c.id} to={`/chat/${c.id}`} onClick={onClose} className={`gx-sb-rc${c.id === convId ? " on" : ""}`} title={c.title}>{c.title || "Untitled"}</Link>
          ))}
          {!!recent?.length && <Link to="/library" onClick={onClose} className="gx-sb-rc all">See all in Library</Link>}
        </div>
        <span style={{ flex: 1, minHeight: 12 }} />
        {eulivAvailable() && (
          <button type="button" className="gx-sb-i" onClick={() => { onClose(); openEuliv(); }} data-gx-sb-euliv="">
            {GX.mic}<span className="two">Talk to Euliv<small>or say “Hi Euliv” on Home</small></span>
            <span className="gx-sb-live" aria-hidden="true" />
          </button>
        )}
        <Link to="/settings" onClick={onClose} className={`gx-sb-i${on === "settings" ? " on" : ""}`}>{GX.gear}<span>Settings</span></Link>
        <button type="button" className="gx-sb-me" data-gx-menu-trigger="" onClick={(e) => onWorkspace(e.currentTarget)} aria-label={`${name}, ${wsLabel}. Switch or manage workspace`}>
          <span className="gx-logo" style={{ marginTop: 0 }}>{initials}</span>
          <span className="two"><b>{name}</b><small>{wsLabel}</small></span>
        </button>
      </aside>
    </>,
    document.body,
  );
}

export default function AppSidebar({
  workspaces,
  activeWorkspaceId,
  onWorkspaceSwitch,
  onWorkspaceCreated,
}: {
  // The account's real workspaces and which one is active right now - both owned by whichever page renders
  // this rail (see lib/useWorkspaceNav), since switching workspace also has to refetch that page's content.
  workspaces: WorkspaceSummary[];
  activeWorkspaceId: string;
  onWorkspaceSwitch: (id: string) => void;
  onWorkspaceCreated: (ws: WorkspaceSummary) => void;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [showBrandKit, setShowBrandKit] = useState(false);
  const [menu, setMenu] = useState<RailMenu>(null);
  const [side, setSide] = useState(false);
  useEffect(() => { setMenu(null); setSide(false); }, [location.pathname]);
  useEffect(() => {
    const open = () => { setMenu(null); setSide(true); };
    window.addEventListener(OPEN_SIDEBAR_EVENT, open);
    return () => window.removeEventListener(OPEN_SIDEBAR_EVENT, open);
  }, []);

  // the top bar's workspace name opens the same menu (components/TopNav.tsx)
  useEffect(() => {
    const open = (e: Event) => {
      const d = (e as CustomEvent).detail || {};
      setMenu({ kind: "ws", x: Number(d.x) || 80, y: Number(d.y) || 64, sheet: window.innerWidth <= 760 });
    };
    window.addEventListener("gx:open-workspace-menu", open);
    return () => window.removeEventListener("gx:open-workspace-menu", open);
  }, []);

  const on = railActive(location.pathname);
  const active = workspaces.find((w) => w.id === activeWorkspaceId) || workspaces[0];
  const isAdmin = ["owner", "admin"].includes(active?.role || "");
  const openAt = (kind: "ws" | "more", el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const sheet = window.innerWidth <= 760;
    setMenu((m) => (m?.kind === kind ? null : { kind, x: sheet ? 8 : r.right + 10, y: sheet ? 0 : r.top, sheet }));
  };
  const close = () => setMenu(null);
  const go = (to: string) => { close(); navigate(to); };

  const primary = [
    { key: "home", label: "Home", to: "/", icon: GX.home },
    { key: "new", label: "New", to: "/chat", icon: GX.plus },
    { key: "library", label: "Library", to: "/library", icon: GX.lib },
    { key: "dashboards", label: "Dashboards", to: "/dashboards", icon: GX.grid },
    { key: "data", label: "Data", to: "/data", icon: GX.db },
    { key: "automations", label: "Automate", to: "/automations", icon: GX.bolt },
    { key: "models", label: "Models", to: "/ml-models", icon: GX.ml },
    { key: "initiatives", label: "Initiatives", to: "/initiatives", icon: GX.target },
  ];
  // the rail's order (mockup "Studio" rail): New, then Home, Library, Dashboards, Data, Automate, Models, Initiatives
  const railItems = primary.filter((it) => it.key !== "new");
  const initials = ((user?.full_name || user?.email || "G").split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("") || "G").toUpperCase();

  return (
    <>
      <nav className="gx-rail" aria-label="Main" data-gx-rail="" data-sidebar-rail="rail">
        <button type="button" className="gx-mark" aria-label="Open the sidebar" title="Open the sidebar" aria-expanded={side} data-gx-open-sidebar=""
          onClick={() => { setMenu(null); setSide((x) => !x); }}><BrandMark size={34} /></button>
        <Link to="/chat" className={`gx-new${on === "new" ? " on" : ""}`} aria-current={on === "new" ? "page" : undefined} data-nav="new" title="New">
          {GX.plus}<span className="gx-sr">New</span>
        </Link>
        {railItems.map((it) => (
          <Link key={it.key} to={it.to} className={`gx-ri${on === it.key ? " on" : ""}`} aria-current={on === it.key ? "page" : undefined} data-nav={it.key} title={it.label}>
            {it.icon}<span className="gx-sr">{it.label}</span>
          </Link>
        ))}
        <span className="gx-spacer" />
        {eulivAvailable() && <button type="button" className="gx-ri gx-euliv" onClick={() => openEuliv()} aria-label="Talk to Euliv, the voice assistant" data-nav="euliv" title="Talk to Euliv - or say “Hi Euliv” on Home">{GX.mic}<span className="gx-sr">Euliv</span></button>}
        <button type="button" className={`gx-ri${on === "more" ? " on" : ""}`} data-gx-menu-trigger="" aria-haspopup="menu" aria-expanded={menu?.kind === "more"}
          onClick={(e) => openAt("more", e.currentTarget)} data-nav="more" title="More">{GX.more}<span className="gx-sr">More</span></button>
        <Link to="/settings" className={`gx-ri${on === "settings" ? " on" : ""}`} aria-current={on === "settings" ? "page" : undefined} data-nav="settings" title="Settings">{GX.gear}<span className="gx-sr">Settings</span></Link>
        <button type="button" className="gx-logo gx-me" data-gx-menu-trigger="" data-gx-ws="" aria-haspopup="menu" aria-expanded={menu?.kind === "ws"}
          aria-label={`Workspace: ${active?.name || "Personal Workspace"}. Switch or manage`} title={active?.name || "Workspace"}
          onClick={(e) => openAt("ws", e.currentTarget)}>
          {initials}
        </button>
      </nav>

      <nav className="gx-tabs" aria-label="Main" data-gx-tabs="">
        {primary.filter((it) => ["home", "new", "library", "dashboards"].includes(it.key)).map((it) => (
          <Link key={it.key} to={it.to} className={`gx-tab${on === it.key ? " on" : ""}`} aria-current={on === it.key ? "page" : undefined}>{it.icon}{PHONE_LABEL[it.key] || it.label}</Link>
        ))}
        <button type="button" className={`gx-tab${["more", "data", "automations", "settings", "models", "initiatives"].includes(on) ? " on" : ""}`} data-gx-menu-trigger="" aria-haspopup="menu"
          aria-expanded={menu?.kind === "more"} onClick={(e) => openAt("more", e.currentTarget)} data-gx-tab-more="">{GX.more}More</button>
      </nav>

      {side && (
        <SidePanel on={on} workspaceId={activeWorkspaceId} items={primary.filter((it) => it.key !== "new")} initials={initials}
          name={user?.full_name || user?.email || "You"}
          wsLabel={active ? `${active.is_personal ? "Personal workspace" : active.name}${active.is_personal ? "" : " · Team"}` : "Workspace"}
          onClose={() => setSide(false)}
          onWorkspace={(el) => { const r = el.getBoundingClientRect(); setSide(false); setMenu({ kind: "ws", x: window.innerWidth <= 760 ? 8 : r.left, y: window.innerWidth <= 760 ? 0 : r.top - 8, sheet: window.innerWidth <= 760 }); }} />
      )}

      {menu?.kind === "ws" && (
        <MenuPanel menu={menu} onClose={close} label="Workspace">
          <div className="hd">Your workspaces</div>
          {workspaces.map((ws) => (
            <button key={ws.id} type="button" role="menuitem" onClick={() => { close(); onWorkspaceSwitch(ws.id); }}>
              <span className="ws">{ws.is_personal ? "G" : ws.name.charAt(0).toUpperCase()}</span>
              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ws.name}{ws.role === "viewer" ? " · View only" : ""}</span>
              {ws.id === activeWorkspaceId && <span className="meta" style={{ color: "rgb(var(--color-primary))" }}>{GX.check}</span>}
            </button>
          ))}
          <div className="sep" />
          <button type="button" role="menuitem" onClick={() => { close(); setShowCreateModal(true); }}>{GX.plus}Create workspace</button>
          <button type="button" role="menuitem" disabled={!!active?.is_personal}
            title={active?.is_personal ? "Personal Workspace is just for you - create or switch to a team workspace to invite people" : undefined}
            onClick={() => { close(); setShowInviteModal(true); }}>{GX.invite}Invite teammates</button>
          <button type="button" role="menuitem" data-open-brand-kit="" onClick={() => { close(); setShowBrandKit(true); }}>{GX.palette}Brand kit…</button>
          <button type="button" role="menuitem" data-open-domain="" onClick={() => go("/settings/domains")}>{GX.globe}Company domain…</button>
        </MenuPanel>
      )}

      {menu?.kind === "more" && (
        <MenuPanel menu={menu} onClose={close} label="More">
          {menu.sheet && (
            <>
              <button type="button" role="menuitem" onClick={() => go("/data")}>{GX.db}Data and Spaces</button>
              <button type="button" role="menuitem" onClick={() => go("/automations")}>{GX.bolt}Automations</button>
              <button type="button" role="menuitem" onClick={() => go("/automate")}>{GX.db}Automate data</button>
              {eulivAvailable() && <button type="button" role="menuitem" onClick={() => { close(); openEuliv(); }}>{GX.mic}Talk to Euliv</button>}
              <div className="sep" />
            </>
          )}
          <div className="hd">More of GD360</div>
          <button type="button" role="menuitem" onClick={() => go("/ml-models")}>{GX.ml}ML Studio</button>
          <button type="button" role="menuitem" onClick={() => go("/initiatives")}>{GX.target}Initiatives<span className="meta">Pro</span></button>
          <button type="button" role="menuitem" onClick={() => go("/experiments")}>{GX.flask}Experiments</button>
          {isAdmin && <button type="button" role="menuitem" onClick={() => go("/trust")} data-nav="trust">{GX.shield}Trust Center</button>}
          <div className="sep" />
          <button type="button" role="menuitem" disabled={!!active?.is_personal} onClick={() => { close(); setShowInviteModal(true); }}
            title={active?.is_personal ? "Switch to a team workspace to invite people" : undefined}>{GX.team}Team and invites</button>
          <button type="button" role="menuitem" data-nav="help" onClick={() => { close(); window.dispatchEvent(new Event("gd360:open-help")); }}>{GX.help}Help and support</button>
          {menu.sheet && (
            <>
              <button type="button" role="menuitem" onClick={() => go("/profile")}>{GX.gear}Settings</button>
              <button type="button" role="menuitem" onClick={() => setMenu({ kind: "ws", x: 8, y: 0, sheet: true })}><span className="ws">G</span>Switch workspace<span className="meta">{active?.name}</span></button>
            </>
          )}
        </MenuPanel>
      )}

      {showCreateModal && (
        <CreateWorkspaceModal
          onClose={() => setShowCreateModal(false)}
          onCreated={(ws) => {
            setShowCreateModal(false);
            onWorkspaceCreated(ws);
          }}
        />
      )}
      {showInviteModal && user && (
        <InviteMembersModal workspaceId={activeWorkspaceId} currentUserId={user.id} onClose={() => setShowInviteModal(false)} />
      )}
      {showBrandKit && activeWorkspaceId && (
        <BrandKitSheet
          open
          onClose={() => setShowBrandKit(false)}
          workspaceId={activeWorkspaceId}
          workspaceName={workspaces.find((w) => w.id === activeWorkspaceId)?.name}
          initial={workspaces.find((w) => w.id === activeWorkspaceId)?.brand_kit ?? null}
        />
      )}
    </>
  );
}
