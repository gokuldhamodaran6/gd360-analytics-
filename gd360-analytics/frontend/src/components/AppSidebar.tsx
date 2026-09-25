import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../api/AuthContext";
import { datasourceApi, DataSourceSummary, WorkspaceDetail, WorkspaceSummary, workspaceApi } from "../api/client";
import DataSourceForm, { connectionKindMeta, dataSourceCategory, DATA_SOURCE_CATEGORIES } from "./DataSourceForm";
import { ChipCloseIcon, SourceDot } from "./ChatPanel";

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

// 2026-09-23 (shared dashboards v1): a second top-level nav entry next to
// Projects, for the new /dashboards list page.
function DashboardsIcon({ className = "w-[18px] h-[18px]" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3v18h18" />
      <rect x="7" y="12" width="3" height="6" rx="0.5" />
      <rect x="13" y="8" width="3" height="10" rx="0.5" />
      <rect x="18" y="5" width="3" height="13" rx="0.5" />
    </svg>
  );
}

// 2026-09-23 (sidebar redesign round): a third top-level nav entry, for the
// new /data page - every connected source, browsable by category, replaces
// this sidebar's old always-expanded flat list.
function DataSourcesIcon({ className = "w-[18px] h-[18px]" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
      <path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" />
    </svg>
  );
}

function SearchIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  );
}

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

