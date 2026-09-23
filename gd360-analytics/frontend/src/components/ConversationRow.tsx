import { useEffect, useRef, useState } from "react";
import { conversationApi, ConversationSummary, FolderSummary } from "../api/client";

function MoreIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
      <circle cx="12" cy="5" r="1.9" />
      <circle cx="12" cy="12" r="1.9" />
      <circle cx="12" cy="19" r="1.9" />
    </svg>
  );
}

function PencilIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

function PinIcon({ className, filled = false }: { className?: string; filled?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 17v5" />
      <path d="M9 3h6l-1 6 3.5 3.5a1 1 0 0 1-.7 1.7H6.2a1 1 0 0 1-.7-1.7L9 9Z" />
    </svg>
  );
}

function FolderIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </svg>
  );
}

function ChevronLeftIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

function TrashIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  );
}

// The dropdown menu opened from a row's "more" button - Rename / Pin /
// Delete, with Delete stepping into an inline "are you sure" state rather
// than a jarring browser confirm() popup. Its own small component so the
// open/close + click-outside + confirm-step state stays self-contained and
// does not clutter ConversationRow's own state below.
function RowMenu({
  pinned,
  busy,
  canEdit,
  canDelete,
  folders,
  currentFolderId,
  onClose,
  onRename,
  onTogglePin,
  onDelete,
  onMoveToFolder,
}: {
  pinned: boolean;
  busy: boolean;
  // Server-computed (2026-09-23, roles & attribution round) - a workspace
  // "viewer" gets both false, so this menu only ever offers what they're
  // actually allowed to do instead of showing an action that would just
  // 403 when clicked.
  canEdit: boolean;
  canDelete: boolean;
  // The workspace's folders, for "Move to folder" below (2026-09-23,
  // folders round) - omitted/empty just skips that menu item entirely,
  // same as any other list-driven menu row in this app.
  folders?: FolderSummary[];
  currentFolderId?: string | null;
  onClose: () => void;
  onRename: () => void;
  onTogglePin: () => void;
  onDelete: () => void;
  onMoveToFolder?: (folderId: string | null) => void;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // A second drill-down step, same shallow one-level pattern as
  // AddDataPicker.tsx's own "existing" view - "folders" shows the list of
  // folders to move into instead of the normal Rename/Pin/Delete row.
  const [pickingFolder, setPickingFolder] = useState(false);

  if (pickingFolder) {
    return (
      <div className="p-1.5 w-56" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="w-full flex items-center gap-2 px-2 py-1.5 text-xs text-muted hover:text-text transition"
          onClick={() => setPickingFolder(false)}
        >
          <ChevronLeftIcon className="w-3.5 h-3.5" /> Back
        </button>
        <div className="my-1 border-t border-border" />
        <button
          type="button"
          className="w-full flex items-center justify-between gap-2.5 px-3 py-2 text-sm text-left hover:bg-surface2 transition rounded-lg"
          onClick={() => { onMoveToFolder?.(null); setPickingFolder(false); }}
        >
          <span>No folder</span>
          {!currentFolderId && <CheckIcon className="w-3.5 h-3.5 text-primary shrink-0" />}
        </button>
        {(folders || []).map((f) => (
          <button
            key={f.id}
            type="button"
            className="w-full flex items-center justify-between gap-2.5 px-3 py-2 text-sm text-left hover:bg-surface2 transition rounded-lg"
            onClick={() => { onMoveToFolder?.(f.id); setPickingFolder(false); }}
          >
            <span className="truncate">{f.name}</span>
            {currentFolderId === f.id && <CheckIcon className="w-3.5 h-3.5 text-primary shrink-0" />}
          </button>
        ))}
      </div>
    );
  }

  if (confirmingDelete) {
    return (
      <div className="p-3 w-56" onClick={(e) => e.stopPropagation()}>
        <div className="text-xs text-text leading-relaxed mb-3">
          Delete this conversation? This can&rsquo;t be undone.
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="flex-1 text-xs font-medium px-2.5 py-1.5 rounded-lg border border-border hover:bg-surface2 transition"
            onClick={() => setConfirmingDelete(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            className="flex-1 text-xs font-semibold px-2.5 py-1.5 rounded-lg bg-red-500/15 text-red-400 border border-red-500/30 hover:bg-red-500/25 transition disabled:opacity-50"
            onClick={onDelete}
          >
            {busy ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>
    );
  }

  const itemClass =
    "w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left hover:bg-surface2 transition rounded-lg";

  return (
    <div className="p-1.5 w-52" onClick={(e) => e.stopPropagation()}>
      {canEdit && (
        <>
          <button type="button" className={itemClass} onClick={onRename}>
            <PencilIcon className="w-4 h-4 text-muted shrink-0" />
            <span>Rename</span>
          </button>
          <button type="button" className={itemClass} disabled={busy} onClick={onTogglePin}>
            <PinIcon className="w-4 h-4 text-muted shrink-0" filled={pinned} />
            <span>{pinned ? "Unpin chat" : "Pin chat"}</span>
          </button>
          {(folders || []).length > 0 && (
            <button type="button" className={itemClass} onClick={() => setPickingFolder(true)}>
              <FolderIcon className="w-4 h-4 text-muted shrink-0" />
              <span>Move to folder</span>
            </button>
          )}
        </>
      )}
      {canEdit && canDelete && <div className="my-1 border-t border-border" />}
      {canDelete && (
        <button
          type="button"
          className={`${itemClass} text-red-400 hover:bg-red-500/10`}
          onClick={() => setConfirmingDelete(true)}
        >
          <TrashIcon className="w-4 h-4 shrink-0" />
          <span>Delete</span>
        </button>
      )}
    </div>
  );
}

// One row for a saved conversation - reused as-is everywhere a
// conversation is listed: the homepage's "Recent conversations", the
// Workspace page's own "Recent conversations" panel, and the
// "Conversations" list inside a data source's popup on the homepage.
// Being the exact same component in all three means a rename, pin or
// delete made in any one of them is the same edit to the same conversation
// on the server, and looks identical the next time either of the other two
// is opened - "it has to reflect all the places" is true by construction,
// not by keeping three separate bits of UI in sync by hand.
export default function ConversationRow({
  conversation,
  variant = "card",
  icon,
  subtitle,
  trailing,
  active = false,
  onOpen,
  onRenamed,
  onPinned,
  onDeleted,
  folders,
  onMoved,
  selectMode = false,
  selected = false,
  onToggleSelect,
}: {
  conversation: ConversationSummary;
  // "card": the homepage / Workspace style (icon + title + subtitle).
  // "row": the compact style used inside a data source's own popup, where
  // the data source is already named in the header above the list.
  variant?: "card" | "row";
  icon?: React.ReactNode;
  subtitle?: string;
  trailing?: React.ReactNode;
  // True when this is the conversation currently open on screen - draws a
  // distinct accent highlight so it is unmistakable which one that is,
  // exactly the way a first-class chat product's own sidebar behaves.
  active?: boolean;
  onOpen: () => void;
  onRenamed: (id: string, title: string) => void;
  onPinned?: (id: string, pinned: boolean) => void;
  onDeleted?: (id: string) => void;
  // 2026-09-23 (folders round): the workspace's folders, for this row's own
  // "Move to folder" menu item - and the callback fired once a move
  // actually succeeds, so the page holding this list can update its own
  // copy of conversation.folder_id without a full refetch. Both omitted
  // (Workspace.tsx's "Recent conversations" panel, which has no folders
  // concept at all) just skips that menu item entirely.
  folders?: FolderSummary[];
  onMoved?: (id: string, folderId: string | null) => void;
  // Select-all/bulk-move mode (2026-09-23, folders round): while active,
  // clicking the card toggles its checkbox instead of opening it, and the
  // "..." menu is hidden (its Rename/Pin/Delete/Move actions don't apply
  // to a multi-select). `folders`/`onMoved` above are for the single-row
  // "Move to folder" menu item, unrelated to this bulk mode.
  selectMode?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(conversation.title);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  const [menuOpen, setMenuOpen] = useState(false);
  const [menuBusy, setMenuBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKey);
    };
  }, [menuOpen]);

  const startRename = () => {
    setDraft(conversation.title);
    setFailed(false);
    setMenuOpen(false);
    setRenaming(true);
  };

  const commitRename = async () => {
    const title = draft.trim();
    setRenaming(false);
    if (!title || title === conversation.title) return;
    setSaving(true);
    setFailed(false);
    try {
      await conversationApi.rename(conversation.id, title);
      onRenamed(conversation.id, title);
    } catch {
      // Nothing is lost - the old title just stays, and the menu is right
      // there to try again.
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  const togglePin = async () => {
    const nextPinned = !conversation.pinned;
    setMenuBusy(true);
    try {
      await conversationApi.pin(conversation.id, nextPinned);
      onPinned?.(conversation.id, nextPinned);
      setMenuOpen(false);
    } catch {
      // Leaves the menu open with its normal (non-busy) state so the
      // person can simply try the click again.
    } finally {
      setMenuBusy(false);
    }
  };

  const confirmDelete = async () => {
    setMenuBusy(true);
    try {
      await conversationApi.remove(conversation.id);
      onDeleted?.(conversation.id);
      setMenuOpen(false);
    } catch {
      setMenuBusy(false);
    }
  };

  // Reuses the same bulk-move endpoint with a single id - one call either
  // way, so there is only ever one code path (and one set of edge cases)
  // for "does this person actually have permission to move it" between the
  // single-row menu here and the Projects page's own select-all bar.
  const moveToFolder = async (folderId: string | null) => {
    setMenuBusy(true);
    try {
      await conversationApi.bulkMove([conversation.id], folderId);
      onMoved?.(conversation.id, folderId);
      setMenuOpen(false);
    } catch {
      // Leaves the menu open (non-busy) so the person can try again.
    } finally {
      setMenuBusy(false);
    }
  };

  // Both false only for a workspace "viewer" looking at someone else's
  // Project (own Projects are always at least deletable by their creator -
  // see backend can_delete_conversation) - there's genuinely nothing this
  // menu could offer them, so skip rendering it rather than showing an
  // empty dropdown.
  const canEdit = conversation.can_edit ?? true;
  const canDelete = conversation.can_delete ?? true;
  // Hidden in select mode - a multi-select bar makes its own bulk actions
  // available (see the Projects page), and this row's own Rename/Pin/
  // Delete/Move menu would otherwise sit right next to a checkbox meant
  // for a completely different action.
  const menuButton = !selectMode && (canEdit || canDelete) && (
    <div className="relative shrink-0" ref={menuRef}>
      <button
        type="button"
        className={`p-1.5 rounded-lg transition ${
          menuOpen
            ? "opacity-100 bg-surface2 text-text"
            : "opacity-0 group-hover:opacity-70 hover:!opacity-100 hover:bg-surface2 text-muted hover:text-text"
        }`}
        title="Conversation options"
        onClick={(e) => {
          e.stopPropagation();
          setMenuOpen((v) => !v);
        }}
      >
        <MoreIcon className="w-4 h-4" />
      </button>
      <div
        className={`absolute right-0 top-full mt-1.5 z-20 origin-top-right rounded-xl border border-border bg-surface2/95 backdrop-blur-xl shadow-2xl transition duration-150 ease-out ${
          menuOpen ? "opacity-100 scale-100 pointer-events-auto" : "opacity-0 scale-95 pointer-events-none"
        }`}
      >
        <RowMenu
          pinned={conversation.pinned}
          busy={menuBusy}
          canEdit={canEdit}
          canDelete={canDelete}
          folders={folders}
          currentFolderId={conversation.folder_id}
          onClose={() => setMenuOpen(false)}
          onRename={startRename}
          onTogglePin={togglePin}
          onDelete={confirmDelete}
          onMoveToFolder={moveToFolder}
        />
      </div>
    </div>
  );

  const checkbox = selectMode && (
    <div className="shrink-0 pt-0.5" onClick={(e) => { e.stopPropagation(); onToggleSelect?.(conversation.id); }}>
      <input
        type="checkbox"
        checked={selected}
        onChange={() => onToggleSelect?.(conversation.id)}
        className="w-4 h-4 rounded accent-primary cursor-pointer"
      />
    </div>
  );

  const titleBlock = renaming ? (
    <input
      autoFocus
      className="input py-1 text-sm font-medium"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") commitRename();
        if (e.key === "Escape") setRenaming(false);
      }}
      onBlur={commitRename}
      maxLength={80}
    />
  ) : (
    <div className="flex items-center gap-1.5 min-w-0">
      {conversation.pinned && (
        <PinIcon filled className="w-3 h-3 text-accent shrink-0 rotate-[20deg]" />
      )}
      <span className={`truncate ${variant === "card" ? "font-medium text-sm" : "text-sm"} ${active ? "text-text font-semibold" : ""}`}>
        {conversation.title}
      </span>
      {/* Attribution (2026-09-23, roles & attribution round): only shown
          for a teammate's Project, never your own - "by You" everywhere
          would just be noise in a mostly-personal-Projects list. */}
      {conversation.is_own === false && (
        <span
          className="text-[10px] text-muted shrink-0 px-1.5 py-0.5 rounded-full bg-surface2 border border-border"
          title={conversation.created_by_email}
        >
          {conversation.created_by_name || conversation.created_by_email}
        </span>
      )}
      {saving && <span className="text-[10px] text-accent shrink-0">Saving&hellip;</span>}
      {failed && <span className="text-[10px] text-red-400 shrink-0">Could not rename</span>}
    </div>
  );

  // A slim gradient bar on the leading edge is the same visual language
  // top-tier chat products (Gemini, Grok) use to mark "this is the one
  // you're in" at a glance in a dense list, without needing to change the
  // row's whole layout to fit an icon or checkmark.
  const activeBar = active ? (
    <span className="absolute left-0 top-1/2 -translate-y-1/2 h-[65%] w-[3px] rounded-full bg-gradient-to-b from-primary to-accent" />
  ) : null;

  const handleCardClick = () => {
    if (renaming) return;
    if (selectMode) { onToggleSelect?.(conversation.id); return; }
    onOpen();
  };

  if (variant === "row") {
    return (
      <div
        className={`relative w-full flex items-center justify-between gap-2 py-2 rounded-lg border text-left transition group cursor-pointer ${
          menuOpen ? "z-30" : "z-0"
        } ${
          active
            ? "pl-4 pr-3 bg-gradient-to-r from-primary/15 via-primary/5 to-transparent border-primary/40"
            : "pl-3 pr-3 border-border hover:bg-surface2"
        }`}
        onClick={handleCardClick}
      >
        {activeBar}
        {checkbox}
        <div className="min-w-0 flex-1">{titleBlock}</div>
        <div className="flex items-center gap-1 shrink-0">
          {trailing && <span className="text-[11px] text-muted">{trailing}</span>}
          {menuButton}
        </div>
      </div>
    );
  }

  return (
    <div
      // `.card`'s blurred-glass background creates its own CSS stacking
      // context (backdrop-filter does that), so every card in a list is an
      // isolated paint layer - by default the dropdown menu's z-20 only
      // wins against elements INSIDE this same card, not against the next
      // card in the list, which paints as a whole layer on top of this
      // one's overflow the moment it comes later in the DOM. Bumping this
      // card's own z-index above its siblings while its menu is open lifts
      // the entire card - dropdown included - above the rest of the list,
      // so the open menu is never sliced up by the cards below it.
      className={`relative card p-4 transition group cursor-pointer ${menuOpen ? "z-30" : "z-0"} ${
        selected
          ? "border-primary/60 bg-primary/5"
          : active
          ? "border-primary/50 shadow-glow bg-gradient-to-br from-primary/10 via-transparent to-accent/5"
          : "hover:shadow-glow"
      }`}
      onClick={handleCardClick}
    >
      {activeBar}
      <div className={`flex items-start gap-3 ${active ? "pl-1.5" : ""}`}>
        {checkbox}
        {icon && (
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-primary/25 to-accent/25 flex items-center justify-center text-primary shrink-0">
            {icon}
          </div>
        )}
        <div className="min-w-0 flex-1">
          {titleBlock}
          {subtitle && <div className="text-xs text-muted mt-0.5 truncate">{subtitle}</div>}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {trailing && <div className="text-xs text-muted">{trailing}</div>}
          {menuButton}
        </div>
      </div>
    </div>
  );
}
