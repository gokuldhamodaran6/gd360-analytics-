import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../api/AuthContext";
import ThemeToggle from "./ThemeToggle";
import {
  Avatar, Button, ChevronDownIcon, CreditCardIcon, LogoutIcon, Popover, SettingsIcon, ShieldIcon,
  TopBar, TopBarSearch, Breadcrumb as KitBreadcrumb, type BreadcrumbItem,
} from "../ui";

// Display-only check for showing the Admin link in the nav. The real
// access control happens on the backend (see ADMIN_EMAILS in config.py) -
// this just avoids showing the link to people it would 403 for anyway.
//
// 2026-09-25f (command palette round): exported so CommandPalette.tsx can
// gate its own "Admin" quick action off this exact same list, instead of
// keeping a second copy of these two email addresses that could quietly
// drift out of sync with this one.
export const ADMIN_EMAILS = ["gokuldhamodaran6@gmail.com", "gokuldhamodaranb@gmail.com"];

// 2026-10-06 (design-system kit): the top bar is now the System.dc.html /
// Main.dc.html chrome - a 56 px bar with a breadcrumb on the left and, on
// the right, a 240 px search field (which opens the command palette, same
// custom event as before), the page's own actions ("Share", a primary
// button - passed in by the page via `actions`), the theme toggle and the
// avatar menu. Every behaviour from before is kept: the account menu's
// routes (/profile, /admin), logout, the "My Subscription" info panel, the
// optional "+ Connect data" page action, and `hideLogo` for pages that
// already show the wordmark in AppSidebar. New, all optional: `breadcrumb`
// (an array of {label, to?} rendered as "Dashboards / Hotel performance"),
// `actions` (a right-hand slot) and `leading` (anything else on the left,
// e.g. a draft status pill).
// 2026-10-07: the frame itself is now the kit's TopBar (src/ui/TopBar.tsx)
// - this file only supplies the app-specific parts: react-router links in
// the breadcrumb, the command-palette search, the theme toggle and the
// account menu.

export type Crumb = { label: ReactNode; to?: string };

function toItems(items: Crumb[]): BreadcrumbItem[] {
  return items.map((c) => ({ label: c.label, href: c.to }));
}

const renderRouterLink: NonNullable<Parameters<typeof KitBreadcrumb>[0]["renderLink"]> = (item, className, children) => (
  <Link to={item.href!} className={className}>{children}</Link>
);

