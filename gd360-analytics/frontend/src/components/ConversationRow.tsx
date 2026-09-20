import { useState } from "react";
import { conversationApi, ConversationSummary } from "../api/client";

// One row for a saved conversation - reused as-is everywhere a
// conversation is listed: the homepage's "Recent conversations", the
// Workspace page's own "Recent conversations" panel, and the
// "Conversations" list inside a data source's popup on the homepage.
// Being the exact same component in all three means a rename made in any
// one of them is the same edit to the same conversation on the server, and
// looks identical the next time either of the other two is opened - "it
// has to reflect all the places" is true by construction, not by keeping
// three separate bits of UI in sync by hand.
export default function ConversationRow({
  conversation,
  variant = "card",
  icon,
  subtitle,
  trailing,
  onOpen,
  onRenamed,
}: {
  conversation: ConversationSummary;
  // "card": the homepage / Workspace style (icon + title + subtitle).
  // "row": the compact style used inside a data source's own popup, where
  // the data source is already named in the header above the list.
  variant?: "card" | "row";
  icon?: React.ReactNode;
  subtitle?: string;
  trailing?: React.ReactNode;
  onOpen: () => void;
  onRenamed: (id: string, title: string) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(conversation.title);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  const startRename = () => {
    setDraft(conversation.title);
    setFailed(false);
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
      // Nothing is lost - the old title just stays, and the pencil icon
      // is right there to try again.
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

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
      <span className={`truncate ${variant === "card" ? "font-medium text-sm" : "text-sm"}`}>{conversation.title}</span>
      <button
        type="button"
        className="opacity-0 group-hover:opacity-70 hover:!opacity-100 transition shrink-0 text-xs"
        title="Rename this conversation"
        onClick={(e) => {
          e.stopPropagation();
          startRename();
        }}
      >
        &#9998;
      </button>
      {saving && <span className="text-[10px] text-accent shrink-0">Saving&hellip;</span>}
      {failed && <span className="text-[10px] text-red-400 shrink-0">Could not rename</span>}
    </div>
  );

  if (variant === "row") {
    return (
      <div
        className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-border text-left hover:bg-surface2 transition group cursor-pointer"
        onClick={renaming ? undefined : onOpen}
      >
        <div className="min-w-0 flex-1">{titleBlock}</div>
        {trailing && <span className="text-[11px] text-muted shrink-0">{trailing}</span>}
      </div>
    );
  }

  return (
    <div
      className="card p-4 hover:shadow-glow transition group cursor-pointer"
      onClick={renaming ? undefined : onOpen}
    >
      <div className="flex items-start gap-3">
        {icon && (
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-primary/25 to-accent/25 flex items-center justify-center text-primary shrink-0">
            {icon}
          </div>
        )}
        <div className="min-w-0 flex-1">
          {titleBlock}
          {subtitle && <div className="text-xs text-muted mt-0.5 truncate">{subtitle}</div>}
        </div>
        {trailing && <div className="text-xs text-muted shrink-0">{trailing}</div>}
      </div>
    </div>
  );
}
