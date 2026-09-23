import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../api/AuthContext";
import { datasourceApi, DataSourceSummary, WorkspaceDetail, WorkspaceSummary, workspaceApi } from "../api/client";
import DataSourceForm, { connectionKindMeta, dataSourceCategory, DATA_SOURCE_CATEGORIES } from "./DataSourceForm";

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
// round) - replaces the old always-expanded flat list at the bottom of the
// sidebar. Two tabs: every source already connected in the active
// workspace, grouped by category (Files / Databases / Warehouses, see
// DataSourceForm.dataSourceCategory) instead of one flat unsorted scroll,
// or connect a brand-new one (the same DataSourceForm used everywhere
// else). Picking an existing source or finishing a new connection always
// navigates straight into it, so this never needs to hand a "refresh your
// list" signal back to whichever page happened to be open underneath it -
// that page is being left either way.
export function ConnectDataPopup({
  activeWorkspaceId,
  onClose,
  draft,
}: {
  activeWorkspaceId: string;
  onClose: () => void;
  // A pending, not-yet-sent chat prompt this popup was opened on top of
  // (see pages/NewProject.tsx) - when set, picking or connecting a source
  // here carries it along in the URL instead of landing on a plain empty
  // workspace, so Workspace.tsx can auto-run it the moment that data source
  // is ready (see its own draft-param effect). Omitted everywhere else
  // (the sidebar's own "Connect data" button below has no pending prompt),
  // in which case this behaves exactly as before.
  draft?: string;
}) {
  const navigate = useNavigate();
  const [tab, setTab] = useState<"existing" | "new">("existing");
  const [sources, setSources] = useState<DataSourceSummary[] | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!activeWorkspaceId) return;
    datasourceApi
      .list(activeWorkspaceId)
      .then((list) => setSources([...list].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())))
      .catch(() => setSources([]));
  }, [activeWorkspaceId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const destination = (dsId: string) =>
    draft && draft.trim() ? `/workspace/${dsId}?draft=${encodeURIComponent(draft.trim())}` : `/workspace/${dsId}`;

  const openSource = (ds: DataSourceSummary) => {
    onClose();
    navigate(destination(ds.id));
  };

  const handleCreated = (ds: { id: string }) => {
    onClose();
    navigate(destination(ds.id));
  };

  const filtered = (sources || []).filter(
    (ds) => !query.trim() || ds.name.toLowerCase().includes(query.trim().toLowerCase())
  );
  const grouped = DATA_SOURCE_CATEGORIES.map((cat) => ({
    category: cat,
    sources: filtered.filter((ds) => dataSourceCategory(ds.kind) === cat),
  })).filter((g) => g.sources.length > 0);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start sm:items-center justify-center bg-black/60 p-4 overflow-y-auto"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="card w-full max-w-md my-8 sm:my-0 flex flex-col max-h-[85vh]">
        <div className="p-4 border-b border-border flex items-center justify-between shrink-0">
          <div className="font-bold text-base">Connect data</div>
          <button type="button" className="text-muted hover:text-text transition" onClick={onClose} aria-label="Close">
            <CloseIcon className="w-5 h-5" />
          </button>
        </div>

        <div className="px-4 pt-3 flex items-center gap-1 shrink-0 border-b border-border">
          <button
            type="button"
            onClick={() => setTab("existing")}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition ${
              tab === "existing" ? "border-primary text-primary" : "border-transparent text-muted hover:text-text"
            }`}
          >
            Your data{sources ? ` (${sources.length})` : ""}
          </button>
          <button
            type="button"
            onClick={() => setTab("new")}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition ${
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
              {sources.length > 5 && (
                <div className="relative mb-3">
                  <SearchIcon className="w-3.5 h-3.5 text-muted absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    autoFocus
                    className="input input-icon-sm text-sm w-full py-1.5"
                    placeholder="Search your data..."
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>
              )}
              {grouped.length === 0 ? (
                <div className="text-xs text-muted text-center py-6">No sources match &ldquo;{query}&rdquo;.</div>
              ) : (
                grouped.map((g) => (
                  <div key={g.category} className="mb-4 last:mb-0">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-muted mb-1.5 px-0.5">
                      {g.category}
                    </div>
                    <div className="space-y-0.5">
                      {g.sources.map((ds) => {
                        const meta = connectionKindMeta(ds.kind);
                        return (
                          <button
                            key={ds.id}
                            type="button"
                            onClick={() => openSource(ds)}
                            className="w-full flex items-center gap-2.5 px-2 py-2 rounded-lg text-left hover:bg-surface2 transition group"
                          >
                            <span
                              className="w-7 h-7 rounded-md flex items-center justify-center shrink-0"
                              style={{ backgroundColor: `${meta.color}1a`, color: meta.color }}
                            >
                              <meta.Logo className="w-3.5 h-3.5" />
                            </span>
                            <span className="text-sm truncate flex-1 text-text/90 group-hover:text-text">{ds.name}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
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

  const onProjects = location.pathname === "/";

  return (
    // Hidden below the `lg` breakpoint rather than becoming a hamburger/
    // drawer nav - this app's other pages (Workspace.tsx) already have an
    // established mobile pattern (stack full-width, no fixed side rail),
    // so hiding it here keeps mobile exactly as good as it was before this
    // round rather than half-building a second, different mobile nav
    // pattern under time pressure.
    <div className="hidden lg:flex w-60 shrink-0 h-screen sticky top-0 border-r border-border bg-surface flex-col">
      <WorkspaceSwitcher
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        onSwitch={onWorkspaceSwitch}
        onOpenCreate={() => setShowCreateModal(true)}
        onOpenInvite={() => setShowInviteModal(true)}
      />

      <div className="px-3 mt-1 space-y-0.5">
        <Link
          to="/"
          className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition ${
            onProjects ? "bg-primary text-white" : "text-text hover:bg-surface2"
          }`}
        >
          <ProjectsIcon />
          Projects
        </Link>
        <Link
          to="/dashboards"
          className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition ${
            location.pathname.startsWith("/dashboards") ? "bg-primary text-white" : "text-text hover:bg-surface2"
          }`}
        >
          <DashboardsIcon />
          Dashboards
        </Link>
        <Link
          to="/data"
          className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition ${
            location.pathname.startsWith("/data") ? "bg-primary text-white" : "text-text hover:bg-surface2"
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
    </div>
  );
}