// The account menu, opened by clicking the avatar top right - name,
// chevron, then a real dropdown (My Subscription / Account Settings /
// Logout, plus Admin for Gokul's own account). "My Subscription" opens a
// small honest info panel rather than a page, since this app has no real
// billing/plan system yet (see its own body text below) - a dead link or a
// fabricated invoice history would be worse than a plain, true statement.
// 2026-10-06: rebuilt on the kit's Popover, so it also takes part in the
// app-wide "only one menu open at a time" rule (src/lib/useExclusiveOpen).
function AccountMenu({ isAdmin }: { isAdmin: boolean }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [showPlan, setShowPlan] = useState(false);

  const label = user?.full_name || user?.email || "Account";
  const itemClass = "ui-focus-inset w-full flex items-center gap-2.5 px-3 py-2 text-ui text-left hover:bg-subtle transition-colors";

  return (
    <>
      <Popover
        align="end"
        width={224}
        haspopup="menu"
        role="menu"
        ariaLabel="Account"
        trigger={(api) => (
          <button
            type="button"
            data-popover-trigger=""
            aria-label={`Account menu for ${label}`}
            {...api.props}
            className="ui-focus flex items-center gap-2 rounded-full pl-1 pr-2 py-1 hover:bg-subtle transition-colors"
          >
            <Avatar name={label} size="sm" title="" />
            <span className="text-ui font-medium hidden md:inline max-w-[10rem] truncate">{label}</span>
            <ChevronDownIcon size={13} className={`text-muted transition-transform ${api.open ? "rotate-180" : ""}`} />
          </button>
        )}
      >
        {({ close }) => (
          <div className="py-1.5">
            <div className="px-3 pb-1.5 pt-1">
              <div className="text-ui font-medium truncate">{user?.full_name || "Signed in"}</div>
              {user?.email && <div className="text-caption text-muted truncate">{user.email}</div>}
            </div>
            <div className="border-t border-border my-1" />
            <button type="button" role="menuitem" className={itemClass} onClick={() => { close(); setShowPlan(true); }}>
              <CreditCardIcon size={15} className="text-muted" /> My Subscription
            </button>
            <button type="button" role="menuitem" className={itemClass} onClick={() => { close(); navigate("/profile"); }}>
              <SettingsIcon size={15} className="text-muted" /> Account Settings
            </button>
            {isAdmin && (
              <button type="button" role="menuitem" className={itemClass} onClick={() => { close(); navigate("/admin"); }}>
                <ShieldIcon size={15} className="text-muted" /> Admin
              </button>
            )}
            <div className="border-t border-border my-1" />
            <button type="button" role="menuitem" className={`${itemClass} text-danger`} onClick={() => { close(); logout(); }}>
              <LogoutIcon size={15} /> Logout
            </button>
          </div>
        )}
      </Popover>

      {showPlan &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
            onClick={(e) => { if (e.target === e.currentTarget) setShowPlan(false); }}
          >
            <div role="dialog" aria-modal="true" aria-labelledby="plan-title" className="w-full max-w-sm rounded-card border border-border bg-surface p-6 shadow-pop">
              <div id="plan-title" className="text-section font-semibold mb-1">Your plan</div>
              <div className="verify-bar pl-4 py-2.5 mt-3">
                <div className="text-ui font-semibold">Free plan &middot; Unlimited usage</div>
                <div className="text-caption text-muted mt-1 leading-relaxed">
                  GD360 is in early access - every feature is free and unlimited for now. Paid plans
                  aren't available yet, and you'll be told clearly before anything about your account
                  changes.
                </div>
              </div>
              <Button variant="secondary" className="w-full mt-5" onClick={() => setShowPlan(false)}>
                Close
              </Button>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}

export function Breadcrumb({ items }: { items: Crumb[] }) {
  return <KitBreadcrumb items={toItems(items)} renderLink={renderRouterLink} />;
}

export default function TopNav({
  onConnectData,
  hideLogo = false,
  breadcrumb,
  leading,
  actions,
}: {
  onConnectData?: () => void;
  // True on any page that already renders its own branding via
  // AppSidebar.tsx - avoids the logo showing twice on screen at once.
  hideLogo?: boolean;
  breadcrumb?: Crumb[];
  leading?: ReactNode;
  actions?: ReactNode;
}) {
  const { user } = useAuth();
  const isAdmin = !!user?.email && ADMIN_EMAILS.includes(user.email.toLowerCase());
  const wordmark =
    !breadcrumb?.length && !hideLogo ? (
      <Link to="/" className="ui-focus flex shrink-0 items-center gap-2.5 rounded">
        <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-ctl bg-primary text-body font-bold text-white">G</span>
        <span className="text-section font-semibold text-text">GD360 Analytics</span>
      </Link>
    ) : null;

  return (
    <TopBar
      // `clearMobileMenu` clears the mobile menu button AppSidebar pins top-left.
      clearMobileMenu
      breadcrumb={breadcrumb && breadcrumb.length > 0 ? toItems(breadcrumb) : undefined}
      renderLink={renderRouterLink}
      leading={
        <>
          {wordmark}
          {leading}
        </>
      }
      search={<TopBarSearch onOpen={() => window.dispatchEvent(new Event("gd360:open-command-palette"))} />}
      actions={
        <>
          {actions}
          {onConnectData && (
            <Button variant="primary" onClick={onConnectData}>
              + Connect data
            </Button>
          )}
          <ThemeToggle />
        </>
      }
      avatar={<AccountMenu isAdmin={isAdmin} />}
    />
  );
}