function categoryGlyph(cat: "Files" | "Databases" | "Warehouses") {
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
      active ? "bg-primary text-white border-primary font-semibold" : "border-border text-muted hover:text-text hover:bg-surface2"
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
function WorkspaceSwitcher({
  workspaces,
  activeWorkspaceId,
  onSwitch,
  onOpenCreate,
  onOpenInvite,
}: {
  workspaces: WorkspaceSummary[];
  activeWorkspaceId: string;
  onSwitch: (id: string) => void;
  onOpenCreate: () => void;
  onOpenInvite: () => void;
}) {
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

  const active = workspaces.find((w) => w.id === activeWorkspaceId) || workspaces[0];
  const activeName = active?.name || "Personal Workspace";

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
          <span className="block text-[11px] text-muted truncate">
            {activeName}
            {active?.role === "viewer" && " · View only"}
          </span>
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
          <div className="max-h-56 overflow-y-auto">
            {workspaces.map((ws) => (
              <button
                key={ws.id}
                type="button"
                onClick={() => { onSwitch(ws.id); setOpen(false); }}
                className="w-full flex items-center gap-2.5 px-3.5 py-2 text-sm text-left hover:bg-surface2 transition"
              >
                <span className="w-6 h-6 rounded-md bg-primary flex items-center justify-center text-white font-bold text-[11px] shrink-0">
                  {ws.is_personal ? "G" : ws.name.charAt(0).toUpperCase()}
                </span>
                <span className="flex-1 truncate">
                  {ws.name}
                  {ws.role === "viewer" && <span className="text-muted"> · View only</span>}
                </span>
                {ws.id === activeWorkspaceId && <CheckIcon className="w-3.5 h-3.5 text-primary shrink-0" />}
              </button>
            ))}
          </div>
          <div className="border-t border-border my-1.5" />
          <button
            type="button"
            onClick={() => { setOpen(false); onOpenCreate(); }}
            className="w-full flex items-center gap-2.5 px-3.5 py-2 text-sm text-left hover:bg-surface2 transition"
          >
            <PlusIcon className="w-3.5 h-3.5 text-muted" /> Create workspace
          </button>
          <button
            type="button"
            disabled={!!active?.is_personal}
            title={active?.is_personal ? "Personal Workspace is just for you - create or switch to a team workspace to invite people" : "Invite teammates"}
            onClick={() => { setOpen(false); onOpenInvite(); }}
            className={`w-full flex items-center gap-2.5 px-3.5 py-2 text-sm text-left transition ${
              active?.is_personal ? "text-muted cursor-not-allowed" : "hover:bg-surface2"
            }`}
          >
            <UserPlusIcon className="w-3.5 h-3.5 text-muted" /> Invite teammates
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
  const updateRole = async (userId: string, role: "member" | "viewer") => {
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
            {isOwner && (
              <button type="button" disabled={busy} className="text-xs text-muted hover:text-text transition mb-5" onClick={regenerate}>
                Reset link (old link stops working)
              </button>
            )}
            {!isOwner && <div className="mb-5" />}

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
                  {isOwner && m.user_id !== currentUserId && m.role !== "owner" ? (
                    <select
                      className="text-[11px] bg-surface2 border border-border rounded-md px-1.5 py-1 shrink-0 cursor-pointer"
                      value={m.role}
                      disabled={busy}
                      title="What this person can do in this workspace"
                      onChange={(e) => updateRole(m.user_id, e.target.value as "member" | "viewer")}
                    >
                      <option value="member">Can edit</option>
                      <option value="viewer">Can view</option>
                    </select>
                  ) : (
                    <span className="text-[10px] uppercase tracking-wide text-muted shrink-0">
                      {m.role === "owner" ? "Owner" : m.role === "viewer" ? "Can view" : "Can edit"}
                    </span>
                  )}
                  {isOwner && m.user_id !== currentUserId && (
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
  const [category, setCategory] = useState<"all" | "Files" | "Databases" | "Warehouses">("all");
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
          <div className="font-bold text-base">Connect data</div>
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
              <div className="grid grid-cols-4 gap-1.5 p-1.5 mb-4 rounded-xl bg-surface2 border border-border">
                {(
                  [
                    { key: "all" as const, label: "All", Icon: AllGlyph },
                    { key: "Files" as const, label: "Files", Icon: categoryGlyph("Files") },
                    { key: "Databases" as const, label: "Databases", Icon: categoryGlyph("Databases") },
                    { key: "Warehouses" as const, label: "Warehouses", Icon: categoryGlyph("Warehouses") },
                  ]
                ).map((t) => (
                  <button
                    type="button"
                    key={t.key}
                    onClick={() => setCategory(t.key)}
                    aria-pressed={category === t.key}
                    className={`flex flex-col items-center justify-center gap-1 px-1 py-2.5 rounded-lg text-[11px] font-medium leading-tight transition ${
                      category === t.key ? "bg-primary text-white shadow-sm" : "text-muted hover:text-text"
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
                                picked ? "bg-primary border-primary text-white" : "border-border text-transparent"
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

function MenuIcon({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18M3 12h18M3 18h18" />
    </svg>
  );
}

// 2026-09-25e (responsive pass): the workspace switcher + three nav links,
// extracted so the exact same content renders both in the desktop static
// rail below AND in the new mobile drawer (see AppSidebar below) without
// keeping two copies of this markup in sync by hand. `onNavigate` is fired
// after every Link click - a no-op on desktop, closes the drawer on
// mobile.
function SidebarNav({
  workspaces,
  activeWorkspaceId,
  pathname,
  onSwitch,
  onOpenCreate,
  onOpenInvite,
  onNavigate,
}: {
  workspaces: WorkspaceSummary[];
  activeWorkspaceId: string;
  pathname: string;
  onSwitch: (id: string) => void;
  onOpenCreate: () => void;
  onOpenInvite: () => void;
  onNavigate: () => void;
}) {
  const onProjects = pathname === "/";

  return (
    <>
      <WorkspaceSwitcher
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        onSwitch={onSwitch}
        onOpenCreate={onOpenCreate}
        onOpenInvite={onOpenInvite}
      />

      <div className="px-3 mt-1 space-y-0.5">
        <Link
          to="/"
          onClick={onNavigate}
          className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition ${
            onProjects ? "bg-primary text-white" : "text-text hover:bg-surface2"
          }`}
        >
          <ProjectsIcon />
          Projects
        </Link>
        <Link
          to="/dashboards"
          onClick={onNavigate}
          className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition ${
            // 2026-09-25d (elite pass): /dashboard-builder/:id (the pages+
            // blocks editor - see App.tsx's own routing comment for why
            // it's a deliberately different path prefix from /dashboards)
            // is still, conceptually, "being in Dashboards" - now that it
            // also renders this sidebar, it should highlight the same nav
            // item rather than leaving nothing active while editing one.
            pathname.startsWith("/dashboards") || pathname.startsWith("/dashboard-builder")
              ? "bg-primary text-white"
              : "text-text hover:bg-surface2"
          }`}
        >
          <DashboardsIcon />
          Dashboards
        </Link>
        <Link
          to="/data"
          onClick={onNavigate}
          className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition ${
            pathname.startsWith("/data") ? "bg-primary text-white" : "text-text hover:bg-surface2"
          }`}
        >
          <DataSourcesIcon />
          Data Sources
        </Link>
      </div>

      {/* 2026-09-23, round three (Gokul's own explicit ask): the sidebar's
          own "+ Connect data" shortcut is gone - adding data now happens in
          exactly one place, the Data Sources page (/data), instead of two
          different entry points that could drift out of sync. The Data
          Sources link two lines up is how a person gets there.
          ConnectDataPopup itself stays exported from this file - it's still
          used by pages/NewProject.tsx's own "Connect data" button. */}
      <div className="flex-1" />
    </>
  );
}

export default function AppSidebar({
  workspaces,
  activeWorkspaceId,
  onWorkspaceSwitch,
  onWorkspaceCreated,
}: {
  // The account's real workspaces and which one is active right now - both
  // owned by whichever page renders this sidebar (see lib/useWorkspaceNav),
  // since switching workspace also has to refetch that page's own content,
  // not just this sidebar.
  workspaces: WorkspaceSummary[];
  activeWorkspaceId: string;
  onWorkspaceSwitch: (id: string) => void;
  onWorkspaceCreated: (ws: WorkspaceSummary) => void;
}) {
  const location = useLocation();
  const { user } = useAuth();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showInviteModal, setShowInviteModal] = useState(false);
  // 2026-09-25e (responsive pass): this used to just be "hidden lg:flex" -
  // every page that renders this sidebar (Dashboard, Dashboards,
  // DataSources, NewProject, DashboardBuilderView) genuinely had NO way to
  // get from Projects to Dashboards to Data Sources on a phone; the sidebar
  // just vanished below `lg` with nothing replacing it. This turns it into
  // a real off-canvas drawer instead: same WorkspaceSwitcher + nav links,
  // opened from a small fixed menu button, closed by its own X, the
  // backdrop, Escape, or picking a destination. Kept entirely self-
  // contained in this one file (its own open/close state, its own trigger
  // button rendered here) rather than threading a new prop through every
  // caller and TopNav.tsx - lower risk, and every page gets the fix with no
  // changes of its own.
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => setMobileOpen(false), [location.pathname]);

  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [mobileOpen]);

  return (
    <>
      {/* Mobile-only trigger - below `lg` this is the sole way to reach
          this nav, so it stays fixed/reachable from anywhere on the page
          rather than only from the top of it. */}
      <button
        type="button"
        onClick={() => setMobileOpen(true)}
        aria-label="Open menu"
        className="lg:hidden fixed top-3 left-3 z-30 w-10 h-10 rounded-xl bg-surface/90 backdrop-blur-sm border border-border shadow-lg flex items-center justify-center text-text hover:bg-surface2 transition"
      >
        <MenuIcon />
      </button>

      {/* Mobile drawer - always mounted below `lg` (not conditionally
          rendered) so open/close animate via CSS transitions instead of an
          abrupt mount/unmount; inert and aria-hidden while closed. */}
      <div
        className={`lg:hidden fixed inset-0 z-40 transition-opacity duration-300 ${
          mobileOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
        aria-hidden={!mobileOpen}
      >
        <div className="absolute inset-0 bg-black/60" onClick={() => setMobileOpen(false)} />
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Navigation"
          className={`absolute left-0 top-0 h-full w-72 max-w-[85vw] bg-surface border-r border-border shadow-2xl flex flex-col transition-transform duration-300 ${
            mobileOpen ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <div className="flex items-center justify-end px-3 pt-3 shrink-0">
            <button
              type="button"
              onClick={() => setMobileOpen(false)}
              aria-label="Close menu"
              className="p-1.5 rounded-lg text-muted hover:text-text hover:bg-surface2 transition"
            >
              <CloseIcon />
            </button>
          </div>
          <SidebarNav
            workspaces={workspaces}
            activeWorkspaceId={activeWorkspaceId}
            pathname={location.pathname}
            onSwitch={onWorkspaceSwitch}
            onOpenCreate={() => {
              setMobileOpen(false);
              setShowCreateModal(true);
            }}
            onOpenInvite={() => {
              setMobileOpen(false);
              setShowInviteModal(true);
            }}
            onNavigate={() => setMobileOpen(false)}
          />
        </div>
      </div>

      {/* Desktop: unchanged fixed rail, static in the flow at `lg` and up. */}
      <div className="hidden lg:flex w-60 shrink-0 h-screen sticky top-0 border-r border-border bg-surface flex-col">
        <SidebarNav
          workspaces={workspaces}
          activeWorkspaceId={activeWorkspaceId}
          pathname={location.pathname}
          onSwitch={onWorkspaceSwitch}
          onOpenCreate={() => setShowCreateModal(true)}
          onOpenInvite={() => setShowInviteModal(true)}
          onNavigate={() => {}}
        />
      </div>

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
        <InviteMembersModal
          workspaceId={activeWorkspaceId}
          currentUserId={user.id}
          onClose={() => setShowInviteModal(false)}
        />
      )}
    </>
  );
}
