import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useTheme } from "../api/ThemeContext";
import { v2Api, type PlanSummary } from "../api/v2";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";
import "../shell/shell.css";
import { useAuth } from "../api/AuthContext";
import ThemeToggle from "./ThemeToggle";
import { NotificationBell } from "./NotificationCenter";
import { TalkButton } from "./Euliv";
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
            <button type="button" role="menuitem" className={itemClass} onClick={() => { close(); navigate("/settings/plan"); }}>
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

// 2026-10-15 (R50, GD360 3.0): the one top bar (mockup boards 01 and 06) - "Workspace / Page" on the left,
// the page's own actions, then the plan, search, alerts, theme and your avatar. Every signed-in page renders it,
// the conversation and the dashboards included, so the product reads as one thing.
const PAGE_LABELS: [RegExp, string][] = [
  [/^\/$/, "Home"], [/^\/chat\/?$/, "New conversation"], [/^\/chat\//, "Conversation"], [/^\/(library|docs\/|projects|p\/|g\/|v\/|workspace\/)/, "Library"],
  [/^\/(dashboards|boards|dashboard-builder|project-dashboards)/, "Dashboards"], [/^\/(data|connect)/, "Data"], [/^\/spaces/, "Spaces"],
  [/^\/(automations|jobs)/, "Automations"], [/^\/profile/, "Settings"], [/^\/settings\/domains/, "Company domain"], [/^\/(ml-models|ml-studio)/, "ML Studio"],
  [/^\/experiments/, "Experiments"], [/^\/initiatives/, "Initiatives"], [/^\/accounts/, "Accounts"], [/^\/(trust|governance)/, "Trust Center"], [/^\/admin/, "Admin"],
];
export function pageLabel(pathname: string): string {
  return PAGE_LABELS.find(([re]) => re.test(pathname))?.[1] || "GD360";
}

let planCache: { at: number; p: Promise<PlanSummary | null> } | null = null;
function loadPlan(): Promise<PlanSummary | null> {
  if (planCache && Date.now() - planCache.at < 60_000) return planCache.p;
  const p = v2Api.plan().catch(() => null);
  planCache = { at: Date.now(), p };
  return p;
}
export function forgetPlan() { planCache = null; }

function PlanChip() {
  const [plan, setPlan] = useState<PlanSummary | null>(null);
  const navigate = useNavigate();
  useEffect(() => { let live = true; void loadPlan().then((p) => live && setPlan(p)); return () => { live = false; }; }, []);
  if (!plan) return null;
  const q = plan.meters.find((m) => m.key === "questions_per_day");
  const text = q && q.limit ? `${plan.label} plan · ${q.used} of ${q.limit} questions today` : `${plan.label} plan`;
  return <button type="button" className="gx-sc gx-hide-md" onClick={() => navigate("/settings/plan")} title="Plan and usage" data-gx-plan="">{text}</button>;
}

function ThemeIcon() {
  const { theme, toggleTheme } = useTheme();
  return (
    <button type="button" className="gx-sc ic" onClick={toggleTheme} aria-label={theme === "dark" ? "Switch to light" : "Switch to dark"} title="Theme" data-c2-theme-toggle="">
      {theme === "dark"
        ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" /></svg>
        : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>}
    </button>
  );
}

function Avatar2() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const isAdmin = !!user?.email && ADMIN_EMAILS.includes(user.email.toLowerCase());
  const label = user?.full_name || user?.email || "Account";
  const initial = (label.trim()[0] || "G").toUpperCase();
  const itemClass = "ui-focus-inset w-full flex items-center gap-2.5 px-3 py-2 text-ui text-left hover:bg-subtle transition-colors";
  return (
    <Popover align="end" width={232} haspopup="menu" role="menu" ariaLabel="Account"
      trigger={(api) => (
        <button type="button" data-popover-trigger="" aria-label={`Account menu for ${label}`} {...api.props} className="gx-av" data-gx-avatar="">{initial}</button>
      )}>
      {({ close }) => (
        <div className="py-1.5">
          <div className="px-3 pb-1.5 pt-1">
            <div className="text-ui font-medium truncate">{user?.full_name || "Signed in"}</div>
            {user?.email && <div className="text-caption text-muted truncate">{user.email}</div>}
          </div>
          <div className="border-t border-border my-1" />
          <button type="button" role="menuitem" className={itemClass} onClick={() => { close(); navigate("/settings/plan"); }} data-gx-plan-menu="">
            <CreditCardIcon size={15} className="text-muted" /> Plan and usage
          </button>
          <button type="button" role="menuitem" className={itemClass} onClick={() => { close(); navigate("/profile"); }}>
            <SettingsIcon size={15} className="text-muted" /> Account settings
          </button>
          {isAdmin && (
            <button type="button" role="menuitem" className={itemClass} onClick={() => { close(); navigate("/admin"); }}>
              <ShieldIcon size={15} className="text-muted" /> Admin
            </button>
          )}
          <div className="border-t border-border my-1" />
          <button type="button" role="menuitem" className={`${itemClass} text-danger`} onClick={() => { close(); logout(); }}>
            <LogoutIcon size={15} /> Sign out
          </button>
        </div>
      )}
    </Popover>
  );
}

