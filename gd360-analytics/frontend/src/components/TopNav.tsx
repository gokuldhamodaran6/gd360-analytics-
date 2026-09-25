import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../api/AuthContext";
import ThemeToggle from "./ThemeToggle";

// Display-only check for showing the Admin link in the nav. The real
// access control happens on the backend (see ADMIN_EMAILS in config.py) -
// this just avoids showing the link to people it would 403 for anyway.
//
// 2026-09-25f (command palette round): exported so CommandPalette.tsx can
// gate its own "Admin" quick action off this exact same list, instead of
// keeping a second copy of these two email addresses that could quietly
// drift out of sync with this one.
export const ADMIN_EMAILS = ["gokuldhamodaran6@gmail.com", "gokuldhamodaranb@gmail.com"];

// 2026-09-25f (command palette round): the visible way to discover Cmd+K
// on any authenticated page (every caller of this component - see
// CommandPalette.tsx's own module comment for why a shortcut alone isn't
// enough). Clicking it dispatches the same custom "open" event the
// keyboard shortcut fires internally, since the palette itself is mounted
// once at the app root (App.tsx) rather than owned by this bar - a plain
// DOM event is the lightest way to reach it from here without adding a
// Context provider just for one open/close boolean.
function SearchIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  );
}

function ChevronDownIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function SubscriptionIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="5" width="20" height="14" rx="2.5" />
      <path d="M2 10h20" />
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

function LogoutIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="M16 17l5-5-5-5" />
      <path d="M21 12H9" />
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

function initials(nameOrEmail: string): string {
  const trimmed = (nameOrEmail || "").trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return trimmed.slice(0, 2).toUpperCase();
}

