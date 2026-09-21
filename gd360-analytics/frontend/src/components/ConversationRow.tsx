import { useEffect, useRef, useState } from "react";
import { conversationApi, ConversationSummary } from "../api/client";

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
  onClose,
  onRename,
  onTogglePin,
  onDelete,
}: {
  pinned: boolean;
  busy: boolean;
  onClose: () => void;
  onRename: () => void;
  onTogglePin: () => void;
  onDelete: () => void;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);

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
      <button type="button" className={itemClass} onClick={onRename}>
        <PencilIcon className="w-4 h-4 text-muted shrink-0" />
        <span>Rename</span>
      </button>
      <button type="button" className={itemClass} disabled={busy} onClick={onTogglePin}>
        <PinIcon className="w-4 h-4 text-muted shrink-0" filled={pinned} />
        <span>{pinned ? "Unpin chat" : "Pin chat"}</span>
      </button>
      <div className="my-1 border-t border-border" />
      <button
        type="button"
        className={`${itemClass} text-red-400 hover:bg-red-500/10`}
        onClick={() => setConfirmingDelete(true)}
      >
        <TrashIcon className="w-4 h-4 shrink-0" />
        <span>Delete</span>
      </button>
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

  const menuButton = (
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
          onClose={() => setMenuOpen(false)}
          onRename={startRename}
          onTogglePin={togglePin}
          onDelete={confirmDelete}
        />
      </div>
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

  if (variant === "row") {
    return (
      <div
        className={`relative w-full flex items-center justify-between gap-2 py-2 rounded-lg border text-left transition group cursor-pointer ${
          active
            ? "pl-4 pr-3 bg-gradient-to-r from-primary/15 via-primary/5 to-transparent border-primary/40"
            : "pl-3 pr-3 border-border hover:bg-surface2"
        }`}
        onClick={renaming ? undefined : onOpen}
      >
        {activeBar}
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
      className={`relative card p-4 transition group cursor-pointer ${
        active ? "border-primary/50 shadow-glow bg-gradient-to-br from-primary/10 via-transparent to-accent/5" : "hover:shadow-glow"
      }`}
      onClick={renaming ? undefined : onOpen}
    >
      {activeBar}
      <div className={`flex items-start gap-3 ${active ? "pl-1.5" : ""}`}>
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