export default function TopNav({
  onConnectData,
  breadcrumb,
  title,
  leading,
  actions,
  hidePlan = false,
}: {
  onConnectData?: () => void;
  /** kept for older call sites; the rail carries the mark now */
  hideLogo?: boolean;
  breadcrumb?: Crumb[];
  /** the page's own title in place of the route's name (a conversation's title, clickable to rename) */
  title?: ReactNode;
  leading?: ReactNode;
  actions?: ReactNode;
  hidePlan?: boolean;
}) {
  const { pathname } = useLocation();
  const { workspaces, activeWorkspaceId } = useWorkspaceNav();
  const ws = workspaces.find((w) => w.id === activeWorkspaceId);
  const { user } = useAuth();
  const first = (user?.full_name || "").trim().split(" ")[0];
  const wsName = ws ? (ws.is_personal ? (first ? `${first}'s workspace` : "Personal workspace") : ws.name) : first ? `${first}'s workspace` : "Workspace";
  const crumbs: Crumb[] = breadcrumb && breadcrumb.length ? breadcrumb : title ? [] : [{ label: pageLabel(pathname) }];
  return (
    <header className="gx-top" data-gx-top="">
      <nav className="gx-crumbs" aria-label="Breadcrumb">
        <button type="button" className="ws" data-gx-menu-trigger="" data-gx-ws-crumb="" title="Switch or manage workspace"
          onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); window.dispatchEvent(new CustomEvent("gx:open-workspace-menu", { detail: { x: r.left, y: r.bottom + 8 } })); }}>
          {wsName}
        </button>
        {crumbs.map((c, i) => (
          <span key={i} style={{ display: "contents" }}>
            <span className={`sl${i === 0 ? " first" : ""}`} aria-hidden="true">/</span>
            {c.to ? <Link to={c.to}>{c.label}</Link> : <span className={`cur${i === crumbs.length - 1 && crumbs.length > 1 ? " strong" : ""}`} aria-current="page">{c.label}</span>}
          </span>
        ))}
        {title && (<><span className="sl first" aria-hidden="true">/</span><span className="cur strong" style={{ display: "inline-flex", alignItems: "center", gap: 10, minWidth: 0 }}>{title}</span></>)}
      </nav>
      {leading}
      <span style={{ flex: 1 }} />
      <div className="gx-acts">
        {actions}
        {onConnectData && <button type="button" className="gx-sc" onClick={onConnectData}>+ Connect data</button>}
        {!hidePlan && <PlanChip />}
        <button type="button" className="gx-sc ic gx-hide-sm" aria-label="Search everything (Ctrl+K)" title="Search · Ctrl+K" data-gx-search=""
          onClick={() => window.dispatchEvent(new Event("gd360:open-command-palette"))}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
        </button>
        <span className="gx-hide-sm"><NotificationBell /></span>
        <ThemeIcon />
        <Avatar2 />
      </div>
    </header>
  );
}