// The account menu, opened by clicking the name/avatar top right - name,
// chevron, then a real dropdown (My Subscription / Account Settings /
// Logout, plus Admin for Gokul's own account), replacing what used to be a
// plain profile text link with no menu at all. "My Subscription" opens a
// small honest info panel rather than a page, since this app has no real
// billing/plan system yet (see its own body text below) - a dead link or a
// fabricated invoice history would be worse than a plain, true statement.
function AccountMenu({ isAdmin }: { isAdmin: boolean }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [showPlan, setShowPlan] = useState(false);
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

  const label = user?.full_name || user?.email || "Account";

  return (
    <div className="relative">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 pl-1.5 pr-2.5 py-1.5 rounded-full hover:bg-surface2 transition"
      >
        <span className="w-7 h-7 rounded-full bg-primary text-white text-xs font-bold flex items-center justify-center shrink-0">
          {initials(label)}
        </span>
        <span className="text-sm font-medium hidden md:inline max-w-[10rem] truncate">{label}</span>
        <ChevronDownIcon className={`w-3.5 h-3.5 text-muted transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div
          ref={menuRef}
          className="absolute right-0 top-full mt-2 w-56 card bg-surface shadow-2xl border border-border py-1.5 z-40"
          role="menu"
        >
          <button
            type="button"
            role="menuitem"
            className="w-full flex items-center gap-2.5 px-3.5 py-2 text-sm text-left hover:bg-surface2 transition"
            onClick={() => { setOpen(false); setShowPlan(true); }}
          >
            <SubscriptionIcon className="w-4 h-4 text-muted" /> My Subscription
          </button>
          <button
            type="button"
            role="menuitem"
            className="w-full flex items-center gap-2.5 px-3.5 py-2 text-sm text-left hover:bg-surface2 transition"
            onClick={() => { setOpen(false); navigate("/profile"); }}
          >
            <SettingsIcon className="w-4 h-4 text-muted" /> Account Settings
          </button>
          {isAdmin && (
            <button
              type="button"
              role="menuitem"
              className="w-full flex items-center gap-2.5 px-3.5 py-2 text-sm text-left hover:bg-surface2 transition"
              onClick={() => { setOpen(false); navigate("/admin"); }}
            >
              <ShieldIcon className="w-4 h-4 text-muted" /> Admin
            </button>
          )}
          <div className="border-t border-border my-1.5" />
          <button
            type="button"
            role="menuitem"
            className="w-full flex items-center gap-2.5 px-3.5 py-2 text-sm text-left hover:bg-surface2 transition text-red-400"
            onClick={() => { setOpen(false); logout(); }}
          >
            <LogoutIcon /> Logout
          </button>
        </div>
      )}

      {showPlan &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
            onClick={(e) => { if (e.target === e.currentTarget) setShowPlan(false); }}
          >
            <div className="card bg-surface w-full max-w-sm p-6 relative">
              <div className="font-bold text-lg mb-1">Your plan</div>
              <div className="verify-bar pl-4 py-2.5 mt-3">
                <div className="text-sm font-semibold">Free plan &middot; Unlimited usage</div>
                <div className="text-xs text-muted mt-1 leading-relaxed">
                  GD360 is in early access - every feature is free and unlimited for now. Paid plans
                  aren't available yet, and you'll be told clearly before anything about your account
                  changes.
                </div>
              </div>
              <button type="button" className="btn-secondary w-full mt-5" onClick={() => setShowPlan(false)}>
                Close
              </button>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}

export default function TopNav({
  onConnectData,
  hideLogo = false,
}: {
  onConnectData?: () => void;
  // True on any page that already renders its own branding via
  // AppSidebar.tsx (currently just Dashboard.tsx) - avoids the logo
  // showing twice on screen at once, which is what happened before this
  // flag existed. Every other page (Workspace, Profile, admin) has no
  // sidebar yet, so they keep passing this as false/omitted and this bar
  // stays their only source of branding.
  hideLogo?: boolean;
}) {
  const { user } = useAuth();
  const isAdmin = !!user?.email && ADMIN_EMAILS.includes(user.email.toLowerCase());

  return (
    // flex-wrap (plus shrinking padding/text/button sizes below sm) keeps
    // this row from overflowing horizontally on a phone-width viewport.
    // 2026-09-23: the wordmark/logo moved to the new left sidebar
    // (AppSidebar.tsx) as part of the workspace-structure revamp, so this
    // bar's own job shrank to page-level actions + the account menu - kept
    // as its own component (rather than folded into the sidebar) since
    // Workspace.tsx, Profile.tsx and the admin pages all still render it
    // without the sidebar for now. The "+ Connect data" header button was
    // also retired from here (Dashboard.tsx no longer passes onConnectData)
    // since "+ New Project" on the Projects page is now the one obvious
    // place to start something new - the prop stays optional so any page
    // that still wants a header action can pass it back.
    <div className="flex flex-wrap items-center justify-between gap-y-2 gap-x-3 px-4 sm:px-6 py-3 sm:py-4 border-b border-border">
      {hideLogo ? (
        <span />
      ) : (
        <Link to="/" className="flex items-center gap-2.5 shrink-0">
          <span className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center text-white font-bold text-sm shrink-0">
            G
          </span>
          <span className="text-base sm:text-lg font-extrabold gradient-text">GD360 Analytics</span>
        </Link>
      )}
      <div className="flex items-center gap-2 sm:gap-3 flex-wrap justify-end">
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event("gd360:open-command-palette"))}
          aria-label="Search and jump to anything"
          title="Search / jump to anything"
          className="h-9 shrink-0 rounded-lg border border-border bg-surface2 hover:bg-border/60 flex items-center gap-1.5 px-2.5 sm:pr-2 text-muted hover:text-text transition"
        >
          <SearchIcon />
          <span className="hidden sm:inline text-[11px] font-medium">Search</span>
          <span className="hidden sm:inline-flex items-center justify-center text-[10px] font-semibold px-1.5 py-0.5 rounded border border-border bg-surface text-muted">
            {typeof navigator !== "undefined" && /mac/i.test(navigator.platform || navigator.userAgent || "") ? "⌘K" : "Ctrl K"}
          </span>
        </button>
        <ThemeToggle />
        {onConnectData && (
          <button className="btn-primary text-xs sm:text-sm px-3 py-1.5 sm:px-4 sm:py-2" onClick={onConnectData}>
            + Connect data
          </button>
        )}
        <AccountMenu isAdmin={isAdmin} />
      </div>
    </div>
  );
}
